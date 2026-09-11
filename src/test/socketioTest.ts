import * as assert from 'assert';
import * as path from 'path';
import type { BaseAPI, FileEntity, ProjectEntity } from '../api/base';
import type { Identity } from '../utils/credentialManager';
import type { SocketEventHandlers } from '../api/socketio';

type Listener = (...args: unknown[]) => void;
type EmitCallback = (error?: unknown, ...data: unknown[]) => void;

class FakeSocket {
    private readonly listeners = new Map<string, Listener[]>();
    readonly emitted: Array<{ event: string; args: unknown[] }> = [];
    disconnected = false;
    onEmit?: (event: string, args: unknown[], callback?: EmitCallback) => void;

    on(event: string, listener: Listener): this {
        const listeners = this.listeners.get(event) || [];
        listeners.push(listener);
        this.listeners.set(event, listeners);
        return this;
    }

    emit(event: string, ...args: unknown[]): this {
        const callback = typeof args[args.length - 1] === 'function'
            ? args.pop() as EmitCallback
            : undefined;
        this.emitted.push({ event, args });
        this.onEmit?.(event, args, callback);
        return this;
    }

    trigger(event: string, ...args: unknown[]): void {
        for (const listener of this.listeners.get(event) || []) {
            listener(...args);
        }
    }

    removeAllListeners(): this {
        this.listeners.clear();
        return this;
    }

    disconnect(): this {
        this.disconnected = true;
        this.trigger('disconnect');
        return this;
    }
}

class FakeApi {
    readonly queries: Array<string | undefined> = [];
    readonly sockets: FakeSocket[] = [];

    constructor(
        private readonly configure: (
            socket: FakeSocket,
            attempt: number,
            query: string | undefined,
        ) => void,
    ) {}

    initSocket(_identity: Identity, query?: string): FakeSocket {
        const socket = new FakeSocket();
        const attempt = this.sockets.length;
        this.queries.push(query);
        this.sockets.push(socket);
        setImmediate(() => this.configure(socket, attempt, query));
        return socket;
    }
}

const project: ProjectEntity = {
    _id: 'project-id',
    name: 'Protocol test',
    rootDoc_id: 'doc-id',
    rootFolder: [{
        _id: 'root-folder-id',
        _type: 'folder',
        name: 'rootFolder',
        docs: [{ _id: 'doc-id', _type: 'doc', name: 'main.tex' }],
        fileRefs: [],
        folders: [],
    }],
    owner: { _id: 'owner-id', email: 'owner@example.test', first_name: 'Owner' },
    members: [],
};

