import './vscode_mock_setup';

import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { encodeReadOnlyPrimaryKeyRecordId } from '../../src/core/row-identity';

(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState() {},
    postMessage() {}
});

const stateModulePath = '../../core/ui/modules/state.js';
const apiModulePath = '../../core/ui/modules/api.js';
const uiModulePath = '../../core/ui/modules/ui.js';
const crudModulePath = '../../core/ui/modules/crud.js';
const exportModulePath = '../../core/ui/modules/export.js';
const sidebarModulePath = '../../core/ui/modules/sidebar.js';

const readOnlyReason = 'Primary-key identity exceeds the safe transport limit.';
const readOnlyId = encodeReadOnlyPrimaryKeyRecordId(readOnlyReason, 0);

function makeClassList(initial: string[] = []) {
    const classes = new Set(initial);
    return {
        add(...names: string[]) { for (const name of names) classes.add(name); },
        remove(...names: string[]) { for (const name of names) classes.delete(name); },
        contains(name: string) { return classes.has(name); }
    };
}

function makeNode(tagName = 'div', isFragment = false): any {
    return {
        tagName,
        isFragment,
        children: [] as any[],
        classList: makeClassList(),
        className: '',
        dataset: {} as Record<string, string>,
        style: {} as Record<string, string>,
        textContent: '',
        disabled: false,
        title: '',
        appendChild(child: any) {
            if (child?.isFragment) this.children.push(...child.children);
            else this.children.push(child);
            return child;
        },
        replaceChildren(...children: any[]) { this.children = [...children]; },
        querySelector() { return null; }
    };
}

function textOf(node: any): string {
    return `${node?.textContent ?? ''}${(node?.children ?? []).map(textOf).join('')}`;
}

function installDocument() {
    const elements: Record<string, any> = {
        statusText: makeNode('span'),
        btnAddRow: makeNode('button'),
        btnAddColumn: makeNode('button'),
        btnDeleteRows: makeNode('button'),
        btnExport: makeNode('button'),
        btnApplyBatchUpdate: makeNode('button'),
        btnSubmitExport: makeNode('button'),
        deleteConfirmText: makeNode('p'),
        deleteModal: makeNode('div'),
        exportModal: makeNode('div'),
        exportFormat: { value: 'csv' },
        exportHeader: { checked: true },
        batchUpdateSectionTitle: makeNode('div'),
        batchUpdateList: makeNode('div'),
        batchUpdateCount: makeNode('span'),
        batchUpdateFields: makeNode('div')
    };
    elements.deleteModal.classList.add('hidden');
    elements.exportModal.classList.add('hidden');
    const batchInput = {
        value: 'updated',
        dataset: { colidx: '0', ispatch: 'false', isnull: 'false' }
    };

    (globalThis as any).document = {
        getElementById(id: string) { return elements[id] ?? null; },
        querySelector() { return null; },
        querySelectorAll(selector: string) {
            if (selector === '.export-col-check:checked') return [{ value: 'value' }];
            if (selector === '.batch-input') return [batchInput];
            return [];
        },
        createElement(tagName: string) { return makeNode(tagName); },
        createTextNode(text: string) { return { textContent: text, children: [] }; },
        createDocumentFragment() { return makeNode('fragment', true); }
    };
    return { elements, batchInput };
}

async function prepareState() {
    const { state } = await import(stateModulePath);
    state.isReadOnly = false;
    state.isGridReloading = false;
    state.selectedTable = 'items';
    state.selectedTableType = 'table';
    state.selectedTableIdentity = null;
    state.tableColumns = [{ name: 'value', type: 'TEXT' }];
    state.gridData = [[readOnlyId, 'preview'], [7, 'before']];
    state.gridReadOnlyRowReasons = { 0: readOnlyReason };
    state.selectedColumns = new Set();
    state.selectedCells = [];
    state.selectedRowIds = new Set([readOnlyId]);
    return state;
}

