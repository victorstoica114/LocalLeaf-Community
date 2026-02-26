/**
 * LocalLeaf Sidebar Providers
 *
 * Three TreeDataProviders for the sidebar:
 * - ProjectsProvider: project list when not linked (with sort/filter)
 * - ChangesProvider: grouped change tree when linked (manual mode: conflicts/incoming/outgoing/activity, realtime: activity)
 * - DetailsProvider: server/account/compiler info when linked (collapsed)
 */

import * as vscode from 'vscode';
import { BaseAPI, ProjectInfo } from '../api/base';
import { CredentialManager, ServerCredential } from '../utils/credentialManager';
import { SettingsManager } from '../utils/settingsManager';
import { COMMANDS } from '../consts';
import { SyncStatus } from '../sync/syncEngine';
import { ChangeTracker, PendingChange, SyncMode } from '../sync/changeTracker';

// ── Changed file tracking ──────────────────────────────────────────

export type ChangeDirection = 'push' | 'pull';

export interface FileChange {
    path: string;
    direction: ChangeDirection;
    timestamp: number;
}

// ── Projects Provider (not-linked state, with sort/filter) ──────────

export type ProjectSortField = 'name' | 'lastUpdated' | 'accessLevel';
export type SortOrder = 'asc' | 'desc';

export class ProjectsProvider implements vscode.TreeDataProvider<SidebarItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private sortField: ProjectSortField = 'lastUpdated';
    private sortOrder: SortOrder = 'desc';
    private filterText: string = '';

    constructor(private credentialManager: CredentialManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setFilter(text: string): void {
        this.filterText = text;
        this.refresh();
    }

    getFilter(): string {
        return this.filterText;
    }

    setSortField(field: ProjectSortField): void {
        if (this.sortField === field) {
            // Toggle order if same field clicked again
            this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortField = field;
            this.sortOrder = field === 'name' ? 'asc' : 'desc';
        }
        this.refresh();
    }

    getSortField(): ProjectSortField {
        return this.sortField;
    }

    getSortOrder(): SortOrder {
        return this.sortOrder;
    }

    toggleSortOrder(): void {
        this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
        this.refresh();
    }

    getTreeItem(element: SidebarItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SidebarItem): Promise<SidebarItem[]> {
        if (element) { return []; }

        const serverUrl = this.credentialManager.getDefaultServer();
        const credential = await this.credentialManager.getCredential(serverUrl);
        if (!credential) { return []; } // viewsWelcome handles this

        const api = new BaseAPI(credential.serverUrl);
        api.setIdentity(credential.identity);

        const result = await api.getProjects();
        if (result.type !== 'success' || !result.projects) {
            return [new SidebarItem('Failed to load projects', {
                icon: 'warning',
                description: result.message || 'Unknown error',
            })];
        }

        let active = result.projects.filter(p => !p.archived && !p.trashed);

        // Apply filter
        if (this.filterText) {
            const lower = this.filterText.toLowerCase();
            active = active.filter(p => p.name.toLowerCase().includes(lower));
        }

        if (active.length === 0) {
            const msg = this.filterText
                ? `No projects matching "${this.filterText}"`
                : 'No projects found';
            return [new SidebarItem(msg, { icon: 'info' })];
        }

        // Apply sort
        active.sort((a, b) => {
            let cmp = 0;
            switch (this.sortField) {
                case 'name':
                    cmp = a.name.localeCompare(b.name);
                    break;
                case 'lastUpdated': {
                    const ta = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
                    const tb = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
                    cmp = ta - tb;
                    break;
                }
                case 'accessLevel': {
                    const order: Record<string, number> = { owner: 3, collaborator: 2, readOnly: 1 };
                    cmp = (order[a.accessLevel] || 0) - (order[b.accessLevel] || 0);
                    break;
                }
            }
            return this.sortOrder === 'asc' ? cmp : -cmp;
        });

        return active.map(p => {
            const date = p.lastUpdated ? new Date(p.lastUpdated).toLocaleDateString() : '';
            return new SidebarItem(p.name, {
                icon: accessIcon(p.accessLevel),
                description: date,
                tooltip: `${p.name}\nAccess: ${p.accessLevel}${date ? `\nUpdated: ${date}` : ''}`,
                command: { command: COMMANDS.OPEN_PROJECT, title: 'Open Project', arguments: [p] },
            });
        });
    }
}

