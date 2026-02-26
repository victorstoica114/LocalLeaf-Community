/**
 * ProjectsWebviewProvider – replaces the old TreeDataProvider-based ProjectsProvider.
 *
 * State machine:
 *   no-folder          → "Please open a folder to use LocalLeaf"
 *   non-empty-folder   → "Please open an empty folder or an existing LocalLeaf project"
 *   not-logged-in      → Login button
 *   project-list       → Searchable, sortable project list
 */

import * as vscode from 'vscode';
import { BaseAPI, ProjectInfo } from '../api/base';
import { CredentialManager } from '../utils/credentialManager';
import { CONFIG_DIR, COMMANDS } from '../consts';

export type ProjectSortField = 'name' | 'lastUpdated' | 'accessLevel';
export type SortOrder = 'asc' | 'desc';

type ViewState = 'no-folder' | 'non-empty-folder' | 'not-logged-in' | 'project-list';

export class ProjectsWebviewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'localleaf.projectsView';

    private _view?: vscode.WebviewView;
    private sortField: ProjectSortField = 'lastUpdated';
    private sortOrder: SortOrder = 'desc';
    private filterText = '';
    private cachedProjects: ProjectInfo[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly credentialManager: CredentialManager,
    ) {}

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

        webviewView.webview.onDidReceiveMessage(msg => this.handleMessage(msg));

        this.updateView();
    }

    // ── Public API (called by extension commands) ──────────────────

    async refresh(): Promise<void> {
        this.cachedProjects = [];
        await this.updateView();
    }

    setFilter(text: string): void {
        this.filterText = text;
        this.updateView();
    }

    getFilter(): string {
        return this.filterText;
    }

    setSortField(field: ProjectSortField): void {
        if (this.sortField === field) {
            this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortField = field;
            this.sortOrder = field === 'name' ? 'asc' : 'desc';
        }
        this.updateView();
    }

    // ── State detection ────────────────────────────────────────────

    private async determineViewState(): Promise<ViewState> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return 'no-folder';
        }

        const rootUri = folders[0].uri;

        // Check for .localleaf directory
        const configUri = vscode.Uri.joinPath(rootUri, CONFIG_DIR);
        let hasConfig = false;
        try {
            await vscode.workspace.fs.stat(configUri);
            hasConfig = true;
        } catch {
            // does not exist
        }

        if (!hasConfig) {
            // Check if folder is empty
            let entries: [string, vscode.FileType][] = [];
            try {
                entries = await vscode.workspace.fs.readDirectory(rootUri);
            } catch {
                // can't read – treat as non-empty
            }
            if (entries.length > 0) {
                return 'non-empty-folder';
            }
        }

        // Folder is empty or has .localleaf → check login
        const serverUrl = this.credentialManager.getDefaultServer();
        const credential = await this.credentialManager.getCredential(serverUrl);
        if (!credential) {
            return 'not-logged-in';
        }

        return 'project-list';
    }

    // ── View update ────────────────────────────────────────────────

    private async updateView(): Promise<void> {
        if (!this._view) { return; }

        const state = await this.determineViewState();

        if (state === 'project-list') {
            if (this.cachedProjects.length === 0) {
                // Fetch projects
                const serverUrl = this.credentialManager.getDefaultServer();
                const credential = await this.credentialManager.getCredential(serverUrl);
                if (credential) {
                    const api = new BaseAPI(credential.serverUrl);
                    api.setIdentity(credential.identity);
                    const result = await api.getProjects();
                    if (result.type === 'success' && result.projects) {
                        this.cachedProjects = result.projects.filter(p => !p.archived && !p.trashed);
                    }
                }
            }
        }

        this._view.webview.html = this.getHtml(state, this.cachedProjects);
    }

    // ── Message handling ───────────────────────────────────────────

    private handleMessage(msg: any): void {
        switch (msg.type) {
            case 'filterChanged':
                this.filterText = msg.text ?? '';
                // Re-render with new filter (no network fetch – use cache)
                if (this._view) {
                    this._view.webview.html = this.getHtml('project-list', this.cachedProjects);
                }
                break;

            case 'sortChanged':
                this.setSortField(msg.field);
                break;

            case 'openProject': {
                const project = this.cachedProjects.find(p => p.id === msg.projectId);
                if (project) {
                    vscode.commands.executeCommand(COMMANDS.OPEN_PROJECT, project);
                }
                break;
            }

            case 'login':
                vscode.commands.executeCommand(COMMANDS.LOGIN);
                break;

            case 'refresh':
                this.refresh();
                break;

            case 'openFolder':
                vscode.commands.executeCommand('vscode.openFolder');
                break;
        }
    }

    // ── HTML generation ────────────────────────────────────────────

    private getHtml(state: ViewState, projects: ProjectInfo[]): string {
        switch (state) {
            case 'no-folder':
                return this.wrapHtml(/*html*/`
                    <div class="center-message">
                        <span class="codicon codicon-folder-opened icon-large"></span>
                        <p>Please open a folder to use LocalLeaf.</p>
                        <button class="primary-button" onclick="postMessage({type:'openFolder'})">Open Folder</button>
                    </div>
                `);

            case 'non-empty-folder':
                return this.wrapHtml(/*html*/`
                    <div class="center-message">
                        <span class="codicon codicon-warning icon-large"></span>
                        <p>The current folder is not empty and does not contain a LocalLeaf project.</p>
                        <p class="secondary">Please open an empty folder or an existing LocalLeaf project (with a <code>.localleaf</code> directory).</p>
                    </div>
                `);

            case 'not-logged-in':
                return this.wrapHtml(/*html*/`
                    <div class="center-message">
                        <span class="codicon codicon-account icon-large"></span>
                        <p>Login to Overleaf to see your projects.</p>
                        <button class="primary-button" onclick="postMessage({type:'login'})">Login to Overleaf</button>
                    </div>
                `);

            case 'project-list':
                return this.getProjectListHtml(projects);
        }
    }

    private getProjectListHtml(projects: ProjectInfo[]): string {
        // Apply filter
        let filtered = projects;
        if (this.filterText) {
            const lower = this.filterText.toLowerCase();
            filtered = projects.filter(p => p.name.toLowerCase().includes(lower));
        }

        // Apply sort
        filtered = [...filtered].sort((a, b) => {
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

        const listItems = filtered.length > 0
            ? filtered.map(p => {
                const date = p.lastUpdated ? new Date(p.lastUpdated).toLocaleDateString() : '';
                const icon = accessIcon(p.accessLevel);
                const escapedName = escapeHtml(p.name);
                return /*html*/`
                    <div class="project-item" onclick="postMessage({type:'openProject',projectId:'${p.id}'})">
                        <span class="codicon codicon-${icon} project-icon"></span>
                        <div class="project-info">
                            <span class="project-name">${escapedName}</span>
                            <span class="project-date">${date}</span>
                        </div>
                    </div>`;
            }).join('\n')
            : /*html*/`<div class="center-message"><p>${this.filterText ? `No projects matching "${escapeHtml(this.filterText)}"` : 'No projects found'}</p></div>`;

        const sortIndicator = (field: ProjectSortField) => {
            if (this.sortField !== field) { return ''; }
            return this.sortOrder === 'asc' ? ' ↑' : ' ↓';
        };

        return this.wrapHtml(/*html*/`
            <div class="search-container">
                <span class="codicon codicon-search search-icon"></span>
                <input type="text" id="search" placeholder="Search projects..." value="${escapeHtml(this.filterText)}" />
            </div>
            <div class="sort-bar">
                <button class="sort-btn${this.sortField === 'name' ? ' active' : ''}" data-field="name">Name${sortIndicator('name')}</button>
                <button class="sort-btn${this.sortField === 'lastUpdated' ? ' active' : ''}" data-field="lastUpdated">Date${sortIndicator('lastUpdated')}</button>
                <button class="sort-btn${this.sortField === 'accessLevel' ? ' active' : ''}" data-field="accessLevel">Access${sortIndicator('accessLevel')}</button>
            </div>
            <div id="project-list">
                ${listItems}
            </div>
        `);
    }

    private wrapHtml(body: string): string {
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
        /* Reset */
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: transparent;
            padding: 0;
            overflow-x: hidden;
        }

        /* Centered message screens */
        .center-message {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            padding: 24px 16px;
            gap: 8px;
        }
        .center-message p { line-height: 1.5; }
        .center-message .secondary {
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
        }
        .icon-large {
            font-size: 32px;
            margin-bottom: 8px;
            opacity: 0.7;
        }
        code {
            background: var(--vscode-textCodeBlock-background);
            padding: 1px 4px;
            border-radius: 3px;
            font-size: 0.9em;
        }

        /* Primary button */
        .primary-button {
            margin-top: 8px;
            padding: 6px 14px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-size: var(--vscode-font-size);
        }
        .primary-button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        /* Search bar */
        .search-container {
            position: relative;
            padding: 8px 8px 4px;
        }
        .search-icon {
            position: absolute;
            left: 16px;
            top: 50%;
            transform: translateY(-50%);
            opacity: 0.6;
            font-size: 14px;
            pointer-events: none;
        }
        #search {
            width: 100%;
            padding: 4px 8px 4px 26px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 2px;
            outline: none;
            font-size: var(--vscode-font-size);
            font-family: var(--vscode-font-family);
        }
        #search:focus {
            border-color: var(--vscode-focusBorder);
        }
        #search::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }

        /* Sort bar */
        .sort-bar {
            display: flex;
            gap: 2px;
            padding: 4px 8px;
            border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
        }
        .sort-btn {
            flex: 1;
            padding: 3px 6px;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-size: 11px;
            font-family: var(--vscode-font-family);
            text-align: center;
        }
        .sort-btn:hover {
            background: var(--vscode-list-hoverBackground);
            color: var(--vscode-foreground);
        }
        .sort-btn.active {
            color: var(--vscode-foreground);
            font-weight: 600;
        }

        /* Project list */
        #project-list {
            padding: 4px 0;
        }
        .project-item {
            display: flex;
            align-items: center;
            padding: 4px 12px;
            cursor: pointer;
            gap: 8px;
        }
        .project-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .project-icon {
            flex-shrink: 0;
            opacity: 0.8;
        }
        .project-info {
            display: flex;
            flex-direction: column;
            min-width: 0;
        }
        .project-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .project-date {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    ${body}
    <script>
        const vscode = acquireVsCodeApi();
        function postMessage(msg) { vscode.postMessage(msg); }

        // Search input with debounce
        const searchInput = document.getElementById('search');
        if (searchInput) {
            let debounceTimer;
            searchInput.addEventListener('input', () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    postMessage({ type: 'filterChanged', text: searchInput.value });
                }, 250);
            });
        }

        // Sort buttons
        document.querySelectorAll('.sort-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                postMessage({ type: 'sortChanged', field: btn.dataset.field });
            });
        });
    </script>
</body>
</html>`;
    }
}

// ── Helpers ────────────────────────────────────────────────────────

function accessIcon(level: ProjectInfo['accessLevel']): string {
    switch (level) {
        case 'owner': return 'person';
        case 'collaborator': return 'organization';
        case 'readOnly': return 'eye';
        default: return 'file';
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
