import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CliError } from '../src/errors.js';
import { assertSupportedNode } from '../src/runtime.js';

test('rejects a Node.js older than 24 with unsupported_node (exit 1) and accepts 24 and newer', () => {
    for (const version of ['20.11.0', '22.5.1', '23.0.0']) {
        assert.throws(
            () => assertSupportedNode(version),
            (error: unknown) =>
                error instanceof CliError && error.code === 'unsupported_node' && error.exitCode === 1 && /Node\.js 24/.test(error.message)
        );
    }
    for (const version of ['24.0.0', '24.11.1', '25.1.0']) assert.doesNotThrow(() => assertSupportedNode(version));
});
