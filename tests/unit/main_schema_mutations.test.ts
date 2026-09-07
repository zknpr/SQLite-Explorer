import './vscode_mock_setup';

import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations, RecordId } from '../../src/core/types';

describe('WASM table-browser operations stay in the main schema', () => {
  let engine: DatabaseOperations;

  beforeEach(async () => {
    const opened = await createDatabaseEngine({
      content: null,
      maxSize: 0,
      readOnlyMode: false
    });
    engine = opened.operations!;
  });

  afterEach(() => {
    (engine as WasmDatabaseEngine).shutdown();
  });

  it('updates and batch-updates main rows when TEMP has the same table name', async () => {
    await engine.executeQuery(
      'CREATE TABLE shadow_update (left_value TEXT, right_value TEXT); ' +
      "INSERT INTO main.shadow_update VALUES ('main-left', 'main-right'); " +
      'CREATE TEMP TABLE shadow_update (left_value TEXT, right_value TEXT); ' +
      "INSERT INTO temp.shadow_update VALUES ('temp-left', 'temp-right')"
    );

    await engine.updateCell('shadow_update', 1, 'left_value', 'main-left-updated');
    await engine.updateCellBatch('shadow_update', [
      { rowId: 1, column: 'right_value', value: 'main-right-updated' }
    ]);

    assert.deepStrictEqual(
      (await engine.executeQuery('SELECT * FROM main.shadow_update'))[0].rows,
      [['main-left-updated', 'main-right-updated']]
    );
    assert.deepStrictEqual(
      (await engine.executeQuery('SELECT * FROM temp.shadow_update'))[0].rows,
      [['temp-left', 'temp-right']]
    );
  });

  it('replaces the confirmed oversized main cell when TEMP shadows the table', async () => {
    const mainPayload = 'm'.repeat(32);
    const tempPayload = 't'.repeat(32);
    await engine.executeQuery('CREATE TABLE shadow_replace (payload TEXT)');
    await engine.executeQuery('INSERT INTO main.shadow_replace VALUES (?)', [mainPayload]);
    await engine.executeQuery('CREATE TEMP TABLE shadow_replace (payload TEXT)');
    await engine.executeQuery('INSERT INTO temp.shadow_replace VALUES (?)', [tempPayload]);

    const metadata = await engine.getCellMetadata({
      table: 'shadow_replace',
      rowId: 1,
      column: 'payload'
    });
    assert.deepStrictEqual(metadata, { storageClass: 'text', byteLength: 32, textEncoding: 'utf-8' });
    await engine.replaceOversizedCell(
      'shadow_replace',
      1,
      'payload',
      'main-replacement',
      { storageClass: 'text', byteLength: 32 },
      16
    );

    assert.deepStrictEqual(
      (await engine.executeQuery('SELECT payload FROM main.shadow_replace'))[0].rows,
      [['main-replacement']]
    );
    assert.deepStrictEqual(
      (await engine.executeQuery('SELECT payload FROM temp.shadow_replace'))[0].rows,
      [[tempPayload]]
    );
  });

  it('inserts single and batch rows only into main', async () => {
    await engine.executeQuery(
      'CREATE TABLE shadow_insert (value TEXT); ' +
      "INSERT INTO main.shadow_insert(rowid, value) VALUES (1, 'main-existing'); " +
      'CREATE TEMP TABLE shadow_insert (value TEXT); ' +
      "INSERT INTO temp.shadow_insert(rowid, value) VALUES (10, 'temp-existing')"
    );

    const rowId = await engine.insertRow('shadow_insert', { value: 'main-single' });
    await engine.insertRowBatch('shadow_insert', [
      { value: 'main-batch-one' },
      { value: 'main-batch-two' }
    ]);

    assert.strictEqual(rowId, 2);
    assert.deepStrictEqual(
      (await engine.executeQuery(
        'SELECT rowid, value FROM main.shadow_insert ORDER BY rowid'
      ))[0].rows,
      [[1, 'main-existing'], [2, 'main-single'], [3, 'main-batch-one'], [4, 'main-batch-two']]
    );
    assert.deepStrictEqual(
      (await engine.executeQuery(
        'SELECT rowid, value FROM temp.shadow_insert ORDER BY rowid'
      ))[0].rows,
      [[10, 'temp-existing']]
    );
  });

  it('deletes only main rows and snapshots the main values', async () => {
    await engine.executeQuery(
      'CREATE TABLE shadow_delete (value TEXT); ' +
      "INSERT INTO main.shadow_delete VALUES ('main-value'); " +
      'CREATE TEMP TABLE shadow_delete (value TEXT); ' +
      "INSERT INTO temp.shadow_delete VALUES ('temp-value')"
    );

    const deleted = await engine.deleteRows('shadow_delete', [1]);

    assert.deepStrictEqual(deleted, [{
      rowId: 1,
      row: { value: 'main-value' },
      storageClasses: [{ column: 'value', storageClass: 'text' }]
    }]);
    assert.deepStrictEqual(
      (await engine.executeQuery('SELECT * FROM main.shadow_delete'))[0].rows,
      []
    );
    assert.deepStrictEqual(
      (await engine.executeQuery('SELECT * FROM temp.shadow_delete'))[0].rows,
      [['temp-value']]
    );
  });

  it('keeps an inserted-row undo bound to main after the TEMP shadow is removed', async () => {
    await engine.executeQuery(
      'CREATE TABLE shadow_undo (value TEXT); ' +
      "INSERT INTO main.shadow_undo VALUES ('main-original'); " +
      'CREATE TEMP TABLE shadow_undo (value TEXT)'
    );

    const insertedRow = await engine.insertRowWithHistory!(
      'shadow_undo',
      { value: 'main-inserted' }
    );
    await engine.executeQuery('DROP TABLE temp.shadow_undo');
    await engine.undoModification({
      description: 'Undo main insert with removed TEMP shadow',
      modificationType: 'row_insert',
      targetTable: 'shadow_undo',
      targetRowId: insertedRow.rowId,
      rowData: insertedRow.row,
      insertedRow
    });

    assert.deepStrictEqual(
      (await engine.executeQuery('SELECT rowid, value FROM main.shadow_undo ORDER BY rowid'))[0].rows,
      [[1, 'main-original']]
    );
  });

  it('reads cell bytes from main while raw SQL retains TEMP-first resolution', async () => {
    await engine.executeQuery(
      'CREATE TABLE shadow_cell_read (payload TEXT); ' +
      "INSERT INTO main.shadow_cell_read VALUES ('main-cell-value'); " +
      'CREATE TEMP TABLE shadow_cell_read (payload TEXT); ' +
      "INSERT INTO temp.shadow_cell_read VALUES ('temp')"
    );

    const session = await engine.openCellReadSession({
      table: 'shadow_cell_read',
      rowId: 1,
      column: 'payload'
    });
    try {
      const chunk = await engine.readCellChunk(session.sessionId, 0, 64);
      assert.strictEqual(new TextDecoder().decode(chunk.bytes), 'main-cell-value');
    } finally {
      await engine.closeCellReadSession(session.sessionId);
    }

    assert.deepStrictEqual(
      (await engine.executeQuery('SELECT payload FROM shadow_cell_read'))[0].rows,
      [['temp']]
    );
  });

  it('rejects duplicate canonical rowid and PK batch targets before changing a value', async () => {
    await engine.executeQuery(
      'CREATE TABLE duplicate_rowid_target (value TEXT); ' +
      "INSERT INTO duplicate_rowid_target VALUES ('before'); " +
      'CREATE TABLE duplicate_pk_target (id TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID; ' +
      "INSERT INTO duplicate_pk_target VALUES ('key', 'before')"
    );

    await assert.rejects(
      engine.updateCellBatch('duplicate_rowid_target', [
        { rowId: 1, column: 'value', value: 'first' },
        { rowId: '1', column: 'VALUE', value: 'second' }
      ]),
      /duplicate.*batch.*target/i
    );
    assert.deepStrictEqual(
      (await engine.executeQuery('SELECT value FROM main.duplicate_rowid_target'))[0].rows,
      [['before']]
    );

    const page = await engine.fetchTableData('duplicate_pk_target', {
      columns: ['rowid', 'id', 'value'],
      limit: 10,
      offset: 0
    });
    const primaryKeyId = page.rows[0][0] as RecordId;
    await assert.rejects(
      engine.updateCellBatch('duplicate_pk_target', [
        { rowId: primaryKeyId, column: 'value', value: 'first' },
        { rowId: primaryKeyId, column: 'VALUE', value: 'second' }
      ]),
      /duplicate.*batch.*target/i
    );
    assert.deepStrictEqual(
      (await engine.executeQuery('SELECT value FROM main.duplicate_pk_target'))[0].rows,
      [['before']]
    );
  });
});
