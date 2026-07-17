import { lstat, opendir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { CliError } from '../errors.js';
import { DeploymentLimits, InventoryFile } from '../protocol.js';
import { isIgnored, PathIgnoreMatcher } from './ignore.js';

export interface LocalInventory {
    root: string;
    files: InventoryFile[];
    snapshots: LocalFileSnapshot[];
    totalBytes: number;
}

export interface LocalFileSnapshot {
    path: string;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    ino: number;
    dev: number;
}

export async function scanLocalDirectory(rootInput: string, matcher: PathIgnoreMatcher, limits: DeploymentLimits): Promise<LocalInventory> {
    const root = resolve(rootInput);
    let rootStat;
    try {
        rootStat = await stat(root);
    } catch (error) {
        throw new CliError(
            `Could not access deployment directory ${root}: ${error instanceof Error ? error.message : String(error)}`,
            2,
            'invalid_source'
        );
    }
    if (!rootStat.isDirectory()) throw new CliError(`Deployment source is not a directory: ${root}`, 2, 'invalid_source');

    const discovered: Array<{ file: InventoryFile; snapshot: LocalFileSnapshot }> = [];
    let totalBytes = 0;
    await walk(root, '');
    discovered.sort((a, b) => Buffer.from(a.file.path).compare(Buffer.from(b.file.path)));
    return {
        root,
        files: discovered.map(entry => entry.file),
        snapshots: discovered.map(entry => entry.snapshot),
        totalBytes
    };

    async function walk(absoluteDirectory: string, relativeDirectory: string): Promise<void> {
        const directory = await opendir(absoluteDirectory);
        for await (const entry of directory) {
            const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
            validateRelativePath(relativePath, limits.maxPathBytes);

            if (entry.isDirectory()) {
                if (!isIgnored(matcher, relativePath, true)) await walk(resolve(absoluteDirectory, entry.name), relativePath);
                continue;
            }
            if (isIgnored(matcher, relativePath, false)) continue;
            if (entry.isSymbolicLink()) throw new CliError(`Symbolic links are not deployable: ${relativePath}`, 2, 'unsupported_file_type');
            if (!entry.isFile()) throw new CliError(`Unsupported file type: ${relativePath}`, 2, 'unsupported_file_type');

            const fileStat = await lstat(resolve(absoluteDirectory, entry.name));
            if (fileStat.isSymbolicLink()) throw new CliError(`Symbolic links are not deployable: ${relativePath}`, 2, 'unsupported_file_type');
            if (!fileStat.isFile()) throw new CliError(`Unsupported file type: ${relativePath}`, 2, 'unsupported_file_type');
            if (fileStat.size > limits.maxFileBytes) {
                throw new CliError(`${relativePath} is ${fileStat.size} bytes; the agent limit is ${limits.maxFileBytes}`, 2, 'file_too_large');
            }
            discovered.push({
                file: { path: relativePath, size: fileStat.size },
                snapshot: {
                    path: relativePath,
                    size: fileStat.size,
                    mtimeMs: fileStat.mtimeMs,
                    ctimeMs: fileStat.ctimeMs,
                    ino: fileStat.ino,
                    dev: fileStat.dev
                }
            });
            totalBytes += fileStat.size;
            if (discovered.length > limits.maxFiles) {
                throw new CliError(`Source contains more than the agent limit of ${limits.maxFiles} files`, 2, 'too_many_files');
            }
        }
    }
}

export function validateRelativePath(path: string, maxPathBytes: number): void {
    if (
        !path ||
        path.startsWith('/') ||
        path.includes('\\') ||
        [...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ) {
        throw new CliError(`Unsafe deployment path: ${JSON.stringify(path)}`, 2, 'unsafe_path');
    }
    const components = path.split('/');
    if (components.some(component => !component || component === '.' || component === '..')) {
        throw new CliError(`Unsafe deployment path: ${JSON.stringify(path)}`, 2, 'unsafe_path');
    }
    if (Buffer.byteLength(path, 'utf8') > maxPathBytes) {
        throw new CliError(`Deployment path exceeds ${maxPathBytes} bytes: ${path}`, 2, 'path_too_long');
    }
}
