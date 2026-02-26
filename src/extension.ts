/**
 * LocalLeaf VS Code Extension
 * Local sync for Overleaf LaTeX projects
 */

import * as vscode from 'vscode';
import { COMMANDS, EXTENSION_NAME, STATUS_BAR_PRIORITY, CONFIG_DIR, IGNORE_FILE } from './consts';
import { CredentialManager, ServerCredential, Identity } from './utils/credentialManager';
import { SettingsManager, createSettingsWatcher } from './utils/settingsManager';
import { BaseAPI, ProjectInfo } from './api/base';
import { SyncEngine, SyncStatus } from './sync/syncEngine';
import { IgnoreParser } from './sync/ignoreParser';
import { SyncMode } from './sync/changeTracker';
import { CursorTracker, TrackedUser } from './collaboration/cursorTracker';
import { setOutputChannel } from './api/socketio';
import { ProjectsProvider, ChangesProvider, DetailsProvider, syncStatusDescription } from './views/sidebarProvider';
import { LatexCompiler, CompilerType, CompilationResult } from './compilation/latexCompiler';
import * as path from 'path';
import { AutoCompiler } from './compilation/autoCompiler';
import { PdfPreviewPanel } from './views/pdfPreviewPanel';

/**
 * Auth state type
 */
type AuthState = 'valid' | 'expired' | 'none';

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
let authState: AuthState = 'none';
let projectsProvider: ProjectsProvider;
let changesProvider: ChangesProvider;
let detailsProvider: DetailsProvider;
let changesTreeView: vscode.TreeView<any>;
let latexCompiler: LatexCompiler | undefined;
let autoCompiler: AutoCompiler | undefined;
let extensionContext: vscode.ExtensionContext;

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
    try {

    extensionContext = context;

    // Initialize output channel
    outputChannel = vscode.window.createOutputChannel(EXTENSION_NAME);
    context.subscriptions.push(outputChannel);

    // Share output channel with socketio module for logging
    setOutputChannel(outputChannel);

    // Initialize credential manager
    credentialManager = CredentialManager.initialize(context);

    // Initialize sidebar providers
    projectsProvider = new ProjectsProvider(credentialManager);
    changesProvider = new ChangesProvider();
    detailsProvider = new DetailsProvider(credentialManager);

    const projectsTreeView = vscode.window.createTreeView('localleaf.projectsView', {
        treeDataProvider: projectsProvider,
    });
    changesTreeView = vscode.window.createTreeView('localleaf.changesView', {
        treeDataProvider: changesProvider,
    });
    const detailsTreeView = vscode.window.createTreeView('localleaf.detailsView', {
        treeDataProvider: detailsProvider,
    });
    context.subscriptions.push(projectsTreeView, changesTreeView, detailsTreeView);

    // Set context for viewsWelcome / toolbar conditionals
    const serverUrl = credentialManager.getDefaultServer();
    const hasCredential = !!(await credentialManager.getCredential(serverUrl));
    await vscode.commands.executeCommand('setContext', 'localleaf.loggedIn', hasCredential);

    const initSettingsManager = SettingsManager.getCurrentInstance();
    const isInitLinked = initSettingsManager && await initSettingsManager.isLinked();
    await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', !!isInitLinked);

    // Create status bar items
    // Sync status (left side)
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY);
    statusBarItem.name = `${EXTENSION_NAME} Sync`;
    context.subscriptions.push(statusBarItem);

    // Login status (left side, before sync)
    loginStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY + 1);
    loginStatusItem.name = `${EXTENSION_NAME} Login`;
    loginStatusItem.command = COMMANDS.LOGIN;
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
    const settingsManager = SettingsManager.getCurrentInstance();
    if (settingsManager && await settingsManager.isLinked()) {
        await settingsManager.load();
        // Show status bar only when linked
        statusBarItem.show();
        await initializeSync(context, settingsManager);
    } else {
        // Hide sync status bar when not linked
        statusBarItem.hide();
        collaboratorStatusItem.hide();
    }

    // Watch for settings changes
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (workspaceFolder) {
        const settingsWatcher = createSettingsWatcher(workspaceFolder, async () => {
            log('Settings changed, reloading...');
            await settingsManager?.load();
        });
        context.subscriptions.push(settingsWatcher);
    }

    log('LocalLeaf activated');

    } catch (error) {
        console.error('[LocalLeaf] Activation error:', error);
        vscode.window.showErrorMessage(`LocalLeaf failed to activate: ${error}`);
    }
}

/**
 * Register all commands
 */
