/**
 * Version policy for installed desktop bundles.
 *
 * A sideloaded .mcpb never updates itself, so a user can run an old build
 * indefinitely without knowing. This reads the descriptor published alongside
 * the newest release and lets the server refuse to operate when the running
 * build is older than the declared minimum.
 *
 * This is a user-experience mechanism, not enforcement: anyone can keep an old
 * bundle and block the descriptor host. Refusing an obsolete client for real
 * belongs in the API, which sees every authenticated operation.
 */
const DESCRIPTOR_URL = 'https://github.com/zyno-io/zynohosting-cli/releases/latest/download/update.json';
const BUNDLE_DOWNLOAD_URL = 'https://github.com/zyno-io/zynohosting-cli/releases/latest/download/zynohosting.mcpb';
const REQUEST_TIMEOUT_MS = 5_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_VERSION_LENGTH = 128;
const VERSION_PATTERN = /^[0-9]+(\.[0-9]+)*(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export interface UpdateDescriptor {
    latest?: string;
    minimum?: string;
    /** The runtime the launcher stages, and its detached signature. */
    payloadUrl?: string;
    signatureUrl?: string;
    payloadSha256?: string;
}

/**
 * One descriptor fetch per process, shared across module graphs.
 *
 * A desktop bundle runs the launcher and the server in the same process but as
 * two separate esbuild outputs, so they have no modules in common and each would
 * otherwise fetch the same document at startup. The global symbol registry is
 * the only surface they do share. Instances keep their own copy of the result;
 * only the network call is pooled, so the refresh semantics of each policy are
 * unchanged.
 *
 * Injected fetchers are never pooled, which keeps tests isolated from each other.
 */
const DESCRIPTOR_CACHE = Symbol.for('zynohosting.mcp.updateDescriptorCache');

interface CachedDescriptor {
    fetchedAt: number;
    descriptor: UpdateDescriptor | undefined;
    inFlight?: Promise<UpdateDescriptor | undefined>;
}

function descriptorCache(): Map<string, CachedDescriptor> {
    const host = globalThis as unknown as Record<symbol, Map<string, CachedDescriptor>>;
    return (host[DESCRIPTOR_CACHE] ??= new Map());
}

function sharedDescriptor(url: string, now: () => number, load: () => Promise<UpdateDescriptor | undefined>): Promise<UpdateDescriptor | undefined> {
    const cache = descriptorCache();
    const entry = cache.get(url);
    if (entry?.inFlight) return entry.inFlight;
    if (entry && now() - entry.fetchedAt < RECHECK_INTERVAL_MS) return Promise.resolve(entry.descriptor);

    const inFlight = load()
        .then(descriptor => {
            cache.set(url, { fetchedAt: now(), descriptor });
            return descriptor;
        })
        .catch(error => {
            // Record the attempt so a failing host is not retried on every call.
            cache.set(url, { fetchedAt: now(), descriptor: entry?.descriptor });
            throw error;
        });
    cache.set(url, { fetchedAt: entry?.fetchedAt ?? 0, descriptor: entry?.descriptor, inFlight });
    return inFlight;
}

export interface UpdateCheckOptions {
    version: string;
    descriptorUrl?: string;
    /** Injected in tests, and by callers that already know the policy. */
    fetchDescriptor?: () => Promise<UpdateDescriptor | undefined>;
    now?: () => number;
}

/**
 * A descriptor comes from an untrusted release asset. Keep only the fields
 * whose runtime types match the contract so a malformed value can never reach
 * version comparison or a user-facing policy message.
 */
function normalizeDescriptor(value: unknown): UpdateDescriptor | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

    const source = value as Record<string, unknown>;
    const descriptor: UpdateDescriptor = {};
    for (const field of ['latest', 'minimum'] as const) {
        const candidate = source[field];
        if (isDescriptorVersion(candidate)) descriptor[field] = candidate;
    }
    for (const field of ['payloadUrl', 'signatureUrl'] as const) {
        const candidate = source[field];
        if (typeof candidate === 'string') descriptor[field] = candidate;
    }
    const payloadSha256 = source.payloadSha256;
    if (typeof payloadSha256 === 'string' && /^[0-9a-f]{64}$/.test(payloadSha256)) descriptor.payloadSha256 = payloadSha256;
    return descriptor;
}

function isDescriptorVersion(value: unknown): value is string {
    return typeof value === 'string' && value.length <= MAX_VERSION_LENGTH && VERSION_PATTERN.test(value) && !value.includes('..');
}

/**
 * Compare dotted numeric versions. Any pre-release suffix on an otherwise equal
 * version sorts lower, so 1.2.0-canary.3 is older than 1.2.0.
 */
