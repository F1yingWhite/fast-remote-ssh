import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { Log } from '../src/common/logger';
import { IServerConfig } from '../src/serverConfig';
import {
    canAttemptFastServerReuse,
    InstallCodeServerOptions,
    installCodeServer,
    normalizeExtensionIds,
} from '../src/serverSetup';
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

const OPTIONS: InstallCodeServerOptions = {
    serverConfig: SERVER_CONFIG,
    serverDownloadUrlTemplate: undefined,
    serverVersion: 'match',
    extensionIds: [],
    envVariables: [],
    platform: 'linux',
    useSocketPath: false,
    customInstallPath: undefined,
    extensionPath: path.resolve('.'),
};

function createLogger(): Log {
    return {
        trace: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    } as unknown as Log;
}

function createConnection(methods: Partial<SSHConnection>): SSHConnection {
    return methods as SSHConnection;
}

function resultBlock(id: string, platform = 'linux', listeningOn = '41234'): string {
    return [
        `${id}: start`,
        'exitCode==0==',
        `listeningOn==${listeningOn}==`,
        'connectionToken==connection-token==',
        'logFile==/tmp/server.log==',
        'osReleaseId==ubuntu==',
        'arch==x64==',
        `platform==${platform}==`,
        'tmpDir==/tmp==',
        'managementConnectionCount==0==',
        `${id}: end`,
    ].join('\n');
}

function decodeBashInstallCommand(command: string): string {
    const encoded = /^echo ([A-Za-z0-9+/=]+) \| base64 -d \| bash -l$/.exec(command)?.[1];
    if (!encoded) {
        throw new Error(`Not a generated bash install command: ${command}`);
    }
    return Buffer.from(encoded, 'base64').toString('utf8');
}

function bashScriptId(script: string): string {
    const id = /echo "([a-f0-9]+): start"/.exec(script)?.[1];
    if (!id) {
        throw new Error('Generated bash script has no result marker');
    }
    return id;
}

function resolveTempDirFromGeneratedScript(script: string, xdgRuntimeDir: string): ReturnType<typeof spawnSync> {
    const lockStart = script.indexOf('\nLOCKFILE=');
    if (lockStart < 0) {
        throw new Error('Generated bash script has no install lock');
    }

    const probeScript = `${script.slice(0, lockStart)}\nprintf '__TMP_DIR__=%s\\n' "$TMP_DIR"\n`;
    return spawnSync('bash', ['-c', probeScript], {
        encoding: 'utf8',
        env: {
            ...process.env,
            XDG_RUNTIME_DIR: xdgRuntimeDir,
        },
    });
}

