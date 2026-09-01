import './vscode_mock_setup';

import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createDatabaseEngine } from '../../src/core/sqlite-db';
import {
    ROWID_TABLE_AUTHORITY_SQL,
    collectRowIdExactRealTexts,
    type RowIdExactRealTextQuery
} from '../../src/core/integer-utils';
import { isReadOnlyPrimaryKeyRecordId } from '../../src/core/row-identity';
import type { DatabaseOperations } from '../../src/core/types';

describe('rowid shadowing authority', () => {
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

    async function hasAuthority(table: string): Promise<boolean> {
        const authority = await engine.executeQuery(ROWID_TABLE_AUTHORITY_SQL, [table, table]);
        return (authority[0]?.rows.length ?? 0) > 0;
    }

    it('denies authority only when the literal rowid alias used by queries is shadowed', async () => {
        await engine.executeQuery(
            'CREATE TABLE plain_rows (value TEXT); ' +
            'CREATE TABLE shadowed_rowid ("rowid" TEXT); ' +
            'CREATE TABLE shadowed_oid (id INTEGER, "OID" TEXT); ' +
            'CREATE TABLE shadowed_rowid_alias (id INTEGER, "_ROWID_" TEXT); ' +
            'CREATE TABLE intrinsic_rowid_alias ("rowid" INTEGER PRIMARY KEY, value TEXT); ' +
            'CREATE TABLE shadowed_rowid_desc ("rowid" INTEGER PRIMARY KEY DESC, value TEXT); ' +
            'CREATE TABLE pk_rows (key TEXT PRIMARY KEY) WITHOUT ROWID'
        );

        assert.strictEqual(await hasAuthority('plain_rows'), true);
        assert.strictEqual(await hasAuthority('shadowed_rowid'), false);
        assert.strictEqual(await hasAuthority('shadowed_oid'), true);
        assert.strictEqual(await hasAuthority('shadowed_rowid_alias'), true);
        assert.strictEqual(await hasAuthority('intrinsic_rowid_alias'), true);
        assert.strictEqual(await hasAuthority('shadowed_rowid_desc'), false);
        assert.strictEqual(await hasAuthority('pk_rows'), false);
    });

    it('keeps a declared INTEGER PRIMARY KEY rowid alias editable', async () => {
        await engine.executeQuery(
            'CREATE TABLE intrinsic_rowid_edit ("rowid" INTEGER PRIMARY KEY, value TEXT); ' +
            "INSERT INTO intrinsic_rowid_edit(rowid, value) VALUES (7, 'before')"
        );

        const page = await engine.fetchTableData('intrinsic_rowid_edit', {
            columns: ['rowid', 'rowid', 'value'],
            limit: 10,
            offset: 0
        });
        assert.strictEqual(page.rows[0][0], 7);
        assert.strictEqual(isReadOnlyPrimaryKeyRecordId(page.rows[0][0]), false);

        await engine.updateCell('intrinsic_rowid_edit', 7, 'value', 'after');
        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT rowid, value FROM intrinsic_rowid_edit'))[0].rows,
            [[7, 'after']]
        );
    });

    it('replays guarded row history for an INTEGER PRIMARY KEY named rowid', async () => {
        await engine.executeQuery(
            'CREATE TABLE intrinsic_rowid_history ("rowid" INTEGER PRIMARY KEY, value TEXT)'
        );
        const insertedRow = await engine.insertRowWithHistory!(
            'intrinsic_rowid_history',
            { rowid: 7, value: 'tracked' }
        );
        const modification = {
            description: 'Insert intrinsic rowid alias',
            modificationType: 'row_insert' as const,
            targetTable: 'intrinsic_rowid_history',
            targetRowId: insertedRow.rowId,
            rowData: insertedRow.row,
            insertedRow
        };

        await engine.undoModification(modification);
        await engine.redoModification(modification);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT rowid, value FROM intrinsic_rowid_history'
            ))[0].rows,
            [[7, 'tracked']]
        );
    });

    it('rejects direct row mutations when a declared rowid shadows intrinsic identity', async () => {
        await engine.executeQuery(
            'CREATE TABLE shadowed_row_history ("rowid" TEXT, value TEXT); ' +
            "INSERT INTO shadowed_row_history VALUES ('declared', 'preserved')"
        );

        await assert.rejects(
            engine.deleteRows('shadowed_row_history', [1]),
            /declared.*rowid.*identity/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT _rowid_, rowid, value FROM shadowed_row_history'
            ))[0].rows,
            [[1, 'declared', 'preserved']]
        );
    });

    it('rejects a unique declared rowid as a single or batch cell identity', async () => {
        await engine.executeQuery(
            'CREATE TABLE unique_shadowed_cell_identity ("rowid" INTEGER UNIQUE, value TEXT); ' +
            "INSERT INTO unique_shadowed_cell_identity(rowid, value) VALUES (7, 'preserved')"
        );

        await assert.rejects(
            engine.updateCell('unique_shadowed_cell_identity', 7, 'value', 'single'),
            /declared.*rowid.*identity/i
        );
        await assert.rejects(
            engine.updateCellBatch('unique_shadowed_cell_identity', [{
                rowId: 7,
                column: 'value',
                value: 'batch'
            }]),
            /declared.*rowid.*identity/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT _rowid_, rowid, value FROM unique_shadowed_cell_identity'
            ))[0].rows,
            [[1, 7, 'preserved']]
        );
    });

    it('tracks INTEGER PRIMARY KEY rowid changes through single and batch undo/redo', async () => {
        await engine.executeQuery(
            'CREATE TABLE remapped_rowid_history (' +
            'id INTEGER PRIMARY KEY, ' +
            'doubled INTEGER GENERATED ALWAYS AS (id * 2) STORED, ' +
            'note TEXT, payload TEXT); ' +
            "INSERT INTO remapped_rowid_history(id, note, payload) " +
            "VALUES (3, 'before', '{\"n\":9007199254740993}')"
        );

        const remapped = await engine.updateCell('remapped_rowid_history', 3, 'id', 34);
        assert.strictEqual(remapped, 34);
        const singleModification = {
            label: 'Update id',
            description: 'Update remapped_rowid_history.id',
            modificationType: 'cell_update' as const,
            targetTable: 'remapped_rowid_history',
            targetRowId: 3,
            newTargetRowId: remapped,
            targetColumn: 'id',
            priorValue: 3,
            newValue: 34,
            operation: 'set' as const,
            priorState: { storageClass: 'integer' as const, value: 3n },
            postState: { storageClass: 'integer' as const, value: 34n }
        };

        await engine.undoModification(singleModification);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT rowid, id, doubled, note, payload FROM remapped_rowid_history'
            ))[0].rows,
            [[3, 3, 6, 'before', '{"n":9007199254740993}']]
        );
        await engine.redoModification(singleModification);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT rowid, id, doubled, note, payload FROM remapped_rowid_history'
            ))[0].rows,
            [[34, 34, 68, 'before', '{"n":9007199254740993}']]
        );
        await engine.undoModification(singleModification);

        const affectedCells = await engine.updateCellBatch('remapped_rowid_history', [
            { rowId: 3, column: 'id', value: 44 },
            { rowId: 3, column: 'note', value: 'after' },
            {
                rowId: 3,
                column: 'payload',
                value: '{"added":true}',
                operation: 'json_patch'
            }
        ]);
        assert.deepStrictEqual(affectedCells.map(cell => cell.newRowId), [44, 44, 44]);
        const batchModification = {
            label: 'Update row',
            description: 'Update remapped row',
            modificationType: 'cell_update' as const,
            targetTable: 'remapped_rowid_history',
            affectedCells
        };

        await engine.undoModification(batchModification);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT rowid, id, doubled, note, payload FROM remapped_rowid_history'
            ))[0].rows,
            [[3, 3, 6, 'before', '{"n":9007199254740993}']]
        );
        await engine.redoModification(batchModification);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT rowid, id, doubled, note, payload FROM remapped_rowid_history'
            ))[0].rows,
            [[44, 44, 88, 'after', '{"n":9007199254740993,"added":true}']]
        );
    });

    it('canonicalizes an exact int64 alias edit from rowid zero', async () => {
        await engine.executeQuery(
            'CREATE TABLE coerced_rowid_alias (id INTEGER PRIMARY KEY, value TEXT); ' +
            "INSERT INTO coerced_rowid_alias(id, value) VALUES (0, 'kept')"
        );

        const newRowId = await engine.updateCell(
            'coerced_rowid_alias',
            0,
            'id',
            '09223372036854775807'
        );
        assert.strictEqual(newRowId, '9223372036854775807');
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT CAST(rowid AS TEXT), CAST(id AS TEXT), value FROM coerced_rowid_alias'
            ))[0].rows,
            [['9223372036854775807', '9223372036854775807', 'kept']]
        );
    });

    it('rolls back an alias edit when an applicable trigger can substitute a decoy row', async () => {
        await engine.executeQuery(
            'CREATE TABLE triggered_rowid_alias (id INTEGER PRIMARY KEY, value TEXT); ' +
            "INSERT INTO triggered_rowid_alias VALUES (5, 'target'), (8, 'decoy'); " +
            'CREATE TRIGGER substitute_rowid_alias AFTER UPDATE OF id ON triggered_rowid_alias ' +
            'BEGIN ' +
            'UPDATE triggered_rowid_alias SET id = 107 WHERE rowid = NEW.rowid; ' +
            'UPDATE triggered_rowid_alias SET id = NEW.id WHERE rowid = 8; ' +
            'END'
        );

        await assert.rejects(
            engine.updateCell('triggered_rowid_alias', 5, 'id', '0007'),
            /rowid identity.*UPDATE trigger|UPDATE trigger.*rowid identity/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT rowid, id, value FROM triggered_rowid_alias ORDER BY rowid'
            ))[0].rows,
            [[5, 5, 'target'], [8, 8, 'decoy']]
        );
    });

    it('rolls back a non-alias edit when a trigger substitutes a decoy rowid', async () => {
        await engine.executeQuery(
            'CREATE TABLE triggered_non_alias (id INTEGER PRIMARY KEY, note TEXT); ' +
            "INSERT INTO triggered_non_alias VALUES (5, 'target'), (8, 'decoy'); " +
            'CREATE TRIGGER substitute_non_alias AFTER UPDATE OF note ON triggered_non_alias ' +
            'BEGIN ' +
            'UPDATE triggered_non_alias SET id = 105 WHERE rowid = NEW.rowid; ' +
            'UPDATE triggered_non_alias SET id = NEW.id WHERE rowid = 8; ' +
            'END'
        );

        await assert.rejects(
            engine.updateCell('triggered_non_alias', 5, 'note', 'changed'),
            /UPDATE trigger.*target table.*rowid identity/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT rowid, id, note FROM triggered_non_alias ORDER BY rowid'
            ))[0].rows,
            [[5, 5, 'target'], [8, 8, 'decoy']]
        );
    });

    it('guards batch and oversized non-alias edits against rowid substitution', async () => {
        await engine.executeQuery(
            'CREATE TABLE triggered_batch_substitution ' +
            '(id INTEGER PRIMARY KEY, note TEXT); ' +
            "INSERT INTO triggered_batch_substitution VALUES (5, 'target'), (8, 'decoy'); " +
            'CREATE TRIGGER substitute_batch_rowid ' +
            'AFTER UPDATE OF note ON triggered_batch_substitution BEGIN ' +
            'UPDATE triggered_batch_substitution SET id = 105 WHERE rowid = NEW.rowid; ' +
            'UPDATE triggered_batch_substitution SET id = NEW.id WHERE rowid = 8; ' +
            'END'
        );
        await assert.rejects(
            engine.updateCellBatch('triggered_batch_substitution', [
                { rowId: 5, column: 'note', value: 'changed' }
            ]),
            /UPDATE trigger.*target table.*rowid identity/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT rowid, id, note FROM triggered_batch_substitution ORDER BY rowid'
            ))[0].rows,
            [[5, 5, 'target'], [8, 8, 'decoy']]
        );

        const original = 'x'.repeat(32);
        await engine.executeQuery(
            'CREATE TABLE triggered_replacement_substitution ' +
            '(id INTEGER PRIMARY KEY, note TEXT); ' +
            `INSERT INTO triggered_replacement_substitution VALUES ` +
            `(5, '${original}'), (8, 'decoy'); ` +
            'CREATE TRIGGER substitute_replacement_rowid ' +
            'AFTER UPDATE OF note ON triggered_replacement_substitution BEGIN ' +
            'UPDATE triggered_replacement_substitution SET id = 105 ' +
            'WHERE rowid = NEW.rowid; ' +
            'UPDATE triggered_replacement_substitution SET id = NEW.id WHERE rowid = 8; ' +
            'END'
        );
        await assert.rejects(
            engine.replaceOversizedCell(
                'triggered_replacement_substitution',
                5,
                'note',
                'new',
                { storageClass: 'text', byteLength: 32 },
                8
            ),
            /UPDATE trigger.*target table.*rowid identity/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT rowid, id, note FROM triggered_replacement_substitution ORDER BY rowid'
            ))[0].rows,
            [[5, 5, original], [8, 8, 'decoy']]
        );
    });

    it('rejects a descendant trigger program that can substitute the target rowid', async () => {
        await engine.executeQuery(
            'CREATE TABLE nested_trigger_target (id INTEGER PRIMARY KEY, note TEXT); ' +
            "INSERT INTO nested_trigger_target VALUES (5, 'target'), (8, 'decoy'); " +
            'CREATE VIEW nested_trigger_hop AS SELECT id, note FROM nested_trigger_target; ' +
            'CREATE TRIGGER nested_trigger_writer ' +
            'INSTEAD OF INSERT ON nested_trigger_hop BEGIN ' +
            'UPDATE nested_trigger_target SET id = 105 WHERE id = NEW.id; ' +
            'UPDATE nested_trigger_target SET id = NEW.id WHERE id = 8; ' +
            'END; ' +
            'CREATE TRIGGER nested_trigger_entry ' +
            'AFTER UPDATE OF note ON nested_trigger_target BEGIN ' +
            'INSERT INTO nested_trigger_hop VALUES (NEW.id, NEW.note); ' +
            'END'
        );

        await assert.rejects(
            engine.updateCell('nested_trigger_target', 5, 'note', 'changed'),
            /UPDATE trigger.*target table.*rowid identity/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT rowid, id, note FROM nested_trigger_target ORDER BY rowid'
            ))[0].rows,
            [[5, 5, 'target'], [8, 8, 'decoy']]
        );
    });

    it('rejects a non-alias edit whose trigger side effect cannot be undone', async () => {
        await engine.executeQuery(
            'CREATE TABLE harmless_audit_target (id INTEGER PRIMARY KEY, note TEXT); ' +
            'CREATE TABLE harmless_audit_events (target_id INTEGER, note TEXT); ' +
            "INSERT INTO harmless_audit_target VALUES (5, 'before'); " +
            'CREATE TRIGGER record_harmless_audit ' +
            'AFTER UPDATE OF note ON harmless_audit_target BEGIN ' +
            'INSERT INTO harmless_audit_events VALUES (NEW.id, NEW.note); ' +
            'END'
        );

        await assert.rejects(
            engine.updateCell('harmless_audit_target', 5, 'note', 'after'),
            /UPDATE trigger.*undo history/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT id, note, (SELECT count(*) FROM harmless_audit_events) ' +
                'FROM harmless_audit_target'
            ))[0].rows,
            [[5, 'before', 0]]
        );
    });

    it('rejects a rowid-alias edit whose trigger side effect cannot be undone', async () => {
        await engine.executeQuery(
            'CREATE TABLE alias_audit_target (id INTEGER PRIMARY KEY, note TEXT); ' +
            'CREATE TABLE alias_audit_events (target_id INTEGER); ' +
            "INSERT INTO alias_audit_target VALUES (5, 'kept'); " +
            'CREATE TRIGGER record_alias_audit AFTER UPDATE OF id ON alias_audit_target ' +
            'BEGIN INSERT INTO alias_audit_events VALUES (NEW.id); END'
        );

        await assert.rejects(
            engine.updateCell('alias_audit_target', 5, 'id', 6),
            /UPDATE trigger.*undo history/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT id, note, (SELECT count(*) FROM alias_audit_events) ' +
                'FROM alias_audit_target'
            ))[0].rows,
            [[5, 'kept', 0]]
        );
    });

    it('allows a rowid alias edit whose foreign key uses ON UPDATE CASCADE', async () => {
        await engine.executeQuery(
            'PRAGMA foreign_keys = ON; ' +
            'CREATE TABLE cascade_parent (id INTEGER PRIMARY KEY); ' +
            'CREATE TABLE cascade_child (' +
            'parent_id INTEGER REFERENCES cascade_parent(id) ON UPDATE CASCADE); ' +
            'INSERT INTO cascade_parent VALUES (1); ' +
            'INSERT INTO cascade_child VALUES (1)'
        );

        assert.strictEqual(await engine.updateCell('cascade_parent', 1, 'id', 2), 2);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT p.id, c.parent_id FROM cascade_parent p JOIN cascade_child c'
            ))[0].rows,
            [[2, 2]]
        );
    });

    it('rolls back a batch when a trigger moves an intrinsic rowid', async () => {
        await engine.executeQuery(
            'CREATE TABLE triggered_plain_rowid (note TEXT); ' +
            "INSERT INTO triggered_plain_rowid(rowid, note) VALUES (5, 'before'); " +
            'CREATE TRIGGER move_plain_rowid AFTER UPDATE OF note ON triggered_plain_rowid ' +
            'BEGIN UPDATE triggered_plain_rowid SET rowid = rowid + 100 ' +
            'WHERE rowid = NEW.rowid; END'
        );

        await assert.rejects(
            engine.updateCellBatch('triggered_plain_rowid', [
                { rowId: 5, column: 'note', value: 'after' }
            ]),
            /trigger changed or removed the rowid identity/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT rowid, note FROM triggered_plain_rowid'
            ))[0].rows,
            [[5, 'before']]
        );
    });

    it('rejects batch UPDATE triggers whose repeated side effects cannot be undone', async () => {
        await engine.executeQuery(
            'CREATE TABLE alias_trigger_count (id INTEGER PRIMARY KEY, a TEXT, b TEXT); ' +
            'CREATE TABLE alias_trigger_audit (event TEXT); ' +
            "INSERT INTO alias_trigger_count VALUES (1, 'a0', 'b0'); " +
            'CREATE TRIGGER count_alias_updates AFTER UPDATE ON alias_trigger_count ' +
            "BEGIN INSERT INTO alias_trigger_audit VALUES ('updated'); END"
        );

        await assert.rejects(
            engine.updateCellBatch('alias_trigger_count', [
                { rowId: 1, column: 'a', value: 'a1' },
                { rowId: 1, column: 'b', value: 'b1' }
            ]),
            /UPDATE trigger.*undo history/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT a, b, (SELECT count(*) FROM alias_trigger_audit) ' +
                'FROM alias_trigger_count'
            ))[0].rows,
            [['a0', 'b0', 0]]
        );
    });

    it('marks only SQLite rowid aliases in table metadata', async () => {
        await engine.executeQuery(
            'CREATE TABLE metadata_rowid_alias (id INTEGER PRIMARY KEY, value TEXT); ' +
            'CREATE TABLE metadata_desc_pk (id INTEGER PRIMARY KEY DESC, value TEXT); ' +
            'CREATE TABLE metadata_table_desc (id INTEGER, value TEXT, PRIMARY KEY(id DESC)); ' +
            'CREATE TABLE metadata_named_rowid ("rowid" INTEGER PRIMARY KEY, value TEXT); ' +
            'CREATE TABLE metadata_named_rowid_desc ' +
            '("rowid" INTEGER PRIMARY KEY DESC, value TEXT)'
        );

        const alias = await engine.getTableInfo('metadata_rowid_alias');
        const descending = await engine.getTableInfo('metadata_desc_pk');
        const tableDescending = await engine.getTableInfo('metadata_table_desc');
        const namedRowid = await engine.getTableInfo('metadata_named_rowid');
        const namedRowidDescending = await engine.getTableInfo('metadata_named_rowid_desc');
        assert.strictEqual(alias.find(column => column.identifier === 'id')?.isRowidAlias, true);
        assert.strictEqual(descending.find(column => column.identifier === 'id')?.isRowidAlias, false);
        assert.strictEqual(
            tableDescending.find(column => column.identifier === 'id')?.isRowidAlias,
            true
        );
        assert.strictEqual(
            namedRowid.find(column => column.identifier === 'rowid')?.isRowidAlias,
            true
        );
        assert.strictEqual(
            namedRowidDescending.find(column => column.identifier === 'rowid')?.isRowidAlias,
            false
        );
    });

    it('skips exact-REAL companions when a wide table declares its own rowid column', async () => {
        const dataColumns = Array.from({ length: 1999 }, (_, index) => `c${index}`);
        await engine.executeQuery(
            `CREATE TABLE hostile_wide ("rowid" TEXT, ${dataColumns.map(name => `"${name}"`).join(', ')}); ` +
            'INSERT INTO hostile_wide("rowid", c0) VALUES ' +
            "('dup', 9.652937795298495e282), ('dup', 2.5)"
        );

        const page = await engine.fetchTableData('hostile_wide', {
            columns: ['rowid', ...dataColumns],
            limit: 10,
            offset: 0
        });

        assert.ok(page.rows.every(row => isReadOnlyPrimaryKeyRecordId(row[0])));
        assert.strictEqual(typeof page.rows[0][1], 'number');
        assert.strictEqual(page.rows[1][1], 2.5);
        // A duplicated declared column cannot key companion reads; the page
        // must keep the documented values-only degradation instead of
        // attributing exact REAL text across rows.
        assert.strictEqual(page.exactIntegerTexts, undefined);
    });

    it('treats an unsafe INTEGER in a declared rowid column as data, not identity', async () => {
        await engine.executeQuery(
            'CREATE TABLE hostile_narrow ("rowid" INTEGER, value TEXT); ' +
            'INSERT INTO hostile_narrow("rowid", value) VALUES ' +
            "(9007199254740993, 'first'), (9007199254740993, 'second')"
        );

        const page = await engine.fetchTableData('hostile_narrow', {
            columns: ['rowid', 'rowid', 'value'],
            limit: 10,
            offset: 0
        });

        assert.ok(page.rows.every(row => isReadOnlyPrimaryKeyRecordId(row[0])));
        assert.deepStrictEqual(
            page.rows.map(row => row[1]),
            [9007199254740992, 9007199254740992]
        );
        assert.strictEqual(page.exactIntegerTexts?.[0]?.[1], '9007199254740993');
        assert.strictEqual(page.exactIntegerTexts?.[1]?.[1], '9007199254740993');
    });

    it('marks rows read-only when a declared rowid column shadows the intrinsic identity', async () => {
        await engine.executeQuery(
            'CREATE TABLE shadowed_grid_identity ("rowid" INTEGER, value TEXT); ' +
            "INSERT INTO shadowed_grid_identity(rowid, value) VALUES (7, 'first'), (7, 'second')"
        );

        const page = await engine.fetchTableData('shadowed_grid_identity', {
            columns: ['rowid', 'rowid', 'value'],
            limit: 10,
            offset: 0
        });

        assert.ok(page.rows.every(row => isReadOnlyPrimaryKeyRecordId(row[0])));
        assert.deepStrictEqual(page.rows.map(row => row.slice(1)), [
            [7, 'first'],
            [7, 'second']
        ]);
        assert.match(page.readOnlyRowReasons?.[0] ?? '', /read-only.*declared.*rowid/i);
        assert.match(page.readOnlyRowReasons?.[1] ?? '', /read-only.*declared.*rowid/i);
    });

    it('rejects a single-cell edit whose declared rowid shadows intrinsic identity', async () => {
        await engine.executeQuery(
            'CREATE TABLE shadowed_edit_identity ("rowid" INTEGER, value TEXT); ' +
            "INSERT INTO shadowed_edit_identity(rowid, value) VALUES (7, 'first'), (7, 'second')"
        );

        await assert.rejects(
            engine.updateCell(
                'shadowed_edit_identity',
                7,
                'value',
                'changed'
            ),
            /read-only.*declared.*rowid.*identity/i
        );

        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT _rowid_, rowid, value FROM shadowed_edit_identity ORDER BY _rowid_'
            ))[0].rows,
            [[1, 7, 'first'], [2, 7, 'second']]
        );
    });

    it('rolls back a rejected oversized-cell replacement whose declared rowid matches multiple rows', async () => {
        const original = 'x'.repeat(32);
        await engine.executeQuery(
            'CREATE TABLE shadowed_oversized_identity ("rowid" INTEGER, value TEXT); ' +
            'INSERT INTO shadowed_oversized_identity(rowid, value) VALUES ' +
            `(7, '${original}'), (7, '${original}')`
        );

        await assert.rejects(
            engine.replaceOversizedCell(
                'shadowed_oversized_identity',
                7,
                'value',
                'new',
                { storageClass: 'text', byteLength: 32 },
                8
            ),
            /read-only.*declared.*rowid/i
        );

        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT _rowid_, rowid, value FROM shadowed_oversized_identity ORDER BY _rowid_'
            ))[0].rows,
            [[1, 7, original], [2, 7, original]]
        );
    });

    it('still resolves unsafe intrinsic rowids to exact string identities', async () => {
        await engine.executeQuery(
            'CREATE TABLE true_rowids (value TEXT); ' +
            "INSERT INTO true_rowids(rowid, value) VALUES (9007199254740993, 'kept')"
        );

        const page = await engine.fetchTableData('true_rowids', {
            columns: ['rowid', 'value'],
            limit: 10,
            offset: 0
        });

        assert.strictEqual(page.rows[0][0], '9007199254740993');
        assert.strictEqual(page.rows[0][1], 'kept');
    });
});

