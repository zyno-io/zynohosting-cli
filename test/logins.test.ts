import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { RenewalTokenStore } from '../src/auth/renewal-token-store.js';

import { createFileRenewalTokenStore } from '../src/auth/file-renewal-token-store.js';
import { createProgram } from '../src/cli.js';
import { login } from '../src/commands/login.js';
import { listLogins, useLogin, whoami } from '../src/commands/logins.js';
import { logout } from '../src/commands/logout.js';
import { loadConfigFile, resolveConfig, updateProfile } from '../src/config.js';
import { CliError } from '../src/errors.js';

const API_URL = 'https://hosting.api-alpha.zyno.dev';
const AUTH_URL = 'https://auth.api-alpha.zyno.dev';
const ACME = '00000000-0000-0000-0000-0000000000a1';
const GLOBEX = '00000000-0000-0000-0000-0000000000b2';
/** The login id of a login whose account is unknown (its test token has no readable `sub`). */
const U = (tenantId: string) => `unknown:${tenantId}`;
const KEY_ACME = '11111111-1111-4111-8111-111111111111';
const KEY_GLOBEX = '22222222-2222-4222-8222-222222222222';

class MemoryStore implements RenewalTokenStore {
    constructor(public values = new Map<string, string>()) {}
    async get(key: string) {
        return this.values.get(key);
    }
    async set(key: string, token: string) {
        this.values.set(key, token);
    }
    async delete(key: string) {
        this.values.delete(key);
    }
}

async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-logins-'));
    const file = join(root, 'config.json');
    return { root, file, env: { ZYNOHOSTING_CONFIG: file } as NodeJS.ProcessEnv };
}

function savedLogin(tenantId: string, tenantName: string, extra: Record<string, unknown> = {}) {
    return {
        tenantId,
        tenantName,
        accountEmail: 'owner@example.com',
        accessToken: `${tenantName.toLowerCase()}.jwt.signature`,
        expiresAt: Date.now() + 3_600_000,
        scopedToken: true as const,
        ...extra
    };
}

/** Two saved logins for alpha, with Globex active. */
async function twoLogins(file: string, extra: { activeLogin?: string | null } = {}) {
    await updateProfile(
        'alpha',
        {
            apiUrl: API_URL,
            authApiUrl: AUTH_URL,
            logins: { [ACME]: savedLogin(ACME, 'Acme Co'), [GLOBEX]: savedLogin(GLOBEX, 'Globex') },
            ...(extra.activeLogin === null ? {} : { activeLogin: extra.activeLogin ?? GLOBEX })
        },
        file
    );
}

function token(config: Awaited<ReturnType<typeof resolveConfig>>): string | undefined {
    return config.credential.type === 'bearer' ? config.credential.accessToken : undefined;
}

test('selection: --tenant, then ZYNOHOSTING_TENANT, then the active login', async () => {
    const { file, env } = await setup();
    await twoLogins(file);
    assert.equal(token(await resolveConfig({ environment: 'alpha' }, env)), 'globex.jwt.signature');
    assert.equal(token(await resolveConfig({ environment: 'alpha' }, { ...env, ZYNOHOSTING_TENANT: 'Acme Co' })), 'acme co.jwt.signature');
    assert.equal(token(await resolveConfig({ environment: 'alpha', tenant: GLOBEX }, { ...env, ZYNOHOSTING_TENANT: ACME })), 'globex.jwt.signature');
    // Names match case-insensitively; ids match exactly.
    assert.equal(token(await resolveConfig({ environment: 'alpha', tenant: 'acme CO' }, env)), 'acme co.jwt.signature');
    // Nothing sticky: the call above did not change the active login.
    assert.equal((await loadConfigFile(file)).profiles.alpha?.activeLogin, U(GLOBEX));
    const resolved = await resolveConfig({ environment: 'alpha', tenant: ACME }, env);
    assert.deepEqual(resolved.login, { id: U(ACME), kind: 'login', tenantId: ACME, tenantName: 'Acme Co', accountEmail: 'owner@example.com' });
});

test('an unknown or ambiguous tenant is an error that lists the candidates', async () => {
    const { file, env } = await setup();
    await twoLogins(file);
    await assert.rejects(resolveConfig({ environment: 'alpha', tenant: 'Initech' }, env), (error: unknown) => {
        assert(error instanceof CliError);
        assert.equal(error.code, 'login_not_found');
        assert.equal(error.exitCode, 2);
        assert.match(error.message, /Acme Co/);
        assert.match(error.message, /Globex/);
        return true;
    });
    await updateProfile(
        'alpha',
        { apiUrl: API_URL, logins: { [ACME]: savedLogin(ACME, 'Same'), [GLOBEX]: savedLogin(GLOBEX, 'same') }, activeLogin: ACME },
        file
    );
    await assert.rejects(
        resolveConfig({ environment: 'alpha', tenant: 'SAME' }, env),
        (error: unknown) =>
            error instanceof CliError && error.code === 'login_ambiguous' && error.message.includes(ACME) && error.message.includes(GLOBEX)
    );
    assert.equal(token(await resolveConfig({ environment: 'alpha', tenant: GLOBEX }, env)), 'same.jwt.signature');
});

