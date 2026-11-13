import type { ManagerCredential } from '../config.js';

import { ensureFreshCredential } from '../auth/credential-refresh.js';
import { rememberDeniedPermissions } from '../auth/denied-permissions.js';
import { CliError } from '../errors.js';
import {
    AccessSession,
    AgentAccessScope,
    AutomationSite,
    PROTOCOL_VERSION,
    DeploymentSession,
    DeploymentTarget,
    PromotionAccepted,
    ReconciliationOperation,
    parsePromotionAccepted,
    parseReconciliation,
    parseAccessSession,
    parseAutomationSite,
    parseAutomationSites
} from '../protocol.js';
import { requestJson } from './http.js';

export class ManagerClient {
    constructor(
        private readonly apiUrl: string,
        private readonly credential: ManagerCredential,
        private readonly timeoutMs = 30_000
    ) {}

    async listSites(): Promise<AutomationSite[]> {
        return parseAutomationSites(
            await requestJson(`${this.apiUrl}/v1/sites`, {
                timeoutMs: this.timeoutMs,
                headers: {
                    ...(await authorizationHeaders(this.credential)),
                    Accept: 'application/json'
                }
            })
        );
    }

    async getSite(siteRef: string): Promise<AutomationSite> {
        return parseAutomationSite(
            await requestJson(`${this.apiUrl}/v1/sites/${encodeURIComponent(siteRef)}`, {
                timeoutMs: this.timeoutMs,
                headers: {
                    ...(await authorizationHeaders(this.credential)),
                    Accept: 'application/json'
                }
            })
        );
    }

    async createAccessSession(siteRef: string, scopes: AgentAccessScope[], target: DeploymentTarget = 'production'): Promise<AccessSession> {
        const requestedScopes = [...new Set(scopes)];
        const value = await requestJson(`${this.apiUrl}/v1/sites/${encodeURIComponent(siteRef)}/access-sessions`, {
            method: 'POST',
            timeoutMs: this.timeoutMs,
            headers: {
                ...(await authorizationHeaders(this.credential)),
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, scopes: requestedScopes, ...(target === 'preview' ? { target } : {}) })
        });
        const session = parseAccessSession(value);
        if ((target === 'preview' && session.target !== 'preview') || (session.target !== undefined && session.target !== target)) {
            throw new CliError(
                'Manager did not authorize the requested deployment target; update the manager before using preview',
                5,
                'invalid_manager_response'
            );
        }
        if (session.scopes.length !== requestedScopes.length || requestedScopes.some(scope => !session.scopes.includes(scope))) {
            throw new CliError('Manager returned an access session with unexpected scopes', 5, 'invalid_manager_response');
        }
        return session;
    }

    async createDeploymentSession(siteRef: string, target: DeploymentTarget = 'production'): Promise<DeploymentSession> {
        const session = await this.createAccessSession(siteRef, ['deploy:inventory', 'deploy:hash', 'deploy:apply'], target);
        const url = session.site.deployments?.[target].url;
        return {
            protocolVersion: session.protocolVersion,
            siteId: session.site.id,
            baseUrl: session.endpoints.deploy,
            accessToken: session.accessToken,
            expiresAt: session.expiresAt,
            target,
            ...(url ? { url } : {})
        };
    }

    async promoteSite(siteId: string, expectedProductionDeploymentId: string | null, force = false): Promise<PromotionAccepted> {
        const accepted = parsePromotionAccepted(
            await requestJson(`${this.apiUrl}/v1/sites/${encodeURIComponent(siteId)}/promote`, {
                method: 'POST',
                timeoutMs: this.timeoutMs,
                headers: { ...(await authorizationHeaders(this.credential)), 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ expectedProductionDeploymentId, ...(force ? { force: true } : {}) })
            })
        );
        if (accepted.result.id !== siteId) throw new CliError('Manager returned a promotion for another site', 5, 'invalid_manager_response');
        return accepted;
    }

    async getReconciliation(operationId: string): Promise<ReconciliationOperation> {
        const operation = parseReconciliation(
            await requestJson(`${this.apiUrl}/reconciliations/${encodeURIComponent(operationId)}`, {
                timeoutMs: this.timeoutMs,
                headers: { ...(await authorizationHeaders(this.credential)), Accept: 'application/json' }
            })
        );
        if (operation.id !== operationId) throw new CliError('Manager returned another reconciliation operation', 5, 'invalid_manager_response');
        return operation;
    }

    async purgeSiteCache(siteId: string): Promise<void> {
        await requestJson(`${this.apiUrl}/v1/sites/${encodeURIComponent(siteId)}/cache/purge`, {
            method: 'POST',
            timeoutMs: this.timeoutMs,
            headers: {
                ...(await authorizationHeaders(this.credential)),
                Accept: 'application/json'
            }
        });
    }
}

export async function authorizationHeaders(credential: ManagerCredential): Promise<Record<string, string>> {
    await ensureFreshCredential(credential);
    if (credential.type === 'api-key') {
        return { Authorization: `Basic ${Buffer.from(`api:${credential.apiKey}`, 'utf8').toString('base64')}` };
    }
    rememberDeniedPermissions(credential.accessToken, credential.deniedPermissionKeys);
    return { Authorization: `Bearer ${credential.accessToken}` };
}
