import * as assert from 'node:assert/strict';
import * as vm from 'node:vm';
import type { CreateProjectPanelAction, CreateProjectPanelState } from '../views/createProjectPanel';
import { runStandaloneTest } from './standaloneRunner';

class Control {
    value = '';
    checked = false;
    textContent = '';
    className = '';
    title = '';
    hidden = false;
    disabled = false;
    readonly attributes = new Map<string, string>();
    readonly listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    addEventListener(name: string, listener: (event: { preventDefault(): void }) => void): void { this.listeners.set(name, listener); }
    dispatch(name: string): void { this.listeners.get(name)?.({ preventDefault() {} }); }
    click(): void { if (!this.disabled) this.dispatch('click'); }
    input(value: string): void { this.value = value; this.dispatch('input'); }
    check(checked: boolean): void { this.checked = checked; this.dispatch('change'); }
}

/** Execute the shipped script against controls declared in the actual HTML. */
function renderPanel(html: string) {
    const controls = new Map<string, Control>();
    for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
        const control = new Control();
        control.disabled = /\sdisabled(?:\s|>)/.test(match[0]);
        control.hidden = /\shidden(?:\s|>)/.test(match[0]);
        controls.set(match[1], control);
    }
    const control = (id: string): Control => {
        assert.ok(controls.has(id), `the generated HTML must declare ${id}`);
        return controls.get(id)!;
    };
    const messages: Array<Record<string, unknown>> = [];
    let receive!: (event: { data: unknown }) => void;
    const script = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
    assert.ok(script, 'the form must use one nonced script');
    assert.ok(html.includes(`script-src 'nonce-${script[1]}'`));
    assert.equal(html.match(/<script/g)?.length, 1);
    assert.doesNotMatch(script[2], /\.innerHTML\s*=/, 'server-controlled data must use text/value bindings');
    vm.runInNewContext(script[2], {
        URL,
        acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => {
            messages.push(JSON.parse(JSON.stringify(message)) as Record<string, unknown>);
        } }),
        document: { getElementById: control },
        window: { addEventListener: (_name: string, listener: typeof receive) => { receive = listener; } },
    });
    return { control, messages, update: (state: CreateProjectPanelState) => receive({ data: { type: 'state', state } }),
        submit: () => control('projectForm').dispatch('submit') };
}

function state(overrides: Partial<CreateProjectPanelState> = {}): CreateProjectPanelState {
    return { draft: { projectName: 'A new paper', serverUrl: 'https://overleaf.example/latex', localCopy: false },
        draftRevision: 0, phase: 'idle', ...overrides };
}

