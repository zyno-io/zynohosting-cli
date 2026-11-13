import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFileRenewalTokenStore, tokenFilePath } from '../src/auth/file-renewal-token-store.js';
import { CliError } from '../src/errors.js';

const KEY_A = '11111111-1111-4111-8111-111111111111';
const KEY_B = '22222222-2222-4222-8222-222222222222';

async function configPath(): Promise<string> {
    return join(await mkdtemp(join(tmpdir(), 'hosting-cli-token-file-')), 'hosting-cli-profiles.json');
}

test('the token file sits next to the profiles file', () => {
    assert.equal(tokenFilePath('/home/me/.config/zyno/hosting-cli-profiles.json'), '/home/me/.config/zyno/hosting-cli-profiles.renewal-tokens.json');
});

test('stores tokens as version 1 JSON with mode 0600 in a 0700 directory', async () => {
    const config = await configPath();
    const store = createFileRenewalTokenStore(config);
    await store.set(KEY_A, 'zrt_alpha');
    assert.equal(await store.get(KEY_A), 'zrt_alpha');
    assert.equal(await store.get(KEY_B), undefined);
    const parsed = JSON.parse(await readFile(store.path, 'utf8')) as {
        version: number;
        tokens: Record<string, { token: string; updatedAt: number }>;
    };
    assert.equal(parsed.version, 1);
    assert.equal(parsed.tokens[KEY_A]?.token, 'zrt_alpha');
    assert.equal(typeof parsed.tokens[KEY_A]?.updatedAt, 'number');
    if (process.platform !== 'win32') {
        assert.equal((await lstat(store.path)).mode & 0o777, 0o600);
        assert.equal((await lstat(join(store.path, '..'))).mode & 0o777, 0o700);
    }
});

test('refuses a token file that other users can read, or that is a symlink', { skip: process.platform === 'win32' }, async () => {
    const config = await configPath();
    const store = createFileRenewalTokenStore(config);
    await store.set(KEY_A, 'zrt_alpha');

    await chmod(store.path, 0o640);
    await assert.rejects(store.get(KEY_A), (error: unknown) => error instanceof CliError && error.code === 'credential_store_insecure');
    await assert.rejects(store.set(KEY_B, 'zrt_beta'), (error: unknown) => error instanceof CliError && error.code === 'credential_store_insecure');
    await chmod(store.path, 0o600);

    const real = `${store.path}.real`;
    await writeFile(real, await readFile(store.path), { mode: 0o600 });
    await rm(store.path);
    await symlink(real, store.path);
    await assert.rejects(store.get(KEY_A), (error: unknown) => error instanceof CliError && error.code === 'credential_store_insecure');
});

test('parallel writes from separate instances lose nothing', async () => {
    const config = await configPath();
    const keys = Array.from({ length: 12 }, (_, index) => `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`);
    await Promise.all(keys.map(key => createFileRenewalTokenStore(config).set(key, `zrt_${key.slice(0, 8)}`)));
    const store = createFileRenewalTokenStore(config);
    for (const key of keys) assert.equal(await store.get(key), `zrt_${key.slice(0, 8)}`);
});

test('the file is deleted when the last token is removed', async () => {
    const config = await configPath();
    const store = createFileRenewalTokenStore(config);
    await store.set(KEY_A, 'zrt_alpha');
    await store.set(KEY_B, 'zrt_beta');
    await store.delete(KEY_A);
    assert.equal(await store.get(KEY_B), 'zrt_beta');
    await store.delete(KEY_B);
    await assert.rejects(lstat(store.path));
    await store.delete(KEY_B);
});

test('prune removes only unreferenced entries that are old enough', async () => {
    const config = await configPath();
    const store = createFileRenewalTokenStore(config);
    await store.set(KEY_A, 'zrt_alpha');
    await store.set(KEY_B, 'zrt_beta');
    await store.prune(new Set([KEY_A]), 0);
    assert.equal(await store.get(KEY_A), 'zrt_alpha');
    assert.equal(await store.get(KEY_B), undefined);
    // Fresh entries survive even when nothing references them: a login may be about to write its profile.
    await store.set(KEY_B, 'zrt_beta');
    await store.prune(new Set(), 60 * 60 * 1000);
    assert.equal(await store.get(KEY_B), 'zrt_beta');
});

test('rejects keys and tokens that are not in the expected shape', async () => {
    const store = createFileRenewalTokenStore(await configPath());
    await assert.rejects(store.set('not-a-uuid', 'zrt_alpha'), (error: unknown) => error instanceof CliError);
    await assert.rejects(store.set(KEY_A, 'not-a-token'), (error: unknown) => error instanceof CliError);
});
