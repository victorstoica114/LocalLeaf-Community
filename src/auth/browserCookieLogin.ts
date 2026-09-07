/**
 * Browser-assisted Overleaf cookie capture.
 *
 * Adapted from Xingyu Chen (Asixa)'s browser-login contribution in
 * Teddy-van-Jerry/LocalLeaf PR #3 (MIT). This Community version keeps the
 * original browser-discovery idea while adding cancellation, bounded I/O,
 * loopback-only DevTools access, deterministic process cleanup, and stricter
 * cookie validation. See ATTRIBUTION.md for the full project credits.
 */

import { ChildProcess, spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { Socket } from 'net';
import * as os from 'os';
import * as path from 'path';
import { readOverleafProjectAuthMetadata } from '../api/base';
import { validateServerUrl, ValidatedServerUrl } from '../utils/serverUrl';

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const MAX_LOGIN_TIMEOUT_MS = 10 * 60_000;
const DEVTOOLS_START_TIMEOUT_MS = 15_000;
const LOCAL_REQUEST_TIMEOUT_MS = 3_000;
const CDP_REQUEST_TIMEOUT_MS = 7_500;
const AUTH_REQUEST_TIMEOUT_MS = 10_000;
const PROCESS_PROBE_TIMEOUT_MS = 2_500;
const PROCESS_STOP_TIMEOUT_MS = 4_000;
const MAX_LOCAL_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_AUTH_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_WEBSOCKET_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_COOKIE_HEADER_BYTES = 64 * 1024;
const PROFILE_PREFIX = 'localleaf-browser-login-';

interface DevToolsTarget {
    type?: string;
    url?: string;
    webSocketDebuggerUrl?: string;
}

interface BrowserCookie {
    name: string;
    value: string;
    domain: string;
    path?: string;
    expires?: number;
    secure?: boolean;
}

interface CommandResult {
    code: number | null;
    stdout: string;
}

interface DecodedWebSocketFrame {
    fin: boolean;
    opcode: number;
    payload: Buffer;
}

type BrowserLoginFailureCode =
    | 'already-running'
    | 'browser-not-found'
    | 'browser-closed'
    | 'cancelled'
    | 'devtools-error'
    | 'invalid-server'
    | 'timeout'
    | 'unknown';

export type BrowserPreference = 'auto' | 'system' | 'chrome' | 'edge';

export interface BrowserCookieCaptureOptions {
    /** Abort the active login and close the isolated browser window. */
    signal?: AbortSignal;
    /** Receives fixed progress messages only; cookie values are never logged. */
    log?: (message: string) => void;
    /** Mainly useful for tests. Defaults to five minutes and is capped at ten. */
    timeoutMs?: number;
    /** Called if the isolated browser profile cannot be removed after retries. */
    onCleanupFailure?: (profilePath: string) => void;
}

export type BrowserCookieCaptureResult =
    | { type: 'success'; cookies: string }
    | { type: 'cancelled'; message: string }
    | { type: 'error'; code: Exclude<BrowserLoginFailureCode, 'cancelled'>; message: string };

class BrowserLoginFailure extends Error {
    constructor(
        readonly code: BrowserLoginFailureCode,
        message: string,
    ) {
        super(message);
        this.name = 'BrowserLoginFailure';
    }
}

class LoginDeadline {
    readonly signal: AbortSignal;
    private readonly controller = new AbortController();
    private readonly deadline: number;
    private readonly timeout: NodeJS.Timeout;
    private readonly externalSignal?: AbortSignal;
    private readonly externalAbortListener: () => void;

    constructor(timeoutMs: number, externalSignal?: AbortSignal) {
        this.signal = this.controller.signal;
        this.deadline = Date.now() + timeoutMs;
        this.externalSignal = externalSignal;
        this.externalAbortListener = () => {
            this.controller.abort(new BrowserLoginFailure('cancelled', 'Browser login was cancelled.'));
        };

        if (externalSignal?.aborted) {
            this.externalAbortListener();
        } else {
            externalSignal?.addEventListener('abort', this.externalAbortListener, { once: true });
        }

        this.timeout = setTimeout(() => {
            this.controller.abort(new BrowserLoginFailure(
                'timeout',
                'Timed out waiting for browser login. Complete the sign-in before the time limit expires.',
            ));
        }, timeoutMs);
    }

    throwIfAborted(): void {
        if (this.signal.aborted) {
            throw failureFromAbort(this.signal);
        }
    }

    remaining(maximumMs: number): number {
        this.throwIfAborted();
        const remaining = this.deadline - Date.now();
        if (remaining <= 0) {
            throw new BrowserLoginFailure(
                'timeout',
                'Timed out waiting for browser login. Complete the sign-in before the time limit expires.',
            );
        }
        return Math.max(1, Math.min(maximumMs, remaining));
    }

    dispose(): void {
        clearTimeout(this.timeout);
        this.externalSignal?.removeEventListener('abort', this.externalAbortListener);
    }
}

let captureInProgress = false;

/** Whether this extension host currently owns an active browser-login operation. */
export function isBrowserCookieLoginInProgress(): boolean {
    return captureInProgress;
}

/**
 * Open an isolated Chromium profile and return the authenticated Overleaf
 * cookie header. Only one operation may run at a time in an extension host.
 */
export async function captureCookiesViaBrowserLogin(
    serverUrl: string,
    preference: BrowserPreference = 'auto',
    options: BrowserCookieCaptureOptions = {},
): Promise<BrowserCookieCaptureResult> {
    if (captureInProgress) {
        return {
            type: 'error',
            code: 'already-running',
            message: 'A browser login is already in progress.',
        };
    }

    captureInProgress = true;
    const timeoutMs = normalizeLoginTimeout(options.timeoutMs);
    const deadline = new LoginDeadline(timeoutMs, options.signal);
    let browserProcess: ChildProcess | undefined;
    let tempProfileDir: string | undefined;

    try {
        deadline.throwIfAborted();
        const server = parseServerUrl(serverUrl);
        validateBrowserPreference(preference);

        safeLog(options.log, 'Looking for a supported Chromium browser...');
        const executable = await findChromiumExecutable(server, preference, deadline);
        if (!executable) {
            throw new BrowserLoginFailure(
                'browser-not-found',
                'No supported Chromium browser was found for the selected mode.',
            );
        }

        tempProfileDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), PROFILE_PREFIX));
        deadline.throwIfAborted();

        safeLog(options.log, 'Opening an isolated browser window for Overleaf login...');
        browserProcess = launchBrowser(
            executable,
            tempProfileDir,
            routeUrl(server, 'login').toString(),
        );
        await waitForProcessSpawn(browserProcess, deadline);

        const debugPort = await waitForDevToolsActivePort(tempProfileDir, browserProcess, deadline);
        await waitForDebugTargets(debugPort, browserProcess, deadline);

        safeLog(options.log, 'Waiting for the Overleaf sign-in to complete...');
        const cookies = await waitForLoginCookies(
            debugPort,
            server,
            browserProcess,
            deadline,
            options.log,
        );
        return { type: 'success', cookies };
    } catch (error) {
        const failure = normalizeFailure(error, deadline.signal);
        if (failure.code === 'cancelled') {
            return { type: 'cancelled', message: failure.message };
        }
        return { type: 'error', code: failure.code, message: failure.message };
    } finally {
        deadline.dispose();
        if (browserProcess) {
            await terminateProcessTree(browserProcess, PROCESS_STOP_TIMEOUT_MS);
        }
        if (tempProfileDir) {
            const removed = await removeTemporaryProfile(tempProfileDir, options.log);
            if (!removed) {
                try {
                    options.onCleanupFailure?.(tempProfileDir);
                } catch {
                    safeLog(options.log, 'Could not report the isolated browser profile cleanup failure.');
                }
            }
        }
        captureInProgress = false;
    }
}