function registerCommands(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.LOGIN, cmdLogin),
        vscode.commands.registerCommand(COMMANDS.LOGOUT, cmdLogout),
        vscode.commands.registerCommand(COMMANDS.LINK_FOLDER, () => cmdLinkFolder(context)),
        vscode.commands.registerCommand(COMMANDS.UNLINK_FOLDER, cmdUnlinkFolder),
        vscode.commands.registerCommand(COMMANDS.SYNC_NOW, cmdSyncNow),
        vscode.commands.registerCommand(COMMANDS.PULL_FROM_OVERLEAF, cmdPullFromOverleaf),
        vscode.commands.registerCommand(COMMANDS.PUSH_TO_OVERLEAF, cmdPushToOverleaf),
        vscode.commands.registerCommand(COMMANDS.EDIT_IGNORE_PATTERNS, cmdEditIgnorePatterns),
        vscode.commands.registerCommand(COMMANDS.SHOW_SYNC_STATUS, cmdShowSyncStatus),
        vscode.commands.registerCommand(COMMANDS.SET_MAIN_DOCUMENT, cmdSetMainDocument),
        vscode.commands.registerCommand(COMMANDS.CONFIGURE, cmdConfigure),
        vscode.commands.registerCommand(COMMANDS.JUMP_TO_COLLABORATOR, cmdJumpToCollaborator),
        vscode.commands.registerCommand(COMMANDS.VERIFY_CREDENTIALS, cmdVerifyCredentials),
        vscode.commands.registerCommand(COMMANDS.REFRESH_COOKIE, cmdRefreshCookie),
        vscode.commands.registerCommand(COMMANDS.OPEN_PROJECT, (project: ProjectInfo) => cmdOpenProject(context, project)),
        vscode.commands.registerCommand(COMMANDS.REMOVE_COMMENTS, cmdRemoveComments),
        // Sync mode
        vscode.commands.registerCommand(COMMANDS.TOGGLE_SYNC_MODE, cmdToggleSyncMode),
        // Project sorting & filtering
        vscode.commands.registerCommand(COMMANDS.FILTER_PROJECTS, cmdFilterProjects),
        vscode.commands.registerCommand(COMMANDS.SORT_PROJECTS_BY_NAME, () => cmdSortProjects('name')),
        vscode.commands.registerCommand(COMMANDS.SORT_PROJECTS_BY_DATE, () => cmdSortProjects('lastUpdated')),
        vscode.commands.registerCommand(COMMANDS.SORT_PROJECTS_BY_ACCESS, () => cmdSortProjects('accessLevel')),
        // Compilation & PDF preview
        vscode.commands.registerCommand(COMMANDS.COMPILE_LATEX, cmdCompileLaTeX),
        vscode.commands.registerCommand(COMMANDS.SHOW_PDF_PREVIEW, cmdShowPdfPreview),
        vscode.commands.registerCommand(COMMANDS.SELECT_COMPILER, cmdSelectCompiler),
        vscode.commands.registerCommand(COMMANDS.TOGGLE_AUTO_COMPILE, cmdToggleAutoCompile),
        vscode.commands.registerCommand(COMMANDS.CANCEL_COMPILATION, cmdCancelCompilation),
        // Changes view context actions
        vscode.commands.registerCommand(COMMANDS.VIEW_DIFF, (path: string) => cmdViewDiff(path)),
        vscode.commands.registerCommand(COMMANDS.DISCARD_CHANGE, (path: string) => cmdDiscardChange(path)),
        vscode.commands.registerCommand(COMMANDS.RESOLVE_CONFLICT_REMOTE, (path: string) => cmdResolveConflict(path, 'remote')),
        vscode.commands.registerCommand(COMMANDS.RESOLVE_CONFLICT_LOCAL, (path: string) => cmdResolveConflict(path, 'local')),
    );
}

/**
 * Initialize sync engine for linked folder
 */
async function initializeSync(context: vscode.ExtensionContext, settings: SettingsManager): Promise<void> {
    const projectSettings = settings.getSettings();
    if (!projectSettings) return;

    // Get credentials
    const credential = await credentialManager.getCredential(projectSettings.serverUrl);
    if (!credential) {
        updateStatusBar('disconnected', 'Not logged in');
        vscode.window.showWarningMessage('LocalLeaf: Please login to Overleaf first');
        return;
    }

    // Create API
    const api = new BaseAPI(projectSettings.serverUrl);
    api.setIdentity(credential.identity);

    // Create sync engine
    syncEngine = new SyncEngine(api, settings, log);

    // Listen to status changes
    syncEngine.onStatusChange(async event => {
        updateStatusBar(event.status, event.message);
        // Track per-file changes in the sidebar
        if (event.file && (event.status === 'pushing' || event.status === 'pulling')) {
            changesProvider.addFileChange(event.file, event.status === 'pushing' ? 'push' : 'pull');
        }
        // Handle auth errors
        if (event.authError) {
            await setAuthState('expired');
            showSessionExpiredNotification();
        }
    });

    // Wire up change tracker to changes view
    changesProvider.setChangeTracker(syncEngine.changeTracker);

    // Read sync mode from settings and apply
    const syncMode: SyncMode = projectSettings.syncMode === 'realtime' ? 'realtime' : 'manual';
    changesProvider.setSyncMode(syncMode);
    await vscode.commands.executeCommand('setContext', 'localleaf.syncMode', syncMode);
    updateSyncModeStatusBar(syncMode);

    // Connect
    try {
        await syncEngine.connect();

        // Initialize cursor tracker
        const socket = syncEngine.getSocket();
        if (socket) {
            cursorTracker = new CursorTracker(socket, settings);
            await cursorTracker.initialize();
            context.subscriptions.push({ dispose: () => cursorTracker?.dispose() });
        }

        // Start periodic status updates for collaborators
        startStatusUpdates();

        log('Sync engine connected');

        // Auto-detect main document from project settings
        await syncEngine.detectMainDocument();

        // Auto-pull on project load
        try {
            log('Auto-pulling files from Overleaf...');
            await syncEngine.pullAll();
            log('Auto-pull complete');

            // Join all docs to receive real-time OT updates
            await syncEngine.joinAllDocsForWatching();
            log('Watching for remote changes');

            vscode.window.showInformationMessage(`LocalLeaf: Synced with "${projectSettings.projectName}"`);
        } catch (pullError) {
            log(`Auto-pull failed: ${pullError}`);
            // Don't show error for auto-pull, user can manually pull
        }

        // Initialize LaTeX compiler
        latexCompiler = new LatexCompiler();
        context.subscriptions.push(latexCompiler);

        autoCompiler = new AutoCompiler(latexCompiler);
        context.subscriptions.push(autoCompiler);

        // Auto-compile on save (always enabled — use setting to opt out)
        {
            const mainTex = projectSettings.mainTex || 'main.tex';
            const delay = vscode.workspace.getConfiguration('localleaf').get<number>('compileDelay', 1500);
            const compileOnSave = vscode.workspace.getConfiguration('localleaf').get<boolean>('compileOnSave', true);
            if (compileOnSave) {
                autoCompiler.enable(settings.getWorkspaceFolder(), mainTex, delay);
                autoCompiler.onDidCompile(result => handleCompilationResult(result));
            }
        }

        // Auto-compile and open PDF preview on project load
        const mainTex = projectSettings.mainTex || 'main.tex';
        let compiler: CompilerType | undefined;
        if (projectSettings.compiler && projectSettings.compiler !== 'auto') {
            compiler = projectSettings.compiler as CompilerType;
        }
        const workspaceFolder = settings.getWorkspaceFolder();
        log('Auto-compiling on project load...');
        latexCompiler.compile(workspaceFolder.fsPath, mainTex, compiler).then(result => {
            if (result.success && result.pdfPath) {
                log(`Auto-compile succeeded (${result.duration}ms), opening PDF preview`);
                PdfPreviewPanel.createOrShow(context.extensionUri, result.pdfPath, workspaceFolder.fsPath);
            } else {
                log(`Auto-compile failed: ${result.errors.map(e => e.message).join('; ')}`);
            }
        });
    } catch (error) {
        log(`Failed to connect: ${error}`);
        vscode.window.showErrorMessage(`LocalLeaf: Failed to connect - ${error}`);
    }
}

