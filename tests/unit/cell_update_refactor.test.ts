
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import { CellUpdate, ModificationEntry } from '../../src/core/types';

describe('SQLite Engine Cell Update Refactoring', () => {
    let engine: any;

    before(async () => {
        // Initialize with empty DB
        const result = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        engine = result.operations;

        // Setup table
        await engine.executeQuery("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, data TEXT)");
        await engine.insertRow('users', { id: 1, name: 'Alice', data: '{"score": 10}' });
        await engine.insertRow('users', { id: 2, name: 'Bob', data: '{"score": 20}' });
    });

    it('should update single cell', async () => {
        await engine.updateCell('users', 1, 'name', 'AliceUpdated');
        const result = await engine.executeQuery("SELECT name FROM users WHERE id = 1");
        assert.strictEqual(result[0].rows[0][0], 'AliceUpdated');
    });

    it('should update single cell with JSON patch', async () => {
        // Apply patch to data column
        await engine.updateCell('users', 1, 'data', null, '{"score": 15}');
        const result = await engine.executeQuery("SELECT data FROM users WHERE id = 1");
        const data = JSON.parse(result[0].rows[0][0] as string);
        assert.strictEqual(data.score, 15);
    });

    it('should update multiple cells in batch', async () => {
        const updates: CellUpdate[] = [
            { rowId: 1, column: 'name', value: 'AliceBatch' },
            { rowId: 2, column: 'name', value: 'BobBatch' }
        ];
        await engine.updateCellBatch('users', updates);

        const result = await engine.executeQuery("SELECT name FROM users ORDER BY id");
        assert.strictEqual(result[0].rows[0][0], 'AliceBatch');
        assert.strictEqual(result[0].rows[1][0], 'BobBatch');
    });

    it('should update multiple cells with JSON patch in batch', async () => {
        const updates: CellUpdate[] = [
            { rowId: 1, column: 'data', value: '{"score": 25}', operation: 'json_patch' },
            { rowId: 2, column: 'data', value: '{"score": 30}', operation: 'json_patch' }
        ];
        await engine.updateCellBatch('users', updates);

        const result = await engine.executeQuery("SELECT data FROM users ORDER BY id");
        const data1 = JSON.parse(result[0].rows[0][0] as string);
        const data2 = JSON.parse(result[0].rows[1][0] as string);
        assert.strictEqual(data1.score, 25);
        assert.strictEqual(data2.score, 30);
    });

    it('should undo batch cell update', async () => {
        // Setup initial state
        await engine.updateCell('users', 1, 'name', 'AlicePreUndo');
        await engine.updateCell('users', 2, 'name', 'BobPreUndo');

        // Apply batch update (to be undone)
        const updates: CellUpdate[] = [
            { rowId: 1, column: 'name', value: 'AliceNew' },
            { rowId: 2, column: 'name', value: 'BobNew' }
        ];
        await engine.updateCellBatch('users', updates);

        // Verify update
        let result = await engine.executeQuery("SELECT name FROM users ORDER BY id");
        assert.strictEqual(result[0].rows[0][0], 'AliceNew');
        assert.strictEqual(result[0].rows[1][0], 'BobNew');

        // Undo
        const mod: ModificationEntry = {
            modificationType: 'cell_update',
            targetTable: 'users',
            description: 'Batch update',
            affectedCells: [
                { rowId: 1, columnName: 'name', priorValue: 'AlicePreUndo', newValue: 'AliceNew' },
                { rowId: 2, columnName: 'name', priorValue: 'BobPreUndo', newValue: 'BobNew' }
            ]
        };
        await engine.undoModification(mod);

        // Verify undo
        result = await engine.executeQuery("SELECT name FROM users ORDER BY id");
        assert.strictEqual(result[0].rows[0][0], 'AlicePreUndo');
        assert.strictEqual(result[0].rows[1][0], 'BobPreUndo');
    });

    it('should fail transaction on error', async () => {
        const updates: CellUpdate[] = [
             { rowId: 1, column: 'name', value: 'AliceTrans' },
             // Invalid column to force error
             { rowId: 2, column: 'non_existent_column', value: 'BobTrans' }
        ];

        try {
            await engine.updateCellBatch('users', updates);
            assert.fail('Should have thrown');
        } catch (e) {
            // Check that first update was rolled back
            const result = await engine.executeQuery("SELECT name FROM users WHERE id = 1");
            assert.strictEqual(result[0].rows[0][0], 'AlicePreUndo'); // Value from previous test
        }
    });

    it('should validate rowId in updateCell', async () => {
        try {
            await engine.updateCell('users', 'invalid', 'name', 'test');
            assert.fail('Should have thrown invalid rowid');
        } catch (e: any) {
            assert.match(e.message, /Invalid rowid/);
        }
    });

    it('should validate rowId in updateCellBatch', async () => {
        const updates: CellUpdate[] = [
            { rowId: 'invalid', column: 'name', value: 'test' }
        ];
        try {
            await engine.updateCellBatch('users', updates);
            assert.fail('Should have thrown invalid rowid');
        } catch (e: any) {
            assert.match(e.message, /Invalid rowid/);
        }
    });
});
