import createIgnore from 'ignore';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { CliError } from '../errors.js';

export interface IgnoreConfiguration {
    matcher: PathIgnoreMatcher;
    customPatterns: string[];
    sources: string[];
}

export interface PathIgnoreMatcher {
    ignores(path: string): boolean;
}

export interface IgnoreOptions {
    root: string;
    mandatoryPatterns: readonly string[];
    ignoreFile?: string;
    additionalPatterns?: string[];
}

export async function buildIgnoreConfiguration(options: IgnoreOptions): Promise<IgnoreConfiguration> {
    const mandatoryMatcher = createIgnore().add(options.mandatoryPatterns);
    const customMatcher = createIgnore();
    const customPatterns: string[] = [];
    const sources = [`built-in rules (${options.mandatoryPatterns.length})`];

    const ignoreFile = options.ignoreFile ?? '.zynohostingignore';
    const ignorePath = isAbsolute(ignoreFile) ? ignoreFile : resolve(options.root, ignoreFile);
    try {
        const contents = await readFile(ignorePath, 'utf8');
        const filePatterns = parsePatterns(contents);
        addPatterns(customMatcher, filePatterns, ignorePath);
        customPatterns.push(...filePatterns);
        sources.push(ignoreFile);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.ignoreFile !== undefined) {
            throw new CliError(
                `Could not read ignore file ${ignorePath}: ${error instanceof Error ? error.message : String(error)}`,
                2,
                'invalid_ignore_file'
            );
        }
    }

    if (options.additionalPatterns?.length) {
        addPatterns(customMatcher, options.additionalPatterns, 'command line');
        customPatterns.push(...options.additionalPatterns);
        sources.push(`${options.additionalPatterns.length} command-line rule${options.additionalPatterns.length === 1 ? '' : 's'}`);
    }

    if (customPatterns.length > 10_000 || customPatterns.reduce((bytes, pattern) => bytes + Buffer.byteLength(pattern), 0) > 1024 * 1024) {
        throw new CliError('Custom ignore rules exceed the cluster protocol limit', 2, 'invalid_ignore_rules');
    }

    return {
        matcher: {
            ignores: path => mandatoryMatcher.ignores(path) || customMatcher.ignores(path)
        },
        customPatterns,
        sources
    };
}

export function isIgnored(matcher: PathIgnoreMatcher, relativePath: string, directory: boolean): boolean {
    const candidate = directory && !relativePath.endsWith('/') ? `${relativePath}/` : relativePath;
    return matcher.ignores(candidate);
}

function parsePatterns(contents: string): string[] {
    return contents.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#'));
}

function addPatterns(matcher: ReturnType<typeof createIgnore>, patterns: readonly string[], source: string): void {
    if (patterns.some(pattern => pattern.length > 1024 || pattern.includes('\0') || pattern.includes('\r') || pattern.includes('\n'))) {
        throw new CliError(`Invalid ignore rule in ${source}`, 2, 'invalid_ignore_rules');
    }
    try {
        matcher.add(patterns);
    } catch (error) {
        throw new CliError(`Invalid ignore rule in ${source}: ${error instanceof Error ? error.message : String(error)}`, 2, 'invalid_ignore_rules');
    }
}
