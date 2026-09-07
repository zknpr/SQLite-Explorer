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
        parentElement: null as any,
        classList: makeClassList(),
        appendChild(child: any) {
            this.children.push(child);
            child.parentElement = this;
            return child;
        },
        replaceChildren(...children: any[]) {
            this.children = [...children];
        },
        querySelector(selector: string) {
            return findNode(this, node => node !== this && node.className.split(' ').includes(selector.slice(1))) ?? null;
        },
        get nextElementSibling() {
            return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null;
        },
        get previousElementSibling() {
            return this.parentElement?.children[this.parentElement.children.indexOf(this) - 1] ?? null;
        },
        remove() {
            const document = (globalThis as any).document;
            if (findNode(this, node => node === document.activeElement)) document.activeElement = document.body;
            if (this.parentElement) {
                this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
                this.parentElement = null;
            }
        },
        focus() { (globalThis as any).document.activeElement = this; }
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
        columnDefinitions: makeNode('div'),
        btnAddColumnDef: makeNode('button')
    };
    elements.addRowModal.classList = makeClassList(['hidden']);
    (globalThis as any).document = {
        body: makeNode('body'),
        activeElement: null,
        getElementById(id: string) {
            return elements[id] ?? findNode(elements.columnDefinitions, node => node.id === id) ?? null;
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
        const defaultInput = findNode(row, node => node.className === 'col-default');
        const removeButton = findNode(row, node => node.className.includes('btn-remove-col'));
        assert.ok(nameInput);
        assert.ok(typeSelect);
        assert.ok(defaultInput, 'Create Table must expose a default literal input');
        assert.ok(findNode(row, node => node.tagName === 'LABEL' && node.htmlFor === defaultInput.id && node.textContent === 'Column 1 default literal'));
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

    for (const { name, count, removedIndex, expectedIndex } of [
        { name: 'the next definition after removing a focused middle row', count: 3, removedIndex: 1, expectedIndex: 2 },
        { name: 'the previous definition after removing a focused final row', count: 2, removedIndex: 1, expectedIndex: 0 },
        { name: 'Add Column after removing the final remaining definition', count: 1, removedIndex: 0, expectedIndex: -1 }
    ]) {
        it(`immediately focuses ${name}`, async () => {
            const elements = installDocument();
            const { addColumnDefinition, removeColumnDefinition } = await import(crudModulePath);
            for (let index = 0; index < count; index++) addColumnDefinition();
            const rows = [...elements.columnDefinitions.children];
            const removed = rows[removedIndex];
            const removeButton = findNode(removed, node => node.className.includes('btn-remove-col'));
            const expectedFocus = expectedIndex < 0
                ? elements.btnAddColumnDef
                : findNode(rows[expectedIndex], node => node.className === 'col-name');
            removeButton.focus();

            removeColumnDefinition(removeButton.dataset.colid);

            assert.strictEqual(elements.columnDefinitions.children.length, count - 1);
            assert.ok(!elements.columnDefinitions.children.includes(removed));
            assert.ok((globalThis as any).document.activeElement === expectedFocus,
                'removing the focused control must not leave focus on BODY');
        });
    }

    it('does not move focus when the requested definition no longer exists', async () => {
        const elements = installDocument();
        const { removeColumnDefinition } = await import(crudModulePath);
        elements.btnAddColumnDef.focus();

        removeColumnDefinition('missing');

        assert.strictEqual((globalThis as any).document.activeElement, elements.btnAddColumnDef);
    });
});
