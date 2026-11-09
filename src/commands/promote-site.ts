import { randomUUID } from 'node:crypto';

import { ManagerClient } from '../api/manager-client.js';
import { ConfigOverrides, ResolvedConfig, resolveConfig } from '../config.js';
import { CliError } from '../errors.js';
import { Output } from '../output.js';
import { AutomationSite, PromotionAccepted, PREVIEW_RESOURCE_NOTICE } from '../protocol.js';
import { normalizeSiteRef } from './deploy-site.js';

export interface PromoteSiteOptions extends ConfigOverrides {
    force?: boolean;
    yes?: boolean;
    dryRun?: boolean;
    json?: boolean;
    timeoutSeconds?: number;
}

export interface PromotionResult {
    siteId: string;
    productionUrl: string;
    previewUrl: string;
    deploymentId: string;
    operationId: string;
    status: 'succeeded';
}

export interface PreparedPromotion {
    force: boolean;
    planId: string;
    expiresAt: string;
    site: AutomationSite;
    manager: ManagerClient;
    expectedProductionDeploymentId: string | null;
    productionUrl: string;
    previewUrl: string;
    timeoutMs: number;
    accepted?: PromotionAccepted;
    inFlight?: Promise<PromotionResult>;
}

export async function preparePromotion(siteRef: string, options: PromoteSiteOptions, resolvedConfig?: ResolvedConfig): Promise<PreparedPromotion> {
    const normalized = normalizeSiteRef(siteRef);
    const config = resolvedConfig ?? (await resolveConfig(options));
    const timeoutMs = Math.max(1, options.timeoutSeconds ?? 900) * 1000;
    const manager = new ManagerClient(config.apiUrl, config.credential, timeoutMs);
    const site = await manager.getSite(normalized);
    if (!site.deployments?.production.url || !site.deployments.preview.url) {
        throw new CliError('This manager/site does not advertise preview deployments; update the manager before promoting', 5, 'preview_unavailable');
    }
    if (site.status !== 'active') throw new CliError('Only an active site can be promoted', 2, 'site_inactive');
    return {
        force: options.force === true,
        planId: randomUUID(),
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        site,
        manager,
        expectedProductionDeploymentId: site.deployments.production.deploymentId,
        productionUrl: site.deployments.production.url,
        previewUrl: site.deployments.preview.url,
        timeoutMs
    };
}

export function promotionSummary(plan: PreparedPromotion) {
    return {
        planId: plan.planId,
        site: plan.site.fqdn,
        siteId: plan.site.id,
        expiresAt: plan.expiresAt,
        productionUrl: plan.productionUrl,
        previewUrl: plan.previewUrl,
        expectedProductionDeploymentId: plan.expectedProductionDeploymentId,
        force: plan.force,
        ...(plan.force
            ? { forceWarning: 'Forced promotion can remove WordPress configuration from production. This bypasses the missing wp-config.php guard.' }
            : {}),
        resourceNotice: PREVIEW_RESOURCE_NOTICE,
        previewContent:
            'At apply time, preview is renamed into production and replaced with an empty preview directory. Old production is archived, then purged by a background job.'
    };
}

export function applyPreparedPromotion(plan: PreparedPromotion, progress: (message: string) => void = () => {}): Promise<PromotionResult> {
    // Concurrent apply calls share one submission. Retain the accepted operation after timeout so
    // a subsequent apply resumes polling instead of rotating the directories again.
    plan.inFlight ??= applyPromotion(plan, progress).finally(() => {
        delete plan.inFlight;
    });
    return plan.inFlight;
}

async function applyPromotion(plan: PreparedPromotion, progress: (message: string) => void): Promise<PromotionResult> {
    if (!plan.accepted) {
        if (Date.parse(plan.expiresAt) <= Date.now()) throw new CliError('Promotion plan expired; create a new plan', 6, 'plan_expired');
        progress('Queuing preview promotion and production reconciliation…');
        plan.accepted = await plan.manager.promoteSite(plan.site.id, plan.expectedProductionDeploymentId, plan.force);
        plan.expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    }
    const accepted = plan.accepted;
    let operation = accepted.operation;
    const deadline = Date.now() + plan.timeoutMs;
    progress(`Waiting for production reconciliation ${operation.id}…`);
    while (operation.status !== 'succeeded') {
        if (operation.status === 'failed') {
            throw new CliError(`Promotion reconciliation failed: ${operation.lastError ?? 'unknown error'}`, 7, 'promotion_failed', {
                operationId: operation.id
            });
        }
        if (Date.now() >= deadline) {
            throw new CliError(
                'Promotion was accepted but is still reconciling; inspect the operation before submitting another promotion',
                7,
                'promotion_pending',
                { operationId: operation.id, statusUrl: operation.statusUrl }
            );
        }
        operation = await plan.manager.getReconciliation(operation.id);
        accepted.operation = operation;
        if (operation.status !== 'succeeded' && operation.status !== 'failed') await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const deploymentId = accepted.result.deployments?.production.deploymentId;
    if (!deploymentId || deploymentId === plan.expectedProductionDeploymentId) {
        throw new CliError('Manager did not return a new production deployment', 5, 'invalid_manager_response');
    }
    return {
        siteId: plan.site.id,
        productionUrl: plan.productionUrl,
        previewUrl: plan.previewUrl,
        deploymentId,
        operationId: operation.id,
        status: 'succeeded'
    };
}

export async function promoteSite(siteRef: string, options: PromoteSiteOptions): Promise<void> {
    const output = new Output(options.json ?? false);
    const plan = await preparePromotion(siteRef, options);
    const summary = promotionSummary(plan);
    if (options.json) process.stdout.write(`${JSON.stringify({ type: 'promotion_plan', ...summary })}\n`);
    else {
        process.stdout.write(`\nPromote ${plan.previewUrl} to ${plan.productionUrl}\n`);
        process.stdout.write(`${summary.previewContent}\n${summary.resourceNotice}\n`);
        if (summary.forceWarning) process.stdout.write(`WARNING: ${summary.forceWarning}\n`);
    }
    if (options.dryRun) {
        output.dryRun();
        return;
    }
    if (options.json && !options.yes) throw new CliError('--json requires --yes or --dry-run', 2, 'confirmation_required');
    if (!options.yes && !(await output.confirm())) {
        output.cancelled();
        return;
    }
    const promoted = await applyPreparedPromotion(plan, message => output.progress(message));
    if (options.json) process.stdout.write(`${JSON.stringify({ type: 'promotion_result', ...promoted })}\n`);
    else process.stdout.write(`\nPromoted successfully: ${promoted.productionUrl}\nPreview: ${promoted.previewUrl}\n`);
}