export function compareVersions(left: string, right: string): number {
    const parse = (value: string): { release: number[]; prerelease: string[] } => {
        const [core = ''] = value.split('+', 1);
        const separator = core.indexOf('-');
        const release = (separator === -1 ? core : core.slice(0, separator)).split('.').map(part => Number.parseInt(part, 10) || 0);
        return { release, prerelease: separator === -1 ? [] : core.slice(separator + 1).split('.') };
    };

    const a = parse(left);
    const b = parse(right);
    for (let index = 0; index < Math.max(a.release.length, b.release.length); index++) {
        const difference = (a.release[index] ?? 0) - (b.release[index] ?? 0);
        if (difference !== 0) return difference < 0 ? -1 : 1;
    }
    if (!a.prerelease.length || !b.prerelease.length) {
        if (a.prerelease.length === b.prerelease.length) return 0;
        return a.prerelease.length ? -1 : 1;
    }

    // Compare identifier by identifier, as semver does. The canary versions this
    // project publishes differ only here, so stopping at "both are pre-releases"
    // would make every canary look identical to every other.
    for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
        const left = a.prerelease[index];
        const right = b.prerelease[index];
        if (left === undefined) return -1;
        if (right === undefined) return 1;
        if (left === right) continue;
        const leftNumeric = /^[0-9]+$/.test(left);
        const rightNumeric = /^[0-9]+$/.test(right);
        if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1;
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return left < right ? -1 : 1;
    }
    return 0;
}

export class UpdatePolicy {
    private readonly version: string;
    private readonly descriptorUrl: string;
    private readonly fetchDescriptor: () => Promise<UpdateDescriptor | undefined>;
    private readonly now: () => number;
    private descriptor: UpdateDescriptor | undefined;
    private checkedAt = 0;
    private inFlight: Promise<void> | undefined;

    constructor(options: UpdateCheckOptions) {
        this.version = options.version;
        this.descriptorUrl = options.descriptorUrl ?? DESCRIPTOR_URL;
        this.now = options.now ?? Date.now;
        // Only the default network path is pooled; an injected fetcher is the
        // caller's own and must not be shared with anything else in the process.
        this.fetchDescriptor = options.fetchDescriptor ?? (() => sharedDescriptor(this.descriptorUrl, this.now, () => this.load()));
    }

    /**
     * The message every tool should return instead of running, or undefined
     * when the running build is permitted. Unknown policy always permits: a
     * blocked or unreachable descriptor must never take a working install down.
     */
    requiredUpdate(): string | undefined {
        const minimum = this.descriptor?.minimum;
        if (!minimum || compareVersions(this.version, minimum) >= 0) return undefined;

        // The descriptor is unsigned. It may decide whether the availability
        // gate is active, but none of its text or URLs may enter model-facing
        // instructions.
        return `This ZynoHosting extension must be updated before it can be used. Tell the user to download the current version from ${BUNDLE_DOWNLOAD_URL} and install it, then restart Claude. Do not attempt the requested operation, and do not offer a workaround.`;
    }

    /**
     * Refresh in the background. Never awaited by a tool call, so a slow or
     * hanging host cannot add latency to an operation.
     */
    refresh(): void {
        if (this.inFlight) return;
        if (this.checkedAt && this.now() - this.checkedAt < RECHECK_INTERVAL_MS) return;
        this.inFlight = this.fetchDescriptor()
            .then(descriptor => {
                const normalized = normalizeDescriptor(descriptor);
                if (normalized) this.descriptor = normalized;
                this.checkedAt = this.now();
            })
            .catch(() => {
                // An unreachable descriptor leaves the previous policy in place.
                this.checkedAt = this.now();
            })
            .finally(() => {
                this.inFlight = undefined;
            });
    }

    /** Wait for any refresh already running. Tests use this; tools do not. */
    async settled(): Promise<void> {
        await this.inFlight;
    }

    /** The last descriptor fetched, for callers that stage updates from it. */
    descriptorSnapshot(): UpdateDescriptor | undefined {
        return this.descriptor;
    }

    private async load(): Promise<UpdateDescriptor | undefined> {
        const response = await fetch(this.descriptorUrl, {
            redirect: 'follow',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!response.ok) return undefined;
        const bytes = await boundedResponseBody(response, this.descriptorUrl, MAX_DESCRIPTOR_BYTES);
        const text = bytes.toString('utf8');
        const value: unknown = JSON.parse(text);
        return normalizeDescriptor(value);
    }
}

/** Read a response while enforcing the limit as bytes arrive, before parsing. */
async function boundedResponseBody(response: Response, url: string, maximumBytes: number): Promise<Buffer> {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`${url} declared ${declared} bytes`);

    if (!response.body) {
        const arrayBuffer = await response.arrayBuffer();
        const bytes = Buffer.from(arrayBuffer);
        if (bytes.length > maximumBytes) throw new Error(`${url} returned ${bytes.length} bytes`);
        return bytes;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maximumBytes) throw new Error(`${url} exceeded ${maximumBytes} bytes`);
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}
