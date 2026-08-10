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
const exportModulePath = '../../core/ui/modules/export.js';
const editModulePath = '../../core/ui/modules/edit.js';
const modalsModulePath = '../../core/ui/modules/modals.js';
const blobInspectorModulePath = '../../core/ui/modules/blob-inspector.js';

function createClassList(initial: string[] = []) {
    const classes = new Set(initial);
    return {
        add: (...names: string[]) => names.forEach(name => classes.add(name)),
        remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
        contains: (name: string) => classes.has(name)
    };
}

function installSubmissionDocument() {
    const elements: Record<string, any> = {
        statusText: { textContent: '' },
        addRowModal: { id: 'addRowModal', classList: createClassList() },
        deleteModal: { id: 'deleteModal', classList: createClassList() },
        createTableModal: { id: 'createTableModal', classList: createClassList() },
        addColumnModal: { id: 'addColumnModal', classList: createClassList() },
        exportModal: { id: 'exportModal', classList: createClassList() },
        cellPreviewModal: { id: 'cellPreviewModal', classList: createClassList() },
        newTableName: { value: 'new_table' },
        newColumnName: { value: 'new_column' },
        newColumnType: { value: 'TEXT' },
        newColumnDefault: { value: '' },
        exportFormat: { value: 'csv' },
        exportHeader: { checked: true },
        cellPreviewTextarea: { value: 'after' }
    };
    const columnDefinition = {
        querySelector(selector: string) {
            if (selector === '.col-name') return { value: 'id' };
            if (selector === '.col-type') return { value: 'INTEGER' };
            if (selector === '.col-pk') return { checked: true };
            if (selector === '.col-nn') return { checked: true };
            return null;
        }
    };

    (globalThis as any).document = {
        getElementById(id: string) {
            return elements[id] ?? null;
        },
        querySelectorAll(selector: string) {
            if (selector === '#addRowForm input[data-column]:not([disabled])') return [];
            if (selector === '.column-def-row') return [columnDefinition];
            if (selector === '.export-col-check:checked') return [{ value: 'value' }];
            return [];
        },
        querySelector() { return null; }
    };
}

async function prepareSubmissionState() {
    const { state } = await import(stateModulePath);
    state.isReadOnly = false;
    state.isGridReloading = false;
    state.selectedTable = 'items';
    state.selectedTableType = 'table';
    state.selectedTableIdentity = null;
    state.selectedRowIds = new Set([1]);
    state.selectedColumns = new Set();
    state.selectedCells = [];
    state.lastSelectedCell = null;
    state.tableColumns = [{ name: 'value', type: 'TEXT', notnull: 0 }];
    state.gridData = [[1, 'before']];
    state.cellPreviewInfo = {
        rowIdx: 0,
        colIdx: 0,
        rowId: 1,
        columnName: 'value',
        originalValue: 'before'
    };
    return state;
}

async function assertOneInFlightRpc(
    method: string,
    submit: () => Promise<unknown>
) {
    const { backendApi } = await import(apiModulePath);
    const originalMethod = backendApi[method];
    const originalConsoleError = console.error;
    let rejectRpc!: (error: Error) => void;
    const rpc = new Promise<never>((_resolve, reject) => { rejectRpc = reject; });
    let calls = 0;
    backendApi[method] = async () => {
        calls++;
        return rpc;
    };
    console.error = () => {};

    try {
        const first = submit();
        const duplicate = submit();
        const callsBeforeSettlement = calls;
        rejectRpc(new Error('intentional test rejection'));
        await Promise.all([first, duplicate]);
        assert.strictEqual(callsBeforeSettlement, 1, method);
        assert.strictEqual(calls, 1, method);
    } finally {
        backendApi[method] = originalMethod;
        console.error = originalConsoleError;
    }
}

