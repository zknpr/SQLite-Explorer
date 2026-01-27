
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ModificationTracker } from '../../src/core/undo-history';

// Mock types
interface MockMod {
    label: string;
    description: string;
    modificationType: string;
    targetTable: string;
    [key: string]: any;
}

describe('Undo/Redo Logic', () => {
    it('should track and restore stack', () => {
        const tracker = new ModificationTracker<MockMod>();

        // Record 1
        tracker.record({
            label: '1', description: '1', modificationType: 'row_insert', targetTable: 't1'
        });

        assert.strictEqual(tracker.entryCount, 1);

        // Record 2
        tracker.record({
            label: '2', description: '2', modificationType: 'row_delete', targetTable: 't1'
        });

        assert.strictEqual(tracker.entryCount, 2);

        // Undo 2
        const undo2 = tracker.stepBack();
        assert.ok(undo2);
        assert.strictEqual(undo2?.label, '2');
        assert.strictEqual(tracker.entryCount, 1);

        // Undo 1
        const undo1 = tracker.stepBack();
        assert.ok(undo1);
        assert.strictEqual(undo1?.label, '1');
        assert.strictEqual(tracker.entryCount, 0);

        // Redo 1
        const redo1 = tracker.stepForward();
        assert.ok(redo1);
        assert.strictEqual(redo1?.label, '1');
        assert.strictEqual(tracker.entryCount, 1);
    });
});
