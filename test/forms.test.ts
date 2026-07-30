import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { DetailedForm, FormsClient } from '../src/api/forms-client.js';
import { buildBasicFormDefinition, buildFormIntegration, EMBEDDING_GUIDE, normalizeWebOrigin } from '../src/mcp/forms.js';

const FORM_ID = '11111111-1111-4111-8111-111111111111';
const DEFINITION_ID = '22222222-2222-4222-8222-222222222222';

test('builds a published-form definition with stable aliases, generated UUIDs, and basic field mappings', () => {
    const definition = buildBasicFormDefinition({
        name: 'Contact us',
        title: 'Talk to us',
        slug: 'contact-us',
        submit_label: 'Send',
        success_message: 'Received!',
        notification_emails: [],
        origins: [],
        origin_sites: [],
        bot_protection: 'interactive',
        fields: [
            { key: 'message', label: 'Message', type: 'textarea', required: true, min_length: 10, max_length: 1000 },
            { key: 'email', label: 'Email', type: 'email', required: false },
            {
                key: 'contact',
                type: 'contact',
                required: true,
                fields: ['first_name', 'last_name', 'email', 'phone_cell', 'address']
            },
            { key: 'department', label: 'Department', type: 'radio', required: true, options: ['Sales', { title: 'Help', value: 'support' }] },
            { key: 'terms', label: 'I agree', type: 'checkbox', required: true }
        ]
    });

    assert.deepEqual(definition.header, { title: 'Talk to us' });
    assert.deepEqual(definition.submit, { title: 'Send', successMessage: 'Received!' });
    assert.equal(definition.pages.length, 1);
    const fields = definition.pages[0]!.fields;
    assert.equal(new Set(fields.map(field => field.id)).size, fields.length);
    assert(fields.every(field => /^[0-9a-f-]{36}$/.test(field.id)));
    assert.deepEqual(definition.fieldIdsByAlias, Object.fromEntries(fields.map(field => [field.alias, field.id])));
    assert.deepEqual(fields[0], {
        id: fields[0]!.id,
        alias: 'message',
        type: 'text',
        label: 'Message',
        format: 'large',
        minLength: 10,
        maxLength: 1000
    });
    assert.deepEqual(fields[1], {
        id: fields[1]!.id,
        alias: 'email',
        optional: true,
        type: 'text',
        label: 'Email',
        inputType: 'email'
    });
    assert.deepEqual(fields[2]!.fields, { firstName: true, lastName: true, email: true, phoneCell: true, address: true });
    assert.deepEqual(fields[3]!.options, [{ title: 'Sales' }, { title: 'Help', value: 'support' }]);
});

test('maps every basic scalar field type and its constraints to the Suite definition model', () => {
    const definition = buildBasicFormDefinition({
        name: 'All fields',
        submit_label: 'Submit',
        success_message: 'Done',
        notification_emails: [],
        origins: [],
        origin_sites: [],
        bot_protection: 'interactive',
        fields: [
            { key: 'plain', label: 'Plain', type: 'text', required: true, placeholder: 'Type here' },
            { key: 'phone', label: 'Phone', type: 'phone', required: true },
            { key: 'website', label: 'Website', type: 'url', required: true },
            { key: 'campaign', label: 'Campaign', type: 'hidden' },
            { key: 'amount', label: 'Amount', type: 'number', required: true, min: 0, max: 10, step: 0.5 },
            { key: 'day', label: 'Day', type: 'date', required: true, min: '2026-01-01', max: '2026-12-31' },
            { key: 'choice', label: 'Choice', type: 'select', required: true, options: ['One', 'Two'], enable_other: true }
        ]
    });
    const fields = definition.pages[0]!.fields;

    assert.equal(fields[0]!.type, 'text');
    assert.equal(fields[0]!.placeholder, 'Type here');
    assert.equal(fields[1]!.inputType, 'tel');
    assert.equal(fields[2]!.inputType, 'url');
    assert.deepEqual(fields[3], { id: fields[3]!.id, alias: 'campaign', type: 'hidden', label: 'Campaign' });
    assert.deepEqual({ min: fields[4]!.min, max: fields[4]!.max, step: fields[4]!.step }, { min: 0, max: 10, step: 0.5 });
    assert.deepEqual({ min: fields[5]!.min, max: fields[5]!.max }, { min: '2026-01-01', max: '2026-12-31' });
    assert.deepEqual(fields[6]!.options, ['One', 'Two']);
    assert.equal(fields[6]!.enableOther, true);
});

