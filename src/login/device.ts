import { setTimeout as sleep } from 'node:timers/promises';

import type { DeviceCredential, DevicePoll, DeviceStart, DeviceStartRequest, ScopedTokenClient } from '../api/scoped-token-client.js';

import { CliError, HttpError } from '../errors.js';

export type DeviceLoginClient = Pick<ScopedTokenClient, 'startDevice' | 'pollDevice' | 'cancelDevice'>;

export interface DeviceApproval {
    credential: DeviceCredential;
    approvedBy?: { email?: string | undefined; tenantName?: string | undefined } | undefined;
}

export interface DevicePollOptions {
    client: Pick<ScopedTokenClient, 'pollDevice' | 'cancelDevice'>;
    deviceCode: string;
    /** Seconds between polls, as the server asked. */
    interval: number;
    /** What the sign-in asked for, so a mismatching credential is rejected. */
    expectation: { renewable: boolean; permissionKeys: string[] };
    signal?: AbortSignal | undefined;
    /** Epoch milliseconds. When it passes, polling stops with `login_timeout` (or `login_pending` when `keepPendingOnTimeout`). */
    deadline?: number | undefined;
    /** Epoch milliseconds after which an unanswered code is given up on, however the server keeps answering. */
    giveUpAt: number;
    /** Leave the code alive on a timeout, so `--resume` can continue. */
    keepPendingOnTimeout?: boolean | undefined;
    /** Start from an earlier run's uncertain state (a resumed sign-in). */
    uncertain?: boolean | undefined;
    /** Called when the uncertain state changes, so it can be saved for a later `--resume`. */
    onUncertainChange?: ((uncertain: boolean) => void | Promise<void>) | undefined;
}

const MIN_INTERVAL_SECS = 0.001;
const MAX_INTERVAL_SECS = 60;
const SLOW_DOWN_STEP_SECS = 5;
const MAX_BACKOFF_MS = 60_000;

/** One answer to a poll, whatever is being approved. */
export type ApprovalPoll<T> =
    | { status: 'pending' | 'slow_down'; interval?: number | undefined }
    | { status: 'denied' | 'expired' | 'consumed' }
    | { status: 'approved'; value: T };

/** The errors a poll loop can end with, worded for what is being approved. */
export interface ApprovalErrors {
    cancelled(): CliError;
    denied(): CliError;
    /** Polling timed out and the code was cancelled. */
    timeout(): CliError;
    /** Polling timed out and the code was kept for a later `--resume`. */
    pending(): CliError;
    /** The code ran out before anyone approved it. */
    codeExpired(): CliError;
    /** The server said `expired` (or `consumed`) with no uncertain poll before it. */
    expiredOrUsed(): CliError;
    /** The server said `expired` after a poll that may have been the one that delivered the secret. */
    lost(): CliError;
}

export interface ApprovalPollOptions<T> {
    poll(): Promise<ApprovalPoll<T>>;
    cancel(): Promise<void>;
    errors: ApprovalErrors;
    /** Seconds between polls, as the server asked. */
    interval: number;
    signal?: AbortSignal | undefined;
    /** Epoch milliseconds. When it passes, polling stops with `timeout` (or `pending` when `keepPendingOnTimeout`). */
    deadline?: number | undefined;
    /** Epoch milliseconds after which an unanswered code is given up on, however the server keeps answering. */
    giveUpAt: number;
    keepPendingOnTimeout?: boolean | undefined;
    uncertain?: boolean | undefined;
    onUncertainChange?: ((uncertain: boolean) => void | Promise<void>) | undefined;
}

/**
 * Polls until the person approves, denies, or the code ends. A poll that fails in transit might have been the one that
 * handed over the credential, so a later `expired` after such a failure is reported as `lost` rather than as an
 * ordinary expiry. Shared by the device sign-in and by key requests.
 */
