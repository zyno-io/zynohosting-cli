import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';

import type { HostingEnvironment } from './config.js';

import { deploySite, DeploySiteOptions } from './commands/deploy-site.js';
import { downloadSite, DownloadSiteOptions } from './commands/download-site.js';
import { deleteFile, getFile, listFiles, putFile } from './commands/files.js';
import { login, LoginOptions } from './commands/login.js';
import { logout, LogoutOptions } from './commands/logout.js';
import { getSite, listSites } from './commands/sites.js';
import { installHostingMcp } from './mcp/install.js';
import { startHostingMcp } from './mcp/start.js';

const PACKAGE_VERSION = readPackageVersion();

export function createProgram(): Command {
    const program = new Command();
    program
        .name('zynohosting')
        .description('Manage and deploy ZynoHosting sites')
        .version(PACKAGE_VERSION)
        .option('--api-url <url>', 'Hosting Manager API URL')
        .option('--suite-api-url <url>', 'ZynoSuite API URL')
        .option('--auth-api-url <url>', 'Zyno Auth API URL')
        .addOption(environmentOption())
        .option('--api-key <key>', 'tenant API key (prefer ZYNO_HOSTING_API_KEY)')
        .option('--json', 'emit machine-readable JSON');

    program
        .command('login')
        .description('sign in through Zyno or save a CI API key')
        .option('--api-url <url>', 'Hosting Manager API URL')
        .option('--suite-api-url <url>', 'ZynoSuite API URL')
        .option('--auth-api-url <url>', 'Zyno Auth API URL')
        .addOption(environmentOption())
        .option('--api-key <key>', 'tenant API key instead of browser login')
        .option('--login-url <url>', 'Zyno SPA login page URL')
        .option('--name <description>', 'name shown on the authorization screen')
        .option('--permission <key>', 'permission to request (repeatable)', collect, [])
        .option('--renewable', 'securely store a renewable credential in the system credential store')
        .option('--no-open', 'print the login URL instead of opening a browser')
        .addOption(new Option('--timeout <seconds>', 'browser login timeout').argParser(positiveInteger).default(300))
        .action(async (commandOptions: LoginOptions & { timeout: number; permission: string[] }) => {
            const global = program.opts<{
                apiUrl?: string;
                suiteApiUrl?: string;
                authApiUrl?: string;
                apiKey?: string;
                environment?: HostingEnvironment;
            }>();
            await login({
                ...((commandOptions.apiUrl ?? global.apiUrl) ? { apiUrl: commandOptions.apiUrl ?? global.apiUrl } : {}),
                ...((commandOptions.suiteApiUrl ?? global.suiteApiUrl) ? { suiteApiUrl: commandOptions.suiteApiUrl ?? global.suiteApiUrl } : {}),
                ...((commandOptions.authApiUrl ?? global.authApiUrl) ? { authApiUrl: commandOptions.authApiUrl ?? global.authApiUrl } : {}),
                ...((commandOptions.environment ?? global.environment) ? { environment: commandOptions.environment ?? global.environment } : {}),
                ...((commandOptions.apiKey ?? global.apiKey) ? { apiKey: commandOptions.apiKey ?? global.apiKey } : {}),
                ...(commandOptions.loginUrl ? { loginUrl: commandOptions.loginUrl } : {}),
                ...(commandOptions.name ? { name: commandOptions.name } : {}),
                ...(commandOptions.permission.length ? { permissionKeys: commandOptions.permission } : {}),
                ...(commandOptions.renewable ? { renewable: true } : {}),
                timeoutSeconds: commandOptions.timeout,
                ...(commandOptions.open === undefined ? {} : { open: commandOptions.open })
            });
        });

    program
        .command('logout')
        .description('revoke the saved scoped token and remove local credentials')
        .option('--api-url <url>', 'Hosting Manager API URL')
        .option('--suite-api-url <url>', 'ZynoSuite API URL')
        .option('--auth-api-url <url>', 'Zyno Auth API URL')
        .addOption(environmentOption())
        .action(async (commandOptions: LogoutOptions) => {
            const context = commandContext(program, commandOptions);
            await logout({
                ...(context.apiUrl ? { apiUrl: context.apiUrl } : {}),
                ...(context.suiteApiUrl ? { suiteApiUrl: context.suiteApiUrl } : {}),
                ...(context.authApiUrl ? { authApiUrl: context.authApiUrl } : {}),
                ...(context.environment ? { environment: context.environment } : {})
            });
        });

    const sites = program.command('sites').description('list and inspect authorized sites');
    sites
        .command('list')
        .description('list authorized hosting sites')
        .option('--json', 'emit JSON')
        .action(async (commandOptions: { json?: boolean }) => {
            await listSites(commandContext(program, commandOptions));
        });
    sites
        .command('get')
        .description('show one authorized hosting site')
        .argument('<site>', 'site ID or hostname')
        .option('--json', 'emit JSON')
        .action(async (siteRef: string, commandOptions: { json?: boolean }) => {
            await getSite(siteRef, commandContext(program, commandOptions));
        });

    const files = program.command('files').description('list, download, upload, and delete individual files');
    files
        .command('list')
        .description('list files in a hosted site directory')
        .argument('<site>', 'site ID or hostname')
        .argument('[path]', 'remote directory path', '')
        .option('-r, --recursive', 'list the complete subtree')
        .option('--json', 'emit JSON')
        .addOption(new Option('--timeout <seconds>', 'request timeout').argParser(positiveInteger).default(600))
        .action(async (siteRef: string, path: string, commandOptions: { recursive?: boolean; json?: boolean; timeout: number }) => {
            await listFiles(siteRef, path, {
                ...commandContext(program, commandOptions),
                recursive: commandOptions.recursive ?? false,
                timeoutSeconds: commandOptions.timeout
            });
        });
    files
        .command('get')
        .description('download one hosted file')
        .argument('<site>', 'site ID or hostname')
        .argument('<remote-path>', 'remote file path')
        .option('-o, --output <path>', 'local destination, or - for stdout')
        .option('-f, --force', 'replace an existing local destination')
        .option('--json', 'emit JSON')
        .addOption(new Option('--timeout <seconds>', 'request timeout').argParser(positiveInteger).default(600))
        .action(
            async (siteRef: string, remotePath: string, commandOptions: { output?: string; force?: boolean; json?: boolean; timeout: number }) => {
                await getFile(siteRef, remotePath, {
                    ...commandContext(program, commandOptions),
                    ...(commandOptions.output ? { output: commandOptions.output } : {}),
                    force: commandOptions.force ?? false,
                    timeoutSeconds: commandOptions.timeout
                });
            }
        );
    files
        .command('put')
        .description('create or replace one hosted file')
        .argument('<site>', 'site ID or hostname')
        .argument('<local-path>', 'local source file')
        .argument('<remote-path>', 'remote destination path')
        .option('--etag <etag>', 'replace only if the current ETag matches')
        .option('--create', 'fail if the remote path already exists')
        .option('--json', 'emit JSON')
        .addOption(new Option('--timeout <seconds>', 'request timeout').argParser(positiveInteger).default(600))
        .action(
            async (
                siteRef: string,
                localPath: string,
                remotePath: string,
                commandOptions: { etag?: string; create?: boolean; json?: boolean; timeout: number }
            ) => {
                await putFile(siteRef, localPath, remotePath, {
                    ...commandContext(program, commandOptions),
                    ...(commandOptions.etag ? { etag: commandOptions.etag } : {}),
                    create: commandOptions.create ?? false,
                    timeoutSeconds: commandOptions.timeout
                });
            }
        );
    files
        .command('rm')
        .alias('delete')
        .description('delete one hosted file')
        .argument('<site>', 'site ID or hostname')
        .argument('<remote-path>', 'remote file path')
        .option('--etag <etag>', 'delete only if the current ETag matches')
        .option('-y, --yes', 'delete without prompting')
        .option('--json', 'emit JSON')
        .addOption(new Option('--timeout <seconds>', 'request timeout').argParser(positiveInteger).default(600))
        .action(async (siteRef: string, remotePath: string, commandOptions: { etag?: string; yes?: boolean; json?: boolean; timeout: number }) => {
            await deleteFile(siteRef, remotePath, {
                ...commandContext(program, commandOptions),
                ...(commandOptions.etag ? { etag: commandOptions.etag } : {}),
                yes: commandOptions.yes ?? false,
                timeoutSeconds: commandOptions.timeout
            });
        });

    program
        .command('deploy')
        .alias('deploy-site')
        .description('preview and synchronize a local directory to a hosted site')
        .argument('<site>', 'site ID or hostname')
        .argument('[directory]', 'local directory', '.')
        .addOption(environmentOption())
        .option('-y, --yes', 'apply without prompting after displaying the plan')
        .option('--dry-run', 'display the exact plan without applying it')
        .option('--json', 'emit newline-delimited JSON output')
        .option('--allow-empty', 'allow an empty local sync scope to delete remote content')
        .option('--ignore <pattern>', 'add a gitignore-style exclusion', collect, [])
        .option('--ignore-file <path>', 'use an alternate ignore file instead of .zynohostingignore')
        .addOption(new Option('--timeout <seconds>', 'inventory/hash request timeout').argParser(positiveInteger).default(600))
        .addOption(new Option('--hash-concurrency <count>', 'number of local files hashed concurrently').argParser(positiveInteger).default(8))
        .action(async (siteRef: string, directory: string, commandOptions: DeploySiteOptions & { timeout: number }) => {
            await deploySite(siteRef, directory, {
                ...commandOptions,
                ...commandContext(program, commandOptions),
                timeoutSeconds: commandOptions.timeout
            });
        });

    program
        .command('download')
        .description('download a complete hosted-site snapshot')
        .argument('<site>', 'site ID or hostname')
        .argument('[directory]', 'new or empty local destination', '.')
        .option('--sensitive', 'include protected configuration and user-generated content')
        .option('-y, --yes', 'download without prompting')
        .option('--json', 'emit JSON')
        .addOption(new Option('--timeout <seconds>', 'request timeout').argParser(positiveInteger).default(600))
        .action(async (siteRef: string, directory: string, commandOptions: DownloadSiteOptions & { timeout: number }) => {
            await downloadSite(siteRef, directory, {
                ...commandContext(program, commandOptions),
                sensitive: commandOptions.sensitive ?? false,
                yes: commandOptions.yes ?? false,
                timeoutSeconds: commandOptions.timeout
            });
        });

    const mcp = program
        .command('mcp')
        .description('run the local ZynoHosting and ZynoForms MCP server')
        .option('--root <path>', 'restrict local-file MCP tools to this root (repeatable)', collect, [])
        .action(async (commandOptions: { root: string[] }) => {
            const context = commandContext(program, {});
            await startHostingMcp({
                roots: commandOptions.root,
                version: PACKAGE_VERSION,
                ...(context.apiUrl ? { apiUrl: context.apiUrl } : {}),
                ...(context.suiteApiUrl ? { suiteApiUrl: context.suiteApiUrl } : {}),
                ...(context.authApiUrl ? { authApiUrl: context.authApiUrl } : {}),
                ...(context.apiKey ? { apiKey: context.apiKey } : {}),
                ...(context.environment ? { environment: context.environment } : {})
            });
        });

    mcp.command('install')
        .description('configure the local ZynoHosting MCP for Claude Code and Codex in this project')
        .option('--project <path>', 'project root to configure', '.')
        .action(async (commandOptions: { project: string }) => {
            const installed = await installHostingMcp({ project: commandOptions.project });
            for (const path of installed.configured) process.stdout.write(`Configured ${path}\n`);
            for (const path of installed.alreadyConfigured) process.stdout.write(`Already configured ${path}\n`);
            process.stdout.write('Restart Codex or Claude Code before using the ZynoHosting MCP tools.\n');
        });

    return program;
}

