/** Primary event delivery must survive secondary project snapshots. */
import { SyncEngine, TestUri } from './nativeSyncFixture';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { cleanTemporaryWorkspaces, createTemporaryWorkspace } from './temporaryWorkspace';
import { runStandaloneTest } from './standaloneRunner';
import { SyncStateStore } from '../sync/syncStateStore';

const engines = new Set<{ disconnect(): void }>();

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function fixture() {
    const directory = await createTemporaryWorkspace('sync-refresh-audit');
    const root = TestUri.file(directory);
    const project = {
        _id: 'project', name: 'Refresh fixture',
        rootFolder: [{ _id: 'root', name: '', docs: [
            { _id: 'doc', name: 'main.tex' }, { _id: 'removed', name: 'removed.tex' },
        ], fileRefs: [], folders: [] }],
    };
    const documents = new Map([['doc', 'A'], ['removed', 'old content']]);
    const settings = {
        getWorkspaceFolder: () => root,
        getSettings: () => ({ serverUrl: 'https://example.invalid', projectId: 'project', autoSync: true }),
        getFilePath: (relative: string) => TestUri.file(path.join(directory, relative)),
        getRelativePath: (uri: InstanceType<typeof TestUri>) => '/' + path.relative(directory, uri.fsPath).replaceAll('\\', '/'),
    };
    const api = { dispose() {}, async getProjectDetails() { return { type: 'success', projectData: {} }; } };
    const engine: any = new SyncEngine(api, settings);
    engines.add(engine);
    const snapshotStarted = deferred<void>();
    const snapshot = deferred<typeof project>();
    engine.project = project;
    engine.buildFileTree(project);
    engine.socket = {
        isConnected: true, publicId: 'primary', disconnect() {}, async leaveDoc() {},
        async joinDoc(id: string) { return { lines: documents.get(id)!.split('\n'), version: 2 }; },
        async refreshProject() { snapshotStarted.resolve(); return snapshot.promise; },
    };
    for (const entry of engine.fileTree.values()) {
        if (entry.type !== 'doc') continue;
        const content = Buffer.from(documents.get(entry.id)!);
        await fs.writeFile(settings.getFilePath(entry.path).fsPath, content);
        engine.recordSynchronizedContent(entry, content);
    }
    return { directory, project, documents, engine, snapshot, snapshotStarted, settings };
}

async function testFailedSnapshotRetainsEvents(): Promise<void> {
    const f = await fixture();
    const gate = deferred<void>();
    f.engine.remoteEventQueue = gate.promise;
    f.documents.set('doc', 'A remote edit');
    f.engine.enqueueRemoteEvent((current: () => boolean) => f.engine.handleRemoteFileChanged({ doc: 'doc', v: 1 }, current));
    f.engine.enqueueRemoteEvent((current: () => boolean) => f.engine.handleRemoteFileRemoved('removed', current));
    const originalProject = f.engine.project;
    const refresh = f.engine.runWorkspaceExclusive(() => f.engine.refreshProjectFileTree());
    await f.snapshotStarted.promise;
    f.snapshot.reject(new Error('Secondary snapshot unavailable'));
    await assert.rejects(refresh, /Secondary snapshot unavailable/);
    assert.equal(f.engine.project, originalProject, 'a failed refresh must preserve the previous project');
    assert.ok(f.engine.fileTree.has('removed'), 'a failed refresh must preserve the previous tree');
    gate.resolve();
    await f.engine.remoteEventQueue;
    assert.equal(await fs.readFile(path.join(f.directory, 'main.tex'), 'utf8'), 'A remote edit');
    await assert.rejects(fs.stat(path.join(f.directory, 'removed.tex')), { code: 'ENOENT' });
    assert.equal(f.engine.fileTree.has('removed'), false);
    f.engine.disconnect();
}

async function testCreationDuringSnapshot(): Promise<void> {
    const f = await fixture();
    const refresh = f.engine.runWorkspaceExclusive(() => f.engine.refreshProjectFileTree());
    await f.snapshotStarted.promise;
    f.documents.set('created', 'created during snapshot');
    f.engine.enqueueRemoteEvent((current: () => boolean) => f.engine.handleRemoteFileCreated(
        'root', 'doc', { _id: 'created', name: 'created.tex' }, current));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.engine.fileTree.has('created'), false, 'primary metadata waits for the in-flight snapshot');
    f.snapshot.resolve(f.project); // Snapshot was captured before the creation.
    await refresh;
    await f.engine.remoteEventQueue;
    assert.equal(f.engine.fileTree.get('created')?.path, '/created.tex');
    assert.equal(await fs.readFile(path.join(f.directory, 'created.tex'), 'utf8'), 'created during snapshot');
    f.engine.disconnect();
}

