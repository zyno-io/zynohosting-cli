import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';

import { AllowedLocalRoots } from '../src/mcp/local-paths.js';
import { createHostingMcpServer } from '../src/mcp/server.js';

test('serves site metadata and downloads files only inside allowed roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-mcp-'));
    const snapshot = await siteArchive('snapshot');
    let remoteContent = 'hello';
    let purgeCount = 0;
    const httpServer = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/v1/sites') {
            response.end(
                JSON.stringify([
                    {
                        id: '11111111-1111-4111-8111-111111111111',
                        fqdn: 'example.com',
                        status: 'active',
                        phpVersion: null
                    }
                ])
            );
            return;
        }
        if (request.url === '/v1/sites/example.com/access-sessions') {
            const body = JSON.parse(await requestText(request)) as { scopes: string[] };
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
                        deploy: `http://127.0.0.1:${address().port}/deploy`,
                        files: `http://127.0.0.1:${address().port}/files`
                    },
                    scopes: body.scopes,
                    accessToken: 'file-token',
                    expiresAt: new Date(Date.now() + 60_000).toISOString()
                })
            );
            return;
        }
        if (request.url === '/files/content?path=index.html' && request.method === 'GET') {
            assert.equal(request.headers.authorization, 'Bearer file-token');
            response.setHeader('Content-Type', 'application/octet-stream');
            response.setHeader('Content-Length', String(Buffer.byteLength(remoteContent)));
            response.end(remoteContent);
            return;
        }
        if (request.url === '/files/content?path=index.html' && request.method === 'PUT') {
            remoteContent = await requestText(request);
            response.end(
                JSON.stringify({
                    created: false,
                    entry: {
                        path: 'index.html',
                        type: 'file',
                        size: Buffer.byteLength(remoteContent),
                        modifiedAt: '2026-07-16T12:00:00.000Z',
                        etag: '"updated"'
                    }
                })
            );
            return;
        }
        if (request.url === '/files/content?path=index.html' && request.method === 'DELETE') {
            remoteContent = '';
            response.end(JSON.stringify({ deleted: true, path: 'index.html' }));
            return;
        }
        if (request.url === '/files/archives' && request.method === 'POST') {
            assert.equal(request.headers.connection, 'TE');
            assert.equal(request.headers.te, 'trailers');
            const body = JSON.parse(await requestText(request)) as { scope: string };
            response.setHeader('Content-Type', 'application/gzip');
            response.setHeader('Trailer', 'X-ZH-Archive-Status, X-ZH-Archive-Error-Code');
            response.setHeader('X-ZH-Archive-Protocol', 'stream-v1');
            response.setHeader('X-ZH-Archive-Scope', body.scope);
            response.setHeader('X-ZH-Archive-Entries', '1');
            response.setHeader('X-ZH-Archive-Skipped-Entries', '0');
            response.write(snapshot);
            response.addTrailers({ 'X-ZH-Archive-Status': 'complete' });
            response.end();
            return;
        }
        if (request.url === '/deploy/capabilities' && request.method === 'GET') {
            response.end(
                JSON.stringify({
                    protocolVersion: 1,
                    hashAlgorithms: ['sha256'],
                    ignoreRulesetId: 'v3',
                    mandatoryIgnores: [],
                    limits: {
                        maxFiles: 100,
                        maxPathBytes: 1024,
                        maxFileBytes: 1024 * 1024,
                        maxUploadBytes: 1024 * 1024
                    }
                })
            );
            return;
        }
        if (request.url === '/deploy/inventory' && request.method === 'POST') {
            await requestText(request);
            response.end(
                JSON.stringify({
                    planId: 'mcp-plan',
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    hashAlgorithm: 'sha256',
                    hashCandidateIndices: [],
                    preliminaryOperations: [{ kind: 'create', path: 'app.html', size: 8 }]
                })
            );
            return;
        }
        if (request.url === '/deploy/plans/mcp-plan/hashes' && request.method === 'POST') {
            await requestText(request);
            response.end(
                JSON.stringify({
                    planId: 'mcp-plan',
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    operations: [{ kind: 'create', path: 'app.html', size: 8 }],
                    uploadIndices: [0]
                })
            );
            return;
        }
        if (request.url === '/deploy/plans/mcp-plan/apply' && request.method === 'PUT') {
            await requestText(request);
            response.end(
                JSON.stringify({
                    ok: true,
                    planId: 'mcp-plan',
                    created: 1,
                    replaced: 0,
                    deleted: 0,
                    uploadedBytes: 8,
                    durationMs: 1
                })
            );
            return;
        }
        if (request.url === '/v1/sites/11111111-1111-4111-8111-111111111111/cache/purge' && request.method === 'POST') {
            purgeCount++;
            response.end(JSON.stringify({ status: 'pending' }));
            return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ message: 'not found' }));
    });
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const address = () => {
        const value = httpServer.address();
        assert(value && typeof value === 'object');
        return value;
    };
    const hosting = await createHostingMcpServer({
        roots: await AllowedLocalRoots.create([root]),
        version: '0.2.0',
        apiUrl: `http://127.0.0.1:${address().port}`,
        apiKey: 'secret'
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await hosting.connect(serverTransport);
    await client.connect(clientTransport);
    try {
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
            'apply_deploy',
            'apply_download',
            'create_basic_form',
            'delete_file',
            'get_file',
            'get_form_integration',
            'get_site',
            'list_files',
            'list_forms',
            'list_sites',
            'plan_deploy',
            'plan_download',
            'put_file',
            'update_form_origins'
        ]);
        const sites = await client.callTool({ name: 'list_sites', arguments: {} });
        assert.match(JSON.stringify(sites.structuredContent), /example\.com/);
        const target = join(root, 'index.html');
        const downloaded = await client.callTool({
            name: 'get_file',
            arguments: { site: 'example.com', remote_path: 'index.html', local_path: target }
        });
        assert.equal(downloaded.isError, undefined);
        assert.equal(await readFile(target, 'utf8'), 'hello');

        const upload = join(root, 'upload.html');
        await writeFile(upload, 'updated');
        const uploaded = await client.callTool({
            name: 'put_file',
            arguments: { site: 'example.com', local_path: upload, remote_path: 'index.html' }
        });
        assert.equal(uploaded.isError, undefined);
        assert.equal(remoteContent, 'updated');

        const deleted = await client.callTool({
            name: 'delete_file',
            arguments: { site: 'example.com', remote_path: 'index.html', etag: '"updated"' }
        });
        assert.equal(deleted.isError, undefined);
        assert.equal(remoteContent, '');
        assert.equal(purgeCount, 2);

        const downloadTarget = join(root, 'snapshot');
        const plannedDownload = await client.callTool({
            name: 'plan_download',
            arguments: {
                site: 'example.com',
                local_root: downloadTarget,
                include_sensitive: false
            }
        });
        assert.equal(plannedDownload.isError, undefined);
        const planId = (plannedDownload.structuredContent as { planId: string }).planId;
        const appliedDownload = await client.callTool({
            name: 'apply_download',
            arguments: { plan_id: planId }
        });
        assert.equal(appliedDownload.isError, undefined);
        assert.equal(await readFile(join(downloadTarget, 'index.html'), 'utf8'), 'snapshot');

        const deploySource = join(root, 'deploy-source');
        await mkdir(deploySource);
        await writeFile(join(deploySource, 'app.html'), 'deployed');
        const plannedDeploy = await client.callTool({
            name: 'plan_deploy',
            arguments: {
                site: 'example.com',
                local_root: deploySource,
                ignore: [],
                allow_empty: false
            }
        });
        assert.equal(plannedDeploy.isError, undefined);
        assert.equal((plannedDeploy.structuredContent as { planId: string }).planId, 'mcp-plan');
        const appliedDeploy = await client.callTool({
            name: 'apply_deploy',
            arguments: { plan_id: 'mcp-plan' }
        });
        assert.equal(appliedDeploy.isError, undefined);
        assert.equal((appliedDeploy.structuredContent as { created: number }).created, 1);
        assert.equal(purgeCount, 3);

        const escaped = await client.callTool({
            name: 'get_file',
            arguments: {
                site: 'example.com',
                remote_path: 'index.html',
                local_path: join(tmpdir(), 'outside-zynohosting-mcp.txt')
            }
        });
        assert.equal(escaped.isError, true);
        assert.match(JSON.stringify(escaped.content), /outside the configured MCP roots/);
    } finally {
        await client.close();
        await hosting.close();
        await new Promise<void>((resolve, reject) => httpServer.close(error => (error ? reject(error) : resolve())));
    }
});

async function requestText(request: AsyncIterable<unknown>): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8');
}

async function siteArchive(content: string): Promise<Buffer> {
    const pack = tar.pack();
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    const complete = (async () => {
        for await (const chunk of Readable.from(pack).pipe(gzip)) chunks.push(Buffer.from(chunk as Buffer));
    })();
    await new Promise<void>((resolve, reject) => {
        pack.entry({ name: 'index.html', type: 'file', size: Buffer.byteLength(content) }, content, error => (error ? reject(error) : resolve()));
    });
    pack.finalize();
    await complete;
    return Buffer.concat(chunks);
}

test('rejects local destinations that escape through a symbolic link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-mcp-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'zynohosting-mcp-outside-'));
    await mkdir(join(outside, 'destination'));
    await symlink(outside, join(root, 'link'));
    const allowed = await AllowedLocalRoots.create([root]);
    await assert.rejects(allowed.destination(join(root, 'link', 'destination', 'file.txt')), /outside the configured MCP roots/);
});
