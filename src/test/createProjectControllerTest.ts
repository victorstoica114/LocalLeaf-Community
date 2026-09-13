/** Exercise the shipped controller with isolated host, account, and transfer adapters. */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
import type { CreateProjectController } from '../views/createProjectController';
import type { CreateProjectDraft, CreateProjectPanelState } from '../views/createProjectPanel';
import { LinkOperationGate } from '../utils/linkSafety';
import { runStandaloneTest } from './standaloneRunner';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const folder = (name: string) => ({ fsPath: `D:\\workspaces\\${name}`, toString: () => `file:///workspaces/${name}` });
const server = 'https://overleaf.example/latex';

function fixture() {
    const controllerPath = path.join(__dirname, '..', 'views', 'createProjectController.js');
    const requireController = createRequire(controllerPath);
    const state: any = {
        currentFolder: folder('original'), selectedFolder: folder('new-project'),
        activeServer: undefined, defaultServer: server,
        credential: { userEmail: 'author@example.test', identity: { cookies: 'test-cookie', csrfToken: 'test-csrf' } },
        result: { type: 'success', projectId: 'createdproject123' },
        verifyResult: { type: 'success', userInfo: { userEmail: 'verified@example.test' } },
        publications: [], panels: [], requests: [], apis: [], engines: [], inspections: [], saves: [],
        credentialServers: [], approvals: [], opened: [], commands: [], finishes: [], starts: [], logs: [],
        refreshes: 0, picks: 0, signedIn: [], trace: [], workspaceFolders: [],
        beforeCredential: async () => {}, beforeCreate: async () => {}, beforeVerify: async () => {},
        beforeInspect: async () => {}, beforeApproval: async () => {}, beforeSave: async () => {},
        beforeConnect: async () => {}, beforePull: async () => {}, beforeOpen: async () => {},
        beforeChoose: async () => {}, beforeRefresh: async () => {},
    };
    const managers = new Map<string, any>();
    const getManager = (uri: { toString(): string }) => {
        let manager = managers.get(uri.toString());
        if (!manager) {
            manager = { folder: uri, settings: undefined,
                load: async () => manager.settings,
                getSettings: () => manager.settings };
            managers.set(uri.toString(), manager);
        }
        return manager;
    };
    class API {
        disposed = false;
        identity: unknown;
        constructor(readonly serverUrl: string) { state.apis.push(this); }
        setIdentity(value: unknown) { this.identity = value; }
        async createProject(projectName: string) {
            state.trace.push('create');
            state.requests.push({ serverUrl: this.serverUrl, projectName });
            await state.beforeCreate();
            return state.result;
        }
        async verifyCredentials() { await state.beforeVerify(); return state.verifyResult; }
        dispose() { this.disposed = true; }
    }
    class Engine {
        disconnected = false;
        subscriptionDisposed = false;
        connects = 0;
        pulls: boolean[] = [];
        listener?: (event: { message: string }) => void;
        constructor(readonly api: API, readonly settings: any) { state.engines.push(this); }
        onStatusChange(listener: (event: { message: string }) => void) {
            this.listener = listener;
            return { dispose: () => { this.subscriptionDisposed = true; this.listener = undefined; } };
        }
        async connect() { this.connects++; state.trace.push('connect'); await state.beforeConnect(); }
        async pullAll(manual: boolean) {
            this.pulls.push(manual);
            state.trace.push('pull');
            this.listener?.({ message: 'Downloading main.tex' });
            await state.beforePull();
        }
        disconnect() { this.disconnected = true; }
    }
    const vscode = {
        Uri: { parse: (value: string) => ({ toString: () => value }) },
        workspace: { get workspaceFolders() { return state.workspaceFolders; } },
        env: { openExternal: async (uri: { toString(): string }) => {
            state.opened.push(uri.toString()); await state.beforeOpen(); return true;
        } },
        commands: { executeCommand: async (...args: unknown[]) => { state.commands.push(args); } },
        window: { showOpenDialog: async () => { throw new Error('The injected native folder picker should be used'); } },
    };
    const panel = {
        createOrShow: (_extensionUri: unknown, initial: CreateProjectPanelState) => {
            const instance = { disposed: false, dispose() { this.disposed = true; } };
            state.panels.push(instance);
            state.publications.push(initial);
            return instance;
        },
        updateIfOpen: (value: CreateProjectPanelState) => { state.publications.push(value); },
    };
    const exports: any = {};
    vm.runInNewContext(fs.readFileSync(controllerPath, 'utf8'), {
        exports, Error,
        require: (name: string) => {
            if (name === 'vscode') return vscode;
            if (name === '../api/base') return { BaseAPI: API };
            if (name === '../sync/syncEngine') return { SyncEngine: Engine };
            if (name === './createProjectPanel') return { CreateProjectPanel: panel };
            if (name === '../utils/createdProjectAuthorization') return {
                approveCreatedProjectSync: async (_memento: unknown, value: unknown) => {
                    state.trace.push('approve'); state.approvals.push(value); await state.beforeApproval();
                },
            };
            if (name === '../utils/projectCreationFolder') return {
                inspectProjectCreationFolder: async (uri: unknown) => {
                    state.trace.push('inspect'); state.inspections.push(uri); await state.beforeInspect();
                },
                saveNewProjectLink: async (uri: { toString(): string }, settings: unknown) => {
                    await state.beforeSave();
                    state.trace.push('save'); state.saves.push({ uri, settings });
                    const manager = getManager(uri);
                    assert.equal(manager.settings, undefined, 'the adapter must never overwrite a link');
                    manager.settings = settings;
                    return manager;
                },
            };
            if (name === '../utils/settingsManager') return {
                SettingsManager: {
                    getCurrentInstance: () => ({ getSettings: () => state.activeServer ? { serverUrl: state.activeServer } : undefined }),
                    getInstance: getManager,
                    createDefaultSettings: (serverUrl: string, projectId: string, projectName: string) => ({ serverUrl, projectId, projectName }),
                },
            };
            return requireController(name);
        },
    }, { filename: controllerPath });
    const gate = new LinkOperationGate();
    const context = { extensionUri: folder('extension'), globalState: {}, globalStorageUri: folder('storage') };
    const controller: CreateProjectController = new exports.CreateProjectController(context, {
        getDefaultServer: () => state.defaultServer,
        getCredential: async (serverUrl: string) => {
            state.credentialServers.push(serverUrl); await state.beforeCredential(); return state.credential;
        },
    }, {
        gate,
        log: (message: string) => { state.logs.push(message); },
        signIn: async (serverUrl: string) => { state.signedIn.push(serverUrl); },
        refreshViews: async () => { state.refreshes++; await state.beforeRefresh(); },
        onLocalSetupStart: (uri: unknown) => { state.starts.push(uri); },
        onLocalSetupFinish: async (uri: unknown, settings: unknown) => { state.finishes.push({ uri, settings }); },
        chooseFolder: async () => { state.picks++; await state.beforeChoose(); return state.selectedFolder; },
    });
    const action = (type: 'draftChanged' | 'create' | 'browseFolder' | 'checkAccount' | 'signIn',
        draft: Partial<CreateProjectDraft> = {}, revision = controller.getState().draftRevision + 1): Promise<void> =>
        controller.handleAction({ type, revision, draft: { projectName: 'A new paper', serverUrl: server,
            localCopy: false, ...draft } });
    return { state, controller, action, gate, getManager };
}

