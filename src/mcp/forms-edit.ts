import { z } from 'zod';

import { FormDefinitionContent, FormField } from '../api/forms-client.js';
import { CliError } from '../errors.js';
import {
    BasicFieldInput,
    basicFieldSchema,
    buildBasicField,
    calendarDateSchema,
    contactPartName,
    contactPartsSchema,
    describeBasicField,
    fieldKeySchema,
    radioOptionsSchema,
    refineBasicField,
    UNSAFE_FORM_KEYS
} from './forms-fields.js';

/** Field types this vocabulary describes but never authors. Each one names the reason in `describeForm`. */
const ADVANCED_FIELD_TYPES: Record<string, string> = {
    section: 'a section, including any fields inside it',
    display: 'a static display block',
    review: 'a review summary of another field',
    signature: 'a signature',
    marketingOptOut: 'a marketing opt-out',
    emailCopy: 'an email-me-a-copy option'
};

const anchorShape = {
    before: z.string().trim().min(1).optional().describe('Insert immediately before this field key'),
    after: z.string().trim().min(1).optional().describe('Insert immediately after this field key'),
    page: z.number().int().positive().optional().describe('Append to this 1-based page; defaults to the last page')
};

export const formOperationSchema = z.discriminatedUnion('op', [
    z
        .object({
            op: z.literal('add_field'),
            field: basicFieldSchema,
            ...anchorShape
        })
        .strict(),
    z
        .object({
            op: z.literal('update_field'),
            key: z.string().trim().min(1).describe('The field key, or its UUID when it has no key'),
            new_key: fieldKeySchema.optional().describe('Rename the submission key; integrations using the old key break'),
            label: z.string().trim().min(1).max(255).optional(),
            required: z.boolean().optional(),
            placeholder: z.string().max(500).nullable().optional(),
            options: radioOptionsSchema.optional(),
            enable_other: z.boolean().optional(),
            min: z.union([z.number().finite(), calendarDateSchema()]).nullable().optional(),
            max: z.union([z.number().finite(), calendarDateSchema()]).nullable().optional(),
            step: z.number().positive().finite().nullable().optional(),
            min_length: z.number().int().nonnegative().nullable().optional(),
            max_length: z.number().int().nonnegative().nullable().optional(),
            fields: contactPartsSchema.optional().describe('Contact parts, replacing the current selection')
        })
        .strict(),
    z
        .object({
            op: z.literal('remove_field'),
            key: z.string().trim().min(1)
        })
        .strict(),
    z
        .object({
            op: z.literal('move_field'),
            key: z.string().trim().min(1),
            ...anchorShape
        })
        .strict()
]);

export type FormOperation = z.infer<typeof formOperationSchema>;

export interface FormContentEdits {
    title?: string;
    submitLabel?: string;
    successMessage?: string;
    operations?: FormOperation[];
}

export interface FormChange {
    change: 'added_field' | 'updated_field' | 'removed_field' | 'moved_field' | 'set_title' | 'set_submit_label' | 'set_success_message';
    key?: string;
    fieldId?: string;
    properties?: string[];
    removedKeys?: string[];
    position?: string;
    /** True when a move changes this field's submission from a scalar to an array, or back. */
    responseShapeChanged?: boolean;
}

export interface FormEditResult {
    content: FormDefinitionContent;
    changes: FormChange[];
    warnings: string[];
}

interface FieldLocation {
    field: FormField;
    container: FormField[];
    index: number;
    pageIndex: number;
    section?: FormField;
}

/**
 * Every addressable field, in document order, together with the array that actually holds it — an edit
 * mutates that array, so the walk deliberately yields the live nested arrays rather than copies.
 */
export function* walkFields(content: FormDefinitionContent): Generator<FieldLocation> {
    for (const [pageIndex, page] of content.pages.entries()) {
        const fields = page.fields;
        for (let index = 0; index < fields.length; index += 1) {
            const field = fields[index];
            if (!isFormField(field)) continue;
            yield { field, container: fields, index, pageIndex };
            if (field.type === 'section' && Array.isArray(field.fields)) {
                const children = field.fields as FormField[];
                for (let child = 0; child < children.length; child += 1) {
                    const subfield = children[child];
                    if (!isFormField(subfield)) continue;
                    yield { field: subfield, container: children, index: child, pageIndex, section: field };
                }
            }
        }
    }
}

