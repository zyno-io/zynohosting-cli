import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { RenewalTokenStore } from '../src/auth/renewal-token-store.js';

import { login } from '../src/commands/login.js';
import { logout } from '../src/commands/logout.js';
import {
    configLocation,
    loadConfigFile,
    profileKeyForApiUrl,
    resolveAuthApiUrl,
    resolveConfig,
    resolveSuiteApiUrl,
    selectProfile,
    updateProfile
} from '../src/config.js';
import { CliError, HttpError } from '../src/errors.js';

// The browser flow is what these tests exercise; a headless CI machine would otherwise pick the device flow.
process.env.DISPLAY ||= ':0';

const PRODUCTION_URL = 'https://hosting.api.zyno.app';
const ALPHA_URL = 'https://hosting.api-alpha.zyno.dev';
const CUSTOM_URL = 'https://hosting.example.com';
const RENEWAL_KEY = '11111111-1111-4111-8111-111111111111';

async function configFile(): Promise<{ file: string; env: NodeJS.ProcessEnv }> {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-profiles-'));
    const file = join(root, 'config.json');
    return { file, env: { ZYNOHOSTING_CONFIG: file } };
}

async function rawFile(file: string): Promise<{ version?: number; profiles?: Record<string, Record<string, unknown>> }> {
    return JSON.parse(await readFile(file, 'utf8')) as never;
}

async function saveKey(
    file: string,
    env: NodeJS.ProcessEnv,
    apiKey: string,
    options: { environment?: 'production' | 'alpha' | 'dev'; apiUrl?: string } = {}
) {
    await login({ ...options, apiKey }, { configFile: file, env, write: () => {} });
}

function apiKeyOf(config: Awaited<ReturnType<typeof resolveConfig>>): string | undefined {
    return config.credential.type === 'api-key' ? config.credential.apiKey : undefined;
}

test('profile keys map environment URLs to names and other URLs to url: keys', () => {
    assert.equal(profileKeyForApiUrl(PRODUCTION_URL), 'production');
    assert.equal(profileKeyForApiUrl(`${ALPHA_URL}/`), 'alpha');
    assert.equal(profileKeyForApiUrl('http://localhost:39840'), 'dev');
    assert.equal(profileKeyForApiUrl(`${CUSTOM_URL}/`), `url:${CUSTOM_URL}`);
});