async function testRemoteOnlyAndExplicitActions(): Promise<void> {
    const f = fixture();
    try {
        await f.controller.show();
        assert.equal(f.state.requests.length, 0, 'opening the form cannot create a project');
        assert.equal(f.controller.getState().account?.email, 'author@example.test');
        await f.action('create', { projectName: '  A new paper  ', serverUrl: `${server}/` });
        assert.equal(f.controller.getState().phase, 'success');
        assert.deepEqual(f.state.requests, [{ serverUrl: server, projectName: 'A new paper' }]);
        assert.equal(f.state.apis[0].identity, f.state.credential.identity);
        assert.ok(f.state.apis[0].disposed);
        assert.equal(f.state.inspections.length + f.state.saves.length + f.state.engines.length, 0);
        assert.equal(f.state.approvals.length + f.state.opened.length + f.state.commands.length, 0,
            'remote-only creation must not link or open a local folder automatically');
        assert.equal(f.gate.isActive, false);
        assert.equal(f.state.refreshes, 1);
        await f.action('create', { projectName: 'Duplicate' });
        assert.equal(f.state.requests.length, 1, 'successful creation cannot replay the POST');
        const snapshot = f.controller.getState();
        snapshot.draft.projectName = 'tampered';
        snapshot.createdProject!.url = 'https://attacker.example';
        await f.controller.handleAction({ type: 'openProject' });
        assert.deepEqual(f.state.opened, [`${server}/project/createdproject123`]);
        f.state.beforeOpen = async () => { throw new Error('Browser could not be opened'); };
        await f.controller.handleAction({ type: 'openProject' });
        assert.equal(f.controller.getState().phase, 'success');
        assert.match(f.controller.getState().error!, /Browser could not be opened/);
        await f.action('create');
        assert.equal(f.state.requests.length, 1, 'a browser failure must not make creation replayable');
    } finally { f.controller.dispose(); }
}