describe('modal submission re-entry guards', () => {
    afterEach(async () => {
        delete (globalThis as any).document;
        const { state } = await import(stateModulePath);
        state.isReadOnly = false;
        state.isGridReloading = false;
        state.selectedTable = null;
        state.selectedTableType = 'table';
        state.selectedRowIds = new Set();
        state.selectedColumns = new Set();
        state.selectedCells = [];
        state.lastSelectedCell = null;
        state.tableColumns = [];
        state.gridData = [];
        state.cellPreviewInfo = null;
    });

    it('ignores a duplicate add-row submission while its RPC is in flight', async () => {
        installSubmissionDocument();
        await prepareSubmissionState();
        const { submitAddRow } = await import(crudModulePath);
        await assertOneInFlightRpc('insertRow', submitAddRow);
    });

    it('ignores a duplicate delete submission while its RPC is in flight', async () => {
        installSubmissionDocument();
        await prepareSubmissionState();
        const { submitDelete } = await import(crudModulePath);
        await assertOneInFlightRpc('deleteRows', submitDelete);
    });

    it('ignores a duplicate create-table submission while its RPC is in flight', async () => {
        installSubmissionDocument();
        await prepareSubmissionState();
        const { submitCreateTable } = await import(crudModulePath);
        await assertOneInFlightRpc('createTable', submitCreateTable);
    });

    it('ignores a duplicate add-column submission while its RPC is in flight', async () => {
        installSubmissionDocument();
        await prepareSubmissionState();
        const { submitAddColumn } = await import(crudModulePath);
        await assertOneInFlightRpc('addColumn', submitAddColumn);
    });

    it('ignores a duplicate export submission while its RPC is in flight', async () => {
        installSubmissionDocument();
        await prepareSubmissionState();
        const { submitExport } = await import(exportModulePath);
        await assertOneInFlightRpc('exportTable', submitExport);
    });

    it('ignores a duplicate cell-preview save while its RPC is in flight', async () => {
        installSubmissionDocument();
        await prepareSubmissionState();
        const { saveCellPreview } = await import(editModulePath);
        await assertOneInFlightRpc('updateCell', saveCellPreview);
    });

    it('clears an Escape-closed cell preview so a queued save is a no-op', async () => {
        const documentListeners = new Map<string, (event: any) => void>();
        const modal = {
            id: 'cellPreviewModal',
            classList: createClassList(['cell-preview-modal']),
            closest() { return null; }
        };
        const textarea = { value: 'after' };
        (globalThis as any).document = {
            addEventListener(type: string, listener: (event: any) => void) {
                documentListeners.set(type, listener);
            },
            getElementById(id: string) {
                if (id === 'cellPreviewModal') return modal;
                if (id === 'cellPreviewTextarea') return textarea;
                if (id === 'statusText') return { textContent: '' };
                return null;
            },
            querySelector(selector: string) {
                return selector.includes('.cell-preview-modal:not(.hidden)') ? modal : null;
            },
            querySelectorAll() { return []; }
        };
        const state = await prepareSubmissionState();
        const { backendApi } = await import(apiModulePath);
        const { initModals } = await import(modalsModulePath);
        const { saveCellPreview } = await import(editModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const originalConsoleError = console.error;
        let updateCalls = 0;
        backendApi.updateCell = async () => {
            updateCalls++;
            throw new Error('closed preview must not reach this RPC');
        };
        console.error = () => {};

        try {
            initModals();
            const keydown = documentListeners.get('keydown');
            assert.ok(keydown);
            keydown({
                key: 'Escape',
                preventDefault() {},
                stopPropagation() {},
                stopImmediatePropagation() {}
            });
            await saveCellPreview();

            assert.strictEqual(state.cellPreviewInfo, null);
            assert.strictEqual(updateCalls, 0);
        } finally {
            backendApi.updateCell = originalUpdateCell;
            console.error = originalConsoleError;
        }
    });

    it('cleans the Blob Inspector session when Escape closes its modal', async () => {
        const documentListeners = new Map<string, (event: any) => void>();
        const modal = {
            id: 'blob-inspector-modal',
            classList: createClassList(['modal-overlay']),
            querySelectorAll() { return []; }
        };
        const preview = { innerHTML: '' };
        const hex = { value: '' };
        const info = { textContent: '' };
        (globalThis as any).document = {
            addEventListener(type: string, listener: (event: any) => void) {
                documentListeners.set(type, listener);
            },
            getElementById(id: string) {
                if (id === 'blob-inspector-modal') return modal;
                if (id === 'tab-preview') return preview;
                if (id === 'blob-info') return info;
                return null;
            },
            querySelector(selector: string) {
                if (selector === '.hex-dump') return hex;
                if (selector.includes('.modal-overlay:not(.hidden)')) return modal;
                return null;
            }
        };
        const { BlobInspector } = await import(blobInspectorModulePath);
        const { initModals } = await import(modalsModulePath);
        const inspector = new BlobInspector();
        inspector.currentData = Uint8Array.from([1, 2, 3]);
        inspector.currentType = { type: 'binary', ext: 'bin' };
        inspector.currentRowId = 7;
        inspector.currentColName = 'payload';
        inspector.currentCellInfo = { rowIdx: 0, colIdx: 0 };

        initModals();
        const keydown = documentListeners.get('keydown');
        assert.ok(keydown);
        keydown({
            key: 'Escape',
            preventDefault() {},
            stopPropagation() {},
            stopImmediatePropagation() {}
        });

        assert.strictEqual(inspector.currentData, null);
        assert.strictEqual(inspector.currentType, null);
        assert.strictEqual(inspector.currentRowId, null);
        assert.strictEqual(inspector.currentColName, null);
        assert.strictEqual(inspector.currentCellInfo, null);
    });
});
