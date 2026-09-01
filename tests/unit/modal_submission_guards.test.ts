import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { createDeferred } from './helpers/deferred';

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
    const container = () => ({
        children: [] as any[],
        style: {} as Record<string, string>,
        appendChild(child: any) {
            this.children.push(child);
            return child;
        },
        replaceChildren(...children: any[]) {
            this.children = children;
        }
    });
    const elements: Record<string, any> = {
        statusText: { textContent: '' },
        addRowModal: { id: 'addRowModal', classList: createClassList() },
        deleteModal: { id: 'deleteModal', classList: createClassList() },
        createTableModal: { id: 'createTableModal', classList: createClassList() },
        addColumnModal: { id: 'addColumnModal', classList: createClassList() },
        exportModal: {
            id: 'exportModal',
            classList: createClassList(),
            querySelector() { return null; }
        },
        exportColumns: container(),
        exportOptions: container(),
        btnSubmitExport: { disabled: false, title: '' },
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
        querySelector() { return null; },
        createElement() {
            return {
                ...container(),
                className: '',
                type: '',
                value: '',
                checked: false,
                id: ''
            };
        },
        createTextNode(text: string) {
            return { textContent: text };
        }
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

    it('ignores a duplicate export click after the first click closes its modal', async () => {
        installSubmissionDocument();
        await prepareSubmissionState();
        const { openExportModal, submitExport } = await import(exportModulePath);
        openExportModal();
        await assertOneInFlightRpc('exportTable', submitExport);
    });

    it('ignores a duplicate cell-preview save while its RPC is in flight', async () => {
        installSubmissionDocument();
        await prepareSubmissionState();
        const { saveCellPreview } = await import(editModulePath);
        await assertOneInFlightRpc('updateCell', saveCellPreview);
    });

    it('traps Tab inside the active modal and restores the opener on close', async () => {
        const documentListeners = new Map<string, (event: any) => void>();
        let activeElement: any;
        const focusable = (id: string) => ({
            id,
            disabled: false,
            hidden: false,
            focus() { activeElement = this; },
            getAttribute() { return null; },
            closest() { return null; }
        });
        const opener = focusable('opener');
        const first = focusable('first');
        const last = focusable('last');
        const modal = {
            id: 'deleteModal',
            classList: createClassList(['modal-overlay', 'hidden']),
            querySelector() { return first; },
            querySelectorAll() { return [first, last]; },
            contains(element: any) { return element === first || element === last; },
            focus() { activeElement = this; }
        };
        activeElement = opener;
        (globalThis as any).document = {
            addEventListener(type: string, listener: (event: any) => void) {
                documentListeners.set(type, listener);
            },
            get activeElement() { return activeElement; },
            getElementById(id: string) { return id === 'deleteModal' ? modal : null; },
            querySelector(selector: string) {
                return selector.includes(':not(.hidden)') && !modal.classList.contains('hidden')
                    ? modal
                    : null;
            },
            querySelectorAll(selector: string) {
                return selector.includes(':not(.hidden)') && !modal.classList.contains('hidden')
                    ? [modal]
                    : [];
            }
        };
        const { closeModal, initModals, openModal } = await import(modalsModulePath);
        initModals();
        openModal('deleteModal');
        assert.strictEqual(activeElement, first);

        const keydown = documentListeners.get('keydown');
        assert.ok(keydown);
        let prevented = 0;
        activeElement = last;
        keydown({
            key: 'Tab',
            shiftKey: false,
            preventDefault() { prevented++; },
            stopPropagation() {},
            stopImmediatePropagation() {}
        });
        assert.strictEqual(activeElement, first);

        activeElement = first;
        keydown({
            key: 'Tab',
            shiftKey: true,
            preventDefault() { prevented++; },
            stopPropagation() {},
            stopImmediatePropagation() {}
        });
        assert.strictEqual(activeElement, last);
        assert.strictEqual(prevented, 2);

        closeModal('deleteModal');
        assert.strictEqual(activeElement, opener);
    });

    it('deletes the rows shown in the confirmation even if live selection changes behind it', async () => {
        const state = await prepareSubmissionState();
        const { backendApi } = await import(apiModulePath);
        const { openDeleteModal, submitDelete } = await import(crudModulePath);
        const originalDeleteRows = backendApi.deleteRows;
        const originalConsoleError = console.error;
        const calls: unknown[][] = [];
        const deleteModal = {
            id: 'deleteModal',
            classList: createClassList(['modal-overlay', 'hidden']),
            querySelector() { return null; }
        };
        const elements: Record<string, any> = {
            deleteModal,
            deleteConfirmText: { textContent: '' },
            statusText: { textContent: '' }
        };
        (globalThis as any).document = {
            activeElement: null,
            getElementById(id: string) { return elements[id] ?? null; },
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        backendApi.deleteRows = async (...args: unknown[]) => {
            calls.push(args);
            throw new Error('stop after target capture');
        };
        console.error = () => {};

        try {
            openDeleteModal();
            state.selectedTable = 'other_items';
            state.selectedRowIds = new Set([99]);
            await submitDelete();

            assert.deepStrictEqual(calls, [['items', [1]]]);
        } finally {
            backendApi.deleteRows = originalDeleteRows;
            console.error = originalConsoleError;
        }
    });

    it('rejects direct row deletion when the document is read-only', async () => {
        installSubmissionDocument();
        const state = await prepareSubmissionState();
        const { backendApi } = await import(apiModulePath);
        const { submitDelete } = await import(crudModulePath);
        const originalDeleteRows = backendApi.deleteRows;
        const originalConsoleError = console.error;
        let calls = 0;
        backendApi.deleteRows = async () => {
            calls++;
            throw new Error('read-only deletion reached the backend');
        };
        console.error = () => {};
        state.isReadOnly = true;

        try {
            await submitDelete();
            assert.strictEqual(calls, 0);
            assert.strictEqual(
                (globalThis as any).document.getElementById('statusText').textContent,
                'Document is read-only'
            );
        } finally {
            backendApi.deleteRows = originalDeleteRows;
            console.error = originalConsoleError;
        }
    });

    it('does not let an older Add Row completion close a reopened form', async () => {
        const state = await prepareSubmissionState();
        const { backendApi } = await import(apiModulePath);
        const { closeModal } = await import(modalsModulePath);
        const { openAddRowModal, submitAddRow } = await import(crudModulePath);
        const originalInsertRow = backendApi.insertRow;
        const inserted = new Promise<void>(resolve => { (globalThis as any).__resolveInsert = resolve; });
        const modal = {
            id: 'addRowModal',
            classList: createClassList(['modal-overlay', 'hidden']),
            querySelector() { return null; }
        };
        const form = { replaceChildren() {} };
        const status = { textContent: '' };
        (globalThis as any).document = {
            activeElement: null,
            getElementById(id: string) {
                if (id === 'addRowModal') return modal;
                if (id === 'addRowForm') return form;
                if (id === 'statusText') return status;
                return null;
            },
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        backendApi.insertRow = async () => inserted;
        state.tableColumns = [];

        try {
            openAddRowModal();
            const pending = submitAddRow();
            closeModal('addRowModal');
            openAddRowModal();
            state.selectedTable = null;
            (globalThis as any).__resolveInsert();
            await pending;

            assert.strictEqual(modal.classList.contains('hidden'), false);
        } finally {
            backendApi.insertRow = originalInsertRow;
            delete (globalThis as any).__resolveInsert;
        }
    });

    it('refreshes the selected table when Add Row closes while its insert is in flight', async () => {
        const state = await prepareSubmissionState();
        const { backendApi } = await import(apiModulePath);
        const { closeModal } = await import(modalsModulePath);
        const { openAddRowModal, submitAddRow } = await import(crudModulePath);
        const inserted = createDeferred<void>();
        const originals = {
            insertRow: backendApi.insertRow,
            fetchTableCount: backendApi.fetchTableCount,
            fetchTableData: backendApi.fetchTableData
        };
        const originalConsoleError = console.error;
        let dataFetches = 0;
        const modal = {
            id: 'addRowModal',
            classList: createClassList(['modal-overlay', 'hidden']),
            querySelector() { return null; }
        };
        const form = { replaceChildren() {} };
        const grid = {
            innerHTML: '', scrollLeft: 0, scrollTop: 0,
            querySelector() { return null; }
        };
        (globalThis as any).document = {
            activeElement: null,
            getElementById(id: string) {
                if (id === 'addRowModal') return modal;
                if (id === 'addRowForm') return form;
                if (id === 'gridContainer') return grid;
                if (id === 'statusText') return { textContent: '' };
                return null;
            },
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        backendApi.insertRow = async () => inserted.promise;
        backendApi.fetchTableCount = async () => ({ count: 1, isExact: true });
        backendApi.fetchTableData = async () => {
            dataFetches++;
            throw new Error('intentional refresh probe');
        };
        console.error = () => {};
        state.tableColumns = [];

        try {
            openAddRowModal();
            const pending = submitAddRow();
            closeModal('addRowModal');
            inserted.resolve();
            await pending;

            assert.strictEqual(dataFetches, 1);
        } finally {
            backendApi.insertRow = originals.insertRow;
            backendApi.fetchTableCount = originals.fetchTableCount;
            backendApi.fetchTableData = originals.fetchTableData;
            console.error = originalConsoleError;
        }
    });

    it('does not let an older Create Table completion close a reopened draft', async () => {
        const state = await prepareSubmissionState();
        const { backendApi } = await import(apiModulePath);
        const { closeModal } = await import(modalsModulePath);
        const { openCreateTableModal, submitCreateTable } = await import(crudModulePath);
        const originalCreateTable = backendApi.createTable;
        let resolveCreate!: () => void;
        const created = new Promise<void>(resolve => { resolveCreate = resolve; });
        const modal = {
            id: 'createTableModal',
            classList: createClassList(['modal-overlay', 'hidden']),
            querySelector() { return null; }
        };
        const tableName = { value: '' };
        const definitions = { replaceChildren() {}, appendChild() {} };
        const columnDefinition = {
            querySelector(selector: string) {
                if (selector === '.col-name') return { value: 'id' };
                if (selector === '.col-type') return { value: 'INTEGER' };
                if (selector === '.col-pk') return { checked: true };
                if (selector === '.col-nn') return { checked: true };
                return null;
            }
        };
        const makeElement = () => ({
            className: '', id: '', value: '', type: '', placeholder: '',
            dataset: {}, style: {}, disabled: false, checked: false,
            appendChild() {}, focus() {}
        });
        (globalThis as any).document = {
            activeElement: null,
            getElementById(id: string) {
                if (id === 'createTableModal') return modal;
                if (id === 'newTableName') return tableName;
                if (id === 'columnDefinitions') return definitions;
                if (id === 'statusText') return { textContent: '' };
                return null;
            },
            createElement() { return makeElement(); },
            createTextNode() { return {}; },
            querySelectorAll(selector: string) {
                return selector === '.column-def-row' ? [columnDefinition] : [];
            },
            querySelector() { return null; }
        };
        backendApi.createTable = async () => created;
        state.isDbConnected = false;

        try {
            openCreateTableModal();
            tableName.value = 'first_table';
            const pending = submitCreateTable();
            closeModal('createTableModal');
            openCreateTableModal();
            tableName.value = 'second_table';
            resolveCreate();
            await pending;

            assert.strictEqual(modal.classList.contains('hidden'), false);
            assert.strictEqual(tableName.value, 'second_table');
        } finally {
            backendApi.createTable = originalCreateTable;
        }
    });

    it('does not let an older Add Column completion close a reopened draft', async () => {
        const state = await prepareSubmissionState();
        const { backendApi } = await import(apiModulePath);
        const { closeModal } = await import(modalsModulePath);
        const { openAddColumnModal, submitAddColumn } = await import(crudModulePath);
        const originalAddColumn = backendApi.addColumn;
        let resolveAdd!: () => void;
        const added = new Promise<void>(resolve => { resolveAdd = resolve; });
        const modal = {
            id: 'addColumnModal',
            classList: createClassList(['modal-overlay', 'hidden']),
            querySelector() { return null; }
        };
        const name = { value: '' };
        const type = { value: '' };
        const defaultValue = { value: '' };
        (globalThis as any).document = {
            activeElement: null,
            getElementById(id: string) {
                if (id === 'addColumnModal') return modal;
                if (id === 'newColumnName') return name;
                if (id === 'newColumnType') return type;
                if (id === 'newColumnDefault') return defaultValue;
                if (id === 'statusText') return { textContent: '' };
                return null;
            },
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        backendApi.addColumn = async () => added;

        try {
            openAddColumnModal();
            name.value = 'first_column';
            const pending = submitAddColumn();
            closeModal('addColumnModal');
            openAddColumnModal();
            name.value = 'second_column';
            state.selectedTable = null;
            resolveAdd();
            await pending;

            assert.strictEqual(modal.classList.contains('hidden'), false);
            assert.strictEqual(name.value, 'second_column');
        } finally {
            backendApi.addColumn = originalAddColumn;
        }
    });

    it('does not let an older Delete completion close a reopened confirmation', async () => {
        const state = await prepareSubmissionState();
        const { backendApi } = await import(apiModulePath);
        const { closeModal } = await import(modalsModulePath);
        const { openDeleteModal, submitDelete } = await import(crudModulePath);
        const originalDeleteRows = backendApi.deleteRows;
        let resolveDelete!: () => void;
        const deleted = new Promise<void>(resolve => { resolveDelete = resolve; });
        const modal = {
            id: 'deleteModal',
            classList: createClassList(['modal-overlay', 'hidden']),
            querySelector() { return null; }
        };
        const confirm = { textContent: '' };
        (globalThis as any).document = {
            activeElement: null,
            getElementById(id: string) {
                if (id === 'deleteModal') return modal;
                if (id === 'deleteConfirmText') return confirm;
                if (id === 'statusText') return { textContent: '' };
                return null;
            },
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        backendApi.deleteRows = async () => deleted;

        try {
            openDeleteModal();
            const pending = submitDelete();
            closeModal('deleteModal');
            state.selectedRowIds = new Set([2]);
            openDeleteModal();
            state.selectedTable = null;
            resolveDelete();
            await pending;

            assert.strictEqual(modal.classList.contains('hidden'), false);
            assert.match(confirm.textContent, /delete 1 row/i);
        } finally {
            backendApi.deleteRows = originalDeleteRows;
        }
    });

    it('refreshes the selected table when Delete closes while its RPC is in flight', async () => {
        const state = await prepareSubmissionState();
        const { backendApi } = await import(apiModulePath);
        const { closeModal } = await import(modalsModulePath);
        const { openDeleteModal, submitDelete } = await import(crudModulePath);
        const deleted = createDeferred<void>();
        const originals = {
            deleteRows: backendApi.deleteRows,
            fetchTableCount: backendApi.fetchTableCount,
            fetchTableData: backendApi.fetchTableData
        };
        const originalConsoleError = console.error;
        let dataFetches = 0;
        const modal = {
            id: 'deleteModal',
            classList: createClassList(['modal-overlay', 'hidden']),
            querySelector() { return null; }
        };
        const grid = {
            innerHTML: '', scrollLeft: 0, scrollTop: 0,
            querySelector() { return null; }
        };
        (globalThis as any).document = {
            activeElement: null,
            getElementById(id: string) {
                if (id === 'deleteModal') return modal;
                if (id === 'deleteConfirmText') return { textContent: '' };
                if (id === 'gridContainer') return grid;
                if (id === 'statusText') return { textContent: '' };
                return null;
            },
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        backendApi.deleteRows = async () => deleted.promise;
        backendApi.fetchTableCount = async () => ({ count: 1, isExact: true });
        backendApi.fetchTableData = async () => {
            dataFetches++;
            throw new Error('intentional refresh probe');
        };
        console.error = () => {};

        try {
            openDeleteModal();
            const pending = submitDelete();
            closeModal('deleteModal');
            state.selectedRowIds = new Set([2]);
            deleted.resolve();
            await pending;

            assert.strictEqual(dataFetches, 1);
            assert.deepStrictEqual([...state.selectedRowIds], [2]);
        } finally {
            backendApi.deleteRows = originals.deleteRows;
            backendApi.fetchTableCount = originals.fetchTableCount;
            backendApi.fetchTableData = originals.fetchTableData;
            console.error = originalConsoleError;
        }
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
