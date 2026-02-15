import '../../tests/unit/vscode_mock_setup'; // Must be first
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { exportToCsv, exportToJson, exportToSql } from '../../src/tableExporter';
import type { CellValue } from '../../src/core/types';

describe('Table Exporter', () => {
  describe('exportToCsv', () => {
    it('should export simple data', () => {
      const columns = ['id', 'name'];
      const rows: CellValue[][] = [
        [1, 'Alice'],
        [2, 'Bob']
      ];
      const result = exportToCsv(columns, rows);
      assert.strictEqual(result, 'id,name\n1,Alice\n2,Bob');
    });

    it('should handle special characters', () => {
      const columns = ['col1', 'col2'];
      const rows: CellValue[][] = [
        ['a,b', 'c"d'],
        ['e\nf', 'g']
      ];
      const result = exportToCsv(columns, rows);
      assert.strictEqual(result, 'col1,col2\n"a,b","c""d"\n"e\nf",g');
    });

    it('should handle null and undefined', () => {
      const columns = ['col1', 'col2'];
      const rows: CellValue[][] = [
        [null, undefined]
      ];
      const result = exportToCsv(columns, rows);
      assert.strictEqual(result, 'col1,col2\n,');
    });

    it('should handle blobs', () => {
      const columns = ['data'];
      const rows: CellValue[][] = [
        [new Uint8Array([1, 2, 3])]
      ];
      const result = exportToCsv(columns, rows);
      assert.strictEqual(result, 'data\n[BLOB]');
    });

    it('should omit header if requested', () => {
      const columns = ['id', 'name'];
      const rows: CellValue[][] = [
        [1, 'Alice']
      ];
      const result = exportToCsv(columns, rows, false);
      assert.strictEqual(result, '1,Alice');
    });
  });

  describe('exportToJson', () => {
    it('should export simple data', () => {
      const columns = ['id', 'name'];
      const rows: CellValue[][] = [
        [1, 'Alice'],
        [2, 'Bob']
      ];
      const result = exportToJson(columns, rows);
      const expected = JSON.stringify([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' }
      ], null, 2);
      assert.strictEqual(result, expected);
    });

    it('should handle blobs as base64', () => {
      const columns = ['data'];
      const blob = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
      const rows: CellValue[][] = [
        [blob]
      ];
      const result = exportToJson(columns, rows);
      const expected = JSON.stringify([
        { data: 'SGVsbG8=' }
      ], null, 2);
      assert.strictEqual(result, expected);
    });

    it('should handle null values', () => {
      const columns = ['val'];
      const rows: CellValue[][] = [
        [null]
      ];
      const result = exportToJson(columns, rows);
      const expected = JSON.stringify([
        { val: null }
      ], null, 2);
      assert.strictEqual(result, expected);
    });
  });

  describe('exportToSql', () => {
    it('should generate INSERT statements', () => {
      const columns = ['id', 'name'];
      const rows: CellValue[][] = [
        [1, 'Alice']
      ];
      const result = exportToSql('users', columns, rows);
      assert.strictEqual(result, 'INSERT INTO "users" ("id", "name") VALUES (1, \'Alice\');');
    });

    it('should escape table and column names', () => {
      const columns = ['user name', 'o"rder'];
      const rows: CellValue[][] = [
        ['Alice', 1]
      ];
      const result = exportToSql('my "table"', columns, rows);
      assert.strictEqual(result, 'INSERT INTO "my ""table""" ("user name", "o""rder") VALUES (\'Alice\', 1);');
    });

    it('should escape string values', () => {
      const columns = ['text'];
      const rows: CellValue[][] = [
        ['It\'s a "test"']
      ];
      const result = exportToSql('t', columns, rows);
      assert.strictEqual(result, 'INSERT INTO "t" ("text") VALUES (\'It\'\'s a "test"\');');
    });

    it('should handle blobs', () => {
      const columns = ['data'];
      const blob = new Uint8Array([0xde, 0xad]);
      const rows: CellValue[][] = [
        [blob]
      ];
      const result = exportToSql('t', columns, rows);
      assert.strictEqual(result, 'INSERT INTO "t" ("data") VALUES (X\'dead\');');
    });

    it('should handle null values', () => {
      const columns = ['val'];
      const rows: CellValue[][] = [
        [null]
      ];
      const result = exportToSql('t', columns, rows);
      assert.strictEqual(result, 'INSERT INTO "t" ("val") VALUES (NULL);');
    });

    it('should omit table name if requested', () => {
      const columns = ['id'];
      const rows: CellValue[][] = [
        [1]
      ];
      // Note: the implementation defaults to 'table_name' if includeTableName is false
      // Let's verify this behavior
      const result = exportToSql('users', columns, rows, false);
      assert.strictEqual(result, 'INSERT INTO table_name ("id") VALUES (1);');
    });
  });
});
