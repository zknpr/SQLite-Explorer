import './vscode_mock_setup';

import assert from 'node:assert';
import { it } from 'node:test';

const stateModulePath = '../../core/ui/modules/state.js';
const apiModulePath = '../../core/ui/modules/api.js';
const crudModulePath = '../../core/ui/modules/crud.js';

(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState() {},
    postMessage() {}
});

function createElement(tagName = 'div'): any {
    const classes = new Set<string>();
    return {
        tagName: tagName.toUpperCase(),
        children: [] as any[],
        dataset: {} as Record<string, string>,
        style: {} as Record<string, string>,
        value: '',
        disabled: false,
        textContent: '',
        classList: {
            add: (...names: string[]) => names.forEach(name => classes.add(name)),
            remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
            contains: (name: string) => classes.has(name)
        },
        appendChild(child: any) {
            this.children.push(child);
            return child;
        },
        replaceChildren(...children: any[]) {
            this.children = children;
        },
        querySelector() { return null; },
        focus() {}
    };
}

it('submits an add-row insert with a defaulted WITHOUT ROWID PK omitted', async () => {
    const form = createElement('form');
    const modal = createElement();
    const status = createElement();
    const elements: Record<string, any> = {
        addRowForm: form,
        addRowModal: modal,
        statusText: status
    };
    const allInputs = () => form.children.flatMap((field: any) => field.children)
        .filter((child: any) => child.tagName === 'INPUT');
    (globalThis as any).document = {
        createElement,
        createTextNode: (text: string) => ({ textContent: text }),
        getElementById: (id: string) => elements[id] ?? null,
        querySelectorAll: () => allInputs().filter((input: any) => !input.disabled)
    };

    const [{ state }, { backendApi }, { openAddRowModal, submitAddRow }] = await Promise.all([
        import(stateModulePath),
        import(apiModulePath),
        import(crudModulePath)
    ]);
    const originalInsertRow = backendApi.insertRow;
    state.selectedTable = 'generated_ids';
    state.selectedTableType = 'table';
    state.selectedTableIdentity = {
        kind: 'primaryKey',
        columns: [{ identifier: 'id', declaredType: 'BLOB', position: 1 }]
    };
    state.tableColumns = [
        {
            name: 'id',
            type: 'BLOB',
            notnull: 1,
            dflt_value: 'randomblob(16)',
            isPrimaryKey: true
        },
        {
            name: 'value',
            type: 'TEXT',
            notnull: 1,
            dflt_value: null,
            isPrimaryKey: false
        }
    ];
    const insertCalls: Array<{ table: string; data: Record<string, unknown> }> = [];
    backendApi.insertRow = async (table: string, data: Record<string, unknown>) => {
        insertCalls.push({ table, data });
        // Avoid an unrelated grid reload after proving the submitted payload.
        state.selectedTable = null;
        return 'generated-id';
    };

    try {
        openAddRowModal();
        const inputs = allInputs();
        const idInput = inputs.find((input: any) => input.dataset.column === 'id');
        const valueInput = inputs.find((input: any) => input.dataset.column === 'value');
        assert.ok(idInput);
        assert.ok(valueInput);
        assert.strictEqual(idInput.dataset.required, 'false');
        valueInput.value = 'payload';

        await submitAddRow();

        assert.deepStrictEqual(insertCalls, [{
            table: 'generated_ids',
            data: { value: 'payload' }
        }]);
    } finally {
        backendApi.insertRow = originalInsertRow;
        state.selectedTable = null;
        state.selectedTableIdentity = null;
        state.tableColumns = [];
        delete (globalThis as any).document;
    }
});

