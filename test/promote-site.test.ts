import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPreparedPromotion, preparePromotion, promoteSite } from '../src/commands/promote-site.js';
import { operationId, previewManager, releaseId, siteId } from './fixtures/preview-manager.js';

test('promote dry run reads the manager contract without changing content', async t => {
    const fixture = await previewManager(t);
    await promoteSite('example.com', { apiUrl: fixture.baseUrl, apiKey: 'secret', dryRun: true, json: true });
    assert.deepEqual(fixture.requests, ['GET /v1/sites/example.com']);
    assert.equal(fixture.state.productionContent, 'live');
});

test('promotion rotates current preview into production at apply and waits for the exact reconciliation', async t => {
    const fixture = await previewManager(t);
    const plan = await preparePromotion('example.com', { apiUrl: fixture.baseUrl, apiKey: 'secret' });
    fixture.state.previewContent = 'edited-after-plan';
    const [result, concurrent] = await Promise.all([applyPreparedPromotion(plan), applyPreparedPromotion(plan)]);
    assert.deepEqual(result, concurrent);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.operationId, operationId);
    assert.equal(result.deploymentId, releaseId);
    assert.equal(fixture.state.promotions, 1);
    assert.equal(fixture.state.polls, 1);
    assert.equal(fixture.state.productionContent, 'edited-after-plan');
    assert.equal(fixture.state.previewContent, '');
    assert.deepEqual(fixture.bodies, [{ expectedProductionDeploymentId: null }]);
    assert(fixture.requests.includes(`POST /v1/sites/${siteId}/promote`));
});

test('stale production plans cannot overwrite a newer deployment', async t => {
    const fixture = await previewManager(t);
    const plan = await preparePromotion('example.com', { apiUrl: fixture.baseUrl, apiKey: 'secret' });
    fixture.state.productionId = releaseId;
    await assert.rejects(applyPreparedPromotion(plan), /production changed/);
    assert.equal(fixture.state.promotions, 0);
    assert.equal(fixture.state.productionContent, 'live');
});

test('failed reconciliation is reported as failure and retry does not resubmit promotion', async t => {
    const fixture = await previewManager(t);
    fixture.state.failReconciliation = true;
    const plan = await preparePromotion('example.com', { apiUrl: fixture.baseUrl, apiKey: 'secret' });
    await assert.rejects(applyPreparedPromotion(plan), /origin validation failed/);
    await assert.rejects(applyPreparedPromotion(plan), /origin validation failed/);
    assert.equal(fixture.state.promotions, 1);
});

test('expired promotion plans cannot submit a mutation', async t => {
    const fixture = await previewManager(t);
    const plan = await preparePromotion('example.com', { apiUrl: fixture.baseUrl, apiKey: 'secret' });
    plan.expiresAt = new Date(Date.now() - 1).toISOString();
    await assert.rejects(applyPreparedPromotion(plan), /expired/);
    assert.equal(fixture.state.promotions, 0);
});
