import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CELL_EDIT_VALUE_TOO_LARGE_CODE,
  assertCellValueWithinEditLimit,
  assertCellValuesWithinEditLimit,
  fromCellEditPolicyErrorData,
  toCellEditPolicyErrorData
} from '../../src/core/cell-edit-policy';
import { DEFAULT_MAX_INLINE_CELL_BYTES } from '../../src/core/cell-containment';
import { MAX_WEBVIEW_BINARY_VALUE_BYTES } from '../../src/core/webview-transport';

describe('oversized cell edit policy', () => {
  it('rejects a new BLOB above the edit limit with a typed, round-trippable refusal', () => {
    let thrown: unknown;
    try {
      assertCellValueWithinEditLimit(new Uint8Array(9), 8);
    } catch (error) {
      thrown = error;
    }

    const data = toCellEditPolicyErrorData(thrown);
    assert.deepStrictEqual(data, {
      name: 'CellEditPolicyError',
      code: CELL_EDIT_VALUE_TOO_LARGE_CODE,
      storageClass: 'blob',
      actualBytes: 9,
      limitBytes: 8,
      message: 'New BLOB cell value is 9 bytes and exceeds the 8-byte edit limit.'
    });

    const restored = fromCellEditPolicyErrorData(data);
    assert.ok(restored);
    assert.strictEqual(restored.name, 'CellEditPolicyError');
    assert.strictEqual(restored.code, CELL_EDIT_VALUE_TOO_LARGE_CODE);
    assert.strictEqual(restored.actualBytes, 9);
  });

  it('counts UTF-8 bytes without allocating a second string and allows the exact boundary', () => {
    assert.doesNotThrow(() => assertCellValueWithinEditLimit('a😀', 5));
    assert.throws(
      () => assertCellValueWithinEditLimit('a😀', 4),
      error => {
        const data = toCellEditPolicyErrorData(error);
        assert.strictEqual(data?.storageClass, 'text');
        assert.strictEqual(data?.actualBytes, 5);
        assert.strictEqual(data?.limitBytes, 4);
        return true;
      }
    );
  });

  it('does not apply the byte policy to scalar SQLite values', () => {
    for (const value of [null, 1, 1n, 1.5] as const) {
      assert.doesNotThrow(() => assertCellValueWithinEditLimit(value, 1));
    }
  });

  it('defaults writes to the transport ceiling rather than the inline preview ceiling', () => {
    const replacement = new Uint8Array(DEFAULT_MAX_INLINE_CELL_BYTES + 1);

    assert.strictEqual(
      assertCellValuesWithinEditLimit([replacement]),
      MAX_WEBVIEW_BINARY_VALUE_BYTES
    );
  });
});
