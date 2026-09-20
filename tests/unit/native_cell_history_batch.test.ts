import './vscode_mock_setup';

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it, type TestContext } from 'node:test';
import * as vscode from 'vscode';
import { createNativeDatabaseConnection, isNativeAvailable, NativeWorkerProcess } from '../../src/nativeWorker';
import type { ModificationEntry } from '../../src/core/types';

async function fixture(t: TestContext, rows = 300) {
  const root = process.cwd();
  if (!await isNativeAvailable(root)) { t.skip('Bundled native runtime unavailable'); return; }
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, '.tmp', 'native-history-batch-'));
  const file = path.join(directory, 'history.sqlite');
  const seed = new DatabaseSync(file);
  try {
    seed.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, value, bytes BLOB)');
    seed.exec(`WITH RECURSIVE rows(id) AS (VALUES(1) UNION ALL SELECT id + 1 FROM rows WHERE id < ${rows})
      INSERT INTO items SELECT id, 'before-' || id, x'00FF' FROM rows`);
  } finally { seed.close(); }
  const bundle = await createNativeDatabaseConnection(vscode.Uri.file(root));
  t.after(() => {
    bundle.workerMethods[Symbol.dispose]();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { databaseOps: db } = await bundle.establishConnection(vscode.Uri.file(file), 'history.sqlite');
  const cells = await db.updateCellBatch('items', Array.from({ length: rows }, (_, index) => [
    { rowId: index + 1, column: 'value', value: index % 2 ? 9007199254740993n : null },
    { rowId: index + 1, column: 'bytes', value: new Uint8Array([index % 256, 0, 128]) }
  ]).flat());
  const modification: ModificationEntry = {
    modificationType: 'cell_update', targetTable: 'items', description: 'Batch history', affectedCells: cells
  };
  const read = async () => (await db.executeQuery(
    'SELECT id, typeof(value), CAST(value AS TEXT), hex(bytes) FROM items ORDER BY id'
  ))[0].rows;
  return { db, modification, read, rows };
}

it('replays exact native cell batches without per-row IPC and respects an outer savepoint', async t => {
  const f = await fixture(t); if (!f) return;
  const after = await f.read();
  const originalCall = NativeWorkerProcess.prototype.call;
  let calls = 0;
  t.mock.method(NativeWorkerProcess.prototype, 'call', function(this: NativeWorkerProcess, ...args: Parameters<typeof originalCall>) {
    calls++;
    return originalCall.apply(this, args);
  });
  await f.db.executeQuery('SAVEPOINT caller_history');
  calls = 0;
  await f.db.undoModification(f.modification);
  const undoCalls = calls;
  assert.deepEqual(await f.read(), Array.from({ length: f.rows }, (_, index) => [index + 1, 'text', `before-${index + 1}`, '00FF']));
  calls = 0;
  await f.db.redoModification(f.modification);
  const redoCalls = calls;
  assert.deepEqual(await f.read(), after);
  await f.db.undoModification(f.modification);
  await f.db.executeQuery('ROLLBACK TO caller_history; RELEASE caller_history');
  assert.deepEqual(await f.read(), after, 'replay must not commit the caller savepoint');
  assert.ok(undoCalls < 40, `300-row Undo used ${undoCalls} native calls`);
  assert.ok(redoCalls < 40, `300-row Redo used ${redoCalls} native calls`);
});

it('rolls earlier history chunks back when a late cell was changed or deleted', async t => {
  for (const direction of ['undo', 'redo'] as const) {
    for (const conflict of ['changed', 'deleted'] as const) {
      const f = await fixture(t); if (!f) return;
      if (direction === 'redo') await f.db.undoModification(f.modification);
      await f.db.executeQuery(conflict === 'changed'
        ? `UPDATE items SET value = 'external' WHERE id = ${f.rows}`
        : `DELETE FROM items WHERE id = ${f.rows}`);
      const beforeAttempt = await f.read();
      await assert.rejects(() => direction === 'undo'
        ? f.db.undoModification(f.modification) : f.db.redoModification(f.modification),
      /changed outside SQLite Explorer history/);
      assert.deepEqual(await f.read(), beforeAttempt, `${direction}/${conflict} must be atomic`);
    }
  }
});

it('validates post-write storage before committing a batched native replay', async t => {
  const f = await fixture(t, 3); if (!f) return;
  const before = await f.read();
  const originalCall = NativeWorkerProcess.prototype.call;
  let injected = false;
  t.mock.method(NativeWorkerProcess.prototype, 'call', async function(this: NativeWorkerProcess, ...args: Parameters<typeof originalCall>) {
    const result = await originalCall.apply(this, args);
    if (!injected && args[0] === 'execBatch') {
      injected = true;
      // Simulate an unexpected coercion/side effect after the guarded writes.
      // It must be discovered by the authoritative post-state read.
      await originalCall.call(this, 'run', ["UPDATE items SET value = 'unexpected' WHERE id = 3"]);
    }
    return result;
  });
  await assert.rejects(() => f.db.undoModification(f.modification), /changed outside SQLite Explorer history/);
  assert.equal(injected, true);
  assert.deepEqual(await f.read(), before);
});

it('keeps stable WITHOUT ROWID batches byte-exact and rejects late conflicts', async t => {
  const f = await fixture(t, 1); if (!f) return;
  await f.db.executeQuery("CREATE TABLE keyed(key TEXT PRIMARY KEY, value) WITHOUT ROWID; INSERT INTO keyed VALUES ('a', 1), ('b', 2)");
  const page = await f.db.fetchTableData('keyed', { columns: ['rowid', 'key', 'value'], limit: 2, offset: 0 });
  const cells = await f.db.updateCellBatch('keyed', page.rows.map(row => ({
    rowId: row[0] as string, column: 'value', value: new Uint8Array([0, 255])
  })));
  const modification: ModificationEntry = {
    modificationType: 'cell_update', targetTable: 'keyed', description: 'PK batch', affectedCells: cells
  };
  const read = async () => (await f.db.executeQuery('SELECT key, typeof(value), hex(value) FROM keyed ORDER BY key'))[0].rows;
  await f.db.undoModification(modification);
  assert.deepEqual(await read(), [['a', 'integer', '31'], ['b', 'integer', '32']]);
  await f.db.redoModification(modification);
  const after = await read();
  assert.deepEqual(after, [['a', 'blob', '00FF'], ['b', 'blob', '00FF']]);
  await f.db.executeQuery("UPDATE keyed SET value = 'external' WHERE key = 'b'");
  const conflicted = await read();
  await assert.rejects(() => f.db.undoModification(modification), /changed outside SQLite Explorer history/);
  assert.deepEqual(await read(), conflicted);
});
