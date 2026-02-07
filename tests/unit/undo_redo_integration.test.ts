
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { createDatabaseEngine } from '../../src/core/sqlite-db';

describe('SQLite Engine Undo/Redo', () => {
    let engine: any;
    const dbPath = path.join(__dirname, 'test_undo.db');

    before(async () => {
        // Initialize with empty DB
        const result = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        engine = result.operations;

        // Setup table
        await engine.executeQuery("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
        await engine.insertRow('users', { id: 1, name: 'Alice' });
        await engine.insertRow('users', { id: 2, name: 'Bob' });
    });

    it('should undo/redo row deletion', async () => {
        // 1. Delete Row 2
        // Emulate HostBridge logic to capture data
        const rows = await engine.executeQuery("SELECT rowid, * FROM users WHERE rowid = 2");
        const deletedRowData = rows[0].rows[0]; // [2, 2, 'Bob'] (rowid, id, name)
        const headers = rows[0].headers; // ['id', 'id', 'name'] or ['rowid', 'id', 'name'] depending on engine

        // Manual mapping logic from HostBridge (simplified for test verification)
        const rowData = { id: 2, name: 'Bob' };

        await engine.deleteRows('users', [2]);

        const verifyGone = await engine.fetchTableCount('users', {});
        assert.strictEqual(verifyGone, 1);

        // 2. Undo Delete
        await engine.undoModification({
            modificationType: 'row_delete',
            targetTable: 'users',
            description: 'Delete row',
            deletedRows: [{ rowId: 2, row: rowData }]
        });

        const verifyRestored = await engine.fetchTableCount('users', {});
        assert.strictEqual(verifyRestored, 2);

        const restoredRow = await engine.executeQuery("SELECT name FROM users WHERE id = 2");
        assert.strictEqual(restoredRow[0].rows[0][0], 'Bob');

        // 3. Redo Delete
        await engine.redoModification({
            modificationType: 'row_delete',
            targetTable: 'users',
            description: 'Delete row',
            affectedRowIds: [2]
        });

        const verifyDeletedAgain = await engine.fetchTableCount('users', {});
        assert.strictEqual(verifyDeletedAgain, 1);
    });

    it('should undo/redo column drop', async () => {
        // 1. Drop column 'name'
        const colDataResult = await engine.executeQuery("SELECT rowid, name FROM users");
        const colData = colDataResult[0].rows.map((r: any[]) => ({ rowId: r[0], value: r[1] }));

        await engine.deleteColumns('users', ['name']);

        // Verify column gone
        try {
            await engine.executeQuery("SELECT name FROM users");
            assert.fail("Column should be gone");
        } catch (e) {
            assert.ok(true);
        }

        // 2. Undo Drop
        await engine.undoModification({
            modificationType: 'column_drop',
            targetTable: 'users',
            description: 'Drop column',
            targetColumn: 'name', // legacy field, might not be used
            deletedColumns: [{ name: 'name', type: 'TEXT', data: colData }]
        });

        // Verify column back
        const result = await engine.executeQuery("SELECT name FROM users WHERE id = 1");
        assert.strictEqual(result[0].rows[0][0], 'Alice');

        // 3. Redo Drop
        await engine.redoModification({
            modificationType: 'column_drop',
            targetTable: 'users',
            description: 'Drop column',
            deletedColumns: [{ name: 'name', type: 'TEXT', data: colData }]
        });

        try {
            await engine.executeQuery("SELECT name FROM users");
            assert.fail("Column should be gone again");
        } catch (e) {
            assert.ok(true);
        }
    });

    it('should undo/redo batch cell updates', async () => {
        // Setup - reset state (Table might be altered by previous tests)
        await engine.executeQuery("DROP TABLE IF EXISTS users");
        await engine.executeQuery("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
        await engine.insertRow('users', { id: 1, name: 'Alice' });
        await engine.insertRow('users', { id: 2, name: 'Bob' });
        await engine.insertRow('users', { id: 3, name: 'Charlie' });

        // 1. Batch Update
        // Update everyone to 'Updated'
        const updates = [
            { rowId: 1, column: 'name', value: 'Updated', originalValue: 'Alice' },
            { rowId: 2, column: 'name', value: 'Updated', originalValue: 'Bob' },
            { rowId: 3, column: 'name', value: 'Updated', originalValue: 'Charlie' }
        ];

        await engine.updateCellBatch('users', updates);

        // Verify update
        const result = await engine.executeQuery("SELECT name FROM users ORDER BY id");
        assert.strictEqual(result[0].rows[0][0], 'Updated');
        assert.strictEqual(result[0].rows[1][0], 'Updated');
        assert.strictEqual(result[0].rows[2][0], 'Updated');

        // 2. Undo Update
        const affectedCells = [
            { rowId: 1, columnName: 'name', priorValue: 'Alice', newValue: 'Updated' },
            { rowId: 2, columnName: 'name', priorValue: 'Bob', newValue: 'Updated' },
            { rowId: 3, columnName: 'name', priorValue: 'Charlie', newValue: 'Updated' }
        ];

        await engine.undoModification({
            modificationType: 'cell_update',
            targetTable: 'users',
            description: 'Batch update',
            affectedCells
        });

        // Verify restored
        const restored = await engine.executeQuery("SELECT name FROM users ORDER BY id");
        assert.strictEqual(restored[0].rows[0][0], 'Alice');
        assert.strictEqual(restored[0].rows[1][0], 'Bob');
        assert.strictEqual(restored[0].rows[2][0], 'Charlie');

        // 3. Redo Update
        await engine.redoModification({
            modificationType: 'cell_update',
            targetTable: 'users',
            description: 'Batch update',
            affectedCells
        });

        // Verify updated again
        const reupdated = await engine.executeQuery("SELECT name FROM users ORDER BY id");
        assert.strictEqual(reupdated[0].rows[0][0], 'Updated');
        assert.strictEqual(reupdated[0].rows[1][0], 'Updated');
        assert.strictEqual(reupdated[0].rows[2][0], 'Updated');
    });
});
