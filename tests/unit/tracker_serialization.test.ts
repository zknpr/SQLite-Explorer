
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ModificationTracker } from '../../src/core/undo-history';
import { LabeledModification } from '../../src/core/types';
import { encodePrimaryKeyRecordId } from '../../src/core/row-identity';

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

    it('backs up and restores signed REAL infinities exactly', () => {
        const tracker = new ModificationTracker<LabeledModification>();
        tracker.record({
            label: 'Infinite REAL row',
            description: 'Delete an infinite-key row',
            modificationType: 'row_delete',
            targetTable: 'measurements',
            deletedRows: [{
                rowId: encodePrimaryKeyRecordId(
                    [{ identifier: 'value', declaredType: 'REAL', position: 1 }],
                    [Infinity]
                ),
                row: { value: Infinity, mirror: -Infinity }
            }]
        });

        const backup = tracker.serialize();
        assert.doesNotMatch(new TextDecoder().decode(backup), /"value":null|"mirror":null/);
        const restored = ModificationTracker.deserialize<LabeledModification>(backup).stepBack();
        assert.strictEqual(restored?.deletedRows?.[0].row.value, Infinity);
        assert.strictEqual(restored?.deletedRows?.[0].row.mirror, -Infinity);
    });

    it('does not collide with a legitimate row shaped like the old infinity history marker', () => {
        const tracker = new ModificationTracker<LabeledModification>();
        tracker.record({
            label: 'Marker-shaped row',
            description: 'Delete a row whose columns resemble an internal marker',
            modificationType: 'row_delete',
            targetTable: 'marker_rows',
            deletedRows: [{
                rowId: 1,
                row: { __type: 'NonFiniteNumber', text: 'Infinity' }
            }]
        });

        const restored = ModificationTracker.deserialize<LabeledModification>(
            tracker.serialize()
        ).stepBack();
        assert.deepStrictEqual(restored?.deletedRows?.[0].row, {
            __type: 'NonFiniteNumber',
            text: 'Infinity'
        });
    });

    it('preserves old and new composite primary-key identities in cell history', () => {
        const columns = [
            { identifier: 'space', declaredType: 'BLOB', position: 1 },
            { identifier: 'sequence', declaredType: 'INTEGER', position: 2 }
        ];
        const oldRowId = encodePrimaryKeyRecordId(
            columns,
            [new Uint8Array([0, 47, 255]), 9007199254740993n]
        );
        const newRowId = encodePrimaryKeyRecordId(
            columns,
            [new Uint8Array([0, 47, 255]), 9007199254740994n]
        );
        const tracker = new ModificationTracker<LabeledModification>();
        tracker.record({
            label: 'PK edit',
            description: 'Change sequence',
            modificationType: 'cell_update',
            targetTable: 'items',
            affectedCells: [{
                rowId: oldRowId,
                newRowId,
                columnName: 'sequence',
                priorValue: '9007199254740993',
                newValue: '9007199254740994'
            }]
        });

        const restored = ModificationTracker.deserialize<LabeledModification>(tracker.serialize());
        assert.deepStrictEqual(restored.stepBack()?.affectedCells, [{
            rowId: oldRowId,
            newRowId,
            columnName: 'sequence',
            priorValue: '9007199254740993',
            newValue: '9007199254740994'
        }]);
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
