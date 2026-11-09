import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';

export const siteId = '11111111-1111-4111-8111-111111111111';
export const releaseId = '22222222-2222-4222-8222-222222222222';
export const operationId = '33333333-3333-4333-8333-333333333333';

export async function previewManager(t: { after(fn: () => unknown): void }) {
    const state = {
        productionId: null as string | null,
        productionContent: 'live',
        previewContent: 'preview-v1',
        promotions: 0,
        polls: 0,
        failReconciliation: false,
        productionHasWpConfig: false,
        previewHasWpConfig: false,
        omitTarget: false,
        grantedTarget: undefined as 'production' | 'preview' | undefined
    };
    const requests: string[] = [];
    const bodies: unknown[] = [];
    const manifests = new Map<string, Array<{ path: string; size: number }>>();
    const site = () => ({
        id: siteId,
        primaryHostname: 'example.com',
        status: 'active',
        phpVersion: null,
        deployments: {
            production: {
                deploymentId: state.productionId,
                url: 'https://example.com',
                directory: '/public_html'
            },
            preview: {
                url: 'https://example-com-preview.aspen.zynohosting.net',
                directory: '/preview_html',
                sharesDatabase: true,
                sharesStorageQuota: true
            }
        }
    });
    const operation = (status = 'queued') => ({
        id: operationId,
        status,
        statusUrl: `/reconciliations/${operationId}`,
        lastError: status === 'failed' ? 'origin validation failed' : null
    });
    const server = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        requests.push(`${request.method} ${request.url}`);
        const json = (value: unknown) => response.end(JSON.stringify(value));
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
        const bytes = Buffer.concat(chunks);
        try {
            if (request.method === 'GET' && (request.url === '/v1/sites/example.com' || request.url === `/v1/sites/${siteId}`)) {
                json(site());
                return;
            }
            if (request.url?.endsWith('/access-sessions')) {
                const body = JSON.parse(bytes.toString()) as { scopes: string[]; target?: string };
                bodies.push(body);
                const target = state.grantedTarget ?? body.target ?? 'production';
                json({
                    protocolVersion: 1,
                    site: site(),
                    ...(state.omitTarget ? {} : { target }),
                    endpoints: { deploy: `${baseUrl}/deploy`, files: `${baseUrl}/files` },
                    scopes: body.scopes,
                    accessToken: `${target}-token`,
                    expiresAt: new Date(Date.now() + 60_000).toISOString()
                });
                return;
            }
            if (request.url === `/v1/sites/${siteId}/promote`) {
                const body = JSON.parse(bytes.toString()) as { expectedProductionDeploymentId: string | null; force?: boolean };
                bodies.push(body);
                if (body.expectedProductionDeploymentId !== state.productionId) {
                    response.statusCode = 409;
                    json({ message: 'production changed since promotion was planned' });
                    return;
                }
                if (state.productionHasWpConfig && !state.previewHasWpConfig && body.force !== true) {
                    response.statusCode = 409;
                    json({ message: 'production contains wp-config.php but preview does not; add it to preview or explicitly force promotion' });
                    return;
                }
                state.promotions++;
                state.productionId = releaseId;
                state.productionContent = state.previewContent;
                state.previewContent = '';
                json({ result: site(), operation: operation() });
                return;
            }
            if (request.url === `/reconciliations/${operationId}`) {
                state.polls++;
                json(operation(state.failReconciliation ? 'failed' : 'succeeded'));
                return;
            }
            if (request.url === `/v1/sites/${siteId}/cache/purge`) {
                json({ status: 'pending' });
                return;
            }
            const target = request.headers.authorization === 'Bearer preview-token' ? 'preview' : 'production';
            assert.equal(request.headers.authorization, `Bearer ${target}-token`);
            if (request.url === '/deploy/capabilities') {
                json({
                    protocolVersion: 1,
                    hashAlgorithms: ['sha256'],
                    ignoreRulesetId: 'v3',
                    mandatoryIgnores: [],
                    limits: { maxFiles: 100, maxPathBytes: 1024, maxFileBytes: 1024 * 1024, maxUploadBytes: 1024 * 1024 }
                });
                return;
            }
            if (request.url === '/deploy/inventory') {
                const body = JSON.parse(gunzipSync(bytes).toString()) as { files: Array<{ path: string; size: number }> };
                manifests.set(target, body.files);
                json({
                    planId: `${target}-plan`,
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    hashAlgorithm: 'sha256',
                    hashCandidateIndices: [],
                    preliminaryOperations: body.files.map(file => ({ kind: 'create', ...file }))
                });
                return;
            }
            if (request.url === `/deploy/plans/${target}-plan/hashes`) {
                const files = manifests.get(target)!;
                json({
                    planId: `${target}-plan`,
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    operations: files.map(file => ({ kind: 'create', ...file })),
                    uploadIndices: files.map((_, i) => i)
                });
                return;
            }
            if (request.url === `/deploy/plans/${target}-plan/apply`) {
                const archive = gunzipSync(bytes);
                assert(archive.includes(Buffer.from('new-preview')));
                if (target === 'preview') state.previewContent = 'new-preview';
                else state.productionContent = 'new-preview';
                json({ ok: true, planId: `${target}-plan`, created: 1, replaced: 0, deleted: 0, uploadedBytes: 11, durationMs: 1 });
                return;
            }
            response.statusCode = 404;
            json({ message: 'not found' });
        } catch (error) {
            response.statusCode = 500;
            json({ message: String(error) });
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))));
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return { baseUrl, state, requests, bodies, site };
}
