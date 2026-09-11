/** Regression tests for the seven 2026-09-06 audit findings. Runs in its own process. */
export {};
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
    workspace: { fs: memoryFs, textDocuments: [] as Array<{ uri: ReturnType<typeof uri>; isDirty: boolean }> },
    window: {
        async showWarningMessage(...args: unknown[]) { prompts.push(args); promptHandler?.(); return promptChoice; },
        async showInformationMessage(...args: unknown[]) { prompts.push(args); return undefined; },
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
    return { engine, server, project, settings, api, socket, subscriptions, put, read, baseline, refreshCount: () => refreshCount };
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
    http.engine.askNewRemoteFileResolution = async () => 'useRemote';
    await http.engine.pullAll();
    assert.equal(http.refreshCount(), 1, 'F5: HTTP pull must fetch the current tree');
    assert.equal(http.read('/new.tex'), 'new remote content');
    http.project.rootFolder[0].docs = http.project.rootFolder[0].docs.filter((doc: any) => doc._id !== 'new-doc');
    let orphaned: string[] = [];
    http.engine.handleOrphanedLocalFiles = async (paths: string[]) => { orphaned = paths; };
    await http.engine.pullAll();
    assert.deepEqual(orphaned, ['/new.tex'], 'preserve the old baseline to detect remote deletions');
    assert.equal(http.read('/new.tex'), 'new remote content', 'remote deletions in HTTP mode still require a choice');

    const unavailable = fixture();
    unavailable.engine.api = { getProjectDetails: async () => ({ type: 'success', projectData: {} }) };
    await unavailable.engine.pullAll(); // Live socket tree remains usable on older servers.
    unavailable.socket.isConnected = false;
    await assert.rejects(() => unavailable.engine.refreshProjectFileTree(), /connection was lost.*Retry sync/,
        'a lost socket must report a reconnection problem instead of missing server metadata');
    unavailable.engine.socket = undefined;
    await assert.rejects(() => unavailable.engine.pullAll(), /no folder tree/,
        'an HTTP session cannot claim success using an unrefreshable tree');
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
    f.engine.askNewRemoteFileResolution = async () => 'useRemote';
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
        assert.equal(Buffer.from(transformed.engine.baseContent.get('/main.tex')).toString(), newerLocalSave ? 'A-local' : 'A-local-remote');
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

async function run(): Promise<void> {
    const tests = [testVersionedSnapshots, testAutomaticConflicts, testSafeRemoteDeletion,
        testPullSubscriptionsAndTree, testAutomaticPullRecovery, testLargeTextFiles, testIgnoredFoldersAndRemoteCleanup,
        testUploadRetryAndTransformation, testAppliedConfirmation, testBinaryMultipartUpload];
    for (const test of tests) {
        await test();
        console.log(`Passed: ${test.name}`);
    }
    console.log('All seven audit findings are covered by passing regression tests.');
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