// ── Changes Provider (linked state — grouped tree) ──────────────────

const MAX_RECENT_CHANGES = 50;

/** Group node IDs for the tree */
type GroupId = 'conflicts' | 'incoming' | 'outgoing' | 'activity' | 'realtime-status';

export class ChangesProvider implements vscode.TreeDataProvider<SidebarItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private recentChanges: FileChange[] = [];
    private syncStatus: SyncStatus = 'disconnected';
    private changeTracker?: ChangeTracker;
    private syncMode: SyncMode = 'manual';
    private trackerDisposable?: vscode.Disposable;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /** Set the change tracker reference and subscribe to its events */
    setChangeTracker(tracker: ChangeTracker): void {
        if (this.trackerDisposable) {
            this.trackerDisposable.dispose();
        }
        this.changeTracker = tracker;
        this.trackerDisposable = tracker.onDidChange(() => this.refresh());
    }

    setSyncMode(mode: SyncMode): void {
        this.syncMode = mode;
        this.refresh();
    }

    /** Record a file that was just pushed or pulled (for activity log). */
    addFileChange(path: string, direction: ChangeDirection): void {
        const existing = this.recentChanges.findIndex(
            c => c.path === path && c.direction === direction,
        );
        if (existing !== -1) {
            this.recentChanges.splice(existing, 1);
        }
        this.recentChanges.unshift({ path, direction, timestamp: Date.now() });
        if (this.recentChanges.length > MAX_RECENT_CHANGES) {
            this.recentChanges.length = MAX_RECENT_CHANGES;
        }
        this.refresh();
    }

    clearChanges(): void {
        this.recentChanges = [];
        this.changeTracker?.clearAll();
        this.refresh();
    }

    setSyncStatus(status: SyncStatus): void {
        this.syncStatus = status;
    }

    getTreeItem(element: SidebarItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SidebarItem): Promise<SidebarItem[]> {
        // Root level: return group nodes
        if (!element) {
            return this.getRootNodes();
        }

        // Child level: return items for the group
        const groupId = element.groupId as GroupId;
        if (!groupId) return [];

        switch (groupId) {
            case 'conflicts':
                return this.getConflictItems();
            case 'incoming':
                return this.getIncomingItems();
            case 'outgoing':
                return this.getOutgoingItems();
            case 'activity':
                return this.getActivityItems();
            default:
                return [];
        }
    }

    private getRootNodes(): SidebarItem[] {
        const nodes: SidebarItem[] = [];

        if (this.syncMode === 'realtime') {
            // Realtime mode: show status + activity
            nodes.push(new SidebarItem('Real-time sync active', {
                icon: 'zap',
                description: '',
                collapsibleState: vscode.TreeItemCollapsibleState.None,
            }));

            if (this.recentChanges.length > 0) {
                const activityNode = new SidebarItem(`Recent Activity (${this.recentChanges.length})`, {
                    icon: 'history',
                    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
                });
                activityNode.groupId = 'activity';
                nodes.push(activityNode);
            }

            return nodes;
        }

        // Manual mode: show conflicts, incoming, outgoing, activity
        if (this.changeTracker) {
            const conflictCount = this.changeTracker.getConflictCount();
            const remoteCount = this.changeTracker.getRemoteChangeCount() - conflictCount;
            const localCount = this.changeTracker.getLocalChangeCount() - conflictCount;

            if (conflictCount > 0) {
                const conflictNode = new SidebarItem(`Conflicts (${conflictCount})`, {
                    icon: 'warning',
                    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
                });
                conflictNode.groupId = 'conflicts';
                nodes.push(conflictNode);
            }

            if (remoteCount > 0) {
                const incomingNode = new SidebarItem(`Incoming Changes (${remoteCount})`, {
                    icon: 'cloud-download',
                    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
                });
                incomingNode.groupId = 'incoming';
                nodes.push(incomingNode);
            }

            if (localCount > 0) {
                const outgoingNode = new SidebarItem(`Outgoing Changes (${localCount})`, {
                    icon: 'cloud-upload',
                    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
                });
                outgoingNode.groupId = 'outgoing';
                nodes.push(outgoingNode);
            }
        }

        if (this.recentChanges.length > 0) {
            const hasChanges = nodes.length > 0;
            const activityNode = new SidebarItem(`Recent Activity (${this.recentChanges.length})`, {
                icon: 'history',
                collapsibleState: hasChanges
                    ? vscode.TreeItemCollapsibleState.Collapsed
                    : vscode.TreeItemCollapsibleState.Expanded,
            });
            activityNode.groupId = 'activity';
            nodes.push(activityNode);
        }

        return nodes;
    }

    private getConflictItems(): SidebarItem[] {
        if (!this.changeTracker) return [];

        const conflicts = this.changeTracker.getConflicts();
        return conflicts.map(c => {
            const item = new SidebarItem(displayPath(c.path), {
                icon: 'warning',
                description: 'modified both',
                tooltip: `${c.path}\nModified locally and remotely`,
                contextValue: 'conflict',
                command: {
                    command: COMMANDS.VIEW_DIFF,
                    title: 'View Diff',
                    arguments: [c.path],
                },
            });
            return item;
        });
    }

    private getIncomingItems(): SidebarItem[] {
        if (!this.changeTracker) return [];

        const remote = this.changeTracker.getRemoteChanges();
        // Exclude conflicts (those are shown in the conflicts group)
        return remote
            .filter(c => !this.changeTracker!.hasLocalChange(c.path))
            .map(c => {
                const icon = changeTypeIcon(c.type);
                return new SidebarItem(displayPath(c.path), {
                    icon,
                    description: c.type,
                    tooltip: `${c.path}\nRemote: ${c.type}`,
                    contextValue: 'incoming-change',
                    command: {
                        command: 'vscode.open',
                        title: 'Open File',
                        arguments: [fileUri(c.path)],
                    },
                });
            });
    }

    private getOutgoingItems(): SidebarItem[] {
        if (!this.changeTracker) return [];

        const local = this.changeTracker.getLocalChanges();
        // Exclude conflicts
        return local
            .filter(c => !this.changeTracker!.hasRemoteChange(c.path))
            .map(c => {
                const icon = changeTypeIcon(c.type);
                return new SidebarItem(displayPath(c.path), {
                    icon,
                    description: c.type,
                    tooltip: `${c.path}\nLocal: ${c.type}`,
                    contextValue: 'outgoing-change',
                    command: {
                        command: 'vscode.open',
                        title: 'Open File',
                        arguments: [fileUri(c.path)],
                    },
                });
            });
    }

    private getActivityItems(): SidebarItem[] {
        return this.recentChanges.map(c => {
            const isPush = c.direction === 'push';
            const icon = isPush ? 'cloud-upload' : 'cloud-download';
            const dirLabel = isPush ? 'pushed' : 'pulled';
            const ago = formatTimeAgo(c.timestamp);

            return new SidebarItem(displayPath(c.path), {
                icon,
                description: ago,
                tooltip: `${c.path}\n${dirLabel} ${ago}`,
                command: {
                    command: 'vscode.open',
                    title: 'Open File',
                    arguments: [fileUri(c.path)],
                },
            });
        });
    }
}

