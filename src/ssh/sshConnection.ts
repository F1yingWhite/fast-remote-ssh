// From https://github.com/sanketbajoria/ssh2-promise

import { EventEmitter } from 'events';
import * as net from 'net';
import * as fs from 'fs';
import { Client, ClientChannel, ClientErrorExtensions, ExecOptions, ShellOptions, ConnectConfig } from 'ssh2';
import { Server } from 'net';

export interface SSHConnectConfig extends ConnectConfig {
    /** Optional Unique ID attached to ssh connection. */
    uniqueId?: string;
    /** Path to private key */
    identity?: string | Buffer;
}

export interface SSHTunnelConfig {
    /** Remote Address to connect */
    remoteAddr?: string;
    /** Local port to bind to. By default, it will bind to a random port, if not passed */
    localPort?: number;
    /** Remote Port to connect */
    remotePort?: number;
    /** Remote socket path to connect */
    remoteSocketPath?: string;
    /**  Unique name */
    name?: string;
}

type ActiveTunnel = SSHTunnelConfig & {
    server: Server;
    connections: Set<net.Socket>;
};

const defaultOptions: Partial<SSHConnectConfig> = {
    port: 22,
};

const SSHConstants = {
    'CHANNEL': {
        SSH: 'ssh',
        TUNNEL: 'tunnel',
        X11: 'x11'
    },
    'STATUS': {
        BEFORECONNECT: 'beforeconnect',
        CONNECT: 'connect',
        BEFOREDISCONNECT: 'beforedisconnect',
        DISCONNECT: 'disconnect'
    }
};

export default class SSHConnection extends EventEmitter {
    public config: SSHConnectConfig;

    private activeTunnels: { [index: string]: ActiveTunnel } = {};
    private connectPromise: Promise<SSHConnection> | null = null;
    private sshConnection: Client | null = null;
    private closed = false;
    private transportClosed = false;
    private pendingTunnels = new Map<string, Promise<ActiveTunnel>>();
    private closePromise: Promise<void> | undefined;

    constructor(options: SSHConnectConfig) {
        super();
        this.config = Object.assign({}, defaultOptions, options);
        this.config.uniqueId = this.config.uniqueId || `${this.config.username}@${this.config.host}`;
    }

    /**
      * Emit message on this channel
      */
    override emit(channel: string, status: string, payload?: unknown): boolean {
        super.emit(channel, status, this, payload);
        return super.emit(`${channel}:${status}`, this, payload);
    }

    /**
     * Get shell socket
     */
    shell(options: ShellOptions = {}): Promise<ClientChannel> {
        return this.connect().then(() => {
            return new Promise<ClientChannel>((resolve, reject) => {
                this.sshConnection!.shell(options, (err, stream) => err ? reject(err) : resolve(stream));
            });
        });
    }

    /**
     * Start a command and return its channel as soon as it's opened, without
     * waiting for it to finish. Unlike shell(), no pty is allocated, so there's
     * no local echo of anything written to the channel.
     */
    execChannel(cmd: string, options: ExecOptions = {}): Promise<ClientChannel> {
        return this.connect().then(() => {
            return new Promise<ClientChannel>((resolve, reject) => {
                this.sshConnection!.exec(cmd, options, (err, stream) => err ? reject(err) : resolve(stream));
            });
        });
    }

    /**
     * Exec a command
     */
    exec(cmd: string, params?: Array<string>, options: ExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
        cmd += (Array.isArray(params) ? (' ' + params.join(' ')) : '');
        return this.connect().then(() => {
            return new Promise((resolve, reject) => {
                this.sshConnection!.exec(cmd, options, (err, stream) => {
                    if (err) {
                        return reject(err);
                    }
                    let stdout = '';
                    let stderr = '';
                    stream.on('close', function () {
                        return resolve({ stdout, stderr });
                    }).on('data', function (data: Buffer | string) {
                        stdout += data.toString();
                    }).stderr.on('data', function (data: Buffer | string) {
                        stderr += data.toString();
                    });
                });
            });
        });
    }

    /**
     * Exec a command
     */
    execPartial(cmd: string, tester: (stdout: string, stderr: string) => boolean, params?: Array<string>, options: ExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
        cmd += (Array.isArray(params) ? (' ' + params.join(' ')) : '');
        return this.connect().then(() => {
            return new Promise((resolve, reject) => {
                this.sshConnection!.exec(cmd, options, (err, stream) => {
                    if (err) {
                        return reject(err);
                    }
                    let stdout = '';
                    let stderr = '';
                    let resolved = false;
                    stream.on('close', function () {
                        if (!resolved) {
                            return resolve({ stdout, stderr });
                        }
                    }).on('data', function (data: Buffer | string) {
                        stdout += data.toString();

                        if (tester(stdout, stderr)) {
                            resolved = true;

                            return resolve({ stdout, stderr });
                        }
                    }).stderr.on('data', function (data: Buffer | string) {
                        stderr += data.toString();

                        if (tester(stdout, stderr)) {
                            resolved = true;

                            return resolve({ stdout, stderr });
                        }
                    });
                });
            });
        });
    }

