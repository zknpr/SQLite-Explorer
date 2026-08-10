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
    state.gridOversizedCells = {};
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

it('refuses cell, range, and row copies containing a truncated grid value', async () => {
    const writes: string[] = [];
    const status = { textContent: '' };
    navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { clipboard: { writeText: async (text: string) => writes.push(text) } }
    });
    (globalThis as any).document = {
        getElementById(id: string) { return id === 'statusText' ? status : null; }
    };

    const { state } = await import(stateModulePath);
    const {
        copyCellsToClipboard,
        copySelectedRowsToClipboard
    } = await import(clipboardModulePath);
    state.selectedTableType = 'table';
    state.tableColumns = [
        { name: 'truncated_text', type: 'TEXT' },
        { name: 'ordinary_text', type: 'TEXT' }
    ];
    state.gridData = [[1, 'bounded prefix', 'complete']];
    state.gridOversizedCells = {
        0: { 1: { storageClass: 'text', byteLength: 32 * 1024 * 1024 } }
    };

    state.selectedCells = [
        { rowIdx: 0, colIdx: 0, rowId: 1, value: 'bounded prefix' }
    ];
    await copyCellsToClipboard();
    assert.match(status.textContent, /truncated.*Open Full Content.*[Ee]xport/);

    state.selectedCells = [
        { rowIdx: 0, colIdx: 0, rowId: 1, value: 'bounded prefix' },
        { rowIdx: 0, colIdx: 1, rowId: 1, value: 'complete' }
    ];
    await copyCellsToClipboard();

    state.selectedCells = [];
    state.selectedRowIds.add(1);
    await copySelectedRowsToClipboard();

    assert.deepStrictEqual(writes, []);
});
