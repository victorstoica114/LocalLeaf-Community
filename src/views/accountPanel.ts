import * as vscode from 'vscode';
import { createNonce } from './webviewUtils';

export type AccountPanelAuthState = 'valid' | 'expired' | 'unknown' | 'none';
export type AccountPanelBrowserPreference = 'auto' | 'system' | 'chrome' | 'edge';
export type AccountPanelOperationKind = 'browserLogin' | 'cookieLogin' | 'verifySession' | 'logout';

export interface AccountPanelOperation {
    kind: AccountPanelOperationKind;
    message: string;
    cancellable: boolean;
}

export interface AccountPanelState {
    serverUrl: string;
    loggedIn: boolean;
    authState: AccountPanelAuthState;
    userEmail?: string;
    operation?: AccountPanelOperation;
}

export type AccountPanelAction =
    | { type: 'loginBrowser'; serverUrl: string; browserPreference: AccountPanelBrowserPreference }
    | { type: 'loginCookies'; serverUrl: string; cookies: string }
    | { type: 'verifySession'; serverUrl: string }
    | { type: 'selectServer'; serverUrl: string }
    | { type: 'cancelLogin' }
    | { type: 'logout'; serverUrl: string }
    | { type: 'openTutorial' };

/** Account management surface adapted from Xingyu Chen's work in PR #3. */
export class AccountPanel {
    static readonly viewType = 'localleaf.accountPanel';
    private static instance: AccountPanel | undefined;

