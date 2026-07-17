import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildIgnoreConfiguration } from '../src/deploy/ignore.js';
import { scanLocalDirectory } from '../src/deploy/inventory.js';
import { FALLBACK_MANDATORY_IGNORES } from '../src/protocol.js';

const limits = {
    maxFiles: 100,
    maxPathBytes: 1024,
    maxFileBytes: 1024 * 1024,
    maxUploadBytes: 1024 * 1024
};

test('scans regular files and applies mandatory, file, and CLI ignores', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-inventory-'));
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'wp-content', 'uploads'), { recursive: true });
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, '.git', 'config'), 'ignored');
    await writeFile(join(root, 'wp-content', 'uploads', 'photo.jpg'), 'ignored');
    await writeFile(join(root, 'assets', 'app.js'), 'kept');
    await writeFile(join(root, 'assets', 'app.js.map'), 'ignored');
    await writeFile(join(root, '.zynohostingignore'), '*.tmp\n');
    await writeFile(join(root, 'scratch.tmp'), 'ignored');

    const ignores = await buildIgnoreConfiguration({
        root,
        mandatoryPatterns: ['.git/', 'wp-content/uploads/', '.zynohostingignore'],
        additionalPatterns: ['*.map']
    });
    const inventory = await scanLocalDirectory(root, ignores.matcher, limits);
    assert.deepEqual(inventory.files, [{ path: 'assets/app.js', size: 4 }]);
    assert.deepEqual(ignores.customPatterns, ['*.tmp', '*.map']);
});

test('custom negation cannot unignore a mandatory rule', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-ignore-'));
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'config'), 'secret');
    const ignores = await buildIgnoreConfiguration({
        root,
        mandatoryPatterns: ['.git/'],
        additionalPatterns: ['!.git/']
    });
    const inventory = await scanLocalDirectory(root, ignores.matcher, limits);
    assert.deepEqual(inventory.files, []);
});

test('fallback rules protect WordPress platform and runtime files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-wordpress-ignore-'));
    await mkdir(join(root, 'wp-content', 'et-cache'), { recursive: true });
    await mkdir(join(root, 'wp-content', 'wflogs'), { recursive: true });
    await writeFile(join(root, 'index.php'), 'kept');
    await writeFile(join(root, 'wp-config.php'), 'platform-owned');
    await writeFile(join(root, 'wp-content', 'et-cache', 'page.css'), 'runtime');
    await writeFile(join(root, 'wp-content', 'wflogs', 'config.php'), 'runtime');
    const ignores = await buildIgnoreConfiguration({ root, mandatoryPatterns: [...FALLBACK_MANDATORY_IGNORES] });
    const inventory = await scanLocalDirectory(root, ignores.matcher, limits);
    assert.deepEqual(inventory.files, [{ path: 'index.php', size: 4 }]);
});

test('rejects non-ignored symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosting-cli-symlink-'));
    await writeFile(join(root, 'target.txt'), 'target');
    await symlink('target.txt', join(root, 'link.txt'));
    const ignores = await buildIgnoreConfiguration({ root, mandatoryPatterns: [] });
    await assert.rejects(scanLocalDirectory(root, ignores.matcher, limits), /Symbolic links are not deployable/);
});
