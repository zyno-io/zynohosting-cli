import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';

import { CliError } from '../errors.js';
import { renderCallbackPage } from './callback-page.js';

const CALLBACK_PATH = '/callback';
const MAX_BODY_BYTES = 16 * 1024;
const TOKEN_MAX_LENGTH = 12 * 1024;
const RENEWAL_TOKEN_MAX_LENGTH = 16 * 1024;
const MAX_ACCESS_LIFETIME_MS = 2 * 60 * 60 * 1000;
// The server caps a grant at 30 days; a day of slack covers clock differences.
const MAX_GRANT_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000;
const TENANT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CANCELLATION_ERRORS = new Set(['access_denied', 'cancelled', 'canceled', 'user_cancelled', 'user_canceled']);

export interface UserCredential {
    accessToken: string;
    tenantId: string;
    expiresAt: number;
    renewalToken?: string;
    tenantName?: string;
    accountEmail?: string;
    /** Epoch milliseconds; the end of the lifetime the approver chose. */
    grantExpiresAt?: number;
}

export interface LoopbackLogin {
    callbackUrl: string;
    state: string;
    result: Promise<UserCredential>;
    close(): Promise<void>;
}

export async function startLoopbackLogin(options: {
    timeoutMs: number;
    renewable?: boolean;
    onCredential?: (credential: UserCredential) => Promise<void>;
}): Promise<LoopbackLogin> {
    const state = randomBytes(32).toString('base64url');
    let resolveResult!: (credential: UserCredential) => void;
    let rejectResult!: (error: Error) => void;
    let settled = false;
    let processing = false;
    let timer: NodeJS.Timeout | undefined;
    const result = new Promise<UserCredential>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    // Browser launch/storage may still be in progress when the listener rejects; keep Node from
    // treating that short gap before the caller awaits `result` as an unhandled rejection.
    void result.catch(() => {});

    const server = createServer((request, response) => {
        void handleCallback(request, response, state, options.renewable ?? false, options.onCredential, () => {
            if (processing || settled) return false;
            processing = true;
            if (timer) clearTimeout(timer);
            return true;
        })
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
    expectedState: string,
    renewable: boolean,
    onCredential: ((credential: UserCredential) => Promise<void>) | undefined,
    acceptCallback: () => boolean
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
    if (!hasSingleValue(form, 'state') || !safeEqual(form.get('state') ?? '', expectedState)) {
        return rejectRequest(response, 400, 'Invalid login state');
    }
    if (hasRepeatedValue(form, 'error')) return rejectRequest(response, 400, 'Invalid login response');
    const loginError = form.get('error');
    if (loginError) {
        if (!acceptCallback()) return rejectRequest(response, 409, 'A login callback is already being processed');
        const providerError = loginError.slice(0, 500).replace(/[\u0000-\u001f\u007f]/g, ' ');
        if (CANCELLATION_ERRORS.has(providerError.toLowerCase())) {
            cancelledResponse(response, 'You did not finish signing in to ZynoSuite, so nothing was changed.');
            return new CliError('ZynoSuite login was cancelled', 3, 'login_cancelled');
        }
        failureResponse(response, 'ZynoSuite could not complete this sign-in. Return to where you started for details.');
        return new CliError(`ZynoSuite login failed: ${providerError}`, 3, 'login_failed');
    }

    if (!['jwt', 'tenantId', 'expiresAt'].every(key => hasSingleValue(form, key))) {
        return rejectRequest(response, 400, 'Invalid login response');
    }
    const accessToken = form.get('jwt')!;
    const tenantId = form.get('tenantId')!;
    const expiresAt = Number(form.get('expiresAt'));
    const renewalValues = form.getAll('renewalToken');
    if ((renewable && renewalValues.length !== 1) || (!renewable && renewalValues.length !== 0)) {
        return rejectRequest(response, 400, 'Invalid renewal credential');
    }
    const renewalToken = renewalValues[0];
    if (!isJwt(accessToken)) return rejectRequest(response, 400, 'Invalid access token');
    if (!TENANT_ID_PATTERN.test(tenantId)) return rejectRequest(response, 400, 'Invalid tenant ID');
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + MAX_ACCESS_LIFETIME_MS) {
        return rejectRequest(response, 400, 'Invalid token expiration');
    }
    if (renewalToken !== undefined && !isRenewalToken(renewalToken)) return rejectRequest(response, 400, 'Invalid renewal credential');
    // Optional fields from newer portals: each may appear at most once and must be well formed.
    for (const key of ['tenantName', 'accountEmail', 'grantExpiresAt']) {
        if (form.getAll(key).length > 1) return rejectRequest(response, 400, 'Invalid login response');
    }
    const tenantName = form.get('tenantName') ?? undefined;
    const accountEmail = form.get('accountEmail') ?? undefined;
    const grantExpiresAtValue = form.get('grantExpiresAt');
    const grantExpiresAt = grantExpiresAtValue === null ? undefined : Number(grantExpiresAtValue);
    if (tenantName !== undefined && !isDisplayText(tenantName, 255)) return rejectRequest(response, 400, 'Invalid tenant name');
    if (accountEmail !== undefined && !isDisplayText(accountEmail, 320)) return rejectRequest(response, 400, 'Invalid account email');
    if (
        grantExpiresAt !== undefined &&
        (!Number.isSafeInteger(grantExpiresAt) || grantExpiresAt <= Date.now() || grantExpiresAt > Date.now() + MAX_GRANT_LIFETIME_MS)
    ) {
        return rejectRequest(response, 400, 'Invalid grant expiration');
    }
    if (!acceptCallback()) return rejectRequest(response, 409, 'A login callback is already being processed');

    const credential: UserCredential = {
        accessToken,
        tenantId,
        expiresAt,
        ...(renewalToken === undefined ? {} : { renewalToken }),
        ...(tenantName === undefined ? {} : { tenantName }),
        ...(accountEmail === undefined ? {} : { accountEmail }),
        ...(grantExpiresAt === undefined ? {} : { grantExpiresAt })
    };
    try {
        await onCredential?.(credential);
    } catch (error) {
        failureResponse(response, 'ZynoHosting could not save this login. Return to where you started for details.');
        return error instanceof Error ? error : new CliError('Could not save the ZynoSuite login', 1, 'login_save_failed');
    }

    successResponse(response, 'ZynoHosting is now connected to your account. Return to where you started to continue.');
    return credential;
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

function isRenewalToken(value: string): boolean {
    return value.length <= RENEWAL_TOKEN_MAX_LENGTH && /^zrt_[A-Za-z0-9_-]+$/.test(value);
}

function isDisplayText(value: string, max: number): boolean {
    return value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function hasSingleValue(form: URLSearchParams, key: string): boolean {
    return form.getAll(key).length === 1;
}

function hasRepeatedValue(form: URLSearchParams, key: string): boolean {
    return form.getAll(key).length > 1;
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
    response.end(renderCallbackPage('complete', message, { autoClose: true }));
}

/**
 * The callback arrived and was well formed, but the user did not finish signing
 * in. That is a 200 because nothing went wrong with the request, and it must not
 * look like success on the page.
 */
function cancelledResponse(response: ServerResponse, message: string): void {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(renderCallbackPage('cancelled', message));
}

function failureResponse(response: ServerResponse, message: string): void {
    response.statusCode = 500;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(renderCallbackPage('failed', message));
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
