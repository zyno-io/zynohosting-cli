import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { FormField } from '../api/forms-client.js';

export const ALIAS_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const UNSAFE_FORM_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** The authoring vocabulary these tools speak. Anything else is described and preserved, never authored. */
export const BASIC_FIELD_TYPES = [
    'text',
    'textarea',
    'email',
    'phone',
    'url',
    'hidden',
    'number',
    'date',
    'select',
    'radio',
    'checkbox',
    'contact'
] as const;

export type BasicFieldType = (typeof BASIC_FIELD_TYPES)[number];

export function calendarDateSchema() {
    return z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'must use YYYY-MM-DD')
        .refine(value => {
            const date = new Date(`${value}T00:00:00Z`);
            return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
        }, 'must be a real calendar date');
}

export const fieldKeySchema = z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(ALIAS_PATTERN, 'must be a JavaScript identifier, using letters, numbers, _, or $')
    .refine(key => !UNSAFE_FORM_KEYS.has(key), 'is reserved by the web-form parser');

const commonFieldIdentityShape = {
    key: fieldKeySchema,
    required: z.boolean().default(true)
};

const commonFieldShape = { ...commonFieldIdentityShape, label: z.string().trim().min(1).max(255) };

export const radioOptionSchema = z.union([
    z.string().trim().min(1).max(255),
    z.object({ title: z.string().trim().min(1).max(255), value: z.string().trim().min(1).max(255).optional() }).strict()
]);

export const selectOptionsSchema = z.array(z.string().trim().min(1).max(255)).min(1).max(100);
export const radioOptionsSchema = z.array(radioOptionSchema).min(1).max(100);

const textFieldSchema = z
    .object({
        ...commonFieldShape,
        type: z.enum(['text', 'textarea', 'email', 'phone', 'url']),
        placeholder: z.string().max(500).optional(),
        min_length: z.number().int().nonnegative().optional(),
        max_length: z.number().int().nonnegative().optional()
    })
    .strict();

/** A URL-populated tracking value. It has no rendered input and therefore cannot be required. */
const hiddenFieldSchema = z
    .object({
        key: fieldKeySchema,
        type: z.literal('hidden'),
        label: z.string().trim().min(1).max(255)
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
        options: selectOptionsSchema,
        enable_other: z.boolean().default(false)
    })
    .strict();

const radioFieldSchema = z
    .object({
        ...commonFieldShape,
        type: z.literal('radio'),
        options: radioOptionsSchema
    })
    .strict();

const checkboxFieldSchema = z
    .object({
        ...commonFieldShape,
        type: z.literal('checkbox')
    })
    .strict();

export const contactPartSchema = z.enum(['display_name', 'first_name', 'last_name', 'company', 'birthdate', 'phone_cell', 'email', 'address', 'zip']);

export const contactPartsSchema = z.array(contactPartSchema).min(1).max(9);

const contactFieldSchema = z
    .object({
        ...commonFieldIdentityShape,
        type: z.literal('contact'),
        fields: contactPartsSchema
    })
    .strict();

export const basicFieldSchema = z.discriminatedUnion('type', [
    textFieldSchema,
    hiddenFieldSchema,
    numberFieldSchema,
    dateFieldSchema,
    selectFieldSchema,
    radioFieldSchema,
    checkboxFieldSchema,
    contactFieldSchema
]);

export type BasicFieldInput = z.infer<typeof basicFieldSchema>;
export type ContactPart = z.infer<typeof contactPartSchema>;
export type RadioOptionInput = z.infer<typeof radioOptionSchema>;

/**
 * The single-field consistency rules shared by form creation and later edits. Cross-field rules — unique
 * keys, at most one contact field — belong to whatever holds the complete set of fields, because an edit
 * has to check its result against the fields it never touched.
 */
export function refineBasicField(field: BasicFieldInput, context: z.RefinementCtx, path: PropertyKey[]): void {
    if ('min_length' in field && field.min_length !== undefined && field.max_length !== undefined && field.min_length > field.max_length) {
        context.addIssue({ code: 'custom', path, message: 'min_length cannot exceed max_length' });
    }
    if ('min' in field && field.min !== undefined && field.max !== undefined && field.min > field.max) {
        context.addIssue({ code: 'custom', path, message: 'min cannot exceed max' });
    }
    if (field.type === 'select' && new Set(field.options).size !== field.options.length) {
        context.addIssue({ code: 'custom', path: [...path, 'options'], message: 'options must be unique' });
    }
    if (field.type === 'radio') {
        const values = field.options.map(radioOptionValue);
        if (new Set(values).size !== values.length) {
            context.addIssue({ code: 'custom', path: [...path, 'options'], message: 'option values must be unique' });
        }
    }
    if (field.type === 'contact') refineContactParts(field.fields, context, [...path, 'fields']);
}

export function refineContactParts(parts: ContactPart[], context: z.RefinementCtx, path: PropertyKey[]): void {
    if (new Set(parts).size !== parts.length) {
        context.addIssue({ code: 'custom', path, message: 'contact fields must be unique' });
    }
    if (parts.includes('address') && parts.includes('zip')) {
        context.addIssue({ code: 'custom', path, message: 'address already includes ZIP; omit zip' });
    }
}

export function radioOptionValue(option: RadioOptionInput): string {
    return typeof option === 'string' ? option : (option.value ?? option.title);
}

