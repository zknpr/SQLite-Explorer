import './vscode_mock_setup';

import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
    CellEditPolicyError,
    OversizedCellReplacementRequiredError
} from '../../src/core/cell-edit-policy';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';

describe('WASM oversized-cell edit policy', () => {
    it('rejects oversized new values before update, insert, or batch mutation', async () => {
        const initialized = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const engine = initialized.operations!;
        const limit = 1024;
        const oversized = new Uint8Array(limit + 1);
        try {
            await engine.executeQuery(
                "CREATE TABLE edit_limits (payload BLOB); INSERT INTO edit_limits VALUES (x'01')"
            );

            for (const mutation of [
                () => engine.updateCell('edit_limits', 1, 'payload', oversized, undefined, limit),
                () => engine.insertRow('edit_limits', { payload: oversized }, limit),
                () => engine.insertRowBatch('edit_limits', [{ payload: oversized }], limit),
                () => engine.updateCellBatch(
                    'edit_limits',
                    [{ rowId: 1, column: 'payload', value: oversized }],
                    limit
                )
            ]) {
                await assert.rejects(mutation, error => {
                    assert.ok(error instanceof CellEditPolicyError);
                    assert.strictEqual(error.storageClass, 'blob');
                    assert.strictEqual(error.actualBytes, limit + 1);
                    assert.strictEqual(error.limitBytes, limit);
                    return true;
                });
            }

            assert.deepStrictEqual(
                (await engine.executeQuery('SELECT hex(payload), count(*) FROM edit_limits'))[0].rows,
                [['01', 1]]
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('rejects a bounded JSON patch when the resulting stored value is oversized', async () => {
        const initialized = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const engine = initialized.operations!;
        const limit = 64;
        const prior = JSON.stringify({ a: 'x'.repeat(32) });
        const patch = JSON.stringify({ b: 'y'.repeat(32) });
        try {
            await engine.executeQuery('CREATE TABLE patch_limits (payload TEXT)');
            await engine.executeQuery('INSERT INTO patch_limits VALUES (?)', [prior]);

            await assert.rejects(
                engine.updateCellBatch(
                    'patch_limits',
                    [{ rowId: 1, column: 'payload', value: patch, operation: 'json_patch' }],
                    limit
                ),
                error => {
                    assert.ok(error instanceof CellEditPolicyError);
                    assert.strictEqual(error.storageClass, 'text');
                    assert.ok(error.actualBytes > limit);
                    assert.strictEqual(error.limitBytes, limit);
                    return true;
                }
            );
            assert.strictEqual(
                (await engine.executeQuery('SELECT payload FROM patch_limits'))[0].rows[0][0],
                prior
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('allows history replay to restore a legacy oversized value without opening a policy bypass', async () => {
        const initialized = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const engine = initialized.operations!;
        const legacyValue = new Uint8Array(1024 * 1024 + 1);
        try {
            await engine.executeQuery(
                "CREATE TABLE legacy_history (payload BLOB); INSERT INTO legacy_history VALUES (x'01')"
            );
            await assert.rejects(
                engine.updateCell('legacy_history', 1, 'payload', legacyValue),
                CellEditPolicyError
            );

            await engine.undoModification({
                modificationType: 'cell_update',
                description: 'legacy oversized prior',
                targetTable: 'legacy_history',
                targetRowId: 1,
                targetColumn: 'payload',
                priorValue: legacyValue,
                newValue: Uint8Array.from([1])
            });
            assert.strictEqual(
                (await engine.executeQuery('SELECT length(payload) FROM legacy_history'))[0].rows[0][0],
                legacyValue.byteLength
            );

            await engine.redoModification({
                modificationType: 'cell_update',
                description: 'legacy oversized prior',
                targetTable: 'legacy_history',
                targetRowId: 1,
                targetColumn: 'payload',
                priorValue: legacyValue,
                newValue: Uint8Array.from([1])
            });
            assert.strictEqual(
                (await engine.executeQuery('SELECT length(payload) FROM legacy_history'))[0].rows[0][0],
                1
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('requires the guarded path for an oversized prior and replaces it without selecting the value', async () => {
        const initialized = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const engine = initialized.operations!;
        const limit = 1024;
        try {
            await engine.executeQuery(
                'CREATE TABLE guarded_replace (payload BLOB); ' +
                `INSERT INTO guarded_replace VALUES (zeroblob(${limit + 1}))`
            );

            const observedSql: string[] = [];
            const executeQuery = engine.executeQuery.bind(engine);
            engine.executeQuery = async (sql, params, signal) => {
                observedSql.push(sql);
                return executeQuery(sql, params, signal);
            };

            await assert.rejects(
                engine.updateCell('guarded_replace', 1, 'payload', 'bounded', undefined, limit),
                error => {
                    assert.ok(error instanceof OversizedCellReplacementRequiredError);
                    assert.strictEqual(error.storageClass, 'blob');
                    assert.strictEqual(error.actualBytes, limit + 1);
                    return true;
                }
            );
            assert.ok(
                observedSql.every(sql => !/^\s*SELECT\s+"payload"\b/i.test(sql)),
                `unconfirmed update selected the prior payload: ${observedSql.join('\n')}`
            );

            observedSql.length = 0;
            await engine.replaceOversizedCell(
                'guarded_replace',
                1,
                'payload',
                'bounded',
                { storageClass: 'blob', byteLength: limit + 1 },
                limit
            );
            assert.ok(
                observedSql.every(sql => !/^\s*SELECT\s+"payload"\b/i.test(sql)),
                `guarded replacement selected the prior payload: ${observedSql.join('\n')}`
            );
            assert.strictEqual(
                (await executeQuery('SELECT payload FROM guarded_replace'))[0].rows[0][0],
                'bounded'
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('leaves the cell unchanged when guarded replacement metadata is stale', async () => {
        const initialized = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const engine = initialized.operations!;
        const limit = 1024;
        try {
            await engine.executeQuery(
                'CREATE TABLE guarded_conflict (payload BLOB); ' +
                `INSERT INTO guarded_conflict VALUES (zeroblob(${limit + 1}))`
            );

            await assert.rejects(
                engine.replaceOversizedCell(
                    'guarded_conflict',
                    1,
                    'payload',
                    'bounded',
                    { storageClass: 'blob', byteLength: limit + 2 },
                    limit
                ),
                /metadata changed before the confirmed replacement/i
            );
            assert.deepStrictEqual(
                (await engine.executeQuery(
                    'SELECT typeof(payload), length(CAST(payload AS BLOB)) FROM guarded_conflict'
                ))[0].rows,
                [['blob', limit + 1]]
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });
});
