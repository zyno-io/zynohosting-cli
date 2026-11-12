import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ScopedTokenClient } from './api/scoped-token-client.js';
import { attachCredentialRefresh, ensureFreshCredential } from './auth/credential-refresh.js';
import { createSystemRenewalTokenStore, type RenewalTokenStore } from './auth/renewal-token-store.js';
import { CliError } from './errors.js';

export interface StoredConfig {
    apiUrl?: string;
    suiteApiUrl?: string;
    authApiUrl?: string;
    apiKey?: string;
    accessToken?: string;
    tenantId?: string;
    expiresAt?: number;
    renewalKey?: string;
    scopedToken?: boolean;
}

export interface ApiKeyCredential {
    type: 'api-key';
    apiKey: string;
}

export interface BearerCredential {
    type: 'bearer';
    accessToken: string;
    tenantId?: string;
    expiresAt?: number;
}

export type ManagerCredential = ApiKeyCredential | BearerCredential;
export type HostingEnvironment = 'production' | 'alpha' | 'dev';

export interface ConfigOverrides extends StoredConfig {
    environment?: HostingEnvironment;
}

export interface ResolvedConfig {
    apiUrl: string;
    suiteApiUrl?: string;
    authApiUrl?: string;
    credential: ManagerCredential;
}

export interface ResolveConfigDependencies {
    renewalTokenStore?: RenewalTokenStore;
    scopedTokenClient?: (apiUrl: string) => Pick<ScopedTokenClient, 'renew'>;
}

const PROFILES_FILE = 'hosting-cli-profiles.json';
const LEGACY_FILE = 'hosting-cli.json';

function defaultDirectory(env: NodeJS.ProcessEnv): string {
    if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Zyno');
    return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'zyno');
}

/** The v2 config file. ZYNOHOSTING_CONFIG, when set, is used as is. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
    if (env.ZYNOHOSTING_CONFIG) return env.ZYNOHOSTING_CONFIG;
    return join(defaultDirectory(env), PROFILES_FILE);
}

/** The v2 file plus, for the default location only, the flat file written by earlier versions (a read-only migration source). */
export interface ConfigLocation {
    path: string;
    legacyPath?: string;
}

export type ConfigTarget = string | ConfigLocation;

export function configLocation(env: NodeJS.ProcessEnv = process.env): ConfigLocation {
    const path = configPath(env);
    return env.ZYNOHOSTING_CONFIG ? { path } : { path, legacyPath: join(defaultDirectory(env), LEGACY_FILE) };
}

function locate(target: ConfigTarget): ConfigLocation {
    return typeof target === 'string' ? { path: target } : target;
}

export interface ConfigFile {
    version: 2;
    profiles: Record<string, StoredConfig>;
}

function parseStoredConfig(object: Record<string, unknown>): StoredConfig {
    return {
        ...(typeof object.apiUrl === 'string' ? { apiUrl: object.apiUrl } : {}),
        ...(typeof object.suiteApiUrl === 'string' ? { suiteApiUrl: object.suiteApiUrl } : {}),
        ...(typeof object.authApiUrl === 'string' ? { authApiUrl: object.authApiUrl } : {}),
        ...(typeof object.apiKey === 'string' ? { apiKey: object.apiKey } : {}),
        ...(typeof object.accessToken === 'string' ? { accessToken: object.accessToken } : {}),
        ...(typeof object.tenantId === 'string' ? { tenantId: object.tenantId } : {}),
        ...(typeof object.expiresAt === 'number' ? { expiresAt: object.expiresAt } : {}),
        ...(typeof object.renewalKey === 'string' ? { renewalKey: object.renewalKey } : {}),
        ...(object.scopedToken === true ? { scopedToken: true } : {})
    };
}

class InvalidLegacyUrlError extends CliError {
    constructor(message: string) {
        super(message, 2, 'invalid_config');
    }
}

