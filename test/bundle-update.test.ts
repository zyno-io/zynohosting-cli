import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signPayload } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
    defaultStagingDirectory,
    signedStatement,
    isSafeVersion,
    listStagedRuntimes,
    pruneStagedRuntimes,
    RUNTIME_DIRECTORY,
    RUNTIME_FILE,
    runtimeModuleUrl,
    selectRuntime,
    sha256,
    SIGNATURE_FILE,
    stageUpdate,
    verifyPayload
} from '../src/mcp/bundle-update.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const trusted = [publicKeyPem];
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

function sign(payload: Buffer, key = keys.privateKey): Buffer {
    return signPayload('sha256', payload, key);
}

async function workspace() {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-update-'));
    return { staging: join(root, 'staging'), embedded: join(root, 'embedded.js'), root };
}

/** Put a staged runtime on disk exactly as stageUpdate would. */
async function stage(staging: string, version: string, body: string, options: { signWith?: typeof keys.privateKey; signature?: Buffer } = {}) {
    const directory = join(staging, 'versions', version);
    await mkdir(join(directory, RUNTIME_DIRECTORY), { recursive: true });
    const payload = Buffer.from(body);
    await writeFile(join(directory, RUNTIME_DIRECTORY, RUNTIME_FILE), payload);
    await writeFile(
        join(directory, RUNTIME_DIRECTORY, SIGNATURE_FILE),
        options.signature ?? sign(signedStatement(version, payload), options.signWith ?? keys.privateKey)
    );
    await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name: '@zyno-io/zynohosting', version, private: true, type: 'module' })}\n`);
    return directory;
}

function descriptorFor(version: string, payload: Buffer, signature: Buffer, digest?: string) {
    const releaseBase = `https://github.com/zyno-io/zynohosting-cli/releases/download/v${version}`;
    return {
        latest: version,
        payloadUrl: `${releaseBase}/server.js`,
        signatureUrl: `${releaseBase}/server.js.sig`,
        ...(digest === undefined ? {} : { payloadSha256: digest }),
        _payload: payload,
        _signature: signature
    };
}