    /**
     * Forward out
     */
    forwardOut(srcIP: string, srcPort: number, destIP: string, destPort: number): Promise<ClientChannel> {
        return this.connect().then(() => {
            return new Promise((resolve, reject) => {
                this.sshConnection!.forwardOut(srcIP, srcPort, destIP, destPort, (err, stream) => {
                    if (err) {
                        return reject(err);
                    }
                    resolve(stream);
                });
            });
        });
    }

    /**
     * Close SSH Connection
     */
    close(): Promise<void> {
        if (this.closePromise) {
            return this.closePromise;
        }
        this.closed = true;
        this.emit(SSHConstants.CHANNEL.SSH, SSHConstants.STATUS.BEFOREDISCONNECT);
        const client = this.sshConnection;
        this.connectPromise = null;
        // A half-open TCP connection may never finish a graceful end. Tear the
        // transport down before waiting for local listener shutdown.
        client?.destroy();
        this.closePromise = this.closeTunnel();
        return this.closePromise;
    }

    /**
     * Connect the SSH Connection
     */
    connect(c?: SSHConnectConfig): Promise<SSHConnection> {
        if (this.closed || this.transportClosed) {
            return Promise.reject(new Error(this.closed ? 'SSH connection has been closed' : 'SSH transport has been closed'));
        }
        this.config = Object.assign(this.config, c);

        if (this.connectPromise) {
            return this.connectPromise;
        }

        this.connectPromise = new Promise((resolve, reject) => {
            this.emit(SSHConstants.CHANNEL.SSH, SSHConstants.STATUS.BEFORECONNECT);
            if (!this.config || typeof this.config === 'function' || !(this.config.host || this.config.sock) || !this.config.username) {
                reject(new Error(`Invalid SSH connection configuration host/username can't be empty`));
                this.connectPromise = null;
                return;
            }

            if (this.config.identity) {
                if (fs.existsSync(this.config.identity)) {
                    this.config.privateKey = fs.readFileSync(this.config.identity);
                }
                delete this.config.identity;
            }

            //Start ssh server connection
            const client = new Client();
            this.sshConnection = client;
            let settled = false;
            let connectionError: Error & ClientErrorExtensions | undefined;
            const rejectBeforeReady = (error: Error) => {
                if (!settled) {
                    settled = true;
                    this.connectPromise = null;
                    reject(error);
                }
            };
            client.on('ready', () => {
                settled = true;
                this.emit(SSHConstants.CHANNEL.SSH, SSHConstants.STATUS.CONNECT);
                resolve(this);
            }).on('error', (err) => {
                connectionError = err;
                this.transportClosed = true;
                rejectBeforeReady(err);
            }).on('close', () => {
                this.transportClosed = true;
                this.connectPromise = null;
                if (this.sshConnection === client) {
                    this.sshConnection = null;
                }
                this.emit(SSHConstants.CHANNEL.SSH, SSHConstants.STATUS.DISCONNECT, { err: connectionError });
                rejectBeforeReady(connectionError ?? new Error('SSH connection closed before authentication completed'));
            }).connect(this.config);

            // Client#setNoDelay is public in the ssh2 runtime used by this
            // extension, but is missing from the older bundled type declaration.
            const transport = client as Client & { setNoDelay(enabled: boolean): Client };
            transport.setNoDelay(true);
        });
        return this.connectPromise;
    }

    /**
     * Get existing tunnel by name
     */
    getTunnel(name: string) {
        return this.activeTunnels[name];
    }

