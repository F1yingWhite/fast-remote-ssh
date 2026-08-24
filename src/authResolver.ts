import * as cp from 'child_process';
import * as fs from 'fs';
import * as stream from 'stream';
import * as vscode from 'vscode';
import * as ssh2 from 'ssh2';
import type { ParsedKey } from 'ssh2-streams';
import { Log } from './common/logger';
import SSHDestination from './ssh/sshDestination';
import SSHConnection, { TunnelActivity } from './ssh/sshConnection';
import SSHConfiguration from './ssh/sshConfig';
import { gatherIdentityFiles, SSHKey } from './ssh/identityFiles';
import { untildify, exists as fileExists } from './common/files';
import { ServerInstallError, findServerInstallPath } from './serverSetup';
import { isWindows } from './common/platform';
import * as os from 'os';
import { getVSCodeServerConfig, ServerVersion } from './serverConfig';
import { RemoteServerManager } from './serverManager';
import { DEFAULT_SSH_KEEPALIVE, resolveSSHKeepaliveConfig } from './ssh/keepalive';

const PASSWORD_RETRY_COUNT = 3;
const PASSPHRASE_RETRY_COUNT = 3;

export const REMOTE_SSH_AUTHORITY = 'ssh-remote';

export function getRemoteAuthority(host: string) {
    return `${REMOTE_SSH_AUTHORITY}+${host}`;
}

export function shouldRotateServerOnRetry(
    resolveAttempt: number,
    activity: TunnelActivity | undefined,
    alreadyRotated: boolean,
    previousEndpoint: number | string | undefined,
    managementConnectionEstablished: boolean | undefined
): boolean {
    return resolveAttempt > 1
        && previousEndpoint !== undefined
        && !alreadyRotated
        && activity !== undefined
        && activity.acceptedConnections > 0
        && (managementConnectionEstablished === false
            || managementConnectionEstablished === undefined && activity.remoteToLocalBytes === 0);
}

class TunnelInfo implements vscode.Disposable {
    private closed = false;

    constructor(
        readonly localPort: number,
        readonly remotePortOrSocketPath: number | string,
        private readonly closeTunnel: () => Promise<void>
    ) {
    }

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closed = true;
        await this.closeTunnel();
    }

    dispose(): void {
        void this.close();
    }
}

/**
 * Split a ProxyCommand value into argv tokens.
 *
 * ssh-config v5.0.0 reassembles ProxyCommand's value into a single string (to
 * preserve quoting across the param boundary), but the spawn code expects
 * individual argv tokens. Calling `[].concat(someString)` does NOT split the
 * string — it wraps it, so `spawn()` ends up receiving the whole command
 * line as the executable path and fails with ENOENT. See
 * https://github.com/jeanp413/open-remote-ssh/issues/271 and
 * https://github.com/jeanp413/open-remote-ssh/issues/273.
 *
 * This helper mirrors OpenSSH's own ProxyCommand tokenization:
 * - whitespace separates tokens (outside quotes)
 * - double quotes group a single token
 * - backslash escapes the next character
 *
 * Array inputs are passed through for defensive compatibility with older
 * ssh-config versions.
 */
function splitProxyCommand(value: string | string[]): string[] {
    if (Array.isArray(value)) {return value.slice();}
    const out: string[] = [];
    let cur = '';
    let i = 0;
    let quoted = false;
    let hasToken = false;
    while (i < value.length) {
        const ch = value[i];
        if (ch === '\\' && i + 1 < value.length) {
            cur += value[i + 1];
            i += 2;
            hasToken = true;
            continue;
        }
        if (ch === '"') {
            quoted = !quoted;
            hasToken = true;
            i += 1;
            continue;
        }
        if (!quoted && /\s/.test(ch)) {
            if (hasToken) { out.push(cur); cur = ''; hasToken = false; }
            i += 1;
            continue;
        }
        cur += ch;
        hasToken = true;
        i += 1;
    }
    if (hasToken) {out.push(cur);}
    return out;
}

export class RemoteSSHResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {

