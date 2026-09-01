import './vscode_mock_setup'; // Must be first

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';
import * as vscode from 'vscode';

import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import type { DatabaseOperations, RecordId } from '../../src/core/types';

function getBundledNativeBinary(repoRoot: string): string | undefined {
  let platformDir: string | undefined;
  if (process.platform === 'darwin') {
    platformDir = process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos';
  } else if (process.platform === 'linux') {
    platformDir = process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu';
  } else if (process.platform === 'win32' && process.arch === 'x64') {
    platformDir = 'x86_64-windows';
  }
  if (!platformDir) return undefined;
  const binary = path.join(
    repoRoot,
    'natives',
    platformDir,
    process.platform === 'win32' ? 'tjs.exe' : 'tjs'
  );
  return fs.existsSync(binary) ? binary : undefined;
}

it('keeps bundled native table-browser operations in main under TEMP shadowing', async (t) => {
  const repoRoot = process.cwd();
  const binary = getBundledNativeBinary(repoRoot);
  const workerScript = path.join(repoRoot, 'natives', 'native-worker.js');
  if (!binary || !fs.existsSync(workerScript)) {
    t.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
    return;
  }

  const workspaceTmp = path.join(repoRoot, '.tmp');
  fs.mkdirSync(workspaceTmp, { recursive: true });
  const testDir = fs.mkdtempSync(path.join(workspaceTmp, 'native-main-schema-'));
  const databasePath = path.join(testDir, 'main-schema.sqlite');
  fs.closeSync(fs.openSync(databasePath, 'w'));

  let bundle: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
  try {
    bundle = await createNativeDatabaseConnection(vscode.Uri.file(repoRoot));
    const connection = await bundle.establishConnection(
      vscode.Uri.file(databasePath),
      'main-schema.sqlite'
    );
    const engine: DatabaseOperations = connection.databaseOps;

    await t.test('fetches and counts main while raw SQL remains TEMP-first', async () => {
      await engine.executeQuery(
        'CREATE TABLE native_shadow_fetch (value TEXT); ' +
        "INSERT INTO main.native_shadow_fetch VALUES ('main-one'), ('main-two'); " +
        'CREATE TEMP TABLE native_shadow_fetch (value TEXT); ' +
        "INSERT INTO temp.native_shadow_fetch VALUES ('temp-only')"
      );

      const page = await engine.fetchTableData('native_shadow_fetch', {
        columns: ['value'],
        limit: 10,
        offset: 0
      });
      const count = await engine.fetchTableCount('native_shadow_fetch', { columns: ['value'] });
      assert.deepStrictEqual(page.rows, [['main-one'], ['main-two']]);
      assert.deepStrictEqual(count, { count: 2, isExact: true });
      assert.deepStrictEqual(
        (await engine.executeQuery('SELECT value FROM native_shadow_fetch'))[0].rows,
        [['temp-only']]
      );
    });

    await t.test('updates and batch-updates only main', async () => {
      await engine.executeQuery(
        'CREATE TABLE native_shadow_update (left_value TEXT, right_value TEXT); ' +
        "INSERT INTO main.native_shadow_update VALUES ('main-left', 'main-right'); " +
        'CREATE TEMP TABLE native_shadow_update (left_value TEXT, right_value TEXT); ' +
        "INSERT INTO temp.native_shadow_update VALUES ('temp-left', 'temp-right')"
      );
      await engine.updateCell(
        'native_shadow_update',
        1,
        'left_value',
        'main-left-updated'
      );
      await engine.updateCellBatch('native_shadow_update', [
        { rowId: 1, column: 'right_value', value: 'main-right-updated' }
      ]);
      assert.deepStrictEqual(
        (await engine.executeQuery('SELECT * FROM main.native_shadow_update'))[0].rows,
        [['main-left-updated', 'main-right-updated']]
      );
      assert.deepStrictEqual(
        (await engine.executeQuery('SELECT * FROM temp.native_shadow_update'))[0].rows,
        [['temp-left', 'temp-right']]
      );
    });

    await t.test('reads and replaces the main oversized cell', async () => {
      const mainPayload = 'm'.repeat(32);
      const tempPayload = 't'.repeat(32);
      await engine.executeQuery('CREATE TABLE native_shadow_replace (payload TEXT)');
      await engine.executeQuery(
        'INSERT INTO main.native_shadow_replace VALUES (?)',
        [mainPayload]
      );
      await engine.executeQuery('CREATE TEMP TABLE native_shadow_replace (payload TEXT)');
      await engine.executeQuery(
        'INSERT INTO temp.native_shadow_replace VALUES (?)',
        [tempPayload]
      );

      const session = await engine.openCellReadSession({
        table: 'native_shadow_replace',
        rowId: 1,
        column: 'payload'
      });
      try {
        const chunk = await engine.readCellChunk(session.sessionId, 0, 64);
        assert.strictEqual(new TextDecoder().decode(chunk.bytes), mainPayload);
      } finally {
        await engine.closeCellReadSession(session.sessionId);
      }
      await engine.replaceOversizedCell(
        'native_shadow_replace',
        1,
        'payload',
        'main-replacement',
        { storageClass: 'text', byteLength: 32 },
        16
      );
      assert.deepStrictEqual(
        (await engine.executeQuery('SELECT payload FROM main.native_shadow_replace'))[0].rows,
        [['main-replacement']]
      );
      assert.deepStrictEqual(
        (await engine.executeQuery('SELECT payload FROM temp.native_shadow_replace'))[0].rows,
        [[tempPayload]]
      );
    });

    await t.test('inserts single and batch rows only into main', async () => {
      await engine.executeQuery(
        'CREATE TABLE native_shadow_insert (value TEXT); ' +
        "INSERT INTO main.native_shadow_insert(rowid, value) VALUES (1, 'main-existing'); " +
        'CREATE TEMP TABLE native_shadow_insert (value TEXT); ' +
        "INSERT INTO temp.native_shadow_insert(rowid, value) VALUES (10, 'temp-existing')"
      );
      const rowId = await engine.insertRow(
        'native_shadow_insert',
        { value: 'main-single' }
      );
      await engine.insertRowBatch('native_shadow_insert', [
        { value: 'main-batch-one' },
        { value: 'main-batch-two' }
      ]);
      assert.strictEqual(rowId, 2);
      assert.deepStrictEqual(
        (await engine.executeQuery(
          'SELECT rowid, value FROM main.native_shadow_insert ORDER BY rowid'
        ))[0].rows,
        [[1, 'main-existing'], [2, 'main-single'], [3, 'main-batch-one'], [4, 'main-batch-two']]
      );
      assert.deepStrictEqual(
        (await engine.executeQuery(
          'SELECT rowid, value FROM temp.native_shadow_insert ORDER BY rowid'
        ))[0].rows,
        [[10, 'temp-existing']]
      );
    });

    await t.test('deletes only main and captures the main snapshot', async () => {
      await engine.executeQuery(
        'CREATE TABLE native_shadow_delete (value TEXT); ' +
        "INSERT INTO main.native_shadow_delete VALUES ('main-value'); " +
        'CREATE TEMP TABLE native_shadow_delete (value TEXT); ' +
        "INSERT INTO temp.native_shadow_delete VALUES ('temp-value')"
      );
      const deleted = await engine.deleteRows('native_shadow_delete', [1]);
      assert.deepStrictEqual(deleted, [{
        rowId: 1,
        row: { value: 'main-value' },
        storageClasses: [{ column: 'value', storageClass: 'text' }]
      }]);
      assert.deepStrictEqual(
        (await engine.executeQuery('SELECT * FROM main.native_shadow_delete'))[0].rows,
        []
      );
      assert.deepStrictEqual(
        (await engine.executeQuery('SELECT * FROM temp.native_shadow_delete'))[0].rows,
        [['temp-value']]
      );
    });

    await t.test('undo remains bound to main after the TEMP table is removed', async () => {
      await engine.executeQuery(
        'CREATE TABLE native_shadow_undo (value TEXT); ' +
        "INSERT INTO main.native_shadow_undo VALUES ('main-original'); " +
        'CREATE TEMP TABLE native_shadow_undo (value TEXT)'
      );
      const insertedRow = await engine.insertRowWithHistory!(
        'native_shadow_undo',
        { value: 'main-inserted' }
      );
      await engine.executeQuery('DROP TABLE temp.native_shadow_undo');
      await engine.undoModification({
        description: 'Undo native main insert with removed TEMP shadow',
        modificationType: 'row_insert',
        targetTable: 'native_shadow_undo',
        targetRowId: insertedRow.rowId,
        rowData: insertedRow.row,
        insertedRow
      });
      assert.deepStrictEqual(
        (await engine.executeQuery(
          'SELECT rowid, value FROM main.native_shadow_undo ORDER BY rowid'
        ))[0].rows,
        [[1, 'main-original']]
      );
    });

    await t.test('rejects duplicate canonical rowid and PK batch targets', async () => {
      await engine.executeQuery(
        'CREATE TABLE native_duplicate_rowid_target (value TEXT); ' +
        "INSERT INTO native_duplicate_rowid_target VALUES ('before'); " +
        'CREATE TABLE native_duplicate_pk_target ' +
        '(id TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID; ' +
        "INSERT INTO native_duplicate_pk_target VALUES ('key', 'before')"
      );
      await assert.rejects(
        engine.updateCellBatch('native_duplicate_rowid_target', [
          { rowId: 1, column: 'value', value: 'first' },
          { rowId: '1', column: 'VALUE', value: 'second' }
        ]),
        /duplicate.*batch.*target/i
      );
      assert.deepStrictEqual(
        (await engine.executeQuery(
          'SELECT value FROM main.native_duplicate_rowid_target'
        ))[0].rows,
        [['before']]
      );

      const page = await engine.fetchTableData('native_duplicate_pk_target', {
        columns: ['rowid', 'id', 'value'],
        limit: 10,
        offset: 0
      });
      const primaryKeyId = page.rows[0][0] as RecordId;
      await assert.rejects(
        engine.updateCellBatch('native_duplicate_pk_target', [
          { rowId: primaryKeyId, column: 'value', value: 'first' },
          { rowId: primaryKeyId, column: 'VALUE', value: 'second' }
        ]),
        /duplicate.*batch.*target/i
      );
      assert.deepStrictEqual(
        (await engine.executeQuery(
          'SELECT value FROM main.native_duplicate_pk_target'
        ))[0].rows,
        [['before']]
      );
    });
  } finally {
    bundle?.workerMethods[Symbol.dispose]();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});
