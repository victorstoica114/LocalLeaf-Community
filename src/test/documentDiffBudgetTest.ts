/** Large saved revisions must remain synchronizable when a fine diff is too costly. */
import { SyncEngine, TestUri, promptMessages } from './nativeSyncFixture';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { promises as fs, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { textOperations, TextOperation } from '../sync/textMerge';
import { MAX_REMOTE_DOCUMENT_OPERATIONS } from '../utils/remoteValidation';
import { cleanTemporaryWorkspaces, createTemporaryWorkspace } from './temporaryWorkspace';
import { runStandaloneTest } from './standaloneRunner';

// Overleaf's independently maintained OT implementation validates both deleted
// text and the sequential UTF-16 positions used by the actual server.
const textType = require(path.resolve(__dirname, '../../src/test/vendor/overleaf-text/text.js')) as {
    apply(content: string, operations: TextOperation[]): string;
    transform(operations: TextOperation[], other: TextOperation[], side: 'left' | 'right'): TextOperation[];
};
const prefix = '\\documentclass{article}\n% untouched opening 😀\n';
const suffix = '\n% untouched ending 🧪\n\\end{document}\n';
const rows = (label: string, count: number) => Array.from({ length: count }, (_, index) => `${label} ${index}\n`).join('');

function withClock<T>(advance: number, action: () => T): T {
    const original = Date.now;
    let tick = 1_700_000_000_000;
    Date.now = () => { tick += advance; return tick; };
    try { return action(); } finally { Date.now = original; }
}

function checkOperations(before: string, after: string, operations: TextOperation[], label: string): void {
    assert.ok(operations.length <= MAX_REMOTE_DOCUMENT_OPERATIONS, `${label}: operation count must fit the transport contract`);
    for (const operation of operations) {
        assert.ok(Number.isSafeInteger(operation.p) && operation.p >= 0, `${label}: offsets must be nonnegative UTF-16 integers`);
        assert.notEqual(operation.i !== undefined, operation.d !== undefined, `${label}: each component inserts or deletes`);
        assert.ok((operation.i ?? operation.d ?? '').length > 0, `${label}: no empty components`);
        for (const character of operation.i ?? operation.d ?? '') {
            assert.ok(character.length > 1 || character.charCodeAt(0) < 0xd800 || character.charCodeAt(0) > 0xdfff,
                `${label}: an edit must not split a valid Unicode surrogate pair`);
        }
    }
    assert.equal(textType.apply(before, operations), after, `${label}: the server must reproduce the exact saved text`);
}

function checkCase(before: string, after: string, label: string, protectedPrefix = 0, protectedSuffix = 0): TextOperation[] {
    const operations = textOperations(before, after);
    checkOperations(before, after, operations, label);
    let current = before;
    for (const operation of operations) {
        assert.ok(operation.p >= protectedPrefix, `${label}: an unchanged opening must not be rewritten`);
        assert.ok(operation.p + (operation.d?.length ?? 0) <= current.length - protectedSuffix,
            `${label}: an unchanged ending must not be rewritten`);
        current = textType.apply(current, [operation]);
    }
    return operations;
}

function testLargeRevisions(): void {
    const cases: Array<[string, string, string]> = [
        [rows('old row', 17_000), rows('new row', 17_000), '17,000 rewritten lines'],
        ['a'.repeat(40_000), 'b'.repeat(40_000), 'more than 8,192 changed characters in one line'],
        [rows('old citation', 10_000), rows('new citation', 3_000), 'large deletion and replacement'],
        ['repeat\n'.repeat(12_000), 'updated\n'.repeat(12_000), 'repeated lines'],
        ['😀 old 🧪\n'.repeat(9_000), '😃 new 🔬\n'.repeat(9_000), 'UTF-16 emoji across a large replacement'],
        ['a|'.repeat(6_001), 'b|'.repeat(6_001), 'many separated changes'],
    ];
    for (const [oldBody, newBody, label] of cases) {
        checkCase(prefix + oldBody + suffix, prefix + newBody + suffix, label, prefix.length, suffix.length);
    }
    checkCase('', '😀 new document\n', 'empty-document insertion');
    checkCase('😀 old document\n', '', 'whole-document deletion');
    checkCase('unchanged\n', 'unchanged\n', 'unchanged document');
    const bigUnchanged = rows('unchanged', 20_000);
    const eol = checkCase(bigUnchanged, bigUnchanged.slice(0, -1), 'one final newline deletion', bigUnchanged.length - 1);
    assert.equal(eol.length, 1, 'a final-newline change must remain a small edit');
    checkCase('prefix 😀 suffix', 'prefix 😃 suffix', 'shared surrogate prefix', 7, 7);
    checkCase('prefix ' + String.fromCodePoint(0x1f600) + ' suffix',
        'prefix ' + String.fromCodePoint(0x1fa00) + ' suffix', 'shared surrogate suffix', 7, 7);
}

function testPreservedAnchors(): void {
    const anchor = '\n% DISTINCT UNCHANGED ANCHOR: a colleague may edit here 😀\n';
    const before = prefix + rows('old first block', 5_000) + anchor + rows('old last block', 5_000) + suffix;
    const after = prefix + rows('new first block', 5_000) + anchor + rows('new last block', 5_000) + suffix;
    const operations = checkCase(before, after, 'two large edits surrounding a shared anchor', prefix.length, suffix.length);
    let current = before;
    for (const operation of operations) {
        if (operation.d !== undefined) {
            const start = current.indexOf(anchor);
            assert.ok(start >= 0);
            assert.ok(operation.p + operation.d.length <= start || operation.p >= start + anchor.length,
                'a unique unchanged line between independent large edits must remain an OT anchor');
        }
        current = textType.apply(current, [operation]);
    }
    const insertion = [{ p: before.indexOf('a colleague'), i: 'ANOTHER CLIENT: ' }];
    const withConcurrentEdit = textType.apply(before, insertion);
    const transformed = textType.transform(operations, insertion, 'left');
    assert.equal(textType.apply(withConcurrentEdit, transformed), after.replace('a colleague', 'ANOTHER CLIENT: a colleague'),
        'an independent concurrent edit inside the retained anchor must survive the large local update');
    const deletion = [{ p: before.indexOf('colleague '), d: 'colleague ' }];
    assert.equal(textType.apply(textType.apply(before, deletion), textType.transform(operations, deletion, 'left')),
        after.replace('colleague ', ''), 'a concurrent deletion in the retained anchor must not be reintroduced');
}

function testSparseEditsInLongLine(): void {
    const before = 'A' + 'x'.repeat(40_000) + 'Z';
    const after = 'B' + 'x'.repeat(40_000) + 'Y';
    const operations = checkCase(before, after, 'two small edits surrounding 40,000 unchanged characters');
    const position = 20_000;
    const deletion = [{ p: position, d: 'x' }];
    assert.equal(textType.apply(textType.apply(before, deletion), textType.transform(operations, deletion, 'left')),
        after.slice(0, position) + after.slice(position + 1),
        'a long unchanged line interior must retain a concurrent deletion despite exceeding the former fine-diff size threshold');
    const insertion = [{ p: position, i: 'CONCURRENT EDIT' }];
    assert.equal(textType.apply(textType.apply(before, insertion), textType.transform(operations, insertion, 'left')),
        after.slice(0, position) + 'CONCURRENT EDIT' + after.slice(position),
        'a concurrent insertion must remain at its original interior position between the two small local edits');
}

function testFragmentedDiffResult(): void {
    // A valid fine diff can contain too many OT components even when its edit
    // distance is small. Force that result independently of machine speed and
    // jsdiff's timeout so the protocol-cap regression is deterministic.
    const filename = require.resolve('../sync/textMerge');
    const realRequire = createRequire(filename);
    let fragmentedResults = 0;
    const fragment = (before: string, after: string) => {
        assert.equal(before.length, after.length);
        const changes: Array<{ value: string; count: number; added?: boolean; removed?: boolean }> = [];
        for (let index = 0; index < before.length; index++) {
            if (before[index] === after[index]) changes.push({ value: before[index], count: 1 });
            else {
                changes.push({ value: before[index], count: 1, removed: true });
                changes.push({ value: after[index], count: 1, added: true });
            }
        }
        if (changes.filter(change => change.added || change.removed).length > MAX_REMOTE_DOCUMENT_OPERATIONS) fragmentedResults++;
        return changes;
    };
    const exported: { textOperations?: typeof textOperations } = {};
    runInNewContext(readFileSync(filename, 'utf8'), {
        exports: exported, module: { exports: exported }, __dirname: path.dirname(filename), __filename: filename,
        require: (name: string) => name === 'diff' ? { ...realRequire(name), diffChars: fragment } : realRequire(name),
        Buffer, TextDecoder, TextEncoder, setTimeout, clearTimeout,
    }, { filename });
    const before = 'a|'.repeat(6_001);
    const after = 'b|'.repeat(6_001);
    checkOperations(before, after, exported.textOperations!(before, after), 'a fine diff producing more than 10,000 components');
    assert.ok(fragmentedResults > 0, 'the fragmented-diff branch must actually be exercised');
}

function testDeterministicReplay(): void {
    const cases = [
        [prefix + 'small original text 😀' + suffix, prefix + 'small revised text 😃' + suffix],
        [prefix + rows('old row', 17_000) + suffix, prefix + rows('new row', 17_000) + suffix],
        [rows('old block', 6_000) + 'UNCHANGED ANCHOR\n' + rows('old ending', 6_000),
            rows('new block', 6_000) + 'UNCHANGED ANCHOR\n' + rows('new ending', 6_000)],
    ];
    for (const [before, after] of cases) {
        const steady = withClock(0, () => textOperations(before, after));
        const delayed = withClock(60_000, () => textOperations(before, after));
        const backwards = withClock(-60_000, () => textOperations(before, after));
        checkOperations(before, after, delayed, 'clock-independent replay');
        assert.deepEqual(delayed, steady, 'a stalled clock schedule must not change the journal replay operation');
        assert.deepEqual(backwards, steady, 'a clock adjustment must not change the journal replay operation');
    }
}

function testRealFragmentedRevision(): void {
    const regionCount = 6_001;
    const importantAnchor = '% LARGE PRESERVED ANCHOR ' + 'unchanged text '.repeat(128) + '\n';
    const makeDocument = (label: string) => Array.from({ length: regionCount }, (_, index) =>
        `${label} row ${index}\nUNIQUE ANCHOR ${index}\n${index === 3_000 ? importantAnchor : ''}`).join('');
    const before = makeDocument('old');
    const after = makeDocument('new');
    assert.ok(Buffer.byteLength(before) + Buffer.byteLength(after) < 2 * 1024 * 1024,
        'the fragmented-edit fixture must remain a normal editable-document size');
    const operations = withClock(0, () => textOperations(before, after));
    checkOperations(before, after, operations, '6,001 real edit regions separated by unique unchanged lines');
    assert.equal(operations.length, MAX_REMOTE_DOCUMENT_OPERATIONS,
        'the real fragmented revision must reach compaction and retain as many regions as the OT cap permits');
    assert.deepEqual(withClock(60_000, () => textOperations(before, after)), operations,
        'compaction of real edits must select the same retained anchors during replay');
    const position = before.indexOf(importantAnchor) + '% LARGE PRESERVED ANCHOR '.length;
    const deletion = [{ p: position, d: 'unchanged ' }];
    assert.equal(textType.apply(textType.apply(before, deletion), textType.transform(operations, deletion, 'left')),
        after.slice(0, position) + after.slice(position + 'unchanged '.length),
        'compaction must preserve a concurrent deletion inside a large retained unchanged region');
}

async function testSyncEngineUpload(): Promise<void> {
    const directory = await createTemporaryWorkspace('document-diff-budget');
    const root = TestUri.file(directory);
    const before = prefix + rows('old row', 17_000) + suffix;
    const after = prefix + rows('new row', 17_000) + suffix;
    const project = { _id: 'project', name: 'Large-document regression', rootDoc_id: 'doc', rootFolder: [
        { _id: 'root', name: '', docs: [{ _id: 'doc', name: 'main.tex' }], fileRefs: [], folders: [] },
    ] };
    const settings = {
        getWorkspaceFolder: () => root,
        getSettings: () => ({ serverUrl: 'https://example.invalid', projectId: 'project', autoSync: true }),
        getFilePath: (relative: string) => TestUri.file(path.join(directory, relative)),
        getRelativePath: (uri: TestUri) => '/' + path.relative(directory, uri.fsPath).replaceAll('\\', '/'),
    };
    const api = { dispose() {} };
    const engine = new SyncEngine(api, settings, undefined, TestUri.file(path.join(directory, '.state')));
    const errors: string[] = [];
    const subscription = engine.onStatusChange((event: { status: string; message?: string }) => {
        if (event.status === 'error') errors.push(event.message || 'Unknown synchronization error');
    });
    const promptCount = promptMessages.length;
    let content = before;
    let version = 1;
    let requests = 0;
    try {
        await engine.stateStore.load();
        engine.project = project;
        engine.buildFileTree(project);
        engine.socket = {
            isConnected: true, publicId: 'large-diff-client', disconnect() {},
            async joinDoc() { return { lines: content.split('\n'), version }; },
            async applyOtUpdate(id: string, update: { v: number; op: TextOperation[] }) {
                requests++;
                assert.equal(id, 'doc');
                assert.equal(update.v, version);
                const journal = engine.stateStore.entries.get('/main.tex');
                assert.equal(journal.intent.kind, 'write', 'a large update must still journal before the mutation');
                assert.equal(Buffer.from(journal.intent.desired, 'base64').toString('utf8'), after);
                checkOperations(content, after, update.op, 'real engine document update');
                content = textType.apply(content, update.op);
                version++;
            },
        };
        await fs.writeFile(settings.getFilePath('/main.tex').fsPath, before);
        engine.recordSynchronizedContent(engine.fileTree.get('doc'), Buffer.from(before));
        await engine.stateStore.flush();
        await fs.writeFile(settings.getFilePath('/main.tex').fsPath, after);
        await engine.handleLocalFileChange(settings.getFilePath('/main.tex'));
        await engine.stateStore.flush();
        assert.equal(content, after, 'a large saved local revision must reach Overleaf');
        assert.equal(await fs.readFile(settings.getFilePath('/main.tex').fsPath, 'utf8'), after);
        assert.equal(requests, 1, 'one saved revision must produce one versioned OT request');
        assert.equal(engine.stateStore.entries.get('/main.tex').intent, undefined);
        assert.equal(Buffer.from(engine.stateStore.entries.get('/main.tex').content, 'base64').toString('utf8'), after);
        assert.deepEqual(errors, [], 'a fine-diff budget must not appear as a synchronization error');
        assert.equal(promptMessages.length, promptCount, 'a one-sided large save needs no conflict decision');
    } finally {
        subscription.dispose();
        engine.disconnect();
        await engine.stateStore.flush();
    }
}

async function testLostAcknowledgementReplay(): Promise<void> {
    for (const committedBeforeDisconnect of [false, true]) {
        const directory = await createTemporaryWorkspace('document-diff-replay');
        const root = TestUri.file(directory);
        const before = prefix + rows('old row', 17_000) + suffix;
        const desired = prefix + rows('new row', 17_000) + suffix;
        const project = { _id: 'project', name: 'Large-document replay', rootDoc_id: 'doc', rootFolder: [
            { _id: 'root', name: '', docs: [{ _id: 'doc', name: 'main.tex' }], fileRefs: [], folders: [] },
        ] };
        const settings = {
            getWorkspaceFolder: () => root,
            getSettings: () => ({ serverUrl: 'https://example.invalid', projectId: 'project', autoSync: true }),
            getFilePath: (relative: string) => TestUri.file(path.join(directory, relative)),
            getRelativePath: (uri: TestUri) => '/' + path.relative(directory, uri.fsPath).replaceAll('\\', '/'),
        };
        const instances: any[] = [];
        const makeEngine = async (advance: number) => {
            const engine = new SyncEngine({ dispose() {} }, settings, undefined, TestUri.file(path.join(directory, '.state')));
            instances.push(engine);
            await engine.stateStore.load();
            engine.project = project;
            engine.buildFileTree(project);
            const calculate = engine.calculateOps.bind(engine);
            engine.calculateOps = (oldText: string, newText: string) => withClock(advance, () => calculate(oldText, newText));
            return engine;
        };
        let remote = before;
        let version = 7;
        let commits = 0;
        let firstOperations: TextOperation[] | undefined;
        const promptCount = promptMessages.length;
        try {
            const initial = await makeEngine(0);
            const firstSocket = {
                isConnected: true, publicId: 'original-client', disconnect() {},
                async joinDoc() { return { lines: remote.split('\n'), version }; },
                async applyOtUpdate(_id: string, update: { v: number; op: TextOperation[] }) {
                    assert.equal(update.v, 7);
                    firstOperations = update.op.map(operation => ({ ...operation }));
                    checkOperations(before, desired, firstOperations, 'initial interrupted update');
                    if (committedBeforeDisconnect) {
                        remote = textType.apply(remote, update.op);
                        version++;
                        commits++;
                    }
                    firstSocket.isConnected = false;
                    throw new Error('simulated lost acknowledgement');
                },
            };
            initial.socket = firstSocket;
            await fs.writeFile(settings.getFilePath('/main.tex').fsPath, desired);
            initial.recordSynchronizedContent(initial.fileTree.get('doc'), Buffer.from(before));
            await initial.stateStore.flush();
            const originalError = console.error;
            const observedErrors: string[] = [];
            console.error = (...messages: unknown[]) => { observedErrors.push(messages.map(String).join(' ')); };
            try {
                await assert.rejects(initial.pushDocumentChanges('doc', '/main.tex', Buffer.from(desired), false),
                    /simulated lost acknowledgement/);
            } finally { console.error = originalError; }
            assert.ok(observedErrors.some(message => message.includes('simulated lost acknowledgement')));
            await initial.stateStore.flush();
            const pending = initial.stateStore.entries.get('/main.tex').intent;
            assert.equal(pending.kind, 'write');
            assert.equal(pending.version, 7);
            assert.equal(Buffer.from(pending.before, 'base64').toString('utf8'), before);
            assert.equal(Buffer.from(pending.desired, 'base64').toString('utf8'), desired);
            assert.deepEqual(pending.sources, ['original-client']);
            initial.disconnect();

            // A later remote edit means equality alone cannot identify the
            // committed write; the original source must suppress its duplicate.
            if (committedBeforeDisconnect) { remote += '% another client edited after the lost ACK\n'; version++; }
            const expected = remote === before ? desired : remote;
            const resumed = await makeEngine(60_000);
            let replayRequests = 0;
            resumed.socket = {
                isConnected: true, publicId: 'reconnected-client', disconnect() {},
                async joinDoc() { return { lines: remote.split('\n'), version }; },
                async applyOtUpdate(id: string, update: { v: number; op: TextOperation[]; dupIfSource?: string[] }) {
                    replayRequests++;
                    assert.equal(id, 'doc');
                    assert.equal(update.v, 7, 'replay must retain the original authoritative version');
                    assert.deepEqual(update.op, firstOperations, 'journal replay must reproduce identical OT despite a different clock schedule');
                    assert.deepEqual(update.dupIfSource, ['original-client']);
                    assert.deepEqual(resumed.stateStore.entries.get('/main.tex').intent.sources,
                        ['original-client', 'reconnected-client'], 'the new source must be durable before replay');
                    if (!committedBeforeDisconnect) {
                        remote = textType.apply(remote, update.op);
                        version++;
                        commits++;
                    }
                },
            };
            await resumed.recoverDocumentIntent(resumed.fileTree.get('doc'));
            await resumed.stateStore.flush();
            assert.equal(replayRequests, 1);
            assert.equal(commits, 1, 'an interrupted update must commit exactly once');
            assert.equal(remote, expected);
            assert.equal(await fs.readFile(settings.getFilePath('/main.tex').fsPath, 'utf8'), expected);
            assert.equal(resumed.stateStore.entries.get('/main.tex').intent, undefined);
            assert.equal(Buffer.from(resumed.stateStore.entries.get('/main.tex').content, 'base64').toString('utf8'), expected);
            assert.equal(promptMessages.length, promptCount, 'replay of a known revision must not ask for conflict choices');
        } finally {
            for (const engine of instances) { engine.disconnect(); await engine.stateStore.flush(); }
        }
    }
}

async function main(): Promise<void> {
    try {
        testLargeRevisions();
        testPreservedAnchors();
        testSparseEditsInLongLine();
        testFragmentedDiffResult();
        testDeterministicReplay();
        testRealFragmentedRevision();
        await testSyncEngineUpload();
        await testLostAcknowledgementReplay();
        console.log('Document diff budget regressions passed: large edits, retained anchors, Unicode, OT cap, journaled upload and deterministic lost-ACK replay.');
    } finally {
        await cleanTemporaryWorkspaces();
    }
}
runStandaloneTest(main);
