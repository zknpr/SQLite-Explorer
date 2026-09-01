import path from 'path';
import { crypto } from './platform/cryptoShim';
import type { DatabaseWriteResult } from './core/types';
import {
  MAX_PAGED_OVERLAY_RUN_BYTES,
  type PagedFileIdentity,
  type PagedWritableOverlaySnapshot
} from './core/paged-writable-overlay';
import { WAL_HEADER_SIZE_BYTES } from './core/paged-open';
import {
  ordinaryPermissionMode,
  replacementFileMetadataFromStats,
  restoreTemporaryMetadata,
  type OwnershipPreservationFailure,
  type ReplacementFileMetadata
} from './fileReplacementMetadata';

type NodeFs = typeof import('fs');
type NodeFileHandle = Awaited<ReturnType<NodeFs['promises']['open']>>;
type PagedSaveLogger = (level: 'warn', message: string, error?: unknown) => void;

export interface PagedSaveWriteLock {
  /** Close the SQLite database handle before replacing its pathname. */
  releaseBeforeRename?: boolean;
  release(): void;
}

export type PagedSaveWriteLockAcquirer = (databasePath: string) => PagedSaveWriteLock;

/** One reusable host buffer bounds every copy from the frozen base. */
const BASE_COPY_BUFFER_BYTES = 1024 * 1024;
const PAGED_FILE_CHANGED_MESSAGE = 'Database file changed on disk; reload the document.';

interface ExistingTarget {
  exists: true;
  fingerprint: HostFileFingerprint;
}

interface MissingTarget {
  exists: false;
}

type TargetGeneration = ExistingTarget | MissingTarget;

interface ReplacementTarget extends ReplacementFileMetadata {
  replacementPath: string;
  requiresReopen: boolean;
  /** Existing ordinary SQLite targets need SQLite's writer lock before replacement. */
  requiresTargetWriteLock: boolean;
  generation: TargetGeneration;
}

/** Host-only identity for paths participating in the atomic replacement. */
interface HostFileFingerprint {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function identityFromStats(stats: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  mode: bigint;
}): PagedFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    mode: stats.mode
  };
}

function fingerprintFromStats(stats: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
}): HostFileFingerprint {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid
  };
}

async function handleIdentity(handle: NodeFileHandle): Promise<PagedFileIdentity> {
  return identityFromStats(await handle.stat({ bigint: true }));
}

async function pathIdentity(fs: NodeFs, filePath: string): Promise<PagedFileIdentity> {
  return identityFromStats(await fs.promises.stat(filePath, { bigint: true }));
}

async function pathFingerprint(fs: NodeFs, filePath: string): Promise<HostFileFingerprint> {
  return fingerprintFromStats(await fs.promises.stat(filePath, { bigint: true }));
}

function sameBaseGeneration(expected: PagedFileIdentity, actual: PagedFileIdentity): boolean {
  // Permission changes do not change the frozen SQLite generation. `mode` is
  // carried only so the replacement can restore the intended permissions.
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeNs === actual.mtimeNs;
}

function sameHostFingerprint(
  expected: HostFileFingerprint,
  actual: HostFileFingerprint
): boolean {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeNs === actual.mtimeNs
    && expected.ctimeNs === actual.ctimeNs
    && expected.mode === actual.mode
    && expected.uid === actual.uid
    && expected.gid === actual.gid;
}

function sameInode(expected: PagedFileIdentity, actual: PagedFileIdentity): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}

const SQLITE_DATABASE_HEADER = new Uint8Array([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
  0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00
]);

/** Distinguish SQLite targets from arbitrary files that Save As may overwrite. */
async function hasSqliteDatabaseHeader(fs: NodeFs, filePath: string): Promise<boolean> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const header = new Uint8Array(SQLITE_DATABASE_HEADER.byteLength);
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    if (bytesRead !== header.byteLength) return false;
    return header.every((byte, index) => byte === SQLITE_DATABASE_HEADER[index]);
  } finally {
    await handle.close();
  }
}

function assertNonNegativeSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `Malformed paged writable snapshot: ${name} must be a non-negative safe integer`
    );
  }
}

function validateBaseIdentity(identity: unknown): asserts identity is PagedFileIdentity {
  if (typeof identity !== 'object' || identity === null) {
    throw new Error('Malformed paged writable snapshot: baseIdentity must be an object');
  }
  const candidate = identity as Partial<PagedFileIdentity>;
  for (const name of ['dev', 'ino', 'size', 'mtimeNs', 'mode'] as const) {
    if (typeof candidate[name] !== 'bigint') {
      throw new Error(
        `Malformed paged writable snapshot: baseIdentity.${name} must be a bigint`
      );
    }
  }
  if (candidate.dev! < 0n || candidate.ino! < 0n || candidate.size! < 0n || candidate.mode! < 0n) {
    throw new Error(
      'Malformed paged writable snapshot: baseIdentity fields except mtimeNs must be non-negative'
    );
  }
}

/** Revalidate worker-provided data before opening a temp or touching a target. */
function validateSnapshot(snapshot: unknown): asserts snapshot is PagedWritableOverlaySnapshot {
  if (typeof snapshot !== 'object' || snapshot === null) {
    throw new Error('Malformed paged writable snapshot: expected an object');
  }
  const candidate = snapshot as Partial<PagedWritableOverlaySnapshot>;
  assertNonNegativeSafeInteger(candidate.chunkSize, 'chunkSize');
  if (candidate.chunkSize === 0) {
    throw new Error(
      'Malformed paged writable snapshot: chunkSize must be a positive safe integer'
    );
  }
  assertNonNegativeSafeInteger(candidate.logicalSize, 'logicalSize');
  assertNonNegativeSafeInteger(candidate.baseLimit, 'baseLimit');
  assertNonNegativeSafeInteger(candidate.dirtyBytes, 'dirtyBytes');
  validateBaseIdentity(candidate.baseIdentity);
  if (BigInt(candidate.baseLimit) > candidate.baseIdentity.size) {
    throw new Error(
      'Malformed paged writable snapshot: baseLimit exceeds the original base size'
    );
  }
  if (!Array.isArray(candidate.runs)) {
    throw new Error('Malformed paged writable snapshot: runs must be an array');
  }

  let previousEnd = 0;
  let computedDirtyBytes = 0;
  for (const [position, run] of candidate.runs.entries()) {
    if (typeof run !== 'object' || run === null) {
      throw new Error(`Malformed paged writable snapshot: runs[${position}] must be an object`);
    }
    assertNonNegativeSafeInteger(run.startChunkIndex, `runs[${position}] start`);
    if (!(run.data instanceof ArrayBuffer)) {
      throw new Error(
        `Malformed paged writable snapshot: runs[${position}].data must be an ArrayBuffer`
      );
    }
    const runLength = run.data.byteLength;
    if (runLength === 0) {
      throw new Error(
        `Malformed paged writable snapshot: run ${position} byteLength must be positive`
      );
    }
    if (runLength % candidate.chunkSize !== 0) {
      throw new Error(
        `Malformed paged writable snapshot: run ${position} byteLength must be an exact multiple of chunkSize`
      );
    }
    if (runLength > MAX_PAGED_OVERLAY_RUN_BYTES) {
      throw new Error(
        `Malformed paged writable snapshot: run ${position} exceeds the 8 MiB cap`
      );
    }
    const runStart = run.startChunkIndex * candidate.chunkSize;
    if (!Number.isSafeInteger(runStart)) {
      throw new Error(
        `Malformed paged writable snapshot: run ${position} start exceeds safe integer range`
      );
    }
    if (runStart > Number.MAX_SAFE_INTEGER - runLength) {
      throw new Error(
        `Malformed paged writable snapshot: run ${position} end exceeds safe integer range`
      );
    }
    const runEnd = runStart + runLength;
    if (position > 0 && runStart < previousEnd) {
      throw new Error(
        'Malformed paged writable snapshot: runs must be sorted and non-overlapping'
      );
    }
    previousEnd = runEnd;
    computedDirtyBytes += runLength;
    if (!Number.isSafeInteger(computedDirtyBytes)) {
      throw new Error(
        'Malformed paged writable snapshot: summed dirty bytes exceed safe integer range'
      );
    }
  }
  if (computedDirtyBytes !== candidate.dirtyBytes) {
    throw new Error(
      'Malformed paged writable snapshot: dirtyBytes must equal the sum of run byte lengths'
    );
  }
}

