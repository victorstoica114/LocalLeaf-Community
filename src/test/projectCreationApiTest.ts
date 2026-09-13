/** Project creation must issue exactly one authenticated POST per explicit call. */
import { BaseAPI } from './nativeSyncFixture';
import type { BaseAPI as BaseAPIType } from '../api/base';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { once } from 'node:events';
import { validateProjectName, MAX_PROJECT_NAME_LENGTH } from '../utils/projectName';
import { runStandaloneTest } from './standaloneRunner';

runStandaloneTest(async () => {
    const requests: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
    let respond = (_request: http.IncomingMessage, response: http.ServerResponse) => {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"project_id":"created-project-id"}');
    };
    const server = http.createServer((request, response) => {
        let body = '';
        request.on('data', chunk => { body += String(chunk); });
        request.on('end', () => {
            requests.push({ method: request.method, url: request.url, headers: request.headers, body });
            respond(request, response);
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const serverUrl = `http://127.0.0.1:${address.port}/overleaf`;
    const clients: BaseAPIType[] = [];
    const client = (authenticated = true): BaseAPIType => {
        const api: BaseAPIType = new BaseAPI(serverUrl);
        if (authenticated) api.setIdentity({ cookies: 'test-session=1', csrfToken: 'test-csrf' });
        clients.push(api);
        return api;
    };
    try {
        assert.equal(MAX_PROJECT_NAME_LENGTH, 150);
        assert.equal(validateProjectName('  Research: α & β  '), 'Research: α & β');
        assert.equal(validateProjectName('🔬'.repeat(75)).length, MAX_PROJECT_NAME_LENGTH);
        const api = client();
        for (const invalid of [undefined, null, 123, {}, [], '', '   ', 'a/b', 'a\\b', 'a\nb', 'a\0b', 'a\u007fb', 'a'.repeat(151), '🔬'.repeat(76)]) {
            assert.throws(() => validateProjectName(invalid));
            const result = await api.createProject(invalid as string);
            assert.equal(result.type, 'error');
            assert.equal(result.projectId, undefined);
        }
        assert.equal(requests.length, 0, 'invalid names must not reach the server');
        const unauthenticated = await client(false).createProject('No session');
        assert.equal(unauthenticated.authError, 'invalid_credentials');
        assert.equal(requests.length, 0);

        assert.deepEqual(await api.createProject('  Research: α & β  '), { type: 'success', projectId: 'created-project-id' });
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, '/overleaf/project/new');
        assert.equal(requests[0].method, 'POST');
        assert.equal(requests[0].headers.cookie, 'test-session=1');
        assert.equal(requests[0].headers['x-csrf-token'], 'test-csrf');
        assert.equal(requests[0].headers['content-type'], 'application/json');
        assert.deepEqual(JSON.parse(requests[0].body), {
            projectName: 'Research: α & β', template: 'blank', _csrf: 'test-csrf',
        });

        for (const status of [400, 401, 403, 429, 503]) {
            respond = (_request, response) => {
                response.writeHead(status, { 'Content-Type': 'text/html' }).end('<html>private server diagnostic</html>');
            };
            const before: number = requests.length;
            const result = await api.createProject('Server failure');
            assert.equal(requests.length, before + 1, `HTTP ${status} must not replay project creation`);
            assert.equal(result.type, 'error');
            assert.equal(result.httpStatus, status);
            assert.equal(result.authError, status === 401 ? 'session_expired' : undefined);
            assert.equal(result.creationUncertain, status === 503 ? true : undefined);
            assert.doesNotMatch(result.message || '', /private server diagnostic|<html>/);
        }
        for (const location of ['/overleaf/login', 'https://example.invalid/project/new']) {
            respond = (_request, response) => response.writeHead(302, { Location: location }).end();
            const before: number = requests.length;
            const result = await api.createProject('Redirected');
            assert.equal(result.type, 'error');
            assert.equal(result.authError, location.endsWith('/login') ? 'session_expired' : undefined);
            assert.equal(requests.length, before + 1, 'redirects must not replay or forward the authenticated POST');
        }

        for (const body of [
            '', '<html>unexpected success response</html>', 'null', '[]', '{}',
            '{"_id":"other-field"}', '{"project_id":false}', '{"project_id":{}}',
            '{"project_id":""}', '{"project_id":" "}', '{"project_id":"../other"}',
            '{"project_id":"line\\nbreak"}', JSON.stringify({ project_id: 'a'.repeat(1025) }),
        ]) {
            respond = (_request, response) => response.writeHead(200).end(body);
            const before: number = requests.length;
            const result = await api.createProject('Ambiguous response');
            assert.equal(result.type, 'error', body);
            assert.equal(result.projectId, undefined);
            assert.equal(result.creationUncertain, true);
            assert.match(result.message || '', /Refresh the project list/);
            assert.equal(requests.length, before + 1);
        }
        respond = (_request, response) => response.end('<form action="/login"><input type="password"></form>');
        assert.equal((await api.createProject('Expired session')).authError, 'session_expired');

        const closed = client();
        closed.dispose();
        let before = requests.length;
        assert.equal((await closed.createProject('Closed session')).type, 'error');
        assert.equal(requests.length, before);
        const closing = client();
        const notSent = closing.createProject('Cancel before dispatch');
        closing.dispose();
        assert.equal((await notSent).type, 'error');
        assert.equal(requests.length, before, 'disposal during module loading must not dispatch a POST');

        let requestReceived!: () => void;
        let responseClosed!: () => void;
        const received = new Promise<void>(resolve => { requestReceived = resolve; });
        const terminated = new Promise<void>(resolve => { responseClosed = resolve; });
        respond = (_request, response) => {
            response.once('close', responseClosed);
            requestReceived();
        };
        const cancelledClient = client();
        const cancelled = cancelledClient.createProject('Cancel pending response');
        await received;
        before = requests.length;
        cancelledClient.dispose();
        const cancelledResult = await cancelled;
        await terminated;
        assert.equal(cancelledResult.type, 'error');
        assert.equal(cancelledResult.creationUncertain, true, 'a dispatched POST may have committed before cancellation');
        assert.equal(requests.length, before, 'cancellation must not replay project creation');

        respond = (request, _response) => request.socket.destroy();
        before = requests.length;
        const interrupted = await api.createProject('Lost response');
        assert.equal(interrupted.creationUncertain, true);
        assert.equal(requests.length, before + 1, 'a lost server response must never create a second project');
        console.log('Project creation API validation, authentication, response, and cancellation tests passed.');
    } finally {
        for (const api of clients) api.dispose();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
