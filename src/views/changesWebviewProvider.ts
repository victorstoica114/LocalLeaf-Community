/**
 * ChangesWebviewProvider — WebviewViewProvider for the Changes sidebar panel.
 *
 * Uses a state-push model: the extension sends a JSON state object via
 * `postMessage` and the webview JS renders it.  Replaces the old
 * TreeDataProvider-based ChangesProvider and moves all sync-related
 * notifications (confirmations / toasts) inline.
 */

import * as vscode from 'vscode';
import { ChangeTracker, SyncMode, PendingChange } from '../sync/changeTracker';
import { SyncStatus } from '../sync/syncEngine';
import { changeTypeIcon, displayPath, formatTimeAgo, syncStatusDescription } from './sidebarProvider';

// ── State & message types ──────────────────────────────────────────

export interface ChangeItem {
    path: string;
    type: string;
    source: 'local' | 'remote';
    entityId?: string;
}

export interface ConfirmationRequest {
    id: string;
    message: string;
    buttons: { label: string; value: string; primary?: boolean; danger?: boolean }[];
}

export interface ToastMessage {
    id: string;
    message: string;
    type: 'info' | 'warning' | 'error';
}

interface ChangesViewState {
    syncMode: SyncMode;
    syncStatus: SyncStatus;
    statusText: string;
    conflicts: ChangeItem[];
    remoteChanges: ChangeItem[];
    localChanges: ChangeItem[];
    confirmation: ConfirmationRequest | null;
    toasts: ToastMessage[];
}

// Messages from webview → extension
type WebviewMessage =
    | { command: 'openFile'; path: string }
    | { command: 'viewDiff'; path: string }
    | { command: 'discardChange'; path: string }
    | { command: 'resolveConflictRemote'; path: string }
    | { command: 'resolveConflictLocal'; path: string }
    | { command: 'confirmationResponse'; id: string; value: string }
    | { command: 'dismissToast'; id: string };

// ── Provider ───────────────────────────────────────────────────────