interface AllocationInterval {
  start: bigint;
  end: bigint;
}

function alignAllocationInterval(
  start: bigint,
  end: bigint,
  blockSize: bigint
): AllocationInterval | undefined {
  if (end <= start) return undefined;
  return {
    start: (start / blockSize) * blockSize,
    end: ((end + blockSize - 1n) / blockSize) * blockSize
  };
}

/**
 * The base prefix is written densely even when its source was sparse. Above
 * baseLimit, only dirty runs allocate blocks; untouched growth remains holes.
 */
function estimateTemporaryAllocationBytes(
  snapshot: PagedWritableOverlaySnapshot,
  blockSize: bigint
): bigint {
  if (blockSize <= 0n) throw new Error('Filesystem reported an invalid allocation block size');
  const logicalSize = BigInt(snapshot.logicalSize);
  const baseLimit = BigInt(Math.min(snapshot.logicalSize, snapshot.baseLimit));
  const intervals: AllocationInterval[] = [];
  const base = alignAllocationInterval(0n, baseLimit, blockSize);
  if (base) intervals.push(base);

  for (const run of snapshot.runs) {
    const start = BigInt(run.startChunkIndex) * BigInt(snapshot.chunkSize);
    const end = start + BigInt(run.data.byteLength);
    const dirty = alignAllocationInterval(
      start > baseLimit ? start : baseLimit,
      end < logicalSize ? end : logicalSize,
      blockSize
    );
    if (dirty) intervals.push(dirty);
  }

  intervals.sort((left, right) => left.start < right.start ? -1 : left.start > right.start ? 1 : 0);
  let allocated = 0n;
  let current: AllocationInterval | undefined;
  for (const interval of intervals) {
    if (!current) {
      current = { ...interval };
    } else if (interval.start <= current.end) {
      if (interval.end > current.end) current.end = interval.end;
    } else {
      allocated += current.end - current.start;
      current = { ...interval };
    }
  }
  if (current) allocated += current.end - current.start;
  return allocated;
}

async function assertAdjacentTemporarySpace(
  fs: NodeFs,
  replacementPath: string,
  snapshot: PagedWritableOverlaySnapshot
): Promise<void> {
  const directory = path.dirname(replacementPath);
  let stats: Awaited<ReturnType<NodeFs['promises']['statfs']>>;
  try {
    stats = await fs.promises.statfs(directory, { bigint: true });
  } catch (error) {
    throw new Error(
      `Cannot verify free space for the atomic paged save in '${directory}'.`,
      { cause: error }
    );
  }
  const blockSize = BigInt(stats.bsize);
  const availableBlocks = BigInt(stats.bavail);
  if (blockSize <= 0n || availableBlocks < 0n) {
    throw new Error(`Filesystem reported invalid free-space metadata for '${directory}'.`);
  }
  const requiredBytes = estimateTemporaryAllocationBytes(snapshot, blockSize);
  const availableBytes = blockSize * availableBlocks;
  if (requiredBytes > availableBytes) {
    throw new Error(
      `Atomic paged save needs approximately ${requiredBytes} bytes of adjacent temporary `
      + `space, but only ${availableBytes} bytes are available in '${directory}'.`
    );
  }
}