/**
 * Update sync status bar
 */
function updateStatusBar(status: SyncStatus, message?: string) {
    if (changesProvider) {
        changesProvider.setSyncStatus(status);
    }
    // Update changes view title with sync status
    if (changesTreeView) {
        const settingsManager = SettingsManager.getCurrentInstance();
        const lastSynced = settingsManager?.getSettings()?.lastSynced;
        changesTreeView.description = syncStatusDescription(status, lastSynced);
    }

    const icons: Record<SyncStatus, string> = {
        idle: '$(cloud)',
        syncing: '$(sync~spin)',
        pulling: '$(cloud-download)',
        pushing: '$(cloud-upload)',
        error: '$(warning)',
        disconnected: '$(cloud-offline)',
    };

    const modeLabel = syncEngine?.syncMode === 'realtime' ? 'Live' : 'Manual';
    statusBarItem.text = `${icons[status]} LocalLeaf [${modeLabel}]`;
    statusBarItem.tooltip = new vscode.MarkdownString(`**LocalLeaf** [${modeLabel}] - ${message || status}`);
    statusBarItem.command = COMMANDS.SHOW_SYNC_STATUS;

    if (status === 'error') {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (status === 'disconnected') {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        statusBarItem.backgroundColor = undefined;
    }

    statusBarItem.show();

    // Update collaborator status bar based on connection
    if (status === 'disconnected' || status === 'error') {
        collaboratorStatusItem.hide();
    }
}

/**
 * Update auth state and refresh UI
 */
async function setAuthState(state: AuthState): Promise<void> {
    authState = state;
    await updateLoginStatus();
}

/**
 * Update login status bar
 */
async function updateLoginStatus() {
    // Only show login status if folder is linked
    const settingsManager = SettingsManager.getCurrentInstance();
    const isLinked = settingsManager && await settingsManager.isLinked();

    if (!isLinked) {
        loginStatusItem.hide();
        return;
    }

    const serverUrl = credentialManager.getDefaultServer();
    const credential = await credentialManager.getCredential(serverUrl);

    if (credential && authState === 'valid') {
        // Logged in with valid session
        loginStatusItem.text = `$(account) ${credential.userEmail}`;
        loginStatusItem.tooltip = new vscode.MarkdownString(
            `**Logged in to Overleaf**\n\n` +
            `Email: ${credential.userEmail}\n\n` +
            `Server: ${credential.serverUrl}`
        );
        loginStatusItem.backgroundColor = undefined;
        loginStatusItem.command = COMMANDS.LOGOUT;
    } else if (credential && authState === 'expired') {
        // Session expired - show warning state
        loginStatusItem.text = `$(warning) ${credential.userEmail} (expired)`;
        loginStatusItem.tooltip = new vscode.MarkdownString(
            `**Session Expired**\n\n` +
            `Email: ${credential.userEmail}\n\n` +
            `Server: ${credential.serverUrl}\n\n` +
            `Click to refresh your cookie`
        );
        loginStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        loginStatusItem.command = COMMANDS.REFRESH_COOKIE;
    } else if (credential) {
        // Credential exists but auth state not confirmed yet (assume valid until proven otherwise)
        loginStatusItem.text = `$(account) ${credential.userEmail}`;
        loginStatusItem.tooltip = new vscode.MarkdownString(
            `**Logged in to Overleaf**\n\n` +
            `Email: ${credential.userEmail}\n\n` +
            `Server: ${credential.serverUrl}`
        );
        loginStatusItem.backgroundColor = undefined;
        loginStatusItem.command = COMMANDS.LOGOUT;
    } else {
        // Not logged in
        authState = 'none';
        loginStatusItem.text = '$(account) Not logged in';
        loginStatusItem.tooltip = 'Click to login to Overleaf';
        loginStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        loginStatusItem.command = COMMANDS.LOGIN;
    }

    loginStatusItem.show();
}

/**
 * Show session expired notification with action buttons
 */
async function showSessionExpiredNotification(): Promise<void> {
    const action = await vscode.window.showWarningMessage(
        'LocalLeaf: Your Overleaf session has expired.',
        'Refresh Cookie',
        'Dismiss'
    );

    if (action === 'Refresh Cookie') {
        await cmdRefreshCookie();
    }
}

/**
 * Update collaborator status bar
 */
function updateCollaboratorStatus() {
    if (!cursorTracker || !syncEngine || syncEngine.status === 'disconnected') {
        collaboratorStatusItem.hide();
        return;
    }

    const users = cursorTracker.getOnlineUsers();
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
        tooltip.isTrusted = true;
        tooltip.supportHtml = true;

        for (const user of users) {
            const timeSince = formatTimeSince(now - user.lastUpdated);
            const location = user.docPath ? `at ${user.docPath}:${user.row + 1}` : '';
            tooltip.appendMarkdown(`- <span style="color:${user.color};">**${user.name}**</span> ${location} (${timeSince})\n`);
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

/**
 * Refresh all sidebar providers
 */
function refreshSidebar(): void {
    projectsProvider.refresh();
    changesProvider.refresh();
    detailsProvider.refresh();
}

// === Command Implementations ===

/**
 * Login to Overleaf
 */
async function cmdLogin() {
    const serverUrl = await vscode.window.showInputBox({
        prompt: 'Enter Overleaf server URL',
        value: credentialManager.getDefaultServer(),
        placeHolder: 'https://www.overleaf.com',
    });

    if (!serverUrl) return;

    // For www.overleaf.com, use cookie-based login
    const isOfficialServer = serverUrl.includes('overleaf.com');

    if (isOfficialServer) {
        // Show help option before asking for cookies
        const helpChoice = await vscode.window.showInformationMessage(
            'You need to paste your Overleaf cookies to login.',
            'How to get cookies?',
            'Continue'
        );

        if (!helpChoice) return;

        if (helpChoice === 'How to get cookies?') {
            await vscode.env.openExternal(vscode.Uri.parse('https://github.com/overleaf-workshop/Overleaf-Workshop/blob/master/docs/wiki.md#login-with-cookies'));
            // Show input box after opening the tutorial
        }

        const cookies = await vscode.window.showInputBox({
            prompt: 'Paste your Overleaf cookies (see tutorial for help)',
            placeHolder: 'overleaf_session2=...',
            password: true,
        });

        if (!cookies) return;

        const api = new BaseAPI(serverUrl);
        const result = await api.cookiesLogin(cookies);

        if (result.type === 'success' && result.userInfo && result.identity) {
            const credential: ServerCredential = {
                serverUrl,
                userId: result.userInfo.userId,
                userEmail: result.userInfo.userEmail,
                identity: result.identity,
            };
            await credentialManager.storeCredential(credential);
            await setAuthState('valid');
            await vscode.commands.executeCommand('setContext', 'localleaf.loggedIn', true);
            refreshSidebar();
            vscode.window.showInformationMessage(`LocalLeaf: Logged in as ${result.userInfo.userEmail}`);
        } else {
            vscode.window.showErrorMessage(`LocalLeaf: Login failed - ${result.message}`);
        }
    } else {
        // For self-hosted, use email/password
        const email = await vscode.window.showInputBox({
            prompt: 'Enter your email',
            placeHolder: 'email@example.com',
        });

        if (!email) return;

        const password = await vscode.window.showInputBox({
            prompt: 'Enter your password',
            password: true,
        });

        if (!password) return;

        const api = new BaseAPI(serverUrl);
        const result = await api.passportLogin(email, password);

        if (result.type === 'success' && result.userInfo && result.identity) {
            const credential: ServerCredential = {
                serverUrl,
                userId: result.userInfo.userId,
                userEmail: result.userInfo.userEmail,
                identity: result.identity,
            };
            await credentialManager.storeCredential(credential);
            await setAuthState('valid');
            await vscode.commands.executeCommand('setContext', 'localleaf.loggedIn', true);
            refreshSidebar();
            vscode.window.showInformationMessage(`LocalLeaf: Logged in as ${result.userInfo.userEmail}`);
        } else {
            vscode.window.showErrorMessage(`LocalLeaf: Login failed - ${result.message}`);
        }
    }
}

/**
 * Logout from Overleaf
 */
async function cmdLogout() {
    const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to logout from Overleaf?',
        'Logout',
        'Cancel'
    );

    if (confirm !== 'Logout') return;

    const serverUrl = credentialManager.getDefaultServer();
    await credentialManager.deleteCredential(serverUrl);

    // Disconnect sync engine but keep settings
    if (syncEngine) {
        syncEngine.disconnect();
        syncEngine = undefined;
    }

    if (cursorTracker) {
        cursorTracker.dispose();
        cursorTracker = undefined;
    }

    updateStatusBar('disconnected', 'Logged out');
    await updateLoginStatus();
    await vscode.commands.executeCommand('setContext', 'localleaf.loggedIn', false);
    refreshSidebar();
    vscode.window.showInformationMessage('LocalLeaf: Logged out');
}

/**
 * Link current folder to an Overleaf project
 */
async function cmdLinkFolder(context: vscode.ExtensionContext) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('LocalLeaf: No workspace folder open');
        return;
    }

    // Get server URL
    const serverUrl = credentialManager.getDefaultServer();

    // Check if logged in
    const credential = await credentialManager.getCredential(serverUrl);
    if (!credential) {
        vscode.window.showWarningMessage('LocalLeaf: Please login first');
        await cmdLogin();
        return;
    }

    // Get projects list
    const api = new BaseAPI(serverUrl);
    api.setIdentity(credential.identity);

    const projectsResult = await api.getProjects();
    if (projectsResult.type !== 'success' || !projectsResult.projects) {
        vscode.window.showErrorMessage(`LocalLeaf: Failed to get projects - ${projectsResult.message}`);
        return;
    }

    // Filter active projects
    const activeProjects = projectsResult.projects.filter(p => !p.archived && !p.trashed);

    // Show project picker
    const items = activeProjects.map(p => ({
        label: p.name,
        description: `${p.accessLevel}${p.lastUpdated ? ` - ${new Date(p.lastUpdated).toLocaleDateString()}` : ''}`,
        project: p,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select an Overleaf project to link',
    });

    if (!selected) return;

    const project = selected.project;

    // Create settings
    const settingsManager = SettingsManager.getInstance(workspaceFolder);
    const settings = SettingsManager.createDefaultSettings(serverUrl, project.id, project.name);
    await settingsManager.save(settings);

    // Create default .leafignore
    const ignoreParser = new IgnoreParser(workspaceFolder);
    if (!(await ignoreParser.exists())) {
        await ignoreParser.createDefault();
    }

    vscode.window.showInformationMessage(`LocalLeaf: Linked to "${project.name}"`);

    // Show status bars now that we're linked
    statusBarItem.show();
    await updateLoginStatus();
    await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', true);
    refreshSidebar();

    // Initialize sync (this will auto-pull)
    await initializeSync(context, settingsManager);
}

/**
 * Unlink current folder
 */
async function cmdUnlinkFolder() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showInformationMessage('LocalLeaf: This folder is not linked');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to unlink this folder from Overleaf?',
        { modal: true },
        'Unlink'
    );

    if (confirm !== 'Unlink') return;

    // Disconnect
    if (syncEngine) {
        syncEngine.disconnect();
        syncEngine = undefined;
    }

    if (cursorTracker) {
        cursorTracker.dispose();
        cursorTracker = undefined;
    }

    // Delete settings
    await settingsManager.delete();

    updateStatusBar('disconnected');
    await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', false);
    changesProvider.clearChanges();
    refreshSidebar();
    vscode.window.showInformationMessage('LocalLeaf: Folder unlinked');
}

