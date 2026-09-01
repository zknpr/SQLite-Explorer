import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState() {},
    postMessage() {}
});

const stateModulePath = '../../core/ui/modules/state.js';
const apiModulePath = '../../core/ui/modules/api.js';
const crudModulePath = '../../core/ui/modules/crud.js';

function createClassList() {
    const classes = new Set<string>();
    return {
        add: (...names: string[]) => names.forEach(name => classes.add(name)),
        remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
        contains: (name: string) => classes.has(name)
    };
}

function installCrudDocument() {
    const columnName = { value: 'id' };
    const columnType = { value: 'INTEGER' };
    const columnPrimaryKey = { checked: true };
    const columnNotNull = { checked: true };
    const columnDefinition = {
        querySelector(selector: string) {
            if (selector === '.col-name') return columnName;
            if (selector === '.col-type') return columnType;
            if (selector === '.col-pk') return columnPrimaryKey;
            if (selector === '.col-nn') return columnNotNull;
            return null;
        }
    };
    const elements: Record<string, any> = {
        statusText: { textContent: '' },
        createTableModal: { classList: createClassList() },
        addColumnModal: { classList: createClassList() },
        newTableName: { value: '' },
        newColumnName: { value: '' },
        newColumnType: { value: 'TEXT' },
        newColumnDefault: { value: '' }
    };
    (globalThis as any).document = {
        getElementById(id: string) {
            return elements[id] ?? null;
        },
        querySelectorAll(selector: string) {
            return selector === '.column-def-row' ? [columnDefinition] : [];
        },
        querySelector() { return null; }
    };
    return { elements, columnName };
}

async function prepareCrudState() {
    const { state } = await import(stateModulePath);
    state.isReadOnly = false;
    state.selectedTable = ' existing "table" 🧩 ';
    state.selectedTableType = 'table';
    state.selectedTableIdentity = { kind: 'rowid' };
    state.tableColumns = [];
    state.gridData = [];
    return state;
}

describe('schema identifier UI', () => {
    afterEach(async () => {
        delete (globalThis as any).document;
        const { state } = await import(stateModulePath);
        state.isReadOnly = false;
        state.selectedTable = null;
        state.selectedTableType = 'table';
        state.selectedTableIdentity = null;
        state.tableColumns = [];
        state.gridData = [];
    });

    it('preserves legal table and column identifiers exactly in CRUD requests', async () => {
        const { elements, columnName } = installCrudDocument();
        await prepareCrudState();
        const { backendApi } = await import(apiModulePath);
        const { submitCreateTable, submitAddColumn } = await import(crudModulePath);
        const originals = {
            createTable: backendApi.createTable,
            addColumn: backendApi.addColumn
        };
        const originalConsoleError = console.error;
        const createCalls: unknown[][] = [];
        const addCalls: unknown[][] = [];
        backendApi.createTable = async (...args: unknown[]) => {
            createCalls.push(args);
            throw new Error('captured create-table request');
        };
        backendApi.addColumn = async (...args: unknown[]) => {
            addCalls.push(args);
            throw new Error('captured add-column request');
        };
        console.error = () => {};

        try {
            elements.newTableName.value = ' ui "table" 🚀 ';
            columnName.value = ' id "column" 🧩 ';
            await submitCreateTable();

            elements.newColumnName.value = ' added "column" ✨ ';
            await submitAddColumn();

            assert.deepStrictEqual(createCalls, [[
                ' ui "table" 🚀 ',
                [{
                    name: ' id "column" 🧩 ',
                    type: 'INTEGER',
                    primaryKey: true,
                    notNull: true
                }]
            ]]);
            assert.deepStrictEqual(addCalls, [[
                ' existing "table" 🧩 ',
                ' added "column" ✨ ',
                'TEXT',
                ''
            ]]);
        } finally {
            backendApi.createTable = originals.createTable;
            backendApi.addColumn = originals.addColumn;
            console.error = originalConsoleError;
        }
    });

    it('rejects empty and NUL schema identifiers before issuing CRUD requests', async () => {
        const { elements, columnName } = installCrudDocument();
        await prepareCrudState();
        const { backendApi } = await import(apiModulePath);
        const { submitCreateTable, submitAddColumn } = await import(crudModulePath);
        const originals = {
            createTable: backendApi.createTable,
            addColumn: backendApi.addColumn
        };
        let createCalls = 0;
        let addCalls = 0;
        backendApi.createTable = async () => { createCalls++; };
        backendApi.addColumn = async () => { addCalls++; };

        try {
            elements.newTableName.value = 'bad\0table';
            await submitCreateTable();
            assert.match(elements.statusText.textContent, /Table name cannot contain NUL/);

            elements.newTableName.value = 'valid table';
            columnName.value = '';
            await submitCreateTable();
            assert.match(elements.statusText.textContent, /Column name is required/);

            columnName.value = 'bad\0column';
            await submitCreateTable();
            assert.match(elements.statusText.textContent, /Column name cannot contain NUL/);

            elements.newColumnName.value = 'bad\0column';
            await submitAddColumn();
            assert.match(elements.statusText.textContent, /Column name cannot contain NUL/);
            assert.strictEqual(createCalls, 0);
            assert.strictEqual(addCalls, 0);
        } finally {
            backendApi.createTable = originals.createTable;
            backendApi.addColumn = originals.addColumn;
        }
    });
});