it('excludes generated columns from Add Row payloads', async () => {
    const form = createElement('form');
    const modal = createElement();
    const status = createElement();
    const elements: Record<string, any> = { addRowForm: form, addRowModal: modal, statusText: status };
    const allInputs = () => form.children.flatMap((field: any) => field.children)
        .filter((child: any) => child.tagName === 'INPUT');
    (globalThis as any).document = {
        createElement,
        createTextNode: (text: string) => ({ textContent: text }),
        getElementById: (id: string) => elements[id] ?? null,
        querySelectorAll: () => allInputs().filter((input: any) => !input.disabled)
    };
    const [{ state }, { backendApi }, { openAddRowModal, submitAddRow }] = await Promise.all([
        import(stateModulePath), import(apiModulePath), import(crudModulePath)
    ]);
    const originalInsertRow = backendApi.insertRow;
    state.selectedTable = 'generated_values';
    state.selectedTableType = 'table';
    state.selectedTableIdentity = { kind: 'rowid' };
    state.tableColumns = [
        { name: 'base', type: 'INTEGER', notnull: 1, dflt_value: null, isPrimaryKey: false },
        {
            name: 'computed', type: 'INTEGER', notnull: 0, dflt_value: null,
            isPrimaryKey: false, isGenerated: true
        }
    ];
    let submitted: Record<string, unknown> | undefined;
    backendApi.insertRow = async (_table: string, data: Record<string, unknown>) => {
        submitted = data;
        state.selectedTable = null;
        return 1;
    };

    try {
        openAddRowModal();
        const base = allInputs().find((input: any) => input.dataset.column === 'base');
        const generated = allInputs().find((input: any) => input.dataset.column === 'computed');
        assert.strictEqual(generated.disabled, true);
        assert.match(generated.placeholder, /generated/i);
        base.value = '7';
        base.oninput();

        await submitAddRow();
        assert.deepStrictEqual(submitted, { base: 7 });
    } finally {
        backendApi.insertRow = originalInsertRow;
        state.selectedTable = null;
        state.selectedTableIdentity = null;
        state.tableColumns = [];
        delete (globalThis as any).document;
    }
});

it('preserves exact Add Row text and distinguishes default, empty string, and SQL NULL', async () => {
    const form = createElement('form');
    const modal = createElement();
    const status = createElement();
    const elements: Record<string, any> = { addRowForm: form, addRowModal: modal, statusText: status };
    const allInputs = () => form.children.flatMap((field: any) => field.children)
        .filter((child: any) => child.tagName === 'INPUT');
    (globalThis as any).document = {
        createElement,
        createTextNode: (text: string) => ({ textContent: text }),
        getElementById: (id: string) => elements[id] ?? null,
        querySelectorAll: () => allInputs().filter((input: any) => !input.disabled)
    };
    const [{ state }, { backendApi }, { openAddRowModal, submitAddRow }] = await Promise.all([
        import(stateModulePath), import(apiModulePath), import(crudModulePath)
    ]);
    const originalInsertRow = backendApi.insertRow;
    state.selectedTable = 'exact_values';
    state.selectedTableType = 'table';
    state.selectedTableIdentity = { kind: 'rowid' };
    state.tableColumns = [
        {
            name: 'id', type: 'INTEGER', isPrimaryKey: true, isRowidAlias: true,
            notnull: 0, dflt_value: null
        },
        { name: 'with_default', type: 'TEXT', isPrimaryKey: false, notnull: 1, dflt_value: "'x'" },
        { name: 'literal_null', type: 'TEXT', isPrimaryKey: false, notnull: 0, dflt_value: null },
        { name: 'spaced', type: 'TEXT', isPrimaryKey: false, notnull: 0, dflt_value: null },
        { name: 'empty_value', type: 'TEXT', isPrimaryKey: false, notnull: 0, dflt_value: null },
        { name: 'null_value', type: 'TEXT', isPrimaryKey: false, notnull: 0, dflt_value: null },
        { name: '__proto__', type: 'TEXT', isPrimaryKey: false, notnull: 0, dflt_value: null }
    ];
    let submitted: Record<string, unknown> | undefined;
    backendApi.insertRow = async (_table: string, data: Record<string, unknown>) => {
        submitted = data;
        state.selectedTable = null;
        return 1;
    };

    try {
        openAddRowModal();
        const byName = (name: string) => allInputs().find((input: any) => input.dataset.column === name);
        const setValue = (name: string, value: string) => {
            const input = byName(name);
            input.value = value;
            input.oninput();
        };
        assert.strictEqual(byName('id').disabled, true);
        assert.strictEqual(byName('with_default').dataset.required, 'false');
        setValue('literal_null', 'NuLl');
        setValue('spaced', '  keep me  ');
        setValue('__proto__', 'safe own value');

        const emptyField = form.children.find(
            (field: any) => field.children.some((child: any) => child.dataset?.column === 'empty_value')
        );
        const emptyAction = emptyField.children.find((child: any) => child.className === 'add-row-value-actions');
        emptyAction.children.find((button: any) => button.className.includes('btn-add-row-empty')).onclick();
        const nullField = form.children.find(
            (field: any) => field.children.some((child: any) => child.dataset?.column === 'null_value')
        );
        const nullAction = nullField.children.find((child: any) => child.className === 'add-row-value-actions');
        nullAction.children.find((button: any) => button.className.includes('btn-add-row-null')).onclick();

        await submitAddRow();

        assert.ok(submitted);
        assert.strictEqual(Object.hasOwn(submitted, 'with_default'), false);
        assert.strictEqual(submitted.literal_null, 'NuLl');
        assert.strictEqual(submitted.spaced, '  keep me  ');
        assert.strictEqual(submitted.empty_value, '');
        assert.strictEqual(submitted.null_value, null);
        assert.strictEqual(Object.hasOwn(submitted, '__proto__'), true);
        assert.strictEqual(submitted.__proto__, 'safe own value');
        assert.strictEqual(Object.getPrototypeOf(submitted), Object.prototype);
    } finally {
        backendApi.insertRow = originalInsertRow;
        state.selectedTable = null;
        state.selectedTableIdentity = null;
        state.tableColumns = [];
        delete (globalThis as any).document;
    }
});