async function testActiveHandlerAndDistinctScopes(): Promise<void> {
    const f = await fixture();
    f.documents.set('active', 'active before snapshot');
    assert.ok(f.engine.acquireLock('/active.tex'));
    f.engine.enqueueRemoteEvent((current: () => boolean) => f.engine.handleRemoteFileCreated(
        'root', 'doc', { _id: 'active', name: 'active.tex' }, current));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(f.engine.fileTree.has('active'), 'the primary handler must already be active before the refresh');
    assert.ok(f.engine.acquireLock('/main.tex'));
    assert.ok(f.engine.acquireLock('/second.tex'));
    const firstRefresh = f.engine.refreshProjectFileTree('/main.tex');
    const secondRefresh = f.engine.refreshProjectFileTree('/second.tex');
    await f.snapshotStarted.promise;
    const captured = structuredClone(f.project);
    captured.rootFolder[0].docs.push({ _id: 'second', name: 'second.tex' });
    f.snapshot.resolve(captured);
    await Promise.all([firstRefresh, secondRefresh]);
    assert.ok(f.engine.fileTree.has('active'), 'a path lookup must preserve unrelated active-handler metadata');
    assert.ok(f.engine.fileTree.has('second'), 'a distinct concurrent lookup must install its own scope');
    f.engine.releaseLock('/active.tex');
    f.engine.releaseLock('/main.tex');
    f.engine.releaseLock('/second.tex');
    await f.engine.remoteEventQueue;
    assert.equal(await fs.readFile(path.join(f.directory, 'active.tex'), 'utf8'), 'active before snapshot');
    f.engine.disconnect();
}

async function testDuplicateStructureEvents(): Promise<void> {
    const f = await fixture();
    let stateDeletes = 0;
    f.engine.stateStore = {
        entries: new Map([['/main.tex', { path: '/main.tex', id: 'doc', type: 'doc' }]]),
        put() {}, delete() { stateDeletes++; }, async flush() {},
    };
    f.engine.rebaseFileTree('/main.tex', '/main.tex');
    await f.engine.handleRemoteFileRenamed('doc', 'main.tex');
    await f.engine.handleRemoteFileMoved('doc', 'root');
    await f.engine.handleRemoteFileCreated('root', 'doc', { _id: 'doc', name: 'older-name.tex' });
    assert.equal(stateDeletes, 0, 'snapshot-included structure notifications must not remove the persisted ancestor');
    assert.equal(f.engine.fileTree.get('doc')?.path, '/main.tex');
    assert.equal(await fs.readFile(path.join(f.directory, 'main.tex'), 'utf8'), 'A');
    f.engine.disconnect();
}

async function testHandlersResolveMovedIdentityAfterWaiting(): Promise<void> {
    for (const operation of ['content', 'rename', 'move', 'delete', 'create']) {
        const f = await fixture();
        assert.ok(f.engine.acquireLock('/'));
        const pending = operation === 'content' ? f.engine.handleRemoteFileChanged({ doc: 'doc', v: 1 })
            : operation === 'rename' ? f.engine.handleRemoteFileRenamed('doc', 'final.tex')
                : operation === 'move' ? f.engine.handleRemoteFileMoved('doc', 'destination')
                    : operation === 'delete' ? f.engine.handleRemoteFileRemoved('doc')
                        : f.engine.handleRemoteFileCreated('root', 'doc', { _id: 'doc', name: 'main.tex' });
        await new Promise<void>(resolve => setImmediate(resolve));
        const updated: any = structuredClone(f.project);
        updated.rootFolder[0].docs[0].name = 'moved.tex';
        updated.rootFolder[0].docs.push({ _id: 'other', name: 'main.tex' });
        updated.rootFolder[0].folders.push({ _id: 'destination', name: 'destination', docs: [], folders: [], fileRefs: [] });
        f.engine.buildFileTree(updated);
        await fs.rename(path.join(f.directory, 'main.tex'), path.join(f.directory, 'moved.tex'));
        await fs.writeFile(path.join(f.directory, 'main.tex'), 'Other document');
        await fs.mkdir(path.join(f.directory, 'destination'));
        f.engine.recordSynchronizedContent(f.engine.fileTree.get('doc'), Buffer.from('A'));
        f.engine.recordSynchronizedContent(f.engine.fileTree.get('other'), Buffer.from('Other document'));
        f.documents.set('doc', 'A remote edit');
        f.engine.releaseLock('/');
        await pending;
        assert.equal(await fs.readFile(path.join(f.directory, 'main.tex'), 'utf8'), 'Other document',
            `${operation}: a reused path belongs to the new entity and must not be touched`);
        if (operation === 'content') {
            assert.equal(await fs.readFile(path.join(f.directory, 'moved.tex'), 'utf8'), 'A remote edit');
        } else if (operation === 'rename') {
            assert.equal(await fs.readFile(path.join(f.directory, 'final.tex'), 'utf8'), 'A');
        } else if (operation === 'move') {
            assert.equal(await fs.readFile(path.join(f.directory, 'destination', 'moved.tex'), 'utf8'), 'A');
        } else if (operation === 'delete') {
            await assert.rejects(fs.stat(path.join(f.directory, 'moved.tex')), { code: 'ENOENT' });
        }
        assert.equal(f.engine.syncLock.size, 0, `${operation}: the previous and current path locks must be released`);
        f.engine.disconnect();
    }
}

