import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BearerCredential } from '../src/config.js';

import { attachCredentialRefresh, ensureFreshCredential, startCredentialRefreshLoop } from '../src/auth/credential-refresh.js';
import { HttpError } from '../src/errors.js';

test('uses the current access token until expiration when tenant policy refuses renewal', async () => {
    const credential: BearerCredential = {
        type: 'bearer',
        accessToken: 'current.jwt.signature',
        expiresAt: Date.now() + 60_000
    };
    let attempts = 0;
    attachCredentialRefresh(credential, async () => {
        attempts++;
        throw new HttpError('renewal forbidden', 403);
    });

    await ensureFreshCredential(credential);
    await ensureFreshCredential(credential);
    assert.equal(attempts, 1);
    credential.expiresAt = Date.now() - 1;
    await assert.rejects(ensureFreshCredential(credential), (error: unknown) => {
        return error instanceof Error && error.message.includes('no longer permits') && 'code' in error && error.code === 'renewal_forbidden';
    });
    assert.equal(attempts, 1);
});

test('treats an invalid one-time renewal credential as permanently unavailable for the current process', async () => {
    const credential: BearerCredential = {
        type: 'bearer',
        accessToken: 'current.jwt.signature',
        expiresAt: Date.now() + 60_000
    };
    let attempts = 0;
    attachCredentialRefresh(credential, async () => {
        attempts++;
        throw new HttpError('invalid renewal token', 401);
    });

    await ensureFreshCredential(credential);
    credential.expiresAt = Date.now() - 1;
    await assert.rejects(ensureFreshCredential(credential), (error: unknown) => {
        return error instanceof Error && error.message.includes('invalid or was already used') && 'code' in error && error.code === 'renewal_invalid';
    });
    assert.equal(attempts, 1);
});

test('rate-limits transient renewal failures after the access token has expired', async () => {
    const credential: BearerCredential = {
        type: 'bearer',
        accessToken: 'expired.jwt.signature',
        expiresAt: Date.now() - 1
    };
    const failure = new HttpError('temporary network failure', 0, 'network_error');
    let attempts = 0;
    attachCredentialRefresh(credential, async () => {
        attempts++;
        throw failure;
    });

    await assert.rejects(ensureFreshCredential(credential), /temporary network failure/);
    await assert.rejects(ensureFreshCredential(credential), /temporary network failure/);
    assert.equal(attempts, 1);
});

test('refreshes a renewable credential in the background while idle', async () => {
    const credential: BearerCredential = {
        type: 'bearer',
        accessToken: 'expiring.jwt.signature',
        expiresAt: Date.now() + 60_000
    };
    let resolveRefresh!: () => void;
    const refreshed = new Promise<void>(resolve => {
        resolveRefresh = resolve;
    });
    let attempts = 0;
    attachCredentialRefresh(credential, async () => {
        attempts++;
        credential.accessToken = 'renewed.jwt.signature';
        credential.expiresAt = Date.now() + 60 * 60 * 1000;
        resolveRefresh();
    });

    const stop = startCredentialRefreshLoop(credential);
    try {
        await Promise.race([refreshed, new Promise((_, reject) => setTimeout(() => reject(new Error('background refresh timed out')), 1_000))]);
        assert.equal(attempts, 1);
        assert.equal(credential.accessToken, 'renewed.jwt.signature');
    } finally {
        stop();
    }
});

test('stops background retries after a terminal invalid renewal credential', async () => {
    const credential: BearerCredential = {
        type: 'bearer',
        accessToken: 'expired.jwt.signature',
        expiresAt: Date.now() - 1
    };
    let attempts = 0;
    const errors: unknown[] = [];
    attachCredentialRefresh(credential, async () => {
        attempts++;
        throw new HttpError('invalid renewal token', 401);
    });

    const stop = startCredentialRefreshLoop(credential, {
        retryDelayMs: 5,
        onError: error => {
            errors.push(error);
        }
    });
    try {
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(attempts, 1);
        assert.equal(errors.length, 1);
        assert(errors[0] instanceof Error && 'code' in errors[0] && errors[0].code === 'renewal_invalid');
    } finally {
        stop();
    }
});

test('does not try to renew in the last minutes of the approved lifetime, and stops at its end with grant_expired', async () => {
    const grantEnd = Date.now() + 120_000;
    const credential: BearerCredential = {
        type: 'bearer',
        accessToken: 'capped.jwt.signature',
        // The server caps the access token at the grant's end, so it is inside the usual 5-minute renewal window.
        expiresAt: grantEnd,
        grantExpiresAt: grantEnd
    };
    let attempts = 0;
    attachCredentialRefresh(credential, async () => {
        attempts++;
    });
    await ensureFreshCredential(credential);
    assert.equal(attempts, 0);

    credential.expiresAt = Date.now() - 1;
    credential.grantExpiresAt = Date.now() - 1;
    await assert.rejects(ensureFreshCredential(credential), (error: unknown) => {
        return error instanceof Error && 'code' in error && error.code === 'grant_expired' && /lifetime approved on/.test(error.message);
    });
    assert.equal(attempts, 0);
});

test('a login with no recorded grant end still renews as before', async () => {
    const credential: BearerCredential = { type: 'bearer', accessToken: 'old.jwt.signature', expiresAt: Date.now() + 60_000 };
    let attempts = 0;
    attachCredentialRefresh(credential, async () => {
        attempts++;
        credential.expiresAt = Date.now() + 3_600_000;
    });
    await ensureFreshCredential(credential);
    assert.equal(attempts, 1);
});
