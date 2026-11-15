import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    applyPreparedRuntime,
    applyPreparedSiteSettings,
    parseRuntimeChoice,
    prepareRuntime,
    prepareSiteSettings,
    runtimeSummary
} from '../src/commands/site-settings.js';
import { resolveConfig } from '../src/config.js';
import { CliError } from '../src/errors.js';
import { SECRET, SITE_ID, startFakeKeyServer } from './support/fake-key-server.js';

const code = (promise: Promise<unknown>) =>
    promise.then(
        () => 'ok',
        (error: unknown) => (error instanceof CliError ? error.code : `other: ${String(error)}`)
    );

const env = { ZYNOHOSTING_CONFIG: '/nonexistent/c.json', ZYNOHOSTING_API_KEY: 'zak_x' };

test('runtime choices parse static, php, and php@X.Y only', () => {
    assert.deepEqual(parseRuntimeChoice('static'), { kind: 'static' });
    assert.deepEqual(parseRuntimeChoice('PHP'), { kind: 'php' });
    assert.deepEqual(parseRuntimeChoice('php@8.3'), { kind: 'php', version: '8.3' });
    for (const bad of ['', 'php@', 'php@8', 'node', 'php8.3'])
        assert.throws(
            () => parseRuntimeChoice(bad),
            (error: unknown) => error instanceof CliError && error.code === 'invalid_input'
        );
});

test('turning PHP on without a version uses the platform default and waits for reconciliation', async () => {
    const server = await startFakeKeyServer();
    try {
        const config = await resolveConfig({ apiUrl: server.url }, env);
        const plan = await prepareRuntime('example.com', parseRuntimeChoice('php'), { timeoutSeconds: 5 }, config);
        assert.equal(plan.phpVersion, '8.4');
        const applied = await applyPreparedRuntime(plan);
        assert.equal(applied.status, 'succeeded');
        assert.equal(applied.changed, true);
        const patch = server.seen.find(entry => entry.method === 'PATCH')!;
        assert.deepEqual(patch.body, { phpVersion: '8.4' });
        assert.equal(patch.url, `/v1/sites/${SITE_ID}`);
        assert.equal(server.count('GET', '/v1/php-versions'), 1);
    } finally {
        await server.close();
    }
});

test('php@X.Y is checked against the supported versions, and static sends null', async () => {
    const server = await startFakeKeyServer();
    try {
        const config = await resolveConfig({ apiUrl: server.url }, env);
        assert.equal(await code(prepareRuntime('example.com', parseRuntimeChoice('php@5.6'), {}, config)), 'unsupported_php_version');
        assert.equal(server.count('PATCH', `/v1/sites/${SITE_ID}`), 0);

        server.state.phpVersion = '8.2';
        const plan = await prepareRuntime('example.com', parseRuntimeChoice('static'), { timeoutSeconds: 5 }, config);
        assert.equal(plan.phpVersion, null);
        await applyPreparedRuntime(plan);
        assert.deepEqual(server.seen.find(entry => entry.method === 'PATCH')!.body, { phpVersion: null });
    } finally {
        await server.close();
    }
});

test('an unchanged runtime sends nothing, and enabling PHP over single-page handling says it resets', async () => {
    const server = await startFakeKeyServer();
    try {
        const config = await resolveConfig({ apiUrl: server.url }, env);
        const same = await prepareRuntime('example.com', parseRuntimeChoice('static'), {}, config);
        assert.equal((await applyPreparedRuntime(same)).status, 'unchanged');
        assert.equal(server.count('PATCH', `/v1/sites/${SITE_ID}`), 0);

        server.state.notFoundHandling = 'single-page-application';
        const plan = await prepareRuntime('example.com', parseRuntimeChoice('php@8.3'), {}, config);
        assert.equal(plan.resetsNotFoundHandling, true);
        assert.match(runtimeSummary(plan).effect, /404-page/);
    } finally {
        await server.close();
    }
});

test('a deploy token may change runtime and not-found handling only when it includes production', async () => {
    const server = await startFakeKeyServer();
    try {
        const config = await resolveConfig(
            { apiUrl: server.url, deployTokenAllowed: true },
            { ZYNOHOSTING_CONFIG: '/nonexistent/c.json', ZYNOHOSTING_DEPLOY_TOKEN: SECRET }
        );
        server.state.tokenEnvironments = ['preview'];
        assert.equal(await code(prepareRuntime('example.com', parseRuntimeChoice('php'), {}, config)), 'deploy_token_wrong_environment');
        assert.equal(await code(prepareSiteSettings('example.com', 'single-page-application', {}, config)), 'deploy_token_wrong_environment');
        assert.equal(server.count('PATCH', `/v1/sites/${SITE_ID}`), 0);

        server.state.tokenEnvironments = ['production'];
        const runtime = await prepareRuntime('example.com', parseRuntimeChoice('php'), { timeoutSeconds: 5 }, config);
        assert.equal((await applyPreparedRuntime(runtime)).status, 'succeeded');
        server.state.phpVersion = null;
        const settings = await prepareSiteSettings('example.com', 'single-page-application', { timeoutSeconds: 5 }, config);
        assert.equal((await applyPreparedSiteSettings(settings)).changed, true);
        // Every request used the token, as Basic auth.
        assert(server.seen.every(entry => entry.authorization === `Basic ${Buffer.from(`api:${SECRET}`).toString('base64')}`));
    } finally {
        await server.close();
    }
});
