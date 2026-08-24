import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { Log } from './common/logger';
import { IServerConfig, ServerVersion, ServerValidation } from './serverConfig';
import SSHConnection from './ssh/sshConnection';
import { fetchRelease, IRelease } from './fetchRelease';
import { sanitizeExtensionIds } from './utils/sanitize-extension-ids';

/**
 * Reads a script template from <extensionPath>/scripts/<templateName> and
 * replaces every %%KEY%% occurrence with the matching value from `variables`.
 */
function compileTemplate(templateName: string, variables: Record<string, string>, extensionPath: string): string {
    const templatePath = path.join(extensionPath, 'src', 'scripts', templateName);
    let content = fs.readFileSync(templatePath, 'utf8');
    for (const [key, value] of Object.entries(variables)) {
        content = content.replace(new RegExp(`%%${key}%%`, 'g'), value);
    }
    return content;
}

/**
 * Matches a hostname against a pattern that may contain wildcards.
 * Returns a specificity score: higher scores indicate more specific matches.
 * Returns -1 if no match.
 */
function matchHostnamePattern(hostname: string, pattern: string): number {
    // Exact match has highest priority
    if (hostname === pattern) {
        return 1000;
    }

    // Catch-all wildcard has lowest priority
    if (pattern === '*') {
        return 1;
    }

    // Convert wildcard pattern to regex
    // Escape special regex characters except *
    const regexPattern = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`);

    if (regex.test(hostname)) {
        // Calculate specificity based on the number of non-wildcard characters
        // More specific patterns (more characters) get higher scores
        const nonWildcardChars = pattern.replace(/\*/g, '').length;
        return 10 + nonWildcardChars;
    }

    return -1;
}

/**
 * Finds the best matching path for a hostname from a map of patterns to paths.
 * Supports wildcards with priority: exact match > specific wildcard > general wildcard.
 */
export function findServerInstallPath(hostname: string, pathMap: Record<string, string>): string | undefined {
    let bestMatch: { pattern: string; path: string; score: number } | undefined;

    for (const [pattern, path] of Object.entries(pathMap)) {
        const score = matchHostnamePattern(hostname, pattern);

        if (score > 0) {
            if (!bestMatch || score > bestMatch.score) {
                bestMatch = { pattern, path, score };
            }
        }
    }

    return bestMatch?.path;
}

export type ServerInstallOptions = {
    id: string;
    quality: string;
    commit: string;
    version: string;
    release?: string;
    extensionIds: string[];
    envVariables: string[];
    useSocketPath: boolean;
    serverApplicationName: string;
    serverDataFolderName: string;
    serverDownloadUrlTemplate: string;
    customInstallPath?: string;
    serverValidation: ServerValidation;
    replaceServerEndpoint?: number | string;
};

export type ServerInstallResult = {
    exitCode: number;
    listeningOn: number | string;
    connectionToken: string;
    logFile: string;
    osReleaseId: string;
    arch: string;
    platform: string;
    tmpDir: string;
    managementConnectionCount?: number;
    [key: string]: unknown;
};

export type InstallCodeServerOptions = {
    serverConfig: IServerConfig;
    serverDownloadUrlTemplate: string | undefined;
    serverVersion: ServerVersion;
    extensionIds: string[];
    envVariables: string[];
    platform: string | undefined;
    useSocketPath: boolean;
    customInstallPath: string | undefined;
    extensionPath: string;
    /**
     * Endpoint returned by the previous resolver attempt. When present, the
     * setup script must rotate away from that exact server generation instead
     * of accepting PID/port liveness as proof that the protocol is healthy.
     */
    replaceServerEndpoint?: number | string;
};

/**
 * Extension identifiers are case-insensitive. Normalizing them keeps both the
 * cache fingerprint and generated install command stable when users only
 * reorder entries, vary casing, or repeat an id.
 */
export function normalizeExtensionIds(extensionIds: string[]): string[] {
    return [...new Set(sanitizeExtensionIds(extensionIds).map(extensionId => extensionId.toLowerCase()))].sort();
}

/**
 * The lightweight recovery probe can only prove that a process for the exact
 * local commit is alive. Fall back to the full setup whenever there are extra
 * requirements that the probe cannot verify or apply.
 */
export function canAttemptFastServerReuse(options: InstallCodeServerOptions): boolean {
    return options.serverVersion === 'match'
        && options.serverConfig.serverValidation === 'strict'
        && !options.useSocketPath
        && options.replaceServerEndpoint === undefined
        && normalizeExtensionIds(options.extensionIds).length === 0
        && options.envVariables.length === 0;
}

export class ServerInstallError extends Error {
    constructor(message: string) {
        super(message);
    }
}

function shellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Reuse an already-running remote extension host without replaying the full
 * install script. The normal path performs platform detection, locking,
 * download checks and process discovery on every connection. None of that is
 * needed when the exact-commit server is alive and its token/log are intact.
 */
async function tryReuseCodeServer(
    conn: SSHConnection,
    installOptions: Pick<ServerInstallOptions, 'id' | 'commit' | 'serverApplicationName' | 'serverDataFolderName' | 'customInstallPath'>,
    platform: string | undefined,
    logger: Log
): Promise<ServerInstallResult | undefined> {
    if (!platform || platform === 'windows') {
        return undefined;
    }

    const serverDataDir = installOptions.customInstallPath
        ? installOptions.customInstallPath.replace(/^~(?=\/|$)/, '$HOME')
        : `$HOME/${installOptions.serverDataFolderName}`;
    const marker = `open-remote-ssh-fast-${installOptions.id}`;
    const script = [
        `data_dir=${shellSingleQuote(serverDataDir)}`,
        // Expand a leading $HOME only after the value has been safely assigned.
        'data_dir="${data_dir/#\\$HOME/$HOME}"',
        `commit=${shellSingleQuote(installOptions.commit)}`,
        `server_name=${shellSingleQuote(installOptions.serverApplicationName)}`,
        'server_script="$data_dir/bin/$commit/bin/$server_name"',
        'metadata_prefix="$data_dir/.$commit"',
        'active_file="$metadata_prefix.active"',
        'generation=""',
        'if [ -s "$active_file" ]; then generation="$(cat "$active_file")"; fi',
        'if ! [[ "$generation" =~ ^[a-f0-9]+$ ]]; then generation=""; fi',
        'metadata_suffix="${generation:+.$generation}"',
        'pid_file="$metadata_prefix$metadata_suffix.pid"',
        'token_file="$metadata_prefix$metadata_suffix.token"',
        'log_file="$metadata_prefix$metadata_suffix.log"',
        '[ -x "$server_script" ] && [ -s "$pid_file" ] && [ -s "$token_file" ] && [ -s "$log_file" ] || exit 20',
        'pid="$(cat "$pid_file")"',
        'kill -0 "$pid" 2>/dev/null || exit 21',
        'ps -p "$pid" -o command= 2>/dev/null | grep -F -- "$server_script" >/dev/null || exit 22',
        'listening="$(sed -n "s/^Extension host agent listening on //p" "$log_file" | tail -n 1)"',
        '[ -n "$listening" ] || exit 23',
        'tmp_dir="${XDG_RUNTIME_DIR:-}"',
        '[ -n "$tmp_dir" ] && [ -d "$tmp_dir" ] && [ -w "$tmp_dir" ] && [ -x "$tmp_dir" ] || tmp_dir=/tmp',
        '[ -d "$tmp_dir" ] && [ -w "$tmp_dir" ] && [ -x "$tmp_dir" ] || exit 24',
        `printf '%s\\n' ${shellSingleQuote(`${marker}: start`)}`,
        'printf "exitCode==0==\\n"',
        'printf "listeningOn==%s==\\n" "$listening"',
        'printf "connectionToken==%s==\\n" "$(cat "$token_file")"',
        'printf "logFile==%s==\\n" "$log_file"',
        `printf "platform==%s==\\n" ${shellSingleQuote(platform || 'unknown')}`,
        'printf "tmpDir==%s==\\n" "$tmp_dir"',
        'printf "managementConnectionCount==%s==\\n" "$(grep -cF "[ManagementConnection] New connection established." "$log_file" 2>/dev/null || true)"',
        `printf '%s\\n' ${shellSingleQuote(`${marker}: end`)}`,
    ].join('; ');

    const started = performance.now();
    const result = await conn.exec(`bash -c ${shellSingleQuote(script)}`);
    if (!result.stdout) {
        logger.trace(`Fast server reuse missed after ${Math.round(performance.now() - started)}ms`);
        return undefined;
    }

    const resultMap = parseServerInstallOutput(result.stdout, marker);
    if (!resultMap || resultMap.exitCode !== '0' || !/^\d+$/.test(resultMap.listeningOn) || !resultMap.connectionToken) {
        logger.trace(`Fast server reuse missed after ${Math.round(performance.now() - started)}ms`);
        return undefined;
    }

    if (result.stderr) {
        // Login shells and remote security tooling may emit harmless warnings
        // on stderr. A complete, valid result block is authoritative.
        logger.trace('Fast server reuse command stderr:', result.stderr);
    }

    logger.info(`Reused running remote server in ${Math.round(performance.now() - started)}ms`);
    return {
        exitCode: 0,
        listeningOn: /^\d+$/.test(resultMap.listeningOn) ? parseInt(resultMap.listeningOn, 10) : resultMap.listeningOn,
        connectionToken: resultMap.connectionToken,
        logFile: resultMap.logFile,
        osReleaseId: '',
        arch: '',
        platform: resultMap.platform,
        tmpDir: resultMap.tmpDir,
        managementConnectionCount: /^\d+$/.test(resultMap.managementConnectionCount)
            ? parseInt(resultMap.managementConnectionCount, 10)
            : undefined,
    };
}

const DEFAULT_DOWNLOAD_URL_TEMPLATE = 'https://github.com/VSCodium/vscodium/releases/download/${version}.${release}/vscodium-reh-${os}-${arch}-${version}.${release}.tar.gz';

export async function installCodeServer(
    conn: SSHConnection,
    options: InstallCodeServerOptions,
    logger: Log
): Promise<ServerInstallResult> {
    const {
        serverConfig: vscodeServerConfig,
        serverDownloadUrlTemplate,
        serverVersion,
        extensionIds,
        envVariables,
        useSocketPath,
        customInstallPath,
        extensionPath,
        replaceServerEndpoint,
    } = options;
    let { platform } = options;
    let shell = 'powershell';

    // detect platform and shell for windows
    if (!platform || platform === 'windows') {
        const result = await conn.exec('uname -s');

        if (result.stdout) {
            const uname = result.stdout.trim().toLowerCase();
            if (uname.includes('windows32')) {
                platform = 'windows';
            } else if (uname.includes('mingw') || uname.includes('msys') || uname.includes('cygwin')) {
                platform = 'windows';
                shell = 'bash';
            } else if (uname === 'linux') {
                platform = 'linux';
            } else if (uname === 'darwin') {
                platform = 'darwin';
            } else if (uname === 'freebsd') {
                platform = 'freebsd';
            } else if (uname === 'dragonfly') {
                platform = 'dragonfly';
            }
        } else if (result.stderr) {
            if (result.stderr.includes('FullyQualifiedErrorId : CommandNotFoundException')) {
                platform = 'windows';
            }

            if (result.stderr.includes('is not recognized as an internal or external command')) {
                platform = 'windows';
                shell = 'cmd';
            }
        }

        if (platform) {
            logger.trace(`Detected platform: ${platform}, ${shell}`);
        }
    }

    if (platform === 'windows' && useSocketPath) {
        throw new ServerInstallError(`Socket-based remote server listening is only supported on Linux and macOS`);
    }

    const scriptId = crypto.randomBytes(12).toString('hex');
    const serverDownloadUrlTemplateFinal = serverDownloadUrlTemplate || vscodeServerConfig.serverDownloadUrlTemplate || DEFAULT_DOWNLOAD_URL_TEMPLATE;
    const normalizedExtensionIds = normalizeExtensionIds(extensionIds);
    const installOptionsBase = {
        id: scriptId,
        commit: vscodeServerConfig.commit,
        quality: vscodeServerConfig.quality,
        extensionIds: normalizedExtensionIds,
        envVariables,
        useSocketPath,
        serverApplicationName: vscodeServerConfig.serverApplicationName,
        serverDataFolderName: vscodeServerConfig.serverDataFolderName,
        serverDownloadUrlTemplate: serverDownloadUrlTemplateFinal,
        customInstallPath,
        serverValidation: vscodeServerConfig.serverValidation,
        replaceServerEndpoint,
    };

    // Avoid release discovery (and a possible GitHub request) when the exact
    // server process is already alive.
    if (canAttemptFastServerReuse(options)) {
        const reused = await tryReuseCodeServer(conn, installOptionsBase, platform, logger);
        if (reused) {
            return reused;
        }
    }

    const bestRelease: IRelease = await fetchRelease(serverDownloadUrlTemplateFinal, vscodeServerConfig.version, vscodeServerConfig.release, serverVersion, logger);
    const installOptions: ServerInstallOptions = {
        ...installOptionsBase,
        version: bestRelease.version,
        release: bestRelease.build,
    };

    let commandOutput: { stdout: string; stderr: string };
    if (platform === 'windows') {
        const installServerScript = generatePowerShellInstallScript(installOptions, extensionPath);

        logger.trace(`Generated PowerShell server setup script (${installServerScript.length} bytes)`);

        const installDir = `$HOME\\${vscodeServerConfig.serverDataFolderName}\\install`;
        const installScript = `${installDir}\\${vscodeServerConfig.commit}.ps1`;
        const endRegex = new RegExp(`${scriptId}: end`);

        let command: string;

        if (shell === 'powershell') {
            command = `md -Force "${installDir}"; echo @'\n${installServerScript}\n'@ | Set-Content "${installScript}"; powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'bash') {
            command = `mkdir -p "${installDir.replace(/\\/g, '/')}" && echo '\n${installServerScript.replace(/'/g, '\'"\'"\'')}\n' > "${installScript.replace(/\\/g, '/')}" && powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'cmd') {
            // cmd.exe has an 8191-character command line limit. Compressing the
            // UTF-8 script keeps even large default-extension lists below it
            // and avoids the fragile cmd/PowerShell double-escaping path.
            const payload = zlib.gzipSync(Buffer.from(installServerScript, 'utf8')).toString('base64');
            const loader = [
                `$d=[Convert]::FromBase64String('${payload}')`,
                '$m=New-Object IO.MemoryStream(,$d)',
                '$g=New-Object IO.Compression.GzipStream($m,[IO.Compression.CompressionMode]::Decompress)',
                '$r=New-Object IO.StreamReader($g,[Text.Encoding]::UTF8)',
                'iex $r.ReadToEnd()',
            ].join(';');
            command = `powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy ByPass -Command "${loader}"`;

            logger.trace('Command length (8191 max):', command.length);

            if (command.length > 8191) {
                throw new ServerInstallError(`Command line too long`);
            }
        } else {
            throw new ServerInstallError(`Not supported shell: ${shell}`);
        }

        commandOutput = await conn.execPartial(command, (stdout: string) => endRegex.test(stdout));
    } else {
        const installServerScript = generateBashInstallScript(installOptions, extensionPath);

        logger.trace(`Generated Bash server setup script (${installServerScript.length} bytes)`);
        // Use base64 encoding to avoid shell quoting issues across different login shells (bash, csh, tcsh, fish).
        // csh cannot handle multi-line strings inside single quotes with -c, so piping via base64 is the most portable approach.
        const base64Script = Buffer.from(installServerScript).toString('base64');
        commandOutput = await conn.exec(`echo ${base64Script} | base64 -d | bash -l`);
    }

    if (commandOutput.stderr) {
        logger.trace('Server install command stderr:', commandOutput.stderr);
    }
    logger.trace('Server install command stdout:', commandOutput.stdout);

    const resultMap = parseServerInstallOutput(commandOutput.stdout, scriptId);
    if (!resultMap) {
        throw new ServerInstallError(`Failed parsing install script output`);
    }

    const exitCode = parseInt(resultMap.exitCode, 10);
    if (exitCode !== 0) {
        throw new ServerInstallError(`Couldn't install vscode server on remote server, install script returned non-zero exit status`);
    }
    if (!resultMap.listeningOn || !resultMap.connectionToken) {
        throw new ServerInstallError(`Remote server setup returned an incomplete endpoint`);
    }

    const listeningOn = resultMap.listeningOn.match(/^\d+$/)
        ? parseInt(resultMap.listeningOn, 10)
        : resultMap.listeningOn;
    if (useSocketPath !== (typeof listeningOn === 'string')) {
        throw new ServerInstallError(`Remote server listener mode changed; stop the existing remote server before reconnecting`);
    }

    const remoteEnvVars = Object.fromEntries(Object.entries(resultMap).filter(([key,]) => envVariables.includes(key)));

    return {
        exitCode,
        listeningOn,
        connectionToken: resultMap.connectionToken,
        logFile: resultMap.logFile,
        osReleaseId: resultMap.osReleaseId,
        arch: resultMap.arch,
        platform: resultMap.platform,
        tmpDir: resultMap.tmpDir,
        managementConnectionCount: /^\d+$/.test(resultMap.managementConnectionCount)
            ? parseInt(resultMap.managementConnectionCount, 10)
            : undefined,
        ...remoteEnvVars
    };
}

