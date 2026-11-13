import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { updateProfile } from '../src/config.js';
import { AllowedLocalRoots } from '../src/mcp/local-paths.js';
import { createHostingMcpServer } from '../src/mcp/server.js';
import { approvedPoll, DEVICE_CODE, JWT, RENEWAL_TOKEN, startFakeAuth, TENANT_ID, USER_CODE } from './support/fake-auth.js';

const ACME = '00000000-0000-0000-0000-0000000000a1';
const GLOBEX = '00000000-0000-0000-0000-0000000000b2';

async function connect(options: Parameters<typeof createHostingMcpServer>[0]) {
    const hosting = await createHostingMcpServer(options);
    const client = new Client({ name: 'logins-test-client', version: '1.0.0' });
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

async function manager() {
    const seen: string[] = [];
    const server = createServer((request, response) => {
        seen.push(String(request.headers.authorization));
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/v1/sites') {
            response.end(JSON.stringify([{ id: '11111111-1111-4111-8111-111111111111', fqdn: 'example.com', status: 'active', phpVersion: null }]));
            return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ message: 'not found' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    return {
        seen,
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    };
}

test('list_logins, use_login and a per-call tenant choose between saved logins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-mcp-logins-'));
    const file = join(root, 'config.json');
    const hosting = await manager();
    const key = `url:${hosting.url}`;
    const login = (tenantId: string, name: string) => ({
        tenantId,
        tenantName: name,
        accountEmail: 'owner@example.com',
        accessToken: `${name.toLowerCase()}.jwt.signature`,
        expiresAt: Date.now() + 3_600_000,
        scopedToken: true as const
    });
    await updateProfile(
        key,
        { apiUrl: hosting.url, logins: { [ACME]: login(ACME, 'Acme'), [GLOBEX]: login(GLOBEX, 'Globex') }, activeLogin: ACME },
        file
    );
    const { client, close } = await connect({
        roots: await AllowedLocalRoots.create([root]),
        version: '1.0.0',
        apiUrl: hosting.url,
        env: { ZYNOHOSTING_CONFIG: file }
    });
    try {
        const { tools } = await client.listTools();
        // Every tool but the sign-in ones takes an optional tenant; list_logins takes nothing; use_login requires it.
        const schemaOf = (name: string) =>
            tools.find(tool => tool.name === name)!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
        for (const name of ['list_sites', 'get_site', 'set_not_found_handling', 'plan_deploy', 'list_forms', 'create_basic_form']) {
            assert(schemaOf(name).properties && 'tenant' in schemaOf(name).properties!, `${name} should accept tenant`);
            assert('account' in schemaOf(name).properties!, `${name} should accept account`);
            assert(!(schemaOf(name).required ?? []).includes('tenant'), `${name} tenant must be optional`);
        }
        assert.equal(schemaOf('login').properties && 'tenant' in schemaOf('login').properties!, false);
        assert.equal(schemaOf('list_logins').properties && 'tenant' in schemaOf('list_logins').properties!, false);
        assert.deepEqual(schemaOf('use_login').required, ['tenant']);

        const listed = (await client.callTool({ name: 'list_logins', arguments: {} })).structuredContent as {
            profile: string;
            logins: { loginId: string; tenantName: string; active: boolean }[];
        };
        assert.deepEqual(
            listed.logins.map(item => [item.loginId, item.tenantName, item.active]),
            [
                [`unknown:${ACME}`, 'Acme', true],
                [`unknown:${GLOBEX}`, 'Globex', false]
            ]
        );
        assert(!JSON.stringify(listed).includes('jwt.signature'));

        await client.callTool({ name: 'list_sites', arguments: {} });
        await client.callTool({ name: 'list_sites', arguments: { tenant: 'Globex' } });
        await client.callTool({ name: 'list_sites', arguments: {} });
        assert.deepEqual(hosting.seen, ['Bearer acme.jwt.signature', 'Bearer globex.jwt.signature', 'Bearer acme.jwt.signature']);

        const unknown = await client.callTool({ name: 'list_sites', arguments: { tenant: 'Initech' } });
        assert.equal(unknown.isError, true);
        assert.match(JSON.stringify(unknown.content), /No saved login/);

        const switched = await client.callTool({ name: 'use_login', arguments: { tenant: GLOBEX } });
        assert.equal(switched.isError, undefined);
        await client.callTool({ name: 'list_sites', arguments: {} });
        assert.equal(hosting.seen.at(-1), 'Bearer globex.jwt.signature');
        const status = (await client.callTool({ name: 'login', arguments: { action: 'status' } })).structuredContent as Record<string, unknown>;
        assert.equal(status.authenticated, true);
        assert.equal(status.tenant, GLOBEX);
        assert.equal(status.tenantName, 'Globex');
        assert.equal(status.account, 'owner@example.com');
        assert.match(await readFile(file, 'utf8'), new RegExp(`"activeLogin": "unknown:${GLOBEX}"`));
    } finally {
        await close();
        await hosting.close();
    }
});

