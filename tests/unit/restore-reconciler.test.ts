import './vscode_mock_setup';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import { ModificationTracker } from '../../src/core/undo-history';
import * as restoreReconciler from '../../src/core/restore-reconciler';
import type { DatabaseOperations, LabeledModification } from '../../src/core/types';

const { reconcileRestoredDatabase } = restoreReconciler;

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
  op: 'set' | 'json_patch' = 'set',
  column: string = 'data'
): LabeledModification => ({
  label,
  description: label,
  modificationType: 'cell_update',
  targetTable: 't',
  targetRowId: 1,
  targetColumn: column,
  priorValue: prior,
  newValue: next,
  operation: op
});

const roundTripTracker = (
  tracker: ModificationTracker<LabeledModification>
): ModificationTracker<LabeledModification> =>
  ModificationTracker.deserialize<LabeledModification>(tracker.serialize());

describe('reconcileRestoredDatabase', () => {
  it('hot-exit round-trip retains a complete within-cap barrier segment for WASM replay', async () => {
    const applied: LabeledModification[] = [];
    const operations = {
      applyModifications: async (entries: LabeledModification[]) => {
        applied.push(...entries);
      },
      undoModification: async () => {}
    } as unknown as DatabaseOperations;
    const tracker = new ModificationTracker<LabeledModification>(300);
    tracker.recordBarrier({
      ...cellEdit('oversized replacement', 'unretained', 'bounded'),
      priorValue: undefined,
      undoPolicy: 'barrier'
    });
    for (let index = 0; index < 200; index++) {
      tracker.record(cellEdit(`later edit ${index}`, String(index), String(index + 1)));
    }

    const restored = roundTripTracker(tracker);
    await reconcileRestoredDatabase(operations, restored, 'wasm');

    assert.strictEqual(restored.hasUncommittedHistoryBarrier, true);
    assert.deepStrictEqual(
      applied.map(entry => entry.label),
      ['oversized replacement', ...Array.from({ length: 200 }, (_, index) => `later edit ${index}`)]
    );
  });

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

  it('BC-restore branch: reverts the saved edit and replays the branch edit', async () => {
    const ops = await freshEngine();
    await ops.insertRow('t', { id: 1, data: '{"a":0,"b":0}' });
    await ops.updateCell('t', 1, 'data', '{"a":1,"b":0}');
    await ops.updateCell('t', 1, 'data', '{"a":1,"b":2}');

    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(cellEdit('e1', '{"a":0,"b":0}', '{"a":1,"b":0}'));
    tracker.record(cellEdit('e2', '{"a":1,"b":0}', '{"a":1,"b":2}'));
    await tracker.createCheckpoint();
    tracker.stepBack();
    tracker.record(cellEdit('e3', '{"a":1,"b":0}', '{"c":3}', 'json_patch'));

    await reconcileRestoredDatabase(ops, roundTripTracker(tracker), 'wasm');

    const r = await ops.executeQuery('SELECT data FROM t WHERE id = 1');
    assert.deepStrictEqual(JSON.parse(r[0].rows[0][0] as string), { a: 1, b: 0, c: 3 });
  });

  it('BC-restore multi-branch: reverts abandoned saved edits before replaying the branch', async () => {
    const ops = await freshEngine();
    await ops.insertRow('t', { id: 1, data: 'v0' });
    await ops.updateCell('t', 1, 'data', 'v1');
    await ops.updateCell('t', 1, 'data', 'v2');
    await ops.updateCell('t', 1, 'data', 'v3');

    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(cellEdit('e1', 'v0', 'v1'));
    tracker.record(cellEdit('e2', 'v1', 'v2'));
    tracker.record(cellEdit('e3', 'v2', 'v3'));
    await tracker.createCheckpoint();
    tracker.stepBack();
    tracker.stepBack();
    tracker.record(cellEdit('e4', 'v1', 'v4'));

    await reconcileRestoredDatabase(ops, roundTripTracker(tracker), 'wasm');

    const r = await ops.executeQuery('SELECT data FROM t WHERE id = 1');
    assert.strictEqual(r[0].rows[0][0], 'v4');
  });

  it('BC-restore base: reverts a saved edit that remains on the redo stack', async () => {
    const ops = await freshEngine();
    await ops.insertRow('t', { id: 1, data: 'v0' });
    await ops.updateCell('t', 1, 'data', 'v1');
    await ops.updateCell('t', 1, 'data', 'v2');

    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(cellEdit('e1', 'v0', 'v1'));
    tracker.record(cellEdit('e2', 'v1', 'v2'));
    await tracker.createCheckpoint();
    tracker.stepBack();

    await reconcileRestoredDatabase(ops, roundTripTracker(tracker), 'wasm');

    const r = await ops.executeQuery('SELECT data FROM t WHERE id = 1');
    assert.strictEqual(r[0].rows[0][0], 'v1');
  });

  it('BC-restore forward: replays edits recorded after the saved checkpoint', async () => {
    const ops = await freshEngine();
    await ops.insertRow('t', { id: 1, data: 'v0' });
    await ops.updateCell('t', 1, 'data', 'v1');

    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(cellEdit('e1', 'v0', 'v1'));
    await tracker.createCheckpoint();
    tracker.record(cellEdit('e2', 'v1', 'v2'));

    await reconcileRestoredDatabase(ops, roundTripTracker(tracker), 'wasm');

    const r = await ops.executeQuery('SELECT data FROM t WHERE id = 1');
    assert.strictEqual(r[0].rows[0][0], 'v2');
  });

  it('BC-restore branch then undo common: reverts abandoned saved and common-prefix edits', async () => {
    const ops = await freshEngine();
    await ops.insertRow('t', { id: 1, data: 'v0' });
    await ops.updateCell('t', 1, 'data', 'v1');
    await ops.updateCell('t', 1, 'data', 'v2');

    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(cellEdit('e1', 'v0', 'v1'));
    tracker.record(cellEdit('e2', 'v1', 'v2'));
    await tracker.createCheckpoint();
    tracker.stepBack();
    tracker.record(cellEdit('e3', 'v1', 'v3'));
    tracker.stepBack();
    tracker.stepBack();

    await reconcileRestoredDatabase(ops, roundTripTracker(tracker), 'wasm');

    const r = await ops.executeQuery('SELECT data FROM t WHERE id = 1');
    assert.strictEqual(r[0].rows[0][0], 'v0');
  });

  it('BC-revert branch: File>Revert restores the saved state without losing data', async () => {
    const ops = await freshEngine();
    await ops.insertRow('t', { id: 1, data: 'v0' });
    await ops.updateCell('t', 1, 'data', 'v1');
    await ops.updateCell('t', 1, 'data', 'v3');

    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(cellEdit('e1', 'v0', 'v1'));
    tracker.record(cellEdit('e2', 'v1', 'v2'));
    await tracker.createCheckpoint();
    tracker.stepBack();
    tracker.record(cellEdit('e3', 'v1', 'v3'));

    await restoreReconciler.revertDatabaseToSaved(ops, tracker);

    const r = await ops.executeQuery('SELECT data FROM t WHERE id = 1');
    assert.strictEqual(r[0].rows[0][0], 'v2');
    assert.strictEqual(tracker.hasUncommittedChanges(), false);
  });

  it('BC-revert base: File>Revert reapplies a saved edit that was undone', async () => {
    const ops = await freshEngine();
    await ops.insertRow('t', { id: 1, data: 'v0' });
    await ops.updateCell('t', 1, 'data', 'v1');

    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(cellEdit('e1', 'v0', 'v1'));
    tracker.record(cellEdit('e2', 'v1', 'v2'));
    await tracker.createCheckpoint();
    tracker.stepBack();

    await restoreReconciler.revertDatabaseToSaved(ops, tracker);

    const r = await ops.executeQuery('SELECT data FROM t WHERE id = 1');
    assert.strictEqual(r[0].rows[0][0], 'v2');
    assert.strictEqual(tracker.hasUncommittedChanges(), false);
  });

  it('BC-revert forward: File>Revert discards edits recorded after the checkpoint', async () => {
    const ops = await freshEngine();
    await ops.insertRow('t', { id: 1, data: 'v0' });
    await ops.updateCell('t', 1, 'data', 'v1');
    await ops.updateCell('t', 1, 'data', 'v2');

    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(cellEdit('e1', 'v0', 'v1'));
    await tracker.createCheckpoint();
    tracker.record(cellEdit('e2', 'v1', 'v2'));

    await restoreReconciler.revertDatabaseToSaved(ops, tracker);

    const r = await ops.executeQuery('SELECT data FROM t WHERE id = 1');
    assert.strictEqual(r[0].rows[0][0], 'v1');
    assert.strictEqual(tracker.hasUncommittedChanges(), false);
  });

  it('BC-restore failure: a failing revert propagates and earlier reverts are not batch-rolled-back', async () => {
    const ops = await freshEngine();
    await ops.insertRow('t', { id: 1, data: 'v0' });
    await ops.updateCell('t', 1, 'data', 'v1');
    await ops.updateCell('t', 1, 'data', 'v2');

    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(cellEdit('bad', 'v0', 'v1', 'set', 'missing_column'));
    tracker.record(cellEdit('e2', 'v1', 'v2'));
    await tracker.createCheckpoint();
    tracker.stepBack();
    tracker.stepBack();

    // The reconcile runs per-operation-atomic engine calls with NO outer
    // SAVEPOINT (an outer transaction would conflict with the BEGIN-based
    // row/column undos and break restoring deleted rows/columns). So a failing
    // entry propagates the error to the caller (DatabaseDocument.create opens
    // the document read-only) but does NOT roll back reverts that already
    // committed: 'e2' reverts first (v2 -> v1), then 'bad' fails on missing_column.
    await assert.rejects(
      reconcileRestoredDatabase(ops, roundTripTracker(tracker), 'wasm'),
      /missing_column|no such column/i
    );

    // Earlier revert stayed committed (would be 'v2' if an outer SAVEPOINT had
    // rolled the sequence back). This guards against re-introducing that wrap.
    const r = await ops.executeQuery('SELECT data FROM t WHERE id = 1');
    assert.strictEqual(r[0].rows[0][0], 'v1');
  });

  it('BC-revert native: re-applies saved-undone edits via redoModification, not unsupported applyModifications', async () => {
    // Native history replay belongs to redoModification; applyModifications is
    // unsupported. Record both calls so this unit test pins the branch even when
    // the bundled native binary is unavailable.
    const redone: string[] = [];
    const applied: string[] = [];
    const discarded: string[] = [];
    const mockOps = {
      applyModifications: async (mods: LabeledModification[]) => {
        applied.push(...mods.map((m) => m.label));
      },
      redoModification: async (mod: LabeledModification) => {
        redone.push(mod.label);
      },
      discardModifications: async (mods: LabeledModification[]) => {
        discarded.push(...mods.map((m) => m.label));
      },
      undoModification: async () => {}
    } as unknown as DatabaseOperations;

    // Branch: save [e1,e2], undo e2, then record e3 so e2 lands in revertOnRestore.
    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(cellEdit('e1', 'a', 'b'));
    tracker.record(cellEdit('e2', 'b', 'c'));
    await tracker.createCheckpoint();
    tracker.stepBack();
    tracker.record(cellEdit('e3', 'b', 'd'));

    await restoreReconciler.revertDatabaseToSaved(mockOps, tracker);

    assert.deepStrictEqual(discarded, ['e3']); // forward edit undone
    assert.deepStrictEqual(redone, ['e2']); // saved-undone edit re-applied via redo path
    assert.deepStrictEqual(applied, []); // never routed through the native no-op
    assert.strictEqual(tracker.hasUncommittedChanges(), false);
  });
});