/** A fetch stand-in that serves the descriptor's own payload and signature. */
function fetchServing(map: Record<string, Buffer>, status = 200): typeof fetch {
    return (async (url: string | URL) => {
        const key = String(url);
        const body = map[key];
        if (!body) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
        return {
            ok: status === 200,
            status,
            arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

test('rejects version strings that could escape the staging directory', () => {
    assert.equal(isSafeVersion('0.4.5'), true);
    assert.equal(isSafeVersion('1.2.3-canary.4'), true);
    assert.equal(isSafeVersion('../../etc'), false);
    assert.equal(isSafeVersion('0.4.5/../..'), false);
    assert.equal(isSafeVersion('/absolute'), false);
    assert.equal(isSafeVersion('..'), false);
    assert.equal(isSafeVersion(''), false);
    assert.equal(isSafeVersion('latest'), false);
});

test('places staging outside the extension directory', () => {
    const explicit = defaultStagingDirectory({ ZYNOHOSTING_MCPB_STAGING: '/tmp/custom' }, '/home/someone');
    assert.equal(explicit, '/tmp/custom');
    const derived = defaultStagingDirectory({}, '/home/someone');
    assert.ok(derived.includes('ZynoHosting'), 'staging should be namespaced');
    assert.ok(derived.startsWith('/home/someone') || derived.includes('AppData'), 'staging should live under the user profile');
});

test('verifies a payload only against the matching key', () => {
    const statement = signedStatement('1.0.0', Buffer.from('console.log("hello")'));
    assert.equal(verifyPayload(statement, sign(statement), trusted), true);
    assert.equal(verifyPayload(statement, sign(statement, otherKeys.privateKey), trusted), false, 'a foreign key must not verify');
    assert.equal(verifyPayload(Buffer.from('tampered'), sign(statement), trusted), false, 'modified material must not verify');
    assert.equal(verifyPayload(statement, Buffer.from('garbage'), trusted), false, 'a malformed signature must not throw');
});

test('runs the embedded runtime when nothing is staged', async () => {
    const { staging, embedded } = await workspace();
    const selection = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: embedded,
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(selection.embedded, true);
    assert.equal(selection.version, '0.4.5');
    assert.equal(selection.entryPoint, embedded);
});

test('prefers a newer staged runtime with a valid signature', async () => {
    const { staging, embedded } = await workspace();
    await stage(staging, '0.5.0', 'export const marker = "0.5.0";');
    const selection = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: embedded,
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(selection.embedded, false);
    assert.equal(selection.version, '0.5.0');
});

test('picks the highest staged version, not merely a newer one', async () => {
    const { staging, embedded } = await workspace();
    await stage(staging, '0.5.0', 'a');
    await stage(staging, '0.10.0', 'b');
    await stage(staging, '0.6.0', 'c');
    const selection = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: embedded,
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(selection.version, '0.10.0');
});

test('continues past a corrupt newer runtime to an older valid staged runtime', async () => {
    const { staging, embedded } = await workspace();
    await stage(staging, '0.5.0', 'export const marker = "0.5.0";');
    const newest = await stage(staging, '0.6.0', 'export const marker = "0.6.0";');
    await writeFile(join(newest, RUNTIME_DIRECTORY, RUNTIME_FILE), 'tampered');

    const selection = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: embedded,
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(selection.embedded, false);
    assert.equal(selection.version, '0.5.0');
});

test('ignores staged runtimes older than or equal to the embedded one', async () => {
    const { staging, embedded } = await workspace();
    await stage(staging, '0.3.0', 'old');
    await stage(staging, '0.4.5', 'same');
    const selection = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: embedded,
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(selection.embedded, true);
});

test('refuses a staged runtime whose payload was modified after staging', async () => {
    const { staging, embedded } = await workspace();
    const directory = await stage(staging, '0.5.0', 'export const marker = "genuine";');
    // The signature is checked on every load precisely so this is caught, rather
    // than trusting a check that happened at download time.
    await writeFile(join(directory, RUNTIME_DIRECTORY, RUNTIME_FILE), 'process.exit(1) // swapped in later');

    const selection = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: embedded,
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(selection.embedded, true, 'a tampered runtime must not be executed');
    assert.match(selection.rejected ?? '', /signature does not verify/);
});

test('imports the verified bytes even if the staged path changes afterwards', async () => {
    const { staging, embedded } = await workspace();
    const directory = await stage(staging, '0.5.0', 'export const marker = "genuine";');
    const selection = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: embedded,
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(selection.embedded, false);

    // The signature was checked already. Swapping the path now models the race
    // that exists if the launcher re-opens server.js for import.
    await writeFile(join(directory, RUNTIME_DIRECTORY, RUNTIME_FILE), 'export const marker = "swapped";');
    const moduleUrl = runtimeModuleUrl(selection);
    assert.match(moduleUrl, /^data:text\/javascript;base64,/);
    const imported = await import(moduleUrl);
    const loaded = imported as { marker: string };
    assert.equal(loaded.marker, 'genuine');
});

test('refuses oversized staged files before reading them into memory', async () => {
    const { staging, embedded } = await workspace();
    const payloadDirectory = await stage(staging, '0.5.0', 'small');
    await truncate(join(payloadDirectory, RUNTIME_DIRECTORY, RUNTIME_FILE), 64 * 1024 * 1024 + 1);

    const payloadSelection = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: embedded,
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(payloadSelection.embedded, true);
    assert.match(payloadSelection.rejected ?? '', /exceeds 67108864 bytes/);

    const signatureDirectory = await stage(staging, '0.6.0', 'small');
    await writeFile(join(signatureDirectory, RUNTIME_DIRECTORY, SIGNATURE_FILE), Buffer.alloc(64 * 1024 + 1));
    const signatureSelection = await selectRuntime({
        embeddedVersion: '0.5.0',
        embeddedEntryPoint: embedded,
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(signatureSelection.embedded, true);
    assert.match(signatureSelection.rejected ?? '', /exceeds 65536 bytes/);
});

test('refuses staged metadata that does not match the signed version or module format', async () => {
    const { staging, embedded } = await workspace();
    const wrongVersion = await stage(staging, '0.5.0', 'export const marker = true;');
    await writeFile(join(wrongVersion, 'package.json'), JSON.stringify({ version: '9.9.9', type: 'module' }));

    const wrongVersionSelection = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: embedded,
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(wrongVersionSelection.embedded, true);
    assert.match(wrongVersionSelection.rejected ?? '', /metadata version/);

    const wrongType = await stage(staging, '0.6.0', 'export const marker = true;');
    await writeFile(join(wrongType, 'package.json'), JSON.stringify({ version: '0.6.0', type: 'commonjs' }));
    const wrongTypeSelection = await selectRuntime({
        embeddedVersion: '0.5.0',
        embeddedEntryPoint: embedded,
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(wrongTypeSelection.embedded, true);
    assert.match(wrongTypeSelection.rejected ?? '', /ES module/);
});

test('refuses a staged runtime signed by a different key', async () => {
    const { staging, embedded } = await workspace();
    await stage(staging, '0.5.0', 'export const marker = "x";', { signWith: otherKeys.privateKey });
    const selection = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: embedded,
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(selection.embedded, true);
    assert.match(selection.rejected ?? '', /signature does not verify/);
});

test('refuses a staged runtime with no signature at all', async () => {
    const { staging, embedded } = await workspace();
    const directory = join(staging, 'versions', '0.5.0');
    await mkdir(join(directory, RUNTIME_DIRECTORY), { recursive: true });
    await writeFile(join(directory, RUNTIME_DIRECTORY, RUNTIME_FILE), 'export const marker = "unsigned";');

    const selection = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: embedded,
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(selection.embedded, true);
    assert.match(selection.rejected ?? '', /unreadable/);
});

test('ignores directories whose names are not plain versions', async () => {
    const { staging } = await workspace();
    await mkdir(join(staging, 'versions', 'not-a-version'), { recursive: true });
    await mkdir(join(staging, 'versions', '9.9.9'), { recursive: true });
    const staged = await listStagedRuntimes(staging);
    assert.deepEqual(
        staged.map(entry => entry.version),
        ['9.9.9']
    );
});

test('stages a signed newer release', async () => {
    const { staging } = await workspace();
    const payload = Buffer.from('export const marker = "0.6.0";');
    const signature = sign(signedStatement('0.6.0', payload));
    const descriptor = descriptorFor('0.6.0', payload, signature);

    const outcome = await stageUpdate({
        descriptor,
        currentVersion: '0.4.5',
        stagingDirectory: staging,
        publicKeyPems: trusted,
        packageName: '@zyno-io/zynohosting',
        fetchImpl: fetchServing({ [descriptor.payloadUrl]: payload, [descriptor.signatureUrl]: signature })
    });

    assert.equal(outcome.status, 'staged');
    const directory = join(staging, 'versions', '0.6.0');
    assert.equal((await readFile(join(directory, RUNTIME_DIRECTORY, RUNTIME_FILE))).toString(), payload.toString());
    // The runtime reads ../package.json for its version, so it must be written too.
    const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { version: string; type: string };
    assert.equal(metadata.version, '0.6.0');
    assert.equal(metadata.type, 'module');

    // And it must be selectable straight away.
    const selection = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: '/embedded.js',
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(selection.version, '0.6.0');
});

test('refuses to stage a payload signed by a different key', async () => {
    const { staging } = await workspace();
    const payload = Buffer.from('export const marker = "evil";');
    const signature = sign(signedStatement('0.6.0', payload), otherKeys.privateKey);
    const descriptor = descriptorFor('0.6.0', payload, signature);

    const outcome = await stageUpdate({
        descriptor,
        currentVersion: '0.4.5',
        stagingDirectory: staging,
        publicKeyPems: trusted,
        packageName: '@zyno-io/zynohosting',
        fetchImpl: fetchServing({ [descriptor.payloadUrl]: payload, [descriptor.signatureUrl]: signature })
    });

    assert.equal(outcome.status, 'failed');
    assert.match((outcome as { reason: string }).reason, /signature does not verify/);
    assert.deepEqual(await listStagedRuntimes(staging), [], 'nothing may be written when verification fails');
});

test('refuses to stage when the digest does not match the descriptor', async () => {
    const { staging } = await workspace();
    const payload = Buffer.from('export const marker = "0.6.0";');
    const signature = sign(signedStatement('0.6.0', payload));
    const descriptor = descriptorFor('0.6.0', payload, signature, 'a'.repeat(64));

    const outcome = await stageUpdate({
        descriptor,
        currentVersion: '0.4.5',
        stagingDirectory: staging,
        publicKeyPems: trusted,
        packageName: '@zyno-io/zynohosting',
        fetchImpl: fetchServing({ [descriptor.payloadUrl]: payload, [descriptor.signatureUrl]: signature })
    });

    assert.equal(outcome.status, 'failed');
    assert.match((outcome as { reason: string }).reason, /digest/);
    assert.deepEqual(await listStagedRuntimes(staging), []);
});

test('does nothing when already current or newer', async () => {
    const { staging } = await workspace();
    const payload = Buffer.from('x');
    const descriptor = descriptorFor('0.4.5', payload, sign(signedStatement('0.4.5', payload)));
    const outcome = await stageUpdate({
        descriptor,
        currentVersion: '0.4.5',
        stagingDirectory: staging,
        publicKeyPems: trusted,
        packageName: 'p',
        fetchImpl: () => {
            throw new Error('must not download when already current');
        }
    });
    assert.equal(outcome.status, 'current');
});

test('is inert when the descriptor is unusable', async () => {
    const { staging } = await workspace();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{}, /no usable version/],
        [{ latest: '../evil' }, /no usable version/],
        [{ latest: '9.9.9' }, /no payload/]
    ];
    for (const [descriptor, expected] of cases) {
        const outcome = await stageUpdate({
            descriptor,
            currentVersion: '0.4.5',
            stagingDirectory: staging,
            publicKeyPems: trusted,
            packageName: 'p',
            fetchImpl: () => {
                throw new Error('must not download');
            }
        });
        assert.equal(outcome.status, 'skipped');
        assert.match((outcome as { reason: string }).reason, expected);
    }
});

test('reports a download failure without throwing', async () => {
    const { staging } = await workspace();
    const payload = Buffer.from('x');
    const descriptor = descriptorFor('0.6.0', payload, sign(signedStatement('0.6.0', payload)));
    const outcome = await stageUpdate({
        descriptor,
        currentVersion: '0.4.5',
        stagingDirectory: staging,
        publicKeyPems: trusted,
        packageName: 'p',
        fetchImpl: fetchServing({})
    });
    assert.equal(outcome.status, 'failed');
    assert.match((outcome as { reason: string }).reason, /404/);
    assert.deepEqual(await listStagedRuntimes(staging), []);
});

test('survives an unwritable staging directory', async () => {
    const { staging } = await workspace();
    await mkdir(staging, { recursive: true });
    await chmod(staging, 0o500);
    const payload = Buffer.from('export const marker = "0.6.0";');
    const signature = sign(signedStatement('0.6.0', payload));
    const descriptor = descriptorFor('0.6.0', payload, signature);

    try {
        const outcome = await stageUpdate({
            descriptor,
            currentVersion: '0.4.5',
            stagingDirectory: staging,
            publicKeyPems: trusted,
            packageName: 'p',
            fetchImpl: fetchServing({ [descriptor.payloadUrl]: payload, [descriptor.signatureUrl]: signature })
        });
        assert.equal(outcome.status, 'failed', 'a read-only staging directory must not throw');
    } finally {
        await chmod(staging, 0o700);
    }
});

test('staging the same version twice is a no-op', async () => {
    const { staging } = await workspace();
    const payload = Buffer.from('export const marker = "0.6.0";');
    const signature = sign(signedStatement('0.6.0', payload));
    const descriptor = descriptorFor('0.6.0', payload, signature);
    const options = {
        descriptor,
        currentVersion: '0.4.5',
        stagingDirectory: staging,
        publicKeyPems: trusted,
        packageName: 'p',
        fetchImpl: fetchServing({ [descriptor.payloadUrl]: payload, [descriptor.signatureUrl]: signature })
    };

    assert.equal((await stageUpdate(options)).status, 'staged');
    assert.equal((await stageUpdate(options)).status, 'current', 'a second pass must not redownload');
    assert.equal((await readdir(join(staging, 'versions'))).length, 1);
});

test('two concurrent stagings of the same version settle without error', async () => {
    const { staging } = await workspace();
    const payload = Buffer.from('export const marker = "0.6.0";');
    const signature = sign(signedStatement('0.6.0', payload));
    const descriptor = descriptorFor('0.6.0', payload, signature);
    const options = {
        descriptor,
        currentVersion: '0.4.5',
        stagingDirectory: staging,
        publicKeyPems: trusted,
        packageName: 'p',
        fetchImpl: fetchServing({ [descriptor.payloadUrl]: payload, [descriptor.signatureUrl]: signature })
    };

    // Two Claude sessions can run the same extension at once.
    const outcomes = await Promise.all([stageUpdate(options), stageUpdate(options)]);
    assert.ok(
        outcomes.every(outcome => outcome.status === 'staged' || outcome.status === 'current'),
        `unexpected outcomes: ${JSON.stringify(outcomes)}`
    );
    assert.equal((await readdir(join(staging, 'versions'))).length, 1);
    const selection = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: '/embedded.js',
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(selection.version, '0.6.0', 'the staged runtime must still verify after a race');
});

test('staged metadata stays one level above the runtime', async () => {
    const { staging } = await workspace();
    // Preserve the same relationship as the bundle for validation, inspection,
    // and compatibility with payloads that consult their adjacent metadata.
    const payload = Buffer.from(
        "export const version = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8')).version;\n"
    );
    const signature = sign(signedStatement('0.6.0', payload));
    const descriptor = descriptorFor('0.6.0', payload, signature);

    const outcome = await stageUpdate({
        descriptor,
        currentVersion: '0.4.5',
        stagingDirectory: staging,
        publicKeyPems: trusted,
        packageName: '@zyno-io/zynohosting',
        fetchImpl: fetchServing({ [descriptor.payloadUrl]: payload, [descriptor.signatureUrl]: signature })
    });
    assert.equal(outcome.status, 'staged');

    const selection = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: '/embedded.js',
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    const loaded = (await import(pathToFileURL(selection.entryPoint).href)) as { version: string };
    assert.equal(loaded.version, '0.6.0', 'the staged runtime must read its own metadata, not a sibling');
});

test('prunes runtimes older than the one in use', async () => {
    const { staging } = await workspace();
    await stage(staging, '0.5.0', 'a');
    await stage(staging, '0.6.0', 'b');
    await stage(staging, '0.7.0', 'c');

    const removed = await pruneStagedRuntimes(staging, '0.6.0');
    assert.deepEqual(removed.sort(), ['0.5.0']);
    const remaining = (await listStagedRuntimes(staging)).map(entry => entry.version).sort();
    assert.deepEqual(remaining, ['0.6.0', '0.7.0']);
});

test('accepts a payload signed by any trusted key, so a signing key can be rotated', async () => {
    // Trust cannot be added to launchers already installed. During a manual
    // migration, a newly installed bundle can trust both the outgoing and
    // incoming keys while release signing moves to the incoming one.
    const incoming = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const incomingPem = incoming.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const during = [publicKeyPem, incomingPem];

    const payload = Buffer.from('export const marker = "rotated";');
    const statement = signedStatement('1.0.0', payload);
    assert.equal(verifyPayload(statement, sign(statement), during), true, 'the outgoing key must keep working');
    assert.equal(verifyPayload(statement, sign(statement, incoming.privateKey), during), true, 'the incoming key must be accepted');

    // An old install rejects the incoming key and must be replaced manually.
    assert.equal(verifyPayload(statement, sign(statement, incoming.privateKey), [publicKeyPem]), false);
});

test('a staged runtime signed by the incoming key loads once trust includes it', async () => {
    const incoming = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const incomingPem = incoming.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const { staging, embedded } = await workspace();
    await stage(staging, '0.7.0', 'export const marker = "new key";', { signWith: incoming.privateKey });

    const beforeRotation = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: embedded,
        stagingDirectory: staging,
        publicKeyPems: [publicKeyPem]
    });
    assert.equal(beforeRotation.embedded, true, 'an untrusted key must be refused');

    const afterRotation = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: embedded,
        stagingDirectory: staging,
        publicKeyPems: [publicKeyPem, incomingPem]
    });
    assert.equal(afterRotation.version, '0.7.0', 'the same runtime must load once its key is trusted');
});

test('an empty trust set verifies nothing', async () => {
    const statement = signedStatement('1.0.0', Buffer.from('anything'));
    assert.equal(verifyPayload(statement, sign(statement), []), false);
});

test('refuses a payload that exceeds the size cap as it streams', async () => {
    const { staging } = await workspace();
    const oversized = 'x'.repeat(1024);
    // Declares a plausible length, then streams far more than the cap.
    const flooding: typeof fetch = (async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
            async *[Symbol.asyncIterator]() {
                for (let index = 0; index < 200_000; index++) yield new TextEncoder().encode(oversized);
            }
        }
    })) as unknown as typeof fetch;

    const descriptor = descriptorFor('0.6.0', Buffer.alloc(0), Buffer.alloc(0));
    const outcome = await stageUpdate({
        descriptor,
        currentVersion: '0.4.5',
        stagingDirectory: staging,
        publicKeyPems: trusted,
        packageName: 'p',
        fetchImpl: flooding
    });

    assert.equal(outcome.status, 'failed');
    assert.match((outcome as { reason: string }).reason, /exceeded/);
});

