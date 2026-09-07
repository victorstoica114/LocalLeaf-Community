import * as vscode from 'vscode';
import { validateServerUrl } from './serverUrl';

/** Change the browsing server locally, without contacting either server or removing sessions. */
export async function selectDefaultServer(
    serverUrl: string,
    configuration: Pick<vscode.WorkspaceConfiguration, 'inspect' | 'update'> = vscode.workspace.getConfiguration('localleaf'),
): Promise<string> {
    const normalized = validateServerUrl(serverUrl).url;
    const setting = configuration.inspect<string>('defaultServer');
    const target = setting?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
        : setting?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
    await configuration.update('defaultServer', normalized, target);
    return normalized;
}
