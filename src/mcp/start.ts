import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { delimiter } from 'node:path';

import type { ConfigOverrides } from '../config.js';

import { AllowedLocalRoots } from './local-paths.js';
import { createHostingMcpServer, McpServerOptions } from './server.js';

export interface StartMcpOptions extends ConfigOverrides {
    roots?: string[];
    version: string;
    env?: NodeJS.ProcessEnv;
}

export async function startHostingMcp(options: StartMcpOptions): Promise<void> {
    const serverOptions = await resolveMcpServerOptions(options);
    const server = await createHostingMcpServer(serverOptions);
    await server.connect(new StdioServerTransport());
}

export async function resolveMcpServerOptions(options: StartMcpOptions): Promise<McpServerOptions> {
    const env = options.env ?? process.env;
    const envRoots = env.ZYNO_HOSTING_MCP_ROOTS?.split(delimiter).filter(Boolean) ?? [];
    const roots = await AllowedLocalRoots.create([...(options.roots ?? []), ...envRoots]);
    return {
        roots,
        version: options.version,
        ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
        ...(options.suiteApiUrl ? { suiteApiUrl: options.suiteApiUrl } : {}),
        ...(options.authApiUrl ? { authApiUrl: options.authApiUrl } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.environment ? { environment: options.environment } : {}),
        env
    };
}
