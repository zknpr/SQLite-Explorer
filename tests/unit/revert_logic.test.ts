
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createDatabaseEngine } from '../../src/core/sqlite-db';

describe('Revert Logic', () => {
    let engine: any;

    before(async () => {
        const result = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        engine = result.operations;
        await engine.executeQuery("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
        await engine.insertRow('test', { value: 'initial' });
    });

    it('should revert uncommitted changes', async () => {
        // 1. Make a change
        await engine.updateCell('test', 1, 'value', 'modified');

        // Verify change applied in memory
        const result = await engine.executeQuery("SELECT value FROM test WHERE id = 1");
        assert.strictEqual(result[0].rows[0][0], 'modified');

        // 2. Simulate Revert (discardModifications)
        // discardModifications expects the list of modifications that were applied (from the tracker).
        // It then undoes them.
        // The modification that changed 'initial' to 'modified' would have:
        // priorValue: 'initial'
        // newValue: 'modified'
        const modificationsToDiscard = [{
            modificationType: 'cell_update',
            targetTable: 'test',
            targetRowId: 1,
            targetColumn: 'value',
            priorValue: 'initial',  // The value to restore
            newValue: 'modified',
            description: 'Update cell'
        }];

        await engine.discardModifications(modificationsToDiscard);

        // 3. Verify Revert
        const revertedResult = await engine.executeQuery("SELECT value FROM test WHERE id = 1");
        assert.strictEqual(revertedResult[0].rows[0][0], 'initial', 'Database should be reverted to initial state');
    });
});
