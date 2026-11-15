import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export const SITE_ID = '11111111-1111-4111-8111-111111111111';
export const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
export const KEY_ID = '99999999-9999-4999-8999-999999999999';
/** A well-formed deploy token. It must never appear in any output. */
export const SECRET = `zck_${'A1b2C3d4'.repeat(5)}abc`;
export const REQUEST_CODE = `zkr_${'Q9w8E7r6'.repeat(5)}abc`;
export const USER_CODE = 'ABCD-EFGH';
export const HUMAN_JWT = 'human.jwt.signature';

export type Script = Record<string, unknown> | 'drop' | { httpStatus: number; body?: unknown };

export interface Seen {
    method: string;
    url: string;
    authorization: string | undefined;
    body: Record<string, unknown>;
}

export interface FakeKeyServer {
    url: string;
    seen: Seen[];
    state: {
        polls: Script[];
        /** Environments the deploy token whoami reports. */
        tokenEnvironments: string[];
        tokenExpiresAt: string;
        self: { httpStatus: number; body?: unknown };
        selfRevokeStatus: number;
        phpVersion: string | null;
        notFoundHandling: string;
        keys: unknown[];
        siteStatus: number;
        whoamiStatus: number;
        /** `default` of GET /v1/php-versions; null when no PHP version is deployed. */
        phpDefault: string | null;
    };
    count(method: string, path: string): number;
    close(): Promise<void>;
}

/** KeyInfo as ZynoAuth returns it. */
export function keyInfo(environments: string[] = ['production']): Record<string, unknown> {
    return {
        id: KEY_ID,
        tenantId: '22222222-2222-4222-8222-222222222222',
        description: 'CI',
        keyPreview: 'zck_A1b2...abc',
        capabilities: { hosting: { v: 1, siteId: SITE_ID, environments, siteOwnershipRevision: 3 } },
        display: { hosting: { resourceLabel: 'example.com', facts: [] } },
        handoff: null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString()
    };
}

/** Poll delivery, approved: the secret is returned once. */
export function approvedPoll(extra: Record<string, unknown> = {}): Script {
    return { status: 'approved', delivery: 'poll', secret: SECRET, key: keyInfo(), ...extra };
}

/** Display delivery, approved: no secret. */
export function displayApprovedPoll(extra: Record<string, unknown> = {}): Script {
    return { status: 'approved', delivery: 'display', key: keyInfo(), ...extra };
}

/** One server that plays the hosting API and ZynoAuth, enough for deploy tokens. */
export async function startFakeKeyServer(): Promise<FakeKeyServer> {
    const seen: Seen[] = [];
    let pollIndex = 0;
    let baseUrl = '';
    const state: FakeKeyServer['state'] = {
        polls: [{ status: 'pending', interval: 0.02 }, approvedPoll()],
        tokenEnvironments: ['production'],
        tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        self: { httpStatus: 200, body: { id: KEY_ID, expiresAt: new Date(Date.now() + 86_400_000).toISOString() } },
        selfRevokeStatus: 200,
        phpVersion: null,
        notFoundHandling: '404-page',
        keys: [],
        siteStatus: 200,
        whoamiStatus: 200,
        phpDefault: '8.4'
    };
    const site = () => ({
        id: SITE_ID,
        primaryHostnameId: '44444444-4444-4444-8444-444444444444',
        primaryHostname: 'example.com',
        status: 'active',
        phpVersion: state.phpVersion,
        notFoundHandling: state.notFoundHandling,
        hostnames: [
            { id: '44444444-4444-4444-8444-444444444444', name: 'example.com', kind: 'custom', isPrimary: true, subdomainDirectory: null },
            { id: '55555555-5555-4555-8555-555555555555', name: 'www.example.com', kind: 'custom', isPrimary: false, subdomainDirectory: null }
        ]
    });
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        const url = request.url ?? '';
        const method = request.method ?? 'GET';
        seen.push({ method, url, authorization: request.headers.authorization, body });
        response.setHeader('Content-Type', 'application/json');
        const send = (value: unknown, status = 200) => {
            response.statusCode = status;
            response.end(JSON.stringify(value));
        };
        const path = url.split('?')[0]!;
        if (method === 'GET' && (path === '/v1/sites/example.com' || path === `/v1/sites/${SITE_ID}`)) return send(site(), state.siteStatus);
        if (method === 'GET' && path === '/v1/deploy-token') {
            if (state.whoamiStatus !== 200) return send({ error: 'unauthorized' }, state.whoamiStatus);
            return send({ keyId: KEY_ID, siteId: SITE_ID, environments: state.tokenEnvironments, expiresAt: state.tokenExpiresAt, site: site() });
        }
        if (method === 'GET' && path === '/v1/php-versions') return send({ versions: ['8.2', '8.3', '8.4'], default: state.phpDefault });
        if (method === 'PATCH' && path === `/v1/sites/${SITE_ID}`) {
            if ('phpVersion' in body) state.phpVersion = body.phpVersion as string | null;
            if (typeof body.notFoundHandling === 'string') state.notFoundHandling = body.notFoundHandling;
            return send({
                result: site(),
                operation: { id: OPERATION_ID, status: 'queued', statusUrl: `/reconciliations/${OPERATION_ID}`, lastError: null }
            });
        }
        if (method === 'GET' && path === `/reconciliations/${OPERATION_ID}`) {
            return send({ id: OPERATION_ID, status: 'succeeded', statusUrl: `/reconciliations/${OPERATION_ID}`, lastError: null });
        }
        if (method === 'POST' && path === '/identity/key-requests') {
            return send({
                requestCode: REQUEST_CODE,
                userCode: USER_CODE,
                verificationUri: `${baseUrl}/keys/approve`,
                verificationUriComplete: `${baseUrl}/keys/approve?code=${USER_CODE}`,
                interval: 0.02,
                expiresIn: 600,
                expiresAt: Date.now() + 600_000
            });
        }
        if (method === 'POST' && path === '/identity/key-requests/poll') {
            const script = state.polls[Math.min(pollIndex++, state.polls.length - 1)]!;
            if (script === 'drop') {
                request.socket.destroy();
                return;
            }
            if ('httpStatus' in script)
                return send((script as { body?: unknown }).body ?? { error: 'error' }, (script as { httpStatus: number }).httpStatus);
            // For display delivery a real server omits the secret; a test can script one that leaks it, which the client must drop.
            // A real server always states the interval with pending and slow_down.
            if ((script.status === 'pending' || script.status === 'slow_down') && script.interval === undefined)
                return send({ ...script, interval: 0.02 });
            return send(script);
        }
        if (method === 'POST' && path === '/identity/key-requests/cancel') return send(null);
        if (method === 'GET' && path === '/identity/tenant-keys/self') return send(state.self.body ?? {}, state.self.httpStatus);
        if (method === 'POST' && path === '/identity/tenant-keys/self-revoke') return send({ revoked: true }, state.selfRevokeStatus);
        if (method === 'GET' && path === '/tenant/capability-keys') return send(state.keys);
        if (method === 'DELETE' && path.startsWith('/tenant/capability-keys/')) return send(null);
        send({ error: 'not found' }, 404);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;
    return {
        url: baseUrl,
        seen,
        state,
        count: (method: string, path: string) => seen.filter(entry => entry.method === method && entry.url.split('?')[0] === path).length,
        close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    };
}
