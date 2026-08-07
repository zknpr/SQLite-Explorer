import './vscode_mock_setup';

import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createDatabaseEngine } from '../../src/core/sqlite-db';
import {
    ROWID_TABLE_AUTHORITY_SQL,
    collectRowIdExactRealTexts,
    type RowIdExactRealTextQuery
} from '../../src/core/integer-utils';
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

    it('denies authority to tables declaring a rowid-shadowing column', async () => {
        await engine.executeQuery(
            'CREATE TABLE plain_rows (value TEXT); ' +
            'CREATE TABLE shadowed_rowid ("rowid" TEXT); ' +
            'CREATE TABLE shadowed_oid (id INTEGER, "OID" TEXT); ' +
            'CREATE TABLE shadowed_rowid_alias (id INTEGER, "_ROWID_" TEXT); ' +
            'CREATE TABLE pk_rows (key TEXT PRIMARY KEY) WITHOUT ROWID'
        );

        assert.strictEqual(await hasAuthority('plain_rows'), true);
        assert.strictEqual(await hasAuthority('shadowed_rowid'), false);
        assert.strictEqual(await hasAuthority('shadowed_oid'), false);
        assert.strictEqual(await hasAuthority('shadowed_rowid_alias'), false);
        assert.strictEqual(await hasAuthority('pk_rows'), false);
    });

    it('skips exact-REAL companions when a wide table declares its own rowid column', async () => {
        const dataColumns = Array.from({ length: 999 }, (_, index) => `c${index}`);
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

        assert.deepStrictEqual(page.rows.map(row => row[0]), ['dup', 'dup']);
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
            columns: ['rowid', 'value'],
            limit: 10,
            offset: 0
        });

        assert.deepStrictEqual(
            page.rows.map(row => row[0]),
            [9007199254740992, 9007199254740992]
        );
        assert.strictEqual(page.exactIntegerTexts?.[0]?.[0], '9007199254740993');
        assert.strictEqual(page.exactIntegerTexts?.[1]?.[0], '9007199254740993');
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
