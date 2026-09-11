import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import * as vm from 'vm';

/** Exercise the real command handlers with a lost socket and an existing project. */
export async function runSyncRecoveryTests(): Promise<void> {
    const extensionPath = path.join(__dirname, '..', 'extension.js');
    const requireExtension = createRequire(extensionPath);
    const { SyncEngine } = requireExtension('./sync/syncEngine.js');
    const commands = new Map<string, () => Promise<void>>();
    const messages: string[] = [];
    let pickCleanup: (items: any[], options: any) => Promise<any[] | undefined> = async () => undefined;
    const settings = {
        isLinked: async () => true,
        getSettings: () => ({ projectId: 'project' }),
    };
    const exports: any = {};
    const testContext = { subscriptions: [] };
    const harness = new vm.Script(fs.readFileSync(extensionPath, 'utf8') + `
        exports.prepareRecovery = (engine, initialize) => {
            syncEngine = engine;
            extensionContext = exports.context;
            initializeSync = initialize;
            registerCommands(extensionContext);
        };
        exports.setEngine = engine => { syncEngine = engine; };
    `);
    exports.context = testContext;
    harness.runInNewContext({
        exports,
        require: (name: string) => {
            if (name === 'vscode') return {
                ProgressLocation: { Notification: 15 },
                commands: {
                    registerCommand: (command: string, handler: () => Promise<void>) => {
                        commands.set(command, handler);
                        return { dispose() {} };
                    },
                },
                window: {
                    withProgress: async (_options: unknown, operation: () => Promise<void>) => operation(),
                    showQuickPick: (items: any[], options: any) => pickCleanup(items, options),
                    showInformationMessage: async (message: string) => { messages.push(message); },
                    showWarningMessage: async (message: string) => { messages.push(message); },
                    showErrorMessage: async (message: string) => { messages.push(message); },
                },
            };
            if (name === './utils/settingsManager') return {
                SettingsManager: { getCurrentInstance: () => settings },
            };
            return requireExtension(name);
        },
    });

    for (const command of ['localleaf.syncNow', 'localleaf.pullFromOverleaf']) {
        let reconnects = 0;
        let recoveringPulls = 0;
        let recoveredWatches = 0;
        const disconnected = Object.assign(Object.create(SyncEngine.prototype), {
            project: { _id: 'project' },
            socket: { isConnected: false },
            _status: 'error',
            pullAll: async () => { recoveringPulls++; },
            joinAllDocsForWatching: async () => { recoveredWatches++; },
        });
        exports.prepareRecovery(disconnected, async (context: unknown, manager: unknown) => {
            assert.equal(context, testContext);
            assert.equal(manager, settings);
            reconnects++;
        });
        await commands.get(command)!();
        assert.equal(reconnects, 0, `${command} must retain the session and its conflict baselines during recovery`);
        assert.equal(recoveringPulls, 1, 'Retry must use the pull operation that automatically recovers its transport');
        assert.equal(recoveredWatches, 1);

        let pulls = 0;
        let watches = 0;
        const connected = Object.assign(Object.create(SyncEngine.prototype), {
            project: { _id: 'project' },
            socket: { isConnected: true },
            _status: 'error', // A file conflict does not invalidate the transport.
            pullAll: async () => { pulls++; },
            joinAllDocsForWatching: async () => { watches++; },
        });
        exports.setEngine(connected);
        await commands.get(command)!();
        assert.equal(reconnects, 0, 'A valid socket must keep its document baselines during a retry');
        assert.equal(pulls, 1);
        assert.equal(watches, 1);

        connected.socket = undefined; // A supported HTTP session has no socket.
        await commands.get(command)!();
        assert.equal(reconnects, 0, 'HTTP sessions must not be stuck in a reconnect loop');
        assert.equal(pulls, 2);

        const messagesBeforeSwitch = messages.length;
        const watchesBeforeSwitch = watches;
        connected.pullAll = async () => { exports.setEngine(disconnected); };
        await commands.get(command)!();
        assert.equal(watches, watchesBeforeSwitch, 'A workspace switch must not subscribe documents on the previous session');
        assert.equal(messages.length, messagesBeforeSwitch, 'An obsolete pull must not report success or failure in the new workspace');

        exports.setEngine(undefined);
        await commands.get(command)!();
        assert.equal(reconnects, 1, 'A linked project without an engine must use the guarded initialization path');
        disconnected.disposed = true;
        exports.setEngine(disconnected);
        await commands.get(command)!();
        assert.equal(reconnects, 2, 'A disposed engine must be initialized again');
    }
    assert.ok(!messages.some(message => message.includes('no folder tree')));

    const cleanupCandidates = [
        { path: '/analysis/', id: 'analysis', type: 'folder', reason: 'ignored' },
        { path: '/samples.csv', id: 'sample', type: 'doc', reason: 'missing-local' },
    ];
    const cleanupCalls: unknown[] = [];
    const cleanupEngine = {
        getRemoteCleanupCandidates: async () => cleanupCandidates,
        deleteRemoteCleanupCandidates: async (selected: unknown[]) => {
            cleanupCalls.push(selected);
            return { deleted: selected.length, skipped: 0, failed: [] };
        },
    };
    exports.setEngine(cleanupEngine);
    pickCleanup = async (items, options) => {
        assert.equal(options.canPickMany, true);
        assert.match(options.title, /Delete selected/);
        assert.equal(items[0].picked, true);
        assert.equal(items[1].picked, false, 'remote-only files require explicit selection');
        return [items[1]];
    };
    await commands.get('localleaf.cleanIgnoredRemoteFiles')!();
    assert.deepStrictEqual(cleanupCalls, [[cleanupCandidates[1]]], 'delete only the concrete selected identities');
    pickCleanup = async () => undefined;
    await commands.get('localleaf.cleanIgnoredRemoteFiles')!();
    assert.equal(cleanupCalls.length, 1, 'cancelling the cleanup preview must not delete anything');
    pickCleanup = async items => { exports.setEngine(undefined); return items; };
    await commands.get('localleaf.cleanIgnoredRemoteFiles')!();
    assert.equal(cleanupCalls.length, 1, 'switching workspaces during cleanup selection must cancel the old operation');
}