async function testChosenLocalFolderAndProgress(): Promise<void> {
    const f = fixture();
    try {
        await f.action('browseFolder', { localCopy: true });
        assert.equal(f.controller.getState().folderPath, f.state.selectedFolder.fsPath);
        assert.ok(f.state.publications.some((value: CreateProjectPanelState) => value.phase === 'choosing'));
        await f.action('create', { localCopy: true });
        const result = f.controller.getState();
        assert.equal(result.phase, 'success');
        assert.equal(result.localFolderReady, true);
        assert.equal(f.state.inspections.length, 2, 'the destination must be checked again before the remote POST');
        assert.ok(f.state.inspections.every((uri: unknown) => uri === f.state.selectedFolder));
        assert.equal(f.state.saves[0].uri, f.state.selectedFolder);
        assert.notEqual(f.state.saves[0].uri, f.state.currentFolder);
        assert.equal(f.state.approvals[0].workspaceUri, f.state.selectedFolder.toString());
        assert.equal(f.state.approvals[0].serverUrl, server);
        assert.equal(f.state.approvals[0].projectId, 'createdproject123');
        const engine = f.state.engines[0];
        assert.deepEqual(engine.pulls, [false], 'initial download uses the shared reconciliation path');
        assert.equal(engine.connects, 1);
        assert.ok(engine.disconnected && engine.subscriptionDisposed && f.state.apis[0].disposed);
        assert.equal(f.state.finishes[0].settings, engine.settings);
        assert.ok(f.state.publications.some((value: CreateProjectPanelState) =>
            value.phase === 'downloading' && value.message === 'Downloading main.tex'));
        assert.deepEqual(f.state.trace, ['inspect', 'inspect', 'create', 'approve', 'save', 'connect', 'pull']);
        assert.equal(f.state.commands.length, 0);
        await f.controller.handleAction({ type: 'openFolder' });
        assert.equal(f.state.commands[0][0], 'vscode.openFolder');
        assert.equal(f.state.commands[0][1], f.state.selectedFolder);
        assert.equal(f.state.commands[0][2].forceNewWindow, true);
        f.state.workspaceFolders = [{ uri: f.state.selectedFolder }];
        await f.controller.handleAction({ type: 'openFolder' });
        assert.equal(f.state.commands[1][0], 'workbench.view.explorer');
    } finally { f.controller.dispose(); }
}

