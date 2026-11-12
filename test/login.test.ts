import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { RenewalTokenStore } from '../src/auth/renewal-token-store.js';

import { login, resolveLoginPageUrl } from '../src/commands/login.js';
import { loadStoredConfig, resolveApiUrl, resolveAuthApiUrl, resolveConfig, resolveSuiteApiUrl, updateProfile } from '../src/config.js';
import { CliError } from '../src/errors.js';
import { startLoopbackLogin } from '../src/login/loopback.js';

const API_URL = 'https://hosting.api-alpha.zyno.dev';
const SUITE_API_URL = 'https://suite.api-alpha.zyno.dev';
const AUTH_API_URL = 'https://auth.api-alpha.zyno.dev';
const LOGIN_URL = 'https://zyno.dev/cli/login';
const TENANT_ID = '00000000-0000-0000-0000-000000000024';
const JWT = 'header.payload.signature';

test('browser login accepts a one-shot SPA form POST and saves Bearer credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-login-'));
    const file = join(root, 'config.json');
    let openedUrl = '';
    const output: string[] = [];
    // login() catches everything openUrl throws, because a browser that will not
    // launch must not fail the sign-in. That also swallows assertion failures, so
    // they are captured here and re-thrown once login() has returned.
    let callbackFailure: unknown;

    await login(
        { apiUrl: API_URL, loginUrl: LOGIN_URL, timeoutSeconds: 5 },
        {
            configFile: file,
            write: message => output.push(message),
            openUrl: async value => {
                try {
                    openedUrl = value;
                    const url = new URL(value);
                    const callback = url.searchParams.get('callback');
                    const state = url.searchParams.get('state');
                    assert(callback);
                    assert(state);
                    assert.equal(url.origin + url.pathname, LOGIN_URL);
                    assert.equal(url.searchParams.get('apiUrl'), null);
                    assert.match(url.searchParams.get('name') ?? '', /^ZynoHosting CLI\/MCP — /);
                    assert.equal(url.searchParams.get('permissions'), 'hosting.sitesRead');
                    assert.equal(url.searchParams.get('renewable'), null);
                    const response = await fetch(callback, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            jwt: JWT,
                            tenantId: TENANT_ID,
                            expiresAt: String(Date.now() + 60_000),
                            state
                        })
                    });
                    assert.equal(response.status, 200);
                    assert.match(await response.text(), /Signed in/i);
                } catch (error) {
                    callbackFailure = error;
                    throw error;
                }
            }
        }
    );

    if (callbackFailure) throw callbackFailure;
    assert(openedUrl);
    const stored = await loadStoredConfig(file, 'alpha');
    assert.equal(stored.apiUrl, API_URL);
    assert.equal(stored.suiteApiUrl, SUITE_API_URL);
    assert.equal(stored.authApiUrl, AUTH_API_URL);
    assert.equal(stored.accessToken, JWT);
    assert.equal(stored.tenantId, TENANT_ID);
    assert.equal(typeof stored.expiresAt, 'number');
    assert.equal(stored.apiKey, undefined);
    assert.equal(stored.scopedToken, true);
    assert.match(output.join(''), /login complete/i);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('loopback listener ignores an invalid state and accepts the valid callback', async () => {
    const loopback = await startLoopbackLogin({ timeoutMs: 5_000 });
    try {
        const invalid = await post(loopback.callbackUrl, 'wrong-state');
        assert.equal(invalid.status, 400);

        const valid = await post(loopback.callbackUrl, loopback.state);
        assert.equal(valid.status, 200);
        assert.deepEqual(await loopback.result, {
            accessToken: JWT,
            tenantId: TENANT_ID,
            expiresAt: EXPIRATION
        });
    } finally {
        await loopback.close();
    }

    async function post(callback: string, state: string): Promise<Response> {
        return fetch(callback, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                jwt: JWT,
                tenantId: TENANT_ID,
                expiresAt: String(EXPIRATION),
                state
            })
        });
    }
});

