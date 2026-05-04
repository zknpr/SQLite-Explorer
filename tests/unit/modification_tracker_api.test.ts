import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ModificationTracker } from '../../src/core/undo-history';
import { ModificationType } from '../../src/core/types';

// Mock types
interface MockMod {
    label: string;
    description: string;
    modificationType: ModificationType;
    targetTable: string;
    [key: string]: any;
}

describe('Undo/Redo Logic Coverage', () => {
    it('should correctly report canStepBack and canStepForward', () => {
        const tracker = new ModificationTracker<MockMod>();
        assert.strictEqual(tracker.canStepBack, false);
        assert.strictEqual(tracker.canStepForward, false);

        tracker.record({ label: '1', description: '1', modificationType: 'row_insert', targetTable: 't1' });
        assert.strictEqual(tracker.canStepBack, true);
        assert.strictEqual(tracker.canStepForward, false);

        tracker.stepBack();
        assert.strictEqual(tracker.canStepBack, false);
        assert.strictEqual(tracker.canStepForward, true);
    });

    it('should clear futureStack when new modification is recorded after undo', () => {
        const tracker = new ModificationTracker<MockMod>();
        tracker.record({ label: '1', description: '1', modificationType: 'row_insert', targetTable: 't1' });
        tracker.record({ label: '2', description: '2', modificationType: 'row_delete', targetTable: 't1' });

        tracker.stepBack(); // Undo 2
        assert.strictEqual(tracker.canStepForward, true);

        tracker.record({ label: '3', description: '3', modificationType: 'row_update', targetTable: 't1' });
        assert.strictEqual(tracker.canStepForward, false);
        assert.strictEqual(tracker.entryCount, 2);
    });

    it('should correctly manage checkpoints and uncommitted changes', async () => {
        const tracker = new ModificationTracker<MockMod>();
        assert.strictEqual(tracker.hasUncommittedChanges(), false);

        tracker.record({ label: '1', description: '1', modificationType: 'row_insert', targetTable: 't1' });
        assert.strictEqual(tracker.hasUncommittedChanges(), true);

        const uncommitted = tracker.getUncommittedEntries();
        assert.strictEqual(uncommitted.length, 1);
        assert.strictEqual(uncommitted[0].label, '1');

        await tracker.createCheckpoint();
        assert.strictEqual(tracker.hasUncommittedChanges(), false);
        assert.strictEqual(tracker.getUncommittedEntries().length, 0);

        tracker.record({ label: '2', description: '2', modificationType: 'row_delete', targetTable: 't1' });
        assert.strictEqual(tracker.hasUncommittedChanges(), true);
        assert.strictEqual(tracker.getUncommittedEntries().length, 1);
        assert.strictEqual(tracker.getUncommittedEntries()[0].label, '2');
    });

    it('should rollback to checkpoint correctly', async () => {
        const tracker = new ModificationTracker<MockMod>();
        tracker.record({ label: '1', description: '1', modificationType: 'row_insert', targetTable: 't1' });
        await tracker.createCheckpoint();

        tracker.record({ label: '2', description: '2', modificationType: 'row_delete', targetTable: 't1' });
        tracker.record({ label: '3', description: '3', modificationType: 'row_update', targetTable: 't1' });

        assert.strictEqual(tracker.entryCount, 3);
        assert.strictEqual(tracker.hasUncommittedChanges(), true);

        tracker.rollbackToCheckpoint();
        assert.strictEqual(tracker.entryCount, 1);
        assert.strictEqual(tracker.hasUncommittedChanges(), false);
        assert.strictEqual(tracker.canStepForward, true);

        const redo = tracker.stepForward();
        assert.strictEqual(redo?.label, '2');
    });

    it('should return undefined when stepping out of bounds', () => {
        const tracker = new ModificationTracker<MockMod>();
        assert.strictEqual(tracker.stepBack(), undefined);
        assert.strictEqual(tracker.stepForward(), undefined);

        tracker.record({ label: '1', description: '1', modificationType: 'row_insert', targetTable: 't1' });
        tracker.stepBack();
        assert.strictEqual(tracker.stepBack(), undefined);
    });

    it('should evict oldest entries when exceeding maxEntries and adjust checkpoint', async () => {
        const tracker = new ModificationTracker<MockMod>(2); // Max 2 entries

        tracker.record({ label: '1', description: '1', modificationType: 'row_insert', targetTable: 't1' });
        await tracker.createCheckpoint(); // checkpointIndex = 1

        tracker.record({ label: '2', description: '2', modificationType: 'row_update', targetTable: 't1' });
        // timeline: ['1', '2'], checkpointIndex: 1

        // Add 3rd entry, should evict '1'
        tracker.record({ label: '3', description: '3', modificationType: 'row_delete', targetTable: 't1' });
        // timeline: ['2', '3']
        // checkpointIndex should adjust from 1 to 0 because entry '1' was removed

        assert.strictEqual(tracker.entryCount, 2);
        const uncommitted = tracker.getUncommittedEntries();
        // Since checkpointIndex is 0, both '2' and '3' are uncommitted
        assert.strictEqual(uncommitted.length, 2);
        assert.strictEqual(uncommitted[0].label, '2');
        assert.strictEqual(uncommitted[1].label, '3');
    });
});
