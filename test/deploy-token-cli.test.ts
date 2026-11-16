import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createProgram } from '../src/cli.js';
import { KEY_ID, OTHER_SITE_ID, SECRET, SITE_ID, selfRow, startFakeKeyServer } from './support/fake-key-server.js';

async function run(args: string[], env: Record<string, string>): Promise<{ out: string; err: string }> {
    const original = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
    const saved = new Map(Object.keys(env).map(name => [name, process.env[name]]));
    Object.assign(process.env, env);
    let out = '';
    let err = '';
    // The test runner reports over stdout as binary frames; only capture the CLI's string output.
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        if (typeof chunk !== 'string') return (original.out as (...a: unknown[]) => boolean)(chunk, ...rest);
        out += chunk;
        return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
        err += String(chunk);
        return true;
    }) as typeof process.stderr.write;
    try {
        await createProgram().parseAsync(['node', 'zynohosting', ...args]);
    } finally {
        process.stdout.write = original.out;
        process.stderr.write = original.err;
        for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
    return { out, err };
}

test('the deploy-tokens command group and sites runtime are registered', () => {
    const program = createProgram();
    const group = program.commands.find(command => command.name() === 'deploy-tokens');
    assert.deepEqual(group?.commands.map(command => command.name()).sort(), ['create', 'list', 'revoke']);
    const create = group!.commands.find(command => command.name() === 'create')!;
    const flags = create.options.map(option => option.long);
    for (const flag of [
        '--production',
        '--preview',
        '--both',
        '--permission',
        '--lifetime',
        '--github',
        '--github-environment',
        '--gitlab',
        '--file',
        '--name',
        '--no-wait',
        '--resume'
    ]) {
        assert(flags.includes(flag), flag);
    }
    const sites = program.commands.find(command => command.name() === 'sites')!;
    assert(sites.commands.some(command => command.name() === 'runtime'));
    const deploy = program.commands.find(command => command.name() === 'deploy')!;
    assert.equal(deploy.registeredArguments[0]!.required, false, 'the site is optional so a deploy token can supply it');
});

test('sites runtime changes the runtime from the CLI', async () => {
    const server = await startFakeKeyServer();
    try {
        const { out } = await run(['--api-url', server.url, 'sites', 'runtime', 'example.com', 'php@8.3', '--yes', '--json'], {
            ZYNOHOSTING_API_KEY: 'zak_x',
            ZYNOHOSTING_CONFIG: '/nonexistent/c.json'
        });
        const events = out
            .trim()
            .split('\n')
            .map(line => JSON.parse(line) as Record<string, unknown>)
            .filter(event => event.type !== 'progress');
        assert.deepEqual(
            events.map(event => event.type),
            ['runtime_plan', 'runtime_result']
        );
        assert.equal(events[1]!.phpVersion, '8.3');
    } finally {
        await server.close();
    }
});

test('whoami with a deploy token lists its sites and takes the expiry from ZynoAuth, and never prints the token', async () => {
    const server = await startFakeKeyServer();
    const expiresAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    server.state.self = { httpStatus: 200, body: selfRow(expiresAt) };
    server.state.extraSites = [{ siteId: OTHER_SITE_ID, hostname: 'shop.example.org', environments: ['preview'] }];
    const args = ['--api-url', server.url, '--auth-api-url', server.url, 'whoami'];
    const env = { ZYNOHOSTING_DEPLOY_TOKEN: SECRET, ZYNOHOSTING_CONFIG: '/nonexistent/c.json' };
    try {
        const { out, err } = await run([...args, '--json'], env);
        const parsed = JSON.parse(out.trim()) as {
            deployToken: {
                keyId: string;
                sites: Array<{ site: string; siteId: string; environments: string[] }>;
                permissionKeys: string[];
                expiresAt: string;
            };
        };
        assert.equal(parsed.deployToken.keyId, KEY_ID);
        assert.deepEqual(parsed.deployToken.sites, [
            { site: 'example.com', siteId: SITE_ID, environments: ['production'] },
            { site: 'shop.example.org', siteId: OTHER_SITE_ID, environments: ['preview'] }
        ]);
        assert.deepEqual(parsed.deployToken.permissionKeys, ['hosting']);
        assert.equal(parsed.deployToken.expiresAt, new Date(expiresAt).toISOString());
        assert(!out.includes(SECRET) && !err.includes(SECRET));
        assert.equal(server.count('GET', '/identity/tenant-keys/self'), 1, 'the expiry comes from ZynoAuth');
        const self = server.seen.find(entry => entry.url === '/identity/tenant-keys/self')!;
        assert.equal(self.authorization, `Basic ${Buffer.from(`api:${SECRET}`).toString('base64')}`);

        const human = await run(args, env);
        assert.match(human.out, /example\.com \(production\), shop\.example\.org \(preview\); expires /);

        // Every granted site was deleted or transferred: whoami still answers, and says so.
        server.state.noSites = true;
        const empty = await run(args, env);
        assert.match(empty.out, /no longer covers any site/);
    } finally {
        await server.close();
    }
});

test('a tenant API key in CI warns on stderr, so JSON stdout stays one parseable document', async () => {
    const server = await startFakeKeyServer();
    const base = { ZYNOHOSTING_CONFIG: '/nonexistent/c.json' };
    try {
        const ci = await run(['--api-url', server.url, 'sites', 'list', '--json'], { ...base, ZYNOHOSTING_API_KEY: 'zak_x', CI: 'true' });
        const documents = JSON.parse(ci.out) as unknown;
        assert(Array.isArray(documents), 'stdout is the single sites document');
        const warnings = ci.err
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as Record<string, unknown>)
            .filter(event => event.type === 'warning');
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0]!.code, 'api_key_in_ci');
        assert(!ci.out.includes('api_key_in_ci'));

        const human = await run(['--api-url', server.url, 'sites', 'get', 'example.com'], { ...base, ZYNOHOSTING_API_KEY: 'zak_x', CI: 'true' });
        assert.match(human.err, /deploy token/);
        assert(!human.out.includes('api_key_in_ci'));

        const local = await run(['--api-url', server.url, 'sites', 'list', '--json'], { ...base, ZYNOHOSTING_API_KEY: 'zak_x', CI: '' });
        assert(!local.err.includes('api_key_in_ci'));
    } finally {
        await server.close();
    }
});

test('deploy without a site fails like a missing required argument unless a deploy token supplies it', async () => {
    const program = createProgram();
    const deploy = program.commands.find(command => command.name() === 'deploy')!;
    let message = '';
    deploy.exitOverride().configureOutput({ writeErr: text => (message += text), outputError: text => (message += text) });
    const saved = process.env.ZYNOHOSTING_API_KEY;
    process.env.ZYNOHOSTING_API_KEY = 'zak_x';
    try {
        await assert.rejects(program.parseAsync(['node', 'zynohosting', 'deploy', '--dry-run']), (error: unknown) => {
            const failure = error as { exitCode?: number };
            assert.equal(failure.exitCode, 1);
            return true;
        });
        assert.match(message, /missing required argument 'site'/);
    } finally {
        if (saved === undefined) delete process.env.ZYNOHOSTING_API_KEY;
        else process.env.ZYNOHOSTING_API_KEY = saved;
    }
});
