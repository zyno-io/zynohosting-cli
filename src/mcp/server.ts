import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';

import { FormsClient } from '../api/forms-client.js';
import { ManagerClient } from '../api/manager-client.js';
import { resolveDistribution } from '../api/user-agent.js';
import { startCredentialRefreshLoop } from '../auth/credential-refresh.js';
import { applyPreparedDeployment, normalizeSiteRef, prepareDeployment, PreparedDeployment } from '../commands/deploy-site.js';
import { applyDownload, prepareDownload, PreparedDownload } from '../commands/download-site.js';
import { createFileClient, purgeSiteCacheAfterMutation, writeResponseAtomically } from '../commands/files.js';
import { login, LOGIN_LIFETIMES, LoginDependencies, type LoginPrompt, type LoginResult } from '../commands/login.js';
import { savedLogins, useLogin } from '../commands/logins.js';
import { applyPreparedPromotion, preparePromotion, PreparedPromotion, promotionSummary } from '../commands/promote-site.js';
import { applyPreparedSiteSettings, prepareSiteSettings } from '../commands/site-settings.js';
import { ConfigOverrides, type HostingEnvironment, ResolvedConfig, resolveConfig } from '../config.js';
import { CliError, errorMessage, HttpError } from '../errors.js';
import { DELEGABLE_PERMISSION_KEYS, permissionCapabilityLines } from '../permissions.js';
import { NOT_FOUND_HANDLING_MODES, PREVIEW_RESOURCE_NOTICE } from '../protocol.js';
import { registerFormsMcp } from './forms.js';
import { AllowedLocalRoots } from './local-paths.js';
import { UpdatePolicy } from './update-check.js';

export interface McpServerOptions extends ConfigOverrides {
    roots: AllowedLocalRoots;
    version: string;
    env?: NodeJS.ProcessEnv;
    loginDependencies?: Pick<LoginDependencies, 'onLoginPrompt' | 'openUrl' | 'renewalTokenStore' | 'scopedTokenClient' | 'platform'>;
    updatePolicy?: UpdatePolicy;
}

const MAX_PENDING_PLANS = 16;
/** These manage logins themselves, so they take no per-call tenant. */
const TENANT_EXEMPT_TOOLS = new Set(['login', 'list_logins', 'use_login']);
// Policy that applies once this server is connected belongs here or in a tool description, not in
// documentation the agent fetches before installing. The riskiest tools echo one line of it.
const SERVER_INSTRUCTIONS = [
    'Never infer a deployment domain from a repository, site content, organization name, or a similar available site. Before any site mutation, use an explicitly stated project domain or ask the user which domain they intend. Verify that domain with list_sites or get_site. If it is unavailable in the current login context, do not substitute another site; explain that access is unavailable and offer the login tool so the user can switch context. Use plan_deploy and present its operations and target before apply_deploy. Production is the default; target preview updates only preview. Use plan_promote and present both URLs before apply_promote; promotion renames the current preview into production and resets preview to empty. Preview has no separate database and shares the main site’s database and storage quota. Only set force to true when the user explicitly requests bypassing the wp-config.php guard; never retry a blocked promotion with force automatically. Read the preview address from get_site deployments.preview.url and never construct it; the vanity hostname serves production. File tools and downloads act only on production. Promotion replaces production with exactly what preview holds, and deployments never send wp-config.php, wp-content/uploads, or other excluded content to preview, so for WordPress or any site whose production holds content outside the build, recommend deploying to production instead of promoting. After a promotion preview is empty; do not promote again until preview has been redeployed.',
    'Saved logins: when list_logins shows more than one login, ask the user which tenant (organization) to work in before any site or form action, and pass that tenant name or id in the tool\u2019s tenant input; use_login changes the default for later calls. After a sign-in finishes, tell the user which account and tenant it signed in to and ask them to confirm it is theirs.',
    'When connecting a page to a form, read the existing page first and preserve its markup, layout, and styling rather than replacing it with a generic form. Allow that page’s exact origin, and follow the response contract and the jsonScript or capScript returned with the form. Read an existing form with describe_form before update_form and edit it in place rather than creating a second form. If ZynoForms cannot represent a field, validation rule, choice, or bot protection exactly, explain the limitation and ask the user how to proceed instead of dropping it.',
    'When the user wants to build a new site: ZynoHosting serves static files, plus PHP on sites with PHP turned on (get_site phpVersion is null when it is off, and .php files then return 404). It runs no Node.js or other server process, so server-side rendering and API routes are unavailable. If you can run commands, recommend Astro with its default static output and no server adapter, build it, and deploy the dist folder rather than the project root. If you cannot run a build, write plain HTML, CSS, and JavaScript files. Use PHP only for real server-side code, and ZynoForms rather than PHP for forms. A static site returns 404 for unknown paths unless get_site notFoundHandling is single-page-application, which serves /index.html for unknown paths unless they end in a listed asset extension. Prefer pre-rendering every route; if a client-side router needs the fallback, ask the user, then call set_not_found_handling; it applies to production and preview and is unavailable with PHP. Everything deployed is publicly readable, so never deploy .env files or secrets. These tools cannot create sites: deploy only to an existing site the user names, and if they have none, tell them to ask ZynoHosting support to set one up.'
].join(' ');

