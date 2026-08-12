import { describe, expect, it } from 'vitest';
import { DEFAULT_SSH_KEEPALIVE, resolveSSHKeepaliveConfig } from '../src/ssh/keepalive';

describe('resolveSSHKeepaliveConfig', () => {
    it('uses the 15 second and 3 attempt extension defaults', () => {
        expect(DEFAULT_SSH_KEEPALIVE).toEqual({
            serverAliveInterval: 15,
            serverAliveCountMax: 3,
        });
        expect(resolveSSHKeepaliveConfig({})).toEqual({
            keepaliveInterval: 15_000,
            keepaliveCountMax: 3,
        });
    });

    it('lets Host settings override extension defaults', () => {
        expect(resolveSSHKeepaliveConfig({
            ServerAliveInterval: '20',
            ServerAliveCountMax: '5',
        }, {
            serverAliveInterval: 30,
            serverAliveCountMax: 7,
        })).toEqual({
            keepaliveInterval: 20_000,
            keepaliveCountMax: 5,
        });
    });

    it('disables keepalive with a zero interval and rejects ssh2-incompatible zero counts', () => {
        expect(resolveSSHKeepaliveConfig({
            serveraliveinterval: '0',
            serveralivecountmax: '0',
        })).toEqual({
            keepaliveInterval: 0,
            keepaliveCountMax: 3,
        });
    });

    it('supports OpenSSH duration suffixes and compound intervals', () => {
        expect(resolveSSHKeepaliveConfig({ ServerAliveInterval: '1m30s' })).toEqual({
            keepaliveInterval: 90_000,
            keepaliveCountMax: 3,
        });
    });

    it('falls back independently for invalid Host values', () => {
        expect(resolveSSHKeepaliveConfig({
            ServerAliveInterval: '-1',
            ServerAliveCountMax: '6',
        }, {
            serverAliveInterval: 25,
            serverAliveCountMax: 4,
        })).toEqual({
            keepaliveInterval: 25_000,
            keepaliveCountMax: 6,
        });
        expect(resolveSSHKeepaliveConfig({
            ServerAliveInterval: '40',
            ServerAliveCountMax: '3.5',
        }, {
            serverAliveInterval: 25,
            serverAliveCountMax: 4,
        })).toEqual({
            keepaliveInterval: 40_000,
            keepaliveCountMax: 4,
        });
    });
});
