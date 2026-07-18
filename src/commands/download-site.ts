import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';

import { FileClient, responseHeader } from '../api/file-client.js';
import { StreamingResponse } from '../api/http.js';
import { ConfigOverrides } from '../config.js';
import { validateRelativePath } from '../deploy/inventory.js';
import { CliError } from '../errors.js';
import { Output } from '../output.js';
import { createFileClient } from './files.js';

export interface DownloadSiteOptions extends ConfigOverrides {
    sensitive?: boolean;
    yes?: boolean;
    json?: boolean;
    timeoutSeconds?: number;
}

export interface PreparedDownload {
    planId: string;
    siteRef: string;
    target: string;
    scope: 'deployable' | 'sensitive';
    expiresAt: string;
    client: FileClient;
}

export async function prepareDownload(siteRef: string, directory: string, options: DownloadSiteOptions): Promise<PreparedDownload> {
    const target = resolve(directory);
    await assertDownloadTarget(target);
    const scope = options.sensitive ? 'sensitive' : 'deployable';
    const session = await createFileClient(
        siteRef,
        [scope === 'sensitive' ? 'download:sensitive' : 'download:deployable'],
        options,
        Math.max(1, options.timeoutSeconds ?? 600) * 1000
    );
    return {
        planId: randomUUID(),
        siteRef,
        target,
        scope,
        expiresAt: session.expiresAt,
        client: session.client
    };
}

export async function applyDownload(plan: PreparedDownload): Promise<{ target: string; scope: string; entries?: number; skippedEntries?: number }> {
    if (Date.parse(plan.expiresAt) <= Date.now()) throw new CliError('The download authorization expired; create a new plan', 6, 'plan_expired');
    const response = await plan.client.archive(plan.scope);
    await extractArchiveResponse(response, plan.target);
    const entriesHeader = responseHeader(response, 'x-zh-archive-entries');
    const entries = entriesHeader === undefined ? undefined : Number(entriesHeader);
    const skippedHeader = responseHeader(response, 'x-zh-archive-skipped-entries');
    const skippedEntries = skippedHeader === undefined ? undefined : Number(skippedHeader);
    const result: { target: string; scope: string; entries?: number; skippedEntries?: number } = {
        target: plan.target,
        scope: plan.scope
    };
    if (entries !== undefined && Number.isSafeInteger(entries) && entries >= 0) result.entries = entries;
    if (skippedEntries !== undefined && Number.isSafeInteger(skippedEntries) && skippedEntries >= 0) result.skippedEntries = skippedEntries;
    return result;
}

export async function downloadSite(siteRef: string, directory: string, options: DownloadSiteOptions): Promise<void> {
    const plan = await prepareDownload(siteRef, directory, options);
    if (options.json && !options.yes) throw new CliError('--json requires --yes for a full download', 2, 'confirmation_required');
    if (!options.json) {
        process.stdout.write(`Download ${plan.scope === 'sensitive' ? 'all user content' : 'deployable files'} from ${siteRef} to ${plan.target}.\n`);
    }
    if (!options.yes && !(await new Output(false).confirm())) return;
    const result = await applyDownload(plan);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
        process.stdout.write(
            `Downloaded ${result.entries ?? 'all'} entries to ${result.target}` +
                `${result.skippedEntries ? `; skipped ${result.skippedEntries} link or special-file entries` : ''}.\n`
        );
    }
}

export async function extractArchiveResponse(response: StreamingResponse, target: string): Promise<void> {
    await assertDownloadTarget(target);
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(`${parent}${sep}.${basename(target)}.zyno-download-`);
    const extract = tar.extract();
    extract.on('entry', (header, stream, next) => {
        void (async () => {
            validateRelativePath(header.name.replace(/\/$/, ''), 1024);
            const destination = inside(staging, header.name);
            if (header.type === 'directory') {
                await mkdir(destination, { recursive: true, mode: 0o755 });
                stream.resume();
                next();
                return;
            }
            if (header.type !== 'file') throw new CliError(`Archive contains unsupported entry type ${header.type}`, 5, 'unsafe_archive');
            await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
            await pipeline(stream, createWriteStream(destination, { flags: 'wx', mode: 0o644 }));
            next();
        })().catch(error => extract.destroy(error instanceof Error ? error : new Error(String(error))));
    });
    try {
        let extractionError: unknown;
        try {
            await pipeline(Readable.from(response.body), createGunzip(), extract);
        } catch (error) {
            extractionError = error;
        }
        await assertArchiveCompletion(response, extractionError);
        await assertDownloadTarget(target);
        const existing = await lstat(target).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
        });
        if (existing) await rmdir(target);
        await rename(staging, target);
    } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

async function assertArchiveCompletion(response: StreamingResponse, extractionError: unknown): Promise<void> {
    let trailers: Awaited<StreamingResponse['trailers']> | undefined;
    let trailerError: unknown;
    try {
        trailers = await response.trailers;
    } catch (error) {
        trailerError = error;
    }
    const protocol = responseHeader(response, 'x-zh-archive-protocol');
    if (protocol === 'stream-v1' && trailers) {
        const status = responseHeader({ headers: trailers }, 'x-zh-archive-status');
        if (status === 'error') {
            const candidate = responseHeader({ headers: trailers }, 'x-zh-archive-error-code');
            const code = candidate && /^[a-z0-9_]{1,64}$/.test(candidate) ? candidate : 'archive_stream_error';
            throw new CliError(`Archive stream failed: ${code}`, 4, code);
        }
    }
    if (extractionError instanceof CliError) throw extractionError;
    if (trailerError) throw trailerError;
    if (extractionError) throw extractionError;
    if (protocol === 'stream-v1' && responseHeader({ headers: trailers ?? {} }, 'x-zh-archive-status') !== 'complete') {
        throw new CliError('Archive stream ended without a completion trailer', 4, 'incomplete_archive');
    }
}

async function assertDownloadTarget(target: string): Promise<void> {
    const info = await lstat(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new CliError(`Download target is not a directory: ${target}`, 2, 'invalid_target');
    if ((await readdir(target)).length) throw new CliError(`Download target is not empty: ${target}`, 2, 'destination_exists');
}

function inside(root: string, path: string): string {
    const destination = resolve(root, ...path.replace(/\/$/, '').split('/'));
    if (destination !== root && !destination.startsWith(`${root}${sep}`))
        throw new CliError('Archive path escapes the target directory', 5, 'unsafe_archive');
    return destination;
}