describe('rowid companion duplicate rejection', () => {
    const query: RowIdExactRealTextQuery = {
        sql: '',
        params: [],
        transportColumns: [
            '__sqlite_explorer_numeric_rowid',
            '__sqlite_explorer_numeric_rowid_text_1'
        ],
        columnIndices: [1]
    };

    it('rejects duplicate companion source ids instead of last-write-wins', () => {
        assert.throws(
            () => collectRowIdExactRealTexts(
                [[7, 1.25], [7, 2.5]],
                [{ query, rows: [[7, '1.25000000000001']] }]
            ),
            /Duplicate rowid identity at source row 1/
        );
    });

    it('keeps merging companion text for unique source ids', () => {
        const exactTexts = collectRowIdExactRealTexts(
            [[7, 1.25], [8, 2.5]],
            [{ query, rows: [[7, '1.25000000000001']] }]
        );
        assert.deepStrictEqual(exactTexts, { 0: { 1: '1.25000000000001' } });
    });
});

describe('fetchTableData preemption', () => {
    it('applies the configured query timeout to page reads', async () => {
        const result = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false,
            queryTimeout: 20
        });
        const engine = result.operations!;
        try {
            await engine.executeQuery(
                'CREATE VIEW slow_view AS ' +
                'WITH RECURSIVE counter(value) AS (' +
                'VALUES(1) UNION ALL SELECT value + 1 FROM counter WHERE value < 100000000' +
                ') SELECT sum(value) AS total FROM counter'
            );

            const startedAt = performance.now();
            await assert.rejects(
                engine.fetchTableData('slow_view', { limit: 1, offset: 0 }),
                /Fetch failed: Query execution timed out after 20ms/
            );
            assert.ok(
                performance.now() - startedAt < 2000,
                'the page read must observe the VM deadline instead of running to completion'
            );
        } finally {
            (engine as DatabaseOperations & { shutdown?: () => void }).shutdown?.();
        }
    });
});