it('keeps nullable primary-key members editable on ordinary rowid tables', async () => {
    const form = createElement('form');
    const modal = createElement();
    const status = createElement();
    const elements: Record<string, any> = { addRowForm: form, addRowModal: modal, statusText: status };
    const allInputs = () => form.children.flatMap((field: any) => field.children)
        .filter((child: any) => child.tagName === 'INPUT');
    (globalThis as any).document = {
        createElement,
        createTextNode: (text: string) => ({ textContent: text }),
        getElementById: (id: string) => elements[id] ?? null,
        querySelectorAll: () => allInputs().filter((input: any) => !input.disabled)
    };
    const [{ state }, { backendApi }, { openAddRowModal, submitAddRow }] = await Promise.all([
        import(stateModulePath), import(apiModulePath), import(crudModulePath)
    ]);
    const originalInsertRow = backendApi.insertRow;
    state.selectedTable = 'ordinary_composite_pk';
    state.selectedTableType = 'table';
    state.selectedTableIdentity = { kind: 'rowid' };
    state.tableColumns = [
        { name: 'tenant', type: 'TEXT', isPrimaryKey: true, notnull: 0, dflt_value: null },
        { name: 'sequence', type: 'INT', isPrimaryKey: true, notnull: 0, dflt_value: null },
        { name: 'payload', type: 'TEXT', isPrimaryKey: false, notnull: 0, dflt_value: null }
    ];
    let submitted: Record<string, unknown> | undefined;
    backendApi.insertRow = async (_table: string, data: Record<string, unknown>) => {
        submitted = data;
        state.selectedTable = null;
        return 1;
    };

    try {
        openAddRowModal();
        const byName = (name: string) => allInputs().find((input: any) => input.dataset.column === name);
        assert.strictEqual(byName('tenant').disabled, false);
        assert.strictEqual(byName('sequence').disabled, false);
        assert.strictEqual(byName('tenant').dataset.required, 'false');
        assert.strictEqual(byName('sequence').dataset.required, 'false');

        byName('tenant').value = 'north';
        byName('tenant').oninput();
        byName('sequence').value = '9007199254740993';
        byName('sequence').oninput();
        await submitAddRow();

        assert.deepStrictEqual(submitted, {
            tenant: 'north',
            sequence: '9007199254740993'
        });
    } finally {
        backendApi.insertRow = originalInsertRow;
        state.selectedTable = null;
        state.selectedTableIdentity = null;
        state.tableColumns = [];
        delete (globalThis as any).document;
    }
});

