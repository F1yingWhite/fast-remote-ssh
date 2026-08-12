export interface SSHKeepaliveDefaults {
    /** SSH protocol keepalive interval, in seconds. */
    serverAliveInterval: number;
    /** Maximum number of consecutive unanswered keepalive requests. */
    serverAliveCountMax: number;
}

export interface SSHKeepaliveConfig {
    /** ssh2 keepalive interval, in milliseconds. */
    keepaliveInterval: number;
    keepaliveCountMax: number;
}

export const DEFAULT_SSH_KEEPALIVE: Readonly<SSHKeepaliveDefaults> = {
    serverAliveInterval: 15,
    serverAliveCountMax: 3,
};

// Node timers above this value are clamped to 1ms. Rejecting a larger SSH
// interval avoids accidentally turning a very long keepalive into a busy loop.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_INTERVAL_SECONDS = Math.floor(MAX_TIMER_DELAY_MS / 1000);
const MAX_COUNT = 2_147_483_647;

const TIME_MULTIPLIERS: Readonly<Record<string, number>> = {
    '': 1,
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
    w: 7 * 24 * 60 * 60,
};

function parseIntervalSeconds(value: unknown): number | undefined {
    if (typeof value === 'number') {
        return Number.isInteger(value) && value >= 0 && value <= MAX_INTERVAL_SECONDS ? value : undefined;
    }
    if (typeof value !== 'string' || !value.length) {
        return undefined;
    }

    // OpenSSH accepts a sequence of time spans such as `1m30s`. A fractional
    // value is valid for seconds, but not for larger units.
    const part = /(\d+(?:\.\d+)?)([smhdw]?)/gi;
    let total = 0;
    let offset = 0;
    for (let match = part.exec(value); match; match = part.exec(value)) {
        if (match.index !== offset) {
            return undefined;
        }
        const unit = match[2].toLowerCase();
        if (match[1].includes('.') && unit !== '' && unit !== 's') {
            return undefined;
        }
        total += Number(match[1]) * TIME_MULTIPLIERS[unit];
        offset = part.lastIndex;
    }

    const seconds = Math.floor(total);
    return offset === value.length && Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= MAX_INTERVAL_SECONDS
        ? seconds
        : undefined;
}

function parseCountMax(value: unknown): number | undefined {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 1 && value <= MAX_COUNT ? value : undefined;
    }
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        return undefined;
    }

    const count = Number(value);
    return Number.isSafeInteger(count) && count >= 1 && count <= MAX_COUNT ? count : undefined;
}

/**
 * Convert OpenSSH ServerAlive settings to the equivalent ssh2 options.
 * Host-specific SSH config takes precedence over the extension defaults.
 */
export function resolveSSHKeepaliveConfig(
    hostConfig: Readonly<Record<string, unknown>>,
    defaults: Readonly<SSHKeepaliveDefaults> = DEFAULT_SSH_KEEPALIVE
): SSHKeepaliveConfig {
    const defaultInterval = parseIntervalSeconds(defaults.serverAliveInterval)
        ?? DEFAULT_SSH_KEEPALIVE.serverAliveInterval;
    const defaultCountMax = parseCountMax(defaults.serverAliveCountMax)
        ?? DEFAULT_SSH_KEEPALIVE.serverAliveCountMax;
    const getHostValue = (name: string) => {
        const matchingKey = Object.keys(hostConfig).find(key => key.toLowerCase() === name.toLowerCase());
        return matchingKey ? hostConfig[matchingKey] : undefined;
    };
    const intervalSeconds = parseIntervalSeconds(getHostValue('ServerAliveInterval')) ?? defaultInterval;
    const countMax = parseCountMax(getHostValue('ServerAliveCountMax')) ?? defaultCountMax;

    return {
        keepaliveInterval: intervalSeconds * 1000,
        keepaliveCountMax: countMax,
    };
}
