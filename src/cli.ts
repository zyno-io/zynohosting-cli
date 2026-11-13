import { Command, CommanderError, Option } from 'commander';
import { readFileSync } from 'node:fs';

import type { HostingEnvironment } from './config.js';

import { configureUserAgent } from './api/user-agent.js';
import { deploySite, DeploySiteOptions } from './commands/deploy-site.js';
import { downloadSite, DownloadSiteOptions } from './commands/download-site.js';
import { deleteFile, getFile, listFiles, putFile } from './commands/files.js';
import { runFormCommand, runFormsGuide } from './commands/forms.js';
import { login, LoginOptions } from './commands/login.js';
import { listLogins, useLogin, whoami } from './commands/logins.js';
import { logout, LogoutOptions } from './commands/logout.js';
import { promoteSite, PromoteSiteOptions } from './commands/promote-site.js';
import { getSite, listSites } from './commands/sites.js';
import { CliError } from './errors.js';
import { FORM_OPERATIONS } from './mcp/forms.js';
import { installHostingMcp, McpInstallAgent } from './mcp/install.js';
import { startHostingMcp } from './mcp/start.js';
import { forceJsonErrors } from './output.js';
import { permissionCapabilityLines } from './permissions.js';

const PACKAGE_VERSION = readPackageVersion();
configureUserAgent({ surface: 'cli', version: PACKAGE_VERSION });

