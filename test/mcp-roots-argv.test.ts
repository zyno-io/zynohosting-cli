import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Run the TypeScript entry point rather than dist/. `yarn test` runs before
// `yarn build` in both pipelines, so a fresh clone has no dist/, and locally a
// stale dist/ would let this pass against code no longer in src/.
const runner = join(root, 'node_modules', '.bin', 'tsx');
const entryPoint = join(root, 'src', 'mcp.ts');

/**
 * Start the built server and report what it did. The desktop bundle passes
 * folders as bare arguments, because the host expands a directory list into
 * argv with no flag between the values.
 */
function start(args: string[]): Promise<{ code: number | null; stderr: string; initialized: boolean }> {
    return new Promise(resolve => {
        const child = spawn(runner, [entryPoint, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        let stdout = '';
        let initialized = false;
        const done = () => {
            clearTimeout(timer);
            child.kill('SIGKILL');
            resolve({ code: child.exitCode, stderr, initialized });
        };
        const timer = setTimeout(done, 15_000);

        child.stderr.on('data', chunk => (stderr += chunk));
        child.stdout.on('data', chunk => {
            stdout += chunk;
            if (stdout.includes('serverInfo')) {
                initialized = true;
                done();
            }
        });
        child.on('exit', () => setTimeout(done, 50));
        child.stdin.write(
            `${JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'roots-test', version: '1.0.0' } }
            })}\n`
        );
    });
}

test('accepts website folders as bare arguments', async () => {
    const first = await mkdtemp(join(tmpdir(), 'zynohosting-root-a-'));
    const second = await mkdtemp(join(tmpdir(), 'zynohosting-root-b-'));
    const result = await start([first, second]);
    assert.equal(result.initialized, true, `server should have started with two positional roots. stderr:\n${result.stderr}`);
});

test('accepts the flag form and bare arguments together', async () => {
    const flagged = await mkdtemp(join(tmpdir(), 'zynohosting-root-c-'));
    const positional = await mkdtemp(join(tmpdir(), 'zynohosting-root-d-'));
    const result = await start(['--root', flagged, positional]);
    assert.equal(result.initialized, true, `both forms should combine. stderr:\n${result.stderr}`);
});

test('a bare argument is enforced as a real root, not ignored', async () => {
    // A path that does not exist must be rejected. If positional arguments were
    // being dropped, this would start cleanly and the containment boundary would
    // silently not exist.
    const missing = join(tmpdir(), 'zynohosting-root-does-not-exist-9f3a2b');
    const result = await start([missing]);
    assert.equal(result.initialized, false, 'a nonexistent root must not be accepted');
    assert.match(result.stderr, /ZynoHosting MCP error/, `expected a startup error. stderr:\n${result.stderr}`);
});

test('still starts with no roots at all', async () => {
    // The npm and Claude Code paths run unrestricted when no root is given, and
    // that behaviour must survive the positional form being added.
    const result = await start([]);
    assert.equal(result.initialized, true, `server should start unrestricted. stderr:\n${result.stderr}`);
});
