import './vscode_mock_setup';

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert';
import * as vscode from 'vscode';

import { HostBridge } from '../../src/hostBridge';

const stateModulePath = '../../core/ui/modules/state.js';
const apiModulePath = '../../core/ui/modules/api.js';
const gridActionsModulePath = '../../core/ui/modules/grid-actions.js';

function makeRows(rowCount: number, columnCount = 1) {
    return Array.from({ length: rowCount }, (_, rowIdx) => [
        rowIdx + 1,
        ...Array.from({ length: columnCount }, (_unused, colIdx) => `${rowIdx}:${colIdx}`)
    ]);
}

function installDocumentStub() {
    const statusText = { textContent: '' };
    (globalThis as any).document = {
        getElementById(id: string) {
            return id === 'statusText' ? statusText : null;
        },
        querySelector() { return null; },
        querySelectorAll() { return []; }
    };
    (globalThis as any).CSS = { escape: (value: string) => value };
    return statusText;
}

function createMouseEvent(overrides: Record<string, unknown> = {}) {
    return {
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        stopPropagation() {},
        preventDefault() {},
        ...overrides
    };
}

async function resetState() {
    const { state } = await import(stateModulePath);
    state.selectedTable = null;
    state.selectedTableType = null;
    state.tableColumns = [];
    state.gridData = [];
    state.isLoadingData = false;
    state.isSavingCell = false;
    state.isTransitioningEdit = false;
    state.editingCellInfo = null;
    state.selectedCells = [];
    state.selectedRowIds = new Set();
    state.selectedColumns = new Set();
    state.lastSelectedCell = null;
    state.lastSelectedColumnIndex = null;
    state.lastSelectedRowIndex = null;
    state.selectedTableIdentity = null;
    state.gridExactIntegerTexts = {};
    state.gridOversizedCells = {};
    state.gridReadOnlyRowReasons = {};
}

