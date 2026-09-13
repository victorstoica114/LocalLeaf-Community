import { selectDefaultServer } from './utils/connectionSettings';
/**
 * LocalLeaf VS Code Extension
 * Local sync for Overleaf LaTeX projects
 */

import * as vscode from 'vscode';
import { COMMANDS, EXTENSION_NAME, STATUS_BAR_PRIORITY, CONFIG_DIR, IGNORE_FILE } from './consts';
import { CredentialManager, ServerCredential } from './utils/credentialManager';
import {
    SettingsManager,
    createSettingsWatcher,
} from './utils/settingsManager';
import { BaseAPI, ProjectInfo } from './api/base';
import { SyncEngine, SyncStatus } from './sync/syncEngine';
import { IgnoreParser } from './sync/ignoreParser';
import { CursorTracker } from './collaboration/cursorTracker';
import { setOutputChannel } from './api/socketio';
import { ProjectsWebviewProvider } from './views/projectsWebviewProvider';
import { MainWebviewProvider } from './views/mainWebviewProvider';
import { AccountPanel, AccountPanelAction, AccountPanelOperation, AccountPanelState } from './views/accountPanel';
import {
    LinkOperationGate,
    resolveRequestedProject,
    shouldConfirmProjectLink,
} from './utils/linkSafety';
import { validateServerUrl, ValidatedServerUrl } from './utils/serverUrl';
import { assertSafeWorkspacePath, normalizeProjectPath } from './utils/pathSafety';
import { removeStandaloneLatexComments } from './utils/latexComments';
import {
    approveSyncTarget,
    isSyncTargetApproved,
    revokeSyncTarget,
    SyncAuthorizationTarget,
} from './utils/syncAuthorization';
import { BrowserPreference, captureCookiesViaBrowserLogin } from './auth/browserCookieLogin';
import { createWindowFocusListener, isSyncInitializationSnapshotCurrent } from './utils/syncInitialization';
import { CreateProjectController } from './views/createProjectController';
import { consumeCreatedProjectSyncAuthorization } from './utils/createdProjectAuthorization';

/**
 * Auth state type
 */
type AuthState = 'valid' | 'expired' | 'unknown' | 'none';

/**
 * Extension state
 */
let credentialManager: CredentialManager;
let syncEngine: SyncEngine | undefined;
let cursorTracker: CursorTracker | undefined;
let statusBarItem: vscode.StatusBarItem;
let loginStatusItem: vscode.StatusBarItem;
let collaboratorStatusItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let statusUpdateInterval: NodeJS.Timeout | undefined;
let authState: AuthState = 'unknown';
let authStateServerUrl: string | undefined;
let authPresentationGeneration = 0;
let loginStatusGeneration = 0;
const expiredSessionNotifications = new Set<string>();
let projectsWebviewProvider: ProjectsWebviewProvider;
let mainWebviewProvider: MainWebviewProvider;
let settingsWatcher: vscode.Disposable | undefined;
let settingsWatcherGeneration = 0;
let syncStatusSubscription: vscode.Disposable | undefined;
let workspaceChangeGeneration = 0;
let syncSessionGeneration = 0;
let activeSyncKey: string | undefined;
let extensionContext: vscode.ExtensionContext;
let accountPanelOperation: AccountPanelOperation | undefined;
let accountPanelServerOverride: string | undefined;
let accountPanelSelectedServer: string | undefined;
let activeBrowserLogin: AbortController | undefined;
let activeBrowserLoginTask: Promise<unknown> | undefined;
let accountActionInProgress = false;
let deactivating = false;
let projectCreationController: CreateProjectController | undefined;
const projectCreationLocalFolders = new Set<string>();
const linkOperationGate = new LinkOperationGate();
const panelConfirmation = Object.freeze({ source: 'localleaf-panel' });
const SYNC_AUTHORIZATION_STATE_KEY = 'localleaf.approvedSyncTargets.v1';

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function getSyncKey(settings: SettingsManager): string | undefined {
    const project = settings.getSettings();
    if (!project) return undefined;
    return JSON.stringify([settings.getWorkspaceFolder().toString(), project.serverUrl, project.projectId]);
}

function getSyncAuthorizationTarget(settings: SettingsManager): SyncAuthorizationTarget | undefined {
    const project = settings.getSettings();
    if (!project) return undefined;
    return {
        workspaceUri: settings.getWorkspaceFolder().toString(),
        serverUrl: project.serverUrl,
        projectId: project.projectId,
    };
}

function hasSyncAuthorization(context: vscode.ExtensionContext, settings: SettingsManager): boolean {
    const target = getSyncAuthorizationTarget(settings);
    return Boolean(target && isSyncTargetApproved(
        context.workspaceState.get<unknown>(SYNC_AUTHORIZATION_STATE_KEY),
        target,
    ));
}

async function grantSyncAuthorization(
    context: vscode.ExtensionContext,
    settings: SettingsManager,
): Promise<void> {
    const target = getSyncAuthorizationTarget(settings);
    if (!target) throw new Error('Cannot authorize synchronization without valid project settings.');
    await context.workspaceState.update(
        SYNC_AUTHORIZATION_STATE_KEY,
        approveSyncTarget(context.workspaceState.get<unknown>(SYNC_AUTHORIZATION_STATE_KEY), target),
    );
}

async function revokeSyncAuthorization(
    context: vscode.ExtensionContext,
    settings: SettingsManager,
): Promise<void> {
    const workspaceUri = settings.getWorkspaceFolder().toString();
    await context.workspaceState.update(
        SYNC_AUTHORIZATION_STATE_KEY,
        revokeSyncTarget(context.workspaceState.get<unknown>(SYNC_AUTHORIZATION_STATE_KEY), workspaceUri),
    );
}

async function ensureSyncAuthorization(
    context: vscode.ExtensionContext,
    settings: SettingsManager,
): Promise<boolean> {
    const target = getSyncAuthorizationTarget(settings);
    const originalKey = getSyncKey(settings);
    if (target) {
        try {
            await consumeCreatedProjectSyncAuthorization(context.globalState, context.workspaceState,
                target, SYNC_AUTHORIZATION_STATE_KEY);
        } catch (error) {
            log(`Could not transfer created-project authorization: ${errorMessage(error)}`);
        }
        if (deactivating || getSyncKey(settings) !== originalKey) return false;
    }
    if (hasSyncAuthorization(context, settings)) return true;
    const project = settings.getSettings();
    if (!project) return false;
    const approvedSyncKey = getSyncKey(settings);

    const approval = await vscode.window.showWarningMessage(
        `Allow LocalLeaf to synchronize this folder with "${project.projectName}"?`,
        {
            modal: true,
            detail: [
                `Folder: ${settings.getWorkspaceFolder().fsPath}`,
                `Server: ${project.serverUrl}`,
                '',
                'Remote changes can replace local project files, and saved local changes can be uploaded to Overleaf.',
                'Approval is stored only for this exact folder, server, and project.',
            ].join('\n'),
        },
        'Allow Sync',
    );
    if (approval !== 'Allow Sync') {
        updateStatusBar('disconnected', 'Sync approval required');
        log(`Synchronization not authorized for ${settings.getWorkspaceFolder().fsPath}`);
        return false;
    }
    if (deactivating || getSyncKey(settings) !== approvedSyncKey) return false;
    await grantSyncAuthorization(context, settings);
    return true;
}

function disposeCurrentSyncSession(): void {
    // Invalidate initializations that are waiting on SecretStorage or another
    // asynchronous prerequisite before they have an engine to dispose.
    syncSessionGeneration++;
    const engine = syncEngine;
    syncEngine = undefined;
    syncStatusSubscription?.dispose();
    syncStatusSubscription = undefined;
    cursorTracker?.dispose();
    cursorTracker = undefined;
    engine?.disconnect();
    activeSyncKey = undefined;
    stopStatusUpdates();
}

function isCurrentSyncInitialization(
    generation: number,
    settings: SettingsManager,
    expectedSyncKey: string,
): boolean {
    return isSyncInitializationSnapshotCurrent({
        deactivating,
        currentGeneration: syncSessionGeneration,
        expectedGeneration: generation,
        currentSyncKey: getSyncKey(settings),
        activeSyncKey,
        expectedSyncKey,
    });
}

function abandonStaleSyncEngine(
    engine: SyncEngine,
    generation: number,
    settings: SettingsManager,
    expectedSyncKey: string,
): boolean {
    if (syncEngine !== engine) return true;
    if (isCurrentSyncInitialization(generation, settings, expectedSyncKey)) return false;
    disposeCurrentSyncSession();
    return true;
}

