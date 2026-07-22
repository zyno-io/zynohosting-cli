import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

import { createSystemRenewalTokenStore } from '../src/auth/renewal-token-store.js';

const KEY = '11111111-1111-4111-8111-111111111111';

test('Linux Secret Service adapter keeps renewal tokens out of process arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-secret-tool-'));
    const executable = join(root, 'secret-tool');
    const secretFile = join(root, 'secret');
    const argsFile = join(root, 'args');
    await writeFile(
        executable,
        `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_SECRET_TOOL_ARGS, JSON.stringify(process.argv.slice(2)) + '\\n');
const operation = process.argv[2];
if (operation === 'store') writeFileSync(process.env.FAKE_SECRET_TOOL_VALUE, readFileSync(0, 'utf8'));
else if (operation === 'lookup') {
    if (!existsSync(process.env.FAKE_SECRET_TOOL_VALUE)) process.exit(1);
    process.stdout.write(readFileSync(process.env.FAKE_SECRET_TOOL_VALUE));
} else if (operation === 'clear') rmSync(process.env.FAKE_SECRET_TOOL_VALUE, { force: true });
else process.exit(2);
`
    );
    await chmod(executable, 0o700);

    const previous = {
        path: process.env.PATH,
        args: process.env.FAKE_SECRET_TOOL_ARGS,
        value: process.env.FAKE_SECRET_TOOL_VALUE
    };
    process.env.PATH = `${root}${delimiter}${previous.path ?? ''}`;
    process.env.FAKE_SECRET_TOOL_ARGS = argsFile;
    process.env.FAKE_SECRET_TOOL_VALUE = secretFile;
    try {
        const store = createSystemRenewalTokenStore('linux');
        await store.set(KEY, 'zrt_private-value');
        assert.equal(await store.get(KEY), 'zrt_private-value');
        await store.delete(KEY);
        assert.equal(await store.get(KEY), undefined);

        const recordedArguments = await readFile(argsFile, 'utf8');
        assert.doesNotMatch(recordedArguments, /zrt_private-value/);
        assert.match(recordedArguments, /ZynoHosting CLI renewal token/);
    } finally {
        restoreEnvironment('PATH', previous.path);
        restoreEnvironment('FAKE_SECRET_TOOL_ARGS', previous.args);
        restoreEnvironment('FAKE_SECRET_TOOL_VALUE', previous.value);
    }
});

test('credential-store adapters reject malformed references and renewal tokens', async () => {
    const store = createSystemRenewalTokenStore('linux');
    await assert.rejects(store.set('not-a-uuid', 'zrt_valid'), /reference is invalid/);
    await assert.rejects(store.set(KEY, 'zrt_value with spaces'), /credential is invalid/);
    assert.throws(() => createSystemRenewalTokenStore('aix'), /not supported/);
});

function restoreEnvironment(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}