/**
 * Sync now (bidirectional)
 */
async function cmdSyncNow() {
    if (!syncEngine) {
        vscode.window.showWarningMessage('LocalLeaf: Not connected. Please link a folder first.');
        return;
    }

    if (syncEngine.syncMode === 'manual') {
        // In manual mode: pull then push
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'LocalLeaf: Syncing...',
            cancellable: false,
        }, async () => {
            await syncEngine!.pullChanges();
            await syncEngine!.pushChanges();
        });
        vscode.window.showInformationMessage('LocalLeaf: Sync complete');
    } else {
        // In realtime mode: do a full pull to catch up
        await cmdPullFromOverleaf();
    }
}

/**
 * Pull from Overleaf
 */
async function cmdPullFromOverleaf() {
    if (!syncEngine) {
        vscode.window.showWarningMessage('LocalLeaf: Not connected. Please link a folder first.');
        return;
    }

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'LocalLeaf: Pulling from Overleaf...',
            cancellable: false,
        }, async () => {
            if (syncEngine!.syncMode === 'manual') {
                await syncEngine!.pullChanges();
            } else {
                await syncEngine!.pullAll();
            }
        });
        vscode.window.showInformationMessage('LocalLeaf: Pull complete');
    } catch (error) {
        vscode.window.showErrorMessage(`LocalLeaf: Pull failed - ${error}`);
    }
}

