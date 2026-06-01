
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

    it('should undo single JSON patch edits without clobbering concurrent sibling keys', async () => {
        await engine.executeQuery("DELETE FROM users");

        const priorValue = JSON.stringify({ status: 'draft', owner: 'ada' });
        const forwardPatch = JSON.stringify({ status: 'published' });
        const concurrentPatch = JSON.stringify({ reviewer: 'grace' });
        await engine.insertRow('users', { id: 1, name: 'Patch Undo', age: 41, data: priorValue });

        // The first edit is the tracked modification; the second edit happens before undo.
        await engine.updateCell('users', 1, 'data', null, forwardPatch);
        await engine.updateCell('users', 1, 'data', null, concurrentPatch);

        await engine.undoModification({
            modificationType: 'cell_update',
            description: 'Undo JSON patch',
            targetTable: 'users',
            targetRowId: 1,
            targetColumn: 'data',
            priorValue,
            newValue: forwardPatch,
            operation: 'json_patch'
        });

        const result = await engine.executeQuery("SELECT data FROM users WHERE id = 1");
        assert.deepStrictEqual(JSON.parse(result[0].rows[0][0] as string), {
            status: 'draft',
            owner: 'ada',
            reviewer: 'grace'
        });
    });

    it('should undo batch JSON patch edits with per-cell inverse patches', async () => {
        await engine.executeQuery("DELETE FROM users");

        const rowOnePrior = JSON.stringify({ count: 1, stable: 'one' });
        const rowTwoPrior = JSON.stringify({ count: 10, stable: 'two' });
        const rowOnePatch = JSON.stringify({ count: 2 });
        const rowTwoPatch = JSON.stringify({ count: 11 });
        await engine.insertRow('users', { id: 1, name: 'Batch One', age: 20, data: rowOnePrior });
        await engine.insertRow('users', { id: 2, name: 'Batch Two', age: 21, data: rowTwoPrior });

        // Both cells receive tracked patches, then independent sibling patches before undo.
        await engine.updateCellBatch('users', [
            { rowId: 1, column: 'data', value: rowOnePatch, operation: 'json_patch' },
            { rowId: 2, column: 'data', value: rowTwoPatch, operation: 'json_patch' }
        ]);
        await engine.updateCellBatch('users', [
            { rowId: 1, column: 'data', value: JSON.stringify({ concurrent: 'row-one' }), operation: 'json_patch' },
            { rowId: 2, column: 'data', value: JSON.stringify({ concurrent: 'row-two' }), operation: 'json_patch' }
        ]);

        await engine.undoModification({
            modificationType: 'cell_update',
            description: 'Undo batch JSON patch',
            targetTable: 'users',
            affectedCells: [
                { rowId: 1, columnName: 'data', priorValue: rowOnePrior, newValue: rowOnePatch, operation: 'json_patch' },
                { rowId: 2, columnName: 'data', priorValue: rowTwoPrior, newValue: rowTwoPatch, operation: 'json_patch' }
            ]
        });

        const result = await engine.executeQuery("SELECT id, data FROM users ORDER BY id");
        assert.deepStrictEqual(JSON.parse(result[0].rows[0][1] as string), {
            count: 1,
            stable: 'one',
            concurrent: 'row-one'
        });
        assert.deepStrictEqual(JSON.parse(result[0].rows[1][1] as string), {
            count: 10,
            stable: 'two',
            concurrent: 'row-two'
        });
    });

    it('should restore NULL when undoing a JSON patch edit whose prior value was NULL', async () => {
        await engine.executeQuery("DELETE FROM users");

        const forwardPatch = JSON.stringify({ added: 'value' });
        await engine.insertRow('users', { id: 1, name: 'Null Prior', age: 42, data: null });
        await engine.updateCell('users', 1, 'data', null, forwardPatch);

        await engine.undoModification({
            modificationType: 'cell_update',
            description: 'Undo JSON patch on NULL',
            targetTable: 'users',
            targetRowId: 1,
            targetColumn: 'data',
            priorValue: null,
            newValue: forwardPatch,
            operation: 'json_patch'
        });

        const result = await engine.executeQuery("SELECT data FROM users WHERE id = 1");
        assert.strictEqual(result[0].rows[0][0], null);
    });

    it('should value-replace undo when the forward JSON patch was a scalar document replacement', async () => {
        await engine.executeQuery("DELETE FROM users");

        const priorValue = JSON.stringify({ a: 1 });
        const forwardPatch = '5';
        await engine.insertRow('users', { id: 1, name: 'Scalar Patch', age: 43, data: priorValue });
        await engine.updateCell('users', 1, 'data', null, forwardPatch);

        // A later write makes a json_patch inverse observable: merge undo would preserve extra, value-replace will not.
        await engine.updateCell('users', 1, 'data', JSON.stringify({ extra: 'concurrent' }));

        await engine.undoModification({
            modificationType: 'cell_update',
            description: 'Undo scalar JSON patch',
            targetTable: 'users',
            targetRowId: 1,
            targetColumn: 'data',
            priorValue,
            newValue: forwardPatch,
            operation: 'json_patch'
        });

        const result = await engine.executeQuery("SELECT data FROM users WHERE id = 1");
        assert.deepStrictEqual(JSON.parse(result[0].rows[0][0] as string), { a: 1 });
    });

    it('should value-replace undo when restoring a prior explicit null JSON leaf', async () => {
        await engine.executeQuery("DELETE FROM users");

        const priorValue = JSON.stringify({ a: null, b: 1 });
        const forwardPatch = JSON.stringify({ a: 2 });
        await engine.insertRow('users', { id: 1, name: 'Explicit Null Leaf', age: 44, data: priorValue });
        await engine.updateCell('users', 1, 'data', null, forwardPatch);

        await engine.undoModification({
            modificationType: 'cell_update',
            description: 'Undo explicit null JSON leaf',
            targetTable: 'users',
            targetRowId: 1,
            targetColumn: 'data',
            priorValue,
            newValue: forwardPatch,
            operation: 'json_patch'
        });

        const result = await engine.executeQuery("SELECT data FROM users WHERE id = 1");
        assert.deepStrictEqual(JSON.parse(result[0].rows[0][0] as string), { a: null, b: 1 });
        assert.ok(Object.prototype.hasOwnProperty.call(JSON.parse(result[0].rows[0][0] as string), 'a'));
    });

    it('should undo nested JSON patch additions without deleting concurrent nested siblings', async () => {
        await engine.executeQuery("DELETE FROM users");

        const priorValue = JSON.stringify({});
        const forwardPatch = JSON.stringify({ meta: { reviewed: true } });
        const concurrentPatch = JSON.stringify({ meta: { note: 'keep' } });
        await engine.insertRow('users', { id: 1, name: 'Nested Add', age: 45, data: priorValue });
        await engine.updateCell('users', 1, 'data', null, forwardPatch);
        await engine.updateCell('users', 1, 'data', null, concurrentPatch);

        await engine.undoModification({
            modificationType: 'cell_update',
            description: 'Undo nested JSON addition',
            targetTable: 'users',
            targetRowId: 1,
            targetColumn: 'data',
            priorValue,
            newValue: forwardPatch,
            operation: 'json_patch'
        });

        const result = await engine.executeQuery("SELECT data FROM users WHERE id = 1");
        assert.deepStrictEqual(JSON.parse(result[0].rows[0][0] as string), {
            meta: { note: 'keep' }
        });
    });

    it('should fall back to value replacement when single-cell JSON patch undo sees non-JSON text', async () => {
        await engine.executeQuery("DELETE FROM users");

        const priorValue = JSON.stringify({ status: 'draft', owner: 'ada' });
        const forwardPatch = JSON.stringify({ status: 'published' });
        await engine.insertRow('users', { id: 1, name: 'Malformed Single', age: 46, data: priorValue });
        await engine.updateCell('users', 1, 'data', null, forwardPatch);
        await engine.updateCell('users', 1, 'data', 'plain text');

        await engine.undoModification({
            modificationType: 'cell_update',
            description: 'Undo malformed single JSON patch',
            targetTable: 'users',
            targetRowId: 1,
            targetColumn: 'data',
            priorValue,
            newValue: forwardPatch,
            operation: 'json_patch'
        });

        const result = await engine.executeQuery("SELECT data FROM users WHERE id = 1");
        assert.deepStrictEqual(JSON.parse(result[0].rows[0][0] as string), {
            status: 'draft',
            owner: 'ada'
        });
    });

    it('should fall back per cell when batch JSON patch undo sees non-JSON text', async () => {
        await engine.executeQuery("DELETE FROM users");

        const rowOnePrior = JSON.stringify({ status: 'draft', stable: 'one' });
        const rowTwoPrior = JSON.stringify({ status: 'draft', stable: 'two' });
        const forwardPatch = JSON.stringify({ status: 'published' });
        await engine.insertRow('users', { id: 1, name: 'Malformed Batch One', age: 47, data: rowOnePrior });
        await engine.insertRow('users', { id: 2, name: 'Malformed Batch Two', age: 48, data: rowTwoPrior });
        await engine.updateCellBatch('users', [
            { rowId: 1, column: 'data', value: forwardPatch, operation: 'json_patch' },
            { rowId: 2, column: 'data', value: forwardPatch, operation: 'json_patch' }
        ]);
        await engine.updateCell('users', 1, 'data', 'plain text');
        await engine.updateCell('users', 2, 'data', null, JSON.stringify({ concurrent: 'survives' }));

        await engine.undoModification({
            modificationType: 'cell_update',
            description: 'Undo malformed batch JSON patch',
            targetTable: 'users',
            affectedCells: [
                { rowId: 1, columnName: 'data', priorValue: rowOnePrior, newValue: forwardPatch, operation: 'json_patch' },
                { rowId: 2, columnName: 'data', priorValue: rowTwoPrior, newValue: forwardPatch, operation: 'json_patch' }
            ]
        });

        const result = await engine.executeQuery("SELECT id, data FROM users ORDER BY id");
        assert.deepStrictEqual(JSON.parse(result[0].rows[0][1] as string), {
            status: 'draft',
            stable: 'one'
        });
        assert.deepStrictEqual(JSON.parse(result[0].rows[1][1] as string), {
            status: 'draft',
            stable: 'two',
            concurrent: 'survives'
        });
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
