import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';

import { CliError } from '../errors.js';

const SERVER_NAME = 'zynohosting';
const PACKAGE_NAME = '@zyno-io/zynohosting';

export type McpInstallAgent = 'claude' | 'codex';

export interface InstallMcpOptions {
    project?: string;
    agent?: McpInstallAgent;
    env?: NodeJS.ProcessEnv;
}

export interface InstallMcpResult {
    project: string;
    agent: McpInstallAgent;
    configured: string[];
    alreadyConfigured: string[];
}

/**
 * Add the ZynoHosting stdio server to the selected agent's project-local
 * configuration. Do not add an unused configuration file for another agent.
 */
export async function installHostingMcp(options: InstallMcpOptions = {}): Promise<InstallMcpResult> {
    const agent = resolveInstallAgent(options.agent, options.env ?? process.env);
    const requestedProject = resolve(options.project ?? '.');
    const projectInfo = await lstat(requestedProject).catch(error => {
        throw new CliError(
            `Could not access project root ${requestedProject}: ${error instanceof Error ? error.message : String(error)}`,
            2,
            'invalid_project_root'
        );
    });
    if (!projectInfo.isDirectory()) throw new CliError(`Project root is not a directory: ${requestedProject}`, 2, 'invalid_project_root');
    const project = await realpath(requestedProject);
    const installed: string[] = [];
    const alreadyConfigured: string[] = [];

    if (agent === 'claude') {
        const claudeConfig = join(project, '.mcp.json');
        if (await installClaudeConfig(claudeConfig)) installed.push(claudeConfig);
        else alreadyConfigured.push(claudeConfig);
    } else {
        const codexConfig = join(project, '.codex', 'config.toml');
        if (await installCodexConfig(codexConfig, project)) installed.push(codexConfig);
        else alreadyConfigured.push(codexConfig);
    }

    return { project, agent, configured: installed, alreadyConfigured };
}

function resolveInstallAgent(agent: McpInstallAgent | undefined, env: NodeJS.ProcessEnv): McpInstallAgent {
    if (agent === 'claude' || agent === 'codex') return agent;
    if (agent !== undefined) throw new CliError('--agent must be either codex or claude.', 2, 'invalid_mcp_agent');
    // Claude documents this marker for shell commands it starts. Codex exposes CODEX_HOME
    // when configured, but neither client guarantees a universal child-process marker, so an
    // unrecognized caller must select its target instead of causing two config-file writes.
    if (env.CLAUDECODE === '1') return 'claude';
    if (env.CODEX_HOME) return 'codex';
    throw new CliError('Choose the target agent with --agent codex or --agent claude.', 2, 'mcp_agent_required');
}

async function installClaudeConfig(path: string): Promise<boolean> {
    const existing = await readOptional(path);
    if (existing === undefined) {
        await writeText(path, `${JSON.stringify({ mcpServers: { [SERVER_NAME]: claudeServerConfig() } }, null, 2)}\n`);
        return true;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(existing);
    } catch (error) {
        throw new CliError(
            `Could not parse Claude MCP configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`,
            2,
            'invalid_mcp_config'
        );
    }
    if (!isRecord(parsed)) throw new CliError(`Claude MCP configuration at ${path} must be a JSON object`, 2, 'invalid_mcp_config');
    const servers = parsed.mcpServers;
    if (servers !== undefined && !isRecord(servers)) {
        throw new CliError(`Claude MCP configuration at ${path} has a non-object mcpServers value`, 2, 'invalid_mcp_config');
    }
    if (isRecord(servers) && SERVER_NAME in servers) return false;

    const next = { ...parsed, mcpServers: { ...(servers ?? {}), [SERVER_NAME]: claudeServerConfig() } };
    await writeText(path, `${JSON.stringify(next, null, 2)}\n`);
    return true;
}

async function installCodexConfig(path: string, project: string): Promise<boolean> {
    const existing = await readOptional(path);
    if (existing !== undefined && hasCodexServer(existing, path)) return false;

    const entry = [
        '[mcp_servers.zynohosting]',
        'command = "npx"',
        `args = ["-y", "${PACKAGE_NAME}", "mcp", "--root", ${tomlString(project)}]`,
        // Browser sign-in intentionally waits for the user to complete MFA or SSO. Codex's default MCP
        // tool timeout is shorter than that flow, so keep this project-local override beside the server.
        'tool_timeout_sec = 330'
    ].join('\n');
    const next = `${existing?.trimEnd() ? `${existing.trimEnd()}\n\n` : ''}${entry}\n`;
    // An inline parent table cannot be extended by a child header. Reparse the exact text we
    // intend to write so unusual but valid user TOML is never converted into invalid TOML.
    parseCodexConfig(next, path);
    await writeText(path, next);
    return true;
}

/**
 * Parse rather than scan TOML. Codex permits quoted and escaped keys as well
 * as multiline strings, so a line-oriented matcher can either create a
 * duplicate server or mistake documentation text for a configuration table.
 */
function hasCodexServer(toml: string, path: string): boolean {
    const parsed = parseCodexConfig(toml, path);
    const servers = parsed.mcp_servers;
    if (servers !== undefined && !isRecord(servers)) {
        throw new CliError(`Codex MCP configuration at ${path} has a non-table mcp_servers value`, 2, 'invalid_mcp_config');
    }
    return !!servers && SERVER_NAME in servers;
}

function parseCodexConfig(toml: string, path: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = parseToml(toml);
    } catch (error) {
        throw new CliError(
            `Could not parse Codex MCP configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`,
            2,
            'invalid_mcp_config'
        );
    }
    if (!isRecord(parsed)) throw new CliError(`Codex MCP configuration at ${path} must be a TOML table`, 2, 'invalid_mcp_config');
    return parsed;
}

function claudeServerConfig(): Record<string, unknown> {
    return {
        command: 'npx',
        args: ['-y', PACKAGE_NAME, 'mcp', '--root', '${CLAUDE_PROJECT_DIR:-.}']
    };
}

function tomlString(value: string): string {
    // TOML basic strings and JSON strings share the escapes used by filesystem paths.
    return JSON.stringify(value);
}

async function readOptional(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new CliError(
            `Could not read MCP configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`,
            2,
            'mcp_config_read_failed'
        );
    }
}

async function writeText(path: string, text: string): Promise<void> {
    const directory = dirname(path);
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    await mkdir(directory, { recursive: true });
    try {
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw new CliError(
            `Could not write MCP configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`,
            2,
            'mcp_config_write_failed'
        );
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
