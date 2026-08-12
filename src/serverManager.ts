import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Log } from './common/logger';
import { IServerConfig, ServerVersion } from './serverConfig';
import { installCodeServer, normalizeExtensionIds, ServerInstallResult } from './serverSetup';
import SSHConnection from './ssh/sshConnection';

const SERVER_CACHE_SCHEMA_VERSION = 2;
const SERVER_CACHE_KEY_PREFIX = 'server-cache:';
const CACHE_PROBE_TIMEOUT_MS = 5_000;

type CachedServer = {
    schemaVersion: typeof SERVER_CACHE_SCHEMA_VERSION;
    cacheId: string;
    identity: string;
    listeningOn: number;
    connectionToken: string;
    logFile: string;
    platform: string;
    tmpDir: string;
};

export type RemoteServerOptions = {
    authority: string;
    host: string;
    port: number;
    user: string;
    serverConfig: IServerConfig;
    serverDownloadUrlTemplate: string | undefined;
    serverVersion: ServerVersion;
    defaultExtensions: string[];
    platform: string | undefined;
    useSocketPath: boolean;
    customInstallPath: string | undefined;
    routeIdentity: string;
    forceRefresh: boolean;
    extensionPath: string;
};

type InstallServer = typeof installCodeServer;

/**
 * Builds a stable identity for a cached server endpoint. The authority alone
 * is insufficient because an SSH alias can later point at another host, user,
 * port, install directory, or server binary.
 */
export function createServerCacheIdentity(options: RemoteServerOptions): string {
    const identity = JSON.stringify({
        authority: options.authority,
        host: options.host,
        port: options.port,
        user: options.user,
        serverConfig: {
            version: options.serverConfig.version,
            commit: options.serverConfig.commit,
            quality: options.serverConfig.quality,
            release: options.serverConfig.release,
            serverApplicationName: options.serverConfig.serverApplicationName,
            serverDataFolderName: options.serverConfig.serverDataFolderName,
            serverDownloadUrlTemplate: options.serverConfig.serverDownloadUrlTemplate ?? '',
            serverValidation: options.serverConfig.serverValidation,
        },
        serverDownloadUrlTemplate: options.serverDownloadUrlTemplate ?? '',
        serverVersion: options.serverVersion,
        defaultExtensions: normalizeExtensionIds(options.defaultExtensions),
        platform: options.platform ?? '',
        useSocketPath: options.useSocketPath,
        customInstallPath: options.customInstallPath ?? '',
        routeIdentity: options.routeIdentity,
    });

    return crypto.createHash('sha256').update(identity).digest('hex');
}

function isCachedServer(value: unknown): value is CachedServer {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const cache = value as Partial<CachedServer>;
    return cache.schemaVersion === SERVER_CACHE_SCHEMA_VERSION
        && typeof cache.cacheId === 'string'
        && cache.cacheId.length > 0
        && typeof cache.identity === 'string'
        && cache.identity.length > 0
        && Number.isInteger(cache.listeningOn)
        && cache.listeningOn! > 0
        && cache.listeningOn! <= 65535
        && typeof cache.connectionToken === 'string'
        && cache.connectionToken.length > 0
        && typeof cache.logFile === 'string'
        && cache.logFile.length > 0
        && typeof cache.platform === 'string'
        && cache.platform.length > 0
        && typeof cache.tmpDir === 'string'
        && cache.tmpDir.length > 0;
}

/**
 * Owns the remote VS Code Server lifecycle and its cross-window endpoint
 * cache. Keeping this out of the authority resolver makes the cache identity,
 * invalidation, and persistence rules independently testable.
 */
