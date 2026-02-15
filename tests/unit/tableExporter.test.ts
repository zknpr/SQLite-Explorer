
import './vscode_mock_setup'; // Must be first
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { exportToJson } from '../../src/tableExporter';
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
