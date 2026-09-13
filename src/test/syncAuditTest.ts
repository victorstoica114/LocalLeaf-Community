import { runStandaloneTest } from './standaloneRunner';
/** Regression tests for the seven 2026-09-06 audit findings. Runs in its own process. */
export {};
import { createTemporaryWorkspace, cleanTemporaryWorkspaces } from './temporaryWorkspace';
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');

const bytes = (value: string) => Buffer.from(value, 'utf8');
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const rootPath = 'D:\\localleaf-audit-memory';
const uri = (value: string) => ({
    scheme: 'file', authority: '', fsPath: path.win32.normalize(value),
    path: '/' + path.win32.normalize(value).replaceAll('\\', '/'),
    toString() { return 'file://' + this.path; },
});
const key = (value: ReturnType<typeof uri>) => path.win32.normalize(value.fsPath).replace(/\\+$/, '').toLowerCase();
let disk = new Map<string, { type: number; content?: Buffer }>();
let prompts: unknown[][] = [];
let promptChoice: string | undefined;
let promptHandler: (() => void) | undefined;
class FileSystemError extends Error {
    code = 'FileNotFound';
    constructor(message: string) { super(message); }
}
class EventEmitter {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
}
const memoryFs = {
    async stat(target: ReturnType<typeof uri>) {
        const entry = disk.get(key(target));
        if (!entry) throw new FileSystemError('File not found');
        return { type: entry.type, size: entry.content?.byteLength ?? 0 };
    },
    async readFile(target: ReturnType<typeof uri>) {
        const entry = disk.get(key(target));
        if (!entry || entry.type !== 1) throw new FileSystemError('File not found');
        return Buffer.from(entry.content!);
    },
    async writeFile(target: ReturnType<typeof uri>, content: Uint8Array) { disk.set(key(target), { type: 1, content: Buffer.from(content) }); },
    async createDirectory(target: ReturnType<typeof uri>) { disk.set(key(target), { type: 2 }); },
    async readDirectory(target: ReturnType<typeof uri>) {
        const parent = key(target);
        return [...disk].filter(([name]) => name !== parent && path.win32.dirname(name) === parent)
            .map(([name, entry]) => [path.win32.basename(name), entry.type]);
    },
    async delete(target: ReturnType<typeof uri>, options?: { recursive?: boolean; useTrash?: boolean }) {
        const name = key(target);
        if (!disk.has(name)) throw new FileSystemError('File not found');
        if (!options?.recursive && [...disk.keys()].some(candidate => candidate.startsWith(name + '\\'))) {
            throw new Error('Directory is not empty');
        }
        for (const candidate of [...disk.keys()]) {
            if (candidate === name || (options?.recursive && candidate.startsWith(name + '\\'))) {
                disk.delete(candidate);
            }
        }
    },
};
const vscode = {
    EventEmitter, FileSystemError, FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: { joinPath: (base: ReturnType<typeof uri>, ...parts: string[]) => uri(path.win32.join(base.fsPath, ...parts)) },
    workspace: { fs: memoryFs, textDocuments: [] as Array<{ uri: ReturnType<typeof uri>; isDirty: boolean }>,
        getConfiguration: () => ({ get: () => true }) },
    window: {
        async showWarningMessage(...args: unknown[]) { prompts.push(args); promptHandler?.(); return promptChoice; },
        async showInformationMessage(...args: unknown[]): Promise<string | undefined> { prompts.push(args); return undefined; },
    },
};
const originalLoad = Module._load;
Module._load = function(request: string, parent: unknown, isMain: boolean) {
    return request === 'vscode' ? vscode : originalLoad(request, parent, isMain);
};
const { SyncEngine } = require('../sync/syncEngine');
const { BaseAPI } = require('../api/base');
const { SocketIOAPI } = require('../api/socketio');
Module._load = originalLoad;
const createdEngines = new Set<any>();
const createdStores = new Set<any>();

function fixture(documentName = 'main.tex') {
    disk = new Map([[key(uri(rootPath)), { type: 2 }]]);
    prompts = [];
    promptChoice = undefined;
    promptHandler = undefined;
    vscode.workspace.textDocuments = [];
    const server = new Map([['doc', { text: 'A', version: 1 }]]);
    const subscriptions = new Set();
    const project: any = {
        _id: 'project', name: 'Audit fixture',
        rootFolder: [{ _id: 'root', name: '', docs: [{ _id: 'doc', name: documentName }], fileRefs: [], folders: [] }],
    };
    const settings = {
        getWorkspaceFolder: () => uri(rootPath),
        getSettings: () => ({ projectId: 'project', serverUrl: 'https://example.invalid', autoSync: true }),
        getFilePath: (relative: string) => uri(path.win32.join(rootPath, relative)),
        getRelativePath: (target: ReturnType<typeof uri>) => '/' + path.win32.relative(rootPath, target.fsPath).replaceAll('\\', '/'),
        async updateLastSynced() {},
    };
    let refreshCount = 0;
    const api = {
        dispose() {},
        async getDocContent(_projectId: string, id: string) { return { type: 'success', lines: server.get(id)!.text.split('\n') }; },
        async getProjectDetails() {
            refreshCount++;
            return { type: 'success', projectData: { projectId: 'project', rootFolder: project.rootFolder } };
        },
    };
    const socket = {
        isConnected: true,
        publicId: 'local-client',
        async reconnect() {
            socket.isConnected = true;
            subscriptions.clear();
            return project;
        },
        disconnect() { socket.isConnected = false; subscriptions.clear(); },
        resetConnection() { socket.isConnected = false; subscriptions.clear(); },
        async checkConnection() { if (!socket.isConnected) throw new Error('Disconnected'); },
        async joinDoc(id: string) {
            subscriptions.add(id);
            return { lines: server.get(id)!.text.split('\n'), version: server.get(id)!.version };
        },
        async leaveDoc(id: string) { subscriptions.delete(id); },
        async applyOtUpdate(id: string, update: any) {
            const doc = server.get(id)!;
            assert.equal(update.v, doc.version);
            for (const op of update.op) {
                if (op.d !== undefined) {
                    assert.equal(doc.text.slice(op.p, op.p + op.d.length), op.d);
                    doc.text = doc.text.slice(0, op.p) + doc.text.slice(op.p + op.d.length);
                }
                if (op.i !== undefined) doc.text = doc.text.slice(0, op.p) + op.i + doc.text.slice(op.p);
            }
            doc.version++;
        },
    };
    const engine: any = new SyncEngine(api, settings);
    createdEngines.add(engine);
    const scheduled: Array<() => Promise<void>> = [];
    engine.scheduleOperation = (operation: () => Promise<void>) => scheduled.push(operation);
    const flushScheduled = async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        for (let count = 0; scheduled.length; count++) {
            assert.ok(count < 20, 'background work must converge');
            await scheduled.shift()!();
        }
    };
    engine.project = project;
    engine.buildFileTree(project);
    engine.socket = socket;
    const put = (relative: string, text: string) => disk.set(key(settings.getFilePath(relative)), { type: 1, content: bytes(text) });
    const read = (relative: string) => disk.get(key(settings.getFilePath(relative)))?.content?.toString('utf8');
    const baseline = (relative: string, text: string) => {
        put(relative, text);
        engine.setBaseContent(relative, bytes(text));
        engine.fileCache.set(relative, hash(bytes(text)));
    };
    baseline('/' + documentName, 'A');
    engine.setDocumentSnapshot('doc', { content: bytes('A'), version: 1 });
    return { engine, server, project, settings, api, socket, subscriptions, put, read, baseline, scheduled, flushScheduled, refreshCount: () => refreshCount };
}

const remoteUpdate = (version: number, position: number, insert: string) => ({
    doc: 'doc', v: version, op: [{ p: position, i: insert }], meta: { source: 'collaborator' },
});

async function testVersionedSnapshots(): Promise<void> {
    const f = fixture();
    f.engine.askConflictResolution = async () => 'useRemote';
    const join = f.socket.joinDoc.bind(f.socket);
    f.socket.joinDoc = async id => {
        f.server.set('doc', { text: 'Ax', version: 2 });
        f.engine.enqueueRemoteEvent(() => f.engine.handleRemoteFileChanged(remoteUpdate(1, 1, 'x')));
        return join(id);
    };
    await f.engine.pullAll();
    await f.engine.remoteEventQueue;
    assert.equal(f.read('/main.tex'), 'Ax', 'F1: the snapshot already contains the queued insertion');
    f.socket.joinDoc = join;
    await f.engine.handleRemoteFileChanged(remoteUpdate(1, 1, 'x'));
    assert.equal(f.read('/main.tex'), 'Ax', 'duplicate versions must be ignored');
    f.server.set('doc', { text: 'Axy', version: 3 });
    await f.engine.handleRemoteFileChanged(remoteUpdate(2, 2, 'y'));
    assert.equal(f.read('/main.tex'), 'Axy', 'the next contiguous version must still apply');
    f.server.set('doc', { text: 'Axyz!', version: 5 });
    await f.engine.handleRemoteFileChanged(remoteUpdate(4, 4, '!'));
    assert.equal(f.read('/main.tex'), 'Axyz!', 'a version gap must recover the authoritative snapshot');
    await f.engine.handleRemoteFileChanged(remoteUpdate(3, 3, 'z'));
    assert.equal(f.read('/main.tex'), 'Axyz!', 'late events must not be replayed after recovery');

    const skipped = fixture();
    skipped.put('/main.tex', 'local draft');
    skipped.server.set('doc', { text: 'Ax', version: 2 });
    skipped.engine.askConflictResolution = async () => 'skip';
    await skipped.engine.pullAll();
    await skipped.engine.handleRemoteFileChanged(remoteUpdate(1, 1, 'x'));
    assert.equal(skipped.read('/main.tex'), 'local draft');
    skipped.server.set('doc', { text: 'Axy', version: 3 });
    await skipped.engine.handleRemoteFileChanged(remoteUpdate(2, 2, 'y'));
    assert.equal(skipped.read('/main.tex'), 'local draft');
    assert.equal(Buffer.from(skipped.engine.documentSnapshots.get('doc').content).toString(), 'Axy',
        'a skipped file still needs the correct server snapshot for later operations');
    assert.equal(Buffer.from(skipped.engine.baseContent.get('/main.tex')).toString(), 'A',
        'skipping a remote edit must not advance the common baseline');
    skipped.put('/main.tex', 'a later local draft');
    let laterConflicts = 0;
    skipped.engine.askConflictResolution = async () => { laterConflicts++; return 'skip'; };
    await skipped.engine.handleLocalFileChange(skipped.settings.getFilePath('/main.tex'));
    assert.equal(laterConflicts, 1, 'a later save must not silently overwrite a previously skipped remote edit');
    assert.equal(skipped.server.get('doc')!.text, 'Axy');

    const http = fixture();
    http.engine.documentSnapshots.set('doc', { content: bytes('A') });
    http.server.set('doc', { text: 'Ax', version: 2 });
    await http.engine.handleRemoteFileChanged(remoteUpdate(1, 1, 'x'));
    assert.equal(http.read('/main.tex'), 'Ax', 'an unversioned base must be refreshed');

    const acknowledgement = fixture();
    acknowledgement.server.set('doc', { text: 'Ax', version: 2 });
    await acknowledgement.engine.handleRemoteFileChanged({ doc: 'doc', v: 1 });
    assert.equal(acknowledgement.read('/main.tex'), 'Ax',
        'a delayed sender acknowledgement without operations must recover the committed content');

    const evicted = fixture();
    evicted.engine.maxRetainedDocumentBytes = 2;
    evicted.engine.setDocumentSnapshot('another-doc', { content: bytes('XX'), version: 1 });
    assert.equal(evicted.engine.documentSnapshots.has('doc'), false,
        'versioned snapshots must remain bounded in memory');
    assert.equal(evicted.engine.retainedSnapshotBytes, 2);
    evicted.server.set('doc', { text: 'Ax', version: 2 });
    await evicted.engine.handleRemoteFileChanged(remoteUpdate(1, 1, 'x'));
    assert.equal(evicted.read('/main.tex'), 'Ax', 'an evicted snapshot must recover before applying an event');
    assert.ok(evicted.engine.retainedSnapshotBytes <= 2);
}

