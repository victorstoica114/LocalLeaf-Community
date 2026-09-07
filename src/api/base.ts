/**
 * LocalLeaf API - Base HTTP client for Overleaf
 * Adapted from Overleaf-Workshop
 */

import * as http from 'http';
import * as https from 'https';
import * as stream from 'stream';
import type { RequestInit, Response } from 'node-fetch';
import { Identity } from '../utils/credentialManager';
import { validateServerUrl } from '../utils/serverUrl';
import { validateProjectEntityName } from '../utils/pathSafety';
import {
    MAX_REMOTE_FILE_BYTES,
    validateOverleafId,
    validateRemoteDocumentLines,
} from '../utils/remoteValidation';
import { httpErrorMessage } from '../utils/errorMessages';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_API_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_PARTIAL_DOWNLOADS = 10_000;
const MAX_AUTH_HEADER_CHARACTERS = 65_536;
const MAX_LOGIN_EMAIL_CHARACTERS = 4096;
const MAX_LOGIN_PASSWORD_CHARACTERS = 65_536;
const MAX_LOGIN_MESSAGE_CHARACTERS = 4096;
const MAX_PROJECT_LIST_ITEMS = 100_000;

type JsonObject = Record<string, unknown>;

function asJsonObject(value: unknown): JsonObject | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonObject
        : undefined;
}

function boundedMessage(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0
        ? value.slice(0, MAX_LOGIN_MESSAGE_CHARACTERS)
        : undefined;
}

function validateAuthHeader(
    value: unknown,
    label: string,
    allowEmpty: boolean = false,
): string {
    if (
        typeof value !== 'string'
        || (!allowEmpty && value.length === 0)
        || value.length > MAX_AUTH_HEADER_CHARACTERS
        || /[\r\n\0]/.test(value)
    ) {
        throw new Error(`Invalid Overleaf ${label}.`);
    }
    return value;
}

function validatedIdentity(value: unknown, allowEmptyCookies: boolean = false): Identity {
    if (!value || typeof value !== 'object') {
        throw new Error('Invalid Overleaf identity.');
    }
    const candidate = value as Partial<Identity>;
    return {
        csrfToken: validateAuthHeader(candidate.csrfToken, 'CSRF token'),
        cookies: validateAuthHeader(candidate.cookies, 'cookie header', allowEmptyCookies),
    };
}

function routeSegment(value: string, label: string): string {
    return encodeURIComponent(validateOverleafId(value, label));
}

function firstValidOverleafId(label: string, ...values: unknown[]): string | undefined {
    for (const value of values) {
        if (value === undefined || value === null) continue;
        try {
            return validateOverleafId(value, label);
        } catch {
            // Some Overleaf versions expose the same ID under a different key.
        }
    }
    return undefined;
}

function boundedMetadata(value: unknown, maximumLength: number): string | undefined {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maximumLength
        && !/[\r\n\0]/.test(value)
        ? value
        : undefined;
}

function entityRouteSegment(entityType: string): string {
    if (entityType !== 'doc' && entityType !== 'file' && entityType !== 'folder') {
        throw new Error(`Invalid Overleaf entity type: ${entityType}`);
    }
    return entityType;
}

function mergeCookieHeaders(...headers: Array<string | undefined>): string {
    const cookies = new Map<string, string>();
    for (const header of headers) {
        for (const rawPair of header?.split(';') || []) {
            const pair = rawPair.trim();
            const separator = pair.indexOf('=');
            if (separator <= 0) continue;
            cookies.set(pair.slice(0, separator).trim(), pair);
        }
    }
    return [...cookies.values()].join('; ');
}

type HtmlAttributes = ReadonlyMap<string, string>;

/**
 * Visit HTML start tags without relying on a permissive `.*` regular expression.
 * This is deliberately a small tokenizer rather than a full DOM parser: Overleaf's
 * authentication metadata only needs tag and attribute names/values.
 */
function visitHtmlStartTags(
    html: string,
    visitor: (tagName: string, attributes: HtmlAttributes) => boolean | void,
): void {
    let cursor = 0;

    while (cursor < html.length) {
        const tagStart = html.indexOf('<', cursor);
        if (tagStart < 0) return;

        if (html.startsWith('<!--', tagStart)) {
            const commentEnd = html.indexOf('-->', tagStart + 4);
            if (commentEnd < 0) return;
            cursor = commentEnd + 3;
            continue;
        }

        let nameStart = tagStart + 1;
        if (
            nameStart >= html.length
            || html[nameStart] === '/'
            || html[nameStart] === '!'
            || html[nameStart] === '?'
        ) {
            cursor = tagStart + 1;
            continue;
        }

        let nameEnd = nameStart;
        while (nameEnd < html.length && isHtmlNameCharacter(html.charCodeAt(nameEnd))) {
            nameEnd++;
        }
        if (nameEnd === nameStart) {
            cursor = tagStart + 1;
            continue;
        }

        const tagEnd = findHtmlTagEnd(html, nameEnd);
        if (tagEnd < 0) return;
        const tagName = html.slice(nameStart, nameEnd).toLowerCase();
        if (visitor(tagName, parseHtmlAttributes(html, nameEnd, tagEnd)) === true) return;

        // These elements contain raw text, where a string such as "<meta ...>"
        // must not be treated as an actual element.
        if (tagName === 'script' || tagName === 'style' || tagName === 'textarea' || tagName === 'title') {
            const closingStart = indexOfAsciiCaseInsensitive(html, `</${tagName}`, tagEnd + 1);
            if (closingStart < 0) return;
            const closingEnd = html.indexOf('>', closingStart + tagName.length + 2);
            if (closingEnd < 0) return;
            cursor = closingEnd + 1;
        } else {
            cursor = tagEnd + 1;
        }
    }
}

