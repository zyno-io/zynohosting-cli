import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { createSystemRenewalTokenStore, type RenewalTokenStore } from '../auth/renewal-token-store.js';
import {
    configPath,
    type HostingEnvironment,
    loadStoredConfig,
    normalizeApiUrl,
    resolveApiUrl,
    resolveAuthApiUrl,
    resolveSuiteApiUrl,
    saveConfig
} from '../config.js';
import { CliError } from '../errors.js';
import { openUrl } from '../login/browser.js';
import { startLoopbackLogin } from '../login/loopback.js';
import {
    DELEGABLE_PERMISSION_KEYS,
    isDelegablePermissionKey,
    NON_DELEGABLE_PERMISSION_KEYS,
    PERMISSION_KEY_PATTERN,
    suggestPermissionKey
} from '../permissions.js';

const DEFAULT_ALPHA_LOGIN_URL = 'https://zyno.dev/cli/login';
const DEFAULT_DEV_LOGIN_URL = 'http://localhost:5173/cli/login';
const DEFAULT_PRODUCTION_LOGIN_URL = 'https://zyno.app/cli/login';
const DEFAULT_PERMISSION_KEYS = ['hosting.sitesRead'];

export interface LoginOptions {
    apiUrl?: string;
    suiteApiUrl?: string;
    authApiUrl?: string;
    environment?: HostingEnvironment;
    apiKey?: string;
    loginUrl?: string;
    name?: string;
    permissionKeys?: string[];
    renewable?: boolean;
    timeoutSeconds?: number;
    open?: boolean;
    /** Abandons an in-flight browser flow: closes the loopback listener and rejects with `login_cancelled`. */
    signal?: AbortSignal;
}

export interface LoginDependencies {
    env?: NodeJS.ProcessEnv;
    configFile?: string;
    openUrl?: (url: string) => Promise<void>;
    onBrowserUrl?: (url: string) => void | Promise<void>;
    write?: (message: string) => void;
    renewalTokenStore?: RenewalTokenStore;
}

export async function login(options: LoginOptions, dependencies: LoginDependencies = {}): Promise<void> {
    const env = dependencies.env ?? process.env;
    const file = dependencies.configFile ?? configPath(env);
    const stored = await loadStoredConfig(file);
    const apiUrl = resolveApiUrl(options.apiUrl, stored, env, options.environment);
    const suiteApiUrl = resolveSuiteApiUrl(options.suiteApiUrl, stored, apiUrl, env, options.environment);
    const authApiUrl = resolveAuthApiUrl(options.authApiUrl, stored, apiUrl, env, options.environment);
    const apiKey = options.apiKey ?? env.ZYNOHOSTING_API_KEY;
    const write = dependencies.write ?? (message => process.stdout.write(message));

    if (apiKey) {
        await saveConfig({ apiUrl, ...(suiteApiUrl ? { suiteApiUrl } : {}), ...(authApiUrl ? { authApiUrl } : {}), apiKey }, file);
        await removePreviousRenewalCredential(stored.renewalKey, dependencies.renewalTokenStore, write);
        write('ZynoHosting API-key credentials saved.\n');
        return;
    }

    const name = validateName(options.name ?? defaultClientName());
    const permissionKeys = validatePermissionKeys(options.permissionKeys ?? DEFAULT_PERMISSION_KEYS);
    const renewable = options.renewable ?? false;
    if (renewable && !authApiUrl) {
        throw new CliError(
            'The ZynoAuth API URL is required for a renewable login. Pass --auth-api-url or set ZYNO_AUTH_API_URL.',
            2,
            'missing_auth_api_url'
        );
    }
    let savedRenewableCredential = false;
    const loginPageUrl = resolveLoginPageUrl(options.loginUrl ?? env.ZYNOHOSTING_LOGIN_URL, apiUrl);
    if (options.signal?.aborted) throw new CliError('Browser login was cancelled', 3, 'login_cancelled');
    const loopback = await startLoopbackLogin({
        timeoutMs: Math.max(1, options.timeoutSeconds ?? 300) * 1000,
        renewable,
        onCredential: async credential => {
            const baseConfig = {
                apiUrl,
                ...(suiteApiUrl ? { suiteApiUrl } : {}),
                ...(authApiUrl ? { authApiUrl } : {}),
                accessToken: credential.accessToken,
                tenantId: credential.tenantId,
                expiresAt: credential.expiresAt,
                scopedToken: true as const
            };
            if (credential.renewalToken) {
                const store = dependencies.renewalTokenStore ?? createSystemRenewalTokenStore();
                const renewalKey = randomUUID();
                await store.set(renewalKey, credential.renewalToken);
                try {
                    await saveConfig({ ...baseConfig, renewalKey }, file);
                } catch (error) {
                    await store.delete(renewalKey).catch(() => {});
                    throw error;
                }
                await removePreviousRenewalCredential(stored.renewalKey, store, write, renewalKey);
                savedRenewableCredential = true;
            } else {
                await saveConfig(baseConfig, file);
                await removePreviousRenewalCredential(stored.renewalKey, dependencies.renewalTokenStore, write);
            }
        }
    });
    const cancel = () => void loopback.close();
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const browserUrl = new URL(loginPageUrl);
    browserUrl.searchParams.set('callback', loopback.callbackUrl);
    browserUrl.searchParams.set('state', loopback.state);
    browserUrl.searchParams.set('name', name);
    browserUrl.searchParams.set('permissions', permissionKeys.join(','));
    if (renewable) browserUrl.searchParams.set('renewable', '1');

    try {
        // Let programmatic callers return the one-time link to their user before attempting to
        // launch a browser. This is essential for an MCP host where browser launching can fail.
        await dependencies.onBrowserUrl?.(browserUrl.toString());
        write('Opening your browser to sign in to Zyno…\n');
        if (options.open === false) {
            write(`Open this URL to continue:\n${browserUrl.toString()}\n`);
        } else {
            try {
                await (dependencies.openUrl ?? openUrl)(browserUrl.toString());
            } catch {
                write(`The browser could not be opened automatically. Open this URL to continue:\n${browserUrl.toString()}\n`);
            }
        }

        await loopback.result;
        if (savedRenewableCredential) {
            write('ZynoHosting renewable login complete. The renewal credential was saved in your system credential store.\n');
        } else {
            write('ZynoHosting login complete.\n');
        }
    } finally {
        options.signal?.removeEventListener('abort', cancel);
        await loopback.close();
    }
}

