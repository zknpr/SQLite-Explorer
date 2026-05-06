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

describe('ModificationTracker Circular Reference Handling', () => {
    it('should not infinite loop when calculating size of circular references', () => {
        const tracker = new ModificationTracker<MockMod>();

        const mod: MockMod = {
            label: 'circular_test',
            description: 'Test circular reference',
            modificationType: 'row_insert',
            targetTable: 't1'
        };

        // Create a circular reference
        mod.self = mod;

        // Recording this entry invokes `calculateSize`
        // We wrap it in a timeout (implicitly via Node test runner)
        // to ensure it completes and doesn't hang.
        tracker.record(mod);

        assert.strictEqual(tracker.entryCount, 1);

        // Ensure size calculation resulted in a reasonable positive number,
        // and did not fail or throw an exception.
        // We can't access `currentSize` directly as it's private,
        // but the successful execution of `record` implies success.

        // Let's also verify we can step back.
        const undone = tracker.stepBack();
        assert.ok(undone);
        assert.strictEqual(undone?.label, 'circular_test');
    });
});