test('the device sign-in through MCP returns the link and code, never the device code, and completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-mcp-device-'));
    const file = join(root, 'config.json');
    const auth = await startFakeAuth([{ status: 'pending' }, approvedPoll({}, { renewalToken: RENEWAL_TOKEN })]);
    const hosting = await manager();
    const { client, close } = await connect({
        roots: await AllowedLocalRoots.create([root]),
        version: '1.0.0',
        apiUrl: hosting.url,
        authApiUrl: auth.url,
        env: { ZYNOHOSTING_CONFIG: file, ZYNOHOSTING_CREDENTIAL_STORE: 'file' },
        // The chooser would pick the browser here, so ask for the device flow the way a headless host would get it.
        loginDependencies: { platform: 'linux' }
    });
    try {
        const started = await client.callTool({
            name: 'login',
            arguments: { flow: 'device', permissions: ['hosting.sitesRead'], renewable: true, lifetime: '7d' }
        });
        assert.equal(started.isError, undefined);
        const content = started.structuredContent as Record<string, unknown>;
        assert.equal(content.status, 'pending');
        assert.equal(content.flow, 'device');
        assert.equal(content.userCode, USER_CODE);
        assert.equal(content.verificationUri, `${auth.url}/cli/device`);
        assert.equal(content.verificationUriComplete, `${auth.url}/cli/device?code=${USER_CODE}`);
        assert.equal(content.reused, false);
        assert.match(String(content.message), /Do not open the link or approve it yourself/);
        assert.equal(content.browserUrl, undefined);

        const again = (
            await client.callTool({
                name: 'login',
                arguments: { flow: 'device', permissions: ['hosting.sitesRead'], renewable: true, lifetime: '7d' }
            })
        ).structuredContent as Record<string, unknown>;
        assert.equal(again.reused, true);
        assert.equal(auth.count('/identity/scoped-tokens/device/start'), 1);

        let status: Record<string, unknown> = {};
        for (let attempt = 0; attempt < 100 && status.authenticated !== true; attempt++) {
            status = (await client.callTool({ name: 'login', arguments: { action: 'status' } })).structuredContent as Record<string, unknown>;
            if (status.status === 'pending') assert.equal(status.userCode, USER_CODE);
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(status.authenticated, true);
        assert.equal(status.tenant, TENANT_ID);
        assert.equal(status.tenantName, 'Acme Co');
        assert.equal(status.account, 'owner@example.com');
        assert.deepEqual(status.permissionKeys, ['hosting.sitesRead']);
        assert.deepEqual(status.deniedPermissionKeys, []);
        assert.match(String(status.grantExpiresAt), /^\d{4}-/);
        const sites = await client.callTool({ name: 'list_sites', arguments: {} });
        assert.equal(sites.isError, undefined);
        assert.equal(hosting.seen.at(-1), `Bearer ${JWT}`);

        // Nothing the model can see carries the device code, the access token or the renewal token.
        const everything = JSON.stringify([started, again, status]);
        assert(!everything.includes(DEVICE_CODE));
        assert(!everything.includes(RENEWAL_TOKEN));
        assert(!everything.includes(JWT));
        assert.match(await readFile(join(root, 'config.renewal-tokens.json'), 'utf8'), /zrt_first-secret-token/);
        assert.doesNotMatch(await readFile(file, 'utf8'), /zrt_/);
    } finally {
        await close();
        await auth.close();
        await hosting.close();
    }
});

test('cancelling a device sign-in through MCP cancels the code on the server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-mcp-device-cancel-'));
    const auth = await startFakeAuth([{ status: 'pending' }]);
    const { client, close } = await connect({
        roots: await AllowedLocalRoots.create([root]),
        version: '1.0.0',
        apiUrl: 'http://127.0.0.1:1',
        authApiUrl: auth.url,
        env: { ZYNOHOSTING_CONFIG: join(root, 'config.json') }
    });
    try {
        await client.callTool({ name: 'login', arguments: { renewable: false, flow: 'device' } });
        const cancelled = (await client.callTool({ name: 'login', arguments: { action: 'cancel' } })).structuredContent as Record<string, unknown>;
        assert.equal(cancelled.status, 'cancelled');
        assert.equal(auth.count('/identity/scoped-tokens/device/cancel'), 1);
        assert.equal(auth.requests.find(request => request.path.endsWith('/device/cancel'))!.body.deviceCode, DEVICE_CODE);
        assert(!JSON.stringify(cancelled).includes(DEVICE_CODE));
    } finally {
        await close();
        await auth.close();
    }
});

test('a server without device sign-in reports it through the login tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-mcp-device-off-'));
    const auth = await startFakeAuth([{ status: 'pending' }]);
    auth.startStatus = 503;
    const { client, close } = await connect({
        roots: await AllowedLocalRoots.create([root]),
        version: '1.0.0',
        apiUrl: 'http://127.0.0.1:1',
        authApiUrl: auth.url,
        env: { ZYNOHOSTING_CONFIG: join(root, 'config.json') }
    });
    try {
        const result = await client.callTool({ name: 'login', arguments: { renewable: false, flow: 'device' } });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /link and code is not available/);
    } finally {
        await close();
        await auth.close();
    }
});