async function assertBaseGeneration(
  fs: NodeFs,
  source: NodeFileHandle,
  activeBasePath: string,
  expected: PagedFileIdentity
): Promise<void> {
  let descriptor: PagedFileIdentity;
  let activePath: PagedFileIdentity;
  try {
    [descriptor, activePath] = await Promise.all([
      handleIdentity(source),
      pathIdentity(fs, activeBasePath)
    ]);
  } catch (error) {
    throw new Error(PAGED_FILE_CHANGED_MESSAGE, { cause: error });
  }
  if (!sameBaseGeneration(expected, descriptor) || !sameBaseGeneration(expected, activePath)) {
    throw new Error(PAGED_FILE_CHANGED_MESSAGE);
  }
}

async function resolveReplacementTarget(
  fs: NodeFs,
  activeBasePath: string,
  targetPath: string,
  baseIdentity: PagedFileIdentity
): Promise<ReplacementTarget> {
  const absoluteTargetPath = path.resolve(targetPath);
  let canonicalTargetPath: string;
  let targetFingerprint: HostFileFingerprint;
  try {
    canonicalTargetPath = await fs.promises.realpath(absoluteTargetPath);
    targetFingerprint = await pathFingerprint(fs, canonicalTargetPath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;

    // A dangling symlink is not a new path: following it could write outside
    // the directory where the private temp was created. Refuse that ambiguity.
    try {
      await fs.promises.lstat(absoluteTargetPath);
      throw new Error(`Cannot save through dangling symlink '${targetPath}'`);
    } catch (lstatError) {
      if (errorCode(lstatError) !== 'ENOENT') throw lstatError;
    }

    const canonicalParent = await fs.promises.realpath(path.dirname(absoluteTargetPath));
    return {
      replacementPath: path.join(canonicalParent, path.basename(absoluteTargetPath)),
      requiresReopen: false,
      requiresTargetWriteLock: false,
      mode: ordinaryPermissionMode(baseIdentity.mode),
      generation: { exists: false }
    };
  }

  const targetNamesActiveBase = canonicalTargetPath === activeBasePath;

  // A distinct hard link deliberately keeps its own pathname: replacing that
  // directory entry leaves the descriptor-backed active base frozen.
  const requiresReopen = targetNamesActiveBase;
  const replacementPath = targetNamesActiveBase
    ? activeBasePath
    : canonicalTargetPath;
  return {
    replacementPath,
    requiresReopen,
    requiresTargetWriteLock:
      !targetNamesActiveBase && await hasSqliteDatabaseHeader(fs, canonicalTargetPath),
    // Existing permissions are live host metadata, not part of the frozen
    // SQLite byte generation. Preserve what is present when this save starts
    // (including a chmod performed after open) and verify it again at commit.
    ...replacementFileMetadataFromStats(targetFingerprint),
    generation: { exists: true, fingerprint: targetFingerprint }
  };
}

function assertTargetGenerationSync(
  fs: NodeFs,
  target: ReplacementTarget
): void {
  if (target.generation.exists) {
    let current: HostFileFingerprint;
    try {
      current = fingerprintFromStats(fs.statSync(target.replacementPath, { bigint: true }));
    } catch (error) {
      throw new Error('Save target changed on disk; retry the save.', { cause: error });
    }
    if (!sameHostFingerprint(target.generation.fingerprint, current)) {
      throw new Error('Save target changed on disk; retry the save.');
    }
    return;
  }

  try {
    fs.lstatSync(target.replacementPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw new Error('Cannot verify the Save As target before replacement.', { cause: error });
  }
  throw new Error('Save target appeared on disk during save; retry the save.');
}

function assertTemporaryGenerationSync(
  fs: NodeFs,
  temporaryPath: string,
  expected: HostFileFingerprint
): void {
  let current: HostFileFingerprint;
  try {
    current = fingerprintFromStats(fs.lstatSync(temporaryPath, { bigint: true }));
  } catch (error) {
    throw new Error('Temporary database changed before rename.', { cause: error });
  }
  if (!sameHostFingerprint(expected, current)) {
    throw new Error('Temporary database changed before rename.');
  }
}

/**
 * The paged-open path already rejects a frame-bearing sibling WAL before and
 * after opening the frozen base. Recheck at the commit boundary as well: WAL
 * frames live outside the main file, so a late external commit must block the
 * rename even when the main-file metadata gate cannot observe it.
 */
function assertNoSiblingWalFramesSync(
  fs: NodeFs,
  databasePath: string,
  targetKind: 'active' | 'saveAsTarget' = 'active'
): void {
  const walPath = `${databasePath}-wal`;
  let walSize: bigint;
  try {
    walSize = fs.statSync(walPath, { bigint: true }).size;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    const message = targetKind === 'saveAsTarget'
      ? 'Cannot verify the Save As target WAL state before replacing it; retry the save.'
      : 'Cannot verify sibling WAL state before replacing the database; reload the document.';
    throw new Error(message, { cause: error });
  }
  if (walSize > BigInt(WAL_HEADER_SIZE_BYTES)) {
    if (targetKind === 'saveAsTarget') {
      throw new Error(
        'The Save As target has a WAL with uncheckpointed frames. Close other connections or '
        + 'checkpoint the target database before retrying; its WAL and SHM files remain under '
        + "SQLite's control."
      );
    }
    throw new Error(
      'A sibling WAL acquired uncheckpointed frames during save; reload the document before retrying.'
    );
  }
}

/**
 * Hold SQLite's own exclusive lock through the final identity/WAL gate and, where
 * the platform permits renaming an open database, through the rename itself.
 *
 * Synchronous host code only excludes another extension-host task. A different
 * process can still switch a rollback database to WAL and commit after the last
 * stat unless SQLite itself excludes every connection. In particular, a clean
 * WAL has no frames to detect, but each attached WAL peer retains a shared lock
 * on the main file. EXCLUSIVE locking mode plus BEGIN EXCLUSIVE must displace
 * that lock, so replacement fails closed while any WAL peer can retain the old
 * inode and later write through the shared WAL pathname.
 */
export function acquireSqliteWriteLock(databasePath: string): PagedSaveWriteLock {
  let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite'));
  } catch (error) {
    throw new Error(
      'Cannot safely replace the page-on-demand database because this extension host '
      + 'does not provide SQLite write locking. Choose a new Save As target that does not '
      + 'already contain a SQLite database.',
      { cause: error }
    );
  }

  let database: import('node:sqlite').DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath);
    // Do not busy-wait on the extension-host thread. Any connection that keeps
    // SQLite's main-file lock makes this save fail immediately and leaves both
    // its transaction and our paged overlay intact for an explicit retry.
    database.exec(
      'PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE'
    );
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the lock-acquisition error; a failed constructor/BEGIN owns no
      // successful save that a secondary close error could usefully describe.
    }
    throw new Error(
      'Cannot acquire the exclusive SQLite lock required for an atomic database save; '
      + 'close other connections and retry.',
      { cause: error }
    );
  }

  let released = false;
  return {
    // SQLite's Windows VFS does not share delete/rename access for the main
    // database handle. POSIX can retain the exclusive lock-through-rename window.
    releaseBeforeRename: process.platform === 'win32',
    release(): void {
      if (released) return;
      released = true;
      let rollbackError: unknown;
      try {
        database!.exec('ROLLBACK');
      } catch (error) {
        rollbackError = error;
      }
      try {
        database!.close();
      } catch (error) {
        if (rollbackError === undefined) throw error;
      }
      if (rollbackError !== undefined) throw rollbackError;
    }
  };
}

