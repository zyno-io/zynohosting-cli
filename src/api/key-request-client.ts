import { z } from 'zod';

import type { ManagerCredential } from '../config.js';

import { DEPLOY_TOKEN_PATTERN } from '../config.js';
import { CliError, HttpError } from '../errors.js';
import { requestJson } from './http.js';
import { authorizationHeaders, basicAuthorization } from './manager-client.js';

export type KeyEnvironment = 'production' | 'preview';
export type KeyDelivery = 'poll' | 'display';
export type HandoffKind = 'github-secret' | 'gitlab-variable' | 'file' | 'manual';

export interface KeyRequestInput {
    siteId: string;
    environments: KeyEnvironment[];
    description: string;
    requestedLifetimeSecs?: number | undefined;
    delivery: KeyDelivery;
    handoff?: { kind: HandoffKind; target?: string | undefined } | undefined;
}

export interface KeyRequestStart {
    requestCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string | undefined;
    /** Seconds between polls. */
    interval: number;
    /** Epoch milliseconds. */
    expiresAt: number;
}

/** What is known about an issued key. The secret is never part of it. */
export interface IssuedKey {
    id: string;
    preview?: string | undefined;
    /** Epoch milliseconds. */
    expiresAt?: number | undefined;
    siteId?: string | undefined;
    environments?: KeyEnvironment[] | undefined;
}

export type KeyRequestPoll =
    | { status: 'pending' | 'slow_down'; interval?: number | undefined }
    | { status: 'denied' | 'expired' | 'consumed' }
    | { status: 'approved'; key?: IssuedKey | undefined; secret?: string | undefined };

export interface CapabilityKeySummary {
    id: string;
    description?: string | undefined;
    preview?: string | undefined;
    siteId?: string | undefined;
    environments?: KeyEnvironment[] | undefined;
    approvedBy?: string | undefined;
    createdAt?: number | undefined;
    expiresAt?: number | undefined;
    lastUsedAt?: number | undefined;
}

/** What the key says about itself at `GET /identity/tenant-keys/self`. */
export interface SelfKey {
    id?: string | undefined;
    expiresAt?: number | undefined;
}

const REQUEST_CODE = /^zkr_[A-Za-z0-9_-]{20,100}$/;
const USER_CODE = /^[A-Z0-9][A-Z0-9-]{2,30}$/;

const time = z
    .union([z.number(), z.string().max(64)])
    .transform(value => (typeof value === 'number' ? value : Date.parse(value)))
    .pipe(z.number().finite());
const optionalTime = time.optional().catch(undefined);
const optionalText = z.string().max(500).optional().catch(undefined);
const environments = z
    .array(z.enum(['production', 'preview']))
    .optional()
    .catch(undefined);

