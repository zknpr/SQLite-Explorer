import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import v8 from 'node:v8';

import { encodeNativeRequest } from '../../src/nativeRequestFormat';

/**
 * The extension writes its requests to the native worker itself, as version 15
 * of V8's serialization format, so that the editor's V8 cannot change what the
 * worker receives. This suite runs under Node, whose V8 writes version 15:
 * `v8.serialize` is the oracle, byte for byte, wherever V8 does not go by how
 * it holds a value in memory, and its reader checks the rest.
 */

const hex = (bytes: Uint8Array | undefined): string => (bytes ? Buffer.from(bytes).toString('hex') : 'not written');
const twoByte = (text: string): string => `✓${text}`;
const bytes = (length: number, start = 0): Uint8Array => Uint8Array.from({ length }, (_, index) => (start + index * 7) & 0xff);
// Of the 4,000 generated messages: how many must differ, and how many must hold a value twice.
const DIFFERENT = 3900;
const AGAIN = 1000;

describe('a request written for the native worker', () => {
  it('is, byte for byte, what V8 writes for the values a request is made of', () => {
    assert.equal(v8.serialize(0)[1], 15, 'this V8 writes the version the worker reads');
    const shared = { sql: 'SELECT 1', params: [] as unknown[] };
    const cycle: Record<string, unknown> = { name: 'cycle' };
    cycle.self = cycle;
    const view = bytes(4);
    const values: Record<string, unknown> = {
      'whole numbers': [0, 1, -1, 63, 64, -64, -65, 2 ** 31 - 1, -(2 ** 31)],
      'numbers that are not whole, or too large': [0.5, -2.5, 1e300, 2 ** 31 + 0.5, 2 ** 53 + 2, -(2 ** 31) - 1.5],
      'minus zero': -0,
      'not a number and the infinities': [NaN, Infinity, -Infinity].map((value) => ({ value })),
      'text of one byte each': ['', 'a', 'hello', 'café', 'a\u0000b', 'x'.repeat(200), 'y'.repeat(70000)],
      'text of two bytes each, alone and after other values': [twoByte(''), 'a', twoByte('done'), 'ab', '😀', '\ud83d', '中'.repeat(40000), 'abc', twoByte('x'.repeat(63)), twoByte('x'.repeat(64))],
      'true, false, null and undefined': [true, false, null, undefined, { missing: undefined }],
      'whole numbers of any size': [0n, 1n, -1n, 28n, 2n ** 63n - 1n, -(2n ** 63n), 2n ** 64n, -(2n ** 64n), 10n ** 60n, -(10n ** 60n)],
      'bytes': [new Uint8Array(0), bytes(5), bytes(70000), Buffer.from('hello'), Buffer.alloc(0), bytes(64).subarray(8, 24)],
      'arrays': [[], [1, 2, 3], ['a', 1, null], [[1, [2, [3]]], ['a', null, undefined, true]], [{ a: 1 }, { a: 2 }]],
      'objects': [{}, { a: { b: { c: [1, 2, { d: 'e' }] } } }, Object.assign(Object.create(null), { bare: 1 })],
      'keys that are array indices, in the order V8 gives them': { x: 'c', 2: 'b', 1: 'a', 2147483648: 'd', 4294967294: 'e', 4294967295: 'f', '-1': 'g', '01': 'h', [twoByte('key')]: 'i' },
      'a value that appears twice, and one that holds itself': [{ first: shared, second: shared }, [view, view], cycle],
      'the requests the host makes': [
        { id: 1, method: 'open', args: ['/tmp/x.db', false, 0], timeoutMs: 30000 },
        { id: 7, method: 'query', args: ['SELECT ?, ?', ['x', null, 5n, bytes(4), 28, -3], true], timeoutMs: 30000 },
        { id: 8, method: 'queryBatch', args: [[{ sql: 'SELECT 1', params: [] }, { sql: 'PRAGMA x', params: [1] }], true], timeoutMs: 1000 },
        { id: 9, method: 'cancel', args: [7] },
        { id: 10, method: 'run', args: [twoByte('INSERT'), [twoByte('value'), 'plain']], timeoutMs: 600000 }
      ]
    };
    for (const [name, value] of Object.entries(values)) {
      assert.equal(hex(encodeNativeRequest(value)), hex(v8.serialize(value)), name);
    }
  });

  it('picks one form where V8 goes by how it holds a value, and V8 reads it as the same value', () => {
    const holey = new Array(3);
    holey[0] = 1;
    holey[1] = 'two';
    holey[2] = 3;
    const cases: Array<[string, unknown]> = [
      // V8 writes 28 as a double here, because it holds the array's numbers as doubles.
      ['a whole number among numbers that are not', [28, 2.5]],
      // V8 writes this text two bytes each, because it is a piece of text that needed them.
      ['text that fits one byte each but is held as two', twoByte('plain text, long enough to stay a piece of the other').slice(1)],
      // V8 writes this array key by key, because it once had gaps.
      ['an array that was made with gaps and has none', holey]
    ];
    for (const [name, value] of cases) {
      const written = encodeNativeRequest(value);
      assert.ok(written, name);
      assert.notEqual(hex(written), hex(v8.serialize(value)), `${name}: V8 goes by its own form here`);
      assert.deepStrictEqual(v8.deserialize(written), v8.deserialize(v8.serialize(value)), name);
    }
  });

  it('is read by V8 as the value written, for generated values', () => {
    // Integer arithmetic only: a generator on floats repeats after a few hundred values.
    let state = 0x9e3779b9;
    const next = (): number => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };
    const pick = <T>(choices: readonly T[]): T => choices[next() % choices.length];
    const text = (): string => {
      const length = pick([0, 1, 2, 7, 63, 64, 127, 128, 300]);
      const units = pick([[0x61, 0x7a], [0x00, 0xff], [0x100, 0xffff], [0x00, 0xffff]] as const);
      let out = '';
      for (let index = 0; index < length; index++) out += String.fromCharCode(units[0] + (next() % (units[1] - units[0] + 1)));
      return out;
    };
    const number = (): number => pick([
      () => (next() % 200) - 100,
      () => next() | 0,
      () => next() * 4096 + next(),
      () => (next() / 0x100000000) * 1e6 - 5e5,
      () => pick([0, -0, NaN, Infinity, -Infinity, 2 ** 31, -(2 ** 31) - 1, 2 ** 53, 5e-324])
    ])();
    const big = (): bigint => {
      let value = 0n;
      for (let digits = next() % 4; digits > 0; digits--) value = (value << 32n) | BigInt(next());
      return next() % 2 ? value : -value;
    };
    // What one message has made so far: a later place can hold one of these again.
    const made: object[] = [];
    const keep = <T extends object>(object: T): T => {
      made.push(object);
      return object;
    };
    const value = (depth: number): unknown => {
      if (made.length > 0 && next() % 8 === 0) return pick(made);
      const kind = next() % (depth > 3 ? 7 : 9);
      switch (kind) {
        case 0: return number();
        case 1: return text();
        case 2: return pick([true, false, null, undefined]);
        case 3: return big();
        case 4: return keep(bytes(pick([0, 1, 16, 300]), next()));
        case 5: return keep(Buffer.from(bytes(pick([0, 3, 129]), next())));
        case 6: return number();
        case 7: return keep(Array.from({ length: next() % 6 }, () => value(depth + 1)));
        default: {
          // Kept before it is filled, so that it can come to hold itself.
          const object: Record<string, unknown> = keep({});
          for (let count = next() % 5; count > 0; count--) object[pick([text(), String(next() % 50), 'sql', 'params'])] = value(depth + 1);
          return object;
        }
      }
    };
    /** Which places hold a value that an earlier place holds: -1 for a first appearance, else the number of that one. */
    const appearances = (root: unknown): number[] => {
      const numbers = new Map<object, number>();
      const found: number[] = [];
      const walk = (item: unknown): void => {
        if (typeof item !== 'object' || item === null) return;
        const known = numbers.get(item);
        found.push(known ?? -1);
        if (known !== undefined) return;
        numbers.set(item, numbers.size);
        if (item instanceof Uint8Array) return;
        for (const inner of Array.isArray(item) ? item : Object.values(item)) walk(inner);
      };
      walk(root);
      return found;
    };
    const seen = new Set<string>();
    let again = 0;
    for (let index = 0; index < 4000; index++) {
      made.length = 0;
      const message = { id: index, method: pick(['query', 'run', 'execBatch']), args: [value(0), value(0), value(0)], timeoutMs: 30000 };
      const written = encodeNativeRequest(message);
      assert.ok(written, `value ${index} is written`);
      // Without the number, which differs anyway.
      seen.add(hex(encodeNativeRequest(message.args)));
      const read = v8.deserialize(written);
      assert.deepStrictEqual(read, message, `value ${index}`);
      // The same places hold the same value again: equal content does not show that.
      const places = appearances(message);
      assert.deepStrictEqual(appearances(read), places, `value ${index}: what appears twice`);
      if (places.some((place) => place !== -1)) again++;
    }
    assert.ok(seen.size > DIFFERENT, `${seen.size} different messages`);
    assert.ok(again > AGAIN, `${again} messages with a value that appears twice`);
  });

  it('does not hold a buffer twice the size of a request with a large value', () => {
    const blob = bytes(8 * 1024 * 1024);
    const written = encodeNativeRequest({ id: 1, method: 'run', args: ['UPDATE t SET b = ?', [blob]], timeoutMs: 30000 });
    assert.ok(written);
    assert.deepStrictEqual((v8.deserialize(written) as { args: [string, Uint8Array[]] }).args[1][0], blob);
    assert.ok(written.buffer.byteLength < written.length * 1.5, `${written.buffer.byteLength} bytes held for a message of ${written.length}`);
  });

  it('leaves to V8 a value no request holds', () => {
    class Row { value = 1; }
    const gap = [1, , 3]; // eslint-disable-line no-sparse-arrays
    const gapAndProperty: unknown[] & { extra?: number } = [1, , 3]; // eslint-disable-line no-sparse-arrays
    gapAndProperty.extra = 2;
    // As many listed keys as elements, and every index answers: V8 writes the unlisted element as a gap.
    const unlisted: unknown[] & { extra?: number } = [0, 0];
    Object.defineProperty(unlisted, 1, { value: 'hidden', enumerable: false });
    unlisted.extra = 1;
    const property: unknown[] & { extra?: number } = [1, 2];
    property.extra = 3;
    const left: Array<[string, unknown]> = [
      ['a date', new Date(0)], ['a map', new Map([[1, 2]])], ['a set', new Set([1])], ['an object of a class', new Row()],
      ['an array with a gap', gap], ['an array with a gap and a property', gapAndProperty], ['an array with a property', property],
      ['an array with an element that is not listed and a property', unlisted],
      ['a view of another kind', new Int32Array(2)], ['a buffer of its own', new ArrayBuffer(4)], ['a view over time', new DataView(new ArrayBuffer(4))],
      ['a key that is a symbol', { [Symbol('key')]: 1 }], ['a pattern', /a/], ['a boxed number', Object(5)]
    ];
    for (const [name, value] of left) {
      assert.equal(encodeNativeRequest(value), undefined, name);
      assert.equal(encodeNativeRequest({ id: 1, method: 'query', args: [[value]] }), undefined, `${name}, inside a request`);
    }
    // A function cannot be sent at all: V8 refuses it too.
    assert.equal(encodeNativeRequest(() => 1), undefined);
  });
});
