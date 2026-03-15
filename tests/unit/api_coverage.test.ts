
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations } from '../../src/core/types';

describe('API Coverage', () => {
    let engine: DatabaseOperations;

    before(async () => {
        const result = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        engine = result.operations!;
        await engine.executeQuery("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");
        await engine.insertRow('test', { id: 1, val: 'A' });
        await engine.insertRow('test', { id: 2, val: 'B' });
    });

    it('should fetchTableData using prepare/step/get', async () => {
        const result = await engine.fetchTableData('test', { columns: ['id', 'val'], orderBy: 'id' });
        assert.strictEqual(result.rows.length, 2);
        assert.deepStrictEqual(result.rows[0], [1, 'A']);
        assert.deepStrictEqual(result.rows[1], [2, 'B']);
    });

    it('should updateCellBatch using prepare/run', async () => {
        await engine.updateCellBatch('test', [
            { rowId: 1, column: 'val', value: 'X' },
            { rowId: 2, column: 'val', value: 'Y' }
        ]);

        const result = await engine.fetchTableData('test', { columns: ['val'], orderBy: 'id' });
        assert.deepStrictEqual(result.rows[0], ['X']);
        assert.deepStrictEqual(result.rows[1], ['Y']);
    });
});
