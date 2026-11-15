import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { authorizationHeaders, ManagerClient } from '../src/api/manager-client.js';
import { prepareDeployment, resolveDeployArguments } from '../src/commands/deploy-site.js';
import { preparePromotion } from '../src/commands/promote-site.js';
import { resolveConfig } from '../src/config.js';
import { diagnoseDeployToken } from '../src/deploy-tokens/guard.js';
import { CliError, HttpError } from '../src/errors.js';
import { KEY_ID, SECRET, SITE_ID, startFakeKeyServer } from './support/fake-key-server.js';

const code = (promise: Promise<unknown>) =>
    promise.then(
        () => 'ok',
        (error: unknown) => (error instanceof CliError ? error.code : `other: ${String(error)}`)
    );

async function config(env: Record<string, string>, url: string, overrides: Record<string, unknown> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'deploy-token-config-'));
    return resolveConfig(
        { apiUrl: url, authApiUrl: url, deployTokenAllowed: true, ...overrides },
        { ZYNOHOSTING_CONFIG: join(root, 'c.json'), ...env }
    );
}

test('ZYNOHOSTING_DEPLOY_TOKEN resolves to a deploy-token credential sent as Basic api:<token>', async () => {
    const resolved = await config({ ZYNOHOSTING_DEPLOY_TOKEN: SECRET }, 'http://127.0.0.1:1');
    assert.deepEqual(resolved.credential, { type: 'deploy-token', token: SECRET });
    assert.deepEqual(await authorizationHeaders(resolved.credential), { Authorization: `Basic ${Buffer.from(`api:${SECRET}`).toString('base64')}` });
});

test('a deploy token with any other credential is a conflict, and the token is never echoed', async () => {
    for (const other of [{ ZYNOHOSTING_API_KEY: 'zak_x' }, { ZYNOHOSTING_ACCESS_TOKEN: 'a.b.c' }]) {
        await assert.rejects(config({ ZYNOHOSTING_DEPLOY_TOKEN: SECRET, ...other }, 'http://127.0.0.1:1'), (error: unknown) => {
            assert(error instanceof CliError);
            assert.equal(error.code, 'conflicting_credentials');
            assert(!error.message.includes(SECRET));
            return true;
        });
    }
    assert.equal(await code(config({ ZYNOHOSTING_DEPLOY_TOKEN: SECRET }, 'http://127.0.0.1:1', { apiKey: 'zak_x' })), 'conflicting_credentials');
});

test('a tenant choice cannot be combined with a deploy token', async () => {
    assert.equal(
        await code(config({ ZYNOHOSTING_DEPLOY_TOKEN: SECRET, ZYNOHOSTING_TENANT: 'acme' }, 'http://127.0.0.1:1')),
        'fixed_credential_source'
    );
    assert.equal(await code(config({ ZYNOHOSTING_DEPLOY_TOKEN: SECRET }, 'http://127.0.0.1:1', { tenant: 'acme' })), 'fixed_credential_source');
});

test('a malformed value is rejected, a tenant API key gets its own message, and neither value is echoed', async () => {
    for (const bad of ['zck_short', `zck_${'!'.repeat(43)}`, `${SECRET}x`, 'plain-text']) {
        await assert.rejects(config({ ZYNOHOSTING_DEPLOY_TOKEN: bad }, 'http://127.0.0.1:1'), (error: unknown) => {
            assert(error instanceof CliError);
            assert.equal(error.code, 'invalid_deploy_token');
            assert(!error.message.includes(bad));
            return true;
        });
    }
    await assert.rejects(config({ ZYNOHOSTING_DEPLOY_TOKEN: 'zak_secretsecretsecret' }, 'http://127.0.0.1:1'), (error: unknown) => {
        assert(error instanceof CliError);
        assert.match(error.message, /tenant API key/);
        assert(!error.message.includes('secretsecret'));
        return true;
    });
});

test('commands that do not opt in refuse a deploy token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-token-config-'));
    const env = { ZYNOHOSTING_CONFIG: join(root, 'c.json'), ZYNOHOSTING_DEPLOY_TOKEN: SECRET };
    await assert.rejects(resolveConfig({ apiUrl: 'http://127.0.0.1:1' }, env), (error: unknown) => {
        assert(error instanceof CliError);
        assert.equal(error.code, 'deploy_token_not_allowed');
        assert(!error.message.includes(SECRET));
        return true;
    });
});

