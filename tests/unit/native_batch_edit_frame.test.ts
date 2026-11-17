import './vscode_mock_setup';

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it, type TestContext } from 'node:test';
import * as vscode from 'vscode';
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import { encodePrimaryKeyRecordId } from '../../src/core/row-identity';
import {
  createNativeDatabaseConnection,
  isNativeAvailable,
  nativeHistoryRowByteLimit,
  NativeWorkerProcess
} from '../../src/nativeWorker';
import type { CellUpdate, DatabaseOperations, ModificationEntry } from '../../src/core/types';

// The host retires the native worker when one response frame passes 64 MiB,
// and the open connection goes with it. A batch cell edit read its prior and
// post values in one response: every edited column of every edited row, or
// one row's edited columns together. A large cell in a column edited on
// another row, several large edited cells, or one prior past the frame
// retired the worker, at the default limits for the first.
const MiB = 1024 * 1024;
const EDIT_LIMIT = 16 * MiB;
const DEFAULT_UNDO_BUDGET = 50 * MiB;
const RAISED_UNDO_BUDGET = 512 * MiB;
const text = (bytes: number) => `replace(hex(zeroblob(${bytes / 2})), '0', 'a')`;
const blob = (bytes: number) => `zeroblob(${bytes})`;
const tenRows = (value: string) =>
  `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10) INSERT INTO t (rowid, v) SELECT i, ${value} FROM n`;
const keyOne = encodePrimaryKeyRecordId([{ identifier: 'k', declaredType: 'INTEGER', position: 1 }], [1n]);

interface Scenario {
  name: string;
  setup: string[];
  updates: CellUpdate[];
  editLimit?: number;
  undoBudget?: number;
  /** Rejection the edit must give; otherwise the edit, its undo and its redo succeed. */
  refused?: RegExp;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'a large cell in a column the batch edits on another row, at the default limits',
    setup: ['CREATE TABLE t (a, b)', `INSERT INTO t (rowid, a, b) VALUES (1, 'a1', ${blob(70 * MiB)}), (2, 'a2', 'b2')`],
    updates: [{ rowId: 1, column: 'a', value: 'x' }, { rowId: 2, column: 'b', value: 'y' }],
    editLimit: EDIT_LIMIT,
    undoBudget: DEFAULT_UNDO_BUDGET
  },
  {
    name: 'ten 8 MiB TEXT priors under a raised undo budget',
    setup: ['CREATE TABLE t (v)', tenRows(text(8 * MiB))],
    updates: Array.from({ length: 10 }, (_, index) => ({ rowId: index + 1, column: 'v', value: 'x' })),
    editLimit: EDIT_LIMIT,
    undoBudget: RAISED_UNDO_BUDGET
  },
  {
    name: 'ten 8 MiB BLOB priors under a raised undo budget',
    setup: ['CREATE TABLE t (v)', tenRows(blob(8 * MiB))],
    updates: Array.from({ length: 10 }, (_, index) => ({ rowId: index + 1, column: 'v', value: 'x' })),
    editLimit: EDIT_LIMIT,
    undoBudget: RAISED_UNDO_BUDGET
  },
  {
    // Control: the default budget refuses these priors before any is read.
    name: 'ten 8 MiB TEXT priors under the default undo budget',
    setup: ['CREATE TABLE t (v)', tenRows(text(8 * MiB))],
    updates: Array.from({ length: 10 }, (_, index) => ({ rowId: index + 1, column: 'v', value: 'x' })),
    editLimit: EDIT_LIMIT,
    undoBudget: DEFAULT_UNDO_BUDGET,
    refused: /Batch update undo snapshot exceeds the 52428800-byte memory budget/
  },
  ...(['rowid', 'withoutRowid', 'alias'] as const).map((kind): Scenario => ({
    name: `five 14 MiB BLOB cells of one ${kind} row`,
    setup: [
      kind === 'rowid' ? 'CREATE TABLE t (a, b, c, d, e)'
        : kind === 'alias' ? 'CREATE TABLE t (k INTEGER PRIMARY KEY, a, b, c, d, e)'
          : 'CREATE TABLE t (k INTEGER PRIMARY KEY, a, b, c, d, e) WITHOUT ROWID',
      kind === 'rowid'
        ? `INSERT INTO t (rowid, a, b, c, d, e) VALUES (1, ${Array(5).fill(blob(14 * MiB)).join(', ')})`
        : `INSERT INTO t VALUES (1, ${Array(5).fill(blob(14 * MiB)).join(', ')})`
    ],
    updates: [
      // The alias edit takes the path that carries a changed rowid forward.
      ...(kind === 'alias' ? [{ rowId: 1, column: 'k', value: 5 }] : []),
      ...['a', 'b', 'c', 'd', 'e'].map(column => ({ rowId: kind === 'withoutRowid' ? keyOne : 1, column, value: 'x' }))
    ],
    editLimit: EDIT_LIMIT,
    undoBudget: RAISED_UNDO_BUDGET
  })),
  // The cell read spells out TEXT-as-bytes itself: prior and post bytes stay exact.
  {
    name: 'malformed UTF-8 TEXT and plain TEXT priors',
    setup: ['CREATE TABLE t (v)', `INSERT INTO t (rowid, v) VALUES (1, CAST(X'80FF41' AS TEXT)), (2, 'héllo ✓')`],
    updates: [{ rowId: 1, column: 'v', value: 'x' }, { rowId: 2, column: 'v', value: 'y' }],
    editLimit: EDIT_LIMIT,
    undoBudget: DEFAULT_UNDO_BUDGET
  },
  {
    name: 'malformed UTF-16 TEXT and plain TEXT priors in a UTF-16le database',
    setup: [
      'PRAGMA encoding = "UTF-16le"',
      'CREATE TABLE t (v)',
      `INSERT INTO t (rowid, v) VALUES (1, CAST(X'00D84100' AS TEXT)), (2, 'héllo ✓')`
    ],
    updates: [{ rowId: 1, column: 'v', value: 'x' }, { rowId: 2, column: 'v', value: 'y' }],
    editLimit: EDIT_LIMIT,
    undoBudget: DEFAULT_UNDO_BUDGET
  },
  {
    name: 'one 70 MiB prior with no edit limit',
    setup: ['CREATE TABLE t (v)', `INSERT INTO t (rowid, v) VALUES (1, ${blob(70 * MiB)}), (2, 'b')`],
    updates: [{ rowId: 1, column: 'v', value: 'x' }, { rowId: 2, column: 'v', value: 'y' }],
    refused: /larger than/
  }
];

