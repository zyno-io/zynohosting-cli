import { stat } from 'node:fs/promises';

import { ScopedTokenClient } from '../api/scoped-token-client.js';
import { createFileRenewalTokenStore, tokenFilePath } from '../auth/file-renewal-token-store.js';
import { describeEntry, hasStoredCredential, loginEntries, selectEntry, withoutEntry, type LoginEntry } from '../auth/logins.js';
import { createRenewalTokenStore, type RenewalTokenStore } from '../auth/renewal-token-store.js';
import {
    type ConfigTarget,
    configLocation,
    describeProfileKey,
    hostingUrlChosenByFlag,
    isolatedEnvironment,
    type HostingEnvironment,
    loadConfigFile,
    missingCredentialError,
    mutateProfile,
    removeLegacyConfigIfMatching,
    resolveAuthApiUrl,
    resolveSavedConfig,
    resolveSavedProfile,
    selectionForKey,
    selectProfile,
    type StoredConfig
} from '../config.js';
import { CliError, HttpError } from '../errors.js';

export interface LogoutOptions {
    apiUrl?: string;
    suiteApiUrl?: string;
    authApiUrl?: string;
    environment?: HostingEnvironment;
    /** Tenant name or id of the login to remove, instead of the active one. */
    tenant?: string;
    /** Log out of every login in every saved profile. */
    all?: boolean;
}

export interface LogoutDependencies {
    env?: NodeJS.ProcessEnv;
    configFile?: string;
    write?: (message: string) => void;
    renewalTokenStore?: RenewalTokenStore;
    scopedTokenClient?: (apiUrl: string) => Pick<ScopedTokenClient, 'renew' | 'revoke'> & Partial<Pick<ScopedTokenClient, 'cancelDevice'>>;
}

// A token stored by a login that has not yet written its profile must survive a concurrent logout.
const PRUNE_MIN_AGE_MS = 60 * 60 * 1000;

export async function logout(options: LogoutOptions = {}, dependencies: LogoutDependencies = {}): Promise<void> {
    const baseEnv = dependencies.env ?? process.env;
    const location = dependencies.configFile ?? configLocation(baseEnv);
    const env = dependencies.configFile ? { ...baseEnv, ZYNOHOSTING_CONFIG: dependencies.configFile } : baseEnv;
    const write = dependencies.write ?? (message => process.stdout.write(message));
    const configFile = await loadConfigFile(location);

    const targets: { key: string; entry: LoginEntry }[] = [];
    if (options.all) {
        for (const [key, profile] of Object.entries(configFile.profiles)) {
            for (const entry of loginEntries(profile)) targets.push({ key, entry });
        }
    } else {
        const selectedKey = selectProfile(options, env).key;
        const entry = selectEntry(configFile.profiles[selectedKey] ?? {}, options.tenant ?? env.ZYNOHOSTING_TENANT, describeProfileKey(selectedKey));
        if (entry) targets.push({ key: selectedKey, entry });
        else if (Object.values(configFile.profiles).some(hasStoredCredential)) {
            // Other saved logins mean the user probably selected the wrong environment; saying "already logged out" would mislead.
            throw missingCredentialError(selectedKey, configFile, 'logout');
        }
    }
    const pendingKeys = options.all ? Object.keys(configFile.profiles).filter(key => configFile.profiles[key]?.pendingDeviceLogin) : [];
    if (targets.length === 0 && pendingKeys.length === 0) {
        write('ZynoHosting is already logged out.\n');
        return;
    }

    let firstError: unknown;
    for (const { key, entry } of targets) {
        try {
            await logoutEntry(key, configFile.profiles[key]!, entry, location, env, options, dependencies, write, Boolean(options.all));
            write(
                options.all || loginEntries(configFile.profiles[key]!).length > 1
                    ? `ZynoHosting logout complete for ${describeEntry(entry)} on ${describeProfileKey(key)}.\n`
                    : 'ZynoHosting logout complete.\n'
            );
        } catch (error) {
            if (!options.all) throw error;
            firstError ??= error;
            write(
                `Could not log out of ${describeEntry(entry)} on ${describeProfileKey(key)}: ${error instanceof Error ? error.message : String(error)}\n`
            );
        }
    }
    for (const key of pendingKeys) await dropPendingDeviceLogin(key, configFile.profiles[key]!, location, dependencies);
    await pruneTokenFile(location, dependencies);
    if (firstError) throw firstError;
}

