import { z } from 'zod';

import { CliError } from '../errors.js';
import { requestJson } from './http.js';

const renewedCredentialSchema = z.object({
    jwt: z
        .string()
        .min(1)
        .max(12 * 1024)
        .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    expiresAt: z
        .number()
        .int()
        .positive()
        .refine(value => value > Date.now() && value <= Date.now() + 2 * 60 * 60 * 1000, 'must be a future access-token expiration'),
    renewalToken: z
        .string()
        .startsWith('zrt_')
        .regex(/^zrt_[A-Za-z0-9_-]+$/)
        .max(16 * 1024)
});

export interface RenewedScopedCredential {
    jwt: string;
    expiresAt: number;
    renewalToken: string;
}

export class ScopedTokenClient {
    constructor(
        private readonly apiUrl: string,
        private readonly timeoutMs = 30_000
    ) {}

    async renew(renewalToken: string): Promise<RenewedScopedCredential> {
        if (!/^zrt_[A-Za-z0-9_-]+$/.test(renewalToken) || renewalToken.length > 16 * 1024) {
            throw new CliError('The saved renewal credential is invalid', 3, 'invalid_renewal_credential');
        }
        const value = await requestJson(`${this.apiUrl}/identity/scoped-tokens/renew`, {
            method: 'POST',
            timeoutMs: this.timeoutMs,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ renewalToken })
        });
        const parsed = renewedCredentialSchema.safeParse(value);
        if (parsed.success) return parsed.data;
        throw new CliError(`ZynoAuth returned an invalid renewal response: ${z.prettifyError(parsed.error)}`, 5, 'invalid_auth_response');
    }

    async revoke(accessToken: string): Promise<void> {
        await requestJson(`${this.apiUrl}/identity/scoped-tokens/revoke`, {
            method: 'POST',
            timeoutMs: this.timeoutMs,
            headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` }
        });
    }
}
