import './vscode_mock_setup';

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';

describe('atomic cell batches', () => {
    it('returns authoritative prior values and derives JSON patches inside the savepoint', async () => {
        const initialized = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const engine = initialized.operations!;
        try {
            await engine.executeQuery('CREATE TABLE docs (payload TEXT, label TEXT)');
            await engine.executeQuery(
                `INSERT INTO docs VALUES ('{"count":1,"concurrent":true}', 'database-current')`
            );

            const outcomes = await engine.updateCellBatch('docs', [
                {
                    rowId: 1,
                    column: 'payload',
                    value: '{"count":2,"concurrent":true}',
                    originalValue: '{"count":0}'
                },
                {
                    rowId: 1,
                    column: 'label',
                    value: 'after',
                    originalValue: 'caller-stale'
                }
            ]);

            assert.deepStrictEqual(outcomes, [
                {
                    rowId: 1,
                    columnName: 'payload',
                    priorValue: '{"count":1,"concurrent":true}',
                    newValue: '{"count":2}',
                    operation: 'json_patch'
                },
                {
                    rowId: 1,
                    columnName: 'label',
                    priorValue: 'database-current',
                    newValue: 'after',
                    operation: 'set'
                }
            ]);
            const stored = await engine.executeQuery('SELECT payload, label FROM docs WHERE rowid = 1');
            assert.deepStrictEqual(stored[0].rows, [['{"count":2,"concurrent":true}', 'after']]);
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });
});