async function testAutomaticConflicts(): Promise<void> {
    for (const choice of [undefined, 'Remote', 'Local']) {
        const f = fixture();
        f.put('/main.tex', 'A-local');
        f.server.set('doc', { text: 'A-remote', version: 2 });
        promptChoice = choice;
        // A prior bulk choice must not authorize a future automatic overwrite.
        f.engine.applyToAll = true;
        f.engine.conflictResolution = 'useLocal';
        await f.engine.handleLocalFileChange(f.settings.getFilePath('/main.tex'));
        await f.flushScheduled();
        assert.equal(prompts.length, 1, 'F2: concurrent changes require a conflict decision');
        assert.equal(f.server.get('doc')!.text, choice === 'Local' ? 'A-local' : 'A-remote');
        assert.equal(f.read('/main.tex'), choice === 'Remote' ? 'A-remote' : 'A-local');
    }
    const ordinary = fixture();
    ordinary.put('/main.tex', 'A-local');
    await ordinary.engine.handleLocalFileChange(ordinary.settings.getFilePath('/main.tex'));
    assert.equal(ordinary.server.get('doc')!.text, 'A-local');
    assert.equal(prompts.length, 0, 'an ordinary save should upload without prompting');

    const changedWhileAsking = fixture();
    changedWhileAsking.put('/main.tex', 'draft');
    changedWhileAsking.server.set('doc', { text: 'remote draft', version: 2 });
    promptChoice = 'Remote';
    promptHandler = () => changedWhileAsking.put('/main.tex', 'newer draft');
    await changedWhileAsking.engine.handleLocalFileChange(changedWhileAsking.settings.getFilePath('/main.tex'));
    assert.equal(changedWhileAsking.read('/main.tex'), 'newer draft');
    assert.equal(changedWhileAsking.server.get('doc')!.text, 'remote draft');

    const remoteChangedWhileAsking = fixture();
    remoteChangedWhileAsking.put('/main.tex', 'draft');
    remoteChangedWhileAsking.server.set('doc', { text: 'remote draft', version: 2 });
    promptChoice = 'Local';
    promptHandler = () => remoteChangedWhileAsking.server.set('doc', { text: 'new remote work', version: 3 });
    await suppressExpectedError(() => remoteChangedWhileAsking.engine.handleLocalFileChange(
        remoteChangedWhileAsking.settings.getFilePath('/main.tex')));
    assert.equal(remoteChangedWhileAsking.server.get('doc')!.text, 'new remote work');
    assert.equal(remoteChangedWhileAsking.engine.status, 'error');
}

function deletionFixture() {
    const f = fixture();
    f.project.rootFolder[0].folders.push({
        _id: 'folder', name: 'chapter', fileRefs: [], folders: [], docs: [
            { _id: 'changed-doc', name: 'chapter.tex' }, { _id: 'safe-doc', name: 'safe.tex' },
        ],
    });
    f.engine.buildFileTree(f.project);
    disk.set(key(f.settings.getFilePath('/chapter/')), { type: 2 });
    f.baseline('/chapter/chapter.tex', 'synced');
    f.baseline('/chapter/safe.tex', 'synced and unchanged');
    f.put('/chapter/chapter.tex', 'unsynchronized local work');
    f.put('/chapter/private-notes.txt', 'only local');
    f.put('/chapter/generated.aux', 'ignored file');
    f.engine.ignoreParser.shouldIgnore = (relative: string) => relative.endsWith('.aux') || relative.startsWith('/.ignored/');
    return f;
}

async function testSafeRemoteDeletion(): Promise<void> {
    for (const choice of [undefined, 'Delete Modified Copies']) {
        const f = deletionFixture();
        promptChoice = choice;
        await f.engine.handleRemoteFileRemoved('folder');
        await f.flushScheduled();
        assert.equal(f.read('/chapter/chapter.tex'), choice ? undefined : 'unsynchronized local work');
        assert.equal(f.read('/chapter/private-notes.txt'), 'only local', 'F3: never delete local-only files');
        assert.equal(f.read('/chapter/generated.aux'), 'ignored file', 'F3: never delete excluded descendants');
        assert.equal(f.read('/chapter/safe.tex'), undefined, 'unchanged synchronized copies can be removed');
        assert.equal(f.engine.fileTree.has('folder'), false, 'retained files must not keep stale remote identities');
    }
    const race = deletionFixture();
    promptChoice = 'Delete Modified Copies';
    promptHandler = () => race.put('/chapter/chapter.tex', 'saved during the prompt');
    await race.engine.handleRemoteFileRemoved('folder');
    await race.flushScheduled();
    assert.equal(race.read('/chapter/chapter.tex'), 'saved during the prompt');

    const dirty = fixture();
    vscode.workspace.textDocuments.push({ uri: dirty.settings.getFilePath('/main.tex'), isDirty: true });
    await dirty.engine.handleRemoteFileRemoved('doc');
    assert.equal(dirty.read('/main.tex'), 'A', 'an unsaved editor buffer must retain its disk file');

    const clean = fixture();
    await clean.engine.handleRemoteFileRemoved('doc');
    assert.equal(clean.read('/main.tex'), undefined, 'ordinary remote deletion still propagates');
    assert.equal(clean.engine.documentSnapshots.has('doc'), false);

    for (const operation of ['rename', 'move']) {
        const f = deletionFixture();
        if (operation === 'rename') {
            await f.engine.handleRemoteFileRenamed('folder', '.ignored');
        } else {
            const parent = { id: 'ignored', type: 'folder', path: '/.ignored/', name: '.ignored' };
            f.engine.fileTree.set(parent.id, parent);
            f.engine.fileTreeByPath.set(parent.path, parent);
            await f.engine.handleRemoteFileMoved('folder', parent.id);
        }
        assert.equal(f.read('/chapter/private-notes.txt'), 'only local', `${operation} into an excluded path must preserve local-only files`);
        assert.equal(f.read('/chapter/chapter.tex'), 'unsynchronized local work');
        await f.flushScheduled();
        assert.equal(f.engine.status, 'idle');
    }
}

async function testPullSubscriptionsAndTree(): Promise<void> {
    const f = fixture();
    await f.engine.joinAllDocsForWatching();
    await f.engine.pullAll();
    await f.engine.pullAll();
    assert(f.subscriptions.has('doc'), 'F4: manual pulls must keep the server subscription');
    assert(f.engine.joinedDocs.has('doc'));
    f.server.set('doc', { text: 'Ax', version: 2 });
    await f.engine.handleRemoteFileChanged(remoteUpdate(1, 1, 'x'));
    assert.equal(f.read('/main.tex'), 'Ax', 'incoming changes still work after repeated pulls');

    const http = fixture();
    http.engine.socket = undefined;
    http.project.rootFolder[0].docs.push({ _id: 'new-doc', name: 'new.tex' });
    http.server.set('new-doc', { text: 'new remote content', version: 1 });
    await http.engine.pullAll();
    assert.equal(http.refreshCount(), 1, 'F5: HTTP pull must fetch the current tree');
    assert.equal(http.read('/new.tex'), 'new remote content');
    http.project.rootFolder[0].docs = http.project.rootFolder[0].docs.filter((doc: any) => doc._id !== 'new-doc');
    let orphaned: string[] = [];
    http.engine.handleOrphanedLocalFiles = async (paths: string[]) => { orphaned = paths; };
    await http.engine.pullAll();
    assert.deepEqual(orphaned, [], 'unchanged local copies can follow an authoritative remote deletion');
    assert.equal(http.read('/new.tex'), undefined, 'the common baseline authorizes deleting the unchanged local copy');

    const unavailable = fixture();
    unavailable.engine.api = { getProjectDetails: async () => ({ type: 'success', projectData: {} }) };
    await unavailable.engine.pullAll(); // Live socket tree remains usable on older servers.
    unavailable.socket.isConnected = false;
    await assert.rejects(() => unavailable.engine.refreshProjectFileTree(), /connection was lost.*Retry sync/,
        'a lost socket must report a reconnection problem instead of missing server metadata');
    unavailable.engine.socket = undefined;
    await assert.rejects(() => unavailable.engine.pullAll(), /no folder tree/,
        'an HTTP session cannot claim success using an unrefreshable tree');

    const refreshed = fixture();
    refreshed.engine.api = { ...refreshed.api, getProjectDetails: async () => ({ type: 'success', projectData: {} }) };
    await refreshed.engine.joinAllDocsForWatching();
    (refreshed.socket as any).refreshProject = async () => {
        refreshed.server.set('doc', { text: 'Edited during tree refresh', version: 2 });
        return refreshed.project;
    };
    await refreshed.engine.refreshProjectFileTree();
    assert.equal(refreshed.engine.joinedDocs.has('doc'), true, 'isolated tree snapshots must preserve the primary document rooms');
    refreshed.engine.lastFocusReconciliation = 0;
    await refreshed.engine.reconcileOnWindowFocus();
    assert(refreshed.subscriptions.has('doc'), 'focus catch-up keeps document subscriptions active');
    assert.equal(refreshed.read('/main.tex'), 'Edited during tree refresh', 'edits missed during a tree refresh must also be applied');
    refreshed.server.set('doc', { text: 'Edited during tree refresh!', version: 3 });
    await refreshed.engine.handleRemoteFileChanged(remoteUpdate(2, 'Edited during tree refresh'.length, '!'));
    assert.equal(refreshed.read('/main.tex'), 'Edited during tree refresh!', 'later live events still converge');
    refreshed.engine.disconnect();
}