/** The submission key a field answers to: its alias, unless that alias is one a bracket parser rejects. */
export function fieldKey(field: FormField): string {
    return field.alias && !UNSAFE_FORM_KEYS.has(field.alias) ? field.alias : field.id;
}

export function isFieldRequired(field: FormField): boolean {
    return !['hidden', 'marketingOptOut', 'emailCopy'].includes(field.type) && field.optional !== true;
}

export interface DescribedField extends Record<string, unknown> {
    key: string;
    fieldId: string;
    type: string;
    required: boolean;
    page: number;
    editable: boolean;
}

export interface FormStructure {
    pages: Array<{ page: number; fields: DescribedField[] }>;
    advanced: Array<{ construct: string; note: string; fields?: string[] }>;
    warnings: string[];
}

/** The authoring view of a stored definition: what these tools can change, and what they only preserve. */
export function describeFormContent(content: FormDefinitionContent): FormStructure {
    const pages: FormStructure['pages'] = content.pages.map((_, index) => ({ page: index + 1, fields: [] }));
    const advanced: FormStructure['advanced'] = [];
    const warnings: string[] = [];
    const advancedFields = new Map<string, string[]>();
    const conditional: string[] = [];

    for (const location of walkFields(content)) {
        const { field, pageIndex, section } = location;
        const key = fieldKey(field);
        const described = describeBasicField(field);
        const base: DescribedField = {
            key,
            fieldId: field.id,
            type: described?.type ?? field.type,
            required: isFieldRequired(field),
            page: pageIndex + 1,
            editable: described !== undefined,
            ...(section ? { section: { key: fieldKey(section), fieldId: section.id } } : {})
        };
        if (described) {
            for (const [name, value] of Object.entries(described.properties)) {
                if (value !== undefined) base[name] = value;
            }
            if (described.preserved.length) base.preservedProperties = described.preserved;
            if (described.locked.length) {
                base.lockedProperties = described.locked;
                base.lockedReason = 'Stored detail this vocabulary cannot express; edit these in the ZynoForms builder.';
            }
        } else {
            base.notEditableReason = `This field is ${ADVANCED_FIELD_TYPES[field.type] ?? `of the advanced type "${field.type}"`}; edit it in the ZynoForms builder.`;
            advancedFields.set(field.type, [...(advancedFields.get(field.type) ?? []), key]);
        }
        if (isRecord(field.condition)) conditional.push(key);
        if (!field.alias) warnings.push(`Field ${field.id} has no key; address it by that UUID.`);

        pages[pageIndex]?.fields.push(base);
    }

    for (const [type, keys] of advancedFields) {
        advanced.push({
            construct: type,
            note: `Preserved through edits. ${capitalize(ADVANCED_FIELD_TYPES[type] ?? `an advanced field of type "${type}"`)} cannot be created or changed here.`,
            fields: keys
        });
    }
    if (conditional.length) {
        advanced.push({
            construct: 'condition',
            note: 'These fields appear conditionally. Their rules are preserved, and a field a rule names cannot be renamed or removed here.',
            fields: conditional
        });
    }
    if (content.pages.some(page => isRecord(page.condition))) {
        advanced.push({ construct: 'pageCondition', note: 'At least one page appears conditionally. Preserved through edits.' });
    }
    if (content.pages.length > 1) {
        advanced.push({
            construct: 'multiPage',
            note: `This form has ${content.pages.length} pages. Target one with an anchor or the page argument.`
        });
    }
    for (const [property, note] of [
        ['theme', 'Custom theme or stylesheet. Preserved through edits.'],
        ['languages', 'Translations. Preserved through edits, and a new field is added untranslated.'],
        ['contact', 'CRM contact creation, matching, or tagging rules. Preserved through edits.'],
        ['exportTemplate', 'A custom export template. Preserved through edits.']
    ] as const) {
        if (content[property] !== undefined) advanced.push({ construct: property, note });
    }

    return { pages, advanced, warnings };
}

/**
 * Applies metadata and field operations to a copy of `content`.
 *
 * Operations run in order against the same working copy, so an operation sees what the ones before it did.
 * Only the JSON nodes an operation names are touched: everything this vocabulary cannot express — sections,
 * conditions, themes, translations, per-field styling — is carried through by construction rather than by
 * being rebuilt.
 */
