#!/usr/bin/env node

import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';

import { HostingEnvironment } from './config.js';
import { CliError, errorMessage } from './errors.js';
import { startHostingMcp } from './mcp/start.js';

const version = readPackageVersion();
const program = new Command()
    .name('zynohosting-mcp')
    .description('Local stdio MCP server for ZynoHosting')
    .version(version)
    .option('--root <path>', 'allow agents to access this local root (repeatable)', collect, [])
    .option('--api-url <url>', 'Hosting Manager API URL')
    .addOption(new Option('--environment <name>', 'Hosting environment').choices(['production', 'alpha', 'dev']))
    .option('--api-key <key>', 'tenant API key (prefer ZYNO_HOSTING_API_KEY)');

try {
    program.parse(process.argv);
    const args = program.opts<{
        root: string[];
        apiUrl?: string;
        apiKey?: string;
        environment?: HostingEnvironment;
    }>();
    await startHostingMcp({
        roots: args.root,
        version,
        ...(args.apiUrl ? { apiUrl: args.apiUrl } : {}),
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
