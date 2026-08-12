#!/usr/bin/env node
/**
 * Prove the packaged MCP server actually starts and answers.
 *
 * Bundling replaces the installed dependency tree with one generated file, so
 * the failure it introduces is a module that resolved during development and is
 * missing from the bundle. That surfaces at startup, never at pack time, so a
 * green `mcpb pack` says nothing about whether the bundle works. This speaks the
 * stdio protocol to the packaged entry point and checks what comes back.
 */
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIGNATURE_HEADER = 'MCPB_SIG_V1';
const SIGNATURE_FOOTER = 'MCPB_SIG_END';
const TIMEOUT_MS = 30_000;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const staging = join(root, 'build', 'mcpb');
const packageJson = await readFile(join(root, 'package.json'), 'utf8');
const pkg = JSON.parse(packageJson);
const bundle = join(root, 'build', `zynohosting-${pkg.version}.mcpb`);

const failures = [];
const check = (condition, message) => {
    if (!condition) failures.push(message);
};

async function exists(path) {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

const manifestJson = await readFile(join(staging, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestJson);

// The entry point is the launcher; the server it falls back to must be beside it.
// A bundle missing either is one that cannot start, so check before booting.
for (const required of [manifest.server.entry_point, 'dist/embedded.js']) {
    const present = await exists(join(staging, required));
    check(present, `bundle is missing ${required}`);
}

// The staging tree is what pack zips, and it carries no node_modules, so a
// server that answers from here is a server that answers from the bundle.
const workspace = await mkdtemp(join(tmpdir(), 'mcpb-verify-'));
let response;
try {
    response = await interrogate(join(staging, 'dist', 'mcp.js'), workspace);
} finally {
    await rm(workspace, { recursive: true, force: true });
}

check(response.initialize !== undefined, 'server did not answer initialize');
check(
    response.initialize?.serverInfo?.version === pkg.version,
    `server reported version ${response.initialize?.serverInfo?.version}, expected ${pkg.version}`
);
check(typeof response.initialize?.instructions === 'string', 'server sent no instructions');

const served = (response.tools ?? []).map(tool => tool.name);
const declared = (manifest.tools ?? []).map(tool => tool.name);
check(served.length > 0, 'server listed no tools');
for (const name of declared.filter(name => !served.includes(name))) check(false, `manifest declares ${name}, server does not serve it`);
for (const name of served.filter(name => !declared.includes(name))) check(false, `server serves ${name}, manifest does not declare it`);
for (const tool of response.tools ?? []) {
    // Hosts surface these in their permission UI, and the connector directory
    // requires them, so a tool that loses its annotations is a regression.
    check(tool.annotations !== undefined, `${tool.name} is missing tool annotations`);
}

const packed = await stat(bundle).catch(() => undefined);
check(packed !== undefined, `no bundle at ${bundle}`);
if (packed) {
    const contents = await readFile(bundle);
    const header = contents.lastIndexOf(Buffer.from(SIGNATURE_HEADER, 'utf-8'));
    if (header === -1) {
        process.stdout.write('Bundle is unsigned.\n');
    } else {
        const length = contents.readUInt32LE(header + SIGNATURE_HEADER.length);
        const end = header + SIGNATURE_HEADER.length + 4 + length;
        check(
            contents.subarray(end, end + SIGNATURE_FOOTER.length).toString('utf-8') === SIGNATURE_FOOTER,
            'signature block is truncated or malformed'
        );

        // Claude Desktop rejects a bundle whose trailing bytes are not declared
        // as the archive comment. The build reserves this length before signing,
        // so the signature covers the final EOCD as well as the archive content.
        const blockLength = contents.length - header;
        let eocd = -1;
        for (let offset = header - 22; offset >= 0; offset--) {
            if (contents.readUInt32LE(offset) === 0x06054b50) {
                eocd = offset;
                break;
            }
        }
        check(eocd !== -1, 'signed bundle has no end of central directory record');
        if (eocd !== -1) {
            const declared = contents.readUInt16LE(eocd + 20);
            check(declared === blockLength, `archive comment length is ${declared}, expected ${blockLength}; Claude Desktop will refuse this bundle`);
        }
        process.stdout.write(`Bundle carries a ${length}-byte signature declared as a ${blockLength}-byte archive comment.\n`);
    }
}

// Exercise the update path against the real launcher and the real key: stage a
// runtime, prove it is preferred, then corrupt it and prove the embedded copy
// takes over. Only possible where the signing key is present, which is exactly
// where it matters — the release build.
// Resolve exactly as build-mcpb.mjs does. Reading a different key would sign the
// probe with something the launcher was never built to trust, and an unsigned
// build would fail this check rather than skip it.
const signingDirectory = process.env.MCPB_SIGN_DIR ?? join(homedir(), '.config', 'zynohosting', 'signing');
const signingKey = process.env.MCPB_SIGN_KEY ?? join(signingDirectory, 'mcpb-key.pem');
const signingKeyExists = await exists(signingKey);
if (signingKeyExists) {
    const area = await mkdtemp(join(tmpdir(), 'mcpb-staged-'));
    try {
        const runtimeDirectory = join(area, 'staging', 'versions', '99.0.0', 'dist');
        await mkdir(runtimeDirectory, { recursive: true });
        const marker = Buffer.from('process.stderr.write("STAGED_RUNTIME_RAN\\n");\n');
        await writeFile(join(runtimeDirectory, 'server.js'), marker);
        // A release signs the version bound to the payload digest, not the bytes
        // alone, so the probe has to present the same statement.
        const statement = Buffer.from(`zynohosting-mcpb/1\n99.0.0\n${createHash('sha256').update(marker).digest('hex')}\n`, 'utf8');
        const signingKeyContents = await readFile(signingKey);
        const signature = sign('sha256', statement, createPrivateKey(signingKeyContents));
        await writeFile(join(runtimeDirectory, 'server.js.sig'), signature);
        await writeFile(
            join(area, 'staging', 'versions', '99.0.0', 'package.json'),
            `${JSON.stringify({ name: pkg.name, version: '99.0.0', private: true, type: 'module' }, null, 2)}\n`
        );

        const staged = await runLauncher(join(area, 'staging'));
        check(staged.includes('STAGED_RUNTIME_RAN'), 'a signed staged runtime should have been preferred over the embedded one');

        // The production payload is imported through a data URL so the verified
        // bytes cannot be swapped before execution. Exercise the actual bundled
        // server here: its imports, createRequire shim, and embedded version all
        // need to work without a neighboring file URL.
        const packagedRuntime = await readFile(join(staging, 'dist', 'embedded.js'));
        const packagedStatement = Buffer.from(`zynohosting-mcpb/1\n99.0.0\n${createHash('sha256').update(packagedRuntime).digest('hex')}\n`, 'utf8');
        const packagedSignature = sign('sha256', packagedStatement, createPrivateKey(signingKeyContents));
        await writeFile(join(runtimeDirectory, 'server.js'), packagedRuntime);
        await writeFile(join(runtimeDirectory, 'server.js.sig'), packagedSignature);
        const stagedServer = await interrogate(join(staging, 'dist', 'mcp.js'), area, join(area, 'staging'));
        check(stagedServer.initialize !== undefined, 'the real staged server did not start from its verified bytes');

        // Now tamper with it. The signature is re-checked on every launch, so the
        // launcher must reject it and fall back rather than execute it.
        await writeFile(join(runtimeDirectory, 'server.js'), 'process.stderr.write("TAMPERED_RAN\\n");\n');
        const tampered = await runLauncher(join(area, 'staging'));
        check(!tampered.includes('TAMPERED_RAN'), 'a tampered staged runtime must never be executed');
        check(/ignoring staged runtime/.test(tampered), 'the launcher should report why it ignored the staged runtime');
        process.stdout.write('Update path verified: signed runtime preferred, tampered runtime rejected.\n');
    } finally {
        await rm(area, { recursive: true, force: true });
    }
}

if (failures.length) {
    process.stderr.write(`${failures.map(failure => `  - ${failure}`).join('\n')}\n`);
    process.stderr.write(`\nBundle verification failed with ${failures.length} problem(s).\n`);
    process.exit(1);
}

process.stdout.write(`Bundle verified: ${served.length} tools, version ${pkg.version}.\n`);

/** Speak just enough of the protocol to see whether the server is alive. */
function interrogate(entryPoint, workspace, stagingDirectory = join(workspace, 'staging')) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [entryPoint, '--root', workspace], {
            stdio: ['pipe', 'pipe', 'pipe'],
            // The entry point is the self-updating launcher. Verification must
            // exercise the launcher, but must not reach the network to do it.
            env: { ...process.env, ZYNOHOSTING_DISABLE_UPDATE: '1', ZYNOHOSTING_MCPB_STAGING: stagingDirectory }
        });
        const result = {};
        let stdout = '';
        let stderr = '';

        const finish = error => {
            clearTimeout(timer);
            child.kill('SIGKILL');
            if (error) reject(error);
            else resolve(result);
        };
        const timer = setTimeout(() => finish(new Error(`server did not respond within ${TIMEOUT_MS}ms. stderr:\n${stderr}`)), TIMEOUT_MS);

        child.on('error', finish);
        child.stderr.on('data', chunk => (stderr += chunk));
        child.stdout.on('data', chunk => {
            stdout += chunk;
            const lines = stdout.split('\n');
            stdout = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) continue;
                let message;
                try {
                    message = JSON.parse(line);
                } catch {
                    continue;
                }
                if (message.error) return finish(new Error(`server returned an error: ${JSON.stringify(message.error)}`));
                if (message.id === 1) {
                    result.initialize = message.result;
                    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
                    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
                } else if (message.id === 2) {
                    result.tools = message.result?.tools ?? [];
                    finish();
                }
            }
        });
        child.on('exit', code => {
            if (result.tools === undefined) finish(new Error(`server exited with code ${code} before listing tools. stderr:\n${stderr}`));
        });

        send(child, {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-mcpb', version: pkg.version } }
        });
    });
}

function send(child, message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
}

/** Boot the launcher against a staging directory and collect its stderr. */
function runLauncher(stagingDirectory) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [join(staging, 'dist', 'mcp.js'), '--root', tmpdir()], {
            stdio: ['pipe', 'ignore', 'pipe'],
            env: { ...process.env, ZYNOHOSTING_DISABLE_UPDATE: '1', ZYNOHOSTING_MCPB_STAGING: stagingDirectory }
        });
        let stderr = '';
        child.stderr.on('data', chunk => {
            stderr += chunk;
            if (stderr.includes('ignoring staged runtime')) child.kill('SIGKILL');
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
        child.on('exit', () => {
            clearTimeout(timer);
            resolve(stderr);
        });
        child.on('error', () => {
            clearTimeout(timer);
            resolve(stderr);
        });
    });
}
