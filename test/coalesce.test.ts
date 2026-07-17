import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coalesceOperations } from '../src/deploy/coalesce.js';

test('coalesces a wholly-created directory', () => {
    const result = coalesceOperations(
        [
            { path: 'assets/a.txt', size: 2 },
            { path: 'assets/icons/b.svg', size: 3 }
        ],
        [
            { kind: 'create', path: 'assets/a.txt', size: 2 },
            { kind: 'create', path: 'assets/icons/b.svg', size: 3 }
        ]
    );
    assert.deepEqual(result, [{ kind: 'create', path: 'assets/', directory: true, fileCount: 2, bytes: 5 }]);
});

test('does not coalesce over an unchanged descendant', () => {
    const result = coalesceOperations(
        [
            { path: 'assets/a.txt', size: 2 },
            { path: 'assets/b.txt', size: 3 }
        ],
        [{ kind: 'replace', path: 'assets/a.txt', size: 2, previousSize: 2 }]
    );
    assert.deepEqual(result, [{ kind: 'replace', path: 'assets/a.txt', directory: false, fileCount: 1, bytes: 2 }]);
});

test('coalesces remote-only deleted descendants', () => {
    const result = coalesceOperations(
        [],
        [
            { kind: 'delete', path: 'legacy/a.txt', previousSize: 2 },
            { kind: 'delete', path: 'legacy/nested/b.txt', previousSize: 3 }
        ]
    );
    assert.deepEqual(result, [{ kind: 'delete', path: 'legacy/', directory: true, fileCount: 2, bytes: 5 }]);
});

test('does not coalesce a directory containing mixed operation kinds', () => {
    const result = coalesceOperations(
        [
            { path: 'assets/new.txt', size: 2 },
            { path: 'assets/nested/replaced.txt', size: 3 }
        ],
        [
            { kind: 'create', path: 'assets/new.txt', size: 2 },
            { kind: 'replace', path: 'assets/nested/replaced.txt', size: 3, previousSize: 3 }
        ]
    );
    assert.deepEqual(result, [
        {
            kind: 'replace',
            path: 'assets/nested/replaced.txt',
            directory: false,
            fileCount: 1,
            bytes: 3
        },
        { kind: 'create', path: 'assets/new.txt', directory: false, fileCount: 1, bytes: 2 }
    ]);
});
