import './vscode_mock_setup';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from '../../vendor/sql.js/sql-wasm.js';
import {
  buildCountUpperBoundSql,
  PAGED_EXACT_COUNT_MAX_FILE_BYTES,
  resolvePagedExactCountMaxFileBytes,
  shouldAnswerCountWithUpperBound
} from '../../src/core/paged-count';
import { createEngineFromModule, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import type { WasmEngineModule } from '../../src/core/engine/wasm/WasmDatabaseEngine';
import type { DatabaseOperations } from '../../src/core/types';

/**
 * Shared paged count policy: the decision layer both the web demo worker
 * and the desktop WASM engine consume, plus the desktop engine actually
 * answering counts through it on a real paged (openPaged) database. The
 * demo side of the parity is pinned by web_demo_paged_open.test.ts
 * against the same shared module.
 */

describe('paged count policy (shared layer)', () => {
  it('bounds only large unfiltered paged counts', () => {
    const base = {
      storage: 'paged' as const,
      filtered: false,
      authorityConfirmedRowIdTable: true,
      pagedFileSizeBytes: 100,
      exactCountMaxFileBytes: 64
    };
    assert.strictEqual(shouldAnswerCountWithUpperBound(base), true);
    // Buffer storage stays exact no matter the size.
    assert.strictEqual(
      shouldAnswerCountWithUpperBound({ ...base, storage: 'memory' }),
      false
    );
    // Filtered counts have no cheap bound.
    assert.strictEqual(
      shouldAnswerCountWithUpperBound({ ...base, filtered: true }),
      false
    );
    // A syntactically valid user-defined rowid column is not the intrinsic
    // rowid authority required by the shortcut.
    assert.strictEqual(
      shouldAnswerCountWithUpperBound({
        ...base,
        authorityConfirmedRowIdTable: false
      }),
      false
    );
    // At or under the gate: exact.
    assert.strictEqual(
      shouldAnswerCountWithUpperBound({ ...base, pagedFileSizeBytes: 64 }),
      false
    );
    assert.strictEqual(
      shouldAnswerCountWithUpperBound({ ...base, pagedFileSizeBytes: 65 }),
      true
    );
  });

  it('normalizes the exact-count gate override like the demo worker always did', () => {
    assert.strictEqual(
      resolvePagedExactCountMaxFileBytes(undefined),
      PAGED_EXACT_COUNT_MAX_FILE_BYTES
    );
    assert.strictEqual(resolvePagedExactCountMaxFileBytes(0), 0);
    assert.strictEqual(resolvePagedExactCountMaxFileBytes(1234), 1234);
    assert.strictEqual(
      resolvePagedExactCountMaxFileBytes(-1),
      PAGED_EXACT_COUNT_MAX_FILE_BYTES
    );
    assert.strictEqual(
      resolvePagedExactCountMaxFileBytes(Number.NaN),
      PAGED_EXACT_COUNT_MAX_FILE_BYTES
    );
    assert.strictEqual(
      resolvePagedExactCountMaxFileBytes('64'),
      PAGED_EXACT_COUNT_MAX_FILE_BYTES
    );
    assert.strictEqual(PAGED_EXACT_COUNT_MAX_FILE_BYTES, 64 * 1024 * 1024);
  });

  it('escapes the upper-bound query identifier', () => {
    assert.strictEqual(
      buildCountUpperBoundSql('fixtures'),
      'SELECT CAST(min(rowid) AS TEXT), CAST(max(rowid) AS TEXT) FROM "fixtures"'
    );
    assert.strictEqual(
      buildCountUpperBoundSql('we"ird'),
      'SELECT CAST(min(rowid) AS TEXT), CAST(max(rowid) AS TEXT) FROM "we""ird"'
    );
  });

  it('rejects rowid spans that cannot be represented as an exact JS count', async () => {
    const pagedCount = await import('../../src/core/paged-count') as any;
    assert.strictEqual(typeof pagedCount.resolveCountUpperBound, 'function');
    assert.strictEqual(pagedCount.resolveCountUpperBound([null, null]), 0);
    assert.strictEqual(pagedCount.resolveCountUpperBound(['-10', '10']), 21);
    assert.strictEqual(
      pagedCount.resolveCountUpperBound(['-9223372036854775808', '9223372036854775807']),
      undefined
    );
  });
});

// ---------------------------------------------------------------------------
// Desktop engine integration on a real paged open
// ---------------------------------------------------------------------------

const wasmBinary = new Uint8Array(
  fs.readFileSync(path.resolve(process.cwd(), 'assets/sqlite3.wasm'))
).buffer;

describe('desktop engine paged count policy', () => {
  let fixtureDir: string;
  let dbPath: string;
  let SqlJsModule: WasmEngineModule;

  before(async () => {
    SqlJsModule = await (initSqlJs as any)({ wasmBinary }) as WasmEngineModule;
    const tmpRoot = path.join(process.cwd(), '.tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    fixtureDir = fs.mkdtempSync(path.join(tmpRoot, 'paged-count-'));
    dbPath = path.join(fixtureDir, 'gappy.db');

    // 20000 rowids inserted, even ids deleted: COUNT 10000, max(rowid)
    // 19999 — the bound visibly diverges from the exact count.
    const db = new (SqlJsModule.Database as any)();
    db.run('CREATE TABLE fixtures (id INTEGER PRIMARY KEY, label TEXT)');
    db.run(
      'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20000) ' +
      "INSERT INTO fixtures SELECT n, 'row-' || n FROM seq"
    );
    db.run('DELETE FROM fixtures WHERE id % 2 = 0');
    db.run('CREATE VIEW odd_labels AS SELECT label FROM fixtures');
    db.run('CREATE TABLE negative_rowids (label TEXT)');
    db.run(
      'WITH RECURSIVE seq(n) AS (SELECT -150 UNION ALL SELECT n + 1 FROM seq WHERE n < -1) ' +
      "INSERT INTO negative_rowids(rowid, label) SELECT n, 'negative-' || n FROM seq"
    );
    db.run(
      'CREATE TABLE without_rowid_shadow (rowid INTEGER PRIMARY KEY, label TEXT) WITHOUT ROWID; ' +
      "INSERT INTO without_rowid_shadow VALUES (-2, 'first'), (-1, 'second'), (0, 'third'); " +
      'CREATE VIEW exposed_rowid AS SELECT 0 AS rowid, label FROM without_rowid_shadow'
    );
    db.run(
      'CREATE TABLE extreme_rowids (label TEXT); ' +
      "INSERT INTO extreme_rowids(rowid, label) VALUES " +
      "(-9223372036854775808, 'minimum'), (9223372036854775807, 'maximum')"
    );
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();
  });

  after(() => {
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function openPagedEngine(): Promise<DatabaseOperations> {
    const result = await createEngineFromModule(SqlJsModule, {
      content: null,
      filePath: dbPath,
      // Any positive limit below the fixture size trips the gate.
      maxSize: 4096,
      allowPagedFallback: true,
      // Treat every paged file as too large for an exact scan.
      pagedExactCountMaxFileBytes: 0,
      readOnlyMode: false
    });
    assert.strictEqual(result.storage, 'paged');
    return result.operations!;
  }

  it('keeps the fast rowid-span bound for a genuine large gappy rowid table', async () => {
    const engine = await openPagedEngine();
    try {
      const bound = await engine.fetchTableCount('fixtures', {});
      assert.strictEqual(bound, 19999);
      assert.ok(bound >= 10000, 'the rowid-span result must remain an upper bound');
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('counts a genuine negative-rowid table without undercounting', async () => {
    const engine = await openPagedEngine();
    try {
      assert.strictEqual(await engine.fetchTableCount('negative_rowids', {}), 150);
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('falls back to exact COUNT for an unsafe signed-int64 rowid span', async () => {
    const engine = await openPagedEngine();
    try {
      assert.strictEqual(await engine.fetchTableCount('extreme_rowids', {}), 2);
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('counts a WITHOUT ROWID table with a user rowid column exactly', async () => {
    const engine = await openPagedEngine();
    try {
      assert.strictEqual(await engine.fetchTableCount('without_rowid_shadow', {}), 3);
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('counts a view exposing a rowid-named column exactly', async () => {
    const engine = await openPagedEngine();
    try {
      assert.strictEqual(await engine.fetchTableCount('exposed_rowid', {}), 3);
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('keeps filtered paged counts exact', async () => {
    const engine = await openPagedEngine();
    try {
      assert.strictEqual(
        await engine.fetchTableCount('fixtures', {
          columns: ['id', 'label'],
          filters: [{ column: 'label', value: 'row-19999' }]
        }),
        1
      );
      assert.strictEqual(
        await engine.fetchTableCount('fixtures', {
          columns: ['id', 'label'],
          globalFilter: 'row-1999'
        }),
        // row-1999, row-19991..row-19999 (odd ids only): 1999, 19991,
        // 19993, 19995, 19997, 19999.
        6
      );
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('falls through to the exact count for views (no rowid to bound with)', async () => {
    const engine = await openPagedEngine();
    try {
      assert.strictEqual(await engine.fetchTableCount('odd_labels', {}), 10000);
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('keeps small paged files exact under the default gate', async () => {
    const result = await createEngineFromModule(SqlJsModule, {
      content: null,
      filePath: dbPath,
      maxSize: 4096,
      allowPagedFallback: true,
      // No override: the fixture is far below the 64 MiB default gate.
      readOnlyMode: false
    });
    assert.strictEqual(result.storage, 'paged');
    const engine = result.operations!;
    try {
      assert.strictEqual(await engine.fetchTableCount('fixtures', {}), 10000);
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });

  it('never rewrites counts on buffer storage even with the override forced', async () => {
    const result = await createEngineFromModule(SqlJsModule, {
      content: null,
      filePath: dbPath,
      maxSize: 0,
      allowPagedFallback: true,
      pagedExactCountMaxFileBytes: 0,
      readOnlyMode: false
    });
    assert.strictEqual(result.storage, 'memory');
    const engine = result.operations!;
    try {
      assert.strictEqual(await engine.fetchTableCount('fixtures', {}), 10000);
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  });
});
