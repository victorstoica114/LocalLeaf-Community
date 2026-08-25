/**
 * LocalLeaf Socket.io API - Real-time sync with Overleaf
 * Adapted from Overleaf-Workshop
 */

import * as vscode from 'vscode';
import { BaseAPI, ProjectEntity, FileEntity } from './base';
import { Identity } from '../utils/credentialManager';

// Output channel for logging (visible to user)
let outputChannel: vscode.OutputChannel | undefined;

function log(message: string) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const logMessage = `[${timestamp}] ${message}`;
    if (outputChannel) {
        outputChannel.appendLine(logMessage);
    }
}

export function setOutputChannel(channel: vscode.OutputChannel) {
    outputChannel = channel;
}

/**
 * Online user information
 */
export interface OnlineUser {
    clientId: string;
    userId: string;
    name: string;
    email: string;
    docId: string;
    row: number;
    column: number;
    lastUpdated: number;
}

/**
 * User cursor update from socket
 */
export interface UserCursorUpdate {
    id: string;
    user_id: string;
    name: string;
    email: string;
    doc_id: string;
    row: number;
    column: number;
}

/**
 * Document update (OT operations)
 */
export interface DocumentUpdate {
    doc: string; // doc id
    op?: Array<{
        p: number; // position
        i?: string; // insert
        d?: string; // delete
        u?: boolean; // isUndo
    }>;
    v: number; // version number
    lastV?: number;
    hash?: string;
    meta?: {
        source: string; // socketio client id
        ts: number; // timestamp
        user_id: string;
    };
}

/**
 * Event handlers for socket events
 */
export interface SocketEventHandlers {
    // File events
    onFileCreated?: (parentFolderId: string, type: 'doc' | 'file' | 'folder', entity: FileEntity) => void;
    onFileRenamed?: (entityId: string, newName: string) => void;
    onFileRemoved?: (entityId: string) => void;
    onFileMoved?: (entityId: string, newParentFolderId: string) => void;
    onFileChanged?: (update: DocumentUpdate) => void;
    // Connection events
    onConnected?: (publicId: string) => void;
    onDisconnected?: (isAuthError?: boolean) => void;
    // Collaboration events
    onUserCursorUpdated?: (user: UserCursorUpdate) => void;
    onUserDisconnected?: (clientId: string) => void;
    // Project events
    onRootDocUpdated?: (rootDocId: string) => void;
    onCompilerUpdated?: (compiler: string) => void;
}

type ConnectionMode = 'legacy' | 'query';

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function projectFromResponse(value: unknown): ProjectEntity {
    if (value === null || typeof value !== 'object') {
        throw new Error('Overleaf returned an invalid project response.');
    }
    return value as ProjectEntity;
}

/**
 * Socket.io API for real-time communication with Overleaf
 * Reference: Overleaf-Workshop/src/api/socketio.ts
 */
export class SocketIOAPI {
    private socket?: SocketIOClient.Socket;
    private connectionMode: ConnectionMode = 'legacy';
    private projectRecord?: ProjectEntity;
    private projectRecordPromise?: Promise<ProjectEntity>;
    private projectRecordResolve?: (project: ProjectEntity) => void;
    private handlers: SocketEventHandlers[] = [];
    private _publicId?: string;
    private _connected: boolean = false;
    private _handshakeComplete: boolean = false;
    private _handshakePromise!: Promise<void>;
    private _handshakeResolve!: () => void;
    private _connectionFailurePromise!: Promise<Error>;
    private _connectionFailureResolve!: (error: Error) => void;

    constructor(
        private readonly api: BaseAPI,
        private readonly identity: Identity,
        private readonly projectId: string
    ) {
        this.init();
    }

