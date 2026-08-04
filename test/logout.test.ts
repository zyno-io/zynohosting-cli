import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { RenewalTokenStore } from '../src/auth/renewal-token-store.js';

import { logout } from '../src/commands/logout.js';
import { loadStoredConfig, saveConfig } from '../src/config.js';
import { HttpError } from '../src/errors.js';

const API_URL = 'https://hosting.api-alpha.zyno.dev';
const SUITE_API_URL = 'https://suite.api-alpha.zyno.dev';
const AUTH_API_URL = 'https://auth.api-alpha.zyno.dev';
const RENEWAL_KEY = '11111111-1111-4111-8111-111111111111';

test('logout self-revokes a scoped grant, removes its renewal credential, and retains endpoint preferences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-logout-'));
    const file = join(root, 'config.json');
    const store = new MemoryStore([[RENEWAL_KEY, 'zrt_secret']]);
    let revoked = '';
    await saveConfig(
        {
            apiUrl: API_URL,
            suiteApiUrl: SUITE_API_URL,
            authApiUrl: AUTH_API_URL,
            accessToken: 'old.jwt.signature',
            tenantId: '00000000-0000-0000-0000-000000000024',
            expiresAt: Date.now() + 60 * 60 * 1000,
            renewalKey: RENEWAL_KEY,
            scopedToken: true
        },
        file
    );

    await logout(
        {},
        {
            configFile: file,
            renewalTokenStore: store,
            write: () => {},
            scopedTokenClient: apiUrl => {
                assert.equal(apiUrl, AUTH_API_URL);
                return {
                    async renew() {
                        throw new Error('fresh access token should not renew');
                    },
                    async revoke(token: string) {
                        revoked = token;
                    }
                };
            }
        }
    );

    assert.equal(revoked, 'old.jwt.signature');
    assert.equal(store.values.has(RENEWAL_KEY), false);
    assert.deepEqual(await loadStoredConfig(file), { apiUrl: API_URL, suiteApiUrl: SUITE_API_URL, authApiUrl: AUTH_API_URL });
});

test('logout preserves credentials when self-revocation cannot reach ZynoAuth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-logout-failure-'));
    const file = join(root, 'config.json');
    const store = new MemoryStore([[RENEWAL_KEY, 'zrt_secret']]);
    const saved = {
        apiUrl: API_URL,
        authApiUrl: AUTH_API_URL,
        accessToken: 'old.jwt.signature',
        expiresAt: Date.now() + 60 * 60 * 1000,
        renewalKey: RENEWAL_KEY,
        scopedToken: true as const
    };
    await saveConfig(saved, file);

    await assert.rejects(
        logout(
            {},
            {
                configFile: file,
                renewalTokenStore: store,
                write: () => {},
                scopedTokenClient: () => ({
                    async renew() {
                        throw new Error('fresh access token should not renew');
                    },
                    async revoke() {
                        throw new HttpError('network unavailable', 0, 'network_error');
                    }
                })
            }
        ),
        /network unavailable/
    );
    assert.deepEqual(await loadStoredConfig(file), saved);
    assert.equal(store.values.get(RENEWAL_KEY), 'zrt_secret');
});

test('logout renews an expired scoped token before revoking its grant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-logout-expired-'));
    const file = join(root, 'config.json');
    const store = new MemoryStore([[RENEWAL_KEY, 'zrt_old']]);
    let revoked = '';
    await saveConfig(
        {
            apiUrl: API_URL,
            authApiUrl: AUTH_API_URL,
            accessToken: 'old.jwt.signature',
            expiresAt: Date.now() - 1,
            renewalKey: RENEWAL_KEY,
            scopedToken: true
        },
        file
    );

    await logout(
        {},
        {
            configFile: file,
            renewalTokenStore: store,
            write: () => {},
            scopedTokenClient: () => ({
                async renew(token: string) {
                    assert.equal(token, 'zrt_old');
                    return {
                        jwt: 'new.jwt.signature',
                        expiresAt: Date.now() + 60 * 60 * 1000,
                        renewalToken: 'zrt_new'
                    };
                },
                async revoke(token: string) {
                    revoked = token;
                }
            })
        }
    );

    assert.equal(revoked, 'new.jwt.signature');
    assert.equal(store.values.has(RENEWAL_KEY), false);
    assert.deepEqual(await loadStoredConfig(file), { apiUrl: API_URL, authApiUrl: AUTH_API_URL });
});

class MemoryStore implements RenewalTokenStore {
    readonly values: Map<string, string>;

    constructor(entries: Iterable<readonly [string, string]> = []) {
        this.values = new Map(entries);
    }

    async get(key: string): Promise<string | undefined> {
        return this.values.get(key);
    }

    async set(key: string, token: string): Promise<void> {
        this.values.set(key, token);
    }

    async delete(key: string): Promise<void> {
        this.values.delete(key);
    }
}
