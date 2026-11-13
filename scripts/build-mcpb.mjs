#!/usr/bin/env node
/**
 * Package the local MCP server as an MCP Bundle (.mcpb) for the Claude desktop app.
 *
 * The desktop app's Chat and Cowork tabs cannot run `mcp install`, and a
 * claude_desktop_config.json entry runs `npx` from the user's own PATH. A bundle
 * avoids both: the desktop app supplies the Node runtime, and the project root
 * comes from a directory picker instead of a hand-typed absolute path.
 */
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, sign as signPayload, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function exists(path) {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const staging = join(root, 'build', 'mcpb');
const packageJson = await readFile(join(root, 'package.json'), 'utf8');
const pkg = JSON.parse(packageJson);
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemver(value, label) {
    if (typeof value !== 'string' || value.length > 128) throw new Error(`${label} must be a SemVer string.`);
    const match = SEMVER_PATTERN.exec(value);
    if (!match) throw new Error(`${label} must be valid SemVer; received ${JSON.stringify(value)}.`);
    const prerelease = match[4]?.split('.') ?? [];
    if (prerelease.some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) {
        throw new Error(`${label} has a numeric prerelease identifier with a leading zero.`);
    }
    return { core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], prerelease };
}

function compareSemver(left, right) {
    for (let index = 0; index < left.core.length; index++) {
        if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
    }
    if (left.prerelease.length === 0 || right.prerelease.length === 0) {
        return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
    }
    const length = Math.max(left.prerelease.length, right.prerelease.length);
    for (let index = 0; index < length; index++) {
        const leftIdentifier = left.prerelease[index];
        const rightIdentifier = right.prerelease[index];
        if (leftIdentifier === undefined || rightIdentifier === undefined) return leftIdentifier === undefined ? -1 : 1;
        if (leftIdentifier === rightIdentifier) continue;
        const leftNumeric = /^\d+$/.test(leftIdentifier);
        const rightNumeric = /^\d+$/.test(rightIdentifier);
        if (leftNumeric && rightNumeric) return BigInt(leftIdentifier) > BigInt(rightIdentifier) ? 1 : -1;
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return leftIdentifier > rightIdentifier ? 1 : -1;
    }
    return 0;
}

const packageVersion = parseSemver(pkg.version, 'package.json version');
const minimumVersionText = pkg.mcpbMinimumVersion === undefined ? '0.0.0' : pkg.mcpbMinimumVersion;
const minimumVersion = parseSemver(minimumVersionText, 'package.json mcpbMinimumVersion');
if (compareSemver(minimumVersion, packageVersion) > 0) {
    throw new Error(`package.json mcpbMinimumVersion ${minimumVersionText} cannot exceed release version ${pkg.version}.`);
}
const bundle = join(root, 'build', `zynohosting-${pkg.version}.mcpb`);

// The desktop app supplies the runtime, so require the major this package
// requires. An older desktop build then refuses to install instead of failing
// at startup with a message the user cannot act on.
const REQUIRED_NODE = '>=24';

// Listing tools is optional for installation but populates the install dialog,
// and the connector directory requires it. Keep in step with SERVER_TOOLS.
const tools = [
    { name: 'login', description: 'Start or check the sign-in (browser, or a link and code to approve on any device)' },
    { name: 'list_logins', description: 'List the saved logins, one per organization' },
    { name: 'use_login', description: 'Choose which saved login is the default' },
    { name: 'list_sites', description: 'List the sites this login can reach' },
    { name: 'get_site', description: 'Describe a single site' },
    { name: 'list_forms', description: 'List ZynoForms forms' },
    { name: 'get_form_integration', description: 'Fetch the embed details for a form' },
    { name: 'describe_form', description: 'Describe a form as it exists today' },
    { name: 'create_basic_form', description: 'Create a form definition' },
    { name: 'update_form', description: 'Edit an existing form in place' },
    { name: 'update_form_bot_protection', description: 'Change a form’s bot protection' },
    { name: 'update_form_origins', description: 'Change the origins allowed to submit a form' },
    { name: 'list_files', description: 'List files in a site’s document root' },
    { name: 'get_file', description: 'Download one remote file' },
    { name: 'put_file', description: 'Upload one local file' },
    { name: 'delete_file', description: 'Delete one remote file' },
    { name: 'plan_deploy', description: 'Plan a production or preview deployment for review' },
    { name: 'apply_deploy', description: 'Apply a reviewed deployment plan' },
    { name: 'plan_promote', description: 'Plan preview promotion to production for review' },
    { name: 'apply_promote', description: 'Apply a reviewed preview promotion plan' },
    { name: 'plan_download', description: 'Plan a full download for review' },
    { name: 'apply_download', description: 'Apply a reviewed download plan' }
];

