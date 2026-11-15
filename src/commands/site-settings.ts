import { ManagerClient } from '../api/manager-client.js';
import { ConfigOverrides, ResolvedConfig, resolveConfig } from '../config.js';
import { diagnoseDeployToken, verifyDeployToken } from '../deploy-tokens/guard.js';
import { CliError } from '../errors.js';
import { Output } from '../output.js';
import { AutomationSite, NOT_FOUND_HANDLING_MODES, NotFoundHandling, SiteMutationAccepted } from '../protocol.js';
import { normalizeSiteRef } from './deploy-site.js';
import { waitForReconciliation } from './reconciliation.js';

export interface SetSiteSettingsOptions extends ConfigOverrides {
    notFound?: string;
    yes?: boolean;
    dryRun?: boolean;
    json?: boolean;
    timeoutSeconds?: number;
}

export interface SiteSettingsResult {
    siteId: string;
    site: string;
    notFoundHandling: NotFoundHandling;
    previous: string;
    changed: boolean;
    operationId: string;
    status: 'succeeded';
}

export interface PreparedSiteSettings {
    site: AutomationSite;
    manager: ManagerClient;
    notFoundHandling: NotFoundHandling;
    previous: string;
    timeoutMs: number;
    accepted?: SiteMutationAccepted;
    inFlight?: Promise<SiteSettingsResult>;
}

/** Reads the site. A deploy token may change these settings only when it includes production, because they affect live traffic. */
async function loadSiteForSettings(manager: ManagerClient, config: ResolvedConfig, siteRef: string): Promise<AutomationSite> {
    try {
        if (config.credential.type === 'deploy-token') await verifyDeployToken(manager, { site: siteRef, environments: ['production'] });
        return await manager.getSite(siteRef);
    } catch (error) {
        return diagnoseDeployToken(config, error);
    }
}

export function isNotFoundHandling(value: unknown): value is NotFoundHandling {
    return typeof value === 'string' && (NOT_FOUND_HANDLING_MODES as readonly string[]).includes(value);
}

export async function prepareSiteSettings(
    siteRef: string,
    mode: string | undefined,
    options: SetSiteSettingsOptions,
    resolvedConfig?: ResolvedConfig
): Promise<PreparedSiteSettings> {
    if (mode === undefined) throw new CliError('No setting given; pass --not-found <404-page|single-page-application>', 2, 'invalid_input');
    if (!isNotFoundHandling(mode)) {
        throw new CliError(`Invalid not-found handling "${mode}"; use 404-page or single-page-application`, 2, 'invalid_input');
    }
    const normalized = normalizeSiteRef(siteRef);
    const config = resolvedConfig ?? (await resolveConfig({ ...options, deployTokenAllowed: true }));
    const timeoutMs = Math.max(1, options.timeoutSeconds ?? 300) * 1000;
    const manager = new ManagerClient(config.apiUrl, config.credential, timeoutMs);
    const site = await loadSiteForSettings(manager, config, normalized);
    if (site.notFoundHandling === undefined) {
        throw new CliError('This manager does not support not-found handling; update the manager first', 5, 'not_found_handling_unavailable');
    }
    if (mode === 'single-page-application' && site.phpVersion !== null) {
        throw new CliError(
            `Single-page-application handling is only available on static sites; ${site.fqdn} runs PHP ${site.phpVersion}`,
            2,
            'not_found_handling_requires_static'
        );
    }
    return { site, manager, notFoundHandling: mode, previous: site.notFoundHandling, timeoutMs };
}

export function siteSettingsSummary(plan: PreparedSiteSettings) {
    return {
        site: plan.site.fqdn,
        siteId: plan.site.id,
        notFoundHandling: plan.notFoundHandling,
        previous: plan.previous,
        changed: plan.notFoundHandling !== plan.previous,
        effect:
            plan.notFoundHandling === 'single-page-application'
                ? 'Unknown paths serve /index.html with status 200 unless they end in a listed asset extension (.js, .css, .png, .json, .txt, ...), which still return 404. Applies to production and preview immediately.'
                : plan.site.phpVersion === null
                  ? 'Every path that matches no file returns 404 (using 404.html when present). Applies to production and preview immediately.'
                  : 'This site runs PHP, so the setting has no effect while PHP is on: unknown paths go to /index.php.'
    };
}

