import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createProgram } from '../src/cli.js';
import { applyPreparedSiteSettings, prepareSiteSettings, setSiteSettings, siteSettingsSummary } from '../src/commands/site-settings.js';
import { CliError } from '../src/errors.js';
import { AllowedLocalRoots } from '../src/mcp/local-paths.js';
import { createHostingMcpServer } from '../src/mcp/server.js';
import { operationId, previewManager, siteId } from './fixtures/preview-manager.js';

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
    const original = process.stdout.write.bind(process.stdout);
    let out = '';
    // The test runner reports over stdout as binary frames; only capture the CLI's string output.
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        if (typeof chunk !== 'string') return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
        out += chunk;
        return true;
    }) as typeof process.stdout.write;
    try {
        await fn();
    } finally {
        process.stdout.write = original;
    }
    return out;
}

async function rejectsWithCode(promise: Promise<unknown>, code: string, exitCode: number) {
    await assert.rejects(promise, (error: unknown) => {
        assert(error instanceof CliError);
        assert.equal(error.code, code);
        assert.equal(error.exitCode, exitCode);
        return true;
    });
}

const spa = 'single-page-application';

test('sites set patches the site and waits for reconciliation', async t => {
    const fixture = await previewManager(t);
    const out = await captureStdout(() =>
        createProgram().parseAsync([
            'node',
            'zynohosting',
            '--api-url',
            fixture.baseUrl,
            '--api-key',
            'secret',
            'sites',
            'set',
            'example.com',
            '--not-found',
            spa,
            '--yes',
            '--json'
        ])
    );
    const events = out
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .filter(event => event.type !== 'progress');
    assert.deepEqual(
        events.map(event => event.type),
        ['site_settings_plan', 'site_settings_result']
    );
    assert.equal(events[1]!.changed, true);
    assert.equal(events[1]!.operationId, operationId);
    assert.equal(fixture.state.notFoundHandling, spa);
    assert.equal(fixture.state.polls, 1);
    assert.deepEqual(fixture.bodies, [{ notFoundHandling: spa }]);
    assert(fixture.requests.includes(`PATCH /v1/sites/${siteId}`));
});

test('sites set --dry-run reads the site and changes nothing', async t => {
    const fixture = await previewManager(t);
    await captureStdout(() => setSiteSettings('example.com', { apiUrl: fixture.baseUrl, apiKey: 'secret', notFound: spa, dryRun: true, json: true }));
    assert.deepEqual(fixture.requests, ['GET /v1/sites/example.com']);
    assert.equal(fixture.state.settingsPatches, 0);
});

test('sites set --json without --yes or --dry-run is refused before any change', async t => {
    const fixture = await previewManager(t);
    await captureStdout(() =>
        rejectsWithCode(
            setSiteSettings('example.com', { apiUrl: fixture.baseUrl, apiKey: 'secret', notFound: spa, json: true }),
            'confirmation_required',
            2
        )
    );
    assert.equal(fixture.state.settingsPatches, 0);
});

test('sites set without a terminal needs --yes or --dry-run', async t => {
    const fixture = await previewManager(t);
    const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
        await captureStdout(() =>
            rejectsWithCode(setSiteSettings('example.com', { apiUrl: fixture.baseUrl, apiKey: 'secret', notFound: spa }), 'confirmation_required', 2)
        );
    } finally {
        if (original) Object.defineProperty(process.stdin, 'isTTY', original);
        else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    assert.equal(fixture.state.settingsPatches, 0);
});

test('sites set without a setting is invalid input', async t => {
    const fixture = await previewManager(t);
    await rejectsWithCode(setSiteSettings('example.com', { apiUrl: fixture.baseUrl, apiKey: 'secret', yes: true }), 'invalid_input', 2);
    assert.equal(fixture.state.settingsPatches, 0);
});

test('an unchanged setting still PATCHes and reconciles, reporting changed false', async t => {
    const fixture = await previewManager(t);
    const plan = await prepareSiteSettings('example.com', '404-page', { apiUrl: fixture.baseUrl, apiKey: 'secret' });
    const result = await applyPreparedSiteSettings(plan);
    assert.equal(result.changed, false);
    assert.equal(fixture.state.settingsPatches, 1);
    assert.equal(fixture.state.polls, 1);
});

test('enabling the SPA fallback on a PHP site is rejected before sending', async t => {
    const fixture = await previewManager(t);
    fixture.state.phpVersion = '8.4';
    await rejectsWithCode(
        prepareSiteSettings('example.com', spa, { apiUrl: fixture.baseUrl, apiKey: 'secret' }),
        'not_found_handling_requires_static',
        2
    );
    assert.equal(fixture.state.settingsPatches, 0);
    // Resetting to the default is still allowed on PHP sites.
    await prepareSiteSettings('example.com', '404-page', { apiUrl: fixture.baseUrl, apiKey: 'secret' });
});

test('a manager that omits notFoundHandling is unavailable for sites set', async t => {
    const fixture = await previewManager(t);
    fixture.state.omitNotFoundHandling = true;
    await rejectsWithCode(
        prepareSiteSettings('example.com', spa, { apiUrl: fixture.baseUrl, apiKey: 'secret' }),
        'not_found_handling_unavailable',
        5
    );
    assert.equal(fixture.state.settingsPatches, 0);
});