const manifest = {
    $schema: 'https://raw.githubusercontent.com/anthropics/mcpb/main/schemas/mcpb-manifest-v0.4.schema.json',
    manifest_version: '0.4',
    name: 'zynohosting',
    display_name: 'ZynoHosting',
    version: pkg.version,
    description: 'Publish sites and manage ZynoForms integrations on ZynoHosting.',
    long_description:
        'Sign in to ZynoHosting through your browser, or with a link and code you approve on any device, publish a folder on this computer to one of your sites, and create or edit the forms on those pages. Deployments are planned and shown to you for approval before anything goes live.',
    // Shown as "Developed by" in the install dialog. Keep it matching the signing
    // certificate's common name so the stated and cryptographic identity agree.
    author: { name: 'Zyno Consulting', url: 'https://zyno.io' },
    repository: { type: 'git', url: 'https://github.com/zyno-io/zynohosting-cli.git' },
    homepage: 'https://cli.zyno.host/',
    documentation: 'https://cli.zyno.host/agents/',
    support: 'https://github.com/zyno-io/zynohosting-cli/issues',
    license: pkg.license,
    keywords: ['hosting', 'deployment', 'forms', 'static-site'],
    server: {
        type: 'node',
        entry_point: 'dist/mcp.js',
        mcp_config: {
            command: 'node',
            // The roots argument stands alone: the host expands a list only when
            // an argument is exactly ${user_config.key}, so a `--root` flag in
            // front would keep the first folder and silently drop the rest.
            args: ['${__dirname}/dist/mcp.js', '${user_config.project_roots}'],
            // The process cannot otherwise tell it was installed as a desktop
            // extension. It reports this in its User-Agent so the API can
            // distinguish a frozen bundle from an npx run that self-updates.
            env: { ZYNOHOSTING_DISTRIBUTION: 'mcpb', ZYNOHOSTING_ENVIRONMENT: '${user_config.environment}' }
        }
    },
    user_config: {
        // Optional on purpose. People add sites over time and cannot name the
        // folders they will use later, so requiring one at install would ask a
        // question the user cannot answer yet. Empty means no restriction, which
        // matches how the npm and Claude Code paths behave with no --root.
        //
        // `default: []` is load-bearing: with the key absent the host leaves the
        // literal ${user_config...} in argv, which would then be read as a path.
        project_roots: {
            type: 'directory',
            title: 'Limit to specific folders (optional)',
            description:
                'Leave this empty unless you want to restrict ZynoHosting. By default it can publish any folder you point it at, which is usually what you want because you can add new sites at any time. Adding folders here confines it to those, and you can change them later without reinstalling.',
            required: false,
            multiple: true,
            default: []
        },
        // Saved logins are per environment and nothing is sticky, so this is the only way
        // the desktop extension can target another one. `default` is load-bearing here too:
        // without it the host leaves the literal ${user_config...} in the environment.
        environment: {
            type: 'string',
            title: 'Environment (Zyno staff only)',
            description: 'Leave as production unless you are testing against another Zyno environment: production, alpha, or dev.',
            required: false,
            default: 'production'
        }
    },
    tools,
    compatibility: {
        platforms: ['darwin', 'win32'],
        runtimes: { node: REQUIRED_NODE }
    }
};

