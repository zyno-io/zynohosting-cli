import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { DetailedForm, FormDefinitionContent, FormField, FormsClient, FormSummary } from '../api/forms-client.js';
import { ManagerClient } from '../api/manager-client.js';
import { CliError } from '../errors.js';

const ALIAS_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const UNSAFE_FORM_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORM_SUBMISSION_MAX_BODY_BYTES = 5 * 1024 * 1024;
const EMBEDDING_GUIDE_URI = 'zynoforms://guides/embedding';

const commonFieldIdentityShape = {
    key: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .regex(ALIAS_PATTERN, 'must be a JavaScript identifier, using letters, numbers, _, or $')
        .refine(key => !UNSAFE_FORM_KEYS.has(key), 'is reserved by the web-form parser'),
    required: z.boolean().default(true)
};

const commonFieldShape = { ...commonFieldIdentityShape, label: z.string().trim().min(1).max(255) };

const textFieldSchema = z
    .object({
        ...commonFieldShape,
        type: z.enum(['text', 'textarea', 'email', 'phone', 'url']),
        placeholder: z.string().max(500).optional(),
        min_length: z.number().int().nonnegative().optional(),
        max_length: z.number().int().nonnegative().optional()
    })
    .strict();

const numberFieldSchema = z
    .object({
        ...commonFieldShape,
        type: z.literal('number'),
        placeholder: z.string().max(500).optional(),
        min: z.number().finite().optional(),
        max: z.number().finite().optional(),
        step: z.number().positive().finite().optional()
    })
    .strict();

const dateFieldSchema = z
    .object({
        ...commonFieldShape,
        type: z.literal('date'),
        min: calendarDateSchema().optional(),
        max: calendarDateSchema().optional()
    })
    .strict();

const selectFieldSchema = z
    .object({
        ...commonFieldShape,
        type: z.literal('select'),
        options: z.array(z.string().trim().min(1).max(255)).min(1).max(100),
        enable_other: z.boolean().default(false)
    })
    .strict();

const radioFieldSchema = z
    .object({
        ...commonFieldShape,
        type: z.literal('radio'),
        options: z
            .array(
                z.union([
                    z.string().trim().min(1).max(255),
                    z.object({ title: z.string().trim().min(1).max(255), value: z.string().trim().min(1).max(255).optional() }).strict()
                ])
            )
            .min(1)
            .max(100)
    })
    .strict();

const checkboxFieldSchema = z
    .object({
        ...commonFieldShape,
        type: z.literal('checkbox')
    })
    .strict();

const contactPartSchema = z.enum(['display_name', 'first_name', 'last_name', 'company', 'birthdate', 'phone_cell', 'email', 'address', 'zip']);

const contactFieldSchema = z
    .object({
        ...commonFieldIdentityShape,
        type: z.literal('contact'),
        fields: z.array(contactPartSchema).min(1).max(9)
    })
    .strict();

const basicFieldSchema = z.discriminatedUnion('type', [
    textFieldSchema,
    numberFieldSchema,
    dateFieldSchema,
    selectFieldSchema,
    radioFieldSchema,
    checkboxFieldSchema,
    contactFieldSchema
]);

