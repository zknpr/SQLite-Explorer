import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  MAX_PAGED_OVERLAY_RUN_BYTES,
  normalizePagedWritableOverlay,
  shouldWarnForPagedOverlayCopy,
  type PagedFileIdentity,
  type RawPagedWritableOverlay
} from '../../src/core/paged-writable-overlay';

const identity: PagedFileIdentity = {
  dev: 1n,
  ino: 2n,
  size: 3n,
  mtimeNs: 4n,
  mode: 0o600n
};

function rawOverlay(
  chunkSize: number,
  indices: readonly number[]
): RawPagedWritableOverlay {
  return {
    chunkSize,
    logicalSize: chunkSize * (indices.at(-1)! + 1),
    baseLimit: chunkSize,
    chunks: indices.map(index => ({
      index,
      data: new Uint8Array(chunkSize).fill(index + 1)
    }))
  };
}

describe('paged writable overlay normalization', () => {
  it('coalesces only contiguous chunks and reuses exact singleton buffers', () => {
    const raw = rawOverlay(4, [0, 1, 3]);
    const singletonBuffer = raw.chunks[2].data.buffer;

    const snapshot = normalizePagedWritableOverlay(raw, identity);

    assert.strictEqual(snapshot.chunkSize, 4);
    assert.strictEqual(snapshot.logicalSize, 16);
    assert.strictEqual(snapshot.baseLimit, 4);
    assert.strictEqual(snapshot.dirtyBytes, 12);
    assert.strictEqual(snapshot.baseIdentity, identity);
    assert.deepStrictEqual(
      snapshot.runs.map(run => ({
        startChunkIndex: run.startChunkIndex,
        bytes: Array.from(new Uint8Array(run.data))
      })),
      [
        { startChunkIndex: 0, bytes: [1, 1, 1, 1, 2, 2, 2, 2] },
        { startChunkIndex: 3, bytes: [4, 4, 4, 4] }
      ]
    );
    assert.strictEqual(snapshot.runs[1].data, singletonBuffer);
  });

  it('caps contiguous runs at 8 MiB without copying the singleton tail', () => {
    const chunkSize = MAX_PAGED_OVERLAY_RUN_BYTES / 2;
    const raw = rawOverlay(chunkSize, [0, 1, 2]);
    const tailBuffer = raw.chunks[2].data.buffer;

    const snapshot = normalizePagedWritableOverlay(raw, identity);

    assert.deepStrictEqual(
      snapshot.runs.map(run => [run.startChunkIndex, run.data.byteLength]),
      [[0, MAX_PAGED_OVERLAY_RUN_BYTES], [2, chunkSize]]
    );
    assert.strictEqual(snapshot.runs[1].data, tailBuffer);
  });

  it('copies a singleton view when its backing buffer is not exact', () => {
    const backing = new Uint8Array([9, 1, 2, 8]);
    const view = backing.subarray(1, 3);
    const snapshot = normalizePagedWritableOverlay({
      chunkSize: 2,
      logicalSize: 2,
      baseLimit: 2,
      chunks: [{ index: 0, data: view }]
    }, identity);

    assert.notStrictEqual(snapshot.runs[0].data, backing.buffer);
    assert.strictEqual(snapshot.runs[0].data.byteLength, 2);
    assert.deepStrictEqual(Array.from(new Uint8Array(snapshot.runs[0].data)), [1, 2]);
  });

  it('rejects malformed fork output loudly', () => {
    const valid = rawOverlay(4, [0, 2]);
    const malformed: Array<[string, unknown, RegExp]> = [
      ['zero chunk size', { ...valid, chunkSize: 0 }, /chunkSize.*positive safe integer/i],
      ['fractional logical size', { ...valid, logicalSize: 1.5 }, /logicalSize.*non-negative safe integer/i],
      ['unsafe base limit', { ...valid, baseLimit: Number.MAX_SAFE_INTEGER + 1 }, /baseLimit.*non-negative safe integer/i],
      ['unsorted indices', { ...valid, chunks: [valid.chunks[1], valid.chunks[0]] }, /sorted.*unique/i],
      ['duplicate indices', { ...valid, chunks: [valid.chunks[0], valid.chunks[0]] }, /sorted.*unique/i],
      ['wrong chunk length', {
        ...valid,
        chunks: [{ index: 0, data: new Uint8Array(3) }]
      }, /data length.*chunkSize/i],
      ['non-byte payload', {
        ...valid,
        chunks: [{ index: 0, data: [1, 2, 3, 4] }]
      }, /Uint8Array/i],
      ['unsafe chunk offset', {
        chunkSize: 2,
        logicalSize: 2,
        baseLimit: 2,
        chunks: [{ index: Number.MAX_SAFE_INTEGER, data: new Uint8Array(2) }]
      }, /byte offset.*safe integer/i],
      ['unsafe chunk exclusive end', {
        chunkSize: 2,
        logicalSize: 2,
        baseLimit: 2,
        chunks: [{ index: 4503599627370495, data: new Uint8Array(2) }]
      }, /exclusive end.*safe integer/i],
      ['chunk exceeds run cap', {
        chunkSize: MAX_PAGED_OVERLAY_RUN_BYTES + 1,
        logicalSize: MAX_PAGED_OVERLAY_RUN_BYTES + 1,
        baseLimit: 0,
        chunks: [{ index: 0, data: new Uint8Array(MAX_PAGED_OVERLAY_RUN_BYTES + 1) }]
      }, /chunkSize.*8 MiB/i]
    ];

    for (const [name, raw, expected] of malformed) {
      assert.throws(
        () => normalizePagedWritableOverlay(raw as RawPagedWritableOverlay, identity),
        expected,
        name
      );
    }
  });

  it('checks the 1 GiB warning threshold arithmetically', () => {
    const oneGiB = 1024 * 1024 * 1024;
    assert.strictEqual(shouldWarnForPagedOverlayCopy(oneGiB - 1), false);
    assert.strictEqual(shouldWarnForPagedOverlayCopy(oneGiB), true);
    assert.strictEqual(shouldWarnForPagedOverlayCopy(oneGiB + 1), true);
    assert.strictEqual(shouldWarnForPagedOverlayCopy(oneGiB, true), false);
  });
});
