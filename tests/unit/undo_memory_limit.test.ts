
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ModificationTracker } from '../../src/core/undo-history';
import { ModificationType, LabeledModification } from '../../src/core/types';

// Mock types
interface MockMod extends LabeledModification {
    payload: string;
}

describe('Undo/Redo Memory Limit', () => {
    it('should respect memory limit', () => {
        // Limit to 200 bytes.
        // Each entry overhead is ~8 bytes.
        // String overhead ~2 bytes per char.
        const maxMemory = 200;
        const tracker = new ModificationTracker<MockMod>(100, maxMemory);

        const createEntry = (id: string, size: number) => {
            return {
                label: id,
                description: id,
                modificationType: 'cell_update' as ModificationType,
                payload: 'x'.repeat(size)
            } as MockMod;
        };

        // Add entries.
        // Entry size approx:
        // overhead (8) +
        // label: '1' (2)
        // description: '1' (2)
        // modificationType: 'cell_update' (22)
        // payload: 50 chars (100)
        // keys: 'label' (10), 'description' (22), 'modificationType' (32), 'payload' (14)
        // Total approx: 8 + 2 + 2 + 22 + 100 + 10 + 22 + 32 + 14 = 212 bytes?
        // Wait, calculateSize logic:
        // object overhead: 8
        // keys:
        // 'label': 5*2=10. value '1': 1*2=2.
        // 'description': 11*2=22. value '1': 1*2=2.
        // 'modificationType': 16*2=32. value 'cell_update': 11*2=22.
        // 'payload': 7*2=14. value 50*2=100.
        // Total: 8 + 10 + 2 + 22 + 2 + 32 + 22 + 14 + 100 = 212 bytes.

        // So even 1 entry exceeds 200 bytes!
        // But we allow at least 1 entry.

        const entry1 = createEntry('1', 50);
        tracker.record(entry1);
        assert.strictEqual(tracker.entryCount, 1);
        assert.strictEqual(tracker.canStepBack, true);

        // Add second entry. This should definitely push the first one out.
        const entry2 = createEntry('2', 50);
        tracker.record(entry2);

        assert.strictEqual(tracker.entryCount, 1);
        const last = tracker.stepBack();
        assert.strictEqual(last?.label, '2');
    });

    it('should keep at least one entry even if it exceeds limit', () => {
        const maxMemory = 10; // Very small
        const tracker = new ModificationTracker<MockMod>(100, maxMemory);

        const entry = {
            label: 'huge',
            description: 'huge',
            modificationType: 'cell_update' as ModificationType,
            payload: 'x'.repeat(100) // 200 bytes > 10 bytes
        } as MockMod;

        tracker.record(entry);
        assert.strictEqual(tracker.entryCount, 1);
    });

    it('should recalculate sizes on deserialize', () => {
        const maxMemory = 1000;
        const tracker = new ModificationTracker<MockMod>(100, maxMemory);
        const entry = {
            label: '1',
            description: '1',
            modificationType: 'cell_update' as ModificationType,
            payload: 'x'.repeat(10)
        } as MockMod;
        tracker.record(entry);

        const serialized = tracker.serialize();
        const restored = ModificationTracker.deserialize<MockMod>(serialized, 100, maxMemory);

        assert.strictEqual(restored.entryCount, 1);

        // Add another large entry to force eviction on restored tracker
        // Entry size estimate for 400 chars:
        // overhead ~112 (keys + other fields) + 800 (payload) = ~912.
        // Existing entry '1' (10 chars): ~112 + 20 = ~132.
        // Total = 912 + 132 = 1044 > 1000.
        // So adding entry2 should remove entry1.

        const entry2 = {
            label: '2',
            description: '2',
            modificationType: 'cell_update' as ModificationType,
            payload: 'x'.repeat(400) // 800 bytes
        } as MockMod;

        restored.record(entry2);

        assert.strictEqual(restored.entryCount, 1);
        const last = restored.stepBack();
        assert.strictEqual(last?.label, '2');
    });

    it('should correctly track memory usage with undo/redo', () => {
         const maxMemory = 10000;
         const tracker = new ModificationTracker<MockMod>(100, maxMemory);

         // Add an entry
         tracker.record({
             label: '1', description: '1', modificationType: 'cell_update', payload: 'a'
         } as MockMod);

         // Undo
         tracker.stepBack();
         assert.strictEqual(tracker.entryCount, 0);

         // Redo
         tracker.stepForward();
         assert.strictEqual(tracker.entryCount, 1);

         // Record new overwrites redo
         tracker.stepBack(); // Undo again -> in futureStack
         tracker.record({
             label: '2', description: '2', modificationType: 'cell_update', payload: 'b'
         } as MockMod);

         assert.strictEqual(tracker.entryCount, 1);
         assert.strictEqual(tracker.canStepForward, false); // Redo history cleared
    });
});
