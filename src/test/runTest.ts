import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vm from 'vm';
import * as esbuild from 'esbuild';
import { runStandaloneTest } from './standaloneRunner';
import { removeStandaloneLatexComments } from '../utils/latexComments';
import {
    approveSyncTarget,
    createSyncTargetFingerprint,
    isSyncTargetApproved,
    revokeSyncTarget,
} from '../utils/syncAuthorization';
import {
    MAX_REMOTE_DOCUMENT_LINES,
    MAX_REMOTE_FILE_BYTES,
    validateRemoteDocumentLines,
} from '../utils/remoteValidation';

const Module = require('module') as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = Module._load;

function readInstalledPackageVersion(...packagePath: string[]): string {
    const packageJson = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'node_modules', ...packagePath, 'package.json'),
        'utf8',
    )) as { version?: string };
    assert.equal(typeof packageJson.version, 'string');
    return packageJson.version as string;
}

function readLockedPackageVersions(packageName: string): string[] {
    const packageLock = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'package-lock.json'),
        'utf8',
    )) as { packages?: Record<string, { version?: string }> };
    const packageSuffix = `node_modules/${packageName}`;
    const versions = Object.entries(packageLock.packages ?? {})
        .filter(([packagePath]) =>
            packagePath === packageSuffix || packagePath.endsWith(`/${packageSuffix}`))
        .map(([, packageMetadata]) => packageMetadata.version);
    assert.ok(versions.length > 0, `${packageName} must be present in package-lock.json`);
    assert.ok(versions.every(version => typeof version === 'string'));
    return [...new Set(versions as string[])].sort();
}

function verifyBundledLegacySocketClient(): void {
    const workspaceRoot = path.join(__dirname, '..', '..');
    const result = esbuild.buildSync({
        stdin: {
            contents: 'module.exports = require("socket.io-client");',
            resolveDir: workspaceRoot,
            sourcefile: 'socket-io-bundle-smoke.js',
            loader: 'js',
        },
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node18',
        write: false,
        logLevel: 'silent',
    });
    const output = result.outputFiles?.[0];
    assert.ok(output, 'esbuild must return the bundled Socket.IO smoke-test output');

    const filename = path.join(workspaceRoot, '.socket-io-bundle-smoke.cjs');
    const bundledModule: { exports: unknown } = { exports: {} };
    const executeBundle = vm.runInThisContext(
        `(function (module, exports, require, __filename, __dirname) {${output.text}\n})`,
        { filename },
    ) as (
        targetModule: { exports: unknown },
        exports: unknown,
        requireFn: NodeRequire,
        moduleFilename: string,
        moduleDirectory: string,
    ) => void;
    const runtimeRequire = ((request: string) => {
        assert.ok(
            !request.startsWith('.'),
            `the production bundle must not retain a relative runtime require: ${request}`,
        );
        return require(request);
    }) as NodeRequire;
    executeBundle(
        bundledModule,
        bundledModule.exports,
        runtimeRequire,
        filename,
        path.dirname(filename),
    );

    const socketClient = bundledModule.exports as {
        version?: string;
        connect?: unknown;
    };
    assert.equal(socketClient.version, '0.9.17-overleaf-5');
    assert.equal(
        typeof socketClient.connect,
        'function',
        'the legacy Socket.IO client must initialize after production bundling',
    );
}

async function verifyWebSocketCompatibility(): Promise<void> {
    const WebSocket = require('ws') as any;

    await new Promise<void>((resolve, reject) => {
        const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
        let client: any;
        let settled = false;
        let timeout: ReturnType<typeof setTimeout>;

        const finish = (error?: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            client?.terminate();
            for (const connection of server.clients) {
                connection.terminate();
            }
            server.close(() => error ? reject(error) : resolve());
        };

        timeout = setTimeout(() => finish(new Error('WebSocket smoke test timed out')), 5000);

        server.once('error', (error: Error) => finish(error));
        server.once('connection', (connection: any, request: any) => {
            try {
                assert.equal(request.headers.cookie, 'localleaf-test=1');
            } catch (error) {
                finish(error as Error);
                return;
            }
            connection.once('message', (message: unknown) => connection.send(message));
        });
        server.once('listening', () => {
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            client = new WebSocket(`ws://127.0.0.1:${address.port}`, {
                headers: { Cookie: 'localleaf-test=1' },
                maxPayload: 1024 * 1024,
            });
            client.onopen = () => {
                try {
                    assert.equal(client._receiver?._maxPayload, 1024 * 1024,
                        'the patched ws client must enforce its configured inbound payload limit');
                    client.send('localleaf-ws-smoke');
                } catch (error) {
                    finish(error as Error);
                }
            };
            client.onmessage = (event: { data: unknown }) => {
                try {
                    assert.equal(String(event.data), 'localleaf-ws-smoke');
                    finish();
                } catch (error) {
                    finish(error as Error);
                }
            };
            client.onerror = () => finish(new Error('WebSocket client connection failed'));
        });
    });
}

function verifyBundledSocketClientCompatibility(): void {
    const esbuild = require('esbuild') as {
        buildSync(options: Record<string, unknown>): void;
    };
    const projectRoot = path.join(__dirname, '..', '..');
    const smokeBundlePath = path.join(__dirname, 'socketClientBundleSmoke.js');
    esbuild.buildSync({
        entryPoints: [path.join(projectRoot, 'node_modules', 'socket.io-client', 'lib', 'io.js')],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node18',
        outfile: smokeBundlePath,
        logLevel: 'silent',
    });

    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    assert.ok(!navigatorDescriptor || navigatorDescriptor.configurable);
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        get: () => {
            throw new Error('PendingMigrationError: navigator is guarded by VS Code');
        },
    });
    try {
        delete require.cache[require.resolve(smokeBundlePath)];
        const socketClient = require(smokeBundlePath) as {
            connect?: unknown;
            transports?: string[];
            version?: string;
        };
        assert.equal(typeof socketClient.connect, 'function');
        assert.equal(socketClient.version, '0.9.17-overleaf-5');
        assert.deepStrictEqual(socketClient.transports, ['websocket', 'xhr-polling']);
    } finally {
        delete require.cache[require.resolve(smokeBundlePath)];
        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
        } else {
            delete (globalThis as { navigator?: unknown }).navigator;
        }
    }
}

let fetchResponse: {
    ok: boolean;
    status: number;
    statusText?: string;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
    buffer?: () => Promise<Buffer>;
    headers?: {
        get(name: string): string | null;
        raw?(): Record<string, string[]>;
    };
    body?: { once(event: string, listener: () => void): void; resume?(): void };
} = {
    ok: true,
    status: 200,
    json: async () => ({ entity_id: 'binary-id-1', entity_type: 'file' }),
    text: async () => '',
};
let fetchImplementation = async (_url?: unknown, _options?: unknown): Promise<typeof fetchResponse> => fetchResponse;

let executeCommandImpl: (...args: unknown[]) => Promise<unknown> = async () => undefined;
let useSocketIoMock = true;

class FakeSocket {
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    disconnectCount = 0;
    removeAllListenersCount = 0;

    constructor(
        private readonly onEmit?: (event: string, args: unknown[]) => void,
    ) {}

    on(event: string, listener: (...args: unknown[]) => void): this {
        const listeners = this.listeners.get(event) ?? [];
        listeners.push(listener);
        this.listeners.set(event, listeners);
        return this;
    }

    emit(event: string, ...args: unknown[]): this {
        this.onEmit?.(event, args);
        return this;
    }

    trigger(event: string, ...args: unknown[]): void {
        for (const listener of this.listeners.get(event) ?? []) {
            listener(...args);
        }
    }

    disconnect(): this {
        this.disconnectCount++;
        return this;
    }

    removeAllListeners(): this {
        this.removeAllListenersCount++;
        this.listeners.clear();
        return this;
    }
}

async function verifyHardenedXmlHttpRequest(): Promise<void> {
    interface XmlHttpRequestLike {
        readyState: number;
        status: number;
        onreadystatechange: (() => void) | null;
        onerror: (() => void) | null;
        open(method: string, url: string, async: boolean): void;
        send(): void;
    }

    const { XMLHttpRequest } = require('xmlhttprequest') as {
        XMLHttpRequest: new () => XmlHttpRequestLike;
    };

    assert.throws(
        () => new XMLHttpRequest().open('GET', 'file:///localleaf-test.txt', true),
        /Only HTTP and HTTPS requests are allowed/,
        'the bundled legacy transport must not read local files',
    );
    assert.throws(
        () => new XMLHttpRequest().open('GET', 'http://127.0.0.1/', false),
        /Synchronous XMLHttpRequest is disabled/,
        'the bundled legacy transport must not spawn a synchronous helper process',
    );

    let targetHits = 0;
    const server = http.createServer((request, response) => {
        if (request.url === '/redirect') {
            response.writeHead(302, { Location: '/target' });
            response.end();
            return;
        }
        if (request.url === '/target') {
            targetHits += 1;
        }
        response.writeHead(200);
        response.end('ok');
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');

        await new Promise<void>((resolve, reject) => {
            const request = new XMLHttpRequest();
            let settled = false;
            let timeout: ReturnType<typeof setTimeout>;
            const finish = (error?: Error): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                error ? reject(error) : resolve();
            };
            const verifyRejectedRedirect = (): void => {
                if (request.readyState !== 4) {
                    return;
                }
                try {
                    assert.equal(request.status, 0, 'redirected legacy XHR must fail closed');
                    finish();
                } catch (error) {
                    finish(error as Error);
                }
            };

            timeout = setTimeout(
                () => finish(new Error('XMLHttpRequest redirect test timed out')),
                5000,
            );

            request.onreadystatechange = verifyRejectedRedirect;
            request.onerror = verifyRejectedRedirect;
            request.open('GET', `http://127.0.0.1:${address.port}/redirect`, true);
            request.send();
        });

        assert.equal(targetHits, 0, 'legacy XHR must not follow redirects with authentication headers');
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}
let openExternalImpl = async (_uri: { toString(): string }): Promise<boolean> => true;

interface MockUri {
    scheme: string;
    authority?: string;
    path: string;
    fsPath: string;
    toString(): string;
}

interface MockFileEntry {
    type: number;
    content?: string;
    size?: number;
}

interface MockTextDocument {
    uri: MockUri;
    isDirty: boolean;
    version: number;
    getText(): string;
    positionAt(offset: number): { offset: number };
    applyText(text: string): void;
}

interface MockWorkspaceReplacement {
    uri: MockUri;
    text: string;
}

interface MockWorkspaceRename {
    oldUri: MockUri;
    newUri: MockUri;
}

interface MockWorkspaceDeletion {
    uri: MockUri;
    recursive: boolean;
}

class MockRange {
    constructor(
        readonly start: { offset: number },
        readonly end: { offset: number },
    ) {}
}

class MockWorkspaceEdit {
    readonly replacements: MockWorkspaceReplacement[] = [];
    readonly renames: MockWorkspaceRename[] = [];
    readonly deletions: MockWorkspaceDeletion[] = [];

    replace(uri: MockUri, _range: MockRange, text: string): void {
        this.replacements.push({ uri, text });
    }

    renameFile(oldUri: MockUri, newUri: MockUri): void {
        this.renames.push({ oldUri, newUri });
    }

    deleteFile(uri: MockUri, options?: { recursive?: boolean }): void {
        this.deletions.push({ uri, recursive: options?.recursive === true });
    }
}

let mockWorkspaceFolders: Array<{ uri: MockUri }> | undefined;
let mockFileEntries = new Map<string, MockFileEntry>();
let mockTextDocuments: MockTextDocument[] = [];
let mockAppliedWorkspaceEdits: MockWorkspaceEdit[] = [];
let mockFileWrites: Array<{ uri: MockUri | string; content: Uint8Array }> = [];
let mockFileDeletes: Array<{ uri: MockUri | string; recursive: boolean }> = [];
let mockFileRenames: Array<{ oldUri: MockUri | string; newUri: MockUri | string }> = [];
let mockApplyEditResult = true;
let mockAutomaticSyncSetting = true;
let mockWindowListenerRegistrations = 0;

function mockFileUri(fsPath: string): MockUri {
    const normalizedFsPath = path.win32.normalize(fsPath);
    const uriPath = `/${normalizedFsPath.replace(/\\/g, '/')}`;
    return {
        scheme: 'file',
        authority: '',
        path: uriPath,
        fsPath: normalizedFsPath,
        toString: () => `file://${uriPath}`,
    };
}

function mockUriKey(uri: MockUri | string): string {
    return path.win32.normalize(typeof uri === 'string' ? uri : uri.fsPath);
}

function createMockTextDocument(uri: MockUri, initialText: string, isDirty: boolean = true): MockTextDocument {
    let text = initialText;
    const document: MockTextDocument = {
        uri,
        isDirty,
        version: 1,
        getText: () => text,
        positionAt: offset => ({ offset }),
        applyText: nextText => {
            text = nextText;
            document.version++;
        },
    };
    return document;
}

function resetMockWorkspace(
    folders?: MockUri[],
    entries: Array<[string, MockFileEntry]> = [],
): void {
    mockWorkspaceFolders = folders?.map(uri => ({ uri }));
    mockFileEntries = new Map(entries.map(([entryPath, entry]) => [
        path.win32.normalize(entryPath),
        entry,
    ]));
    mockTextDocuments = [];
    mockAppliedWorkspaceEdits = [];
    mockFileWrites = [];
    mockFileDeletes = [];
    mockFileRenames = [];
    mockApplyEditResult = true;
    mockAutomaticSyncSetting = true;
}

const mockWorkspaceFs = {
    async readFile(uri: MockUri | string): Promise<Uint8Array> {
        const entry = mockFileEntries.get(mockUriKey(uri));
        if (!entry || entry.type !== 1) throw new MockFileSystemError('File not found', 'FileNotFound');
        return new TextEncoder().encode(entry.content ?? '');
    },
    async stat(uri: MockUri | string): Promise<{ type: number; size: number }> {
        const entry = mockFileEntries.get(mockUriKey(uri));
        if (!entry) throw new MockFileSystemError('File not found', 'FileNotFound');
        return {
            type: entry.type,
            size: entry.size ?? new TextEncoder().encode(entry.content ?? '').byteLength,
        };
    },
    async readDirectory(uri: MockUri | string): Promise<Array<[string, number]>> {
        const directoryPath = mockUriKey(uri);
        const directory = mockFileEntries.get(directoryPath);
        if (!directory || directory.type !== 2) {
            throw new MockFileSystemError('Directory not found', 'FileNotFound');
        }
        const children: Array<[string, number]> = [];
        for (const [entryPath, entry] of mockFileEntries) {
            if (entryPath !== directoryPath && path.win32.dirname(entryPath) === directoryPath) {
                children.push([path.win32.basename(entryPath), entry.type]);
            }
        }
        return children;
    },
    async createDirectory(): Promise<void> {},
    async writeFile(uri: MockUri | string, content: Uint8Array): Promise<void> {
        mockFileWrites.push({ uri, content });
    },
    async delete(uri: MockUri | string, options?: { recursive?: boolean }): Promise<void> {
        mockFileDeletes.push({ uri, recursive: options?.recursive === true });
        const target = mockUriKey(uri);
        for (const entryPath of [...mockFileEntries.keys()]) {
            if (entryPath === target || (options?.recursive && entryPath.startsWith(`${target}\\`))) {
                mockFileEntries.delete(entryPath);
            }
        }
    },
    async rename(oldUri: MockUri | string, newUri: MockUri | string): Promise<void> {
        mockFileRenames.push({ oldUri, newUri });
        const oldPath = mockUriKey(oldUri);
        const newPath = mockUriKey(newUri);
        for (const [entryPath, entry] of [...mockFileEntries]) {
            if (entryPath === oldPath || entryPath.startsWith(`${oldPath}\\`)) {
                mockFileEntries.delete(entryPath);
                mockFileEntries.set(`${newPath}${entryPath.slice(oldPath.length)}`, entry);
            }
        }
    },
};

class MockEventEmitter {
    readonly event = () => undefined;
    fire(): void {}
    dispose(): void {}
}

class MockFileSystemError extends Error {
    constructor(message: string, readonly code?: string) {
        super(message);
    }
}

Module._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') {
        return {
            EventEmitter: MockEventEmitter,
            FileSystemError: MockFileSystemError,
            FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
            ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
            env: { openExternal: (uri: { toString(): string }) => openExternalImpl(uri) },
            Uri: {
                parse: (value: string) => ({ toString: () => value }),
                joinPath: (
                    base: MockUri | string,
                    ...segments: string[]
                ): MockUri | string => typeof base === 'string'
                    ? [base, ...segments].join('/')
                    : mockFileUri(path.win32.join(base.fsPath, ...segments)),
                from: (components: { scheme: string; path: string }): MockUri => ({
                    scheme: components.scheme,
                    path: components.path,
                    fsPath: components.path,
                    toString: () => `${components.scheme}:${components.path}`,
                }),
            },
            Range: MockRange,
            WorkspaceEdit: MockWorkspaceEdit,
            window: {
                showWarningMessage: async () => undefined,
                showInformationMessage: async () => undefined,
                onDidChangeTextEditorSelection: (
                    _listener: (...args: unknown[]) => void,
                ) => {
                    mockWindowListenerRegistrations++;
                    return { dispose: () => undefined };
                },
                onDidChangeVisibleTextEditors: (
                    _listener: (...args: unknown[]) => void,
                ) => {
                    mockWindowListenerRegistrations++;
                    return { dispose: () => undefined };
                },
            },
            commands: {
                executeCommand: (...args: unknown[]) => executeCommandImpl(...args),
            },
            workspace: {
                get workspaceFolders() { return mockWorkspaceFolders; },
                get textDocuments() { return mockTextDocuments; },
                getConfiguration: () => ({
                    get: (_name: string, fallback: unknown) => mockAutomaticSyncSetting ?? fallback,
                }),
                fs: mockWorkspaceFs,
                applyEdit: async (edit: MockWorkspaceEdit) => {
                    mockAppliedWorkspaceEdits.push(edit);
                    if (!mockApplyEditResult) return false;
                    for (const replacement of edit.replacements) {
                        const document = mockTextDocuments.find(candidate =>
                            candidate.uri.toString() === replacement.uri.toString()
                        );
                        document?.applyText(replacement.text);
                    }
                    for (const rename of edit.renames) {
                        const oldPath = mockUriKey(rename.oldUri);
                        const newPath = mockUriKey(rename.newUri);
                        for (const [entryPath, entry] of [...mockFileEntries]) {
                            if (entryPath === oldPath || entryPath.startsWith(`${oldPath}\\`)) {
                                mockFileEntries.delete(entryPath);
                                mockFileEntries.set(`${newPath}${entryPath.slice(oldPath.length)}`, entry);
                            }
                        }
                        for (const document of mockTextDocuments) {
                            const documentPath = mockUriKey(document.uri);
                            if (documentPath === oldPath || documentPath.startsWith(`${oldPath}\\`)) {
                                document.uri = mockFileUri(`${newPath}${documentPath.slice(oldPath.length)}`);
                            }
                        }
                    }
                    for (const deletion of edit.deletions) {
                        const target = mockUriKey(deletion.uri);
                        for (const entryPath of [...mockFileEntries.keys()]) {
                            if (
                                entryPath === target
                                || (deletion.recursive && entryPath.startsWith(`${target}\\`))
                            ) {
                                mockFileEntries.delete(entryPath);
                            }
                        }
                    }
                    return true;
                },
            },
        };
    }
    if (request === '../api/socketio' && useSocketIoMock) {
        return { SocketIOAPI: class {} };
    }
    if (request === './ignoreParser') {
        return { IgnoreParser: class {} };
    }
    if (request === 'form-data') {
        return class FormData {
            append(): void {}
        };
    }
    if (request === 'mime-types') {
        return { lookup: () => 'application/octet-stream' };
    }
    if (request === 'node-fetch') {
        return {
            __esModule: true,
            default: (url?: unknown, options?: unknown) => fetchImplementation(url, options),
        };
    }
    return originalLoad(request, parent, isMain);
};