/**
 * Push to Overleaf
 */
async function cmdPushToOverleaf() {
    if (!syncEngine) {
        vscode.window.showWarningMessage('LocalLeaf: Not connected. Please link a folder first.');
        return;
    }

    if (syncEngine.syncMode === 'manual') {
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'LocalLeaf: Pushing to Overleaf...',
                cancellable: false,
            }, async () => {
                await syncEngine!.pushChanges();
            });
            vscode.window.showInformationMessage('LocalLeaf: Push complete');
        } catch (error) {
            vscode.window.showErrorMessage(`LocalLeaf: Push failed - ${error}`);
        }
    } else {
        vscode.window.showInformationMessage('LocalLeaf: Push is automatic in real-time mode');
    }
}

/**
 * Edit ignore patterns
 */
async function cmdEditIgnorePatterns() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('LocalLeaf: No workspace folder open');
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
 * Show sync status
 */
async function cmdShowSyncStatus() {
    const settingsManager = SettingsManager.getCurrentInstance();
    const settings = settingsManager?.getSettings();

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
    if (settings && authState === 'expired') {
        items.push({
            label: '$(key) Refresh Cookie',
            description: 'Session expired - click to enter new cookie',
        });
    }

    // Show verify credentials option when connected
    if (settings && authState !== 'expired') {
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
        await cmdReconnect();
    } else if (selected?.label.includes('Refresh Cookie')) {
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
async function cmdReconnect() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showWarningMessage('LocalLeaf: No linked project');
        return;
    }

    // Disconnect existing sync engine
    if (syncEngine) {
        syncEngine.disconnect();
        syncEngine = undefined;
    }

    if (cursorTracker) {
        cursorTracker.dispose();
        cursorTracker = undefined;
    }

    stopStatusUpdates();

    const projectSettings = settingsManager.getSettings();
    if (!projectSettings) return;

    const credential = await credentialManager.getCredential(projectSettings.serverUrl);
    if (!credential) {
        updateStatusBar('disconnected', 'Not logged in');
        vscode.window.showWarningMessage('LocalLeaf: Please login to Overleaf first');
        return;
    }

    const api = new BaseAPI(projectSettings.serverUrl);
    api.setIdentity(credential.identity);

    syncEngine = new SyncEngine(api, settingsManager, log);

    // Wire up change tracker
    changesProvider.setChangeTracker(syncEngine.changeTracker);
    const syncMode: SyncMode = projectSettings.syncMode === 'realtime' ? 'realtime' : 'manual';
    changesProvider.setSyncMode(syncMode);
    await vscode.commands.executeCommand('setContext', 'localleaf.syncMode', syncMode);

    syncEngine.onStatusChange(async event => {
        updateStatusBar(event.status, event.message);
        // Track per-file changes in the sidebar
        if (event.file && (event.status === 'pushing' || event.status === 'pulling')) {
            changesProvider.addFileChange(event.file, event.status === 'pushing' ? 'push' : 'pull');
        }
        // Handle auth errors
        if (event.authError) {
            await setAuthState('expired');
            showSessionExpiredNotification();
        }
    });

    try {
        updateStatusBar('syncing', 'Reconnecting...');
        await syncEngine.connect();

        const socket = syncEngine.getSocket();
        if (socket) {
            cursorTracker = new CursorTracker(socket, settingsManager);
            await cursorTracker.initialize();
        }

        startStatusUpdates();
        log('Reconnected to Overleaf');

        await syncEngine.pullAll();
        vscode.window.showInformationMessage(`LocalLeaf: Reconnected to "${projectSettings.projectName}"`);
    } catch (error) {
        log(`Failed to reconnect: ${error}`);
        vscode.window.showErrorMessage(`LocalLeaf: Failed to reconnect - ${error}`);
    }
}

/**
 * Set main document
 */
async function cmdSetMainDocument() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showErrorMessage('LocalLeaf: No linked project');
        return;
    }

    const mainTex = await vscode.window.showInputBox({
        prompt: 'Enter main TeX file name',
        value: settingsManager.getSettings()?.mainTex || 'main.tex',
    });

    if (!mainTex) return;

    const mainPdf = mainTex.replace(/\.tex$/, '.pdf');

    await settingsManager.update({ mainTex, mainPdf });
    vscode.window.showInformationMessage(`LocalLeaf: Main document set to ${mainTex}`);
}

/**
 * Configure settings
 */
