/**
 * LocalLeaf Sidebar Providers
 *
 * Three TreeDataProviders for the sidebar:
 * - ProjectsProvider: project list when not linked (+ viewsWelcome when not logged in)
 * - ChangesProvider: recently synced files when linked
 * - DetailsProvider: server/account info when linked (collapsed)
 */

import * as vscode from 'vscode';
import { BaseAPI, ProjectInfo } from '../api/base';
import { CredentialManager, ServerCredential } from '../utils/credentialManager';
import { SettingsManager } from '../utils/settingsManager';
import { COMMANDS } from '../consts';
import { SyncStatus } from '../sync/syncEngine';

// ── Changed file tracking ──────────────────────────────────────────

export type ChangeDirection = 'push' | 'pull';

export interface FileChange {
    path: string;
    direction: ChangeDirection;
    timestamp: number;
}

// ── Projects Provider (not-linked state) ───────────────────────────

export class ProjectsProvider implements vscode.TreeDataProvider<SidebarItem> {
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

        const active = result.projects.filter(p => !p.archived && !p.trashed);
        if (active.length === 0) {
            return [new SidebarItem('No projects found', { icon: 'info' })];
        }

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

// ── Changes Provider (linked state — main area) ───────────────────

const MAX_RECENT_CHANGES = 50;

export class ChangesProvider implements vscode.TreeDataProvider<SidebarItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private changes: FileChange[] = [];
    private syncStatus: SyncStatus = 'disconnected';

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /** Record a file that was just pushed or pulled. */
    addFileChange(path: string, direction: ChangeDirection): void {
        // Deduplicate: if same path+direction already at top, just bump timestamp
        const existing = this.changes.findIndex(
            c => c.path === path && c.direction === direction,
        );
        if (existing !== -1) {
            this.changes.splice(existing, 1);
        }
        this.changes.unshift({ path, direction, timestamp: Date.now() });
        if (this.changes.length > MAX_RECENT_CHANGES) {
            this.changes.length = MAX_RECENT_CHANGES;
        }
        this.refresh();
    }

    clearChanges(): void {
        this.changes = [];
        this.refresh();
    }

    setSyncStatus(status: SyncStatus): void {
        this.syncStatus = status;
        // Don't refresh here — avoids constant redraws during rapid status flips
    }

    getTreeItem(element: SidebarItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SidebarItem): Promise<SidebarItem[]> {
        if (element) { return []; }
        if (this.changes.length === 0) { return []; } // viewsWelcome handles empty

        return this.changes.map(c => {
            const isPush = c.direction === 'push';
            const icon = isPush ? 'cloud-upload' : 'cloud-download';
            const dirLabel = isPush ? 'pushed' : 'pulled';
            const ago = formatTimeAgo(c.timestamp);

            return new SidebarItem(c.path, {
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

function fileUri(relativePath: string): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) { return undefined; }
    // relativePath may start with /
    const clean = relativePath.replace(/^\/+/, '');
    return vscode.Uri.joinPath(folder, clean);
}

// ── SidebarItem ────────────────────────────────────────────────────

interface SidebarItemOptions {
    icon?: string;
    description?: string;
    tooltip?: string;
    command?: vscode.Command;
}

class SidebarItem extends vscode.TreeItem {
    constructor(label: string, options: SidebarItemOptions = {}) {
        super(label, vscode.TreeItemCollapsibleState.None);
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
    }
}
