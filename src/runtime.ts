import { CliError } from './errors.js';

export const REQUIRED_NODE_MAJOR = 24;

/** Fails with a clear message when the CLI runs on a Node.js older than the one it needs. */
export function assertSupportedNode(version: string = process.versions.node): void {
    const major = Number(version.split('.')[0]);
    if (!Number.isFinite(major) || major < REQUIRED_NODE_MAJOR) {
        throw new CliError(
            `ZynoHosting needs Node.js ${REQUIRED_NODE_MAJOR} or newer, but this is Node.js ${version}. Install Node.js ${REQUIRED_NODE_MAJOR} from https://nodejs.org/ and try again.`,
            1,
            'unsupported_node'
        );
    }
}