export function applyFormEdits(content: FormDefinitionContent, edits: FormContentEdits): FormEditResult {
    const draft = structuredClone(content) as FormDefinitionContent;
    const changes: FormChange[] = [];
    const warnings: string[] = [];

    if (edits.title !== undefined) {
        draft.header = { ...(draft.header ?? {}), title: edits.title };
        changes.push({ change: 'set_title' });
    }
    if (edits.submitLabel !== undefined) {
        draft.submit = { ...(draft.submit ?? {}), title: edits.submitLabel };
        changes.push({ change: 'set_submit_label' });
    }
    if (edits.successMessage !== undefined) {
        if (isRecord(draft.submit?.successMessage)) {
            warnings.push('The success message was an expression that varied by response; it is now fixed text.');
        }
        draft.submit = { ...(draft.submit ?? {}), successMessage: edits.successMessage };
        changes.push({ change: 'set_success_message' });
    }

    for (const [index, operation] of (edits.operations ?? []).entries()) {
        try {
            applyOperation(draft, operation, changes, warnings);
        } catch (error) {
            if (error instanceof CliError) {
                throw new CliError(`Operation ${index + 1} (${operation.op}): ${error.message}`, error.exitCode, error.code, error.details);
            }
            throw error;
        }
    }

    draft.fieldIdsByAlias = buildFieldIdsByAlias(draft);
    return { content: draft, changes, warnings };
}

function applyOperation(content: FormDefinitionContent, operation: FormOperation, changes: FormChange[], warnings: string[]): void {
    switch (operation.op) {
        case 'add_field':
            return addField(content, operation, changes, warnings);
        case 'update_field':
            return updateField(content, operation, changes, warnings);
        case 'remove_field':
            return removeField(content, operation, changes);
        case 'move_field':
            return moveField(content, operation, changes, warnings);
    }
}

function addField(
    content: FormDefinitionContent,
    operation: Extract<FormOperation, { op: 'add_field' }>,
    changes: FormChange[],
    warnings: string[]
): void {
    const input: BasicFieldInput = operation.field;
    if (findLocation(content, input.key)) throw new CliError(`the key "${input.key}" is already used by another field`, 2, 'duplicate_field_key');
    if (input.type === 'contact') {
        const existing = [...walkFields(content)].find(location => location.field.type === 'contact');
        if (existing) {
            throw new CliError(
                `this form already has a contact field ("${fieldKey(existing.field)}"); a form supports one`,
                2,
                'duplicate_contact_field'
            );
        }
    }

    const field = buildBasicField(input);
    const target = resolveInsertion(content, operation);
    target.container.splice(target.index, 0, field);
    if (Array.isArray(content.languages) && content.languages.length) {
        warnings.push(`"${input.key}" was added to a translated form; it has no translations yet.`);
    }
    changes.push({ change: 'added_field', key: input.key, fieldId: field.id, position: target.description });
}

const PROPERTIES_BY_TYPE: Record<string, string[]> = {
    text: ['label', 'placeholder', 'min_length', 'max_length'],
    textarea: ['label', 'placeholder', 'min_length', 'max_length'],
    email: ['label', 'placeholder', 'min_length', 'max_length'],
    phone: ['label', 'placeholder', 'min_length', 'max_length'],
    url: ['label', 'placeholder', 'min_length', 'max_length'],
    hidden: ['label'],
    number: ['label', 'placeholder', 'min', 'max', 'step'],
    date: ['label', 'min', 'max'],
    select: ['label', 'options', 'enable_other'],
    radio: ['label', 'options'],
    checkbox: ['label'],
    contact: ['fields']
};

const CONSISTENCY_PROPERTIES = new Set(['min', 'max', 'min_length', 'max_length', 'options', 'fields']);