function parseServerUrl(serverUrl: string): ValidatedServerUrl {
    try {
        return validateServerUrl(serverUrl);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'The Overleaf server URL is invalid.';
        throw new BrowserLoginFailure('invalid-server', message);
    }
}

function validateBrowserPreference(preference: string): asserts preference is BrowserPreference {
    if (preference !== 'auto' && preference !== 'system' && preference !== 'chrome' && preference !== 'edge') {
        throw new BrowserLoginFailure('unknown', 'The selected browser preference is invalid.');
    }
}

function normalizeLoginTimeout(timeoutMs: number | undefined): number {
    if (timeoutMs === undefined) return DEFAULT_LOGIN_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_LOGIN_TIMEOUT_MS;
    return Math.min(Math.max(Math.floor(timeoutMs), 100), MAX_LOGIN_TIMEOUT_MS);
}

function routeUrl(server: ValidatedServerUrl, route: string): URL {
    const base = server.url.endsWith('/') ? server.url : `${server.url}/`;
    return new URL(route.replace(/^\/+/, ''), base);
}

function safeLog(log: ((message: string) => void) | undefined, message: string): void {
    try {
        log?.(message);
    } catch {
        // Logging must never affect authentication or expose captured secrets.
    }
}

function attachAbortListener(signal: AbortSignal, listener: () => void): void {
    signal.addEventListener('abort', listener, { once: true });
    // Close the check/listener race without relying on AbortSignal.any, which
    // is not available in every Node version supported by VS Code 1.85.
    if (signal.aborted) listener();
}

function failureFromAbort(signal: AbortSignal): BrowserLoginFailure {
    const reason: unknown = signal.reason;
    if (reason instanceof BrowserLoginFailure) return reason;
    return new BrowserLoginFailure('cancelled', 'Browser login was cancelled.');
}

function normalizeFailure(error: unknown, signal: AbortSignal): BrowserLoginFailure {
    if (signal.aborted) return failureFromAbort(signal);
    if (error instanceof BrowserLoginFailure) return error;
    return new BrowserLoginFailure('unknown', 'Browser login failed unexpectedly. Please try again.');
}

async function findChromiumExecutable(
    server: ValidatedServerUrl,
    preference: BrowserPreference,
    deadline: LoginDeadline,
): Promise<string | undefined> {
    const candidates = await getPrioritizedExecutableCandidates(server, preference, deadline);
    for (const candidate of candidates) {
        deadline.throwIfAborted();
        if (path.isAbsolute(candidate)) {
            try {
                await fs.promises.access(candidate, fs.constants.F_OK);
                return candidate;
            } catch {
                continue;
            }
        }
        if (await canExecute(candidate, deadline)) return candidate;
    }
    return undefined;
}

async function getPrioritizedExecutableCandidates(
    server: ValidatedServerUrl,
    preference: BrowserPreference,
    deadline: LoginDeadline,
): Promise<string[]> {
    const candidates: string[] = [];
    if (preference === 'system') {
        const systemExecutable = await getSystemDefaultBrowserExecutable(server, deadline);
        if (systemExecutable && isChromiumBrowserExecutable(systemExecutable)) {
            candidates.push(systemExecutable);
        }
        candidates.push(...getChromeExecutableCandidates(), ...getEdgeExecutableCandidates());
    } else if (preference === 'chrome') {
        candidates.push(...getChromeExecutableCandidates());
    } else if (preference === 'edge') {
        candidates.push(...getEdgeExecutableCandidates());
    } else {
        candidates.push(...getChromeExecutableCandidates(), ...getEdgeExecutableCandidates());
    }
    return dedupeCandidates(candidates.filter(candidate => candidate.length > 0));
}

