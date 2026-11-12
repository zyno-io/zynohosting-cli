import { ScopedTokenClient } from '../api/scoped-token-client.js';
import { createSystemRenewalTokenStore, type RenewalTokenStore } from '../auth/renewal-token-store.js';
import {
    type ConfigTarget,
    configLocation,
    describeProfileKey,
    hasStoredCredential,
    isolatedEnvironment,
    type HostingEnvironment,
    loadConfigFile,
    missingCredentialError,
    removeLegacyConfigIfMatching,
    hostingUrlChosenByFlag,
    resolveAuthApiUrl,
    resolveSavedConfig,
    resolveSavedProfile,
    selectionForKey,
    selectProfile,
    type StoredConfig,
    updateProfile
} from '../config.js';
import { CliError, HttpError } from '../errors.js';

export interface LogoutOptions {
    apiUrl?: string;
    suiteApiUrl?: string;
    authApiUrl?: string;
    environment?: HostingEnvironment;
    /** Log out of every saved profile instead of only the selected one. */
    all?: boolean;
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
    const location = dependencies.configFile ?? configLocation(baseEnv);
    const env = dependencies.configFile ? { ...baseEnv, ZYNOHOSTING_CONFIG: dependencies.configFile } : baseEnv;
    const write = dependencies.write ?? (message => process.stdout.write(message));
    const configFile = await loadConfigFile(location);
    const selectedKey = options.all ? undefined : selectProfile(options, env).key;
    const keys = selectedKey === undefined ? Object.keys(configFile.profiles) : [selectedKey];
    const targets = keys.filter(key => hasStoredCredential(configFile.profiles[key] ?? {}));
    if (targets.length === 0) {
        // Other saved logins mean the user probably selected the wrong environment; saying "already logged out" would mislead.
        if (selectedKey !== undefined && Object.values(configFile.profiles).some(hasStoredCredential)) {
            throw missingCredentialError(selectedKey, configFile, 'logout');
        }
        write('ZynoHosting is already logged out.\n');
        return;
    }

    let firstError: unknown;
    for (const key of targets) {
        try {
            await logoutProfile(key, configFile.profiles[key]!, location, env, options, dependencies, write, Boolean(options.all));
            write(`ZynoHosting logout complete${options.all ? ` for ${describeProfileKey(key)}` : ''}.\n`);
        } catch (error) {
            if (!options.all) throw error;
            firstError ??= error;
            write(`Could not log out of ${describeProfileKey(key)}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
    }
    if (firstError) throw firstError;
}

async function logoutProfile(
    key: string,
    stored: StoredConfig,
    location: ConfigTarget,
    env: NodeJS.ProcessEnv,
    options: LogoutOptions,
    dependencies: LogoutDependencies,
    write: (message: string) => void,
    isolated: boolean
): Promise<void> {
    const selection = selectionForKey(key, stored);
    // With --all every profile resolves its own URLs; selection overrides only describe the single selected one.
    const authApiUrl = isolated
        ? resolveAuthApiUrl(undefined, stored, selection.apiUrl, isolatedEnvironment(env))
        : resolveAuthApiUrl(options.authApiUrl, stored, selection.apiUrl, env, options.environment, hostingUrlChosenByFlag(options));
    const client = authApiUrl ? (dependencies.scopedTokenClient?.(authApiUrl) ?? new ScopedTokenClient(authApiUrl)) : undefined;
    const accessAlreadyExpired = stored.expiresAt !== undefined && stored.expiresAt <= Date.now() && !stored.renewalKey;
    if (stored.scopedToken && stored.accessToken && !accessAlreadyExpired) {
        if (!client || !authApiUrl) {
            throw new CliError(
                isolated
                    ? `The ZynoAuth API URL is required to revoke the ${describeProfileKey(key)} login, and --all does not accept one. Run \`zynohosting logout --api-url ${selection.apiUrl} --auth-api-url <url>\` for it.`
                    : 'The ZynoAuth API URL is required to revoke this login. Pass --auth-api-url or set ZYNO_AUTH_API_URL.',
                2,
                'missing_auth_api_url'
            );
        }
        try {
            let accessToken = stored.accessToken;
            if (stored.expiresAt !== undefined && stored.expiresAt <= Date.now()) {
                const renewalDependencies = {
                    ...(dependencies.renewalTokenStore ? { renewalTokenStore: dependencies.renewalTokenStore } : {}),
                    scopedTokenClient: () => client
                };
                const resolved = isolated
                    ? await resolveSavedProfile(key, env, renewalDependencies)
                    : await resolveSavedConfig(options, env, renewalDependencies);
                if (resolved.credential.type !== 'bearer') throw new CliError('The saved login is not a scoped token.', 2, 'invalid_config');
                accessToken = resolved.credential.accessToken;
            }
            await client.revoke(accessToken);
        } catch (error) {
            if (!isAlreadyUnusable(error)) throw error;
        }
    }

    await updateProfile(key, undefined, location);
    await removeLegacyConfigIfMatching(location, stored);
    if (stored.renewalKey) {
        try {
            await (dependencies.renewalTokenStore ?? createSystemRenewalTokenStore()).delete(stored.renewalKey);
        } catch {
            write('Warning: the local renewal credential could not be removed, but it is no longer valid.\n');
        }
    }
}

function isAlreadyUnusable(error: unknown): boolean {
    return (
        (error instanceof CliError && ['login_expired', 'renewal_invalid', 'renewal_missing'].includes(error.code)) ||
        (error instanceof HttpError && error.status === 401)
    );
}