async function suppressExpectedError(operation: () => Promise<void>): Promise<void> {
    const original = console.error;
    console.error = () => {};
    try { await operation(); } finally { console.error = original; }
}

async function testAutomaticPullRecovery(): Promise<void> {
    const f = fixture();
    const join = f.socket.joinDoc.bind(f.socket);
    let reads = 0;
    let reconnects = 0;
    let oldEventStarted = false;
    f.engine.api = {
        ...f.api,
        getProjectDetails: async () => ({ type: 'success', projectData: {} }),
        getDocContent: async () => ({ type: 'error', message: 'HTTP 404' }),
    };
    f.put('/main.tex', 'local draft');
    f.engine.askConflictResolution = async () => 'skip';
    f.server.set('doc', { text: 'remote draft', version: 2 });
    f.socket.joinDoc = async id => {
        if (++reads === 1) {
            f.engine.enqueueRemoteEvent(async (isCurrent: () => boolean) => {
                oldEventStarted = true;
                await f.engine.handleRemoteFileRemoved('doc', isCurrent);
            });
            // Let the obsolete event start waiting for the bulk pull's lock.
            await new Promise(resolve => setImmediate(resolve));
            assert(oldEventStarted);
            f.socket.isConnected = false;
            throw new Error('Socket event "joinDoc" timed out');
        }
        return join(id);
    };
    f.socket.reconnect = async () => {
        reconnects++;
        f.socket.isConnected = true;
        assert.equal(Buffer.from(f.engine.baseContent.get('/main.tex')).toString(), 'A',
            'recovery must retain the common baseline used to protect local changes');
        f.project.rootFolder[0].docs.push({ _id: 'new-doc', name: 'new.tex' });
        f.server.set('new-doc', { text: 'added while disconnected', version: 1 });
        return f.project;
    };
    const pull = f.engine.pullAll();
    assert.equal(f.engine.pullAll(), pull, 'concurrent pulls must share automatic recovery');
    await pull;
    await f.engine.remoteEventQueue;
    assert.equal(reconnects, 1, 'an interrupted read must reconnect without a user command');
    assert.equal(reads, 3, 'resume using the new tree, including files added while disconnected');
    assert.equal(f.read('/main.tex'), 'local draft', 'recovery must preserve unsynchronized local edits');
    assert.equal(Buffer.from(f.engine.baseContent.get('/main.tex')).toString(), 'A');
    assert.equal(f.read('/new.tex'), 'added while disconnected');
    assert(f.engine.fileTree.has('doc'), 'events waiting on a lock from the old connection must be discarded');
    assert(f.subscriptions.has('doc') && f.subscriptions.has('new-doc'));
    assert.equal(f.engine.status, 'idle');
    assert.equal(prompts.length, 0, 'transport recovery must not require a Retry prompt');

    const fallback = fixture();
    const fallbackJoin = fallback.socket.joinDoc.bind(fallback.socket);
    let fallbackReads = 0;
    let fallbackReconnects = 0;
    fallback.socket.joinDoc = async id => {
        if (++fallbackReads === 1) {
            fallback.socket.isConnected = false;
            throw new Error('Socket disconnected');
        }
        return fallbackJoin(id);
    };
    fallback.socket.reconnect = async () => {
        fallbackReconnects++;
        fallback.socket.isConnected = true;
        return fallback.project;
    };
    fallback.engine.waitForRetry = async () => true;
    await fallback.engine.pullAll();
    assert.equal(fallbackReconnects, 1, 'a successful HTTP fallback must still restore live synchronization');
    assert(fallback.subscriptions.has('doc'));

    const stalled = fixture();
    let stalledReads = 0;
    let stalledReconnects = 0;
    stalled.engine.waitForRetry = async () => true;
    stalled.engine.api.getDocContent = async () => ({ type: 'error', message: 'HTTP 404' });
    stalled.socket.joinDoc = async () => {
        stalledReads++;
        stalled.socket.isConnected = false;
        throw new Error('Socket event "joinDoc" timed out');
    };
    stalled.socket.reconnect = async () => {
        stalledReconnects++;
        stalled.socket.isConnected = true;
        return stalled.project;
    };
    await assert.rejects(stalled.engine.pullAll(), /joinDoc.*timed out/);
    assert.equal(stalledReads, 3, 'a persistent failure must stop after the initial read and two retries');
    assert.equal(stalledReconnects, 2);
    assert.equal(stalled.engine.status, 'error');
    assert.equal(stalled.read('/main.tex'), 'A');

    const idle = fixture();
    idle.socket.isConnected = false;
    const scheduled: Array<() => Promise<void>> = [];
    idle.engine.scheduleOperation = (operation: () => Promise<void>) => scheduled.push(operation);
    idle.engine.scheduleAutomaticRecovery();
    idle.engine.scheduleAutomaticRecovery();
    assert.equal(scheduled.length, 1, 'idle disconnection notifications must coalesce');
    await scheduled[0]();
    assert(idle.socket.isConnected);
    assert(idle.subscriptions.has('doc'));
    assert.equal(idle.engine.status, 'idle');

    const cancelled = fixture();
    let cancellationReconnects = 0;
    cancelled.socket.joinDoc = async () => {
        cancelled.socket.isConnected = false;
        throw new Error('Socket disconnected');
    };
    cancelled.engine.api.getDocContent = async () => ({ type: 'error', message: 'HTTP 404' });
    cancelled.socket.reconnect = async () => { cancellationReconnects++; return cancelled.project; };
    const wait = cancelled.engine.waitForRetry.bind(cancelled.engine);
    cancelled.engine.waitForRetry = (delay: number) => {
        const pending = wait(delay);
        if (delay === 1000) setImmediate(() => cancelled.engine.disconnect());
        return pending;
    };
    await assert.rejects(cancelled.engine.pullAll(), /sync session was closed/);
    assert.equal(cancellationReconnects, 0, 'closing or switching the workspace must cancel delayed recovery');
    assert.equal(cancelled.read('/main.tex'), 'A');

    const expired = fixture();
    let authReconnects = 0;
    expired.socket.joinDoc = async () => { expired.socket.isConnected = false; throw new Error('Session expired'); };
    expired.socket.reconnect = async () => { authReconnects++; return expired.project; };
    await assert.rejects(expired.engine.pullAll(), /Session expired/);
    assert.equal(authReconnects, 0, 'expired sessions need login, not automatic retries');
}