test('refuses a payload whose declared length exceeds the cap', async () => {
    const { staging } = await workspace();
    const lying: typeof fetch = (async () => ({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === 'content-length' ? String(1024 ** 4) : null) },
        arrayBuffer: async () => new ArrayBuffer(0)
    })) as unknown as typeof fetch;

    const descriptor = descriptorFor('0.6.0', Buffer.alloc(0), Buffer.alloc(0));
    const outcome = await stageUpdate({
        descriptor,
        currentVersion: '0.4.5',
        stagingDirectory: staging,
        publicKeyPems: trusted,
        packageName: 'p',
        fetchImpl: lying
    });

    assert.equal(outcome.status, 'failed');
    assert.match((outcome as { reason: string }).reason, /declared/);
});

test('refuses an older signed runtime replayed under a higher version', async () => {
    // The descriptor is an ordinary release asset and is not signed. If the
    // signature covered only the payload bytes, anyone able to serve a forged
    // descriptor could advertise a genuinely signed but older runtime as the
    // newest release and walk installs backwards onto known-vulnerable code.
    const { staging } = await workspace();
    const oldPayload = Buffer.from('export const marker = "0.4.0 with a known bug";');
    const genuineOldSignature = sign(signedStatement('0.4.0', oldPayload));
    const descriptor = descriptorFor('99.0.0', oldPayload, genuineOldSignature, sha256(oldPayload));

    const outcome = await stageUpdate({
        descriptor,
        currentVersion: '0.5.0',
        stagingDirectory: staging,
        publicKeyPems: trusted,
        packageName: 'p',
        fetchImpl: fetchServing({ [descriptor.payloadUrl]: oldPayload, [descriptor.signatureUrl]: genuineOldSignature })
    });

    assert.equal(outcome.status, 'failed');
    assert.match((outcome as { reason: string }).reason, /does not verify for this version/);
    assert.deepEqual(await listStagedRuntimes(staging), [], 'the replayed runtime must not be written');
});