function getChromeExecutableCandidates(): string[] {
    if (process.platform === 'win32') {
        return [
            windowsApplicationPath(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            windowsApplicationPath(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
            windowsApplicationPath(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            'chrome',
            'google-chrome',
            'chromium',
        ].filter(candidate => candidate.length > 0);
    }
    if (process.platform === 'darwin') {
        return [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            `${os.homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
            'google-chrome',
            'chromium',
        ];
    }
    return ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];
}

function getEdgeExecutableCandidates(): string[] {
    if (process.platform === 'win32') {
        return [
            windowsApplicationPath(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            windowsApplicationPath(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            windowsApplicationPath(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            'msedge',
            'microsoft-edge',
        ].filter(candidate => candidate.length > 0);
    }
    if (process.platform === 'darwin') {
        return [
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            `${os.homedir()}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
            'microsoft-edge',
        ];
    }
    return ['microsoft-edge', 'microsoft-edge-stable', 'msedge'];
}

function windowsApplicationPath(root: string | undefined, ...segments: string[]): string {
    return root ? path.join(root, ...segments) : '';
}

function dedupeCandidates(candidates: readonly string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const candidate of candidates) {
        const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(candidate);
    }
    return result;
}

function isChromiumBrowserExecutable(executable: string): boolean {
    const name = path.basename(executable).toLowerCase();
    return name.includes('chrome')
        || name.includes('msedge')
        || name.includes('chromium')
        || name.includes('brave')
        || name.includes('opera')
        || name.includes('vivaldi')
        || name.includes('arc');
}

async function getSystemDefaultBrowserExecutable(
    server: ValidatedServerUrl,
    deadline: LoginDeadline,
): Promise<string | undefined> {
    if (process.platform === 'win32') {
        return getWindowsDefaultBrowserExecutable(server, deadline);
    }
    if (process.platform === 'darwin') {
        const result = await runCommandCapture(
            'osascript',
            ['-e', `id of app (path to default application for URL "${server.parsed.protocol}//example.invalid")`],
            deadline,
            PROCESS_PROBE_TIMEOUT_MS,
        );
        return result?.code === 0 ? executableForBundleId(result.stdout.trim()) : undefined;
    }
    const result = await runCommandCapture(
        'xdg-settings',
        ['get', 'default-web-browser'],
        deadline,
        PROCESS_PROBE_TIMEOUT_MS,
    );
    return result?.code === 0 ? executableForDesktopId(result.stdout.trim()) : undefined;
}

async function getWindowsDefaultBrowserExecutable(
    server: ValidatedServerUrl,
    deadline: LoginDeadline,
): Promise<string | undefined> {
    const schemes = server.parsed.protocol === 'https:' ? ['https', 'http'] : ['http', 'https'];
    let progId: string | undefined;
    for (const scheme of schemes) {
        progId = await queryWindowsRegistryValue(
            `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`,
            'ProgId',
            deadline,
        );
        if (progId) break;
    }
    if (!progId || !/^[A-Za-z0-9._-]{1,256}$/.test(progId)) return undefined;
    const command = await queryWindowsRegistryDefaultValue(
        `HKCR\\${progId}\\shell\\open\\command`,
        deadline,
    );
    return command ? extractExecutableFromCommand(command) : undefined;
}

function executableForBundleId(bundleId: string): string | undefined {
    const normalized = bundleId.toLowerCase();
    if (normalized.includes('google.chrome')) {
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    }
    if (normalized.includes('microsoft.edgemac')) {
        return '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    }
    if (normalized.includes('brave')) {
        return '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
    }
    if (normalized.includes('vivaldi')) {
        return '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi';
    }
    return undefined;
}

function executableForDesktopId(desktopId: string): string | undefined {
    const normalized = path.basename(desktopId).replace(/\.desktop$/i, '').toLowerCase();
    if (/^(google-chrome|google-chrome-stable|chromium|chromium-browser)$/.test(normalized)) {
        return normalized;
    }
    if (/^(microsoft-edge|microsoft-edge-stable|msedge)$/.test(normalized)) {
        return normalized;
    }
    if (/^(brave-browser|vivaldi|opera)$/.test(normalized)) {
        return normalized;
    }
    return undefined;
}

async function queryWindowsRegistryValue(
    key: string,
    valueName: string,
    deadline: LoginDeadline,
): Promise<string | undefined> {
    const result = await runCommandCapture(
        'reg',
        ['query', key, '/v', valueName],
        deadline,
        PROCESS_PROBE_TIMEOUT_MS,
    );
    if (!result || result.code !== 0) return undefined;
    const expression = new RegExp(`${escapeRegExp(valueName)}\\s+REG_\\w+\\s+(.+)$`, 'im');
    return result.stdout.match(expression)?.[1]?.trim();
}

async function queryWindowsRegistryDefaultValue(
    key: string,
    deadline: LoginDeadline,
): Promise<string | undefined> {
    const result = await runCommandCapture(
        'reg',
        ['query', key, '/ve'],
        deadline,
        PROCESS_PROBE_TIMEOUT_MS,
    );
    if (!result || result.code !== 0) return undefined;
    return result.stdout.match(/REG_\w+\s+(.+)$/im)?.[1]?.trim();
}

function extractExecutableFromCommand(command: string): string | undefined {
    const trimmed = command.trim();
    if (!trimmed || /[\r\n\0]/.test(trimmed)) return undefined;
    if (trimmed.startsWith('"')) {
        const closingQuote = trimmed.indexOf('"', 1);
        return closingQuote > 1 ? trimmed.slice(1, closingQuote) : undefined;
    }
    const executableEnd = trimmed.toLowerCase().indexOf('.exe');
    if (executableEnd >= 0) return trimmed.slice(0, executableEnd + 4).trim();
    return trimmed.split(/\s+/, 1)[0] || undefined;
}

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function canExecute(command: string, deadline: LoginDeadline): Promise<boolean> {
    const result = await runCommandCapture(
        command,
        ['--version'],
        deadline,
        PROCESS_PROBE_TIMEOUT_MS,
    );
    return result?.code === 0;
}

async function runCommandCapture(
    executable: string,
    args: readonly string[],
    deadline: LoginDeadline,
    timeoutMs: number,
): Promise<CommandResult | undefined> {
    deadline.throwIfAborted();
    return new Promise((resolve, reject) => {
        let settled = false;
        let stdout = '';
        let proc: ChildProcess;
        const finish = (result: CommandResult | undefined, error?: BrowserLoginFailure) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            deadline.signal.removeEventListener('abort', abortListener);
            if (error) reject(error);
            else resolve(result);
        };
        const abortListener = () => {
            try { proc.kill(); } catch { /* process may not have started */ }
            finish(undefined, failureFromAbort(deadline.signal));
        };
        const timer = setTimeout(() => {
            try { proc.kill(); } catch { /* process may already be closed */ }
            finish(undefined);
        }, deadline.remaining(timeoutMs));

        try {
            proc = spawn(executable, [...args], {
                shell: false,
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
            });
        } catch {
            finish(undefined);
            return;
        }

        attachAbortListener(deadline.signal, abortListener);
        if (settled) return;
        proc.stdout?.on('data', (data: Buffer) => {
            if (stdout.length >= 16 * 1024) return;
            stdout += data.toString('utf8', 0, Math.max(0, 16 * 1024 - stdout.length));
        });
        proc.once('error', () => finish(undefined));
        proc.once('close', code => finish({ code, stdout }));
    });
}

function launchBrowser(
    executable: string,
    tempProfileDir: string,
    loginUrl: string,
): ChildProcess {
    const args = [
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        `--user-data-dir=${tempProfileDir}`,
        '--new-window',
        loginUrl,
    ];
    if (process.platform === 'linux') args.unshift('--password-store=basic');

    return spawn(executable, args, {
        detached: process.platform !== 'win32',
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
    });
}

async function waitForProcessSpawn(proc: ChildProcess, deadline: LoginDeadline): Promise<void> {
    deadline.throwIfAborted();
    if (proc.pid) return;
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            proc.removeListener('spawn', spawned);
            proc.removeListener('error', failed);
            deadline.signal.removeEventListener('abort', aborted);
        };
        const finish = (error?: BrowserLoginFailure) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve();
        };
        const spawned = () => finish();
        const failed = () => finish(new BrowserLoginFailure('browser-closed', 'The browser could not be started.'));
        const aborted = () => finish(failureFromAbort(deadline.signal));
        proc.once('spawn', spawned);
        proc.once('error', failed);
        attachAbortListener(deadline.signal, aborted);
    });
}