async function logoutEntry(
    key: string,
    stored: StoredConfig,
    entry: LoginEntry,
    location: ConfigTarget,
    env: NodeJS.ProcessEnv,
    options: LogoutOptions,
    dependencies: LogoutDependencies,
    write: (message: string) => void,
    isolated: boolean
): Promise<void> {
    const login = entry.login;
    const selection = selectionForKey(key, stored);
    // With --all every profile resolves its own URLs; selection overrides only describe the single selected one.
    const authApiUrl = isolated
        ? resolveAuthApiUrl(undefined, stored, selection.apiUrl, isolatedEnvironment(env))
        : resolveAuthApiUrl(options.authApiUrl, stored, selection.apiUrl, env, options.environment, hostingUrlChosenByFlag(options));
    const configPath = typeof location === 'string' ? location : location.path;
    const store = (): RenewalTokenStore => dependencies.renewalTokenStore ?? createRenewalTokenStore(login?.renewalStore ?? 'system', configPath);

    if (login) {
        const client = authApiUrl ? (dependencies.scopedTokenClient?.(authApiUrl) ?? new ScopedTokenClient(authApiUrl)) : undefined;
        const accessAlreadyExpired = login.expiresAt !== undefined && login.expiresAt <= Date.now() && !login.renewalKey;
        if (login.scopedToken && login.accessToken && !accessAlreadyExpired) {
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
                let accessToken = login.accessToken;
                if (login.expiresAt !== undefined && login.expiresAt <= Date.now()) {
                    const renewalDependencies = {
                        ...(dependencies.renewalTokenStore ? { renewalTokenStore: dependencies.renewalTokenStore } : {}),
                        scopedTokenClient: () => client
                    };
                    const resolved = isolated
                        ? await resolveSavedProfile(key, entry.id, env, renewalDependencies)
                        : await resolveSavedConfig({ ...options, tenant: entry.id }, env, renewalDependencies);
                    if (resolved.credential.type !== 'bearer') throw new CliError('The saved login is not a scoped token.', 2, 'invalid_config');
                    accessToken = resolved.credential.accessToken;
                }
                await client.revoke(accessToken);
            } catch (error) {
                if (!isAlreadyUnusable(error)) throw error;
            }
        }
    }

    // Remove the entry only if it is still the one that was revoked: a same-tenant login saved in the meantime must survive.
    let replaced = false;
    await mutateProfile(
        key,
        current => {
            const now = loginEntries(current).find(candidate => candidate.id === entry.id);
            const unchanged = entry.login
                ? // A renewal during logout rotates the access token but keeps the renewal key, so the key identifies the login.
                  now?.login !== undefined &&
                  (entry.login.renewalKey ? now.login.renewalKey === entry.login.renewalKey : now.login.accessToken === entry.login.accessToken)
                : now?.kind === 'api-key' && current.apiKey === stored.apiKey;
            if (!unchanged) {
                replaced = true;
                return current;
            }
            const next = withoutEntry(current, entry);
            return hasStoredCredential(next) || next.pendingDeviceLogin ? next : undefined;
        },
        location
    );
    if (replaced) return;
    await removeLegacyConfigIfMatching(location, entry.login ? { logins: { [entry.id]: entry.login } } : { apiKey: stored.apiKey! });
    if (login?.renewalKey) {
        try {
            await store().delete(login.renewalKey);
        } catch {
            write('Warning: the local renewal credential could not be removed, but it is no longer valid.\n');
        }
    }
}

/** Drops a started-but-never-finished device sign-in: the server is told, best effort, and the saved record is removed. */
async function dropPendingDeviceLogin(key: string, stored: StoredConfig, location: ConfigTarget, dependencies: LogoutDependencies): Promise<void> {
    const pending = stored.pendingDeviceLogin;
    if (!pending) return;
    try {
        const client = dependencies.scopedTokenClient?.(pending.authApiUrl) ?? new ScopedTokenClient(pending.authApiUrl);
        await client.cancelDevice?.(pending.deviceCode);
    } catch {
        // The code expires on its own within minutes.
    }
    await mutateProfile(
        key,
        current => {
            const { pendingDeviceLogin: _pending, ...rest } = current;
            return hasStoredCredential(rest) ? rest : undefined;
        },
        location
    );
}

/** Removes token-file entries that no profile references any more (for example after a crash), once they are old enough to be orphans. */
async function pruneTokenFile(location: ConfigTarget, dependencies: LogoutDependencies): Promise<void> {
    if (dependencies.renewalTokenStore) return;
    const configPath = typeof location === 'string' ? location : location.path;
    try {
        await stat(tokenFilePath(configPath));
        const file = await loadConfigFile(location);
        const referenced = new Set<string>();
        for (const profile of Object.values(file.profiles)) {
            for (const login of Object.values(profile.logins ?? {})) if (login.renewalKey) referenced.add(login.renewalKey);
        }
        await createFileRenewalTokenStore(configPath).prune(referenced, PRUNE_MIN_AGE_MS);
    } catch {
        // Housekeeping only; a missing or unreadable token file must not fail a logout that already succeeded.
    }
}

function isAlreadyUnusable(error: unknown): boolean {
    return (
        (error instanceof CliError && ['login_expired', 'renewal_invalid', 'renewal_missing', 'grant_expired'].includes(error.code)) ||
        (error instanceof HttpError && error.status === 401)
    );
}
