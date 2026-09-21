import * as vscode from 'vscode';
import { Log } from './common/logger';
import { RemoteSSHResolver, REMOTE_SSH_AUTHORITY } from './authResolver';
import { openSSHConfigFile, promptOpenRemoteSSHWindow, enableNativeRemoteView } from './commands';
import { HostTreeDataProvider } from './hostTreeView';
import { getRemoteWorkspaceLocationData, RemoteLocationHistory } from './remoteLocationHistory';

const NATIVE_VIEW_ID = 'sshHosts';
const FALLBACK_VIEW_ID = 'fastRemoteSsh.hosts';

export async function activate(context: vscode.ExtensionContext) {
    const logger = new Log('Remote - SSH');
    context.subscriptions.push(logger);

    const remoteSSHResolver = new RemoteSSHResolver(context, logger);
    try {
        context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver(REMOTE_SSH_AUTHORITY, remoteSSHResolver));
        context.subscriptions.push(remoteSSHResolver);
    } catch (error) {
        // 'resolvers' is a proposed API only granted to extensions allowlisted by the client.
        logger.error('Failed to register the remote authority resolver, SSH connections will not work. Enable proposed APIs for this extension (see README, section Activation).', error);

        void vscode.window.showErrorMessage(
            'Fast Remote SSH: the "resolvers" proposed API is not enabled for this extension, SSH connections will not work.',
            'Configure Runtime Arguments'
        ).then(choice => choice && vscode.commands.executeCommand('workbench.action.configureRuntimeArguments'));
    }

    const locationHistory = new RemoteLocationHistory(context);
    const locationData = getRemoteWorkspaceLocationData();
    if (locationData) {
        await locationHistory.addLocation(locationData[0], locationData[1]);
    }

    // A view in the built-in 'remote' container requires the 'contribViewsRemote' proposed API.
    // When it is not granted the view contribution is silently skipped, so probe for its
    // auto-generated focus command and fall back to our own view container.
    const commands = await vscode.commands.getCommands();
    const nativeViewRegistered = commands.includes(`${NATIVE_VIEW_ID}.focus`);
    if (!nativeViewRegistered) {
        logger.trace(`View '${NATIVE_VIEW_ID}' is not registered, using fallback view '${FALLBACK_VIEW_ID}'`);
    }
    await vscode.commands.executeCommand('setContext', 'fastRemoteSsh.useFallbackView', !nativeViewRegistered);

    const hostTreeDataProvider = new HostTreeDataProvider(locationHistory);
    context.subscriptions.push(vscode.window.createTreeView(nativeViewRegistered ? NATIVE_VIEW_ID : FALLBACK_VIEW_ID, { treeDataProvider: hostTreeDataProvider }));
    context.subscriptions.push(hostTreeDataProvider);

    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openEmptyWindow', () => promptOpenRemoteSSHWindow(false)));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openEmptyWindowInCurrentWindow', () => promptOpenRemoteSSHWindow(true)));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openConfigFile', () => openSSHConfigFile()));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.showLog', () => logger.show()));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.enableNativeView', () => enableNativeRemoteView(context.extension.id)));
}

export function deactivate() {
}
