
import './vscode_mock_setup';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations, CellUpdate, ModificationEntry } from '../../src/core/types';

describe('WasmDatabaseEngine', () => {
    let engine: DatabaseOperations;

    before(async () => {
        // Initialize with empty DB
        const result = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        engine = result.operations!;

        // Setup table
        await engine.executeQuery("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, data TEXT)");
    });

    it('should update multiple cells in a batch', async () => {
        // Setup initial data
        await engine.executeQuery("DELETE FROM users");
        await engine.insertRow('users', { id: 1, name: 'Alice', age: 30, data: '{}' });
        await engine.insertRow('users', { id: 2, name: 'Bob', age: 25, data: '{}' });

        const updates: CellUpdate[] = [
            { rowId: 1, column: 'name', value: 'Alice Smith' },
            { rowId: 2, column: 'age', value: 26 }
        ];

        await engine.updateCellBatch('users', updates);

        const result = await engine.executeQuery("SELECT * FROM users ORDER BY id");
        const rows = result[0].rows;

        // Alice updated
        assert.strictEqual(rows[0][1], 'Alice Smith');
        assert.strictEqual(rows[0][2], 30); // Age unchanged

        // Bob updated
        assert.strictEqual(rows[1][1], 'Bob'); // Name unchanged
        assert.strictEqual(rows[1][2], 26);
    });

    it('should handle JSON patch updates', async () => {
        // Setup initial data
        await engine.executeQuery("DELETE FROM users");
        await engine.insertRow('users', { id: 1, name: 'Charlie', age: 40, data: '{"a": 1, "b": 2}' });

        const updates: CellUpdate[] = [
            { rowId: 1, column: 'data', value: '{"b": 3, "c": 4}', operation: 'json_patch' }
        ];

        await engine.updateCellBatch('users', updates);

        const result = await engine.executeQuery("SELECT data FROM users WHERE id = 1");
        const dataStr = result[0].rows[0][0] as string;
        const data = JSON.parse(dataStr);

        assert.deepStrictEqual(data, { a: 1, b: 3, c: 4 });
    });

    it('should handle mixed standard and JSON patch updates', async () => {
         // Setup initial data
         await engine.executeQuery("DELETE FROM users");
         await engine.insertRow('users', { id: 1, name: 'David', age: 50, data: '{"x": 10}' });
         await engine.insertRow('users', { id: 2, name: 'Eve', age: 55, data: '{"y": 20}' });

         const updates: CellUpdate[] = [
             { rowId: 1, column: 'name', value: 'David Jones' },
             { rowId: 1, column: 'data', value: '{"x": 11}', operation: 'json_patch' },
             { rowId: 2, column: 'age', value: 56 },
             { rowId: 2, column: 'data', value: '{"z": 30}', operation: 'json_patch' }
         ];

         await engine.updateCellBatch('users', updates);

         const result = await engine.executeQuery("SELECT name, age, data FROM users ORDER BY id");
         const rows = result[0].rows;

         // David
         assert.strictEqual(rows[0][0], 'David Jones');
         assert.strictEqual(rows[0][1], 50); // Age unchanged
         assert.deepStrictEqual(JSON.parse(rows[0][2] as string), { x: 11 });

         // Eve
         assert.strictEqual(rows[1][0], 'Eve');
         assert.strictEqual(rows[1][1], 56);
         assert.deepStrictEqual(JSON.parse(rows[1][2] as string), { y: 20, z: 30 });
    });

    it('should handle empty updates gracefully', async () => {
        await engine.updateCellBatch('users', []);
        assert.ok(true);
    });

    it('should rollback transaction on error', async () => {
        // Setup initial data
        await engine.executeQuery("DELETE FROM users");
        await engine.insertRow('users', { id: 1, name: 'Frank', age: 60, data: '{}' });

        const updates: CellUpdate[] = [
            { rowId: 1, column: 'name', value: 'Frank Sinatra' }, // Valid update
            { rowId: 1, column: 'non_existent_column', value: 'Error' } // Invalid update
        ];

        try {
            await engine.updateCellBatch('users', updates);
            assert.fail('Should have thrown an error');
        } catch (e) {
            assert.ok(e);
        }

        // Verify rollback
        const result = await engine.executeQuery("SELECT name FROM users WHERE id = 1");
        assert.strictEqual(result[0].rows[0][0], 'Frank'); // Should remain original value
    });

    it('should replay modification entries when applyModifications restores a dirty backup', async () => {
        // A hot-exit backup stores edit history, not full database bytes. Restoring
        // that backup must replay each pending entry into the freshly opened
        // in-memory database so later saves contain the recovered edits.
        await engine.executeQuery("DROP TABLE IF EXISTS restored_users");
        await engine.executeQuery("CREATE TABLE restored_users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)");

        const modifications: ModificationEntry[] = [
            {
                description: 'Insert restored row',
                modificationType: 'row_insert',
                targetTable: 'restored_users',
                targetRowId: 1,
                rowData: { id: 1, name: 'Draft', age: 30 }
            },
            {
                description: 'Update restored name',
                modificationType: 'cell_update',
                targetTable: 'restored_users',
                targetRowId: 1,
                targetColumn: 'name',
                priorValue: 'Draft',
                newValue: 'Recovered'
            },
            {
                description: 'Update restored age',
                modificationType: 'cell_update',
                targetTable: 'restored_users',
                affectedCells: [
                    { rowId: 1, columnName: 'age', priorValue: 30, newValue: 31 }
                ]
            }
        ];

        await engine.applyModifications(modifications);

        const result = await engine.executeQuery("SELECT id, name, age FROM restored_users ORDER BY id");
        assert.deepStrictEqual(result[0].rows, [[1, 'Recovered', 31]]);
    });

    it('should stop replaying modifications when the restore signal is already aborted', async () => {
        // The restore caller passes an AbortSignal from VS Code cancellation.
        // A pre-aborted signal must fail loudly before any entry is applied.
        await engine.executeQuery("DROP TABLE IF EXISTS aborted_restore");
        await engine.executeQuery("CREATE TABLE aborted_restore (id INTEGER PRIMARY KEY, name TEXT)");

        const controller = new AbortController();
        controller.abort();

        await assert.rejects(
            () => engine.applyModifications([
                {
                    description: 'Insert aborted row',
                    modificationType: 'row_insert',
                    targetTable: 'aborted_restore',
                    targetRowId: 1,
                    rowData: { id: 1, name: 'Should not exist' }
                }
            ], controller.signal),
            /aborted/i
        );

        const result = await engine.executeQuery("SELECT COUNT(*) FROM aborted_restore");
        assert.strictEqual(result[0].rows[0][0], 0);
    });

    it('should check cancellation before each restored modification is replayed', async () => {
        // This signal flips to aborted after the first replay entry has finished.
        // applyModifications must observe that state at the next loop boundary
        // before starting another forward replay operation.
        await engine.executeQuery("DROP TABLE IF EXISTS boundary_abort_restore");
        await engine.executeQuery("CREATE TABLE boundary_abort_restore (id INTEGER PRIMARY KEY, name TEXT)");

        const originalInsertRow = engine.insertRow.bind(engine);
        const startedRowIds: unknown[] = [];
        engine.insertRow = async (table, data) => {
            startedRowIds.push(data.id);
            return originalInsertRow(table, data);
        };

        let checkCount = 0;
        let isAborted = false;
        const boundarySignal = {
            throwIfAborted() {
                checkCount++;
                if (isAborted) {
                    throw new Error('Replay aborted at loop boundary');
                }
                if (checkCount === 2) {
                    isAborted = true;
                }
            }
        } as AbortSignal;

        try {
            await assert.rejects(
                () => engine.applyModifications([
                    {
                        description: 'Insert first row before abort boundary',
                        modificationType: 'row_insert',
                        targetTable: 'boundary_abort_restore',
                        targetRowId: 1,
                        rowData: { id: 1, name: 'First' }
                    },
                    {
                        description: 'Insert second row after abort boundary',
                        modificationType: 'row_insert',
                        targetTable: 'boundary_abort_restore',
                        targetRowId: 2,
                        rowData: { id: 2, name: 'Second' }
                    }
                ], boundarySignal),
                /Replay aborted at loop boundary/
            );

            assert.deepStrictEqual(startedRowIds, [1]);
            const result = await engine.executeQuery("SELECT COUNT(*) FROM boundary_abort_restore");
            assert.strictEqual(result[0].rows[0][0], 0);
        } finally {
            engine.insertRow = originalInsertRow;
        }
    });
});
