/** Opt-in creation test using LocalLeaf's normal SecretStorage authentication. */
import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { CredentialManager } from '../utils/credentialManager';
import { BaseAPI } from '../api/base';
import { SyncEngine } from '../sync/syncEngine';
import { SettingsManager } from '../utils/settingsManager';
import { setOutputChannel } from '../api/socketio';

export function activate(context: vscode.ExtensionContext): void {
    const credentials = CredentialManager.initialize(context);
    const run = async () => {
        assert.equal(context.extensionMode, vscode.ExtensionMode.Development);
        const config = JSON.parse(await fs.readFile(path.join(context.extensionPath, 'run.json'), 'utf8')) as {
            serverUrl: string; projectId: string; projectName: string; directory: string; createProjectTest?: boolean;
        };
        assert.equal(config.createProjectTest, true, 'Project creation must be explicitly enabled');
        const output = vscode.window.createOutputChannel('LocalLeaf Project Creation Test');
        context.subscriptions.push(output);
        setOutputChannel(output);
        const report: { checks: string[]; projectName?: string; projectId?: string; url?: string; failure?: string; finished?: string } = { checks: [] };
        const reportPath = path.join(config.directory, 'result.json');
        const log = (message: string) => {
            const line = `[${new Date().toISOString()}] ${message}`;
            output.appendLine(line);
            void fs.appendFile(path.join(config.directory, 'integration.log'), line + '\n');
        };
        const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
        const pass = async (message: string) => { report.checks.push(message); log('PASS: ' + message); await save(); };
        let api: BaseAPI | undefined;
        let engine: SyncEngine | undefined;
        await save();
        try {
            const credential = await credentials.getCredential(config.serverUrl);
            assert.ok(credential, 'Sign in through LocalLeaf before running this test');
            api = new BaseAPI(config.serverUrl);
            api.setIdentity(credential.identity);
            // Verify the explicitly selected existing test project before
            // creating anything on this account/server. Its files are untouched.
            const anchor = await api.getProjectDetails(config.projectId);
            assert.equal(anchor.type, 'success', anchor.message);
            assert.equal(anchor.projectData?.projectName, config.projectName);
            const name = 'LocalLeaf create test ' + path.basename(config.directory);
            report.projectName = name;
            await save();
            const created = await api.createProject(name);
            assert.equal(created.type, 'success', created.message);
            assert.ok(created.projectId);
            const projectId = created.projectId;
            report.projectId = projectId;
            report.url = `${config.serverUrl}/project/${encodeURIComponent(projectId)}`;
            await pass('Create New Project returns a valid project identity');
            const projects = await api.getProjects();
            assert.equal(projects.type, 'success', projects.message);
            const matches = projects.projects?.filter(project => project.id === projectId);
            assert.equal(matches?.length, 1);
            assert.equal(matches?.[0].name, name);
            assert.equal(matches?.[0].accessLevel, 'owner');
            assert.equal(projects.projects?.filter(project => project.name === name).length, 1, 'one request must create one project');
            await pass('Created project appears once in the authenticated project list with the requested name');

            const root = vscode.Uri.file(path.join(config.directory, 'client-a'));
            const settings = SettingsManager.getInstance(root);
            await settings.save(SettingsManager.createDefaultSettings(config.serverUrl, projectId, name));
            engine = new SyncEngine(api, settings, log, vscode.Uri.file(path.join(config.directory, 'state')));
            await engine.connect();
            await engine.pullAll(false);
            const main = [...engine.getFileTree().values()].find(entry => entry.path === '/main.tex');
            assert.equal(main?.name, 'main.tex');
            assert.equal(main?.type, 'doc');
            const mainUri = settings.getFilePath(main!.path);
            const initial = await vscode.workspace.fs.readFile(mainUri);
            assert.ok(initial.byteLength > 0);
            await pass('Blank project contains main.tex and downloads into an empty local folder');
            const next = Buffer.concat([initial, Buffer.from('\n% LocalLeaf project creation integration test\n')]);
            await vscode.workspace.fs.writeFile(mainUri, next);
            const deadline = Date.now() + 30_000;
            let synchronized = false;
            while (Date.now() < deadline) {
                const snapshot = await engine.getSocket()!.joinDoc(main!.id);
                if (snapshot.lines.join('\n') === next.toString('utf8')) { synchronized = true; break; }
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            assert.ok(synchronized, 'A local save in the new project must reach the server');
            await pass('A local edit automatically synchronizes to the newly created project');
            report.finished = new Date().toISOString();
        } catch (error) {
            report.failure = error instanceof Error ? error.message : String(error);
            log('FAILED: ' + report.failure);
        } finally {
            engine?.disconnect();
            api?.dispose();
            await save();
        }
    };
    void run().catch(error => console.error('Project creation integration failed:', error))
        .finally(() => { setTimeout(() => void vscode.commands.executeCommand('workbench.action.closeWindow'), 1000); });
}