function listenForSyncStatus(engine: SyncEngine, serverUrl: string): void {
    syncStatusSubscription?.dispose();
    syncStatusSubscription = engine.onStatusChange(event => {
        if (syncEngine !== engine) return;
        updateStatusBar(event.status, event.message);
        if (event.authError) {
            void (async () => {
                await setAuthState('expired', serverUrl);
                if (syncEngine === engine && !deactivating) {
                    await showSessionExpiredNotification(serverUrl);
                }
            })().catch(error => log(`Failed to present session status: ${errorMessage(error)}`));
        }
    });
}

function configureSettingsWatcher(context: vscode.ExtensionContext, workspaceFolder?: vscode.Uri): void {
    const watcherGeneration = ++settingsWatcherGeneration;
    let changeGeneration = 0;
    settingsWatcher?.dispose();
    settingsWatcher = undefined;
    if (!workspaceFolder) return;

    const watchedManager = SettingsManager.getInstance(workspaceFolder);
    const targetSubscription = watchedManager.onWillChangeSyncTarget(() => {
        // The engine shares this manager. Invalidate it before load/save can
        // publish another target, including between awaiting microtasks.
        if (!deactivating && activeSyncKey && watchedManager === SettingsManager.getCurrentInstance()) {
            disposeCurrentSyncSession();
        }
    });

    const handleSettingsChange = async () => {
        if (projectCreationLocalFolders.has(workspaceFolder.toString())) return;
        const change = ++changeGeneration;
        const current = SettingsManager.getCurrentInstance();
        if (!current || current.getWorkspaceFolder().toString() !== workspaceFolder.toString()) return;
        const isCurrent = () => !deactivating
            && watcherGeneration === settingsWatcherGeneration
            && change === changeGeneration
            && current === SettingsManager.getCurrentInstance();

        const linked = Boolean(await current.load());
        if (!isCurrent()) return;
        await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', linked);
        if (!isCurrent()) return;
        if (!linked) {
            disposeCurrentSyncSession();
            statusBarItem.hide();
            collaboratorStatusItem.hide();
        } else {
            statusBarItem.show();
            const nextKey = getSyncKey(current);
            if (nextKey !== activeSyncKey) {
                await initializeSync(context, current);
            }
        }
        if (isCurrent()) await refreshGui();
    };
    const fileWatcher = createSettingsWatcher(workspaceFolder, () => {
        void handleSettingsChange().catch(error => {
            log(`Failed to reload LocalLeaf settings: ${errorMessage(error)}`);
        });
    });
    settingsWatcher = { dispose: () => { targetSubscription.dispose(); fileWatcher.dispose(); } };
}

async function handleWorkspaceFoldersChanged(context: vscode.ExtensionContext): Promise<void> {
    const generation = ++workspaceChangeGeneration;
    settingsWatcherGeneration++;
    disposeCurrentSyncSession();
    settingsWatcher?.dispose();
    settingsWatcher = undefined;
    SettingsManager.clearCurrentWorkspaceFolder();

    const manager = await SettingsManager.resolveCurrentInstance();
    if (generation !== workspaceChangeGeneration) return;
    const linked = Boolean(manager && await manager.isLinked());
    if (manager && linked) await manager.load();
    if (generation !== workspaceChangeGeneration) return;

    configureSettingsWatcher(context, manager?.getWorkspaceFolder());
    await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', linked);
    if (manager && linked) {
        statusBarItem.show();
        await initializeSync(context, manager);
    } else {
        statusBarItem.hide();
        collaboratorStatusItem.hide();
    }
    if (generation === workspaceChangeGeneration) await refreshGui();
}

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
    deactivating = false;
    try {

    extensionContext = context;

    // Initialize output channel
    outputChannel = vscode.window.createOutputChannel(EXTENSION_NAME);
    context.subscriptions.push(outputChannel);

    // Share output channel with socketio module for logging
    setOutputChannel(outputChannel);

    // Initialize credential manager
    credentialManager = CredentialManager.initialize(context);

    // Register the Activity Bar views adapted from PR #3.
    projectsWebviewProvider = new ProjectsWebviewProvider(
        context.extensionUri,
        credentialManager,
        (serverUrl, state) => updateAuthStatePresentation(state, serverUrl),
    );
    mainWebviewProvider = new MainWebviewProvider(
        context.extensionUri,
        credentialManager,
        async command => {
            if (command === COMMANDS.CLEAN_IGNORED_REMOTE) {
                await cmdCleanIgnoredRemoteFiles();
            } else if (command === COMMANDS.UNLINK_FOLDER) {
                await cmdUnlinkFolder(panelConfirmation);
            }
        },
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ProjectsWebviewProvider.viewType,
            projectsWebviewProvider,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
        vscode.window.registerWebviewViewProvider(
            MainWebviewProvider.viewType,
            mainWebviewProvider,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
    );

    // Resolve the view context before slower authentication and network work.
    let settingsManager = await SettingsManager.resolveCurrentInstance();
    const isLinked = Boolean(settingsManager && await settingsManager.isLinked());
    await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', isLinked);

    // Create status bar items
    // Sync status (left side)
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY);
    statusBarItem.name = `${EXTENSION_NAME} Sync`;
    context.subscriptions.push(statusBarItem);

    // Login status (left side, before sync)
    loginStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY + 1);
    loginStatusItem.name = `${EXTENSION_NAME} Login`;
    loginStatusItem.command = COMMANDS.SHOW_ACCOUNT_PANEL;
    context.subscriptions.push(loginStatusItem);

    // Collaborator status (left side, next to sync)
    collaboratorStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY - 1);
    collaboratorStatusItem.name = `${EXTENSION_NAME} Collaborators`;
    collaboratorStatusItem.command = COMMANDS.JUMP_TO_COLLABORATOR;
    context.subscriptions.push(collaboratorStatusItem);

    // Update login status
    await updateLoginStatus();

    // Register commands
    registerCommands(context);

    // Check if current workspace is linked
    if (settingsManager && isLinked) {
        await settingsManager.load();
        // Show status bar only when linked
        statusBarItem.show();
        // Activation must finish before VS Code can resolve the contributed
        // webview. A first pull may legitimately wait for the user to resolve
        // local/remote conflicts, so keep synchronization in the background.
        startInitialSync(context, settingsManager);
    } else {
        // Hide sync status bar when not linked
        statusBarItem.hide();
        collaboratorStatusItem.hide();
    }

    configureSettingsWatcher(
        context,
        settingsManager?.getWorkspaceFolder() ?? vscode.workspace.workspaceFolders?.[0]?.uri,
    );
    context.subscriptions.push(
        { dispose: () => settingsWatcher?.dispose() },
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void handleWorkspaceFoldersChanged(context).catch(error => {
                log(`Failed to switch LocalLeaf workspace: ${errorMessage(error)}`);
            });
        }),
        vscode.window.onDidChangeWindowState(createWindowFocusListener(() => {
            const engine = syncEngine;
            if (!engine || deactivating) return;
            void engine.reconcileOnWindowFocus().catch(error => {
                if (syncEngine === engine && !deactivating) {
                    log(`Could not catch up after returning to VS Code: ${errorMessage(error)}`);
                }
            });
        })),
    );

    await refreshGui();
    log('LocalLeaf activated');

    } catch (error) {
        console.error('[LocalLeaf] Activation error:', error);
        void vscode.window.showErrorMessage(`LocalLeaf failed to activate: ${error}`);
    }
}

function startInitialSync(context: vscode.ExtensionContext, settings: SettingsManager): void {
    void initializeSync(context, settings).catch(error => {
        if (deactivating) return;
        const message = errorMessage(error);
        log(`Failed to initialize sync: ${message}`);
        updateStatusBar('error', message);
    });
}

/**
 * Register all commands
 */
function registerCommands(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.LOGIN, () => cmdShowAccountPanel(context)),
        vscode.commands.registerCommand(COMMANDS.LOGOUT, cmdLogoutFromCommand),
        vscode.commands.registerCommand(COMMANDS.SHOW_ACCOUNT_PANEL, () => cmdShowAccountPanel(context)),
        vscode.commands.registerCommand(COMMANDS.OPEN_PROJECT, (project: unknown) => cmdLinkFolder(context, project)),
        vscode.commands.registerCommand(COMMANDS.CREATE_PROJECT, () => cmdCreateProject(context)),
        vscode.commands.registerCommand(COMMANDS.LINK_FOLDER, () => cmdLinkFolder(context)),
        vscode.commands.registerCommand(COMMANDS.UNLINK_FOLDER, cmdUnlinkFolder),
        vscode.commands.registerCommand(COMMANDS.SYNC_NOW, cmdSyncNow),
        vscode.commands.registerCommand(COMMANDS.PULL_FROM_OVERLEAF, cmdPullFromOverleaf),
        vscode.commands.registerCommand(COMMANDS.PUSH_TO_OVERLEAF, cmdPushToOverleaf),
        vscode.commands.registerCommand(COMMANDS.EDIT_IGNORE_PATTERNS, cmdEditIgnorePatterns),
        vscode.commands.registerCommand(COMMANDS.CLEAN_IGNORED_REMOTE, cmdCleanIgnoredRemoteFiles),
        vscode.commands.registerCommand(COMMANDS.SHOW_SYNC_STATUS, () => cmdShowSyncStatus(context)),
        vscode.commands.registerCommand(COMMANDS.SET_MAIN_DOCUMENT, cmdSetMainDocument),
        vscode.commands.registerCommand(COMMANDS.CONFIGURE, cmdConfigure),
        vscode.commands.registerCommand(COMMANDS.JUMP_TO_COLLABORATOR, cmdJumpToCollaborator),
        vscode.commands.registerCommand(COMMANDS.VERIFY_CREDENTIALS, cmdVerifyCredentials),
        vscode.commands.registerCommand(COMMANDS.REFRESH_COOKIE, cmdRefreshCookie),
        vscode.commands.registerCommand(COMMANDS.REMOVE_COMMENTS, cmdRemoveComments),
    );
}