const createBasicFormInputSchema = z
    .object({
        name: z.string().trim().min(1).max(255),
        slug: z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^[a-z0-9][a-z0-9-]*$/)
            .max(255)
            .refine(slug => slug.length !== 36, 'cannot be exactly 36 characters long')
            .optional(),
        title: z.string().trim().min(1).max(500).optional(),
        submit_label: z.string().trim().min(1).max(255).default('Submit'),
        success_message: z.string().trim().min(1).max(5000).default('Thank you. Your response has been submitted.'),
        notification_emails: z.array(z.string().trim().email()).max(100).default([]),
        origins: z.array(z.string().trim().min(1)).max(100).default([]),
        origin_sites: z.array(z.string().trim().min(1)).max(100).default([]),
        fields: z.array(basicFieldSchema).min(1).max(100)
    })
    .strict()
    .superRefine((value, context) => {
        const keys = new Set<string>();
        let contacts = 0;
        for (const [index, field] of value.fields.entries()) {
            if (keys.has(field.key)) context.addIssue({ code: 'custom', path: ['fields', index, 'key'], message: `duplicate key "${field.key}"` });
            keys.add(field.key);
            if (field.type === 'contact' && ++contacts > 1) {
                context.addIssue({ code: 'custom', path: ['fields', index], message: 'only one contact field is supported' });
            }
            if ('min_length' in field && field.min_length !== undefined && field.max_length !== undefined && field.min_length > field.max_length) {
                context.addIssue({ code: 'custom', path: ['fields', index], message: 'min_length cannot exceed max_length' });
            }
            if ('min' in field && field.min !== undefined && field.max !== undefined && field.min > field.max) {
                context.addIssue({ code: 'custom', path: ['fields', index], message: 'min cannot exceed max' });
            }
            if (field.type === 'select' && new Set(field.options).size !== field.options.length) {
                context.addIssue({ code: 'custom', path: ['fields', index, 'options'], message: 'options must be unique' });
            }
            if (field.type === 'radio') {
                const values = field.options.map(option => (typeof option === 'string' ? option : (option.value ?? option.title)));
                if (new Set(values).size !== values.length) {
                    context.addIssue({ code: 'custom', path: ['fields', index, 'options'], message: 'option values must be unique' });
                }
            }
            if (field.type === 'contact' && new Set(field.fields).size !== field.fields.length) {
                context.addIssue({ code: 'custom', path: ['fields', index, 'fields'], message: 'contact fields must be unique' });
            }
            if (field.type === 'contact' && field.fields.includes('address') && field.fields.includes('zip')) {
                context.addIssue({ code: 'custom', path: ['fields', index, 'fields'], message: 'address already includes ZIP; omit zip' });
            }
        }
    });

const updateOriginsInputSchema = z
    .object({
        form: z.string().trim().min(1).describe('Form UUID or slug'),
        add_origins: z.array(z.string().trim().min(1)).max(100).default([]),
        remove_origins: z.array(z.string().trim().min(1)).max(100).default([]),
        add_sites: z.array(z.string().trim().min(1)).max(100).default([]),
        remove_sites: z.array(z.string().trim().min(1)).max(100).default([])
    })
    .strict()
    .refine(value => value.add_origins.length + value.remove_origins.length + value.add_sites.length + value.remove_sites.length > 0, {
        message: 'provide at least one origin or site to add or remove'
    });

type BasicFieldInput = z.infer<typeof basicFieldSchema>;
type CreateBasicFormInput = z.infer<typeof createBasicFormInputSchema>;