function indexOfAsciiCaseInsensitive(source: string, needle: string, from: number): number {
    for (let start = source.indexOf('<', from); start >= 0; start = source.indexOf('<', start + 1)) {
        if (start + needle.length > source.length) return -1;
        let matched = true;
        for (let offset = 0; offset < needle.length; offset++) {
            const sourceCode = source.charCodeAt(start + offset);
            const normalizedSourceCode = sourceCode >= 0x41 && sourceCode <= 0x5a
                ? sourceCode + 0x20
                : sourceCode;
            if (normalizedSourceCode !== needle.charCodeAt(offset)) {
                matched = false;
                break;
            }
        }
        if (matched) {
            const nextCode = source.charCodeAt(start + needle.length);
            if (!Number.isNaN(nextCode) && isHtmlNameCharacter(nextCode)) continue;
            return start;
        }
    }
    return -1;
}

function isHtmlNameCharacter(code: number): boolean {
    return (code >= 0x30 && code <= 0x39)
        || (code >= 0x41 && code <= 0x5a)
        || (code >= 0x61 && code <= 0x7a)
        || code === 0x2d
        || code === 0x3a
        || code === 0x5f;
}

function isHtmlWhitespace(code: number): boolean {
    return code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
}

function findHtmlTagEnd(html: string, start: number): number {
    let quote = 0;
    for (let cursor = start; cursor < html.length; cursor++) {
        const code = html.charCodeAt(cursor);
        if (quote !== 0) {
            if (code === quote) quote = 0;
        } else if (code === 0x22 || code === 0x27) {
            quote = code;
        } else if (code === 0x3e) {
            return cursor;
        }
    }
    return -1;
}

function parseHtmlAttributes(html: string, start: number, end: number): HtmlAttributes {
    const attributes = new Map<string, string>();
    let cursor = start;

    while (cursor < end) {
        while (cursor < end && (isHtmlWhitespace(html.charCodeAt(cursor)) || html[cursor] === '/')) cursor++;
        if (cursor >= end) break;

        const nameStart = cursor;
        while (
            cursor < end
            && !isHtmlWhitespace(html.charCodeAt(cursor))
            && html[cursor] !== '='
            && html[cursor] !== '/'
        ) {
            cursor++;
        }
        if (cursor === nameStart) {
            cursor++;
            continue;
        }

        const name = html.slice(nameStart, cursor).toLowerCase();
        while (cursor < end && isHtmlWhitespace(html.charCodeAt(cursor))) cursor++;

        let value = '';
        if (cursor < end && html[cursor] === '=') {
            cursor++;
            while (cursor < end && isHtmlWhitespace(html.charCodeAt(cursor))) cursor++;
            const quote = html.charCodeAt(cursor);
            if (quote === 0x22 || quote === 0x27) {
                cursor++;
                const valueStart = cursor;
                while (cursor < end && html.charCodeAt(cursor) !== quote) cursor++;
                value = html.slice(valueStart, cursor);
                if (cursor < end) cursor++;
            } else {
                const valueStart = cursor;
                while (
                    cursor < end
                    && !isHtmlWhitespace(html.charCodeAt(cursor))
                    && !(html[cursor] === '/' && cursor + 1 === end)
                ) {
                    cursor++;
                }
                value = html.slice(valueStart, cursor);
            }
        }

        // Browsers use the first duplicate attribute. Matching that behaviour
        // also prevents an ambiguous later attribute from changing auth data.
        if (!attributes.has(name)) attributes.set(name, decodeHtmlAttributeValue(value));
    }

    return attributes;
}

function decodeHtmlAttributeValue(value: string): string {
    return value.replace(
        /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|apos|gt|lt|quot));/gi,
        (entity, decimal: string | undefined, hexadecimal: string | undefined, named: string | undefined) => {
            const codePoint = decimal
                ? Number.parseInt(decimal, 10)
                : hexadecimal
                    ? Number.parseInt(hexadecimal, 16)
                    : undefined;
            if (codePoint !== undefined) {
                if (
                    codePoint <= 0x1f
                    || codePoint === 0x7f
                    || codePoint > 0x10ffff
                    || (codePoint >= 0xd800 && codePoint <= 0xdfff)
                ) {
                    return entity;
                }
                return String.fromCodePoint(codePoint);
            }
            switch (named?.toLowerCase()) {
                case 'amp': return '&';
                case 'apos': return "'";
                case 'gt': return '>';
                case 'lt': return '<';
                case 'quot': return '"';
                default: return entity;
            }
        },
    );
}

function findNamedElementAttributes(
    html: string,
    tagName: string,
    selectorValue: string,
): HtmlAttributes | undefined {
    let result: HtmlAttributes | undefined;
    const normalizedTagName = tagName.toLowerCase();
    const normalizedSelector = selectorValue.toLowerCase();
    visitHtmlStartTags(html, (candidateTag, attributes) => {
        if (
            candidateTag === normalizedTagName
            && attributes.get('name')?.toLowerCase() === normalizedSelector
        ) {
            result = attributes;
            return true;
        }
        return false;
    });
    return result;
}

function findNamedElementValue(
    html: string,
    tagName: string,
    selectorValue: string,
    valueAttribute: string,
): string | undefined {
    return findNamedElementAttributes(html, tagName, selectorValue)?.get(valueAttribute.toLowerCase());
}