/**
 * Initialize sync engine for linked folder
 */
async function initializeSync(context: vscode.ExtensionContext, settings: SettingsManager): Promise<void> {
    if (deactivating) return;
    disposeCurrentSyncSession();
    const initializationGeneration = syncSessionGeneration;
    const projectSettings = settings.getSettings();
    const initializationSyncKey = getSyncKey(settings);
    if (!projectSettings || !initializationSyncKey) return;
    // Publish the pending key before the first await so a settings watcher can
    // invalidate this initialization even while SecretStorage is still busy.
    activeSyncKey = initializationSyncKey;

    // Get credentials
    const credential = await credentialManager.getCredential(projectSettings.serverUrl);
    if (!isCurrentSyncInitialization(initializationGeneration, settings, initializationSyncKey)) {
        // A stale initialization for the same project must not clear the key
        // already claimed by a newer generation.
        if (
            syncSessionGeneration === initializationGeneration
            && activeSyncKey === initializationSyncKey
        ) {
            activeSyncKey = undefined;
        }
        return;
    }
    if (!credential) {
        updateStatusBar('disconnected', 'Not logged in');
        void vscode.window.showWarningMessage('LocalLeaf: Please login to Overleaf first');
        return;
    }
    if (!(await ensureSyncAuthorization(context, settings))) return;
    if (!isCurrentSyncInitialization(initializationGeneration, settings, initializationSyncKey)) return;

    // Create API
    const api = new BaseAPI(projectSettings.serverUrl);
    api.setIdentity(credential.identity);

    // Create sync engine
    const engine = new SyncEngine(api, settings, log, context.globalStorageUri);
    syncEngine = engine;

    // Listen to status changes
    listenForSyncStatus(engine, projectSettings.serverUrl);

    // Connect
    try {
        await engine.connect();
        if (abandonStaleSyncEngine(engine, initializationGeneration, settings, initializationSyncKey)) return;
        await setAuthState('valid', projectSettings.serverUrl);
        if (abandonStaleSyncEngine(engine, initializationGeneration, settings, initializationSyncKey)) return;

        // Initialize cursor tracker
        const socket = engine.getSocket();
        if (socket) {
            const tracker = new CursorTracker(socket, settings, engine.getFileTree());
            cursorTracker = tracker;
            await tracker.initialize();
            if (abandonStaleSyncEngine(engine, initializationGeneration, settings, initializationSyncKey)) {
                tracker.dispose();
                return;
            }
        }

        // Start periodic status updates for collaborators
        startStatusUpdates();

        log('Sync engine connected');

        // Auto-detect main document from project settings
        await engine.detectMainDocument();
        if (abandonStaleSyncEngine(engine, initializationGeneration, settings, initializationSyncKey)) return;

        // Pull the initial remote state and subscribe to remote document updates.
        // `autoSync` controls propagation of local filesystem changes to
        // Overleaf; it does not disable safe incoming synchronization.
        try {
            log('Auto-pulling files from Overleaf...');
            await engine.pullAll(false);
            log('Auto-pull complete');
            if (abandonStaleSyncEngine(engine, initializationGeneration, settings, initializationSyncKey)) return;

            // Join all docs to receive real-time OT updates
            await engine.joinAllDocsForWatching();
            if (abandonStaleSyncEngine(engine, initializationGeneration, settings, initializationSyncKey)) return;
            log('Watching for remote changes');

            void vscode.window.showInformationMessage(`LocalLeaf: Synced with "${projectSettings.projectName}"`);
        } catch (pullError) {
            log(`Auto-pull failed: ${pullError}`);
            // Don't show error for auto-pull, user can manually pull
        }
    } catch (error) {
        if (syncEngine !== engine) return;
        log(`Failed to connect: ${error}`);
        disposeCurrentSyncSession();
        updateStatusBar('error', `Failed to connect: ${errorMessage(error)}`);
    }
}

/**
 * Update sync status bar
 */