test('a sign-in that finishes after use_login leaves that choice alone, but its status names the tenant it approved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-mcp-login-vs-use-'));
    const file = join(root, 'config.json');
    const hosting = await manager();
    const key = `url:${hosting.url}`;
    const saved = (tenantId: string, name: string) => ({
        tenantId,
        tenantName: name,
        accessToken: `${name.toLowerCase()}.jwt.signature`,
        expiresAt: Date.now() + 3_600_000,
        scopedToken: true as const
    });
    await updateProfile(
        key,
        { apiUrl: hosting.url, logins: { [ACME]: saved(ACME, 'Acme'), [GLOBEX]: saved(GLOBEX, 'Globex') }, activeLogin: ACME },
        file
    );
    const { client, close } = await connect({
        roots: await AllowedLocalRoots.create([root]),
        version: '1.0.0',
        apiUrl: hosting.url,
        env: { ZYNOHOSTING_CONFIG: file, ZYNOHOSTING_LOGIN_URL: 'https://login.example.test/cli/login' },
        loginDependencies: { openUrl: async () => {}, platform: 'darwin' }
    });
    try {
        const started = (await client.callTool({ name: 'login', arguments: { renewable: false, flow: 'browser', timeout_seconds: 20 } }))
            .structuredContent as {
            browserUrl: string;
        };
        const url = new URL(started.browserUrl);
        await client.callTool({ name: 'use_login', arguments: { tenant: GLOBEX } });
        // The sign-in completes for a third tenant, after the user chose Globex.
        const NEW_TENANT = '00000000-0000-0000-0000-0000000000c3';
        const response = await fetch(url.searchParams.get('callback')!, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                jwt: 'initech.jwt.signature',
                tenantId: NEW_TENANT,
                expiresAt: String(Date.now() + 3_600_000),
                state: url.searchParams.get('state')!,
                tenantName: 'Initech',
                accountEmail: 'me@example.com'
            })
        });
        assert.equal(response.status, 200);
        let status: Record<string, unknown> = {};
        for (let attempt = 0; attempt < 100 && status.authenticated !== true; attempt++) {
            status = (await client.callTool({ name: 'login', arguments: { action: 'status' } })).structuredContent as Record<string, unknown>;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(status.tenant, NEW_TENANT);
        assert.equal(status.tenantName, 'Initech');
        assert.equal(status.account, 'me@example.com');
    } finally {
        await close();
        await hosting.close();
    }
});

test('MCP login status reports the permissions a partial approval did not grant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-mcp-partial-'));
    const auth = await startFakeAuth([approvedPoll({}, { permissionKeys: ['hosting.sitesRead'], deniedPermissionKeys: ['hosting.deploy'] })]);
    const { client, close } = await connect({
        roots: await AllowedLocalRoots.create([root]),
        version: '1.0.0',
        apiUrl: 'http://127.0.0.1:1',
        authApiUrl: auth.url,
        env: { ZYNOHOSTING_CONFIG: join(root, 'config.json') }
    });
    try {
        await client.callTool({
            name: 'login',
            arguments: { renewable: false, flow: 'device', permissions: ['hosting.sitesRead', 'hosting.deploy'] }
        });
        let status: Record<string, unknown> = {};
        for (let attempt = 0; attempt < 100 && status.authenticated !== true; attempt++) {
            status = (await client.callTool({ name: 'login', arguments: { action: 'status' } })).structuredContent as Record<string, unknown>;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.deepEqual(status.permissionKeys, ['hosting.sitesRead']);
        assert.deepEqual(status.deniedPermissionKeys, ['hosting.deploy']);
    } finally {
        await close();
        await auth.close();
    }
});

test('the MCP login asks for a renewable login unless told otherwise', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-mcp-renewable-'));
    const auth = await startFakeAuth([{ status: 'pending' }]);
    const { client, close } = await connect({
        roots: await AllowedLocalRoots.create([root]),
        version: '1.0.0',
        apiUrl: 'http://127.0.0.1:1',
        authApiUrl: auth.url,
        env: { ZYNOHOSTING_CONFIG: join(root, 'config.json'), ZYNOHOSTING_CREDENTIAL_STORE: 'file' }
    });
    try {
        await client.callTool({ name: 'login', arguments: { flow: 'device' } });
        assert.equal(auth.requests.find(request => request.path.endsWith('/device/start'))!.body.renewable, true);
        await client.callTool({ name: 'login', arguments: { action: 'cancel' } });
        await client.callTool({ name: 'login', arguments: { flow: 'device', renewable: false } });
        assert.equal(auth.requests.filter(request => request.path.endsWith('/device/start')).at(-1)!.body.renewable, false);
    } finally {
        await close();
        await auth.close();
    }
});
