/**
 * Keep an installed desktop bundle current.
 *
 * A sideloaded .mcpb never updates itself: the user installed a version and
 * keeps it until they replace the file by hand. This stages newer, signed
 * runtimes beside the installed one so the next launch picks them up.
 *
 * Two rules shape everything here.
 *
 * The embedded runtime that shipped inside the bundle is the floor. It is
 * covered by the bundle's own signature and always present, so any failure in
 * this module — unreachable host, malformed descriptor, corrupt download, bad
 * signature, staged file that will not load — falls back to it rather than
 * leaving the user with a broken extension.
 *
 * Signatures are checked on every load, not just at download. The staging
 * directory is ordinary user-writable storage; anything else running as that
 * user can write to it. Verifying only at download would make it a persistence
 * foothold for code this process would then execute.
 */
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { compareVersions, UpdateDescriptor } from './update-check.js';

// Keep staged releases shaped like the bundle: metadata one level above the
// runtime. The generated server embeds its version for verified-byte imports,
// while this file remains useful for validation and inspection on disk.
export const RUNTIME_DIRECTORY = 'dist';
export const RUNTIME_FILE = 'server.js';
export const SIGNATURE_FILE = 'server.js.sig';
export const METADATA_FILE = 'package.json';

function runtimePaths(directory: string) {
    return {
        entryPoint: join(directory, RUNTIME_DIRECTORY, RUNTIME_FILE),
        signature: join(directory, RUNTIME_DIRECTORY, SIGNATURE_FILE),
        metadata: join(directory, METADATA_FILE)
    };
}

const DOWNLOAD_TIMEOUT_MS = 60_000;
/** A wildly oversized payload is a sign of trouble, not a large release. */
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_REDIRECTS = 5;
const RELEASE_ORIGIN = 'https://github.com';
const RELEASE_PATH_PREFIX = '/zyno-io/zynohosting-cli/releases/download/';
const RELEASE_ASSET_ORIGIN = 'https://release-assets.githubusercontent.com';
const RELEASE_ASSET_PATH_PREFIX = '/github-production-release-asset/';

export interface StagedRuntime {
    version: string;
    directory: string;
    entryPoint: string;
}

export interface RuntimeSelection {
    version: string;
    entryPoint: string;
    /** True when the embedded copy was chosen, including after a rejection. */
    embedded: boolean;
    /** Exact staged bytes whose signature was verified, retained for import. */
    verifiedSource?: Buffer;
    /** Why a staged runtime was passed over, for logging. */
    rejected?: string;
}

/** Import staged bytes directly so the path cannot be swapped after verification. */
export function runtimeModuleUrl(selection: RuntimeSelection): string {
    if (selection.verifiedSource) return `data:text/javascript;base64,${selection.verifiedSource.toString('base64')}`;
    return pathToFileURL(selection.entryPoint).href;
}

/** Per-user storage that survives reinstalling the extension. */
export function defaultStagingDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
    if (env.ZYNOHOSTING_MCPB_STAGING) return env.ZYNOHOSTING_MCPB_STAGING;
    if (platform() === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'ZynoHosting', 'mcpb');
    if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'ZynoHosting', 'mcpb');
    return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'ZynoHosting', 'mcpb');
}

/**
 * A version directory name must be a plain dotted version. Anything else could
 * escape the staging directory when joined, so it is not merely invalid — it is
 * refused before it reaches the filesystem.
 */
