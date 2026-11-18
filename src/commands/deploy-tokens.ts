import { hostname } from 'node:os';

import type { KeyDelivery, KeyEnvironment, KeyRequestInput, KeyRequestPoll, KeyRequestStart } from '../api/key-request-client.js';
import type { PendingKeyRequest, StoredHandoff } from '../auth/logins.js';
import type { ConfigOverrides, ResolvedConfig } from '../config.js';
import type { Handoff, HandoffDependencies } from '../deploy-tokens/handoff.js';
import type { LoginFlow } from '../login/flow.js';

import { ApiKeySummary, KeyRequestClient } from '../api/key-request-client.js';
import { ManagerClient } from '../api/manager-client.js';
import { configLocation, describeProfileKey, loadConfigFile, mutateProfile, resolveConfig, selectProfile } from '../config.js';
import { assertTokenAllowedForSite, diagnoseDeployToken, selfFailure } from '../deploy-tokens/guard.js';
import {
    DEFAULT_SECRET_NAME,
    deliverSecret,
    describeHandoff,
    type HandoffPreflight,
    handoffKind,
    handoffTarget,
    preflightHandoff,
    redactSecret,
    validateHandoff
} from '../deploy-tokens/handoff.js';
import { CliError } from '../errors.js';
import { openUrl } from '../login/browser.js';
import { type ApprovalPoll, pollApproval } from '../login/device.js';
import { chooseLoginFlow } from '../login/flow.js';
import { normalizeSiteRef } from './deploy-site.js';

/** Lifetimes the approver can choose from; the server decides which are allowed. */
export const KEY_LIFETIMES = { '30d': 2_592_000, '90d': 7_776_000, '180d': 15_552_000, '365d': 31_536_000 } as const;

export interface DeployTokenCreateOptions extends ConfigOverrides {
    production?: boolean;
    preview?: boolean;
    both?: boolean;
    /** Extra permission keys for the token (for example `hosting.sitesRead`), each a separate `--permission`. */
    permission?: string[];
    lifetime?: string;
    github?: string;
    githubEnvironment?: string;
    gitlab?: string;
    file?: string;
    /** The secret or variable name at the destination. */
    name?: string;
    noWait?: boolean;
    resume?: boolean;
    /** false never opens a browser. */
    open?: boolean;
    timeoutSeconds?: number;
    json?: boolean;
    /** Cancel the request on Ctrl+C. For the CLI only. */
    handleSigint?: boolean;
    signal?: AbortSignal;
}

export interface DeployTokenDependencies extends HandoffDependencies {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    openUrl?: (url: string) => Promise<void>;
    write?: (message: string) => void;
    emit?: (event: Record<string, unknown>) => void;
    warn?: (message: string) => void;
}

export type DeployTokenCreateResult =
    | { status: 'pending'; site: string; userCode: string; verificationUri: string; expiresAt: string; permissions: string[] }
    | {
          status: 'created';
          site: string;
          siteId: string;
          environments: KeyEnvironment[];
          keyId?: string;
          preview?: string;
          permissionKeys?: string[];
          expiresAt?: string;
          destination: string;
          warnings: string[];
      };

type ApprovedKey = Extract<KeyRequestPoll, { status: 'approved' }>;

function context(options: { json?: boolean | undefined }, dependencies: DeployTokenDependencies) {
    const json = options.json ?? false;
    const env = dependencies.env ?? process.env;
    const write =
        dependencies.write ?? (json ? (message: string) => process.stderr.write(message) : (message: string) => process.stdout.write(message));
    const emit = (event: Record<string, unknown>): void => {
        if (!json) return;
        if (dependencies.emit) dependencies.emit(event);
        else process.stdout.write(`${JSON.stringify(event)}\n`);
    };
    const warn = (code: string, message: string): void => {
        (dependencies.warn ?? ((text: string) => process.stderr.write(text)))(`Warning: ${message}\n`);
        emit({ type: 'warning', code, message });
    };
    return { json, env, write, emit, warn };
}

function environmentsFrom(options: Pick<DeployTokenCreateOptions, 'production' | 'preview' | 'both'>): KeyEnvironment[] {
    const chosen = [options.production, options.preview, options.both].filter(Boolean).length;
    if (chosen === 0) {
        throw new CliError('Say which environment the token may deploy to: --production, --preview, or --both.', 2, 'invalid_input');
    }
    if (chosen > 1) throw new CliError('Choose one of --production, --preview, or --both.', 2, 'invalid_input');
    return options.both ? ['preview', 'production'] : options.preview ? ['preview'] : ['production'];
}