describe('server setup reuse policy', () => {
    it('normalizes actionable extension ids', () => {
        expect(normalizeExtensionIds([
            'Publisher.Two',
            'publisher.one',
            'PUBLISHER.ONE',
            'not-an-extension-id',
        ])).toEqual(['publisher.one', 'publisher.two']);
    });

    it('only uses the lightweight probe when it can prove all requirements', () => {
        expect(canAttemptFastServerReuse(OPTIONS)).toBe(true);
        expect(canAttemptFastServerReuse({ ...OPTIONS, extensionIds: ['publisher.extension'] })).toBe(false);
        expect(canAttemptFastServerReuse({ ...OPTIONS, envVariables: ['SSH_AUTH_SOCK'] })).toBe(false);
        expect(canAttemptFastServerReuse({ ...OPTIONS, serverVersion: 'closest' })).toBe(false);
        expect(canAttemptFastServerReuse({ ...OPTIONS, useSocketPath: true })).toBe(false);
        expect(canAttemptFastServerReuse({ ...OPTIONS, replaceServerEndpoint: 41234 })).toBe(false);
        expect(canAttemptFastServerReuse({
            ...OPTIONS,
            serverConfig: { ...SERVER_CONFIG, serverValidation: 'skip' },
        })).toBe(false);
    });

    it('reuses an exact strict/match server without running full setup', async () => {
        const exec = vi.fn(async (command: string) => {
            const marker = /open-remote-ssh-fast-[a-f0-9]+/.exec(command)?.[0];
            if (!marker) {
                throw new Error('Expected the fast recovery probe');
            }
            return { stdout: resultBlock(marker), stderr: '' };
        });
        const conn = createConnection({ exec } as unknown as Partial<SSHConnection>);

        const result = await installCodeServer(conn, OPTIONS, createLogger());

        expect(exec).toHaveBeenCalledOnce();
        expect(exec.mock.calls[0][0]).toMatch(/^bash -c /);
        expect(result.listeningOn).toBe(41234);
    });

    it('bypasses fast recovery and emits a running-server extension install path', async () => {
        let generatedScript = '';
        const exec = vi.fn(async (command: string) => {
            generatedScript = decodeBashInstallCommand(command);
            return { stdout: resultBlock(bashScriptId(generatedScript)), stderr: '' };
        });
        const conn = createConnection({ exec } as unknown as Partial<SSHConnection>);
        const options = {
            ...OPTIONS,
            extensionIds: ['Publisher.Extension', 'publisher.extension', 'invalid'],
        };

        await installCodeServer(conn, options, createLogger());

        expect(exec).toHaveBeenCalledOnce();
        expect(exec.mock.calls[0][0]).toMatch(/^echo /);
        expect(generatedScript).toContain('SERVER_INITIAL_EXTENSIONS="--install-extension publisher.extension"');
        expect(generatedScript).toContain('SERVER_INITIAL_EXTENSION_IDS=(\'publisher.extension\')');
        expect(generatedScript).toContain('"$SERVER_SCRIPT" "${SERVER_EXTENSION_ARGUMENTS[@]}" --accept-server-license-terms');
        expect(generatedScript).toContain('Error installing default extensions');
        expect(generatedScript).toContain('while ! mkdir "$LOCKDIR"');
        expect(generatedScript).toContain('[[ $ELAPSED -ge 10 ]]');
        expect(generatedScript).toContain('cannot record the portable install lock owner');
        expect(generatedScript).not.toContain('skipping install lock');
        expect(spawnSync('bash', ['-n'], { input: generatedScript }).status).toBe(0);
    });

    it('rotates away from the endpoint that failed the editor handshake', async () => {
        let generatedScript = '';
        const exec = vi.fn(async (command: string) => {
            generatedScript = decodeBashInstallCommand(command);
            return { stdout: resultBlock(bashScriptId(generatedScript)), stderr: '' };
        });
        const conn = createConnection({ exec } as unknown as Partial<SSHConnection>);

        await installCodeServer(conn, { ...OPTIONS, replaceServerEndpoint: 41234 }, createLogger());

        expect(exec).toHaveBeenCalledOnce();
        expect(generatedScript).toContain(`REPLACE_SERVER_ENDPOINT='41234'`);
        expect(generatedScript).toContain('select_new_server_generation');
        expect(generatedScript).toContain('Rotating unhealthy server endpoint');
        expect(generatedScript).toContain('Another resolver already replaced server endpoint');
        expect(generatedScript).toContain('SERVER_ACTIVEFILE_TMP=');
        expect(generatedScript).toContain('mv -f "$SERVER_ACTIVEFILE_TMP" "$SERVER_ACTIVEFILE"');
        expect(spawnSync('bash', ['-n'], { input: generatedScript }).status).toBe(0);
    });

    it('falls back to /tmp when XDG_RUNTIME_DIR is missing or not a directory', async () => {
        let generatedScript = '';
        const exec = vi.fn(async (command: string) => {
            generatedScript = decodeBashInstallCommand(command);
            return { stdout: resultBlock(bashScriptId(generatedScript)), stderr: '' };
        });
        const conn = createConnection({ exec } as unknown as Partial<SSHConnection>);

        await installCodeServer(conn, { ...OPTIONS, extensionIds: ['publisher.extension'] }, createLogger());

        const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-remote-ssh-runtime-'));
        try {
            const validRuntimeDir = path.join(testRoot, 'runtime');
            fs.mkdirSync(validRuntimeDir);
            const validResult = resolveTempDirFromGeneratedScript(generatedScript, validRuntimeDir);
            expect(validResult.status).toBe(0);
            expect(validResult.stdout).toContain(`__TMP_DIR__=${validRuntimeDir}`);
            expect(validResult.stderr).toBe('');

            const missingResult = resolveTempDirFromGeneratedScript(generatedScript, path.join(testRoot, 'missing'));
            expect(missingResult.status).toBe(0);
            expect(missingResult.stdout).toContain('__TMP_DIR__=/tmp');
            expect(missingResult.stderr).toContain('falling back to /tmp');
            expect(generatedScript).toContain('export XDG_RUNTIME_DIR="$TMP_DIR"');

            const filePath = path.join(testRoot, 'not-a-directory');
            fs.writeFileSync(filePath, 'not a directory');
            const fileResult = resolveTempDirFromGeneratedScript(generatedScript, filePath);
            expect(fileResult.status).toBe(0);
            expect(fileResult.stdout).toContain('__TMP_DIR__=/tmp');
            expect(fileResult.stderr).toContain('falling back to /tmp');
        } finally {
            fs.rmSync(testRoot, { recursive: true, force: true });
        }
    });

    it('emits the equivalent running-server extension install path on Windows', async () => {
        let installCommand = '';
        const exec = vi.fn(async () => ({
            stdout: '',
            stderr: 'FullyQualifiedErrorId : CommandNotFoundException',
        }));
        const execPartial = vi.fn(async (command: string) => {
            installCommand = command;
            const id = /([a-f0-9]+): end/.exec(command)?.[1];
            if (!id) {
                throw new Error('Generated PowerShell script has no result marker');
            }
            return { stdout: resultBlock(id, 'win32'), stderr: '' };
        });
        const conn = createConnection({ exec, execPartial } as unknown as Partial<SSHConnection>);

        await installCodeServer(conn, {
            ...OPTIONS,
            platform: 'windows',
            extensionIds: ['publisher.extension'],
        }, createLogger());

        expect(exec).toHaveBeenCalledWith('uname -s');
        expect(execPartial).toHaveBeenCalledOnce();
        expect(installCommand).toContain('$SERVER_INITIAL_EXTENSION_IDS=@("publisher.extension")');
        expect(installCommand).toContain('& $SERVER_SCRIPT @SERVER_EXTENSION_ARGUMENTS');
        expect(installCommand).toContain('Error installing default extensions');
        expect(installCommand).toContain('New-Object System.Threading.Mutex');
        expect(installCommand).toContain('[Security.Cryptography.SHA256]::Create()');
        expect(installCommand).toContain('FromSeconds(120)');
        expect(installCommand).toContain('$SERVER_CONNECTION_TOKEN=$null');
        expect(installCommand).toContain('$LISTENING_ON=$null');
        expect(installCommand).toContain('for($I = 1; $I -le 35; $I++)');
        expect(installCommand).toContain('if(!$LISTENING_ON)');
        expect(installCommand).toContain('if(!(gps -Id $SERVER_ID))');
    });

    it('emits generation rotation for a failed Windows endpoint', async () => {
        let installCommand = '';
        const exec = vi.fn(async () => ({
            stdout: '',
            stderr: 'FullyQualifiedErrorId : CommandNotFoundException',
        }));
        const execPartial = vi.fn(async (command: string) => {
            installCommand = command;
            const id = /([a-f0-9]+): end/.exec(command)?.[1];
            if (!id) {
                throw new Error('Generated PowerShell script has no result marker');
            }
            return { stdout: resultBlock(id, 'win32'), stderr: '' };
        });
        const conn = createConnection({ exec, execPartial } as unknown as Partial<SSHConnection>);

        await installCodeServer(conn, {
            ...OPTIONS,
            platform: 'windows',
            replaceServerEndpoint: 41234,
        }, createLogger());

        expect(installCommand).toContain(`$REPLACE_SERVER_ENDPOINT='41234'`);
        expect(installCommand).toContain('Select-NewServerGeneration');
        expect(installCommand).toContain('Rotating unhealthy server endpoint');
        expect(installCommand).toContain('Move-Item -Force $SERVER_ACTIVEFILE_TMP $SERVER_ACTIVEFILE');
    });

    it('fails before generating an invalid socket listener on Windows', async () => {
        const exec = vi.fn(async () => ({
            stdout: '',
            stderr: 'FullyQualifiedErrorId : CommandNotFoundException',
        }));
        const conn = createConnection({ exec } as unknown as Partial<SSHConnection>);

        await expect(installCodeServer(conn, {
            ...OPTIONS,
            platform: 'windows',
            useSocketPath: true,
        }, createLogger())).rejects.toThrow('only supported on Linux and macOS');
    });

    it('keeps cmd.exe setup below its command line limit with many default extensions', async () => {
        let installCommand = '';
        const exec = vi.fn(async () => ({
            stdout: '',
            stderr: 'is not recognized as an internal or external command',
        }));
        const execPartial = vi.fn(async (command: string) => {
            installCommand = command;
            const compressedPayload = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(command)?.[1];
            if (!compressedPayload) {
                throw new Error('Generated cmd setup has no compressed payload');
            }
            const script = zlib.gunzipSync(Buffer.from(compressedPayload, 'base64')).toString('utf8');
            const id = /"([a-f0-9]+): start"/.exec(script)?.[1];
            if (!id) {
                throw new Error('Decompressed PowerShell script has no result marker');
            }
            return { stdout: resultBlock(id, 'win32'), stderr: '' };
        });
        const conn = createConnection({ exec, execPartial } as unknown as Partial<SSHConnection>);
        const extensionIds = Array.from({ length: 40 }, (_, index) => `publisher.extension-${index}`);

        await installCodeServer(conn, { ...OPTIONS, platform: 'windows', extensionIds }, createLogger());

        expect(installCommand).toContain('IO.Compression.GzipStream');
        expect(installCommand.length).toBeLessThanOrEqual(8191);
    });

    it('does not fast-reuse a socket endpoint when port listening is requested', async () => {
        const exec = vi.fn(async (command: string) => {
            if (command.startsWith('bash -c ')) {
                const marker = /open-remote-ssh-fast-[a-f0-9]+/.exec(command)?.[0];
                if (!marker) {
                    throw new Error('Expected the fast recovery probe');
                }
                return { stdout: resultBlock(marker, 'linux', '/tmp/server.sock'), stderr: '' };
            }

            const script = decodeBashInstallCommand(command);
            return { stdout: resultBlock(bashScriptId(script), 'linux', '/tmp/server.sock'), stderr: '' };
        });
        const conn = createConnection({ exec } as unknown as Partial<SSHConnection>);

        await expect(installCodeServer(conn, OPTIONS, createLogger())).rejects.toThrow('listener mode changed');
        expect(exec).toHaveBeenCalledTimes(2);
    });
});
