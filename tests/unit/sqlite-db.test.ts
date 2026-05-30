
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createDatabaseEngine, getNodeFs, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import type { Database } from 'sql.js';

describe('getNodeFs', () => {
  it('should return the fs module in Node.js environment', () => {
    const fs = getNodeFs();
    assert.ok(fs, 'getNodeFs() should return a module in Node.js');
    assert.strictEqual(typeof fs.readFileSync, 'function', 'should have readFileSync');
    assert.strictEqual(typeof fs.writeFileSync, 'function', 'should have writeFileSync');
    assert.strictEqual(typeof fs.statSync, 'function', 'should have statSync');
  });

  it('should return the same module on repeated calls', () => {
    const fs1 = getNodeFs();
    const fs2 = getNodeFs();
    assert.strictEqual(fs1, fs2, 'should return the same fs reference');
  });
});

describe('createDatabaseEngine file reading errors', () => {
  it('should catch and log error for non-existent file', async () => {
    const originalConsoleError = console.error;
    let loggedError: any;
    console.error = (msg: string, err: any) => {
      if (msg === 'Failed to read file in worker:') {
        loggedError = err;
      }
    };
    try {
      await createDatabaseEngine({
        content: null,
        filePath: '/non/existent/path/for/test/db.sqlite',
        maxSize: 1000,
        readOnlyMode: false
      });
      assert.ok(loggedError, 'Should have caught and logged an error');
      assert.strictEqual(loggedError.code, 'ENOENT');
    } finally {
      console.error = originalConsoleError;
    }
  });

  it('should catch and log error when file exceeds maxSize', async () => {
    const fs = require('fs');
    const tempFile = 'test-temp.sqlite';
    fs.writeFileSync(tempFile, 'dummy data for max size test');

    const originalConsoleError = console.error;
    let loggedError: any;
    console.error = (msg: string, err: any) => {
      if (msg === 'Failed to read file in worker:') {
        loggedError = err;
      }
    };

    try {
      await createDatabaseEngine({
        content: null,
        filePath: tempFile,
        maxSize: 1, // extremely small max size
        readOnlyMode: false
      });
      assert.ok(loggedError, 'Should have caught and logged an error');
      assert.strictEqual(loggedError.message, 'File too large');
    } finally {
      console.error = originalConsoleError;
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  });
});

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

  describe('safeRollback', () => {
    it('should attempt a rollback and warn on error', async () => {
      // override executeQuery to simulate error on ROLLBACK
      const originalExecuteQuery = engine.executeQuery.bind(engine);
      let rollbackCalled = false;

      engine.executeQuery = async (sql: string) => {
        if (sql === 'ROLLBACK') {
          rollbackCalled = true;
          throw new Error('Simulated rollback error');
        }
        return originalExecuteQuery(sql);
      };

      let warnCalled = false;
      let warnArgs: any[] = [];
      const originalWarn = console.warn;

      console.warn = (...args) => {
        warnCalled = true;
        warnArgs = args;
      };

      try {
        await engine.safeRollback('testContext');

        assert.ok(rollbackCalled, 'ROLLBACK should have been called');
        assert.ok(warnCalled, 'console.warn should have been called');
        assert.match(warnArgs[0], /Failed to rollback \(testContext\)/);
        assert.strictEqual(warnArgs[1].message, 'Simulated rollback error');
      } finally {
        console.warn = originalWarn;
        engine.executeQuery = originalExecuteQuery; // Restore
      }
    });
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

  describe('executeQuery', () => {

    it('should handle errors in executeQuery iteration and attempt to free statement', async () => {
      let freeCalled = false;
      let freeThrew = false;

      // Mock the WASM Database instance
      const mockDb = {
        iterateStatements: (sql: string) => {
          return [{
            bind: () => {},
            step: () => {
              throw new Error('Simulated iteration error');
            },
            get: () => [],
            getColumnNames: () => [],
            free: () => {
              freeCalled = true;
              throw new Error('Simulated free error');
            }
          }];
        }
      } as unknown as Database;

      const engine = new WasmDatabaseEngine(mockDb as any, 5000);

      const consoleWarnOrig = console.warn;
      let warnedMessage = '';
      console.warn = (msg: string, err: any) => {
        warnedMessage = msg;
        if (err && err.message === 'Simulated free error') {
          freeThrew = true;
        }
      };

      try {
        await assert.rejects(
          async () => {
            await engine.executeQuery('SELECT * FROM dummy');
          },
          (err: Error) => {
            return err.message.includes('Simulated iteration error');
          }
        );

        assert.strictEqual(freeCalled, true, 'currentStmt.free() should have been called');
        assert.strictEqual(freeThrew, true, 'The error in free() should have been caught and warned');
        assert.strictEqual(warnedMessage, 'Failed to free statement on error:', 'Warning message should match');
      } finally {
        console.warn = consoleWarnOrig;
      }
    });

    it('should timeout long running queries', async () => {
      // Create a specific engine instance with a short timeout
      const result = await createDatabaseEngine({
        content: null,
        maxSize: 0,
        readOnlyMode: false,
        queryTimeout: 100 // 100ms timeout
      });
      const timeoutEngine = result.operations!;

      await timeoutEngine.executeQuery("CREATE TABLE timeout_test (id INTEGER PRIMARY KEY, value TEXT)");
      await timeoutEngine.insertRow('timeout_test', { id: 1, value: 'test1' });
      await timeoutEngine.insertRow('timeout_test', { id: 2, value: 'test2' });

      const originalDateNow = Date.now;
      let callCount = 0;

      try {
        Date.now = () => {
          // First call establishes startTime, subsequent calls simulate elapsed time
          if (callCount === 0) {
            callCount++;
            return 1000;
          }
          callCount++;
          // Return a time far in the future to trigger timeout
          return 1000 + 200;
        };

        // This query will hit the while(stmt.step()) loop
        await assert.rejects(
          async () => {
            await timeoutEngine!.executeQuery("SELECT * FROM timeout_test");
          },
          (err: any) => {
            assert.strictEqual(err.message, "Query failed: Query execution timed out after 100ms");
            return true;
          }
        );
      } finally {
        Date.now = originalDateNow;
      }
    });
  });
});
