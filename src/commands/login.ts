import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import type { DeviceCredential, DeviceStart, ScopedTokenClient } from '../api/scoped-token-client.js';

import { ScopedTokenClient as ScopedTokenClientImpl } from '../api/scoped-token-client.js';
import {
    API_KEY_LOGIN_ID,
    jwtSubject,
    loginIdFor,
    type PendingDeviceLogin,
    type StoredConfig,
    type StoredLogin,
    UNKNOWN_ACCOUNT
} from '../auth/logins.js';
import { resolvePermissionGrant } from '../auth/permission-grant.js';
import { createRenewalTokenStore, type RenewalTokenStore } from '../auth/renewal-token-store.js';
import { retireDisplacedLogins, retireLogin } from '../auth/retire.js';
import {
    configLocation,
    describeProfileKey,
    type HostingEnvironment,
    loadStoredConfig,
    mutateProfile,
    normalizeApiUrl,
    hostingUrlChosenByFlag,
    removeLegacyConfigIfMatching,
    resolveAuthApiUrl,
    resolveSuiteApiUrl,
    selectProfile
} from '../config.js';
import { CliError } from '../errors.js';
import { openUrl } from '../login/browser.js';
import { type DeviceLoginClient, pollDeviceApproval } from '../login/device.js';
import { chooseLoginFlow, type LoginFlow, type LoginFlowReason } from '../login/flow.js';
import { startLoopbackLogin, type UserCredential } from '../login/loopback.js';
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
const DEFAULT_WAIT_SECONDS = 300;

/** How long a grant can last, as the approver sees the choices. */
export const LOGIN_LIFETIMES = { '1h': 3_600, '1d': 86_400, '7d': 604_800, '30d': 2_592_000 } as const;

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
    /** How long to wait for approval. Browser: 300 seconds by default. Device: until the code expires. `resume`: 300 seconds. */
    timeoutSeconds?: number;
    open?: boolean;
    /** true forces the device flow (a link and code), false forces the browser flow; unset chooses automatically. */
    device?: boolean;
    /** Device flow only: print the link and code, save the pending sign-in, and return. */
    noWait?: boolean;
    /** Continue the pending device sign-in saved by `noWait`. */
    resume?: boolean;
    /** 1h, 1d, 7d or 30d: the lifetime to suggest to the approver. Anything above 1h needs `renewable`. */
    lifetime?: string;
    /** Where a renewal token is kept; overrides ZYNOHOSTING_CREDENTIAL_STORE. Needs `renewable`. */
    credentialStore?: string;
    /** Machine-readable output: one JSON event per line on stdout, human messages on stderr. */
    json?: boolean;
    /** Cancel the device sign-in on Ctrl+C. For the CLI only; a host process manages its own signals. */
    handleSigint?: boolean;
    /** Abandons an in-flight flow: closes the loopback listener or cancels the device code, and rejects with `login_cancelled`. */
    signal?: AbortSignal;
}

export type LoginPrompt =
    | { flow: 'browser'; reason: LoginFlowReason; url: string }
    | {
          flow: 'device';
          reason: LoginFlowReason;
          verificationUri: string;
          verificationUriComplete?: string | undefined;
          userCode: string;
          /** Epoch milliseconds. */
          expiresAt: number;
          interval: number;
      };

export type LoginResult =
    | { status: 'api_key_saved'; profile: string }
    | { status: 'pending'; profile: string; prompt: Extract<LoginPrompt, { flow: 'device' }> }
    | {
          status: 'authenticated';
          flow: LoginFlow;
          profile: string;
          loginId: string;
          accountId?: string;
          tenantId: string;
          tenantName?: string;
          account?: string;
          renewable: boolean;
          permissionKeys: string[];
          deniedPermissionKeys: string[];
          credentialStore?: 'system' | 'file';
          accessExpiresAt: number;
          grantExpiresAt?: number;
      };

