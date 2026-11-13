import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { DetailedForm } from '../src/api/forms-client.js';
import { createProgram } from '../src/cli.js';
import { runFormCommand, runFormsGuide } from '../src/commands/forms.js';
import { CliError } from '../src/errors.js';
import { EMBEDDING_GUIDE } from '../src/mcp/forms.js';
import { AllowedLocalRoots } from '../src/mcp/local-paths.js';
import { createHostingMcpServer } from '../src/mcp/server.js';

const FORM_ID = '11111111-1111-4111-8111-111111111111';
const DEFINITION_ID = '22222222-2222-4222-8222-222222222222';
const FIELD_ID = '33333333-3333-4333-8333-333333333333';

function stubForm(): DetailedForm {
    return {
        id: FORM_ID,
        name: 'Contact us',
        slug: 'contact-us',
        emailTo: ['ops@example.com'],
        corsOrigins: null,
        botProtectionMode: null,
        activeDefinitionId: DEFINITION_ID,
        createdAt: '2026-07-21T12:00:00.000Z',
        updatedAt: '2026-07-21T12:00:00.000Z',
        publicUrl: 'https://zyno.app/f/acme/contact-us',
        hasDraft: false,
        submissionCount: 2,
        activeDefinition: {
            id: DEFINITION_ID,
            version: 1,
            isDraft: false,
            revision: 0,
            renderTemplate: null,
            content: {
                fieldIdsByAlias: { email: FIELD_ID },
                pages: [{ fields: [{ id: FIELD_ID, alias: 'email', type: 'text', label: 'Email', inputType: 'email' }] }]
            }
        }
    };
}

async function startStub(): Promise<{ baseUrl: string; close(): Promise<void> }> {
    const form = stubForm();
    const server = createServer((request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/forms' && request.method === 'GET') {
            const { activeDefinition: _a, draftDefinition: _d, ...summary } = form;
            response.end(JSON.stringify([summary]));
        } else if (request.url === `/forms/manage/${FORM_ID}` && request.method === 'GET') {
            response.end(JSON.stringify(form));
        } else {
            response.statusCode = 404;
            response.end(JSON.stringify({ message: 'not found' }));
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>(resolve => server.close(() => resolve()))
    };
}

/** The MCP result keeps `undefined` members that the CLI's JSON text drops. */
function wire(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value));
}

function capture(): { out: string[]; io: { stdout: { write(text: string): void } } } {
    const out: string[] = [];
    return { out, io: { stdout: { write: text => void out.push(text) } } };
}

async function rejectsInvalidInput(promise: Promise<unknown>): Promise<CliError> {
    try {
        await promise;
    } catch (error) {
        assert(error instanceof CliError);
        assert.equal(error.code, 'invalid_input');
        assert.equal(error.exitCode, 2);
        return error;
    }
    throw new Error('expected invalid_input');
}

test('forms commands accept inline JSON, @file, and stdin input and match the MCP tools', async () => {
    const stub = await startStub();
    const dir = await mkdtemp(join(tmpdir(), 'zynohosting-forms-cli-'));
    const env = {
        ZYNOHOSTING_API_KEY: 'api-secret',
        ZYNOHOSTING_API_URL: stub.baseUrl,
        ZYNO_SUITE_API_URL: stub.baseUrl,
        HOME: dir,
        ZYNOHOSTING_CONFIG: join(dir, 'config.json')
    };
    const hosting = await createHostingMcpServer({
        roots: await AllowedLocalRoots.create([dir]),
        version: '0.0.0',
        apiUrl: stub.baseUrl,
        suiteApiUrl: stub.baseUrl,
        apiKey: 'api-secret'
    });
    const mcp = new Client({ name: 'forms-cli-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await hosting.connect(serverTransport);
    await mcp.connect(clientTransport);

    try {
        const listed = capture();
        await runFormCommand('list', {}, { ...listed.io, env });
        assert(listed.out[0]!.endsWith('\n'));
        const mcpList = await mcp.callTool({ name: 'list_forms', arguments: {} });
        assert.deepEqual(JSON.parse(listed.out[0]!), wire(mcpList.structuredContent));

        const mcpDescribe = await mcp.callTool({ name: 'describe_form', arguments: { form: 'contact-us' } });
        const inline = capture();
        await runFormCommand('describe', { input: '{"form":"contact-us"}' }, { ...inline.io, env });
        assert.deepEqual(JSON.parse(inline.out[0]!), wire(mcpDescribe.structuredContent));

        await writeFile(join(dir, 'input.json'), '{"form":"contact-us"}');
        const fromFile = capture();
        await runFormCommand('describe', { input: '@input.json' }, { ...fromFile.io, env, cwd: dir });
        assert.deepEqual(JSON.parse(fromFile.out[0]!), wire(mcpDescribe.structuredContent));

        const fromStdin = capture();
        await runFormCommand('integration', { input: '-' }, { ...fromStdin.io, env, stdin: Readable.from(['{"form":', '"contact-us"}']) });
        const mcpIntegration = await mcp.callTool({ name: 'get_form_integration', arguments: { form: 'contact-us' } });
        assert.deepEqual(JSON.parse(fromStdin.out[0]!), wire(mcpIntegration.structuredContent));
    } finally {
        await mcp.close();
        await stub.close();
    }
});

test('forms commands reject bad input with invalid_input before any request', async () => {
    const io = { ...capture().io, env: {}, cwd: tmpdir() };
    await rejectsInvalidInput(runFormCommand('describe', { input: '{not json' }, io));
    await rejectsInvalidInput(runFormCommand('describe', { input: '[1]' }, io));
    await rejectsInvalidInput(runFormCommand('describe', { input: '"x"' }, io));
    await rejectsInvalidInput(runFormCommand('describe', { input: '@does-not-exist.json' }, io));
    const unknown = await rejectsInvalidInput(runFormCommand('describe', { input: '{"form":"x","bogus":1}' }, io));
    assert.match(unknown.message, /bogus/);
    assert(Array.isArray((unknown.details as { issues: unknown[] }).issues));
    await rejectsInvalidInput(runFormCommand('describe', {}, io));
    await rejectsInvalidInput(runFormCommand('list', { input: '{"x":1}' }, io));
    await rejectsInvalidInput(runFormCommand('bot-protection', { input: '{"form":"x","bot_protection":"maybe"}' }, io));
});

test('forms guide prints the embedding guide as JSON without credentials', () => {
    const { out, io } = capture();
    runFormsGuide(io);
    assert.deepEqual(JSON.parse(out[0]!), { uri: 'zynoforms://guides/embedding', markdown: EMBEDDING_GUIDE });
});

test('forms --help lists every subcommand', () => {
    const forms = createProgram().commands.find(command => command.name() === 'forms');
    assert(forms);
    const help = forms.helpInformation();
    for (const name of ['list', 'integration', 'describe', 'create', 'update', 'bot-protection', 'origins', 'guide']) {
        assert.match(help, new RegExp(`^  ${name}\\b`, 'm'));
    }
    assert.equal(forms.commands.length, 8);
});