test('loopback distinguishes a provider cancellation from a provider failure', async () => {
    const cancelled = await startLoopbackLogin({ timeoutMs: 5_000 });
    try {
        const response = await postError(cancelled.callbackUrl, cancelled.state, 'access_denied');
        assert.equal(response.status, 200);
        const page = await response.text();
        assert.match(page, /Sign-in cancelled/);
        await assert.rejects(cancelled.result, (error: unknown) => error instanceof CliError && error.code === 'login_cancelled');
    } finally {
        await cancelled.close();
    }

    const failed = await startLoopbackLogin({ timeoutMs: 5_000 });
    try {
        const response = await postError(failed.callbackUrl, failed.state, 'server_error');
        assert.equal(response.status, 500);
        const page = await response.text();
        assert.match(page, /Sign-in failed/);
        await assert.rejects(failed.result, (error: unknown) => error instanceof CliError && error.code === 'login_failed');
    } finally {
        await failed.close();
    }

    async function postError(callback: string, state: string, error: string): Promise<Response> {
        return fetch(callback, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ state, error })
        });
    }
});

test('renewable browser login requests exact scopes and stores only a credential-store reference in config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-renewable-login-'));
    const file = join(root, 'config.json');
    const store = new MemoryRenewalTokenStore();
    const renewalToken = 'zrt_first-secret';

    await login(
        {
            apiUrl: API_URL,
            loginUrl: LOGIN_URL,
            name: 'Claude MCP — work laptop',
            permissionKeys: ['hosting.sitesRead', 'hosting.deploy', 'hosting.sitesRead'],
            renewable: true,
            timeoutSeconds: 5
        },
        {
            configFile: file,
            renewalTokenStore: store,
            write: () => {},
            openUrl: async value => {
                const url = new URL(value);
                assert.equal(url.searchParams.get('name'), 'Claude MCP — work laptop');
                assert.equal(url.searchParams.get('permissions'), 'hosting.sitesRead,hosting.deploy');
                assert.equal(url.searchParams.get('renewable'), '1');
                const callback = url.searchParams.get('callback');
                const state = url.searchParams.get('state');
                assert(callback && state);
                const response = await fetch(callback, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        jwt: JWT,
                        tenantId: TENANT_ID,
                        expiresAt: String(Date.now() + 60 * 60 * 1000),
                        state,
                        renewalToken
                    })
                });
                assert.equal(response.status, 200);
            }
        }
    );

    const stored = await loadStoredConfig(file, 'alpha');
    assert.equal(stored.scopedToken, true);
    assert.match(stored.renewalKey ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(store.values.get(stored.renewalKey!), renewalToken);
    assert.doesNotMatch(await readFile(file, 'utf8'), /zrt_first-secret/);
});

test('browser reports failure and preserves config when a renewal credential cannot be stored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-renewable-failure-'));
    const file = join(root, 'config.json');
    await updateProfile('alpha', { apiUrl: API_URL, apiKey: 'existing-key' }, file);
    let callbackStatus = 0;

    await assert.rejects(
        login(
            { apiUrl: API_URL, loginUrl: LOGIN_URL, renewable: true, timeoutSeconds: 5 },
            {
                configFile: file,
                write: () => {},
                renewalTokenStore: {
                    async get() {
                        return undefined;
                    },
                    async set() {
                        throw new Error('credential store unavailable');
                    },
                    async delete() {}
                },
                openUrl: async value => {
                    const url = new URL(value);
                    const callback = url.searchParams.get('callback');
                    const state = url.searchParams.get('state');
                    assert(callback && state);
                    const response = await fetch(callback, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            jwt: JWT,
                            tenantId: TENANT_ID,
                            expiresAt: String(Date.now() + 60 * 60 * 1000),
                            state,
                            renewalToken: 'zrt_unstored'
                        })
                    });
                    callbackStatus = response.status;
                    assert.match(await response.text(), /could not save/i);
                }
            }
        ),
        /credential store unavailable/
    );

    assert.equal(callbackStatus, 500);
    assert.deepEqual(await loadStoredConfig(file, 'alpha'), { apiUrl: API_URL, apiKey: 'existing-key' });
});

