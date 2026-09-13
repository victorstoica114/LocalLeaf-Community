import * as vscode from 'vscode';
import { BaseAPI } from '../api/base';
import { SyncEngine } from '../sync/syncEngine';
import { CredentialManager } from '../utils/credentialManager';
import { approveCreatedProjectSync } from '../utils/createdProjectAuthorization';
import { conciseErrorMessage } from '../utils/errorMessages';
import { LinkOperationGate } from '../utils/linkSafety';
import { inspectProjectCreationFolder, saveNewProjectLink } from '../utils/projectCreationFolder';
import { validateProjectName } from '../utils/projectName';
import { validateServerUrl } from '../utils/serverUrl';
import { SettingsManager } from '../utils/settingsManager';
import { CreateProjectPanel, CreateProjectPanelAction, CreateProjectPanelState } from './createProjectPanel';

export interface CreateProjectHooks {
    gate: LinkOperationGate;
    log(message: string): void;
    signIn(serverUrl: string): Promise<void>;
    refreshViews(): Promise<void>;
    onLocalSetupStart(folder: vscode.Uri): void;
    onLocalSetupFinish(folder: vscode.Uri, settings?: SettingsManager): Promise<void>;
    chooseFolder?(): Promise<vscode.Uri | undefined>;
}

/** Keeps the operation alive when its editor tab is hidden or closed. */
export class CreateProjectController implements vscode.Disposable {
    private state: CreateProjectPanelState;
    private panel?: CreateProjectPanel;
    private folder?: vscode.Uri;
    private created?: { id: string; name: string; serverUrl: string; folder?: vscode.Uri };
    private submittedServer?: string;
    private api?: BaseAPI;
    private engine?: SyncEngine;
    private disposed = false;
    private busy = false;
    private accountGeneration = 0;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly credentials: CredentialManager,
        private readonly hooks: CreateProjectHooks,
    ) {
        this.state = {
            draft: { projectName: '', serverUrl: SettingsManager.getCurrentInstance()?.getSettings()?.serverUrl
                || credentials.getDefaultServer(), localCopy: true },
            draftRevision: 0, phase: 'idle',
        };
    }

    getState(): CreateProjectPanelState {
        return { ...this.state, draft: { ...this.state.draft }, account: this.state.account && { ...this.state.account },
            createdProject: this.state.createdProject && { ...this.state.createdProject } };
    }

    async show(): Promise<void> {
        if (this.disposed) return;
        this.panel = CreateProjectPanel.createOrShow(this.context.extensionUri, this.getState(), action => this.handleAction(action));
        await this.refreshAccount();
    }

    private publish(): void {
        if (!this.disposed) CreateProjectPanel.updateIfOpen(this.getState());
    }

    async refreshAccount(): Promise<void> {
        if (this.disposed || this.busy || this.state.phase === 'uncertain') return;
        const generation = ++this.accountGeneration;
        let serverUrl: string;
        try { serverUrl = validateServerUrl(this.created?.serverUrl || this.state.draft.serverUrl).url; }
        catch { this.state.account = undefined; this.publish(); return; }
        try {
            const credential = await this.credentials.getCredential(serverUrl);
            if (this.disposed || this.busy || generation !== this.accountGeneration) return;
            this.state.account = credential ? { serverUrl, email: credential.userEmail } : undefined;
            this.publish();
        } catch (error) {
            if (this.disposed || this.busy || generation !== this.accountGeneration) return;
            this.state.account = undefined;
            this.state.error = conciseErrorMessage(error);
            this.publish();
        }
    }

    async handleAction(action: CreateProjectPanelAction): Promise<void> {
        if (this.disposed || this.busy) return;
        try {
            if (action.type === 'signIn' && this.created) {
                await this.hooks.signIn(this.created.serverUrl);
                await this.refreshAccount();
                return;
            }
            if ('draft' in action) {
                if (this.created || this.state.phase === 'uncertain' || action.revision < this.state.draftRevision) return;
                const serverChanged = this.state.draft.serverUrl !== action.draft.serverUrl;
                this.state.draft = { ...action.draft };
                this.state.draftRevision = action.revision;
                if (serverChanged) {
                    this.accountGeneration++;
                    this.state.account = undefined;
                }
                this.state.phase = 'idle';
                this.state.error = undefined;
                this.state.message = undefined;
                if (action.type === 'draftChanged') {
                    this.publish();
                    if (serverChanged) await this.refreshAccount();
                    return;
                }
            }
            switch (action.type) {
                case 'checkAccount': await this.checkAccount(); break;
                case 'signIn':
                    await this.hooks.signIn(validateServerUrl(this.state.draft.serverUrl).url);
                    await this.refreshAccount();
                    break;
                case 'browseFolder': await this.browseFolder(); break;
                case 'create': await this.create(); break;
                case 'retryLocalSetup':
                    if (this.created?.folder && this.state.canRetryLocalSetup) await this.runCreationOperation(false);
                    break;
                case 'openProject': {
                    const url = this.state.createdProject?.url
                        || (this.state.phase === 'uncertain' && this.submittedServer ? `${this.submittedServer}/project` : undefined);
                    if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
                    break;
                }
                case 'openFolder':
                    if (this.state.localFolderReady && this.created?.folder) {
                        const alreadyOpen = vscode.workspace.workspaceFolders?.some(folder =>
                            folder.uri.toString() === this.created!.folder!.toString());
                        if (alreadyOpen) await vscode.commands.executeCommand('workbench.view.explorer');
                        else await vscode.commands.executeCommand('vscode.openFolder', this.created.folder, { forceNewWindow: true });
                    }
                    break;
                case 'newProject':
                    this.created = undefined;
                    this.submittedServer = undefined;
                    this.folder = undefined;
                    this.state = { draft: { projectName: '', serverUrl: this.state.draft.serverUrl, localCopy: true },
                        draftRevision: this.state.draftRevision + 1, phase: 'idle' };
                    this.publish();
                    await this.refreshAccount();
                    break;
            }
        } catch (error) {
            if (!this.disposed) {
                // Opening a successful result must never turn it into another creation attempt.
                if (!this.created && this.state.phase !== 'uncertain') this.state.phase = 'error';
                this.state.error = conciseErrorMessage(error);
                this.publish();
            }
        }
    }

    private async checkAccount(): Promise<void> {
        const serverUrl = validateServerUrl(this.state.draft.serverUrl).url;
        this.busy = true;
        this.state.phase = 'checking';
        this.state.message = 'Checking your Overleaf session…';
        this.publish();
        try {
            const credential = await this.credentials.getCredential(serverUrl);
            if (this.disposed) return;
            if (!credential) throw new Error('Sign in to this server to create your project.');
            const api = this.api = new BaseAPI(serverUrl);
            api.setIdentity(credential.identity);
            const result = await api.verifyCredentials();
            if (this.disposed) return;
            if (result.type !== 'success') throw new Error(result.message || 'The session could not be verified. Sign in again.');
            this.state.account = { serverUrl, email: result.userInfo?.userEmail || credential.userEmail };
            this.state.phase = 'idle';
            this.state.message = 'Account verified. You can create your project.';
        } catch (error) {
            this.state.account = undefined;
            this.state.phase = 'error';
            this.state.error = conciseErrorMessage(error);
        } finally {
            this.api?.dispose();
            this.api = undefined;
            this.busy = false;
            this.publish();
        }
    }

    private async browseFolder(): Promise<void> {
        this.busy = true;
        this.accountGeneration++;
        this.state.phase = 'choosing';
        this.state.message = 'Choose an empty local folder in the folder picker…';
        this.publish();
        try {
            const selected = this.hooks.chooseFolder ? await this.hooks.chooseFolder()
                : (await vscode.window.showOpenDialog({ title: 'Choose an empty folder for your new project',
                canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
                openLabel: 'Use This Folder', defaultUri: this.folder }))?.[0];
            if (this.disposed || !selected) return;
            await inspectProjectCreationFolder(selected);
            if (this.disposed) return;
            this.folder = selected;
            this.state.folderPath = this.folder.fsPath;
            this.state.draft.localCopy = true;
        } finally {
            this.busy = false;
            this.state.phase = 'idle';
            this.state.message = undefined;
            this.publish();
        }
    }

    private async create(): Promise<void> {
        if (this.created || this.state.phase === 'uncertain') return;
        this.state.draft.projectName = validateProjectName(this.state.draft.projectName);
        this.state.draft.serverUrl = validateServerUrl(this.state.draft.serverUrl).url;
        if (this.state.draft.localCopy && !this.folder) throw new Error('Choose an empty local folder first.');
        await this.runCreationOperation(true);
    }

    private async runCreationOperation(createRemote: boolean): Promise<void> {
        if (!this.hooks.gate.tryEnter()) throw new Error('Another project setup is running. Finish it before creating a project.');
        this.busy = true;
        this.accountGeneration++;
        this.state.error = undefined;
        this.state.canRetryLocalSetup = false;
        this.state.phase = createRemote ? 'creating' : 'downloading';
        this.state.message = createRemote ? 'Creating your project on Overleaf…' : 'Resuming the local download…';
        this.publish();
        let postStarted = false;
        try {
            const serverUrl = this.created?.serverUrl || this.state.draft.serverUrl;
            const folder = createRemote ? (this.state.draft.localCopy ? this.folder : undefined) : this.created?.folder;
            if (createRemote && folder) await inspectProjectCreationFolder(folder);
            if (this.disposed) return;
            const credential = await this.credentials.getCredential(serverUrl);
            if (this.disposed) return;
            if (!credential) {
                this.state.account = undefined;
                throw new Error('Your session is no longer available. Sign in to this server and try again.');
            }
            const api = this.api = new BaseAPI(serverUrl);
            api.setIdentity(credential.identity);
            if (createRemote) {
                this.submittedServer = serverUrl;
                postStarted = true;
                const result = await api.createProject(this.state.draft.projectName);
                if (this.disposed) return;
                if (result.type !== 'success' || !result.projectId) {
                    postStarted = result.type === 'success' || Boolean(result.creationUncertain);
                    if (result.authError) this.state.account = undefined;
                    throw new Error(postStarted
                        ? 'The server may have created your project. Open Overleaf and check the project list before starting another project.'
                        : result.message || 'The server could not create the project.');
                }
                this.created = { id: result.projectId, name: this.state.draft.projectName, serverUrl, folder };
                this.state.createdProject = { name: this.created.name,
                    url: `${serverUrl}/project/${encodeURIComponent(result.projectId)}` };
                this.publish();
            }
            if (folder) await this.setUpLocalFolder(api);
            if (this.disposed) return;
            this.state.phase = 'success';
            this.state.message = folder ? 'Your project is ready in Overleaf and in your local folder.' : 'Your project is ready in Overleaf.';
        } catch (error) {
            if (this.disposed) return;
            this.state.phase = !this.created && postStarted ? 'uncertain' : 'error';
            this.state.canRetryLocalSetup = Boolean(this.created?.folder && !this.state.localFolderReady);
            this.state.error = conciseErrorMessage(error);
            this.state.message = this.created ? 'Your project was created in Overleaf. Local setup needs attention.' : undefined;
        } finally {
            this.api?.dispose();
            this.api = undefined;
            this.busy = false;
            this.hooks.gate.leave();
            this.publish();
            if (!this.disposed && this.created) {
                try { await this.hooks.refreshViews(); }
                catch (error) { this.hooks.log(`Project list refresh failed: ${conciseErrorMessage(error)}`); }
            }
        }
    }

    private async setUpLocalFolder(api: BaseAPI): Promise<void> {
        const project = this.created!;
        const folder = project.folder!;
        this.state.phase = 'downloading';
        this.state.message = 'Preparing the local folder…';
        this.publish();
        this.hooks.onLocalSetupStart(folder);
        let readySettings: SettingsManager | undefined;
        let subscription: vscode.Disposable | undefined;
        try {
            await approveCreatedProjectSync(this.context.globalState, {
                workspaceUri: folder.toString(), serverUrl: project.serverUrl, projectId: project.id,
            });
            if (this.disposed) return;
            // A prior attempt may have published the exact link before download failed.
            let settings = SettingsManager.getInstance(folder);
            const existing = await settings.load();
            if (this.disposed) return;
            if (existing) {
                if (existing.serverUrl !== project.serverUrl || existing.projectId !== project.id) {
                    throw new Error('This folder is now linked to another project. Its configuration was preserved.');
                }
            } else {
                settings = await saveNewProjectLink(folder,
                    SettingsManager.createDefaultSettings(project.serverUrl, project.id, project.name));
            }
            if (this.disposed) return;
            const engine = this.engine = new SyncEngine(api, settings, this.hooks.log, this.context.globalStorageUri);
            subscription = engine.onStatusChange(event => {
                if (this.disposed) return;
                if (event.authError) this.state.account = undefined;
                this.state.message = event.message || 'Downloading project files…';
                this.publish();
            });
            await engine.connect();
            if (this.disposed) return;
            await engine.pullAll(false);
            if (this.disposed) return;
            this.state.localFolderReady = true;
            readySettings = settings;
        } finally {
            subscription?.dispose();
            this.engine?.disconnect();
            this.engine = undefined;
            try { await this.hooks.onLocalSetupFinish(folder, this.disposed ? undefined : readySettings); }
            catch (error) { this.hooks.log(`Could not activate the new local project: ${conciseErrorMessage(error)}`); }
        }
    }

    dispose(): void {
        this.disposed = true;
        this.accountGeneration++;
        this.panel?.dispose();
        this.engine?.disconnect();
        this.engine = undefined;
        this.api?.dispose();
        this.api = undefined;
    }
}
