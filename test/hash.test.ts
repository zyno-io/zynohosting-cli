import { xxhash128 } from 'hash-wasm';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { hashInventoryFiles } from '../src/deploy/hash.js';

test('hashes only requested inventory indices with both protocol algorithms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-hash-'));
    await writeFile(join(root, 'a.txt'), 'alpha');
    await writeFile(join(root, 'b.txt'), 'bravo');
    const files = [
        { path: 'a.txt', size: 5 },
        { path: 'b.txt', size: 5 }
    ];

    const xxh = await hashInventoryFiles(root, files, [1], 'xxh3-128', 2);
    assert.deepEqual(xxh, [{ index: 1, digest: await xxhash128('bravo') }]);

    const sha = await hashInventoryFiles(root, files, [0], 'sha256', 2);
    assert.deepEqual(sha, [{ index: 0, digest: createHash('sha256').update('alpha').digest('hex') }]);
});

test('detects a size change after inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-hash-change-'));
    await writeFile(join(root, 'a.txt'), 'changed');
    await assert.rejects(hashInventoryFiles(root, [{ path: 'a.txt', size: 5 }], [0], 'sha256'), /changed while the deployment plan/);
});