export function applyPreparedSiteSettings(plan: PreparedSiteSettings, progress: (message: string) => void = () => {}): Promise<SiteSettingsResult> {
    // Concurrent apply calls share one submission, and an accepted operation is retained so a retry
    // after a timeout resumes polling.
    plan.inFlight ??= applySiteSettings(plan, progress).finally(() => {
        delete plan.inFlight;
    });
    return plan.inFlight;
}

async function applySiteSettings(plan: PreparedSiteSettings, progress: (message: string) => void): Promise<SiteSettingsResult> {
    const deadline = Date.now() + plan.timeoutMs;
    if (!plan.accepted) {
        progress('Queuing site settings change…');
        plan.accepted = await plan.manager.updateSite(plan.site.id, { notFoundHandling: plan.notFoundHandling });
    }
    const accepted = plan.accepted;
    progress(`Waiting for reconciliation ${accepted.operation.id}…`);
    const operation = await waitForReconciliation(
        plan.manager,
        accepted.operation,
        deadline,
        { failed: 'reconciliation_failed', pending: 'reconciliation_pending', label: 'Site settings' },
        updated => {
            accepted.operation = updated;
        }
    );
    return {
        siteId: plan.site.id,
        site: plan.site.fqdn,
        notFoundHandling: plan.notFoundHandling,
        previous: plan.previous,
        changed: plan.notFoundHandling !== plan.previous,
        operationId: operation.id,
        status: 'succeeded'
    };
}