test('login rejects malformed and non-delegable permission requests before opening a browser', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-invalid-permissions-'));
    const file = join(root, 'config.json');
    const dependencies = {
        configFile: file,
        write: () => {},
        openUrl: async () => {
            throw new Error('browser must not open');
        }
    };
    await assert.rejects(login({ permissionKeys: [] }, dependencies), /1–100 permissions/);
    await assert.rejects(login({ permissionKeys: ['not a key'] }, dependencies), /app\.capability/);
    await assert.rejects(login({ permissionKeys: ['msp.impersonate'] }, dependencies), /cannot be delegated/);
    await assert.rejects(
        login({ permissionKeys: ['hosting.sitesRead', 'hosting.sitesWrite'] }, dependencies),
        /hosting\.sitesWrite is not a ZynoSuite permission\. Did you mean hosting\.filesWrite\?.*hosting\.downloadSensitive/s
    );
    await assert.rejects(login({ permissionKeys: ['storage.read'] }, dependencies), /is not a ZynoSuite permission/);
});

test('an aborted browser login stops waiting and closes its loopback listener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-cancelled-login-'));
    const file = join(root, 'config.json');
    const abort = new AbortController();
    let callbackUrl = '';

    await assert.rejects(
        login(
            { apiUrl: API_URL, loginUrl: LOGIN_URL, timeoutSeconds: 60, signal: abort.signal },
            {
                configFile: file,
                write: () => {},
                openUrl: async () => {},
                onBrowserUrl: url => {
                    callbackUrl = new URL(url).searchParams.get('callback') ?? '';
                    abort.abort();
                }
            }
        ),
        /cancelled/i
    );

    assert(callbackUrl);
    await assert.rejects(fetch(callbackUrl, { method: 'POST' }));
    await assert.rejects(stat(file));
});

test('loopback rejects repeated callback fields and unexpected renewal credentials without settling login', async () => {
    const loopback = await startLoopbackLogin({ timeoutMs: 5_000 });
    try {
        const repeated = await fetch(loopback.callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `jwt=${JWT}&tenantId=${TENANT_ID}&expiresAt=${Date.now() + 60_000}&state=${loopback.state}&state=${loopback.state}`
        });
        assert.equal(repeated.status, 400);
        const unexpectedRenewal = await fetch(loopback.callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                jwt: JWT,
                tenantId: TENANT_ID,
                expiresAt: String(Date.now() + 60_000),
                state: loopback.state,
                renewalToken: 'zrt_unexpected'
            })
        });
        assert.equal(unexpectedRenewal.status, 400);
        assert.equal((await postValid(loopback.callbackUrl, loopback.state)).status, 200);
        await loopback.result;
    } finally {
        await loopback.close();
    }
});

test('loopback requires form encoding, enforces its body limit, and requires an opted-in renewal credential', async () => {
    const loopback = await startLoopbackLogin({ timeoutMs: 5_000, renewable: true });
    try {
        const json = await fetch(loopback.callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        assert.equal(json.status, 415);
        const oversized = await fetch(loopback.callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `state=${loopback.state}&padding=${'x'.repeat(17 * 1024)}`
        });
        assert.equal(oversized.status, 413);
        assert.equal((await postValid(loopback.callbackUrl, loopback.state)).status, 400);
        const valid = await fetch(loopback.callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                jwt: JWT,
                tenantId: TENANT_ID,
                expiresAt: String(Date.now() + 60_000),
                state: loopback.state,
                renewalToken: 'zrt_required'
            })
        });
        assert.equal(valid.status, 200);
        assert.equal((await loopback.result).renewalToken, 'zrt_required');
    } finally {
        await loopback.close();
    }
});

test('loopback processes only one valid callback while credential storage is in progress', async () => {
    let releaseStorage!: () => void;
    let storageStarted!: () => void;
    const release = new Promise<void>(resolve => {
        releaseStorage = resolve;
    });
    const started = new Promise<void>(resolve => {
        storageStarted = resolve;
    });
    let stores = 0;
    const loopback = await startLoopbackLogin({
        timeoutMs: 5_000,
        onCredential: async () => {
            stores++;
            storageStarted();
            await release;
        }
    });
    try {
        const first = postValid(loopback.callbackUrl, loopback.state);
        await started;
        const replay = await postValid(loopback.callbackUrl, loopback.state);
        assert.equal(replay.status, 409);
        releaseStorage();
        assert.equal((await first).status, 200);
        await loopback.result;
        assert.equal(stores, 1);
    } finally {
        releaseStorage();
        await loopback.close();
    }
});

