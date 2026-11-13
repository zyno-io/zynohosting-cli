import { domainToASCII } from 'node:url';

import { AgentClient } from '../api/agent-client.js';
import { ManagerClient } from '../api/manager-client.js';
import { ConfigOverrides, ResolvedConfig, resolveConfig } from '../config.js';
import { createDeploymentArchive } from '../deploy/archive.js';
import { coalesceOperations, DisplayOperation } from '../deploy/coalesce.js';
import { hashInventoryFiles } from '../deploy/hash.js';
import { buildIgnoreConfiguration } from '../deploy/ignore.js';
import { LocalInventory, scanLocalDirectory, validateRelativePath } from '../deploy/inventory.js';
import { CliError } from '../errors.js';
import { Output } from '../output.js';
import {
    ApplyResult,
    DEFAULT_HASH_ALGORITHM,
    DeploymentSession,
    DeploymentTarget,
    FALLBACK_MANDATORY_IGNORES,
    FinalDeploymentPlan,
    HashAlgorithm,
    PROTOCOL_VERSION
} from '../protocol.js';

export interface DeploySiteOptions extends ConfigOverrides {
    preview?: boolean;
    yes?: boolean;
    dryRun?: boolean;
    json?: boolean;
    allowEmpty?: boolean;
    ignore?: string[];
    ignoreFile?: string;
    timeoutSeconds?: number;
    hashConcurrency?: number;
}

export interface PreparedDeployment {
    target: DeploymentTarget;
    fqdn: string;
    source: string;
    manager: ManagerClient;
    session: DeploymentSession;
    agent: AgentClient;
    inventory: LocalInventory;
    finalPlan: FinalDeploymentPlan;
    displayOperations: DisplayOperation[];
    ignoreSources: string[];
    uploadBytes: number;
    allowEmpty: boolean;
    applyTimeoutMs: number;
}

export async function deploySite(fqdnInput: string, directory: string, options: DeploySiteOptions): Promise<void> {
    const output = new Output(options.json ?? false);
    const plan = await prepareDeployment(fqdnInput, directory, options, message => output.progress(message));
    output.showPlan({
        target: plan.target,
        ...(plan.session.url ? { url: plan.session.url } : {}),
        fqdn: plan.fqdn,
        source: plan.source,
        ignores: plan.ignoreSources,
        displayOperations: plan.displayOperations,
        operations: plan.finalPlan.operations,
        uploadBytes: plan.uploadBytes
    });

    if (options.dryRun) {
        output.dryRun();
        return;
    }
    if (!plan.finalPlan.operations.length) return;
    if (!plan.inventory.files.length && plan.finalPlan.operations.some(operation => operation.kind === 'delete') && !options.allowEmpty) {
        throw new CliError(
            'The local source contains no deployable files. Pass --allow-empty to approve deleting the remote sync scope.',
            2,
            'empty_source'
        );
    }
    if (options.json && !options.yes) throw new CliError('--json requires --yes or --dry-run', 2, 'confirmation_required');
    if (!options.yes && !(await output.confirm())) {
        output.cancelled();
        return;
    }
    const result = await applyPreparedDeployment(plan, message => output.progress(message));
    output.applied(result, plan.target, plan.session.url);
}

