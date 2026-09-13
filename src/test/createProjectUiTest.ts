import * as assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { runStandaloneTest } from './standaloneRunner';

class Element {
    className = '';
    textContent = '';
    disabled = false;
    readonly dataset: Record<string, string> = {};
    children: Element[] = [];
    readonly attributes = new Map<string, string>();
    readonly listeners = new Map<string, () => void>();
    constructor(readonly tag: string) {}
    append(...children: Element[]): void { this.children.push(...children); }
    replaceChildren(...children: Element[]): void { this.children = children; }
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    removeAttribute(name: string): void { this.attributes.delete(name); }
    addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
    descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
    click(): void { this.listeners.get('click')?.(); }
}

function renderWebview(html: string) {
    const elements = new Map<string, Element>();
    const getElement = (id: string) => {
        if (!elements.has(id)) elements.set(id, new Element(id === 'createProject' ? 'button' : 'div'));
        return elements.get(id)!;
    };
    const messages: Array<Record<string, unknown>> = [];
    let onMessage!: (event: { data: unknown }) => void;
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    vm.runInNewContext(script, {
        acquireVsCodeApi: () => ({ getState: () => ({}), setState() {}, postMessage: (message: Record<string, unknown>) => messages.push(message) }),
        document: {
            getElementById: getElement,
            createElement: (tag: string) => new Element(tag),
            createDocumentFragment: () => new Element('fragment'),
        },
        window: { addEventListener: (_name: string, listener: typeof onMessage) => { onMessage = listener; } },
    });
    return { getElement, messages, state: (state: unknown) => onMessage({ data: { type: 'state', state } }) };
}

async function run(): Promise<void> {
    const Module = require('module') as { _load(request: string, parent: unknown, isMain: boolean): unknown };
    const originalLoad = Module._load;
    const commands: unknown[][] = [];
    let execute: () => Promise<void> = async () => undefined;
    const vscode = {
        Uri: { joinPath: (_root: unknown, ...parts: string[]) => parts.join('/') },
        commands: { executeCommand: (...args: unknown[]) => { commands.push(args); return execute(); } },
    };
    Module._load = function (request, parent, isMain) {
        return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
    };
    try {
        const { ProjectsWebviewProvider } = require('../views/projectsWebviewProvider');
        const { MainWebviewProvider } = require('../views/mainWebviewProvider');
        const { COMMANDS } = require('../consts') as typeof import('../consts');
        const webview = { cspSource: 'vscode-resource:', asWebviewUri: (uri: unknown) => String(uri) };
        const browser: any = new ProjectsWebviewProvider('extension', {});
        const main: any = new MainWebviewProvider('extension', {});
        const browserHtml = browser.getHtml(webview);
        assert.match(browserHtml, /<button id="createProject"[^>]*aria-label="Create New Project">Create New Project<\/button>/,
            'project creation must be a named native button outside state-specific content');
        const browserPage = renderWebview(browserHtml);
        for (const status of ['no-folder', 'local-projects', 'ready', 'not-logged-in', 'error']) {
            browserPage.state({ status, projects: [], localProjects: [] });
            const button = browserPage.getElement('createProject');
            assert.equal(button.disabled, false, `creation must be available in ${status}`);
            const before = browserPage.messages.length;
            button.click();
            button.click();
            assert.equal(browserPage.messages.length, before + 1, 'a double-click must dispatch only one creation message');
            assert.deepEqual(Object.keys(browserPage.messages.at(-1)!), ['type']);
            assert.equal(browserPage.messages.at(-1)!.type, 'createProject');
            assert.equal(button.attributes.get('aria-busy'), 'true');
        }
        browserPage.state({ status: 'ready', projects: [], localProjects: [], creatingProject: true });
        assert.equal(browserPage.getElement('createProject').disabled, true);

        const mainPage = renderWebview(main.getHtml(webview));
        const linkedState = { linked: true, projectName: 'Existing project', syncStatus: 'idle', statusText: 'Up to date', details: [], onlineUsers: [], showChanges: false };
        mainPage.state(linkedState);
        const createTool = mainPage.getElement('content').descendants().find(element =>
            element.tag === 'button' && element.attributes.get('aria-label')?.startsWith('Create New Project.'));
        assert.ok(createTool, 'a linked workspace must offer creation without unlinking');
        const previousMessages = mainPage.messages.length;
        createTool.click();
        createTool.click();
        assert.equal(mainPage.messages.length, previousMessages + 1);
        assert.equal(mainPage.messages.at(-1)!.command, COMMANDS.CREATE_PROJECT);
        assert.deepEqual(Object.keys(mainPage.messages.at(-1)!).sort(), ['command', 'type']);
        mainPage.state({ ...linkedState, creatingProject: true });
        assert.equal(mainPage.getElement('content').descendants().find(element =>
            element.tag === 'button' && element.attributes.get('aria-label')?.startsWith('Create New Project.'))?.disabled, true);

        for (const provider of [browser, main]) {
            let finish!: () => void;
            execute = () => new Promise(resolve => { finish = resolve; });
            let refreshes = 0;
            provider.refresh = async () => { refreshes++; };
            provider.state = provider === browser
                ? { status: 'ready', projects: [], localProjects: [] } : linkedState;
            const message = provider === browser
                ? { type: 'createProject', serverUrl: 'https://untrusted.example', projectName: 'Untrusted' }
                : { type: 'runCommand', command: COMMANDS.CREATE_PROJECT, serverUrl: 'https://untrusted.example' };
            const before = commands.length;
            const creation = provider.handleMessage(message);
            await provider.handleMessage(message);
            assert.equal(commands.length, before + 1, 'the extension host must independently coalesce repeated creation messages');
            assert.deepEqual(commands.at(-1), [COMMANDS.CREATE_PROJECT], 'webview fields must never become command arguments');
            finish();
            await creation;
            assert.equal(refreshes, 1);
            assert.equal(provider.state.creatingProject, false);
            execute = async () => { throw new Error('Creation cancelled or failed'); };
            await assert.rejects(provider.handleMessage(message), /Creation cancelled or failed/);
            assert.equal(provider.state.creatingProject, false, 'failed creation must restore the button');
            assert.equal(refreshes, 2, 'failed creation must also refresh the current view');
        }
        console.log('Create-project UI tests passed: all browser states, linked Tools, pending guards, command boundary and error reset.');
    } finally {
        Module._load = originalLoad;
    }
}

runStandaloneTest(run);