/**
 * Final replacement gates. The caller normally holds BEGIN IMMEDIATE for
 * in-place saves, excluding cross-process writers while these checks run.
 */
function assertReplacementReadySync(
  fs: NodeFs,
  sourceFd: number,
  activeBasePath: string,
  expectedBase: PagedFileIdentity,
  temporaryPath: string,
  expectedTemporary: HostFileFingerprint,
  target: ReplacementTarget
): void {
  assertTemporaryGenerationSync(fs, temporaryPath, expectedTemporary);
  assertTargetGenerationSync(fs, target);

  let descriptor: PagedFileIdentity;
  let activePath: PagedFileIdentity;
  try {
    descriptor = identityFromStats(fs.fstatSync(sourceFd, { bigint: true }));
    activePath = identityFromStats(fs.statSync(activeBasePath, { bigint: true }));
  } catch (error) {
    throw new Error(PAGED_FILE_CHANGED_MESSAGE, { cause: error });
  }
  if (
    !sameBaseGeneration(expectedBase, descriptor)
    || !sameBaseGeneration(expectedBase, activePath)
  ) {
    throw new Error(PAGED_FILE_CHANGED_MESSAGE);
  }
  assertNoSiblingWalFramesSync(fs, activeBasePath);
  if (target.requiresTargetWriteLock) {
    // A hot WAL belongs to the target's old main file. Never rename a fresh main
    // beside those frames, and never delete WAL/SHM files that another SQLite
    // connection may still own.
    assertNoSiblingWalFramesSync(fs, target.replacementPath, 'saveAsTarget');
  }
}

