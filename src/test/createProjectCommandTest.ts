/** Exercise the real create/link command orchestration without a network or VS Code window. */
import './nativeSyncFixture';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
import { runStandaloneTest } from './standaloneRunner';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const folder = (name: string) => ({ fsPath: `D:\\workspaces\\${name}`, toString: () => `file:///workspaces/${name}` });

function fixture() {
    const extensionPath = path.join(__dirname, '..', 'extension.js');
    const requireExtension = createRequire(extensionPath);
    const state: any = {
        defaultServer: 'https://default.example', activeServer: undefined, linked: false,
        folder: folder('original'), credential: { identity: { cookies: 'test-session' } },
        requests: [], apis: [], credentialServers: [], notices: [], errors: [], warnings: [],
        refreshes: 0, accounts: 0, inputs: 0, saves: [], projectLists: 0, links: [], opened: [],
        input: async () => '  Test Project  ',
        create: async () => ({ type: 'success', projectId: 'newproject' }),
        warning: async () => undefined,
        refresh: async () => {},
    };
    const manager = {
        getSettings: () => state.activeServer ? { serverUrl: state.activeServer, projectId: 'existingproject' } : undefined,
        getWorkspaceFolder: () => state.folder,
        isLinked: async () => state.linked,
        save: async (settings: unknown) => { state.saves.push(settings); },
    };
    state.manager = manager;
    state.workspaceFolders = [{ uri: state.folder }];
    class API {
        disposed = false;
        identity: unknown;
        constructor(readonly server: string) { state.apis.push(this); }
        setIdentity(identity: unknown) { this.identity = identity; }
        async createProject(name: string) {
            state.requests.push({ server: this.server, name });
            return state.create(name, this.server);
        }
        async getProjects() {
            state.projectLists++;
            return { type: 'success', projects: [{ id: 'newproject', name: 'Test Project', accessLevel: 'owner' }] };
        }
        dispose() { this.disposed = true; }
    }
    const workspace: any = {
        get workspaceFolders() { return state.workspaceFolders; },
        fs: { readDirectory: async () => [] },
    };
    const vscode = {
        ProgressLocation: { Notification: 15 }, workspace,
        Uri: { parse: (value: string) => ({ toString: () => value }) },
        env: { openExternal: async (uri: { toString(): string }) => { state.opened.push(uri.toString()); return true; } },
        commands: { executeCommand: async () => {} },
        window: {
            showInputBox: async (options: unknown) => { state.inputs++; return state.input(options); },
            withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
            showWarningMessage: async (message: string, ...actions: unknown[]) => {
                state.warnings.push(message);
                return state.warning(message, actions);
            },
            showErrorMessage: async (message: string) => { state.errors.push(message); },
            showInformationMessage: (message: string, ...actions: string[]) => {
                const response = deferred<string | undefined>();
                state.notices.push({ message, actions, response });
                return response.promise;
            },
        },
    };
    const exports: any = {
        state,
        credentials: {
            getDefaultServer: () => state.defaultServer,
            getCredential: async (server: string) => { state.credentialServers.push(server); return state.credential; },
        },
        context: { subscriptions: [], workspaceState: { get() {}, async update() {} } },
    };
    const harness = new vm.Script(fs.readFileSync(extensionPath, 'utf8') + `
        credentialManager = exports.credentials;
        extensionContext = exports.context;
        outputChannel = { appendLine() {} };
        cmdShowAccountPanel = async () => { exports.state.accounts++; };
        refreshGui = async () => { exports.state.refreshes++; await exports.state.refresh(); };
        setAuthState = async () => {};
        initializeSync = async () => {};
        configureSettingsWatcher = () => {};
        updateLoginStatus = async () => {};
        statusBarItem = { show() {}, hide() {} };
        mainWebviewProvider = { async refresh() {} };
        const originalLinkCommand = cmdLinkFolder;
        exports.create = () => cmdCreateProject(exports.context);
        exports.link = (project, server, folder) => originalLinkCommand(exports.context, project, server, folder);
        exports.stubLink = () => { cmdLinkFolder = async (...args) => { exports.state.links.push(args); }; };
        exports.gateActive = () => linkOperationGate.isActive;
    `);
    const moduleLoader = require('node:module');
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function(name: string, parent: unknown, main: boolean) {
        return name === 'vscode' ? vscode : originalLoad(name, parent, main);
    };
    try { harness.runInNewContext({
        exports, setTimeout, clearTimeout, setInterval, clearInterval,
        require: (name: string) => {
            if (name === 'vscode') return vscode;
            if (name === './api/base') return { BaseAPI: API };
            if (name === './utils/settingsManager') return {
                SettingsManager: {
                    getCurrentInstance: () => state.manager,
                    getInstance: () => manager,
                    createDefaultSettings: (serverUrl: string, projectId: string, projectName: string) => ({ serverUrl, projectId, projectName }),
                    setCurrentWorkspaceFolder() {},
                },
            };
            if (name === './sync/ignoreParser') return { IgnoreParser: class { async exists() { return true; } } };
            return requireExtension(name);
        },
    }); } finally { moduleLoader._load = originalLoad; }
    return { state, commands: exports };
}