async function readConfigFile(path: string): Promise<ConfigFile> {
    try {
        const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('config must be an object');
        const object = value as Record<string, unknown>;
        if ('version' in object) {
            if (object.version !== 2) throw new Error(`unsupported config version ${String(object.version)}`);
            const profiles = object.profiles;
            if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) throw new Error('profiles must be an object');
            return {
                version: 2,
                profiles: Object.fromEntries(
                    Object.entries(profiles as Record<string, unknown>).map(([key, profile]) => {
                        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error(`profile ${key} must be an object`);
                        return [key, parseStoredConfig(profile as Record<string, unknown>)];
                    })
                )
            };
        }
        const legacy = parseStoredConfig(object);
        if (Object.keys(legacy).length === 0) return { version: 2, profiles: {} };
        let key: string;
        try {
            key = profileKeyForApiUrl(legacy.apiUrl ?? API_URLS.production);
        } catch (error) {
            throw new InvalidLegacyUrlError(
                `its saved API URL is invalid (${error instanceof Error ? error.message : String(error)}). Run \`zynohosting login\` again or delete the file`
            );
        }
        return { version: 2, profiles: { [key]: legacy } };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
        const message = `Could not read config at ${path}: ${error instanceof Error ? error.message : String(error)}`;
        throw error instanceof InvalidLegacyUrlError ? new InvalidLegacyUrlError(message) : new CliError(message, 2, 'invalid_config');
    }
}

export interface LoadConfigOptions {
    /** Ignore an unreadable legacy file instead of failing, for callers that are about to write the v2 file. */
    lenientLegacy?: boolean;
}

/**
 * Reads the v2 file. If it does not exist yet, the legacy flat file (when the location has one) is read as a single
 * profile keyed from its stored API URL. Once the v2 file exists the legacy file is ignored. A flat object found at the
 * v2 path itself (an explicit ZYNOHOSTING_CONFIG) is migrated in place.
 */