describe('read-only primary-key action eligibility', () => {
    afterEach(async () => {
        delete (globalThis as any).document;
        const { state } = await import(stateModulePath);
        state.selectedTable = null;
        state.selectedTableType = 'table';
        state.selectedTableIdentity = null;
        state.tableColumns = [];
        state.gridData = [];
        state.gridReadOnlyRowReasons = {};
        state.selectedColumns = new Set();
        state.selectedCells = [];
        state.selectedRowIds = new Set();
        state.isReadOnly = false;
        state.isGridReloading = false;
    });

    it('disables readonly-only delete with a reason and describes mixed-selection skips', async () => {
        const { elements } = installDocument();
        const state = await prepareState();
        const { updateToolbarButtons } = await import(uiModulePath);
        const { openDeleteModal } = await import(crudModulePath);

        updateToolbarButtons();
        assert.strictEqual(elements.btnDeleteRows.disabled, true);
        assert.match(elements.btnDeleteRows.title, /primary-key identity exceeds/i);

        state.selectedRowIds.add(7);
        updateToolbarButtons();
        assert.strictEqual(elements.btnDeleteRows.disabled, false);
        openDeleteModal();
        assert.match(elements.deleteConfirmText.textContent, /delete 1 row/i);
        assert.match(elements.deleteConfirmText.textContent, /1 read-only.*skipped/i);
        assert.match(elements.deleteConfirmText.textContent, /primary-key identity exceeds/i);
    });

    it('filters delete RPC identities and blocks a readonly-only submission', async () => {
        const { elements } = installDocument();
        const state = await prepareState();
        const { backendApi } = await import(apiModulePath);
        const { submitDelete } = await import(crudModulePath);
        const originalDeleteRows = backendApi.deleteRows;
        const originalConsoleError = console.error;
        let submitted: unknown[] | undefined;
        backendApi.deleteRows = async (_table: string, rowIds: unknown[]) => {
            submitted = rowIds;
            throw new Error('stop after identity capture');
        };
        console.error = () => {};

        try {
            state.selectedRowIds.add(7);
            await submitDelete();
            assert.deepStrictEqual(submitted, [7]);

            submitted = undefined;
            state.selectedRowIds = new Set([readOnlyId]);
            await submitDelete();
            assert.strictEqual(submitted, undefined);
            assert.match(elements.statusText.textContent, /primary-key identity exceeds/i);
        } finally {
            backendApi.deleteRows = originalDeleteRows;
            console.error = originalConsoleError;
        }
    });

    it('filters selected export identities and blocks readonly-only export', async () => {
        const { elements } = installDocument();
        const state = await prepareState();
        const { backendApi } = await import(apiModulePath);
        const { submitExport } = await import(exportModulePath);
        const originalExportTable = backendApi.exportTable;
        const originalConsoleError = console.error;
        let submittedOptions: any;
        backendApi.exportTable = async (...args: any[]) => {
            submittedOptions = args[4];
            throw new Error('stop after option capture');
        };
        console.error = () => {};

        try {
            state.selectedRowIds.add(7);
            await submitExport();
            assert.deepStrictEqual(submittedOptions?.rowIds, [7]);

            submittedOptions = undefined;
            state.selectedRowIds = new Set([readOnlyId]);
            await submitExport();
            assert.strictEqual(submittedOptions, undefined);
            assert.match(elements.statusText.textContent, /primary-key identity exceeds/i);
        } finally {
            backendApi.exportTable = originalExportTable;
            console.error = originalConsoleError;
        }
    });

    it('excludes readonly cells from the batch count, notice, and RPC payload', async () => {
        const { elements } = installDocument();
        const state = await prepareState();
        const { backendApi } = await import(apiModulePath);
        const { updateBatchSidebar, applyBatchUpdate } = await import(sidebarModulePath);
        const originalUpdateCellBatch = backendApi.updateCellBatch;
        const originalConsoleError = console.error;
        let submitted: any[] | undefined;
        backendApi.updateCellBatch = async (_table: string, updates: any[]) => {
            submitted = updates;
            throw new Error('stop after batch capture');
        };
        console.error = () => {};
        state.selectedCells = [
            { rowIdx: 0, colIdx: 0, rowId: readOnlyId, value: 'preview' },
            { rowIdx: 1, colIdx: 0, rowId: 7, value: 'before' }
        ];

        try {
            updateBatchSidebar();
            assert.strictEqual(elements.batchUpdateCount.textContent, 1);
            assert.match(textOf(elements.batchUpdateFields), /1 read-only.*excluded/i);
            assert.match(textOf(elements.batchUpdateFields), /primary-key identity exceeds/i);
            assert.strictEqual(elements.btnApplyBatchUpdate.disabled, false);

            await applyBatchUpdate();
            assert.deepStrictEqual(submitted?.map(update => update.rowId), [7]);
        } finally {
            backendApi.updateCellBatch = originalUpdateCellBatch;
            console.error = originalConsoleError;
        }
    });
});