test('login to alpha preserves production and the reverse, in a 0600 v2 file', async () => {
    const { file, env } = await configFile();
    await saveKey(file, env, 'prod-key');
    await saveKey(file, env, 'alpha-key', { environment: 'alpha' });
    let raw = await rawFile(file);
    assert.equal(raw.version, 3);
    assert.deepEqual(Object.keys(raw.profiles ?? {}).sort(), ['alpha', 'production']);
    assert.equal(raw.profiles?.production?.apiKey, 'prod-key');
    assert.equal(raw.profiles?.alpha?.apiKey, 'alpha-key');

    await saveKey(file, env, 'prod-key-2');
    raw = await rawFile(file);
    assert.equal(raw.profiles?.production?.apiKey, 'prod-key-2');
    assert.equal(raw.profiles?.alpha?.apiKey, 'alpha-key');
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('selection precedence: --api-url, --environment, ZYNOHOSTING_API_URL, ZYNOHOSTING_ENVIRONMENT, production', async () => {
    const { file, env } = await configFile();
    await saveKey(file, env, 'prod-key');
    await saveKey(file, env, 'alpha-key', { environment: 'alpha' });
    await saveKey(file, env, 'dev-key', { environment: 'dev' });
    await saveKey(file, env, 'custom-key', { apiUrl: CUSTOM_URL });
    assert.equal((await rawFile(file)).profiles?.[`url:${CUSTOM_URL}`]?.apiKey, 'custom-key');

    // No sticky environment: logging in elsewhere never changes the default.
    assert.equal(apiKeyOf(await resolveConfig({}, env)), 'prod-key');
    assert.equal(apiKeyOf(await resolveConfig({ environment: 'alpha' }, env)), 'alpha-key');
    assert.equal(apiKeyOf(await resolveConfig({}, { ...env, ZYNOHOSTING_ENVIRONMENT: 'dev' })), 'dev-key');
    assert.equal(apiKeyOf(await resolveConfig({ environment: 'alpha' }, { ...env, ZYNOHOSTING_ENVIRONMENT: 'dev' })), 'alpha-key');
    assert.equal(apiKeyOf(await resolveConfig({ environment: 'alpha', apiUrl: CUSTOM_URL }, env)), 'custom-key');
    assert.equal(apiKeyOf(await resolveConfig({ environment: 'alpha' }, { ...env, ZYNOHOSTING_API_URL: CUSTOM_URL })), 'alpha-key');
    assert.equal(apiKeyOf(await resolveConfig({ apiUrl: CUSTOM_URL }, { ...env, ZYNOHOSTING_ENVIRONMENT: 'alpha' })), 'custom-key');
    assert.equal(apiKeyOf(await resolveConfig({}, { ...env, ZYNOHOSTING_API_URL: CUSTOM_URL, ZYNOHOSTING_ENVIRONMENT: 'alpha' })), 'custom-key');
    assert.equal(apiKeyOf(await resolveConfig({ apiUrl: CUSTOM_URL }, env)), 'custom-key');
    assert.equal(apiKeyOf(await resolveConfig({}, { ...env, ZYNOHOSTING_API_URL: `${CUSTOM_URL}/` })), 'custom-key');
    assert.equal(apiKeyOf(await resolveConfig({ apiUrl: ALPHA_URL }, env)), 'alpha-key');
    assert.equal((await resolveConfig({ apiUrl: CUSTOM_URL }, env)).apiUrl, CUSTOM_URL);
    assert.deepEqual(selectProfile({}, {}), { key: 'production', apiUrl: PRODUCTION_URL });
    // An explicit URL is never dropped in favor of an environment.
    assert.deepEqual(selectProfile({ apiUrl: 'http://localhost:5555' }, { ZYNOHOSTING_ENVIRONMENT: 'alpha' }), {
        key: 'url:http://localhost:5555',
        apiUrl: 'http://localhost:5555'
    });
    assert.deepEqual(selectProfile({ environment: 'dev', apiUrl: 'http://localhost:5555' }, {}), {
        key: 'url:http://localhost:5555',
        apiUrl: 'http://localhost:5555'
    });
    // A URL that equals a known environment's URL maps to that environment's key.
    assert.equal(selectProfile({ apiUrl: `${ALPHA_URL}/` }, {}).key, 'alpha');
    assert.equal(
        (await resolveConfig({ apiUrl: 'http://localhost:5555', apiKey: 'k' }, { ...env, ZYNOHOSTING_ENVIRONMENT: 'alpha' })).suiteApiUrl,
        undefined
    );
});

test('environment and command-option credentials still take precedence over saved ones', async () => {
    const { file, env } = await configFile();
    await saveKey(file, env, 'prod-key');
    assert.equal(apiKeyOf(await resolveConfig({}, { ...env, ZYNOHOSTING_API_KEY: 'env-key' })), 'env-key');
    assert.equal(apiKeyOf(await resolveConfig({ apiKey: 'option-key' }, { ...env, ZYNOHOSTING_API_KEY: 'env-key' })), 'option-key');
    // A profile without a credential does not block injected credentials.
    assert.equal(apiKeyOf(await resolveConfig({ environment: 'alpha', apiKey: 'option-key' }, env)), 'option-key');
});

test('a missing profile reports saved logins with a hint and missing_config', async () => {
    const { file, env } = await configFile();
    await assert.rejects(
        resolveConfig({}, env),
        (error: unknown) =>
            error instanceof CliError && error.code === 'missing_config' && /Hosting credentials are not configured/.test(error.message)
    );
    await saveKey(file, env, 'alpha-key', { environment: 'alpha' });
    await saveKey(file, env, 'custom-key', { apiUrl: CUSTOM_URL });
    await assert.rejects(resolveConfig({}, env), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, 'missing_config');
        assert.equal(error.exitCode, 2);
        assert.equal(
            error.message,
            `Not signed in to production. Saved logins: alpha, ${CUSTOM_URL}. Pass --environment alpha, or run \`zynohosting login\`.`
        );
        return true;
    });
    await assert.rejects(resolveConfig({ environment: 'dev' }, env), /Not signed in to dev\. Saved logins: alpha, /);
});

test('a legacy production file is read as the production profile and rewritten as v2 on the next save', async () => {
    const { file, env } = await configFile();
    await writeFile(file, JSON.stringify({ apiUrl: PRODUCTION_URL, apiKey: 'legacy-prod' }));
    assert.equal(apiKeyOf(await resolveConfig({}, env)), 'legacy-prod');
    assert.equal((await rawFile(file)).version, undefined);

    await saveKey(file, env, 'alpha-key', { environment: 'alpha' });
    const raw = await rawFile(file);
    assert.equal(raw.version, 3);
    assert.equal(raw.profiles?.production?.apiKey, 'legacy-prod');
    assert.equal(raw.profiles?.alpha?.apiKey, 'alpha-key');
});

