import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';

import { extractArchiveResponse } from '../src/commands/download-site.js';

test('extracts a safe complete download through a staging directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-download-'));
    const target = join(root, 'site');
    await extractArchiveResponse(new Response(new Uint8Array(await archive([{ name: 'nested/index.html', content: 'hello' }]))), target);
    assert.equal(await readFile(join(target, 'nested/index.html'), 'utf8'), 'hello');
});

test('rejects traversal entries in a complete download', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-download-unsafe-'));
    await assert.rejects(
        extractArchiveResponse(new Response(new Uint8Array(await archive([{ name: '../escape', content: 'bad' }]))), join(root, 'site')),
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

    await assert.rejects(
        extractArchiveResponse(new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>), target),
        /Download target is not empty/
    );
    assert.equal(await readFile(join(target, 'created-during-download.txt'), 'utf8'), 'preserve me');
});

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
