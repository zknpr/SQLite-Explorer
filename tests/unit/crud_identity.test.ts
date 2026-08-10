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
