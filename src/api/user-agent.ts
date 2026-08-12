/**
 * Identify this client to the ZynoHosting API.
 *
 * Without this, requests arrive as bare `node` from fetch and with no
 * User-Agent at all from the streaming transport, so the server cannot tell
 * which client, which version, or which install channel it is talking to.
 *
 * The install channel matters more than usual here: an npx invocation resolves
 * the newest published version on every launch, while a desktop bundle stays on
 * whatever version was installed until someone replaces it. A server that wants
 * to refuse obsolete clients has to be able to tell those apart.
 */
export type ClientSurface = 'cli' | 'mcp';
export type ClientDistribution = 'npm' | 'mcpb';

export interface UserAgentIdentity {
    surface: ClientSurface;
    version: string;
    distribution?: ClientDistribution;
}

const PRODUCT = '@zyno-io/zynohosting';

let identity: UserAgentIdentity = { surface: 'cli', version: '0.0.0' };
let cached: string | undefined;

/** Called once by each entry point, before any request is made. */
export function configureUserAgent(next: UserAgentIdentity, env: NodeJS.ProcessEnv = process.env): void {
    identity = {
        ...next,
        // The bundle manifest sets this in the server's environment, which is the
        // only way the process can know it was installed as a desktop extension.
        distribution: next.distribution ?? resolveDistribution(env)
    };
    cached = undefined;
}

export function resolveDistribution(env: NodeJS.ProcessEnv = process.env): ClientDistribution {
    return env.ZYNOHOSTING_DISTRIBUTION === 'mcpb' ? 'mcpb' : 'npm';
}

export function userAgent(): string {
    if (cached) return cached;
    const details = [identity.surface, identity.distribution ?? 'npm'].join('; ');
    // Keep every field token-safe: a stray newline or control character here
    // would be a header injection, and versions come from package metadata.
    cached = sanitize(`${PRODUCT}/${identity.version} (${details}) node/${process.versions.node} ${process.platform}-${process.arch}`);
    return cached;
}

function sanitize(value: string): string {
    return value.replace(/[^\t -~]/g, '');
}