test('a legacy file without an apiUrl migrates to production', async () => {
    const { file, env } = await configFile();
    await writeFile(file, JSON.stringify({ apiKey: 'legacy-key' }));
    assert.deepEqual(Object.keys((await loadConfigFile(file)).profiles), ['production']);
    assert.equal(apiKeyOf(await resolveConfig({}, env)), 'legacy-key');
});

test('a legacy alpha file needs --environment alpha and flagless commands get the hint', async () => {
    const { file, env } = await configFile();
    await writeFile(file, JSON.stringify({ apiUrl: ALPHA_URL, apiKey: 'legacy-alpha' }));
    await assert.rejects(
        resolveConfig({}, env),
        (error: unknown) =>
            error instanceof CliError &&
            error.code === 'missing_config' &&
            error.message === 'Not signed in to production. Saved logins: alpha. Pass --environment alpha, or run `zynohosting login`.'
    );
    assert.equal(apiKeyOf(await resolveConfig({ environment: 'alpha' }, env)), 'legacy-alpha');
    assert.equal(apiKeyOf(await resolveConfig({ apiUrl: ALPHA_URL }, env)), 'legacy-alpha');

    await saveKey(file, env, 'prod-key');
    const raw = await rawFile(file);
    assert.equal(raw.version, 3);
    assert.equal(raw.profiles?.alpha?.apiKey, 'legacy-alpha');
    assert.equal(raw.profiles?.production?.apiKey, 'prod-key');
});

test('logout removes only the selected profile and its renewal credential', async () => {
    const { file, env } = await configFile();
    const store = new MemoryStore([[RENEWAL_KEY, 'zrt_secret']]);
    await saveKey(file, env, 'prod-key');
    await updateProfile('alpha', { apiUrl: ALPHA_URL, apiKey: 'alpha-key' }, file);
    await updateProfile('dev', { apiUrl: 'http://localhost:39840', accessToken: 'dev.jwt.signature', renewalKey: RENEWAL_KEY }, file);

    await logout({}, { configFile: file, env, write: () => {}, renewalTokenStore: store });
    let raw = await rawFile(file);
    assert.deepEqual(Object.keys(raw.profiles ?? {}).sort(), ['alpha', 'dev']);
    assert.equal(store.values.has(RENEWAL_KEY), true);

    await logout({ environment: 'dev' }, { configFile: file, env, write: () => {}, renewalTokenStore: store });
    raw = await rawFile(file);
    assert.deepEqual(Object.keys(raw.profiles ?? {}), ['alpha']);
    assert.equal(store.values.has(RENEWAL_KEY), false);

    // Other logins exist, so a plain logout must not claim to be logged out.
    await assert.rejects(logout({}, { configFile: file, env, write: () => {} }), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, 'missing_config');
        assert.equal(error.exitCode, 2);
        assert.equal(
            error.message,
            'Not signed in to production. Saved logins: alpha. Pass --environment alpha, or --all to log out of every login.'
        );
        return true;
    });
    assert.equal((await rawFile(file)).profiles?.alpha?.apiKey, 'alpha-key');

    await logout({ all: true }, { configFile: file, env, write: () => {} });
    const output: string[] = [];
    await logout({}, { configFile: file, env, write: message => output.push(message) });
    assert.match(output.join(''), /already logged out/);
});

test('logout --all logs out of every profile', async () => {
    const { file, env } = await configFile();
    const store = new MemoryStore([[RENEWAL_KEY, 'zrt_secret']]);
    await saveKey(file, env, 'prod-key');
    await updateProfile('alpha', { apiUrl: ALPHA_URL, accessToken: 'alpha.jwt.signature', renewalKey: RENEWAL_KEY }, file);
    await updateProfile(`url:${CUSTOM_URL}`, { apiUrl: CUSTOM_URL, apiKey: 'custom-key' }, file);

    await logout({ all: true }, { configFile: file, env, write: () => {}, renewalTokenStore: store });
    assert.deepEqual((await rawFile(file)).profiles, {});
    assert.equal(store.values.has(RENEWAL_KEY), false);
    await assert.rejects(resolveConfig({ environment: 'alpha' }, env), /Hosting credentials are not configured/);
});

