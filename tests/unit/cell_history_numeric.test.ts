import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { storedCellStatesEqual } from '../../src/core/cell-history';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import type { ModificationEntry } from '../../src/core/types';

describe('exact numeric cell history', () => {
  let engine: WasmDatabaseEngine | undefined;
  afterEach(() => { engine?.shutdown(); engine = undefined; });

  it('compares only losslessly equivalent INTEGER number and bigint representations', () => {
    assert.equal(storedCellStatesEqual(
      { storageClass: 'integer', value: 7 }, { storageClass: 'integer', value: 7n }
    ), true);
    assert.equal(storedCellStatesEqual(
      { storageClass: 'integer', value: 7n }, { storageClass: 'integer', value: 7 }
    ), true);
    assert.equal(storedCellStatesEqual(
      { storageClass: 'integer', value: 7n }, { storageClass: 'integer', value: 8 }
    ), false);
    assert.equal(storedCellStatesEqual(
      { storageClass: 'integer', value: 7n }, { storageClass: 'real', value: 7 }
    ), false);
    assert.equal(storedCellStatesEqual(
      { storageClass: 'integer', value: 9007199254740992n },
      { storageClass: 'integer', value: 9007199254740992 }
    ), false);
  });

  for (const [before, after] of [
    [7n, 9n],
    [9007199254740991n, 9007199254740992n],
    [-9223372036854775808n, 9223372036854775807n]
  ]) {
    it(`undoes and redoes INTEGER ${before} after a full-image save without weakening conflicts`, async () => {
      engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
      await engine.executeQuery('CREATE TABLE items(id INTEGER PRIMARY KEY, value INTEGER);');
      await engine.executeQuery('INSERT INTO items VALUES(1, CAST(? AS INTEGER))', [before.toString()]);
      const [cell] = await engine.updateCellBatch('items', [{ rowId: 1, column: 'value', value: after }]);
      const modification: ModificationEntry = {
        description: 'Edit INTEGER value',
        modificationType: 'cell_update', targetTable: 'items', targetRowId: 1,
        targetColumn: 'value', priorValue: cell.priorValue, newValue: cell.newValue,
        priorState: cell.priorState, postState: cell.postState, operation: cell.operation
      };
      const current = async () => (await engine!.executeQuery('SELECT typeof(value), CAST(value AS TEXT) FROM items'))[0].rows;
      await engine.serializeDatabase();
      await engine.undoModification(modification);
      assert.deepEqual(await current(), [['integer', before.toString()]]);
      await engine.serializeDatabase();
      await engine.redoModification(modification);
      assert.deepEqual(await current(), [['integer', after.toString()]]);
      await engine.executeQuery('UPDATE items SET value = 42');
      await assert.rejects(() => engine!.undoModification(modification), /changed outside SQLite Explorer history/);
      assert.deepEqual(await current(), [['integer', '42']]);
    });
  }
});