function updateField(
    content: FormDefinitionContent,
    operation: Extract<FormOperation, { op: 'update_field' }>,
    changes: FormChange[],
    warnings: string[]
): void {
    const location = requireLocation(content, operation.key);
    const { field } = location;
    const described = describeBasicField(field);
    if (!described) {
        throw new CliError(
            `"${operation.key}" is ${ADVANCED_FIELD_TYPES[field.type] ?? `of the advanced type "${field.type}"`} and can only be changed in the ZynoForms builder`,
            2,
            'unsupported_field_type'
        );
    }

    const { op: _op, key: _key, new_key: newKey, ...properties } = operation;
    const provided = Object.entries(properties).filter(([, value]) => value !== undefined);
    if (!provided.length && newKey === undefined) throw new CliError(`no change was requested for "${operation.key}"`, 2, 'empty_operation');

    const allowed = [...(PROPERTIES_BY_TYPE[described.type] ?? []), ...(described.type === 'hidden' ? [] : ['required'])];
    for (const [name] of provided) {
        if (allowed.includes(name)) continue;
        throw new CliError(
            `"${name}" does not apply to the ${described.type} field "${operation.key}"; it accepts ${allowed.join(', ')}`,
            2,
            'unsupported_field_change'
        );
    }
    const locked =
        (properties.options !== undefined && described.locked.includes('options')) ||
        (properties.fields !== undefined && described.locked.includes('fields'));
    if (locked) {
        throw new CliError(
            `"${operation.key}" holds detail this vocabulary cannot express (${described.locked.join(', ')}); change it in the ZynoForms builder`,
            2,
            'locked_field_property'
        );
    }

    if (properties.label !== undefined) field.label = properties.label;
    if (properties.required !== undefined) {
        if (properties.required) delete field.optional;
        else field.optional = true;
    }
    if (properties.placeholder !== undefined) assign(field, 'placeholder', properties.placeholder);
    if (properties.min !== undefined) assign(field, 'min', requireBound(described.type, 'min', properties.min));
    if (properties.max !== undefined) assign(field, 'max', requireBound(described.type, 'max', properties.max));
    if (properties.step !== undefined) assign(field, 'step', properties.step);
    if (properties.min_length !== undefined) assign(field, 'minLength', properties.min_length);
    if (properties.max_length !== undefined) assign(field, 'maxLength', properties.max_length);
    if (properties.enable_other !== undefined) assign(field, 'enableOther', properties.enable_other ? true : null);
    if (properties.options !== undefined) {
        if (described.type === 'select') {
            const plain = properties.options.map(option => {
                if (typeof option !== 'string') {
                    throw new CliError(`select options are plain strings; "${operation.key}" was given an option object`, 2, 'invalid_options');
                }
                return option;
            });
            field.options = plain;
        } else {
            field.options = properties.options.map(option => (typeof option === 'string' ? { title: option } : option));
        }
    }
    if (properties.fields !== undefined) {
        field.fields = Object.fromEntries(properties.fields.map(part => [contactPartName(part), true]));
    }

    if (provided.some(([name]) => CONSISTENCY_PROPERTIES.has(name))) {
        const problem = fieldConsistencyProblem(field);
        if (problem) throw new CliError(`"${operation.key}" would become inconsistent: ${problem}`, 2, 'invalid_field');
    }

    if (newKey !== undefined && newKey !== field.alias) {
        const clash = findLocation(content, newKey);
        if (clash && clash.field.id !== field.id)
            throw new CliError(`the key "${newKey}" is already used by another field`, 2, 'duplicate_field_key');
        const referenced = expressionReferences(content, field);
        if (referenced.length) {
            throw new CliError(
                `"${operation.key}" is named by ${referenced.length === 1 ? 'a rule' : 'rules'} on ${referenced.join(', ')}; rename it in the ZynoForms builder so those rules follow`,
                2,
                'field_referenced'
            );
        }
        warnings.push(`"${operation.key}" now submits as "${newKey}"; integrations posting the old key will fail validation.`);
        field.alias = newKey;
    }

    changes.push({
        change: 'updated_field',
        key: newKey ?? operation.key,
        fieldId: field.id,
        properties: [...provided.map(([name]) => name), ...(newKey === undefined ? [] : ['key'])]
    });
}

function removeField(content: FormDefinitionContent, operation: Extract<FormOperation, { op: 'remove_field' }>, changes: FormChange[]): void {
    const location = requireLocation(content, operation.key);
    const removed = [location.field, ...sectionChildren(location.field)];
    const removedIds = new Set(removed.map(field => field.id));

    for (const other of walkFields(content)) {
        if (removedIds.has(other.field.id)) continue;
        if (other.field.type === 'review') {
            const targets = [other.field.targetId, ...(Array.isArray(other.field.fieldsIds) ? (other.field.fieldsIds as string[]) : [])];
            if (targets.some(target => typeof target === 'string' && removedIds.has(target))) {
                throw new CliError(`"${operation.key}" is summarized by the review field "${fieldKey(other.field)}"`, 2, 'field_referenced');
            }
        }
    }
    for (const field of removed) {
        const referenced = expressionReferences(content, field, removedIds);
        if (referenced.length) {
            throw new CliError(
                `"${fieldKey(field)}" is named by ${referenced.length === 1 ? 'a rule' : 'rules'} on ${referenced.join(', ')}; remove those in the ZynoForms builder first`,
                2,
                'field_referenced'
            );
        }
    }

    location.container.splice(location.index, 1);
    changes.push({
        change: 'removed_field',
        key: operation.key,
        fieldId: location.field.id,
        ...(removed.length > 1 ? { removedKeys: removed.map(field => fieldKey(field)) } : {})
    });
}