    private state: AccountPanelState;

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        initialState: AccountPanelState,
        private readonly onAction: (action: AccountPanelAction) => Promise<void>,
    ) {
        this.state = initialState;
        this.panel.onDidDispose(() => {
            AccountPanel.instance = undefined;
            if (this.state.operation?.kind === 'browserLogin' && this.state.operation.cancellable) {
                void this.onAction({ type: 'cancelLogin' }).catch(error => {
                    console.error('[LocalLeaf] Failed to cancel browser login:', error);
                });
            }
        });
        this.panel.webview.onDidReceiveMessage((message: unknown) => {
            if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'ready') {
                this.updateState(this.state);
                return;
            }
            const action = this.parseAction(message);
            if (action) {
                void this.onAction(action).catch(error => {
                    console.error('[LocalLeaf] Account action failed:', error);
                });
            }
        });
        this.panel.webview.html = this.getHtml(this.panel.webview);
    }

    static createOrShow(
        extensionUri: vscode.Uri,
        state: AccountPanelState,
        onAction: (action: AccountPanelAction) => Promise<void>,
    ): AccountPanel {
        if (AccountPanel.instance) {
            AccountPanel.instance.panel.reveal(vscode.ViewColumn.Active);
            AccountPanel.instance.updateState(state);
            return AccountPanel.instance;
        }

        const panel = vscode.window.createWebviewPanel(
            AccountPanel.viewType,
            'LocalLeaf Connection Settings',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'images')],
            },
        );
        AccountPanel.instance = new AccountPanel(panel, state, onAction);
        return AccountPanel.instance;
    }

    static updateIfOpen(state: AccountPanelState): void {
        AccountPanel.instance?.updateState(state);
    }

    private updateState(state: AccountPanelState): void {
        this.state = state;
        void this.panel.webview.postMessage({ type: 'state', state }).then(undefined, error => {
            console.error('[LocalLeaf] Failed to update Account panel:', error);
        });
    }

    private parseAction(raw: unknown): AccountPanelAction | undefined {
        if (!raw || typeof raw !== 'object') return undefined;
        const message = raw as Record<string, unknown>;
        if (message.type === 'selectServer') {
            if (typeof message.serverUrl !== 'string' || !message.serverUrl.trim()) return undefined;
            return { type: 'selectServer', serverUrl: message.serverUrl.trim() };
        }
        if (message.type === 'cancelLogin') return { type: 'cancelLogin' };
        if (message.type === 'logout') {
            const serverUrl = String(message.serverUrl || '').trim();
            if (serverUrl) return { type: 'logout', serverUrl };
        }
        if (message.type === 'openTutorial') return { type: 'openTutorial' };
        if (message.type === 'verifySession') {
            const serverUrl = String(message.serverUrl || '').trim();
            if (serverUrl) return { type: 'verifySession', serverUrl };
        }
        if (message.type === 'loginBrowser') {
            const serverUrl = String(message.serverUrl || '').trim();
            const browserPreference = String(message.browserPreference || 'auto');
            if (serverUrl && ['auto', 'system', 'chrome', 'edge'].includes(browserPreference)) {
                return {
                    type: 'loginBrowser',
                    serverUrl,
                    browserPreference: browserPreference as AccountPanelBrowserPreference,
                };
            }
        }
        if (message.type === 'loginCookies') {
            if (typeof message.serverUrl !== 'string' || typeof message.cookies !== 'string') {
                return undefined;
            }
            const serverUrl = message.serverUrl.trim();
            const cookies = message.cookies.trim();
            if (
                serverUrl
                && serverUrl.length <= 8192
                && cookies
                && cookies.length <= 65536
                && !/[\r\n\0]/.test(cookies)
            ) {
                return { type: 'loginCookies', serverUrl, cookies };
            }
        }
        return undefined;
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = createNonce();

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>LocalLeaf Connection Settings</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; }
        body {
            margin: 0; padding: 28px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background);
            font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
        }
        .layout { max-width: 720px; margin: 0 auto; }
        .eyebrow { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .08em; }
        h1 { margin: 5px 0 6px; font-size: 24px; font-weight: 650; }
        .lead { margin: 0 0 22px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
        .card { padding: 18px; border: 1px solid var(--vscode-panel-border); border-radius: 10px; background: var(--vscode-editorWidget-background); }
        .status, .operation { display: grid; grid-template-columns: 12px minmax(0, 1fr); gap: 10px; align-items: start; padding: 11px; margin-bottom: 18px; border: 1px solid var(--vscode-panel-border); border-radius: 7px; background: var(--vscode-sideBar-background); }
        .status-dot, .spinner { width: 9px; height: 9px; margin-top: 4px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
        .status.valid .status-dot { background: var(--vscode-testing-iconPassed, #2ea043); }
        .status.expired .status-dot { background: var(--vscode-editorWarning-foreground); }
        .status-title { font-weight: 650; }
        .status-copy { display: block; margin-top: 2px; color: var(--vscode-descriptionForeground); }
        .operation { grid-template-columns: 12px minmax(0, 1fr) auto; border-color: var(--vscode-focusBorder); }
        .spinner { border: 2px solid var(--vscode-progressBar-background); border-right-color: transparent; background: transparent; animation: spin .8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .spinner { animation: none; border-right-color: var(--vscode-progressBar-background); } }
        .field { margin-top: 14px; }
        label { display: block; margin-bottom: 6px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; }
        input, textarea, select {
            width: 100%; padding: 8px 10px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit;
        }
        textarea { min-height: 94px; resize: vertical; font-family: var(--vscode-editor-font-family); }
        input:focus-visible, textarea:focus-visible, select:focus-visible, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
        .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
        button { padding: 8px 12px; border: 0; border-radius: 6px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font: inherit; cursor: pointer; }
        button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
        button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
        button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
        button:disabled { cursor: default; opacity: .55; }
        details { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--vscode-panel-border); }
        summary { color: var(--vscode-descriptionForeground); cursor: pointer; }
        .hint { margin-top: 8px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }
        [hidden] { display: none !important; }
    </style>
</head>
<body>
    <main class="layout">
        <div class="eyebrow">LocalLeaf</div>
        <h1>Connection settings</h1>
        <p class="lead">Choose an Overleaf server and manage your account. You can switch servers even when the current connection is unavailable.</p>
        <section id="accountCard" class="card" aria-busy="false">
            <div id="status" class="status" role="status" aria-live="polite">
                <span class="status-dot"></span>
                <span><span id="statusTitle" class="status-title"></span><span id="statusCopy" class="status-copy"></span></span>
            </div>

            <div id="operation" class="operation" role="status" aria-live="polite" hidden>
                <span class="spinner"></span>
                <span id="operationCopy"></span>
                <button id="cancelLogin" type="button">Cancel</button>
            </div>

            <div class="field">
                <label for="serverUrl">Overleaf server</label>
                <input id="serverUrl" type="url" autocomplete="url" placeholder="https://www.overleaf.com">
                <div class="actions"><button id="selectServer" type="button" class="primary">Use This Server</button></div>
                <p class="hint">Select the server used to browse projects. Existing project links keep their own server.</p>
            </div>
            <div class="field">
                <label for="browserPreference">Browser</label>
                <select id="browserPreference">
                    <option value="auto">Auto (recommended)</option>
                    <option value="system">System default</option>
                    <option value="chrome">Google Chrome</option>
                    <option value="edge">Microsoft Edge</option>
                </select>
            </div>

            <div id="signedOut">
                <div class="actions">
                    <button id="loginBrowser" type="button" class="primary">Sign in with Browser</button>
                </div>
                <p class="hint">LocalLeaf opens a temporary browser profile, waits for you to sign in, and stores only the resulting Overleaf session in VS Code Secret Storage.</p>
            </div>

            <div id="signedIn" hidden>
                <div class="actions">
                    <button id="verifySession" type="button" class="primary">Verify Session</button>
                    <button id="refreshSession" type="button">Re-authenticate</button>
                    <button id="logout" type="button">Log Out</button>
                </div>
                <p class="hint">Re-authenticate opens the same isolated browser flow and replaces the stored session only after validation succeeds.</p>
            </div>

            <details>
                <summary>Use session cookies manually</summary>
                <div class="field">
                    <label for="cookies">Session cookies</label>
                    <textarea id="cookies" spellcheck="false" autocomplete="off" placeholder="overleaf_session2=..."></textarea>
                </div>
                <div class="actions">
                    <button id="loginCookies" type="button">Use These Cookies</button>
                    <button id="tutorial" type="button">Cookie Tutorial</button>
                </div>
            </details>
        </section>
    </main>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const saved = vscode.getState() || {};
        let state = { serverUrl: '', loggedIn: false, authState: 'none' };
        let serverDraft;
        const normalizeServer = value => String(value || '').trim().replace(/\\/+$/, '');
        const status = document.getElementById('status');
        const accountCard = document.getElementById('accountCard');
        const statusTitle = document.getElementById('statusTitle');
        const statusCopy = document.getElementById('statusCopy');
        const operation = document.getElementById('operation');
        const operationCopy = document.getElementById('operationCopy');
        const cancelLogin = document.getElementById('cancelLogin');
        const signedOut = document.getElementById('signedOut');
        const signedIn = document.getElementById('signedIn');
        const serverUrl = document.getElementById('serverUrl');
        const selectServer = document.getElementById('selectServer');
        const browserPreference = document.getElementById('browserPreference');
        const cookies = document.getElementById('cookies');
        const loginBrowser = document.getElementById('loginBrowser');
        const loginCookies = document.getElementById('loginCookies');
        const verifySession = document.getElementById('verifySession');
        const refreshSession = document.getElementById('refreshSession');
        const logout = document.getElementById('logout');
        const tutorial = document.getElementById('tutorial');
        const preferenceValues = ['auto', 'system', 'chrome', 'edge'];
        browserPreference.value = preferenceValues.includes(saved.browserPreference) ? saved.browserPreference : 'auto';

        function browserPayload() {
            return {
                type: 'loginBrowser',
                serverUrl: (serverUrl.value || state.serverUrl || '').trim(),
                browserPreference: browserPreference.value,
            };
        }

        function render() {
            serverUrl.value = serverDraft ?? state.serverUrl ?? '';
            const changingServer = normalizeServer(serverUrl.value) !== normalizeServer(state.serverUrl);
            const hasCredential = !changingServer && Boolean(state.loggedIn);
            const valid = hasCredential && state.authState === 'valid';
            const busy = Boolean(state.operation);
            accountCard.setAttribute('aria-busy', String(busy));
            status.className = 'status ' + (valid ? 'valid' : state.authState === 'expired' ? 'expired' : 'none');
            if (changingServer) {
                statusTitle.textContent = 'New connection';
                statusCopy.textContent = 'Use this server to switch connections, then sign in if needed.';
            } else if (valid) {
                statusTitle.textContent = 'Session verified';
                statusCopy.textContent = 'Signed in as ' + (state.userEmail || 'unknown account') + ' on ' + state.serverUrl + '.';
            } else if (hasCredential && state.authState !== 'expired') {
                statusTitle.textContent = 'Session stored';
                statusCopy.textContent = 'Signed in as ' + (state.userEmail || 'unknown account') + '. Verify the session to confirm it is still valid.';
            } else if (state.authState === 'expired') {
                statusTitle.textContent = 'Session expired';
                statusCopy.textContent = 'The session for ' + (state.userEmail || 'this account') + ' expired. Sign in again to continue synchronizing.';
            } else {
                statusTitle.textContent = 'Not connected';
                statusCopy.textContent = 'Sign in to browse and synchronize Overleaf projects.';
            }
            signedOut.hidden = hasCredential;
            signedIn.hidden = !hasCredential;
            operation.hidden = !busy;
            operationCopy.textContent = busy ? state.operation.message : '';
            cancelLogin.hidden = !busy || !state.operation.cancellable;
            document.querySelectorAll('input, textarea, select, button').forEach(control => {
                control.disabled = busy;
            });
            serverUrl.readOnly = false;
            selectServer.disabled = busy || !changingServer;
            loginBrowser.disabled = busy || changingServer;
            loginCookies.disabled = busy || changingServer;
            cancelLogin.disabled = !busy || !state.operation.cancellable;
            verifySession.hidden = state.authState === 'expired';
            refreshSession.className = state.authState === 'expired' ? 'primary' : '';
            refreshSession.textContent = state.authState === 'expired' ? 'Sign in again with Browser' : 'Re-authenticate';
            loginBrowser.textContent = 'Sign in with Browser';
            if (hasCredential) cookies.value = '';
        }

        function submitBrowserLogin() {
            const payload = browserPayload();
            if (!payload.serverUrl) {
                status.className = 'status expired';
                statusTitle.textContent = 'Missing server';
                statusCopy.textContent = 'Enter the Overleaf server URL.';
                return;
            }
            vscode.setState({ browserPreference: payload.browserPreference });
            vscode.postMessage(payload);
        }

        serverUrl.addEventListener('input', () => {
            serverDraft = serverUrl.value;
            cookies.value = '';
            render();
        });
        selectServer.addEventListener('click', () => {
            const selectedServer = serverUrl.value.trim();
            if (!selectedServer) {
                statusTitle.textContent = 'Missing server';
                statusCopy.textContent = 'Enter the Overleaf server URL.';
                return;
            }
            vscode.postMessage({ type: 'selectServer', serverUrl: selectedServer });
        });
        loginBrowser.addEventListener('click', submitBrowserLogin);
        refreshSession.addEventListener('click', submitBrowserLogin);
        verifySession.addEventListener('click', () => vscode.postMessage({ type: 'verifySession', serverUrl: state.serverUrl }));
        cancelLogin.addEventListener('click', () => vscode.postMessage({ type: 'cancelLogin' }));
        tutorial.addEventListener('click', () => vscode.postMessage({ type: 'openTutorial' }));
        logout.addEventListener('click', () => vscode.postMessage({ type: 'logout', serverUrl: state.serverUrl }));
        loginCookies.addEventListener('click', () => {
            const normalizedServer = serverUrl.value.trim();
            const normalizedCookies = cookies.value.trim();
            if (!normalizedServer || !normalizedCookies) {
                status.className = 'status expired';
                statusTitle.textContent = 'Missing information';
                statusCopy.textContent = 'Enter both the server URL and session cookies.';
                return;
            }
            cookies.value = '';
            vscode.postMessage({ type: 'loginCookies', serverUrl: normalizedServer, cookies: normalizedCookies });
        });
        window.addEventListener('message', event => {
            if (event.data && event.data.type === 'state') {
                if (state.serverUrl !== event.data.state.serverUrl) {
                    serverDraft = undefined;
                    cookies.value = '';
                }
                state = event.data.state;
                render();
            }
        });
        render();
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}