function parseServerInstallOutput(str: string, scriptId: string): { [k: string]: string } | undefined {
    const startResultStr = `${scriptId}: start`;
    const endResultStr = `${scriptId}: end`;

    const startResultIdx = str.indexOf(startResultStr);
    if (startResultIdx < 0) {
        return undefined;
    }

    const endResultIdx = str.indexOf(endResultStr, startResultIdx + startResultStr.length);
    if (endResultIdx < 0) {
        return undefined;
    }

    const installResult = str.substring(startResultIdx + startResultStr.length, endResultIdx);

    const resultMap: { [k: string]: string } = {};
    const resultArr = installResult.split(/\r?\n/);
    for (const line of resultArr) {
        const [key, value] = line.split('==');
        resultMap[key] = value;
    }

    return resultMap;
}

function generateBashInstallScript({ id, quality, version, commit, release, extensionIds, envVariables, useSocketPath, serverApplicationName, serverDataFolderName, serverDownloadUrlTemplate, customInstallPath, serverValidation, replaceServerEndpoint }: ServerInstallOptions, extensionPath: string): string {
    const extensions = extensionIds.map(extId => '--install-extension ' + extId).join(' ');
    const extensionIdArray = extensionIds.map(shellSingleQuote).join(' ');
    const serverDataDir = customInstallPath
        ? customInstallPath.replace(/^~(?=\/|$)/, '$HOME')
        : `$HOME/${serverDataFolderName}`;
    const listenFlag = useSocketPath
        ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"`
        : '--port=0';
    const envVarLines = envVariables.map(envVar => `  echo "${envVar}==$${envVar}=="`).join('\n');

    return compileTemplate('server-setup.sh', {
        DISTRO_VERSION: version,
        DISTRO_COMMIT: commit,
        DISTRO_QUALITY: quality,
        DISTRO_VSCODIUM_RELEASE: release ?? '',
        SERVER_APP_NAME: serverApplicationName,
        SERVER_INITIAL_EXTENSIONS: extensions,
        SERVER_INITIAL_EXTENSION_IDS: extensionIdArray,
        SERVER_LISTEN_FLAG: listenFlag,
        SERVER_DATA_DIR: serverDataDir,
        SERVER_DATA_DIR_FLAG: customInstallPath ? '--server-data-dir="$SERVER_DATA_DIR"' : '',
        SERVER_VALIDATION_FLAG: serverValidation === 'skip' ? '--disable-client-validation' : '',
        SERVER_DOWNLOAD_URL_TEMPLATE: serverDownloadUrlTemplate.replace(/\$\{/g, '\\${'),
        SCRIPT_ID: id,
        ENV_VAR_LINES: envVarLines,
        MODIFY_PRODUCT_JSON: serverValidation === 'force' ? 'true' : 'false',
        SERVER_CONNECTION_TOKEN: crypto.randomUUID(),
        REPLACE_SERVER_ENDPOINT: shellSingleQuote(replaceServerEndpoint?.toString() ?? ''),
    }, extensionPath);
}

function generatePowerShellInstallScript({ id, quality, version, commit, release, extensionIds, envVariables, useSocketPath, serverApplicationName, serverDataFolderName, serverDownloadUrlTemplate, customInstallPath, serverValidation, replaceServerEndpoint }: ServerInstallOptions, extensionPath: string): string {
    const extensions = extensionIds.map(extId => '--install-extension ' + extId).join(' ');
    const extensionIdArray = extensionIds.map(extId => `"${extId}"`).join(', ');
    const downloadUrl = serverDownloadUrlTemplate
        .replace(/\$\{quality\}/g, quality)
        .replace(/\$\{version\}/g, version)
        .replace(/\$\{commit\}/g, commit)
        .replace(/\$\{os\}/g, 'win32')
        .replace(/\$\{arch\}/g, 'x64')
        .replace(/\$\{release\}/g, release ?? '');
    const serverDataDir = customInstallPath
        ? customInstallPath.replace(/^~(?=[\\/]|$)/, '$(Resolve-Path ~)')
        : `$(Resolve-Path ~)\\${serverDataFolderName}`;
    const listenFlag = useSocketPath
        ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"`
        : '--port=0';
    const envVarLines = envVariables.map(envVar => `    "$${envVar}==$${envVar}=="`).join('\n');

    return compileTemplate('server-setup.ps1', {
        DISTRO_VERSION: version,
        DISTRO_COMMIT: commit,
        DISTRO_QUALITY: quality,
        DISTRO_VSCODIUM_RELEASE: release ?? '',
        SERVER_APP_NAME: serverApplicationName,
        SERVER_INITIAL_EXTENSIONS: extensions,
        SERVER_INITIAL_EXTENSION_IDS: extensionIdArray,
        SERVER_LISTEN_FLAG: listenFlag,
        SERVER_DATA_DIR: serverDataDir,
        SERVER_DATA_DIR_FLAG: customInstallPath ? '--server-data-dir=""$SERVER_DATA_DIR""' : '',
        SERVER_VALIDATION_FLAG: serverValidation === 'skip' ? '--disable-client-validation' : '',
        SERVER_DOWNLOAD_URL: downloadUrl,
        SCRIPT_ID: id,
        ENV_VAR_LINES: envVarLines,
        MODIFY_PRODUCT_JSON: serverValidation === 'force' ? '$true' : '$false',
        SERVER_CONNECTION_TOKEN: crypto.randomUUID(),
        REPLACE_SERVER_ENDPOINT: `'${(replaceServerEndpoint?.toString() ?? '').replace(/'/g, '\'\'')}'`,
    }, extensionPath);
}