test('API-key login remains available for CI credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-login-key-'));
    const file = join(root, 'config.json');
    await login({ apiUrl: API_URL, apiKey: 'ci-key' }, { configFile: file, write: () => {} });
    assert.deepEqual(await loadStoredConfig(file, 'alpha'), {
        apiUrl: API_URL,
        suiteApiUrl: SUITE_API_URL,
        authApiUrl: AUTH_API_URL,
        apiKey: 'ci-key'
    });
});

test('saved browser credentials resolve for deployments and expire locally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-config-'));
    const file = join(root, 'config.json');
    const env = { ZYNOHOSTING_CONFIG: file };
    await updateProfile('alpha', { apiUrl: API_URL, accessToken: JWT, tenantId: TENANT_ID, expiresAt: EXPIRATION }, file);
    assert.deepEqual(await resolveConfig({ environment: 'alpha' }, env), {
        apiUrl: API_URL,
        suiteApiUrl: SUITE_API_URL,
        authApiUrl: AUTH_API_URL,
        credential: { type: 'bearer', accessToken: JWT, tenantId: TENANT_ID, expiresAt: EXPIRATION }
    });

    await updateProfile('alpha', { apiUrl: API_URL, accessToken: JWT, tenantId: TENANT_ID, expiresAt: Date.now() - 1 }, file);
    await assert.rejects(
        resolveConfig({ environment: 'alpha' }, env),
        (error: unknown) => error instanceof Error && error.message.includes('expired')
    );
});

test('an injected scoped Bearer token does not require tenant metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-injected-token-'));
    const file = join(root, 'config.json');
    const expiresAt = Date.now() + 60_000;
    const resolved = await resolveConfig({ accessToken: JWT, expiresAt }, { ZYNOHOSTING_CONFIG: file, ZYNOHOSTING_ENVIRONMENT: 'alpha' });
    assert.deepEqual(resolved.credential, { type: 'bearer', accessToken: JWT, expiresAt });
});

test('an expiring renewable login rotates once across concurrent config resolution and persists the replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-refresh-'));
    const file = join(root, 'config.json');
    const renewalKey = '11111111-1111-4111-8111-111111111111';
    const store = new MemoryRenewalTokenStore([[renewalKey, 'zrt_old']]);
    const env = { ZYNOHOSTING_CONFIG: file };
    const newExpiration = Date.now() + 60 * 60 * 1000;
    let renewals = 0;
    await updateProfile(
        'alpha',
        {
            apiUrl: API_URL,
            authApiUrl: AUTH_API_URL,
            accessToken: JWT,
            tenantId: TENANT_ID,
            expiresAt: Date.now() - 1,
            renewalKey,
            scopedToken: true
        },
        file
    );
    const dependencies = {
        renewalTokenStore: store,
        scopedTokenClient: (apiUrl: string) => {
            assert.equal(apiUrl, AUTH_API_URL);
            return {
                async renew(value: string) {
                    assert.equal(value, 'zrt_old');
                    renewals++;
                    await new Promise(resolve => setTimeout(resolve, 20));
                    return { jwt: 'new.header.signature', expiresAt: newExpiration, renewalToken: 'zrt_new' };
                }
            };
        }
    };

    const [first, second] = await Promise.all([
        resolveConfig({ environment: 'alpha' }, env, dependencies),
        resolveConfig({ environment: 'alpha' }, env, dependencies)
    ]);
    assert.equal(first.credential.type === 'bearer' && first.credential.accessToken, 'new.header.signature');
    assert.equal(second.credential.type === 'bearer' && second.credential.accessToken, 'new.header.signature');
    assert.equal(renewals, 1);
    assert.equal(store.values.get(renewalKey), 'zrt_new');
    assert.equal((await loadStoredConfig(file, 'alpha')).accessToken, 'new.header.signature');
    assert.equal((await loadStoredConfig(file, 'alpha')).expiresAt, newExpiration);
});

test('an explicit SPA login URL works with a custom Hosting API hostname', () => {
    assert.equal(resolveLoginPageUrl(LOGIN_URL, 'https://hosting.example.com'), LOGIN_URL);
});

