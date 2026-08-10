
import './vscode_mock_setup'; // Must be first
import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {
    exportToJson,
    exportToCsv,
    exportToSql,
    exportTableCommand,
    exportTableToLocalFileForTests,
    EXPORT_CELL_CHUNK_BYTES,
    getFormatHelper,
    streamTableExport
} from '../../src/tableExporter';
import { CellValue, DatabaseOperations, ExportOptions, RecordId } from '../../src/core/types';
import { mockVscode } from './mocks/vscode';
import { DocumentRegistry } from '../../src/documentRegistry';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { serializeOperations } from '../../src/core/operation-serializer';

async function collectStreamingExport(
    operations: DatabaseOperations,
    table: string,
    columns: string[],
    options: ExportOptions,
    cancellation?: Parameters<typeof streamTableExport>[5]
): Promise<{ content: string; chunks: string[]; rowCount: number }> {
    const chunks: string[] = [];
    const rowCount = await streamTableExport(
        operations,
        table,
        columns,
        options,
        {
            write: async (chunk: string) => {
                chunks.push(chunk);
            }
        },
        cancellation
    );
    return { content: chunks.join(''), chunks, rowCount };
}

describe('streamTableExport golden parity', () => {
    it('emits headers for empty CSV/Excel results and preserves JSON/SQL empty shapes', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery('CREATE TABLE stage_e_empty (id INTEGER, name TEXT)');

        try {
            const csv = await collectStreamingExport(
                operations,
                'stage_e_empty',
                ['id', 'name'],
                { format: 'csv' }
            );
            const excel = await collectStreamingExport(
                operations,
                'stage_e_empty',
                ['id', 'name'],
                { format: 'excel' }
            );
            const json = await collectStreamingExport(
                operations,
                'stage_e_empty',
                ['id', 'name'],
                { format: 'json' }
            );
            const sql = await collectStreamingExport(
                operations,
                'stage_e_empty',
                ['id', 'name'],
                { format: 'sql' }
            );

            assert.deepStrictEqual(
                [csv.content, excel.content, json.content, sql.content],
                ['id,name', '\uFEFFid,name', '[]', '']
            );
            assert.deepStrictEqual(
                [csv.rowCount, excel.rowCount, json.rowCount, sql.rowCount],
                [0, 0, 0, 0]
            );
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('exports exact signed int64 bytes through CSV, Excel, JSON, and SQL', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery(
            'CREATE TABLE stage_e_int64 (value); ' +
            'INSERT INTO stage_e_int64 VALUES ' +
            '(9007199254740993), (9223372036854775807), (-9223372036854775808)'
        );
        const decimalLines =
            '9007199254740993\n' +
            '9223372036854775807\n' +
            '-9223372036854775808';

        try {
            const csv = await collectStreamingExport(
                operations,
                'stage_e_int64',
                ['value'],
                { format: 'csv' }
            );
            assert.strictEqual(csv.content, `value\n${decimalLines}`);

            const excel = await collectStreamingExport(
                operations,
                'stage_e_int64',
                ['value'],
                { format: 'excel' }
            );
            assert.strictEqual(excel.content, `\uFEFFvalue\n${decimalLines}`);

            const json = await collectStreamingExport(
                operations,
                'stage_e_int64',
                ['value'],
                { format: 'json' }
            );
            assert.strictEqual(
                json.content,
                '[\n' +
                '  {\n    "value": 9007199254740993\n  },\n' +
                '  {\n    "value": 9223372036854775807\n  },\n' +
                '  {\n    "value": -9223372036854775808\n  }\n' +
                ']'
            );

            const sql = await collectStreamingExport(
                operations,
                'stage_e_int64',
                ['value'],
                { format: 'sql' }
            );
            assert.strictEqual(
                sql.content,
                'INSERT INTO "stage_e_int64" ("value") VALUES (9007199254740993);\n' +
                'INSERT INTO "stage_e_int64" ("value") VALUES (9223372036854775807);\n' +
                'INSERT INTO "stage_e_int64" ("value") VALUES (-9223372036854775808);'
            );

            await operations.executeQuery('CREATE TABLE stage_e_int64_copy (value)');
            await operations.executeQuery(
                sql.content.replaceAll('"stage_e_int64"', '"stage_e_int64_copy"')
            );
            const restored = await operations.executeQuery(
                'SELECT typeof(value), CAST(value AS TEXT) FROM stage_e_int64_copy ORDER BY rowid'
            );
            assert.deepStrictEqual(restored[0].rows, [
                ['integer', '9007199254740993'],
                ['integer', '9223372036854775807'],
                ['integer', '-9223372036854775808']
            ]);
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    for (const testCase of [
        {
            format: 'csv' as const,
            expected: 'value\n[SQLite TEXT bytes; encoding=utf-8; base64=gA==]'
        },
        {
            format: 'excel' as const,
            expected: '\uFEFFvalue\n[SQLite TEXT bytes; encoding=utf-8; base64=gA==]'
        },
        {
            format: 'json' as const,
            expected:
                '[\n' +
                '  {\n' +
                '    "value": {"$sqliteExplorerTextBytes":{"encoding":"utf-8","base64":"gA=="}}\n' +
                '  }\n' +
                ']'
        },
        {
            format: 'sql' as const,
            expected: 'INSERT INTO "stage_e_invalid_text" ("value") VALUES (CAST(X\'80\' AS TEXT));'
        }
    ]) {
        it(`exports unrepresentable TEXT bytes faithfully in ${testCase.format.toUpperCase()}`, async () => {
            const database = await createDatabaseEngine({
                content: null,
                maxSize: 0,
                readOnlyMode: false
            });
            const operations = database.operations!;
            await operations.executeQuery(
                'CREATE TABLE stage_e_invalid_text (value TEXT); ' +
                "INSERT INTO stage_e_invalid_text VALUES (CAST(X'80' AS TEXT))"
            );

            try {
                const exported = await collectStreamingExport(
                    operations,
                    'stage_e_invalid_text',
                    ['value'],
                    { format: testCase.format }
                );
                assert.strictEqual(exported.content, testCase.expected);

                if (testCase.format === 'sql') {
                    await operations.executeQuery(
                        'CREATE TABLE stage_e_invalid_text_copy (value TEXT)'
                    );
                    await operations.executeQuery(
                        exported.content.replace(
                            '"stage_e_invalid_text"',
                            '"stage_e_invalid_text_copy"'
                        )
                    );
                    const restored = await operations.executeQuery(
                        'SELECT typeof(value), hex(CAST(value AS BLOB)) ' +
                        'FROM stage_e_invalid_text_copy'
                    );
                    assert.deepStrictEqual(restored[0].rows, [['text', '80']]);
                }
            } finally {
                (operations as WasmDatabaseEngine).shutdown();
            }
        });
    }

    it('preserves bounded CSV, JSON, and SQL bytes including options and NUL text', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery(
            'CREATE TABLE stage_e_golden (' +
            'id INTEGER, name TEXT, note TEXT, payload BLOB, nul TEXT, nullable)'
        );
        await operations.executeQuery(
            'INSERT INTO stage_e_golden VALUES (?, ?, ?, ?, CAST(? AS TEXT), ?), ' +
            '(?, ?, ?, ?, ?, ?)',
            [
                1,
                'Alice',
                'comma, "quote"\nline',
                new Uint8Array([0, 1, 2, 253, 254, 255]),
                new TextEncoder().encode('before\0after'),
                null,
                2,
                "O'Reilly 😀",
                'plain',
                new Uint8Array(),
                'ok',
                3.5
            ]
        );
        const columns = ['id', 'name', 'note', 'payload', 'nul', 'nullable'];
        const boundedRows: CellValue[][] = [
            [
                1,
                'Alice',
                'comma, "quote"\nline',
                new Uint8Array([0, 1, 2, 253, 254, 255]),
                'before\0after',
                null
            ],
            [2, "O'Reilly 😀", 'plain', new Uint8Array(), 'ok', 3.5]
        ];

        try {
            const csv = await collectStreamingExport(
                operations,
                'stage_e_golden',
                columns,
                { format: 'csv', header: true }
            );
            assert.strictEqual(csv.rowCount, 2);
            assert.strictEqual(csv.content, exportToCsv(columns, boundedRows, true));
            assert.strictEqual(
                csv.content,
                'id,name,note,payload,nul,nullable\n' +
                '1,Alice,"comma, ""quote""\nline",[BLOB],before\0after,\n' +
                "2,O'Reilly 😀,plain,[BLOB],ok,3.5"
            );

            const csvWithoutHeader = await collectStreamingExport(
                operations,
                'stage_e_golden',
                columns,
                { format: 'csv', header: false }
            );
            assert.strictEqual(
                csvWithoutHeader.content,
                exportToCsv(columns, boundedRows, false)
            );
            assert.strictEqual(
                csvWithoutHeader.content,
                '1,Alice,"comma, ""quote""\nline",[BLOB],before\0after,\n' +
                "2,O'Reilly 😀,plain,[BLOB],ok,3.5"
            );

            const json = await collectStreamingExport(
                operations,
                'stage_e_golden',
                columns,
                { format: 'json' }
            );
            assert.strictEqual(json.content, exportToJson(columns, boundedRows));
            assert.strictEqual(
                json.content,
                '[\n' +
                '  {\n' +
                '    "id": 1,\n' +
                '    "name": "Alice",\n' +
                '    "note": "comma, \\"quote\\"\\nline",\n' +
                '    "payload": "AAEC/f7/",\n' +
                '    "nul": "before\\u0000after",\n' +
                '    "nullable": null\n' +
                '  },\n' +
                '  {\n' +
                '    "id": 2,\n' +
                '    "name": "O\'Reilly 😀",\n' +
                '    "note": "plain",\n' +
                '    "payload": "",\n' +
                '    "nul": "ok",\n' +
                '    "nullable": 3.5\n' +
                '  }\n' +
                ']'
            );

            const sql = await collectStreamingExport(
                operations,
                'stage_e_golden',
                columns,
                { format: 'sql', includeTableName: true }
            );
            assert.strictEqual(
                sql.content,
                exportToSql('stage_e_golden', columns, boundedRows, true)
            );
            assert.strictEqual(
                sql.content,
                'INSERT INTO "stage_e_golden" ("id", "name", "note", "payload", "nul", "nullable") ' +
                'VALUES (1, \'Alice\', \'comma, "quote"\nline\', X\'000102fdfeff\', ' +
                'CAST(X\'6265666f7265006166746572\' AS TEXT), NULL);\n' +
                'INSERT INTO "stage_e_golden" ("id", "name", "note", "payload", "nul", "nullable") ' +
                'VALUES (2, \'O\'\'Reilly 😀\', \'plain\', X\'\', \'ok\', 3.5);'
            );

            const sqlWithoutTableName = await collectStreamingExport(
                operations,
                'stage_e_golden',
                ['id'],
                { format: 'sql', includeTableName: false }
            );
            assert.strictEqual(
                sqlWithoutTableName.content,
                exportToSql('stage_e_golden', ['id'], [[1], [2]], false)
            );
            assert.strictEqual(
                sqlWithoutTableName.content,
                'INSERT INTO table_name ("id") VALUES (1);\n' +
                'INSERT INTO table_name ("id") VALUES (2);'
            );
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('round-trips desktop SQL and JSON exports across BLOB, embedded NUL text, and int64 cells', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery(
            'CREATE TABLE desktop_roundtrip (payload BLOB, nul_text TEXT, exact_int INTEGER)'
        );
        await operations.executeQuery(
            'INSERT INTO desktop_roundtrip VALUES (?, CAST(? AS TEXT), 9007199254740993)',
            [new Uint8Array([0, 1, 2, 253, 254, 255]), new TextEncoder().encode('before\0after')]
        );

        const assertRestored = async (table: string) => {
            const restored = await operations.executeQuery(
                `SELECT hex(payload), hex(CAST(nul_text AS BLOB)), typeof(exact_int), ` +
                `CAST(exact_int AS TEXT) FROM "${table}"`
            );
            assert.deepStrictEqual(restored[0].rows, [[
                '000102FDFEFF',
                '6265666F7265006166746572',
                'integer',
                '9007199254740993'
            ]]);
        };

        try {
            const sql = await collectStreamingExport(
                operations,
                'desktop_roundtrip',
                ['payload', 'nul_text', 'exact_int'],
                { format: 'sql' }
            );
            await operations.executeQuery(
                'CREATE TABLE desktop_sql_copy (payload BLOB, nul_text TEXT, exact_int INTEGER)'
            );
            await operations.executeQuery(
                sql.content.replaceAll('"desktop_roundtrip"', '"desktop_sql_copy"')
            );
            await assertRestored('desktop_sql_copy');

            const json = await collectStreamingExport(
                operations,
                'desktop_roundtrip',
                ['payload', 'nul_text', 'exact_int'],
                { format: 'json' }
            );
            assert.match(json.content, /"exact_int": 9007199254740993/);
            const [row] = JSON.parse(json.content);
            await operations.executeQuery(
                'CREATE TABLE desktop_json_copy (payload BLOB, nul_text TEXT, exact_int INTEGER)'
            );
            await operations.executeQuery(
                'INSERT INTO desktop_json_copy VALUES ' +
                '(?, CAST(? AS TEXT), json_extract(?, \'$[0].exact_int\'))',
                [
                    new Uint8Array(Buffer.from(row.payload, 'base64')),
                    new TextEncoder().encode(row.nul_text),
                    json.content
                ]
            );
            await assertRestored('desktop_json_copy');
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('matches legacy JSON key ordering and __proto__ handling', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery(
            'CREATE TABLE stage_e_json_keys ("__proto__" TEXT, "1" TEXT, normal TEXT)'
        );
        await operations.executeQuery(
            'INSERT INTO stage_e_json_keys VALUES (?, ?, ?)',
            ['ignored-by-legacy-object', 'integer-key', 'normal-value']
        );
        const columns = ['normal', '__proto__', '1', 'normal'];

        try {
            const exported = await collectStreamingExport(
                operations,
                'stage_e_json_keys',
                columns,
                { format: 'json' }
            );
            assert.strictEqual(
                exported.content,
                exportToJson(
                    columns,
                    [[
                        'normal-value',
                        'ignored-by-legacy-object',
                        'integer-key',
                        'normal-value'
                    ]]
                )
            );
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });
});

describe('streamTableExport cell boundaries', () => {
    const readonlyPrimaryKeyExportTable = 'stage_e_readonly_pk_stream';
    const oversizedReadonlyRowText =
        'readonly-payload|' + 'x'.repeat(EXPORT_CELL_CHUNK_BYTES + 17);
    const bindableReadonlyExportRows = Array.from({ length: 128 }, (_, index) => ({
        label: `bindable-${String(index).padStart(3, '0')}`,
        payload: `selected-safe-${String(index).padStart(3, '0')}`
    }));
    const allReadonlyExportRows = [
        ...bindableReadonlyExportRows,
        { label: 'readonly', payload: oversizedReadonlyRowText }
    ];

    async function createReadonlyPrimaryKeyExportFixture(
        operations: DatabaseOperations
    ): Promise<RecordId> {
        const oversizedPrimaryKey = 'readonly-key|' + 'k'.repeat(256 * 1024);
        await operations.executeQuery(
            `CREATE TABLE ${readonlyPrimaryKeyExportTable} (` +
            'key TEXT PRIMARY KEY, label TEXT, payload TEXT' +
            ') WITHOUT ROWID'
        );
        await operations.executeQuery(
            `WITH RECURSIVE rows(id) AS (` +
            'VALUES(0) UNION ALL SELECT id + 1 FROM rows WHERE id < 127' +
            `) INSERT INTO ${readonlyPrimaryKeyExportTable} ` +
            "SELECT printf('key-%03d', id), printf('bindable-%03d', id), " +
            "printf('selected-safe-%03d', id) FROM rows"
        );
        await operations.executeQuery(
            `INSERT INTO ${readonlyPrimaryKeyExportTable} VALUES (?, ?, ?)`,
            [oversizedPrimaryKey, 'readonly', oversizedReadonlyRowText]
        );

        const page = await operations.fetchTableData(readonlyPrimaryKeyExportTable, {
            columns: ['rowid', 'label'],
            orderBy: 'rowid',
            orderDir: 'ASC',
            limit: 256,
            offset: 0,
            keyset: { mode: 'first' },
            maxInlineCellBytes: 1024 * 1024,
            maxPageResponseBytes: 16 * 1024 * 1024
        });
        const bindableRow = page.rows.find(row => row[1] === 'bindable-000');
        const readonlyRow = page.rows.find(row => row[1] === 'readonly');
        assert.ok(bindableRow && readonlyRow);
        assert.match(String(bindableRow[0]), /^pk:/);
        assert.match(String(readonlyRow[0]), /^readonly-pk:/);
        return bindableRow[0] as RecordId;
    }

    for (const testCase of [
        {
            format: 'csv' as const,
            expected:
                'label,payload\n' +
                allReadonlyExportRows.map(row => `${row.label},${row.payload}`).join('\n')
        },
        {
            format: 'excel' as const,
            expected:
                '\uFEFFlabel,payload\n' +
                allReadonlyExportRows.map(row => `${row.label},${row.payload}`).join('\n')
        },
        {
            format: 'json' as const,
            expected: JSON.stringify(allReadonlyExportRows, null, 2)
        },
        {
            format: 'sql' as const,
            expected: allReadonlyExportRows.map(row => (
                `INSERT INTO "${readonlyPrimaryKeyExportTable}" ("label", "payload") ` +
                `VALUES ('${row.label}', '${row.payload}');`
            )).join('\n')
        }
    ]) {
        it(
            `streams a readonly WITHOUT ROWID row's oversized TEXT byte-faithfully in ` +
            testCase.format.toUpperCase(),
            async () => {
                const database = await createDatabaseEngine({
                    content: null,
                    maxSize: 0,
                    readOnlyMode: false
                });
                const operations = database.operations!;

                try {
                    await createReadonlyPrimaryKeyExportFixture(operations);
                    const exported = await collectStreamingExport(
                        operations,
                        readonlyPrimaryKeyExportTable,
                        ['label', 'payload'],
                        { format: testCase.format }
                    );

                    assert.strictEqual(exported.rowCount, 129);
                    assert.strictEqual(exported.content, testCase.expected);
                } finally {
                    (operations as WasmDatabaseEngine).shutdown();
                }
            }
        );
    }

    it('exports another selected row from a readonly WITHOUT ROWID table', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;

        try {
            const bindableRowId = await createReadonlyPrimaryKeyExportFixture(operations);
            const exported = await collectStreamingExport(
                operations,
                readonlyPrimaryKeyExportTable,
                ['label', 'payload'],
                { format: 'json', rowIds: [bindableRowId] }
            );

            assert.strictEqual(exported.rowCount, 1);
            assert.strictEqual(
                exported.content,
                JSON.stringify([
                    { label: 'bindable-000', payload: 'selected-safe-000' }
                ], null, 2)
            );
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('streams late-invalid TEXT bytes through lossless envelopes without leaking a decoded prefix', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        const rawText = new Uint8Array(EXPORT_CELL_CHUNK_BYTES + 1);
        rawText.fill(0x61);
        rawText[rawText.length - 1] = 0x80;
        const base64 = Buffer.from(rawText).toString('base64');
        const hex = Buffer.from(rawText).toString('hex');
        const tagged = `[SQLite TEXT bytes; encoding=utf-8; base64=${base64}]`;
        await operations.executeQuery('CREATE TABLE stage_e_late_invalid_text (value TEXT)');
        await operations.executeQuery(
            'INSERT INTO stage_e_late_invalid_text VALUES (CAST(? AS TEXT))',
            [rawText]
        );

        try {
            const csv = await collectStreamingExport(
                operations,
                'stage_e_late_invalid_text',
                ['value'],
                { format: 'csv' }
            );
            const excel = await collectStreamingExport(
                operations,
                'stage_e_late_invalid_text',
                ['value'],
                { format: 'excel' }
            );
            const json = await collectStreamingExport(
                operations,
                'stage_e_late_invalid_text',
                ['value'],
                { format: 'json' }
            );
            const sql = await collectStreamingExport(
                operations,
                'stage_e_late_invalid_text',
                ['value'],
                { format: 'sql' }
            );

            assert.strictEqual(csv.content, `value\n${tagged}`);
            assert.strictEqual(excel.content, `\uFEFFvalue\n${tagged}`);
            assert.strictEqual(
                json.content,
                '[\n' +
                '  {\n' +
                `    "value": {"$sqliteExplorerTextBytes":{"encoding":"utf-8","base64":"${base64}"}}\n` +
                '  }\n' +
                ']'
            );
            assert.strictEqual(
                sql.content,
                `INSERT INTO "stage_e_late_invalid_text" ("value") VALUES (CAST(X'${hex}' AS TEXT));`
            );
            for (const exported of [csv, excel, json, sql]) {
                assert.ok(
                    exported.chunks.every(chunk => !chunk.includes('a'.repeat(1024))),
                    'the valid first source chunk must not be emitted before decode preflight finishes'
                );
            }
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('keeps JSON base64 and escaped UTF-8 text correct across cell chunk seams', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        const blob = new Uint8Array(EXPORT_CELL_CHUNK_BYTES + 5);
        for (let index = 0; index < blob.length; index++) blob[index] = index % 251;
        // The first byte of the emoji lands at the end of one source window, so
        // both the TextDecoder carry and the incremental JSON escaper are live.
        const text = 'a'.repeat(EXPORT_CELL_CHUNK_BYTES - 1) + '😀"\\\nend';
        await operations.executeQuery('CREATE TABLE stage_e_json (payload BLOB, text_value TEXT)');
        await operations.executeQuery('INSERT INTO stage_e_json VALUES (?, ?)', [blob, text]);

        try {
            const exported = await collectStreamingExport(
                operations,
                'stage_e_json',
                ['payload', 'text_value'],
                { format: 'json' }
            );
            assert.strictEqual(
                exported.content,
                JSON.stringify([{
                    payload: Buffer.from(blob).toString('base64'),
                    text_value: text
                }], null, 2)
            );
            assert.ok(
                exported.chunks.every(chunk => chunk.length <= 1024 * 1024),
                'no individual JSON emission may grow to a cell-sized string'
            );
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('keeps SQL BLOB hex and NUL-to-UTF-8-hex output correct across chunk seams', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        const blob = new Uint8Array(EXPORT_CELL_CHUNK_BYTES + 7);
        for (let index = 0; index < blob.length; index++) blob[index] = (index * 17) % 256;
        const text = 'z'.repeat(EXPORT_CELL_CHUNK_BYTES - 1) + '\0😀tail';
        await operations.executeQuery('CREATE TABLE stage_e_sql (payload BLOB, text_value TEXT)');
        await operations.executeQuery(
            'INSERT INTO stage_e_sql VALUES (?, CAST(? AS TEXT))',
            [blob, new TextEncoder().encode(text)]
        );

        try {
            const exported = await collectStreamingExport(
                operations,
                'stage_e_sql',
                ['payload', 'text_value'],
                { format: 'sql' }
            );
            assert.strictEqual(
                exported.content,
                exportToSql('stage_e_sql', ['payload', 'text_value'], [[blob, text]])
            );
            assert.ok(
                exported.chunks.every(chunk => chunk.length <= 1024 * 1024),
                'no individual SQL hex emission may grow to a cell-sized string'
            );
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('exports CSV BLOB placeholders without returning or opening BLOB content', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        const blob = new Uint8Array(EXPORT_CELL_CHUNK_BYTES * 2);
        blob.fill(0x42);
        await operations.executeQuery('CREATE TABLE stage_e_csv (id INTEGER, payload BLOB)');
        await operations.executeQuery('INSERT INTO stage_e_csv VALUES (?, ?)', [1, blob]);
        await operations.executeQuery(
            'CREATE VIEW stage_e_csv_view AS SELECT id, payload FROM stage_e_csv'
        );

        const guardedOperations = new Proxy(operations, {
            get(target, property, receiver) {
                if (property === 'executeQuery') {
                    return async (...args: Parameters<DatabaseOperations['executeQuery']>) => {
                        const result = await target.executeQuery(...args);
                        for (const resultSet of result) {
                            for (const row of resultSet.rows) {
                                assert.ok(
                                    row.every(value => !(value instanceof Uint8Array)),
                                    'CSV row enumeration returned BLOB bytes'
                                );
                            }
                        }
                        return result;
                    };
                }
                if (property === 'openCellReadSession') {
                    return async (cellTarget: Parameters<DatabaseOperations['openCellReadSession']>[0]) => {
                        assert.notStrictEqual(
                            cellTarget.column,
                            'payload',
                            'CSV opened a BLOB content session'
                        );
                        return target.openCellReadSession(cellTarget);
                    };
                }
                const value = Reflect.get(target, property, receiver);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });

        try {
            const exported = await collectStreamingExport(
                guardedOperations,
                'stage_e_csv',
                ['id', 'payload'],
                { format: 'csv' }
            );
            assert.strictEqual(exported.content, 'id,payload\n1,[BLOB]');

            const viewExported = await collectStreamingExport(
                guardedOperations,
                'stage_e_csv_view',
                ['id', 'payload'],
                { format: 'csv' }
            );
            assert.strictEqual(viewExported.content, 'id,payload\n1,[BLOB]');
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('awaits each sink emission before producing the next chunk', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery('CREATE TABLE stage_e_backpressure (value TEXT)');
        await operations.executeQuery("INSERT INTO stage_e_backpressure VALUES ('one'), ('two')");
        let writeInFlight = false;
        const chunks: string[] = [];

        try {
            const rowCount = await streamTableExport(
                operations,
                'stage_e_backpressure',
                ['value'],
                { format: 'json' },
                {
                    write: async chunk => {
                        assert.strictEqual(writeInFlight, false, 'sink writes overlapped');
                        writeInFlight = true;
                        await new Promise(resolve => setImmediate(resolve));
                        chunks.push(chunk);
                        writeInFlight = false;
                    }
                }
            );
            assert.strictEqual(rowCount, 2);
            assert.strictEqual(chunks.join(''), JSON.stringify([{ value: 'one' }, { value: 'two' }], null, 2));
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('evaluates a volatile ordered view once for the whole streamed export', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery(
            'CREATE TABLE stage_e_volatile_source (id INTEGER PRIMARY KEY); ' +
            'INSERT INTO stage_e_volatile_source VALUES (1), (2), (3)'
        );
        let invocations = 0;
        const sqlJs = (operations as unknown as {
            instance: { create_function(name: string, callback: (id: number) => number): void };
        }).instance;
        sqlJs.create_function('__stage_e_volatile_order', (id: number) => {
            const evaluation = Math.floor(invocations++ / 3);
            return (id + evaluation) % 3;
        });
        await operations.executeQuery(
            'CREATE VIEW stage_e_volatile_view AS ' +
            'SELECT id FROM stage_e_volatile_source ' +
            'ORDER BY __stage_e_volatile_order(id)'
        );
        let openedQuerySessions = 0;
        let closedQuerySessions = 0;
        const queryReadLimits: number[] = [];
        const recordingOperations = new Proxy(operations, {
            get(target, property, receiver) {
                if (property === 'openQueryReadSession') {
                    return async (sql: string) => {
                        openedQuerySessions++;
                        return target.openQueryReadSession!(sql);
                    };
                }
                if (property === 'readQueryRows') {
                    return async (sessionId: string, maxRows: number) => {
                        queryReadLimits.push(maxRows);
                        return target.readQueryRows!(sessionId, maxRows);
                    };
                }
                if (property === 'closeQueryReadSession') {
                    return async (sessionId: string) => {
                        closedQuerySessions++;
                        return target.closeQueryReadSession!(sessionId);
                    };
                }
                const value = Reflect.get(target, property, receiver);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });

        try {
            const exported = await collectStreamingExport(
                recordingOperations,
                'stage_e_volatile_view',
                ['id'],
                { format: 'csv' }
            );
            assert.strictEqual(exported.content, 'id\n3\n1\n2');
            assert.strictEqual(exported.rowCount, 3);
            assert.strictEqual(invocations, 3, 'the view must have one SQLite evaluation pass');
            assert.strictEqual(openedQuerySessions, 1);
            assert.strictEqual(closedQuerySessions, 1);
            assert.ok(queryReadLimits.length >= 3);
            assert.ok(queryReadLimits.every(limit => limit === 1));

            invocations = 0;
            const spoolFallbackOperations = new Proxy(operations, {
                get(target, property, receiver) {
                    if (
                        property === 'openQueryReadSession'
                        || property === 'readQueryRows'
                        || property === 'closeQueryReadSession'
                    ) {
                        return undefined;
                    }
                    const value = Reflect.get(target, property, receiver);
                    return typeof value === 'function' ? value.bind(target) : value;
                }
            });
            const fallbackExport = await collectStreamingExport(
                spoolFallbackOperations,
                'stage_e_volatile_view',
                ['id'],
                { format: 'csv' }
            );
            assert.strictEqual(fallbackExport.content, 'id\n3\n1\n2');
            assert.strictEqual(fallbackExport.rowCount, 3);
            assert.strictEqual(invocations, 3, 'the spool fallback must also evaluate the view once');
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('aborts an in-flight spool inside the engine, cleans it, and releases the serializer', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery('CREATE TABLE cancelled_spool_source (value TEXT)');
        await operations.executeQuery("INSERT INTO cancelled_spool_source VALUES ('one')");
        await operations.executeQuery(
            'CREATE VIEW cancelled_spool_view AS SELECT value FROM cancelled_spool_source'
        );

        let resolveSpoolStarted!: () => void;
        const spoolStarted = new Promise<void>(resolve => { resolveSpoolStarted = resolve; });
        let cancelListener: (() => void) | undefined;
        let cancelled = false;
        let engineAbortObserved = false;
        let dropAttempts = 0;
        const cancellation = {
            get isCancellationRequested() { return cancelled; },
            onCancellationRequested(listener: () => void) {
                cancelListener = listener;
                return { dispose() { if (cancelListener === listener) cancelListener = undefined; } };
            }
        };
        const spoolOperations = new Proxy(operations, {
            get(target, property, receiver) {
                if (
                    property === 'openQueryReadSession'
                    || property === 'readQueryRows'
                    || property === 'closeQueryReadSession'
                ) {
                    return undefined;
                }
                if (property === 'executeQuery') {
                    return async (...args: Parameters<DatabaseOperations['executeQuery']>) => {
                        const sql = String(args[0]);
                        if (/^CREATE TEMP TABLE "__sqlite_explorer_export_/i.test(sql)) {
                            await target.executeQuery(sql, args[1]);
                            resolveSpoolStarted();
                            const signal = args[2];
                            if (!signal) throw new Error('spool query did not receive an AbortSignal');
                            await new Promise<void>((_resolve, reject) => {
                                signal.addEventListener('abort', () => {
                                    engineAbortObserved = true;
                                    reject(signal.reason ?? new Error('aborted'));
                                }, { once: true });
                            });
                        }
                        if (/^DROP TABLE IF EXISTS temp\."__sqlite_explorer_export_/i.test(sql)) {
                            dropAttempts++;
                        }
                        return target.executeQuery(...args);
                    };
                }
                const value = Reflect.get(target, property, receiver);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
        const serialized = serializeOperations(spoolOperations);
        const exported = collectStreamingExport(
            serialized,
            'cancelled_spool_view',
            ['value'],
            { format: 'csv' },
            cancellation
        );

        try {
            await spoolStarted;
            const queuedMutation = serialized.executeQuery(
                "INSERT INTO cancelled_spool_source VALUES ('after-cancel')"
            );
            cancelled = true;
            cancelListener?.();

            await assert.rejects(exported, /Export cancelled/);
            await queuedMutation;
            assert.strictEqual(engineAbortObserved, true);
            assert.strictEqual(dropAttempts, 1);
            assert.deepStrictEqual(
                (await operations.executeQuery(
                    "SELECT name FROM sqlite_temp_schema WHERE name LIKE '__sqlite_explorer_export_%'"
                ))[0].rows,
                []
            );
            assert.deepStrictEqual(
                (await operations.executeQuery(
                    'SELECT value FROM cancelled_spool_source ORDER BY rowid'
                ))[0].rows,
                [['one'], ['after-cancel']]
            );
        } finally {
            await exported.catch(() => {});
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('refuses selected-row export when the source has no stable row identity', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery('CREATE TABLE stage_e_view_source (value TEXT)');
        await operations.executeQuery("INSERT INTO stage_e_view_source VALUES ('one')");
        await operations.executeQuery(
            'CREATE VIEW stage_e_unstable_view AS SELECT value FROM stage_e_view_source'
        );

        try {
            await assert.rejects(
                collectStreamingExport(
                    operations,
                    'stage_e_unstable_view',
                    ['value'],
                    { format: 'json', rowIds: [1] }
                ),
                /has no stable row identity/
            );
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('chunks a selected rowid export above the SQLite bind limit without gaps or duplicates', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        const selectedRowIds: RecordId[] = Array.from(
            { length: 32_768 },
            (_, index) => 32_768 - index
        );
        // Preserve the prior IN-predicate behavior for repeated aliases while
        // forcing the duplicate to straddle the chunk boundary.
        selectedRowIds.push('1');
        await operations.executeQuery(
            'CREATE TABLE stage_e_wide_rowid_selection (value INTEGER); ' +
            'WITH RECURSIVE ids(value) AS (' +
            'VALUES(1) UNION ALL SELECT value + 1 FROM ids WHERE value < 32768' +
            ') INSERT INTO stage_e_wide_rowid_selection SELECT value FROM ids'
        );

        try {
            const exported = await collectStreamingExport(
                operations,
                'stage_e_wide_rowid_selection',
                ['value'],
                { format: 'csv', rowIds: selectedRowIds }
            );
            const values = exported.content.split('\n').slice(1);
            assert.strictEqual(exported.rowCount, 32_768);
            assert.strictEqual(values.length, 32_768);
            assert.strictEqual(new Set(values).size, 32_768);
            for (let index = 0; index < values.length; index++) {
                assert.strictEqual(values[index], String(index + 1));
            }
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('exports every declared-rowid row across duplicate 128-row batch boundaries', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery(
            'CREATE TABLE stage_e_declared_rowid (rowid INTEGER, value TEXT); ' +
            'WITH RECURSIVE rows(id) AS (' +
            'VALUES(1) UNION ALL SELECT id + 1 FROM rows WHERE id < 200' +
            ') INSERT INTO stage_e_declared_rowid ' +
            "SELECT 7, printf('row-%d', id) FROM rows"
        );

        try {
            const exported = await collectStreamingExport(
                operations,
                'stage_e_declared_rowid',
                ['rowid', 'value'],
                { format: 'csv' }
            );
            const rows = exported.content.split('\n').slice(1);
            assert.strictEqual(exported.rowCount, 200);
            assert.strictEqual(rows.length, 200);
            assert.strictEqual(new Set(rows).size, 200);
            assert.deepStrictEqual(
                [...rows].sort(),
                Array.from({ length: 200 }, (_, index) => `7,row-${index + 1}`).sort()
            );
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('does not zip a selected WITHOUT ROWID identity to values from a later snapshot', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery(
            'CREATE TABLE stage_e_pk_race (' +
            'id TEXT PRIMARY KEY, value TEXT' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO stage_e_pk_race VALUES ('a', 'selected'), ('b', 'other')"
        );
        const identityPage = await operations.fetchTableData('stage_e_pk_race', {
            columns: ['rowid', 'value'],
            orderBy: 'rowid',
            limit: 10,
            offset: 0
        });
        const selectedId = identityPage.rows[0][0];
        assert.ok(typeof selectedId === 'string' || typeof selectedId === 'number');
        let mutationInjected = false;
        const racingOperations = new Proxy(operations, {
            get(target, property, receiver) {
                if (property === 'executeQuery') {
                    return async (...args: Parameters<DatabaseOperations['executeQuery']>) => {
                        const sql = String(args[0]);
                        if (
                            !mutationInjected &&
                            sql.includes('FROM "stage_e_pk_race"') &&
                            sql.includes('__export_type_0')
                        ) {
                            mutationInjected = true;
                            await target.executeQuery(
                                "DELETE FROM stage_e_pk_race WHERE id = 'a'; " +
                                "INSERT INTO stage_e_pk_race VALUES ('c', 'unselected replacement')"
                            );
                        }
                        return target.executeQuery(...args);
                    };
                }
                const value = Reflect.get(target, property, receiver);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });

        try {
            const exported = await collectStreamingExport(
                racingOperations,
                'stage_e_pk_race',
                ['value'],
                { format: 'csv', rowIds: [selectedId] }
            );
            assert.strictEqual(mutationInjected, true);
            assert.strictEqual(exported.content, 'value');
            assert.doesNotMatch(exported.content, /other|unselected replacement/);
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('exports a selected unsafe INTEGER stored in a typeless primary key', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery(
            'CREATE TABLE stage_e_typeless_pk (' +
            'id PRIMARY KEY, value TEXT' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO stage_e_typeless_pk VALUES (9007199254740993, 'selected')"
        );
        const page = await operations.fetchTableData('stage_e_typeless_pk', {
            columns: ['rowid', 'id', 'value'],
            limit: 10,
            offset: 0
        });

        try {
            const exported = await collectStreamingExport(
                operations,
                'stage_e_typeless_pk',
                ['id', 'value'],
                { format: 'csv', rowIds: [page.rows[0][0] as string] }
            );
            assert.strictEqual(
                exported.content,
                'id,value\n9007199254740993,selected'
            );
            assert.strictEqual(exported.rowCount, 1);
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('keeps full WITHOUT ROWID export rows coherent across an equal-length ordering shift', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        const payloadFor = (id: number) => `row-${id}|`.padEnd(64 * 1024 + 1, 'x');
        const initialIds = Array.from({ length: 129 }, (_, index) => index + 2);
        await operations.executeQuery(
            'CREATE TABLE stage_e_pk_full_race (' +
            'id INTEGER PRIMARY KEY, payload TEXT, tag TEXT' +
            ') WITHOUT ROWID'
        );
        await operations.executeQuery(
            `INSERT INTO stage_e_pk_full_race VALUES ${initialIds.map(() => '(?, ?, ?)').join(', ')}`,
            initialIds.flatMap(id => [id, payloadFor(id), `row-${id}`])
        );

        let mutationInjected = false;
        let mutation: Promise<unknown> | undefined;
        let serialized!: DatabaseOperations;
        const racingOperations = new Proxy(operations, {
            get(target, property, receiver) {
                if (property === 'fetchTableData') {
                    return async (...args: Parameters<DatabaseOperations['fetchTableData']>) => {
                        const page = await target.fetchTableData(...args);
                        if (!mutationInjected && args[0] === 'stage_e_pk_full_race') {
                            mutationInjected = true;
                            // Keep 129 rows and every streamed TEXT length unchanged,
                            // but shift the first 128-row page by one key. Queue
                            // through the public facade so the export-wide
                            // snapshot lease keeps this external edit outside.
                            mutation = serialized.executeQuery(
                                'DELETE FROM stage_e_pk_full_race WHERE id = 130'
                            ).then(() => serialized.executeQuery(
                                'INSERT INTO stage_e_pk_full_race VALUES (?, ?, ?)',
                                [1, payloadFor(1), 'row-1']
                            ));
                        }
                        return page;
                    };
                }
                const value = Reflect.get(target, property, receiver);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
        serialized = serializeOperations(racingOperations);

        try {
            const exported = await collectStreamingExport(
                serialized,
                'stage_e_pk_full_race',
                ['payload', 'tag'],
                { format: 'csv' }
            );
            assert.strictEqual(mutationInjected, true);
            const rows = exported.content.split('\n').slice(1);
            assert.strictEqual(rows.length, 129);
            for (const row of rows) {
                const separator = row.lastIndexOf(',');
                const payload = row.slice(0, separator);
                const tag = row.slice(separator + 1);
                const payloadId = /^row-(\d+)\|/.exec(payload)?.[1];
                assert.strictEqual(
                    tag,
                    `row-${payloadId}`,
                    'one exported row combined a streamed identity value with another row\'s inline value'
                );
            }
            await mutation;
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('seeks across 128-row WITHOUT ROWID export boundaries without skips or duplicates', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery(
            'CREATE TABLE stage_e_pk_seek (' +
            'tenant TEXT, bucket INTEGER, sequence INTEGER, value TEXT, ' +
            'PRIMARY KEY (tenant, bucket, sequence)' +
            ') WITHOUT ROWID; ' +
            'WITH RECURSIVE rows(id) AS (' +
            'VALUES(1) UNION ALL SELECT id + 1 FROM rows WHERE id < 257' +
            ') INSERT INTO stage_e_pk_seek ' +
            "SELECT printf('tenant-%d', id % 5), id % 7, id, printf('row-%d', id) FROM rows"
        );
        const fetches: Parameters<DatabaseOperations['fetchTableData']>[1][] = [];
        const recordingOperations = new Proxy(operations, {
            get(target, property, receiver) {
                if (property === 'fetchTableData') {
                    return async (...args: Parameters<DatabaseOperations['fetchTableData']>) => {
                        if (args[0] === 'stage_e_pk_seek') fetches.push(args[1]);
                        return target.fetchTableData(...args);
                    };
                }
                const value = Reflect.get(target, property, receiver);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });

        try {
            const exported = await collectStreamingExport(
                recordingOperations,
                'stage_e_pk_seek',
                ['value'],
                { format: 'csv' }
            );
            const values = exported.content.split('\n').slice(1);
            assert.strictEqual(exported.rowCount, 257);
            assert.strictEqual(values.length, 257);
            assert.strictEqual(new Set(values).size, 257);
            assert.deepStrictEqual(
                [...values].sort(),
                Array.from({ length: 257 }, (_, index) => `row-${index + 1}`).sort()
            );

            assert.strictEqual(fetches.length, 3);
            assert.deepStrictEqual(fetches[0].keyset, { mode: 'first' });
            assert.strictEqual(fetches[1].keyset?.mode, 'after');
            assert.strictEqual(fetches[2].keyset?.mode, 'after');
            assert.ok(fetches[1].keyset?.anchor);
            assert.ok(fetches[2].keyset?.anchor);
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('keeps an oversized cell bound to the row-query snapshot across a same-length replacement', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        const oldPayload = 'old|'.padEnd(64 * 1024 + 1, 'a');
        const newPayload = 'new|'.padEnd(oldPayload.length, 'b');
        await operations.executeQuery(
            'CREATE TABLE stage_e_cell_snapshot (id INTEGER PRIMARY KEY, payload TEXT, tag TEXT)'
        );
        await operations.executeQuery(
            'INSERT INTO stage_e_cell_snapshot VALUES (1, ?, ?)',
            [oldPayload, 'old-row']
        );

        let mutationQueued = false;
        let mutation: Promise<unknown> | undefined;
        let serialized!: DatabaseOperations;
        const racingOperations = new Proxy(operations, {
            get(target, property, receiver) {
                if (property === 'executeQuery') {
                    return async (...args: Parameters<DatabaseOperations['executeQuery']>) => {
                        const result = await target.executeQuery(...args);
                        const sql = String(args[0]);
                        if (
                            !mutationQueued &&
                            sql.includes('FROM "stage_e_cell_snapshot"') &&
                            sql.includes('__export_type_0')
                        ) {
                            mutationQueued = true;
                            // Queue through the public facade while the projection is
                            // returning. Without an export-wide lease this write wins
                            // the race to openCellReadSession and produces a hybrid row.
                            mutation = serialized.executeQuery(
                                'UPDATE stage_e_cell_snapshot SET payload = ?, tag = ? WHERE id = 1',
                                [newPayload, 'new-row']
                            );
                        }
                        return result;
                    };
                }
                const value = Reflect.get(target, property, receiver);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
        serialized = serializeOperations(racingOperations);

        try {
            const exported = await collectStreamingExport(
                serialized,
                'stage_e_cell_snapshot',
                ['payload', 'tag'],
                { format: 'csv' }
            );
            assert.strictEqual(mutationQueued, true);
            assert.strictEqual(exported.content, `payload,tag\n${oldPayload},old-row`);
            await mutation;
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
        }
    });
});

describe('exportTableCommand atomic streaming', () => {
    it('writes a sibling temp and renames it only after the stream has finished', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery('CREATE TABLE stage_e_atomic (payload BLOB)');
        await operations.executeQuery(
            'INSERT INTO stage_e_atomic VALUES (?)',
            [new Uint8Array([1, 2, 3, 4])]
        );

        const scratch = await fsPromises.mkdtemp(path.join(process.cwd(), '.stage-e-export-test-'));
        const finalPath = path.join(scratch, 'atomic.json');
        const documentUri = mockVscode.Uri.parse('vscode-sqlite://stage-e-atomic.db');
        const originalShowSaveDialog = mockVscode.window.showSaveDialog;
        const nodeFs = require('node:fs') as typeof import('node:fs');
        const originalRename = nodeFs.promises.rename;
        let observedRename: { from: string; to: string } | undefined;
        DocumentRegistry.set('stage-e-atomic', {
            uri: documentUri,
            databaseOperations: operations
        } as any);

        try {
            mockVscode.window.showSaveDialog = async (): Promise<any> => mockVscode.Uri.file(finalPath);
            nodeFs.promises.rename = async (from, to) => {
                observedRename = { from: String(from), to: String(to) };
                return originalRename(from, to);
            };

            await exportTableCommand(
                {} as any,
                undefined,
                { table: 'stage_e_atomic', uri: documentUri.toString() },
                ['payload'],
                undefined,
                undefined,
                { format: 'json' }
            );

            assert.ok(observedRename, 'the completed temp file was not renamed');
            assert.strictEqual(observedRename.to, finalPath);
            assert.strictEqual(path.dirname(observedRename.from), scratch);
            assert.notStrictEqual(observedRename.from, finalPath);
            assert.strictEqual(
                await fsPromises.readFile(finalPath, 'utf8'),
                JSON.stringify([{ payload: 'AQIDBA==' }], null, 2)
            );
            assert.deepStrictEqual(await fsPromises.readdir(scratch), ['atomic.json']);
        } finally {
            nodeFs.promises.rename = originalRename;
            mockVscode.window.showSaveDialog = originalShowSaveDialog;
            DocumentRegistry.delete('stage-e-atomic');
            (operations as WasmDatabaseEngine).shutdown();
            await fsPromises.rm(scratch, { recursive: true, force: true });
        }
    });

    it('preserves 0644 mode when replacing an existing destination', async (t) => {
        if (process.platform === 'win32') {
            t.skip('POSIX permission bits are not available on Windows');
            return;
        }

        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery(
            "CREATE TABLE mode_export (value TEXT); INSERT INTO mode_export VALUES ('new-content')"
        );
        const scratch = await fsPromises.mkdtemp(path.join(process.cwd(), '.stage-e-export-test-'));
        const destinationPath = path.join(scratch, 'existing.json');
        await fsPromises.writeFile(destinationPath, 'old-content');
        await fsPromises.chmod(destinationPath, 0o644);

        try {
            const rowCount = await exportTableToLocalFileForTests(
                { databaseOperations: operations } as any,
                destinationPath,
                'mode_export',
                ['value'],
                { format: 'json' }
            );

            assert.strictEqual(rowCount, 1);
            assert.strictEqual((await fsPromises.stat(destinationPath)).mode & 0o777, 0o644);
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
            await fsPromises.rm(scratch, { recursive: true, force: true });
        }
    });

    it('uses the process umask for a new destination', async (t) => {
        if (process.platform === 'win32') {
            t.skip('POSIX permission bits are not available on Windows');
            return;
        }

        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery(
            "CREATE TABLE umask_export (value TEXT); INSERT INTO umask_export VALUES ('new-content')"
        );
        const scratch = await fsPromises.mkdtemp(path.join(process.cwd(), '.stage-e-export-test-'));
        const destinationPath = path.join(scratch, 'new.json');
        const previousUmask = process.umask(0o027);

        try {
            const rowCount = await exportTableToLocalFileForTests(
                { databaseOperations: operations } as any,
                destinationPath,
                'umask_export',
                ['value'],
                { format: 'json' }
            );

            assert.strictEqual(rowCount, 1);
            assert.strictEqual((await fsPromises.stat(destinationPath)).mode & 0o777, 0o640);
        } finally {
            process.umask(previousUmask);
            (operations as WasmDatabaseEngine).shutdown();
            await fsPromises.rm(scratch, { recursive: true, force: true });
        }
    });

    it('writes through an existing destination symlink without replacing the link or target mode', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery(
            "CREATE TABLE symlink_export (value TEXT); INSERT INTO symlink_export VALUES ('new-content')"
        );
        const scratch = await fsPromises.mkdtemp(path.join(process.cwd(), '.stage-e-export-test-'));
        const targetPath = path.join(scratch, 'target.json');
        const linkPath = path.join(scratch, 'destination.json');
        await fsPromises.writeFile(targetPath, 'old-content');
        await fsPromises.chmod(targetPath, 0o644);
        await fsPromises.symlink(targetPath, linkPath);

        try {
            const rowCount = await exportTableToLocalFileForTests(
                { databaseOperations: operations } as any,
                linkPath,
                'symlink_export',
                ['value'],
                { format: 'json' }
            );

            assert.strictEqual(rowCount, 1);
            assert.strictEqual((await fsPromises.lstat(linkPath)).isSymbolicLink(), true);
            assert.strictEqual(
                await fsPromises.readFile(targetPath, 'utf8'),
                JSON.stringify([{ value: 'new-content' }], null, 2)
            );
            if (process.platform !== 'win32') {
                assert.strictEqual((await fsPromises.stat(targetPath)).mode & 0o777, 0o644);
            }
        } finally {
            (operations as WasmDatabaseEngine).shutdown();
            await fsPromises.rm(scratch, { recursive: true, force: true });
        }
    });

    it('cancels between oversized-cell chunks and removes every partial file', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        const blob = new Uint8Array(EXPORT_CELL_CHUNK_BYTES * 3);
        blob.fill(0x5a);
        await operations.executeQuery('CREATE TABLE stage_e_cancel (payload BLOB)');
        await operations.executeQuery('INSERT INTO stage_e_cancel VALUES (?)', [blob]);

        let cancelled = false;
        const cancellableOperations = new Proxy(operations, {
            get(target, property, receiver) {
                if (property === 'readCellChunk') {
                    return async (...args: Parameters<DatabaseOperations['readCellChunk']>) => {
                        const chunk = await target.readCellChunk(...args);
                        cancelled = true;
                        return chunk;
                    };
                }
                const value = Reflect.get(target, property, receiver);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
        const scratch = await fsPromises.mkdtemp(path.join(process.cwd(), '.stage-e-export-test-'));
        const finalPath = path.join(scratch, 'cancelled.json');
        const documentUri = mockVscode.Uri.parse('vscode-sqlite://stage-e-cancel.db');
        const originalShowSaveDialog = mockVscode.window.showSaveDialog;
        const originalWithProgress = mockVscode.window.withProgress;
        DocumentRegistry.set('stage-e-cancel', {
            uri: documentUri,
            databaseOperations: cancellableOperations
        } as any);

        try {
            mockVscode.window.showSaveDialog = async (): Promise<any> => mockVscode.Uri.file(finalPath);
            mockVscode.window.withProgress = async (_options: unknown, task: Function): Promise<any> => task(
                { report: () => {} },
                {
                    get isCancellationRequested() { return cancelled; },
                    onCancellationRequested: () => ({ dispose: () => {} })
                }
            );

            await exportTableCommand(
                {} as any,
                undefined,
                { table: 'stage_e_cancel', uri: documentUri.toString() },
                ['payload'],
                undefined,
                undefined,
                { format: 'json' }
            );

            assert.strictEqual(cancelled, true, 'the oversized cell never reached the chunk loop');
            await assert.rejects(fsPromises.stat(finalPath), (error: any) => error?.code === 'ENOENT');
            assert.deepStrictEqual(await fsPromises.readdir(scratch), []);
        } finally {
            mockVscode.window.showSaveDialog = originalShowSaveDialog;
            mockVscode.window.withProgress = originalWithProgress;
            DocumentRegistry.delete('stage-e-cancel');
            (operations as WasmDatabaseEngine).shutdown();
            await fsPromises.rm(scratch, { recursive: true, force: true });
        }
    });

    it('uses a capped sibling-temp workspace.fs write for non-local destinations', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery('CREATE TABLE stage_e_remote (value TEXT)');
        await operations.executeQuery("INSERT INTO stage_e_remote VALUES ('remote')");
        const documentUri = mockVscode.Uri.parse('vscode-sqlite://stage-e-remote.db');
        const destination = {
            ...mockVscode.Uri.file('/remote/export.json'),
            scheme: 'vscode-remote',
            toString: () => 'vscode-remote:///remote/export.json'
        };
        const originalShowSaveDialog = mockVscode.window.showSaveDialog;
        const originalWriteFile = mockVscode.workspace.fs.writeFile;
        const originalRename = mockVscode.workspace.fs.rename;
        const originalDelete = mockVscode.workspace.fs.delete;
        let tempUri: any;
        let written: Uint8Array = new Uint8Array();
        let renamed: { from: any; to: any } | undefined;
        DocumentRegistry.set('stage-e-remote', {
            uri: documentUri,
            databaseOperations: operations
        } as any);

        try {
            mockVscode.window.showSaveDialog = async (): Promise<any> => destination;
            mockVscode.workspace.fs.writeFile = async (uri: any, bytes: Uint8Array) => {
                tempUri = uri;
                written = bytes;
            };
            mockVscode.workspace.fs.rename = async (from: any, to: any) => {
                renamed = { from, to };
            };
            mockVscode.workspace.fs.delete = async () => {
                throw new Error('successful non-local export must not delete its completed temp');
            };

            await exportTableCommand(
                {} as any,
                undefined,
                { table: 'stage_e_remote', uri: documentUri.toString() },
                ['value'],
                undefined,
                undefined,
                { format: 'json' }
            );

            assert.ok(tempUri, 'workspace.fs did not receive a sibling temp write');
            assert.notStrictEqual(tempUri.toString(), destination.toString());
            assert.strictEqual(new TextDecoder().decode(written), JSON.stringify([{ value: 'remote' }], null, 2));
            assert.ok(renamed, 'workspace.fs temp was not renamed');
            assert.strictEqual(renamed.from, tempUri);
            assert.strictEqual(renamed.to, destination);
        } finally {
            mockVscode.window.showSaveDialog = originalShowSaveDialog;
            mockVscode.workspace.fs.writeFile = originalWriteFile;
            mockVscode.workspace.fs.rename = originalRename;
            mockVscode.workspace.fs.delete = originalDelete;
            DocumentRegistry.delete('stage-e-remote');
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

    it('refuses output above the precise non-local memory cap before workspace.fs writes', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        // Base64 expands this source beyond the 16 MiB UTF-8 output cap.
        const blob = new Uint8Array(12 * 1024 * 1024 + 3);
        blob.fill(0x41);
        await operations.executeQuery('CREATE TABLE stage_e_remote_cap (payload BLOB)');
        await operations.executeQuery('INSERT INTO stage_e_remote_cap VALUES (?)', [blob]);
        const documentUri = mockVscode.Uri.parse('vscode-sqlite://stage-e-remote-cap.db');
        const destination = {
            ...mockVscode.Uri.file('/remote/export.json'),
            scheme: 'vscode-remote',
            toString: () => 'vscode-remote:///remote/export.json'
        };
        const originalShowSaveDialog = mockVscode.window.showSaveDialog;
        const originalShowErrorMessage = mockVscode.window.showErrorMessage;
        const originalWriteFile = mockVscode.workspace.fs.writeFile;
        const originalConsoleError = console.error;
        let writeCalled = false;
        let errorMessage = '';
        DocumentRegistry.set('stage-e-remote-cap', {
            uri: documentUri,
            databaseOperations: operations
        } as any);

        try {
            mockVscode.window.showSaveDialog = async (): Promise<any> => destination;
            mockVscode.workspace.fs.writeFile = async () => {
                writeCalled = true;
            };
            mockVscode.window.showErrorMessage = async (message: string): Promise<any> => {
                errorMessage = message;
            };
            console.error = () => {};

            await exportTableCommand(
                {} as any,
                undefined,
                { table: 'stage_e_remote_cap', uri: documentUri.toString() },
                ['payload'],
                undefined,
                undefined,
                { format: 'json' }
            );

            assert.strictEqual(writeCalled, false);
            assert.match(errorMessage, /16 MiB \(16,777,216 bytes\)/);
            assert.match(errorMessage, /workspace\.fs has no streaming write API/);
        } finally {
            mockVscode.window.showSaveDialog = originalShowSaveDialog;
            mockVscode.window.showErrorMessage = originalShowErrorMessage;
            mockVscode.workspace.fs.writeFile = originalWriteFile;
            console.error = originalConsoleError;
            DocumentRegistry.delete('stage-e-remote-cap');
            (operations as WasmDatabaseEngine).shutdown();
        }
    });
});

describe('exportToJson', () => {
    it('should export basic types correctly', () => {
        const columns = ['id', 'name', 'value', 'nullable'];
        const rows: CellValue[][] = [
            [1, 'test', 12.34, null],
            [2, 'another', 0, 'not null']
        ];

        const json = exportToJson(columns, rows);
        const parsed = JSON.parse(json);

        assert.deepStrictEqual(parsed, [
            { id: 1, name: 'test', value: 12.34, nullable: null },
            { id: 2, name: 'another', value: 0, nullable: 'not null' }
        ]);
    });

    it('should convert Uint8Array to base64', () => {
        const columns = ['id', 'data'];
        const buffer = new Uint8Array([1, 2, 3]);
        const rows: CellValue[][] = [
            [1, buffer]
        ];

        const json = exportToJson(columns, rows);
        const parsed = JSON.parse(json);

        assert.deepStrictEqual(parsed, [
            { id: 1, data: 'AQID' } // AQID is base64 for [1, 2, 3]
        ]);
    });

    it('should handle empty rows', () => {
        const columns = ['id', 'name'];
        const rows: CellValue[][] = [];

        const json = exportToJson(columns, rows);
        const parsed = JSON.parse(json);

        assert.deepStrictEqual(parsed, []);
    });

    it('should handle empty columns (though unlikely in practice)', () => {
        const columns: string[] = [];
        const rows: CellValue[][] = [[], []];

        const json = exportToJson(columns, rows);
        const parsed = JSON.parse(json);

        assert.deepStrictEqual(parsed, [{}, {}]);
    });
});

describe('exportToCsv', () => {
    it('should export with header by default', () => {
        const columns = ['id', 'name'];
        const rows: CellValue[][] = [[1, 'Alice'], [2, 'Bob']];

        const csv = exportToCsv(columns, rows);
        assert.strictEqual(csv, 'id,name\n1,Alice\n2,Bob');
    });

    it('should omit header when includeHeader is false', () => {
        const columns = ['id', 'name'];
        const rows: CellValue[][] = [[1, 'Alice']];

        const csv = exportToCsv(columns, rows, false);
        assert.strictEqual(csv, '1,Alice');
    });

    it('should escape values containing commas, quotes, and newlines', () => {
        const columns = ['text'];
        const rows: CellValue[][] = [
            ['hello, world'],
            ['say "hi"'],
            ['line1\nline2']
        ];

        const csv = exportToCsv(columns, rows);
        const lines = csv.split('\n');
        assert.strictEqual(lines[0], 'text');
        assert.strictEqual(lines[1], '"hello, world"');
        assert.strictEqual(lines[2], '"say ""hi"""');
    });

    it('should handle null and Uint8Array values', () => {
        const columns = ['val', 'blob'];
        const rows: CellValue[][] = [[null, new Uint8Array([1, 2, 3])]];

        const csv = exportToCsv(columns, rows);
        assert.strictEqual(csv, 'val,blob\n,[BLOB]');
    });
});

describe('exportToSql', () => {
    it('should generate INSERT statements with escaped identifiers', () => {
        const columns = ['id', 'name'];
        const rows: CellValue[][] = [[1, 'Alice']];

        const sql = exportToSql('users', columns, rows);
        assert.ok(sql.includes('INSERT INTO'));
        assert.ok(sql.includes('"users"'));
        assert.ok(sql.includes('"id"'));
        assert.ok(sql.includes('"name"'));
    });

    it('should use placeholder table name when includeTableName is false', () => {
        const columns = ['id'];
        const rows: CellValue[][] = [[1]];

        const sql = exportToSql('users', columns, rows, false);
        assert.ok(sql.includes('table_name'));
        assert.ok(!sql.includes('"users"'));
    });

    it('should handle empty rows', () => {
        const columns = ['id'];
        const rows: CellValue[][] = [];

        const sql = exportToSql('t', columns, rows);
        assert.strictEqual(sql, '');
    });
});

describe('exportTableCommand compatibility and failures', () => {
    it('exports the minimum signed-int64 rowid in the first keyset batch', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery('CREATE TABLE export_min_rowid (value TEXT)');
        await operations.executeQuery(
            'INSERT INTO export_min_rowid(rowid, value) VALUES (?, ?)',
            ['-9223372036854775808', 'minimum']
        );

        const scratch = await fsPromises.mkdtemp(path.join(process.cwd(), '.stage-e-export-test-'));
        const finalPath = path.join(scratch, 'export-min.csv');
        const uri = mockVscode.Uri.file(finalPath);
        const originalShowSaveDialog = mockVscode.window.showSaveDialog;
        mockVscode.window.showSaveDialog = async (): Promise<any> => uri;

        DocumentRegistry.set('export-min', {
            uri: mockVscode.Uri.parse('vscode-sqlite://export-min.db'),
            databaseOperations: operations
        } as any);

        try {
            await exportTableCommand(
                {} as any,
                undefined,
                { table: 'export_min_rowid', uri: 'vscode-sqlite://export-min.db' },
                ['value'],
                undefined,
                undefined,
                { format: 'csv' }
            );

            assert.strictEqual(await fsPromises.readFile(finalPath, 'utf8'), 'value\nminimum');
        } finally {
            mockVscode.window.showSaveDialog = originalShowSaveDialog;
            DocumentRegistry.delete('export-min');
            (operations as WasmDatabaseEngine).shutdown();
            await fsPromises.rm(scratch, { recursive: true, force: true });
        }
    });

    it('exports only selected WITHOUT ROWID identities', async () => {
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const operations = database.operations!;
        await operations.executeQuery(
            'CREATE TABLE export_pk (tenant TEXT, id INTEGER, value TEXT, PRIMARY KEY (tenant, id)) WITHOUT ROWID'
        );
        await operations.executeQuery(
            'INSERT INTO export_pk VALUES (?, ?, ?), (?, ?, ?)',
            ['one', '9007199254740993', 'selected', 'two', '9007199254740994', 'excluded']
        );
        const fetched = await operations.fetchTableData('export_pk', {
            columns: ['rowid', 'tenant', 'id', 'value'],
            orderBy: 'rowid'
        });
        const selectedId = fetched.rows.find(row => row[1] === 'one')![0] as string;

        const scratch = await fsPromises.mkdtemp(path.join(process.cwd(), '.stage-e-export-test-'));
        const finalPath = path.join(scratch, 'export-pk.csv');
        const uri = mockVscode.Uri.file(finalPath);
        const originalShowSaveDialog = mockVscode.window.showSaveDialog;
        mockVscode.window.showSaveDialog = async (): Promise<any> => uri;
        DocumentRegistry.set('export-pk', {
            uri: mockVscode.Uri.parse('vscode-sqlite://export-pk.db'),
            databaseOperations: operations
        } as any);

        try {
            await exportTableCommand(
                {} as any,
                undefined,
                { table: 'export_pk', uri: 'vscode-sqlite://export-pk.db' },
                ['tenant', 'id', 'value'],
                undefined,
                undefined,
                { format: 'csv', rowIds: [selectedId] }
            );

            const exported = await fsPromises.readFile(finalPath, 'utf8');
            assert.match(exported, /selected/);
            assert.doesNotMatch(exported, /excluded/);
        } finally {
            mockVscode.window.showSaveDialog = originalShowSaveDialog;
            DocumentRegistry.delete('export-pk');
            (operations as WasmDatabaseEngine).shutdown();
            await fsPromises.rm(scratch, { recursive: true, force: true });
        }
    });

    it('does not fall back to whole-memory workspace.fs after a local stream-open failure', async () => {
        const docUri = mockVscode.Uri.parse('vscode-sqlite://test.db');
        const uri = mockVscode.Uri.file(path.join(process.cwd(), 'stage-e-open-failure.csv'));
        const originalShowSaveDialog = mockVscode.window.showSaveDialog;
        const originalShowErrorMessage = mockVscode.window.showErrorMessage;
        const originalWriteFile = mockVscode.workspace.fs.writeFile;
        let fileWritten = false;
        mockVscode.workspace.fs.writeFile = async () => {
            fileWritten = true;
        };
        let errorMessage = '';
        mockVscode.window.showSaveDialog = async (): Promise<any> => uri;
        mockVscode.window.showErrorMessage = async (message: string): Promise<any> => {
            errorMessage = message;
        };
        const doc = {
            uri: docUri,
            databaseOperations: {}
        };
        DocumentRegistry.set('test', doc as any);

        const fs = require('fs');
        const originalCreateWriteStream = fs.createWriteStream;
        const originalConsoleError = console.error;
        try {
            fs.createWriteStream = () => {
                throw new Error('Simulated stream failure');
            };
            console.error = () => {};

            await exportTableCommand(
                {} as any,
                undefined,
                { table: 'test_table', uri: 'vscode-sqlite://test.db' },
                ['id', 'name'],
                undefined,
                undefined,
                { format: 'csv' }
            );

            assert.strictEqual(fileWritten, false, 'local failures must not trigger an accumulating fallback');
            assert.strictEqual(errorMessage, 'Export failed: Simulated stream failure');
        } finally {
            fs.createWriteStream = originalCreateWriteStream;
            console.error = originalConsoleError;
            mockVscode.window.showSaveDialog = originalShowSaveDialog;
            mockVscode.window.showErrorMessage = originalShowErrorMessage;
            mockVscode.workspace.fs.writeFile = originalWriteFile;
            DocumentRegistry.delete('test');
        }
    });

    it('should catch unsupported format error', async () => {
        const docUri = mockVscode.Uri.parse('vscode-sqlite://test.db');

        let errorMessageShown = '';
        const originalShowErrorMessage = mockVscode.window.showErrorMessage;
        (mockVscode.window as any).showErrorMessage = async (msg: string) => {
            errorMessageShown = msg;
        };

        const doc = {
            uri: docUri,
            databaseOperations: {}
        };
        DocumentRegistry.set('test', doc as any);

        try {
            await exportTableCommand(
                {} as any,
                undefined,
                { table: 'test_table', uri: 'vscode-sqlite://test.db' },
                ['id', 'name'],
                undefined,
                undefined,
                { format: 'invalid_format' }
            );

            assert.strictEqual(errorMessageShown, 'Unsupported export format: invalid_format');
        } finally {
            mockVscode.window.showErrorMessage = originalShowErrorMessage;
            DocumentRegistry.delete('test');
        }
    });

    it('should catch and show error when export fails', async () => {
        const docUri = mockVscode.Uri.parse('vscode-sqlite://test.db');
        const scratch = await fsPromises.mkdtemp(path.join(process.cwd(), '.stage-e-export-test-'));
        const finalPath = path.join(scratch, 'export.csv');
        const uri = mockVscode.Uri.file(finalPath);

        let errorMessageShown = '';
        const originalShowErrorMessage = mockVscode.window.showErrorMessage;
        (mockVscode.window as any).showErrorMessage = async (msg: string) => {
            errorMessageShown = msg;
        };

        const originalShowSaveDialog = mockVscode.window.showSaveDialog;
        mockVscode.window.showSaveDialog = async (): Promise<any> => uri;

        let fileWritten = false;
        const originalWriteFile = mockVscode.workspace.fs.writeFile;
        mockVscode.workspace.fs.writeFile = async () => {
            fileWritten = true;
        };

        const originalConsoleError = console.error;
        let consoleErrorCalled = false;
        console.error = () => { consoleErrorCalled = true; };

        const dbOperations = {
            executeQuery: async (sql: string) => {
                throw new Error('Simulated query failure for testing');
            }
        };

        const doc = {
            uri: docUri,
            databaseOperations: dbOperations
        };
        DocumentRegistry.set('test', doc as any);

        try {
            await exportTableCommand(
                {} as any,
                undefined,
                { table: 'test_table', uri: 'vscode-sqlite://test.db' },
                ['id', 'name'],
                undefined,
                undefined,
                { format: 'csv' }
            );

            assert.strictEqual(fileWritten, false, 'Should not have written file');
            assert.strictEqual(errorMessageShown, 'Export failed: Simulated query failure for testing');
            assert.strictEqual(consoleErrorCalled, true, 'console.error should have been called');
            await assert.rejects(fsPromises.stat(finalPath), (error: any) => error?.code === 'ENOENT');
            assert.deepStrictEqual(await fsPromises.readdir(scratch), []);
        } finally {
            mockVscode.window.showErrorMessage = originalShowErrorMessage;
            mockVscode.window.showSaveDialog = originalShowSaveDialog;
            mockVscode.workspace.fs.writeFile = originalWriteFile;
            console.error = originalConsoleError;
            DocumentRegistry.delete('test');
            await fsPromises.rm(scratch, { recursive: true, force: true });
        }
    });
});

describe('getFormatHelper', () => {
    it('should return correct helper for csv format', () => {
        const helper = getFormatHelper('csv', 'test_table', true, true);
        assert.strictEqual(helper.extension, 'csv');

        let called = false;
        helper.streamStart({ write: () => called = true });
        assert.strictEqual(called, false, 'streamStart should be a no-op');

        called = false;
        helper.streamEnd({ write: () => called = true });
        assert.strictEqual(called, false, 'streamEnd should be a no-op');

        let written = '';
        helper.streamWriteBatch({ write: (data: string) => written += data }, ['col1'], [[1]], true);
        assert.ok(written.includes('col1'), 'First batch should include header');
        assert.ok(written.includes('1'), 'First batch should include data');

        written = '';
        helper.streamWriteBatch({ write: (data: string) => written += data }, ['col1'], [[2]], false);
        assert.strictEqual(written.startsWith('\n'), true, 'Subsequent batches should start with newline');
        assert.ok(!written.includes('col1'), 'Subsequent batches should not include header');

        const memExport = helper.exportMemory(['col1'], [[1]]);
        assert.ok(memExport.includes('col1'));
        assert.ok(memExport.includes('1'));
    });

    it('should return correct helper for excel format', () => {
        const helper = getFormatHelper('excel', 'test_table', true, true);
        assert.strictEqual(helper.extension, 'csv');

        let written = '';
        helper.streamStart({ write: (data: string) => written = data });
        assert.strictEqual(written, '\uFEFF', 'streamStart should write BOM');

        let called = false;
        helper.streamEnd({ write: () => called = true });
        assert.strictEqual(called, false, 'streamEnd should be a no-op');

        const memExport = helper.exportMemory(['col1'], [[1]]);
        assert.ok(memExport.startsWith('\uFEFF'), 'exportMemory should start with BOM');
        assert.ok(memExport.includes('col1'));
        assert.ok(memExport.includes('1'));
    });

    it('should return correct helper for json format', () => {
        const helper = getFormatHelper('json', 'test_table', true, true);
        assert.strictEqual(helper.extension, 'json');

        let written = '';
        helper.streamStart({ write: (data: string) => written = data });
        assert.strictEqual(written, '[', 'streamStart should write array start');

        written = '';
        helper.streamEnd({ write: (data: string) => written = data });
        assert.strictEqual(written, ']', 'streamEnd should write array end');

        written = '';
        helper.streamWriteBatch({ write: (data: string) => written += data }, ['col1'], [[1]], true);
        assert.ok(written.includes('"col1": 1'), 'First batch should write formatted object');
        assert.ok(!written.startsWith('['), 'First batch should not start with [');
        assert.ok(!written.endsWith(']'), 'First batch should not end with ]');

        written = '';
        helper.streamWriteBatch({ write: (data: string) => written += data }, ['col1'], [[2]], false);
        assert.strictEqual(written.startsWith(','), true, 'Subsequent batches should prepend comma');
        assert.ok(written.includes('"col1": 2'), 'Subsequent batches should write formatted object');

        const memExport = helper.exportMemory(['col1'], [[1]]);
        assert.strictEqual(memExport, '[\n  {\n    "col1": 1\n  }\n]', 'exportMemory should write full JSON array');
    });

    it('should return correct helper for sql format', () => {
        const helper = getFormatHelper('sql', 'test_table', true, true);
        assert.strictEqual(helper.extension, 'sql');

        let called = false;
        helper.streamStart({ write: () => called = true });
        assert.strictEqual(called, false, 'streamStart should be a no-op');

        called = false;
        helper.streamEnd({ write: () => called = true });
        assert.strictEqual(called, false, 'streamEnd should be a no-op');

        let written = '';
        helper.streamWriteBatch({ write: (data: string) => written += data }, ['col1'], [[1]], true);
        assert.ok(written.includes('INSERT INTO "test_table"'), 'First batch should contain INSERT statement');

        written = '';
        helper.streamWriteBatch({ write: (data: string) => written += data }, ['col1'], [[2]], false);
        assert.strictEqual(written.startsWith('\n'), true, 'Subsequent batches should start with newline');
        assert.ok(written.includes('INSERT INTO "test_table"'), 'Subsequent batches should contain INSERT statement');

        const memExport = helper.exportMemory(['col1'], [[1]]);
        assert.ok(memExport.includes('INSERT INTO "test_table"'), 'exportMemory should contain INSERT statement');
    });

    it('should throw error for unknown format', () => {
        assert.throws(() => {
            getFormatHelper('unknown_format', 'test_table', true, true);
        }, /Unsupported export format: unknown_format/);
    });

    it('should throw error for undefined format', () => {
        assert.throws(() => {
            getFormatHelper('', 'test_table', true, true);
        }, /Unsupported export format: undefined/);
    });
});
