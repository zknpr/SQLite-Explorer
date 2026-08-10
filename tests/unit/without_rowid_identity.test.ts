import './vscode_mock_setup';

import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createDatabaseEngine } from '../../src/core/sqlite-db';
import { encodePrimaryKeyRecordId } from '../../src/core/row-identity';
import type {
    DatabaseOperations,
    ModificationEntry,
    PrimaryKeyColumn,
    RecordId
} from '../../src/core/types';

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

    it('marks a row read-only instead of encoding a truncated oversized primary key', async () => {
        await engine.executeQuery(
            "CREATE TABLE oversized_identity (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID; " +
            "INSERT INTO oversized_identity VALUES ('abcdefghijklmnopqrstuvwxyz012345', 'visible')"
        );
        const page = await engine.fetchTableData('oversized_identity', {
            columns: ['rowid', 'key', 'value'],
            limit: 1,
            offset: 0,
            maxInlineCellBytes: 8,
            maxPageResponseBytes: 64
        });
        const identity = page.rows[0][0] as RecordId;

        assert.match(String(identity), /^readonly-pk:/);
        assert.doesNotMatch(String(identity), /^pk:/);
        assert.strictEqual(page.rows[0][1], 'ab');
        assert.deepStrictEqual(page.oversizedCells, {
            0: { 1: { storageClass: 'text', byteLength: 32 } }
        });
        assert.match(
            page.readOnlyRowReasons?.[0] ?? '',
            /WITHOUT ROWID primary-key column "key".*32 bytes.*8-byte inline limit.*identity was not transported/
        );
        await assert.rejects(
            engine.updateCell('oversized_identity', identity, 'value', 'changed'),
            /WITHOUT ROWID primary-key column "key".*32 bytes.*identity was not transported/
        );
        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT value FROM oversized_identity'))[0].rows,
            [['visible']]
        );
    });

    it('orders a declared rowid column as data and keeps keyset pages in that order', async () => {
        await engine.executeQuery(
            'CREATE TABLE declared_rowid_order (' +
            'pk INTEGER PRIMARY KEY, rowid TEXT NOT NULL, value TEXT' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO declared_rowid_order VALUES " +
            "(1, 'zulu', 'one'), (2, 'alpha', 'two'), (3, 'alpha', 'three')"
        );
        const options = {
            columns: ['rowid', 'pk', 'rowid', 'value'],
            orderBy: 'rowid',
            orderDir: 'ASC' as const,
            limit: 2,
            offset: 0
        };

        const offsetPage = await engine.fetchTableData('declared_rowid_order', options);
        assert.deepStrictEqual(
            offsetPage.rows.map(row => [row[1], row[2]]),
            [[2, 'alpha'], [3, 'alpha']]
        );

        const first = await engine.fetchTableData('declared_rowid_order', {
            ...options,
            keyset: { mode: 'first' }
        });
        assert.deepStrictEqual(
            first.rows.map(row => [row[1], row[2]]),
            [[2, 'alpha'], [3, 'alpha']]
        );
        assert.ok(first.keysetAnchors?.last);
        const second = await engine.fetchTableData('declared_rowid_order', {
            ...options,
            offset: 2,
            keyset: { mode: 'after', anchor: first.keysetAnchors.last }
        });
        assert.deepStrictEqual(
            second.rows.map(row => [row[1], row[2]]),
            [[1, 'zulu']]
        );
    });

    it('round-trips signed infinite REAL primary keys while NaN remains unstorable', async () => {
        await engine.executeQuery(
            'CREATE TABLE infinite_real_identity (' +
            'key REAL PRIMARY KEY, value TEXT' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO infinite_real_identity VALUES " +
            "(-1e999, 'negative'), (1e999, 'positive')"
        );
        const options = {
            columns: ['rowid', 'key', 'value'],
            orderBy: 'key',
            orderDir: 'ASC' as const,
            limit: 1,
            offset: 0
        };

        const first = await engine.fetchTableData('infinite_real_identity', {
            ...options,
            keyset: { mode: 'first' }
        });
        assert.strictEqual(first.rows[0][1], Number.NEGATIVE_INFINITY);
        assert.match(String(first.rows[0][0]), /^pk:/);
        assert.ok(first.keysetAnchors?.last);
        const second = await engine.fetchTableData('infinite_real_identity', {
            ...options,
            offset: 1,
            keyset: { mode: 'after', anchor: first.keysetAnchors.last }
        });
        assert.strictEqual(second.rows[0][1], Number.POSITIVE_INFINITY);
        assert.match(String(second.rows[0][0]), /^pk:/);

        await engine.updateCell(
            'infinite_real_identity',
            second.rows[0][0] as RecordId,
            'value',
            'edited'
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT value FROM infinite_real_identity WHERE key = 1e999'
            ))[0].rows,
            [['edited']]
        );
        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT typeof(0.0/0.0), 0.0/0.0 IS NULL'))[0].rows,
            [['null', 1]]
        );
        await assert.rejects(
            engine.executeQuery(
                "INSERT INTO infinite_real_identity VALUES (0.0/0.0, 'nan')"
            ),
            /NOT NULL constraint failed/
        );
    });

    it('keeps malformed UTF-8 TEXT identities viewable but read-only', async () => {
        await engine.executeQuery(
            'CREATE TABLE malformed_text_identity (' +
            'key TEXT PRIMARY KEY, value TEXT' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO malformed_text_identity VALUES " +
            "(CAST(X'80' AS TEXT), 'malformed'), " +
            "(CAST(X'EFBFBD' AS TEXT), 'replacement-character')"
        );
        const page = await engine.fetchTableData('malformed_text_identity', {
            columns: ['rowid', 'key', 'value'],
            limit: 10,
            offset: 0,
            keyset: { mode: 'first' }
        });
        const malformedIndex = page.rows.findIndex(row => row[2] === 'malformed');
        const validIndex = page.rows.findIndex(row => row[2] === 'replacement-character');
        assert.notStrictEqual(malformedIndex, -1);
        assert.notStrictEqual(validIndex, -1);
        const malformedIdentity = page.rows[malformedIndex][0] as RecordId;
        const validIdentity = page.rows[validIndex][0] as RecordId;

        assert.match(String(malformedIdentity), /^readonly-pk:/);
        assert.match(String(validIdentity), /^pk:/);
        assert.notStrictEqual(malformedIdentity, validIdentity);
        assert.match(page.readOnlyRowReasons?.[malformedIndex] ?? '', /not valid UTF-8/i);
        if (malformedIndex === 0) assert.strictEqual(page.keysetAnchors?.first, undefined);
        if (malformedIndex === page.rows.length - 1) {
            assert.strictEqual(page.keysetAnchors?.last, undefined);
        }

        await assert.rejects(
            engine.updateCell('malformed_text_identity', malformedIdentity, 'value', 'bad-edit'),
            /not valid UTF-8/i
        );
        await engine.updateCell(
            'malformed_text_identity',
            validIdentity,
            'value',
            'valid-edit'
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT hex(CAST(key AS BLOB)), value FROM malformed_text_identity ORDER BY 1'
            ))[0].rows,
            [['80', 'malformed'], ['EFBFBD', 'valid-edit']]
        );
    });

    it('suppresses keyset anchors for malformed ordinary TEXT sort keys', async () => {
        await engine.executeQuery(
            'CREATE TABLE malformed_text_sort (' +
            'id INTEGER PRIMARY KEY, sort_value TEXT NOT NULL' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO malformed_text_sort VALUES " +
            "(1, CAST(X'80' AS TEXT)), " +
            "(2, CAST(X'C0' AS TEXT)), " +
            "(3, CAST(X'EFBFBD' AS TEXT))"
        );
        const options = {
            columns: ['rowid', 'id', 'sort_value'],
            orderBy: 'sort_value',
            orderDir: 'ASC' as const,
            limit: 1,
            offset: 0
        };

        const first = await engine.fetchTableData('malformed_text_sort', {
            ...options,
            keyset: { mode: 'first' }
        });
        assert.strictEqual(first.rows[0][1], 1);
        assert.strictEqual(first.keysetAnchors, undefined);
        const offsetSecond = await engine.fetchTableData('malformed_text_sort', {
            ...options,
            offset: 1
        });
        assert.strictEqual(offsetSecond.rows[0][1], 2);
        assert.strictEqual(offsetSecond.keysetAnchors, undefined);
    });

    it('treats a leading UTF-8 BOM as identity-significant bytes', async () => {
        await engine.executeQuery(
            'CREATE TABLE bom_text_identity (' +
            'key TEXT PRIMARY KEY, value TEXT' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO bom_text_identity VALUES " +
            "(CAST(X'EFBBBF41' AS TEXT), 'bom'), ('A', 'plain')"
        );
        const page = await engine.fetchTableData('bom_text_identity', {
            columns: ['rowid', 'key', 'value'],
            limit: 10,
            offset: 0
        });
        const bomRow = page.rows.find(row => row[2] === 'bom');
        const plainRow = page.rows.find(row => row[2] === 'plain');
        assert.ok(bomRow && plainRow);
        assert.match(String(bomRow[0]), /^readonly-pk:/);
        assert.match(String(plainRow[0]), /^pk:/);
        assert.notStrictEqual(bomRow[0], plainRow[0]);
        await assert.rejects(
            engine.updateCell('bom_text_identity', bomRow[0] as RecordId, 'value', 'wrong'),
            /byte-faithful|stored bytes/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT hex(CAST(key AS BLOB)), value FROM bom_text_identity ORDER BY 1'
            ))[0].rows,
            [['41', 'plain'], ['EFBBBF41', 'bom']]
        );
    });

    it('rolls back an insert whose generated TEXT key cannot mint a byte-faithful identity', async () => {
        await engine.executeQuery(
            'CREATE TABLE generated_malformed_identity (' +
            "key TEXT PRIMARY KEY DEFAULT (CAST(X'80' AS TEXT)), value TEXT" +
            ') WITHOUT ROWID; ' +
            "INSERT INTO generated_malformed_identity(key, value) " +
            "VALUES (CAST(X'EFBFBD' AS TEXT), 'existing-valid')"
        );

        await assert.rejects(
            engine.insertRow('generated_malformed_identity', { value: 'must-rollback' }),
            /byte-faithful editable identity cannot be minted/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT hex(CAST(key AS BLOB)), value FROM generated_malformed_identity'
            ))[0].rows,
            [['EFBFBD', 'existing-valid']]
        );
    });

    it('keeps a 1000-column composite key viewable with bounded read-only identities', async () => {
        const columns = Array.from({ length: 1000 }, (_, index) => `c${index}`);
        await engine.executeQuery(
            `CREATE TABLE wide_composite_identity (` +
            columns.map((column, index) => `"${column}" TEXT DEFAULT 'v${index}'`).join(', ') +
            `, PRIMARY KEY (${columns.map(column => `"${column}"`).join(', ')})) WITHOUT ROWID; ` +
            'INSERT INTO wide_composite_identity DEFAULT VALUES'
        );

        const page = await engine.fetchTableData('wide_composite_identity', {
            columns: ['rowid', ...columns],
            limit: 1,
            offset: 0,
            keyset: { mode: 'first' }
        });

        assert.strictEqual(page.headers.length, 1001);
        assert.strictEqual(page.rows[0].length, 1001);
        assert.match(String(page.rows[0][0]), /^readonly-pk:/);
        assert.match(page.readOnlyRowReasons?.[0] ?? '', /result-column limit/i);
        assert.strictEqual(page.keysetAnchors, undefined);
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

    it('fails clearly and rolls back when an UPDATE trigger rewrites the primary key', async () => {
        await engine.executeQuery(
            'CREATE TABLE trigger_rekey_identity (' +
            'tenant TEXT, sequence INTEGER, value TEXT, PRIMARY KEY (tenant, sequence)' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO trigger_rekey_identity VALUES ('north', 1, 'before'); " +
            'CREATE TRIGGER trigger_rekey_identity_after ' +
            'AFTER UPDATE OF value ON trigger_rekey_identity BEGIN ' +
            'UPDATE trigger_rekey_identity SET sequence = sequence + 1 ' +
            'WHERE tenant = NEW.tenant AND sequence = NEW.sequence; END'
        );
        const page = await engine.fetchTableData('trigger_rekey_identity', {
            columns: ['rowid', 'tenant', 'sequence', 'value'],
            limit: 1,
            offset: 0
        });

        await assert.rejects(
            engine.updateCell(
                'trigger_rekey_identity',
                page.rows[0][0] as RecordId,
                'value',
                'after'
            ),
            /UPDATE trigger changed or removed.*primary-key identity.*rolled back.*cannot safely identify/is
        );
        await assert.rejects(
            engine.replaceOversizedCell(
                'trigger_rekey_identity',
                page.rows[0][0] as RecordId,
                'value',
                'after',
                { storageClass: 'text', byteLength: 6 },
                5
            ),
            /UPDATE trigger changed or removed.*primary-key identity.*rolled back.*cannot safely identify/is
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT tenant, sequence, value FROM trigger_rekey_identity'
            ))[0].rows,
            [['north', 1, 'before']]
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

    it('undoes dependent composite-key changes in reverse transition order', async () => {
        await engine.executeQuery(
            'CREATE TABLE dependent_identity (' +
            'tenant INTEGER, sequence INTEGER, value TEXT, ' +
            'PRIMARY KEY (tenant, sequence)' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO dependent_identity VALUES (1, 1, 'first'), (1, 2, 'second')"
        );
        const page = await engine.fetchTableData('dependent_identity', {
            columns: ['rowid', 'tenant', 'sequence', 'value'],
            orderBy: 'sequence',
            limit: 10,
            offset: 0
        });

        const affectedCells = await engine.updateCellBatch('dependent_identity', [
            { rowId: page.rows[0][0] as RecordId, column: 'tenant', value: 2 },
            { rowId: page.rows[1][0] as RecordId, column: 'sequence', value: 1 }
        ]);
        await engine.undoModification({
            description: 'Undo dependent composite identities',
            modificationType: 'cell_update',
            targetTable: 'dependent_identity',
            affectedCells
        });

        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT tenant, sequence, value FROM dependent_identity ORDER BY sequence'
            ))[0].rows,
            [[1, 1, 'first'], [1, 2, 'second']]
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

    it('targets an unsafe INTEGER stored in a typeless primary key across record operations', async () => {
        await engine.executeQuery(
            'CREATE TABLE typeless_integer_identity (' +
            'id, shard TEXT, value TEXT, payload BLOB, PRIMARY KEY (id, shard)' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO typeless_integer_identity VALUES " +
            "(9007199254740993, 'a', 'before', X'01020304')"
        );
        const page = await engine.fetchTableData('typeless_integer_identity', {
            columns: ['rowid', 'id', 'shard', 'value', 'payload'],
            limit: 10,
            offset: 0
        });
        const identity = page.rows[0][0] as RecordId;

        const metadata = await engine.getCellMetadata({
            table: 'typeless_integer_identity',
            rowId: identity,
            column: 'value'
        });
        assert.deepStrictEqual(metadata, {
            storageClass: 'text',
            byteLength: 6,
            textEncoding: 'utf-8'
        });
        const session = await engine.openCellReadSession({
            table: 'typeless_integer_identity',
            rowId: identity,
            column: 'value'
        });
        await engine.closeCellReadSession(session.sessionId);

        const replacementIdentity = await engine.replaceOversizedCell(
            'typeless_integer_identity',
            identity,
            'payload',
            new Uint8Array([9]),
            { storageClass: 'blob', byteLength: 4 },
            2
        );
        assert.strictEqual(replacementIdentity, identity);

        await engine.updateCell(
            'typeless_integer_identity',
            identity,
            'value',
            'after'
        );
        const changedIdentity = await engine.updateCell(
            'typeless_integer_identity',
            identity,
            'shard',
            'b'
        );
        if (changedIdentity === undefined) {
            throw new Error('Primary-key update did not return the changed identity');
        }
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT typeof(id), CAST(id AS TEXT), shard, value, hex(payload) ' +
                'FROM typeless_integer_identity'
            ))[0].rows,
            [['integer', '9007199254740993', 'b', 'after', '09']]
        );

        const deleted = await engine.deleteRows('typeless_integer_identity', [changedIdentity]);
        assert.strictEqual(deleted?.length, 1);
        assert.deepStrictEqual(
            await engine.fetchTableCount('typeless_integer_identity', {}),
            { count: 0, isExact: true }
        );

        await engine.executeQuery(
            'CREATE TABLE strict_any_identity (id ANY PRIMARY KEY, value TEXT) ' +
            'STRICT, WITHOUT ROWID; ' +
            "INSERT INTO strict_any_identity VALUES (9007199254740993, 'strict')"
        );
        const strictPage = await engine.fetchTableData('strict_any_identity', {
            columns: ['rowid', 'id', 'value'],
            limit: 10,
            offset: 0
        });
        assert.deepStrictEqual(await engine.getCellMetadata({
            table: 'strict_any_identity',
            rowId: strictPage.rows[0][0] as RecordId,
            column: 'value'
        }), {
            storageClass: 'text',
            byteLength: 6,
            textEncoding: 'utf-8'
        });
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
        assert.deepStrictEqual(
            await engine.fetchTableCount('row_lifecycle', {}),
            { count: 0, isExact: true }
        );
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
        assert.deepStrictEqual(
            await engine.fetchTableCount('row_lifecycle', {}),
            { count: 0, isExact: true }
        );
    });

    it('restores a deleted WITHOUT ROWID row without inserting generated columns', async () => {
        await engine.executeQuery(
            'CREATE TABLE generated_pk_row (' +
            'id INTEGER PRIMARY KEY, base INTEGER, ' +
            'stored_value INTEGER GENERATED ALWAYS AS (base * 2) STORED, ' +
            'virtual_value INTEGER GENERATED ALWAYS AS (base * 3) VIRTUAL' +
            ') WITHOUT ROWID; ' +
            'INSERT INTO generated_pk_row (id, base) VALUES (7, 5)'
        );
        const page = await engine.fetchTableData('generated_pk_row', {
            columns: ['rowid', 'id', 'base', 'stored_value', 'virtual_value'],
            limit: 10,
            offset: 0
        });
        const rowId = page.rows[0][0] as RecordId;
        const deletedRows = await engine.deleteRows('generated_pk_row', [rowId]);
        assert.ok(deletedRows);

        await engine.undoModification({
            description: 'Restore generated PK row',
            modificationType: 'row_delete',
            targetTable: 'generated_pk_row',
            deletedRows
        });

        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT id, base, stored_value, virtual_value FROM generated_pk_row'
            ))[0].rows,
            [[7, 5, 10, 15]]
        );
    });

    it('restores a deleted rowid row without inserting generated columns', async () => {
        await engine.executeQuery(
            'CREATE TABLE generated_rowid_row (' +
            'base INTEGER, ' +
            'stored_value INTEGER GENERATED ALWAYS AS (base * 2) STORED, ' +
            'virtual_value INTEGER GENERATED ALWAYS AS (base * 3) VIRTUAL' +
            '); ' +
            'INSERT INTO generated_rowid_row (rowid, base) VALUES (9, 5)'
        );
        const deletedRows = await engine.deleteRows('generated_rowid_row', [9]);
        assert.ok(deletedRows);

        await engine.undoModification({
            description: 'Restore generated rowid row',
            modificationType: 'row_delete',
            targetTable: 'generated_rowid_row',
            deletedRows
        });

        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT rowid, base, stored_value, virtual_value FROM generated_rowid_row'
            ))[0].rows,
            [[9, 5, 10, 15]]
        );
    });

    it('refuses an oversized delete before materializing its exact undo snapshot', async () => {
        await engine.executeQuery(
            'CREATE TABLE oversized_delete_history (payload BLOB); ' +
            'INSERT INTO oversized_delete_history(rowid, payload) VALUES (1, zeroblob(2097152))'
        );

        await assert.rejects(
            (engine.deleteRows as unknown as (
                table: string,
                rowIds: RecordId[],
                maxUndoSnapshotBytes: number
            ) => Promise<unknown>)('oversized_delete_history', [1], 1024),
            /delete.*undo.*memory|undo.*snapshot.*budget/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT count(*) FROM oversized_delete_history'))[0].rows,
            [[1]]
        );
    });

    it('preserves an unsafe INTEGER prior storage class when undoing a typeless cell', async () => {
        await engine.executeQuery(
            'CREATE TABLE typeless_undo (' +
            'id INTEGER PRIMARY KEY, value' +
            ') WITHOUT ROWID; ' +
            'INSERT INTO typeless_undo VALUES (1, 9007199254740993)'
        );
        const page = await engine.fetchTableData('typeless_undo', {
            columns: ['rowid', 'id', 'value'],
            limit: 10,
            offset: 0
        });
        const affectedCells = await engine.updateCellBatch('typeless_undo', [{
            rowId: page.rows[0][0] as RecordId,
            column: 'value',
            value: 'changed'
        }]);
        assert.strictEqual(typeof affectedCells[0].priorValue, 'bigint');

        await engine.undoModification({
            description: 'Restore unsafe typeless INTEGER',
            modificationType: 'cell_update',
            targetTable: 'typeless_undo',
            affectedCells
        });

        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT typeof(value), CAST(value AS TEXT) FROM typeless_undo'
            ))[0].rows,
            [['integer', '9007199254740993']]
        );
    });

    it('preserves an unsafe INTEGER storage class when restoring a deleted typeless row', async () => {
        await engine.executeQuery(
            'CREATE TABLE typeless_restore (value); ' +
            'INSERT INTO typeless_restore (rowid, value) VALUES (11, 9007199254740993)'
        );
        const deletedRows = await engine.deleteRows('typeless_restore', [11]);
        assert.ok(deletedRows);
        assert.strictEqual(typeof deletedRows[0].row.value, 'bigint');

        await engine.undoModification({
            description: 'Restore deleted unsafe typeless INTEGER',
            modificationType: 'row_delete',
            targetTable: 'typeless_restore',
            deletedRows
        });

        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT rowid, typeof(value), CAST(value AS TEXT) FROM typeless_restore'
            ))[0].rows,
            [[11, 'integer', '9007199254740993']]
        );
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
        assert.deepStrictEqual(
            await engine.fetchTableCount('bulk_single', {}),
            { count: 0, isExact: true }
        );
    });

    it('chunks a rowid delete above the SQLite bind limit atomically', async () => {
        await engine.executeQuery(
            'CREATE TABLE bulk_rowid_delete (value INTEGER); ' +
            'WITH RECURSIVE ids(value) AS (' +
            'VALUES(1) UNION ALL SELECT value + 1 FROM ids WHERE value < 32768' +
            ') INSERT INTO bulk_rowid_delete SELECT value FROM ids'
        );
        const rowIds = Array.from({ length: 32_768 }, (_, index) => index + 1);

        await assert.rejects(
            engine.deleteRows('bulk_rowid_delete', [...rowIds, 32_769]),
            /one or more row identities no longer exist/
        );
        assert.deepStrictEqual(
            await engine.fetchTableCount('bulk_rowid_delete', {}),
            { count: 32_768, isExact: true },
            'a missing identity in the final chunk must leave every row intact'
        );

        const deleted = await engine.deleteRows('bulk_rowid_delete', rowIds);
        assert.strictEqual(deleted?.length, 32_768);
        assert.strictEqual(new Set(deleted?.map(row => String(row.rowId))).size, 32_768);
        assert.deepStrictEqual(
            await engine.fetchTableCount('bulk_rowid_delete', {}),
            { count: 0, isExact: true }
        );
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
        assert.deepStrictEqual(
            await engine.fetchTableCount('bulk_composite', {}),
            { count: 0, isExact: true }
        );
    });

    it('chunks a 5000-row seven-column primary-key delete atomically below the bind limit', async () => {
        const keyColumns: PrimaryKeyColumn[] = Array.from(
            { length: 7 },
            (_, index) => ({
                identifier: `k${index + 1}`,
                declaredType: 'INTEGER',
                position: index + 1
            })
        );
        await engine.executeQuery(
            'CREATE TABLE bulk_wide_composite (' +
            keyColumns.map(column => `"${column.identifier}" INTEGER`).join(', ') +
            ', value TEXT, PRIMARY KEY (' +
            keyColumns.map(column => `"${column.identifier}"`).join(', ') +
            ')) WITHOUT ROWID; ' +
            'WITH RECURSIVE rows(id) AS (' +
            'VALUES(1) UNION ALL SELECT id + 1 FROM rows WHERE id < 5000' +
            ') INSERT INTO bulk_wide_composite SELECT ' +
            [...keyColumns.map(() => 'id'), "printf('value-%d', id)"].join(', ') +
            ' FROM rows'
        );
        const identityFor = (id: number) => encodePrimaryKeyRecordId(
            keyColumns,
            keyColumns.map(() => BigInt(id))
        );
        const rowIds = Array.from({ length: 5000 }, (_, index) => identityFor(index + 1));

        await assert.rejects(
            engine.deleteRows(
                'bulk_wide_composite',
                [...rowIds.slice(0, 4680), rowIds[0]]
            ),
            /Duplicate row identities are not allowed/
        );
        assert.deepStrictEqual(
            await engine.fetchTableCount('bulk_wide_composite', {}),
            { count: 5000, isExact: true },
            'a duplicate identity crossing a chunk boundary must be rejected atomically'
        );

        await assert.rejects(
            engine.deleteRows('bulk_wide_composite', [...rowIds, identityFor(5001)]),
            /one or more row identities no longer exist/
        );
        assert.deepStrictEqual(
            await engine.fetchTableCount('bulk_wide_composite', {}),
            { count: 5000, isExact: true },
            'a missing identity in a later chunk must roll back earlier chunk deletions'
        );

        const deleted = await engine.deleteRows('bulk_wide_composite', rowIds);
        assert.strictEqual(deleted?.length, 5000);
        assert.deepStrictEqual(
            await engine.fetchTableCount('bulk_wide_composite', {}),
            { count: 0, isExact: true }
        );
    });
});
