import { z } from 'zod';

import type { ManagerCredential } from '../config.js';

import { CliError } from '../errors.js';
import { requestJson } from './http.js';
import { authorizationHeaders } from './manager-client.js';

const formFieldSchema = z
    .object({
        id: z.string().uuid(),
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
        fieldIdsByAlias: z.record(z.string(), z.string().uuid()).optional(),
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
        pages: z.array(z.object({ fields: z.array(formFieldSchema) }).passthrough())
    })
    .passthrough();

const formSummarySchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string().nullable(),
    emailTo: z.array(z.string()).nullable(),
    corsOrigins: z.array(z.string()).nullable(),
    activeDefinitionId: z.string().uuid(),
    createdAt: z.string(),
    updatedAt: z.string(),
    publicUrl: z.string().url().refine(isSafePublicUrl, 'must be an HTTP(S) URL without credentials, a query, or a fragment'),
    hasDraft: z.boolean(),
    submissionCount: z.number().int().nonnegative()
});

const formDefinitionSchema = z.object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    isDraft: z.boolean(),
    revision: z.number().int().nonnegative(),
    content: formDefinitionContentSchema,
    renderTemplate: z.string().nullable()
});

const detailedFormSchema = formSummarySchema.extend({
    activeDefinition: formDefinitionSchema.optional(),
    draftDefinition: formDefinitionSchema.optional()
});

export type FormField = z.infer<typeof formFieldSchema>;
export type FormDefinitionContent = z.infer<typeof formDefinitionContentSchema>;
export type FormSummary = z.infer<typeof formSummarySchema>;
export type DetailedForm = z.infer<typeof detailedFormSchema>;

export interface CreateFormRequest {
    name: string;
    slug?: string | null;
    emailTo?: string[] | null;
    corsOrigins?: string[] | null;
    content: FormDefinitionContent;
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

    async updateForm(id: string, body: { corsOrigins: string[] | null }): Promise<DetailedForm> {
        return parseResponse(
            detailedFormSchema,
            await this.request(`/forms/manage/${encodeURIComponent(id)}`, {
                method: 'PUT',
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
