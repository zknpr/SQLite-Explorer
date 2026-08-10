import './vscode_mock_setup';

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { OversizedCellReplacementRequiredError } from '../../src/core/cell-edit-policy';
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

            const outcomes = await engine.updateCellBatch(
                'docs',
                [
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
                ],
                1024,
                64 * 1024
            );

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

    it('preflights bounded rowid batches once per distinct column', async () => {
        const initialized = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const engine = initialized.operations!;
        try {
            await engine.executeQuery('CREATE TABLE batch_preflight (left_value TEXT, right_value TEXT)');
            await engine.executeQuery(
                "INSERT INTO batch_preflight VALUES ('left-1', 'right-1'), " +
                "('left-2', 'right-2'), ('left-3', 'right-3')"
            );

            const observedSql: string[] = [];
            const executeQuery = engine.executeQuery.bind(engine);
            engine.executeQuery = async (sql, params, signal) => {
                observedSql.push(sql);
                return executeQuery(sql, params, signal);
            };

            const outcomes = await engine.updateCellBatch(
                'batch_preflight',
                [1, 2, 3].flatMap(rowId => [
                    { rowId, column: 'left_value', value: 'same-left' },
                    { rowId, column: 'right_value', value: 'same-right' }
                ]),
                1024
            );

            const preflightQueries = observedSql.filter(sql => (
                /length\s*\(\s*CAST\s*\(/i.test(sql) && /rowid\s+IN\s*\(/i.test(sql)
            ));
            assert.strictEqual(preflightQueries.length, 2);
            assert.ok(preflightQueries.some(sql => /"left_value"/.test(sql)));
            assert.ok(preflightQueries.some(sql => /"right_value"/.test(sql)));
            assert.strictEqual(outcomes.length, 6);
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('refuses an oversized batch prior before materializing batch history values', async () => {
        const initialized = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const engine = initialized.operations!;
        try {
            await engine.executeQuery('CREATE TABLE batch_oversized_prior (payload BLOB)');
            await engine.executeQuery(
                "INSERT INTO batch_oversized_prior VALUES (x'01'), (zeroblob(2048))"
            );

            const observedSql: string[] = [];
            const executeQuery = engine.executeQuery.bind(engine);
            engine.executeQuery = async (sql, params, signal) => {
                observedSql.push(sql);
                return executeQuery(sql, params, signal);
            };

            await assert.rejects(
                engine.updateCellBatch(
                    'batch_oversized_prior',
                    [
                        { rowId: 1, column: 'payload', value: 'bounded' },
                        { rowId: 2, column: 'payload', value: 'bounded' }
                    ],
                    1024
                ),
                error => {
                    assert.ok(error instanceof OversizedCellReplacementRequiredError);
                    assert.strictEqual(error.storageClass, 'blob');
                    assert.strictEqual(error.actualBytes, 2048);
                    return true;
                }
            );
            assert.ok(
                observedSql.every(sql => !/^\s*SELECT\s+CAST\s*\(\s*rowid\s+AS\s+TEXT\s*\)/i.test(sql)),
                `unconfirmed batch selected prior values: ${observedSql.join('\n')}`
            );
            assert.deepStrictEqual(
                (await executeQuery(
                    'SELECT typeof(payload), length(CAST(payload AS BLOB)) ' +
                    'FROM batch_oversized_prior ORDER BY rowid'
                ))[0].rows,
                [['blob', 1], ['blob', 2048]]
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('refuses aggregate oversized undo history before opening the update savepoint', async () => {
        const initialized = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const engine = initialized.operations!;
        const originalExecuteQuery = engine.executeQuery.bind(engine);
        try {
            await originalExecuteQuery('CREATE TABLE aggregate_history (payload TEXT)');
            const prior = 'x'.repeat(256 * 1024);
            await originalExecuteQuery(
                'INSERT INTO aggregate_history VALUES (?), (?), (?), (?)',
                [prior, prior, prior, prior]
            );

            const observedSql: string[] = [];
            engine.executeQuery = async (sql, params, signal) => {
                observedSql.push(sql);
                return originalExecuteQuery(sql, params, signal);
            };

            await assert.rejects(
                (engine.updateCellBatch as any)(
                    'aggregate_history',
                    [1, 2, 3, 4].map(rowId => ({
                        rowId,
                        column: 'payload',
                        value: 'after'
                    })),
                    1024 * 1024,
                    700 * 1024
                ),
                /Batch update undo snapshot exceeds the 716800-byte memory budget/i
            );
            assert.strictEqual(
                observedSql.some(sql => /^\s*SAVEPOINT\s+/i.test(sql)),
                false,
                'aggregate history refusal must happen before the savepoint'
            );
            assert.deepStrictEqual(
                (await originalExecuteQuery(
                    'SELECT count(*), min(length(payload)), max(length(payload)) FROM aggregate_history'
                ))[0].rows,
                [[4, prior.length, prior.length]]
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });
});
