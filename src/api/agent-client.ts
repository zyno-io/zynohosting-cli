import { gzipSync } from 'node:zlib';

import {
    AgentCapabilities,
    ApplyResult,
    FinalDeploymentPlan,
    HashSubmission,
    InventoryPlanResponse,
    InventoryRequest,
    PROTOCOL_VERSION,
    parseApplyResult,
    parseCapabilities,
    parseFinalPlan,
    parseInventoryPlan
} from '../protocol.js';
import { requestJson } from './http.js';

export class AgentClient {
    constructor(
        baseUrl: string,
        private readonly token: string,
        private readonly timeoutMs = 600_000
    ) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
    }

    private readonly baseUrl: string;

    async capabilities(): Promise<AgentCapabilities> {
        return parseCapabilities(
            await requestJson(`${this.baseUrl}/capabilities`, {
                headers: this.headers(),
                timeoutMs: this.timeoutMs
            })
        );
    }

    async createPlan(inventory: InventoryRequest): Promise<InventoryPlanResponse> {
        const body = gzipSync(Buffer.from(JSON.stringify(inventory), 'utf8'));
        return parseInventoryPlan(
            await requestJson(`${this.baseUrl}/inventory`, {
                method: 'POST',
                headers: this.headers({
                    'Content-Type': 'application/json',
                    'Content-Encoding': 'gzip'
                }),
                body,
                timeoutMs: this.timeoutMs
            }),
            inventory.files.length
        );
    }

    async submitHashes(planId: string, submission: HashSubmission, fileCount: number): Promise<FinalDeploymentPlan> {
        return parseFinalPlan(
            await requestJson(`${this.baseUrl}/plans/${encodeURIComponent(planId)}/hashes`, {
                method: 'POST',
                headers: this.headers({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(submission),
                timeoutMs: this.timeoutMs
            }),
            fileCount,
            planId
        );
    }

    async apply(planId: string, archive: NodeJS.ReadableStream, timeoutMs: number): Promise<ApplyResult> {
        return parseApplyResult(
            await requestJson(`${this.baseUrl}/plans/${encodeURIComponent(planId)}/apply`, {
                method: 'PUT',
                headers: this.headers({
                    'Content-Type': 'application/vnd.zyno.deploy.tar',
                    'Content-Encoding': 'gzip',
                    'X-ZH-Deploy-Protocol': String(PROTOCOL_VERSION),
                    // One release of dual-send keeps the CLI usable while cluster agents roll.
                    'X-Zyno-Deploy-Protocol': String(PROTOCOL_VERSION)
                }),
                body: archive,
                timeoutMs
            }),
            planId
        );
    }

    private headers(additional: Record<string, string> = {}): Record<string, string> {
        return {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
            ...additional
        };
    }
}