/** A permission key (`hosting.sitesRead`) or a bare app (`hosting`). Checked loosely here; ZynoAuth knows the real catalogue. */
const PERMISSION_KEY = /^[a-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/;

function permissionsFrom(values: readonly string[] | undefined): string[] {
    const keys = [...new Set((values ?? []).map(value => value.trim()))];
    if (keys.length > 100) throw new CliError('Give at most 100 --permission options.', 2, 'invalid_input');
    for (const key of keys) {
        if (key.length > 100 || !PERMISSION_KEY.test(key)) {
            throw new CliError(`Invalid --permission "${key.slice(0, 60)}"; use a permission key such as hosting.sitesRead.`, 2, 'invalid_input');
        }
    }
    return keys;
}

function handoffFrom(options: DeployTokenCreateOptions): Handoff {
    const targets = [options.github, options.gitlab, options.file].filter(value => value !== undefined).length;
    if (targets > 1) throw new CliError('Choose one of --github, --gitlab, or --file.', 2, 'invalid_input');
    const name = options.name ?? DEFAULT_SECRET_NAME;
    if (options.githubEnvironment !== undefined && options.github === undefined) {
        throw new CliError('--github-environment needs --github.', 2, 'invalid_input');
    }
    if (options.name !== undefined && options.github === undefined && options.gitlab === undefined) {
        throw new CliError('--name needs --github or --gitlab.', 2, 'invalid_input');
    }
    if (options.github !== undefined) {
        return validateHandoff({
            kind: 'github',
            repo: options.github,
            name,
            ...(options.githubEnvironment ? { environment: options.githubEnvironment } : {})
        });
    }
    if (options.gitlab !== undefined) return validateHandoff({ kind: 'gitlab', project: options.gitlab, name });
    if (options.file !== undefined) return validateHandoff({ kind: 'file', path: options.file });
    return { kind: 'manual' };
}

function lifetimeSeconds(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const seconds = (KEY_LIFETIMES as Record<string, number>)[value];
    if (seconds === undefined) throw new CliError(`Invalid --lifetime "${value}"; use ${Object.keys(KEY_LIFETIMES).join(', ')}.`, 2, 'invalid_input');
    return seconds;
}

function description(siteName: string): string {
    return `ZynoHosting CLI on ${hostname()}: deploy token for ${siteName}`.slice(0, 255);
}

const keyError = {
    cancelled: () => new CliError('The deploy token request was cancelled.', 3, 'key_request_cancelled'),
    denied: () => new CliError('The deploy token request was denied.', 3, 'key_request_denied'),
    timeout: () => new CliError('Timed out waiting for approval.', 3, 'key_request_timeout'),
    pending: () =>
        new CliError('Still waiting for approval. Run `zynohosting deploy-tokens create --resume` to keep waiting.', 3, 'key_request_pending'),
    codeExpired: () =>
        new CliError('The approval code expired before it was approved. Run `zynohosting deploy-tokens create` again.', 3, 'key_request_expired'),
    expiredOrUsed: () =>
        new CliError('The approval code expired or was already used. Run `zynohosting deploy-tokens create` again.', 3, 'key_request_expired'),
    lost: () =>
        new CliError(
            'The connection dropped while the approved token was being delivered, so it was lost. Run `zynohosting deploy-tokens list` and revoke any token you did not receive, then create it again.',
            3,
            'key_credential_lost'
        )
};

function toStoredHandoff(handoff: Handoff): StoredHandoff {
    return handoff as StoredHandoff;
}

function requireAuthApiUrl(config: ResolvedConfig): string {
    if (!config.authApiUrl) {
        throw new CliError('The ZynoAuth API URL is required. Pass --auth-api-url or set ZYNO_AUTH_API_URL.', 2, 'missing_auth_api_url');
    }
    return config.authApiUrl;
}

function iso(value: number | undefined): string | undefined {
    return value === undefined || !Number.isFinite(value) ? undefined : new Date(value).toISOString();
}

/**
 * Asks ZynoAuth for a deploy token for one site, waits for the person to approve it, and puts it where they chose.
 * The token is never printed, never put in an argument, and never included in JSON output or an error.
 */
export async function createDeployToken(
    siteRef: string | undefined,
    options: DeployTokenCreateOptions,
    dependencies: DeployTokenDependencies = {}
): Promise<DeployTokenCreateResult> {
    const { json, env, write, emit, warn } = context(options, dependencies);
    const location = configLocation(env);
    const profileKey = selectProfile(options, env).key;
    let client: KeyRequestClient;
    let authApiUrl: string;
    let pending: PendingKeyRequest | undefined;
    let start: KeyRequestStart;
    let handoff: Handoff;
    let delivery: KeyDelivery;
    let siteId: string;
    let siteName: string;
    let environments: KeyEnvironment[];
    let handoffPlan: HandoffPreflight = { replacesExisting: false };
    let requestedPermissions: string[] = [];

    if (options.resume) {
        if (
            siteRef !== undefined ||
            options.production ||
            options.preview ||
            options.both ||
            options.permission?.length ||
            options.github ||
            options.gitlab ||
            options.file ||
            options.noWait
        ) {
            throw new CliError('--resume continues the saved request and takes no site or other options.', 2, 'invalid_input');
        }
        pending = (await loadConfigFile(location)).profiles[profileKey]?.pendingKeyRequest;
        if (!pending)
            throw new CliError(
                'There is no pending deploy token request to resume. Run `zynohosting deploy-tokens create --no-wait` first.',
                2,
                'no_pending_key_request'
            );
        handoff = pending.handoff as Handoff;
        delivery = pending.delivery;
        siteId = pending.siteId;
        siteName = pending.siteName;
        environments = pending.environments;
        start = {
            requestCode: pending.requestCode,
            userCode: pending.userCode,
            verificationUri: pending.verificationUri,
            verificationUriComplete: pending.verificationUriComplete ?? pending.verificationUri,
            interval: pending.interval,
            expiresAt: pending.expiresAt
        };
        // The request was made against a specific ZynoAuth, so that is the one to poll.
        authApiUrl = pending.authApiUrl;
        client = new KeyRequestClient(authApiUrl);
    } else {
        const config = await resolveConfig(options, env);
        authApiUrl = requireAuthApiUrl(config);
        client = new KeyRequestClient(authApiUrl);
        if (!siteRef)
            throw new CliError('Name the site: zynohosting deploy-tokens create <site> --production --github owner/repo', 2, 'invalid_input');
        environments = environmentsFrom(options);
        handoff = handoffFrom(options);
        const permissions = permissionsFrom(options.permission);
        const lifetime = lifetimeSeconds(options.lifetime);
        if (options.noWait && handoff.kind !== 'manual') {
            throw new CliError(
                '--no-wait works with the approval page only (no --github, --gitlab, or --file). Use --resume to finish a hand-off.',
                2,
                'invalid_input'
            );
        }
        const manager = new ManagerClient(config.apiUrl, config.credential);
        const site = await manager.getSite(normalizeSiteRef(siteRef));
        if (site.status !== 'active') throw new CliError('Only an active site can have a deploy token', 2, 'site_inactive');
        siteId = site.id;
        siteName = site.fqdn;
        delivery = handoff.kind === 'manual' ? 'display' : 'poll';
        // A preview-only token cannot deploy to a site that runs PHP, so fail here instead of after approval.
        assertTokenAllowedForSite(site, environments);
        handoffPlan = await preflightHandoff(handoff, dependencies);
        const input: KeyRequestInput = {
            permissions,
            sites: [{ siteId, environments }],
            description: description(siteName),
            ...(lifetime === undefined ? {} : { requestedLifetimeSecs: lifetime }),
            delivery,
            handoff: { kind: handoffKind(handoff), target: handoffTarget(handoff) }
        };
        start = await client.start(config.credential, input);
        // What ZynoAuth normalized the request to is what the approver will see.
        requestedPermissions = start.requested?.permissions ?? permissions;
    }
    return finishRequest(client, authApiUrl);

    async function finishRequest(activeClient: KeyRequestClient, activeAuthUrl: string): Promise<DeployTokenCreateResult> {
        const link = start.verificationUriComplete ?? start.verificationUri;
        if (!pending) {
            const prompt = {
                userCode: start.userCode,
                verificationUri: start.verificationUri,
                expiresAt: new Date(start.expiresAt).toISOString(),
                permissions: requestedPermissions
            };
            // The bare `hosting` key only means "access to hosting"; show the ones the person asked for beyond it.
            const extra = requestedPermissions.filter(key => key !== 'hosting');
            write(
                `\nApprove the deploy token for ${siteName} (${environments.join(' and ')})${extra.length ? ` with ${extra.join(', ')}` : ''}.\nOpen: ${link}\nCode: ${start.userCode}\nCheck that the page shows the same code and your site.\n`
            );
            emit({
                type: 'prompt',
                site: siteName,
                environments,
                ...prompt,
                ...(start.verificationUriComplete ? { verificationUriComplete: start.verificationUriComplete } : {}),
                destination: describeHandoff(handoff)
            });
            const flow: LoginFlow =
                options.open === false ? 'device' : chooseLoginFlow(undefined, env, dependencies.platform ?? process.platform).flow;
            if (flow === 'browser') {
                try {
                    await (dependencies.openUrl ?? openUrl)(link);
                } catch {
                    // The link is already shown above.
                }
            }
            if (options.noWait) {
                const saved: PendingKeyRequest = {
                    requestCode: start.requestCode,
                    userCode: start.userCode,
                    verificationUri: start.verificationUri,
                    ...(start.verificationUriComplete ? { verificationUriComplete: start.verificationUriComplete } : {}),
                    expiresAt: start.expiresAt,
                    interval: start.interval,
                    authApiUrl: activeAuthUrl,
                    delivery,
                    siteId,
                    siteName,
                    environments,
                    handoff: toStoredHandoff(handoff),
                    createdAt: Date.now()
                };
                let previous: PendingKeyRequest | undefined;
                await mutateProfile(
                    profileKey,
                    current => {
                        previous = current.pendingKeyRequest;
                        return { ...current, pendingKeyRequest: saved };
                    },
                    location
                );
                // A saved request this one replaces can no longer be resumed, so end it on the server too (best effort).
                if (previous && previous.requestCode !== saved.requestCode) {
                    await new KeyRequestClient(previous.authApiUrl).cancel(previous.requestCode).catch(() => {});
                }
                write('\nThe request is saved. After you approve it, run `zynohosting deploy-tokens create --resume`.\n');
                emit({ type: 'result', status: 'pending', site: siteName, ...prompt });
                return { status: 'pending', site: siteName, ...prompt };
            }
        } else {
            write(`\nWaiting for approval of the deploy token for ${siteName}. Code: ${start.userCode}\n`);
        }

        const abort = new AbortController();
        const onSigint = () => abort.abort();
        if (options.handleSigint) process.once('SIGINT', onSigint);
        options.signal?.addEventListener('abort', onSigint, { once: true });
        const clearPending = () =>
            mutateProfile(
                profileKey,
                current => {
                    // Only this request's own record: a newer saved request must survive.
                    if (current.pendingKeyRequest?.requestCode !== start.requestCode) return current;
                    const { pendingKeyRequest: _gone, ...rest } = current;
                    return rest;
                },
                location
            ).catch(() => {});
        let secret = '';
        try {
            const approved = await pollApproval<ApprovedKey>({
                poll: async (): Promise<ApprovalPoll<ApprovedKey>> => {
                    const result = await activeClient.poll(start.requestCode, delivery);
                    return result.status === 'approved' ? { status: 'approved', value: result } : result;
                },
                cancel: () => activeClient.cancel(start.requestCode),
                // For display delivery the server holds the key, so nothing can have been lost in transit.
                errors: { ...keyError, lost: delivery === 'display' ? keyError.expiredOrUsed : keyError.lost },
                interval: start.interval,
                signal: abort.signal,
                ...(options.timeoutSeconds === undefined ? {} : { deadline: Date.now() + options.timeoutSeconds * 1000 }),
                keepPendingOnTimeout: pending !== undefined || options.noWait === true,
                giveUpAt: start.expiresAt + 60_000,
                uncertain: pending?.deliveryUncertain ?? false,
                onUncertainChange: async uncertain => {
                    if (!pending) return;
                    await mutateProfile(
                        profileKey,
                        current => {
                            if (current.pendingKeyRequest?.requestCode !== pending!.requestCode) return current;
                            const { deliveryUncertain: _old, ...rest } = current.pendingKeyRequest;
                            return { ...current, pendingKeyRequest: uncertain ? { ...rest, deliveryUncertain: true } : rest };
                        },
                        location
                    );
                }
            });

            let destination = describeHandoff(handoff);
            let warnings: string[] = [];
            if (delivery === 'poll') {
                secret = approved.secret ?? '';
                try {
                    const outcome = await deliverSecret(handoff, secret, dependencies, handoffPlan);
                    destination = outcome.destination;
                    warnings = outcome.warnings;
                } catch (error) {
                    throw await undoFailedHandoff(activeClient, secret, approved.key?.id, error);
                }
            }
            await clearPending();
            for (const message of warnings) warn('deploy_token_file_in_worktree', message);
            const keyExpiry = iso(approved.key?.expiresAt);
            write(
                delivery === 'poll'
                    ? `\nDeploy token for ${siteName} saved to ${destination}${keyExpiry ? `; it expires ${keyExpiry}` : ''}.\nThe token itself was not printed.\n`
                    : `\nApproved. Copy the deploy token from the approval page now; it is shown once.${keyExpiry ? ` It expires ${keyExpiry}.` : ''}\n`
            );
            const result: Extract<DeployTokenCreateResult, { status: 'created' }> = {
                status: 'created',
                site: siteName,
                siteId,
                environments,
                ...(approved.key?.id ? { keyId: approved.key.id } : {}),
                ...(approved.key?.preview ? { preview: approved.key.preview } : {}),
                ...(approved.key ? { permissionKeys: approved.key.permissionKeys } : {}),
                ...(keyExpiry ? { expiresAt: keyExpiry } : {}),
                destination,
                warnings
            };
            emit({ type: 'result', ...result });
            return result;
        } catch (error) {
            if (
                error instanceof CliError &&
                [
                    'key_request_denied',
                    'key_request_expired',
                    'key_request_cancelled',
                    'key_request_timeout',
                    'key_credential_lost',
                    'handoff_failed'
                ].includes(error.code)
            ) {
                await clearPending();
            }
            throw secret ? scrub(error, secret) : error;
        } finally {
            process.removeListener('SIGINT', onSigint);
            options.signal?.removeEventListener('abort', onSigint);
            secret = '';
        }
    }
}

/** A hand-off that failed leaves a live token nobody holds, so revoke it with itself and say what happened. */
async function undoFailedHandoff(client: KeyRequestClient, secret: string, keyId: string | undefined, error: unknown): Promise<CliError> {
    const reason = error instanceof CliError ? redactSecret(error.message, secret) : 'the hand-off failed';
    let revoked = false;
    try {
        await client.revokeSelf(secret, 10_000);
        revoked = true;
    } catch {
        revoked = false;
    }
    return new CliError(
        revoked
            ? `${reason}. The new deploy token was revoked, so nothing was left behind. Fix the problem and run the command again.`
            : `${reason}. The new deploy token could not be revoked automatically${keyId ? ` (key ${keyId})` : ''}; revoke it with \`zynohosting deploy-tokens revoke ${keyId ?? '<keyId>'}\` or from the ZynoSuite site.`,
        error instanceof CliError ? error.exitCode : 7,
        'handoff_failed'
    );
}

/** Rebuilds an error without any trace of the secret: no details, a redacted message. */
function scrub(error: unknown, secret: string): CliError {
    if (error instanceof CliError) return new CliError(redactSecret(error.message, secret), error.exitCode, error.code);
    return new CliError(redactSecret(error instanceof Error ? error.message : String(error), secret), 1, 'cli_error');
}

// ---------------------------------------------------------------------------------------------------------------------

export async function listDeployTokens(
    siteRef: string | undefined,
    options: ConfigOverrides & { json?: boolean },
    dependencies: DeployTokenDependencies = {}
): Promise<ApiKeySummary[]> {
    const { json, env } = context(options, dependencies);
    const write = dependencies.write ?? ((message: string) => process.stdout.write(message));
    const config = await resolveConfig(options, env);
    const client = new KeyRequestClient(requireAuthApiUrl(config));
    const siteId = siteRef ? (await new ManagerClient(config.apiUrl, config.credential).getSite(normalizeSiteRef(siteRef))).id : undefined;
    const keys = await client.list(config.credential, { siteId });
    if (json) {
        write(
            `${JSON.stringify(keys.map(key => ({ ...key, createdAt: iso(key.createdAt), expiresAt: iso(key.expiresAt), lastUsedAt: iso(key.lastUsedAt) })))}\n`
        );
        return keys;
    }
    if (!keys.length) {
        write('No deploy tokens.\n');
        return keys;
    }
    for (const key of keys) {
        const parts = [
            key.id,
            key.preview ?? '',
            key.sites.map(site => `${site.label} (${site.environments.join('+')})`).join(', '),
            (key.permissionKeys ?? []).filter(permission => !key.apps.includes(permission)).join(','),
            key.expiresAt === undefined ? '' : `expires ${iso(key.expiresAt)}`,
            key.lastUsedAt === undefined ? 'never used' : `last used ${iso(key.lastUsedAt)}`,
            key.approvedBy ? `approved by ${key.approvedBy}` : '',
            key.description ?? ''
        ].filter(Boolean);
        write(`${parts.join('  ')}\n`);
    }
    return keys;
}

export async function revokeDeployToken(
    keyId: string | undefined,
    options: ConfigOverrides & { json?: boolean; self?: boolean },
    dependencies: DeployTokenDependencies = {}
): Promise<void> {
    const { json, env, write, emit } = context(options, dependencies);
    if (options.self && keyId) throw new CliError('Give a key id or --self, not both.', 2, 'invalid_input');
    if (!options.self && !keyId)
        throw new CliError('Give the key id to revoke, or --self to revoke the deploy token in ZYNOHOSTING_DEPLOY_TOKEN.', 2, 'invalid_input');
    if (options.self) {
        const config = await resolveConfig({ ...options, deployTokenAllowed: true }, env);
        if (config.credential.type !== 'deploy-token') {
            throw new CliError('--self revokes the deploy token in ZYNOHOSTING_DEPLOY_TOKEN, which is not set.', 2, 'invalid_input');
        }
        await new KeyRequestClient(requireAuthApiUrl(config)).revokeSelf(config.credential.token);
        write('The deploy token was revoked.\n');
        emit({ type: 'result', status: 'revoked', self: true });
        return;
    }
    const config = await resolveConfig(options, env);
    const { alreadyRevoked } = await new KeyRequestClient(requireAuthApiUrl(config)).revoke(config.credential, keyId!);
    write(
        alreadyRevoked
            ? `Deploy token ${keyId} was not found: it was already revoked or never existed. Nothing changed.\n`
            : `Deploy token ${keyId} was revoked. A deployment already in progress can run for up to 20 minutes more.\n`
    );
    emit({ type: 'result', status: 'revoked', keyId, ...(alreadyRevoked ? { alreadyRevoked: true } : {}) });
}

/** `whoami` for a deploy token: the sites and environments it holds, and its expiry (which only ZynoAuth knows). */
export async function describeDeployToken(options: ConfigOverrides & { json?: boolean }, dependencies: DeployTokenDependencies = {}): Promise<void> {
    const { json, env } = context(options, dependencies);
    const write = dependencies.write ?? ((message: string) => process.stdout.write(message));
    const config = await resolveConfig({ ...options, deployTokenAllowed: true }, env);
    if (config.credential.type !== 'deploy-token') throw new CliError('ZYNOHOSTING_DEPLOY_TOKEN is not set.', 2, 'invalid_input');
    const token = config.credential.token;
    let info;
    try {
        info = await new ManagerClient(config.apiUrl, config.credential).getDeployTokenInfo();
    } catch (error) {
        return diagnoseDeployToken(config, error);
    }
    // Hosting reports no expiry; ZynoAuth does. If ZynoAuth cannot answer, show what hosting said and warn.
    const warnText = (message: string) => (dependencies.warn ?? ((text: string) => process.stderr.write(text)))(`Warning: ${message}\n`);
    let expiresAt: string | undefined;
    let permissionKeys: string[] | null | undefined;
    if (!config.authApiUrl) {
        warnText('the ZynoAuth API URL is not set (--auth-api-url or ZYNO_AUTH_API_URL), so the expiry is unknown.');
    } else {
        try {
            const self = await new KeyRequestClient(config.authApiUrl).self(token);
            expiresAt = iso(self.expiresAt);
            permissionKeys = self.permissionKeys;
        } catch (error) {
            const verdict = selfFailure(error);
            if (verdict) throw verdict;
            warnText('ZynoAuth could not be reached, so the expiry is unknown.');
        }
    }
    const expiry = expiresAt ? `expires ${expiresAt}` : 'expiry unknown';
    if (json) {
        write(
            `${JSON.stringify({
                profile: describeProfileKey(selectProfile(options, env).key),
                deployToken: {
                    keyId: info.keyId,
                    sites: info.sites.map(entry => ({ site: entry.site.fqdn, siteId: entry.siteId, environments: entry.environments })),
                    ...(permissionKeys ? { permissionKeys } : {}),
                    expiresAt: expiresAt ?? null
                }
            })}\n`
        );
        return;
    }
    if (!info.sites.length) {
        write(`Deploy token ${info.keyId} no longer covers any site (deleted or transferred); ${expiry}.\n`);
        return;
    }
    write(`Deploy token for ${info.sites.map(entry => `${entry.site.fqdn} (${entry.environments.join(' and ')})`).join(', ')}; ${expiry}.\n`);
}
