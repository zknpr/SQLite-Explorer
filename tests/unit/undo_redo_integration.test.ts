
import { describe, it, before, beforeEach, after, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { createDatabaseEngine } from '../../src/core/sqlite-db';

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

    it('should undo/redo row deletion', async () => {
        // 1. Delete Row 2
        // Emulate HostBridge logic to capture data
        const rows = await engine.executeQuery("SELECT rowid, * FROM users WHERE rowid = 2");
        const deletedRowData = rows[0].rows[0]; // [2, 2, 'Bob'] (rowid, id, name)
        const headers = rows[0].headers; // ['id', 'id', 'name'] or ['rowid', 'id', 'name'] depending on engine

        // Manual mapping logic from HostBridge (simplified for test verification)
        const rowData = { id: 2, name: 'Bob' };

        await engine.deleteRows('users', [2]);

        const verifyGone = await engine.fetchTableCount('users', {});
        assert.strictEqual(verifyGone, 1);

        // 2. Undo Delete
        await engine.undoModification({
            modificationType: 'row_delete',
            targetTable: 'users',
            description: 'Delete row',
            deletedRows: [{ rowId: 2, row: rowData }]
        });

        const verifyRestored = await engine.fetchTableCount('users', {});
        assert.strictEqual(verifyRestored, 2);

        const restoredRow = await engine.executeQuery("SELECT name FROM users WHERE id = 2");
        assert.strictEqual(restoredRow[0].rows[0][0], 'Bob');

        // 3. Redo Delete
        await engine.redoModification({
            modificationType: 'row_delete',
            targetTable: 'users',
            description: 'Delete row',
            affectedRowIds: [2]
        });

        const verifyDeletedAgain = await engine.fetchTableCount('users', {});
        assert.strictEqual(verifyDeletedAgain, 1);
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

    it('should undo/redo cell update', async () => {
        // 1. Update Cell (id=1, name='Alice' -> 'Alice Updated')
        await engine.updateCell('users', 1, 'name', 'Alice Updated');

        const verifyUpdate = await engine.executeQuery("SELECT name FROM users WHERE id = 1");
        assert.strictEqual(verifyUpdate[0].rows[0][0], 'Alice Updated');

        // 2. Undo Update
        await engine.undoModification({
            modificationType: 'cell_update',
            targetTable: 'users',
            description: 'Update cell',
            affectedCells: [{ rowId: 1, columnName: 'name', priorValue: 'Alice', newValue: 'Alice Updated' }]
        });

        const verifyRestored = await engine.executeQuery("SELECT name FROM users WHERE id = 1");
        assert.strictEqual(verifyRestored[0].rows[0][0], 'Alice');

        // 3. Redo Update
        await engine.redoModification({
            modificationType: 'cell_update',
            targetTable: 'users',
            description: 'Update cell',
            affectedCells: [{ rowId: 1, columnName: 'name', priorValue: 'Alice', newValue: 'Alice Updated' }]
        });

        const verifyRedone = await engine.executeQuery("SELECT name FROM users WHERE id = 1");
        assert.strictEqual(verifyRedone[0].rows[0][0], 'Alice Updated');
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
        await engine.insertRow('users', row4);

        const countAfter = (await engine.executeQuery("SELECT COUNT(*) FROM users"))[0].rows[0][0] as number;
        assert.strictEqual(countAfter, countBefore + 1);

        // 2. Undo Insert
        await engine.undoModification({
            modificationType: 'row_insert',
            targetTable: 'users',
            description: 'Insert row',
            targetRowId: 4,
            rowData: row4
        });

        const countRestored = (await engine.executeQuery("SELECT COUNT(*) FROM users"))[0].rows[0][0] as number;
        assert.strictEqual(countRestored, countBefore);

        // 3. Redo Insert
        await engine.redoModification({
            modificationType: 'row_insert',
            targetTable: 'users',
            description: 'Insert row',
            targetRowId: 4,
            rowData: row4
        });

        const countRedone = (await engine.executeQuery("SELECT COUNT(*) FROM users"))[0].rows[0][0] as number;
        assert.strictEqual(countRedone, countBefore + 1);
    });
});
