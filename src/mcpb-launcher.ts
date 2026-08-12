#!/usr/bin/env node
/**
 * Entry point for the desktop bundle.
 *
 * Runs the newest verified runtime and then, in the background, stages any
 * newer signed release for the next launch. Nothing here blocks startup: the
 * runtime is chosen from what is already on disk, so a slow or unreachable
 * update host costs nothing.
 *
 * Kept separate from the server so the update path stays small enough to read
 * in one sitting. The server is bundled beside this file as embedded.js.
 */
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    defaultStagingDirectory,
    pruneStagedRuntimes,
    runtimeModuleUrl,
    selectRuntime,
    stageUpdate,
    type RuntimeSelection
} from './mcp/bundle-update.js';
import { UpdatePolicy } from './mcp/update-check.js';

// Injected at build time from the signing certificate, so it travels inside the
// bundle the certificate signs. A pinned key means a compromise of the download
// host alone is not enough to get code executed here.
declare const __ZYNO_UPDATE_PUBLIC_KEYS__: string;
declare const __ZYNO_UPDATE_DESCRIPTOR_URL__: string;

const here = dirname(fileURLToPath(import.meta.url));
const embeddedEntryPoint = join(here, 'embedded.js');

async function main(): Promise<void> {
    const packageJson = await readFile(join(here, '..', 'package.json'), 'utf8');
    const { version, name } = JSON.parse(packageJson) as {
        version: string;
        name: string;
    };

    const stagingDirectory = defaultStagingDirectory();
    // A JSON array so a release can carry more than one trusted key while a
    // signing key is being rotated. See verifyPayload for why that matters.
    const publicKeyPems: string[] = JSON.parse(__ZYNO_UPDATE_PUBLIC_KEYS__) as string[];

    const selection: RuntimeSelection = await selectRuntime({
        embeddedVersion: version,
        embeddedEntryPoint,
        stagingDirectory,
        publicKeyPems
    }).catch(() => ({ version, entryPoint: embeddedEntryPoint, embedded: true }));

    if (selection.rejected) {
        // stderr is safe: the MCP transport owns stdout, and the desktop app
        // captures stderr into its per-server log.
        process.stderr.write(`ZynoHosting: ignoring staged runtime ${selection.rejected}\n`);
    }

    let running = selection.version;
    try {
        // A staged path lives in user-writable storage. Import the exact bytes
        // that selectRuntime verified rather than opening that path a second
        // time and giving another process a chance to swap it in between.
        await import(runtimeModuleUrl(selection));
    } catch (error) {
        if (selection.embedded) throw error;
        // A staged runtime that will not load must never take the extension down.
        // Discard it and report the embedded version as the one running: saying
        // otherwise would tell the updater that this release is already in use,
        // so the broken directory would survive pruning and be retried forever.
        process.stderr.write(`ZynoHosting: staged runtime ${selection.version} failed to start, using ${version}\n`);
        await rm(dirname(dirname(selection.entryPoint)), { recursive: true, force: true }).catch(() => {});
        running = version;
        await import(pathToFileURL(embeddedEntryPoint).href);
    }

    // Set by verification runs and by anyone who wants a strictly offline install.
    if (process.env.ZYNOHOSTING_DISABLE_UPDATE === '1' || publicKeyPems.length === 0) return;
    scheduleUpdate({ running, embedded: version, stagingDirectory, publicKeyPems, packageName: name });
}

function scheduleUpdate(context: {
    running: string;
    embedded: string;
    stagingDirectory: string;
    publicKeyPems: readonly string[];
    packageName: string;
}): void {
    // Detached on purpose: the server is already serving, and an update is never
    // worth delaying or failing a session over.
    void (async () => {
        try {
            const policy = new UpdatePolicy({ version: context.running, descriptorUrl: __ZYNO_UPDATE_DESCRIPTOR_URL__ });
            policy.refresh();
            await policy.settled();
            const descriptor = policy.descriptorSnapshot();
            if (!descriptor) return;

            const outcome = await stageUpdate({
                descriptor,
                currentVersion: context.running,
                stagingDirectory: context.stagingDirectory,
                publicKeyPems: context.publicKeyPems,
                packageName: context.packageName
            });
            if (outcome.status === 'staged') {
                process.stderr.write(`ZynoHosting: staged ${outcome.version}; it will be used the next time Claude starts.\n`);
            } else if (outcome.status === 'failed') {
                process.stderr.write(`ZynoHosting: update check failed (${outcome.reason})\n`);
            }
            // Never prune below the embedded version; it is the fallback.
            await pruneStagedRuntimes(context.stagingDirectory, context.running);
        } catch {
            // An update is best effort by definition.
        }
    })();
}

await main();
