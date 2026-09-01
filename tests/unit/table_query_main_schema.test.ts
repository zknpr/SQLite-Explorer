import './vscode_mock_setup';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';

describe('UI table reads use the persistent schema', () => {
  it('does not let a same-named TEMP table intercept fetch or count', async () => {
    const opened = await createDatabaseEngine({ content: null, maxSize: 0 });
    const engine = opened.operations as WasmDatabaseEngine;
    try {
      await engine.executeQuery(
        'CREATE TABLE shadowed_table (value TEXT); ' +
        "INSERT INTO shadowed_table VALUES ('main-one'), ('main-two'); " +
        'CREATE TEMP TABLE shadowed_table (value TEXT); ' +
        "INSERT INTO temp.shadowed_table VALUES ('temp-only')"
      );

      const page = await engine.fetchTableData('shadowed_table', {
        columns: ['value'],
        limit: 10,
        offset: 0
      });
      const count = await engine.fetchTableCount('shadowed_table', {
        columns: ['value']
      });

      assert.deepStrictEqual(page.rows, [['main-one'], ['main-two']]);
      assert.deepStrictEqual(count, { count: 2, isExact: true });

      // Raw SQL is user-authored and must retain ordinary SQLite name
      // resolution, where an unqualified name resolves TEMP first.
      const raw = await engine.executeQuery('SELECT value FROM shadowed_table');
      assert.deepStrictEqual(raw[0].rows, [['temp-only']]);
    } finally {
      engine.shutdown();
    }
  });
});
