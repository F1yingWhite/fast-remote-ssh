import { once } from 'node:events';
import * as net from 'node:net';
import { PassThrough } from 'node:stream';
import type { ClientChannel } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import SSHConnection from '../src/ssh/sshConnection';

type ForwardCallback = (error: Error | undefined, stream: ClientChannel) => void;

function createConnection(forwardOut: (callback: ForwardCallback) => void) {
    const connection = new SSHConnection({ host: 'example.test', username: 'test' });
    const destroy = vi.fn();
    const client = {
        destroy,
        forwardOut: (
            _srcIP: string,
            _srcPort: number,
            _destIP: string,
            _destPort: number,
            callback: ForwardCallback
        ) => forwardOut(callback),
    };

    const connect = vi.spyOn(connection, 'connect').mockResolvedValue(connection);
    Reflect.set(connection, 'sshConnection', client);
    return { connection, connect, destroy };
}

describe('SSHConnection tunnel lifecycle', () => {
    it('binds the tunnel to loopback and closes its active sockets', async () => {
        const remoteStream = new PassThrough();
        const { connection } = createConnection(callback => callback(undefined, remoteStream as unknown as ClientChannel));
        const tunnel = await connection.addTunnel({
            name: 'primary',
            localPort: 0,
            remoteAddr: '127.0.0.1',
            remotePort: 12345,
        });

        const address = tunnel.server.address() as net.AddressInfo;
        expect(address.address).toBe('127.0.0.1');

        const socket = net.connect(address.port, address.address);
        await once(socket, 'connect');
        socket.write('ping');
        const [data] = await once(socket, 'data');
        expect(data.toString()).toBe('ping');

        await connection.closeTunnel('primary');
        if (!socket.destroyed) {
            await once(socket, 'close');
        }
        expect(socket.destroyed).toBe(true);
        expect(tunnel.server.listening).toBe(false);
    });

    it('destroys a late SSH channel when the local client has gone away', async () => {
        let forwardCallback: ForwardCallback | undefined;
        let markCallbackReady: (() => void) | undefined;
        const callbackReady = new Promise<void>(resolve => {
            markCallbackReady = resolve;
        });
        const { connection } = createConnection(callback => {
            forwardCallback = callback;
            markCallbackReady!();
        });
        const tunnel = await connection.addTunnel({
            name: 'primary',
            localPort: 0,
            remoteAddr: '127.0.0.1',
            remotePort: 12345,
        });

        const address = tunnel.server.address() as net.AddressInfo;
        const socket = net.connect(address.port, address.address);
        await once(socket, 'connect');
        await callbackReady;
        socket.destroy();
        await once(socket, 'close');
        await vi.waitFor(() => {
            expect(Reflect.get(connection.getTunnel('primary'), 'connections').size).toBe(0);
        });

        const remoteStream = new PassThrough();
        forwardCallback!(undefined, remoteStream as unknown as ClientChannel);
        expect(remoteStream.destroyed).toBe(true);

        await connection.closeTunnel('primary');
    });

    it('force-closes the transport and is idempotent', async () => {
        const { connection, connect, destroy } = createConnection(() => undefined);

        await connection.close();
        await connection.close();

        expect(destroy).toHaveBeenCalledTimes(1);
        connect.mockRestore();
        await expect(connection.connect()).rejects.toThrow('SSH connection has been closed');
    });

    it('returns the same cleanup promise to concurrent close callers', async () => {
        const { connection, destroy } = createConnection(() => undefined);
        let finishTunnelClose!: () => void;
        const tunnelClose = new Promise<void>(resolve => {
            finishTunnelClose = resolve;
        });
        vi.spyOn(connection, 'closeTunnel').mockReturnValue(tunnelClose);

        const first = connection.close();
        const second = connection.close();

        expect(second).toBe(first);
        expect(destroy).toHaveBeenCalledOnce();
        finishTunnelClose();
        await first;
    });

    it('shares an in-flight tunnel instead of leaking a duplicate listener', async () => {
        const { connection } = createConnection(() => undefined);
        const config = {
            name: 'primary',
            localPort: 0,
            remoteAddr: '127.0.0.1',
            remotePort: 12345,
        };

        const first = connection.addTunnel({ ...config });
        const second = connection.addTunnel({ ...config });
        const [firstTunnel, secondTunnel] = await Promise.all([first, second]);

        expect(secondTunnel).toBe(firstTunnel);
        await connection.closeTunnel('primary');
    });

    it('does not leave a pending listener behind when the connection closes', async () => {
        const { connection } = createConnection(() => undefined);
        const pending = connection.addTunnel({
            name: 'primary',
            localPort: 0,
            remoteAddr: '127.0.0.1',
            remotePort: 12345,
        });

        await connection.close();

        await expect(pending).rejects.toThrow('closed while opening the tunnel');
        await expect(connection.addTunnel({ name: 'another', localPort: 0 })).rejects.toThrow('SSH connection has been closed');
    });

    it('closes a named tunnel requested while its listener is still opening', async () => {
        const { connection } = createConnection(() => undefined);
        const pending = connection.addTunnel({
            name: 'primary',
            localPort: 0,
            remoteAddr: '127.0.0.1',
            remotePort: 12345,
        });

        await connection.closeTunnel('primary');
        const tunnel = await pending;

        expect(tunnel.server.listening).toBe(false);
        expect(connection.getTunnel('primary')).toBeUndefined();
    });
});
