/**
 * What the extension host sends the native worker, written here and not by
 * the editor's V8.
 *
 * The bundled runtime reads version 15 of V8's serialization format. The
 * host used to write its requests with `v8.serialize`, which writes whatever
 * version the editor's V8 has: VS Code 1.139 moved to version 16, the
 * runtime refused every request, and each open waited out its time limit
 * before the extension fell back to WebAssembly. A request is made of a few
 * kinds of value, so this writes them itself, always as version 15, the way
 * V8 and Node write them. What the worker receives then no longer depends on
 * the editor.
 *
 * The bytes are V8's own for every value written here
 * (`native_request_format.test.ts` compares them with `v8.serialize` under
 * Node, which writes version 15), except where V8 goes by how it happens to
 * hold a value in memory. There this picks one form, and the reader takes
 * either:
 * - a whole number in the 32-bit range is always written as an integer (V8
 *   writes one it holds as a double, as in `[28, 2.5]`, as a double);
 * - text whose characters all fit one byte is always written one byte each
 *   (V8 writes two when it holds the text that way);
 * - an array with no gaps is always written densely (V8 writes one it once
 *   held with gaps key by key).
 *
 * Anything else (a Date, a Map, an array with a gap, an object of a class)
 * is not written here: `encodeNativeRequest` answers `undefined` and the
 * caller sends V8's own bytes, as before. No request the extension makes
 * holds such a value, and the tests check that none does.
 *
 * Two things cannot be told apart from here and are written as they read: a
 * Proxy of an array or a plain object (V8 refuses one), and an object whose
 * getters change it while it is written.
 */

const VERSION = 15;

// V8's tags (`SerializationTag` in value-serializer.cc).
const TAG_VERSION = 0xff;
const TAG_PADDING = 0x00;
const TAG_UNDEFINED = 0x5f; // _
const TAG_NULL = 0x30; // 0
const TAG_TRUE = 0x54; // T
const TAG_FALSE = 0x46; // F
const TAG_INT32 = 0x49; // I
const TAG_DOUBLE = 0x4e; // N
const TAG_BIGINT = 0x5a; // Z
const TAG_ONE_BYTE_STRING = 0x22; // "
const TAG_TWO_BYTE_STRING = 0x63; // c
const TAG_OBJECT_REFERENCE = 0x5e; // ^
const TAG_BEGIN_OBJECT = 0x6f; // o
const TAG_END_OBJECT = 0x7b; // {
const TAG_BEGIN_DENSE_ARRAY = 0x41; // A
const TAG_END_DENSE_ARRAY = 0x24; // $
const TAG_HOST_OBJECT = 0x5c; // \

// Node's numbers for the views it writes as host objects (`arrayBufferViewTypes` in lib/v8.js).
const HOST_UINT8_ARRAY = 1;
const HOST_BUFFER = 10;

const NOT_ONE_BYTE = /[^\u0000-ÿ]/;
// An own key that is an array index is written as a number, as V8 does.
const ARRAY_INDEX = /^(?:0|[1-9]\d{0,9})$/;
const MAX_ARRAY_INDEX = 4294967294;

/** A value this does not write: the caller sends V8's bytes instead. */
class NotWrittenHere extends Error {}

class Writer {
  private bytes = Buffer.allocUnsafe(256);
  private length = 0;
  // Objects, arrays and views get a number at their first appearance, as V8 gives them; a later one is a reference to it.
  private readonly seen = new Map<object, number>();

  private room(more: number): void {
    if (this.length + more <= this.bytes.length) return;
    // Some room past a large value, so that the few bytes after it do not double the buffer.
    const grown = Buffer.allocUnsafe(Math.max(this.bytes.length * 2, this.length + more + 1024));
    this.bytes.copy(grown, 0, 0, this.length);
    this.bytes = grown;
  }

  private byte(value: number): void {
    this.room(1);
    this.bytes[this.length++] = value;
  }

  /** Base 128, low group first, as V8's WriteVarint. */
  private varint(value: number): void {
    this.room(5);
    let rest = value;
    while (rest >= 0x80) {
      this.bytes[this.length++] = (rest & 0x7f) | 0x80;
      rest = Math.floor(rest / 128);
    }
    this.bytes[this.length++] = rest;
  }

  header(): void {
    this.byte(TAG_VERSION);
    this.varint(VERSION);
  }

  value(value: unknown): void {
    switch (typeof value) {
      case 'undefined':
        return this.byte(TAG_UNDEFINED);
      case 'boolean':
        return this.byte(value ? TAG_TRUE : TAG_FALSE);
      case 'number':
        return this.number(value);
      case 'bigint':
        return this.bigint(value);
      case 'string':
        return this.string(value);
      case 'object':
        if (value === null) return this.byte(TAG_NULL);
        return this.object(value);
      default:
        throw new NotWrittenHere(typeof value);
    }
  }

