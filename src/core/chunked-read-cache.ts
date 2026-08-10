/**
 * Chunked read cache for paged-database host I/O (read coalescing).
 *
 * Both paged VFS variants (`openPaged` and `openPagedWritable`) pull 4KB
 * SQLite base pages through a synchronous `read(offset, length)` host callback.
 * Each host call has a
 * flat per-call cost (~100-300µs for FileReaderSync / fs.readSync round
 * trips regardless of size in the 4-16KiB range), so a multi-GB table scan
 * that issues one host call per 4KB page spends almost all of its time in
 * call overhead. This helper serves those small reads from a bounded LRU of
 * larger aligned chunks, so a sequential scan costs one host call per
 * (chunk size / page size) pages instead of one per page.
 *
 * Correctness contract:
 * - The assembled result is byte-identical to what a direct
 *   `rawRead(offset, length)` would return, including the short tail at
 *   EOF: the underlying readers (Blob.slice + FileReaderSync in the web
 *   demo, positional fs.readSync on desktop) return fewer than the
 *   requested bytes exactly when the request overruns EOF, and a short
 *   chunk therefore marks EOF inside that chunk. Reads at or past EOF
 *   return an empty array, as the raw readers do.
 * - The cache is strictly per-open: create a fresh instance for every
 *   database open and drop it with the connection. Cache misses call
 *   `rawRead`; hosts backed by mutable files must validate their captured
 *   file identity in that callback before returning the read. Without that
 *   check, a hit can return the old generation while a miss returns the new one.
 * - Returned arrays may be views into cached chunks. The sql.js paged VFS
 *   copies every read result into the WASM heap before returning to
 *   SQLite (verified empirically: serving all reads from one reused
 *   scratch buffer works), so aliasing is safe there; any other consumer
 *   must copy before retaining or mutating a result.
 */

/**
 * Synchronous absolute-offset reader. Must return exactly `length` bytes,
 * short only when the request overruns EOF (empty at or past EOF).
 */
export type ChunkedRawReader = (offset: number, length: number) => Uint8Array;

/**
 * Chunk size: 64KiB. SQLite page sizes are powers of two between 512B and
 * 64KiB, so every page read falls entirely inside one aligned 64KiB chunk
 * (offsets of N-byte pages are N-aligned); with the common 4KB page size a
 * sequential scan makes one host call per 16 pages. Larger chunks would
 * amortize better on pure sequential scans but waste I/O and cache space
 * on the random b-tree descents that dominate point lookups.
 */
export const DEFAULT_CHUNK_SIZE_BYTES = 64 * 1024;

/**
 * Cache budget: 8MiB (128 chunks of 64KiB). Enough to keep a working set
 * of hot interior b-tree pages plus several leaf runs resident during
 * scans, while staying trivial next to the multi-hundred-MB buffers the
 * paged path exists to avoid. Sized within the 4-8MiB envelope chosen for
 * this stage; the win comes from coalescing (fewer host calls), not from
 * cache capacity, so growing this further shows quickly diminishing
 * returns.
 */
export const DEFAULT_MAX_CACHE_BYTES = 8 * 1024 * 1024;

export interface ChunkedReadCacheOptions {
  /** Aligned chunk size in bytes (positive safe integer). */
  chunkSizeBytes?: number;
  /** Cache budget in bytes; at least one chunk is always retained. */
  maxCacheBytes?: number;
}

function resolvePositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

/**
 * Wrap a raw absolute-offset reader with an aligned-chunk LRU cache.
 *
 * The returned function is a drop-in replacement for `rawRead` with the
 * byte-identical-result contract documented in the module header. Create
 * one wrapper per database open; never share instances across opens.
 */
export function createChunkedReadCache(
  rawRead: ChunkedRawReader,
  options: ChunkedReadCacheOptions = {}
): ChunkedRawReader {
  const chunkSize = resolvePositiveInteger(
    options.chunkSizeBytes,
    DEFAULT_CHUNK_SIZE_BYTES,
    'Chunk size'
  );
  const maxCacheBytes = resolvePositiveInteger(
    options.maxCacheBytes,
    DEFAULT_MAX_CACHE_BYTES,
    'Cache budget'
  );
  const maxChunks = Math.max(1, Math.floor(maxCacheBytes / chunkSize));

  // Map iteration order is insertion order: delete+set on hit refreshes an
  // entry to most-recently-used, and the first key is always the eviction
  // victim. Chunks may be short (EOF) or empty (fully past EOF); both are
  // cached so repeated tail reads cost no host calls.
  const chunks = new Map<number, Uint8Array>();

  function chunkAt(index: number): Uint8Array {
    const cached = chunks.get(index);
    if (cached !== undefined) {
      chunks.delete(index);
      chunks.set(index, cached);
      return cached;
    }
    const loaded = rawRead(index * chunkSize, chunkSize);
    // Defensive trim: a reader returning MORE than requested would corrupt
    // assembly arithmetic; the contract forbids it, but clamp anyway.
    const chunk = loaded.length > chunkSize ? loaded.subarray(0, chunkSize) : loaded;
    chunks.set(index, chunk);
    if (chunks.size > maxChunks) {
      const oldest = chunks.keys().next().value as number;
      chunks.delete(oldest);
    }
    return chunk;
  }

  return (offset: number, length: number): Uint8Array => {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('Read offset must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error('Read length must be a non-negative safe integer');
    }
    if (length === 0) return new Uint8Array(0);

    const firstIndex = Math.floor(offset / chunkSize);
    const lastIndex = Math.floor((offset + length - 1) / chunkSize);

    if (firstIndex === lastIndex) {
      // Hot path: the read (page-sized in practice) lies inside one chunk.
      const chunk = chunkAt(firstIndex);
      const start = offset - firstIndex * chunkSize;
      if (start >= chunk.length) return new Uint8Array(0);
      return chunk.subarray(start, Math.min(start + length, chunk.length));
    }

    // Assemble a spanning read from consecutive chunks. A short chunk marks
    // EOF inside it, so assembly stops there and the result carries exactly
    // the bytes a direct read would have returned.
    const out = new Uint8Array(length);
    let filled = 0;
    for (let index = firstIndex; index <= lastIndex; index++) {
      const chunk = chunkAt(index);
      const chunkStart = index * chunkSize;
      const from = Math.max(offset, chunkStart) - chunkStart;
      const to = Math.min(offset + length, chunkStart + chunkSize) - chunkStart;
      const available = Math.min(to, chunk.length);
      if (from >= available) break;
      out.set(chunk.subarray(from, available), chunkStart + from - offset);
      filled = chunkStart + available - offset;
      if (chunk.length < chunkSize) break;
    }
    return filled === length ? out : out.subarray(0, filled);
  };
}
