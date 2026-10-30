import './vscode_mock_setup';

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, it, type TestContext } from 'node:test';
import * as vscode from 'vscode';
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, isNativeAvailable } from '../../src/nativeWorker';
import type { CellValue, DatabaseOperations, ModificationEntry } from '../../src/core/types';

// FTS3, FTS4 and FTS5 declare hidden columns that are not row data: one named
// like the table (FTS5 reads it as a changing integer, and writing it runs a
// command), FTS3/4's docid rowid alias and FTS5's rank. Row history captured
// them, so undo could not put back a deleted row. FTS4's language column is
// data and must come back.
const KINDS: Array<{ table: string; ddl: string; row: Record<string, CellValue>; columns: string }> = [
  { table: 'notes5', ddl: 'CREATE VIRTUAL TABLE notes5 USING fts5(title, body)', row: { title: 'alpha', body: 'first note' }, columns: 'title, body' },
  { table: 'notes4', ddl: 'CREATE VIRTUAL TABLE notes4 USING fts4(title, body)', row: { title: 'beta', body: 'second note' }, columns: 'title, body' },
  { table: 'notes3', ddl: 'CREATE VIRTUAL TABLE notes3 USING fts3(title, body)', row: { title: 'gamma', body: 'third note' }, columns: 'title, body' },
  { table: 'notes4l', ddl: 'CREATE VIRTUAL TABLE notes4l USING fts4(body, languageid="lid")', row: { body: 'fourth note', lid: 7 }, columns: 'body, lid' }
];

async function assertFtsHistory(ops: DatabaseOperations, kinds = KINDS): Promise<void> {
  for (const kind of kinds) {
    await ops.executeQuery(kind.ddl);
    const contents = async () => (await ops.executeQuery(
      `SELECT rowid, ${kind.columns} FROM ${kind.table} ORDER BY rowid`
    ))[0].rows;
    const inserted = await ops.insertRowWithHistory!(kind.table, kind.row);
    const one = await contents();
    assert.equal(one.length, 1, kind.table);
    const insert: ModificationEntry = {
      modificationType: 'row_insert', targetTable: kind.table, description: `Insert into ${kind.table}`,
      targetRowId: inserted.rowId, rowData: inserted.row, insertedRow: inserted
    };
    await ops.undoModification(insert);
    assert.deepEqual(await contents(), [], `${kind.table}: undo insert`);
    await ops.redoModification(insert);
    assert.deepEqual(await contents(), one, `${kind.table}: redo insert`);

    const deletedRows = await ops.deleteRows(kind.table, [inserted.rowId]);
    const remove: ModificationEntry = {
      modificationType: 'row_delete', targetTable: kind.table, description: `Delete from ${kind.table}`,
      affectedRowIds: [inserted.rowId], deletedRows
    };
    assert.deepEqual(await contents(), [], `${kind.table}: delete`);
    await ops.undoModification(remove);
    assert.deepEqual(await contents(), one, `${kind.table}: undo delete`);
    await ops.redoModification(remove);
    assert.deepEqual(await contents(), [], `${kind.table}: redo delete`);
    // The restored row is searchable again, not only stored.
    await ops.undoModification(remove);
    const match = String(Object.values(kind.row).find(value => typeof value === 'string')).split(' ')[0];
    // A language-id table searches language 0 unless the query names one.
    const language = 'lid' in kind.row ? ` AND lid = ${kind.row.lid}` : '';
    assert.equal((await ops.executeQuery(
      `SELECT count(*) FROM ${kind.table} WHERE ${kind.table} MATCH ?${language}`, [match]
    ))[0].rows[0][0], 1, `${kind.table}: MATCH after undo`);
  }
}

// Directories go last: a throwing t.after hook skips the hooks behind it.
const directories: string[] = [];
after(() => {
  for (const directory of directories) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe('row history on full-text search tables', () => {
  it('undoes and redoes FTS3, FTS4 and FTS5 rows on WebAssembly', async () => {
    const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations!;
    await assertFtsHistory(engine);
  });

  // The bundled native runtime is built with FTS5 but not FTS3 or FTS4.
  it('undoes and redoes FTS5 rows on the native engine', async (t: TestContext) => {
    if (!await isNativeAvailable(process.cwd())) {
      if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
      return t.skip('Bundled native runtime unavailable');
    }
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/fts-row-history-'));
    directories.push(directory);
    const file = path.join(directory, 'fts.db');
    fs.closeSync(fs.openSync(file, 'w'));
    const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
    t.after(() => native.workerMethods[Symbol.dispose]());
    const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'fts.db', false);
    const modules = (await databaseOps.executeQuery(
      "SELECT name FROM pragma_module_list WHERE name IN ('fts3', 'fts4', 'fts5') ORDER BY name"
    ))[0].rows;
    assert.deepEqual(modules, [['fts5']], 'native FTS modules changed: extend this test');
    await assertFtsHistory(databaseOps, KINDS.filter(kind => kind.table === 'notes5'));
  });
});