// Local binaries rather than `npx -y`: the release pipeline should not depend on
// reaching the registry mid-build, and the installed versions are lockfile-pinned.
const ESBUILD = join(root, 'node_modules', '.bin', 'esbuild');
const MCPB = join(root, 'node_modules', '.bin', 'mcpb');

const SIGNATURE_HEADER = 'MCPB_SIG_V1';
const DESCRIPTOR_URL = 'https://github.com/zyno-io/zynohosting-cli/releases/latest/download/update.json';

// Resolved before the build so the launcher can be compiled with the key in it.
const signingDirectory = process.env.MCPB_SIGN_DIR ?? join(homedir(), '.config', 'zynohosting', 'signing');
const certPath = process.env.MCPB_SIGN_CERT ?? join(signingDirectory, 'mcpb-cert.pem');
const keyPath = process.env.MCPB_SIGN_KEY ?? join(signingDirectory, 'mcpb-key.pem');

function run(command, args, cwd) {
    execFileSync(command, args, { cwd, stdio: 'inherit' });
}

/** The SPKI public key from a certificate, or undefined when it cannot be read. */
function certificatePublicKey(certificatePath) {
    try {
        return new X509Certificate(readFileSync(certificatePath)).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    } catch {
        return undefined;
    }
}

/**
 * Every key an installed launcher should accept updates from.
 *
 * The signing certificate plus anything listed in MCPB_TRUSTED_CERTS. During a
 * key rotation, the new manually installed bundle is signed by the incoming key
 * and carries the outgoing key as extra trust. Launchers already in the field
 * cannot learn either key because staged updates replace server.js only.
 */
function trustedPublicKeys() {
    // The platform path delimiter, matching ZYNOHOSTING_MCP_ROOTS. Splitting on
    // ':' as well would shred an absolute Windows path at its drive letter.
    const extra = (process.env.MCPB_TRUSTED_CERTS ?? '')
        .split(delimiter)
        .map(entry => entry.trim())
        .filter(Boolean);

    const keys = [certificatePublicKey(certPath)];
    for (const path of extra) {
        const key = certificatePublicKey(path);
        if (!key) throw new Error(`MCPB_TRUSTED_CERTS could not be read as a certificate: ${path}`);
        keys.push(key);
    }
    return [...new Set(keys.filter(Boolean))];
}

function findEndOfCentralDirectory(contents) {
    for (let offset = contents.length - 22; offset >= 0; offset--) {
        if (contents.readUInt32LE(offset) === 0x06054b50) return offset;
    }
    return -1;
}

/**
 * Read the complete block mcpb appended to a signed bundle.
 *
 * This length must be reserved in the ZIP's EOCD before the final signing pass:
 * changing an already signed EOCD would invalidate the detached signature.
 */
async function signatureBlockLength(bundlePath) {
    const contents = await readFile(bundlePath);
    const header = contents.lastIndexOf(Buffer.from(SIGNATURE_HEADER, 'utf-8'));
    if (header === -1) throw new Error('Signed bundle has no signature block.');

    const lengthOffset = header + SIGNATURE_HEADER.length;
    if (lengthOffset + 4 > contents.length) throw new Error('Signed bundle has a truncated signature length.');
    const signatureLength = contents.readUInt32LE(lengthOffset);
    const blockLength = SIGNATURE_HEADER.length + 4 + signatureLength + Buffer.byteLength('MCPB_SIG_END');
    if (header + blockLength !== contents.length) throw new Error('Signed bundle has a truncated or trailing signature block.');
    return blockLength;
}

/**
 * Reserve the final signature block as the archive's trailing comment.
 *
 * mcpb sign appends its block just past the EOCD but leaves comment_length at
 * zero. A strict ZIP reader rejects that. Set the length before signing so the
 * signature covers the final EOCD; after signing, the appended block supplies
 * the bytes that complete the ZIP comment.
 */
