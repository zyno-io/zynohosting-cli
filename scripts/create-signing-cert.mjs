#!/usr/bin/env node
/**
 * Create the long-lived self-signed certificate used to sign .mcpb bundles.
 *
 * Run once. The point is a stable publisher identity across releases:
 * `mcpb sign --self-signed` mints a throwaway certificate on every run, with a
 * placeholder subject, no Code Signing extended key usage, and CA:TRUE, so the
 * publisher and fingerprint change with each build and no trust store can
 * usefully anchor it.
 *
 * Self-signing does not by itself produce a trusted bundle: verification runs
 * the certificate against the OS trust store, and an untrusted chain reports as
 * unsigned. What it does give you is tamper-evidence, one fingerprint to
 * publish, and a certificate an organization can deploy to its own trust store.
 */
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const directory = process.env.MCPB_SIGN_DIR ?? join(homedir(), '.config', 'zynohosting', 'signing');
const certPath = join(directory, 'mcpb-cert.pem');
const keyPath = join(directory, 'mcpb-key.pem');

// Use the legal entity name. A public CA would require it to match exactly, so
// starting there keeps a later move off self-signing from changing the publisher.
const commonName = process.env.MCPB_SIGN_CN ?? 'Zyno Consulting';
const organization = process.env.MCPB_SIGN_O ?? 'Signal24 LLC dba Zyno Consulting';
const country = process.env.MCPB_SIGN_C ?? 'US';
const days = process.env.MCPB_SIGN_DAYS ?? '3650';

async function exists(path) {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

await mkdir(directory, { recursive: true, mode: 0o700 });
const artifactPresence = await Promise.all([exists(certPath), exists(keyPath)]);
if (artifactPresence.some(Boolean)) {
    const existingPaths = [certPath, keyPath].filter((_path, index) => artifactPresence[index]);
    process.stderr.write(
        `A signing artifact already exists at ${existingPaths.join(' and ')}.\n` +
            'Replacing it changes the publisher identity for every future release.\n' +
            'Move or delete the existing identity deliberately if that is what you intend.\n'
    );
    process.exit(1);
}

// Generate away from the canonical names, then publish both files with
// COPYFILE_EXCL. Even if another process creates either destination while
// openssl is running, it cannot be overwritten with a different identity.
const scratch = await mkdtemp(join(directory, '.creating-'));
const temporaryCertPath = join(scratch, 'mcpb-cert.pem');
const temporaryKeyPath = join(scratch, 'mcpb-key.pem');
let certPublished = false;
let keyPublished = false;

// node-forge signs PKCS#7 with RSA only, so an EC key would produce a bundle
// mcpb cannot sign. keyUsage and the code-signing EKU are what the platform
// verifiers ask for: `security verify-cert -p codeSign` on macOS and the
// 1.3.6.1.5.5.7.3.3 application policy on Windows.
try {
    execFileSync(
        'openssl',
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:4096',
            '-sha256',
            '-days',
            days,
            '-nodes',
            '-keyout',
            temporaryKeyPath,
            '-out',
            temporaryCertPath,
            '-subj',
            `/CN=${commonName}/O=${organization}/C=${country}`,
            '-addext',
            'basicConstraints=critical,CA:FALSE',
            '-addext',
            'keyUsage=critical,digitalSignature',
            '-addext',
            'extendedKeyUsage=critical,codeSigning'
        ],
        // openssl reports key-generation progress on stderr; surface it only on failure.
        { stdio: ['ignore', 'ignore', 'pipe'] }
    );

    await chmod(temporaryKeyPath, 0o600);
    await chmod(temporaryCertPath, 0o644);
    await copyFile(temporaryCertPath, certPath, constants.COPYFILE_EXCL);
    certPublished = true;
    await copyFile(temporaryKeyPath, keyPath, constants.COPYFILE_EXCL);
    keyPublished = true;
    await chmod(keyPath, 0o600);
    await chmod(certPath, 0o644);
} catch (error) {
    if (keyPublished) await rm(keyPath, { force: true });
    if (certPublished) await rm(certPath, { force: true });
    throw error;
} finally {
    await rm(scratch, { recursive: true, force: true });
}

const fingerprint = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' })
    .trim()
    .replace(/^sha256 fingerprint=/i, '');

await writeFile(join(directory, 'FINGERPRINT.txt'), `${fingerprint}\n`);

process.stdout.write(
    `Certificate: ${certPath}\n` +
        `Private key: ${keyPath} (mode 600)\n` +
        `SHA-256 fingerprint:\n  ${fingerprint}\n\n` +
        'Back up the key somewhere durable and secret. Losing it means the next\n' +
        'release ships under a different identity; leaking it lets anyone publish\n' +
        'as you. For CI, inject both files from the secret store rather than\n' +
        'committing them, and publish the fingerprint so installs can be checked.\n'
);