export async function pollApproval<T>(options: ApprovalPollOptions<T>): Promise<T> {
    let interval = clampInterval(options.interval);
    let uncertain = options.uncertain ?? false;
    const setUncertain = async (value: boolean) => {
        if (value === uncertain) return;
        uncertain = value;
        await Promise.resolve(options.onUncertainChange?.(value)).catch(() => {});
    };
    let failures = 0;
    let waitMs = interval * 1000;

    const stop = async (error: CliError, cancel: boolean): Promise<never> => {
        if (cancel) await options.cancel().catch(() => {});
        throw error;
    };

    for (;;) {
        if (options.signal?.aborted) await stop(options.errors.cancelled(), true);
        const now = Date.now();
        if (options.deadline !== undefined && now >= options.deadline) {
            if (options.keepPendingOnTimeout) throw options.errors.pending();
            await stop(options.errors.timeout(), true);
        }
        if (now >= options.giveUpAt) {
            await stop(uncertain ? options.errors.lost() : options.errors.codeExpired(), false);
        }

        const limit = Math.min(options.deadline ?? Infinity, options.giveUpAt) - now;
        try {
            await sleep(Math.max(0, Math.min(waitMs, limit)), undefined, options.signal ? { signal: options.signal } : undefined);
        } catch {
            await stop(options.errors.cancelled(), true);
        }
        if (Date.now() >= (options.deadline ?? Infinity) || Date.now() >= options.giveUpAt) continue;

        let poll: ApprovalPoll<T>;
        try {
            poll = await options.poll();
        } catch (error) {
            if (error instanceof HttpError && error.status === 429) {
                interval = Math.min(MAX_INTERVAL_SECS, interval + SLOW_DOWN_STEP_SECS);
                waitMs = interval * 1000;
                continue;
            }
            if (error instanceof HttpError && (error.status === 0 || error.status === 408 || error.status >= 500)) {
                await setUncertain(true);
                failures++;
                waitMs = Math.min(MAX_BACKOFF_MS, interval * 1000 * 2 ** Math.min(failures, 6));
                continue;
            }
            throw error;
        }

        switch (poll.status) {
            case 'approved':
                return poll.value;
            case 'denied':
                throw options.errors.denied();
            case 'expired':
            case 'consumed':
                throw uncertain ? options.errors.lost() : options.errors.expiredOrUsed();
            case 'slow_down':
                interval = clampInterval(poll.interval ?? interval + SLOW_DOWN_STEP_SECS);
                break;
            case 'pending':
                if (poll.interval !== undefined) interval = clampInterval(poll.interval);
                break;
        }
        await setUncertain(false);
        failures = 0;
        waitMs = interval * 1000;
    }
}

/** Polls a device sign-in. The device code never leaves this function except in the poll and cancel requests. */
export async function pollDeviceApproval(options: DevicePollOptions): Promise<DeviceApproval> {
    return pollApproval<DeviceApproval>({
        poll: async () => {
            const poll: DevicePoll = await options.client.pollDevice(options.deviceCode, options.expectation);
            return poll.status === 'approved' ? { status: 'approved', value: { credential: poll.credential, approvedBy: poll.approvedBy } } : poll;
        },
        cancel: () => options.client.cancelDevice(options.deviceCode),
        errors: {
            cancelled: () => new CliError('Sign-in was cancelled', 3, 'login_cancelled'),
            denied: () => new CliError('The sign-in request was denied.', 3, 'login_denied'),
            timeout: () => new CliError('Timed out waiting for sign-in approval', 3, 'login_timeout'),
            pending: () => new CliError('Still waiting for approval. Run `zynohosting login --resume` to keep waiting.', 3, 'login_pending'),
            codeExpired: () =>
                new CliError('The sign-in code expired before it was approved. Run `zynohosting login` again.', 3, 'device_code_expired'),
            expiredOrUsed: () =>
                new CliError('The sign-in code expired or was already used. Run `zynohosting login` again.', 3, 'device_code_expired'),
            lost: () =>
                new CliError(
                    'The connection dropped while the approved sign-in was being delivered, so the credential was lost. Run `zynohosting login` again.',
                    3,
                    'device_credential_lost'
                )
        },
        interval: options.interval,
        signal: options.signal,
        deadline: options.deadline,
        giveUpAt: options.giveUpAt,
        keepPendingOnTimeout: options.keepPendingOnTimeout,
        uncertain: options.uncertain,
        onUncertainChange: options.onUncertainChange
    });
}

function clampInterval(seconds: number): number {
    return Math.min(MAX_INTERVAL_SECS, Math.max(MIN_INTERVAL_SECS, seconds));
}

export interface DeviceLoginOptions {
    client: DeviceLoginClient;
    request: DeviceStartRequest;
    signal?: AbortSignal | undefined;
    /** Epoch milliseconds; the default is to wait until the code expires. */
    deadline?: number | undefined;
    /** Called once with the link and code, before polling starts. */
    onPrompt: (start: DeviceStart) => void | Promise<void>;
}

/** Starts a device sign-in, shows the prompt, and waits for the approval. */
export async function runDeviceLogin(options: DeviceLoginOptions): Promise<DeviceApproval & { start: DeviceStart }> {
    const start = await options.client.startDevice(options.request);
    try {
        await options.onPrompt(start);
    } catch (error) {
        await options.client.cancelDevice(start.deviceCode).catch(() => {});
        throw error;
    }
    const approval = await pollDeviceApproval({
        client: options.client,
        deviceCode: start.deviceCode,
        interval: start.interval,
        expectation: { renewable: options.request.renewable, permissionKeys: options.request.permissionKeys },
        signal: options.signal,
        deadline: options.deadline,
        // The server stretches an approved code's life to let the credential be picked up, so allow it some grace.
        giveUpAt: start.expiresAt + 150_000
    });
    return { ...approval, start };
}
