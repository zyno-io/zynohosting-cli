import { describeEntry, entryName, findEntry, loginEntries, selectEntry, type LoginEntry, type StoredConfig } from '../auth/logins.js';
import {
    configLocation,
    describeProfileKey,
    type HostingEnvironment,
    loadConfigFile,
    missingCredentialError,
    mutateProfile,
    selectProfile
} from '../config.js';
import { CliError } from '../errors.js';

export interface LoginsOptions {
    apiUrl?: string;
    environment?: HostingEnvironment;
    tenant?: string;
    account?: string;
    json?: boolean;
}

export interface LoginsDependencies {
    env?: NodeJS.ProcessEnv;
    configFile?: string;
    write?: (message: string) => void;
    now?: () => number;
}

/** One saved credential as listed to people and agents. Times are ISO strings. */
export interface LoginSummary {
    /** What to pass to `--tenant` or `logins use` to pick exactly this login: `<accountId>:<tenantId>` (or `api-key`). */
    loginId: string;
    kind: 'login' | 'api-key';
    accountId?: string;
    accountEmail?: string;
    tenantId?: string;
    tenantName: string;
    /** The login a command uses when no tenant is named. */
    active: boolean;
    renewable: boolean;
    /** What the login may do; absent when it was saved before permissions were recorded. */
    permissionKeys?: string[];
    /** Requested at sign-in but not granted. */
    deniedPermissionKeys?: string[];
    credentialStore?: 'system' | 'file';
    accessExpiresAt?: string;
    grantExpiresAt?: string;
    /** The approved lifetime has ended, or a login that cannot renew has run out. Using it fails until you log in again. */
    expired: boolean;
}

function summarize(entry: LoginEntry, active: boolean, now: number): LoginSummary {
    if (entry.kind === 'api-key') return { loginId: entry.id, kind: 'api-key', tenantName: 'API key', active, renewable: false, expired: false };
    const login = entry.login!;
    const expired =
        (login.grantExpiresAt !== undefined && login.grantExpiresAt <= now) ||
        (!login.renewalKey && login.expiresAt !== undefined && login.expiresAt <= now);
    return {
        loginId: entry.id,
        kind: 'login',
        ...(login.accountId ? { accountId: login.accountId } : {}),
        ...(login.accountEmail ? { accountEmail: login.accountEmail } : {}),
        tenantId: login.tenantId,
        tenantName: entryName(entry),
        active,
        renewable: Boolean(login.renewalKey),
        ...(login.permissionKeys ? { permissionKeys: login.permissionKeys } : {}),
        ...(login.deniedPermissionKeys ? { deniedPermissionKeys: login.deniedPermissionKeys } : {}),
        ...(login.renewalKey ? { credentialStore: login.renewalStore ?? ('system' as const) } : {}),
        ...(login.expiresAt === undefined ? {} : { accessExpiresAt: new Date(login.expiresAt).toISOString() }),
        ...(login.grantExpiresAt === undefined ? {} : { grantExpiresAt: new Date(login.grantExpiresAt).toISOString() }),
        expired
    };
}

/** The entry a command would use now, or undefined when the choice is unresolved (nothing saved, or several and none active). */
function currentEntry(profile: StoredConfig): LoginEntry | undefined {
    const entries = loginEntries(profile);
    return entries.find(entry => entry.id === profile.activeLogin) ?? (entries.length === 1 ? entries[0] : undefined);
}

export function summarizeLogins(profile: StoredConfig, now = Date.now()): LoginSummary[] {
    const current = currentEntry(profile);
    return loginEntries(profile).map(entry => summarize(entry, entry.id === current?.id, now));
}

function context(options: LoginsOptions, dependencies: LoginsDependencies) {
    const env = dependencies.env ?? process.env;
    const location = dependencies.configFile ?? configLocation(env);
    const key = selectProfile(options, env).key;
    const write = dependencies.write ?? ((message: string) => process.stdout.write(message));
    return { env, location, key, write, now: dependencies.now?.() ?? Date.now() };
}

