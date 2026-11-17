import { z } from 'zod';

import type { ManagerCredential } from '../config.js';

import { DEPLOY_TOKEN_PATTERN } from '../config.js';
import { CliError, HttpError } from '../errors.js';
import { request, requestJson } from './http.js';
import { authorizationHeaders, basicAuthorization } from './manager-client.js';

export type KeyEnvironment = 'production' | 'preview';
export type KeyDelivery = 'poll' | 'display';
export type HandoffKind = 'github-secret' | 'gitlab-variable' | 'file' | 'manual';

/** One site a key is granted, and the environments it may deploy to. */
export interface KeySiteGrant {
    siteId: string;
    environments: KeyEnvironment[];
}

/** A site grant as ZynoAuth displays it on an issued key or a listed key. */
export interface KeySite extends KeySiteGrant {
    /** The site's primary hostname, as the owning app labelled it. */
    label: string;
}

export interface KeyRequestInput {
    /** Extra permission keys beyond the bare `hosting` app key the server adds for the grants. May be empty. */
    permissions: string[];
    /** The sites the key may deploy to. */
    sites: KeySiteGrant[];
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
    /** What ZynoAuth normalized the request to (not what was sent). Absent when a saved request is resumed. */
    requested?: { permissions: string[]; sites: KeySiteGrant[] } | undefined;
}

/** What is known about an issued key. The secret is never part of it. */
export interface IssuedKey {
    id: string;
    preview: string;
    /** Epoch milliseconds. */
    expiresAt: number;
    permissionKeys: string[];
    sites: KeySite[];
}

export type KeyRequestPoll =
    | { status: 'pending' | 'slow_down'; interval: number }
    | { status: 'denied' | 'expired' | 'consumed' }
    | { status: 'approved'; key: IssuedKey; secret?: string | undefined };

export interface ApiKeySummary {
    id: string;
    description: string;
    preview: string;
    status: 'active' | 'expired';
    apps: string[];
    /** Null for a manual key, which has every permission its tenant allows. */
    permissionKeys: string[] | null;
    origin: 'manual' | 'request';
    sites: KeySite[];
    approvedBy?: string | undefined;
    /** Epoch milliseconds. */
    createdAt: number;
    /** Absent for a manual key, which never expires. */
    expiresAt?: number | undefined;
    lastUsedAt?: number | undefined;
}

