import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCellTextDecoder } from '../../src/core/cell-text-decoder';

for (const encoding of ['utf-16le', 'utf-16be'] as const) {
  const bytes = (units: number[]) => Uint8Array.from(units.flatMap(unit => encoding === 'utf-16le'
    ? [unit & 255, unit >>> 8] : [unit >>> 8, unit & 255]));

  test(`${encoding}: preserves stored text, BOM, NUL, surrogate pairs and long values`, () => {
    const decoder = createCellTextDecoder(encoding);
    for (const text of ['', '\uFEFF東京😀\0\uFFFE', '東京😀\n'.repeat(20_000)]) {
      const raw = bytes(Array.from({ length: text.length }, (_, index) => text.charCodeAt(index)));
      assert.equal(decoder.decode(raw), text);
      assert.equal(decoder.decode(raw), new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(raw));
    }
  });

  test(`${encoding}: refuses malformed bytes and stays reusable after a refusal`, () => {
    const decoder = createCellTextDecoder(encoding);
    for (const raw of [Uint8Array.of(0), bytes([0xd800]), bytes([0xdc00]),
      bytes([0xd800, 0x41]), bytes([0xd800, 0xd800]), bytes([0xdc00, 0xd800])]) {
      assert.throws(() => decoder.decode(raw), TypeError);
      assert.throws(() => new TextDecoder(encoding, { fatal: true }).decode(raw), TypeError);
      assert.equal(decoder.decode(bytes([0x41])), 'A');
    }
  });
}

test('UTF-8 retains fatal decoding and a stored BOM', () => {
  const decoder = createCellTextDecoder('utf-8');
  assert.equal(decoder.decode(new TextEncoder().encode('\uFEFF東京😀')), '\uFEFF東京😀');
  assert.throws(() => decoder.decode(Uint8Array.of(0xff)), TypeError);
});
