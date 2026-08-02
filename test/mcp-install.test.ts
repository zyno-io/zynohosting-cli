import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { installHostingMcp } from '../src/mcp/install.js';

test('installs project-local Claude and Codex MCP configuration without secrets', async () => {
    const project = await mkdtemp(join(tmpdir(), 'zynohosting-mcp-install-'));
    await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { existing: { command: 'example-mcp', args: ['serve'] } } }, null, 2));

    const installed = await installHostingMcp({ project });
    assert.deepEqual(installed.configured.sort(), [join(installed.project, '.codex', 'config.toml'), join(installed.project, '.mcp.json')].sort());
    assert.deepEqual(installed.alreadyConfigured, []);

    const claude = JSON.parse(await readFile(join(project, '.mcp.json'), 'utf8')) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
    };
    assert.deepEqual(claude.mcpServers.existing, { command: 'example-mcp', args: ['serve'] });
    assert.deepEqual(claude.mcpServers.zynohosting, {
        command: 'npx',
        args: ['-y', '@zyno-io/zynohosting', 'mcp', '--root', '${CLAUDE_PROJECT_DIR:-.}']
    });
    assert.doesNotMatch(JSON.stringify(claude), /api.?key|access.?token/i);

    const codex = await readFile(join(project, '.codex', 'config.toml'), 'utf8');
    assert.match(codex, /^\[mcp_servers\.zynohosting\]$/m);
    assert.match(codex, /command = "npx"/);
    assert.match(codex, new RegExp(JSON.stringify(installed.project).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(codex, /tool_timeout_sec = 330/);
    assert.doesNotMatch(codex, /api.?key|access.?token/i);
});

test('does not overwrite an existing ZynoHosting entry', async () => {
    const project = await mkdtemp(join(tmpdir(), 'zynohosting-mcp-install-existing-'));
    await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { zynohosting: { command: 'custom-zyno-mcp' } } }, null, 2));
    await mkdir(join(project, '.codex'));
    await writeFile(join(project, '.codex', 'config.toml'), '[mcp_servers.zynohosting]\ncommand = "custom-zyno-mcp"\n');

    const installed = await installHostingMcp({ project });
    assert.deepEqual(installed.configured, []);
    assert.deepEqual(
        installed.alreadyConfigured.sort(),
        [join(installed.project, '.codex', 'config.toml'), join(installed.project, '.mcp.json')].sort()
    );
    assert.match(await readFile(join(project, '.mcp.json'), 'utf8'), /custom-zyno-mcp/);
    assert.match(await readFile(join(project, '.codex', 'config.toml'), 'utf8'), /custom-zyno-mcp/);
});

test('recognizes structurally equivalent Codex server configuration', async () => {
    for (const existingConfig of [
        '[mcp_servers."zynohosting"]\ncommand = "custom-zyno-mcp"\n',
        '[mcp_servers]\nzynohosting = { command = "custom-zyno-mcp" }\n',
        '[mcp_servers.zynohosting.env]\nCUSTOM_SETTING = "value"\n',
        '[mcp_servers."zynohost\\u0069ng"]\ncommand = "custom-zyno-mcp"\n'
    ]) {
        const project = await mkdtemp(join(tmpdir(), 'zynohosting-mcp-install-toml-'));
        await mkdir(join(project, '.codex'));
        await writeFile(join(project, '.codex', 'config.toml'), existingConfig);

        const installed = await installHostingMcp({ project });
        assert.deepEqual(installed.configured, [join(installed.project, '.mcp.json')]);
        assert.deepEqual(installed.alreadyConfigured, [join(installed.project, '.codex', 'config.toml')]);
        assert.equal(await readFile(join(project, '.codex', 'config.toml'), 'utf8'), existingConfig);
    }
});

test('does not mistake a multiline TOML string for an existing Codex server', async () => {
    const project = await mkdtemp(join(tmpdir(), 'zynohosting-mcp-install-multiline-'));
    await mkdir(join(project, '.codex'));
    const existingConfig = 'notes = """\n[mcp_servers.zynohosting]\n"""\n';
    await writeFile(join(project, '.codex', 'config.toml'), existingConfig);

    const installed = await installHostingMcp({ project });
    assert.deepEqual(installed.configured.sort(), [join(installed.project, '.codex', 'config.toml'), join(installed.project, '.mcp.json')].sort());
    assert.match(await readFile(join(project, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.zynohosting\]/);
});

test('does not invalidate an inline Codex mcp_servers table', async () => {
    const project = await mkdtemp(join(tmpdir(), 'zynohosting-mcp-install-inline-parent-'));
    await mkdir(join(project, '.codex'));
    const existingConfig = 'mcp_servers = { existing = { command = "example-mcp" } }\n';
    const configPath = join(project, '.codex', 'config.toml');
    await writeFile(configPath, existingConfig);

    await assert.rejects(installHostingMcp({ project }), /Could not parse Codex MCP configuration/);
    assert.equal(await readFile(configPath, 'utf8'), existingConfig);
});
