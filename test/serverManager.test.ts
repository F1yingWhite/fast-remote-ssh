import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { Log } from '../src/common/logger';
import { IServerConfig } from '../src/serverConfig';
import { createServerCacheIdentity, RemoteServerManager, RemoteServerOptions } from '../src/serverManager';
import { installCodeServer, ServerInstallResult } from '../src/serverSetup';
import SSHConnection from '../src/ssh/sshConnection';

const SERVER_CONFIG: IServerConfig = {
    version: '1.126.0',
    commit: '0123456789abcdef',
    quality: 'stable',
    release: '4524',
    serverApplicationName: 'codium-server',
    serverDataFolderName: '.vscodium-server',
    serverDownloadUrlTemplate: 'https://example.test/${commit}/${os}/${arch}',
    serverValidation: 'strict',
};

const OPTIONS: RemoteServerOptions = {
    authority: 'ssh-remote+example',
    host: 'server.example.test',
    port: 22,
    user: 'developer',
    serverConfig: SERVER_CONFIG,
    serverDownloadUrlTemplate: undefined,
    serverVersion: 'match',
    defaultExtensions: [],
    platform: 'linux',
    useSocketPath: false,
    customInstallPath: undefined,
    routeIdentity: '',
    forceRefresh: false,
    extensionPath: '/extension',
};

const INSTALL_RESULT: ServerInstallResult = {
    exitCode: 0,
    listeningOn: 41234,
    connectionToken: 'connection-token',
    logFile: '/home/developer/.vscodium-server/.commit.log',
    osReleaseId: 'ubuntu',
    arch: 'x64',
    platform: 'linux',
    tmpDir: '/tmp',
};

function createContext(initialState: Record<string, unknown> = {}) {
    const state = new Map(Object.entries(initialState));
    const update = vi.fn(async (key: string, value: unknown) => {
        if (value === undefined) {
            state.delete(key);
        } else {
            state.set(key, value);
        }
    });
    const context = {
        globalState: {
            get: <T>(key: string): T | undefined => state.get(key) as T | undefined,
            update,
        },
    } as unknown as vscode.ExtensionContext;

    return { context, state, update };
}

function createLogger(): Log {
    return {
        trace: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    } as unknown as Log;
}

function createConnection(forwardOut = vi.fn()): SSHConnection {
    return { forwardOut } as unknown as SSHConnection;
}

function createInstaller(result: ServerInstallResult = INSTALL_RESULT) {
    return vi.fn(async () => ({ ...result })) as unknown as typeof installCodeServer;
}

describe('createServerCacheIdentity', () => {
    it('normalizes extension order, casing, duplicates, and invalid ids', () => {
        const first = createServerCacheIdentity({
            ...OPTIONS,
            defaultExtensions: ['Publisher.One', 'publisher.two', 'publisher.one', 'invalid'],
        });
        const second = createServerCacheIdentity({
            ...OPTIONS,
            defaultExtensions: ['PUBLISHER.TWO', 'publisher.one'],
        });

        expect(first).toBe(second);
    });

    it('changes for every server input that can select or configure a different runtime', () => {
        const identity = createServerCacheIdentity(OPTIONS);
        const variants: RemoteServerOptions[] = [
            { ...OPTIONS, host: 'other.example.test' },
            { ...OPTIONS, port: 2222 },
            { ...OPTIONS, user: 'other' },
            { ...OPTIONS, serverVersion: '1.125.0' },
            { ...OPTIONS, defaultExtensions: ['publisher.extension'] },
            { ...OPTIONS, platform: 'macos' },
            { ...OPTIONS, useSocketPath: true },
            { ...OPTIONS, customInstallPath: '/srv/codium' },
            { ...OPTIONS, routeIdentity: 'jump:bastion' },
            { ...OPTIONS, serverDownloadUrlTemplate: 'https://mirror.test/${commit}' },
            { ...OPTIONS, serverConfig: { ...SERVER_CONFIG, version: '1.127.0' } },
            { ...OPTIONS, serverConfig: { ...SERVER_CONFIG, commit: 'fedcba9876543210' } },
            { ...OPTIONS, serverConfig: { ...SERVER_CONFIG, quality: 'insider' } },
            { ...OPTIONS, serverConfig: { ...SERVER_CONFIG, release: '5000' } },
            { ...OPTIONS, serverConfig: { ...SERVER_CONFIG, serverApplicationName: 'code-server' } },
            { ...OPTIONS, serverConfig: { ...SERVER_CONFIG, serverDataFolderName: '.code-server' } },
            { ...OPTIONS, serverConfig: { ...SERVER_CONFIG, serverDownloadUrlTemplate: 'https://other.test/${commit}' } },
            { ...OPTIONS, serverConfig: { ...SERVER_CONFIG, serverValidation: 'skip' } },
        ];

        for (const variant of variants) {
            expect(createServerCacheIdentity(variant)).not.toBe(identity);
        }
    });
});

