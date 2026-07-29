import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormDefinitionContent } from '../src/api/forms-client.js';
import { applyFormEdits, describeFormContent, FormOperation } from '../src/mcp/forms-edit.js';
import { buildBasicFormDefinition } from '../src/mcp/forms.js';

const SECTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GUEST_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOTES_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REVIEW_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function basicForm(): FormDefinitionContent {
    return buildBasicFormDefinition({
        name: 'Contact us',
        submit_label: 'Send',
        success_message: 'Received!',
        notification_emails: [],
        origins: [],
        origin_sites: [],
        bot_protection: 'interactive',
        fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'email', label: 'Email', type: 'email', required: true },
            { key: 'message', label: 'Message', type: 'textarea', required: true, min_length: 10 },
            { key: 'amount', label: 'Amount', type: 'number', required: false, min: 0, max: 10, step: 0.5 },
            { key: 'day', label: 'Day', type: 'date', required: true, min: '2026-01-01' },
            { key: 'choice', label: 'Choice', type: 'select', required: true, options: ['One', 'Two'], enable_other: true },
            { key: 'department', label: 'Department', type: 'radio', required: true, options: ['Sales', { title: 'Help', value: 'support' }] },
            { key: 'terms', label: 'I agree', type: 'checkbox', required: true },
            { key: 'contact', type: 'contact', required: true, fields: ['first_name', 'last_name', 'email'] }
        ]
    });
}

/** A definition of the kind the SPA builder produces: sections, conditions, translations, and a theme. */
function advancedForm(): FormDefinitionContent {
    return {
        fieldIdsByAlias: { guestName: GUEST_ID, notes: NOTES_ID },
        theme: { name: 'midnight', stylesheet: '.zf { color: red }' },
        languages: [{ languageCode: 'es', overrides: { [GUEST_ID]: { label: 'Nombre' } } }],
        contact: { create: 'all', addTagIds: ['11111111-1111-4111-8111-111111111111'] },
        header: { title: 'Booking', titleAlign: 'center', logoUrl: 'https://example.com/logo.png' },
        submit: { title: 'Book', successMessage: { expr: '$.guestName' } },
        pages: [
            {
                fields: [
                    {
                        id: SECTION_ID,
                        type: 'section',
                        title: 'Guests',
                        repeat: { min: 1, max: 4 },
                        fields: [
                            { id: GUEST_ID, alias: 'guestName', type: 'text', label: 'Guest name', style: { width: '50%' } },
                            {
                                id: NOTES_ID,
                                alias: 'notes',
                                type: 'text',
                                label: 'Notes',
                                optional: true,
                                condition: { expr: '$.guestName !== ""' },
                                pattern: '[a-z ]+'
                            }
                        ]
                    },
                    { id: REVIEW_ID, type: 'review', targetId: SECTION_ID }
                ]
            },
            { fields: [], condition: { expr: '$.notes' } }
        ]
    } as FormDefinitionContent;
}

function keys(content: FormDefinitionContent): string[] {
    return describeFormContent(content)
        .pages.flatMap(page => page.fields)
        .map(field => field.key);
}

test('describes every basic field in the vocabulary that created it', () => {
    const described = describeFormContent(basicForm());
    assert.equal(described.pages.length, 1);
    const fields = described.pages[0]!.fields;

    assert.deepEqual(
        fields.map(field => field.type),
        ['text', 'email', 'textarea', 'number', 'date', 'select', 'radio', 'checkbox', 'contact']
    );
    assert(fields.every(field => field.editable && field.page === 1));
    assert.deepEqual(
        fields.map(field => field.required),
        [true, true, true, false, true, true, true, true, true]
    );
    assert.equal(fields[2]!.min_length, 10);
    assert.deepEqual({ min: fields[3]!.min, max: fields[3]!.max, step: fields[3]!.step }, { min: 0, max: 10, step: 0.5 });
    assert.equal(fields[4]!.min, '2026-01-01');
    assert.deepEqual(fields[5]!.options, ['One', 'Two']);
    assert.equal(fields[5]!.enable_other, true);
    assert.deepEqual(fields[6]!.options, ['Sales', { title: 'Help', value: 'support' }]);
    assert.deepEqual(fields[8]!.fields, ['first_name', 'last_name', 'email']);
    assert.deepEqual(described.advanced, []);
    assert.deepEqual(described.warnings, []);
});

