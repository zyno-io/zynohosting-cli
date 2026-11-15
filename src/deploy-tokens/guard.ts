import type { ResolvedConfig } from '../config.js';

import { KeyRequestClient } from '../api/key-request-client.js';
import { ManagerClient } from '../api/manager-client.js';
import { CliError, HttpError } from '../errors.js';
import { DeployTokenInfo, DeploymentTarget } from '../protocol.js';

export type KeyClientFactory = (authApiUrl: string) => Pick<KeyRequestClient, 'self'>;

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
    const client = makeClient?.(config.authApiUrl) ?? new KeyRequestClient(config.authApiUrl);
    const expired = (): CliError =>
        new CliError('This deploy token has expired. Create a new one with `zynohosting deploy-tokens create`.', 3, 'deploy_token_expired');
    try {
        const self = await client.self(config.credential.token);
        if (self.expiresAt !== undefined && self.expiresAt <= Date.now()) throw expired();
    } catch (selfError) {
        if (selfError instanceof CliError && selfError.code === 'deploy_token_expired') throw selfError;
        if (selfError instanceof HttpError && (selfError.status === 401 || selfError.status === 403)) {
            if (/expired/i.test(selfError.message)) throw expired();
            throw new CliError(
                'This deploy token has been revoked or is no longer valid. Create a new one with `zynohosting deploy-tokens create`.',
                3,
                'deploy_token_revoked'
            );
        }
        throw error;
    }
    if (error.status === 403) {
        throw new CliError(
            'This deploy token is valid but is not allowed to do that (a different site or environment than it was created for).',
            3,
            'deploy_token_wrong_environment'
        );
    }
    throw error;
}
