/** Native filesystem and VS Code adapter for the local two-client integration fixture. */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
const Module = require('module');
const disk = fs.promises;

class TestUri {
    readonly scheme = 'file';
    readonly authority = '';
    readonly path: string;
    constructor(readonly fsPath: string) { this.path = pathToFileURL(fsPath).pathname; }
    toString(): string { return pathToFileURL(this.fsPath).href; }
    static file(value: string): TestUri { return new TestUri(path.resolve(value)); }
    static joinPath(base: TestUri, ...segments: string[]): TestUri { return TestUri.file(path.join(base.fsPath, ...segments)); }
    static parse(value: string): TestUri { return TestUri.file(fileURLToPath(value)); }
}
class TestEmitter {
    private listeners = new Set<(value: any) => void>();
    event = (listener: (value: any) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value: any): void { this.listeners.forEach(listener => listener(value)); }
    dispose(): void { this.listeners.clear(); }
}
class TestFileSystemError extends Error {
    code = 'FileNotFound';
}
function convertError(error: any): never {
    if (error.code === 'ENOENT') throw new TestFileSystemError('File not found');
    throw error;
}
const promptMessages: string[] = [];
const mockVscode = {
    Uri: TestUri, EventEmitter: TestEmitter, FileSystemError: TestFileSystemError,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    RelativePattern: class { constructor(readonly baseUri: TestUri, readonly pattern: string) {} },
    workspace: {
        textDocuments: [],
        getConfiguration: () => ({ get: (_name: string, fallback: unknown) => fallback }),
        fs: {
            async stat(uri: TestUri) {
                const s = await disk.lstat(uri.fsPath).catch(convertError);
                return { type: s.isSymbolicLink() ? 64 : s.isDirectory() ? 2 : s.isFile() ? 1 : 0,
                    size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
            },
            readFile: (uri: TestUri) => disk.readFile(uri.fsPath).catch(convertError),
            writeFile: (uri: TestUri, data: Uint8Array) => disk.writeFile(uri.fsPath, data).catch(convertError),
            createDirectory: (uri: TestUri) => disk.mkdir(uri.fsPath, { recursive: true }),
            async readDirectory(uri: TestUri) {
                const entries = await disk.readdir(uri.fsPath, { withFileTypes: true }).catch(convertError);
                return entries.map(entry => [entry.name, entry.isSymbolicLink() ? 64 : entry.isDirectory() ? 2 : 1]);
            },
            async delete(uri: TestUri, options?: { recursive?: boolean }) {
                const stat = await disk.lstat(uri.fsPath).catch(convertError);
                if (stat.isDirectory() && !options?.recursive) {
                    await disk.rmdir(uri.fsPath).catch(convertError);
                } else {
                    await disk.rm(uri.fsPath, { recursive: !!options?.recursive }).catch(convertError);
                }
            },
            rename: (before: TestUri, after: TestUri) => disk.rename(before.fsPath, after.fsPath),
        },
        createFileSystemWatcher(pattern: { baseUri: TestUri; pattern: string }) {
            const change = new TestEmitter();
            const create = new TestEmitter();
            const remove = new TestEmitter();
            const watcher = fs.watch(pattern.baseUri.fsPath, { recursive: true }, (_kind, filename) => {
                if (!filename || (pattern.pattern !== '**/*' && filename !== pattern.pattern)) return;
                change.fire(TestUri.joinPath(pattern.baseUri, filename));
            });
            return { onDidChange: change.event, onDidCreate: create.event, onDidDelete: remove.event,
                dispose() { watcher.close(); change.dispose(); create.dispose(); remove.dispose(); } };
        },
    },
    window: {
        async showWarningMessage(message: string) { promptMessages.push(message); return undefined; },
        async showInformationMessage(message: string) { promptMessages.push(message); return undefined; },
        async showErrorMessage(message: string) { promptMessages.push(message); return undefined; },
    },
};

const originalLoad = Module._load;
Module._load = function(request: string, parent: unknown, main: boolean) {
    return request === 'vscode' ? mockVscode : originalLoad(request, parent, main);
};
const { SyncEngine } = require('../sync/syncEngine');
const { BaseAPI } = require('../api/base');
Module._load = originalLoad;
export { TestUri, SyncEngine, BaseAPI, promptMessages };

export async function eventually(check: () => Promise<boolean>, label: string, timeout = 45_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out: ${label}`);
}
