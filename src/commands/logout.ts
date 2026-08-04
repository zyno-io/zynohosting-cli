import { ScopedTokenClient } from '../api/scoped-token-client.js';
import { createSystemRenewalTokenStore, type RenewalTokenStore } from '../auth/renewal-token-store.js';
import {
    configPath,
    type HostingEnvironment,
    loadStoredConfig,
    resolveApiUrl,
    resolveAuthApiUrl,
    resolveSavedConfig,
    saveConfig,
    type StoredConfig
} from '../config.js';
import { CliError, HttpError } from '../errors.js';

export interface LogoutOptions {
    apiUrl?: string;
    suiteApiUrl?: string;
    authApiUrl?: string;
    environment?: HostingEnvironment;
}

export interface LogoutDependencies {
    env?: NodeJS.ProcessEnv;
    configFile?: string;
    write?: (message: string) => void;
    renewalTokenStore?: RenewalTokenStore;
    scopedTokenClient?: (apiUrl: string) => Pick<ScopedTokenClient, 'renew' | 'revoke'>;
}

export async function logout(options: LogoutOptions = {}, dependencies: LogoutDependencies = {}): Promise<void> {
    const baseEnv = dependencies.env ?? process.env;
    const file = dependencies.configFile ?? configPath(baseEnv);
    const env = { ...baseEnv, ZYNOHOSTING_CONFIG: file };
    const write = dependencies.write ?? (message => process.stdout.write(message));
    const stored = await loadStoredConfig(file);
    if (!stored.apiKey && !stored.accessToken && !stored.renewalKey) {
        write('ZynoHosting is already logged out.\n');
        return;
    }

    const apiUrl = resolveApiUrl(options.apiUrl, stored, env, options.environment);
    const authApiUrl = resolveAuthApiUrl(options.authApiUrl, stored, apiUrl, env, options.environment);
    const client = authApiUrl ? (dependencies.scopedTokenClient?.(authApiUrl) ?? new ScopedTokenClient(authApiUrl)) : undefined;
    const accessAlreadyExpired = stored.expiresAt !== undefined && stored.expiresAt <= Date.now() && !stored.renewalKey;
    if (stored.scopedToken && stored.accessToken && !accessAlreadyExpired) {
        if (!client || !authApiUrl) {
            throw new CliError(
                'The ZynoAuth API URL is required to revoke this login. Pass --auth-api-url or set ZYNO_AUTH_API_URL.',
                2,
                'missing_auth_api_url'
            );
        }
        try {
            let accessToken = stored.accessToken;
            if (stored.expiresAt !== undefined && stored.expiresAt <= Date.now()) {
                const resolved = await resolveSavedConfig(options, env, {
                    ...(dependencies.renewalTokenStore ? { renewalTokenStore: dependencies.renewalTokenStore } : {}),
                    scopedTokenClient: () => client
                });
                if (resolved.credential.type !== 'bearer') throw new CliError('The saved login is not a scoped token.', 2, 'invalid_config');
                accessToken = resolved.credential.accessToken;
            }
            await client.revoke(accessToken);
        } catch (error) {
            if (!isAlreadyUnusable(error)) throw error;
        }
    }

    const retained: StoredConfig = {
        ...(stored.apiUrl ? { apiUrl: stored.apiUrl } : {}),
        ...(stored.suiteApiUrl ? { suiteApiUrl: stored.suiteApiUrl } : {}),
        ...(stored.authApiUrl ? { authApiUrl: stored.authApiUrl } : {})
    };
    await saveConfig(retained, file);
    if (stored.renewalKey) {
        try {
            await (dependencies.renewalTokenStore ?? createSystemRenewalTokenStore()).delete(stored.renewalKey);
        } catch {
            write('Warning: the local renewal credential could not be removed, but it is no longer valid.\n');
        }
    }
    write('ZynoHosting logout complete.\n');
}

function isAlreadyUnusable(error: unknown): boolean {
    return (
        (error instanceof CliError && ['login_expired', 'renewal_invalid', 'renewal_missing'].includes(error.code)) ||
        (error instanceof HttpError && error.status === 401)
    );
}