async function testCancellationAndAuthentication(): Promise<void> {
    const cancelled = fixture();
    cancelled.state.input = async () => undefined;
    await cancelled.commands.create();
    assert.equal(cancelled.state.requests.length, 0);
    assert.equal(cancelled.commands.gateActive(), false);
    const unsigned = fixture();
    unsigned.state.credential = undefined;
    await unsigned.commands.create();
    assert.equal(unsigned.state.inputs, 0);
    assert.equal(unsigned.state.requests.length, 0);
    assert.equal(unsigned.state.accounts, 1);
    const loggedOut = fixture();
    loggedOut.state.input = async () => { loggedOut.state.credential = undefined; return 'Project'; };
    await loggedOut.commands.create();
    assert.equal(loggedOut.state.requests.length, 0, 'credentials must be checked again after the name input');
}

async function testSingleCreationAndServerSelection(): Promise<void> {
    for (const linked of [false, true]) {
        const f = fixture();
        f.state.linked = linked;
        if (linked) f.state.activeServer = 'https://active.example';
        await f.commands.create();
        assert.deepEqual(f.state.requests, [{ server: linked ? 'https://active.example' : 'https://default.example', name: 'Test Project' }]);
        assert.ok(f.state.apis[0].disposed);
        assert.equal(f.state.saves.length, 0, 'creating a project must not overwrite a linked folder');
        assert.equal(f.state.notices[0].actions.includes('Link This Folder'), !linked);
        assert.equal(f.commands.gateActive(), false, 'an unanswered success notification must not retain the create/link gate');
        f.state.notices[0].response.resolve('Open in Overleaf');
        await flush();
        assert.deepEqual(f.state.opened, [`${linked ? 'https://active.example' : 'https://default.example'}/project/newproject`]);
    }
    const concurrent = fixture();
    const entered = deferred<string | undefined>();
    concurrent.state.input = () => entered.promise;
    const first = concurrent.commands.create();
    await flush();
    await concurrent.commands.create();
    assert.equal(concurrent.state.inputs, 1);
    entered.resolve('One Project');
    await first;
    assert.equal(concurrent.state.requests.length, 1, 'overlapping invocations must send only one creation POST');
    concurrent.state.input = async () => undefined;
    await concurrent.commands.create();
    assert.equal(concurrent.state.inputs, 2, 'a pending success notification must allow a later command');
    const noWorkspace = fixture();
    noWorkspace.state.manager = undefined;
    noWorkspace.state.workspaceFolders = [];
    await noWorkspace.commands.create();
    assert.equal(noWorkspace.state.requests[0].server, 'https://default.example');
    assert.deepEqual(Array.from(noWorkspace.state.notices[0].actions), ['Open in Overleaf']);
}