async function testLargeTextFiles(): Promise<void> {
    const largeText = 'sample,value\r\n' + '123,456\r\n'.repeat(350_000);
    const setup = () => {
        const f = fixture('samples.csv');
        const files = new Map<string, Buffer>();
        let uploads = 0;
        let otWrites = 0;
        let failUpload = false;
        f.socket.applyOtUpdate = async () => {
            otWrites++;
            throw new Error('Update takes doc over max doc size');
        };
        f.engine.api = {
            ...f.api,
            async renameEntity(_project: string, type: string, id: string, name: string) {
                const entities = type === 'doc' ? f.project.rootFolder[0].docs : f.project.rootFolder[0].fileRefs;
                entities.find((entity: any) => entity._id === id).name = name;
                return { type: 'success' };
            },
            async uploadFile(_project: string, parent: string, name: string, content: Uint8Array) {
                assert.equal(parent, 'root');
                if (failUpload) return { type: 'error', message: 'Upload unavailable' };
                const id = 'file-' + ++uploads;
                files.set(id, Buffer.from(content));
                f.project.rootFolder[0].fileRefs.push({ _id: id, name });
                return { type: 'success', file: { _id: id, _type: 'file', name } };
            },
            async deleteEntity(_project: string, type: string, id: string) {
                assert(uploads > 0, 'keep the original until its replacement is uploaded');
                const list = type === 'doc' ? 'docs' : 'fileRefs';
                f.project.rootFolder[0][list] = f.project.rootFolder[0][list].filter((entity: any) => entity._id !== id);
                return { type: 'success' };
            },
            async getFile(_project: string, id: string) {
                return { type: 'success', content: files.get(id) };
            },
        };
        return { ...f, files, uploads: () => uploads, otWrites: () => otWrites,
            failUpload: () => { failUpload = true; } };
    };

    const updated = setup();
    updated.put('/samples.csv', largeText);
    await updated.engine.handleLocalFileChange(updated.settings.getFilePath('/samples.csv'));
    assert.equal(updated.otWrites(), 0, 'a CSV over 2 MiB must not enter the server document updater');
    assert.equal(updated.uploads(), 1);
    assert.equal(updated.read('/samples.csv'), largeText, 'preserve all local bytes and Windows line endings');
    assert.equal(updated.files.get('file-1')!.toString(), largeText);
    assert.equal(updated.engine.fileTreeByPath.get('/samples.csv').type, 'file');
    assert.equal(updated.engine.joinedDocs.has('doc'), false);
    assert.equal(updated.engine.documentSnapshots.has('doc'), false);
    assert(updated.socket.isConnected);
    await updated.engine.handleLocalFileChange(updated.settings.getFilePath('/samples.csv'));
    await updated.engine.pullAll();
    assert.equal(updated.uploads(), 1, 'the next save and pull must recognize the uploaded file');
    assert.equal(updated.engine.status, 'idle');

    const bulk = setup();
    bulk.put('/samples.csv', largeText);
    bulk.engine.askConflictResolution = async () => 'useLocal';
    await bulk.engine.pullAll();
    assert.equal(bulk.otWrites(), 0, 'choosing Local during a pull must also support large documents');
    assert.equal(bulk.uploads(), 1);
    assert.equal(bulk.read('/samples.csv'), largeText);
    assert.equal(bulk.engine.status, 'idle');

    const newFile = setup();
    newFile.put('/new.csv', largeText);
    await newFile.engine.uploadLocalFile('/new.csv');
    assert.equal(newFile.otWrites(), 0);
    assert.equal(newFile.uploads(), 1, 'new large CSV files must use multipart upload directly');
    assert.equal(newFile.engine.fileTreeByPath.get('/new.csv').type, 'file');
    newFile.put('/watched.csv', largeText);
    await newFile.engine.handleLocalFileCreate(newFile.settings.getFilePath('/watched.csv'));
    assert.equal(newFile.uploads(), 2, 'filesystem-created large CSV files need the same upload path');

    const failed = setup();
    failed.put('/samples.csv', largeText);
    failed.failUpload();
    await suppressExpectedError(() => failed.engine.handleLocalFileChange(failed.settings.getFilePath('/samples.csv')));
    assert.equal(failed.engine.fileTreeByPath.get('/samples.csv').id, 'doc');
    assert.equal(failed.project.rootFolder[0].docs[0].name, 'samples.csv');
    assert.equal(failed.server.get('doc')!.text, 'A');
    assert.equal(failed.read('/samples.csv'), largeText, 'an unsuccessful conversion must retain both versions');
    assert.equal(failed.engine.fileCache.get('/samples.csv'), hash(bytes('A')));
    assert.equal(failed.engine.status, 'error');

    const conflict = setup();
    conflict.put('/samples.csv', largeText);
    conflict.server.set('doc', { text: 'collaborator edit', version: 2 });
    conflict.engine.askConflictResolution = async () => 'skip';
    await conflict.engine.handleLocalFileChange(conflict.settings.getFilePath('/samples.csv'));
    assert.equal(conflict.uploads(), 0, 'large-file conversion must respect existing conflict decisions');
    assert.equal(conflict.server.get('doc')!.text, 'collaborator edit');

    const main = setup();
    main.project.rootDoc_id = 'doc';
    main.put('/samples.csv', largeText);
    await suppressExpectedError(() => main.engine.handleLocalFileChange(main.settings.getFilePath('/samples.csv')));
    assert.equal(main.uploads(), 0, 'never silently convert the compilation root into an attachment');
    assert.equal(main.engine.fileTreeByPath.get('/samples.csv').id, 'doc');
}

async function testIgnoredFoldersAndRemoteCleanup(): Promise<void> {
    const setup = () => {
        const f = fixture();
        f.project.rootDoc_id = 'doc';
        f.put('/.leafignore', '/analysis/\n/scripts/\n__pycache__/\n');
        f.project.rootFolder[0].folders.push({ _id: 'analysis', name: 'analysis', docs: [], fileRefs: [], folders: [
            { _id: 'raw', name: 'raw_data', docs: [{ _id: 'data', name: 'data.csv' }], fileRefs: [], folders: [] },
        ] });
        f.project.rootFolder[0].docs.push({ _id: 'sample', name: 'samples.csv' });
        const deleted: string[] = [];
        f.engine.api.deleteEntity = async (_project: string, _type: string, id: string) => {
            deleted.push(id);
            return { type: 'success' };
        };
        return { ...f, deleted };
    };

    const f = setup();
    await f.engine.ignoreParser.load();
    assert(f.engine.ignoreParser.shouldIgnore('/analysis/raw_data/data.csv'),
        'anchored directory rules must exclude descendants visited directly by socket events and pulls');
    assert(f.engine.ignoreParser.shouldIgnore('/analysis/'));
    assert(f.engine.ignoreParser.shouldIgnore('/scripts/tool.py'));
    assert(f.engine.ignoreParser.shouldIgnore('/nested/__pycache__/compiled.pyc'));
    assert.equal(f.engine.ignoreParser.shouldIgnore('/other/analysis/data.csv'), false);
    assert.equal(f.engine.ignoreParser.shouldIgnore('/analysis-notes.tex'), false);
    f.put('/analysis/local.txt', 'keep local analysis');
    f.engine.api.uploadFile = async () => { throw new Error('Ignored content must never be uploaded'); };
    await f.engine.handleLocalFileCreate(f.settings.getFilePath('/analysis/local.txt'));
    assert.equal(f.engine.status, 'disconnected', 'ignored file events must not start a transfer');

    const candidates = await f.engine.getRemoteCleanupCandidates();
    assert.deepEqual(candidates.map((candidate: any) => [candidate.path, candidate.reason]), [
        ['/analysis/', 'ignored'], ['/samples.csv', 'missing-local'],
    ], 'preview the ignored folder as one target and the root-only sample separately');
    const result = await f.engine.deleteRemoteCleanupCandidates(candidates);
    assert.deepEqual(result, { deleted: 2, skipped: 0, failed: [] });
    assert.deepEqual(f.deleted, ['analysis', 'sample'], 'delete an ignored subtree with one folder request');
    assert.equal(f.read('/analysis/local.txt'), 'keep local analysis', 'remote cleanup must preserve local ignored data');
    assert.equal(f.read('/main.tex'), 'A');
    assert.equal(f.engine.fileTreeByPath.has('/analysis/raw_data/data.csv'), false);
    assert.equal(f.engine.fileTreeByPath.has('/analysis/'), false);
    assert.equal(f.engine.fileTreeByPath.has('/samples.csv'), false);

    const exception = setup();
    exception.put('/.leafignore', '/analysis/\n!/analysis/raw_data/data.csv\n');
    assert.deepEqual(await exception.engine.getIgnoredRemoteFiles(), [],
        'a folder containing an explicitly included file must never be deleted recursively');

    const changedRules = setup();
    const oldIgnored = (await changedRules.engine.getRemoteCleanupCandidates()).filter((candidate: any) => candidate.reason === 'ignored');
    changedRules.put('/.leafignore', '# no exclusions now\n');
    assert.equal((await changedRules.engine.deleteRemoteCleanupCandidates(oldIgnored)).skipped, 1);
    assert.deepEqual(changedRules.deleted, []);

    const replaced = setup();
    const oldMissing = (await replaced.engine.getRemoteCleanupCandidates()).filter((candidate: any) => candidate.reason === 'missing-local');
    replaced.project.rootFolder[0].docs.find((doc: any) => doc._id === 'sample')._id = 'replacement';
    assert.equal((await replaced.engine.deleteRemoteCleanupCandidates(oldMissing)).skipped, 1,
        'a new remote file at the same path must not inherit approval for the old identity');
    assert.deepEqual(replaced.deleted, []);

    const appeared = setup();
    const selectedMissing = (await appeared.engine.getRemoteCleanupCandidates()).filter((candidate: any) => candidate.reason === 'missing-local');
    appeared.put('/samples.csv', 'new local file');
    assert.equal((await appeared.engine.deleteRemoteCleanupCandidates(selectedMissing)).skipped, 1);
    assert.deepEqual(appeared.deleted, []);
    assert.equal(appeared.read('/samples.csv'), 'new local file');

    const open = setup();
    vscode.workspace.textDocuments = [{ uri: open.settings.getFilePath('/samples.csv'), isDirty: true }];
    assert.equal((await open.engine.getRemoteCleanupCandidates()).some((candidate: any) => candidate.path === '/samples.csv'), false,
        'an open unsaved document is not a remote-only deletion candidate');

    const protectedMain = setup();
    protectedMain.put('/.leafignore', '/**\n');
    assert.equal((await protectedMain.engine.getIgnoredRemoteFiles()).includes('/main.tex'), false,
        'cleanup must preserve the compilation root even when an ignore rule matches it');
}

async function testUploadRetryAndTransformation(): Promise<void> {
    const f = fixture();
    f.put('/main.tex', 'pending local change');
    const apply = f.socket.applyOtUpdate.bind(f.socket);
    let attempts = 0;
    f.socket.applyOtUpdate = async (...args) => {
        if (++attempts === 1) throw new Error('simulated transient upload failure');
        return apply(...args);
    };
    await suppressExpectedError(() => f.engine.handleLocalFileChange(f.settings.getFilePath('/main.tex')));
    assert.equal(f.engine.fileCache.get('/main.tex'), hash(bytes('A')), 'F6: failed uploads must not advance the echo cache');
    await f.engine.handleLocalFileChange(f.settings.getFilePath('/main.tex'));
    assert.equal(attempts, 2);
    assert.equal(f.server.get('doc')!.text, 'pending local change');
    await f.engine.handleLocalFileChange(f.settings.getFilePath('/main.tex'));
    assert.equal(attempts, 2, 'successful uploads should still suppress identical echoes');

    for (const newerLocalSave of [false, true]) {
        const transformed = fixture();
        transformed.put('/main.tex', 'A-local');
        transformed.socket.applyOtUpdate = async () => {
            // Simulate a server transform against a collaborator's in-flight edit.
            transformed.server.set('doc', { text: 'A-local-remote', version: 3 });
            if (newerLocalSave) transformed.put('/main.tex', 'A-newer-local');
        };
        await transformed.engine.handleLocalFileChange(transformed.settings.getFilePath('/main.tex'));
        assert.equal(transformed.read('/main.tex'), newerLocalSave ? 'A-newer-local' : 'A-local-remote');
        assert.equal(Buffer.from(transformed.engine.baseContent.get('/main.tex')).toString(), newerLocalSave ? 'A' : 'A-local-remote',
            'an overlapping newer save must keep the previous common ancestor until the conflict is resolved');
    }
}

