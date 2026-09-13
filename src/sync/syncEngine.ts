/**
 * LocalLeaf Sync Engine
 * Handles real-time bidirectional sync between local files and Overleaf
 */

import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { BaseAPI, ProjectEntity, FileEntity, FolderEntity } from '../api/base';
import { SocketIOAPI, DocumentUpdate } from '../api/socketio';
import { isAutomaticSyncEnabled, SettingsManager } from '../utils/settingsManager';
import { createIgnoreWatcher, IgnoreParser } from './ignoreParser';
import { DEBOUNCE_DELAY } from '../consts';
import { mergeText, textOperations } from './textMerge';
import { SyncStateStore } from './syncStateStore';
import {
    assertSafeWorkspacePath,
    isFileNotFoundError,
    joinProjectPath,
    normalizeProjectPath,
    validateProjectEntityName,
} from '../utils/pathSafety';
import {
    MAX_REMOTE_DOCUMENT_CHARACTERS,
    MAX_REMOTE_DOCUMENT_OPERATIONS,
    MAX_REMOTE_FILE_BYTES,
    validateOverleafId,
} from '../utils/remoteValidation';

const MAX_PENDING_REMOTE_EVENTS = 10_000;
const MAX_PENDING_REMOTE_EVENT_CHARACTERS = 20 * 1024 * 1024;
const DEFAULT_REMOTE_EVENT_COST = 4096;
const MAX_LOCAL_SCAN_ENTITIES = 100_000;
const MAX_LOCAL_SCAN_DEPTH = 256;
const MAX_RETAINED_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_REMOTE_DIFF_CHARACTERS = 20 * 1024 * 1024;
const MAX_SUPPRESSED_DOCUMENT_UPDATES = 10_000;
const MAX_SUPPRESSED_RENAME_ENTITIES = 10_000;
const MAX_SUPPRESSED_RENAMES_PER_ENTITY = 16;
const MAX_SUPPRESSED_DELETES = 10_000;
const SYNCHRONIZED_CONTENT_MARKER = new Uint8Array(0);
// Overleaf's default editable-document limit. Larger text belongs in the file
// upload path, where the server chooses its supported storage type.
const MAX_EDITABLE_DOCUMENT_CHARACTERS = 2 * 1024 * 1024;

/**
 * Sync status
 */
export type SyncStatus =
    | 'disconnected'
    | 'connecting'
    | 'idle'
    | 'syncing'
    | 'pulling'
    | 'pushing'
    | 'error';

/**
 * Sync status change event
 */
export interface SyncStatusEvent {
    status: SyncStatus;
    message?: string;
    file?: string;
    authError?: boolean;
}

export interface RemoteCleanupCandidate {
    path: string;
    id: string;
    type: 'file' | 'doc' | 'folder';
    reason: 'ignored' | 'missing-local';
}

/**
 * Hash function for content comparison
 */
function hashContent(content: Uint8Array | undefined): string {
    if (!content) return 'missing';
    return createHash('sha256').update(content).digest('hex');
}

/**
 * Compare two Uint8Arrays for equality
 */