async function writeAll(
  handle: NodeFileHandle,
  data: Uint8Array,
  position: number,
  signal?: AbortSignal
): Promise<void> {
  let written = 0;
  while (written < data.byteLength) {
    signal?.throwIfAborted();
    const writeLength = Math.min(BASE_COPY_BUFFER_BYTES, data.byteLength - written);
    const result = await handle.write(
      data,
      written,
      writeLength,
      position + written
    );
    signal?.throwIfAborted();
    if (result.bytesWritten <= 0) {
      throw new Error('Temporary database write made no progress');
    }
    written += result.bytesWritten;
  }
}

async function copyBaseGap(
  source: NodeFileHandle,
  temporary: NodeFileHandle,
  buffer: Uint8Array,
  start: number,
  end: number,
  baseLimit: number,
  signal?: AbortSignal
): Promise<void> {
  const copyEnd = Math.min(end, baseLimit);
  let position = start;
  while (position < copyEnd) {
    signal?.throwIfAborted();
    const requested = Math.min(buffer.byteLength, copyEnd - position);
    let filled = 0;
    while (filled < requested) {
      signal?.throwIfAborted();
      const result = await source.read(
        buffer,
        filled,
        requested - filled,
        position + filled
      );
      signal?.throwIfAborted();
      if (result.bytesRead <= 0) {
        throw new Error(
          `Short read from frozen base below baseLimit at byte ${position + filled}`
        );
      }
      filled += result.bytesRead;
    }
    await writeAll(temporary, buffer.subarray(0, requested), position, signal);
    position += requested;
  }
  // [copyEnd, end) is outside baseLimit. Leaving it unwritten creates a
  // sparse zero-filled hole; the final truncate establishes trailing holes.
}

async function assembleSnapshot(
  source: NodeFileHandle,
  temporary: NodeFileHandle,
  snapshot: PagedWritableOverlaySnapshot,
  signal?: AbortSignal
): Promise<void> {
  const baseBuffer = new Uint8Array(BASE_COPY_BUFFER_BYTES);
  let outputPosition = 0;
  for (const run of snapshot.runs) {
    signal?.throwIfAborted();
    const runStart = run.startChunkIndex * snapshot.chunkSize;
    if (runStart >= snapshot.logicalSize) break;
    await copyBaseGap(
      source,
      temporary,
      baseBuffer,
      outputPosition,
      Math.min(runStart, snapshot.logicalSize),
      snapshot.baseLimit,
      signal
    );
    const runBytes = new Uint8Array(run.data);
    const writtenLength = Math.min(runBytes.byteLength, snapshot.logicalSize - runStart);
    await writeAll(temporary, runBytes.subarray(0, writtenLength), runStart, signal);
    outputPosition = runStart + writtenLength;
  }
  await copyBaseGap(
    source,
    temporary,
    baseBuffer,
    outputPosition,
    snapshot.logicalSize,
    snapshot.baseLimit,
    signal
  );
  signal?.throwIfAborted();
  await temporary.truncate(snapshot.logicalSize);
  signal?.throwIfAborted();
}