export async function loadConfigFile(target: ConfigTarget = configLocation(), options: LoadConfigOptions = {}): Promise<ConfigFile> {
    const { path, legacyPath } = locate(target);
    try {
        return await readConfigFile(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            // A flat file whose only problem is an unusable API URL holds no usable login, so a writer may replace it.
            if (options.lenientLegacy && error instanceof InvalidLegacyUrlError) {
                return { version: 2, profiles: {} };
            }
            throw error;
        }
    }
    if (legacyPath) {
        try {
            return await readConfigFile(legacyPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' || options.lenientLegacy) return { version: 2, profiles: {} };
            throw error;
        }
    }
    return { version: 2, profiles: {} };
}

/** Reads one saved profile; an absent profile is an empty config. */
export async function loadStoredConfig(
    target: ConfigTarget = configLocation(),
    key = 'production',
    options: LoadConfigOptions = {}
): Promise<StoredConfig> {
    return (await loadConfigFile(target, options)).profiles[key] ?? {};
}

/** Profile key: the environment name when the URL is that environment's Hosting API, else `url:<normalized URL>`. */
export function profileKeyForApiUrl(apiUrl: string): string {
    const normalized = normalizeApiUrl(apiUrl);
    const environment = (Object.entries(API_URLS) as [HostingEnvironment, string][]).find(([, url]) => url === normalized)?.[0];
    return environment ?? `url:${normalized}`;
}

export interface ProfileSelection {
    key: string;
    apiUrl: string;
}

/**
 * The effective Hosting API URL is --api-url, --environment, ZYNOHOSTING_API_URL, ZYNOHOSTING_ENVIRONMENT, then
 * production (flags before environment variables). The profile key is always derived from that URL. Nothing is sticky.
 */
export function selectProfile(
    overrides: Pick<ConfigOverrides, 'apiUrl' | 'environment'> = {},
    env: NodeJS.ProcessEnv = process.env
): ProfileSelection {
    // Each source is only parsed when the precedence reaches it, so an invalid variable cannot break a flag.
    const apiUrl = normalizeApiUrl(
        overrides.apiUrl ||
            (overrides.environment ? API_URLS[parseEnvironment(overrides.environment)] : '') ||
            env.ZYNOHOSTING_API_URL ||
            (env.ZYNOHOSTING_ENVIRONMENT ? API_URLS[parseEnvironment(env.ZYNOHOSTING_ENVIRONMENT)] : '') ||
            API_URLS.production
    );
    return { key: profileKeyForApiUrl(apiUrl), apiUrl };
}

/** True when --api-url or --environment, rather than a variable, chose the Hosting URL. */
export function hostingUrlChosenByFlag(overrides: Pick<ConfigOverrides, 'apiUrl' | 'environment'>): boolean {
    return Boolean(overrides.apiUrl || overrides.environment);
}

export function describeProfileKey(key: string): string {
    return key.startsWith('url:') ? key.slice(4) : key;
}

export function selectionForKey(key: string, stored: StoredConfig = {}): ProfileSelection {
    if (key.startsWith('url:')) return { key, apiUrl: key.slice(4) };
    const apiUrl = API_URLS[key as HostingEnvironment];
    return { key, apiUrl: stored.apiUrl ? normalizeApiUrl(stored.apiUrl) : (apiUrl ?? key) };
}

export function hasStoredCredential(config: StoredConfig): boolean {
    return Boolean(config.apiKey || config.accessToken || config.renewalKey);
}

/** Under the config lock, re-reads the file and replaces (or, with undefined, removes) only one profile before writing the v2 file. */
export async function updateProfile(key: string, profile: StoredConfig | undefined, target: ConfigTarget = configLocation()): Promise<void> {
    const location = locate(target);
    await withRefreshLock(location.path, () => updateProfileUnlocked(key, profile, location), PROFILE_UPDATE_LOCK_WAIT_MS);
}

/** For callers that already hold the config lock; the lock must never be taken twice in one process. */
async function updateProfileUnlocked(key: string, profile: StoredConfig | undefined, location: ConfigLocation): Promise<void> {
    const file = await loadConfigFile(location, { lenientLegacy: true });
    const profiles = { ...file.profiles };
    if (profile === undefined) delete profiles[key];
    else profiles[key] = profile;
    await writeConfigFile({ version: 2, profiles }, location.path);
}

/**
 * Deletes the legacy flat file when it still holds the given credential, so an older CLI build cannot keep using a login
 * that was just removed. Does nothing for an explicit ZYNOHOSTING_CONFIG.
 */
export async function removeLegacyConfigIfMatching(target: ConfigTarget, removed: StoredConfig): Promise<void> {
    const { legacyPath } = locate(target);
    if (!legacyPath) return;
    let legacy: StoredConfig;
    try {
        const value = JSON.parse(await readFile(legacyPath, 'utf8')) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value) || 'version' in value) return;
        legacy = parseStoredConfig(value as Record<string, unknown>);
    } catch {
        return;
    }
    const matches =
        (removed.apiKey !== undefined && legacy.apiKey === removed.apiKey) ||
        (removed.accessToken !== undefined && legacy.accessToken === removed.accessToken) ||
        (removed.renewalKey !== undefined && legacy.renewalKey === removed.renewalKey);
    if (matches) await rm(legacyPath, { force: true });
}

/** Environment with every endpoint selector removed, so a saved profile uses its own stored URLs. */
export function isolatedEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
        ...env,
        ZYNOHOSTING_ENVIRONMENT: undefined,
        ZYNOHOSTING_API_URL: undefined,
        ZYNO_SUITE_API_URL: undefined,
        ZYNO_AUTH_API_URL: undefined
    };
}

// Longer than the stale-lock threshold, so a just-completed browser login outlasts a crashed holder instead of failing.
const PROFILE_UPDATE_LOCK_WAIT_MS = 150_000;