function updateStatusBar(status: SyncStatus, message?: string) {
    const icons: Record<SyncStatus, string> = {
        disconnected: '$(cloud-offline)',
        connecting: '$(sync~spin)',
        idle: '$(cloud)',
        syncing: '$(sync~spin)',
        pulling: '$(cloud-download)',
        pushing: '$(cloud-upload)',
        error: '$(warning)',
    };
    const labels: Record<SyncStatus, string> = {
        disconnected: 'Disconnected',
        connecting: 'Connecting',
        idle: 'Up to date',
        syncing: 'Syncing',
        pulling: 'Pulling',
        pushing: 'Pushing',
        error: 'Error',
    };

    statusBarItem.text = `${icons[status]} LocalLeaf: ${labels[status]}`;
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**LocalLeaf — ${labels[status]}**\n\n`);
    const settings = SettingsManager.getCurrentInstance()?.getSettings();
    if (settings?.projectName) {
        tooltip.appendText(`Project: ${settings.projectName}`);
        tooltip.appendMarkdown('\n\n');
    }
    tooltip.appendText(message || labels[status]);
    tooltip.appendMarkdown('\n\n_Click to show synchronization details_');
    statusBarItem.tooltip = tooltip;
    statusBarItem.command = COMMANDS.SHOW_SYNC_STATUS;
    statusBarItem.accessibilityInformation = {
        label: `LocalLeaf ${labels[status]}. ${message || labels[status]}`,
        role: 'button',
    };

    if (status === 'error') {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (status === 'disconnected') {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        statusBarItem.backgroundColor = undefined;
    }

    statusBarItem.show();
    mainWebviewProvider?.setSyncStatus(status, message);

    // Update collaborator status bar based on connection
    if (status === 'disconnected' || status === 'error') {
        collaboratorStatusItem.hide();
    }
}

/**
 * Update auth state and refresh UI
 */
async function setAuthState(state: AuthState, serverUrl?: string): Promise<void> {
    await updateAuthStatePresentation(state, serverUrl);
    await refreshGui();
}

function createCredentialTooltip(
    credential: ServerCredential,
    expired: boolean,
): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(expired ? '**Session Expired**\n\n' : '**Logged in to Overleaf**\n\n');
    tooltip.appendText(`Email: ${credential.userEmail}`);
    tooltip.appendMarkdown('\n\n');
    tooltip.appendText(`Server: ${credential.serverUrl}`);
    if (expired) {
        tooltip.appendMarkdown('\n\n_Click to refresh your cookie_');
    }
    return tooltip;
}

/** Update account/status UI without recursively refreshing the Projects view. */
async function updateAuthStatePresentation(state: AuthState, serverUrl?: string): Promise<void> {
    const generation = ++authPresentationGeneration;
    const resolvedServer = serverUrl ? validateServerUrl(serverUrl).url : await resolveActiveServerUrl();
    if (deactivating || generation !== authPresentationGeneration) return;
    authState = state;
    authStateServerUrl = state === 'none' ? undefined : resolvedServer;
    if (state === 'valid' || state === 'none') expiredSessionNotifications.delete(resolvedServer);
    await updateLoginStatus();
    if (credentialManager) {
        const accountState = await getAccountPanelState();
        if (!deactivating && generation === authPresentationGeneration) AccountPanel.updateIfOpen(accountState);
    }
}

function getAuthStateForServer(serverUrl: string, hasCredential: boolean): AuthState {
    if (!hasCredential) return 'none';
    return authStateServerUrl === serverUrl && authState !== 'none' ? authState : 'unknown';
}

/**
 * Update login status bar
 */
async function updateLoginStatus() {
    if (!loginStatusItem) return;
    const generation = ++loginStatusGeneration;
    // Only show login status if folder is linked
    const settingsManager = SettingsManager.getCurrentInstance();
    const linked = Boolean(settingsManager && await settingsManager.isLinked());
    const isCurrent = () => !deactivating && generation === loginStatusGeneration
        && settingsManager === SettingsManager.getCurrentInstance();
    if (!isCurrent()) return;
    if (!settingsManager || !linked) {
        loginStatusItem.hide();
        return;
    }

    const settings = settingsManager.getSettings() ?? await settingsManager.load();
    if (!isCurrent()) return;
    if (!settings) {
        loginStatusItem.hide();
        return;
    }
    const credential = await credentialManager.getCredential(settings.serverUrl);
    if (!isCurrent()) return;
    const serverAuthState = getAuthStateForServer(settings.serverUrl, Boolean(credential));

    if (credential && serverAuthState === 'valid') {
        // Logged in with valid session
        loginStatusItem.text = `$(account) ${credential.userEmail}`;
        loginStatusItem.tooltip = createCredentialTooltip(credential, false);
        loginStatusItem.backgroundColor = undefined;
        loginStatusItem.command = COMMANDS.SHOW_ACCOUNT_PANEL;
    } else if (credential && serverAuthState === 'expired') {
        // Session expired - show warning state
        loginStatusItem.text = `$(warning) ${credential.userEmail} (expired)`;
        loginStatusItem.tooltip = createCredentialTooltip(credential, true);
        loginStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        loginStatusItem.command = COMMANDS.SHOW_ACCOUNT_PANEL;
    } else if (credential) {
        // A stored credential is not considered valid until a request confirms it.
        loginStatusItem.text = `$(question) ${credential.userEmail} (not verified)`;
        loginStatusItem.tooltip = createCredentialTooltip(credential, false);
        loginStatusItem.backgroundColor = undefined;
        loginStatusItem.command = COMMANDS.SHOW_ACCOUNT_PANEL;
    } else {
        // Not logged in
        authState = 'none';
        authStateServerUrl = undefined;
        loginStatusItem.text = '$(account) Not logged in';
        loginStatusItem.tooltip = 'Click to login to Overleaf';
        loginStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        loginStatusItem.command = COMMANDS.SHOW_ACCOUNT_PANEL;
    }

    loginStatusItem.show();
}

/**
 * Show session expired notification with action buttons
 */
async function showSessionExpiredNotification(serverUrl?: string, force = false): Promise<void> {
    const server = await resolveActiveServerUrl(serverUrl);
    if (deactivating || (!force && expiredSessionNotifications.has(server))) return;
    expiredSessionNotifications.add(server);
    const action = await vscode.window.showWarningMessage(
        'LocalLeaf: Your Overleaf session has expired.',
        'Open Account',
        'Dismiss'
    );

    if (action === 'Open Account') {
        await vscode.commands.executeCommand(COMMANDS.SHOW_ACCOUNT_PANEL);
    }
}

/**
 * Update collaborator status bar
 */
function updateCollaboratorStatus() {
    if (!cursorTracker || !syncEngine || syncEngine.status === 'disconnected') {
        collaboratorStatusItem.hide();
        mainWebviewProvider?.setOnlineUsers([]);
        return;
    }

    const users = cursorTracker.getOnlineUsers();
    mainWebviewProvider?.setOnlineUsers(users.map(user => ({
        clientId: user.clientId,
        name: user.name,
        color: user.color,
        docPath: user.docPath,
        row: user.row,
    })));
    const count = users.length;

    if (count === 0) {
        collaboratorStatusItem.text = '$(person) 0';
        collaboratorStatusItem.tooltip = 'No collaborators online';
        collaboratorStatusItem.backgroundColor = undefined;
    } else {
        // Check if any user was recently active (within last 10 seconds)
        const now = Date.now();
        const recentlyActive = users.some(u => now - u.lastUpdated < 10000);

        collaboratorStatusItem.text = `$(organization) ${count}`;

        // Build tooltip with user list
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**${count} Collaborator${count > 1 ? 's' : ''} Online**\n\n`);

        for (const user of users) {
            const timeSince = formatTimeSince(now - user.lastUpdated);
            const location = user.docPath ? `at ${user.docPath}:${user.row + 1}` : '';
            tooltip.appendMarkdown('- ');
            tooltip.appendText(`${user.name} ${location} (${timeSince})`);
            tooltip.appendMarkdown('\n');
        }

        tooltip.appendMarkdown('\n*Click to jump to a collaborator*');
        collaboratorStatusItem.tooltip = tooltip;

        // Highlight if someone is active
        if (recentlyActive) {
            collaboratorStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        } else {
            collaboratorStatusItem.backgroundColor = undefined;
        }
    }

    collaboratorStatusItem.show();
}

/**
 * Format time since last activity
 */
function formatTimeSince(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
}

/**
 * Start periodic status updates
 */
function startStatusUpdates() {
    if (statusUpdateInterval) {
        clearInterval(statusUpdateInterval);
    }
    statusUpdateInterval = setInterval(() => {
        updateCollaboratorStatus();
    }, 1000);
}

/**
 * Stop periodic status updates
 */
function stopStatusUpdates() {
    if (statusUpdateInterval) {
        clearInterval(statusUpdateInterval);
        statusUpdateInterval = undefined;
    }
}

/**
 * Log to output channel
 */
function log(message: string) {
    const timestamp = new Date().toISOString();
    outputChannel.appendLine(`[${timestamp}] ${message}`);
}

/** Refresh whichever Activity Bar view is currently relevant. */
async function refreshGui(): Promise<void> {
    // Keep connection settings responsive while the project server is unavailable.
    if (credentialManager) AccountPanel.updateIfOpen(await getAccountPanelState());
    const manager = SettingsManager.getCurrentInstance();
    const linked = Boolean(manager && await manager.isLinked());
    if (linked) {
        await mainWebviewProvider?.refresh();
    } else {
        await projectsWebviewProvider?.refresh();
    }
    if (credentialManager) {
        AccountPanel.updateIfOpen(await getAccountPanelState());
    }
}

async function resolveActiveServerUrl(requestedServerUrl?: string): Promise<string> {
    if (requestedServerUrl) return validateServerUrl(requestedServerUrl).url;
    const manager = SettingsManager.getCurrentInstance();
    if (manager && await manager.isLinked() && !manager.getSettings()) {
        await manager.load();
    }
    return validateServerUrl(
        manager?.getSettings()?.serverUrl || credentialManager.getDefaultServer(),
    ).url;
}

async function getAccountPanelState(): Promise<AccountPanelState> {
    const serverUrl = accountPanelServerOverride || accountPanelSelectedServer || await resolveActiveServerUrl();
    const credential = await credentialManager.getCredential(serverUrl);
    return {
        serverUrl,
        loggedIn: Boolean(credential),
        authState: getAuthStateForServer(serverUrl, Boolean(credential)),
        userEmail: credential?.userEmail,
        operation: accountPanelOperation,
    };
}

async function setAccountPanelOperation(
    operation: AccountPanelOperation | undefined,
    serverUrl?: string,
): Promise<void> {
    if (operation && serverUrl) accountPanelServerOverride = validateServerUrl(serverUrl).url;
    if (!operation) accountPanelServerOverride = undefined;
    accountPanelOperation = operation;
    AccountPanel.updateIfOpen(await getAccountPanelState());
}

async function cmdShowAccountPanel(context: vscode.ExtensionContext, requestedServerUrl?: string): Promise<void> {
    accountPanelSelectedServer = requestedServerUrl ? validateServerUrl(requestedServerUrl).url : undefined;
    AccountPanel.createOrShow(
        context.extensionUri,
        await getAccountPanelState(),
        async action => {
            try {
                await handleAccountPanelAction(context, action);
            } catch (error) {
                void vscode.window.showErrorMessage(`LocalLeaf: Account action failed - ${errorMessage(error)}`);
            } finally {
                await refreshGui();
                await projectCreationController?.refreshAccount();
            }
        },
    );
}