async function cmdConfigure() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showInformationMessage('LocalLeaf: No linked project');
        return;
    }

    const workspaceFolder = settingsManager.getWorkspaceFolder();
    const settingsFile = vscode.Uri.joinPath(workspaceFolder, CONFIG_DIR, 'settings.json');
    await vscode.window.showTextDocument(settingsFile);
}

/**
 * Jump to collaborator cursor
 */
async function cmdJumpToCollaborator() {
    if (!cursorTracker) {
        vscode.window.showWarningMessage('LocalLeaf: Not connected');
        return;
    }

    await cursorTracker.jumpToUser();
}

/**
 * Verify credentials are still valid
 */
async function cmdVerifyCredentials() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showInformationMessage('LocalLeaf: No linked project');
        return;
    }

    const projectSettings = settingsManager.getSettings();
    if (!projectSettings) return;

    const credential = await credentialManager.getCredential(projectSettings.serverUrl);
    if (!credential) {
        await setAuthState('none');
        vscode.window.showWarningMessage('LocalLeaf: Not logged in');
        return;
    }

    const api = new BaseAPI(projectSettings.serverUrl);
    api.setIdentity(credential.identity);

    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'LocalLeaf: Verifying credentials...',
    }, async () => {
        return api.verifyCredentials();
    });

    if (result.type === 'success') {
        await setAuthState('valid');
        vscode.window.showInformationMessage('LocalLeaf: Credentials are valid');
    } else {
        await setAuthState('expired');
        showSessionExpiredNotification();
    }
}

/**
 * Refresh cookie (re-login without clearing stored info)
 */
async function cmdRefreshCookie() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showWarningMessage('LocalLeaf: No linked project');
        return;
    }

    const projectSettings = settingsManager.getSettings();
    if (!projectSettings) return;

    const serverUrl = projectSettings.serverUrl;

    // Get existing credential to show user info
    const existingCredential = await credentialManager.getCredential(serverUrl);
    const userInfo = existingCredential
        ? `Refreshing session for ${existingCredential.userEmail}`
        : 'Enter your Overleaf cookie';

    // Show help option
    const helpChoice = await vscode.window.showInformationMessage(
        userInfo,
        'How to get cookies?',
        'Continue'
    );

    if (!helpChoice) return;

    if (helpChoice === 'How to get cookies?') {
        await vscode.env.openExternal(vscode.Uri.parse(
            'https://github.com/overleaf-workshop/Overleaf-Workshop/blob/master/docs/wiki.md#login-with-cookies'
        ));
    }

    const cookies = await vscode.window.showInputBox({
        prompt: 'Paste your fresh Overleaf cookie',
        placeHolder: 'overleaf_session2=...',
        password: true,
    });

    if (!cookies) return;

    const api = new BaseAPI(serverUrl);
    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'LocalLeaf: Validating cookie...',
    }, async () => {
        return api.cookiesLogin(cookies);
    });

    if (result.type === 'success' && result.userInfo && result.identity) {
        const credential: ServerCredential = {
            serverUrl,
            userId: result.userInfo.userId,
            userEmail: result.userInfo.userEmail,
            identity: result.identity,
        };
        await credentialManager.storeCredential(credential);
        await setAuthState('valid');
        await vscode.commands.executeCommand('setContext', 'localleaf.loggedIn', true);
        refreshSidebar();

        vscode.window.showInformationMessage(
            `LocalLeaf: Session refreshed for ${result.userInfo.userEmail}`
        );

        // Attempt to reconnect sync engine
        await cmdReconnect();
    } else {
        vscode.window.showErrorMessage(`LocalLeaf: Cookie validation failed - ${result.message}`);
    }
}

/**
 * Remove LaTeX comments from all .tex files in the workspace
 */
async function cmdRemoveComments() {
    try {
        log('Remove Comments: starting...');

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('LocalLeaf: No workspace folder open');
            return;
        }

        // Find all .tex files
        log('Remove Comments: scanning for .tex files...');
        const texFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceFolder, '**/*.tex'),
            new vscode.RelativePattern(workspaceFolder, '.localleaf/**'),
        );
        log(`Remove Comments: found ${texFiles.length} .tex files`);

        if (texFiles.length === 0) {
            vscode.window.showInformationMessage('LocalLeaf: No .tex files found in workspace');
            return;
        }

        // Dry-run: count how many comment lines would be removed
        let totalCommentLines = 0;
        const fileSummaries: { uri: vscode.Uri; name: string; commentLines: number }[] = [];

        for (const uri of texFiles) {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const content = new TextDecoder().decode(bytes);
            const commentLines = countCommentLines(content);
            if (commentLines > 0) {
                const relativePath = vscode.workspace.asRelativePath(uri);
                fileSummaries.push({ uri, name: relativePath, commentLines });
                totalCommentLines += commentLines;
            }
        }

        log(`Remove Comments: ${totalCommentLines} comment lines in ${fileSummaries.length} files`);

        if (totalCommentLines === 0) {
            vscode.window.showInformationMessage('LocalLeaf: No comments found in any .tex files');
            return;
        }

        // Confirmation dialog
        const fileList = fileSummaries.map(f => `${f.name}: ${f.commentLines} lines`).join('\n');
        const confirm = await vscode.window.showWarningMessage(
            `Remove ${totalCommentLines} comment lines from ${fileSummaries.length} file(s)?`,
            { modal: true, detail: `This cannot be undone (except via sync/git).\n\n${fileList}` },
            'Remove All Comments'
        );

        if (confirm !== 'Remove All Comments') { return; }

        // Process each file
        let totalRemoved = 0;
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'LocalLeaf: Removing comments...',
            cancellable: false,
        }, async (progress) => {
            for (let i = 0; i < fileSummaries.length; i++) {
                const f = fileSummaries[i];
                progress.report({ message: f.name, increment: (100 / fileSummaries.length) });

                const bytes = await vscode.workspace.fs.readFile(f.uri);
                const original = new TextDecoder().decode(bytes);
                const cleaned = removeLatexComments(original);

                const origLines = original.split('\n').length;
                const cleanLines = cleaned.split('\n').length;
                totalRemoved += origLines - cleanLines;

                await vscode.workspace.fs.writeFile(f.uri, new TextEncoder().encode(cleaned));
            }
        });

        vscode.window.showInformationMessage(
            `LocalLeaf: Removed ${totalRemoved} comment lines from ${fileSummaries.length} file(s)`
        );
    } catch (error) {
        log(`Remove Comments error: ${error}`);
        vscode.window.showErrorMessage(`LocalLeaf: Remove comments failed — ${error}`);
    }
}