async function testInflightAndStaleDrafts(): Promise<void> {
    const f = fixture();
    const response = deferred<void>();
    try {
        await f.action('draftChanged', { projectName: 'Latest name' }, 8);
        await f.action('create', { projectName: 'Stale name' }, 7);
        assert.equal(f.state.requests.length, 0, 'an obsolete form message cannot submit an older draft');
        f.state.beforeCreate = () => response.promise;
        const pending = f.action('create', { projectName: 'Latest name' }, 8);
        await flush();
        assert.equal(f.state.requests.length, 1);
        assert.equal(f.gate.isActive, true);
        await Promise.all([
            f.action('create', { projectName: 'Duplicate' }, 9),
            f.action('draftChanged', { serverUrl: 'https://changed.example' }, 10),
            f.controller.handleAction({ type: 'newProject' }),
            f.controller.show(),
        ]);
        assert.equal(f.state.requests.length, 1);
        assert.equal(f.controller.getState().draft.projectName, 'Latest name');
        assert.equal(f.controller.getState().draft.serverUrl, server);
        response.resolve();
        await pending;
        assert.equal(f.controller.getState().phase, 'success');
        assert.equal(f.gate.isActive, false);
    } finally { response.resolve(); f.controller.dispose(); }

    const blocked = fixture();
    try {
        assert.ok(blocked.gate.tryEnter());
        await blocked.action('create');
        assert.equal(blocked.state.requests.length, 0);
        assert.equal(blocked.gate.isActive, true, 'a rejected operation must not release another operation\'s gate');
        assert.match(blocked.controller.getState().error!, /Another project setup/);
    } finally { blocked.gate.leave(); blocked.controller.dispose(); }
}

async function testUncertainCreationNeverRetriesImplicitly(): Promise<void> {
    for (const failure of ['response', 'exception']) {
        const f = fixture();
        try {
            if (failure === 'response') f.state.result = { type: 'error', creationUncertain: true, message: 'Timed out' };
            else f.state.beforeCreate = async () => { throw new Error('Connection reset after submission'); };
            await f.action('create');
            assert.equal(f.controller.getState().phase, 'uncertain');
            for (const type of ['create', 'draftChanged', 'browseFolder'] as const) await f.action(type);
            await f.controller.handleAction({ type: 'retryLocalSetup' });
            await f.controller.refreshAccount();
            assert.equal(f.state.requests.length, 1, `${failure}: an unknown POST outcome cannot be replayed`);
            assert.equal(f.state.picks, 0);
            assert.equal(f.gate.isActive, false);
            assert.ok(f.state.apis[0].disposed);
            await f.controller.handleAction({ type: 'openProject' });
            assert.deepEqual(f.state.opened, [`${server}/project`], 'uncertain results open the server project list');
            await f.controller.handleAction({ type: 'newProject' });
            assert.equal(f.controller.getState().phase, 'idle');
            assert.equal(f.controller.getState().createdProject, undefined);
            assert.equal(f.state.requests.length, 1, 'resetting the form requires a new explicit submission');
        } finally { f.controller.dispose(); }
    }
}