function isLocalHttp(url: URL): boolean {
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

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

const startSchema = z.object({
    requestCode: z.string().regex(REQUEST_CODE),
    userCode: z.string().regex(USER_CODE),
    verificationUri: verificationUrl.optional(),
    verificationUriComplete: verificationUrl.optional().catch(undefined),
    interval: z.number().positive().max(300),
    expiresIn: z.number().positive().optional(),
    expiresAt: time.optional()
});

/** `granted` as the server stores it: `{ hosting: { v: 1, siteId, environments } }`, or that namespace on its own. */
function hostingGrant(value: unknown): { siteId?: string; environments?: KeyEnvironment[] } {
    if (!value || typeof value !== 'object') return {};
    const object = value as Record<string, unknown>;
    const hosting = (object.hosting && typeof object.hosting === 'object' ? object.hosting : object) as Record<string, unknown>;
    const parsed = z.object({ siteId: z.string().max(100).optional().catch(undefined), environments }).safeParse(hosting);
    return parsed.success
        ? {
              ...(parsed.data.siteId ? { siteId: parsed.data.siteId } : {}),
              ...(parsed.data.environments ? { environments: parsed.data.environments } : {})
          }
        : {};
}

const keySchema = z
    .object({
        id: z.string().min(1).max(100),
        preview: optionalText,
        expiresAt: optionalTime,
        granted: z.unknown().optional(),
        capabilities: z.unknown().optional()
    })
    .loose();

const pollSchema = z.object({
    status: z.enum(['pending', 'slow_down', 'approved', 'denied', 'expired', 'consumed']),
    interval: z.number().positive().max(300).optional().catch(undefined),
    key: keySchema.optional().catch(undefined),
    secret: z.string().max(256).optional()
});

const summarySchema = z
    .object({
        id: z.string().min(1).max(100),
        description: optionalText,
        preview: optionalText,
        createdAt: optionalTime,
        expiresAt: optionalTime,
        lastUsedAt: optionalTime,
        approvedBy: z
            .union([z.string(), z.object({ email: z.string().optional() }).loose()])
            .transform(value => (typeof value === 'string' ? value : value.email))
            .optional()
            .catch(undefined),
        granted: z.unknown().optional(),
        capabilities: z.unknown().optional()
    })
    .loose();

function invalid(error: z.ZodError, what: string): CliError {
    // Issue paths only: a response value (a request code, a key) must never reach a message.
    const where = [...new Set(error.issues.map(issue => issue.path.join('.') || 'response'))].join(', ');
    return new CliError(`ZynoAuth returned an invalid ${what} response (${where})`, 5, 'invalid_auth_response');
}

function issuedKey(key: z.infer<typeof keySchema>): IssuedKey {
    const grant = hostingGrant(key.granted ?? key.capabilities);
    return {
        id: key.id,
        ...(key.preview ? { preview: key.preview } : {}),
        ...(key.expiresAt === undefined ? {} : { expiresAt: key.expiresAt }),
        ...grant
    };
}

export class KeyRequestClient {
    constructor(
        private readonly apiUrl: string,
        private readonly timeoutMs = 30_000
    ) {}

    /** Starts a key request as the signed-in account. The requester must be a person's login, never an API key or a key. */
    async start(credential: ManagerCredential, input: KeyRequestInput): Promise<KeyRequestStart> {
        if (credential.type !== 'bearer') {
            throw new CliError(
                'Creating a deploy token needs a ZynoSuite login (run `zynohosting login`), not an API key or another token.',
                3,
                'login_required'
            );
        }
        let value: unknown;
        try {
            value = await requestJson(`${this.apiUrl}/identity/key-requests`, {
                method: 'POST',
                timeoutMs: this.timeoutMs,
                headers: { ...(await authorizationHeaders(credential)), Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    capabilities: { hosting: { v: 1, siteId: input.siteId, environments: input.environments } },
                    description: input.description,
                    ...(input.requestedLifetimeSecs === undefined ? {} : { requestedLifetimeSecs: input.requestedLifetimeSecs }),
                    delivery: input.delivery,
                    ...(input.handoff
                        ? { handoff: { kind: input.handoff.kind, ...(input.handoff.target ? { target: input.handoff.target } : {}) } }
                        : {})
                })
            });
        } catch (error) {
            if (error instanceof HttpError && (error.status === 404 || error.status === 503)) {
                throw new CliError(
                    'Deploy tokens are not available on this ZynoSuite server right now. Try again later.',
                    4,
                    'deploy_tokens_unavailable'
                );
            }
            throw error;
        }
        const parsed = startSchema.safeParse(value);
        if (!parsed.success) throw invalid(parsed.error, 'key request');
        const { expiresAt, expiresIn, verificationUri, verificationUriComplete, ...rest } = parsed.data;
        const deadline = expiresAt ?? (expiresIn === undefined ? undefined : Date.now() + expiresIn * 1000);
        const link = verificationUri ?? verificationUriComplete;
        if (deadline === undefined || !link)
            throw new CliError('ZynoAuth returned an invalid key request response (expiry or link)', 5, 'invalid_auth_response');
        const complete =
            verificationUriComplete && new URL(verificationUriComplete).origin === new URL(link).origin ? verificationUriComplete : undefined;
        return { ...rest, verificationUri: link, ...(complete ? { verificationUriComplete: complete } : {}), expiresAt: deadline };
    }

    /**
     * Asks whether the person approved. With `poll` delivery the secret arrives exactly once, here, and must match the key
     * format. With `display` delivery the response is read for key details only: any secret in it is dropped unread.
     */
    async poll(requestCode: string, delivery: KeyDelivery): Promise<KeyRequestPoll> {
        const value = await requestJson(`${this.apiUrl}/identity/key-requests/poll`, {
            method: 'POST',
            timeoutMs: this.timeoutMs,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestCode })
        });
        const parsed = pollSchema.safeParse(value);
        if (!parsed.success) throw invalid(parsed.error, 'key request poll');
        const { status, interval, key, secret } = parsed.data;
        if (status === 'approved') {
            const fromKey =
                key && typeof (key as Record<string, unknown>).secret === 'string' ? ((key as Record<string, unknown>).secret as string) : undefined;
            const found = secret ?? fromKey;
            if (delivery === 'display') return { status, ...(key ? { key: issuedKey(key) } : {}) };
            if (!found || !DEPLOY_TOKEN_PATTERN.test(found)) {
                throw new CliError('ZynoAuth returned an approved key request without a valid key', 5, 'invalid_auth_response');
            }
            return { status, secret: found, ...(key ? { key: issuedKey(key) } : {}) };
        }
        if (status === 'pending' || status === 'slow_down') return { status, interval };
        return { status };
    }

    /** Abandons a key request. Best effort. */
    async cancel(requestCode: string, timeoutMs = 2_000): Promise<void> {
        await requestJson(`${this.apiUrl}/identity/key-requests/cancel`, {
            method: 'POST',
            timeoutMs,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestCode })
        });
    }

    async list(credential: ManagerCredential, filter: { siteId?: string | undefined } = {}): Promise<CapabilityKeySummary[]> {
        const query = new URLSearchParams({ namespace: 'hosting', ...(filter.siteId ? { ref: `site:${filter.siteId}` } : {}) });
        const value = await requestJson(`${this.apiUrl}/tenant/capability-keys?${query}`, {
            timeoutMs: this.timeoutMs,
            headers: { ...(await authorizationHeaders(credential)), Accept: 'application/json' }
        });
        const rows = Array.isArray(value)
            ? value
            : value && typeof value === 'object'
              ? ((value as Record<string, unknown>).keys ?? (value as Record<string, unknown>).items ?? (value as Record<string, unknown>).data)
              : undefined;
        if (!Array.isArray(rows)) throw new CliError('ZynoAuth returned an invalid key list response', 5, 'invalid_auth_response');
        return rows.map(row => {
            const parsed = summarySchema.safeParse(row);
            if (!parsed.success) throw invalid(parsed.error, 'key list');
            const item = parsed.data;
            return {
                id: item.id,
                ...(item.description ? { description: item.description } : {}),
                ...(item.preview ? { preview: item.preview } : {}),
                ...(item.approvedBy ? { approvedBy: item.approvedBy } : {}),
                ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
                ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
                ...(item.lastUsedAt === undefined ? {} : { lastUsedAt: item.lastUsedAt }),
                ...hostingGrant(item.granted ?? item.capabilities)
            };
        });
    }

    async revoke(credential: ManagerCredential, keyId: string): Promise<void> {
        await requestJson(`${this.apiUrl}/tenant/capability-keys/${encodeURIComponent(keyId)}`, {
            method: 'DELETE',
            timeoutMs: this.timeoutMs,
            headers: { ...(await authorizationHeaders(credential)), Accept: 'application/json' }
        });
    }

    /** The key describing itself. Used to say why a deploy was refused. */
    async self(key: string): Promise<SelfKey> {
        const value = await requestJson(`${this.apiUrl}/identity/tenant-keys/self`, {
            timeoutMs: this.timeoutMs,
            headers: { Authorization: basicAuthorization(key), Accept: 'application/json' }
        });
        const parsed = z
            .object({ id: z.string().max(100).optional().catch(undefined), expiresAt: optionalTime })
            .loose()
            .safeParse(value ?? {});
        return parsed.success ? parsed.data : {};
    }

    /** The key revoking itself: for a deploy-tokens revoke --self, and to undo a key whose hand-off failed. */
    async revokeSelf(key: string, timeoutMs = this.timeoutMs): Promise<void> {
        await requestJson(`${this.apiUrl}/identity/tenant-keys/self-revoke`, {
            method: 'POST',
            timeoutMs,
            headers: { Authorization: basicAuthorization(key), Accept: 'application/json' }
        });
    }
}
