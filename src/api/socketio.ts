/**
 * LocalLeaf Socket.io API - Real-time sync with Overleaf
 * Adapted from Overleaf-Workshop
 */

import * as vscode from 'vscode';
import { BaseAPI, ProjectEntity, FileEntity } from './base';
import { Identity } from '../utils/credentialManager';
import { validateProjectEntityName } from '../utils/pathSafety';
import {
    MAX_REMOTE_DOCUMENT_CHARACTERS,
    MAX_REMOTE_DOCUMENT_OPERATIONS,
    validateOverleafId,
    validateRemoteDocumentLines,
} from '../utils/remoteValidation';

const MAX_CONNECTED_USERS = 1000;
const MAX_CONNECTED_USER_RESPONSE_ITEMS = 10_000;
const MAX_PROFILE_FIELD_LENGTH = 4096;

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

function objectRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
    return typeof value === 'string' && value.length <= maximumLength ? value : undefined;
}

function safePosition(value: unknown): number | undefined {
    return Number.isSafeInteger(value) && (value as number) >= 0
        ? value as number
        : undefined;
}

function decodeSocketDocumentLines(value: unknown): string[] {
    const encodedLines = validateRemoteDocumentLines(value, 'Socket.IO document content');
    const lines = encodedLines.map(line => Buffer.from(line, 'ascii').toString('utf-8'));
    return validateRemoteDocumentLines(lines, 'decoded Socket.IO document content');
}

function parseDocumentUpdate(value: unknown): DocumentUpdate | undefined {
    const record = objectRecord(value);
    if (!record) return undefined;

    let doc: string;
    try {
        doc = validateOverleafId(record.doc, 'document ID');
    } catch {
        return undefined;
    }

    const version = safePosition(record.v);
    if (version === undefined) return undefined;

    let operations: DocumentUpdate['op'];
    if (record.op !== undefined) {
        if (!Array.isArray(record.op) || record.op.length > MAX_REMOTE_DOCUMENT_OPERATIONS) {
            return undefined;
        }
        operations = [];
        let operationCharacters = 0;
        for (const value of record.op) {
            const operation = objectRecord(value);
            const position = safePosition(operation?.p);
            if (!operation || position === undefined) return undefined;

            const insert = operation.i;
            const deletion = operation.d;
            const undo = operation.u;
            if (
                (insert !== undefined && typeof insert !== 'string')
                || (deletion !== undefined && typeof deletion !== 'string')
                || (undo !== undefined && typeof undo !== 'boolean')
            ) {
                return undefined;
            }
            operationCharacters += (insert as string | undefined)?.length ?? 0;
            operationCharacters += (deletion as string | undefined)?.length ?? 0;
            if (operationCharacters > MAX_REMOTE_DOCUMENT_CHARACTERS) return undefined;

            operations.push({
                p: position,
                ...(insert !== undefined ? { i: insert as string } : {}),
                ...(deletion !== undefined ? { d: deletion as string } : {}),
                ...(undo !== undefined ? { u: undo as boolean } : {}),
            });
        }
    }

    const lastVersion = record.lastV === undefined ? undefined : safePosition(record.lastV);
    if (record.lastV !== undefined && lastVersion === undefined) return undefined;
    const hash = record.hash === undefined ? undefined : boundedString(record.hash, 1024);
    if (record.hash !== undefined && hash === undefined) return undefined;

    let meta: DocumentUpdate['meta'];
    if (record.meta !== undefined) {
        const metaRecord = objectRecord(record.meta);
        const source = boundedString(metaRecord?.source, 1024);
        const timestamp = metaRecord ? Number(metaRecord.ts) : Number.NaN;
        const userId = boundedString(metaRecord?.user_id, 1024);
        if (!metaRecord || source === undefined || !Number.isFinite(timestamp) || userId === undefined) {
            return undefined;
        }
        meta = { source, ts: timestamp, user_id: userId };
    }

    return {
        doc,
        v: version,
        ...(operations !== undefined ? { op: operations } : {}),
        ...(lastVersion !== undefined ? { lastV: lastVersion } : {}),
        ...(hash !== undefined ? { hash } : {}),
        ...(meta !== undefined ? { meta } : {}),
    };
}

