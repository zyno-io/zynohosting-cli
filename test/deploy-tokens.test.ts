import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ProcessResult } from '../src/deploy-tokens/handoff.js';

import { createDeployToken, listDeployTokens, revokeDeployToken } from '../src/commands/deploy-tokens.js';
import { loadStoredConfig } from '../src/config.js';
import { deliverSecret } from '../src/deploy-tokens/handoff.js';
import { CliError } from '../src/errors.js';
import {
    approvedPoll,
    displayApprovedPoll,
    grantDisplay,
    HUMAN_JWT,
    KEY_ID,
    keyInfo,
    listRow,
    OTHER_SITE_ID,
    REQUEST_CODE,
    SECRET,
    SITE_ID,
    selfRow,
    startFakeKeyServer
} from './support/fake-key-server.js';

interface Call {
    command: string;
    args: string[];
    input?: string | undefined;
}

async function setup(responses: (call: Call) => Partial<ProcessResult> | undefined = () => undefined) {
    const root = await mkdtemp(join(tmpdir(), 'deploy-tokens-'));
    const file = join(root, 'config.json');
    const server = await startFakeKeyServer();
    const output: string[] = [];
    const events: Record<string, unknown>[] = [];
    const warnings: string[] = [];
    const calls: Call[] = [];
    const opened: string[] = [];
    const dependencies = {
        env: { ZYNOHOSTING_CONFIG: file, ZYNOHOSTING_ACCESS_TOKEN: HUMAN_JWT } as NodeJS.ProcessEnv,
        write: (message: string) => output.push(message),
        emit: (event: Record<string, unknown>) => events.push(event),
        warn: (message: string) => warnings.push(message),
        openUrl: async (url: string) => {
            opened.push(url);
        },
        run: async (command: string, args: string[], options?: { input?: string | undefined }): Promise<ProcessResult> => {
            const call: Call = { command, args, input: options?.input };
            calls.push(call);
            return { code: 0, stdout: '', stderr: '', ...responses(call) };
        }
    };
    const options = { apiUrl: server.url, authApiUrl: server.url, production: true, json: true };
    return { root, file, server, output, events, warnings, calls, opened, dependencies, options };
}

/** Everything a person, a log, or an agent could see. */
function visible(context: { output: string[]; events: Record<string, unknown>[]; warnings: string[]; calls: Call[] }, extra = ''): string {
    // The one place the secret may legitimately go is a hand-off program's stdin, so it is not part of what is visible.
    const argv = context.calls.map(call => [call.command, ...call.args].join(' '));
    return [...context.output, JSON.stringify(context.events), ...context.warnings, ...argv, extra].join('\n');
}

function assertNoSecret(text: string): void {
    assert(!text.includes(SECRET), 'the deploy token must never be shown');
    assert(!text.includes(SECRET.slice(4)), 'the deploy token body must never be shown');
    assert(!text.includes(REQUEST_CODE), 'the request code must never be shown');
}

test('a GitHub hand-off puts the token on stdin of gh secret set and nowhere else', async () => {
    const context = await setup();
    try {
        const result = await createDeployToken('example.com', { ...context.options, github: 'acme/web' }, context.dependencies);

        assert.equal(result.status, 'created');
        const set = context.calls.find(call => call.args[0] === 'secret' && call.args[1] === 'set');
        assert.deepEqual(set?.args, ['secret', 'set', 'ZYNOHOSTING_DEPLOY_TOKEN', '-R', 'acme/web']);
        assert.equal(set?.input, SECRET);
        // Preflight ran before the request was made.
        assert.deepEqual(
            context.calls.slice(0, 2).map(call => call.args.slice(0, 2).join(' ')),
            ['auth status', 'secret list']
        );

        const start = context.server.seen.find(entry => entry.url === '/identity/key-requests')!;
        assert.equal(start.authorization, `Bearer ${HUMAN_JWT}`);
        assert.deepEqual(start.body.permissions, []);
        assert.deepEqual(start.body.grants, { hosting: [{ v: 1, siteId: SITE_ID, environments: ['production'] }] });
        assert.equal('capabilities' in start.body, false);
        assert.equal(start.body.delivery, 'poll');
        assert.deepEqual(start.body.handoff, { kind: 'github-secret', target: 'acme/web' });
        assert.equal(typeof start.body.description, 'string');
        assert.equal(context.opened.length, 1);

        assertNoSecret(visible(context, JSON.stringify(result)));
        assert.equal(context.server.count('POST', '/identity/tenant-keys/self-revoke'), 0);
    } finally {
        await context.server.close();
    }
});