function looksLikeLoginPage(html: string): boolean {
    let loginForm = false;
    let passwordInput = false;
    visitHtmlStartTags(html, (tagName, attributes) => {
        if (tagName === 'form') {
            const action = attributes.get('action')?.toLowerCase();
            if (action && (action === 'login' || action.includes('/login'))) loginForm = true;
        } else if (tagName === 'input' && attributes.get('type')?.toLowerCase() === 'password') {
            passwordInput = true;
        }
        return loginForm || passwordInput;
    });
    return loginForm || passwordInput;
}

function isRedirectStatus(status: number): boolean {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export interface OverleafProjectAuthMetadata {
    userId: string;
    userEmail: string;
    csrfToken: string;
}

/** Read authenticated Overleaf project metadata from real HTML elements only. */
export function readOverleafProjectAuthMetadata(html: string): OverleafProjectAuthMetadata | undefined {
    const userId = findNamedElementValue(html, 'meta', 'ol-user_id', 'content');
    const userEmail = findNamedElementValue(html, 'meta', 'ol-usersEmail', 'content');
    const csrfToken = findNamedElementValue(html, 'meta', 'ol-csrfToken', 'content');
    if (!userId || !csrfToken) return undefined;
    try {
        validateOverleafId(userId, 'user ID');
        validateAuthHeader(csrfToken, 'CSRF token');
        if (userEmail !== undefined && (
            userEmail.length > MAX_LOGIN_EMAIL_CHARACTERS || /[\r\n\0]/.test(userEmail)
        )) return undefined;
        return { userId, userEmail: userEmail || '', csrfToken };
    } catch {
        return undefined;
    }
}

type UserIdentityLookup =
    | { kind: 'success'; metadata: OverleafProjectAuthMetadata }
    | { kind: 'invalid-session' }
    | { kind: 'error'; response: ResponseSchema };

class ApiHttpError extends Error {
    constructor(
        message: string,
        readonly status?: number,
        readonly authError?: AuthErrorType,
    ) {
        super(message);
    }
}

export interface ProjectInfo {
    id: string;
    name: string;
    lastUpdated?: string;
    accessLevel: 'owner' | 'collaborator' | 'readOnly';
    archived?: boolean;
    trashed?: boolean;
}

export interface FileEntity {
    _id: string;
    _type: 'doc' | 'file' | 'folder';
    name: string;
}

export interface FolderEntity extends FileEntity {
    _type: 'folder';
    docs: FileEntity[];
    fileRefs: FileEntity[];
    folders: FolderEntity[];
}

export interface ProjectEntity {
    _id: string;
    name: string;
    rootDoc_id?: string;
    rootFolder: FolderEntity[];
    compiler?: string;
    spellCheckLanguage?: string;
    owner: { _id: string; email: string; first_name: string; last_name?: string };
    members: Array<{ _id: string; email: string; first_name: string; last_name?: string; privileges: string }>;
}

export interface ProjectDetails {
    projectId: string;
    projectName?: string;
    rootDocId?: string;
    userId?: string;
    userEmail?: string;
    compiler?: string;
    rootFolder?: FolderEntity[];
}

export type AuthErrorType = 'session_expired' | 'invalid_credentials';

export interface ResponseSchema {
    type: 'success' | 'error';
    httpStatus?: number;
    message?: string;
    authError?: AuthErrorType;
    userInfo?: { userId: string; userEmail: string };
    identity?: Identity;
    projects?: ProjectInfo[];
    project?: ProjectEntity;
    content?: Uint8Array;
    file?: FileEntity;
    doc?: FileEntity;
    folder?: FileEntity;
}

export class BaseAPI {
    private url: string;
    private agent: http.Agent | https.Agent;
    private identity?: Identity;
    private readonly activeRequests = new Set<AbortController>();
    private disposed = false;

    constructor(url: string) {
        const server = validateServerUrl(url);
        this.url = `${server.url}/`;
        this.agent = server.parsed.protocol === 'http:'
            ? new http.Agent({ keepAlive: true })
            : new https.Agent({ keepAlive: true });
    }

    private async fetchRoute(
        route: string,
        options: RequestInit,
        maxResponseBytes: number = MAX_API_RESPONSE_BYTES,
    ): Promise<Response> {
        if (this.disposed) {
            throw new Error('Overleaf request cancelled because the sync session was closed.');
        }

        const fetch = (await import('node-fetch')).default;
        const controller = new AbortController();
        this.activeRequests.add(controller);
        const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            clearTimeout(timeout);
            this.activeRequests.delete(controller);
        };

        try {
            const response = await fetch(this.url + route, {
                redirect: 'manual',
                agent: this.agent,
                ...options,
                signal: controller.signal,
                size: maxResponseBytes,
            });
            if (response.body) {
                response.body.once('end', release);
                response.body.once('close', release);
                response.body.once('error', release);
            } else {
                release();
            }
            return response;
        } catch (error) {
            release();
            if (controller.signal.aborted) {
                const reason = this.disposed ? 'sync session was closed' : 'request timed out';
                throw new Error(`Overleaf ${reason}.`);
            }
            throw error;
        }
    }

    private async responseError(response: Response): Promise<ResponseSchema> {
        const location = isRedirectStatus(response.status)
            ? response.headers.get('location')
            : null;
        if (location && this.isLoginRedirect(location)) {
            this.discardResponseBody(response);
            return {
                type: 'error',
                message: 'Session expired',
                authError: 'session_expired',
            };
        }

        let detail = '';
        try {
            detail = await response.text();
        } catch {
            detail = response.statusText;
        }
        const authError = response.status === 401
            ? 'session_expired' as const
            : undefined;
        return {
            type: 'error',
            httpStatus: response.status,
            message: authError ? 'Session expired' : httpErrorMessage(
                response.status, detail, response.headers.get('content-type') || '',
            ),
            authError,
        };
    }

    private discardResponseBody(response: Response): void {
        response.body?.resume();
    }

    private isPotentialHtmlDownload(response: Response, content: Buffer): boolean {
        const contentType = response.headers.get('content-type')?.toLowerCase() || '';
        const prefix = content.subarray(0, 4096).toString('utf8');
        return contentType.includes('text/html')
            || contentType.includes('application/xhtml+xml')
            || /^\s*(?:<!doctype\s+html|<html|<form)\b/i.test(prefix);
    }

    private getResponseCookies(response: Response): string {
        const setCookieHeaders = response.headers.raw()['set-cookie'] || [];
        return validateAuthHeader(
            mergeCookieHeaders(...setCookieHeaders.map(header => header.split(';', 1)[0])),
            'cookie header',
            true,
        );
    }

    /** Abort all active requests and remove the in-memory identity. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.identity = undefined;
        for (const controller of this.activeRequests) {
            controller.abort();
        }
        this.activeRequests.clear();
        this.agent.destroy();
    }

    /**
     * Get CSRF token from login page
     */
    private async getCsrfToken(): Promise<Identity> {
        const res = await this.fetchRoute('login', {
            method: 'GET',
        });
        if (!res.ok) {
            const failure = await this.responseError(res);
            throw new Error(failure.message || 'Failed to load the Overleaf login page.');
        }
        const body = await res.text();
        const csrfToken = findNamedElementValue(body, 'input', '_csrf', 'value');
        if (!csrfToken) {
            throw new Error('Failed to get CSRF token.');
        }
        validateAuthHeader(csrfToken, 'CSRF token');
        const cookies = this.getResponseCookies(res);
        return { csrfToken, cookies };
    }

    /**
     * Get user ID from project page (validates cookies)
     */
    private async getUserId(cookies: string): Promise<UserIdentityLookup> {
        const requestOptions: RequestInit = {
            method: 'GET',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': cookies,
            }
        };
        let route: 'project' | 'project/' = 'project';
        let res = await this.fetchRoute(route, requestOptions);

        if (isRedirectStatus(res.status)) {
            const location = res.headers.get('location');
            if (location && this.isLoginRedirect(location)) {
                this.discardResponseBody(res);
                return { kind: 'invalid-session' };
            }

            const canonicalRoute = location
                ? this.getCanonicalProjectRedirectRoute(location, route)
                : undefined;
            if (canonicalRoute) {
                this.discardResponseBody(res);
                route = canonicalRoute;
                res = await this.fetchRoute(route, requestOptions);
            }
        }

        if (res.status === 401) {
            await this.responseError(res);
            return { kind: 'invalid-session' };
        }
        if (isRedirectStatus(res.status)) {
            const location = res.headers.get('location');
            if (location && this.isLoginRedirect(location)) {
                this.discardResponseBody(res);
                return { kind: 'invalid-session' };
            }
            return { kind: 'error', response: await this.responseError(res) };
        }
        if (!res.ok) {
            return { kind: 'error', response: await this.responseError(res) };
        }

        const body = await res.text();
        const metadata = readOverleafProjectAuthMetadata(body);
        if (metadata) return { kind: 'success', metadata };
        if (looksLikeLoginPage(body)) {
            return { kind: 'invalid-session' };
        }
        return {
            kind: 'error',
            response: {
                type: 'error',
                message: 'Overleaf returned a project page without authentication metadata.',
            },
        };
    }

    /**
     * Accept only trailing-slash canonicalization for the configured project
     * route. Returning a local route prevents redirects from sending cookies to
     * another origin or outside a configured self-hosted base path.
     */
    private getCanonicalProjectRedirectRoute(
        location: string,
        currentRoute: 'project' | 'project/',
    ): 'project' | 'project/' | undefined {
        try {
            const destination = new URL(location, this.url);
            const server = new URL(this.url);
            if (
                destination.origin !== server.origin
                || destination.username
                || destination.password
                || destination.search
                || destination.hash
            ) {
                return undefined;
            }

            const canonicalRoute = currentRoute === 'project' ? 'project/' : 'project';
            const canonicalPath = new URL(canonicalRoute, this.url).pathname;
            return destination.pathname === canonicalPath ? canonicalRoute : undefined;
        } catch {
            return undefined;
        }
    }

    private isLoginRedirect(location: string): boolean {
        try {
            const destination = new URL(location, this.url);
            const server = new URL(this.url);
            if (destination.origin !== server.origin) return false;
            const destinationPath = destination.pathname.replace(/\/+$/, '').toLowerCase();
            const configuredLoginPath = new URL('login', this.url).pathname.replace(/\/+$/, '').toLowerCase();
            return destinationPath === configuredLoginPath || destinationPath.endsWith('/login');
        } catch {
            return false;
        }
    }

    /**
     * Update cookies with socket.io session
     */
    async updateCookies(identity: Identity): Promise<Identity> {
        const currentIdentity = validatedIdentity(identity);
        const res = await this.fetchRoute('socket.io/socket.io.js', {
            method: 'GET',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': currentIdentity.cookies,
            }
        });
        const cookies = this.getResponseCookies(res);
        this.discardResponseBody(res);
        return validatedIdentity({
            ...currentIdentity,
            cookies: mergeCookieHeaders(currentIdentity.cookies, cookies),
        });
    }

    /**
     * Login with cookies (recommended for www.overleaf.com)
     */
    async cookiesLogin(cookies: string): Promise<ResponseSchema> {
        if (
            typeof cookies !== 'string'
            || cookies.length === 0
            || cookies.length > 65536
            || /[\r\n\0]/.test(cookies)
        ) {
            return { type: 'error', message: 'The Overleaf cookie header is invalid.' };
        }
        const validation = await this.getUserId(cookies);
        if (validation.kind === 'success') {
            const { userId, userEmail, csrfToken } = validation.metadata;
            const identity = await this.updateCookies({ cookies, csrfToken });
            return {
                type: 'success',
                userInfo: { userId, userEmail },
                identity,
            };
        }
        if (validation.kind === 'error') return validation.response;
        return {
            type: 'error',
            message: 'Failed to validate cookies. Please check that you copied the correct cookies.',
        };
    }

    /**
     * Login with email and password (not available for www.overleaf.com due to SSO/captcha)
     */
    async passportLogin(email: string, password: string): Promise<ResponseSchema> {
        if (
            typeof email !== 'string'
            || email.length === 0
            || email.length > MAX_LOGIN_EMAIL_CHARACTERS
            || /[\r\n\0]/.test(email)
        ) {
            return { type: 'error', message: 'The Overleaf login email is invalid.' };
        }
        if (
            typeof password !== 'string'
            || password.length === 0
            || password.length > MAX_LOGIN_PASSWORD_CHARACTERS
        ) {
            return { type: 'error', message: 'The Overleaf login password is invalid.' };
        }

        const identity = await this.getCsrfToken();
        const res = await this.fetchRoute('login', {
            method: 'POST',
            headers: {
                'Accept': '*/*',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Content-Type': 'application/json',
                'Cookie': identity.cookies,
                'X-Csrf-Token': identity.csrfToken,
            },
            body: JSON.stringify({ _csrf: identity.csrfToken, email, password }),
        });

        if (res.status === 302) {
            const text = await res.text();
            const redirect = boundedMessage(text.match(/Found. Redirecting to (.*)/)?.[1]);
            if (redirect === '/project') {
                const newCookies = mergeCookieHeaders(identity.cookies, this.getResponseCookies(res));
                if (!newCookies) return { type: 'error', message: 'Login returned no session cookie.' };
                return this.cookiesLogin(newCookies);
            }
            return {
                type: 'error',
                message: redirect ? `Redirecting to ${redirect}` : 'Login returned an invalid redirect.',
            };
        } else if (res.status === 200) {
            const json = asJsonObject(await res.json());
            const message = asJsonObject(json?.message);
            return { type: 'error', message: boundedMessage(message?.message) || 'Login failed' };
        } else if (res.status === 401) {
            const json = asJsonObject(await res.json());
            const message = asJsonObject(json?.message);
            return { type: 'error', message: boundedMessage(message?.text) || 'Unauthorized' };
        }
        return this.responseError(res);
    }

    /**
     * Set identity for authenticated requests
     */
    setIdentity(identity: Identity): this {
        this.identity = validatedIdentity(identity);
        return this;
    }

    /**
     * Get current identity
     */
    getIdentity(): Identity | undefined {
        return this.identity ? { ...this.identity } : undefined;
    }

    /**
     * Initialize Socket.io connection
     * Reference: Overleaf-Workshop base.ts _initSocketV0
     */
    initSocket(identity: Identity, query?: string): SocketIOClient.Socket {
        const safeIdentity = validatedIdentity(identity);
        const socketUrl = new URL(this.url).origin + (query ?? '');

        const io: SocketIOClientStatic = require('socket.io-client');
        const options: SocketIOClient.ConnectOpts & {
            reconnect: boolean;
            'force new connection': boolean;
            extraHeaders: Record<string, string>;
        } = {
            reconnect: false,
            'force new connection': true,
            extraHeaders: {
                'Origin': new URL(this.url).origin,
                'Cookie': safeIdentity.cookies,
            },
        };
        const socket = io.connect(socketUrl, options);

        return socket;
    }

    /**
     * Generic HTTP request
     */
    private async request(
        method: 'GET' | 'POST' | 'DELETE',
        route: string,
        body?: object,
        extraHeaders?: object
    ): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        const headers: Record<string, string> = {
            'Connection': 'keep-alive',
            'Cookie': this.identity.cookies,
            ...extraHeaders,
        };

        const fetchOptions: RequestInit = {
            method,
            headers,
        };

        if (method === 'POST' && body) {
            headers['Content-Type'] = 'application/json';
            fetchOptions.body = JSON.stringify({ _csrf: this.identity.csrfToken, ...body });
        }

        if (method === 'DELETE') {
            headers['X-Csrf-Token'] = this.identity.csrfToken;
        }

        const res = await this.fetchRoute(route, fetchOptions);

        if (res.status === 200 || res.status === 204) {
            this.discardResponseBody(res);
            return { type: 'success' };
        }
        return this.responseError(res);
    }

    /**
     * Download file content
     */
    private async download(route: string): Promise<Buffer> {
        if (!this.identity) {
            throw new Error('Not authenticated');
        }

        const content: Buffer[] = [];
        let offset = 0;

        for (let requestCount = 0; requestCount < MAX_PARTIAL_DOWNLOADS; requestCount++) {
            const headers: Record<string, string> = {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
            };
            if (offset > 0) {
                headers.Range = `bytes=${offset}-`;
            }

            const res = await this.fetchRoute(route, {
                method: 'GET',
                headers,
            }, MAX_REMOTE_FILE_BYTES);

            if (res.status === 200) {
                if (offset !== 0) {
                    this.discardResponseBody(res);
                    throw new ApiHttpError('The Overleaf server stopped a partial download unexpectedly.');
                }
                const body = await res.buffer();
                if (this.isPotentialHtmlDownload(res, body)) {
                    // HTML may be a legitimate project file, a rewritten login
                    // response, or a WAF/policy page. Verify the account before
                    // classifying it, and never save an ambiguous login page as
                    // binary project content.
                    const validation = await this.getUserId(this.identity.cookies);
                    if (validation.kind === 'invalid-session') {
                        throw new ApiHttpError('Session expired', res.status, 'session_expired');
                    }
                    if (validation.kind === 'error') {
                        throw new ApiHttpError(
                            `Could not verify the account after an HTML file response: ${validation.response.message || 'unknown Overleaf response'}`,
                            res.status,
                        );
                    }
                    const sample = body.subarray(0, 4 * 1024 * 1024).toString('utf8');
                    if (looksLikeLoginPage(sample)) {
                        throw new ApiHttpError(
                            'Overleaf returned a login page for a file even though the account endpoint remained available.',
                            res.status,
                        );
                    }
                }
                return body;
            }

            if (res.status === 401) {
                this.discardResponseBody(res);
                throw new ApiHttpError('Session expired', res.status);
            }
            if (res.status !== 206) {
                const failure = await this.responseError(res);
                throw new ApiHttpError(
                    failure.message || 'File download failed',
                    res.status,
                    failure.authError,
                );
            }

            const contentRange = res.headers.get('content-range');
            const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
            if (!match) {
                this.discardResponseBody(res);
                throw new ApiHttpError('The Overleaf server returned an invalid partial download range.');
            }

            const start = Number(match[1]);
            const end = Number(match[2]);
            const total = Number(match[3]);
            if (
                !Number.isSafeInteger(start)
                || !Number.isSafeInteger(end)
                || !Number.isSafeInteger(total)
                || start !== offset
                || end < start
                || end >= total
                || total > MAX_REMOTE_FILE_BYTES
            ) {
                this.discardResponseBody(res);
                throw new ApiHttpError('The Overleaf server returned an unsafe partial download range.');
            }

            const chunk = await res.buffer();
            if (chunk.length !== end - start + 1) {
                throw new ApiHttpError('The Overleaf server returned an incomplete partial download.');
            }
            content.push(chunk);
            offset = end + 1;
            if (offset === total) {
                return Buffer.concat(content, total);
            }
        }

        throw new ApiHttpError('The Overleaf server returned too many partial download responses.');
    }

    /**
     * Get list of user's projects
     */
    async getProjects(): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        const res = await this.fetchRoute('user/projects', {
            method: 'GET',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
            },
        });

        if (isRedirectStatus(res.status)) {
            const location = res.headers.get('location');
            if (location && this.isLoginRedirect(location)) {
                this.discardResponseBody(res);
                return {
                    type: 'error',
                    message: 'Session expired',
                    authError: 'session_expired',
                };
            }
        }

        if (res.status === 401) {
            this.discardResponseBody(res);
            return {
                type: 'error',
                message: 'Session expired',
                authError: 'session_expired',
            };
        }

        if (res.status === 200) {
            const body = await res.text();
            let parsed: unknown;
            try {
                parsed = JSON.parse(body) as unknown;
            } catch {
                if (looksLikeLoginPage(body)) {
                    return {
                        type: 'error',
                        message: 'Session expired',
                        authError: 'session_expired',
                    };
                }
                return { type: 'error', message: 'Overleaf returned an invalid project list.' };
            }
            const data = asJsonObject(parsed);
            if (!Array.isArray(data?.projects) || data.projects.length > MAX_PROJECT_LIST_ITEMS) {
                return { type: 'error', message: 'Overleaf returned an invalid project list.' };
            }
            const projects: ProjectInfo[] = data.projects.flatMap((value: unknown) => {
                const p = asJsonObject(value);
                const id = firstValidOverleafId('project ID', p?._id);
                const name = boundedMetadata(p?.name, 4096);
                if (!p || !id || !name) return [];
                const accessLevel: ProjectInfo['accessLevel'] = p.accessLevel === 'owner'
                    || p.accessLevel === 'collaborator'
                    || p.accessLevel === 'readOnly'
                    ? p.accessLevel
                    : 'readOnly';
                return [{
                    id,
                    name,
                    lastUpdated: boundedMetadata(p.lastUpdated, 128),
                    accessLevel,
                    archived: Boolean(p.archived),
                    trashed: Boolean(p.trashed),
                }];
            });
            return { type: 'success', projects };
        }
        return this.responseError(res);
    }

    /**
     * Get file content
     */
    async getFile(projectId: string, fileId: string): Promise<ResponseSchema> {
        try {
            const content = await this.download(
                `project/${routeSegment(projectId, 'project ID')}/file/${routeSegment(fileId, 'file ID')}`
            );
            return { type: 'success', content: new Uint8Array(content) };
        } catch (error) {
            const status = error instanceof ApiHttpError ? error.status : undefined;
            return {
                type: 'error',
                message: error instanceof Error ? error.message : String(error),
                authError: error instanceof ApiHttpError && error.authError
                    ? error.authError
                    : status === 401 ? 'session_expired' : undefined,
            };
        }
    }

    /**
     * Upload a file to a project
     */
    async uploadFile(
        projectId: string,
        parentFolderId: string,
        filename: string,
        fileContent: Uint8Array
    ): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }
        if (
            !(fileContent instanceof Uint8Array)
            || fileContent.byteLength > MAX_REMOTE_FILE_BYTES
        ) {
            return { type: 'error', message: 'The local file exceeds the synchronization size limit.' };
        }

        const FormData = require('form-data');
        const mimeTypes = require('mime-types');

        validateProjectEntityName(filename);
        const fileStream = stream.Readable.from([Buffer.from(fileContent)]);
        const formData = new FormData();
        const mimeType = mimeTypes.lookup(filename);

        formData.append('targetFolderId', parentFolderId);
        formData.append('name', filename);
        formData.append('type', mimeType || 'text/plain');
        formData.append('qqfile', fileStream, { filename });

        const res = await this.fetchRoute(
            `project/${routeSegment(projectId, 'project ID')}/upload?folder_id=${routeSegment(parentFolderId, 'folder ID')}`,
            {
                method: 'POST',
                headers: {
                    'Connection': 'keep-alive',
                    'Cookie': this.identity.cookies,
                    'X-Csrf-Token': this.identity.csrfToken,
                },
                body: formData,
            }
        );

        if (res.ok) {
            let uploadData: unknown;
            try {
                uploadData = await res.json();
            } catch {
                // Some Overleaf versions return an empty successful response.
            }

            const uploadObject = asJsonObject(uploadData);
            const rawEntity = asJsonObject(uploadObject?.file)
                || asJsonObject(uploadObject?.entity)
                || uploadObject;
            const entityId = firstValidOverleafId(
                'uploaded entity ID',
                rawEntity?._id,
                rawEntity?.id,
                uploadObject?.entity_id,
            );
            const file: FileEntity | undefined = entityId
                ? {
                    _id: entityId,
                    // This endpoint creates fileRefs. Do not let malformed
                    // response metadata turn the result into a doc or folder.
                    _type: 'file',
                    name: filename,
                }
                : undefined;

            return { type: 'success', file };
        }
        return this.responseError(res);
    }

    /**
     * Create a new document (text file)
     */
    async addDoc(projectId: string, parentFolderId: string, filename: string): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        validateOverleafId(parentFolderId, 'parent folder ID');
        validateProjectEntityName(filename);
        const res = await this.fetchRoute(`project/${routeSegment(projectId, 'project ID')}/doc`, {
            method: 'POST',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
                'Content-Type': 'application/json',
                'X-Csrf-Token': this.identity.csrfToken,
            },
            body: JSON.stringify({
                _csrf: this.identity.csrfToken,
                parent_folder_id: parentFolderId,
                name: filename,
            }),
        });

        if (res.ok) {
            let doc: FileEntity | undefined;
            try {
                const data = asJsonObject(await res.json());
                const rawDoc = asJsonObject(data?.doc) || data;
                const docId = firstValidOverleafId('document ID', rawDoc?._id, rawDoc?.id);
                if (docId) {
                    doc = {
                        _id: docId,
                        _type: 'doc',
                        name: filename,
                    };
                }
            } catch {
                // Some Overleaf versions return an empty successful response.
            }

            return { type: 'success', doc };
        }
        return this.responseError(res);
    }

    /**
     * Create a new folder
     * Returns the created folder entity with _id
     */
    async addFolder(projectId: string, parentFolderId: string, folderName: string): Promise<ResponseSchema & { folder?: FileEntity }> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        validateOverleafId(parentFolderId, 'parent folder ID');
        validateProjectEntityName(folderName);
        const res = await this.fetchRoute(`project/${routeSegment(projectId, 'project ID')}/folder`, {
            method: 'POST',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
                'Content-Type': 'application/json',
                'X-Csrf-Token': this.identity.csrfToken,
            },
            body: JSON.stringify({
                _csrf: this.identity.csrfToken,
                parent_folder_id: parentFolderId,
                name: folderName,
            }),
        });

        if (res.ok) {
            // Parse response to get folder entity with _id
            const data = asJsonObject(await res.json());
            const folderId = firstValidOverleafId('folder ID', data?._id, data?.id);
            const folder: FileEntity | undefined = folderId
                ? {
                    _id: folderId,
                    _type: 'folder',
                    name: folderName,
                }
                : undefined;
            return { type: 'success', folder };
        }
        return this.responseError(res);
    }

    /**
     * Delete an entity (doc, file, or folder)
     */
    async deleteEntity(projectId: string, entityType: string, entityId: string): Promise<ResponseSchema> {
        return this.request(
            'DELETE',
            `project/${routeSegment(projectId, 'project ID')}/${entityRouteSegment(entityType)}/${routeSegment(entityId, 'entity ID')}`
        );
    }

    /**
     * Rename an entity
     */
    async renameEntity(
        projectId: string,
        entityType: string,
        entityId: string,
        newName: string
    ): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        validateProjectEntityName(newName);
        const res = await this.fetchRoute(
            `project/${routeSegment(projectId, 'project ID')}/${entityRouteSegment(entityType)}/${routeSegment(entityId, 'entity ID')}/rename`, {
            method: 'POST',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
                'Content-Type': 'application/json',
                'X-Csrf-Token': this.identity.csrfToken,
            },
            body: JSON.stringify({
                _csrf: this.identity.csrfToken,
                name: newName,
            }),
            });

        if (res.status === 200 || res.status === 204) {
            this.discardResponseBody(res);
            return { type: 'success' };
        }
        return this.responseError(res);
    }

    /**
     * Move an entity to another folder
     */
    async moveEntity(
        projectId: string,
        entityType: string,
        entityId: string,
        newParentFolderId: string
    ): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        validateOverleafId(newParentFolderId, 'parent folder ID');
        const res = await this.fetchRoute(
            `project/${routeSegment(projectId, 'project ID')}/${entityRouteSegment(entityType)}/${routeSegment(entityId, 'entity ID')}/move`, {
            method: 'POST',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
                'Content-Type': 'application/json',
                'X-Csrf-Token': this.identity.csrfToken,
            },
            body: JSON.stringify({
                _csrf: this.identity.csrfToken,
                folder_id: newParentFolderId,
            }),
            });

        if (res.status === 200 || res.status === 204) {
            this.discardResponseBody(res);
            return { type: 'success' };
        }
        return this.responseError(res);
    }

    /**
     * Get project details via HTTP (alternative to socket.io joinProject)
     * Fetches project page and extracts metadata from HTML
     */
    async getProjectDetails(projectId: string): Promise<ResponseSchema & { projectData?: ProjectDetails }> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        const requestedProjectId = validateOverleafId(projectId, 'project ID');

        // Get project page which contains metadata in HTML
        const res = await this.fetchRoute(`project/${routeSegment(requestedProjectId, 'project ID')}`, {
            method: 'GET',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
            },
        });

        if (res.status === 200) {
            const body = await res.text();
            // Extract project data from meta tags
            const extractMeta = (name: string): string | undefined => {
                return findNamedElementValue(body, 'meta', name, 'content');
            };

            const extractJsonMeta = (name: string): unknown => {
                const attributes = findNamedElementAttributes(body, 'meta', name);
                const content = attributes?.get('content');
                if (attributes?.get('data-type')?.toLowerCase() !== 'json' || content === undefined) {
                    return undefined;
                }
                try {
                    return JSON.parse(content) as unknown;
                } catch {
                    return undefined;
                }
            };

            const rootFolder = extractJsonMeta('ol-rootFolder');
            const pageProjectId = extractMeta('ol-project_id');
            const pageUserId = extractMeta('ol-user_id');
            const hasAuthenticatedProjectMetadata = Boolean(pageProjectId || pageUserId || Array.isArray(rootFolder));
            if (!hasAuthenticatedProjectMetadata && looksLikeLoginPage(body)) {
                return {
                    type: 'error',
                    message: 'Session expired',
                    authError: 'session_expired',
                };
            }

            const responseProjectId = extractMeta('ol-project_id');
            let validatedProjectId: string;
            try {
                validatedProjectId = responseProjectId === undefined
                    ? requestedProjectId
                    : validateOverleafId(responseProjectId, 'project ID');
            } catch {
                return { type: 'error', message: 'Overleaf returned invalid project metadata.' };
            }
            if (validatedProjectId !== requestedProjectId) {
                return { type: 'error', message: 'Overleaf returned metadata for a different project.' };
            }

            const rawRootDocId = extractMeta('ol-rootDoc_id');
            const rootDocId = rawRootDocId
                ? firstValidOverleafId('root document ID', rawRootDocId)
                : undefined;
            const rawUserId = extractMeta('ol-user_id');
            const userId = rawUserId ? firstValidOverleafId('user ID', rawUserId) : undefined;
            if ((rawRootDocId && !rootDocId) || (rawUserId && !userId)) {
                return { type: 'error', message: 'Overleaf returned invalid project metadata.' };
            }
            const projectData: ProjectDetails = {
                projectId: validatedProjectId,
                projectName: boundedMetadata(extractMeta('ol-projectName'), 4096),
                rootDocId,
                userId,
                userEmail: boundedMetadata(extractMeta('ol-usersEmail'), MAX_LOGIN_EMAIL_CHARACTERS),
                compiler: boundedMetadata(extractMeta('ol-compiler'), 255),
                rootFolder: Array.isArray(rootFolder) ? rootFolder as FolderEntity[] : undefined,
            };

            return { type: 'success', projectData };
        }

        return this.responseError(res);
    }

    /**
     * Get document content via HTTP
     */
    async getDocContent(projectId: string, docId: string): Promise<ResponseSchema & { lines?: string[] }> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        const res = await this.fetchRoute(
            `project/${routeSegment(projectId, 'project ID')}/doc/${routeSegment(docId, 'document ID')}`, {
            method: 'GET',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
            },
            });

        if (res.status === 200) {
            const body = await res.text();
            let parsed: unknown;
            try {
                parsed = JSON.parse(body) as unknown;
            } catch {
                if (looksLikeLoginPage(body)) {
                    return {
                        type: 'error',
                        message: 'Session expired',
                        authError: 'session_expired',
                    };
                }
                return { type: 'error', message: 'Overleaf returned invalid document content.' };
            }
            const data = asJsonObject(parsed);
            try {
                const lines = validateRemoteDocumentLines(data?.lines);
                return { type: 'success', lines };
            } catch {
                return { type: 'error', message: 'Overleaf returned invalid document content.' };
            }
        }

        return this.responseError(res);
    }

    /**
     * Verify that current credentials are still valid
     */
    async verifyCredentials(): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated', authError: 'invalid_credentials' };
        }

        const result = await this.getUserId(this.identity.cookies);
        if (result.kind === 'success') {
            return {
                type: 'success',
                userInfo: {
                    userId: result.metadata.userId,
                    userEmail: result.metadata.userEmail,
                },
            };
        }
        if (result.kind === 'error') return result.response;
        return {
            type: 'error',
            message: 'Session expired or cookie invalid',
            authError: 'session_expired',
        };
    }
}
