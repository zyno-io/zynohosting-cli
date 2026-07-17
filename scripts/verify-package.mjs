import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
assert.deepEqual(
    packageJson.bin,
    { zynohosting: 'dist/index.js', 'zynohosting-mcp': 'dist/mcp.js' },
    'package must expose the CLI and MCP executables'
);

for (const name of ['zynohosting', 'zynohosting-mcp']) {
    const executable = new URL(packageJson.bin[name], root);
    await access(executable, constants.R_OK | constants.X_OK);
    assert.match(await readFile(executable, 'utf8'), /^#!\/usr\/bin\/env node\n/, `${name} must start with the Node shebang`);
}

assert.equal(packageJson.publishConfig?.access, 'public');
assert.equal(packageJson.publishConfig?.registry, 'https://registry.npmjs.org/');
assert.equal(packageJson.mcpName, 'io.github.zyno-io/zynohosting');

const server = JSON.parse(await readFile(new URL('server.json', root), 'utf8'));
assert.equal(server.name, packageJson.mcpName, 'server.json name must match package.json mcpName');
assert.equal(server.version, packageJson.version, 'server.json version must match package.json');
assert.equal(server.packages?.[0]?.identifier, packageJson.name, 'server.json package identifier must match package.json');
assert.equal(server.packages?.[0]?.version, packageJson.version, 'server.json package version must match package.json');
