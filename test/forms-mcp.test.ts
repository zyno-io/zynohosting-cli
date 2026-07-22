import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DetailedForm, FormDefinitionContent } from '../src/api/forms-client.js';
import { AllowedLocalRoots } from '../src/mcp/local-paths.js';
import { createHostingMcpServer } from '../src/mcp/server.js';

const FORM_ID = '11111111-1111-4111-8111-111111111111';
const DEFINITION_ID = '22222222-2222-4222-8222-222222222222';
const CREATED_FORM_ID = '55555555-5555-4555-8555-555555555555';
const CREATED_DEFINITION_ID = '66666666-6666-4666-8666-666666666666';

test('exposes forms discovery, creation, integration guidance, and exact-origin management over MCP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-forms-mcp-'));
    const forms = new Map<string, DetailedForm>([[FORM_ID, existingForm()]]);
    const suiteRequests: Array<{ method: string; url: string; authorization?: string; body?: unknown }> = [];
    const server = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/v1/sites/example.com' && request.method === 'GET') {
            assert.equal(request.headers.authorization, basicAuthorization());
            response.end(
                JSON.stringify({
                    id: '77777777-7777-4777-8777-777777777777',
                    fqdn: 'example.com',
                    status: 'active',
                    phpVersion: null,
                    hostnames: [
                        { name: 'www.example.com', type: 'alias' },
                        { name: 'forms.example.net', type: 'vanity' },
                        { name: 'example.com', type: 'primary' }
                    ]
                })
            );
            return;
        }

        if (request.url?.startsWith('/forms')) {
            const text = await requestText(request);
            const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
            suiteRequests.push({
                method: request.method ?? '',
                url: request.url,
                ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
                ...(body === undefined ? {} : { body })
            });
            if (request.url === '/forms' && request.method === 'GET') {
                response.end(JSON.stringify([...forms.values()].map(({ activeDefinition: _, draftDefinition: __, ...form }) => form)));
                return;
            }
            if (request.url === `/forms/manage/${FORM_ID}` && request.method === 'GET') {
                response.end(JSON.stringify(forms.get(FORM_ID)));
                return;
            }
            if (request.url === `/forms/manage/${FORM_ID}` && request.method === 'PUT') {
                const existing = forms.get(FORM_ID)!;
                const updated = { ...existing, corsOrigins: (body?.corsOrigins as string[] | null) ?? null };
                forms.set(FORM_ID, updated);
                response.end(JSON.stringify(updated));
                return;
            }
            if (request.url === '/forms/manage' && request.method === 'POST') {
                const content = body?.content as FormDefinitionContent;
                const created: DetailedForm = {
                    id: CREATED_FORM_ID,
                    name: body?.name as string,
                    slug: (body?.slug as string | undefined) ?? null,
                    emailTo: (body?.emailTo as string[] | null) ?? null,
                    corsOrigins: (body?.corsOrigins as string[] | null) ?? null,
                    activeDefinitionId: CREATED_DEFINITION_ID,
                    createdAt: '2026-07-21T12:30:00.000Z',
                    updatedAt: '2026-07-21T12:30:00.000Z',
                    publicUrl: `https://zyno.app/f/acme/${(body?.slug as string | undefined) ?? CREATED_FORM_ID}`,
                    hasDraft: false,
                    submissionCount: 0,
                    activeDefinition: {
                        id: CREATED_DEFINITION_ID,
                        version: 1,
                        isDraft: false,
                        revision: 0,
                        renderTemplate: null,
                        content
                    }
                };
                forms.set(CREATED_FORM_ID, created);
                response.end(JSON.stringify(created));
                return;
            }
        }

        response.statusCode = 404;
        response.end(JSON.stringify({ message: 'not found' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const hosting = await createHostingMcpServer({
        roots: await AllowedLocalRoots.create([root]),
        version: '0.2.3',
        apiUrl: baseUrl,
        suiteApiUrl: baseUrl,
        apiKey: 'api-secret'
    });
    const client = new Client({ name: 'forms-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await hosting.connect(serverTransport);
    await client.connect(clientTransport);

    try {
        const resources = await client.listResources();
        assert.deepEqual(
            resources.resources.map(resource => resource.uri),
            ['zynoforms://guides/embedding']
        );
        const guide = await client.readResource({ uri: 'zynoforms://guides/embedding' });
        assert.match(JSON.stringify(guide.contents), /responses\[contact\]\[firstName\]/);

        const listed = await client.callTool({ name: 'list_forms', arguments: {} });
        assert.equal(listed.isError, undefined);
        assert.match(JSON.stringify(listed.structuredContent), /<iframe/);
        assert.match(JSON.stringify(listed.structuredContent), /contact-us/);

        const integration = await client.callTool({ name: 'get_form_integration', arguments: { form: 'contact-us' } });
        assert.equal(integration.isError, undefined);
        const integrationJson = JSON.stringify(integration.structuredContent);
        assert.match(integrationJson, new RegExp(`${DEFINITION_ID}/submissions`));
        assert.match(integrationJson, /responses\[email\]/);
        assert.match(integrationJson, /unpublished draft/);

        const created = await client.callTool({
            name: 'create_basic_form',
            arguments: {
                name: 'Request a quote',
                slug: 'request-quote',
                notification_emails: ['sales@example.com'],
                origins: ['https://standalone.example.org/'],
                origin_sites: ['example.com'],
                fields: [
                    { key: 'name', label: 'Name', type: 'text' },
                    { key: 'email', label: 'Email', type: 'email' },
                    { key: 'budget', label: 'Budget', type: 'number', required: false, min: 0 },
                    { key: 'message', label: 'Message', type: 'textarea' }
                ]
            }
        });
        assert.equal(created.isError, undefined);
        assert.equal((created.structuredContent as { liveDefinition: { version: number } }).liveDefinition.version, 1);
        const createRequest = suiteRequests.find(request => request.method === 'POST' && request.url === '/forms/manage');
        assert(createRequest);
        const createBody = createRequest.body as {
            emailTo: string[];
            corsOrigins: string[];
            content: {
                fieldIdsByAlias: Record<string, string>;
                header: unknown;
                submit: unknown;
                pages: Array<{ fields: Array<Record<string, unknown>> }>;
            };
        };
        assert.deepEqual(createBody.emailTo, ['sales@example.com']);
        assert.deepEqual(createBody.corsOrigins, [
            'https://standalone.example.org',
            'https://example.com',
            'https://www.example.com',
            'https://forms.example.net'
        ]);
        assert.deepEqual(Object.keys(createBody.content.fieldIdsByAlias), ['name', 'email', 'budget', 'message']);
        assert(createBody.content.pages[0]!.fields.every(field => typeof field.id === 'string'));
        assert.equal(createBody.content.pages[0]!.fields[0]!.optional, undefined);
        assert.equal(createBody.content.pages[0]!.fields[2]!.optional, true);
        assert.deepEqual(createBody.content.header, { title: 'Request a quote' });
        assert.deepEqual(createBody.content.submit, {
            title: 'Submit',
            successMessage: 'Thank you. Your response has been submitted.'
        });

        const postsBeforeInvalid = suiteRequests.filter(request => request.method === 'POST').length;
        const invalidCreate = await client.callTool({
            name: 'create_basic_form',
            arguments: {
                name: 'Invalid aliases',
                fields: [
                    { key: '__proto__', label: 'Unsafe', type: 'text' },
                    { key: '__proto__', label: 'Duplicate', type: 'text' }
                ]
            }
        });
        assert.equal(invalidCreate.isError, true);
        assert.equal(suiteRequests.filter(request => request.method === 'POST').length, postsBeforeInvalid);

        const invalidContactLabel = await client.callTool({
            name: 'create_basic_form',
            arguments: {
                name: 'Invalid contact label',
                fields: [{ key: 'contact', type: 'contact', label: 'Ignored label', fields: ['email'] }]
            }
        });
        assert.equal(invalidContactLabel.isError, true);
        assert.equal(suiteRequests.filter(request => request.method === 'POST').length, postsBeforeInvalid);

        const updated = await client.callTool({
            name: 'update_form_origins',
            arguments: {
                form: FORM_ID,
                remove_origins: ['https://old.example.com/'],
                add_origins: ['https://new.example.com'],
                add_sites: ['example.com']
            }
        });
        assert.equal(updated.isError, undefined);
        assert.deepEqual((updated.structuredContent as { corsOrigins: string[] }).corsOrigins, [
            'https://new.example.com',
            'https://example.com',
            'https://www.example.com',
            'https://forms.example.net'
        ]);

        const putsBeforeConflict = suiteRequests.filter(request => request.method === 'PUT').length;
        const conflicting = await client.callTool({
            name: 'update_form_origins',
            arguments: {
                form: FORM_ID,
                add_origins: ['https://conflict.example.com/'],
                remove_origins: ['https://conflict.example.com']
            }
        });
        assert.equal(conflicting.isError, true);
        assert.equal(suiteRequests.filter(request => request.method === 'PUT').length, putsBeforeConflict);

        const updateCount = suiteRequests.filter(request => request.method === 'PUT').length;
        await client.callTool({
            name: 'update_form_origins',
            arguments: { form: FORM_ID, add_origins: ['https://new.example.com'] }
        });
        assert.equal(suiteRequests.filter(request => request.method === 'PUT').length, updateCount, 'idempotent no-op should skip PUT');

        const removedSite = await client.callTool({
            name: 'update_form_origins',
            arguments: { form: FORM_ID, remove_sites: ['example.com'] }
        });
        assert.equal(removedSite.isError, undefined);
        assert.deepEqual((removedSite.structuredContent as { corsOrigins: string[] }).corsOrigins, ['https://new.example.com']);

        assert(suiteRequests.every(request => request.authorization === basicAuthorization()));
        assert.doesNotMatch(JSON.stringify([listed, integration, created, updated]), /api-secret|YXBpOmFwaS1zZWNyZXQ=/);
    } finally {
        await client.close();
        await hosting.close();
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
});

function existingForm(): DetailedForm {
    return {
        id: FORM_ID,
        name: 'Contact us',
        slug: 'contact-us',
        emailTo: ['ops@example.com'],
        corsOrigins: ['https://old.example.com'],
        activeDefinitionId: DEFINITION_ID,
        createdAt: '2026-07-21T12:00:00.000Z',
        updatedAt: '2026-07-21T12:00:00.000Z',
        publicUrl: 'https://zyno.app/f/acme/contact-us',
        hasDraft: true,
        submissionCount: 2,
        activeDefinition: {
            id: DEFINITION_ID,
            version: 1,
            isDraft: false,
            revision: 0,
            renderTemplate: null,
            content: {
                fieldIdsByAlias: { email: '33333333-3333-4333-8333-333333333333' },
                pages: [
                    {
                        fields: [
                            {
                                id: '33333333-3333-4333-8333-333333333333',
                                alias: 'email',
                                type: 'text',
                                label: 'Email',
                                inputType: 'email'
                            }
                        ]
                    }
                ]
            }
        }
    };
}

function basicAuthorization(): string {
    return `Basic ${Buffer.from('api:api-secret').toString('base64')}`;
}

async function requestText(request: AsyncIterable<unknown>): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8');
}
