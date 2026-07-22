import { CliError } from './errors.js';

export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_HASH_ALGORITHM: HashAlgorithm = 'xxh3-128';

export const FALLBACK_MANDATORY_IGNORES = [
    '.git/',
    '.hg/',
    '.svn/',
    '.zyno/',
    '.zynohostingignore',
    '.DS_Store',
    'Thumbs.db',
    'node_modules/',
    'wp-config.php',
    'wp-content/uploads/',
    'wp-content/mu-plugins/zynohosting-vanity-preview.php',
    'wp-content/mu-plugins/zynohosting.php',
    'wp-content/mu-plugins/zynohosting/',
    'wp-content/cache/',
    'wp-content/et-cache/',
    'wp-content/upgrade/',
    'wp-content/wflogs/',
    'wp-content/ai1wm-backups/',
    'wp-content/updraft/',
    '*.log'
] as const;

export type HashAlgorithm = 'xxh3-128' | 'sha256';
export type OperationKind = 'create' | 'replace' | 'delete';
export type AgentAccessScope =
    | 'deploy:inventory'
    | 'deploy:hash'
    | 'deploy:apply'
    | 'files:list'
    | 'files:read'
    | 'files:write'
    | 'files:delete'
    | 'download:deployable'
    | 'download:sensitive';

export interface DeploymentSession {
    protocolVersion: number;
    siteId: string;
    baseUrl: string;
    accessToken: string;
    expiresAt: string;
}

export interface AutomationSite {
    id: string;
    fqdn: string;
    status: string;
    phpVersion: string | null;
    hostnames?: Array<{ name: string; type: string }>;
}

export interface AccessSession {
    protocolVersion: number;
    site: AutomationSite;
    endpoints: {
        deploy: string;
        files: string;
    };
    scopes: AgentAccessScope[];
    accessToken: string;
    expiresAt: string;
}

export type ManagedFileEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface ManagedFileEntry {
    path: string;
    type: ManagedFileEntryType;
    size: number;
    modifiedAt: string;
    etag: string;
}

export interface FileListResponse {
    path: string;
    recursive: boolean;
    entries: ManagedFileEntry[];
}

export interface FilePutResult {
    created: boolean;
    entry: ManagedFileEntry;
}

export interface FileDeleteResult {
    deleted: true;
    path: string;
}

export interface DeploymentLimits {
    maxFiles: number;
    maxPathBytes: number;
    maxFileBytes: number;
    maxUploadBytes: number;
}

export interface AgentCapabilities {
    protocolVersion: number;
    hashAlgorithms: HashAlgorithm[];
    ignoreRulesetId: string;
    mandatoryIgnores: string[];
    limits: DeploymentLimits;
}

export interface InventoryFile {
    path: string;
    size: number;
}

export interface InventoryRequest {
    protocolVersion: number;
    hashAlgorithm: HashAlgorithm;
    ignoreRulesetId: string;
    customIgnores: string[];
    files: InventoryFile[];
}

export interface InventoryPlanResponse {
    planId: string;
    expiresAt: string;
    hashAlgorithm: HashAlgorithm;
    hashCandidateIndices: number[];
    preliminaryOperations: DeploymentOperation[];
}

export interface HashSubmission {
    protocolVersion: number;
    algorithm: HashAlgorithm;
    hashes: Array<{ index: number; digest: string }>;
}

export interface DeploymentOperation {
    kind: OperationKind;
    path: string;
    size?: number;
    previousSize?: number;
}

export interface FinalDeploymentPlan {
    planId: string;
    expiresAt: string;
    operations: DeploymentOperation[];
    uploadIndices: number[];
}

export interface ApplyResult {
    ok: boolean;
    planId: string;
    created: number;
    replaced: number;
    deleted: number;
    uploadedBytes: number;
    durationMs: number;
    error?: string;
}

export function parseDeploymentSession(value: unknown): DeploymentSession {
    const session = parseAccessSession(value);
    return {
        protocolVersion: session.protocolVersion,
        siteId: session.site.id,
        baseUrl: session.endpoints.deploy,
        accessToken: session.accessToken,
        expiresAt: session.expiresAt
    };
}

export function parseAccessSession(value: unknown): AccessSession {
    const object = record(value, 'deployment session');
    const endpoints = record(object.endpoints, 'endpoints');
    const result: AccessSession = {
        protocolVersion: integer(object.protocolVersion, 'protocolVersion'),
        site: parseAutomationSite(object.site),
        endpoints: {
            deploy: safeEndpoint(endpoints.deploy, 'endpoints.deploy'),
            files: safeEndpoint(endpoints.files, 'endpoints.files')
        },
        scopes: array(object.scopes, 'scopes').map((scope, index) => accessScope(scope, `scopes[${index}]`)),
        accessToken: string(object.accessToken, 'accessToken'),
        expiresAt: isoDate(object.expiresAt, 'expiresAt')
    };
    if (result.protocolVersion !== PROTOCOL_VERSION) {
        throw new CliError(`Manager selected unsupported deployment protocol ${result.protocolVersion}`, 5, 'unsupported_protocol');
    }
    return result;
}

