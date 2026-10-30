import './vscode_mock_setup';

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as v8 from 'node:v8';
import { after, it, type TestContext } from 'node:test';
import * as vscode from 'vscode';
import { createNativeDatabaseConnection, getNativeBinaryPath, NativeWorkerProcess } from '../../src/nativeWorker';
import { runReadSnapshot } from '../../src/core/operation-serializer';
import { importRowsAtomically } from '../../src/core/bulk-import';

// Native row history sends each generated statement text once per
// queryHistoryBatch request; a query names its text by index.

// Directories go last: a throwing t.after hook skips the hooks behind it.
const directories: string[] = [];
after(() => {
  for (const directory of directories) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function databaseFile(t: TestContext): Promise<{ binary: string; file: string } | undefined> {
  const binary = await getNativeBinaryPath(process.cwd());
  if (!binary) {
    if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
    t.skip('Bundled native runtime unavailable');
    return undefined;
  }
  fs.mkdirSync('.tmp', { recursive: true });
  const directory = fs.mkdtempSync(path.resolve('.tmp/native-history-texts-'));
  directories.push(directory);
  const file = path.join(directory, 'texts.db');
  fs.closeSync(fs.openSync(file, 'w'));
  return { binary, file };
}

it('runs history queries that name a shared text by index, beside inline ones', async t => {
  const fixture = await databaseFile(t); if (!fixture) return;
  const worker = new NativeWorkerProcess(fixture.binary, path.resolve('natives/native-worker.js'));
  t.after(() => worker.stop());
  await worker.start();
  await worker.call('open', [fixture.file, false]);
  await worker.call('run', ['CREATE TABLE t(v)']);
  const batch = (queries: unknown[], texts?: unknown) => worker.call<{ results: Array<{ values: unknown[][] }> }>(
    'queryHistoryBatch',
    [queries, 1, 5000, 1000, 1 << 20, ...(texts === undefined ? [] : [texts])]
  );
  const texts = ['INSERT INTO t VALUES (?) RETURNING v', 'SELECT count(*) FROM t'];
  const { results } = await batch([
    { sql: 0, params: [1] },
    { sql: 'INSERT INTO t VALUES (?) RETURNING v', params: [2] },
    { sql: 0, params: ['x'] },
    { sql: 1, params: [] }
  ], texts);
  assert.deepEqual(results.map(result => result.values), [[[1]], [[2]], [['x']], [[3]]]);

  const refused: Array<[unknown[], unknown]> = [
    [[{ sql: 2, params: [] }], texts],
    [[{ sql: -1, params: [] }], texts],
    [[{ sql: 0.5, params: [] }], texts],
    [[{ sql: 0, params: [] }], undefined],
    [[{ sql: 0, params: [] }], [7]],
    [[{ sql: 0, params: [] }], 'SELECT 1']
  ];
  for (const [queries, sharedTexts] of refused) {
    await assert.rejects(batch(queries, sharedTexts), /Invalid row-history batch/, JSON.stringify([queries, sharedTexts]));
  }
  const count = await batch([{ sql: 'SELECT count(*) FROM t', params: [] }]);
  assert.deepEqual(count.results[0].values, [[3]]);
});

// SQLite refuses RETURNING on a DELETE from a virtual table, so the history
// checks of such deletes cannot use it.
it('undoes and redoes row history on an R*Tree virtual table', async t => {
  const fixture = await databaseFile(t); if (!fixture) return;
  const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
  t.after(() => native.workerMethods[Symbol.dispose]());
  const { databaseOps } = await native.establishConnection(vscode.Uri.file(fixture.file), 'texts.db', false);
  await databaseOps.executeQuery('CREATE VIRTUAL TABLE boxes USING rtree(id, x0, x1)');
  const contents = async () => (await databaseOps.executeQuery('SELECT id, x0, x1 FROM boxes ORDER BY id'))[0].rows;
  const inserted = await databaseOps.insertRowWithHistory!('boxes', { x0: 1.5, x1: 2.5 });
  const insert = {
    modificationType: 'row_insert' as const, targetTable: 'boxes', description: 'Insert box',
    targetRowId: inserted.rowId, rowData: inserted.row, insertedRow: inserted
  };
  const one = await contents();
  assert.equal(one.length, 1);
  await databaseOps.undoModification(insert);
  assert.deepEqual(await contents(), []);
  await databaseOps.redoModification(insert);
  assert.deepEqual(await contents(), one);
  const deletedRows = await databaseOps.deleteRows('boxes', [inserted.rowId]);
  const remove = {
    modificationType: 'row_delete' as const, targetTable: 'boxes', description: 'Delete box',
    affectedRowIds: [inserted.rowId], deletedRows
  };
  await databaseOps.undoModification(remove);
  assert.deepEqual(await contents(), one);
  await databaseOps.redoModification(remove);
  assert.deepEqual(await contents(), []);
});

it('sends an import\'s history texts once per request, not once per row', async t => {
  const fixture = await databaseFile(t); if (!fixture) return;
  const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
  t.after(() => native.workerMethods[Symbol.dispose]());
  const { databaseOps } = await native.establishConnection(vscode.Uri.file(fixture.file), 'texts.db', false);
  await databaseOps.executeQuery('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, score REAL, note TEXT)');
  const contents = async () => (await databaseOps.executeQuery(
    'SELECT id, typeof(name), name, typeof(score), score, note FROM items ORDER BY id'
  ))[0].rows;

  const requests: unknown[][] = [];
  const originalCall = NativeWorkerProcess.prototype.call;
  t.mock.method(NativeWorkerProcess.prototype, 'call', function(this: NativeWorkerProcess, ...args: Parameters<typeof originalCall>) {
    if (args[0] === 'queryHistoryBatch') requests.push(args[1] as unknown[]);
    return originalCall.apply(this, args);
  });
  const rows = Array.from({ length: 400 }, (_, index) => ({ name: `n${index}`, score: index + 0.5, note: 'x'.repeat(index % 7) }));
  const modification = await runReadSnapshot(databaseOps, tx => importRowsAtomically(tx, 'items', rows, 64 * 1024 * 1024));
  const imported = await contents();
  assert.equal(imported.length, 400);
  await databaseOps.undoModification(modification);
  assert.deepEqual(await contents(), []);
  await databaseOps.redoModification(modification);
  assert.deepEqual(await contents(), imported);

  assert.ok(requests.length > 0);
  let queries = 0;
  let bytes = 0;
  for (const request of requests) {
    const [batch, , , , , texts] = request as [Array<{ sql: unknown }>, ...unknown[]];
    assert.ok(Array.isArray(texts) && texts.length <= 8, `shared texts: ${JSON.stringify(texts)?.slice(0, 200)}`);
    for (const query of batch) assert.equal(typeof query.sql, 'number');
    queries += batch.length;
    bytes += v8.serialize(request).byteLength;
  }
  // A query carries its parameters and an index; its text crossed once.
  assert.ok(bytes / queries < 100, `${(bytes / queries).toFixed(0)} request bytes per query`);
});