// ── Details Provider (linked state — collapsed bottom) ─────────────

export class DetailsProvider implements vscode.TreeDataProvider<SidebarItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private credentialManager: CredentialManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SidebarItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SidebarItem): Promise<SidebarItem[]> {
        if (element) { return []; }

        const settingsManager = SettingsManager.getCurrentInstance();
        const settings = settingsManager?.getSettings();
        if (!settings) { return []; }

        const serverUrl = this.credentialManager.getDefaultServer();
        const credential = await this.credentialManager.getCredential(serverUrl);

        const items: SidebarItem[] = [];

        items.push(new SidebarItem(settings.serverUrl, {
            icon: 'globe',
            description: 'Server',
        }));

        if (credential) {
            items.push(new SidebarItem(credential.userEmail, {
                icon: 'account',
                description: 'Account',
            }));
        }

        if (settings.mainTex) {
            items.push(new SidebarItem(settings.mainTex, {
                icon: 'file',
                description: 'Main document',
            }));
        }

        items.push(new SidebarItem(settings.projectId, {
            icon: 'key',
            description: 'Project ID',
        }));

        // Sync mode
        const syncModeLabel = settings.syncMode === 'realtime' ? 'Real-time' : 'Manual';
        items.push(new SidebarItem(syncModeLabel, {
            icon: settings.syncMode === 'realtime' ? 'zap' : 'git-pull-request',
            description: 'Sync mode',
        }));

