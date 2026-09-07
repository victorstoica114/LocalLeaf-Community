import * as assert from 'assert';
import * as vm from 'vm';
import { conciseErrorMessage, httpErrorMessage } from '../utils/errorMessages';

/** Execute the actual webview script with only the DOM operations needed for error/loading states. */
export function runErrorPresentationTests(html: string): void {
    const htmlPage = '<!DOCTYPE html><img src="data:image/jpeg;base64,' + 'A'.repeat(20000) + '">';
    for (const status of [400, 403, 404, 408, 429, 500, 502, 503, 504]) {
        for (const contentType of ['text/html', 'text/plain', '']) {
            const message = httpErrorMessage(status, htmlPage, contentType);
            assert.ok(message.length < 200);
            assert.ok(message.startsWith(`${status}:`));
            assert.doesNotMatch(message, /DOCTYPE|base64|AAAA/);
        }
    }
    assert.match(httpErrorMessage(400, '{"message":"Choose a different project name."}'), /Choose a different project name/);
    assert.match(httpErrorMessage(403, 'Blocked by server policy'), /Blocked by server policy/);
    assert.doesNotMatch(httpErrorMessage(400, '{"message":"<html>failure</html>"}'), /<html>/);
    assert.doesNotMatch(httpErrorMessage(400, '{"message":' + 'A'.repeat(20000)), /AAAA/);
    assert.equal(conciseErrorMessage(new Error(htmlPage), 'Unavailable'), 'Unavailable');
    assert.equal(conciseErrorMessage('&lt;html&gt;failure&lt;/html&gt;', 'Unavailable'), 'Unavailable');
    assert.equal(conciseErrorMessage('A'.repeat(20000)).length, 320);
    assert.equal(conciseErrorMessage('Connection\n\tfailed'), 'Connection failed');
    assert.match(httpErrorMessage(429, htmlPage), /Wait a moment/);

    class TestElement {
        className = '';
        textContent = '';
        type = '';
        children: TestElement[] = [];
        readonly attributes = new Map<string, string>();
        readonly listeners = new Map<string, () => void>();
        constructor(readonly tag: string) {}
        append(...children: TestElement[]): void { this.children.push(...children); }
        replaceChildren(...children: TestElement[]): void { this.children = children; }
        setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
        addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
        descendants(): TestElement[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
    }
    const root = new TestElement('main');
    const menu = new TestElement('button');
    const postedMessages: Array<{ type: string }> = [];
    let receiveState: ((event: { data: unknown }) => void) | undefined;
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script, 'the projects webview must contain an executable script');
    vm.runInNewContext(script, {
        acquireVsCodeApi: () => ({
            getState: () => ({}),
            postMessage: (message: { type: string }) => { postedMessages.push(message); },
        }),
        document: {
            getElementById: (id: string) => id === 'root' ? root : menu,
            createElement: (tag: string) => new TestElement(tag),
        },
        window: {
            addEventListener: (_name: string, listener: typeof receiveState) => { receiveState = listener; },
        },
    });
    assert.equal(postedMessages[0].type, 'ready');
    for (const status of ['connection-error', 'loading', 'error']) {
        postedMessages.length = 0;
        receiveState?.({ data: { type: 'state', state: {
            status, projects: [], localProjects: [],
            message: httpErrorMessage(502, htmlPage), serverUrl: 'https://overleaf.example/latex',
        } } });
        const buttons = root.descendants().filter(node => node.tag === 'button');
        const labels = status !== 'loading'
            ? ['Try Again', 'Connection Settings'] : ['Connection Settings'];
        assert.deepStrictEqual(buttons.map(button => button.textContent), labels);
        buttons.forEach(button => button.listeners.get('click')?.());
        assert.deepStrictEqual(postedMessages.map(message => message.type), status !== 'loading'
            ? ['refresh', 'login'] : ['login']);
        menu.listeners.get('click')?.();
        assert.equal(postedMessages.at(-1)?.type, 'login', 'the permanent menu must remain usable in every state');
        assert.equal(root.children[0].attributes.get('role'), status !== 'loading' ? 'alert' : 'status');
        if (status === 'connection-error') {
            const copy = root.descendants().map(node => node.textContent).join(' ');
            assert.match(copy, /Cannot connect to server/);
            assert.match(copy, /Connection Settings to choose another server/);
            assert.doesNotMatch(copy, /502:/, 'the connection message must not be replaced by technical details');
        }
        assert.doesNotMatch(root.descendants().map(node => node.textContent).join(' '), /DOCTYPE|base64|AAAA/);
    }
}
