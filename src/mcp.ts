#!/usr/bin/env node

import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';

import type { HostingEnvironment } from './config.js';

import { configureUserAgent } from './api/user-agent.js';
import { CliError, errorMessage } from './errors.js';
import { startHostingMcp } from './mcp/start.js';

// The desktop update payload is imported from its verified bytes through a data
// URL, which deliberately has no package.json beside it. Its build replaces
// this constant; npm/CLI builds fall back to their installed package metadata.
declare const __ZYNO_MCPB_VERSION__: string;
const version = typeof __ZYNO_MCPB_VERSION__ === 'string' ? __ZYNO_MCPB_VERSION__ : readPackageVersion();
configureUserAgent({ surface: 'mcp', version });
const program = new Command()
    .name('zynohosting-mcp')
    .description('Local stdio MCP server for ZynoHosting and ZynoForms')
    .version(version)
    .option('--root <path>', 'restrict local-file MCP tools to this root (repeatable)', collect, [])
    // Bare positional roots exist for hosts that expand a list into argv. The
    // desktop bundle's directory picker produces one argument per folder with no
    // flag between them, so a flag-only form would silently keep just the first.
    .argument('[roots...]', 'additional local roots, equivalent to repeating --root')
    .option('--api-url <url>', 'Hosting Manager API URL')
    .option('--suite-api-url <url>', 'ZynoSuite API URL')
    .option('--auth-api-url <url>', 'ZynoAuth API URL')
    .addOption(new Option('--environment <name>', 'Hosting environment').choices(['production', 'alpha', 'dev']))
    .option('--api-key <key>', 'tenant API key (prefer ZYNOHOSTING_API_KEY)');

try {
    program.parse(process.argv);
    const args = program.opts<{
        root: string[];
        apiUrl?: string;
        suiteApiUrl?: string;
        authApiUrl?: string;
        apiKey?: string;
        environment?: HostingEnvironment;
    }>();
    await startHostingMcp({
        // Duplicates collapse during canonical resolution, so the two forms can
        // be combined without the caller having to keep them distinct.
        roots: [...args.root, ...program.args],
        version,
        ...(args.apiUrl ? { apiUrl: args.apiUrl } : {}),
        ...(args.suiteApiUrl ? { suiteApiUrl: args.suiteApiUrl } : {}),
        ...(args.authApiUrl ? { authApiUrl: args.authApiUrl } : {}),
        ...(args.apiKey ? { apiKey: args.apiKey } : {}),
        ...(args.environment ? { environment: args.environment } : {})
    });
} catch (error) {
    const cliError = error instanceof CliError ? error : new CliError(errorMessage(error));
    process.stderr.write(`ZynoHosting MCP error: ${cliError.message}\n`);
    process.exitCode = cliError.exitCode;
}

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

function readPackageVersion(): string {
    const value = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>).version !== 'string') {
        throw new Error('Package version is missing from package.json');
    }
    return (value as Record<string, string>).version!;
}