test('refresh updates only its profile and keeps a profile written while it was renewing', async () => {
    const { file, env } = await configFile();
    const store = new MemoryStore([[RENEWAL_KEY, 'zrt_old']]);
    const expiresAt = Date.now() + 60 * 60 * 1000;
    await updateProfile('production', { apiUrl: PRODUCTION_URL, apiKey: 'prod-key' }, file);
    await updateProfile(
        'alpha',
        {
            apiUrl: ALPHA_URL,
            authApiUrl: 'https://auth.api-alpha.zyno.dev',
            accessToken: 'old.jwt.signature',
            tenantId: '00000000-0000-0000-0000-000000000024',
            expiresAt: Date.now() - 1,
            renewalKey: RENEWAL_KEY,
            scopedToken: true
        },
        file
    );

    const resolved = await resolveConfig({ environment: 'alpha' }, env, {
        renewalTokenStore: store,
        scopedTokenClient: () => ({
            async renew(value: string) {
                assert.equal(value, 'zrt_old');
                // Another process signs in to dev while this renewal is in flight.
                // It cannot take the lock the renewal already holds in this process, so it writes the file directly.
                const current = await rawFile(file);
                current.profiles!.dev = { apiUrl: 'http://localhost:39840', apiKey: 'dev-key' };
                await writeFile(file, JSON.stringify(current));
                return { jwt: 'new.jwt.signature', expiresAt, renewalToken: 'zrt_new' };
            }
        })
    });
    assert.equal(resolved.credential.type === 'bearer' && resolved.credential.accessToken, 'new.jwt.signature');

    const raw = await rawFile(file);
    const renewed = (raw.profiles?.alpha?.logins as Record<string, Record<string, unknown>> | undefined)?.[
        'unknown:00000000-0000-0000-0000-000000000024'
    ];
    assert.equal(renewed?.accessToken, 'new.jwt.signature');
    assert.equal(renewed?.expiresAt, expiresAt);
    assert.equal(renewed?.renewalKey, RENEWAL_KEY);
    assert.equal(raw.profiles?.production?.apiKey, 'prod-key');
    assert.equal(raw.profiles?.dev?.apiKey, 'dev-key');
    assert.equal(store.values.get(RENEWAL_KEY), 'zrt_new');
});

test('concurrent profile updates for different profiles both survive', async () => {
    const { file } = await configFile();
    const keys = ['production', 'alpha', 'dev', `url:${CUSTOM_URL}`];
    await Promise.all(keys.map(key => updateProfile(key, { apiUrl: PRODUCTION_URL, apiKey: `${key}-key` }, file)));
    const profiles = (await rawFile(file)).profiles ?? {};
    assert.deepEqual(Object.keys(profiles).sort(), [...keys].sort());
    for (const key of keys) assert.equal(profiles[key]?.apiKey, `${key}-key`);
});

test('logout --all removes the other profiles when one revocation fails, then throws the first error', async () => {
    const { file, env } = await configFile();
    const store = new MemoryStore([[RENEWAL_KEY, 'zrt_secret']]);
    await updateProfile('production', { apiUrl: PRODUCTION_URL, apiKey: 'prod-key' }, file);
    await updateProfile(
        'alpha',
        {
            apiUrl: ALPHA_URL,
            authApiUrl: 'https://auth.api-alpha.zyno.dev',
            accessToken: 'alpha.jwt.signature',
            expiresAt: Date.now() + 3_600_000,
            scopedToken: true
        },
        file
    );
    await updateProfile(`url:${CUSTOM_URL}`, { apiUrl: CUSTOM_URL, accessToken: 'custom.jwt.signature', renewalKey: RENEWAL_KEY }, file);

    await assert.rejects(
        logout(
            { all: true },
            {
                configFile: file,
                env,
                write: () => {},
                renewalTokenStore: store,
                scopedTokenClient: () => ({
                    async renew() {
                        throw new Error('unexpected renew');
                    },
                    async revoke() {
                        throw new HttpError('network unavailable', 0, 'network_error');
                    }
                })
            }
        ),
        /network unavailable/
    );
    assert.deepEqual(Object.keys((await rawFile(file)).profiles ?? {}), ['alpha']);
    assert.equal(store.values.has(RENEWAL_KEY), false);
});