/** Every cell as its storage class, size and first and last bytes. */
async function contents(ops: DatabaseOperations): Promise<unknown[][]> {
  const columns = (await ops.executeQuery('SELECT name FROM pragma_table_info(\'t\') ORDER BY cid'))[0].rows.map(row => String(row[0]));
  // Native results are keyed by column name, so every one is aliased.
  const key = columns.includes('k') ? 'k' : 'CAST(rowid AS TEXT)';
  return (await ops.executeQuery(
    `SELECT ${[`${key} AS r`, ...columns.map((column, index) => (
      `typeof("${column}") AS t${index}, length(CAST("${column}" AS BLOB)) AS l${index}, ` +
      `hex(substr(CAST("${column}" AS BLOB), 1, 8)) AS h${index}, ` +
      `hex(substr(CAST("${column}" AS BLOB), -8)) AS e${index}`
    ))].join(', ')} FROM t ORDER BY 1`
  ))[0].rows;
}

async function assertScenario(ops: DatabaseOperations, scenario: Scenario): Promise<void> {
  for (const sql of scenario.setup) await ops.executeQuery(sql);
  if (scenario.setup.some(sql => /UTF-16le/.test(sql))) {
    assert.equal((await ops.executeQuery('PRAGMA encoding'))[0].rows[0][0], 'UTF-16le');
  }
  const before = await contents(ops);
  if (scenario.refused) {
    await assert.rejects(
      ops.updateCellBatch('t', scenario.updates, scenario.editLimit, scenario.undoBudget),
      scenario.refused
    );
    assert.deepEqual(await contents(ops), before, 'a refused edit writes nothing and keeps the connection');
    return;
  }
  const cells = await ops.updateCellBatch('t', scenario.updates, scenario.editLimit, scenario.undoBudget);
  const edited = await contents(ops);
  assert.notDeepEqual(edited, before);
  const entry: ModificationEntry = {
    modificationType: 'cell_update', targetTable: 't', description: scenario.name, affectedCells: cells
  };
  await ops.undoModification(entry);
  assert.deepEqual(await contents(ops), before, 'undo');
  await ops.redoModification(entry);
  assert.deepEqual(await contents(ops), edited, 'redo');
}

