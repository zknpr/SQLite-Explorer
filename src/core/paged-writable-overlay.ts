/** Maximum payload carried by one worker-to-host dirty-overlay run. */
export const MAX_PAGED_OVERLAY_RUN_BYTES = 8 * 1024 * 1024;
const PAGED_OVERLAY_COPY_WARNING_BYTES = 1024 * 1024 * 1024;

/** Immutable identity of the base file descriptor opened by the worker. */
export interface PagedFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  mode: bigint;
}

/** Direct result shape supplied by the patched sql.js fork. */
export interface RawPagedWritableOverlayChunk {
  index: number;
  data: Uint8Array;
}

/** Direct result shape supplied by the patched sql.js fork. */
export interface RawPagedWritableOverlay {
  chunkSize: number;
  logicalSize: number;
  baseLimit: number;
  chunks: RawPagedWritableOverlayChunk[];
}

/** One worker-to-host payload spanning contiguous dirty chunks. */
export interface PagedWritableOverlayRun {
  startChunkIndex: number;
  data: ArrayBuffer;
}

/** Validated worker-to-host snapshot used by the paged save protocol. */
export interface PagedWritableOverlaySnapshot {
  chunkSize: number;
  logicalSize: number;
  baseLimit: number;
  dirtyBytes: number;
  baseIdentity: PagedFileIdentity;
  runs: PagedWritableOverlayRun[];
}

function assertNonNegativeSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `Malformed paged writable overlay: ${name} must be a non-negative safe integer`
    );
  }
}

function exactTransferBuffer(data: Uint8Array): ArrayBuffer {
  if (
    data.buffer instanceof ArrayBuffer
    && data.byteOffset === 0
    && data.byteLength === data.buffer.byteLength
  ) {
    return data.buffer;
  }
  // Shared/oversized backing buffers are not exact transferable payloads.
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

/** Pure threshold check so the GiB boundary is testable without a GiB allocation. */
export function shouldWarnForPagedOverlayCopy(
  dirtyBytes: number,
  warningAlreadyEmitted: boolean = false
): boolean {
  return !warningAlreadyEmitted && dirtyBytes >= PAGED_OVERLAY_COPY_WARNING_BYTES;
}

/**
 * Validate untrusted fork output and coalesce adjacent dirty chunks into
 * bounded, exactly-sized buffers suitable for worker transfer.
 */
export function normalizePagedWritableOverlay(
  raw: unknown,
  baseIdentity: PagedFileIdentity
): PagedWritableOverlaySnapshot {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Malformed paged writable overlay: expected an object');
  }
  const candidate = raw as Partial<RawPagedWritableOverlay>;
  assertNonNegativeSafeInteger(candidate.chunkSize, 'chunkSize');
  if (candidate.chunkSize === 0) {
    throw new Error(
      'Malformed paged writable overlay: chunkSize must be a positive safe integer'
    );
  }
  assertNonNegativeSafeInteger(candidate.logicalSize, 'logicalSize');
  assertNonNegativeSafeInteger(candidate.baseLimit, 'baseLimit');
  if (!Array.isArray(candidate.chunks)) {
    throw new Error('Malformed paged writable overlay: chunks must be an array');
  }
  if (
    candidate.chunks.length > 0
    && candidate.chunkSize > MAX_PAGED_OVERLAY_RUN_BYTES
  ) {
    throw new Error('Malformed paged writable overlay: chunkSize exceeds the 8 MiB run cap');
  }

  const dirtyBytes = candidate.chunkSize * candidate.chunks.length;
  if (!Number.isSafeInteger(dirtyBytes)) {
    throw new Error('Malformed paged writable overlay: dirtyBytes exceeds safe integer range');
  }

  let previousIndex = -1;
  for (const [position, chunk] of candidate.chunks.entries()) {
    if (typeof chunk !== 'object' || chunk === null) {
      throw new Error(`Malformed paged writable overlay: chunks[${position}] must be an object`);
    }
    assertNonNegativeSafeInteger(chunk.index, `chunks[${position}].index`);
    if (chunk.index <= previousIndex) {
      throw new Error(
        'Malformed paged writable overlay: chunk indices must be sorted and unique'
      );
    }
    const byteOffset = chunk.index * candidate.chunkSize;
    if (!Number.isSafeInteger(byteOffset)) {
      throw new Error(
        `Malformed paged writable overlay: chunks[${position}] byte offset exceeds safe integer range`
      );
    }
    if (byteOffset > Number.MAX_SAFE_INTEGER - candidate.chunkSize) {
      throw new Error(
        `Malformed paged writable overlay: chunks[${position}] exclusive end exceeds safe integer range`
      );
    }
    if (!(chunk.data instanceof Uint8Array)) {
      throw new Error(
        `Malformed paged writable overlay: chunks[${position}].data must be a Uint8Array`
      );
    }
    if (chunk.data.byteLength !== candidate.chunkSize) {
      throw new Error(
        `Malformed paged writable overlay: chunks[${position}] data length must equal chunkSize`
      );
    }
    previousIndex = chunk.index;
  }

  const runs: PagedWritableOverlayRun[] = [];
  let position = 0;
  while (position < candidate.chunks.length) {
    const start = position;
    let end = start + 1;
    while (
      end < candidate.chunks.length
      && candidate.chunks[end].index === candidate.chunks[end - 1].index + 1
      && (end - start + 1) * candidate.chunkSize <= MAX_PAGED_OVERLAY_RUN_BYTES
    ) {
      end++;
    }

    if (end - start === 1) {
      runs.push({
        startChunkIndex: candidate.chunks[start].index,
        data: exactTransferBuffer(candidate.chunks[start].data)
      });
    } else {
      const merged = new Uint8Array((end - start) * candidate.chunkSize);
      for (let chunkPosition = start; chunkPosition < end; chunkPosition++) {
        merged.set(
          candidate.chunks[chunkPosition].data,
          (chunkPosition - start) * candidate.chunkSize
        );
      }
      runs.push({
        startChunkIndex: candidate.chunks[start].index,
        data: merged.buffer
      });
    }
    position = end;
  }

  return {
    chunkSize: candidate.chunkSize,
    logicalSize: candidate.logicalSize,
    baseLimit: candidate.baseLimit,
    dirtyBytes,
    baseIdentity,
    runs
  };
}