test('invalid or empty ZYNOHOSTING_ENVIRONMENT is only parsed when the precedence reaches it', () => {
    assert.equal(selectProfile({ environment: 'alpha' }, { ZYNOHOSTING_ENVIRONMENT: 'bogus' }).key, 'alpha');
    assert.equal(selectProfile({ apiUrl: CUSTOM_URL }, { ZYNOHOSTING_ENVIRONMENT: 'bogus' }).key, `url:${CUSTOM_URL}`);
    assert.equal(selectProfile({}, { ZYNOHOSTING_API_URL: CUSTOM_URL, ZYNOHOSTING_ENVIRONMENT: 'bogus' }).key, `url:${CUSTOM_URL}`);
    assert.equal(selectProfile({}, { ZYNOHOSTING_ENVIRONMENT: '' }).key, 'production');
    assert.throws(() => selectProfile({}, { ZYNOHOSTING_ENVIRONMENT: 'bogus' }), /Unknown Hosting environment/);
});

test('--environment beats ZYNO_AUTH_API_URL, so a production renewal token never goes to another auth server', async () => {
    const { file, env } = await configFile();
    const store = new MemoryStore([[RENEWAL_KEY, 'zrt_prod']]);
    await updateProfile(
        'production',
        { apiUrl: PRODUCTION_URL, accessToken: 'old.jwt.signature', expiresAt: Date.now() - 1, renewalKey: RENEWAL_KEY, scopedToken: true },
        file
    );
    const seen: string[] = [];
    const resolved = await resolveConfig(
        { environment: 'production' },
        { ...env, ZYNO_AUTH_API_URL: 'https://auth.api-alpha.zyno.dev' },
        {
            renewalTokenStore: store,
            scopedTokenClient: apiUrl => {
                seen.push(apiUrl);
                return {
                    async renew() {
                        return { jwt: 'new.jwt.signature', expiresAt: Date.now() + 3_600_000, renewalToken: 'zrt_new' };
                    }
                };
            }
        }
    );
    assert.deepEqual(seen, ['https://auth.api.zyno.app']);
    assert.equal(resolved.authApiUrl, 'https://auth.api.zyno.app');
    // Without the flag the explicit variable still applies, and a flag URL beats it.
    assert.equal(resolveAuthApiUrl(undefined, {}, PRODUCTION_URL, { ZYNO_AUTH_API_URL: 'https://auth.example.com' }), 'https://auth.example.com');
    assert.equal(
        resolveAuthApiUrl('https://flag.example.com', {}, PRODUCTION_URL, { ZYNO_AUTH_API_URL: 'https://auth.example.com' }, 'production'),
        'https://flag.example.com'
    );
    assert.equal(
        resolveSuiteApiUrl(undefined, {}, PRODUCTION_URL, { ZYNO_SUITE_API_URL: 'https://suite.example.com' }, 'production'),
        'https://suite.api.zyno.app'
    );
});

test('logout --all ignores endpoint selectors in the environment and explains a missing auth URL', async () => {
    const { file, env } = await configFile();
    await updateProfile(
        'alpha',
        { apiUrl: ALPHA_URL, accessToken: 'alpha.jwt.signature', expiresAt: Date.now() + 3_600_000, scopedToken: true },
        file
    );
    const seen: string[] = [];
    await logout(
        { all: true },
        {
            configFile: file,
            env: { ...env, ZYNOHOSTING_ENVIRONMENT: 'production', ZYNOHOSTING_API_URL: CUSTOM_URL, ZYNO_AUTH_API_URL: 'https://evil.example.com' },
            write: () => {},
            scopedTokenClient: apiUrl => {
                seen.push(apiUrl);
                return {
                    async renew() {
                        throw new Error('unexpected');
                    },
                    async revoke() {}
                };
            }
        }
    );
    assert.deepEqual(seen, ['https://auth.api-alpha.zyno.dev']);

    await updateProfile(
        `url:${CUSTOM_URL}`,
        { apiUrl: CUSTOM_URL, accessToken: 'custom.jwt.signature', expiresAt: Date.now() + 3_600_000, scopedToken: true },
        file
    );
    await assert.rejects(logout({ all: true }, { configFile: file, env, write: () => {} }), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.match(error.message, new RegExp(`zynohosting logout --api-url ${CUSTOM_URL} --auth-api-url <url>`));
        assert.doesNotMatch(error.message, /Pass --auth-api-url/);
        return true;
    });
});

const defaultLocation = { skip: process.platform === 'win32' };

async function legacyLocation(): Promise<{ env: NodeJS.ProcessEnv; legacy: string; profiles: string }> {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-legacy-'));
    const directory = join(root, 'zyno');
    await mkdir(directory, { recursive: true });
    return { env: { XDG_CONFIG_HOME: root }, legacy: join(directory, 'hosting-cli.json'), profiles: join(directory, 'hosting-cli-profiles.json') };
}