test('resolves environment API defaults while preserving explicit and saved URLs', () => {
    assert.equal(resolveApiUrl(undefined, {}), 'https://hosting.api.zyno.app');
    assert.equal(resolveApiUrl(undefined, { ZYNOHOSTING_ENVIRONMENT: 'alpha' }), API_URL);
    assert.equal(resolveApiUrl(undefined, { ZYNOHOSTING_ENVIRONMENT: 'dev' }), 'http://localhost:39840');
    assert.equal(resolveApiUrl('https://hosting.example.com', {}), 'https://hosting.example.com');
    assert.equal(resolveApiUrl('https://hosting.example.com', { ZYNOHOSTING_ENVIRONMENT: 'alpha' }), 'https://hosting.example.com');
    assert.equal(resolveApiUrl('https://override.example.com', {}), 'https://override.example.com');
    assert.throws(() => resolveApiUrl(undefined, { ZYNOHOSTING_ENVIRONMENT: 'staging' }), /Expected production, alpha, or dev/);
});

test('resolves matching Suite API defaults and honors explicit, environment, and saved overrides', () => {
    assert.equal(resolveSuiteApiUrl(undefined, {}, 'https://hosting.api.zyno.app', {}), 'https://suite.api.zyno.app');
    assert.equal(resolveSuiteApiUrl(undefined, {}, API_URL, {}), SUITE_API_URL);
    assert.equal(resolveSuiteApiUrl(undefined, {}, 'http://localhost:39840', {}), 'http://localhost:39874');
    assert.equal(
        resolveSuiteApiUrl(undefined, {}, 'https://hosting.example.com', { ZYNO_SUITE_API_URL: 'https://suite.env.example.com' }),
        'https://suite.env.example.com'
    );
    assert.equal(
        resolveSuiteApiUrl('https://suite.override.example.com', { suiteApiUrl: 'https://suite.saved.example.com' }, API_URL, {}),
        'https://suite.override.example.com'
    );
    assert.equal(
        resolveSuiteApiUrl(undefined, { suiteApiUrl: 'https://suite.saved.example.com' }, 'https://hosting.example.com', {}),
        'https://suite.saved.example.com'
    );
    assert.equal(
        resolveSuiteApiUrl(undefined, { apiUrl: 'https://hosting.api.zyno.app', suiteApiUrl: 'https://suite.api.zyno.app' }, API_URL, {}),
        SUITE_API_URL
    );
    assert.equal(resolveSuiteApiUrl(undefined, {}, 'https://hosting.example.com', {}), undefined);
    assert.throws(() => resolveSuiteApiUrl('http://suite.example.com', {}, API_URL, {}), /must use HTTPS/);
});

test('resolves matching Auth API defaults and honors explicit, environment, and saved overrides', () => {
    assert.equal(resolveAuthApiUrl(undefined, {}, 'https://hosting.api.zyno.app', {}), 'https://auth.api.zyno.app');
    assert.equal(resolveAuthApiUrl(undefined, {}, API_URL, {}), AUTH_API_URL);
    assert.equal(resolveAuthApiUrl(undefined, {}, 'http://localhost:39840', {}), 'http://localhost:39827');
    assert.equal(
        resolveAuthApiUrl(undefined, {}, 'https://hosting.example.com', { ZYNO_AUTH_API_URL: 'https://auth.env.example.com' }),
        'https://auth.env.example.com'
    );
    assert.equal(
        resolveAuthApiUrl(undefined, { authApiUrl: 'https://auth.saved.example.com' }, 'https://hosting.example.com', {}),
        'https://auth.saved.example.com'
    );
    assert.equal(
        resolveAuthApiUrl(undefined, { apiUrl: 'https://hosting.api.zyno.app', authApiUrl: 'https://auth.api.zyno.app' }, API_URL, {}),
        AUTH_API_URL
    );
    assert.equal(resolveAuthApiUrl(undefined, {}, 'https://hosting.example.com', {}), undefined);
});

test('resolves each environment SPA login page', () => {
    assert.equal(resolveLoginPageUrl(undefined, 'https://hosting.api.zyno.app'), 'https://zyno.app/cli/login');
    assert.equal(resolveLoginPageUrl(undefined, API_URL), LOGIN_URL);
    assert.equal(resolveLoginPageUrl(undefined, 'http://localhost:39840'), 'http://localhost:5173/cli/login');
});

const EXPIRATION = Date.now() + 60_000;

async function postValid(callback: string, state: string): Promise<Response> {
    return fetch(callback, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ jwt: JWT, tenantId: TENANT_ID, expiresAt: String(Date.now() + 60_000), state })
    });
}

class MemoryRenewalTokenStore implements RenewalTokenStore {
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
