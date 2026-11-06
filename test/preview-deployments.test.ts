import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ManagerClient } from '../src/api/manager-client.js';
import { createProgram } from '../src/cli.js';
import { AllowedLocalRoots } from '../src/mcp/local-paths.js';
import { createHostingMcpServer } from '../src/mcp/server.js';
import { previewManager } from './fixtures/preview-manager.js';

async function sourceDirectory(t: { after(fn: () => unknown): void }) {
    const root = await mkdtemp(join(tmpdir(), 'zh-cli-preview-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist', 'index.html'), 'new-preview');
    return { root, source: join(root, 'dist') };
}

for (const preview of [false, true]) {
    test(`CLI deploy ${preview ? '--preview isolates production' : 'keeps production as its default'}`, async t => {
        const fixture = await previewManager(t);
        const { source } = await sourceDirectory(t);
        await createProgram().parseAsync([
            'node',
            'zynohosting',
            '--api-url',
            fixture.baseUrl,
            '--api-key',
            'secret',
            'deploy',
            'example.com',
            source,
            '--yes',
            '--json',
            ...(preview ? ['--preview'] : [])
        ]);
        assert.equal(fixture.state.productionContent, preview ? 'live' : 'new-preview');
        assert.equal(fixture.state.previewContent, preview ? 'new-preview' : 'preview-v1');
        assert.equal(fixture.state.promotions, 0);
        assert.equal((fixture.bodies[0] as { target?: string }).target, preview ? 'preview' : undefined);
    });
}

test('preview upload refuses an older manager that ignores or changes the requested slot', async t => {
    const fixture = await previewManager(t);
    const manager = new ManagerClient(fixture.baseUrl, { type: 'api-key', apiKey: 'secret' });
    fixture.state.omitTarget = true;
    await assert.rejects(manager.createDeploymentSession('example.com', 'preview'), /did not authorize/);
    fixture.state.omitTarget = false;
    fixture.state.grantedTarget = 'production';
    await assert.rejects(manager.createDeploymentSession('example.com', 'preview'), /did not authorize/);
    assert.equal(fixture.state.productionContent, 'live');
});

test('MCP plans/applies preview uploads and promotion through the manager contract', async t => {
    const fixture = await previewManager(t);
    const { root, source } = await sourceDirectory(t);
    const hosting = await createHostingMcpServer({
        roots: await AllowedLocalRoots.create([root]),
        version: 'test',
        apiUrl: fixture.baseUrl,
        apiKey: 'secret'
    });
    const client = new Client({ name: 'preview-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await hosting.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => {
        await client.close();
        await hosting.close();
    });

    const planned = await client.callTool({ name: 'plan_deploy', arguments: { site: 'example.com', local_root: source, target: 'preview' } });
    assert.equal(planned.isError, undefined);
    const plan = planned.structuredContent as { planId: string; target: string; url: string; resourceNotice: string };
    assert.equal(plan.target, 'preview');
    assert.match(plan.resourceNotice, /no separate database/);
    assert.match(plan.resourceNotice, /storage quota/);
    assert.equal(plan.url, 'https://example-com-preview.aspen.zynohosting.net');
    assert.equal(fixture.state.productionContent, 'live');
    assert.equal(fixture.state.previewContent, 'preview-v1');
    const applied = await client.callTool({ name: 'apply_deploy', arguments: { plan_id: plan.planId } });
    assert.equal(applied.isError, undefined);
    assert.equal((applied.structuredContent as { target: string }).target, 'preview');
    assert.equal(fixture.state.productionContent, 'live');
    assert.equal(fixture.state.previewContent, 'new-preview');

    const plannedPromotion = await client.callTool({ name: 'plan_promote', arguments: { site: 'example.com' } });
    assert.equal(plannedPromotion.isError, undefined);
    const promotion = plannedPromotion.structuredContent as { planId: string; productionUrl: string; previewUrl: string };
    assert.equal(promotion.productionUrl, 'https://example.com');
    assert.equal(promotion.previewUrl, plan.url);
    assert.equal(fixture.state.promotions, 0);
    const promoted = await client.callTool({ name: 'apply_promote', arguments: { plan_id: promotion.planId } });
    assert.equal(promoted.isError, undefined);
    assert.equal((promoted.structuredContent as { status: string }).status, 'succeeded');
    assert.equal(fixture.state.productionContent, 'new-preview');
    assert.equal(fixture.state.polls, 1);
    assert.equal(fixture.state.previewContent, '');
    const replay = await client.callTool({ name: 'apply_promote', arguments: { plan_id: promotion.planId } });
    assert.equal(replay.isError, true);
    assert.equal(fixture.state.promotions, 1);
});

test('MCP rejects unknown plans and reports stale production without applying', async t => {
    const fixture = await previewManager(t);
    const hosting = await createHostingMcpServer({
        roots: await AllowedLocalRoots.create([]),
        version: 'test',
        apiUrl: fixture.baseUrl,
        apiKey: 'secret'
    });
    const client = new Client({ name: 'stale-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await hosting.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => {
        await client.close();
        await hosting.close();
    });
    const unknown = await client.callTool({ name: 'apply_promote', arguments: { plan_id: 'unknown' } });
    assert.equal(unknown.isError, true);
    const planned = await client.callTool({ name: 'plan_promote', arguments: { site: 'example.com' } });
    fixture.state.productionId = '44444444-4444-4444-8444-444444444444';
    const stale = await client.callTool({ name: 'apply_promote', arguments: { plan_id: (planned.structuredContent as { planId: string }).planId } });
    assert.equal(stale.isError, true);
    assert.match(JSON.stringify(stale), /production changed/);
    assert.equal(fixture.state.promotions, 0);
});
