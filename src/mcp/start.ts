import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { delimiter } from 'node:path';

import { ConfigOverrides } from '../config.js';
import { AllowedLocalRoots } from './local-paths.js';
import { createHostingMcpServer } from './server.js';

export interface StartMcpOptions extends ConfigOverrides {
    roots?: string[];
    version: string;
    env?: NodeJS.ProcessEnv;
}

export async function startHostingMcp(options: StartMcpOptions): Promise<void> {
    const env = options.env ?? process.env;
    const envRoots = env.ZYNO_HOSTING_MCP_ROOTS?.split(delimiter).filter(Boolean) ?? [];
    const roots = await AllowedLocalRoots.create([...(options.roots ?? []), ...envRoots]);
    const server = await createHostingMcpServer({
        roots,
        version: options.version,
        ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.environment ? { environment: options.environment } : {})
    });
    await server.connect(new StdioServerTransport());
}