test('never requests descriptor-controlled hosts', async () => {
    const { staging } = await workspace();
    const requested: string[] = [];
    const outcome = await stageUpdate({
        descriptor: {
            latest: '0.6.0',
            payloadUrl: 'http://127.0.0.1:8080/admin',
            signatureUrl: 'https://example.test/server.js.sig'
        },
        currentVersion: '0.4.5',
        stagingDirectory: staging,
        publicKeyPems: trusted,
        packageName: 'p',
        fetchImpl: (async (url: string | URL) => {
            requested.push(String(url));
            throw new Error('must not fetch an untrusted URL');
        }) as typeof fetch
    });

    assert.equal(outcome.status, 'skipped');
    assert.deepEqual(requested, []);
    assert.match((outcome as { reason: string }).reason, /not trusted/);
});

test('validates redirect destinations before requesting them', async () => {
    const { staging } = await workspace();
    const payload = Buffer.from('export const marker = "0.6.0";');
    const signature = sign(signedStatement('0.6.0', payload));
    const descriptor = descriptorFor('0.6.0', payload, signature);
    const requested: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
        requested.push(String(url));
        return {
            ok: false,
            status: 302,
            headers: { get: (name: string) => (name === 'location' ? 'http://localhost:8080/internal' : null) }
        } as unknown as Response;
    }) as typeof fetch;

    const outcome = await stageUpdate({
        descriptor,
        currentVersion: '0.4.5',
        stagingDirectory: staging,
        publicKeyPems: trusted,
        packageName: 'p',
        fetchImpl
    });

    assert.equal(outcome.status, 'failed');
    assert.ok(requested.length > 0);
    assert.equal(
        requested.some(url => url.startsWith('http://localhost')),
        false,
        'the redirect target must be rejected before fetch'
    );
    assert.match((outcome as { reason: string }).reason, /untrusted update URL/);
});

