import type { ManagerCredential } from '../config.js';

import { ensureFreshCredential } from '../auth/credential-refresh.js';
import { CliError } from '../errors.js';
import {
    AccessSession,
    AgentAccessScope,
    AutomationSite,
    PROTOCOL_VERSION,
    DeploymentSession,
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

    async createAccessSession(siteRef: string, scopes: AgentAccessScope[]): Promise<AccessSession> {
        const requestedScopes = [...new Set(scopes)];
        const value = await requestJson(`${this.apiUrl}/v1/sites/${encodeURIComponent(siteRef)}/access-sessions`, {
            method: 'POST',
            timeoutMs: this.timeoutMs,
            headers: {
                ...(await authorizationHeaders(this.credential)),
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, scopes: requestedScopes })
        });
        const session = parseAccessSession(value);
        if (session.scopes.length !== requestedScopes.length || requestedScopes.some(scope => !session.scopes.includes(scope))) {
            throw new CliError('Manager returned an access session with unexpected scopes', 5, 'invalid_manager_response');
        }
        return session;
    }

    async createDeploymentSession(siteRef: string): Promise<DeploymentSession> {
        const session = await this.createAccessSession(siteRef, ['deploy:inventory', 'deploy:hash', 'deploy:apply']);
        return {
            protocolVersion: session.protocolVersion,
            siteId: session.site.id,
            baseUrl: session.endpoints.deploy,
            accessToken: session.accessToken,
            expiresAt: session.expiresAt
        };
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
    return { Authorization: `Bearer ${credential.accessToken}` };
}
