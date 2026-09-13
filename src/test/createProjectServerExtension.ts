/** Opt-in creation test using LocalLeaf's normal SecretStorage authentication. */
import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { CredentialManager } from '../utils/credentialManager';
import { BaseAPI } from '../api/base';
import { SyncEngine } from '../sync/syncEngine';
import { SettingsManager } from '../utils/settingsManager';
import { setOutputChannel } from '../api/socketio';
import { CreateProjectController } from '../views/createProjectController';
import { LinkOperationGate } from '../utils/linkSafety';
import { CREATED_PROJECT_AUTHORIZATION_KEY } from '../utils/createdProjectAuthorization';
import { isSyncTargetApproved } from '../utils/syncAuthorization';

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
        const report: {
            checks: string[]; projectName?: string; projectId?: string; url?: string;
            localFolder?: string; failure?: string; finished?: string;
        } = { checks: [] };
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
        let controller: CreateProjectController | undefined;
        const originalCreateProject = BaseAPI.prototype.createProject;
        let creationCalls = 0;
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
            await pass('Authenticated test anchor matches the explicitly selected project');
            const name = 'LocalLeaf create test ' + path.basename(config.directory);
            report.projectName = name;
            // The repository itself is linked. A newly selected destination must
            // be outside that project and all other existing linked ancestors.
            const root = vscode.Uri.file(await fs.mkdtemp(path.join(tmpdir(), 'localleaf-create-project-')));
            report.localFolder = root.fsPath;
            await save();
            const workspaceBefore = vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString());
            const currentBefore = SettingsManager.getCurrentInstance();
            const gate = new LinkOperationGate();
            let folderSelections = 0;
            let setupStarts = 0;
            let setupFinishes = 0;
            let downloadedSettings: SettingsManager | undefined;
            BaseAPI.prototype.createProject = async function (projectName: string) {
                creationCalls++;
                // Count actual production API calls, without replaying a second
                // mutation even if a controller regression attempted one.
                assert.equal(creationCalls, 1, 'The controller must submit only one creation request');
                assert.equal(projectName, name);
                return originalCreateProject.call(this, projectName);
            };
            controller = new CreateProjectController(context, credentials, {
                gate, log,
                signIn: async () => { throw new Error('The existing SecretStorage session must be reused'); },
                refreshViews: async () => {},
                chooseFolder: async () => { folderSelections++; return root; },
                onLocalSetupStart: folder => {
                    assert.equal(folder.toString(), root.toString());
                    setupStarts++;
                },
                onLocalSetupFinish: async (folder, settings) => {
                    assert.equal(folder.toString(), root.toString());
                    setupFinishes++;
                    downloadedSettings = settings;
                },
            });
            await controller.show();
            const draft = { projectName: name, serverUrl: config.serverUrl, localCopy: true };
            const revision = controller.getState().draftRevision + 1;
            await controller.handleAction({ type: 'draftChanged', draft, revision });
            assert.equal(controller.getState().account?.serverUrl, config.serverUrl);
            assert.equal(creationCalls, 0);
            await controller.handleAction({ type: 'browseFolder', draft, revision });
            assert.equal(controller.getState().error, undefined);
            assert.equal(controller.getState().folderPath, root.fsPath);
            assert.equal(folderSelections, 1);
            assert.equal(creationCalls, 0, 'Choosing a folder must not create a remote project');
            await pass('Creation webview reuses the signed-in account and accepts a native empty-folder selection');

            await controller.handleAction({ type: 'create', draft, revision });
            const created = controller.getState();
            if (created.createdProject) {
                report.url = created.createdProject.url;
                report.projectId = new URL(created.createdProject.url).pathname.split('/').pop();
                await save();
            }
            assert.equal(created.phase, 'success', created.error || created.message);
            assert.equal(created.localFolderReady, true);
            assert.equal(created.canRetryLocalSetup, false);
            assert.equal(created.createdProject?.name, name);
            assert.equal(creationCalls, 1);
            assert.equal(gate.isActive, false);
            assert.equal(setupStarts, 1);
            assert.equal(setupFinishes, 1);
            assert.ok(downloadedSettings, 'The local download must finish with usable settings');
            const settings = SettingsManager.getInstance(root);
            const savedSettings = await settings.load();
            assert.ok(savedSettings);
            const projectId = savedSettings.projectId;
            assert.notEqual(projectId, config.projectId);
            assert.equal(savedSettings.serverUrl, config.serverUrl);
            assert.equal(savedSettings.projectName, name);
            assert.equal(savedSettings.autoSync, true);
            report.projectId = projectId;
            report.url = `${config.serverUrl}/project/${encodeURIComponent(projectId)}`;
            assert.equal(created.createdProject?.url, report.url);
            assert.equal(downloadedSettings.getWorkspaceFolder().toString(), root.toString());
            assert.deepEqual(vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()), workspaceBefore);
            assert.equal(SettingsManager.getCurrentInstance(), currentBefore);
            await pass('Create-and-download succeeds and saves the exact target without switching the current workspace');

            const target = { workspaceUri: root.toString(), serverUrl: config.serverUrl, projectId };
            const pending = context.globalState.get<unknown>(CREATED_PROJECT_AUTHORIZATION_KEY);
            assert.ok(isSyncTargetApproved(pending, target), 'Opening the selected folder must reuse the exact creation consent');
            assert.equal(isSyncTargetApproved(pending, { ...target, workspaceUri: vscode.Uri.joinPath(root, 'other').toString() }), false);
            assert.equal(isSyncTargetApproved(pending, { ...target, projectId: config.projectId }), false);
            assert.equal(isSyncTargetApproved(pending, { ...target, serverUrl: 'https://other.localleaf.invalid' }), false);
            const mainUri = settings.getFilePath('/main.tex');
            const initial = await vscode.workspace.fs.readFile(mainUri);
            assert.ok(initial.byteLength > 0);
            await pass('main.tex downloads and persisted opening consent is limited to this folder, server and project');

            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await controller.show();
            assert.equal(controller.getState().phase, 'success');
            assert.equal(controller.getState().localFolderReady, true);
            await controller.handleAction({ type: 'create', draft, revision: revision + 1 });
            assert.equal(creationCalls, 1);
            assert.equal(controller.getState().createdProject?.url, report.url);
            await pass('Closing and reopening the creation form preserves its result and prevents duplicate creation');

            const projects = await api.getProjects();
            assert.equal(projects.type, 'success', projects.message);
            const matches = projects.projects?.filter(project => project.id === projectId);
            assert.equal(matches?.length, 1);
            assert.equal(matches?.[0].name, name);
            assert.equal(matches?.[0].accessLevel, 'owner');
            assert.equal(projects.projects?.filter(project => project.name === name).length, 1, 'one request must create one project');
            await pass('Created project appears once in the authenticated project list with the requested name');

            engine = new SyncEngine(api, settings, log, context.globalStorageUri);
            await engine.connect();
            await engine.pullAll(false);
            const main = [...engine.getFileTree().values()].find(entry => entry.path === '/main.tex');
            assert.equal(main?.name, 'main.tex');
            assert.equal(main?.type, 'doc');
            assert.deepEqual(await vscode.workspace.fs.readFile(mainUri), initial);
            await pass('A fresh sync engine resumes the local copy created by the graphical workflow');
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
            controller?.dispose();
            engine?.disconnect();
            api?.dispose();
            BaseAPI.prototype.createProject = originalCreateProject;
            await save();
        }
    };
    void run().catch(error => console.error('Project creation integration failed:', error))
        .finally(() => { setTimeout(() => void vscode.commands.executeCommand('workbench.action.closeWindow'), 1000); });
}