export class RemoteServerManager {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly logger: Log,
        private readonly installServer: InstallServer = installCodeServer
    ) {
    }

    async resolve(conn: SSHConnection, options: RemoteServerOptions): Promise<ServerInstallResult> {
        const cacheKey = `${SERVER_CACHE_KEY_PREFIX}${options.authority}`;
        const identity = createServerCacheIdentity(options);

        if (options.forceRefresh) {
            this.logger.trace('Bypassing remote server cache on a resolver retry');
        } else if (!options.useSocketPath) {
            const cached = await this.tryCachedServer(conn, cacheKey, identity);
            if (cached) {
                return cached;
            }
        }

        // A resolver retry deliberately bypasses the persisted endpoint, but
        // the exact-commit process can still be recovered safely by the remote
        // script's PID/token/log validation below.
        const cacheBeforeInstall = this.context.globalState.get<unknown>(cacheKey);

        const result = await this.installServer(conn, {
            serverConfig: options.serverConfig,
            serverDownloadUrlTemplate: options.serverDownloadUrlTemplate,
            serverVersion: options.serverVersion,
            extensionIds: options.defaultExtensions,
            envVariables: [],
            platform: options.platform,
            useSocketPath: options.useSocketPath,
            customInstallPath: options.customInstallPath,
            extensionPath: options.extensionPath,
        }, this.logger);

        if (!options.useSocketPath && typeof result.listeningOn === 'number') {
            await this.updateCacheIfUnchanged(cacheKey, cacheBeforeInstall, {
                schemaVersion: SERVER_CACHE_SCHEMA_VERSION,
                cacheId: crypto.randomUUID(),
                identity,
                listeningOn: result.listeningOn,
                connectionToken: result.connectionToken,
                logFile: result.logFile,
                platform: result.platform,
                tmpDir: result.tmpDir,
            });
        }

        return result;
    }

    private async updateCacheIfUnchanged(cacheKey: string, observedValue: unknown, value: CachedServer): Promise<void> {
        const currentValue = this.context.globalState.get<unknown>(cacheKey);
        const isSameGeneration = currentValue === undefined && observedValue === undefined
            || isCachedServer(currentValue) && isCachedServer(observedValue) && currentValue.cacheId === observedValue.cacheId;

        if (!isSameGeneration || isCachedServer(currentValue) && currentValue.identity !== value.identity) {
            this.logger.trace('Remote server cache changed during setup; keeping the newer entry');
            return;
        }

        await this.updateCache(cacheKey, value);
    }

    private async tryCachedServer(conn: SSHConnection, cacheKey: string, identity: string): Promise<ServerInstallResult | undefined> {
        const value = this.context.globalState.get<unknown>(cacheKey);
        if (!value) {
            return undefined;
        }

        if (!isCachedServer(value) || value.identity !== identity) {
            this.logger.trace('Discarding incompatible remote server cache entry');
            await this.invalidateCache(cacheKey, value);
            return undefined;
        }

        const started = performance.now();
        try {
            const probe = await this.probeCachedServer(conn, value.listeningOn);
            probe.close();
            this.logger.info(`Reused cached remote server in ${Math.round(performance.now() - started)}ms`);
            return {
                exitCode: 0,
                listeningOn: value.listeningOn,
                connectionToken: value.connectionToken,
                logFile: value.logFile,
                osReleaseId: '',
                arch: '',
                platform: value.platform,
                tmpDir: value.tmpDir,
            };
        } catch (error) {
            this.logger.trace(`Cached remote server was stale after ${Math.round(performance.now() - started)}ms`, error);
            await this.invalidateCache(cacheKey, value);
            return undefined;
        }
    }

    private probeCachedServer(conn: SSHConnection, listeningOn: number): ReturnType<SSHConnection['forwardOut']> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                settled = true;
                reject(new Error(`Cached remote server probe timed out after ${CACHE_PROBE_TIMEOUT_MS}ms`));
            }, CACHE_PROBE_TIMEOUT_MS);

            void conn.forwardOut('127.0.0.1', 0, '127.0.0.1', listeningOn).then(
                probe => {
                    clearTimeout(timeout);
                    if (settled) {
                        probe.close();
                        return;
                    }
                    settled = true;
                    resolve(probe);
                },
                error => {
                    clearTimeout(timeout);
                    if (!settled) {
                        settled = true;
                        reject(error);
                    }
                }
            );
        });
    }

    /**
     * Avoid deleting a cache entry that another window refreshed while this
     * window was probing an older endpoint. Memento has no compare-and-swap,
     * so the per-write cache id is used as a best-effort generation token.
     */
    private async invalidateCache(cacheKey: string, observedValue: unknown): Promise<void> {
        const currentValue = this.context.globalState.get<unknown>(cacheKey);

        if (isCachedServer(currentValue)) {
            if (!isCachedServer(observedValue) || currentValue.cacheId !== observedValue.cacheId) {
                this.logger.trace('Remote server cache changed while it was being checked; keeping the newer entry');
                return;
            }
        }

        await this.updateCache(cacheKey, undefined);
    }

    private async updateCache(cacheKey: string, value: CachedServer | undefined): Promise<void> {
        try {
            await this.context.globalState.update(cacheKey, value);
        } catch (error) {
            // Cache persistence is an optimization and must never make an
            // otherwise healthy SSH connection fail.
            this.logger.trace('Failed updating remote server cache', error);
        }
    }
}