async function run(): Promise<void> {
    const syncAuthorizationTarget = {
        workspaceUri: 'file:///trusted-workspace',
        serverUrl: 'https://overleaf.example',
        projectId: 'project-a',
    };
    const approvedTargets = approveSyncTarget(undefined, syncAuthorizationTarget);
    assert.equal(isSyncTargetApproved(approvedTargets, syncAuthorizationTarget), true);
    assert.equal(isSyncTargetApproved(approvedTargets, {
        ...syncAuthorizationTarget,
        projectId: 'project-b',
    }), false, 'changing the project must invalidate prior synchronization consent');
    assert.equal(isSyncTargetApproved(approvedTargets, {
        ...syncAuthorizationTarget,
        serverUrl: 'https://different-overleaf.example',
    }), false, 'changing the server must invalidate prior synchronization consent');
    assert.equal(isSyncTargetApproved(approvedTargets, {
        ...syncAuthorizationTarget,
        workspaceUri: 'file:///other-workspace',
    }), false, 'synchronization consent must remain scoped to one workspace');
    assert.match(createSyncTargetFingerprint(syncAuthorizationTarget), /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(revokeSyncTarget(approvedTargets, syncAuthorizationTarget.workspaceUri), []);
    assert.equal(isSyncTargetApproved([{ workspaceUri: 1, fingerprint: 'unsafe' }], syncAuthorizationTarget), false,
        'corrupt workspace authorization state must fail closed');

    const latexCleanup = removeStandaloneLatexComments([
        '% remove this\r\n',
        'Text % keep inline\r\n',
        '\\% keep escaped\r\n',
        '\r\n',
        '\\begin{verbatim}\r\n',
        '% keep verbatim\r\n',
        '\\end{verbatim}\r\n',
        '\\begin{comment}\r\n',
        'ignored content\r\n',
        '\\end{comment}\r\n',
        'After\r\n',
    ].join(''));
    assert.equal(latexCleanup.removedLines, 4);
    assert.equal(latexCleanup.removedBlocks, 1);
    assert.equal(latexCleanup.content, [
        'Text % keep inline\r\n',
        '\\% keep escaped\r\n',
        '\r\n',
        '\\begin{verbatim}\r\n',
        '% keep verbatim\r\n',
        '\\end{verbatim}\r\n',
        'After\r\n',
    ].join(''), 'comment cleanup must preserve inline text, verbatim content, blank lines, and CRLF endings');

    const incompleteCommentEnvironment = '\\begin{comment}\nkeep this text\n';
    assert.deepStrictEqual(
        removeStandaloneLatexComments(incompleteCommentEnvironment),
        { content: incompleteCommentEnvironment, removedLines: 0, removedBlocks: 0 },
        'an unterminated comment environment must be preserved fail-safe',
    );
    assert.deepStrictEqual(
        removeStandaloneLatexComments('prefix\n  % remove\nsuffix'),
        { content: 'prefix\nsuffix', removedLines: 1, removedBlocks: 0 },
        'standalone comments must be removed without adding or collapsing unrelated lines',
    );

    useSocketIoMock = false;
    const { SocketIOAPI } = require(path.join('..', 'api', 'socketio')) as {
        SocketIOAPI: new (api: unknown, identity: unknown, projectId: string) => {
            registerHandlers(handlers: {
                onConnected?: (publicId: string) => void;
                onFileCreated?: (parentId: string, type: string, entity: unknown) => void;
                onFileRenamed?: (entityId: string, newName: string) => void;
                onFileChanged?: (update: unknown) => void;
                onUserCursorUpdated?: (update: unknown) => void;
                onDisconnected?: (isAuthError?: boolean) => void;
            }): void;
            joinProject(): Promise<unknown>;
            joinDoc(docId: string): Promise<{ lines: string[]; version: number }>;
            getConnectedUsers(): Promise<unknown[]>;
            disconnect(): void;
        };
    };
    useSocketIoMock = true;
    const { isAutomaticSyncEnabled } = require(path.join('..', 'utils', 'settingsManager')) as {
        isAutomaticSyncEnabled(settings: {
            getSettings(): { autoSync: boolean } | undefined;
            getWorkspaceFolder(): unknown;
        }): boolean;
    };
    const automaticSettings = (projectAutoSync: boolean) => ({
        getSettings: () => ({ autoSync: projectAutoSync }),
        getWorkspaceFolder: () => mockFileUri('D:\\workspace'),
    });
    mockAutomaticSyncSetting = true;
    assert.equal(isAutomaticSyncEnabled(automaticSettings(true)), true);
    assert.equal(isAutomaticSyncEnabled(automaticSettings(false)), false,
        'the project setting must disable background synchronization');
    mockAutomaticSyncSetting = false;
    assert.equal(isAutomaticSyncEnabled(automaticSettings(true)), false,
        'the VS Code setting must disable background synchronization');
    mockAutomaticSyncSetting = true;

    const { isSyncInitializationSnapshotCurrent } = require(
        path.join('..', 'utils', 'syncInitialization')
    ) as {
        isSyncInitializationSnapshotCurrent(snapshot: {
            deactivating: boolean;
            currentGeneration: number;
            expectedGeneration: number;
            currentSyncKey?: string;
            activeSyncKey?: string;
            expectedSyncKey: string;
        }): boolean;
    };
    const currentInitialization = {
        deactivating: false,
        currentGeneration: 4,
        expectedGeneration: 4,
        currentSyncKey: 'workspace|server|project-a',
        activeSyncKey: 'workspace|server|project-a',
        expectedSyncKey: 'workspace|server|project-a',
    };
    assert.equal(isSyncInitializationSnapshotCurrent(currentInitialization), true);
    assert.equal(isSyncInitializationSnapshotCurrent({
        ...currentInitialization,
        currentGeneration: 5,
    }), false, 'a newer initialization must invalidate an older async continuation');
    assert.equal(isSyncInitializationSnapshotCurrent({
        ...currentInitialization,
        currentSyncKey: 'workspace|server|project-b',
    }), false, 'changing project settings must invalidate an in-flight initialization');
    assert.equal(isSyncInitializationSnapshotCurrent({
        ...currentInitialization,
        activeSyncKey: undefined,
    }), false, 'a session key claimed or cleared elsewhere must invalidate an in-flight initialization');
    assert.equal(isSyncInitializationSnapshotCurrent({
        ...currentInitialization,
        deactivating: true,
    }), false, 'deactivation must invalidate every async initialization');

    const { BaseAPI } = require(path.join('..', 'api', 'base')) as {
        BaseAPI: new (url: string) => {
            setIdentity(identity: unknown): void;
            getIdentity(): { cookies: string; csrfToken: string } | undefined;
            dispose(): void;
            cookiesLogin(cookies: string): Promise<unknown>;
            getProjects(): Promise<unknown>;
            getProjectDetails(projectId: string): Promise<unknown>;
            passportLogin(email: string, password: string): Promise<unknown>;
            verifyCredentials(): Promise<unknown>;
            uploadFile(
                projectId: string,
                folderId: string,
                filename: string,
                content: Uint8Array
            ): Promise<unknown>;
            addDoc(projectId: string, folderId: string, filename: string): Promise<unknown>;
            getFile(projectId: string, fileId: string): Promise<unknown>;
            getDocContent(projectId: string, docId: string): Promise<unknown>;
        };
    };
    const { SyncEngine } = require(path.join('..', 'sync', 'syncEngine')) as {
        SyncEngine: new (...args: unknown[]) => object;
    };
    const { CursorTracker } = require(path.join('..', 'collaboration', 'cursorTracker')) as {
        CursorTracker: new (...args: unknown[]) => object;
    };

    const cursorQueue = Object.create(CursorTracker.prototype) as any;
    const cursorCalls: Array<[string, number, number]> = [];
    let releaseFirstCursorCall: (() => void) | undefined;
    const firstCursorCall = new Promise<void>(resolve => { releaseFirstCursorCall = resolve; });
    cursorQueue.socket = {
        updatePosition: async (docId: string, row: number, column: number) => {
            cursorCalls.push([docId, row, column]);
            if (cursorCalls.length === 1) await firstCursorCall;
        },
    };
    cursorQueue.disposed = false;
    cursorQueue.publishingLocalPosition = false;
    const cursorPublishing = cursorQueue.queueLocalPosition('doc', 1, 1);
    await new Promise<void>(resolve => setImmediate(resolve));
    await cursorQueue.queueLocalPosition('doc', 2, 2);
    await cursorQueue.queueLocalPosition('doc', 3, 3);
    assert.deepStrictEqual(cursorCalls, [['doc', 1, 1]],
        'cursor updates must not create concurrent Socket.IO ACK callbacks');
    releaseFirstCursorCall!();
    await cursorPublishing;
    assert.deepStrictEqual(cursorCalls, [['doc', 1, 1], ['doc', 3, 3]],
        'cursor publishing must retain only the latest position while an ACK is pending');

    let disposedCursorDecoration = 0;
    cursorQueue.users = new Map([['client', {
        userId: 'user',
        decoration: { dispose: () => { disposedCursorDecoration++; } },
    }]]);
    cursorQueue.userIdToColor = new Map([['user', '#fff']]);
    cursorQueue.disposables = [];
    cursorQueue.handleUserDisconnected('client');
    assert.equal(cursorQueue.userIdToColor.size, 0,
        'disconnected user colors must not accumulate for the lifetime of the extension');
    cursorQueue.dispose();
    assert.equal(disposedCursorDecoration, 1);

    let finishDisposedCursorInitialization: ((users: unknown[]) => void) | undefined;
    const disposedCursorInitialization = Object.create(CursorTracker.prototype) as any;
    disposedCursorInitialization.socket = {
        getConnectedUsers: () => new Promise<unknown[]>(resolve => {
            finishDisposedCursorInitialization = resolve;
        }),
    };
    disposedCursorInitialization.users = new Map();
    disposedCursorInitialization.userIdToColor = new Map();
    disposedCursorInitialization.disposables = [];
    disposedCursorInitialization.initialized = false;
    disposedCursorInitialization.disposed = false;
    const listenerRegistrationsBeforeDispose = mockWindowListenerRegistrations;
    const pendingCursorInitialization = disposedCursorInitialization.initialize();
    disposedCursorInitialization.dispose();
    finishDisposedCursorInitialization!([]);
    await pendingCursorInitialization;
    assert.equal(
        mockWindowListenerRegistrations,
        listenerRegistrationsBeforeDispose,
        'a cursor tracker disposed during initialization must not register editor listeners afterwards',
    );
    assert.deepStrictEqual(disposedCursorInitialization.disposables, []);

    const legacyProject = {
        _id: 'legacy-project',
        name: 'Legacy project',
        rootFolder: [{
            _id: 'legacy-root',
            name: 'rootFolder',
            docs: [],
            fileRefs: [],
            folders: [],
        }],
        owner: { _id: 'owner', email: 'owner@example.com', first_name: 'Owner' },
        members: [],
    };
    const legacyQueries: Array<string | undefined> = [];
    let legacyConnectedId: string | undefined;
    const legacySocket = new FakeSocket((event, args) => {
        if (event === 'joinProject') {
            const callback = args.at(-1) as (...callbackArgs: unknown[]) => void;
            callback(null, legacyProject, 'owner', 0);
        }
    });
    const legacyApi = {
        initSocket: (_identity: unknown, query?: string) => {
            legacyQueries.push(query);
            queueMicrotask(() => {
                legacySocket.trigger('connect');
                legacySocket.trigger('connectionAccepted', undefined, 'legacy-public-id');
            });
            return legacySocket;
        },
    };
    const legacyClient = new SocketIOAPI(legacyApi, { cookies: 'cookie', csrfToken: 'csrf' }, 'legacy-project');
    legacyClient.registerHandlers({ onConnected: publicId => { legacyConnectedId = publicId; } });
    assert.deepStrictEqual(await legacyClient.joinProject(), legacyProject);
    assert.deepStrictEqual(legacyQueries, [undefined], 'legacy servers must be joined without a handshake query');
    assert.equal(legacyConnectedId, 'legacy-public-id');
    legacyClient.disconnect();

    const queryProject = {
        ...legacyProject,
        _id: 'query-project',
        name: 'Query project',
    };
    const negotiatedQueries: Array<string | undefined> = [];
    const negotiatedSockets: FakeSocket[] = [];
    let renamedEvent: [string, string] | undefined;
    let createdEventCount = 0;
    let documentUpdateCount = 0;
    let cursorUpdateCount = 0;
    const negotiationApi = {
        initSocket: (_identity: unknown, query?: string) => {
            negotiatedQueries.push(query);
            const socket = new FakeSocket((event) => {
                if (event === 'joinProject' && query === undefined) {
                    socket.trigger('connectionRejected', {
                        message: 'missing/bad ?projectId=... query flag on handshake',
                    });
                }
            });
            negotiatedSockets.push(socket);
            queueMicrotask(() => {
                socket.trigger('connect');
                if (query !== undefined) {
                    socket.trigger('joinProjectResponse', {
                        publicId: 'query-public-id',
                        project: queryProject,
                    });
                }
            });
            return socket;
        },
    };
    const negotiatedClient = new SocketIOAPI(
        negotiationApi,
        { cookies: 'cookie', csrfToken: 'csrf' },
        'query project/with spaces',
    );
    negotiatedClient.registerHandlers({
        onFileCreated: () => { createdEventCount++; },
        onFileRenamed: (entityId, newName) => { renamedEvent = [entityId, newName]; },
        onFileChanged: () => { documentUpdateCount++; },
        onUserCursorUpdated: () => { cursorUpdateCount++; },
    });
    assert.deepStrictEqual(await negotiatedClient.joinProject(), queryProject);
    assert.equal(negotiatedQueries.length, 2);
    assert.equal(negotiatedQueries[0], undefined);
    assert.match(negotiatedQueries[1] || '', /^\?projectId=query%20project%2Fwith%20spaces&t=\d+$/);
    negotiatedSockets[1].trigger('reciveEntityRename', 'doc-id', 'renamed.tex');
    assert.deepStrictEqual(renamedEvent, ['doc-id', 'renamed.tex'],
        'event handlers must survive Socket.IO protocol negotiation');
    negotiatedSockets[1].trigger('reciveEntityRename', 'doc-id', '../outside.tex');
    assert.deepStrictEqual(renamedEvent, ['doc-id', 'renamed.tex'],
        'unsafe remote entity names must be discarded at the socket boundary');
    negotiatedSockets[1].trigger('reciveNewDoc', 'folder-id', {
        _id: 'new-doc',
        name: 'new.tex',
        ignoredPayload: { deeply: 'nested' },
    });
    negotiatedSockets[1].trigger('reciveNewDoc', 'folder-id', { _id: 'new-doc', name: '..' });
    assert.equal(createdEventCount, 1,
        'remote filesystem events must be validated and reduced to safe entity fields');
    negotiatedSockets[1].trigger('otUpdateApplied', { doc: 'doc-id', v: 1, op: [{ p: 0, i: 'x' }] });
    negotiatedSockets[1].trigger('otUpdateApplied', { doc: 'doc-id', v: 1, op: [null] });
    assert.equal(documentUpdateCount, 1, 'malformed OT events must be discarded at the socket boundary');
    negotiatedSockets[1].trigger('clientTracking.clientUpdated', {
        id: 'client-id',
        user_id: 'user-id',
        name: 'Collaborator',
        email: 'collaborator@example.com',
        doc_id: 'doc-id',
        row: 1,
        column: 2,
    });
    negotiatedSockets[1].trigger('clientTracking.clientUpdated', null);
    assert.equal(cursorUpdateCount, 1, 'malformed presence events must be discarded at the socket boundary');
    negotiatedClient.disconnect();

    let joinDocResponse: unknown[] = [['server text'], 4];
    let connectedUsersResponse: unknown = [{
        client_id: 'client-id',
        user_id: 'user-id',
        first_name: 'Safe',
        last_name: 'User',
        email: 'safe@example.com',
        cursorData: { doc_id: 'doc-id', row: 3, column: 5 },
        last_updated_at: '1234',
    }, null];
    const boundarySocket = new FakeSocket((event, args) => {
        const callback = args.at(-1) as (...callbackArgs: unknown[]) => void;
        if (event === 'joinDoc') callback(null, ...joinDocResponse);
        if (event === 'clientTracking.getConnectedUsers') callback(null, connectedUsersResponse);
    });
    const boundaryClient = new SocketIOAPI({
        initSocket: () => boundarySocket,
    }, { cookies: 'cookie', csrfToken: 'csrf' }, 'project');
    assert.deepStrictEqual(
        await boundaryClient.joinDoc('doc-id'),
        { lines: ['server text'], version: 4 },
    );
    joinDocResponse = [['valid line', 123], 4];
    await assert.rejects(
        () => boundaryClient.joinDoc('doc-id'),
        /invalid Socket\.IO document content/,
        'non-string document lines must be rejected before decoding',
    );
    joinDocResponse = [['server text'], -1];
    await assert.rejects(
        () => boundaryClient.joinDoc('doc-id'),
        /invalid document version/,
    );
    assert.deepStrictEqual(await boundaryClient.getConnectedUsers(), [{
        clientId: 'client-id',
        userId: 'user-id',
        name: 'Safe User',
        email: 'safe@example.com',
        docId: 'doc-id',
        row: 3,
        column: 5,
        lastUpdated: 1234,
    }], 'malformed connected-user records must be ignored');
    connectedUsersResponse = {};
    await assert.rejects(
        () => boundaryClient.getConnectedUsers(),
        /invalid connected-user list/,
    );
    boundaryClient.disconnect();

    const slowDocumentSocket = new FakeSocket((event, args) => {
        if (event !== 'joinDoc') return;
        const callback = args.at(-1) as (...values: unknown[]) => void;
        setTimeout(() => callback(null, ['loaded from storage'], 4), 10);
    });
    const slowDocumentClient = new SocketIOAPI({
        initSocket: () => slowDocumentSocket,
    }, { cookies: 'cookie', csrfToken: 'csrf' }, 'project');
    (slowDocumentClient as any).socketEventTimeoutMs = 1;
    (slowDocumentClient as any).documentReadTimeoutMs = 1000;
    assert.deepStrictEqual(await slowDocumentClient.joinDoc('doc-id'), {
        lines: ['loaded from storage'], version: 4,
    }, 'document reads must survive a response slower than the generic event acknowledgement deadline');
    assert.equal(slowDocumentSocket.disconnectCount, 0, 'a successful slow document read must keep the socket alive');
    slowDocumentClient.disconnect();

    const stalledSocket = new FakeSocket();
    const stalledClient = new SocketIOAPI({
        initSocket: () => stalledSocket,
    }, { cookies: 'cookie', csrfToken: 'csrf' }, 'project');
    let timeoutDisconnectNotifications = 0;
    stalledClient.registerHandlers({
        onDisconnected: () => { timeoutDisconnectNotifications++; },
    });
    (stalledClient as any)._connected = true;
    (stalledClient as any).documentReadTimeoutMs = 1;
    await assert.rejects(
        () => stalledClient.joinDoc('doc-id'),
        /Socket event "joinDoc" timed out/,
        'an unanswered ACK must terminate the stalled socket instead of retaining its callback',
    );
    assert.equal(stalledSocket.removeAllListenersCount, 1);
    assert.equal(stalledSocket.disconnectCount, 1);
    assert.equal(timeoutDisconnectNotifications, 1,
        'a timed-out live socket must surface the connection loss exactly once');
    assert.equal((stalledClient as any).socket, undefined);

    const overloadedSocket = new FakeSocket();
    const overloadedClient = new SocketIOAPI({
        initSocket: () => overloadedSocket,
    }, { cookies: 'cookie', csrfToken: 'csrf' }, 'project');
    (overloadedClient as any)._connected = true;
    (overloadedClient as any).documentReadTimeoutMs = 5;
    (overloadedClient as any).maxPendingSocketEvents = 1;
    const firstPendingEvent = overloadedClient.joinDoc('first-doc');
    await assert.rejects(
        () => overloadedClient.joinDoc('second-doc'),
        /Too many pending Socket\.IO events/,
        'pending ACK callbacks must be capped before another event is emitted',
    );
    assert.equal(overloadedSocket.disconnectCount, 1,
        'exceeding the pending ACK limit must close the stalled transport');
    await assert.rejects(() => firstPendingEvent, /disposed/);
    assert.equal((overloadedClient as any).pendingSocketEvents.size, 0);

    const forcedSocket = new FakeSocket();
    const forcedClient = new SocketIOAPI({
        initSocket: () => forcedSocket,
    }, { cookies: 'cookie', csrfToken: 'csrf' }, 'project');
    let forcedAuthNotification: boolean | undefined;
    forcedClient.registerHandlers({
        onDisconnected: isAuthError => { forcedAuthNotification = isAuthError; },
    });
    (forcedClient as any)._connected = true;
    forcedSocket.trigger('forceDisconnect', 'session expired');
    assert.equal(forcedAuthNotification, true);
    assert.equal(forcedSocket.disconnectCount, 1,
        'a server-forced disconnect must close the transport immediately');
    assert.equal((forcedClient as any).socket, undefined);

    assert.throws(
        () => validateRemoteDocumentLines(new Array(MAX_REMOTE_DOCUMENT_LINES + 1).fill('')),
        /oversized document content/,
        'document line counts must be bounded even when every line is empty',
    );

    const api = new BaseAPI('https://overleaf.example/');
    assert.throws(
        () => api.setIdentity({ cookies: 'cookie\r\nInjected: true', csrfToken: 'csrf' }),
        /Invalid Overleaf cookie header/,
        'programmatically supplied identities must not inject HTTP headers',
    );
    const sourceIdentity = { cookies: 'cookie', csrfToken: 'csrf' };
    api.setIdentity(sourceIdentity);
    sourceIdentity.cookies = 'mutated';
    assert.equal(api.getIdentity()?.cookies, 'cookie',
        'the API must retain a defensive copy of authentication secrets');
    assert.deepStrictEqual(
        await api.passportLogin('x'.repeat(4097), 'password'),
        { type: 'error', message: 'The Overleaf login email is invalid.' },
    );
    assert.deepStrictEqual(
        await api.passportLogin('safe@example.com', 'x'.repeat(65_537)),
        { type: 'error', message: 'The Overleaf login password is invalid.' },
    );
    await assert.rejects(
        () => api.getDocContent('project\r\nInjected: true', 'doc-id'),
        /Invalid Overleaf project ID/,
        'opaque route IDs must reject HTTP control characters before request construction',
    );
    fetchResponse = {
        ok: true,
        status: 200,
        json: async () => ({ projects: new Array(100_001).fill(null) }),
        text: async () => JSON.stringify({ projects: new Array(100_001).fill(null) }),
    };
    assert.deepStrictEqual(
        await api.getProjects(),
        { type: 'error', message: 'Overleaf returned an invalid project list.' },
        'project-list cardinality must be bounded before iteration',
    );
    fetchResponse = {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '<meta name="ol-project_id" content="different-project">',
    };
    assert.deepStrictEqual(
        await api.getProjectDetails('expected-project'),
        { type: 'error', message: 'Overleaf returned metadata for a different project.' },
        'HTTP fallback metadata must not switch the requested project identity',
    );
    fetchResponse = {
        ok: true,
        status: 200,
        json: async () => ({ entity_id: 'binary-id-1', entity_type: 'folder' }),
        text: async () => '',
    };
    const upload = await api.uploadFile(
        'project',
        'folder',
        'figure.pdf',
        Uint8Array.from([1, 2, 3])
    ) as {
        type: string;
        file?: { _id: string; _type: string; name: string };
    };
    assert.equal(upload.type, 'error', 'an invalid upload type must not be relabeled as a file');
    assert.equal(upload.file, undefined);
    fetchResponse = {
        ok: true,
        status: 200,
        json: async () => ({ entity_id: 'binary-id\r\nInjected: true' }),
        text: async () => '',
    };
    const invalidUploadIdentity = await api.uploadFile(
        'project',
        'folder',
        'figure.pdf',
        Uint8Array.from([1, 2, 3]),
    ) as { type: string; file?: unknown };
    assert.equal(invalidUploadIdentity.type, 'success');
    assert.equal(invalidUploadIdentity.file, undefined,
        'malformed uploaded entity IDs must be discarded at the HTTP boundary');
    assert.deepStrictEqual(
        await api.uploadFile(
            'project',
            'folder',
            'oversized.bin',
            { byteLength: MAX_REMOTE_FILE_BYTES + 1 } as Uint8Array,
        ),
        { type: 'error', message: 'The local file exceeds the synchronization size limit.' },
        'the HTTP upload boundary must reject invalid or oversized byte inputs before multipart encoding',
    );

    fetchResponse = {
        ok: true,
        status: 200,
        json: async () => ({ doc: { _id: 'doc-id-1', name: 'chapter.tex' } }),
        text: async () => '',
    };
    const documentResult = await api.addDoc('project', 'folder', 'chapter.tex') as {
        type: string;
        doc?: { _id: string; _type: string; name: string };
    };
    assert.deepStrictEqual(documentResult.doc, {
        _id: 'doc-id-1',
        _type: 'doc',
        name: 'chapter.tex',
    });
    await assert.rejects(
        () => api.addDoc('project', 'folder', '../outside.tex'),
        /Unsafe Overleaf entity name/,
        'entity names must be validated again at the HTTP boundary',
    );
    await assert.rejects(
        () => (api as any).deleteEntity('project', '../../logout', 'entity'),
        /entity type/,
    );

    fetchResponse = {
        ok: true,
        status: 200,
        json: async () => ({ lines: ['safe', 'document'] }),
        text: async () => JSON.stringify({ lines: ['safe', 'document'] }),
    };
    assert.deepStrictEqual(
        await api.getDocContent('project', 'doc-id'),
        { type: 'success', lines: ['safe', 'document'] },
    );
    fetchResponse = {
        ok: true,
        status: 200,
        json: async () => ({ lines: ['safe', 123] }),
        text: async () => JSON.stringify({ lines: ['safe', 123] }),
    };
    assert.deepStrictEqual(
        await api.getDocContent('project', 'doc-id'),
        { type: 'error', message: 'Overleaf returned invalid document content.' },
        'HTTP document responses must use the same validation as Socket.IO',
    );

    const rangeHeaders: Array<string | undefined> = [];
    const downloadUrls: string[] = [];
    const partialResponses = [
        { range: 'bytes 0-1/4', bytes: [1, 2] },
        { range: 'bytes 2-3/4', bytes: [3, 4] },
    ];
    fetchImplementation = async (url, options) => {
        downloadUrls.push(String(url));
        const request = options as { headers?: Record<string, string> };
        rangeHeaders.push(request.headers?.Range);
        const partial = partialResponses.shift();
        assert.ok(partial, 'partial download requested too many chunks');
        return {
            ok: true,
            status: 206,
            json: async () => ({}),
            text: async () => '',
            buffer: async () => Buffer.from(partial.bytes),
            headers: { get: name => name.toLowerCase() === 'content-range' ? partial.range : null },
        };
    };
    const partialDownload = await api.getFile('project/../../other', 'partial?file') as {
        type: string;
        content?: Uint8Array;
    };
    assert.equal(partialDownload.type, 'success');
    assert.deepStrictEqual([...partialDownload.content!], [1, 2, 3, 4]);
    assert.deepStrictEqual(rangeHeaders, [undefined, 'bytes=2-']);
    assert.ok(
        downloadUrls.every(url => url.includes('project/project%2F..%2F..%2Fother/file/partial%3Ffile')),
        'opaque IDs must remain encoded inside their URL segments',
    );

    fetchImplementation = async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({}),
        text: async () => 'Forbidden',
        buffer: async () => Buffer.alloc(0),
        headers: { get: () => null },
    });
    const deniedDownload = await api.getFile('project', 'denied-file') as {
        type: string;
        authError?: string;
        content?: Uint8Array;
    };
    assert.equal(deniedDownload.type, 'error');
    assert.equal(deniedDownload.authError, undefined,
        'a project-level 403 may be a permission denial and must not erase a valid session');
    assert.equal(deniedDownload.content, undefined, 'HTTP errors must never become empty successful files');

    fetchImplementation = async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({}),
        text: async () => 'Unauthorized',
        buffer: async () => Buffer.alloc(0),
        headers: { get: () => null },
    });
    const unauthorizedDownload = await api.getFile('project', 'expired-file') as {
        type: string;
        authError?: string;
    };
    assert.equal(unauthorizedDownload.type, 'error');
    assert.equal(unauthorizedDownload.authError, 'session_expired');

    fetchImplementation = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
        text: async () => [
            '<p>İstanbul</p>',
            '<script>const fake = "<meta name=\'ol-user_id\' content=\'script-user\'>";</script>',
            '<!-- <meta name="ol-csrfToken" content="comment-token"> -->',
            '<META data-note=ignored CONTENT=\'user&#45;id\' NAME=\'OL-USER_ID\'>',
            '<meta CONTENT="person&#64;example.test" name="OL-USERSEMAIL">',
            '<MeTa content=\'csrf&gt;token\' data-note=\'value > still quoted\' NAME=\'ol-csrftoken\'>',
        ].join(''),
        headers: { get: () => null, raw: () => ({}) },
    });
    const flexibleMetadata = await api.verifyCredentials() as {
        type: string;
        userInfo?: { userId: string; userEmail: string };
    };
    assert.equal(flexibleMetadata.type, 'success');
    assert.deepStrictEqual(flexibleMetadata.userInfo, {
        userId: 'user-id',
        userEmail: 'person@example.test',
    }, 'authentication metadata must allow reordered, mixed-case, and single-quoted attributes');

    fetchImplementation = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
        text: async () => [
            '<META CONTENT=\'server-project\' NAME=\'OL-PROJECT_ID\'>',
            '<meta content="Main document" name="ol-projectName">',
            '<meta CONTENT=\'root-doc\' NAME=\'ol-rootDoc_id\'>',
            '<META CONTENT=\'[{&quot;_id&quot;:&quot;root-folder&quot;}]\' DATA-TYPE=\'JSON\' NAME=\'OL-ROOTFOLDER\'>',
        ].join(''),
        headers: { get: () => null, raw: () => ({}) },
    });
    const projectMetadata = await api.getProjectDetails('server-project') as {
        type: string;
        projectData?: {
            projectId: string;
            projectName?: string;
            rootDocId?: string;
            rootFolder?: Array<{ _id?: string }>;
        };
    };
    assert.equal(projectMetadata.type, 'success');
    assert.deepStrictEqual(projectMetadata.projectData, {
        projectId: 'server-project',
        projectName: 'Main document',
        rootDocId: 'root-doc',
        userId: undefined,
        userEmail: undefined,
        compiler: undefined,
        rootFolder: [{ _id: 'root-folder' }],
    }, 'HTTP project fallback metadata must use the same order-independent parser');

    fetchImplementation = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
        text: async () => [
            '<meta name="ol-project_id" content="project-with-sharing-ui">',
            '<meta name="ol-user_id" content="user-id">',
            '<meta name="ol-rootFolder" data-type="json" content="[]">',
            '<form action="/login"><input type="password"></form>',
        ].join(''),
        headers: { get: () => 'text/html', raw: () => ({}) },
    });
    const projectWithPasswordUi = await api.getProjectDetails('project-with-sharing-ui') as {
        type: string;
        authError?: string;
        projectData?: { projectId: string };
    };
    assert.equal(projectWithPasswordUi.type, 'success',
        'authenticated project metadata must win over unrelated password UI on the page');
    assert.equal(projectWithPasswordUi.authError, undefined);
    assert.equal(projectWithPasswordUi.projectData?.projectId, 'project-with-sharing-ui');

    fetchImplementation = async () => ({
        ok: false,
        status: 302,
        statusText: 'Found',
        json: async () => ({}),
        text: async () => '',
        buffer: async () => Buffer.alloc(0),
        headers: {
            get: name => name.toLowerCase() === 'location' ? '/login?redir=/project' : null,
            raw: () => ({}),
        },
    });
    const redirectedFile = await api.getFile('project', 'file') as { authError?: string };
    const redirectedProject = await api.getProjectDetails('project') as { authError?: string };
    const redirectedDocument = await api.getDocContent('project', 'doc') as { authError?: string };
    assert.equal(redirectedFile.authError, 'session_expired',
        'file-download redirects to login must expire the session');
    assert.equal(redirectedProject.authError, 'session_expired',
        'project-detail redirects to login must expire the session');
    assert.equal(redirectedDocument.authError, 'session_expired',
        'document redirects to login must expire the session');

    fetchImplementation = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
        text: async () => '<form action="/login"><input type="password"></form>',
        headers: { get: () => 'text/html', raw: () => ({}) },
    });
    const projectLoginPage = await api.getProjectDetails('project') as { authError?: string };
    const documentLoginPage = await api.getDocContent('project', 'doc') as { authError?: string };
    assert.equal(projectLoginPage.authError, 'session_expired');
    assert.equal(documentLoginPage.authError, 'session_expired');

    fetchImplementation = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ lines: ['unused'] }),
        text: async () => JSON.stringify({ lines: ['first', 'second'] }),
        headers: { get: () => 'application/json', raw: () => ({}) },
    });
    const validHttpDocument = await api.getDocContent('project', 'doc') as {
        type: string;
        lines?: string[];
    };
    assert.equal(validHttpDocument.type, 'success');
    assert.deepStrictEqual(validHttpDocument.lines, ['first', 'second']);

    fetchImplementation = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
        text: async () => JSON.stringify({
            lines: ['<form action="/login">', '<input type="password">', '</form>'],
        }),
        headers: { get: () => 'application/json', raw: () => ({}) },
    });
    const loginExampleDocument = await api.getDocContent('project', 'doc') as {
        type: string;
        authError?: string;
        lines?: string[];
    };
    assert.equal(loginExampleDocument.type, 'success',
        'valid document JSON containing login markup must not expire the session');
    assert.equal(loginExampleDocument.authError, undefined);

    let binaryLoginStep = 0;
    fetchImplementation = async () => {
        binaryLoginStep++;
        const loginPage = '<html><form action="/login"><input type="password"></form></html>';
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({}),
            text: async () => loginPage,
            buffer: async () => Buffer.from(loginPage),
            headers: {
                get: name => name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null,
                raw: () => ({}),
            },
        };
    };
    const binaryLoginPage = await api.getFile('project', 'binary') as {
        type: string;
        authError?: string;
        content?: Uint8Array;
    };
    assert.equal(binaryLoginPage.type, 'error');
    assert.equal(binaryLoginPage.authError, 'session_expired',
        'an HTTP 200 login page must never be accepted as remote binary content');
    assert.equal(binaryLoginPage.content, undefined);
    assert.equal(binaryLoginStep, 2, 'an ambiguous HTML download must be confirmed against the account endpoint');

    let legitimateHtmlStep = 0;
    fetchImplementation = async () => {
        legitimateHtmlStep++;
        const projectHtml = '<html><form action="/login"><input type="password"></form></html>';
        const identityHtml = [
            '<meta name="ol-user_id" content="user-id">',
            '<meta name="ol-usersEmail" content="person@example.test">',
            '<meta name="ol-csrfToken" content="csrf">',
        ].join('');
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({}),
            text: async () => legitimateHtmlStep === 1 ? projectHtml : identityHtml,
            buffer: async () => Buffer.from(projectHtml),
            headers: {
                get: name => name.toLowerCase() === 'content-type' ? 'text/html' : null,
                raw: () => ({}),
            },
        };
    };
    const ambiguousHtmlFile = await api.getFile('project', 'login-form.html') as {
        type: string;
        authError?: string;
        content?: Uint8Array;
    };
    assert.equal(ambiguousHtmlFile.type, 'error');
    assert.equal(ambiguousHtmlFile.authError, undefined,
        'a login-like project file must be blocked as ambiguous without expiring a verified session');
    assert.equal(ambiguousHtmlFile.content, undefined);

    let passportStep = 0;
    let passportRequest: { headers?: Record<string, string>; body?: string } | undefined;
    fetchImplementation = async (_url, options) => {
        passportStep++;
        if (passportStep === 1) {
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => ({}),
                text: async () => '<INPUT DATA-NOTE=\'value > remains quoted\' VALUE=\'csrf&amp;value\' NAME=\'_CSRF\'>',
                headers: {
                    get: () => null,
                    raw: () => ({ 'set-cookie': ['session=login; Path=/; HttpOnly'] }),
                },
            };
        }
        passportRequest = options as { headers?: Record<string, string>; body?: string };
        return {
            ok: false,
            status: 302,
            statusText: 'Found',
            json: async () => ({}),
            text: async () => 'Found. Redirecting to /login-failed',
            headers: { get: () => '/login-failed', raw: () => ({}) },
        };
    };
    const passportResult = await api.passportLogin('person@example.test', 'password') as {
        type: string;
        message?: string;
    };
    assert.equal(passportResult.type, 'error');
    assert.equal(passportStep, 2);
    assert.equal(passportRequest?.headers?.['X-Csrf-Token'], 'csrf&value');
    assert.equal(JSON.parse(passportRequest?.body || '{}')._csrf, 'csrf&value');

    for (const transient of [
        { status: 500, statusText: 'Internal Server Error', detail: 'Planned maintenance' },
        { status: 502, statusText: 'Bad Gateway', detail: 'Reverse proxy unavailable' },
    ]) {
        fetchImplementation = async () => ({
            ok: false,
            status: transient.status,
            statusText: transient.statusText,
            json: async () => ({}),
            text: async () => transient.detail,
            headers: { get: () => null, raw: () => ({}) },
        });
        const result = await api.verifyCredentials() as {
            type: string;
            message?: string;
            authError?: string;
        };
        assert.equal(result.type, 'error');
        assert.equal(result.authError, undefined, `${transient.status} must not expire a valid local session`);
        assert.match(result.message || '', new RegExp(`^${transient.status}:`));
    }

    const gatewayPage = '<!DOCTYPE html><html><body><img src="data:image/jpeg;base64,'
        + 'A'.repeat(20000) + '"></body></html>';
    for (const contentType of ['text/html', 'text/plain', '']) {
        fetchImplementation = async () => ({
            ok: false,
            status: 502,
            statusText: 'Bad Gateway',
            text: async () => gatewayPage,
            json: async () => ({}),
            headers: { get: () => contentType, raw: () => ({}) },
        });
        for (const result of [await api.getProjects(), await api.verifyCredentials()]) {
            const failure = result as { type: string; message: string; authError?: string };
            assert.equal(failure.type, 'error');
            assert.equal(failure.authError, undefined, 'a gateway failure must preserve the stored session');
            assert.match(failure.message, /^502:.*temporarily unavailable/);
            assert.ok(failure.message.length < 200, 'an HTML gateway page must become a short explanation');
            assert.doesNotMatch(failure.message, /DOCTYPE|<html|base64|AAAA/);
        }
    }

    fetchImplementation = async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({}),
        text: async () => 'Blocked by server policy',
        headers: { get: () => null, raw: () => ({}) },
    });
    const forbiddenVerification = await api.verifyCredentials() as { type: string; authError?: string };
    const forbiddenProjects = await api.getProjects() as { type: string; authError?: string };
    assert.equal(forbiddenVerification.authError, undefined,
        'a policy/WAF 403 is not proof that the stored session expired');
    assert.equal(forbiddenProjects.authError, undefined,
        'a project-list 403 is not proof that the stored session expired');

    fetchImplementation = async url => {
        assert.equal(String(url), 'https://overleaf.example/user/projects');
        return {
            ok: false,
            status: 302,
            statusText: 'Found',
            json: async () => ({}),
            text: async () => '',
            headers: {
                get: name => name.toLowerCase() === 'location' ? '/login?redir=/project' : null,
                raw: () => ({}),
            },
        };
    };
    const projectListLoginRedirect = await api.getProjects() as { type: string; authError?: string };
    assert.equal(projectListLoginRedirect.type, 'error');
    assert.equal(
        projectListLoginRedirect.authError,
        'session_expired',
        'a project-list redirect to login must expire the session',
    );

    fetchImplementation = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
        text: async () => '<form action="/login"><input type="password"></form>',
        headers: { get: () => 'text/html', raw: () => ({}) },
    });
    const projectListLoginPage = await api.getProjects() as { type: string; authError?: string };
    assert.equal(projectListLoginPage.authError, 'session_expired',
        'a project-list login page returned with HTTP 200 must expire the session');

    fetchImplementation = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
        text: async () => JSON.stringify({
            projects: [{ _id: 'project-id', name: 'Project', accessLevel: 'owner' }],
        }),
        headers: { get: () => 'application/json', raw: () => ({}) },
    });
    const validProjectList = await api.getProjects() as { type: string; projects?: Array<{ id: string }> };
    assert.equal(validProjectList.type, 'success');
    assert.deepStrictEqual(validProjectList.projects, [{
        id: 'project-id',
        name: 'Project',
        lastUpdated: undefined,
        accessLevel: 'owner',
        archived: false,
        trashed: false,
    }]);

    let canonicalRedirectStep = 0;
    const canonicalRedirectUrls: string[] = [];
    fetchImplementation = async url => {
        canonicalRedirectUrls.push(String(url));
        canonicalRedirectStep++;
        if (canonicalRedirectStep === 1) {
            return {
                ok: false,
                status: 302,
                statusText: 'Found',
                json: async () => ({}),
                text: async () => '',
                headers: {
                    get: name => name.toLowerCase() === 'location' ? '/project/' : null,
                    raw: () => ({}),
                },
            };
        }
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({}),
            text: async () => [
                '<meta name="ol-user_id" content="canonical-user">',
                '<meta name="ol-usersEmail" content="canonical@example.test">',
                '<meta name="ol-csrfToken" content="canonical-csrf">',
            ].join(''),
            headers: { get: () => null, raw: () => ({}) },
        };
    };
    const canonicalRedirect = await api.verifyCredentials() as {
        type: string;
        authError?: string;
        userInfo?: { userId: string; userEmail: string };
    };
    assert.equal(canonicalRedirect.type, 'success');
    assert.deepStrictEqual(canonicalRedirect.userInfo, {
        userId: 'canonical-user',
        userEmail: 'canonical@example.test',
    });
    assert.deepStrictEqual(canonicalRedirectUrls, [
        'https://overleaf.example/project',
        'https://overleaf.example/project/',
    ], 'credential verification may follow one same-origin trailing-slash redirect');

    let canonicalThenLoginStep = 0;
    fetchImplementation = async () => {
        canonicalThenLoginStep++;
        const location = canonicalThenLoginStep === 1
            ? '/project/'
            : '/login?redir=/project';
        return {
            ok: false,
            status: 302,
            statusText: 'Found',
            json: async () => ({}),
            text: async () => '',
            headers: {
                get: name => name.toLowerCase() === 'location' ? location : null,
                raw: () => ({}),
            },
        };
    };
    const canonicalThenLogin = await api.verifyCredentials() as { type: string; authError?: string };
    assert.equal(canonicalThenLogin.type, 'error');
    assert.equal(canonicalThenLogin.authError, 'session_expired');
    assert.equal(canonicalThenLoginStep, 2, 'verification must follow at most one canonical redirect');

    let crossOriginRedirectRequests = 0;
    fetchImplementation = async () => {
        crossOriginRedirectRequests++;
        return {
            ok: false,
            status: 302,
            statusText: 'Found',
            json: async () => ({}),
            text: async () => '',
            headers: {
                get: name => name.toLowerCase() === 'location'
                    ? 'https://attacker.example/project/'
                    : null,
                raw: () => ({}),
            },
        };
    };
    const crossOriginRedirect = await api.verifyCredentials() as { type: string; authError?: string };
    assert.equal(crossOriginRedirect.type, 'error');
    assert.equal(crossOriginRedirect.authError, undefined);
    assert.equal(crossOriginRedirectRequests, 1, 'credential cookies must never follow a cross-origin redirect');

    let canonicalLoopRequests = 0;
    fetchImplementation = async () => {
        canonicalLoopRequests++;
        const location = canonicalLoopRequests === 1 ? '/project/' : '/project';
        return {
            ok: false,
            status: 302,
            statusText: 'Found',
            json: async () => ({}),
            text: async () => '',
            headers: {
                get: name => name.toLowerCase() === 'location' ? location : null,
                raw: () => ({}),
            },
        };
    };
    const canonicalLoop = await api.verifyCredentials() as { type: string; authError?: string };
    assert.equal(canonicalLoop.type, 'error');
    assert.equal(canonicalLoop.authError, undefined);
    assert.equal(canonicalLoopRequests, 2, 'canonical redirects must never form a request loop');

    fetchImplementation = async () => ({
        ok: false,
        status: 302,
        statusText: 'Found',
        json: async () => ({}),
        text: async () => '',
        headers: {
            get: name => name.toLowerCase() === 'location' ? '/login?redir=/project' : null,
            raw: () => ({}),
        },
    });
    const loginRedirect = await api.verifyCredentials() as { type: string; authError?: string };
    assert.equal(loginRedirect.type, 'error');
    assert.equal(loginRedirect.authError, 'session_expired');

    fetchImplementation = async () => ({
        ok: false,
        status: 302,
        statusText: 'Found',
        json: async () => ({}),
        text: async () => 'Maintenance',
        headers: {
            get: name => name.toLowerCase() === 'location' ? '/maintenance' : null,
            raw: () => ({}),
        },
    });
    const maintenanceRedirect = await api.verifyCredentials() as {
        type: string;
        authError?: string;
    };
    assert.equal(maintenanceRedirect.type, 'error');
    assert.equal(maintenanceRedirect.authError, undefined, 'non-login redirects must remain transient errors');

    fetchImplementation = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
        text: async () => '<FORM ACTION=\'/LOGIN\'><INPUT TYPE=\'PASSWORD\' NAME=\'password\'></FORM>',
        headers: { get: () => null, raw: () => ({}) },
    });
    const loginPage = await api.verifyCredentials() as { type: string; authError?: string };
    assert.equal(loginPage.type, 'error');
    assert.equal(loginPage.authError, 'session_expired');

    fetchImplementation = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
        text: async () => '<html><h1>Maintenance in progress</h1></html>',
        headers: { get: () => null, raw: () => ({}) },
    });
    const metadataMissing = await api.verifyCredentials() as {
        type: string;
        authError?: string;
    };
    assert.equal(metadataMissing.type, 'error');
    assert.equal(metadataMissing.authError, undefined, 'a metadata-free 200 response is not proof of logout');

    fetchImplementation = async () => fetchResponse;
    api.dispose();

    function createTestSyncEngine(): any {
        return Object.assign(Object.create(SyncEngine.prototype), {
            documentSnapshots: new Map(), pendingLocalCreates: new Set(), joinedDocs: new Set(),
            syncLock: new Set(), pendingWaits: new Map(), fileTree: new Map(), fileTreeByPath: new Map(),
            removedSnapshotEntries: new Map(),
            baseContent: new Map(), fileCache: new Map(), remoteEventQueue: Promise.resolve(),
        });
    }
    let pullLastSyncedUpdates = 0;
    const pullStatuses: Array<{ status: string; authError: boolean }> = [];
    const authenticationFailurePull = createTestSyncEngine() as any;
    authenticationFailurePull.disposed = false;
    authenticationFailurePull.syncLock = new Set();
    authenticationFailurePull.pendingWaits = new Map();
    authenticationFailurePull.project = { name: 'Authentication test' };
    authenticationFailurePull.refreshProjectFileTree = async () => undefined;
    authenticationFailurePull.fileTree = new Map([[
        'document',
        { id: 'document', type: 'doc', name: 'main.tex', path: '/main.tex' },
    ]]);
    authenticationFailurePull.fileTreeByPath = new Map();
    authenticationFailurePull.baseContent = new Map();
    authenticationFailurePull.fileCache = new Map();
    authenticationFailurePull.settings = {
        getSettings: () => ({ projectId: 'project' }),
        updateLastSynced: async () => { pullLastSyncedUpdates++; },
    };
    authenticationFailurePull.shouldSync = () => true;
    let authenticationJoinAttempts = 0;
    authenticationFailurePull.socket = {
        joinDoc: async () => {
            authenticationJoinAttempts++;
            await Promise.resolve();
            throw new Error('Not authenticated');
        },
        leaveDoc: async () => undefined,
    };
    authenticationFailurePull.setStatus = (status: string, _message?: string, _file?: string, authError = false) => {
        pullStatuses.push({ status, authError });
    };
    const firstAuthenticationPull = authenticationFailurePull.pullAll();
    const secondAuthenticationPull = authenticationFailurePull.pullAll();
    await Promise.all([
        assert.rejects(firstAuthenticationPull, /Not authenticated/,
            'a document authentication failure must abort the entire pull'),
        assert.rejects(secondAuthenticationPull, /Not authenticated/,
            'concurrent callers must observe the same failed pull'),
    ]);
    assert.equal(authenticationJoinAttempts, 1,
        'concurrent pull requests must share one remote operation');
    assert.equal(pullLastSyncedUpdates, 0,
        'a failed document pull must never advance lastSynced');
    assert.deepStrictEqual(pullStatuses[pullStatuses.length - 1], { status: 'error', authError: true },
        'a pull authentication failure must visibly expire the session');

    const nonAuthPullStatuses: Array<{ status: string; authError: boolean }> = [];
    const nonAuthenticationFailurePull = createTestSyncEngine() as any;
    nonAuthenticationFailurePull.disposed = false;
    nonAuthenticationFailurePull.syncLock = new Set();
    nonAuthenticationFailurePull.pendingWaits = new Map();
    nonAuthenticationFailurePull.project = { name: 'Transient error test' };
    nonAuthenticationFailurePull.fileTree = new Map([[
        'document',
        { id: 'document', type: 'doc', name: 'authentication-notes.tex', path: '/authentication-notes.tex' },
    ]]);
    nonAuthenticationFailurePull.fileTreeByPath = new Map();
    nonAuthenticationFailurePull.baseContent = new Map();
    nonAuthenticationFailurePull.fileCache = new Map();
    nonAuthenticationFailurePull.refreshProjectFileTree = async () => undefined;
    nonAuthenticationFailurePull.settings = {
        getSettings: () => ({ projectId: 'project' }),
        updateLastSynced: async () => undefined,
    };
    nonAuthenticationFailurePull.shouldSync = () => true;
    nonAuthenticationFailurePull.socket = {
        joinDoc: async () => { throw new Error('Temporary socket failure'); },
        leaveDoc: async () => undefined,
    };
    nonAuthenticationFailurePull.api = {
        getDocContent: async () => ({ type: 'error', message: '500: temporary server error' }),
    };
    nonAuthenticationFailurePull.setStatus = (
        status: string,
        _message?: string,
        _file?: string,
        authError = false,
    ) => {
        nonAuthPullStatuses.push({ status, authError });
    };
    await assert.rejects(
        () => nonAuthenticationFailurePull.pullAll(),
        /authentication-notes\.tex: 500/,
    );
    assert.deepStrictEqual(
        nonAuthPullStatuses[nonAuthPullStatuses.length - 1],
        { status: 'error', authError: false },
        'authentication-like filenames and transient HTTP errors must not expire the session',
    );

    const watchStatuses: Array<{ status: string; authError: boolean }> = [];
    const authenticationFailureWatcher = createTestSyncEngine() as any;
    authenticationFailureWatcher.socket = {
        joinDoc: async () => { throw new Error('Not authenticated'); },
    };
    authenticationFailureWatcher.fileTree = new Map([[
        'document',
        { id: 'document', type: 'doc', name: 'main.tex', path: '/main.tex' },
    ]]);
    authenticationFailureWatcher.joinedDocs = new Set();
    authenticationFailureWatcher.syncLock = new Set();
    authenticationFailureWatcher.pendingWaits = new Map();
    authenticationFailureWatcher.shouldSync = () => true;
    authenticationFailureWatcher.setStatus = (
        status: string,
        _message?: string,
        _file?: string,
        authError = false,
    ) => {
        watchStatuses.push({ status, authError });
    };
    await assert.rejects(
        () => authenticationFailureWatcher.joinAllDocsForWatching(),
        /Not authenticated/,
        'authentication failure while starting document watches must not be ignored',
    );
    assert.deepStrictEqual(watchStatuses[watchStatuses.length - 1], { status: 'error', authError: true });

    const propagation = createTestSyncEngine() as any;
    propagation.fileCache = new Map();
    propagation.baseContent = new Map();
    assert.equal(
        propagation.shouldPropagate('/chapter.tex', Uint8Array.from([1])),
        true
    );
    assert.equal(
        propagation.shouldPropagate('/chapter.tex', Uint8Array.from([1])),
        true,
        'unconfirmed content must remain eligible for retry after a failed upload'
    );
    propagation.recordSynchronizedContent(
        { type: 'doc', path: '/chapter.tex' },
        Uint8Array.from([1]),
    );
    assert.equal(
        propagation.shouldPropagate('/chapter.tex', Uint8Array.from([1])),
        false,
        'confirmed identical content should still be treated as an echo'
    );
    assert.equal(
        propagation.shouldPropagate('/chapter.tex', Uint8Array.from([2])),
        true,
        'unconfirmed content must remain eligible for retry'
    );
    propagation.fileCache.set('/chapter.tex', require('crypto').createHash('sha256').update(Uint8Array.from([2])).digest('hex'));
    assert.equal(propagation.shouldPropagate('/chapter.tex', Uint8Array.from([2])), false,
        'only confirmed identical content is an echo');
    assert.equal(
        propagation.shouldPropagate('/binary.dat', Uint8Array.from([0xff])),
        true,
    );
    assert.equal(
        propagation.shouldPropagate('/binary.dat', Uint8Array.from([0xfe])),
        true,
        'different invalid UTF-8 byte sequences must not collide in the synchronization cache',
    );

    const transactionalTree = createTestSyncEngine() as any;
    const retainedTreeEntry = {
        id: 'retained-doc',
        type: 'doc',
        name: 'retained.tex',
        path: '/retained.tex',
        parentId: 'retained-root',
    };
    transactionalTree.fileTree = new Map([[retainedTreeEntry.id, retainedTreeEntry]]);
    transactionalTree.fileTreeByPath = new Map([[retainedTreeEntry.path, retainedTreeEntry]]);
    const retainedProject = {
        _id: 'retained-project',
        name: 'Retained project',
        rootFolder: [],
        owner: { _id: 'owner', email: 'owner@example.com', first_name: 'Owner' },
        members: [],
    };
    transactionalTree.project = retainedProject;
    transactionalTree.settings = {
        getSettings: () => ({ projectId: 'retained-project' }),
    };
    transactionalTree.api = {
        getProjectDetails: async () => ({
            type: 'success',
            projectData: {
                projectId: 'retained-project',
                rootFolder: [{
                    _id: 'replacement-root',
                    name: 'rootFolder',
                    docs: [
                        { _id: 'replacement-a', name: 'duplicate.tex' },
                        { _id: 'replacement-b', name: 'duplicate.tex' },
                    ],
                    fileRefs: [],
                    folders: [],
                }],
            },
        }),
    };
    await assert.rejects(
        () => transactionalTree.refreshProjectFileTree(),
        /duplicate entity path/,
        'malformed refresh metadata must be rejected',
    );
    assert.strictEqual(transactionalTree.project, retainedProject,
        'a failed refresh must preserve the last valid project metadata');
    assert.deepStrictEqual([...transactionalTree.fileTree.entries()], [[retainedTreeEntry.id, retainedTreeEntry]],
        'a failed refresh must preserve the last valid entity tree');
    assert.deepStrictEqual([...transactionalTree.fileTreeByPath.entries()], [[retainedTreeEntry.path, retainedTreeEntry]],
        'a failed refresh must preserve the last valid path index');
    const binaryBaseline = Uint8Array.from([1, 2, 3, 4]);
    propagation.recordSynchronizedContent(
        { type: 'file', path: '/binary.dat' },
        binaryBaseline,
    );
    assert.equal(propagation.baseContent.get('/binary.dat').byteLength, 0,
        'binary synchronization baselines must not retain complete payloads in memory');
    const documentBaseline = new TextEncoder().encode('document baseline');
    propagation.recordSynchronizedContent(
        { type: 'doc', path: '/chapter.tex' },
        documentBaseline,
    );
    assert.strictEqual(propagation.baseContent.get('/chapter.tex'), documentBaseline,
        'OT documents must retain their exact server baseline');

    const boundedBaselines = createTestSyncEngine() as any;
    boundedBaselines.baseContent = new Map();
    boundedBaselines.baseHashes = new Map();
    boundedBaselines.fileCache = new Map();
    boundedBaselines.retainedDocumentBytes = 0;
    boundedBaselines.maxRetainedDocumentBytes = 7;
    const evictedServerBaseline = new TextEncoder().encode('server');
    const retainedServerBaseline = new TextEncoder().encode('other!');
    boundedBaselines.recordSynchronizedContent(
        { type: 'doc', path: '/evicted.tex' },
        evictedServerBaseline,
    );
    boundedBaselines.recordSynchronizedContent(
        { type: 'doc', path: '/retained.tex' },
        retainedServerBaseline,
    );
    const evictedDocumentMarker = boundedBaselines.baseContent.get('/evicted.tex');
    assert.equal(evictedDocumentMarker.byteLength, 0,
        'the oldest OT baseline must be evicted when the aggregate memory budget is exceeded');
    assert.strictEqual(boundedBaselines.baseContent.get('/retained.tex'), retainedServerBaseline);
    assert.equal(boundedBaselines.retainedDocumentBytes, retainedServerBaseline.byteLength);
    assert.equal(typeof boundedBaselines.baseHashes.get('/evicted.tex'), 'string',
        'evicted content must retain its server hash for safe conflict detection');

    const boundedSuppressions = createTestSyncEngine() as any;
    boundedSuppressions.suppressedRemoteDocumentUpdates = new Map();
    boundedSuppressions.suppressedDocumentUpdateCount = 0;
    boundedSuppressions.maxSuppressedDocumentUpdates = 2;
    const sensitiveUpdate = {
        doc: 'doc',
        v: 1,
        op: [{ p: 0, i: 'sensitive document payload' }],
    };
    const suppressionFingerprint = boundedSuppressions.documentUpdateFingerprint(sensitiveUpdate);
    assert.equal(suppressionFingerprint.length, 64);
    assert.equal(suppressionFingerprint.includes('sensitive'), false,
        'OT echo suppression must retain only a fixed-size digest, not document text');
    boundedSuppressions.suppressRemoteDocumentUpdate(sensitiveUpdate);
    boundedSuppressions.suppressRemoteDocumentUpdate({ ...sensitiveUpdate, v: 2 });
    boundedSuppressions.suppressRemoteDocumentUpdate({ ...sensitiveUpdate, v: 3 });
    assert.equal(boundedSuppressions.suppressedDocumentUpdateCount, 2);
    assert.equal(boundedSuppressions.consumeSuppressedRemoteDocumentUpdate(sensitiveUpdate), false,
        'the oldest suppression must be evicted when the aggregate bound is reached');
    assert.equal(
        boundedSuppressions.consumeSuppressedRemoteDocumentUpdate({ ...sensitiveUpdate, v: 3 }),
        true,
    );
    assert.equal(boundedSuppressions.suppressedDocumentUpdateCount, 1);

    const boundedDiffs = createTestSyncEngine() as any;
    boundedDiffs.remoteDiffContents = new Map();
    boundedDiffs.remoteDiffCharacters = 0;
    boundedDiffs.maxRemoteDiffCharacters = 7;
    const firstDiffUri = mockFileUri('D:\\diff-workspace\\first.tex');
    const secondDiffUri = mockFileUri('D:\\diff-workspace\\second.tex');
    boundedDiffs.setRemoteDiffContent(firstDiffUri, 'first');
    boundedDiffs.setRemoteDiffContent(secondDiffUri, 'other');
    assert.equal(boundedDiffs.remoteDiffContents.has(firstDiffUri.toString()), false,
        'the oldest remote diff must be evicted when the aggregate memory budget is exceeded');
    assert.equal(boundedDiffs.remoteDiffContents.get(secondDiffUri.toString()), 'other');
    assert.equal(boundedDiffs.remoteDiffCharacters, 5);
    boundedDiffs.setRemoteDiffContent(secondDiffUri, 'new');
    assert.equal(boundedDiffs.remoteDiffCharacters, 3,
        'replacing a remote diff must not leak the previous content into the byte budget');
    assert.throws(
        () => boundedDiffs.setRemoteDiffContent(firstDiffUri, 'oversized'),
        /memory limit/,
        'a single remote diff larger than the configured memory budget must be rejected',
    );

    assert.deepEqual(
        propagation.calculateOps('hello world', 'hello brave world'),
        [{ p: 6, i: 'brave ' }],
        'OT updates should insert only the changed range',
    );
    assert.deepEqual(
        propagation.calculateOps('abcXYZdef', 'abc123def'),
        [{ p: 3, d: 'XYZ' }, { p: 3, i: '123' }],
        'OT updates should retain the common prefix and suffix',
    );
    assert.deepEqual(
        propagation.calculateOps('unchanged', 'unchanged'),
        [],
        'unchanged documents should not generate operations',
    );

    const textCreation = createTestSyncEngine() as any;
    textCreation.api = {
        addDoc: async () => ({
            type: 'success',
            doc: { _id: 'created-doc', _type: 'doc', name: 'new.tex' },
        }),
    };
    textCreation.fileTree = new Map();
    textCreation.fileTreeByPath = new Map();
    textCreation.baseContent = new Map();
    textCreation.fileCache = new Map();
    textCreation.pendingLocalCreates = new Set();
    textCreation.socket = {};
    let pushedDocument: { id: string; path: string; content: Uint8Array } | undefined;
    textCreation.pushDocumentChanges = async (
        id: string,
        filePath: string,
        content: Uint8Array
    ) => {
        pushedDocument = { id, path: filePath, content };
        return { content, pushed: true };
    };
    const textContent = new TextEncoder().encode('Thesis content');
    await textCreation.createTextDocumentWithContent(
        'project',
        'folder',
        '/new.tex',
        'new.tex',
        textContent
    );
    assert.equal(textCreation.fileTreeByPath.get('/new.tex').id, 'created-doc');
    assert.deepStrictEqual(pushedDocument, {
        id: 'created-doc',
        path: '/new.tex',
        content: textContent,
    });
    assert.equal(textCreation.pendingLocalCreates.size, 0);
    assert.deepStrictEqual(textCreation.baseContent.get('/new.tex'), textContent,
        'a new document must enter the synchronized baseline only after its content push succeeds');

    const failedTextCreation = createTestSyncEngine() as any;
    failedTextCreation.api = {
        addDoc: async () => ({ type: 'error', message: 'simulated create failure' }),
    };
    failedTextCreation.fileTree = new Map();
    failedTextCreation.fileTreeByPath = new Map();
    failedTextCreation.baseContent = new Map();
    failedTextCreation.pendingLocalCreates = new Set();
    failedTextCreation.socket = {};
    await assert.rejects(
        () => failedTextCreation.createTextDocumentWithContent(
            'project',
            'folder',
            '/failed.tex',
            'failed.tex',
            textContent,
        ),
        /simulated create failure/,
    );
    assert.equal(failedTextCreation.baseContent.has('/failed.tex'), false,
        'failed creates must not leave a false synchronized baseline');
    assert.equal(failedTextCreation.pendingLocalCreates.size, 0,
        'pending-create markers must be released after failures');

    const failedTextPush = createTestSyncEngine() as any;
    failedTextPush.api = {
        addDoc: async () => ({
            type: 'success',
            doc: { _id: 'empty-remote-doc', _type: 'doc', name: 'failed-push.tex' },
        }),
    };
    failedTextPush.fileTree = new Map();
    failedTextPush.fileTreeByPath = new Map();
    failedTextPush.baseContent = new Map();
    failedTextPush.pendingLocalCreates = new Set();
    failedTextPush.socket = {};
    failedTextPush.pushDocumentChanges = async () => {
        throw new Error('simulated content push failure');
    };
    await assert.rejects(
        () => failedTextPush.createTextDocumentWithContent(
            'project',
            'folder',
            '/failed-push.tex',
            'failed-push.tex',
            textContent,
        ),
        /simulated content push failure/,
    );
    assert.equal(failedTextPush.fileTreeByPath.has('/failed-push.tex'), true,
        'a remotely created empty document must remain tracked for a retry');
    assert.equal(failedTextPush.baseContent.has('/failed-push.tex'), false,
        'an empty remote document must not be marked as containing the failed local push');
    assert.equal(failedTextPush.pendingLocalCreates.size, 0);

    const binaryReplacement = createTestSyncEngine() as any;
    binaryReplacement.settings = {
        getSettings: () => ({ projectId: 'project' }),
    };
    const replacementOperations: string[] = [];
    binaryReplacement.api = {
        renameEntity: async (
            _projectId: string,
            _type: string,
            _id: string,
            name: string
        ) => {
            replacementOperations.push(`rename:${name}`);
            return { type: 'success' };
        },
        uploadFile: async (
            _projectId: string,
            _parentId: string,
            name: string
        ) => {
            assert.equal(binaryReplacement.fileTreeByPath.has('/figure.pdf'), false,
                'the original path must be released before its replacement is uploaded');
            const backup = binaryReplacement.fileTree.get('old/binary?id');
            assert.match(backup.path, /^\/figure\.pdf\.localleaf-[0-9a-f]{12}-/);
            replacementOperations.push(`upload:${name}`);
            return {
                type: 'success',
                file: { _id: 'new-binary-id', _type: 'file', name: 'figure.pdf' },
            };
        },
    };
    const oldBinary = {
        id: 'old/binary?id',
        type: 'file',
        name: 'figure.pdf',
        path: '/figure.pdf',
        parentId: 'folder',
    };
    binaryReplacement.fileTree = new Map([[oldBinary.id, oldBinary]]);
    binaryReplacement.fileTreeByPath = new Map([[oldBinary.path, oldBinary]]);
    binaryReplacement.baseContent = new Map();
    binaryReplacement.fileCache = new Map();
    binaryReplacement.suppressedRemoteRenames = new Map();
    binaryReplacement.deleteRemoteEntry = async (entry: { id: string }) => {
        replacementOperations.push(`delete:${entry.id}`);
    };
    binaryReplacement.refreshProjectFileTree = async () => {
        throw new Error('upload response should make a tree refresh unnecessary');
    };
    await binaryReplacement.replaceRemoteFile(
        oldBinary,
        Uint8Array.from([9, 8, 7])
    );
    assert.equal(
        binaryReplacement.fileTreeByPath.get('/figure.pdf').id,
        'new-binary-id'
    );
    assert.equal(replacementOperations[0].startsWith('rename:figure.pdf.localleaf-'), true);
    assert.deepStrictEqual(replacementOperations.slice(1), [
        'upload:figure.pdf',
        'delete:old/binary?id',
    ]);
    assert.doesNotMatch(replacementOperations[0], /[/?]/,
        'opaque remote IDs must be hashed before they are used in a temporary filename');

    const failedReplacement = createTestSyncEngine() as any;
    failedReplacement.settings = {
        getSettings: () => ({ projectId: 'project' }),
    };
    const failedRenameTargets: string[] = [];
    failedReplacement.api = {
        renameEntity: async (
            _projectId: string,
            _type: string,
            _id: string,
            name: string
        ) => {
            failedRenameTargets.push(name);
            return { type: 'success' };
        },
        uploadFile: async () => ({
            type: 'error',
            message: 'simulated upload failure',
        }),
    };
    failedReplacement.fileTree = new Map([[oldBinary.id, oldBinary]]);
    failedReplacement.fileTreeByPath = new Map([[oldBinary.path, oldBinary]]);
    const oldBinaryContent = Uint8Array.from([1, 2, 3]);
    failedReplacement.baseContent = new Map([[oldBinary.path, oldBinaryContent]]);
    failedReplacement.fileCache = new Map();
    failedReplacement.suppressedRemoteRenames = new Map();
    failedReplacement.deleteRemoteEntry = async () => {
        throw new Error('the original must not be deleted after a failed upload');
    };
    await assert.rejects(
        () => failedReplacement.replaceRemoteFile(
            oldBinary,
            Uint8Array.from([9, 8, 7])
        ),
        /simulated upload failure/
    );
    assert.equal(failedRenameTargets.length, 2);
    assert.equal(failedRenameTargets[0].startsWith('figure.pdf.localleaf-'), true);
    assert.equal(failedRenameTargets[1], 'figure.pdf');
    assert.deepStrictEqual(
        failedReplacement.baseContent.get('/figure.pdf'),
        oldBinaryContent
    );
    assert.equal(failedReplacement.fileTreeByPath.get('/figure.pdf').id, oldBinary.id,
        'a failed replacement must restore the original in-memory path');

    const uncertainReplacement = createTestSyncEngine() as any;
    uncertainReplacement.settings = {
        getSettings: () => ({ projectId: 'project' }),
    };
    uncertainReplacement.api = {
        renameEntity: async () => ({ type: 'success' }),
        uploadFile: async () => ({ type: 'success' }),
    };
    uncertainReplacement.fileTree = new Map([[oldBinary.id, { ...oldBinary }]]);
    uncertainReplacement.fileTreeByPath = new Map([
        [oldBinary.path, uncertainReplacement.fileTree.get(oldBinary.id)],
    ]);
    uncertainReplacement.baseContent = new Map([[oldBinary.path, oldBinaryContent]]);
    uncertainReplacement.fileCache = new Map();
    uncertainReplacement.suppressedRemoteRenames = new Map();
    uncertainReplacement.refreshProjectFileTree = async () => undefined;
    let uncertainDeleteCount = 0;
    uncertainReplacement.deleteRemoteEntry = async () => { uncertainDeleteCount++; };
    await assert.rejects(
        () => uncertainReplacement.replaceRemoteFile(
            uncertainReplacement.fileTree.get(oldBinary.id),
            Uint8Array.from([9, 8, 7]),
        ),
        /uploaded file identity could not be verified.*backup was kept/,
        'an untracked successful upload must keep the original rollback copy',
    );
    assert.equal(uncertainDeleteCount, 0,
        'the original backup must not be deleted before the replacement is tracked');
    assert.equal(uncertainReplacement.fileTree.has(oldBinary.id), true);
    assert.equal(uncertainReplacement.fileTreeByPath.has('/figure.pdf'), false);

    const invalidUploadTracker = createTestSyncEngine() as any;
    invalidUploadTracker.fileTree = new Map();
    invalidUploadTracker.fileTreeByPath = new Map();
    assert.throws(
        () => invalidUploadTracker.trackUploadedEntity(
            { file: { _id: 'wrong-type', _type: 'folder', name: 'figure.pdf' } },
            'folder',
            'figure.pdf',
            '/figure.pdf',
        ),
        /invalid uploaded entity type/,
        'file upload tracking must reject impossible server entity types',
    );
    invalidUploadTracker.fileTreeByPath.set('/occupied.pdf', {
        id: 'occupied', type: 'file', name: 'occupied.pdf', path: '/occupied.pdf', parentId: 'folder',
    });
    assert.throws(
        () => invalidUploadTracker.trackUploadedEntity(
            { file: { _id: 'different', _type: 'file', name: 'occupied.pdf' } },
            'folder',
            'occupied.pdf',
            '/occupied.pdf',
        ),
        /duplicate uploaded entity path/,
        'upload responses must not overwrite a concurrently tracked entity',
    );

    const untrackedUpload = createTestSyncEngine() as any;
    untrackedUpload.fileTree = new Map();
    untrackedUpload.fileTreeByPath = new Map();
    untrackedUpload.refreshProjectFileTree = async () => undefined;
    await assert.rejects(
        () => untrackedUpload.resolveUploadedFile(
            {},
            'folder',
            'untracked.pdf',
            '/untracked.pdf',
        ),
        /uploaded file identity could not be verified/,
        'an empty upload response and unavailable HTTP tree must not create a false baseline',
    );

    const folderRebase = createTestSyncEngine() as any;
    const folderEntry = { id: 'folder', type: 'folder', name: 'old', path: '/old/' };
    const childEntry = { id: 'child', type: 'doc', name: 'child.tex', path: '/old/child.tex' };
    const nestedEntry = { id: 'nested', type: 'file', name: 'image.png', path: '/old/assets/image.png' };
    folderRebase.fileTree = new Map([
        [folderEntry.id, folderEntry],
        [childEntry.id, childEntry],
        [nestedEntry.id, nestedEntry],
    ]);
    folderRebase.fileTreeByPath = new Map([
        [folderEntry.path, folderEntry],
        [childEntry.path, childEntry],
        [nestedEntry.path, nestedEntry],
    ]);
    folderRebase.baseContent = new Map([[childEntry.path, Uint8Array.from([1])]]);
    folderRebase.fileCache = new Map([[nestedEntry.path, 'hash']]);
    folderRebase.rebaseFileTree('/old/', '/renamed/');
    assert.equal(childEntry.path, '/renamed/child.tex');
    assert.equal(nestedEntry.path, '/renamed/assets/image.png');
    assert.ok(folderRebase.fileTreeByPath.has('/renamed/child.tex'));
    assert.ok(folderRebase.baseContent.has('/renamed/child.tex'));
    assert.ok(folderRebase.fileCache.has('/renamed/assets/image.png'));
    assert.equal(folderRebase.fileTreeByPath.has('/old/child.tex'), false);

    const collidingTransition = createTestSyncEngine() as any;
    const movingFolder = { id: 'moving-folder', type: 'folder', path: '/moving/' };
    const movingChild = { id: 'moving-child', type: 'doc', path: '/moving/child.tex' };
    const occupiedChild = { id: 'occupied-child', type: 'doc', path: '/renamed/child.tex' };
    collidingTransition.fileTree = new Map([
        [movingFolder.id, movingFolder],
        [movingChild.id, movingChild],
        [occupiedChild.id, occupiedChild],
    ]);
    collidingTransition.fileTreeByPath = new Map([
        [movingFolder.path, movingFolder],
        [movingChild.path, movingChild],
        [occupiedChild.path, occupiedChild],
    ]);
    assert.throws(
        () => collidingTransition.assertRemotePathTransitionAvailable('/moving/', '/renamed/'),
        /already belongs to another entity/,
        'remote folder changes must validate every descendant destination',
    );
    assert.throws(
        () => collidingTransition.assertRemotePathTransitionAvailable('/moving/', '/moving/nested/'),
        /own subtree/,
        'a remote event must not move a folder below itself',
    );
    assert.doesNotThrow(
        () => collidingTransition.assertRemotePathTransitionAvailable('/moving/', '/available/'),
    );

    const subtreeRemoval = createTestSyncEngine() as any;
    const subtreeFolder = { id: 'folder', type: 'folder', name: 'folder', path: '/folder/' };
    const subtreeChild = { id: 'child', type: 'doc', name: 'child.tex', path: '/folder/child.tex' };
    subtreeRemoval.fileTree = new Map([['folder', subtreeFolder], ['child', subtreeChild]]);
    subtreeRemoval.fileTreeByPath = new Map([
        ['/folder/', subtreeFolder],
        ['/folder/child.tex', subtreeChild],
    ]);
    subtreeRemoval.baseContent = new Map([
        ['/folder/', new Uint8Array()],
        ['/folder/child.tex', Uint8Array.from([1])],
    ]);
    subtreeRemoval.fileCache = new Map([['/folder/child.tex', 'hash']]);
    subtreeRemoval.joinedDocs = new Set(['child']);
    subtreeRemoval.documentSnapshots = new Map();
    subtreeRemoval.removeTrackedSubtree('/folder/');
    assert.equal(subtreeRemoval.fileTree.size, 0, 'folder removal must clear every descendant identity');
    assert.equal(subtreeRemoval.fileTreeByPath.size, 0);
    assert.equal(subtreeRemoval.baseContent.size, 0);
    assert.equal(subtreeRemoval.fileCache.size, 0);
    assert.equal(subtreeRemoval.joinedDocs.size, 0);

    const safeFolderWorkspace = mockFileUri('D:\\safe-folder-delete');
    resetMockWorkspace([safeFolderWorkspace], [
        ['D:\\safe-folder-delete', { type: 2 }],
        ['D:\\safe-folder-delete\\folder', { type: 2 }],
        ['D:\\safe-folder-delete\\folder\\tracked.tex', { type: 1, content: 'tracked' }],
        ['D:\\safe-folder-delete\\folder\\local-notes.txt', { type: 1, content: 'local' }],
        ['D:\\safe-folder-delete\\folder\\nested', { type: 2 }],
        ['D:\\safe-folder-delete\\folder\\nested\\tracked.tex', { type: 1, content: 'nested' }],
    ]);
    const safeFolderDelete = createTestSyncEngine() as any;
    safeFolderDelete.disposed = false;
    safeFolderDelete.fileTree = new Map([
        ['folder', { id: 'folder', type: 'folder', path: '/folder/' }],
        ['tracked', { id: 'tracked', type: 'doc', path: '/folder/tracked.tex' }],
        ['nested', { id: 'nested', type: 'folder', path: '/folder/nested/' }],
        ['nested-tracked', { id: 'nested-tracked', type: 'doc', path: '/folder/nested/tracked.tex' }],
    ]);
    safeFolderDelete.settings = {
        getFilePath: (projectPath: string) => mockFileUri(
            `D:\\safe-folder-delete${projectPath.replace(/\/$/, '').replace(/\//g, '\\')}`
        ),
    };
    safeFolderDelete.baseContent = new Map([['/folder/tracked.tex', Buffer.from('tracked')], ['/folder/nested/tracked.tex', Buffer.from('nested')]]);
    safeFolderDelete.shouldSync = () => true;
    safeFolderDelete.assertNoSymbolicLinks = async () => undefined;
    const safeFolderOutcome = await safeFolderDelete.deleteTrackedLocalEntry(
        safeFolderDelete.fileTree.get('folder')
    );
    assert.equal(safeFolderOutcome, 'preserved');
    assert.equal(mockFileEntries.has(path.win32.normalize(
        'D:\\safe-folder-delete\\folder\\local-notes.txt'
    )), true, 'remote folder deletion must preserve local-only content');
    assert.equal(mockFileEntries.has(path.win32.normalize(
        'D:\\safe-folder-delete\\folder\\tracked.tex'
    )), false, 'remote folder deletion must still remove synchronized files');
    assert.equal(mockFileEntries.has(path.win32.normalize(
        'D:\\safe-folder-delete\\folder\\nested\\tracked.tex'
    )), false);
    assert.ok(mockFileDeletes.every(deletion => deletion.recursive === false),
        'remote folder deletion must never issue a recursive local delete');

    const acknowledgement = createTestSyncEngine() as any;
    acknowledgement.fileTree = new Map([
        ['root', { id: 'root', type: 'folder', path: '/' }],
    ]);
    acknowledgement.fileTreeByPath = new Map();
    acknowledgement.shouldSync = () => true;
    acknowledgement.acquireLockWhenAvailable = async () => false;
    await acknowledgement.handleRemoteFileCreated(
        'root',
        'file',
        { _id: 'socket-id-1', name: 'photo.jpg' }
    );
    assert.equal(acknowledgement.fileTreeByPath.get('/photo.jpg').id, 'socket-id-1');

    const localCreate = createTestSyncEngine() as any;
    localCreate.disposed = false;
    localCreate.getRelativePath = () => '/new.tex';
    localCreate.shouldSync = () => true;
    let waitedForLock = false;
    localCreate.acquireLockWhenAvailable = async () => {
        waitedForLock = true;
        return false;
    };
    await localCreate.handleLocalFileCreate({});
    assert.equal(waitedForLock, true, 'locked local create events must wait instead of being discarded');

    const orderedRemoteEvents = createTestSyncEngine() as any;
    orderedRemoteEvents.disposed = false;
    orderedRemoteEvents.remoteEventQueue = Promise.resolve();
    const eventOrder: string[] = [];
    let releaseFirstEvent: (() => void) | undefined;
    orderedRemoteEvents.enqueueRemoteEvent(async () => {
        eventOrder.push('first-start');
        await new Promise<void>(resolve => { releaseFirstEvent = resolve; });
        eventOrder.push('first-end');
    });
    orderedRemoteEvents.enqueueRemoteEvent(async () => { eventOrder.push('second'); });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(eventOrder, ['first-start']);
    releaseFirstEvent?.();
    await orderedRemoteEvents.remoteEventQueue;
    assert.deepStrictEqual(eventOrder, ['first-start', 'first-end', 'second']);

    const ownDocumentEcho = createTestSyncEngine() as any;
    ownDocumentEcho.socket = { publicId: 'this-client' };
    ownDocumentEcho.suppressedRemoteDocumentUpdates = new Map();
    ownDocumentEcho.fileTree = new Map();
    await ownDocumentEcho.handleRemoteFileChanged({
        doc: 'doc',
        v: 1,
        op: [{ p: 0, i: 'content' }],
        meta: { source: 'this-client', ts: Date.now(), user_id: 'user' },
    });

    const remoteOt = createTestSyncEngine() as any;
    const remoteOtUri = mockFileUri('D:\\ot-workspace\\chapter.tex');
    resetMockWorkspace([mockFileUri('D:\\ot-workspace')], [
        ['D:\\ot-workspace', { type: 2 }],
        ['D:\\ot-workspace\\chapter.tex', { type: 1, content: 'local edit' }],
    ]);
    remoteOt.disposed = false;
    remoteOt.socket = { publicId: 'this-client' };
    remoteOt.suppressedRemoteDocumentUpdates = new Map();
    remoteOt.fileTree = new Map([[
        'doc',
        { id: 'doc', type: 'doc', name: 'chapter.tex', path: '/chapter.tex' },
    ]]);
    remoteOt.baseContent = new Map([[
        '/chapter.tex',
        new TextEncoder().encode('server'),
    ]]);
    remoteOt.fileCache = new Map();
    remoteOt.documentSnapshots = new Map([['doc', { content: new TextEncoder().encode('server'), version: 2 }]]);
    remoteOt.settings = {
        getFilePath: () => remoteOtUri,
        getSettings: () => ({ projectId: 'project' }),
    };
    remoteOt.api = {};
    remoteOt.shouldSync = () => true;
    remoteOt.acquireLockWhenAvailable = async () => true;
    remoteOt.releaseLock = () => undefined;
    remoteOt.assertNoSymbolicLinks = async () => undefined;
    remoteOt.askConflictResolution = async () => 'skip';
    remoteOt.setStatus = () => undefined;
    await remoteOt.handleRemoteFileChanged({
        doc: 'doc',
        v: 2,
        op: [{ p: 6, i: '!' }],
        meta: { source: 'other-client', ts: Date.now(), user_id: 'other' },
    });
    assert.equal(
        new TextDecoder().decode(remoteOt.documentSnapshots.get('doc').content),
        'server!',
        'remote operations must be applied to the known server base, not an unsaved local edit',
    );
    assert.equal(new TextDecoder().decode(remoteOt.baseContent.get('/chapter.tex')), 'server',
        'skipping a remote update must retain the common baseline for the next automatic save');

    const evictedOtUri = mockFileUri('D:\\evicted-ot-workspace\\chapter.tex');
    resetMockWorkspace([mockFileUri('D:\\evicted-ot-workspace')], [
        ['D:\\evicted-ot-workspace', { type: 2 }],
        ['D:\\evicted-ot-workspace\\chapter.tex', { type: 1, content: 'server' }],
    ]);
    const evictedOt = createTestSyncEngine() as any;
    evictedOt.disposed = false;
    evictedOt.socket = { publicId: 'this-client' };
    evictedOt.suppressedRemoteDocumentUpdates = new Map();
    evictedOt.fileTree = new Map([[
        'doc',
        { id: 'doc', type: 'doc', name: 'chapter.tex', path: '/chapter.tex' },
    ]]);
    evictedOt.baseContent = new Map([['/chapter.tex', evictedDocumentMarker]]);
    evictedOt.baseHashes = new Map([[
        '/chapter.tex',
        boundedBaselines.baseHashes.get('/evicted.tex'),
    ]]);
    evictedOt.fileCache = new Map();
    evictedOt.settings = {
        getFilePath: () => evictedOtUri,
        getWorkspaceFolder: () => mockFileUri('D:\\evicted-ot-workspace'),
        getSettings: () => ({ projectId: 'project' }),
    };
    let evictedRecoveryRequests = 0;
    evictedOt.api = {
        getDocContent: async () => {
            evictedRecoveryRequests++;
            return { type: 'success', lines: ['server!'] };
        },
    };
    evictedOt.shouldSync = () => true;
    evictedOt.acquireLockWhenAvailable = async () => true;
    evictedOt.releaseLock = () => undefined;
    evictedOt.assertNoSymbolicLinks = async () => undefined;
    evictedOt.askConflictResolution = async () => {
        throw new Error('an unchanged local baseline must not create a false conflict');
    };
    evictedOt.setStatus = () => undefined;
    await evictedOt.handleRemoteFileChanged({
        doc: 'doc',
        v: 2,
        op: [{ p: 6, i: '!' }],
        meta: { source: 'other-client', ts: Date.now(), user_id: 'other' },
    });
    assert.equal(evictedRecoveryRequests, 1,
        'an OT update with an evicted baseline must recover authoritative document content');
    assert.equal(new TextDecoder().decode(mockFileWrites.at(-1)?.content), 'server!');
    assert.equal(new TextDecoder().decode(evictedOt.baseContent.get('/chapter.tex')), 'server!');

    const createDirtyRemoteOt = (
        resolveConflict: (document: MockTextDocument) => Promise<'useRemote' | 'useLocal' | 'skip'>,
    ) => {
        const uri = mockFileUri('D:\\dirty-ot-workspace\\chapter.tex');
        resetMockWorkspace([mockFileUri('D:\\dirty-ot-workspace')], [
            ['D:\\dirty-ot-workspace', { type: 2 }],
            ['D:\\dirty-ot-workspace\\chapter.tex', { type: 1, content: 'server' }],
        ]);
        const document = createMockTextDocument(uri, 'local edit');
        mockTextDocuments = [document];

        const engine = createTestSyncEngine() as any;
        engine.disposed = false;
        engine.socket = { publicId: 'this-client' };
        engine.suppressedRemoteDocumentUpdates = new Map();
        engine.fileTree = new Map([[
            'doc',
            { id: 'doc', type: 'doc', name: 'chapter.tex', path: '/chapter.tex' },
        ]]);
        engine.baseContent = new Map([[
            '/chapter.tex',
            new TextEncoder().encode('server'),
        ]]);
        engine.fileCache = new Map();
        engine.settings = {
            getFilePath: () => uri,
            getSettings: () => ({ projectId: 'project' }),
            getWorkspaceFolder: () => mockFileUri('D:\\dirty-ot-workspace'),
        };
        engine.documentSnapshots.set('doc', {content: Buffer.from('server'), version: 2});
        engine.api = {};
        engine.shouldSync = () => true;
        engine.acquireLockWhenAvailable = async () => true;
        engine.releaseLock = () => undefined;
        engine.assertNoSymbolicLinks = async () => undefined;
        engine.askConflictResolution = async () => resolveConflict(document);
        engine.setStatus = () => undefined;

        return { engine, document };
    };
    const remoteEdit = {
        doc: 'doc',
        v: 2,
        op: [{ p: 6, i: '!' }],
        meta: { source: 'other-client', ts: Date.now(), user_id: 'other' },
    };

    const dirtyMerge = createDirtyRemoteOt(async () => { throw new Error('Independent editor edits must merge'); });
    const dirtyBase = 'first\nunchanged\nlast\n';
    dirtyMerge.document.applyText('FIRST\nunchanged\nlast\n');
    dirtyMerge.engine.baseContent.set('/chapter.tex', Buffer.from(dirtyBase));
    dirtyMerge.engine.documentSnapshots.set('doc', { content: Buffer.from(dirtyBase), version: 2 });
    await dirtyMerge.engine.handleRemoteFileChanged({ ...remoteEdit,
        op: [{ p: dirtyBase.indexOf('last'), d: 'last' }, { p: dirtyBase.indexOf('last'), i: 'LAST' }] });
    assert.equal(dirtyMerge.document.getText(), 'FIRST\nunchanged\nLAST\n');
    assert.equal(dirtyMerge.document.isDirty, true, 'automatic merging must not save the editor');
    assert.equal(mockFileWrites.length, 0, 'automatic merging of a dirty buffer must not write or upload the draft');
    assert.equal(mockAppliedWorkspaceEdits.length, 1, 'editor merges must remain undoable');
    assert.equal(Buffer.from(dirtyMerge.engine.baseContent.get('/chapter.tex')).toString(), dirtyBase,
        'an unsaved merged buffer is not a newly synchronized ancestor');

    let conflictPrompts = 0;
    const skippedDirtyRemote = createDirtyRemoteOt(async () => {
        conflictPrompts++;
        return 'skip';
    });
    await skippedDirtyRemote.engine.handleRemoteFileChanged(remoteEdit);
    assert.equal(conflictPrompts, 1, 'a dirty editor must be treated as local content, not as its stale disk file');
    assert.equal(skippedDirtyRemote.document.getText(), 'local edit');
    assert.equal(mockAppliedWorkspaceEdits.length, 0);
    assert.equal(mockFileWrites.length, 0, 'skipping a dirty conflict must not overwrite the editor or disk');
    assert.equal(
        new TextDecoder().decode(skippedDirtyRemote.engine.baseContent.get('/chapter.tex')),
        'server',
        'the common baseline must remain unchanged while dirty local edits are retained',
    );
    assert.equal(
        skippedDirtyRemote.engine.shouldPropagate('/chapter.tex', new TextEncoder().encode('server')),
        true,
        'skipping a conflict must not mark an unconfirmed disk revision as synchronized',
    );
    assert.equal(
        skippedDirtyRemote.engine.shouldPropagate('/chapter.tex', new TextEncoder().encode('local edit')),
        true,
        'saving retained dirty edits must still trigger a push',
    );

    const keptDirtyRemote = createDirtyRemoteOt(async () => 'useLocal');
    let pushedDirtyContent: string | undefined;
    keptDirtyRemote.engine.pushDocumentChanges = async (
        _docId: string,
        _path: string,
        content: Uint8Array,
    ) => {
        pushedDirtyContent = new TextDecoder().decode(content);
        return { content, pushed: true };
    };
    await keptDirtyRemote.engine.handleRemoteFileChanged(remoteEdit);
    assert.equal(pushedDirtyContent, 'local edit', 'Keep Local must push the in-memory editor, not stale disk');
    assert.equal(mockAppliedWorkspaceEdits.length, 0);
    assert.equal(mockFileWrites.length, 0);

    const acceptedDirtyRemote = createDirtyRemoteOt(async () => 'useRemote');
    await acceptedDirtyRemote.engine.handleRemoteFileChanged(remoteEdit);
    assert.equal(mockAppliedWorkspaceEdits.length, 1, 'Use Remote must be one reversible workspace edit');
    assert.deepStrictEqual(mockAppliedWorkspaceEdits[0].replacements.map(edit => edit.text), ['server!']);
    assert.equal(acceptedDirtyRemote.document.getText(), 'server!');
    assert.equal(mockFileWrites.length, 0, 'a dirty editor must not be replaced behind VS Code through the filesystem');

    const changedDuringPrompt = createDirtyRemoteOt(async document => {
        document.applyText('newer typing');
        return 'useRemote';
    });
    await changedDuringPrompt.engine.handleRemoteFileChanged(remoteEdit);
    assert.equal(changedDuringPrompt.document.getText(), 'newer typing');
    assert.equal(mockAppliedWorkspaceEdits.length, 0,
        'typing that occurs while the conflict prompt is open must never be overwritten');
    assert.equal(mockFileWrites.length, 0);

    const createDirtyFullPull = (
        resolveConflict: (document: MockTextDocument) => Promise<'useRemote' | 'useLocal' | 'skip'>,
    ) => {
        const workspaceUri = mockFileUri('D:\\dirty-pull-workspace');
        const uri = mockFileUri('D:\\dirty-pull-workspace\\chapter.tex');
        resetMockWorkspace([workspaceUri], [
            ['D:\\dirty-pull-workspace', { type: 2 }],
            ['D:\\dirty-pull-workspace\\chapter.tex', { type: 1, content: 'server' }],
        ]);
        const document = createMockTextDocument(uri, 'local edit');
        mockTextDocuments = [document];
        const entry = { id: 'doc', type: 'doc', name: 'chapter.tex', path: '/chapter.tex' };

        const engine = createTestSyncEngine() as any;
        engine.disposed = false;
        engine.project = { name: 'Test project', rootFolder: [] };
        engine.refreshProjectFileTree = async () => undefined;
        engine.socket = {
            joinDoc: async () => ({ lines: ['server!'], version: 2 }),
            leaveDoc: async () => undefined,
        };
        engine.fileTree = new Map([[entry.id, entry]]);
        engine.fileTreeByPath = new Map([[entry.path, entry]]);
        engine.joinedDocs = new Set();
        engine.baseContent = new Map([[entry.path, new TextEncoder().encode('server')]]);
        engine.fileCache = new Map();
        engine.settings = {
            getFilePath: () => uri,
            getSettings: () => ({ projectId: 'project' }),
            getWorkspaceFolder: () => workspaceUri,
            updateLastSynced: async () => undefined,
        };
        engine.shouldSync = () => true;
        engine.assertNoSymbolicLinks = async () => undefined;
        engine.askConflictResolution = async () => resolveConflict(document);
        engine.setStatus = () => undefined;
        engine.logFn = () => undefined;

        return { engine, document };
    };

    const acceptedDirtyPull = createDirtyFullPull(async () => 'useRemote');
    await acceptedDirtyPull.engine.pullAll();
    assert.equal(acceptedDirtyPull.document.getText(), 'server!');
    assert.equal(mockAppliedWorkspaceEdits.length, 1,
        'a full pull must apply accepted remote text to a dirty editor through one workspace edit');
    assert.equal(mockFileWrites.length, 0,
        'a full pull must not write behind a dirty editor through the filesystem');

    const keptDirtyPull = createDirtyFullPull(async () => 'useLocal');
    let fullPullPushedContent: string | undefined;
    keptDirtyPull.engine.pushDocumentChanges = async (
        _docId: string,
        _path: string,
        content: Uint8Array,
    ) => {
        fullPullPushedContent = new TextDecoder().decode(content);
        return { content, pushed: true };
    };
    await keptDirtyPull.engine.pullAll();
    assert.equal(fullPullPushedContent, 'local edit',
        'Keep Local during a full pull must use the unsaved editor buffer');
    assert.equal(mockAppliedWorkspaceEdits.length, 0);
    assert.equal(mockFileWrites.length, 0);

    const changedDuringFullPullPrompt = createDirtyFullPull(async document => {
        document.applyText('newer typing');
        return 'useRemote';
    });
    await changedDuringFullPullPrompt.engine.pullAll();
    assert.equal(changedDuringFullPullPrompt.document.getText(), 'newer typing');
    assert.equal(mockAppliedWorkspaceEdits.length, 0,
        'a full pull must preserve typing performed while its conflict prompt is open');
    assert.equal(mockFileWrites.length, 0);
    assert.equal(
        new TextDecoder().decode(changedDuringFullPullPrompt.engine.baseContent.get('/chapter.tex')),
        'server',
        'the common baseline must remain unchanged when a full pull preserves newer editor text',
    );

    const structuralWorkspace = mockFileUri('D:\\structural-workspace');
    const structuralSource = mockFileUri('D:\\structural-workspace\\draft.tex');
    const structuralTarget = mockFileUri('D:\\structural-workspace\\renamed.tex');
    const structuralSettings = {
        getRelativePath: (uri: MockUri): string | undefined => {
            const relative = path.win32.relative(structuralWorkspace.fsPath, uri.fsPath);
            if (relative.startsWith('..') || path.win32.isAbsolute(relative)) return undefined;
            return relative.length === 0 ? '/' : `/${relative.replace(/\\/g, '/')}`;
        },
        getFilePath: () => structuralSource,
        getSettings: () => ({ projectId: 'project' }),
    };
    resetMockWorkspace([structuralWorkspace], [
        [structuralWorkspace.fsPath, { type: 2 }],
        [structuralSource.fsPath, { type: 1, content: 'saved text' }],
    ]);
    const dirtyStructuralDocument = createMockTextDocument(structuralSource, 'unsaved text');
    mockTextDocuments = [dirtyStructuralDocument];
    const structuralEngine = createTestSyncEngine() as any;
    structuralEngine.settings = structuralSettings;
    assert.equal(
        await structuralEngine.deleteLocalPath('/draft.tex', structuralSource, false),
        'preserved',
        'a remote deletion must never remove a dirty editor from disk',
    );
    assert.equal(mockAppliedWorkspaceEdits.length, 0);
    assert.equal(mockFileDeletes.length, 0);

    dirtyStructuralDocument.isDirty = false;
    assert.equal(
        await structuralEngine.deleteLocalPath('/draft.tex', structuralSource, false),
        'deleted',
    );
    assert.equal(mockAppliedWorkspaceEdits.length, 1,
        'deleting an open clean file must go through an undoable WorkspaceEdit');
    assert.equal(mockAppliedWorkspaceEdits[0].deletions.length, 1);
    assert.equal(mockFileDeletes.length, 0,
        'an open editor must not be deleted behind VS Code through the raw filesystem API');

    resetMockWorkspace([structuralWorkspace], [
        [structuralWorkspace.fsPath, { type: 2 }],
        [structuralSource.fsPath, { type: 1, content: 'saved text' }],
    ]);
    const renamedDirtyDocument = createMockTextDocument(structuralSource, 'unsaved text');
    mockTextDocuments = [renamedDirtyDocument];
    await structuralEngine.renameLocalPath('/draft.tex', structuralSource, structuralTarget);
    assert.equal(mockAppliedWorkspaceEdits.length, 1,
        'renaming an open file must go through a WorkspaceEdit');
    assert.equal(mockAppliedWorkspaceEdits[0].renames.length, 1);
    assert.equal(mockFileRenames.length, 0);
    assert.equal(renamedDirtyDocument.uri.toString(), structuralTarget.toString());
    assert.equal(renamedDirtyDocument.getText(), 'unsaved text');
    assert.equal(renamedDirtyDocument.isDirty, true,
        'a remote rename must preserve the unsaved editor buffer');

    resetMockWorkspace([structuralWorkspace], [
        [structuralWorkspace.fsPath, { type: 2 }],
        [structuralSource.fsPath, { type: 1, content: 'saved text' }],
    ]);
    const reuploadedDirtyDocument = createMockTextDocument(structuralSource, 'unsaved text');
    mockTextDocuments = [reuploadedDirtyDocument];
    const reuploadEngine = createTestSyncEngine() as any;
    reuploadEngine.disposed = false;
    reuploadEngine.settings = structuralSettings;
    reuploadEngine.baseContent = new Map();
    reuploadEngine.fileCache = new Map();
    reuploadEngine.assertNoSymbolicLinks = async () => undefined;
    reuploadEngine.ensureParentFoldersExist = async () => 'root';
    reuploadEngine.setStatus = () => undefined;
    let reuploadedContent: string | undefined;
    reuploadEngine.createTextDocumentWithContent = async (
        _projectId: string,
        _parentId: string,
        _relativePath: string,
        _name: string,
        content: Uint8Array,
    ) => {
        reuploadedContent = new TextDecoder().decode(content);
    };
    await reuploadEngine.uploadLocalFile('/draft.tex');
    assert.equal(reuploadedContent, 'unsaved text',
        're-uploading a dirty text file must use its editor buffer rather than stale disk content');

    const remoteEntry = { id: 'remote-doc', type: 'doc', name: 'remote.tex', path: '/remote.tex' };
    const remoteDownload = createTestSyncEngine() as any;
    remoteDownload.settings = { getSettings: () => ({ projectId: 'project' }) };
    remoteDownload.joinedDocs = new Set([remoteEntry.id]);
    let socketLeaves = 0;
    remoteDownload.socket = {
        joinDoc: async () => ({ lines: ['live content'], version: 3 }),
        leaveDoc: async () => { socketLeaves++; },
    };
    remoteDownload.api = {
        getDocContent: async () => ({ type: 'error', message: 'HTTP should not be used' }),
    };
    assert.equal(
        new TextDecoder().decode(await remoteDownload.getRemoteEntryContent(remoteEntry)),
        'live content',
    );
    assert.equal(socketLeaves, 0,
        'a manual pull must not leave a document that was already joined for live updates');

    remoteDownload.joinedDocs.clear();
    assert.equal(
        new TextDecoder().decode(await remoteDownload.getRemoteEntryContent(remoteEntry)),
        'live content',
    );
    assert.equal(socketLeaves, 0, 'a Socket.IO snapshot must retain its live document subscription');
    assert.equal(remoteDownload.joinedDocs.has(remoteEntry.id), true);

    let httpFallbacks = 0;
    remoteDownload.socket.joinDoc = async () => { throw new Error('join unavailable'); };
    remoteDownload.api.getDocContent = async () => {
        httpFallbacks++;
        return { type: 'success', lines: ['HTTP fallback'] };
    };
    assert.equal(
        new TextDecoder().decode(await remoteDownload.getRemoteEntryContent(remoteEntry)),
        'HTTP fallback',
        'a failed Socket.IO document read must genuinely fall back to HTTP',
    );
    assert.equal(httpFallbacks, 1);
    assert.equal(socketLeaves, 0, 'a failed refresh must not unsubscribe a previously watched document');

    remoteDownload.api.getDocContent = async () => ({ type: 'error', message: 'HTTP unavailable' });
    await assert.rejects(
        () => remoteDownload.getRemoteEntryContent(remoteEntry),
        /failed via Socket\.IO.*and HTTP/,
        'a pull must fail visibly when neither transport can download a document',
    );

    const watchFailure = createTestSyncEngine() as any;
    watchFailure.socket = { joinDoc: async () => { throw new Error('watch unavailable'); } };
    watchFailure.fileTree = new Map([[remoteEntry.id, remoteEntry]]);
    watchFailure.joinedDocs = new Set();
    watchFailure.shouldSync = () => true;
    watchFailure.log = () => undefined;
    let watchFailureStatus: string | undefined;
    watchFailure.setStatus = (status: string) => { watchFailureStatus = status; };
    await assert.rejects(
        () => watchFailure.joinAllDocsForWatching(),
        /Unable to watch 1 document/,
        'a live-watch failure must not be silently reported as a successful sync',
    );
    assert.equal(watchFailureStatus, 'error');

    const floodedRemoteQueue = createTestSyncEngine() as any;
    floodedRemoteQueue.pendingRemoteEventCount = 10_000;
    floodedRemoteQueue.pendingRemoteEventCost = 0;
    floodedRemoteQueue.log = () => undefined;
    let floodedQueueStatus: string | undefined;
    floodedRemoteQueue.setStatus = (status: string) => { floodedQueueStatus = status; };
    let floodedSocketDisconnected = false;
    floodedRemoteQueue.socket = { resetConnection: () => { floodedSocketDisconnected = true; } };
    floodedRemoteQueue.enqueueRemoteEvent(async () => undefined);
    assert.equal(floodedQueueStatus, 'error');
    assert.equal(floodedSocketDisconnected, true,
        'a server must not be able to grow the pending remote-event queue without a bound');

    floodedQueueStatus = undefined;
    floodedSocketDisconnected = false;
    floodedRemoteQueue.pendingRemoteEventCount = 0;
    floodedRemoteQueue.pendingRemoteEventCost = 20 * 1024 * 1024;
    floodedRemoteQueue.enqueueRemoteEvent(async () => undefined, 1);
    assert.equal(floodedQueueStatus, 'error');
    assert.equal(floodedSocketDisconnected, true,
        'large queued OT payloads must be bounded independently from event count');

    const automaticSync = createTestSyncEngine() as any;
    const automaticSyncWorkspace = mockFileUri('D:\\automatic-sync-workspace');
    automaticSync.settings = {
        getSettings: () => ({ autoSync: true }),
        getWorkspaceFolder: () => automaticSyncWorkspace,
    };
    assert.equal(automaticSync.automaticSyncEnabled, true);
    mockAutomaticSyncSetting = false;
    assert.equal(automaticSync.automaticSyncEnabled, false,
        'the VS Code autoSync setting must actually disable automatic local uploads');
    mockAutomaticSyncSetting = true;
    automaticSync.settings.getSettings = () => ({ autoSync: false });
    assert.equal(automaticSync.automaticSyncEnabled, false,
        'the linked-project autoSync setting must actually disable automatic local uploads');

    const scanWorkspace = mockFileUri('D:\\scan-workspace');
    resetMockWorkspace([scanWorkspace], [
        [scanWorkspace.fsPath, { type: 2 }],
        ['D:\\scan-workspace\\known.tex', { type: 1, content: 'known' }],
        ['D:\\scan-workspace\\new.tex', { type: 1, content: 'new' }],
        ['D:\\scan-workspace\\nested', { type: 2 }],
        ['D:\\scan-workspace\\nested\\other.tex', { type: 1, content: 'other' }],
        ['D:\\scan-workspace\\outside-link', { type: 2 | 64 }],
    ]);
    const boundedLocalScan = createTestSyncEngine() as any;
    boundedLocalScan.settings = { getWorkspaceFolder: () => scanWorkspace };
    boundedLocalScan.assertNoSymbolicLinks = async () => undefined;
    boundedLocalScan.shouldSync = () => true;
    boundedLocalScan.log = () => undefined;
    boundedLocalScan.fileTreeByPath = new Map([['/known.tex', {}]]);
    boundedLocalScan.baseContent = new Map();
    assert.deepStrictEqual(
        await boundedLocalScan.findLocalOnlyFiles(),
        ['/new.tex', '/nested/other.tex'],
        'local discovery must stay inside ordinary non-symlink directories',
    );
    await assert.rejects(
        () => boundedLocalScan.findLocalOnlyFiles(1, 256),
        /too many files or directories/,
        'the local project scan must have a hard entity bound',
    );
    await assert.rejects(
        () => boundedLocalScan.findLocalOnlyFiles(100, 0),
        /excessively deep directory tree/,
        'the local project scan must have a hard recursion bound',
    );

    const oversizedLocalWorkspace = mockFileUri('D:\\oversized-workspace');
    const oversizedLocalUri = mockFileUri('D:\\oversized-workspace\\huge.bin');
    resetMockWorkspace([oversizedLocalWorkspace], [
        [oversizedLocalWorkspace.fsPath, { type: 2 }],
        [oversizedLocalUri.fsPath, { type: 1, content: 'small mock', size: MAX_REMOTE_FILE_BYTES + 1 }],
    ]);
    const boundedLocalRead = createTestSyncEngine() as any;
    boundedLocalRead.settings = { getWorkspaceFolder: () => oversizedLocalWorkspace };
    await assert.rejects(
        () => boundedLocalRead.readLocalFile(oversizedLocalUri),
        /exceeds the synchronization size limit/,
        'local uploads must reject oversized files before reading them into memory',
    );

    const protectedPaths = createTestSyncEngine() as any;
    protectedPaths.ignoreParser = { shouldIgnore: () => false };
    assert.equal(protectedPaths.shouldSync('/.git/config'), false);
    assert.equal(protectedPaths.shouldSync('/.vscode/settings.json'), false);
    assert.equal(protectedPaths.shouldSync('/.localleaf/settings.json'), false);
    assert.equal(protectedPaths.shouldSync('/chapter.tex'), true);

    const protectedPull = createTestSyncEngine() as any;
    protectedPull.disposed = false;
    protectedPull.project = { name: 'Protected project', rootFolder: [] };
    protectedPull.refreshProjectFileTree = async () => undefined;
    const protectedRoot = { id: 'root', type: 'folder', path: '/' };
    const protectedFolder = { id: 'git', type: 'folder', path: '/.git/' };
    protectedPull.fileTree = new Map([
        [protectedRoot.id, protectedRoot],
        [protectedFolder.id, protectedFolder],
    ]);
    protectedPull.fileTreeByPath = new Map([
        [protectedRoot.path, protectedRoot],
        [protectedFolder.path, protectedFolder],
    ]);
    protectedPull.baseContent = new Map();
    protectedPull.baseHashes = new Map();
    protectedPull.fileCache = new Map();
    protectedPull.shouldSync = (projectPath: string) => projectPath === '/';
    protectedPull.assertNoSymbolicLinks = async () => {
        throw new Error('ignored remote folders must not reach the local filesystem');
    };
    protectedPull.findLocalOnlyFiles = async () => [];
    protectedPull.settings = { updateLastSynced: async () => undefined };
    protectedPull.setStatus = () => undefined;
    await protectedPull.pullAll();
    assert.equal(protectedPull.baseContent.has('/.git/'), false,
        'a full pull must not materialize or track protected remote folders');

    const cancellableLock = createTestSyncEngine() as any;
    cancellableLock.disposed = false;
    cancellableLock.syncLock = new Set(['/busy.tex']);
    cancellableLock.pendingWaits = new Map();
    cancellableLock.disposables = [];
    cancellableLock.api = { dispose: () => undefined };
    cancellableLock._onStatusChange = new MockEventEmitter();
    cancellableLock.suppressedRemoteDeletes = new Set();
    cancellableLock.suppressedRemoteRenames = new Map();
    cancellableLock.suppressedRemoteDocumentUpdates = new Map();
    cancellableLock.remoteDiffContents = new Map();
    cancellableLock.fileTree = new Map();
    cancellableLock.fileTreeByPath = new Map();
    cancellableLock.fileCache = new Map();
    cancellableLock.baseContent = new Map();
    cancellableLock.pendingLocalCreates = new Set();
    cancellableLock.joinedDocs = new Set();
    cancellableLock.documentSnapshots = new Map();
    const pendingLock = cancellableLock.acquireLockWhenAvailable('/busy.tex');
    cancellableLock.disconnect();
    assert.equal(await pendingLock, false, 'disconnect must cancel lock waits immediately');

    const rootDeletion = createTestSyncEngine() as any;
    rootDeletion.suppressedRemoteDeletes = new Set();
    rootDeletion.fileTree = new Map([['root', { id: 'root', type: 'folder', path: '/' }]]);
    await assert.rejects(
        () => rootDeletion.handleRemoteFileRemoved('root'),
        /project root/,
    );

    const cleanup = createTestSyncEngine() as any;
    cleanup.disposed = false;
    cleanup.syncLock = new Set();
    cleanup.pendingWaits = new Map();
    const ignored = {
        id: 'aux-id',
        type: 'file',
        path: '/thesis.aux',
        name: 'thesis.aux',
    };
    const kept = {
        id: 'tex-id',
        type: 'doc',
        path: '/thesis.tex',
        name: 'thesis.tex',
    };
    const ignoredFolder = {
        id: 'folder-id',
        type: 'folder',
        path: '/build/',
        name: 'build',
    };
    cleanup.fileTree = new Map([
        [ignored.id, ignored],
        [kept.id, kept],
        [ignoredFolder.id, ignoredFolder],
    ]);
    cleanup.fileTreeByPath = new Map([
        [ignored.path, ignored],
        [kept.path, kept],
        [ignoredFolder.path, ignoredFolder],
    ]);
    cleanup.baseContent = new Map();
    cleanup.fileCache = new Map();
    cleanup.joinedDocs = new Set();
    cleanup.documentSnapshots = new Map();
    cleanup.pendingLocalCreates = new Set();
    cleanup.suppressedRemoteDocumentUpdates = new Map();
    cleanup.ignoreParser = {
        load: async () => undefined,
        shouldIgnore: (candidate: string) =>
            candidate.endsWith('.aux') || candidate.startsWith('/build/'),
    };
    cleanup.refreshProjectFileTree = async () => undefined;
    cleanup.setStatus = () => undefined;
    cleanup.log = () => undefined;
    const deleted: string[] = [];
    cleanup.deleteRemoteEntry = async (entry: { id: string; path: string }) => {
        deleted.push(entry.path);
        cleanup.fileTree.delete(entry.id);
        cleanup.fileTreeByPath.delete(entry.path);
    };

    const ignoredRemote = await cleanup.getIgnoredRemoteFiles();
    assert.deepStrictEqual(ignoredRemote, ['/build/', '/thesis.aux']);
    const cleanupResult = await cleanup.deleteIgnoredRemoteFiles(ignoredRemote);
    assert.deepStrictEqual(cleanupResult, { deleted: 2, failed: [] });
    assert.deepStrictEqual(deleted, ['/build/', '/thesis.aux']);
    assert.equal(cleanup.fileTreeByPath.has('/thesis.tex'), true);

    const selfHostedRefresh = createTestSyncEngine() as any;
    const liveEntry = {
        id: 'live-id',
        type: 'file',
        path: '/thesis.aux',
        name: 'thesis.aux',
    };
    selfHostedRefresh.settings = { getSettings: () => ({ projectId: 'project' }) };
    selfHostedRefresh.socket = { isConnected: true };
    selfHostedRefresh.api = {
        getProjectDetails: async () => ({
            type: 'success',
            projectData: { projectId: 'project' },
        }),
    };
    selfHostedRefresh.fileTree = new Map([[liveEntry.id, liveEntry]]);
    selfHostedRefresh.fileTreeByPath = new Map([[liveEntry.path, liveEntry]]);
    await selfHostedRefresh.refreshProjectFileTree();
    assert.equal(selfHostedRefresh.fileTreeByPath.get(liveEntry.path), liveEntry,
        'a self-hosted server without HTTP folder metadata must retain the live Socket.IO tree');

    const unavailableRefresh = createTestSyncEngine() as any;
    unavailableRefresh.settings = selfHostedRefresh.settings;
    unavailableRefresh.api = selfHostedRefresh.api;
    unavailableRefresh.fileTree = new Map();
    unavailableRefresh.fileTreeByPath = new Map();
    await assert.rejects(
        () => unavailableRefresh.refreshProjectFileTree(),
        /Overleaf returned no folder tree/,
        'missing HTTP metadata must still fail when no live project tree is available',
    );

    const viewsDirectory = path.join(__dirname, '..', 'views');
    const webviewFiles = [
        'projectsWebviewProvider.js',
        'mainWebviewProvider.js',
        'accountPanel.js',
    ];
    for (const filename of webviewFiles) {
        const source = fs.readFileSync(path.join(viewsDirectory, filename), 'utf8');
        assert.match(source, /Content-Security-Policy/, `${filename} must define a CSP`);
        assert.match(source, /script-src 'nonce-\$\{nonce\}'/, `${filename} must use a script nonce`);
        assert.doesNotMatch(source, /enableCommandUris/, `${filename} must not enable command URIs`);
        assert.doesNotMatch(source, /\.innerHTML\s*=/, `${filename} must render untrusted data with DOM APIs`);
    }

    const mockWebview = {
        cspSource: 'vscode-webview-test:',
        asWebviewUri: () => 'vscode-webview-test:/icon.svg',
    };
    const { ProjectsWebviewProvider } = require(path.join('..', 'views', 'projectsWebviewProvider')) as {
        ProjectsWebviewProvider: any;
    };
    const projectsProvider = Object.create(ProjectsWebviewProvider.prototype) as any;
    projectsProvider.extensionUri = 'extension';
    const projectsHtml = projectsProvider.getHtml(mockWebview);
    const { runErrorPresentationTests } = require('./errorPresentationTest') as {
        runErrorPresentationTests(html: string): void;
    };
    runErrorPresentationTests(projectsHtml);
    assert.match(projectsHtml, /split\(\/\\s\+\/\)/, 'project initials must split on whitespace');
    assert.match(projectsHtml, /openLocalProject/, 'detected local projects must be openable from the panel');
    assert.match(projectsHtml, /ArrowDown/, 'project lists must support keyboard navigation');
    assert.match(projectsHtml, /aria-label', 'Detected LocalLeaf projects'/,
        'the detected-project list must have an accessible name');
    assert.match(projectsHtml, /state\.workspaceKind === 'invalid-config'/,
        'invalid LocalLeaf configuration must have a dedicated warning state');

    let finishOpenProject: (() => void) | undefined;
    let openProjectCalls = 0;
    executeCommandImpl = async () => {
        openProjectCalls++;
        await new Promise<void>(resolve => { finishOpenProject = resolve; });
    };
    const project = { id: 'project-id', name: 'Project' };
    projectsProvider.projects = [project];
    projectsProvider.state = { status: 'ready', projects: [project] };
    const firstOpen = projectsProvider.handleMessage({ type: 'openProject', projectId: project.id });
    const duplicateOpen = projectsProvider.handleMessage({ type: 'openProject', projectId: project.id });
    await Promise.resolve();
    assert.equal(openProjectCalls, 1, 'the projects view must suppress duplicate link actions');
    finishOpenProject?.();
    await Promise.all([firstOpen, duplicateOpen]);
    assert.equal(projectsProvider.state.openingProjectId, undefined, 'the project action must unlock after completion');
    executeCommandImpl = async () => undefined;

    const { MainWebviewProvider, statusDescription, shouldShowChangesTab } = require(
        path.join('..', 'views', 'mainWebviewProvider')
    ) as {
        MainWebviewProvider: any;
        statusDescription(status: string): string;
        shouldShowChangesTab(syncMode: 'realtime' | 'manual'): boolean;
    };
    const mainProvider = Object.create(MainWebviewProvider.prototype) as any;
    mainProvider.extensionUri = 'extension';
    const mainHtml = mainProvider.getHtml(mockWebview);
    assert.match(mainHtml, /split\(\/\\s\+\/\)/, 'collaborator initials must split on whitespace');
    assert.match(mainHtml, /role="tablist"/, 'main navigation must expose ARIA tab semantics');
    assert.match(mainHtml, /ArrowRight/, 'main tabs must support keyboard navigation');
    assert.match(mainHtml, /aria-modal', 'true'/, 'dangerous actions must use an accessible modal dialog');
    assert.match(mainHtml, /event\.key === 'Escape'/, 'confirmation dialogs must support Escape');
    assert.equal(shouldShowChangesTab('realtime'), false,
        'the placeholder Changes tab must stay hidden during real-time synchronization');
    assert.equal(shouldShowChangesTab('manual'), true,
        'manual synchronization can expose the Changes surface later');
    assert.deepStrictEqual(
        ['disconnected', 'connecting', 'idle', 'syncing', 'pulling', 'pushing', 'error']
            .map(status => statusDescription(status)),
        [
            'Disconnected',
            'Connecting\u2026',
            'Up to date',
            'Synchronizing\u2026',
            'Pulling from Overleaf\u2026',
            'Pushing to Overleaf\u2026',
            'Synchronization error',
        ],
        'every synchronization state must have user-facing text',
    );

    const noticeProvider = Object.create(MainWebviewProvider.prototype) as any;
    noticeProvider.syncStatus = 'idle';
    noticeProvider.onlineUsers = [];
    noticeProvider.state = {
        linked: true,
        syncStatus: 'idle',
        statusText: 'Up to date',
        syncMode: 'realtime',
        showChanges: false,
        details: [],
        onlineUsers: [],
        signedIn: true,
        mainDocumentSelected: true,
    };
    noticeProvider.setSyncStatus('connecting', 'Connecting to Overleaf...');
    assert.deepStrictEqual(noticeProvider.state.notice, {
        kind: 'info',
        message: 'Connecting to Overleaf...',
    });
    noticeProvider.setSyncStatus('error', 'Connection failed');
    assert.equal(noticeProvider.state.notice.actionLabel, 'Retry sync',
        'authenticated sync failures should offer a retry instead of an unrelated login action');

    const confirmedCommands: string[] = [];
    const confirmedCommandProvider = new MainWebviewProvider(
        'extension',
        {},
        async (command: string) => { confirmedCommands.push(command); },
    ) as any;
    await confirmedCommandProvider.handleMessage({
        type: 'runConfirmedCommand',
        command: 'localleaf.cleanIgnoredRemoteFiles',
    });
    await confirmedCommandProvider.handleMessage({
        type: 'runConfirmedCommand',
        command: 'localleaf.syncNow',
    });
    assert.deepStrictEqual(confirmedCommands, ['localleaf.cleanIgnoredRemoteFiles'],
        'only explicitly dangerous panel actions may use the panel-confirmed path');

    let postedStates = 0;
    mainProvider.onlineUsers = [];
    mainProvider.state = {
        linked: true,
        syncStatus: 'idle',
        statusText: 'Up to date',
        details: [],
        onlineUsers: [],
    };
    mainProvider.view = {
        webview: {
            postMessage: async () => {
                postedStates++;
                return true;
            },
        },
    };
    mainProvider.setOnlineUsers([]);
    assert.equal(postedStates, 0, 'an unchanged collaborator list must not refresh the webview');
    const onlineUser = { clientId: 'client', name: 'User', color: '#123456', docPath: '/main.tex', row: 4 };
    mainProvider.setOnlineUsers([onlineUser]);
    mainProvider.setOnlineUsers([{ ...onlineUser }]);
    assert.equal(postedStates, 1, 'equivalent collaborator updates must be coalesced');

    let finishStateBuild: (() => void) | undefined;
    let stateBuilds = 0;
    const refreshProvider = Object.create(MainWebviewProvider.prototype) as any;
    refreshProvider.buildState = async () => {
        stateBuilds++;
        if (stateBuilds === 1) await new Promise<void>(resolve => { finishStateBuild = resolve; });
        return {
            linked: true,
            syncStatus: 'idle',
            statusText: 'Up to date',
            details: [],
            onlineUsers: [],
        };
    };
    const firstRefresh = refreshProvider.refresh();
    const duplicateRefresh = refreshProvider.refresh();
    await Promise.resolve();
    assert.equal(stateBuilds, 1, 'overlapping full refreshes must share one state build');
    finishStateBuild?.();
    await Promise.all([firstRefresh, duplicateRefresh]);
    assert.equal(stateBuilds, 2, 'a refresh during an outstanding snapshot must rebuild the current state');

    const accountSource = fs.readFileSync(path.join(viewsDirectory, 'accountPanel.js'), 'utf8');
    const { AccountPanel } = require('../views/accountPanel') as { AccountPanel: any };
    const accountProvider = Object.create(AccountPanel.prototype) as any;
    const { runConnectionSettingsTests } = require('./connectionSettingsTest') as {
        runConnectionSettingsTests(html: string): Promise<void>;
    };
    await runConnectionSettingsTests(accountProvider.getHtml(mockWebview));
    assert.deepStrictEqual(accountProvider.parseAction({ type: 'selectServer', serverUrl: ' https://other.example/ ' }),
        { type: 'selectServer', serverUrl: 'https://other.example/' });
    assert.equal(accountProvider.parseAction({ type: 'selectServer', serverUrl: 42 }), undefined);
    const cookieHandler = accountSource.indexOf("loginCookies.addEventListener('click'");
    const cookieClear = accountSource.indexOf("cookies.value = ''", cookieHandler);
    const cookiePost = accountSource.indexOf("vscode.postMessage({ type: 'loginCookies'", cookieHandler);
    assert.ok(cookieHandler >= 0 && cookieClear > cookieHandler && cookieClear < cookiePost,
        'session cookies must be removed from the DOM before the login message is posted');
    const accountParser = Object.create(AccountPanel.prototype) as any;
    assert.deepStrictEqual(accountParser.parseAction({
        type: 'loginCookies',
        serverUrl: 'https://overleaf.example',
        cookies: 'session=safe',
    }), {
        type: 'loginCookies',
        serverUrl: 'https://overleaf.example',
        cookies: 'session=safe',
    });
    assert.equal(accountParser.parseAction({
        type: 'loginCookies',
        serverUrl: { toString: () => 'https://attacker.example' },
        cookies: 'session=safe',
    }), undefined, 'account messages must not coerce attacker-controlled objects into URLs');
    assert.equal(accountParser.parseAction({
        type: 'loginCookies',
        serverUrl: 'https://overleaf.example',
        cookies: 'session=safe\r\nInjected: header',
    }), undefined, 'cookie messages containing header delimiters must be rejected in the webview host');
    assert.match(accountSource, /loginBrowser/);
    assert.match(accountSource, /cancelLogin/);
    assert.match(accountSource, /verifySession/);
    assert.match(accountSource, /aria-busy/,
        'the Account panel must expose its busy state to assistive technology');
    assert.doesNotMatch(accountSource, /\.innerHTML\s*=/,
        'account and server values must never be interpolated through innerHTML');

    const extensionSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'extension.ts'),
        'utf8',
    );
    const syncEngineSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'sync', 'syncEngine.ts'),
        'utf8',
    );
    assert.match(syncEngineSource, /Some files need your choice in notifications; other files continue syncing/,
        'interactive pulls must identify a required choice even when VS Code hides notifications');
    const cookieLoginStart = extensionSource.indexOf('async function loginWithCookies');
    const cookieLoginEnd = extensionSource.indexOf('// === Command Implementations ===', cookieLoginStart);
    const cookieLoginSource = extensionSource.slice(cookieLoginStart, cookieLoginEnd);
    const insecureWarning = extensionSource.indexOf('async function confirmInsecureServer');
    const cookieApiCreation = cookieLoginSource.indexOf('new BaseAPI');
    assert.ok(cookieLoginStart >= 0 && cookieLoginEnd > cookieLoginStart);
    assert.match(cookieLoginSource, /validateServerUrl\(serverUrl\)/);
    assert.match(cookieLoginSource, /await confirmInsecureServer/);
    assert.match(extensionSource.slice(insecureWarning, cookieLoginStart), /modal:\s*true/);
    assert.ok(insecureWarning >= 0 && cookieApiCreation >= 0,
        'HTTP cookie login must require a modal warning before any API request');
    assert.match(extensionSource, /if \(await loginWithCookies[\s\S]*await reconnectAfterLogin\(context\)/,
        'cancelling the HTTP warning must also skip reconnecting');
    assert.doesNotMatch(extensionSource, /serverUrl\.includes\(['"]overleaf\.com/,
        'official Overleaf detection must use the parsed hostname, not a substring');
    assert.match(extensionSource, /async function cmdRefreshCookie[\s\S]*COMMANDS\.SHOW_ACCOUNT_PANEL/,
        're-authentication commands must return users to the unified Account panel');
    const activationStart = extensionSource.indexOf('export async function activate');
    const activationEnd = extensionSource.indexOf(' * Register all commands', activationStart);
    const activationSource = extensionSource.slice(activationStart, activationEnd);
    assert.ok(activationStart >= 0 && activationEnd > activationStart);
    assert.match(activationSource, /startInitialSync\(context, settingsManager\);/,
        'extension activation must start initial synchronization without awaiting an interactive pull');
    assert.doesNotMatch(activationSource, /await initializeSync\(context, settingsManager\);/,
        'an interactive initial pull must not block webview activation');
    const initializeStart = extensionSource.indexOf('async function initializeSync');
    const initializeEnd = extensionSource.indexOf('function updateStatusBar', initializeStart);
    const initializeSource = extensionSource.slice(initializeStart, initializeEnd);
    const credentialAwait = initializeSource.indexOf('await credentialManager.getCredential');
    const pendingKeyPublication = initializeSource.indexOf('activeSyncKey = initializationSyncKey');
    const staleInitializationCheck = initializeSource.indexOf(
        'if (!isCurrentSyncInitialization(',
        credentialAwait,
    );
    const engineCreation = initializeSource.indexOf('new SyncEngine', credentialAwait);
    assert.ok(initializeStart >= 0 && initializeEnd > initializeStart);
    assert.match(extensionSource, /function disposeCurrentSyncSession\(\): void \{[\s\S]*syncSessionGeneration\+\+;/,
        'disposing a sync session must invalidate initializations that are still awaiting prerequisites');
    assert.match(initializeSource, /if \(deactivating\) return;[\s\S]*const initializationGeneration = syncSessionGeneration;/,
        'initial synchronization must capture an ownership generation and refuse to start during deactivation');
    assert.ok(
        pendingKeyPublication >= 0
        && pendingKeyPublication < credentialAwait
        && staleInitializationCheck > credentialAwait
        && engineCreation > staleInitializationCheck,
        'the pending key must be visible before SecretStorage and stale initialization must stop before engine creation',
    );
    assert.match(initializeSource, /await setAuthState[\s\S]*abandonStaleSyncEngine/,
        'initial synchronization must re-check ownership after UI refreshes yield control');
    assert.match(extensionSource, /if \(nextKey !== activeSyncKey\)[\s\S]*initializeSync\(context, current\)/,
        'settings changes must invalidate pending as well as active synchronization');
    const reconnectStart = extensionSource.indexOf('async function cmdReconnect');
    const reconnectEnd = extensionSource.indexOf('/**', reconnectStart + 1);
    const reconnectSource = extensionSource.slice(reconnectStart, reconnectEnd);
    assert.match(reconnectSource, /if \(deactivating\) return;/);
    assert.match(reconnectSource, /await settingsManager\.isLinked\(\)[\s\S]*deactivating[\s\S]*SettingsManager\.getCurrentInstance/,
        'reconnect must revalidate its workspace after yielding');
    assert.match(reconnectSource, /await initializeSync\(context, settingsManager\);/,
        'reconnect must use the generation-guarded initialization path');
    assert.doesNotMatch(reconnectSource, /new SyncEngine/,
        'reconnect must not maintain a second unguarded engine-construction path');
    assert.match(extensionSource, /captureCookiesViaBrowserLogin[\s\S]*controller\.signal/,
        'browser login must be cancellable from the Account panel and native progress UI');
    assert.match(extensionSource, /vscode\.env\.remoteName[\s\S]*manual cookie option/,
        'remote extension hosts must fall back to manual cookies instead of launching a remote browser');
    assert.match(extensionSource, /verifyCredentialsForServer\(requestedServerUrl/,
        'session verification must accept an Account-panel server without requiring a linked project');
    assert.match(extensionSource, /activeBrowserLogin\?\.abort\(\)[\s\S]*await waitForBrowserLoginCleanup/,
        'extension deactivation must wait for browser process and profile cleanup');
    assert.match(extensionSource, /if \(deactivating\) return false;[\s\S]*confirmInsecureServer[\s\S]*\|\| deactivating/,
        'deactivation must prevent browser launch before and after an HTTP warning');
    assert.match(extensionSource, /result\.authError === 'session_expired'[\s\S]*result\.authError === 'invalid_credentials'/,
        'only explicit authentication failures may expire a stored session');
    assert.match(extensionSource, /Could not verify the session[\s\S]*stored session was not changed/,
        'transient verification failures must preserve the stored session');
    assert.match(extensionSource, /onCleanupFailure:[\s\S]*could not remove its isolated browser profile/,
        'failed temporary-profile cleanup must be visible to the user');
    assert.match(extensionSource, /if \(accountActionInProgress\)[\s\S]*before logging out/,
        'direct account commands must not race an active browser login');
    assert.doesNotMatch(extensionSource, /context\.subscriptions\.push\(tracker\)/,
        'reconnected cursor trackers must not be retained for the full extension lifetime');
    assert.match(extensionSource, /handleWorkspaceFoldersChanged[\s\S]*disposeCurrentSyncSession\(\)[\s\S]*initializeSync/,
        'workspace-folder changes must replace the active synchronization session');
    const initializeSyncStart = extensionSource.indexOf('async function initializeSync');
    const initializeSyncEnd = extensionSource.indexOf('/**\n * Update status bar', initializeSyncStart);
    const initializeSyncSource = extensionSource.slice(initializeSyncStart, initializeSyncEnd);
    assert.ok(
        initializeSyncSource.indexOf('await ensureSyncAuthorization')
            < initializeSyncSource.indexOf('new BaseAPI'),
        'an existing .localleaf file must require explicit target approval before any sync API is created',
    );
    assert.match(extensionSource, /settingsManager\.save\(settings\)[\s\S]*grantSyncAuthorization/,
        'an explicit project-link workflow must record synchronization consent');
    assert.match(extensionSource, /revokeSyncAuthorization[\s\S]*settingsManager\.delete\(\)/,
        'unlinking must revoke the folder-specific synchronization consent');
    assert.match(
        extensionSource,
        /createCredentialTooltip[\s\S]*appendText\(`Email: \$\{credential\.userEmail\}`\)[\s\S]*appendText\(`Server: \$\{credential\.serverUrl\}`\)/,
        'server-provided account fields must be appended as text instead of interpreted as Markdown',
    );
    const loginStatusStart = extensionSource.indexOf('async function updateLoginStatus');
    const loginStatusEnd = extensionSource.indexOf(
        'async function showSessionExpiredNotification',
        loginStatusStart,
    );
    const loginStatusSource = extensionSource.slice(loginStatusStart, loginStatusEnd);
    assert.match(
        loginStatusSource,
        /credentialManager\.getCredential\(settings\.serverUrl\)/,
        'the account status must use the linked project server',
    );
    assert.doesNotMatch(
        loginStatusSource,
        /credentialManager\.getDefaultServer\(\)/,
        'the account status must not fall back to a different global server while a project is linked',
    );
    assert.doesNotMatch(
        extensionSource,
        /new vscode\.MarkdownString\([^)]*credential\.(?:userEmail|serverUrl)/,
        'credential fields must never be interpolated into a MarkdownString constructor',
    );
    assert.equal(extensionSource.match(/new SyncEngine/g)?.length, 1,
        'all connection and reconnection paths must pass through the authorized initializer');
    const pullCommandStart = extensionSource.indexOf('async function cmdPullFromOverleaf');
    const pullCommandEnd = extensionSource.indexOf('/**\n * Push to Overleaf', pullCommandStart);
    assert.match(
        extensionSource.slice(pullCommandStart, pullCommandEnd),
        /pullAll\(\)[\s\S]*joinAllDocsForWatching\(\)/,
        'a manual pull must restore live document subscriptions before it reports success',
    );

    const projectsSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'views', 'projectsWebviewProvider.ts'),
        'utf8',
    );
    assert.match(projectsSource, /Preparing synchronization\.\.\./);
    assert.match(projectsSource, /result\.authError[\s\S]*onAuthenticationState\?\.\(credential\.serverUrl, 'expired'\)/,
        'project-list authentication failures must update the Account panel state');
    assert.match(projectsSource, /onAuthenticationState\?\.\(credential\.serverUrl, 'valid'\)/,
        'a successful authenticated project request must verify the stored session');
    assert.doesNotMatch(projectsSource, /Ã|â€¦/,
        'project loading text must not contain mojibake');

    const { LinkOperationGate, resolveRequestedProject, shouldConfirmProjectLink } = require(
        path.join('..', 'utils', 'linkSafety')
    ) as {
        LinkOperationGate: new () => { tryEnter(): boolean; leave(): void; isActive: boolean };
        resolveRequestedProject<T extends { id: string }>(projects: readonly T[], requested: unknown): T | undefined;
        shouldConfirmProjectLink(entryNames: readonly string[]): boolean;
    };
    const linkGate = new LinkOperationGate();
    assert.equal(linkGate.tryEnter(), true);
    assert.equal(linkGate.tryEnter(), false, 'a concurrent project link must be rejected');
    linkGate.leave();
    assert.equal(linkGate.tryEnter(), true, 'the project link gate must release in a finally block');
    assert.equal(shouldConfirmProjectLink(['.localleaf', '.leafignore']), false);
    assert.equal(shouldConfirmProjectLink(['.git', '.vscode', '.localleaf', '.leafignore']), false);
    assert.equal(shouldConfirmProjectLink(['.localleaf', 'chapter.tex']), true,
        'folders containing user files must require confirmation');
    const canonicalProject = { id: 'project-1', name: 'Canonical project' };
    assert.strictEqual(
        resolveRequestedProject([canonicalProject], { id: 'project-1', name: 'Injected name' }),
        canonicalProject,
        'public command arguments must resolve to the canonical authenticated project object',
    );
    assert.equal(resolveRequestedProject([canonicalProject], { id: 'other-project' }), undefined);
    assert.equal(resolveRequestedProject([canonicalProject], { id: 'project-1\nInjected' }), undefined);

    const { createNonce } = require(path.join('..', 'views', 'webviewUtils')) as {
        createNonce(): string;
    };
    const firstNonce = createNonce();
    const secondNonce = createNonce();
    assert.match(firstNonce, /^[0-9a-f]{32}$/);
    assert.notEqual(firstNonce, secondNonce, 'CSP nonces must use cryptographic randomness');

    const {
        assertSafeWorkspacePath,
        getWorkspaceRelativePath,
        isFileNotFoundError,
        joinProjectPath,
        normalizeProjectPath,
    } = require(
        path.join('..', 'utils', 'pathSafety')
    ) as {
        assertSafeWorkspacePath(workspace: MockUri, target: MockUri): Promise<void>;
        getWorkspaceRelativePath(workspace: MockUri, target: MockUri): string | undefined;
        isFileNotFoundError(error: unknown): boolean;
        joinProjectPath(parent: string, name: string, folder: boolean): string;
        normalizeProjectPath(candidate: string, allowRoot?: boolean): string;
    };
    assert.equal(joinProjectPath('/chapters/', 'intro.tex', false), '/chapters/intro.tex');
    assert.throws(() => joinProjectPath('/', '../outside.tex', false), /Unsafe Overleaf entity name/);
    assert.throws(() => normalizeProjectPath('/../../outside.tex', false), /Unsafe Overleaf entity name/);
    assert.throws(() => normalizeProjectPath('/safe\\..\\outside.tex', false), /Unsafe Overleaf project path/);
    assert.throws(() => normalizeProjectPath('/', false), /workspace root/);
    assert.throws(() => joinProjectPath('/', 'settings.json.', false), /Unsafe Overleaf entity name/);
    assert.throws(() => joinProjectPath('/', 'CON', false), /Unsafe Overleaf entity name/);
    const safetyRoot = mockFileUri('D:\\safety-workspace');
    const linkedTarget = mockFileUri('D:\\safety-workspace\\linked\\secret.tex');
    const driveCaseTarget = mockFileUri('d:\\SAFETY-WORKSPACE\\chapter.tex');
    resetMockWorkspace([safetyRoot], [
        ['D:\\safety-workspace', { type: 2 }],
        ['D:\\safety-workspace\\linked', { type: 66 }],
        ['D:\\safety-workspace\\chapter.tex', { type: 1, content: 'test' }],
    ]);
    await assert.rejects(
        () => assertSafeWorkspacePath(safetyRoot, linkedTarget),
        /symbolic link/,
        'existing symbolic-link ancestors must never be traversed',
    );
    await assert.rejects(
        () => assertSafeWorkspacePath(safetyRoot, mockFileUri('D:\\outside\\secret.tex')),
        /outside the workspace/,
    );
    assert.equal(
        getWorkspaceRelativePath(safetyRoot, driveCaseTarget),
        'chapter.tex',
        'Windows drive and directory case differences must remain inside the workspace',
    );
    await assert.doesNotReject(() => assertSafeWorkspacePath(safetyRoot, driveCaseTarget));
    assert.equal(
        getWorkspaceRelativePath(safetyRoot, mockFileUri('D:\\safety-workspace-evil\\secret.tex')),
        undefined,
        'a sibling with the same textual prefix must remain outside the workspace',
    );
    assert.equal(
        getWorkspaceRelativePath(safetyRoot, mockFileUri('E:\\safety-workspace\\secret.tex')),
        undefined,
        'a path on another Windows drive must remain outside the workspace',
    );
    assert.equal(isFileNotFoundError(new Error('ENOENT: missing file')), true);
    assert.equal(
        isFileNotFoundError(new MockFileSystemError('Access denied')),
        false,
        'filesystem errors without a missing-path signal must not bypass path safety checks',
    );

    const { validateServerUrl } = require(path.join('..', 'utils', 'serverUrl')) as {
        validateServerUrl(candidate: string): { url: string; isOfficialOverleaf: boolean };
    };
    assert.equal(validateServerUrl('https://www.overleaf.com/').url, 'https://www.overleaf.com');
    assert.equal(validateServerUrl('https://www.overleaf.com').isOfficialOverleaf, true);
    assert.equal(validateServerUrl('https://overleaf.com.attacker.example').isOfficialOverleaf, false);
    assert.throws(() => validateServerUrl('https://overleaf.com@attacker.example'), /embedded credentials/);
    assert.throws(() => validateServerUrl('file:///tmp/overleaf'), /HTTP or HTTPS/);

    const { MAX_PROJECT_SETTINGS_BYTES, SettingsManager, isValidProjectSettings } = require(
        path.join('..', 'utils', 'settingsManager')
    ) as {
        MAX_PROJECT_SETTINGS_BYTES: number;
        SettingsManager: {
            clearCurrentWorkspaceFolder(): void;
            getInstance(uri: MockUri): {
                delete(): Promise<void>;
                getFilePath(relativePath: string): MockUri;
                getRelativePath(uri: MockUri): string | undefined;
            };
            createDefaultSettings(serverUrl: string, projectId: string, projectName: string): {
                mainTex?: string;
                mainPdf?: string;
            };
            findLinkedProjectFolders(): Promise<Array<{
                uri: MockUri;
                relativePath: string;
                settings: { projectId: string; projectName: string };
            }>>;
            inspectFolder(uri: MockUri): Promise<{ kind: string }>;
            loadSettings(uri: MockUri): Promise<unknown>;
            resolveCurrentInstance(): Promise<{
                getWorkspaceFolder(): MockUri;
            } | undefined>;
        };
        isValidProjectSettings(value: unknown): boolean;
    };
    const defaultSettings = SettingsManager.createDefaultSettings(
        'https://overleaf.example',
        'project-id',
        'Project',
    );
    assert.equal(defaultSettings.mainTex, undefined, 'new links must not assume main.tex');
    assert.equal(defaultSettings.mainPdf, undefined, 'new links must not assume main.pdf');
    assert.equal(isValidProjectSettings({}), false, 'an empty .localleaf settings object is not a valid link');
    assert.equal(isValidProjectSettings({
        serverUrl: 'https://overleaf.example',
        projectId: 'project-id',
        projectName: 'Project',
        autoSync: true,
    }), true);
    assert.equal(isValidProjectSettings({
        serverUrl: 'https://overleaf.example',
        projectId: 'project-id',
        projectName: 'Project',
        mainTex: 42,
    }), false, 'invalid optional values must not pass the stored-settings validator');
    assert.equal(isValidProjectSettings({
        serverUrl: 'https://overleaf.example',
        projectId: 'project-id',
        projectName: 'Project',
        mainTex: '../outside.tex',
    }), false, 'main-document settings must remain inside the project');
    assert.equal(isValidProjectSettings({
        serverUrl: 'file:///tmp/not-a-server',
        projectId: 'project-id',
        projectName: 'Project',
    }), false, 'project settings must reject non-HTTP server URLs');
    assert.equal(isValidProjectSettings({
        serverUrl: 'https://overleaf.example',
        projectId: 'project-id',
        projectName: 'Project',
        lastSynced: 'not-a-date',
    }), false, 'last-synchronized metadata must be a bounded valid timestamp');

    const linkedSettings = JSON.stringify({
        serverUrl: 'https://overleaf.example',
        projectId: 'detected-project-id',
        projectName: 'Detected Project',
        autoSync: true,
    });
    const workspaceRoot = mockFileUri('D:\\workspace');
    resetMockWorkspace([workspaceRoot], [
        ['D:\\workspace', { type: 2 }],
        ['D:\\workspace\\.localleaf', { type: 2 }],
        ['D:\\workspace\\.localleaf\\settings.json', { type: 1, content: linkedSettings }],
    ]);
    SettingsManager.clearCurrentWorkspaceFolder();
    const resolvedManager = await SettingsManager.resolveCurrentInstance();
    assert.equal(resolvedManager?.getWorkspaceFolder().toString(), workspaceRoot.toString(),
        'activation must restore a valid LocalLeaf project already open as a workspace root');
    assert.equal((await SettingsManager.inspectFolder(workspaceRoot)).kind, 'linked');
    const pathManager = SettingsManager.getInstance(workspaceRoot);
    assert.equal(pathManager.getFilePath('/safe/file.tex').fsPath, 'D:\\workspace\\safe\\file.tex');
    assert.throws(() => pathManager.getFilePath('/../outside.tex'), /Unsafe Overleaf entity name/);
    assert.throws(() => pathManager.getFilePath('/'), /workspace root/);
    assert.equal(
        pathManager.getRelativePath(mockFileUri('d:\\WORKSPACE\\safe\\file.tex')),
        '/safe/file.tex',
        'filesystem watcher URIs must tolerate Windows path casing differences',
    );
    assert.equal(pathManager.getRelativePath(mockFileUri('d:\\WORKSPACE')), '/');
    assert.equal(pathManager.getRelativePath(mockFileUri('D:\\workspace-evil\\file.tex')), undefined);
    assert.equal(pathManager.getRelativePath(mockFileUri('E:\\workspace\\file.tex')), undefined);

    resetMockWorkspace([workspaceRoot], [
        ['D:\\workspace', { type: 2 }],
        ['D:\\workspace\\.localleaf', { type: 2 }],
        [
            'D:\\workspace\\.localleaf\\settings.json',
            { type: 1, content: 'x'.repeat(MAX_PROJECT_SETTINGS_BYTES + 1) },
        ],
    ]);
    assert.equal(await SettingsManager.loadSettings(workspaceRoot), undefined,
        'oversized project settings must be rejected before parsing');

    resetMockWorkspace([workspaceRoot], [
        ['D:\\workspace', { type: 2 }],
        ['D:\\workspace\\.localleaf', { type: 2 }],
        ['D:\\workspace\\.localleaf\\settings.json', { type: 1, content: linkedSettings }],
        ['D:\\workspace\\.localleaf\\legacy-cache.json', { type: 1, content: '{}' }],
    ]);
    await pathManager.delete();
    assert.deepStrictEqual(
        mockFileDeletes.map(item => [mockUriKey(item.uri), item.recursive]),
        [['D:\\workspace\\.localleaf\\settings.json', false]],
        'unlinking must preserve unknown files under .localleaf',
    );

    resetMockWorkspace([workspaceRoot], [
        ['D:\\workspace', { type: 2 }],
        ['D:\\workspace\\.localleaf', { type: 2 }],
        ['D:\\workspace\\.localleaf\\settings.json', { type: 1, content: linkedSettings }],
    ]);
    await pathManager.delete();
    assert.deepStrictEqual(
        mockFileDeletes.map(item => [mockUriKey(item.uri), item.recursive]),
        [
            ['D:\\workspace\\.localleaf\\settings.json', false],
            ['D:\\workspace\\.localleaf', false],
        ],
        'unlinking may remove an empty metadata directory without recursive deletion',
    );

    resetMockWorkspace([workspaceRoot], [
        ['D:\\workspace', { type: 2 }],
        ['D:\\workspace\\project-a', { type: 2 }],
        ['D:\\workspace\\project-a\\.localleaf', { type: 2 }],
        ['D:\\workspace\\project-a\\.localleaf\\settings.json', { type: 1, content: linkedSettings }],
    ]);
    SettingsManager.clearCurrentWorkspaceFolder();
    assert.equal((await SettingsManager.inspectFolder(workspaceRoot)).kind, 'non-empty');
    const detectedProjects = await SettingsManager.findLinkedProjectFolders();
    assert.equal(detectedProjects.length, 1, 'one-level LocalLeaf projects must be discovered');
    assert.equal(detectedProjects[0].relativePath, 'project-a');
    assert.equal(detectedProjects[0].settings.projectId, 'detected-project-id');

    const noCredentialManager = {
        getDefaultServer: () => 'https://overleaf.example',
        getCredential: async () => undefined,
    };
    const detectedProjectsProvider = new ProjectsWebviewProvider(
        'extension',
        noCredentialManager,
    ) as any;
    await detectedProjectsProvider.refresh();
    assert.equal(detectedProjectsProvider.state.status, 'local-projects');
    assert.equal(detectedProjectsProvider.state.localProjects[0].projectName, 'Detected Project');
    let openLocalProjectArgs: unknown[] | undefined;
    executeCommandImpl = async (...args: unknown[]) => {
        openLocalProjectArgs = args;
        return undefined;
    };
    await detectedProjectsProvider.handleMessage({
        type: 'openLocalProject',
        uri: detectedProjects[0].uri.toString(),
    });
    assert.equal(openLocalProjectArgs?.[0], 'vscode.openFolder');
    assert.equal((openLocalProjectArgs?.[1] as MockUri).toString(), detectedProjects[0].uri.toString());
    assert.equal(openLocalProjectArgs?.[2], false,
        'opening a detected project should reuse the Extension Development Host window');
    executeCommandImpl = async () => undefined;

    resetMockWorkspace([workspaceRoot], [
        ['D:\\workspace', { type: 2 }],
        ['D:\\workspace\\.leafignore', { type: 1, content: '*.aux' }],
    ]);
    assert.equal((await SettingsManager.inspectFolder(workspaceRoot)).kind, 'empty',
        '.leafignore alone must not make a workspace unsafe to link');
    const emptyFolderProvider = new ProjectsWebviewProvider('extension', noCredentialManager) as any;
    await emptyFolderProvider.refresh();
    assert.equal(emptyFolderProvider.state.status, 'not-logged-in');
    assert.equal(emptyFolderProvider.state.workspaceKind, 'empty');

    const recoveryCredential = {
        serverUrl: 'https://overleaf.example/latex',
        identity: { cookies: 'test-cookie', csrfToken: 'test-csrf' },
    };
    const recoveryAuthStates: string[] = [];
    const recoveryProvider = new ProjectsWebviewProvider('extension', {
        getDefaultServer: () => recoveryCredential.serverUrl,
        getCredential: async () => recoveryCredential,
    }, (_server: string, authState: string) => { recoveryAuthStates.push(authState); }) as any;
    fetchImplementation = async () => ({
        ok: false, status: 502, statusText: 'Bad Gateway',
        text: async () => gatewayPage, json: async () => ({}),
        headers: { get: () => 'text/html', raw: () => ({}) },
    });
    await recoveryProvider.refresh();
    assert.equal(recoveryProvider.state.status, 'connection-error');
    assert.match(recoveryProvider.state.message, /^502:/);
    assert.deepStrictEqual(recoveryAuthStates, [], 'a server failure must not change account validity');
    const recoveryCommands: unknown[][] = [];
    executeCommandImpl = async (...args: unknown[]) => { recoveryCommands.push(args); };
    await recoveryProvider.handleMessage({ type: 'login' });
    await recoveryProvider.handleMessage({ type: 'openFolder' });
    assert.deepStrictEqual(recoveryCommands, [['localleaf.showAccountPanel'], ['vscode.openFolder']]);
    let openedServer = '';
    openExternalImpl = async uri => { openedServer = uri.toString(); return true; };
    await recoveryProvider.handleMessage({ type: 'openServer', url: 'https://untrusted.example' });
    assert.equal(openedServer, 'https://overleaf.example/latex/project',
        'browser recovery must use the configured server and preserve its subpath');
    openExternalImpl = async () => true;
    executeCommandImpl = async () => undefined;

    fetchImplementation = async () => { throw new Error(gatewayPage); };
    await recoveryProvider.refresh();
    assert.equal(recoveryProvider.state.message, 'Could not load Overleaf projects.',
        'exceptions must not put an HTML page back into the sidebar');

    fetchImplementation = async () => ({
        ok: true, status: 200, statusText: 'OK',
        text: async () => JSON.stringify({ projects: [{ _id: 'restored', name: 'Restored project' }] }),
        json: async () => ({}), headers: { get: () => 'application/json', raw: () => ({}) },
    });
    await recoveryProvider.handleMessage({ type: 'refresh' });
    assert.equal(recoveryProvider.state.status, 'ready', 'retry must restore the project list when the server recovers');
    assert.equal(recoveryProvider.state.projects[0].id, 'restored');
    assert.deepStrictEqual(recoveryAuthStates, ['valid']);

    fetchImplementation = async () => ({
        ok: false, status: 302, statusText: 'Found',
        text: async () => 'Found. Redirecting to /login', json: async () => ({}),
        headers: { get: name => name.toLowerCase() === 'location' ? '/login' : null, raw: () => ({}) },
    });
    await recoveryProvider.refresh();
    assert.equal(recoveryProvider.state.status, 'not-logged-in',
        'a 302 to login must lead to authentication rather than leave a retry-only error');
    assert.match(recoveryProvider.state.message, /Re-authenticate/);
    assert.deepStrictEqual(recoveryAuthStates, ['valid', 'expired']);

    let selectedServerUrl = 'https://old.example';
    let finishOldRequest: ((response: typeof fetchResponse) => void) | undefined;
    let startedOldRequest: (() => void) | undefined;
    const oldRequestStarted = new Promise<void>(resolve => { startedOldRequest = resolve; });
    const switchingProvider = new ProjectsWebviewProvider('extension', {
        getDefaultServer: () => selectedServerUrl,
        getCredential: async (serverUrl: string) => ({ serverUrl, identity: { cookies: serverUrl, csrfToken: 'test' } }),
    }) as any;
    fetchImplementation = async url => {
        if (String(url).startsWith('https://old.example/')) {
            return new Promise(resolve => { finishOldRequest = resolve; startedOldRequest?.(); });
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ projects: [{ _id: 'new-server-project', name: 'New server project' }] }),
            json: async () => ({}), headers: { get: () => 'application/json', raw: () => ({}) },
        };
    };
    const oldRefresh = switchingProvider.refresh();
    await oldRequestStarted;
    selectedServerUrl = 'https://new.example';
    await switchingProvider.refresh();
    finishOldRequest?.({
        ok: false, status: 502,
        text: async () => gatewayPage, json: async () => ({}),
        headers: { get: () => 'text/html', raw: () => ({}) },
    });
    await oldRefresh;
    assert.equal(switchingProvider.state.status, 'ready');
    assert.equal(switchingProvider.state.projects[0].id, 'new-server-project',
        'an old server failure must not replace projects from the newly selected connection');



    resetMockWorkspace([workspaceRoot], [
        ['D:\\workspace', { type: 2 }],
        ['D:\\workspace\\.localleaf', { type: 2 }],
        ['D:\\workspace\\.localleaf\\settings.json', { type: 1, content: '{"projectId":42}' }],
    ]);
    assert.equal((await SettingsManager.inspectFolder(workspaceRoot)).kind, 'invalid-config');
    const invalidFolderProvider = new ProjectsWebviewProvider('extension', noCredentialManager) as any;
    await invalidFolderProvider.refresh();
    assert.equal(invalidFolderProvider.state.status, 'not-logged-in');
    assert.equal(invalidFolderProvider.state.workspaceKind, 'invalid-config');

    const virtualWorkspace: MockUri = {
        scheme: 'vscode-remote',
        path: '/workspace',
        fsPath: '',
        toString: () => 'vscode-remote://workspace',
    };
    resetMockWorkspace([virtualWorkspace]);
    assert.equal((await SettingsManager.inspectFolder(virtualWorkspace)).kind, 'unsupported');
    const incompatibleFolderProvider = new ProjectsWebviewProvider(
        'extension',
        noCredentialManager,
    ) as any;
    await incompatibleFolderProvider.refresh();
    assert.equal(incompatibleFolderProvider.state.status, 'incompatible-folder');

    resetMockWorkspace();
    const noFolderProvider = new ProjectsWebviewProvider('extension', noCredentialManager) as any;
    await noFolderProvider.refresh();
    assert.equal(noFolderProvider.state.status, 'no-folder');

    const {
        IgnoreParser,
        MAX_IGNORE_FILE_BYTES,
        MAX_IGNORE_PATTERNS,
        MAX_IGNORE_PATTERN_LENGTH,
    } = require(path.join('..', 'sync', 'ignoreParser')) as {
        IgnoreParser: { prototype: object };
        MAX_IGNORE_FILE_BYTES: number;
        MAX_IGNORE_PATTERNS: number;
        MAX_IGNORE_PATTERN_LENGTH: number;
    };
    resetMockWorkspace([workspaceRoot], [
        ['D:\\workspace', { type: 2 }],
        ['D:\\workspace\\.leafignore', { type: 1, content: 'x'.repeat(MAX_IGNORE_FILE_BYTES + 1) }],
    ]);
    const boundedIgnoreParser = Object.create(IgnoreParser.prototype) as any;
    boundedIgnoreParser.workspaceFolder = workspaceRoot;
    await assert.rejects(
        () => boundedIgnoreParser.load(),
        /exceeds the size limit/,
        'oversized ignore files must be rejected before parsing',
    );
    assert.throws(
        () => boundedIgnoreParser.parseIgnoreFile(
            new Array(MAX_IGNORE_PATTERNS + 1).fill('*.tmp').join('\n')
        ),
        /too many patterns/,
    );
    assert.throws(
        () => boundedIgnoreParser.parseIgnoreFile('x'.repeat(MAX_IGNORE_PATTERN_LENGTH + 1)),
        /invalid or oversized pattern/,
    );
    const ignoreParser = Object.create(IgnoreParser.prototype) as any;
    ignoreParser.patterns = ['$MAIN_TEX', '$MAIN_PDF', '*.aux'];
    ignoreParser.settings = {};
    ignoreParser.resolveVariables();
    assert.deepStrictEqual(
        ignoreParser.resolvedPatterns,
        ['*.aux'],
        'unresolved main-document variables must not silently target main.tex/main.pdf',
    );

    const vscodeIgnore = fs.readFileSync(path.join(__dirname, '..', '..', '.vscodeignore'), 'utf8');
    assert.match(vscodeIgnore, /^LOCAL_GUI_INTEGRATION_CHECKLIST\.md$/m,
        'the local integration checklist must never be packaged');
    assert.match(vscodeIgnore, /^local-pr3-artifacts\/\*\*$/m,
        'local PR artifacts must never be packaged');
    assert.match(vscodeIgnore, /^\.localleaf\/\*\*$/m,
        'workspace link metadata must never be packaged');
    assert.match(vscodeIgnore, /^\.tmp-\*\/\*\*$/m,
        'temporary build and verification tooling must never be packaged');
    assert.match(vscodeIgnore, /^\.leafignore$/m,
        'this checkout\'s local ignore rules must never be packaged');
    assert.match(vscodeIgnore, /^\.mailmap$/m,
        'repository-only author mappings must never be packaged');
    assert.match(vscodeIgnore, /^test\/\*\*$/m,
        'local end-to-end workspaces and personal documents must never be packaged');
    assert.match(vscodeIgnore, /^out\/\*\*$/m,
        'intermediate TypeScript output must not be packaged');
    assert.match(vscodeIgnore, /^node_modules\/\*\*$/m,
        'dependencies already included in the bundle must not be packaged separately');
    assert.match(vscodeIgnore, /^dist\/\*\*$/m,
        'the dist folder must default to excluded');
    assert.match(vscodeIgnore, /^!dist\/extension\.js$/m,
        'the production extension bundle must be explicitly included');
    ignoreParser.settings = { mainTex: 'thesis[1].tex', mainPdf: 'thesis[1].pdf' };
    ignoreParser.resolveVariables();
    assert.deepStrictEqual(
        ignoreParser.resolvedPatterns,
        ['thesis\\[1\\].tex', 'thesis\\[1\\].pdf', '*.aux'],
        'main-document names must be treated as literal ignore paths, not glob syntax',
    );

    resetMockWorkspace([workspaceRoot], [
        ['D:\\workspace', { type: 2 }],
        ['D:\\workspace\\.leafignore', { type: 1 | 64, content: '*.aux' }],
    ]);
    const transactionalIgnoreParser = Object.create(IgnoreParser.prototype) as any;
    transactionalIgnoreParser.workspaceFolder = workspaceRoot;
    transactionalIgnoreParser.patterns = ['*.aux'];
    transactionalIgnoreParser.settings = {};
    transactionalIgnoreParser.resolveVariables();
    await assert.rejects(
        () => transactionalIgnoreParser.addPattern('*.log'),
        /symbolic link/,
        'unsafe ignore-file writes must fail closed',
    );
    assert.deepStrictEqual(transactionalIgnoreParser.getPatterns(), ['*.aux'],
        'a failed ignore-file write must not mutate the active patterns');
    assert.deepStrictEqual(transactionalIgnoreParser.getResolvedPatterns(), ['*.aux'],
        'a failed ignore-file write must not mutate the resolved matcher state');

    const manifest = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'package.json'),
        'utf8',
    )) as {
        publisher: string;
        main: string;
        contributes?: {
            viewsContainers?: { activitybar?: Array<{ id?: string }> };
            views?: { localleaf?: Array<{ id?: string; type?: string }> };
        };
        capabilities?: { untrustedWorkspaces?: { supported?: boolean } };
    };
    assert.equal(manifest.publisher, 'victorstoica114');
    assert.equal(manifest.main, './dist/extension.js');
    assert.equal(manifest.contributes?.viewsContainers?.activitybar?.[0]?.id, 'localleaf');
    assert.deepStrictEqual(
        manifest.contributes?.views?.localleaf?.map(view => [view.id, view.type]),
        [
            ['localleaf.projectsView', 'webview'],
            ['localleaf.mainView', 'webview'],
        ],
    );
    assert.equal(
        manifest.capabilities?.untrustedWorkspaces?.supported,
        false,
        'LocalLeaf must stay disabled in untrusted workspaces because it writes remote content locally',
    );

    const bundlePath = path.join(__dirname, '..', '..', 'dist', 'extension.js');
    assert.ok(fs.statSync(bundlePath).size > 0, 'the extension bundle must be generated');
    const bundleSource = fs.readFileSync(bundlePath, 'utf8');
    assert.doesNotMatch(
        bundleSource,
        /\beval\(/,
        'the production bundle must not contain the legacy JSON eval fallback',
    );
    assert.doesNotMatch(
        bundleSource,
        /node-xmlhttprequest-(?:content|sync)/,
        'the production bundle must not contain legacy XHR temporary-file helpers',
    );
    verifyBundledLegacySocketClient();
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    assert.ok(
        !navigatorDescriptor || navigatorDescriptor.configurable,
        'the test runner must be able to emulate VS Code\'s guarded navigator global',
    );
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        get: () => {
            throw new Error('PendingMigrationError: navigator is guarded by VS Code');
        },
    });
    let bundle: { activate?: unknown; deactivate?: unknown };
    try {
        bundle = require(bundlePath) as { activate?: unknown; deactivate?: unknown };
    } finally {
        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
        } else {
            delete (globalThis as { navigator?: unknown }).navigator;
        }
    }
    assert.equal(typeof bundle.activate, 'function', 'the bundle must export activate');
    assert.equal(typeof bundle.deactivate, 'function', 'the bundle must export deactivate');

    assert.equal(readInstalledPackageVersion('form-data'), '4.0.6');
    assert.equal(readInstalledPackageVersion('minimatch'), '9.0.9');
    assert.equal(readInstalledPackageVersion('ws'), '5.2.7');
    assert.deepStrictEqual(readLockedPackageVersions('brace-expansion'), ['1.1.18', '2.1.4']);
    assert.deepStrictEqual(readLockedPackageVersions('minimatch'), ['3.1.5', '9.0.9']);
    assert.deepStrictEqual(readLockedPackageVersions('form-data'), ['4.0.6']);
    assert.deepStrictEqual(readLockedPackageVersions('ws'), ['5.2.7']);
    assert.equal(
        readInstalledPackageVersion(
            '@typescript-eslint',
            'typescript-estree',
            'node_modules',
            'minimatch',
        ),
        '9.0.9',
        'the development toolchain must not restore the vulnerable minimatch release',
    );

    const socketTransportSource = fs.readFileSync(
        path.join(
            __dirname,
            '..',
            '..',
            'node_modules',
            'socket.io-client',
            'lib',
            'transports',
            'websocket.js',
        ),
        'utf8',
    );
    assert.match(socketTransportSource, /require\('ws'\)/);
    assert.match(socketTransportSource, /headers:\s*extraHeaders\s*\|\|\s*\{\}/);
    assert.match(socketTransportSource, /maxPayload:\s*64\s*\*\s*1024\s*\*\s*1024/);
    assert.match(socketTransportSource, /maxBufferedChunks:\s*16\s*\*\s*1024/);
    assert.match(socketTransportSource, /\.onopen\s*=/);
    assert.match(socketTransportSource, /\.onmessage\s*=/);
    const socketUtilSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'node_modules', 'socket.io-client', 'lib', 'util.js'),
        'utf8',
    );
    assert.match(socketUtilSource, /util\.ua\.webkit\s*=\s*false/);
    assert.match(socketUtilSource, /util\.ua\.iDevice\s*=\s*false/);
    assert.doesNotMatch(socketUtilSource, /typeof navigator|navigator\.userAgent/);
    const socketLifecycleSource = fs.readFileSync(
        path.join(
            __dirname,
            '..',
            '..',
            'node_modules',
            'socket.io-client',
            'lib',
            'socket.js',
        ),
        'utf8',
    );
    assert.match(socketLifecycleSource, /this\.namespaces\[endpoint\]\.acks\s*=\s*\{\}/);
    assert.match(socketLifecycleSource, /this\.buffer\s*=\s*\[\]/);
    const legacySocketClient = require('socket.io-client') as any;
    const legacySocketManager = new legacySocketClient.Socket({
        'auto connect': false,
        reconnect: false,
    });
    const legacyCleanupNamespace = legacySocketManager.of('/cleanup-test');
    legacyCleanupNamespace.acks[1] = () => undefined;
    legacySocketManager.buffer = [{ sensitive: 'queued payload' }];
    legacySocketManager.onDisconnect('booted');
    assert.deepStrictEqual(Object.keys(legacyCleanupNamespace.acks), [],
        'legacy disconnects must release every pending ACK callback');
    assert.deepStrictEqual(legacySocketManager.buffer, [],
        'legacy disconnects must release queued payloads');
    const wsClientSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'node_modules', 'ws', 'lib', 'websocket.js'),
        'utf8',
    );
    assert.match(wsClientSource, /maxPayload:\s*100\s*\*\s*1024\s*\*\s*1024/);
    assert.match(wsClientSource, /head,\s*options\.maxPayload,/s);
    await verifyWebSocketCompatibility();
    await verifyHardenedXmlHttpRequest();
    const socketPatchSource = fs.readFileSync(
        path.join(__dirname, '..', '..',
            'patches',
            'socket.io-client+0.9.17-overleaf-5.patch',
        ),
        'utf8',
    );
    assert.match(socketPatchSource, /\+\s*util\.ua\.webkit\s*=\s*false/);
    assert.match(socketPatchSource, /\+\s*util\.ua\.iDevice\s*=\s*false/);
    assert.doesNotMatch(socketPatchSource, /\+.*module\.parent\.exports/);
    assert.match(socketPatchSource, /\+\s*io\.Transport\.websocket\s*=\s*require/);
    verifyBundledSocketClientCompatibility();
    const { runSocketTransportTests } = require('./socketTransportTest') as {
        runSocketTransportTests(): Promise<void>;
    };
    await runSocketTransportTests();
    const { runBrowserCookieLoginTests } = require(path.join(__dirname, 'browserCookieLoginTest.js')) as {
        runBrowserCookieLoginTests(): Promise<void>;
    };
    await runBrowserCookieLoginTests();
    const { runSocketIOProtocolTests } = require(path.join(__dirname, 'socketioTest.js')) as {
        runSocketIOProtocolTests(): Promise<void>;
    };
    await runSocketIOProtocolTests();
    const { runSyncRecoveryTests } = require('./syncRecoveryTest') as {
        runSyncRecoveryTests(): Promise<void>;
    };
    await runSyncRecoveryTests();

    Module._load = originalLoad;
    console.log('LocalLeaf synchronization and UI contract regression tests passed.');
}

runStandaloneTest(async () => {
    try { await run(); } finally { Module._load = originalLoad; }
});