export function registerFormsMcp(server: McpServer, forms: FormsClient, manager: ManagerClient, suiteApiUrl: string | undefined): void {
    server.registerResource(
        'zynoforms_embedding_guide',
        EMBEDDING_GUIDE_URI,
        {
            title: 'Embedding ZynoForms',
            description: 'How to link, iframe, and submit published ZynoForms from a website.',
            mimeType: 'text/markdown'
        },
        async () => ({
            contents: [{ uri: EMBEDDING_GUIDE_URI, mimeType: 'text/markdown', text: EMBEDDING_GUIDE }]
        })
    );

    server.registerTool(
        'list_forms',
        {
            title: 'List published ZynoForms',
            description: 'List the tenant’s forms with direct links and ready-to-use iframe snippets.',
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async () => {
            const listed = await forms.listForms();
            return result({ forms: listed.map(form => decorateFormSummary(form)) });
        }
    );

    server.registerTool(
        'get_form_integration',
        {
            title: 'Get ZynoForm integration details',
            description: 'Get live field aliases, public endpoints, an iframe, and JSON, URL-encoded, multipart, and HTML examples.',
            inputSchema: { form: z.string().trim().min(1).describe('Form UUID or slug') },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ form }) => {
            const detailed = await getFormByReference(forms, form);
            return result(buildFormIntegration(detailed, requireSuiteApiUrl(suiteApiUrl)));
        }
    );

    server.registerTool(
        'create_basic_form',
        {
            title: 'Create a basic published ZynoForm',
            description:
                'Create and immediately publish a one-page form with text, textarea, email, phone, URL, number, date, select, radio, checkbox, or contact fields. Fields submit by stable key aliases; required defaults to true. Exact origins or ZynoHosting site references may be allowed for browser JavaScript.',
            inputSchema: createBasicFormInputSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        },
        async input => {
            const siteOrigins = await originsForSites(manager, input.origin_sites);
            const corsOrigins = unique([...input.origins.map(normalizeWebOrigin), ...siteOrigins]);
            const created = await forms.createForm({
                name: input.name,
                ...(input.slug === undefined ? {} : { slug: input.slug }),
                emailTo: input.notification_emails.length ? unique(input.notification_emails) : null,
                corsOrigins: corsOrigins.length ? corsOrigins : null,
                content: buildBasicFormDefinition(input)
            });
            return result(buildFormIntegration(created, requireSuiteApiUrl(suiteApiUrl)));
        }
    );

    server.registerTool(
        'update_form_origins',
        {
            title: 'Update ZynoForm CORS origins',
            description:
                'Idempotently add or remove exact HTTP(S) origins. Site references expand to the site’s primary, alias, and vanity HTTPS hostnames.',
            inputSchema: updateOriginsInputSchema,
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
        },
        async input => {
            const detailed = await getFormByReference(forms, input.form);
            const [addSiteOrigins, removeSiteOrigins] = await Promise.all([
                originsForSites(manager, input.add_sites),
                originsForSites(manager, input.remove_sites)
            ]);
            const additions = unique([...input.add_origins.map(normalizeWebOrigin), ...addSiteOrigins]);
            const removals = unique([...input.remove_origins.map(normalizeWebOrigin), ...removeSiteOrigins]);
            const overlap = additions.filter(origin => removals.includes(origin));
            if (overlap.length) {
                throw new CliError(`Origins cannot be added and removed in the same request: ${overlap.join(', ')}`, 2, 'conflicting_origins');
            }

            const before = detailed.corsOrigins ?? [];
            const removeSet = new Set(removals);
            const after = before.filter(origin => !removeSet.has(canonicalStoredOrigin(origin)));
            for (const origin of additions) {
                if (!after.some(existing => canonicalStoredOrigin(existing) === origin)) after.push(origin);
            }
            const updated = arraysEqual(before, after) ? detailed : await forms.updateForm(detailed.id, { corsOrigins: after.length ? after : null });
            return result({
                form: decorateFormSummary(updated),
                before,
                corsOrigins: updated.corsOrigins ?? [],
                added: additions.filter(origin => !before.some(existing => canonicalStoredOrigin(existing) === origin)),
                removed: before.filter(origin => removeSet.has(canonicalStoredOrigin(origin)))
            });
        }
    );
}

export function buildBasicFormDefinition(input: CreateBasicFormInput): FormDefinitionContent {
    const fields = input.fields.map(buildBasicField);
    return {
        fieldIdsByAlias: Object.fromEntries(fields.map(field => [field.alias!, field.id])),
        header: { title: input.title ?? input.name },
        submit: { title: input.submit_label, successMessage: input.success_message },
        pages: [{ fields }]
    };
}

export function normalizeWebOrigin(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new CliError(`Invalid web origin: ${value}`, 2, 'invalid_origin');
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new CliError(`Origin must contain only an HTTP(S) scheme and host: ${value}`, 2, 'invalid_origin');
    }
    return url.origin;
}

