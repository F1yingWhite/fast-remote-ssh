import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as net from 'node:net';
import fse from '@zokugun/fs-extra-plus/sync';
import { xtry } from '@zokugun/xtry/sync';
import { vol } from 'memfs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { RemoteSSHResolver, SSHConfiguration, getRemoteAuthority } from './rewires/remote';
import { Log } from './mocks/logger';
import * as vscode from './mocks/vscode';
import { runDocker } from './utils/run-docker';
import { getMappedPort } from './utils/get-mapped-port';
import { waitForSSHReady } from './utils/wait-for-ssh-ready';

const ROOT = fse.join('.', 'test', 'fixtures', 'default');
const SERVER_SETUP = fse.readFile('./src/scripts/server-setup.sh', 'utf8').value!;

type ClientOptions = {
  files: Record<string, string>;
  /** When set, the hosts the SSH config is expected to declare. */
  hosts?: string[];
};

type ServerOptions = {
  image: string;
  username: string;
  password: string;
};

const files = fse.walk(ROOT, {
  absolute: true,
  onlyFiles: true,
  collect: true,
  filter: (item) => item.path.endsWith('.yml'),
});

if (files.fails) {
  throw files.error;
}

for (const file of files.value) {
  const name = fse.leafName(file.path, 1);
  const content = fse.readFile(file.path, 'utf8');
  if (content.fails) {
    throw content.error;
  }

  const document = xtry(() => YAML.parse(content.value) as unknown);
  if (document.fails) {
    throw document.error;
  }

  const { client, server } = document.value as { client: ClientOptions; server: ServerOptions };
  const containerName = `open-remote-ssh-test-${randomUUID()}`;

  describe(name, async () => {
    beforeAll(async () => {
      vol.reset();

      if(!server.image.startsWith('local-')) {
        runDocker(['pull', server.image]);
      }

      runDocker(['rm', '-f', containerName], true);

      runDocker([
        'run',
        '--detach',
        '--rm',
        '--name',
        containerName,
        '--publish',
        '2222:2222',
        '--env',
        `USER_NAME=${server.username}`,
        '--env',
        `USER_PASSWORD=${server.password}`,
        '--env',
        'PASSWORD_ACCESS=true',
        '--env',
        'SUDO_ACCESS=false',
        '--env',
        'LOG_STDOUT=true',
        server.image,
      ]);

      const hostPort = getMappedPort(containerName);

      await waitForSSHReady(server.username, server.password, hostPort, 60_000);
    }, 120_000);

    afterAll(() => {
      runDocker(['rm', '-f', containerName], true);
    });

    it(`test-${name}`, async () => {
      vol.fromJSON({
        ...client.files,
        '/data/vscodium/extensions/open-remote-ssh/src/scripts/server-setup.sh': SERVER_SETUP,
      });

      vscode.window.setPassword(server.password);

      if (client.hosts) {
        const config = await SSHConfiguration.loadFromFS();

        expect(config.getAllConfiguredHosts()).to.eql(client.hosts);
      }

      const logger = new Log('Remote - SSH');
      const extContext = new vscode.ExtensionContext();
      const remoteSSHResolver = new RemoteSSHResolver(extContext, logger);
      const remoteContext = new vscode.RemoteAuthorityResolverContext();
      remoteContext.resolveAttempt = 1;
      const authority = getRemoteAuthority('test');
      const result = await remoteSSHResolver.resolve(authority, remoteContext);

      expect(result).toBeDefined();
      expect(result.host).to.eql('127.0.0.1');

      if (name === 'linux-bash') {
        // Model the production failure: the workbench reaches the local
        // listener, SSH opens the remote TCP connection, but the Agent sends no
        // protocol bytes before the editor retries. The retry must create a new
        // generation while leaving the legacy process alive for other windows.
        const secondContext = new vscode.ExtensionContext();
        const secondResolver = new RemoteSSHResolver(secondContext, new Log('Remote - SSH'));
        const secondRemoteContext = new vscode.RemoteAuthorityResolverContext();
        secondRemoteContext.resolveAttempt = 1;
        const secondResult = await secondResolver.resolve(authority, secondRemoteContext);

        const openZeroResponseTunnel = async (host: string, port: number) => {
          const socket = net.connect(port, host);
          await once(socket, 'connect');
          await new Promise(resolve => setTimeout(resolve, 200));
          socket.end();
          await once(socket, 'close');
        };
        await Promise.all([
          openZeroResponseTunnel(result.host, result.port),
          openZeroResponseTunnel(secondResult.host, secondResult.port),
        ]);

        remoteContext.resolveAttempt = 2;
        secondRemoteContext.resolveAttempt = 2;
        const [retried, secondRetried] = await Promise.all([
          remoteSSHResolver.resolve(authority, remoteContext),
          secondResolver.resolve(authority, secondRemoteContext),
        ]);
        expect(retried).toBeDefined();
        expect(secondRetried).toBeDefined();

        const generationState = runDocker([
          'exec', containerName, 'bash', '-c',
          [
            `prefix="/home/${server.username}/.vscodium-server/.4c0b0c6cc561d2d3636d1ec250935431876ce4dc"`,
            'generation="$(cat "$prefix.active")"',
            '[[ "$generation" =~ ^[a-f0-9]+$ ]]',
            'legacy_pid="$(cat "$prefix.pid")"',
            'generation_pid="$(cat "$prefix.$generation.pid")"',
            'kill -0 "$legacy_pid"',
            'kill -0 "$generation_pid"',
            'generation_count="$(find "$(dirname "$prefix")" -maxdepth 1 -name "$(basename "$prefix").*.pid" | wc -l | tr -d " ")"',
            'printf "%s legacy=%s replacement=%s generations=%s" "$generation" "$legacy_pid" "$generation_pid" "$generation_count"',
          ].join('; '),
        ]);
        expect(generationState).toMatch(/^[a-f0-9]+ legacy=\d+ replacement=\d+ generations=1$/);
        expect(generationState.match(/legacy=(\d+) replacement=(\d+)/)?.[1])
          .not.toBe(generationState.match(/legacy=(\d+) replacement=(\d+)/)?.[2]);
      }
    }, 60_000);
  });
}
