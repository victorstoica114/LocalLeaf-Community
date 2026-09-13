/** Opt-in VS Code development-host runner. Uses this extension's SecretStorage API. */
import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as assert from 'node:assert/strict';
import { CredentialManager } from '../utils/credentialManager';
import { BaseAPI } from '../api/base';
import { SyncEngine } from '../sync/syncEngine';
import { SettingsManager } from '../utils/settingsManager';
import { setOutputChannel } from '../api/socketio';

interface RunConfiguration {
    serverUrl: string; projectId: string; projectName: string; directory: string;
    folderName: string; soakSeconds?: number;
}

export function activate(context: vscode.ExtensionContext): { run: () => Promise<void> } {
    const credentials = CredentialManager.initialize(context);
    const runner = { run: async () => {
        assert.equal(context.extensionMode, vscode.ExtensionMode.Development, 'This runner requires an extension development host');
        const config = JSON.parse(await fs.readFile(path.join(context.extensionPath, 'run.json'), 'utf8')) as RunConfiguration;
        const output = vscode.window.createOutputChannel('LocalLeaf Server Integration');
        setOutputChannel(output);
        context.subscriptions.push(output);
        const report: { projectId: string; url: string; folder: string; checks: string[]; failure?: string; finished?: string } = {
            projectId: config.projectId, url: `${config.serverUrl}/project/${config.projectId}`,
            folder: config.folderName, checks: [],
        };
        const logPath = path.join(config.directory, 'integration.log');
        const log = (message: string) => {
            const line = `[${new Date().toISOString()}] ${message}`;
            output.appendLine(line);
            void fs.appendFile(logPath, line + '\n');
        };
        const saveReport = () => fs.writeFile(path.join(config.directory, 'result.json'), JSON.stringify(report, null, 2));
        const passed = async (name: string) => { report.checks.push(name); log('PASS: ' + name); await saveReport(); };
        const eventually = async (check: () => Promise<boolean>, label: string, timeout = 60_000) => {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                if (await check()) return;
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            throw new Error('Timed out: ' + label);
        };
        const engines: SyncEngine[] = [];
        let control: BaseAPI | undefined;
        await saveReport();
        try {
            log(`Starting VS Code integration for ${config.projectName} (${config.projectId})`);
            assert.ok(typeof config.projectName === 'string' && config.projectName.trim(), 'An explicitly selected test project is required');
            assert.match(config.folderName, /^\.localleaf-tests-[a-zA-Z0-9-]+$/);
            const credential = await credentials.getCredential(config.serverUrl);
            if (!credential) throw new Error('Please sign in to this server using LocalLeaf in this VS Code profile');
            control = new BaseAPI(config.serverUrl);
            control.setIdentity(credential.identity);
            const details = await control.getProjectDetails(config.projectId);
            assert.equal(details.type, 'success', 'The configured test project must be accessible');
            assert.equal(details.projectData?.projectName, config.projectName, 'Test project name must match');
            log('Authenticated through the extension SecretStorage API; project identity verified');
            const identity = control.getIdentity()!;
            const initialPatterns = `/**\n!/${config.folderName}/\n!/${config.folderName}/**\n`;
            const startClient = async (name: string) => {
                const root = path.join(config.directory, name);
                await fs.mkdir(root, { recursive: true });
                await fs.writeFile(path.join(root, '.leafignore'), initialPatterns);
                const settingsData = { projectId: config.projectId, projectName: config.projectName,
                    serverUrl: config.serverUrl, autoSync: true };
                const settings = { getSettings: () => settingsData, getWorkspaceFolder: () => vscode.Uri.file(root),
                    getFilePath: (relative: string) => vscode.Uri.file(path.join(root, relative)),
                    getRelativePath: (uri: vscode.Uri) => '/' + path.relative(root, uri.fsPath).replaceAll('\\', '/'),
                    async updateLastSynced() {}, async update(value: object) { Object.assign(settingsData, value); } };
                const api = new BaseAPI(config.serverUrl);
                api.setIdentity(identity);
                const engine: any = new SyncEngine(api, settings as unknown as SettingsManager,
                    message => log(name + ': ' + message), vscode.Uri.file(path.join(config.directory, 'state')));
                engines.push(engine);
                // A prompt is recorded as a test outcome; it never blocks unattended tests.
                const choices: string[] = [];
                engine.askConflictResolution = async (file: string) => { choices.push(file); return 'skip'; };
                engine.onStatusChange((status: any) => { if (status.status === 'error') log(name + ' ERROR: ' + status.message); });
                await engine.connect();
                await engine.pullAll(false);
                return { engine, api, root, choices,
                    write: (relative: string, text: string | Buffer) => fs.writeFile(path.join(root, relative), text),
                    read: (relative: string) => fs.readFile(path.join(root, relative), 'utf8').catch(() => ''),
                    exists: (relative: string) => fs.stat(path.join(root, relative)).then(() => true, () => false) };
            };
            let a = await startClient('client-a');
            const rootEntry = a.engine.fileTreeByPath.get('/');
            assert.ok(rootEntry?.id);
            const createdFolder = await control.addFolder(config.projectId, rootEntry.id, config.folderName);
            assert.equal(createdFolder.type, 'success', createdFolder.message);
            assert.ok(createdFolder.folder?._id);
            const folderId = createdFolder.folder!._id;
            const createdDoc = await control.addDoc(config.projectId, folderId, 'sync.tex');
            assert.equal(createdDoc.type, 'success', createdDoc.message);
            const target = config.folderName + '/sync.tex';
            await eventually(() => a.exists(target), 'new remote document appears');
            const b = await startClient('client-b');
            await eventually(() => b.exists(target), 'second empty workspace downloads');
            assert.deepEqual(a.choices.concat(b.choices), []);
            await passed('Remote creation and an empty second workspace download without a choice');

            const initial = 'first\nseparator\nmiddle\nseparator\nlast\n';
            await a.write(target, initial);
            await eventually(async () => await b.read(target) === initial, 'saved edit reaches second client');
            await passed('VS Code filesystem watcher uploads and real-time events update the second client');
            await Promise.all([a.write(target, initial.replace('first', 'FIRST')), b.write(target, initial.replace('last', 'LAST'))]);
            const merged = initial.replace('first', 'FIRST').replace('last', 'LAST');
            await eventually(async () => await a.read(target) === merged && await b.read(target) === merged, 'simultaneous edits');
            assert.deepEqual(a.choices.concat(b.choices), []);
            await passed('Independent simultaneous edits converge automatically');

            await a.engine.stateStore.flush();
            a.engine.disconnect();
            await a.write(target, merged.replace('FIRST', 'FIRST offline'));
            await b.write(target, merged.replace('LAST', 'LAST remote'));
            await eventually(async () => b.engine.fileCache.get('/' + target) === createHash('sha256').update(await b.read(target)).digest('hex'), 'remote offline revision committed');
            a = await startClient('client-a');
            const resumed = merged.replace('FIRST', 'FIRST offline').replace('LAST', 'LAST remote');
            await eventually(async () => await a.read(target) === resumed && await b.read(target) === resumed, 'restart with saved ancestor');
            await passed('Restart restores the ancestor and merges offline changes');

            const socket = a.engine.getSocket();
            const apply = socket.applyOtUpdate.bind(socket);
            let injected = false;
            socket.applyOtUpdate = async (...args: any[]) => {
                await apply(...args);
                if (!injected) { injected = true; socket.resetConnection(); throw new Error('Injected interruption after server commit'); }
            };
            const ackText = resumed + 'ACK appears once\n';
            await a.write(target, ackText);
            await eventually(async () => injected && await a.read(target) === ackText && await b.read(target) === ackText
                && !a.engine.stateStore.entries.get('/' + target)?.intent, 'uncertain write recovery', 120_000);
            socket.applyOtUpdate = apply;
            await passed('Lost confirmation after commit recovers without duplicate content');

            for (let cycle = 0; cycle < 5; cycle++) {
                a.engine.getSocket().resetConnection();
                await a.engine.pullAll(false);
                await eventually(async () => a.engine.getSocket().isConnected, 'reconnection');
            }
            const finalText = ackText + 'still synchronized\n';
            await b.write(target, finalText);
            await eventually(async () => await a.read(target) === finalText, 'editing after repeated reconnects');
            await passed('Five reconnects preserve live synchronization');

            const primaryIdentity = a.engine.getSocket().publicId;
            await a.engine.runWorkspaceExclusive(() => a.engine.refreshProjectFileTree());
            assert.equal(a.engine.getSocket().publicId, primaryIdentity, 'a tree snapshot must not replace the live connection');
            const refreshedText = finalText + 'after tree refresh\n';
            await b.write(target, refreshedText);
            await eventually(async () => await a.read(target) === refreshedText, 'subscription recovery after tree-only refresh');
            await passed('Tree-only refresh preserves the primary connection and live document subscriptions');

            const concurrentOld = config.folderName + '/snapshot-before.tex';
            const concurrentNew = config.folderName + '/snapshot-after.tex';
            await b.write(concurrentOld, 'Snapshot rename content\n');
            await eventually(async () => await a.read(concurrentOld) === 'Snapshot rename content\n', 'snapshot race fixture uploaded');
            const concurrentEntry = b.engine.fileTreeByPath.get('/' + concurrentOld);
            assert.ok(concurrentEntry?.id);
            const getDetails = a.api.getProjectDetails.bind(a.api);
            let concurrentRename = false;
            a.api.getProjectDetails = async (...args: Parameters<BaseAPI['getProjectDetails']>) => {
                if (!concurrentRename) {
                    concurrentRename = true;
                    const result = await control!.renameEntity(config.projectId, concurrentEntry.type, concurrentEntry.id, 'snapshot-after.tex');
                    assert.equal(result.type, 'success', result.message);
                    await eventually(() => b.exists(concurrentNew), 'other client receives rename during snapshot');
                }
                return getDetails(...args);
            };
            try {
                // Preview only: the snapshot includes the rename while its
                // primary event is queued; no remote deletion is requested.
                await a.engine.getRemoteCleanupCandidates();
                await a.engine.remoteEventQueue;
            } finally {
                a.api.getProjectDetails = getDetails;
            }
            await eventually(async () => await a.read(concurrentNew) === 'Snapshot rename content\n'
                && !await a.exists(concurrentOld), 'snapshot-included rename reaches the local filesystem');
            await b.write(concurrentNew, 'Edit after snapshot rename\n');
            await eventually(async () => await a.read(concurrentNew) === 'Edit after snapshot rename\n', 'document identity stays correct after snapshot rename');
            assert.equal(a.engine.getSocket().publicId, primaryIdentity);
            await passed('A rename included in a concurrent cleanup snapshot preserves local paths, identity, and subsequent edits');

            const nested = config.folderName + '/nested';
            await fs.mkdir(path.join(b.root, nested), { recursive: true });
            await b.write(nested + '/created.tex', 'Creation from disk\n');
            await eventually(async () => await a.read(nested + '/created.tex') === 'Creation from disk\n', 'local folder and document creation');
            await passed('Local directories and files propagate automatically');
            const entry = b.engine.fileTreeByPath.get('/' + nested + '/created.tex');
            assert.ok(entry?.id);
            const rename = await control.renameEntity(config.projectId, entry.type, entry.id, 'renamed.tex');
            assert.equal(rename.type, 'success', rename.message);
            await eventually(async () => await a.read(nested + '/renamed.tex') === 'Creation from disk\n'
                && await b.read(nested + '/renamed.tex') === 'Creation from disk\n', 'remote rename');
            await passed('Server rename reaches both local copies');

            const ignored = config.folderName + '/analysis';
            await b.write('.leafignore', initialPatterns + '/' + ignored + '/\n');
            await eventually(async () => b.engine.ignoreParser.shouldIgnore('/' + ignored + '/ignored.csv'), 'ignore settings reload');
            await fs.mkdir(path.join(b.root, ignored), { recursive: true });
            await b.write(ignored + '/ignored.csv', 'ignored,data\n');
            await new Promise(resolve => setTimeout(resolve, 1800));
            await b.engine.runWorkspaceExclusive(() => b.engine.refreshProjectFileTree());
            assert.equal(b.engine.fileTreeByPath.has('/' + ignored + '/'), false);
            await passed('Ignored generated directories are not uploaded');

            await fs.unlink(path.join(b.root, nested, 'renamed.tex'));
            await eventually(async () => !b.engine.fileTreeByPath.has('/' + nested + '/renamed.tex')
                && !await a.exists(nested + '/renamed.tex'), 'deletion converges');
            await passed('Local deletion reaches Overleaf and the second client');
            await fs.rmdir(path.join(b.root, nested));
            await eventually(async () => !b.engine.fileTreeByPath.has('/' + nested + '/')
                && !await a.exists(nested), 'directory deletion converges');
            await passed('Deleting a synchronized directory removes it from both remote and local copies');

            const large = config.folderName + '/generated.csv';
            const payload = 'key,value\n' + 'sample,1234567890\n'.repeat(150_000);
            await b.write(large, payload);
            await eventually(async () => await a.read(large) === payload, 'large generated file upload', 180_000);
            await passed('A generated file larger than 2 MiB synchronizes without manual retry');

            const soakMs = (config.soakSeconds ?? 150) * 1000;
            const deadline = Date.now() + soakMs;
            let healthyReconnects = 0;
            let periodicRefreshes = 0;
            for (const client of [a, b]) {
                const live = client.engine.getSocket();
                const reconnect = live.reconnect.bind(live);
                const refresh = live.refreshProject.bind(live);
                live.reconnect = async () => { healthyReconnects++; return reconnect(); };
                live.refreshProject = async () => { periodicRefreshes++; return refresh(); };
            }
            let tick = 0;
            while (Date.now() < deadline) {
                const probe = finalText + `Health probe ${++tick}\n`;
                await b.write(target, probe);
                await eventually(async () => await a.read(target) === probe, 'health probe during soak');
                log(`Soak probe ${tick} converged`);
                await new Promise(resolve => setTimeout(resolve, Math.min(15_000, Math.max(0, deadline - Date.now()))));
            }
            assert.deepEqual(a.choices.concat(b.choices), []);
            assert.equal(healthyReconnects, 0, 'healthy sessions must not reconnect on a timer');
            assert.equal(periodicRefreshes, 0, 'healthy sessions must not refresh the full tree on a timer');
            await passed(`Synchronization remains active across ${config.soakSeconds ?? 150}s with zero periodic retries or project refreshes`);

            const receiveCreation = a.engine.handleRemoteFileCreated.bind(a.engine);
            a.engine.handleRemoteFileCreated = async (...args: any[]) => {
                if (args[2]?.name !== 'focus-restored.tex') return receiveCreation(...args);
            };
            const restored = await control.addDoc(config.projectId, folderId, 'focus-restored.tex');
            assert.equal(restored.type, 'success', restored.message);
            const focusTarget = config.folderName + '/focus-restored.tex';
            await eventually(() => b.exists(focusTarget), 'other client receives the restoration event');
            await a.engine.remoteEventQueue;
            assert.equal(await a.exists(focusTarget), false, 'the test intentionally misses one creation event');
            a.engine.handleRemoteFileCreated = receiveCreation;
            a.engine.lastFocusReconciliation = 0;
            const beforeFocus = a.engine.getSocket().publicId;
            await a.engine.reconcileOnWindowFocus();
            assert.ok(await a.exists(focusTarget), 'returning to the window catches up the missed structural change');
            assert.equal(a.engine.getSocket().publicId, beforeFocus);
            const refreshCount = periodicRefreshes;
            await a.engine.reconcileOnWindowFocus();
            assert.equal(periodicRefreshes, refreshCount, 'repeated focus events are coalesced');
            await passed('Window-focus catch-up recovers a missed restoration without reconnecting or repeated notifications');
            for (const client of [a, b]) {
                await client.engine.stateStore.flush();
                assert.equal(client.engine.fileErrors.size, 0, 'No unexplained file errors may remain');
                assert.equal([...client.engine.stateStore.entries.values()].some((record: any) => record.intent), false,
                    'Every submitted operation must finish its journal');
            }
            const common = await b.read(target);
            a.engine.disconnect();
            const localConflict = common.replace('FIRST offline', 'Local conflicting edit');
            const remoteConflict = common.replace('FIRST offline', 'Remote conflicting edit');
            assert.notEqual(localConflict, common);
            await a.write(target, localConflict);
            await b.write(target, remoteConflict);
            await eventually(async () => b.engine.fileCache.get('/' + target) === createHash('sha256').update(remoteConflict).digest('hex'),
                'conflicting remote edit committed');
            a = await startClient('client-a');
            assert.ok(a.choices.includes('/' + target), 'Overlapping edits must request review');
            assert.equal(await a.read(target), localConflict);
            assert.equal(await b.read(target), remoteConflict);
            const remoteEntry = b.engine.fileTreeByPath.get('/' + target);
            assert.equal(Buffer.from(await b.engine.getRemoteEntryContent(remoteEntry)).toString('utf8'), remoteConflict);
            await passed('Overlapping edits preserve both versions for review without overwriting remote content');
            report.finished = new Date().toISOString();
        } catch (error) {
            report.failure = error instanceof Error ? error.message : String(error);
            log('FAILED: ' + report.failure);
            throw error;
        } finally {
            for (const engine of engines) engine.disconnect();
            control?.dispose();
            await saveReport();
        }
    } };
    // A development window can share the normal VS Code profile while the
    // user's ordinary windows stay open. CLI extensionTestsPath cannot do that.
    void runner.run().catch(error => console.error('LocalLeaf integration failed:', error instanceof Error ? error.message : String(error)))
        .finally(() => { setTimeout(() => void vscode.commands.executeCommand('workbench.action.closeWindow'), 1000); });
    return runner;
}