describe('RemoteServerManager', () => {
    it('counts management connections without exposing a quoted remote log path to the shell', async () => {
        const { context } = createContext();
        const exec = vi.fn(async () => ({ stdout: '7\n', stderr: '' }));
        const manager = new RemoteServerManager(context, createLogger(), createInstaller());

        const count = await manager.getManagementConnectionCount(
            { exec } as unknown as SSHConnection,
            `/home/developer/log's/server.log`,
            'linux'
        );

        expect(count).toBe(7);
        expect(exec.mock.calls[0][0]).toContain(`'/home/developer/log'"'"'s/server.log'`);
    });

    it('uses an encoded PowerShell probe for Windows management logs', async () => {
        const { context } = createContext();
        const exec = vi.fn(async () => ({ stdout: '3\r\n', stderr: '' }));
        const manager = new RemoteServerManager(context, createLogger(), createInstaller());

        const count = await manager.getManagementConnectionCount(
            { exec } as unknown as SSHConnection,
            'C:\\Users\\developer\\server.log',
            'win32'
        );

        expect(count).toBe(3);
        expect(exec.mock.calls[0][0]).toMatch(/^powershell .* -EncodedCommand [A-Za-z0-9+/=]+$/);
    });

    it('reuses a live compatible cache entry without reinstalling', async () => {
        const { context } = createContext();
        const installServer = createInstaller();
        const close = vi.fn();
        const forwardOut = vi.fn().mockResolvedValue({ close });
        const conn = createConnection(forwardOut);
        const manager = new RemoteServerManager(context, createLogger(), installServer);

        await manager.resolve(conn, OPTIONS);
        const result = await manager.resolve(conn, OPTIONS);

        expect(installServer).toHaveBeenCalledTimes(1);
        expect(forwardOut).toHaveBeenCalledWith('127.0.0.1', 0, '127.0.0.1', INSTALL_RESULT.listeningOn);
        expect(close).toHaveBeenCalledOnce();
        expect(result.connectionToken).toBe(INSTALL_RESULT.connectionToken);
    });

    it('invalidates the cache and reruns setup when defaultExtensions changes', async () => {
        const { context, update } = createContext();
        const installServer = createInstaller();
        const conn = createConnection();
        const manager = new RemoteServerManager(context, createLogger(), installServer);

        await manager.resolve(conn, OPTIONS);
        await manager.resolve(conn, { ...OPTIONS, defaultExtensions: ['publisher.extension'] });

        expect(installServer).toHaveBeenCalledTimes(2);
        expect(update).toHaveBeenCalledWith(`server-cache:${OPTIONS.authority}`, undefined);
    });

    it('clears a stale endpoint, falls back to setup, and stores the replacement', async () => {
        const { context, state, update } = createContext();
        const installServer = createInstaller();
        const forwardOut = vi.fn().mockRejectedValue(new Error('connection refused'));
        const manager = new RemoteServerManager(context, createLogger(), installServer);

        await manager.resolve(createConnection(), OPTIONS);
        await manager.resolve(createConnection(forwardOut), OPTIONS);

        expect(installServer).toHaveBeenCalledTimes(2);
        expect(update).toHaveBeenCalledWith(`server-cache:${OPTIONS.authority}`, undefined);
        expect(state.get(`server-cache:${OPTIONS.authority}`)).toMatchObject({
            listeningOn: INSTALL_RESULT.listeningOn,
            connectionToken: INSTALL_RESULT.connectionToken,
        });
    });

    it('bypasses an open but incorrectly authenticated endpoint on resolver retry', async () => {
        const { context, update } = createContext();
        const installServer = createInstaller();
        const forwardOut = vi.fn().mockResolvedValue({ close: vi.fn() });
        const manager = new RemoteServerManager(context, createLogger(), installServer);

        await manager.resolve(createConnection(), OPTIONS);
        await manager.resolve(createConnection(forwardOut), { ...OPTIONS, forceRefresh: true });

        expect(forwardOut).not.toHaveBeenCalled();
        expect(installServer).toHaveBeenCalledTimes(2);
        expect(update).not.toHaveBeenCalledWith(`server-cache:${OPTIONS.authority}`, undefined);
    });

    it('passes the failed endpoint to setup so it can rotate the server generation', async () => {
        const { context } = createContext();
        const installServer = createInstaller();
        const manager = new RemoteServerManager(context, createLogger(), installServer);

        await manager.resolve(createConnection(), {
            ...OPTIONS,
            forceRefresh: true,
            replaceServerEndpoint: 41234,
        });

        expect(installServer).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ replaceServerEndpoint: 41234 }),
            expect.anything()
        );
    });

    it('does not overwrite a cache entry refreshed by another window during setup', async () => {
        const cacheKey = `server-cache:${OPTIONS.authority}`;
        const { context, state } = createContext();
        let finishInstall!: (result: ServerInstallResult) => void;
        const installServer = vi.fn(() => new Promise<ServerInstallResult>(resolve => {
            finishInstall = resolve;
        })) as unknown as typeof installCodeServer;
        const manager = new RemoteServerManager(context, createLogger(), installServer);

        const resolving = manager.resolve(createConnection(), OPTIONS);
        await vi.waitFor(() => expect(installServer).toHaveBeenCalledOnce());
        const otherWindowCache = {
            schemaVersion: 2,
            cacheId: 'other-window-generation',
            identity: createServerCacheIdentity(OPTIONS),
            listeningOn: 42345,
            connectionToken: 'newer-token',
            logFile: '/tmp/newer.log',
            platform: 'linux',
            tmpDir: '/tmp',
        };
        state.set(cacheKey, otherWindowCache);
        finishInstall(INSTALL_RESULT);
        await resolving;

        expect(state.get(cacheKey)).toBe(otherWindowCache);
    });

    it('bounds a stalled cache probe and closes a channel that arrives late', async () => {
        const { context } = createContext();
        const seedManager = new RemoteServerManager(context, createLogger(), createInstaller());
        await seedManager.resolve(createConnection(), OPTIONS);

        let finishProbe!: (probe: { close(): void }) => void;
        const lateClose = vi.fn();
        const forwardOut = vi.fn(() => new Promise<{ close(): void }>(resolve => {
            finishProbe = resolve;
        }));
        const installServer = createInstaller({ ...INSTALL_RESULT, listeningOn: 42345 });
        const manager = new RemoteServerManager(context, createLogger(), installServer);

        vi.useFakeTimers();
        try {
            const resolving = manager.resolve(createConnection(forwardOut), OPTIONS);
            expect(forwardOut).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(5_000);
            const result = await resolving;
            expect(result.listeningOn).toBe(42345);

            finishProbe({ close: lateClose });
            await Promise.resolve();
            expect(lateClose).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not erase an entry refreshed by another window during a stale probe', async () => {
        const cacheKey = `server-cache:${OPTIONS.authority}`;
        const { context, state, update } = createContext();
        const seedManager = new RemoteServerManager(context, createLogger(), createInstaller());
        await seedManager.resolve(createConnection(), OPTIONS);

        const observed = state.get(cacheKey) as Record<string, unknown>;
        const refreshed = { ...observed, cacheId: 'new-window-generation', listeningOn: 42345 };
        update.mockClear();

        const forwardOut = vi.fn(async () => {
            state.set(cacheKey, refreshed);
            throw new Error('old endpoint is stale');
        });
        const failedInstall = vi.fn(async () => {
            throw new Error('setup failed');
        }) as unknown as typeof installCodeServer;
        const manager = new RemoteServerManager(context, createLogger(), failedInstall);

        await expect(manager.resolve(createConnection(forwardOut), OPTIONS)).rejects.toThrow('setup failed');
        expect(update).not.toHaveBeenCalledWith(cacheKey, undefined);
        expect(state.get(cacheKey)).toBe(refreshed);
    });
});