export function buildFormIntegration(form: DetailedForm, suiteApiUrl: string): Record<string, unknown> {
    const definition = form.activeDefinition;
    if (!definition) throw new CliError('The form has no live definition', 5, 'missing_active_definition');
    if (definition.isDraft) throw new CliError('ZynoSuite marked the active form definition as a draft', 5, 'invalid_suite_response');
    if (definition.id !== form.activeDefinitionId) {
        throw new CliError('ZynoSuite returned an active form definition with an unexpected ID', 5, 'invalid_suite_response');
    }
    const endpoints = publicEndpoints(form.publicUrl, suiteApiUrl, definition.id, form.id, form.name);
    const contract = fieldContract(definition.content);
    const responseExample = Object.fromEntries(
        contract.fields.map(field => [field.key, field.repeated ? [exampleValue(field.field)] : exampleValue(field.field)])
    );
    const flatExample = flattenResponsesForForm(responseExample);
    const warnings = form.hasDraft ? ['This form has an unpublished draft. Integration details describe the current live definition.'] : [];
    const unsafeAliases = contract.fields.map(field => field.alias).filter((alias): alias is string => !!alias && UNSAFE_FORM_KEYS.has(alias));
    if (unsafeAliases.length) {
        warnings.push(
            `The aliases ${unsafeAliases.join(', ')} are reserved by bracket-notation parsers; generated submission examples use field UUID keys for those fields.`
        );
    }

    return {
        form: decorateFormSummary(form),
        liveDefinition: {
            id: definition.id,
            version: definition.version,
            revision: definition.revision,
            published: !definition.isDraft
        },
        endpoints,
        submission: {
            public: true,
            credentialsRequired: false,
            maxBodyBytes: FORM_SUBMISSION_MAX_BODY_BYTES,
            recommendedContentType: 'application/json',
            openApiContentTypes: ['application/json'],
            acceptedContentTypes: ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data'],
            fieldsByAlias: Object.fromEntries(contract.fields.filter(field => field.alias).map(field => [field.alias!, field.details])),
            fieldsWithoutAlias: contract.fields.filter(field => !field.alias).map(field => field.details),
            examples: {
                json: { responses: responseExample },
                urlencodedFields: Object.fromEntries(flatExample),
                multipartTextFields: Object.fromEntries(flatExample),
                html: htmlFormExample(endpoints.submission, contract.fields)
            }
        },
        warnings
    };
}

async function getFormByReference(forms: FormsClient, reference: string): Promise<DetailedForm> {
    if (UUID_PATTERN.test(reference)) return forms.getForm(reference);
    const matches = (await forms.listForms()).filter(form => form.slug === reference);
    if (!matches.length) throw new CliError(`No form has the slug "${reference}"`, 4, 'form_not_found');
    if (matches.length > 1) throw new CliError(`More than one form has the slug "${reference}"; use its UUID`, 5, 'ambiguous_form');
    return forms.getForm(matches[0]!.id);
}

function buildBasicField(field: BasicFieldInput): FormField {
    const common = {
        id: randomUUID(),
        alias: field.key,
        ...(!field.required ? { optional: true } : {})
    };
    switch (field.type) {
        case 'text':
        case 'textarea':
        case 'email':
        case 'phone':
        case 'url':
            return {
                ...common,
                type: 'text',
                label: field.label,
                ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
                ...(field.type === 'textarea' ? { format: 'large' } : {}),
                ...(['email', 'phone', 'url'].includes(field.type) ? { inputType: field.type === 'phone' ? 'tel' : field.type } : {}),
                ...(field.min_length === undefined ? {} : { minLength: field.min_length }),
                ...(field.max_length === undefined ? {} : { maxLength: field.max_length })
            };
        case 'number':
            return {
                ...common,
                type: 'number',
                label: field.label,
                ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
                ...(field.min === undefined ? {} : { min: field.min }),
                ...(field.max === undefined ? {} : { max: field.max }),
                ...(field.step === undefined ? {} : { step: field.step })
            };
        case 'date':
            return {
                ...common,
                type: 'date',
                label: field.label,
                ...(field.min === undefined ? {} : { min: field.min }),
                ...(field.max === undefined ? {} : { max: field.max })
            };
        case 'select':
            return {
                ...common,
                type: 'select',
                label: field.label,
                options: field.options,
                ...(field.enable_other ? { enableOther: true } : {})
            };
        case 'radio':
            return {
                ...common,
                type: 'radio',
                label: field.label,
                options: field.options.map(option => (typeof option === 'string' ? { title: option } : option))
            };
        case 'checkbox':
            return { ...common, type: 'checkbox', label: field.label };
        case 'contact':
            return {
                ...common,
                type: 'contact',
                fields: Object.fromEntries(field.fields.map(part => [contactPartName(part), true]))
            };
    }
}

function contactPartName(part: z.infer<typeof contactPartSchema>): string {
    const names: Record<z.infer<typeof contactPartSchema>, string> = {
        display_name: 'displayName',
        first_name: 'firstName',
        last_name: 'lastName',
        company: 'company',
        birthdate: 'birthdate',
        phone_cell: 'phoneCell',
        email: 'email',
        address: 'address',
        zip: 'zip'
    };
    return names[part];
}

