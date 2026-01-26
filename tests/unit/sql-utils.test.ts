import { describe, it } from 'node:test';
import assert from 'node:assert';
import { escapeIdentifier, cellValueToSql } from '../../src/core/sql-utils';

describe('SQL Utils', () => {
  describe('escapeIdentifier', () => {
    it('should escape simple identifiers', () => {
      assert.strictEqual(escapeIdentifier('foo'), '"foo"');
    });

    it('should escape identifiers with spaces', () => {
      assert.strictEqual(escapeIdentifier('foo bar'), '"foo bar"');
    });

    it('should escape identifiers with double quotes', () => {
      assert.strictEqual(escapeIdentifier('foo"bar'), '"foo""bar"');
    });

    it('should escape complex identifiers', () => {
      assert.strictEqual(escapeIdentifier('foo"bar"baz'), '"foo""bar""baz"');
    });
  });

  describe('cellValueToSql', () => {
    it('should handle null and undefined', () => {
      assert.strictEqual(cellValueToSql(null), 'NULL');
      assert.strictEqual(cellValueToSql(undefined), 'NULL');
    });

    it('should handle numbers', () => {
      assert.strictEqual(cellValueToSql(123), '123');
      assert.strictEqual(cellValueToSql(12.34), '12.34');
    });

    it('should handle strings', () => {
      assert.strictEqual(cellValueToSql('foo'), "'foo'");
      assert.strictEqual(cellValueToSql('foo bar'), "'foo bar'");
    });

    it('should escape strings with single quotes', () => {
      assert.strictEqual(cellValueToSql("foo'bar"), "'foo''bar'");
    });

    it('should handle Uint8Array (blobs)', () => {
      const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      assert.strictEqual(cellValueToSql(data), "X'deadbeef'");
    });
  });
});
