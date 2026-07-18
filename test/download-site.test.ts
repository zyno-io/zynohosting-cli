import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';

import { StreamingResponse } from '../src/api/http.js';
import { extractArchiveResponse } from '../src/commands/download-site.js';
import { CliError, HttpError } from '../src/errors.js';

test('extracts a safe complete download through a staging directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-download-'));
    const target = join(root, 'site');
    await extractArchiveResponse(downloadResponse(Readable.from(await archive([{ name: 'nested/index.html', content: 'hello' }]))), target);
    assert.equal(await readFile(join(target, 'nested/index.html'), 'utf8'), 'hello');
});

test('rejects traversal entries in a complete download', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-download-unsafe-'));
    await assert.rejects(
        extractArchiveResponse(downloadResponse(Readable.from(await archive([{ name: '../escape', content: 'bad' }]))), join(root, 'site')),
        /Unsafe deployment path/
    );
});

test('preserves destination content created while a download is in progress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-download-race-'));
    const target = join(root, 'site');
    await mkdir(target);
    const content = await archive([{ name: 'index.html', content: 'hello' }]);
    const midpoint = Math.floor(content.length / 2);
    const stream = Readable.from(
        (async function* () {
            yield content.subarray(0, midpoint);
            await writeFile(join(target, 'created-during-download.txt'), 'preserve me');
            yield content.subarray(midpoint);
        })()
    );

    await assert.rejects(extractArchiveResponse(downloadResponse(stream), target), /Download target is not empty/);
    assert.equal(await readFile(join(target, 'created-during-download.txt'), 'utf8'), 'preserve me');
});

test('uses the archive error trailer and removes partial extraction state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-download-error-trailer-'));
    const target = join(root, 'site');
    const content = await archive([{ name: 'index.html', content: 'partial' }]);
    const response = downloadResponse(Readable.from(content.subarray(0, Math.floor(content.length / 2))), {
        trailers: { 'x-zh-archive-status': 'error', 'x-zh-archive-error-code': 'file_changed' }
    });
    await assert.rejects(extractArchiveResponse(response, target), error => {
        assert(error instanceof CliError);
        assert.equal(error.code, 'file_changed');
        return true;
    });
    await assert.rejects(readFile(join(target, 'index.html')));
});

test('rejects a streaming response without its completion trailer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-download-missing-trailer-'));
    const target = join(root, 'site');
    const response = downloadResponse(Readable.from(await archive([{ name: 'index.html', content: 'hello' }])), { trailers: {} });
    await assert.rejects(extractArchiveResponse(response, target), error => {
        assert(error instanceof CliError);
        assert.equal(error.code, 'incomplete_archive');
        return true;
    });
});

test('accepts a complete archive from a legacy pre-streaming agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-download-legacy-'));
    const target = join(root, 'site');
    const response = downloadResponse(Readable.from(await archive([{ name: 'index.html', content: 'legacy' }])), {
        protocol: undefined,
        trailers: {}
    });
    await extractArchiveResponse(response, target);
    assert.equal(await readFile(join(target, 'index.html'), 'utf8'), 'legacy');
});

test('propagates an interrupted archive response and removes partial extraction state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-download-interrupted-'));
    const target = join(root, 'site');
    const body = Readable.from(
        (async function* () {
            yield Buffer.from([0x1f, 0x8b]);
            throw new Error('connection reset');
        })()
    );
    const response = downloadResponse(body, {
        trailerError: new HttpError('Request failed: connection reset', 0, 'network_error')
    });
    await assert.rejects(extractArchiveResponse(response, target), /connection reset/);
    await assert.rejects(readFile(join(target, 'index.html')));
});

function downloadResponse(
    body: Readable,
    options: {
        protocol?: 'stream-v1' | undefined;
        trailers?: Record<string, string>;
        trailerError?: Error;
    } = {}
): StreamingResponse {
    const protocol = Object.hasOwn(options, 'protocol') ? options.protocol : 'stream-v1';
    const trailers = options.trailerError
        ? Promise.reject<Record<string, string>>(options.trailerError)
        : Promise.resolve(options.trailers ?? { 'x-zh-archive-status': 'complete' });
    void trailers.catch(() => {});
    return {
        status: 200,
        statusText: 'OK',
        headers: protocol ? { 'x-zh-archive-protocol': protocol } : {},
        body,
        trailers,
        abort() {
            body.destroy();
        }
    };
}

async function archive(files: Array<{ name: string; content: string }>): Promise<Buffer> {
    const pack = tar.pack();
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    const complete = (async () => {
        for await (const chunk of Readable.from(pack).pipe(gzip)) chunks.push(Buffer.from(chunk as Buffer));
    })();
    for (const file of files) {
        await new Promise<void>((resolve, reject) => {
            pack.entry({ name: file.name, type: 'file', size: Buffer.byteLength(file.content) }, file.content, error =>
                error ? reject(error) : resolve()
            );
        });
    }
    pack.finalize();
    await complete;
    return Buffer.concat(chunks);
}
