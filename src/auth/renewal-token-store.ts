import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { CliError } from '../errors.js';
import { createFileRenewalTokenStore } from './file-renewal-token-store.js';

const SERVICE = 'io.zyno.zynohosting.cli';
const MAX_SECRET_BYTES = 16 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export interface RenewalTokenStore {
    get(key: string): Promise<string | undefined>;
    set(key: string, token: string): Promise<void>;
    delete(key: string): Promise<void>;
    /** Fails with `credential_store_unavailable` when the store cannot work, without writing anything. */
    probe?(): Promise<void>;
}

export type RenewalStoreChoice = 'system' | 'file';

/** The store a login uses: the operating system's, or the opt-in file next to the profiles file. */
export function createRenewalTokenStore(kind: RenewalStoreChoice, configPath: string): RenewalTokenStore {
    return kind === 'file' ? createFileRenewalTokenStore(configPath) : createSystemRenewalTokenStore();
}

export function createSystemRenewalTokenStore(platform: NodeJS.Platform = process.platform): RenewalTokenStore {
    if (platform === 'darwin') return macOsKeychainStore();
    if (platform === 'linux') return linuxSecretServiceStore();
    if (platform === 'win32') return windowsCredentialLockerStore();
    throw unavailable(`Renewable login is not supported on ${platform}`);
}

function macOsKeychainStore(): RenewalTokenStore {
    const get = async (key: string): Promise<string | undefined> => {
        validateRenewalKey(key);
        const result = await run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', key, '-w'], undefined, [44]);
        return result.exitCode === 44 ? undefined : requireSecret(result.stdout);
    };
    return {
        get,
        async probe() {
            // A lookup for a random account exits 44 (not found) when the keychain can be searched. Anything else, or a
            // missing `security` tool, means it cannot. A locked keychain may still pass here and fail when storing.
            await run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', randomUUID()], undefined, [44]).catch(error => {
                throw error instanceof CliError && error.code === 'credential_store_unavailable'
                    ? error
                    : unavailable('The macOS keychain could not be searched');
            });
        },
        async set(key, token) {
            validateRenewalKey(key);
            validateRenewalToken(token);
            // Interactive mode accepts the command on stdin, keeping the URL-safe token out of argv and process listings.
            await run(
                '/usr/bin/security',
                ['-i'],
                `add-generic-password -U -s ${SERVICE} -a ${key} -l "ZynoHosting CLI renewal token" -w ${token}\n`
            );
            if ((await get(key)) !== token)
                throw new CliError('The system credential store did not save the renewal credential', 3, 'credential_store_failed');
        },
        async delete(key) {
            validateRenewalKey(key);
            await run('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', key], undefined, [44]);
        }
    };
}

function linuxSecretServiceStore(): RenewalTokenStore {
    const get = async (key: string): Promise<string | undefined> => {
        validateRenewalKey(key);
        const result = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', key], undefined, [1]);
        if (result.exitCode === 1) {
            if (result.stderr.trim()) throw credentialStoreFailure(result.stderr);
            return undefined;
        }
        return requireSecret(result.stdout);
    };
    return {
        get,
        async probe() {
            // A lookup for a random key exits 1 with no output when the service works; anything on stderr means it does not.
            const result = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', randomUUID()], undefined, [1]).catch(error => {
                throw error instanceof CliError && error.code === 'credential_store_failed' ? unavailable(error.message) : error;
            });
            if (result.exitCode === 1 && result.stderr.trim()) throw unavailable('The system credential service is not running');
        },
        async set(key, token) {
            validateRenewalKey(key);
            validateRenewalToken(token);
            await run('secret-tool', ['store', '--label=ZynoHosting CLI renewal token', 'service', SERVICE, 'account', key], token);
            if ((await get(key)) !== token)
                throw new CliError('The system credential store did not save the renewal credential', 3, 'credential_store_failed');
        },
        async delete(key) {
            validateRenewalKey(key);
            const result = await run('secret-tool', ['clear', 'service', SERVICE, 'account', key], undefined, [1]);
            if (result.exitCode === 1 && result.stderr.trim()) throw credentialStoreFailure(result.stderr);
        }
    };
}

