
import './vscode_mock_setup';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations, CellUpdate, ModificationEntry } from '../../src/core/types';
import { buildIndexDependencyProbeIndexSql } from '../../src/core/schema-ddl';

async function withFreshWasmEngine(
    run: (engine: WasmDatabaseEngine) => Promise<void>
): Promise<void> {
    const opened = await createDatabaseEngine({
        content: null,
        maxSize: 0,
        readOnlyMode: false
    });
    const engine = opened.operations as WasmDatabaseEngine;
    try {
        await run(engine);
    } finally {
        engine.shutdown();
    }
}

describe('WasmDatabaseEngine', () => {
    let engine: DatabaseOperations;

    before(async () => {
        // Initialize with empty DB
        const result = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        engine = result.operations!;

        // Setup table
        await engine.executeQuery("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, data TEXT)");
    });

    it('rejects an executable tail in untrusted stored index SQL', () => {
        assert.throws(
            () => buildIndexDependencyProbeIndexSql(
                'probe_table',
                'probe_index',
                'CREATE INDEX source_index ON source_table(value); DROP TABLE source_table'
            ),
            /multiple statements/
        );
    });

    it('finds only real index dependencies before dropping a column', () => (
        withFreshWasmEngine(async dependencyEngine => {
            await dependencyEngine.executeQuery(
                'CREATE TABLE wasm_index_dependencies (' +
                'keep TEXT, removed TEXT, note TEXT); ' +
                'CREATE UNIQUE INDEX idx_wasm_unrelated ON wasm_index_dependencies(' +
                'keep /* , removed) */) WHERE note <> \'(removed)\'; ' +
                'CREATE INDEX idx_wasm_removed_collate ON wasm_index_dependencies(' +
                '"removed" COLLATE NOCASE); ' +
                'CREATE INDEX idx_wasm_removed_partial ON wasm_index_dependencies(' +
                'keep) WHERE removed IS NOT NULL; ' +
                'CREATE INDEX idx_wasm_removed_constant_partial ON wasm_index_dependencies(' +
                'note) WHERE removed IS NOT NULL AND 0; ' +
                "INSERT INTO wasm_index_dependencies VALUES ('same', 'value', 'active')"
            );

            const dependent = (
                await dependencyEngine.findDependentIndexes(
                    'wasm_index_dependencies',
                    ['removed']
                )
            ).sort();
            assert.deepStrictEqual(dependent, [
                'idx_wasm_removed_collate',
                'idx_wasm_removed_constant_partial',
                'idx_wasm_removed_partial'
            ]);

            await dependencyEngine.deleteColumns(
                'wasm_index_dependencies',
                ['removed'],
                dependent
            );
            const remaining = await dependencyEngine.executeQuery(
                "SELECT name FROM sqlite_schema WHERE type = 'index' " +
                "AND tbl_name = 'wasm_index_dependencies' ORDER BY name"
            );
            assert.deepStrictEqual(remaining[0].rows, [['idx_wasm_unrelated']]);
            await assert.rejects(
                dependencyEngine.executeQuery(
                    "INSERT INTO wasm_index_dependencies(keep, note) VALUES ('same', 'active')"
                ),
                /UNIQUE constraint failed/
            );
        })
    ));

    it('honors requested NOT NULL on a TEXT PRIMARY KEY', () => (
        withFreshWasmEngine(async schemaEngine => {
            await schemaEngine.createTable('wasm_text_primary_key', [
                { name: 'key', type: 'TEXT', primaryKey: true, notNull: true },
                { name: 'value', type: 'TEXT', primaryKey: false, notNull: false }
            ]);

            const info = await schemaEngine.executeQuery(
                'PRAGMA table_info("wasm_text_primary_key")'
            );
            assert.strictEqual(info[0].rows[0][3], 1);
            await assert.rejects(
                schemaEngine.insertRow('wasm_text_primary_key', { key: null, value: 'invalid' }),
                /NOT NULL constraint failed/
            );
        })
    ));

    it('builds selected primary-key columns as one NOT NULL composite key', () => (
        withFreshWasmEngine(async schemaEngine => {
            await schemaEngine.createTable('wasm_composite_primary_key', [
                { name: 'tenant', type: 'TEXT', primaryKey: true, notNull: true },
                { name: 'sequence', type: 'INTEGER', primaryKey: true, notNull: true },
                { name: 'value', type: 'TEXT', primaryKey: false, notNull: false }
            ]);

            const info = await schemaEngine.executeQuery(
                'PRAGMA table_info("wasm_composite_primary_key")'
            );
            assert.deepStrictEqual(
                info[0].rows.map(row => [row[1], row[3], row[5]]),
                [
                    ['tenant', 1, 1],
                    ['sequence', 1, 2],
                    ['value', 0, 0]
                ]
            );
            await assert.rejects(
                schemaEngine.insertRow('wasm_composite_primary_key', {
                    tenant: 'north',
                    sequence: null,
                    value: 'invalid'
                }),
                /NOT NULL constraint failed/
            );
        })
    ));

    it('preserves Create Table defaults and targets main through a TEMP shadow', () => (
        withFreshWasmEngine(async schemaEngine => {
            await schemaEngine.executeQuery(
                'CREATE TEMP TABLE "shadowed_create" ("temporary_only" TEXT)'
            );
            await schemaEngine.createTable('shadowed_create', [
                {
                    name: 'value',
                    type: 'TEXT',
                    primaryKey: false,
                    notNull: false,
                    defaultValue: 'hello'
                }
            ]);

            const mainInfo = await schemaEngine.executeQuery(
                'PRAGMA main.table_info("shadowed_create")'
            );
            const tempInfo = await schemaEngine.executeQuery(
                'PRAGMA temp.table_info("shadowed_create")'
            );
            assert.deepStrictEqual(
                mainInfo[0].rows.map(row => [row[1], row[4]]),
                [['value', "'hello'"]]
            );
            assert.deepStrictEqual(
                tempInfo[0].rows.map(row => row[1]),
                ['temporary_only']
            );
        })
    ));

    it('adds and deletes columns only on main through a TEMP table shadow', () => (
        withFreshWasmEngine(async schemaEngine => {
            await schemaEngine.executeQuery(
                'CREATE TABLE "shadowed_ddl" ("keep" TEXT, "removed" TEXT); ' +
                'CREATE TEMP TABLE "shadowed_ddl" ("temporary_only" TEXT, "removed" TEXT)'
            );

            await schemaEngine.addColumn('shadowed_ddl', 'added', 'TEXT');
            await schemaEngine.deleteColumns('shadowed_ddl', ['removed']);

            const mainInfo = await schemaEngine.executeQuery(
                'PRAGMA main.table_info("shadowed_ddl")'
            );
            const tempInfo = await schemaEngine.executeQuery(
                'PRAGMA temp.table_info("shadowed_ddl")'
            );
            assert.deepStrictEqual(
                mainInfo[0].rows.map(row => row[1]),
                ['keep', 'added']
            );
            assert.deepStrictEqual(
                tempInfo[0].rows.map(row => row[1]),
                ['temporary_only', 'removed']
            );
        })
    ));

    it('keeps every table-browser CRUD operation on main through a TEMP shadow', () => (
        withFreshWasmEngine(async crudEngine => {
            const table = 'shadowed_crud_target';
            await crudEngine.executeQuery(
                `CREATE TABLE main.${table} (id INTEGER PRIMARY KEY, value TEXT); ` +
                `INSERT INTO main.${table}(id, value) VALUES ` +
                `(1, 'main-one'), (2, 'main-two'), (5, '0123456789'); ` +
                `CREATE TEMP TABLE ${table} (id INTEGER PRIMARY KEY, value TEXT); ` +
                `INSERT INTO temp.${table}(id, value) VALUES ` +
                `(1, 'temp-one'), (2, 'temp-two'), (5, 'temp-five'), (99, 'temp-only')`
            );

            const initial = await crudEngine.fetchTableData(table, {
                columns: ['rowid', 'id', 'value'],
                orderBy: 'id',
                limit: 20,
                offset: 0
            });
            assert.deepStrictEqual(initial.rows, [
                [1, 1, 'main-one'],
                [2, 2, 'main-two'],
                [5, 5, '0123456789']
            ]);
            assert.strictEqual(
                (await crudEngine.fetchTableCount(table, { columns: ['id', 'value'] })).count,
                3
            );

            await crudEngine.updateCell(table, 1, 'value', 'main-one-updated');
            await crudEngine.updateCellBatch(table, [{
                rowId: 2,
                column: 'value',
                value: 'main-two-updated'
            }]);
            await crudEngine.replaceOversizedCell(
                table,
                5,
                'value',
                'fit',
                { storageClass: 'text', byteLength: 10 },
                4
            );
            await crudEngine.insertRow(table, { id: 3, value: 'main-three' });
            await crudEngine.insertRowBatch(table, [{ id: 4, value: 'main-four' }]);
            const deleted = await crudEngine.deleteRows(table, [2]);
            assert.strictEqual(deleted[0]?.row.value, 'main-two-updated');

            assert.deepStrictEqual(
                (await crudEngine.executeQuery(
                    `SELECT id, value FROM main.${table} ORDER BY id`
                ))[0].rows,
                [
                    [1, 'main-one-updated'],
                    [3, 'main-three'],
                    [4, 'main-four'],
                    [5, 'fit']
                ]
            );
            assert.deepStrictEqual(
                (await crudEngine.executeQuery(
                    `SELECT id, value FROM temp.${table} ORDER BY id`
                ))[0].rows,
                [
                    [1, 'temp-one'],
                    [2, 'temp-two'],
                    [5, 'temp-five'],
                    [99, 'temp-only']
                ]
            );
        })
    ));

    it('rejects creating a main table that would shadow and break a TEMP dependency', () => (
        withFreshWasmEngine(async schemaEngine => {
            await schemaEngine.executeQuery(
                "ATTACH ':memory:' AS aux; " +
                'CREATE TABLE aux.created_table_shadow (value TEXT); ' +
                "INSERT INTO aux.created_table_shadow VALUES ('aux'); " +
                'CREATE TEMP VIEW created_table_shadow_consumer AS ' +
                'SELECT value FROM created_table_shadow'
            );

            await assert.rejects(
                schemaEngine.createTable('created_table_shadow', [{
                    name: 'other',
                    type: 'TEXT',
                    primaryKey: false,
                    notNull: false
                }]),
                /would break existing view.*created_table_shadow_consumer/is
            );
            assert.deepStrictEqual(
                (await schemaEngine.executeQuery(
                    'SELECT value FROM temp.created_table_shadow_consumer'
                ))[0].rows,
                [['aux']]
            );
        })
    ));

    it('keeps INTEGER PRIMARY KEY auto-rowid assignment when NOT NULL is requested', () => (
        withFreshWasmEngine(async schemaEngine => {
            await schemaEngine.createTable('wasm_integer_primary_key', [
                { name: 'id', type: 'INTEGER', primaryKey: true, notNull: true },
                { name: 'value', type: 'TEXT', primaryKey: false, notNull: false }
            ]);

            await schemaEngine.insertRow('wasm_integer_primary_key', {
                id: null,
                value: 'auto'
            });
            const rows = await schemaEngine.executeQuery(
                'SELECT id, value FROM "wasm_integer_primary_key"'
            );
            assert.deepStrictEqual(rows[0].rows, [[1, 'auto']]);
        })
    ));

    it('preserves legal SQLite identifiers across table and column creation', () => (
        withFreshWasmEngine(async schemaEngine => {
            const table = ' ui "table" 🚀 ';
            const firstColumn = ' id "column" 🧩 ';
            const addedColumn = ' added "column" ✨ ';
            await schemaEngine.createTable(table, [{
                name: firstColumn,
                type: 'TEXT',
                primaryKey: false,
                notNull: false
            }]);
            await schemaEngine.addColumn(table, addedColumn, 'TEXT');
            await schemaEngine.insertRow(table, {
                [firstColumn]: 'first',
                [addedColumn]: 'second'
            });

            assert.deepStrictEqual(
                (await schemaEngine.getTableInfo(table)).map(column => column.identifier),
                [firstColumn, addedColumn]
            );
            assert.deepStrictEqual(
                (await schemaEngine.fetchTableData(table, {
                    columns: ['rowid', firstColumn, addedColumn],
                    limit: 1,
                    offset: 0
                })).rows,
                [[1, 'first', 'second']]
            );
        })
    ));

    it('rejects unusable created identifiers and leaves case equality to SQLite', () => (
        withFreshWasmEngine(async schemaEngine => {
            const column = {
                name: 'value',
                type: 'TEXT',
                primaryKey: false,
                notNull: false
            };
            await assert.rejects(
                schemaEngine.createTable('', [column]),
                /Table name is required/
            );
            await assert.rejects(
                schemaEngine.createTable('bad\0table', [column]),
                /Table name cannot contain NUL/
            );
            await assert.rejects(
                schemaEngine.createTable('valid table', [{ ...column, name: 'bad\0column' }]),
                /Column name cannot contain NUL/
            );
            await assert.rejects(
                schemaEngine.createTable('duplicate column table', [
                    { ...column, name: 'value' },
                    { ...column, name: 'VALUE' }
                ]),
                /Column "VALUE" is defined more than once/
            );

            await schemaEngine.createTable('Case Table', [column]);
            await assert.rejects(
                schemaEngine.createTable('case table', [column]),
                /already exists/i
            );
            await schemaEngine.createTable('Ä Table', [column]);
            await schemaEngine.createTable('ä Table', [column]);
            await assert.rejects(
                schemaEngine.addColumn('Case Table', '', 'TEXT'),
                /Column name is required/
            );
            await assert.rejects(
                schemaEngine.addColumn('Case Table', 'bad\0column', 'TEXT'),
                /Column name cannot contain NUL/
            );
            await assert.rejects(
                schemaEngine.addColumn('Case Table', 'VALUE', 'TEXT'),
                /Column "VALUE" already exists in table "Case Table"/
            );
        })
    ));

    it('replays persistent PRAGMA history for hot-exit and refuses in-memory undo', async () => {
        const opened = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const pragmaEngine = opened.operations!;
        const modification: ModificationEntry = {
            description: 'Set PRAGMA auto_vacuum',
            modificationType: 'pragma_update',
            targetPragma: 'auto_vacuum',
            priorValue: 0,
            newValue: 1,
            undoPolicy: 'barrier',
            undoBarrierKind: 'persistent_pragma'
        };
        try {
            assert.strictEqual((await pragmaEngine.getPragmas()).auto_vacuum, 0);
            await pragmaEngine.applyModifications([modification]);
            assert.strictEqual((await pragmaEngine.getPragmas()).auto_vacuum, 1);
            await assert.rejects(
                pragmaEngine.undoModification(modification),
                /forward-only history barrier/i
            );
        } finally {
            (pragmaEngine as any).shutdown?.();
        }
    });

    it('preserves caller order for heterogeneous batch inserts', () => (
        withFreshWasmEngine(async batchEngine => {
            const wasmEngine = batchEngine as any;
            await batchEngine.executeQuery('CREATE TABLE batch_target (a TEXT, b TEXT)');

            const originalPrepare = wasmEngine.instance.prepare.bind(wasmEngine.instance);
            const insertPrepares: string[] = [];
            wasmEngine.instance.prepare = (sql: string, params?: unknown[]) => {
                if (sql.startsWith('INSERT INTO main."batch_target"')) insertPrepares.push(sql);
                return originalPrepare(sql, params);
            };
            try {
                await batchEngine.insertRowBatch('batch_target', [
                    { a: 'first' },
                    { b: 'second' },
                    { a: 'third' }
                ]);
            } finally {
                wasmEngine.instance.prepare = originalPrepare;
            }

            const target = await batchEngine.executeQuery(
                'SELECT COALESCE(a, b) FROM batch_target ORDER BY rowid'
            );
            assert.deepStrictEqual(
                target[0].rows.map(row => row[0]),
                ['first', 'second', 'third']
            );
            assert.deepStrictEqual(insertPrepares, [
                'INSERT INTO main."batch_target" ("a") VALUES (?)',
                'INSERT INTO main."batch_target" ("b") VALUES (?)'
            ]);
        })
    ));

    it('rejects batch inserts whose trigger side effects cannot be represented in history', () => (
        withFreshWasmEngine(async batchEngine => {
            await batchEngine.executeQuery('CREATE TABLE triggered_batch_target (value TEXT)');
            await batchEngine.executeQuery('CREATE TABLE triggered_batch_audit (value TEXT)');
            await batchEngine.executeQuery(
                'CREATE TRIGGER audit_triggered_batch AFTER INSERT ON triggered_batch_target ' +
                'BEGIN INSERT INTO triggered_batch_audit VALUES (NEW.value); END'
            );

            await assert.rejects(
                batchEngine.insertRowBatch('triggered_batch_target', [{ value: 'blocked' }]),
                /trigger side effects cannot be represented safely in undo history/i
            );
            assert.deepStrictEqual(
                (await batchEngine.executeQuery(
                    'SELECT value FROM triggered_batch_target'
                ))[0].rows,
                []
            );
            assert.deepStrictEqual(
                (await batchEngine.executeQuery(
                    'SELECT value FROM triggered_batch_audit'
                ))[0].rows,
                []
            );
        })
    ));

    it('preserves value order for same-shape batch inserts', () => (
        withFreshWasmEngine(async batchEngine => {
            await batchEngine.executeQuery('CREATE TABLE same_shape_batch (value TEXT NOT NULL)');
            await batchEngine.insertRowBatch('same_shape_batch', [
                { value: 'first' },
                { value: 'second' },
                { value: 'third' }
            ]);

            const result = await batchEngine.executeQuery(
                'SELECT value FROM same_shape_batch ORDER BY rowid'
            );
            assert.deepStrictEqual(
                result[0].rows.map(row => row[0]),
                ['first', 'second', 'third']
            );
        })
    ));

    it('supports repeated default-value rows in a batch', () => (
        withFreshWasmEngine(async batchEngine => {
            await batchEngine.executeQuery(`
                CREATE TABLE default_value_batch (
                    id INTEGER PRIMARY KEY,
                    value TEXT NOT NULL DEFAULT 'generated'
                )
            `);
            await batchEngine.insertRowBatch('default_value_batch', [{}, {}]);

            const result = await batchEngine.executeQuery(
                'SELECT id, value FROM default_value_batch ORDER BY rowid'
            );
            assert.deepStrictEqual(result[0].rows, [
                [1, 'generated'],
                [2, 'generated']
            ]);
        })
    ));

    it('rolls back a failed batch and permits a subsequent successful insert', () => (
        withFreshWasmEngine(async batchEngine => {
            await batchEngine.executeQuery(
                'CREATE TABLE atomic_batch (value TEXT NOT NULL UNIQUE)'
            );

            await assert.rejects(
                batchEngine.insertRowBatch('atomic_batch', [
                    { value: 'first' },
                    { value: 'duplicate' },
                    { value: 'duplicate' }
                ]),
                /UNIQUE constraint failed/
            );
            const afterFailure = await batchEngine.executeQuery(
                'SELECT value FROM atomic_batch ORDER BY rowid'
            );
            assert.deepStrictEqual(afterFailure[0]?.rows ?? [], []);

            await batchEngine.insertRowBatch('atomic_batch', [{ value: 'after' }]);
            const afterSuccess = await batchEngine.executeQuery(
                'SELECT value FROM atomic_batch ORDER BY rowid'
            );
            assert.deepStrictEqual(afterSuccess[0].rows, [['after']]);
        })
    ));

    it('rejects an invalid table before opening a transaction', () => (
        withFreshWasmEngine(async batchEngine => {
            await batchEngine.executeQuery('CREATE TABLE valid_after_invalid_table (value TEXT)');

            await assert.rejects(
                batchEngine.insertRowBatch(undefined as any, [{ value: 'invalid' }]),
                TypeError
            );
            await batchEngine.insertRowBatch(
                'valid_after_invalid_table',
                [{ value: 'after' }]
            );

            const result = await batchEngine.executeQuery(
                'SELECT value FROM valid_after_invalid_table ORDER BY rowid'
            );
            assert.deepStrictEqual(result[0].rows, [['after']]);
        })
    ));

    it('rolls back when preparing a later row shape fails', () => (
        withFreshWasmEngine(async batchEngine => {
            const wasmEngine = batchEngine as any;
            await batchEngine.executeQuery('CREATE TABLE prepare_failure_batch (a TEXT, b TEXT)');
            const originalPrepare = wasmEngine.instance.prepare.bind(wasmEngine.instance);
            wasmEngine.instance.prepare = (sql: string, params?: unknown[]) => {
                if (sql === 'INSERT INTO main."prepare_failure_batch" ("b") VALUES (?)') {
                    throw new Error('simulated second-shape prepare failure');
                }
                return originalPrepare(sql, params);
            };

            try {
                await assert.rejects(
                    batchEngine.insertRowBatch('prepare_failure_batch', [
                        { a: 'first' },
                        { b: 'second' }
                    ]),
                    /simulated second-shape prepare failure/
                );
            } finally {
                wasmEngine.instance.prepare = originalPrepare;
            }

            const afterFailure = await batchEngine.executeQuery(
                'SELECT COALESCE(a, b) FROM prepare_failure_batch ORDER BY rowid'
            );
            assert.deepStrictEqual(afterFailure[0]?.rows ?? [], []);

            await batchEngine.insertRowBatch('prepare_failure_batch', [{ a: 'after' }]);
            const afterSuccess = await batchEngine.executeQuery(
                'SELECT COALESCE(a, b) FROM prepare_failure_batch ORDER BY rowid'
            );
            assert.deepStrictEqual(afterSuccess[0].rows, [['after']]);
        })
    ));

    it('rolls back when a deferred foreign key rejects commit', () => (
        withFreshWasmEngine(async batchEngine => {
            await batchEngine.executeQuery('PRAGMA foreign_keys = ON');
            const foreignKeys = await batchEngine.executeQuery('PRAGMA foreign_keys');
            assert.strictEqual(foreignKeys[0].rows[0][0], 1);
            await batchEngine.executeQuery('CREATE TABLE deferred_parent (id INTEGER PRIMARY KEY)');
            await batchEngine.executeQuery(`
                CREATE TABLE deferred_child (
                    parent_id INTEGER NOT NULL,
                    value TEXT NOT NULL,
                    FOREIGN KEY (parent_id) REFERENCES deferred_parent(id)
                        DEFERRABLE INITIALLY DEFERRED
                )
            `);

            const originalExecuteQuery = batchEngine.executeQuery.bind(batchEngine);
            const transactionCommands: string[] = [];
            batchEngine.executeQuery = async (sql, params, cancellation) => {
                if (/^(?:SAVEPOINT|RELEASE|ROLLBACK TO)\b/.test(sql)) {
                    transactionCommands.push(sql);
                }
                return originalExecuteQuery(sql, params, cancellation);
            };
            try {
                await assert.rejects(
                    batchEngine.insertRowBatch('deferred_child', [
                        { parent_id: 404, value: 'must roll back' }
                    ]),
                    /FOREIGN KEY constraint failed/
                );
            } finally {
                batchEngine.executeQuery = originalExecuteQuery;
            }
            assert.strictEqual(transactionCommands.length, 4);
            assert.match(transactionCommands[0], /^SAVEPOINT /);
            assert.match(transactionCommands[1], /^RELEASE /);
            assert.match(transactionCommands[2], /^ROLLBACK TO /);
            assert.match(transactionCommands[3], /^RELEASE /);
            const afterFailure = await batchEngine.executeQuery(
                'SELECT parent_id, value FROM deferred_child ORDER BY rowid'
            );
            assert.deepStrictEqual(afterFailure[0]?.rows ?? [], []);

            await batchEngine.executeQuery('INSERT INTO deferred_parent (id) VALUES (1)');
            await batchEngine.insertRowBatch('deferred_child', [
                { parent_id: 1, value: 'after' }
            ]);
            const afterSuccess = await batchEngine.executeQuery(
                'SELECT parent_id, value FROM deferred_child ORDER BY rowid'
            );
            assert.deepStrictEqual(afterSuccess[0].rows, [[1, 'after']]);
        })
    ));

    it('preserves the insert error and every statement cleanup error', () => (
        withFreshWasmEngine(async batchEngine => {
            const wasmEngine = batchEngine as any;

            await batchEngine.executeQuery(
                'CREATE TABLE cleanup_failure_batch (a TEXT UNIQUE, b TEXT UNIQUE)'
            );
            const originalPrepare = wasmEngine.instance.prepare.bind(wasmEngine.instance);
            let preparedInsertCount = 0;
            wasmEngine.instance.prepare = (sql: string, params?: unknown[]) => {
                const statement = originalPrepare(sql, params);
                if (!sql.startsWith('INSERT INTO main."cleanup_failure_batch"')) return statement;
                const cleanupIndex = ++preparedInsertCount;
                const originalFree = statement.free.bind(statement);
                statement.free = () => {
                    originalFree();
                    throw new Error(`simulated cleanup failure ${cleanupIndex}`);
                };
                return statement;
            };

            let rejection: unknown;
            try {
                await batchEngine.insertRowBatch('cleanup_failure_batch', [
                    { a: 'duplicate' },
                    { b: 'second' },
                    { a: 'duplicate' }
                ]);
                assert.fail('Expected the duplicate batch to reject');
            } catch (error) {
                rejection = error;
            } finally {
                wasmEngine.instance.prepare = originalPrepare;
            }

            assert.ok(rejection instanceof AggregateError);
            assert.strictEqual(rejection.errors.length, 3);
            assert.match(String(rejection.errors[0]), /UNIQUE constraint failed/);
            assert.match(String(rejection.errors[1]), /simulated cleanup failure 1/);
            assert.match(String(rejection.errors[2]), /simulated cleanup failure 2/);
            const afterFailure = await batchEngine.executeQuery(
                'SELECT COALESCE(a, b) FROM cleanup_failure_batch ORDER BY rowid'
            );
            assert.deepStrictEqual(afterFailure[0]?.rows ?? [], []);
        })
    ));

    it('rolls back when statement finalization reports failure', () => (
        withFreshWasmEngine(async batchEngine => {
            const wasmEngine = batchEngine as any;

            await batchEngine.executeQuery('CREATE TABLE finalize_failure_batch (value TEXT)');
            const originalPrepare = wasmEngine.instance.prepare.bind(wasmEngine.instance);
            wasmEngine.instance.prepare = (sql: string, params?: unknown[]) => {
                const statement = originalPrepare(sql, params);
                if (!sql.startsWith('INSERT INTO main."finalize_failure_batch"')) return statement;
                const originalFree = statement.free.bind(statement);
                statement.free = () => {
                    originalFree();
                    return false;
                };
                return statement;
            };

            try {
                await assert.rejects(
                    batchEngine.insertRowBatch('finalize_failure_batch', [{ value: 'first' }]),
                    /failed to finalize/i
                );
            } finally {
                wasmEngine.instance.prepare = originalPrepare;
            }

            const afterFailure = await batchEngine.executeQuery(
                'SELECT value FROM finalize_failure_batch ORDER BY rowid'
            );
            assert.deepStrictEqual(afterFailure[0]?.rows ?? [], []);
        })
    ));

    it('should update multiple cells in a batch', async () => {
        // Setup initial data
        await engine.executeQuery("DELETE FROM users");
        await engine.insertRow('users', { id: 1, name: 'Alice', age: 30, data: '{}' });
        await engine.insertRow('users', { id: 2, name: 'Bob', age: 25, data: '{}' });

        const updates: CellUpdate[] = [
            { rowId: 1, column: 'name', value: 'Alice Smith' },
            { rowId: 2, column: 'age', value: 26 }
        ];

        await engine.updateCellBatch('users', updates);

        const result = await engine.executeQuery("SELECT * FROM users ORDER BY id");
        const rows = result[0].rows;

        // Alice updated
        assert.strictEqual(rows[0][1], 'Alice Smith');
        assert.strictEqual(rows[0][2], 30); // Age unchanged

        // Bob updated
        assert.strictEqual(rows[1][1], 'Bob'); // Name unchanged
        assert.strictEqual(rows[1][2], 26);
    });

    it('should handle JSON patch updates', async () => {
        // Setup initial data
        await engine.executeQuery("DELETE FROM users");
        await engine.insertRow('users', { id: 1, name: 'Charlie', age: 40, data: '{"a": 1, "b": 2}' });

        const updates: CellUpdate[] = [
            { rowId: 1, column: 'data', value: '{"b": 3, "c": 4}', operation: 'json_patch' }
        ];

        await engine.updateCellBatch('users', updates);

        const result = await engine.executeQuery("SELECT data FROM users WHERE id = 1");
        const dataStr = result[0].rows[0][0] as string;
        const data = JSON.parse(dataStr);

        assert.deepStrictEqual(data, { a: 1, b: 3, c: 4 });
    });

    it('should handle mixed standard and JSON patch updates', async () => {
         // Setup initial data
         await engine.executeQuery("DELETE FROM users");
         await engine.insertRow('users', { id: 1, name: 'David', age: 50, data: '{"x": 10}' });
         await engine.insertRow('users', { id: 2, name: 'Eve', age: 55, data: '{"y": 20}' });

         const updates: CellUpdate[] = [
             { rowId: 1, column: 'name', value: 'David Jones' },
             { rowId: 1, column: 'data', value: '{"x": 11}', operation: 'json_patch' },
             { rowId: 2, column: 'age', value: 56 },
             { rowId: 2, column: 'data', value: '{"z": 30}', operation: 'json_patch' }
         ];

         await engine.updateCellBatch('users', updates);

         const result = await engine.executeQuery("SELECT name, age, data FROM users ORDER BY id");
         const rows = result[0].rows;

         // David
         assert.strictEqual(rows[0][0], 'David Jones');
         assert.strictEqual(rows[0][1], 50); // Age unchanged
         assert.deepStrictEqual(JSON.parse(rows[0][2] as string), { x: 11 });

         // Eve
         assert.strictEqual(rows[1][0], 'Eve');
         assert.strictEqual(rows[1][1], 56);
         assert.deepStrictEqual(JSON.parse(rows[1][2] as string), { y: 20, z: 30 });
    });

    it('should handle empty updates gracefully', async () => {
        await engine.updateCellBatch('users', []);
        assert.ok(true);
    });

    it('should rollback transaction on error', async () => {
        // Setup initial data
        await engine.executeQuery("DELETE FROM users");
        await engine.insertRow('users', { id: 1, name: 'Frank', age: 60, data: '{}' });

        const updates: CellUpdate[] = [
            { rowId: 1, column: 'name', value: 'Frank Sinatra' }, // Valid update
            { rowId: 1, column: 'non_existent_column', value: 'Error' } // Invalid update
        ];

        try {
            await engine.updateCellBatch('users', updates);
            assert.fail('Should have thrown an error');
        } catch (e) {
            assert.ok(e);
        }

        // Verify rollback
        const result = await engine.executeQuery("SELECT name FROM users WHERE id = 1");
        assert.strictEqual(result[0].rows[0][0], 'Frank'); // Should remain original value
    });

    it('should replay modification entries when applyModifications restores a dirty backup', async () => {
        // A hot-exit backup stores edit history, not full database bytes. Restoring
        // that backup must replay each pending entry into the freshly opened
        // in-memory database so later saves contain the recovered edits.
        await engine.executeQuery("DROP TABLE IF EXISTS restored_users");
        await engine.executeQuery("CREATE TABLE restored_users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)");

        const modifications: ModificationEntry[] = [
            {
                description: 'Insert restored row',
                modificationType: 'row_insert',
                targetTable: 'restored_users',
                targetRowId: 1,
                rowData: { id: 1, name: 'Draft', age: 30 },
                insertedRow: {
                    rowId: 1,
                    row: { id: 1n, name: 'Draft', age: 30n },
                    storageClasses: [
                        { column: 'id', storageClass: 'integer' },
                        { column: 'name', storageClass: 'text' },
                        { column: 'age', storageClass: 'integer' }
                    ]
                }
            },
            {
                description: 'Update restored name',
                modificationType: 'cell_update',
                targetTable: 'restored_users',
                targetRowId: 1,
                targetColumn: 'name',
                priorValue: 'Draft',
                newValue: 'Recovered',
                operation: 'set',
                priorState: { storageClass: 'text', value: 'Draft' },
                postState: { storageClass: 'text', value: 'Recovered' }
            },
            {
                description: 'Update restored age',
                modificationType: 'cell_update',
                targetTable: 'restored_users',
                affectedCells: [
                    {
                        rowId: 1,
                        columnName: 'age',
                        priorValue: 30,
                        newValue: 31,
                        operation: 'set',
                        priorState: { storageClass: 'integer', value: 30n },
                        postState: { storageClass: 'integer', value: 31n }
                    }
                ]
            }
        ];

        await engine.applyModifications(modifications);

        const result = await engine.executeQuery("SELECT id, name, age FROM restored_users ORDER BY id");
        assert.deepStrictEqual(result[0].rows, [[1, 'Recovered', 31]]);
    });

    it('should stop replaying modifications when the restore signal is already aborted', async () => {
        // The restore caller passes an AbortSignal from VS Code cancellation.
        // A pre-aborted signal must fail loudly before any entry is applied.
        await engine.executeQuery("DROP TABLE IF EXISTS aborted_restore");
        await engine.executeQuery("CREATE TABLE aborted_restore (id INTEGER PRIMARY KEY, name TEXT)");

        const controller = new AbortController();
        controller.abort();

        await assert.rejects(
            () => engine.applyModifications([
                {
                    description: 'Insert aborted row',
                    modificationType: 'row_insert',
                    targetTable: 'aborted_restore',
                    targetRowId: 1,
                    rowData: { id: 1, name: 'Should not exist' },
                    insertedRow: {
                        rowId: 1,
                        row: { id: 1, name: 'Should not exist' },
                        storageClasses: [
                            { column: 'id', storageClass: 'integer' },
                            { column: 'name', storageClass: 'text' }
                        ]
                    }
                }
            ], controller.signal),
            /aborted/i
        );

        const result = await engine.executeQuery("SELECT COUNT(*) FROM aborted_restore");
        assert.strictEqual(result[0].rows[0][0], 0);
    });

    it('should check cancellation before each restored modification is replayed', async () => {
        // This signal flips to aborted after the first replay entry has finished.
        // applyModifications must observe that state at the next loop boundary
        // before starting another forward replay operation.
        await engine.executeQuery("DROP TABLE IF EXISTS boundary_abort_restore");
        await engine.executeQuery("CREATE TABLE boundary_abort_restore (id INTEGER PRIMARY KEY, name TEXT)");

        let checkCount = 0;
        let isAborted = false;
        const boundarySignal = {
            throwIfAborted() {
                checkCount++;
                if (isAborted) {
                    throw new Error('Replay aborted at loop boundary');
                }
                if (checkCount === 2) {
                    isAborted = true;
                }
            }
        } as AbortSignal;

        try {
            await assert.rejects(
                () => engine.applyModifications([
                    {
                        description: 'Insert first row before abort boundary',
                        modificationType: 'row_insert',
                        targetTable: 'boundary_abort_restore',
                        targetRowId: 1,
                        rowData: { id: 1, name: 'First' },
                        insertedRow: {
                            rowId: 1,
                            row: { id: 1, name: 'First' },
                            storageClasses: [
                                { column: 'id', storageClass: 'integer' },
                                { column: 'name', storageClass: 'text' }
                            ]
                        }
                    },
                    {
                        description: 'Insert second row after abort boundary',
                        modificationType: 'row_insert',
                        targetTable: 'boundary_abort_restore',
                        targetRowId: 2,
                        rowData: { id: 2, name: 'Second' },
                        insertedRow: {
                            rowId: 2,
                            row: { id: 2, name: 'Second' },
                            storageClasses: [
                                { column: 'id', storageClass: 'integer' },
                                { column: 'name', storageClass: 'text' }
                            ]
                        }
                    }
                ], boundarySignal),
                /Replay aborted at loop boundary/
            );

            assert.ok(checkCount >= 3);
            const result = await engine.executeQuery("SELECT COUNT(*) FROM boundary_abort_restore");
            assert.strictEqual(result[0].rows[0][0], 0);
        } finally {
            // The failed replay must leave the engine ready for later tests.
        }
    });

    it('undo single json_patch edit preserves a concurrent sibling key (s1)', async () => {
        // The tracked edit changes only status; the later reviewer key must survive undo.
        await engine.executeQuery('DELETE FROM users');
        const prior = JSON.stringify({ status: 'draft', owner: 'ada' });
        const forward = JSON.stringify({ status: 'published' });
        await engine.insertRow('users', { id: 1, name: 'A', age: 30, data: prior });
        await engine.updateCell('users', 1, 'data', null, forward);
        await engine.updateCell('users', 1, 'data', null, JSON.stringify({ reviewer: 'grace' }));

        await engine.undoModification({
            modificationType: 'cell_update',
            description: 'undo status',
            targetTable: 'users',
            targetRowId: 1,
            targetColumn: 'data',
            priorValue: prior,
            newValue: forward,
            operation: 'json_patch',
            priorState: { storageClass: 'text', value: prior },
            postState: {
                storageClass: 'text',
                value: JSON.stringify({ status: 'published', owner: 'ada' })
            }
        });

        const result = await engine.executeQuery('SELECT data FROM users WHERE id = 1');
        assert.deepStrictEqual(JSON.parse(result[0].rows[0][0] as string), {
            status: 'draft',
            owner: 'ada',
            reviewer: 'grace'
        });
    });

    it('undo of a wholly-added object key removes it entirely (s2)', async () => {
        // A forward patch that introduced an object with no surviving concurrent child should remove it.
        await engine.executeQuery('DELETE FROM users');
        const forward = JSON.stringify({ meta: { reviewed: true } });
        await engine.insertRow('users', { id: 1, name: 'A', age: 30, data: '{}' });
        await engine.updateCell('users', 1, 'data', null, forward);

        await engine.undoModification({
            modificationType: 'cell_update',
            description: 'undo meta',
            targetTable: 'users',
            targetRowId: 1,
            targetColumn: 'data',
            priorValue: '{}',
            newValue: forward,
            operation: 'json_patch',
            priorState: { storageClass: 'text', value: '{}' },
            postState: { storageClass: 'text', value: forward }
        });

        const result = await engine.executeQuery('SELECT data FROM users WHERE id = 1');
        assert.deepStrictEqual(JSON.parse(result[0].rows[0][0] as string), {});
    });

    it('undo restores an explicit null at the edited key while preserving a concurrent sibling (s4)', async () => {
        // Explicit null is a stored value here, not a merge-patch delete marker. c is added
        // concurrently after the tracked edit; blind value-replacement to prior would drop it.
        await engine.executeQuery('DELETE FROM users');
        const prior = JSON.stringify({ a: null, b: 1 });
        const forward = JSON.stringify({ a: 2 });
        await engine.insertRow('users', { id: 1, name: 'A', age: 30, data: prior });
        await engine.updateCell('users', 1, 'data', null, forward);
        await engine.updateCell('users', 1, 'data', null, JSON.stringify({ c: 3 }));

        await engine.undoModification({
            modificationType: 'cell_update',
            description: 'undo explicit null',
            targetTable: 'users',
            targetRowId: 1,
            targetColumn: 'data',
            priorValue: prior,
            newValue: forward,
            operation: 'json_patch',
            priorState: { storageClass: 'text', value: prior },
            postState: {
                storageClass: 'text',
                value: JSON.stringify({ a: 2, b: 1 })
            }
        });

        const result = await engine.executeQuery('SELECT data FROM users WHERE id = 1');
        const parsed = JSON.parse(result[0].rows[0][0] as string);
        assert.deepStrictEqual(parsed, { a: null, b: 1, c: 3 });
        assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'a'));
    });

    it('refuses JSON undo when the cell became non-JSON since the edit (s6)', async () => {
        // The current value no longer proves the recorded patch post-state.
        await engine.executeQuery('DELETE FROM users');
        const prior = JSON.stringify({ status: 'draft', owner: 'ada' });
        const forward = JSON.stringify({ status: 'published' });
        await engine.insertRow('users', { id: 1, name: 'A', age: 30, data: prior });
        await engine.updateCell('users', 1, 'data', null, forward);
        await engine.updateCell('users', 1, 'data', 'plain text');

        await assert.rejects(
            engine.undoModification({
                modificationType: 'cell_update',
                description: 'undo non-object current',
                targetTable: 'users',
                targetRowId: 1,
                targetColumn: 'data',
                priorValue: prior,
                newValue: forward,
                operation: 'json_patch',
                priorState: { storageClass: 'text', value: prior },
                postState: {
                    storageClass: 'text',
                    value: JSON.stringify({ status: 'published', owner: 'ada' })
                }
            }),
            /changed outside SQLite Explorer history/i
        );

        const result = await engine.executeQuery('SELECT data FROM users WHERE id = 1');
        assert.strictEqual(result[0].rows[0][0], 'plain text');
    });

    it('refuses JSON undo when a touched parent subtree changed shape', async () => {
        await engine.executeQuery('DELETE FROM users');
        const prior = JSON.stringify({ meta: { reviewed: false, owner: 'ada' } });
        const forward = JSON.stringify({ meta: { reviewed: true } });
        await engine.insertRow('users', { id: 1, name: 'A', age: 30, data: prior });
        await engine.updateCell('users', 1, 'data', JSON.stringify({ meta: 'archived' }));

        await assert.rejects(
            engine.undoModification({
                modificationType: 'cell_update',
                description: 'undo scalar nested current',
                targetTable: 'users',
                targetRowId: 1,
                targetColumn: 'data',
                priorValue: prior,
                newValue: forward,
                operation: 'json_patch',
                priorState: { storageClass: 'text', value: prior },
                postState: {
                    storageClass: 'text',
                    value: JSON.stringify({ meta: { reviewed: true, owner: 'ada' } })
                }
            }),
            /changed outside SQLite Explorer history/i
        );

        const result = await engine.executeQuery('SELECT data FROM users WHERE id = 1');
        assert.deepStrictEqual(JSON.parse(result[0].rows[0][0] as string), {
            meta: 'archived'
        });
    });

    it('undo value-replaces cells with precision-risky integer tokens without rounding siblings', async () => {
        // The id token is outside JavaScript's safe integer range. Undo must avoid
        // JSON.parse/stringify read-modify-write so the untouched id remains byte-exact.
        await engine.executeQuery('DELETE FROM users');
        const prior = '{"id":9007199254740993,"a":1}';
        const current = '{"id":9007199254740993,"a":2}';
        await engine.insertRow('users', { id: 1, name: 'A', age: 30, data: current });

        await engine.undoModification({
            modificationType: 'cell_update',
            description: 'undo precision-risky JSON patch',
            targetTable: 'users',
            targetRowId: 1,
            targetColumn: 'data',
            priorValue: prior,
            newValue: JSON.stringify({ a: 2 }),
            operation: 'json_patch',
            priorState: { storageClass: 'text', value: prior },
            postState: { storageClass: 'text', value: current }
        });

        const result = await engine.executeQuery('SELECT data FROM users WHERE id = 1');
        assert.strictEqual(result[0].rows[0][0], prior);
    });

    it('undo value-replaces cells with overflowing exponent tokens without nulling siblings', async () => {
        // The huge token parses to Infinity in JavaScript. Undo must avoid
        // JSON.parse/stringify read-modify-write so the untouched token does
        // not become null and the stored prior string remains byte-exact.
        await engine.executeQuery('DELETE FROM users');
        const prior = '{"huge":1e999,"a":1}';
        const current = '{"huge":1e999,"a":2}';
        await engine.insertRow('users', { id: 1, name: 'A', age: 30, data: current });

        await engine.undoModification({
            modificationType: 'cell_update',
            description: 'undo overflowing JSON patch number',
            targetTable: 'users',
            targetRowId: 1,
            targetColumn: 'data',
            priorValue: prior,
            newValue: JSON.stringify({ a: 2 }),
            operation: 'json_patch',
            priorState: { storageClass: 'text', value: prior },
            postState: { storageClass: 'text', value: current }
        });

        const result = await engine.executeQuery('SELECT data FROM users WHERE id = 1');
        assert.strictEqual(result[0].rows[0][0], prior);
    });

    it('undo value-replaces cells with high-precision decimals without rounding siblings', async () => {
        // The decimal carries more precision than a JS double. Undo must avoid the
        // JSON.parse/stringify restore so the untouched value stays byte-exact.
        await engine.executeQuery('DELETE FROM users');
        const prior = '{"precise":0.1234567890123456789012345,"a":1}';
        const current = '{"precise":0.1234567890123456789012345,"a":2}';
        await engine.insertRow('users', { id: 1, name: 'A', age: 30, data: current });

        await engine.undoModification({
            modificationType: 'cell_update',
            description: 'undo high-precision decimal',
            targetTable: 'users',
            targetRowId: 1,
            targetColumn: 'data',
            priorValue: prior,
            newValue: JSON.stringify({ a: 2 }),
            operation: 'json_patch',
            priorState: { storageClass: 'text', value: prior },
            postState: { storageClass: 'text', value: current }
        });

        const result = await engine.executeQuery('SELECT data FROM users WHERE id = 1');
        assert.strictEqual(result[0].rows[0][0], prior);
    });

    it('batch undo restores each json_patch cell, keeps concurrent siblings, and is atomic (s9)', async () => {
        // Two read-modify-write undos in one history entry must restore only the count keys.
        await engine.executeQuery('DELETE FROM users');
        const p1 = JSON.stringify({ count: 1, stable: 'one' });
        const p2 = JSON.stringify({ count: 10, stable: 'two' });
        await engine.insertRow('users', { id: 1, name: 'A', age: 30, data: p1 });
        await engine.insertRow('users', { id: 2, name: 'B', age: 31, data: p2 });
        await engine.updateCellBatch('users', [
            { rowId: 1, column: 'data', value: JSON.stringify({ count: 2 }), operation: 'json_patch' },
            { rowId: 2, column: 'data', value: JSON.stringify({ count: 11 }), operation: 'json_patch' }
        ]);
        await engine.updateCell('users', 1, 'data', null, JSON.stringify({ concurrent: 'one' }));
        await engine.updateCell('users', 2, 'data', null, JSON.stringify({ concurrent: 'two' }));

        await engine.undoModification({
            modificationType: 'cell_update',
            description: 'undo batch',
            targetTable: 'users',
            affectedCells: [
                {
                    rowId: 1,
                    columnName: 'data',
                    priorValue: p1,
                    newValue: JSON.stringify({ count: 2 }),
                    operation: 'json_patch',
                    priorState: { storageClass: 'text', value: p1 },
                    postState: {
                        storageClass: 'text',
                        value: JSON.stringify({ count: 2, stable: 'one' })
                    }
                },
                {
                    rowId: 2,
                    columnName: 'data',
                    priorValue: p2,
                    newValue: JSON.stringify({ count: 11 }),
                    operation: 'json_patch',
                    priorState: { storageClass: 'text', value: p2 },
                    postState: {
                        storageClass: 'text',
                        value: JSON.stringify({ count: 11, stable: 'two' })
                    }
                }
            ]
        });

        const result = await engine.executeQuery('SELECT id, data FROM users ORDER BY id');
        assert.deepStrictEqual(JSON.parse(result[0].rows[0][1] as string), {
            count: 1,
            stable: 'one',
            concurrent: 'one'
        });
        assert.deepStrictEqual(JSON.parse(result[0].rows[1][1] as string), {
            count: 10,
            stable: 'two',
            concurrent: 'two'
        });
    });

    it('batch json_patch undo uses its guarded internal compare-and-swap path', async () => {
        await engine.executeQuery('DELETE FROM users');
        const p1 = JSON.stringify({ count: 1, stable: 'one' });
        const p2 = JSON.stringify({ count: 10, stable: 'two' });
        await engine.insertRow('users', { id: 1, name: 'A', age: 30, data: JSON.stringify({ count: 2, stable: 'one' }) });
        await engine.insertRow('users', { id: 2, name: 'B', age: 31, data: JSON.stringify({ count: 11, stable: 'two' }) });

        const originalUpdateCell = engine.updateCell.bind(engine);
        const originalUpdateCellBatch = engine.updateCellBatch.bind(engine);
        const batchCalls: CellUpdate[][] = [];
        let singleCellWrites = 0;

        engine.updateCell = async (table, rowId, column, value, patch) => {
            singleCellWrites++;
            return originalUpdateCell(table, rowId, column, value, patch);
        };
        engine.updateCellBatch = async (table, updates) => {
            batchCalls.push(updates.map(update => ({ ...update })));
            return originalUpdateCellBatch(table, updates);
        };

        try {
            await engine.undoModification({
                modificationType: 'cell_update',
                description: 'undo batch through primitive',
                targetTable: 'users',
                affectedCells: [
                    {
                        rowId: 1,
                        columnName: 'data',
                        priorValue: p1,
                        newValue: JSON.stringify({ count: 2 }),
                        operation: 'json_patch',
                        priorState: { storageClass: 'text', value: p1 },
                        postState: {
                            storageClass: 'text',
                            value: JSON.stringify({ count: 2, stable: 'one' })
                        }
                    },
                    {
                        rowId: 2,
                        columnName: 'data',
                        priorValue: p2,
                        newValue: JSON.stringify({ count: 11 }),
                        operation: 'json_patch',
                        priorState: { storageClass: 'text', value: p2 },
                        postState: {
                            storageClass: 'text',
                            value: JSON.stringify({ count: 11, stable: 'two' })
                        }
                    }
                ]
            });
        } finally {
            engine.updateCell = originalUpdateCell;
            engine.updateCellBatch = originalUpdateCellBatch;
        }

        assert.strictEqual(singleCellWrites, 0);
        assert.strictEqual(batchCalls.length, 0);
        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT data FROM users ORDER BY id'))[0].rows,
            [[p1], [p2]]
        );
    });
});
