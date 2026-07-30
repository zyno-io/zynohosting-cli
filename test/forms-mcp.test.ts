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
const EDITABLE_FORM_ID = '77777777-7777-4777-8777-777777777771';
const EDITABLE_DEFINITION_ID = '88888888-8888-4888-8888-888888888881';
const DRAFTED_FORM_ID = '77777777-7777-4777-8777-777777777772';
const EMAIL_FIELD_ID = '44444444-4444-4444-8444-444444444444';
const MESSAGE_FIELD_ID = '44444444-4444-4444-8444-444444444445';

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

        const publicMatch = request.url?.match(/^\/public\/forms\/acme\/([0-9a-f-]{36})\?definitionId=([0-9a-f-]{36})$/i);
        if (publicMatch && request.method === 'GET') {
            const form = forms.get(publicMatch[1]!);
            if (!form) {
                response.statusCode = 404;
                response.end(JSON.stringify({ message: 'not found' }));
                return;
            }
            response.end(
                JSON.stringify({
                    id: form.id,
                    tenantId: 'acme',
                    definition: { id: publicMatch[2]! },
                    ...(form.botProtectionMode
                        ? {
                              botProtection: {
                                  provider: 'cap',
                                  mode: form.botProtectionMode,
                                  apiEndpoint: `https://cap.example.test/v1/forms.submit/${form.id}/`,
                                  tokenField: 'capToken'
                              }
                          }
                        : {})
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
                response.end(JSON.stringify(withBotProtection(forms.get(FORM_ID)!)));
                return;
            }
            if (request.url === `/forms/manage/${FORM_ID}` && request.method === 'PUT') {
                const existing = forms.get(FORM_ID)!;
                const updated = {
                    ...existing,
                    ...(body?.corsOrigins === undefined ? {} : { corsOrigins: body.corsOrigins as string[] | null }),
                    ...(body?.botProtectionMode === undefined
                        ? {}
                        : { botProtectionMode: body.botProtectionMode as DetailedForm['botProtectionMode'] })
                };
                forms.set(FORM_ID, updated);
                response.end(JSON.stringify(withBotProtection(updated)));
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
                    botProtectionMode: (body?.botProtectionMode as DetailedForm['botProtectionMode'] | undefined) ?? null,
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
                response.end(JSON.stringify(withBotProtection(created)));
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
        assert.match(integrationJson, /cap-widget@0\.1\.56/);
        assert.match(integrationJson, /"tokenField":"capToken"/);

        const protectedDescription = await client.callTool({ name: 'describe_form', arguments: { form: 'contact-us' } });
        assert.equal(protectedDescription.isError, undefined);
        assert.deepEqual((protectedDescription.structuredContent as { botProtection: unknown }).botProtection, {
            provider: 'cap',
            mode: 'interactive',
            apiEndpoint: `https://cap.example.test/v1/forms.submit/${FORM_ID}/`,
            tokenField: 'capToken'
        });

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
                    { key: 'campaign', label: 'Campaign', type: 'hidden' },
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
            botProtectionMode: string;
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
        assert.equal(createBody.botProtectionMode, 'interactive', 'basic forms default to interactive Cap protection');
        assert.deepEqual(Object.keys(createBody.content.fieldIdsByAlias), ['name', 'email', 'campaign', 'budget', 'message']);
        assert(createBody.content.pages[0]!.fields.every(field => typeof field.id === 'string'));
        assert.equal(createBody.content.pages[0]!.fields[0]!.optional, undefined);
        assert.deepEqual(createBody.content.pages[0]!.fields[2], {
            id: createBody.content.pages[0]!.fields[2]!.id,
            alias: 'campaign',
            type: 'hidden',
            label: 'Campaign'
        });
        assert.equal(createBody.content.pages[0]!.fields[3]!.optional, true);
        assert.deepEqual(createBody.content.header, { title: 'Request a quote' });
        assert.deepEqual(createBody.content.submit, {
            title: 'Submit',
            successMessage: 'Thank you. Your response has been submitted.'
        });

        const disabled = await client.callTool({
            name: 'update_form_bot_protection',
            arguments: { form: FORM_ID, bot_protection: 'disabled' }
        });
        assert.equal(disabled.isError, undefined);
        const disabledResult = disabled.structuredContent as {
            botProtection: unknown;
            botProtectionSetting: string;
            form: { botProtectionMode: string | null };
            submission: { examples: { html: string; capScript?: string } };
        };
        assert.equal(disabledResult.botProtection, null);
        assert.equal(disabledResult.botProtectionSetting, 'disabled', 'the result echoes the tri-state argument it was given');
        assert.equal(disabledResult.form.botProtectionMode, null, 'the stored column stays null, as the Suite reports it');
        assert.doesNotMatch(disabledResult.submission.examples.html, /cap-widget/);
        assert.equal(Object.hasOwn(disabledResult.submission.examples, 'capScript'), false, 'disabled forms preserve the legacy examples');
        const botPuts = suiteRequests.filter(
            request => request.method === 'PUT' && (request.body as Record<string, unknown>)?.botProtectionMode === null
        ).length;
        assert.equal(botPuts, 1);
        await client.callTool({ name: 'update_form_bot_protection', arguments: { form: FORM_ID, bot_protection: 'disabled' } });
        assert.equal(
            suiteRequests.filter(request => request.method === 'PUT' && (request.body as Record<string, unknown>)?.botProtectionMode === null).length,
            botPuts,
            'an unchanged bot-protection setting skips PUT'
        );

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

test('describes and edits a form over MCP without disturbing what it was not asked to change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-forms-edit-mcp-'));
    const form = editableForm();
    const requests: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
    let publishedVersions = 1;
    let draftsCreated = 0;
    const server = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        const text = await requestText(request);
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
        requests.push({ method: request.method ?? '', url: request.url ?? '', ...(body === undefined ? {} : { body }) });

        if (request.url === `/forms/manage/${EDITABLE_FORM_ID}` && request.method === 'GET') {
            response.end(JSON.stringify(form));
            return;
        }
        if (request.url === `/forms/manage/${EDITABLE_FORM_ID}` && request.method === 'PUT') {
            if (body?.name !== undefined) form.name = body.name as string;
            if (body?.emailTo !== undefined) form.emailTo = body.emailTo as string[] | null;
            response.end(JSON.stringify(form));
            return;
        }
        if (request.url === `/forms/manage/${EDITABLE_FORM_ID}/definitions` && request.method === 'POST') {
            // Modelled on `upsertDraftLocked`: one shared draft row, a revision that climbs with every save,
            // and a stale quote rejected as a conflict. Publishing numbers the row and stops it being a draft,
            // so `getDraft` no longer finds one.
            const publish = body?.publish === true;
            const expected = body?.expectedRevision as number | undefined;
            if (expected !== undefined && (form.draftDefinition?.revision ?? 0) !== expected) {
                response.statusCode = 409;
                response.end(JSON.stringify({ error: 'Someone else has saved changes to this form since you opened it.' }));
                return;
            }
            const definition = {
                id: form.draftDefinition?.id ?? `99999999-9999-4999-8999-99999999999${++draftsCreated}`,
                version: publish ? ++publishedVersions : 0,
                isDraft: !publish,
                revision: (form.draftDefinition?.revision ?? 0) + 1,
                renderTemplate: null,
                content: body?.content as FormDefinitionContent
            };
            if (publish) {
                form.activeDefinitionId = definition.id;
                form.activeDefinition = definition;
                form.hasDraft = false;
                delete form.draftDefinition;
            } else {
                form.hasDraft = true;
                form.draftDefinition = definition;
            }
            response.end(JSON.stringify(definition));
            return;
        }
        if (request.url === `/forms/manage/${DRAFTED_FORM_ID}` && request.method === 'GET') {
            response.end(JSON.stringify({ ...editableForm(), id: DRAFTED_FORM_ID, hasDraft: true }));
            return;
        }
        if (request.url === `/forms/manage/${DRAFTED_FORM_ID}/definitions` && request.method === 'POST') {
            // A draft the GET did not return: quoting revision 0 is what makes the API reject the write.
            response.statusCode = 409;
            response.end(JSON.stringify({ error: 'Someone else has saved changes to this form since you opened it. Reload to pick them up.' }));
            return;
        }
        if (request.url?.startsWith('/public/forms/acme/') && request.method === 'GET') {
            response.end(JSON.stringify({ id: EDITABLE_FORM_ID, tenantId: 'acme', definition: { id: form.activeDefinitionId } }));
            return;
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
        version: '0.4.0',
        apiUrl: baseUrl,
        suiteApiUrl: baseUrl,
        apiKey: 'api-secret'
    });
    const client = new Client({ name: 'forms-edit-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await hosting.connect(serverTransport);
    await client.connect(clientTransport);

    try {
        const described = await client.callTool({ name: 'describe_form', arguments: { form: EDITABLE_FORM_ID } });
        assert.equal(described.isError, undefined);
        const structure = described.structuredContent as {
            editable: boolean;
            live: { definitionId: string; version: number; submitLabel: string };
            pages: Array<{ page: number; fields: Array<Record<string, unknown>> }>;
            advanced: Array<{ construct: string }>;
        };
        assert.equal(structure.editable, true);
        assert.equal(structure.live.definitionId, EDITABLE_DEFINITION_ID);
        assert.equal(structure.live.submitLabel, 'Send');
        assert.deepEqual(
            structure.pages[0]!.fields.map(field => [field.key, field.type, field.editable]),
            [
                ['email', 'email', true],
                ['message', 'textarea', true]
            ]
        );
        assert.deepEqual(structure.advanced, []);

        const edited = await client.callTool({
            name: 'update_form',
            arguments: {
                form: EDITABLE_FORM_ID,
                name: 'Contact sales',
                notification_emails: ['sales@example.com'],
                expected_definition_id: EDITABLE_DEFINITION_ID,
                operations: [
                    { op: 'add_field', after: 'email', field: { key: 'budget', label: 'Budget', type: 'number', required: false, min: 0 } },
                    { op: 'update_field', key: 'message', label: 'How can we help?' }
                ]
            }
        });
        assert.equal(edited.isError, undefined);
        const result = edited.structuredContent as {
            applied: { metadata: boolean; definition: string };
            changes: Array<{ change: string; key: string }>;
            liveDefinition: { version: number };
        };
        assert.deepEqual(result.applied, { metadata: true, definition: 'published' });
        assert.deepEqual(
            result.changes.map(change => `${change.change}:${change.key}`),
            ['added_field:budget', 'updated_field:message']
        );
        assert.equal(result.liveDefinition.version, 2);

        const metadataRequest = requests.find(entry => entry.method === 'PUT');
        assert.deepEqual(metadataRequest?.body, { name: 'Contact sales', emailTo: ['sales@example.com'] });
        const save = requests.find(entry => entry.method === 'POST' && entry.url.endsWith('/definitions'));
        assert.equal(save?.body?.publish, true);
        assert.equal(save?.body?.expectedRevision, 0, 'a form with no draft quotes revision 0 so a concurrent save is rejected');
        assert.equal(Object.hasOwn(save!.body!, 'renderTemplate'), false, 'omitting the template is what preserves the live one');
        const saved = save?.body?.content as FormDefinitionContent;
        assert.deepEqual(
            saved.pages[0]!.fields.map(field => field.alias),
            ['email', 'budget', 'message']
        );
        assert.equal(saved.pages[0]!.fields[0]!.id, EMAIL_FIELD_ID, 'an untouched field keeps its id');
        assert.equal(saved.pages[0]!.fields[2]!.format, 'large', 'an update must not rewrite what it was not given');
        assert.deepEqual(Object.keys(saved.fieldIdsByAlias!), ['email', 'budget', 'message']);

        const writesBefore = requests.filter(entry => entry.method !== 'GET').length;
        const unchanged = await client.callTool({
            name: 'update_form',
            arguments: {
                form: EDITABLE_FORM_ID,
                name: 'Contact sales',
                operations: [{ op: 'update_field', key: 'message', label: 'How can we help?' }]
            }
        });
        assert.equal(unchanged.isError, undefined);
        assert.deepEqual((unchanged.structuredContent as { applied: unknown }).applied, { metadata: false, definition: 'unchanged' });
        assert.deepEqual(
            (unchanged.structuredContent as { changes: unknown[] }).changes,
            [],
            'nothing was written, so nothing is reported as changed'
        );
        assert.equal(requests.filter(entry => entry.method !== 'GET').length, writesBefore, 'an edit that changes nothing writes nothing');

        const stale = await client.callTool({
            name: 'update_form',
            arguments: { form: EDITABLE_FORM_ID, expected_definition_id: EDITABLE_DEFINITION_ID, operations: [{ op: 'remove_field', key: 'budget' }] }
        });
        assert.equal(stale.isError, true);
        assert.match(JSON.stringify(stale.content), /describe it again/);

        const drafted = await client.callTool({
            name: 'update_form',
            arguments: { form: DRAFTED_FORM_ID, operations: [{ op: 'remove_field', key: 'message' }] }
        });
        assert.equal(drafted.isError, true);
        assert.match(JSON.stringify(drafted.content), /unpublished draft/);
        assert.equal(requests.filter(entry => entry.method !== 'GET').length, writesBefore, 'a refused edit reaches no write endpoint');

        const draftSaved = await client.callTool({
            name: 'update_form',
            arguments: { form: EDITABLE_FORM_ID, publish: false, operations: [{ op: 'remove_field', key: 'budget' }] }
        });
        assert.equal(draftSaved.isError, undefined);
        assert.deepEqual((draftSaved.structuredContent as { applied: unknown }).applied, { metadata: false, definition: 'draft' });
        assert.equal(
            (draftSaved.structuredContent as { liveDefinition: { version: number } }).liveDefinition.version,
            2,
            'the live version is untouched'
        );

        const extended = await client.callTool({
            name: 'update_form',
            arguments: {
                form: EDITABLE_FORM_ID,
                publish: false,
                on_existing_draft: 'extend',
                operations: [{ op: 'update_field', key: 'message', label: 'Tell us more' }]
            }
        });
        assert.equal(extended.isError, undefined);
        const extendSave = requests.filter(entry => entry.method === 'POST' && entry.url.endsWith('/definitions')).at(-1);
        assert.equal(extendSave?.body?.expectedRevision, 1, 'extending quotes the revision of the draft it was based on');
        const extendedContent = extendSave?.body?.content as FormDefinitionContent;
        assert.deepEqual(
            extendedContent.pages[0]!.fields.map(field => field.alias),
            ['email', 'message'],
            'extending builds on the draft, which no longer holds the removed field'
        );
        assert.equal(extendedContent.pages[0]!.fields[1]!.label, 'Tell us more');

        // `hasDraft` and the draft body are two queries: a discard between them leaves the first true and the
        // second empty. The API adjudicates that, rather than the CLI calling the response invalid.
        const raced = await client.callTool({
            name: 'update_form',
            arguments: {
                form: DRAFTED_FORM_ID,
                on_existing_draft: 'extend',
                operations: [{ op: 'update_field', key: 'message', label: 'Raced' }]
            }
        });
        assert.equal(raced.isError, true);
        assert.match(JSON.stringify(raced.content), /Someone else has saved changes/);
        assert.doesNotMatch(JSON.stringify(raced.content), /did not return/);

        // Publishing a draft is a request in its own right. An edit the draft already reflects still has to
        // reach the API, or the tool reports success while the form never goes live.
        const publishedDraft = await client.callTool({
            name: 'update_form',
            arguments: {
                form: EDITABLE_FORM_ID,
                publish: true,
                on_existing_draft: 'extend',
                operations: [{ op: 'update_field', key: 'message', label: 'Tell us more' }]
            }
        });
        assert.equal(publishedDraft.isError, undefined);
        assert.deepEqual((publishedDraft.structuredContent as { applied: unknown }).applied, { metadata: false, definition: 'published' });
        const publishSave = requests.filter(entry => entry.method === 'POST' && entry.url.endsWith('/definitions')).at(-1);
        assert.equal(publishSave?.body?.publish, true, 'the no-op short-circuit must not swallow a publish');
        assert.equal(publishSave?.body?.expectedRevision, 2, 'each draft save climbs the revision, and the next quote follows it');
        const afterPublish = (publishedDraft.structuredContent as { form: { hasDraft: boolean } }).form;
        assert.equal(afterPublish.hasDraft, false, 'publishing consumes the draft');

        // Moving a field across a repeating-section boundary changes its response shape. A custom template
        // needs its own warning because it may still expect the scalar value in notification emails or PDFs.
        const sectionId = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const guestId = 'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        form.activeDefinition!.renderTemplate = '{{ email }}';
        form.activeDefinition!.content = {
            fieldIdsByAlias: { guest: guestId, email: EMAIL_FIELD_ID },
            header: { title: 'Contact us' },
            submit: { title: 'Send', successMessage: 'Thanks!' },
            pages: [
                {
                    fields: [
                        {
                            id: sectionId,
                            type: 'section',
                            repeat: { min: 1, max: 3 },
                            fields: [{ id: guestId, alias: 'guest', type: 'text', label: 'Guest' }]
                        },
                        { id: EMAIL_FIELD_ID, alias: 'email', type: 'text', label: 'Email', inputType: 'email' }
                    ]
                }
            ]
        };
        const reshaped = await client.callTool({
            name: 'update_form',
            arguments: { form: EDITABLE_FORM_ID, operations: [{ op: 'move_field', key: 'email', after: 'guest' }] }
        });
        assert.equal(reshaped.isError, undefined);
        assert(
            (reshaped.structuredContent as { warnings: string[] }).warnings.some(warning => /custom submission template/.test(warning)),
            'a response-shape change must warn that a template can no longer render the field as before'
        );
    } finally {
        await client.close();
        await hosting.close();
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
});

test('refuses to report bot protection a Suite without Cap support never applied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zynohosting-forms-precap-'));
    let createBody: Record<string, unknown> | undefined;
    // A deployment predating Cap accepts the field and echoes a form without it, which reads as disabled.
    const preCapForm = () => {
        const { botProtectionMode: _mode, ...form } = editableForm();
        return form;
    };
    const server = createServer(async (request, response) => {
        const text = await requestText(request);
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/forms/manage' && request.method === 'POST') {
            createBody = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
            response.end(JSON.stringify(preCapForm()));
            return;
        }
        if (request.url === `/forms/manage/${EDITABLE_FORM_ID}`) {
            response.end(JSON.stringify(preCapForm()));
            return;
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
        version: '0.4.0',
        apiUrl: baseUrl,
        suiteApiUrl: baseUrl,
        apiKey: 'api-secret'
    });
    const client = new Client({ name: 'forms-precap-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await hosting.connect(serverTransport);
    await client.connect(clientTransport);

    try {
        const described = await client.callTool({ name: 'describe_form', arguments: { form: EDITABLE_FORM_ID } });
        assert.equal(described.isError, undefined, 'reading a form from an older Suite still works');
        assert.equal((described.structuredContent as { botProtection: unknown }).botProtection, null);

        const created = await client.callTool({
            name: 'create_basic_form',
            arguments: {
                name: 'Protected contact form',
                fields: [{ key: 'email', label: 'Email', type: 'email' }]
            }
        });
        assert.equal(created.isError, true);
        assert.equal(createBody?.botProtectionMode, 'interactive', 'the default requests interactive protection');
        assert.match(JSON.stringify(created.content), new RegExp(`form ${EDITABLE_FORM_ID} was created, but ZynoSuite did not apply bot protection`));

        const attempted = await client.callTool({
            name: 'update_form_bot_protection',
            arguments: { form: EDITABLE_FORM_ID, bot_protection: 'interactive' }
        });
        assert.equal(attempted.isError, true);
        assert.match(JSON.stringify(attempted.content), /did not apply bot protection/);
    } finally {
        await client.close();
        await hosting.close();
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
});

function editableForm(): DetailedForm {
    return {
        id: EDITABLE_FORM_ID,
        name: 'Contact us',
        slug: 'contact-us',
        emailTo: ['ops@example.com'],
        corsOrigins: null,
        botProtectionMode: null,
        activeDefinitionId: EDITABLE_DEFINITION_ID,
        createdAt: '2026-07-21T12:00:00.000Z',
        updatedAt: '2026-07-21T12:00:00.000Z',
        publicUrl: 'https://zyno.app/f/acme/contact-us',
        hasDraft: false,
        submissionCount: 0,
        activeDefinition: {
            id: EDITABLE_DEFINITION_ID,
            version: 1,
            isDraft: false,
            revision: 0,
            renderTemplate: null,
            content: {
                fieldIdsByAlias: { email: EMAIL_FIELD_ID, message: MESSAGE_FIELD_ID },
                header: { title: 'Contact us' },
                submit: { title: 'Send', successMessage: 'Thanks!' },
                pages: [
                    {
                        fields: [
                            { id: EMAIL_FIELD_ID, alias: 'email', type: 'text', label: 'Email', inputType: 'email' },
                            { id: MESSAGE_FIELD_ID, alias: 'message', type: 'text', label: 'Message', format: 'large' }
                        ]
                    }
                ]
            }
        }
    };
}

function existingForm(): DetailedForm {
    return {
        id: FORM_ID,
        name: 'Contact us',
        slug: 'contact-us',
        emailTo: ['ops@example.com'],
        corsOrigins: ['https://old.example.com'],
        botProtectionMode: 'interactive',
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

function withBotProtection(form: DetailedForm): DetailedForm {
    const { botProtection: _, ...withoutConfig } = form;
    if (!form.botProtectionMode) return withoutConfig;
    return {
        ...withoutConfig,
        botProtection: {
            provider: 'cap',
            mode: form.botProtectionMode,
            apiEndpoint: `https://cap.example.test/v1/forms.submit/${form.id}/`,
            tokenField: 'capToken'
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