const API_URLS: Record<HostingEnvironment, string> = {
    production: 'https://hosting.api.zyno.app',
    alpha: 'https://hosting.api-alpha.zyno.dev',
    dev: 'http://localhost:39840'
};

const SUITE_API_URLS: Record<HostingEnvironment, string> = {
    production: 'https://suite.api.zyno.app',
    alpha: 'https://suite.api-alpha.zyno.dev',
    dev: 'http://localhost:39874'
};

const AUTH_API_URLS: Record<HostingEnvironment, string> = {
    production: 'https://auth.api.zyno.app',
    alpha: 'https://auth.api-alpha.zyno.dev',
    dev: 'http://localhost:39827'
};

export async function resolveConfig(
    overrides: ConfigOverrides = {},
    env: NodeJS.ProcessEnv = process.env,
    dependencies: ResolveConfigDependencies = {}
): Promise<ResolvedConfig> {
    return resolveConfigWithSource(overrides, env, dependencies, false);
}

export async function resolveSavedConfig(
    overrides: Pick<ConfigOverrides, 'apiUrl' | 'suiteApiUrl' | 'authApiUrl' | 'environment'> = {},
    env: NodeJS.ProcessEnv = process.env,
    dependencies: ResolveConfigDependencies = {}
): Promise<ResolvedConfig> {
    return resolveConfigWithSource(overrides, env, dependencies, true);
}

/** Resolves the saved credential of one specific profile, ignoring selection overrides and environment URLs. */
export async function resolveSavedProfile(
    key: string,
    env: NodeJS.ProcessEnv = process.env,
    dependencies: ResolveConfigDependencies = {}
): Promise<ResolvedConfig> {
    return resolveConfigWithSource({}, env, dependencies, true, key);
}

export function missingCredentialError(selectedKey: string, file: ConfigFile, action: 'login' | 'logout' = 'login'): CliError {
    const saved = Object.entries(file.profiles)
        .filter(([key, profile]) => key !== selectedKey && hasStoredCredential(profile))
        .map(([key]) => key);
    if (saved.length === 0) {
        return new CliError('Hosting credentials are not configured. Run `zynohosting login` or set ZYNOHOSTING_API_KEY.', 2, 'missing_config');
    }
    const first = saved[0]!;
    const flag = first.startsWith('url:') ? `--api-url ${describeProfileKey(first)}` : `--environment ${first}`;
    const advice = action === 'logout' ? `Pass ${flag}, or --all to log out of every login.` : `Pass ${flag}, or run \`zynohosting login\`.`;
    return new CliError(
        `Not signed in to ${describeProfileKey(selectedKey)}. Saved logins: ${saved.map(describeProfileKey).join(', ')}. ${advice}`,
        2,
        'missing_config'
    );
}

