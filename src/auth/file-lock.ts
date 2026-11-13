import { mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { CliError } from '../errors.js';

/**
 * Runs an operation while holding `<file>.renew.lock`. The lock must never be taken twice in one process.
 * Lock order across files is always legacy config, then profiles, then the token file.
 */
export async function withRefreshLock<T>(file: string, operation: () => Promise<T>, waitMs = 30_000): Promise<T> {
    const lockFile = `${file}.renew.lock`;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + waitMs;
    let handle: FileHandle | undefined;
    while (!handle) {
        try {
            handle = await open(lockFile, 'wx', 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const info = await stat(lockFile).catch(() => undefined);
            if (info && info.mtimeMs < Date.now() - 2 * 60 * 1000) {
                await rm(lockFile, { force: true });
                continue;
            }
            if (Date.now() >= deadline) {
                throw new CliError('Timed out waiting for another ZynoHosting CLI process that is updating saved logins.', 3, 'renewal_locked');
            }
            await delay(100);
        }
    }
    try {
        return await operation();
    } finally {
        try {
            await handle.close();
        } finally {
            await rm(lockFile, { force: true });
        }
    }
}
