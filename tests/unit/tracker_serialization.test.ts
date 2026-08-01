
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ModificationTracker } from '../../src/core/undo-history';
import { LabeledModification } from '../../src/core/types';

describe('ModificationTracker Serialization', () => {

    it('should serialize and deserialize an empty tracker', () => {
        const tracker = new ModificationTracker<LabeledModification>();
        const serialized = tracker.serialize();

        assert.ok(serialized instanceof Uint8Array);
        assert.ok(serialized.length > 0);

        const restored = ModificationTracker.deserialize<LabeledModification>(serialized);

        assert.strictEqual(restored.entryCount, 0);
        assert.strictEqual(restored.canStepBack, false);
        assert.strictEqual(restored.canStepForward, false);
    });

    it('should serialize and deserialize a tracker with simple modifications', () => {
        const tracker = new ModificationTracker<LabeledModification>();
        const mod: LabeledModification = {
            label: 'Test Mod',
            description: 'Insert row',
            modificationType: 'row_insert',
            targetTable: 'users',
            newValue: 'Alice'
        };

        tracker.record(mod);

        const serialized = tracker.serialize();
        const restored = ModificationTracker.deserialize<LabeledModification>(serialized);

        assert.strictEqual(restored.entryCount, 1);

        const lastMod = restored.stepBack();
        assert.ok(lastMod);
        assert.strictEqual(lastMod?.label, 'Test Mod');
        assert.strictEqual(lastMod?.newValue, 'Alice');
    });

    it('should properly serialize and deserialize Uint8Array data', () => {
        const tracker = new ModificationTracker<LabeledModification>();

        // Create a Uint8Array with some data
        const binaryData = new Uint8Array([1, 2, 3, 255, 0]);

        const mod: LabeledModification = {
            label: 'Binary Mod',
            description: 'Update blob',
            modificationType: 'cell_update',
            targetTable: 'files',
            priorValue: binaryData,
            newValue: new Uint8Array([10, 20, 30])
        };

        tracker.record(mod);

        const serialized = tracker.serialize();
        const restored = ModificationTracker.deserialize<LabeledModification>(serialized);

        assert.strictEqual(restored.entryCount, 1);

        const lastMod = restored.stepBack();
        assert.ok(lastMod);

        // Verify priorValue
        const restoredBinary = lastMod?.priorValue;
        assert.ok(restoredBinary instanceof Uint8Array, 'priorValue should be Uint8Array');
        assert.deepStrictEqual(restoredBinary, binaryData);

        // Verify newValue
        const restoredNewValue = lastMod?.newValue;
        assert.ok(restoredNewValue instanceof Uint8Array, 'newValue should be Uint8Array');
        assert.deepStrictEqual(restoredNewValue, new Uint8Array([10, 20, 30]));
    });

    it('backs up and restores unsafe native INTEGER history values exactly', () => {
        const tracker = new ModificationTracker<LabeledModification>();
        const priorValue = BigInt('9007199254740993');
        const newValue = BigInt('9007199254740995');
        tracker.record({
            label: 'Unsafe INTEGER update',
            description: 'Update counters.value',
            modificationType: 'cell_update',
            targetTable: 'counters',
            targetRowId: 1,
            targetColumn: 'value',
            priorValue,
            newValue
        });

        const serialized = tracker.serialize();
        const backupJson = new TextDecoder().decode(serialized);
        assert.match(
            backupJson,
            /"priorValue":\{"__type":"BigInt","text":"9007199254740993"\}/
        );

        const restored = ModificationTracker.deserialize<LabeledModification>(serialized);
        const restoredModification = restored.stepBack();
        assert.strictEqual(restoredModification?.priorValue, priorValue);
        assert.strictEqual(restoredModification?.newValue, newValue);
    });

    it('should preserve checkpoint index', async () => {
        const tracker = new ModificationTracker<LabeledModification>();
        tracker.record({
            label: '1', description: '1', modificationType: 'row_insert'
        });

        await tracker.createCheckpoint();

        tracker.record({
            label: '2', description: '2', modificationType: 'row_insert'
        });

        assert.strictEqual(tracker.hasUncommittedChanges(), true);

        const serialized = tracker.serialize();
        const restored = ModificationTracker.deserialize<LabeledModification>(serialized);

        // Checkpoint index should be preserved (at 1)
        // Total entries 2
        assert.strictEqual(restored.entryCount, 2);

        const uncommitted = restored.getUncommittedEntries();
        assert.strictEqual(uncommitted.length, 1);
        assert.strictEqual(uncommitted[0].label, '2');
    });
});
