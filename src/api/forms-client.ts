import { z } from 'zod';

import type { ManagerCredential } from '../config.js';

import { CliError } from '../errors.js';
import { requestJson } from './http.js';
import { authorizationHeaders } from './manager-client.js';

/**
 * What the Suite itself accepts for a field id — any hex in UUID shape, not only an RFC-versioned one
 * (`_UUID_PATTERN` in FormsDefinition.service.ts). A definition authored before the management API existed
 * can hold such an id, and rejecting it here would report every form as an invalid server response.
 */
const storedUuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be a UUID');

const formFieldSchema = z
    .object({
        id: storedUuidSchema,
        alias: z.string().optional(),
        type: z.string().min(1),
        label: z.string().optional(),
        title: z.union([z.string(), z.object({ expr: z.string() }).passthrough()]).optional(),
        optional: z.boolean().optional(),
        options: z.unknown().optional(),
        fields: z.unknown().optional()
    })
    .passthrough();

const formDefinitionContentSchema = z
    .object({
        fieldIdsByAlias: z.record(z.string(), storedUuidSchema).optional(),
        header: z
            .object({
                title: z.string().optional(),
                browserTitle: z.string().optional()
            })
            .passthrough()
            .optional(),
        submit: z
            .object({
                title: z.string().optional(),
                successMessage: z.unknown().optional()
            })
            .passthrough()
            .optional(),
        pages: z.array(z.object({ fields: z.array(formFieldSchema).default([]) }).passthrough())
    })
    .passthrough();

const formSummarySchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string().nullable(),
    emailTo: z.array(z.string()).nullable(),
    corsOrigins: z.array(z.string()).nullable(),
    // Absent from a Suite deployment that predates Cap, and the CLI can be pointed at one environment while
    // another is still on the older build. Missing means the same thing the column does: protection is off.
    botProtectionMode: z.enum(['interactive', 'invisible']).nullish().default(null),
    activeDefinitionId: z.string().uuid(),
    createdAt: z.string(),
    updatedAt: z.string(),
    publicUrl: z.string().url().refine(isSafePublicUrl, 'must be an HTTP(S) URL without credentials, a query, or a fragment'),
    hasDraft: z.boolean(),
    submissionCount: z.number().int().nonnegative()
});

const publicBotProtectionSchema = z.object({
    provider: z.literal('cap'),
    mode: z.enum(['interactive', 'invisible']),
    apiEndpoint: z.string().url(),
    tokenField: z.literal('capToken')
});

const formDefinitionSchema = z.object({
    id: z.string().uuid(),
    // A draft carries version 0 until publishing numbers it, so a detailed form holding one has to parse.
    version: z.number().int().nonnegative(),
    isDraft: z.boolean(),
    revision: z.number().int().nonnegative(),
    content: formDefinitionContentSchema,
    renderTemplate: z.string().nullable()
});

const detailedFormSchema = formSummarySchema.extend({
    activeDefinition: formDefinitionSchema.optional(),
    draftDefinition: formDefinitionSchema.optional(),
    botProtection: publicBotProtectionSchema.optional()
});

export type FormField = z.infer<typeof formFieldSchema>;
export type FormDefinitionContent = z.infer<typeof formDefinitionContentSchema>;
export type FormSummary = z.infer<typeof formSummarySchema>;
export type DetailedForm = z.infer<typeof detailedFormSchema>;
export type PublicBotProtection = z.infer<typeof publicBotProtectionSchema>;

export type FormDefinition = z.infer<typeof formDefinitionSchema>;

export interface CreateFormRequest {
    name: string;
    slug?: string | null;
    emailTo?: string[] | null;
    corsOrigins?: string[] | null;
    botProtectionMode?: 'interactive' | 'invisible' | null;
    content: FormDefinitionContent;
}

export type UpdateFormRequest = Partial<Pick<CreateFormRequest, 'name' | 'slug' | 'emailTo' | 'corsOrigins' | 'botProtectionMode'>>;

export interface SaveDefinitionRequest {
    content: FormDefinitionContent;
    /** Publish in the same locked transaction instead of leaving the draft unpublished. */
    publish?: boolean;
    /**
     * The draft revision this edit was based on — 0 when the form had no draft. A form has one shared
     * draft, so quoting it is what stops this write from erasing an edit made since the base was read.
     */
    expectedRevision?: number;
}

export class FormsClient {
    constructor(
        private readonly apiUrl: string | undefined,
        private readonly credential: ManagerCredential,
        private readonly timeoutMs = 30_000
    ) {}

    async listForms(): Promise<FormSummary[]> {
        return parseResponse(z.array(formSummarySchema), await this.request('/forms'));
    }

    async getForm(id: string): Promise<DetailedForm> {
        return parseResponse(detailedFormSchema, await this.request(`/forms/manage/${encodeURIComponent(id)}`));
    }

    async createForm(body: CreateFormRequest): Promise<DetailedForm> {
        return parseResponse(
            detailedFormSchema,
            await this.request('/forms/manage', {
                method: 'POST',
                body: JSON.stringify(body)
            })
        );
    }

    async updateForm(id: string, body: UpdateFormRequest): Promise<DetailedForm> {
        return parseResponse(
            detailedFormSchema,
            await this.request(`/forms/manage/${encodeURIComponent(id)}`, {
                method: 'PUT',
                body: JSON.stringify(body)
            })
        );
    }

    /**
     * Upserts the form's single draft definition, optionally publishing it in the same call.
     *
     * `renderTemplate` is deliberately never sent: omitting it is what makes a new draft inherit the live
     * version's submission template, and sending null would quietly revert emails and PDFs to the built-in
     * layout off the back of an edit that never mentioned it.
     */
    async saveDefinition(formId: string, body: SaveDefinitionRequest): Promise<FormDefinition> {
        return parseResponse(
            formDefinitionSchema,
            await this.request(`/forms/manage/${encodeURIComponent(formId)}/definitions`, {
                method: 'POST',
                body: JSON.stringify(body)
            })
        );
    }

    private async request(path: string, options: { method?: string; body?: string } = {}): Promise<unknown> {
        if (!this.apiUrl) {
            throw new CliError(
                'The ZynoSuite API URL is not configured for this Hosting API. Pass --suite-api-url or set ZYNO_SUITE_API_URL.',
                2,
                'missing_suite_api_url'
            );
        }
        return requestJson(`${this.apiUrl}${path}`, {
            ...(options.method === undefined ? {} : { method: options.method }),
            timeoutMs: this.timeoutMs,
            headers: {
                ...(await authorizationHeaders(this.credential)),
                Accept: 'application/json',
                ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' })
            },
            ...(options.body === undefined ? {} : { body: options.body })
        });
    }
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new CliError(`ZynoSuite returned an invalid forms response: ${z.prettifyError(parsed.error)}`, 5, 'invalid_suite_response');
}

function isSafePublicUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && !url.search && !url.hash;
    } catch {
        return false;
    }
}