function moveField(
    content: FormDefinitionContent,
    operation: Extract<FormOperation, { op: 'move_field' }>,
    changes: FormChange[],
    warnings: string[]
): void {
    const location = requireLocation(content, operation.key);
    // By resolved field, not by the string used to name it: a field can be anchored to itself by key on one
    // side and by UUID on the other, and that would splice it out and then fail to find its own anchor.
    const anchorKey = operation.before ?? operation.after;
    if (anchorKey !== undefined && findLocation(content, anchorKey)?.field.id === location.field.id) {
        throw new CliError(`"${operation.key}" cannot be positioned relative to itself`, 2, 'invalid_anchor');
    }

    location.container.splice(location.index, 1);
    let target: Insertion;
    try {
        target = resolveInsertion(content, operation);
    } catch (error) {
        location.container.splice(location.index, 0, location.field);
        throw error;
    }
    if (location.field.type === 'section' && target.section) {
        location.container.splice(location.index, 0, location.field);
        throw new CliError('a section cannot be moved inside another section', 2, 'invalid_anchor');
    }
    target.container.splice(target.index, 0, location.field);
    // A field inside a repeating section answers as an array; the same field outside one answers as a scalar.
    // Crossing that boundary rewrites the submission contract exactly as renaming its key would.
    const wasRepeated = isRepeating(location.section);
    const isRepeated = isRepeating(target.section);
    const responseShapeChanged = wasRepeated !== isRepeated;
    if (responseShapeChanged) {
        warnings.push(
            isRepeated
                ? `"${operation.key}" now sits in a repeating section, so it answers as an array of per-copy values; a single value still submits, as the first copy.`
                : `"${operation.key}" left a repeating section, so it answers as a single value; an integration posting an array will now fail validation.`
        );
    }
    // A review narrowed to specific fields keeps naming them by id, so a field that leaves the section the
    // review summarizes is quietly dropped from it — the definition stays valid, and nothing else notices.
    const reviewers = [...walkFields(content)]
        .filter(other => other.field.type === 'review' && Array.isArray(other.field.fieldsIds) && other.field.fieldsIds.includes(location.field.id))
        .map(other => fieldKey(other.field));
    if (reviewers.length && location.section?.id !== target.section?.id) {
        warnings.push(
            `"${operation.key}" is listed by the review ${reviewers.length === 1 ? 'field' : 'fields'} ${reviewers.join(', ')}; moving it out of what that review summarizes drops it from the summary shown before submission.`
        );
    }
    changes.push({
        change: 'moved_field',
        key: operation.key,
        fieldId: location.field.id,
        position: target.description,
        ...(responseShapeChanged ? { responseShapeChanged: true } : {})
    });
}

function isRepeating(section: FormField | undefined): boolean {
    return section !== undefined && section.repeat !== undefined;
}

interface Insertion {
    container: FormField[];
    index: number;
    section?: FormField;
    description: string;
}

function resolveInsertion(
    content: FormDefinitionContent,
    anchor: { before?: string | undefined; after?: string | undefined; page?: number | undefined }
): Insertion {
    if (anchor.before !== undefined && anchor.after !== undefined) {
        throw new CliError('provide either before or after, not both', 2, 'invalid_anchor');
    }
    const relative = anchor.before ?? anchor.after;
    if (relative !== undefined) {
        if (anchor.page !== undefined) throw new CliError('page cannot be combined with before or after', 2, 'invalid_anchor');
        const location = requireLocation(content, relative);
        return {
            container: location.container,
            index: anchor.before === undefined ? location.index + 1 : location.index,
            ...(location.section ? { section: location.section } : {}),
            description: `${anchor.before === undefined ? 'after' : 'before'} "${relative}"`
        };
    }

    const pageIndex = anchor.page === undefined ? content.pages.length - 1 : anchor.page - 1;
    const page = content.pages[pageIndex];
    if (!page) throw new CliError(`this form has ${content.pages.length} page(s); page ${anchor.page} does not exist`, 2, 'invalid_anchor');
    return { container: page.fields, index: page.fields.length, description: `at the end of page ${pageIndex + 1}` };
}

