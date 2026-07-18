import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { FileClient } from '../src/api/file-client.js';
import { requestStream } from '../src/api/http.js';
import { HttpError } from '../src/errors.js';

test('encodes remote paths and forwards conditional file mutations', async () => {
    const requests: Array<{
        method: string | undefined;
        url: string | undefined;
        ifMatch?: string;
        ifNoneMatch?: string;
        connection?: string;
        te?: string;
        body: string;
    }> = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
        requests.push({
            method: request.method,
            url: request.url,
            ...(request.headers['if-match'] ? { ifMatch: request.headers['if-match'] } : {}),
            ...(request.headers['if-none-match'] ? { ifNoneMatch: request.headers['if-none-match'] } : {}),
            ...(typeof request.headers.te === 'string' && typeof request.headers.connection === 'string'
                ? { connection: request.headers.connection }
                : {}),
            ...(typeof request.headers.te === 'string' ? { te: request.headers.te } : {}),
            body: Buffer.concat(chunks).toString('utf8')
        });
        assert.equal(request.headers.authorization, 'Bearer file-token');
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/archives') {
            response.setHeader('Content-Type', 'application/gzip');
            response.setHeader('Trailer', 'X-ZH-Archive-Status, X-ZH-Archive-Error-Code');
            response.setHeader('X-ZH-Archive-Protocol', 'stream-v1');
            response.setHeader('X-ZH-Archive-Scope', 'deployable');
            response.write('archive');
            response.addTrailers({ 'X-ZH-Archive-Status': 'complete' });
            response.end();
        } else if (request.method === 'GET') {
            response.end(JSON.stringify({ path: 'a b', recursive: true, entries: [] }));
        } else if (request.method === 'PUT') {
            response.end(
                JSON.stringify({
                    created: true,
                    entry: {
                        path: 'a b/index.html',
                        type: 'file',
                        size: 5,
                        modifiedAt: '2026-07-16T12:00:00.000Z',
                        etag: '"next"'
                    }
                })
            );
        } else {
            response.end(JSON.stringify({ deleted: true, path: 'a b/index.html' }));
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    try {
        const client = new FileClient(`http://127.0.0.1:${address.port}`, 'file-token');
        await client.list('a b', true);
        await client.put('a b/index.html', Readable.from('hello'), { ifNoneMatch: '*' });
        await client.delete('a b/index.html', '"next"');
        const archive = await client.archive('deployable');
        archive.body.resume();
        assert.equal((await archive.trailers)['x-zh-archive-status'], 'complete');
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }

    assert.deepEqual(requests, [
        { method: 'GET', url: '/entries?path=a+b&recursive=true', body: '' },
        { method: 'PUT', url: '/content?path=a+b%2Findex.html', ifNoneMatch: '*', body: 'hello' },
        { method: 'DELETE', url: '/content?path=a+b%2Findex.html', ifMatch: '"next"', body: '' },
        { method: 'POST', url: '/archives', connection: 'TE', te: 'trailers', body: '{"scope":"deployable"}' }
    ]);
});

test('keeps the timeout active for a stalled streaming response body', async () => {
    const server = createServer((_request, response) => {
        response.setHeader('Content-Type', 'application/octet-stream');
        response.flushHeaders();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    try {
        const response = await requestStream(`http://127.0.0.1:${address.port}/stalled`, { timeoutMs: 1_000, bodyTimeoutMs: 25 });
        await assert.rejects(
            async () => {
                for await (const _chunk of response.body) {
                    // The server deliberately sends no body data.
                }
            },
            error => {
                assert(error instanceof HttpError);
                assert.equal(error.code, 'request_timeout');
                return true;
            }
        );
        await assert.rejects(response.trailers, /timed out/);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
});

test('preserves structured preflight errors for archive requests', async () => {
    const server = createServer(async (request, response) => {
        for await (const _chunk of request) {
            // Drain the request body before returning the preflight failure.
        }
        response.statusCode = 413;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ code: 'limit_exceeded', message: 'archive exceeds the authorized download limit' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    try {
        const client = new FileClient(`http://127.0.0.1:${address.port}`, 'file-token');
        await assert.rejects(client.archive('deployable'), error => {
            assert(error instanceof HttpError);
            assert.equal(error.status, 413);
            assert.equal(error.code, 'limit_exceeded');
            return true;
        });
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
});