async function run(): Promise<void> {
    const Module = require('module') as { _load(request: string, parent: unknown, isMain: boolean): unknown };
    const originalLoad = Module._load;
    const hostMessages: Array<{ type: string; state: CreateProjectPanelState }> = [];
    let hostReceive!: (raw: unknown) => void;
    let disposeCallback!: () => void;
    let createdPanels = 0;
    let reveals = 0;
    const webview = {
        html: '', cspSource: 'vscode-resource:',
        onDidReceiveMessage: (callback: typeof hostReceive) => { hostReceive = callback; },
        postMessage: async (message: typeof hostMessages[number]) => { hostMessages.push(message); return true; },
    };
    const vscode = {
        Uri: { joinPath: (_root: unknown, ...parts: string[]) => parts.join('/') },
        ViewColumn: { Active: -1 },
        window: { createWebviewPanel: () => {
            createdPanels++;
            return { webview, onDidDispose: (callback: () => void) => { disposeCallback = callback; },
                reveal: () => { reveals++; }, dispose: () => disposeCallback() };
        } },
    };
    Module._load = function (request, parent, isMain) {
        return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
    };
    try {
        const { CreateProjectPanel } = require('../views/createProjectPanel') as typeof import('../views/createProjectPanel');
        const actions: CreateProjectPanelAction[] = [];
        let actionError: Error | undefined;
        const onAction = async (action: CreateProjectPanelAction) => {
            actions.push(action);
            if (actionError) throw actionError;
        };
        const extensionUri = {} as import('vscode').Uri;
        const panel = CreateProjectPanel.createOrShow(extensionUri, state(), onAction);
        const page = renderPanel(webview.html);
        const { control } = page;
        assert.deepEqual([...page.messages], [{ type: 'ready' }]);
        assert.match(webview.html, /readonly[^>]+placeholder="Choose an empty local folder"/);
        assert.match(webview.html, /aria-label="Blank project"/);
        assert.match(webview.html, /@media[^}]+700px/);
        assert.ok(webview.html.includes('\\documentclass{article}'), 'the preview must retain literal LaTeX commands');

        const account = { serverUrl: 'https://overleaf.example/latex/', email: 'person@example.test' };
        page.update(state());
        assert.equal(control('create').disabled, true, 'creation requires an account check');
        control('checkAccount').click();
        control('checkAccount').click();
        assert.equal(page.messages.filter(message => message.type === 'checkAccount').length, 1);
        for (const id of ['projectName', 'serverUrl', 'localCopy']) assert.equal(control(id).disabled, true);
        page.update(state({ phase: 'checking' }));
        assert.equal(control('projectName').disabled, true, 'host account checks must pin the draft until completion');
        assert.equal(control('create').textContent, 'Create project');
        page.update(state({ account }));
        assert.equal(control('create').disabled, false, 'canonical matching account enables remote-only creation');
        assert.equal(control('accountTitle').textContent, account.email);
        assert.match(control('accountHint').textContent, /Session available/);
        page.update(state({ account, message: 'Account verified. You can create your project.' }));
        assert.equal(control('statusTitle').textContent, 'Account ready');

        for (const invalid of ['', '  ', 'folder/name', 'folder\\name', 'bad\u007f', 'x'.repeat(151)]) {
            control('projectName').input(invalid);
            assert.equal(control('create').disabled, true, `invalid project name ${JSON.stringify(invalid)}`);
            assert.equal(control('projectName').attributes.get('aria-invalid'), 'true');
        }
        control('projectName').input('Retained project');
        const retainedRevision = page.messages.at(-1)!.revision as number;
        page.update(state({ account, phase: 'checking' }));
        assert.equal(control('projectName').value, 'Retained project', 'a stale asynchronous account update must not erase edits');
        page.update(state({ account, draftRevision: retainedRevision,
            draft: { projectName: 'Retained project', serverUrl: 'https://overleaf.example/latex', localCopy: false } }));
        for (const invalid of ['javascript:alert(1)', 'https://user:password@overleaf.example',
            'https://overleaf.example/latex?token=secret', 'https://overleaf.example/latex#project', 'not a URL']) {
            control('serverUrl').input(invalid);
            assert.equal(control('create').disabled, true);
            assert.equal(control('checkAccount').disabled, true);
        }
        control('serverUrl').input('https://other.example/latex');
        assert.equal(control('checkAccount').disabled, false);
        assert.equal(control('create').disabled, true, 'credentials for another server cannot authorize creation');
        control('serverUrl').input('https://overleaf.example/latex/');
        assert.equal(control('create').disabled, false);

        control('localCopy').check(true);
        assert.equal(control('folderSection').hidden, false);
        assert.equal(control('create').disabled, true, 'a requested local copy requires a host-selected folder');
        control('folderPath').value = 'C:\\arbitrary-browser-path';
        control('browseFolder').click();
        assert.equal(control('serverUrl').disabled, true);
        assert.deepEqual(Object.keys(page.messages.at(-1)!).sort(), ['draft', 'revision', 'type']);
        assert.equal((page.messages.at(-1)!.draft as Record<string, unknown>).folderPath, undefined);
        const localState = state({ account, folderPath: 'C:\\chosen-empty-folder',
            draft: page.messages.at(-1)!.draft as CreateProjectPanelState['draft'],
            draftRevision: page.messages.at(-1)!.revision as number });
        page.update({ ...localState, phase: 'choosing', message: 'Choose an empty local folder.' });
        assert.equal(control('statusTitle').textContent, 'Choose a local folder');
        assert.equal(control('serverUrl').disabled, true, 'the folder picker must keep the submitted draft pinned');
        assert.equal(control('create').disabled, true);
        page.update(localState);
        assert.equal(control('create').disabled, false);
        assert.equal(control('folderPath').value, localState.folderPath);
        page.submit();
        page.submit();
        assert.equal(page.messages.filter(message => message.type === 'create').length, 1, 'a double submission must be coalesced before host acknowledgement');
        for (const id of ['projectName', 'serverUrl', 'localCopy', 'browseFolder', 'create']) {
            assert.equal(control(id).disabled, true, `${id} must be pinned while the server may create the project`);
        }
        page.update({ ...localState, phase: 'creating', message: 'Creating the project...' });
        assert.equal(control('create').disabled, true);
        assert.equal(control('projectForm').attributes.get('aria-busy'), 'true');
        const literalError = '<img src=x onerror="alert(1)">';
        page.update({ ...localState, phase: 'error', error: literalError });
        assert.equal(control('projectName').value, localState.draft.projectName);
        assert.equal(control('create').disabled, false, 'a definite creation failure should leave a retryable form');
        assert.equal(control('statusError').textContent, literalError);
        assert.equal(control('status').attributes.get('role'), 'alert');

        const result = { name: '<Project & name>', url: 'https://overleaf.example/project/new-id' };
        page.update({ ...localState, phase: 'success', createdProject: result, localFolderReady: true });
        assert.equal(control('projectForm').hidden, true);
        assert.equal(control('statusMessage').textContent, result.name);
        assert.equal(control('openFolder').hidden, false);
        control('openProject').click();
        assert.deepEqual(page.messages.at(-1), { type: 'openProject' });
        control('openFolder').click();
        assert.deepEqual(page.messages.at(-1), { type: 'openFolder' });
        page.update({ ...localState, phase: 'error', createdProject: result,
            error: 'Folder setup was interrupted.', canRetryLocalSetup: true });
        assert.equal(control('retryLocalSetup').hidden, false);
        assert.equal(control('create').disabled, true, 'partial local failures must never offer a second remote creation');
        control('retryLocalSetup').click();
        control('retryLocalSetup').click();
        assert.equal(page.messages.filter(message => message.type === 'retryLocalSetup').length, 1);
        assert.deepEqual(page.messages.at(-1), { type: 'retryLocalSetup' });
        page.update({ ...localState, phase: 'uncertain', error: 'The server did not acknowledge the request.' });
        assert.equal(control('projectForm').hidden, true);
        assert.equal(control('openProject').textContent, 'Open Overleaf');
        assert.equal(control('retryLocalSetup').hidden, true);
        control('newProject').click();
        assert.deepEqual(page.messages.at(-1), { type: 'newProject' });
        page.update(state({ draftRevision: localState.draftRevision + 1 }));
        assert.equal(control('projectForm').hidden, false);
        assert.equal(control('projectName').value, 'A new paper');

        const samePanel = CreateProjectPanel.createOrShow(extensionUri, localState, onAction);
        assert.equal(samePanel, panel);
        assert.equal(createdPanels, 1);
        assert.equal(reveals, 1);
        hostReceive({ type: 'ready' });
        assert.equal(hostMessages.at(-1)!.state, localState, 'ready must replay the newest host state');
        const validDraft = { projectName: 'Name', serverUrl: 'https://overleaf.example', localCopy: true };
        for (const raw of [null, [], { type: 'unknown' }, { type: {} }, { type: 'create' },
            { type: 'create', draft: validDraft, revision: -1 },
            { type: 'create', draft: validDraft, revision: 1.5 },
            { type: 'create', draft: { ...validDraft, localCopy: 'true' }, revision: 1 },
            { type: 'create', draft: { ...validDraft, serverUrl: 'https://bad.example\nsecret' }, revision: 1 },
            { type: 'draftChanged', draft: { ...validDraft, projectName: 'x'.repeat(1025) }, revision: 1 }]) hostReceive(raw);
        assert.equal(actions.length, 0, 'malformed webview messages must not reach the controller');
        hostReceive({ type: 'browseFolder', revision: 1, draft: { ...validDraft, folderPath: 'C:\\untrusted' }, folderPath: 'C:\\untrusted' });
        assert.deepEqual(actions.at(-1), { type: 'browseFolder', revision: 1, draft: validDraft });
        hostReceive({ type: 'openProject', url: 'javascript:untrusted()', folderPath: 'C:\\untrusted' });
        assert.deepEqual(actions.at(-1), { type: 'openProject' });
        hostReceive({ type: 'draftChanged', revision: 2, draft: { ...validDraft, projectName: '', serverUrl: '' } });
        assert.equal(actions.at(-1)!.type, 'draftChanged', 'incomplete form edits must still reach host draft storage');
        actionError = new Error('An unexpected controller failure');
        hostReceive({ type: 'checkAccount', revision: 2, draft: validDraft });
        await Promise.resolve();
        assert.equal(hostMessages.at(-1)!.state.phase, 'error');
        assert.match(hostMessages.at(-1)!.state.error!, /unexpected controller failure/);
        const messagesBeforeDispose = hostMessages.length;
        const actionsBeforeDispose = actions.length;
        panel.dispose();
        panel.updateState(state());
        hostReceive({ type: 'newProject' });
        assert.equal(hostMessages.length, messagesBeforeDispose);
        assert.equal(actions.length, actionsBeforeDispose);
        CreateProjectPanel.createOrShow(extensionUri, state(), onAction).dispose();
        assert.equal(createdPanels, 2, 'disposing must release the singleton for a fresh editor tab');
        console.log('Graphical create-project panel tests passed: generated script, validation, draft retention, actions, partial recovery, parser and lifecycle.');
    } finally {
        Module._load = originalLoad;
    }
}

runStandaloneTest(run);
