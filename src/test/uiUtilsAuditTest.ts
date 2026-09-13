import { runStandaloneTest } from './standaloneRunner';
import * as assert from 'assert/strict';
import * as path from 'path';
import type * as vscode from 'vscode';

class TestUri {
    readonly scheme = 'file';
    readonly authority = '';
    readonly fsPath: string;
    constructor(readonly path: string) { this.fsPath = path; }
    toString(): string { return `file://${this.path}`; }
    static joinPath(base: TestUri, ...parts: string[]): TestUri {
        return new TestUri(path.posix.join(base.path, ...parts));
    }
}

class TestFileSystemError extends Error {
    constructor(readonly code: string) { super(code); }
}

interface DiskEntry { type: number; content?: Uint8Array }
const disk = new Map<string, DiskEntry>();
let failRename = false;
let duringTemporaryWrite: (() => void) | undefined;
const decorations: Array<{ uri: string; ranges: unknown[] }> = [];
const workspace = {
    workspaceFolders: [] as Array<{ uri: TestUri }>,
    fs: {
        async stat(uri: TestUri) {
            const entry = disk.get(uri.path);
            if (!entry) throw new TestFileSystemError('FileNotFound');
            return { type: entry.type, size: entry.content?.byteLength ?? 0 };
        },
        async createDirectory(uri: TestUri) { disk.set(uri.path, { type: 2 }); },
        async readFile(uri: TestUri) {
            const entry = disk.get(uri.path);
            if (!entry?.content) throw new TestFileSystemError('FileNotFound');
            return entry.content;
        },
        async writeFile(uri: TestUri, content: Uint8Array) {
            if (uri.path.endsWith('.tmp')) duringTemporaryWrite?.();
            disk.set(uri.path, { type: 1, content });
        },
        async rename(from: TestUri, to: TestUri) {
            if (failRename) throw new Error('Injected rename failure');
            const entry = disk.get(from.path);
            if (!entry) throw new TestFileSystemError('FileNotFound');
            disk.set(to.path, entry);
            disk.delete(from.path);
        },
        async delete(uri: TestUri) {
            if (!disk.delete(uri.path)) throw new TestFileSystemError('FileNotFound');
        },
        async readDirectory(uri: TestUri) {
            return [...disk].filter(([name]) => name !== uri.path && path.posix.dirname(name) === uri.path)
                .map(([name, entry]) => [path.posix.basename(name), entry.type]);
        },
    },
};
const editor = {
    document: {
        uri: new TestUri('/cursor/main.tex'),
        lineCount: 2,
        lineAt: () => ({ text: 'Text' }),
    },
    setDecorations: (_decoration: unknown, ranges: unknown[]) => {
        decorations.push({ uri: editor.document.uri.path, ranges });
    },
};
const disposable = { dispose() {} };
const vscodeMock = {
    Uri: TestUri,
    FileSystemError: TestFileSystemError,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    workspace,
    window: {
        visibleTextEditors: [editor],
        createTextEditorDecorationType: () => ({ dispose() {} }),
        onDidChangeTextEditorSelection: () => disposable,
        onDidChangeVisibleTextEditors: () => disposable,
    },
    MarkdownString: class {
        appendText() { return this; }
        appendMarkdown() { return this; }
    },
    Range: class { constructor(..._coordinates: unknown[]) {} },
    OverviewRulerLane: { Center: 2 },
    DecorationRangeBehavior: { ClosedClosed: 1 },
};
const moduleLoader = require('module') as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
};
const originalLoad = moduleLoader._load;
moduleLoader._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') return vscodeMock;
    return originalLoad.call(this, request, parent, isMain);
};

function uri(value: string): vscode.Uri { return new TestUri(value) as unknown as vscode.Uri; }
function readSettings(folder: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(disk.get(`${folder}/.localleaf/settings.json`)!.content!).toString('utf8'));
}

