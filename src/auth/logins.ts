import { CliError } from '../errors.js';

/** Where a login's renewal token lives. Absent means the operating system credential store. */
export type RenewalStoreKind = 'system' | 'file';

/** The id of the API-key entry, which is listed next to the logins of a profile. */
export const API_KEY_LOGIN_ID = 'api-key';
/** The id given to a login migrated from a saved credential that never recorded its tenant. */
export const LEGACY_LOGIN_ID = 'unknown';
/** The account part of a login id when the account could not be determined. */
export const UNKNOWN_ACCOUNT = 'unknown';

/** A login is one account in one tenant, keyed `<accountId>:<tenantId>`. */
export function loginIdFor(accountId: string, tenantId: string): string {
    return `${accountId}:${tenantId}`;
}

/** The `sub` claim of a JWT (the account id for a scoped token), or undefined if it cannot be read. Never verified. */
export function jwtSubject(jwt: string): string | undefined {
    try {
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: unknown };
        return typeof payload.sub === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(payload.sub) ? payload.sub : undefined;
    } catch {
        return undefined;
    }
}

/** One saved sign-in to one tenant. A profile holds one per tenant, keyed by tenant id. */
export interface StoredLogin {
    /** The account that approved the login. With `tenantId` it forms the login id. */
    accountId?: string;
    tenantId: string;
    tenantName?: string;
    accountEmail?: string;
    /** Epoch milliseconds. The end of the lifetime the approver chose; renewal stops there. */
    grantExpiresAt?: number;
    accessToken: string;
    /** Epoch milliseconds. */
    expiresAt?: number;
    renewalKey?: string;
    /** Absent means the system credential store. */
    renewalStore?: 'file';
    scopedToken?: boolean;
    permissionKeys?: string[];
    /** Requested at sign-in but not granted by the approver. */
    deniedPermissionKeys?: string[];
    createdAt?: number;
}

/** A device sign-in that was started with `--no-wait` and is waiting for `--resume`. */
export interface PendingDeviceLogin {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    /** Epoch milliseconds. */
    expiresAt: number;
    /** Seconds between polls. */
    interval: number;
    authApiUrl: string;
    renewable: boolean;
    renewalStore?: 'file';
    permissionKeys: string[];
    name: string;
    createdAt?: number;
    /** A poll failed in transit, so the credential may already have been handed over. An `expired` answer then means it was lost. */
    deliveryUncertain?: boolean;
}

