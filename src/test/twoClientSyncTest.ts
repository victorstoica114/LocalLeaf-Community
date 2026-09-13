import { runStandaloneTest } from './standaloneRunner';
/** Two real engines, native file watchers and the actual legacy Socket.IO transport. */
import * as assert from 'node:assert/strict';
import * as http from 'http';
import * as path from 'path';
import { promises as fs } from 'fs';
import { once } from 'events';
import { TestUri, SyncEngine, BaseAPI, eventually, promptMessages } from './nativeSyncFixture';
import { createTemporaryWorkspace, cleanTemporaryWorkspaces } from './temporaryWorkspace';

async function run(): Promise<void> {
    // Upstream's MIT text type is the reference server transform, not our client implementation.
    const textType = require(path.join(process.cwd(), 'src/test/vendor/overleaf-text/text.js'));
    const WebSocket = require('ws');
    const directory = await createTemporaryWorkspace('two-client');
    const project = { _id: 'test-project', name: 'Two-client integration', rootFolder: [
        { _id: 'root', name: '', docs: [{ _id: 'doc', name: 'main.tex' }], fileRefs: [], folders: [] },
    ] };
    let content = 'first\nseparator\nmiddle\nseparator\nlast\n';
    let version = 1;
    let nextConnection = 0;
    let dropNextConfirmation = false;
    const history: any[] = [];
    const peers = new Set<any>();
    const tcp = new Set<import('net').Socket>();
    const server = http.createServer((_request, response) => response.end(`session-${++nextConnection}:60:60:websocket`));
    const ws = new WebSocket.Server({ noServer: true });
    const send = (peer: any, name: string, ...args: any[]) => {
        if (peer.readyState === WebSocket.OPEN) peer.send('5:::' + JSON.stringify({ name, args }));
    };
    server.on('connection', socket => { tcp.add(socket); socket.on('close', () => tcp.delete(socket)); });
    server.on('upgrade', (request, socket, head) => ws.handleUpgrade(request, socket, head, (peer: any) => {
        const source = 'client-' + request.url!.split('/').at(-1);
        peers.add(peer);
        peer.on('close', () => peers.delete(peer));
        peer.send('1::');
        send(peer, 'connectionAccepted', null, source);
        peer.on('message', (packet: Buffer) => {
            const match = /^5:(\d*)\+?::(.+)$/.exec(String(packet));
            if (!match) return;
            const event = JSON.parse(match[2]);
            const ack = (...args: any[]) => {
                if (match[1] && peer.readyState === WebSocket.OPEN) peer.send(`6:::${match[1]}+${JSON.stringify([null, ...args])}`);
            };
            if (event.name === 'joinProject') return ack(project);
            if (event.name === 'joinDoc') return ack(content.split('\n'), version);
            if (event.name === 'clientTracking.getConnectedUsers') return ack([]);
            if (event.name !== 'applyOtUpdate') return ack();
            const update = event.args[1];
            try {
                const intervening = history.filter(old => old.v >= update.v);
                const duplicate = intervening.find(old => update.dupIfSource?.includes(old.meta.source));
                if (duplicate) { ack(); send(peer, 'otUpdateApplied', { doc: 'doc', v: update.v }); return; }
                let operation = update.op;
                for (const old of intervening) operation = textType.transform(operation, old.op, 'left');
                content = textType.apply(content, operation);
                const committed = { doc: 'doc', v: version++, op: operation, meta: { source, ts: Date.now(), user_id: 'test-user' } };
                history.push(committed);
                for (const other of peers) if (other !== peer) send(other, 'otUpdateApplied', committed);
                if (dropNextConfirmation) { dropNextConfirmation = false; peer.terminate(); return; }
                ack();
                send(peer, 'otUpdateApplied', { doc: 'doc', v: committed.v });
            } catch (error) { ack(); send(peer, 'otUpdateError', String(error), { doc_id: 'doc' }); }
        });
    }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`;
    const engines: any[] = [];
    const start = async (name: string) => {
        const root = path.join(directory, name);
        await fs.mkdir(root, { recursive: true });
        const settings = { getWorkspaceFolder: () => TestUri.file(root),
            getSettings: () => ({ projectId: project._id, serverUrl: origin, autoSync: true }),
            getFilePath: (relative: string) => TestUri.file(path.join(root, relative)),
            getRelativePath: (uri: TestUri) => '/' + path.relative(root, uri.fsPath).replaceAll('\\', '/'),
            async updateLastSynced() {} };
        const api = new BaseAPI(origin);
        api.setIdentity({ cookies: 'test-only=synthetic', csrfToken: 'synthetic' });
        api.getProjectDetails = async () => ({ type: 'success', projectData: { projectId: project._id, rootFolder: project.rootFolder } });
        const engine = new SyncEngine(api, settings, undefined, TestUri.file(path.join(directory, 'state')));
        engines.push(engine);
        engine.recoveryDelayMs = 20;
        await engine.connect();
        await engine.pullAll(false);
        return { engine, root,
            read: () => fs.readFile(path.join(root, 'main.tex'), 'utf8'),
            write: (value: string) => fs.writeFile(path.join(root, 'main.tex'), value) };
    };
    try {
        let a = await start('a');
        const b = await start('b');
        assert.equal(promptMessages.length, 0, 'empty replicas automatically download');
        const expected = 'FIRST\nseparator\nmiddle\nseparator\nLAST\n';
        await Promise.all([a.write('FIRST\nseparator\nmiddle\nseparator\nlast\n'), b.write('first\nseparator\nmiddle\nseparator\nLAST\n')]);
        await eventually(async () => await a.read() === expected && await b.read() === expected && content === expected,
            'two simultaneous saves', 10_000);
        assert.equal(promptMessages.length, 0);
        await a.engine.stateStore.flush();
        a.engine.disconnect();
        await a.write('FIRST offline\nseparator\nmiddle\nseparator\nLAST\n');
        await b.write('FIRST\nseparator\nmiddle\nseparator\nLAST remote\n');
        await eventually(async () => content.endsWith('LAST remote\n'), 'remote offline edit', 10_000);
        a = await start('a');
        const resumed = 'FIRST offline\nseparator\nmiddle\nseparator\nLAST remote\n';
        await eventually(async () => await a.read() === resumed && await b.read() === resumed && content === resumed,
            'persisted ancestor after restart', 10_000);
        dropNextConfirmation = true;
        const onceOnly = resumed + 'one insertion\n';
        await a.write(onceOnly);
        await eventually(async () => await a.read() === onceOnly && await b.read() === onceOnly && content === onceOnly
            && !a.engine.stateStore.entries.get('/main.tex')?.intent, 'lost ACK over real websocket', 15_000);
        for (let cycle = 0; cycle < 5; cycle++) {
            a.engine.socket.resetConnection();
            await a.engine.pullAll(false);
            await eventually(async () => a.engine.socket.isConnected && a.engine.joinedDocs.has('doc'), 'reconnect', 5000);
        }
        const final = onceOnly + 'still live\n';
        await b.write(final);
        await eventually(async () => await a.read() === final && content === final, 'live after five reconnects', 10_000);
        assert.equal(promptMessages.length, 0);
        console.log('Two-client integration passed: simultaneous edits, persisted restart, lost ACK, five reconnects, native watchers.');
    } finally {
        for (const engine of engines) engine.disconnect();
        try { await Promise.all(engines.map(engine => engine.stateStore?.flush())); }
        finally {
            for (const peer of peers) peer.terminate();
            for (const socket of tcp) socket.destroy();
            ws.close();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    }
}
async function main(): Promise<void> {
    try { await run(); } finally { await cleanTemporaryWorkspaces(); }
}
runStandaloneTest(main);