async function waitForDevToolsActivePort(
    tempProfileDir: string,
    proc: ChildProcess,
    deadline: LoginDeadline,
): Promise<number> {
    const activePortFile = path.join(tempProfileDir, 'DevToolsActivePort');
    const localDeadline = Date.now() + deadline.remaining(DEVTOOLS_START_TIMEOUT_MS);
    while (Date.now() < localDeadline) {
        deadline.throwIfAborted();
        ensureBrowserRunning(proc);
        try {
            const contents = await fs.promises.readFile(activePortFile, {
                encoding: 'utf8',
                signal: deadline.signal,
            });
            const port = parseDevToolsActivePort(contents);
            if (port !== undefined) return port;
        } catch (error) {
            if (deadline.signal.aborted) throw failureFromAbort(deadline.signal);
            if (!isFileNotFoundError(error)) {
                throw new BrowserLoginFailure('devtools-error', 'Could not read the browser debugging endpoint.');
            }
        }
        await abortableDelay(250, deadline);
    }
    throw new BrowserLoginFailure('devtools-error', 'Timed out while starting the browser debugging endpoint.');
}

function parseDevToolsActivePort(contents: string): number | undefined {
    if (contents.length > 1024) return undefined;
    const firstLine = contents.split(/\r?\n/, 1)[0]?.trim();
    if (!firstLine || !/^\d{1,5}$/.test(firstLine)) return undefined;
    const port = Number(firstLine);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function ensureBrowserRunning(proc: ChildProcess): void {
    if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new BrowserLoginFailure(
            'browser-closed',
            'The login browser was closed before authentication completed.',
        );
    }
}

async function waitForDebugTargets(
    port: number,
    proc: ChildProcess,
    deadline: LoginDeadline,
): Promise<DevToolsTarget[]> {
    const localDeadline = Date.now() + deadline.remaining(DEVTOOLS_START_TIMEOUT_MS);
    while (Date.now() < localDeadline) {
        deadline.throwIfAborted();
        ensureBrowserRunning(proc);
        try {
            const targets = await getDevToolsTargets(port, deadline);
            if (targets.length > 0) return targets;
        } catch (error) {
            if (error instanceof BrowserLoginFailure && (error.code === 'cancelled' || error.code === 'timeout')) {
                throw error;
            }
        }
        await abortableDelay(300, deadline);
    }
    throw new BrowserLoginFailure('devtools-error', 'Timed out while connecting to the login browser.');
}

async function getDevToolsTargets(port: number, deadline: LoginDeadline): Promise<DevToolsTarget[]> {
    const data = await requestLoopbackJson(port, '/json/list', deadline);
    if (!Array.isArray(data)) return [];
    return data.flatMap((value): DevToolsTarget[] => {
        const target = asObject(value);
        if (!target) return [];
        return [{
            type: optionalString(target.type),
            url: optionalString(target.url),
            webSocketDebuggerUrl: optionalString(target.webSocketDebuggerUrl),
        }];
    });
}

async function requestLoopbackJson(
    port: number,
    requestPath: string,
    deadline: LoginDeadline,
): Promise<unknown> {
    const body = await new Promise<Buffer>((resolve, reject) => {
        let settled = false;
        let response: http.IncomingMessage | undefined;
        const chunks: Buffer[] = [];
        let byteLength = 0;
        const request = http.request({
            host: '127.0.0.1',
            port,
            path: requestPath,
            method: 'GET',
            agent: false,
            headers: { Accept: 'application/json' },
        });
        const finish = (value?: Buffer, error?: BrowserLoginFailure) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            deadline.signal.removeEventListener('abort', abortListener);
            if (error) {
                response?.destroy();
                request.destroy();
                reject(error);
            } else {
                resolve(value || Buffer.alloc(0));
            }
        };
        const abortListener = () => finish(undefined, failureFromAbort(deadline.signal));
        const timer = setTimeout(() => finish(undefined, new BrowserLoginFailure(
            'devtools-error',
            'The browser debugging endpoint did not respond in time.',
        )), deadline.remaining(LOCAL_REQUEST_TIMEOUT_MS));

        attachAbortListener(deadline.signal, abortListener);
        if (settled) return;
        request.once('response', incoming => {
            response = incoming;
            if (incoming.statusCode !== 200) {
                incoming.resume();
                finish(undefined, new BrowserLoginFailure(
                    'devtools-error',
                    'The browser debugging endpoint returned an unexpected response.',
                ));
                return;
            }
            incoming.on('data', (chunk: Buffer) => {
                byteLength += chunk.length;
                if (byteLength > MAX_LOCAL_RESPONSE_BYTES) {
                    finish(undefined, new BrowserLoginFailure(
                        'devtools-error',
                        'The browser debugging response was unexpectedly large.',
                    ));
                    return;
                }
                chunks.push(chunk);
            });
            incoming.once('end', () => finish(Buffer.concat(chunks, byteLength)));
            incoming.once('error', () => finish(undefined, new BrowserLoginFailure(
                'devtools-error',
                'The browser debugging response was interrupted.',
            )));
        });
        request.once('error', () => finish(undefined, new BrowserLoginFailure(
            'devtools-error',
            'Could not connect to the browser debugging endpoint.',
        )));
        request.end();
    });

    try {
        return JSON.parse(body.toString('utf8')) as unknown;
    } catch {
        throw new BrowserLoginFailure('devtools-error', 'The browser debugging endpoint returned invalid data.');
    }
}

