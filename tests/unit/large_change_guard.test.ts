import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import * as vscode from 'vscode';
import { HostBridge } from '../../src/hostBridge';

Object.assign(globalThis, { acquireVsCodeApi: () => ({ getState() {}, setState() {}, postMessage() {} }) });
const stateModulePath = '../../core/ui/modules/state.js';
const apiModulePath = '../../core/ui/modules/api.js';
const clipboardModulePath = '../../core/ui/modules/clipboard.js';

afterEach(() => { mock.restoreAll(); delete (globalThis as any).document; });

for (const decision of ['cancel', 'switch', 'reload']) it(`does not clear cells after a large-change ${decision}`, async () => {
    const { state } = await import(stateModulePath);
    const { backendApi } = await import(apiModulePath);
    const { clearSelectedCellValues } = await import(clipboardModulePath);
    Object.assign(state, {
        selectedTable: 'items', selectedTableType: 'table', selectedTableIdentity: { kind: 'rowid' },
        isReadOnly: false, isDbConnected: true, isGridReloading: false,
        tableColumns: [{ name: 'value', type: 'TEXT', notnull: 0 }],
        gridData: Array.from({ length: 1001 }, (_, index) => [index + 1, 'original']),
        selectedCells: Array.from({ length: 1001 }, (_, index) => ({ rowIdx: index, colIdx: 0, rowId: index + 1, value: 'original' })),
        gridOversizedCells: {}, gridReadOnlyRowReasons: {}, gridExactIntegerTexts: {},
        connectionGeneration: 1, contentGeneration: 1
    });
    const status = { textContent: '' };
    Object.assign(globalThis, { document: { getElementById(id: string) { return id === 'statusText' ? status : null; } } });
    const originalConfirm = backendApi.confirmLargeChanges, originalUpdate = backendApi.updateCellBatch;
    let confirmations = 0, mutations = 0;
    backendApi.confirmLargeChanges = async (count: number, unit: string) => {
        confirmations++; assert.equal(count, 1001); assert.equal(unit, 'cells');
        if (decision === 'switch') state.selectedTable = 'other';
        if (decision === 'reload') state.connectionGeneration++;
        return decision !== 'cancel';
    };
    backendApi.updateCellBatch = async () => { mutations++; throw new Error('Unconfirmed mutation reached the backend'); };
    try {
        await clearSelectedCellValues();
        assert.equal(confirmations, 1);
        assert.equal(mutations, 0);
        assert.equal(state.selectedCells.length, 1001);
        assert.ok(state.gridData.every((row: unknown[]) => row[1] === 'original'));
        assert.match(status.textContent, /cancelled/i);
    } finally { backendApi.confirmLargeChanges = originalConfirm; backendApi.updateCellBatch = originalUpdate; }
});

it('names the affected count in the host large-change dialog and handles Cancel as false', async () => {
    const bridge = new HostBridge({ webviews: new Map(), context: {} } as never, {} as never);
    const warning = mock.method(vscode.window, 'showWarningMessage', async () => undefined);
    assert.equal(await bridge.confirmLargeChanges(1001, 'cells'), false);
    assert.match((warning.mock.calls[0].arguments[1] as { detail: string }).detail, /1,001 cells/);
    await assert.rejects(bridge.confirmLargeChanges(-1, 'cells'), /count/);
});