describe('large selection allocation guard', () => {
    afterEach(async () => {
        delete (globalThis as any).document;
        delete (globalThis as any).CSS;
        await resetState();
        mock.reset();
    });

    it('asks with serializable row metadata before selecting more than 10,000 rows', async () => {
        installDocumentStub();
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { onSelectAllClick } = await import(gridActionsModulePath);
        const originalConfirm = (backendApi as any).confirmLargeSelection;
        const calls: unknown[][] = [];
        (backendApi as any).confirmLargeSelection = async (...args: unknown[]) => {
            calls.push(args);
            return false;
        };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = makeRows(10_001);

        try {
            await onSelectAllClick(createMouseEvent());
            assert.deepStrictEqual(calls, [[10_001, 'rows']]);
            assert.strictEqual(calls.flat().some(value => typeof value === 'function'), false);
            assert.strictEqual(state.selectedRowIds.size, 0);
        } finally {
            (backendApi as any).confirmLargeSelection = originalConfirm;
        }
    });

    it('does not allocate a cancelled large column selection', async () => {
        installDocumentStub();
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { onColumnHeaderClick } = await import(gridActionsModulePath);
        const originalConfirm = (backendApi as any).confirmLargeSelection;
        const calls: unknown[][] = [];
        (backendApi as any).confirmLargeSelection = async (...args: unknown[]) => {
            calls.push(args);
            return false;
        };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = makeRows(10_001);

        try {
            await onColumnHeaderClick(createMouseEvent(), 'value');
            assert.deepStrictEqual(calls, [[10_001, 'cells']]);
            assert.deepStrictEqual(state.selectedCells, []);
            assert.deepStrictEqual([...state.selectedColumns], []);
        } finally {
            (backendApi as any).confirmLargeSelection = originalConfirm;
        }
    });

    it('allocates a confirmed large row selection', async () => {
        installDocumentStub();
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { onSelectAllClick } = await import(gridActionsModulePath);
        const originalConfirm = (backendApi as any).confirmLargeSelection;
        (backendApi as any).confirmLargeSelection = async () => true;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = makeRows(10_001);

        try {
            await onSelectAllClick(createMouseEvent());
            assert.strictEqual(state.selectedRowIds.size, 10_001);
        } finally {
            (backendApi as any).confirmLargeSelection = originalConfirm;
        }
    });

    it('preserves the existing cell selection when a large rectangle is cancelled', async () => {
        installDocumentStub();
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { onCellClick } = await import(gridActionsModulePath);
        const originalConfirm = (backendApi as any).confirmLargeSelection;
        const calls: unknown[][] = [];
        (backendApi as any).confirmLargeSelection = async (...args: unknown[]) => {
            calls.push(args);
            return false;
        };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = Array.from(
            { length: 100 },
            (_, index) => ({ name: `c${index}`, type: 'TEXT' })
        );
        state.gridData = makeRows(101, 100);
        state.lastSelectedCell = { rowIdx: 0, colIdx: 0 };
        state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 1, value: '0:0' }];

        try {
            await onCellClick(createMouseEvent({ shiftKey: true }), 100, 99, 101);
            assert.deepStrictEqual(calls, [[10_100, 'cells']]);
            assert.deepStrictEqual(state.selectedCells, [
                { rowIdx: 0, colIdx: 0, rowId: 1, value: '0:0' }
            ]);
        } finally {
            (backendApi as any).confirmLargeSelection = originalConfirm;
        }
    });

    it('refuses a rectangle above the hard allocation limit without opening a dialog', async () => {
        const statusText = installDocumentStub();
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { onCellClick } = await import(gridActionsModulePath);
        const originalConfirm = (backendApi as any).confirmLargeSelection;
        let confirmCalls = 0;
        (backendApi as any).confirmLargeSelection = async () => {
            confirmCalls++;
            return true;
        };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = Array.from(
            { length: 100 },
            (_, index) => ({ name: `c${index}`, type: 'TEXT' })
        );
        state.gridData = makeRows(1_001, 100);
        state.lastSelectedCell = { rowIdx: 0, colIdx: 0 };
        state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 1, value: '0:0' }];

        try {
            await onCellClick(createMouseEvent({ shiftKey: true }), 1_000, 99, 1_001);
            assert.strictEqual(confirmCalls, 0);
            assert.strictEqual(state.selectedCells.length, 1);
            assert.match(statusText.textContent, /100[,.]100 cells/);
            assert.match(statusText.textContent, /Export/i);
        } finally {
            (backendApi as any).confirmLargeSelection = originalConfirm;
        }
    });

    it('drops an approved request when its rendered grid changed during the dialog', async () => {
        installDocumentStub();
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { onSelectAllClick } = await import(gridActionsModulePath);
        const originalConfirm = (backendApi as any).confirmLargeSelection;
        let resolveConfirmation!: (value: boolean) => void;
        (backendApi as any).confirmLargeSelection = () => new Promise<boolean>(resolve => {
            resolveConfirmation = resolve;
        });
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = makeRows(10_001);

        try {
            const pending = onSelectAllClick(createMouseEvent());
            await Promise.resolve();
            state.gridData = [[99, 'replacement page']];
            resolveConfirmation(true);
            await pending;
            assert.strictEqual(state.selectedRowIds.size, 0);
        } finally {
            (backendApi as any).confirmLargeSelection = originalConfirm;
        }
    });

    it('fails closed when confirmation rejects with a non-Error value', async () => {
        const statusText = installDocumentStub();
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { onSelectAllClick } = await import(gridActionsModulePath);
        const originalConfirm = (backendApi as any).confirmLargeSelection;
        mock.method(console, 'error', () => {});
        (backendApi as any).confirmLargeSelection = async () => Promise.reject(null);
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = makeRows(10_001);

        try {
            await onSelectAllClick(createMouseEvent());
            assert.strictEqual(state.selectedRowIds.size, 0);
            assert.strictEqual(statusText.textContent, 'Selection cancelled: null');
        } finally {
            (backendApi as any).confirmLargeSelection = originalConfirm;
        }
    });

    it('returns a boolean decision from the host without receiving a callback', async () => {
        const bridge = new HostBridge(
            { webviews: new Map(), context: {} } as any,
            {} as any
        );
        let warningArgs: unknown[] = [];
        mock.method(vscode.l10n, 't', (message: string, ...args: unknown[]) => (
            message.replace(/\{(\d+)\}/g, (_match, index) => String(args[Number(index)]))
        ));
        mock.method(vscode.window, 'showWarningMessage', async (...args: unknown[]) => {
            warningArgs = args;
            return { title: 'Continue', value: true };
        });

        const result = await (bridge as any).confirmLargeSelection(10_001, 'cells');

        assert.strictEqual(result, true);
        assert.strictEqual(warningArgs.some(value => typeof value === 'function'), false);
        assert.match(String((warningArgs[1] as any).detail), /10[,.]001 cells/);
    });
});