async function testPartialDownloadRetriesTheSameProject(): Promise<void> {
    const f = fixture();
    try {
        await f.action('browseFolder', { localCopy: true });
        f.state.beforePull = async () => { throw new Error('Download interrupted'); };
        await f.action('create', { localCopy: true });
        assert.equal(f.controller.getState().phase, 'error');
        assert.equal(f.controller.getState().canRetryLocalSetup, true);
        assert.match(f.controller.getState().error!, /Download interrupted/);
        assert.equal(f.state.saves.length, 1);
        const originalSettings = f.state.saves[0].settings;
        assert.equal(f.state.finishes[0].settings, undefined);
        assert.ok(f.state.engines[0].disconnected && f.state.engines[0].subscriptionDisposed);
        await f.action('create');
        assert.equal(f.state.requests.length, 1);
        f.state.credential = undefined;
        await f.controller.handleAction({ type: 'retryLocalSetup' });
        assert.equal(f.controller.getState().canRetryLocalSetup, true);
        assert.match(f.controller.getState().error!, /session is no longer available/);
        await f.action('signIn', { serverUrl: 'https://stale-form.example' }, 0);
        assert.deepEqual(f.state.signedIn, [server], 'retry sign-in must use the server of the already-created project');
        f.state.credential = { userEmail: 'renewed@example.test', identity: { cookies: 'renewed' } };
        f.state.beforePull = async () => {};
        await f.controller.handleAction({ type: 'retryLocalSetup' });
        assert.equal(f.controller.getState().phase, 'success');
        assert.equal(f.controller.getState().localFolderReady, true);
        assert.equal(f.state.requests.length, 1, 'resuming local setup must not create another project');
        assert.equal(f.state.saves.length, 1, 'the previously published exact link must be reused');
        assert.equal(f.getManager(f.state.selectedFolder).settings, originalSettings);
        assert.equal(f.state.finishes.at(-1).settings, f.state.engines[1].settings);
    } finally { f.controller.dispose(); }
}

async function testInvalidFolderAndChangedLinkPreserved(): Promise<void> {
    const invalid = fixture();
    try {
        invalid.state.beforeInspect = async () => { throw new Error('Choose an empty folder'); };
        await invalid.action('browseFolder', { localCopy: true });
        assert.equal(invalid.controller.getState().folderPath, undefined);
        assert.match(invalid.controller.getState().error!, /empty folder/);
        await invalid.action('create', { localCopy: true });
        assert.equal(invalid.state.requests.length, 0);
        invalid.state.beforeInspect = async () => {};
        await invalid.action('browseFolder', { localCopy: true });
        invalid.state.beforeInspect = async () => { throw new Error('Folder is no longer empty'); };
        await invalid.action('create', { localCopy: true });
        assert.equal(invalid.state.requests.length, 0, 'changed destination must be rejected before the POST');
        assert.equal(invalid.gate.isActive, false);
    } finally { invalid.controller.dispose(); }

    const linked = fixture();
    try {
        await linked.action('browseFolder', { localCopy: true });
        const existing = { serverUrl: 'https://other.example', projectId: 'existingproject', projectName: 'Keep me' };
        linked.state.beforeCreate = async () => { linked.getManager(linked.state.selectedFolder).settings = existing; };
        await linked.action('create', { localCopy: true });
        assert.equal(linked.state.requests.length, 1);
        assert.equal(linked.controller.getState().phase, 'error');
        assert.equal(linked.controller.getState().canRetryLocalSetup, true);
        assert.match(linked.controller.getState().error!, /another project.*preserved/);
        assert.equal(linked.getManager(linked.state.selectedFolder).settings, existing);
        assert.equal(linked.state.saves.length + linked.state.engines.length, 0);
        await linked.controller.handleAction({ type: 'retryLocalSetup' });
        assert.equal(linked.state.requests.length, 1);
        assert.equal(linked.getManager(linked.state.selectedFolder).settings, existing);
    } finally { linked.controller.dispose(); }
}

async function testAuthenticationAndInvalidInput(): Promise<void> {
    const f = fixture();
    try {
        f.state.credential = undefined;
        await f.controller.show();
        await f.action('create');
        assert.equal(f.state.requests.length + f.state.apis.length, 0);
        assert.equal(f.controller.getState().account, undefined);
        assert.match(f.controller.getState().error!, /Sign in/);
        f.state.credential = { userEmail: 'author@example.test', identity: { cookies: 'new' } };
        await f.action('checkAccount');
        assert.equal(f.controller.getState().account?.email, 'verified@example.test');
        assert.ok(f.state.apis[0].disposed);
        f.state.result = { type: 'error', authError: true, message: 'Session expired' };
        await f.action('create');
        assert.equal(f.controller.getState().phase, 'error', 'definite authentication failures do not imply an unknown POST outcome');
        assert.equal(f.controller.getState().account, undefined);
        assert.equal(f.gate.isActive, false);
        const count = f.state.requests.length;
        await f.action('create', { projectName: '   ' });
        await f.action('create', { serverUrl: 'file:///invalid' });
        assert.equal(f.state.requests.length, count, 'host validation must reject invalid names and servers before calling the API');
    } finally { f.controller.dispose(); }
}

