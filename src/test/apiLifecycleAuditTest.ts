import { runStandaloneTest } from './standaloneRunner';
import * as assert from 'assert';
import * as http from 'http';
import { EventEmitter } from 'events';
import * as path from 'path';
import type { BaseAPI as BaseAPIType, ProjectEntity } from '../api/base';
import type { SocketIOAPI as SocketIOAPIType } from '../api/socketio';

// Keep HTTP real in this process; the main unit suite replaces node-fetch.
const Module = require('module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = Module._load;
let BaseAPI: typeof BaseAPIType;
let SocketIOAPI: typeof SocketIOAPIType;
let browserCookieLoginInternals: typeof import('../auth/browserCookieLogin').browserCookieLoginInternals;
try {
    Module._load = function (request, parent, isMain) {
        return request === 'vscode' ? {} : originalLoad.call(this, request, parent, isMain);
    };
    ({ BaseAPI } = require(path.join(__dirname, '..', 'api', 'base.js')));
    ({ SocketIOAPI } = require(path.join(__dirname, '..', 'api', 'socketio.js')));
    ({ browserCookieLoginInternals } = require(path.join(__dirname, '..', 'auth', 'browserCookieLogin.js')));
} finally {
    Module._load = originalLoad;
}

async function testHttpLifecycleAndRevisions(): Promise<void> {
    const requests: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
    let respond = (_request: http.IncomingMessage, response: http.ServerResponse) => {
        response.writeHead(500).end();
    };
    const server = http.createServer((request, response) => {
        requests.push({ url: request.url || '', headers: request.headers });
        request.resume();
        respond(request, response);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const clients: BaseAPIType[] = [];
    const client = () => {
        const api = new BaseAPI(`${origin}/overleaf`).setIdentity({ csrfToken: 'test-csrf', cookies: 'test=session' });
        clients.push(api);
        return api;
    };
    try {
        const closing = client();
        const pending = closing.getProjects();
        closing.dispose();
        await assert.rejects(pending, /sync session was closed/);
        assert.equal(requests.length, 0, 'disposal while the fetch module loads must prevent a request');
        assert.throws(() => closing.initSocket({ csrfToken: 'test', cookies: 'test=session' }), /session was closed/);

        for (const redirect of ['/overleaf/project', '/overleaf/project/', `${origin}/overleaf/project`, 'project']) {
            requests.length = 0;
            respond = (request, response) => {
                if (request.url === '/overleaf/login' && request.method === 'GET') {
                    response.setHeader('Set-Cookie', 'initial=session; Path=/overleaf');
                    response.end('<input name="_csrf" value="test-csrf">');
                } else if (request.url === '/overleaf/login' && request.method === 'POST') {
                    response.writeHead(303, { Location: redirect, 'Set-Cookie': 'test=authenticated; Path=/overleaf' }).end();
                } else if (request.url === '/overleaf/project') {
                    response.end('<meta name="ol-user_id" content="test-user"><meta name="ol-csrfToken" content="test-csrf">');
                } else if (request.url === '/overleaf/socket.io/socket.io.js') {
                    response.end('');
                } else {
                    response.writeHead(404).end();
                }
            };
            const result = await client().passportLogin('test@example.invalid', 'test-password');
            assert.equal(result.type, 'success', `Location-only login redirect ${redirect}`);
            assert.ok(requests.find(request => request.url === '/overleaf/project')?.headers.cookie?.includes('test=authenticated'));
        }
        for (const redirect of ['https://example.invalid/project', '/project', '/overleaf/project?next=other', '//user:password@localhost/project']) {
            requests.length = 0;
            respond = (request, response) => {
                if (request.method === 'GET') response.end('<input name="_csrf" value="test-csrf">');
                else response.writeHead(302, { Location: redirect, 'Set-Cookie': 'test=session' }).end();
            };
            assert.equal((await client().passportLogin('test@example.invalid', 'test-password')).type, 'error');
            assert.equal(requests.length, 2, 'untrusted or unrelated redirects must not receive an authenticated follow-up');
        }

        const modified = 'Sat, 12 Sep 2026 10:00:00 GMT';
        for (const variant of ['etag', 'last-modified', 'changed-total', 'changed-etag', 'missing-etag'] as const) {
            requests.length = 0;
            respond = (_request, response) => {
                const first = requests.length === 1;
                const total = variant === 'changed-total' && !first ? 7 : 6;
                const headers: Record<string, string> = {
                    'Content-Range': first ? 'bytes 0-2/6' : `bytes 3-${total - 1}/${total}`,
                };
                if (variant === 'last-modified') headers['Last-Modified'] = modified;
                else if (variant !== 'missing-etag' || first) {
                    headers.ETag = variant === 'changed-etag' && !first ? '"new"' : '"original"';
                }
                response.writeHead(206, headers).end(first ? 'abc' : total === 7 ? 'defg' : 'def');
            };
            const result = await client().getFile('test-project', 'test-file');
            const stable = variant === 'etag' || variant === 'last-modified';
            assert.equal(result.type, stable ? 'success' : 'error', variant);
            if (stable) assert.equal(Buffer.from(result.content!).toString(), 'abcdef');
            else assert.match(result.message || '', /changed during its partial download/);
            assert.equal(requests[1]?.headers['if-range'], variant === 'last-modified' ? modified : '"original"');
        }

        requests.length = 0;
        let sawHandshake!: () => void;
        const handshake = new Promise<void>(resolve => { sawHandshake = resolve; });
        respond = (_request, response) => {
            response.writeHead(400).end('test handshake rejected');
            sawHandshake();
        };
        const socket = client().initSocket({ csrfToken: 'test', cookies: 'test=session' });
        socket.on('error', () => undefined);
        try {
            await handshake;
            assert.match(requests[0]?.url || '', /^\/overleaf\/socket\.io\/1\//,
                'socket handshake must honor the same reverse-proxy base path as HTTP');
        } finally {
            socket.disconnect();
        }

        const controller = new AbortController();
        const deadline = new browserCookieLoginInternals.LoginDeadline(5000, controller.signal);
        let requestStarted!: () => void;
        const started = new Promise<void>(resolve => { requestStarted = resolve; });
        respond = () => { requestStarted(); };
        const readingCookies = browserCookieLoginInternals.sendCookieCommand(
            new URL(`ws://127.0.0.1:${address.port}/devtools/test`),
            [`${origin}/overleaf/project`],
            deadline,
        );
        const cancelled = assert.rejects(readingCookies, /cancelled/);
        try {
            await started;
            controller.abort();
            await cancelled;
            // ClientRequest emits its terminal socket-hang-up error after the
            // rejected login promise. It must remain handled during cleanup.
            await new Promise<void>(resolve => setImmediate(resolve));
        } finally {
            deadline.dispose();
        }
    } finally {
        for (const api of clients) api.dispose();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

class SnapshotSocket extends EventEmitter {
    disconnected = false;
    readonly documents = new Set<string>();
    override emit(event: string, ...args: any[]): boolean {
        const callback = args[args.length - 1];
        if (event === 'joinDoc' && typeof callback === 'function') {
            this.documents.add(args[0]);
            callback(null, ['test document'], 0);
        }
        return true;
    }
    receive(event: string, ...args: unknown[]): void { super.emit(event, ...args); }
    disconnect(): void {
        this.disconnected = true;
        this.receive('disconnect', 'test closed');
    }
}

async function testNonDisruptiveProjectRefresh(): Promise<void> {
    const sockets: SnapshotSocket[] = [];
    const queries: Array<string | undefined> = [];
    let nextSnapshot: 'success' | 'failure' | 'stall' = 'success';
    const project = { _id: 'test-project', rootFolder: [{ _id: 'root', docs: [], fileRefs: [], folders: [] }] } as unknown as ProjectEntity;
    const api = {
        initSocket: (_identity: unknown, query?: string) => {
            const socket = new SnapshotSocket();
            sockets.push(socket);
            queries.push(query);
            const publicId = `client-${sockets.length}`;
            const behavior = nextSnapshot;
            nextSnapshot = 'success';
            setImmediate(() => {
                if (socket.disconnected || behavior === 'stall') return;
                socket.receive('connect');
                if (!query || behavior === 'failure') socket.receive('connectionRejected', 'test project join rejected');
                else socket.receive('joinProjectResponse', { publicId, project: { ...project } });
            });
            return socket;
        },
    } as unknown as BaseAPIType;
    const subject = new SocketIOAPI(api, { csrfToken: 'test', cookies: 'test=session' }, 'test-project');
    let connections = 0;
    let disconnections = 0;
    subject.registerHandlers({ onConnected: () => { connections++; }, onDisconnected: () => { disconnections++; } });
    try {
        await subject.joinProject();
        await subject.joinDoc('test-document');
        const live = sockets[1];
        const publicId = subject.publicId;
        const refresh = subject.refreshProject();
        assert.strictEqual(subject.refreshProject(), refresh, 'concurrent refreshes must share one snapshot connection');
        await refresh;
        assert.equal(sockets.length, 3);
        assert.equal(sockets[2].disconnected, true);
        assert.equal(subject.isConnected, true);
        assert.equal(subject.publicId, publicId);
        assert.equal(live.disconnected, false);
        assert.ok(live.documents.has('test-document'));
        assert.equal(connections, 1, 'refresh must not announce a new live connection');
        assert.equal(disconnections, 0);

        nextSnapshot = 'failure';
        await assert.rejects(subject.refreshProject(), /test project join rejected/);
        assert.equal(sockets[3].disconnected, true, 'failed snapshot must be disposed');
        assert.equal(subject.publicId, publicId);
        assert.equal(subject.isConnected, true);
        assert.equal(disconnections, 0, 'snapshot errors must not disconnect the live client');

        const beforeReconnect = sockets.length;
        await subject.reconnect();
        assert.equal(sockets.length, beforeReconnect + 1, 'known query protocol must reconnect without another rejected legacy probe');
        assert.match(queries[queries.length - 1] || '', /^\?projectId=/);

        nextSnapshot = 'stall';
        const cancelled = assert.rejects(subject.refreshProject(), /disposed/);
        subject.disconnect();
        await cancelled;
        assert.equal(sockets[sockets.length - 1].disconnected, true, 'closing the workspace must cancel a pending snapshot');
    } finally {
        subject.disconnect();
    }
}

async function run(): Promise<void> {
    await testHttpLifecycleAndRevisions();
    await testNonDisruptiveProjectRefresh();
    console.log('API lifecycle, login redirects/cancellation, partial revisions, and isolated socket refresh tests passed.');
}

runStandaloneTest(run);
