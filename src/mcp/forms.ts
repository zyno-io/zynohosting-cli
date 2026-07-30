import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
    DetailedForm,
    FormDefinition,
    FormDefinitionContent,
    FormField,
    FormsClient,
    FormSummary,
    PublicBotProtection,
    UpdateFormRequest
} from '../api/forms-client.js';
import { ManagerClient } from '../api/manager-client.js';
import { CliError } from '../errors.js';
import { applyFormEdits, describeFormContent, FormEditResult, formOperationSchema, isFieldRequired, walkFields } from './forms-edit.js';
import { basicFieldSchema, buildBasicField, describeBasicField, refineBasicField, UNSAFE_FORM_KEYS } from './forms-fields.js';

export { buildBasicField, describeBasicField } from './forms-fields.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORM_SUBMISSION_MAX_BODY_BYTES = 5 * 1024 * 1024;
const EMBEDDING_GUIDE_URI = 'zynoforms://guides/embedding';
/** The id the generated markup carries so the generated script can find the form it belongs to. */
const FORM_ELEMENT_ID = 'zyno-form';
/** Where the generated script reports verification and submission outcomes to the visitor. */
const STATUS_ELEMENT_ID = 'zyno-status';

const slugSchema = z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .max(255)
    .refine(slug => slug.length !== 36, 'cannot be exactly 36 characters long');

const createBasicFormInputSchema = z
    .object({
        name: z.string().trim().min(1).max(255),
        slug: slugSchema.optional(),
        title: z.string().trim().min(1).max(500).optional(),
        submit_label: z.string().trim().min(1).max(255).default('Submit'),
        success_message: z.string().trim().min(1).max(5000).default('Thank you. Your response has been submitted.'),
        notification_emails: z.array(z.string().trim().email()).max(100).default([]),
        origins: z.array(z.string().trim().min(1)).max(100).default([]),
        origin_sites: z.array(z.string().trim().min(1)).max(100).default([]),
        bot_protection: z
            .enum(['interactive', 'invisible', 'disabled'])
            .default('interactive')
            .describe('Cap.js protection for public submissions; disabled preserves legacy integrations without a token'),
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
            refineBasicField(field, context, ['fields', index]);
        }
    });

const describeFormInputSchema = {
    form: z.string().trim().min(1).describe('Form UUID or slug'),
    include_draft: z.boolean().default(true).describe('Also describe the unpublished draft, when there is one')
};