test('describes advanced content as preserved and not editable', () => {
    const described = describeFormContent(advancedForm());
    const fields = described.pages.flatMap(page => page.fields);
    const byKey = new Map(fields.map(field => [field.key, field]));

    assert.equal(byKey.get(SECTION_ID)!.editable, false);
    assert.match(String(byKey.get(SECTION_ID)!.notEditableReason), /ZynoForms builder/);
    assert.equal(byKey.get(REVIEW_ID)!.editable, false);
    assert.equal(byKey.get('guestName')!.editable, true);
    assert.deepEqual(byKey.get('guestName')!.section, { key: SECTION_ID, fieldId: SECTION_ID });
    assert.deepEqual(byKey.get('guestName')!.preservedProperties, ['style']);
    assert.deepEqual(byKey.get('notes')!.preservedProperties, ['condition', 'pattern']);
    assert.equal(byKey.get('notes')!.required, false);

    const constructs = described.advanced.map(entry => entry.construct);
    assert.deepEqual(constructs.sort(), ['condition', 'contact', 'languages', 'multiPage', 'pageCondition', 'review', 'section', 'theme'].sort());
    assert.deepEqual(described.warnings, [
        `Field ${SECTION_ID} has no key; address it by that UUID.`,
        `Field ${REVIEW_ID} has no key; address it by that UUID.`
    ]);
});

test('adds, updates, moves, and removes fields addressed by key', () => {
    const before = basicForm();
    const { content, changes } = applyFormEdits(before, {
        title: 'Talk to us',
        submitLabel: 'Send it',
        operations: [
            { op: 'add_field', after: 'email', field: { key: 'budget', label: 'Budget', type: 'number', required: false, min: 0 } },
            { op: 'update_field', key: 'message', label: 'How can we help?', required: false, min_length: 5 },
            { op: 'move_field', key: 'terms', before: 'name' },
            { op: 'remove_field', key: 'day' }
        ] as FormOperation[]
    });

    assert.deepEqual(keys(content), ['terms', 'name', 'email', 'budget', 'message', 'amount', 'choice', 'department', 'contact']);
    assert.equal(content.header?.title, 'Talk to us');
    assert.equal(content.submit?.title, 'Send it');
    assert.equal(content.submit?.successMessage, 'Received!');

    const described = describeFormContent(content).pages[0]!.fields;
    const message = described.find(field => field.key === 'message')!;
    assert.equal(message.label, 'How can we help?');
    assert.equal(message.required, false);
    assert.equal(message.min_length, 5);
    assert.equal(message.type, 'textarea', 'an update must not disturb the stored format');

    const budget = described.find(field => field.key === 'budget')!;
    assert.match(String(budget.fieldId), /^[0-9a-f-]{36}$/);
    assert.equal(budget.required, false);
    assert.equal(content.fieldIdsByAlias!.budget, budget.fieldId);

    assert.deepEqual(
        changes.map(change => change.change),
        ['set_title', 'set_submit_label', 'added_field', 'updated_field', 'moved_field', 'removed_field']
    );
});

test('leaves the base definition untouched and keeps the ids of fields it did not name', () => {
    const before = basicForm();
    const snapshot = JSON.stringify(before);
    const { content } = applyFormEdits(before, { operations: [{ op: 'update_field', key: 'name', label: 'Full name' }] });

    assert.equal(JSON.stringify(before), snapshot);
    const idsBefore = before.pages[0]!.fields.map(field => field.id);
    const idsAfter = content.pages[0]!.fields.map(field => field.id);
    assert.deepEqual(idsAfter, idsBefore);
});

test('carries advanced content through an edit byte for byte', () => {
    const before = advancedForm();
    const { content, warnings } = applyFormEdits(before, {
        operations: [
            { op: 'add_field', after: 'guestName', field: { key: 'guestAge', label: 'Age', type: 'number', required: false } },
            { op: 'update_field', key: 'notes', label: 'Special requests' }
        ] as FormOperation[]
    });

    assert.deepEqual(content.theme, before.theme);
    assert.deepEqual(content.languages, before.languages);
    assert.deepEqual(content.contact, before.contact);
    assert.deepEqual(content.header, before.header);
    assert.deepEqual(content.submit, before.submit);
    assert.deepEqual(content.pages[1], before.pages[1]);

    const section = content.pages[0]!.fields[0]!;
    assert.deepEqual(section.repeat, { min: 1, max: 4 });
    const children = section.fields as Array<Record<string, unknown>>;
    assert.deepEqual(
        children.map(child => child.alias),
        ['guestName', 'guestAge', 'notes'],
        'an anchor inside a section inserts into that section'
    );
    assert.deepEqual(children[0]!.style, { width: '50%' });
    assert.equal(children[2]!.label, 'Special requests');
    assert.deepEqual(children[2]!.condition, { expr: '$.guestName !== ""' });
    assert.equal(children[2]!.pattern, '[a-z ]+');
    assert.deepEqual(content.fieldIdsByAlias, { guestName: GUEST_ID, guestAge: children[1]!.id, notes: NOTES_ID });
    assert(warnings.some(warning => /translated form/.test(warning)));
});