        // Compiler info
        if (settings.compiler) {
            items.push(new SidebarItem(settings.compiler, {
                icon: 'gear',
                description: 'Compiler',
            }));
        }

        // Auto-compile status
        if (settings.compileOnSave !== undefined) {
            items.push(new SidebarItem(settings.compileOnSave ? 'Enabled' : 'Disabled', {
                icon: settings.compileOnSave ? 'check' : 'circle-slash',
                description: 'Auto-compile',
            }));
        }

        return items;
    }
}

// ── Helpers ────────────────────────────────────────────────────────

/** Build a sync-status description string for the view title. */
export function syncStatusDescription(status: SyncStatus, lastSynced?: string): string {
    const icon: Record<SyncStatus, string> = {
        idle: '$(check)',
        syncing: '$(sync~spin)',
        pulling: '$(cloud-download)',
        pushing: '$(cloud-upload)',
        error: '$(warning)',
        disconnected: '$(cloud-offline)',
    };
    const label: Record<SyncStatus, string> = {
        idle: 'Up to date',
        syncing: 'Syncing…',
        pulling: 'Pulling…',
        pushing: 'Pushing…',
        error: 'Error',
        disconnected: 'Disconnected',
    };
    let text = `${icon[status]} ${label[status]}`;
    if (status === 'idle' && lastSynced) {
        text += ` — ${formatTimeAgo(new Date(lastSynced).getTime())}`;
    }
    return text;
}

function accessIcon(level: ProjectInfo['accessLevel']): string {
    switch (level) {
        case 'owner': return 'person';
        case 'collaborator': return 'organization';
        case 'readOnly': return 'eye';
        default: return 'file';
    }
}

function changeTypeIcon(type: string): string {
    switch (type) {
        case 'modified': return 'diff-modified';
        case 'created': return 'diff-added';
        case 'deleted': return 'diff-removed';
        case 'renamed': return 'diff-renamed';
        case 'moved': return 'diff-renamed';
        default: return 'file';
    }
}

function formatTimeAgo(ts: number): string {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 5) { return 'just now'; }
    if (sec < 60) { return `${sec}s ago`; }
    const min = Math.floor(sec / 60);
    if (min < 60) { return `${min}m ago`; }
    const hr = Math.floor(min / 60);
    if (hr < 24) { return `${hr}h ago`; }
    return new Date(ts).toLocaleDateString();
}

/** Display the filename only (last segment of path) */
function displayPath(relativePath: string): string {
    const clean = relativePath.replace(/^\/+/, '').replace(/\/+$/, '');
    return clean.split('/').pop() || clean;
}

function fileUri(relativePath: string): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) { return undefined; }
    const clean = relativePath.replace(/^\/+/, '');
    return vscode.Uri.joinPath(folder, clean);
}

// ── SidebarItem ────────────────────────────────────────────────────

interface SidebarItemOptions {
    icon?: string;
    description?: string;
    tooltip?: string;
    command?: vscode.Command;
    contextValue?: string;
    collapsibleState?: vscode.TreeItemCollapsibleState;
}

class SidebarItem extends vscode.TreeItem {
    groupId?: string;

    constructor(label: string, options: SidebarItemOptions = {}) {
        super(label, options.collapsibleState ?? vscode.TreeItemCollapsibleState.None);
        if (options.icon) {
            this.iconPath = new vscode.ThemeIcon(options.icon);
        }
        if (options.description !== undefined) {
            this.description = options.description;
        }
        if (options.tooltip) {
            this.tooltip = options.tooltip;
        }
        if (options.command) {
            this.command = options.command;
        }
        if (options.contextValue) {
            this.contextValue = options.contextValue;
        }
    }
}