function findLocation(content: FormDefinitionContent, key: string): FieldLocation | undefined {
    for (const location of walkFields(content)) {
        if (location.field.alias === key || location.field.id === key) return location;
    }
    return undefined;
}

function requireLocation(content: FormDefinitionContent, key: string): FieldLocation {
    const location = findLocation(content, key);
    if (!location) throw new CliError(`no field has the key "${key}"`, 4, 'field_not_found');
    return location;
}

function sectionChildren(field: FormField): FormField[] {
    if (field.type !== 'section' || !Array.isArray(field.fields)) return [];
    return (field.fields as unknown[]).filter(isFormField);
}

/** The fields whose rules name `field`, so a rename or removal cannot quietly break them. */
function expressionReferences(content: FormDefinitionContent, field: FormField, ignoreIds?: Set<string>): string[] {
    const names = [field.id, ...(field.alias ? [field.alias] : [])];
    // Conditions are arbitrary JavaScript, so the optional-chaining spellings (`$?.name`, `$?.["name"]`)
    // count too. The trailing guard is a lookahead over identifier characters rather than `\b`: an alias may
    // end in `$`, which is not a word character, so a word boundary there could never match `$.price$`.
    const patterns = names.map(
        name => new RegExp(`\\$\\??(?:\\.${escapeRegExp(name)}(?![A-Za-z0-9_$])|\\.?\\[\\s*(['"])${escapeRegExp(name)}\\1\\s*\\])`)
    );
    const matches = (expression: unknown): boolean => {
        const source = isRecord(expression) && typeof expression.expr === 'string' ? expression.expr : undefined;
        return source !== undefined && patterns.some(pattern => pattern.test(source));
    };

    const holders: string[] = [];
    for (const [index, page] of content.pages.entries()) {
        if (matches(page.condition)) holders.push(`page ${index + 1}`);
    }
    for (const location of walkFields(content)) {
        if (location.field.id === field.id || ignoreIds?.has(location.field.id)) continue;
        if (matches(location.field.condition) || matches(location.field.title)) holders.push(`"${fieldKey(location.field)}"`);
    }
    if (matches(content.submit?.successMessage)) holders.push('the success message');
    return [...new Set(holders)];
}

/** Re-runs the shared single-field rules against the stored shape an edit has just produced. */
function fieldConsistencyProblem(field: FormField): string | undefined {
    const described = describeBasicField(field);
    if (!described) return undefined;
    const issues: string[] = [];
    const context = {
        addIssue: (issue: { message?: string }) => {
            if (issue.message) issues.push(issue.message);
        }
    } as unknown as z.RefinementCtx;
    const synthetic = { type: described.type, key: fieldKey(field), required: isFieldRequired(field), ...described.properties } as BasicFieldInput;
    refineBasicField(synthetic, context, []);
    return issues.length ? issues.join('; ') : undefined;
}

function requireBound(type: string, name: string, value: number | string | null): number | string | null {
    if (value === null) return null;
    if (type === 'date' && typeof value !== 'string') throw new CliError(`${name} for a date field is a YYYY-MM-DD string`, 2, 'invalid_field');
    if (type !== 'date' && typeof value !== 'number') throw new CliError(`${name} for a ${type} field is a number`, 2, 'invalid_field');
    return value;
}

function assign(field: FormField, property: string, value: unknown): void {
    if (value === null || value === undefined) delete field[property];
    else field[property] = value;
}

/** Mirrors the suite's own derivation so the content posted back already agrees with what it will store. */
function buildFieldIdsByAlias(content: FormDefinitionContent): Record<string, string> {
    const entries: Array<[string, string]> = [];
    for (const { field } of walkFields(content)) {
        if (field.alias !== undefined) entries.push([field.alias, field.id]);
    }
    return Object.fromEntries(entries);
}

function capitalize(value: string): string {
    return value.replace(/^./, first => first.toUpperCase());
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isFormField(value: unknown): value is FormField {
    return isRecord(value) && typeof value.id === 'string' && typeof value.type === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
