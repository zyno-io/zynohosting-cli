import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { request, requestStream } from '../src/api/http.js';
import { configureUserAgent, resolveDistribution, userAgent } from '../src/api/user-agent.js';

async function withServer(run: (baseUrl: string, seen: string[]) => Promise<void>) {
    const seen: string[] = [];
    const server = createServer((incoming, response) => {
        seen.push(incoming.headers['user-agent'] ?? '(none)');
        response.setHeader('Content-Type', 'application/json');
        response.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
        await run(`http://127.0.0.1:${port}`, seen);
    } finally {
        server.close();
    }
}

test('identifies the product, version, surface, and runtime', () => {
    configureUserAgent({ surface: 'mcp', version: '1.2.3', distribution: 'mcpb' });
    const value = userAgent();
    assert.match(value, /^@zyno-io\/zynohosting\/1\.2\.3 \(mcp; mcpb\) node\/\d+\.\d+\.\d+ \w+-\w+$/);
});

test('distinguishes the CLI surface and the npm distribution', () => {
    configureUserAgent({ surface: 'cli', version: '1.2.3', distribution: 'npm' });
    assert.match(userAgent(), /^@zyno-io\/zynohosting\/1\.2\.3 \(cli; npm\)/);
});

test('reads the distribution from the environment the bundle manifest sets', () => {
    assert.equal(resolveDistribution({ ZYNOHOSTING_DISTRIBUTION: 'mcpb' }), 'mcpb');
    assert.equal(resolveDistribution({}), 'npm');
    // Anything unrecognized must not be echoed back into a header.
    assert.equal(resolveDistribution({ ZYNOHOSTING_DISTRIBUTION: 'nonsense' }), 'npm');

    configureUserAgent({ surface: 'mcp', version: '1.2.3' }, { ZYNOHOSTING_DISTRIBUTION: 'mcpb' });
    assert.match(userAgent(), /\(mcp; mcpb\)/);
});

test('strips control characters that would let a version inject a header', () => {
    configureUserAgent({ surface: 'cli', version: '1.2.3\r\nX-Injected: yes' });
    const value = userAgent();
    assert.doesNotMatch(value, /[\r\n]/);
    assert.match(value, /X-Injected/, 'the text survives, only the control characters are removed');
});

test('sends the User-Agent on the fetch transport', async () => {
    configureUserAgent({ surface: 'mcp', version: '4.5.6', distribution: 'mcpb' });
    await withServer(async (baseUrl, seen) => {
        await request(`${baseUrl}/sites`);
        assert.equal(seen.length, 1);
        assert.match(seen[0]!, /^@zyno-io\/zynohosting\/4\.5\.6 \(mcp; mcpb\)/);
    });
});

test('sends the User-Agent on the streaming transport', async () => {
    configureUserAgent({ surface: 'cli', version: '4.5.6', distribution: 'npm' });
    await withServer(async (baseUrl, seen) => {
        const response = await requestStream(`${baseUrl}/download`);
        response.body.resume();
        await new Promise(resolve => response.body.once('end', resolve));
        assert.equal(seen.length, 1);
        // This transport previously sent no User-Agent at all, which is the path
        // deploy uploads and downloads take.
        assert.match(seen[0]!, /^@zyno-io\/zynohosting\/4\.5\.6 \(cli; npm\)/);
    });
});

test('does not override a User-Agent a caller set deliberately', async () => {
    configureUserAgent({ surface: 'cli', version: '4.5.6' });
    await withServer(async (baseUrl, seen) => {
        await request(`${baseUrl}/sites`, { headers: { 'user-agent': 'caller-supplied/1.0' } });
        assert.equal(seen[0], 'caller-supplied/1.0');
    });
});

test('keeps other headers intact while adding its own', async () => {
    configureUserAgent({ surface: 'cli', version: '4.5.6' });
    const server = createServer((incoming, response) => {
        assert.equal(incoming.headers.authorization, 'Bearer token');
        assert.match(incoming.headers['user-agent'] ?? '', /zynohosting/);
        response.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
        await request(`http://127.0.0.1:${port}/sites`, { headers: { Authorization: 'Bearer token' } });
    } finally {
        server.close();
    }
});