test('follows only GitHub release-asset redirects', async () => {
    const { staging } = await workspace();
    const payload = Buffer.from('export const marker = "0.6.0";');
    const signature = sign(signedStatement('0.6.0', payload));
    const descriptor = descriptorFor('0.6.0', payload, signature);
    const redirects = new Map([
        [descriptor.payloadUrl, 'https://release-assets.githubusercontent.com/github-production-release-asset/123/payload?token=one'],
        [descriptor.signatureUrl, 'https://release-assets.githubusercontent.com/github-production-release-asset/123/signature?token=two']
    ]);
    const bodies = new Map([
        [redirects.get(descriptor.payloadUrl), payload],
        [redirects.get(descriptor.signatureUrl), signature]
    ]);
    const fetchImpl = (async (url: string | URL) => {
        const href = String(url);
        const location = redirects.get(href);
        if (location) {
            return { ok: false, status: 302, headers: { get: (name: string) => (name === 'location' ? location : null) } } as unknown as Response;
        }
        const body = bodies.get(href);
        if (!body) return { ok: false, status: 404 } as Response;
        return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
        } as unknown as Response;
    }) as typeof fetch;

    const outcome = await stageUpdate({
        descriptor,
        currentVersion: '0.4.5',
        stagingDirectory: staging,
        publicKeyPems: trusted,
        packageName: 'p',
        fetchImpl
    });

    assert.equal(outcome.status, 'staged');
});

