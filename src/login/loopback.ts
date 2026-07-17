import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';

import { CliError } from '../errors.js';

const CALLBACK_PATH = '/callback';
const MAX_BODY_BYTES = 16 * 1024;
const TOKEN_MAX_LENGTH = 12 * 1024;
const TENANT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export interface UserCredential {
    accessToken: string;
    tenantId: string;
    expiresAt: number;
}

export interface LoopbackLogin {
    callbackUrl: string;
    state: string;
    result: Promise<UserCredential>;
    close(): Promise<void>;
}

export async function startLoopbackLogin(options: { timeoutMs: number }): Promise<LoopbackLogin> {
    const state = randomBytes(32).toString('base64url');
    let resolveResult!: (credential: UserCredential) => void;
    let rejectResult!: (error: Error) => void;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const result = new Promise<UserCredential>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });

    const server = createServer((request, response) => {
        void handleCallback(request, response, state)
            .then(outcome => {
                if (!outcome || settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (outcome instanceof Error) rejectResult(outcome);
                else resolveResult(outcome);
                void closeServer(server);
            })
            .catch(() => rejectRequest(response, 500, 'Login callback failed'));
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 10_000;
    server.keepAliveTimeout = 1_000;
    server.maxRequestsPerSocket = 2;
    server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));

    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
        await closeServer(server);
        throw new CliError('Could not determine the local login listener address', 1, 'login_listener_failed');
    }
    const callbackUrl = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
    timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectResult(new CliError('Timed out waiting for browser login', 3, 'login_timeout'));
        void closeServer(server, true);
    }, options.timeoutMs);

    return {
        callbackUrl,
        state,
        result,
        async close() {
            if (timer) clearTimeout(timer);
            if (!settled) {
                settled = true;
                rejectResult(new CliError('Browser login was cancelled', 3, 'login_cancelled'));
            }
            await closeServer(server, true);
        }
    };
}

async function handleCallback(
    request: IncomingMessage,
    response: ServerResponse,
    expectedState: string
): Promise<UserCredential | Error | undefined> {
    setResponseSecurityHeaders(response);
    if (request.socket.remoteAddress !== '127.0.0.1') {
        return rejectRequest(response, 403, 'Loopback connections only');
    }
    if (request.method !== 'POST' || request.url !== CALLBACK_PATH) {
        response.setHeader('Allow', 'POST');
        return rejectRequest(response, 405, 'POST required');
    }
    if (request.headers.host !== `127.0.0.1:${request.socket.localPort}`) {
        return rejectRequest(response, 400, 'Invalid callback host');
    }
    if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
        return rejectRequest(response, 415, 'Form-encoded body required');
    }

    let form: URLSearchParams;
    try {
        form = new URLSearchParams(await readBody(request));
    } catch (error) {
        const tooLarge = error instanceof CliError && error.code === 'callback_too_large';
        return rejectRequest(response, tooLarge ? 413 : 400, tooLarge ? 'Callback body is too large' : 'Could not read callback body');
    }
    if (!safeEqual(form.get('state') ?? '', expectedState)) {
        return rejectRequest(response, 400, 'Invalid login state');
    }
    const loginError = form.get('error');
    if (loginError) {
        successResponse(response, 'Zyno login was not completed. You can close this window.');
        return new CliError(`Zyno login failed: ${loginError.slice(0, 500)}`, 3, 'login_failed');
    }

    const accessToken = form.get('jwt') ?? '';
    const tenantId = form.get('tenantId') ?? '';
    const expiresAt = Number(form.get('expiresAt'));
    if (!isJwt(accessToken)) return rejectRequest(response, 400, 'Invalid access token');
    if (!TENANT_ID_PATTERN.test(tenantId)) return rejectRequest(response, 400, 'Invalid tenant ID');
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return rejectRequest(response, 400, 'Invalid token expiration');

    successResponse(response, 'ZynoHosting login complete. You can close this window.');
    return { accessToken, tenantId, expiresAt };
}

async function readBody(request: IncomingMessage): Promise<string> {
    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
        request.resume();
        throw new CliError('Callback body is too large', 3, 'callback_too_large');
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
        const bytes = Buffer.from(chunk as Buffer);
        length += bytes.length;
        if (length > MAX_BODY_BYTES) throw new CliError('Callback body is too large', 3, 'callback_too_large');
        chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function isJwt(value: string): boolean {
    if (!value || value.length > TOKEN_MAX_LENGTH) return false;
    const parts = value.split('.');
    return parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part));
}

function safeEqual(actual: string, expected: string): boolean {
    const actualHash = createHash('sha256').update(actual).digest();
    const expectedHash = createHash('sha256').update(expected).digest();
    return timingSafeEqual(actualHash, expectedHash);
}

function rejectRequest(response: ServerResponse, status: number, message: string): undefined {
    response.statusCode = status;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end(`${message}\n`);
    return undefined;
}

function successResponse(response: ServerResponse, message: string): void {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ZynoHosting CLI</title><p>${message}</p><script>window.close()</script>`
    );
}

function setResponseSecurityHeaders(response: ServerResponse): void {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
}

async function listen(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', onError);
            resolve();
        });
    });
}

async function closeServer(server: Server, force = false): Promise<void> {
    if (!server.listening) {
        if (force) server.closeAllConnections();
        return;
    }
    await new Promise<void>(resolve => {
        server.close(() => resolve());
        if (force) server.closeAllConnections();
    });
}
