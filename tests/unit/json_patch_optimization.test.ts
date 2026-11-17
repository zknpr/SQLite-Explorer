
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

    it('should apply json patch when updating cell with string patch', async () => {
        const patch = JSON.stringify({ b: 3, c: 4 });
        await engine.updateCell('data', 1, 'content', null, patch);

        // Verify result - patch should merge with existing data
        const result = await engine.executeQuery("SELECT content FROM data WHERE id = 1");
        const content = JSON.parse(result[0].rows[0][0]);
        assert.deepStrictEqual(content, { a: 1, b: 3, c: 4 });
    });

    it('should apply json patch when updating cell with object patch', async () => {
        const patchObj = { b: 300, c: 400 };
        // Pass object directly (simulating loose JS or intentional usage)
        await engine.updateCell('data', 3, 'content', null, patchObj as any);

        // Verify result
        const result = await engine.executeQuery("SELECT content FROM data WHERE id = 3");
        const content = JSON.parse(result[0].rows[0][0]);
        assert.deepStrictEqual(content, { a: 100, b: 300, c: 400 });
    });

    it('should apply json patch when updating batch cells', async () => {
        // Reset data
        await engine.executeQuery("UPDATE data SET content = ? WHERE id = 2", [JSON.stringify({ a: 10, b: 20 })]);

        const updates = [
            { rowId: 2, column: 'content', value: JSON.stringify({ b: 25, d: 5 }), operation: 'json_patch' as const }
        ];

        await engine.updateCellBatch('data', updates);

        // Verify result
        const result = await engine.executeQuery("SELECT content FROM data WHERE id = 2");
        const content = JSON.parse(result[0].rows[0][0]);
        assert.deepStrictEqual(content, { a: 10, b: 25, d: 5 });
    });

    it('keeps integers past 2^53 exact when a JSON object cell is edited', async () => {
        const prior = '{"ids":[9007199254740993,1152921504606846977],"name":"a"}';
        const next = '{"ids":[9007199254740993,1152921504606846977],"name":"b"}';
        await engine.executeQuery("INSERT INTO data (id, content) VALUES (40, ?)", [prior]);

        await engine.updateCellBatch('data', [{ rowId: 40, column: 'content', value: next, operation: 'set' as const }]);

        const result = await engine.executeQuery("SELECT content FROM data WHERE id = 40");
        assert.strictEqual(result[0].rows[0][0], next);
    });

    it('should handle json patch on null/empty cell', async () => {
        await engine.insertRow('data', { id: 4, content: null });

        const patch = JSON.stringify({ x: 1, y: 2 });
        await engine.updateCell('data', 4, 'content', null, patch);

        const result = await engine.executeQuery("SELECT content FROM data WHERE id = 4");
        const content = JSON.parse(result[0].rows[0][0]);
        assert.deepStrictEqual(content, { x: 1, y: 2 });
    });
});
