import type { ResolvedConfig } from '../config.js';

import { KeyRequestClient } from '../api/key-request-client.js';
import { ManagerClient } from '../api/manager-client.js';
import { CliError, HttpError } from '../errors.js';
import { DeployTokenInfo, DeploymentTarget } from '../protocol.js';

export type KeyClientFactory = (authApiUrl: string) => Pick<KeyRequestClient, 'self'>;

/** The hosting manager's wording for a preview-only token on a PHP site. */
const PHP_PREVIEW_PREFIX = 'This site runs PHP, so preview code can reach production';

/** The exact 403 messages the hosting manager and the shared capability guard use when a token's grant does not cover a request. */
const CAPABILITY_DENIALS = [
    'capability keys cannot use this route',
    'capability key does not allow this request',
    'deploy token is not bound to this site',
    'deploy token can only request deploy access scopes',
    'deploy token cannot perform this action'
];

export function isCapabilityDenial(message: string): boolean {
    return CAPABILITY_DENIALS.includes(message) || /^deploy token does not include the (production|preview) environment$/.test(message);
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

/** True when `reference` (a site id or hostname) names the site the token is bound to. */
export function tokenCoversSite(info: DeployTokenInfo, reference: string): boolean {
    const wanted = reference.trim().toLowerCase();
    if (wanted === info.site.id.toLowerCase()) return true;
    const names = [info.site.fqdn, ...(info.site.hostnames ?? []).map(hostname => hostname.name)];
    return names.some(name => name.toLowerCase() === wanted);
}

/**
 * Reads what the deploy token allows and checks the request against it before anything is uploaded. `site` and
 * `environments` are what the command is about to touch.
 */
export async function verifyDeployToken(
    manager: ManagerClient,
    need: { site?: string | undefined; environments?: DeploymentTarget[] }
): Promise<DeployTokenInfo> {
    const info = await manager.getDeployTokenInfo();
    if (need.site !== undefined && !tokenCoversSite(info, need.site)) {
        throw new CliError(
            `This deploy token is for ${info.site.fqdn}, not ${need.site}. Use the token created for that site.`,
            3,
            'deploy_token_wrong_site'
        );
    }
    // The manager refuses a preview deploy by a preview-only token on a PHP site, so say why before any request.
    if (need.environments?.includes('preview')) assertTokenAllowedForSite(info.site, info.environments);
    for (const environment of need.environments ?? []) {
        if (!info.environments.includes(environment)) {
            throw new CliError(
                `This deploy token cannot change ${environment} (it allows ${info.environments.join(' and ')}). Create a token that includes ${environment}.`,
                3,
                'deploy_token_wrong_environment'
            );
        }
    }
    return info;
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
        // ZynoAuth answers 401 for an expired key and 403 for one that was revoked or never existed.
        if (selfError instanceof HttpError && selfError.status === 401) {
            throw new CliError('This deploy token has expired. Create a new one with `zynohosting deploy-tokens create`.', 3, 'deploy_token_expired');
        }
        if (selfError instanceof HttpError && selfError.status === 403) {
            throw new CliError(
                'This deploy token has been revoked or is not valid. Create a new one with `zynohosting deploy-tokens create`.',
                3,
                'deploy_token_revoked'
            );
        }
        throw error;
    }
    // The token is valid. Only an authorization denial is about what the token may do; any other 403 (the site is not
    // active, a transfer is in progress, ...) is the manager's own reason and is shown unchanged.
    if (error.status === 403 && isCapabilityDenial(error.message)) {
        throw new CliError(
            `This deploy token is valid but is not allowed to do that (${error.message}). It may be for a different site or environment.`,
            3,
            'deploy_token_wrong_environment'
        );
    }
    throw error;
}