    private proxyConnections: SSHConnection[] = [];
    private sshConnection: SSHConnection | undefined;
    private sshAgentSock: string | undefined;
    private proxyCommandProcess: cp.ChildProcessWithoutNullStreams | undefined;
    private agentForwardSession: ssh2.ClientChannel | undefined;

    private tunnels: TunnelInfo[] = [];

    private labelFormatterDisposable: vscode.Disposable | undefined;
    private readonly serverManager: RemoteServerManager;
    private resolveInFlight: Thenable<vscode.ResolverResult> | undefined;
    private resolvingAuthority: string | undefined;
    private readonly lastServerStates = new Map<string, {
        endpoint: number | string;
        logFile: string;
        platform: string;
        managementConnectionCount: number | undefined;
    }>();
    private readonly rotatedServerAuthorities = new Set<string>();
    private disposed = false;

    constructor(
        readonly context: vscode.ExtensionContext,
        readonly logger: Log
    ) {
        this.serverManager = new RemoteServerManager(context, logger);
    }

    resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        if (this.disposed) {
            throw new Error('Remote SSH resolver has been disposed');
        }
        if (this.resolveInFlight) {
            if (this.resolvingAuthority === authority) {
                this.logger.trace('Sharing the in-flight SSH authority resolution');
                return this.resolveInFlight;
            }
            throw new Error(`Cannot resolve '${authority}' while '${this.resolvingAuthority}' is still connecting`);
        }

