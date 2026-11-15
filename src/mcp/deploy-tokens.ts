import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { ManagerClient } from '../api/manager-client.js';
import type { ResolvedConfig } from '../config.js';

import { KeyRequestClient } from '../api/key-request-client.js';
import { normalizeSiteRef } from '../commands/deploy-site.js';
import { assertTokenAllowedForSite } from '../deploy-tokens/guard.js';
import { CliError } from '../errors.js';

export interface DeployTokenMcpClients {
    config: ResolvedConfig;
    manager: ManagerClient;
}

interface PendingRequest {
    /** Stays in this process. The model only ever sees `requestId`. */
    requestCode: string;
    authApiUrl: string;
    site: string;
    environments: string[];
    expiresAt: number;
}

const MAX_PENDING = 16;
const KEY_SHAPE = /zck_[A-Za-z0-9_-]{20,}/;

/** The last line of defense: a value that looks like a deploy token is never returned to the model. */
function safeResult(value: Record<string, unknown>) {
    const text = JSON.stringify(value, null, 2);
    if (KEY_SHAPE.test(text)) throw new CliError('Refusing to return a value that looks like a deploy token.', 1, 'secret_in_output');
    return { content: [{ type: 'text' as const, text }], structuredContent: value };
}

const iso = (value: number | undefined): string | undefined =>
    value === undefined || !Number.isFinite(value) ? undefined : new Date(value).toISOString();

/**
 * Deploy token tools. A token is requested with display delivery only: the person approves in ZynoSuite, sees the token
 * once on that page, and puts it into their CI settings themselves. These tools never receive it, so they cannot return it.
 */