async function waitForLoginCookies(
    port: number,
    server: ValidatedServerUrl,
    proc: ChildProcess,
    deadline: LoginDeadline,
    log?: (message: string) => void,
): Promise<string> {
    let lastCookieHeader = '';
    let lastAuthenticationCheck = 0;
    while (!deadline.signal.aborted) {
        deadline.throwIfAborted();
        ensureBrowserRunning(proc);
        try {
            const targets = await getDevToolsTargets(port, deadline);
            const target = pickTarget(targets, server);
            if (target?.webSocketDebuggerUrl) {
                const cookies = await getCookiesFromDevTools(
                    target.webSocketDebuggerUrl,
                    port,
                    server,
                    deadline,
                );
                const cookieHeader = buildCookieHeader(cookies, routeUrl(server, 'project'));
                const now = Date.now();
                if (
                    cookieHeader
                    && (cookieHeader !== lastCookieHeader || now - lastAuthenticationCheck >= 1_500)
                ) {
                    lastCookieHeader = cookieHeader;
                    lastAuthenticationCheck = now;
                    if (await isAuthenticatedCookie(server, cookieHeader, deadline)) {
                        return cookieHeader;
                    }
                    safeLog(log, 'A browser session was detected; waiting for Overleaf to confirm sign-in...');
                }
            }
        } catch (error) {
            if (error instanceof BrowserLoginFailure) {
                if (
                    error.code === 'cancelled'
                    || error.code === 'timeout'
                    || error.code === 'browser-closed'
                ) {
                    throw error;
                }
            }
            // DevTools may briefly replace the page target during redirects.
        }
        await abortableDelay(350, deadline);
    }
    throw failureFromAbort(deadline.signal);
}

function pickTarget(
    targets: readonly DevToolsTarget[],
    server: ValidatedServerUrl,
): DevToolsTarget | undefined {
    const pageTargets = targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl);
    const sameOrigin = pageTargets.find(target => {
        if (!target.url) return false;
        try {
            return new URL(target.url).origin === server.parsed.origin;
        } catch {
            return false;
        }
    });
    return sameOrigin || pageTargets[0];
}

async function getCookiesFromDevTools(
    webSocketUrl: string,
    expectedPort: number,
    server: ValidatedServerUrl,
    deadline: LoginDeadline,
): Promise<BrowserCookie[]> {
    const debuggerUrl = validateDebuggerWebSocketUrl(webSocketUrl, expectedPort);
    const requestedUrls = [
        server.url,
        routeUrl(server, 'login').toString(),
        routeUrl(server, 'project').toString(),
    ];
    return sendCookieCommand(debuggerUrl, requestedUrls, deadline);
}

function validateDebuggerWebSocketUrl(webSocketUrl: string, expectedPort: number): URL {
    let parsed: URL;
    try {
        parsed = new URL(webSocketUrl);
    } catch {
        throw new BrowserLoginFailure('devtools-error', 'The browser returned an invalid debugging address.');
    }
    const hostname = parsed.hostname.toLowerCase();
    const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
    if (
        parsed.protocol !== 'ws:'
        || !isLoopback
        || parsed.username
        || parsed.password
        || Number(parsed.port) !== expectedPort
    ) {
        throw new BrowserLoginFailure('devtools-error', 'The browser debugging address was not loopback-only.');
    }
    return parsed;
}