async function originsForSites(manager: ManagerClient, siteRefs: string[]): Promise<string[]> {
    const sites = await Promise.all(unique(siteRefs).map(site => manager.getSite(site)));
    return unique(
        sites
            .flatMap(site => [site.fqdn, ...(site.hostnames ?? []).map(hostname => hostname.name)])
            .map(hostname => normalizeWebOrigin(`https://${hostname}`))
    );
}

function decorateFormSummary(form: FormSummary): Record<string, unknown> {
    return {
        id: form.id,
        name: form.name,
        slug: form.slug,
        emailTo: form.emailTo,
        corsOrigins: form.corsOrigins,
        activeDefinitionId: form.activeDefinitionId,
        createdAt: form.createdAt,
        updatedAt: form.updatedAt,
        publicUrl: form.publicUrl,
        hasDraft: form.hasDraft,
        submissionCount: form.submissionCount,
        directUrl: form.publicUrl,
        iframe: `<iframe src="${escapeHtml(form.publicUrl)}" title="${escapeHtml(form.name)}" style="width:100%;min-height:720px;border:0" loading="lazy"></iframe>`
    };
}

function publicEndpoints(publicUrl: string, suiteApiUrl: string, definitionId: string, formId: string, formName: string) {
    const url = new URL(publicUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    const formMarker = segments.lastIndexOf('f');
    if (formMarker < 0 || segments.length !== formMarker + 3) {
        throw new CliError('ZynoSuite returned a public form URL with an unexpected path', 5, 'invalid_suite_response');
    }
    let tenant: string;
    try {
        tenant = decodeURIComponent(segments[formMarker + 1]!);
        decodeURIComponent(segments[formMarker + 2]!);
    } catch {
        throw new CliError('ZynoSuite returned a public form URL with invalid path encoding', 5, 'invalid_suite_response');
    }
    const publicDefinition = `${suiteApiUrl}/public/forms/${encodeURIComponent(tenant)}/${encodeURIComponent(formId)}`;
    return {
        direct: publicUrl,
        iframe: `<iframe src="${escapeHtml(publicUrl)}" title="${escapeHtml(formName)}" style="width:100%;min-height:720px;border:0" loading="lazy"></iframe>`,
        definition: `${publicDefinition}?definitionId=${encodeURIComponent(definitionId)}`,
        currentDefinition: publicDefinition,
        submission: `${publicDefinition}/${encodeURIComponent(definitionId)}/submissions`
    };
}

interface ContractField {
    key: string;
    alias?: string;
    field: FormField;
    repeated: boolean;
    details: Record<string, unknown>;
}

function fieldContract(content: FormDefinitionContent): { fields: ContractField[] } {
    const aliases = content.fieldIdsByAlias ?? {};
    const aliasById = new Map(Object.entries(aliases).map(([alias, id]) => [id, alias]));
    const result: ContractField[] = [];
    const visit = (fields: FormField[], repeat?: unknown) => {
        for (const field of fields) {
            if (field.type === 'display' || field.type === 'review') continue;
            if (field.type === 'section' && Array.isArray(field.fields)) {
                visit(field.fields.filter(isFormField), field.repeat);
                continue;
            }
            const candidateAlias = field.alias ?? aliasById.get(field.id);
            const alias = candidateAlias ? candidateAlias : undefined;
            const key = alias && !UNSAFE_FORM_KEYS.has(alias) ? alias : field.id;
            const contactFields = isRecord(field.fields) ? field.fields : undefined;
            const details: Record<string, unknown> = {
                fieldId: field.id,
                submissionKey: key,
                type: field.type,
                required: !['marketingOptOut', 'emailCopy'].includes(field.type) && field.optional !== true,
                ...(repeat === undefined ? {} : { repeated: true, repeat }),
                ...(field.label ? { label: field.label } : {}),
                ...(field.options !== undefined ? { options: field.options } : {}),
                ...(field.type === 'contact' && contactFields ? { contactFields: contactResponseParts(contactFields) } : {})
            };
            for (const property of [
                'inputType',
                'format',
                'placeholder',
                'min',
                'max',
                'step',
                'minLength',
                'maxLength',
                'pattern',
                'patternMessage',
                'enableOther',
                'inverted',
                'preamble',
                'condition'
            ]) {
                if (field[property] !== undefined) details[property] = field[property];
            }
            result.push({ key, ...(alias ? { alias } : {}), field, repeated: repeat !== undefined, details });
        }
    };
    for (const page of content.pages) visit(page.fields);
    return { fields: result };
}

function exampleValue(field: FormField): unknown {
    switch (field.type) {
        case 'checkbox':
        case 'marketingOptOut':
        case 'emailCopy':
            return true;
        case 'number':
            if (typeof field.min === 'number') return field.min;
            if (typeof field.max === 'number' && field.max < 0) {
                const step = typeof field.step === 'number' && field.step > 0 ? field.step : 1;
                return Math.floor(field.max / step) * step;
            }
            return 0;
        case 'date':
            return typeof field.min === 'string' ? field.min : typeof field.max === 'string' ? field.max : '2026-01-01';
        case 'select':
            return Array.isArray(field.options) && typeof field.options[0] === 'string' ? field.options[0] : 'option';
        case 'radio': {
            const option = Array.isArray(field.options) ? field.options[0] : undefined;
            if (typeof option === 'string') return option;
            if (isRecord(option)) return typeof option.value === 'string' ? option.value : typeof option.title === 'string' ? option.title : 'option';
            return 'option';
        }
        case 'contact':
            return contactExample(field.fields);
        case 'signature':
            return 'name:Alex Example';
        default:
            return textExample(field);
    }
}

function contactExample(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) return {};
    const examples: Record<string, unknown> = {
        displayName: 'Alex Example',
        firstName: 'Alex',
        lastName: 'Example',
        company: 'Example Co',
        birthdate: contactBirthdateExample(value.birthdate),
        phoneCell: '+15555550100',
        email: 'alex@example.com',
        street1: '123 Main St',
        street2: 'Suite 100',
        city: 'Example',
        state: 'NY',
        zip: '10001',
        country: 'US'
    };
    return Object.fromEntries(contactResponseParts(value).map(key => [key, examples[key] ?? 'example']));
}