function warnAfterSuccessfulRename(
  logger: PagedSaveLogger | undefined,
  message: string,
  error: unknown
): void {
  try {
    if (logger) logger('warn', message, error);
    else console.warn(`[SQLite Explorer] ${message}`, error);
  } catch {
    // A logging sink must not turn an already-renamed save into a false failure.
  }
}

/**
 * Stream a worker-transferred dirty overlay over its frozen local base.
 *
 * The function never allocates a merged database image: overlay buffers are
 * written directly and every base gap uses one 1 MiB reusable buffer.
 */
export async function writePagedWritableOverlayToFile(
  fs: NodeFs,
  basePath: string,
  targetPath: string,
  snapshot: PagedWritableOverlaySnapshot,
  logger?: PagedSaveLogger,
  acquireWriteLock: PagedSaveWriteLockAcquirer = acquireSqliteWriteLock,
  signal?: AbortSignal
): Promise<DatabaseWriteResult> {
  signal?.throwIfAborted();
  validateSnapshot(snapshot);

  let source: NodeFileHandle | undefined;
  let temporary: NodeFileHandle | undefined;
  let replacementDirectory: NodeFileHandle | undefined;
  let replacementDirectoryOpenError: unknown;
  let temporaryPath: string | undefined;
  let completedTemporaryFingerprint: HostFileFingerprint | undefined;
  let ownershipPreservationFailure: OwnershipPreservationFailure | undefined;
  let temporaryCreated = false;
  let renamed = false;
  try {
    source = await fs.promises.open(basePath, 'r');
    signal?.throwIfAborted();
    const activeBasePath = await fs.promises.realpath(basePath);
    signal?.throwIfAborted();
    await assertBaseGeneration(fs, source, activeBasePath, snapshot.baseIdentity);
    signal?.throwIfAborted();

    const target = await resolveReplacementTarget(
      fs,
      activeBasePath,
      targetPath,
      snapshot.baseIdentity
    );
    signal?.throwIfAborted();
    await assertAdjacentTemporarySpace(fs, target.replacementPath, snapshot);
    signal?.throwIfAborted();
    try {
      // Open before assembly so the post-rename durability step needs no path
      // lookup in the commit window. Some platforms cannot open directories;
      // that becomes a post-rename durability warning, not a false save failure.
      replacementDirectory = await fs.promises.open(
        path.dirname(target.replacementPath),
        'r'
      );
    } catch (error) {
      replacementDirectoryOpenError = error;
    }
    signal?.throwIfAborted();
    temporaryPath = path.join(
      path.dirname(target.replacementPath),
      `.${path.basename(target.replacementPath)}.sqlite-explorer-${crypto.randomUUID()}.tmp`
    );
    temporary = await fs.promises.open(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    signal?.throwIfAborted();

    await assembleSnapshot(source, temporary, snapshot, signal);
    ownershipPreservationFailure = await restoreTemporaryMetadata(temporary, target);
    signal?.throwIfAborted();
    await temporary.sync();
    signal?.throwIfAborted();
    completedTemporaryFingerprint = fingerprintFromStats(
      fs.fstatSync(temporary.fd, { bigint: true })
    );
    await temporary.close();
    temporary = undefined;
    // This is the last cooperative cancellation point. Once rename commits,
    // durability cleanup and any required reconnect must run to completion.
    signal?.throwIfAborted();

    let writeLock: PagedSaveWriteLock | undefined;
    let replacementError: unknown;
    try {
      // Existing SQLite targets need the same writer exclusion as an in-place
      // replacement. A new Save As target remains on the lock-free fast path.
      if (target.requiresReopen) {
        // Keep the specific hot-WAL error while retaining the locked recheck in
        // assertReplacementReadySync as the authoritative commit gate.
        assertNoSiblingWalFramesSync(fs, activeBasePath);
        writeLock = acquireWriteLock(activeBasePath);
      } else if (target.requiresTargetWriteLock) {
        assertNoSiblingWalFramesSync(fs, target.replacementPath, 'saveAsTarget');
        writeLock = acquireWriteLock(target.replacementPath);
      }
      assertReplacementReadySync(
        fs,
        source.fd,
        activeBasePath,
        snapshot.baseIdentity,
        temporaryPath,
        completedTemporaryFingerprint,
        target
      );

      if (writeLock?.releaseBeforeRename) {
        // Windows cannot rename over SQLite's open main-database handle. Close
        // it only after a locked gate, then repeat every identity/WAL gate
        // synchronously immediately before rename. A different process can
        // still commit in the residual post-check/pre-rename window; unlike
        // POSIX, Windows cannot retain BEGIN IMMEDIATE across the swap.
        const lockToRelease = writeLock;
        writeLock = undefined;
        lockToRelease.release();
        assertReplacementReadySync(
          fs,
          source.fd,
          activeBasePath,
          snapshot.baseIdentity,
          temporaryPath,
          completedTemporaryFingerprint,
          target
        );
      }

      fs.renameSync(temporaryPath, target.replacementPath);
      renamed = true;
    } catch (error) {
      replacementError = error;
      throw error;
    } finally {
      if (writeLock) {
        try {
          writeLock.release();
        } catch (error) {
          if (renamed) {
            warnAfterSuccessfulRename(
              logger,
              'Paged save replaced the database, but releasing its SQLite write lock failed:',
              error
            );
          } else if (replacementError !== undefined) {
            try {
              logger?.(
                'warn',
                'Paged save failed and its SQLite write lock reported a release error:',
                error
              );
            } catch {
              // Never mask the replacement failure with a diagnostic sink.
            }
          } else {
            throw error;
          }
        }
      }
    }

    if (ownershipPreservationFailure) {
      const { uid, gid, error } = ownershipPreservationFailure;
      warnAfterSuccessfulRename(
        logger,
        'Paged save replaced the database, but could not restore its previous '
        + `owner/group (uid ${uid}, gid ${gid}). The save remains valid because the user `
        + 'had write access and the replacement is still governed by the parent directory '
        + 'permissions and ACLs; access based only on the previous owner/group may change:',
        error
      );
    }

    if (replacementDirectory) {
      try {
        await replacementDirectory.sync();
      } catch (syncError) {
        warnAfterSuccessfulRename(
          logger,
          'Paged save replaced the database, but parent-directory durability could not be confirmed:',
          syncError
        );
      }
      try {
        await replacementDirectory.close();
      } catch (closeError) {
        warnAfterSuccessfulRename(
          logger,
          'Paged save replaced the database, but the parent-directory descriptor could not be closed:',
          closeError
        );
      }
      replacementDirectory = undefined;
    } else if (replacementDirectoryOpenError !== undefined) {
      warnAfterSuccessfulRename(
        logger,
        'Paged save replaced the database, but parent-directory durability is unsupported or unavailable:',
        replacementDirectoryOpenError
      );
    }

    try {
      await source.close();
    } catch (closeError) {
      warnAfterSuccessfulRename(
        logger,
        'Paged save succeeded, but the frozen source descriptor could not be closed:',
        closeError
      );
    }
    source = undefined;
    return { requiresReopen: target.requiresReopen };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (replacementDirectory) {
      try {
        await replacementDirectory.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
      replacementDirectory = undefined;
    }
    if (temporary) {
      try {
        await temporary.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
      temporary = undefined;
    }
    if (source) {
      try {
        await source.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
      source = undefined;
    }
    if (temporaryCreated && !renamed && temporaryPath) {
      try {
        await fs.promises.unlink(temporaryPath);
      } catch (unlinkError) {
        if (errorCode(unlinkError) !== 'ENOENT') cleanupErrors.push(unlinkError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Failed to save paged database '${targetPath}', and cleanup also failed`
      );
    }
    if (signal?.aborted && error === signal.reason) throw error;
    throw new Error(
      `Failed to save paged database '${targetPath}': ${describeError(error)}`,
      { cause: error }
    );
  }
}