async function sendCookieCommand(
    debuggerUrl: URL,
    requestedUrls: readonly string[],
    deadline: LoginDeadline,
): Promise<BrowserCookie[]> {
    deadline.throwIfAborted();
    return new Promise((resolve, reject) => {
        let settled = false;
        let upgradedSocket: Socket | undefined;
        let receiveBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        let fragments: Buffer[] = [];
        let fragmentedOpcode: number | undefined;
        let activeCommandId = 1;
        const key = randomBytes(16).toString('base64');
        const expectedAccept = createHash('sha1')
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest('base64');
        const request = http.request({
            host: '127.0.0.1',
            port: Number(debuggerUrl.port),
            path: `${debuggerUrl.pathname}${debuggerUrl.search}`,
            method: 'GET',
            agent: false,
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Key': key,
                'Sec-WebSocket-Version': '13',
            },
        });

        const cleanup = () => {
            clearTimeout(timer);
            deadline.signal.removeEventListener('abort', abortListener);
            request.removeAllListeners();
            upgradedSocket?.removeAllListeners();
        };
        const finish = (cookies?: BrowserCookie[], error?: BrowserLoginFailure) => {
            if (settled) return;
            settled = true;
            cleanup();
            try {
                if (upgradedSocket && !upgradedSocket.destroyed) {
                    upgradedSocket.write(encodeWebSocketFrame(0x8, Buffer.alloc(0)));
                    upgradedSocket.end();
                    upgradedSocket.destroy();
                }
            } catch {
                upgradedSocket?.destroy();
            }
            request.destroy();
            if (error) reject(error);
            else resolve(cookies || []);
        };
        const abortListener = () => finish(undefined, failureFromAbort(deadline.signal));
        const timer = setTimeout(() => finish(undefined, new BrowserLoginFailure(
            'devtools-error',
            'Timed out while reading cookies from the login browser.',
        )), deadline.remaining(CDP_REQUEST_TIMEOUT_MS));

        const sendCommand = (id: number, method: string, params?: Record<string, unknown>) => {
            const socket = upgradedSocket;
            if (!socket || socket.destroyed) {
                finish(undefined, new BrowserLoginFailure(
                    'devtools-error',
                    'The browser debugging connection closed unexpectedly.',
                ));
                return;
            }
            const command = JSON.stringify({ id, method, ...(params ? { params } : {}) });
            socket.write(encodeWebSocketFrame(0x1, Buffer.from(command, 'utf8')));
        };

        const handleMessage = (message: Buffer) => {
            if (message.length > MAX_WEBSOCKET_MESSAGE_BYTES) {
                finish(undefined, new BrowserLoginFailure(
                    'devtools-error',
                    'The browser returned an unexpectedly large cookie response.',
                ));
                return;
            }
            let payload: Record<string, unknown> | undefined;
            try {
                payload = asObject(JSON.parse(message.toString('utf8')) as unknown);
            } catch {
                return;
            }
            if (!payload || payload.id !== activeCommandId) return;

            const result = asObject(payload.result);
            const cookies = parseBrowserCookies(result?.cookies);
            if (cookies) {
                finish(cookies);
                return;
            }
            if (activeCommandId === 1) {
                activeCommandId = 2;
                sendCommand(2, 'Storage.getCookies');
                return;
            }
            finish(undefined, new BrowserLoginFailure(
                'devtools-error',
                'The login browser did not return readable cookies.',
            ));
        };

        const handleFrame = (frame: DecodedWebSocketFrame) => {
            if (frame.opcode === 0x8) {
                finish(undefined, new BrowserLoginFailure(
                    'devtools-error',
                    'The browser debugging connection closed before cookies were read.',
                ));
                return;
            }
            if (frame.opcode === 0x9) {
                upgradedSocket?.write(encodeWebSocketFrame(0xA, frame.payload));
                return;
            }
            if (frame.opcode === 0xA) return;
            if (frame.opcode === 0x1) {
                if (fragmentedOpcode !== undefined) {
                    finish(undefined, new BrowserLoginFailure('devtools-error', 'Invalid browser debugging frame.'));
                    return;
                }
                if (frame.fin) {
                    handleMessage(frame.payload);
                } else {
                    fragmentedOpcode = frame.opcode;
                    fragments = [frame.payload];
                }
                return;
            }
            if (frame.opcode === 0x0 && fragmentedOpcode === 0x1) {
                fragments.push(frame.payload);
                const totalLength = fragments.reduce((sum, fragment) => sum + fragment.length, 0);
                if (totalLength > MAX_WEBSOCKET_MESSAGE_BYTES) {
                    finish(undefined, new BrowserLoginFailure(
                        'devtools-error',
                        'The browser returned an unexpectedly large cookie response.',
                    ));
                    return;
                }
                if (frame.fin) {
                    const completeMessage = Buffer.concat(fragments, totalLength);
                    fragments = [];
                    fragmentedOpcode = undefined;
                    handleMessage(completeMessage);
                }
                return;
            }
            finish(undefined, new BrowserLoginFailure('devtools-error', 'Invalid browser debugging frame.'));
        };

        attachAbortListener(deadline.signal, abortListener);
        if (settled) return;
        request.once('upgrade', (response, socket, head) => {
            if (response.headers['sec-websocket-accept'] !== expectedAccept) {
                socket.destroy();
                finish(undefined, new BrowserLoginFailure(
                    'devtools-error',
                    'The browser debugging handshake could not be verified.',
                ));
                return;
            }
            upgradedSocket = socket;
            socket.setNoDelay(true);
            socket.on('data', (chunk: Buffer) => {
                if (settled) return;
                receiveBuffer = Buffer.concat([receiveBuffer, chunk]);
                try {
                    const decoded = decodeWebSocketFrames(receiveBuffer);
                    receiveBuffer = decoded.remaining;
                    for (const frame of decoded.frames) handleFrame(frame);
                } catch {
                    finish(undefined, new BrowserLoginFailure(
                        'devtools-error',
                        'The browser returned an invalid debugging response.',
                    ));
                }
            });
            socket.once('error', () => finish(undefined, new BrowserLoginFailure(
                'devtools-error',
                'The browser debugging connection failed.',
            )));
            socket.once('close', () => finish(undefined, new BrowserLoginFailure(
                'devtools-error',
                'The browser debugging connection closed before cookies were read.',
            )));
            if (head.length > 0) socket.emit('data', head);
            sendCommand(1, 'Network.getCookies', { urls: [...requestedUrls] });
        });
        request.once('response', response => {
            response.resume();
            finish(undefined, new BrowserLoginFailure(
                'devtools-error',
                'The browser rejected the debugging connection.',
            ));
        });
        request.once('error', () => finish(undefined, new BrowserLoginFailure(
            'devtools-error',
            'Could not connect to the browser debugging endpoint.',
        )));
        request.end();
    });
}

function encodeWebSocketFrame(opcode: number, payload: Buffer): Buffer {
    const mask = randomBytes(4);
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
        header = Buffer.from([0x80 | opcode, 0x80 | length]);
    } else if (length <= 0xFFFF) {
        header = Buffer.allocUnsafe(4);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.allocUnsafe(10);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }
    const maskedPayload = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index++) {
        maskedPayload[index] = payload[index] ^ mask[index % 4];
    }
    return Buffer.concat([header, mask, maskedPayload]);
}

