import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { removeStandaloneLatexComments } from '../utils/latexComments';
import {
    approveSyncTarget,
    createSyncTargetFingerprint,
    isSyncTargetApproved,
    revokeSyncTarget,
} from '../utils/syncAuthorization';
import {
    MAX_REMOTE_DOCUMENT_LINES,
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
            });
            client.onopen = () => client.send('localleaf-ws-smoke');
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
        return this;
    }

    removeAllListeners(): this {
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
    async stat(uri: MockUri | string): Promise<{ type: number }> {
        const entry = mockFileEntries.get(mockUriKey(uri));
        if (!entry) throw new MockFileSystemError('File not found', 'FileNotFound');
        return { type: entry.type };
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
            Uri: {
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
            }): void;
            joinProject(): Promise<unknown>;
            joinDoc(docId: string): Promise<{ lines: string[]; version: number }>;
            getConnectedUsers(): Promise<unknown[]>;
            disconnect(): void;
        };
    };
    useSocketIoMock = true;

    const { BaseAPI } = require(path.join('..', 'api', 'base')) as {
        BaseAPI: new (url: string) => {
            setIdentity(identity: unknown): void;
            dispose(): void;
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

    assert.throws(
        () => validateRemoteDocumentLines(new Array(MAX_REMOTE_DOCUMENT_LINES + 1).fill('')),
        /oversized document content/,
        'document line counts must be bounded even when every line is empty',
    );

    const api = new BaseAPI('https://overleaf.example/');
    api.setIdentity({ cookies: 'cookie', csrfToken: 'csrf' });
    const upload = await api.uploadFile(
        'project',
        'folder',
        'figure.pdf',
        Uint8Array.from([1, 2, 3])
    ) as {
        type: string;
        file?: { _id: string; _type: string; name: string };
    };
    assert.equal(upload.type, 'success');
    assert.deepStrictEqual(upload.file, {
        _id: 'binary-id-1',
        _type: 'file',
        name: 'figure.pdf',
    });

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
        text: async () => '',
    };
    assert.deepStrictEqual(
        await api.getDocContent('project', 'doc-id'),
        { type: 'success', lines: ['safe', 'document'] },
    );
    fetchResponse = {
        ok: true,
        status: 200,
        json: async () => ({ lines: ['safe', 123] }),
        text: async () => '',
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
    assert.equal(deniedDownload.authError, 'session_expired');
    assert.equal(deniedDownload.content, undefined, 'HTTP errors must never become empty successful files');
    fetchImplementation = async () => fetchResponse;
    api.dispose();

    const propagation = Object.create(SyncEngine.prototype) as any;
    propagation.fileCache = new Map();
    assert.equal(
        propagation.shouldPropagate('/chapter.tex', Uint8Array.from([1])),
        true
    );
    assert.equal(
        propagation.shouldPropagate('/chapter.tex', Uint8Array.from([2])),
        true,
        'different content inside the debounce window must not be discarded'
    );
    assert.equal(
        propagation.shouldPropagate('/chapter.tex', Uint8Array.from([2])),
        false,
        'identical content should still be treated as an echo'
    );
    assert.equal(
        propagation.shouldPropagate('/binary.dat', Uint8Array.from([0xff])),
        true,
    );
    assert.equal(
        propagation.shouldPropagate('/binary.dat', Uint8Array.from([0xfe])),
        true,
        'different invalid UTF-8 byte sequences must not collide in the synchronization cache',
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

    const textCreation = Object.create(SyncEngine.prototype) as any;
    textCreation.api = {
        addDoc: async () => ({
            type: 'success',
            doc: { _id: 'created-doc', _type: 'doc', name: 'new.tex' },
        }),
    };
    textCreation.fileTree = new Map();
    textCreation.fileTreeByPath = new Map();
    textCreation.baseContent = new Map();
    textCreation.socket = {};
    let pushedDocument: { id: string; path: string; content: Uint8Array } | undefined;
    textCreation.pushDocumentChanges = async (
        id: string,
        filePath: string,
        content: Uint8Array
    ) => {
        pushedDocument = { id, path: filePath, content };
        return true;
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

    const binaryReplacement = Object.create(SyncEngine.prototype) as any;
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
            replacementOperations.push(`upload:${name}`);
            return {
                type: 'success',
                file: { _id: 'new-binary-id', _type: 'file', name: 'figure.pdf' },
            };
        },
    };
    const oldBinary = {
        id: 'old-binary-id',
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
        'delete:old-binary-id',
    ]);

    const failedReplacement = Object.create(SyncEngine.prototype) as any;
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

    const folderRebase = Object.create(SyncEngine.prototype) as any;
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

    const subtreeRemoval = Object.create(SyncEngine.prototype) as any;
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
    subtreeRemoval.removeTrackedSubtree('/folder/');
    assert.equal(subtreeRemoval.fileTree.size, 0, 'folder removal must clear every descendant identity');
    assert.equal(subtreeRemoval.fileTreeByPath.size, 0);
    assert.equal(subtreeRemoval.baseContent.size, 0);
    assert.equal(subtreeRemoval.fileCache.size, 0);
    assert.equal(subtreeRemoval.joinedDocs.size, 0);

    const acknowledgement = Object.create(SyncEngine.prototype) as any;
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

    const localCreate = Object.create(SyncEngine.prototype) as any;
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

    const orderedRemoteEvents = Object.create(SyncEngine.prototype) as any;
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

    const ownDocumentEcho = Object.create(SyncEngine.prototype) as any;
    ownDocumentEcho.socket = { publicId: 'this-client' };
    ownDocumentEcho.suppressedRemoteDocumentUpdates = new Map();
    ownDocumentEcho.fileTree = new Map();
    await ownDocumentEcho.handleRemoteFileChanged({
        doc: 'doc',
        v: 1,
        op: [{ p: 0, i: 'content' }],
        meta: { source: 'this-client', ts: Date.now(), user_id: 'user' },
    });

    const remoteOt = Object.create(SyncEngine.prototype) as any;
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
        new TextDecoder().decode(remoteOt.baseContent.get('/chapter.tex')),
        'server!',
        'remote operations must be applied to the known server base, not an unsaved local edit',
    );

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

        const engine = Object.create(SyncEngine.prototype) as any;
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
        };
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
        'server!',
        'the server base must advance even while dirty local edits are retained',
    );
    assert.equal(
        skippedDirtyRemote.engine.shouldPropagate('/chapter.tex', new TextEncoder().encode('server')),
        false,
        'the cache must continue to represent disk after retaining a dirty editor',
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
        return true;
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

        const engine = Object.create(SyncEngine.prototype) as any;
        engine.disposed = false;
        engine.project = { name: 'Test project', rootFolder: [] };
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
        return true;
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
        'server!',
        'the remote base must advance when a full pull preserves newer editor text',
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
    const structuralEngine = Object.create(SyncEngine.prototype) as any;
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
    const reuploadEngine = Object.create(SyncEngine.prototype) as any;
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
    const remoteDownload = Object.create(SyncEngine.prototype) as any;
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
    assert.equal(socketLeaves, 1, 'a temporary Socket.IO read must release its document join');

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
    assert.equal(socketLeaves, 2, 'a failed temporary join must still attempt cleanup');

    remoteDownload.api.getDocContent = async () => ({ type: 'error', message: 'HTTP unavailable' });
    await assert.rejects(
        () => remoteDownload.getRemoteEntryContent(remoteEntry),
        /failed via Socket\.IO.*and HTTP/,
        'a pull must fail visibly when neither transport can download a document',
    );

    const watchFailure = Object.create(SyncEngine.prototype) as any;
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

    const floodedRemoteQueue = Object.create(SyncEngine.prototype) as any;
    floodedRemoteQueue.pendingRemoteEventCount = 10_000;
    floodedRemoteQueue.pendingRemoteEventCost = 0;
    floodedRemoteQueue.log = () => undefined;
    let floodedQueueStatus: string | undefined;
    floodedRemoteQueue.setStatus = (status: string) => { floodedQueueStatus = status; };
    let floodedSocketDisconnected = false;
    floodedRemoteQueue.socket = { disconnect: () => { floodedSocketDisconnected = true; } };
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

    const automaticSync = Object.create(SyncEngine.prototype) as any;
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
    const boundedLocalScan = Object.create(SyncEngine.prototype) as any;
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

    const protectedPaths = Object.create(SyncEngine.prototype) as any;
    protectedPaths.ignoreParser = { shouldIgnore: () => false };
    assert.equal(protectedPaths.shouldSync('/.git/config'), false);
    assert.equal(protectedPaths.shouldSync('/.vscode/settings.json'), false);
    assert.equal(protectedPaths.shouldSync('/.localleaf/settings.json'), false);
    assert.equal(protectedPaths.shouldSync('/chapter.tex'), true);

    const cancellableLock = Object.create(SyncEngine.prototype) as any;
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
    cancellableLock.joinedDocs = new Set();
    const pendingLock = cancellableLock.acquireLockWhenAvailable('/busy.tex');
    cancellableLock.disconnect();
    assert.equal(await pendingLock, false, 'disconnect must cancel lock waits immediately');

    const rootDeletion = Object.create(SyncEngine.prototype) as any;
    rootDeletion.suppressedRemoteDeletes = new Set();
    rootDeletion.fileTree = new Map([['root', { id: 'root', type: 'folder', path: '/' }]]);
    await assert.rejects(
        () => rootDeletion.handleRemoteFileRemoved('root'),
        /project root/,
    );

    const cleanup = Object.create(SyncEngine.prototype) as any;
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
    assert.deepStrictEqual(ignoredRemote, ['/thesis.aux']);
    const cleanupResult = await cleanup.deleteIgnoredRemoteFiles(ignoredRemote);
    assert.deepStrictEqual(cleanupResult, { deleted: 1, failed: [] });
    assert.deepStrictEqual(deleted, ['/thesis.aux']);
    assert.equal(cleanup.fileTreeByPath.has('/thesis.tex'), true);

    const selfHostedRefresh = Object.create(SyncEngine.prototype) as any;
    const liveEntry = {
        id: 'live-id',
        type: 'file',
        path: '/thesis.aux',
        name: 'thesis.aux',
    };
    selfHostedRefresh.settings = { getSettings: () => ({ projectId: 'project' }) };
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

    const unavailableRefresh = Object.create(SyncEngine.prototype) as any;
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
        await new Promise<void>(resolve => { finishStateBuild = resolve; });
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

    const accountSource = fs.readFileSync(path.join(viewsDirectory, 'accountPanel.js'), 'utf8');
    const cookieHandler = accountSource.indexOf("loginCookies.addEventListener('click'");
    const cookieClear = accountSource.indexOf("cookies.value = ''", cookieHandler);
    const cookiePost = accountSource.indexOf("vscode.postMessage({ type: 'loginCookies'", cookieHandler);
    assert.ok(cookieHandler >= 0 && cookieClear > cookieHandler && cookieClear < cookiePost,
        'session cookies must be removed from the DOM before the login message is posted');
    const { AccountPanel } = require(path.join('..', 'views', 'accountPanel')) as { AccountPanel: any };
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

    const extensionSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'extension.ts'),
        'utf8',
    );
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
    assert.match(extensionSource, /if \(await loginWithCookies[\s\S]*await reconnectAfterLogin\(\)/,
        'cancelling the HTTP warning must also skip reconnecting');
    assert.doesNotMatch(extensionSource, /serverUrl\.includes\(['"]overleaf\.com/,
        'official Overleaf detection must use the parsed hostname, not a substring');
    assert.match(extensionSource, /async function cmdRefreshCookie[\s\S]*loginWithCookies\(serverUrl, cookies\)/,
        'cookie refresh must use the same URL and HTTP safety policy as login');
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

    const { SettingsManager, isValidProjectSettings } = require(
        path.join('..', 'utils', 'settingsManager')
    ) as {
        SettingsManager: {
            clearCurrentWorkspaceFolder(): void;
            getInstance(uri: MockUri): {
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

    const { IgnoreParser } = require(path.join('..', 'sync', 'ignoreParser')) as {
        IgnoreParser: { prototype: object };
    };
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
    assert.match(vscodeIgnore, /^\.leafignore$/m,
        'this checkout\'s local ignore rules must never be packaged');
    assert.match(vscodeIgnore, /^\.mailmap$/m,
        'repository-only author mappings must never be packaged');
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
        /require\(["']child_process["']\)/,
        'the production bundle must not contain the legacy synchronous XHR helper',
    );
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
    const bundle = require(bundlePath) as { activate?: unknown; deactivate?: unknown };
    assert.equal(typeof bundle.activate, 'function', 'the bundle must export activate');
    assert.equal(typeof bundle.deactivate, 'function', 'the bundle must export deactivate');

    assert.equal(readInstalledPackageVersion('form-data'), '4.0.6');
    assert.equal(readInstalledPackageVersion('minimatch'), '9.0.9');
    assert.equal(readInstalledPackageVersion('ws'), '5.2.7');
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
    assert.match(socketTransportSource, /\.onopen\s*=/);
    assert.match(socketTransportSource, /\.onmessage\s*=/);
    await verifyWebSocketCompatibility();
    await verifyHardenedXmlHttpRequest();

    Module._load = originalLoad;
    console.log('LocalLeaf synchronization and UI contract regression tests passed.');
}

run().catch(error => {
    Module._load = originalLoad;
    console.error(error);
    process.exitCode = 1;
});