test('failed reconciliation is reported as such and a retry does not resubmit', async t => {
    const fixture = await previewManager(t);
    fixture.state.failReconciliation = true;
    const plan = await prepareSiteSettings('example.com', spa, { apiUrl: fixture.baseUrl, apiKey: 'secret' });
    await rejectsWithCode(applyPreparedSiteSettings(plan), 'reconciliation_failed', 7);
    await rejectsWithCode(applyPreparedSiteSettings(plan), 'reconciliation_failed', 7);
    assert.equal(fixture.state.settingsPatches, 1);
});

test('an expired deadline reports reconciliation_pending with the operation id', async t => {
    const fixture = await previewManager(t);
    const plan = await prepareSiteSettings('example.com', spa, { apiUrl: fixture.baseUrl, apiKey: 'secret' });
    plan.timeoutMs = -1;
    await assert.rejects(applyPreparedSiteSettings(plan), (error: unknown) => {
        assert(error instanceof CliError);
        assert.equal(error.code, 'reconciliation_pending');
        assert.equal(error.exitCode, 7);
        return true;
    });
    assert.equal(fixture.state.settingsPatches, 1);
});

test('sites get prints the setting only when the manager reports it', async t => {
    const fixture = await previewManager(t);
    const run = () =>
        captureStdout(() =>
            createProgram().parseAsync(['node', 'zynohosting', '--api-url', fixture.baseUrl, '--api-key', 'secret', 'sites', 'get', 'example.com'])
        );
    assert.match(await run(), /Not found: 404 page/);
    fixture.state.notFoundHandling = spa;
    assert.match(await run(), /Not found: single-page app/);
    fixture.state.omitNotFoundHandling = true;
    assert.doesNotMatch(await run(), /Not found:/);
    // PHP sites ignore the setting, so it is not shown.
    fixture.state.omitNotFoundHandling = false;
    fixture.state.phpVersion = '8.4';
    assert.doesNotMatch(await run(), /Not found:/);
});

test('MCP set_not_found_handling is annotated, applies the change, and instructions fit the limit', async t => {
    const fixture = await previewManager(t);
    const root = await mkdtemp(join(tmpdir(), 'zh-nf-'));
    const configFile = join(root, 'hosting-config.json');
    await writeFile(configFile, JSON.stringify({ apiUrl: fixture.baseUrl, apiKey: 'secret' }));
    const hosting = await createHostingMcpServer({
        roots: await AllowedLocalRoots.create([root]),
        version: '0.6.0',
        env: { ZYNOHOSTING_CONFIG: configFile, ZYNOHOSTING_API_URL: fixture.baseUrl }
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await hosting.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(() => client.close());
    const instructions = client.getInstructions();
    assert(instructions);
    assert(instructions.length <= 4096, `instructions are ${instructions.length} chars`);
    assert.match(instructions, /set_not_found_handling/);
    const tool = (await client.listTools()).tools.find(entry => entry.name === 'set_not_found_handling');
    assert(tool);
    assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    const applied = await client.callTool({ name: 'set_not_found_handling', arguments: { site: 'example.com', mode: spa } });
    assert.equal(applied.isError, undefined);
    assert.equal((applied.structuredContent as { notFoundHandling: string }).notFoundHandling, spa);
    assert.equal(fixture.state.notFoundHandling, spa);
    const invalid = await client.callTool({ name: 'set_not_found_handling', arguments: { site: 'example.com', mode: 'bogus' } });
    assert.equal(invalid.isError, true);
    fixture.state.phpVersion = '8.4';
    fixture.state.notFoundHandling = '404-page';
    const php = await client.callTool({ name: 'set_not_found_handling', arguments: { site: 'example.com', mode: spa } });
    assert.equal(php.isError, true);
    assert.equal(fixture.state.settingsPatches, 1);
});

test('an invalid --not-found value is invalid_input (exit 2), not a commander error', async t => {
    const fixture = await previewManager(t);
    await rejectsWithCode(
        createProgram().parseAsync([
            'node',
            'zynohosting',
            '--api-url',
            fixture.baseUrl,
            '--api-key',
            'secret',
            'sites',
            'set',
            'example.com',
            '--not-found',
            'bogus',
            '--yes',
            '--json'
        ]),
        'invalid_input',
        2
    );
    assert.equal(fixture.state.settingsPatches, 0);
});

test('resetting to 404-page on a PHP site explains the setting has no effect', async t => {
    const fixture = await previewManager(t);
    fixture.state.phpVersion = '8.4';
    const plan = await prepareSiteSettings('example.com', '404-page', { apiUrl: fixture.baseUrl, apiKey: 'secret' });
    assert.match(siteSettingsSummary(plan).effect, /no effect while PHP is on/);
});

test('MCP set_not_found_handling normalizes the site reference like the CLI', async t => {
    const fixture = await previewManager(t);
    const root = await mkdtemp(join(tmpdir(), 'zh-nf-'));
    const configFile = join(root, 'hosting-config.json');
    await writeFile(configFile, JSON.stringify({ apiUrl: fixture.baseUrl, apiKey: 'secret' }));
    const hosting = await createHostingMcpServer({
        roots: await AllowedLocalRoots.create([root]),
        version: '0.6.0',
        env: { ZYNOHOSTING_CONFIG: configFile, ZYNOHOSTING_API_URL: fixture.baseUrl }
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await hosting.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(() => client.close());
    const applied = await client.callTool({ name: 'set_not_found_handling', arguments: { site: ' EXAMPLE.com ', mode: spa } });
    assert.equal(applied.isError, undefined);
    assert(fixture.requests.every(request => !request.includes('EXAMPLE') && !request.includes('%20')));
});
