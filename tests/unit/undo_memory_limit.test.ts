
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ModificationTracker } from '../../src/core/undo-history';
import { ModificationType, LabeledModification } from '../../src/core/types';
import { assertBatchHistoryFitsUndoBudget } from '../../src/core/batch-update';

// Mock types
interface MockMod extends LabeledModification {
    payload: string;
}

describe('Undo/Redo Memory Limit', () => {
    it('reserves the optional raw-TEXT sidecar before materializing batch history', () => {
        assert.throws(
            () => assertBatchHistoryFitsUndoBudget({
                table: 'malformed_text',
                preflight: {
                    queries: [{ sql: 'metadata only', params: [] }],
                    expectedCellCount: 1
                },
                resultRows: [[1, 2]],
                maxPriorValueBytes: 25
            }),
            /undo snapshot exceeds/i
        );
    });

    it('blocks additional records when an unsaved barrier segment reaches the entry cap', () => {
        const tracker = new ModificationTracker<MockMod>(3, 1024 * 1024);
        tracker.recordBarrier({
            label: 'barrier',
            description: 'forward-only oversized replacement',
            modificationType: 'cell_update',
            payload: 'bounded',
            undoPolicy: 'barrier'
        } as MockMod);
        for (let index = 0; index < 2; index++) {
            tracker.record({
                label: `normal-${index}`,
                description: `normal-${index}`,
                modificationType: 'cell_update',
                payload: 'small'
            } as MockMod);
        }

        const serialized = tracker.serialize();
        assert.throws(
            () => tracker.record({
                label: 'must-not-accumulate',
                description: 'must-not-accumulate',
                modificationType: 'cell_update',
                payload: 'small'
            } as MockMod),
            /undo history.*limit.*save.*before making more changes/i
        );
        assert.deepStrictEqual(
            tracker.getUncommittedEntries().map(candidate => candidate.label),
            ['barrier', 'normal-0', 'normal-1']
        );
        assert.deepStrictEqual(tracker.serialize(), serialized);

        const restored = ModificationTracker.deserialize<MockMod>(
            serialized,
            3,
            1024 * 1024
        );
        assert.throws(
            () => restored.record({
                label: 'restored-must-not-accumulate',
                description: 'restored-must-not-accumulate',
                modificationType: 'cell_update',
                payload: 'small'
            } as MockMod),
            /undo history.*limit.*save.*before making more changes/i
        );
        assert.deepStrictEqual(
            restored.getUncommittedEntries().map(candidate => candidate.label),
            ['barrier', 'normal-0', 'normal-1']
        );
    });

    it('accounts an unsaved barrier entry against the memory cap', () => {
        const tracker = new ModificationTracker<MockMod>(100, 1);
        tracker.recordBarrier({
            label: 'barrier',
            description: 'forward-only oversized replacement',
            modificationType: 'cell_update',
            payload: 'bounded',
            undoPolicy: 'barrier'
        } as MockMod);

        assert.throws(
            () => tracker.record({
                label: 'ordinary edit',
                description: 'ordinary edit',
                modificationType: 'cell_update',
                payload: 'small'
            } as MockMod),
            /undo history.*limit.*save.*before making more changes/i
        );
        assert.deepStrictEqual(
            tracker.getUncommittedEntries().map(candidate => candidate.label),
            ['barrier']
        );
    });

    it('keeps the saturated barrier segment complete for backup, then resumes eviction after save', async () => {
        const tracker = new ModificationTracker<MockMod>(100, 700);
        const barrier = {
            label: 'barrier',
            description: 'forward-only oversized replacement',
            modificationType: 'cell_update' as ModificationType,
            payload: 'bounded',
            undoPolicy: 'barrier' as const
        } as MockMod;
        tracker.recordBarrier(barrier);
        tracker.record({
            label: 'normal-0',
            description: 'normal-0',
            modificationType: 'cell_update',
            payload: 'x'.repeat(200)
        } as MockMod);

        assert.strictEqual(tracker.hasUncommittedHistoryBarrier, true);
        assert.strictEqual(tracker.isHistoryRecordingBlockedByBarrierLimit, true);
        assert.deepStrictEqual(
            tracker.getUncommittedEntries().map(candidate => candidate.label),
            ['barrier', 'normal-0']
        );
        const restored = ModificationTracker.deserialize<MockMod>(tracker.serialize(), 100, 700);
        assert.deepStrictEqual(
            restored.getUncommittedEntries().map(candidate => candidate.label),
            ['barrier', 'normal-0']
        );

        await tracker.createCheckpoint();
        assert.strictEqual(tracker.hasUncommittedHistoryBarrier, false);
        assert.strictEqual(tracker.isHistoryRecordingBlockedByBarrierLimit, false);
        tracker.record({
            label: 'normal-1',
            description: 'normal-1',
            modificationType: 'cell_update',
            payload: 'x'.repeat(200)
        } as MockMod);
        assert.strictEqual(tracker.entryCount, 1, 'memory retention must resume after saving the barrier');
        assert.strictEqual(tracker.stepBack()?.label, 'normal-1');
    });

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
