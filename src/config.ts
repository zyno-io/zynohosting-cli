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

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
    if (env.ZYNO_HOSTING_CONFIG) return env.ZYNO_HOSTING_CONFIG;
    if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Zyno', 'hosting-cli.json');
    return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'zyno', 'hosting-cli.json');
}

export async function loadStoredConfig(path = configPath()): Promise<StoredConfig> {
    try {
        const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('config must be an object');
        const object = value as Record<string, unknown>;
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
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw new CliError(`Could not read config at ${path}: ${error instanceof Error ? error.message : String(error)}`, 2, 'invalid_config');
    }
}

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

async function resolveConfigWithSource(
    overrides: ConfigOverrides,
    env: NodeJS.ProcessEnv,
    dependencies: ResolveConfigDependencies,
    savedOnly: boolean
): Promise<ResolvedConfig> {
    const file = configPath(env);
    const stored = await loadStoredConfig(file);
    const apiUrl = resolveApiUrl(overrides.apiUrl, stored, env, overrides.environment);
    const suiteApiUrl = resolveSuiteApiUrl(overrides.suiteApiUrl, stored, apiUrl, env, overrides.environment);
    const authApiUrl = resolveAuthApiUrl(overrides.authApiUrl, stored, apiUrl, env, overrides.environment);
    const overrideCredential = savedOnly ? undefined : credentialFrom(overrides, 'command options');
    const environmentCredential = savedOnly
        ? undefined
        : credentialFrom(
              {
                  ...(env.ZYNO_HOSTING_API_KEY ? { apiKey: env.ZYNO_HOSTING_API_KEY } : {}),
                  ...(env.ZYNO_HOSTING_ACCESS_TOKEN ? { accessToken: env.ZYNO_HOSTING_ACCESS_TOKEN } : {}),
                  ...(env.ZYNO_HOSTING_TENANT_ID ? { tenantId: env.ZYNO_HOSTING_TENANT_ID } : {}),
                  ...(env.ZYNO_HOSTING_TOKEN_EXPIRES_AT ? { expiresAt: parseExpiration(env.ZYNO_HOSTING_TOKEN_EXPIRES_AT) } : {})
              },
              'environment'
          );
    const storedCredential = overrideCredential || environmentCredential ? undefined : credentialFrom(stored, 'saved configuration');
    const credential = overrideCredential ?? environmentCredential ?? storedCredential;
    if (!credential) {
        throw new CliError('Hosting credentials are not configured. Run `zynohosting login` or set ZYNO_HOSTING_API_KEY.', 2, 'missing_config');
    }

    if (credential === storedCredential && credential.type === 'bearer' && stored.renewalKey) {
        if (!authApiUrl) {
            throw new CliError(
                'The Zyno Auth API URL is required to renew this login. Pass --auth-api-url or set ZYNO_AUTH_API_URL.',
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
                file,
                renewalKey: stored.renewalKey!,
                renewalTokenStore,
                scopedTokenClient
            })
        );
    }
    await ensureFreshCredential(credential);
    return { apiUrl, ...(suiteApiUrl ? { suiteApiUrl } : {}), ...(authApiUrl ? { authApiUrl } : {}), credential };
}

export function resolveApiUrl(
    override: string | undefined,
    stored: StoredConfig,
    env: NodeJS.ProcessEnv = process.env,
    environmentOverride?: HostingEnvironment
): string {
    const environmentValue = environmentOverride ?? env.ZYNO_HOSTING_ENVIRONMENT;
    const environment = environmentValue === undefined ? undefined : parseEnvironment(environmentValue);
    const apiUrl = override ?? env.ZYNO_HOSTING_API_URL ?? (environment ? API_URLS[environment] : stored.apiUrl) ?? API_URLS.production;
    return normalizeApiUrl(apiUrl);
}

