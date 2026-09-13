/**
 * LocalLeaf Cursor Tracker
 * Tracks and displays collaborator cursors in real-time
 */

import * as vscode from 'vscode';
import { SocketIOAPI, OnlineUser, UserCursorUpdate } from '../api/socketio';
import { SettingsManager } from '../utils/settingsManager';
import { assertSafeWorkspacePath } from '../utils/pathSafety';

/**
 * User cursor colors - matches Overleaf's color palette
 */
const CURSOR_COLORS = [
    '#ff8000', // orange
    '#8000ff', // purple
    '#ff00ff', // pink
    '#804000', // brown
    '#808080', // gray
    '#0080ff', // light blue
    '#00ff80', // light green
    '#ff80ff', // light purple
    '#ff80c0', // light pink
    '#ffff80', // light yellow
    '#ffc080', // light orange
    '#ff8080', // light red
    '#c0c0c0', // light gray
    '#c08040', // light brown
    '#000080', // dark blue
    '#008040', // dark green
];

/**
 * Generate a consistent hash from a string
 */
function hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
}

/**
 * Get a consistent color for a user based on their user ID
 */
function getColorForUserId(userId: string): string {
    const hash = hashString(userId);
    return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

/**
 * Extended user with decoration info
 */
export interface TrackedUser {
    clientId: string;
    userId: string;
    name: string;
    email: string;
    docId: string;
    docPath?: string;
    row: number;
    column: number;
    lastUpdated: number;
    color: string;
    decoration: vscode.TextEditorDecorationType;
    hoverMessage: vscode.MarkdownString;
}

/**
 * Cursor Tracker - manages collaborator cursor display
 */
export class CursorTracker {
    private users: Map<string, TrackedUser> = new Map();
    private userIdToColor: Map<string, string> = new Map(); // Consistent colors per user ID
    private disposables: vscode.Disposable[] = [];
    private _publicId?: string;
    private pendingLocalPosition?: { docId: string; row: number; column: number };
    private publishingLocalPosition = false;
    private initialized = false;
    private disposed = false;

    constructor(
        private readonly socket: SocketIOAPI,
        private readonly settings: SettingsManager,
        private readonly fileTree: ReadonlyMap<string, { type: string; path: string }>,
    ) {
        this._publicId = socket.publicId;
        this.registerHandlers();
    }

    private getDocumentPath(docId: string): string | undefined {
        const entry = this.fileTree.get(docId);
        return entry?.type === 'doc' ? entry.path : undefined;
    }

    /**
     * Register socket event handlers
     */
    private registerHandlers(): void {
        this.socket.registerHandlers({
            onConnected: (publicId) => {
                if (this.disposed) return;
                this._publicId = publicId;
                // Presence identifiers belong to one socket session. Users
                // who left while offline will not send us a disconnect event.
                for (const user of this.users.values()) user.decoration.dispose();
                this.users.clear();
                this.userIdToColor.clear();
                void this.loadConnectedUsers().catch(error => {
                    if (!this.disposed) console.error('[LocalLeaf] Failed to refresh collaborators:', error);
                });
            },
            onUserCursorUpdated: (update) => this.handleCursorUpdate(update),
            onUserDisconnected: (clientId) => this.handleUserDisconnected(clientId),
        });
    }

    /**
     * Initialize with connected users
     */
    async initialize(): Promise<void> {
        if (this.disposed || this.initialized) return;
        try {
            await this.loadConnectedUsers();
        } catch (error) {
            if (!this.disposed) {
                console.error('[LocalLeaf] Failed to get connected users:', error);
            }
        }

        if (this.disposed || this.initialized) return;

        // Listen for selection changes to update our position
        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection(e => {
                void this.handleLocalSelectionChange(e).catch(error => {
                    console.error('[LocalLeaf] Failed to publish cursor position:', error);
                });
            }),
            vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations())
        );
        this.initialized = true;
    }

    private async loadConnectedUsers(): Promise<void> {
        const publicId = this._publicId;
        const users = await this.socket.getConnectedUsers();
        if (this.disposed || this._publicId !== publicId) return;
        for (const user of users) {
            if (user.clientId !== publicId) this.addOrUpdateUser(user);
        }
    }

    /**
     * Handle cursor update from another user
     */
    private handleCursorUpdate(update: UserCursorUpdate): void {
        if (this.disposed || update.id === this._publicId) return;

        const user: OnlineUser = {
            clientId: update.id,
            userId: update.user_id,
            name: update.name,
            email: update.email,
            docId: update.doc_id,
            row: update.row,
            column: update.column,
            lastUpdated: Date.now(),
        };

        this.addOrUpdateUser(user);
    }

    /**
     * Add or update a user's cursor
     */
    private addOrUpdateUser(user: OnlineUser): void {
        if (this.disposed) return;
        if (
            typeof user.clientId !== 'string'
            || user.clientId.length === 0
            || user.clientId.length > 1024
            || typeof user.userId !== 'string'
            || user.userId.length > 1024
            || typeof user.name !== 'string'
            || user.name.length > 4096
            || typeof user.email !== 'string'
            || user.email.length > 4096
            || typeof user.docId !== 'string'
            || user.docId.length > 1024
        ) {
            return;
        }
        const existing = this.users.get(user.clientId);
        if (!existing && this.users.size >= 1000) return;
        const row = Number.isSafeInteger(user.row) && user.row >= 0 ? user.row : 0;
        const column = Number.isSafeInteger(user.column) && user.column >= 0 ? user.column : 0;
        const lastUpdated = Number.isFinite(user.lastUpdated) ? user.lastUpdated : Date.now();

        if (existing) {
            // Update existing user
            const oldDocPath = existing.docPath;
            existing.docId = user.docId;
            existing.docPath = this.getDocumentPath(user.docId);
            existing.row = row;
            existing.column = column;
            existing.lastUpdated = lastUpdated;

            // Clear decoration from old document if changed
            if (oldDocPath && oldDocPath !== existing.docPath) {
                this.clearDecoration(existing, oldDocPath);
            }

            // Update decoration in new document
            this.updateDecoration(existing);
        } else {
            // Create new tracked user
            // Use consistent color based on user ID (same user = same color across sessions)
            let color = this.userIdToColor.get(user.userId);
            if (!color) {
                color = getColorForUserId(user.userId);
                this.userIdToColor.set(user.userId, color);
            }

            const decoration = vscode.window.createTextEditorDecorationType({
                outline: `2px solid ${color}`,
                overviewRulerColor: color,
                overviewRulerLane: vscode.OverviewRulerLane.Center,
                rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            });

            const hoverMessage = new vscode.MarkdownString();
            hoverMessage.appendMarkdown(`<span style="color:${color};"><b>`);
            hoverMessage.appendText(user.name);
            hoverMessage.appendMarkdown('</b></span>');
            hoverMessage.supportHtml = true;

            const tracked: TrackedUser = {
                clientId: user.clientId,
                userId: user.userId,
                name: user.name,
                email: user.email,
                docId: user.docId,
                docPath: this.getDocumentPath(user.docId),
                row,
                column,
                lastUpdated,
                color,
                decoration,
                hoverMessage,
            };

            this.users.set(user.clientId, tracked);
            this.updateDecoration(tracked);
        }
    }

    /**
     * Update decoration for a user
     */
    private updateDecoration(user: TrackedUser): void {
        const currentPath = this.getDocumentPath(user.docId);
        if (user.docPath && user.docPath !== currentPath) this.clearDecoration(user, user.docPath);
        user.docPath = currentPath;
        if (!user.docPath) return;

        let uri: vscode.Uri;
        try {
            uri = this.settings.getFilePath(user.docPath);
        } catch {
            return;
        }

        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === uri.toString()
        );

        if (editor) {
            if (!Number.isSafeInteger(user.row) || !Number.isSafeInteger(user.column) || user.row < 0 || user.column < 0) {
                return;
            }
            if (user.row >= editor.document.lineCount) {
                editor.setDecorations(user.decoration, []);
                return;
            }
            const lineLength = editor.document.lineAt(user.row).text.length;
            const column = Math.min(user.column, lineLength);
            const endColumn = Math.min(column + 1, lineLength);
            const range = new vscode.Range(user.row, column, user.row, endColumn);
            editor.setDecorations(user.decoration, [{
                range,
                hoverMessage: user.hoverMessage,
            }]);
        }
    }

    /**
     * Clear decoration for a user from a specific document
     */
    private clearDecoration(user: TrackedUser, docPath: string): void {
        let uri: vscode.Uri;
        try {
            uri = this.settings.getFilePath(docPath);
        } catch {
            return;
        }

        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === uri.toString()
        );

        if (editor) {
            editor.setDecorations(user.decoration, []);
        }
    }

    /**
     * Refresh all decorations
     */
    private refreshDecorations(): void {
        for (const user of this.users.values()) {
            this.updateDecoration(user);
        }
    }

    /**
     * Handle user disconnection
     */
    private handleUserDisconnected(clientId: string): void {
        if (this.disposed) return;
        const user = this.users.get(clientId);
        if (user) {
            // Clear decoration
            if (user.docPath) {
                this.clearDecoration(user, user.docPath);
            }
            user.decoration.dispose();
            this.users.delete(clientId);
            if (![...this.users.values()].some(candidate => candidate.userId === user.userId)) {
                this.userIdToColor.delete(user.userId);
            }
        }
    }

    /**
     * Keep at most one cursor ACK in flight and one latest queued position.
     * Selection events can arrive much faster than a remote server responds;
     * publishing every intermediate point would retain unbounded callbacks.
     */
    private async queueLocalPosition(docId: string, row: number, column: number): Promise<void> {
        if (this.disposed) return;
        this.pendingLocalPosition = { docId, row, column };
        if (this.publishingLocalPosition) return;

        this.publishingLocalPosition = true;
        try {
            while (!this.disposed && this.pendingLocalPosition) {
                const position = this.pendingLocalPosition;
                this.pendingLocalPosition = undefined;
                try {
                    await this.socket.updatePosition(
                        position.docId,
                        position.row,
                        position.column,
                    );
                } catch (error) {
                    this.pendingLocalPosition = undefined;
                    throw error;
                }
            }
        } finally {
            this.publishingLocalPosition = false;
        }
    }

    /**
     * Handle local selection change to update our position
     */
    private async handleLocalSelectionChange(event: vscode.TextEditorSelectionChangeEvent): Promise<void> {
        // Don't filter by event.kind - we want to track all cursor movements

        const uri = event.textEditor.document.uri;
        if (uri.scheme !== 'file') return;

        const relativePath = this.settings.getRelativePath(uri);
        if (!relativePath || relativePath === '/') return;

        // Find doc ID for this path
        let docId: string | undefined;
        for (const [id, entry] of this.fileTree) {
            if (entry.type === 'doc' && entry.path === relativePath) {
                docId = id;
                break;
            }
        }

        if (docId) {
            const selection = event.selections[0];
            if (!selection) return;
            try {
                await this.queueLocalPosition(
                    docId,
                    selection.active.line,
                    selection.active.character,
                );
            } catch {
                // Ignore errors (e.g., if disconnected)
            }
        }
    }

    /**
     * Get online users
     */
    getOnlineUsers(): TrackedUser[] {
        for (const user of this.users.values()) {
            if (user.docPath !== this.getDocumentPath(user.docId)) this.updateDecoration(user);
        }
        return Array.from(this.users.values());
    }

    /**
     * Get user count
     */
    getUserCount(): number {
        return this.users.size;
    }

    /**
     * Jump to a user's cursor position
     */
    async jumpToUser(clientId?: string): Promise<void> {
        if (this.disposed) return;
        this.refreshDecorations();
        let user: TrackedUser | undefined;

        if (clientId) {
            user = this.users.get(clientId);
        } else if (this.users.size > 0) {
            // Show picker
            const items = Array.from(this.users.values()).map(u => ({
                label: u.name,
                description: u.docPath ? `${u.docPath}:${u.row + 1}` : 'Unknown location',
                user: u,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a collaborator to jump to',
            });

            if (selected) {
                user = selected.user;
            }
        } else {
            void vscode.window.showInformationMessage('No collaborators online');
            return;
        }

        if (this.disposed) return;
        if (user) user.docPath = this.getDocumentPath(user.docId);
        if (user && user.docPath) {
            try {
                const uri = this.settings.getFilePath(user.docPath);
                await assertSafeWorkspacePath(this.settings.getWorkspaceFolder(), uri);
                const row = Number.isSafeInteger(user.row) && user.row >= 0 ? user.row : 0;
                const column = Number.isSafeInteger(user.column) && user.column >= 0 ? user.column : 0;
                await vscode.window.showTextDocument(uri, {
                    selection: new vscode.Selection(row, column, row, column),
                    preview: false,
                });
            } catch {
                // File might not exist locally yet, offer to pull
                const choice = await vscode.window.showWarningMessage(
                    `Cannot open ${user.docPath}. The file may not exist locally. Try pulling from Overleaf.`,
                    'Pull Now'
                );
                if (choice === 'Pull Now') {
                    await vscode.commands.executeCommand('localleaf.pullFromOverleaf');
                }
            }
        } else if (user) {
            void vscode.window.showInformationMessage(`${user.name} is not currently editing a document`);
        }
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.pendingLocalPosition = undefined;
        for (const user of this.users.values()) {
            user.decoration.dispose();
        }
        this.users.clear();
        this.userIdToColor.clear();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}