/**
 * Count comment lines in LaTeX content (for preview)
 */
function countCommentLines(content: string): number {
    const lines = content.split('\n');
    let count = 0;
    let inBlock = false;

    for (const line of lines) {
        const stripped = line.trim();
        if (stripped === '\\begin{comment}') { inBlock = true; count++; continue; }
        if (stripped === '\\end{comment}') { inBlock = false; count++; continue; }
        if (inBlock) { count++; continue; }
        if (/^\s*%/.test(line) && !/^\s*\\%/.test(line)) { count++; }
    }
    return count;
}

/**
 * Remove LaTeX comments from content
 * - Removes \begin{comment}...\end{comment} blocks
 * - Removes lines starting with % (but not \%)
 * - Collapses consecutive blank lines
 * - Strips trailing blank lines
 */
function removeLatexComments(content: string): string {
    const lines = content.split('\n');
    const result: string[] = [];
    let inBlock = false;

    for (const line of lines) {
        const stripped = line.trim();

        // Handle \begin{comment} ... \end{comment} blocks
        if (stripped === '\\begin{comment}') { inBlock = true; continue; }
        if (stripped === '\\end{comment}') { inBlock = false; continue; }
        if (inBlock) { continue; }

        // Remove lines starting with % (but not \%)
        if (/^\s*%/.test(line) && !/^\s*\\%/.test(line)) { continue; }

        result.push(line);
    }

    // Collapse consecutive blank lines into at most one
    const cleaned: string[] = [];
    for (const line of result) {
        const isBlank = line.trim() === '';
        if (isBlank && cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') {
            continue;
        }
        cleaned.push(line);
    }

    // Strip trailing blank lines
    while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') {
        cleaned.pop();
    }

    return cleaned.join('\n') + '\n';
}

// === Sync Mode Commands ===

/**
 * Toggle between manual and realtime sync modes
 */
async function cmdToggleSyncMode() {
    if (!syncEngine) {
        vscode.window.showWarningMessage('LocalLeaf: Not connected. Please link a folder first.');
        return;
    }

    const currentMode = syncEngine.syncMode;
    const newMode: SyncMode = currentMode === 'manual' ? 'realtime' : 'manual';

    await syncEngine.setSyncMode(newMode);
    changesProvider.setSyncMode(newMode);
    await vscode.commands.executeCommand('setContext', 'localleaf.syncMode', newMode);
    updateSyncModeStatusBar(newMode);
    refreshSidebar();

    const label = newMode === 'manual' ? 'Manual' : 'Real-time';
    vscode.window.showInformationMessage(`LocalLeaf: Sync mode set to ${label}`);
}

/**
 * Update status bar to reflect current sync mode
 */
function updateSyncModeStatusBar(mode: SyncMode) {
    // The status bar text is updated in updateStatusBar, which reads syncEngine.syncMode
    // Just trigger a refresh
    if (syncEngine) {
        updateStatusBar(syncEngine.status);
    }
}

// === Project Sorting & Filtering Commands ===

async function cmdFilterProjects() {
    const current = projectsProvider.getFilter();
    const text = await vscode.window.showInputBox({
        prompt: 'Filter projects by name',
        value: current,
        placeHolder: 'Type to filter...',
    });

    if (text !== undefined) {
        projectsProvider.setFilter(text);
    }
}

function cmdSortProjects(field: 'name' | 'lastUpdated' | 'accessLevel') {
    projectsProvider.setSortField(field);
}

// === Compilation Commands ===

async function cmdCompileLaTeX() {
    const settingsManager = SettingsManager.getCurrentInstance();
    const settings = settingsManager?.getSettings();
    if (!settingsManager || !settings) {
        vscode.window.showWarningMessage('LocalLeaf: No linked project');
        return;
    }

    if (!latexCompiler) {
        latexCompiler = new LatexCompiler();
    }

    const mainTex = settings.mainTex || 'main.tex';
    const workspaceFolder = settingsManager.getWorkspaceFolder();

    // Determine compiler to use
    let compiler: CompilerType | undefined;
    if (settings.compiler && settings.compiler !== 'auto') {
        compiler = settings.compiler as CompilerType;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `LocalLeaf: Compiling ${mainTex}...`,
        cancellable: true,
    }, async (progress, token) => {
        token.onCancellationRequested(() => {
            latexCompiler?.cancel();
        });

        const result = await latexCompiler!.compile(workspaceFolder.fsPath, mainTex, compiler);
        handleCompilationResult(result);
    });
}

function handleCompilationResult(result: CompilationResult) {
    if (result.success) {
        const duration = (result.duration / 1000).toFixed(1);
        vscode.window.showInformationMessage(`LocalLeaf: Compilation successful (${duration}s)`);

        // Auto-open / refresh PDF preview
        if (result.pdfPath) {
            PdfPreviewPanel.createOrShow(extensionContext.extensionUri, result.pdfPath);
        }
    } else {
        const errorCount = result.errors.length;
        const warningCount = result.warnings.length;
        vscode.window.showErrorMessage(
            `LocalLeaf: Compilation failed (${errorCount} error(s), ${warningCount} warning(s))`,
            'Show Problems'
        ).then(choice => {
            if (choice === 'Show Problems') {
                vscode.commands.executeCommand('workbench.action.problems.focus');
            }
        });
    }

    log(`Compilation ${result.success ? 'succeeded' : 'failed'} in ${result.duration}ms`);
}

