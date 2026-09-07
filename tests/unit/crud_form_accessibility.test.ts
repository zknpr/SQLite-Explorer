import './vscode_mock_setup';

import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState() {},
    postMessage() {}
});

const stateModulePath = '../../core/ui/modules/state.js';
const crudModulePath = '../../core/ui/modules/crud.js';

function makeClassList(initial: string[] = []) {
    const classes = new Set(initial);
    return {
        add(...names: string[]) { names.forEach(name => classes.add(name)); },
        remove(...names: string[]) { names.forEach(name => classes.delete(name)); },
        contains(name: string) { return classes.has(name); }
    };
}

function makeNode(tagName = 'div'): any {
    return {
        tagName: tagName.toUpperCase(),
        children: [] as any[],
        dataset: {} as Record<string, string>,
        style: {} as Record<string, string>,
        className: '',
        id: '',
        htmlFor: '',
        ariaLabel: '',
        textContent: '',
        type: '',
        value: '',
        placeholder: '',
        disabled: false,
        classList: makeClassList(),
        appendChild(child: any) {
            this.children.push(child);
            return child;
        },
        replaceChildren(...children: any[]) {
            this.children = [...children];
        },
        querySelector() { return null; },
        focus() {}
    };
}

function findNode(root: any, predicate: (node: any) => boolean): any {
    if (predicate(root)) return root;
    for (const child of root.children ?? []) {
        const match = findNode(child, predicate);
        if (match) return match;
    }
    return undefined;
}

function installDocument() {
    const elements: Record<string, any> = {
        addRowForm: makeNode('form'),
        addRowModal: makeNode('div'),
        columnDefinitions: makeNode('div')
    };
    elements.addRowModal.classList = makeClassList(['hidden']);
    (globalThis as any).document = {
        getElementById(id: string) {
            return elements[id] ?? null;
        },
        createElement(tagName: string) {
            return makeNode(tagName);
        },
        createTextNode(text: string) {
            const node = makeNode('#text');
            node.textContent = text;
            return node;
        },
        querySelectorAll() {
            return [];
        },
        querySelector() {
            return null;
        }
    };
    return elements;
}

describe('generated CRUD form accessibility', () => {
    afterEach(async () => {
        delete (globalThis as any).document;
        const { state } = await import(stateModulePath);
        state.selectedTable = null;
        state.selectedTableType = 'table';
        state.selectedTableIdentity = null;
        state.tableColumns = [];
    });

    it('associates every generated Add Row input with its column label', async () => {
        const elements = installDocument();
        const { state } = await import(stateModulePath);
        const { openAddRowModal } = await import(crudModulePath);
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.selectedTableIdentity = { kind: 'rowid' };
        state.tableColumns = [
            { name: 'display name', type: 'TEXT', notnull: 1, dflt_value: null },
            { name: '__proto__', type: 'TEXT', notnull: 0, dflt_value: null }
        ];

        openAddRowModal();

        assert.strictEqual(elements.addRowForm.children.length, 2);
        for (const field of elements.addRowForm.children) {
            const input = findNode(field, node => node.tagName === 'INPUT');
            const label = findNode(field, node => node.tagName === 'LABEL');
            assert.ok(input);
            assert.ok(label);
            assert.notStrictEqual(input.id, '');
            assert.strictEqual(label.htmlFor, input.id);
            assert.match(label.textContent, new RegExp(input.dataset.column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        }
    });

    it('labels generated Create Table name/type controls and the remove icon', async () => {
        const elements = installDocument();
        const { addColumnDefinition } = await import(crudModulePath);

        addColumnDefinition();

        const row = elements.columnDefinitions.children[0];
        const nameInput = findNode(row, node => node.className === 'col-name');
        const typeSelect = findNode(row, node => node.className === 'col-type');
        const removeButton = findNode(row, node => node.className.includes('btn-remove-col'));
        assert.ok(nameInput);
        assert.ok(typeSelect);
        assert.ok(removeButton);
        assert.strictEqual(nameInput.id, 'columnName_1');
        assert.strictEqual(typeSelect.id, 'columnType_1');
        assert.ok(findNode(
            row,
            node => node.tagName === 'LABEL'
                && node.htmlFor === nameInput.id
                && node.textContent === 'Column 1 name'
        ));
        assert.ok(findNode(
            row,
            node => node.tagName === 'LABEL'
                && node.htmlFor === typeSelect.id
                && node.textContent === 'Column 1 type'
        ));
        assert.strictEqual(removeButton.type, 'button');
        assert.strictEqual(removeButton.ariaLabel, 'Remove column definition 1');
    });
});
