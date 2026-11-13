import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { RenewalTokenStore } from '../src/auth/renewal-token-store.js';
import type { LoginPrompt } from '../src/commands/login.js';

import { ScopedTokenClient } from '../src/api/scoped-token-client.js';
import { login } from '../src/commands/login.js';
import { loadStoredConfig, updateProfile } from '../src/config.js';
import { CliError, HttpError } from '../src/errors.js';
import { pollDeviceApproval } from '../src/login/device.js';
import { approvedPoll, DEVICE_CODE, JWT, RENEWAL_TOKEN, startFakeAuth, TENANT_ID, USER_CODE } from './support/fake-auth.js';

const HOSTING_URL = 'https://hosting.api-alpha.zyno.dev';

async function setup(polls: Parameters<typeof startFakeAuth>[0]) {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-device-'));
    const file = join(root, 'config.json');
    const auth = await startFakeAuth(polls);
    const output: string[] = [];
    const events: Record<string, unknown>[] = [];
    const prompts: LoginPrompt[] = [];
    const dependencies = {
        configFile: file,
        env: { ZYNOHOSTING_CONFIG: file } as NodeJS.ProcessEnv,
        write: (message: string) => output.push(message),
        emit: (event: Record<string, unknown>) => events.push(event),
        onLoginPrompt: (prompt: LoginPrompt) => {
            prompts.push(prompt);
        }
    };
    const options = { apiUrl: HOSTING_URL, authApiUrl: auth.url, device: true };
    return { root, file, auth, output, events, prompts, dependencies, options };
}

/** Everything a person or an agent could see: human output, JSON events, prompts, and error text. */
function visible(context: { output: string[]; events: Record<string, unknown>[]; prompts: LoginPrompt[] }, extra = ''): string {
    return [...context.output, JSON.stringify(context.events), JSON.stringify(context.prompts), extra].join('\n');
}

function assertNoSecrets(text: string): void {
    assert(!text.includes(DEVICE_CODE), 'the device code must never be shown');
    assert(!text.includes(JWT), 'the access token must never be shown');
    assert(!text.includes(RENEWAL_TOKEN), 'the renewal token must never be shown');
}