function decodeWebSocketFrames(buffer: Buffer): {
    frames: DecodedWebSocketFrame[];
    remaining: Buffer;
} {
    const frames: DecodedWebSocketFrame[] = [];
    let offset = 0;
    while (buffer.length - offset >= 2) {
        const first = buffer[offset];
        const second = buffer[offset + 1];
        if ((first & 0x70) !== 0) throw new Error('Unsupported WebSocket extension.');
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0F;
        const masked = (second & 0x80) !== 0;
        if (masked) throw new Error('Server WebSocket frames must not be masked.');

        let payloadLength = second & 0x7F;
        let headerLength = 2;
        if (payloadLength === 126) {
            if (buffer.length - offset < 4) break;
            payloadLength = buffer.readUInt16BE(offset + 2);
            headerLength = 4;
        } else if (payloadLength === 127) {
            if (buffer.length - offset < 10) break;
            const longLength = buffer.readBigUInt64BE(offset + 2);
            if (longLength > BigInt(MAX_WEBSOCKET_MESSAGE_BYTES)) {
                throw new Error('WebSocket frame too large.');
            }
            payloadLength = Number(longLength);
            headerLength = 10;
        }
        if (payloadLength > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error('WebSocket frame too large.');
        if (opcode >= 0x8 && (!fin || payloadLength > 125)) throw new Error('Invalid control frame.');
        if (buffer.length - offset < headerLength + payloadLength) break;
        const payloadStart = offset + headerLength;
        frames.push({
            fin,
            opcode,
            payload: buffer.subarray(payloadStart, payloadStart + payloadLength),
        });
        offset = payloadStart + payloadLength;
    }
    return { frames, remaining: buffer.subarray(offset) };
}

function parseBrowserCookies(value: unknown): BrowserCookie[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.flatMap((candidate): BrowserCookie[] => {
        const cookie = asObject(candidate);
        if (!cookie) return [];
        if (
            typeof cookie.name !== 'string'
            || typeof cookie.value !== 'string'
            || typeof cookie.domain !== 'string'
        ) {
            return [];
        }
        return [{
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: optionalString(cookie.path),
            expires: typeof cookie.expires === 'number' ? cookie.expires : undefined,
            secure: typeof cookie.secure === 'boolean' ? cookie.secure : undefined,
        }];
    });
}

function buildCookieHeader(cookies: readonly BrowserCookie[], targetUrl: URL): string {
    const host = targetUrl.hostname.toLowerCase();
    const requestPath = targetUrl.pathname || '/';
    const nowSeconds = Date.now() / 1000;
    const matchingCookies = cookies
        .filter(cookie => {
            if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name)) return false;
            if (cookie.value.length > MAX_COOKIE_HEADER_BYTES || /[\x00-\x20\x7F;]/.test(cookie.value)) return false;
            if (!domainMatches(cookie.domain, host)) return false;
            if (!cookiePathMatches(cookie.path || '/', requestPath)) return false;
            if (cookie.secure && targetUrl.protocol !== 'https:') return false;
            return !(typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires <= nowSeconds);
        })
        .sort((left, right) => (right.path?.length || 1) - (left.path?.length || 1));

    const unique = new Map<string, string>();
    let byteLength = 0;
    for (const cookie of matchingCookies) {
        if (unique.has(cookie.name)) continue;
        const pair = `${cookie.name}=${cookie.value}`;
        const addedBytes = Buffer.byteLength(pair, 'utf8') + (unique.size > 0 ? 2 : 0);
        if (byteLength + addedBytes > MAX_COOKIE_HEADER_BYTES) continue;
        unique.set(cookie.name, pair);
        byteLength += addedBytes;
    }
    return [...unique.values()].join('; ');
}

function domainMatches(cookieDomain: string, host: string): boolean {
    const normalized = cookieDomain.replace(/^\./, '').toLowerCase();
    if (!normalized || /[\s\0/\\]/.test(normalized)) return false;
    return host === normalized || host.endsWith(`.${normalized}`);
}

function cookiePathMatches(cookiePath: string, requestPath: string): boolean {
    if (!cookiePath.startsWith('/') || /[\r\n\0]/.test(cookiePath)) return false;
    if (cookiePath === '/') return true;
    if (!requestPath.startsWith(cookiePath)) return false;
    return cookiePath.endsWith('/') || requestPath.length === cookiePath.length || requestPath[cookiePath.length] === '/';
}

async function isAuthenticatedCookie(
    server: ValidatedServerUrl,
    cookieHeader: string,
    deadline: LoginDeadline,
): Promise<boolean> {
    const projectUrl = routeUrl(server, 'project');
    return requestAuthenticatedPage(server, projectUrl, cookieHeader, deadline, 1);
}

type AuthenticationRedirect = 'login' | 'project' | 'other';

function classifyAuthenticationRedirect(
    server: ValidatedServerUrl,
    currentUrl: URL,
    location: string,
): AuthenticationRedirect {
    let redirect: URL;
    try {
        redirect = new URL(location, currentUrl);
    } catch {
        return 'other';
    }

    if (
        redirect.origin !== server.parsed.origin
        || redirect.username
        || redirect.password
    ) {
        return 'other';
    }

    const normalizedPath = redirect.pathname.replace(/\/+$/, '');
    const loginPath = routeUrl(server, 'login').pathname.replace(/\/+$/, '');
    if (normalizedPath === loginPath) return 'login';

    const projectPath = routeUrl(server, 'project').pathname.replace(/\/+$/, '');
    if (
        normalizedPath === projectPath
        && !redirect.search
        && !redirect.hash
    ) {
        return 'project';
    }
    return 'other';
}

