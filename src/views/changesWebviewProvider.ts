/**
 * ChangesWebviewProvider — WebviewViewProvider for the Changes sidebar panel.
 *
 * Uses a state-push model: the extension sends a JSON state object via
 * `postMessage` and the webview JS renders it.  Replaces the old
 * TreeDataProvider-based ChangesProvider and moves all sync-related
 * notifications (confirmations / notices) inline.
 */

import * as vscode from 'vscode';
import { ChangeTracker, SyncMode, PendingChange } from '../sync/changeTracker';
import { SyncStatus } from '../sync/syncEngine';
import { changeTypeIcon, displayPath, formatTimeAgo, syncStatusDescription } from './sidebarProvider';
import { SettingsManager } from '../utils/settingsManager';
import { PanelNotificationCenter, PanelNotificationState } from './panelNotificationCenter';

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

export interface OnlineUserInfo {
    clientId: string;
    name: string;
    color: string;
    initials: string;
    docPath?: string;
    row?: number;
}

interface ChangesViewState {
    syncMode: SyncMode;
    syncStatus: SyncStatus;
    statusText: string;
    conflicts: ChangeItem[];
    remoteChanges: ChangeItem[];
    localChanges: ChangeItem[];
    notifications: PanelNotificationState;
    onlineUsers: OnlineUserInfo[];
}

// Messages from webview → extension
type WebviewMessage =
    | { command: 'openFile'; path: string }
    | { command: 'viewDiff'; path: string }
    | { command: 'discardChange'; path: string }
    | { command: 'resolveConflictRemote'; path: string }
    | { command: 'resolveConflictLocal'; path: string }
    | { command: 'confirmationResponse'; id: string; value: string }
    | { command: 'dismissNotice'; id: string }
    | { command: 'jumpToUser'; clientId: string }
    | { command: 'toggleSyncMode' };

// ── Provider ───────────────────────────────────────────────────────

export class ChangesWebviewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'localleaf.changesView';

    private _view?: vscode.WebviewView;
    private changeTracker?: ChangeTracker;
    private trackerDisposable?: vscode.Disposable;
    private syncMode: SyncMode = 'manual';
    private syncStatus: SyncStatus = 'disconnected';
    private lastSynced?: string;
    private onlineUsers: OnlineUserInfo[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly notifications: PanelNotificationCenter,
    ) {
        this.notifications.subscribe(() => this.pushState());
    }

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
     * Show a choice modal and wait for the user's choice.
     * Resolves with the `value` of the button the user clicked.
     */
    showConfirmation(request: Omit<ConfirmationRequest, 'id'>): Promise<string> {
        // Auto-reveal the sidebar when a confirmation is needed
        if (this._view) {
            this._view.show?.(true);
        }

        return this.notifications.showModal({ ...request, type: 'warning' });
    }

    /**
     * Show a coalesced notice in the sidebar.
     */
    showNotice(message: string, type: 'info' | 'warning' | 'error', autoDismissMs?: number): void {
        const id = this.notifications.showNotice(message, type);
        const revision = this.notifications.getState().notice?.revision;

        if (autoDismissMs && autoDismissMs > 0) {
            setTimeout(() => {
                this.notifications.dismissNotice(id, revision);
            }, autoDismissMs);
        }
    }

    /**
     * Update the online users displayed in the sidebar.
     */
    setOnlineUsers(users: OnlineUserInfo[]): void {
        this.onlineUsers = users;
        this.pushState();
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
                this.notifications.respondToModal(msg.id, msg.value);
                break;
            case 'dismissNotice':
                this.notifications.dismissNotice(msg.id);
                break;
            case 'jumpToUser':
                vscode.commands.executeCommand('localleaf.jumpToCollaborator', msg.clientId);
                break;
            case 'toggleSyncMode':
                vscode.commands.executeCommand('localleaf.toggleSyncMode');
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
            notifications: this.notifications.getState(),
            onlineUsers: this.onlineUsers,
        };
    }

    private pushState(): void {
        if (!this._view) { return; }
        this._view.webview.postMessage({ type: 'state', state: this.buildState() });
    }

    private fileUri(relativePath: string): vscode.Uri | undefined {
        const folder = SettingsManager.getCurrentInstance()?.getWorkspaceFolder()
            ?? vscode.workspace.workspaceFolders?.[0]?.uri;
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
    justify-content: space-between;
    gap: 4px;
}
.status-left{
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.status-right{
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    font-size: 0.95em;
}
.sync-mode-label{
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
}
.sync-toggle{
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1em;
    font-weight: 600;
    padding: 1px 4px;
    border-radius: 3px;
}
.sync-toggle.on{
    color: var(--vscode-charts-green, #89d185);
}
.sync-toggle.off{
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
}
.sync-toggle:hover{
    background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,.31));
}