export function createProgram(): Command {
    const program = new Command();
    program
        .name('zynohosting')
        .description('Manage and deploy ZynoHosting sites')
        .version(PACKAGE_VERSION)
        .option('--api-url <url>', 'Hosting Manager API URL')
        .option('--suite-api-url <url>', 'ZynoSuite API URL')
        .option('--auth-api-url <url>', 'ZynoAuth API URL')
        .addOption(environmentOption())
        .option('--api-key <key>', 'tenant API key (prefer ZYNOHOSTING_API_KEY)')
        .option('--tenant <name|id>', 'use this saved login for this command only (or set ZYNOHOSTING_TENANT)')
        .option('--json', 'emit machine-readable JSON');

    program
        .command('login')
        .description('sign in through ZynoSuite (browser, or a link and code) or save a CI API key')
        .option('--api-url <url>', 'Hosting Manager API URL')
        .option('--suite-api-url <url>', 'ZynoSuite API URL')
        .option('--auth-api-url <url>', 'ZynoAuth API URL')
        .addOption(environmentOption())
        .option('--api-key <key>', 'tenant API key instead of browser login')
        .option('--login-url <url>', 'ZynoSuite SPA login page URL')
        .option('--name <description>', 'name shown on the authorization screen')
        .option('--permission <key>', 'permission to request, repeatable (see the list below)', collect, [])
        .option('--renewable', 'keep a renewable credential (system credential store by default; see --credential-store)')
        .option('--lifetime <1h|1d|7d|30d>', 'suggest how long the login lasts; the approver decides. Anything above 1h needs --renewable')
        .option(
            '--credential-store <system|file>',
            'where the renewal token lives with --renewable (default: system; env ZYNOHOSTING_CREDENTIAL_STORE)'
        )
        .option('--device', 'sign in with a link and code you open on any device, even where a browser is available')
        .option('--no-device', 'use the browser even where a link and code would be chosen')
        .option('--no-wait', 'with --device: print the link and code, save the pending sign-in, and exit; finish it with --resume')
        .option('--resume', 'continue the pending sign-in started with --no-wait')
        .option('--no-open', 'print the login URL instead of opening a browser')
        .option('--json', 'emit machine-readable JSON events on stdout')
        .addOption(
            new Option(
                '--timeout <seconds>',
                'how long to wait for approval (browser: 300; device: until the code expires; --resume: 300)'
            ).argParser(positiveInteger)
        )
        .action(async (commandOptions: LoginOptions & { timeout?: number; permission: string[]; wait?: boolean; json?: boolean }) => {
            const global = program.opts<{
                apiUrl?: string;
                suiteApiUrl?: string;
                authApiUrl?: string;
                apiKey?: string;
                environment?: HostingEnvironment;
                json?: boolean;
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
                ...(commandOptions.lifetime ? { lifetime: commandOptions.lifetime } : {}),
                ...(commandOptions.credentialStore ? { credentialStore: commandOptions.credentialStore } : {}),
                ...(commandOptions.device === undefined ? {} : { device: commandOptions.device }),
                ...(commandOptions.wait === false ? { noWait: true } : {}),
                ...(commandOptions.resume ? { resume: true } : {}),
                ...(commandOptions.timeout === undefined ? {} : { timeoutSeconds: commandOptions.timeout }),
                ...(commandOptions.open === undefined ? {} : { open: commandOptions.open }),
                json: commandOptions.json ?? global.json ?? false,
                handleSigint: true
            });
        })
        .addHelpText(
            'after',
            [
                '',
                'Permissions (the complete list; any other key is rejected before anything is started):',
                permissionCapabilityLines()
                    .split('\n')
                    .map(line => `  ${line}`)
                    .join('\n'),
                '',
                'Every hosting permission also needs hosting.sitesRead. Request the narrowest complete set:',
                'a token cannot be widened later, so changing scope means logging out and signing in again.',
                '',
                'Where no browser can open (SSH, no display) login picks the link-and-code flow by itself.',
                'Agents that only show output when a command exits: login --device --no-wait --json, then login --resume --json.'
            ].join('\n')
        );

    program
        .command('logout')
        .description('revoke the active saved login (or the one named by --tenant) and remove its local credentials')
        .option('--all', 'log out of every login in every saved environment')
        .option('--tenant <name|id>', 'log out of this saved login instead of the active one')
        .option('--api-url <url>', 'Hosting Manager API URL')
        .option('--suite-api-url <url>', 'ZynoSuite API URL')
        .option('--auth-api-url <url>', 'ZynoAuth API URL')
        .addOption(environmentOption())
        .action(async (commandOptions: LogoutOptions) => {
            const context = commandContext(program, commandOptions);
            await logout({
                ...(commandOptions.all ? { all: true } : {}),
                ...(context.tenant ? { tenant: context.tenant } : {}),
                ...(context.apiUrl ? { apiUrl: context.apiUrl } : {}),
                ...(context.suiteApiUrl ? { suiteApiUrl: context.suiteApiUrl } : {}),
                ...(context.authApiUrl ? { authApiUrl: context.authApiUrl } : {}),
                ...(context.environment ? { environment: context.environment } : {})
            });
        });

    const logins = program
        .command('logins')
        .description('list the saved logins for the selected environment, one per tenant')
        .option('--api-url <url>', 'Hosting Manager API URL')
        .addOption(environmentOption())
        .option('--json', 'emit JSON')
        .action(async (commandOptions: { json?: boolean; environment?: HostingEnvironment; apiUrl?: string }) => {
            await listLogins(commandContext(program, commandOptions));
        });
    logins
        .command('use')
        .description('make a saved login the default, without signing in again')
        .argument('<tenant>', 'tenant name or tenant ID, as listed by `zynohosting logins`')
        .option('--api-url <url>', 'Hosting Manager API URL')
        .addOption(environmentOption())
        .option('--json', 'emit JSON')
        .action(async (tenant: string, commandOptions: { json?: boolean; environment?: HostingEnvironment; apiUrl?: string }) => {
            await useLogin(tenant, commandContext(program, commandOptions));
        });
    program
        .command('whoami')
        .description('show which saved login commands use now (with --all, every saved login)')
        .option('--all', 'list every saved login, like `zynohosting logins`')
        .option('--api-url <url>', 'Hosting Manager API URL')
        .addOption(environmentOption())
        .option('--json', 'emit JSON')
        .action(async (commandOptions: { all?: boolean; json?: boolean; environment?: HostingEnvironment; apiUrl?: string }) => {
            await whoami({ ...commandContext(program, commandOptions), ...(commandOptions.all ? { all: true } : {}) });
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
        .description('plan and synchronize a local directory to production or preview')
        .argument('<site>', 'site ID or hostname')
        .argument('[directory]', 'local directory', '.')
        .addOption(environmentOption())
        .option('-y, --yes', 'apply without prompting after displaying the plan')
        .option('--dry-run', 'display the exact plan without applying it')
        .option('--preview', 'deploy to the isolated preview slot')
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
        .command('promote')
        .description('publish the current preview deployment to production')
        .argument('<site>', 'site ID or hostname')
        .option('--force', 'allow promotion when production has wp-config.php and preview does not')
        .addOption(environmentOption())
        .option('-y, --yes', 'promote without prompting after displaying the plan')
        .option('--dry-run', 'show the promotion target without changing production')
        .option('--json', 'emit newline-delimited JSON output')
        .addOption(new Option('--timeout <seconds>', 'promotion and reconciliation timeout').argParser(positiveInteger).default(900))
        .action(async (siteRef: string, commandOptions: PromoteSiteOptions & { timeout: number }) => {
            await promoteSite(siteRef, { ...commandContext(program, commandOptions), ...commandOptions, timeoutSeconds: commandOptions.timeout });
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
        .argument('[roots...]', 'additional local roots, equivalent to repeating --root')
        .action(async (positionalRoots: string[], commandOptions: { root: string[] }) => {
            // This process is an MCP server, not the CLI, even though it was
            // reached through the CLI binary. `npx ... mcp` is the documented
            // invocation, so without this every npm-installed MCP server would
            // identify itself as a CLI to the API.
            configureUserAgent({ surface: 'mcp', version: PACKAGE_VERSION });
            const context = commandContext(program, {});
            await startHostingMcp({
                roots: [...commandOptions.root, ...positionalRoots],
                version: PACKAGE_VERSION,
                ...(context.apiUrl ? { apiUrl: context.apiUrl } : {}),
                ...(context.suiteApiUrl ? { suiteApiUrl: context.suiteApiUrl } : {}),
                ...(context.authApiUrl ? { authApiUrl: context.authApiUrl } : {}),
                ...(context.apiKey ? { apiKey: context.apiKey } : {}),
                ...(context.environment ? { environment: context.environment } : {})
            });
        });

    mcp.command('install')
        .description('configure the local ZynoHosting MCP for one agent in this project')
        .option('--project <path>', 'project root to configure', '.')
        .option('--agent <agent>', 'target agent: codex or claude')
        .action(async (commandOptions: { project: string; agent?: McpInstallAgent }) => {
            const installed = await installHostingMcp({
                project: commandOptions.project,
                ...(commandOptions.agent ? { agent: commandOptions.agent } : {})
            });
            for (const path of installed.configured) process.stdout.write(`Configured ${path}\n`);
            for (const path of installed.alreadyConfigured) process.stdout.write(`Already configured ${path}\n`);
            process.stdout.write(`Restart ${installAgentName(installed.agent)} before using the ZynoHosting MCP tools.\n`);
        });

    const forms = jsonParseErrors(
        program
            .command('forms')
            .description('discover, create, inspect, edit, and connect ZynoForms (JSON in, JSON out)')
            .hook('preAction', () => forceJsonErrors())
    );
    const formsDocs = 'https://cli.zyno.host/cli/forms';
    for (const operation of FORM_OPERATIONS) {
        const command = jsonParseErrors(forms.command(operation.command).description(operation.title));
        // `list` takes no arguments but still accepts `--input '{}'`, as its MCP tool accepts an empty object.
        command.option('--input <json|@file|->', 'JSON object of arguments, @file to read a file, or - for stdin');
        command
            .addOption(environmentOption())
            .addHelpText('after', `\n${operation.description}\n\nMirrors the MCP tool ${operation.tool}. Output is always JSON.\nSee ${formsDocs}\n`)
            .action(async (commandOptions: { input?: string; environment?: HostingEnvironment }) => {
                const { json: _json, ...context } = commandContext(program, commandOptions);
                await runFormCommand(operation.command, {
                    ...context,
                    ...(commandOptions.input === undefined ? {} : { input: commandOptions.input })
                });
            });
    }
    forms
        .command('guide')
        .description('print the ZynoForms embedding guide (no authentication needed)')
        .addHelpText('after', `\nMirrors the MCP resource zynoforms://guides/embedding. Output is always JSON.\nSee ${formsDocs}\n`)
        .action(() => runFormsGuide());

    return program;
}

function installAgentName(agent: McpInstallAgent): string {
    return agent === 'claude' ? 'Claude Code' : 'Codex';
}

/**
 * Forms commands promise JSON errors, but commander rejects bad options before any action hook runs and
 * prints plain text. Route those parse errors through the JSON error path as invalid input instead.
 */
function jsonParseErrors(command: Command): Command {
    return command.configureOutput({ outputError: () => {} }).exitOverride((error: CommanderError) => {
        // Help and version output exit normally; let commander finish them.
        if (error.code === 'commander.helpDisplayed' || error.code === 'commander.help' || error.code === 'commander.version') return;
        forceJsonErrors();
        throw new CliError(error.message.replace(/^error: /, ''), 2, 'invalid_input');
    });
}

function commandContext(
    program: Command,
    commandOptions: {
        apiUrl?: string;
        suiteApiUrl?: string;
        authApiUrl?: string;
        apiKey?: string;
        environment?: HostingEnvironment;
        tenant?: string;
        json?: boolean;
    }
): {
    apiUrl?: string;
    suiteApiUrl?: string;
    authApiUrl?: string;
    apiKey?: string;
    environment?: HostingEnvironment;
    tenant?: string;
    json: boolean;
} {
    const global = program.opts<{
        apiUrl?: string;
        suiteApiUrl?: string;
        authApiUrl?: string;
        apiKey?: string;
        environment?: HostingEnvironment;
        tenant?: string;
        json?: boolean;
    }>();
    return {
        ...((commandOptions.apiUrl ?? global.apiUrl) ? { apiUrl: commandOptions.apiUrl ?? global.apiUrl } : {}),
        ...((commandOptions.suiteApiUrl ?? global.suiteApiUrl) ? { suiteApiUrl: commandOptions.suiteApiUrl ?? global.suiteApiUrl } : {}),
        ...((commandOptions.authApiUrl ?? global.authApiUrl) ? { authApiUrl: commandOptions.authApiUrl ?? global.authApiUrl } : {}),
        ...((commandOptions.apiKey ?? global.apiKey) ? { apiKey: commandOptions.apiKey ?? global.apiKey } : {}),
        ...((commandOptions.environment ?? global.environment) ? { environment: commandOptions.environment ?? global.environment } : {}),
        ...((commandOptions.tenant ?? global.tenant) ? { tenant: commandOptions.tenant ?? global.tenant } : {}),
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