it('allows an omitted INTEGER PRIMARY KEY DESC because SQLite permits its NULL key', async () => {
    const form = createElement('form');
    const status = createElement();
    const elements: Record<string, any> = {
        addRowForm: form,
        addRowModal: createElement(),
        statusText: status
    };
    const allInputs = () => form.children.flatMap((field: any) => field.children)
        .filter((child: any) => child.tagName === 'INPUT');
    (globalThis as any).document = {
        createElement,
        createTextNode: (text: string) => ({ textContent: text }),
        getElementById: (id: string) => elements[id] ?? null,
        querySelectorAll: () => allInputs().filter((input: any) => !input.disabled)
    };
    const [{ state }, { backendApi }, { openAddRowModal, submitAddRow }] = await Promise.all([
        import(stateModulePath), import(apiModulePath), import(crudModulePath)
    ]);
    const originalInsertRow = backendApi.insertRow;
    state.selectedTable = 'descending_pk';
    state.selectedTableType = 'table';
    state.selectedTableIdentity = { kind: 'rowid' };
    state.tableColumns = [
        {
            name: 'id', type: 'INTEGER', isPrimaryKey: true, isRowidAlias: false,
            notnull: 0, dflt_value: null
        },
        { name: 'value', type: 'TEXT', isPrimaryKey: false, notnull: 0, dflt_value: null }
    ];
    let submitted: Record<string, unknown> | undefined;
    backendApi.insertRow = async (_table: string, data: Record<string, unknown>) => {
        submitted = data;
        state.selectedTable = null;
        return 1;
    };

    try {
        openAddRowModal();
        const id = allInputs().find((input: any) => input.dataset.column === 'id');
        assert.strictEqual(id.disabled, false);
        assert.strictEqual(id.dataset.required, 'false');

        await submitAddRow();
        assert.deepStrictEqual(submitted, {});
    } finally {
        backendApi.insertRow = originalInsertRow;
        state.selectedTable = null;
        state.selectedTableIdentity = null;
        state.tableColumns = [];
        delete (globalThis as any).document;
    }
});

it('rejects an Add Row draft after its table target changes', async () => {
    const form = createElement('form');
    const status = createElement();
    (globalThis as any).document = {
        createElement,
        createTextNode: (text: string) => ({ textContent: text }),
        getElementById(id: string) {
            if (id === 'addRowForm') return form;
            if (id === 'addRowModal') return createElement();
            if (id === 'statusText') return status;
            return null;
        },
        querySelectorAll() { return []; }
    };
    const [{ state }, { backendApi }, { openAddRowModal, submitAddRow }] = await Promise.all([
        import(stateModulePath), import(apiModulePath), import(crudModulePath)
    ]);
    const originalInsertRow = backendApi.insertRow;
    let inserts = 0;
    backendApi.insertRow = async () => { inserts++; };
    state.selectedTable = 'table_a';
    state.selectedTableType = 'table';
    state.selectedTableIdentity = { kind: 'rowid' };
    state.tableColumns = [{ name: 'body', type: 'TEXT', notnull: 0, dflt_value: null }];

    try {
        openAddRowModal();
        state.selectedTable = 'table_b';
        await submitAddRow();
        assert.strictEqual(inserts, 0);
        assert.match(status.textContent, /target changed.*reopen/i);
    } finally {
        backendApi.insertRow = originalInsertRow;
        state.selectedTable = null;
        state.selectedTableIdentity = null;
        state.tableColumns = [];
        delete (globalThis as any).document;
    }
});
