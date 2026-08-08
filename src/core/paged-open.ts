/**
 * Web demo database-open routing: buffer vs page-on-demand.
 *
 * The web demo historically loaded every database fully into memory
 * ("buffer" mode: bytes -> sql.js MEMFS). The patched sql.js fork adds
 * `SQL.Database.openPaged(hostIo)`, a read-only mode where SQLite pulls
 * 4KB pages through host callbacks instead, so a multi-GB file opens with
 * near-zero heap cost. This module holds the pure routing logic shared by
 * the demo page (which decides what to post to the worker) and the demo
 * worker (which decides how to open what it received), so both sides and
 * the unit tests agree on one ladder:
 *
 *   (a) WAL-marked header (bytes 18/19 == 0x02)  -> never paged. The
 *       paged VFS is a read-only snapshot of the main file only; an
 *       at-rest WAL database may have committed frames in a sibling -wal
 *       the browser cannot see, and the fork refuses/ignores WAL
 *       sidecars by design.
 *   (b) size > paged threshold                    -> paged, read-only.
 *   (c) otherwise                                 -> today's editable
 *       buffer path, unchanged.
 *
 * WAL files above the threshold still buffer-open (read-only — mirroring
 * the extension's WAL gate in workerFactory.ts, which forces readOnlyMode
 * whenever WAL state may exist that the engine cannot see) as long as
 * they fit under the buffer ceiling; beyond it they are rejected with an
 * actionable message. Paged-open failure (capability absent in the
 * vendored build, or an open error) re-enters the ladder with
 * `pagedAvailable: false`, which lands on the same buffer path or the
 * same rejection today's code would produce — no new dead-end states.
 */

import { MAX_WEBVIEW_BINARY_VALUE_BYTES } from './webview-transport';

/**
 * The canonical SQLite header probe: the first 100 bytes contain the
 * magic string (offset 0..15) and the file-format write/read versions
 * (offsets 18/19). One slice serves every routing question.
 */
export const SQLITE_HEADER_PROBE_BYTES = 100;

/** Offsets 18/19 of the header: file-format write/read version. 1 =
 * legacy (rollback journal), 2 = WAL. Persisted at rest — a cleanly
 * checkpointed WAL database still carries 2/2 until `PRAGMA
 * journal_mode` is changed away from WAL. */
const HEADER_OFFSET_WRITE_VERSION = 18;
const HEADER_OFFSET_READ_VERSION = 19;
const FORMAT_VERSION_WAL = 2;
const FORMAT_VERSION_ROLLBACK = 1;

/**
 * Size of the SQLite write-ahead log header in bytes.
 *
 * A -wal file is a 32-byte header followed by frames of 24 + page_size
 * bytes each (page_size >= 512), so anything larger than the bare header
 * holds at least one (possibly torn) frame. Observed with sqlite3 3.51: a
 * database with uncheckpointed commits leaves a frame-bearing -wal (e.g.
 * 12392 bytes for 3 pages), `PRAGMA wal_checkpoint(TRUNCATE)` leaves a
 * 0-byte file, and macOS system SQLite keeps a persistent empty -wal
 * after a clean close. Sizes <= 32 therefore must NOT count as WAL data
 * or every cleanly checkpointed database on macOS would be forced
 * read-only. A fully backfilled but untruncated WAL keeps its size and
 * still trips gates built on this constant; that false positive degrades
 * to read-only (or a checkpoint-first rejection), the safe direction when
 * frame state cannot be inspected without a WAL-aware SQLite.
 */
export const WAL_HEADER_SIZE_BYTES = 32;

/**
 * Largest database the demo page still posts to the worker as inline
 * bytes. Bound by the demo worker-request transport guard: a Uint8Array
 * above MAX_WEBVIEW_BINARY_VALUE_BYTES is rejected at the RPC boundary,
 * so anything larger must travel as a File handle (structured-cloneable,
 * measured by the guard as an opaque object) and be read worker-side via
 * FileReaderSync.
 */
export const DEMO_INLINE_CONTENT_MAX_BYTES = MAX_WEBVIEW_BINARY_VALUE_BYTES;

/**
 * Above this size a database opens paged (read-only) when the runtime
 * supports it. Chosen from measured buffer-path behavior in the demo
 * (Chromium 146, macOS arm64, 24 GB): buffer opens peak at ~2.1x the
 * file size in renderer RSS — the FileReaderSync copy plus the copy
 * sql.js materializes for MEMFS — measured 2.92 GB peak for a 1.30 GiB
 * file and 3.72 GB for a 1.75 GiB file, with 0.6-0.8s open latency. A
 * 1 GiB file therefore already costs ~2.2 GB of transient RSS, hostile
 * on common 8 GB machines, while paged opens of the same files measure
 * ~51ms and ~260 MB peak RSS regardless of size (3.5 GiB fixture). The
 * hard failure point is the ~2 GiB reader cap (BUFFER_OPEN_CEILING_BYTES
 * below); 1 GiB keeps a 2x margin under it while capturing every file
 * for which buffer mode is measurably punishing.
 */
export const PAGED_OPEN_THRESHOLD_BYTES = 1024 * 1024 * 1024;