export interface StoredConfig {
    apiUrl?: string;
    suiteApiUrl?: string;
    authApiUrl?: string;
    apiKey?: string;
    logins?: Record<string, StoredLogin>;
    activeLogin?: string;
    pendingDeviceLogin?: PendingDeviceLogin;
    /**
     * Fields of the single-credential format used before multiple logins. They are only accepted as input and are folded
     * into `logins` by `normalizeStoredConfig`; nothing writes them any more.
     */
    accessToken?: string;
    tenantId?: string;
    expiresAt?: number;
    renewalKey?: string;
    scopedToken?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = 4096): string | undefined {
    return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function number(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every(item => typeof item === 'string') ? (value as string[]) : undefined;
}

function parseLogin(value: unknown, fallbackId: string): StoredLogin | undefined {
    if (!isObject(value)) return undefined;
    const accessToken = text(value.accessToken, 64 * 1024);
    if (!accessToken) return undefined;
    const tenantId = text(value.tenantId, 200) ?? fallbackId;
    return {
        ...(text(value.accountId, 100) ? { accountId: text(value.accountId, 100)! } : {}),
        tenantId,
        ...(text(value.tenantName, 255) ? { tenantName: text(value.tenantName, 255)! } : {}),
        ...(text(value.accountEmail, 320) ? { accountEmail: text(value.accountEmail, 320)! } : {}),
        ...(number(value.grantExpiresAt) !== undefined ? { grantExpiresAt: number(value.grantExpiresAt)! } : {}),
        accessToken,
        ...(number(value.expiresAt) !== undefined ? { expiresAt: number(value.expiresAt)! } : {}),
        ...(typeof value.renewalKey === 'string' ? { renewalKey: value.renewalKey } : {}),
        ...(value.renewalStore === 'file' ? { renewalStore: 'file' as const } : {}),
        ...(value.scopedToken === true ? { scopedToken: true } : {}),
        ...(strings(value.permissionKeys) ? { permissionKeys: strings(value.permissionKeys)! } : {}),
        ...(strings(value.deniedPermissionKeys)?.length ? { deniedPermissionKeys: strings(value.deniedPermissionKeys)! } : {}),
        ...(number(value.createdAt) !== undefined ? { createdAt: number(value.createdAt)! } : {})
    };
}

function parsePending(value: unknown): PendingDeviceLogin | undefined {
    if (!isObject(value)) return undefined;
    const deviceCode = text(value.deviceCode, 200);
    const userCode = text(value.userCode, 64);
    const verificationUri = text(value.verificationUri);
    const authApiUrl = text(value.authApiUrl);
    const name = text(value.name, 255);
    const permissionKeys = strings(value.permissionKeys);
    const expiresAt = number(value.expiresAt);
    const interval = number(value.interval);
    if (
        !deviceCode ||
        !userCode ||
        !verificationUri ||
        !authApiUrl ||
        !name ||
        !permissionKeys ||
        expiresAt === undefined ||
        interval === undefined
    ) {
        return undefined;
    }
    if (typeof value.renewable !== 'boolean') return undefined;
    return {
        deviceCode,
        userCode,
        verificationUri,
        ...(text(value.verificationUriComplete) ? { verificationUriComplete: text(value.verificationUriComplete)! } : {}),
        expiresAt,
        interval,
        authApiUrl,
        renewable: value.renewable,
        ...(value.renewalStore === 'file' ? { renewalStore: 'file' as const } : {}),
        permissionKeys,
        name,
        ...(value.deliveryUncertain === true ? { deliveryUncertain: true } : {}),
        ...(number(value.createdAt) !== undefined ? { createdAt: number(value.createdAt)! } : {})
    };
}

/** Reads one profile object from disk, accepting both the multi-login format and the older single-credential one. */
export function parseStoredConfig(object: Record<string, unknown>): StoredConfig {
    const logins: Record<string, StoredLogin> = {};
    if (isObject(object.logins)) {
        for (const [id, value] of Object.entries(object.logins)) {
            const login = parseLogin(value, id);
            if (login) logins[id] = login;
        }
    }
    const pending = parsePending(object.pendingDeviceLogin);
    return normalizeStoredConfig({
        ...(typeof object.apiUrl === 'string' ? { apiUrl: object.apiUrl } : {}),
        ...(typeof object.suiteApiUrl === 'string' ? { suiteApiUrl: object.suiteApiUrl } : {}),
        ...(typeof object.authApiUrl === 'string' ? { authApiUrl: object.authApiUrl } : {}),
        ...(typeof object.apiKey === 'string' ? { apiKey: object.apiKey } : {}),
        ...(Object.keys(logins).length ? { logins } : {}),
        ...(typeof object.activeLogin === 'string' ? { activeLogin: object.activeLogin } : {}),
        ...(pending ? { pendingDeviceLogin: pending } : {}),
        ...(typeof object.accessToken === 'string' ? { accessToken: object.accessToken } : {}),
        ...(typeof object.tenantId === 'string' ? { tenantId: object.tenantId } : {}),
        ...(typeof object.expiresAt === 'number' ? { expiresAt: object.expiresAt } : {}),
        ...(typeof object.renewalKey === 'string' ? { renewalKey: object.renewalKey } : {}),
        ...(object.scopedToken === true ? { scopedToken: true } : {})
    });
}

/**
 * Folds a single-credential profile into the multi-login shape: the flat credential becomes the login for its tenant
 * (or `unknown` when the tenant was never recorded) and the active one. Everything else is returned as is.
 */
export function normalizeStoredConfig(config: StoredConfig): StoredConfig {
    const { accessToken, tenantId, expiresAt, renewalKey, scopedToken, ...rest } = config;
    let logins: Record<string, StoredLogin> = { ...rest.logins };
    let activeLogin = rest.activeLogin;
    if (accessToken) {
        const id = tenantId ?? LEGACY_LOGIN_ID;
        // Keyed by tenant for now; the re-keying below gives it its account.
        if (!(id in logins)) {
            logins[id] = {
                tenantId: id,
                accessToken,
                ...(expiresAt === undefined ? {} : { expiresAt }),
                ...(renewalKey === undefined ? {} : { renewalKey }),
                ...(scopedToken ? { scopedToken: true } : {})
            };
        }
        activeLogin ??= id;
    }
    // Logins saved before accounts were part of the key (keyed by tenant id) move to `<accountId>:<tenantId>`. The
    // account comes from the login, else the access token's `sub`, else the login is kept as `unknown:<tenantId>`.
    const rekeyed: Record<string, StoredLogin> = {};
    const renamed = new Map<string, string>();
    for (const [key, login] of Object.entries(logins)) {
        const accountId = login.accountId ?? jwtSubject(login.accessToken) ?? UNKNOWN_ACCOUNT;
        const id = loginIdFor(accountId, login.tenantId);
        renamed.set(key, id);
        rekeyed[id] = { ...login, ...(accountId === UNKNOWN_ACCOUNT ? {} : { accountId }) };
    }
    logins = rekeyed;
    if (activeLogin !== undefined && activeLogin !== API_KEY_LOGIN_ID) activeLogin = renamed.get(activeLogin) ?? activeLogin;
    return { ...rest, ...(Object.keys(logins).length ? { logins } : {}), ...(activeLogin === undefined ? {} : { activeLogin }) };
}

export function hasStoredCredential(config: StoredConfig): boolean {
    return Boolean(config.apiKey) || Object.keys(config.logins ?? {}).length > 0 || Boolean(config.accessToken);
}

/** A selectable credential in one profile: a login, or the saved API key. */
export interface LoginEntry {
    id: string;
    kind: 'login' | 'api-key';
    login?: StoredLogin;
}

export function loginEntries(config: StoredConfig): LoginEntry[] {
    const entries: LoginEntry[] = Object.entries(config.logins ?? {}).map(([id, login]) => ({ id, kind: 'login' as const, login }));
    if (config.apiKey) entries.push({ id: API_KEY_LOGIN_ID, kind: 'api-key' });
    return entries;
}

export function entryName(entry: LoginEntry): string {
    return entry.kind === 'api-key' ? 'API key' : (entry.login?.tenantName ?? entry.login?.tenantId ?? entry.id);
}

/** `Tenant (account email) [login id]`, enough to tell apart two accounts in one tenant. */
export function describeEntry(entry: LoginEntry): string {
    if (entry.kind === 'api-key') return 'API key';
    const who = entry.login?.accountEmail ? ` (${entry.login.accountEmail})` : '';
    return `${entryName(entry)}${who} [${entry.id}]`;
}

function accountMatches(entry: LoginEntry, account: string): boolean {
    const wanted = account.trim().toLowerCase();
    return entry.kind === 'login' && (entry.login?.accountId?.toLowerCase() === wanted || entry.login?.accountEmail?.toLowerCase() === wanted);
}

/**
 * Finds one login. `query` is a login id, a tenant id, or a tenant name (case-insensitive); `account` (an email or account
 * id) narrows the match. Several matches are `login_ambiguous`, listing each login id with its account and tenant.
 */
export function findEntry(entries: LoginEntry[], query: string | undefined, profileLabel: string, account?: string): LoginEntry {
    const wanted = query?.trim() ?? '';
    let candidates: LoginEntry[];
    if (!wanted) candidates = entries.filter(entry => entry.kind === 'login');
    else {
        const byId = entries.find(entry => entry.id === wanted);
        const byTenantId = entries.filter(entry => entry.kind === 'login' && entry.login?.tenantId === wanted);
        const lower = wanted.toLowerCase();
        const byName = entries.filter(entry => entry.kind === 'login' && entryName(entry).toLowerCase() === lower);
        candidates = byId ? [byId] : byTenantId.length ? byTenantId : byName;
    }
    if (account?.trim()) candidates = candidates.filter(entry => accountMatches(entry, account));
    if (candidates.length === 1) return candidates[0]!;
    const asked = [wanted && `"${wanted}"`, account?.trim() && `account "${account.trim()}"`].filter(Boolean).join(' with ');
    if (candidates.length > 1) {
        throw new CliError(
            `More than one saved login for ${profileLabel} matches ${asked}: ${candidates.map(describeEntry).join('; ')}. Pass --account <email or account id>, or use a full login id.`,
            2,
            'login_ambiguous'
        );
    }
    throw new CliError(
        entries.length
            ? `No saved login for ${profileLabel} matches ${asked}. Saved logins: ${entries.map(describeEntry).join('; ')}.`
            : `No saved login for ${profileLabel} matches ${asked}.`,
        2,
        'login_not_found'
    );
}

/**
 * The login a command uses: an explicit tenant and/or account (--tenant/--account, then the ZYNOHOSTING_ variables), the
 * active login, then the only one. Returns undefined when nothing is saved and throws `login_selection_required` when
 * several exist and none is chosen.
 */
export function selectEntry(config: StoredConfig, query: string | undefined, profileLabel: string, account?: string): LoginEntry | undefined {
    const entries = loginEntries(config);
    if (query?.trim() || account?.trim()) return findEntry(entries, query, profileLabel, account);
    if (entries.length === 0) return undefined;
    const active = config.activeLogin ? entries.find(entry => entry.id === config.activeLogin) : undefined;
    if (active) return active;
    if (entries.length === 1) return entries[0]!;
    throw new CliError(
        `More than one login is saved for ${profileLabel}: ${entries.map(describeEntry).join('; ')}. Pass --tenant <name or id> (and --account <email> if a tenant has several accounts), set ZYNOHOSTING_TENANT, or run \`zynohosting logins use <tenant>\` to choose one.`,
        2,
        'login_selection_required'
    );
}

/** The active login after removing one: the one that remains, or none when the choice would be a guess. */
export function activeAfterRemoval(config: StoredConfig, removedId: string): string | undefined {
    const remaining = loginEntries(config).filter(entry => entry.id !== removedId);
    if (config.activeLogin && config.activeLogin !== removedId && remaining.some(entry => entry.id === config.activeLogin)) return config.activeLogin;
    return remaining.length === 1 ? remaining[0]!.id : undefined;
}

/** A copy of the profile without one entry. The active login is re-chosen by `activeAfterRemoval`. */
export function withoutEntry(config: StoredConfig, entry: LoginEntry): StoredConfig {
    const { logins, apiKey, activeLogin: _activeLogin, ...rest } = config;
    const remaining = { ...logins };
    if (entry.kind === 'login') delete remaining[entry.id];
    const next: StoredConfig = {
        ...rest,
        ...(entry.kind === 'api-key' ? {} : apiKey === undefined ? {} : { apiKey }),
        ...(Object.keys(remaining).length ? { logins: remaining } : {})
    };
    const active = activeAfterRemoval(config, entry.id);
    return active ? { ...next, activeLogin: active } : next;
}