test('a GitHub environment secret and a custom name are passed as arguments', async () => {
    const context = await setup();
    try {
        await createDeployToken(
            'example.com',
            { ...context.options, github: 'acme/web', githubEnvironment: 'production', name: 'DEPLOY_KEY' },
            context.dependencies
        );
        const set = context.calls.find(call => call.args[1] === 'set');
        assert.deepEqual(set?.args, ['secret', 'set', 'DEPLOY_KEY', '-R', 'acme/web', '--env', 'production']);
    } finally {
        await context.server.close();
    }
});

test('a GitLab hand-off creates a masked variable with the token on stdin', async () => {
    const context = await setup(call => (call.command === 'glab' && call.args[1] === 'get' ? { code: 1 } : undefined));
    try {
        await createDeployToken(
            'example.com',
            { ...context.options, gitlab: 'group/sub/project', preview: true, production: false },
            context.dependencies
        );
        const set = context.calls.find(call => call.command === 'glab' && call.args[1] === 'set');
        assert.deepEqual(set?.args, ['variable', 'set', 'ZYNOHOSTING_DEPLOY_TOKEN', '--masked', '-R', 'group/sub/project']);
        assert.equal(set?.input, SECRET);
        const start = context.server.seen.find(entry => entry.url === '/identity/key-requests')!;
        assert.deepEqual((start.body.grants as { hosting: Array<{ environments: string[] }> }).hosting[0]!.environments, ['preview']);
        assert.deepEqual(start.body.handoff, { kind: 'gitlab-variable', target: 'group/sub/project' });
        assertNoSecret(visible(context));
    } finally {
        await context.server.close();
    }
});

test('a failed hand-off revokes the new token with itself, exits non-zero, and never shows the token', async () => {
    // gh echoes the secret in its error: the message must still be clean.
    const context = await setup(call => (call.args[1] === 'set' ? { code: 1, stderr: `HTTP 403: could not set ${SECRET}` } : undefined));
    try {
        await assert.rejects(createDeployToken('example.com', { ...context.options, github: 'acme/web' }, context.dependencies), (error: unknown) => {
            assert(error instanceof CliError);
            assert.equal(error.code, 'handoff_failed');
            assert.notEqual(error.exitCode, 0);
            assert.match(error.message, /revoked/);
            assertNoSecret(error.message + JSON.stringify(error.details ?? ''));
            return true;
        });
        const revoke = context.server.seen.find(entry => entry.url === '/identity/tenant-keys/self-revoke');
        assert.equal(revoke?.authorization, `Basic ${Buffer.from(`api:${SECRET}`).toString('base64')}`);
        assertNoSecret(visible(context));
    } finally {
        await context.server.close();
    }
});

test('when the self-revoke also fails the error names the key id to revoke by hand', async () => {
    const context = await setup(call => (call.args[1] === 'set' ? { code: 1, stderr: 'nope' } : undefined));
    context.server.state.selfRevokeStatus = 500;
    try {
        await assert.rejects(createDeployToken('example.com', { ...context.options, github: 'acme/web' }, context.dependencies), (error: unknown) => {
            assert(error instanceof CliError);
            assert.equal(error.code, 'handoff_failed');
            assert.match(error.message, new RegExp(KEY_ID));
            assert.match(error.message, /could not be revoked/);
            assertNoSecret(error.message);
            return true;
        });
    } finally {
        await context.server.close();
    }
});

