import * as vscode from 'vscode';
import { conciseErrorMessage } from '../utils/errorMessages';
import { MAX_PROJECT_NAME_LENGTH } from '../utils/projectName';
import { createNonce } from './webviewUtils';

export interface CreateProjectDraft {
    projectName: string;
    serverUrl: string;
    localCopy: boolean;
}

export type CreateProjectPhase = 'idle' | 'checking' | 'choosing' | 'creating' | 'downloading'
    | 'success' | 'error' | 'uncertain';

export interface CreateProjectPanelState {
    draft: CreateProjectDraft;
    draftRevision: number;
    folderPath?: string;
    account?: { serverUrl: string; email: string };
    phase: CreateProjectPhase;
    message?: string;
    error?: string;
    createdProject?: { name: string; url: string };
    localFolderReady?: boolean;
    canRetryLocalSetup?: boolean;
}

export type CreateProjectPanelAction =
    | { type: 'draftChanged' | 'checkAccount' | 'signIn' | 'browseFolder' | 'create'; draft: CreateProjectDraft; revision: number }
    | { type: 'openProject' | 'openFolder' | 'newProject' | 'retryLocalSetup' };

/** One editor tab owns the graphical project-creation form. */
export class CreateProjectPanel {
    static readonly viewType = 'localleaf.createProjectPanel';
    private static instance?: CreateProjectPanel;
    private disposed = false;

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private state: CreateProjectPanelState,
        private readonly onAction: (action: CreateProjectPanelAction) => Promise<void>,
    ) {
        this.panel.onDidDispose(() => {
            this.disposed = true;
            if (CreateProjectPanel.instance === this) CreateProjectPanel.instance = undefined;
        });
        this.panel.webview.onDidReceiveMessage((raw: unknown) => {
            if (this.disposed) return;
            if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'ready') {
                this.updateState(this.state);
                return;
            }
            const action = this.parseAction(raw);
            if (!action) return;
            void this.onAction(action).catch(error => {
                if (!this.disposed) this.updateState({ ...this.state, phase: 'error', error: conciseErrorMessage(error) });
            });
        });
        this.panel.webview.html = this.getHtml(this.panel.webview);
    }

    static createOrShow(
        extensionUri: vscode.Uri,
        state: CreateProjectPanelState,
        onAction: (action: CreateProjectPanelAction) => Promise<void>,
    ): CreateProjectPanel {
        if (CreateProjectPanel.instance) {
            CreateProjectPanel.instance.updateState(state);
            CreateProjectPanel.instance.reveal();
            return CreateProjectPanel.instance;
        }
        const panel = vscode.window.createWebviewPanel(
            CreateProjectPanel.viewType, 'Create Overleaf Project', vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'images')] },
        );
        CreateProjectPanel.instance = new CreateProjectPanel(panel, state, onAction);
        return CreateProjectPanel.instance;
    }

    static updateIfOpen(state: CreateProjectPanelState): void {
        CreateProjectPanel.instance?.updateState(state);
    }

    updateState(state: CreateProjectPanelState): void {
        if (this.disposed) return;
        this.state = state;
        void this.panel.webview.postMessage({ type: 'state', state }).then(undefined, error => {
            console.error('[LocalLeaf] Could not update project creation panel:', error);
        });
    }

    reveal(): void { if (!this.disposed) this.panel.reveal(vscode.ViewColumn.Active); }
    dispose(): void { if (!this.disposed) this.panel.dispose(); }

    private parseAction(raw: unknown): CreateProjectPanelAction | undefined {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
        const value = raw as Record<string, unknown>;
        if (typeof value.type !== 'string') return undefined;
        if (['openProject', 'openFolder', 'newProject', 'retryLocalSetup'].includes(value.type)) {
            // URLs and filesystem paths always come from the host controller.
            return { type: value.type as 'openProject' | 'openFolder' | 'newProject' | 'retryLocalSetup' };
        }
        if (!['draftChanged', 'checkAccount', 'signIn', 'browseFolder', 'create'].includes(value.type)) return undefined;
        if (!value.draft || typeof value.draft !== 'object' || Array.isArray(value.draft)) return undefined;
        const draft = value.draft as Record<string, unknown>;
        if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0
            || typeof draft.projectName !== 'string' || draft.projectName.length > 1024
            || typeof draft.serverUrl !== 'string' || draft.serverUrl.length > 8192
            || /[\0\r\n]/.test(draft.projectName + draft.serverUrl)
            || typeof draft.localCopy !== 'boolean') return undefined;
        return { type: value.type as 'draftChanged' | 'checkAccount' | 'signIn' | 'browseFolder' | 'create',
            revision: value.revision as number,
            draft: { projectName: draft.projectName, serverUrl: draft.serverUrl, localCopy: draft.localCopy } };
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = createNonce();
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Create Overleaf Project</title>
<style>
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); }
    [hidden] { display: none !important; }
    button, input { font: inherit; }
    button { border: 1px solid transparent; border-radius: 6px; padding: 9px 14px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .55; cursor: default; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .page { max-width: 1000px; margin: 0 auto; padding: 42px 36px 36px; }
    .eyebrow { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 16px; }
    .leaf { display: inline-grid; place-items: center; width: 25px; height: 25px; border-radius: 7px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-size: 18px; }
    h1 { margin: 0 0 10px; font-size: 30px; line-height: 1.2; letter-spacing: -.6px; font-weight: 600; }
    .lead { margin: 0 0 28px; max-width: 660px; color: var(--vscode-descriptionForeground); line-height: 1.6; font-size: 14px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(245px, 1fr); gap: 22px; align-items: start; }
    .card { border: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); border-radius: 10px; padding: 22px; }
    .section + .section { margin-top: 25px; padding-top: 23px; border-top: 1px solid var(--vscode-panel-border); }
    h2 { margin: 0 0 18px; font-size: 15px; font-weight: 600; }
    label.field-label { display: block; font-weight: 600; margin: 0 0 8px; }
    input[type="text"], input[type="url"] { width: 100%; min-width: 0; padding: 10px 11px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 5px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); }
    input[aria-invalid="true"] { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }
    input[readonly] { color: var(--vscode-descriptionForeground); }
    .hint { color: var(--vscode-descriptionForeground); line-height: 1.5; font-size: 12px; margin: 8px 0 0; }
    .field-error { min-height: 16px; color: var(--vscode-errorForeground); font-size: 12px; line-height: 1.4; margin-top: 6px; }
    .name-meta { display: flex; gap: 12px; justify-content: space-between; }
    .name-meta .hint { margin-top: 0; white-space: nowrap; }
    .account { display: flex; gap: 9px; align-items: flex-start; margin-top: 14px; }
    .account-mark { width: 21px; flex: 0 0 21px; text-align: center; color: var(--vscode-descriptionForeground); }
    .account.valid .account-mark { color: var(--vscode-testing-iconPassed); }
    .account-copy { min-width: 0; }
    .account-title { font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
    .account-copy .hint { margin-top: 3px; }
    .row-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 13px; }
    .row-actions button { padding: 7px 11px; font-size: 12px; }
    .checkbox { display: flex; align-items: flex-start; gap: 9px; cursor: pointer; line-height: 1.5; }
    .checkbox input { accent-color: var(--vscode-focusBorder); margin: 3px 0 0; }
    .checkbox strong { display: block; font-size: 13px; }
    .checkbox .hint { display: block; margin-top: 3px; }
    .folder { margin-top: 16px; }
    .folder-row { display: flex; gap: 8px; }
    .folder-row input { text-overflow: ellipsis; }
    .folder-row button { flex-shrink: 0; }
    .template { border: 1px solid var(--vscode-focusBorder); border-radius: 7px; padding: 14px; display: flex; gap: 9px; }
    .template input { accent-color: var(--vscode-focusBorder); margin: 2px 0 0; }
    .template-title { font-weight: 600; }
    .template .hint { margin-top: 4px; }
    .file-preview { border: 1px solid var(--vscode-panel-border); border-radius: 7px; margin-top: 18px; overflow: hidden; background: var(--vscode-editor-background); }
    .file-heading { padding: 10px 12px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; }
    pre { margin: 0; padding: 15px 12px; overflow-x: auto; font-size: 12px; line-height: 1.8; font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-descriptionForeground); }
    .footer { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-top: 24px; }
    .footer .hint { margin: 0; max-width: 430px; }
    .footer button { min-width: 156px; }
    .status { border: 1px solid var(--vscode-panel-border); border-left: 3px solid var(--vscode-progressBar-background); border-radius: 7px; padding: 17px 19px; margin-bottom: 22px; background: var(--vscode-sideBar-background); }
    .status.error { border-left-color: var(--vscode-errorForeground); }
    .status.success { border-left-color: var(--vscode-testing-iconPassed); }
    .status-title { display: flex; align-items: center; gap: 9px; font-weight: 600; font-size: 14px; }
    .status-copy { margin: 7px 0 0; color: var(--vscode-descriptionForeground); white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
    .status-error { color: var(--vscode-errorForeground); }
    .status-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    .spinner { width: 13px; height: 13px; border: 2px solid var(--vscode-panel-border); border-top-color: var(--vscode-progressBar-background); border-radius: 50%; animation: spin .85s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
    @media (max-width: 700px) { .page { padding: 26px 20px; } .layout { grid-template-columns: minmax(0, 1fr); } h1 { font-size: 26px; } .card { padding: 18px; } .footer { align-items: stretch; flex-direction: column; } .footer button { width: 100%; } }
</style>
</head>
<body>
<main class="page">
    <header><div class="eyebrow"><span class="leaf" aria-hidden="true">+</span> LocalLeaf</div><h1>Create a new project</h1><p class="lead">Start a blank Overleaf project and keep a local copy if you want.</p></header>
    <section id="status" class="status" role="status" aria-live="polite" hidden>
        <div class="status-title"><span id="spinner" class="spinner" aria-hidden="true" hidden></span><span id="statusTitle"></span></div>
        <p id="statusMessage" class="status-copy" hidden></p><p id="statusError" class="status-copy status-error" hidden></p>
        <div id="resultActions" class="status-actions" hidden><button id="openProject" type="button">Open in Overleaf</button><button id="openFolder" class="secondary" type="button" hidden>Open Local Folder</button><button id="retryLocalSetup" type="button" hidden>Retry Local Setup</button><button id="recoverSignIn" class="secondary" type="button" hidden>Sign in</button><button id="newProject" class="secondary" type="button">New Project</button></div>
    </section>
    <form id="projectForm" novalidate>
        <div class="layout">
            <div class="card">
                <section class="section"><h2>Project details</h2><label for="projectName" class="field-label">Project name</label><input id="projectName" type="text" maxlength="${MAX_PROJECT_NAME_LENGTH}" placeholder="My research paper" autocomplete="off" aria-describedby="nameError nameCount"><div class="name-meta"><div id="nameError" class="field-error" aria-live="polite"></div><span id="nameCount" class="hint">0 / ${MAX_PROJECT_NAME_LENGTH}</span></div></section>
                <section class="section"><label for="serverUrl" class="field-label">Overleaf server</label><input id="serverUrl" type="url" placeholder="https://www.overleaf.com" autocomplete="off" spellcheck="false" aria-describedby="serverError"><div id="serverError" class="field-error" aria-live="polite"></div><div id="account" class="account" role="status" aria-live="polite"><span id="accountMark" class="account-mark" aria-hidden="true">○</span><div class="account-copy"><div id="accountTitle" class="account-title">Check your account</div><p id="accountHint" class="hint">Verify your session on this server before creating the project.</p></div></div><div class="row-actions"><button id="checkAccount" type="button" class="secondary">Check account</button><button id="signIn" type="button" class="secondary">Sign in</button></div></section>
                <section class="section"><label class="checkbox" for="localCopy"><input id="localCopy" type="checkbox"><span><strong>Download and link a local folder</strong><span class="hint">Edit in VS Code and synchronize saved changes with Overleaf.</span></span></label><div id="folderSection" class="folder" hidden><label for="folderPath" class="field-label">Local folder</label><div class="folder-row"><input id="folderPath" type="text" readonly placeholder="Choose an empty local folder" aria-describedby="folderHint"><button id="browseFolder" type="button" class="secondary">Browse...</button></div><p id="folderHint" class="hint">Choose an empty folder for the project files.</p></div></section>
            </div>
            <aside class="card" aria-label="Project template"><h2>Template</h2><label class="template"><input type="radio" name="template" value="blank" checked aria-label="Blank project"><span><span class="template-title">Blank project</span><span class="hint" style="display:block">A fresh LaTeX document, ready to write.</span></span></label><div class="file-preview" aria-label="Example main.tex starter file"><div class="file-heading">main.tex</div><pre>\\documentclass{article}

\\begin{document}
  Your content starts here.
\\end{document}</pre></div><p class="hint">Overleaf creates the initial main.tex file for your project.</p></aside>
        </div>
        <footer class="footer"><p id="submitHint" class="hint">Enter a name and check your account to continue.</p><button id="create" type="submit" disabled>Create project</button></footer>
    </form>
</main>
<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const control = id => document.getElementById(id);
    let state = null;
    let revision = -1;
    let pendingAction = null;
    let touchedName = false;
    let touchedServer = false;
    const draft = () => ({ projectName: control('projectName').value, serverUrl: control('serverUrl').value, localCopy: control('localCopy').checked });
    function canonicalServer(value) {
        try {
            const url = new URL(value.trim());
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
            let path = url.pathname;
            while (path.endsWith('/')) path = path.slice(0, -1);
            return url.origin + path;
        } catch { return ''; }
    }
    function nameError(value) {
        const name = value.trim();
        if (!name) return 'Enter a project name.';
        if (name.length > ${MAX_PROJECT_NAME_LENGTH}) return 'Use ${MAX_PROJECT_NAME_LENGTH} characters or fewer.';
        if (/[\\/\\\\]/.test(name)) return 'Project names cannot contain / or \\\\ characters.';
        if (/[\\x00-\\x1f\\x7f-\\x9f]/.test(value)) return 'Project names cannot contain control characters.';
        return '';
    }
    function busy() { return ['create', 'retryLocalSetup', 'checkAccount', 'signIn', 'browseFolder'].includes(pendingAction) || ['creating', 'downloading', 'checking', 'choosing'].includes(state?.phase); }
    function validAccount() { const server = canonicalServer(draft().serverUrl); return Boolean(server && state?.account && canonicalServer(state.account.serverUrl) === server); }
    function send(type, withDraft = false) {
        if (withDraft) vscode.postMessage({ type, draft: draft(), revision: Math.max(0, revision) });
        else vscode.postMessage({ type });
    }
    function changeDraft() { revision = Math.max(0, revision) + 1; send('draftChanged', true); render(); }
    function perform(type) {
        if (busy()) return;
        if (['checkAccount', 'signIn', 'browseFolder'].includes(type) && pendingAction === type) return;
        pendingAction = type;
        send(type, ['checkAccount', 'signIn', 'browseFolder', 'create'].includes(type));
        render();
    }
    control('projectName').addEventListener('input', () => { touchedName = true; changeDraft(); });
    control('serverUrl').addEventListener('input', () => { touchedServer = true; changeDraft(); });
    control('localCopy').addEventListener('change', changeDraft);
    ['checkAccount', 'signIn', 'browseFolder', 'openProject', 'openFolder', 'newProject', 'retryLocalSetup'].forEach(type => {
        control(type).addEventListener('click', () => { if (!control(type).disabled) perform(type); });
    });
    control('recoverSignIn').addEventListener('click', () => perform('signIn'));
    control('projectForm').addEventListener('submit', event => { event.preventDefault(); if (!control('create').disabled) perform('create'); });

    function render() {
        if (!state) return;
        const value = draft();
        const currentNameError = nameError(value.projectName);
        const serverValid = Boolean(canonicalServer(value.serverUrl));
        const accountValid = validAccount();
        const locked = busy() || Boolean(state.createdProject) || state.phase === 'uncertain';
        const checking = state.phase === 'checking' || pendingAction === 'checkAccount';
        control('projectName').disabled = locked;
        control('serverUrl').disabled = locked;
        control('localCopy').disabled = locked;
        control('nameCount').textContent = value.projectName.length + ' / ${MAX_PROJECT_NAME_LENGTH}';
        control('nameError').textContent = touchedName ? currentNameError : '';
        control('projectName').setAttribute('aria-invalid', String(Boolean(touchedName && currentNameError)));
        control('serverError').textContent = touchedServer && !serverValid ? 'Enter an HTTP or HTTPS server URL without a query or credentials.' : '';
        control('serverUrl').setAttribute('aria-invalid', String(touchedServer && !serverValid));
        control('account').className = 'account' + (accountValid ? ' valid' : '');
        control('accountMark').textContent = accountValid ? '✓' : '○';
        control('accountTitle').textContent = checking ? 'Checking account...' : accountValid ? state.account.email || 'Signed in' : 'Sign in to this server';
        control('accountHint').textContent = accountValid ? 'Session available for this server. Check account to verify it.' : 'Sign in to create a project, or check an existing session.';
        control('checkAccount').disabled = busy() || checking || !serverValid;
        control('checkAccount').textContent = checking ? 'Checking...' : 'Check account';
        control('signIn').disabled = busy() || pendingAction === 'signIn' || !serverValid;
        control('folderSection').hidden = !value.localCopy;
        control('folderPath').value = state.folderPath || '';
        control('folderPath').title = state.folderPath || '';
        control('browseFolder').disabled = locked || pendingAction === 'browseFolder';
        control('create').disabled = locked || checking || Boolean(currentNameError) || !serverValid || !accountValid || (value.localCopy && !state.folderPath);
        control('create').textContent = state.phase === 'downloading' || pendingAction === 'retryLocalSetup' ? 'Setting up local copy...' : state.phase === 'creating' || pendingAction === 'create' ? 'Creating project...' : 'Create project';
        control('projectForm').setAttribute('aria-busy', String(busy()));
        control('submitHint').textContent = currentNameError ? 'Enter a valid project name to continue.' : !serverValid ? 'Enter a valid Overleaf server URL.' : !accountValid ? 'Check your account on the selected server.' : value.localCopy && !state.folderPath ? 'Choose a local folder to continue.' : 'A blank project will be created on Overleaf.';

        const complete = state.phase === 'success';
        const uncertain = state.phase === 'uncertain';
        const hasResult = Boolean(state.createdProject) || uncertain;
        const hasError = Boolean(state.error);
        const showStatus = state.phase !== 'idle' || hasError || Boolean(state.message);
        control('status').hidden = !showStatus;
        control('status').className = 'status' + (hasError || state.phase === 'error' || uncertain ? ' error' : complete ? ' success' : '');
        control('status').setAttribute('role', hasError || uncertain ? 'alert' : 'status');
        control('spinner').hidden = !busy() && !checking;
        control('statusTitle').textContent = uncertain ? 'Check Overleaf before trying again' : complete ? 'Project created' : state.phase === 'downloading' ? 'Setting up your local copy' : state.phase === 'creating' ? 'Creating your project' : checking ? 'Checking your account' : state.phase === 'choosing' ? 'Choose a local folder' : state.createdProject ? 'Project created; local setup needs attention' : state.phase === 'idle' && !hasError ? 'Account ready' : 'Could not complete this step';
        control('statusMessage').textContent = state.message || (uncertain ? 'The server may have created the project. Check your project list before starting again.' : complete ? state.createdProject?.name || 'Your project is ready.' : '');
        control('statusMessage').hidden = !control('statusMessage').textContent;
        control('statusError').textContent = state.error || '';
        control('statusError').hidden = !hasError;
        control('resultActions').hidden = !hasResult;
        control('openProject').textContent = uncertain ? 'Open Overleaf' : 'Open in Overleaf';
        control('openProject').disabled = busy();
        control('openFolder').hidden = !state.localFolderReady;
        control('openFolder').disabled = busy();
        control('retryLocalSetup').hidden = !state.canRetryLocalSetup;
        control('retryLocalSetup').disabled = busy();
        control('recoverSignIn').hidden = !state.canRetryLocalSetup || accountValid;
        control('recoverSignIn').disabled = busy();
        control('newProject').disabled = busy();
        control('projectForm').hidden = complete || uncertain || Boolean(state.createdProject);
    }
    window.addEventListener('message', event => {
        if (!event.data || event.data.type !== 'state') return;
        const incoming = event.data.state;
        if (!incoming || !incoming.draft || !Number.isSafeInteger(incoming.draftRevision)) return;
        if (incoming.draftRevision >= revision) {
            control('projectName').value = incoming.draft.projectName;
            control('serverUrl').value = incoming.draft.serverUrl;
            control('localCopy').checked = incoming.draft.localCopy;
            revision = incoming.draftRevision;
            pendingAction = null;
        }
        state = incoming;
        render();
    });
    vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}
