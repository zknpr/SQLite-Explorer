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
});