test('several logins and none active is login_selection_required; one login needs no choice', async () => {
    const { file, env } = await setup();
    await twoLogins(file, { activeLogin: null });
    await assert.rejects(resolveConfig({ environment: 'alpha' }, env), (error: unknown) => {
        assert(error instanceof CliError);
        assert.equal(error.code, 'login_selection_required');
        assert.equal(error.exitCode, 2);
        assert.match(error.message, /Acme Co/);
        assert.match(error.message, /--tenant/);
        return true;
    });
    // An explicit choice still works, and so does an injected credential.
    assert.equal(token(await resolveConfig({ environment: 'alpha', tenant: 'Globex' }, env)), 'globex.jwt.signature');
    assert.equal(
        token(await resolveConfig({ environment: 'alpha' }, { ...env, ZYNOHOSTING_ACCESS_TOKEN: 'env.jwt.signature' })),
        'env.jwt.signature'
    );

    await updateProfile('alpha', { apiUrl: API_URL, logins: { [ACME]: savedLogin(ACME, 'Acme Co') } }, file);
    assert.equal(token(await resolveConfig({ environment: 'alpha' }, env)), 'acme co.jwt.signature');
});

test('a single-credential profile (v2 flat) migrates into one login and is written back in the new format', async () => {
    const { file, env } = await setup();
    await writeFile(
        file,
        JSON.stringify({
            version: 2,
            profiles: {
                alpha: { apiUrl: API_URL, accessToken: 'old.jwt.signature', tenantId: ACME, expiresAt: Date.now() + 3_600_000, scopedToken: true }
            }
        })
    );
    const config = await loadConfigFile(file);
    assert.equal(config.profiles.alpha?.logins?.[U(ACME)]?.accessToken, 'old.jwt.signature');
    assert.equal(config.profiles.alpha?.activeLogin, U(ACME));
    assert.equal(token(await resolveConfig({ environment: 'alpha' }, env)), 'old.jwt.signature');

    await useLogin(ACME, { environment: 'alpha' }, { env, write: () => {} });
    const raw = JSON.parse(await readFile(file, 'utf8')) as { profiles: { alpha: Record<string, unknown> } };
    assert.equal(raw.profiles.alpha.accessToken, undefined);
    assert.equal(raw.profiles.alpha.tenantId, undefined);
    assert.deepEqual(Object.keys(raw.profiles.alpha.logins as object), [U(ACME)]);
});

test('a login for another tenant adds to the profile and becomes active; the same tenant replaces its login', async () => {
    const { file, env } = await setup();
    const store = new MemoryStore();
    const revoked: string[] = [];
    const scopedTokenClient = () => ({
        async startDevice(): Promise<never> {
            throw new Error('unexpected');
        },
        async pollDevice(): Promise<never> {
            throw new Error('unexpected');
        },
        async cancelDevice() {},
        async revoke(accessToken: string) {
            revoked.push(accessToken);
        }
    });
    const signIn = async (tenantId: string, jwt: string, renewalToken: string) => {
        let failure: unknown;
        await login(
            { apiUrl: API_URL, loginUrl: 'https://zyno.dev/cli/login', renewable: true, timeoutSeconds: 5, device: false },
            {
                configFile: file,
                env,
                renewalTokenStore: store,
                scopedTokenClient,
                write: () => {},
                openUrl: async value => {
                    try {
                        const url = new URL(value);
                        const response = await fetch(url.searchParams.get('callback')!, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: new URLSearchParams({
                                jwt,
                                tenantId,
                                expiresAt: String(Date.now() + 3_600_000),
                                state: url.searchParams.get('state')!,
                                renewalToken,
                                tenantName: tenantId === ACME ? 'Acme Co' : 'Globex',
                                accountEmail: 'owner@example.com',
                                grantExpiresAt: String(Date.now() + 7 * 86_400_000)
                            })
                        });
                        assert.equal(response.status, 200);
                    } catch (error) {
                        failure = error;
                    }
                }
            }
        );
        if (failure) throw failure;
    };

    await signIn(ACME, 'acme1.jwt.signature', 'zrt_acme1');
    await signIn(GLOBEX, 'globex.jwt.signature', 'zrt_globex');
    let profile = (await loadConfigFile(file)).profiles.alpha!;
    assert.deepEqual(Object.keys(profile.logins ?? {}).sort(), [U(ACME), U(GLOBEX)]);
    assert.equal(profile.activeLogin, U(GLOBEX));
    assert.equal(profile.logins?.[U(ACME)]?.tenantName, 'Acme Co');
    assert.equal(typeof profile.logins?.[U(ACME)]?.grantExpiresAt, 'number');
    assert.equal(store.values.size, 2);
    assert.deepEqual(revoked, []);

    const firstKey = profile.logins![U(ACME)]!.renewalKey!;
    await signIn(ACME, 'acme2.jwt.signature', 'zrt_acme2');
    profile = (await loadConfigFile(file)).profiles.alpha!;
    assert.equal(profile.logins?.[U(ACME)]?.accessToken, 'acme2.jwt.signature');
    assert.equal(profile.activeLogin, U(ACME));
    assert.equal(Object.keys(profile.logins ?? {}).length, 2);
    // The replaced grant is revoked (best effort) and its renewal token removed.
    assert.deepEqual(revoked, ['acme1.jwt.signature']);
    assert.equal(store.values.has(firstKey), false);
    assert.equal(store.values.size, 2);
});