async function handleAccountPanelAction(
    context: vscode.ExtensionContext,
    action: AccountPanelAction,
): Promise<void> {
    if (action.type === 'cancelLogin') {
        activeBrowserLogin?.abort();
        return;
    }
    if (action.type === 'openTutorial') {
        await vscode.env.openExternal(vscode.Uri.parse(
            'https://github.com/overleaf-workshop/Overleaf-Workshop/blob/master/docs/wiki.md#login-with-cookies'
        ));
        return;
    }
    if (accountActionInProgress) {
        void vscode.window.showInformationMessage('LocalLeaf: An account operation is already in progress.');
        return;
    }

    accountActionInProgress = true;
    try {
        switch (action.type) {
            case 'selectServer':
                accountPanelSelectedServer = await selectDefaultServer(action.serverUrl);
                break;
            case 'loginBrowser':
                await loginViaBrowserAndStore(context, action.serverUrl, action.browserPreference);
                break;
            case 'loginCookies':
                await setAccountPanelOperation({
                    kind: 'cookieLogin',
                    message: 'Validating the supplied Overleaf session...',
                    cancellable: false,
                }, action.serverUrl);
                if (await loginWithCookies(action.serverUrl, action.cookies)) {
                    await reconnectAfterLogin(context);
                }
                break;
            case 'verifySession':
                await verifyCredentialsForServer(action.serverUrl);
                break;
            case 'logout':
                // Pin the target before the first await. The active workspace or
                // default server may change while the confirmation dialog is open.
                const serverUrl = validateServerUrl(action.serverUrl).url;
                await setAccountPanelOperation({
                    kind: 'logout',
                    message: 'Removing the stored Overleaf session...',
                    cancellable: false,
                }, serverUrl);
                await cmdLogout(serverUrl);
                break;
        }
    } finally {
        accountActionInProgress = false;
        await setAccountPanelOperation(undefined);
    }
}

async function loginViaBrowserAndStore(
    context: vscode.ExtensionContext,
    serverUrl: string,
    browserPreference: BrowserPreference,
): Promise<boolean> {
    const task = performBrowserLoginAndStore(context, serverUrl, browserPreference);
    activeBrowserLoginTask = task;
    try {
        return await task;
    } finally {
        if (activeBrowserLoginTask === task) activeBrowserLoginTask = undefined;
    }
}

async function performBrowserLoginAndStore(
    context: vscode.ExtensionContext,
    serverUrl: string,
    browserPreference: BrowserPreference,
): Promise<boolean> {
    if (deactivating) return false;
    const server = validateServerUrl(serverUrl);
    if (vscode.env.remoteName) {
        void vscode.window.showWarningMessage(
            `LocalLeaf: Browser login is unavailable in ${vscode.env.remoteName}. Use the manual cookie option in the Account panel instead.`,
        );
        return false;
    }
    if (!(await confirmInsecureServer(server, 'Overleaf session')) || deactivating) return false;

    const controller = new AbortController();
    activeBrowserLogin = controller;
    await setAccountPanelOperation({
        kind: 'browserLogin',
        message: 'Opening an isolated browser and waiting for you to sign in...',
        cancellable: true,
    }, server.url);

    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'LocalLeaf: Waiting for browser login...',
            cancellable: true,
        }, async (_progress, token) => {
            const cancellation = token.onCancellationRequested(() => controller.abort());
            try {
                return await captureCookiesViaBrowserLogin(server.url, browserPreference, {
                    signal: controller.signal,
                    log,
                    onCleanupFailure: profilePath => {
                        if (deactivating) return;
                        void vscode.window.showWarningMessage(
                            `LocalLeaf could not remove its isolated browser profile. Close any leftover browser window and delete: ${profilePath}`,
                        );
                    },
                });
            } finally {
                cancellation.dispose();
            }
        });

        if (result.type === 'cancelled') {
            void vscode.window.showInformationMessage('LocalLeaf: Browser login cancelled.');
            return false;
        }
        if (result.type === 'error') {
            void vscode.window.showErrorMessage(`LocalLeaf: Browser login failed - ${result.message}`);
            return false;
        }
        if (deactivating) return false;

        await setAccountPanelOperation({
            kind: 'browserLogin',
            message: 'Login detected. Validating and storing the Overleaf session...',
            cancellable: false,
        });
        if (!(await loginWithCookies(server.url, result.cookies, true))) return false;
        await reconnectAfterLogin(context);
        return true;
    } finally {
        if (activeBrowserLogin === controller) activeBrowserLogin = undefined;
    }
}

async function reconnectAfterLogin(context: vscode.ExtensionContext): Promise<void> {
    if (deactivating) return;
    const manager = SettingsManager.getCurrentInstance();
    if (!manager) return;
    const linked = await manager.isLinked();
    if (deactivating || manager !== SettingsManager.getCurrentInstance() || !linked) return;
    await cmdReconnect(context);
}

async function confirmInsecureServer(server: ValidatedServerUrl, secretDescription: string): Promise<boolean> {
    if (server.parsed.protocol !== 'http:') return true;
    const continueAction = 'Continue with HTTP';
    const choice = await vscode.window.showWarningMessage(
        `LocalLeaf: This server uses unencrypted HTTP. Your ${secretDescription} could be intercepted.`,
        {
            modal: true,
            detail: `Server: ${server.parsed.origin}\n\nContinue only if you trust this server and network.`,
        },
        continueAction,
    );
    return choice === continueAction;
}

async function loginWithCookies(
    serverUrl: string,
    cookies: string,
    skipInsecureConfirmation = false,
): Promise<boolean> {
    const server = validateServerUrl(serverUrl);
    const normalizedServer = server.url;
    if (!skipInsecureConfirmation && !(await confirmInsecureServer(server, 'Overleaf session cookie'))) return false;

    const api = new BaseAPI(normalizedServer);
    let result: Awaited<ReturnType<BaseAPI['cookiesLogin']>>;
    try {
        result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'LocalLeaf: Validating Overleaf cookies...',
            cancellable: false,
        }, () => api.cookiesLogin(cookies));
    } finally {
        api.dispose();
    }

    if (result.type !== 'success' || !result.userInfo || !result.identity) {
        throw new Error(result.message || 'Cookie validation failed.');
    }
    if (deactivating) return false;

    await credentialManager.storeCredential({
        serverUrl: normalizedServer,
        userId: result.userInfo.userId,
        userEmail: result.userInfo.userEmail,
        identity: result.identity,
    });
    await vscode.workspace.getConfiguration('localleaf').update(
        'defaultServer',
        normalizedServer,
        vscode.ConfigurationTarget.Global,
    );
    await setAuthState('valid', normalizedServer);
    void vscode.window.showInformationMessage(`LocalLeaf: Logged in as ${result.userInfo.userEmail}`);
    return true;
}

// === Command Implementations ===

async function chooseWorkspaceFolder(): Promise<vscode.Uri | undefined> {
    const folders = (vscode.workspace.workspaceFolders ?? [])
        .filter(folder => folder.uri.scheme === 'file');
    if (folders.length === 0) return undefined;

    const current = SettingsManager.getCurrentInstance()?.getWorkspaceFolder();
    if (current && folders.some(folder => folder.uri.toString() === current.toString())) return current;

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    if (activeFolder?.uri.scheme === 'file') return activeFolder.uri;
    if (folders.length === 1) return folders[0].uri;

    const selection = await vscode.window.showQuickPick(
        folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, uri: folder.uri })),
        { placeHolder: 'Select the local folder for this LocalLeaf project' },
    );
    return selection?.uri;
}

/**
 * Logout from Overleaf
 */