/** The saved logins of the selected profile, without printing anything. */
export async function savedLogins(
    options: LoginsOptions = {},
    dependencies: LoginsDependencies = {}
): Promise<{ profile: string; logins: LoginSummary[] }> {
    const { location, key, now } = context(options, dependencies);
    const file = await loadConfigFile(location);
    return { profile: describeProfileKey(key), logins: summarizeLogins(file.profiles[key] ?? {}, now) };
}

export async function listLogins(options: LoginsOptions = {}, dependencies: LoginsDependencies = {}): Promise<LoginSummary[]> {
    const { key, write } = context(options, dependencies);
    const { logins } = await savedLogins(options, dependencies);
    if (options.json) {
        write(`${JSON.stringify({ profile: describeProfileKey(key), logins })}\n`);
        return logins;
    }
    if (logins.length === 0) {
        write(`No saved logins for ${describeProfileKey(key)}. Run \`zynohosting login\`.\n`);
        return logins;
    }
    const rows = logins.map(login => [
        login.active ? '*' : '',
        login.tenantName,
        login.accountEmail ?? login.accountId ?? '',
        login.loginId,
        login.permissionKeys
            ? `${login.permissionKeys.length}${login.deniedPermissionKeys?.length ? ` (${login.deniedPermissionKeys.length} not granted)` : ''}`
            : '',
        login.expired ? 'expired' : (login.accessExpiresAt?.slice(0, 16).replace('T', ' ') ?? ''),
        login.grantExpiresAt?.slice(0, 10) ?? (login.kind === 'login' && login.renewable ? 'no limit recorded' : '')
    ]);
    const header = ['', 'TENANT', 'ACCOUNT', 'LOGIN ID', 'PERMISSIONS', 'ACCESS ENDS (UTC)', 'RENEWS UNTIL'];
    const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => row[column]!.length)));
    const line = (cells: string[]) =>
        cells
            .map((cell, column) => cell.padEnd(widths[column]!))
            .join('  ')
            .trimEnd();
    write(`Logins for ${describeProfileKey(key)} (* = used by default)\n${[header, ...rows].map(line).join('\n')}\n`);
    return logins;
}

export async function useLogin(query: string, options: LoginsOptions = {}, dependencies: LoginsDependencies = {}): Promise<LoginSummary> {
    const { location, key, write, now } = context(options, dependencies);
    const label = describeProfileKey(key);
    let chosen: LoginEntry | undefined;
    await mutateProfile(
        key,
        current => {
            const entries = loginEntries(current);
            if (entries.length === 0) throw new CliError(`No saved logins for ${label}. Run \`zynohosting login\`.`, 2, 'missing_config');
            chosen = findEntry(entries, query, label, options.account);
            return { ...current, activeLogin: chosen.id };
        },
        location
    );
    const entry = chosen!;
    const summary = summarize(entry, true, now);
    if (options.json) write(`${JSON.stringify({ profile: label, active: summary })}\n`);
    else
        write(
            `Now using ${describeEntry(entry)} for ${label}.${summary.expired ? ' This login has expired; run `zynohosting login` to renew access.' : ''}\n`
        );
    return summary;
}

export async function whoami(
    options: LoginsOptions & { all?: boolean } = {},
    dependencies: LoginsDependencies = {}
): Promise<LoginSummary | LoginSummary[]> {
    if (options.all) return listLogins(options, dependencies);
    const { env, location, key, write, now } = context(options, dependencies);
    const file = await loadConfigFile(location);
    const entry = selectEntry(
        file.profiles[key] ?? {},
        options.tenant ?? env.ZYNOHOSTING_TENANT,
        describeProfileKey(key),
        options.account ?? env.ZYNOHOSTING_ACCOUNT
    );
    if (!entry) throw missingCredentialError(key, file);
    const summary = summarize(entry, true, now);
    if (options.json) write(`${JSON.stringify({ profile: describeProfileKey(key), login: summary })}\n`);
    else {
        const who = summary.accountEmail ? `${summary.accountEmail} (${summary.tenantName})` : summary.tenantName;
        write(`Signed in to ${describeProfileKey(key)} as ${who}${summary.expired ? ' (expired)' : ''}.\n`);
    }
    return summary;
}
