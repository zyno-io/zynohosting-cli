import type { IncomingMessage } from 'node:http';

import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export const DEVICE_CODE = `zdc_${'A1b2C3d4'.repeat(5)}abc`;
export const USER_CODE = 'ABCD-EFGH';
export const TENANT_ID = '00000000-0000-0000-0000-000000000024';
export const JWT = 'header.payload.signature';
export const RENEWAL_TOKEN = 'zrt_first-secret-token';

export type PollScript = Record<string, unknown> | 'drop' | { status: number; body?: unknown };

export interface RecordedRequest {
    path: string;
    body: Record<string, unknown>;
    at: number;
}

export interface FakeAuth {
    url: string;
    requests: RecordedRequest[];
    /** Responses for successive polls; the last one repeats. */
    polls: PollScript[];
    /** Overrides the start response status (404 or 503 for a server with the feature off). */
    startStatus?: number;
    startOverrides: Record<string, unknown>;
    close(): Promise<void>;
    count(path: string): number;
}

export function approvedPoll(extra: Record<string, unknown> = {}, credential: Record<string, unknown> = {}): PollScript {
    return {
        status: 'approved',
        approvedBy: { email: 'owner@example.com', tenantName: 'Acme Co' },
        credential: {
            jwt: JWT,
            tenantId: TENANT_ID,
            expiresAt: Date.now() + 60 * 60 * 1000,
            grantExpiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
            tenantName: 'Acme Co',
            accountEmail: 'owner@example.com',
            ...credential
        },
        ...extra
    };
}

export async function startFakeAuth(polls: PollScript[]): Promise<FakeAuth> {
    const requests: RecordedRequest[] = [];
    let pollIndex = 0;
    const state: FakeAuth = {
        url: '',
        requests,
        polls,
        startOverrides: {},
        count: path => requests.filter(request => request.path === path).length,
        close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    };
    const server = createServer(async (request, response) => {
        const text = await bodyText(request);
        const path = request.url ?? '';
        requests.push({ path, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, at: Date.now() });
        response.setHeader('Content-Type', 'application/json');
        if (path.endsWith('/device/start')) {
            if (state.startStatus) {
                response.statusCode = state.startStatus;
                response.end(JSON.stringify({ message: 'unavailable' }));
                return;
            }
            const base = state.url;
            response.end(
                JSON.stringify({
                    deviceCode: DEVICE_CODE,
                    userCode: USER_CODE,
                    verificationUri: `${base}/cli/device`,
                    verificationUriComplete: `${base}/cli/device?code=${USER_CODE}`,
                    interval: 0.02,
                    expiresIn: 600,
                    expiresAt: Date.now() + 600_000,
                    ...state.startOverrides
                })
            );
            return;
        }
        if (path.endsWith('/device/poll')) {
            const script = state.polls[Math.min(pollIndex++, state.polls.length - 1)]!;
            if (script === 'drop') {
                request.socket.destroy();
                return;
            }
            if ('status' in script && typeof script.status === 'number') {
                response.statusCode = script.status;
                response.end(JSON.stringify((script as { body?: unknown }).body ?? { message: 'error' }));
                return;
            }
            response.end(JSON.stringify(script));
            return;
        }
        response.end('null');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    state.url = `http://127.0.0.1:${address.port}`;
    return state;
}

async function bodyText(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8');
}