async function testAppliedConfirmation(): Promise<void> {
    const tick = () => new Promise<void>(resolve => setImmediate(resolve));
    const makeSocket = () => {
        const wire = new (require('node:events').EventEmitter)();
        const socket = {
            on: wire.on.bind(wire), removeListener: wire.removeListener.bind(wire),
            removeAllListeners: wire.removeAllListeners.bind(wire), disconnect() {},
            emit(_event: string, ...args: any[]) { args.at(-1)(null); },
        };
        const client: any = new SocketIOAPI({ initSocket: () => socket },
            { cookies: 'audit=synthetic', csrfToken: 'synthetic' }, 'project');
        client._publicId = 'self';
        return { client, wire };
    };
    const update = { doc: 'doc', v: 2, op: [{ p: 1, i: 'x' }] };
    const f = makeSocket();
    let completed = false;
    const pending = f.client.applyOtUpdate('doc', update).then(() => { completed = true; });
    await tick();
    assert.equal(completed, false, 'a queue acknowledgement is not confirmation that content was applied');
    f.wire.emit('otUpdateApplied', { ...update, meta: { source: 'someone-else' } });
    f.wire.emit('otUpdateApplied', { ...update, v: 1, meta: { source: 'self' } });
    await tick();
    assert.equal(completed, false, 'another client or an earlier own operation must not confirm this write');
    f.wire.emit('otUpdateApplied', { ...update, v: 3, meta: { source: 'self' } });
    await pending;
    assert.equal(f.wire.listenerCount('otUpdateApplied'), 0);
    for (const version of [2, 3]) {
        const reduced = makeSocket();
        const write = reduced.client.applyOtUpdate('doc', update);
        reduced.wire.emit('otUpdateApplied', { doc: 'doc', v: version });
        await write;
        assert.equal(reduced.wire.listenerCount('otUpdateApplied'), 0,
            'the official sender acknowledgement contains only doc and v, even after a transform');
    }
    const failed = makeSocket();
    const failedWrite = failed.client.applyOtUpdate('doc', update);
    failed.wire.emit('otUpdateError', 'document update rejected', { doc_id: 'doc' });
    await assert.rejects(failedWrite, /rejected/);
    const cancelled = makeSocket();
    const cancelledWrite = cancelled.client.applyOtUpdate('doc', update);
    cancelled.client.disconnect();
    await assert.rejects(cancelledWrite, /disconnected/);
    assert.equal(cancelled.wire.listenerCount('otUpdateApplied'), 0);
}

async function testBinaryMultipartUpload(): Promise<void> {
    const http = require('node:http');
    const bodies: Buffer[] = [];
    let responseType = 'file';
    const server = http.createServer((request: any, response: any) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            bodies.push(Buffer.concat(chunks));
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ entity_id: 'uploaded', entity_type: responseType }));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const api = new BaseAPI(`http://127.0.0.1:${server.address().port}`);
    api.setIdentity({ cookies: 'audit=synthetic', csrfToken: 'synthetic' });
    try {
        const backing = new Uint8Array([99, 0, 127, 255, 42, 99]);
        for (const data of [Buffer.from([0, 127, 255]), new Uint8Array([0, 127, 255]), backing.subarray(1, 5), new Uint8Array()]) {
            const result = await api.uploadFile('project', 'root', 'figure.png', data);
            assert.equal(result.type, 'success', 'F7: accept every Uint8Array, including empty/subarray inputs');
            const body = bodies.at(-1)!;
            const part = body.indexOf('name="qqfile"');
            assert(part > 0);
            const start = body.indexOf('\r\n\r\n', part) + 4;
            const end = body.indexOf('\r\n--', start);
            assert.deepEqual(body.subarray(start, end), Buffer.from(data), 'multipart upload must preserve the exact binary bytes');
        }
        responseType = 'doc';
        const editable = await api.uploadFile('project', 'root', 'small.csv', bytes('x,y\n'));
        assert.equal(editable.doc?._type, 'doc', 'respect the storage type returned by the upload endpoint');
        assert.equal(editable.file, undefined, 'an editable upload must not be misidentified as an attachment');
        responseType = 'folder';
        const invalid = await api.uploadFile('project', 'root', 'small.csv', bytes('x,y\n'));
        assert.equal(invalid.type, 'error', 'invalid upload types must not authorize deleting a replacement backup');
    } finally {
        api.dispose();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(resolve));
    }
}

async function testRestoredRootFiles(): Promise<void> {
    const f = fixture();
    const transport = new (require('node:events').EventEmitter)();
    transport.disconnect = () => {};
    transport.on('joinProject', (_request: unknown, callback: (...args: unknown[]) => void) => callback(null, f.project));
    const socket = new SocketIOAPI({ initSocket: () => transport }, { cookies: 'test', csrfToken: 'test' }, 'project');
    socket.registerHandlers({
        onFileCreated: (parentId: string, type: string, entity: unknown) => f.engine.enqueueRemoteEvent(
            (isCurrent: () => boolean) => f.engine.handleRemoteFileCreated(parentId, type, entity, isCurrent),
        ),
        onFileRemoved: (id: string) => f.engine.enqueueRemoteEvent(
            (isCurrent: () => boolean) => f.engine.handleRemoteFileRemoved(id, isCurrent),
        ),
    });
    const joined = socket.joinProject();
    transport.emit('connect');
    await joined;
    f.engine.socket = socket;
    let downloads = 0;
    const pdf = Buffer.from([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 255, 128]);
    (f.api as any).getFile = async () => { downloads++; return { type: 'success', content: pdf }; };
    try {
        transport.emit('reciveNewFile', null, { _id: 'restored', name: 'main-old.pdf' }, 'restore');
        await f.engine.remoteEventQueue;
        assert.deepEqual(disk.get(key(f.settings.getFilePath('/main-old.pdf')))?.content, pdf,
            'a restored root PDF must download automatically with its binary bytes unchanged');
        assert.equal(downloads, 1);
        assert.equal(prompts.length, 0, 'a missing local file must not wait for a Download notification');
        assert.equal(f.engine.fileTreeByPath.get('/main-old.pdf').parentId, 'root');
        transport.emit('reciveNewFile', null, { _id: 'restored', name: 'main-old.pdf' });
        await f.engine.remoteEventQueue;
        assert.equal(downloads, 1, 'a repeated restoration notification must not download twice');

        transport.emit('removeEntity', 'restored', { kind: 'file-restore' });
        transport.emit('reciveNewFile', null, { _id: 'restored-again', name: 'main-old.pdf' });
        await f.engine.remoteEventQueue;
        assert.equal(f.engine.fileTreeByPath.get('/main-old.pdf').id, 'restored-again');
        assert.deepEqual(disk.get(key(f.settings.getFilePath('/main-old.pdf')))?.content, pdf);
        assert.equal(downloads, 2, 'a later restoration with a new identity must not be mistaken for an upload echo');

        await f.engine.ignoreParser.save(['/main.pdf']);
        transport.emit('reciveNewFile', null, { _id: 'compiled', name: 'main.pdf' });
        await f.engine.remoteEventQueue;
        assert.equal(f.read('/main.pdf'), undefined, 'explicit PDF ignore rules still apply to restored files');
        assert.equal(downloads, 2);

        f.put('/conflicting.pdf', 'unsynchronized local content');
        transport.emit('reciveNewFile', null, { _id: 'conflict', name: 'conflicting.pdf' });
        await f.engine.remoteEventQueue;
        assert.equal(f.read('/conflicting.pdf'), 'unsynchronized local content',
            'restoring a remote file must preserve an existing local file when the conflict is skipped');
        assert.ok(prompts.length > 0);

        f.put('/racy.pdf', 'local content before choice');
        promptChoice = 'Replace Local';
        promptHandler = () => f.put('/racy.pdf', 'newer content while choosing');
        transport.emit('reciveNewFile', null, { _id: 'racy', name: 'racy.pdf' });
        await f.engine.remoteEventQueue;
        assert.equal(f.read('/racy.pdf'), 'newer content while choosing',
            'an overwrite choice must not discard edits made after the conflict was shown');
        promptHandler = undefined;
        promptChoice = undefined;

        vscode.workspace.textDocuments = [{
            uri: f.settings.getFilePath('/unsaved.pdf'), isDirty: true, version: 1,
            getText: () => 'unsaved local editor content',
        } as any];
        transport.emit('reciveNewFile', null, { _id: 'unsaved', name: 'unsaved.pdf' });
        await f.engine.remoteEventQueue;
        assert.equal(f.read('/unsaved.pdf'), undefined, 'a restored attachment must respect an unsaved text editor at its path');
    } finally {
        f.engine.disconnect();
    }

    const initial = fixture();
    initial.project.rootFolder[0].fileRefs.push({ _id: 'restored-before-connect', name: 'main-old.pdf' });
    (initial.api as any).getFile = async () => ({ type: 'success', content: pdf });
    await initial.engine.pullAll();
    assert.deepEqual(disk.get(key(initial.settings.getFilePath('/main-old.pdf')))?.content, pdf,
        'the startup pull must recover a file restored before the current socket connection');
    assert.ok(!prompts.some(args => String(args[0]).startsWith('New file on Overleaf:')));
    initial.engine.disconnect();
}

async function within<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Synchronization remained blocked')), 2000);
        })]);
    } finally { clearTimeout(timer!); }
}

