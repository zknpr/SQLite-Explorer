
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createDatabaseEngine } from '../../src/core/sqlite-db';

describe('JSON Patch Optimization', () => {
    let engine: any;

    before(async () => {
        const result = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        engine = result.operations;

        await engine.executeQuery("CREATE TABLE data (id INTEGER PRIMARY KEY, content TEXT)");
        await engine.insertRow('data', { id: 1, content: JSON.stringify({ a: 1, b: 2 }) });
        await engine.insertRow('data', { id: 2, content: JSON.stringify({ a: 10, b: 20 }) });
        await engine.insertRow('data', { id: 3, content: JSON.stringify({ a: 100, b: 200 }) });
    });

    it('should use json_patch when updating cell with string patch', async () => {
        // Spy on executeQuery to check SQL
        const originalExecuteQuery = engine.executeQuery.bind(engine);
        const queries: string[] = [];
        engine.executeQuery = async (sql: string, params: any[]) => {
            queries.push(sql);
            return originalExecuteQuery(sql, params);
        };

        const originalPrepare = engine.instance.prepare.bind(engine.instance);
        engine.instance.prepare = (sql: string, params: any[]) => {
            return originalPrepare(sql, params);
        };

        const patch = JSON.stringify({ b: 3, c: 4 });
        await engine.updateCell('data', 1, 'content', null, patch);

        // Verify result
        const result = await originalExecuteQuery("SELECT content FROM data WHERE id = 1");
        const content = JSON.parse(result[0].rows[0][0]);
        assert.deepStrictEqual(content, { a: 1, b: 3, c: 4 });

        // Check if json_patch was used in executeQuery (for updateCell)
        const usesJsonPatch = queries.some(q => q.toLowerCase().includes('json_patch'));
        assert.ok(usesJsonPatch, 'Should use json_patch SQL function');

        // Restore spies
        engine.executeQuery = originalExecuteQuery;
        engine.instance.prepare = originalPrepare;
    });

    it('should use json_patch when updating cell with object patch (regression test)', async () => {
        const originalExecuteQuery = engine.executeQuery.bind(engine);
        const queries: string[] = [];
        engine.executeQuery = async (sql: string, params: any[]) => {
            queries.push(sql);
            return originalExecuteQuery(sql, params);
        };

        const patchObj = { b: 300, c: 400 };
        // Pass object directly (simulating loose JS or intentional usage)
        await engine.updateCell('data', 3, 'content', null, patchObj as any);

        // Verify result
        const result = await originalExecuteQuery("SELECT content FROM data WHERE id = 3");
        const content = JSON.parse(result[0].rows[0][0]);
        assert.deepStrictEqual(content, { a: 100, b: 300, c: 400 });

        const usesJsonPatch = queries.some(q => q.toLowerCase().includes('json_patch'));
        assert.ok(usesJsonPatch, 'Should use json_patch SQL function');

        engine.executeQuery = originalExecuteQuery;
    });

    it('should use json_patch when updating batch cells', async () => {
        // Reset data
        await engine.executeQuery("UPDATE data SET content = ? WHERE id = 2", [JSON.stringify({ a: 10, b: 20 })]);

        const originalPrepare = engine.instance.prepare.bind(engine.instance);
        const preparedStatements: string[] = [];
        engine.instance.prepare = (sql: string, params: any[]) => {
            preparedStatements.push(sql);
            return originalPrepare(sql, params);
        };

        const updates = [
            { rowId: 2, column: 'content', value: JSON.stringify({ b: 30, c: 40 }), operation: 'json_patch' }
        ];

        await engine.updateCellBatch('data', updates);

        // Verify result
        const result = await engine.executeQuery("SELECT content FROM data WHERE id = 2");
        const content = JSON.parse(result[0].rows[0][0]);
        assert.deepStrictEqual(content, { a: 10, b: 30, c: 40 });

        // Check if json_patch was used in prepare (for updateCellBatch)
        const usesJsonPatch = preparedStatements.some(q => q.toLowerCase().includes('json_patch'));
        assert.ok(usesJsonPatch, 'Should use json_patch SQL function for batch update');

        engine.instance.prepare = originalPrepare;
    });

    it('should use json_patch when updating batch cells with object value (regression test)', async () => {
        // Reset data
        await engine.executeQuery("UPDATE data SET content = ? WHERE id = 2", [JSON.stringify({ a: 10, b: 20 })]);

        const updates = [
            { rowId: 2, column: 'content', value: { b: 3000, c: 4000 } as any, operation: 'json_patch' }
        ];

        await engine.updateCellBatch('data', updates);

        // Verify result
        const result = await engine.executeQuery("SELECT content FROM data WHERE id = 2");
        const content = JSON.parse(result[0].rows[0][0]);
        assert.deepStrictEqual(content, { a: 10, b: 3000, c: 4000 });
    });
});