        const resolvePromise = this.resolveAuthority(authority, context);
        this.resolveInFlight = resolvePromise;
        this.resolvingAuthority = authority;
        const clearInFlight = () => {
            if (this.resolveInFlight === resolvePromise) {
                this.resolveInFlight = undefined;
                this.resolvingAuthority = undefined;
            }
        };
        void Promise.resolve(resolvePromise).then(clearInFlight, clearInFlight);
        return resolvePromise;
    }

    private resolveAuthority(authority: string, context: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        const resolveStarted = performance.now();
        const [type, dest] = authority.split('+');
        if (type !== REMOTE_SSH_AUTHORITY) {
            throw new Error(`Invalid authority type for SSH resolver: ${type}`);
        }

        this.logger.info(`Resolving ssh remote authority '${authority}' (attempt #${context.resolveAttempt})`);

        const sshDest = SSHDestination.parseEncoded(dest);

        // It looks like default values are not loaded yet when resolving a remote,
        // so let's hardcode the default values here
        const remoteSSHconfig = vscode.workspace.getConfiguration('remote.SSH');
        const enableAgentForwarding = remoteSSHconfig.get<boolean>('enableAgentForwarding', true)!;
        const serverDownloadUrlTemplate = remoteSSHconfig.get<string>('serverDownloadUrlTemplate');
        const serverVersion = remoteSSHconfig.get<ServerVersion>('serverVersion', 'match');
        const defaultExtensions = remoteSSHconfig.get<string[]>('defaultExtensions', []);
        const remotePlatformMap = remoteSSHconfig.get<Record<string, string>>('remotePlatform', {});
        const remoteServerListenOnSocket = remoteSSHconfig.get<boolean>('remoteServerListenOnSocket', false)!;
        const connectTimeout = remoteSSHconfig.get<number>('connectTimeout', 60)!;
        const serverAliveInterval = remoteSSHconfig.get<number>('serverAliveInterval', DEFAULT_SSH_KEEPALIVE.serverAliveInterval)!;
        const serverAliveCountMax = remoteSSHconfig.get<number>('serverAliveCountMax', DEFAULT_SSH_KEEPALIVE.serverAliveCountMax)!;
        const serverInstallPathMap = remoteSSHconfig.get<Record<string, string>>('serverInstallPath', {});
        const keepaliveDefaults = { serverAliveInterval, serverAliveCountMax };

        return vscode.window.withProgress({
            title: `Setting up SSH Host ${sshDest.hostname}`,
            location: vscode.ProgressLocation.Notification,
            cancellable: false
        }, async () => {
            try {
                const previousTunnelActivity = this.sshConnection?.getTunnelActivity();
                const previousServerState = this.lastServerStates.get(authority);
                let managementConnectionEstablished: boolean | undefined;
                if (this.sshConnection && previousServerState?.managementConnectionCount !== undefined) {
                    const currentCount = await this.serverManager.getManagementConnectionCount(
                        this.sshConnection,
                        previousServerState.logFile,
                        previousServerState.platform
                    );
                    if (currentCount !== undefined) {
                        managementConnectionEstablished = currentCount > previousServerState.managementConnectionCount;
                    }
                }
                if (managementConnectionEstablished === true
                    || managementConnectionEstablished === undefined && previousTunnelActivity?.remoteToLocalBytes) {
                    // The previous generation completed real protocol traffic.
                    // Preserve it for normal reconnection and allow one future
                    // failed management-connection episode to rotate independently.
                    this.rotatedServerAuthorities.delete(authority);
                }
                const previousEndpoint = previousServerState?.endpoint;
                const replaceServerEndpoint = shouldRotateServerOnRetry(
                    context.resolveAttempt,
                    previousTunnelActivity,
                    this.rotatedServerAuthorities.has(authority),
                    previousEndpoint,
                    managementConnectionEstablished
                ) ? previousEndpoint : undefined;
                if (previousTunnelActivity) {
                    this.logger.trace(
                        `Previous tunnel activity: ${previousTunnelActivity.acceptedConnections} connection(s), `
                        + `${previousTunnelActivity.localToRemoteBytes} bytes sent, `
                        + `${previousTunnelActivity.remoteToLocalBytes} bytes received`
                        + (managementConnectionEstablished === undefined
                            ? ''
                            : `, management connection ${managementConnectionEstablished ? 'established' : 'not established'}`)
                    );
                }

                // VS Code invokes the resolver again after a transport failure. Tear
                // down the previous listener/session before replacing its references;
                // otherwise every reconnect leaks an SSH client and a loopback port.
                await this.closeSession();

                const sshconfigStarted = performance.now();
                const sshconfig = await SSHConfiguration.loadFromFS();
                this.logger.trace(`Performance: SSH config loaded in ${Math.round(performance.now() - sshconfigStarted)}ms`);
                const sshHostConfig = sshconfig.getHostConfiguration(sshDest.hostname);
                const sshHostName = sshHostConfig['HostName'] ? sshHostConfig['HostName'].replace('%h', sshDest.hostname) : sshDest.hostname;
                const sshUser = sshHostConfig['User'] || sshDest.user || os.userInfo().username || ''; // https://github.com/openssh/openssh-portable/blob/5ec5504f1d328d5bfa64280cd617c3efec4f78f3/sshconnect.c#L1561-L1562
                const sshPort = sshHostConfig['Port'] ? parseInt(sshHostConfig['Port'], 10) : (sshDest.port || 22);

                this.sshAgentSock = sshHostConfig['IdentityAgent'] || process.env['SSH_AUTH_SOCK'] || (isWindows ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
                this.sshAgentSock = this.sshAgentSock ? untildify(this.sshAgentSock) : undefined;
                const agentForward = enableAgentForwarding && (sshHostConfig['ForwardAgent'] || 'no').toLowerCase() === 'yes';
                const agent = agentForward && this.sshAgentSock ? new ssh2.OpenSSHAgent(this.sshAgentSock) : undefined;

                const preferredAuthentications = sshHostConfig['PreferredAuthentications'] ? sshHostConfig['PreferredAuthentications'].split(',').map(s => s.trim()) : ['publickey', 'password', 'keyboard-interactive'];

                const identityFiles: string[] = (sshHostConfig['IdentityFile'] as unknown as string[]) || [];
                const identitiesOnly = (sshHostConfig['IdentitiesOnly'] || 'no').toLowerCase() === 'yes';
                const identityStarted = performance.now();
                const identityKeys = await gatherIdentityFiles(identityFiles, this.sshAgentSock, identitiesOnly, this.logger);
                this.logger.trace(`Performance: identities loaded in ${Math.round(performance.now() - identityStarted)}ms`);

                // Create proxy jump connections if any
                let proxyStream: ssh2.ClientChannel | stream.Duplex | undefined;
                const routeParts: string[] = [];
                if (sshHostConfig['ProxyJump']) {
                    const proxyJumps = sshHostConfig['ProxyJump'].split(',').filter(i => !!i.trim())
                        .map(i => {
                            const proxy = SSHDestination.parse(i);
                            const proxyHostConfig = sshconfig.getHostConfiguration(proxy.hostname);
                            return [proxy, proxyHostConfig] as [SSHDestination, Record<string, string>];
                        });
                    for (let i = 0; i < proxyJumps.length; i++) {
                        const [proxy, proxyHostConfig] = proxyJumps[i];
                        const proxyHostName = proxyHostConfig['HostName'] || proxy.hostname;
                        const proxyUser = proxyHostConfig['User'] || proxy.user || sshUser;
                        const proxyPort = proxyHostConfig['Port'] ? parseInt(proxyHostConfig['Port'], 10) : (proxy.port || 22);
                        routeParts.push(`jump:${proxyUser}@${proxyHostName}:${proxyPort}`);

                        const proxyAgentForward = enableAgentForwarding && (proxyHostConfig['ForwardAgent'] || 'no').toLowerCase() === 'yes';
                        const proxyAgent = proxyAgentForward && this.sshAgentSock ? new ssh2.OpenSSHAgent(this.sshAgentSock) : undefined;

                        const proxyIdentityFiles: string[] = (proxyHostConfig['IdentityFile'] as unknown as string[]) || [];
                        const proxyIdentitiesOnly = (proxyHostConfig['IdentitiesOnly'] || 'no').toLowerCase() === 'yes';
                        const proxyIdentityKeys = await gatherIdentityFiles(proxyIdentityFiles, this.sshAgentSock, proxyIdentitiesOnly, this.logger);

                        const proxyAuthHandler = this.getSSHAuthHandler(proxyUser, proxyHostName, proxyIdentityKeys, preferredAuthentications);
                        const proxyKeepalive = resolveSSHKeepaliveConfig(proxyHostConfig, keepaliveDefaults);
                        const proxyConnection = new SSHConnection({
                            host: !proxyStream ? proxyHostName : undefined,
                            port: !proxyStream ? proxyPort : undefined,
                            sock: proxyStream,
                            username: proxyUser,
                            readyTimeout: connectTimeout * 1000,
                            ...proxyKeepalive,
                            strictVendor: false,
                            agentForward: proxyAgentForward,
                            agent: proxyAgent,
                            authHandler: (arg0, arg1, arg2) => (proxyAuthHandler(arg0, arg1, arg2), undefined)
                        });
                        this.proxyConnections.push(proxyConnection);

                        const nextProxyJump = i < proxyJumps.length - 1 ? proxyJumps[i + 1] : undefined;
                        const destIP = nextProxyJump ? (nextProxyJump[1]['HostName'] || nextProxyJump[0].hostname) : sshHostName;
                        const destPort = nextProxyJump ? ((nextProxyJump[1]['Port'] && parseInt(nextProxyJump[1]['Port'], 10)) || nextProxyJump[0].port || 22) : sshPort;
                        proxyStream = await proxyConnection.forwardOut('127.0.0.1', 0, destIP, destPort);
                    }
                } else if (sshHostConfig['ProxyCommand']) {
                    routeParts.push(`command:${sshHostConfig['ProxyCommand']}`);
                    let proxyArgs = splitProxyCommand(sshHostConfig['ProxyCommand'] as unknown as string | string[])
                        .map((arg) => arg.replace('%h', sshHostName).replace('%n', sshDest.hostname).replace('%p', sshPort.toString()).replace('%r', sshUser));
                    let proxyCommand = proxyArgs.shift()!;

                    let options = {};
                    if (isWindows && /\.(bat|cmd)$/.test(proxyCommand)) {
                        proxyCommand = `"${proxyCommand}"`;
                        proxyArgs = proxyArgs.map((arg) => arg.includes(' ') ? `"${arg}"` : arg);
                        options = { shell: true, windowsHide: true, windowsVerbatimArguments: true };
                    }

                    this.logger.trace(`Spawning ProxyCommand: ${proxyCommand} ${proxyArgs.join(' ')}`);

                    const child = cp.spawn(proxyCommand, proxyArgs, options);
                    proxyStream = stream.Duplex.from({ readable: child.stdout, writable: child.stdin });
                    this.proxyCommandProcess = child;
                }

                // Create final shh connection
                const sshAuthHandler = this.getSSHAuthHandler(sshUser, sshHostName, identityKeys, preferredAuthentications);
                const keepalive = resolveSSHKeepaliveConfig(sshHostConfig, keepaliveDefaults);
                this.logger.trace(`SSH keepalive: ${keepalive.keepaliveInterval === 0 ? 'disabled' : `${keepalive.keepaliveInterval}ms, ${keepalive.keepaliveCountMax} unanswered requests`}`);

                this.sshConnection = new SSHConnection({
                    host: !proxyStream ? sshHostName : undefined,
                    port: !proxyStream ? sshPort : undefined,
                    sock: proxyStream,
                    username: sshUser,
                    readyTimeout: connectTimeout * 1000,
                    ...keepalive,
                    strictVendor: false,
                    agentForward,
                    agent,
                    authHandler: (arg0, arg1, arg2) => (sshAuthHandler(arg0, arg1, arg2), undefined),
                    tunnelEventLogger: (message, error) => {
                        if (error) {
                            this.logger.error(message, error);
                        } else {
                            this.logger.trace(message);
                        }
                    },
                });
                const sshStarted = performance.now();
                await this.sshConnection.connect();
                this.logger.info(`Performance: SSH authenticated in ${Math.round(performance.now() - sshStarted)}ms`);

                const envVariables: Record<string, string | null> = {};
                if (agentForward) {
                    // The agent-forwarding socket sshd creates is scoped to the ssh channel that
                    // requested it and is torn down as soon as that channel closes. The server
                    // install/start script runs on its own short-lived exec channel, so any
                    // SSH_AUTH_SOCK it reports is already stale by the time we get here. Keep a
                    // dedicated channel open for the lifetime of the connection instead, and use
                    // its socket path everywhere else (terminals, extension host). Agent
                    // forwarding is best-effort: a failure here must not prevent connecting.
                    try {
                        const remoteAgentSock = await this.openAgentForwardSession();
                        if (remoteAgentSock) {
                            envVariables['SSH_AUTH_SOCK'] = remoteAgentSock;
                        }
                    } catch (e) {
                        this.logger.error(`Failed to setup agent forwarding`, e);
                    }
                }

                // Find the custom install path for this hostname (supports wildcards)
                const customInstallPath = findServerInstallPath(sshDest.hostname, serverInstallPathMap);

                const serverStarted = performance.now();
                const serverConfig = await getVSCodeServerConfig();
                const installResult = await this.serverManager.resolve(this.sshConnection, {
                    authority,
                    host: sshHostName,
                    port: sshPort,
                    user: sshUser,
                    serverConfig,
                    serverDownloadUrlTemplate,
                    serverVersion,
                    defaultExtensions,
                    platform: remotePlatformMap[sshDest.hostname],
                    useSocketPath: remoteServerListenOnSocket,
                    customInstallPath,
                    routeIdentity: routeParts.join('|'),
                    forceRefresh: context.resolveAttempt > 1,
                    extensionPath: this.context.extensionPath,
                    replaceServerEndpoint,
                });
                if (replaceServerEndpoint !== undefined) {
                    this.rotatedServerAuthorities.add(authority);
                    this.logger.info(`Rotated remote server endpoint after the editor tunnel failed to establish a management connection`);
                }
                this.lastServerStates.set(authority, {
                    endpoint: installResult.listeningOn,
                    logFile: installResult.logFile,
                    platform: installResult.platform,
                    managementConnectionCount: installResult.managementConnectionCount,
                });
                this.logger.info(`Performance: remote server ready in ${Math.round(performance.now() - serverStarted)}ms`);

                // Update terminal env variables
                this.context.environmentVariableCollection.persistent = false;
                this.context.environmentVariableCollection.delete('SSH_AUTH_SOCK');
                for (const [key, value] of Object.entries(envVariables)) {
                    if (value) {
                        this.context.environmentVariableCollection.replace(key, value);
                    }
                }

                // The remote management and extension-host channels share this
                // latency-sensitive listener, so connect it directly over SSH.
                const tunnelStarted = performance.now();
                const tunnelConfig = await this.openTunnel(0, installResult.listeningOn);
                this.tunnels.push(tunnelConfig);
                this.logger.info(`Performance: primary tunnel listening in ${Math.round(performance.now() - tunnelStarted)}ms`);

                // Enable ports view
                vscode.commands.executeCommand('setContext', 'forwardedPortsViewEnabled', true);

                this.labelFormatterDisposable?.dispose();
                this.labelFormatterDisposable = vscode.workspace.registerResourceLabelFormatter({
                    scheme: 'vscode-remote',
                    authority: `${REMOTE_SSH_AUTHORITY}+*`,
                    formatting: {
                        label: '${path}',
                        separator: '/',
                        tildify: true,
                        workspaceSuffix: `SSH: ${sshDest.hostname}` + (sshDest.port && sshDest.port !== 22 ? `:${sshDest.port}` : '')
                    }
                });

                const resolvedResult: vscode.ResolverResult = new vscode.ResolvedAuthority('127.0.0.1', tunnelConfig.localPort, installResult.connectionToken);
                resolvedResult.extensionHostEnv = envVariables;
                if (this.disposed) {
                    await this.closeSession();
                    throw new Error('Remote SSH resolver was disposed while connecting');
                }
                this.logger.info(`Performance: authority resolved in ${Math.round(performance.now() - resolveStarted)}ms`);
                return resolvedResult;
            } catch (e: unknown) {
                this.logger.error(`Error resolving authority`, e);
                await this.closeSession();

                // Initial connection
                if (context.resolveAttempt === 1 && !this.disposed) {
                    this.logger.show();

                    const closeRemote = 'Close Remote';
                    const retry = 'Retry';
                    const result = await vscode.window.showErrorMessage(`Could not establish connection to "${sshDest.hostname}"`, { modal: true }, closeRemote, retry);
                    if (result === closeRemote) {
                        await vscode.commands.executeCommand('workbench.action.remote.close');
                    } else if (result === retry) {
                        await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                }

                if (e instanceof ServerInstallError || !(e instanceof Error)) {
                    throw vscode.RemoteAuthorityResolverError.NotAvailable(e instanceof Error ? e.message : String(e));
                } else {
                    throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(e.message);
                }
            }
        });
    }

    private openAgentForwardSession(): Promise<string | undefined> {
        // No pty here on purpose: a pty echoes back whatever is written to the
        // channel before the remote shell executes it, which would otherwise be
        // mistaken for the command's actual output. `exec cat` keeps the process
        // (and therefore the channel's agent-forwarding socket) alive indefinitely
        // after printing the socket path once.
        return this.sshConnection!.execChannel('echo "$SSH_AUTH_SOCK"; exec cat').then(channel => {
            this.agentForwardSession?.close();
            this.agentForwardSession = channel;

            return new Promise<string | undefined>(resolve => {
                let buffer = '';
                let resolved = false;

                const finish = (value: string | undefined) => {
                    if (!resolved) {
                        resolved = true;
                        channel.removeListener('data', onData);
                        channel.removeListener('close', onClose);
                        clearTimeout(timer);
                        resolve(value);
                    }
                };

                const onData = (data: Buffer) => {
                    buffer += data.toString();
                    const newlineIdx = buffer.indexOf('\n');
                    if (newlineIdx < 0) {
                        return;
                    }
                    // A forwarded SSH_AUTH_SOCK is always an absolute path. Anything else
                    // (e.g. a non-POSIX remote echoing the command back verbatim) is rejected
                    // rather than exported as a bogus value.
                    const value = buffer.slice(0, newlineIdx).trim();
                    finish(value.startsWith('/') ? value : undefined);
                };

                // On a non-POSIX remote the `echo`d line ends the command and the channel
                // closes without a usable path; resolve now instead of waiting for the timeout.
                const onClose = () => finish(undefined);

                const timer = setTimeout(() => {
                    this.logger.trace('Timed out waiting for remote SSH_AUTH_SOCK');
                    finish(undefined);
                }, 5000);

                channel.on('data', onData);
                channel.on('close', onClose);
            });
        });
    }

    private async openTunnel(localPort: number, remotePortOrSocketPath: number | string) {
        const connection = this.sshConnection;
        if (!connection) {
            throw new Error('Cannot open a tunnel without an SSH connection');
        }
        const remotePort = typeof remotePortOrSocketPath === 'number' ? remotePortOrSocketPath : undefined;
        const remoteSocketPath = typeof remotePortOrSocketPath === 'string' ? remotePortOrSocketPath : undefined;
        this.logger.trace(`Opening tunnel ${localPort}(local) => ${remotePortOrSocketPath}(remote)`);
        const tunnelConfig = await connection.addTunnel({
            name: `ssh_tunnel_${localPort}_${remotePortOrSocketPath}`,
            remoteAddr: '127.0.0.1',
            remotePort,
            remoteSocketPath,
            localPort
        });
        localPort = tunnelConfig.localPort!;

        return new TunnelInfo(
            localPort,
            remotePortOrSocketPath,
            () => connection.closeTunnel(tunnelConfig.name)
        );
    }

    private getSSHAuthHandler(sshUser: string, sshHostName: string, identityKeys: SSHKey[], preferredAuthentications: string[]) {
        let passwordRetryCount = PASSWORD_RETRY_COUNT;
        let keyboardRetryCount = PASSWORD_RETRY_COUNT;
        let noneAttempted = false;
        identityKeys = identityKeys.slice();
        return async (methodsLeft: string[] | null, _partialSuccess: boolean | null, callback: (nextAuth: ssh2.AuthHandlerResult) => void) => {
            if (methodsLeft === null) {
                // ssh2 normally starts with a "none" request to discover the
                // server's methods. For the overwhelmingly common key-auth case
                // we already know both the preferred method and a usable key, so
                // submit it immediately and save one full network round trip.
                if (identityKeys.length && preferredAuthentications.includes('publickey')) {
                    methodsLeft = ['publickey'];
                } else {
                    this.logger.info(`Trying no-auth authentication`);
                    noneAttempted = true;
                    return callback({
                        type: 'none',
                        username: sshUser,
                    });
                }
            }
            if (methodsLeft.includes('publickey') && identityKeys.length && preferredAuthentications.includes('publickey')) {
                const identityKey = identityKeys.shift()!;

                if (identityKey.parsedKey) {
                    this.logger.info(`Trying publickey authentication: ${identityKey.filename} ${identityKey.parsedKey.type} SHA256:${identityKey.fingerprint}`);

                    if (identityKey.agentSupport) {
                        const { parsedKey } = identityKey;

                        return callback({
                            type: 'agent',
                            username: sshUser,
                            agent: new class extends ssh2.OpenSSHAgent {
                                // Only return the current key
                                override getIdentities(callback: (err: Error | undefined, publicKeys?: ParsedKey[]) => void): void {
                                    callback(undefined, [parsedKey]);
                                }
                            }(this.sshAgentSock!)
                        });
                    }
                    if (identityKey.isPrivate) {
                        return callback({
                            type: 'publickey',
                            username: sshUser,
                            key: identityKey.parsedKey
                        });
                    }
                }

                if (!await fileExists(identityKey.filename)) {
                    // Try next identity file
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return callback(null as any);
                }

                const keyBuffer = await fs.promises.readFile(identityKey.filename);
                let result = ssh2.utils.parseKey(keyBuffer); // First try without passphrase
                if (result instanceof Error && result.message.includes('but no passphrase given')) {
                    let passphraseRetryCount = PASSPHRASE_RETRY_COUNT;
                    while (result instanceof Error && passphraseRetryCount > 0) {
                        const passphrase = await vscode.window.showInputBox({
                            title: `Enter passphrase for ${identityKey.filename}`,
                            password: true,
                            ignoreFocusOut: true
                        });
                        if (!passphrase) {
                            break;
                        }
                        result = ssh2.utils.parseKey(keyBuffer, passphrase);
                        passphraseRetryCount--;
                    }
                }
                if (!result || result instanceof Error) {
                    // Try next identity file
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return callback(null as any);
                }

                const key = Array.isArray(result) ? result[0] : result;
                return callback({
                    type: 'publickey',
                    username: sshUser,
                    key
                });
            }
            if (methodsLeft.includes('password') && passwordRetryCount > 0 && preferredAuthentications.includes('password')) {
                if (passwordRetryCount === PASSWORD_RETRY_COUNT) {
                    this.logger.info(`Trying password authentication`);
                }

                const password = await vscode.window.showInputBox({
                    title: `Enter password for ${sshUser}@${sshHostName}`,
                    password: true,
                    ignoreFocusOut: true
                });
                passwordRetryCount--;

                return callback(password
                    ? {
                        type: 'password',
                        username: sshUser,
                        password
                    }
                    : false);
            }
            if (methodsLeft.includes('keyboard-interactive') && keyboardRetryCount > 0 && preferredAuthentications.includes('keyboard-interactive')) {
                if (keyboardRetryCount === PASSWORD_RETRY_COUNT) {
                    this.logger.info(`Trying keyboard-interactive authentication`);
                }

                return callback({
                    type: 'keyboard-interactive',
                    username: sshUser,
                    prompt: async (_name, _instructions, _instructionsLang, prompts, finish) => {
                        const responses: string[] = [];
                        for (const prompt of prompts) {
                            const response = await vscode.window.showInputBox({
                                title: `(${sshUser}@${sshHostName}) ${prompt.prompt}`,
                                password: !prompt.echo,
                                ignoreFocusOut: true
                            });
                            if (response === undefined) {
                                keyboardRetryCount = 0;
                                break;
                            }
                            responses.push(response);
                        }
                        keyboardRetryCount--;
                        finish(responses);
                    }
                });
            }

            // Direct public-key authentication saves a round trip, but an SSH
            // server may also allow an account to authenticate with "none".
            // Preserve that uncommon compatibility path after all configured
            // methods have been exhausted.
            if (!noneAttempted) {
                noneAttempted = true;
                this.logger.info(`Trying no-auth authentication`);
                return callback({
                    type: 'none',
                    username: sshUser,
                });
            }

            callback(false);
        };
    }

    private async closeSession(): Promise<void> {
        // Snapshot and detach every resource before the first await. This keeps
        // an overlapping dispose/reconnect cleanup from capturing resources
        // created by a newer resolution attempt.
        const tunnels = this.tunnels.splice(0);
        const agentForwardSession = this.agentForwardSession;
        this.agentForwardSession = undefined;
        const connection = this.sshConnection;
        this.sshConnection = undefined;
        const proxyConnections = this.proxyConnections.splice(0).reverse();
        const proxyCommandProcess = this.proxyCommandProcess;
        this.proxyCommandProcess = undefined;

        await Promise.allSettled(tunnels.map(tunnel => tunnel.close()));
        agentForwardSession?.close();
        if (connection) {
            await Promise.allSettled([connection.close()]);
        }

        // Close every jump in reverse order. Closing only the first jump tears
        // down the chain eventually, but leaves child Client objects and their
        // listeners retained until the transport notices.
        await Promise.allSettled(proxyConnections.map(proxyConnection => proxyConnection.close()));
        proxyCommandProcess?.kill();
    }

    dispose(): void {
        this.disposed = true;
        void this.closeSession();
        this.labelFormatterDisposable?.dispose();
        this.labelFormatterDisposable = undefined;
    }
}
