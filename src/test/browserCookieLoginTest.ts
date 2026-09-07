import * as assert from 'assert';
import {
    browserCookieLoginInternals,
    captureCookiesViaBrowserLogin,
    isBrowserCookieLoginInProgress,
} from '../auth/browserCookieLogin';
import { validateServerUrl } from '../utils/serverUrl';

function testRouteConstruction(): void {
    const server = validateServerUrl('https://latex.example.test/overleaf/');
    assert.equal(
        browserCookieLoginInternals.routeUrl(server, 'login').toString(),
        'https://latex.example.test/overleaf/login',
        'browser login must preserve a self-hosted Overleaf subpath',
    );
    assert.equal(
        browserCookieLoginInternals.routeUrl(server, '/project').toString(),
        'https://latex.example.test/overleaf/project',
        'a leading route slash must not discard the configured subpath',
    );
}

function testBrowserParsingHelpers(): void {
    const quoted = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" -- "%1"';
    const unquoted = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe --single-argument %1';
    assert.equal(
        browserCookieLoginInternals.extractExecutableFromCommand(quoted),
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    );
    assert.equal(
        browserCookieLoginInternals.extractExecutableFromCommand(unquoted),
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    );
    assert.equal(browserCookieLoginInternals.extractExecutableFromCommand(''), undefined);
    assert.equal(browserCookieLoginInternals.extractExecutableFromCommand('chrome.exe\r\nmalicious'), undefined);

    assert.equal(browserCookieLoginInternals.isChromiumBrowserExecutable('/usr/bin/google-chrome'), true);
    assert.equal(browserCookieLoginInternals.isChromiumBrowserExecutable('/usr/bin/msedge'), true);
    assert.equal(browserCookieLoginInternals.isChromiumBrowserExecutable('/usr/bin/brave-browser'), true);
    assert.equal(browserCookieLoginInternals.isChromiumBrowserExecutable('/usr/bin/firefox'), false);

    assert.equal(
        browserCookieLoginInternals.executableForBundleId('com.google.Chrome'),
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
    assert.equal(
        browserCookieLoginInternals.executableForBundleId('com.microsoft.edgemac'),
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
    assert.equal(browserCookieLoginInternals.executableForBundleId('org.mozilla.firefox'), undefined);
    assert.equal(
        browserCookieLoginInternals.executableForDesktopId('google-chrome.desktop'),
        'google-chrome',
    );
    assert.equal(
        browserCookieLoginInternals.executableForDesktopId('/usr/share/applications/microsoft-edge.desktop'),
        'microsoft-edge',
    );
    assert.equal(browserCookieLoginInternals.executableForDesktopId('firefox.desktop'), undefined);

    const deduplicated = browserCookieLoginInternals.dedupeCandidates(['chrome', 'chrome', 'msedge']);
    assert.deepStrictEqual(deduplicated, ['chrome', 'msedge']);
    const caseVariants = browserCookieLoginInternals.dedupeCandidates(['Chrome', 'chrome']);
    assert.equal(caseVariants.length, process.platform === 'win32' ? 1 : 2);
}

function testTimeoutAndPortParsing(): void {
    assert.equal(browserCookieLoginInternals.normalizeLoginTimeout(undefined), 300_000);
    assert.equal(browserCookieLoginInternals.normalizeLoginTimeout(Number.NaN), 300_000);
    assert.equal(browserCookieLoginInternals.normalizeLoginTimeout(1), 100);
    assert.equal(browserCookieLoginInternals.normalizeLoginTimeout(900_000), 600_000);

    assert.equal(browserCookieLoginInternals.parseDevToolsActivePort('9222\n/devtools/browser/id\n'), 9222);
    assert.equal(browserCookieLoginInternals.parseDevToolsActivePort('0\n'), undefined);
    assert.equal(browserCookieLoginInternals.parseDevToolsActivePort('65536\n'), undefined);
    assert.equal(browserCookieLoginInternals.parseDevToolsActivePort('not-a-port\n'), undefined);
    assert.equal(browserCookieLoginInternals.parseDevToolsActivePort('1'.repeat(1025)), undefined);
}

function testCookieFiltering(): void {
    const now = Date.now() / 1000;
    const cookies = browserCookieLoginInternals.parseBrowserCookies([
        {
            name: 'session',
            value: 'broad',
            domain: '.example.test',
            path: '/',
            expires: now + 600,
            secure: true,
        },
        {
            name: 'session',
            value: 'specific',
            domain: 'latex.example.test',
            path: '/overleaf',
            expires: now + 600,
            secure: true,
        },
        {
            name: 'expired',
            value: 'secret',
            domain: 'latex.example.test',
            path: '/',
            expires: now - 1,
        },
        {
            name: 'wrong_domain',
            value: 'secret',
            domain: 'example.test.attacker.invalid',
            path: '/',
        },
        {
            name: 'wrong_path',
            value: 'secret',
            domain: 'latex.example.test',
            path: '/admin',
        },
        {
            name: 'header_injection',
            value: 'secret\r\nX-Injected: yes',
            domain: 'latex.example.test',
            path: '/',
        },
        {
            name: 'delimiter_injection',
            value: 'secret; injected=yes',
            domain: 'latex.example.test',
            path: '/',
        },
        {
            name: 'invalid name',
            value: 'secret',
            domain: 'latex.example.test',
            path: '/',
        },
        {
            name: 'oversized',
            value: 'x'.repeat(64 * 1024),
            domain: 'latex.example.test',
            path: '/',
        },
        { name: 42, value: 'ignored', domain: 'latex.example.test' },
        null,
    ]);
    assert.ok(cookies);

    const header = browserCookieLoginInternals.buildCookieHeader(
        cookies,
        new URL('https://latex.example.test/overleaf/project'),
    );
    assert.equal(header, 'session=specific');

    const httpHeader = browserCookieLoginInternals.buildCookieHeader(
        cookies,
        new URL('http://latex.example.test/overleaf/project'),
    );
    assert.equal(httpHeader, '', 'Secure cookies must not be sent over HTTP');

    assert.equal(browserCookieLoginInternals.domainMatches('.example.test', 'latex.example.test'), true);
    assert.equal(browserCookieLoginInternals.domainMatches('example.test', 'example.test'), true);
    assert.equal(browserCookieLoginInternals.domainMatches('ample.test', 'example.test'), false);
    assert.equal(browserCookieLoginInternals.domainMatches('example.test.attacker', 'example.test'), false);
    assert.equal(browserCookieLoginInternals.domainMatches('', 'example.test'), false);

    assert.equal(browserCookieLoginInternals.cookiePathMatches('/', '/overleaf/project'), true);
    assert.equal(browserCookieLoginInternals.cookiePathMatches('/overleaf', '/overleaf/project'), true);
    assert.equal(browserCookieLoginInternals.cookiePathMatches('/over', '/overleaf/project'), false);
    assert.equal(browserCookieLoginInternals.cookiePathMatches('/admin', '/overleaf/project'), false);
}

function testAuthenticatedPageDetection(): void {
    const authenticated = [
        '<html><head>',
        '<meta content="user-id" data-extra="1" name="ol-user_id">',
        '<meta name=\'ol-csrfToken\' content=\'csrf-token\'>',
        '</head></html>',
    ].join('');
    assert.equal(browserCookieLoginInternals.containsAuthenticatedProjectPage(authenticated), true);
    assert.equal(
        browserCookieLoginInternals.containsAuthenticatedProjectPage(
            '<meta name="ol-user_id" content="user-id"><form action="/login"></form>',
        ),
        false,
    );
    assert.equal(
        browserCookieLoginInternals.containsAuthenticatedProjectPage(
            '<meta name="ol-user_id" content=""><meta name="ol-csrfToken" content="csrf-token">',
        ),
        false,
    );
    assert.equal(
        browserCookieLoginInternals.containsAuthenticatedProjectPage([
            '<!-- <meta name="ol-user_id" content="comment-user"> -->',
            '<script>const fake = \'<meta name="ol-csrfToken" content="script-token">\';</script>',
        ].join('')),
        false,
        'metadata-looking text in comments or scripts must not complete browser login',
    );
}

function testAuthenticationRedirectClassification(): void {
    const server = validateServerUrl('https://latex.example.test/overleaf/');
    const projectUrl = browserCookieLoginInternals.routeUrl(server, 'project');

    assert.equal(
        browserCookieLoginInternals.classifyAuthenticationRedirect(server, projectUrl, '/overleaf/project/'),
        'project',
        'a same-origin canonical project redirect may be followed once',
    );
    assert.equal(
        browserCookieLoginInternals.classifyAuthenticationRedirect(
            server,
            projectUrl,
            '/overleaf/login?redir=%2Foverleaf%2Fproject',
        ),
        'login',
        'a login redirect must never prove authentication',
    );
    assert.equal(
        browserCookieLoginInternals.classifyAuthenticationRedirect(
            server,
            projectUrl,
            'https://attacker.invalid/overleaf/project/',
        ),
        'other',
        'cross-origin redirects must not receive or validate the captured session',
    );
    assert.equal(
        browserCookieLoginInternals.classifyAuthenticationRedirect(
            server,
            projectUrl,
            '/overleaf/project/?continue=1',
        ),
        'other',
        'a project redirect with a query is not a safe canonical redirect',
    );
}

function testLoopbackDebuggerValidation(): void {
    assert.equal(
        browserCookieLoginInternals.validateDebuggerWebSocketUrl(
            'ws://127.0.0.1:9222/devtools/page/id',
            9222,
        ).hostname,
        '127.0.0.1',
    );
    assert.equal(
        browserCookieLoginInternals.validateDebuggerWebSocketUrl(
            'ws://localhost:9222/devtools/page/id',
            9222,
        ).hostname,
        'localhost',
    );
    assert.doesNotThrow(() => browserCookieLoginInternals.validateDebuggerWebSocketUrl(
        'ws://[::1]:9222/devtools/page/id',
        9222,
    ));

    const rejected = [
        'ws://attacker.invalid:9222/devtools/page/id',
        'ws://127.0.0.1:9223/devtools/page/id',
        'wss://127.0.0.1:9222/devtools/page/id',
        'ws://user:password@127.0.0.1:9222/devtools/page/id',
        'ws://127.0.0.1/devtools/page/id',
    ];
    for (const candidate of rejected) {
        assert.throws(
            () => browserCookieLoginInternals.validateDebuggerWebSocketUrl(candidate, 9222),
            /loopback-only/,
        );
    }
}

function testWebSocketFrameDecoder(): void {
    const payload = Buffer.from('{"id":1}', 'utf8');
    const frame = Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
    const decoded = browserCookieLoginInternals.decodeWebSocketFrames(frame);
    assert.equal(decoded.frames.length, 1);
    assert.equal(decoded.frames[0].fin, true);
    assert.equal(decoded.frames[0].opcode, 1);
    assert.equal(decoded.frames[0].payload.toString('utf8'), '{"id":1}');
    assert.equal(decoded.remaining.length, 0);

    const incomplete = frame.subarray(0, frame.length - 1);
    const partial = browserCookieLoginInternals.decodeWebSocketFrames(incomplete);
    assert.equal(partial.frames.length, 0);
    assert.equal(partial.remaining.length, incomplete.length);

    assert.throws(
        () => browserCookieLoginInternals.decodeWebSocketFrames(Buffer.from([0x81, 0x80])),
        /must not be masked/,
    );
    const oversized = Buffer.alloc(10);
    oversized[0] = 0x82;
    oversized[1] = 127;
    oversized.writeBigUInt64BE(BigInt(4 * 1024 * 1024 + 1), 2);
    assert.throws(
        () => browserCookieLoginInternals.decodeWebSocketFrames(oversized),
        /too large/,
    );
}

async function testCancellationAndOperationGate(): Promise<void> {
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    const cancelledResult = await captureCookiesViaBrowserLogin(
        'https://example.test/overleaf',
        'auto',
        { signal: alreadyCancelled.signal },
    );
    assert.equal(cancelledResult.type, 'cancelled');
    assert.equal(isBrowserCookieLoginInProgress(), false);

    const activeController = new AbortController();
    const activeLogin = captureCookiesViaBrowserLogin(
        'https://example.test/overleaf',
        'chrome',
        { signal: activeController.signal, timeoutMs: 5_000 },
    );
    assert.equal(isBrowserCookieLoginInProgress(), true);

    const overlappingLogin = await captureCookiesViaBrowserLogin(
        'https://example.test/overleaf',
        'edge',
    );
    assert.equal(overlappingLogin.type, 'error');
    if (overlappingLogin.type === 'error') {
        assert.equal(overlappingLogin.code, 'already-running');
    }

    activeController.abort();
    const activeResult = await activeLogin;
    assert.equal(activeResult.type, 'cancelled');
    assert.equal(isBrowserCookieLoginInProgress(), false);
}

/** Run the pure and cancellation-safe browser login unit tests. */
export async function runBrowserCookieLoginTests(): Promise<void> {
    testRouteConstruction();
    testBrowserParsingHelpers();
    testTimeoutAndPortParsing();
    testCookieFiltering();
    testAuthenticatedPageDetection();
    testAuthenticationRedirectClassification();
    testLoopbackDebuggerValidation();
    testWebSocketFrameDecoder();
    await testCancellationAndOperationGate();
}
