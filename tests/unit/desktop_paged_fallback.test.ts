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

/**
 * Desktop WASM-fallback paged routing matrix at the engine layer
 * (createDatabaseEngine / createEngineFromModule / the worker endpoint),
 * against the REAL vendored sql.js fork and real files on disk:
 *
 *   under the gate                        -> buffer, editable, byte-identical
 *   over the gate + openPaged             -> paged read-only snapshot
 *   over the gate + capability absent     -> today's size rejection
 *   over the gate + fallback not allowed  -> today's size rejection
 *   over the gate + paged open throws     -> today's size rejection (cause kept)
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
 * The real vendored Database class with openPaged masked off, mirroring a
 * stale vendored build. A plain constructor function does not inherit the
 * original class's static properties, so the capability is genuinely
 * absent rather than stubbed to throw.
 */
function maskOpenPaged(module: WasmEngineModule): WasmEngineModule {
  const Original = module.Database;
  const BufferOnly: any = function BufferOnlyDatabase(...args: unknown[]) {
    return Reflect.construct(Original, args as never[], BufferOnly);
  };
  BufferOnly.prototype = Original.prototype;
  return { ...module, Database: BufferOnly };
}

/** The real class with openPaged replaced by a deterministic failure. */
function throwingOpenPaged(module: WasmEngineModule): WasmEngineModule {
  const masked = maskOpenPaged(module);
  (masked.Database as any).openPaged = () => {
    throw new Error('synthetic paged open failure');
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

  it('opens over-gate files paged read-only through the real openPaged', async () => {
    const result = await createDatabaseEngine(overGateConfig(dbPath));
    assert.strictEqual(result.storage, 'paged');
    assert.strictEqual(result.isReadOnly, true);
    const engine = result.operations!;
    try {
      // A page fetch works.
      const data = await engine.fetchTableData('fixtures', {
        columns: ['id', 'label'],
        limit: 5,
        offset: 0,
        orderBy: 'id',
        orderDir: 'ASC'
      });
      assert.deepStrictEqual(
        data.rows.map(row => row[row.length - 1]),
        ['row-1', 'row-2', 'row-3', 'row-4', 'row-5']
      );
      // Counts answer (small fixture: exact under the default gate).
      assert.strictEqual(await engine.fetchTableCount('fixtures', {}), 2000);
      // Writes are cleanly rejected.
      await assert.rejects(
        engine.updateCell('fixtures', 1, 'label', 'nope'),
        /read.?only/i
      );
      // Whole-database serialization surfaces the actionable error.
      await assert.rejects(
        engine.serializeDatabase(),
        /page-on-demand as a[\s\S]*read-only snapshot[\s\S]*maxFileSize/
      );
      await assert.rejects(
        engine.writeToFile(path.join(fixtureDir, 'copy.db')),
        /page-on-demand as a[\s\S]*read-only snapshot/
      );
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('rejects PRAGMA changes on a paged read-only engine', async () => {
    const result = await createDatabaseEngine(overGateConfig(dbPath));
    assert.strictEqual(result.storage, 'paged');
    const engine = result.operations!;
    try {
      const before = await engine.getPragmas();
      await assert.rejects(
        engine.setPragma('cache_size', 123),
        /read.?only/i
      );
      const after = await engine.getPragmas();
      assert.strictEqual(after.cache_size, before.cache_size);
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('rejects over-gate files with today\'s size error when openPaged is absent', async () => {
    const masked = maskOpenPaged(SqlJsModule);
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

  it('falls back to the size error and keeps the cause when the paged open throws', async () => {
    const throwing = throwingOpenPaged(SqlJsModule);
    const before = openFdCount();
    await assert.rejects(
      createEngineFromModule(throwing, overGateConfig(dbPath)),
      (error: Error) => {
        assert.match(error.message, SIZE_ERROR_PATTERN);
        // The paged failure rides the cause chain: wrap -> size error -> paged error.
        const sizeError = error.cause as Error;
        assert.match(String((sizeError?.cause as Error)?.message), /synthetic paged open failure/);
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
    const fakeModule = maskOpenPaged(SqlJsModule);
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
  it('reports paged storage, enforces read-only, and releases the fd on dispose', async () => {
    const endpoint = createWorkerEndpoint();
    const before = openFdCount();
    const initResult: DatabaseInitResult = await endpoint.initializeDatabase(
      'big.db',
      overGateConfig(dbPath, { wasmBinary: new Uint8Array(wasmBinary) })
    );
    assert.strictEqual(initResult.isReadOnly, true);
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
    await assert.rejects(endpoint.exportDatabase(), /page-on-demand/);
    await assert.rejects(
      endpoint.updateCell('fixtures', 1, 'label', 'nope'),
      /read.?only/i
    );

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