function parseOnlineUser(value: unknown): OnlineUser | undefined {
    const record = objectRecord(value);
    if (!record) return undefined;

    let clientId: string;
    try {
        clientId = validateOverleafId(record.client_id, 'client ID');
    } catch {
        return undefined;
    }

    const userId = boundedString(record.user_id, 1024);
    const firstName = boundedString(record.first_name, MAX_PROFILE_FIELD_LENGTH);
    const lastName = record.last_name === undefined
        ? undefined
        : boundedString(record.last_name, MAX_PROFILE_FIELD_LENGTH);
    const email = boundedString(record.email, MAX_PROFILE_FIELD_LENGTH);
    if (userId === undefined || firstName === undefined || email === undefined) return undefined;
    if (record.last_name !== undefined && lastName === undefined) return undefined;

    const cursor = record.cursorData === undefined ? undefined : objectRecord(record.cursorData);
    if (record.cursorData !== undefined && !cursor) return undefined;
    const docId = cursor ? boundedString(cursor.doc_id, 1024) : '';
    const row = cursor ? safePosition(cursor.row) : 0;
    const column = cursor ? safePosition(cursor.column) : 0;
    if (docId === undefined || row === undefined || column === undefined) return undefined;

    const rawLastUpdated = Number(record.last_updated_at);
    return {
        clientId,
        userId,
        name: [firstName, lastName].filter(Boolean).join(' '),
        email,
        docId,
        row,
        column,
        lastUpdated: Number.isFinite(rawLastUpdated) ? rawLastUpdated : Date.now(),
    };
}

function parseUserCursorUpdate(value: unknown): UserCursorUpdate | undefined {
    const record = objectRecord(value);
    if (!record) return undefined;

    let id: string;
    try {
        id = validateOverleafId(record.id, 'client ID');
    } catch {
        return undefined;
    }
    const userId = boundedString(record.user_id, 1024);
    const name = boundedString(record.name, MAX_PROFILE_FIELD_LENGTH);
    const email = boundedString(record.email, MAX_PROFILE_FIELD_LENGTH);
    const docId = boundedString(record.doc_id, 1024);
    const row = safePosition(record.row);
    const column = safePosition(record.column);
    if (
        userId === undefined
        || name === undefined
        || email === undefined
        || docId === undefined
        || row === undefined
        || column === undefined
    ) {
        return undefined;
    }
    return { id, user_id: userId, name, email, doc_id: docId, row, column };
}