export function parseAutomationSites(value: unknown): AutomationSite[] {
    return array(value, 'sites').map(parseAutomationSite);
}

export function parseAutomationSite(value: unknown): AutomationSite {
    const object = record(value, 'site');
    const hostnames =
        object.hostnames === undefined
            ? undefined
            : array(object.hostnames, 'hostnames').map((hostname, index) => {
                  const item = record(hostname, `hostnames[${index}]`);
                  return {
                      name: string(item.name, `hostnames[${index}].name`),
                      type: string(item.type ?? item.kind, `hostnames[${index}].type`)
                  };
              });
    return {
        id: uuid(object.id, 'site.id'),
        fqdn: string(object.fqdn ?? object.primaryHostname, 'site.fqdn'),
        status: string(object.status, 'site.status'),
        phpVersion: object.phpVersion === null ? null : string(object.phpVersion, 'site.phpVersion'),
        ...(hostnames === undefined ? {} : { hostnames })
    };
}

export function parseFileList(value: unknown): FileListResponse {
    const object = record(value, 'file listing');
    return {
        path: typeof object.path === 'string' ? object.path : '',
        recursive: boolean(object.recursive, 'recursive'),
        entries: array(object.entries, 'entries').map((entry, index) => parseFileEntry(entry, `entries[${index}]`))
    };
}

export function parseFilePutResult(value: unknown): FilePutResult {
    const object = record(value, 'file put result');
    return {
        created: boolean(object.created, 'created'),
        entry: parseFileEntry(object.entry, 'entry')
    };
}

export function parseFileDeleteResult(value: unknown): FileDeleteResult {
    const object = record(value, 'file delete result');
    if (object.deleted !== true) throw new CliError('Invalid file delete result', 5, 'invalid_agent_response');
    return { deleted: true, path: string(object.path, 'path') };
}

function parseFileEntry(value: unknown, field: string): ManagedFileEntry {
    const object = record(value, field);
    const type = object.type;
    if (type !== 'file' && type !== 'directory' && type !== 'symlink' && type !== 'other') {
        throw new CliError(`Invalid ${field}.type`, 5, 'invalid_agent_response');
    }
    return {
        path: string(object.path, `${field}.path`),
        type,
        size: nonNegativeInteger(object.size, `${field}.size`),
        modifiedAt: isoDate(object.modifiedAt, `${field}.modifiedAt`),
        etag: string(object.etag, `${field}.etag`)
    };
}

function safeEndpoint(value: unknown, field: string): string {
    const result = string(value, field);
    let url: URL;
    try {
        url = new URL(result);
    } catch {
        throw new CliError(`Manager returned an invalid ${field}`, 5, 'unsafe_agent_url');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new CliError(`Manager returned an invalid ${field}`, 5, 'unsafe_agent_url');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost(url.hostname))) {
        throw new CliError(`Manager returned a non-HTTPS ${field}`, 5, 'unsafe_agent_url');
    }
    return result;
}

function accessScope(value: unknown, field: string): AgentAccessScope {
    if (
        value !== 'deploy:inventory' &&
        value !== 'deploy:hash' &&
        value !== 'deploy:apply' &&
        value !== 'files:list' &&
        value !== 'files:read' &&
        value !== 'files:write' &&
        value !== 'files:delete' &&
        value !== 'download:deployable' &&
        value !== 'download:sensitive'
    ) {
        throw new CliError(`Invalid ${field}`, 5, 'invalid_manager_response');
    }
    return value;
}

function uuid(value: unknown, field: string): string {
    const result = string(value, field);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
        throw new CliError(`${field} must be a UUID`, 5, 'invalid_manager_response');
    }
    return result;
}

export function parseCapabilities(value: unknown): AgentCapabilities {
    const object = record(value, 'agent capabilities');
    const rawAlgorithms = array(object.hashAlgorithms, 'hashAlgorithms').map((item, index) => hashAlgorithm(item, `hashAlgorithms[${index}]`));
    const rawIgnores = array(object.mandatoryIgnores, 'mandatoryIgnores').map((item, index) => string(item, `mandatoryIgnores[${index}]`));
    const rawLimits = record(object.limits, 'limits');
    const result: AgentCapabilities = {
        protocolVersion: integer(object.protocolVersion, 'protocolVersion'),
        hashAlgorithms: rawAlgorithms,
        ignoreRulesetId: string(object.ignoreRulesetId, 'ignoreRulesetId'),
        mandatoryIgnores: rawIgnores,
        limits: {
            maxFiles: positiveInteger(rawLimits.maxFiles, 'limits.maxFiles'),
            maxPathBytes: positiveInteger(rawLimits.maxPathBytes, 'limits.maxPathBytes'),
            maxFileBytes: positiveInteger(rawLimits.maxFileBytes, 'limits.maxFileBytes'),
            maxUploadBytes: positiveInteger(rawLimits.maxUploadBytes, 'limits.maxUploadBytes')
        }
    };
    if (result.protocolVersion !== PROTOCOL_VERSION) {
        throw new CliError(
            `Agent supports deployment protocol ${result.protocolVersion}, but this CLI requires ${PROTOCOL_VERSION}`,
            5,
            'unsupported_protocol'
        );
    }
    return result;
}

