
import './vscode_mock_setup'; // Must be first
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { exportToJson, exportToCsv, exportToSql, exportTableCommand } from '../../src/tableExporter';
import { CellValue } from '../../src/core/types';
import { mockVscode } from './mocks/vscode';
import { DocumentRegistry } from '../../src/documentRegistry';

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

describe('exportTableCommand Fallback', () => {
    it('should use fallback memory export if stream write fails', async () => {
        const docUri = mockVscode.Uri.parse('vscode-sqlite://test.db');
        const uri = mockVscode.Uri.file('/test/export.csv');

        mockVscode.window.showSaveDialog = async (): Promise<any> => uri;

        let fileWritten = false;
        mockVscode.workspace.fs.writeFile = async () => {
            fileWritten = true;
        };

        // Ensure stream fails without attempting to open file to prevent ENOENT.
        // `getNodeFs()` returns `undefined` inside tests (mocked environment).
        // Since `getNodeFs()` is used if it's a file, we can bypass fs entirely
        // and force the `try...catch` fallback simply by letting `fs.createWriteStream` fail,
        // or by making `fs` unavailable. However, in our test `getNodeFs()` will resolve to the real `fs`.
        // To avoid an `ENOENT` on `fs.createWriteStream`, we mock `fs` directly or just throw error earlier.

        const executeQueryCalls: string[] = [];
        const dbOperations = {
            executeQuery: async (sql: string) => {
                executeQueryCalls.push(sql);

                // For the fallback non-paginated query, return dummy data
                return [{
                    headers: ['id', 'name'],
                    rows: [[1, 'Alice'], [2, 'Bob']],
                    columns: ['id', 'name'],
                    values: [[1, 'Alice'], [2, 'Bob']]
                }];
            }
        };

        const doc = {
            uri: docUri,
            databaseOperations: dbOperations
        };
        DocumentRegistry.set('test', doc as any);

        const fs = require('fs');
        const originalCreateWriteStream = fs.createWriteStream;

        const originalConsoleWarn = console.warn;
        let warnCalled = false;
        try {
            fs.createWriteStream = () => {
                throw new Error('Simulated stream failure');
            };

            console.warn = (msg, e) => {
                if (msg === 'Native stream write failed, falling back to memory') {
                    warnCalled = true;
                }
            };

            await exportTableCommand(
                {} as any,
                undefined,
                { table: 'test_table', uri: 'vscode-sqlite://test.db' },
                ['id', 'name'],
                undefined,
                undefined,
                { format: 'csv' }
            );

            assert.strictEqual(warnCalled, true, 'Should have logged fallback warning');
            assert.strictEqual(fileWritten, true, 'Should have written file using fallback workspace.fs');

            const expectedQuery = 'SELECT "id", "name" FROM "test_table"';
            assert.ok(executeQueryCalls.includes(expectedQuery), `Expected query to be executed: ${expectedQuery}`);

        } finally {
            fs.createWriteStream = originalCreateWriteStream;
            console.warn = originalConsoleWarn;
            DocumentRegistry.delete('test');
        }
    });
});
