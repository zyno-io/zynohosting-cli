import type { ResolvedConfig } from '../config.js';

import { KeyRequestClient } from '../api/key-request-client.js';
import { ManagerClient } from '../api/manager-client.js';
import { CliError, HttpError } from '../errors.js';
import { DeployTokenInfo, DeployTokenSite, DeploymentTarget } from '../protocol.js';

export type KeyClientFactory = (authApiUrl: string) => Pick<KeyRequestClient, 'self'>;

/** The hosting manager's wording for a preview-only token on a PHP site. */
const PHP_PREVIEW_PREFIX = 'This site runs PHP, so preview code can reach production';

/**
 * The exact 403 messages the hosting manager uses when a deploy token's grants do not cover a request. An unknown site, another
 * tenant's site and an ungranted site all answer `is not bound to this site` (403, never 404).
 */
const TOKEN_DENIALS = [
    'deploy token is not bound to this site',
    'deploy token can only request deploy access scopes',
    'deploy token cannot perform this action',
    'deploy token does not allow this request',
    'This credential can only use its hosting grants'
];

export function isTokenDenial(message: string): boolean {
    return TOKEN_DENIALS.includes(message) || /^deploy token does not include the (production|preview) environment$/.test(message);
}

function requiresProduction(): CliError {
    return new CliError(
        'This site runs PHP, so preview code can reach production. A deploy token for this site must include production (use --production or --both).',
        3,
        'deploy_token_requires_production'
    );
}

/** Refuses, before anything is requested, a preview-only token for a site that runs PHP. */
export function assertTokenAllowedForSite(site: { phpVersion: string | null }, environments: readonly DeploymentTarget[]): void {
    if (site.phpVersion !== null && !environments.includes('production')) throw requiresProduction();
}

/** The names a token covers for a site: its primary hostname and aliases. Subdomain hostnames are never covered (hosting denies them). */
function siteNames(site: DeployTokenSite['site']): string[] {
    return [site.fqdn, ...(site.hostnames ?? []).filter(hostname => hostname.subdomainDirectory === undefined).map(hostname => hostname.name)];
}

/** The site grant of the token that `reference` (a site id or any hostname of the site) names. */
export function findTokenSite(info: DeployTokenInfo, reference: string): DeployTokenSite | undefined {
    const wanted = reference.trim().toLowerCase();
    return info.sites.find(entry => entry.siteId.toLowerCase() === wanted || siteNames(entry.site).some(name => name.toLowerCase() === wanted));
}

/** True when `reference` (a site id or hostname) names a site the token is granted. */
export function tokenCoversSite(info: DeployTokenInfo, reference: string): boolean {
    return findTokenSite(info, reference) !== undefined;
}

/** The primary hostnames of the sites a token covers, for messages. */
export function describeTokenSites(info: DeployTokenInfo): string {
    return info.sites.map(entry => entry.site.fqdn).join(', ');
}

/** An empty site list means every site the token was approved for was deleted or moved to another tenant. */
export function assertTokenHasSites(info: DeployTokenInfo): void {
    if (info.sites.length === 0) {
        throw new CliError(
            'This deploy token no longer covers any site: the site was deleted or transferred to another tenant after the token was approved. Create a new token with `zynohosting deploy-tokens create`.',
            3,
            'deploy_token_no_sites'
        );
    }
}

/** The error for a site the token does not cover. */
export function siteNotCovered(info: DeployTokenInfo, site: string): CliError {
    return new CliError(
        `This deploy token does not cover ${site}. It covers: ${describeTokenSites(info)}. Use the token created for that site.`,
        3,
        'deploy_token_wrong_site'
    );
}

/**
 * Reads what the deploy token allows and checks the request against it before anything is uploaded. `site` and
 * `environments` are what the command is about to touch. Returns the token's grant for that site.
 */
export async function verifyDeployToken(manager: ManagerClient, need: { site: string; environments?: DeploymentTarget[] }): Promise<DeployTokenSite> {
    const info = await manager.getDeployTokenInfo();
    assertTokenHasSites(info);
    const grant = findTokenSite(info, need.site);
    if (!grant) throw siteNotCovered(info, need.site);
    // The manager refuses a preview deploy by a preview-only token on a PHP site, so say why before any request.
    if (need.environments?.includes('preview')) assertTokenAllowedForSite(grant.site, grant.environments);
    for (const environment of need.environments ?? []) {
        if (!grant.environments.includes(environment)) {
            throw new CliError(
                `This deploy token cannot change ${environment} on ${grant.site.fqdn} (it allows ${grant.environments.join(' and ')}). Create a token that includes ${environment}.`,
                3,
                'deploy_token_wrong_environment'
            );
        }
    }
    return grant;
}

/** ZynoAuth answers `self` with 401 for an expired key and 403 for one that was revoked or never existed. Anything else is not a verdict. */
export function selfFailure(selfError: unknown): CliError | undefined {
    if (selfError instanceof HttpError && selfError.status === 401) {
        return new CliError('This deploy token has expired. Create a new one with `zynohosting deploy-tokens create`.', 3, 'deploy_token_expired');
    }
    if (selfError instanceof HttpError && selfError.status === 403) {
        return new CliError(
            'This deploy token has been revoked or is not valid. Create a new one with `zynohosting deploy-tokens create`.',
            3,
            'deploy_token_revoked'
        );
    }
    return undefined;
}

/**
 * Turns a 401 or 403 from a call made with a deploy token into a reason the person can act on, by asking the token about
 * itself. Any other error, or a credential that is not a deploy token, is rethrown unchanged.
 */
export async function diagnoseDeployToken(config: ResolvedConfig, error: unknown, makeClient?: KeyClientFactory): Promise<never> {
    if (
        config.credential.type !== 'deploy-token' ||
        !(error instanceof HttpError) ||
        (error.status !== 401 && error.status !== 403) ||
        !config.authApiUrl
    ) {
        throw error;
    }
    if (error.status === 403 && error.message.startsWith(PHP_PREVIEW_PREFIX)) throw requiresProduction();
    const client = makeClient?.(config.authApiUrl) ?? new KeyRequestClient(config.authApiUrl);
    try {
        await client.self(config.credential.token);
    } catch (selfError) {
        throw selfFailure(selfError) ?? error;
    }
    // The token is valid. Only an authorization denial is about what the token may do; any other 403 (the site is not
    // active, a transfer is in progress, ...) is the manager's own reason and is shown unchanged.
    if (error.status === 403 && isTokenDenial(error.message)) {
        throw new CliError(
            `This deploy token is valid but is not allowed to do that (${error.message}). It may be for a different site or environment.`,
            3,
            'deploy_token_denied'
        );
    }
    throw error;
}