function contentEquals(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Debug logging - only logs in debug mode
 */
const DEBUG = false;
function debugLog(...args: unknown[]): void {
    if (DEBUG) {
        console.log('[LocalLeaf]', ...args);
    }
}

/**
 * Check if an error indicates session expiration
 */
class SyncAuthenticationError extends Error {
    readonly name = 'SyncAuthenticationError';
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isAuthError(error: unknown): boolean {
    if (!error) return false;
    if (error instanceof SyncAuthenticationError) return true;
    const message = (error instanceof Error ? error.message : String(error)).trim().toLowerCase();
    return /^(?:session expired|invalid session|not logged in|not authenticated|authentication (?:failed|required)|login required|unauthorized)(?:\b|:)/.test(message)
        || /^(?:http\s+)?401(?:\b|:)/.test(message);
}

function ensureApiSuccess(
    result: { type: 'success' | 'error'; message?: string; authError?: unknown },
    action: string,
): void {
    if (!result || result.type !== 'success') {
        if (result?.authError) {
            throw new SyncAuthenticationError(`${action}: Session expired`);
        }
        throw new Error(`${action}: ${result?.message || 'unknown Overleaf API error'}`);
    }
}

/**
 * File entry in the project tree
 */
interface FileTreeEntry {
    id: string;
    type: 'doc' | 'file' | 'folder';
    name: string;
    path: string;
    parentId?: string;
}

interface DocumentSnapshot {
    content: Uint8Array;
    /** Version of this exact content; HTTP-only snapshots have no version. */
    version?: number;
}

/**
 * Sync Engine - manages real-time file synchronization
 */
export class SyncEngine {
    private socket?: SocketIOAPI;
    private project?: ProjectEntity;
    private fileTree: Map<string, FileTreeEntry> = new Map();
    private fileTreeByPath: Map<string, FileTreeEntry> = new Map();
    private readonly removedSnapshotEntries = new Map<string, FileTreeEntry>();
    private fileCache: Map<string, string> = new Map();
    private baseContent: Map<string, Uint8Array> = new Map();
    private baseHashes: Map<string, string> = new Map();
    private retainedDocumentBytes = 0;
    private readonly maxRetainedDocumentBytes = MAX_RETAINED_DOCUMENT_BYTES;
    private ignoreParser: IgnoreParser;
    private _status: SyncStatus = 'disconnected';
    private statusMessage?: string;
    private _onStatusChange = new vscode.EventEmitter<SyncStatusEvent>();
    private disposables: vscode.Disposable[] = [];
    private syncLock: Set<string> = new Set();
    private joinedDocs: Set<string> = new Set();
    private pendingLocalCreates: Set<string> = new Set();
    private documentSnapshots = new Map<string, DocumentSnapshot>();
    private retainedSnapshotBytes = 0;
    private suppressedRemoteDeletes: Set<string> = new Set();
    private suppressedRemoteRenames: Map<string, Set<string>> = new Map();
    private suppressedRemoteDocumentUpdates: Map<string, Set<string>> = new Map();
    private suppressedDocumentUpdateCount = 0;
    private readonly maxSuppressedDocumentUpdates = MAX_SUPPRESSED_DOCUMENT_UPDATES;
    private logFn?: (message: string) => void;
    private disposed = false;
    private readonly pendingWaits = new Map<NodeJS.Timeout, (active: boolean) => void>();
    private remoteEventQueue: Promise<void> = Promise.resolve();
    private pendingRemoteEventCount = 0;
    private pendingRemoteEventCost = 0;
    private activePull?: Promise<void>;
    private activeProjectRefresh?: Promise<void>;
    private automaticRecoveryScheduled = false;
    private recoveryRequired = false;
    private authenticationRequired = false;
    private lastFocusReconciliation = Date.now();
    private recoveryDelayMs = 5000;
    private conflictPromptActive = false;
    private readonly backgroundChoices = new Set<string>();
    private reviewedBackgroundChoices?: Map<string, string>;
    private readonly pendingConflicts = new Map<string, {
        entityId: string; localHash: string; remoteHash: string;
        choice?: 'useRemote' | 'useLocal' | 'skip';
    }>();
    private remoteEventGeneration = 0;
    private readonly remoteDiffContents = new Map<string, string>();
    private remoteDiffCharacters = 0;
    private readonly maxRemoteDiffCharacters = MAX_REMOTE_DIFF_CHARACTERS;
    private remoteDiffChangeEmitter?: vscode.EventEmitter<vscode.Uri>;
    private stateStore?: SyncStateStore;
    private readonly fileErrors = new Map<string, string>();
    private readonly localEventTimers = new Map<string, NodeJS.Timeout>();

    readonly onStatusChange = this._onStatusChange.event;

    constructor(
        private readonly api: BaseAPI,
        private readonly settings: SettingsManager,
        logFn?: (message: string) => void,
        storageRoot?: vscode.Uri,
    ) {
        const workspaceFolder = settings.getWorkspaceFolder();
        this.ignoreParser = new IgnoreParser(workspaceFolder, settings.getSettings());
        this.logFn = logFn;
        const project = settings.getSettings();
        if (storageRoot && project) {
            this.stateStore = new SyncStateStore(storageRoot.fsPath,
                JSON.stringify([project.serverUrl, project.projectId, workspaceFolder.toString()]),
                error => this.setStatus('error', `Cannot save synchronization state: ${error.message}`, '/.sync-state'));
        }
    }

    private log(message: string): void {
        this.logFn?.(message);
    }

    /**
     * Get current sync status
     */
    get status(): SyncStatus {
        return this._status;
    }

    /** Established sessions recover inside pullAll without losing their baselines. */
    get needsInitialization(): boolean {
        return this.disposed || !this.project;
    }

    /**
     * Automatic local uploads can be disabled either for this linked project
     * or through the VS Code setting. Read both values dynamically so changing
     * either setting does not require reconnecting the socket.
     */
    get automaticSyncEnabled(): boolean {
        return isAutomaticSyncEnabled(this.settings);
    }

    /**
     * Set status and emit event
     */
    private setStatus(status: SyncStatus, message?: string, file?: string, authError: boolean = false): void {
        if (this.disposed && status !== 'disconnected') return;
        if (authError) this.authenticationRequired = true;
        if (status === 'error' && file && !authError) {
            this.fileErrors?.set(file, message || 'Synchronization failed');
            this.log(`${file}: ${message}`);
        }
        if (status === 'idle' && this.authenticationRequired) return;
        if (status === 'idle' && this.socket?.isConnected === false) {
            status = 'connecting';
            message = 'Connection interrupted; reconnecting automatically...';
        } else if (status === 'idle' && (this.pendingConflicts?.size || this.backgroundChoices?.size)) {
            status = 'error';
            message = 'Some files need your choice in notifications; other files continue syncing';
        } else if (status === 'idle' && this.fileErrors?.size) {
            status = 'error';
            message = `${this.fileErrors.size} file(s) need attention: ${this.fileErrors.values().next().value}`;
        }
        this._status = status;
        this.statusMessage = message;
        this._onStatusChange.fire({ status, message, file, authError });
    }

    private throwIfDisposed(): void {
        if (this.disposed) {
            throw new Error('LocalLeaf sync session was closed.');
        }
    }

    private enqueueRemoteEvent(
        operation: (isCurrent: () => boolean) => Promise<void>,
        estimatedCost: number = DEFAULT_REMOTE_EVENT_COST,
    ): void {
        const generation = this.remoteEventGeneration;
        const isCurrent = () => !this.disposed && generation === this.remoteEventGeneration;
        const safeCost = Number.isSafeInteger(estimatedCost) && estimatedCost > 0
            ? estimatedCost
            : DEFAULT_REMOTE_EVENT_COST;
        if (
            this.pendingRemoteEventCount >= MAX_PENDING_REMOTE_EVENTS
            || this.pendingRemoteEventCost + safeCost > MAX_PENDING_REMOTE_EVENT_CHARACTERS
        ) {
            const message = 'Remote event queue limit exceeded; reconnect before continuing synchronization.';
            this.log(message);
            this.setStatus('error', message);
            this.socket?.resetConnection();
            this.scheduleAutomaticRecovery();
            return;
        }

        this.pendingRemoteEventCount++;
        this.pendingRemoteEventCost += safeCost;
        this.remoteEventQueue = this.remoteEventQueue
            .then(async () => {
                // A secondary snapshot must not overwrite primary events that
                // finish while it is being fetched. Resume the same queue on
                // both success and failure; the live transport did not change.
                await this.activeProjectRefresh?.catch(() => undefined);
                if (isCurrent()) await operation(isCurrent);
            })
            .catch(error => {
                if (!this.disposed) {
                    console.error('[LocalLeaf] Failed to process a remote synchronization event:', error);
                    const authErr = isAuthError(error);
                    this.setStatus(
                        'error',
                        authErr ? 'Session expired' : `Remote synchronization failed: ${error}`,
                        undefined,
                        authErr,
                    );
                }
            })
            .finally(() => {
                this.pendingRemoteEventCount--;
                this.pendingRemoteEventCost -= safeCost;
            });
    }

    private estimateDocumentUpdateCost(update: DocumentUpdate): number {
        let cost = update.doc.length + 128;
        for (const operation of update.op ?? []) {
            cost += 128 + (operation.i?.length ?? 0) + (operation.d?.length ?? 0);
        }
        return cost;
    }

    /**
     * Initialize and connect to Overleaf
     */
    async connect(): Promise<void> {
        this.throwIfDisposed();
        const projectSettings = this.settings.getSettings();
        if (!projectSettings) {
            throw new Error('Project not configured');
        }

        this.setStatus('connecting', 'Connecting...');

        await this.assertNoSymbolicLinks(this.settings.getWorkspaceFolder());

        // Load ignore patterns
        await this.ignoreParser.load();

        if (this.stateStore) {
            await this.stateStore.load();
            for (const entry of this.stateStore.entries.values()) {
                this.setBaseContent(entry.path, entry.content === undefined
                    ? SYNCHRONIZED_CONTENT_MARKER : Buffer.from(entry.content, 'base64'));
                if (entry.hash) {
                    this.getBaseHashes().set(entry.path, entry.hash);
                    this.fileCache.set(entry.path, entry.hash);
                }
            }
            this.log(`Restored ${this.stateStore.entries.size} synchronization ancestors`);
        }

        // Create socket connection
        const identity = this.api.getIdentity();
        if (!identity) {
            throw new Error('Not authenticated');
        }

        // Try socket.io first, fall back to HTTP-only mode
        let useHttpFallback = false;
        let socketError: unknown;
        try {
            this.socket = new SocketIOAPI(this.api, identity, projectSettings.projectId);

            // Register socket event handlers
            this.socket.registerHandlers({
                onConnected: () => this.setStatus('connecting', 'Connected; restoring synchronization...'),
                onDisconnected: (isAuthError?: boolean) => {
                    if (isAuthError) {
                        this.setStatus('error', 'Session expired', undefined, true);
                    } else {
                        this.setStatus('disconnected', 'Disconnected');
                        this.scheduleAutomaticRecovery();
                    }
                },
                onFileCreated: (parentId, type, entity) => this.enqueueRemoteEvent(
                    isCurrent => this.handleRemoteFileCreated(parentId, type, entity, isCurrent)
                ),
                onFileRenamed: (entityId, newName) => this.enqueueRemoteEvent(
                    isCurrent => this.handleRemoteFileRenamed(entityId, newName, isCurrent)
                ),
                onFileRemoved: (entityId) => this.enqueueRemoteEvent(
                    isCurrent => this.handleRemoteFileRemoved(entityId, isCurrent)
                ),
                onFileMoved: (entityId, newParentId) => this.enqueueRemoteEvent(
                    isCurrent => this.handleRemoteFileMoved(entityId, newParentId, isCurrent)
                ),
                onFileChanged: (update) => this.enqueueRemoteEvent(
                    isCurrent => this.handleRemoteFileChanged(update, isCurrent),
                    this.estimateDocumentUpdateCost(update),
                ),
                onRootDocUpdated: (rootDocId) => this.enqueueRemoteEvent(
                    () => this.handleRootDocumentUpdated(rootDocId)
                ),
            });

            // Join project via socket.io
            const socketProject = await this.socket.joinProject();
            this.buildFileTree(socketProject);
            this.project = socketProject;
            this.setStatus('idle', 'Connected (real-time)');
        } catch (error) {
            debugLog('Socket.io failed, using HTTP fallback:', error);
            socketError = error;
            this.log(`Real-time connection unavailable: ${errorMessage(error)}`);
            this.socket?.disconnect();
            useHttpFallback = true;
        }

        // HTTP fallback - use REST API instead of socket.io
        if (useHttpFallback) {
            this.setStatus('connecting', 'Connecting via HTTP...');
            this.socket = undefined;

            try {
                // Get project details via HTTP
                const projectResult = await this.api.getProjectDetails(projectSettings.projectId);
                ensureApiSuccess(projectResult, 'Get project details');
                if (!projectResult.projectData) throw new Error('Overleaf returned no project details');

                const projectData = projectResult.projectData;
                debugLog('HTTP fallback - project data:', projectData.projectName);

                // Build file tree from rootFolder if available
                if (projectData.rootFolder && projectData.rootFolder.length > 0) {
                    const httpProject: ProjectEntity = {
                        _id: projectData.projectId,
                        name: projectData.projectName || 'Unknown',
                        rootDoc_id: projectData.rootDocId,
                        rootFolder: projectData.rootFolder,
                        compiler: projectData.compiler,
                        owner: { _id: projectData.userId || '', email: projectData.userEmail || '', first_name: 'Unknown' },
                        members: [],
                    };
                    this.buildFileTree(httpProject);
                    this.project = httpProject;
                } else {
                    throw new Error(
                        'Safe HTTP synchronization is unavailable because this server does not expose folder IDs.'
                    );
                }

                this.setStatus('idle', 'Connected (HTTP mode)');
            } catch (httpError) {
                const authErr = isAuthError(socketError) || isAuthError(httpError);
                const connectionError = new Error(
                    socketError
                        ? `Real-time synchronization failed: ${errorMessage(socketError)} `
                            + `HTTP fallback failed: ${errorMessage(httpError)}`
                        : `HTTP synchronization failed: ${errorMessage(httpError)}`
                );
                this.setStatus(
                    'error',
                    authErr ? 'Session expired' : `Failed to connect: ${connectionError.message}`,
                    undefined,
                    authErr,
                );
                throw connectionError;
            }
        }

        // Setup local file watcher
        this.throwIfDisposed();
        this.setupLocalWatcher();
        const ignoreWatcher = createIgnoreWatcher(this.settings.getWorkspaceFolder(), () => {
            void this.ignoreParser.load().catch(error => {
                if (!this.disposed) {
                    this.setStatus('error', `Failed to reload .leafignore: ${error}`);
                }
            });
        });
        this.disposables.push(ignoreWatcher);
    }

    /**
     * Build file tree from project structure
     */
    private buildFileTree(project: ProjectEntity, targetPath = '/'): void {
        debugLog('buildFileTree: Building tree for project', project.name);
        debugLog('buildFileTree: rootFolder count:', project.rootFolder?.length || 0);

        // Build into temporary maps so malformed remote metadata cannot erase a
        // valid live tree before the replacement has been fully validated.
        const nextFileTree = new Map<string, FileTreeEntry>();
        const nextFileTreeByPath = new Map<string, FileTreeEntry>();

        let entityCount = 0;
        const addEntry = (entry: FileTreeEntry) => {
            entityCount++;
            if (entityCount > 100_000) {
                throw new Error('Overleaf project contains too many entities.');
            }
            if (nextFileTree.has(entry.id)) {
                throw new Error(`Overleaf returned duplicate entity ID: ${entry.id}`);
            }
            if (nextFileTreeByPath.has(entry.path)) {
                throw new Error(`Overleaf returned duplicate entity path: ${entry.path}`);
            }
            nextFileTree.set(entry.id, entry);
            nextFileTreeByPath.set(entry.path, entry);
        };
        const childEntities = (value: unknown, label: string): FileEntity[] => {
            if (value === undefined) return [];
            if (!Array.isArray(value)) throw new Error(`Overleaf returned invalid ${label}.`);
            return value as FileEntity[];
        };

        const traverse = (
            folder: FolderEntity,
            parentPath: string,
            parentId?: string,
            isRoot: boolean = false,
            depth: number = 0,
        ) => {
            if (!folder || typeof folder !== 'object' || depth > 256) {
                throw new Error('Overleaf returned an invalid or excessively deep folder tree.');
            }
            const folderId = validateOverleafId(folder._id, 'folder ID');
            // For root folder, don't add the folder itself, just its contents at /
            const folderPath = isRoot ? '/' : joinProjectPath(parentPath, folder.name, true);

            // Add folder entry (skip for root folder)
            if (!isRoot) {
                const folderEntry: FileTreeEntry = {
                    id: folderId,
                    type: 'folder',
                    name: folder.name,
                    path: folderPath,
                    parentId,
                };
                addEntry(folderEntry);
            } else {
                // Store root folder ID for reference
                const rootEntry: FileTreeEntry = {
                    id: folderId,
                    type: 'folder',
                    name: '',
                    path: '/',
                    parentId: undefined,
                };
                addEntry(rootEntry);
            }

            // Add docs
            for (const doc of childEntities(folder.docs, 'document list')) {
                const docPath = joinProjectPath(folderPath, doc.name, false);
                const docId = validateOverleafId(doc._id, 'document ID');
                const entry: FileTreeEntry = {
                    id: docId,
                    type: 'doc',
                    name: doc.name,
                    path: docPath,
                    parentId: folderId,
                };
                addEntry(entry);
                debugLog('buildFileTree: Added doc', docPath);
            }

            // Add file refs
            for (const file of childEntities(folder.fileRefs, 'file list')) {
                const filePath = joinProjectPath(folderPath, file.name, false);
                const fileId = validateOverleafId(file._id, 'file ID');
                const entry: FileTreeEntry = {
                    id: fileId,
                    type: 'file',
                    name: file.name,
                    path: filePath,
                    parentId: folderId,
                };
                addEntry(entry);
                debugLog('buildFileTree: Added file', filePath);
            }

            // Recurse into subfolders
            for (const subfolder of childEntities(folder.folders, 'folder list')) {
                traverse(subfolder as FolderEntity, folderPath, folderId, false, depth + 1);
            }
        };

        // Start from root folder - treat it as root (don't include its name in paths)
        if (Array.isArray(project.rootFolder) && project.rootFolder.length > 0) {
            traverse(project.rootFolder[0], '', undefined, true);
        } else {
            throw new Error('Overleaf returned no valid root folder.');
        }

        if (targetPath !== '/') {
            const target = normalizeProjectPath(targetPath, false).replace(/\/$/, '');
            const belongsToTarget = (candidate: string) => candidate.replace(/\/$/, '') === target
                || candidate.startsWith(target + '/');
            // A file operation owns only its path. Updating unrelated entries
            // here could erase work from a primary handler already in flight.
            for (const [id, entry] of nextFileTree) {
                const ancestor = entry.type === 'folder' && target.startsWith(entry.path);
                if (!belongsToTarget(entry.path) && !ancestor) {
                    nextFileTree.delete(id);
                    nextFileTreeByPath.delete(entry.path);
                }
            }
            for (const entry of this.fileTree.values()) {
                if (belongsToTarget(entry.path)) continue;
                const incoming = nextFileTree.get(entry.id);
                const collision = nextFileTreeByPath.get(entry.path);
                if ((incoming && incoming.path !== entry.path) || (collision && collision.id !== entry.id)) {
                    throw new Error(`Remote structure changed outside ${targetPath}; synchronize the project before retrying`);
                }
                nextFileTree.set(entry.id, entry);
                nextFileTreeByPath.set(entry.path, entry);
            }
        }

        // Preserve the Map objects returned by getFileTree while replacing
        // their contents in one synchronous commit.
        for (const [id, entry] of this.fileTree) {
            if (!nextFileTree.has(id)) this.removedSnapshotEntries.set(id, { ...entry });
        }
        for (const id of nextFileTree.keys()) this.removedSnapshotEntries.delete(id);
        while (this.removedSnapshotEntries.size > MAX_LOCAL_SCAN_ENTITIES) {
            this.removedSnapshotEntries.delete(this.removedSnapshotEntries.keys().next().value!);
        }
        this.fileTree.clear();
        this.fileTreeByPath.clear();
        for (const [id, entry] of nextFileTree) this.fileTree.set(id, entry);
        for (const [path, entry] of nextFileTreeByPath) this.fileTreeByPath.set(path, entry);

        debugLog('buildFileTree: Total entries:', this.fileTree.size);
    }

    /**
     * Detect and update main document from project's rootDoc_id
     */
    async detectMainDocument(): Promise<void> {
        if (!this.project?.rootDoc_id) return;

        const rootDocEntry = this.fileTree.get(this.project.rootDoc_id);
        if (!rootDocEntry || rootDocEntry.type !== 'doc') return;

        const mainTex = rootDocEntry.path.startsWith('/')
            ? rootDocEntry.path.slice(1)  // Remove leading slash
            : rootDocEntry.path;
        if (!mainTex.toLowerCase().endsWith('.tex')) return;
        const mainPdf = mainTex.replace(/\.tex$/i, '.pdf');

        const currentSettings = this.settings.getSettings();
        if (currentSettings && (currentSettings.mainTex !== mainTex || currentSettings.mainPdf !== mainPdf)) {
            await this.settings.update({ mainTex, mainPdf });
            this.ignoreParser.updateSettings({ ...currentSettings, mainTex, mainPdf });
            debugLog('Updated main document:', mainTex, mainPdf);
        }
    }

    /**
     * Setup local file system watcher
     */
    private setupLocalWatcher(): void {
        const workspaceFolder = this.settings.getWorkspaceFolder();
        const pattern = new vscode.RelativePattern(workspaceFolder, '**/*');

        const localWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        const run = (operation: () => Promise<void>) => {
            if (!this.automaticSyncEnabled) return;
            void operation().catch(error => {
                if (!this.disposed) {
                    console.error('[LocalLeaf] Local filesystem event failed:', error);
                    const authErr = isAuthError(error);
                    this.setStatus(
                        'error',
                        authErr ? 'Session expired' : `Local synchronization failed: ${error}`,
                        undefined,
                        authErr,
                    );
                }
            });
        };

        this.disposables.push(
            localWatcher.onDidChange(uri => this.queueLocalEvent(uri, run)),
            localWatcher.onDidCreate(uri => this.queueLocalEvent(uri, run)),
            localWatcher.onDidDelete(uri => this.queueLocalEvent(uri, run)),
            localWatcher
        );
    }

    /** Watcher events are hints. Coalesce atomic replacement and inspect the current type. */
    private queueLocalEvent(uri: vscode.Uri, run: (operation: () => Promise<void>) => void): void {
        try { if (!this.shouldSync(this.getRelativePath(uri))) return; }
        catch { return; }
        const key = uri.toString();
        clearTimeout(this.localEventTimers.get(key));
        this.localEventTimers.set(key, setTimeout(() => {
            this.localEventTimers.delete(key);
            run(async () => {
                if (this.disposed) return;
                let stat: vscode.FileStat;
                try { await this.assertNoSymbolicLinks(uri); stat = await vscode.workspace.fs.stat(uri); }
                catch (error) {
                    if (isFileNotFoundError(error)) return this.handleLocalFileDelete(uri);
                    throw error;
                }
                const relative = this.getRelativePath(uri);
                if (!this.shouldSync(relative)) return;
                if ((stat.type & vscode.FileType.Directory) !== 0) return this.handleLocalFileCreate(uri);
                if ((stat.type & vscode.FileType.File) === 0) return;
                // Size/mtime stability avoids uploading the middle of a generated-file write.
                if (!(await this.waitForRetry(250))) return;
                const latest = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(error => {
                    if (isFileNotFoundError(error)) return undefined;
                    throw error;
                });
                if (!latest || latest.size !== stat.size || latest.mtime !== stat.mtime) {
                    this.queueLocalEvent(uri, run);
                    return;
                }
                if (this.fileTreeByPath.has(relative)) await this.handleLocalFileChange(uri);
                else await this.handleLocalFileCreate(uri);
            });
        }, DEBOUNCE_DELAY));
    }

    /**
     * Get relative path from URI
     */
    private getRelativePath(uri: vscode.Uri): string {
        const relativePath = this.settings.getRelativePath(uri);
        if (!relativePath || relativePath === '/') {
            throw new Error(`Refusing to synchronize a path outside the workspace: ${uri.toString()}`);
        }
        return normalizeProjectPath(relativePath, false);
    }

    private async assertNoSymbolicLinks(uri: vscode.Uri): Promise<void> {
        await assertSafeWorkspacePath(this.settings.getWorkspaceFolder(), uri);
    }

    private async readLocalFile(uri: vscode.Uri): Promise<Uint8Array> {
        await this.assertNoSymbolicLinks(uri);
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.File) === 0) {
            throw new Error(`Refusing to read a non-file synchronization path: ${uri.fsPath}`);
        }
        if (
            !Number.isSafeInteger(stat.size)
            || stat.size < 0
            || stat.size > MAX_REMOTE_FILE_BYTES
        ) {
            throw new Error(`Local file exceeds the synchronization size limit: ${uri.fsPath}`);
        }

        const content = await vscode.workspace.fs.readFile(uri);
        if (content.byteLength > MAX_REMOTE_FILE_BYTES) {
            throw new Error(`Local file exceeds the synchronization size limit: ${uri.fsPath}`);
        }
        return content;
    }

    /**
     * Check if path should be synced (not ignored)
     */
    private shouldSync(relativePath: string): boolean {
        const normalized = normalizeProjectPath(relativePath).toLowerCase();
        if (
            normalized === '/.leafignore'
            || normalized === '/.localleaf'
            || normalized === '/.localleaf/'
            || normalized.startsWith('/.localleaf/')
            || normalized === '/.git'
            || normalized === '/.git/'
            || normalized.startsWith('/.git/')
            || normalized === '/.vscode'
            || normalized === '/.vscode/'
            || normalized.startsWith('/.vscode/')
        ) {
            return false;
        }
        return !this.ignoreParser.shouldIgnore(relativePath);
    }

    /**
     * Check if we should propagate a change (prevent echo)
     */
    private shouldPropagate(path: string, content?: Uint8Array): boolean {
        const cache = this.fileCache.get(path);
        const newHash = hashContent(content);
        // Only content confirmed as synchronized is an echo. Advancing this
        // cache before the remote operation succeeds would suppress retries
        // after a failed upload of otherwise unchanged local content.
        return cache !== newHash;
    }

    private recordSynchronizedContent(entry: FileTreeEntry, content: Uint8Array): void {
        const hash = hashContent(content);
        this.setBaseContent(
            entry.path,
            entry.type === 'doc' ? content : SYNCHRONIZED_CONTENT_MARKER,
            hash,
        );
        this.fileCache.set(entry.path, hash);
        // Keep hashes for attachments too, without retaining their byte buffers.
        this.getBaseHashes().set(entry.path, hash);
        this.pendingConflicts?.delete(entry.path);
        this.fileErrors?.delete(entry.path);
        this.stateStore?.put({ path: entry.path, id: entry.id, type: entry.type,
            hash, content: entry.type === 'doc' && /\.(tex|bib|md|sty|cls)$/i.test(entry.path)
                && content.byteLength <= 2 * 1024 * 1024
                ? Buffer.from(content).toString('base64') : undefined,
            version: this.documentSnapshots.get(entry.id)?.version });
    }

    private ensureRetainedDocumentByteCount(): void {
        if (Number.isSafeInteger(this.retainedDocumentBytes) && this.retainedDocumentBytes >= 0) return;
        this.retainedDocumentBytes = [...this.baseContent.values()].reduce(
            (total, value) => total + (
                value === SYNCHRONIZED_CONTENT_MARKER ? 0 : value.byteLength
            ),
            0,
        );
    }

    private getBaseHashes(): Map<string, string> {
        if (!(this.baseHashes instanceof Map)) this.baseHashes = new Map();
        return this.baseHashes;
    }

    private setBaseContent(path: string, content: Uint8Array, knownHash?: string): void {
        this.ensureRetainedDocumentByteCount();
        const previous = this.baseContent.get(path);
        if (previous && previous !== SYNCHRONIZED_CONTENT_MARKER) {
            this.retainedDocumentBytes -= previous.byteLength;
        }
        this.baseContent.delete(path);
        this.baseContent.set(path, content);
        if (content !== SYNCHRONIZED_CONTENT_MARKER) {
            this.retainedDocumentBytes += content.byteLength;
            this.getBaseHashes().set(path, knownHash ?? hashContent(content));
        } else {
            this.getBaseHashes().delete(path);
        }
        const folder = this.fileTreeByPath.get(path);
        if (folder?.type === 'folder' && this.stateStore) {
            this.stateStore.put({ path, id: folder.id, type: 'folder' });
        }
        if (folder?.type === 'folder') {
            this.fileErrors?.delete(path);
            this.fileErrors?.delete(path.replace(/\/$/, ''));
        }

        const maximum = this.maxRetainedDocumentBytes ?? MAX_RETAINED_DOCUMENT_BYTES;
        while (this.retainedDocumentBytes > maximum) {
            let evicted = false;
            for (const [candidatePath, candidateContent] of this.baseContent) {
                if (
                    candidatePath === path
                    || candidateContent === SYNCHRONIZED_CONTENT_MARKER
                    || candidateContent.byteLength === 0
                ) continue;
                this.baseContent.delete(candidatePath);
                this.baseContent.set(candidatePath, SYNCHRONIZED_CONTENT_MARKER);
                this.retainedDocumentBytes -= candidateContent.byteLength;
                evicted = true;
                break;
            }
            if (!evicted) break;
        }
    }

    private deleteBaseContent(path: string): void {
        this.ensureRetainedDocumentByteCount();
        const previous = this.baseContent.get(path);
        if (previous && previous !== SYNCHRONIZED_CONTENT_MARKER) {
            this.retainedDocumentBytes -= previous.byteLength;
        }
        this.baseContent.delete(path);
        this.getBaseHashes().delete(path);
        this.stateStore?.delete(path);
        this.fileErrors?.delete(path);
        if (path.endsWith('/')) this.fileErrors?.delete(path.slice(0, -1));
    }

    private clearBaseContent(): void {
        this.baseContent.clear();
        this.getBaseHashes().clear();
        this.retainedDocumentBytes = 0;
    }

    private getOpenTextDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
        const target = uri.toString();
        return vscode.workspace.textDocuments.find(document => document.uri.toString() === target);
    }

    private getOpenTextDocumentsUnderProjectPath(projectPath: string): vscode.TextDocument[] {
        const folderPrefix = projectPath.endsWith('/') ? projectPath : undefined;
        return vscode.workspace.textDocuments.filter(document => {
            let relativePath: string | undefined;
            try {
                relativePath = this.settings.getRelativePath(document.uri);
            } catch {
                return false;
            }
            return relativePath === projectPath
                || Boolean(folderPrefix && relativePath?.startsWith(folderPrefix));
        });
    }

    private async renameLocalPath(
        projectPath: string,
        oldUri: vscode.Uri,
        newUri: vscode.Uri,
    ): Promise<void> {
        if (this.getOpenTextDocumentsUnderProjectPath(projectPath).length === 0) {
            await vscode.workspace.fs.rename(oldUri, newUri);
            return;
        }

        // WorkspaceEdit keeps open editor tabs (including dirty buffers)
        // associated with the renamed file and makes the operation undoable.
        const edit = new vscode.WorkspaceEdit();
        edit.renameFile(oldUri, newUri, { overwrite: false, ignoreIfExists: false });
        if (!(await vscode.workspace.applyEdit(edit))) {
            throw new Error(`VS Code refused to rename the open local path ${projectPath}`);
        }
    }

    private async deleteLocalPath(
        projectPath: string,
        localUri: vscode.Uri,
        recursive: boolean,
    ): Promise<'deleted' | 'preserved'> {
        const openDocuments = this.getOpenTextDocumentsUnderProjectPath(projectPath);
        if (openDocuments.some(document => document.isDirty)) {
            return 'preserved';
        }

        if (openDocuments.length > 0) {
            // Keep VS Code's editor model in sync with the filesystem and retain
            // an Undo route for a clean file removed remotely.
            const edit = new vscode.WorkspaceEdit();
            edit.deleteFile(localUri, { recursive, ignoreIfNotExists: true });
            if (!(await vscode.workspace.applyEdit(edit))) {
                throw new Error(`VS Code refused to delete the open local path ${projectPath}`);
            }
        } else {
            await vscode.workspace.fs.delete(localUri, { recursive, useTrash: true });
        }
        return 'deleted';
    }

    private reportPreservedRemoteDeletion(projectPath: string): void {
        const message = `Kept ${projectPath} locally because it contains unsaved editor changes; `
            + 'run Sync Now when you are ready to reconcile the remote deletion.';
        this.log(message);
        void vscode.window.showWarningMessage(`LocalLeaf: ${message}`);
    }

    private getTrackedSubtreeEntries(projectPath: string, includeRemovedSnapshot = false): FileTreeEntry[] {
        const candidates = [...this.fileTree.values()];
        if (includeRemovedSnapshot) {
            candidates.push(...[...this.removedSnapshotEntries.values()].filter(entry => !this.fileTreeByPath.has(entry.path)));
        }
        return candidates.filter(candidate =>
            candidate.path === projectPath
            || (projectPath.endsWith('/') && candidate.path.startsWith(projectPath))
        );
    }

    private getOpenDocumentContent(document: vscode.TextDocument): Uint8Array {
        const text = document.getText();
        if (text.length > MAX_REMOTE_DOCUMENT_CHARACTERS) {
            throw new Error('The open document exceeds the synchronization size limit.');
        }
        const content = new TextEncoder().encode(text);
        if (content.byteLength > MAX_REMOTE_FILE_BYTES) {
            throw new Error('The open document exceeds the synchronization size limit.');
        }
        return content;
    }

    /**
     * Replace a dirty editor through the VS Code edit API so the user's previous
     * buffer remains recoverable with Undo. The expected version prevents a
     * response to an older conflict prompt from overwriting newer typing.
     */
    private async applyRemoteContentToOpenDocument(
        document: vscode.TextDocument,
        expectedVersion: number,
        content: Uint8Array,
    ): Promise<'applied' | 'unchanged' | 'stale' | 'failed'> {
        if (document.version !== expectedVersion) return 'stale';

        const currentText = document.getText();
        const nextText = new TextDecoder().decode(content);
        if (currentText === nextText) return 'unchanged';

        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(document.positionAt(0), document.positionAt(currentText.length)),
            nextText,
        );

        if (!(await vscode.workspace.applyEdit(edit))) return 'failed';
        return document.getText() === nextText ? 'applied' : 'stale';
    }

    private keepLocalDocumentAfterRemoteUpdate(
        path: string,
        message: string,
        updateStatus: boolean = true,
    ): void {
        // Keep the last common baseline; the separate document snapshot tracks remote revisions.
        this.log(message);
        if (updateStatus) this.setStatus('idle', message, path);
    }

    /**
     * Acquire sync lock for a path
     */
    private acquireLock(path: string): boolean {
        if (this.disposed) return false;
        const pathPrefix = path.endsWith('/') ? path : `${path}/`;
        const overlapsExistingLock = [...this.syncLock].some(lockedPath => {
            const lockedPrefix = lockedPath.endsWith('/') ? lockedPath : `${lockedPath}/`;
            return lockedPath === path || lockedPath.startsWith(pathPrefix) || path.startsWith(lockedPrefix);
        });
        if (overlapsExistingLock) {
            return false;
        }
        this.syncLock.add(path);
        return true;
    }

    /**
     * Release sync lock for a path
     */
    private releaseLock(path: string): void {
        this.syncLock.delete(path);
        void this.stateStore?.flush().catch(error => this.log(`Synchronization state write failed: ${errorMessage(error)}`));
    }

    private waitForRetry(delayMs = DEBOUNCE_DELAY): Promise<boolean> {
        if (this.disposed) return Promise.resolve(false);
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.pendingWaits.delete(timer);
                resolve(!this.disposed);
            }, delayMs);
            this.pendingWaits.set(timer, resolve);
        });
    }

    private async acquireLockWhenAvailable(path: string): Promise<boolean> {
        while (!this.disposed) {
            if (this.acquireLock(path)) return true;
            if (!(await this.waitForRetry())) return false;
        }
        return false;
    }

    /** A queued event identifies an entity, not the path it occupied before waiting. */
    private async acquireRemoteEntryLock(entityId: string, isCurrent: () => boolean,
        includeRemovedSnapshot = false): Promise<FileTreeEntry | undefined> {
        const resolve = () => {
            const entry = this.fileTree.get(entityId) ?? (includeRemovedSnapshot ? this.removedSnapshotEntries.get(entityId) : undefined);
            const occupant = entry && this.fileTreeByPath.get(entry.path);
            return occupant && occupant.id !== entityId ? undefined : entry;
        };
        while (isCurrent()) {
            const before = resolve();
            if (!before) return undefined;
            const lockedPath = before.path;
            if (lockedPath === '/') throw new Error('Refusing to synchronize the Overleaf project root.');
            if (!(await this.acquireLockWhenAvailable(lockedPath))) return undefined;
            const current = resolve();
            if (isCurrent() && current?.path === lockedPath) return current;
            this.releaseLock(lockedPath);
            // A snapshot may have moved the entity and reused its old path.
            // Reacquire its current path before performing any filesystem I/O.
        }
        return undefined;
    }

    private async runWorkspaceExclusive<T>(operation: () => Promise<T>): Promise<T> {
        if (!(await this.acquireLockWhenAvailable('/'))) {
            this.throwIfDisposed();
            throw new Error('Could not acquire the workspace synchronization lock.');
        }
        try {
            this.throwIfDisposed();
            return await operation();
        } finally {
            this.releaseLock('/');
        }
    }

    private scheduleOperation(operation: () => Promise<void>): void {
        void this.waitForRetry().then(active => {
            if (active) return operation();
            return undefined;
        }).catch(error => {
            if (!this.disposed) console.error('[LocalLeaf] Delayed synchronization failed:', error);
        });
    }

    private requestBackgroundChoice(
        key: string,
        prompt: () => Thenable<string | undefined>,
        apply: (choice: string | undefined) => Promise<void>,
        fingerprint?: string,
    ): void {
        if (this.disposed || this.backgroundChoices.has(key)
            || (fingerprint !== undefined && this.reviewedBackgroundChoices?.get(key) === fingerprint)) return;
        if (fingerprint !== undefined) {
            const reviewed = this.reviewedBackgroundChoices ??= new Map();
            // Remember only a small number of batch revisions during this
            // session. A changed batch or an explicit Sync Now is reviewable.
            if (reviewed.size >= 32 && !reviewed.has(key)) reviewed.delete(reviewed.keys().next().value!);
            reviewed.set(key, fingerprint);
        }
        this.backgroundChoices.add(key);
        void Promise.resolve(prompt()).then(choice => {
            if (this.disposed) return;
            this.scheduleOperation(async () => {
                try {
                    await this.runWorkspaceExclusive(() => apply(choice));
                } catch (error) {
                    this.setStatus('error', `Unable to apply synchronization choice: ${errorMessage(error)}`, undefined, isAuthError(error));
                    throw error;
                } finally {
                    this.backgroundChoices.delete(key);
                    if (this.statusMessage === 'Some files need your choice in notifications; other files continue syncing') {
                        this.setStatus('idle');
                    }
                }
            });
        }).catch(error => {
            this.backgroundChoices.delete(key);
            this.log(`Synchronization choice failed: ${errorMessage(error)}`);
        });
    }

    private localChoiceFingerprint(hashes: ReadonlyMap<string, string>): string {
        const digest = createHash('sha256');
        for (const filePath of [...hashes.keys()].sort()) {
            const document = this.getOpenTextDocument(this.settings.getFilePath(filePath));
            const contentHash = document?.isDirty ? hashContent(this.getOpenDocumentContent(document)) : hashes.get(filePath);
            digest.update(JSON.stringify([filePath, contentHash]));
        }
        return digest.digest('hex');
    }

    private suppressRemoteRename(entityId: string, newName: string): void {
        if (
            !this.suppressedRemoteRenames.has(entityId)
            && this.suppressedRemoteRenames.size >= MAX_SUPPRESSED_RENAME_ENTITIES
        ) {
            const oldestEntity = this.suppressedRemoteRenames.keys().next().value as string | undefined;
            if (oldestEntity !== undefined) this.suppressedRemoteRenames.delete(oldestEntity);
        }
        const names = this.suppressedRemoteRenames.get(entityId) || new Set<string>();
        names.add(newName);
        while (names.size > MAX_SUPPRESSED_RENAMES_PER_ENTITY) {
            const oldestName = names.values().next().value as string | undefined;
            if (oldestName === undefined) break;
            names.delete(oldestName);
        }
        this.suppressedRemoteRenames.set(entityId, names);
    }

    private consumeSuppressedRemoteRename(entityId: string, newName: string): boolean {
        const names = this.suppressedRemoteRenames.get(entityId);
        if (!names?.delete(newName)) {
            return false;
        }
        if (names.size === 0) {
            this.suppressedRemoteRenames.delete(entityId);
        }
        return true;
    }

    private documentUpdateFingerprint(update: DocumentUpdate): string {
        const digest = createHash('sha256');
        const append = (label: string, value: string): void => {
            digest.update(label);
            digest.update(':');
            digest.update(String(value.length));
            digest.update(':');
            digest.update(value);
            digest.update(';');
        };
        append('version', String(update.v));
        append('lastVersion', update.lastV === undefined ? '' : String(update.lastV));
        append('operationCount', String(update.op?.length ?? 0));
        for (const operation of update.op ?? []) {
            append('position', String(operation.p));
            append('insertPresent', operation.i === undefined ? '0' : '1');
            if (operation.i !== undefined) append('insert', operation.i);
            append('deletePresent', operation.d === undefined ? '0' : '1');
            if (operation.d !== undefined) append('delete', operation.d);
            append('undo', operation.u === undefined ? '' : String(operation.u));
        }
        return digest.digest('hex');
    }

    private ensureSuppressedDocumentUpdateCount(): void {
        if (!(this.suppressedRemoteDocumentUpdates instanceof Map)) {
            this.suppressedRemoteDocumentUpdates = new Map();
        }
        if (
            Number.isSafeInteger(this.suppressedDocumentUpdateCount)
            && this.suppressedDocumentUpdateCount >= 0
        ) return;
        this.suppressedDocumentUpdateCount = [...this.suppressedRemoteDocumentUpdates.values()]
            .reduce((total, fingerprints) => total + fingerprints.size, 0);
    }

    private clearSuppressedDocumentUpdates(docId: string): void {
        this.ensureSuppressedDocumentUpdateCount();
        const fingerprints = this.suppressedRemoteDocumentUpdates.get(docId);
        if (fingerprints) this.suppressedDocumentUpdateCount -= fingerprints.size;
        this.suppressedRemoteDocumentUpdates.delete(docId);
    }

    private suppressRemoteDocumentUpdate(update: DocumentUpdate): void {
        this.ensureSuppressedDocumentUpdateCount();
        const fingerprints = this.suppressedRemoteDocumentUpdates.get(update.doc) || new Set<string>();
        const previousSize = fingerprints.size;
        fingerprints.add(this.documentUpdateFingerprint(update));
        this.suppressedDocumentUpdateCount += fingerprints.size - previousSize;
        while (fingerprints.size > 100) {
            const oldest = fingerprints.values().next().value as string | undefined;
            if (oldest === undefined) break;
            fingerprints.delete(oldest);
            this.suppressedDocumentUpdateCount--;
        }
        this.suppressedRemoteDocumentUpdates.set(update.doc, fingerprints);

        const maximum = this.maxSuppressedDocumentUpdates ?? MAX_SUPPRESSED_DOCUMENT_UPDATES;
        while (this.suppressedDocumentUpdateCount > maximum) {
            const oldestDocument = this.suppressedRemoteDocumentUpdates.entries().next().value as
                | [string, Set<string>]
                | undefined;
            const oldestFingerprint = oldestDocument?.[1].values().next().value as string | undefined;
            if (!oldestDocument || oldestFingerprint === undefined) break;
            oldestDocument[1].delete(oldestFingerprint);
            this.suppressedDocumentUpdateCount--;
            if (oldestDocument[1].size === 0) {
                this.suppressedRemoteDocumentUpdates.delete(oldestDocument[0]);
            }
        }
    }

    private consumeSuppressedRemoteDocumentUpdate(update: DocumentUpdate): boolean {
        this.ensureSuppressedDocumentUpdateCount();
        const fingerprints = this.suppressedRemoteDocumentUpdates.get(update.doc);
        if (!fingerprints?.delete(this.documentUpdateFingerprint(update))) return false;
        this.suppressedDocumentUpdateCount--;
        if (fingerprints.size === 0) this.suppressedRemoteDocumentUpdates.delete(update.doc);
        return true;
    }

    private suppressRemoteDelete(entityId: string): void {
        this.suppressedRemoteDeletes.add(entityId);
        while (this.suppressedRemoteDeletes.size > MAX_SUPPRESSED_DELETES) {
            const oldest = this.suppressedRemoteDeletes.values().next().value as string | undefined;
            if (oldest === undefined) break;
            this.suppressedRemoteDeletes.delete(oldest);
        }
    }

    private rebaseTrackedPathMap<T>(map: Map<string, T>, oldPath: string, newPath: string): void {
        const updates = [...map.entries()]
            .filter(([path]) => path === oldPath || (oldPath.endsWith('/') && path.startsWith(oldPath)))
            .map(([path, value]) => ({ oldPath: path, newPath: newPath + path.slice(oldPath.length), value }));
        for (const update of updates) map.delete(update.oldPath);
        for (const update of updates) map.set(update.newPath, update.value);
    }

    private assertRemotePathTransitionAvailable(oldPath: string, newPath: string): void {
        if (oldPath === newPath) return;
        const isFolder = oldPath.endsWith('/');
        if (isFolder && newPath.startsWith(oldPath)) {
            throw new Error(`Refusing to move ${oldPath} into its own subtree: ${newPath}`);
        }

        const movingEntries = [...this.fileTree.values()].filter(entry =>
            entry.path === oldPath || (isFolder && entry.path.startsWith(oldPath))
        );
        const movingIds = new Set(movingEntries.map(entry => entry.id));
        for (const entry of movingEntries) {
            const destination = newPath + entry.path.slice(oldPath.length);
            const collision = this.fileTreeByPath.get(destination);
            if (collision && !movingIds.has(collision.id)) {
                throw new Error(
                    `Refusing remote path change because ${destination} already belongs to another entity.`
                );
            }
        }
    }

    private rebaseFileTree(oldPath: string, newPath: string): void {
        if (oldPath === newPath) return;
        this.assertRemotePathTransitionAvailable(oldPath, newPath);
        const updates = [...this.fileTree.values()]
            .filter(entry => entry.path === oldPath || (oldPath.endsWith('/') && entry.path.startsWith(oldPath)))
            .map(entry => ({ entry, oldPath: entry.path, newPath: newPath + entry.path.slice(oldPath.length) }));
        for (const update of updates) this.fileTreeByPath.delete(update.oldPath);
        for (const update of updates) {
            update.entry.path = update.newPath;
            this.fileTreeByPath.set(update.newPath, update.entry);
        }
        this.rebaseTrackedPathMap(this.baseContent, oldPath, newPath);
        this.rebaseTrackedPathMap(this.getBaseHashes(), oldPath, newPath);
        this.rebaseTrackedPathMap(this.fileCache, oldPath, newPath);
        for (const update of updates) {
            const saved = this.stateStore?.entries.get(update.oldPath);
            if (saved) {
                this.stateStore!.put({ ...saved, path: update.newPath });
                this.stateStore!.delete(update.oldPath);
            }
        }
        for (const update of updates) this.pendingConflicts?.delete(update.oldPath);
    }

    private removeTrackedSubtree(path: string): void {
        const matches = (candidate: string) => candidate === path
            || (path.endsWith('/') && candidate.startsWith(path));
        for (const [id, entry] of this.removedSnapshotEntries) {
            if (matches(entry.path)) this.removedSnapshotEntries.delete(id);
        }
        for (const [id, entry] of [...this.fileTree]) {
            if (!matches(entry.path)) continue;
            this.fileTree.delete(id);
            this.fileTreeByPath.delete(entry.path);
            this.joinedDocs.delete(id);
            this.clearSuppressedDocumentUpdates(id);
            this.deleteDocumentSnapshot(id);
        }
        for (const key of [...this.baseContent.keys()]) {
            if (matches(key)) this.deleteBaseContent(key);
        }
        for (const key of [...this.fileCache.keys()]) {
            if (matches(key)) this.fileCache.delete(key);
        }
        for (const key of this.pendingConflicts?.keys() ?? []) {
            if (matches(key)) this.pendingConflicts.delete(key);
        }
    }

    private async handleRootDocumentUpdated(rootDocId: string): Promise<void> {
        if (!this.project) return;
        if (!rootDocId) {
            this.project.rootDoc_id = undefined;
            await this.settings.update({ mainTex: undefined, mainPdf: undefined });
            const currentSettings = this.settings.getSettings();
            if (currentSettings) this.ignoreParser.updateSettings(currentSettings);
            return;
        }
        this.project.rootDoc_id = validateOverleafId(rootDocId, 'root document ID');
        await this.detectMainDocument();
    }

    private removeTrackedContent(path: string): void {
        const matches = (candidate: string) => candidate === path
            || (path.endsWith('/') && candidate.startsWith(path));
        for (const key of [...this.baseContent.keys()]) {
            if (matches(key)) this.deleteBaseContent(key);
        }
        for (const key of [...this.fileCache.keys()]) {
            if (matches(key)) this.fileCache.delete(key);
        }
    }

    private async getRemoteEntryContent(entry: FileTreeEntry): Promise<Uint8Array> {
        if (entry.type === 'folder') {
            throw new Error(`Cannot download folder content: ${entry.path}`);
        }

        const projectSettings = this.settings.getSettings()!;
        if (entry.type === 'file') {
            const result = await this.api.getFile(projectSettings.projectId, entry.id);
            ensureApiSuccess(result, `Download ${entry.path}`);
            if (!result.content) throw new Error(`Download ${entry.path}: Overleaf returned no content`);
            return result.content;
        }

        return (await this.readRemoteDocument(entry.id)).content;
    }

    /** Read a snapshot without leaving the document's real-time subscription. */
    private async readRemoteDocument(docId: string): Promise<DocumentSnapshot> {
        let snapshot: DocumentSnapshot | undefined;
        let socketError: unknown;
        if (this.socket) {
            try {
                const { lines, version } = await this.socket.joinDoc(docId);
                this.throwIfDisposed();
                if (!Number.isSafeInteger(version) || version < 0) {
                    throw new Error('Overleaf returned an invalid document version.');
                }
                snapshot = { content: this.encodeDocument(lines), version };
                this.joinedDocs.add(docId);
            } catch (error) {
                this.throwIfDisposed();
                if (isAuthError(error)) throw error;
                socketError = error;
                debugLog(`Unable to read document ${docId} via Socket.IO:`, error);
            }
        }
        if (!snapshot) {
            const projectId = this.settings.getSettings()!.projectId;
            const result = await this.api.getDocContent(projectId, docId);
            try {
                ensureApiSuccess(result, `Download ${this.fileTree.get(docId)?.path || docId}`);
            } catch (error) {
                if (isAuthError(error) || !socketError) throw error;
                throw new Error(`Download ${docId} failed via Socket.IO (${errorMessage(socketError)}) and HTTP (${errorMessage(error)})`);
            }
            this.throwIfDisposed();
            if (!result.lines) throw new Error('Overleaf returned no document content.');
            snapshot = { content: this.encodeDocument(result.lines) };
        }
        this.setDocumentSnapshot(docId, snapshot);
        return snapshot;
    }

    private setDocumentSnapshot(docId: string, snapshot: DocumentSnapshot): void {
        this.deleteDocumentSnapshot(docId);
        this.documentSnapshots.set(docId, snapshot);
        this.retainedSnapshotBytes += snapshot.content.byteLength;
        const maximum = this.maxRetainedDocumentBytes ?? MAX_RETAINED_DOCUMENT_BYTES;
        for (const candidate of this.documentSnapshots.keys()) {
            if (this.retainedSnapshotBytes <= maximum) break;
            this.deleteDocumentSnapshot(candidate);
        }
    }

    private deleteDocumentSnapshot(docId: string): void {
        if (!Number.isSafeInteger(this.retainedSnapshotBytes)) {
            this.retainedSnapshotBytes = [...this.documentSnapshots.values()]
                .reduce((total, snapshot) => total + snapshot.content.byteLength, 0);
        }
        const previous = this.documentSnapshots.get(docId);
        if (previous) this.retainedSnapshotBytes -= previous.content.byteLength;
        this.documentSnapshots.delete(docId);
    }

    private encodeDocument(lines: string[]): Uint8Array {
        if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string')) {
            throw new Error('Overleaf returned invalid document content.');
        }
        const content = lines.join('\n');
        if (content.length > MAX_REMOTE_DOCUMENT_CHARACTERS) {
            throw new Error('Overleaf document exceeds the synchronization size limit.');
        }
        return new TextEncoder().encode(content);
    }

    private async materializeRemoteEntry(entry: FileTreeEntry): Promise<'downloaded' | 'skipped'> {
        if (!this.shouldSync(entry.path)) return 'skipped';
        const localUri = this.settings.getFilePath(entry.path);
        await this.assertNoSymbolicLinks(localUri);
        this.throwIfDisposed();

        if (entry.type === 'folder') {
            await vscode.workspace.fs.createDirectory(localUri);
            this.setBaseContent(entry.path, SYNCHRONIZED_CONTENT_MARKER);
            return 'downloaded';
        }

        const content = await this.getRemoteEntryContent(entry);
        const diskContent = await this.readLocalFileIfExists(localUri);
        const openDocument = this.getOpenTextDocument(localUri);
        const openVersion = openDocument?.version;
        const localContent = openDocument ? this.getOpenDocumentContent(openDocument) : diskContent;
        if (localContent !== undefined && !contentEquals(localContent, content)) {
            const choice = await this.askConflictResolution(entry.path, localUri, content);
            this.throwIfDisposed();
            if (choice !== 'useRemote') return 'skipped';
        }
        this.throwIfDisposed();

        // Downloads and conflict choices can take time. Never overwrite a file
        // or editor that appeared/changed while waiting for either operation.
        const currentDocument = this.getOpenTextDocument(localUri);
        const currentDiskContent = await this.readLocalFileIfExists(localUri);
        this.throwIfDisposed();
        if (!contentEquals(diskContent, currentDiskContent)
            || currentDocument !== openDocument || currentDocument?.version !== openVersion) {
            this.log(`Kept newer local changes while receiving ${entry.path}`);
            return 'skipped';
        }
        if (currentDocument?.isDirty) {
            const result = await this.applyRemoteContentToOpenDocument(currentDocument, openVersion!, content);
            this.throwIfDisposed();
            if (result === 'stale' || result === 'failed') return 'skipped';
        } else if (!contentEquals(diskContent, content)) {
            await vscode.workspace.fs.writeFile(localUri, content);
        }
        this.recordSynchronizedContent(entry, content);
        this.log(`Downloaded from Overleaf: ${entry.path}`);
        return 'downloaded';
    }

    private async materializeRemoteSubtree(path: string): Promise<void> {
        const entries = [...this.fileTree.values()]
            .filter(entry => entry.path === path || (path.endsWith('/') && entry.path.startsWith(path)))
            .sort((left, right) => {
                if (left.type === 'folder' && right.type !== 'folder') return -1;
                if (left.type !== 'folder' && right.type === 'folder') return 1;
                return left.path.length - right.path.length;
            });
        for (const entry of entries) {
            await this.materializeRemoteEntry(entry);
        }
    }

    // === Local change handlers ===

    /**
     * Handle local file change
     */
    private async handleLocalFileChange(uri: vscode.Uri): Promise<void> {
        if (this.disposed) return;
        const relativePath = this.getRelativePath(uri);
        if (!this.shouldSync(relativePath)) return;
        if (!(await this.acquireLockWhenAvailable(relativePath))) return;

        try {
            await this.assertNoSymbolicLinks(uri);
            const kind = await vscode.workspace.fs.stat(uri);
            if ((kind.type & vscode.FileType.Directory) !== 0) return;
            if (this.hasDirtyDocument(uri)) return; // Upload saved revisions only.
            // Read file content - may throw if file was deleted between watcher event and now
            let content: Uint8Array;
            try {
                content = await this.readLocalFile(uri);
            } catch (readError) {
                // File was deleted between watcher event and read - this is normal during rapid operations
                if (isFileNotFoundError(readError)) {
                    debugLog(`File no longer exists (race condition): ${relativePath}`);
                    return;
                }
                throw readError;
            }

            if (!this.shouldPropagate(relativePath, content)) return;

            const entry = this.fileTreeByPath.get(relativePath);
            if (!entry) {
                debugLog(`File not in remote tree: ${relativePath}`);
                return;
            }

            this.setStatus('pushing', `Uploading ${relativePath}`, relativePath);

            // For documents, we need to use OT updates
            // For binary files, we upload directly
            if (entry.type === 'doc') {
                if (!this.socket) {
                    throw new Error(`Cannot update ${relativePath}: real-time connection is unavailable`);
                }
                const result = await this.pushDocumentChanges(entry.id, relativePath, content, false);
                if (!result) return;
                content = result.content;
                if (result.pushed) {
                    this.log(`Pushed to Overleaf: ${relativePath}`);
                }
            } else {
                const remote = await this.getRemoteEntryContent(entry);
                if (!contentEquals(remote, content)
                    && hashContent(remote) !== this.getBaseHashes().get(relativePath)) {
                    const choice = await this.askConflictResolution(relativePath, uri, remote);
                    if (choice === 'skip' || !contentEquals(await this.readLocalFile(uri), content)) return;
                    if (choice === 'useRemote') {
                        await vscode.workspace.fs.writeFile(uri, remote);
                        this.recordSynchronizedContent(entry, remote);
                        this.setStatus('idle');
                        return;
                    }
                    if (!contentEquals(await this.getRemoteEntryContent(entry), remote)) return;
                }
                await this.replaceRemoteFile(entry, content);
                this.log(`Replaced on Overleaf: ${relativePath}`);
            }

            this.recordSynchronizedContent(entry, content);
            this.setStatus('idle');
        } catch (error) {
            // Don't show error for file-not-found during rapid operations
            if (isFileNotFoundError(error)) {
                debugLog(`File disappeared during sync: ${relativePath}`);
                this.setStatus('idle');
                return;
            }
            console.error(`[LocalLeaf] Failed to sync ${relativePath}:`, error);
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Failed to sync: ${error}`, relativePath, authErr);
            if (!authErr && (this.socket?.isConnected === false
                || this.stateStore?.entries.get(relativePath)?.intent?.kind === 'write')) this.scheduleAutomaticRecovery();
        } finally {
            this.releaseLock(relativePath);
        }
    }

    /**
     * Push document changes using OT
     * Automatic saves compare the common base before replacing remote content.
     * Explicit conflict choices and newly created documents may replace it.
     */
    private async pushDocumentChanges(
        docId: string,
        path: string,
        newContent: Uint8Array,
        allowOverwrite = true,
    ): Promise<{ content: Uint8Array; pushed: boolean } | undefined> {
        if (!this.socket) throw new Error(`Cannot update ${path}: real-time connection is unavailable`);

        try {
            const pendingEntry = this.fileTree.get(docId);
            if (pendingEntry && this.stateStore?.entries.get(path)?.intent?.kind === 'write') {
                await this.recoverDocumentIntent(pendingEntry);
                return undefined;
            }
            const originalContent = newContent;
            let snapshot = await this.readRemoteDocument(docId);
            const base = this.baseContent.get(path);
            if (!allowOverwrite && !contentEquals(snapshot.content, newContent)
                && !(base !== undefined && base !== SYNCHRONIZED_CONTENT_MARKER
                    ? contentEquals(snapshot.content, base)
                    : hashContent(snapshot.content) === this.getBaseHashes().get(path))) {
                const localUri = this.settings.getFilePath(path);
                const merged = await this.mergeDocument(path, newContent, snapshot.content);
                const resolution = merged ? 'merged'
                    : await this.askConflictResolution(path, localUri, snapshot.content);
                this.throwIfDisposed();
                if (resolution === 'skip') {
                    this.setStatus('idle', `Kept conflicting local changes for ${path}`, path);
                    return undefined;
                }
                if (!contentEquals(await this.readLocalFile(localUri), newContent)
                    || this.hasDirtyDocument(localUri)) {
                    this.setStatus('idle', `Local content changed while resolving ${path}; sync again`, path);
                    return undefined;
                }
                if (resolution === 'useRemote') {
                    await this.assertNoSymbolicLinks(localUri);
                    this.throwIfDisposed();
                    await vscode.workspace.fs.writeFile(localUri, snapshot.content);
                    return { content: snapshot.content, pushed: false };
                }
                if (merged) newContent = merged;
                // Do not silently overwrite edits made while the prompt was open.
                const latest = await this.readRemoteDocument(docId);
                if (!contentEquals(latest.content, snapshot.content) && !merged) {
                    throw new Error(`Remote content changed while resolving ${path}; sync again.`);
                }
                // Auto-merge is based on snapshot.v. The server transforms this
                // operation against edits that arrived since that version.
                if (!merged) snapshot = latest;
            }
            if (this.requiresFileUpload(newContent)) {
                const entry = this.fileTree.get(docId);
                if (!entry || entry.type !== 'doc' || entry.path !== path) {
                    throw new Error(`Cannot upload ${path}: the document identity changed`);
                }
                if (this.project?.rootDoc_id === docId) {
                    throw new Error(`Cannot upload ${path}: the main document exceeds Overleaf's editable-document limit`);
                }
                await this.replaceRemoteFile(entry, newContent);
                const replacement = this.fileTreeByPath.get(path)!;
                // Callers must record the uploaded entity's type and identity.
                Object.assign(entry, replacement);
                this.log(`Uploaded large text file: ${path} (${newContent.byteLength} bytes)`);
                return { content: newContent, pushed: true };
            }
            const { version } = snapshot;
            if (version === undefined) {
                throw new Error(`Cannot update ${path}: no authoritative document version is available`);
            }
            const remoteContent = new TextDecoder().decode(snapshot.content);
            const localContent = new TextDecoder().decode(newContent);
            if (localContent.length > MAX_REMOTE_DOCUMENT_CHARACTERS) {
                throw new Error(`Cannot upload ${path}: document exceeds the synchronization size limit`);
            }

            // Calculate diff and create OT operations
            const ops = this.calculateOps(remoteContent, localContent);

            if (ops.length > 0) {
                const update: DocumentUpdate = {
                    doc: docId,
                    op: ops,
                    v: version,
                };
                const entry = this.fileTree.get(docId)!;
                if (this.stateStore) {
                    const previous = this.stateStore.entries.get(path);
                    this.stateStore.put({ ...previous, path, id: docId, type: 'doc',
                        intent: { kind: 'write', before: Buffer.from(snapshot.content).toString('base64'),
                            desired: Buffer.from(newContent).toString('base64'),
                            local: Buffer.from(originalContent).toString('base64'), version,
                            sources: this.socket.publicId ? [this.socket.publicId] : [] } });
                    await this.stateStore.flush(); // Durable intent precedes the network mutation.
                }
                this.suppressRemoteDocumentUpdate(update);
                try {
                    await this.socket.applyOtUpdate(docId, update);
                } catch (error) {
                    this.consumeSuppressedRemoteDocumentUpdate(update);
                    // A lost confirmation is not evidence that the operation
                    // failed. Read the committed state; never resend the old OT.
                    if (!this.socket.isConnected) throw error;
                    const observed = await this.readRemoteDocument(docId);
                    if (observed.version === undefined || observed.version <= version
                        || !contentEquals(observed.content, newContent)) throw error;
                    this.log(`Recovered a lost update confirmation for ${path}`);
                }

                // applyOtUpdate waits for the applied event, not just the queue
                // acknowledgement. Re-read because the server may transform an
                // operation against concurrent edits from another client.
                const applied = await this.readRemoteDocument(docId);
                const journal = this.stateStore?.entries.get(path);
                if (journal?.intent?.kind === 'write') {
                    this.stateStore!.put({ ...journal, intent: { ...journal.intent, confirmed: true } });
                    await this.stateStore!.flush();
                }
                const localUri = this.settings.getFilePath(path);
                const current = await this.readLocalFileIfExists(localUri);
                if (!current || this.hasDirtyDocument(localUri)) return undefined;
                if (current && !this.hasDirtyDocument(localUri)) {
                    const pending = contentEquals(current, originalContent)
                        ? { clean: true as const, content: applied.content }
                        : await mergeText(originalContent, current, applied.content);
                    if (!pending.clean) {
                        // Keep the previous ancestor and durable intent for a
                        // genuinely overlapping save made during the upload.
                        await this.askConflictResolution(path, localUri, applied.content);
                        return undefined;
                    }
                    if (contentEquals(await this.readLocalFile(localUri), current) && !this.hasDirtyDocument(localUri)) {
                        if (!contentEquals(current, pending.content)) await vscode.workspace.fs.writeFile(localUri, pending.content);
                        this.recordSynchronizedContent(entry, applied.content);
                        if (!contentEquals(pending.content, applied.content)) {
                            this.scheduleOperation(() => this.handleLocalFileChange(localUri));
                        }
                    } else {
                        return undefined; // Keep the journal for the newer disk/editor revision.
                    }
                }
                return { content: applied.content, pushed: true };
            }

            // Keep doc joined for watching even if no changes
            this.joinedDocs.add(docId);
            if (!contentEquals(originalContent, snapshot.content)) {
                const localUri = this.settings.getFilePath(path);
                if (!contentEquals(await this.readLocalFileIfExists(localUri), originalContent)
                    || this.hasDirtyDocument(localUri)) return undefined;
                await vscode.workspace.fs.writeFile(localUri, snapshot.content);
            }
            return { content: snapshot.content, pushed: false };
        } catch (error) {
            console.error(`[LocalLeaf] OT update failed for ${path}:`, error);
            throw error;
        }
    }

    private async mergeDocument(path: string, local: Uint8Array, remote: Uint8Array): Promise<Uint8Array | undefined> {
        if (!/\.(tex|bib|md|sty|cls)$/i.test(path)) return undefined;
        const saved = this.baseContent.get(path);
        const base = saved === SYNCHRONIZED_CONTENT_MARKER ? undefined : saved;
        const result = await mergeText(base, local, remote);
        this.throwIfDisposed();
        if (!result.clean) {
            this.log(`Automatic merge deferred for ${path}: ${result.reason}`);
            return undefined;
        }
        this.log(`Automatically merged independent edits in ${path}`);
        return result.content;
    }

    /** Replay only the journaled operation, with Overleaf's original-source deduplication. */
    private async recoverDocumentIntent(entry: FileTreeEntry, rebaseAttempts = 0): Promise<void> {
        const saved = this.stateStore?.entries.get(entry.path);
        if (saved?.intent?.kind !== 'write') return;
        const intent = { ...saved.intent, sources: [...saved.intent.sources] };
        if (entry.id !== saved.id || !this.socket?.isConnected) {
            throw new Error(`Cannot recover pending write for ${entry.path}: remote identity or connection changed`);
        }
        let snapshot = await this.readRemoteDocument(entry.id);
        const desired = Buffer.from(intent.desired, 'base64');
        if (!intent.confirmed && !(snapshot.version !== undefined && snapshot.version > intent.version
            && contentEquals(snapshot.content, desired))) {
            if (!intent.sources.length || intent.sources.length >= 32) {
                throw new Error(`Pending write for ${entry.path} needs review: no safe duplicate identifier`);
            }
            const previousSources = [...intent.sources];
            if (this.socket.publicId && !intent.sources.includes(this.socket.publicId)) intent.sources.push(this.socket.publicId);
            this.stateStore!.put({ ...saved, intent: { ...intent } });
            await this.stateStore!.flush();
            try {
                await this.socket.applyOtUpdate(entry.id, { doc: entry.id, v: intent.version,
                    op: this.calculateOps(Buffer.from(intent.before, 'base64').toString('utf8'), desired.toString('utf8')),
                    dupIfSource: previousSources });
            } catch (error) {
                if (!/Op too old/i.test(errorMessage(error))) throw error;
                // The server explicitly rejected the obsolete operation. Rebase
                // its intent against a fresh snapshot instead of retrying it forever.
                snapshot = await this.readRemoteDocument(entry.id);
                if (rebaseAttempts >= 3) throw new Error(`Remote edits are changing too quickly to recover ${entry.path}; retrying later`);
                const combined = await mergeText(Buffer.from(intent.before, 'base64'), desired, snapshot.content);
                if (snapshot.version === undefined) throw error;
                let next = combined.clean ? combined.content : undefined;
                let offeredLocal: Uint8Array | undefined;
                if (!next) {
                    const uri = this.settings.getFilePath(entry.path);
                    offeredLocal = await this.readLocalFile(uri);
                    const choice = await this.askConflictResolution(entry.path, uri, snapshot.content);
                    if (choice === 'skip') return;
                    if (this.hasDirtyDocument(uri) || !contentEquals(await this.readLocalFile(uri), offeredLocal)) return;
                    next = choice === 'useRemote' ? snapshot.content : offeredLocal;
                }
                this.stateStore!.put({ ...saved, intent: { ...intent,
                    before: Buffer.from(snapshot.content).toString('base64'), desired: Buffer.from(next).toString('base64'),
                    local: offeredLocal ? Buffer.from(offeredLocal).toString('base64') : intent.local,
                    version: snapshot.version, sources: this.socket.publicId ? [this.socket.publicId] : [],
                    confirmed: contentEquals(next, snapshot.content) } });
                await this.stateStore!.flush();
                return this.recoverDocumentIntent(entry, rebaseAttempts + 1);
            }
            snapshot = await this.readRemoteDocument(entry.id);
        }
        this.stateStore!.put({ ...saved, intent: { ...intent, confirmed: true } });
        await this.stateStore!.flush();
        const uri = this.settings.getFilePath(entry.path);
        const local = await this.readLocalFileIfExists(uri);
        const editor = this.getOpenTextDocument(uri);
        if (editor?.isDirty) {
            const revision = editor.version;
            const draft = this.getOpenDocumentContent(editor);
            const combined = await mergeText(Buffer.from(intent.local, 'base64'), draft, snapshot.content);
            if (combined.clean) await this.applyRemoteContentToOpenDocument(editor, revision, combined.content);
            else await this.askConflictResolution(entry.path, uri, snapshot.content);
            return;
        }
        if (!local) return;
        let merged = await mergeText(Buffer.from(intent.local, 'base64'), local, snapshot.content);
        if (!merged.clean) {
            const choice = await this.askConflictResolution(entry.path, uri, snapshot.content);
            if (choice === 'skip') return;
            if (!contentEquals(await this.readLocalFileIfExists(uri), local) || this.hasDirtyDocument(uri)) return;
            const latest = await this.readRemoteDocument(entry.id);
            if (!contentEquals(latest.content, snapshot.content)) return;
            if (choice === 'useLocal') {
                this.stateStore!.put({ ...saved, intent: undefined });
                await this.stateStore!.flush();
                const result = await this.pushDocumentChanges(entry.id, entry.path, local, true);
                if (result) this.recordSynchronizedContent(entry, result.content);
                return;
            }
            merged = { clean: true, content: snapshot.content };
        }
        if (!contentEquals(await this.readLocalFileIfExists(uri), local) || this.hasDirtyDocument(uri)) return;
        if (!contentEquals(local, merged.content)) await vscode.workspace.fs.writeFile(uri, merged.content);
        this.recordSynchronizedContent(entry, snapshot.content);
        await this.stateStore!.flush();
        if (!contentEquals(merged.content, snapshot.content)) this.scheduleOperation(() => this.handleLocalFileChange(uri));
        this.log(`Recovered pending document write without duplication: ${entry.path}`);
    }

    private async reconcileIndependentChanges(entry: FileTreeEntry, local: Uint8Array, remote: Uint8Array): Promise<boolean> {
        if (entry.type !== 'doc') return false;
        const merged = await this.mergeDocument(entry.path, local, remote);
        if (!merged || !this.automaticSyncEnabled) return false;
        const uri = this.settings.getFilePath(entry.path);
        const editor = this.getOpenTextDocument(uri);
        if (editor?.isDirty) {
            if (!contentEquals(this.getOpenDocumentContent(editor), local)) return true;
            const result = await this.applyRemoteContentToOpenDocument(editor, editor.version, merged);
            if (result !== 'failed' && result !== 'stale') this.pendingConflicts?.delete(entry.path);
            return true; // The merged draft stays unsaved and is not uploaded.
        }
        if (!contentEquals(await this.readLocalFileIfExists(uri), local)) return true;
        const result = await this.pushDocumentChanges(entry.id, entry.path, local, false);
        if (result) this.recordSynchronizedContent(entry, result.content);
        return true;
    }

    /**
     * Calculate granular OT updates with UTF-16 offsets and a bounded diff budget.
     */
    private calculateOps(oldText: string, newText: string): Array<{ p: number; i?: string; d?: string }> {
        return textOperations(oldText, newText);
    }

    private hasDirtyDocument(uri: vscode.Uri): boolean {
        return vscode.workspace.textDocuments.some(document =>
            document.uri.toString() === uri.toString() && document.isDirty
        );
    }

    private refreshProjectFileTree(targetPath = '/'): Promise<void> {
        const previous = this.activeProjectRefresh;
        // Each caller must install its own scope. Sharing only the first
        // caller's refresh would lose a concurrent lookup for another path.
        const operation = previous
            ? previous.catch(() => undefined).then(() => this.performProjectTreeRefresh(targetPath))
            : this.performProjectTreeRefresh(targetPath);
        this.activeProjectRefresh = operation;
        void operation.then(
            () => { if (this.activeProjectRefresh === operation) this.activeProjectRefresh = undefined; },
            () => { if (this.activeProjectRefresh === operation) this.activeProjectRefresh = undefined; },
        );
        return operation;
    }

    private async performProjectTreeRefresh(targetPath: string): Promise<void> {
        const projectSettings = this.settings.getSettings()!;
        const result = await this.api.getProjectDetails(projectSettings.projectId);
        this.throwIfDisposed();
        ensureApiSuccess(result, 'Refresh project file tree');

        if (!result.projectData?.rootFolder) {
            if (this.socket?.isConnected && this.socket.refreshProject) {
                // The primary transport is unchanged: retain every queued
                // event, including events needed after a failed snapshot.
                const refreshedProject = await this.socket.refreshProject();
                this.throwIfDisposed();
                this.buildFileTree(refreshedProject, targetPath);
                this.project = refreshedProject;
                await this.removeObsoleteDocumentSubscriptions();
                if (targetPath === '/') await this.reconcileRecordedStructure();
                return;
            }
            // Some self-hosted Overleaf versions expose the project tree only
            // through Socket.IO, not in the project page metadata. In that
            // case the live tree built during connect (and maintained by
            // socket events) is still authoritative enough for operations
            // such as cleaning ignored remote files. Do not discard it just
            // because the optional HTTP refresh is unavailable.
            if (this.socket?.isConnected && this.fileTree.size > 0 && this.fileTreeByPath.size > 0) {
                debugLog('HTTP project tree refresh unavailable; keeping the live project tree');
                return;
            }
            if (this.socket && !this.socket.isConnected) {
                throw new Error('The real-time connection was lost. Retry sync to reconnect and refresh the project.');
            }
            throw new Error('Refresh project file tree: Overleaf returned no folder tree');
        }

        const refreshedProject = {
            ...(this.project || {}),
            _id: result.projectData.projectId || projectSettings.projectId,
            name: result.projectData.projectName || this.project?.name || 'Unknown',
            rootDoc_id: result.projectData.rootDocId || this.project?.rootDoc_id,
            rootFolder: result.projectData.rootFolder,
        } as ProjectEntity;
        this.buildFileTree(refreshedProject, targetPath);
        this.project = refreshedProject;
        await this.removeObsoleteDocumentSubscriptions();
        if (targetPath === '/') await this.reconcileRecordedStructure();
    }

    private async removeObsoleteDocumentSubscriptions(): Promise<void> {
        for (const id of this.documentSnapshots.keys()) {
            if (!this.fileTree.has(id)) this.deleteDocumentSnapshot(id);
        }
        for (const id of this.joinedDocs) {
            if (!this.fileTree.has(id)) {
                await this.socket?.leaveDoc(id);
                this.joinedDocs.delete(id);
            }
        }
    }

    private trackUploadedEntity(
        result: { file?: FileEntity; doc?: FileEntity },
        parentId: string,
        name: string,
        path: string
    ): FileTreeEntry | undefined {
        const entity = result.doc || result.file;
        if (!entity?._id) {
            return undefined;
        }
        const entityId = validateOverleafId(entity._id, 'uploaded entity ID');
        const type = result.doc ? 'doc' : 'file';
        if (entity._type !== type || (result.doc && result.file)) {
            throw new Error(`Overleaf returned an invalid uploaded entity type for ${path}`);
        }
        const existing = this.fileTree.get(entityId);
        if (existing) {
            if (existing.path !== path || existing.type !== type) {
                throw new Error(`Overleaf reused uploaded entity ID: ${entityId}`);
            }
            return existing;
        }
        const existingAtPath = this.fileTreeByPath.get(path);
        if (existingAtPath && existingAtPath.id !== entityId) {
            throw new Error(`Overleaf returned a duplicate uploaded entity path: ${path}`);
        }

        const entry: FileTreeEntry = {
            id: entityId,
            type,
            name,
            path,
            parentId,
        };
        this.fileTree.set(entityId, entry);
        this.fileTreeByPath.set(path, entry);
        debugLog('Tracked uploaded file:', path, entry.id);
        return entry;
    }

    private async resolveUploadedFile(
        result: { file?: FileEntity; doc?: FileEntity },
        parentId: string,
        name: string,
        path: string,
    ): Promise<FileTreeEntry> {
        let entry = this.trackUploadedEntity(result, parentId, name, path);
        if (!entry) {
            await this.refreshProjectFileTree(path);
            entry = this.fileTreeByPath.get(path);
        }
        if (!entry || (entry.type !== 'file' && entry.type !== 'doc')) {
            throw new Error(`Upload ${path}: the uploaded file identity could not be verified`);
        }
        return entry;
    }

    private async runPendingLocalCreate<T>(
        path: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        this.pendingLocalCreates.add(path);
        try {
            return await operation();
        } finally {
            this.pendingLocalCreates.delete(path);
        }
    }

    private async createTextDocumentWithContent(
        projectId: string,
        parentId: string,
        relativePath: string,
        name: string,
        content: Uint8Array
    ): Promise<Uint8Array> {
        return this.runPendingLocalCreate(relativePath, async () => {
            const result = await this.api.addDoc(projectId, parentId, name);
            ensureApiSuccess(result, `Create ${relativePath}`);

            let entry: FileTreeEntry | undefined;
            if (result.doc?._id) {
                const docId = validateOverleafId(result.doc._id, 'document ID');
                const existing = this.fileTree.get(docId);
                if (existing && (existing.path !== relativePath || existing.type !== 'doc')) {
                    throw new Error(`Overleaf reused document ID: ${docId}`);
                }
                entry = existing || {
                    id: docId,
                    type: 'doc',
                    name,
                    path: relativePath,
                    parentId,
                };
                this.fileTree.set(docId, entry);
                this.fileTreeByPath.set(relativePath, entry);
            } else {
                await this.refreshProjectFileTree(relativePath);
                entry = this.fileTreeByPath.get(relativePath);
            }

            if (!entry || entry.type !== 'doc') {
                throw new Error(`Create ${relativePath}: new document was not returned by Overleaf`);
            }
            if (!this.socket) {
                throw new Error(
                    `Create ${relativePath}: real-time connection is required to write document content`
                );
            }

            const pushed = await this.pushDocumentChanges(entry.id, relativePath, content);
            if (!pushed) throw new Error(`Create ${relativePath}: document content was not uploaded`);
            this.recordSynchronizedContent(entry, pushed.content);
            return pushed.content;
        });
    }

    private async deleteRemoteEntry(entry: FileTreeEntry, preserveLocal = false): Promise<void> {
        const projectSettings = this.settings.getSettings()!;
        if (preserveLocal) {
            this.suppressRemoteDelete(entry.id);
        }

        const result = await this.api.deleteEntity(projectSettings.projectId, entry.type, entry.id);
        try {
            ensureApiSuccess(result, `Delete ${entry.path}`);
        } catch (error) {
            this.suppressedRemoteDeletes.delete(entry.id);
            throw error;
        }

        this.fileTree.delete(entry.id);
        this.joinedDocs.delete(entry.id);
        this.deleteDocumentSnapshot(entry.id);
        this.clearSuppressedDocumentUpdates(entry.id);
        this.suppressedRemoteRenames.delete(entry.id);
        if (this.fileTreeByPath.get(entry.path)?.id === entry.id) {
            this.fileTreeByPath.delete(entry.path);
        }
        if (!preserveLocal) {
            this.deleteBaseContent(entry.path);
            this.fileCache.delete(entry.path);
        }
        if (entry.id === this.project?.rootDoc_id) {
            await this.handleRootDocumentUpdated('');
        }
    }

    private async renameRemoteEntry(entry: FileTreeEntry, name: string, action: string): Promise<void> {
        const projectSettings = this.settings.getSettings()!;
        this.suppressRemoteRename(entry.id, name);
        try {
            const result = await this.api.renameEntity(
                projectSettings.projectId,
                entry.type,
                entry.id,
                name
            );
            ensureApiSuccess(result, action);
        } catch (error) {
            this.consumeSuppressedRemoteRename(entry.id, name);
            throw error;
        }
    }

    private async replaceRemoteFile(entry: FileTreeEntry, content: Uint8Array): Promise<void> {
        if (!entry.parentId) {
            throw new Error(`Replace ${entry.path}: parent folder is unknown`);
        }

        const projectSettings = this.settings.getSettings()!;
        const originalPath = entry.path;
        const originalName = entry.name;
        const opaqueIdHash = createHash('sha256').update(entry.id).digest('hex').slice(0, 12);
        const suffix = `.localleaf-${opaqueIdHash}-${Date.now().toString(36)}`;
        const temporaryName = `${originalName.slice(0, Math.max(1, 150 - suffix.length))}${suffix}`;
        const parentPath = originalPath.slice(0, originalPath.lastIndexOf('/') + 1);
        const temporaryPath = joinProjectPath(parentPath, temporaryName, false);
        if (this.fileTreeByPath.has(temporaryPath)) {
            throw new Error(`Replace ${originalPath}: temporary backup path already exists`);
        }

        let backupEntry = entry;
        let renamedOriginal = false;
        let uploadedReplacement = false;

        if (this.stateStore) {
            this.stateStore.put({ ...this.stateStore.entries.get(originalPath),
                path: originalPath, id: entry.id, type: entry.type,
                intent: { kind: 'replace', desiredHash: hashContent(content), backupPath: temporaryPath } });
            await this.stateStore.flush();
        }

        // Retain the last common content and hash until the replacement is
        // confirmed. A failed rename/upload must remain safely retryable.
        try {
            // Overleaf rejects duplicate names. Move the original aside first,
            // then keep it as a rollback copy until the replacement is tracked.
            await this.renameRemoteEntry(
                entry,
                temporaryName,
                `Prepare replacement for ${originalPath}`
            );
            renamedOriginal = true;

            // Reflect the successful rename before starting the upload. A fast
            // socket create event for the replacement must see the original
            // path as available instead of reporting a false collision.
            backupEntry = { ...entry, name: temporaryName, path: temporaryPath };
            if (this.fileTreeByPath.get(originalPath)?.id === entry.id) {
                this.fileTreeByPath.delete(originalPath);
            }
            this.fileTree.set(entry.id, backupEntry);
            this.fileTreeByPath.set(temporaryPath, backupEntry);

            const result = await this.api.uploadFile(
                projectSettings.projectId,
                entry.parentId,
                originalName,
                content
            );
            ensureApiSuccess(result, `Upload ${originalPath}`);
            uploadedReplacement = true;

            const replacementEntry = await this.resolveUploadedFile(
                result,
                entry.parentId,
                originalName,
                originalPath,
            );
            if (replacementEntry.id === entry.id) {
                throw new Error(
                    `Upload ${originalPath}: the replacement identity could not be verified`
                );
            }

            const originalEntry = this.fileTree.get(entry.id) || backupEntry;
            await this.deleteRemoteEntry(originalEntry, true);
            Object.assign(entry, replacementEntry);
        } catch (error) {
            if (renamedOriginal && !uploadedReplacement) {
                try {
                    await this.renameRemoteEntry(
                        backupEntry,
                        originalName,
                        `Restore ${originalPath} after failed replacement`
                    );
                    if (this.fileTreeByPath.get(temporaryPath)?.id === entry.id) {
                        this.fileTreeByPath.delete(temporaryPath);
                    }
                    this.fileTree.set(entry.id, entry);
                    this.fileTreeByPath.set(originalPath, entry);
                } catch (restoreError) {
                    const replacementMessage = error instanceof Error ? error.message : String(error);
                    const restoreMessage = restoreError instanceof Error
                        ? restoreError.message
                        : String(restoreError);
                    throw new Error(
                        `${replacementMessage}; the original file remains on Overleaf under ` +
                        `${temporaryName} because restoring its name failed: ${restoreMessage}`
                    );
                }
            }

            const message = error instanceof Error ? error.message : String(error);
            if (uploadedReplacement) {
                throw new Error(
                    `${message}; the replacement was uploaded, but its backup was kept as ${temporaryName}`
                );
            }
            throw error;
        }
    }

    /**
     * Handle local file creation
     */
    private async handleLocalFileCreate(uri: vscode.Uri): Promise<void> {
        if (this.disposed) return;
        const relativePath = this.getRelativePath(uri);
        if (!this.shouldSync(relativePath)) return;
        if (!(await this.acquireLockWhenAvailable(relativePath))) return;

        try {
            // Stat the file - may throw if file was deleted between watcher event and now
            let stat: vscode.FileStat;
            try {
                await this.assertNoSymbolicLinks(uri);
                stat = await vscode.workspace.fs.stat(uri);
            } catch (statError) {
                if (isFileNotFoundError(statError)) {
                    debugLog(`File no longer exists (race condition): ${relativePath}`);
                    return;
                }
                throw statError;
            }

            const trackedPath = (stat.type & vscode.FileType.Directory) !== 0
                ? relativePath + '/'
                : relativePath;
            // Watcher URIs omit the trailing slash required by directory-only
            // ignore rules. Recheck after stat, before creating any parents.
            if (!this.shouldSync(trackedPath)) return;
            if (this.fileTreeByPath.has(trackedPath)) {
                // A create event can be the local echo of a remote write or an
                // editor's atomic replacement of an existing file. Folders
                // already exist remotely; files are re-evaluated as changes.
                if ((stat.type & vscode.FileType.Directory) === 0) {
                    this.scheduleOperation(() => this.handleLocalFileChange(uri));
                }
                return;
            }

            const projectSettings = this.settings.getSettings()!;

            this.setStatus('pushing', `Creating ${relativePath}`, relativePath);

            // Ensure parent folders exist (creates them if needed)
            const parentId = await this.ensureParentFoldersExist(relativePath);
            const name = relativePath.split('/').pop()!;

            if ((stat.type & vscode.FileType.Directory) !== 0) {
                const folderPath = relativePath + '/';
                await this.runPendingLocalCreate(folderPath, async () => {
                    const result = await this.api.addFolder(projectSettings.projectId, parentId, name);
                    ensureApiSuccess(result, `Create folder ${folderPath}`);

                    // Add the folder immediately when possible; otherwise
                    // recover its canonical identity from the server tree.
                    if (result.folder) {
                        const folderId = validateOverleafId(result.folder._id, 'folder ID');
                        const existing = this.fileTree.get(folderId);
                        if (existing && (existing.path !== folderPath || existing.type !== 'folder')) {
                            throw new Error(`Overleaf reused folder ID: ${folderId}`);
                        }
                        const folderEntry: FileTreeEntry = existing || {
                            id: folderId,
                            type: 'folder',
                            name,
                            path: folderPath,
                            parentId,
                        };
                        this.fileTree.set(folderId, folderEntry);
                        this.fileTreeByPath.set(folderPath, folderEntry);
                        debugLog('Added folder to tree:', folderPath, result.folder._id);
                    } else {
                        await this.refreshProjectFileTree(folderPath);
                    }
                    if (this.fileTreeByPath.get(folderPath)?.type !== 'folder') {
                        throw new Error(`Create folder ${folderPath}: Overleaf returned no folder identity`);
                    }
                    this.setBaseContent(folderPath, SYNCHRONIZED_CONTENT_MARKER);
                });

                this.log(`Created folder on Overleaf: ${folderPath}`);
            } else {
                // Read file content - may throw if file was deleted
                let content: Uint8Array;
                try {
                    content = await this.readLocalFile(uri);
                } catch (readError) {
                    if (isFileNotFoundError(readError)) {
                        debugLog(`File no longer exists (race condition): ${relativePath}`);
                        return;
                    }
                    throw readError;
                }

                const isTextFile = this.isTextFile(name) && !this.requiresFileUpload(content);

                if (isTextFile) {
                    content = await this.createTextDocumentWithContent(
                        projectSettings.projectId,
                        parentId,
                        relativePath,
                        name,
                        content
                    );
                } else {
                    await this.runPendingLocalCreate(relativePath, async () => {
                        const result = await this.api.uploadFile(
                            projectSettings.projectId,
                            parentId,
                            name,
                            content
                        );
                        ensureApiSuccess(result, `Upload ${relativePath}`);
                        const entry = await this.resolveUploadedFile(result, parentId, name, relativePath);
                        this.recordSynchronizedContent(entry, content);
                    });
                }
            }

            this.setStatus('idle');
        } catch (error) {
            // Don't show error for file-not-found during rapid operations
            if (isFileNotFoundError(error)) {
                debugLog(`File disappeared during create: ${relativePath}`);
                this.setStatus('idle');
                return;
            }
            console.error(`[LocalLeaf] Failed to create ${relativePath}:`, error);
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Failed to create: ${error}`, relativePath, authErr);
        } finally {
            this.releaseLock(relativePath);
        }
    }

    /**
     * Handle local file deletion
     */
    private async handleLocalFileDelete(uri: vscode.Uri): Promise<void> {
        if (this.disposed) return;
        const relativePath = this.getRelativePath(uri);
        if (!this.shouldSync(relativePath)) return;
        // A remote rename/deletion also emits a local deletion. Once its
        // ancestor is removed there is no authorized local deletion to send,
        // and refreshing the whole project would only reconnect needlessly.
        if (!this.baseContent.has(relativePath) && !this.baseContent.has(relativePath + '/')) return;
        if (!(await this.acquireLockWhenAvailable(relativePath))) return;

        try {
            await this.assertNoSymbolicLinks(uri);
            // A deleted path can already be recreated by an atomic save.
            if (await this.localFileExists(uri)) return;
            // Try both file path and folder path (with trailing slash)
            let entry = this.fileTreeByPath.get(relativePath);
            let pathToUse = relativePath;
            if (!entry) {
                // Maybe it's a folder - try with trailing slash
                const folderPath = relativePath + '/';
                entry = this.fileTreeByPath.get(folderPath);
                if (entry) {
                    pathToUse = folderPath;
                }
            }
            if (!entry) {
                // Socket events can be missed while reconnecting. Refresh the
                // server tree before deciding there is nothing to delete.
                await this.refreshProjectFileTree(relativePath);
                entry = this.fileTreeByPath.get(relativePath);
                if (!entry) {
                    const folderPath = relativePath + '/';
                    entry = this.fileTreeByPath.get(folderPath);
                    if (entry) {
                        pathToUse = folderPath;
                    }
                }
            }
            if (!entry || !this.shouldSync(pathToUse)) return;
            const savedIdentity = this.stateStore?.entries.get(pathToUse)?.id;
            if (savedIdentity !== undefined && savedIdentity !== entry.id) return;

            // Only delete from Overleaf if the file was previously synced locally.
            // If baseContent doesn't have this path, the file was never downloaded/synced,
            // so we should NOT propagate this deletion to Overleaf (prevents deleting
            // new upstream files that haven't been pulled yet).
            if (!this.baseContent.has(pathToUse)) {
                debugLog(`Ignoring delete for never-synced file: ${pathToUse}`);
                return;
            }

            this.setStatus('pushing', `Deleting ${pathToUse}`, pathToUse);
            if (this.stateStore) {
                const previous = this.stateStore.entries.get(pathToUse);
                this.stateStore.put({ ...previous, path: pathToUse, id: entry.id, type: entry.type,
                    intent: { kind: 'delete' } });
                await this.stateStore.flush();
            }
            await this.assertRemoteDeletionUnchanged(entry);
            await this.deleteRemoteEntry(entry, true);
            this.removeTrackedSubtree(pathToUse);

            this.log(`Deleted from Overleaf: ${pathToUse}`);
            this.setStatus('idle');
        } catch (error) {
            console.error(`[LocalLeaf] Failed to delete ${relativePath}:`, error);
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Failed to delete: ${error}`, relativePath, authErr);
        } finally {
            this.releaseLock(relativePath);
        }
    }

    // === Remote change handlers ===

    private async assertRemoteDeletionUnchanged(entry: FileTreeEntry): Promise<void> {
        const children = entry.type === 'folder' ? [...this.fileTree.values()].filter(child =>
            child.type !== 'folder' && child.path.startsWith(entry.path)) : [entry];
        for (const child of children) {
            const expected = this.getBaseHashes().get(child.path);
            const current = await this.getRemoteEntryContent(child);
            if (!expected || hashContent(current) !== expected) {
                throw new Error(`Remote changes preserved at ${child.path}; deletion needs review`);
            }
        }
    }

    private async recoverDeletionIntents(): Promise<void> {
        for (const saved of [...this.stateStore?.entries.values() ?? []]) {
            if (saved.intent?.kind !== 'delete' || !this.shouldSync(saved.path)) continue;
            const entry = this.fileTreeByPath.get(saved.path);
            if (!entry) { this.deleteBaseContent(saved.path); continue; }
            if (entry.id !== saved.id) {
                this.setStatus('error', `Remote identity changed at ${saved.path}; deletion needs review`, saved.path);
                continue;
            }
            if (await this.localFileExists(this.settings.getFilePath(saved.path))) {
                this.stateStore!.put({ ...saved, intent: undefined });
                continue;
            }
            try {
                await this.assertRemoteDeletionUnchanged(entry);
                await this.deleteRemoteEntry(entry, true);
                this.removeTrackedSubtree(saved.path);
                this.log(`Recovered local deletion: ${saved.path}`);
            } catch (error) {
                this.setStatus('error', errorMessage(error), saved.path);
            }
        }
    }

    /** Recover rename/move events missed while this workspace was closed. */
    private async reconcileRecordedStructure(): Promise<void> {
        const savedEntries = [...this.stateStore?.entries.values() ?? []].sort((a, b) => a.path.length - b.path.length);
        for (const saved of savedEntries) {
            if (!this.stateStore?.entries.has(saved.path)) continue;
            const current = this.fileTree.get(saved.id);
            if (!current || current.path === saved.path || current.type !== saved.type || saved.intent) continue;
            if (!this.shouldSync(saved.path) || !this.shouldSync(current.path)) continue;
            const before = this.settings.getFilePath(saved.path);
            const after = this.settings.getFilePath(current.path);
            if (!await this.localFileExists(before)) continue;
            if (await this.localFileExists(after)) {
                this.setStatus('error', `Remote move to ${current.path} collides with a local path`, saved.path);
                continue;
            }
            await this.assertNoSymbolicLinks(before);
            await this.assertNoSymbolicLinks(after);
            const parent = current.path.replace(/\/$/, '').slice(0, current.path.replace(/\/$/, '').lastIndexOf('/') + 1);
            if (parent !== '/') await vscode.workspace.fs.createDirectory(this.settings.getFilePath(parent));
            await this.renameLocalPath(saved.path, before, after);
            const records = [...this.stateStore.entries.values()].filter(record => record.path === saved.path
                || (saved.type === 'folder' && record.path.startsWith(saved.path)));
            this.rebaseTrackedPathMap(this.baseContent, saved.path, current.path);
            this.rebaseTrackedPathMap(this.getBaseHashes(), saved.path, current.path);
            this.rebaseTrackedPathMap(this.fileCache, saved.path, current.path);
            for (const record of records) {
                this.stateStore.put({ ...record, path: current.path + record.path.slice(saved.path.length) });
                this.stateStore.delete(record.path);
            }
            this.log(`Recovered remote move: ${saved.path} to ${current.path}`);
        }
    }

    private async recoverReplacementIntents(): Promise<void> {
        for (const saved of [...this.stateStore?.entries.values() ?? []]) {
            if (saved.intent?.kind !== 'replace' || !this.shouldSync(saved.path)) continue;
            const intent = saved.intent;
            const original = this.fileTree.get(saved.id);
            const replacement = this.fileTreeByPath.get(saved.path);
            if (original?.path === saved.path) {
                this.stateStore!.put({ ...saved, intent: undefined });
                continue;
            }
            if (replacement && replacement.id !== saved.id) {
                const content = await this.getRemoteEntryContent(replacement);
                if (hashContent(content) !== intent.desiredHash) {
                    throw new Error(`Replacement at ${saved.path} changed remotely; both copies are preserved`);
                }
                if (original) {
                    const backupContent = await this.getRemoteEntryContent(original);
                    if (original.path !== intent.backupPath || hashContent(backupContent) !== saved.hash) {
                        throw new Error(`Backup for ${saved.path} changed remotely; both copies are preserved`);
                    }
                    await this.deleteRemoteEntry(original, true);
                }
                this.recordSynchronizedContent(replacement, content);
                this.log(`Recovered verified attachment replacement: ${saved.path}`);
                continue;
            }
            if (!replacement && original?.path === intent.backupPath) {
                const name = saved.path.slice(saved.path.lastIndexOf('/') + 1);
                await this.renameRemoteEntry(original, name, `Recover interrupted replacement ${saved.path}`);
                this.fileTreeByPath.delete(original.path);
                original.name = name;
                original.path = saved.path;
                this.fileTreeByPath.set(saved.path, original);
                this.stateStore!.put({ ...saved, intent: undefined });
                this.log(`Restored interrupted attachment replacement: ${saved.path}`);
                continue;
            }
            throw new Error(`Cannot identify interrupted replacement ${saved.path}; local content is preserved`);
        }
    }

    /**
     * Handle remote file created
     */
    private async handleRemoteFileCreated(parentId: string, type: 'doc' | 'file' | 'folder', entity: FileEntity, isCurrent = () => true): Promise<void> {
        const safeParentId = validateOverleafId(parentId, 'parent folder ID');
        const entityId = validateOverleafId(entity?._id, 'entity ID');
        const existingEntity = this.fileTree.get(entityId);
        if (existingEntity?.type === type && (existingEntity.parentId !== safeParentId || existingEntity.name !== entity.name)) {
            // An authoritative snapshot can already include a later rename
            // or move. The older creation notification must not undo it.
            return;
        }
        const parent = this.fileTree.get(safeParentId);
        if (!parent || parent.type !== 'folder') {
            throw new Error(`Overleaf created an entity under an unknown folder: ${safeParentId}`);
        }
        const path = joinProjectPath(parent.path, entity.name, type === 'folder');

        const entry: FileTreeEntry = {
            id: entityId,
            type,
            name: entity.name,
            path,
            parentId: safeParentId,
        };
        const trackEntry = (): FileTreeEntry => {
            const existingById = this.fileTree.get(entityId);
            const existingByPath = this.fileTreeByPath.get(path);
            if (existingById && existingById.path !== path) {
                throw new Error(`Overleaf reused entity ID ${entityId} for a different path.`);
            }
            if (existingByPath && existingByPath.id !== entityId) {
                throw new Error(`Overleaf created a duplicate entity path: ${path}`);
            }
            if (existingById && existingById.type !== type) {
                throw new Error(`Overleaf reused entity ID ${entityId} with a different type.`);
            }
            const tracked = existingById || entry;
            this.fileTree.set(entityId, tracked);
            this.fileTreeByPath.set(path, tracked);
            return tracked;
        };

        // Local uploads hold the path lock while the server acknowledges the
        // new entity, so record that acknowledgement immediately. A bulk
        // operation owns '/', however, and must finish its tree snapshot first.
        let trackedEntry = this.syncLock?.has('/') ? undefined : trackEntry();
        if (!this.shouldSync(path) && trackedEntry) return;
        if (!(await this.acquireLockWhenAvailable(path))) return;
        let ownsLock = true;

        try {
            if (!isCurrent()) return;
            const currentParent = this.fileTree.get(safeParentId);
            const currentEntry = this.fileTree.get(entityId);
            if (!currentParent || currentParent.type !== 'folder') return;
            const currentPath = currentEntry?.path ?? joinProjectPath(currentParent.path, entity.name, type === 'folder');
            if (currentPath !== path) {
                this.releaseLock(path);
                ownsLock = false;
                await this.handleRemoteFileCreated(safeParentId, type, entity, isCurrent);
                return;
            }
            trackedEntry = trackEntry();
            if (!this.shouldSync(path)) return;
            this.setStatus('pulling', `Downloading ${path}`, path);

            // Check if this is an echo of our own creation (file already in baseContent)
            const alreadySynced = this.baseContent.has(path);
            if (alreadySynced || this.pendingLocalCreates.has(path)) {
                debugLog(`Ignoring remote create echo for already-synced: ${path}`);
                this.setStatus('idle');
                return;
            }

            const result = await this.materializeRemoteEntry(trackedEntry);
            if (result === 'skipped') {
                debugLog(`Skipped new remote file (user choice): ${path}`);
                this.log(`Skipped new file from Overleaf: ${path}`);
            }

            this.setStatus('idle');
        } catch (error) {
            console.error(`[LocalLeaf] Failed to sync remote create ${path}:`, error);
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Failed to download ${path}: ${error}`, path, authErr);
        } finally {
            if (ownsLock) this.releaseLock(path);
        }
    }

    /**
     * Handle remote file renamed
     */
    private async handleRemoteFileRenamed(entityId: string, newName: string, isCurrent = () => true): Promise<void> {
        entityId = validateOverleafId(entityId, 'entity ID');
        if (this.consumeSuppressedRemoteRename(entityId, newName)) {
            return;
        }

        const entry = await this.acquireRemoteEntryLock(entityId, isCurrent);
        if (!entry) return;
        const oldPath = entry.path;
        try {
            if (entry.path === '/') {
                throw new Error('Refusing to rename the Overleaf project root.');
            }

            const pathWithoutTrailingSlash = entry.type === 'folder' ? oldPath.slice(0, -1) : oldPath;
            const parentPath = pathWithoutTrailingSlash.substring(
                0,
                pathWithoutTrailingSlash.lastIndexOf('/') + 1,
            );
            const newPath = joinProjectPath(parentPath, newName, entry.type === 'folder');
            if (newPath === oldPath) return;
            this.assertRemotePathTransitionAvailable(oldPath, newPath);
            const syncedBefore = this.shouldSync(oldPath);
            const syncedAfter = this.shouldSync(newPath);

            if (!isCurrent()) return;
            this.setStatus('pulling', `Renaming ${oldPath} to ${newPath}`, oldPath);

            const oldUri = this.settings.getFilePath(oldPath);
            const newUri = this.settings.getFilePath(newPath);
            await this.assertNoSymbolicLinks(oldUri);
            await this.assertNoSymbolicLinks(newUri);
            this.throwIfDisposed();
            if (syncedBefore) {
                try {
                    if (syncedAfter) {
                        await this.renameLocalPath(oldPath, oldUri, newUri);
                    } else {
                        await this.deleteTrackedLocalEntry(entry);
                        this.removeTrackedContent(oldPath);
                    }
                } catch (error) {
                    if (!isFileNotFoundError(error)) throw error;
                }
            }

            // Rebase the folder and every descendant only after the local
            // operation succeeds, so the in-memory tree cannot get ahead of disk.
            entry.name = validateProjectEntityName(newName);
            this.rebaseFileTree(oldPath, newPath);
            if (!syncedBefore && syncedAfter) {
                await this.materializeRemoteSubtree(newPath);
            }
            if (entry.id === this.project?.rootDoc_id) await this.detectMainDocument();

            this.setStatus('idle');
        } catch (error) {
            console.error(`[LocalLeaf] Failed to sync remote rename:`, error);
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Failed to rename ${oldPath}: ${error}`, oldPath, authErr);
        } finally {
            this.releaseLock(oldPath);
        }
    }

    /** Delete tracked copies individually, preserving newer local changes. */
    private async deleteTrackedLocalEntry(entry: FileTreeEntry): Promise<'deleted' | 'preserved'> {
        const tracked = this.getTrackedSubtreeEntries(entry.path, true);
        const files: Array<{ path: string; uri: vscode.Uri; hash: string; modified: boolean }> = [];
        const directories: Array<{ path: string; uri: vscode.Uri }> = [];
        let preserved = false;
        for (const candidate of tracked) {
            this.throwIfDisposed();
            if (!this.shouldSync(candidate.path)) { preserved = true; continue; }
            const uri = this.settings.getFilePath(candidate.path);
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if ((stat.type & vscode.FileType.SymbolicLink) !== 0) { preserved = true; continue; }
                await this.assertNoSymbolicLinks(uri);
                if (candidate.type === 'folder') {
                    directories.push({ path: candidate.path, uri });
                    continue;
                }
                if (this.hasDirtyDocument(uri)) { preserved = true; continue; }
                const content = await this.readLocalFile(uri);
                const hash = hashContent(content);
                const base = this.baseContent.get(candidate.path);
                const baseHash = this.getBaseHashes().get(candidate.path)
                    ?? (base && base !== SYNCHRONIZED_CONTENT_MARKER ? hashContent(base) : undefined)
                    ?? this.fileCache.get(candidate.path);
                files.push({ path: candidate.path, uri, hash, modified: hash !== baseHash });
            } catch (error) {
                if (!isFileNotFoundError(error)) throw error;
            }
        }
        const modified = files.filter(file => file.modified);
        if (modified.length > 0) {
            this.requestBackgroundChoice(`removed:${entry.id}`, () => vscode.window.showWarningMessage(
                `Overleaf removed "${entry.path}" from synchronization. ${modified.length} local file(s) have unsynchronized changes.`,
                'Keep Local Changes', 'Delete Modified Copies',
            ), async choice => {
                if (choice !== 'Delete Modified Copies') return;
                for (const file of modified) {
                    if (this.fileTreeByPath.has(file.path) || this.hasDirtyDocument(file.uri)) continue;
                    await this.assertNoSymbolicLinks(file.uri);
                    const current = await this.readLocalFileIfExists(file.uri);
                    if (hashContent(current) === file.hash) await this.deleteLocalPath(file.path, file.uri, false);
                }
            });
        }
        this.throwIfDisposed();
        for (const file of files) {
            if (file.modified) { preserved = true; continue; }
            try {
                const current = await this.readLocalFile(file.uri);
                if (hashContent(current) !== file.hash || this.hasDirtyDocument(file.uri)) {
                    preserved = true;
                    continue;
                }
                this.throwIfDisposed();
                const outcome = await this.deleteLocalPath(file.path, file.uri, false);
                preserved ||= outcome === 'preserved';
            } catch (error) {
                if (!isFileNotFoundError(error)) throw error;
            }
        }
        for (const directory of directories.sort((a, b) => b.path.length - a.path.length)) {
            await this.assertNoSymbolicLinks(directory.uri);
            try {
                if ((await vscode.workspace.fs.readDirectory(directory.uri)).length > 0) {
                    preserved = true;
                    continue;
                }
                this.throwIfDisposed();
                const outcome = await this.deleteLocalPath(directory.path, directory.uri, false);
                preserved ||= outcome === 'preserved';
            } catch (error) {
                if (!isFileNotFoundError(error)) throw error;
            }
        }
        if (preserved) {
            this.log(`Kept local content after remote removal: ${entry.path}`);
            void vscode.window.showInformationMessage(`LocalLeaf: Kept local changes or excluded files in "${entry.path}".`);
        }
        return preserved ? 'preserved' : 'deleted';
    }


    /**
     * Handle remote file removed
     */
    private async handleRemoteFileRemoved(entityId: string, isCurrent = () => true): Promise<void> {
        entityId = validateOverleafId(entityId, 'entity ID');
        if (this.suppressedRemoteDeletes.delete(entityId)) {
            const suppressedEntry = this.fileTree.get(entityId);
            if (suppressedEntry) {
                if (suppressedEntry.type === 'folder') {
                    this.removeTrackedSubtree(suppressedEntry.path);
                } else {
                    this.fileTree.delete(entityId);
                    if (this.fileTreeByPath.get(suppressedEntry.path)?.id === entityId) {
                        this.fileTreeByPath.delete(suppressedEntry.path);
                    }
                }
            }
            return;
        }

        const entry = await this.acquireRemoteEntryLock(entityId, isCurrent, true);
        if (!entry) return;
        try {
            if (entry.path === '/') {
                throw new Error('Refusing to delete the Overleaf project root.');
            }

            if (!this.shouldSync(entry.path)) {
                this.removeTrackedSubtree(entry.path);
                return;
            }
            if (!isCurrent()) return;
            this.setStatus('pulling', `Deleting ${entry.path}`, entry.path);

            const removedEntries = this.getTrackedSubtreeEntries(entry.path, true);

            // Delete local content first. If this fails, keep the remote tree
            // and joined-document state intact so a later pull can retry.
            await this.deleteTrackedLocalEntry(entry);

            for (const removedEntry of removedEntries) {
                if (removedEntry.type === 'doc' && this.joinedDocs.has(removedEntry.id)) {
                    try {
                        await this.socket?.leaveDoc(removedEntry.id);
                    } catch {
                        // Ignore leave errors
                    }
                }
            }

            this.removeTrackedSubtree(entry.path);
            if (entry.id === this.project?.rootDoc_id) {
                await this.handleRootDocumentUpdated('');
            }

            this.setStatus('idle');
        } catch (error) {
            console.error(`[LocalLeaf] Failed to sync remote delete:`, error);
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Failed to delete ${entry.path}: ${error}`, entry.path, authErr);
        } finally {
            this.releaseLock(entry.path);
        }
    }

    /**
     * Handle remote file moved
     */
    private async handleRemoteFileMoved(entityId: string, newParentId: string, isCurrent = () => true): Promise<void> {
        entityId = validateOverleafId(entityId, 'entity ID');
        newParentId = validateOverleafId(newParentId, 'parent folder ID');
        const entry = await this.acquireRemoteEntryLock(entityId, isCurrent);
        if (!entry) return;
        const oldPath = entry.path;
        try {
            const newParent = this.fileTree.get(newParentId);
            if (!newParent || newParent.type !== 'folder') return;
            if (entry.path === '/') {
                throw new Error('Refusing to move the Overleaf project root.');
            }

            const newPath = joinProjectPath(newParent.path, entry.name, entry.type === 'folder');
            if (newPath === oldPath) return;
            this.assertRemotePathTransitionAvailable(oldPath, newPath);
            const syncedBefore = this.shouldSync(oldPath);
            const syncedAfter = this.shouldSync(newPath);

            if (!isCurrent()) return;
            this.setStatus('pulling', `Moving ${oldPath} to ${newPath}`, oldPath);

            const oldUri = this.settings.getFilePath(oldPath);
            const newUri = this.settings.getFilePath(newPath);
            await this.assertNoSymbolicLinks(oldUri);
            await this.assertNoSymbolicLinks(newUri);
            this.throwIfDisposed();
            if (syncedBefore) {
                try {
                    if (syncedAfter) {
                        await this.renameLocalPath(oldPath, oldUri, newUri);
                    } else {
                        await this.deleteTrackedLocalEntry(entry);
                        this.removeTrackedContent(oldPath);
                    }
                } catch (error) {
                    if (!isFileNotFoundError(error)) throw error;
                }
            }

            this.rebaseFileTree(oldPath, newPath);
            entry.parentId = newParentId;
            if (!syncedBefore && syncedAfter) {
                await this.materializeRemoteSubtree(newPath);
            }
            if (entry.id === this.project?.rootDoc_id) await this.detectMainDocument();

            this.setStatus('idle');
        } catch (error) {
            console.error(`[LocalLeaf] Failed to sync remote move:`, error);
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Failed to move ${oldPath}: ${error}`, oldPath, authErr);
        } finally {
            this.releaseLock(oldPath);
        }
    }

    /**
     * Handle remote file content changed (OT update)
     */
    private async handleRemoteFileChanged(update: DocumentUpdate, isCurrent = () => true): Promise<void> {
        validateOverleafId(update?.doc, 'document ID');
        if (
            update.op !== undefined
            && (!Array.isArray(update.op) || update.op.length > MAX_REMOTE_DOCUMENT_OPERATIONS)
        ) {
            throw new Error('Overleaf returned an invalid document update.');
        }
        const isOwnUpdate = this.socket?.publicId !== undefined && update.meta?.source === this.socket.publicId;
        const wasSuppressed = this.consumeSuppressedRemoteDocumentUpdate(update);
        if (isOwnUpdate) {
            return;
        }
        if (wasSuppressed) return;
        const entry = await this.acquireRemoteEntryLock(update.doc, isCurrent);
        if (!entry) return;
        try {
            if (entry.type !== 'doc' || !this.shouldSync(entry.path)) return;
            if (!isCurrent()) return;
            const snapshot = this.documentSnapshots.get(update.doc);
            if (snapshot?.version !== undefined && Number.isSafeInteger(update.v)
                && update.v < snapshot.version) {
                return; // This operation is already included in our snapshot.
            }
            // Get current local content
            const localUri = this.settings.getFilePath(entry.path);
            await this.assertNoSymbolicLinks(localUri);
            let diskBytes: Uint8Array | undefined;
            try {
                diskBytes = await this.readLocalFile(localUri);
            } catch (error) {
                if (!isFileNotFoundError(error)) throw error;
                diskBytes = undefined;
            }

            const openDocument = this.getOpenTextDocument(localUri);
            const openDocumentVersion = openDocument?.version;
            if (diskBytes === undefined && !openDocument?.isDirty && this.deferKnownLocalDeletion(entry, localUri)) return;
            const localBytes = openDocument?.isDirty
                ? this.getOpenDocumentContent(openDocument)
                : diskBytes;

            const baseBytes = this.baseContent.get(entry.path);
            const hasRetainedBase = baseBytes !== undefined
                && baseBytes !== SYNCHRONIZED_CONTENT_MARKER;
            const retainedBaseHash = this.getBaseHashes().get(entry.path);
            let contentBytes: Uint8Array | undefined;

            // Apply operations to the last known server state, never directly to
            // an unsynchronized local edit. If the state is unavailable or the
            // operation does not match it, recover from the authoritative copy.
            if (snapshot?.version !== undefined && snapshot.version === update.v && update.op !== undefined) {
                try {
                    let newContent = new TextDecoder().decode(snapshot.content);
                    if (newContent.length > MAX_REMOTE_DOCUMENT_CHARACTERS) {
                        throw new Error('Overleaf document exceeds the synchronization size limit.');
                    }
                    for (const op of update.op || []) {
                        if (!Number.isSafeInteger(op.p) || op.p < 0 || op.p > newContent.length) {
                            throw new Error(`Invalid Overleaf document operation position: ${op.p}`);
                        }
                        if (op.d !== undefined) {
                            if (
                                typeof op.d !== 'string'
                                || op.p + op.d.length > newContent.length
                                || newContent.slice(op.p, op.p + op.d.length) !== op.d
                            ) {
                                throw new Error('Overleaf document delete operation did not match the known content.');
                            }
                            newContent = newContent.slice(0, op.p) + newContent.slice(op.p + op.d.length);
                        }
                        if (op.i !== undefined) {
                            if (
                                typeof op.i !== 'string'
                                || newContent.length + op.i.length > MAX_REMOTE_DOCUMENT_CHARACTERS
                            ) {
                                throw new Error('Invalid or oversized Overleaf document insert operation.');
                            }
                            newContent = newContent.slice(0, op.p) + op.i + newContent.slice(op.p);
                        }
                    }
                    contentBytes = new TextEncoder().encode(newContent);
                    this.setDocumentSnapshot(update.doc, { content: contentBytes, version: update.v + 1 });
                } catch (operationError) {
                    debugLog(`Recovering ${entry.path} after an unusable OT update:`, operationError);
                }
            }

            if (!contentBytes) {
                // Missing/out-of-order versions and HTTP snapshots must be
                // recovered, even when the operation's offsets look plausible.
                contentBytes = (await this.readRemoteDocument(entry.id)).content;
            }

            const hasUnsynchronizedLocalChanges = localBytes !== undefined
                && !contentEquals(localBytes, contentBytes)
                && (hasRetainedBase
                    ? !contentEquals(localBytes, baseBytes)
                    : retainedBaseHash !== undefined
                        ? hashContent(localBytes) !== retainedBaseHash
                        : true);
            const remoteUnchanged = retainedBaseHash !== undefined
                && hashContent(contentBytes) === retainedBaseHash;
            if (hasUnsynchronizedLocalChanges && remoteUnchanged) {
                // A periodic rejoin may find no remote change while the user is
                // editing. Leave the draft to the normal save/upload watcher.
                this.pendingConflicts?.delete(entry.path);
                return;
            }
            if (hasUnsynchronizedLocalChanges) {
                if (await this.reconcileIndependentChanges(entry, localBytes!, contentBytes)) {
                    this.setStatus('idle');
                    return;
                }
                const resolution = await this.askConflictResolution(entry.path, localUri, contentBytes);
                this.throwIfDisposed();
                if (resolution === 'skip') {
                    // The remote snapshot advanced, but the common local/server
                    // base did not. A later local save must still see this conflict.
                    this.setStatus('idle', `Skipped conflicting remote update for ${entry.path}`, entry.path);
                    return;
                }
                if (resolution === 'useLocal') {
                    if (!this.socket) {
                        throw new Error(`Cannot update ${entry.path}: real-time connection is unavailable`);
                    }

                    const latestOpenDocument = this.getOpenTextDocument(localUri);
                    let latestLocalBytes = latestOpenDocument?.isDirty
                        ? this.getOpenDocumentContent(latestOpenDocument)
                        : undefined;
                    if (!latestLocalBytes) {
                        try {
                            latestLocalBytes = await this.readLocalFile(localUri);
                        } catch (error) {
                            if (!isFileNotFoundError(error)) throw error;
                            latestLocalBytes = localBytes;
                        }
                    }

                    const result = await this.pushDocumentChanges(entry.id, entry.path, latestLocalBytes!);
                    if (!result) return;
                    this.recordSynchronizedContent(entry, result.content);
                    this.setStatus('idle');
                    return;
                }
            }

            // Recheck the same editor or disk revision shown in the conflict prompt.
            let currentBytes: Uint8Array | undefined;
            try {
                const currentDocument = this.getOpenTextDocument(localUri);
                currentBytes = currentDocument?.isDirty
                    ? this.getOpenDocumentContent(currentDocument)
                    : await this.readLocalFile(localUri);
            } catch (error) {
                if (!isFileNotFoundError(error)) throw error;
            }
            if (!contentEquals(localBytes, currentBytes)) {
                this.setStatus('idle', `Kept newer local changes for ${entry.path}`, entry.path);
                return;
            }

            // Only write if content actually changed (prevents file flashing)
            if (!contentEquals(localBytes, contentBytes)) {
                this.setStatus('pulling', `Updating ${entry.path}`, entry.path);
                this.throwIfDisposed();

                const currentOpenDocument = this.getOpenTextDocument(localUri);
                if (currentOpenDocument) {
                    if (
                        openDocumentVersion === undefined
                        || currentOpenDocument.version !== openDocumentVersion
                    ) {
                        this.keepLocalDocumentAfterRemoteUpdate(
                            entry.path,
                            `Kept newer editor changes; retry synchronization for ${entry.path}`,
                        );
                        return;
                    }

                    if (currentOpenDocument.isDirty) {
                        const result = await this.applyRemoteContentToOpenDocument(
                            currentOpenDocument,
                            openDocumentVersion,
                            contentBytes,
                        );
                        this.throwIfDisposed();
                        if (result === 'stale' || result === 'failed') {
                            this.keepLocalDocumentAfterRemoteUpdate(
                                entry.path,
                                `Kept newer editor changes; retry synchronization for ${entry.path}`,
                            );
                            return;
                        }
                    } else {
                        await vscode.workspace.fs.writeFile(localUri, contentBytes);
                    }
                } else {
                    let latestDiskBytes: Uint8Array | undefined;
                    try {
                        latestDiskBytes = await this.readLocalFile(localUri);
                    } catch (error) {
                        if (!isFileNotFoundError(error)) throw error;
                        latestDiskBytes = undefined;
                    }
                    if (!contentEquals(latestDiskBytes, diskBytes)) {
                        this.keepLocalDocumentAfterRemoteUpdate(
                            entry.path,
                            `Kept newer local changes; retry synchronization for ${entry.path}`,
                        );
                        return;
                    }
                    await vscode.workspace.fs.writeFile(localUri, contentBytes);
                }
                this.log(`Remote update: ${entry.path}`);
            }

            this.recordSynchronizedContent(entry, contentBytes);

            this.setStatus('idle');
        } catch (error) {
            console.error(`[LocalLeaf] Failed to apply OT update:`, error);
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Failed to update ${entry.path}: ${error}`, entry.path, authErr);
        } finally {
            this.releaseLock(entry.path);
        }
    }

    /**
     * Join all documents to receive real-time OT updates
     */
    async joinAllDocsForWatching(): Promise<void> {
        if (!this.socket) return;

        let joinedCount = 0;
        let failureCount = 0;
        const failedPaths: string[] = [];
        for (const [id, entry] of this.fileTree) {
            if (entry.type === 'doc' && !this.joinedDocs.has(id)) {
                if (!this.shouldSync(entry.path)) continue;
                if (!(await this.acquireLockWhenAvailable(entry.path))) return;
                try {
                    if (this.joinedDocs.has(id)) continue;
                    await this.readRemoteDocument(id);
                    if (this.joinedDocs.has(id)) joinedCount++;
                    else throw new Error('Real-time document subscription is unavailable.');
                } catch (error) {
                    if (isAuthError(error)) {
                        this.setStatus('error', 'Session expired', entry.path, true);
                        throw error;
                    }
                    failureCount++;
                    if (failedPaths.length < 3) failedPaths.push(entry.path);
                    debugLog(`Unable to watch ${entry.path}:`, error);
                    if (this.socket.isConnected === false) break;
                } finally {
                    this.releaseLock(entry.path);
                }
            }
        }
        if (joinedCount > 0) {
            this.log(`Watching ${joinedCount} documents for remote changes`);
        }
        if (failureCount > 0) {
            const preview = failedPaths.join(', ');
            const message = `Unable to watch ${failureCount} document(s) for live updates: ${preview}`;
            this.log(message);
            this.setStatus('error', message);
            throw new Error(message);
        }
    }

    // === Public methods ===

    /**
     * Check if local file exists
     */
    private async localFileExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch (error) {
            if (isFileNotFoundError(error)) return false;
            throw error;
        }
    }

    private async readLocalFileIfExists(localUri: vscode.Uri): Promise<Uint8Array | undefined> {
        try {
            return await this.readLocalFile(localUri);
        } catch (error) {
            if (isFileNotFoundError(error)) return undefined;
            throw error;
        }
    }

    /** A missing synchronized copy is a local deletion, not a fresh download. */
    private deferKnownLocalDeletion(entry: FileTreeEntry, localUri: vscode.Uri): boolean {
        if (!this.baseContent.has(entry.path)) return false;
        const saved = this.stateStore?.entries.get(entry.path);
        if (saved && saved.id !== entry.id) return false; // A restored remote entity is new.
        this.scheduleOperation(async () => {
            if (this.automaticSyncEnabled && !this.hasDirtyDocument(localUri)) {
                await this.handleLocalFileDelete(localUri);
            }
        });
        return true;
    }

    private setRemoteDiffContent(uri: vscode.Uri, content: string): void {
        if (!Number.isSafeInteger(this.remoteDiffCharacters) || this.remoteDiffCharacters < 0) {
            this.remoteDiffCharacters = [...this.remoteDiffContents.values()].reduce(
                (total, value) => total + value.length,
                0,
            );
        }

        const key = uri.toString();
        const previous = this.remoteDiffContents.get(key);
        if (previous !== undefined) this.remoteDiffCharacters -= previous.length;
        this.remoteDiffContents.delete(key);

        const maximum = this.maxRemoteDiffCharacters ?? MAX_REMOTE_DIFF_CHARACTERS;
        if (!Number.isSafeInteger(maximum) || maximum < 0 || content.length > maximum) {
            throw new Error('Remote diff content exceeds the LocalLeaf memory limit.');
        }

        while (this.remoteDiffCharacters + content.length > maximum) {
            const oldest = this.remoteDiffContents.entries().next().value as
                | [string, string]
                | undefined;
            if (!oldest) break;
            this.remoteDiffContents.delete(oldest[0]);
            this.remoteDiffCharacters -= oldest[1].length;
        }

        this.remoteDiffContents.set(key, content);
        this.remoteDiffCharacters += content.length;
    }

    /**
     * Show diff between local and remote file
     */
    private async showDiff(filePath: string, localUri: vscode.Uri, remoteContent: Uint8Array): Promise<void> {
        const remoteUri = vscode.Uri.from({ scheme: 'localleaf-remote', path: filePath });
        if (!this.remoteDiffChangeEmitter) {
            const emitter = new vscode.EventEmitter<vscode.Uri>();
            const provider: vscode.TextDocumentContentProvider = {
                onDidChange: emitter.event,
                provideTextDocumentContent: uri => this.remoteDiffContents.get(uri.toString()) || '',
            };
            this.remoteDiffChangeEmitter = emitter;
            this.disposables.push(
                emitter,
                vscode.workspace.registerTextDocumentContentProvider('localleaf-remote', provider),
            );
        }

        this.setRemoteDiffContent(remoteUri, new TextDecoder().decode(remoteContent));
        this.remoteDiffChangeEmitter.fire(remoteUri);

        await vscode.commands.executeCommand('vscode.diff',
                localUri,
                remoteUri,
                `${filePath} (Local ↔ Remote)`
        );
    }

    /**
     * Ask user how to resolve conflict
     */
    private async askConflictResolution(filePath: string, localUri: vscode.Uri, remoteContent: Uint8Array): Promise<'useRemote' | 'useLocal' | 'skip'> {
        const entry = this.fileTreeByPath.get(filePath);
        if (!entry || this.disposed) return 'skip';
        const document = this.getOpenTextDocument(localUri);
        const local = document ? this.getOpenDocumentContent(document) : await this.readLocalFileIfExists(localUri);
        const localHash = hashContent(local);
        const remoteHash = hashContent(remoteContent);
        const pending = this.pendingConflicts.get(filePath);
        if (pending?.entityId === entry.id && pending.localHash === localHash && pending.remoteHash === remoteHash) {
            return pending.choice ?? 'skip';
        }
        // Only hashes are retained: waiting notifications must not hold remote
        // byte buffers, the workspace lock, or the remote-event queue.
        this.pendingConflicts.set(filePath, { entityId: entry.id, localHash, remoteHash });
        this.log(`Conflict needs a choice: ${filePath}; continuing other synchronization`);
        this.offerNextConflict();
        return 'skip';
    }

    private offerNextConflict(): void {
        if (this.disposed || this.conflictPromptActive) return;
        const next = [...this.pendingConflicts].find(([, pending]) => pending.choice === undefined);
        if (!next) return;
        const [filePath, pending] = next;
        this.conflictPromptActive = true;
        void (async () => {
            let choice = await vscode.window.showWarningMessage(
                `Conflict: "${filePath}". Other files continue syncing.`,
                'Diff', 'Remote', 'Local', 'All Remote', 'All Local',
            );
            if (this.disposed || this.pendingConflicts.get(filePath) !== pending) return;
            if (choice === 'Diff') {
                const entry = this.fileTreeByPath.get(filePath);
                if (!entry || entry.id !== pending.entityId) return;
                // Previewing must not advance the OT snapshot: it has not been
                // applied locally, and doing so could suppress a queued update.
                let content: Uint8Array;
                if (entry.type === 'doc') {
                    const result = await this.api.getDocContent(this.project!._id, entry.id);
                    ensureApiSuccess(result, 'Preview conflict');
                    if (!result.lines) throw new Error('No remote document content');
                    content = this.encodeDocument(result.lines);
                } else {
                    content = await this.getRemoteEntryContent(entry);
                }
                if (this.disposed || hashContent(content) !== pending.remoteHash) return;
                await this.showDiff(filePath, this.settings.getFilePath(filePath), content);
                const result = await this.askConflictResolutionAfterDiff(filePath);
                choice = result === 'useRemote' ? 'Remote' : result === 'useLocal' ? 'Local' : undefined;
            }
            if (this.disposed || this.pendingConflicts.get(filePath) !== pending) return;
            pending.choice = choice === 'Remote' || choice === 'All Remote' ? 'useRemote'
                : choice === 'Local' || choice === 'All Local' ? 'useLocal' : 'skip';
            if (choice === 'All Remote' || choice === 'All Local') {
                // Approval applies only to the exact copies already inspected.
                for (const conflict of this.pendingConflicts.values()) conflict.choice = pending.choice;
            }
            if (pending.choice !== 'skip') {
                this.scheduleOperation(async () => {
                    // A choice can arrive before the original pull finishes.
                    // Revisit the file afterwards instead of sharing that pull.
                    await this.activePull?.catch(() => undefined);
                    if (this.disposed) return;
                    await this.pullAll(false);
                    await this.joinAllDocsForWatching();
                });
            }
        })().catch(error => {
            pending.choice = 'skip';
            this.log(`Conflict resolution failed for ${filePath}: ${errorMessage(error)}`);
        }).finally(() => {
            // An invalidated choice must be reviewed against the next snapshot.
            if (this.pendingConflicts.get(filePath) === pending && pending.choice === undefined) pending.choice = 'skip';
            this.conflictPromptActive = false;
            this.offerNextConflict();
        });
    }

    /**
     * Ask after viewing diff
     */
    private async askConflictResolutionAfterDiff(filePath: string): Promise<'useRemote' | 'useLocal' | 'skip'> {
        this.setStatus(
            'error',
            `Conflict needs your choice; other files continue syncing: ${filePath}`,
            filePath,
        );
        const result = await vscode.window.showWarningMessage(
            `After reviewing diff for "${filePath}", what would you like to do?`,
            { modal: false },
            'Use Remote',
            'Keep Local',
            'Skip'
        );

        switch (result) {
            case 'Use Remote':
                return 'useRemote';
            case 'Keep Local':
                return 'useLocal';
            default:
                return 'skip';
        }
    }

    /**
     * Handle local files that were deleted on Overleaf.
     * These are files that exist locally, were previously synced (in baseContent),
     * but no longer exist on Overleaf.
     */
    private async handleOrphanedLocalFiles(orphanedPaths: string[]): Promise<void> {
        if (orphanedPaths.length === 0) return;

        const fileList = orphanedPaths.length <= 5
            ? orphanedPaths.join(', ')
            : `${orphanedPaths.slice(0, 5).join(', ')}... and ${orphanedPaths.length - 5} more`;

        const originalHashes = new Map<string, string>();
        for (const path of orphanedPaths) {
            const uri = this.settings.getFilePath(path);
            await this.assertNoSymbolicLinks(uri);
            originalHashes.set(path, hashContent(await this.readLocalFileIfExists(uri)));
        }
        this.requestBackgroundChoice('orphaned-files', () => vscode.window.showWarningMessage(
            `${orphanedPaths.length} file(s) were deleted on Overleaf but exist locally: ${fileList}`,
            { modal: false },
            'Delete Locally',
            'Keep Locally',
            'Re-upload'
        ), async choice => {
            if (choice === 'Delete Locally') {
                this.throwIfDisposed();
                for (const path of orphanedPaths) {
                    if (this.disposed) break;
                    try {
                        if (this.fileTreeByPath.has(path) || !this.shouldSync(path)) continue;
                        const localUri = this.settings.getFilePath(path);
                        await this.assertNoSymbolicLinks(localUri);
                        if (hashContent(await this.readLocalFileIfExists(localUri)) !== originalHashes.get(path)) continue;
                        const outcome = await this.deleteLocalPath(path, localUri, false);
                        this.deleteBaseContent(path);
                        this.fileCache.delete(path);
                        if (outcome === 'preserved') {
                            this.reportPreservedRemoteDeletion(path);
                        } else {
                            this.log(`Deleted local file (removed from Overleaf): ${path}`);
                        }
                    } catch (error) {
                        console.error(`[LocalLeaf] Failed to delete local file: ${path}`, error);
                        this.setStatus('error', `Cannot delete ${path}: ${errorMessage(error)}`, path, isAuthError(error));
                    }
                }
            } else if (choice === 'Re-upload') {
                this.throwIfDisposed();
                for (const path of orphanedPaths) {
                    if (this.disposed) break;
                    try {
                        if (this.fileTreeByPath.has(path) || !this.shouldSync(path)) continue;
                        await this.uploadLocalFile(path);
                        this.log(`Re-uploaded to Overleaf: ${path}`);
                    } catch (error) {
                        console.error(`[LocalLeaf] Failed to re-upload: ${path}`, error);
                        this.setStatus('error', `Cannot upload ${path}: ${errorMessage(error)}`, path, isAuthError(error));
                    }
                }
            } else if (choice === 'Keep Locally') {
                // Keep Locally - clear from baseContent so it's not tracked as synced
                for (const path of orphanedPaths) {
                    if (!this.fileTreeByPath.has(path)) this.deleteBaseContent(path);
                    debugLog(`Keeping local file, removed from sync tracking: ${path}`);
                }
                // The same reviewed copies are now local-only. Keeping them
                // locally must not immediately lead to an Upload All prompt.
                this.reviewedBackgroundChoices?.set('local-only-files', this.localChoiceFingerprint(originalHashes));
            }
        }, this.localChoiceFingerprint(originalHashes));
    }

    /**
     * Handle files that exist only locally (not on Overleaf, never synced).
     * These could be new files the user wants to upload or files to ignore.
     */
    private async handleLocalOnlyFiles(localOnlyPaths: string[]): Promise<void> {
        if (localOnlyPaths.length === 0) return;

        const originalHashes = new Map<string, string>();
        for (const filePath of localOnlyPaths) {
            const localUri = this.settings.getFilePath(filePath);
            await this.assertNoSymbolicLinks(localUri);
            originalHashes.set(filePath, hashContent(await this.readLocalFileIfExists(localUri)));
        }

        const fileList = localOnlyPaths.length <= 5
            ? localOnlyPaths.join(', ')
            : `${localOnlyPaths.slice(0, 5).join(', ')}... and ${localOnlyPaths.length - 5} more`;

        this.requestBackgroundChoice('local-only-files', () => vscode.window.showInformationMessage(
            `${localOnlyPaths.length} local file(s) not on Overleaf: ${fileList}`,
            { modal: false },
            'Upload All',
            'Ignore'
        ), async choice => {
            if (choice === 'Upload All') {
                this.throwIfDisposed();
                for (const path of localOnlyPaths) {
                    if (this.disposed) break;
                    try {
                        if (this.fileTreeByPath.has(path) || !this.shouldSync(path)) continue;
                        await this.uploadLocalFile(path);
                        this.log(`Uploaded new file: ${path}`);
                    } catch (error) {
                        console.error(`[LocalLeaf] Failed to upload: ${path}`, error);
                        this.setStatus('error', `Cannot upload ${path}: ${errorMessage(error)}`, path, isAuthError(error));
                    }
                }
            }
            // 'Ignore' - do nothing, files stay local only
        }, this.localChoiceFingerprint(originalHashes));
    }

    /**
     * Ensure all parent folders exist for a given file path.
     * Creates missing folders recursively and adds them to the file tree.
     * Returns the parent folder ID for the file.
     */
    private async ensureParentFoldersExist(relativePath: string): Promise<string> {
        const projectSettings = this.settings.getSettings()!;
        const rootFolderId = this.project?.rootFolder[0]._id;

        if (!rootFolderId) {
            throw new Error('Project root folder not found');
        }

        // Get parent path (e.g., "/tex/chapters/" from "/tex/chapters/intro.tex")
        const parentPath = relativePath.substring(0, relativePath.lastIndexOf('/') + 1) || '/';

        // If parent exists, return its ID
        const existingParent = this.fileTreeByPath.get(parentPath);
        if (existingParent) {
            return existingParent.id;
        }

        // If parent is root, return root ID
        if (parentPath === '/') {
            return rootFolderId;
        }

        // Parse path into folder segments (e.g., ["tex", "chapters"])
        const segments = parentPath.split('/').filter(s => s.length > 0);

        let currentPath = '/';
        let currentParentId = rootFolderId;

        for (const segment of segments) {
            const folderPath = currentPath + segment + '/';
            const existingFolder = this.fileTreeByPath.get(folderPath);

            if (existingFolder) {
                // Folder exists, move to next level
                currentParentId = existingFolder.id;
                currentPath = folderPath;
            } else {
                // Folder doesn't exist, create it
                debugLog('Creating missing parent folder:', folderPath);
                const trackedFolder = await this.runPendingLocalCreate(folderPath, async () => {
                    const result = await this.api.addFolder(
                        projectSettings.projectId,
                        currentParentId,
                        segment
                    );
                    this.throwIfDisposed();

                ensureApiSuccess(result, `Create folder ${folderPath}`);
                if (!result.folder) throw new Error(`Create folder ${folderPath}: Overleaf returned no folder`);

                    const folderEntry: FileTreeEntry = {
                        id: validateOverleafId(result.folder._id, 'folder ID'),
                        type: 'folder',
                        name: segment,
                        path: folderPath,
                        parentId: currentParentId,
                    };
                    const existing = this.fileTree.get(folderEntry.id);
                    if (existing && (existing.path !== folderPath || existing.type !== 'folder')) {
                        throw new Error(`Overleaf reused folder ID: ${folderEntry.id}`);
                    }
                    const canonicalFolder = existing || folderEntry;
                    this.fileTree.set(canonicalFolder.id, canonicalFolder);
                    this.fileTreeByPath.set(folderPath, canonicalFolder);
                    this.setBaseContent(folderPath, SYNCHRONIZED_CONTENT_MARKER);
                    return canonicalFolder;
                });

                this.log(`Created folder on Overleaf: ${folderPath}`);

                currentParentId = trackedFolder.id;
                currentPath = folderPath;
            }
        }

        return currentParentId;
    }

    /**
     * Upload a local file to Overleaf (create new entity).
     */
    private async uploadLocalFile(relativePath: string): Promise<void> {
        const projectSettings = this.settings.getSettings()!;
        const localUri = this.settings.getFilePath(relativePath);
        await this.assertNoSymbolicLinks(localUri);
        const name = relativePath.split('/').pop()!;
        const isTextFile = this.isTextFile(name);
        const openDocument = isTextFile ? this.getOpenTextDocument(localUri) : undefined;
        let content = openDocument?.isDirty
            ? this.getOpenDocumentContent(openDocument)
            : await this.readLocalFile(localUri);
        this.throwIfDisposed();

        // Ensure all parent folders exist (creates them if needed)
        const parentId = await this.ensureParentFoldersExist(relativePath);

        this.setStatus('pushing', `Uploading ${relativePath}`, relativePath);

        if (isTextFile && !this.requiresFileUpload(content)) {
            content = await this.createTextDocumentWithContent(
                projectSettings.projectId,
                parentId,
                relativePath,
                name,
                content
            );
        } else {
            await this.runPendingLocalCreate(relativePath, async () => {
                const result = await this.api.uploadFile(
                    projectSettings.projectId,
                    parentId,
                    name,
                    content
                );
                this.throwIfDisposed();
                ensureApiSuccess(result, `Upload ${relativePath}`);
                const entry = await this.resolveUploadedFile(result, parentId, name, relativePath);
                this.recordSynchronizedContent(entry, content);
            });
        }
    }

    /**
     * Return remote files currently excluded by .leafignore.
     * Refreshing both sources also finds artifacts left by earlier sessions.
     */
    getIgnoredRemoteFiles(): Promise<string[]> {
        return this.runWorkspaceExclusive(() => this.getIgnoredRemoteFilesExclusive());
    }

    private async getIgnoredRemoteFilesExclusive(): Promise<string[]> {
        await this.ignoreParser.load();
        await this.refreshProjectFileTree();
        return this.getIgnoredRemoteRoots().map(entry => entry.path);
    }

    /** Collapse fully ignored subtrees into one server-side folder deletion. */
    private getIgnoredRemoteRoots(): FileTreeEntry[] {
        const entries = [...this.fileTree.values()];
        const ignored = new Set(entries.filter(entry => entry.path !== '/'
            && entry.id !== this.project?.rootDoc_id && this.ignoreParser.shouldIgnore(entry.path))
            .map(entry => entry.path));
        const protectedFolders = new Set<string>();
        for (const entry of entries) {
            if (ignored.has(entry.path)) continue;
            for (let index = entry.path.indexOf('/', 1); index >= 0; index = entry.path.indexOf('/', index + 1)) {
                if (index < entry.path.length - 1) protectedFolders.add(entry.path.slice(0, index + 1));
            }
        }
        const folders = new Set(entries.filter(entry => entry.type === 'folder'
            && ignored.has(entry.path) && !protectedFolders.has(entry.path)).map(entry => entry.path));
        return entries.filter(entry => {
            if (!ignored.has(entry.path) || (entry.type === 'folder' && !folders.has(entry.path))) return false;
            for (let index = entry.path.indexOf('/', 1); index >= 0; index = entry.path.indexOf('/', index + 1)) {
                if (index < entry.path.length - 1 && folders.has(entry.path.slice(0, index + 1))) return false;
            }
            return true;
        }).sort((a, b) => a.path.localeCompare(b.path));
    }

    getRemoteCleanupCandidates(): Promise<RemoteCleanupCandidate[]> {
        return this.runWorkspaceExclusive(async () => {
            await this.ignoreParser.load();
            await this.refreshProjectFileTree();
            const ignored = this.getIgnoredRemoteRoots();
            const candidates: RemoteCleanupCandidate[] = ignored.map(entry => ({
                path: entry.path, id: entry.id, type: entry.type, reason: 'ignored',
            }));
            for (const entry of this.fileTree.values()) {
                if (await this.isRemoteOnlyCleanupCandidate(entry)) {
                    candidates.push({ path: entry.path, id: entry.id, type: entry.type, reason: 'missing-local' });
                }
            }
            return candidates.sort((a, b) => a.path.localeCompare(b.path));
        });
    }

    private async isRemoteOnlyCleanupCandidate(entry: FileTreeEntry): Promise<boolean> {
        if (entry.type === 'folder' || entry.id === this.project?.rootDoc_id || !this.shouldSync(entry.path)) return false;
        const uri = this.settings.getFilePath(entry.path);
        await this.assertNoSymbolicLinks(uri);
        return !this.getOpenTextDocument(uri) && !(await this.localFileExists(uri));
    }

    deleteRemoteCleanupCandidates(candidates: readonly RemoteCleanupCandidate[]): Promise<{
        deleted: number; skipped: number; failed: Array<{ path: string; error: unknown }>;
    }> {
        return this.runWorkspaceExclusive(async () => {
            await this.ignoreParser.load();
            await this.refreshProjectFileTree();
            const ignoredRoots = new Set(this.getIgnoredRemoteRoots().map(entry => entry.path));
            let deleted = 0;
            let skipped = 0;
            const failed: Array<{ path: string; error: unknown }> = [];
            this.setStatus('pushing', 'Cleaning selected entries from Overleaf...');
            for (const candidate of candidates) {
                this.throwIfDisposed();
                const entry = this.fileTreeByPath.get(candidate.path);
                if (!entry || entry.id !== candidate.id || entry.type !== candidate.type) {
                    skipped++;
                    continue;
                }
                try {
                    const eligible = candidate.reason === 'ignored'
                        ? ignoredRoots.has(entry.path)
                        : candidate.reason === 'missing-local' && await this.isRemoteOnlyCleanupCandidate(entry);
                    if (!eligible) { skipped++; continue; }
                    await this.deleteRemoteEntry(entry, true);
                    this.removeTrackedSubtree(entry.path);
                    this.log(`Deleted ${candidate.reason === 'ignored' ? 'ignored' : 'remote-only'} entry from Overleaf: ${entry.path}`);
                    deleted++;
                } catch (error) {
                    failed.push({ path: candidate.path, error });
                }
            }
            this.setStatus(failed.length ? 'error' : 'idle',
                `Cleanup complete: ${deleted} deleted, ${skipped} skipped, ${failed.length} failed`);
            return { deleted, skipped, failed };
        });
    }

    /**
     * Delete a user-confirmed list of ignored remote files.
     * Every path is revalidated immediately before deletion.
     */
    deleteIgnoredRemoteFiles(
        paths: readonly string[]
    ): Promise<{ deleted: number; failed: Array<{ path: string; error: unknown }> }> {
        return this.runWorkspaceExclusive(() => this.deleteIgnoredRemoteFilesExclusive(paths));
    }

    private async deleteIgnoredRemoteFilesExclusive(
        paths: readonly string[]
    ): Promise<{ deleted: number; failed: Array<{ path: string; error: unknown }> }> {
        await this.ignoreParser.load();
        await this.refreshProjectFileTree();
        const ignoredRoots = new Set(this.getIgnoredRemoteRoots().map(entry => entry.path));

        let deleted = 0;
        const failed: Array<{ path: string; error: unknown }> = [];
        this.setStatus('pushing', 'Cleaning ignored files from Overleaf...');

        for (const path of paths) {
            const entry = this.fileTreeByPath.get(path);
            if (!entry || !ignoredRoots.has(path)) {
                continue;
            }

            try {
                await this.deleteRemoteEntry(entry, true);
                this.removeTrackedSubtree(path);
                this.log(`Deleted ignored file from Overleaf: ${path}`);
                deleted++;
            } catch (error) {
                failed.push({ path, error });
            }
        }

        if (failed.length > 0) {
            this.setStatus('error', `Cleanup completed with ${failed.length} failure(s)`);
        } else {
            this.setStatus('idle', `Deleted ${deleted} ignored file(s) from Overleaf`);
        }

        return { deleted, failed };
    }

    /**
     * Find local files that have not been seen on Overleaf. Directory reads
     * may legitimately fail because of permissions, but traversal limits and
     * path-safety failures must propagate instead of being silently swallowed.
     */
    private async findLocalOnlyFiles(
        maxEntities: number = MAX_LOCAL_SCAN_ENTITIES,
        maxDepth: number = MAX_LOCAL_SCAN_DEPTH,
    ): Promise<string[]> {
        const localOnlyPaths: string[] = [];
        const workspaceFolder = this.settings.getWorkspaceFolder();
        await this.assertNoSymbolicLinks(workspaceFolder);
        let scannedEntities = 0;

        const scanDirectory = async (
            directoryUri: vscode.Uri,
            basePath: string = '/',
            depth: number = 0,
        ): Promise<void> => {
            if (depth > maxDepth) {
                throw new Error('Local project contains an excessively deep directory tree.');
            }

            let entries: [string, vscode.FileType][];
            try {
                entries = await vscode.workspace.fs.readDirectory(directoryUri);
            } catch (error) {
                if (isFileNotFoundError(error)) return; // A directory may disappear during the scan.
                throw error;
            }

            for (const [name, type] of entries) {
                scannedEntities++;
                if (scannedEntities > maxEntities) {
                    throw new Error('Local project contains too many files or directories to scan safely.');
                }

                const relativePath = basePath + name;
                const isDirectory = (type & vscode.FileType.Directory) !== 0;
                const fullPath = isDirectory ? `${relativePath}/` : relativePath;

                if (!this.shouldSync(fullPath)) continue;

                // Never traverse or upload a symbolic link. It may point
                // outside the workspace even though its visible path is inside.
                if ((type & vscode.FileType.SymbolicLink) !== 0) {
                    this.log(`Skipped symbolic link: ${fullPath}`);
                    continue;
                }

                if (isDirectory) {
                    const childUri = vscode.Uri.joinPath(directoryUri, name);
                    await this.assertNoSymbolicLinks(childUri);
                    await scanDirectory(childUri, fullPath, depth + 1);
                } else if (!this.fileTreeByPath.has(fullPath) && !this.baseContent.has(fullPath)) {
                    localOnlyPaths.push(fullPath);
                }
            }
        };

        await scanDirectory(workspaceFolder);
        return localOnlyPaths;
    }

    /**
     * Perform full sync (pull all files)
     */
    pullAll(reviewConflicts = true): Promise<void> {
        this.throwIfDisposed();
        if (!this.project) {
            return Promise.reject(new Error('Not connected'));
        }

        // A background pull and a user-triggered pull can arrive together.
        // Share the in-flight operation so conflict prompts, uploads and cache
        // mutations execute exactly once.
        if (this.activePull) return this.activePull;
        if (reviewConflicts) {
            this.reviewedBackgroundChoices?.clear();
            for (const [path, pending] of this.pendingConflicts ?? []) {
                if (pending.choice === 'skip') this.pendingConflicts.delete(path);
            }
        }

        const operation = this.runWorkspaceExclusive(() => this.pullWithRecovery());
        this.activePull = operation;
        void operation.then(
            () => {
                if (this.activePull === operation) this.activePull = undefined;
            },
            () => {
                if (this.activePull === operation) this.activePull = undefined;
            },
        );
        return operation;
    }

    private scheduleAutomaticRecovery(): void {
        if (this.disposed || !this.project || this.authenticationRequired) return;
        this.recoveryRequired = true;
        if (this.automaticRecoveryScheduled) return;
        this.automaticRecoveryScheduled = true;
        this.scheduleOperation(async () => {
            try {
                let failures = 0;
                while (!this.disposed && !this.authenticationRequired && this.recoveryRequired) {
                    this.recoveryRequired = false;
                    try {
                        await this.pullAll(false);
                        await this.joinAllDocsForWatching();
                        if (this.socket?.isConnected === false) throw new Error('Connection lost while restoring subscriptions');
                        this.log('Automatic recovery complete; live synchronization is active');
                        failures = 0;
                    } catch (error) {
                        if (this.disposed || isAuthError(error) || this.authenticationRequired) {
                            if (isAuthError(error)) this.setStatus('error', 'Session expired', undefined, true);
                            return;
                        }
                        if (this.socket?.isConnected !== false) {
                            // File conflicts and failed local writes cannot be
                            // repaired by reconnecting a healthy transport.
                            this.recoveryRequired = false;
                            this.log(`Connection restored; synchronization needs attention: ${errorMessage(error)}`);
                            return;
                        }
                        this.recoveryRequired = true;
                        const delay = Math.min(30_000, this.recoveryDelayMs * 2 ** Math.min(failures++, 3));
                        this.log(`Automatic recovery failed; retrying in ${delay / 1000}s: ${errorMessage(error)}`);
                        this.setStatus('connecting', `Connection interrupted; retrying automatically in ${delay / 1000}s`);
                        if (!(await this.waitForRetry(delay))) return;
                    }
                }
            } finally {
                this.automaticRecoveryScheduled = false;
            }
        });
    }

    /** Catch up once when the user returns, without periodically restarting healthy sessions. */
    async reconcileOnWindowFocus(): Promise<void> {
        if (this.disposed || !this.project || this.authenticationRequired || this.activePull
            || this.automaticRecoveryScheduled || Date.now() - this.lastFocusReconciliation < 60_000) return;
        this.lastFocusReconciliation = Date.now();
        if (this.socket?.isConnected === false) {
            this.scheduleAutomaticRecovery();
            return;
        }
        try {
            await this.pullAll(false);
            await this.checkDocumentSubscriptions();
        } catch (error) {
            if (this.disposed) return;
            this.log(`Synchronization on window focus did not complete: ${errorMessage(error)}`);
            if (isAuthError(error)) this.setStatus('error', 'Session expired', undefined, true);
            else if (this.getSocket()?.isConnected === false) this.scheduleAutomaticRecovery();
        }
    }

    /** Rejoin and reconcile documents even if a server silently loses a room. */
    private async checkDocumentSubscriptions(): Promise<void> {
        let checked = 0;
        for (const [id, entry] of [...this.fileTree]) {
            if (this.disposed || this.activePull || this.authenticationRequired) return;
            if (entry.type !== 'doc' || !this.shouldSync(entry.path)) continue;
            this.enqueueRemoteEvent(isCurrent => this.handleRemoteFileChanged({
                doc: id, v: this.documentSnapshots.get(id)?.version ?? 0,
            }, isCurrent));
            await this.remoteEventQueue;
            checked++;
            if (this.socket?.isConnected === false) throw new Error('Connection lost while checking document subscriptions');
        }
        this.log(`Live synchronization check completed (${checked} documents)`);
    }

    /** Retry reads with fresh server metadata, retaining all local baselines. */
    private async pullWithRecovery(): Promise<void> {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                let refreshTree = true;
                if (this.socket?.isConnected === false) {
                    this.setStatus('connecting', 'Reconnecting automatically...');
                    this.remoteEventGeneration = (this.remoteEventGeneration ?? 0) + 1;
                    const project = await this.socket.reconnect();
                    this.throwIfDisposed();
                    this.buildFileTree(project);
                    this.project = project;
                    this.joinedDocs.clear();
                    this.documentSnapshots.clear();
                    this.retainedSnapshotBytes = 0;
                    this.log('Reconnected; resuming synchronization with the current project tree');
                    this.recoveryRequired = false;
                    refreshTree = false; // The successful join just supplied an authoritative tree.
                }
                await this.performPullAll(refreshTree);
                if (this.socket?.isConnected === false) {
                    throw new Error('Real-time connection was lost during the pull.');
                }
                return;
            } catch (error) {
                this.throwIfDisposed();
                if (isAuthError(error) || this.socket?.isConnected !== false || attempt === 2) {
                    const authError = isAuthError(error);
                    this.setStatus('error', authError ? 'Session expired' : `Pull failed: ${errorMessage(error)}`, undefined, authError);
                    throw error;
                }
                this.log(`Connection interrupted; retrying synchronization automatically (${attempt + 1}/2): ${errorMessage(error)}`);
                this.setStatus('connecting', 'Connection interrupted; resuming automatically...');
                if (!(await this.waitForRetry(1000 * (attempt + 1)))) this.throwIfDisposed();
            }
        }
    }

    private async performPullAll(refreshTree = true): Promise<void> {
        const project = this.project;
        if (!project) throw new Error('Not connected');

        debugLog('pullAll: Starting pull');
        debugLog('pullAll: File tree size:', this.fileTree.size);
        debugLog('pullAll: Project name:', project.name);

        this.setStatus('pulling', 'Downloading all files...');
        let downloadedCount = 0;
        let skippedCount = 0;
        let conflictCount = 0;

        try {
            // Preserve ancestors across fresh snapshots to detect remote
            // deletions. A reconnect already supplied this same metadata.
            if (refreshTree) await this.refreshProjectFileTree();
            await this.recoverReplacementIntents();
            await this.reconcileRecordedStructure();
            const downloadFile = async (entry: FileTreeEntry) => {
                this.throwIfDisposed();
                debugLog('pullAll: Processing', entry.path, entry.type);

                if (entry.path === '/') {
                    this.setBaseContent('/', SYNCHRONIZED_CONTENT_MARKER);
                    return;
                }

                if (!this.shouldSync(entry.path)) {
                    debugLog('pullAll: Ignored', entry.path);
                    return;
                }
                if (this.stateStore?.entries.get(entry.path)?.intent?.kind === 'delete') return;
                if (entry.type === 'doc' && this.stateStore?.entries.get(entry.path)?.intent?.kind === 'write') {
                    await this.recoverDocumentIntent(entry);
                    return;
                }

                if (entry.type === 'folder') {
                    const localUri = this.settings.getFilePath(entry.path);
                    await this.assertNoSymbolicLinks(localUri);
                    if (!await this.localFileExists(localUri) && this.deferKnownLocalDeletion(entry, localUri)) return;
                    await vscode.workspace.fs.createDirectory(localUri);
                    // Track folders in baseContent with empty content
                    this.setBaseContent(entry.path, SYNCHRONIZED_CONTENT_MARKER);
                    return;
                }

                const remoteContent = await this.getRemoteEntryContent(entry);
                debugLog('pullAll: Downloaded remote content', entry.path, remoteContent.length, 'bytes');

                const localUri = this.settings.getFilePath(entry.path);
                await this.assertNoSymbolicLinks(localUri);
                const diskContent = await this.readLocalFileIfExists(localUri);
                const openDocument = this.getOpenTextDocument(localUri);
                const openDocumentVersion = openDocument?.version;
                if (diskContent === undefined && !openDocument?.isDirty && this.deferKnownLocalDeletion(entry, localUri)) return;
                const localContent = openDocument
                    ? this.getOpenDocumentContent(openDocument)
                    : diskContent;
                const hasLocalContent = localContent !== undefined;

                // Check for conflicts or new remote files
                if (hasLocalContent) {
                    if (!contentEquals(localContent, remoteContent)) {
                        conflictCount++;
                        const baseHash = this.getBaseHashes().get(entry.path);
                        const localUnchanged = baseHash !== undefined && hashContent(localContent) === baseHash;
                        const remoteUnchanged = baseHash !== undefined && hashContent(remoteContent) === baseHash;
                        // Overleaf returns LF line endings; Windows checkouts
                        // can contain the same text with CRLF. This is not a conflict.
                        const sameDocumentText = entry.type === 'doc'
                            && new TextDecoder().decode(localContent).replace(/\r\n/g, '\n')
                                === new TextDecoder().decode(remoteContent).replace(/\r\n/g, '\n');
                        if (!localUnchanged && !sameDocumentText && !remoteUnchanged
                            && await this.reconcileIndependentChanges(entry, localContent, remoteContent)) return;
                        if (remoteUnchanged && openDocument?.isDirty) return;
                        const resolution = localUnchanged || sameDocumentText ? 'useRemote'
                            : remoteUnchanged ? (this.automaticSyncEnabled ? 'useLocal' : 'skip')
                                : await this.askConflictResolution(entry.path, localUri, remoteContent);
                        this.throwIfDisposed();

                        if (resolution === 'skip') {
                            debugLog('pullAll: Skipped (user choice)', entry.path);
                            this.keepLocalDocumentAfterRemoteUpdate(
                                entry.path,
                                `Kept local edits; Overleaf content was not applied to ${entry.path}`,
                                false,
                            );
                            skippedCount++;
                            return;
                        }

                        if (resolution === 'useLocal') {
                            // Push local content to Overleaf
                            debugLog('pullAll: Using local, pushing to Overleaf', entry.path);
                            this.setStatus('pushing', `Uploading ${entry.path}`, entry.path);
                            const latestOpenDocument = this.getOpenTextDocument(localUri);
                            let latestLocalContent = latestOpenDocument
                                ? this.getOpenDocumentContent(latestOpenDocument)
                                : await this.readLocalFileIfExists(localUri);
                            if (!latestLocalContent) {
                                throw new Error(`Cannot keep ${entry.path}: the local file no longer exists`);
                            }

                            if (entry.type === 'doc') {
                                if (!this.socket) {
                                    throw new Error(`Cannot update ${entry.path}: real-time connection is unavailable`);
                                }
                                const pushed = await this.pushDocumentChanges(entry.id, entry.path, latestLocalContent, !remoteUnchanged);
                                if (!pushed) return;
                                latestLocalContent = pushed.content;
                            } else {
                                await this.replaceRemoteFile(entry, latestLocalContent);
                            }

                            this.recordSynchronizedContent(entry, latestLocalContent);
                            return;
                        }
                        // resolution === 'useRemote' - continue to download
                    }
                }

                // Skip write if content is identical
                if (contentEquals(localContent, remoteContent)) {
                    // Content is the same, just update cache
                    this.recordSynchronizedContent(entry, remoteContent);
                    return;
                }

                this.setStatus('pulling', `Downloading ${entry.path}`, entry.path);
                this.throwIfDisposed();

                const currentOpenDocument = this.getOpenTextDocument(localUri);
                if (currentOpenDocument) {
                    if (
                        openDocumentVersion === undefined
                        || currentOpenDocument.version !== openDocumentVersion
                    ) {
                        this.keepLocalDocumentAfterRemoteUpdate(
                            entry.path,
                            `Kept newer editor changes; retry the pull for ${entry.path}`,
                            false,
                        );
                        skippedCount++;
                        return;
                    }

                    if (currentOpenDocument.isDirty) {
                        const result = await this.applyRemoteContentToOpenDocument(
                            currentOpenDocument,
                            openDocumentVersion,
                            remoteContent,
                        );
                        this.throwIfDisposed();
                        if (result === 'stale' || result === 'failed') {
                            this.keepLocalDocumentAfterRemoteUpdate(
                                entry.path,
                                `Kept newer editor changes; retry the pull for ${entry.path}`,
                                false,
                            );
                            skippedCount++;
                            return;
                        }
                    } else {
                        await vscode.workspace.fs.writeFile(localUri, remoteContent);
                    }
                } else {
                    const latestDiskContent = await this.readLocalFileIfExists(localUri);
                    if (!contentEquals(latestDiskContent, diskContent)) {
                        this.keepLocalDocumentAfterRemoteUpdate(
                            entry.path,
                            `Kept newer local changes; retry the pull for ${entry.path}`,
                            false,
                        );
                        skippedCount++;
                        return;
                    }
                    await vscode.workspace.fs.writeFile(localUri, remoteContent);
                }
                this.recordSynchronizedContent(entry, remoteContent);
                downloadedCount++;
            };

            // Download all files
            await this.recoverDeletionIntents();
            const downloadErrors: unknown[] = [];
            for (const entry of this.fileTree.values()) {
                try { await downloadFile(entry); }
                catch (error) {
                    if (isAuthError(error) || this.socket?.isConnected === false) throw error;
                    this.setStatus('error', `Cannot synchronize ${entry.path}: ${errorMessage(error)}`, entry.path);
                    downloadErrors.push(error);
                    skippedCount++;
                }
            }
            if (downloadErrors.length) throw downloadErrors[0];

            // Detect files that were deleted on Overleaf but exist locally
            // (files in baseContent but not in fileTreeByPath)
            const orphanedPaths: string[] = [];
            for (const [syncedPath] of this.baseContent) {
                // Skip if still exists on Overleaf
                if (this.fileTreeByPath.has(syncedPath)) continue;
                // Skip folders
                if (syncedPath.endsWith('/')) continue;
                // Skip ignored files
                if (!this.shouldSync(syncedPath)) continue;
                // Check if local file actually exists
                const localUri = this.settings.getFilePath(syncedPath);
                if (await this.localFileExists(localUri)) {
                    const baseHash = this.getBaseHashes().get(syncedPath);
                    if (baseHash && !this.hasDirtyDocument(localUri)
                        && hashContent(await this.readLocalFile(localUri)) === baseHash) {
                        await this.deleteLocalPath(syncedPath, localUri, false);
                        this.deleteBaseContent(syncedPath);
                        this.fileCache.delete(syncedPath);
                        this.log(`Applied remote deletion missed while offline: ${syncedPath}`);
                        continue;
                    }
                    orphanedPaths.push(syncedPath);
                }
            }
            if (orphanedPaths.length > 0) {
                await this.handleOrphanedLocalFiles(orphanedPaths);
            }

            // Detect local-only files (exist locally but not on Overleaf or in baseContent)
            const localOnlyPaths = await this.findLocalOnlyFiles();
            if (localOnlyPaths.length > 0) {
                await this.handleLocalOnlyFiles(localOnlyPaths);
            }

            await this.settings.updateLastSynced();
            await this.stateStore?.flush();

            const message = `Pull complete: ${downloadedCount} downloaded, ${skippedCount} skipped, ${conflictCount} conflicts`;
            debugLog('pullAll:', message);
            this.setStatus('idle', message);
        } catch (error) {
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Pull failed: ${error}`, undefined, authErr);
            throw error;
        }
    }

    /**
     * Determine if a file is a text file (doc) vs binary file
     */
    private isTextFile(filename: string): boolean {
        const textExtensions = [
            '.tex', '.bib', '.cls', '.sty', '.txt', '.md', '.rst',
            '.json', '.xml', '.yaml', '.yml', '.csv', '.tsv',
            '.gitignore', '.latexmkrc', 'makefile', '.leafignore',
        ];
        const lower = filename.toLowerCase();
        return textExtensions.some(ext => lower.endsWith(ext) || lower === ext.slice(1));
    }

    private requiresFileUpload(content: Uint8Array): boolean {
        // The server's limit counts UTF-16 characters, not UTF-8 bytes.
        return content.byteLength >= MAX_EDITABLE_DOCUMENT_CHARACTERS
            && new TextDecoder().decode(content).length >= MAX_EDITABLE_DOCUMENT_CHARACTERS;
    }

    /**
     * Get the socket instance
     */
    getSocket(): SocketIOAPI | undefined {
        return this.socket;
    }

    /**
     * Disconnect and cleanup
     */
    disconnect(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const timer of this.localEventTimers?.values() ?? []) clearTimeout(timer);
        this.localEventTimers?.clear();
        for (const [timer, resolve] of this.pendingWaits) {
            clearTimeout(timer);
            resolve(false);
        }
        this.pendingWaits.clear();
        this.socket?.disconnect();
        this.socket = undefined;
        this.api.dispose();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        this.syncLock.clear();
        this.suppressedRemoteDocumentUpdates.clear();
        this.suppressedDocumentUpdateCount = 0;
        this.suppressedRemoteDeletes.clear();
        this.suppressedRemoteRenames.clear();
        this.remoteDiffContents.clear();
        this.pendingConflicts?.clear();
        this.backgroundChoices?.clear();
        this.reviewedBackgroundChoices?.clear();
        this.remoteDiffCharacters = 0;
        this.fileTree.clear();
        this.fileTreeByPath.clear();
        this.removedSnapshotEntries.clear();
        this.fileCache.clear();
        this.clearBaseContent();
        this.pendingLocalCreates.clear();
        this.joinedDocs.clear();
        this.documentSnapshots.clear();
        this.retainedSnapshotBytes = 0;
        this._status = 'disconnected';
        this._onStatusChange.fire({ status: 'disconnected' });
        this._onStatusChange.dispose();
    }

    /**
     * Get file tree
     */
    getFileTree(): Map<string, FileTreeEntry> {
        return this.fileTree;
    }
}
