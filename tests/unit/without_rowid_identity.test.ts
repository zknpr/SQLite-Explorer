import './vscode_mock_setup';

import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createDatabaseEngine } from '../../src/core/sqlite-db';
import {
    buildRecordIdentitiesPredicate,
    buildRecordIdentityPredicate,
    encodePrimaryKeyRecordId
} from '../../src/core/row-identity';
import { streamTableExport } from '../../src/tableExporter';
import type {
    DatabaseOperations,
    ModificationEntry,
    PrimaryKeyColumn,
    RecordId
} from '../../src/core/types';

/**
 * A database whose stored values do not follow the declared column types
 * or collations.
 */
async function createRedeclaredEngine(
    setupSql: string,
    redeclarations: readonly [table: string, createSql: string][]
): Promise<DatabaseOperations> {
    const seed = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations!;
    await seed.executeQuery(setupSql);
    await seed.executeQuery('PRAGMA writable_schema = ON');
    for (const [table, createSql] of redeclarations) {
        await seed.executeQuery('UPDATE sqlite_schema SET sql = ? WHERE name = ?', [createSql, table]);
    }
    await seed.executeQuery('PRAGMA writable_schema = OFF');
    return (await createDatabaseEngine({
        content: await seed.serializeDatabase(),
        maxSize: 0,
        readOnlyMode: false
    })).operations!;
}

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

    it('keeps TEXT identities containing NUL read-only with a reason that names the NUL', async () => {
        await engine.executeQuery(
            'CREATE TABLE nul_text_identity (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID; ' +
            "INSERT INTO nul_text_identity VALUES (CAST(X'610062' AS TEXT), 'nul'), ('plain', 'plain')"
        );
        const page = await engine.fetchTableData('nul_text_identity', {
            columns: ['rowid', 'key', 'value'],
            limit: 10,
            offset: 0
        });
        const nulIndex = page.rows.findIndex(row => row[2] === 'nul');
        assert.notStrictEqual(nulIndex, -1);
        assert.match(String(page.rows[nulIndex][0]), /^readonly-pk:/);
        const reason = page.readOnlyRowReasons?.[nulIndex] ?? '';
        assert.match(reason, /NUL character/);
        assert.doesNotMatch(reason, /inline limit/);

        await assert.rejects(
            engine.insertRow('nul_text_identity', { key: 'b\0c', value: 'must-rollback' }),
            /NUL character/
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT hex(CAST(key AS BLOB)) FROM nul_text_identity ORDER BY 1'
            ))[0].rows,
            [['610062'], ['706C61696E']]
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
            columns: [{ identifier: 'key', declaredType: 'TEXT', position: 1, collation: 'BINARY' }]
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

    it('enumerates and loads tables that shadow PRAGMA virtual-table names', async () => {
        await engine.executeQuery(
            'CREATE TABLE pragma_shadow_target (id INTEGER PRIMARY KEY, value TEXT); ' +
            "INSERT INTO pragma_shadow_target VALUES (1, 'before'); " +
            'CREATE TABLE pragma_table_info (dummy TEXT)'
        );

        const infoShadowSchema = await engine.fetchSchema();
        assert.ok(
            infoShadowSchema.tables.some(table => table.identifier === 'pragma_shadow_target')
        );

        await engine.executeQuery(
            'CREATE TABLE pragma_table_list (dummy TEXT); ' +
            'CREATE TABLE pragma_table_xinfo (dummy TEXT)'
        );
        const fullyShadowedSchema = await engine.fetchSchema();
        const identifiers = new Set(
            fullyShadowedSchema.tables.map(table => table.identifier)
        );
        for (const table of [
            'pragma_shadow_target',
            'pragma_table_info',
            'pragma_table_list',
            'pragma_table_xinfo'
        ]) {
            assert.ok(identifiers.has(table), `schema omitted ${table}`);
        }

        const page = await engine.fetchTableData('pragma_shadow_target', {
            columns: ['rowid', 'id', 'value'],
            limit: 10,
            offset: 0
        });
        assert.deepStrictEqual(page.rows, [[1, 1, 'before']]);

        await engine.insertRow('pragma_shadow_target', { value: 'after' });
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT id, value FROM pragma_shadow_target ORDER BY id'
            ))[0].rows,
            [[1, 'before'], [2, 'after']]
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
                /UPDATE trigger changed or removed.*primary-key identity.*target table.*rolled back/is
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
            /UPDATE trigger changed or removed.*primary-key identity.*target table.*rolled back/is
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

    it('returns an exact unsafe auto-rowid and undoes only that inserted row', async () => {
        await engine.executeQuery(
            'CREATE TABLE unsafe_auto_rowid (value TEXT); ' +
            "INSERT INTO unsafe_auto_rowid(rowid, value) VALUES " +
            "(9007199254740991, 'lower'), (9007199254740992, 'upper')"
        );

        const insertedRow = await engine.insertRowWithHistory!(
            'unsafe_auto_rowid',
            { value: 'inserted' }
        );
        assert.strictEqual(insertedRow.rowId, '9007199254740993');

        await engine.undoModification({
            description: 'Undo unsafe auto-rowid insert',
            modificationType: 'row_insert',
            targetTable: 'unsafe_auto_rowid',
            targetRowId: insertedRow.rowId,
            rowData: insertedRow.row,
            insertedRow
        });
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT CAST(rowid AS TEXT), value FROM unsafe_auto_rowid ORDER BY rowid'
            ))[0].rows,
            [
                ['9007199254740991', 'lower'],
                ['9007199254740992', 'upper']
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

    it('refuses an INTEGER identity whose column was later declared TEXT, beside its TEXT twin', async () => {
        // The fixture holds INTEGER 1 and TEXT '1' in a column declared TEXT.
        // Each identity must name only its own row.
        const seed = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations!;
        await seed.executeQuery(
            'CREATE TABLE crafted (k PRIMARY KEY, v TEXT) WITHOUT ROWID; ' +
            "INSERT INTO crafted VALUES (1, 'integer'), ('1', 'text'), (2, 'other')"
        );
        await seed.executeQuery('PRAGMA writable_schema = ON');
        await seed.executeQuery(
            "UPDATE sqlite_schema SET sql = 'CREATE TABLE crafted (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID' " +
            "WHERE name = 'crafted'"
        );
        await seed.executeQuery('PRAGMA writable_schema = OFF');
        const crafted = (await createDatabaseEngine({
            content: await seed.serializeDatabase(),
            maxSize: 0,
            readOnlyMode: false
        })).operations!;
        const rows = async () => (await crafted.executeQuery('SELECT typeof(k), v FROM crafted'))[0].rows;
        const stored = [['integer', 'integer'], ['integer', 'other'], ['text', 'text']];
        assert.deepStrictEqual(await rows(), stored);
        const page = await crafted.fetchTableData('crafted', { columns: ['rowid', 'k', 'v'], limit: 10, offset: 0 });
        const integerRow = page.rows.find(row => row[2] === 'integer');
        assert.ok(integerRow, 'the INTEGER row is on the page');
        const integerKey = integerRow[0] as RecordId;

        await assert.rejects(() => crafted.updateCell('crafted', integerKey, 'v', 'edited'));
        await assert.rejects(() => crafted.updateCellBatch('crafted', [{ rowId: integerKey, column: 'v', value: 'edited' }]));
        await assert.rejects(() => crafted.getCellMetadata({ table: 'crafted', rowId: integerKey, column: 'v' }));
        assert.deepStrictEqual(await rows(), stored);
    });

    it('refuses multi-row operations whose INTEGER identity names a row in a column later declared TEXT', async () => {
        // The fixture of the test above, for the forms that address several
        // rows at once: the IN list, the row-value IN and the selected-row
        // export join.
        const seed = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations!;
        await seed.executeQuery(
            'CREATE TABLE crafted (k PRIMARY KEY, v TEXT) WITHOUT ROWID; ' +
            "INSERT INTO crafted VALUES (1, 'integer'), ('1', 'text'), ('2', 'other'); " +
            'CREATE TABLE crafted_pair (a, b, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID; ' +
            "INSERT INTO crafted_pair VALUES (1, 5, 'integer'), ('1', 5, 'text'), ('2', 5, 'other'); " +
            'CREATE TABLE crafted_restore (k PRIMARY KEY, v TEXT) WITHOUT ROWID; ' +
            "INSERT INTO crafted_restore VALUES (1, 'integer'), ('1', 'text')"
        );
        const restorePage = await seed.fetchTableData('crafted_restore', {
            columns: ['rowid', 'k', 'v'],
            limit: 10,
            offset: 0
        });
        const deletedRows = await seed.deleteRows(
            'crafted_restore',
            [restorePage.rows.find(row => row[2] === 'integer')![0] as RecordId]
        );
        assert.strictEqual(deletedRows.length, 1);
        await seed.executeQuery('PRAGMA writable_schema = ON');
        for (const [table, sql] of [
            ['crafted', 'CREATE TABLE crafted (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID'],
            ['crafted_pair', 'CREATE TABLE crafted_pair (a TEXT, b, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID'],
            ['crafted_restore', 'CREATE TABLE crafted_restore (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID']
        ]) {
            await seed.executeQuery('UPDATE sqlite_schema SET sql = ? WHERE name = ?', [sql, table]);
        }
        await seed.executeQuery('PRAGMA writable_schema = OFF');
        const crafted = (await createDatabaseEngine({
            content: await seed.serializeDatabase(),
            maxSize: 0,
            readOnlyMode: false
        })).operations!;
        const stored = async (table: string) => (await crafted.executeQuery(
            `SELECT typeof(${table === 'crafted_pair' ? 'a' : 'k'}), v FROM ${table} ORDER BY v`
        ))[0].rows;
        const identityOf = async (table: string, columns: string[], label: string) => {
            const page = await crafted.fetchTableData(table, { columns: ['rowid', ...columns], limit: 10, offset: 0 });
            const row = page.rows.find(candidate => candidate[columns.length] === label);
            assert.ok(row, `${table}: no row labelled ${label}`);
            return row[0] as RecordId;
        };
        const exportSelected = async (table: string, rowIds: RecordId[]) => {
            const chunks: string[] = [];
            await streamTableExport(crafted, table, ['v'], { format: 'csv', rowIds }, {
                write: async chunk => { chunks.push(chunk); }
            });
            return chunks.join('');
        };
        const before = {
            crafted: await stored('crafted'),
            crafted_pair: await stored('crafted_pair'),
            crafted_restore: await stored('crafted_restore')
        };
        assert.deepStrictEqual(before.crafted, [['integer', 'integer'], ['text', 'other'], ['text', 'text']]);

        for (const [table, columns] of [['crafted', ['k', 'v']], ['crafted_pair', ['a', 'b', 'v']]] as const) {
            const integerKey = await identityOf(table, [...columns], 'integer');
            const otherKey = await identityOf(table, [...columns], 'other');
            assert.strictEqual(await exportSelected(table, [integerKey]), 'v');
            await assert.rejects(() => crafted.deleteRows(table, [integerKey]));
            await assert.rejects(() => crafted.deleteRows(table, [integerKey, otherKey]));
            assert.deepStrictEqual(await stored(table), before[table]);
        }

        // Restoring the deleted INTEGER row would turn it into TEXT '1'.
        await assert.rejects(() => crafted.undoModification({
            description: 'Restore the INTEGER row',
            modificationType: 'row_delete',
            targetTable: 'crafted_restore',
            deletedRows
        }));
        assert.deepStrictEqual(await stored('crafted_restore'), before.crafted_restore);

        // A TEXT identity still names its own row.
        await crafted.deleteRows('crafted', [await identityOf('crafted', ['k', 'v'], 'text')]);
        assert.deepStrictEqual(await stored('crafted'), [['integer', 'integer'], ['text', 'other']]);
    });

    it('refuses a REAL identity whose column was later declared TEXT, beside its TEXT twin', async () => {
        // A REAL identity binds as a number, which a column declared TEXT
        // compares as text. Each identity must name only its own row.
        const seed = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations!;
        await seed.executeQuery(
            'CREATE TABLE crafted (k PRIMARY KEY, v TEXT) WITHOUT ROWID; ' +
            "INSERT INTO crafted VALUES (1.0, 'real'), ('1', 'text'), (2.5, 'real-fraction'), ('2.5', 'text-fraction'); " +
            'CREATE TABLE crafted_pair (a, b, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID; ' +
            "INSERT INTO crafted_pair VALUES (1.0, 'x', 'real'), ('1', 'x', 'text')"
        );
        await seed.executeQuery('PRAGMA writable_schema = ON');
        await seed.executeQuery(
            "UPDATE sqlite_schema SET sql = 'CREATE TABLE crafted (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID' " +
            "WHERE name = 'crafted'"
        );
        await seed.executeQuery(
            "UPDATE sqlite_schema SET sql = 'CREATE TABLE crafted_pair (a TEXT, b, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID' " +
            "WHERE name = 'crafted_pair'"
        );
        await seed.executeQuery('PRAGMA writable_schema = OFF');
        const crafted = (await createDatabaseEngine({
            content: await seed.serializeDatabase(),
            maxSize: 0,
            readOnlyMode: false
        })).operations!;
        for (const [table, columns, labels] of [
            ['crafted', ['k', 'v'], ['real', 'real-fraction']],
            ['crafted_pair', ['a', 'b', 'v'], ['real']]
        ] as const) {
            const stored = async () => (await crafted.executeQuery(
                `SELECT typeof(${columns[0]}), v FROM ${table} ORDER BY v`
            ))[0].rows;
            const before = await stored();
            const page = await crafted.fetchTableData(table, { columns: ['rowid', ...columns], limit: 10, offset: 0 });
            for (const label of labels) {
                const realKey = page.rows.find(row => row[columns.length] === label)![0] as RecordId;
                assert.match(decodeURIComponent(String(realKey)), /\["real",/);
                await assert.rejects(() => crafted.getCellMetadata({ table, rowId: realKey, column: 'v' }));
                await assert.rejects(() => crafted.updateCell(table, realKey, 'v', 'edited'));
                await assert.rejects(() => crafted.updateCellBatch(table, [{ rowId: realKey, column: 'v', value: 'edited' }]));
                await assert.rejects(() => crafted.deleteRows(table, [realKey]));
                const chunks: string[] = [];
                await streamTableExport(crafted, table, ['v'], { format: 'csv', rowIds: [realKey] }, {
                    write: async chunk => { chunks.push(chunk); }
                });
                assert.strictEqual(chunks.join(''), 'v');
            }
            assert.deepStrictEqual(await stored(), before);
        }
    });

    it('refuses a TEXT identity whose column was later declared numeric, beside its numeric twin', async () => {
        // A TEXT identity binds as text, which a column declared INTEGER or
        // REAL compares as a number. Each identity must name only its own row.
        const crafted = await createRedeclaredEngine(
            'CREATE TABLE crafted_int (k PRIMARY KEY, v TEXT) WITHOUT ROWID; ' +
            "INSERT INTO crafted_int VALUES (1, 'number'), ('1', 'text'), (2, 'other'); " +
            'CREATE TABLE crafted_real (k PRIMARY KEY, v TEXT) WITHOUT ROWID; ' +
            "INSERT INTO crafted_real VALUES (1.5, 'number'), ('1.5', 'text'), (2.5, 'other'); " +
            'CREATE TABLE crafted_pair (a, b, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID; ' +
            "INSERT INTO crafted_pair VALUES (1, 'x', 'number'), ('1', 'x', 'text'), (2, 'x', 'other')",
            [
                ['crafted_int', 'CREATE TABLE crafted_int (k INTEGER PRIMARY KEY, v TEXT) WITHOUT ROWID'],
                ['crafted_real', 'CREATE TABLE crafted_real (k REAL PRIMARY KEY, v TEXT) WITHOUT ROWID'],
                ['crafted_pair', 'CREATE TABLE crafted_pair (a INTEGER, b, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID']
            ]
        );
        for (const [table, columns] of [
            ['crafted_int', ['k', 'v']],
            ['crafted_real', ['k', 'v']],
            ['crafted_pair', ['a', 'b', 'v']]
        ] as const) {
            const stored = async () => (await crafted.executeQuery(
                `SELECT typeof(${columns[0]}), v FROM ${table} ORDER BY v`
            ))[0].rows;
            const before = await stored();
            const page = await crafted.fetchTableData(table, { columns: ['rowid', ...columns], limit: 10, offset: 0 });
            const textKey = page.rows.find(row => row[columns.length] === 'text')![0] as RecordId;
            assert.match(decodeURIComponent(String(textKey)), /\["text","1(\.5)?"\]/);
            await assert.rejects(() => crafted.updateCell(table, textKey, 'v', 'edited'));
            await assert.rejects(() => crafted.updateCellBatch(table, [{ rowId: textKey, column: 'v', value: 'edited' }]));
            await assert.rejects(() => crafted.getCellMetadata({ table, rowId: textKey, column: 'v' }));
            await assert.rejects(() => crafted.deleteRows(table, [textKey]));
            const chunks: string[] = [];
            await streamTableExport(crafted, table, ['v'], { format: 'csv', rowIds: [textKey] }, {
                write: async chunk => { chunks.push(chunk); }
            });
            assert.strictEqual(chunks.join(''), 'v');
            assert.deepStrictEqual(await stored(), before, table);
        }
    });

    it('refuses a delete whose identity matches another row, or two rows beside a missing one', async () => {
        // A key declared COLLATE NOCASE over rows stored under BINARY holds
        // 'A' and 'a'. Each identity must match exactly one row.
        const crafted = await createRedeclaredEngine(
            "CREATE TABLE folded (a TEXT, v TEXT, PRIMARY KEY (a)) WITHOUT ROWID; " +
            "INSERT INTO folded VALUES ('A', 'upper'), ('a', 'lower'), ('c', 'other')",
            [['folded', 'CREATE TABLE folded (a TEXT, v TEXT, PRIMARY KEY (a COLLATE NOCASE)) WITHOUT ROWID']]
        );
        const stored = async () => (await crafted.executeQuery('SELECT a, v FROM folded ORDER BY v'))[0].rows;
        const before = await stored();
        const page = await crafted.fetchTableData('folded', { columns: ['rowid', 'a', 'v'], limit: 10, offset: 0 });
        const lower = page.rows.find(row => row[2] === 'lower')![0] as RecordId;
        const missing = encodePrimaryKeyRecordId([{ identifier: 'a', declaredType: 'TEXT', position: 1 }], [5n]);
        await assert.rejects(() => crafted.deleteRows('folded', [lower, missing]), /more than one row|no longer exist/);
        assert.deepStrictEqual(await stored(), before);
        await assert.rejects(() => crafted.deleteRows('folded', [lower]));
        assert.deepStrictEqual(await stored(), before);
    });

    it('edits, exports, deletes and restores TEXT keys under the TEXT storage check', async () => {
        await engine.executeQuery(
            "CREATE TABLE text_keys (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID; " +
            "INSERT INTO text_keys VALUES ('1', 'text'), ('b', 'other'); " +
            'CREATE TABLE typeless_text_keys (k PRIMARY KEY, v TEXT) WITHOUT ROWID; ' +
            "INSERT INTO typeless_text_keys VALUES ('1', 'text'), (1, 'integer'), ('b', 'other')"
        );
        for (const table of ['text_keys', 'typeless_text_keys']) {
            const rows = async () => (await engine.executeQuery(
                `SELECT typeof(k), CAST(k AS TEXT), v FROM ${table} ORDER BY v`
            ))[0].rows;
            const before = await rows();
            const page = await engine.fetchTableData(table, { columns: ['rowid', 'k', 'v'], limit: 10, offset: 0 });
            const textKey = page.rows.find(row => row[2] === 'text')![0] as RecordId;
            assert.match(decodeURIComponent(String(textKey)), /\["text","1"\]/);

            const chunks: string[] = [];
            await streamTableExport(engine, table, ['v'], { format: 'csv', rowIds: [textKey] }, {
                write: async chunk => { chunks.push(chunk); }
            });
            assert.strictEqual(chunks.join(''), 'v\ntext');
            const affectedCells = await engine.updateCellBatch(table, [{ rowId: textKey, column: 'v', value: 'text-edited' }]);
            assert.deepStrictEqual(
                await rows(),
                before.map(row => row[2] === 'text' ? [row[0], row[1], 'text-edited'] : row).sort((l, r) => String(l[2]).localeCompare(String(r[2])))
            );
            await engine.undoModification({
                description: 'Undo the TEXT key edit',
                modificationType: 'cell_update',
                targetTable: table,
                affectedCells
            });
            assert.deepStrictEqual(await rows(), before);
            const deletedRows = await engine.deleteRows(table, [textKey]);
            assert.strictEqual(deletedRows.length, 1);
            assert.deepStrictEqual(await rows(), before.filter(row => row[2] !== 'text'));
            await engine.undoModification({
                description: 'Restore the TEXT key row',
                modificationType: 'row_delete',
                targetTable: table,
                deletedRows
            });
            assert.deepStrictEqual(await rows(), before);
        }
    });

    it('resolves the stored TEXT identity after writing a number into a TEXT primary key', async () => {
        // The identity re-read after a key edit carries the class of the value
        // written, which the column's affinity may have changed.
        await engine.executeQuery(
            "CREATE TABLE text_key (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID; INSERT INTO text_key VALUES ('x', 'row')"
        );
        const page = await engine.fetchTableData('text_key', { columns: ['rowid', 'k', 'v'], limit: 10, offset: 0 });
        const edited = await engine.updateCell('text_key', page.rows[0][0] as RecordId, 'k', 5) as RecordId;
        assert.match(decodeURIComponent(String(edited)), /\["text","5"\]/);
        const [batch] = await engine.updateCellBatch('text_key', [
            { rowId: edited, column: 'k', value: 6.5 },
            { rowId: edited, column: 'v', value: 'batch' }
        ]);
        assert.match(decodeURIComponent(String(batch.newRowId)), /\["text","6.5"\]/);
        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT typeof(k), k, v FROM text_key'))[0].rows,
            [['text', '6.5', 'batch']]
        );
    });

    it('addresses a row under its primary key collation when the column collation is looser', async () => {
        // 'A' and 'a' are distinct keys under the key's BINARY collation, and
        // equal under the column's NOCASE. Each identity must name one row.
        await engine.executeQuery(
            'CREATE TABLE cased (a TEXT COLLATE NOCASE, v TEXT, PRIMARY KEY (a COLLATE BINARY)) WITHOUT ROWID; ' +
            "INSERT INTO cased VALUES ('A', 'upper'), ('a', 'lower'), ('c', 'other'); " +
            'CREATE TABLE padded (k TEXT COLLATE RTRIM, n INTEGER, v TEXT, PRIMARY KEY (k COLLATE BINARY, n)) WITHOUT ROWID; ' +
            "INSERT INTO padded VALUES ('x', 1, 'plain'), ('x ', 1, 'padded'), ('y', 1, 'other')"
        );
        const cases = [
            ['cased', ['a', 'v'], 'lower', encodePrimaryKeyRecordId(
                [{ identifier: 'a', declaredType: 'TEXT', position: 1 }],
                ['zz']
            )],
            ['padded', ['k', 'n', 'v'], 'padded', encodePrimaryKeyRecordId(
                [{ identifier: 'k', declaredType: 'TEXT', position: 1 }, { identifier: 'n', declaredType: 'INTEGER', position: 2 }],
                ['zz', 1n]
            )]
        ] as const;
        for (const [table, columns, label, missing] of cases) {
            const stored = async () => (await engine.executeQuery(`SELECT v FROM ${table} ORDER BY v`))[0].rows.map(row => row[0]);
            const before = await stored();
            const page = await engine.fetchTableData(table, { columns: ['rowid', ...columns], limit: 10, offset: 0 });
            const rowId = page.rows.find(row => row[columns.length] === label)![0] as RecordId;

            await assert.rejects(() => engine.deleteRows(table, [rowId, missing]));
            assert.deepStrictEqual(await stored(), before, `${table}: delete with a missing identity`);
            assert.deepStrictEqual(
                await engine.getCellMetadata({ table, rowId, column: 'v' }),
                { storageClass: 'text', byteLength: label.length, textEncoding: 'utf-8' }
            );
            const chunks: string[] = [];
            await streamTableExport(engine, table, ['v'], { format: 'csv', rowIds: [rowId] }, {
                write: async chunk => { chunks.push(chunk); }
            });
            assert.strictEqual(chunks.join(''), `v\n${label}`);
            await engine.updateCell(table, rowId, 'v', `${label}-edited`);
            await engine.updateCellBatch(table, [{ rowId, column: 'v', value: `${label}-batch` }]);
            assert.deepStrictEqual(
                await stored(),
                before.map(value => value === label ? `${label}-batch` : value).sort()
            );
            const deleted = await engine.deleteRows(table, [rowId]);
            assert.strictEqual(deleted.length, 1);
            assert.deepStrictEqual(await stored(), before.filter(value => value !== label));
        }
    });

    it('reads key collations past a generated column and exports in key order', async () => {
        // table_info leaves generated columns out of its cid numbering, which
        // the key index's own numbering includes.
        await engine.executeQuery(
            "CREATE TABLE gen_cased (g TEXT GENERATED ALWAYS AS ('x' || v) VIRTUAL, a TEXT COLLATE NOCASE, " +
            'b TEXT, v TEXT, PRIMARY KEY (a COLLATE BINARY, b COLLATE NOCASE)) WITHOUT ROWID; ' +
            "INSERT INTO gen_cased (a, b, v) VALUES ('A', 'x', 'upper'), ('a', 'x', 'lower'), " +
            "('B', 'y', 'upper-b'), ('b', 'Y', 'lower-b'), ('c', 'x', 'other')"
        );
        const schemaIdentity = (await engine.fetchSchema()).tables
            .find(table => table.identifier === 'gen_cased')?.identity;
        const expected = [
            { identifier: 'a', declaredType: 'TEXT', position: 1, collation: 'BINARY' },
            { identifier: 'b', declaredType: 'TEXT', position: 2, collation: 'NOCASE' }
        ];
        assert.deepStrictEqual(schemaIdentity, { kind: 'primaryKey', columns: expected });
        assert.deepStrictEqual(
            (await engine.getTableInfo('gen_cased'))
                .filter(column => column.primaryKeyPosition > 0)
                .map(column => column.primaryKeyCollation),
            ['BINARY', 'NOCASE']
        );

        const exportCsv = async (rowIds?: RecordId[]) => {
            const chunks: string[] = [];
            await streamTableExport(engine, 'gen_cased', ['v'], { format: 'csv', ...(rowIds ? { rowIds } : {}) }, {
                write: async chunk => { chunks.push(chunk); }
            });
            return chunks.join('');
        };
        const oracle = (await engine.executeQuery(
            'SELECT v FROM gen_cased ORDER BY a COLLATE BINARY, b COLLATE NOCASE'
        ))[0].rows.map(row => row[0]);
        assert.strictEqual(await exportCsv(), ['v', ...oracle].join('\n'));
        const page = await engine.fetchTableData('gen_cased', { columns: ['rowid', 'a', 'b', 'v'], limit: 10, offset: 0 });
        const lower = page.rows.find(row => row[3] === 'lower')![0] as RecordId;
        assert.strictEqual(await exportCsv([lower]), 'v\nlower');
    });

    it('keeps guarded multi-row identity predicates on the key index', async () => {
        await engine.executeQuery(
            'CREATE TABLE plan_typeless (k PRIMARY KEY, v) WITHOUT ROWID; ' +
            'CREATE TABLE plan_integer (k INTEGER PRIMARY KEY, v) WITHOUT ROWID; ' +
            'CREATE TABLE plan_pair (a, b, v, PRIMARY KEY (a, b)) WITHOUT ROWID; ' +
            'CREATE TABLE plan_rowid (id INTEGER PRIMARY KEY, v); ' +
            'CREATE TABLE plan_nocase (k TEXT COLLATE NOCASE PRIMARY KEY, v) WITHOUT ROWID; ' +
            'CREATE TABLE plan_text (k TEXT PRIMARY KEY, v) WITHOUT ROWID; ' +
            "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2000) " +
            "INSERT INTO plan_text SELECT 'k' || x, x FROM n; " +
            "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2000) " +
            "INSERT INTO plan_nocase SELECT 'k' || x, x FROM n; " +
            'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2000) ' +
            'INSERT INTO plan_typeless SELECT x, x FROM n; ' +
            'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2000) ' +
            'INSERT INTO plan_integer SELECT x, x FROM n; ' +
            'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2000) ' +
            'INSERT INTO plan_pair SELECT x, x, x FROM n; ' +
            'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2000) ' +
            'INSERT INTO plan_rowid SELECT x, x FROM n; ' +
            'ANALYZE'
        );
        const ids = (columns: PrimaryKeyColumn[], rows: (string | bigint)[][]) => (
            rows.map(values => encodePrimaryKeyRecordId(columns, values))
        );
        const cases: Array<[string, ReturnType<typeof buildRecordIdentitiesPredicate>]> = [
            ['plan_rowid', buildRecordIdentitiesPredicate([1, 2], { kind: 'rowid' })]
        ];
        // Identities read from the schema carry their key's collation.
        for (const collation of [undefined, 'BINARY']) {
            const key = (identifier: string, position = 1): PrimaryKeyColumn => (
                { identifier, declaredType: '', position, ...(collation ? { collation } : {}) }
            );
            cases.push(
                ['plan_typeless', buildRecordIdentitiesPredicate(
                    ids([key('k')], [[1n], [2n]]),
                    { kind: 'primaryKey', columns: [key('k')] }
                )],
                ['plan_typeless', buildRecordIdentitiesPredicate(
                    ids([key('k')], [[1n], ['1'], [2n]]),
                    { kind: 'primaryKey', columns: [key('k')] }
                )],
                ['plan_integer', buildRecordIdentitiesPredicate(
                    ids([key('k')], [[1n], [2n]]),
                    { kind: 'primaryKey', columns: [key('k')] }
                )],
                ['plan_pair', buildRecordIdentitiesPredicate(
                    ids([key('a'), key('b', 2)], [[1n, 1n], [2n, 2n]]),
                    { kind: 'primaryKey', columns: [key('a'), key('b', 2)] }
                )],
                ['plan_pair', buildRecordIdentitiesPredicate(
                    ids([key('a'), key('b', 2)], [[1n, 1n], ['1', 1n]]),
                    { kind: 'primaryKey', columns: [key('a'), key('b', 2)] }
                )]
            );
        }
        const nocase: PrimaryKeyColumn[] = [{ identifier: 'k', declaredType: 'TEXT', position: 1, collation: 'NOCASE' }];
        cases.push(
            ['plan_nocase', buildRecordIdentitiesPredicate(ids(nocase, [['k1'], ['k2']]), { kind: 'primaryKey', columns: nocase })],
            ['plan_nocase', buildRecordIdentityPredicate(ids(nocase, [['k1']])[0], { kind: 'primaryKey', columns: nocase })]
        );
        // A TEXT member carries a TEXT storage check, which stays a filter.
        const text: PrimaryKeyColumn[] = [{ identifier: 'k', declaredType: 'TEXT', position: 1, collation: 'BINARY' }];
        cases.push(
            ['plan_text', buildRecordIdentitiesPredicate(ids(text, [['k1'], ['k2']]), { kind: 'primaryKey', columns: text })],
            ['plan_text', buildRecordIdentitiesPredicate(ids(text, [['k1'], [3n]]), { kind: 'primaryKey', columns: text })],
            ['plan_text', buildRecordIdentityPredicate(ids(text, [['k1']])[0], { kind: 'primaryKey', columns: text })]
        );
        for (const [table, predicate] of cases) {
            for (const statement of [`SELECT v FROM ${table}`, `DELETE FROM ${table}`]) {
                const plan = (await engine.executeQuery(
                    `EXPLAIN QUERY PLAN ${statement} WHERE ${predicate.sql}`,
                    predicate.params
                ))[0].rows.map(row => String(row[3]));
                assert.ok(
                    plan.some(detail => detail.startsWith(`SEARCH ${table} USING `) && detail.includes('PRIMARY KEY')),
                    `${statement} WHERE ${predicate.sql}: ${plan.join(' / ')}`
                );
                assert.ok(
                    !plan.some(detail => detail.startsWith(`SCAN ${table}`)),
                    `${statement} WHERE ${predicate.sql}: ${plan.join(' / ')}`
                );
            }
        }

        // The selected-row export join reads each identity through the key.
        const statements: Array<{ sql: string; params: unknown[] }> = [];
        const recording = new Proxy(engine, {
            get(target, property, receiver) {
                if (property === 'executeQuery') {
                    return (sql: string, params?: unknown[]) => {
                        statements.push({ sql, params: params ?? [] });
                        return target.executeQuery(sql, params as never);
                    };
                }
                const value = Reflect.get(target, property, receiver);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
        const page = await engine.fetchTableData('plan_text', { columns: ['rowid', 'k', 'v'], limit: 2, offset: 0 });
        await streamTableExport(recording, 'plan_text', ['v'], {
            format: 'csv',
            rowIds: page.rows.map(row => row[0] as RecordId)
        }, { write: async () => {} });
        const join = statements.find(statement => statement.sql.includes('__sqlite_explorer_export_selected'));
        assert.ok(join, 'selected-row export join');
        const joinPlan = (await engine.executeQuery(`EXPLAIN QUERY PLAN ${join.sql}`, join.params as never))[0].rows
            .map(row => String(row[3]));
        assert.ok(
            joinPlan.some(detail => /^SEARCH .*plan_text|^SEARCH __sqlite_explorer_export_source USING PRIMARY KEY/.test(detail)),
            joinPlan.join(' / ')
        );
        assert.ok(!joinPlan.some(detail => /^SCAN (main\.)?(plan_text|__sqlite_explorer_export_source)\b/.test(detail)), joinPlan.join(' / '));
    });

    it('targets an INTEGER key beside its numeric-looking TEXT twin in a typeless primary key', async () => {
        // INTEGER 1 and TEXT '1' are distinct keys of a typeless column. An
        // identity predicate that applied NUMERIC affinity matched both, so
        // the one-row guards refused every edit and delete of either row.
        await engine.executeQuery(
            'CREATE TABLE typeless_twins (k PRIMARY KEY, v TEXT) WITHOUT ROWID; ' +
            "INSERT INTO typeless_twins VALUES (1, 'integer'), ('1', 'text'), (2, 'other'); " +
            'CREATE TABLE typeless_composite_twins (a, b, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID; ' +
            'INSERT INTO typeless_composite_twins VALUES ' +
            "(1, 1, 'ii'), ('1', 1, 'ti'), (1, '1', 'it'), ('1', '1', 'tt'), (2, 2, 'x')"
        );
        const identityOf = async (table: string, columns: string[], label: string) => {
            const page = await engine.fetchTableData(table, {
                columns: ['rowid', ...columns],
                limit: 10,
                offset: 0
            });
            const row = page.rows.find(candidate => candidate[columns.length] === label);
            assert.ok(row, `${table}: no row labelled ${label}`);
            return row[0] as RecordId;
        };

        const twinRows = async () => (await engine.executeQuery(
            'SELECT typeof(k), k, v FROM typeless_twins ORDER BY k'
        ))[0].rows;
        const integerTwin = await identityOf('typeless_twins', ['k', 'v'], 'integer');
        assert.deepStrictEqual(
            await engine.getCellMetadata({ table: 'typeless_twins', rowId: integerTwin, column: 'v' }),
            { storageClass: 'text', byteLength: 7, textEncoding: 'utf-8' }
        );
        const affectedCells = await engine.updateCellBatch('typeless_twins', [{
            rowId: integerTwin,
            column: 'v',
            value: 'batch-edited'
        }]);
        assert.deepStrictEqual(
            await twinRows(),
            [['integer', 1, 'batch-edited'], ['integer', 2, 'other'], ['text', '1', 'text']]
        );
        await engine.undoModification({
            description: 'Undo the INTEGER twin edit',
            modificationType: 'cell_update',
            targetTable: 'typeless_twins',
            affectedCells
        });
        assert.deepStrictEqual(
            await twinRows(),
            [['integer', 1, 'integer'], ['integer', 2, 'other'], ['text', '1', 'text']]
        );
        await engine.updateCell('typeless_twins', integerTwin, 'v', 'integer-edited');
        await engine.updateCell(
            'typeless_twins',
            await identityOf('typeless_twins', ['k', 'v'], 'text'),
            'v',
            'text-edited'
        );
        assert.deepStrictEqual(
            await twinRows(),
            [['integer', 1, 'integer-edited'], ['integer', 2, 'other'], ['text', '1', 'text-edited']]
        );

        const columns = ['a', 'b', 'v'];
        const single = await engine.deleteRows('typeless_composite_twins', [
            await identityOf('typeless_composite_twins', columns, 'ii')
        ]);
        assert.strictEqual(single?.length, 1);
        const pair = await engine.deleteRows('typeless_composite_twins', [
            await identityOf('typeless_composite_twins', columns, 'it'),
            await identityOf('typeless_composite_twins', columns, 'x')
        ]);
        assert.strictEqual(pair?.length, 2);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT typeof(a), a, typeof(b), b, v FROM typeless_composite_twins ORDER BY v'
            ))[0].rows,
            [['text', '1', 'integer', 1, 'ti'], ['text', '1', 'text', '1', 'tt']]
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
        assert.deepStrictEqual(
            await engine.fetchTableCount('row_lifecycle', {}),
            { count: 0, isExact: true }
        );
        assert.deepStrictEqual(deletedRows, [{
            rowId: identity,
            row,
            storageClasses: [
                { column: 'namespace', storageClass: 'blob' },
                { column: 'key', storageClass: 'text' },
                { column: 'value', storageClass: 'text' }
            ]
        }]);

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
            affectedRowIds: [identity],
            deletedRows
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