async function testDisposalStopsStaleContinuations(): Promise<void> {
    for (const stage of ['Credential', 'Create', 'Approval', 'Save', 'Connect', 'Pull']) {
        const f = fixture();
        const resume = deferred<void>();
        try {
            await f.controller.show();
            await f.action('browseFolder', { localCopy: true });
            f.state[`before${stage}`] = () => resume.promise;
            const pending = f.action('create', { localCopy: true });
            await flush();
            assert.equal(f.gate.isActive, true, `${stage}: the operation must reach its suspended stage`);
            f.controller.dispose();
            const publications = f.state.publications.length;
            resume.resolve();
            await pending;
            assert.equal(f.state.publications.length, publications, `${stage}: disposed controllers must not publish stale state`);
            assert.equal(f.controller.getState().localFolderReady, undefined);
            assert.equal(f.gate.isActive, false);
            assert.equal(f.state.refreshes, 0);
            assert.ok(f.state.apis.every((api: { disposed: boolean }) => api.disposed));
            assert.ok(f.state.engines.every((engine: { disconnected: boolean }) => engine.disconnected));
            assert.ok(f.state.finishes.every((finish: { settings: unknown }) => finish.settings === undefined));
            if (stage === 'Credential') assert.equal(f.state.requests.length, 0);
            if (['Credential', 'Create', 'Approval', 'Save'].includes(stage)) assert.equal(f.state.engines.length, 0);
            if (stage === 'Connect') assert.equal(f.state.engines[0].pulls.length, 0,
                'a connection completing after disposal must not start a download');
            assert.ok(f.state.panels[0].disposed);
            await f.controller.handleAction({ type: 'newProject' });
            await f.controller.show();
            assert.equal(f.state.publications.length, publications);
        } finally { resume.resolve(); f.controller.dispose(); }
    }
}

async function testStaleAccountAndCancelledFolderPicker(): Promise<void> {
    const f = fixture();
    const account = deferred<void>();
    try {
        f.state.beforeCredential = () => account.promise;
        const initial = f.controller.refreshAccount();
        const updated = f.action('draftChanged', { serverUrl: 'https://second.example' });
        account.resolve();
        await Promise.all([initial, updated]);
        assert.equal(f.controller.getState().account?.serverUrl, 'https://second.example',
            'a stale credential lookup cannot populate the account for an older server');
        f.state.selectedFolder = undefined;
        await f.action('browseFolder', { localCopy: true });
        assert.equal(f.controller.getState().folderPath, undefined);
        assert.equal(f.controller.getState().phase, 'idle');
        assert.equal(f.state.inspections.length, 0);
        assert.equal(f.state.requests.length, 0);
    } finally { account.resolve(); f.controller.dispose(); }
}

async function run(): Promise<void> {
    await testRemoteOnlyAndExplicitActions();
    await testChosenLocalFolderAndProgress();
    await testInflightAndStaleDrafts();
    await testUncertainCreationNeverRetriesImplicitly();
    await testPartialDownloadRetriesTheSameProject();
    await testInvalidFolderAndChangedLinkPreserved();
    await testAuthenticationAndInvalidInput();
    await testDisposalStopsStaleContinuations();
    await testStaleAccountAndCancelledFolderPicker();
    console.log('Create project controller regression tests passed.');
}

runStandaloneTest(run);
