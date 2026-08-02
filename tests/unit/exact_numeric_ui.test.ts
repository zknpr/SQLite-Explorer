import './vscode_mock_setup';

import { afterEach, it } from 'node:test';
import assert from 'node:assert';

const stateModulePath = '../../core/ui/modules/state.js';
const clipboardModulePath = '../../core/ui/modules/clipboard.js';

let navigatorDescriptor: PropertyDescriptor | undefined;

afterEach(async () => {
    if (navigatorDescriptor) {
        Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    } else {
        delete (globalThis as any).navigator;
    }
    navigatorDescriptor = undefined;
    delete (globalThis as any).document;

    const { state } = await import(stateModulePath);
    state.selectedTableType = null;
    state.tableColumns = [];
    state.gridData = [];
    state.gridExactIntegerTexts = {};
    state.selectedCells = [];
    state.selectedRowIds.clear();
});

it('copies exact numeric sidecar text for single cells, ranges, and selected rows', async () => {
    const writes: string[] = [];
    navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { clipboard: { writeText: async (text: string) => writes.push(text) } }
    });
    (globalThis as any).document = {
        getElementById() { return null; }
    };

    const { state } = await import(stateModulePath);
    const {
        copyCellsToClipboard,
        copySelectedRowsToClipboard
    } = await import(clipboardModulePath);
    state.selectedTableType = 'table';
    state.tableColumns = [{ name: 'value', type: 'INTEGER' }];
    state.gridData = [
        [1, 9007199254740992],
        [2, 9007199254740996]
    ];
    state.gridExactIntegerTexts = {
        0: { 1: '9007199254740993' },
        1: { 1: '9007199254740995' }
    };

    state.selectedCells = [
        { rowIdx: 0, colIdx: 0, rowId: 1, value: 9007199254740992 }
    ];
    await copyCellsToClipboard();

    state.selectedCells = [
        { rowIdx: 0, colIdx: 0, rowId: 1, value: 9007199254740992 },
        { rowIdx: 1, colIdx: 0, rowId: 2, value: 9007199254740996 }
    ];
    await copyCellsToClipboard();

    state.selectedRowIds.add(1);
    state.selectedRowIds.add(2);
    await copySelectedRowsToClipboard();

    assert.deepStrictEqual(writes, [
        '9007199254740993',
        '9007199254740993\n9007199254740995',
        'value\n9007199254740993\n9007199254740995'
    ]);
});