class MemoryStore implements RenewalTokenStore {
    values = new Map<string, string>();
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

test('a device sign-in waits through pending and slow_down, then saves the approved login', async () => {
    const context = await setup([{ status: 'pending' }, { status: 'slow_down', interval: 0.25 }, { status: 'pending' }, approvedPoll()]);
    try {
        const result = await login({ ...context.options, json: true, timeoutSeconds: 20 }, context.dependencies);

        assert.equal(result.status, 'authenticated');
        const polls = context.auth.requests.filter(request => request.path.endsWith('/device/poll'));
        assert.equal(polls.length, 4);
        // After slow_down the client really waits the longer interval before polling again.
        assert(polls[2]!.at - polls[1]!.at >= 200, `waited ${polls[2]!.at - polls[1]!.at}ms`);

        const saved = (await loadStoredConfig(context.file, 'alpha')).logins?.[`unknown:${TENANT_ID}`];
        assert.equal(saved?.accessToken, JWT);
        assert.equal(saved?.tenantName, 'Acme Co');
        assert.equal(saved?.accountEmail, 'owner@example.com');
        assert.equal(typeof saved?.grantExpiresAt, 'number');
        assert.equal((await loadStoredConfig(context.file, 'alpha')).activeLogin, `unknown:${TENANT_ID}`);

        const start = context.auth.requests.find(request => request.path.endsWith('/device/start'))!;
        assert.deepEqual(Object.keys(start.body).sort(), ['description', 'permissionKeys', 'renewable']);
        assert.deepEqual(start.body.permissionKeys, ['hosting.sitesRead']);
        assert.equal(start.body.renewable, false);

        const started = context.events.find(event => event.type === 'login_started')!;
        assert.equal(started.flow, 'device');
        assert.equal(started.reason, 'explicit');
        assert.equal(started.userCode, USER_CODE);
        assert.equal(started.verificationUri, `${context.auth.url}/cli/device`);
        assert.equal(started.verificationUriComplete, `${context.auth.url}/cli/device?code=${USER_CODE}`);
        const done = context.events.at(-1)!;
        assert.equal(done.type, 'result');
        assert.equal(done.status, 'authenticated');
        assert.equal(done.tenantName, 'Acme Co');
        assert.equal(done.account, 'owner@example.com');
        assert.match(context.output.join(''), /Signed in as owner@example\.com \(Acme Co\)/);
        assert.match(context.output.join(''), new RegExp(`${USER_CODE}`));
        assertNoSecrets(visible(context));
    } finally {
        await context.auth.close();
    }
});

test('a renewable device sign-in with the file store keeps the token out of the profile file', async () => {
    const context = await setup([approvedPoll({}, { renewalToken: RENEWAL_TOKEN })]);
    try {
        const result = await login(
            { ...context.options, renewable: true, lifetime: '7d', credentialStore: 'file', timeoutSeconds: 20 },
            context.dependencies
        );
        assert.equal(result.status === 'authenticated' && result.credentialStore, 'file');
        const start = context.auth.requests.find(request => request.path.endsWith('/device/start'))!;
        assert.equal(start.body.requestedLifetimeSecs, 604_800);
        assert.equal(start.body.renewable, true);

        const saved = (await loadStoredConfig(context.file, 'alpha')).logins?.[`unknown:${TENANT_ID}`];
        assert.equal(saved?.renewalStore, 'file');
        assert.match(saved?.renewalKey ?? '', /^[0-9a-f-]{36}$/);
        assert.doesNotMatch(await readFile(context.file, 'utf8'), /zrt_/);
        const tokenFile = join(context.root, 'config.renewal-tokens.json');
        const tokens = JSON.parse(await readFile(tokenFile, 'utf8')) as { version: number; tokens: Record<string, { token: string }> };
        assert.equal(tokens.version, 1);
        assert.equal(tokens.tokens[saved!.renewalKey!]?.token, RENEWAL_TOKEN);
        if (process.platform !== 'win32') {
            assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
            assert.equal((await stat(context.root)).mode & 0o777, 0o700);
        }
        assertNoSecrets(visible(context));
    } finally {
        await context.auth.close();
    }
});

test('ZYNOHOSTING_CREDENTIAL_STORE=file applies to renewable logins and is ignored otherwise', async () => {
    const context = await setup([approvedPoll()]);
    try {
        await login(
            { ...context.options, timeoutSeconds: 20 },
            { ...context.dependencies, env: { ...context.dependencies.env, ZYNOHOSTING_CREDENTIAL_STORE: 'file' } }
        );
        assert.equal((await loadStoredConfig(context.file, 'alpha')).logins?.[`unknown:${TENANT_ID}`]?.renewalKey, undefined);
        await assert.rejects(stat(join(context.root, 'config.renewal-tokens.json')));
    } finally {
        await context.auth.close();
    }
});

test('the credential store is checked before anything is started', async () => {
    const context = await setup([approvedPoll()]);
    try {
        const store = new MemoryStore();
        await assert.rejects(
            login(
                { ...context.options, renewable: true, timeoutSeconds: 20 },
                {
                    ...context.dependencies,
                    renewalTokenStore: Object.assign(store, {
                        async probe() {
                            throw new CliError('no credential service', 3, 'credential_store_unavailable');
                        }
                    })
                }
            ),
            (error: unknown) => error instanceof CliError && error.code === 'credential_store_unavailable'
        );
        assert.equal(context.auth.requests.length, 0);

        await assert.rejects(
            login({ ...context.options, credentialStore: 'file' }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'invalid_credential_store'
        );
        assert.equal(context.auth.requests.length, 0);
    } finally {
        await context.auth.close();
    }
});

test('lifetimes are validated before anything is started', async () => {
    const context = await setup([approvedPoll()]);
    try {
        for (const options of [{ lifetime: '90d', renewable: true }, { lifetime: '7d' }, { lifetime: 'forever', renewable: true }]) {
            await assert.rejects(
                login({ ...context.options, ...options }, context.dependencies),
                (error: unknown) => error instanceof CliError && error.code === 'invalid_lifetime' && error.exitCode === 2
            );
        }
        assert.equal(context.auth.requests.length, 0);
    } finally {
        await context.auth.close();
    }
});

test('aborting cancels the device code on the server', async () => {
    const context = await setup([{ status: 'pending' }]);
    try {
        const abort = new AbortController();
        const promise = login(
            { ...context.options, signal: abort.signal },
            {
                ...context.dependencies,
                onLoginPrompt: () => {
                    setTimeout(() => abort.abort(), 60);
                }
            }
        );
        await assert.rejects(promise, (error: unknown) => error instanceof CliError && error.code === 'login_cancelled');
        const cancels = context.auth.requests.filter(request => request.path.endsWith('/device/cancel'));
        assert.equal(cancels.length, 1);
        assert.equal(cancels[0]!.body.deviceCode, DEVICE_CODE);
    } finally {
        await context.auth.close();
    }
});

test('a timeout cancels the device code and reports login_timeout', async () => {
    const context = await setup([{ status: 'pending' }]);
    try {
        await assert.rejects(
            login({ ...context.options, timeoutSeconds: 1 }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'login_timeout'
        );
        assert.equal(context.auth.count('/identity/scoped-tokens/device/cancel'), 1);
    } finally {
        await context.auth.close();
    }
});

test('denied and expired codes end the sign-in with their own errors', async () => {
    for (const [status, code] of [
        ['denied', 'login_denied'],
        ['expired', 'device_code_expired']
    ] as const) {
        const context = await setup([{ status: 'pending' }, { status }]);
        try {
            await assert.rejects(
                login({ ...context.options, timeoutSeconds: 20 }, context.dependencies),
                (error: unknown) => error instanceof CliError && error.code === code && error.exitCode === 3
            );
            assert.deepEqual(await loadStoredConfig(context.file, 'alpha'), {});
        } finally {
            await context.auth.close();
        }
    }
});

test('a dropped connection followed by expired is reported as a lost credential', async () => {
    const context = await setup(['drop', { status: 'expired' }]);
    try {
        await assert.rejects(
            login({ ...context.options, timeoutSeconds: 30 }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'device_credential_lost'
        );
    } finally {
        await context.auth.close();
    }
});

test('a transient server error is retried and the sign-in still completes', async () => {
    const context = await setup([{ status: 502 }, { status: 'pending' }, approvedPoll()]);
    try {
        const result = await login({ ...context.options, timeoutSeconds: 30 }, context.dependencies);
        assert.equal(result.status, 'authenticated');
    } finally {
        await context.auth.close();
    }
});

test('a server without device sign-in (404 or 503) is device_flow_unavailable', async () => {
    for (const status of [404, 503]) {
        const context = await setup([approvedPoll()]);
        context.auth.startStatus = status;
        try {
            await assert.rejects(
                login(context.options, context.dependencies),
                (error: unknown) => error instanceof CliError && error.code === 'device_flow_unavailable' && error.exitCode === 4
            );
        } finally {
            await context.auth.close();
        }
    }
});

test('--no-wait saves the pending sign-in and --resume completes it', async () => {
    const context = await setup([{ status: 'pending' }, approvedPoll({}, { renewalToken: RENEWAL_TOKEN })]);
    try {
        const store = new MemoryStore();
        const dependencies = { ...context.dependencies, renewalTokenStore: store };
        const started = await login({ ...context.options, renewable: true, noWait: true, json: true, lifetime: '1d' }, dependencies);
        assert.equal(started.status, 'pending');
        assert.deepEqual(
            context.events.map(event => event.type),
            ['login_started', 'login_pending']
        );
        assert.equal(context.events[1]!.resume, 'zynohosting login --resume');
        assert.match(context.output.join(''), /zynohosting login --resume/);
        // Nothing was polled yet, and the profile remembers the pending sign-in.
        assert.equal(context.auth.count('/identity/scoped-tokens/device/poll'), 0);
        const pending = (await loadStoredConfig(context.file, 'alpha')).pendingDeviceLogin;
        assert.equal(pending?.userCode, USER_CODE);
        assert.equal(pending?.renewable, true);
        assert.equal(pending?.authApiUrl, context.auth.url);

        // A new process resumes with no options beyond the profile selection.
        const resumed = await login({ apiUrl: HOSTING_URL, resume: true, json: true, timeoutSeconds: 20 }, dependencies);
        assert.equal(resumed.status, 'authenticated');
        const config = await loadStoredConfig(context.file, 'alpha');
        assert.equal(config.pendingDeviceLogin, undefined);
        assert.equal(config.logins?.[`unknown:${TENANT_ID}`]?.accessToken, JWT);
        assert.equal(store.values.size, 1);
        // The renewal request the resumed sign-in checked against the saved request: renewable and the same permissions.
        assertNoSecrets(visible(context));
    } finally {
        await context.auth.close();
    }
});

test('--resume reports login_pending and keeps the pending sign-in when nobody has approved yet', async () => {
    const context = await setup([{ status: 'pending' }]);
    try {
        await login({ ...context.options, noWait: true }, context.dependencies);
        await assert.rejects(
            login({ apiUrl: HOSTING_URL, resume: true, timeoutSeconds: 1, json: true }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'login_pending' && error.exitCode === 3
        );
        assert.equal(context.events.at(-1)!.type, 'login_pending');
        assert.equal((await loadStoredConfig(context.file, 'alpha')).pendingDeviceLogin?.userCode, USER_CODE);
        // The code is still alive on the server: a timeout while resuming must not cancel it.
        assert.equal(context.auth.count('/identity/scoped-tokens/device/cancel'), 0);
    } finally {
        await context.auth.close();
    }
});

test('--resume after the code expired reports it and drops the pending sign-in; without one it is no_pending_login', async () => {
    const context = await setup([{ status: 'expired' }]);
    try {
        await assert.rejects(
            login({ apiUrl: HOSTING_URL, resume: true }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'no_pending_login' && error.exitCode === 2
        );
        await login({ ...context.options, noWait: true }, context.dependencies);
        await assert.rejects(
            login({ apiUrl: HOSTING_URL, resume: true, timeoutSeconds: 20 }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'device_code_expired'
        );
        assert.equal((await loadStoredConfig(context.file, 'alpha')).pendingDeviceLogin, undefined);
    } finally {
        await context.auth.close();
    }
});

test('an uncertain delivery is remembered, so a later --resume reports a lost credential rather than an expiry', async () => {
    const context = await setup(['drop']);
    try {
        await login({ ...context.options, noWait: true }, context.dependencies);
        await assert.rejects(
            login({ apiUrl: HOSTING_URL, resume: true, timeoutSeconds: 1 }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'login_pending'
        );
        assert.equal((await loadStoredConfig(context.file, 'alpha')).pendingDeviceLogin?.deliveryUncertain, true);
        context.auth.polls = [{ status: 'expired' }];
        await assert.rejects(
            login({ apiUrl: HOSTING_URL, resume: true, timeoutSeconds: 20 }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'device_credential_lost'
        );
        assert.equal((await loadStoredConfig(context.file, 'alpha')).pendingDeviceLogin, undefined);
    } finally {
        await context.auth.close();
    }
});

test('a newer --no-wait cancels the older pending code', async () => {
    const context = await setup([{ status: 'pending' }]);
    try {
        await login({ ...context.options, noWait: true }, context.dependencies);
        await login({ ...context.options, noWait: true }, context.dependencies);
        assert.equal(context.auth.count('/identity/scoped-tokens/device/cancel'), 1);
    } finally {
        await context.auth.close();
    }
});

test('an older server that omits tenant and lifetime details is accepted', async () => {
    const context = await setup([
        {
            status: 'approved',
            approvedBy: { email: null, tenantName: 'Acme Co' },
            credential: { jwt: JWT, tenantId: TENANT_ID, expiresAt: Date.now() + 3_600_000 }
        }
    ]);
    try {
        const result = await login({ ...context.options, timeoutSeconds: 20 }, context.dependencies);
        assert(result.status === 'authenticated');
        assert.equal(result.tenantName, 'Acme Co');
        assert.equal(result.grantExpiresAt, undefined);
        const saved = (await loadStoredConfig(context.file, 'alpha')).logins?.[`unknown:${TENANT_ID}`];
        assert.equal(saved?.grantExpiresAt, undefined);
        assert.equal(saved?.accountEmail, undefined);
    } finally {
        await context.auth.close();
    }
});

test('malformed or mismatching server responses are rejected without echoing them', async () => {
    const cases: [string, Record<string, unknown>, Record<string, unknown>?][] = [
        ['a malformed user code', {}, { startOverrides: { userCode: 'abc' } }],
        ['a malformed device code', {}, { startOverrides: { deviceCode: 'zdc_short' } }],
        ['an insecure approval page', {}, { startOverrides: { verificationUri: 'http://evil.example.com/cli/device' } }],
        ['a credential for another permission set', approvedPoll({}, { permissionKeys: ['hosting.deploy'] }) as Record<string, unknown>],
        ['a renewal token that was not requested', approvedPoll({}, { renewalToken: RENEWAL_TOKEN }) as Record<string, unknown>]
    ];
    for (const [label, poll, startOverrides] of cases) {
        const context = await setup([poll]);
        Object.assign(context.auth.startOverrides, startOverrides?.startOverrides ?? {});
        try {
            let message = '';
            await assert.rejects(login({ ...context.options, timeoutSeconds: 20 }, context.dependencies), (error: unknown) => {
                assert(error instanceof CliError, label);
                assert.equal(error.code, 'invalid_auth_response', label);
                message = error.message;
                return true;
            });
            assertNoSecrets(message);
            assert.deepEqual(await loadStoredConfig(context.file, 'alpha'), {}, label);
        } finally {
            await context.auth.close();
        }
    }
});

test('a failure to store the credential after approval revokes the grant and leaves no login', async () => {
    const context = await setup([approvedPoll({}, { renewalToken: RENEWAL_TOKEN })]);
    try {
        const revoked: string[] = [];
        await assert.rejects(
            login(
                { ...context.options, renewable: true, timeoutSeconds: 20 },
                {
                    ...context.dependencies,
                    renewalTokenStore: {
                        async get() {
                            return undefined;
                        },
                        async set() {
                            throw new CliError('disk full', 3, 'credential_store_failed');
                        },
                        async delete() {}
                    },
                    scopedTokenClient: url =>
                        Object.assign(new ScopedTokenClient(url), {
                            async revoke(token: string) {
                                revoked.push(token);
                            }
                        })
                }
            ),
            (error: unknown) => error instanceof CliError && error.code === 'credential_store_failed'
        );
        assert.deepEqual(revoked, [JWT]);
        assert.deepEqual(await loadStoredConfig(context.file, 'alpha'), {});
    } finally {
        await context.auth.close();
    }
});

test('at the give-up deadline an uncertain delivery is a lost credential, not an expiry', async () => {
    const options = {
        client: {
            async pollDevice(): Promise<never> {
                throw new HttpError('down', 0);
            },
            async cancelDevice() {}
        },
        deviceCode: DEVICE_CODE,
        interval: 0.01,
        expectation: { renewable: false, permissionKeys: ['hosting.sitesRead'] }
    };
    const code = (error: unknown) => (error instanceof CliError ? error.code : undefined);
    await assert.rejects(
        pollDeviceApproval({ ...options, giveUpAt: Date.now() - 1, uncertain: true }),
        (error: unknown) => code(error) === 'device_credential_lost'
    );
    await assert.rejects(
        pollDeviceApproval({ ...options, giveUpAt: Date.now() + 300 }),
        (error: unknown) => code(error) === 'device_credential_lost'
    );
    await assert.rejects(
        pollDeviceApproval({
            ...options,
            client: {
                ...options.client,
                async pollDevice() {
                    return { status: 'pending' as const };
                }
            },
            giveUpAt: Date.now() + 100
        }),
        (error: unknown) => code(error) === 'device_code_expired'
    );
});

test('a resume only changes or removes the pending sign-in it is handling', async () => {
    const context = await setup([{ status: 'pending' }]);
    try {
        await login({ ...context.options, noWait: true }, context.dependencies);
        const first = (await loadStoredConfig(context.file, 'alpha')).pendingDeviceLogin!;
        // While the resume polls, another process replaces the pending sign-in with a different code.
        let replaced = false;
        const replacement = { ...first, deviceCode: `zdc_${'Z'.repeat(43)}`, userCode: 'WXYZ-2345' };
        await assert.rejects(
            login(
                { apiUrl: HOSTING_URL, resume: true, timeoutSeconds: 1 },
                {
                    ...context.dependencies,
                    scopedTokenClient: url => {
                        const real = new ScopedTokenClient(url);
                        return Object.assign(real, {
                            async pollDevice(): Promise<never> {
                                if (!replaced) {
                                    replaced = true;
                                    await updateProfile(
                                        'alpha',
                                        { ...(await loadStoredConfig(context.file, 'alpha')), pendingDeviceLogin: replacement },
                                        context.file
                                    );
                                }
                                throw new HttpError('down', 0);
                            }
                        });
                    }
                }
            ),
            (error: unknown) => error instanceof CliError && error.code === 'login_pending'
        );
        const now = (await loadStoredConfig(context.file, 'alpha')).pendingDeviceLogin;
        assert.equal(now?.deviceCode, replacement.deviceCode);
        assert.equal(now?.deliveryUncertain, undefined);
    } finally {
        await context.auth.close();
    }
});
