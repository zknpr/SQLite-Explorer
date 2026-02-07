
import { test } from 'node:test';
import assert from 'node:assert';
import { createDatabaseEngine } from '../../src/core/sqlite-db';

test('WasmDatabaseEngine timeout test', async (t) => {
  await t.test('should timeout on long running query', async () => {
    const { operations } = await createDatabaseEngine({
      content: null,
      maxSize: 0,
      queryTimeout: 100 // 100ms timeout
    });

    // Recursive CTE that generates infinite rows
    const sql = `
      WITH RECURSIVE cnt(x) AS (
        SELECT 1
        UNION ALL
        SELECT x+1 FROM cnt
      )
      SELECT x FROM cnt;
    `;

    await assert.rejects(async () => {
      await operations.executeQuery(sql);
    }, {
      message: /Query execution timed out after 100ms/
    });
  });

  await t.test('should run fast query successfully', async () => {
      const { operations } = await createDatabaseEngine({
        content: null,
        maxSize: 0,
        queryTimeout: 100
      });

      const result = await operations.executeQuery("SELECT 1 as val");
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].rows[0][0], 1);
  });
});
