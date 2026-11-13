import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { ScopedTokenClient } from '../src/api/scoped-token-client.js';

test('rotates a renewal credential and self-revokes with the scoped Bearer token', async () => {
    const seen: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const server = createServer(async (request, response) => {
        const text = await requestText(request);
        seen.push({
            url: request.url ?? '',
            authorization: request.headers.authorization,
            body: text ? JSON.parse(text) : undefined
        });
        response.setHeader('Content-Type', 'application/json');
        if (request.url?.endsWith('/renew')) {
            response.end(JSON.stringify({ jwt: 'new.jwt.signature', expiresAt, renewalToken: 'zrt_replacement' }));
        } else {
            response.end('null');
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const client = new ScopedTokenClient(`http://127.0.0.1:${address.port}`);

    try {
        assert.deepEqual(await client.renew('zrt_current'), {
            jwt: 'new.jwt.signature',
            expiresAt,
            renewalToken: 'zrt_replacement'
        });
        await client.revoke('new.jwt.signature');
        assert.deepEqual(seen, [
            {
                url: '/identity/scoped-tokens/renew',
                authorization: undefined,
                body: { renewalToken: 'zrt_current' }
            },
            {
                url: '/identity/scoped-tokens/revoke',
                authorization: 'Bearer new.jwt.signature',
                body: undefined
            }
        ]);
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
});

test('rejects malformed or implausibly long-lived renewal responses', async () => {
    const server = createServer((_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ jwt: 'new.jwt.signature', expiresAt: Date.now() + 24 * 60 * 60 * 1000, renewalToken: 'zrt_replacement' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    try {
        await assert.rejects(new ScopedTokenClient(`http://127.0.0.1:${address.port}`).renew('zrt_current'), /invalid renewal response/i);
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
});

test('renewal accepts the tenant, account and grant end that newer servers add, and ignores malformed ones', async () => {
    const grantEnd = new Date(Date.now() + 86_400_000).toISOString();
    const bodies = [
        { tenantName: 'Acme Co', accountEmail: 'owner@example.com', grantExpiresAt: grantEnd },
        { tenantName: 42, accountEmail: null, grantExpiresAt: 'not a date' }
    ];
    let call = 0;
    const server = createServer((_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(
            JSON.stringify({ jwt: 'new.jwt.signature', expiresAt: Date.now() + 3_600_000, renewalToken: 'zrt_replacement', ...bodies[call++] })
        );
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    try {
        const client = new ScopedTokenClient(`http://127.0.0.1:${address.port}`);
        const first = await client.renew('zrt_current');
        assert.equal(first.tenantName, 'Acme Co');
        assert.equal(first.accountEmail, 'owner@example.com');
        assert.equal(first.grantExpiresAt, Date.parse(grantEnd));
        const second = await client.renew('zrt_current');
        assert.equal(second.tenantName, undefined);
        assert.equal(second.accountEmail, undefined);
        assert.equal(second.grantExpiresAt, undefined);
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
});

async function requestText(request: AsyncIterable<unknown>): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8');
}
