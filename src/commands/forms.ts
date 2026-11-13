import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

import { FormsClient } from '../api/forms-client.js';
import { ManagerClient } from '../api/manager-client.js';
import { ConfigOverrides, resolveConfig } from '../config.js';
import { CliError } from '../errors.js';
import { EMBEDDING_GUIDE, FORM_OPERATIONS, FormsMcpClients } from '../mcp/forms.js';

export const FORMS_GUIDE_URI = 'zynoforms://guides/embedding';

export interface FormCommandIo {
    stdin?: AsyncIterable<unknown>;
    stdout?: { write(text: string): unknown };
    env?: NodeJS.ProcessEnv;
    cwd?: string;
}

export type FormCommandOptions = ConfigOverrides & { input?: string };

export async function runFormCommand(command: string, options: FormCommandOptions, io: FormCommandIo = {}): Promise<void> {
    const operation = FORM_OPERATIONS.find(candidate => candidate.command === command);
    if (!operation) throw new CliError(`Unknown forms command: ${command}`, 2, 'invalid_input');

    const { input: rawInput, ...overrides } = options;
    const parsed = operation.input.safeParse(await readFormInput(rawInput, io));
    if (!parsed.success) throw invalidInput(parsed.error);

    const config = await resolveConfig(overrides, io.env ?? process.env);
    const clients: FormsMcpClients = {
        forms: new FormsClient(config.suiteApiUrl, config.credential),
        manager: new ManagerClient(config.apiUrl, config.credential),
        ...(config.suiteApiUrl ? { suiteApiUrl: config.suiteApiUrl } : {})
    };
    writeJson(await operation.run(clients, parsed.data), io);
}

export function runFormsGuide(io: FormCommandIo = {}): void {
    writeJson({ uri: FORMS_GUIDE_URI, markdown: EMBEDDING_GUIDE }, io);
}

function writeJson(value: unknown, io: FormCommandIo): void {
    (io.stdout ?? process.stdout).write(`${JSON.stringify(value)}\n`);
}

async function readFormInput(value: string | undefined, io: FormCommandIo): Promise<Record<string, unknown>> {
    let text: string;
    if (value === undefined) return {};
    if (value === '-') {
        text = await readAll(io.stdin ?? process.stdin);
    } else if (value.startsWith('@')) {
        const path = resolve(io.cwd ?? process.cwd(), value.slice(1));
        try {
            text = await readFile(path, 'utf8');
        } catch (error) {
            throw new CliError(`Cannot read input file ${path}: ${error instanceof Error ? error.message : String(error)}`, 2, 'invalid_input');
        }
    } else {
        text = value;
    }

    let parsed: unknown;
    try {
        // Windows editors and PowerShell 5.1 often save UTF-8 with a byte-order mark.
        parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (error) {
        throw new CliError(`Input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 2, 'invalid_input');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new CliError('Input must be a JSON object', 2, 'invalid_input');
    }
    return parsed as Record<string, unknown>;
}

async function readAll(stream: AsyncIterable<unknown>): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks).toString('utf8');
}

function invalidInput(error: z.ZodError): CliError {
    const message = error.issues.map(issue => `${issue.path.length ? issue.path.join('.') : '(input)'}: ${issue.message}`).join('; ');
    return new CliError(`Invalid input: ${message}`, 2, 'invalid_input', { issues: error.issues });
}
