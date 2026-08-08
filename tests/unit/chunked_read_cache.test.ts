import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createChunkedReadCache,
  DEFAULT_CHUNK_SIZE_BYTES,
  DEFAULT_MAX_CACHE_BYTES
} from '../../src/core/chunked-read-cache';

/**
 * The chunked read cache must be byte-for-byte transparent: any
 * read(offset, length) served through it must equal a direct read,
 * including EOF short tails, while the LRU stays bounded and per-open
 * instances stay isolated. These properties are what let it sit inside
 * both paged hostIo adapters (demo FileReaderSync, desktop fs.readSync)
 * without changing what SQLite sees.
 */

/** Reference reader over a byte fixture with clamped-EOF semantics. */
function makeBacking(bytes: Uint8Array) {
  const calls: Array<{ offset: number; length: number }> = [];
  const read = (offset: number, length: number): Uint8Array => {
    calls.push({ offset, length });
    return bytes.slice(offset, Math.min(offset + length, bytes.length));
  };
  return { calls, read };
}

/** What a direct (uncached) read returns: the ground truth. */
function directRead(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  return bytes.slice(offset, Math.min(offset + length, bytes.length));
}

function makeFixture(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    // xorshift32: deterministic, cheap, full-byte coverage.
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

describe('chunked read cache', () => {
  it('serves byte-identical results across chunk boundaries and the EOF tail', () => {
    // Fixture length deliberately NOT chunk-aligned: 3.5 chunks + 37 bytes.
    const chunk = 256;
    const bytes = makeFixture(chunk * 3 + chunk / 2 + 37, 0xc0ffee);
    const backing = makeBacking(bytes);
    const read = createChunkedReadCache(backing.read, { chunkSizeBytes: chunk });

    const windows: Array<[number, number]> = [
      [0, 100],                       // engine header probe shape
      [0, chunk],                     // exactly one chunk
      [1, chunk],                     // one-past-alignment spanning two chunks
      [chunk - 1, 2],                 // boundary straddle
      [chunk, chunk],                 // aligned second chunk
      [chunk / 2, chunk * 2],         // three-chunk span
      [0, bytes.length],              // whole file
      [0, bytes.length + 999],        // over-read: EOF short tail
      [bytes.length - 37, 37],        // exact tail
      [bytes.length - 1, chunk],      // tail straddle
      [bytes.length, 16],             // at EOF: empty
      [bytes.length + chunk * 4, 16], // far past EOF: empty
      [chunk * 3, chunk]              // last partial chunk
    ];
    for (const [offset, length] of windows) {
      assert.deepStrictEqual(
        Array.from(read(offset, length)),
        Array.from(directRead(bytes, offset, length)),
        `read(${offset}, ${length}) must match a direct read`
      );
    }
  });

  it('matches direct reads on randomized windows (seeded sweep)', () => {
    const chunk = 128;
    const bytes = makeFixture(chunk * 5 + 61, 0xdead);
    const backing = makeBacking(bytes);
    const read = createChunkedReadCache(backing.read, {
      chunkSizeBytes: chunk,
      // Tiny budget so the sweep also exercises constant eviction.
      maxCacheBytes: chunk * 2
    });

    let state = 0xbeef;
    const next = (bound: number): number => {
      state ^= state << 13; state >>>= 0;
      state ^= state >> 17;
      state ^= state << 5; state >>>= 0;
      return state % bound;
    };
    for (let i = 0; i < 500; i++) {
      const offset = next(bytes.length + chunk * 2);
      const length = next(chunk * 3) + 1;
      assert.deepStrictEqual(
        Array.from(read(offset, length)),
        Array.from(directRead(bytes, offset, length)),
        `random read(${offset}, ${length}) must match a direct read`
      );
    }
  });

  it('coalesces sequential page-sized reads into one backing read per chunk', () => {
    const chunk = 64 * 1024;
    const page = 4096;
    const bytes = makeFixture(chunk * 2, 0x5eed);
    const backing = makeBacking(bytes);
    const read = createChunkedReadCache(backing.read, { chunkSizeBytes: chunk });

    for (let offset = 0; offset < bytes.length; offset += page) {
      const result = read(offset, page);
      assert.strictEqual(result.length, page);
    }
    // 32 page reads served by 2 chunk fetches: the coalescing win.
    assert.strictEqual(backing.calls.length, 2);
    assert.deepStrictEqual(backing.calls, [
      { offset: 0, length: chunk },
      { offset: chunk, length: chunk }
    ]);
  });

  it('bounds the cache and evicts least-recently-used, not most recent', () => {
    const chunk = 64;
    const bytes = makeFixture(chunk * 8, 0xace);
    const backing = makeBacking(bytes);
    // Budget of 3 chunks.
    const read = createChunkedReadCache(backing.read, {
      chunkSizeBytes: chunk,
      maxCacheBytes: chunk * 3
    });

    read(0, 8);              // load chunk 0
    read(chunk, 8);          // load chunk 1
    read(chunk * 2, 8);      // load chunk 2 — cache full [0,1,2]
    read(0, 8);              // HIT chunk 0, refreshing it → order [1,2,0]
    assert.strictEqual(backing.calls.length, 3);

    read(chunk * 3, 8);      // load chunk 3 → evicts chunk 1 (LRU)
    assert.strictEqual(backing.calls.length, 4);

    read(0, 8);              // chunk 0 must still be cached (was refreshed)
    read(chunk * 2, 8);      // chunk 2 still cached
    assert.strictEqual(backing.calls.length, 4, 'refreshed chunks must survive eviction');

    read(chunk, 8);          // chunk 1 was evicted → backing read again
    assert.strictEqual(backing.calls.length, 5);
  });

  it('keeps per-open instances fully isolated', () => {
    const chunk = 64;
    const first = makeFixture(chunk * 2, 1);
    const second = makeFixture(chunk * 2, 2);
    assert.notDeepStrictEqual(Array.from(first), Array.from(second));
    const firstBacking = makeBacking(first);
    const secondBacking = makeBacking(second);
    const readFirst = createChunkedReadCache(firstBacking.read, { chunkSizeBytes: chunk });
    const readSecond = createChunkedReadCache(secondBacking.read, { chunkSizeBytes: chunk });

    assert.deepStrictEqual(Array.from(readFirst(0, chunk)), Array.from(first.subarray(0, chunk)));
    assert.deepStrictEqual(Array.from(readSecond(0, chunk)), Array.from(second.subarray(0, chunk)));
    // A second wrapper over the same source starts cold: no shared state.
    const readFirstAgain = createChunkedReadCache(firstBacking.read, { chunkSizeBytes: chunk });
    readFirstAgain(0, 8);
    assert.strictEqual(firstBacking.calls.length, 2, 'fresh instance must not share cached chunks');
  });

  it('handles zero-length reads without touching the backing reader', () => {
    const backing = makeBacking(makeFixture(1024, 3));
    const read = createChunkedReadCache(backing.read, { chunkSizeBytes: 256 });
    assert.deepStrictEqual(Array.from(read(0, 0)), []);
    assert.deepStrictEqual(Array.from(read(4096, 0)), []);
    assert.strictEqual(backing.calls.length, 0);
  });

  it('caches the EOF tail chunk so repeated tail reads cost no backing calls', () => {
    const chunk = 256;
    const bytes = makeFixture(chunk + 40, 4);
    const backing = makeBacking(bytes);
    const read = createChunkedReadCache(backing.read, { chunkSizeBytes: chunk });
    read(chunk, 40);
    read(chunk, 40);
    read(chunk + 10, 100);
    assert.strictEqual(backing.calls.length, 1, 'short tail chunk must be cached too');
  });

  it('validates inputs and options', () => {
    const backing = makeBacking(makeFixture(64, 5));
    const read = createChunkedReadCache(backing.read, { chunkSizeBytes: 16 });
    assert.throws(() => read(-1, 4), /offset must be a non-negative safe integer/);
    assert.throws(() => read(1.5, 4), /offset must be a non-negative safe integer/);
    assert.throws(() => read(0, -1), /length must be a non-negative safe integer/);
    assert.throws(() => read(0, Number.NaN), /length must be a non-negative safe integer/);
    assert.throws(
      () => createChunkedReadCache(backing.read, { chunkSizeBytes: 0 }),
      /Chunk size must be a positive safe integer/
    );
    assert.throws(
      () => createChunkedReadCache(backing.read, { maxCacheBytes: -1 }),
      /Cache budget must be a positive safe integer/
    );
    // Defaults stay in the envelope the paged program chose.
    assert.strictEqual(DEFAULT_CHUNK_SIZE_BYTES, 64 * 1024);
    assert.strictEqual(DEFAULT_MAX_CACHE_BYTES, 8 * 1024 * 1024);
  });
});
