import './vscode_mock_setup';

import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations, ModificationEntry, RecordId } from '../../src/core/types';

describe('WITHOUT ROWID primary-key identity', () => {
    let engine: DatabaseOperations;

    beforeEach(async () => {
        const result = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        engine = result.operations!;
    });

    afterEach(() => {
        (engine as DatabaseOperations & { shutdown?: () => void }).shutdown?.();
    });

    it('edits a row identified by a TEXT primary key', async () => {
        await engine.executeQuery(
            "CREATE TABLE text_identity (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID; " +
            "INSERT INTO text_identity VALUES ('alpha', 'before')"
        );
        const metadata = (await engine.fetchSchema()).tables.find(
            table => table.identifier === 'text_identity'
        );
        assert.deepStrictEqual(metadata?.identity, {
            kind: 'primaryKey',
            columns: [{ identifier: 'key', declaredType: 'TEXT', position: 1 }]
        });

        const page = await engine.fetchTableData('text_identity', {
            columns: ['rowid', 'key', 'value'],
            limit: 10,
            offset: 0
        });
        const identity = page.rows[0][0] as RecordId;

        assert.match(String(identity), /^pk:/);
        const newIdentity = await engine.updateCell('text_identity', identity, 'value', 'after');
        assert.strictEqual(newIdentity, identity);
        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT key, value FROM text_identity'))[0].rows,
            [['alpha', 'after']]
        );
    });

    it('keeps a changed composite primary-key identity coherent through undo and redo', async () => {
        await engine.executeQuery(
            'CREATE TABLE composite_identity (' +
            'tenant TEXT, sequence REAL, value TEXT, PRIMARY KEY (tenant, sequence)' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO composite_identity VALUES ('north', 1.5, 'before')"
        );
        const page = await engine.fetchTableData('composite_identity', {
            columns: ['rowid', 'tenant', 'sequence', 'value'],
            limit: 10,
            offset: 0
        });
        const oldIdentity = page.rows[0][0] as RecordId;

        const affectedCells = await engine.updateCellBatch('composite_identity', [
            { rowId: oldIdentity, column: 'tenant', value: 'south' },
            { rowId: oldIdentity, column: 'sequence', value: 2.5 },
            { rowId: oldIdentity, column: 'value', value: 'after' }
        ]);
        const newIdentity = affectedCells[0].newRowId;
        assert.ok(newIdentity);
        assert.notStrictEqual(newIdentity, oldIdentity);
        assert.ok(affectedCells.every(cell => cell.newRowId === newIdentity));

        const modification: ModificationEntry = {
            description: 'Edit composite identity',
            modificationType: 'cell_update',
            targetTable: 'composite_identity',
            affectedCells
        };
        await engine.undoModification(modification);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT tenant, sequence, value FROM composite_identity'
            ))[0].rows,
            [['north', 1.5, 'before']]
        );

        await engine.redoModification(modification);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT tenant, sequence, value FROM composite_identity'
            ))[0].rows,
            [['south', 2.5, 'after']]
        );
    });

    it('keeps adjacent unsafe int64 primary keys distinct and editable', async () => {
        await engine.executeQuery(
            'CREATE TABLE int64_identity (id INTEGER PRIMARY KEY, value TEXT) WITHOUT ROWID; ' +
            "INSERT INTO int64_identity VALUES " +
            "(9007199254740992, 'lower'), (9007199254740993, 'higher')"
        );
        const page = await engine.fetchTableData('int64_identity', {
            columns: ['rowid', 'id', 'value'],
            orderBy: 'id',
            limit: 10,
            offset: 0
        });

        assert.strictEqual(page.exactIntegerTexts?.[1]?.[1], '9007199254740993');
        await engine.updateCell('int64_identity', page.rows[1][0] as RecordId, 'value', 'edited');
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT CAST(id AS TEXT), value FROM int64_identity ORDER BY id'
            ))[0].rows,
            [
                ['9007199254740992', 'lower'],
                ['9007199254740993', 'edited']
            ]
        );
    });

    it('returns primary-key identity for insert and restores a deleted row', async () => {
        await engine.executeQuery(
            'CREATE TABLE row_lifecycle (' +
            'namespace BLOB, key TEXT, value TEXT, PRIMARY KEY (namespace, key)' +
            ') WITHOUT ROWID'
        );
        const row = {
            namespace: new Uint8Array([0, 47, 255]),
            key: 'item/one',
            value: 'payload'
        };
        const identity = await engine.insertRow('row_lifecycle', row);
        assert.ok(identity);
        assert.match(String(identity), /^pk:/);

        const deletedRows = await engine.deleteRows('row_lifecycle', [identity]);
        assert.ok(deletedRows);
        assert.strictEqual(await engine.fetchTableCount('row_lifecycle', {}), 0);
        assert.deepStrictEqual(deletedRows, [{ rowId: identity, row }]);

        await engine.undoModification({
            description: 'Delete PK row',
            modificationType: 'row_delete',
            targetTable: 'row_lifecycle',
            deletedRows
        });
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT hex(namespace), key, value FROM row_lifecycle'
            ))[0].rows,
            [['002FFF', 'item/one', 'payload']]
        );

        await engine.redoModification({
            description: 'Delete PK row',
            modificationType: 'row_delete',
            targetTable: 'row_lifecycle',
            affectedRowIds: [identity]
        });
        assert.strictEqual(await engine.fetchTableCount('row_lifecycle', {}), 0);
    });

    it('loads and edits rowid-addressable FTS virtual and shadow tables', async () => {
        await engine.executeQuery(
            "CREATE VIRTUAL TABLE fts4_identity USING fts4(body); " +
            "INSERT INTO fts4_identity(body) VALUES ('before')"
        );

        const schemaSql: string[] = [];
        const originalExecuteQuery = engine.executeQuery.bind(engine);
        engine.executeQuery = async (sql, params) => {
            schemaSql.push(sql);
            return originalExecuteQuery(sql, params);
        };
        let schema;
        try {
            schema = await engine.fetchSchema();
        } finally {
            engine.executeQuery = originalExecuteQuery;
        }
        assert.strictEqual(
            schemaSql.filter(sql => sql.includes('pragma_table_list')).length,
            1
        );
        assert.strictEqual(
            schemaSql.filter(sql => /PRAGMA\s+(?:main\.)?table_info/i.test(sql)).length,
            0
        );
        const virtualTable = schema.tables.find(table => table.identifier === 'fts4_identity');
        const shadowTables = schema.tables.filter(table => table.identifier.startsWith('fts4_identity_'));
        assert.deepStrictEqual(virtualTable?.identity, { kind: 'rowid' });
        assert.ok(shadowTables.length > 0);
        assert.ok(shadowTables.every(table => table.identity?.kind === 'rowid'));

        const page = await engine.fetchTableData('fts4_identity', {
            columns: ['rowid', 'body'],
            limit: 10,
            offset: 0
        });
        await engine.updateCell('fts4_identity', page.rows[0][0] as RecordId, 'body', 'after');
        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT rowid, body FROM fts4_identity'))[0].rows,
            [[1, 'after']]
        );

        const contentShadow = shadowTables.find(table => table.identifier.endsWith('_content'));
        assert.ok(contentShadow);
        const shadowPage = await engine.fetchTableData(contentShadow.identifier, {
            columns: ['rowid', 'c0body'],
            limit: 10,
            offset: 0
        });
        await engine.updateCell(
            contentShadow.identifier,
            shadowPage.rows[0][0] as RecordId,
            'c0body',
            'shadow-after'
        );
        assert.strictEqual(
            (await engine.executeQuery(
                'SELECT c0body FROM fts4_identity_content WHERE rowid = ?',
                [shadowPage.rows[0][0]]
            ))[0].rows[0][0],
            'shadow-after'
        );
    });

    it('loads and edits an FTS5 virtual table when the bundled SQLite provides FTS5', async t => {
        try {
            await engine.executeQuery(
                "CREATE VIRTUAL TABLE fts5_identity USING fts5(body); " +
                "INSERT INTO fts5_identity(body) VALUES ('before')"
            );
        } catch (error) {
            if (/no such module: fts5/i.test(String(error))) {
                t.skip('bundled sql.js does not include FTS5');
                return;
            }
            throw error;
        }

        const schema = await engine.fetchSchema();
        assert.deepStrictEqual(
            schema.tables.find(table => table.identifier === 'fts5_identity')?.identity,
            { kind: 'rowid' }
        );
        const page = await engine.fetchTableData('fts5_identity', {
            columns: ['rowid', 'body'],
            limit: 10,
            offset: 0
        });
        await engine.updateCell('fts5_identity', page.rows[0][0] as RecordId, 'body', 'after');
        assert.strictEqual(
            (await engine.executeQuery('SELECT body FROM fts5_identity'))[0].rows[0][0],
            'after'
        );
    });

    it('inserts a row while omitting a default-generated BLOB primary key', async () => {
        await engine.executeQuery(
            'CREATE TABLE default_identity (' +
            'id BLOB PRIMARY KEY DEFAULT (randomblob(16)), value TEXT NOT NULL' +
            ') WITHOUT ROWID'
        );

        const identity = await engine.insertRow('default_identity', { value: 'payload' });

        assert.match(String(identity), /^pk:/);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT length(id), value FROM default_identity'
            ))[0].rows,
            [[16, 'payload']]
        );
    });

    it('bulk-deletes 1500 rows through a single-column primary key', async () => {
        await engine.executeQuery(
            'CREATE TABLE bulk_single (id INTEGER PRIMARY KEY, value TEXT) WITHOUT ROWID; ' +
            'WITH RECURSIVE rows(id) AS (' +
            'VALUES(1) UNION ALL SELECT id + 1 FROM rows WHERE id < 1500' +
            ') INSERT INTO bulk_single SELECT id, printf(\'value-%d\', id) FROM rows'
        );
        const page = await engine.fetchTableData('bulk_single', {
            columns: ['rowid', 'id', 'value'],
            orderBy: 'rowid',
            limit: 1500,
            offset: 0
        });

        const deleted = await engine.deleteRows(
            'bulk_single',
            page.rows.map(row => row[0] as RecordId)
        );

        assert.strictEqual(deleted?.length, 1500);
        assert.strictEqual(await engine.fetchTableCount('bulk_single', {}), 0);
    });

    it('bulk-deletes 1000 rows through a composite primary key', async () => {
        await engine.executeQuery(
            'CREATE TABLE bulk_composite (' +
            'tenant INTEGER, sequence INTEGER, value TEXT, ' +
            'PRIMARY KEY (tenant, sequence)' +
            ') WITHOUT ROWID; ' +
            'WITH RECURSIVE rows(id) AS (' +
            'VALUES(1) UNION ALL SELECT id + 1 FROM rows WHERE id < 1000' +
            ') INSERT INTO bulk_composite ' +
            'SELECT id % 7, id, printf(\'value-%d\', id) FROM rows'
        );
        const page = await engine.fetchTableData('bulk_composite', {
            columns: ['rowid', 'tenant', 'sequence', 'value'],
            orderBy: 'rowid',
            limit: 1000,
            offset: 0
        });

        const deleted = await engine.deleteRows(
            'bulk_composite',
            page.rows.map(row => row[0] as RecordId)
        );

        assert.strictEqual(deleted?.length, 1000);
        assert.strictEqual(await engine.fetchTableCount('bulk_composite', {}), 0);
    });
});