test('renewal is per login: only the login in use renews, with its own key and store', async () => {
    const { file, env } = await setup();
    const store = new MemoryStore(
        new Map([
            [KEY_ACME, 'zrt_acme'],
            [KEY_GLOBEX, 'zrt_globex']
        ])
    );
    await updateProfile(
        'alpha',
        {
            apiUrl: API_URL,
            authApiUrl: AUTH_URL,
            logins: {
                [ACME]: savedLogin(ACME, 'Acme Co', { renewalKey: KEY_ACME, expiresAt: Date.now() - 1 }),
                [GLOBEX]: savedLogin(GLOBEX, 'Globex', { renewalKey: KEY_GLOBEX, expiresAt: Date.now() - 1 })
            },
            activeLogin: ACME
        },
        file
    );
    const renewed: string[] = [];
    const expiresAt = Date.now() + 3_600_000;
    const resolved = await resolveConfig({ environment: 'alpha', tenant: GLOBEX }, env, {
        renewalTokenStore: store,
        scopedTokenClient: () => ({
            async renew(value: string) {
                renewed.push(value);
                return {
                    jwt: 'globex2.jwt.signature',
                    expiresAt,
                    renewalToken: 'zrt_globex2',
                    tenantName: 'Globex Inc',
                    grantExpiresAt: Date.now() + 86_400_000
                };
            }
        })
    });
    assert.deepEqual(renewed, ['zrt_globex']);
    assert.equal(token(resolved), 'globex2.jwt.signature');
    const profile = (await loadConfigFile(file)).profiles.alpha!;
    assert.equal(profile.logins?.[U(GLOBEX)]?.accessToken, 'globex2.jwt.signature');
    assert.equal(profile.logins?.[U(GLOBEX)]?.tenantName, 'Globex Inc');
    assert.equal(typeof profile.logins?.[U(GLOBEX)]?.grantExpiresAt, 'number');
    assert.equal(profile.logins?.[U(ACME)]?.accessToken, 'acme co.jwt.signature');
    assert.equal(profile.activeLogin, U(ACME));
    assert.equal(store.values.get(KEY_GLOBEX), 'zrt_globex2');
    assert.equal(store.values.get(KEY_ACME), 'zrt_acme');
});

test('logins lists every login with the active one marked, as JSON or a table', async () => {
    const { file, env } = await setup();
    await updateProfile(
        'alpha',
        {
            apiUrl: API_URL,
            logins: {
                [ACME]: savedLogin(ACME, 'Acme Co', { renewalKey: KEY_ACME, grantExpiresAt: Date.now() + 5 * 86_400_000 }),
                [GLOBEX]: savedLogin(GLOBEX, 'Globex', { renewalKey: KEY_GLOBEX, grantExpiresAt: Date.now() - 1000 })
            },
            activeLogin: ACME
        },
        file
    );
    const output: string[] = [];
    const logins = await listLogins({ environment: 'alpha', json: true }, { env, write: message => output.push(message) });
    const parsed = JSON.parse(output.join('')) as { profile: string; logins: typeof logins };
    assert.equal(parsed.profile, 'alpha');
    assert.deepEqual(
        parsed.logins.map(item => [item.loginId, item.tenantName, item.active, item.expired, item.renewable]),
        [
            [U(ACME), 'Acme Co', true, false, true],
            [U(GLOBEX), 'Globex', false, true, true]
        ]
    );
    assert.equal(parsed.logins[0]!.accountEmail, 'owner@example.com');
    assert.match(parsed.logins[0]!.grantExpiresAt ?? '', /^\d{4}-\d\d-\d\dT/);
    assert(!JSON.stringify(parsed).includes('jwt.signature'), 'tokens are never listed');

    const table: string[] = [];
    await listLogins({ environment: 'alpha' }, { env, write: message => table.push(message) });
    assert.match(table.join(''), /\* *Acme Co/);
    assert.match(table.join(''), /Globex.*expired/);

    const empty: string[] = [];
    await listLogins({ environment: 'dev' }, { env, write: message => empty.push(message) });
    assert.match(empty.join(''), /No saved logins/);
});

test('logins use switches the active login by id or unique name and rejects strangers', async () => {
    const { file, env } = await setup();
    await twoLogins(file);
    await useLogin('acme co', { environment: 'alpha' }, { env, write: () => {} });
    assert.equal((await loadConfigFile(file)).profiles.alpha?.activeLogin, U(ACME));
    await useLogin(GLOBEX, { environment: 'alpha' }, { env, write: () => {} });
    assert.equal((await loadConfigFile(file)).profiles.alpha?.activeLogin, U(GLOBEX));
    await assert.rejects(
        useLogin('Initech', { environment: 'alpha' }, { env, write: () => {} }),
        (error: unknown) => error instanceof CliError && error.code === 'login_not_found'
    );
    await assert.rejects(
        useLogin('x', { environment: 'dev' }, { env, write: () => {} }),
        (error: unknown) => error instanceof CliError && error.code === 'missing_config'
    );
    const output: string[] = [];
    const who = await whoami({ environment: 'alpha', tenant: 'Acme Co' }, { env, write: message => output.push(message) });
    assert.match(output.join(''), /Signed in to alpha as owner@example\.com \(Acme Co\)/);
    assert(!Array.isArray(who) && who.loginId === U(ACME));
});

