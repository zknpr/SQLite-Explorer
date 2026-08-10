import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ModificationTracker } from '../../src/core/undo-history';
import type { LabeledModification } from '../../src/core/types';

const entry = (label: string): LabeledModification => ({
  label,
  description: label,
  modificationType: 'cell_update'
});

describe('ModificationTracker hot-exit persistence', () => {
  it('keeps an at-cap unsaved barrier segment complete through hot-exit serialization', () => {
    const tracker = new ModificationTracker<LabeledModification>(100);
    const barrier: LabeledModification = {
      ...entry('oversized replacement'),
      targetTable: 'items',
      targetRowId: 1,
      targetColumn: 'payload',
      newValue: 'bounded replacement',
      undoPolicy: 'barrier'
    };
    tracker.recordBarrier(barrier);
    for (let index = 0; index < 99; index++) {
      tracker.record({
        ...entry(`later edit ${index}`),
        priorValue: index,
        newValue: index + 1
      });
    }

    assert.throws(
      () => tracker.record({
        ...entry('blocked edit'),
        priorValue: 99,
        newValue: 100
      }),
      /undo history.*limit.*save.*before making more changes/i
    );

    assert.strictEqual(tracker.hasUncommittedHistoryBarrier, true);
    assert.deepStrictEqual(
      tracker.getUncommittedEntries().map(candidate => candidate.label),
      ['oversized replacement', ...Array.from({ length: 99 }, (_, index) => `later edit ${index}`)]
    );

    const restored = ModificationTracker.deserialize<LabeledModification>(tracker.serialize());
    assert.strictEqual(restored.hasUncommittedHistoryBarrier, true);
    assert.deepStrictEqual(
      restored.getUncommittedEntries().map(candidate => candidate.label),
      tracker.getUncommittedEntries().map(candidate => candidate.label)
    );
  });

  it('releases saved barriers back to ordinary front retention', async () => {
    const tracker = new ModificationTracker<LabeledModification>(2);
    for (let index = 0; index < 5; index++) {
      tracker.recordBarrier({
        ...entry(`saved barrier ${index}`),
        newValue: index,
        undoPolicy: 'barrier'
      });
      await tracker.createCheckpoint();
    }

    assert.strictEqual(tracker.hasUncommittedHistoryBarrier, false);
    assert.strictEqual(tracker.entryCount, 2);
    assert.deepStrictEqual(
      tracker['timeline'].map((candidate: LabeledModification) => candidate.label),
      ['saved barrier 3', 'saved barrier 4']
    );
  });

  it('records a forward-only barrier that preserves replay state but cannot be crossed by undo', async () => {
    const t = new ModificationTracker<LabeledModification>();
    t.record(entry('saved'));
    await t.createCheckpoint();
    const unsavedBeforeBarrier = entry('unsaved before barrier');
    t.record(unsavedBeforeBarrier);
    t.record(entry('discarded redo'));
    t.stepBack();

    const barrier: LabeledModification = {
      label: 'Replace Oversized Cell',
      description: 'Replace items.payload without an in-memory prior value',
      modificationType: 'cell_update',
      targetTable: 'items',
      targetRowId: 1,
      targetColumn: 'payload',
      newValue: 'bounded replacement',
      undoPolicy: 'barrier'
    };
    t.recordBarrier(barrier);

    assert.strictEqual(t.entryCount, 3);
    assert.strictEqual(t.canStepBack, false);
    assert.strictEqual(t.canStepForward, false);
    assert.strictEqual(t.stepBack(), undefined);
    assert.strictEqual(t.isUndoBlockedByBarrier, true);
    assert.strictEqual(t.hasUncommittedHistoryBarrier, true);
    assert.strictEqual(t.hasUncommittedChanges(), true);
    assert.deepStrictEqual(t.getUncommittedEntries(), [unsavedBeforeBarrier, barrier]);

    const restored = ModificationTracker.deserialize<LabeledModification>(t.serialize());
    assert.strictEqual(restored.canStepBack, false);
    assert.strictEqual(restored.isUndoBlockedByBarrier, true);
    assert.strictEqual(restored.hasUncommittedHistoryBarrier, true);
    assert.deepStrictEqual(
      restored.getUncommittedEntries(),
      [unsavedBeforeBarrier, barrier]
    );
  });

  it('treats a saved barrier as the new File Revert baseline', async () => {
    const t = new ModificationTracker<LabeledModification>();
    t.recordBarrier({
      ...entry('barrier'),
      newValue: 'bounded replacement',
      undoPolicy: 'barrier'
    });

    assert.strictEqual(t.hasUncommittedHistoryBarrier, true);
    await t.createCheckpoint();
    assert.strictEqual(t.hasUncommittedHistoryBarrier, false);

    t.record({ ...entry('normal'), priorValue: 'a', newValue: 'b' });
    assert.strictEqual(t.hasUncommittedHistoryBarrier, false);
  });

  it('allows a normal edit immediately after a barrier to undo and redo without crossing it', () => {
    const t = new ModificationTracker<LabeledModification>();
    t.recordBarrier({
      ...entry('barrier'),
      newValue: 'bounded replacement',
      undoPolicy: 'barrier'
    });
    const normal = { ...entry('normal'), priorValue: 'a', newValue: 'b' };
    t.record(normal);

    assert.strictEqual(t.canStepBack, true);
    assert.strictEqual(t.stepBack(), normal);
    assert.strictEqual(t.canStepBack, false);
    assert.strictEqual(t.isUndoBlockedByBarrier, true);
    assert.strictEqual(t.canStepForward, true);
    assert.strictEqual(t.stepForward(), normal);
    assert.strictEqual(t.canStepBack, true);
  });

  it('T1: serialize/deserialize round-trips futureStack', () => {
    const t = new ModificationTracker<LabeledModification>();
    t.record(entry('e1'));
    t.record(entry('e2'));
    t.stepBack();

    const restored = ModificationTracker.deserialize<LabeledModification>(t.serialize());

    assert.strictEqual(restored.entryCount, 1);
    assert.strictEqual(restored.canStepForward, true);
    assert.strictEqual(restored.stepForward()?.label, 'e2');
  });

  it('T2: a pre-1.5.1 backup (no futureStack key) yields an empty redo stack', () => {
    const legacy = new TextEncoder().encode(
      JSON.stringify({ timeline: [entry('e1')], checkpointIndex: 1 })
    );

    const restored = ModificationTracker.deserialize<LabeledModification>(legacy);

    assert.strictEqual(restored.entryCount, 1);
    assert.strictEqual(restored.canStepForward, false);
  });

  it('T3: getEntriesUndoneSinceCheckpoint returns the saved-then-undone entries in revert order', async () => {
    const t = new ModificationTracker<LabeledModification>();
    t.record(entry('e1'));
    t.record(entry('e2'));
    await t.createCheckpoint();

    assert.deepStrictEqual(t.getEntriesUndoneSinceCheckpoint().map(e => e.label), []);
    t.stepBack();
    assert.deepStrictEqual(t.getEntriesUndoneSinceCheckpoint().map(e => e.label), ['e2']);
    t.stepBack();
    assert.deepStrictEqual(t.getEntriesUndoneSinceCheckpoint().map(e => e.label), ['e2', 'e1']);
  });

  it('BC1: record after undoing a saved edit captures it and moves the checkpoint', async () => {
    const t = new ModificationTracker<LabeledModification>();
    t.record(entry('e1'));
    t.record(entry('e2'));
    await t.createCheckpoint();
    t.stepBack();
    t.record(entry('e3'));

    assert.strictEqual(t.entryCount, 2);
    assert.deepStrictEqual(t.getCheckpointRevertSequence().map(e => e.label), ['e2']);
    assert.strictEqual(t.hasUncommittedChanges(), true);
  });

  it('BC2: multi-branch accumulates saved-undone in revert order', async () => {
    const t = new ModificationTracker<LabeledModification>();
    t.record(entry('e1'));
    t.record(entry('e2'));
    t.record(entry('e3'));
    await t.createCheckpoint();
    t.stepBack();
    t.stepBack();
    t.record(entry('e4'));

    assert.deepStrictEqual(t.getCheckpointRevertSequence().map(e => e.label), ['e3', 'e2']);
  });

  it('BC3: a save clears revertOnRestore (clean baseline)', async () => {
    const t = new ModificationTracker<LabeledModification>();
    t.record(entry('e1'));
    t.record(entry('e2'));
    await t.createCheckpoint();
    t.stepBack();
    t.record(entry('e3'));
    await t.createCheckpoint();

    assert.deepStrictEqual(t.getCheckpointRevertSequence(), []);
    assert.strictEqual(t.hasUncommittedChanges(), false);
  });

  it('BC4: serialize/deserialize round-trips revertOnRestore', async () => {
    const t = new ModificationTracker<LabeledModification>();
    t.record(entry('e1'));
    t.record(entry('e2'));
    await t.createCheckpoint();
    t.stepBack();
    t.record(entry('e3'));

    const restored = ModificationTracker.deserialize<LabeledModification>(t.serialize());

    assert.deepStrictEqual(restored.getCheckpointRevertSequence().map(e => e.label), ['e2']);
    assert.strictEqual(restored.hasUncommittedChanges(), true);
  });

  it('BC5: rollbackToCheckpoint re-applies branched saved edits to reach the saved state', async () => {
    const t = new ModificationTracker<LabeledModification>();
    t.record(entry('e1'));
    t.record(entry('e2'));
    await t.createCheckpoint();
    t.stepBack();
    t.record(entry('e3'));

    t.rollbackToCheckpoint();

    assert.deepStrictEqual(t['timeline'].map((e: LabeledModification) => e.label), ['e1', 'e2']);
    assert.deepStrictEqual(t.getCheckpointRevertSequence(), []);
    assert.strictEqual(t.hasUncommittedChanges(), false);
  });

  it('BC6: a branch does not invalidate an in-flight save started after the undo; the save clears revertOnRestore', async () => {
    const t = new ModificationTracker<LabeledModification>();
    t.record(entry('e1'));
    t.record(entry('e2'));
    await t.createCheckpoint(); // saved = [e1, e2]
    t.stepBack(); // undo e2 -> the async save below writes the [e1] state

    // Capture what an in-flight async save of the undone [e1] state would hold.
    const savePosition = t.getCurrentPosition();
    const saveRevision = t.getCheckpointInvalidationRevision();

    t.record(entry('e3')); // branch while that save is still writing

    // The branch must NOT bump the invalidation revision: the save's bytes ([e1])
    // still match the captured common-prefix position, so save() will commit its
    // checkpoint. (Re-adding invalidateCapturedCheckpointPositions() here breaks this.)
    assert.strictEqual(t.getCheckpointInvalidationRevision(), saveRevision);

    // Save completes and commits -> clears revertOnRestore so the tracker's saved
    // state matches the [e1] bytes on disk, not the stale [e1, e2].
    t.createCheckpointAt(savePosition);

    assert.deepStrictEqual(t.getCheckpointRevertSequence(), []); // e2 no longer saved-undone
    assert.deepStrictEqual(t.getUncommittedEntries().map((e) => e.label), ['e3']);
    assert.strictEqual(t.hasUncommittedChanges(), true); // e3 still uncommitted
  });
});