export async function createHostingMcpServer(options: McpServerOptions): Promise<McpServer> {
    const deployments = new Map<string, PreparedDeployment>();
    const downloads = new Map<string, PreparedDownload>();
    const promotions = new Map<string, PreparedPromotion>();
    const server = new McpServer(
        { name: 'io.github.zyno-io/zynohosting', version: options.version },
        { capabilities: { logging: {} }, instructions: SERVER_INSTRUCTIONS }
    );
    const authentication = new McpAuthentication(
        options,
        async error => {
            if (!server.isConnected()) return;
            await server.sendLoggingMessage({
                level: 'warning',
                logger: 'zynohosting.auth',
                data: `Background credential renewal failed: ${errorMessage(error)}`
            });
        },
        () => {
            deployments.clear();
            downloads.clear();
            promotions.clear();
        }
    );
    server.server.onclose = () => authentication.close();

    // Every tool except the sign-in ones accepts an optional `tenant`: which saved login to use for that one call.
    // It is registered here, once, so form tools and any tool added later get it, and is carried to
    // McpAuthentication.clients() through async context instead of being threaded through every handler.
    const registerWithTenant = server.registerTool.bind(server);
    server.registerTool = ((name: string, config: { inputSchema?: unknown }, handler: (...args: never[]) => unknown) => {
        const schema = config.inputSchema;
        if (TENANT_EXEMPT_TOOLS.has(name) || (isRecord(schema) && !(schema instanceof z.ZodType) && 'tenant' in schema)) {
            return registerWithTenant(name, config as never, handler as never);
        }
        const tenantField = z
            .string()
            .min(1)
            .max(255)
            .optional()
            .describe(
                'Saved login to use for this call only: a login id, tenant id, or tenant name from list_logins. Omit to use the default login.'
            );
        const accountField = z
            .string()
            .min(1)
            .max(320)
            .optional()
            .describe('Account email or id that narrows tenant when several accounts are signed in to the same tenant.');
        const extended =
            schema === undefined
                ? { tenant: tenantField, account: accountField }
                : schema instanceof z.ZodObject
                  ? schema.extend({ tenant: tenantField, account: accountField })
                  : { ...(schema as Record<string, z.ZodType>), tenant: tenantField, account: accountField };
        return registerWithTenant(
            name,
            { ...config, inputSchema: extended } as never,
            ((...args: unknown[]) => {
                // A tool that had no input is now called with (input, extra) but its handler still expects (extra).
                const [input, extra] = args as [{ tenant?: string; account?: string }, unknown];
                const { tenant, account, ...rest } = input ?? {};
                const forward = schema === undefined ? [extra] : [rest, extra];
                return authentication.tenant.run({ tenant, account }, () => (handler as (...forwarded: unknown[]) => unknown)(...forward));
            }) as never
        );
    }) as typeof server.registerTool;

    // Only a desktop bundle can go stale: an installed .mcpb is frozen until it
    // stages a newer runtime, while npm and npx resolve the newest version on
    // every launch. Enforcing a minimum elsewhere would tell a Claude Code user
    // to install a bundle they never had, and would make every CLI process fetch
    // a release descriptor it has no use for.
    const environment = options.env ?? process.env;
    const enforcesMinimumVersion = resolveDistribution(environment) === 'mcpb' && environment.ZYNOHOSTING_DISABLE_UPDATE !== '1';
    const updatePolicy = options.updatePolicy ?? (enforcesMinimumVersion ? new UpdatePolicy({ version: options.version }) : undefined);

    // Gate at registration rather than in each handler, so the form tools
    // registered elsewhere are covered too and a tool added later cannot forget.
    if (updatePolicy) {
        updatePolicy.refresh();
        const registerToolDirectly = server.registerTool.bind(server);
        server.registerTool = ((name: string, config: never, handler: (...args: never[]) => unknown) =>
            registerToolDirectly(name, config, ((...args: never[]) => {
                // Never awaited: a slow or unreachable descriptor host must not add
                // latency to an operation, and unknown policy always permits.
                updatePolicy.refresh();
                const demand = updatePolicy.requiredUpdate();
                if (demand) return { isError: true, content: [{ type: 'text' as const, text: demand }] };
                return handler(...args);
            }) as never)) as typeof server.registerTool;
    }

    server.registerTool(
        'login',
        {
            title: 'Sign in to ZynoHosting',
            description: [
                'Start, check, or cancel the sign-in flow for ZynoHosting. Starting returns what the user needs in this tool result: either a one-time browser URL (flow "browser", also opened in a browser on the computer running this server) or a link and a short code (flow "device") that the user opens on any device. Use this before authenticated tools when no login is saved, when the requested domain is unavailable in the current login context, or to add a login for another tenant. A sign-in cannot replace API-key or token credentials injected into this MCP process; change those credentials and restart instead.',
                'The flow is chosen automatically: the browser flow where a browser can open on this computer, the link-and-code flow over SSH or on a machine with no display. Pass flow "device" or "browser" only to override that. For the device flow, give the user the link and the code verbatim, tell them to check that the code matches, pick how long the access lasts and approve it, then call this tool with action "status" until it reports authenticated. Never open the link or approve it yourself, and never ask the user to send you the code from a link someone else gave them.',
                `Request only these permissions — no others exist, and one invalid key rejects the whole request instead of granting the rest:\n${permissionCapabilityLines()}`,
                'Include hosting.sitesRead in every hosting request. Ask for the narrowest complete set for the stated task: editing individual files needs hosting.filesRead and hosting.filesWrite (add hosting.filesDelete only to remove files); a full deploy, promotion, or not-found handling change needs hosting.deploy; a backup needs hosting.download, plus hosting.downloadSensitive only when user-generated content is wanted. A token cannot be widened later, so a missing permission means revoking and signing in again.',
                'Each tenant has one saved login: signing in again to the same tenant replaces it, and signing in to another tenant adds a login and makes it the default (see list_logins and use_login). lifetime is only a suggestion for how long the access lasts; the user chooses when approving, and anything above 1h needs renewable.',
                'One sign-in runs at a time. Starting with the same permissions, name, renewable flag, flow, and lifetime returns that same in-flight prompt with "reused": true; starting with a different request cancels the in-flight sign-in and returns a new one, so the user must use the newest link. Use action "cancel" to abandon a sign-in the user is not going to finish.'
            ].join('\n\n'),
            inputSchema: {
                action: z.enum(['start', 'status', 'cancel']).default('start'),
                permissions: z
                    .array(z.enum(DELEGABLE_PERMISSION_KEYS))
                    .min(1)
                    .max(DELEGABLE_PERMISSION_KEYS.length)
                    .default(['hosting.sitesRead'])
                    .describe('ZynoSuite permissions to request, from the enumerated list; the narrowest set that completes the stated task.'),
                name: z.string().min(1).max(255).optional(),
                renewable: z.boolean().default(false),
                flow: z
                    .enum(['auto', 'browser', 'device'])
                    .default('auto')
                    .describe('auto picks browser or device for this computer; set it only to override.'),
                lifetime: z.enum(Object.keys(LOGIN_LIFETIMES) as [keyof typeof LOGIN_LIFETIMES, ...(keyof typeof LOGIN_LIFETIMES)[]]).optional(),
                timeout_seconds: z
                    .number()
                    .int()
                    .min(1)
                    .max(600)
                    .optional()
                    .describe('How long to wait for approval. Default: 300 for the browser flow, until the code expires for the device flow.')
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
        },
        async ({ action, permissions, name, renewable, flow, lifetime, timeout_seconds }) => {
            if (action === 'status') return result(await authentication.loginStatus());
            if (action === 'cancel') return result(await authentication.cancelLogin());

            const pendingLogin = await authentication.beginLogin({
                permissions,
                ...(name ? { name } : {}),
                renewable,
                flow,
                ...(lifetime ? { lifetime } : {}),
                ...(timeout_seconds === undefined ? {} : { timeoutSeconds: timeout_seconds })
            });
            const prompt = pendingLogin.prompt;
            const sharedFields = {
                authenticated: false,
                status: 'pending',
                permissions: [...new Set(permissions)].sort(),
                reused: pendingLogin.reused
            };
            if (prompt.flow === 'device') {
                return result({
                    ...sharedFields,
                    flow: 'device',
                    verificationUri: prompt.verificationUri,
                    ...(prompt.verificationUriComplete ? { verificationUriComplete: prompt.verificationUriComplete } : {}),
                    userCode: prompt.userCode,
                    expiresAt: new Date(prompt.expiresAt).toISOString(),
                    message: `Give the user the link (${prompt.verificationUriComplete ?? prompt.verificationUri}) and the code ${prompt.userCode} verbatim. They open it on any device, check the code matches, choose how long access lasts, and approve. Do not open the link or approve it yourself. Then call login with action "status" until it reports authenticated, and tell the user which account and tenant it signed in to so they can confirm it is theirs.${pendingLogin.reused ? ' This is the same pending code as before, not a new one.' : ''}`
                });
            }
            return result({
                ...sharedFields,
                flow: 'browser',
                browserUrl: prompt.url,
                message: pendingLogin.reused
                    ? 'An identical browser sign-in was already in flight, so this is that same one-time URL, not a new one. Its permissions match this request. After sign-in, call login with action "status".'
                    : 'Open the one-time sign-in URL if a browser did not open. Any earlier sign-in URL from this server is now cancelled. After you finish sign-in, call login with action "status" before using authenticated tools.'
            });
        }
    );

    server.registerTool(
        'list_logins',
        {
            title: 'List saved ZynoHosting logins',
            description:
                'List the saved logins for this environment, one per tenant (organization): tenant name and id, the account that approved it, which one is the default, when access and the approved lifetime end, and whether it has expired. When there is more than one, ask the user which tenant to work in. This changes nothing.',
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async () => result(await authentication.listLogins())
    );

    server.registerTool(
        'use_login',
        {
            title: 'Choose the default ZynoHosting login',
            description:
                'Make a saved login the default for later calls, without signing in again. Pass the tenant name or id from list_logins. To use a different login for one call only, pass tenant on that tool instead. Pending deployment, promotion, and download plans are cleared because the context changes.',
            inputSchema: {
                tenant: z.string().min(1).max(255).describe('Login id, tenant id, or tenant name from list_logins.'),
                account: z.string().min(1).max(320).optional().describe('Account email or id, when several accounts are signed in to that tenant.')
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async ({ tenant, account }) => result(await authentication.useLogin(tenant, account))
    );

    registerFormsMcp(server, () => authentication.clients());

    server.registerTool(
        'list_sites',
        {
            title: 'List authorized ZynoHosting sites',
            description: 'List sites the current credential is authorized to inspect.',
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async () => result(await (await authentication.clients()).manager.listSites())
    );

    server.registerTool(
        'get_site',
        {
            title: 'Get a ZynoHosting site',
            description:
                'Get one explicitly intended site by UUID or hostname. Do not use this to pick a likely deployment target; ask the user when the project domain is not explicit.',
            inputSchema: { site: z.string().min(1) },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ site }) => result(await authorizedSite((await authentication.clients()).manager, site))
    );

    server.registerTool(
        'list_files',
        {
            title: 'List hosted files',
            description: 'List one directory or subtree without following symbolic links.',
            inputSchema: {
                site: z.string().min(1),
                path: z.string().default(''),
                recursive: z.boolean().default(false)
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ site, path, recursive }) => {
            const { config } = await authentication.clients();
            const { client } = await createFileClient(site, ['files:list'], options, undefined, config);
            return result(await client.list(path, recursive));
        }
    );

    server.registerTool(
        'get_file',
        {
            title: 'Download one hosted file',
            description: 'Download one regular hosted file to the MCP process filesystem, optionally restricted by configured local roots.',
            inputSchema: {
                site: z.string().min(1),
                remote_path: z.string().min(1),
                local_path: z.string().min(1).describe('Absolute local destination; inside an MCP root when roots are configured'),
                overwrite: z.boolean().default(false)
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async ({ site, remote_path, local_path, overwrite }) => {
            const destination = await options.roots.destination(local_path);
            const { config } = await authentication.clients();
            const { client } = await createFileClient(site, ['files:read'], options, undefined, config);
            const response = await client.get(remote_path);
            await writeResponseAtomically(response, destination, overwrite);
            return result({
                site,
                remotePath: remote_path,
                localPath: destination,
                size: numberHeader(response, 'content-length'),
                etag: response.headers.get('etag')
            });
        }
    );

    server.registerTool(
        'put_file',
        {
            title: 'Upload one hosted file',
            description:
                'Create or replace one regular hosted file from the MCP process filesystem, optionally restricted by configured local roots.',
            inputSchema: {
                site: z.string().min(1),
                local_path: z.string().min(1).describe('Absolute local source; inside an MCP root when roots are configured'),
                remote_path: z.string().min(1),
                etag: z.string().optional(),
                create_only: z.boolean().default(false)
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
        },
        async ({ site, local_path, remote_path, etag, create_only }) => {
            const source = await options.roots.existing(local_path);
            const info = await lstat(source);
            if (!info.isFile() || info.isSymbolicLink()) throw new CliError('Local source is not a regular file', 2, 'invalid_source');
            const { config } = await authentication.clients();
            const files = await createFileClient(site, ['files:write'], options, undefined, config);
            const uploaded = await files.client.put(remote_path, createReadStream(source), {
                ...(etag ? { ifMatch: etag } : {}),
                ...(create_only ? { ifNoneMatch: '*' } : {})
            });
            await purgeSiteCacheAfterMutation(files.manager, files.siteId, uploaded);
            return result(uploaded);
        }
    );

    server.registerTool(
        'delete_file',
        {
            title: 'Delete one hosted file',
            description: 'Delete one regular hosted file, optionally guarded by its ETag.',
            inputSchema: {
                site: z.string().min(1),
                remote_path: z.string().min(1),
                etag: z.string().optional()
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
        },
        async ({ site, remote_path, etag }) => {
            const { config } = await authentication.clients();
            const files = await createFileClient(site, ['files:delete'], options, undefined, config);
            const deleted = await files.client.delete(remote_path, etag);
            await purgeSiteCacheAfterMutation(files.manager, files.siteId, deleted);
            return result(deleted);
        }
    );

    server.registerTool(
        'plan_deploy',
        {
            title: 'Plan a full site deployment',
            description:
                'Build and store an exact deployment plan for the domain the user explicitly chose. target defaults to production; choose preview to update only its isolated preview deployment. Never guess a site from the project or select a similar authorized domain. This does not change hosted content.',
            inputSchema: {
                site: z.string().min(1),
                local_root: z.string().min(1).describe('Absolute local directory; inside an MCP root when roots are configured'),
                target: z.enum(['production', 'preview']).default('production'),
                ignore: z.array(z.string()).default([]),
                ignore_file: z.string().optional(),
                allow_empty: z.boolean().default(false)
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ site, local_root, target, ignore, ignore_file, allow_empty }) => {
            purgeExpired(deployments, downloads, promotions);
            requirePlanCapacity(deployments, downloads, promotions);
            const source = await options.roots.existing(local_root);
            const info = await lstat(source);
            if (!info.isDirectory() || info.isSymbolicLink()) throw new CliError('Deployment source is not a regular directory', 2, 'invalid_source');
            const { config } = await authentication.clients();
            const plan = await prepareDeployment(
                site,
                source,
                {
                    ...options,
                    yes: true,
                    preview: target === 'preview',
                    allowEmpty: allow_empty,
                    ...(ignore.length ? { ignore } : {}),
                    ...(ignore_file ? { ignoreFile: await options.roots.existing(ignore_file) } : {})
                },
                undefined,
                config
            );
            deployments.set(plan.finalPlan.planId, plan);
            return result({
                planId: plan.finalPlan.planId,
                site: plan.fqdn,
                target: plan.target,
                ...(plan.target === 'preview' ? { resourceNotice: PREVIEW_RESOURCE_NOTICE } : {}),
                ...(plan.session.url ? { url: plan.session.url } : {}),
                source: plan.source,
                expiresAt: earliest(plan.finalPlan.expiresAt, plan.session.expiresAt),
                operations: plan.finalPlan.operations,
                uploadBytes: plan.uploadBytes,
                ignoreSources: plan.ignoreSources
            });
        }
    );

    server.registerTool(
        'apply_deploy',
        {
            title: 'Apply a planned full deployment',
            description: 'Apply the exact deployment plan returned by plan_deploy.',
            inputSchema: { plan_id: z.string().min(1) },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
        },
        async ({ plan_id }) => {
            purgeExpired(deployments, downloads, promotions);
            const plan = deployments.get(plan_id);
            if (!plan) throw new CliError('Deployment plan is unknown or expired; create a new plan', 6, 'plan_expired');
            const applied = await applyPreparedDeployment(plan);
            deployments.delete(plan_id);
            return result({
                ...applied,
                target: plan.target,
                ...(plan.target === 'preview' ? { resourceNotice: PREVIEW_RESOURCE_NOTICE } : {}),
                ...(plan.session.url ? { url: plan.session.url } : {})
            });
        }
    );

    server.registerTool(
        'plan_promote',
        {
            title: 'Plan preview promotion to production',
            description:
                'Inspect the explicitly chosen site and store a promotion plan with its preview/production URLs and current production deployment. No content changes. At apply time preview is renamed into production, old production is archived for background deletion, and preview is reset to empty. Preview has no separate database and shares the main site’s database and storage quota. Promotion is blocked if production has wp-config.php and preview does not; force must be explicitly selected when planning to bypass this check. Requires hosting.sitesRead; applying also requires hosting.deploy.',
            inputSchema: {
                site: z.string().min(1),
                force: z.boolean().default(false).describe('Explicitly bypass the missing preview wp-config.php promotion guard')
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ site, force }) => {
            purgeExpired(deployments, downloads, promotions);
            requirePlanCapacity(deployments, downloads, promotions);
            const { config } = await authentication.clients();
            const plan = await preparePromotion(site, { ...options, force }, config);
            promotions.set(plan.planId, plan);
            return result(promotionSummary(plan));
        }
    );

    server.registerTool(
        'apply_promote',
        {
            title: 'Promote preview to production',
            description:
                'Apply a plan_promote plan from this process. Renames current preview into production and resets preview to empty, guards against changes to the planned production deployment, and waits for serving reconciliation. A retry after acceptance resumes the same reconciliation. Requires hosting.deploy.',
            inputSchema: { plan_id: z.string().min(1) },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
        },
        async ({ plan_id }) => {
            purgeExpired(deployments, downloads, promotions);
            const plan = promotions.get(plan_id);
            if (!plan) throw new CliError('Promotion plan is unknown or expired; create a new plan', 6, 'plan_expired');
            const promoted = await applyPreparedPromotion(plan);
            promotions.delete(plan_id);
            return result(promoted);
        }
    );

    server.registerTool(
        'set_not_found_handling',
        {
            title: 'Set how a site handles missing pages',
            description:
                'Set a site\'s not-found handling. "single-page-application" serves /index.html (status 200) for unknown paths unless they end in a listed asset extension (.js, .css, images, fonts, .json, .txt, ...), which still return 404, so client-side routers can handle deep links. "404-page" (default) returns 404 for every unknown path. Applies immediately to both production and preview and purges the CDN cache; it changes live traffic, so ask the user first. Static sites only: fails if the site runs PHP. Prefer pre-rendering every route; use this only when a client-side router needs it. Idempotent; waits for serving reconciliation. Requires hosting.deploy.',
            inputSchema: {
                site: z.string().min(1),
                mode: z.enum(NOT_FOUND_HANDLING_MODES)
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
        },
        async ({ site, mode }) => {
            const { config, manager } = await authentication.clients();
            await authorizedSite(manager, normalizeSiteRef(site));
            const plan = await prepareSiteSettings(site, mode, options, config);
            return result(await applyPreparedSiteSettings(plan));
        }
    );

    server.registerTool(
        'plan_download',
        {
            title: 'Plan a complete site download',
            description:
                'Authorize a deployable-only or sensitive full snapshot into a local destination, optionally restricted by configured roots.',
            inputSchema: {
                site: z.string().min(1),
                local_root: z.string().min(1).describe('Absolute new or empty directory; inside an MCP root when roots are configured'),
                include_sensitive: z.boolean().default(false)
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ site, local_root, include_sensitive }) => {
            purgeExpired(deployments, downloads, promotions);
            requirePlanCapacity(deployments, downloads, promotions);
            const target = await options.roots.destination(local_root);
            const { config } = await authentication.clients();
            const plan = await prepareDownload(site, target, { ...options, sensitive: include_sensitive, yes: true }, config);
            downloads.set(plan.planId, plan);
            return result({
                planId: plan.planId,
                site,
                target: plan.target,
                ...(plan.target === 'preview' ? { resourceNotice: PREVIEW_RESOURCE_NOTICE } : {}),
                scope: plan.scope,
                expiresAt: plan.expiresAt
            });
        }
    );

    server.registerTool(
        'apply_download',
        {
            title: 'Apply a planned complete site download',
            description: 'Download and safely extract the exact snapshot authorized by plan_download.',
            inputSchema: { plan_id: z.string().min(1) },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        },
        async ({ plan_id }) => {
            purgeExpired(deployments, downloads, promotions);
            const plan = downloads.get(plan_id);
            if (!plan) throw new CliError('Download plan is unknown or expired; create a new plan', 6, 'plan_expired');
            const downloaded = await applyDownload(plan);
            downloads.delete(plan_id);
            return result(downloaded);
        }
    );

    return server;
}

interface AuthenticatedMcpClients {
    config: ResolvedConfig;
    manager: ManagerClient;
    forms: FormsClient;
}

interface LoginRequest {
    permissions: string[];
    name?: string;
    renewable: boolean;
    flow: 'auto' | 'browser' | 'device';
    lifetime?: string;
}

interface PendingMcpLogin {
    prompt: Promise<LoginPrompt>;
    value?: LoginPrompt;
    completion: Promise<ResolvedConfig>;
    request: LoginRequest;
    abort: AbortController;
}

/** Which saved login one call names. */
interface LoginChoice {
    tenant?: string | undefined;
    account?: string | undefined;
}

/** Clients are cached per saved login: '' is the default login, any other key is a tenant named for one call. */
const DEFAULT_LOGIN = '';

class McpAuthentication {
    /** Carries the `tenant` and `account` inputs of the tool call being handled. */
    readonly tenant = new AsyncLocalStorage<LoginChoice>();
    private readonly current = new Map<string, AuthenticatedMcpClients>();
    private readonly pending = new Map<string, Promise<AuthenticatedMcpClients>>();
    private readonly stopRefresh = new Map<string, () => void>();
    /** Bumped whenever the default login may have changed, so a load that began earlier cannot cache a stale client. */
    private generation = 0;
    private pendingLogin: PendingMcpLogin | undefined;
    /** The sign-in that just finished, so its status names the tenant that was approved, whatever the default now is. */
    private lastSignIn: Extract<LoginResult, { status: 'authenticated' }> | undefined;
    private lastLoginError: unknown;

    constructor(
        private readonly options: McpServerOptions,
        private readonly onRefreshError: (error: unknown) => Promise<void>,
        private readonly onLoginComplete: () => void
    ) {}

    async clients(choice: LoginChoice | undefined = this.tenant.getStore()): Promise<AuthenticatedMcpClients> {
        const tenant = choice?.tenant?.trim() || undefined;
        const account = choice?.account?.trim() || undefined;
        const key = tenant || account ? `${tenant ?? ''}\u0000${account ?? ''}` : DEFAULT_LOGIN;
        const cached = this.current.get(key);
        if (cached) return cached;
        let loading = this.pending.get(key);
        if (!loading) {
            const started: Promise<AuthenticatedMcpClients> = this.load(key, { tenant, account }).finally(() => {
                if (this.pending.get(key) === started) this.pending.delete(key);
            });
            loading = started;
            this.pending.set(key, loading);
        }
        return loading;
    }

    async listLogins(): Promise<Record<string, unknown>> {
        const env = this.options.env ?? process.env;
        const { profile, logins } = await savedLogins({ ...this.selectors() }, { env });
        return {
            profile,
            logins,
            message: logins.length
                ? logins.length > 1
                    ? 'Several logins are saved. Ask the user which tenant to work in, then pass it as tenant on each call or call use_login.'
                    : 'One login is saved; it is used by default.'
                : 'No saved logins. Call login with action "start".'
        };
    }

    async useLogin(tenant: string, account?: string): Promise<Record<string, unknown>> {
        this.requireSwitchableCredentialSource();
        this.lastSignIn = undefined;
        const env = this.options.env ?? process.env;
        const active = await useLogin(tenant, { ...this.selectors(), ...(account ? { account } : {}) }, { env, write: () => {} });
        this.resetClients();
        this.onLoginComplete();
        return { active, message: 'This is now the default login. Any pending deployment, promotion, or download plans were cleared.' };
    }

    async beginLogin(input: {
        permissions: string[];
        name?: string;
        renewable: boolean;
        flow: 'auto' | 'browser' | 'device';
        lifetime?: string;
        timeoutSeconds?: number;
    }): Promise<{ prompt: LoginPrompt; reused: boolean }> {
        this.requireSwitchableCredentialSource();
        const request: LoginRequest = {
            permissions: [...new Set(input.permissions)].sort(),
            ...(input.name ? { name: input.name } : {}),
            renewable: input.renewable,
            flow: input.flow,
            ...(input.lifetime ? { lifetime: input.lifetime } : {})
        };
        // A different scope must never be answered with the in-flight prompt: that sign-in would
        // mint the earlier permissions while the caller believes it requested new ones. Re-check
        // after each await, because another call can install its own flow while this one waits.
        while (this.pendingLogin) {
            if (sameLoginRequest(this.pendingLogin.request, request)) {
                return { prompt: await this.pendingLogin.prompt, reused: true };
            }
            await this.abortPendingLogin();
        }
        this.lastLoginError = undefined;
        this.lastSignIn = undefined;

        let publishPrompt!: (prompt: LoginPrompt) => void;
        let failBeforePrompt!: (error: unknown) => void;
        const prompt = new Promise<LoginPrompt>((resolve, reject) => {
            publishPrompt = resolve;
            failBeforePrompt = reject;
        });
        const pendingLogin: PendingMcpLogin = {
            prompt,
            completion: Promise.resolve<ResolvedConfig>(undefined as never),
            request,
            abort: new AbortController()
        };
        this.pendingLogin = pendingLogin;
        pendingLogin.completion = login(
            {
                ...(this.options.apiUrl ? { apiUrl: this.options.apiUrl } : {}),
                ...(this.options.suiteApiUrl ? { suiteApiUrl: this.options.suiteApiUrl } : {}),
                ...(this.options.authApiUrl ? { authApiUrl: this.options.authApiUrl } : {}),
                ...(this.options.environment ? { environment: this.options.environment } : {}),
                ...(request.name ? { name: request.name } : {}),
                permissionKeys: request.permissions,
                renewable: request.renewable,
                ...(request.flow === 'auto' ? {} : { device: request.flow === 'device' }),
                ...(request.lifetime ? { lifetime: request.lifetime } : {}),
                ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
                signal: pendingLogin.abort.signal
            },
            {
                ...(this.options.loginDependencies ?? {}),
                env: this.options.env ?? process.env,
                // The MCP stdio transport owns stdout. Login progress and a fallback URL must never be
                // emitted there because that would corrupt the protocol stream.
                write: message => process.stderr.write(message),
                onLoginPrompt: async loginPrompt => {
                    pendingLogin.value = loginPrompt;
                    publishPrompt(loginPrompt);
                    await this.options.loginDependencies?.onLoginPrompt?.(loginPrompt);
                }
            }
        )
            .then(async result => {
                this.resetClients();
                const config = await this.resolve();
                this.lastSignIn = result.status === 'authenticated' ? result : undefined;
                this.setCurrent(DEFAULT_LOGIN, config);
                this.onLoginComplete();
                return config;
            })
            .catch(error => {
                this.lastLoginError = error;
                failBeforePrompt(error);
                throw error;
            })
            .finally(() => {
                if (this.pendingLogin === pendingLogin) this.pendingLogin = undefined;
            });
        // The request itself returns the prompt, so keep a later timeout or cancellation from
        // becoming an unhandled rejection after the MCP tool result has been delivered.
        void pendingLogin.completion.catch(() => {});
        return { prompt: await pendingLogin.prompt, reused: false };
    }

    async cancelLogin(): Promise<Record<string, unknown>> {
        if (!this.pendingLogin) {
            return { authenticated: this.current.has(DEFAULT_LOGIN), status: 'not_pending', message: 'No sign-in is in flight.' };
        }
        // The user can win the race with a cancellation already on its way.
        if (await this.abortPendingLogin()) return await this.loginStatus();
        return {
            authenticated: false,
            status: 'cancelled',
            message: 'The sign-in was cancelled. Its one-time URL or code no longer works.'
        };
    }

    async loginStatus(): Promise<Record<string, unknown>> {
        if (this.pendingLogin) {
            const prompt = this.pendingLogin.value;
            return {
                authenticated: false,
                status: 'pending',
                permissions: this.pendingLogin.request.permissions,
                ...(prompt?.flow === 'browser' ? { flow: 'browser', browserUrl: prompt.url } : {}),
                ...(prompt?.flow === 'device'
                    ? {
                          flow: 'device',
                          verificationUri: prompt.verificationUri,
                          ...(prompt.verificationUriComplete ? { verificationUriComplete: prompt.verificationUriComplete } : {}),
                          userCode: prompt.userCode,
                          expiresAt: new Date(prompt.expiresAt).toISOString()
                      }
                    : {}),
                message:
                    prompt?.flow === 'device'
                        ? 'Still waiting for the user to approve the code. Give them the link and code again if needed; do not approve it yourself.'
                        : 'Browser sign-in is still waiting for its secure local callback.'
            };
        }
        if (this.lastLoginError) {
            return { authenticated: false, status: 'failed', message: `Sign-in failed: ${errorMessage(this.lastLoginError)}` };
        }
        if (this.lastSignIn) {
            const done = this.lastSignIn;
            return {
                authenticated: true,
                status: 'authenticated',
                expiresAt: done.accessExpiresAt,
                loginId: done.loginId,
                ...(done.accountId ? { accountId: done.accountId } : {}),
                tenant: done.tenantId,
                ...(done.tenantName ? { tenantName: done.tenantName } : {}),
                ...(done.account ? { account: done.account } : {}),
                ...(done.grantExpiresAt === undefined ? {} : { grantExpiresAt: new Date(done.grantExpiresAt).toISOString() }),
                permissionKeys: done.permissionKeys,
                deniedPermissionKeys: done.deniedPermissionKeys,
                message:
                    'ZynoHosting login is ready. Tell the user which account and tenant this signed in to so they can confirm it is theirs. Any pending deployment or download plans were cleared because the login context changed.'
            };
        }
        const current = this.current.get(DEFAULT_LOGIN);
        if (current) return authenticatedLoginStatus(current.config);
        try {
            return authenticatedLoginStatus((await this.clients({})).config);
        } catch (error) {
            if (error instanceof CliError && error.code === 'missing_config') {
                return { authenticated: false, status: 'not_started', message: 'No saved ZynoHosting login. Call login with action "start".' };
            }
            throw error;
        }
    }

    close(): void {
        for (const stop of this.stopRefresh.values()) stop();
        this.stopRefresh.clear();
        this.current.clear();
        // Abort so the loopback listener or device code and its one-time URL die with the MCP session.
        this.pendingLogin?.abort.abort();
        this.pendingLogin = undefined;
    }

    /** Ends the in-flight sign-in. Resolves true when it had already completed successfully. */
    private async abortPendingLogin(): Promise<boolean> {
        const pendingLogin = this.pendingLogin;
        if (!pendingLogin) return false;
        pendingLogin.abort.abort();
        const completed = await pendingLogin.completion.then(
            () => true,
            () => false
        );
        if (this.pendingLogin === pendingLogin) this.pendingLogin = undefined;
        // A cancellation the caller asked for is not a failure to report on the next status call.
        if (!completed && this.lastLoginError instanceof CliError && this.lastLoginError.code === 'login_cancelled') {
            this.lastLoginError = undefined;
        }
        return completed;
    }

    private async load(key: string, choice: LoginChoice): Promise<AuthenticatedMcpClients> {
        const generation = this.generation;
        const config = await this.resolve(choice);
        // The default login changed while this resolved, so what it read may be the old one: use it for this call only.
        if (generation !== this.generation) return this.build(config);
        return this.setCurrent(key, config);
    }

    private async resolve(choice: LoginChoice = {}): Promise<ResolvedConfig> {
        try {
            return await resolveConfig(
                { ...this.options, ...(choice.tenant ? { tenant: choice.tenant } : {}), ...(choice.account ? { account: choice.account } : {}) },
                this.options.env ?? process.env
            );
        } catch (error) {
            if (error instanceof CliError && error.code === 'missing_config') {
                throw new CliError('ZynoHosting is not signed in. Call the login MCP tool to start the sign-in flow.', error.exitCode, error.code);
            }
            throw error;
        }
    }

    private build(config: ResolvedConfig): AuthenticatedMcpClients {
        return {
            config,
            manager: new ManagerClient(config.apiUrl, config.credential),
            forms: new FormsClient(config.suiteApiUrl, config.credential),
            ...(config.suiteApiUrl ? { suiteApiUrl: config.suiteApiUrl } : {})
        };
    }

    private setCurrent(key: string, config: ResolvedConfig): AuthenticatedMcpClients {
        this.stopRefresh.get(key)?.();
        this.stopRefresh.set(key, startCredentialRefreshLoop(config.credential, { onError: this.onRefreshError }));
        const current = this.build(config);
        this.current.set(key, current);
        return current;
    }

    /** The default login changed (a sign-in or use_login), so every cached client may now be wrong. */
    private resetClients(): void {
        this.generation++;
        this.pending.clear();
        for (const stop of this.stopRefresh.values()) stop();
        this.stopRefresh.clear();
        this.current.clear();
    }

    private selectors(): { apiUrl?: string; environment?: HostingEnvironment } {
        return {
            ...(this.options.apiUrl ? { apiUrl: this.options.apiUrl } : {}),
            ...(this.options.environment ? { environment: this.options.environment } : {})
        };
    }

    private requireSwitchableCredentialSource(): void {
        const env = this.options.env ?? process.env;
        if (this.options.apiKey || this.options.accessToken || env.ZYNOHOSTING_API_KEY || env.ZYNOHOSTING_ACCESS_TOKEN) {
            throw new CliError(
                'This MCP process uses an API key or access token supplied by its command or environment, so signing in or choosing a login cannot switch its active context. Remove or replace that credential and restart the MCP host.',
                2,
                'fixed_credential_source'
            );
        }
    }
}

function sameLoginRequest(a: LoginRequest, b: LoginRequest): boolean {
    return (
        a.renewable === b.renewable &&
        a.name === b.name &&
        a.flow === b.flow &&
        a.lifetime === b.lifetime &&
        a.permissions.length === b.permissions.length &&
        a.permissions.every((permission, index) => permission === b.permissions[index])
    );
}

function authenticatedLoginStatus(config: ResolvedConfig): Record<string, unknown> {
    const login = config.login;
    return {
        authenticated: true,
        status: 'authenticated',
        expiresAt: config.credential.type === 'bearer' ? (config.credential.expiresAt ?? null) : null,
        ...(login?.kind === 'login'
            ? {
                  loginId: login.id,
                  ...(login.accountId ? { accountId: login.accountId } : {}),
                  tenant: login.tenantId ?? login.id,
                  ...(login.tenantName ? { tenantName: login.tenantName } : {})
              }
            : {}),
        ...(login?.accountEmail ? { account: login.accountEmail } : {}),
        ...(login?.grantExpiresAt === undefined ? {} : { grantExpiresAt: new Date(login.grantExpiresAt).toISOString() }),
        ...(login?.permissionKeys ? { permissionKeys: login.permissionKeys } : {}),
        ...(login?.deniedPermissionKeys ? { deniedPermissionKeys: login.deniedPermissionKeys } : {}),
        message:
            'ZynoHosting login is ready. Tell the user which account and tenant this is signed in to so they can confirm it is theirs. Any pending deployment or download plans were cleared because the login context changed.'
    };
}

async function authorizedSite(manager: ManagerClient, site: string) {
    try {
        return await manager.getSite(site);
    } catch (error) {
        if (error instanceof HttpError && (error.status === 403 || error.status === 404)) {
            throw new CliError(
                `The current ZynoHosting login cannot access ${site}. Do not substitute another domain; ask the user whether to call login again and switch context.`,
                error.exitCode,
                'site_not_available'
            );
        }
        throw error;
    }
}

function result(value: unknown) {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
        structuredContent: isRecord(value) ? value : { value }
    };
}

function purgeExpired(
    deployments: Map<string, PreparedDeployment>,
    downloads: Map<string, PreparedDownload>,
    promotions: Map<string, PreparedPromotion>
): void {
    const now = Date.now();
    for (const [id, plan] of deployments) {
        if (Date.parse(plan.finalPlan.expiresAt) <= now || Date.parse(plan.session.expiresAt) <= now) deployments.delete(id);
    }
    for (const [id, plan] of downloads) {
        if (Date.parse(plan.expiresAt) <= now) downloads.delete(id);
    }
    for (const [id, plan] of promotions) {
        if (!plan.inFlight && Date.parse(plan.expiresAt) <= now) promotions.delete(id);
    }
}

function requirePlanCapacity(
    deployments: Map<string, PreparedDeployment>,
    downloads: Map<string, PreparedDownload>,
    promotions: Map<string, PreparedPromotion>
): void {
    if (deployments.size + downloads.size + promotions.size >= MAX_PENDING_PLANS) {
        throw new CliError(`The MCP server already has ${MAX_PENDING_PLANS} pending plans; apply them or wait for expiry`, 6, 'plan_limit');
    }
}

function earliest(a: string, b: string): string {
    return Date.parse(a) <= Date.parse(b) ? a : b;
}

function numberHeader(response: Response, name: string): number | null {
    const value = response.headers.get(name);
    if (value === null) return null;
    const result = Number(value);
    return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