    /**
     * Initialize socket connection
     * Reference: Overleaf-Workshop socketio.ts init()
     */
    private init(mode: ConnectionMode = 'legacy') {
        this.teardownSocket();
        this.connectionMode = mode;

        // Create handshake promise
        this._handshakeComplete = false;
        this._handshakePromise = new Promise((resolve) => {
            this._handshakeResolve = resolve;
        });
        this._connectionFailurePromise = new Promise((resolve) => {
            this._connectionFailureResolve = resolve;
        });

        // Older Community Edition servers expect an explicit joinProject event.
        // Newer servers expect the project ID as part of the Socket.IO handshake.
        this.projectRecordPromise = undefined;
        this.projectRecordResolve = undefined;
        this.projectRecord = undefined;
        this._connected = false;
        const query = mode === 'query'
            ? `?projectId=${encodeURIComponent(this.projectId)}&t=${Date.now()}`
            : undefined;
        this.socket = this.api.initSocket(this.identity, query);

        this.setupInternalHandlers(this.socket, mode);
        for (const handlers of this.handlers) {
            this.attachHandlers(this.socket, handlers);
        }
    }

    private teardownSocket(): void {
        const socket = this.socket;
        this.socket = undefined;
        if (!socket) return;
        socket.removeAllListeners?.();
        socket.disconnect();
    }

    private failConnection(socket: SocketIOClient.Socket, error: Error): void {
        if (this.socket !== socket || this._connected) return;
        this._connectionFailureResolve(error);
    }

    private async raceConnectionFailure<T>(operation: Promise<T>): Promise<T> {
        return Promise.race([
            operation,
            this._connectionFailurePromise.then(error => {
                throw error;
            }),
        ]);
    }

