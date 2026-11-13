import type { StoredLogin } from './logins.js';

import { ScopedTokenClient } from '../api/scoped-token-client.js';
import { type ConfigTarget, loadConfigFile, mutateProfile, resolveAuthApiUrl, selectionForKey } from '../config.js';
import { createRenewalTokenStore, type RenewalTokenStore } from './renewal-token-store.js';

export interface RetireDependencies {
    /** Where ZynoAuth is, when known; without it no grant can be revoked. */
    authApiUrl?: string | undefined;
    configPath: string;
    renewalTokenStore?: RenewalTokenStore | undefined;
    scopedTokenClient?: ((authApiUrl: string) => Pick<ScopedTokenClient, 'revoke'> & Partial<Pick<ScopedTokenClient, 'renew'>>) | undefined;
    write?: ((message: string) => void) | undefined;
}

/**
 * Retires a login that was replaced or displaced: revoke its grant (best effort, never blocking), then delete its renewal
 * token. An expired access token is renewed first, as logout does, because revoking needs a live one.
 */
export async function retireLogin(previous: StoredLogin, dependencies: RetireDependencies): Promise<void> {
    const store = previous.renewalKey
        ? (dependencies.renewalTokenStore ?? createRenewalTokenStore(previous.renewalStore ?? 'system', dependencies.configPath))
        : undefined;
    const url = dependencies.authApiUrl;
    if (previous.scopedToken && previous.accessToken && url) {
        try {
            const client = dependencies.scopedTokenClient?.(url) ?? new ScopedTokenClient(url, 5_000);
            let accessToken = previous.accessToken;
            if (previous.expiresAt !== undefined && previous.expiresAt <= Date.now()) {
                const renewalToken = previous.renewalKey ? await store?.get(previous.renewalKey) : undefined;
                accessToken = renewalToken && client.renew ? (await client.renew(renewalToken)).jwt : '';
            }
            if (accessToken) await client.revoke(accessToken);
        } catch {
            // Best effort: the grant ends at its own expiry if it cannot be revoked now.
        }
    }
    if (previous.renewalKey && store) {
        try {
            await store.delete(previous.renewalKey);
        } catch {
            dependencies.write?.("Warning: a replaced login's renewal credential could not be removed from its credential store.\n");
        }
    }
}

/** Retires the logins a profile kept aside when two stored entries turned out to be the same account and tenant. */
export async function retireDisplacedLogins(
    profileKey: string,
    location: ConfigTarget,
    dependencies: Omit<RetireDependencies, 'authApiUrl'>
): Promise<void> {
    const profile = (await loadConfigFile(location, { lenientLegacy: true })).profiles[profileKey];
    const displaced = profile?.retiredLogins;
    if (!profile || !displaced?.length) return;
    const authApiUrl = resolveAuthApiUrl(undefined, profile, selectionForKey(profileKey, profile).apiUrl, {});
    for (const login of displaced) await retireLogin(login, { ...dependencies, authApiUrl });
    await mutateProfile(
        profileKey,
        current => {
            const { retiredLogins: _done, ...rest } = current;
            return rest;
        },
        location
    );
}
