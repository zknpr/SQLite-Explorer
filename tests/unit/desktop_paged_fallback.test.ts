import './vscode_mock_setup';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from '../../vendor/sql.js/sql-wasm.js';
import {
  createDatabaseEngine,
  createEngineFromModule,
  createWorkerEndpoint,
  WasmDatabaseEngine
} from '../../src/core/sqlite-db';
import type { WasmEngineModule } from '../../src/core/engine/wasm/WasmDatabaseEngine';
import type { DatabaseInitConfig, DatabaseInitResult } from '../../src/core/types';
import { HostBridge } from '../../src/hostBridge';

/**
 * Desktop WASM-fallback paged routing matrix at the engine layer
 * (createDatabaseEngine / createEngineFromModule / the worker endpoint),
 * against the REAL vendored sql.js fork and real files on disk:
 *
 *   under the gate                        -> buffer, editable, byte-identical
 *   over the gate + openPagedWritable     -> paged writable overlay
 *   over the gate + openPaged only        -> paged read-only snapshot
 *   over the gate + both capabilities absent -> today's size rejection
 *   over the gate + fallback not allowed  -> today's size rejection
 *   over the gate + writable open throws  -> read-only paged fallback
 *   over the gate + both opens throw      -> today's size rejection (cause kept)
 *   over the gate + frame-bearing -wal    -> refused (defensive recheck)
 *   over the gate + WAL-at-rest header    -> paged (no sibling = no frames)
 *   unlimited gate (0)                    -> buffer for everything
 *
 * plus fd lifecycle across successful opens, failed opens, and shutdown.
 */

const wasmBinary = new Uint8Array(
  fs.readFileSync(path.resolve(process.cwd(), 'assets/sqlite3.wasm'))
).buffer;

let SqlJsModule: WasmEngineModule;
let fixtureDir: string;
let dbPath: string;
let dbBytes: Uint8Array;
let walMarkedPath: string;
let framedWalDbPath: string;
let garbagePath: string;
let generationDbPath: string;
let nextGenerationBytes: Uint8Array;

/** Gate placed below every fixture so all of them count as over-limit. */
const TINY_GATE = 4096;

function openFdCount(): number | undefined {
  // /dev/fd lists this process's descriptors on both macOS and Linux.
  try {
    return fs.readdirSync('/dev/fd').length;
  } catch {
    return undefined;
  }
}

before(async () => {
  SqlJsModule = await (initSqlJs as any)({ wasmBinary }) as WasmEngineModule;
  const tmpRoot = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  fixtureDir = fs.mkdtempSync(path.join(tmpRoot, 'paged-fallback-'));

  const db = new (SqlJsModule.Database as any)();
  db.run('CREATE TABLE fixtures (id INTEGER PRIMARY KEY, label TEXT)');
  const insert = db.prepare('INSERT INTO fixtures VALUES (?, ?)');
  for (let index = 1; index <= 2000; index++) {
    insert.run([index, `row-${index}`]);
  }
  insert.free();
  dbBytes = db.export();
  db.close();
  assert.ok(dbBytes.length > TINY_GATE * 4, 'fixture must be well over the tiny gate');

  dbPath = path.join(fixtureDir, 'plain.db');
  fs.writeFileSync(dbPath, Buffer.from(dbBytes));

  // WAL-at-rest: journal_mode=WAL bytes (18/19 == 0x02) with NO sibling
  // -wal — the shape a cleanly closed WAL database has on disk.
  const walMarked = new Uint8Array(dbBytes);
  walMarked[18] = 2;
  walMarked[19] = 2;
  walMarkedPath = path.join(fixtureDir, 'wal-at-rest.db');
  fs.writeFileSync(walMarkedPath, Buffer.from(walMarked));

  // Frame-bearing sibling: only the -wal SIZE matters to the recheck
  // (32-byte header + at least one frame's worth of bytes).
  framedWalDbPath = path.join(fixtureDir, 'framed.db');
  fs.writeFileSync(framedWalDbPath, Buffer.from(dbBytes));
  fs.writeFileSync(`${framedWalDbPath}-wal`, Buffer.alloc(12392, 7));

  garbagePath = path.join(fixtureDir, 'garbage.db');
  fs.writeFileSync(garbagePath, Buffer.alloc(TINY_GATE * 3, 0x41));

  // Keep the early and late rows in different cache regions. Rewriting this
  // same inode after the early read reproduces a single query assembled from
  // one cached old leaf and one newly-read committed leaf.
  const generationDb = new (SqlJsModule.Database as any)();
  generationDb.run(
    'CREATE TABLE generation_fixture (id INTEGER PRIMARY KEY, label TEXT, padding BLOB); ' +
    'WITH RECURSIVE seq(n) AS (' +
    'SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 12000' +
    ') INSERT INTO generation_fixture ' +
    "SELECT n, CASE n WHEN 1 THEN 'oldE' WHEN 12000 THEN 'oldL' ELSE 'same' END, " +
    'zeroblob(1024) FROM seq'
  );
  generationDbPath = path.join(fixtureDir, 'generation.db');
  fs.writeFileSync(generationDbPath, Buffer.from(generationDb.export()));
  generationDb.run(
    "UPDATE generation_fixture SET label = CASE id WHEN 1 THEN 'newE' ELSE 'newL' END " +
    'WHERE id IN (1, 12000)'
  );
  nextGenerationBytes = generationDb.export();
  generationDb.close();
});

