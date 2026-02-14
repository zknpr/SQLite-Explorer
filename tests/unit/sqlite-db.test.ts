
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createDatabaseEngine } from '../../src/core/sqlite-db';

describe('WasmDatabaseEngine', () => {
  let engine: any;

  before(async () => {
    // Initialize with empty DB
    const result = await createDatabaseEngine({
      content: null,
      maxSize: 0,
      readOnlyMode: false
    });
    engine = result.operations;

    // Setup initial table
    await engine.executeQuery("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
    await engine.insertRow('users', { id: 1, name: 'Alice' });
  });

  describe('addColumn', () => {
    it('should add a new column with default NULL', async () => {
      await engine.addColumn('users', 'email', 'TEXT');
      const info = await engine.getTableInfo('users');
      const col = info.find((c: any) => c.identifier === 'email');
      assert.ok(col, 'Column email should exist');
      assert.strictEqual(col.declaredType, 'TEXT');

      // Verify default value is NULL for existing rows
      const rows = await engine.executeQuery("SELECT email FROM users WHERE id = 1");
      assert.strictEqual(rows[0].rows[0][0], null);
    });

    it('should add a column with a specific default string value', async () => {
      await engine.addColumn('users', 'status', 'TEXT', 'active');
      const info = await engine.getTableInfo('users');
      const col = info.find((c: any) => c.identifier === 'status');
      assert.ok(col, 'Column status should exist');

      // Verify default value was applied to existing rows
      const rows = await engine.executeQuery("SELECT status FROM users WHERE id = 1");
      assert.strictEqual(rows[0].rows[0][0], 'active');
    });

    it('should add a column with a numeric default value', async () => {
      await engine.addColumn('users', 'points', 'INTEGER', '100');
      const rows = await engine.executeQuery("SELECT points FROM users WHERE id = 1");
      assert.strictEqual(rows[0].rows[0][0], 100);
    });

    it('should add a column with a float default value', async () => {
      await engine.addColumn('users', 'score', 'REAL', '95.5');
      const rows = await engine.executeQuery("SELECT score FROM users WHERE id = 1");
      assert.strictEqual(rows[0].rows[0][0], 95.5);
    });

    it('should add a column with a default value containing quotes', async () => {
      await engine.addColumn('users', 'quote', 'TEXT', "O'Reilly");
      const rows = await engine.executeQuery("SELECT quote FROM users WHERE id = 1");
      assert.strictEqual(rows[0].rows[0][0], "O'Reilly");
    });

    it('should fail when adding a column with invalid SQL type', async () => {
      try {
        await engine.addColumn('users', 'bad_col', 'VARCHAR(255); DROP TABLE users');
        assert.fail('Should have thrown error for invalid type');
      } catch (err: any) {
        assert.match(err.message, /Invalid SQL type/);
      }
    });

    it('should fail when adding a column that already exists', async () => {
      try {
        await engine.addColumn('users', 'name', 'TEXT');
        assert.fail('Should have thrown error for duplicate column');
      } catch (err: any) {
        assert.match(err.message, /duplicate column name/i);
      }
    });
  });

  describe('fetchTableData', () => {
    it('should correctly filter with globalFilter and implicit columns (*)', async () => {
      // Create a test table for this case
      await engine.executeQuery("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, description TEXT)");
      await engine.insertRow('items', { id: 1, name: 'Apple', description: 'Red fruit' });
      await engine.insertRow('items', { id: 2, name: 'Banana', description: 'Yellow fruit' });

      const result = await engine.fetchTableData('items', {
        columns: ['*'],
        globalFilter: 'Yellow'
      });

      assert.strictEqual(result.rows.length, 1);
      assert.strictEqual(result.rows[0][1], 'Banana');
    });

    it('should correctly count with globalFilter and implicit columns (*)', async () => {
       const count = await engine.fetchTableCount('items', {
         columns: ['*'],
         globalFilter: 'fruit'
       });
       assert.strictEqual(count, 2);

       const countYellow = await engine.fetchTableCount('items', {
        columns: ['*'],
        globalFilter: 'Yellow'
      });
      assert.strictEqual(countYellow, 1);
    });
  });
});
