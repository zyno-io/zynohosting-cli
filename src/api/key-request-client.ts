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
    verificationUriComplete: string;
    /** Seconds between polls. */
    interval: number;
    /** Epoch milliseconds. */
    expiresAt: number;
}

/** What is known about an issued key. The secret is never part of it. */
export interface IssuedKey {
    id: string;
    preview: string;
    /** Epoch milliseconds. */
    expiresAt: number;
    siteId?: string | undefined;
    environments?: KeyEnvironment[] | undefined;
}

export type KeyRequestPoll =
    | { status: 'pending' | 'slow_down'; interval: number }
    | { status: 'denied' | 'expired' | 'consumed' }
    | { status: 'approved'; key: IssuedKey; secret?: string | undefined };

export interface CapabilityKeySummary {
    id: string;
    description: string;
    preview: string;
    status: 'active' | 'expired';
    siteId?: string | undefined;
    environments?: KeyEnvironment[] | undefined;
    approvedBy?: string | undefined;
    /** Epoch milliseconds. */
    createdAt: number;
    expiresAt: number;
    lastUsedAt?: number | undefined;
}

/** What the key says about itself at `GET /identity/tenant-keys/self`. */
export interface SelfKey {
    id: string;
    /** Epoch milliseconds. */
    expiresAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_CODE = /^zkr_[A-Za-z0-9_-]{43}$/;
const USER_CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

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
        .pipe(z.string().max(max));
}

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
    verificationUri: verificationUrl,
    verificationUriComplete: verificationUrl,
    interval: z.number().positive().max(300),
    /** Epoch milliseconds. */
    expiresAt: z.number().positive()
});

const environmentsSchema = z.array(z.enum(['production', 'preview'])).min(1);
const hostingGrantSchema = z.object({ v: z.literal(1), siteId: z.string().regex(UUID), environments: environmentsSchema });
/** `{ hosting?: {...} }`; namespaces this CLI does not know about are ignored. */
const capabilitiesSchema = z.object({ hosting: hostingGrantSchema.loose().optional() }).loose();

const keyInfoSchema = z.object({
    id: z.string().regex(UUID),
    keyPreview: displayText(100),
    capabilities: capabilitiesSchema,
    createdAt: isoMilliseconds,
    expiresAt: isoMilliseconds
});

const pollSchema = z.object({
    status: z.enum(['pending', 'slow_down', 'approved', 'denied', 'expired', 'consumed']),
    interval: z.number().positive().max(300).optional(),
    delivery: z.enum(['poll', 'display']).optional(),
    key: keyInfoSchema.optional(),
    secret: z.string().max(256).optional()
});

const summarySchema = z.object({
    id: z.string().regex(UUID),
    description: displayText(500),
    keyPreview: displayText(100),
    capabilities: capabilitiesSchema,
    createdAt: isoMilliseconds,
    expiresAt: isoMilliseconds,
    lastUsedAt: isoMilliseconds.nullable(),
    createdByEmail: displayText(320).nullable(),
    status: z.enum(['active', 'expired'])
});

const selfSchema = z.object({ id: z.string().regex(UUID), expiresAt: isoMilliseconds });

function invalid(error: z.ZodError, what: string): CliError {
    // Issue paths only: a response value (a request code, a key) must never reach a message.
    const where = [...new Set(error.issues.map(issue => issue.path.join('.') || 'response'))].join(', ');
    return new CliError(`ZynoAuth returned an invalid ${what} response (${where})`, 5, 'invalid_auth_response');
}

function grantOf(capabilities: z.infer<typeof capabilitiesSchema>): { siteId?: string; environments?: KeyEnvironment[] } {
    const hosting = capabilities.hosting;
    return hosting ? { siteId: hosting.siteId, environments: hosting.environments } : {};
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
            // 503 is the owning app or ZynoAuth being unavailable; its message says which. 404 is the site not being found, so it passes through.
            if (error instanceof HttpError && error.status === 503) {
                throw new CliError(`Deploy tokens are not available right now: ${error.message}`, 4, 'deploy_tokens_unavailable');
            }
            throw error;
        }
        const parsed = startSchema.safeParse(value);
        if (!parsed.success) throw invalid(parsed.error, 'key request');
        const start = parsed.data;
        // The approval link must stay on the origin ZynoAuth named, so a response cannot send the person elsewhere.
        if (new URL(start.verificationUriComplete).origin !== new URL(start.verificationUri).origin) {
            throw new CliError('ZynoAuth returned an invalid key request response (verificationUriComplete)', 5, 'invalid_auth_response');
        }
        return start;
    }

    /**
     * Asks whether the person approved. With `poll` delivery the secret arrives exactly once, here, and must match the key
     * format. With `display` delivery the response must carry no secret; if one is there it is dropped unread.
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
        const { status, interval, key, secret, delivery: answered } = parsed.data;
        if (status === 'approved') {
            if (!key || answered !== delivery) {
                throw new CliError('ZynoAuth returned an invalid key request poll response (delivery or key)', 5, 'invalid_auth_response');
            }
            const issued: IssuedKey = { id: key.id, preview: key.keyPreview, expiresAt: key.expiresAt, ...grantOf(key.capabilities) };
            if (delivery === 'display') return { status, key: issued };
            if (!secret || !DEPLOY_TOKEN_PATTERN.test(secret)) {
                throw new CliError('ZynoAuth returned an approved key request without a valid key', 5, 'invalid_auth_response');
            }
            return { status, key: issued, secret };
        }
        if (status === 'pending' || status === 'slow_down') {
            if (interval === undefined)
                throw new CliError('ZynoAuth returned an invalid key request poll response (interval)', 5, 'invalid_auth_response');
            return { status, interval };
        }
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
        if (!Array.isArray(value)) throw new CliError('ZynoAuth returned an invalid key list response', 5, 'invalid_auth_response');
        return value.map(row => {
            const parsed = summarySchema.safeParse(row);
            if (!parsed.success) throw invalid(parsed.error, 'key list');
            const item = parsed.data;
            return {
                id: item.id,
                description: item.description,
                preview: item.keyPreview,
                status: item.status,
                ...(item.createdByEmail ? { approvedBy: item.createdByEmail } : {}),
                createdAt: item.createdAt,
                expiresAt: item.expiresAt,
                ...(item.lastUsedAt === null ? {} : { lastUsedAt: item.lastUsedAt }),
                ...grantOf(item.capabilities)
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
        const parsed = selfSchema.safeParse(value);
        if (!parsed.success) throw invalid(parsed.error, 'key');
        return parsed.data;
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