async function reserveSignatureZipComment(bundlePath, blockLength) {
    const contents = await readFile(bundlePath);

    const eocd = findEndOfCentralDirectory(contents);
    if (eocd === -1) throw new Error('Signed bundle has no end of central directory record.');
    if (blockLength > 0xffff) throw new Error(`Signature block of ${blockLength} bytes exceeds the ZIP comment field.`);

    const declared = contents.readUInt16LE(eocd + 20);
    if (declared === blockLength) return;
    if (declared !== 0) throw new Error(`Unexpected archive comment of ${declared} bytes; refusing to overwrite it.`);

    contents.writeUInt16LE(blockLength, eocd + 20);
    await writeFile(bundlePath, contents);
}

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

run('yarn', ['build'], root);

// Ship one bundled file rather than the installed dependency tree. Shipping
// node_modules works, but carries type declarations, TypeScript sources, docs,
// dual CommonJS and ESM builds, and two subsystems this server never executes:
// the MCP SDK's HTTP transport and tar-stream's Bare-runtime filesystem shim.
//
// The launcher output stays at dist/mcp.js because it reads ../package.json for
// the embedded version, so its depth below the bundle root is load-bearing.
// Bundled CommonJS dependencies call require() at runtime, which an ESM output
// has no binding for unless one is created here. Base it on the Node executable,
// not import.meta.url: staged code is imported from a verified data URL and
// createRequire rejects non-file URLs.
const REQUIRE_BANNER =
    "--banner:js=import{createRequire as __mcpbCreateRequire}from'node:module';const require=__mcpbCreateRequire(process.execPath);";

function bundleWithEsbuild(entry, outfile, defines = []) {
    run(ESBUILD, [entry, '--bundle', '--platform=node', '--format=esm', '--target=node24', `--outfile=${outfile}`, REQUIRE_BANNER, ...defines], root);
}

// The server itself. Also published as the update payload, so a bundle that is
// already installed can stage this exact file rather than a whole new .mcpb.
bundleWithEsbuild(join(root, 'dist', 'mcp.js'), join(staging, 'dist', 'embedded.js'), [
    `--define:__ZYNO_MCPB_VERSION__=${JSON.stringify(pkg.version)}`
]);

// The entry point is a launcher that runs the newest verified runtime. The
// public key is compiled into it, so it travels inside the bundle the matching
// certificate signs: compromising the download host alone cannot get code run.
const updatePublicKeys = trustedPublicKeys();
bundleWithEsbuild(join(root, 'dist', 'mcpb-launcher.js'), join(staging, 'dist', 'mcp.js'), [
    `--define:__ZYNO_UPDATE_PUBLIC_KEYS__=${JSON.stringify(JSON.stringify(updatePublicKeys))}`,
    `--define:__ZYNO_UPDATE_DESCRIPTOR_URL__=${JSON.stringify(DESCRIPTOR_URL)}`
]);

await cp(join(root, 'README.md'), join(staging, 'README.md'));
// MIT requires the notice to travel with the copies, and the bundle is a copy.
await cp(join(root, 'LICENSE'), join(staging, 'LICENSE'));
await writeFile(
    join(staging, 'package.json'),
    `${JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: pkg.type }, null, 2)}\n`
);
await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

run(MCPB, ['validate', join(staging, 'manifest.json')], root);
run(MCPB, ['pack', staging, bundle], root);

// Sign with the stable identity from scripts/create-signing-cert.mjs when it is
// available. Never `mcpb sign --self-signed` here: that mints a fresh throwaway
// certificate per run, so the publisher and fingerprint change every release.
const signable = await Promise.all([exists(certPath), exists(keyPath)]);

