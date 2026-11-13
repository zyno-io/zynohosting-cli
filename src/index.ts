#!/usr/bin/env node

// This file imports nothing and uses no top-level await before the check, so an old Node reports a clear error here
// instead of failing on syntax or APIs in the rest of the CLI, which lives in main.js. Keep src/runtime.ts in step.
const major = Number(process.versions.node.split('.')[0]);
if (!(major >= 24)) {
    const message = `ZynoHosting needs Node.js 24 or newer, but this is Node.js ${process.versions.node}. Install Node.js 24 from https://nodejs.org/ and try again.`;
    process.stderr.write(
        process.argv.includes('--json') ? `${JSON.stringify({ type: 'error', code: 'unsupported_node', message })}\n` : `Error: ${message}\n`
    );
    process.exitCode = 1;
} else {
    await import('./main.js');
}
