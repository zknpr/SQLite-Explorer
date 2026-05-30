/**
 * Unit tests for the DOM-free batch-update logic extracted from sidebar.js.
 * Covers the value-processing rules that drive the batch-update form.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  groupSelectedCellsByColumn,
  summarizeColumnValue,
  prepareBatchUpdates,
} from '../../core/ui/modules/batch-update-logic.js';
import type {
  BatchSelectedCell,
  BatchColumnDef,
  BatchInputLike,
} from '../../core/ui/modules/batch-update-logic.js';

const columns: BatchColumnDef[] = [
  { name: 'id', type: 'INTEGER' },
  { name: 'name', type: 'TEXT' },
  { name: 'price', type: 'REAL' },
  { name: 'meta', type: 'TEXT' },
];

const cell = (rowIdx: number, colIdx: number, value: unknown): BatchSelectedCell =>
  ({ rowId: rowIdx + 1, rowIdx, colIdx, value });

const input = (value: string, opts: { isnull?: boolean; ispatch?: boolean } = {}): BatchInputLike =>
  ({ value, dataset: { isnull: opts.isnull ? 'true' : 'false', ispatch: opts.ispatch ? 'true' : 'false' } });

describe('groupSelectedCellsByColumn', () => {
  it('groups cells by column with distinct value sets', () => {
    const grouped = groupSelectedCellsByColumn(
      [cell(0, 1, 'a'), cell(1, 1, 'b'), cell(2, 1, 'a'), cell(0, 0, 1)],
      columns
    );
    assert.strictEqual(grouped.size, 2);
    assert.strictEqual(grouped.get(1)!.name, 'name');
    assert.deepStrictEqual([...grouped.get(1)!.values], ['a', 'b']); // distinct
    assert.deepStrictEqual([...grouped.get(0)!.values], [1]);
  });
});

describe('summarizeColumnValue', () => {
  it('shows the single shared value', () => {
    assert.strictEqual(summarizeColumnValue(new Set(['hello'])), 'hello');
    assert.strictEqual(summarizeColumnValue(new Set([42])), '42');
  });
  it('shows NULL for null and [BLOB] for binary', () => {
    assert.strictEqual(summarizeColumnValue(new Set([null])), 'NULL');
    assert.strictEqual(summarizeColumnValue(new Set([new Uint8Array([1, 2])])), '[BLOB]');
  });
  it('shows (mixed values) when the selection spans differing values', () => {
    assert.strictEqual(summarizeColumnValue(new Set(['a', 'b'])), '(mixed values)');
  });
});

describe('prepareBatchUpdates', () => {
  it('coerces INTEGER columns to numbers (operation set)', () => {
    const [u] = prepareBatchUpdates([cell(0, 0, 5)], new Map([[0, input('42')]]), columns);
    assert.strictEqual(u.value, 42);
    assert.strictEqual(typeof u.value, 'number');
    assert.strictEqual(u.operation, 'set');
    assert.strictEqual(u.column, 'id');
    assert.strictEqual(u.originalValue, 5);
  });
  it('coerces REAL columns', () => {
    const [u] = prepareBatchUpdates([cell(0, 2, 1)], new Map([[2, input('3.14')]]), columns);
    assert.strictEqual(u.value, 3.14);
  });
  it('does not coerce non-numeric input in a numeric column', () => {
    const [u] = prepareBatchUpdates([cell(0, 0, 1)], new Map([[0, input('abc')]]), columns);
    assert.strictEqual(u.value, 'abc');
  });
  it('leaves TEXT values as strings', () => {
    const [u] = prepareBatchUpdates([cell(0, 1, 'x')], new Map([[1, input('hello')]]), columns);
    assert.strictEqual(u.value, 'hello');
  });
  it('sets value to null when the field is marked NULL', () => {
    const [u] = prepareBatchUpdates([cell(0, 1, 'x')], new Map([[1, input('', { isnull: true })]]), columns);
    assert.strictEqual(u.value, null);
    assert.strictEqual(u.operation, 'set');
  });
  it('tags json_patch and keeps the raw patch string', () => {
    const [u] = prepareBatchUpdates([cell(0, 3, '{}')], new Map([[3, input('{"a":1}', { ispatch: true })]]), columns);
    assert.strictEqual(u.operation, 'json_patch');
    assert.strictEqual(u.value, '{"a":1}');
  });
  it('skips cells left blank unless explicitly NULL', () => {
    assert.strictEqual(prepareBatchUpdates([cell(0, 1, 'x')], new Map([[1, input('')]]), columns).length, 0);
  });
  it('skips cells whose column has no input', () => {
    assert.strictEqual(prepareBatchUpdates([cell(0, 1, 'x')], new Map(), columns).length, 0);
  });
  it('processes multiple cells and preserves row/col metadata', () => {
    const updates = prepareBatchUpdates([cell(0, 1, 'x'), cell(1, 1, 'y')], new Map([[1, input('Z')]]), columns);
    assert.strictEqual(updates.length, 2);
    assert.deepStrictEqual(updates.map(u => u.rowIdx), [0, 1]);
    assert.strictEqual(updates[0].colIdx, 1);
  });
});

describe('batch-update-logic hardening (edge cases)', () => {
  it('groupSelectedCellsByColumn skips out-of-bounds column indices', () => {
    const grouped = groupSelectedCellsByColumn([cell(0, 99, 'x'), cell(0, 1, 'a')], columns);
    assert.strictEqual(grouped.size, 1);
    assert.ok(grouped.has(1));
    assert.ok(!grouped.has(99));
  });
  it('summarizeColumnValue returns empty string for an empty set', () => {
    assert.strictEqual(summarizeColumnValue(new Set()), '');
  });
  it('prepareBatchUpdates skips cells whose column is out of bounds (e.g. after a column drop)', () => {
    assert.strictEqual(prepareBatchUpdates([cell(0, 99, 'x')], new Map([[99, input('v')]]), columns).length, 0);
  });
  it('prepareBatchUpdates tolerates an input without a dataset', () => {
    const [u] = prepareBatchUpdates([cell(0, 1, 'x')], new Map([[1, { value: 'hi' } as BatchInputLike]]), columns);
    assert.strictEqual(u.value, 'hi');
    assert.strictEqual(u.operation, 'set');
  });
});