test('logout removes the active login, --tenant removes another, and the active one is re-chosen only when unambiguous', async () => {
    const { file, env } = await setup();
    const store = new MemoryStore(
        new Map([
            [KEY_ACME, 'zrt_acme'],
            [KEY_GLOBEX, 'zrt_globex']
        ])
    );
    const revoked: string[] = [];
    const dependencies = {
        configFile: file,
        env,
        write: () => {},
        renewalTokenStore: store,
        scopedTokenClient: () => ({
            async renew(): Promise<never> {
                throw new Error('unexpected renew');
            },
            async revoke(accessToken: string) {
                revoked.push(accessToken);
            }
        })
    };
    const seed = async () => {
        store.values.set(KEY_ACME, 'zrt_acme');
        store.values.set(KEY_GLOBEX, 'zrt_globex');
        await updateProfile(
            'alpha',
            {
                apiUrl: API_URL,
                authApiUrl: AUTH_URL,
                logins: {
                    [ACME]: savedLogin(ACME, 'Acme Co', { renewalKey: KEY_ACME }),
                    [GLOBEX]: savedLogin(GLOBEX, 'Globex', { renewalKey: KEY_GLOBEX })
                },
                activeLogin: GLOBEX
            },
            file
        );
    };

    await seed();
    await logout({ environment: 'alpha' }, dependencies);
    let profile = (await loadConfigFile(file)).profiles.alpha!;
    assert.deepEqual(Object.keys(profile.logins ?? {}), [U(ACME)]);
    assert.equal(profile.activeLogin, U(ACME));
    assert.deepEqual(revoked, ['globex.jwt.signature']);
    assert.equal(store.values.has(KEY_GLOBEX), false);
    assert.equal(store.values.has(KEY_ACME), true);

    revoked.length = 0;
    await seed();
    await logout({ environment: 'alpha', tenant: 'Acme Co' }, dependencies);
    profile = (await loadConfigFile(file)).profiles.alpha!;
    assert.deepEqual(Object.keys(profile.logins ?? {}), [U(GLOBEX)]);
    assert.equal(profile.activeLogin, U(GLOBEX));
    assert.deepEqual(revoked, ['acme co.jwt.signature']);

    // Without an active login and without --tenant, a logout must not guess.
    await seed();
    await updateProfile('alpha', { apiUrl: API_URL, authApiUrl: AUTH_URL, logins: (await loadConfigFile(file)).profiles.alpha!.logins! }, file);
    await assert.rejects(
        logout({ environment: 'alpha' }, dependencies),
        (error: unknown) => error instanceof CliError && error.code === 'login_selection_required'
    );

    revoked.length = 0;
    await logout({ all: true }, dependencies);
    assert.deepEqual((await loadConfigFile(file)).profiles, {});
    assert.deepEqual(revoked.sort(), ['acme co.jwt.signature', 'globex.jwt.signature']);
    assert.equal(store.values.size, 0);
});

test('logout keeps the other logins of a profile, and an API key lives next to them', async () => {
    const { file, env } = await setup();
    await updateProfile('alpha', { apiUrl: API_URL, apiKey: 'key-1', logins: { [ACME]: savedLogin(ACME, 'Acme Co') }, activeLogin: 'api-key' }, file);
    const output: string[] = [];
    const listed = await listLogins({ environment: 'alpha', json: true }, { env, write: message => output.push(message) });
    assert.deepEqual(
        listed.map(item => [item.loginId, item.kind, item.tenantName, item.active]),
        [
            [U(ACME), 'login', 'Acme Co', false],
            ['api-key', 'api-key', 'API key', true]
        ]
    );
    assert.equal(((await resolveConfig({ environment: 'alpha' }, env)).credential as { apiKey: string }).apiKey, 'key-1');
    await logout(
        { environment: 'alpha' },
        {
            configFile: file,
            env,
            write: () => {},
            scopedTokenClient: () => ({ renew: async () => Promise.reject(new Error('no')), revoke: async () => {} })
        }
    );
    const profile = (await loadConfigFile(file)).profiles.alpha!;
    assert.equal(profile.apiKey, undefined);
    assert.deepEqual(Object.keys(profile.logins ?? {}), [U(ACME)]);
    assert.equal(profile.activeLogin, U(ACME));
});