function parseFileEntityEvent(
    value: unknown,
    type: FileEntity['_type'],
): FileEntity | undefined {
    const record = objectRecord(value);
    if (!record) return undefined;
    try {
        return {
            _id: validateOverleafId(record._id, 'entity ID'),
            _type: type,
            name: validateProjectEntityName(record.name as string),
        };
    } catch {
        return undefined;
    }
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

        socket.on('forceDisconnect', (value: unknown) => {
            if (this.socket !== socket) return;
            const message = boundedString(value, MAX_PROFILE_FIELD_LENGTH)
                ?? 'Overleaf forced the socket to disconnect';
            log(`Force disconnected: ${message}`);
            this._connected = false;
            this.failConnection(socket, new Error(message || 'Overleaf forced the socket to disconnect'));
            // Check if force disconnect is auth-related
            const isAuthError = this.isAuthRelatedMessage(message);
            this.handlers.forEach(h => h.onDisconnected?.(isAuthError));
        });

        socket.on('error', (err: unknown) => {
            if (this.socket !== socket) return;
            log(`Socket error: ${errorMessage(err).slice(0, MAX_PROFILE_FIELD_LENGTH)}`);
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
            const rawMessage = err instanceof Error
                ? err.message
                : typeof err === 'object' && err !== null && 'message' in err
                    ? String(err.message)
                    : String(err);
            const message = rawMessage.slice(0, MAX_PROFILE_FIELD_LENGTH);
            log(`Connection rejected: ${message}`);
            this._connected = false;
            this.failConnection(socket, new Error(message || 'Socket connection rejected'));
        });

        socket.on('connectionAccepted', (_session: unknown, value: unknown) => {
            if (this.socket !== socket) return;
            try {
                this._publicId = validateOverleafId(value, 'public client ID');
            } catch {
                this.failConnection(socket, new Error('Overleaf returned an invalid public client ID.'));
            }
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
                if (project === null || typeof project !== 'object') {
                    this.failConnection(socket, new Error('Overleaf returned incomplete project metadata.'));
                    return;
                }
                try {
                    this._publicId = validateOverleafId(publicId, 'public client ID');
                } catch (error) {
                    this.failConnection(socket, error as Error);
                    return;
                }
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
            socket.on('reciveNewDoc', (parentValue: unknown, docValue: unknown) => {
                const doc = parseFileEntityEvent(docValue, 'doc');
                try {
                    if (doc) handlers.onFileCreated!(validateOverleafId(parentValue, 'parent folder ID'), 'doc', doc);
                } catch {
                    // Ignore malformed filesystem events.
                }
            });
            socket.on('reciveNewFile', (parentValue: unknown, fileValue: unknown) => {
                const file = parseFileEntityEvent(fileValue, 'file');
                try {
                    if (file) handlers.onFileCreated!(validateOverleafId(parentValue, 'parent folder ID'), 'file', file);
                } catch {
                    // Ignore malformed filesystem events.
                }
            });
            socket.on('reciveNewFolder', (parentValue: unknown, folderValue: unknown) => {
                const folder = parseFileEntityEvent(folderValue, 'folder');
                try {
                    if (folder) handlers.onFileCreated!(
                        validateOverleafId(parentValue, 'parent folder ID'),
                        'folder',
                        folder,
                    );
                } catch {
                    // Ignore malformed filesystem events.
                }
            });
        }

        if (handlers.onFileRenamed) {
            socket.on('reciveEntityRename', (entityValue: unknown, nameValue: unknown) => {
                try {
                    handlers.onFileRenamed!(
                        validateOverleafId(entityValue, 'entity ID'),
                        validateProjectEntityName(nameValue as string),
                    );
                } catch {
                    // Ignore malformed filesystem events.
                }
            });
        }

        if (handlers.onFileRemoved) {
            socket.on('removeEntity', (value: unknown) => {
                try {
                    handlers.onFileRemoved!(validateOverleafId(value, 'entity ID'));
                } catch {
                    // Ignore malformed filesystem events.
                }
            });
        }

        if (handlers.onFileMoved) {
            socket.on('reciveEntityMove', (entityValue: unknown, folderValue: unknown) => {
                try {
                    handlers.onFileMoved!(
                        validateOverleafId(entityValue, 'entity ID'),
                        validateOverleafId(folderValue, 'parent folder ID'),
                    );
                } catch {
                    // Ignore malformed filesystem events.
                }
            });
        }

        if (handlers.onFileChanged) {
            socket.on('otUpdateApplied', (value: unknown) => {
                const update = parseDocumentUpdate(value);
                if (update) handlers.onFileChanged!(update);
            });
        }

        // Collaboration events
        if (handlers.onUserCursorUpdated) {
            socket.on('clientTracking.clientUpdated', (value: unknown) => {
                const user = parseUserCursorUpdate(value);
                if (user) handlers.onUserCursorUpdated!(user);
            });
        }

        if (handlers.onUserDisconnected) {
            socket.on('clientTracking.clientDisconnected', (value: unknown) => {
                try {
                    handlers.onUserDisconnected!(validateOverleafId(value, 'client ID'));
                } catch {
                    // Ignore malformed presence events.
                }
            });
        }

        // Project settings events
        if (handlers.onRootDocUpdated) {
            socket.on('rootDocUpdated', (value: unknown) => {
                try {
                    handlers.onRootDocUpdated!(value === '' ? '' : validateOverleafId(value, 'root document ID'));
                } catch {
                    // Ignore malformed project events.
                }
            });
        }

        if (handlers.onCompilerUpdated) {
            socket.on('compilerUpdated', (value: unknown) => {
                const compiler = boundedString(value, 255);
                if (compiler) handlers.onCompilerUpdated!(compiler);
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
        const safeDocId = validateOverleafId(docId, 'document ID');
        const response = await this.emit('joinDoc', safeDocId, {
            encodeRanges: true,
        });
        const lines = decodeSocketDocumentLines(response[0]);
        const version = safePosition(response[1]);
        if (version === undefined) {
            throw new Error('Overleaf returned an invalid document version.');
        }

        return { lines, version };
    }

    /**
     * Leave a document
     */
    async leaveDoc(docId: string): Promise<void> {
        await this.emit('leaveDoc', validateOverleafId(docId, 'document ID'));
    }

    /**
     * Apply OT update to a document
     */
    async applyOtUpdate(docId: string, update: DocumentUpdate): Promise<void> {
        const safeDocId = validateOverleafId(docId, 'document ID');
        const safeUpdate = parseDocumentUpdate(update);
        if (!safeUpdate || safeUpdate.doc !== safeDocId) {
            throw new Error('Refusing to send an invalid document update.');
        }
        await this.emit('applyOtUpdate', safeDocId, safeUpdate);
    }

    /**
     * Get connected users
     */
    async getConnectedUsers(): Promise<OnlineUser[]> {
        const [value] = await this.emit('clientTracking.getConnectedUsers');
        if (!Array.isArray(value) || value.length > MAX_CONNECTED_USER_RESPONSE_ITEMS) {
            throw new Error('Overleaf returned an invalid connected-user list.');
        }

        const users: OnlineUser[] = [];
        for (const item of value) {
            const user = parseOnlineUser(item);
            if (user) users.push(user);
            if (users.length >= MAX_CONNECTED_USERS) break;
        }
        return users;
    }

    /**
     * Update cursor position
     */
    async updatePosition(docId: string, row: number, column: number): Promise<void> {
        const safeRow = safePosition(row);
        const safeColumn = safePosition(column);
        if (safeRow === undefined || safeColumn === undefined) {
            throw new Error('Refusing to send an invalid cursor position.');
        }
        await this.emit('clientTracking.updatePosition', {
            row: safeRow,
            column: safeColumn,
            doc_id: validateOverleafId(docId, 'document ID'),
        });
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
