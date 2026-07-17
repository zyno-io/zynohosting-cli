import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { CliError } from '../errors.js';

export class AllowedLocalRoots {
    private constructor(private readonly roots: string[]) {}

    static async create(values: string[]): Promise<AllowedLocalRoots> {
        if (!values.length) {
            throw new CliError('At least one MCP local root is required. Pass --root or set ZYNO_HOSTING_MCP_ROOTS.', 2, 'missing_local_root');
        }
        const roots = await Promise.all(
            values.map(async value => {
                const absolute = resolve(value);
                const info = await lstat(absolute).catch(error => {
                    throw new CliError(
                        `Could not access MCP local root ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
                        2,
                        'invalid_local_root'
                    );
                });
                if (!info.isDirectory() || info.isSymbolicLink()) {
                    throw new CliError(`MCP local root is not a real directory: ${absolute}`, 2, 'invalid_local_root');
                }
                return realpath(absolute);
            })
        );
        return new AllowedLocalRoots([...new Set(roots)]);
    }

    async existing(path: string): Promise<string> {
        const absolute = this.absolute(path);
        const canonical = await realpath(absolute).catch(error => {
            throw new CliError(
                `Could not access local path ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
                2,
                'invalid_local_path'
            );
        });
        this.requireInside(canonical);
        return canonical;
    }

    async destination(path: string): Promise<string> {
        const absolute = this.absolute(path);
        const existing = await lstat(absolute).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
        });
        if (existing) {
            if (existing.isSymbolicLink()) throw new CliError(`Local destination cannot be a symbolic link: ${absolute}`, 2, 'unsafe_local_path');
            const canonical = await realpath(absolute);
            this.requireInside(canonical);
            return canonical;
        }

        let ancestor = dirname(absolute);
        while (true) {
            const info = await lstat(ancestor).catch(error => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
                throw error;
            });
            if (info) {
                if (!info.isDirectory() || info.isSymbolicLink()) {
                    throw new CliError(`Local destination parent is unsafe: ${ancestor}`, 2, 'unsafe_local_path');
                }
                const canonicalParent = await realpath(ancestor);
                this.requireInside(canonicalParent);
                const suffix = relative(ancestor, absolute);
                const canonical = resolve(canonicalParent, suffix);
                this.requireInside(canonical);
                return canonical;
            }
            const parent = dirname(ancestor);
            if (parent === ancestor) throw new CliError(`No existing parent for local path ${absolute}`, 2, 'unsafe_local_path');
            ancestor = parent;
        }
    }

    list(): string[] {
        return [...this.roots];
    }

    private absolute(path: string): string {
        if (!path || !isAbsolute(path)) throw new CliError('MCP local paths must be absolute', 2, 'unsafe_local_path');
        return resolve(path);
    }

    private requireInside(path: string): void {
        if (!this.roots.some(root => path === root || path.startsWith(`${root}${sep}`))) {
            throw new CliError(`Local path is outside the configured MCP roots: ${path}`, 2, 'unsafe_local_path');
        }
    }
}