test('the default v2 file is separate from the legacy file, which login never writes', defaultLocation, async () => {
    const { env, legacy, profiles } = await legacyLocation();
    const legacyText = JSON.stringify({ apiUrl: PRODUCTION_URL, apiKey: 'legacy-prod' });
    await writeFile(legacy, legacyText);
    assert.equal(apiKeyOf(await resolveConfig({}, env)), 'legacy-prod');
    await assert.rejects(stat(profiles));

    await login({ environment: 'alpha', apiKey: 'alpha-key' }, { env, write: () => {} });
    const raw = await rawFile(profiles);
    assert.equal(raw.version, 3);
    assert.equal(raw.profiles?.production?.apiKey, 'legacy-prod');
    assert.equal(raw.profiles?.alpha?.apiKey, 'alpha-key');
    assert.equal(await readFile(legacy, 'utf8'), legacyText);
});

test('refresh migrates a legacy login into the v2 file without touching the legacy file', defaultLocation, async () => {
    const { env, legacy, profiles } = await legacyLocation();
    const legacyText = JSON.stringify({
        apiUrl: PRODUCTION_URL,
        accessToken: 'old.jwt.signature',
        expiresAt: Date.now() - 1,
        renewalKey: RENEWAL_KEY,
        scopedToken: true
    });
    await writeFile(legacy, legacyText);
    const expiresAt = Date.now() + 3_600_000;
    await resolveConfig({}, env, {
        renewalTokenStore: new MemoryStore([[RENEWAL_KEY, 'zrt_old']]),
        scopedTokenClient: () => ({
            async renew() {
                return { jwt: 'new.jwt.signature', expiresAt, renewalToken: 'zrt_new' };
            }
        })
    });
    const migrated = (await rawFile(profiles)).profiles?.production;
    assert.equal((migrated?.logins as Record<string, Record<string, unknown>>)['unknown:unknown']?.accessToken, 'new.jwt.signature');
    assert.equal(migrated?.activeLogin, 'unknown:unknown');
    assert.equal(migrated?.accessToken, undefined);
    assert.equal(await readFile(legacy, 'utf8'), legacyText);
});

test('the legacy file is ignored once the v2 file exists', defaultLocation, async () => {
    const { env, legacy } = await legacyLocation();
    await writeFile(legacy, JSON.stringify({ apiUrl: PRODUCTION_URL, apiKey: 'legacy-prod' }));
    await login({ environment: 'alpha', apiKey: 'alpha-key' }, { env, write: () => {} });
    await updateProfile('production', undefined, configLocation(env));
    await assert.rejects(resolveConfig({}, env), /Saved logins: alpha/);
});

test('logout removes the legacy file when it holds the removed credential, and keeps it otherwise', defaultLocation, async () => {
    const { env, legacy } = await legacyLocation();
    await writeFile(legacy, JSON.stringify({ apiUrl: PRODUCTION_URL, apiKey: 'legacy-prod' }));
    await login({ environment: 'alpha', apiKey: 'alpha-key' }, { env, write: () => {} });

    await logout({ environment: 'alpha' }, { env, write: () => {} });
    assert.equal((await stat(legacy)).isFile(), true);

    await logout({}, { env, write: () => {} });
    await assert.rejects(stat(legacy));
});

test('logout --all also removes a matching legacy file', defaultLocation, async () => {
    const { env, legacy } = await legacyLocation();
    await writeFile(legacy, JSON.stringify({ apiUrl: ALPHA_URL, apiKey: 'legacy-alpha' }));
    await logout({ all: true }, { env, write: () => {} });
    await assert.rejects(stat(legacy));
});

test('an invalid legacy apiUrl names the file, and login still succeeds', defaultLocation, async () => {
    const { env, legacy, profiles } = await legacyLocation();
    await writeFile(legacy, JSON.stringify({ apiUrl: 'not a url', apiKey: 'legacy' }));
    await assert.rejects(resolveConfig({}, env), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, 'invalid_config');
        assert.ok(error.message.includes(legacy));
        assert.match(error.message, /zynohosting login. again or delete the file/);
        return true;
    });
    await login({ environment: 'alpha', apiKey: 'alpha-key' }, { env, write: () => {} });
    assert.equal((await rawFile(profiles)).profiles?.alpha?.apiKey, 'alpha-key');
});