export interface LoginDependencies {
    env?: NodeJS.ProcessEnv;
    configFile?: string;
    platform?: NodeJS.Platform;
    openUrl?: (url: string) => Promise<void>;
    /** Called with the link (browser) or link and code (device) as soon as they exist, before waiting. */
    onLoginPrompt?: (prompt: LoginPrompt) => void | Promise<void>;
    write?: (message: string) => void;
    /** Receives warnings; stderr by default. */
    warn?: (message: string) => void;
    /** Receives JSON events when `json` is set. */
    emit?: (event: Record<string, unknown>) => void;
    renewalTokenStore?: RenewalTokenStore;
    scopedTokenClient?: (authApiUrl: string) => DeviceLoginClient & Pick<ScopedTokenClient, 'revoke'> & Partial<Pick<ScopedTokenClient, 'renew'>>;
}

interface IssuedCredential {
    accessToken: string;
    accountId?: string | undefined;
    tenantId: string;
    expiresAt: number;
    renewalToken?: string | undefined;
    tenantName?: string | undefined;
    accountEmail?: string | undefined;
    grantExpiresAt?: number | undefined;
    /** Granted and denied permissions, when the approver said; absent means everything requested was granted. */
    permissionKeys?: string[] | undefined;
    deniedPermissionKeys?: string[] | undefined;
}