export class ChangesWebviewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'localleaf.changesView';

    private _view?: vscode.WebviewView;
    private changeTracker?: ChangeTracker;
    private trackerDisposable?: vscode.Disposable;
    private syncMode: SyncMode = 'manual';
    private syncStatus: SyncStatus = 'disconnected';
    private lastSynced?: string;
    private toasts: ToastMessage[] = [];
    private confirmation: ConfirmationRequest | null = null;
    private confirmationResolve?: (value: string) => void;
    private toastCounter = 0;

    constructor(private readonly extensionUri: vscode.Uri) {}

    // ── WebviewViewProvider ────────────────────────────────────────

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };

        webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) =>
            this.handleMessage(msg),
        );

        webviewView.webview.html = this.getHtml();
        this.pushState();
    }

    // ── Public API ─────────────────────────────────────────────────

    setChangeTracker(tracker: ChangeTracker): void {
        this.trackerDisposable?.dispose();
        this.changeTracker = tracker;
        this.trackerDisposable = tracker.onDidChange(() => this.pushState());
    }

    setSyncMode(mode: SyncMode): void {
        this.syncMode = mode;
        this.pushState();
    }

    setSyncStatus(status: SyncStatus, lastSynced?: string): void {
        this.syncStatus = status;
        if (lastSynced !== undefined) {
            this.lastSynced = lastSynced;
        }
        this.pushState();
    }

    clearChanges(): void {
        this.changeTracker?.clearAll();
        this.pushState();
    }

    refresh(): void {
        this.pushState();
    }

    /**
     * Show an inline confirmation banner and wait for the user's choice.
     * Resolves with the `value` of the button the user clicked.
     */
    showConfirmation(request: Omit<ConfirmationRequest, 'id'>): Promise<string> {
        // Auto-reveal the sidebar when a confirmation is needed
        if (this._view) {
            this._view.show?.(true);
        }

        return new Promise<string>(resolve => {
            this.confirmation = { ...request, id: String(Date.now()) };
            this.confirmationResolve = resolve;
            this.pushState();
        });
    }

    /**
     * Show an auto-dismissing toast in the sidebar.
     */
    showToast(message: string, type: 'info' | 'warning' | 'error', autoDismissMs?: number): void {
        const id = `toast-${++this.toastCounter}`;
        this.toasts.push({ id, message, type });
        this.pushState();

        if (autoDismissMs && autoDismissMs > 0) {
            setTimeout(() => {
                this.toasts = this.toasts.filter(t => t.id !== id);
                this.pushState();
            }, autoDismissMs);
        }
    }

    // ── Private ────────────────────────────────────────────────────

    private handleMessage(msg: WebviewMessage): void {
        switch (msg.command) {
            case 'openFile':
                vscode.commands.executeCommand('vscode.open', this.fileUri(msg.path));
                break;
            case 'viewDiff':
                vscode.commands.executeCommand('localleaf.viewDiff', msg.path);
                break;
            case 'discardChange':
                vscode.commands.executeCommand('localleaf.discardChange', msg.path);
                break;
            case 'resolveConflictRemote':
                vscode.commands.executeCommand('localleaf.resolveConflictRemote', msg.path);
                break;
            case 'resolveConflictLocal':
                vscode.commands.executeCommand('localleaf.resolveConflictLocal', msg.path);
                break;
            case 'confirmationResponse':
                if (this.confirmationResolve && this.confirmation?.id === msg.id) {
                    this.confirmationResolve(msg.value);
                    this.confirmationResolve = undefined;
                    this.confirmation = null;
                    this.pushState();
                }
                break;
            case 'dismissToast':
                this.toasts = this.toasts.filter(t => t.id !== msg.id);
                this.pushState();
                break;
        }
    }

    private buildState(): ChangesViewState {
        const conflicts: ChangeItem[] = [];
        const remoteChanges: ChangeItem[] = [];
        const localChanges: ChangeItem[] = [];

        if (this.changeTracker && this.syncMode === 'manual') {
            for (const c of this.changeTracker.getConflicts()) {
                conflicts.push({ path: c.path, type: c.type, source: 'local', entityId: c.entityId });
            }
            for (const c of this.changeTracker.getRemoteChanges()) {
                if (!this.changeTracker.hasLocalChange(c.path)) {
                    remoteChanges.push({ path: c.path, type: c.type, source: 'remote', entityId: c.entityId });
                }
            }
            for (const c of this.changeTracker.getLocalChanges()) {
                if (!this.changeTracker.hasRemoteChange(c.path)) {
                    localChanges.push({ path: c.path, type: c.type, source: 'local', entityId: c.entityId });
                }
            }
        }

        return {
            syncMode: this.syncMode,
            syncStatus: this.syncStatus,
            statusText: syncStatusDescription(this.syncStatus, this.lastSynced),
            conflicts,
            remoteChanges,
            localChanges,
            confirmation: this.confirmation,
            toasts: this.toasts,
        };
    }

    private pushState(): void {
        if (!this._view) { return; }
        this._view.webview.postMessage({ type: 'state', state: this.buildState() });
    }

    private fileUri(relativePath: string): vscode.Uri | undefined {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!folder) { return undefined; }
        const clean = relativePath.replace(/^\/+/, '');
        return vscode.Uri.joinPath(folder, clean);
    }

    // ── HTML ───────────────────────────────────────────────────────

    private getHtml(): string {
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
/* ── Reset ─────────────────────────────────────────── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
    line-height: 1.4;
    overflow-x: hidden;
}

/* ── Status strip ──────────────────────────────────── */
.status-strip{
    padding: 6px 12px;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
    display: flex;
    align-items: center;
    gap: 4px;
}

/* ── Confirmation banner ───────────────────────────── */
.confirmation{
    padding: 10px 12px;
    background: var(--vscode-editorWidget-background, var(--vscode-notifications-background));
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
}
.confirmation-message{
    margin-bottom: 8px;
    font-size: 0.9em;
    line-height: 1.5;
}
.confirmation-buttons{
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}
.confirmation-buttons button{
    padding: 4px 10px;
    font-size: 0.82em;
    border: none;
    border-radius: 2px;
    cursor: pointer;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
}
.confirmation-buttons button:hover{
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
}
.confirmation-buttons button.primary{
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}
.confirmation-buttons button.primary:hover{
    background: var(--vscode-button-hoverBackground);
}
.confirmation-buttons button.danger{
    background: var(--vscode-inputValidation-errorBackground, #c53030);
    color: var(--vscode-inputValidation-errorForeground, #fff);
}

/* ── Change groups ─────────────────────────────────── */
.group{
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
}
.group-header{
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    cursor: pointer;
    user-select: none;
    font-size: 0.82em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    background: var(--vscode-sideBarSectionHeader-background, transparent);
}
.group-header:hover{
    background: var(--vscode-list-hoverBackground);
}
.group-header .chevron{
    font-size: 0.9em;
    transition: transform 0.15s;
}
.group-header.collapsed .chevron{
    transform: rotate(-90deg);
}
.group-body.hidden{
    display: none;
}

/* ── Change items ──────────────────────────────────── */
.change-item{
    display: flex;
    align-items: center;
    padding: 3px 12px 3px 24px;
    font-size: 0.9em;
    cursor: pointer;
    position: relative;
}
.change-item:hover{
    background: var(--vscode-list-hoverBackground);
}
.change-item .icon{
    width: 16px;
    text-align: center;
    margin-right: 6px;
    flex-shrink: 0;
    font-size: 0.9em;
}
.change-item .name{
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.change-item .desc{
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    margin-left: 6px;
    flex-shrink: 0;
}
.change-item .actions{
    display: none;
    gap: 2px;
    margin-left: 6px;
    flex-shrink: 0;
}
.change-item:hover .actions{
    display: flex;
}
.change-item:hover .desc{
    display: none;
}
.action-btn{
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 0.85em;
    opacity: 0.7;
}
.action-btn:hover{
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,.31));
}

/* ── Toasts ────────────────────────────────────────── */
.toasts{
    padding: 0 8px;
}
.toast{
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    margin: 4px 0;
    border-radius: 4px;
    font-size: 0.85em;
    animation: fadeIn 0.2s;
}
.toast.info{
    background: var(--vscode-editorInfo-background, rgba(0,120,212,.15));
    color: var(--vscode-editorInfo-foreground, var(--vscode-foreground));
}
.toast.warning{
    background: var(--vscode-editorWarning-background, rgba(255,204,0,.15));
    color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
}
.toast.error{
    background: var(--vscode-editorError-background, rgba(255,18,18,.15));
    color: var(--vscode-editorError-foreground, var(--vscode-foreground));
}
.toast .toast-msg{ flex:1; }
.toast .dismiss{
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0 2px;
    opacity: 0.6;
    font-size: 1em;
}
.toast .dismiss:hover{ opacity:1; }

/* ── Empty state ───────────────────────────────────── */
.empty{
    padding: 20px 12px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
}

/* ── Realtime badge ────────────────────────────────── */
.realtime-badge{
    padding: 12px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
}

/* ── Animations ────────────────────────────────────── */
@keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
</style>
</head>
<body>
    <div id="root"></div>
    <script>
    (function(){
        const vscode = acquireVsCodeApi();
        const root = document.getElementById('root');
        let state = null;
        let collapsedGroups = {};

        window.addEventListener('message', e => {
            if (e.data.type === 'state') {
                state = e.data.state;
                render();
            }
        });

        function h(tag, attrs, ...children) {
            const el = document.createElement(tag);
            if (attrs) {
                for (const [k, v] of Object.entries(attrs)) {
                    if (k === 'className') el.className = v;
                    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
                    else if (k === 'title') el.title = v;
                    else el.setAttribute(k, v);
                }
            }
            for (const c of children) {
                if (typeof c === 'string') el.appendChild(document.createTextNode(c));
                else if (c) el.appendChild(c);
            }
            return el;
        }

        function changeIcon(type) {
            const map = {modified:'M', created:'+', deleted:'-', renamed:'R', moved:'V'};
            return map[type] || '?';
        }
        function changeIconColor(type) {
            const map = {
                modified: 'var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d)',
                created: 'var(--vscode-gitDecoration-untrackedResourceForeground, #73c991)',
                deleted: 'var(--vscode-gitDecoration-deletedResourceForeground, #c74e39)',
                renamed: 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
                moved: 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
            };
            return map[type] || 'inherit';
        }

        function fileName(p) {
            const clean = p.replace(/^\\/+/, '').replace(/\\/+$/, '');
            return clean.split('/').pop() || clean;
        }

        function renderStatusStrip() {
            return h('div', {className:'status-strip'}, state.statusText);
        }

        function renderConfirmation() {
            if (!state.confirmation) return null;
            const c = state.confirmation;
            const btns = c.buttons.map(b => {
                let cls = '';
                if (b.primary) cls = 'primary';
                if (b.danger) cls = 'danger';
                return h('button', {
                    className: cls,
                    onClick: () => vscode.postMessage({command:'confirmationResponse', id:c.id, value:b.value}),
                }, b.label);
            });
            return h('div', {className:'confirmation'},
                h('div', {className:'confirmation-message'}, c.message),
                h('div', {className:'confirmation-buttons'}, ...btns),
            );
        }

        function renderChangeItem(item, groupType) {
            const actions = [];
            if (groupType === 'conflict') {
                actions.push(
                    h('button', {className:'action-btn', title:'View Diff', onClick:e=>{e.stopPropagation();vscode.postMessage({command:'viewDiff',path:item.path})}}, 'Diff'),
                    h('button', {className:'action-btn', title:'Use Remote', onClick:e=>{e.stopPropagation();vscode.postMessage({command:'resolveConflictRemote',path:item.path})}}, 'Remote'),
                    h('button', {className:'action-btn', title:'Use Local', onClick:e=>{e.stopPropagation();vscode.postMessage({command:'resolveConflictLocal',path:item.path})}}, 'Local'),
                );
            } else {
                actions.push(
                    h('button', {className:'action-btn', title:'Discard', onClick:e=>{e.stopPropagation();vscode.postMessage({command:'discardChange',path:item.path})}}, 'Discard'),
                );
            }

            const openCmd = groupType === 'conflict' ? 'viewDiff' : 'openFile';
            return h('div', {className:'change-item', title: item.path, onClick:()=>vscode.postMessage({command:openCmd, path:item.path})},
                h('span', {className:'icon', style:'color:'+changeIconColor(item.type)}, changeIcon(item.type)),
                h('span', {className:'name'}, fileName(item.path)),
                h('span', {className:'desc'}, item.type),
                h('span', {className:'actions'}, ...actions),
            );
        }

        function renderGroup(id, label, icon, items, groupType) {
            if (items.length === 0) return null;
            const isCollapsed = !!collapsedGroups[id];
            const header = h('div', {
                className: 'group-header' + (isCollapsed ? ' collapsed' : ''),
                onClick: () => { collapsedGroups[id] = !collapsedGroups[id]; render(); },
            },
                h('span', {className:'chevron'}, isCollapsed ? '\u25B8' : '\u25BE'),
                icon + ' ' + label + ' (' + items.length + ')',
            );
            const body = h('div', {className: 'group-body' + (isCollapsed ? ' hidden' : '')},
                ...items.map(it => renderChangeItem(it, groupType)),
            );
            return h('div', {className:'group'}, header, body);
        }

        function renderToasts() {
            if (!state.toasts || state.toasts.length === 0) return null;
            return h('div', {className:'toasts'},
                ...state.toasts.map(t =>
                    h('div', {className:'toast ' + t.type},
                        h('span', {className:'toast-msg'}, t.message),
                        h('button', {className:'dismiss', title:'Dismiss', onClick:()=>vscode.postMessage({command:'dismissToast',id:t.id})}, '\u00d7'),
                    )
                ),
            );
        }

        function render() {
            if (!state) { root.innerHTML = ''; return; }
            root.innerHTML = '';

            root.appendChild(renderStatusStrip());

            // Toasts (top, below status)
            const toastsEl = renderToasts();
            if (toastsEl) root.appendChild(toastsEl);

            // Confirmation banner
            const confEl = renderConfirmation();
            if (confEl) root.appendChild(confEl);

            if (state.syncMode === 'realtime') {
                root.appendChild(h('div', {className:'realtime-badge'}, '\u26A1 Real-time sync active'));
                return;
            }

            // Change groups
            const conflictsEl = renderGroup('conflicts', 'Conflicts', '\u26A0', state.conflicts, 'conflict');
            const remoteEl = renderGroup('remote', 'Remote Changes', '\u2193', state.remoteChanges, 'remote');
            const localEl = renderGroup('local', 'Local Changes', '\u2191', state.localChanges, 'local');

            if (conflictsEl) root.appendChild(conflictsEl);
            if (remoteEl) root.appendChild(remoteEl);
            if (localEl) root.appendChild(localEl);

            if (!conflictsEl && !remoteEl && !localEl && !confEl) {
                root.appendChild(h('div', {className:'empty'}, 'No file changes yet.\\nChanges will appear here as files are synced.'));
            }
        }
    })();
    </script>
</body>
</html>`;
    }
}
