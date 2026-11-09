import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createProgram } from '../src/cli.js';

test('reports the version from the package manifest', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(createProgram().version(), packageJson.version);
});

test('advertises the Suite API override used by MCP form tools', () => {
    assert.match(createProgram().helpInformation(), /--suite-api-url <url>/);
    assert.match(createProgram().helpInformation(), /--auth-api-url <url>/);
});

test('advertises scoped browser-login and revocation commands', () => {
    const program = createProgram();
    const login = program.commands.find(command => command.name() === 'login');
    assert(login);
    assert.match(login.helpInformation(), /--permission <key>/);
    assert.match(login.helpInformation(), /--renewable/);
    const logout = program.commands.find(command => command.name() === 'logout');
    assert(logout);
    assert.match(logout.helpInformation(), /--auth-api-url <url>/);
});

test('advertises project-local MCP installation', () => {
    const mcp = createProgram().commands.find(command => command.name() === 'mcp');
    assert(mcp);
    const install = mcp.commands.find(command => command.name() === 'install');
    assert(install);
    assert.match(install.helpInformation(), /--project <path>/);
    assert.match(install.helpInformation(), /--agent <agent>/);
});

test('advertises preview uploads and explicit promotion with planning options', () => {
    const program = createProgram();
    const deploy = program.commands.find(command => command.name() === 'deploy');
    assert(deploy);
    assert.match(deploy.helpInformation(), /--preview/);
    const promote = program.commands.find(command => command.name() === 'promote');
    assert(promote);
    assert.match(promote.helpInformation(), /--dry-run/);
    assert.match(promote.helpInformation(), /--yes/);
});