test('the CLI accepts --tenant, lists logins as JSON, and `logins use` switches the active one', async () => {
    const { file } = await setup();
    await twoLogins(file);
    const original = { config: process.env.ZYNOHOSTING_CONFIG, write: process.stdout.write.bind(process.stdout) };
    const captured: string[] = [];
    process.env.ZYNOHOSTING_CONFIG = file;
    process.stdout.write = ((chunk: string | Uint8Array) => {
        captured.push(String(chunk));
        return true;
    }) as typeof process.stdout.write;
    try {
        await createProgram().parseAsync(['node', 'zynohosting', '--environment', 'alpha', 'logins', '--json']);
        await createProgram().parseAsync(['node', 'zynohosting', 'whoami', '--environment', 'alpha', '--tenant', 'Acme Co', '--json']);
        await createProgram().parseAsync(['node', 'zynohosting', 'logins', 'use', 'Acme Co', '--environment', 'alpha']);
    } finally {
        process.stdout.write = original.write;
        if (original.config === undefined) delete process.env.ZYNOHOSTING_CONFIG;
        else process.env.ZYNOHOSTING_CONFIG = original.config;
    }
    const [listing, current] = captured.slice(0, 2).map(text => JSON.parse(text) as Record<string, unknown>);
    assert.equal((listing!.logins as unknown[]).length, 2);
    assert.equal((current!.login as { loginId: string }).loginId, U(ACME));
    assert.equal((await loadConfigFile(file)).profiles.alpha?.activeLogin, U(ACME));
});

test('a login using the file store renews through the token file under the profile lock, and logout removes its entry', async () => {
    const { root, file, env } = await setup();
    const tokenStore = createFileRenewalTokenStore(file);
    await tokenStore.set(KEY_ACME, 'zrt_acme');
    await tokenStore.set(KEY_GLOBEX, 'zrt_orphan');
    await updateProfile(
        'alpha',
        {
            apiUrl: API_URL,
            authApiUrl: AUTH_URL,
            logins: { [ACME]: savedLogin(ACME, 'Acme Co', { renewalKey: KEY_ACME, renewalStore: 'file', expiresAt: Date.now() - 1 }) },
            activeLogin: ACME
        },
        file
    );
    const renewed: string[] = [];
    const resolved = await resolveConfig({ environment: 'alpha' }, env, {
        scopedTokenClient: () => ({
            async renew(value: string) {
                renewed.push(value);
                // The profiles lock is held for the whole renewal.
                await stat(`${file}.renew.lock`);
                return { jwt: 'acme2.jwt.signature', expiresAt: Date.now() + 3_600_000, renewalToken: 'zrt_acme2' };
            }
        })
    });
    assert.deepEqual(renewed, ['zrt_acme']);
    assert.equal(token(resolved), 'acme2.jwt.signature');
    assert.equal(await tokenStore.get(KEY_ACME), 'zrt_acme2');
    await assert.rejects(stat(`${file}.renew.lock`));
    await assert.rejects(stat(`${tokenStore.path}.renew.lock`));
    assert.doesNotMatch(await readFile(file, 'utf8'), /zrt_/);

    // Logout deletes the login's own entry. The orphan is too fresh to prune, so it stays for now.
    await logout(
        { environment: 'alpha' },
        {
            configFile: file,
            env,
            write: () => {},
            scopedTokenClient: () => ({ renew: async () => Promise.reject(new Error('no')), revoke: async () => {} })
        }
    );
    assert.equal(await tokenStore.get(KEY_ACME), undefined);
    assert.equal(await tokenStore.get(KEY_GLOBEX), 'zrt_orphan');
    void root;
});

test('logout --all prunes token-file entries that no profile references once they are old enough', async () => {
    const { file, env } = await setup();
    const tokenStore = createFileRenewalTokenStore(file);
    await tokenStore.set(KEY_GLOBEX, 'zrt_orphan');
    // Age the orphan by rewriting its timestamp.
    const aged = JSON.parse(await readFile(tokenStore.path, 'utf8')) as { tokens: Record<string, { updatedAt: number }> };
    aged.tokens[KEY_GLOBEX]!.updatedAt = Date.now() - 2 * 3_600_000;
    await writeFile(tokenStore.path, JSON.stringify(aged), { mode: 0o600 });
    await updateProfile('alpha', { apiUrl: API_URL, apiKey: 'key-1' }, file);
    await logout({ all: true }, { configFile: file, env, write: () => {} });
    await assert.rejects(stat(tokenStore.path));
});

test('signing in again to a tenant whose access token expired renews it to revoke the old grant, then removes the old key', async () => {
    const { file, env } = await setup();
    const store = new MemoryStore(new Map([[KEY_ACME, 'zrt_old']]));
    await updateProfile(
        'alpha',
        {
            apiUrl: API_URL,
            authApiUrl: AUTH_URL,
            logins: { [ACME]: savedLogin(ACME, 'Acme Co', { renewalKey: KEY_ACME, expiresAt: Date.now() - 1000 }) },
            activeLogin: ACME
        },
        file
    );
    const calls: string[] = [];
    let failure: unknown;
    await login(
        { apiUrl: API_URL, loginUrl: 'https://zyno.dev/cli/login', renewable: true, timeoutSeconds: 5, device: false },
        {
            configFile: file,
            env,
            renewalTokenStore: store,
            write: () => {},
            scopedTokenClient: () => ({
                async startDevice(): Promise<never> {
                    throw new Error('unexpected');
                },
                async pollDevice(): Promise<never> {
                    throw new Error('unexpected');
                },
                async cancelDevice() {},
                async renew(token: string) {
                    calls.push(`renew ${token}`);
                    return { jwt: 'renewed.jwt.signature', expiresAt: Date.now() + 3_600_000, renewalToken: 'zrt_rotated' };
                },
                async revoke(accessToken: string) {
                    calls.push(`revoke ${accessToken}`);
                }
            }),
            openUrl: async value => {
                try {
                    const url = new URL(value);
                    const response = await fetch(url.searchParams.get('callback')!, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            jwt: 'new.jwt.signature',
                            tenantId: ACME,
                            expiresAt: String(Date.now() + 3_600_000),
                            state: url.searchParams.get('state')!,
                            renewalToken: 'zrt_new'
                        })
                    });
                    assert.equal(response.status, 200);
                } catch (error) {
                    failure = error;
                }
            }
        }
    );
    if (failure) throw failure;
    assert.deepEqual(calls, ['renew zrt_old', 'revoke renewed.jwt.signature']);
    assert.equal(store.values.has(KEY_ACME), false);
    assert.equal(store.values.size, 1);
});

