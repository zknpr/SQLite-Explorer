
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDatabaseEngine, createWorkerEndpoint, getNodeFs, WasmDatabaseEngine } from '../../src/core/sqlite-db';
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
  // An unreadable filePath must fail the open. The engine must never fall
  // back to an empty writable database: saving that empty view would
  // overwrite the real file on disk.
  it('rejects for a non-existent file instead of opening an empty database', async () => {
    const missingPath = '/non/existent/path/for/test/db.sqlite';
    await assert.rejects(
      createDatabaseEngine({
        content: null,
        filePath: missingPath,
        maxSize: 1000,
        readOnlyMode: false
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'rejection must be an Error');
        assert.ok(err.message.includes(missingPath), 'message must name the path');
        assert.match(err.message, /ENOENT/, 'message must carry the original FS error');
        const cause = err.cause as NodeJS.ErrnoException | undefined;
        assert.strictEqual(cause?.code, 'ENOENT', 'original FS error must be preserved as cause');
        return true;
      }
    );
  });

  it('rejects when the file exceeds maxSize instead of opening an empty database', async () => {
    const tempDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-db-test-'));
    const tempFile = path.join(tempDir, 'too-large.sqlite');
    nodeFs.writeFileSync(tempFile, 'dummy data for max size test');

    try {
      await assert.rejects(
        createDatabaseEngine({
          content: null,
          filePath: tempFile,
          maxSize: 1, // extremely small max size
          readOnlyMode: false
        }),
        (err: unknown) => {
          assert.ok(err instanceof Error, 'rejection must be an Error');
          assert.ok(err.message.includes(tempFile), 'message must name the path');
          assert.match(err.message, /exceeds the maximum allowed size/);
          assert.ok(err.cause instanceof Error, 'size violation must be preserved as cause');
          return true;
        }
      );
    } finally {
      nodeFs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('still opens a fresh database for a zero-byte file (successful read, legitimately empty)', async () => {
    const tempDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-db-test-'));
    const tempFile = path.join(tempDir, 'empty.sqlite');
    nodeFs.writeFileSync(tempFile, new Uint8Array(0));

    try {
      const result = await createDatabaseEngine({
        content: null,
        filePath: tempFile,
        maxSize: 1000,
        readOnlyMode: false
      });
      const engine = result.operations!;
      try {
        const sets = await engine.executeQuery('SELECT 1');
        assert.strictEqual(sets[0].rows[0][0], 1);
      } finally {
        (engine as WasmDatabaseEngine).shutdown();
      }
    } finally {
      nodeFs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('still opens a fresh database for explicit zero-length content without a filePath', async () => {
    const result = await createDatabaseEngine({
      content: new Uint8Array(0),
      maxSize: 0,
      readOnlyMode: false
    });
    const engine = result.operations!;
    try {
      const sets = await engine.executeQuery('SELECT 1');
      assert.strictEqual(sets[0].rows[0][0], 1);
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('rechecks bytes read after stat and routes a grown file to paged storage', async () => {
    const tempDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-db-test-'));
    const tempFile = path.join(tempDir, 'grew-after-stat.sqlite');
    const seed = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    try {
      await seed.operations!.executeQuery(
        "CREATE TABLE gate_probe (value TEXT); INSERT INTO gate_probe VALUES ('present')"
      );
      nodeFs.writeFileSync(tempFile, await seed.operations!.serializeDatabase());
    } finally {
      (seed.operations as WasmDatabaseEngine).shutdown();
    }

    const originalStat = nodeFs.promises.stat;
    (nodeFs.promises as any).stat = async (candidate: nodeFs.PathLike, ...args: unknown[]) => {
      const actual = await (originalStat as any)(candidate, ...args);
      return String(candidate) === tempFile ? { ...actual, size: 1 } : actual;
    };

    let result: Awaited<ReturnType<typeof createDatabaseEngine>> | undefined;
    try {
      result = await createDatabaseEngine({
        content: null,
        filePath: tempFile,
        maxSize: 0,
        pagedOpenThresholdBytes: 1,
        readOnlyMode: false,
        allowPagedFallback: true
      });
      assert.strictEqual(result.storage, 'paged');
      assert.strictEqual(result.isReadOnly, false);
      await result.operations!.updateCell('gate_probe', 1, 'value', 'edited');
    } finally {
      (nodeFs.promises as any).stat = originalStat;
      (result?.operations as WasmDatabaseEngine | undefined)?.shutdown();
      nodeFs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects provider content whose actual bytes exceed the advertised gate', async () => {
    const seed = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    let content: Uint8Array;
    try {
      await seed.operations!.executeQuery(
        "CREATE TABLE provider_probe (value TEXT); INSERT INTO provider_probe VALUES ('present')"
      );
      content = await seed.operations!.serializeDatabase();
    } finally {
      (seed.operations as WasmDatabaseEngine).shutdown();
    }
    assert.ok(content!.byteLength > 1);

    await assert.rejects(
      createDatabaseEngine({
        content: content!,
        maxSize: 1,
        readOnlyMode: false,
        allowPagedFallback: false
      }),
      /file size \(\d+ bytes\) exceeds the maximum allowed size \(1 bytes\)/
    );
  });
});

describe('createWorkerEndpoint initializeDatabase failure', () => {
  it('leaves no half-initialized engine behind when a re-open fails', async () => {
    const endpoint = createWorkerEndpoint();
    try {
      await endpoint.initializeDatabase('first.db', {
        content: null,
        maxSize: 0,
        readOnlyMode: false
      });
      await endpoint.runQuery('CREATE TABLE t (id INTEGER)');

      // Re-initialization against an unreadable path must reject...
      await assert.rejects(
        endpoint.initializeDatabase('missing.db', {
          content: null,
          filePath: '/non/existent/path/for/test/db.sqlite',
          maxSize: 0,
          readOnlyMode: false
        }),
        /Failed to open database file/
      );

      // ...and must not leave the previous (now shut down) engine reachable:
      // the endpoint reports "no database" rather than serving a dead engine.
      assert.strictEqual(await endpoint.ping(), false);
      await assert.rejects(endpoint.runQuery('SELECT 1'), /No database initialized/);
    } finally {
      endpoint.dispose();
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
        progress_handler: () => {},
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

    it('interrupts a long-running statement before its first row is produced', async () => {
      const result = await createDatabaseEngine({
        content: null,
        maxSize: 0,
        readOnlyMode: false,
        queryTimeout: 20
      });
      const timeoutEngine = result.operations!;
      const startedAt = performance.now();

      try {
        await assert.rejects(
          timeoutEngine.executeQuery(
            'WITH RECURSIVE counter(value) AS (' +
            'VALUES(1) UNION ALL SELECT value + 1 FROM counter WHERE value < 10000000' +
            ') SELECT sum(value) FROM counter'
          ),
          (err: Error) => {
            assert.strictEqual(
              err.message,
              'Query failed: Query execution timed out after 20ms'
            );
            return true;
          }
        );
      } finally {
        (timeoutEngine as WasmDatabaseEngine).shutdown();
      }

      assert.ok(
        performance.now() - startedAt < 500,
        'recursive CTE completed before timeout rejection instead of being interrupted'
      );
    });
  });
});