function requestAuthenticatedPage(
    server: ValidatedServerUrl,
    requestUrl: URL,
    cookieHeader: string,
    deadline: LoginDeadline,
    remainingCanonicalRedirects: number,
): Promise<boolean> {
    const transport = requestUrl.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        let settled = false;
        let response: http.IncomingMessage | undefined;
        const request = transport.request(requestUrl, {
            method: 'GET',
            agent: false,
            headers: {
                Accept: 'text/html,*/*',
                Cookie: cookieHeader,
            },
        });
        const finish = (authenticated?: boolean, error?: BrowserLoginFailure) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            deadline.signal.removeEventListener('abort', abortListener);
            if (error) {
                response?.destroy();
                request.destroy();
                reject(error);
            } else {
                resolve(authenticated || false);
            }
        };
        const handOff = (nextRequest: Promise<boolean>) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            deadline.signal.removeEventListener('abort', abortListener);
            nextRequest.then(resolve, reject);
        };
        const abortListener = () => finish(undefined, failureFromAbort(deadline.signal));
        const timer = setTimeout(() => finish(undefined, new BrowserLoginFailure(
            'devtools-error',
            'The Overleaf session check timed out.',
        )), deadline.remaining(AUTH_REQUEST_TIMEOUT_MS));

        attachAbortListener(deadline.signal, abortListener);
        if (settled) return;
        request.once('response', incoming => {
            response = incoming;
            const status = incoming.statusCode || 0;
            const location = incoming.headers.location;
            if (status === 200) {
                const chunks: Buffer[] = [];
                let byteLength = 0;
                incoming.on('data', (chunk: Buffer) => {
                    byteLength += chunk.length;
                    if (byteLength > MAX_AUTH_RESPONSE_BYTES) {
                        finish(false);
                        incoming.destroy();
                        return;
                    }
                    chunks.push(chunk);
                });
                incoming.once('end', () => {
                    const html = Buffer.concat(chunks, byteLength).toString('utf8');
                    finish(containsAuthenticatedProjectPage(html));
                });
                incoming.once('error', () => finish(undefined, new BrowserLoginFailure(
                    'devtools-error',
                    'The Overleaf session check was interrupted.',
                )));
                return;
            }
            incoming.resume();
            if (status >= 300 && status < 400 && location) {
                const redirectKind = classifyAuthenticationRedirect(server, requestUrl, location);
                if (redirectKind === 'login') {
                    finish(false);
                    return;
                }
                if (redirectKind === 'project' && remainingCanonicalRedirects > 0) {
                    const redirect = new URL(location, requestUrl);
                    handOff(requestAuthenticatedPage(
                        server,
                        redirect,
                        cookieHeader,
                        deadline,
                        remainingCanonicalRedirects - 1,
                    ));
                    return;
                }
            }
            finish(false);
        });
        request.once('error', () => finish(undefined, new BrowserLoginFailure(
            'devtools-error',
            'Could not verify the Overleaf browser session.',
        )));
        request.end();
    });
}

function containsAuthenticatedProjectPage(html: string): boolean {
    return Boolean(readOverleafProjectAuthMetadata(html));
}

async function terminateProcessTree(proc: ChildProcess, timeoutMs: number): Promise<void> {
    if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
    if (process.platform === 'win32') {
        await runCleanupCommand('taskkill', ['/PID', String(proc.pid), '/T', '/F'], timeoutMs);
        if (proc.exitCode === null && proc.signalCode === null) {
            try { proc.kill(); } catch { /* process may already be closed */ }
        }
        await waitForProcessExit(proc, timeoutMs);
        return;
    }

    try {
        process.kill(-proc.pid, 'SIGTERM');
    } catch {
        try { proc.kill('SIGTERM'); } catch { /* process may already be closed */ }
    }
    if (await waitForProcessExit(proc, Math.min(1_500, timeoutMs))) return;
    try {
        process.kill(-proc.pid, 'SIGKILL');
    } catch {
        try { proc.kill('SIGKILL'); } catch { /* process may already be closed */ }
    }
    await waitForProcessExit(proc, Math.max(1, timeoutMs - 1_500));
}

async function runCleanupCommand(executable: string, args: readonly string[], timeoutMs: number): Promise<void> {
    await new Promise<void>(resolve => {
        let settled = false;
        let proc: ChildProcess;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            try { proc.kill(); } catch { /* process may already be closed */ }
            finish();
        }, timeoutMs);
        try {
            proc = spawn(executable, [...args], {
                shell: false,
                stdio: 'ignore',
                windowsHide: true,
            });
        } catch {
            finish();
            return;
        }
        proc.once('error', finish);
        proc.once('close', finish);
    });
}

async function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (proc.exitCode !== null || proc.signalCode !== null) return true;
    return new Promise(resolve => {
        let settled = false;
        const finish = (exited: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            proc.removeListener('exit', exitedListener);
            resolve(exited);
        };
        const exitedListener = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        proc.once('exit', exitedListener);
    });
}

async function removeTemporaryProfile(
    tempProfileDir: string,
    log?: (message: string) => void,
): Promise<boolean> {
    const resolvedTempRoot = path.resolve(os.tmpdir());
    const resolvedProfile = path.resolve(tempProfileDir);
    if (
        path.dirname(resolvedProfile) !== resolvedTempRoot
        || !path.basename(resolvedProfile).startsWith(PROFILE_PREFIX)
    ) {
        safeLog(log, 'The isolated browser profile could not be safely removed.');
        return false;
    }

    const retryDelays = [0, 100, 250, 500, 1_000];
    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
        if (retryDelays[attempt] > 0) await plainDelay(retryDelays[attempt]);
        try {
            await fs.promises.rm(resolvedProfile, { recursive: true, force: true });
            return true;
        } catch {
            if (attempt === retryDelays.length - 1) {
                safeLog(log, 'The isolated browser profile could not be removed completely.');
            }
        }
    }
    return false;
}

async function abortableDelay(ms: number, deadline: LoginDeadline): Promise<void> {
    const delayMs = deadline.remaining(ms);
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: BrowserLoginFailure) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            deadline.signal.removeEventListener('abort', abortListener);
            if (error) reject(error);
            else resolve();
        };
        const abortListener = () => finish(failureFromAbort(deadline.signal));
        const timer = setTimeout(() => finish(), delayMs);
        attachAbortListener(deadline.signal, abortListener);
        if (settled) return;
    });
}

async function plainDelay(ms: number): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, ms));
}

function isFileNotFoundError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function asObject(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/** Pure helpers exported for focused security and parsing tests. */
export const browserCookieLoginInternals = {
    buildCookieHeader,
    cookiePathMatches,
    decodeWebSocketFrames,
    dedupeCandidates,
    domainMatches,
    executableForBundleId,
    executableForDesktopId,
    extractExecutableFromCommand,
    isChromiumBrowserExecutable,
    normalizeLoginTimeout,
    parseBrowserCookies,
    parseDevToolsActivePort,
    classifyAuthenticationRedirect,
    containsAuthenticatedProjectPage,
    routeUrl,
    validateDebuggerWebSocketUrl,
};