test('normalizes exact web origins and rejects paths, credentials, and non-web schemes', () => {
    assert.equal(normalizeWebOrigin('https://EXAMPLE.com:443'), 'https://example.com');
    assert.equal(normalizeWebOrigin('http://localhost:8080/'), 'http://localhost:8080');
    assert.throws(() => normalizeWebOrigin('https://example.com/path'), /scheme and host/);
    assert.throws(() => normalizeWebOrigin('https://user@example.com'), /scheme and host/);
    assert.throws(() => normalizeWebOrigin('ftp://example.com'), /scheme and host/);
});

test('builds live endpoints and alias-keyed examples without credentials', () => {
    const integration = buildFormIntegration(detailedForm(), 'https://suite.api.zyno.app');
    const summary = integration.form as Record<string, unknown>;
    assert.equal(Object.hasOwn(summary, 'activeDefinition'), false);
    assert.equal(Object.hasOwn(summary, 'draftDefinition'), false);
    assert.deepEqual(integration.liveDefinition, { id: DEFINITION_ID, version: 1, revision: 0, published: true });
    assert.equal(integration.botProtection, null);
    const { iframeAutoHeight, ...endpoints } = integration.endpoints as Record<string, string> & { iframeAutoHeight: string };
    assert.deepEqual(endpoints, {
        direct: 'https://zyno.app/f/acme/contact-us',
        iframe: '<iframe src="https://zyno.app/f/acme/contact-us" title="Contact us" style="width:100%;min-height:720px;border:0" loading="lazy"></iframe>',
        definition: `https://suite.api.zyno.app/public/forms/acme/${FORM_ID}?definitionId=${DEFINITION_ID}`,
        currentDefinition: `https://suite.api.zyno.app/public/forms/acme/${FORM_ID}`,
        submission: `https://suite.api.zyno.app/public/forms/acme/${FORM_ID}/${DEFINITION_ID}/submissions`
    });
    // The generated listener must be selective: any framed page can post a message, and one host page
    // may embed several forms.
    assert.match(iframeAutoHeight, /<iframe src="https:\/\/zyno\.app\/f\/acme\/contact-us"/);
    assert.doesNotMatch(iframeAutoHeight, /id="zynoform-/);
    // Each pasted snippet binds to its immediately preceding iframe rather than a page-global ID, so
    // embedding the same form twice does not make both listeners target the first frame.
    assert.match(iframeAutoHeight, /document\.currentScript && document\.currentScript\.previousElementSibling/);
    assert.match(iframeAutoHeight, /event\.origin !== "https:\/\/zyno\.app"/);
    assert.match(iframeAutoHeight, /message\.type !== "zcx:embed:form-height"/);
    // Not `message.formId`: a public URL may name the form by slug, so the id is only canonical after
    // the definition loads.
    assert.match(iframeAutoHeight, /event\.source !== frame\.contentWindow/);
    assert.doesNotMatch(iframeAutoHeight, /message\.formId/);
    assert.match(iframeAutoHeight, /typeof message\.height !== "number"/);
    assert.match(iframeAutoHeight, /frame\.style\.height = Math\.ceil\(message\.height\) \+ "px"/);
    const submission = integration.submission as Record<string, unknown>;
    assert.deepEqual(submission.openApiContentTypes, ['application/json']);
    assert.deepEqual(submission.acceptedContentTypes, ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data']);
    const examples = submission.examples as { json: unknown; urlencodedFields: Record<string, string>; html: string };
    assert.deepEqual(examples.json, {
        responses: {
            email: 'person@example.com',
            contact: {
                firstName: 'Alex',
                lastName: 'Example',
                street1: '123 Main St',
                zip: '10001',
                city: 'Example',
                state: 'NY'
            }
        }
    });
    assert.equal(examples.urlencodedFields['responses[contact][firstName]'], 'Alex');
    assert.equal(examples.urlencodedFields['responses[contact][street1]'], '123 Main St');
    assert.equal(examples.urlencodedFields['responses[contact][state]'], 'NY');
    assert.equal(examples.urlencodedFields['responses[contact][street2]'], undefined);
    assert.equal(examples.urlencodedFields['responses[contact][phoneHome]'], undefined);
    assert.match(examples.html, /name="responses\[email\]"/);
    assert.doesNotMatch(JSON.stringify(integration), /api-secret|Authorization|Bearer/);
    assert.match(EMBEDDING_GUIDE, /OpenAPI-advertised/);
    assert.match(EMBEDDING_GUIDE, /application\/x-www-form-urlencoded/);
    assert.match(EMBEDDING_GUIDE, /zcx:embed:form-height/);
    assert.match(EMBEDDING_GUIDE, /iframeAutoHeight/);
    // A site building its own themed form needs the verb, the header, and what an answer looks like.
    assert.match(EMBEDDING_GUIDE, /Content-Type: application\/json/);
    assert.match(EMBEDDING_GUIDE, /\{ "ok": true \}/);
    assert.match(EMBEDDING_GUIDE, /\{ "error": "<message>" \}/);

    // No bot protection on this form, so the plain JSON submitter stands in for capScript.
    const submitters = examples as unknown as Record<string, string | undefined>;
    assert.equal(submitters.capScript, undefined);
    const jsonScript = submitters.jsonScript!;
    assert.match(jsonScript, /method: 'POST', headers: \{ 'Content-Type': 'application\/json' \}/);
    assert.match(jsonScript, new RegExp(`fetch\\("https://suite\\.api\\.zyno\\.app/public/forms/acme/${FORM_ID}/${DEFINITION_ID}/submissions"`));
    assert.match(jsonScript, /JSON\.stringify\(\{ responses \}\)/);
    assert.match(jsonScript, /result\.error \|\| /);
    assert.match(jsonScript, /\(\(\) => \{/);
    assert.match(jsonScript, /\}\)\(\);/);
    assert.doesNotMatch(jsonScript, /(?:window\.)?submitZynoForm\s*=/, 'the helper must not overwrite one from another pasted snippet');
});

test('describes and prefills hidden URL-parameter fields in generated integrations', () => {
    const form = detailedForm();
    const hiddenId = '99999999-9999-4999-8999-999999999999';
    form.activeDefinition!.content.fieldIdsByAlias!.campaign = hiddenId;
    form.activeDefinition!.content.pages[0]!.fields.push({ id: hiddenId, alias: 'campaign', type: 'hidden', label: 'Campaign' });

    const integration = buildFormIntegration(form, 'https://suite.api.zyno.app');
    const submission = integration.submission as {
        fieldsByAlias: Record<string, Record<string, unknown>>;
        examples: { json: { responses: Record<string, unknown> }; html: string };
    };
    assert.deepEqual(submission.fieldsByAlias.campaign, {
        fieldId: hiddenId,
        submissionKey: 'campaign',
        type: 'hidden',
        required: false,
        label: 'Campaign',
        source: 'urlQueryParameter',
        urlParameter: 'campaign'
    });

    const examples = submission.examples;
    assert.equal(examples.json.responses.campaign, 'example-url-value');
    assert.match(examples.html, new RegExp(`<input type="hidden" id="zyno-hidden-${hiddenId}" name="responses\\[campaign\\]" disabled>`));
    assert.match(examples.html, /"parameter":"campaign"/);
    assert.match(examples.html, /new URLSearchParams\(window\.location\.search\)\.get\(parameter\)/);
    assert.doesNotMatch(examples.html, /<label>Campaign/);
    assert.match(EMBEDDING_GUIDE, /visitor-controlled attribution/);
});

test('rejects a malformed hidden field without its URL parameter alias', () => {
    const form = detailedForm();
    form.activeDefinition!.content.pages[0]!.fields = [{ id: '99999999-9999-4999-8999-999999999999', type: 'hidden', label: 'Campaign' }];
    form.activeDefinition!.content.fieldIdsByAlias = {};
    assert.throws(() => buildFormIntegration(form, 'https://suite.api.zyno.app'), /hidden field .*required URL parameter name/);
});

function protectedForm(mode: 'interactive' | 'invisible'): DetailedForm {
    const form = detailedForm();
    form.botProtectionMode = mode;
    form.botProtection = {
        provider: 'cap',
        mode,
        apiEndpoint: `https://cap.example.test/v1/forms.submit/${FORM_ID}/`,
        tokenField: 'capToken'
    };
    return form;
}

test('adds Cap.js widget and programmatic JSON guidance only when bot protection is enabled', () => {
    const interactive = buildFormIntegration(protectedForm('interactive'), 'https://suite.api.zyno.app');
    const interactiveExamples = (interactive.submission as { examples: { html: string; capScript: string } }).examples;
    assert.match(interactiveExamples.html, /cap-widget@0\.1\.56/);
    assert.match(interactiveExamples.html, /<cap-widget required data-cap-api-endpoint=/);
    assert.match(interactiveExamples.html, /data-cap-hidden-field-name="capToken"/);
    assert.match(interactiveExamples.html, /<form id="zyno-form" method="post" action=/, 'an interactive form still posts natively');
    assert.match(interactiveExamples.capScript, /zynoCapWidget\?\.tokenValue/);
    assert.match(interactiveExamples.capScript, /if \(response\.ok\)/);
    assert.match(interactiveExamples.capScript, /zynoCapWidget\.reset\(\)/);
    assert.match(interactiveExamples.capScript, /capToken/);
    assert.deepEqual(interactive.warnings, [], 'an interactive widget posts its own hidden proof, so the markup stands alone');

    const invisible = buildFormIntegration(protectedForm('invisible'), 'https://suite.api.zyno.app');
    const invisibleExamples = (invisible.submission as { examples: { html: string; capScript: string } }).examples;
    assert.doesNotMatch(invisibleExamples.html, /<cap-widget/);
    assert.match(invisibleExamples.html, /^<!-- Invisible bot protection: the capScript example submits this form/);
    // The action stays put: if the script never loads, a native post fails loudly instead of navigating to
    // a URL carrying every answer in its query string.
    assert.match(invisibleExamples.html, /<form id="zyno-form" method="post" action=/);
    assert.match(invisibleExamples.html, /<p id="zyno-status" role="status" aria-live="polite"><\/p>$/);
    assert(
        invisible.warnings.some(warning => /cannot post by itself/.test(warning)),
        'an HTML example that the API would always reject has to say so'
    );
    assert.match(invisibleExamples.capScript, /document\.querySelector\("#zyno-form"\)/, 'the script must find the markup it ships with');
    assert.match(invisibleExamples.capScript, /addEventListener\('submit'/);
    assert.match(invisibleExamples.capScript, /event\.preventDefault\(\)/);
    assert.match(invisibleExamples.capScript, /capToken/);

    // JSON, not the form's own encoding: urlencoded is a simple request, so an unallowed origin would have
    // its submission stored and only the response hidden.
    assert.match(invisibleExamples.capScript, /'Content-Type': 'application\/json'/);
    assert.doesNotMatch(invisibleExamples.capScript, /URLSearchParams/);
    // One solver per page — constructing Cap appends a hidden widget and spawns workers that nothing removes.
    assert.match(invisibleExamples.capScript, /^const zynoCap = new Cap\(\{ apiEndpoint: /m);
    assert.equal(invisibleExamples.capScript.match(/new Cap\(/g)?.length, 1);
    // A listener's rejected promise goes nowhere a visitor can see, so outcomes are written to the page.
    assert.match(invisibleExamples.capScript, /zynoStatus\.textContent = error\.message/);
    assert.match(invisibleExamples.capScript, /submit\.disabled = true/);
});

test('builds prototype-safe response objects for invisible protected forms', () => {
    const form = protectedForm('invisible');
    const contactId = '55555555-5555-4555-8555-555555555555';
    // `toString` is a valid field alias. The generated script must not traverse into Object.prototype when
    // this contact field produces a nested response object.
    form.activeDefinition!.content.fieldIdsByAlias = { toString: contactId };
    form.activeDefinition!.content.pages[0]!.fields = [
        { id: contactId, alias: 'toString', type: 'contact', fields: { firstName: true, email: true } }
    ];

    const script = (buildFormIntegration(form, 'https://suite.api.zyno.app').submission as { examples: { capScript: string } }).examples.capScript;
    assert.match(script, /const responses = Object\.create\(null\);/);
    assert.match(script, /if \(!Object\.hasOwn\(node, part\)\) node\[part\] =/);
    assert.doesNotMatch(script, /node = node\[part\] \?\?=/);
});

test('keeps a solved proof usable when the API rejects the responses rather than the verification', () => {
    const interactive = buildFormIntegration(protectedForm('interactive'), 'https://suite.api.zyno.app');
    const capScript = (interactive.submission as { examples: { capScript: string } }).examples.capScript;

    // The Suite validates fields before it consumes the proof, so only a spent or stale proof is reset.
    assert.doesNotMatch(capScript, /finally/);
    assert.match(capScript, /if \(response\.ok\) \{\n\s+zynoCapWidget\.reset\(\);/);
    // The proof is consumed before the submission transaction, so only a field-level 400 provably left it
    // unspent — anything else has to send the visitor back through verification.
    assert.match(capScript, /if \(response\.status !== 400 \|\| \/verification\/i\.test\(failure\.error \?\? ''\)\) zynoCapWidget\.reset\(\);/);
    // The Suite writes rejections as {"error": "..."}, so reading `message` would surface nothing.
    assert.doesNotMatch(capScript, /failure\.message/);
});

test('submits a boolean answer for questions a tickbox cannot express', () => {
    const form = detailedForm();
    const fid = (n: number) => `4444444${n}-4444-4444-8444-444444444444`;
    form.activeDefinition!.content.fieldIdsByAlias = {};
    form.activeDefinition!.content.pages[0]!.fields = [
        { id: fid(1), type: 'marketingOptOut', label: 'Yes, send me offers', inverted: true },
        { id: fid(2), type: 'marketingOptOut', label: 'Do not contact me' },
        { id: fid(3), type: 'checkbox', label: 'Do you consent?', format: 'yesno' },
        { id: fid(4), type: 'checkbox', label: 'I agree' }
    ];
    const html = (buildFormIntegration(form, 'https://suite.api.zyno.app').submission as { examples: { html: string } }).examples.html;

    // The stored value always means "opted out", whichever way the question is worded, and an untouched
    // question is itself an answer — so the renderer's seeded default is preselected rather than omitted.
    assert.match(html, new RegExp(`name="responses\\[${fid(1)}\\]" value="false"> Yes`));
    assert.match(html, new RegExp(`name="responses\\[${fid(1)}\\]" value="true" checked> No`));
    assert.match(html, new RegExp(`name="responses\\[${fid(2)}\\]" value="true"> Yes`));
    assert.match(html, new RegExp(`name="responses\\[${fid(2)}\\]" value="false" checked> No`));

    // A yes/no question is required and starts unanswered: a tickbox could only ever say yes.
    assert.match(html, new RegExp(`name="responses\\[${fid(3)}\\]" value="true" required> Yes`));
    assert.match(html, new RegExp(`name="responses\\[${fid(3)}\\]" value="false" required> No`));
    assert.doesNotMatch(html, new RegExp(`name="responses\\[${fid(3)}\\]"[^>]*checked`));

    // A plain agreement checkbox is still a checkbox.
    assert.match(html, new RegExp(`type="checkbox" name="responses\\[${fid(4)}\\]" value="true" required`));
});

test('describes repeatable-section aliases as arrays in generated integration examples', () => {
    const form = detailedForm();
    form.activeDefinition!.content.fieldIdsByAlias!.guestName = '55555555-5555-4555-8555-555555555555';
    form.activeDefinition!.content.pages.push({
        fields: [
            {
                id: '66666666-6666-4666-8666-666666666666',
                type: 'section',
                repeat: { min: 1, max: 3 },
                fields: [
                    {
                        id: '55555555-5555-4555-8555-555555555555',
                        alias: 'guestName',
                        type: 'text',
                        label: 'Guest name'
                    }
                ]
            }
        ]
    });

    const integration = buildFormIntegration(form, 'https://suite.api.zyno.app');
    const submission = integration.submission as {
        fieldsByAlias: Record<string, Record<string, unknown>>;
        examples: { json: { responses: Record<string, unknown> }; urlencodedFields: Record<string, string>; html: string };
    };
    assert.deepEqual(submission.examples.json.responses.guestName, ['example response']);
    assert.equal(submission.examples.urlencodedFields['responses[guestName][0]'], 'example response');
    assert.equal(submission.fieldsByAlias.guestName!.repeated, true);
    assert.match(submission.examples.html, /name="responses\[guestName\]\[0\]"/);
});

test('falls back to a field UUID when a legacy alias is unsafe for bracket notation', () => {
    const form = detailedForm();
    const fieldId = '77777777-7777-4777-8777-777777777777';
    form.activeDefinition!.content.fieldIdsByAlias = Object.fromEntries([
        ...Object.entries(form.activeDefinition!.content.fieldIdsByAlias!),
        ['__proto__', fieldId]
    ]);
    form.activeDefinition!.content.pages[0]!.fields.push({ id: fieldId, alias: '__proto__', type: 'text', label: 'Legacy field' });

    const integration = buildFormIntegration(form, 'https://suite.api.zyno.app');
    const submission = integration.submission as {
        fieldsByAlias: Record<string, { submissionKey: string }>;
        examples: { json: { responses: Record<string, unknown> }; html: string };
    };
    assert.equal(submission.fieldsByAlias['__proto__']!.submissionKey, fieldId);
    assert.equal(submission.examples.json.responses[fieldId], 'example response');
    assert.equal(Object.hasOwn(submission.examples.json.responses, '__proto__'), false);
    assert.match(submission.examples.html, new RegExp(`responses\\[${fieldId}\\]`));
    assert.match((integration.warnings as string[]).join(' '), /reserved/);
});

test('FormsClient sends shared credentials to exact Suite paths and rejects malformed responses', async () => {
    const seen: Array<{ method: string; url: string; authorization: string | undefined; body: unknown }> = [];
    let malformed = false;
    let preCap = false;
    const server = createServer(async (request, response) => {
        const bodyText = await requestText(request);
        seen.push({
            method: request.method ?? '',
            url: request.url ?? '',
            authorization: request.headers.authorization,
            body: bodyText ? JSON.parse(bodyText) : undefined
        });
        response.setHeader('Content-Type', 'application/json');
        if (malformed) {
            response.end(JSON.stringify({ unexpected: true }));
            return;
        }
        if (preCap) {
            const { botProtectionMode: _mode, ...summary } = formSummary();
            const { botProtection: _config, botProtectionMode: _detailedMode, ...detailed } = protectedDetailedForm();
            response.end(JSON.stringify(request.url === '/forms' ? [summary] : detailed));
            return;
        }
        if (request.url === '/forms') response.end(JSON.stringify([formSummary()]));
        else if (request.url === `/forms/manage/${FORM_ID}` && request.method === 'GET') response.end(JSON.stringify(protectedDetailedForm()));
        else if (request.url === '/forms/manage' && request.method === 'POST') response.end(JSON.stringify(protectedDetailedForm()));
        else if (request.url === `/forms/manage/${FORM_ID}` && request.method === 'PUT') response.end(JSON.stringify(protectedDetailedForm()));
        else {
            response.statusCode = 404;
            response.end(JSON.stringify({ message: 'not found' }));
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const client = new FormsClient(`http://127.0.0.1:${address.port}`, { type: 'api-key', apiKey: 'api-secret' });

    try {
        assert.equal((await client.listForms())[0]!.id, FORM_ID);
        const detailed = await client.getForm(FORM_ID);
        assert.equal(detailed.activeDefinition?.id, DEFINITION_ID);
        assert.equal(detailed.botProtection?.mode, 'interactive');
        await client.createForm({ name: 'Contact us', content: detailedForm().activeDefinition!.content });
        await client.updateForm(FORM_ID, { corsOrigins: ['https://example.com'] });
        assert.deepEqual(
            seen.map(request => [request.method, request.url]),
            [
                ['GET', '/forms'],
                ['GET', `/forms/manage/${FORM_ID}`],
                ['POST', '/forms/manage'],
                ['PUT', `/forms/manage/${FORM_ID}`]
            ]
        );
        assert(seen.every(request => request.authorization === `Basic ${Buffer.from('api:api-secret').toString('base64')}`));
        assert.deepEqual(seen[3]!.body, { corsOrigins: ['https://example.com'] });

        // A Suite deployment that predates Cap sends no bot-protection field at all. The CLI can be pointed
        // at that environment while another is already upgraded, so its absence has to read as "off".
        preCap = true;
        const legacy = await client.listForms();
        assert.equal(legacy[0]!.botProtectionMode, null);
        const legacyDetailed = await client.getForm(FORM_ID);
        assert.equal(legacyDetailed.botProtectionMode, null);
        assert.equal(legacyDetailed.botProtection, undefined);
        preCap = false;

        malformed = true;
        await assert.rejects(client.listForms(), (error: unknown) => error instanceof Error && /invalid forms response/.test(error.message));
        await assert.rejects(
            new FormsClient(undefined, { type: 'api-key', apiKey: 'api-secret' }).listForms(),
            (error: unknown) => error instanceof Error && /Suite API URL is not configured/.test(error.message)
        );
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
});

function formSummary() {
    return {
        id: FORM_ID,
        name: 'Contact us',
        slug: 'contact-us',
        emailTo: ['ops@example.com'],
        corsOrigins: ['https://old.example.com'],
        botProtectionMode: null,
        activeDefinitionId: DEFINITION_ID,
        createdAt: '2026-07-21T12:00:00.000Z',
        updatedAt: '2026-07-21T12:00:00.000Z',
        publicUrl: 'https://zyno.app/f/acme/contact-us',
        hasDraft: false,
        submissionCount: 2
    };
}

function detailedForm(): DetailedForm {
    return {
        ...formSummary(),
        activeDefinition: {
            id: DEFINITION_ID,
            version: 1,
            isDraft: false,
            revision: 0,
            renderTemplate: null,
            content: {
                fieldIdsByAlias: {
                    email: '33333333-3333-4333-8333-333333333333',
                    contact: '44444444-4444-4444-8444-444444444444'
                },
                pages: [
                    {
                        fields: [
                            {
                                id: '33333333-3333-4333-8333-333333333333',
                                alias: 'email',
                                type: 'text',
                                label: 'Email',
                                inputType: 'email'
                            },
                            {
                                id: '44444444-4444-4444-8444-444444444444',
                                alias: 'contact',
                                type: 'contact',
                                fields: { firstName: true, lastName: true, address: true, phoneHome: true, phoneWork: true }
                            }
                        ]
                    }
                ]
            }
        }
    };
}

function protectedDetailedForm(): DetailedForm {
    return {
        ...detailedForm(),
        botProtectionMode: 'interactive',
        botProtection: {
            provider: 'cap',
            mode: 'interactive',
            apiEndpoint: `https://cap.example.test/v1/forms.submit/${FORM_ID}/`,
            tokenField: 'capToken'
        }
    };
}

async function requestText(request: AsyncIterable<unknown>): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8');
}
