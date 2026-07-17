import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCapabilities, parseDeploymentSession, parseFinalPlan } from '../src/protocol.js';

test('parses a valid manager session and rejects unsafe remote URLs', () => {
    const session = parseDeploymentSession({
        protocolVersion: 1,
        site: {
            id: '11111111-1111-4111-8111-111111111111',
            fqdn: 'example.com',
            status: 'active',
            phpVersion: null
        },
        endpoints: {
            deploy: 'https://demo.example.com/@zh/deploy/v1',
            files: 'https://demo.example.com/@zh/files/v1'
        },
        scopes: ['deploy:inventory', 'deploy:hash', 'deploy:apply'],
        accessToken: 'token',
        expiresAt: '2026-07-12T12:00:00.000Z'
    });
    assert.equal(session.protocolVersion, 1);
    assert.throws(() =>
        parseDeploymentSession({
            protocolVersion: 1,
            site: {
                id: '11111111-1111-4111-8111-111111111111',
                fqdn: 'example.com',
                status: 'active',
                phpVersion: null
            },
            endpoints: {
                deploy: 'http://demo.example.com/@zh/deploy/v1',
                files: 'https://demo.example.com/@zh/files/v1'
            },
            scopes: ['deploy:inventory', 'deploy:hash', 'deploy:apply'],
            accessToken: 'token',
            expiresAt: '2026-07-12T12:00:00.000Z'
        })
    );
});

test('parses capabilities and validates candidate indices', () => {
    const capabilities = parseCapabilities({
        protocolVersion: 1,
        hashAlgorithms: ['xxh3-128', 'sha256'],
        ignoreRulesetId: 'v1',
        mandatoryIgnores: ['.git/'],
        limits: { maxFiles: 10, maxPathBytes: 100, maxFileBytes: 1000, maxUploadBytes: 2000 }
    });
    assert.deepEqual(capabilities.hashAlgorithms, ['xxh3-128', 'sha256']);
    assert.throws(() =>
        parseFinalPlan(
            {
                planId: 'plan',
                expiresAt: '2026-07-12T12:00:00.000Z',
                operations: [],
                uploadIndices: [2]
            },
            2,
            'plan'
        )
    );
});