function textExample(field: FormField): string {
    const minLength = typeof field.minLength === 'number' ? field.minLength : 0;
    const maxLength = typeof field.maxLength === 'number' ? field.maxLength : Number.POSITIVE_INFINITY;
    if (field.inputType === 'email') {
        const base = 'person@example.com';
        if (minLength <= base.length && base.length <= maxLength) return base;
        const suffix = maxLength < base.length ? '@b.c' : '@example.com';
        const targetLength = Math.max(minLength, suffix.length + 1);
        return targetLength <= maxLength ? `${'a'.repeat(targetLength - suffix.length)}${suffix}` : '';
    }
    if (field.inputType === 'url') {
        const base = 'https://example.com';
        if (minLength <= base.length && base.length <= maxLength) return base;
        const short = 'http://a';
        const targetLength = Math.max(minLength, short.length);
        if (targetLength > maxLength) return '';
        return targetLength === short.length ? short : `${short}/${'x'.repeat(targetLength - short.length - 1)}`;
    }
    if (field.inputType === 'tel') {
        const base = '+15555550100';
        const targetLength = Math.max(minLength, Math.min(base.length, maxLength));
        return `${base}${'0'.repeat(Math.max(0, targetLength - base.length))}`.slice(0, targetLength);
    }
    const base = 'example response';
    const length = Math.max(base.length, minLength);
    const finiteMaximum = Number.isFinite(maxLength) ? maxLength : length;
    if (finiteMaximum <= 0) return '';
    return `${base}${'x'.repeat(Math.max(0, length - base.length))}`.slice(0, finiteMaximum);
}

function contactBirthdateExample(value: unknown): string {
    const limits = isRecord(value) ? value : {};
    const minAge = typeof limits.minAge === 'number' ? limits.minAge : undefined;
    const maxAge = typeof limits.maxAge === 'number' ? limits.maxAge : undefined;
    const age = minAge ?? Math.min(maxAge ?? 30, 30);
    const year = new Date().getUTCFullYear() - age;
    return year >= 0 && year <= 9999 ? `${String(year).padStart(4, '0')}-01-01` : '1970-01-01';
}