export function isSafeVersion(value: string): boolean {
    return /^[0-9]+(\.[0-9]+)*(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(value) && !value.includes('..');
}

/**
 * Accept a payload signed by any currently trusted key.
 *
 * A set rather than one key so a newly installed launcher can carry the outgoing
 * and incoming keys during a manual key-rotation migration. Trust cannot be
 * added to launchers already installed because updates replace only server.js;
 * those users must install a new .mcpb before they can accept the incoming key.
 *
 * Certificate expiry is deliberately not evaluated. What is pinned is the public
 * key, which has no validity window, and enforcing the certificate's would stop
 * every installed extension from updating on one date rather than at the moment
 * anything is actually wrong.
 */
/**
 * What the release signs: the version bound to the payload digest.
 *
 * Signing the payload alone would leave the version unauthenticated. The
 * descriptor that carries it is an ordinary release asset, so anyone able to
 * serve a forged one could pair a genuinely signed but older runtime with a
 * higher version, and the launcher would adopt known-vulnerable code believing
 * it to be the newest. Binding the two means such a pairing does not verify.
 */
export function signedStatement(version: string, payload: Buffer): Buffer {
    return Buffer.from(`zynohosting-mcpb/1\n${version}\n${sha256(payload)}\n`, 'utf8');
}

export function verifyPayload(payload: Buffer, signature: Buffer, publicKeyPems: readonly string[]): boolean {
    return publicKeyPems.some(pem => {
        try {
            return verifySignature('sha256', payload, createPublicKey(pem), signature);
        } catch {
            return false;
        }
    });
}

export function sha256(payload: Buffer): string {
    return createHash('sha256').update(payload).digest('hex');
}

/**
 * Choose what to run: the newest staged runtime whose signature still verifies,
 * otherwise the embedded copy.
 */
export async function selectRuntime(options: {
    embeddedVersion: string;
    embeddedEntryPoint: string;
    stagingDirectory: string;
    publicKeyPems: readonly string[];
}): Promise<RuntimeSelection> {
    const embedded: RuntimeSelection = { version: options.embeddedVersion, entryPoint: options.embeddedEntryPoint, embedded: true };

    const stagedRuntimes = await listStagedRuntimes(options.stagingDirectory);
    const newer = stagedRuntimes
        .filter(candidate => compareVersions(candidate.version, options.embeddedVersion) > 0)
        .sort((left, right) => compareVersions(right.version, left.version));

    let rejected: string | undefined;
    for (const candidate of newer) {
        const validation = await validateRuntime(candidate, options.publicKeyPems);
        if (validation.accepted) {
            return {
                version: candidate.version,
                entryPoint: candidate.entryPoint,
                embedded: false,
                verifiedSource: validation.payload
            };
        }
        rejected ??= `${candidate.version}: ${validation.reason}`;
    }

    return rejected ? { ...embedded, rejected } : embedded;
}

type RuntimeValidation = { accepted: true; payload: Buffer } | { accepted: false; reason: string };

async function validateRuntime(candidate: StagedRuntime, publicKeyPems: readonly string[]): Promise<RuntimeValidation> {
    try {
        const paths = runtimePaths(candidate.directory);
        const runtimeFiles = await Promise.all([
            readBoundedFile(paths.entryPoint, MAX_PAYLOAD_BYTES),
            readBoundedFile(paths.signature, MAX_SIGNATURE_BYTES)
        ]);
        const [payload, signature] = runtimeFiles;
        // Re-verified on every launch: the staging directory is user-writable,
        // so a signature checked only at download time proves nothing now. The
        // statement is rebuilt from the directory's own name, so a runtime moved
        // or renamed into a higher version no longer verifies.
        if (!verifyPayload(signedStatement(candidate.version, payload), signature, publicKeyPems)) {
            return { accepted: false, reason: 'signature does not verify' };
        }

        // Keep the on-disk metadata honest as well. Staged code is imported from
        // the verified bytes below rather than by this path, but a directory
        // claiming another version or module format is corrupt and must not be
        // treated as a reusable staged release.
        const metadataBytes = await readBoundedFile(paths.metadata, MAX_METADATA_BYTES);
        const metadata = JSON.parse(metadataBytes.toString('utf8')) as unknown;
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
            return { accepted: false, reason: 'metadata is not an object' };
        }
        const fields = metadata as Record<string, unknown>;
        if (fields.version !== candidate.version) {
            return { accepted: false, reason: 'metadata version does not match the signed runtime' };
        }
        if (fields.type !== 'module') return { accepted: false, reason: 'metadata does not declare an ES module' };
        return { accepted: true, payload };
    } catch (error) {
        return { accepted: false, reason: `unreadable (${error instanceof Error ? error.message : String(error)})` };
    }
}

/** Read a regular file without ever allocating beyond its type-specific cap. */
async function readBoundedFile(path: string, maximumBytes: number): Promise<Buffer> {
    // O_NONBLOCK keeps a malicious FIFO in the user-writable staging directory
    // from hanging startup before the file-type check can reject it.
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        const fileStats = await handle.stat();
        if (!fileStats.isFile()) throw new Error(`${path} is not a regular file`);
        if (fileStats.size > maximumBytes) throw new Error(`${path} exceeds ${maximumBytes} bytes`);

        const chunks: Buffer[] = [];
        let total = 0;
        while (total <= maximumBytes) {
            const remaining = maximumBytes + 1 - total;
            const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
            const readResult = await handle.read(chunk, 0, chunk.length, null);
            if (readResult.bytesRead === 0) break;
            total += readResult.bytesRead;
            if (total > maximumBytes) throw new Error(`${path} exceeds ${maximumBytes} bytes`);
            chunks.push(chunk.subarray(0, readResult.bytesRead));
        }
        return Buffer.concat(chunks, total);
    } finally {
        await handle.close();
    }
}