export async function login(options: LoginOptions, dependencies: LoginDependencies = {}): Promise<LoginResult> {
    const env = dependencies.env ?? process.env;
    const file = dependencies.configFile ?? configLocation(env);
    const configPath = typeof file === 'string' ? file : file.path;
    const selection = selectProfile(options, env);
    const profileKey = selection.key;
    const apiUrl = selection.apiUrl;
    const stored = await loadStoredConfig(file, profileKey, { lenientLegacy: true });
    const suiteApiUrl = resolveSuiteApiUrl(options.suiteApiUrl, stored, apiUrl, env, options.environment, hostingUrlChosenByFlag(options));
    const authApiUrl = resolveAuthApiUrl(options.authApiUrl, stored, apiUrl, env, options.environment, hostingUrlChosenByFlag(options));
    // Only an explicit --api-key is saved. A key that merely sits in the environment (as in CI) is never written to disk.
    const apiKey = options.apiKey;
    const json = options.json ?? false;
    const write =
        dependencies.write ?? (json ? (message: string) => process.stderr.write(message) : (message: string) => process.stdout.write(message));
    const emit = (event: Record<string, unknown>): void => {
        if (!json) return;
        if (dependencies.emit) dependencies.emit(event);
        else process.stdout.write(`${JSON.stringify(event)}\n`);
    };
    const urlFields = (current: StoredConfig): StoredConfig => {
        const { suiteApiUrl: _suite, authApiUrl: _auth, ...rest } = current;
        // A resumed sign-in was started against a specific ZynoAuth, so that is the one to remember.
        const auth = options.resume ? (stored.pendingDeviceLogin?.authApiUrl ?? authApiUrl) : authApiUrl;
        return { ...rest, apiUrl, ...(suiteApiUrl ? { suiteApiUrl } : {}), ...(auth ? { authApiUrl: auth } : {}) };
    };

    if (apiKey) {
        let replaced: string | undefined;
        await mutateProfile(
            profileKey,
            current => {
                replaced = current.apiKey;
                return { ...urlFields(current), apiKey, activeLogin: API_KEY_LOGIN_ID };
            },
            file
        );
        if (replaced) await removeLegacyConfigIfMatching(file, { apiKey: replaced });
        write('ZynoHosting API-key credentials saved.\n');
        emit({ type: 'result', status: 'api_key_saved', profile: profileKey });
        return { status: 'api_key_saved', profile: profileKey };
    }

    if (env.ZYNOHOSTING_API_KEY) {
        const message =
            'ZYNOHOSTING_API_KEY is set in the environment, so it overrides saved logins for every command, including the one you are about to sign in with. Unset it to use the saved login.';
        (dependencies.warn ?? ((text: string) => process.stderr.write(text)))(`Warning: ${message}\n`);
        emit({ type: 'warning', code: 'api_key_in_environment', message });
    }

    const resuming = options.resume === true;
    const pendingSaved = stored.pendingDeviceLogin;
    if (resuming && !pendingSaved) {
        throw new CliError('There is no pending sign-in to resume. Run `zynohosting login --device --no-wait` first.', 2, 'no_pending_login');
    }
    if (resuming && (options.noWait || options.device === false)) {
        throw new CliError('--resume cannot be combined with --no-wait or --no-device.', 2, 'invalid_login_options');
    }
    if (options.noWait && options.device === false) {
        throw new CliError('--no-wait only works with the device sign-in (a link and code). Remove --no-device.', 2, 'invalid_login_options');
    }

    const name = validateName(resuming ? pendingSaved!.name : (options.name ?? defaultClientName()));
    const permissionKeys = validatePermissionKeys(resuming ? pendingSaved!.permissionKeys : (options.permissionKeys ?? DEFAULT_PERMISSION_KEYS));
    const renewable = resuming ? pendingSaved!.renewable : (options.renewable ?? false);
    const lifetimeSecs = resuming ? undefined : parseLifetime(options.lifetime, renewable);
    if (renewable && !authApiUrl && !resuming) {
        throw new CliError(
            'The ZynoAuth API URL is required for a renewable login. Pass --auth-api-url or set ZYNO_AUTH_API_URL.',
            2,
            'missing_auth_api_url'
        );
    }

    // Check where the renewal token will live before anything is minted: a grant that cannot be stored is an orphan.
    const storeKind = resuming ? (pendingSaved!.renewalStore ?? 'system') : chooseStoreKind(options.credentialStore, env, renewable);
    let store: RenewalTokenStore | undefined;
    if (renewable) {
        store = dependencies.renewalTokenStore ?? createRenewalTokenStore(storeKind, configPath);
        await store.probe?.();
    }

    const clientFor = (url: string) => dependencies.scopedTokenClient?.(url) ?? new ScopedTokenClientImpl(url);
    const revokeQuietly = async (accessToken: string): Promise<void> => {
        if (!authApiUrl && !pendingSaved) return;
        try {
            await (
                dependencies.scopedTokenClient?.((authApiUrl ?? pendingSaved?.authApiUrl)!) ??
                new ScopedTokenClientImpl((authApiUrl ?? pendingSaved?.authApiUrl)!, 5_000)
            ).revoke(accessToken);
        } catch {
            // Best effort: the grant is unusable without its owner and ends at its own expiry.
        }
    };

    /** Stores the credential and makes it the active login for its tenant. Shared by the browser and device flows. */
    const persist = async (credential: IssuedCredential, approvedBy?: { email?: string | undefined; tenantName?: string | undefined }) => {
        const renewalKey = credential.renewalToken ? randomUUID() : undefined;
        // The account comes from the server's credential, else from the token's `sub` (the account id for a scoped token).
        const accountId = credential.accountId ?? jwtSubject(credential.accessToken);
        const loginId = loginIdFor(accountId ?? UNKNOWN_ACCOUNT, credential.tenantId);
        // An approver may grant only some of what was asked for; an older portal says nothing, meaning all of it.
        const grant = resolvePermissionGrant(permissionKeys, credential.permissionKeys, credential.deniedPermissionKeys);
        if (!grant)
            throw new CliError('The sign-in granted none of the requested permissions, or ones that were not requested.', 5, 'invalid_auth_response');
        const login: StoredLogin = {
            ...(accountId ? { accountId } : {}),
            tenantId: credential.tenantId,
            ...((credential.tenantName ?? approvedBy?.tenantName) ? { tenantName: (credential.tenantName ?? approvedBy?.tenantName)! } : {}),
            ...((credential.accountEmail ?? approvedBy?.email) ? { accountEmail: (credential.accountEmail ?? approvedBy?.email)! } : {}),
            ...(credential.grantExpiresAt === undefined ? {} : { grantExpiresAt: credential.grantExpiresAt }),
            accessToken: credential.accessToken,
            expiresAt: credential.expiresAt,
            ...(renewalKey ? { renewalKey, ...(storeKind === 'file' ? { renewalStore: 'file' as const } : {}) } : {}),
            scopedToken: true,
            permissionKeys: grant.granted,
            ...(grant.denied.length ? { deniedPermissionKeys: grant.denied } : {}),
            createdAt: Date.now()
        };
        let previous: StoredLogin | undefined;
        try {
            if (renewalKey) await store!.set(renewalKey, credential.renewalToken!);
            await mutateProfile(
                profileKey,
                current => {
                    previous = current.logins?.[loginId];
                    const { pendingDeviceLogin: _pending, ...rest } = urlFields(current);
                    return { ...rest, logins: { ...current.logins, [loginId]: login }, activeLogin: loginId };
                },
                file
            );
        } catch (error) {
            if (renewalKey) await store!.delete(renewalKey).catch(() => {});
            await revokeQuietly(credential.accessToken);
            throw error;
        }
        if (previous) {
            await removeLegacyConfigIfMatching(file, { logins: { [loginId]: previous } });
            await retire(previous);
        }
        await retireDisplacedLogins(profileKey, file, {
            configPath,
            renewalTokenStore: dependencies.renewalTokenStore,
            scopedTokenClient: dependencies.scopedTokenClient,
            write
        });
        return login;
    };

    const retire = (previous: StoredLogin): Promise<void> =>
        retireLogin(previous, {
            authApiUrl: authApiUrl ?? pendingSaved?.authApiUrl,
            configPath,
            renewalTokenStore: dependencies.renewalTokenStore,
            scopedTokenClient: dependencies.scopedTokenClient,
            write
        });

    const finish = (login: StoredLogin, flow: LoginFlow): LoginResult => {
        const result: Extract<LoginResult, { status: 'authenticated' }> = {
            status: 'authenticated',
            flow,
            profile: profileKey,
            loginId: loginIdFor(login.accountId ?? UNKNOWN_ACCOUNT, login.tenantId),
            ...(login.accountId ? { accountId: login.accountId } : {}),
            tenantId: login.tenantId,
            ...(login.tenantName ? { tenantName: login.tenantName } : {}),
            ...(login.accountEmail ? { account: login.accountEmail } : {}),
            renewable: Boolean(login.renewalKey),
            permissionKeys: login.permissionKeys ?? permissionKeys,
            deniedPermissionKeys: login.deniedPermissionKeys ?? [],
            ...(login.renewalKey ? { credentialStore: login.renewalStore ?? ('system' as const) } : {}),
            accessExpiresAt: login.expiresAt!,
            ...(login.grantExpiresAt === undefined ? {} : { grantExpiresAt: login.grantExpiresAt })
        };
        const who = login.accountEmail ? `${login.accountEmail} (${login.tenantName ?? login.tenantId})` : (login.tenantName ?? login.tenantId);
        const until = login.grantExpiresAt === undefined ? '' : `, renews until ${new Date(login.grantExpiresAt).toISOString().slice(0, 10)}`;
        const notGranted = result.deniedPermissionKeys.length
            ? ` Not granted: ${result.deniedPermissionKeys.join(', ')} (you don't have ${result.deniedPermissionKeys.length > 1 ? 'them' : 'it'} in ${login.tenantName ?? login.tenantId}).`
            : '';
        write(
            login.renewalKey
                ? `ZynoHosting renewable login complete. Signed in as ${who}${until}. The renewal credential was saved in ${login.renewalStore === 'file' ? 'a private file next to your saved logins' : 'your system credential store'}.${notGranted}\n`
                : `ZynoHosting login complete. Signed in as ${who}.${notGranted}\n`
        );
        emit({
            type: 'result',
            status: 'authenticated',
            flow,
            profile: describeProfileKey(profileKey),
            loginId: result.loginId,
            ...(result.accountId ? { accountId: result.accountId } : {}),
            tenantId: result.tenantId,
            ...(result.tenantName ? { tenantName: result.tenantName } : {}),
            ...(result.account ? { account: result.account } : {}),
            renewable: result.renewable,
            permissionKeys: result.permissionKeys,
            deniedPermissionKeys: result.deniedPermissionKeys,
            ...(result.credentialStore ? { credentialStore: result.credentialStore } : {}),
            accessExpiresAt: new Date(result.accessExpiresAt).toISOString(),
            ...(result.grantExpiresAt === undefined ? {} : { grantExpiresAt: new Date(result.grantExpiresAt).toISOString() })
        });
        return result;
    };

    const devicePromptFrom = (start: DeviceStart | PendingDeviceLogin, reason: LoginFlowReason): Extract<LoginPrompt, { flow: 'device' }> => ({
        flow: 'device',
        reason,
        verificationUri: start.verificationUri,
        ...(start.verificationUriComplete ? { verificationUriComplete: start.verificationUriComplete } : {}),
        userCode: start.userCode,
        expiresAt: start.expiresAt,
        interval: start.interval
    });
    const showDevicePrompt = async (prompt: Extract<LoginPrompt, { flow: 'device' }>, noWait: boolean): Promise<void> => {
        emit({
            type: 'login_started',
            flow: 'device',
            reason: prompt.reason,
            verificationUri: prompt.verificationUri,
            ...(prompt.verificationUriComplete ? { verificationUriComplete: prompt.verificationUriComplete } : {}),
            userCode: prompt.userCode,
            expiresAt: new Date(prompt.expiresAt).toISOString(),
            interval: prompt.interval
        });
        write(devicePromptText(prompt, noWait));
        await dependencies.onLoginPrompt?.(prompt);
    };

    // One controller covers an abort from the caller and, for the CLI, Ctrl+C.
    const abort = new AbortController();
    const forwardAbort = () => abort.abort();
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (options.signal?.aborted) abort.abort();
    const onSigint = () => abort.abort();
    if (options.handleSigint) process.once('SIGINT', onSigint);
    const cleanup = () => {
        options.signal?.removeEventListener('abort', forwardAbort);
        if (options.handleSigint) process.off('SIGINT', onSigint);
    };

    try {
        if (resuming) {
            const pending = pendingSaved!;
            const client = clientFor(pending.authApiUrl);
            emit({ type: 'login_resuming', userCode: pending.userCode });
            write(`Waiting for you to approve code ${pending.userCode}…\n`);
            try {
                const approval = await pollDeviceApproval({
                    client,
                    deviceCode: pending.deviceCode,
                    interval: pending.interval,
                    expectation: { renewable: pending.renewable, permissionKeys: pending.permissionKeys },
                    signal: abort.signal,
                    deadline: Date.now() + (options.timeoutSeconds ?? DEFAULT_WAIT_SECONDS) * 1000,
                    giveUpAt: Infinity,
                    keepPendingOnTimeout: true,
                    uncertain: pending.deliveryUncertain ?? false,
                    onUncertainChange: async deliveryUncertain => {
                        await mutateProfile(
                            profileKey,
                            current => {
                                if (current.pendingDeviceLogin?.deviceCode !== pending.deviceCode) return current;
                                const { deliveryUncertain: _old, ...rest } = current.pendingDeviceLogin;
                                return { ...current, pendingDeviceLogin: deliveryUncertain ? { ...rest, deliveryUncertain: true } : rest };
                            },
                            file
                        );
                    }
                });
                const login = await persist(toIssued(approval.credential), approval.approvedBy);
                return finish(login, 'device');
            } catch (error) {
                if (error instanceof CliError && error.code === 'login_pending')
                    emit({ type: 'login_pending', resume: 'zynohosting login --resume' });
                else await dropPending(error, pending.deviceCode);
                throw error;
            }
        }

        let choice = chooseLoginFlow(options.noWait ? true : options.device, env, dependencies.platform ?? process.platform);
        const loginPageUrl = choice.flow === 'browser' ? resolveLoginPageUrl(options.loginUrl ?? env.ZYNOHOSTING_LOGIN_URL, apiUrl) : undefined;
        if (abort.signal.aborted) throw new CliError('Sign-in was cancelled', 3, 'login_cancelled');

        if (choice.flow === 'browser') {
            try {
                return await browserLogin(loginPageUrl!, choice.reason);
            } catch (error) {
                if (!(error instanceof LoopbackUnavailable)) throw error;
                // No local listener means no browser round trip; the device flow does not need one.
                if (!authApiUrl) throw error.cause;
                choice = { flow: 'device', reason: 'loopback_unavailable' };
            }
        }
        return await deviceLogin(choice.reason);

        async function browserLogin(pageUrl: string, reason: LoginFlowReason): Promise<LoginResult> {
            let saved: StoredLogin | undefined;
            let loopback;
            try {
                loopback = await startLoopbackLogin({
                    timeoutMs: Math.max(1, options.timeoutSeconds ?? DEFAULT_WAIT_SECONDS) * 1000,
                    renewable,
                    requestedPermissions: permissionKeys,
                    onCredential: async credential => {
                        saved = await persist(toIssued(credential));
                    }
                });
            } catch (error) {
                if (reason !== 'explicit') throw new LoopbackUnavailable(error);
                throw error;
            }
            const cancel = () => void loopback.close();
            abort.signal.addEventListener('abort', cancel, { once: true });
            if (abort.signal.aborted) cancel();
            const browserUrl = new URL(pageUrl);
            browserUrl.searchParams.set('callback', loopback.callbackUrl);
            browserUrl.searchParams.set('state', loopback.state);
            browserUrl.searchParams.set('name', name);
            browserUrl.searchParams.set('permissions', permissionKeys.join(','));
            if (renewable) browserUrl.searchParams.set('renewable', '1');
            if (lifetimeSecs !== undefined) browserUrl.searchParams.set('lifetime', String(lifetimeSecs));
            try {
                const prompt: LoginPrompt = { flow: 'browser', reason, url: browserUrl.toString() };
                emit({ type: 'login_started', flow: 'browser', reason, url: prompt.url });
                // Let programmatic callers return the one-time link to their user before attempting to
                // launch a browser. This is essential for an MCP host where browser launching can fail.
                await dependencies.onLoginPrompt?.(prompt);
                write('Opening your browser to sign in to Zyno…\n');
                if (options.open === false) {
                    write(`Open this URL to continue:\n${prompt.url}\n`);
                } else {
                    try {
                        await (dependencies.openUrl ?? openUrl)(prompt.url);
                    } catch {
                        write(`The browser could not be opened automatically. Open this URL to continue:\n${prompt.url}\n`);
                    }
                }
                await loopback.result;
                return finish(saved!, 'browser');
            } finally {
                abort.signal.removeEventListener('abort', cancel);
                await loopback.close();
            }
        }

        async function deviceLogin(reason: LoginFlowReason): Promise<LoginResult> {
            if (!authApiUrl) {
                throw new CliError(
                    'The ZynoAuth API URL is required for a sign-in with a link and code. Pass --auth-api-url or set ZYNO_AUTH_API_URL.',
                    2,
                    'missing_auth_api_url'
                );
            }
            const client = clientFor(authApiUrl);
            // A newer sign-in replaces an unfinished one, so the older code must not stay approvable.
            if (pendingSaved) await client.cancelDevice(pendingSaved.deviceCode).catch(() => {});
            const start = await client.startDevice({
                description: name,
                permissionKeys,
                renewable,
                ...(lifetimeSecs === undefined ? {} : { requestedLifetimeSecs: lifetimeSecs })
            });
            const prompt = devicePromptFrom(start, reason);
            try {
                if (options.noWait) {
                    await mutateProfile(
                        profileKey,
                        current => ({
                            ...urlFields(current),
                            pendingDeviceLogin: {
                                deviceCode: start.deviceCode,
                                userCode: start.userCode,
                                verificationUri: start.verificationUri,
                                ...(start.verificationUriComplete ? { verificationUriComplete: start.verificationUriComplete } : {}),
                                expiresAt: start.expiresAt,
                                interval: start.interval,
                                authApiUrl,
                                renewable,
                                ...(renewable && storeKind === 'file' ? { renewalStore: 'file' as const } : {}),
                                permissionKeys,
                                name,
                                createdAt: Date.now()
                            }
                        }),
                        file
                    );
                    await showDevicePrompt(prompt, true);
                    emit({ type: 'login_pending', resume: 'zynohosting login --resume' });
                    return { status: 'pending', profile: profileKey, prompt };
                }
                // Forget an older unfinished sign-in now that this one replaces it.
                if (pendingSaved) {
                    await mutateProfile(
                        profileKey,
                        current => {
                            const { pendingDeviceLogin: _old, ...rest } = current;
                            return rest;
                        },
                        file
                    );
                }
                await showDevicePrompt(prompt, false);
            } catch (error) {
                await client.cancelDevice(start.deviceCode).catch(() => {});
                throw error;
            }
            const approval = await pollDeviceApproval({
                client,
                deviceCode: start.deviceCode,
                interval: start.interval,
                expectation: { renewable, permissionKeys },
                signal: abort.signal,
                deadline: options.timeoutSeconds === undefined ? undefined : Date.now() + options.timeoutSeconds * 1000,
                giveUpAt: start.expiresAt + 150_000
            });
            const login = await persist(toIssued(approval.credential), approval.approvedBy);
            return finish(login, 'device');
        }
    } finally {
        cleanup();
    }

    /** A pending device sign-in that the server has ended (or that failed for good) is no use to `--resume`. */
    async function dropPending(error: unknown, deviceCode: string): Promise<void> {
        if (
            !(error instanceof CliError) ||
            !['login_denied', 'device_code_expired', 'device_credential_lost', 'login_cancelled'].includes(error.code)
        )
            return;
        await mutateProfile(
            profileKey,
            current => {
                // Only the sign-in this process was handling: a newer one started elsewhere must survive.
                if (current.pendingDeviceLogin?.deviceCode !== deviceCode) return current;
                const { pendingDeviceLogin: _pending, ...rest } = current;
                return rest;
            },
            file
        ).catch(() => {});
    }
}

