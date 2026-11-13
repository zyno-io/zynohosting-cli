import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { CliError } from '../errors.js';
import { withRefreshLock } from './file-lock.js';
import { validateRenewalKey, validateRenewalToken, type RenewalTokenStore } from './renewal-token-store.js';

interface TokenFile {
    version: 1;
    tokens: Record<string, { token: string; updatedAt: number }>;
}

export interface FileRenewalTokenStore extends RenewalTokenStore {
    readonly path: string;
    /** Removes entries that no profile references and that are older than `minAgeMs`. */
    prune(referencedKeys: ReadonlySet<string>, minAgeMs: number): Promise<void>;
}

/** The token file sits next to the profiles file: `<name>.renewal-tokens.json`. */
export function tokenFilePath(configPath: string): string {
    return join(dirname(configPath), `${basename(configPath, '.json')}.renewal-tokens.json`);
}

function insecure(path: string, reason: string): CliError {
    return new CliError(
        `The renewal token file ${path} ${reason}. Fix it or delete it, then run \`zynohosting login\` again.`,
        3,
        'credential_store_insecure'
    );
}

/**
 * An explicit opt-in store for machines with no system credential service. The file is written with mode 0600 in a 0700
 * directory, refuses to be a symbolic link or readable by others, and is replaced atomically under its own lock.
 */
export function createFileRenewalTokenStore(configPath: string): FileRenewalTokenStore {
    const path = tokenFilePath(configPath);

    const read = async (): Promise<TokenFile> => {
        let info;
        try {
            info = await lstat(path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, tokens: {} };
            throw error;
        }
        if (info.isSymbolicLink() || !info.isFile()) throw insecure(path, 'is not a regular file');
        if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw insecure(path, 'is readable by other users');
        try {
            const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
            if (!value || typeof value !== 'object' || (value as TokenFile).version !== 1) throw new Error('unsupported format');
            const tokens = (value as TokenFile).tokens;
            if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) throw new Error('invalid tokens');
            return { version: 1, tokens: Object.fromEntries(Object.entries(tokens).filter(([, entry]) => typeof entry?.token === 'string')) };
        } catch {
            throw new CliError(
                `The renewal token file ${path} could not be read. Delete it and run \`zynohosting login\` again.`,
                3,
                'credential_store_failed'
            );
        }
    };

    const write = async (file: TokenFile): Promise<void> => {
        if (Object.keys(file.tokens).length === 0) {
            await rm(path, { force: true });
            return;
        }
        const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') await chmod(dirname(path), 0o700);
        try {
            await writeFile(temporary, `${JSON.stringify(file)}\n`, { mode: 0o600 });
            await rename(temporary, path);
            if (process.platform !== 'win32') await chmod(path, 0o600);
        } catch (error) {
            await rm(temporary, { force: true }).catch(() => {});
            throw error;
        }
    };

    const update = (change: (file: TokenFile) => void): Promise<void> =>
        withRefreshLock(path, async () => {
            const file = await read();
            change(file);
            await write(file);
        });

    return {
        path,
        async get(key) {
            validateRenewalKey(key);
            const entry = (await read()).tokens[key];
            if (!entry) return undefined;
            validateRenewalToken(entry.token);
            return entry.token;
        },
        async set(key, token) {
            validateRenewalKey(key);
            validateRenewalToken(token);
            await update(file => {
                file.tokens[key] = { token, updatedAt: Date.now() };
            });
        },
        async delete(key) {
            validateRenewalKey(key);
            await update(file => {
                delete file.tokens[key];
            });
        },
        async prune(referencedKeys, minAgeMs) {
            const cutoff = Date.now() - minAgeMs;
            await update(file => {
                for (const [key, entry] of Object.entries(file.tokens)) {
                    if (!referencedKeys.has(key) && entry.updatedAt < cutoff) delete file.tokens[key];
                }
            });
        }
    };
}
