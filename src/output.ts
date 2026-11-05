import { createInterface } from 'node:readline/promises';

import { DisplayOperation } from './deploy/coalesce.js';
import { CliError } from './errors.js';
import { ApplyResult, DeploymentOperation, DeploymentTarget } from './protocol.js';

export class Output {
    constructor(
        private readonly json: boolean,
        private readonly color = process.stderr.isTTY && !process.env.NO_COLOR
    ) {}

    progress(message: string, details: Record<string, unknown> = {}): void {
        if (this.json) this.event('progress', { message, ...details });
        else process.stderr.write(`${message}\n`);
    }

    showPlan(input: {
        target?: DeploymentTarget;
        url?: string;
        fqdn: string;
        source: string;
        ignores: string[];
        displayOperations: DisplayOperation[];
        operations: DeploymentOperation[];
        uploadBytes: number;
    }): void {
        const counts = countOperations(input.operations);
        if (this.json) {
            this.event('plan', {
                target: input.target ?? 'production',
                ...(input.url ? { url: input.url } : {}),
                fqdn: input.fqdn,
                source: input.source,
                ignores: input.ignores,
                operations: input.operations,
                displayOperations: input.displayOperations,
                counts,
                uploadBytes: input.uploadBytes
            });
            return;
        }

        process.stdout.write(`\nDeploy ${input.fqdn} (${input.target ?? 'production'}) from ${input.source}\n`);
        if (input.url) process.stdout.write(`URL: ${input.url}\n`);
        process.stdout.write('\n');
        process.stdout.write(`Ignore sources: ${input.ignores.join(', ')}\n\n`);
        if (!input.displayOperations.length) {
            process.stdout.write('No changes.\n');
            return;
        }
        const width = Math.max(...input.displayOperations.map(operation => operation.kind.length));
        for (const operation of input.displayOperations) {
            const kind = operation.kind.toUpperCase().padEnd(width).padEnd(8);
            const details = operation.directory ? `${operation.fileCount} files, ${formatBytes(operation.bytes)}` : formatBytes(operation.bytes);
            process.stdout.write(`${this.operationColor(operation.kind, kind)} ${operation.path.padEnd(48)} ${details}\n`);
        }
        process.stdout.write(
            `\n${counts.create} create, ${counts.replace} replace, ${counts.delete} delete; ${formatBytes(input.uploadBytes)} to upload\n`
        );
    }

    async confirm(): Promise<boolean> {
        if (!process.stdin.isTTY) throw new CliError('Confirmation requires a terminal; pass --yes or --dry-run', 2, 'confirmation_required');
        const readline = createInterface({ input: process.stdin, output: process.stdout });
        try {
            const answer = await readline.question('\nContinue? [y/N] ');
            return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
        } finally {
            readline.close();
        }
    }

    applied(result: ApplyResult, target: DeploymentTarget = 'production', url?: string): void {
        if (this.json) {
            this.event('result', { ...result, target, ...(url ? { url } : {}) });
            return;
        }
        process.stdout.write(
            `\nDeployed ${target} successfully: ${result.created} created, ${result.replaced} replaced, ${result.deleted} deleted ` +
                `(${formatBytes(result.uploadedBytes)} uploaded in ${formatDuration(result.durationMs)}).\n`
        );
        if (url) process.stdout.write(`URL: ${url}\n`);
    }

    dryRun(): void {
        if (this.json) this.event('dry_run_complete', {});
        else process.stdout.write('\nDry run complete; no changes applied.\n');
    }

    cancelled(): void {
        if (this.json) this.event('cancelled', {});
        else process.stdout.write('\nCancelled.\n');
    }

    private event(type: string, payload: Record<string, unknown> | ApplyResult): void {
        process.stdout.write(`${JSON.stringify({ type, ...payload })}\n`);
    }

    private operationColor(kind: DisplayOperation['kind'], value: string): string {
        if (!this.color) return value;
        const code = kind === 'create' ? 32 : kind === 'replace' ? 33 : 31;
        return `\u001B[${code}m${value}\u001B[0m`;
    }
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes / 1024;
    let unit = units[0]!;
    for (let index = 1; index < units.length && value >= 1024; index++) {
        value /= 1024;
        unit = units[index]!;
    }
    return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function formatDuration(milliseconds: number): string {
    if (milliseconds < 1000) return `${milliseconds}ms`;
    return `${(milliseconds / 1000).toFixed(1)}s`;
}

function countOperations(operations: readonly DeploymentOperation[]): Record<'create' | 'replace' | 'delete', number> {
    return operations.reduce(
        (counts, operation) => {
            counts[operation.kind]++;
            return counts;
        },
        { create: 0, replace: 0, delete: 0 }
    );
}