/** What the key says about itself at `GET /identity/api-keys/self`. */
export interface SelfKey {
    id: string;
    /** Epoch milliseconds. Absent for a manual API key, which never expires. */
    expiresAt?: number | undefined;
    description: string;
    apps: string[];
    permissionKeys: string[] | null;
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

const permissionKeySchema = z.string().min(1).max(100);
const environmentsSchema = z.array(z.enum(['production', 'preview'])).min(1);
const hostingGrantSchema = z.object({ v: z.literal(1), siteId: z.string().regex(UUID), environments: environmentsSchema });
/** `{ hosting?: [...] }`; apps this CLI does not know about are ignored. */
const grantMapSchema = z.object({ hosting: z.array(hostingGrantSchema).optional() }).loose();
const requestedSchema = z.object({ permissions: z.array(permissionKeySchema), grants: grantMapSchema });

const viewSchema = z.object({
    /** An app's own grant shape; the hosting ones are parsed with `hostingGrantSchema` after. */
    grant: z.record(z.string(), z.unknown()),
    display: z.object({
        resourceLabel: displayText(255),
        facts: z.array(z.object({ label: displayText(100), value: displayText(500) })).max(8)
    })
});

/** `KeyGrantDisplayMap`: per app, a title, the owner's views of each grant, and what the key can and cannot do. */
const displayMapSchema = z.record(
    z.string(),
    z.object({
        title: displayText(200),
        views: z.array(viewSchema),
        statements: z.object({ can: z.array(displayText(500)), cannot: z.array(displayText(500)) })
    })
);

const lifetimeSchema = z.object({ optionsSecs: z.array(z.number().int().positive()).min(1), defaultSecs: z.number().int().positive() });

const handoffSchema = z.object({
    kind: z.enum(['github-secret', 'gitlab-variable', 'file', 'manual']),
    target: displayText(200).nullable().optional()
});

const startSchema = z.object({
    requestId: z.string().regex(UUID),
    requestCode: z.string().regex(REQUEST_CODE),
    userCode: z.string().regex(USER_CODE),
    verificationUri: verificationUrl,
    verificationUriComplete: verificationUrl,
    interval: z.number().positive().max(300),
    expiresIn: z.number().positive(),
    /** Epoch milliseconds. */
    expiresAt: z.number().positive(),
    apps: z.array(z.string().max(64)),
    requested: requestedSchema,
    views: z.record(z.string(), z.array(viewSchema)),
    lifetime: lifetimeSchema
});

const keyInfoSchema = z.object({
    id: z.string().regex(UUID),
    tenantId: z.string().regex(UUID),
    description: displayText(500),
    keyPreview: displayText(100),
    permissionKeys: z.array(permissionKeySchema),
    display: displayMapSchema,
    handoff: handoffSchema.nullable(),
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

/** The fields a listed key and the key's own `self` answer share (manual keys have nulls and an empty `display`). */
const keyRowShape = {
    id: z.string().regex(UUID),
    tenantId: z.string().regex(UUID),
    description: displayText(500),
    keyPreview: displayText(100),
    permissionKeys: z.array(permissionKeySchema).nullable(),
    createdAt: isoMilliseconds,
    deletedAt: isoMilliseconds.nullable(),
    origin: z.enum(['manual', 'request']),
    expiresAt: isoMilliseconds.nullable(),
    apps: z.array(z.string().max(64)),
    display: displayMapSchema,
    handoff: handoffSchema.nullable(),
    lastUsedAt: isoMilliseconds.nullable(),
    createdByAccountId: z.string().regex(UUID).nullable(),
    requestedByAccountId: z.string().regex(UUID).nullable()
};

const summarySchema = z.object({ ...keyRowShape, createdByEmail: displayText(320).nullable(), status: z.enum(['active', 'expired']) });

/** The self answer is the list row without `status` and `createdByEmail`. */
const selfSchema = z.object(keyRowShape);

function invalid(error: z.ZodError, what: string): CliError {
    // Issue paths only: a response value (a request code, a key) must never reach a message.
    const where = [...new Set(error.issues.map(issue => issue.path.join('.') || 'response'))].join(', ');
    return new CliError(`ZynoAuth returned an invalid ${what} response (${where})`, 5, 'invalid_auth_response');
}

/** The hosting sites in a key's display map, each parsed against the hosting grant shape. */
function sitesOf(display: z.infer<typeof displayMapSchema>, what: string): KeySite[] {
    return (display.hosting?.views ?? []).map(view => {
        const grant = hostingGrantSchema.safeParse(view.grant);
        if (!grant.success) throw invalid(grant.error, what);
        return { siteId: grant.data.siteId, label: view.display.resourceLabel, environments: grant.data.environments };
    });
}

/** Reads one poll answer. Throws `invalid_auth_response` for anything the contract does not allow. */
function parsePoll(value: unknown, delivery: KeyDelivery): KeyRequestPoll {
    const parsed = pollSchema.safeParse(value);
    if (!parsed.success) throw invalid(parsed.error, 'key request poll');
    const { status, interval, key, secret, delivery: answered } = parsed.data;
    if (status === 'approved') {
        if (!key || answered !== delivery) {
            throw new CliError('ZynoAuth returned an invalid key request poll response (delivery or key)', 5, 'invalid_auth_response');
        }
        const issued: IssuedKey = {
            id: key.id,
            preview: key.keyPreview,
            expiresAt: key.expiresAt,
            permissionKeys: key.permissionKeys,
            sites: sitesOf(key.display, 'key request poll')
        };
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

/** A well-formed secret in an approved answer, found before the rest of the body is validated. Also searches text that is not JSON. */
function findSecret(value: unknown, text: string): string | undefined {
    if (value === undefined) return /zak_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/.exec(text)?.[0];
    if (!value || typeof value !== 'object') return undefined;
    const object = value as Record<string, unknown>;
    if (object.status !== 'approved' || typeof object.secret !== 'string') return undefined;
    return DEPLOY_TOKEN_PATTERN.test(object.secret) ? object.secret : undefined;
}

/** The key id, when the answer names one that looks like an id, so a person can find the key to revoke. */
function keyHints(value: unknown): string | undefined {
    const key = value && typeof value === 'object' ? (value as Record<string, unknown>).key : undefined;
    const id = key && typeof key === 'object' ? (key as Record<string, unknown>).id : undefined;
    return typeof id === 'string' && UUID.test(id) ? id : undefined;
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
            value = await requestJson(`${this.apiUrl}/identity/api-key-requests`, {
                method: 'POST',
                timeoutMs: this.timeoutMs,
                headers: { ...(await authorizationHeaders(credential)), Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    permissions: input.permissions,
                    grants: { hosting: input.sites.map(site => ({ v: 1, siteId: site.siteId, environments: site.environments })) },
                    description: input.description,
                    ...(input.requestedLifetimeSecs === undefined ? {} : { requestedLifetimeSecs: input.requestedLifetimeSecs }),
                    delivery: input.delivery,
                    ...(input.handoff
                        ? { handoff: { kind: input.handoff.kind, ...(input.handoff.target ? { target: input.handoff.target } : {}) } }
                        : {})
                })
            });
        } catch (error) {
            // 503 is the owning app or ZynoAuth being unavailable; its message says which. Other statuses (403, 404, 429) carry the server's own message and pass through.
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
        return {
            requestCode: start.requestCode,
            userCode: start.userCode,
            verificationUri: start.verificationUri,
            verificationUriComplete: start.verificationUriComplete,
            interval: start.interval,
            expiresAt: start.expiresAt,
            requested: {
                permissions: start.requested.permissions,
                sites: (start.requested.grants.hosting ?? []).map(grant => ({ siteId: grant.siteId, environments: grant.environments }))
            }
        };
    }

    /**
     * Asks whether the person approved. With `poll` delivery the secret arrives exactly once, here, and must match the key
     * format. With `display` delivery the response must carry no secret; if one is there it is dropped unread.
     *
     * With `poll` delivery the secret is found before anything else is checked. If the rest of the answer is unusable the
     * key already exists and nobody holds it, so it is revoked with itself before the error is raised.
     */
    async poll(requestCode: string, delivery: KeyDelivery): Promise<KeyRequestPoll> {
        const response = await request(`${this.apiUrl}/identity/api-key-requests/poll`, {
            method: 'POST',
            timeoutMs: this.timeoutMs,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestCode })
        });
        let text: string;
        try {
            text = await response.text();
        } catch {
            throw new HttpError('Request failed: the connection dropped', 0, 'network_error');
        }
        let value: unknown;
        try {
            value = text ? (JSON.parse(text) as unknown) : null;
        } catch {
            value = undefined;
        }
        const secret = delivery === 'poll' ? findSecret(value, text) : undefined;
        try {
            if (value === undefined)
                throw new HttpError('Server returned invalid JSON from /identity/api-key-requests/poll', response.status, 'invalid_json_response');
            return parsePoll(value, delivery);
        } catch (error) {
            if (!secret) throw error;
            let revoked = false;
            try {
                await this.revokeSelf(secret, 10_000);
                revoked = true;
            } catch {
                revoked = false;
            }
            const key = keyHints(value);
            throw new CliError(
                `The approved deploy token could not be read from ZynoAuth's answer, so ${revoked ? 'it was revoked' : 'it could not be revoked automatically'}${key ? ` (key ${key})` : ''}. ${revoked ? 'Run `zynohosting deploy-tokens create` again.' : 'Run `zynohosting deploy-tokens list` and revoke it, then create it again.'}`,
                3,
                'key_credential_lost'
            );
        }
    }

    /** Abandons a key request. Best effort. */
    async cancel(requestCode: string, timeoutMs = 2_000): Promise<void> {
        await requestJson(`${this.apiUrl}/identity/api-key-requests/cancel`, {
            method: 'POST',
            timeoutMs,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestCode })
        });
    }

    async list(credential: ManagerCredential, filter: { siteId?: string | undefined } = {}): Promise<ApiKeySummary[]> {
        const query = new URLSearchParams({ app: 'hosting' });
        const value = await requestJson(`${this.apiUrl}/tenant/api-keys?${query}`, {
            timeoutMs: this.timeoutMs,
            headers: { ...(await authorizationHeaders(credential)), Accept: 'application/json' }
        });
        if (!Array.isArray(value)) throw new CliError('ZynoAuth returned an invalid key list response', 5, 'invalid_auth_response');
        const keys = value.map(row => {
            const parsed = summarySchema.safeParse(row);
            if (!parsed.success) throw invalid(parsed.error, 'key list');
            const item = parsed.data;
            const summary: ApiKeySummary = {
                id: item.id,
                description: item.description,
                preview: item.keyPreview,
                status: item.status,
                ...(item.createdByEmail ? { approvedBy: item.createdByEmail } : {}),
                createdAt: item.createdAt,
                origin: item.origin,
                ...(item.expiresAt === null ? {} : { expiresAt: item.expiresAt }),
                ...(item.lastUsedAt === null ? {} : { lastUsedAt: item.lastUsedAt }),
                apps: item.apps,
                permissionKeys: item.permissionKeys,
                sites: sitesOf(item.display, 'key list')
            };
            return summary;
        });
        // ZynoAuth has no per-site filter: the site grants are in each key's display snapshot.
        const siteId = filter.siteId?.toLowerCase();
        return siteId ? keys.filter(key => key.sites.some(site => site.siteId.toLowerCase() === siteId)) : keys;
    }

    /** Revokes a key. ZynoAuth answers 404 for a key that is unknown, in another tenant, or already revoked: that is reported, not thrown. */
    async revoke(credential: ManagerCredential, keyId: string): Promise<{ alreadyRevoked: boolean }> {
        try {
            await this.sendRevoke(credential, keyId);
            return { alreadyRevoked: false };
        } catch (error) {
            if (error instanceof HttpError && error.status === 404) return { alreadyRevoked: true };
            throw error;
        }
    }

    private async sendRevoke(credential: ManagerCredential, keyId: string): Promise<void> {
        await requestJson(`${this.apiUrl}/tenant/api-keys/${encodeURIComponent(keyId)}`, {
            method: 'DELETE',
            timeoutMs: this.timeoutMs,
            headers: { ...(await authorizationHeaders(credential)), Accept: 'application/json' }
        });
    }

    /** The key describing itself: its expiry (hosting does not report one) and why a deploy was refused. */
    async self(key: string): Promise<SelfKey> {
        const value = await requestJson(`${this.apiUrl}/identity/api-keys/self`, {
            timeoutMs: this.timeoutMs,
            headers: { Authorization: basicAuthorization(key), Accept: 'application/json' }
        });
        const parsed = selfSchema.safeParse(value);
        if (!parsed.success) throw invalid(parsed.error, 'key');
        const { id, expiresAt, description, apps, permissionKeys } = parsed.data;
        return { id, expiresAt: expiresAt ?? undefined, description, apps, permissionKeys };
    }

    /** The key revoking itself: for a deploy-tokens revoke --self, and to undo a key whose hand-off failed. */
    async revokeSelf(key: string, timeoutMs = this.timeoutMs): Promise<void> {
        await requestJson(`${this.apiUrl}/identity/api-keys/self-revoke`, {
            method: 'POST',
            timeoutMs,
            headers: { Authorization: basicAuthorization(key), Accept: 'application/json' }
        });
    }
}
