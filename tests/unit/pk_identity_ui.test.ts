import './vscode_mock_setup';

import assert from 'node:assert';
import { it } from 'node:test';

import { encodePrimaryKeyRecordId } from '../../src/core/row-identity';
const utilsModulePath = '../../core/ui/modules/utils.js';
const stateModulePath = '../../core/ui/modules/state.js';
const dataUtilsModulePath = '../../core/ui/modules/data-utils.js';

it('passes a canonical primary-key RecordId through the grid edit validator', async () => {
    const { validateRowId } = await import(utilsModulePath);
    const identity = encodePrimaryKeyRecordId(
        [
            { identifier: 'space/key', declaredType: 'BLOB', position: 1 },
            { identifier: 'name', declaredType: 'TEXT', position: 2 }
        ],
        [new Uint8Array([0, 47, 255]), 'item/one']
    );

    assert.strictEqual(validateRowId(identity), identity);
});

it('keeps unsafe INTEGER primary-key input as exact decimal text', async () => {
    const { parseGridInputValue } = await import(utilsModulePath);
    const column = { name: 'id', type: 'INTEGER', isPrimaryKey: true };

    assert.strictEqual(
        parseGridInputValue('9007199254740993', column, true),
        '9007199254740993'
    );
    assert.strictEqual(parseGridInputValue('42', column, true), 42);
    assert.strictEqual(parseGridInputValue('9007199254740993', column, false), '9007199254740993');
});

it('keeps unsafe NUMERIC-affinity primary-key input as exact decimal text', async () => {
    const { parseGridInputValue } = await import(utilsModulePath);

    for (const type of ['NUMERIC', 'DECIMAL(20, 0)']) {
        const column = { name: 'id', type, isPrimaryKey: true };
        assert.strictEqual(
            parseGridInputValue('9223372036854775807', column, true),
            '9223372036854775807',
            type
        );
    }
});

it('keeps numeric-looking TEXT primary-key input as text', async () => {
    const { parseGridInputValue } = await import(utilsModulePath);
    const column = { name: 'id', type: 'TEXT', isPrimaryKey: true };

    assert.strictEqual(
        parseGridInputValue('9007199254740993', column, true),
        '9007199254740993'
    );
    assert.strictEqual(parseGridInputValue('42', column, true), '42');
    assert.strictEqual(parseGridInputValue('42', column, false), '42');
    assert.strictEqual(parseGridInputValue('00123', column, false), '00123');
});

it('keeps unsafe integer input exact outside primary-key columns', async () => {
    const { parseGridInputValue } = await import(utilsModulePath);
    const column = { name: 'amount', type: 'INTEGER', isPrimaryKey: false };

    assert.strictEqual(
        parseGridInputValue('9007199254740993', column, false),
        '9007199254740993'
    );
    assert.strictEqual(parseGridInputValue('42', column, false), 42);
});

it('remaps grid, selected, and pinned state after a primary-key edit', async () => {
    const { state } = await import(stateModulePath);
    const {
        remapDisplayedRowIdentity,
        resolveDisplayedCell
    } = await import(dataUtilsModulePath);
    const columns = [{ identifier: 'id', declaredType: 'TEXT', position: 1 }];
    const oldIdentity = encodePrimaryKeyRecordId(columns, ['before']);
    const newIdentity = encodePrimaryKeyRecordId(columns, ['after']);
    state.selectedTable = 'items';
    state.selectedTableType = 'table';
    state.tableColumns = [{ name: 'id', type: 'TEXT', isPrimaryKey: true }];
    state.gridData = [[oldIdentity, 'before']];
    state.selectedRowIds = new Set([oldIdentity]);
    state.pinnedRowIds = new Set([oldIdentity]);
    state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: oldIdentity, value: 'before' }];

    const currentCell = resolveDisplayedCell('items', oldIdentity, 'id');
    assert.deepStrictEqual(currentCell, { rowIdx: 0, colIdx: 0 });
    remapDisplayedRowIdentity('items', oldIdentity, newIdentity, currentCell);

    assert.strictEqual(state.gridData[0][0], newIdentity);
    assert.deepStrictEqual([...state.selectedRowIds], [newIdentity]);
    assert.deepStrictEqual([...state.pinnedRowIds], [newIdentity]);
    assert.strictEqual(state.selectedCells[0].rowId, newIdentity);
});

it('blocks generated columns from single-cell and batch mutation paths', async () => {
    const { state } = await import(stateModulePath);
    const {
        getBatchSelectionEligibility,
        getCellMutationBlockReason
    } = await import(dataUtilsModulePath);
    state.selectedTable = 'generated_values';
    state.selectedTableType = 'table';
    state.tableColumns = [
        { name: 'base', type: 'INTEGER', isPrimaryKey: false, isGenerated: false },
        { name: 'computed', type: 'INTEGER', isPrimaryKey: false, isGenerated: true }
    ];
    state.gridData = [[1, 7, 14]];
    state.gridReadOnlyRowReasons = {};
    state.gridOversizedCells = {};
    state.selectedCells = [
        { rowIdx: 0, colIdx: 0, rowId: 1, value: 7 },
        { rowIdx: 0, colIdx: 1, rowId: 1, value: 14 }
    ];

    try {
        assert.strictEqual(getCellMutationBlockReason(0, 0), undefined);
        assert.match(getCellMutationBlockReason(0, 1), /generated column/i);
        const eligibility = getBatchSelectionEligibility();
        assert.deepStrictEqual(eligibility.cells, [state.selectedCells[0]]);
        assert.strictEqual(eligibility.readOnlyCount, 1);
        assert.match(eligibility.readOnlyReason, /generated column/i);
    } finally {
        state.selectedTable = null;
        state.tableColumns = [];
        state.gridData = [];
        state.gridReadOnlyRowReasons = {};
        state.gridOversizedCells = {};
        state.selectedCells = [];
    }
});