export async function prepareDeployment(
    siteRefInput: string,
    directory: string,
    options: DeploySiteOptions,
    progress: (message: string) => void = () => {},
    resolvedConfig?: ResolvedConfig
): Promise<PreparedDeployment> {
    const fqdn = normalizeSiteRef(siteRefInput);
    const timeoutMs = Math.max(1, options.timeoutSeconds ?? 600) * 1000;
    const config =
        resolvedConfig ??
        (await resolveConfig({
            ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
            ...(options.authApiUrl ? { authApiUrl: options.authApiUrl } : {}),
            ...(options.apiKey ? { apiKey: options.apiKey } : {}),
            ...(options.tenant ? { tenant: options.tenant } : {}),
            ...(options.environment ? { environment: options.environment } : {})
        }));

    progress('Authorizing deployment…');
    const manager = new ManagerClient(config.apiUrl, config.credential, Math.min(timeoutMs, 30_000));
    const target = options.preview ? 'preview' : 'production';
    const session = await manager.createDeploymentSession(fqdn, target);
    const agent = new AgentClient(session.baseUrl, session.accessToken, timeoutMs);

    progress('Loading cluster deployment capabilities…');
    const capabilities = await agent.capabilities();
    const hashAlgorithm = chooseHashAlgorithm(capabilities.hashAlgorithms);
    const mandatoryPatterns = [...new Set([...FALLBACK_MANDATORY_IGNORES, ...capabilities.mandatoryIgnores])];
    const cliOnlyMandatoryPatterns = FALLBACK_MANDATORY_IGNORES.filter(pattern => !capabilities.mandatoryIgnores.includes(pattern));
    const ignores = await buildIgnoreConfiguration({
        root: directory,
        mandatoryPatterns,
        ...(options.ignoreFile ? { ignoreFile: options.ignoreFile } : {}),
        ...(options.ignore?.length ? { additionalPatterns: options.ignore } : {})
    });

    progress('Scanning local files…');
    const inventory = await scanLocalDirectory(directory, ignores.matcher, capabilities.limits);
    progress(`Found ${inventory.files.length} deployable files.`);

    const initialPlan = await agent.createPlan({
        protocolVersion: PROTOCOL_VERSION,
        hashAlgorithm,
        ignoreRulesetId: capabilities.ignoreRulesetId,
        customIgnores: [...cliOnlyMandatoryPatterns, ...ignores.customPatterns],
        files: inventory.files
    });
    if (initialPlan.hashAlgorithm !== hashAlgorithm) {
        throw new CliError(
            `Agent changed the selected hash algorithm from ${hashAlgorithm} to ${initialPlan.hashAlgorithm}`,
            5,
            'invalid_agent_response'
        );
    }

    progress(`Hashing ${initialPlan.hashCandidateIndices.length} same-size file${initialPlan.hashCandidateIndices.length === 1 ? '' : 's'}…`);
    const hashes = await hashInventoryFiles(
        inventory.root,
        inventory.files,
        initialPlan.hashCandidateIndices,
        hashAlgorithm,
        options.hashConcurrency ?? 8,
        inventory.snapshots
    );
    const finalPlan = await agent.submitHashes(
        initialPlan.planId,
        { protocolVersion: PROTOCOL_VERSION, algorithm: hashAlgorithm, hashes },
        inventory.files.length
    );
    validateFinalPlan(finalPlan.uploadIndices, finalPlan.operations, inventory.files, capabilities.limits.maxPathBytes);

    const uploadBytes = finalPlan.uploadIndices.reduce((total, index) => total + inventory.files[index]!.size, 0);
    if (uploadBytes > capabilities.limits.maxUploadBytes) {
        throw new CliError(
            `Changed content is ${uploadBytes} bytes; the cluster upload limit is ${capabilities.limits.maxUploadBytes}`,
            2,
            'upload_too_large'
        );
    }
    const displayOperations = coalesceOperations(inventory.files, finalPlan.operations);
    return {
        target,
        fqdn,
        source: inventory.root,
        manager,
        session,
        agent,
        inventory,
        finalPlan,
        displayOperations,
        ignoreSources: ignores.sources,
        uploadBytes,
        allowEmpty: options.allowEmpty ?? false,
        applyTimeoutMs: Math.max(timeoutMs, 45 * 60_000)
    };
}