test('refuses edits that would break the form or lose stored detail', () => {
    const basic = basicForm();
    const advanced = advancedForm();
    const reject = (content: FormDefinitionContent, operation: unknown, pattern: RegExp) =>
        assert.throws(() => applyFormEdits(content, { operations: [operation as FormOperation] }), pattern);

    reject(basic, { op: 'update_field', key: 'nope', label: 'x' }, /no field has the key "nope"/);
    reject(basic, { op: 'update_field', key: 'name', options: ['a'] }, /does not apply to the text field/);
    reject(basic, { op: 'update_field', key: 'amount', min: 20 }, /min cannot exceed max/);
    reject(basic, { op: 'update_field', key: 'choice', options: ['One', 'One'] }, /options must be unique/);
    reject(basic, { op: 'update_field', key: 'name', new_key: 'email' }, /already used by another field/);
    reject(basic, { op: 'add_field', field: { key: 'email', label: 'Email', type: 'email', required: true } }, /already used by another field/);
    reject(basic, { op: 'add_field', field: { key: 'who', type: 'contact', required: true, fields: ['email'] } }, /already has a contact field/);
    reject(basic, { op: 'add_field', field: { key: 'x', label: 'X', type: 'text', required: true }, page: 4 }, /page 4 does not exist/);
    reject(basic, { op: 'move_field', key: 'name', before: 'name' }, /relative to itself/);
    reject(advanced, { op: 'update_field', key: SECTION_ID, label: 'Guests' }, /section.*ZynoForms builder/);
    reject(advanced, { op: 'remove_field', key: 'notes' }, /named by a rule on page 2/);
    reject(advanced, { op: 'remove_field', key: SECTION_ID }, /summarized by the review field/);
    reject(advanced, { op: 'update_field', key: 'guestName', new_key: 'guest' }, /named by rules on "notes"/);

    // A date bound is a calendar string and a number bound is a number; neither substitutes for the other.
    reject(basic, { op: 'update_field', key: 'day', min: 3 }, /YYYY-MM-DD/);
    reject(basic, { op: 'update_field', key: 'amount', min: '2026-01-01' }, /is a number/);
});

test('reports a locked field rather than flattening detail the vocabulary cannot express', () => {
    const content = basicForm();
    content.pages[0]!.fields[6]!.options = [
        { title: 'Sales', icon: 'phone' },
        { title: 'Help', value: 'support' }
    ];
    content.pages[0]!.fields[8]!.fields = { firstName: true, birthdate: { minAge: 18 } };

    const described = describeFormContent(content).pages[0]!.fields;
    assert.deepEqual(described[6]!.lockedProperties, ['options']);
    assert.deepEqual(described[8]!.lockedProperties, ['fields']);
    assert.equal(described[6]!.editable, true, 'the rest of a locked field stays editable');

    assert.throws(
        () => applyFormEdits(content, { operations: [{ op: 'update_field', key: 'department', options: ['Sales'] }] }),
        /cannot express \(options\)/
    );
    assert.throws(
        () => applyFormEdits(content, { operations: [{ op: 'update_field', key: 'contact', fields: ['email'] }] }),
        /cannot express \(fields\)/
    );
    const { content: relabeled } = applyFormEdits(content, { operations: [{ op: 'update_field', key: 'department', label: 'Team' }] });
    assert.equal(relabeled.pages[0]!.fields[6]!.label, 'Team');
    assert.deepEqual(relabeled.pages[0]!.fields[6]!.options, content.pages[0]!.fields[6]!.options);
});

test('removes a section together with its fields and reports every key it took', () => {
    const content = advancedForm();
    content.pages[0]!.fields.pop();
    (content.pages[0]!.fields[0]!.fields as Array<Record<string, unknown>>)[1]!.condition = undefined;
    content.pages[1] = { fields: [] };
    content.submit = { title: 'Book', successMessage: 'Done' };

    const { content: edited, changes } = applyFormEdits(content, { operations: [{ op: 'remove_field', key: SECTION_ID }] });
    assert.deepEqual(edited.pages[0]!.fields, []);
    assert.deepEqual(changes[0]!.removedKeys, [SECTION_ID, 'guestName', 'notes']);
    assert.deepEqual(edited.fieldIdsByAlias, {});
});

test('rebuilds the alias map without reporting a change when nothing was edited', () => {
    const content = basicForm();
    delete content.fieldIdsByAlias;
    const { content: rebuilt, changes } = applyFormEdits(content, {});

    assert.deepEqual(changes, []);
    assert.equal(Object.keys(rebuilt.fieldIdsByAlias!).length, 9);
    assert.equal(JSON.stringify(applyFormEdits(rebuilt, {}).content), JSON.stringify(rebuilt), 'a second pass is a no-op');
});