after(() => {
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

function overGateConfig(filePath: string, extra: Partial<DatabaseInitConfig> = {}): DatabaseInitConfig {
  return {
    content: null,
    filePath,
    maxSize: TINY_GATE,
    readOnlyMode: false,
    allowPagedFallback: true,
    ...extra
  };
}

/**
 * Clone the real constructor without inheriting any static paged capability.
 * Individual helpers add back exactly the capability needed by that test.
 */
function maskPagedCapabilities(module: WasmEngineModule): WasmEngineModule {
  const Original = module.Database;
  const BufferOnly: any = function BufferOnlyDatabase(...args: unknown[]) {
    return Reflect.construct(Original, args as never[], BufferOnly);
  };
  BufferOnly.prototype = Original.prototype;
  return { ...module, Database: BufferOnly };
}

/** A stale intermediate build: read-only paging exists, writable paging does not. */
function maskOpenPagedWritable(module: WasmEngineModule): WasmEngineModule {
  const masked = maskPagedCapabilities(module);
  (masked.Database as any).openPaged = module.Database.openPaged;
  return masked;
}

/** Writable open fails, but the read-only capability remains usable. */
function throwingOpenPagedWritable(module: WasmEngineModule): WasmEngineModule {
  const masked = maskOpenPagedWritable(module);
  (masked.Database as any).openPagedWritable = () => {
    throw new Error('synthetic writable paged open failure');
  };
  return masked;
}

/** Both paged capabilities fail, forcing the original size rejection. */
function throwingPagedCapabilities(module: WasmEngineModule): WasmEngineModule {
  const masked = throwingOpenPagedWritable(module);
  (masked.Database as any).openPaged = () => {
    throw new Error('synthetic read-only paged open failure');
  };
  return masked;
}

const SIZE_ERROR_PATTERN = /file size \(\d+ bytes\) exceeds the maximum allowed size \(4096 bytes\)/;

describe('desktop paged fallback routing (engine layer)', () => {
  it('keeps under-gate files on the editable buffer path, byte-for-byte', async () => {
    const result = await createDatabaseEngine({
      content: null,
      filePath: dbPath,
      maxSize: dbBytes.length + 1024,
      readOnlyMode: false,
      allowPagedFallback: true
    });
    assert.strictEqual(result.storage, 'memory');
    assert.strictEqual(result.isReadOnly, false);
    const engine = result.operations!;
    try {
      // Unmodified buffer opens serialize back the identical bytes.
      const exported = await engine.serializeDatabase();
      assert.deepStrictEqual(Buffer.from(exported), Buffer.from(dbBytes));
      // And stay editable.
      await engine.updateCell('fixtures', 1, 'label', 'edited');
      const row = await engine.executeQuery('SELECT label FROM fixtures WHERE id = 1');
      assert.strictEqual(row[0].rows[0][0], 'edited');
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('edits and exports an over-gate file through the real openPagedWritable without touching its base', async () => {
    const testPath = path.join(fixtureDir, 'writable-round-trip.db');
    fs.writeFileSync(testPath, Buffer.from(dbBytes));
    const baseBefore = fs.readFileSync(testPath);
    const result = await createDatabaseEngine(overGateConfig(testPath));
    assert.strictEqual(result.storage, 'paged');
    assert.strictEqual(result.isReadOnly, false);
    const engine = result.operations!;
    try {
      await engine.updateCell('fixtures', 1, 'label', 'updated');
      await engine.insertRow('fixtures', { id: 2001, label: 'inserted' });
      await engine.deleteRows('fixtures', [2]);

      assert.deepStrictEqual(
        fs.readFileSync(testPath),
        baseBefore,
        'overlay edits must not modify the base file'
      );

      const bridge = new HostBridge(
        { webviews: new Map(), context: {} } as any,
        { databaseOperations: engine } as any
      );
      const exported = await bridge.exportDb('writable-round-trip.db');
      assert.deepStrictEqual(
        fs.readFileSync(testPath),
        baseBefore,
        'merged export must leave the base file frozen'
      );
      const reopened = new (SqlJsModule.Database as any)(exported);
      try {
        const changed = reopened.exec(
          'SELECT id, label FROM fixtures WHERE id IN (1, 2, 2001) ORDER BY id'
        );
        assert.deepStrictEqual(changed[0].values, [[1, 'updated'], [2001, 'inserted']]);
        assert.deepStrictEqual(reopened.exec('PRAGMA integrity_check')[0].values, [['ok']]);
      } finally {
        reopened.close();
      }
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('warns once before a very large writable paged export materializes the full image', async () => {
    const warnings: string[] = [];
    const instance = new (SqlJsModule.Database as any)();
    const engine = new WasmDatabaseEngine(
      instance,
      5000,
      false,
      (level, ...args) => {
        if (level === 'warn') warnings.push(args.map(String).join(' '));
      },
      {},
      {
        writable: true,
        fileSizeBytes: 1024 * 1024 * 1024,
        exactCountMaxFileBytes: 0
      }
    );
    try {
      await engine.serializeDatabase();
      await engine.serializeDatabase();
      assert.strictEqual(
        warnings.filter(message => /complete merged image.*host memory/i.test(message)).length,
        1
      );
    } finally {
      engine.shutdown();
    }
  });

  it('saves in place through an adjacent temp file, then atomically renames over the frozen base', async () => {
    const testPath = path.join(fixtureDir, 'atomic-save.db');
    fs.writeFileSync(testPath, Buffer.from(dbBytes));
    const baseBefore = fs.readFileSync(testPath);
    const result = await createDatabaseEngine(overGateConfig(testPath));
    const engine = result.operations!;
    const originalRenameSync = fs.renameSync;
    let renameObservation: { temporaryPath: string; targetPath: string } | undefined;
    (fs as any).renameSync = (temporaryPath: fs.PathLike, targetPath: fs.PathLike) => {
      assert.deepStrictEqual(
        fs.readFileSync(testPath),
        baseBefore,
        'the base must remain byte-identical until the atomic replacement'
      );
      assert.notStrictEqual(String(temporaryPath), testPath);
      assert.strictEqual(String(targetPath), fs.realpathSync(testPath));
      assert.ok(fs.statSync(temporaryPath).size > 0, 'the merged temp image must be complete');
      renameObservation = {
        temporaryPath: String(temporaryPath),
        targetPath: String(targetPath)
      };
      return originalRenameSync(temporaryPath, targetPath);
    };
    try {
      await engine.updateCell('fixtures', 1, 'label', 'atomically-saved');
      const writeResult = await engine.writeToFile(testPath) as any;
      assert.deepStrictEqual(writeResult, { requiresReopen: true });
      assert.ok(renameObservation, 'save-in-place must use rename');
      assert.strictEqual(fs.existsSync(renameObservation!.temporaryPath), false);

      const reopened = new (SqlJsModule.Database as any)(fs.readFileSync(testPath));
      try {
        assert.deepStrictEqual(
          reopened.exec('SELECT label FROM fixtures WHERE id = 1')[0].values,
          [['atomically-saved']]
        );
        assert.deepStrictEqual(reopened.exec('PRAGMA integrity_check')[0].values, [['ok']]);
      } finally {
        reopened.close();
      }
    } finally {
      (fs as any).renameSync = originalRenameSync;
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('Save As to a hard-link alias replaces the chosen target without replacing the active base', async () => {
    const testPath = path.join(fixtureDir, 'hard-link-base.db');
    const targetPath = path.join(fixtureDir, 'hard-link-copy.db');
    fs.writeFileSync(testPath, Buffer.from(dbBytes));
    fs.linkSync(testPath, targetPath);
    const result = await createDatabaseEngine(overGateConfig(testPath));
    const engine = result.operations!;
    try {
      await engine.updateCell('fixtures', 1, 'label', 'hard-link-save-as');
      const writeResult = await engine.writeToFile(targetPath);
      assert.deepStrictEqual(writeResult, { requiresReopen: false });
      assert.deepStrictEqual(fs.readFileSync(testPath), Buffer.from(dbBytes));

      const reopenedCopy = new (SqlJsModule.Database as any)(fs.readFileSync(targetPath));
      try {
        assert.deepStrictEqual(
          reopenedCopy.exec('SELECT label FROM fixtures WHERE id = 1')[0].values,
          [['hard-link-save-as']]
        );
      } finally {
        reopenedCopy.close();
      }
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('refuses to overwrite a base pathname atomically replaced by another writer', async () => {
    const testPath = path.join(fixtureDir, 'externally-replaced.db');
    const replacementPath = path.join(fixtureDir, 'external-next.db');
    fs.writeFileSync(testPath, Buffer.from(dbBytes));
    const result = await createDatabaseEngine(overGateConfig(testPath));
    const engine = result.operations!;
    try {
      await engine.updateCell('fixtures', 1, 'label', 'local-overlay');

      // rename(2) leaves the engine's old descriptor readable and internally
      // consistent. Save must also validate that the pathname still resolves
      // to that descriptor's generation or it would clobber this replacement.
      fs.writeFileSync(replacementPath, Buffer.from(nextGenerationBytes));
      fs.renameSync(replacementPath, testPath);

      await assert.rejects(
        engine.writeToFile(testPath),
        /file changed on disk; reload the document/i
      );
      assert.deepStrictEqual(fs.readFileSync(testPath), Buffer.from(nextGenerationBytes));
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('surfaces a clean retryable error when a writable paged export starts mid-transaction', async () => {
    const testPath = path.join(fixtureDir, 'mid-transaction.db');
    fs.writeFileSync(testPath, Buffer.from(dbBytes));
    const result = await createDatabaseEngine(overGateConfig(testPath));
    const engine = result.operations!;
    try {
      await engine.executeQuery('BEGIN');
      await assert.rejects(
        engine.serializeDatabase(),
        /cannot save.*transaction.*retry after the edit completes/i
      );
      await assert.rejects(
        engine.writeToFile(testPath),
        /cannot save.*transaction.*retry after the edit completes/i
      );
      assert.deepStrictEqual(fs.readFileSync(testPath), Buffer.from(dbBytes));
      await engine.executeQuery('ROLLBACK');
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('falls back to read-only openPaged when openPagedWritable is absent', async () => {
    const result = await createEngineFromModule(
      maskOpenPagedWritable(SqlJsModule),
      overGateConfig(dbPath)
    );
    assert.strictEqual(result.storage, 'paged');
    assert.strictEqual(result.isReadOnly, true);
    const engine = result.operations!;
    try {
      await assert.rejects(
        engine.updateCell('fixtures', 1, 'label', 'nope'),
        /read.?only/i
      );
      await assert.rejects(engine.setPragma('cache_size', 123), /read.?only/i);
      await assert.rejects(
        engine.serializeDatabase(),
        /page-on-demand as a[\s\S]*read-only snapshot[\s\S]*maxFileSize/
      );
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('uses read-only paging when the caller explicitly requests read-only mode', async () => {
    const result = await createDatabaseEngine(overGateConfig(dbPath, { readOnlyMode: true }));
    assert.strictEqual(result.storage, 'paged');
    assert.strictEqual(result.isReadOnly, true);
    try {
      await assert.rejects(result.operations!.serializeDatabase(), /read-only snapshot/);
    } finally {
      (result.operations as WasmDatabaseEngine).shutdown();
    }
  });

  it('rejects over-gate files with today\'s size error when both paged capabilities are absent', async () => {
    const masked = maskPagedCapabilities(SqlJsModule);
    await assert.rejects(
      createEngineFromModule(masked, overGateConfig(dbPath)),
      (error: Error) => {
        assert.match(error.message, /Failed to open database file/);
        assert.match(error.message, SIZE_ERROR_PATTERN);
        return true;
      }
    );
  });

  it('rejects over-gate files with today\'s size error when the fallback is not allowed', async () => {
    await assert.rejects(
      createDatabaseEngine(overGateConfig(dbPath, { allowPagedFallback: false })),
      SIZE_ERROR_PATTERN
    );
    await assert.rejects(
      createDatabaseEngine(overGateConfig(dbPath, { allowPagedFallback: undefined })),
      SIZE_ERROR_PATTERN
    );
  });

  it('falls back to read-only paging when the writable paged open throws', async () => {
    const result = await createEngineFromModule(
      throwingOpenPagedWritable(SqlJsModule),
      overGateConfig(dbPath)
    );
    assert.strictEqual(result.storage, 'paged');
    assert.strictEqual(result.isReadOnly, true);
    (result.operations as WasmDatabaseEngine).shutdown();
  });

  it('falls back to the size error and keeps the cause when both paged opens throw', async () => {
    const throwing = throwingPagedCapabilities(SqlJsModule);
    const before = openFdCount();
    await assert.rejects(
      createEngineFromModule(throwing, overGateConfig(dbPath)),
      (error: Error) => {
        assert.match(error.message, SIZE_ERROR_PATTERN);
        // The paged failure rides the cause chain: wrap -> size error -> paged error.
        const sizeError = error.cause as Error;
        assert.match(
          String((sizeError?.cause as Error)?.message),
          /synthetic read-only paged open failure/
        );
        return true;
      }
    );
    if (before !== undefined) {
      assert.strictEqual(openFdCount(), before, 'failed paged open must not leak its fd');
    }
  });

  it('refuses a paged snapshot when a frame-bearing sibling -wal exists', async () => {
    const before = openFdCount();
    await assert.rejects(
      createDatabaseEngine(overGateConfig(framedWalDbPath)),
      (error: Error) => {
        // The deliberate refusal lands on the ordinary size rejection...
        assert.match(error.message, SIZE_ERROR_PATTERN);
        // ...with the WAL refusal preserved on the cause chain.
        const sizeError = error.cause as Error;
        assert.match(
          String((sizeError?.cause as Error)?.message),
          /holds uncheckpointed frames/
        );
        return true;
      }
    );
    if (before !== undefined) {
      assert.strictEqual(openFdCount(), before);
    }
  });

  it('abandons a paged open when a frame-bearing -wal appears during openPaged', async () => {
    const originalStatSync = fs.statSync;
    let walStatCalls = 0;
    let instanceCloseCalls = 0;
    const fakeModule = maskPagedCapabilities(SqlJsModule);
    (fakeModule.Database as any).openPaged = () => ({
      exec: () => [],
      close: () => { instanceCloseCalls += 1; },
      export: () => new Uint8Array(0),
      interrupt: () => {},
      iterateStatements: () => [],
      prepare: () => { throw new Error('prepare must not run during initialization'); },
      progress_handler: () => {}
    });

    (fs as any).statSync = (candidate: fs.PathLike, ...args: unknown[]) => {
      if (String(candidate) === `${dbPath}-wal`) {
        walStatCalls += 1;
        if (walStatCalls === 1) {
          throw Object.assign(new Error('ENOENT: no -wal file'), { code: 'ENOENT' });
        }
        return { size: 33 };
      }
      return (originalStatSync as any)(candidate, ...args);
    };

    let opened: DatabaseInitResult | undefined;
    let rejected: Error | undefined;
    try {
      try {
        opened = await createEngineFromModule(fakeModule, overGateConfig(dbPath));
      } catch (error) {
        rejected = error as Error;
      }
    } finally {
      (fs as any).statSync = originalStatSync;
      (opened?.operations as WasmDatabaseEngine | undefined)?.shutdown();
    }

    assert.strictEqual(opened, undefined, 'the raced WAL must prevent a paged result');
    assert.ok(rejected);
    assert.match(String((rejected.cause as Error)?.cause), /holds uncheckpointed frames/);
    assert.strictEqual(walStatCalls, 2, 'the sibling WAL must be checked again after openPaged');
    assert.strictEqual(instanceCloseCalls, 1, 'the rejected paged instance must be closed');
  });

  it('pages WAL-at-rest headers when no sibling -wal exists', async () => {
    // The engine refuses raw WAL-marked headers through the read-only VFS
    // (SQLITE_CANTOPEN); the hostIo presents them as rollback-journal, so
    // this open must succeed and read correct rows.
    const result = await createDatabaseEngine(overGateConfig(walMarkedPath));
    assert.strictEqual(result.storage, 'paged');
    assert.strictEqual(result.isReadOnly, true);
    const engine = result.operations!;
    try {
      const rows = await engine.executeQuery(
        'SELECT count(*), min(label), max(label) FROM fixtures'
      );
      assert.deepStrictEqual(rows[0].rows[0], [2000, 'row-1', 'row-999']);
      const integrity = await engine.executeQuery('PRAGMA integrity_check');
      assert.deepStrictEqual(integrity[0].rows[0], ['ok']);
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('keeps an unlimited gate (0) on the buffer path for everything', async () => {
    const result = await createDatabaseEngine(overGateConfig(dbPath, { maxSize: 0 }));
    assert.strictEqual(result.storage, 'memory');
    assert.strictEqual(result.isReadOnly, false);
    const engine = result.operations!;
    try {
      await engine.updateCell('fixtures', 1, 'label', 'still-editable');
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('holds exactly one fd for the engine lifetime and releases it on shutdown', async (t) => {
    const before = openFdCount();
    if (before === undefined) {
      t.skip('/dev/fd unavailable');
      return;
    }
    const result = await createDatabaseEngine(overGateConfig(dbPath));
    assert.strictEqual(result.storage, 'paged');
    assert.strictEqual(openFdCount(), before + 1, 'paged open must hold its fd');
    // Shutdown is idempotent and must close the fd exactly once.
    (result.operations as WasmDatabaseEngine).shutdown();
    assert.strictEqual(openFdCount(), before, 'shutdown must release the fd');
    (result.operations as WasmDatabaseEngine).shutdown();
    assert.strictEqual(openFdCount(), before);
  });

  it('opens garbage over-gate bytes paged and fails queries honestly', async () => {
    // sql.js defers validation to the first statement on the buffer path
    // too; paged garbage behaves the same way instead of regressing to a
    // less accurate error.
    const result = await createDatabaseEngine(overGateConfig(garbagePath));
    assert.strictEqual(result.storage, 'paged');
    const engine = result.operations!;
    try {
      await assert.rejects(
        engine.executeQuery('SELECT count(*) FROM sqlite_schema'),
        /not a database/
      );
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('fails loudly when an uncached read observes a changed file generation', async () => {
    const result = await createDatabaseEngine(overGateConfig(generationDbPath));
    assert.strictEqual(result.storage, 'paged');
    const engine = result.operations!;
    try {
      const early = await engine.executeQuery(
        'SELECT label FROM generation_fixture WHERE id = 1'
      );
      assert.strictEqual(early[0].rows[0][0], 'oldE');

      fs.writeFileSync(generationDbPath, Buffer.from(nextGenerationBytes));
      const future = new Date('2100-01-01T00:00:00.000Z');
      fs.utimesSync(generationDbPath, future, future);

      await assert.rejects(
        engine.executeQuery(
          'SELECT label FROM generation_fixture WHERE id IN (1, 12000) ORDER BY id'
        ),
        /file changed on disk; reload the document/i
      );
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });
});

describe('desktop paged fallback through the worker endpoint', () => {
  it('edits, atomically saves, and reopens the replaced base through the endpoint', async () => {
    const testPath = path.join(fixtureDir, 'endpoint-save-reopen.db');
    fs.writeFileSync(testPath, Buffer.from(dbBytes));
    const endpoint = createWorkerEndpoint();
    try {
      const config = overGateConfig(testPath, { wasmBinary: new Uint8Array(wasmBinary) });
      const opened = await endpoint.initializeDatabase('endpoint-save.db', config);
      assert.strictEqual(opened.storage, 'paged');
      assert.strictEqual(opened.isReadOnly, false);

      await endpoint.updateCell('fixtures', 1, 'label', 'worker-round-trip');
      const writeResult = await endpoint.writeToFile(testPath);
      assert.deepStrictEqual(writeResult, { requiresReopen: true });

      const reopened = await endpoint.initializeDatabase('endpoint-save.db', config);
      assert.strictEqual(reopened.storage, 'paged');
      assert.strictEqual(reopened.isReadOnly, false);
      const rows = await endpoint.runQuery(
        'SELECT label FROM fixtures WHERE id = 1; PRAGMA integrity_check'
      );
      assert.deepStrictEqual(rows[0].rows, [['worker-round-trip']]);
      assert.deepStrictEqual(rows[1].rows, [['ok']]);
    } finally {
      endpoint.dispose();
    }
  });

  it('reports writable paged storage, exports edits, and releases the fd on dispose', async () => {
    const endpoint = createWorkerEndpoint();
    const before = openFdCount();
    const initResult: DatabaseInitResult = await endpoint.initializeDatabase(
      'big.db',
      overGateConfig(dbPath, { wasmBinary: new Uint8Array(wasmBinary) })
    );
    assert.strictEqual(initResult.isReadOnly, false);
    assert.strictEqual(initResult.storage, 'paged');
    if (before !== undefined) {
      assert.strictEqual(openFdCount(), before + 1);
    }

    const data = await endpoint.fetchTableData('fixtures', {
      columns: ['id', 'label'],
      limit: 1,
      offset: 0
    });
    assert.strictEqual(data.rows.length, 1);
    await endpoint.updateCell('fixtures', 1, 'label', 'endpoint-edit');
    const exported = await endpoint.exportDatabase();
    const reopened = new (SqlJsModule.Database as any)(exported);
    try {
      assert.deepStrictEqual(
        reopened.exec('SELECT label FROM fixtures WHERE id = 1')[0].values,
        [['endpoint-edit']]
      );
    } finally {
      reopened.close();
    }

    endpoint.dispose();
    if (before !== undefined) {
      assert.strictEqual(openFdCount(), before, 'endpoint dispose must release the fd');
    }
  });

  it('serializes concurrent paged initialization without leaking superseded fds', async (t) => {
    const before = openFdCount();
    if (before === undefined) {
      t.skip('/dev/fd unavailable');
      return;
    }

    const endpoint = createWorkerEndpoint();
    try {
      const results = await Promise.all(Array.from({ length: 5 }, (_, index) => (
        endpoint.initializeDatabase(
          `concurrent-${index}.db`,
          overGateConfig(dbPath, { wasmBinary: new Uint8Array(wasmBinary) })
        )
      )));
      assert.ok(results.every(result => result.storage === 'paged'));
      assert.strictEqual(
        openFdCount(),
        before + 1,
        'only the final serialized engine may retain a descriptor'
      );
    } finally {
      endpoint.dispose();
    }
    assert.strictEqual(openFdCount(), before, 'dispose must release the final descriptor');
  });
});