test('deploy resolves one positional argument as the token site or as the directory', async () => {
    const server = await startFakeKeyServer();
    const dir = await mkdtemp(join(tmpdir(), 'deploy-arg-'));
    const dist = join(dir, 'dist');
    await mkdir(dist);
    const resolved = await config({ ZYNOHOSTING_DEPLOY_TOKEN: SECRET }, server.url);
    try {
        assert.deepEqual(await resolveDeployArguments(undefined, undefined, resolved), { site: 'example.com', directory: '.' });
        // The site, by hostname, alias, or id.
        assert.deepEqual(await resolveDeployArguments('example.com', undefined, resolved), { site: 'example.com', directory: '.' });
        assert.deepEqual(await resolveDeployArguments('WWW.example.com', undefined, resolved), { site: 'WWW.example.com', directory: '.' });
        assert.deepEqual(await resolveDeployArguments(SITE_ID, undefined, resolved), { site: SITE_ID, directory: '.' });
        // A directory.
        assert.deepEqual(await resolveDeployArguments(dist, undefined, resolved), { site: 'example.com', directory: dist });
        // Both given.
        assert.deepEqual(await resolveDeployArguments('example.com', dist, resolved), { site: 'example.com', directory: dist });
        // Neither.
        assert.equal(await code(resolveDeployArguments(join(dir, 'missing'), undefined, resolved)), 'deploy_token_wrong_site');
        // Both readings apply: a directory named like the site.
        const cwd = process.cwd();
        process.chdir(dir);
        try {
            await mkdir(join(dir, 'example.com'));
            assert.equal(await code(resolveDeployArguments('example.com', undefined, resolved)), 'ambiguous_deploy_argument');
        } finally {
            process.chdir(cwd);
        }
        assert.equal(server.count('GET', '/v1/sites/example.com'), 0);
    } finally {
        await server.close();
    }
});

test('without a deploy token the site is still required', async () => {
    const resolved = await config({ ZYNOHOSTING_API_KEY: 'zak_x' }, 'http://127.0.0.1:1');
    assert.equal(await code(resolveDeployArguments(undefined, undefined, resolved)), 'invalid_input');
    assert.deepEqual(await resolveDeployArguments('example.com', undefined, resolved), { site: 'example.com', directory: '.' });
    assert.deepEqual(await resolveDeployArguments('example.com', 'dist', resolved), { site: 'example.com', directory: 'dist' });
});

test('a wrong site or an environment the token lacks fails before any upload', async () => {
    const server = await startFakeKeyServer();
    const dir = await mkdtemp(join(tmpdir(), 'deploy-guard-'));
    const resolved = await config({ ZYNOHOSTING_DEPLOY_TOKEN: SECRET }, server.url);
    try {
        assert.equal(await code(prepareDeployment('other.example.org', dir, {}, undefined, resolved)), 'deploy_token_wrong_site');
        assert.equal(await code(prepareDeployment('example.com', dir, { preview: true }, undefined, resolved)), 'deploy_token_wrong_environment');
        assert.equal(await code(preparePromotion('example.com', {}, resolved)), 'deploy_token_wrong_environment');
        assert.equal(server.seen.filter(entry => entry.url.includes('access-sessions')).length, 0);
        // Every call carried the token as Basic auth, to the hosting API only.
        assert(server.seen.every(entry => entry.authorization === `Basic ${Buffer.from(`api:${SECRET}`).toString('base64')}`));
    } finally {
        await server.close();
    }
});

test('a refused deploy token says whether it expired, was revoked, or is just not allowed', async () => {
    const server = await startFakeKeyServer();
    const dir = await mkdtemp(join(tmpdir(), 'deploy-diagnose-'));
    const resolved = await config({ ZYNOHOSTING_DEPLOY_TOKEN: SECRET }, server.url);
    const manager = new ManagerClient(server.url, resolved.credential);
    void manager;
    try {
        server.state.whoamiStatus = 401;
        server.state.self = { httpStatus: 401, body: { error: 'Capability key has expired' } };
        assert.equal(await code(prepareDeployment('example.com', dir, {}, undefined, resolved)), 'deploy_token_expired');

        server.state.self = { httpStatus: 403, body: { error: 'Invalid API key' } };
        assert.equal(await code(prepareDeployment('example.com', dir, {}, undefined, resolved)), 'deploy_token_revoked');

        server.state.whoamiStatus = 403;
        server.state.self = { httpStatus: 200, body: { id: KEY_ID, expiresAt: new Date(Date.now() + 86_400_000).toISOString() } };
        assert.equal(await code(prepareDeployment('example.com', dir, {}, undefined, resolved)), 'deploy_token_wrong_environment');
    } finally {
        await server.close();
    }
});

test('a preview-only token on a PHP site is refused up front and when the manager says so', async () => {
    const server = await startFakeKeyServer();
    const dir = await mkdtemp(join(tmpdir(), 'deploy-php-'));
    const resolved = await config({ ZYNOHOSTING_DEPLOY_TOKEN: SECRET }, server.url);
    try {
        server.state.phpVersion = '8.4';
        server.state.tokenEnvironments = ['preview'];
        assert.equal(await code(prepareDeployment('example.com', dir, { preview: true }, undefined, resolved)), 'deploy_token_requires_production');
        assert.equal(server.seen.filter(entry => entry.url.includes('access-sessions')).length, 0);

        // The manager's own refusal (PHP enabled after approval) maps to the same code.
        const refusal = new HttpError(
            'This site runs PHP, so preview code can reach production; a deploy token for this site must include production.',
            403,
            'http_error'
        );
        assert.equal(await code(diagnoseDeployToken(resolved, refusal)), 'deploy_token_requires_production');
    } finally {
        await server.close();
    }
});