/* ── Notifications ─────────────────────────────────── */
.notice-status-bar{
    margin: 0;
    min-height: 34px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
    border-left: 3px solid transparent;
    border-radius: 0;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    animation: noticeIn 0.14s ease-out;
    contain: layout paint;
}
.notice-status-bar.info{ border-left-color: var(--vscode-editorInfo-foreground, #3794ff); }
.notice-status-bar.warning{ border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
.notice-status-bar.error{ border-left-color: var(--vscode-editorError-foreground, #f14c4c); }
.notice-msg{
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.86em;
}
.notice-count{
    color: var(--vscode-descriptionForeground);
    font-size: 0.78em;
    flex-shrink: 0;
}
.notice-dismiss{
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    opacity: 0.65;
    padding: 1px 4px;
    border-radius: 3px;
}
.notice-dismiss:hover{ opacity:1; background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,.31)); }
.choice-modal-backdrop{
    position: fixed;
    inset: 0;
    z-index: 20;
    display: flex;
    align-items: flex-start;
    padding: 12px 8px;
    background: rgba(0,0,0,.28);
    animation: fadeIn 0.12s ease-out;
}
.choice-modal{
    width: 100%;
    border: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
    border-top: 3px solid transparent;
    border-radius: 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    box-shadow: 0 8px 24px rgba(0,0,0,.32);
    overflow: hidden;
}
.choice-modal.info{ border-top-color: var(--vscode-editorInfo-foreground, #3794ff); }
.choice-modal.warning{ border-top-color: var(--vscode-editorWarning-foreground, #cca700); }
.choice-modal.error{ border-top-color: var(--vscode-editorError-foreground, #f14c4c); }
.choice-message{
    padding: 12px;
    line-height: 1.45;
    font-size: 0.9em;
    white-space: pre-wrap;
    word-break: break-word;
}
.choice-buttons{
    display: flex;
    gap: 6px;
    padding: 0 12px 12px;
    flex-wrap: wrap;
}
.choice-buttons button{
    padding: 4px 10px;
    font-size: 0.82em;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
}
.choice-buttons button:hover{ background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
.choice-buttons button.primary{ background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.choice-buttons button.primary:hover{ background: var(--vscode-button-hoverBackground); }
.choice-buttons button.danger{ background: var(--vscode-inputValidation-errorBackground, #c53030); color: var(--vscode-inputValidation-errorForeground, #fff); }

.notice-history{
    display: none;
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

/* ── Empty state ───────────────────────────────────── */
.empty{
    padding: 20px 12px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
}

/* ── Online users ──────────────────────────────────── */
.online-users{
    padding: 8px 12px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
}
.online-users-label{
    font-size: 0.75em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
    margin-right: 2px;
}
.avatar{
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7em;
    font-weight: 700;
    color: #000;
    cursor: pointer;
    flex-shrink: 0;
    transition: transform 0.1s;
    position: relative;
}
.avatar:hover{
    transform: scale(1.15);
}
.avatar-tooltip{
    display: none;
    position: absolute;
    bottom: calc(100% + 4px);
    left: 50%;
    transform: translateX(-50%);
    background: var(--vscode-editorWidget-background, #252526);
    color: var(--vscode-foreground);
    padding: 3px 8px;
    border-radius: 3px;
    font-size: 0.8em;
    font-weight: 400;
    white-space: nowrap;
    z-index: 10;
    pointer-events: none;
    box-shadow: 0 2px 6px rgba(0,0,0,.3);
}
.avatar:hover .avatar-tooltip{
    display: block;
}

/* ── Animations ────────────────────────────────────── */
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes noticeIn{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:translateY(0)}}
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

        function renderOnlineUsers() {
            if (!state.onlineUsers || state.onlineUsers.length === 0) return null;
            const avatars = state.onlineUsers.map(u => {
                const tip = u.docPath
                    ? u.name + ' — ' + u.docPath + ':' + ((u.row || 0) + 1)
                    : u.name;
                return h('div', {
                    className: 'avatar',
                    style: 'background:' + u.color,
                    title: '',
                    onClick: () => vscode.postMessage({ command: 'jumpToUser', clientId: u.clientId }),
                },
                    u.initials,
                    h('span', { className: 'avatar-tooltip' }, tip),
                );
            });
            return h('div', { className: 'online-users' },
                h('span', { className: 'online-users-label' }, 'Online'),
                ...avatars,
            );
        }

        function renderStatusStrip() {
            const isRealtime = state.syncMode === 'realtime';
            const toggleLabel = isRealtime ? 'ON' : 'OFF';
            const toggleCls = 'sync-toggle ' + (isRealtime ? 'on' : 'off');

            return h('div', {className:'status-strip'},
                h('span', {className:'status-left'}, state.statusText),
                h('span', {className:'status-right'},
                    h('span', {className:'sync-mode-label'}, 'Real-time sync'),
                    h('button', {
                        className: toggleCls,
                        title: isRealtime ? 'Switch to manual sync' : 'Switch to real-time sync',
                        onClick: () => vscode.postMessage({command:'toggleSyncMode'}),
                    }, toggleLabel),
                ),
            );
        }

        function renderChoiceModal() {
            const c = state.notifications && state.notifications.modal;
            if (!c) return null;
            const btns = c.buttons.map(b => {
                let cls = '';
                if (b.primary) cls = 'primary';
                if (b.danger) cls = 'danger';
                return h('button', {
                    className: cls,
                    onClick: () => vscode.postMessage({command:'confirmationResponse', id:c.id, value:b.value}),
                }, b.label);
            });
            return h('div', {className:'choice-modal-backdrop'},
                h('div', {className:'choice-modal ' + c.type},
                    h('div', {className:'choice-message'}, c.message),
                    h('div', {className:'choice-buttons'}, ...btns),
                ),
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

        function renderPanelNotice() {
            const n = state.notifications && state.notifications.notice;
            if (!n) return null;
            const count = n.count > 1 ? 'x' + n.count : '';
            const title = n.history && n.history.length > 1 ? n.history.join('\\n') : n.message;
            return h('div', {className:'notice-status-bar ' + n.type, title},
                h('span', {className:'notice-msg'}, n.message),
                count ? h('span', {className:'notice-count'}, count) : null,
                h('button', {
                    className:'notice-dismiss',
                    title:'Dismiss',
                    onClick:()=>vscode.postMessage({command:'dismissNotice',id:n.id}),
                }, '\u00d7'),
            );
        }

        function render() {
            if (!state) { root.innerHTML = ''; return; }
            root.innerHTML = '';

            const noticeEl = renderPanelNotice();
            if (noticeEl) root.appendChild(noticeEl);

            root.appendChild(renderStatusStrip());

            const usersEl = renderOnlineUsers();
            if (usersEl) root.appendChild(usersEl);

            // Change groups
            const conflictsEl = renderGroup('conflicts', 'Conflicts', '\u26A0', state.conflicts, 'conflict');
            const remoteEl = renderGroup('remote', 'Remote Changes', '\u2193', state.remoteChanges, 'remote');
            const localEl = renderGroup('local', 'Local Changes', '\u2191', state.localChanges, 'local');

            if (conflictsEl) root.appendChild(conflictsEl);
            if (remoteEl) root.appendChild(remoteEl);
            if (localEl) root.appendChild(localEl);

            if (!conflictsEl && !remoteEl && !localEl) {
                root.appendChild(h('div', {className:'empty'}, 'No file changes yet.\\nChanges will appear here as files are synced.'));
            }

            const choiceEl = renderChoiceModal();
            if (choiceEl) root.appendChild(choiceEl);
        }
    })();
    </script>
</body>
</html>`;
    }
}
