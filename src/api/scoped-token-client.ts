import { z } from 'zod';

import { CliError, HttpError } from '../errors.js';
import { requestJson } from './http.js';

/** An ISO date string converted to epoch milliseconds. */
const isoMilliseconds = z
    .string()
    .max(64)
    .transform((value, context) => {
        const parsed = Date.parse(value);
        if (Number.isNaN(parsed)) {
            context.addIssue({ code: 'custom', message: 'must be a date' });
            return z.NEVER;
        }
        return parsed;
    });

/** Display text with control characters removed, so a hostile server cannot inject terminal escapes. */
function displayText(max: number) {
    return z
        .string()
        .transform(value => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim())
        .pipe(z.string().min(1).max(max));
}

const renewedCredentialSchema = z.object({
    jwt: z
        .string()
        .min(1)
        .max(12 * 1024)
        .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    expiresAt: z
        .number()
        .int()
        .positive()
        .refine(value => value > Date.now() && value <= Date.now() + 2 * 60 * 60 * 1000, 'must be a future access-token expiration'),
    renewalToken: z
        .string()
        .startsWith('zrt_')
        .regex(/^zrt_[A-Za-z0-9_-]+$/)
        .max(16 * 1024),
    ...identityFields()
});

/** Optional fields an older server omits. A null or malformed value is dropped rather than failing the response. */
function identityFields() {
    return {
        grantExpiresAt: isoMilliseconds.optional().catch(undefined),
        tenantName: displayText(255).optional().catch(undefined),
        accountEmail: displayText(320).optional().catch(undefined)
    };
}

export interface RenewedScopedCredential {
    jwt: string;
    expiresAt: number;
    renewalToken: string;
    grantExpiresAt?: number | undefined;
    tenantName?: string | undefined;
    accountEmail?: string | undefined;
}

/** A credential from the device flow: the create response, which also carries the tenant and account it was issued for. */
export interface DeviceCredential {
    jwt: string;
    expiresAt: number;
    tenantId: string;
    renewalToken?: string | undefined;
    grantExpiresAt?: number | undefined;
    tenantName?: string | undefined;
    accountEmail?: string | undefined;
}

export interface DeviceStartRequest {
    description: string;
    permissionKeys: string[];
    renewable: boolean;
    requestedLifetimeSecs?: number;
}

export interface DeviceStart {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string | undefined;
    /** Seconds between polls. */
    interval: number;
    /** Epoch milliseconds. */
    expiresAt: number;
}

export type DevicePoll =
    | { status: 'pending' | 'slow_down'; interval?: number | undefined }
    | { status: 'denied' | 'expired' }
    | { status: 'approved'; credential: DeviceCredential; approvedBy?: { email?: string | undefined; tenantName?: string | undefined } | undefined };

const TENANT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const USER_CODE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const DEVICE_CODE = /^zdc_[A-Za-z0-9_-]{43}$/;
const jwtSchema = z
    .string()
    .min(1)
    .max(12 * 1024)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