function windowsCredentialLockerStore(): RenewalTokenStore {
    const credentialScript = (operation: 'get' | 'set' | 'delete') => `
& {
param([string]$resource, [string]$user)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$vault = [Windows.Security.Credentials.PasswordVault]::new()
if ('${operation}' -eq 'set') {
    $secret = [Console]::In.ReadToEnd()
    $vault.Add([Windows.Security.Credentials.PasswordCredential]::new($resource, $user, $secret))
    $credential = $vault.Retrieve($resource, $user)
    $credential.RetrievePassword()
    if ($credential.Password -cne $secret) { throw 'Credential verification failed' }
} elseif ('${operation}' -eq 'get') {
    try {
        $credential = $vault.Retrieve($resource, $user)
        $credential.RetrievePassword()
        [Console]::Out.Write($credential.Password)
    } catch [System.Exception] {
        if ($_.Exception.HResult -eq -2147023728) { exit 44 }
        throw
    }
} else {
    try {
        $credential = $vault.Retrieve($resource, $user)
        $vault.Remove($credential)
    } catch [System.Exception] {
        if ($_.Exception.HResult -eq -2147023728) { exit 44 }
        throw
    }
}
}`;

    const invoke = (operation: 'get' | 'set' | 'delete', key: string, input?: string) =>
        run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', credentialScript(operation), SERVICE, key], input, [44]);

    return {
        async probe() {
            // Looking up a random entry exits 44 (not found) when the vault works.
            await invoke('get', randomUUID()).catch(error => {
                throw error instanceof CliError && error.code === 'credential_store_unavailable'
                    ? error
                    : unavailable('Windows Credential Locker could not be searched');
            });
        },
        async get(key) {
            validateRenewalKey(key);
            const result = await invoke('get', key);
            return result.exitCode === 44 ? undefined : requireSecret(result.stdout);
        },
        async set(key, token) {
            validateRenewalKey(key);
            validateRenewalToken(token);
            await invoke('set', key, token);
        },
        async delete(key) {
            validateRenewalKey(key);
            await invoke('delete', key);
        }
    };
}

interface CommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

async function run(command: string, args: string[], input?: string, allowedExitCodes: number[] = []): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        const timeout = setTimeout(() => {
            child.kill();
            fail(new CliError('The system credential store did not respond in time', 3, 'credential_store_failed'));
        }, COMMAND_TIMEOUT_MS);
        timeout.unref();

        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(error);
        };

        child.stdout.on('data', chunk => {
            const bytes = Buffer.from(chunk as Buffer);
            stdoutBytes += bytes.length;
            if (stdoutBytes <= MAX_SECRET_BYTES) stdout.push(bytes);
            else child.kill();
        });
        child.stderr.on('data', chunk => {
            const bytes = Buffer.from(chunk as Buffer);
            stderrBytes += bytes.length;
            if (stderrBytes <= MAX_SECRET_BYTES) stderr.push(bytes);
            else child.kill();
        });
        child.once('error', error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail(unavailable(`${command} is not installed`));
            else fail(new CliError(`Could not access the system credential store: ${error.message}`, 3, 'credential_store_failed'));
        });
        child.once('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            const exitCode = code ?? 1;
            if (stdoutBytes > MAX_SECRET_BYTES || stderrBytes > MAX_SECRET_BYTES) {
                reject(new CliError('The system credential store returned an oversized response', 3, 'credential_store_failed'));
                return;
            }
            if (code === null) {
                reject(new CliError('The system credential store process was interrupted', 3, 'credential_store_failed'));
                return;
            }
            if (exitCode === 0 || allowedExitCodes.includes(exitCode)) {
                resolve({ exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
                return;
            }
            const detail = Buffer.concat(stderr).toString('utf8').trim();
            reject(
                new CliError(`Could not access the system credential store${detail ? `: ${detail.slice(0, 500)}` : ''}`, 3, 'credential_store_failed')
            );
        });

        child.stdin.end(input === undefined ? undefined : Buffer.from(input, 'utf8'));
    });
}

function credentialStoreFailure(detail: string): CliError {
    return new CliError(`Could not access the system credential store: ${detail.trim().slice(0, 500)}`, 3, 'credential_store_failed');
}

function requireSecret(value: string): string {
    const token = value.trim();
    validateRenewalToken(token);
    return token;
}

export function validateRenewalKey(value: string): void {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
        throw new CliError('The saved renewal credential reference is invalid', 3, 'invalid_renewal_credential');
    }
}

export function validateRenewalToken(value: string): void {
    if (value.length > MAX_SECRET_BYTES || !/^zrt_[A-Za-z0-9_-]+$/.test(value)) {
        throw new CliError('The saved renewal credential is invalid', 3, 'invalid_renewal_credential');
    }
}

function unavailable(reason: string): CliError {
    return new CliError(
        `${reason}. Use a non-renewable login, install or start the operating system credential service, or (on a computer only you use) pass --credential-store file to keep the renewal token in a private file instead.`,
        3,
        'credential_store_unavailable'
    );
}