if (signable.every(Boolean)) {
    // A dry signing pass reveals the fixed-size block mcpb will append. Its
    // DER content changes with the signed bytes, but its length is determined
    // by the certificate and key. Confirm that assumption after the real pass
    // so a future mcpb release cannot silently publish an invalid archive.
    const signatureProbe = join(staging, 'signature-probe.mcpb');
    try {
        await cp(bundle, signatureProbe);
        run(MCPB, ['sign', signatureProbe, '--cert', certPath, '--key', keyPath], root);
        const reservedSignatureLength = await signatureBlockLength(signatureProbe);
        await reserveSignatureZipComment(bundle, reservedSignatureLength);

        run(MCPB, ['sign', bundle, '--cert', certPath, '--key', keyPath], root);
        const actualSignatureLength = await signatureBlockLength(bundle);
        if (actualSignatureLength !== reservedSignatureLength) {
            throw new Error(
                `Signature block length changed from ${reservedSignatureLength} to ${actualSignatureLength}; refusing to publish an invalid bundle.`
            );
        }
    } finally {
        await rm(signatureProbe, { force: true });
    }
    // Signing itself is pure JavaScript. The fingerprint is only for the log, and
    // the openssl binary is absent from some minimal images, so never fail on it.
    let fingerprint = '(install openssl to print the fingerprint)';
    try {
        fingerprint = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' })
            .trim()
            .replace(/^sha256 fingerprint=/i, '');
    } catch {}
    process.stdout.write(`\nSigned with ${fingerprint}\n`);
} else {
    process.stdout.write('\nUnsigned: no signing certificate found. Run scripts/create-signing-cert.mjs to create one.\n');
}

// The update descriptor is what installed bundles poll. It is attached to the
// release, so clients read the stable releases/latest/download URL and always
// see the newest one, whatever version they are running.
//
// `minimum` is the force-update lever: raise it to make older bundles refuse to
// operate, and lower it to undo that without shipping a build.
// The update payload is the server bundle on its own, signed with the same key
// as the .mcpb. An installed launcher stages this file rather than a whole new
// archive, which keeps the update path free of any ZIP handling.
const releaseBase = `https://github.com/zyno-io/zynohosting-cli/releases/download/v${pkg.version}`;
const payload = await readFile(join(staging, 'dist', 'embedded.js'));
const payloadPath = join(root, 'build', 'server.js');
await writeFile(payloadPath, payload);

// Sign the version bound to the payload digest, not the payload alone. The
// descriptor carrying the version is an unsigned release asset, so signing only
// the bytes would let a forged descriptor pair an older signed runtime with a
// higher version and drive installs backwards onto known-vulnerable code.
const signedStatement = version => Buffer.from(`zynohosting-mcpb/1\n${version}\n${createHash('sha256').update(payload).digest('hex')}\n`, 'utf8');

let payloadSignature;
if (signable.every(Boolean)) {
    const signingKey = await readFile(keyPath);
    payloadSignature = signPayload('sha256', signedStatement(pkg.version), createPrivateKey(signingKey));
    await writeFile(`${payloadPath}.sig`, payloadSignature);
} else {
    // Never leave an earlier run's signature next to an unsigned payload; the
    // release step attaches whatever it finds on disk.
    await rm(`${payloadPath}.sig`, { force: true });
}

const bundleContents = await readFile(bundle);
const bundleStats = await stat(bundle);
const descriptor = {
    latest: pkg.version,
    minimum: minimumVersionText,
    url: `${releaseBase}/zynohosting-${pkg.version}.mcpb`,
    sha256: createHash('sha256').update(bundleContents).digest('hex'),
    size: bundleStats.size,
    // Omitted when unsigned. A launcher must never stage a payload it cannot
    // verify, and leaving these out is what makes it skip rather than fail.
    ...(payloadSignature
        ? {
              payloadUrl: `${releaseBase}/server.js`,
              signatureUrl: `${releaseBase}/server.js.sig`,
              payloadSha256: createHash('sha256').update(payload).digest('hex')
          }
        : {})
};
const descriptorPath = join(root, 'build', 'update.json');
await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

process.stdout.write(`\nBundle: ${bundle}\nDescriptor: ${descriptorPath} (latest ${descriptor.latest}, minimum ${descriptor.minimum})\n`);