describe('invalidateCapturedCheckpointPositions', () => {
  it('increments checkpointInvalidationRevision on timeline eviction', () => {
    const tracker = new ModificationTracker<LabeledModification>(1);
    tracker.record(entry('e1'));
    const initialRevision = tracker.getCheckpointInvalidationRevision();
    tracker.record(entry('e2'));
    assert.strictEqual(tracker.getCheckpointInvalidationRevision(), initialRevision + 1);
  });

  it('increments checkpointInvalidationRevision on stepBack (undo)', () => {
    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(entry('e1'));
    const preUndoRevision = tracker.getCheckpointInvalidationRevision();
    tracker.stepBack();
    assert.strictEqual(tracker.getCheckpointInvalidationRevision(), preUndoRevision + 1);
  });

  it('increments checkpointInvalidationRevision on rollbackToCheckpoint with undone entries', async () => {
    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(entry('e1'));
    tracker.record(entry('e2'));
    await tracker.createCheckpoint();
    tracker.stepBack();
    const preRollbackRevision = tracker.getCheckpointInvalidationRevision();
    tracker.rollbackToCheckpoint();
    assert.strictEqual(tracker.getCheckpointInvalidationRevision(), preRollbackRevision + 1);
  });

  it('increments checkpointInvalidationRevision on rollbackToCheckpoint with uncommitted entries', async () => {
    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(entry('e1'));
    await tracker.createCheckpoint();
    tracker.record(entry('e2'));
    const preRollbackRevision = tracker.getCheckpointInvalidationRevision();
    tracker.rollbackToCheckpoint();
    assert.strictEqual(tracker.getCheckpointInvalidationRevision(), preRollbackRevision + 1);
  });

  it('does NOT increment checkpointInvalidationRevision when rollbackToCheckpoint causes no change', async () => {
    const tracker = new ModificationTracker<LabeledModification>();
    tracker.record(entry('e1'));
    await tracker.createCheckpoint();
    const preRollbackRevision = tracker.getCheckpointInvalidationRevision();
    tracker.rollbackToCheckpoint();
    assert.strictEqual(tracker.getCheckpointInvalidationRevision(), preRollbackRevision);
  });
});
