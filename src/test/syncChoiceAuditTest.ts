/** Background catch-up must not repeat unchanged local-file decisions. */
import { SyncEngine, TestUri } from './nativeSyncFixture';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { cleanTemporaryWorkspaces, createTemporaryWorkspace } from './temporaryWorkspace';
import { runStandaloneTest } from './standaloneRunner';

const engines = new Set<{ disconnect(): void }>();

async function fixture() {
    const directory = await createTemporaryWorkspace('sync-choice-audit');
    const project = {
        _id: 'project', name: 'Choice fixture',
        rootFolder: [{ _id: 'root', name: '', docs: [], fileRefs: [], folders: [] }],
    };
    const settings = {
        getWorkspaceFolder: () => TestUri.file(directory),
        getSettings: () => ({ serverUrl: 'https://example.invalid', projectId: 'project', autoSync: true }),
        getFilePath: (relative: string) => TestUri.file(path.join(directory, relative)),
        getRelativePath: (uri: InstanceType<typeof TestUri>) => '/' + path.relative(directory, uri.fsPath).replaceAll('\\', '/'),
        async updateLastSynced() {},
    };
    const api = { dispose() {}, async getProjectDetails() { return { type: 'success', projectData: project }; } };
    const engine: any = new SyncEngine(api, settings);
    engines.add(engine);
    engine.project = project;
    engine.buildFileTree(project);
    let reconnects = 0;
    engine.socket = {
        isConnected: true,
        disconnect() {},
        async reconnect() { reconnects++; return project; },
    };
    await engine.ignoreParser.load();
    let nextChoice: string | undefined;
    const prompts: string[] = [];
    const scheduled: Promise<void>[] = [];
    engine.scheduleOperation = (operation: () => Promise<void>) => {
        scheduled.push(Promise.resolve().then(operation));
    };
    const request = engine.requestBackgroundChoice.bind(engine);
    engine.requestBackgroundChoice = (
        key: string,
        _prompt: unknown,
        apply: (choice: string | undefined) => Promise<void>,
        fingerprint?: string,
    ) => request(key, () => {
        prompts.push(key);
        return Promise.resolve(nextChoice);
    }, apply, fingerprint);
    const drain = async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        while (scheduled.length) await Promise.all(scheduled.splice(0));
    };
    return {
        directory, engine, settings, prompts, drain,
        choose(value: string | undefined) { nextChoice = value; },
        reconnects: () => reconnects,
        async pull(review = false) { await engine.pullAll(review); await drain(); },
    };
}

async function testDismissedAndChangedLocalBatches(): Promise<void> {
    const f = await fixture();
    await fs.writeFile(path.join(f.directory, 'new.txt'), 'local contents');
    await f.pull();
    assert.deepEqual(f.prompts, ['local-only-files']);
    await f.pull();
    await f.pull();
    assert.equal(f.prompts.length, 1, 'dismissed unchanged files must remain quiet during background catch-up');
    f.choose('Ignore');
    await f.pull(true);
    assert.equal(f.prompts.length, 2, 'manual Sync Now must allow reviewing the same files');
    await f.pull();
    assert.equal(f.prompts.length, 2, 'Ignore must be retained for this session');
    await fs.writeFile(path.join(f.directory, 'new.txt'), 'changed contents');
    await f.pull();
    assert.equal(f.prompts.length, 3, 'a changed saved revision must be reviewable');
    await fs.rename(path.join(f.directory, 'new.txt'), path.join(f.directory, 'renamed.txt'));
    await f.pull();
    assert.equal(f.prompts.length, 4, 'a renamed path must be reviewable even with the same contents');
    f.engine.getOpenTextDocument = () => ({ isDirty: true, getText: () => 'unsaved changed contents' });
    await f.pull();
    assert.equal(f.prompts.length, 5, 'unsaved editor changes must also invalidate a previous decision');
    await f.pull();
    assert.equal(f.prompts.length, 5);
    assert.equal(f.reconnects(), 0);
}

async function testFailedUploadsStayVisible(): Promise<void> {
    const f = await fixture();
    await fs.writeFile(path.join(f.directory, 'new.txt'), 'local contents');
    f.choose('Upload All');
    let uploads = 0;
    f.engine.uploadLocalFile = async () => { uploads++; throw new Error('HTTP 503 test upload failure'); };
    await f.pull();
    assert.equal(uploads, 1);
    assert.match(f.engine.fileErrors.get('/new.txt'), /HTTP 503 test upload failure/);
    assert.equal(f.engine.status, 'error');
    await f.pull();
    await f.pull();
    assert.equal(f.prompts.length, 1, 'a failed approved upload must not generate repeated background prompts');
    assert.equal(uploads, 1, 'a healthy transport must not retry a file failure indefinitely');
    assert.equal(f.engine.status, 'error', 'suppressing the repeated prompt must retain the actionable error');
    assert.equal(f.engine.automaticRecoveryScheduled, false);
    assert.equal(f.reconnects(), 0);
    await f.pull(true);
    assert.equal(uploads, 2, 'explicit review can retry the failed upload');
}

async function testOrphanDecisions(): Promise<void> {
    const f = await fixture();
    await fs.writeFile(path.join(f.directory, 'old.txt'), 'locally edited contents');
    f.engine.setBaseContent('/old.txt', Buffer.from('old synchronized contents'));
    await f.pull();
    assert.deepEqual(f.prompts, ['orphaned-files']);
    assert.equal(f.engine.baseContent.has('/old.txt'), true, 'dismissing a deletion choice must preserve its ancestor');
    await f.pull();
    assert.equal(f.prompts.length, 1);
    f.choose('Keep Locally');
    await f.pull(true);
    assert.equal(f.prompts.length, 2);
    assert.equal(f.engine.baseContent.has('/old.txt'), false);
    await f.pull();
    assert.equal(f.prompts.length, 2, 'Keep Locally must not immediately prompt to upload the same retained files');
    assert.equal(await fs.readFile(path.join(f.directory, 'old.txt'), 'utf8'), 'locally edited contents');
    await fs.writeFile(path.join(f.directory, 'old.txt'), 'new local contents');
    await f.pull();
    assert.equal(f.prompts.length, 3, 'editing a retained local-only copy makes it eligible for review');
}

runStandaloneTest(async () => {
    try {
        await testDismissedAndChangedLocalBatches();
        await testFailedUploadsStayVisible();
        await testOrphanDecisions();
        console.log('Background file-choice deduplication and visible failure tests passed.');
    } finally {
        for (const engine of engines) engine.disconnect();
        await cleanTemporaryWorkspaces();
    }
});
