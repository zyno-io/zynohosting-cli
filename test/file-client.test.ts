import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { FileClient } from '../src/api/file-client.js';

test('encodes remote paths and forwards conditional file mutations', async () => {
    const requests: Array<{
        method: string | undefined;
        url: string | undefined;
        ifMatch?: string;
        ifNoneMatch?: string;
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
            body: Buffer.concat(chunks).toString('utf8')
        });
        assert.equal(request.headers.authorization, 'Bearer file-token');
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/archives') {
            response.setHeader('Content-Type', 'application/gzip');
            response.setHeader('X-ZH-Archive-Scope', 'deployable');
            response.end('archive');
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
        await client.archive('deployable');
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }

    assert.deepEqual(requests, [
        { method: 'GET', url: '/entries?path=a+b&recursive=true', body: '' },
        { method: 'PUT', url: '/content?path=a+b%2Findex.html', ifNoneMatch: '*', body: 'hello' },
        { method: 'DELETE', url: '/content?path=a+b%2Findex.html', ifMatch: '"next"', body: '' },
        { method: 'POST', url: '/archives', body: '{"scope":"deployable"}' }
    ]);
});