async function run(): Promise<void> {
    const { SettingsManager } = require('../utils/settingsManager') as typeof import('../utils/settingsManager');
    const { MainWebviewProvider } = require('../views/mainWebviewProvider') as typeof import('../views/mainWebviewProvider');
    const { ProjectsWebviewProvider } = require('../views/projectsWebviewProvider') as typeof import('../views/projectsWebviewProvider');
    const { CursorTracker } = require('../collaboration/cursorTracker') as typeof import('../collaboration/cursorTracker');
    const { createWindowFocusListener } = require('../utils/syncInitialization') as typeof import('../utils/syncInitialization');
    const { removeStandaloneLatexComments } = require('../utils/latexComments') as typeof import('../utils/latexComments');
    const unfinishedComment = '\\begin{comment}\n' + '% preserve\n'.repeat(200_000);
    assert.equal(removeStandaloneLatexComments(unfinishedComment).content, unfinishedComment,
        'an unterminated comment block must preserve large documents without exceeding the JavaScript argument limit');

    disk.set('/settings-a', { type: 2 });
    disk.set('/settings-b', { type: 2 });
    const manager = SettingsManager.getInstance(uri('/settings-a'));
    const settings = SettingsManager.createDefaultSettings('https://overleaf.example', 'project', 'Test');
    await manager.save(settings);
    SettingsManager.setCurrentWorkspaceFolder(uri('/settings-b'));
    let atomicWrites = 0;
    duringTemporaryWrite = () => {
        assert.equal(readSettings('/settings-a').projectId, 'project');
        atomicWrites++;
    };
    await Promise.all([
        manager.update({ mainTex: 'paper.tex', mainPdf: 'paper.pdf' }),
        manager.update({ autoSync: false }),
        manager.updateLastSynced(),
    ]);
    assert.equal(readSettings('/settings-a').mainTex, 'paper.tex', 'timestamp writes must retain concurrent main-document changes');
    assert.equal(readSettings('/settings-a').autoSync, false, 'timestamp writes must retain concurrent synchronization preferences');
    assert.equal(typeof readSettings('/settings-a').lastSynced, 'string');
    assert.equal(atomicWrites, 3);
    assert.equal(SettingsManager.getCurrentInstance()!.getWorkspaceFolder().path, '/settings-b',
        'background settings writes must not switch the active workspace');
    failRename = true;
    await assert.rejects(manager.update({ mainTex: 'failed.tex' }), /Injected rename failure/);
    failRename = false;
    assert.equal(readSettings('/settings-a').mainTex, 'paper.tex', 'failed publication must retain the previous valid settings');
    assert.equal([...disk.keys()].some(name => name.endsWith('.tmp')), false, 'failed publication must clean its temporary file');
    await manager.update({ mainTex: 'recovered.tex' });
    assert.equal(readSettings('/settings-a').mainTex, 'recovered.tex', 'a write error must not poison the settings mutation queue');
    duringTemporaryWrite = undefined;
    await Promise.all([manager.updateLastSynced(), manager.delete(), manager.updateLastSynced()]);
    assert.equal(disk.has('/settings-a/.localleaf/settings.json'), false, 'a queued timestamp after unlink must not recreate the settings');

    disk.set('/target-guard', { type: 2 });
    const guardedManager = SettingsManager.getInstance(uri('/target-guard'));
    await guardedManager.save(settings);
    const revokedTargets: Array<{ serverUrl?: string; projectId?: string }> = [];
    const targetSubscription = guardedManager.onWillChangeSyncTarget(() => {
        const previous = guardedManager.getSettings();
        revokedTargets.push({ serverUrl: previous?.serverUrl, projectId: previous?.projectId });
    });
    await guardedManager.updateLastSynced();
    await guardedManager.update({ mainTex: 'paper.tex', autoSync: false });
    assert.equal(revokedTargets.length, 0, 'ordinary preferences and timestamps must retain the current authorized session');
    disk.set('/target-guard/.localleaf/settings.json', {
        type: 1,
        content: Buffer.from(JSON.stringify({ ...settings, projectId: 'another-project' })),
    });
    await guardedManager.load().then(loaded => {
        assert.equal(loaded?.projectId, 'another-project');
        assert.deepEqual(revokedTargets, [{ serverUrl: settings.serverUrl, projectId: 'project' }],
            'the old session must be revoked synchronously before a reload exposes another project to asynchronous work');
    });
    await guardedManager.save({ ...settings, serverUrl: 'https://another.example', projectId: 'another-project' });
    assert.deepEqual(revokedTargets[1], { serverUrl: settings.serverUrl, projectId: 'another-project' },
        'changing only the server must revoke the old target before updating the cached settings');
    await guardedManager.delete();
    assert.deepEqual(revokedTargets[2], { serverUrl: 'https://another.example', projectId: 'another-project' },
        'unlink must revoke the cached session before its target disappears');
    targetSubscription.dispose();
    await guardedManager.save(settings);
    assert.equal(revokedTargets.length, 3, 'a disposed workspace listener must not retain a callback on later saves');

    const sidebar = Object.create(MainWebviewProvider.prototype) as any;
    let releaseFirstBuild!: (state: unknown) => void;
    let builds = 0;
    const published: unknown[] = [];
    sidebar.buildState = () => ++builds === 1
        ? new Promise(resolve => { releaseFirstBuild = resolve; })
        : Promise.resolve({ projectName: 'Current project' });
    sidebar.publishState = (state: unknown) => published.push(state);
    const firstRefresh = sidebar.refresh();
    const secondRefresh = sidebar.refresh();
    releaseFirstBuild({ projectName: 'Previous project' });
    await Promise.all([firstRefresh, secondRefresh]);
    assert.equal(builds, 2, 'a refresh during asynchronous reads must request one fresh snapshot');
    assert.deepEqual(published, [{ projectName: 'Current project' }], 'stale sidebar snapshots must never be published');

    workspace.workspaceFolders = [{ uri: new TestUri('/projects') }];
    const oldInspect = SettingsManager.inspectFolder;
    const oldFind = SettingsManager.findLinkedProjectFolders;
    const projectScans: Array<(projects: unknown) => void> = [];
    try {
        SettingsManager.inspectFolder = async () => ({ uri: uri('/projects'), kind: 'linked', settings });
        SettingsManager.findLinkedProjectFolders = () => new Promise(resolve => { projectScans.push(resolve as (projects: unknown) => void); });
        const browser = new ProjectsWebviewProvider(uri('/extension'), {} as never) as any;
        const older = browser.refresh();
        const newer = browser.refresh();
        const newerProjects = [{ uri: uri('/projects/new'), workspaceFolder: uri('/projects'), relativePath: 'new', settings }];
        projectScans[1](newerProjects);
        await newer;
        projectScans[0]([{ uri: uri('/projects/old'), workspaceFolder: uri('/projects'), relativePath: 'old', settings }]);
        await older;
        assert.deepEqual(browser.localProjects, newerProjects, 'a stale project scan must not replace action targets from the current view');
    } finally {
        SettingsManager.inspectFolder = oldInspect;
        SettingsManager.findLinkedProjectFolders = oldFind;
    }

    let now = 0;
    let catchUps = 0;
    const onFocus = createWindowFocusListener(() => { catchUps++; }, () => now);
    onFocus({ focused: true });
    onFocus({ focused: false });
    now = 29_999;
    onFocus({ focused: true });
    assert.equal(catchUps, 0, 'quick application switching must not trigger synchronization');
    onFocus({ focused: false });
    now = 60_000;
    onFocus({ focused: true });
    onFocus({ focused: true });
    assert.equal(catchUps, 1, 'returning after an absence must trigger exactly one catch-up');

    const fileTree = new Map([['doc', { type: 'doc', path: '/main.tex' }]]);
    let handlers: any;
    let remoteUsers: any[] = [];
    const socket = {
        publicId: 'local',
        registerHandlers: (value: unknown) => { handlers = value; },
        getConnectedUsers: async () => remoteUsers,
        updatePosition: async () => undefined,
    };
    const tracker = new CursorTracker(socket as never, SettingsManager.getInstance(uri('/cursor')), fileTree);
    await tracker.initialize();
    handlers.onUserCursorUpdated({ id: 'remote', user_id: 'user', name: 'Editor', email: 'editor@example.com', doc_id: 'doc', row: 1, column: 1 });
    assert.equal(tracker.getOnlineUsers()[0].docPath, '/main.tex');
    fileTree.set('doc', { type: 'doc', path: '/renamed.tex' });
    assert.equal(tracker.getOnlineUsers()[0].docPath, '/renamed.tex', 'collaborator paths must follow the live synchronized tree after renames');
    assert.equal(decorations.at(-1)!.ranges.length, 0, 'renaming must remove a collaborator decoration from the old document');
    fileTree.delete('doc');
    assert.equal(tracker.getOnlineUsers()[0].docPath, undefined, 'removed documents must not remain jump targets');
    remoteUsers = [];
    handlers.onConnected('new-local');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(tracker.getUserCount(), 0, 'reconnect must remove collaborators who left during the outage');
    tracker.dispose();
    console.log('UI and settings audit tests passed: atomic/concurrent settings, stale UI refreshes, focus recovery, collaborator lifecycle.');
}

runStandaloneTest(async () => {
    try { await run(); } finally { moduleLoader._load = originalLoad; }
});