export async function listStagedRuntimes(stagingDirectory: string): Promise<StagedRuntime[]> {
    const entries = await readdir(join(stagingDirectory, 'versions'), { withFileTypes: true }).catch(() => []);
    return entries
        .filter(entry => entry.isDirectory() && isSafeVersion(entry.name))
        .map(entry => {
            const directory = join(stagingDirectory, 'versions', entry.name);
            return { version: entry.name, directory, entryPoint: runtimePaths(directory).entryPoint };
        });
}

export interface StageUpdateOptions {
    descriptor: UpdateDescriptor & { payloadUrl?: string; signatureUrl?: string; payloadSha256?: string };
    currentVersion: string;
    stagingDirectory: string;
    publicKeyPems: readonly string[];
    packageName: string;
    fetchImpl?: typeof fetch;
}

export type StageOutcome =
    | { status: 'staged'; version: string; directory: string }
    | { status: 'current' }
    | { status: 'skipped'; reason: string }
    | { status: 'failed'; reason: string };

/**
 * Download, verify, and stage a newer runtime. Never throws: a failed update
 * must be inert, because the caller is a running server that works already.
 */
export async function stageUpdate(options: StageUpdateOptions): Promise<StageOutcome> {
    const { descriptor, currentVersion, stagingDirectory, publicKeyPems, packageName } = options;
    const fetchImpl = options.fetchImpl ?? fetch;
    const target = descriptor.latest;

    if (!target || !isSafeVersion(target)) return { status: 'skipped', reason: 'descriptor has no usable version' };
    if (compareVersions(target, currentVersion) <= 0) return { status: 'current' };
    if (!descriptor.payloadUrl || !descriptor.signatureUrl) return { status: 'skipped', reason: 'descriptor has no payload' };

    const destination = join(stagingDirectory, 'versions', target);
    const stagedRuntimes = await listStagedRuntimes(stagingDirectory);
    const existing = stagedRuntimes.find(entry => entry.version === target);
    if (existing) {
        // Present is not the same as usable. selectRuntime re-verifies on every
        // launch and falls back when a staged runtime fails, so treating mere
        // presence as current would leave a corrupted directory in place for as
        // long as that release stayed newest, and it would never be repaired.
        const validation = await validateRuntime(existing, publicKeyPems);
        if (validation.accepted) return { status: 'current' };
        await rm(existing.directory, { recursive: true, force: true }).catch(() => {});
    }

    try {
        const payloadUrl = trustedReleaseUrl(descriptor.payloadUrl, target, RUNTIME_FILE);
        const signatureUrl = trustedReleaseUrl(descriptor.signatureUrl, target, SIGNATURE_FILE);
        if (!payloadUrl || !signatureUrl) return { status: 'skipped', reason: 'descriptor payload URLs are not trusted release assets' };

        const downloads = await Promise.all([
            download(fetchImpl, payloadUrl, MAX_PAYLOAD_BYTES),
            download(fetchImpl, signatureUrl, MAX_SIGNATURE_BYTES)
        ]);
        const [payload, signature] = downloads;

        if (descriptor.payloadSha256 && sha256(payload) !== descriptor.payloadSha256) {
            return { status: 'failed', reason: 'payload digest does not match the descriptor' };
        }
        if (!verifyPayload(signedStatement(target, payload), signature, publicKeyPems)) {
            return { status: 'failed', reason: 'payload signature does not verify for this version' };
        }

        // Assemble somewhere else and rename into place, so a crash or a second
        // process mid-download can never expose a half-written runtime.
        await mkdir(join(stagingDirectory, 'versions'), { recursive: true });
        // Assembled inside the staging directory, not the system temp dir: a
        // rename across filesystems fails EXDEV, which on Linux (tmpfs /tmp with
        // staging under ~/.local/share) would mean updates never land at all.
        const scratch = await mkdtemp(join(stagingDirectory, 'versions', '.staging-'));
        try {
            await mkdir(join(scratch, RUNTIME_DIRECTORY), { recursive: true });
            await writeFile(join(scratch, RUNTIME_DIRECTORY, RUNTIME_FILE), payload);
            await writeFile(join(scratch, RUNTIME_DIRECTORY, SIGNATURE_FILE), signature);
            // Mirror the bundle layout and record the version beside the staged
            // payload, even though the generated server also embeds that value
            // so it can be imported safely from its verified bytes.
            await writeFile(
                join(scratch, METADATA_FILE),
                `${JSON.stringify({ name: packageName, version: target, private: true, type: 'module' }, null, 2)}\n`
            );
            try {
                await rename(scratch, destination);
            } catch (error) {
                // A concurrent staging of the same version already won the race.
                // The code differs by platform and filesystem, but permission
                // errors can also use EPERM/EACCES. Treat the failure as a win
                // only after proving the destination really contains the same
                // valid, signed runtime.
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error;
                const competing: StagedRuntime = {
                    version: target,
                    directory: destination,
                    entryPoint: runtimePaths(destination).entryPoint
                };
                const validation = await validateRuntime(competing, publicKeyPems);
                if (!validation.accepted) throw error;
            }
        } finally {
            await rm(scratch, { recursive: true, force: true }).catch(() => {});
        }

        return { status: 'staged', version: target, directory: destination };
    } catch (error) {
        return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
}

/** Remove staged runtimes older than what is running, keeping storage bounded. */
export async function pruneStagedRuntimes(stagingDirectory: string, keepAtOrAbove: string): Promise<string[]> {
    const removed: string[] = [];
    const stagedRuntimes = await listStagedRuntimes(stagingDirectory);
    for (const candidate of stagedRuntimes) {
        if (compareVersions(candidate.version, keepAtOrAbove) >= 0) continue;
        await rm(candidate.directory, { recursive: true, force: true }).catch(() => {});
        removed.push(candidate.version);
    }
    return removed;
}

/**
 * Read at most maximumBytes, checking as the body arrives.
 *
 * Buffering first and measuring afterwards would bound nothing: a compromised
 * or misbehaving host could make this process allocate the whole response
 * before the limit was ever consulted. The declared length cannot be trusted
 * either, so the running total is what stops it.
 */
async function download(fetchImpl: typeof fetch, initialUrl: URL, maximumBytes: number): Promise<Buffer> {
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    let current = initialUrl;
    let response: Response | undefined;

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        assertTrustedDownloadUrl(current, initialUrl);
        response = await fetchImpl(current, { redirect: 'manual', signal });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        if (redirects === MAX_REDIRECTS) throw new Error(`${initialUrl.href} exceeded ${MAX_REDIRECTS} redirects`);

        const location = response.headers?.get?.('location');
        if (!location) throw new Error(`${current.href} redirected without a location`);
        current = new URL(location, current);
        assertTrustedDownloadUrl(current, initialUrl);
    }

    if (!response || !response.ok) throw new Error(`${current.href} responded ${response?.status ?? 'without a response'}`);

    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`${current.href} declared ${declared} bytes`);

    if (!response.body) {
        const arrayBuffer = await response.arrayBuffer();
        const bytes = Buffer.from(arrayBuffer);
        if (bytes.length > maximumBytes) throw new Error(`${current.href} returned ${bytes.length} bytes`);
        return bytes;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maximumBytes) throw new Error(`${current.href} exceeded ${maximumBytes} bytes`);
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

/** Accept only the two assets published for this exact repository and version. */
function trustedReleaseUrl(value: string, version: string, filename: string): URL | undefined {
    const expected = new URL(`${RELEASE_PATH_PREFIX}v${version}/${filename}`, RELEASE_ORIGIN);
    try {
        const candidate = new URL(value);
        return candidate.href === expected.href ? candidate : undefined;
    } catch {
        return undefined;
    }
}

/** Validate a URL immediately before each request, including after redirects. */
function assertTrustedDownloadUrl(candidate: URL, initial: URL): void {
    if (candidate.protocol !== 'https:' || candidate.username || candidate.password || candidate.hash) {
        throw new Error(`refusing untrusted update URL ${candidate.href}`);
    }
    if (candidate.origin === RELEASE_ORIGIN && candidate.href === initial.href) return;
    if (candidate.origin === RELEASE_ASSET_ORIGIN && candidate.pathname.startsWith(RELEASE_ASSET_PATH_PREFIX)) return;
    throw new Error(`refusing untrusted update URL ${candidate.href}`);
}