  private number(value: number): void {
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 && !Object.is(value, -0)) {
      this.byte(TAG_INT32);
      // ZigZag, so that small negative numbers stay short.
      this.varint(((value << 1) ^ (value >> 31)) >>> 0);
      return;
    }
    this.room(9);
    this.bytes[this.length++] = TAG_DOUBLE;
    this.length = this.bytes.writeDoubleLE(value, this.length);
  }

  private bigint(value: bigint): void {
    this.byte(TAG_BIGINT);
    const negative = value < 0n;
    let magnitude = negative ? -value : value;
    // Whole 64-bit digits, low digit first; zero has none.
    const digits: bigint[] = [];
    while (magnitude > 0n) {
      digits.push(magnitude & 0xffffffffffffffffn);
      magnitude >>= 64n;
    }
    this.varint(digits.length * 8 * 2 + (negative ? 1 : 0));
    this.room(digits.length * 8);
    for (const digit of digits) this.length = this.bytes.writeBigUInt64LE(digit, this.length);
  }

  private string(value: string): void {
    if (!NOT_ONE_BYTE.test(value)) {
      this.byte(TAG_ONE_BYTE_STRING);
      this.varint(value.length);
      this.room(value.length);
      this.length += this.bytes.write(value, this.length, value.length, 'latin1');
      return;
    }
    const byteLength = value.length * 2;
    // V8 keeps two-byte text at an even place in the whole message.
    let lengthBytes = 1;
    for (let rest = byteLength; rest >= 0x80; rest = Math.floor(rest / 128)) lengthBytes++;
    if ((this.length + 1 + lengthBytes) & 1) this.byte(TAG_PADDING);
    this.byte(TAG_TWO_BYTE_STRING);
    this.varint(byteLength);
    this.room(byteLength);
    this.length += this.bytes.write(value, this.length, byteLength, 'utf16le');
  }

  private object(value: object): void {
    const known = this.seen.get(value);
    if (known !== undefined) {
      this.byte(TAG_OBJECT_REFERENCE);
      this.varint(known);
      return;
    }
    if (Array.isArray(value)) {
      this.seen.set(value, this.seen.size);
      return this.array(value);
    }
    if (value instanceof Uint8Array) {
      const kind = value.constructor === Buffer ? HOST_BUFFER : value.constructor === Uint8Array ? HOST_UINT8_ARRAY : undefined;
      if (kind === undefined) throw new NotWrittenHere('a view of another kind');
      this.seen.set(value, this.seen.size);
      this.byte(TAG_HOST_OBJECT);
      this.varint(kind);
      this.varint(value.byteLength);
      this.room(value.byteLength);
      this.bytes.set(value, this.length);
      this.length += value.byteLength;
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new NotWrittenHere('an object of a class');
    this.seen.set(value, this.seen.size);
    this.byte(TAG_BEGIN_OBJECT);
    const keys = Object.keys(value);
    if (Object.getOwnPropertySymbols(value).length > 0) throw new NotWrittenHere('a symbol key');
    for (const key of keys) {
      this.key(key);
      this.value((value as Record<string, unknown>)[key]);
    }
    this.byte(TAG_END_OBJECT);
    this.varint(keys.length);
  }

  private key(key: string): void {
    if (ARRAY_INDEX.test(key)) {
      const index = Number(key);
      if (index <= MAX_ARRAY_INDEX) return this.number(index);
    }
    this.string(key);
  }

  private array(value: unknown[]): void {
    const length = value.length;
    // Only its elements: one with a property of its own, with a gap, or with
    // an element that is not listed, is V8's to write. Keys come indices
    // first, in order, so as many keys as elements with the last index last
    // are every index and nothing else.
    const keys = Object.keys(value);
    if (keys.length !== length || (length > 0 && keys[length - 1] !== String(length - 1))) {
      throw new NotWrittenHere('an array with a gap or a property');
    }
    this.byte(TAG_BEGIN_DENSE_ARRAY);
    this.varint(length);
    for (let index = 0; index < length; index++) this.value(value[index]);
    this.byte(TAG_END_DENSE_ARRAY);
    this.varint(0);
    this.varint(length);
  }

  finish(): Buffer {
    return this.bytes.subarray(0, this.length);
  }
}

/**
 * The message as version 15 of V8's serialization format, or `undefined`
 * when it holds a value this does not write.
 */
export function encodeNativeRequest(message: unknown): Buffer | undefined {
  const writer = new Writer();
  try {
    writer.header();
    writer.value(message);
  } catch (error) {
    if (error instanceof NotWrittenHere) return undefined;
    throw error;
  }
  return writer.finish();
}
