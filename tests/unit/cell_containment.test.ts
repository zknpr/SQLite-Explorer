import './vscode_mock_setup';

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import {
    WEBVIEW_TRANSPORT_SURFACES,
    assertWebviewTransportPayload
} from '../../src/core/webview-transport';

const containmentModulePath = '../../src/core/cell-containment.ts';

async function loadContainmentModule(): Promise<any> {
    const module = await import(containmentModulePath).catch(() => undefined);
    assert.ok(module, 'the shared cell-containment module must exist');
    return module;
}

describe('grid cell containment limits', () => {
    it('routes byte-unrepresentable TEXT to a raw sidecar instead of exposing U+FFFD as editable data', async () => {
        const { containUnrepresentableTextCells } = await loadContainmentModule();
        const decoded = containUnrepresentableTextCells({
            sourceRows: [['�', '�']],
            rawTextRows: [[Uint8Array.of(0x80), Uint8Array.of(0xef, 0xbf, 0xbd)]],
            rawTextColumnIndices: [0, 1],
            textEncoding: 'utf-8',
            contained: { rows: [['�', '�']] }
        });

        assert.deepStrictEqual(decoded.rows, [[Uint8Array.of(0x80), '�']]);
        assert.deepStrictEqual(decoded.oversizedCells, {
            0: { 0: { storageClass: 'text', byteLength: 1 } }
        });
    });

    it('caps an unrepresentable TEXT raw prefix without changing its bytes', async () => {
        const {
            containUnrepresentableTextCells,
            MAX_UNREPRESENTABLE_TEXT_PREVIEW_BYTES
        } = await loadContainmentModule();
        const raw = new Uint8Array(MAX_UNREPRESENTABLE_TEXT_PREVIEW_BYTES + 17);
        raw.fill(0x80);
        raw[0] = 0xff;
        raw[MAX_UNREPRESENTABLE_TEXT_PREVIEW_BYTES - 1] = 0xfe;
        const decoded = containUnrepresentableTextCells({
            sourceRows: [['�']],
            rawTextRows: [[raw]],
            rawTextColumnIndices: [0],
            textEncoding: 'utf-8',
            contained: { rows: [['�']] }
        });
        const retained = decoded.rows[0][0];

        assert.ok(retained instanceof Uint8Array);
        assert.strictEqual(retained.byteLength, MAX_UNREPRESENTABLE_TEXT_PREVIEW_BYTES);
        assert.strictEqual(retained[0], 0xff);
        assert.strictEqual(retained.at(-1), 0xfe);
        assert.deepStrictEqual(decoded.oversizedCells, {
            0: { 0: { storageClass: 'text', byteLength: raw.byteLength } }
        });
    });

    it('contains malformed ordinary SQLite TEXT in an actual WASM table page', async () => {
        const result = await createDatabaseEngine({ content: null, maxSize: 0 });
        const engine = result.operations!;
        try {
            await engine.executeQuery(
                'CREATE TABLE malformed_text_value (value TEXT); ' +
                "INSERT INTO malformed_text_value VALUES " +
                "(CAST(X'80' AS TEXT)), (CAST(X'EFBFBD' AS TEXT))"
            );
            const page = await engine.fetchTableData('malformed_text_value', {
                columns: ['rowid', 'value'],
                orderBy: 'rowid',
                orderDir: 'ASC',
                limit: 10,
                offset: 0
            });

            assert.deepStrictEqual(page.rows, [[1, Uint8Array.of(0x80)], [2, '�']]);
            assert.deepStrictEqual(page.oversizedCells, {
                0: { 1: { storageClass: 'text', byteLength: 1 } }
            });
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('retains a byte-exact raw prefix for unrepresentable TEXT returned by a view', async () => {
        const result = await createDatabaseEngine({ content: null, maxSize: 0 });
        const engine = result.operations!;
        try {
            await engine.executeQuery(
                'CREATE TABLE malformed_view_source (value TEXT); ' +
                "INSERT INTO malformed_view_source VALUES (CAST(X'80' AS TEXT)); " +
                'CREATE VIEW malformed_text_view AS SELECT value FROM malformed_view_source'
            );
            const page = await engine.fetchTableData('malformed_text_view', {
                columns: ['value'],
                limit: 1,
                offset: 0
            });

            assert.deepStrictEqual(page.rows, [[Uint8Array.of(0x80)]]);
            assert.deepStrictEqual(page.oversizedCells, {
                0: { 0: { storageClass: 'text', byteLength: 1 } }
            });
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('keeps the 1 MiB per-cell ceiling when the page budget is looser', async () => {
        const { deriveEffectiveInlineCellBytes } = await loadContainmentModule();

        assert.strictEqual(deriveEffectiveInlineCellBytes({
            maxInlineCellBytes: 1024 * 1024,
            maxPageResponseBytes: 16 * 1024 * 1024,
            limit: 2
        }, 4), 1024 * 1024);
    });

    it('caps the SQL display floor by the aggregate raw page budget', async () => {
        const { deriveEffectiveInlineCellBytes } = await loadContainmentModule();

        assert.strictEqual(deriveEffectiveInlineCellBytes({
            maxInlineCellBytes: 1024 * 1024,
            maxPageResponseBytes: 16 * 1024 * 1024,
            limit: 5000
        }, 50), 67);
        assert.strictEqual(deriveEffectiveInlineCellBytes({
            maxInlineCellBytes: 1024 * 1024,
            maxPageResponseBytes: 16 * 1024 * 1024,
            limit: 5000
        }, 51), 65);
        assert.strictEqual(deriveEffectiveInlineCellBytes({
            maxInlineCellBytes: 1024 * 1024,
            maxPageResponseBytes: 16 * 1024 * 1024,
            limit: 5000
        }, 1000), 3);
        assert.strictEqual(deriveEffectiveInlineCellBytes({
            maxInlineCellBytes: 1024 * 1024,
            maxPageResponseBytes: 16 * 1024 * 1024,
            limit: Number.MAX_SAFE_INTEGER
        }, 2), 0);
    });

    it('bounds BLOB bytes in SQLite before the result reaches the decoder', async () => {
        const { buildCellContainmentQuery } = await loadContainmentModule();
        const result = await createDatabaseEngine({ content: null, maxSize: 0 });
        const engine = result.operations!;
        try {
            await engine.executeQuery(
                'CREATE TABLE predecode_page_bound (a BLOB, b BLOB); ' +
                'INSERT INTO predecode_page_bound VALUES ' +
                '(zeroblob(300), zeroblob(300)), ' +
                '(zeroblob(300), zeroblob(300)), ' +
                '(zeroblob(300), zeroblob(300)), ' +
                '(zeroblob(300), zeroblob(300))'
            );
            const query = buildCellContainmentQuery(
                'SELECT a, b FROM predecode_page_bound LIMIT 4',
                2,
                {
                    limit: 4,
                    maxInlineCellBytes: 1024 * 1024,
                    maxPageResponseBytes: 16
                }
            );
            const queryResult = await engine.executeQuery(query.sql);
            const transportedBlobBytes = (queryResult[0]?.rows ?? []).reduce<number>(
                (pageTotal, row) => pageTotal + row.slice(0, 2).reduce<number>(
                    (rowTotal, value) => rowTotal + (
                        value instanceof Uint8Array ? value.byteLength : 0
                    ),
                    0
                ),
                0
            );

            assert.ok(
                transportedBlobBytes <= 16,
                `SQLite materialized ${transportedBlobBytes} BLOB bytes for a 16-byte page`
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('derives maximum-width containment metadata from the same volatile row evaluation', async () => {
        const {
            buildCellContainmentQuery,
            decodeCellContainment,
            mergeCellContainmentMetadataRows
        } = await loadContainmentModule();
        const sourceColumns = Array.from({ length: 2000 }, (_, index) => (
            index === 0 ? 'volatile_blob() AS c0' : `NULL AS c${index}`
        ));
        const query = buildCellContainmentQuery(
            `SELECT ${sourceColumns.join(', ')}`,
            2000,
            {
                limit: 1,
                maxInlineCellBytes: 1024 * 1024,
                maxPageResponseBytes: 16 * 1024 * 1024
            }
        );
        let evaluations = 0;
        const database = new DatabaseSync(':memory:');
        try {
            database.function('volatile_blob', () => {
                evaluations += 1;
                const byteLength = evaluations === 1
                    ? query.effectiveInlineCellBytes + 1
                    : 1;
                return Buffer.alloc(byteLength, 0x41);
            });
            const executeRows = (sql: string): unknown[][] => {
                const statement = database.prepare(sql);
                statement.setReturnArrays(true);
                return statement.all() as unknown as unknown[][];
            };
            const primaryRows = executeRows(query.sql);
            const metadataRows = query.metadataSql
                ? executeRows(query.metadataSql)
                : undefined;
            const transportedRows = mergeCellContainmentMetadataRows(
                primaryRows,
                metadataRows,
                query
            );
            const decoded = decodeCellContainment(
                transportedRows,
                2000,
                undefined,
                16 * 1024 * 1024
            );

            assert.strictEqual(evaluations, 1);
            assert.strictEqual(
                (decoded.rows[0][0] as Uint8Array).byteLength,
                query.effectiveInlineCellBytes
            );
            assert.deepStrictEqual(decoded.oversizedCells, {
                0: {
                    0: {
                        storageClass: 'blob',
                        byteLength: query.effectiveInlineCellBytes + 1
                    }
                }
            });
        } finally {
            database.close();
        }
    });

    it('evaluates a source that ends with OFFSET once per row without its own wrapper', async () => {
        const { buildCellContainmentQuery, decodeCellContainment } = await loadContainmentModule();
        const { assembleKeysetSelect } = await import('../../src/core/keyset-pagination');
        const database = new DatabaseSync(':memory:');
        try {
            database.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, v BLOB); INSERT INTO t VALUES (1, x'00'), (2, x'00'), (3, x'00')");
            let evaluations = 0;
            database.function('volatile_blob', { deterministic: false }, () => {
                evaluations += 1;
                return Buffer.alloc(evaluations % 2 ? 900 : 1, 0x41);
            });
            const keyset = (mode: 'first' | 'last') => assembleKeysetSelect({
                selectListSql: '"k", volatile_blob() AS "v"',
                escapedTable: '"t"',
                whereClauses: [],
                filterParams: [],
                plan: { mode, keyColumns: ['k'], direction: 'ASC', limit: 3 } as any
            }).sql;
            const sources = [
                'SELECT "k", volatile_blob() AS "v" FROM "t" ORDER BY "k" LIMIT 3 OFFSET 0',
                keyset('first'),
                keyset('last')
            ];
            for (const source of sources) {
                const query = buildCellContainmentQuery(
                    source, 2, { limit: 3, maxInlineCellBytes: 64, maxPageResponseBytes: 1024 }, [], 'blob', false, true
                );
                assert.ok(query.sql.includes(`AS (\n${source}\n)\n`), 'the source runs without the wrapper');
                evaluations = 0;
                const statement = database.prepare(query.sql);
                statement.setReturnArrays(true);
                const decoded = decodeCellContainment(statement.all() as unknown as unknown[][], 2, undefined, 1024);
                // Flattening would evaluate the call once per reference.
                assert.strictEqual(evaluations, 3, source);
                for (const [rowIndex, row] of decoded.rows.entries()) {
                    const byteLength = decoded.oversizedCells?.[rowIndex]?.[1]?.byteLength
                        ?? (row[1] as Uint8Array).byteLength;
                    assert.ok(byteLength === 900 || byteLength === 1, `${source}: row ${rowIndex}`);
                    if (byteLength === 900) assert.strictEqual((row[1] as Uint8Array).byteLength, query.effectiveInlineCellBytes);
                }
            }
            assert.throws(
                () => buildCellContainmentQuery('SELECT 1 LIMIT 1', 1, { limit: 1 }, [], 'blob', false, true),
                /does not end with an OFFSET clause/
            );
        } finally {
            database.close();
        }
    });

    it('downgrades the payload tail after actual UTF-8 bytes exhaust the page budget', async () => {
        const { decodeCellContainment } = await loadContainmentModule();
        const decoded = decodeCellContainment([
            ['early', ''],
            ['😀', ''],
            ['late', ''],
            ['x', '']
        ], 1, undefined, 9);

        assert.deepStrictEqual(decoded.rows, [['early'], ['😀'], [''], ['']]);
        assert.deepStrictEqual(decoded.oversizedCells, {
            2: { 0: { storageClass: 'text', byteLength: 4 } },
            3: { 0: { storageClass: 'text', byteLength: 1 } }
        });
        assert.strictEqual(
            decoded.rows.reduce(
                (total: number, row: string[]) => total + Buffer.byteLength(row[0]),
                0
            ),
            9
        );
    });

    it('keeps the 32 MiB aggregate transport guard unreachable for contained pages', async () => {
        const { decodeCellContainment } = await loadContainmentModule();
        const rowCount = 5000;
        const columnCount = 50;
        const value = new Uint8Array(256);
        const packedMetadata = Array(columnCount).fill('b257').join('|');
        const transportedRow = [...Array(columnCount).fill(value), packedMetadata];
        const decoded = decodeCellContainment(
            Array(rowCount).fill(transportedRow),
            columnCount,
            undefined,
            16 * 1024 * 1024
        );
        const response = {
            channel: 'rpc',
            content: {
                kind: 'response',
                messageId: 'contained-wide-grid',
                success: true,
                data: {
                    headers: Array.from(
                        { length: columnCount },
                        (_, column) => `column_${column}`
                    ),
                    rows: decoded.rows,
                    oversizedCells: decoded.oversizedCells
                }
            }
        };

        assert.doesNotThrow(() => assertWebviewTransportPayload(
            response,
            { surface: WEBVIEW_TRANSPORT_SURFACES.hostResponse }
        ));
    });

    it('bounds percent-expanded WITHOUT ROWID identities inside the host response budget', async () => {
        const {
            decodeCellContainment,
            remapPrimaryKeyContainment
        } = await loadContainmentModule();
        const rowCount = 16;
        const primaryKeyBytes = 1024 * 1024 - 1024;
        const keyTail = ' '.repeat(primaryKeyBytes - 2);
        const transportedRows = Array.from({ length: rowCount }, (_, rowIndex) => [
            'visible',
            `${String(rowIndex).padStart(2, '0')}${keyTail}`,
            '|'
        ]);
        const decoded = decodeCellContainment(
            transportedRows,
            2,
            undefined,
            16 * 1024 * 1024
        );
        const remapped = remapPrimaryKeyContainment({
            identity: {
                kind: 'primaryKey',
                columns: [{ identifier: 'key', declaredType: 'TEXT', position: 1 }]
            },
            sourceColumns: ['value', 'key'],
            visibleColumnCount: 1,
            identityRows: decoded.rows,
            rawTextBytes: decoded.rows.map((row: unknown[]) => [
                new TextEncoder().encode(String(row[1]))
            ]),
            rawTextColumnIndices: [1],
            textEncoding: 'utf-8',
            rows: decoded.rows,
            oversizedCells: decoded.oversizedCells,
            exactIntegerTexts: decoded.exactIntegerTexts,
            effectiveInlineCellBytes: 1024 * 1024
        });
        const response = {
            channel: 'rpc',
            content: {
                kind: 'response',
                messageId: 'contained-primary-key-identities',
                success: true,
                data: {
                    headers: ['rowid', 'value'],
                    rows: remapped.rows,
                    oversizedCells: remapped.oversizedCells,
                    exactIntegerTexts: remapped.exactIntegerTexts,
                    readOnlyRowReasons: remapped.readOnlyRowReasons
                }
            }
        };

        assert.match(String(remapped.rows[0][0]), /^pk:/);
        assert.strictEqual(String(remapped.rows.at(-1)?.[0]).startsWith('readonly-pk:'), true);
        assert.ok(Object.keys(remapped.readOnlyRowReasons ?? {}).length > 0);
        assert.doesNotThrow(() => assertWebviewTransportPayload(
            response,
            { surface: WEBVIEW_TRANSPORT_SURFACES.hostResponse }
        ));
    });

    it('returns the same REAL text from the containment statement as from a second numeric layer', async () => {
        const { buildCellContainmentQuery } = await loadContainmentModule();
        const { buildExactNumericTextQuery, normalizeIntegerRowsForTransport } =
            await import('../../src/core/integer-utils.ts');
        const database = new DatabaseSync(':memory:');
        try {
            database.exec('CREATE TABLE t (r REAL, i INTEGER, s TEXT, b BLOB, n)');
            database.exec(
                "INSERT INTO t VALUES " +
                "(0.1, 9007199254740993, 'short', x'00ff', NULL), " +
                "(1.0 / 3, -1, printf('%.*c', 600, 'é'), zeroblob(700), 2.5), " +
                "(1e300, 0, 'x', NULL, -0.0), " +
                "(2.0, NULL, NULL, x'', 'text in an untyped column')"
            );
            const execute = (sql: string): unknown[][] => {
                const statement = database.prepare(sql);
                statement.setReturnArrays(true);
                statement.setReadBigInts(true);
                return statement.all() as unknown as unknown[][];
            };
            const source = 'SELECT r, i, s, b, n FROM t ORDER BY rowid';
            const options = { limit: 4, maxInlineCellBytes: 300, maxPageResponseBytes: 16 * 1024 * 1024 };
            const rawColumns = [0, 1, 2, 3, 4];
            const merged = buildCellContainmentQuery(source, 5, options, rawColumns, 'blob', true);
            const plain = buildCellContainmentQuery(source, 5, options, rawColumns, 'blob');
            const layered = buildExactNumericTextQuery(plain.sql, plain.primaryTransportColumnCount);

            assert.strictEqual(plain.numericTransport.valueColumnCount, undefined);
            assert.strictEqual(merged.numericTransport.valueColumnCount, merged.primaryTransportColumnCount);
            assert.strictEqual(merged.numericTransport.realTextColumnCount, 5);
            assert.strictEqual(
                merged.numericTransport.transportColumns.length,
                merged.primaryTransportColumnCount + 5
            );
            const fromMerged = normalizeIntegerRowsForTransport(
                execute(merged.sql),
                merged.numericTransport.valueColumnCount,
                undefined,
                undefined,
                merged.numericTransport.realTextColumnCount
            );
            const fromLayered = normalizeIntegerRowsForTransport(
                execute(layered.sql),
                layered.valueColumnCount
            );
            assert.deepStrictEqual(fromMerged, fromLayered);
            // SQLite 3.53 prints 1/3 with 17 digits where 3.50 printed 15.
            const third = (database.prepare('SELECT CAST(1.0 / 3 AS TEXT) AS t').get() as { t: string }).t;
            assert.deepStrictEqual(fromMerged.exactIntegerTexts, {
                0: { 1: '9007199254740993' },
                1: { 0: third },
                2: { 0: '1.0e+300', 4: '0.0' },
                3: { 0: '2.0' }
            });
            // The oversized TEXT and BLOB of row 1 keep their metadata.
            assert.deepStrictEqual(
                fromMerged.rows.map(row => row[merged.metadataColumnIndex]),
                ['||||', '||t1200|b700|', '||||', '||||']
            );
        } finally {
            database.close();
        }
    });

    it('reports an oversized cell in any metadata chunk of a wide row', async () => {
        const { buildCellContainmentQuery, decodeCellContainment } = await loadContainmentModule();
        const database = new DatabaseSync(':memory:');
        try {
            const columns = Array.from({ length: 450 }, (_, index) => (
                index === 420 ? `zeroblob(5000) AS c${index}` : `${index} AS c${index}`
            ));
            const query = buildCellContainmentQuery(`SELECT ${columns.join(', ')}`, 450, {
                limit: 1, maxInlineCellBytes: 1024, maxPageResponseBytes: 16 * 1024 * 1024
            });
            const statement = database.prepare(query.sql);
            statement.setReturnArrays(true);
            const rows = statement.all() as unknown as unknown[][];
            const decoded = decodeCellContainment(rows, 450, undefined, 16 * 1024 * 1024);
            assert.deepStrictEqual(decoded.oversizedCells, {
                0: { 420: { storageClass: 'blob', byteLength: 5000 } }
            });
        } finally {
            database.close();
        }
    });

    it('keeps 5000 rows of 50 ordinary UUID cells inline through SQLite', async () => {
        const rowCount = 5000;
        const columnCount = 50;
        const columns = Array.from({ length: columnCount }, (_, index) => `c${index}`);
        const uuid = '550e8400-e29b-41d4-a716-446655440000';
        const result = await createDatabaseEngine({ content: null, maxSize: 0 });
        const engine = result.operations!;
        try {
            await engine.executeQuery(
                'CREATE TABLE ordinary_wide_page (' +
                columns.map(column => `"${column}" TEXT`).join(', ') +
                '); WITH RECURSIVE rows(value) AS (' +
                `VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < ${rowCount}` +
                ') INSERT INTO ordinary_wide_page SELECT ' +
                columns.map(() => `'${uuid}'`).join(', ') +
                ' FROM rows'
            );
            const page = await engine.fetchTableData('ordinary_wide_page', {
                columns: ['rowid', ...columns],
                orderBy: 'rowid',
                limit: rowCount,
                offset: 0,
                maxInlineCellBytes: 1024 * 1024,
                maxPageResponseBytes: 16 * 1024 * 1024
            });

            assert.strictEqual(page.rows.length, rowCount);
            assert.strictEqual(page.rows[0].length, columnCount + 1);
            assert.strictEqual(page.rows[0][1], uuid);
            assert.strictEqual(page.rows.at(-1)?.at(-1), uuid);
            assert.strictEqual(page.oversizedCells, undefined);
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    for (const declaredColumnCount of [1999, 2000]) {
        for (const withoutRowId of [false, true]) {
            const tableKind = withoutRowId ? 'WITHOUT ROWID' : 'rowid';
            it(`loads a ${declaredColumnCount}-column ${tableKind} table at SQLite's result-width boundary`, async () => {
                const columns = Array.from(
                    { length: declaredColumnCount },
                    (_, index) => `c${index}`
                );
                const table = `containment_width_${declaredColumnCount}_${withoutRowId ? 'pk' : 'rowid'}`;
                const result = await createDatabaseEngine({ content: null, maxSize: 0 });
                const engine = result.operations!;
                try {
                    const definitions = columns.map((column, index) => (
                        withoutRowId && index === 0
                            ? `"${column}" INTEGER PRIMARY KEY`
                            : `"${column}" TEXT`
                    ));
                    await engine.executeQuery(
                        `CREATE TABLE "${table}" (${definitions.join(', ')})` +
                        `${withoutRowId ? ' WITHOUT ROWID' : ''}; ` +
                        `INSERT INTO "${table}" ("c0", "c${declaredColumnCount - 1}") ` +
                        `VALUES (1, 'last')`
                    );

                    const page = await engine.fetchTableData(table, {
                        columns: ['rowid', ...columns],
                        globalFilterColumns: columns,
                        limit: 1,
                        offset: 0
                    });

                    assert.strictEqual(page.headers.length, declaredColumnCount + 1);
                    assert.strictEqual(page.rows[0].length, declaredColumnCount + 1);
                    assert.strictEqual(page.rows[0][1], withoutRowId ? 1 : '1');
                    assert.strictEqual(page.rows[0][declaredColumnCount], 'last');
                    if (withoutRowId) {
                        assert.match(String(page.rows[0][0]), /^(?:pk|readonly-pk):/);
                    } else {
                        assert.strictEqual(page.rows[0][0], 1);
                    }
                } finally {
                    (engine as WasmDatabaseEngine).shutdown();
                }
            });
        }
    }

    it('fails closed instead of exceeding SQLite result width for a 1000-column key', async () => {
        const { buildCellContainmentQuery } = await loadContainmentModule();
        const keyColumns = Array.from({ length: 1000 }, (_, index) => index);
        const query = buildCellContainmentQuery(
            'SELECT * FROM "wide_key"',
            1000,
            { limit: 1 },
            keyColumns
        );

        assert.strictEqual(query.transportColumnCount, 1001);
        assert.strictEqual(query.rawTextColumnCount, 0);
        assert.strictEqual(query.rawTextValidationUnavailable, true);
    });

    it('returns bounded WASM previews and exact sparse metadata without changing small DTOs', async () => {
        const result = await createDatabaseEngine({ content: null, maxSize: 0 });
        const engine = result.operations!;
        try {
            await engine.executeQuery(
                'CREATE TABLE contained_cells (text_value TEXT, blob_value BLOB); ' +
                "INSERT INTO contained_cells VALUES ('😀😀😀', x'000102030405060708090a0b'); " +
                "INSERT INTO contained_cells VALUES ('ok', x'0102')"
            );
            const page = await engine.fetchTableData('contained_cells', {
                columns: ['rowid', 'text_value', 'blob_value'],
                orderBy: 'rowid',
                limit: 2,
                offset: 0,
                maxInlineCellBytes: 8,
                maxPageResponseBytes: 64
            });

            assert.deepStrictEqual(page.rows[0], [
                1,
                '😀😀',
                Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])
            ]);
            assert.deepStrictEqual(page.rows[1], [2, 'ok', Uint8Array.from([1, 2])]);
            assert.deepStrictEqual(page.oversizedCells, {
                0: {
                    1: { storageClass: 'text', byteLength: 12 },
                    2: { storageClass: 'blob', byteLength: 12 }
                }
            });

            const small = await engine.fetchTableData('contained_cells', {
                columns: ['rowid', 'text_value', 'blob_value'],
                filters: [{ column: 'text_value', value: 'ok' }],
                limit: 1,
                offset: 0,
                maxInlineCellBytes: 8,
                maxPageResponseBytes: 64
            });
            // Keyset anchors are the one deliberate DTO addition: every rowid
            // grid page re-anchors itself for seek pagination.
            const { keysetAnchors, ...smallDto } = small;
            assert.ok(keysetAnchors?.first && keysetAnchors?.last);
            assert.deepStrictEqual(smallDto, {
                headers: ['rowid', 'text_value', 'blob_value'],
                rows: [[2, 'ok', Uint8Array.from([1, 2])]],
                columns: ['rowid', 'text_value', 'blob_value'],
                values: [[2, 'ok', Uint8Array.from([1, 2])]],
                exactIntegerTexts: undefined
            });
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('filters and orders on original values instead of their previews', async () => {
        const result = await createDatabaseEngine({ content: null, maxSize: 0 });
        const engine = result.operations!;
        try {
            await engine.executeQuery(
                'CREATE TABLE original_cell_semantics (payload TEXT); ' +
                "INSERT INTO original_cell_semantics VALUES ('zzzzzz-needle'), ('aaaaaa-needle')"
            );
            const page = await engine.fetchTableData('original_cell_semantics', {
                columns: ['rowid', 'payload'],
                filters: [{ column: 'payload', value: 'needle' }],
                orderBy: 'payload',
                orderDir: 'ASC',
                limit: 2,
                offset: 0,
                maxInlineCellBytes: 4,
                maxPageResponseBytes: 64
            });

            assert.deepStrictEqual(page.rows.map(row => row[0]), [2, 1]);
            assert.deepStrictEqual(page.rows.map(row => row[1]), ['a', 'z']);
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });
});
