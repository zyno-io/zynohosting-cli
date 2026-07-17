import { createXXHash128 } from 'hash-wasm';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { LocalFileSnapshot } from './inventory.js';

import { CliError } from '../errors.js';
import { HashAlgorithm, InventoryFile } from '../protocol.js';

export async function hashInventoryFiles(
    root: string,
    files: readonly InventoryFile[],
    indices: readonly number[],
    algorithm: HashAlgorithm,
    concurrency = 8,
    snapshots?: readonly LocalFileSnapshot[]
): Promise<Array<{ index: number; digest: string }>> {
    const results = new Map<number, string>();
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(concurrency, indices.length || 1));
    await Promise.all(
        Array.from({ length: workerCount }, async () => {
            const xxHasher = algorithm === 'xxh3-128' ? await createXXHash128(0, 0) : undefined;
            while (cursor < indices.length) {
                const position = cursor++;
                const index = indices[position];
                if (index === undefined) continue;
                const file = files[index];
                if (!file) throw new CliError(`Agent requested unknown inventory index ${index}`, 5, 'invalid_agent_response');
                results.set(index, await hashFile(root, file, algorithm, xxHasher, snapshots?.[index]));
            }
        })
    );
    return indices.map(index => ({ index, digest: results.get(index)! }));
}

async function hashFile(
    root: string,
    file: InventoryFile,
    algorithm: HashAlgorithm,
    xxHasher: Awaited<ReturnType<typeof createXXHash128>> | undefined,
    snapshot: LocalFileSnapshot | undefined
): Promise<string> {
    const absolutePath = resolve(root, ...file.path.split('/'));
    const before = await stat(absolutePath);
    if (!matchesSnapshot(before, file, snapshot)) throw sourceChanged(file.path);

    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const handle = await open(absolutePath, constants.O_RDONLY | noFollow);
    try {
        const opened = await handle.stat();
        if (!matchesSnapshot(opened, file, snapshot)) throw sourceChanged(file.path);
        let digest: string;
        if (algorithm === 'xxh3-128') {
            if (!xxHasher) throw new Error('XXH3 hasher is unavailable');
            xxHasher.init();
            for await (const chunk of handle.createReadStream({ autoClose: false })) xxHasher.update(chunk as Buffer);
            digest = xxHasher.digest('hex');
        } else {
            const hasher = createHash('sha256');
            for await (const chunk of handle.createReadStream({ autoClose: false })) hasher.update(chunk as Buffer);
            digest = hasher.digest('hex');
        }
        if (!matchesSnapshot(await handle.stat(), file, snapshot)) throw sourceChanged(file.path);
        return digest;
    } finally {
        await handle.close();
    }
}

function matchesSnapshot(
    stat: { isFile(): boolean; size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number },
    file: InventoryFile,
    snapshot: LocalFileSnapshot | undefined
): boolean {
    if (!stat.isFile() || stat.size !== file.size) return false;
    if (!snapshot) return true;
    return (
        snapshot.path === file.path &&
        stat.size === snapshot.size &&
        stat.mtimeMs === snapshot.mtimeMs &&
        stat.ctimeMs === snapshot.ctimeMs &&
        stat.ino === snapshot.ino &&
        stat.dev === snapshot.dev
    );
}

function sourceChanged(path: string): CliError {
    return new CliError(`Local file changed while the deployment plan was being built: ${path}`, 6, 'local_source_changed');
}