async function resolveConfigWithSource(
    overrides: ConfigOverrides,
    env: NodeJS.ProcessEnv,
    dependencies: ResolveConfigDependencies,
    savedOnly: boolean,
    forcedKey?: string
): Promise<ResolvedConfig> {
    const location = configLocation(env);
    const file = location.path;
    const configFile = await loadConfigFile(location);
    const preselected = forcedKey === undefined ? selectProfile(overrides, env) : undefined;
    const stored = configFile.profiles[forcedKey ?? preselected!.key] ?? {};
    const selection = preselected ?? selectionForKey(forcedKey!, stored);
    const apiUrl = selection.apiUrl;
    if (forcedKey !== undefined) {
        overrides = {};
        env = isolatedEnvironment(env);
    }
    const suiteApiUrl = resolveSuiteApiUrl(overrides.suiteApiUrl, stored, apiUrl, env, overrides.environment, hostingUrlChosenByFlag(overrides));
    const authApiUrl = resolveAuthApiUrl(overrides.authApiUrl, stored, apiUrl, env, overrides.environment, hostingUrlChosenByFlag(overrides));
    const overrideCredential = savedOnly ? undefined : credentialFrom(overrides, 'command options');
    const environmentCredential = savedOnly
        ? undefined
        : credentialFrom(
              {
                  ...(env.ZYNOHOSTING_API_KEY ? { apiKey: env.ZYNOHOSTING_API_KEY } : {}),
                  ...(env.ZYNOHOSTING_ACCESS_TOKEN ? { accessToken: env.ZYNOHOSTING_ACCESS_TOKEN } : {}),
                  ...(env.ZYNOHOSTING_TENANT_ID ? { tenantId: env.ZYNOHOSTING_TENANT_ID } : {}),
                  ...(env.ZYNOHOSTING_TOKEN_EXPIRES_AT ? { expiresAt: parseExpiration(env.ZYNOHOSTING_TOKEN_EXPIRES_AT) } : {})
              },
              'environment'
          );
    const storedCredential = overrideCredential || environmentCredential ? undefined : credentialFrom(stored, 'saved configuration');
    const credential = overrideCredential ?? environmentCredential ?? storedCredential;
    if (!credential) throw missingCredentialError(selection.key, configFile);

    if (credential === storedCredential && credential.type === 'bearer' && stored.renewalKey) {
        if (!authApiUrl) {
            throw new CliError(
                'The ZynoAuth API URL is required to renew this login. Pass --auth-api-url or set ZYNO_AUTH_API_URL.',
                2,
                'missing_auth_api_url'
            );
        }
        validateRenewalKey(stored.renewalKey);
        const renewalTokenStore = dependencies.renewalTokenStore ?? createSystemRenewalTokenStore();
        const scopedTokenClient = dependencies.scopedTokenClient?.(authApiUrl) ?? new ScopedTokenClient(authApiUrl);
        attachCredentialRefresh(credential, async () =>
            refreshStoredCredential({
                credential,
                location,
                profileKey: selection.key,
                renewalKey: stored.renewalKey!,
                renewalTokenStore,
                scopedTokenClient
            })
        );
    }
    await ensureFreshCredential(credential);
    return { apiUrl, ...(suiteApiUrl ? { suiteApiUrl } : {}), ...(authApiUrl ? { authApiUrl } : {}), credential };
}

export function resolveApiUrl(override: string | undefined, env: NodeJS.ProcessEnv = process.env, environmentOverride?: HostingEnvironment): string {
    return selectProfile({ ...(override ? { apiUrl: override } : {}), ...(environmentOverride ? { environment: environmentOverride } : {}) }, env)
        .apiUrl;
}

/**
 * Companion endpoint order: explicit flag, the `--environment` flag's defaults, the ZYNO_*_API_URL variable, the
 * ZYNOHOSTING_ENVIRONMENT variable's defaults, the saved profile URL, then the URL inferred from the Hosting API. An
 * environment's defaults only apply when the effective Hosting API URL belongs to it, so a flag always beats a variable.
 */
