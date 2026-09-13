import { runStandaloneTest } from './standaloneRunner';
/** Filesystem regression checks for durable synchronization state. */
import './nativeSyncFixture'; // Load the shared VS Code adapter before path safety helpers.
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { SyncStateEntry, SyncStateStore } from '../sync/syncStateStore';
import { cleanTemporaryWorkspaces, createTemporaryWorkspace } from './temporaryWorkspace';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

async function run(): Promise<void> {
    const directory = await createTemporaryWorkspace('sync-storage-audit');
    const failures: string[] = [];
    const content = Buffer.from('saved ancestor');
    const ancestor: SyncStateEntry = {
        path: '/main.tex', id: 'doc', type: 'doc', hash: digest(content),
        content: content.toString('base64'), version: 1,
    };
    const makeStore = (identity: string) => new SyncStateStore(directory, identity,
        error => failures.push(error.message));
    const store = makeStore('unchanged-state');
    await store.load();
    const originalOpen = fs.open;
    let writes = 0;
    fs.open = async (...args: Parameters<typeof fs.open>) => {
        writes++;
        return originalOpen(...args);
    };
    try {
        store.put(ancestor);
        await store.flush();
        store.put({ ...ancestor });
        await store.flush();
        assert.equal(writes, 1, 'an unchanged ancestor must not repeatedly write and fsync the state file');
        store.put({ ...ancestor, version: 2 });
        await store.flush();
        assert.equal(writes, 2, 'a new document version must still be persisted');
    } finally {
        fs.open = originalOpen;
    }

    const reloaded = makeStore('unchanged-state');
    await reloaded.load();
    assert.equal(reloaded.entries.get('/main.tex')?.version, 2);
    const stateDirectory = path.join(directory, 'sync-v1', digest('unchanged-state'));
    await fs.writeFile(path.join(stateDirectory, digest('/invalid.tex') + '.json'), JSON.stringify({
        schema: 1, entry: { path: '/invalid.tex', id: 'invalid', type: 'doc', version: -1 },
    }));
    await assert.rejects(reloaded.load(), /Invalid synchronization ancestor/);
    assert.equal(reloaded.entries.size, 1, 'a failed load must not expose partial state');
    assert.equal(reloaded.entries.get('/main.tex')?.version, 2);

    const journal = makeStore('journal');
    await journal.load();
    const intent: Extract<NonNullable<SyncStateEntry['intent']>, { kind: 'write' }> = {
        kind: 'write', before: ancestor.content!, desired: Buffer.from('desired text').toString('base64'),
        local: Buffer.from('local text').toString('base64'), version: 1, sources: ['initial-connection'],
    };
    journal.put({ ...ancestor, intent });
    intent.sources.push('changed-after-queueing');
    await journal.flush();
    const restoredJournal = makeStore('journal');
    await restoredJournal.load();
    const restoredIntent = restoredJournal.entries.get('/main.tex')?.intent;
    assert.ok(restoredIntent?.kind === 'write');
    assert.deepEqual(restoredIntent.sources, ['initial-connection'], 'queued journal contents must own their source list');
    journal.put({ ...ancestor, intent: { ...intent, confirmed: true } });
    await journal.flush();
    await restoredJournal.load();
    assert.equal(restoredJournal.entries.get('/main.tex')?.intent?.kind, 'write');
    assert.deepEqual(restoredJournal.entries.get('/main.tex')?.intent, { ...intent, confirmed: true });

    const broken = makeStore('failed-write');
    await broken.load();
    fs.open = async (...args: Parameters<typeof fs.open>) => {
        const file = await originalOpen(...args);
        file.sync = async () => { throw new Error('simulated fsync failure'); };
        return file;
    };
    try {
        broken.put(ancestor);
        await assert.rejects(broken.flush(), /simulated fsync failure/);
    } finally {
        fs.open = originalOpen;
    }
    const files = await fs.readdir(path.join(directory, 'sync-v1', digest('failed-write')));
    assert.equal(files.filter(filename => filename.endsWith('.tmp')).length, 0,
        'failed synchronization state writes must not leave temporary files behind');
    assert.deepEqual(failures, ['simulated fsync failure']);
    console.log('Synchronization storage audit regression tests passed.');
}

async function main(): Promise<void> {
    try { await run(); } finally { await cleanTemporaryWorkspaces(); }
}
runStandaloneTest(main);
