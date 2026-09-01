
import { describe, it, before, beforeEach, after, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import { ModificationTracker } from '../../src/core/undo-history';
import { revertDatabaseToSaved } from '../../src/core/restore-reconciler';
import type { LabeledModification } from '../../src/core/types';
import {
    assertNoNewColumnDropForeignKeyViolations,
    captureColumnDropForeignKeyBaseline,
    COLUMN_DROP_FOREIGN_KEY_FIELD_BYTES_LIMIT,
    COLUMN_DROP_FOREIGN_KEY_VIOLATION_LIMIT
} from '../../src/core/column-drop';

describe('SQLite Engine Undo/Redo', () => {
    let engine: any;
    const dbPath = path.join(__dirname, 'test_undo.db');

    // Use beforeEach to ensure clean state for each test
    beforeEach(async () => {
        // Initialize with empty DB
        const result = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        engine = result.operations;

        // Setup table
        await engine.executeQuery("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
        await engine.insertRow('users', { id: 1, name: 'Alice' });
        await engine.insertRow('users', { id: 2, name: 'Bob' });
    });

    afterEach(() => {
        if (engine && typeof engine.shutdown === 'function') {
            engine.shutdown();
        }
    });

    it('rolls back the whole File Revert when an earlier history entry conflicts', async () => {
        const tracker = new ModificationTracker<LabeledModification>(100);
        await engine.updateCell('users', 1, 'name', 'Edited');
        tracker.record({
            label: 'Edit Alice',
            description: 'Edit Alice',
            modificationType: 'cell_update',
            targetTable: 'users',
            targetRowId: 1,
            targetColumn: 'name',
            priorValue: 'Alice',
            newValue: 'Edited',
            priorState: { storageClass: 'text', value: 'Alice' },
            postState: { storageClass: 'text', value: 'Edited' }
        });
        const insertedRow = await engine.insertRowWithHistory('users', { id: 3, name: 'Carol' });
        tracker.record({
            label: 'Insert Carol',
            description: 'Insert Carol',
            modificationType: 'row_insert',
            targetTable: 'users',
            targetRowId: insertedRow.rowId,
            rowData: insertedRow.row,
            insertedRow
        });
        await engine.executeQuery("UPDATE users SET name = 'External' WHERE id = 1");

        await assert.rejects(
            revertDatabaseToSaved(engine, tracker),
            /changed outside SQLite Explorer history/i
        );

        const rows = await engine.executeQuery('SELECT id, name FROM users ORDER BY id');
        assert.deepStrictEqual(rows[0].rows, [
            [1, 'External'],
            [2, 'Bob'],
            [3, 'Carol']
        ]);
        assert.strictEqual(tracker.hasUncommittedChanges(), true);
    });

    async function captureRowidTableState(table: string) {
        const schema = await engine.executeQuery(
            "SELECT type, name, sql FROM main.sqlite_schema " +
            "WHERE (type = 'table' AND name = ?) OR " +
            "(tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL) " +
            "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name",
            [table, table]
        );
        const tableInfo = await engine.getTableInfo(table);
        const generatedColumns = tableInfo
            .filter((column: any) => column.isGenerated)
            .map((column: any) => column.identifier);
        return {
            tableSql: schema[0].rows[0][2] as string,
            columns: tableInfo.map((column: any) => column.identifier),
            ...(generatedColumns.length > 0 ? { generatedColumns } : {}),
            identity: { kind: 'rowid' as const },
            schemaObjects: schema[0].rows.slice(1).map((row: any[]) => ({
                type: row[0] as 'index' | 'trigger',
                identifier: row[1] as string,
                sql: row[2] as string
            }))
        };
    }

    it('should undo/redo row deletion', async () => {
        // 1. Delete Row 2
        const deletedRows = await engine.deleteRows('users', [2]);

        const verifyGone = await engine.fetchTableCount('users', {});
        assert.deepStrictEqual(verifyGone, { count: 1, isExact: true });

        // 2. Undo Delete
        const modification = {
            modificationType: 'row_delete',
            targetTable: 'users',
            description: 'Delete row',
            affectedRowIds: [2],
            deletedRows
        };
        await engine.undoModification(modification);

        const verifyRestored = await engine.fetchTableCount('users', {});
        assert.deepStrictEqual(verifyRestored, { count: 2, isExact: true });

        const restoredRow = await engine.executeQuery("SELECT name FROM users WHERE id = 2");
        assert.strictEqual(restoredRow[0].rows[0][0], 'Bob');

        // 3. Redo Delete
        await engine.redoModification(modification);

        const verifyDeletedAgain = await engine.fetchTableCount('users', {});
        assert.deepStrictEqual(verifyDeletedAgain, { count: 1, isExact: true });
    });

    it('restores a deleted row to its deterministic grid position', async () => {
        await engine.insertRow('users', { id: 3, name: 'Charlie' });
        const before = await engine.fetchTableData('users', {
            columns: ['rowid', 'id', 'name'],
            orderBy: 'id',
            limit: 10,
            offset: 0
        });
        const deletedRows = await engine.deleteRows('users', [2]);
        assert.ok(deletedRows);

        await engine.undoModification({
            modificationType: 'row_delete',
            targetTable: 'users',
            description: 'Delete middle row',
            deletedRows
        });

        const after = await engine.fetchTableData('users', {
            columns: ['rowid', 'id', 'name'],
            orderBy: 'id',
            limit: 10,
            offset: 0
        });
        assert.deepStrictEqual(after.rows, before.rows);
        assert.deepStrictEqual(after.rows.map((row: any[]) => row[0]), [1, 2, 3]);
    });

    it('should undo/redo column drop', async () => {
        // 1. Drop column 'name'
        const colDataResult = await engine.executeQuery("SELECT rowid, name FROM users");
        const colData = colDataResult[0].rows.map((r: any[]) => ({ rowId: r[0], value: r[1] }));

        await engine.deleteColumns('users', ['name']);

        // Verify column gone
        try {
            await engine.executeQuery("SELECT name FROM users");
            assert.fail("Column should be gone");
        } catch (e) {
            assert.ok(true);
        }

        // 2. Undo Drop
        await engine.undoModification({
            modificationType: 'column_drop',
            targetTable: 'users',
            description: 'Drop column',
            targetColumn: 'name', // legacy field, might not be used
            deletedColumns: [{ name: 'name', type: 'TEXT', data: colData }]
        });

        // Verify column back
        const result = await engine.executeQuery("SELECT name FROM users WHERE id = 1");
        assert.strictEqual(result[0].rows[0][0], 'Alice');

        // 3. Redo Drop
        await engine.redoModification({
            modificationType: 'column_drop',
            targetTable: 'users',
            description: 'Drop column',
            deletedColumns: [{ name: 'name', type: 'TEXT', data: colData }]
        });

        try {
            await engine.executeQuery("SELECT name FROM users");
            assert.fail("Column should be gone again");
        } catch (e) {
            assert.ok(true);
        }
    });

    it('rolls back a column drop when its post-drop snapshot cannot be captured', async () => {
        const originalGetTableInfo = engine.getTableInfo.bind(engine);
        engine.getTableInfo = async (table: string) => {
            const columns = await originalGetTableInfo(table);
            if (table === 'users' && !columns.some((column: any) => column.identifier === 'name')) {
                throw new Error('post-drop snapshot failed');
            }
            return columns;
        };

        await assert.rejects(
            engine.deleteColumns('users', ['name']),
            /post-drop snapshot failed/
        );

        assert.deepStrictEqual(
            (await originalGetTableInfo('users')).map((column: any) => column.identifier),
            ['id', 'name']
        );
    });

    it('restores a dropped middle column with its exact schema position and dependents', async () => {
        const createTableSql =
            "CREATE TABLE column_restore_parent (id INTEGER PRIMARY KEY, removed TEXT NOT NULL DEFAULT 'fallback' CHECK(length(removed) > 0), tail TEXT)";
        const createRemovedIndexSql =
            'CREATE INDEX idx_column_restore_removed ON column_restore_parent(removed)';
        const createTailIndexSql =
            'CREATE INDEX idx_column_restore_tail ON column_restore_parent(tail)';
        const createTriggerSql =
            'CREATE TRIGGER trg_column_restore_tail AFTER UPDATE OF tail ON column_restore_parent ' +
            'BEGIN INSERT INTO column_restore_audit(value) VALUES (NEW.tail); END';
        await engine.executeQuery('PRAGMA foreign_keys = ON');
        await engine.executeQuery('CREATE TABLE column_restore_audit (value TEXT)');
        await engine.executeQuery(createTableSql);
        await engine.executeQuery(createRemovedIndexSql);
        await engine.executeQuery(createTailIndexSql);
        await engine.executeQuery(createTriggerSql);
        await engine.executeQuery(
            'CREATE VIEW column_restore_view AS SELECT id, tail FROM column_restore_parent'
        );
        await engine.executeQuery(
            'CREATE TABLE column_restore_child (' +
            'id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES column_restore_parent(id))'
        );
        await engine.executeQuery(
            "INSERT INTO column_restore_parent(rowid, id, removed, tail) VALUES " +
            "(7, 7, 'seven', 'tail-7'), (11, 11, 'eleven', 'tail-11')"
        );
        await engine.executeQuery('INSERT INTO column_restore_child VALUES (1, 7)');

        const removedData = (await engine.executeQuery(
            'SELECT rowid, removed FROM column_restore_parent ORDER BY rowid'
        ))[0].rows.map((row: any[]) => ({ rowId: row[0], value: row[1] }));
        await engine.deleteColumns(
            'column_restore_parent',
            ['removed'],
            ['idx_column_restore_removed']
        );
        const afterTableSql = (await engine.executeQuery(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'column_restore_parent'"
        ))[0].rows[0][0];

        await engine.undoModification({
            modificationType: 'column_drop',
            targetTable: 'column_restore_parent',
            description: 'Drop middle constrained column',
            deletedColumns: [{ name: 'removed', type: 'TEXT', data: removedData }],
            droppedIndexes: ['idx_column_restore_removed'],
            columnDropSnapshot: {
                before: {
                    tableSql: createTableSql,
                    columns: ['id', 'removed', 'tail'],
                    identity: { kind: 'rowid' },
                    schemaObjects: [
                        { type: 'index', identifier: 'idx_column_restore_removed', sql: createRemovedIndexSql },
                        { type: 'index', identifier: 'idx_column_restore_tail', sql: createTailIndexSql },
                        { type: 'trigger', identifier: 'trg_column_restore_tail', sql: createTriggerSql }
                    ]
                },
                after: {
                    tableSql: afterTableSql,
                    columns: ['id', 'tail'],
                    identity: { kind: 'rowid' },
                    schemaObjects: [
                        { type: 'index', identifier: 'idx_column_restore_tail', sql: createTailIndexSql },
                        { type: 'trigger', identifier: 'trg_column_restore_tail', sql: createTriggerSql }
                    ]
                }
            }
        } as any);

        const tableInfo = (await engine.executeQuery(
            'PRAGMA table_info(column_restore_parent)'
        ))[0].rows;
        assert.deepStrictEqual(
            tableInfo.map((column: any[]) => [column[0], column[1], column[2], column[3], column[4]]),
            [
                [0, 'id', 'INTEGER', 0, null],
                [1, 'removed', 'TEXT', 1, "'fallback'"],
                [2, 'tail', 'TEXT', 0, null]
            ]
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT rowid, id, removed, tail FROM column_restore_parent ORDER BY rowid'
            ))[0].rows,
            [[7, 7, 'seven', 'tail-7'], [11, 11, 'eleven', 'tail-11']]
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                "SELECT type, name, sql FROM sqlite_schema " +
                "WHERE tbl_name = 'column_restore_parent' AND type IN ('index', 'trigger') " +
                'AND sql IS NOT NULL ORDER BY type, name'
            ))[0].rows,
            [
                ['index', 'idx_column_restore_removed', createRemovedIndexSql],
                ['index', 'idx_column_restore_tail', createTailIndexSql],
                ['trigger', 'trg_column_restore_tail', createTriggerSql]
            ]
        );
        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT id, tail FROM column_restore_view ORDER BY id'))[0].rows,
            [[7, 'tail-7'], [11, 'tail-11']]
        );
        assert.deepStrictEqual(
            (await engine.executeQuery('PRAGMA foreign_key_check'))[0]?.rows ?? [],
            []
        );
        assert.strictEqual(
            (await engine.executeQuery('PRAGMA foreign_keys'))[0].rows[0][0],
            1
        );
        await engine.executeQuery(
            "UPDATE column_restore_parent SET tail = 'changed' WHERE id = 7"
        );
        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT value FROM column_restore_audit'))[0].rows,
            [['changed']]
        );
    });

    it('preserves an AUTOINCREMENT high-water mark across positional column-drop undo', async () => {
        const createTableSql =
            'CREATE TABLE column_restore_sequence (' +
            'id INTEGER PRIMARY KEY AUTOINCREMENT, removed TEXT, tail TEXT)';
        await engine.executeQuery(createTableSql);
        await engine.executeQuery(
            "INSERT INTO column_restore_sequence(id, removed, tail) VALUES " +
            "(1, 'one', 'tail-1'), (100, 'retired', 'tail-100')"
        );
        await engine.executeQuery('DELETE FROM column_restore_sequence WHERE id = 100');
        const removedData = (await engine.executeQuery(
            'SELECT rowid, removed FROM column_restore_sequence'
        ))[0].rows.map((row: any[]) => ({ rowId: row[0], value: row[1] }));

        await engine.deleteColumns('column_restore_sequence', ['removed']);
        const afterTableSql = (await engine.executeQuery(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'column_restore_sequence'"
        ))[0].rows[0][0];
        await engine.undoModification({
            modificationType: 'column_drop',
            targetTable: 'column_restore_sequence',
            description: 'Restore AUTOINCREMENT middle column',
            deletedColumns: [{ name: 'removed', type: 'TEXT', data: removedData }],
            columnDropSnapshot: {
                before: {
                    tableSql: createTableSql,
                    columns: ['id', 'removed', 'tail'],
                    identity: { kind: 'rowid' },
                    schemaObjects: []
                },
                after: {
                    tableSql: afterTableSql,
                    columns: ['id', 'tail'],
                    identity: { kind: 'rowid' },
                    schemaObjects: []
                }
            }
        } as any);

        assert.strictEqual(
            (await engine.executeQuery(
                "SELECT seq FROM sqlite_sequence WHERE name = 'column_restore_sequence'"
            ))[0].rows[0][0],
            100
        );
        await engine.executeQuery(
            "INSERT INTO column_restore_sequence(removed, tail) VALUES ('next', 'tail-next')"
        );
        assert.strictEqual(
            (await engine.executeQuery(
                "SELECT id FROM column_restore_sequence WHERE tail = 'tail-next'"
            ))[0].rows[0][0],
            101
        );
    });

    it('allows positional column-drop undo when an unrelated FK violation pre-existed', async () => {
        await engine.executeQuery('PRAGMA foreign_keys = OFF');
        await engine.executeQuery('CREATE TABLE preexisting_fk_parent (id INTEGER PRIMARY KEY)');
        await engine.executeQuery(
            'CREATE TABLE preexisting_fk_child (' +
            'id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES preexisting_fk_parent(id)' +
            ') WITHOUT ROWID'
        );
        await engine.executeQuery('INSERT INTO preexisting_fk_child VALUES (1, 999), (2, 999)');
        await engine.executeQuery('PRAGMA foreign_keys = ON');
        assert.deepStrictEqual(
            (await engine.executeQuery('PRAGMA foreign_key_check'))[0].rows,
            [
                ['preexisting_fk_child', null, 'preexisting_fk_parent', 0],
                ['preexisting_fk_child', null, 'preexisting_fk_parent', 0]
            ]
        );

        const createTableSql =
            'CREATE TABLE fk_baseline_restore (' +
            'id INTEGER PRIMARY KEY, removed TEXT, tail TEXT)';
        await engine.executeQuery(createTableSql);
        await engine.executeQuery(
            "INSERT INTO fk_baseline_restore(rowid, id, removed, tail) " +
            "VALUES (7, 7, 'saved', 'tail')"
        );
        const removedData = (await engine.executeQuery(
            'SELECT rowid, removed FROM fk_baseline_restore'
        ))[0].rows.map((row: any[]) => ({ rowId: row[0], value: row[1] }));
        await engine.deleteColumns('fk_baseline_restore', ['removed']);
        const afterTableSql = (await engine.executeQuery(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'fk_baseline_restore'"
        ))[0].rows[0][0];

        await engine.undoModification({
            modificationType: 'column_drop',
            targetTable: 'fk_baseline_restore',
            description: 'Restore with unrelated pre-existing FK violation',
            deletedColumns: [{ name: 'removed', type: 'TEXT', data: removedData }],
            columnDropSnapshot: {
                before: {
                    tableSql: createTableSql,
                    columns: ['id', 'removed', 'tail'],
                    identity: { kind: 'rowid' },
                    schemaObjects: []
                },
                after: {
                    tableSql: afterTableSql,
                    columns: ['id', 'tail'],
                    identity: { kind: 'rowid' },
                    schemaObjects: []
                }
            }
        } as any);

        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT rowid, id, removed, tail FROM fk_baseline_restore'
            ))[0].rows,
            [[7, 7, 'saved', 'tail']]
        );
        assert.deepStrictEqual(
            (await engine.executeQuery('PRAGMA foreign_key_check'))[0].rows,
            [
                ['preexisting_fk_child', null, 'preexisting_fk_parent', 0],
                ['preexisting_fk_child', null, 'preexisting_fk_parent', 0]
            ]
        );
    });

    it('compares bounded foreign-key violations as a multiset', () => {
        const violation = ['child', null, 'parent', '0'] as const;
        const baseline = captureColumnDropForeignKeyBaseline('target', [violation, violation]);

        assert.doesNotThrow(() => assertNoNewColumnDropForeignKeyViolations(
            'target',
            baseline,
            [violation, violation]
        ));
        assert.throws(
            () => assertNoNewColumnDropForeignKeyViolations(
                'target',
                baseline,
                [violation, violation, violation]
            ),
            /new violations/i
        );
        assert.throws(
            () => captureColumnDropForeignKeyBaseline(
                'target',
                Array(COLUMN_DROP_FOREIGN_KEY_VIOLATION_LIMIT + 1).fill(violation)
            ),
            /safety bound/i
        );
        const longName = 'x'.repeat(20_000);
        assert.throws(
            () => captureColumnDropForeignKeyBaseline(
                'target',
                Array(60).fill([longName, null, longName, '0'])
            ),
            /byte safety bound/i
        );
        assert.throws(
            () => captureColumnDropForeignKeyBaseline(
                'target',
                [['x'.repeat(COLUMN_DROP_FOREIGN_KEY_FIELD_BYTES_LIMIT + 1), null, 'p', '0']]
            ),
            /field exceeds the safety bound/i
        );
    });

    it('rolls back positional undo when restored values introduce an FK violation', async () => {
        await engine.executeQuery('CREATE TABLE rebuild_fk_parent (id INTEGER PRIMARY KEY)');
        await engine.executeQuery('INSERT INTO rebuild_fk_parent VALUES (1)');
        const createTableSql =
            'CREATE TABLE rebuild_fk_target (' +
            'id INTEGER PRIMARY KEY, removed INTEGER REFERENCES rebuild_fk_parent(id), tail TEXT)';
        await engine.executeQuery(createTableSql);
        await engine.executeQuery(
            "INSERT INTO rebuild_fk_target(rowid, id, removed, tail) VALUES (7, 7, 1, 'tail')"
        );
        await engine.deleteColumns('rebuild_fk_target', ['removed']);
        const afterTableSql = (await engine.executeQuery(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'rebuild_fk_target'"
        ))[0].rows[0][0];
        // A real object with this name shadows the table-valued pragma. The
        // safety gate must execute the non-shadowable PRAGMA statement.
        await engine.executeQuery(
            'CREATE TABLE pragma_foreign_key_check (' +
            '"table" TEXT, rowid INTEGER, parent TEXT, fkid INTEGER)'
        );

        await assert.rejects(
            engine.undoModification({
                modificationType: 'column_drop',
                targetTable: 'rebuild_fk_target',
                description: 'Reject a new rebuild violation',
                deletedColumns: [{
                    name: 'removed',
                    type: 'INTEGER',
                    data: [{ rowId: 7, value: 999 }]
                }],
                columnDropSnapshot: {
                    before: {
                        tableSql: createTableSql,
                        columns: ['id', 'removed', 'tail'],
                        identity: { kind: 'rowid' },
                        schemaObjects: []
                    },
                    after: {
                        tableSql: afterTableSql,
                        columns: ['id', 'tail'],
                        identity: { kind: 'rowid' },
                        schemaObjects: []
                    }
                }
            } as any),
            /new violations/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery('PRAGMA table_info(rebuild_fk_target)'))[0].rows
                .map((column: any[]) => column[1]),
            ['id', 'tail']
        );
        assert.deepStrictEqual(
            (await engine.executeQuery('PRAGMA foreign_key_check'))[0]?.rows ?? [],
            []
        );
    });

    it('rolls back a guarded column restore when the post-drop schema changed', async () => {
        const createTableSql =
            'CREATE TABLE guarded_column_restore (id INTEGER PRIMARY KEY, removed TEXT, tail TEXT)';
        await engine.executeQuery(createTableSql);
        await engine.executeQuery(
            "INSERT INTO guarded_column_restore(rowid, id, removed, tail) VALUES (5, 5, 'value', 'tail')"
        );
        await engine.deleteColumns('guarded_column_restore', ['removed']);

        await assert.rejects(
            engine.undoModification({
                modificationType: 'column_drop',
                targetTable: 'guarded_column_restore',
                description: 'Reject stale column history',
                deletedColumns: [{
                    name: 'removed',
                    type: 'TEXT',
                    data: [{ rowId: 5, value: 'value' }]
                }],
                columnDropSnapshot: {
                    before: {
                        tableSql: createTableSql,
                        columns: ['id', 'removed', 'tail'],
                        identity: { kind: 'rowid' },
                        schemaObjects: []
                    },
                    after: {
                        tableSql: 'CREATE TABLE guarded_column_restore (id INTEGER PRIMARY KEY)',
                        columns: ['id', 'tail'],
                        identity: { kind: 'rowid' },
                        schemaObjects: []
                    }
                }
            } as any),
            /schema changed/i
        );

        assert.deepStrictEqual(
            (await engine.executeQuery('PRAGMA table_info(guarded_column_restore)'))[0].rows
                .map((column: any[]) => column[1]),
            ['id', 'tail']
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT rowid, id, tail FROM guarded_column_restore'
            ))[0].rows,
            [[5, 5, 'tail']]
        );
    });

    it('rejects table-create undo after the created table was replaced', async () => {
        const table = 'guarded_table_create';
        const columns = [
            { name: 'id', type: 'INTEGER', primaryKey: true, notNull: false },
            { name: 'value', type: 'TEXT', primaryKey: false, notNull: false }
        ];
        const tableCreateSnapshot = await engine.createTable(table, columns);

        await engine.executeQuery(`DROP TABLE ${table}`);
        await engine.executeQuery(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, replacement BLOB)`);
        await engine.executeQuery(`INSERT INTO ${table}(id, replacement) VALUES (1, X'CAFE')`);

        await assert.rejects(
            engine.undoModification({
                description: 'Undo stale table creation',
                modificationType: 'table_create',
                targetTable: table,
                tableDef: { columns },
                tableCreateSnapshot
            } as any),
            /schema changed/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                `SELECT id, typeof(replacement), hex(replacement) FROM ${table}`
            ))[0].rows,
            [[1, 'blob', 'CAFE']]
        );

        await engine.executeQuery(`DROP TABLE ${table}`);
        await engine.executeQuery(tableCreateSnapshot.tableSql);
        await engine.executeQuery(`INSERT INTO ${table}(id, value) VALUES (2, 'kept')`);
        await assert.rejects(
            engine.undoModification({
                description: 'Undo non-empty table creation',
                modificationType: 'table_create',
                targetTable: table,
                tableDef: { columns },
                tableCreateSnapshot
            } as any),
            /contains data/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(`SELECT id, value FROM ${table}`))[0].rows,
            [[2, 'kept']]
        );
    });

    it('undoes table creation only in main through a TEMP table shadow', async () => {
        const table = 'shadowed_table_create_undo';
        const columns = [{
            name: 'main_only',
            type: 'TEXT',
            primaryKey: false,
            notNull: false
        }];
        const tableCreateSnapshot = await engine.createTable(table, columns);
        await engine.executeQuery(
            `CREATE TEMP TABLE ${table} (temporary_only TEXT)`
        );

        await engine.undoModification({
            description: 'Undo main table creation through TEMP shadow',
            modificationType: 'table_create',
            targetTable: table,
            tableDef: { columns },
            tableCreateSnapshot
        } as any);

        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT name FROM main.sqlite_schema WHERE type = \'table\' AND name = ?',
                [table]
            ))[0].rows,
            []
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(`PRAGMA temp.table_info(${table})`))[0].rows
                .map((column: any[]) => column[1]),
            ['temporary_only']
        );
    });

    it('refuses table-create undo that would break a newer dependent view', async () => {
        const table = 'created_table_with_new_dependency';
        const columns = [{
            name: 'value',
            type: 'TEXT',
            primaryKey: false,
            notNull: false
        }];
        const tableCreateSnapshot = await engine.createTable(table, columns);
        await engine.executeQuery(
            `CREATE VIEW created_table_consumer AS SELECT value FROM ${table}`
        );

        await assert.rejects(
            engine.undoModification({
                description: 'Undo table creation with newer dependency',
                modificationType: 'table_create',
                targetTable: table,
                tableDef: { columns },
                tableCreateSnapshot
            } as any),
            /would break existing view.*created_table_consumer/is
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                "SELECT name FROM main.sqlite_schema WHERE name IN " +
                "('created_table_with_new_dependency', 'created_table_consumer') ORDER BY name"
            ))[0].rows,
            [['created_table_consumer'], ['created_table_with_new_dependency']]
        );
    });

    it('refuses legacy table-create undo without an identity snapshot', async () => {
        const table = 'legacy_table_create_without_snapshot';
        await engine.executeQuery(
            `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, retained TEXT)`
        );
        await engine.executeQuery(
            `INSERT INTO ${table}(id, retained) VALUES (1, 'must survive')`
        );

        await assert.rejects(
            engine.undoModification({
                description: 'Legacy table creation without a guard',
                modificationType: 'table_create',
                targetTable: table,
                tableDef: { columns: [] }
            } as any),
            /lacks the required schema snapshot/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(`SELECT id, retained FROM ${table}`))[0].rows,
            [[1, 'must survive']]
        );
    });

    it('rejects column-add undo after the added column was replaced', async () => {
        const table = 'guarded_column_add';
        await engine.executeQuery(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
        await engine.executeQuery(`INSERT INTO ${table}(id) VALUES (1)`);
        const columnAddSnapshot = await engine.addColumn(table, 'added', 'TEXT');

        await engine.executeQuery(`ALTER TABLE ${table} DROP COLUMN added`);
        await engine.executeQuery(`ALTER TABLE ${table} ADD COLUMN added BLOB`);
        await engine.executeQuery(`UPDATE ${table} SET added = X'BEEF' WHERE id = 1`);

        await assert.rejects(
            engine.undoModification({
                description: 'Undo stale column addition',
                modificationType: 'column_add',
                targetTable: table,
                targetColumn: 'added',
                columnDef: { type: 'TEXT' },
                columnAddSnapshot
            } as any),
            /schema changed/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                `SELECT typeof(added), hex(added) FROM ${table} WHERE id = 1`
            ))[0].rows,
            [['blob', 'BEEF']]
        );
    });

    it('rejects column-add redo after the original table was replaced', async () => {
        const table = 'guarded_column_add_redo';
        await engine.executeQuery(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
        const columnAddBeforeSnapshot = await captureRowidTableState(table);
        const columnAddSnapshot = await engine.addColumn(table, 'added', 'TEXT');
        const modification = {
            description: 'Redo guarded column addition',
            modificationType: 'column_add',
            targetTable: table,
            targetColumn: 'added',
            columnDef: { type: 'TEXT' },
            columnAddBeforeSnapshot,
            columnAddSnapshot
        } as any;
        await engine.undoModification(modification);

        await engine.executeQuery(`DROP TABLE ${table}`);
        await engine.executeQuery(
            `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, replacement BLOB)`
        );
        await engine.executeQuery(
            `INSERT INTO ${table}(id, replacement) VALUES (1, X'CAFE')`
        );

        await assert.rejects(engine.redoModification(modification), /schema changed/i);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                `SELECT id, typeof(replacement), hex(replacement) FROM ${table}`
            ))[0].rows,
            [[1, 'blob', 'CAFE']]
        );
    });

    it('rejects column-drop redo after the restored column was replaced', async () => {
        const table = 'guarded_column_drop_redo';
        await engine.executeQuery(
            `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, removed TEXT, tail TEXT)`
        );
        await engine.executeQuery(
            `INSERT INTO ${table}(id, removed, tail) VALUES (1, 'original', 'tail')`
        );
        const before = await captureRowidTableState(table);
        const after = await engine.deleteColumns(table, ['removed']);
        const modification = {
            description: 'Redo guarded column deletion',
            modificationType: 'column_drop',
            targetTable: table,
            deletedColumns: [{
                name: 'removed',
                type: 'TEXT',
                data: [{ rowId: 1, value: 'original' }]
            }],
            columnDropSnapshot: { before, after }
        } as any;
        await engine.undoModification(modification);

        await engine.executeQuery(`ALTER TABLE ${table} DROP COLUMN removed`);
        await engine.executeQuery(`ALTER TABLE ${table} ADD COLUMN removed BLOB`);
        await engine.executeQuery(`UPDATE ${table} SET removed = X'FACE' WHERE id = 1`);

        await assert.rejects(engine.redoModification(modification), /schema changed/i);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                `SELECT typeof(removed), hex(removed), tail FROM ${table} WHERE id = 1`
            ))[0].rows,
            [['blob', 'FACE', 'tail']]
        );
    });

    it('restores main column-drop schema objects through a TEMP table shadow', async () => {
        const table = 'shadowed_column_restore';
        await engine.executeQuery(
            `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, removed TEXT, keep TEXT); ` +
            `CREATE INDEX shadowed_restore_idx ON ${table}(keep); ` +
            `CREATE TRIGGER shadowed_restore_trg AFTER UPDATE ON ${table} ` +
            'BEGIN SELECT NEW.keep; END; ' +
            `INSERT INTO ${table}(id, removed, keep) VALUES (1, 'restore-me', 'kept')`
        );
        const before = await captureRowidTableState(table);
        const after = await engine.deleteColumns(table, ['removed']);
        await engine.executeQuery(
            `CREATE TEMP TABLE ${table} (temporary_only TEXT, keep TEXT)`
        );

        await engine.undoModification({
            description: 'Restore a dropped main column through TEMP shadow',
            modificationType: 'column_drop',
            targetTable: table,
            deletedColumns: [{
                name: 'removed',
                type: 'TEXT',
                data: [{ rowId: 1, value: 'restore-me' }]
            }],
            columnDropSnapshot: { before, after }
        } as any);

        assert.deepStrictEqual(
            (await engine.executeQuery(
                `SELECT id, removed, keep FROM main.${table}`
            ))[0].rows,
            [[1, 'restore-me', 'kept']]
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                "SELECT type, name FROM main.sqlite_schema " +
                "WHERE name IN ('shadowed_restore_idx', 'shadowed_restore_trg') ORDER BY name"
            ))[0].rows,
            [
                ['index', 'shadowed_restore_idx'],
                ['trigger', 'shadowed_restore_trg']
            ]
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(`PRAGMA temp.table_info(${table})`))[0].rows
                .map((column: any[]) => column[1]),
            ['temporary_only', 'keep']
        );
    });

    it('restores a dropped column without inserting generated columns', async () => {
        for (const storage of ['VIRTUAL', 'STORED']) {
            const table = `generated_column_restore_${storage.toLowerCase()}`;
            await engine.executeQuery(
                `CREATE TABLE ${table} (` +
                'id INTEGER PRIMARY KEY, base TEXT, removed TEXT, ' +
                `calculated TEXT GENERATED ALWAYS AS (base || '!') ${storage}); ` +
                `INSERT INTO ${table}(id, base, removed) VALUES (1, 'source', 'restore-me')`
            );
            const before = await captureRowidTableState(table);
            const after = await engine.deleteColumns(table, ['removed']);

            await engine.undoModification({
                description: `Restore column beside ${storage} generated column`,
                modificationType: 'column_drop',
                targetTable: table,
                deletedColumns: [{
                    name: 'removed',
                    type: 'TEXT',
                    data: [{ rowId: 1, value: 'restore-me' }]
                }],
                columnDropSnapshot: { before, after }
            } as any);

            assert.deepStrictEqual(
                (await engine.executeQuery(
                    `SELECT id, base, removed, calculated FROM ${table}`
                ))[0].rows,
                [[1, 'source', 'restore-me', 'source!']]
            );
        }
    });

    it('should undo/redo cell update', async () => {
        // 1. Update Cell (id=1, name='Alice' -> 'Alice Updated')
        const affectedCells = await engine.updateCellBatch('users', [{
            rowId: 1,
            column: 'name',
            value: 'Alice Updated'
        }]);

        const verifyUpdate = await engine.executeQuery("SELECT name FROM users WHERE id = 1");
        assert.strictEqual(verifyUpdate[0].rows[0][0], 'Alice Updated');

        // 2. Undo Update
        await engine.undoModification({
            modificationType: 'cell_update',
            targetTable: 'users',
            description: 'Update cell',
            affectedCells
        });

        const verifyRestored = await engine.executeQuery("SELECT name FROM users WHERE id = 1");
        assert.strictEqual(verifyRestored[0].rows[0][0], 'Alice');

        // 3. Redo Update
        await engine.redoModification({
            modificationType: 'cell_update',
            targetTable: 'users',
            description: 'Update cell',
            affectedCells
        });

        const verifyRedone = await engine.executeQuery("SELECT name FROM users WHERE id = 1");
        assert.strictEqual(verifyRedone[0].rows[0][0], 'Alice Updated');
    });

    it('rejects set undo after an external cell change and preserves that value', async () => {
        const affectedCells = await engine.updateCellBatch('users', [{
            rowId: 1,
            column: 'name',
            value: 'Tracked'
        }]);
        await engine.executeQuery("UPDATE users SET name = 'External' WHERE rowid = 1");

        await assert.rejects(
            engine.undoModification({
                modificationType: 'cell_update',
                targetTable: 'users',
                description: 'Tracked cell edit',
                affectedCells
            }),
            /changed outside SQLite Explorer history/i
        );

        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT name FROM users WHERE rowid = 1'))[0].rows,
            [['External']]
        );
    });

    it('rejects set redo after an external cell change and preserves that value', async () => {
        const affectedCells = await engine.updateCellBatch('users', [{
            rowId: 1,
            column: 'name',
            value: 'Tracked'
        }]);
        const modification = {
            modificationType: 'cell_update' as const,
            targetTable: 'users',
            description: 'Tracked cell edit',
            affectedCells
        };
        await engine.undoModification(modification);
        await engine.executeQuery("UPDATE users SET name = 'External' WHERE rowid = 1");

        await assert.rejects(
            engine.redoModification(modification),
            /changed outside SQLite Explorer history/i
        );

        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT name FROM users WHERE rowid = 1'))[0].rows,
            [['External']]
        );
    });

    it('rolls back a multi-cell undo when any expected cell changed externally', async () => {
        await engine.executeQuery("UPDATE users SET name = 'Alice' WHERE rowid = 1");
        const affectedCells = await engine.updateCellBatch('users', [
            { rowId: 1, column: 'name', value: 'Tracked Alice' },
            { rowId: 2, column: 'name', value: 'Tracked Bob' }
        ]);
        await engine.executeQuery("UPDATE users SET name = 'External Bob' WHERE rowid = 2");

        await assert.rejects(
            engine.undoModification({
                modificationType: 'cell_update',
                targetTable: 'users',
                description: 'Tracked batch edit',
                affectedCells
            }),
            /changed outside SQLite Explorer history/i
        );

        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT rowid, name FROM users ORDER BY rowid'))[0].rows,
            [[1, 'Tracked Alice'], [2, 'External Bob']]
        );
    });

    it('preserves untouched JSON siblings while undoing and redoing a tracked patch', async () => {
        await engine.executeQuery(
            "CREATE TABLE history_json_siblings (id INTEGER PRIMARY KEY, payload TEXT); " +
            "INSERT INTO history_json_siblings VALUES (1, '{\"status\":\"draft\",\"owner\":\"ada\"}')"
        );
        const affectedCells = await engine.updateCellBatch('history_json_siblings', [{
            rowId: 1,
            column: 'payload',
            value: '{"status":"published"}',
            operation: 'json_patch'
        }]);
        const modification = {
            modificationType: 'cell_update' as const,
            targetTable: 'history_json_siblings',
            description: 'Tracked JSON patch',
            affectedCells
        };
        await engine.executeQuery(
            `UPDATE history_json_siblings SET payload = json_patch(payload, '{"reviewer":"grace"}') WHERE rowid = 1`
        );

        await engine.undoModification(modification);
        assert.deepStrictEqual(
            JSON.parse((await engine.executeQuery(
                'SELECT payload FROM history_json_siblings WHERE rowid = 1'
            ))[0].rows[0][0] as string),
            { status: 'draft', owner: 'ada', reviewer: 'grace' }
        );

        await engine.redoModification(modification);
        assert.deepStrictEqual(
            JSON.parse((await engine.executeQuery(
                'SELECT payload FROM history_json_siblings WHERE rowid = 1'
            ))[0].rows[0][0] as string),
            { status: 'published', owner: 'ada', reviewer: 'grace' }
        );
    });

    it('rejects JSON undo when an externally changed touched path differs from the recorded post-state', async () => {
        await engine.executeQuery(
            "CREATE TABLE history_json_conflict (id INTEGER PRIMARY KEY, payload TEXT); " +
            "INSERT INTO history_json_conflict VALUES (1, '{\"status\":\"draft\",\"owner\":\"ada\"}')"
        );
        const affectedCells = await engine.updateCellBatch('history_json_conflict', [{
            rowId: 1,
            column: 'payload',
            value: '{"status":"published"}',
            operation: 'json_patch'
        }]);
        await engine.executeQuery(
            `UPDATE history_json_conflict SET payload = '{"status":"archived","owner":"ada","reviewer":"grace"}' WHERE rowid = 1`
        );

        await assert.rejects(
            engine.undoModification({
                modificationType: 'cell_update',
                targetTable: 'history_json_conflict',
                description: 'Tracked JSON patch',
                affectedCells
            }),
            /changed outside SQLite Explorer history/i
        );
        assert.deepStrictEqual(
            JSON.parse((await engine.executeQuery(
                'SELECT payload FROM history_json_conflict WHERE rowid = 1'
            ))[0].rows[0][0] as string),
            { status: 'archived', owner: 'ada', reviewer: 'grace' }
        );
    });

    it('distinguishes an absent JSON patch path from an explicit null', async () => {
        await engine.executeQuery(
            "CREATE TABLE history_json_missing (id INTEGER PRIMARY KEY, payload TEXT); " +
            "INSERT INTO history_json_missing VALUES (1, '{\"removed\":1,\"keep\":2}')"
        );
        const affectedCells = await engine.updateCellBatch('history_json_missing', [{
            rowId: 1,
            column: 'payload',
            value: '{"removed":null}',
            operation: 'json_patch'
        }]);
        await engine.executeQuery(
            `UPDATE history_json_missing SET payload = '{"removed":null,"keep":2}' WHERE rowid = 1`
        );

        await assert.rejects(
            engine.undoModification({
                modificationType: 'cell_update',
                targetTable: 'history_json_missing',
                description: 'Tracked JSON delete',
                affectedCells
            }),
            /changed outside SQLite Explorer history/i
        );
    });

    it('fails closed for legacy cell history entries without stored-state guards', async () => {
        await engine.updateCell('users', 1, 'name', 'Tracked');

        await assert.rejects(
            engine.undoModification({
                modificationType: 'cell_update',
                targetTable: 'users',
                targetRowId: 1,
                targetColumn: 'name',
                description: 'Legacy cell edit',
                priorValue: 'Alice',
                newValue: 'Tracked',
                operation: 'set'
            }),
            /predates guarded cell history/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT name FROM users WHERE rowid = 1'))[0].rows,
            [['Tracked']]
        );
    });

    it('captures and restores authoritative storage classes on typeless cells', async () => {
        await engine.executeQuery(
            'CREATE TABLE history_typeless (value); ' +
            'INSERT INTO history_typeless(value) VALUES (CAST(1 AS REAL))'
        );
        const affectedCells = await engine.updateCellBatch('history_typeless', [{
            rowId: 1,
            column: 'value',
            value: 2
        }]);
        assert.deepStrictEqual(affectedCells[0].priorState, {
            storageClass: 'real',
            value: 1
        });
        assert.deepStrictEqual(affectedCells[0].postState, {
            storageClass: 'integer',
            value: 2n
        });
        const modification = {
            modificationType: 'cell_update' as const,
            targetTable: 'history_typeless',
            description: 'Typeless edit',
            affectedCells
        };

        await engine.undoModification(modification);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT typeof(value), value FROM history_typeless WHERE rowid = 1'
            ))[0].rows,
            [['real', 1]]
        );

        await engine.redoModification(modification);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT typeof(value), value FROM history_typeless WHERE rowid = 1'
            ))[0].rows,
            [['integer', 2]]
        );
    });

    it('should undo/redo row insert', async () => {
        // 1. Insert Row (id=3, name='Charlie')
        const newRow = { id: 3, name: 'Charlie' };
        await engine.insertRow('users', newRow);

        const verifyInsert = await engine.fetchTableCount('users', {});
        // Note: previous tests might have left table state.
        // deleteRows test restores state to 2 rows.
        // columnDrop test restores state to 2 rows + name column.
        // cellUpdate test restores state to 'Alice Updated' (redo)
        // Wait, tests run sequentially but `before` runs once.
        // Let's check state.
        // After cell_update test, id=1 is 'Alice Updated', id=2 is gone? No, row_delete test redid delete of id=2.
        // So we likely have 1 row (id=1).

        // Actually, let's just insert and check count increase.
        const countBefore = (await engine.executeQuery("SELECT COUNT(*) FROM users"))[0].rows[0][0] as number;

        // Wait, insertRow was done above. Let's do another one.
        const row4 = { id: 4, name: 'Dave' };
        const insertedRow = await engine.insertRowWithHistory('users', row4);

        const countAfter = (await engine.executeQuery("SELECT COUNT(*) FROM users"))[0].rows[0][0] as number;
        assert.strictEqual(countAfter, countBefore + 1);

        // 2. Undo Insert
        const modification = {
            modificationType: 'row_insert',
            targetTable: 'users',
            description: 'Insert row',
            targetRowId: 4,
            rowData: insertedRow.row,
            insertedRow
        };
        await engine.undoModification(modification);

        const countRestored = (await engine.executeQuery("SELECT COUNT(*) FROM users"))[0].rows[0][0] as number;
        assert.strictEqual(countRestored, countBefore);

        // 3. Redo Insert
        await engine.redoModification(modification);

        const countRedone = (await engine.executeQuery("SELECT COUNT(*) FROM users"))[0].rows[0][0] as number;
        assert.strictEqual(countRedone, countBefore + 1);
    });

    it('refuses to undo an insert after that row changed externally', async () => {
        const insertedRow = await engine.insertRowWithHistory('users', { id: 3, name: 'tracked' });
        const modification = {
            modificationType: 'row_insert' as const,
            targetTable: 'users',
            targetRowId: insertedRow.rowId,
            description: 'Insert tracked row',
            rowData: insertedRow.row,
            insertedRow
        };
        await engine.executeQuery("UPDATE users SET name = 'external' WHERE id = 3");

        await assert.rejects(
            engine.undoModification(modification),
            /Row changed outside SQLite Explorer history/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT id, name FROM users WHERE id = 3'))[0].rows,
            [[3, 'external']]
        );
    });

    it('refuses to restore a deleted row after its identity was reused', async () => {
        const deletedRows = await engine.deleteRows('users', [2]);
        await engine.insertRow('users', { id: 2, name: 'replacement' });

        await assert.rejects(
            engine.undoModification({
                modificationType: 'row_delete',
                targetTable: 'users',
                description: 'Delete Bob',
                affectedRowIds: [2],
                deletedRows
            }),
            /Row changed outside SQLite Explorer history/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT id, name FROM users WHERE id = 2'))[0].rows,
            [[2, 'replacement']]
        );
    });

    it('refuses to redo a delete after the restored row changed externally', async () => {
        const deletedRows = await engine.deleteRows('users', [2]);
        const modification = {
            modificationType: 'row_delete' as const,
            targetTable: 'users',
            description: 'Delete Bob',
            affectedRowIds: [2],
            deletedRows
        };
        await engine.undoModification(modification);
        await engine.executeQuery("UPDATE users SET name = 'external' WHERE id = 2");

        await assert.rejects(
            engine.redoModification(modification),
            /Row changed outside SQLite Explorer history/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT id, name FROM users WHERE id = 2'))[0].rows,
            [[2, 'external']]
        );
    });

    it('captures defaulted row values and exact storage classes for insert history', async () => {
        await engine.executeQuery(
            "CREATE TABLE history_defaults (id INTEGER PRIMARY KEY, value DEFAULT 7, note TEXT DEFAULT 'x')"
        );
        const insertedRow = await engine.insertRowWithHistory('history_defaults', { id: 1 });
        const modification = {
            modificationType: 'row_insert' as const,
            targetTable: 'history_defaults',
            targetRowId: insertedRow.rowId,
            description: 'Insert defaulted row',
            rowData: insertedRow.row,
            insertedRow
        };

        assert.deepStrictEqual(insertedRow.row, { id: 1n, value: 7n, note: 'x' });
        assert.deepStrictEqual(insertedRow.storageClasses, [
            { column: 'id', storageClass: 'integer' },
            { column: 'value', storageClass: 'integer' },
            { column: 'note', storageClass: 'text' }
        ]);
        await engine.undoModification(modification);
        await engine.redoModification(modification);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT typeof(value), value, typeof(note), note FROM history_defaults'
            ))[0].rows,
            [['integer', 7, 'text', 'x']]
        );
    });

    it('replays row history for a legal empty column identifier', async () => {
        await engine.executeQuery('CREATE TABLE empty_row_history ("" TEXT, normal INTEGER)');
        const insertedRow = await engine.insertRowWithHistory(
            'empty_row_history',
            { '': 'empty-name', normal: 7 }
        );
        const modification = {
            modificationType: 'row_insert' as const,
            targetTable: 'empty_row_history',
            targetRowId: insertedRow.rowId,
            description: 'Insert empty-name column row',
            rowData: insertedRow.row,
            insertedRow
        };

        await engine.undoModification(modification);
        await engine.redoModification(modification);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT "", normal FROM empty_row_history'
            ))[0].rows,
            [['empty-name', 7]]
        );

        const deletedRows = await engine.deleteRows(
            'empty_row_history',
            [insertedRow.rowId]
        );
        await engine.undoModification({
            modificationType: 'row_delete',
            targetTable: 'empty_row_history',
            description: 'Delete empty-name column row',
            deletedRows
        });
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT "", normal FROM empty_row_history'
            ))[0].rows,
            [['empty-name', 7]]
        );
    });

    it('fails closed for legacy row history without storage guards', async () => {
        await engine.insertRow('users', { id: 3, name: 'legacy' });
        await assert.rejects(
            engine.undoModification({
                modificationType: 'row_insert',
                targetTable: 'users',
                targetRowId: 3,
                description: 'Legacy insert',
                rowData: { id: 3, name: 'legacy' }
            }),
            /predates guarded row history/i
        );
    });
});
