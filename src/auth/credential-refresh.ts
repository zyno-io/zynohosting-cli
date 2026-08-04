import type { BearerCredential, ManagerCredential } from '../config.js';

import { CliError, HttpError } from '../errors.js';

const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const RETRY_DELAY_MS = 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface RefreshState {
    refresh: () => Promise<void>;
    pending?: Promise<void>;
    unavailable?: 'invalid';
    policyDenied?: boolean;
    retryAfter?: number;
    lastError?: unknown;
}

const refreshStates = new WeakMap<BearerCredential, RefreshState>();

export function attachCredentialRefresh(credential: BearerCredential, refresh: () => Promise<void>): void {
    refreshStates.set(credential, { refresh });
}

export interface CredentialRefreshLoopOptions {
    refreshWindowMs?: number;
    retryDelayMs?: number;
    onError?: (error: unknown) => void | Promise<void>;
}

/**
 * Proactively refreshes a renewable credential while its process remains alive.
 * The timer is unref'd so this loop never extends the lifetime of a one-shot CLI command.
 */
export function startCredentialRefreshLoop(credential: ManagerCredential, options: CredentialRefreshLoopOptions = {}): () => void {
    if (credential.type !== 'bearer' || credential.expiresAt === undefined || !refreshStates.has(credential)) return () => {};

    const refreshWindowMs = options.refreshWindowMs ?? REFRESH_WINDOW_MS;
    const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;

    const schedule = (delayMs: number) => {
        if (stopped) return;
        timer = setTimeout(run, Math.min(Math.max(0, delayMs), MAX_TIMER_DELAY_MS));
        timer.unref();
    };
    const scheduleAtRefreshWindow = () => {
        const expiresAt = credential.expiresAt;
        if (expiresAt === undefined) return;
        schedule(expiresAt - Date.now() - refreshWindowMs);
    };
    const run = async () => {
        let error: unknown;
        try {
            await ensureFreshCredential(credential);
        } catch (caught) {
            error = caught;
            try {
                await options.onError?.(caught);
            } catch {
                // Reporting must not stop credential maintenance.
            }
        }
        if (stopped || (error instanceof CliError && error.code === 'renewal_invalid')) return;
        const expiresAt = credential.expiresAt;
        if (expiresAt === undefined) return;
        const untilRefreshWindow = expiresAt - Date.now() - refreshWindowMs;
        schedule(untilRefreshWindow > 0 ? untilRefreshWindow : retryDelayMs);
    };

    scheduleAtRefreshWindow();
    return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
    };
}

export async function ensureFreshCredential(credential: ManagerCredential): Promise<void> {
    if (credential.type !== 'bearer' || credential.expiresAt === undefined) return;

    const now = Date.now();
    const state = refreshStates.get(credential);
    if (credential.expiresAt > now + REFRESH_WINDOW_MS) return;
    if (!state) {
        if (credential.expiresAt <= now) throw expired();
        return;
    }
    if (state.unavailable) {
        if (credential.expiresAt <= now) throw unavailable(state.unavailable);
        return;
    }
    if (state.retryAfter && state.retryAfter > now) {
        if (credential.expiresAt > now) return;
        if (state.policyDenied) throw unavailable('policy');
        if (state.lastError) throw state.lastError;
    }

    state.pending ??= state.refresh().finally(() => {
        delete state.pending;
    });
    try {
        await state.pending;
        delete state.retryAfter;
        delete state.policyDenied;
        delete state.lastError;
    } catch (error) {
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
            delete state.lastError;
            if (error.status === 401) {
                state.unavailable = 'invalid';
                delete state.policyDenied;
            } else {
                state.policyDenied = true;
                state.retryAfter = Date.now() + RETRY_DELAY_MS;
            }
            if (credential.expiresAt > Date.now()) return;
            throw unavailable(error.status === 401 ? 'invalid' : 'policy');
        }
        delete state.policyDenied;
        state.retryAfter = Date.now() + RETRY_DELAY_MS;
        state.lastError = error;
        if (credential.expiresAt > Date.now()) return;
        throw error;
    }

    if (credential.expiresAt <= Date.now()) throw expired();
}

function expired(): CliError {
    return new CliError('Your ZynoSuite CLI login has expired. Run `zynohosting login` again.', 3, 'login_expired');
}

function unavailable(reason: 'invalid' | 'policy'): CliError {
    const message =
        reason === 'policy'
            ? 'Your tenant no longer permits this CLI token to renew. Run `zynohosting login` again or ask a tenant administrator.'
            : 'Your saved CLI renewal credential is invalid or was already used. Run `zynohosting login` again.';
    return new CliError(message, 3, reason === 'policy' ? 'renewal_forbidden' : 'renewal_invalid');
}