function resolveCompanionApiUrl(
    label: string,
    defaults: Record<HostingEnvironment, string>,
    override: string | undefined,
    variable: string | undefined,
    storedUrl: string | undefined,
    stored: StoredConfig,
    resolvedHostingApiUrl: string,
    env: NodeJS.ProcessEnv,
    environmentOverride: HostingEnvironment | undefined,
    hostingUrlFromFlag: boolean
): string | undefined {
    const forEnvironment = (value: string | undefined, lenient = false): string | undefined => {
        if (!value) return undefined;
        let environment: HostingEnvironment;
        try {
            environment = parseEnvironment(value);
        } catch (error) {
            // An invalid variable only matters when it selects the Hosting URL, which selectProfile reports.
            if (lenient) return undefined;
            throw error;
        }
        return API_URLS[environment] === resolvedHostingApiUrl ? defaults[environment] : undefined;
    };
    const inferred = (Object.entries(API_URLS) as [HostingEnvironment, string][]).find(([, hostingUrl]) => hostingUrl === resolvedHostingApiUrl)?.[0];
    const storedMatchesHosting = stored.apiUrl === undefined || stored.apiUrl.replace(/\/+$/, '') === resolvedHostingApiUrl;
    // A Hosting URL chosen by a flag is never redirected by a ZYNO_*_API_URL or ZYNOHOSTING_ENVIRONMENT variable.
    const result = hostingUrlFromFlag
        ? override || (inferred ? defaults[inferred] : undefined) || (storedMatchesHosting ? storedUrl : undefined)
        : override ||
          forEnvironment(environmentOverride) ||
          variable ||
          forEnvironment(env.ZYNOHOSTING_ENVIRONMENT, true) ||
          (storedMatchesHosting ? storedUrl : undefined) ||
          (inferred ? defaults[inferred] : undefined);
    return result === undefined ? undefined : normalizeApiUrl(result, label);
}

export function resolveSuiteApiUrl(
    override: string | undefined,
    stored: StoredConfig,
    resolvedHostingApiUrl: string,
    env: NodeJS.ProcessEnv = process.env,
    environmentOverride?: HostingEnvironment,
    hostingUrlFromFlag = false
): string | undefined {
    return resolveCompanionApiUrl(
        'Suite API',
        SUITE_API_URLS,
        override,
        env.ZYNO_SUITE_API_URL,
        stored.suiteApiUrl,
        stored,
        resolvedHostingApiUrl,
        env,
        environmentOverride,
        hostingUrlFromFlag
    );
}

export function resolveAuthApiUrl(
    override: string | undefined,
    stored: StoredConfig,
    resolvedHostingApiUrl: string,
    env: NodeJS.ProcessEnv = process.env,
    environmentOverride?: HostingEnvironment,
    hostingUrlFromFlag = false
): string | undefined {
    return resolveCompanionApiUrl(
        'Auth API',
        AUTH_API_URLS,
        override,
        env.ZYNO_AUTH_API_URL,
        stored.authApiUrl,
        stored,
        resolvedHostingApiUrl,
        env,
        environmentOverride,
        hostingUrlFromFlag
    );
}

async function writeConfigFile(config: ConfigFile, path: string): Promise<void> {
    const directory = dirname(path);
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    try {
        await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, path);
        if (process.platform !== 'win32') await chmod(path, 0o600);
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
}

function credentialFrom(config: StoredConfig, source: string): ManagerCredential | undefined {
    if (config.apiKey && config.accessToken) {
        throw new CliError(`${source} contains both an API key and a user access token`, 2, 'invalid_config');
    }
    if (config.apiKey) return { type: 'api-key', apiKey: config.apiKey };
    if (!config.accessToken) return undefined;
    return {
        type: 'bearer',
        accessToken: config.accessToken,
        ...(config.tenantId === undefined ? {} : { tenantId: config.tenantId }),
        ...(config.expiresAt === undefined ? {} : { expiresAt: config.expiresAt })
    };
}

interface RefreshStoredCredentialOptions {
    credential: BearerCredential;
    location: ConfigLocation;
    profileKey: string;
    renewalKey: string;
    renewalTokenStore: RenewalTokenStore;
    scopedTokenClient: Pick<ScopedTokenClient, 'renew'>;
}

async function refreshStoredCredential(options: RefreshStoredCredentialOptions): Promise<void> {
    // An older build renews the legacy file's login under that file's own lock but shares the same keychain entry.
    // Always take the legacy lock first, then the v2 lock, so the order never varies. Other writers only take the v2 lock.
    const { legacyPath } = options.location;
    if (legacyPath && (await legacyHoldsRenewalKey(legacyPath, options.renewalKey))) {
        await withRefreshLock(legacyPath, () => refreshUnderLocks(options));
        return;
    }
    await refreshUnderLocks(options);
}