async function testPersistentRecovery(): Promise<void> {
    const f = fixture();
    const delays: number[] = [];
    f.engine.waitForRetry = async (delay: number) => { delays.push(delay); return !f.engine.disposed; };
    f.socket.isConnected = false;
    let attempts = 0;
    const reconnect = f.socket.reconnect.bind(f.socket);
    f.socket.reconnect = async () => {
        if (++attempts <= 8) throw new Error('HTTP 503: gateway temporarily unavailable');
        return reconnect();
    };
    f.server.set('doc', { text: 'changed during outage', version: 2 });
    f.engine.scheduleAutomaticRecovery();
    f.engine.scheduleAutomaticRecovery();
    assert.equal(f.scheduled.length, 1);
    await within(f.flushScheduled());
    assert.equal(attempts, 9, 'recovery must continue beyond the old three-attempt limit');
    assert.ok(delays.includes(5000) && delays.includes(10000));
    assert.ok(delays.every(delay => delay <= 30_000));
    assert.equal(f.read('/main.tex'), 'changed during outage');
    assert.ok(f.subscriptions.has('doc'));
    assert.equal(prompts.length, 0, 'remote-only changes after an outage need no Local/Remote choice');

    for (let cycle = 0; cycle < 5; cycle++) {
        f.put('/main.tex', `local edit ${cycle}`);
        f.socket.isConnected = false;
        f.engine.scheduleAutomaticRecovery();
        await within(f.flushScheduled());
        assert.equal(f.server.get('doc')!.text, `local edit ${cycle}`);
        const doc = f.server.get('doc')!;
        doc.text += '!';
        doc.version++;
        await f.engine.handleRemoteFileChanged(remoteUpdate(doc.version - 1, doc.text.length - 1, '!'));
        assert.equal(f.read('/main.tex'), `local edit ${cycle}!`);
    }
    assert.equal(f.engine.status, 'idle');
    f.engine.disconnect();

    const auth = fixture();
    auth.socket.isConnected = false;
    let authAttempts = 0;
    auth.socket.reconnect = async () => { authAttempts++; throw new Error('Session expired'); };
    auth.engine.scheduleAutomaticRecovery();
    await auth.flushScheduled();
    auth.engine.scheduleAutomaticRecovery();
    assert.equal(authAttempts, 1);
    assert.equal(auth.scheduled.length, 0, 'expired credentials must stop unattended recovery');
    auth.engine.disconnect();

    const closed = fixture();
    closed.socket.isConnected = false;
    closed.socket.reconnect = async () => { throw new Error('HTTP 503'); };
    closed.engine.waitForRetry = async (delay: number) => {
        if (delay >= 5000) closed.engine.disconnect();
        return !closed.engine.disposed;
    };
    closed.engine.scheduleAutomaticRecovery();
    await within(closed.flushScheduled());
    assert.equal(closed.engine.automaticRecoveryScheduled, false);
    assert.equal(closed.engine.status, 'disconnected');
}

async function testUnattendedConflicts(): Promise<void> {
    const showWarning = vscode.window.showWarningMessage;
    const f = fixture();
    let resolveChoice!: (value: string | undefined) => void;
    vscode.window.showWarningMessage = async (...args) => {
        prompts.push(args);
        return new Promise<string | undefined>(resolve => { resolveChoice = resolve; });
    };
    try {
        f.put('/main.tex', 'local work');
        f.server.set('doc', { text: 'remote work', version: 2 });
        f.project.rootFolder[0].docs.push({ _id: 'other', name: 'other.tex' });
        f.server.set('other', { text: 'other remote work', version: 2 });
        f.baseline('/other.tex', 'other');
        await within(f.engine.pullAll());
        assert.equal(f.read('/main.tex'), 'local work');
        assert.equal(f.read('/other.tex'), 'other remote work');
        assert.equal(f.engine.status, 'error', 'unresolved conflicts must not appear Up to date');
        assert.equal(f.engine.syncLock.size, 0, 'a notification must not retain the workspace lock');

        f.server.set('other', { text: 'other remote work!', version: 3 });
        f.engine.enqueueRemoteEvent(() => f.engine.handleRemoteFileChanged({
            doc: 'other', v: 2, op: [{ p: 17, i: '!' }],
        }));
        await within(f.engine.remoteEventQueue);
        assert.equal(f.read('/other.tex'), 'other remote work!');
        f.put('/other.tex', 'local change while a notification is open');
        await within(f.engine.handleLocalFileChange(f.settings.getFilePath('/other.tex')));
        assert.equal(f.server.get('other')!.text, 'local change while a notification is open');
        resolveChoice('Remote');
        await within(f.flushScheduled());
        assert.equal(f.read('/main.tex'), 'remote work', 'the choice must be applied automatically after the earlier pull');
        assert.equal(f.engine.status, 'idle');

        f.put('/main.tex', 'second local draft');
        f.server.set('doc', { text: 'second remote draft', version: 3 });
        await within(f.engine.pullAll());
        f.put('/main.tex', 'newer local edits after notification');
        resolveChoice('Remote');
        await within(f.flushScheduled());
        assert.equal(f.read('/main.tex'), 'newer local edits after notification',
            'an earlier approval must not overwrite a newer local revision');
        resolveChoice(undefined);
    } finally {
        f.engine.disconnect();
        vscode.window.showWarningMessage = showWarning;
    }
}

async function testInitialAndUnilateralSync(): Promise<void> {
    const empty = fixture();
    disk.delete(key(empty.settings.getFilePath('/main.tex')));
    empty.engine.clearBaseContent();
    empty.engine.fileCache.clear();
    disk.set(key(empty.settings.getFilePath('/.git')), { type: 2 });
    empty.put('/.git/config', 'git metadata');
    await empty.engine.pullAll();
    assert.equal(empty.read('/main.tex'), 'A');
    assert.equal(prompts.length, 0, 'an empty Git repository must download automatically');
    empty.engine.disconnect();

    const windows = fixture();
    windows.engine.clearBaseContent();
    windows.put('/main.tex', 'line one\r\nline two\r\n');
    windows.server.set('doc', { text: 'line one\nline two\n', version: 1 });
    await windows.engine.pullAll();
    assert.equal(prompts.length, 0, 'CRLF/LF differences are not conflicting edits');
    assert.equal(windows.read('/main.tex'), 'line one\nline two\n');
    windows.engine.disconnect();

    const attachment = fixture();
    attachment.project.rootFolder[0].fileRefs.push({ _id: 'pdf', name: 'figure.pdf' });
    let remote = bytes('PDF before change');
    (attachment.api as any).getFile = async () => ({ type: 'success', content: remote });
    await attachment.engine.pullAll();
    remote = bytes('PDF after change');
    await attachment.engine.pullAll();
    assert.equal(attachment.read('/figure.pdf'), 'PDF after change');
    assert.equal(prompts.length, 0, 'unchanged local attachments must accept remote changes without a conflict');
    attachment.engine.disconnect();
}

async function testUnattendedFileChoices(): Promise<void> {
    const warning = vscode.window.showWarningMessage;
    const information = vscode.window.showInformationMessage;
    let resolveChoice!: (choice: string | undefined) => void;
    const prompt = async (...args: unknown[]) => {
        prompts.push(args);
        return new Promise<string | undefined>(resolve => { resolveChoice = resolve; });
    };
    try {
        vscode.window.showWarningMessage = prompt;
        const removed = deletionFixture();
        await within(removed.engine.handleRemoteFileRemoved('folder'));
        assert.equal(removed.read('/chapter/safe.tex'), undefined);
        assert.equal(removed.engine.syncLock.size, 0);
        removed.put('/main.tex', 'save during a deletion notification');
        await within(removed.engine.handleLocalFileChange(removed.settings.getFilePath('/main.tex')));
        assert.equal(removed.server.get('doc')!.text, 'save during a deletion notification');
        removed.put('/chapter/chapter.tex', 'new edits after notification');
        resolveChoice('Delete Modified Copies');
        await removed.flushScheduled();
        assert.equal(removed.read('/chapter/chapter.tex'), 'new edits after notification');
        removed.engine.disconnect();

        const orphan = fixture();
        orphan.baseline('/orphan.tex', 'common ancestor');
        orphan.put('/orphan.tex', 'local orphan');
        await within(orphan.engine.pullAll());
        assert.equal(orphan.engine.syncLock.size, 0);
        // A restore arriving before the deletion choice must invalidate it.
        orphan.project.rootFolder[0].docs.push({ _id: 'restored', name: 'orphan.tex' });
        orphan.server.set('restored', { text: 'local orphan', version: 1 });
        orphan.engine.buildFileTree(orphan.project);
        resolveChoice('Delete Locally');
        await orphan.flushScheduled();
        assert.equal(orphan.read('/orphan.tex'), 'local orphan');
        orphan.engine.disconnect();

        vscode.window.showInformationMessage = prompt;
        const localOnly = fixture();
        localOnly.put('/new.tex', 'local only');
        await within(localOnly.engine.pullAll());
        assert.equal(localOnly.engine.syncLock.size, 0);
        localOnly.server.set('doc', { text: 'A!', version: 2 });
        localOnly.engine.enqueueRemoteEvent(() => localOnly.engine.handleRemoteFileChanged(remoteUpdate(1, 1, '!')));
        await within(localOnly.engine.remoteEventQueue);
        assert.equal(localOnly.read('/main.tex'), 'A!');
        resolveChoice('Ignore');
        await localOnly.flushScheduled();
        localOnly.engine.disconnect();
    } finally {
        vscode.window.showWarningMessage = warning;
        vscode.window.showInformationMessage = information;
    }
}

async function testEventDrivenRecovery(): Promise<void> {
    const f = fixture();
    let healthProbes = 0;
    f.socket.checkConnection = async () => { healthProbes++; };
    f.engine.lastFocusReconciliation = 0;
    f.server.set('doc', { text: 'edit missed while the window was inactive', version: 2 });
    f.project.rootFolder[0].docs.push({ _id: 'restored', name: 'restored.tex' });
    f.server.set('restored', { text: 'restored on the server', version: 1 });
    await f.engine.reconcileOnWindowFocus();
    assert.equal(f.read('/main.tex'), 'edit missed while the window was inactive');
    assert.equal(f.read('/restored.tex'), 'restored on the server');
    assert.ok(f.subscriptions.has('doc'));
    const refreshes = f.refreshCount();
    await f.engine.reconcileOnWindowFocus();
    assert.equal(f.refreshCount(), refreshes, 'repeated focus events must share the catch-up cooldown');
    assert.equal(healthProbes, 0, 'normal operation uses transport heartbeat, not recurring liveness RPCs');
    assert.equal(f.engine.pendingWaits.size, 0, 'healthy sessions must not install a periodic retry loop');
    f.socket.isConnected = false;
    f.engine.lastFocusReconciliation = 0;
    await f.engine.reconcileOnWindowFocus();
    await f.flushScheduled();
    assert.ok(f.socket.isConnected && f.subscriptions.has('doc'), 'an actual lost connection still recovers');
    f.engine.disconnect();

    const failedFile = fixture();
    let attempts = 0;
    failedFile.engine.pullAll = async () => { attempts++; throw new Error('Local disk is read-only'); };
    failedFile.engine.scheduleAutomaticRecovery();
    await failedFile.flushScheduled();
    assert.equal(attempts, 1, 'a file error cannot be repaired by repeatedly retrying a healthy connection');
    assert.equal(failedFile.engine.recoveryRequired, false);
    failedFile.engine.disconnect();

    const missed = fixture();
    missed.engine.joinedDocs.add('doc');
    missed.subscriptions.clear();
    missed.server.set('doc', { text: 'remote edit with no delivered event', version: 2 });
    await missed.engine.checkDocumentSubscriptions();
    assert.equal(missed.read('/main.tex'), 'remote edit with no delivered event');
    assert.ok(missed.subscriptions.has('doc'), 'event-triggered reconciliation renews a lost document room');
    missed.put('/main.tex', 'local draft while the server has no new change');
    await missed.engine.checkDocumentSubscriptions();
    assert.equal(missed.read('/main.tex'), 'local draft while the server has no new change');
    assert.equal(prompts.length, 0, 'an unchanged snapshot must not conflict with a local draft');
    missed.engine.disconnect();
}