test('renames a submission key only when no rule names the field', () => {
    const { content, warnings, changes } = applyFormEdits(basicForm(), {
        operations: [{ op: 'update_field', key: 'email', new_key: 'emailAddress' }]
    });

    const field = content.pages[0]!.fields[1]!;
    assert.equal(field.alias, 'emailAddress');
    assert.equal(content.fieldIdsByAlias!.emailAddress, field.id);
    assert.equal(content.fieldIdsByAlias!.email, undefined);
    assert.deepEqual(changes[0]!.properties, ['key']);
    assert(warnings.some(warning => /integrations posting the old key will fail/.test(warning)));
});

test('warns when a move changes whether a field submits as an array', () => {
    const content = advancedForm();
    content.pages[0]!.fields.pop();
    (content.pages[0]!.fields[0]!.fields as Array<Record<string, unknown>>)[1]!.condition = undefined;
    content.pages[1] = { fields: [{ id: '11111111-2222-4333-8444-555555555555', alias: 'email', type: 'text', label: 'Email' }] };
    content.submit = { title: 'Book', successMessage: 'Done' };

    // Into a repeat, a scalar still submits as the first copy — `normalizeResponses` only splits arrays.
    const into = applyFormEdits(content, { operations: [{ op: 'move_field', key: 'email', after: 'guestName' }] });
    assert(
        into.warnings.some(warning => /array of per-copy values/.test(warning)),
        into.warnings.join('; ')
    );
    assert(into.warnings.some(warning => /single value still submits/.test(warning)));
    assert.equal(into.changes[0]!.responseShapeChanged, true, 'callers can reliably detect the contract change without parsing warning text');

    // Out of one, an array is handed to the field whole rather than split, and validation rejects it.
    const outOf = applyFormEdits(into.content, { operations: [{ op: 'move_field', key: 'email', page: 2 }] });
    assert(
        outOf.warnings.some(warning => /posting an array will now fail validation/.test(warning)),
        outOf.warnings.join('; ')
    );
    assert.equal(outOf.changes[0]!.responseShapeChanged, true);

    // A move within the same repeating section changes no contract and must stay quiet.
    const within = applyFormEdits(into.content, { operations: [{ op: 'move_field', key: 'email', before: 'guestName' }] });
    assert.deepEqual(within.warnings, []);
    assert.equal(within.changes[0]!.responseShapeChanged, undefined);
});

test('recognizes a field anchored to itself by UUID rather than by key', () => {
    const content = basicForm();
    const emailId = content.pages[0]!.fields[1]!.id;

    assert.throws(
        () => applyFormEdits(content, { operations: [{ op: 'move_field', key: 'email', after: emailId }] }),
        /cannot be positioned relative to itself/,
        'the two spellings name one field, and the field must survive the attempt'
    );
    assert.deepEqual(keys(applyFormEdits(content, {}).content), keys(content));
});

test('protects a field whose alias ends in $ from a rule that names it', () => {
    const content = basicForm();
    const price = content.pages[0]!.fields[3]!;
    price.alias = 'price$';
    content.fieldIdsByAlias = { ...content.fieldIdsByAlias, price$: price.id };
    content.pages[0]!.fields[2]!.condition = { expr: '$.price$ > 0' };

    // `\b` after an escaped name cannot match when the name ends in `$`, which is not a word character.
    assert.throws(() => applyFormEdits(content, { operations: [{ op: 'remove_field', key: 'price$' }] }), /named by a rule/);
    assert.throws(() => applyFormEdits(content, { operations: [{ op: 'update_field', key: 'price$', new_key: 'cost' }] }), /named by a rule/);

    // A different field whose name merely starts the same must not be caught by the same rule.
    const other = applyFormEdits(content, { operations: [{ op: 'update_field', key: 'name', new_key: 'fullName' }] });
    assert.equal(other.content.pages[0]!.fields[0]!.alias, 'fullName');
});

test('recognizes every spelling a condition can use to name a field', () => {
    const spellings = ['$.email !== ""', '$?.email !== ""', '$["email"]', '$?.["email"]'];
    for (const expr of spellings) {
        const content = basicForm();
        content.pages[0]!.fields[0]!.condition = { expr };
        assert.throws(
            () => applyFormEdits(content, { operations: [{ op: 'remove_field', key: 'email' }] }),
            /named by a rule/,
            `conditions are arbitrary JavaScript, and ${expr} names the field`
        );
    }

    // A longer alias that merely starts with the same characters is a different field.
    const unrelated = basicForm();
    unrelated.pages[0]!.fields[0]!.condition = { expr: '$.emailAddress !== ""' };
    assert.doesNotThrow(() => applyFormEdits(unrelated, { operations: [{ op: 'remove_field', key: 'email' }] }));
});