function isLocalHttp(url: URL): boolean {
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** The approval page must be https (or http on localhost) and must not embed credentials. */
const verificationUrl = z
    .string()
    .max(2048)
    .refine(value => {
        try {
            const url = new URL(value);
            return (url.protocol === 'https:' || isLocalHttp(url)) && !url.username && !url.password && !url.hash;
        } catch {
            return false;
        }
    }, 'must be an https URL');

const deviceStartSchema = z.object({
    deviceCode: z.string().regex(DEVICE_CODE),
    userCode: z.string().regex(USER_CODE),
    verificationUri: verificationUrl,
    verificationUriComplete: verificationUrl.optional().catch(undefined),
    interval: z.number().positive().max(300),
    expiresIn: z.number().positive().optional(),
    expiresAt: z.union([z.number().positive(), isoMilliseconds]).optional()
});

const deviceCredentialSchema = z.object({
    jwt: jwtSchema,
    expiresAt: z
        .number()
        .int()
        .positive()
        .refine(value => value > Date.now() && value <= Date.now() + 2 * 60 * 60 * 1000, 'must be a future access-token expiration'),
    tenantId: z.string().regex(TENANT_ID),
    renewalToken: z
        .string()
        .regex(/^zrt_[A-Za-z0-9_-]+$/)
        .max(16 * 1024)
        .optional(),
    permissionKeys: z.array(z.string()).optional(),
    ...identityFields()
});

const devicePollSchema = z.object({
    status: z.enum(['pending', 'slow_down', 'approved', 'denied', 'expired']),
    interval: z.number().positive().max(300).optional().catch(undefined),
    credential: deviceCredentialSchema.optional(),
    approvedBy: z
        .object({ email: displayText(320).nullish().catch(undefined), tenantName: displayText(255).optional().catch(undefined) })
        .optional()
        .catch(undefined)
});

function sameSet(a: readonly string[], b: readonly string[]): boolean {
    const left = new Set(a);
    return left.size === new Set(b).size && b.every(item => left.has(item));
}

function invalidDevice(error: z.ZodError): CliError {
    // Issue paths only: a response value (a device code, a token) must never reach a message.
    const where = [...new Set(error.issues.map(issue => issue.path.join('.') || 'response'))].join(', ');
    return new CliError(`ZynoAuth returned an invalid device sign-in response (${where})`, 5, 'invalid_auth_response');
}

export class ScopedTokenClient {
    constructor(
        private readonly apiUrl: string,
        private readonly timeoutMs = 30_000
    ) {}

    async renew(renewalToken: string): Promise<RenewedScopedCredential> {
        if (!/^zrt_[A-Za-z0-9_-]+$/.test(renewalToken) || renewalToken.length > 16 * 1024) {
            throw new CliError('The saved renewal credential is invalid', 3, 'invalid_renewal_credential');
        }
        const value = await requestJson(`${this.apiUrl}/identity/scoped-tokens/renew`, {
            method: 'POST',
            timeoutMs: this.timeoutMs,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ renewalToken })
        });
        const parsed = renewedCredentialSchema.safeParse(value);
        if (parsed.success) return parsed.data;
        throw new CliError(`ZynoAuth returned an invalid renewal response: ${z.prettifyError(parsed.error)}`, 5, 'invalid_auth_response');
    }

    async revoke(accessToken: string): Promise<void> {
        await requestJson(`${this.apiUrl}/identity/scoped-tokens/revoke`, {
            method: 'POST',
            timeoutMs: this.timeoutMs,
            headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` }
        });
    }

    /** Starts a device sign-in. A server that has the feature off (404) or is at capacity (503) is reported as unavailable. */
    async startDevice(request: DeviceStartRequest): Promise<DeviceStart> {
        let value: unknown;
        try {
            value = await requestJson(`${this.apiUrl}/identity/scoped-tokens/device/start`, {
                method: 'POST',
                timeoutMs: this.timeoutMs,
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    description: request.description,
                    permissionKeys: request.permissionKeys,
                    renewable: request.renewable,
                    ...(request.requestedLifetimeSecs === undefined ? {} : { requestedLifetimeSecs: request.requestedLifetimeSecs })
                })
            });
        } catch (error) {
            if (error instanceof HttpError && (error.status === 404 || error.status === 503)) {
                throw new CliError(
                    'Signing in with a link and code is not available on this ZynoSuite server right now. Use the browser sign-in on a computer with a browser, or try again later.',
                    4,
                    'device_flow_unavailable'
                );
            }
            throw error;
        }
        const parsed = deviceStartSchema.safeParse(value);
        if (!parsed.success) throw invalidDevice(parsed.error);
        const { expiresAt, expiresIn, ...rest } = parsed.data;
        const deadline = expiresAt ?? (expiresIn === undefined ? undefined : Date.now() + expiresIn * 1000);
        if (deadline === undefined)
            throw new CliError('ZynoAuth returned an invalid device sign-in response (expiresAt)', 5, 'invalid_auth_response');
        if (rest.verificationUriComplete && new URL(rest.verificationUriComplete).origin !== new URL(rest.verificationUri).origin) {
            delete rest.verificationUriComplete;
        }
        return { ...rest, expiresAt: deadline };
    }

    /**
     * Asks whether the person approved. The credential is returned exactly once. When `renewable` is stated, a renewal
     * token must be present exactly then, and `permissionKeys` (if the server echoes them) must match what was requested.
     */
    async pollDevice(deviceCode: string, expectation: { renewable: boolean; permissionKeys: string[] }): Promise<DevicePoll> {
        const value = await requestJson(`${this.apiUrl}/identity/scoped-tokens/device/poll`, {
            method: 'POST',
            timeoutMs: this.timeoutMs,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceCode })
        });
        const parsed = devicePollSchema.safeParse(value);
        if (!parsed.success) throw invalidDevice(parsed.error);
        const { status, interval, credential, approvedBy } = parsed.data;
        if (status === 'approved') {
            if (!credential) throw new CliError('ZynoAuth returned an invalid device sign-in response (credential)', 5, 'invalid_auth_response');
            if (Boolean(credential.renewalToken) !== expectation.renewable) {
                throw new CliError('ZynoAuth returned a credential that does not match the sign-in request (renewal)', 5, 'invalid_auth_response');
            }
            if (credential.permissionKeys && !sameSet(credential.permissionKeys, expectation.permissionKeys)) {
                throw new CliError(
                    'ZynoAuth returned a credential that does not match the sign-in request (permissions)',
                    5,
                    'invalid_auth_response'
                );
            }
            const { permissionKeys: _permissionKeys, ...issued } = credential;
            return {
                status,
                credential: issued,
                ...(approvedBy ? { approvedBy: { email: approvedBy.email ?? undefined, tenantName: approvedBy.tenantName } } : {})
            };
        }
        if (status === 'pending' || status === 'slow_down') return { status, interval };
        return { status };
    }

    /** Abandons a device sign-in. Best effort: the server answers the same whether or not the code existed. */
    async cancelDevice(deviceCode: string, timeoutMs = 2_000): Promise<void> {
        await requestJson(`${this.apiUrl}/identity/scoped-tokens/device/cancel`, {
            method: 'POST',
            timeoutMs,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceCode })
        });
    }
}