    /**
     * Add new tunnel if not exist
     */
    addTunnel(SSHTunnelConfig: SSHTunnelConfig): Promise<ActiveTunnel> {
        if (this.closed) {
            return Promise.reject(new Error('SSH connection has been closed'));
        }
        SSHTunnelConfig.name = SSHTunnelConfig.name || `${SSHTunnelConfig.remoteAddr}@${SSHTunnelConfig.remotePort || SSHTunnelConfig.remoteSocketPath}`;
        this.emit(SSHConstants.CHANNEL.TUNNEL, SSHConstants.STATUS.BEFORECONNECT, { SSHTunnelConfig: SSHTunnelConfig });
        if (this.getTunnel(SSHTunnelConfig.name)) {
            this.emit(SSHConstants.CHANNEL.TUNNEL, SSHConstants.STATUS.CONNECT, { SSHTunnelConfig: SSHTunnelConfig });
            return Promise.resolve(this.getTunnel(SSHTunnelConfig.name));
        }

        const pendingTunnel = this.pendingTunnels.get(SSHTunnelConfig.name);
        if (pendingTunnel) {
            return pendingTunnel;
        }

        const tunnelPromise = new Promise<ActiveTunnel>((resolve, reject) => {
            const connections = new Set<net.Socket>();
            const server = net.createServer()
                .on('connection', (socket) => {
                    this.connectTunnelSocket(socket, SSHTunnelConfig);
                });

            SSHTunnelConfig.localPort = SSHTunnelConfig.localPort || 0;
            server.on('connection', (socket: net.Socket) => {
                connections.add(socket);
                socket.once('close', () => connections.delete(socket));
            });
            server.on('listening', () => {
                if (this.closed) {
                    for (const socket of connections) {
                        socket.destroy();
                    }
                    server.close();
                    reject(new Error('SSH connection was closed while opening the tunnel'));
                    return;
                }
                SSHTunnelConfig.localPort = (server.address() as net.AddressInfo).port;
                this.activeTunnels[SSHTunnelConfig.name!] = Object.assign({}, { server, connections }, SSHTunnelConfig);
                this.emit(SSHConstants.CHANNEL.TUNNEL, SSHConstants.STATUS.CONNECT, { SSHTunnelConfig: SSHTunnelConfig });
                resolve(this.activeTunnels[SSHTunnelConfig.name!]);
            }).on('error', (err: unknown) => {
                this.emit(SSHConstants.CHANNEL.TUNNEL, SSHConstants.STATUS.DISCONNECT, { SSHTunnelConfig: SSHTunnelConfig, err: err });
                if (this.activeTunnels[SSHTunnelConfig.name!]) {
                    void this.closeTunnel(SSHTunnelConfig.name);
                } else {
                    if (server.listening) {
                        server.close();
                    }
                    reject(err);
                }
            }).listen(SSHTunnelConfig.localPort, '127.0.0.1');
        });
        const trackedPromise = tunnelPromise.then(
            tunnel => {
                this.pendingTunnels.delete(SSHTunnelConfig.name!);
                return tunnel;
            },
            error => {
                this.pendingTunnels.delete(SSHTunnelConfig.name!);
                throw error;
            }
        );
        this.pendingTunnels.set(SSHTunnelConfig.name, trackedPromise);
        return trackedPromise;
    }

    private connectTunnelSocket(socket: net.Socket, config: SSHTunnelConfig): void {
        socket.setNoDelay(true);

        let remoteStream: ClientChannel | undefined;
        const destroyRemote = () => {
            if (remoteStream && !remoteStream.destroyed) {
                remoteStream.destroy();
            }
        };
        const fail = (error: Error) => {
            this.emit(SSHConstants.CHANNEL.TUNNEL, SSHConstants.STATUS.DISCONNECT, { SSHTunnelConfig: config, err: error });
            destroyRemote();
            socket.destroy();
        };
        // Install these before opening the SSH channel: a renderer can close or
        // reset its local socket while forwardOut is still in flight.
        socket.once('close', destroyRemote);
        socket.once('error', fail);

        const connected = (error: Error | undefined, channel: ClientChannel) => {
            if (error) {
                fail(error);
                return;
            }
            if (socket.destroyed) {
                channel.destroy();
                return;
            }
            remoteStream = channel;

            const destroyLocal = () => {
                if (!socket.destroyed) {
                    socket.destroy();
                }
            };

            channel.once('close', destroyLocal);
            channel.once('error', (streamError) => {
                this.emit(SSHConstants.CHANNEL.TUNNEL, SSHConstants.STATUS.DISCONNECT, { SSHTunnelConfig: config, err: streamError });
                destroyLocal();
            });

            socket.pipe(channel);
            channel.pipe(socket);
        };

        void this.connect().then(() => {
            const client = this.sshConnection;
            if (!client || this.closed || socket.destroyed) {
                socket.destroy();
                return;
            }
            if (config.remotePort) {
                client.forwardOut('127.0.0.1', 0, config.remoteAddr!, config.remotePort, connected);
            } else {
                client.openssh_forwardOutStreamLocal(config.remoteSocketPath!, connected);
            }
        }).catch(fail);
    }

    /**
     * Close the tunnel
     */
    closeTunnel(name?: string): Promise<void> {
        if (name && this.activeTunnels[name]) {
            return new Promise((resolve) => {
                const tunnel = this.activeTunnels[name];
                delete this.activeTunnels[name];
                this.emit(
                    SSHConstants.CHANNEL.TUNNEL,
                    SSHConstants.STATUS.BEFOREDISCONNECT,
                    { SSHTunnelConfig: tunnel }
                );

                for (const socket of tunnel.connections) {
                    socket.destroy();
                }

                const finish = () => {
                    this.emit(
                        SSHConstants.CHANNEL.TUNNEL,
                        SSHConstants.STATUS.DISCONNECT,
                        { SSHTunnelConfig: tunnel }
                    );
                    resolve();
                };

                if (!tunnel.server.listening) {
                    finish();
                    return;
                }

                tunnel.server.close(finish);
            });
        } else if (name && this.pendingTunnels.has(name)) {
            return this.pendingTunnels.get(name)!.then(
                () => this.closeTunnel(name),
                () => undefined
            );
        } else if (!name) {
            const pending = [...this.pendingTunnels.values()];
            return Promise.allSettled(pending).then(() => {
                const tunnels = Object.keys(this.activeTunnels).map((key) => this.closeTunnel(key));
                return Promise.all(tunnels).then(() => { });
            });
        }

        return Promise.resolve();
    }

}