async function browserLogin(
    options: Parameters<typeof login>[0],
    dependencies: Parameters<typeof login>[1],
    callbackFields: Record<string, string>
): Promise<void> {
    let failure: unknown;
    await login(
        { loginUrl: 'https://zyno.app/cli/login', timeoutSeconds: 5, device: false, ...options },
        {
            ...dependencies,
            write: () => {},
            openUrl: async value => {
                try {
                    const url = new URL(value);
                    const response = await fetch(url.searchParams.get('callback')!, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            jwt: 'new.jwt.signature',
                            tenantId: '00000000-0000-0000-0000-000000000024',
                            expiresAt: String(Date.now() + 3_600_000),
                            state: url.searchParams.get('state')!,
                            ...callbackFields
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
}

test('re-login removes the superseded credential from the legacy file (API key)', defaultLocation, async () => {
    const { env, legacy, profiles } = await legacyLocation();
    await writeFile(legacy, JSON.stringify({ apiUrl: PRODUCTION_URL, apiKey: 'old-key' }));
    await login({ apiKey: 'new-key' }, { env, write: () => {} });
    await assert.rejects(stat(legacy));
    assert.equal((await rawFile(profiles)).profiles?.production?.apiKey, 'new-key');

    await logout({ all: true }, { env, write: () => {} });
    const output: string[] = [];
    await logout({ all: true }, { env, write: message => output.push(message) });
    assert.match(output.join(''), /already logged out/);
});

test('re-login removes the superseded credential from the legacy file (renewable token)', defaultLocation, async () => {
    const { env, legacy, profiles } = await legacyLocation();
    const store = new MemoryStore([[RENEWAL_KEY, 'zrt_old']]);
    await writeFile(
        legacy,
        JSON.stringify({
            apiUrl: PRODUCTION_URL,
            accessToken: 'old.jwt.signature',
            tenantId: '00000000-0000-0000-0000-000000000024',
            expiresAt: Date.now() + 3_600_000,
            renewalKey: RENEWAL_KEY,
            scopedToken: true
        })
    );
    const revoked: string[] = [];
    await browserLogin(
        { renewable: true, authApiUrl: 'https://auth.api.zyno.app' },
        {
            env,
            renewalTokenStore: store,
            scopedTokenClient: () => ({
                async startDevice() {
                    throw new Error('unexpected');
                },
                async pollDevice() {
                    throw new Error('unexpected');
                },
                async cancelDevice() {},
                async revoke(token: string) {
                    revoked.push(token);
                }
            })
        },
        { renewalToken: 'zrt_new' }
    );
    await assert.rejects(stat(legacy));
    // The replaced grant for the same tenant is revoked, best effort.
    assert.deepEqual(revoked, ['old.jwt.signature']);
    const saved = ((await rawFile(profiles)).profiles?.production?.logins as Record<string, Record<string, unknown>>)[
        '00000000-0000-0000-0000-000000000024'
    ];
    assert.notEqual(saved?.renewalKey, RENEWAL_KEY);
    assert.equal(store.values.has(RENEWAL_KEY), false);
});

test('a login to another environment leaves an unrelated legacy file alone', defaultLocation, async () => {
    const { env, legacy } = await legacyLocation();
    await writeFile(legacy, JSON.stringify({ apiUrl: PRODUCTION_URL, apiKey: 'legacy-prod' }));
    await login({ environment: 'alpha', apiKey: 'alpha-key' }, { env, write: () => {} });
    assert.equal((await stat(legacy)).isFile(), true);
});

test('renewing a legacy-sourced login holds the legacy lock too, and keeps the legacy file', defaultLocation, async () => {
    const { env, legacy } = await legacyLocation();
    await writeFile(
        legacy,
        JSON.stringify({
            apiUrl: PRODUCTION_URL,
            accessToken: 'old.jwt.signature',
            expiresAt: Date.now() - 1,
            renewalKey: RENEWAL_KEY,
            scopedToken: true
        })
    );
    const lock = `${legacy}.renew.lock`;
    let lockedDuringRenew = false;
    await resolveConfig({}, env, {
        renewalTokenStore: new MemoryStore([[RENEWAL_KEY, 'zrt_old']]),
        scopedTokenClient: () => ({
            async renew() {
                lockedDuringRenew = await stat(lock).then(
                    () => true,
                    () => false
                );
                return { jwt: 'new.jwt.signature', expiresAt: Date.now() + 3_600_000, renewalToken: 'zrt_new' };
            }
        })
    });
    assert.equal(lockedDuringRenew, true);
    await assert.rejects(stat(lock));
    assert.equal((await stat(legacy)).isFile(), true);
});

test('a flag-chosen Hosting URL ignores ZYNO_AUTH_API_URL for renewal and for what login saves', async () => {
    const { file, env } = await configFile();
    const alphaAuth = 'https://auth.api-alpha.zyno.dev';
    await updateProfile(
        'production',
        { apiUrl: PRODUCTION_URL, accessToken: 'old.jwt.signature', expiresAt: Date.now() - 1, renewalKey: RENEWAL_KEY, scopedToken: true },
        file
    );
    const seen: string[] = [];
    await resolveConfig(
        { apiUrl: PRODUCTION_URL },
        { ...env, ZYNO_AUTH_API_URL: alphaAuth },
        {
            renewalTokenStore: new MemoryStore([[RENEWAL_KEY, 'zrt_prod']]),
            scopedTokenClient: apiUrl => {
                seen.push(apiUrl);
                return {
                    async renew() {
                        return { jwt: 'new.jwt.signature', expiresAt: Date.now() + 3_600_000, renewalToken: 'zrt_new' };
                    }
                };
            }
        }
    );
    assert.deepEqual(seen, ['https://auth.api.zyno.app']);

    await login(
        { apiUrl: PRODUCTION_URL, apiKey: 'prod-key' },
        { configFile: file, env: { ...env, ZYNO_AUTH_API_URL: alphaAuth, ZYNO_SUITE_API_URL: 'https://suite.evil.example.com' }, write: () => {} }
    );
    const saved = (await rawFile(file)).profiles?.production;
    assert.equal(saved?.authApiUrl, 'https://auth.api.zyno.app');
    assert.equal(saved?.suiteApiUrl, 'https://suite.api.zyno.app');

    // Explicit flags still win, a custom Hosting URL falls back to the saved profile URL, and without a flag the variable applies.
    assert.equal(
        resolveAuthApiUrl('https://flag.example.com', {}, PRODUCTION_URL, { ZYNO_AUTH_API_URL: alphaAuth }, undefined, true),
        'https://flag.example.com'
    );
    assert.equal(
        resolveAuthApiUrl(undefined, { authApiUrl: 'https://auth.saved.example.com' }, CUSTOM_URL, { ZYNO_AUTH_API_URL: alphaAuth }, undefined, true),
        'https://auth.saved.example.com'
    );
    assert.equal(resolveAuthApiUrl(undefined, {}, PRODUCTION_URL, { ZYNO_AUTH_API_URL: alphaAuth }), alphaAuth);
});

test('an invalid ZYNOHOSTING_ENVIRONMENT only fails where it selects the Hosting URL', async () => {
    assert.equal(resolveAuthApiUrl(undefined, {}, PRODUCTION_URL, { ZYNOHOSTING_ENVIRONMENT: 'bogus' }), 'https://auth.api.zyno.app');
    assert.equal(resolveSuiteApiUrl(undefined, {}, PRODUCTION_URL, { ZYNOHOSTING_ENVIRONMENT: 'bogus' }), 'https://suite.api.zyno.app');
    const { file, env } = await configFile();
    await login(
        { apiUrl: PRODUCTION_URL, apiKey: 'prod-key' },
        { configFile: file, env: { ...env, ZYNOHOSTING_ENVIRONMENT: 'bogus' }, write: () => {} }
    );
    assert.equal((await rawFile(file)).profiles?.production?.apiKey, 'prod-key');
    assert.throws(() => selectProfile({}, { ZYNOHOSTING_ENVIRONMENT: 'bogus' }), /Unknown Hosting environment/);
});

test('login replaces an explicit ZYNOHOSTING_CONFIG flat file whose apiUrl is invalid', async () => {
    const { file, env } = await configFile();
    await writeFile(file, JSON.stringify({ apiUrl: 'not a url', apiKey: 'legacy' }));
    await assert.rejects(resolveConfig({}, env), /log.* again or delete the file/);
    await login({ environment: 'alpha', apiKey: 'alpha-key' }, { configFile: file, env, write: () => {} });
    const raw = await rawFile(file);
    assert.equal(raw.version, 3);
    assert.equal(raw.profiles?.alpha?.apiKey, 'alpha-key');
});

class MemoryStore implements RenewalTokenStore {
    values: Map<string, string>;
    constructor(entries: [string, string][] = []) {
        this.values = new Map(entries);
    }
    async get(key: string) {
        return this.values.get(key);
    }
    async set(key: string, value: string) {
        this.values.set(key, value);
    }
    async delete(key: string) {
        this.values.delete(key);
    }
}