export async function setSiteSettings(siteRef: string, options: SetSiteSettingsOptions): Promise<void> {
    const output = new Output(options.json ?? false);
    const plan = await prepareSiteSettings(siteRef, options.notFound, options);
    const summary = siteSettingsSummary(plan);
    if (options.json) process.stdout.write(`${JSON.stringify({ type: 'site_settings_plan', ...summary })}\n`);
    else {
        process.stdout.write(
            `\nSet not-found handling for ${summary.site}: ${summary.previous} -> ${summary.notFoundHandling}${summary.changed ? '' : ' (unchanged)'}\n`
        );
        process.stdout.write(`${summary.effect}\n`);
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
    const applied = await applyPreparedSiteSettings(plan, message => output.progress(message));
    if (options.json) process.stdout.write(`${JSON.stringify({ type: 'site_settings_result', ...applied })}\n`);
    else process.stdout.write(`\nNot-found handling is now ${applied.notFoundHandling} for ${applied.site}\n`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Runtime: PHP on (a version) or off (static).
// ---------------------------------------------------------------------------------------------------------------------

export interface SetRuntimeOptions extends ConfigOverrides {
    yes?: boolean;
    dryRun?: boolean;
    json?: boolean;
    timeoutSeconds?: number;
}

/** What the person asked for: `static`, `php` (the platform default version), or `php@8.3`. */
export type RuntimeChoice = { kind: 'static' } | { kind: 'php'; version?: string };

export function parseRuntimeChoice(value: string): RuntimeChoice {
    const text = value.trim().toLowerCase();
    if (text === 'static') return { kind: 'static' };
    if (text === 'php') return { kind: 'php' };
    const match = /^php@(\d+\.\d+)$/.exec(text);
    if (match) return { kind: 'php', version: match[1]! };
    throw new CliError(`Invalid runtime "${value}"; use static, php, or php@<version> (for example php@8.3)`, 2, 'invalid_input');
}

export interface PreparedRuntime {
    site: AutomationSite;
    manager: ManagerClient;
    /** The PHP version to run, or null for a static site. */
    phpVersion: string | null;
    previous: string | null;
    timeoutMs: number;
    /** Turning PHP on while single-page-application handling is set puts handling back to 404-page in the same change. */
    resetsNotFoundHandling: boolean;
    accepted?: SiteMutationAccepted;
    inFlight?: Promise<RuntimeResult>;
}

export interface RuntimeResult {
    siteId: string;
    site: string;
    phpVersion: string | null;
    previous: string | null;
    changed: boolean;
    operationId?: string;
    status: 'succeeded' | 'unchanged';
}

export async function prepareRuntime(
    siteRef: string,
    runtime: RuntimeChoice,
    options: SetRuntimeOptions,
    resolvedConfig?: ResolvedConfig
): Promise<PreparedRuntime> {
    const normalized = normalizeSiteRef(siteRef);
    const config = resolvedConfig ?? (await resolveConfig({ ...options, deployTokenAllowed: true }));
    const timeoutMs = Math.max(1, options.timeoutSeconds ?? 300) * 1000;
    const manager = new ManagerClient(config.apiUrl, config.credential, timeoutMs);
    const site = await loadSiteForSettings(manager, config, normalized);
    let phpVersion: string | null = null;
    if (runtime.kind === 'php') {
        const supported = await manager.getPhpVersions().catch(error => diagnoseDeployToken(config, error));
        if (runtime.version === undefined && supported.default === null) {
            throw new CliError('No PHP version is available on this platform right now', 5, 'php_unavailable');
        }
        phpVersion = runtime.version ?? supported.default!;
        if (!supported.versions.includes(phpVersion)) {
            throw new CliError(`PHP ${phpVersion} is not available; choose one of ${supported.versions.join(', ')}`, 2, 'unsupported_php_version');
        }
    }
    return {
        site,
        manager,
        phpVersion,
        previous: site.phpVersion,
        timeoutMs,
        resetsNotFoundHandling: phpVersion !== null && site.phpVersion === null && site.notFoundHandling === 'single-page-application'
    };
}

export function runtimeSummary(plan: PreparedRuntime) {
    const label = (version: string | null) => (version === null ? 'static' : `PHP ${version}`);
    return {
        site: plan.site.fqdn,
        siteId: plan.site.id,
        phpVersion: plan.phpVersion,
        previous: plan.previous,
        changed: plan.phpVersion !== plan.previous,
        effect:
            plan.phpVersion === null
                ? '.php files stop running and return 404. Applies to production and preview immediately.'
                : `Runs the site on ${label(plan.phpVersion)}. Applies to production and preview immediately.${
                      plan.resetsNotFoundHandling
                          ? ' Not-found handling goes back to 404-page, because single-page-application handling needs a static site.'
                          : ''
                  }`
    };
}

export function applyPreparedRuntime(plan: PreparedRuntime, progress: (message: string) => void = () => {}): Promise<RuntimeResult> {
    plan.inFlight ??= applyRuntime(plan, progress).finally(() => {
        delete plan.inFlight;
    });
    return plan.inFlight;
}

async function applyRuntime(plan: PreparedRuntime, progress: (message: string) => void): Promise<RuntimeResult> {
    const base = { siteId: plan.site.id, site: plan.site.fqdn, phpVersion: plan.phpVersion, previous: plan.previous };
    if (plan.phpVersion === plan.previous && !plan.accepted) return { ...base, changed: false, status: 'unchanged' };
    const deadline = Date.now() + plan.timeoutMs;
    if (!plan.accepted) {
        progress('Queuing runtime change…');
        plan.accepted = await plan.manager.updateSite(plan.site.id, { phpVersion: plan.phpVersion });
    }
    const accepted = plan.accepted;
    progress(`Waiting for reconciliation ${accepted.operation.id}…`);
    const operation = await waitForReconciliation(
        plan.manager,
        accepted.operation,
        deadline,
        { failed: 'reconciliation_failed', pending: 'reconciliation_pending', label: 'Runtime change' },
        updated => {
            accepted.operation = updated;
        }
    );
    return { ...base, changed: true, operationId: operation.id, status: 'succeeded' };
}

export async function setRuntime(siteRef: string, runtimeInput: string, options: SetRuntimeOptions): Promise<void> {
    const output = new Output(options.json ?? false);
    const runtime = parseRuntimeChoice(runtimeInput);
    const plan = await prepareRuntime(siteRef, runtime, options);
    const summary = runtimeSummary(plan);
    const label = (version: string | null) => (version === null ? 'static' : `PHP ${version}`);
    if (options.json) process.stdout.write(`${JSON.stringify({ type: 'runtime_plan', ...summary })}\n`);
    else {
        process.stdout.write(
            `\nSet runtime for ${summary.site}: ${label(summary.previous)} -> ${label(summary.phpVersion)}${summary.changed ? '' : ' (unchanged)'}\n`
        );
        process.stdout.write(`${summary.effect}\n`);
    }
    if (options.dryRun) {
        output.dryRun();
        return;
    }
    if (options.json && !options.yes) throw new CliError('--json requires --yes or --dry-run', 2, 'confirmation_required');
    if (summary.changed && !options.yes && !(await output.confirm())) {
        output.cancelled();
        return;
    }
    const applied = await applyPreparedRuntime(plan, message => output.progress(message));
    if (options.json) process.stdout.write(`${JSON.stringify({ type: 'runtime_result', ...applied })}\n`);
    else process.stdout.write(`\nRuntime is ${applied.changed ? 'now' : 'already'} ${label(applied.phpVersion)} for ${applied.site}\n`);
}