async function cmdLogout(requestedServerUrl: string): Promise<void> {
    // Normalize once, before displaying the prompt, so every subsequent action
    // applies to the credential the user actually chose to remove.
    const serverUrl = validateServerUrl(requestedServerUrl).url;
    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to logout from ${serverUrl}?`,
        'Logout',
        'Cancel'
    );

    if (confirm !== 'Logout') return;

    // Removing a secondary server's account must not interrupt synchronization
    // with the server selected by the active workspace.
    const activeServer = SettingsManager.getCurrentInstance()?.getSettings()?.serverUrl;
    if (activeServer === serverUrl) disposeCurrentSyncSession();
    await credentialManager.deleteCredential(serverUrl);
    if (!syncEngine && SettingsManager.getCurrentInstance()?.getSettings()?.serverUrl === serverUrl) {
        updateStatusBar('disconnected', 'Logged out');
    }
    if (authStateServerUrl === serverUrl) await setAuthState('none', serverUrl);
    else await refreshGui();
    void vscode.window.showInformationMessage('LocalLeaf: Logged out');
}

async function cmdLogoutFromCommand(): Promise<void> {
    if (accountActionInProgress) {
        void vscode.window.showInformationMessage(
            'LocalLeaf: Finish or cancel the current account operation before logging out.',
        );
        return;
    }
    // Capture the cached project/default target synchronously. In particular,
    // do not re-resolve it after the Account panel update or confirmation await.
    const serverUrl = validateServerUrl(
        SettingsManager.getCurrentInstance()?.getSettings()?.serverUrl
            || credentialManager.getDefaultServer(),
    ).url;
    accountActionInProgress = true;
    try {
        await setAccountPanelOperation({
            kind: 'logout',
            message: 'Removing the stored Overleaf session...',
            cancellable: false,
        }, serverUrl);
        await cmdLogout(serverUrl);
    } finally {
        accountActionInProgress = false;
        await setAccountPanelOperation(undefined);
    }
}

/** Open the complete creation form; side effects start only on its Create action. */
async function cmdCreateProject(context: vscode.ExtensionContext): Promise<void> {
    if (deactivating) return;
    projectCreationController ??= new CreateProjectController(context, credentialManager, {
        gate: linkOperationGate,
        log,
        signIn: serverUrl => cmdShowAccountPanel(context, serverUrl),
        refreshViews: refreshGui,
        onLocalSetupStart: folder => { projectCreationLocalFolders.add(folder.toString()); },
        onLocalSetupFinish: async (folder, settings) => {
            projectCreationLocalFolders.delete(folder.toString());
            if (deactivating || !settings) return;
            const current = SettingsManager.getCurrentInstance();
            if (current?.getWorkspaceFolder().toString() !== folder.toString()) return;
            await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', true);
            if (deactivating || current !== SettingsManager.getCurrentInstance()) return;
            configureSettingsWatcher(context, folder);
            statusBarItem.show();
            await initializeSync(context, settings);
        },
    });
    await projectCreationController.show();
}

/**
 * Link current folder to an Overleaf project
 */
async function cmdLinkFolder(context: vscode.ExtensionContext, requestedProject?: unknown,
    requestedServerUrl?: string, requestedWorkspaceFolder?: vscode.Uri) {
    if (!linkOperationGate.tryEnter()) {
        void vscode.window.showInformationMessage('LocalLeaf: A project link is already in progress');
        return;
    }

    try {
        if (requestedWorkspaceFolder && !vscode.workspace.workspaceFolders?.some(folder =>
            folder.uri.toString() === requestedWorkspaceFolder.toString())) {
            void vscode.window.showInformationMessage('LocalLeaf: The original folder is no longer open. Link the created project from its folder.');
            return;
        }
        const workspaceFolder = requestedWorkspaceFolder ?? await chooseWorkspaceFolder();
        if (!workspaceFolder) {
            void vscode.window.showErrorMessage('LocalLeaf: No workspace folder open');
            return;
        }

        const settingsManager = SettingsManager.getInstance(workspaceFolder);
        if (await settingsManager.isLinked()) {
            void vscode.window.showWarningMessage(
                'LocalLeaf: This folder is already linked. Unlink it before choosing another project.'
            );
            return;
        }

        // Get server URL
        const serverUrl = requestedServerUrl ? validateServerUrl(requestedServerUrl).url : credentialManager.getDefaultServer();

        // Check if logged in
        const credential = await credentialManager.getCredential(serverUrl);
        if (!credential) {
            void vscode.window.showWarningMessage('LocalLeaf: Please login first');
            await cmdShowAccountPanel(context);
            return;
        }

        // Commands are a public extension boundary. Resolve even a webview
        // selection against a fresh authenticated list and use only that
        // canonical server object.
        const api = new BaseAPI(serverUrl);
        api.setIdentity(credential.identity);
        let projectsResult: Awaited<ReturnType<BaseAPI['getProjects']>>;
        try {
            projectsResult = await api.getProjects();
        } finally {
            api.dispose();
        }
        if (projectsResult.type !== 'success' || !projectsResult.projects) {
            void vscode.window.showErrorMessage(`LocalLeaf: Failed to get projects - ${projectsResult.message}`);
            return;
        }

        const activeProjects = projectsResult.projects.filter(p => !p.archived && !p.trashed);
        let project: ProjectInfo | undefined;
        if (requestedProject !== undefined) {
            project = resolveRequestedProject(activeProjects, requestedProject);
            if (!project) {
                void vscode.window.showErrorMessage(
                    'LocalLeaf: The requested project is not available for the authenticated account.'
                );
                return;
            }
        } else {
            const items = activeProjects.map(p => ({
                label: p.name,
                description: `${p.accessLevel}${p.lastUpdated ? ` - ${new Date(p.lastUpdated).toLocaleDateString()}` : ''}`,
                project: p,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select an Overleaf project to link',
            });
            if (!selected) return;
            project = selected.project;
        }

        const workspaceEntries = await vscode.workspace.fs.readDirectory(workspaceFolder);
        const containsExistingContent = shouldConfirmProjectLink(
            workspaceEntries.map(([name]) => name)
        );
        const confirmation = await vscode.window.showWarningMessage(
            `Link this folder to "${project.name}" and allow synchronization?`,
            {
                modal: true,
                detail: [
                    `Folder: ${workspaceFolder.fsPath}`,
                    `Server: ${serverUrl}`,
                    `Project: ${project.name}`,
                    '',
                    containsExistingContent
                        ? 'LocalLeaf will compare existing files with Overleaf and ask before resolving content conflicts.'
                        : 'Remote project files can be downloaded into this folder.',
                    'Saved local changes can be uploaded to Overleaf.',
                ].join('\n'),
            },
            'Link and Synchronize',
        );
        if (confirmation !== 'Link and Synchronize') return;

        // A confirmation may outlive the original workspace or another link.
        if (deactivating || !vscode.workspace.workspaceFolders?.some(folder =>
            folder.uri.toString() === workspaceFolder.toString())) return;
        if (await settingsManager.isLinked()) {
            void vscode.window.showWarningMessage('LocalLeaf: This folder was linked while the dialog was open. Its project was kept.');
            return;
        }
        if (deactivating || !vscode.workspace.workspaceFolders?.some(folder =>
            folder.uri.toString() === workspaceFolder.toString())) return;

        // Create settings
        const settings = SettingsManager.createDefaultSettings(serverUrl, project.id, project.name);
        await settingsManager.save(settings);
        SettingsManager.setCurrentWorkspaceFolder(workspaceFolder);
        await grantSyncAuthorization(context, settingsManager);

        // Create default .leafignore
        const ignoreParser = new IgnoreParser(workspaceFolder);
        if (!(await ignoreParser.exists())) {
            await ignoreParser.createDefault();
        }

        void vscode.window.showInformationMessage(`LocalLeaf: Linked to "${project.name}"`);

        // Show status bars now that we're linked
        await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', true);
        configureSettingsWatcher(context, workspaceFolder);
        statusBarItem.show();
        await updateLoginStatus();
        await mainWebviewProvider.refresh();

        // Initialize sync (this will auto-pull)
        await initializeSync(context, settingsManager);
        await refreshGui();
    } finally {
        linkOperationGate.leave();
    }
}

/**
 * Unlink current folder
 */
async function cmdUnlinkFolder(confirmation?: object) {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        void vscode.window.showInformationMessage('LocalLeaf: This folder is not linked');
        return;
    }
    const unlinkSyncKey = getSyncKey(settingsManager);

    if (confirmation !== panelConfirmation) {
        const confirm = await vscode.window.showWarningMessage(
            'Are you sure you want to unlink this folder from Overleaf?',
            { modal: true },
            'Unlink'
        );

        if (confirm !== 'Unlink') return;
    }

    if (
        deactivating || settingsManager !== SettingsManager.getCurrentInstance()
        || getSyncKey(settingsManager) !== unlinkSyncKey
    ) return;

    disposeCurrentSyncSession();

    // Delete settings
    await revokeSyncAuthorization(extensionContext, settingsManager);
    await settingsManager.delete();

    mainWebviewProvider.setOnlineUsers([]);
    await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', false);
    statusBarItem.hide();
    collaboratorStatusItem.hide();
    await updateLoginStatus();
    await refreshGui();
    void vscode.window.showInformationMessage('LocalLeaf: Folder unlinked');
}

/**
 * Sync now (bidirectional)
 */
async function cmdSyncNow() {
    // pullAll reconciles both sides against the saved common revision.
    await cmdPullFromOverleaf();
}

/**
 * Pull from Overleaf
 */
async function cmdPullFromOverleaf() {
    if (!syncEngine || syncEngine.needsInitialization) {
        await cmdReconnect(extensionContext);
        return;
    }

    const engine = syncEngine;
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'LocalLeaf: Pulling from Overleaf...',
            cancellable: false,
        }, async () => {
            await engine.pullAll();
            if (deactivating || syncEngine !== engine) return;
            await engine.joinAllDocsForWatching();
        });
        if (deactivating || syncEngine !== engine) return;
        void vscode.window.showInformationMessage('LocalLeaf: Pull complete');
    } catch (error) {
        if (deactivating || syncEngine !== engine) return;
        void vscode.window.showErrorMessage(`LocalLeaf: Pull failed - ${error}`);
    }
}

/**
 * Push to Overleaf
 */
async function cmdPushToOverleaf() {
    if (!syncEngine) {
        void vscode.window.showWarningMessage('LocalLeaf: Not connected. Please link a folder first.');
        return;
    }

    void vscode.window.showInformationMessage(syncEngine.automaticSyncEnabled
        ? 'LocalLeaf: Push is automatic via real-time sync'
        : 'LocalLeaf: Automatic local push is disabled. Run Sync Now to review and upload local changes.');
}

interface LatexCommentEditCandidate {
    document: vscode.TextDocument;
    originalContent: string;
    cleanedContent: string;
    removedLines: number;
    removedBlocks: number;
    version: number;
    displayPath: string;
}

const MAX_COMMENT_CLEANUP_FILES = 500;
const MAX_COMMENT_CLEANUP_BYTES = 50 * 1024 * 1024;

/**
 * Remove only standalone LaTeX comments after a dry run and an explicit
 * confirmation. A single WorkspaceEdit keeps the operation in VS Code's Undo
 * history and preserves unsaved editor content.
 */
async function cmdRemoveComments(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage('LocalLeaf: Trust this workspace before editing LaTeX files.');
        return;
    }

    const workspaceFolder = SettingsManager.getCurrentInstance()?.getWorkspaceFolder()
        ?? await chooseWorkspaceFolder();
    if (!workspaceFolder) {
        void vscode.window.showWarningMessage('LocalLeaf: No workspace folder is available.');
        return;
    }

    try {
        const texFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceFolder, '**/*.tex'),
            new vscode.RelativePattern(workspaceFolder, '**/{.git,.localleaf,node_modules}/**'),
            MAX_COMMENT_CLEANUP_FILES + 1,
        );
        if (texFiles.length > MAX_COMMENT_CLEANUP_FILES) {
            throw new Error(
                `More than ${MAX_COMMENT_CLEANUP_FILES} .tex files matched; narrow the workspace before cleanup.`,
            );
        }

        const candidates: LatexCommentEditCandidate[] = [];
        let inspectedBytes = 0;
        for (const uri of texFiles) {
            await assertSafeWorkspacePath(workspaceFolder, uri);
            const document = await vscode.workspace.openTextDocument(uri);
            const originalContent = document.getText();
            inspectedBytes += Buffer.byteLength(originalContent, 'utf8');
            if (inspectedBytes > MAX_COMMENT_CLEANUP_BYTES) {
                throw new Error('Matched LaTeX sources exceed the 50 MiB safety limit.');
            }

            const removal = removeStandaloneLatexComments(originalContent);
            if (removal.content === originalContent) continue;
            candidates.push({
                document,
                originalContent,
                cleanedContent: removal.content,
                removedLines: removal.removedLines,
                removedBlocks: removal.removedBlocks,
                version: document.version,
                displayPath: vscode.workspace.asRelativePath(uri, false),
            });
        }

        if (candidates.length === 0) {
            void vscode.window.showInformationMessage('LocalLeaf: No standalone LaTeX comments were found.');
            return;
        }

        const removedLines = candidates.reduce((total, candidate) => total + candidate.removedLines, 0);
        const removedBlocks = candidates.reduce((total, candidate) => total + candidate.removedBlocks, 0);
        const visibleFiles = candidates.slice(0, 12)
            .map(candidate => `${candidate.displayPath}: ${candidate.removedLines} line(s)`);
        if (candidates.length > visibleFiles.length) {
            visibleFiles.push(`... and ${candidates.length - visibleFiles.length} more file(s)`);
        }

        const confirmation = await vscode.window.showWarningMessage(
            `Remove ${removedLines} standalone comment line(s) from ${candidates.length} LaTeX file(s)?`,
            {
                modal: true,
                detail: [
                    ...visibleFiles,
                    '',
                    `${removedBlocks} complete comment environment(s) are included.`,
                    'Inline comments and verbatim-like environments are intentionally preserved.',
                    'The changes are applied through VS Code and can be undone before saving.',
                ].join('\n'),
            },
            'Remove Standalone Comments',
        );
        if (confirmation !== 'Remove Standalone Comments') return;

        const changedWhileConfirming = candidates.find(candidate =>
            candidate.document.version !== candidate.version
            || candidate.document.getText() !== candidate.originalContent
        );
        if (changedWhileConfirming) {
            void vscode.window.showWarningMessage(
                `LocalLeaf: ${changedWhileConfirming.displayPath} changed during confirmation; no comments were removed.`,
            );
            return;
        }

        const edit = new vscode.WorkspaceEdit();
        for (const candidate of candidates) {
            edit.replace(
                candidate.document.uri,
                new vscode.Range(
                    candidate.document.positionAt(0),
                    candidate.document.positionAt(candidate.originalContent.length),
                ),
                candidate.cleanedContent,
            );
        }
        if (!(await vscode.workspace.applyEdit(edit))) {
            throw new Error('VS Code rejected the workspace edit.');
        }

        void vscode.window.showInformationMessage(
            `LocalLeaf: Removed ${removedLines} standalone comment line(s) from ${candidates.length} file(s).`,
        );
    } catch (error) {
        log(`Remove standalone comments failed: ${errorMessage(error)}`);
        void vscode.window.showErrorMessage(
            `LocalLeaf: Remove comments failed - ${errorMessage(error)}`,
        );
    }
}

/**
 * Edit ignore patterns
 */
async function cmdEditIgnorePatterns() {
    const workspaceFolder = SettingsManager.getCurrentInstance()?.getWorkspaceFolder()
        ?? await chooseWorkspaceFolder();
    if (!workspaceFolder) {
        void vscode.window.showErrorMessage('LocalLeaf: No workspace folder open');
        return;
    }

    const ignoreFile = vscode.Uri.joinPath(workspaceFolder, IGNORE_FILE);

    // Create default if doesn't exist
    const ignoreParser = new IgnoreParser(workspaceFolder);
    if (!(await ignoreParser.exists())) {
        await ignoreParser.createDefault();
    }

    await vscode.window.showTextDocument(ignoreFile);
}

/**
 * Preview ignored and remote-only entries before deleting the selected targets.
 */
async function cmdCleanIgnoredRemoteFiles() {
    if (!syncEngine) {
        void vscode.window.showWarningMessage('LocalLeaf: Not connected. Please link a folder first.');
        return;
    }

    const engine = syncEngine;
    try {
        const candidates = await engine.getRemoteCleanupCandidates();
        if (syncEngine !== engine || deactivating) return;
        if (candidates.length === 0) {
            void vscode.window.showInformationMessage('LocalLeaf: No ignored or remote-only entries exist on Overleaf.');
            return;
        }

        const selected = await vscode.window.showQuickPick(candidates.map(candidate => ({
            label: candidate.path,
            description: candidate.reason === 'ignored'
                ? (candidate.type === 'folder' ? 'Ignored folder and its contents' : 'Ignored by .leafignore')
                : 'Exists only on Overleaf',
            picked: candidate.reason === 'ignored',
            candidate,
        })), {
            title: 'Delete selected files and folders from Overleaf',
            placeHolder: 'Select entries to delete, then press Enter. Local files are kept.',
            canPickMany: true,
            matchOnDescription: true,
            ignoreFocusOut: true,
        });
        if (!selected?.length || syncEngine !== engine || deactivating) return;

        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'LocalLeaf: Cleaning selected entries from Overleaf...',
            cancellable: false,
        }, () => engine.deleteRemoteCleanupCandidates(selected.map(item => item.candidate)));
        if (syncEngine !== engine || deactivating) return;

        if (result.failed.length > 0) {
            const failedPreview = result.failed
                .slice(0, 5)
                .map(item => item.path)
                .join(', ');
            void vscode.window.showWarningMessage(
                `LocalLeaf: Deleted ${result.deleted} selected entry/entries; ` +
                `${result.failed.length} failed: ${failedPreview}`
            );
        } else {
            void vscode.window.showInformationMessage(
                `LocalLeaf: Deleted ${result.deleted} selected entry/entries from Overleaf.`
                + (result.skipped ? ` ${result.skipped} skipped because they changed after the preview.` : '')
            );
        }
    } catch (error) {
        if (syncEngine !== engine || deactivating) return;
        void vscode.window.showErrorMessage(`LocalLeaf: Cleanup failed - ${errorMessage(error)}`);
    }
}

/**
 * Show sync status
 */
async function cmdShowSyncStatus(context: vscode.ExtensionContext) {
    const settingsManager = SettingsManager.getCurrentInstance();
    const settings = settingsManager?.getSettings();
    const statusServerUrl = settings ? validateServerUrl(settings.serverUrl).url : undefined;
    const statusCredential = statusServerUrl
        ? await credentialManager.getCredential(statusServerUrl)
        : undefined;
    const statusAuthState = statusServerUrl
        ? getAuthStateForServer(statusServerUrl, Boolean(statusCredential))
        : 'none';

    const items: vscode.QuickPickItem[] = [];
    const currentStatus = syncEngine?.status || 'disconnected';

    if (settings) {
        items.push({
            label: '$(project) Project',
            description: settings.projectName,
            detail: settings.projectId,
        });
        items.push({
            label: '$(globe) Server',
            description: settings.serverUrl,
        });
        items.push({
            label: '$(sync) Status',
            description: currentStatus,
        });
        if (cursorTracker) {
            items.push({
                label: '$(organization) Collaborators',
                description: `${cursorTracker.getUserCount()} online`,
            });
        }
        if (settings.lastSynced) {
            items.push({
                label: '$(clock) Last Synced',
                description: new Date(settings.lastSynced).toLocaleString(),
            });
        }
    } else {
        items.push({
            label: '$(info) Not linked',
            description: 'Use "LocalLeaf: Link Folder" to connect to Overleaf',
        });
    }

    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

    // Show resync option when there's an error or when connected
    if (settings && (currentStatus === 'error' || currentStatus === 'idle')) {
        items.push({
            label: '$(sync) Resync with Overleaf',
            description: currentStatus === 'error' ? 'Retry after error' : 'Pull latest changes',
        });
    }

    // Show reconnect option when disconnected
    if (settings && currentStatus === 'disconnected') {
        items.push({
            label: '$(debug-disconnect) Reconnect',
            description: 'Reconnect to Overleaf',
        });
    }

    // Show refresh cookie option when auth is expired
    if (settings && statusAuthState === 'expired') {
        items.push({
            label: '$(key) Re-authenticate',
            description: 'Open the Account panel and replace the expired session',
        });
    }

    // Show verify credentials option when connected
    if (settings && statusCredential && statusAuthState !== 'expired') {
        items.push({
            label: '$(shield) Verify Credentials',
            description: 'Check if your session is still valid',
        });
    }

    if (cursorTracker && cursorTracker.getUserCount() > 0) {
        items.push({
            label: '$(person) Jump to collaborator...',
            description: '',
        });
    }

    if (settings) {
        items.push({
            label: '$(link-external) Unlink folder',
            description: 'Disconnect from Overleaf project',
        });
    }

    const selected = await vscode.window.showQuickPick(items, {
        title: 'LocalLeaf Status',
    });

    if (selected?.label.includes('Resync')) {
        await cmdPullFromOverleaf();
    } else if (selected?.label.includes('Reconnect')) {
        await cmdReconnect(context);
    } else if (selected?.label.includes('Re-authenticate')) {
        await cmdRefreshCookie();
    } else if (selected?.label.includes('Verify Credentials')) {
        await cmdVerifyCredentials();
    } else if (selected?.label.includes('Jump to collaborator')) {
        await cursorTracker?.jumpToUser();
    } else if (selected?.label.includes('Unlink folder')) {
        await cmdUnlinkFolder();
    }
}

/**
 * Reconnect to Overleaf (after disconnect or error)
 */
async function cmdReconnect(context: vscode.ExtensionContext) {
    if (deactivating) return;
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager) {
        void vscode.window.showWarningMessage('LocalLeaf: No linked project');
        return;
    }

    const linked = await settingsManager.isLinked();
    if (deactivating || settingsManager !== SettingsManager.getCurrentInstance()) return;
    if (!linked) {
        void vscode.window.showWarningMessage('LocalLeaf: No linked project');
        return;
    }

    if (!settingsManager.getSettings()) await settingsManager.load();
    if (deactivating || settingsManager !== SettingsManager.getCurrentInstance()) return;
    await initializeSync(context, settingsManager);
}

/**
 * Set main document
 */
async function cmdSetMainDocument() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        void vscode.window.showErrorMessage('LocalLeaf: No linked project');
        return;
    }

    const mainTex = await vscode.window.showInputBox({
        prompt: 'Enter main TeX file name',
        value: settingsManager.getSettings()?.mainTex || '',
        placeHolder: 'path/to/document.tex',
    });

    if (!mainTex) return;

    let canonicalMainTex: string;
    try {
        const projectPath = normalizeProjectPath(mainTex, false);
        if (projectPath.endsWith('/') || !projectPath.toLowerCase().endsWith('.tex')) {
            throw new Error('The main document must be a .tex file.');
        }
        const mainDocumentUri = settingsManager.getFilePath(projectPath);
        await assertSafeWorkspacePath(settingsManager.getWorkspaceFolder(), mainDocumentUri);
        const stat = await vscode.workspace.fs.stat(mainDocumentUri);
        if ((stat.type & vscode.FileType.File) === 0) {
            throw new Error('The selected main document is not a file.');
        }
        canonicalMainTex = projectPath.slice(1);
    } catch (error) {
        void vscode.window.showErrorMessage(`LocalLeaf: Invalid main document - ${error}`);
        return;
    }

    const mainPdf = canonicalMainTex.replace(/\.tex$/i, '.pdf');

    await settingsManager.update({ mainTex: canonicalMainTex, mainPdf });
    await mainWebviewProvider.refresh();
    void vscode.window.showInformationMessage(`LocalLeaf: Main document set to ${canonicalMainTex}`);
}

/**
 * Configure settings
 */
async function cmdConfigure() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        void vscode.window.showInformationMessage('LocalLeaf: No linked project');
        return;
    }

    const workspaceFolder = settingsManager.getWorkspaceFolder();
    const settingsFile = vscode.Uri.joinPath(workspaceFolder, CONFIG_DIR, 'settings.json');
    await assertSafeWorkspacePath(workspaceFolder, settingsFile);
    await vscode.window.showTextDocument(settingsFile);
}

/**
 * Jump to collaborator cursor
 */
async function cmdJumpToCollaborator(clientId?: string) {
    if (!cursorTracker) {
        void vscode.window.showWarningMessage('LocalLeaf: Not connected');
        return;
    }

    await cursorTracker.jumpToUser(clientId);
}

/**
 * Verify credentials are still valid
 */
async function verifyCredentialsForServer(requestedServerUrl?: string): Promise<boolean> {
    const serverUrl = await resolveActiveServerUrl(requestedServerUrl);
    const credential = await credentialManager.getCredential(serverUrl);
    if (!credential) {
        await setAuthState('none', serverUrl);
        void vscode.window.showWarningMessage('LocalLeaf: Not logged in');
        return false;
    }

    await setAccountPanelOperation({
        kind: 'verifySession',
        message: 'Checking the stored Overleaf session...',
        cancellable: false,
    }, serverUrl);
    const api = new BaseAPI(serverUrl);
    api.setIdentity(credential.identity);

    let result: Awaited<ReturnType<BaseAPI['verifyCredentials']>>;
    try {
        result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'LocalLeaf: Verifying credentials...',
        }, () => api.verifyCredentials());
    } catch (error) {
        void vscode.window.showErrorMessage(
            `LocalLeaf: Could not verify the session - ${errorMessage(error)}. The stored session was not changed.`,
        );
        return false;
    } finally {
        api.dispose();
    }

    if (result.type === 'success') {
        await setAuthState('valid', serverUrl);
        void vscode.window.showInformationMessage('LocalLeaf: Credentials are valid');
        return true;
    } else if (result.authError === 'session_expired' || result.authError === 'invalid_credentials') {
        await setAuthState('expired', serverUrl);
        void showSessionExpiredNotification(serverUrl, true).catch(error => {
            log(`Could not show the expired-session notification: ${errorMessage(error)}`);
        });
        return false;
    }

    void vscode.window.showErrorMessage(
        `LocalLeaf: Could not verify the session - ${result.message || 'Overleaf returned an unexpected response'}. `
        + 'The stored session was not changed.',
    );
    return false;
}

async function cmdVerifyCredentials(): Promise<void> {
    if (accountActionInProgress) {
        void vscode.window.showInformationMessage(
            'LocalLeaf: Finish or cancel the current account operation before verifying the session.',
        );
        return;
    }
    accountActionInProgress = true;
    try {
        await verifyCredentialsForServer();
    } finally {
        accountActionInProgress = false;
        await setAccountPanelOperation(undefined);
    }
}

/**
 * Refresh cookie (re-login without clearing stored info)
 */
async function cmdRefreshCookie() {
    await vscode.commands.executeCommand(COMMANDS.SHOW_ACCOUNT_PANEL);
}

/**
 * Extension deactivation
 */
async function waitForBrowserLoginCleanup(task: Promise<unknown>, timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            task.then(() => undefined, () => undefined),
            new Promise<void>(resolve => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export async function deactivate(): Promise<void> {
    deactivating = true;
    projectCreationController?.dispose();
    projectCreationController = undefined;
    projectCreationLocalFolders.clear();
    workspaceChangeGeneration++;
    settingsWatcherGeneration++;
    authPresentationGeneration++;
    loginStatusGeneration++;
    activeBrowserLogin?.abort();
    activeBrowserLogin = undefined;
    settingsWatcher?.dispose();
    settingsWatcher = undefined;
    disposeCurrentSyncSession();
    const browserLoginTask = activeBrowserLoginTask;
    if (browserLoginTask) await waitForBrowserLoginCleanup(browserLoginTask, 12_000);
    activeBrowserLoginTask = undefined;
}