function flattenResponsesForForm(responses: Record<string, unknown>): Array<[string, string]> {
    const result: Array<[string, string]> = [];
    const visit = (path: string, value: unknown) => {
        if (Array.isArray(value)) {
            value.forEach((item, index) => visit(`${path}[${index}]`, item));
        } else if (isRecord(value)) {
            for (const [key, child] of Object.entries(value)) visit(`${path}[${key}]`, child);
        } else {
            result.push([path, String(value)]);
        }
    };
    for (const [key, value] of Object.entries(responses)) visit(`responses[${key}]`, value);
    return result;
}

function htmlFormExample(submissionUrl: string, fields: ContractField[]): string {
    const controls = fields.flatMap(({ key, field, repeated }) => htmlControls(key, field, repeated));
    return [
        `<form method="post" action="${escapeHtml(submissionUrl)}" enctype="application/x-www-form-urlencoded">`,
        ...controls.map(control => `  ${control}`),
        '  <button type="submit">Submit</button>',
        '</form>'
    ].join('\n');
}

function htmlControls(key: string, field: FormField, repeated: boolean): string[] {
    const name = `responses[${key}]${repeated ? '[0]' : ''}`;
    const label = field.label ?? key;
    const required = field.optional === true || field.type === 'marketingOptOut' || field.type === 'emailCopy' ? '' : ' required';
    if (field.type === 'contact' && isRecord(field.fields)) {
        return contactResponseParts(field.fields).map(
            part =>
                `<label>${escapeHtml(humanize(part))} <input name="${escapeHtml(`${name}[${part}]`)}"${contactInputType(part)}${required}></label>`
        );
    }
    if (field.type === 'select' && Array.isArray(field.options)) {
        return [
            `<label>${escapeHtml(label)} <select name="${escapeHtml(name)}"${required}>${field.options
                .filter((option): option is string => typeof option === 'string')
                .map(option => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`)
                .join('')}</select></label>`
        ];
    }
    if (field.type === 'radio' && Array.isArray(field.options)) {
        return field.options.map(option => {
            const title = typeof option === 'string' ? option : isRecord(option) && typeof option.title === 'string' ? option.title : 'Option';
            const value = isRecord(option) && typeof option.value === 'string' ? option.value : title;
            return `<label><input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${required}> ${escapeHtml(title)}</label>`;
        });
    }
    if (field.type === 'checkbox' || field.type === 'marketingOptOut' || field.type === 'emailCopy') {
        return [`<label><input type="checkbox" name="${escapeHtml(name)}" value="true"${required}> ${escapeHtml(label)}</label>`];
    }
    if (field.type === 'signature') {
        return [
            `<label>${escapeHtml(label)} <input type="text" name="${escapeHtml(name)}" value="name:Alex Example" pattern="name:.+"${required}></label>`
        ];
    }
    if (field.type === 'text' && field.format === 'large') {
        return [`<label>${escapeHtml(label)} <textarea name="${escapeHtml(name)}"${controlAttributes(field)}${required}></textarea></label>`];
    }
    const type =
        field.type === 'number' || field.type === 'date'
            ? field.type
            : field.type === 'text' && typeof field.inputType === 'string'
              ? field.inputType
              : 'text';
    return [
        `<label>${escapeHtml(label)} <input type="${escapeHtml(type)}" name="${escapeHtml(name)}"${controlAttributes(field)}${required}></label>`
    ];
}

function controlAttributes(field: FormField): string {
    const attributes: Array<[string, unknown]> = [
        ['placeholder', field.placeholder],
        ['min', field.min],
        ['max', field.max],
        ['step', field.step],
        ['minlength', field.minLength],
        ['maxlength', field.maxLength],
        ['pattern', field.pattern]
    ];
    return attributes
        .filter((entry): entry is [string, string | number] => typeof entry[1] === 'string' || typeof entry[1] === 'number')
        .map(([name, value]) => ` ${name}="${escapeHtml(String(value))}"`)
        .join('');
}

function contactResponseParts(fields: Record<string, unknown>): string[] {
    const parts = ['displayName', 'firstName', 'lastName', 'company', 'birthdate', 'phoneCell', 'email'].filter(part => !!fields[part]);
    if (fields.address) parts.push('street1', 'zip', 'city', 'state');
    else if (fields.zip) parts.push('zip');
    return parts;
}

function contactInputType(part: string): string {
    if (part === 'email') return ' type="email"';
    if (part.startsWith('phone')) return ' type="tel"';
    if (part === 'birthdate') return ' type="date"';
    return '';
}

function canonicalStoredOrigin(origin: string): string {
    try {
        return normalizeWebOrigin(origin);
    } catch {
        return origin;
    }
}

function requireSuiteApiUrl(value: string | undefined): string {
    if (value) return value;
    throw new CliError(
        'The ZynoSuite API URL is not configured for this Hosting API. Pass --suite-api-url or set ZYNO_SUITE_API_URL.',
        2,
        'missing_suite_api_url'
    );
}

function isFormField(value: unknown): value is FormField {
    return isRecord(value) && typeof value.id === 'string' && typeof value.type === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function unique<T>(values: T[]): T[] {
    return [...new Set(values)];
}

function arraysEqual(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function humanize(value: string): string {
    return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, first => first.toUpperCase());
}

function calendarDateSchema() {
    return z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'must use YYYY-MM-DD')
        .refine(value => {
            const date = new Date(`${value}T00:00:00Z`);
            return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
        }, 'must be a real calendar date');
}

function escapeHtml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function result(value: unknown) {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
        structuredContent: isRecord(value) ? value : { value }
    };
}

export const EMBEDDING_GUIDE = `# Embedding ZynoForms

Use \`list_forms\` to discover published forms and \`get_form_integration\` to retrieve the live definition, exact endpoints, field aliases, and generated examples.

## Creating a basic form

\`create_basic_form\` creates and immediately publishes a one-page form. Each field has a unique \`key\`, which becomes its stable submission alias, and \`required\` defaults to true. The creator supports text, textarea, email, phone, URL, number, date, select, radio, checkbox, and one contact field. Contact details label themselves and are selected with \`fields\`, such as \`["first_name", "last_name", "email", "phone_cell", "address"]\`. Use \`zip\` for ZIP-only collection; \`address\` already includes street, ZIP, city, and state.

Set explicit \`origins\`, or use \`origin_sites\` to allow HTTPS origins for a ZynoHosting site's primary, alias, and vanity hostnames. The result includes the published form's complete integration details.

## Direct link or iframe

The form's \`publicUrl\` is a customer-facing rendered form. Link to it directly or use the iframe returned by the tools. An iframe does not require custom JavaScript; adjust its minimum height to suit the page and form.

## Custom HTML or JavaScript

Submit to the live definition's public submission endpoint. Public definition and submission requests require no credentials. JSON is the recommended and OpenAPI-advertised format:

\`\`\`json
{ "responses": { "email": "person@example.com" } }
\`\`\`

The runtime also accepts \`application/x-www-form-urlencoded\` and multipart text fields using bracket notation:

\`\`\`text
responses[email]=person@example.com
responses[contact][firstName]=Alex
responses[contact][lastName]=Example
\`\`\`

Use field aliases as response keys. Field UUIDs remain supported as a fallback. Brackets create nested objects; numeric brackets and empty brackets create arrays. File uploads are not supported by the basic-form integration.

The generated native HTML form posts without JavaScript, then navigates to the API's JSON success response. To show an in-page confirmation instead, intercept submission with JavaScript and allow the page's exact origin before using cross-origin \`fetch\`.

The rendered ZynoForm and generated HTML enforce required fields in the browser. A custom JavaScript client should enforce the returned \`required\` contract before submission; the public API cannot generally enforce requiredness because advanced forms may conditionally hide fields.

## CORS origins

Browser JavaScript that fetches a definition or submits cross-origin must use an allowed exact origin. Use \`update_form_origins\` with explicit HTTP(S) origins, or add a ZynoHosting site to allow HTTPS from its primary, alias, and vanity hostnames. Origins contain only scheme, host, and optional port—never a path.

## Versioning and limits

API endpoints use the stable form UUID and submission URLs include the active definition ID. After publishing a different definition, call \`get_form_integration\` again and update custom integrations. A saved draft does not change the live endpoint. Request bodies are limited to 5 MiB. The public parser rejects unsafe object keys such as \`__proto__\`.
`;