test('an explicit tenant alongside an injected credential is fixed_credential_source, not silently ignored', async () => {
    const { file, env } = await setup();
    await twoLogins(file);
    const rejected = (error: unknown) => error instanceof CliError && error.code === 'fixed_credential_source' && error.exitCode === 2;
    await assert.rejects(resolveConfig({ environment: 'alpha', tenant: 'Acme Co' }, { ...env, ZYNOHOSTING_API_KEY: 'key' }), rejected);
    await assert.rejects(resolveConfig({ environment: 'alpha', apiKey: 'key', tenant: GLOBEX }, env), rejected);
    await assert.rejects(
        resolveConfig({ environment: 'alpha' }, { ...env, ZYNOHOSTING_ACCESS_TOKEN: 'a.b.c', ZYNOHOSTING_TENANT: 'Acme Co' }),
        rejected
    );
    // Without a tenant choice an injected credential still works.
    assert.equal((await resolveConfig({ environment: 'alpha' }, { ...env, ZYNOHOSTING_API_KEY: 'key' })).credential.type, 'api-key');
});

test('profiles are written as version 3, version 2 is read, and an unknown version is refused untouched', async () => {
    const { file, env } = await setup();
    await writeFile(file, JSON.stringify({ version: 2, profiles: { alpha: { apiUrl: API_URL, accessToken: 'old.jwt.signature', tenantId: ACME } } }));
    await useLogin(ACME, { environment: 'alpha' }, { env, write: () => {} });
    assert.equal((JSON.parse(await readFile(file, 'utf8')) as { version: number }).version, 3);

    // What an older build that knows only version 2 sees: an error, never an empty file to overwrite.
    const future = JSON.stringify({ version: 4, profiles: { alpha: { apiUrl: API_URL } } });
    await writeFile(file, future);
    await assert.rejects(
        updateProfile('alpha', { apiUrl: API_URL, apiKey: 'k' }, file),
        (error: unknown) => error instanceof CliError && error.code === 'invalid_config'
    );
    assert.equal(await readFile(file, 'utf8'), future);
});

test('logout leaves a login that a concurrent sign-in replaced while it was being revoked', async () => {
    const { file, env } = await setup();
    const store = new MemoryStore(new Map([[KEY_ACME, 'zrt_old']]));
    await updateProfile(
        'alpha',
        { apiUrl: API_URL, authApiUrl: AUTH_URL, logins: { [ACME]: savedLogin(ACME, 'Acme Co', { renewalKey: KEY_ACME }) }, activeLogin: ACME },
        file
    );
    await logout(
        { environment: 'alpha' },
        {
            configFile: file,
            env,
            write: () => {},
            renewalTokenStore: store,
            scopedTokenClient: () => ({
                async renew(): Promise<never> {
                    throw new Error('unexpected');
                },
                async revoke() {
                    // Another process signs in to the same tenant while this revocation is in flight.
                    await updateProfile(
                        'alpha',
                        {
                            apiUrl: API_URL,
                            authApiUrl: AUTH_URL,
                            logins: { [ACME]: savedLogin(ACME, 'Acme Co', { renewalKey: KEY_GLOBEX, accessToken: 'new.jwt.signature' }) },
                            activeLogin: ACME
                        },
                        file
                    );
                }
            })
        }
    );
    assert.equal((await loadConfigFile(file)).profiles.alpha?.logins?.[U(ACME)]?.accessToken, 'new.jwt.signature');
    // The old login's renewal token is left alone too: it is not what the profile holds any more.
    assert.equal(store.values.get(KEY_ACME), 'zrt_old');
});