// Directories go last: a throwing hook skips the hooks behind it.
const directories: string[] = [];
after(() => {
  for (const directory of directories) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/** A native connection to a new file, or undefined when the test was skipped. */
async function openNative(t: TestContext): Promise<{ ops: DatabaseOperations; file: string } | undefined> {
  if (!await isNativeAvailable(process.cwd())) {
    if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
    t.skip('Bundled native runtime unavailable');
    return undefined;
  }
  fs.mkdirSync('.tmp', { recursive: true });
  const directory = fs.mkdtempSync(path.resolve('.tmp/native-batch-frame-'));
  directories.push(directory);
  const file = path.join(directory, 'batch.db');
  fs.closeSync(fs.openSync(file, 'w'));
  const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
  t.after(() => native.workerMethods[Symbol.dispose]());
  const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'batch.db', false);
  return { ops: databaseOps, file };
}

describe('a native batch cell edit keeps every response under the frame cap', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async (t: TestContext) => {
      const native = await openNative(t);
      if (!native) return;
      await assertScenario(native.ops, scenario);
    });
  }
});

/** The SQL of every cell read the per-cell path completes while `run` runs. */
async function cellReadsDuring(t: TestContext, run: () => Promise<unknown>): Promise<string[]> {
  const originalCall = NativeWorkerProcess.prototype.call;
  const reads: string[] = [];
  const spy = t.mock.method(NativeWorkerProcess.prototype, 'call', async function (
    this: NativeWorkerProcess,
    ...args: Parameters<typeof originalCall>
  ) {
    const result = await originalCall.apply(this, args);
    if (args[0] === 'queryHistoryBatch') {
      const [queries, , , , , texts = []] = args[1] as [
        Array<{ sql: string | number }>, unknown, unknown, unknown, unknown, string[]?
      ];
      // A request may return a prefix; the rest is sent again.
      const completed = (result as { results: unknown[] }).results.length;
      for (const query of queries.slice(0, completed)) {
        const sql = typeof query.sql === 'number' ? texts[query.sql] : query.sql;
        if (/^SELECT typeof\(/.test(sql) && / LIMIT 2$/.test(sql)) reads.push(sql);
      }
    }
    return result;
  });
  try {
    await run();
  } finally {
    spy.mock.restore();
  }
  return reads;
}

// Each read of a batch's cells is one statement while the rows it reads fit
// one response, judged by that statement from the stored sizes of every cell
// it returns; a row that does not fit is read cell by cell.
describe('which read a native batch cell edit takes', () => {
  const twoRows = (firstBytes: number) => [
    'CREATE TABLE t (v)',
    `INSERT INTO t (rowid, v) VALUES (1, ${blob(firstBytes)}), (2, 'b')`
  ];
  const updates = [{ rowId: 1, column: 'v', value: 'x' }, { rowId: 2, column: 'v', value: 'y' }];
  const limit = nativeHistoryRowByteLimit(2, 1);

  it('reads two rows in one statement when the larger is at the per-row limit', async (t: TestContext) => {
    const native = await openNative(t);
    if (!native) return;
    for (const sql of twoRows(limit)) await native.ops.executeQuery(sql);
    const reads = await cellReadsDuring(t, () => native.ops.updateCellBatch('t', updates, 32 * MiB, RAISED_UNDO_BUDGET));
    assert.deepEqual(reads, []);
  });

  it('reads the row one byte past the limit cell by cell and the other in one statement', async (t: TestContext) => {
    const native = await openNative(t);
    if (!native) return;
    for (const sql of twoRows(limit + 1)) await native.ops.executeQuery(sql);
    let cells: Awaited<ReturnType<DatabaseOperations['updateCellBatch']>> = [];
    const reads = await cellReadsDuring(t, async () => {
      cells = await native.ops.updateCellBatch('t', updates, 32 * MiB, RAISED_UNDO_BUDGET);
    });
    // The prior read only: after the edit both rows are small.
    assert.equal(reads.length, 1);
    assert.match(reads[0], /FROM main\."t" WHERE rowid = \? LIMIT 2$/);
    assert.equal((cells[0].priorValue as Uint8Array).byteLength, limit + 1);
    assert.equal(cells[1].priorValue, 'b');
  });

  it('reads only the edited cell of a row whose other edited column is large', async (t: TestContext) => {
    const native = await openNative(t);
    if (!native) return;
    await native.ops.executeQuery('CREATE TABLE t (a, b)');
    await native.ops.executeQuery(`INSERT INTO t (rowid, a, b) VALUES (1, 'a1', ${blob(70 * MiB)}), (2, 'a2', 'b2')`);
    const batch = [{ rowId: 1, column: 'a', value: 'x' }, { rowId: 2, column: 'b', value: 'y' }];
    let cells: Awaited<ReturnType<DatabaseOperations['updateCellBatch']>> = [];
    const reads = await cellReadsDuring(t, async () => {
      cells = await native.ops.updateCellBatch('t', batch, EDIT_LIMIT, DEFAULT_UNDO_BUDGET);
    });
    // Row 1's edited cell before and after the write; never its column b.
    assert.equal(reads.length, 2);
    for (const sql of reads) assert.match(sql, /^SELECT typeof\("a"\), /);
    const entry: ModificationEntry = { modificationType: 'cell_update', targetTable: 't', description: 'diagonal', affectedCells: cells };
    const undoReads = await cellReadsDuring(t, () => native.ops.undoModification(entry));
    assert.ok(undoReads.length > 0 && undoReads.every(sql => /^SELECT typeof\("a"\), /.test(sql)));
    assert.deepEqual((await native.ops.executeQuery('SELECT a, b = \'b2\' AS same FROM t ORDER BY rowid'))[0].rows, [['a1', 0], ['a2', 1]]);
  });

  it('keeps another connection from enlarging a cell between the edit\'s reads', async (t: TestContext) => {
    const native = await openNative(t);
    if (!native) return;
    for (const sql of twoRows(16)) await native.ops.executeQuery(sql);
    const external = new DatabaseSync(native.file, { timeout: 0 });
    t.after(() => external.close());
    const originalCall = NativeWorkerProcess.prototype.call;
    let outcome: string | undefined;
    t.mock.method(NativeWorkerProcess.prototype, 'call', async function (
      this: NativeWorkerProcess,
      ...args: Parameters<typeof originalCall>
    ) {
      const result = await originalCall.apply(this, args);
      // Right after the prior read, inside the edit's savepoint.
      if (outcome === undefined && args[0] === 'query' && /^SELECT CAST\(rowid AS TEXT\), typeof/.test(String((args[1] as unknown[])[0]))) {
        try {
          external.exec(`UPDATE t SET v = zeroblob(${70 * MiB}) WHERE rowid = 2`);
          outcome = 'written';
        } catch (error) {
          outcome = (error as Error).message;
        }
      }
      return result;
    });
    const cells = await native.ops.updateCellBatch('t', updates, EDIT_LIMIT, DEFAULT_UNDO_BUDGET);
    assert.match(String(outcome), /database is locked/);
    assert.equal(cells[1].priorValue, 'b');
    assert.deepEqual((await native.ops.executeQuery('SELECT length(v) AS l FROM t ORDER BY rowid'))[0].rows, [[1], [1]]);
  });
});

// A multi-row delete snapshots its rows for undo with one statement per
// identity chunk. Ten 8 MiB rows under a raised undo budget took that
// response past the frame cap and retired the worker.
describe('a native multi-row delete keeps every response under the frame cap', () => {
  const keyed = (key: number) => encodePrimaryKeyRecordId([{ identifier: 'k', declaredType: 'INTEGER', position: 1 }], [BigInt(key)]);
  const cases = [
    { name: 'ten 8 MiB BLOB rowid rows', columns: 1, ddl: 'CREATE TABLE t (v)', fill: tenRows(blob(8 * MiB)), rowIds: (count: number) => Array.from({ length: count }, (_, index) => index + 1) },
    {
      name: 'ten 8 MiB TEXT WITHOUT ROWID rows',
      columns: 2,
      ddl: 'CREATE TABLE t (k INTEGER PRIMARY KEY, v) WITHOUT ROWID',
      fill: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10) INSERT INTO t (k, v) SELECT i, ${text(8 * MiB)} FROM n`,
      rowIds: (count: number) => Array.from({ length: count }, (_, index) => keyed(index + 1))
    }
  ];
  for (const item of cases) {
    it(`deletes, undoes and redoes ${item.name} under a raised undo budget, cell by cell`, async (t: TestContext) => {
      const native = await openNative(t);
      if (!native) return;
      await native.ops.executeQuery(item.ddl);
      await native.ops.executeQuery(item.fill);
      const before = await contents(native.ops);
      const rowIds = item.rowIds(10);
      let deletedRows: Awaited<ReturnType<DatabaseOperations['deleteRows']>> = [];
      const reads = await cellReadsDuring(t, async () => {
        deletedRows = await native.ops.deleteRows('t', rowIds, RAISED_UNDO_BUDGET);
      });
      // Every column of every row, each on its own.
      assert.equal(reads.length, 10 * item.columns);
      assert.deepEqual(await contents(native.ops), []);
      const entry: ModificationEntry = {
        modificationType: 'row_delete', targetTable: 't', description: item.name, affectedRowIds: rowIds, deletedRows
      };
      await native.ops.undoModification(entry);
      assert.deepEqual(await contents(native.ops), before, 'undo');
      await native.ops.redoModification(entry);
      assert.deepEqual(await contents(native.ops), [], 'redo');
    });
  }

  it('refuses ten 8 MiB rows under the default undo budget before reading them', async (t: TestContext) => {
    const native = await openNative(t);
    if (!native) return;
    await native.ops.executeQuery('CREATE TABLE t (v)');
    await native.ops.executeQuery(tenRows(blob(8 * MiB)));
    await assert.rejects(
      native.ops.deleteRows('t', cases[0].rowIds(10), DEFAULT_UNDO_BUDGET),
      /Delete undo snapshot exceeds the 52428800-byte memory budget/
    );
    assert.equal((await contents(native.ops)).length, 10);
  });

  it('keeps another connection from enlarging a row between its size and its snapshot', async (t: TestContext) => {
    const native = await openNative(t);
    if (!native) return;
    await native.ops.executeQuery('CREATE TABLE t (v)');
    await native.ops.executeQuery(tenRows(text(1024)));
    const external = new DatabaseSync(native.file, { timeout: 0 });
    t.after(() => external.close());
    const originalCall = NativeWorkerProcess.prototype.call;
    let outcome: string | undefined;
    t.mock.method(NativeWorkerProcess.prototype, 'call', async function (
      this: NativeWorkerProcess,
      ...args: Parameters<typeof originalCall>
    ) {
      const result = await originalCall.apply(this, args);
      // Right after the size query, inside the delete's savepoint.
      if (outcome === undefined && args[0] === 'query' && /^SELECT COUNT\(\*\), COALESCE\(SUM\(/.test(String((args[1] as unknown[])[0]))) {
        try {
          external.exec(`UPDATE t SET v = zeroblob(${70 * MiB}) WHERE rowid = 1`);
          outcome = 'written';
        } catch (error) {
          outcome = (error as Error).message;
        }
      }
      return result;
    });
    const deletedRows = await native.ops.deleteRows('t', cases[0].rowIds(10), DEFAULT_UNDO_BUDGET);
    assert.match(String(outcome), /database is locked/);
    assert.equal(deletedRows.length, 10);
    assert.equal((deletedRows[0].row.v as string).length, 1024);
    assert.deepEqual(await contents(native.ops), []);
  });

  // Identity chunks hold up to 32,765 rows; the snapshot is gathered chunk
  // by chunk, as one array of 200,000 rows exceeds the call stack.
  it('snapshots 200,000 small rows in several identity chunks', async (t: TestContext) => {
    const native = await openNative(t);
    if (!native) return;
    await native.ops.executeQuery('CREATE TABLE t (v)');
    await native.ops.executeQuery(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200000) INSERT INTO t (rowid, v) SELECT i, 'v' || i FROM n"
    );
    const deletedRows = await native.ops.deleteRows('t', cases[0].rowIds(200000), DEFAULT_UNDO_BUDGET);
    assert.equal(deletedRows.length, 200000);
    assert.deepEqual((await native.ops.executeQuery('SELECT count(*) AS n FROM t'))[0].rows, [[0]]);
  });

  it('snapshots ordinary rows in one statement', async (t: TestContext) => {
    const native = await openNative(t);
    if (!native) return;
    await native.ops.executeQuery('CREATE TABLE t (v)');
    await native.ops.executeQuery(tenRows(text(1024)));
    const reads = await cellReadsDuring(t, () => native.ops.deleteRows('t', cases[0].rowIds(10), DEFAULT_UNDO_BUDGET));
    assert.deepEqual(reads, []);
    assert.deepEqual(await contents(native.ops), []);
  });
});

// WebAssembly reads in process, with no frame; the same edits succeed there.
describe('the same batch cell edits on WebAssembly', () => {
  for (const scenario of SCENARIOS.filter(item => !item.refused || /undo snapshot/.test(String(item.refused)))) {
    it(scenario.name, async () => {
      const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations!;
      await assertScenario(engine, scenario);
    });
  }
});