    private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            promise.then(
                value => {
                    clearTimeout(timer);
                    resolve(value);
                },
                error => {
                    clearTimeout(timer);
                    reject(error);
                },
            );
        });
    }

    private emit(event: string, ...args: unknown[]): Promise<unknown[]> {
        const socket = this.socket;
        if (!socket) {
            return Promise.reject(new Error('Socket is not initialized'));
        }
        const response = new Promise<unknown[]>((resolve, reject) => {
            socket.emit(event, ...args, (error: unknown, ...data: unknown[]) => {
                if (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                } else {
                    resolve(data);
                }
            });
        });
        return this.withTimeout(response, 5000, `Socket event "${event}" timed out`);
    }

    /**
     * Setup internal event handlers
     * Reference: Overleaf-Workshop socketio.ts initInternalHandlers()
     */
    private setupInternalHandlers(socket: SocketIOClient.Socket, mode: ConnectionMode) {
        socket.on('connect', () => {
            if (this.socket !== socket) return;
            this._handshakeComplete = true;
            this._handshakeResolve();
        });

        socket.on('connect_failed', () => {
            if (this.socket !== socket) return;
            const error = new Error('Socket connection failed');
            log(error.message);
            this.failConnection(socket, error);
        });

        socket.on('forceDisconnect', (message: string) => {
            if (this.socket !== socket) return;
            log(`Force disconnected: ${message}`);
            this._connected = false;
            this.failConnection(socket, new Error(message || 'Overleaf forced the socket to disconnect'));
            // Check if force disconnect is auth-related
            const isAuthError = this.isAuthRelatedMessage(message);
            this.handlers.forEach(h => h.onDisconnected?.(isAuthError));
        });

        socket.on('error', (err: unknown) => {
            if (this.socket !== socket) return;
            log(`Socket error: ${err}`);
        });

        socket.on('disconnect', () => {
            if (this.socket !== socket) return;
            log('Disconnected from Overleaf');
            const wasConnected = this._connected;
            this._connected = false;
            if (wasConnected) {
                this.handlers.forEach(h => h.onDisconnected?.(false));
            } else {
                this.failConnection(socket, new Error('Socket disconnected before the project was joined'));
            }
        });

        socket.on('connectionRejected', (err: unknown) => {
            if (this.socket !== socket) return;
            const message = err instanceof Error
                ? err.message
                : typeof err === 'object' && err !== null && 'message' in err
                    ? String(err.message)
                    : String(err);
            log(`Connection rejected: ${message}`);
            this._connected = false;
            this.failConnection(socket, new Error(message || 'Socket connection rejected'));
        });

        socket.on('connectionAccepted', (_session: unknown, publicId: string) => {
            if (this.socket !== socket) return;
            this._publicId = publicId;
        });

        if (mode === 'query') {
            this.projectRecordPromise = new Promise(resolve => {
                this.projectRecordResolve = resolve;
            });
            socket.on('joinProjectResponse', (res: unknown) => {
                if (this.socket !== socket) return;
                if (res === null || typeof res !== 'object') {
                    this.failConnection(socket, new Error('Overleaf returned an invalid project response.'));
                    return;
                }
                const response = res as Record<string, unknown>;
                const publicId = response.publicId;
                const project = response.project;
                if (typeof publicId !== 'string' || project === null || typeof project !== 'object') {
                    this.failConnection(socket, new Error('Overleaf returned incomplete project metadata.'));
                    return;
                }
                this._publicId = publicId;
                this.projectRecord = project as ProjectEntity;
                this.projectRecordResolve?.(this.projectRecord);
            });
        }
    }

    /**
     * Register event handlers
     */
    registerHandlers(handlers: SocketEventHandlers) {
        this.handlers.push(handlers);
        if (this.socket) {
            this.attachHandlers(this.socket, handlers);
        }
    }

    private attachHandlers(socket: SocketIOClient.Socket, handlers: SocketEventHandlers): void {
        // File events
        if (handlers.onFileCreated) {
            socket.on('reciveNewDoc', (parentFolderId: string, doc: FileEntity) => {
                handlers.onFileCreated!(parentFolderId, 'doc', doc);
            });
            socket.on('reciveNewFile', (parentFolderId: string, file: FileEntity) => {
                handlers.onFileCreated!(parentFolderId, 'file', file);
            });
            socket.on('reciveNewFolder', (parentFolderId: string, folder: FileEntity) => {
                handlers.onFileCreated!(parentFolderId, 'folder', folder);
            });
        }

        if (handlers.onFileRenamed) {
            socket.on('reciveEntityRename', (entityId: string, newName: string) => {
                handlers.onFileRenamed!(entityId, newName);
            });
        }

        if (handlers.onFileRemoved) {
            socket.on('removeEntity', (entityId: string) => {
                handlers.onFileRemoved!(entityId);
            });
        }

        if (handlers.onFileMoved) {
            socket.on('reciveEntityMove', (entityId: string, folderId: string) => {
                handlers.onFileMoved!(entityId, folderId);
            });
        }

        if (handlers.onFileChanged) {
            socket.on('otUpdateApplied', (update: DocumentUpdate) => {
                handlers.onFileChanged!(update);
            });
        }

        // Collaboration events
        if (handlers.onUserCursorUpdated) {
            socket.on('clientTracking.clientUpdated', (user: UserCursorUpdate) => {
                handlers.onUserCursorUpdated!(user);
            });
        }

        if (handlers.onUserDisconnected) {
            socket.on('clientTracking.clientDisconnected', (clientId: string) => {
                handlers.onUserDisconnected!(clientId);
            });
        }

        // Project settings events
        if (handlers.onRootDocUpdated) {
            socket.on('rootDocUpdated', (rootDocId: string) => {
                handlers.onRootDocUpdated!(rootDocId);
            });
        }

        if (handlers.onCompilerUpdated) {
            socket.on('compilerUpdated', (compiler: string) => {
                handlers.onCompilerUpdated!(compiler);
            });
        }
    }

    /**
     * Wait for socket handshake to complete
     */
    private async waitForHandshake(timeoutMs: number = 5000): Promise<void> {
        if (this._handshakeComplete) {
            return;
        }

        await this.withTimeout(
            this.raceConnectionFailure(this._handshakePromise),
            timeoutMs,
            'Socket handshake timeout',
        );
    }

    /**
     * Join a project
     * Reference: Overleaf-Workshop socketio.ts joinProject()
     */
    async joinProject(): Promise<ProjectEntity> {
        let legacyError: unknown;
        try {
            const project = await this.joinProjectLegacy();
            this.markProjectJoined(project);
            log('Connected to project (real-time, legacy protocol)');
            return project;
        } catch (error) {
            legacyError = error;
            log(`Legacy Socket.IO project join failed: ${errorMessage(error)}`);
        }

        this.init('query');
        try {
            const project = await this.joinProjectFromHandshake();
            this.markProjectJoined(project);
            log('Connected to project (real-time, query protocol)');
            return project;
        } catch (queryError) {
            this.teardownSocket();
            throw new Error(
                `Unable to join the Overleaf project using either Socket.IO protocol. `
                + `Legacy: ${errorMessage(legacyError)}. Query: ${errorMessage(queryError)}.`
            );
        }
    }

    private async joinProjectLegacy(): Promise<ProjectEntity> {
        if (this.connectionMode !== 'legacy') {
            throw new Error('Legacy Socket.IO connection is not active');
        }
        await this.waitForHandshake();
        const response = await this.withTimeout(
            this.raceConnectionFailure(this.emit('joinProject', { project_id: this.projectId })),
            5000,
            'Legacy project join timed out',
        );
        return projectFromResponse(response[0]);
    }

    private async joinProjectFromHandshake(): Promise<ProjectEntity> {
        if (this.connectionMode !== 'query' || !this.projectRecordPromise) {
            throw new Error('Query Socket.IO connection is not initialized');
        }
        await this.waitForHandshake();
        return this.withTimeout(
            this.raceConnectionFailure(this.projectRecordPromise),
            5000,
            'Query project join timed out',
        );
    }

    private markProjectJoined(project: ProjectEntity): void {
        this.projectRecord = project;
        this._connected = true;
        this.handlers.forEach(handler => handler.onConnected?.(this._publicId || ''));
    }

    /**
     * Join a document for editing
     */
    async joinDoc(docId: string): Promise<{ lines: string[]; version: number }> {
        const [docLinesAscii, version] = await this.emit('joinDoc', docId, {
            encodeRanges: true,
        }) as [string[], number];

        const lines = docLinesAscii.map(line => Buffer.from(line, 'ascii').toString('utf-8'));
        return { lines, version };
    }

    /**
     * Leave a document
     */
    async leaveDoc(docId: string): Promise<void> {
        await this.emit('leaveDoc', docId);
    }

    /**
     * Apply OT update to a document
     */
    async applyOtUpdate(docId: string, update: DocumentUpdate): Promise<void> {
        await this.emit('applyOtUpdate', docId, update);
    }

    /**
     * Get connected users
     */
    async getConnectedUsers(): Promise<OnlineUser[]> {
        const [users] = await this.emit('clientTracking.getConnectedUsers') as [Array<{
            client_id: string;
            user_id: string;
            first_name: string;
            last_name?: string;
            email: string;
            cursorData?: { doc_id: string; row: number; column: number };
            last_updated_at: string;
        }>];

        return users.map(u => ({
            clientId: u.client_id,
            userId: u.user_id,
            name: [u.first_name, u.last_name].filter(Boolean).join(' '),
            email: u.email,
            docId: u.cursorData?.doc_id || '',
            row: u.cursorData?.row || 0,
            column: u.cursorData?.column || 0,
            lastUpdated: Number(u.last_updated_at),
        }));
    }

    /**
     * Update cursor position
     */
    async updatePosition(docId: string, row: number, column: number): Promise<void> {
        await this.emit('clientTracking.updatePosition', { row, column, doc_id: docId });
    }

    /**
     * Get public ID (client ID assigned by server)
     */
    get publicId(): string | undefined {
        return this._publicId;
    }

    /**
     * Check if connected
     */
    get isConnected(): boolean {
        return this._connected;
    }

    /**
     * Get project record
     */
    get project(): ProjectEntity | undefined {
        return this.projectRecord;
    }

    /**
     * Disconnect from socket
     */
    disconnect() {
        this.teardownSocket();
        this.handlers = [];
        this._connected = false;
    }

    /**
     * Check if a message indicates an auth-related error
     */
    private isAuthRelatedMessage(message: string | undefined): boolean {
        if (!message) return false;
        const msg = message.toLowerCase();
        return msg.includes('unauthorized') ||
               msg.includes('not logged in') ||
               msg.includes('session expired') ||
               msg.includes('invalid session') ||
               msg.includes('403') ||
               msg.includes('401') ||
               msg.includes('authentication');
    }
}
