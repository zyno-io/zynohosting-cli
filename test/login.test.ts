import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { login, resolveLoginPageUrl } from '../src/commands/login.js';
import { loadStoredConfig, resolveApiUrl, resolveConfig, saveConfig } from '../src/config.js';
import { startLoopbackLogin } from '../src/login/loopback.js';

const API_URL = 'https://hosting.api-alpha.zyno.dev';
const LOGIN_URL = 'https://zyno.dev/cli/login';
const TENANT_ID = '00000000-0000-0000-0000-000000000024';
const JWT = 'header.payload.signature';

test('browser login accepts a one-shot SPA form POST and saves Bearer credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-login-'));
    const file = join(root, 'config.json');
    let openedUrl = '';
    const output: string[] = [];

    await login(
        { apiUrl: API_URL, loginUrl: LOGIN_URL, timeoutSeconds: 5 },
        {
            configFile: file,
            write: message => output.push(message),
            openUrl: async value => {
                openedUrl = value;
                const url = new URL(value);
                const callback = url.searchParams.get('callback');
                const state = url.searchParams.get('state');
                assert(callback);
                assert(state);
                assert.equal(url.origin + url.pathname, LOGIN_URL);
                assert.equal(url.searchParams.get('apiUrl'), API_URL);
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
                assert.match(await response.text(), /login complete/i);
            }
        }
    );

    assert(openedUrl);
    const stored = await loadStoredConfig(file);
    assert.equal(stored.apiUrl, API_URL);
    assert.equal(stored.accessToken, JWT);
    assert.equal(stored.tenantId, TENANT_ID);
    assert.equal(typeof stored.expiresAt, 'number');
    assert.equal(stored.apiKey, undefined);
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

test('API-key login remains available for CI credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-login-key-'));
    const file = join(root, 'config.json');
    await login({ apiUrl: API_URL, apiKey: 'ci-key' }, { configFile: file, write: () => {} });
    assert.deepEqual(await loadStoredConfig(file), { apiUrl: API_URL, apiKey: 'ci-key' });
});

test('saved browser credentials resolve for deployments and expire locally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-config-'));
    const file = join(root, 'config.json');
    const env = { ZYNO_HOSTING_CONFIG: file };
    await saveConfig({ apiUrl: API_URL, accessToken: JWT, tenantId: TENANT_ID, expiresAt: EXPIRATION }, file);
    assert.deepEqual(await resolveConfig({}, env), {
        apiUrl: API_URL,
        credential: { type: 'bearer', accessToken: JWT, tenantId: TENANT_ID, expiresAt: EXPIRATION }
    });

    await saveConfig({ apiUrl: API_URL, accessToken: JWT, tenantId: TENANT_ID, expiresAt: Date.now() - 1 }, file);
    await assert.rejects(resolveConfig({}, env), (error: unknown) => error instanceof Error && error.message.includes('expired'));
});

test('an explicit SPA login URL works with a custom Hosting API hostname', () => {
    assert.equal(resolveLoginPageUrl(LOGIN_URL, 'https://hosting.example.com'), LOGIN_URL);
});

test('resolves environment API defaults while preserving explicit and saved URLs', () => {
    assert.equal(resolveApiUrl(undefined, {}, {}), 'https://hosting.api.zyno.app');
    assert.equal(resolveApiUrl(undefined, {}, { ZYNO_HOSTING_ENVIRONMENT: 'alpha' }), API_URL);
    assert.equal(resolveApiUrl(undefined, {}, { ZYNO_HOSTING_ENVIRONMENT: 'dev' }), 'http://localhost:39840');
    assert.equal(resolveApiUrl(undefined, { apiUrl: 'https://hosting.example.com' }, {}), 'https://hosting.example.com');
    assert.equal(resolveApiUrl(undefined, { apiUrl: 'https://hosting.example.com' }, { ZYNO_HOSTING_ENVIRONMENT: 'alpha' }), API_URL);
    assert.equal(resolveApiUrl('https://override.example.com', {}, { ZYNO_HOSTING_ENVIRONMENT: 'alpha' }), 'https://override.example.com');
    assert.throws(() => resolveApiUrl(undefined, {}, { ZYNO_HOSTING_ENVIRONMENT: 'staging' }), /Expected production, alpha, or dev/);
});

test('resolves each environment SPA login page', () => {
    assert.equal(resolveLoginPageUrl(undefined, 'https://hosting.api.zyno.app'), 'https://zyno.app/cli/login');
    assert.equal(resolveLoginPageUrl(undefined, API_URL), LOGIN_URL);
    assert.equal(resolveLoginPageUrl(undefined, 'http://localhost:39840'), 'http://localhost:5173/cli/login');
});

const EXPIRATION = Date.now() + 60_000;
