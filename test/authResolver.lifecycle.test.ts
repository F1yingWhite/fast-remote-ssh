import type * as cp from 'node:child_process';
import type * as ssh2 from 'ssh2';
import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { RemoteSSHResolver, shouldRotateServerOnRetry } from '../src/authResolver';
import { Log } from '../src/common/logger';
import SSHConnection from '../src/ssh/sshConnection';

type ResolverInternals = {
    resolveAuthority: (authority: string, context: vscode.RemoteAuthorityResolverContext) => Thenable<vscode.ResolverResult>;
    closeSession: () => Promise<void>;
    tunnels: Array<{ close(): Promise<void> }>;
    agentForwardSession: ssh2.ClientChannel | undefined;
    sshConnection: SSHConnection | undefined;
    proxyConnections: SSHConnection[];
    proxyCommandProcess: cp.ChildProcessWithoutNullStreams | undefined;
};

function createResolver(): RemoteSSHResolver {
    return new RemoteSSHResolver({} as vscode.ExtensionContext, new Log('Remote - SSH'));
}

describe('RemoteSSHResolver lifecycle', () => {
    it('rotates only a retry that never established a management connection', () => {
        const zeroResponse = {
            acceptedConnections: 2,
            localToRemoteBytes: 1024,
            remoteToLocalBytes: 0,
        };

        expect(shouldRotateServerOnRetry(2, zeroResponse, false, 41234, false)).toBe(true);
        expect(shouldRotateServerOnRetry(1, zeroResponse, false, 41234, false)).toBe(false);
        expect(shouldRotateServerOnRetry(2, zeroResponse, true, 41234, false)).toBe(false);
        expect(shouldRotateServerOnRetry(2, zeroResponse, false, undefined, false)).toBe(false);
        expect(shouldRotateServerOnRetry(2, { ...zeroResponse, acceptedConnections: 0 }, false, 41234, false)).toBe(false);
        expect(shouldRotateServerOnRetry(2, { ...zeroResponse, remoteToLocalBytes: 4096 }, false, 41234, false)).toBe(true);
        expect(shouldRotateServerOnRetry(31, zeroResponse, false, 41234, true)).toBe(false);
        expect(shouldRotateServerOnRetry(2, { ...zeroResponse, remoteToLocalBytes: 4096 }, false, 41234, undefined)).toBe(false);
    });

    it('shares a concurrent authority setup instead of creating competing sessions', async () => {
        const resolver = createResolver();
        const internals = resolver as unknown as ResolverInternals;
        let finish!: (result: vscode.ResolverResult) => void;
        const pending = new Promise<vscode.ResolverResult>(resolve => {
            finish = resolve;
        });
        const resolveAuthority = vi.spyOn(internals, 'resolveAuthority').mockReturnValue(pending);
        const context = {} as vscode.RemoteAuthorityResolverContext;

        const first = resolver.resolve('ssh-remote+example', context);
        const second = resolver.resolve('ssh-remote+example', context);

        expect(second).toBe(first);
        expect(resolveAuthority).toHaveBeenCalledOnce();
        expect(() => resolver.resolve('ssh-remote+other', context)).toThrow('while \'ssh-remote+example\' is still connecting');

        const result = {} as vscode.ResolverResult;
        finish(result);
        await expect(first).resolves.toBe(result);
        await Promise.resolve();

        const third = resolver.resolve('ssh-remote+example', context);
        expect(resolveAuthority).toHaveBeenCalledTimes(2);
        await expect(third).resolves.toBe(result);
        resolver.dispose();
    });

    it('snapshots old resources before awaiting and never closes a newer session', async () => {
        const resolver = createResolver();
        const internals = resolver as unknown as ResolverInternals;
        let releaseTunnel!: () => void;
        const tunnelReleased = new Promise<void>(resolve => {
            releaseTunnel = resolve;
        });
        const oldTunnel = { close: vi.fn(() => tunnelReleased) };
        const oldAgent = { close: vi.fn() } as unknown as ssh2.ClientChannel;
        const oldConnection = { close: vi.fn(async () => undefined) } as unknown as SSHConnection;
        const oldProxy = { close: vi.fn(async () => undefined) } as unknown as SSHConnection;
        const oldProcess = { kill: vi.fn() } as unknown as cp.ChildProcessWithoutNullStreams;
        internals.tunnels = [oldTunnel];
        internals.agentForwardSession = oldAgent;
        internals.sshConnection = oldConnection;
        internals.proxyConnections = [oldProxy];
        internals.proxyCommandProcess = oldProcess;

        const cleanup = internals.closeSession();

        const newTunnel = { close: vi.fn(async () => undefined) };
        const newConnection = { close: vi.fn(async () => undefined) } as unknown as SSHConnection;
        const newProcess = { kill: vi.fn() } as unknown as cp.ChildProcessWithoutNullStreams;
        internals.tunnels = [newTunnel];
        internals.sshConnection = newConnection;
        internals.proxyCommandProcess = newProcess;
        releaseTunnel();
        await cleanup;

        expect(oldTunnel.close).toHaveBeenCalledOnce();
        expect(oldAgent.close).toHaveBeenCalledOnce();
        expect(oldConnection.close).toHaveBeenCalledOnce();
        expect(oldProxy.close).toHaveBeenCalledOnce();
        expect(oldProcess.kill).toHaveBeenCalledOnce();
        expect(newTunnel.close).not.toHaveBeenCalled();
        expect(newConnection.close).not.toHaveBeenCalled();
        expect(newProcess.kill).not.toHaveBeenCalled();

        await internals.closeSession();
    });
});