/**
 * Hard ceiling for the buffer path: Chromium's maximum ArrayBuffer, and
 * therefore the largest FileReaderSync.readAsArrayBuffer result. Bisected
 * empirically in Chromium 146 (macOS arm64): reads of up to exactly
 * 2,145,386,496 bytes (2 GiB - 2 MiB, the PartitionAlloc cap) succeed and
 * one byte more throws a misleading "could not be read, typically due to
 * permission problems" DOMException; `new ArrayBuffer(n)` fails at the
 * same bound. Files at or beyond it can never buffer-open here, so the
 * ladder rejects them with an actionable message instead. Other engines
 * cap elsewhere (Firefox allows larger buffers), but a file this size
 * would also cost ~4.3 GB of transient RSS to buffer — rejecting at the
 * Chromium bound is the safe uniform choice.
 */
export const BUFFER_OPEN_CEILING_BYTES = 2145386496;

/** Spec-fixed rejection for WAL-marked files too large to buffer. */
export const WAL_TOO_LARGE_MESSAGE =
  'WAL database too large for in-memory mode; checkpoint it first';

export interface DemoOpenLimits {
  pagedThresholdBytes?: number;
  bufferCeilingBytes?: number;
}

export interface DemoOpenInput {
  /** Total database file size in bytes. */
  sizeBytes: number;
  /** Header bytes 18/19 are both 2 (journal_mode=WAL at rest). */
  walMarked: boolean;
  /** The loaded sql.js runtime exposes Database.openPaged. */
  pagedAvailable: boolean;
}

export type DemoOpenPlan =
  | { mode: 'buffer'; readOnly: boolean }
  | { mode: 'paged' }
  | { mode: 'reject'; message: string };

/**
 * True when a SQLite header probe marks the database as journal_mode=WAL.
 * Short probes (file smaller than the 100-byte header) are never
 * WAL-marked: they are not valid databases and route to the buffer path,
 * which fails exactly as it does today.
 */
export function isWalMarkedHeader(header: Uint8Array): boolean {
  return header.length > HEADER_OFFSET_READ_VERSION
    && header[HEADER_OFFSET_WRITE_VERSION] === FORMAT_VERSION_WAL
    && header[HEADER_OFFSET_READ_VERSION] === FORMAT_VERSION_WAL;
}

/**
 * In-place: rewrite the file-format write/read version bytes (offsets
 * 18/19 of the database file) to 1 (rollback journal) wherever they fall
 * inside a read window that starts at absolute file offset
 * `viewFileOffset`. Used by paged (read-only snapshot) opens of
 * WAL-at-rest databases whose sibling `-wal` is known to hold no frames:
 * with no frames to merge, the main image already is the complete
 * committed state, and presenting it as a rollback-journal database is
 * the same byte-level rewrite `PRAGMA journal_mode=DELETE` would persist.
 * The patch is applied to read results only and never touches disk.
 */
export function patchWalHeaderToRollback(
  view: Uint8Array,
  viewFileOffset: number
): void {
  const writeIndex = HEADER_OFFSET_WRITE_VERSION - viewFileOffset;
  const readIndex = HEADER_OFFSET_READ_VERSION - viewFileOffset;
  if (writeIndex >= 0 && writeIndex < view.length) {
    view[writeIndex] = FORMAT_VERSION_ROLLBACK;
  }
  if (readIndex >= 0 && readIndex < view.length) {
    view[readIndex] = FORMAT_VERSION_ROLLBACK;
  }
}

function resolveLimit(
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

function formatGiB(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

/**
 * Decide how to open a database of the given size and header state.
 *
 * Callers that attempt a 'paged' plan and fail (open error) re-invoke
 * with `pagedAvailable: false` to obtain the fallback plan; the ladder
 * then either buffers (files under the ceiling behave exactly as today)
 * or rejects oversized files with a clear message.
 */
export function decideOpenPlan(
  input: DemoOpenInput,
  limits: DemoOpenLimits = {}
): DemoOpenPlan {
  const threshold = resolveLimit(
    limits.pagedThresholdBytes,
    PAGED_OPEN_THRESHOLD_BYTES,
    'Paged-open threshold'
  );
  const ceiling = resolveLimit(
    limits.bufferCeilingBytes,
    BUFFER_OPEN_CEILING_BYTES,
    'Buffer-open ceiling'
  );
  if (threshold > ceiling) {
    throw new Error('Paged-open threshold must not exceed the buffer-open ceiling');
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new Error('Database size must be a non-negative safe integer');
  }

  if (input.walMarked) {
    // (a) WAL-marked: never paged. Oversized WAL files cannot open at
    // all; in-range files above the threshold buffer-open read-only
    // (invisible -wal siblings may hold state this snapshot lacks).
    if (input.sizeBytes >= ceiling) {
      return { mode: 'reject', message: WAL_TOO_LARGE_MESSAGE };
    }
    return { mode: 'buffer', readOnly: input.sizeBytes > threshold };
  }
  if (input.sizeBytes > threshold && input.pagedAvailable) {
    // (b) Large and pageable.
    return { mode: 'paged' };
  }
  if (input.sizeBytes >= ceiling) {
    // Large, not pageable (capability absent or paged open failed), and
    // too big to buffer: reject instead of hanging or surfacing an
    // opaque reader error.
    return {
      mode: 'reject',
      message:
        `Database is too large to load into memory in this browser ` +
        `(${formatGiB(input.sizeBytes)}; limit ${formatGiB(ceiling)}) and ` +
        'page-on-demand mode is unavailable'
    };
  }
  // (c) Today's editable buffer path.
  return { mode: 'buffer', readOnly: false };
}