async function cmdShowPdfPreview() {
    const settingsManager = SettingsManager.getCurrentInstance();
    const settings = settingsManager?.getSettings();
    if (!settingsManager || !settings) {
        vscode.window.showWarningMessage('LocalLeaf: No linked project');
        return;
    }

    const mainPdf = settings.mainPdf || settings.mainTex?.replace(/\.tex$/, '.pdf') || 'main.pdf';
    const workspaceFolder = settingsManager.getWorkspaceFolder();
    const pdfPath = path.join(LatexCompiler.getBuildDir(workspaceFolder.fsPath), mainPdf);

    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(pdfPath));
        PdfPreviewPanel.createOrShow(extensionContext.extensionUri, pdfPath, workspaceFolder.fsPath);
    } catch {
        // PDF not found — compile automatically then show preview
        await cmdCompileLaTeX();
    }
}

async function cmdSelectCompiler() {
    if (!latexCompiler) {
        latexCompiler = new LatexCompiler();
    }

    const available = await latexCompiler.detectCompilers();

    if (available.length === 0) {
        vscode.window.showErrorMessage('LocalLeaf: No LaTeX compilers found. Please install TeX Live or MiKTeX.');
        return;
    }

    const items: vscode.QuickPickItem[] = [
        { label: 'auto', description: 'Auto-detect (prefer latexmk)' },
        ...available.map(c => ({
            label: c,
            description: c === 'latexmk' ? 'Recommended (auto multi-pass)' : '',
        })),
    ];

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select LaTeX compiler',
    });

    if (selected) {
        const settingsManager = SettingsManager.getCurrentInstance();
        await settingsManager?.update({ compiler: selected.label as any });
        detailsProvider.refresh();
        vscode.window.showInformationMessage(`LocalLeaf: Compiler set to ${selected.label}`);
    }
}

async function cmdToggleAutoCompile() {
    const settingsManager = SettingsManager.getCurrentInstance();
    const settings = settingsManager?.getSettings();
    if (!settingsManager || !settings) {
        vscode.window.showWarningMessage('LocalLeaf: No linked project');
        return;
    }

    const config = vscode.workspace.getConfiguration('localleaf');
    const current = config.get<boolean>('compileOnSave', true);
    const newState = !current;
    await config.update('compileOnSave', newState, vscode.ConfigurationTarget.Global);

    if (newState) {
        if (!latexCompiler) {
            latexCompiler = new LatexCompiler();
        }
        if (!autoCompiler) {
            autoCompiler = new AutoCompiler(latexCompiler);
        }
        const mainTex = settings.mainTex || 'main.tex';
        const delay = config.get<number>('compileDelay', 1500);
        autoCompiler.enable(settingsManager.getWorkspaceFolder(), mainTex, delay);
        autoCompiler.onDidCompile(result => handleCompilationResult(result));
        vscode.window.showInformationMessage('LocalLeaf: Auto-compile enabled');
    } else {
        autoCompiler?.disable();
        vscode.window.showInformationMessage('LocalLeaf: Auto-compile disabled');
    }

    detailsProvider.refresh();
}

function cmdCancelCompilation() {
    if (latexCompiler?.isCompiling) {
        latexCompiler.cancel();
        vscode.window.showInformationMessage('LocalLeaf: Compilation cancelled');
    } else {
        vscode.window.showInformationMessage('LocalLeaf: No compilation in progress');
    }
}

// === Changes View Context Actions ===

async function cmdViewDiff(filePath: string) {
    if (!syncEngine || !filePath) return;

    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager) return;

    const localUri = settingsManager.getFilePath(filePath);
    const remoteUri = vscode.Uri.parse(`localleaf-remote:${filePath}`);

    await vscode.commands.executeCommand('vscode.diff',
        localUri,
        remoteUri,
        `${filePath} (Local ↔ Remote)`
    );
}

async function cmdResolveConflict(filePath: string, resolution: 'remote' | 'local') {
    if (!syncEngine || !filePath) return;

    const tracker = syncEngine.changeTracker;

    if (resolution === 'remote') {
        // Clear local change, keep remote
        tracker.clearLocal(filePath);
    } else {
        // Clear remote change, keep local
        tracker.clearRemote(filePath);
    }

    const label = resolution === 'remote' ? 'remote' : 'local';
    vscode.window.showInformationMessage(`LocalLeaf: Resolved "${filePath}" using ${label} version`);
}

async function cmdDiscardChange(filePath: string) {
    if (!syncEngine || !filePath) return;

    const tracker = syncEngine.changeTracker;
    const hasLocal = tracker.hasLocalChange(filePath);
    const hasRemote = tracker.hasRemoteChange(filePath);

    if (hasLocal) {
        tracker.clearLocal(filePath);
    }
    if (hasRemote) {
        tracker.clearRemote(filePath);
    }
}

/**
 * Open a project from the sidebar (link + download)
 */
async function cmdOpenProject(context: vscode.ExtensionContext, project: ProjectInfo) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('LocalLeaf: No workspace folder open');
        return;
    }

    const serverUrl = credentialManager.getDefaultServer();
    const credential = await credentialManager.getCredential(serverUrl);
    if (!credential) {
        vscode.window.showWarningMessage('LocalLeaf: Please login first');
        return;
    }

    // Create settings
    const settingsManager = SettingsManager.getInstance(workspaceFolder);
    const settings = SettingsManager.createDefaultSettings(serverUrl, project.id, project.name);
    await settingsManager.save(settings);

    // Create default .leafignore
    const ignoreParser = new IgnoreParser(workspaceFolder);
    if (!(await ignoreParser.exists())) {
        await ignoreParser.createDefault();
    }

    vscode.window.showInformationMessage(`LocalLeaf: Linked to "${project.name}"`);

    // Show status bars now that we're linked
    statusBarItem.show();
    await updateLoginStatus();
    await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', true);
    refreshSidebar();

    // Initialize sync (this will auto-pull)
    await initializeSync(context, settingsManager);
}

/**
 * Extension deactivation
 */
export function deactivate() {
    stopStatusUpdates();

    if (autoCompiler) {
        autoCompiler.dispose();
    }
    if (latexCompiler) {
        latexCompiler.dispose();
    }
    if (syncEngine) {
        syncEngine.disconnect();
    }
    if (cursorTracker) {
        cursorTracker.dispose();
    }
}
