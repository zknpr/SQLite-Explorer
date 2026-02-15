
import './vscode_mock_setup'; // Must be first
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { exportToJson, exportToCsv, exportToSql } from '../../src/tableExporter';
import { CellValue } from '../../src/core/types';

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