export function parseInventoryPlan(value: unknown, fileCount: number): InventoryPlanResponse {
    const object = record(value, 'inventory plan');
    const result: InventoryPlanResponse = {
        planId: string(object.planId, 'planId'),
        expiresAt: isoDate(object.expiresAt, 'expiresAt'),
        hashAlgorithm: hashAlgorithm(object.hashAlgorithm, 'hashAlgorithm'),
        hashCandidateIndices: indices(object.hashCandidateIndices, fileCount, 'hashCandidateIndices'),
        preliminaryOperations: operations(object.preliminaryOperations)
    };
    return result;
}

export function parseFinalPlan(value: unknown, fileCount: number, expectedPlanId: string): FinalDeploymentPlan {
    const object = record(value, 'final deployment plan');
    const result: FinalDeploymentPlan = {
        planId: string(object.planId, 'planId'),
        expiresAt: isoDate(object.expiresAt, 'expiresAt'),
        operations: operations(object.operations),
        uploadIndices: indices(object.uploadIndices, fileCount, 'uploadIndices')
    };
    if (result.planId !== expectedPlanId) throw new CliError('Agent returned a mismatched plan ID', 5, 'invalid_agent_response');
    return result;
}

export function parseApplyResult(value: unknown, expectedPlanId: string): ApplyResult {
    const object = record(value, 'apply result');
    const result: ApplyResult = {
        ok: boolean(object.ok, 'ok'),
        planId: string(object.planId, 'planId'),
        created: nonNegativeInteger(object.created, 'created'),
        replaced: nonNegativeInteger(object.replaced, 'replaced'),
        deleted: nonNegativeInteger(object.deleted, 'deleted'),
        uploadedBytes: nonNegativeInteger(object.uploadedBytes, 'uploadedBytes'),
        durationMs: nonNegativeInteger(object.durationMs, 'durationMs'),
        ...(object.error === undefined ? {} : { error: string(object.error, 'error') })
    };
    if (result.planId !== expectedPlanId) throw new CliError('Agent returned a mismatched apply result', 5, 'invalid_agent_response');
    return result;
}

function operations(value: unknown): DeploymentOperation[] {
    return array(value, 'operations').map((item, index) => {
        const object = record(item, `operations[${index}]`);
        const kind = object.kind;
        if (kind !== 'create' && kind !== 'replace' && kind !== 'delete') {
            throw new CliError(`Invalid operations[${index}].kind`, 5, 'invalid_agent_response');
        }
        return {
            kind,
            path: string(object.path, `operations[${index}].path`),
            ...(object.size === undefined ? {} : { size: nonNegativeInteger(object.size, `operations[${index}].size`) }),
            ...(object.previousSize === undefined
                ? {}
                : {
                      previousSize: nonNegativeInteger(object.previousSize, `operations[${index}].previousSize`)
                  })
        };
    });
}

function indices(value: unknown, upperBound: number, field: string): number[] {
    const seen = new Set<number>();
    return array(value, field).map((item, index) => {
        const result = nonNegativeInteger(item, `${field}[${index}]`);
        if (result >= upperBound) throw new CliError(`${field}[${index}] is outside the submitted inventory`, 5, 'invalid_agent_response');
        if (seen.has(result)) throw new CliError(`${field} contains duplicate index ${result}`, 5, 'invalid_agent_response');
        seen.add(result);
        return result;
    });
}

function hashAlgorithm(value: unknown, field: string): HashAlgorithm {
    if (value !== 'xxh3-128' && value !== 'sha256') throw new CliError(`Invalid ${field}`, 5, 'invalid_agent_response');
    return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError(`Invalid ${field}`, 5, 'invalid_agent_response');
    return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
    if (!Array.isArray(value)) throw new CliError(`Invalid ${field}`, 5, 'invalid_agent_response');
    return value;
}

function string(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value) throw new CliError(`Invalid ${field}`, 5, 'invalid_agent_response');
    return value;
}

function boolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') throw new CliError(`Invalid ${field}`, 5, 'invalid_agent_response');
    return value;
}

function integer(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new CliError(`Invalid ${field}`, 5, 'invalid_agent_response');
    return value;
}

function positiveInteger(value: unknown, field: string): number {
    const result = integer(value, field);
    if (result <= 0) throw new CliError(`Invalid ${field}`, 5, 'invalid_agent_response');
    return result;
}

function nonNegativeInteger(value: unknown, field: string): number {
    const result = integer(value, field);
    if (result < 0) throw new CliError(`Invalid ${field}`, 5, 'invalid_agent_response');
    return result;
}

function isoDate(value: unknown, field: string): string {
    const result = string(value, field);
    if (!Number.isFinite(Date.parse(result))) throw new CliError(`Invalid ${field}`, 5, 'invalid_agent_response');
    return result;
}

function isLocalhost(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}
