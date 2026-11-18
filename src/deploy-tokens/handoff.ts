import { spawn } from 'node:child_process';
import { access, mkdir, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import type { HandoffKind } from '../api/key-request-client.js';

import { CliError } from '../errors.js';

export const DEFAULT_SECRET_NAME = 'ZYNOHOSTING_DEPLOY_TOKEN';

export type Handoff =
    | { kind: 'github'; repo: string; environment?: string | undefined; name: string }
    | { kind: 'gitlab'; project: string; name: string }
    | { kind: 'file'; path: string }
    | { kind: 'manual' };

export interface ProcessResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

/** Runs a program. `input` goes to its stdin; nothing secret may ever be in `args`. */
export type RunProcess = (
    command: string,
    args: string[],
    options?: { input?: string | undefined; cwd?: string | undefined }
) => Promise<ProcessResult>;

export interface HandoffDependencies {
    run?: RunProcess;
}

/** Spawns a program with the secret on stdin. A program that is not installed resolves with code 127. */
export const runProcess: RunProcess = (command, args, options = {}) =>
    new Promise<ProcessResult>(resolvePromise => {
        // A neutral directory, so no program in the current directory can be picked over the real one on Windows.
        const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: options.cwd ?? tmpdir() });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let settled = false;
        const finish = (result: ProcessResult) => {
            if (settled) return;
            settled = true;
            resolvePromise(result);
        };
        child.stdout.on('data', chunk => out.push(chunk as Buffer));
        child.stderr.on('data', chunk => err.push(chunk as Buffer));
        child.once('error', error => finish({ code: 127, stdout: '', stderr: error.message }));
        child.once('close', code => finish({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
        // A program that exits before reading stdin makes the write fail; the exit code already says what happened.
        child.stdin.on('error', () => {});
        child.stdin.end(options.input ?? '');
    });

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const GITLAB_PROJECT = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)+$/;
const GITHUB_ENVIRONMENT = /^[A-Za-z0-9_.][A-Za-z0-9_. -]{0,254}$/;

export function handoffKind(handoff: Handoff): HandoffKind {
    return handoff.kind === 'github' ? 'github-secret' : handoff.kind === 'gitlab' ? 'gitlab-variable' : handoff.kind;
}

/** What may be told to ZynoAuth: where the key is going, never a local path. */
export function handoffTarget(handoff: Handoff): string | undefined {
    if (handoff.kind === 'github') return handoff.repo;
    if (handoff.kind === 'gitlab') return handoff.project;
    return undefined;
}

export function describeHandoff(handoff: Handoff): string {
    switch (handoff.kind) {
        case 'github':
            return `GitHub ${handoff.environment ? `environment secret ${handoff.name} (${handoff.environment})` : `secret ${handoff.name}`} in ${handoff.repo}`;
        case 'gitlab':
            return `GitLab masked variable ${handoff.name} in ${handoff.project}`;
        case 'file':
            return `file ${handoff.path}`;
        case 'manual':
            return 'the approval page (copy it there, once)';
    }
}

export function validateHandoff(handoff: Handoff): Handoff {
    if (handoff.kind === 'github') {
        if (!GITHUB_REPO.test(handoff.repo)) throw new CliError(`Invalid GitHub repository "${handoff.repo}"; use owner/repo`, 2, 'invalid_input');
        if (handoff.environment !== undefined && !GITHUB_ENVIRONMENT.test(handoff.environment)) {
            throw new CliError('Invalid GitHub environment name', 2, 'invalid_input');
        }
    }
    if (handoff.kind === 'gitlab' && !GITLAB_PROJECT.test(handoff.project)) {
        throw new CliError(`Invalid GitLab project "${handoff.project}"; use group/project`, 2, 'invalid_input');
    }
    if ((handoff.kind === 'github' || handoff.kind === 'gitlab') && !SECRET_NAME.test(handoff.name)) {
        throw new CliError(`Invalid variable name "${handoff.name}"; use letters, digits, and underscores`, 2, 'invalid_input');
    }
    if (handoff.kind === 'github' && handoff.name.toUpperCase().startsWith('GITHUB_')) {
        throw new CliError('GitHub does not allow secret names that start with GITHUB_', 2, 'invalid_input');
    }
    if (handoff.kind === 'file' && !handoff.path.trim()) throw new CliError('--file needs a path', 2, 'invalid_input');
    return handoff;
}

function unavailable(message: string): CliError {
    return new CliError(message, 2, 'handoff_unavailable');
}

export interface HandoffPreflight {
    /** The GitLab variable already exists, so it is updated rather than created. */
    replacesExisting: boolean;
    /** Extra `glab variable update` flags that keep the existing variable's settings (protected, raw, file type, description). */
    keepFlags?: string[];
}

/**
 * Reads an existing GitLab variable's settings from `glab variable get -F json` so a rotation does not reset them. The JSON
 * also holds the old value; only the settings are taken, and the value is never kept or shown. Unreadable output keeps none.
 */
function keepFlagsFrom(stdout: string): string[] {
    try {
        const value = JSON.parse(stdout) as Record<string, unknown>;
        const flags: string[] = [];
        if (value.protected === true) flags.push('--protected');
        if (value.raw === true) flags.push('--raw');
        if (value.variable_type === 'file') flags.push('--type', 'file');
        if (typeof value.description === 'string' && value.description) flags.push('--description', value.description.slice(0, 255));
        return flags;
    } catch {
        return [];
    }
}

/** Checks, before any request is made, that the destination can take the key. Nothing secret exists yet. */
export async function preflightHandoff(handoff: Handoff, dependencies: HandoffDependencies = {}): Promise<HandoffPreflight> {
    const run = dependencies.run ?? runProcess;
    if (handoff.kind === 'github') {
        if ((await run('gh', ['auth', 'status'])).code !== 0) {
            throw unavailable('GitHub CLI is not ready. Install `gh` and run `gh auth login`, or use --file and add the secret yourself.');
        }
        if ((await run('gh', ['secret', 'list', '-R', handoff.repo])).code !== 0) {
            throw unavailable(
                `Cannot manage secrets in ${handoff.repo}. Check the repository name and that your GitHub account may edit its secrets.`
            );
        }
    } else if (handoff.kind === 'gitlab') {
        if ((await run('glab', ['auth', 'status'])).code !== 0) {
            throw unavailable('GitLab CLI is not ready. Install `glab` and run `glab auth login`, or use --file and add the variable yourself.');
        }
        if ((await run('glab', ['variable', 'list', '-R', handoff.project])).code !== 0) {
            throw unavailable(
                `Cannot manage variables in ${handoff.project}. Check the project path and that your GitLab account may edit its CI/CD variables.`
            );
        }
        // `glab variable set` fails when the variable exists, so a rotation must use `update`. Only the exit code is used;
        // the old value that `get` prints stays in memory and is never shown.
        const existing = await run('glab', ['variable', 'get', handoff.name, '-R', handoff.project, '-F', 'json']);
        return existing.code === 0 ? { replacesExisting: true, keepFlags: keepFlagsFrom(existing.stdout) } : { replacesExisting: false };
    } else if (handoff.kind === 'file') {
        const path = resolve(handoff.path);
        const exists = await access(path).then(
            () => true,
            () => false
        );
        if (exists) throw unavailable(`${path} already exists. Choose a new file name; an existing file is never overwritten.`);
        const parent = await stat(dirname(path)).catch(() => undefined);
        if (parent && !parent.isDirectory()) throw unavailable(`${dirname(path)} is not a directory`);
    }
    return { replacesExisting: false };
}

/** Removes the secret from text that may echo it. */
export function redactSecret(text: string, secret: string): string {
    return secret ? text.split(secret).join('[redacted]') : text;
}

function failure(what: string, result: ProcessResult, secret: string): CliError {
    const detail = redactSecret(result.stderr, secret).trim().split('\n').slice(0, 3).join(' ').slice(0, 300);
    return new CliError(`${what} failed${detail ? `: ${detail}` : ''}`, 7, 'handoff_failed');
}

export interface HandoffOutcome {
    /** Human description of where the key went. */
    destination: string;
    warnings: string[];
}

/** Puts the secret where the person chose. The secret travels on stdin or in a 0600 file, never in an argument. */
export async function deliverSecret(
    handoff: Handoff,
    secret: string,
    dependencies: HandoffDependencies = {},
    preflight: HandoffPreflight = { replacesExisting: false }
): Promise<HandoffOutcome> {
    const run = dependencies.run ?? runProcess;
    const warnings: string[] = [];
    if (handoff.kind === 'github') {
        const args = ['secret', 'set', handoff.name, '-R', handoff.repo, ...(handoff.environment ? ['--env', handoff.environment] : [])];
        const result = await run('gh', args, { input: secret });
        if (result.code !== 0) throw failure('Saving the GitHub secret', result, secret);
    } else if (handoff.kind === 'gitlab') {
        const verb = preflight.replacesExisting ? 'update' : 'set';
        // An update keeps the settings the variable already has; `--masked` is always set, as it is for a new variable.
        const keep = preflight.replacesExisting ? (preflight.keepFlags ?? []) : [];
        const result = await run('glab', ['variable', verb, handoff.name, '--masked', ...keep, '-R', handoff.project], { input: secret });
        if (result.code !== 0) throw failure('Saving the GitLab variable', result, secret);
    } else if (handoff.kind === 'file') {
        warnings.push(...(await writeSecretFile(resolve(handoff.path), secret, run)));
    }
    return { destination: describeHandoff(handoff), warnings };
}

async function writeSecretFile(path: string, secret: string, run: RunProcess): Promise<string[]> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let created = false;
    try {
        // 'wx' is O_WRONLY | O_CREAT | O_EXCL: it never replaces a file and never follows a link planted at the path.
        const file = await open(path, 'wx', 0o600);
        created = true;
        try {
            await file.writeFile(`${secret}\n`);
        } finally {
            await file.close();
        }
    } catch (error) {
        if (created) await rm(path, { force: true }).catch(() => {});
        const code = (error as NodeJS.ErrnoException).code;
        throw new CliError(
            code === 'EEXIST' ? `${path} already exists; an existing file is never overwritten` : `Could not write ${path}: ${code ?? 'write error'}`,
            7,
            'handoff_failed'
        );
    }
    const warnings: string[] = [];
    const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dirname(path) });
    if (inside.code === 0 && inside.stdout.trim() === 'true') {
        const ignored = await run('git', ['check-ignore', '-q', '--', path], { cwd: dirname(path) });
        if (ignored.code === 1) {
            warnings.push(
                `${path} is inside a git worktree and is not ignored. Add it to .gitignore before you commit, or move it out of the repository.`
            );
        }
    }
    return warnings;
}
