import { describe, it } from 'node:test';
import assert from 'node:assert';
import { toDatasetAttrs, toBoolString } from '../../src/html-utils';

describe('toDatasetAttrs', () => {
  it('should return empty string for empty object', () => {
    assert.strictEqual(toDatasetAttrs({}), '');
  });

  it('should format string values correctly', () => {
    assert.strictEqual(toDatasetAttrs({ foo: 'bar' }), 'data-foo="bar"');
  });

  it('should format boolean values correctly', () => {
    assert.strictEqual(toDatasetAttrs({ active: true }), 'data-active="true"');
    assert.strictEqual(toDatasetAttrs({ disabled: false }), 'data-disabled="false"');
  });

  it('should omit undefined values', () => {
    assert.strictEqual(toDatasetAttrs({ foo: undefined }), '');
    assert.strictEqual(toDatasetAttrs({ foo: 'bar', baz: undefined }), 'data-foo="bar"');
  });

  it('should convert camelCase keys to dash-case', () => {
    assert.strictEqual(toDatasetAttrs({ fooBar: 'baz' }), 'data-foo-bar="baz"');
    assert.strictEqual(toDatasetAttrs({ myLongVariableName: 'value' }), 'data-my-long-variable-name="value"');
  });

  it('should handle mixed types', () => {
    const input = {
      id: '123',
      isActive: true,
      hidden: false,
      optional: undefined
    };
    const result = toDatasetAttrs(input);
    assert.strictEqual(result, 'data-id="123" data-is-active="true" data-hidden="false"');
  });

  it('should join multiple attributes with space', () => {
      const result = toDatasetAttrs({ a: '1', b: '2' });
      assert.strictEqual(result, 'data-a="1" data-b="2"');
  });
});

describe('toBoolString', () => {
  it('should return "true" for true', () => {
    assert.strictEqual(toBoolString(true), 'true');
  });

  it('should return "false" for false', () => {
    assert.strictEqual(toBoolString(false), 'false');
  });

  it('should return undefined for null or undefined', () => {
    assert.strictEqual(toBoolString(null), undefined);
    assert.strictEqual(toBoolString(undefined), undefined);
  });
});
