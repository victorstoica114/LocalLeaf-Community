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

function fixture() {
    disk = new Map([[key(uri(rootPath)), { type: 2 }]]);
    prompts = [];
    promptChoice = undefined;
    promptHandler = undefined;
    vscode.workspace.textDocuments = [];
    const server = new Map([['doc', { text: 'A', version: 1 }]]);
    const subscriptions = new Set();
    const project: any = {
        _id: 'project', name: 'Audit fixture',
        rootFolder: [{ _id: 'root', name: '', docs: [{ _id: 'doc', name: 'main.tex' }], fileRefs: [], folders: [] }],
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
        async getDocContent(_projectId: string, id: string) { return { type: 'success', lines: server.get(id)!.text.split('\n') }; },
        async getProjectDetails() {
            refreshCount++;
            return { type: 'success', projectData: { projectId: 'project', rootFolder: project.rootFolder } };
        },
    };
    const socket = {
        isConnected: true,
        publicId: 'local-client',
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
    baseline('/main.tex', 'A');
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
    unavailable.engine.socket = undefined;
    await assert.rejects(() => unavailable.engine.pullAll(), /no folder tree/,
        'an HTTP session cannot claim success using an unrefreshable tree');
}

async function suppressExpectedError(operation: () => Promise<void>): Promise<void> {
    const original = console.error;
    console.error = () => {};
    try { await operation(); } finally { console.error = original; }
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
        const client: any = Object.create(SocketIOAPI.prototype);
        Object.assign(client, { _publicId: 'self', handlers: [], pendingDocumentWrites: new Set(), disposed: false });
        client.socket = {
            on: wire.on.bind(wire), removeListener: wire.removeListener.bind(wire),
            removeAllListeners: wire.removeAllListeners.bind(wire), disconnect() {},
            emit(_event: string, ...args: any[]) { args.at(-1)(null); },
        };
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
    const server = http.createServer((request: any, response: any) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            bodies.push(Buffer.concat(chunks));
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ entity_id: 'uploaded', entity_type: 'file' }));
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
    } finally {
        api.dispose();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(resolve));
    }
}

async function run(): Promise<void> {
    const tests = [testVersionedSnapshots, testAutomaticConflicts, testSafeRemoteDeletion,
        testPullSubscriptionsAndTree, testUploadRetryAndTransformation, testAppliedConfirmation, testBinaryMultipartUpload];
    for (const test of tests) {
        await test();
        console.log(`Passed: ${test.name}`);
    }
    console.log('All seven audit findings are covered by passing regression tests.');
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
