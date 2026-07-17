import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { ManagerClient } from '../src/api/manager-client.js';

test('uses a Zyno Bearer token and tenant header for user authentication', async () => {
    const server = createServer((request, response) => {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/sites/example.com/access-sessions');
        assert.equal(request.headers.authorization, 'Bearer user-token');
        assert.equal(request.headers['x-zs-tid'], 'tenant-id');
        response.setHeader('Content-Type', 'application/json');
        response.end(
            JSON.stringify({
                protocolVersion: 1,
                site: {
                    id: '11111111-1111-4111-8111-111111111111',
                    fqdn: 'example.com',
                    status: 'active',
                    phpVersion: null
                },
                endpoints: {
                    deploy: 'https://site.example.com/@zh/deploy/v1',
                    files: 'https://site.example.com/@zh/files/v1'
                },
                scopes: ['deploy:inventory', 'deploy:hash', 'deploy:apply'],
                accessToken: 'deployment-token',
                expiresAt: new Date(Date.now() + 60_000).toISOString()
            })
        );
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');

    try {
        const client = new ManagerClient(`http://127.0.0.1:${address.port}`, {
            type: 'bearer',
            accessToken: 'user-token',
            tenantId: 'tenant-id'
        });
        const session = await client.createDeploymentSession('example.com');
        assert.equal(session.accessToken, 'deployment-token');
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
});

test('rejects an access session whose granted scopes do not match the request', async () => {
    const server = createServer(async (request, response) => {
        const body = JSON.parse(await requestText(request)) as { scopes: string[] };
        assert.deepEqual(body.scopes, ['files:read']);
        response.setHeader('Content-Type', 'application/json');
        response.end(
            JSON.stringify({
                protocolVersion: 1,
                site: {
                    id: '11111111-1111-4111-8111-111111111111',
                    fqdn: 'example.com',
                    status: 'active',
                    phpVersion: null
                },
                endpoints: {
                    deploy: 'https://site.example.com/@zh/deploy/v1',
                    files: 'https://site.example.com/@zh/files/v1'
                },
                scopes: ['files:list'],
                accessToken: 'access-token',
                expiresAt: '2026-07-16T12:20:00.000Z'
            })
        );
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    try {
        const client = new ManagerClient(`http://127.0.0.1:${address.port}`, {
            type: 'api-key',
            apiKey: 'secret'
        });
        await assert.rejects(client.createAccessSession('example.com', ['files:read']), /unexpected scopes/);
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
});

async function requestText(request: AsyncIterable<unknown>): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8');
}