test('refuses a staged runtime moved into a higher version directory', async () => {
    // The same binding, checked at load: renaming versions/0.5.0 to versions/9.9.9
    // must not promote it, because the statement is rebuilt from the directory name.
    const { staging, embedded } = await workspace();
    const payload = Buffer.from('export const marker = "genuine 0.5.0";');
    const directory = join(staging, 'versions', '9.9.9');
    await mkdir(join(directory, RUNTIME_DIRECTORY), { recursive: true });
    await writeFile(join(directory, RUNTIME_DIRECTORY, RUNTIME_FILE), payload);
    await writeFile(join(directory, RUNTIME_DIRECTORY, SIGNATURE_FILE), sign(signedStatement('0.5.0', payload)));

    const selection = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: embedded,
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(selection.embedded, true, 'a relabelled runtime must not be executed');
    assert.match(selection.rejected ?? '', /signature does not verify/);
});

test('re-stages a corrupted runtime instead of treating it as current', async () => {
    // selectRuntime rejects a corrupted directory and falls back. If staging then
    // treated its mere presence as current, it would never be repaired for as
    // long as that release stayed newest.
    const { staging } = await workspace();
    const directory = await stage(staging, '0.6.0', 'export const marker = "genuine";');
    await writeFile(join(directory, RUNTIME_DIRECTORY, RUNTIME_FILE), 'corrupted');

    const payload = Buffer.from('export const marker = "genuine";');
    const signature = sign(signedStatement('0.6.0', payload));
    const descriptor = descriptorFor('0.6.0', payload, signature);
    const outcome = await stageUpdate({
        descriptor,
        currentVersion: '0.4.5',
        stagingDirectory: staging,
        publicKeyPems: trusted,
        packageName: 'p',
        fetchImpl: fetchServing({ [descriptor.payloadUrl]: payload, [descriptor.signatureUrl]: signature })
    });

    assert.equal(outcome.status, 'staged', 'a corrupted staged runtime must be replaced, not accepted');
    const selection = await selectRuntime({
        embeddedVersion: '0.4.5',
        embeddedEntryPoint: '/embedded.js',
        stagingDirectory: staging,
        publicKeyPems: trusted
    });
    assert.equal(selection.version, '0.6.0', 'the repaired runtime must verify');
});
