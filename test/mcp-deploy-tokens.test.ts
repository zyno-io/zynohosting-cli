import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AllowedLocalRoots } from '../src/mcp/local-paths.js';
import { createHostingMcpServer } from '../src/mcp/server.js';
import { displayApprovedPoll, HUMAN_JWT, KEY_ID, listRow, REQUEST_CODE, SECRET, SITE_ID, startFakeKeyServer } from './support/fake-key-server.js';

async function connect(url: string, extraEnv: Record<string, string>) {
    const root = await mkdtemp(join(tmpdir(), 'mcp-deploy-tokens-'));
    const hosting = await createHostingMcpServer({
        roots: await AllowedLocalRoots.create([root]),
        version: '0.7.0',
        apiUrl: url,
        authApiUrl: url,
        env: { ZYNOHOSTING_CONFIG: join(root, 'c.json'), ...extraEnv }
    });
    const client = new Client({ name: 'deploy-token-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await hosting.connect(serverTransport);
    await client.connect(clientTransport);
    return {
        client,
        async close() {
            await client.close();
            await hosting.close();
        }
    };
}

type Called = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ called: Called; text: string }> {
    const called = (await client.callTool({ name, arguments: args })) as Called;
    return { called, text: JSON.stringify(called) };
}

test('request_deploy_token returns a link and code, never the token or the request code', async () => {
    const server = await startFakeKeyServer();
    const mcp = await connect(server.url, { ZYNOHOSTING_ACCESS_TOKEN: HUMAN_JWT });
    try {
        const { called, text } = await call(mcp.client, 'request_deploy_token', {
            site: 'example.com',
            environments: ['production'],
            ci: 'github',
            lifetimeDays: 30,
            permissions: ['hosting.sitesRead']
        });
        assert(!called.isError, text);
        assert(!text.includes(SECRET));
        assert(!text.includes(REQUEST_CODE), 'the request code stays inside the server process');
        assert.equal(called.structuredContent?.userCode, 'ABCD-EFGH');
        assert.match(String(called.structuredContent?.verificationUriComplete), /\/api-keys\/approve\?code=ABCD-EFGH$/);

        const start = server.seen.find(entry => entry.url === '/identity/api-key-requests')!;
        assert.equal(start.body.delivery, 'display', 'the MCP asks for display delivery only');
        assert.deepEqual(start.body.handoff, { kind: 'github-secret' });
        assert.equal(start.body.requestedLifetimeSecs, 30 * 86_400);
        assert.deepEqual(start.body.permissions, ['hosting.sitesRead']);
        assert.deepEqual(start.body.grants, { hosting: [{ v: 1, siteId: SITE_ID, environments: ['production'] }] });
        assert.deepEqual(called.structuredContent?.permissions, ['hosting.sitesRead']);
    } finally {
        await mcp.close();
        await server.close();
    }
});

test('deploy_token_status reports approval without the token, even when the server wrongly sends it', async () => {
    const server = await startFakeKeyServer();
    server.state.polls = [{ status: 'pending' }, displayApprovedPoll({ secret: SECRET })];
    const mcp = await connect(server.url, { ZYNOHOSTING_ACCESS_TOKEN: HUMAN_JWT });
    try {
        const requested = await call(mcp.client, 'request_deploy_token', { site: 'example.com', environments: ['preview', 'production'] });
        const requestId = String(requested.called.structuredContent?.requestId);

        const pending = await call(mcp.client, 'deploy_token_status', { requestId });
        assert.equal(pending.called.structuredContent?.status, 'pending');

        const approved = await call(mcp.client, 'deploy_token_status', { requestId });
        assert(!approved.called.isError, approved.text);
        assert.equal(approved.called.structuredContent?.status, 'approved');
        assert.equal(approved.called.structuredContent?.keyId, KEY_ID);
        assert(!approved.text.includes(SECRET));
        assert(!approved.text.includes(SECRET.slice(4)));
        assert(!approved.text.includes(REQUEST_CODE));

        const unknown = await call(mcp.client, 'deploy_token_status', { requestId: 'nope' });
        assert.equal(unknown.called.isError, true);
    } finally {
        await mcp.close();
        await server.close();
    }
});

test('list_deploy_tokens and revoke_deploy_token never expose a token', async () => {
    const server = await startFakeKeyServer();
    server.state.keys = [listRow({ createdByEmail: 'owner@example.com' })];

    const mcp = await connect(server.url, { ZYNOHOSTING_ACCESS_TOKEN: HUMAN_JWT });
    try {
        const listed = await call(mcp.client, 'list_deploy_tokens', { site: 'example.com' });
        assert(!listed.called.isError, listed.text);
        assert(!listed.text.includes(SECRET));
        assert.equal((listed.called.structuredContent?.tokens as unknown[]).length, 1);
        const revoked = await call(mcp.client, 'revoke_deploy_token', { keyId: KEY_ID });
        assert.equal(revoked.called.structuredContent?.status, 'revoked');
        assert.equal(server.count('DELETE', `/tenant/api-keys/${KEY_ID}`), 1);
    } finally {
        await mcp.close();
        await server.close();
    }
});

test('set_runtime turns PHP on and off', async () => {
    const server = await startFakeKeyServer();
    const mcp = await connect(server.url, { ZYNOHOSTING_ACCESS_TOKEN: HUMAN_JWT });
    try {
        const tools = (await mcp.client.listTools()).tools.map(tool => tool.name);
        for (const name of ['set_runtime', 'request_deploy_token', 'deploy_token_status', 'list_deploy_tokens', 'revoke_deploy_token'])
            assert(tools.includes(name), name);

        const on = await call(mcp.client, 'set_runtime', { site: 'example.com', runtime: 'php', phpVersion: '8.3' });
        assert(!on.called.isError, on.text);
        assert.equal(on.called.structuredContent?.phpVersion, '8.3');
        const bad = await call(mcp.client, 'set_runtime', { site: 'example.com', runtime: 'static', phpVersion: '8.3' });
        assert.equal(bad.called.isError, true);
        const off = await call(mcp.client, 'set_runtime', { site: 'example.com', runtime: 'static' });
        assert.equal(off.called.structuredContent?.phpVersion, null);
    } finally {
        await mcp.close();
        await server.close();
    }
});

test('an MCP process holding a deploy token can use only the deploy-token tools', async () => {
    const server = await startFakeKeyServer();
    const mcp = await connect(server.url, { ZYNOHOSTING_DEPLOY_TOKEN: SECRET });
    try {
        for (const [name, args] of [
            ['list_sites', {}],
            ['get_site', { site: 'example.com' }],
            ['request_deploy_token', { site: 'example.com', environments: ['production'] }],
            ['list_deploy_tokens', {}],
            ['list_files', { site: 'example.com' }]
        ] as const) {
            const result = await call(mcp.client, name, args as Record<string, unknown>);
            assert.equal(result.called.isError, true, name);
            assert.match(result.text, /deploy token/i, name);
            assert(!result.text.includes(SECRET));
        }
        assert.equal(server.seen.length, 0, 'nothing reached the server');

        const runtime = await call(mcp.client, 'set_runtime', { site: 'example.com', runtime: 'php' });
        assert(!runtime.called.isError, runtime.text);
        assert(!runtime.text.includes(SECRET));
        assert(server.seen.every(entry => entry.authorization === `Basic ${Buffer.from(`api:${SECRET}`).toString('base64')}`));
    } finally {
        await mcp.close();
        await server.close();
    }
});

test('set_runtime with php and no version keeps the version of a site already running PHP', async () => {
    const server = await startFakeKeyServer();
    server.state.phpVersion = '8.2';
    const mcp = await connect(server.url, { ZYNOHOSTING_ACCESS_TOKEN: HUMAN_JWT });
    try {
        const result = await call(mcp.client, 'set_runtime', { site: 'example.com', runtime: 'php' });
        assert(!result.called.isError, result.text);
        assert.equal(result.called.structuredContent?.phpVersion, '8.2');
        assert.equal(result.called.structuredContent?.status, 'unchanged');
        assert.equal(server.count('PATCH', `/v1/sites/${SITE_ID}`), 0);
    } finally {
        await mcp.close();
        await server.close();
    }
});

test('request_deploy_token rejects a malformed permissions input before anything is requested, and omits it by default', async () => {
    const server = await startFakeKeyServer();
    const mcp = await connect(server.url, { ZYNOHOSTING_ACCESS_TOKEN: HUMAN_JWT });
    try {
        const bad = await call(mcp.client, 'request_deploy_token', {
            site: 'example.com',
            environments: ['production'],
            permissions: ['Hosting Sites']
        });
        assert(bad.called.isError, 'a malformed permission key is refused');
        assert.equal(server.count('POST', '/identity/api-key-requests'), 0);

        const plain = await call(mcp.client, 'request_deploy_token', { site: 'example.com', environments: ['production'] });
        assert(!plain.called.isError, plain.text);
        const start = server.seen.find(entry => entry.url === '/identity/api-key-requests')!;
        assert.deepEqual(start.body.permissions, []);
    } finally {
        await mcp.close();
        await server.close();
    }
});

test('revoke_deploy_token is idempotent: an id ZynoAuth no longer has is already_revoked', async () => {
    const server = await startFakeKeyServer();
    server.state.revokeStatus = 404;
    const mcp = await connect(server.url, { ZYNOHOSTING_ACCESS_TOKEN: HUMAN_JWT });
    try {
        const revoked = await call(mcp.client, 'revoke_deploy_token', { keyId: KEY_ID });
        assert(!revoked.called.isError, revoked.text);
        assert.equal(revoked.called.structuredContent?.status, 'revoked');
        assert.equal(revoked.called.structuredContent?.already_revoked, true);
    } finally {
        await mcp.close();
        await server.close();
    }
});
