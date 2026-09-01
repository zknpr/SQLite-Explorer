import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  assertUsableSqlIdentifier,
  escapeIdentifier,
  cellValueToSql,
  validateSqlType,
  escapeLikePattern,
  validateRowId,
  validateRowIds
} from '../../src/core/sql-utils';

describe('SQL Utils', () => {
  describe('validateSqlType', () => {
    it('should accept valid simple types', () => {
      assert.doesNotThrow(() => validateSqlType('INTEGER'));
      assert.doesNotThrow(() => validateSqlType('TEXT'));
      assert.doesNotThrow(() => validateSqlType('BLOB'));
    });

    it('should accept types with length/precision', () => {
      assert.doesNotThrow(() => validateSqlType('VARCHAR(255)'));
      assert.doesNotThrow(() => validateSqlType('DECIMAL(10, 5)'));
      assert.doesNotThrow(() => validateSqlType('NUMERIC(10,5)'));
    });

    it('should accept types with modifiers', () => {
      assert.doesNotThrow(() => validateSqlType('UNSIGNED INTEGER'));
      assert.doesNotThrow(() => validateSqlType('INTEGER UNSIGNED'));
      assert.doesNotThrow(() => validateSqlType('INT(10) UNSIGNED'));
    });

    it('should reject types with dangerous characters', () => {
      assert.throws(() => validateSqlType('TEXT; DROP TABLE foo'), /unsafe characters/);
      assert.throws(() => validateSqlType("VARCHAR(20)'"), /unsafe characters/);
      assert.throws(() => validateSqlType('INT -- comment'), /unsafe characters/);
      assert.throws(() => validateSqlType('INT /* comment */'), /unsafe characters/);
    });

    it('should reject malformed types', () => {
      assert.throws(() => validateSqlType('INTEGER)'), /match allowed format/);
      assert.throws(() => validateSqlType('(INTEGER)'), /match allowed format/);
      assert.throws(() => validateSqlType('VARCHAR(20))'), /match allowed format/);
    });

    it('should reject empty or invalid inputs', () => {
      // @ts-ignore
      assert.throws(() => validateSqlType(null), /non-empty string/);
      assert.throws(() => validateSqlType(''), /non-empty string/);
    });
  });

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

    it('should handle empty strings', () => {
      assert.strictEqual(escapeIdentifier(''), '""');
    });
  });

  describe('assertUsableSqlIdentifier', () => {
    it('accepts legal SQLite identifiers without trimming or Unicode folding', () => {
      assert.doesNotThrow(() => assertUsableSqlIdentifier(' ui "table" 🚀 ', 'Table name'));
      assert.doesNotThrow(() => assertUsableSqlIdentifier('   ', 'Table name'));
      assert.doesNotThrow(() => assertUsableSqlIdentifier('Ä', 'Table name'));
      assert.doesNotThrow(() => assertUsableSqlIdentifier('ä', 'Table name'));
    });

    it('rejects missing, empty, and NUL-containing identifiers explicitly', () => {
      assert.throws(
        () => assertUsableSqlIdentifier(undefined, 'Table name'),
        /Table name is required/
      );
      assert.throws(
        () => assertUsableSqlIdentifier('', 'Column name'),
        /Column name is required/
      );
      assert.throws(
        () => assertUsableSqlIdentifier('bad\0name', 'View name'),
        /View name cannot contain NUL/
      );
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

    it('emits signed int64 BigInts as bare INTEGER literals', () => {
      assert.strictEqual(cellValueToSql(9007199254740993n), '9007199254740993');
      assert.strictEqual(cellValueToSql(9223372036854775807n), '9223372036854775807');
      assert.strictEqual(cellValueToSql(-9223372036854775808n), '-9223372036854775808');
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

    it('should securely handle NUL characters in strings', () => {
      const input = 'foo\0bar';
      const output = cellValueToSql(input);
      // 'foo\0bar' -> 66 6f 6f 00 62 61 72
      assert.strictEqual(output, "CAST(X'666f6f00626172' AS TEXT)");
    });
  });

  describe('escapeLikePattern', () => {
    it('should escape wildcards', () => {
      assert.strictEqual(escapeLikePattern('foo%bar'), 'foo\\%bar');
      assert.strictEqual(escapeLikePattern('foo_bar'), 'foo\\_bar');
    });

    it('should escape the escape character', () => {
      assert.strictEqual(escapeLikePattern('foo\\bar'), 'foo\\\\bar');
    });

    it('should escape multiple wildcards', () => {
      assert.strictEqual(escapeLikePattern('100%_test'), '100\\%\\_test');
    });

    it('should handle strings without wildcards', () => {
      assert.strictEqual(escapeLikePattern('normal text'), 'normal text');
    });
  });

  describe('validateRowId', () => {
    it('should return a number for valid numeric string', () => {
      assert.strictEqual(validateRowId('123'), 123);
    });

    it('should return a number for a valid number', () => {
      assert.strictEqual(validateRowId(456), 456);
    });

    it('should return negative numbers correctly', () => {
      assert.strictEqual(validateRowId('-789'), -789);
      assert.strictEqual(validateRowId(-12), -12);
    });

    it('should handle boundary integer values', () => {
      assert.strictEqual(validateRowId(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
      assert.strictEqual(validateRowId(Number.MIN_SAFE_INTEGER), Number.MIN_SAFE_INTEGER);
      assert.strictEqual(validateRowId(Number.MAX_SAFE_INTEGER.toString()), Number.MAX_SAFE_INTEGER);
      assert.strictEqual(validateRowId(Number.MIN_SAFE_INTEGER.toString()), Number.MIN_SAFE_INTEGER);
    });

    it('should handle bigint values correctly', () => {
      // @ts-ignore - testing BigInt fallback since JS allows it even if types don't
      assert.strictEqual(validateRowId(9007199254740991n), 9007199254740991);
      // @ts-ignore
      assert.strictEqual(validateRowId(-9007199254740991n), -9007199254740991);
    });

    it('preserves full-precision decimal strings for unsafe SQLite rowids', () => {
      assert.strictEqual(validateRowId('9007199254740993'), '9007199254740993');
      assert.strictEqual(validateRowId('-9007199254740993'), '-9007199254740993');
      assert.strictEqual(validateRowId('9223372036854775807'), '9223372036854775807');
      assert.strictEqual(validateRowId('-9223372036854775808'), '-9223372036854775808');
      assert.deepStrictEqual(
        validateRowIds(['9007199254740992', '9007199254740993']),
        ['9007199254740992', '9007199254740993']
      );
    });

    it('rejects decimal strings outside SQLite signed-int64 rowid bounds', () => {
      assert.throws(() => validateRowId('9223372036854775808'), /Invalid rowid:/);
      assert.throws(() => validateRowId('-9223372036854775809'), /Invalid rowid:/);
    });

    it('should reject empty or whitespace-only strings', () => {
      // Number('') and Number('   ') coerce to 0; a rowid must never silently become "row 0".
      assert.throws(() => validateRowId(''), /Invalid rowid:/);
      assert.throws(() => validateRowId('  '), /Invalid rowid:/);
    });

    it('should reject fractional and scientific-notation strings', () => {
      assert.throws(() => validateRowId('123.45'), /Invalid rowid: 123\.45/);
      assert.throws(() => validateRowId('1e3'), /Invalid rowid: 1e3/);
      assert.throws(() => validateRowId('-1e3'), /Invalid rowid: -1e3/);
    });

    it('should reject fractional numbers and unsafe-magnitude integers', () => {
      assert.throws(() => validateRowId(123.45), /Invalid rowid: 123\.45/);
      assert.throws(() => validateRowId(Number.MAX_SAFE_INTEGER + 1), /Invalid rowid:/);
    });

    it('should reject non-string/non-numeric types that Number() would coerce', () => {
      // Number(null)/Number(false)/Number([]) are all 0, Number(true) is 1, Number([5]) is 5 —
      // none are valid rowids. RecordId is string|number, but this guards untyped runtime values.
      // @ts-ignore - exercising the runtime type guard for values outside RecordId
      assert.throws(() => validateRowId(null), /Invalid rowid:/);
      // @ts-ignore
      assert.throws(() => validateRowId(undefined), /Invalid rowid:/);
      // @ts-ignore
      assert.throws(() => validateRowId(true), /Invalid rowid:/);
      // @ts-ignore
      assert.throws(() => validateRowId(false), /Invalid rowid:/);
      // @ts-ignore
      assert.throws(() => validateRowId([]), /Invalid rowid:/);
      // @ts-ignore
      assert.throws(() => validateRowId([5]), /Invalid rowid:/);
      // @ts-ignore
      assert.throws(() => validateRowId({}), /Invalid rowid:/);
    });

    it('should throw an error for non-numeric strings', () => {
      assert.throws(() => validateRowId('abc'), /Invalid rowid: abc/);
      assert.throws(() => validateRowId('12a'), /Invalid rowid: 12a/);
    });

    it('should throw an error for NaN and Infinity', () => {
      assert.throws(() => validateRowId(NaN), /Invalid rowid: NaN/);
      assert.throws(() => validateRowId(Infinity), /Invalid rowid: Infinity/);
    });
  });

  describe('validateRowIds', () => {
    it('should validate an array of valid row IDs', () => {
      assert.deepStrictEqual(validateRowIds(['1', 2, '3']), [1, 2, 3]);
    });

    it('should return an empty array for empty input', () => {
      assert.deepStrictEqual(validateRowIds([]), []);
    });

    it('should throw an error if any row ID is invalid', () => {
      assert.throws(() => validateRowIds(['1', 'a', 3]), /Invalid rowid: a/);
    });

    it('should throw on NaN, Infinity, or non-numeric strings anywhere in the array', () => {
      assert.throws(() => validateRowIds([1, NaN]), /Invalid rowid: NaN/);
      assert.throws(() => validateRowIds([Infinity, 2]), /Invalid rowid: Infinity/);
      assert.throws(() => validateRowIds(['1', 'abc']), /Invalid rowid: abc/);
    });

    it('should throw TypeError when given non-array malformed inputs', () => {
      // @ts-ignore
      assert.throws(() => validateRowIds(null), TypeError);
      // @ts-ignore
      assert.throws(() => validateRowIds(undefined), TypeError);
      // @ts-ignore
      assert.throws(() => validateRowIds({}), TypeError);
      // @ts-ignore
      assert.throws(() => validateRowIds(123), TypeError);
    });
  });
});
