import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { CliError } from './errors.js';

export interface StoredConfig {
    apiUrl?: string;
    apiKey?: string;
    accessToken?: string;
    tenantId?: string;
    expiresAt?: number;
}

export interface ApiKeyCredential {
    type: 'api-key';
    apiKey: string;
}

export interface BearerCredential {
    type: 'bearer';
    accessToken: string;
    tenantId: string;
    expiresAt?: number;
}

export type ManagerCredential = ApiKeyCredential | BearerCredential;
export type HostingEnvironment = 'production' | 'alpha' | 'dev';

export interface ConfigOverrides extends StoredConfig {
    environment?: HostingEnvironment;
}

export interface ResolvedConfig {
    apiUrl: string;
    credential: ManagerCredential;
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
            ...(typeof object.apiKey === 'string' ? { apiKey: object.apiKey } : {}),
            ...(typeof object.accessToken === 'string' ? { accessToken: object.accessToken } : {}),
            ...(typeof object.tenantId === 'string' ? { tenantId: object.tenantId } : {}),
            ...(typeof object.expiresAt === 'number' ? { expiresAt: object.expiresAt } : {})
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

export async function resolveConfig(overrides: ConfigOverrides = {}, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedConfig> {
    const stored = await loadStoredConfig(configPath(env));
    const apiUrl = resolveApiUrl(overrides.apiUrl, stored, env, overrides.environment);
    const overrideCredential = credentialFrom(overrides, 'command options');
    const environmentCredential = credentialFrom(
        {
            ...(env.ZYNO_HOSTING_API_KEY ? { apiKey: env.ZYNO_HOSTING_API_KEY } : {}),
            ...(env.ZYNO_HOSTING_ACCESS_TOKEN ? { accessToken: env.ZYNO_HOSTING_ACCESS_TOKEN } : {}),
            ...(env.ZYNO_HOSTING_TENANT_ID ? { tenantId: env.ZYNO_HOSTING_TENANT_ID } : {}),
            ...(env.ZYNO_HOSTING_TOKEN_EXPIRES_AT ? { expiresAt: parseExpiration(env.ZYNO_HOSTING_TOKEN_EXPIRES_AT) } : {})
        },
        'environment'
    );
    const credential = overrideCredential ?? environmentCredential ?? credentialFrom(stored, 'saved configuration');
    if (!credential) {
        throw new CliError('Hosting credentials are not configured. Run `zynohosting login` or set ZYNO_HOSTING_API_KEY.', 2, 'missing_config');
    }
    if (credential.type === 'bearer' && credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
        throw new CliError('Your Zyno login has expired. Run `zynohosting login` again.', 3, 'login_expired');
    }
    return { apiUrl, credential };
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

export async function saveConfig(config: StoredConfig, path = configPath()): Promise<void> {
    const directory = dirname(path);
    const temporary = `${path}.tmp.${process.pid}`;
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
    if (!config.tenantId) {
        throw new CliError(`${source} provides a user access token without a tenant ID`, 2, 'invalid_config');
    }
    return {
        type: 'bearer',
        accessToken: config.accessToken,
        tenantId: config.tenantId,
        ...(config.expiresAt === undefined ? {} : { expiresAt: config.expiresAt })
    };
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

export function normalizeApiUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new CliError(`Invalid Hosting API URL: ${value}`, 2, 'invalid_config');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new CliError('Hosting API URL cannot contain credentials, a query, or a fragment', 2, 'invalid_config');
    }
    const localHttp = url.protocol === 'http:' && new Set(['localhost', '127.0.0.1', '[::1]']).has(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) {
        throw new CliError('Hosting API URL must use HTTPS unless it points to localhost', 2, 'invalid_config');
    }
    return url.toString().replace(/\/+$/, '');
}
