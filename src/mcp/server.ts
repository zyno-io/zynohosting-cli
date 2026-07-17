import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';

import { ManagerClient } from '../api/manager-client.js';
import { applyPreparedDeployment, prepareDeployment, PreparedDeployment } from '../commands/deploy-site.js';
import { applyDownload, prepareDownload, PreparedDownload } from '../commands/download-site.js';
import { createFileClient, purgeSiteCacheAfterMutation, writeResponseAtomically } from '../commands/files.js';
import { ConfigOverrides, resolveConfig } from '../config.js';
import { CliError } from '../errors.js';
import { AllowedLocalRoots } from './local-paths.js';

export interface McpServerOptions extends ConfigOverrides {
    roots: AllowedLocalRoots;
    version: string;
}

const MAX_PENDING_PLANS = 16;

export async function createHostingMcpServer(options: McpServerOptions): Promise<McpServer> {
    const config = await resolveConfig(options);
    const manager = new ManagerClient(config.apiUrl, config.credential);
    const deployments = new Map<string, PreparedDeployment>();
    const downloads = new Map<string, PreparedDownload>();
    const server = new McpServer({ name: 'io.github.zyno-io/zynohosting', version: options.version }, { capabilities: { logging: {} } });

    server.registerTool(
        'list_sites',
        {
            title: 'List authorized ZynoHosting sites',
            description: 'List sites the current credential is authorized to inspect.',
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async () => result(await manager.listSites())
    );

    server.registerTool(
        'get_site',
        {
            title: 'Get a ZynoHosting site',
            description: 'Get one authorized site by UUID or hostname.',
            inputSchema: { site: z.string().min(1) },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ site }) => result(await manager.getSite(site))
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
            const { client } = await createFileClient(site, ['files:list'], options);
            return result(await client.list(path, recursive));
        }
    );

    server.registerTool(
        'get_file',
        {
            title: 'Download one hosted file',
            description: 'Download one regular hosted file into an allowed local root.',
            inputSchema: {
                site: z.string().min(1),
                remote_path: z.string().min(1),
                local_path: z.string().min(1).describe('Absolute path inside an allowed MCP local root'),
                overwrite: z.boolean().default(false)
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async ({ site, remote_path, local_path, overwrite }) => {
            const destination = await options.roots.destination(local_path);
            const { client } = await createFileClient(site, ['files:read'], options);
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
            description: 'Create or replace one regular hosted file from an allowed local source.',
            inputSchema: {
                site: z.string().min(1),
                local_path: z.string().min(1).describe('Absolute source path inside an allowed MCP local root'),
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
            const files = await createFileClient(site, ['files:write'], options);
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
            const files = await createFileClient(site, ['files:delete'], options);
            const deleted = await files.client.delete(remote_path, etag);
            await purgeSiteCacheAfterMutation(files.manager, files.siteId, deleted);
            return result(deleted);
        }
    );

    server.registerTool(
        'plan_deploy',
        {
            title: 'Plan a full site deployment',
            description: 'Build and store an exact deployment plan. This does not change the hosted site.',
            inputSchema: {
                site: z.string().min(1),
                local_root: z.string().min(1).describe('Absolute directory inside an allowed MCP local root'),
                ignore: z.array(z.string()).default([]),
                ignore_file: z.string().optional(),
                allow_empty: z.boolean().default(false)
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ site, local_root, ignore, ignore_file, allow_empty }) => {
            purgeExpired(deployments, downloads);
            requirePlanCapacity(deployments, downloads);
            const source = await options.roots.existing(local_root);
            const info = await lstat(source);
            if (!info.isDirectory() || info.isSymbolicLink()) throw new CliError('Deployment source is not a regular directory', 2, 'invalid_source');
            const plan = await prepareDeployment(site, source, {
                ...options,
                yes: true,
                allowEmpty: allow_empty,
                ...(ignore.length ? { ignore } : {}),
                ...(ignore_file ? { ignoreFile: await options.roots.existing(ignore_file) } : {})
            });
            deployments.set(plan.finalPlan.planId, plan);
            return result({
                planId: plan.finalPlan.planId,
                site: plan.fqdn,
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
            purgeExpired(deployments, downloads);
            const plan = deployments.get(plan_id);
            if (!plan) throw new CliError('Deployment plan is unknown or expired; create a new plan', 6, 'plan_expired');
            const applied = await applyPreparedDeployment(plan);
            deployments.delete(plan_id);
            return result(applied);
        }
    );

    server.registerTool(
        'plan_download',
        {
            title: 'Plan a complete site download',
            description: 'Authorize a deployable-only or sensitive full snapshot into an allowed local destination.',
            inputSchema: {
                site: z.string().min(1),
                local_root: z.string().min(1).describe('Absolute new or empty directory inside an allowed MCP local root'),
                include_sensitive: z.boolean().default(false)
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ site, local_root, include_sensitive }) => {
            purgeExpired(deployments, downloads);
            requirePlanCapacity(deployments, downloads);
            const target = await options.roots.destination(local_root);
            const plan = await prepareDownload(site, target, { ...options, sensitive: include_sensitive, yes: true });
            downloads.set(plan.planId, plan);
            return result({
                planId: plan.planId,
                site,
                target: plan.target,
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
            purgeExpired(deployments, downloads);
            const plan = downloads.get(plan_id);
            if (!plan) throw new CliError('Download plan is unknown or expired; create a new plan', 6, 'plan_expired');
            const downloaded = await applyDownload(plan);
            downloads.delete(plan_id);
            return result(downloaded);
        }
    );

    return server;
}

function result(value: unknown) {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
        structuredContent: isRecord(value) ? value : { value }
    };
}

function purgeExpired(deployments: Map<string, PreparedDeployment>, downloads: Map<string, PreparedDownload>): void {
    const now = Date.now();
    for (const [id, plan] of deployments) {
        if (Date.parse(plan.finalPlan.expiresAt) <= now || Date.parse(plan.session.expiresAt) <= now) deployments.delete(id);
    }
    for (const [id, plan] of downloads) {
        if (Date.parse(plan.expiresAt) <= now) downloads.delete(id);
    }
}

function requirePlanCapacity(deployments: Map<string, PreparedDeployment>, downloads: Map<string, PreparedDownload>): void {
    if (deployments.size + downloads.size >= MAX_PENDING_PLANS) {
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