class LoopbackUnavailable extends Error {
    constructor(readonly cause: unknown) {
        super('The local sign-in listener could not start');
    }
}

function toIssued(credential: UserCredential | DeviceCredential): IssuedCredential {
    const token = 'jwt' in credential ? credential.jwt : credential.accessToken;
    return {
        accessToken: token,
        accountId: credential.accountId,
        tenantId: credential.tenantId,
        expiresAt: credential.expiresAt,
        renewalToken: credential.renewalToken,
        tenantName: credential.tenantName,
        accountEmail: credential.accountEmail,
        grantExpiresAt: credential.grantExpiresAt,
        permissionKeys: credential.permissionKeys,
        deniedPermissionKeys: credential.deniedPermissionKeys
    };
}

function devicePromptText(prompt: Extract<LoginPrompt, { flow: 'device' }>, noWait: boolean): string {
    const link = prompt.verificationUriComplete ?? prompt.verificationUri;
    const lines = [
        '',
        'To sign in to ZynoHosting, open this link on any device:',
        '',
        `    ${link}`,
        '',
        ...(prompt.verificationUriComplete
            ? [`Or go to ${prompt.verificationUri} and type this code: ${prompt.userCode}`, '']
            : [`and type this code: ${prompt.userCode}`, '']),
        'Check that the code matches, choose how long this access lasts, then approve it.',
        'Only approve a sign-in you started yourself. If someone sent you this link or code, do not approve it.',
        `The code expires at ${new Date(prompt.expiresAt).toLocaleTimeString()}.`,
        ''
    ];
    lines.push(noWait ? 'After you approve it, run: zynohosting login --resume' : 'Waiting for approval…');
    return `${lines.join('\n')}\n`;
}

