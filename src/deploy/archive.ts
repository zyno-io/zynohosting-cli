import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';

import type { LocalFileSnapshot } from './inventory.js';

import { CliError } from '../errors.js';
import { InventoryFile } from '../protocol.js';

export interface DeploymentArchive {
    stream: Readable;
    uncompressedBytes: number;
    fileCount: number;
}

export function createDeploymentArchive(
    root: string,
    files: readonly InventoryFile[],
    uploadIndices: readonly number[],
    snapshots?: readonly LocalFileSnapshot[]
): DeploymentArchive {
    const selected = uploadIndices.map(index => {
        const file = files[index];
        if (!file) throw new CliError(`Agent requested unknown upload index ${index}`, 5, 'invalid_agent_response');
        return { file, snapshot: snapshots?.[index] };
    });
    const pack = tar.pack();
    const gzip = createGzip({ level: 6 });
    const output = pack.pipe(gzip);

    void fillArchive(pack, root, selected).catch(error => pack.destroy(error instanceof Error ? error : new Error(String(error))));
    return {
        stream: output,
        uncompressedBytes: selected.reduce((total, entry) => total + entry.file.size, 0),
        fileCount: selected.length
    };
}

async function fillArchive(
    pack: ReturnType<typeof tar.pack>,
    root: string,
    files: ReadonlyArray<{ file: InventoryFile; snapshot: LocalFileSnapshot | undefined }>
): Promise<void> {
    try {
        for (const { file, snapshot } of files) {
            const absolutePath = resolve(root, ...file.path.split('/'));
            const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
            const handle = await open(absolutePath, constants.O_RDONLY | noFollow);
            try {
                const current = await handle.stat();
                if (!matchesSnapshot(current, file, snapshot)) {
                    throw new CliError(`Local file changed after preview: ${file.path}`, 6, 'local_source_changed');
                }
                const entry = pack.entry({
                    name: file.path,
                    size: file.size,
                    mode: 0o644,
                    type: 'file',
                    mtime: new Date(0)
                });
                await pipeline(handle.createReadStream({ autoClose: false }), entry);
                if (!matchesSnapshot(await handle.stat(), file, snapshot)) {
                    throw new CliError(`Local file changed while it was being archived: ${file.path}`, 6, 'local_source_changed');
                }
            } finally {
                await handle.close();
            }
        }
        pack.finalize();
    } catch (error) {
        pack.destroy(error instanceof Error ? error : new Error(String(error)));
        throw error;
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