export function buildBasicField(field: BasicFieldInput): FormField {
    const optional = 'required' in field && field.required === false;
    const common = {
        id: randomUUID(),
        alias: field.key,
        ...(optional ? { optional: true } : {})
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
        case 'hidden':
            return { ...common, type: 'hidden', label: field.label };
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

const CONTACT_PART_NAMES: Record<ContactPart, string> = {
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

const CONTACT_PARTS_BY_NAME = new Map(Object.entries(CONTACT_PART_NAMES).map(([part, name]) => [name, part as ContactPart]));

export function contactPartName(part: ContactPart): string {
    return CONTACT_PART_NAMES[part];
}

export interface BasicFieldDescription {
    type: BasicFieldType;
    /** The field in the authoring vocabulary — the same property names `add_field` accepts. */
    properties: Record<string, unknown>;
    /** Stored properties outside the vocabulary. They survive an edit untouched but cannot be authored here. */
    preserved: string[];
    /** Authoring properties that cannot be rewritten without discarding detail this vocabulary omits. */
    locked: string[];
}

/**
 * The inverse of `buildBasicField`: the stored field as the vocabulary that produced it. Returns undefined
 * for a type the vocabulary has no word for, which is how callers decide a field is describe-only.
 */
export function describeBasicField(field: FormField): BasicFieldDescription | undefined {
    switch (field.type) {
        case 'text': {
            const type: BasicFieldType =
                field.format === 'large'
                    ? 'textarea'
                    : field.inputType === 'email'
                      ? 'email'
                      : field.inputType === 'tel'
                        ? 'phone'
                        : field.inputType === 'url'
                          ? 'url'
                          : 'text';
            // Only the property the reported type accounts for is considered described. A builder-authored
            // textarea that also carries an input type reports that input type as preserved rather than
            // pretending one word covered both.
            const known = ['label', 'placeholder', 'minLength', 'maxLength'];
            if (type === 'textarea' || field.format === 'standard') known.push('format');
            if (type === 'email' || type === 'phone' || type === 'url') known.push('inputType');
            return {
                type,
                properties: {
                    label: stringOrUndefined(field.label),
                    placeholder: stringOrUndefined(field.placeholder),
                    min_length: numberOrUndefined(field.minLength),
                    max_length: numberOrUndefined(field.maxLength)
                },
                preserved: preservedProperties(field, known),
                locked: []
            };
        }
        case 'hidden':
            return {
                type: 'hidden',
                properties: { label: stringOrUndefined(field.label) },
                preserved: preservedProperties(field, ['label']),
                locked: []
            };
        case 'number':
            return {
                type: 'number',
                properties: {
                    label: stringOrUndefined(field.label),
                    placeholder: stringOrUndefined(field.placeholder),
                    min: numberOrUndefined(field.min),
                    max: numberOrUndefined(field.max),
                    step: numberOrUndefined(field.step)
                },
                preserved: preservedProperties(field, ['label', 'placeholder', 'min', 'max', 'step']),
                locked: []
            };
        case 'date':
            return {
                type: 'date',
                properties: {
                    label: stringOrUndefined(field.label),
                    min: stringOrUndefined(field.min),
                    max: stringOrUndefined(field.max)
                },
                preserved: preservedProperties(field, ['label', 'min', 'max']),
                locked: []
            };
        case 'select': {
            const options = Array.isArray(field.options) ? field.options : [];
            const plain = options.every(option => typeof option === 'string');
            return {
                type: 'select',
                properties: {
                    label: stringOrUndefined(field.label),
                    options: plain ? (options as string[]) : options,
                    enable_other: field.enableOther === true
                },
                preserved: preservedProperties(field, ['label', 'options', 'enableOther']),
                locked: plain ? [] : ['options']
            };
        }
        case 'radio': {
            const options = Array.isArray(field.options) ? field.options : [];
            // `icon` and `description` have no word in this vocabulary, so replacing the option list would
            // silently drop them. Everything else about such a field stays editable.
            const simple = options.every(
                option =>
                    isRecord(option) &&
                    typeof option.title === 'string' &&
                    Object.keys(option).every(key => key === 'title' || key === 'value') &&
                    (option.value === undefined || typeof option.value === 'string')
            );
            return {
                type: 'radio',
                properties: {
                    label: stringOrUndefined(field.label),
                    options: simple
                        ? options.map(option => {
                              const entry = option as { title: string; value?: string };
                              return entry.value === undefined ? entry.title : { title: entry.title, value: entry.value };
                          })
                        : options
                },
                preserved: preservedProperties(field, ['label', 'options']),
                locked: simple ? [] : ['options']
            };
        }
        case 'checkbox':
            return {
                type: 'checkbox',
                properties: { label: stringOrUndefined(field.label) },
                preserved: preservedProperties(field, ['label']),
                locked: []
            };
        case 'contact': {
            const stored = isRecord(field.fields) ? field.fields : {};
            const enabled = Object.entries(stored).filter(([, value]) => value !== false && value !== undefined && value !== null);
            const parts = enabled.map(([name]) => CONTACT_PARTS_BY_NAME.get(name));
            // A part with per-part configuration (a custom label, an age window) or one this vocabulary
            // cannot name is unrepresentable as a flat list, so the list becomes read-only.
            const representable = parts.every(part => part !== undefined) && enabled.every(([, value]) => value === true);
            // Never the same key for two vocabularies: an unrepresentable selection reports the stored names
            // under a different property, so nothing reads `fields` expecting words `update_field` accepts.
            return {
                type: 'contact',
                properties: representable ? { fields: parts as ContactPart[] } : { storedFields: enabled.map(([name]) => name) },
                preserved: preservedProperties(field, ['fields']),
                locked: representable ? [] : ['fields']
            };
        }
        default:
            return undefined;
    }
}

/** The stored properties a description does not account for — everything an edit must leave alone. */
function preservedProperties(field: FormField, known: string[]): string[] {
    const accounted = new Set([...known, 'id', 'alias', 'type', 'optional']);
    return Object.keys(field)
        .filter(key => !accounted.has(key) && field[key] !== undefined)
        .sort();
}

function stringOrUndefined(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