export function resolveSuiteApiUrl(
    override: string | undefined,
    stored: StoredConfig,
    resolvedHostingApiUrl: string,
    env: NodeJS.ProcessEnv = process.env,
    environmentOverride?: HostingEnvironment
): string | undefined {
    const environmentValue = environmentOverride ?? env.ZYNO_HOSTING_ENVIRONMENT;
    const environment = environmentValue === undefined ? undefined : parseEnvironment(environmentValue);
    const inferred = Object.entries(API_URLS).find(([, hostingUrl]) => hostingUrl === resolvedHostingApiUrl)?.[0] as HostingEnvironment | undefined;
    const storedMatchesHosting = stored.apiUrl === undefined || stored.apiUrl.replace(/\/+$/, '') === resolvedHostingApiUrl;
    const suiteApiUrl =
        override ??
        env.ZYNO_SUITE_API_URL ??
        (environment ? SUITE_API_URLS[environment] : storedMatchesHosting ? stored.suiteApiUrl : undefined) ??
        (inferred ? SUITE_API_URLS[inferred] : undefined);
    return suiteApiUrl === undefined ? undefined : normalizeApiUrl(suiteApiUrl, 'Suite API');
}

export function resolveAuthApiUrl(
    override: string | undefined,
    stored: StoredConfig,
    resolvedHostingApiUrl: string,
    env: NodeJS.ProcessEnv = process.env,
    environmentOverride?: HostingEnvironment
): string | undefined {
    const environmentValue = environmentOverride ?? env.ZYNO_HOSTING_ENVIRONMENT;
    const environment = environmentValue === undefined ? undefined : parseEnvironment(environmentValue);
    const inferred = Object.entries(API_URLS).find(([, hostingUrl]) => hostingUrl === resolvedHostingApiUrl)?.[0] as HostingEnvironment | undefined;
    const storedMatchesHosting = stored.apiUrl === undefined || stored.apiUrl.replace(/\/+$/, '') === resolvedHostingApiUrl;
    const authApiUrl =
        override ??
        env.ZYNO_AUTH_API_URL ??
        (environment ? AUTH_API_URLS[environment] : storedMatchesHosting ? stored.authApiUrl : undefined) ??
        (inferred ? AUTH_API_URLS[inferred] : undefined);
    return authApiUrl === undefined ? undefined : normalizeApiUrl(authApiUrl, 'Auth API');
}

export async function saveConfig(config: StoredConfig, path = configPath()): Promise<void> {
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
    file: string;
    renewalKey: string;
    renewalTokenStore: RenewalTokenStore;
    scopedTokenClient: Pick<ScopedTokenClient, 'renew'>;
}

async function refreshStoredCredential(options: RefreshStoredCredentialOptions): Promise<void> {
    await withRefreshLock(options.file, async () => {
        const latest = await loadStoredConfig(options.file);
        if (latest.renewalKey !== options.renewalKey) {
            throw new CliError('The saved Zyno login changed while it was being renewed. Retry the command.', 3, 'login_changed');
        }
        if (latest.accessToken && latest.expiresAt && latest.expiresAt > Date.now() + 5 * 60 * 1000) {
            options.credential.accessToken = latest.accessToken;
            options.credential.expiresAt = latest.expiresAt;
            if (latest.tenantId) options.credential.tenantId = latest.tenantId;
            return;
        }

        const renewalToken = await options.renewalTokenStore.get(options.renewalKey);
        if (!renewalToken) {
            throw new CliError('The saved Zyno CLI renewal credential could not be found. Run `zynohosting login` again.', 3, 'renewal_missing');
        }
        const renewed = await options.scopedTokenClient.renew(renewalToken);
        await options.renewalTokenStore.set(options.renewalKey, renewed.renewalToken);

        options.credential.accessToken = renewed.jwt;
        options.credential.expiresAt = renewed.expiresAt;
        await saveConfig({ ...latest, accessToken: renewed.jwt, expiresAt: renewed.expiresAt }, options.file);
    });
}

async function withRefreshLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
    const lockFile = `${file}.renew.lock`;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 30_000;
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
                throw new CliError('Timed out waiting for another Zyno CLI process to finish renewing the login.', 3, 'renewal_locked');
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
        throw new CliError('ZYNO_HOSTING_TOKEN_EXPIRES_AT must be an epoch-millisecond timestamp', 2, 'invalid_config');
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