async function testFullSnapshotReconcilesRenameBeforeCleanup(): Promise<void> {
    const f = await fixture();
    const store = new SyncStateStore(f.directory, 'cleanup-rename', error => { throw error; });
    await store.load();
    f.engine.stateStore = store;
    f.engine.recordSynchronizedContent(f.engine.fileTree.get('doc'), Buffer.from('A'));
    const updated = structuredClone(f.project);
    updated.rootFolder[0].docs[0].name = 'renamed.tex';
    const refresh = f.engine.runWorkspaceExclusive(() => f.engine.refreshProjectFileTree());
    await f.snapshotStarted.promise;
    f.snapshot.resolve(updated);
    await refresh;
    await assert.rejects(fs.stat(path.join(f.directory, 'main.tex')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(f.directory, 'renamed.tex'), 'utf8'), 'A');
    assert.equal(store.entries.get('/renamed.tex')?.id, 'doc');
    await f.engine.handleRemoteFileRenamed('doc', 'renamed.tex');
    f.documents.set('doc', 'A after rename');
    await f.engine.handleRemoteFileChanged({ doc: 'doc', v: 1 });
    assert.equal(await fs.readFile(path.join(f.directory, 'renamed.tex'), 'utf8'), 'A after rename');
    await assert.rejects(fs.stat(path.join(f.directory, 'main.tex')), { code: 'ENOENT' });
    await store.flush();
    f.engine.disconnect();
}

async function testSnapshotIncludedDeletion(): Promise<void> {
    const f = await fixture();
    const folder: any = { _id: 'folder', name: 'folder', docs: [{ _id: 'child', name: 'child.tex' }], folders: [], fileRefs: [] };
    const initial: any = structuredClone(f.project);
    initial.rootFolder[0].folders.push(folder);
    f.engine.buildFileTree(initial);
    await fs.mkdir(path.join(f.directory, 'folder'));
    await fs.writeFile(path.join(f.directory, 'folder', 'child.tex'), 'child');
    f.engine.recordSynchronizedContent(f.engine.fileTree.get('child'), Buffer.from('child'));
    const refresh = f.engine.runWorkspaceExclusive(() => f.engine.refreshProjectFileTree());
    await f.snapshotStarted.promise;
    f.engine.enqueueRemoteEvent((current: () => boolean) => f.engine.handleRemoteFileRemoved('folder', current));
    f.snapshot.resolve(f.project); // The snapshot already includes the folder's removal.
    await refresh;
    await f.engine.remoteEventQueue;
    await assert.rejects(fs.stat(path.join(f.directory, 'folder')), { code: 'ENOENT' });

    const removed = f.engine.fileTree.get('removed');
    const replacement = structuredClone(f.project);
    replacement.rootFolder[0].docs[1]._id = 'replacement';
    f.engine.buildFileTree(replacement);
    await f.engine.handleRemoteFileRemoved(removed.id);
    assert.equal(await fs.readFile(path.join(f.directory, 'removed.tex'), 'utf8'), 'old content',
        'a deleted identity must not delete a path now occupied by a different entity');
    f.engine.disconnect();
}

async function run(): Promise<void> {
    await testFailedSnapshotRetainsEvents();
    await testCreationDuringSnapshot();
    await testActiveHandlerAndDistinctScopes();
    await testDuplicateStructureEvents();
    await testHandlersResolveMovedIdentityAfterWaiting();
    await testFullSnapshotReconcilesRenameBeforeCleanup();
    await testSnapshotIncludedDeletion();
    console.log('Synchronization refresh audit regression tests passed.');
}

async function main(): Promise<void> {
    try { await run(); } finally {
        for (const engine of engines) engine.disconnect();
        await cleanTemporaryWorkspaces();
    }
}
runStandaloneTest(main);