async function legacyHoldsRenewalKey(legacyPath: string, renewalKey: string): Promise<boolean> {
    try {
        const value = JSON.parse(await readFile(legacyPath, 'utf8')) as unknown;
        return Boolean(value && typeof value === 'object' && !('version' in value) && (value as Record<string, unknown>).renewalKey === renewalKey);
    } catch {
        return false;
    }
}

async function refreshUnderLocks(options: RefreshStoredCredentialOptions): Promise<void> {
    await withRefreshLock(options.location.path, async () => {
        const latest = await loadStoredConfig(options.location, options.profileKey);
        if (latest.renewalKey !== options.renewalKey) {
            throw new CliError('The saved ZynoSuite login changed while it was being renewed. Retry the command.', 3, 'login_changed');
        }
        if (latest.accessToken && latest.expiresAt && latest.expiresAt > Date.now() + 5 * 60 * 1000) {
            options.credential.accessToken = latest.accessToken;
            options.credential.expiresAt = latest.expiresAt;
            if (latest.tenantId) options.credential.tenantId = latest.tenantId;
            return;
        }

        const renewalToken = await options.renewalTokenStore.get(options.renewalKey);
        if (!renewalToken) {
            throw new CliError('The saved ZynoSuite CLI renewal credential could not be found. Run `zynohosting login` again.', 3, 'renewal_missing');
        }
        const renewed = await options.scopedTokenClient.renew(renewalToken);
        await options.renewalTokenStore.set(options.renewalKey, renewed.renewalToken);

        options.credential.accessToken = renewed.jwt;
        options.credential.expiresAt = renewed.expiresAt;
        await updateProfileUnlocked(options.profileKey, { ...latest, accessToken: renewed.jwt, expiresAt: renewed.expiresAt }, options.location);
    });
}

async function withRefreshLock<T>(file: string, operation: () => Promise<T>, waitMs = 30_000): Promise<T> {
    const lockFile = `${file}.renew.lock`;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + waitMs;
    let handle: FileHandle | undefined;
    while (!handle) {
        try {
            handle = await open(lockFile, 'wx', 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const info = await stat(lockFile).catch(() => undefined);
            if (info && info.mtimeMs < Date.now() - 2 * 60 * 1000) {
                await rm(lockFile, { force: true });
                continue;
            }
            if (Date.now() >= deadline) {
                throw new CliError('Timed out waiting for another ZynoHosting CLI process that is updating saved logins.', 3, 'renewal_locked');
            }
            await delay(100);
        }
    }
    try {
        return await operation();
    } finally {
        try {
            await handle.close();
        } finally {
            await rm(lockFile, { force: true });
        }
    }
}

function validateRenewalKey(value: string): void {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
        throw new CliError('The saved renewal credential reference is invalid', 2, 'invalid_config');
    }
}

function parseExpiration(value: string): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result <= 0) {
        throw new CliError('ZYNOHOSTING_TOKEN_EXPIRES_AT must be an epoch-millisecond timestamp', 2, 'invalid_config');
    }
    return result;
}

function parseEnvironment(value: string): HostingEnvironment {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'production' || normalized === 'alpha' || normalized === 'dev') return normalized;
    throw new CliError(`Unknown Hosting environment: ${value}. Expected production, alpha, or dev.`, 2, 'invalid_environment');
}

export function normalizeApiUrl(value: string, service = 'Hosting API'): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new CliError(`Invalid ${service} URL: ${value}`, 2, 'invalid_config');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new CliError(`${service} URL cannot contain credentials, a query, or a fragment`, 2, 'invalid_config');
    }
    const localHttp = url.protocol === 'http:' && new Set(['localhost', '127.0.0.1', '[::1]']).has(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) {
        throw new CliError(`${service} URL must use HTTPS unless it points to localhost`, 2, 'invalid_config');
    }
    return url.toString().replace(/\/+$/, '');
}