export async function runSocketIOProtocolTests(): Promise<void> {
    // Use an absolute module path so runTest's SyncEngine-only SocketIO mock does
    // not hide the real protocol negotiator from these focused tests.
    const { SocketIOAPI } = require(path.join(__dirname, '..', 'api', 'socketio.js')) as {
        SocketIOAPI: new (api: BaseAPI, identity: Identity, projectId: string) => {
            registerHandlers(handlers: {
                onFileCreated?: (
                    parentFolderId: string,
                    type: 'doc' | 'file' | 'folder',
                    entity: FileEntity,
                ) => void;
                onDisconnected?: (isAuthError?: boolean) => void;
            }): void;
            joinProject(): Promise<ProjectEntity>;
            reconnect(): Promise<ProjectEntity>;
            joinDoc(id: string): Promise<unknown>;
            disconnect(): void;
        };
    };
    const identity = { cookies: 'overleaf.sid=test', csrfToken: 'csrf' };

    const legacyApi = new FakeApi((socket, _attempt, query) => {
        assert.equal(query, undefined, 'the first attempt must use the legacy event protocol');
        socket.onEmit = (event, args, callback) => {
            if (event === 'joinProject') {
                assert.deepStrictEqual(args, [{ project_id: project._id }]);
                callback?.(undefined, project, 'owner', 1);
            }
        };
        socket.trigger('connect');
        socket.trigger('connectionAccepted', {}, 'legacy-public-id');
    });
    const legacySocket = new SocketIOAPI(
        legacyApi as unknown as BaseAPI,
        identity,
        project._id,
    );
    const joinedDisconnects: Array<boolean | undefined> = [];
    legacySocket.registerHandlers({
        onDisconnected: isAuthError => joinedDisconnects.push(isAuthError),
    });
    assert.equal(await legacySocket.joinProject(), project);
    assert.deepStrictEqual(legacyApi.queries, [undefined]);
    legacyApi.sockets[0].trigger('connectionRejected', { message: 'Not authenticated' });
    assert.deepStrictEqual(
        joinedDisconnects,
        [true],
        'a rejection after joining must notify SyncEngine and preserve its auth classification',
    );
    const authClassifier = legacySocket as unknown as {
        isAuthRelatedMessage(message: string): boolean;
    };
    assert.equal(authClassifier.isAuthRelatedMessage('403 project permission denied'), false);
    assert.equal(authClassifier.isAuthRelatedMessage('failure in authentication-notes.tex'), false);
    assert.equal(authClassifier.isAuthRelatedMessage('Connection rejected: Not authenticated'), true);
    legacySocket.disconnect();

    const rootEvents: Array<{ parentId: string; type: string; name: string }> = [];
    const moves: string[] = [];
    const rootApi = new FakeApi(socket => {
        socket.onEmit = (event, _args, callback) => {
            if (event === 'joinProject') callback?.(undefined, project);
        };
        socket.trigger('connect');
    });
    const rootSocket = new SocketIOAPI(rootApi as unknown as BaseAPI, identity, project._id);
    rootSocket.registerHandlers({
        onFileCreated: (parentId, type, entity) => rootEvents.push({ parentId, type, name: entity.name }),
        onFileMoved: (_id: string, parentId: string) => moves.push(parentId),
    } as SocketEventHandlers);
    await rootSocket.joinProject();
    rootApi.sockets[0].trigger('reciveNewFile', null, { _id: 'restored-pdf', name: 'main-old.pdf' });
    rootApi.sockets[0].trigger('reciveNewDoc', undefined, { _id: 'restored-doc', name: 'old.tex' });
    rootApi.sockets[0].trigger('reciveNewFolder', null, { _id: 'restored-folder', name: 'restored' });
    rootApi.sockets[0].trigger('reciveEntityMove', 'restored-pdf', null);
    assert.deepStrictEqual(rootEvents, [
        { parentId: 'root-folder-id', type: 'file', name: 'main-old.pdf' },
        { parentId: 'root-folder-id', type: 'doc', name: 'old.tex' },
        { parentId: 'root-folder-id', type: 'folder', name: 'restored' },
    ], 'a missing parent in Overleaf events denotes the joined project root');
    assert.deepStrictEqual(moves, ['root-folder-id']);
    for (const malformedParent of ['', 0, false, {}, []]) {
        rootApi.sockets[0].trigger('reciveNewFile', malformedParent, { _id: 'unsafe', name: 'unsafe.pdf' });
        rootApi.sockets[0].trigger('reciveEntityMove', 'restored-pdf', malformedParent);
    }
    assert.equal(rootEvents.length, 3, 'invalid parent values must not be silently redirected to the root');
    assert.equal(moves.length, 1);
    rootSocket.disconnect();

    let fileEvents = 0;
    let negotiationDisconnects = 0;
    const queryApi = new FakeApi((socket, attempt, query) => {
        if (attempt % 2 === 0) {
            assert.equal(query, undefined);
            socket.trigger('connect');
            socket.trigger('connectionRejected', { message: 'project query required' });
            return;
        }

        assert.match(query || '', /^\?projectId=project-id&t=\d+$/);
        socket.trigger('connect');
        socket.trigger('joinProjectResponse', {
            publicId: 'query-public-id',
            project,
        });
        socket.trigger(
            'reciveNewDoc',
            'root-folder-id',
            { _id: 'new-doc-id', _type: 'doc', name: 'new.tex' },
        );
    });
    const querySocket = new SocketIOAPI(
        queryApi as unknown as BaseAPI,
        identity,
        project._id,
    );
    querySocket.registerHandlers({
        onFileCreated: () => { fileEvents++; },
        onDisconnected: () => { negotiationDisconnects++; },
    });
    assert.equal(await querySocket.joinProject(), project);
    assert.equal(queryApi.sockets.length, 2, 'a rejected legacy join must open one clean query retry');
    assert.equal(queryApi.sockets[0].disconnected, true, 'the rejected socket must be closed before retrying');
    assert.equal(fileEvents, 1, 'remote event handlers must be restored on the retry socket');
    assert.equal(
        negotiationDisconnects,
        0,
        'an initial protocol rejection must not flash a disconnected state before fallback succeeds',
    );
    const pendingRead = querySocket.joinDoc('doc-id');
    const cancelledRead = assert.rejects(pendingRead, /Socket disconnected/,
        'transport loss must cancel a large read immediately, without waiting two minutes');
    queryApi.sockets[1].trigger('disconnect');
    await cancelledRead;
    const recovering = querySocket.reconnect();
    assert.equal(querySocket.reconnect(), recovering, 'concurrent recovery requests must share one negotiation');
    assert.equal(await recovering, project);
    assert.equal(queryApi.sockets.length, 4);
    assert.equal(fileEvents, 2, 'existing event handlers must remain attached after automatic recovery');
    assert.equal(negotiationDisconnects, 1, 'recovery negotiation must not trigger additional recovery loops');
    querySocket.disconnect();
    await assert.rejects(querySocket.reconnect(), /disposed/);
    assert.equal(queryApi.sockets.length, 4, 'a disposed workspace must not open another socket');

    for (const authMessage of ['not logged in', 'Not authenticated', 'invalid session', '401 Unauthorized']) {
        const authApi = new FakeApi((socket, _attempt, query) => {
            assert.equal(query, undefined);
            socket.trigger('connect');
            socket.trigger('connectionRejected', { message: authMessage });
        });
        const authSocket = new SocketIOAPI(
            authApi as unknown as BaseAPI,
            identity,
            project._id,
        );
        await assert.rejects(authSocket.joinProject(), new RegExp(authMessage, 'i'));
        assert.equal(
            authApi.sockets.length,
            1,
            `an authentication failure (${authMessage}) must not retry another protocol`,
        );
        authSocket.disconnect();
    }

    const doubleFailureApi = new FakeApi((socket, attempt) => {
        socket.trigger('connect');
        socket.trigger('connectionRejected', {
            message: attempt === 0 ? 'project query required' : 'invalid session',
        });
    });
    const doubleFailureSocket = new SocketIOAPI(
        doubleFailureApi as unknown as BaseAPI,
        identity,
        project._id,
    );
    let doubleFailure: unknown;
    try {
        await doubleFailureSocket.joinProject();
    } catch (error) {
        doubleFailure = error;
    }
    assert.ok(doubleFailure instanceof Error);
    assert.equal(doubleFailure.message, 'invalid session',
        'an authentication rejection from the query retry must remain classifiable by SyncEngine');
    assert.equal(doubleFailureApi.sockets.length, 2);
    doubleFailureSocket.disconnect();

    const twoProtocolErrorsApi = new FakeApi((socket, attempt) => {
        socket.trigger('connect');
        socket.trigger('connectionRejected', {
            message: attempt === 0 ? 'legacy project join unavailable' : 'query project join unavailable',
        });
    });
    const twoProtocolErrorsSocket = new SocketIOAPI(
        twoProtocolErrorsApi as unknown as BaseAPI,
        identity,
        project._id,
    );
    let twoProtocolErrors: unknown;
    try {
        await twoProtocolErrorsSocket.joinProject();
    } catch (error) {
        twoProtocolErrors = error;
    }
    assert.ok(twoProtocolErrors instanceof Error);
    assert.match(twoProtocolErrors.message, /Legacy protocol: legacy project join unavailable/);
    assert.match(twoProtocolErrors.message, /Project-query protocol: query project join unavailable/);
    assert.ok(twoProtocolErrors.cause instanceof Error);
    assert.equal(twoProtocolErrors.cause.message, 'legacy project join unavailable');
    twoProtocolErrorsSocket.disconnect();

    let pendingLegacyCallback: EmitCallback | undefined;
    const disposedApi = new FakeApi((socket, _attempt, query) => {
        assert.equal(query, undefined);
        socket.onEmit = (event, _args, callback) => {
            if (event === 'joinProject') pendingLegacyCallback = callback;
        };
        socket.trigger('connect');
    });
    const disposedSocket = new SocketIOAPI(
        disposedApi as unknown as BaseAPI,
        identity,
        project._id,
    );
    const pendingJoin = disposedSocket.joinProject();
    await new Promise<void>(resolve => setImmediate(resolve));
    disposedSocket.disconnect();
    pendingLegacyCallback?.(undefined, project, 'owner', 1);
    await assert.rejects(pendingJoin, /disposed/);
    assert.equal(
        disposedApi.sockets.length,
        1,
        'an intentional disconnect must never start a protocol-fallback socket',
    );
}