export function registerDeployTokensMcp(server: McpServer, getClients: () => Promise<DeployTokenMcpClients>): void {
    const pending = new Map<string, PendingRequest>();

    server.registerTool(
        'request_deploy_token',
        {
            title: 'Request a deploy token for CI',
            description: [
                'Start a request for a deploy token: a key that lets CI deploy ONE site and do nothing else. Use this whenever the user wants automated or CI deployment (GitHub Actions, GitLab CI). Never create or use a tenant API key for CI, and never ask the user to paste a token into this chat.',
                'Returns an approval link and a short code. Give both to the user verbatim. They open the link, check that the code, site and environments match, choose how long the token lasts, and approve. The page then shows the token ONCE for them to copy into their CI secret settings (GitHub: Settings, Secrets and variables, Actions, secret ZYNOHOSTING_DEPLOY_TOKEN; GitLab: Settings, CI/CD, Variables, masked). This tool never receives the token and cannot show it to you.',
                'Ask the user which environments the token may deploy to. "production" deploys to the live site; "preview" deploys to the preview slot; promoting preview to production needs both. A token that includes production can also change the site runtime and not-found handling. Pick the narrowest set that fits.',
                'Then call deploy_token_status with the returned requestId until it reports approved. Never open the link or approve it yourself. The approving user needs the hosting.deploy permission.'
            ].join('\n\n'),
            inputSchema: {
                site: z.string().min(1).describe('Site hostname or ID the user named. Do not guess it.'),
                environments: z
                    .array(z.enum(['production', 'preview']))
                    .min(1)
                    .max(2)
                    .describe('Environments the token may deploy to.'),
                lifetimeDays: z
                    .union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)])
                    .optional()
                    .describe('Suggested lifetime in days; the user chooses when approving. Default 90.'),
                ci: z
                    .enum(['github', 'gitlab', 'other'])
                    .optional()
                    .describe('Where the token will be used, so the approval page shows the right instructions.')
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
        },
        async ({ site, environments, lifetimeDays, ci }) => {
            const { config, manager } = await getClients();
            if (!config.authApiUrl) {
                throw new CliError(
                    'The ZynoAuth API URL is required. Set ZYNO_AUTH_API_URL or pass --auth-api-url to the MCP server.',
                    2,
                    'missing_auth_api_url'
                );
            }
            for (const [id, entry] of pending) if (entry.expiresAt <= Date.now()) pending.delete(id);
            if (pending.size >= MAX_PENDING) throw new CliError('Too many deploy token requests are waiting for approval.', 6, 'too_many_requests');
            const found = await manager.getSite(normalizeSiteRef(site));
            if (found.status !== 'active') throw new CliError('Only an active site can have a deploy token', 2, 'site_inactive');
            const unique = [...new Set(environments)].sort() as Array<'production' | 'preview'>;
            assertTokenAllowedForSite(found, unique);
            const client = new KeyRequestClient(config.authApiUrl);
            const start = await client.start(config.credential, {
                siteId: found.id,
                environments: unique,
                description: `ZynoHosting MCP: deploy token for ${found.fqdn}`.slice(0, 255),
                ...(lifetimeDays === undefined ? {} : { requestedLifetimeSecs: lifetimeDays * 86_400 }),
                delivery: 'display',
                handoff: { kind: ci === 'github' ? 'github-secret' : ci === 'gitlab' ? 'gitlab-variable' : 'manual' }
            });
            const requestId = randomUUID();
            pending.set(requestId, {
                requestCode: start.requestCode,
                authApiUrl: config.authApiUrl,
                site: found.fqdn,
                environments: unique,
                expiresAt: start.expiresAt
            });
            return safeResult({
                requestId,
                status: 'pending',
                site: found.fqdn,
                environments: unique,
                verificationUri: start.verificationUri,
                ...(start.verificationUriComplete ? { verificationUriComplete: start.verificationUriComplete } : {}),
                userCode: start.userCode,
                expiresAt: new Date(start.expiresAt).toISOString(),
                message: `Give the user the link (${start.verificationUriComplete ?? start.verificationUri}) and the code ${start.userCode} verbatim. They open it, check the code, site (${found.fqdn}) and environments (${unique.join(' and ')}), pick a lifetime and approve. The page then shows the deploy token once; they copy it into their CI secret settings themselves. You will never see the token. Do not open the link or approve it yourself. Call deploy_token_status with requestId ${requestId} until it reports approved.`
            });
        }
    );

    server.registerTool(
        'deploy_token_status',
        {
            title: 'Check a deploy token request',
            description:
                'Check whether the user approved a request_deploy_token request. Reports pending, approved (with the token id, expiry and a short preview, never the token), denied, or expired. Call it after the user says they approved, or every few seconds while waiting. This changes nothing.',
            inputSchema: { requestId: z.string().min(1).describe('The requestId returned by request_deploy_token.') },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ requestId }) => {
            const entry = pending.get(requestId);
            if (!entry)
                throw new CliError('This deploy token request is unknown or has expired; call request_deploy_token again.', 6, 'unknown_request');
            const poll = await new KeyRequestClient(entry.authApiUrl).poll(entry.requestCode, 'display');
            const base = { requestId, site: entry.site, environments: entry.environments };
            if (poll.status === 'pending' || poll.status === 'slow_down') {
                return safeResult({
                    ...base,
                    status: 'pending',
                    message:
                        'Still waiting for the user to approve. Give them the link and code again if needed, and wait a few seconds before checking again.'
                });
            }
            if (poll.status === 'approved') {
                return safeResult({
                    ...base,
                    status: 'approved',
                    keyId: poll.key.id,
                    preview: poll.key.preview,
                    expiresAt: iso(poll.key.expiresAt),
                    message:
                        'Approved. The token was shown to the user once on the approval page, and they put it into their CI settings. Remind them it can deploy only this site, and that they can revoke it any time (list_deploy_tokens, revoke_deploy_token). Do not ask them to send you the token.'
                });
            }
            pending.delete(requestId);
            return safeResult({
                ...base,
                status: poll.status,
                message:
                    poll.status === 'denied'
                        ? 'The user denied the request. Do not retry unless they ask.'
                        : 'The request expired or was cancelled. Call request_deploy_token again if the user still wants a token.'
            });
        }
    );

    server.registerTool(
        'list_deploy_tokens',
        {
            title: 'List deploy tokens',
            description:
                'List deploy tokens for one site or all sites: id, short preview, environments, who approved it, when it expires and was last used. Never includes the token itself. Requires hosting.sitesRead.',
            inputSchema: { site: z.string().min(1).optional().describe('Site hostname or ID. Omit to list every site.') },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ site }) => {
            const { config, manager } = await getClients();
            if (!config.authApiUrl) throw new CliError('The ZynoAuth API URL is required.', 2, 'missing_auth_api_url');
            const siteId = site ? (await manager.getSite(normalizeSiteRef(site))).id : undefined;
            const keys = await new KeyRequestClient(config.authApiUrl).list(config.credential, { siteId });
            return safeResult({
                tokens: keys.map(key => ({
                    ...key,
                    createdAt: iso(key.createdAt),
                    expiresAt: iso(key.expiresAt),
                    lastUsedAt: iso(key.lastUsedAt)
                }))
            });
        }
    );

    server.registerTool(
        'revoke_deploy_token',
        {
            title: 'Revoke a deploy token',
            description:
                'Revoke a deploy token by its id from list_deploy_tokens. CI that uses it stops deploying at once (a deployment already running can finish for up to 20 minutes). Ask the user first. Idempotent. Requires hosting.deploy.',
            inputSchema: { keyId: z.string().min(1).max(100) },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
        },
        async ({ keyId }) => {
            const { config } = await getClients();
            if (!config.authApiUrl) throw new CliError('The ZynoAuth API URL is required.', 2, 'missing_auth_api_url');
            await new KeyRequestClient(config.authApiUrl).revoke(config.credential, keyId);
            return safeResult({ keyId, status: 'revoked' });
        }
    );
}