const updateFormInputSchema = z
    .object({
        form: z.string().trim().min(1).describe('Form UUID or slug'),
        name: z.string().trim().min(1).max(255).optional(),
        slug: slugSchema.nullable().optional().describe('The public link name; null removes it'),
        title: z.string().trim().min(1).max(500).optional().describe('The heading shown above the form'),
        submit_label: z.string().trim().min(1).max(255).optional(),
        success_message: z.string().trim().min(1).max(5000).optional(),
        notification_emails: z.array(z.string().trim().email()).max(100).optional().describe('Replaces the current list; an empty array clears it'),
        operations: z.array(formOperationSchema).max(100).optional().describe('Field edits, applied in order'),
        publish: z.boolean().default(true).describe('Publish the result; false saves an unpublished draft instead'),
        expected_definition_id: z
            .string()
            .uuid()
            .optional()
            .describe('The live definition this edit was computed against; the edit is refused if it is no longer live'),
        on_existing_draft: z
            .enum(['fail', 'extend'])
            .default('fail')
            .describe('What to do when the form already has an unpublished draft: refuse, or edit that draft')
    })
    .strict()
    .superRefine((value, context) => {
        const metadata = [value.name, value.slug, value.title, value.submit_label, value.success_message, value.notification_emails];
        if (metadata.every(field => field === undefined) && !value.operations?.length) {
            context.addIssue({ code: 'custom', path: [], message: 'provide at least one change or field operation' });
        }
        for (const [index, operation] of (value.operations ?? []).entries()) {
            if (operation.op === 'add_field') refineBasicField(operation.field, context, ['operations', index, 'field']);
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

const updateBotProtectionInputSchema = z.object({
    form: z.string().trim().min(1).describe('Form UUID or slug'),
    bot_protection: z
        .enum(['interactive', 'invisible', 'disabled'])
        .describe(
            'interactive renders a Cap widget, invisible solves it programmatically after local validation, and disabled accepts legacy submissions'
        )
});

type CreateBasicFormInput = z.infer<typeof createBasicFormInputSchema>;
type UpdateFormInput = z.infer<typeof updateFormInputSchema>;

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
                'Create and immediately publish a one-page form with text, textarea, email, phone, URL, hidden, number, date, select, radio, checkbox, or contact fields. Fields submit by stable key aliases; required defaults to true except for hidden URL-parameter fields. Exact origins or ZynoHosting site references may be allowed for browser JavaScript.',
            inputSchema: createBasicFormInputSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        },
        async input => {
            const siteOrigins = await originsForSites(manager, input.origin_sites);
            const corsOrigins = unique([...input.origins.map(normalizeWebOrigin), ...siteOrigins]);
            const requestedBotProtection = botProtectionMode(input.bot_protection);
            const created = await forms.createForm({
                name: input.name,
                ...(input.slug === undefined ? {} : { slug: input.slug }),
                emailTo: input.notification_emails.length ? unique(input.notification_emails) : null,
                corsOrigins: corsOrigins.length ? corsOrigins : null,
                botProtectionMode: requestedBotProtection,
                content: buildBasicFormDefinition(input)
            });
            // Older Suite deployments accept unknown form properties but silently drop them. Creation cannot
            // be rolled back here, so make that outcome explicit rather than claiming an unprotected form has
            // the interactive default this tool requested.
            if (created.botProtectionMode !== requestedBotProtection) {
                throw new CliError(
                    `The form ${created.id} was created, but ZynoSuite did not apply bot protection; it reports ${botProtectionModeName(created.botProtectionMode)} after being asked for ${input.bot_protection}. It is likely running a build without Cap support.`,
                    5,
                    'bot_protection_unsupported'
                );
            }
            return result(buildFormIntegration(created, requireSuiteApiUrl(suiteApiUrl)));
        }
    );

    server.registerTool(
        'describe_form',
        {
            title: 'Describe a ZynoForm’s structure',
            description:
                'Describe a form the way it is authored: its fields in order with their keys, types, labels, and constraints, which of them this tool can edit, and what advanced content — sections, conditions, themes, translations — it preserves but cannot change. Read this before update_form.',
            inputSchema: describeFormInputSchema,
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ form, include_draft }) => {
            const detailed = await getFormByReference(forms, form);
            const live = requireLiveDefinition(detailed);
            const structure = describeFormContent(live.content);
            const draft = include_draft ? detailed.draftDefinition : undefined;
            const warnings = [...structure.warnings];
            if (detailed.hasDraft) {
                warnings.push('This form has an unpublished draft, so the live structure below is not what the builder currently shows.');
            }

            return result({
                form: decorateFormSummary(detailed),
                notificationEmails: detailed.emailTo ?? [],
                botProtection: detailed.botProtection ?? null,
                live: definitionSummary(live),
                pages: structure.pages,
                advanced: structure.advanced,
                draft: draft ? { ...definitionSummary(draft), ...describeFormContent(draft.content) } : null,
                editable: !detailed.hasDraft,
                ...(detailed.hasDraft
                    ? {
                          blockedReason:
                              'An unpublished draft exists. Publish or discard it in the ZynoForms builder, or call update_form with on_existing_draft: "extend" to edit the draft itself.'
                      }
                    : {}),
                warnings
            });
        }
    );

    server.registerTool(
        'update_form',
        {
            title: 'Update a ZynoForm',
            description:
                'Change a form’s name, link, heading, submit label, success message, or notification emails, and add, update, move, or remove fields addressed by key. Untouched fields keep their identity, and content this vocabulary cannot express is preserved. Publishes a new version by default. Removing a field does not affect existing submissions, which are pinned to the version they were made against.',
            inputSchema: updateFormInputSchema,
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
        },
        async input => {
            const detailed = await getFormByReference(forms, input.form);
            requireExpectedDefinition(input.expected_definition_id, detailed);

            const base = resolveEditBase(detailed, input);
            const edit = base && applyFormEdits(base.content, contentEdits(input));
            const metadata = metadataChanges(detailed, input);
            const applied = { metadata: false, definition: 'unchanged' as 'unchanged' | 'draft' | 'published' };

            let form: DetailedForm = detailed;
            if (Object.keys(metadata).length) {
                form = await forms.updateForm(detailed.id, metadata);
                applied.metadata = true;
                try {
                    requireExpectedDefinition(input.expected_definition_id, form);
                } catch (error) {
                    throw withAppliedMetadataNote(error);
                }
            }

            // Skipping the save when the content is identical avoids a pointless version — but "publish this
            // draft" is a request in its own right, and an edit that the draft already reflects (a retry, or
            // a change someone else saved first) still has to reach the API or the form never goes live.
            const rewrites = !!edit && !!base && changesContent(base, edit);
            const publishesDraft = !!base?.isDraft && input.publish;
            if (edit && base && (rewrites || publishesDraft)) {
                try {
                    await forms.saveDefinition(detailed.id, {
                        content: edit.content,
                        publish: input.publish,
                        expectedRevision: base.isDraft ? base.revision : 0
                    });
                } catch (error) {
                    throw applied.metadata ? withAppliedMetadataNote(error) : error;
                }
                applied.definition = input.publish ? 'published' : 'draft';
                form = await describeAppliedWrites(applied, () => forms.getForm(detailed.id));
            }

            // Reading the result back can still fail. Everything above has already been written by then, so
            // the error has to say so rather than read as "the edit did not happen".
            const integration = await describeAppliedWrites(applied, () => buildFormIntegration(form, requireSuiteApiUrl(suiteApiUrl)));
            const warnings = [...(rewrites ? (edit?.warnings ?? []) : []), ...integration.warnings];
            if (applied.metadata && applied.definition === 'draft') {
                warnings.push(
                    'The name, link, and notification-email changes are live now — form metadata is not versioned, so publish: false held back only the field and wording changes.'
                );
            }
            // A custom submission template addresses fields by key, and it is inherited by the new version
            // untouched. The Suite cannot rewrite it, so a key that moved leaves that template addressing
            // something that no longer answers.
            if (base?.renderTemplate && rewrites) {
                const renamed = (edit?.changes ?? [])
                    .filter(change => change.change === 'updated_field' && change.properties?.includes('key'))
                    .map(change => change.key);
                const removed = (edit?.changes ?? []).flatMap(change =>
                    change.change === 'removed_field' ? (change.removedKeys ?? [change.key]) : []
                );
                renamed.push(...removed);
                const reshaped = (edit?.changes ?? []).some(change => change.responseShapeChanged === true);
                if (renamed.length || reshaped) {
                    warnings.push(
                        `This form has a custom submission template, which addresses fields by key${renamed.length ? ` — including ${renamed.join(', ')}` : ''}. Notification emails and PDFs will render those values empty until the template is updated in the ZynoForms builder.`
                    );
                }
            }
            return result({
                ...integration,
                applied,
                // Only what was actually written: an edit the base already reflected changed nothing, and
                // reporting it as a change would read as work this call performed.
                changes: rewrites ? (edit?.changes ?? []) : [],
                warnings
            });
        }
    );

    server.registerTool(
        'update_form_bot_protection',
        {
            title: 'Update ZynoForm bot protection',
            description:
                'Idempotently set Cap.js protection to an interactive widget, an invisible programmatic solve, or disabled for legacy submissions. A request that already matches skips the update call.',
            inputSchema: updateBotProtectionInputSchema,
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
        },
        async input => {
            const detailed = await getFormByReference(forms, input.form);
            const wanted = botProtectionMode(input.bot_protection);
            const updated = detailed.botProtectionMode === wanted ? detailed : await forms.updateForm(detailed.id, { botProtectionMode: wanted });
            // A Suite that predates Cap accepts the request and returns a form without the field, which the
            // client reads as disabled. Left unchecked this reports "changed to disabled" on every call and
            // never converges; say what actually happened instead.
            if (updated.botProtectionMode !== wanted) {
                throw new CliError(
                    `This ZynoSuite deployment did not apply bot protection; it reports ${botProtectionModeName(updated.botProtectionMode)} after being asked for ${input.bot_protection}. It is likely running a build without Cap support.`,
                    5,
                    'bot_protection_unsupported'
                );
            }
            const changed = detailed.botProtectionMode !== updated.botProtectionMode;
            const integration = await describeAppliedWrites({ metadata: changed, definition: 'unchanged' }, () =>
                buildFormIntegration(updated, requireSuiteApiUrl(suiteApiUrl))
            );
            // Named for the tri-state argument rather than the stored column, which the spread integration
            // already reports as `form.botProtectionMode` (null when off) and `botProtection` (the config).
            return result({
                ...integration,
                botProtectionChanged: changed,
                botProtectionSetting: botProtectionModeName(updated.botProtectionMode)
            });
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

/** The definition an edit starts from: the live version, or the shared draft when asked to extend it. */
function resolveEditBase(form: DetailedForm, input: UpdateFormInput): FormDefinition | undefined {
    const wanted = [input.title, input.submit_label, input.success_message].some(value => value !== undefined) || !!input.operations?.length;
    if (!wanted) return undefined;

    const draft = form.draftDefinition;
    if (draft !== undefined || form.hasDraft) {
        if (input.on_existing_draft === 'fail') {
            throw new CliError(
                'This form has an unpublished draft. Publish or discard it in the ZynoForms builder, or pass on_existing_draft: "extend" to edit that draft instead of the live version.',
                6,
                'form_has_draft'
            );
        }
        // `hasDraft` and the draft itself are two queries, so a draft discarded between them reads as
        // "there is one, here it isn't". Fall through to the live definition and quote revision 0: if a
        // draft really is there, the API rejects the stale write with its own message.
        if (draft) return draft;
    }
    return requireLiveDefinition(form);
}

function contentEdits(input: UpdateFormInput) {
    return {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.submit_label === undefined ? {} : { submitLabel: input.submit_label }),
        ...(input.success_message === undefined ? {} : { successMessage: input.success_message }),
        ...(input.operations === undefined ? {} : { operations: input.operations })
    };
}

/** Only the metadata that actually differs, so an unchanged value never mints an audit entry. */
function metadataChanges(form: DetailedForm, input: UpdateFormInput): UpdateFormRequest {
    const changes: UpdateFormRequest = {};
    if (input.name !== undefined && input.name !== form.name) changes.name = input.name;
    if (input.slug !== undefined && (input.slug ?? null) !== form.slug) changes.slug = input.slug;
    if (input.notification_emails !== undefined) {
        const emails = unique(input.notification_emails);
        if (!arraysEqual(emails, form.emailTo ?? [])) changes.emailTo = emails.length ? emails : null;
    }
    return changes;
}

/**
 * Whether the edit is worth a new version. The baseline runs through the same edit pass with nothing to
 * do, so a definition stored before `fieldIdsByAlias` existed is not mistaken for a change.
 */
function changesContent(base: FormDefinition, edit: FormEditResult): boolean {
    return JSON.stringify(edit.content) !== JSON.stringify(applyFormEdits(base.content, {}).content);
}

/**
 * Runs the read-back that turns a completed write into a result. A failure here is not a failed edit — the
 * writes already landed — so the error says which ones did before it propagates.
 */
/**
 * The caller's precondition on the live version, re-tested against the freshest form the call holds — as
 * close to the write as this API allows. Saving a definition quotes a draft revision, not the version it
 * was derived from, so a publish landing between this check and the save cannot be detected here.
 */
function requireExpectedDefinition(expected: string | undefined, form: DetailedForm): void {
    if (expected === undefined || expected === form.activeDefinitionId) return;
    throw new CliError(
        `The form’s live definition is now ${form.activeDefinitionId}, not the expected ${expected}; describe it again and rebuild the edit`,
        6,
        'definition_changed'
    );
}

async function describeAppliedWrites<T>(
    applied: { metadata: boolean; definition: 'unchanged' | 'draft' | 'published' },
    build: () => T | Promise<T>
): Promise<T> {
    try {
        return await build();
    } catch (error) {
        const written = [
            ...(applied.metadata ? ['the metadata change'] : []),
            ...(applied.definition === 'unchanged' ? [] : [`the ${applied.definition} definition`])
        ];
        if (!written.length || !(error instanceof CliError)) throw error;
        throw new CliError(
            `${error.message} (${written.join(' and ')} already applied; read the form again rather than repeating the edit)`,
            error.exitCode,
            error.code,
            error.details
        );
    }
}

function withAppliedMetadataNote(error: unknown): unknown {
    if (!(error instanceof CliError)) return error;
    return new CliError(
        `${error.message} (the requested name, link, or notification-email changes were already applied)`,
        error.exitCode,
        error.code,
        error.details
    );
}

function requireLiveDefinition(form: DetailedForm): FormDefinition {
    const definition = form.activeDefinition;
    if (!definition) throw new CliError('The form has no live definition', 5, 'missing_active_definition');
    return definition;
}

function definitionSummary(definition: FormDefinition): Record<string, unknown> {
    const successMessage = definition.content.submit?.successMessage;
    return {
        definitionId: definition.id,
        version: definition.version,
        revision: definition.revision,
        isDraft: definition.isDraft,
        hasRenderTemplate: definition.renderTemplate !== null,
        title: definition.content.header?.title,
        submitLabel: definition.content.submit?.title,
        successMessage: typeof successMessage === 'string' ? successMessage : undefined,
        ...(successMessage !== undefined && typeof successMessage !== 'string' ? { successMessageIsExpression: true } : {})
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

export function buildFormIntegration(form: DetailedForm, suiteApiUrl: string): Record<string, unknown> & { warnings: string[] } {
    const botProtection = form.botProtection;
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
    if (form.botProtectionMode && !botProtection) {
        throw new CliError('ZynoSuite did not return the enabled form’s public bot-protection configuration', 5, 'invalid_suite_response');
    }
    if (botProtection && botProtection.mode !== form.botProtectionMode) {
        throw new CliError('ZynoSuite returned bot-protection configuration that does not match the form', 5, 'invalid_suite_response');
    }
    // An invisible proof is only obtainable from script, so the generated markup cannot stand on its own.
    if (botProtection?.mode === 'invisible') {
        warnings.push(
            'Invisible bot protection is enabled, so the generated HTML example cannot post by itself; every submission needs a Cap token. Use the capScript example, which solves Cap and submits the answers as JSON.'
        );
    }
    // A select stores plain strings. Anything else is authored outside this vocabulary, and the generated
    // control would drop those options silently, leaving an empty and unsubmittable field.
    const unrenderableSelects = contract.fields
        .filter(({ field }) => field.type === 'select' && Array.isArray(field.options) && !field.options.every(option => typeof option === 'string'))
        .map(({ key }) => key);
    if (unrenderableSelects.length) {
        warnings.push(
            `The select fields ${unrenderableSelects.join(', ')} hold options this vocabulary cannot express; the generated HTML omits their choices, so build those controls from the live definition instead.`
        );
    }
    // A paragraph field's pattern is a browser-side rule the API never re-checks, and a textarea cannot
    // carry one — so for these fields the generated markup enforces nothing the rendered form does.
    const unenforcedPatterns = contract.fields
        .filter(({ field }) => field.type === 'text' && field.format === 'large' && typeof field.pattern === 'string')
        .map(({ key }) => key);
    if (unenforcedPatterns.length) {
        warnings.push(
            `The paragraph fields ${unenforcedPatterns.join(', ')} carry a format rule that a textarea cannot enforce and the API does not re-check; validate them in your own script as the rendered ZynoForm does.`
        );
    }
    // The generated markup shows one copy of a repeating section. The API reads indexed names as an array
    // and rejects gaps, so hand-added copies have to be numbered consecutively from zero.
    const repeatedKeys = contract.fields.filter(({ repeated }) => repeated).map(({ key }) => key);
    if (repeatedKeys.length) {
        warnings.push(
            `The fields ${repeatedKeys.join(', ')} belong to a repeating section and are shown as copy [0] only. Number further copies consecutively — the API rejects a gap in the sequence — or let the rendered ZynoForm handle repeats.`
        );
    }
    const otherSelects = contract.fields.filter(({ field }) => field.type === 'select' && field.enableOther === true).map(({ key }) => key);
    if (otherSelects.length) {
        warnings.push(
            `The select fields ${otherSelects.join(', ')} accept a free-text "Other" answer that the generated markup cannot offer; it can submit only the listed options.`
        );
    }
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
        botProtection: botProtection ?? null,
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
                html: htmlFormExample(endpoints.submission, contract.fields, botProtection),
                // A Cap-free script for a protected form would be a submission the API always rejects,
                // so the two are alternatives rather than both being offered.
                ...(botProtection === undefined
                    ? { jsonScript: jsonScriptExample(endpoints.submission, successText(definition.content)) }
                    : { capScript: capScriptExample(endpoints.submission, botProtection, successText(definition.content)) })
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
        botProtectionMode: form.botProtectionMode,
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

function botProtectionMode(value: 'interactive' | 'invisible' | 'disabled'): 'interactive' | 'invisible' | null {
    return value === 'disabled' ? null : value;
}

function botProtectionModeName(value: 'interactive' | 'invisible' | null): 'interactive' | 'invisible' | 'disabled' {
    return value ?? 'disabled';
}

function publicTenantFromUrl(publicUrl: string): string {
    const segments = new URL(publicUrl).pathname.split('/').filter(Boolean);
    const formPrefix = segments.indexOf('f');
    const tenant = formPrefix === -1 ? undefined : segments[formPrefix + 1];
    if (!tenant) {
        throw new CliError('ZynoSuite returned a public form URL without a tenant segment', 5, 'invalid_suite_response');
    }
    try {
        return decodeURIComponent(tenant);
    } catch {
        // A stray percent makes decoding throw a bare URIError, which would surface with no exit code.
        throw new CliError('ZynoSuite returned a public form URL with invalid path encoding', 5, 'invalid_suite_response');
    }
}

function publicEndpoints(publicUrl: string, suiteApiUrl: string, definitionId: string, formId: string, formName: string) {
    const tenant = publicTenantFromUrl(publicUrl);
    const publicDefinition = `${suiteApiUrl}/public/forms/${encodeURIComponent(tenant)}/${encodeURIComponent(formId)}`;
    return {
        direct: publicUrl,
        iframe: `<iframe src="${escapeHtml(publicUrl)}" title="${escapeHtml(formName)}" style="width:100%;min-height:720px;border:0" loading="lazy"></iframe>`,
        iframeAutoHeight: autoHeightIframe(publicUrl, formName),
        definition: `${publicDefinition}?definitionId=${encodeURIComponent(definitionId)}`,
        currentDefinition: publicDefinition,
        submission: `${publicDefinition}/${encodeURIComponent(definitionId)}/submissions`
    };
}

// The rendered form measures itself and posts its height to whatever framed it, so a host page can
// size the frame to the content instead of leaving a fixed box with an inner scrollbar. The listener
// is generated rather than described because it has two checks a hand-written one tends to omit: any
// framed page can post a message, so the origin must match the form's, and a page may embed several
// forms, so the message must be tied to this frame. It matches on `event.source`, not the message's
// `formId` — a form URL may name its form by slug, so the id in the payload is only canonical once
// the definition has loaded.
function autoHeightIframe(publicUrl: string, formName: string): string {
    const origin = new URL(publicUrl).origin;
    return [
        `<iframe src="${escapeHtml(publicUrl)}" title="${escapeHtml(formName)}" style="width:100%;height:720px;border:0" loading="lazy"></iframe>`,
        '<script>',
        '(function () {',
        '    var frame = document.currentScript && document.currentScript.previousElementSibling;',
        '    if (!(frame instanceof HTMLIFrameElement)) return;',
        '    window.addEventListener("message", function (event) {',
        `    if (event.origin !== ${JSON.stringify(origin)}) return;`,
        '    var message = event.data;',
        '    if (!message || message.type !== "zcx:embed:form-height") return;',
        '    if (event.source !== frame.contentWindow) return;',
        '    if (typeof message.height !== "number" || !Number.isFinite(message.height) || message.height < 0) return;',
        '    frame.style.height = Math.ceil(message.height) + "px";',
        '    });',
        '}());',
        '</script>'
    ].join('\n');
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
    for (const { field, section } of walkFields(content)) {
        // A section holds no response of its own, and neither display blocks nor review summaries are
        // submitted; everything else answers under its own key, sections included via their children.
        if (field.type === 'section' || field.type === 'display' || field.type === 'review') continue;
        const repeat = section?.repeat;
        const candidateAlias = field.alias ?? aliasById.get(field.id);
        const alias = candidateAlias ? candidateAlias : undefined;
        const key = alias && !UNSAFE_FORM_KEYS.has(alias) ? alias : field.id;
        const contactFields = isRecord(field.fields) ? field.fields : undefined;
        const urlParameter = field.type === 'hidden' ? requireHiddenUrlParameter(field) : undefined;
        const details: Record<string, unknown> = {
            fieldId: field.id,
            submissionKey: key,
            type: field.type,
            required: isFieldRequired(field),
            ...(repeat === undefined ? {} : { repeated: true, repeat }),
            ...(field.label ? { label: field.label } : {}),
            ...(field.options !== undefined ? { options: field.options } : {}),
            ...(field.type === 'contact' && contactFields ? { contactFields: contactResponseParts(contactFields) } : {}),
            ...(urlParameter === undefined ? {} : { source: 'urlQueryParameter', urlParameter })
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
        case 'hidden':
            return 'example-url-value';
        default:
            return textExample(field);
    }
}

function requireHiddenUrlParameter(field: FormField): string {
    if (typeof field.alias === 'string' && field.alias) return field.alias;
    throw new CliError(`ZynoSuite returned hidden field ${field.id} without its required URL parameter name`, 5, 'invalid_suite_response');
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

function htmlFormExample(submissionUrl: string, fields: ContractField[], botProtection?: PublicBotProtection): string {
    const controls = fields.flatMap(({ key, field, repeated }) => htmlControls(key, field, repeated));
    const hiddenPrefill = hiddenFieldPrefillScript(fields);
    // The widget posts the solved proof as a hidden field of this form, so interactive protection needs no
    // script of the site's own. An invisible proof has no markup form at all — say so instead of shipping a
    // form every submission of which the API rejects.
    const capControls =
        botProtection?.mode === 'interactive'
            ? [
                  capWidgetScriptTag(),
                  `  <cap-widget required data-cap-api-endpoint="${escapeHtml(botProtection.apiEndpoint)}" data-cap-hidden-field-name="${escapeHtml(botProtection.tokenField)}"></cap-widget>`
              ]
            : [];
    // Under invisible protection the capScript below takes over this form's submit event. The action stays
    // on the element anyway: if that script never loads, a native post fails loudly with the API's own 400
    // instead of navigating to a URL carrying every answer in its query string.
    const invisible = botProtection?.mode === 'invisible';
    const preamble = invisible
        ? [
              '<!-- Invisible bot protection: the capScript example submits this form. Paste it after this markup; a native post carries no proof and is rejected. -->'
          ]
        : [];
    const status = invisible ? [`<p id="${STATUS_ELEMENT_ID}" role="status" aria-live="polite"></p>`] : [];
    return [
        ...preamble,
        `<form id="${FORM_ELEMENT_ID}" method="post" action="${escapeHtml(submissionUrl)}" enctype="application/x-www-form-urlencoded">`,
        ...controls.map(control => `  ${control}`),
        ...capControls,
        '  <button type="submit">Submit</button>',
        '</form>',
        ...hiddenPrefill,
        ...status
    ].join('\n');
}

/** The submitting script for each protection mode: a JSON path for custom pages, a handler for the markup. */
function capScriptExample(submissionUrl: string, botProtection: PublicBotProtection, success: string): string {
    const endpoint = jsonForInlineScript(botProtection.apiEndpoint);
    const submission = jsonForInlineScript(submissionUrl);
    const tokenField = jsonForInlineScript(botProtection.tokenField);
    const formSelector = jsonForInlineScript(`#${FORM_ELEMENT_ID}`);
    const statusSelector = jsonForInlineScript(`#${STATUS_ELEMENT_ID}`);
    const successMessage = jsonForInlineScript(success);
    if (botProtection.mode === 'interactive') {
        // The API validates the responses before it consumes the proof, so a field error leaves the visitor's
        // solved widget usable. Resetting on every failure would send them back through verification for a
        // mistyped email; reset once the proof has actually been spent, or when the API says it is stale.
        return `<cap-widget id="zyno-cap" required data-cap-api-endpoint="${escapeHtml(botProtection.apiEndpoint)}"></cap-widget>
${capWidgetScriptTag()}
<script>
const zynoCapWidget = document.querySelector('#zyno-cap');
async function submitZynoForm(responses) {
  const capToken = zynoCapWidget?.tokenValue;
  if (!capToken) throw new Error('Complete the verification first.');
  const response = await fetch(${submission}, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ responses, [${tokenField}]: capToken })
  });
  if (response.ok) {
    zynoCapWidget.reset();
    return await response.json();
  }
  const failure = await response.json().catch(() => ({}));
  // Only a field-level 400 provably left the proof unspent; anything else may have consumed it.
  if (response.status !== 400 || /verification/i.test(failure.error ?? '')) zynoCapWidget.reset();
  throw new Error(failure.error || \`Submission failed (\${response.status})\`);
}
</script>`;
    }
    // Wired to the generated markup, so the pair works as pasted. Three things this has to get right:
    // JSON rather than the form's own encoding, because it forces a CORS preflight and a page whose origin
    // is not allowed is then refused *before* a submission is stored rather than after; one solver for the
    // page, because constructing Cap appends a hidden widget and spawns workers that nothing removes; and a
    // visible outcome, because a listener's rejected promise goes nowhere a visitor can see.
    return `${capWidgetScriptTag()}
<script>
const zynoForm = document.querySelector(${formSelector});
const zynoStatus = document.querySelector(${statusSelector});
const zynoCap = new Cap({ apiEndpoint: ${endpoint} });

zynoForm.addEventListener('submit', event => {
  event.preventDefault();
  void submitZynoForm();
});

async function submitZynoForm() {
  if (!zynoForm.reportValidity()) return;
  const submit = zynoForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  zynoStatus.textContent = 'Verifying that you are human…';
  try {
    const result = await zynoCap.solve();
    if (!result?.success || !result.token) throw new Error('Human verification could not be completed. Please try again.');
    const response = await fetch(${submission}, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responses: zynoResponses(), [${tokenField}]: result.token })
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.error || \`Submission failed (\${response.status})\`);
    }
    zynoForm.hidden = true;
    zynoStatus.textContent = ${successMessage};
  } catch (error) {
    zynoStatus.textContent = error.message;
    submit.disabled = false;
  }
}

/** Rebuilds the nested responses object from this form's own field names. */
function zynoResponses() {
  const responses = Object.create(null);
  for (const [name, value] of new FormData(zynoForm)) {
    if (!name.startsWith('responses[')) continue;
    const path = [...name.matchAll(/\\[([^\\]]*)\\]/g)].map(part => part[1]);
    let node = responses;
    path.forEach((part, index) => {
      if (index === path.length - 1) node[part] = value;
      else {
        if (!Object.hasOwn(node, part)) node[part] = /^\\d+$/.test(path[index + 1]) ? [] : Object.create(null);
        node = node[part];
      }
    });
  }
  return responses;
}
</script>`;
}

/**
 * The submitting script for a form the site builds and styles itself. Cap-protected forms get
 * `capScript` instead, which has to solve a proof first; this is the plain path, and it exists
 * because a page carrying its own markup otherwise had the endpoint and the body shape but no
 * example stating the verb, the content type, or what a rejection looks like.
 */
function jsonScriptExample(submissionUrl: string, success: string): string {
    const submission = jsonForInlineScript(submissionUrl);
    const successMessage = jsonForInlineScript(success);
    return `<script>
(() => {
// In this script's own submit handler, call with field values keyed by submission key:
// submitZynoForm({ email: 'person@example.com' })
async function submitZynoForm(responses) {
  const response = await fetch(${submission}, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ responses })
  });
  const result = await response.json().catch(() => ({}));
  // 200 answers { ok: true }; every failure answers { error: "..." } — 400 for a rejected value,
  // 404 for an unknown form or definition, 413 for a body over the 5 MiB limit.
  if (!response.ok) throw new Error(result.error || \`Submission failed (\${response.status})\`);
  return ${successMessage};
}
})();
</script>`;
}

/** The form's own confirmation, when it is fixed text an artifact can safely repeat back. */
function successText(content: FormDefinitionContent): string {
    const message = content.submit?.successMessage;
    return typeof message === 'string' && message.trim() ? message : 'Thank you. Your response has been submitted.';
}

function capWidgetScriptTag(): string {
    return '<script src="https://cdn.jsdelivr.net/npm/cap-widget@0.1.56/cap.min.js"></script>';
}

function jsonForInlineScript(value: unknown): string {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error('Cannot serialize inline script data');
    return json.replaceAll('<', '\\u003c');
}

function htmlControls(key: string, field: FormField, repeated: boolean): string[] {
    const name = `responses[${key}]${repeated ? '[0]' : ''}`;
    const label = field.label ?? key;
    const required = field.optional === true || field.type === 'marketingOptOut' || field.type === 'emailCopy' ? '' : ' required';
    if (field.type === 'hidden') {
        return [`<input type="hidden" id="${escapeHtml(hiddenInputId(field))}" name="${escapeHtml(name)}" disabled>`];
    }
    if (field.type === 'contact' && isRecord(field.fields)) {
        return contactResponseParts(field.fields).map(
            part =>
                `<label>${escapeHtml(humanize(part))} <input name="${escapeHtml(`${name}[${part}]`)}"${contactInputType(part)}${required}></label>`
        );
    }
    if (field.type === 'select' && Array.isArray(field.options)) {
        // A select is only "missing" to the browser when its selected option is a placeholder — first, and
        // with an empty value. Without one, `required` never fires and the first real option is submitted
        // by default, quietly answering a question the rendered ZynoForm makes the visitor answer.
        const placeholder = `<option value=""${required ? ' disabled' : ''} selected></option>`;
        return [
            `<label>${escapeHtml(label)} <select name="${escapeHtml(name)}"${required}>${placeholder}${field.options
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
    // A tickbox can only say yes, and an untouched one is indistinguishable from an unread question. Two
    // formats need an answer either way, so both render as an explicit pair, exactly as the ZynoForm does:
    // a yes/no checkbox (required, unanswered until chosen) and a marketing question (whose unticked state
    // is itself an answer, so the default the renderer seeds is preselected here).
    if (field.type === 'marketingOptOut' || (field.type === 'checkbox' && field.format === 'yesno')) {
        const inverted = field.type === 'marketingOptOut' && field.inverted === true;
        const marketing = field.type === 'marketingOptOut';
        const preselected = marketing ? String(inverted) : undefined;
        return [
            `<fieldset><legend>${escapeHtml(label)}</legend>`,
            ...(['Yes', 'No'] as const).map(answer => {
                // The stored value always means "opted out", whichever way the question is worded.
                const value = String(answer === 'Yes' ? !inverted : inverted);
                const checked = value === preselected ? ' checked' : '';
                return `  <label><input type="radio" name="${escapeHtml(name)}" value="${value}"${marketing ? '' : required}${checked}> ${answer}</label>`;
            }),
            '</fieldset>'
        ];
    }
    if (field.type === 'checkbox' || field.type === 'emailCopy') {
        return [`<label><input type="checkbox" name="${escapeHtml(name)}" value="true"${required}> ${escapeHtml(label)}</label>`];
    }
    if (field.type === 'signature') {
        return [
            `<label>${escapeHtml(label)} <input type="text" name="${escapeHtml(name)}" value="name:Alex Example" pattern="name:.+"${required}></label>`
        ];
    }
    if (field.type === 'text' && field.format === 'large') {
        // `pattern` is an input-only attribute; a textarea ignores it, and the API deliberately does not
        // re-check patterns either. Emitting it would look like a rule and enforce nothing.
        return [
            `<label>${escapeHtml(label)} <textarea name="${escapeHtml(name)}"${controlAttributes(field, { pattern: false })}${required}></textarea></label>`
        ];
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

function hiddenFieldPrefillScript(fields: ContractField[]): string[] {
    const bindings = fields.flatMap(({ field }) => {
        if (field.type !== 'hidden' || typeof field.alias !== 'string') return [];
        return [{ id: hiddenInputId(field), parameter: field.alias }];
    });
    if (!bindings.length) return [];
    return [
        `<script>
for (const { id, parameter } of ${jsonForInlineScript(bindings)}) {
  const input = document.getElementById(id);
  const value = new URLSearchParams(window.location.search).get(parameter);
  if (input instanceof HTMLInputElement && value !== null) {
    input.value = value;
    input.disabled = false;
  }
}
</script>`
    ];
}

function hiddenInputId(field: FormField): string {
    return `zyno-hidden-${field.id}`;
}

function controlAttributes(field: FormField, options: { pattern?: boolean } = {}): string {
    const attributes: Array<[string, unknown]> = [
        ['placeholder', field.placeholder],
        ['min', field.min],
        ['max', field.max],
        ['step', field.step],
        ['minlength', field.minLength],
        ['maxlength', field.maxLength],
        ['pattern', options.pattern === false ? undefined : field.pattern]
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

\`create_basic_form\` creates and immediately publishes a one-page form. Each field has a unique \`key\`, which becomes its stable submission alias, and \`required\` defaults to true. The creator supports text, textarea, email, phone, URL, hidden URL-parameter, number, date, select, radio, checkbox, and one contact field. A hidden field accepts only \`key\` and \`label\`: the public ZynoForm reads its matching query parameter (for example, \`?campaign=spring\`) into that response. It is visitor-controlled attribution, not a secret or trusted input. Contact details label themselves and are selected with \`fields\`, such as \`["first_name", "last_name", "email", "phone_cell", "address"]\`. Use \`zip\` for ZIP-only collection; \`address\` already includes street, ZIP, city, and state. Its \`bot_protection\` defaults to \`interactive\`; choose \`invisible\` for a programmatic solve or \`disabled\` to preserve a legacy submission integration.

Set explicit \`origins\`, or use \`origin_sites\` to allow HTTPS origins for a ZynoHosting site's primary, alias, and vanity hostnames. The result includes the published form's complete integration details.

## Inspecting and editing a form

\`describe_form\` returns a form the way it is authored: its pages and fields in order, each with the \`key\` that addresses it, its type in the same vocabulary \`create_basic_form\` speaks, its constraints, and whether these tools can edit it. Its \`advanced\` list names everything a form holds that they preserve but cannot author — sections, conditional rules, themes, translations, review and signature fields.

\`update_form\` changes a form in place. Metadata — \`name\`, \`slug\`, \`title\`, \`submit_label\`, \`success_message\`, \`notification_emails\` — is set directly; fields change through \`operations\`, applied in order:

\`\`\`json
{
    "form": "contact-us",
    "operations": [
        { "op": "add_field", "after": "email", "field": { "key": "budget", "type": "number", "label": "Budget", "min": 0 } },
        { "op": "update_field", "key": "message", "label": "How can we help?", "required": false },
        { "op": "move_field", "key": "terms", "page": 2 },
        { "op": "remove_field", "key": "fax" }
    ]
}
\`\`\`

Fields not named by an operation keep their identity and every stored detail, so editing one field never disturbs another. An anchor inside a section inserts into that section. A new version is published immediately; pass \`publish: false\` to leave an unpublished draft for a person to review instead.

Removing a field does not affect existing submissions: each one is pinned to the definition version it was made against. Renaming a key does break integrations posting the old one. A field named by a conditional rule cannot be renamed or removed here, and neither can a field type outside the basic vocabulary — use the ZynoForms builder for those.

A form has one shared draft. While an unpublished draft exists, \`update_form\` refuses rather than overwrite work in progress; publish or discard it in the builder, or pass \`on_existing_draft: "extend"\` to build on that draft. Pass \`expected_definition_id\` from \`describe_form\` to have the edit refused if the live version changed in the meantime. It is re-checked immediately before the write; the API has no atomic compare-and-publish, so a publish landing in that last instant cannot be detected.

\`update_form_bot_protection\` independently and idempotently changes only Cap protection. Use \`interactive\`, \`invisible\`, or \`disabled\`; a setting that already matches makes no write.

## Direct link or iframe

The form's \`publicUrl\` is a customer-facing rendered form. Link to it directly or use the iframe returned by the tools. An iframe does not require custom JavaScript; adjust its minimum height to suit the page and form.

A framed form measures itself and posts its height to the parent page, so the frame can follow the content instead of scrolling inside a fixed box:

\`\`\`json
{ "type": "zcx:embed:form-height", "formId": "<form UUID>", "height": 1180 }
\`\`\`

It posts as soon as it loads and again on every later height change — paging through a multi-page form, a conditional field appearing, a validation message, the visitor resizing the window. \`get_form_integration\` returns \`iframeAutoHeight\`: the same iframe plus a listener that applies it. A page writing its own listener must check \`event.origin\` against the form's origin, and identify the sending frame with \`event.source === frame.contentWindow\` when the page embeds more than one form. Do not match on \`formId\`: a form URL may name its form by slug, so the payload carries whatever the URL used until the definition loads and the canonical form UUID afterwards. The form posts to \`*\` because it cannot know which site framed it; the payload is only that id and an integer. A page that ignores the message keeps its fixed-height iframe and inner scrollbar, so nothing breaks by not listening.

## Custom HTML or JavaScript

A site can build and style its own form and post to ZynoForms directly — no iframe, no ZynoSuite markup. Read the field list from \`get_form_integration\`'s \`fieldsByAlias\` (or the public definition endpoint, to pick up changes without a redeploy), render it however the site's design calls for, and \`POST\` the answers to the live definition's public submission endpoint with \`Content-Type: application/json\`. Public definition and submission requests require no credentials. JSON is the recommended and OpenAPI-advertised format:

\`\`\`json
{ "responses": { "email": "person@example.com" } }
\`\`\`

A form without bot protection returns a ready \`jsonScript\` example with an instance-scoped \`submitZynoForm\` function for that form's own submit handler; a protected one returns \`capScript\` instead, which is the same request with a solved Cap token added, since a submission without one is always rejected.

A stored submission answers \`200\` with \`{ "ok": true }\`. Every failure answers \`{ "error": "<message>" }\`: \`400\` for a rejected value, a field addressed twice, an unpublished definition, or failed verification — the message is meant to be shown to the visitor; \`404\` for a tenant, form, or definition that does not exist; \`413\` for a body over the 5 MiB limit. A cross-origin submission from an unlisted origin is refused by the browser at the preflight, so the page sees a network error rather than a status.

The runtime also accepts \`application/x-www-form-urlencoded\` and multipart text fields using bracket notation:

\`\`\`text
responses[email]=person@example.com
responses[contact][firstName]=Alex
responses[contact][lastName]=Example
\`\`\`

Use field aliases as response keys. Field UUIDs remain supported as a fallback. Brackets create nested objects; numeric brackets and empty brackets create arrays. File uploads are not supported by the basic-form integration.

A hidden field is not a secret and never renders a visible input. Its alias is the public form URL's query-parameter name: a link ending in \`?campaign=spring\` submits \`campaign: "spring"\`. The generated native HTML keeps that control disabled unless that exact parameter is present, then a small prefill script enables it. Custom JSON clients should use the same parameter convention and must treat every value as visitor-controlled.

When \`botProtection\` is non-null in the integration result, its \`apiEndpoint\` and \`tokenField\` are authoritative. Use the endpoint exactly as returned, trailing slash included—the widget appends its own \`challenge\` and \`redeem\` paths to it. The public definition endpoint returns the same object, so a script can read it at runtime instead of hard-coding it.

For \`interactive\`, the native HTML example pins \`cap-widget@0.1.56\` and renders \`<cap-widget>\` with that endpoint and a hidden \`capToken\` field, so the widget posts the proof as part of the form and the page needs no script of its own. The widget is form-associated and carries \`required\`, so the browser blocks submission until the visitor solves it. Its \`capScript\` example shows the matching JSON payload, so custom pages can use Cap without rendering an official ZynoForm.

For \`invisible\`, run local validation first and then call \`new Cap({ apiEndpoint }).solve()\`; include the resulting token as the returned \`tokenField\` (currently \`capToken\`) in the JSON submission. There is no markup-only path: the generated \`capScript\` takes over the generated form's submit event, solves Cap, and posts its answers as JSON. \`disabled\` omits Cap entirely, so existing HTML and JSON submissions remain valid.

The widget loads more than the pinned script: at runtime it fetches its WebAssembly and pako from \`cdn.jsdelivr.net\` and calls the Cap \`apiEndpoint\`. A page with a strict Content-Security-Policy needs both hosts in \`script-src\` and \`connect-src\`, or verification fails with nothing visibly wrong.

A proof is single-use. Each submission needs its own, and the API validates the responses *before* it consumes the proof—so a rejection for a bad field value leaves the visitor's solved widget usable, and only a spent or expired proof requires verifying again. Verification failures come back as HTTP 400 with a message about verification.

The generated native HTML form posts without a script of the site's own—except the small URL-prefill script needed for hidden fields. For \`invisible\` protection, use the \`capScript\` example instead—and then navigates to the API's JSON success response. To show an in-page confirmation instead, intercept submission with JavaScript and allow the page's exact origin before using cross-origin \`fetch\`.

The rendered ZynoForm and generated HTML enforce required fields in the browser. A custom JavaScript client should enforce the returned \`required\` contract before submission; the public API cannot generally enforce requiredness because advanced forms may conditionally hide fields.

## CORS origins

Browser JavaScript that fetches a definition or submits cross-origin must use an allowed exact origin. Use \`update_form_origins\` with explicit HTTP(S) origins, or add a ZynoHosting site to allow HTTPS from its primary, alias, and vanity hostnames. Origins contain only scheme, host, and optional port—never a path.

Allowed origins govern the ZynoSuite form endpoints only. Cap's own \`apiEndpoint\` answers any origin, so solving needs no configuration; a page that solves successfully and is then refused at submission has an origin problem, not a verification one.

Both generated scripts submit JSON deliberately. A URL-encoded \`fetch\` is a simple cross-origin request that skips the preflight, and the submission endpoint withholds only its response headers — so an unlisted origin would have its submissions stored and merely hidden from the page, with every retry storing another. JSON forces the preflight, and an unlisted origin is refused before anything is written. A native \`<form>\` post is a navigation rather than a fetch, so it is unaffected either way.

## Versioning and limits

API endpoints use the stable form UUID and submission URLs include the active definition ID. After publishing a different definition, call \`get_form_integration\` again and update custom integrations. A saved draft does not change the live endpoint. Request bodies are limited to 5 MiB. The URL-encoded and multipart bracket parser rejects unsafe object keys such as \`__proto__\`; a field whose alias is one of those submits under its field UUID instead.
`;