test('a destination that is not ready fails before any request is made', async () => {
    const context = await setup(call => (call.args[0] === 'secret' && call.args[1] === 'list' ? { code: 1 } : undefined));
    try {
        await assert.rejects(
            createDeployToken('example.com', { ...context.options, github: 'acme/web' }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'handoff_unavailable'
        );
        assert.equal(context.server.count('POST', '/identity/key-requests'), 0);
    } finally {
        await context.server.close();
    }
});

test('a file hand-off creates a new 0600 file, never overwrites, and warns inside an unignored git worktree', async () => {
    const context = await setup(call => {
        if (call.command === 'git' && call.args[0] === 'rev-parse') return { stdout: 'true\n' };
        if (call.command === 'git' && call.args[0] === 'check-ignore') return { code: 1 };
        return undefined;
    });
    const target = join(context.root, 'token.txt');
    try {
        const result = await createDeployToken('example.com', { ...context.options, file: target }, context.dependencies);
        assert.equal(result.status, 'created');
        assert.equal((await readFile(target, 'utf8')).trim(), SECRET);
        if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600);
        assert.equal(context.warnings.length, 1);
        assert.match(context.warnings[0]!, /git worktree/);
        assertNoSecret(visible(context, JSON.stringify(result)));

        // A second run never replaces it, and says so before asking for a token.
        const before = context.server.count('POST', '/identity/key-requests');
        await assert.rejects(
            createDeployToken('example.com', { ...context.options, file: target }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'handoff_unavailable'
        );
        assert.equal(context.server.count('POST', '/identity/key-requests'), before);
        assert.equal((await readFile(target, 'utf8')).trim(), SECRET);
    } finally {
        await context.server.close();
    }
});

test('a file that appears after the preflight is not overwritten, and the token is revoked', async () => {
    const context = await setup();
    const target = join(context.root, 'race.txt');
    // The browser opens after the preflight and the request; the file shows up right then.
    context.dependencies.openUrl = async () => {
        await writeFile(target, 'precious');
    };
    try {
        await assert.rejects(
            createDeployToken('example.com', { ...context.options, file: target }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'handoff_failed'
        );
        assert.equal(await readFile(target, 'utf8'), 'precious');
        assert.equal(context.server.count('POST', '/identity/tenant-keys/self-revoke'), 1);
    } finally {
        await context.server.close();
    }
});

test('without a destination the token is shown on the approval page only, and a leaked secret is dropped', async () => {
    const context = await setup();
    // A server that wrongly included the secret for display delivery.
    context.server.state.polls = [displayApprovedPoll({ secret: SECRET })];
    try {
        const result = await createDeployToken('example.com', { ...context.options, both: true, production: false }, context.dependencies);
        assert.equal(result.status, 'created');
        const start = context.server.seen.find(entry => entry.url === '/identity/key-requests')!;
        assert.equal(start.body.delivery, 'display');
        assert.deepEqual(start.body.handoff, { kind: 'manual' });
        assert.deepEqual((start.body.grants as { hosting: Array<{ environments: string[] }> }).hosting[0]!.environments, ['preview', 'production']);
        assert.equal(context.calls.length, 0);
        assertNoSecret(visible(context, JSON.stringify(result)));
        assert.match(context.output.join(''), /approval page/);
    } finally {
        await context.server.close();
    }
});

test('a denied request fails with key_request_denied and hands nothing off', async () => {
    const context = await setup();
    context.server.state.polls = [{ status: 'pending' }, { status: 'denied' }];
    try {
        await assert.rejects(
            createDeployToken('example.com', { ...context.options, github: 'acme/web' }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'key_request_denied'
        );
        assert(!context.calls.some(call => call.args[1] === 'set'));
    } finally {
        await context.server.close();
    }
});

test('--no-wait saves the request and --resume finishes it without asking for anything again', async () => {
    const context = await setup();
    context.server.state.polls = [{ status: 'pending' }, displayApprovedPoll()];
    try {
        const first = await createDeployToken('example.com', { ...context.options, noWait: true }, context.dependencies);
        assert.equal(first.status, 'pending');
        const saved = (await loadStoredConfig(context.file, 'url:' + context.server.url)).pendingKeyRequest;
        assert.equal(saved?.userCode, 'ABCD-EFGH');
        assert.equal(saved?.delivery, 'display');
        // The saved request is the credential for collecting the key, so the file must be private.
        if (process.platform !== 'win32') assert.equal((await stat(context.file)).mode & 0o777, 0o600);

        const second = await createDeployToken(undefined, { apiUrl: context.server.url, resume: true, json: true }, context.dependencies);
        assert.equal(second.status, 'created');
        assert.equal(context.server.count('POST', '/identity/key-requests'), 1);
        assert.equal((await loadStoredConfig(context.file, 'url:' + context.server.url)).pendingKeyRequest, undefined);
        assertNoSecret(visible(context));
    } finally {
        await context.server.close();
    }
});

test('--resume with nothing saved, and a resume with other options, are refused', async () => {
    const context = await setup();
    try {
        await assert.rejects(
            createDeployToken(undefined, { apiUrl: context.server.url, resume: true }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'no_pending_key_request'
        );
        await assert.rejects(
            createDeployToken('example.com', { apiUrl: context.server.url, resume: true }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'invalid_input'
        );
    } finally {
        await context.server.close();
    }
});

test('input errors are caught before any request: no environment, two environments, two destinations, bad lifetime', async () => {
    const context = await setup();
    const base = { apiUrl: context.server.url, authApiUrl: context.server.url };
    const code = (options: Record<string, unknown>) =>
        createDeployToken('example.com', { ...base, ...options }, context.dependencies).then(
            () => 'ok',
            (error: unknown) => (error instanceof CliError ? error.code : 'other')
        );
    try {
        assert.equal(await code({}), 'invalid_input');
        assert.equal(await code({ production: true, preview: true }), 'invalid_input');
        assert.equal(await code({ production: true, github: 'a/b', gitlab: 'a/b' }), 'invalid_input');
        assert.equal(await code({ production: true, lifetime: '7d' }), 'invalid_input');
        assert.equal(await code({ production: true, github: 'not a repo' }), 'invalid_input');
        assert.equal(await code({ production: true, github: 'a/b', name: '--oops' }), 'invalid_input');
        assert.equal(context.server.count('POST', '/identity/key-requests'), 0);
    } finally {
        await context.server.close();
    }
});

test('a tenant API key cannot request a deploy token', async () => {
    const context = await setup();
    try {
        await assert.rejects(
            createDeployToken(
                'example.com',
                { ...context.options },
                { ...context.dependencies, env: { ZYNOHOSTING_CONFIG: context.file, ZYNOHOSTING_API_KEY: 'zak_tenant-key' } }
            ),
            (error: unknown) => error instanceof CliError && error.code === 'login_required'
        );
        assert.equal(context.server.count('POST', '/identity/key-requests'), 0);
    } finally {
        await context.server.close();
    }
});

test('a deploy token in the environment cannot create, list, or revoke other tokens', async () => {
    const context = await setup();
    const env = { ZYNOHOSTING_CONFIG: context.file, ZYNOHOSTING_DEPLOY_TOKEN: SECRET };
    try {
        for (const run of [
            () => createDeployToken('example.com', context.options, { ...context.dependencies, env }),
            () => listDeployTokens(undefined, context.options, { ...context.dependencies, env }),
            () => revokeDeployToken(KEY_ID, context.options, { ...context.dependencies, env })
        ]) {
            await assert.rejects(run(), (error: unknown) => {
                assert(error instanceof CliError);
                assert.equal(error.code, 'deploy_token_not_allowed');
                assertNoSecret(error.message);
                return true;
            });
        }
        assert.equal(context.server.seen.length, 0);
    } finally {
        await context.server.close();
    }
});

test('revoke --self uses the token as its own credential, and the token never reaches output', async () => {
    const context = await setup();
    const env = { ZYNOHOSTING_CONFIG: context.file, ZYNOHOSTING_DEPLOY_TOKEN: SECRET };
    try {
        await revokeDeployToken(undefined, { ...context.options, self: true }, { ...context.dependencies, env });
        const revoke = context.server.seen.find(entry => entry.url === '/identity/tenant-keys/self-revoke')!;
        assert.equal(revoke.authorization, `Basic ${Buffer.from(`api:${SECRET}`).toString('base64')}`);
        assertNoSecret(visible(context));
        // --self without the variable is an error, not a request.
        await assert.rejects(
            revokeDeployToken(undefined, { ...context.options, self: true }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'invalid_input'
        );
    } finally {
        await context.server.close();
    }
});

test('list filters by site and prints no secret; revoke by id calls the tenant endpoint', async () => {
    const context = await setup();
    context.server.state.keys = [listRow({ description: 'CI for example.com', createdByEmail: 'owner@example.com' })];

    try {
        const keys = await listDeployTokens('example.com', context.options, context.dependencies);
        assert.equal(keys.length, 1);
        assert.deepEqual(keys[0]!.sites, [{ siteId: SITE_ID, label: 'example.com', environments: ['production'] }]);
        assert.deepEqual(keys[0]!.permissionKeys, ['hosting']);
        const request = context.server.seen.find(entry => entry.url.startsWith('/tenant/capability-keys'))!;
        const query = new URL(request.url, 'http://x').searchParams;
        assert.equal(query.get('app'), 'hosting');
        assert.equal(query.has('ref') || query.has('namespace'), false);
        // The site filter is applied to the key's site grants: another site's list is empty.
        context.server.state.keys = [listRow({ display: grantDisplay([[OTHER_SITE_ID, 'other.example', ['preview']]]) })];
        assert.deepEqual(await listDeployTokens('example.com', context.options, context.dependencies), []);
        assertNoSecret(visible(context));

        await revokeDeployToken(KEY_ID, context.options, context.dependencies);
        assert.equal(context.server.count('DELETE', `/tenant/capability-keys/${KEY_ID}`), 1);
    } finally {
        await context.server.close();
    }
});

test('revoking a key ZynoAuth no longer has is a success that says so', async () => {
    const context = await setup();
    context.server.state.revokeStatus = 404;
    try {
        await revokeDeployToken(KEY_ID, context.options, context.dependencies);
        assert.match(context.output.join(''), /already revoked or never existed/);
        assert.equal(context.events.at(-1)?.alreadyRevoked, true);
        context.server.state.revokeStatus = 403;
        await assert.rejects(
            revokeDeployToken(KEY_ID, context.options, context.dependencies),
            (error: unknown) => (error as { status?: number }).status === 403
        );
    } finally {
        await context.server.close();
    }
});

test('rotating a GitLab variable keeps its protected, raw, and type settings and never shows the old value', async () => {
    const existing = JSON.stringify({
        key: 'ZYNOHOSTING_DEPLOY_TOKEN',
        value: 'old-secret-value',
        protected: true,
        raw: true,
        variable_type: 'file',
        masked: true
    });
    const context = await setup(call => (call.command === 'glab' && call.args[1] === 'get' ? { code: 0, stdout: existing } : undefined));
    try {
        await createDeployToken('example.com', { ...context.options, gitlab: 'group/project' }, context.dependencies);
        const update = context.calls.find(call => call.command === 'glab' && call.args[1] === 'update');
        assert.deepEqual(update?.args, [
            'variable',
            'update',
            'ZYNOHOSTING_DEPLOY_TOKEN',
            '--masked',
            '--protected',
            '--raw',
            '--type',
            'file',
            '-R',
            'group/project'
        ]);
        assert.equal(update?.input, SECRET);
        assert(!visible(context).includes('old-secret-value'));
    } finally {
        await context.server.close();
    }
});

test('the real hand-off passes the token on stdin and never in an argument', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'fake-gh-'));
    const log = join(root, 'log.json');
    const stdinFile = join(root, 'stdin.txt');
    const script = join(root, 'gh');
    await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$*" > '${log}'\ncat > '${stdinFile}'\n`);
    await chmod(script, 0o755);
    const original = process.env.PATH;
    process.env.PATH = `${root}:${original}`;
    try {
        const outcome = await deliverSecret({ kind: 'github', repo: 'acme/web', name: 'ZYNOHOSTING_DEPLOY_TOKEN' }, SECRET);
        assert.match(outcome.destination, /acme\/web/);
        const args = await readFile(log, 'utf8');
        assert(!args.includes(SECRET), 'argv must not hold the secret');
        assert.match(args, /secret set ZYNOHOSTING_DEPLOY_TOKEN -R acme\/web/);
        assert.equal(await readFile(stdinFile, 'utf8'), SECRET);
    } finally {
        process.env.PATH = original;
    }
});

test('a preview-only token for a site that runs PHP fails before any request, with the reason', async () => {
    const context = await setup();
    context.server.state.phpVersion = '8.4';
    try {
        await assert.rejects(
            createDeployToken('example.com', { ...context.options, production: false, preview: true, github: 'acme/web' }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'deploy_token_requires_production' && /PHP/.test(error.message)
        );
        assert.equal(context.server.count('POST', '/identity/key-requests'), 0);
        assert.equal(context.calls.length, 0, 'not even the hand-off preflight ran');
    } finally {
        await context.server.close();
    }
});

test('ZynoAuth responses are parsed strictly: a malformed start, poll, or list is rejected', async () => {
    const { KeyRequestClient } = await import('../src/api/key-request-client.js');
    const context = await setup();
    try {
        const client = new KeyRequestClient(context.server.url);
        const bad = async (script: Record<string, unknown>, delivery: 'poll' | 'display' = 'poll') => {
            context.server.state.polls = [script as never];
            return client.poll(REQUEST_CODE, delivery).then(
                () => 'ok',
                (error: unknown) => (error instanceof CliError ? error.code : 'other')
            );
        };
        // Poll delivery without a secret, with a malformed one, and answered as the other delivery.
        assert.equal(await bad({ status: 'approved', delivery: 'poll', key: (approvedPoll() as { key: unknown }).key }), 'invalid_auth_response');
        assert.equal(await bad({ ...(approvedPoll() as object), secret: 'zck_short' }), 'invalid_auth_response');
        // With a well-formed secret present, an unusable answer revokes the key instead (see the revoke test below).
        assert.equal(await bad({ ...(approvedPoll() as object), delivery: 'display' }), 'key_credential_lost');
        assert.equal(await bad({ ...(displayApprovedPoll() as object) }), 'invalid_auth_response');
        assert.equal(await bad({ status: 'mystery' }), 'invalid_auth_response');
        // A key without its fields.
        assert.equal(await bad({ status: 'approved', delivery: 'poll', secret: SECRET, key: { id: KEY_ID } }), 'key_credential_lost');
    } finally {
        await context.server.close();
    }
});

test('a GitLab variable that already exists is updated, a new one is created, and the old value is never shown', async () => {
    for (const exists of [true, false]) {
        const context = await setup(call =>
            call.command === 'glab' && call.args[1] === 'get' ? { code: exists ? 0 : 1, stdout: 'old-secret-value' } : undefined
        );
        try {
            await createDeployToken('example.com', { ...context.options, gitlab: 'group/project' }, context.dependencies);
            const write = context.calls.find(call => call.command === 'glab' && (call.args[1] === 'set' || call.args[1] === 'update'));
            assert.deepEqual(write?.args, ['variable', exists ? 'update' : 'set', 'ZYNOHOSTING_DEPLOY_TOKEN', '--masked', '-R', 'group/project']);
            assert.equal(write?.input, SECRET);
            assert(!visible(context).includes('old-secret-value'));
        } finally {
            await context.server.close();
        }
    }
});

test('--no-wait over a saved request cancels the old one on the server and keeps the new one', async () => {
    const context = await setup();
    try {
        await createDeployToken('example.com', { ...context.options, noWait: true }, context.dependencies);
        await createDeployToken('example.com', { ...context.options, noWait: true }, context.dependencies);
        const cancels = context.server.seen.filter(entry => entry.url === '/identity/key-requests/cancel');
        assert.equal(cancels.length, 1);
        assert.equal(cancels[0]!.body.requestCode, REQUEST_CODE);
        const saved = (await loadStoredConfig(context.file, `url:${context.server.url}`)).pendingKeyRequest;
        assert.notEqual(saved?.requestCode, REQUEST_CODE);
    } finally {
        await context.server.close();
    }
});

test('a resumed request clears its uncertain flag after a good poll, and display delivery never reports a lost key', async () => {
    const context = await setup();
    try {
        await createDeployToken('example.com', { ...context.options, noWait: true }, context.dependencies);
        const resumeOptions = { apiUrl: context.server.url, resume: true, json: true };
        // A dropped poll marks it uncertain; a pending answer afterwards clears the mark.
        context.server.state.polls = ['drop', { status: 'pending' }];
        await assert.rejects(
            createDeployToken(undefined, { ...resumeOptions, timeoutSeconds: 1 }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'key_request_pending'
        );
        const saved = (await loadStoredConfig(context.file, `url:${context.server.url}`)).pendingKeyRequest;
        assert(saved);
        assert.equal(saved.deliveryUncertain, undefined);

        // After a dropped poll an `expired` answer is an ordinary expiry for display delivery, and the saved request is removed.
        context.server.state.polls = ['drop', { status: 'expired' }];
        await assert.rejects(
            createDeployToken(undefined, resumeOptions, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'key_request_expired'
        );
        assert.equal((await loadStoredConfig(context.file, `url:${context.server.url}`)).pendingKeyRequest, undefined);
    } finally {
        await context.server.close();
    }
});

test('an approved poll-delivery answer that cannot be read revokes the token with itself and never shows it', async () => {
    const { KeyRequestClient } = await import('../src/api/key-request-client.js');
    const context = await setup();
    try {
        const client = new KeyRequestClient(context.server.url);
        const unreadable = [
            // The key is malformed.
            { ...(approvedPoll() as object), key: { id: KEY_ID } },
            // Not JSON at all, with the token inside.
            { rawBody: `<html>${SECRET}` }
        ];
        for (const script of unreadable) {
            context.server.state.polls = [script as never];
            const before = context.server.count('POST', '/identity/tenant-keys/self-revoke');
            await assert.rejects(client.poll(REQUEST_CODE, 'poll'), (error: unknown) => {
                assert(error instanceof CliError);
                assert.equal(error.code, 'key_credential_lost');
                assert.match(error.message, /revoked/);
                assertNoSecret(error.message);
                return true;
            });
            assert.equal(context.server.count('POST', '/identity/tenant-keys/self-revoke'), before + 1);
            const revoke = context.server.seen.filter(entry => entry.url === '/identity/tenant-keys/self-revoke').at(-1)!;
            assert.equal(revoke.authorization, `Basic ${Buffer.from(`api:${SECRET}`).toString('base64')}`);
        }
        // Display delivery has no secret to revoke, so an unreadable answer is just an invalid response.
        context.server.state.polls = [{ status: 'approved', delivery: 'display' }];
        await assert.rejects(
            client.poll(REQUEST_CODE, 'display'),
            (error: unknown) => error instanceof CliError && error.code === 'invalid_auth_response'
        );
    } finally {
        await context.server.close();
    }
});

test('hand-off programs run from a neutral directory', { skip: process.platform === 'win32' }, async () => {
    const { runProcess } = await import('../src/deploy-tokens/handoff.js');
    const { realpath } = await import('node:fs/promises');
    const result = await runProcess('pwd', []);
    assert.equal(result.stdout.trim(), await realpath(tmpdir()));
});

test('--permission is sent with the request, deduplicated, and shown to the approver as ZynoAuth normalized it', async () => {
    const context = await setup();
    try {
        const result = await createDeployToken(
            'example.com',
            { ...context.options, permission: ['hosting.sitesRead', 'hosting.sitesRead', 'hosting.deploy'], noWait: true },
            context.dependencies
        );
        const start = context.server.seen.find(entry => entry.url === '/identity/key-requests')!;
        assert.deepEqual(start.body.permissions, ['hosting.sitesRead', 'hosting.deploy']);
        assert.deepEqual(start.body.grants, { hosting: [{ v: 1, siteId: SITE_ID, environments: ['production'] }] });
        assert.equal(result.status, 'pending');
        // The server adds the bare app key and sorts; that is what is reported, not what was sent.
        assert.deepEqual(result.status === 'pending' && result.permissions, ['hosting.deploy', 'hosting.sitesRead']);
        assert.match(context.output.join(''), /with hosting\.deploy, hosting\.sitesRead/);
    } finally {
        await context.server.close();
    }
});

test('--permission is checked loosely before anything is requested, and does not combine with --resume', async () => {
    const context = await setup();
    try {
        for (const bad of ['', 'Hosting', 'hosting..deploy', 'hosting.sites read', '.hosting', '1hosting', 'x'.repeat(101)]) {
            await assert.rejects(
                createDeployToken('example.com', { ...context.options, permission: [bad] }, context.dependencies),
                (error: unknown) => error instanceof CliError && error.code === 'invalid_input' && /--permission/.test(error.message),
                bad
            );
        }
        // Unknown but well-formed keys are left to the server, which is authoritative.
        await createDeployToken('example.com', { ...context.options, permission: ['somefuture.key'], noWait: true }, context.dependencies);
        assert.equal(context.server.count('POST', '/identity/key-requests'), 1);
        await assert.rejects(
            createDeployToken(undefined, { ...context.options, resume: true, permission: ['hosting.sitesRead'] }, context.dependencies),
            (error: unknown) => error instanceof CliError && error.code === 'invalid_input'
        );
    } finally {
        await context.server.close();
    }
});

test('an approved key reports its permission keys and sites', async () => {
    const context = await setup();
    context.server.state.polls = [approvedPollWith(['hosting', 'hosting.sitesRead'])];
    try {
        const result = await createDeployToken('example.com', { ...context.options, github: 'acme/web' }, context.dependencies);
        assert.equal(result.status, 'created');
        assert.deepEqual(result.status === 'created' && result.permissionKeys, ['hosting', 'hosting.sitesRead']);
        assertNoSecret(visible(context, JSON.stringify(result)));
    } finally {
        await context.server.close();
    }
});

function approvedPollWith(permissionKeys: string[]) {
    return { status: 'approved', delivery: 'poll', secret: SECRET, key: keyInfo(['production'], permissionKeys) } as never;
}

test('the new ZynoAuth shapes are parsed strictly: start, key info, list rows, and the key itself', async () => {
    const { KeyRequestClient } = await import('../src/api/key-request-client.js');
    const context = await setup();
    try {
        const client = new KeyRequestClient(context.server.url);
        const input = {
            permissions: [],
            sites: [{ siteId: SITE_ID, environments: ['production' as const] }],
            description: 'CI',
            delivery: 'poll' as const
        };
        const start = await client.start({ type: 'bearer', token: HUMAN_JWT } as never, input);
        assert.deepEqual(start.requested, { permissions: [], sites: [{ siteId: SITE_ID, environments: ['production'] }] });

        const state = context.server.state;
        const verdict = async (call: () => Promise<unknown>) =>
            call().then(
                () => 'ok',
                (error: unknown) => (error instanceof CliError ? error.code : `other: ${String(error)}`)
            );
        const poll = (script: Record<string, unknown>) => {
            state.polls = [script as never];
            return verdict(() => client.poll(REQUEST_CODE, 'display'));
        };
        const info = keyInfo();
        assert.equal(await poll({ status: 'approved', delivery: 'display', key: info }), 'ok');
        // The old `capabilities` envelope is not a key.
        const { display: _display, permissionKeys: _permissionKeys, ...old } = info;
        assert.equal(
            await poll({ status: 'approved', delivery: 'display', key: { ...old, capabilities: { hosting: {} } } }),
            'invalid_auth_response'
        );
        // Each required field of the new shape.
        for (const field of ['permissionKeys', 'display', 'handoff', 'tenantId', 'description']) {
            const { [field]: _removed, ...partial } = info;
            assert.equal(await poll({ status: 'approved', delivery: 'display', key: partial }), 'invalid_auth_response', field);
        }
        // A hosting view whose grant is not a hosting grant.
        const bad = keyInfo();
        (bad.display as { hosting: { views: Array<{ grant: unknown }> } }).hosting.views[0]!.grant = { v: 2, siteId: 'nope', environments: [] };
        assert.equal(await poll({ status: 'approved', delivery: 'display', key: bad }), 'invalid_auth_response');

        // List rows and the self answer.
        const list = (rows: unknown[]) => {
            state.keys = rows;
            return verdict(() => client.list({ type: 'bearer', token: HUMAN_JWT } as never));
        };
        assert.equal(await list([listRow()]), 'ok');
        for (const field of ['apps', 'permissionKeys', 'display', 'status', 'lastUsedAt', 'createdByEmail', 'requestedByAccountId']) {
            const { [field]: _removed, ...partial } = listRow();
            assert.equal(await list([partial]), 'invalid_auth_response', field);
        }
        assert.equal(await list([listRow({ status: 'revoked' })]), 'invalid_auth_response');
        assert.equal(await list([listRow({ expiresAt: 'tomorrow' })]), 'invalid_auth_response');

        const self = await client.self(SECRET);
        assert.deepEqual(self.permissionKeys, ['hosting']);
        assert.deepEqual(self.apps, ['hosting']);
        for (const field of ['id', 'permissionKeys', 'expiresAt', 'display']) {
            const { [field]: _removed, ...partial } = selfRow(new Date().toISOString());
            state.self = { httpStatus: 200, body: partial };
            assert.equal(await verdict(() => client.self(SECRET)), 'invalid_auth_response', field);
        }
    } finally {
        await context.server.close();
    }
});

test('a start response that does not match the contract is rejected', async () => {
    const { KeyRequestClient } = await import('../src/api/key-request-client.js');
    const { createServer } = await import('node:http');
    const answers: Record<string, unknown>[] = [];
    const server = createServer((_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(answers.shift()));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const good = {
        requestId: '77777777-7777-4777-8777-777777777777',
        requestCode: REQUEST_CODE,
        userCode: 'ABCD-EFGH',
        verificationUri: `${base}/keys/approve`,
        verificationUriComplete: `${base}/keys/approve?code=ABCD-EFGH`,
        interval: 5,
        expiresIn: 600,
        expiresAt: Date.now() + 600_000,
        apps: ['hosting'],
        requested: { permissions: ['hosting'], grants: { hosting: [{ v: 1, siteId: SITE_ID, environments: ['production'] }] } },
        views: { hosting: [] },
        lifetime: { optionsSecs: [2592000], defaultSecs: 2592000 }
    };
    try {
        const client = new KeyRequestClient(base);
        const credential = { type: 'bearer', token: HUMAN_JWT } as never;
        const input = {
            permissions: [],
            sites: [{ siteId: SITE_ID, environments: ['production' as const] }],
            description: 'CI',
            delivery: 'poll' as const
        };
        answers.push(good);
        assert.equal((await client.start(credential, input)).userCode, 'ABCD-EFGH');
        for (const field of ['requested', 'apps', 'views', 'lifetime', 'requestId', 'expiresIn']) {
            const { [field]: _removed, ...partial } = good as Record<string, unknown>;
            answers.push(partial);
            await assert.rejects(
                client.start(credential, input),
                (error: unknown) => error instanceof CliError && error.code === 'invalid_auth_response',
                field
            );
        }
        // A grant in the wrong shape (the old namespace and ref fields are not part of it).
        answers.push({
            ...good,
            requested: { permissions: ['hosting'], grants: { hosting: [{ v: 1, siteId: 'x', environments: ['production'] }] } }
        });
        await assert.rejects(
            client.start(credential, input),
            (error: unknown) => error instanceof CliError && error.code === 'invalid_auth_response'
        );
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