async function testThreeWayMerge(): Promise<void> {
    const { mergeText, textOperations } = require('../sync/textMerge');
    const ancestor = 'first\nunchanged\nlast\n';
    const unknown = fixture();
    unknown.engine.deleteBaseContent('/main.tex');
    unknown.engine.fileCache.delete('/main.tex');
    unknown.put('/main.tex', 'Saved local content without an ancestor');
    unknown.server.set('doc', { text: 'Different remote content', version: 2 });
    unknown.engine.askConflictResolution = async () => 'skip';
    await unknown.engine.handleRemoteFileChanged({ doc: 'doc', v: 2 });
    assert.equal(unknown.read('/main.tex'), 'Saved local content without an ancestor');
    assert.equal(unknown.engine.getBaseHashes().has('/main.tex'), false, 'skipping an unknown ancestor conflict cannot grant overwrite authority');
    unknown.engine.disconnect();
    const unchangedSave = fixture();
    unchangedSave.server.set('doc', { text: 'Remote change only', version: 2 });
    unchangedSave.engine.fileCache.delete('/main.tex'); // a repeated filesystem hint
    await unchangedSave.engine.handleLocalFileChange(unchangedSave.settings.getFilePath('/main.tex'));
    assert.equal(unchangedSave.read('/main.tex'), 'Remote change only');
    assert.equal(unchangedSave.server.get('doc')!.text, 'Remote change only');
    unchangedSave.engine.disconnect();
    for (const trigger of ['push', 'pull', 'event']) {
        const f = fixture();
        f.baseline('/main.tex', ancestor);
        f.put('/main.tex', 'FIRST\nunchanged\nlast\n');
        f.server.set('doc', { text: 'first\nunchanged\nLAST\n', version: 2 });
        if (trigger === 'push') await f.engine.handleLocalFileChange(f.settings.getFilePath('/main.tex'));
        if (trigger === 'pull') await f.engine.pullAll(false);
        if (trigger === 'event') await f.engine.handleRemoteFileChanged({ doc: 'doc', v: 1 });
        assert.equal(f.read('/main.tex'), 'FIRST\nunchanged\nLAST\n', trigger);
        assert.equal(f.server.get('doc')!.text, f.read('/main.tex'), trigger + ' must converge');
        assert.equal(prompts.length, 0, 'independent edits need no prompt');
        f.engine.disconnect();
    }
    const cases = [
        ['\uFEFFa\nkeep\nz', '\uFEFFA\nkeep\nz', '\uFEFFa\nkeep\nZ', '\uFEFFA\nkeep\nZ'],
        ['a\r\nkeep\r\nz', 'A\r\nkeep\r\nz', 'a\r\nkeep\r\nZ', 'A\r\nkeep\r\nZ'],
        ['🙂\n\tkeep  \nlast\n', '🚀\n\tkeep  \nlast\n', '🙂\n\tkeep  \nLAST\n', '🚀\n\tkeep  \nLAST\n'],
        ['a\nb\nc\n', 'A\nb\nc\n', 'A\nb\nc\n', 'A\nb\nc\n'],
    ];
    for (const [base, local, remote, expected] of cases) {
        const result = await mergeText(bytes(base), bytes(local), bytes(remote));
        assert.equal(result.clean, true);
        assert.equal(Buffer.from(result.content).toString(), expected);
    }
    assert.equal((await mergeText(undefined, bytes('local'), bytes('remote'))).clean, false);
    assert.equal((await mergeText(bytes(''), bytes('local'), bytes('remote'))).clean, false);
    assert.equal((await mergeText(bytes('a\n'), bytes(''), bytes('A\n'))).clean, false, 'delete versus edit is a conflict');
    assert.equal((await mergeText(bytes('same\n'.repeat(10000)), bytes('X\n' + 'same\n'.repeat(10000)),
        bytes('same\n'.repeat(10000) + 'Y\n'), 20)).clean, false, 'repeated lines have a hard worker deadline');
    const original = '🙂 start\nkeep this middle intact\nlast\n';
    const wanted = '🙂 START\nkeep this middle intact\nLAST\n';
    let value = original;
    const ops = textOperations(original, wanted);
    assert.ok(ops.length >= 4, 'separate edits should not delete the unchanged middle');
    for (const op of ops) {
        if (op.d) {
            assert.equal(value.slice(op.p, op.p + op.d.length), op.d);
            assert.ok(!op.d.includes('keep this middle'));
            value = value.slice(0, op.p) + value.slice(op.p + op.d.length);
        }
        if (op.i) value = value.slice(0, op.p) + op.i + value.slice(op.p);
    }
    assert.equal(value, wanted, 'positions must use UTF-16 offsets');
    assert.deepEqual(textOperations('', 'x'.repeat(20000)), [{ p: 0, i: 'x'.repeat(20000) }]);

    const pending = fixture();
    const pendingBase = 'first\nseparator\nmiddle\nseparator\nlast\n';
    pending.baseline('/main.tex', pendingBase);
    pending.server.set('doc', { text: pendingBase, version: 1 });
    pending.put('/main.tex', 'FIRST\nseparator\nmiddle\nseparator\nlast\n');
    const apply = pending.socket.applyOtUpdate.bind(pending.socket);
    pending.socket.applyOtUpdate = async (...args) => {
        await apply(...args);
        pending.server.set('doc', { text: 'FIRST\nseparator\nmiddle\nseparator\nLAST\n', version: 3 });
        pending.put('/main.tex', 'FIRST\nseparator\nnew save\nseparator\nlast\n');
    };
    await pending.engine.handleLocalFileChange(pending.settings.getFilePath('/main.tex'));
    assert.equal(pending.read('/main.tex'), 'FIRST\nseparator\nnew save\nseparator\nLAST\n');
    pending.socket.applyOtUpdate = apply;
    await pending.flushScheduled();
    assert.equal(pending.server.get('doc')!.text, pending.read('/main.tex'));
    assert.equal(prompts.length, 0, 'new saves during an upload must converge too');
    pending.engine.disconnect();
}

