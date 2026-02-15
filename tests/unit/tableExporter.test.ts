
import { test } from 'node:test';
import * as assert from 'node:assert';
import '../unit/vscode_mock_setup';
import { exportToJson } from '../../src/tableExporter';
import { CellValue } from '../../src/core/types';

test('exportToJson should produce valid JSON', () => {
    const columns = ['id', 'name'];
    const rows: CellValue[][] = [
        [1, 'Alice'],
        [2, 'Bob']
    ];

    const json = exportToJson(columns, rows);
    const parsed = JSON.parse(json);

    assert.deepStrictEqual(parsed, [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' }
    ]);
});

test('exportToJson should handle Uint8Array', () => {
    const columns = ['data'];
    const buffer = Buffer.from('hello');
    // Uint8Array is often returned by sql.js
    const rows: CellValue[][] = [
        [new Uint8Array(buffer)]
    ];

    const json = exportToJson(columns, rows);
    const parsed = JSON.parse(json);

    assert.strictEqual(parsed[0].data, buffer.toString('base64'));
});

test('exportToJson should handle empty input', () => {
    const columns = ['id'];
    const rows: CellValue[][] = [];

    const json = exportToJson(columns, rows);
    assert.strictEqual(json, '[]');
});

test('exportToJson output format', () => {
     const columns = ['a', 'b'];
     const rows = [[1, 2], [3, 4]];
     const json = exportToJson(columns, rows);

     // Expect compact rows
     const expected = '[\n  {"a":1,"b":2},\n  {"a":3,"b":4}\n]';
     assert.strictEqual(json, expected);
});
