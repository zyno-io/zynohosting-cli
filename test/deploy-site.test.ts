import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';

import { deploySite } from '../src/commands/deploy-site.js';

test('runs the manager-to-agent protocol and streams only planned content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-e2e-'));
    await writeFile(join(root, 'index.html'), 'new-content');
    const requests: string[] = [];
    let uploadedArchive: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    const server = createServer(async (request, response) => {
        requests.push(`${request.method} ${request.url}`);
        try {
            await route(request, response);
        } catch (error) {
            response.statusCode = 500;
            response.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
        await deploySite('example.com', root, {
            apiUrl: baseUrl,
            apiKey: 'secret',
            yes: true,
            json: true
        });
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }

    assert.deepEqual(requests, [
        'POST /v1/sites/example.com/access-sessions',
        'GET /deploy/capabilities',
        'POST /deploy/inventory',
        'POST /deploy/plans/plan-1/hashes',
        'PUT /deploy/plans/plan-1/apply',
        'POST /v1/sites/11111111-1111-4111-8111-111111111111/cache/purge'
    ]);
    assert(gunzipSync(uploadedArchive).includes(Buffer.from('new-content')));

    async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/v1/sites/example.com/access-sessions') {
            assert.equal(request.headers.authorization, `Basic ${Buffer.from('api:secret').toString('base64')}`);
            json(response, {
                protocolVersion: 1,
                site: {
                    id: '11111111-1111-4111-8111-111111111111',
                    fqdn: 'example.com',
                    status: 'active',
                    phpVersion: null
                },
                endpoints: {
                    deploy: `${baseUrl}/deploy`,
                    files: `${baseUrl}/files`
                },
                scopes: ['deploy:inventory', 'deploy:hash', 'deploy:apply'],
                accessToken: 'deploy-token',
                expiresAt: future()
            });
            return;
        }
        if (request.url === '/v1/sites/11111111-1111-4111-8111-111111111111/cache/purge') {
            assert.equal(request.headers.authorization, `Basic ${Buffer.from('api:secret').toString('base64')}`);
            json(response, { status: 'pending' });
            return;
        }
        assert.equal(request.headers.authorization, 'Bearer deploy-token');
        if (request.url === '/deploy/capabilities') {
            json(response, {
                protocolVersion: 1,
                hashAlgorithms: ['xxh3-128', 'sha256'],
                ignoreRulesetId: 'v1',
                mandatoryIgnores: ['.git/', '.zynohostingignore'],
                limits: { maxFiles: 100, maxPathBytes: 1024, maxFileBytes: 1024, maxUploadBytes: 1024 }
            });
            return;
        }
        if (request.url === '/deploy/inventory') {
            const inventory = JSON.parse(gunzipSync(await body(request)).toString('utf8')) as {
                files: Array<{ path: string; size: number }>;
            };
            assert.deepEqual(inventory.files, [{ path: 'index.html', size: 11 }]);
            json(response, {
                planId: 'plan-1',
                expiresAt: future(),
                hashAlgorithm: 'xxh3-128',
                hashCandidateIndices: [0],
                preliminaryOperations: []
            });
            return;
        }
        if (request.url === '/deploy/plans/plan-1/hashes') {
            const submission = JSON.parse((await body(request)).toString('utf8')) as {
                hashes: unknown[];
            };
            assert.equal(submission.hashes.length, 1);
            json(response, {
                planId: 'plan-1',
                expiresAt: future(),
                operations: [{ kind: 'replace', path: 'index.html', size: 11, previousSize: 11 }],
                uploadIndices: [0]
            });
            return;
        }
        if (request.url === '/deploy/plans/plan-1/apply') {
            assert.equal(request.headers['x-zh-deploy-protocol'], '1');
            assert.equal(request.headers['x-zyno-deploy-protocol'], '1');
            uploadedArchive = await body(request);
            json(response, {
                ok: true,
                planId: 'plan-1',
                created: 0,
                replaced: 1,
                deleted: 0,
                uploadedBytes: 11,
                durationMs: 10
            });
            return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ message: 'not found' }));
    }
});

function json(response: ServerResponse, value: unknown): void {
    response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
}

function future(): string {
    return new Date(Date.now() + 60_000).toISOString();
}