async function testPersistentStateAndUnknownWrites(): Promise<void> {
    const { SyncStateStore } = require('../sync/syncStateStore');
    const directory = await createTemporaryWorkspace('sync-state');
    const errors: Error[] = [];
    const makeStore = (identity = 'test-project-client-A') => {
        const created = new SyncStateStore(directory, identity, (error: Error) => errors.push(error));
        createdStores.add(created);
        return created;
    };
    const store = makeStore();
    await store.load();
    store.put({ path: '/empty.tex', id: 'empty', type: 'doc', content: '', hash: hash(bytes('')) });
    store.put({ path: '/binary.pdf', id: 'binary', type: 'file', hash: hash(bytes('binary')) });
    await store.flush();
    const reloaded = makeStore();
    await reloaded.load();
    assert.equal(reloaded.entries.get('/empty.tex').content, '', 'an empty ancestor survives a restart');
    assert.equal(reloaded.entries.get('/binary.pdf').content, undefined, 'an opaque hash must not become an empty ancestor');
    const otherClient = makeStore('test-project-client-B');
    await otherClient.load();
    assert.equal(otherClient.entries.size, 0, 'another workspace cannot inherit deletion authority');

    const f = fixture();
    f.engine.stateStore = store;
    f.engine.recordSynchronizedContent(f.engine.fileTree.get('doc'), bytes('A'));
    await store.flush();
    f.put('/main.tex', 'A-local');
    const apply = f.socket.applyOtUpdate.bind(f.socket);
    let applied = 0;
    f.socket.applyOtUpdate = async (...args) => {
        applied++;
        await apply(...args);
        f.socket.isConnected = false;
        throw new Error('Connection lost after commit, before confirmation');
    };
    await suppressExpectedError(() => f.engine.handleLocalFileChange(f.settings.getFilePath('/main.tex')));
    await store.flush();
    const restarted = makeStore();
    await restarted.load();
    assert.equal(restarted.entries.get('/main.tex').intent.kind, 'write');
    assert.equal(restarted.entries.get('/main.tex').content, bytes('A').toString('base64'));
    f.engine.stateStore = restarted;
    f.socket.isConnected = true;
    f.socket.applyOtUpdate = apply;
    await f.engine.pullAll(false);
    assert.equal(f.server.get('doc')!.text, 'A-local');
    assert.equal(applied, 1, 'a committed write with a lost ACK must not be applied twice');
    assert.equal(restarted.entries.get('/main.tex').intent, undefined);

    // The old packet can still be queued when joinDoc returns. Recovery must
    // send the original operation with its old connection ID for server dedup.
    restarted.put({ path: '/main.tex', id: 'doc', type: 'doc', content: bytes('A-local').toString('base64'),
        hash: hash(bytes('A-local')), intent: { kind: 'write', before: bytes('A-local').toString('base64'),
            desired: bytes('A-local-next').toString('base64'), local: bytes('A-local-next').toString('base64'),
            version: 2, sources: ['old-connection'] } });
    await restarted.flush();
    f.put('/main.tex', 'A-local-next');
    f.socket.applyOtUpdate = async (_id, update) => {
        assert.deepEqual(update.dupIfSource, ['old-connection']);
        f.server.set('doc', { text: 'A-local-next', version: 3 });
    };
    await f.engine.pullAll(false);
    assert.equal(f.read('/main.tex'), 'A-local-next');
    assert.equal(restarted.entries.get('/main.tex').intent, undefined);
    const oldBase = 'first\nseparator\nlast\n';
    const oldDesired = 'FIRST\nseparator\nlast\n';
    restarted.put({ path: '/main.tex', id: 'doc', type: 'doc', hash: hash(bytes(oldBase)),
        content: bytes(oldBase).toString('base64'), intent: { kind: 'write', before: bytes(oldBase).toString('base64'),
            desired: bytes(oldDesired).toString('base64'), local: bytes(oldDesired).toString('base64'),
            version: 1, sources: ['previous-session'] } });
    f.put('/main.tex', oldDesired);
    f.server.set('doc', { text: 'first\nseparator\nLAST\n', version: 100 });
    f.socket.applyOtUpdate = async (id, update) => {
        if (update.v === 1) throw new Error('Overleaf rejected the document update: Op too old');
        await apply(id, update);
    };
    await f.engine.pullAll(false);
    assert.equal(f.read('/main.tex'), 'FIRST\nseparator\nLAST\n', 'obsolete OT history falls back to three-way merging');
    assert.equal(f.server.get('doc')!.text, f.read('/main.tex'));
    assert.equal(restarted.entries.get('/main.tex').intent, undefined);
    assert.deepEqual(errors, []);
    f.engine.disconnect();

    for (const rollbackFails of [false, true]) {
        const failed = fixture('data.csv');
        const failedStore = makeStore('failed-attachment-' + rollbackFails);
        await failedStore.load();
        failed.engine.stateStore = failedStore;
        const entry = failed.engine.fileTree.get('doc');
        failed.engine.recordSynchronizedContent(entry, bytes('A'));
        await failedStore.flush();
        let renames = 0;
        (failed.api as any).renameEntity = async () => {
            if (++renames === 2 && rollbackFails) throw new Error('Rollback unavailable');
            return { type: 'success' };
        };
        (failed.api as any).uploadFile = async () => { throw new Error('Upload failed'); };
        await assert.rejects(() => failed.engine.replaceRemoteFile(entry, bytes('replacement')), /Upload failed/);
        await failedStore.flush();
        assert.equal(failed.engine.getBaseHashes().get('/data.csv'), hash(bytes('A')));
        const pending = makeStore('failed-attachment-' + rollbackFails);
        await pending.load();
        assert.equal(pending.entries.get('/data.csv').hash, hash(bytes('A')));
        assert.equal(pending.entries.get('/data.csv').intent.kind, 'replace', 'failure cannot discard the durable replacement intent');
        failed.engine.disconnect();
    }

    for (const uploaded of [false, true]) {
        const replacement = fixture('data.csv');
        const replacementStore = makeStore('replacement-' + uploaded);
        await replacementStore.load();
        replacement.engine.stateStore = replacementStore;
        replacement.put('/data.csv', 'new attachment');
        replacement.project.rootFolder[0].docs[0].name = 'data.csv.localleaf-backup';
        if (uploaded) {
            replacement.project.rootFolder[0].docs.push({ _id: 'new-id', name: 'data.csv' });
            replacement.server.set('new-id', { text: 'new attachment', version: 1 });
        }
        replacement.engine.buildFileTree(replacement.project);
        replacementStore.put({ path: '/data.csv', id: 'doc', type: 'doc', hash: hash(bytes('A')),
            intent: { kind: 'replace', desiredHash: hash(bytes('new attachment')), backupPath: '/data.csv.localleaf-backup' } });
        await replacementStore.flush();
        const deleted: string[] = [];
        (replacement.api as any).deleteEntity = async (_project: string, _type: string, id: string) => {
            deleted.push(id); return { type: 'success' };
        };
        (replacement.api as any).renameEntity = async (_project: string, _type: string, id: string, name: string) => {
            assert.equal(id, 'doc'); assert.equal(name, 'data.csv'); return { type: 'success' };
        };
        await replacement.engine.recoverReplacementIntents();
        assert.equal(replacement.read('/data.csv'), 'new attachment', 'interrupted replacements preserve the local revision');
        assert.equal(replacementStore.entries.get('/data.csv').intent, undefined);
        assert.equal(replacement.engine.fileTreeByPath.get('/data.csv').id, uploaded ? 'new-id' : 'doc');
        assert.deepEqual(deleted, uploaded ? ['doc'] : [], 'remove a backup only after verifying the replacement');
        replacement.engine.disconnect();
    }
}

async function testFilesystemReconciliation(): Promise<void> {
    const f = fixture();
    disk.set(key(f.settings.getFilePath('/data')), { type: 2 });
    await f.engine.handleLocalFileChange(f.settings.getFilePath('/data'));
    assert.notEqual(f.engine.status, 'error', 'directory changes must not be routed to readFile');
    const runner = (operation: () => Promise<void>) => { void operation(); };
    const original = f.socket.applyOtUpdate.bind(f.socket);
    let uploads = 0;
    f.socket.applyOtUpdate = async (...args) => { uploads++; return original(...args); };
    f.put('/main.tex', 'staged write');
    f.engine.queueLocalEvent(f.settings.getFilePath('/main.tex'), runner);
    f.put('/main.tex', 'finished write');
    f.engine.queueLocalEvent(f.settings.getFilePath('/main.tex'), runner);
    await within((async () => {
        while (f.server.get('doc')!.text !== 'finished write') await new Promise(resolve => setTimeout(resolve, 20));
    })());
    assert.equal(uploads, 1, 'rapid changes must coalesce into one saved revision');
    f.engine.setStatus('error', 'Attachment failed', '/broken.pdf');
    f.engine.recordSynchronizedContent(f.engine.fileTree.get('doc'), bytes('finished write'));
    f.engine.setStatus('idle');
    assert.equal(f.engine.status, 'error', 'a successful file must not hide another file failure');
    f.engine.disconnect();
    assert.equal(f.engine.localEventTimers.size, 0);

    const ignored = fixture();
    await ignored.engine.ignoreParser.save(['/analysis/']);
    disk.set(key(ignored.settings.getFilePath('/analysis')), { type: 2 });
    let folderRequests = 0;
    (ignored.api as any).addFolder = async () => { folderRequests++; return { type: 'success' }; };
    await ignored.engine.handleLocalFileCreate(ignored.settings.getFilePath('/analysis'));
    assert.equal(folderRequests, 0, 'directory-only ignore rules must also exclude the directory creation itself');
    assert.notEqual(ignored.engine.status, 'error');
    const previouslySynced = { id: 'analysis', type: 'folder', path: '/analysis/', name: 'analysis', parentId: 'root' };
    ignored.engine.fileTree.set(previouslySynced.id, previouslySynced);
    ignored.engine.fileTreeByPath.set(previouslySynced.path, previouslySynced);
    ignored.engine.setBaseContent(previouslySynced.path, bytes(''));
    disk.delete(key(ignored.settings.getFilePath('/analysis')));
    let deleteRequests = 0;
    (ignored.api as any).deleteEntity = async () => { deleteRequests++; return { type: 'success' }; };
    await ignored.engine.handleLocalFileDelete(ignored.settings.getFilePath('/analysis'));
    assert.equal(deleteRequests, 0, 'new directory-only ignore rules also protect previously synchronized folders from deletion');
    ignored.engine.disconnect();

    for (const trigger of ['event', 'pull']) {
        const removed = fixture();
        disk.delete(key(removed.settings.getFilePath('/main.tex')));
        const deletions: string[] = [];
        (removed.api as any).deleteEntity = async (_project: string, _type: string, id: string) => {
            deletions.push(id); return { type: 'success' };
        };
        if (trigger === 'event') await removed.engine.handleRemoteFileChanged({ doc: 'doc', v: 1 });
        else await removed.engine.pullAll(false);
        assert.equal(removed.read('/main.tex'), undefined, 'background reconciliation must not resurrect a local deletion');
        await removed.flushScheduled();
        assert.deepEqual(deletions, ['doc'], 'a known local deletion is eventually sent to the unchanged remote copy');
        removed.engine.disconnect();
    }

    const concurrentlyEdited = fixture();
    disk.delete(key(concurrentlyEdited.settings.getFilePath('/main.tex')));
    concurrentlyEdited.server.set('doc', { text: 'New remote edit', version: 2 });
    let unsafeDeletions = 0;
    (concurrentlyEdited.api as any).deleteEntity = async () => { unsafeDeletions++; return { type: 'success' }; };
    await concurrentlyEdited.engine.handleRemoteFileChanged({ doc: 'doc', v: 2 });
    await suppressExpectedError(() => concurrentlyEdited.flushScheduled());
    assert.equal(unsafeDeletions, 0, 'deletion reconciliation must preserve a remotely edited document');
    assert.equal(concurrentlyEdited.read('/main.tex'), undefined);
    assert.equal(concurrentlyEdited.engine.status, 'error', 'delete/edit conflicts remain visible for review');
    concurrentlyEdited.engine.disconnect();
}

async function run(): Promise<void> {
    const tests = [testVersionedSnapshots, testAutomaticConflicts, testSafeRemoteDeletion,
        testPullSubscriptionsAndTree, testAutomaticPullRecovery, testLargeTextFiles, testIgnoredFoldersAndRemoteCleanup,
        testUploadRetryAndTransformation, testAppliedConfirmation, testBinaryMultipartUpload, testRestoredRootFiles,
        testPersistentRecovery, testUnattendedConflicts, testInitialAndUnilateralSync, testEventDrivenRecovery, testUnattendedFileChoices,
        testThreeWayMerge, testPersistentStateAndUnknownWrites, testFilesystemReconciliation];
    for (const test of tests) {
        await test();
        console.log(`Passed: ${test.name}`);
    }
    console.log('Synchronization audit regression tests passed.');
}
async function main(): Promise<void> {
    try { await run(); }
    finally {
        for (const engine of createdEngines) {
            // Some narrow tests replace the API with just their request stub.
            engine.api.dispose ??= () => {};
            engine.disconnect();
        }
        try { await Promise.all([...createdStores].map(store => store.flush())); }
        finally { await cleanTemporaryWorkspaces(); }
    }
}
runStandaloneTest(main);