/** A token whose payload names the account, as ZynoAuth's scoped JWT does. */
function jwtFor(accountId: string, tag = 'a'): string {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'none' })}.${part({ sub: accountId, tag })}.signature`;
}

const ALICE = 'aaaaaaaa-0000-4000-8000-00000000000a';
const BOB = 'bbbbbbbb-0000-4000-8000-00000000000b';

/** Two accounts signed in to the same tenant, plus one in another tenant. */
async function twoAccounts(file: string) {
    await updateProfile(
        'alpha',
        {
            apiUrl: API_URL,
            authApiUrl: AUTH_URL,
            logins: {
                [`${ALICE}:${ACME}`]: savedLogin(ACME, 'Acme Co', {
                    accountId: ALICE,
                    accountEmail: 'alice@example.com',
                    accessToken: jwtFor(ALICE)
                }),
                [`${BOB}:${ACME}`]: savedLogin(ACME, 'Acme Co', { accountId: BOB, accountEmail: 'bob@example.com', accessToken: jwtFor(BOB) }),
                [`${ALICE}:${GLOBEX}`]: savedLogin(GLOBEX, 'Globex', {
                    accountId: ALICE,
                    accountEmail: 'alice@example.com',
                    accessToken: jwtFor(ALICE, 'g')
                })
            },
            activeLogin: `${ALICE}:${GLOBEX}`
        },
        file
    );
}

test('two accounts in one tenant coexist; a tenant that matches both is login_ambiguous until --account narrows it', async () => {
    const { file, env } = await setup();
    await twoAccounts(file);
    const profile = (await loadConfigFile(file)).profiles.alpha!;
    assert.deepEqual(Object.keys(profile.logins ?? {}).sort(), [`${ALICE}:${ACME}`, `${ALICE}:${GLOBEX}`, `${BOB}:${ACME}`].sort());

    for (const query of [ACME, 'Acme Co']) {
        await assert.rejects(resolveConfig({ environment: 'alpha', tenant: query }, env), (error: unknown) => {
            assert(error instanceof CliError);
            assert.equal(error.code, 'login_ambiguous');
            assert.equal(error.exitCode, 2);
            for (const text of [`${ALICE}:${ACME}`, `${BOB}:${ACME}`, 'alice@example.com', 'bob@example.com', 'Acme Co'])
                assert(error.message.includes(text), text);
            assert(!error.message.includes(`${ALICE}:${GLOBEX}`));
            return true;
        });
    }
    const bob = await resolveConfig({ environment: 'alpha', tenant: 'Acme Co', account: 'BOB@example.com' }, env);
    assert.equal(bob.login?.id, `${BOB}:${ACME}`);
    assert.equal(token(bob), jwtFor(BOB));
    assert.equal(token(await resolveConfig({ environment: 'alpha', tenant: ACME, account: ALICE }, env)), jwtFor(ALICE));
    // A full login id needs no account, and ZYNOHOSTING_ACCOUNT narrows like the flag.
    assert.equal((await resolveConfig({ environment: 'alpha', tenant: `${BOB}:${ACME}` }, env)).login?.accountId, BOB);
    assert.equal(
        token(await resolveConfig({ environment: 'alpha', tenant: 'Acme Co' }, { ...env, ZYNOHOSTING_ACCOUNT: 'alice@example.com' })),
        jwtFor(ALICE)
    );
    await assert.rejects(
        resolveConfig({ environment: 'alpha', tenant: 'Acme Co', account: 'carol@example.com' }, env),
        (error: unknown) => error instanceof CliError && error.code === 'login_not_found'
    );
    // An account alone picks the one login that account has, when that is unambiguous.
    assert.equal((await resolveConfig({ environment: 'alpha', account: BOB }, env)).login?.id, `${BOB}:${ACME}`);

    // logins use and logout take the same selectors.
    await assert.rejects(
        useLogin('Acme Co', { environment: 'alpha' }, { env, write: () => {} }),
        (error: unknown) => error instanceof CliError && error.code === 'login_ambiguous'
    );
    await useLogin('Acme Co', { environment: 'alpha', account: 'bob@example.com' }, { env, write: () => {} });
    assert.equal((await loadConfigFile(file)).profiles.alpha?.activeLogin, `${BOB}:${ACME}`);
    const listed = await listLogins({ environment: 'alpha', json: true }, { env, write: () => {} });
    assert.deepEqual(
        listed.map(item => [item.loginId, item.accountId, item.accountEmail, item.tenantId, item.tenantName, item.active]).sort(),
        [
            [`${ALICE}:${ACME}`, ALICE, 'alice@example.com', ACME, 'Acme Co', false],
            [`${ALICE}:${GLOBEX}`, ALICE, 'alice@example.com', GLOBEX, 'Globex', false],
            [`${BOB}:${ACME}`, BOB, 'bob@example.com', ACME, 'Acme Co', true]
        ].sort()
    );
    await assert.rejects(
        logout({ environment: 'alpha', tenant: 'Acme Co', account: 'nobody@example.com' }, { configFile: file, env, write: () => {} }),
        (error: unknown) => error instanceof CliError && error.code === 'login_not_found'
    );
});

test('signing in again replaces and revokes only the same account and tenant pair', async () => {
    const { file, env } = await setup();
    await twoAccounts(file);
    const store = new MemoryStore();
    const revoked: string[] = [];
    let failure: unknown;
    const signIn = async (accountId: string, tenantId: string, jwt: string) =>
        login(
            { apiUrl: API_URL, loginUrl: 'https://zyno.dev/cli/login', timeoutSeconds: 5, device: false },
            {
                configFile: file,
                env,
                renewalTokenStore: store,
                write: () => {},
                scopedTokenClient: () => ({
                    async startDevice(): Promise<never> {
                        throw new Error('unexpected');
                    },
                    async pollDevice(): Promise<never> {
                        throw new Error('unexpected');
                    },
                    async cancelDevice() {},
                    async revoke(accessToken: string) {
                        revoked.push(accessToken);
                    }
                }),
                openUrl: async value => {
                    try {
                        const url = new URL(value);
                        const response = await fetch(url.searchParams.get('callback')!, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: new URLSearchParams({
                                jwt,
                                tenantId,
                                accountId,
                                expiresAt: String(Date.now() + 3_600_000),
                                state: url.searchParams.get('state')!,
                                tenantName: tenantId === ACME ? 'Acme Co' : 'Globex',
                                accountEmail: accountId === ALICE ? 'alice@example.com' : 'bob@example.com'
                            })
                        });
                        assert.equal(response.status, 200);
                    } catch (error) {
                        failure = error;
                    }
                }
            }
        );
    await signIn(BOB, ACME, jwtFor(BOB, 'second'));
    if (failure) throw failure;
    const profile = (await loadConfigFile(file)).profiles.alpha!;
    assert.equal(Object.keys(profile.logins ?? {}).length, 3);
    assert.equal(profile.logins?.[`${BOB}:${ACME}`]?.accessToken, jwtFor(BOB, 'second'));
    assert.equal(profile.logins?.[`${ALICE}:${ACME}`]?.accessToken, jwtFor(ALICE));
    assert.equal(profile.activeLogin, `${BOB}:${ACME}`);
    assert.deepEqual(revoked, [jwtFor(BOB)]);

    // A brand new account in that tenant adds a fourth login and revokes nothing.
    revoked.length = 0;
    await signIn('cccccccc-0000-4000-8000-00000000000c', ACME, jwtFor('cccccccc-0000-4000-8000-00000000000c'));
    if (failure) throw failure;
    assert.equal(Object.keys((await loadConfigFile(file)).profiles.alpha?.logins ?? {}).length, 4);
    assert.deepEqual(revoked, []);
});

test('logins saved by tenant id migrate to account:tenant keys using the token subject, or stay under unknown:', async () => {
    const { file, env } = await setup();
    // A version 3 file from before accounts were part of the key, and a flat version 2 profile.
    await writeFile(
        file,
        JSON.stringify({
            version: 3,
            profiles: {
                alpha: {
                    apiUrl: API_URL,
                    logins: {
                        [ACME]: savedLogin(ACME, 'Acme Co', { accessToken: jwtFor(ALICE) }),
                        [GLOBEX]: savedLogin(GLOBEX, 'Globex', { accessToken: 'not-a-jwt' })
                    },
                    activeLogin: ACME
                },
                dev: {
                    apiUrl: 'http://localhost:39840',
                    accessToken: jwtFor(BOB),
                    tenantId: ACME,
                    expiresAt: Date.now() + 3_600_000,
                    scopedToken: true
                }
            }
        })
    );
    const config = await loadConfigFile(file);
    assert.deepEqual(Object.keys(config.profiles.alpha?.logins ?? {}).sort(), [`${ALICE}:${ACME}`, `unknown:${GLOBEX}`].sort());
    assert.equal(config.profiles.alpha?.activeLogin, `${ALICE}:${ACME}`);
    assert.equal(config.profiles.alpha?.logins?.[`${ALICE}:${ACME}`]?.accountId, ALICE);
    assert.equal(config.profiles.alpha?.logins?.[`unknown:${GLOBEX}`]?.accountId, undefined);
    assert.deepEqual(Object.keys(config.profiles.dev?.logins ?? {}), [`${BOB}:${ACME}`]);
    assert.equal(config.profiles.dev?.activeLogin, `${BOB}:${ACME}`);
    // Both stay usable, by tenant name or by the unknown-account id.
    assert.equal(token(await resolveConfig({ environment: 'alpha' }, env)), jwtFor(ALICE));
    assert.equal(token(await resolveConfig({ environment: 'alpha', tenant: 'Globex' }, env)), 'not-a-jwt');
    // Re-saving writes the new keys, and migrating again changes nothing.
    await useLogin('Globex', { environment: 'alpha' }, { env, write: () => {} });
    const raw = JSON.parse(await readFile(file, 'utf8')) as { profiles: { alpha: { logins: object; activeLogin: string } } };
    assert.deepEqual(Object.keys(raw.profiles.alpha.logins).sort(), [`${ALICE}:${ACME}`, `unknown:${GLOBEX}`].sort());
    assert.equal(raw.profiles.alpha.activeLogin, `unknown:${GLOBEX}`);
});

test('logins lists what each login was granted and what it was not', async () => {
    const { file, env } = await setup();
    await updateProfile(
        'alpha',
        {
            apiUrl: API_URL,
            logins: {
                [ACME]: savedLogin(ACME, 'Acme Co', { permissionKeys: ['hosting.sitesRead'], deniedPermissionKeys: ['hosting.deploy'] }),
                [GLOBEX]: savedLogin(GLOBEX, 'Globex')
            },
            activeLogin: ACME
        },
        file
    );
    const output: string[] = [];
    const listed = await listLogins({ environment: 'alpha', json: true }, { env, write: message => output.push(message) });
    assert.deepEqual(listed[0]!.permissionKeys, ['hosting.sitesRead']);
    assert.deepEqual(listed[0]!.deniedPermissionKeys, ['hosting.deploy']);
    assert.equal(listed[1]!.permissionKeys, undefined);
    const table: string[] = [];
    await listLogins({ environment: 'alpha' }, { env, write: message => table.push(message) });
    assert.match(table.join(''), /1 \(1 not granted\)/);
});
