import { createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { FileClient } from '../api/file-client.js';
import { ManagerClient } from '../api/manager-client.js';
import { ConfigOverrides } from '../config.js';
import { validateRelativePath } from '../deploy/inventory.js';
import { CliError } from '../errors.js';
import { formatBytes, Output } from '../output.js';
import { FileDeleteResult, FileListResponse, FilePutResult } from '../protocol.js';
import { managerClient } from './context.js';

export interface FileCommandOptions extends ConfigOverrides {
    json?: boolean;
    recursive?: boolean;
    timeoutSeconds?: number;
}

export async function listFiles(siteRef: string, path: string, options: FileCommandOptions): Promise<FileListResponse> {
    if (path) validateRelativePath(path, 1024);
    const files = await fileClient(siteRef, ['files:list'], options);
    const result = await files.list(path, options.recursive ?? false);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else if (!result.entries.length) process.stdout.write('No files.\n');
    else {
        const width = Math.max(...result.entries.map(entry => entry.path.length));
        for (const entry of result.entries) {
            process.stdout.write(`${entry.type.padEnd(9)}  ${formatBytes(entry.size).padStart(10)}  ${entry.path.padEnd(width)}  ${entry.etag}\n`);
        }
    }
    return result;
}

export interface GetFileOptions extends FileCommandOptions {
    output?: string;
    force?: boolean;
}

export async function getFile(siteRef: string, remotePath: string, options: GetFileOptions): Promise<{ output: string; etag?: string }> {
    validateRelativePath(remotePath, 1024);
    const files = await fileClient(siteRef, ['files:read'], options);
    const response = await files.get(remotePath);
    const output = options.output ?? basename(remotePath);
    if (output === '-') {
        if (options.json) throw new CliError('--json cannot be used with --output -', 2, 'invalid_output');
        await writeResponseToStdout(response);
        return { output, ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}) };
    }
    const destination = resolve(output);
    await writeResponseAtomically(response, destination, options.force ?? false);
    if (!options.json) process.stdout.write(`Downloaded ${remotePath} to ${destination}.\n`);
    else process.stdout.write(`${JSON.stringify({ site: siteRef, path: remotePath, output: destination, etag: response.headers.get('etag') })}\n`);
    return { output: destination, ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}) };
}

export interface PutFileOptions extends FileCommandOptions {
    etag?: string;
    create?: boolean;
}

export async function putFile(siteRef: string, localPath: string, remotePath: string, options: PutFileOptions): Promise<FilePutResult> {
    validateRelativePath(remotePath, 1024);
    const source = resolve(localPath);
    const info = await lstat(source).catch(error => {
        throw new CliError(`Could not access ${source}: ${error instanceof Error ? error.message : String(error)}`, 2, 'invalid_source');
    });
    if (!info.isFile() || info.isSymbolicLink()) throw new CliError(`Source is not a regular file: ${source}`, 2, 'invalid_source');
    const files = await createFileClient(siteRef, ['files:write'], options, Math.max(1, options.timeoutSeconds ?? 600) * 1000);
    const result = await files.client.put(remotePath, createReadStream(source), {
        ...(options.etag ? { ifMatch: options.etag } : {}),
        ...(options.create ? { ifNoneMatch: '*' } : {})
    });
    await purgeSiteCacheAfterMutation(files.manager, files.siteId, result);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`${result.created ? 'Created' : 'Updated'} ${remotePath} (${formatBytes(result.entry.size)}).\n`);
    return result;
}

export interface DeleteFileOptions extends FileCommandOptions {
    etag?: string;
    yes?: boolean;
}

export async function deleteFile(siteRef: string, remotePath: string, options: DeleteFileOptions): Promise<FileDeleteResult | undefined> {
    validateRelativePath(remotePath, 1024);
    if (!options.yes) {
        if (options.json) throw new CliError('--json requires --yes for file deletion', 2, 'confirmation_required');
        process.stdout.write(`Delete ${remotePath} from ${siteRef}?\n`);
        if (!(await new Output(false).confirm())) return undefined;
    }
    const files = await createFileClient(siteRef, ['files:delete'], options, Math.max(1, options.timeoutSeconds ?? 600) * 1000);
    const result = await files.client.delete(remotePath, options.etag);
    await purgeSiteCacheAfterMutation(files.manager, files.siteId, result);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`Deleted ${remotePath}.\n`);
    return result;
}

export async function createFileClient(
    siteRef: string,
    scopes: Array<'files:list' | 'files:read' | 'files:write' | 'files:delete' | 'download:deployable' | 'download:sensitive'>,
    options: ConfigOverrides,
    timeoutMs = 600_000
): Promise<{ client: FileClient; expiresAt: string; siteId: string; manager: Awaited<ReturnType<typeof managerClient>> }> {
    const manager = await managerClient(options, Math.min(timeoutMs, 30_000));
    const session = await manager.createAccessSession(siteRef, scopes);
    return {
        client: new FileClient(session.endpoints.files, session.accessToken, timeoutMs),
        expiresAt: session.expiresAt,
        siteId: session.site.id,
        manager
    };
}

async function fileClient(
    siteRef: string,
    scopes: Array<'files:list' | 'files:read' | 'files:write' | 'files:delete'>,
    options: FileCommandOptions
): Promise<FileClient> {
    return (await createFileClient(siteRef, scopes, options, Math.max(1, options.timeoutSeconds ?? 600) * 1000)).client;
}

export async function writeResponseAtomically(response: Response, destination: string, overwrite: boolean): Promise<void> {
    if (!response.body) throw new CliError('Server returned an empty response stream', 5, 'invalid_agent_response');
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp.${process.pid}.${Date.now()}`;
    try {
        if (!overwrite) {
            const existing = await lstat(destination).catch(error => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
                throw error;
            });
            if (existing) throw new CliError(`Destination already exists: ${destination}`, 2, 'destination_exists');
        }
        await pipeline(
            Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
            createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
        );
        if (overwrite) {
            await rename(temporary, destination);
        } else {
            try {
                await link(temporary, destination);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                    throw new CliError(`Destination already exists: ${destination}`, 2, 'destination_exists');
                }
                throw error;
            }
            await unlink(temporary);
        }
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
}

export async function purgeSiteCacheAfterMutation(manager: ManagerClient, siteId: string, details: unknown): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await manager.purgeSiteCache(siteId);
            return;
        } catch (error) {
            lastError = error;
            if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 250));
        }
    }
    throw new CliError(
        `File mutation succeeded, but cache invalidation could not be queued: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        8,
        'cache_invalidation_failed',
        details
    );
}

async function writeResponseToStdout(response: Response): Promise<void> {
    if (!response.body) throw new CliError('Server returned an empty response stream', 5, 'invalid_agent_response');
    for await (const chunk of Readable.from(response.body as unknown as AsyncIterable<Uint8Array>)) {
        if (!process.stdout.write(chunk)) await new Promise<void>(resolveDrain => process.stdout.once('drain', resolveDrain));
    }
}