function commandContext(
    program: Command,
    commandOptions: {
        apiUrl?: string;
        suiteApiUrl?: string;
        authApiUrl?: string;
        apiKey?: string;
        environment?: HostingEnvironment;
        json?: boolean;
    }
): {
    apiUrl?: string;
    suiteApiUrl?: string;
    authApiUrl?: string;
    apiKey?: string;
    environment?: HostingEnvironment;
    json: boolean;
} {
    const global = program.opts<{
        apiUrl?: string;
        suiteApiUrl?: string;
        authApiUrl?: string;
        apiKey?: string;
        environment?: HostingEnvironment;
        json?: boolean;
    }>();
    return {
        ...((commandOptions.apiUrl ?? global.apiUrl) ? { apiUrl: commandOptions.apiUrl ?? global.apiUrl } : {}),
        ...((commandOptions.suiteApiUrl ?? global.suiteApiUrl) ? { suiteApiUrl: commandOptions.suiteApiUrl ?? global.suiteApiUrl } : {}),
        ...((commandOptions.authApiUrl ?? global.authApiUrl) ? { authApiUrl: commandOptions.authApiUrl ?? global.authApiUrl } : {}),
        ...((commandOptions.apiKey ?? global.apiKey) ? { apiKey: commandOptions.apiKey ?? global.apiKey } : {}),
        ...((commandOptions.environment ?? global.environment) ? { environment: commandOptions.environment ?? global.environment } : {}),
        json: commandOptions.json ?? global.json ?? false
    };
}

function environmentOption(): Option {
    return new Option('--environment <name>', 'Hosting environment').choices(['production', 'alpha', 'dev']);
}

function readPackageVersion(): string {
    const value = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>).version !== 'string') {
        throw new Error('Package version is missing from package.json');
    }
    return (value as Record<string, string>).version!;
}

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

function positiveInteger(value: string): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`Expected a positive integer, received ${value}`);
    return result;
}
