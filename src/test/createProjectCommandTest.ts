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
        refreshes: 0, accounts: 0, inputs: 0, saves: [], projectLists: 0, opened: [],
        controllers: [], shows: 0, show: async () => {},
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
            throw new Error('Opening the creation form must not submit a project');
        }
        async getProjects() {
            state.projectLists++;
            return { type: 'success', projects: [{ id: 'newproject', name: 'Test Project', accessLevel: 'owner' }] };
        }
        dispose() { this.disposed = true; }
    }
    class Controller {
        disposed = false;
        constructor(readonly context: unknown, readonly credentials: unknown, readonly hooks: any) {
            state.controllers.push(this);
        }
        async show() { state.shows++; await state.show(); }
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
            showInputBox: async () => { state.inputs++; throw new Error('Use the create-project webview'); },
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
        exports.linkGate = () => linkOperationGate;
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
            if (name === './views/createProjectController') return { CreateProjectController: Controller };
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

async function testControllerIsLazyAndReused(): Promise<void> {
    const f = fixture();
    assert.equal(f.state.controllers.length, 0);
    await f.commands.create();
    await f.commands.create();
    assert.equal(f.state.controllers.length, 1, 'reopening the command must reuse its controller');
    assert.equal(f.state.shows, 2);
    assert.equal(f.state.inputs, 0, 'creation settings belong in the webview, not an input box');
    assert.equal(f.state.requests.length, 0, 'opening the form must not create a remote project');
    assert.equal(f.commands.gateActive(), false, 'opening the form must not hold the create/link gate');
    const controller = f.state.controllers[0];
    assert.equal(controller.context, f.commands.context);
    assert.equal(controller.credentials, f.commands.credentials);
    assert.equal(controller.hooks.gate, f.commands.linkGate());
    await controller.hooks.signIn('https://selected.example');
    assert.equal(f.state.accounts, 1);
    await controller.hooks.refreshViews();
    assert.equal(f.state.refreshes, 1);
    assert.equal(typeof controller.hooks.onLocalSetupStart, 'function');
    assert.equal(typeof controller.hooks.onLocalSetupFinish, 'function');
    assert.equal(typeof controller.hooks.log, 'function');
}

async function testConcurrentShowAndDeactivation(): Promise<void> {
    const f = fixture();
    const shown = deferred<void>();
    f.state.show = () => shown.promise;
    const first = f.commands.create();
    const second = f.commands.create();
    await flush();
    assert.equal(f.state.controllers.length, 1, 'concurrent reveals must not instantiate multiple controllers');
    assert.equal(f.state.shows, 2);
    assert.equal(f.commands.gateActive(), false);
    await f.commands.deactivate();
    assert.ok(f.state.controllers[0].disposed, 'deactivation must dispose the controller even while show is pending');
    shown.resolve();
    await Promise.all([first, second]);
    await f.commands.create();
    assert.equal(f.state.controllers.length, 1);
    assert.equal(f.state.shows, 2, 'a deactivated extension must not reveal another panel');

    const stopped = fixture();
    await stopped.commands.deactivate();
    await stopped.commands.create();
    assert.equal(stopped.state.controllers.length, 0, 'deactivation before first use must not initialize a controller');
}

async function testFormOpensWithoutCredentialsOrWorkspace(): Promise<void> {
    const f = fixture();
    f.state.credential = undefined;
    f.state.manager = undefined;
    f.state.workspaceFolders = [];
    await f.commands.create();
    assert.equal(f.state.controllers.length, 1, 'the form presents sign-in and folder choices itself');
    assert.equal(f.state.shows, 1);
    assert.equal(f.state.inputs, 0);
    assert.equal(f.state.requests.length, 0);
    assert.equal(f.state.saves.length, 0);
}

async function testExplicitLinkTargetAndLatePrerequisites(): Promise<void> {
    const captured = fixture();
    const originalFolder = captured.state.folder;
    captured.state.defaultServer = 'https://different.example';
    await captured.commands.link({ id: 'newproject' }, 'https://original.example', originalFolder);
    assert.equal(captured.state.apis[0].server, 'https://original.example',
        'an explicit created-project link must not switch to the current preferred server');
    assert.ok(captured.state.warnings.some((message: string) => message.startsWith('Link this folder')));
    assert.equal(captured.state.saves.length, 0, 'cancelling link confirmation must preserve local settings');

    const closed = fixture();
    const closedFolder = closed.state.folder;
    closed.state.workspaceFolders = [];
    await closed.commands.link({ id: 'newproject' }, 'https://original.example', closedFolder);
    assert.equal(closed.state.projectLists, 0, 'late linking must skip a folder which is no longer open');
    assert.equal(closed.state.saves.length, 0);

    const linked = fixture();
    linked.state.linked = true;
    await linked.commands.link({ id: 'newproject' }, 'https://original.example', linked.state.folder);
    assert.equal(linked.state.projectLists, 0);
    assert.equal(linked.state.saves.length, 0, 'linking must not overwrite an existing association');
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
    await testControllerIsLazyAndReused();
    await testConcurrentShowAndDeactivation();
    await testFormOpensWithoutCredentialsOrWorkspace();
    await testExplicitLinkTargetAndLatePrerequisites();
    await testLinkConfirmationRevalidatesWorkspace();
    console.log('Create project command regression tests passed.');
}

runStandaloneTest(run);
