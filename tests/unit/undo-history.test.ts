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
});