async function testUncertainCreationAndRefreshFailure(): Promise<void> {
    const uncertain = fixture();
    uncertain.state.create = async () => ({ type: 'error', creationUncertain: true, message: 'Connection lost' });
    await uncertain.commands.create();
    await flush();
    assert.equal(uncertain.state.requests.length, 1, 'uncertain project creation must never be replayed automatically');
    assert.match(uncertain.state.errors[0], /may have created.*Refresh the project list/);
    assert.equal(uncertain.state.notices.length, 0);
    assert.equal(uncertain.commands.gateActive(), false);
    const refreshFailed = fixture();
    refreshFailed.state.refresh = async () => { throw new Error('View unavailable'); };
    await refreshFailed.commands.create();
    assert.equal(refreshFailed.state.requests.length, 1);
    assert.equal(refreshFailed.state.errors.length, 0, 'a presentation failure must not report the successful POST as failed');
    assert.match(refreshFailed.state.notices[0].message, /Created/);
}

async function testLateLinkUsesCapturedTarget(): Promise<void> {
    const captured = fixture();
    const originalFolder = captured.state.folder;
    captured.commands.stubLink();
    captured.state.input = async () => {
        captured.state.defaultServer = 'https://changed-during-input.example';
        return 'Captured Project';
    };
    await captured.commands.create();
    assert.equal(captured.state.requests[0].server, 'https://default.example',
        'changing the preferred server during name entry must not redirect the creation');
    captured.state.defaultServer = 'https://different.example';
    captured.state.folder = folder('different');
    captured.state.notices[0].response.resolve('Link This Folder');
    await flush();
    assert.equal(captured.state.links.length, 1);
    assert.equal(captured.state.links[0][1].id, 'newproject');
    assert.equal(captured.state.links[0][2], 'https://default.example');
    assert.equal(captured.state.links[0][3], originalFolder);

    const closed = fixture();
    await closed.commands.create();
    closed.state.workspaceFolders = [];
    closed.state.notices[0].response.resolve('Link This Folder');
    await flush();
    assert.equal(closed.state.projectLists, 0, 'late linking must skip a folder which is no longer open');
    assert.equal(closed.state.saves.length, 0);

    const alreadyLinked = fixture();
    await alreadyLinked.commands.create();
    alreadyLinked.state.linked = true;
    alreadyLinked.state.notices[0].response.resolve('Link This Folder');
    await flush();
    assert.equal(alreadyLinked.state.projectLists, 0);
    assert.equal(alreadyLinked.state.saves.length, 0, 'late linking must not overwrite a newly linked folder');
}

async function testDeactivationCancelsCreation(): Promise<void> {
    const f = fixture();
    const result = deferred<unknown>();
    f.state.create = () => result.promise;
    const pending = f.commands.create();
    await flush();
    assert.equal(f.state.requests.length, 1);
    await f.commands.deactivate();
    assert.ok(f.state.apis[0].disposed, 'deactivation must dispose the in-flight creation API');
    result.resolve({ type: 'success', projectId: 'newproject' });
    await pending;
    assert.equal(f.state.notices.length, 0);
    assert.equal(f.state.refreshes, 0);
    await f.commands.create();
    assert.equal(f.state.requests.length, 1);
}

async function testLinkConfirmationRevalidatesWorkspace(): Promise<void> {
    for (const change of ['workspace-removed', 'folder-linked', 'deactivated']) {
        const f = fixture();
        const confirmation = deferred<string | undefined>();
        f.state.warning = () => confirmation.promise;
        const pending = f.commands.link({ id: 'newproject' }, 'https://default.example', f.state.folder);
        await flush();
        assert.equal(f.state.projectLists, 1);
        assert.ok(f.state.warnings.some((message: string) => message.startsWith('Link this folder')),
            'the test must reach the real link confirmation before changing its prerequisites');
        if (change === 'workspace-removed') f.state.workspaceFolders = [];
        if (change === 'folder-linked') f.state.linked = true;
        if (change === 'deactivated') await f.commands.deactivate();
        confirmation.resolve('Link and Synchronize');
        await pending;
        assert.equal(f.state.saves.length, 0, `${change}: a delayed confirmation must not persist an obsolete link`);
    }
}

async function run(): Promise<void> {
    await testCancellationAndAuthentication();
    await testSingleCreationAndServerSelection();
    await testUncertainCreationAndRefreshFailure();
    await testLateLinkUsesCapturedTarget();
    await testDeactivationCancelsCreation();
    await testLinkConfirmationRevalidatesWorkspace();
    console.log('Create project command regression tests passed.');
}

runStandaloneTest(run);
