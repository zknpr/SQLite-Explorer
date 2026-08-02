
import './vscode_mock_setup'; // Must be first
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { exportToJson, exportToCsv, exportToSql, exportTableCommand, getFormatHelper } from '../../src/tableExporter';
import { CellValue } from '../../src/core/types';
import { mockVscode } from './mocks/vscode';
import { DocumentRegistry } from '../../src/documentRegistry';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';

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

        const uri = mockVscode.Uri.file('/test/export-min.csv');
        const originalShowSaveDialog = mockVscode.window.showSaveDialog;
        mockVscode.window.showSaveDialog = async (): Promise<any> => uri;
        const fs = require('fs');
        const originalCreateWriteStream = fs.createWriteStream;
        let exported = '';

        DocumentRegistry.set('export-min', {
            uri: mockVscode.Uri.parse('vscode-sqlite://export-min.db'),
            databaseOperations: operations
        } as any);

        try {
            fs.createWriteStream = () => ({
                write: (chunk: string) => { exported += chunk; },
                end: () => {}
            });

            await exportTableCommand(
                {} as any,
                undefined,
                { table: 'export_min_rowid', uri: 'vscode-sqlite://export-min.db' },
                ['value'],
                undefined,
                undefined,
                { format: 'csv' }
            );

            assert.strictEqual(exported, 'value\nminimum');
        } finally {
            fs.createWriteStream = originalCreateWriteStream;
            mockVscode.window.showSaveDialog = originalShowSaveDialog;
            DocumentRegistry.delete('export-min');
            (operations as WasmDatabaseEngine).shutdown();
        }
    });

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

    it('should fall back to memory export if stream write fails during chunking', async () => {
        const docUri = mockVscode.Uri.parse('vscode-sqlite://test.db');
        const uri = mockVscode.Uri.file('/test/export.csv');

        mockVscode.window.showSaveDialog = async (): Promise<any> => uri;

        let fileWritten = false;
        mockVscode.workspace.fs.writeFile = async () => {
            fileWritten = true;
        };

        let chunkQueryExecuted = false;
        const executeQueryCalls: string[] = [];
        const dbOperations = {
            executeQuery: async (sql: string) => {
                executeQueryCalls.push(sql);
                if (sql.includes('LIMIT 5000')) {
                    chunkQueryExecuted = true;
                    return [{
                        headers: ['id', 'name'],
                        rows: [[1, 'Alice'], [2, 'Bob']],
                        columns: ['id', 'name'],
                        values: [[1, 'Alice'], [2, 'Bob']]
                    }];
                }

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
                return {
                    write: () => { throw new Error('Simulated write failure during chunking'); },
                    end: () => {}
                };
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
            assert.strictEqual(chunkQueryExecuted, true, 'Should have attempted the chunk query before failing');

            const expectedQuery = 'SELECT "id", "name" FROM "test_table"';
            assert.ok(executeQueryCalls.includes(expectedQuery), `Expected query to be executed: ${expectedQuery}`);

        } finally {
            fs.createWriteStream = originalCreateWriteStream;
            console.warn = originalConsoleWarn;
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
        const uri = mockVscode.Uri.file('/test/export.csv');

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

        const fs = require('fs');
        const originalCreateWriteStream = fs.createWriteStream;
        const originalConsoleWarn = console.warn;

        try {
            fs.createWriteStream = () => {
                throw new Error('Simulated stream failure');
            };

            console.warn = () => {};

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
        } finally {
            fs.createWriteStream = originalCreateWriteStream;
            mockVscode.window.showErrorMessage = originalShowErrorMessage;
            mockVscode.window.showSaveDialog = originalShowSaveDialog;
            mockVscode.workspace.fs.writeFile = originalWriteFile;
            console.error = originalConsoleError;
            console.warn = originalConsoleWarn;
            DocumentRegistry.delete('test');
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
