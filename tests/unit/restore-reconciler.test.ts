import './vscode_mock_setup';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import { ModificationTracker } from '../../src/core/undo-history';
import { reconcileRestoredDatabase } from '../../src/core/restore-reconciler';
import type { DatabaseOperations, LabeledModification } from '../../src/core/types';

async function freshEngine(): Promise<DatabaseOperations> {
  const result = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
  const ops = result.operations!;
  await ops.executeQuery('CREATE TABLE t (id INTEGER PRIMARY KEY, data TEXT)');
  return ops;
}

const cellEdit = (
  label: string,
  prior: string,
  next: string,
  op: 'set' | 'json_patch' = 'set'
): LabeledModification => ({
  label,
  description: label,
  modificationType: 'cell_update',
  targetTable: 't',
  targetRowId: 1,
  targetColumn: 'data',
  priorValue: prior,
  newValue: next,
  operation: op
});

describe('reconcileRestoredDatabase', () => {
  it('W1: WASM restore reverts a saved-then-undone edit to the undone value', async () => {
    const ops = await freshEngine();
    await ops.insertRow('t', { id: 1, data: 'original' });
    await ops.updateCell('t', 1, 'data', 'edited');

    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(cellEdit('e', 'original', 'edited'));
    await tracker.createCheckpoint();
    tracker.stepBack();

    await reconcileRestoredDatabase(ops, tracker, 'wasm');

    const r = await ops.executeQuery('SELECT data FROM t WHERE id = 1');
    assert.strictEqual(r[0].rows[0][0], 'original');
    assert.strictEqual(tracker.canStepForward, true);
  });

  it('W2: reverts two saved-then-undone edits to the same cell in the correct order', async () => {
    const ops = await freshEngine();
    await ops.insertRow('t', { id: 1, data: 'v0' });
    await ops.updateCell('t', 1, 'data', 'v1');
    await ops.updateCell('t', 1, 'data', 'v2');

    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(cellEdit('e1', 'v0', 'v1'));
    tracker.record(cellEdit('e2', 'v1', 'v2'));
    await tracker.createCheckpoint();
    tracker.stepBack();
    tracker.stepBack();

    await reconcileRestoredDatabase(ops, tracker, 'wasm');

    const r = await ops.executeQuery('SELECT data FROM t WHERE id = 1');
    assert.strictEqual(r[0].rows[0][0], 'v0');
  });

  it('W3: WASM restore replays forward edits recorded after the checkpoint', async () => {
    const ops = await freshEngine();
    await ops.insertRow('t', { id: 1, data: 'v0' });
    await ops.updateCell('t', 1, 'data', 'v1');

    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(cellEdit('e1', 'v0', 'v1'));
    await tracker.createCheckpoint();
    tracker.record(cellEdit('e2', 'v1', 'v2'));

    await reconcileRestoredDatabase(ops, tracker, 'wasm');

    const r = await ops.executeQuery('SELECT data FROM t WHERE id = 1');
    assert.strictEqual(r[0].rows[0][0], 'v2');
  });

  it('W4: WASM restore reverts a saved-then-undone json_patch edit faithfully (uses #427)', async () => {
    const ops = await freshEngine();
    await ops.insertRow('t', { id: 1, data: '{"x":1,"y":2}' });
    await ops.updateCell('t', 1, 'data', null, '{"x":9}');

    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(cellEdit('jp', '{"x":1,"y":2}', '{"x":9}', 'json_patch'));
    await tracker.createCheckpoint();
    tracker.stepBack();

    await reconcileRestoredDatabase(ops, tracker, 'wasm');

    const r = await ops.executeQuery('SELECT data FROM t WHERE id = 1');
    assert.deepStrictEqual(JSON.parse(r[0].rows[0][0] as string), { x: 1, y: 2 });
  });

  it('native: reconcile performs no database operations and keeps redo available', async () => {
    const calls: string[] = [];
    const ops = {
      applyModifications: async () => { calls.push('apply'); },
      undoModification: async () => { calls.push('undo'); }
    } as unknown as DatabaseOperations;

    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(cellEdit('e', 'a', 'b'));
    await tracker.createCheckpoint();
    tracker.stepBack();

    await reconcileRestoredDatabase(ops, tracker, 'native');

    assert.deepStrictEqual(calls, []);
    assert.strictEqual(tracker.canStepForward, true);
  });
});