export async function applyPreparedDeployment(plan: PreparedDeployment, progress: (message: string) => void = () => {}): Promise<ApplyResult> {
    if (!plan.finalPlan.operations.length) {
        return {
            ok: true,
            planId: plan.finalPlan.planId,
            created: 0,
            replaced: 0,
            deleted: 0,
            uploadedBytes: 0,
            durationMs: 0
        };
    }
    if (!plan.inventory.files.length && plan.finalPlan.operations.some(operation => operation.kind === 'delete') && !plan.allowEmpty) {
        throw new CliError(
            'The local source contains no deployable files. Pass --allow-empty to approve deleting the remote sync scope.',
            2,
            'empty_source'
        );
    }
    if (Date.parse(plan.finalPlan.expiresAt) <= Date.now() || Date.parse(plan.session.expiresAt) <= Date.now()) {
        throw new CliError('The deployment plan expired before apply; rerun the command to generate a fresh preview', 6, 'plan_expired');
    }

    const archive = createDeploymentArchive(plan.inventory.root, plan.inventory.files, plan.finalPlan.uploadIndices, plan.inventory.snapshots);
    progress(`Uploading ${archive.fileCount} changed file${archive.fileCount === 1 ? '' : 's'} (${archive.uncompressedBytes} bytes)…`);
    const result = await plan.agent.apply(plan.finalPlan.planId, archive.stream, plan.applyTimeoutMs);
    if (!result.ok) throw new CliError(result.error ?? 'The cluster agent could not apply the deployment', 7, 'apply_failed', result);
    progress('Invalidating the site cache…');
    try {
        await retry(() => plan.manager.purgeSiteCache(plan.session.siteId), 3);
    } catch (error) {
        throw new CliError(
            `Deployment applied, but cache invalidation could not be queued: ${error instanceof Error ? error.message : String(error)}`,
            8,
            'cache_invalidation_failed',
            result
        );
    }
    return result;
}

async function retry(operation: () => Promise<void>, attempts: number): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await operation();
            return;
        } catch (error) {
            lastError = error;
            if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 250));
        }
    }
    throw lastError;
}

function chooseHashAlgorithm(supported: readonly HashAlgorithm[]): HashAlgorithm {
    if (supported.includes(DEFAULT_HASH_ALGORITHM)) return DEFAULT_HASH_ALGORITHM;
    if (supported.includes('sha256')) return 'sha256';
    throw new CliError(`Agent does not support a CLI hash algorithm (${supported.join(', ') || 'none advertised'})`, 5, 'unsupported_hash_algorithm');
}

export function normalizeSiteRef(value: string): string {
    const trimmed = value.trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) return trimmed.toLowerCase();
    const result = domainToASCII(value.trim().toLowerCase());
    if (
        !result ||
        result.length > 253 ||
        !result.includes('.') ||
        result.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ) {
        throw new CliError(`Invalid site hostname: ${value}`, 2, 'invalid_hostname');
    }
    return result;
}

function validateFinalPlan(
    uploadIndices: readonly number[],
    operations: readonly { kind: string; path: string; size?: number }[],
    files: readonly { path: string; size: number }[],
    maxPathBytes: number
): void {
    const operationPaths = new Set<string>();
    const expectedUploadPaths = new Set<string>();
    const fileByPath = new Map(files.map(file => [file.path, file]));
    for (const operation of operations) {
        validateRelativePath(operation.path, maxPathBytes);
        if (operationPaths.has(operation.path))
            throw new CliError(`Agent plan contains duplicate operation path ${operation.path}`, 5, 'invalid_agent_response');
        operationPaths.add(operation.path);
        if (operation.kind === 'create' || operation.kind === 'replace') {
            const file = fileByPath.get(operation.path);
            if (!file || operation.size !== file.size) {
                throw new CliError(`Agent plan has invalid upload metadata for ${operation.path}`, 5, 'invalid_agent_response');
            }
            expectedUploadPaths.add(operation.path);
        } else if (fileByPath.has(operation.path)) {
            throw new CliError(`Agent plan deletes a submitted local file: ${operation.path}`, 5, 'invalid_agent_response');
        }
    }

    const actualUploadPaths = new Set<string>();
    for (const index of uploadIndices) {
        const file = files[index];
        if (!file) throw new CliError('Agent plan contains an invalid upload index', 5, 'invalid_agent_response');
        actualUploadPaths.add(file.path);
    }
    if (actualUploadPaths.size !== uploadIndices.length || actualUploadPaths.size !== expectedUploadPaths.size) {
        throw new CliError('Agent plan upload indices do not match create/replace operations', 5, 'invalid_agent_response');
    }
    for (const path of expectedUploadPaths) {
        if (!actualUploadPaths.has(path)) throw new CliError(`Agent omitted upload content for ${path}`, 5, 'invalid_agent_response');
    }
}
