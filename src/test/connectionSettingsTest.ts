import * as assert from 'assert';
import * as vm from 'vm';
import { selectDefaultServer } from '../utils/connectionSettings';

export async function runConnectionSettingsTests(html: string): Promise<void> {
    for (const [setting, target] of [[{}, 1], [{ workspaceValue: 'https://old.example' }, 2],
        [{ workspaceFolderValue: 'https://old.example' }, 3]] as const) {
        const updates: unknown[][] = [];
        const configuration = {
            inspect: <T>() => ({
                key: 'defaultServer',
                workspaceValue: ('workspaceValue' in setting ? setting.workspaceValue : undefined) as T | undefined,
                workspaceFolderValue: ('workspaceFolderValue' in setting ? setting.workspaceFolderValue : undefined) as T | undefined,
            }),
            update: async (...args: unknown[]) => { updates.push(args); },
        };
        assert.equal(await selectDefaultServer(' https://other.example/latex/ ', configuration), 'https://other.example/latex');
        assert.deepStrictEqual(updates, [['defaultServer', 'https://other.example/latex', target]],
            'switching must update the effective configuration scope without needing the old server');
        await assert.rejects(selectDefaultServer('javascript:alert(1)', configuration), /HTTP or HTTPS/);
        await assert.rejects(selectDefaultServer('https://user:password@other.example', configuration), /embedded credentials/);
        assert.equal(updates.length, 1, 'invalid servers must not replace the existing connection');
    }

    class Control {
        value = '';
        textContent = '';
        className = '';
        hidden = false;
        disabled = false;
        readOnly = false;
        readonly listeners = new Map<string, () => void>();
        setAttribute(): void {}
        addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
        click(): void { if (!this.disabled) this.listeners.get('click')?.(); }
        input(value: string): void { this.value = value; this.listeners.get('input')?.(); }
    }
    const controls = new Map<string, Control>();
    const control = (id: string): Control => {
        if (!controls.has(id)) controls.set(id, new Control());
        return controls.get(id)!;
    };
    const messages: Array<{ type: string; serverUrl?: string }> = [];
    let receive: ((event: { data: unknown }) => void) | undefined;
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    vm.runInNewContext(script, {
        acquireVsCodeApi: () => ({
            getState: () => ({}), setState: () => {},
            postMessage: (message: { type: string; serverUrl?: string }) => { messages.push(message); },
        }),
        document: { getElementById: control, querySelectorAll: () => [...controls.values()] },
        window: { addEventListener: (_name: string, listener: typeof receive) => { receive = listener; } },
    });
    const current = { serverUrl: 'https://old.example', loggedIn: true, authState: 'valid', userEmail: 'test@example.test' };
    const update = (state: unknown) => receive?.({ data: { type: 'state', state } });
    update(current);
    assert.equal(control('serverUrl').readOnly, false, 'stored credentials must not lock the server field');
    control('cookies').value = 'old-session-cookie';
    control('serverUrl').input('https://other.example/latex');
    assert.equal(control('cookies').value, '', 'changing servers must clear cookie input');
    assert.equal(control('signedIn').hidden, true, 'actions for the old session must be hidden while selecting another server');
    assert.equal(control('loginBrowser').disabled, true, 'apply the selected server before signing in');
    assert.equal(control('selectServer').disabled, false);
    update(current);
    assert.equal(control('serverUrl').value, 'https://other.example/latex', 'background refreshes must preserve the draft server');
    control('selectServer').click();
    assert.equal(messages.at(-1)?.type, 'selectServer');
    assert.equal(messages.at(-1)?.serverUrl, 'https://other.example/latex');
    update({ serverUrl: 'https://other.example/latex', loggedIn: false, authState: 'none' });
    assert.equal(control('serverUrl').value, 'https://other.example/latex');
    assert.equal(control('signedOut').hidden, false);
    assert.equal(control('loginBrowser').disabled, false);
    control('loginBrowser').click();
    assert.equal(messages.at(-1)?.serverUrl, 'https://other.example/latex', 'sign-in must target the newly selected server');
    assert.ok(messages.every(message => message.type !== 'logout'), 'switching servers must not log out of the old connection');
    control('serverUrl').input('');
    const beforeEmptySubmit = messages.length;
    control('selectServer').click();
    assert.equal(messages.length, beforeEmptySubmit);
    assert.equal(control('statusTitle').textContent, 'Missing server');
    update({ ...current, operation: { kind: 'browserLogin', message: 'Signing in', cancellable: true } });
    assert.equal(control('selectServer').disabled, true, 'an active login must keep its server pinned');
    assert.equal(control('cancelLogin').disabled, false);
}