function parseLifetime(value: string | undefined, renewable: boolean): number | undefined {
    if (value === undefined) return undefined;
    const seconds = (LOGIN_LIFETIMES as Record<string, number>)[value];
    if (seconds === undefined) {
        throw new CliError(`Lifetime must be one of ${Object.keys(LOGIN_LIFETIMES).join(', ')}.`, 2, 'invalid_lifetime');
    }
    if (!renewable && seconds !== LOGIN_LIFETIMES['1h']) {
        throw new CliError('A lifetime longer than 1h needs --renewable. Without it the login lasts 1 hour.', 2, 'invalid_lifetime');
    }
    return seconds;
}

function chooseStoreKind(flag: string | undefined, env: NodeJS.ProcessEnv, renewable: boolean): 'system' | 'file' {
    if (flag !== undefined && flag !== 'system' && flag !== 'file') {
        throw new CliError('--credential-store must be "system" or "file".', 2, 'invalid_credential_store');
    }
    if (flag !== undefined && !renewable) {
        throw new CliError('--credential-store only applies to a renewable login. Add --renewable.', 2, 'invalid_credential_store');
    }
    if (!renewable) return 'system';
    const fromEnv = env.ZYNOHOSTING_CREDENTIAL_STORE?.trim();
    if (flag === undefined && fromEnv && fromEnv !== 'system' && fromEnv !== 'file') {
        throw new CliError('ZYNOHOSTING_CREDENTIAL_STORE must be "system" or "file".', 2, 'invalid_credential_store');
    }
    return (flag ?? (fromEnv || undefined) ?? 'system') as 'system' | 'file';
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
