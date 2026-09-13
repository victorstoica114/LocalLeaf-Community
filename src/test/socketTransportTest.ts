import * as assert from 'assert';
import * as http from 'http';
import * as path from 'path';
import { once } from 'events';
import type { BaseAPI } from '../api/base';
import type { SocketIOAPI as SocketAPI } from '../api/socketio';

/** Exercise the actual legacy client against HTTP/WebSocket transports. */
export async function runSocketTransportTests(): Promise<void> {
    const { SocketIOAPI } = require(path.join(__dirname, '..', 'api', 'socketio.js')) as {
        SocketIOAPI: typeof SocketAPI;
    };
    const client = require('./socketClientBundleSmoke.js') as SocketIOClientStatic;
    let respond: (request: http.IncomingMessage, response: http.ServerResponse) => void = () => {};
    const server = http.createServer((request, response) => respond(request, response));
    const connections = new Set<import('net').Socket>();
    const WebSocket = require('ws') as any;
    let received: ((connection: any, data: string) => void) | undefined;
    let latestConnection: any;
    const websocketServer = new WebSocket.Server({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
        websocketServer.handleUpgrade(request, socket, head, (connection: any) => {
            latestConnection = connection;
            assert.equal(request.headers.cookie, 'test-session=1');
            connection.send('1::');
            connection.on('message', (data: Buffer) => {
                if (received) { received(connection, String(data)); return; }
                const packet = /^5:(\d+)\+::(.+)$/.exec(String(data));
                if (!packet || JSON.parse(packet[2]).name !== 'joinProject') return;
                setTimeout(() => {
                    if (connection.readyState === WebSocket.OPEN) connection.send(
                        `6:::${packet[1]}+${JSON.stringify([null, { _id: 'test-project', rootFolder: [] }])}`,
                    );
                }, 30);
            });
        });
    });
    server.on('connection', connection => {
        connections.add(connection);
        connection.on('close', () => connections.delete(connection));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const sockets: SocketIOClient.Socket[] = [];
    const api = {
        initSocket: (_identity: unknown, query?: string) => {
            const socket = client.connect(origin + (query ?? ''), {
                reconnect: false,
                'force new connection': true,
                extraHeaders: { Origin: origin, Cookie: 'test-session=1' },
            } as SocketIOClient.ConnectOpts);
            sockets.push(socket);
            return socket;
        },
    } as unknown as BaseAPI;
    const identity = { cookies: 'test-session=1', csrfToken: 'test' };
    let subject: SocketAPI | undefined;
    try {
        // A server that never completes its HTTP handshake must lose its TCP
        // connection as soon as the workspace is closed, even before WebSocket.
        const requested = new Promise<void>(resolve => {
            respond = () => resolve();
        });
        subject = new SocketIOAPI(api, identity, 'test-project');
        const pending = assert.rejects(subject.joinProject(), /disposed/);
        await requested;
        subject.disconnect();
        await pending;
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(connections.size, 0, 'disposing a pending handshake must abort its HTTP request');

        respond = (_request, response) => {
            response.writeHead(503, { 'Content-Type': 'text/html' });
            response.end('<html>private gateway response must not appear in logs</html>');
        };
        subject = new SocketIOAPI(api, identity, 'test-project');
        (subject as unknown as { initialRetryDelaysMs: number[] }).initialRetryDelaysMs = [];
        const started = Date.now();
        await assert.rejects(subject.joinProject(), error => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /HTTP 503/);
            assert.doesNotMatch(error.message, /private gateway|<html>|handshake timeout/);
            return true;
        });
        assert.ok(Date.now() - started < 1000, 'HTTP errors must fail immediately, without the handshake deadline');
        subject.disconnect();

        // A slow handshake and a project ACK have their own time budgets.
        // Exercise an actual delay above the old five-second deadline.
        respond = (_request, response) => {
            setTimeout(() => response.end('test-session:60:60:websocket'), 5100);
        };
        subject = new SocketIOAPI(api, identity, 'test-project');
        (subject as unknown as { socketEventTimeoutMs: number }).socketEventTimeoutMs = 1;
        assert.equal((await subject.joinProject())._id, 'test-project');
        subject.disconnect();

        let requests = 0;
        respond = (_request, response) => {
            if (++requests <= 2) {
                response.writeHead(503);
                response.end('temporarily unavailable');
            } else response.end('test-session:60:60:websocket');
        };
        subject = new SocketIOAPI(api, identity, 'test-project');
        (subject as unknown as { initialRetryDelaysMs: number[] }).initialRetryDelaysMs = [1, 1];
        assert.equal((await subject.joinProject())._id, 'test-project');
        assert.equal(requests, 3, 'a temporary initial failure must reconnect automatically');
        subject.disconnect();

        requests = 0;
        respond = (_request, response) => {
            requests++;
            response.writeHead(401);
            response.end('private authentication response');
        };
        subject = new SocketIOAPI(api, identity, 'test-project');
        await assert.rejects(subject.joinProject(), /^Error: 401 Unauthorized: .*HTTP 401/);
        assert.equal(requests, 1, 'an expired session must not retry or negotiate another protocol');
        subject.disconnect();

        requests = 0;
        respond = (_request, response) => {
            response.writeHead(++requests === 1 ? 503 : 403);
            response.end();
        };
        subject = new SocketIOAPI(api, identity, 'test-project');
        await assert.rejects(subject.joinProject(), /HTTP 403/);
        assert.equal(requests, 2, 'a definitive query rejection must not retry because an earlier protocol had a temporary error');
        subject.disconnect();

        requests = 0;
        respond = (_request, response) => {
            requests++;
            response.writeHead(503);
            response.end();
        };
        subject = new SocketIOAPI(api, identity, 'test-project');
        (subject as unknown as { initialRetryDelaysMs: number[] }).initialRetryDelaysMs = [1, 1];
        await assert.rejects(subject.joinProject(), /HTTP 503/);
        assert.equal(requests, 6, 'initial recovery must stop after three two-protocol attempts');
        subject.disconnect();

        requests = 0;
        respond = (_request, response) => {
            requests++;
            response.writeHead(503);
            response.end();
        };
        subject = new SocketIOAPI(api, identity, 'test-project');
        const cancelledRetry = assert.rejects(subject.joinProject(), /disposed/);
        for (let wait = 0; wait < 100 && !(subject as any).cancelConnectionRetry; wait++) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.ok((subject as any).cancelConnectionRetry, 'the failure must schedule a retry');
        subject.disconnect();
        await cancelledRetry;
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(requests, 2, 'closing the workspace must cancel scheduled connection retries');

        // Established sessions: use the actual bundled Socket.IO client and
        // real TCP/WebSocket connections through repeated outages and silence.
        let cursorPackets = 0;
        let heartbeatReplies = 0;
        let remoteUpdates = 0;
        let disconnects = 0;
        respond = (_request, response) => response.end('test-session:0.2:0.2:websocket');
        received = (connection, data) => {
            if (data === '2::') { heartbeatReplies++; return; }
            const eventPacket = /^5:(\d*)\+?::(.+)$/.exec(data);
            if (!eventPacket) return;
            const event = JSON.parse(eventPacket[2]);
            if (event.name === 'clientTracking.updatePosition') {
                cursorPackets++;
                assert.equal(eventPacket[1], '', 'cursor packets must not allocate acknowledgement callbacks');
                return; // Deliberately never acknowledge optional presence.
            }
            const response = event.name === 'joinProject' ? [null, { _id: 'test-project', rootFolder: [] }]
                : event.name === 'joinDoc' ? [null, ['A'], 1]
                    : [null, []];
            connection.send(`6:::${eventPacket[1]}+${JSON.stringify(response)}`);
        };
        subject = new SocketIOAPI(api, identity, 'test-project');
        (subject as any).socketEventTimeoutMs = 10;
        subject.registerHandlers({
            onDisconnected: () => { disconnects++; },
            onFileChanged: () => { remoteUpdates++; },
        });
        await subject.joinProject();
        for (let cycle = 0; cycle < 10; cycle++) {
            await subject.joinDoc('test-doc');
            await subject.updatePosition('test-doc', cycle, 0);
            latestConnection.send('2::');
            await new Promise(resolve => setTimeout(resolve, 25));
            assert.ok(subject.isConnected, 'unacknowledged cursor updates must not disconnect synchronization');
            await subject.getConnectedUsers();
            const updated = remoteUpdates + 1;
            latestConnection.send('5:::' + JSON.stringify({ name: 'otUpdateApplied', args: [{
                doc: 'test-doc', v: cycle, op: [{ p: 0, i: 'x' }],
            }] }));
            for (let wait = 0; wait < 100 && remoteUpdates < updated; wait++) {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            assert.equal(remoteUpdates, updated, 'remote listeners must survive each reconnection exactly once');
            latestConnection.terminate();
            for (let wait = 0; wait < 100 && subject.isConnected; wait++) {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            assert.equal(subject.isConnected, false);
            await subject.reconnect();
        }
        assert.equal(cursorPackets, 10);
        assert.equal(heartbeatReplies, 10);
        assert.equal(disconnects, 10);
        // Keep TCP open, but stop sending heartbeats and all application data.
        for (let wait = 0; wait < 100 && subject.isConnected; wait++) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(subject.isConnected, false, 'a silent half-open transport must expire its heartbeat deadline');
        await subject.reconnect();
        await subject.joinDoc('test-doc');
        await subject.getConnectedUsers();
        assert.ok(subject.isConnected);
        subject.disconnect();
    } finally {
        subject?.disconnect();
        for (const socket of sockets) socket.disconnect();
        for (const connection of websocketServer.clients) connection.terminate();
        websocketServer.close();
        for (const connection of connections) connection.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}