function validateName(value: string): string {
    const result = value.trim();
    if (!result || result.length > 255 || /[\u0000-\u001f\u007f]/.test(result)) {
        throw new CliError('Login name must be 1–255 characters and cannot contain control characters.', 2, 'invalid_login_name');
    }
    return result;
}

function validatePermissionKeys(values: string[]): string[] {
    const result = [...new Set(values.map(value => value.trim()))];
    if (!result.length || result.length > 100 || result.some(value => !PERMISSION_KEY_PATTERN.test(value))) {
        throw new CliError(
            'Request 1–100 permissions in app.capability format, using a separate --permission option for each.',
            2,
            'invalid_permissions'
        );
    }
    const prohibited = result.find(value => NON_DELEGABLE_PERMISSION_KEYS.has(value));
    if (prohibited) throw new CliError(`${prohibited} cannot be delegated to a CLI token.`, 2, 'non_delegable_permission');
    const unknown = result.find(value => !isDelegablePermissionKey(value));
    if (unknown) {
        const suggestion = suggestPermissionKey(unknown);
        throw new CliError(
            `${unknown} is not a ZynoSuite permission.${suggestion ? ` Did you mean ${suggestion}?` : ''} Request only: ${DELEGABLE_PERMISSION_KEYS.join(', ')}.`,
            2,
            'unknown_permission'
        );
    }
    return result;
}

function defaultClientName(): string {
    return `ZynoHosting CLI/MCP — ${hostname()}`;
}

async function removePreviousRenewalCredential(
    renewalKey: string | undefined,
    configuredStore: RenewalTokenStore | undefined,
    write: (message: string) => void,
    replacementKey?: string
): Promise<void> {
    if (!renewalKey || renewalKey === replacementKey) return;
    try {
        await (configuredStore ?? createSystemRenewalTokenStore()).delete(renewalKey);
    } catch {
        write('Warning: the previous renewal credential could not be removed from your system credential store.\n');
    }
}

export function resolveLoginPageUrl(value: string | undefined, apiUrl: string): string {
    const normalized = normalizeApiUrl(value ?? defaultLoginPageUrl(apiUrl));
    const url = new URL(normalized);
    if (url.hash) throw new CliError('The SPA login URL cannot contain a fragment', 2, 'invalid_login_url');
    return normalized;
}

function defaultLoginPageUrl(apiUrl: string): string {
    const hostname = new URL(apiUrl).hostname;
    if (hostname === 'hosting.api-alpha.zyno.dev') return DEFAULT_ALPHA_LOGIN_URL;
    if (hostname === 'hosting.api.zyno.app') return DEFAULT_PRODUCTION_LOGIN_URL;
    if (new Set(['localhost', '127.0.0.1', '[::1]']).has(hostname)) return DEFAULT_DEV_LOGIN_URL;
    throw new CliError(
        'The SPA login URL is not configured for this Hosting API. Pass --login-url or set ZYNOHOSTING_LOGIN_URL.',
        2,
        'missing_login_url'
    );
}
