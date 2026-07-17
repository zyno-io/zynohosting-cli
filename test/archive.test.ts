import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import tar from 'tar-stream';

import { createDeploymentArchive } from '../src/deploy/archive.js';

test('streams only selected files into a deterministic safe tar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-archive-'));
    await writeFile(join(root, 'a.txt'), 'alpha');
    await writeFile(join(root, 'b.txt'), 'bravo');
    const archive = createDeploymentArchive(
        root,
        [
            { path: 'a.txt', size: 5 },
            { path: 'b.txt', size: 5 }
        ],
        [1]
    );
    const compressed = await collect(archive.stream);
    const entries = await extract(gunzipSync(compressed));
    assert.deepEqual(entries, [{ name: 'b.txt', mode: 0o644, content: 'bravo' }]);
    assert.equal(archive.fileCount, 1);
    assert.equal(archive.uncompressedBytes, 5);
});

async function collect(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
}

async function extract(buffer: Buffer): Promise<Array<{ name: string; mode: number; content: string }>> {
    const extractor = tar.extract();
    const entries: Array<{ name: string; mode: number; content: string }> = [];
    extractor.on('entry', (header, stream, next) => {
        void (async () => {
            const content = await collect(stream);
            entries.push({
                name: header.name,
                mode: header.mode ?? 0,
                content: content.toString('utf8')
            });
            next();
        })();
    });
    const complete = new Promise<void>((resolve, reject) => {
        extractor.once('finish', resolve);
        extractor.once('error', reject);
    });
    Readable.from(buffer).pipe(extractor);
    await complete;
    return entries;
}
