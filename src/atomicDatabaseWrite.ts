import path from 'path';

import type { DatabaseWriteResult } from './core/types';
import { crypto } from './platform/cryptoShim';
import {
  replacementFileMetadataFromStats,
  restoreTemporaryMetadata,
  type OwnershipPreservationFailure,
  type ReplacementFileMetadata
} from './fileReplacementMetadata';
import {
  acquireSqliteWriteLock,
  type PagedSaveWriteLock
} from './pagedWritableSave';

type NodeFs = typeof import('node:fs');
type NodeFileHandle = Awaited<ReturnType<NodeFs['promises']['open']>>;
type CancellationCheck = Pick<AbortSignal, 'throwIfAborted'>;

export type AtomicDatabaseWriteLogger = (
  level: 'warn',
  message: string,
  error?: unknown
) => void;

interface FileFingerprint {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
}

/** The local file whose bytes back an in-memory WASM connection. */
export interface DatabaseFileGeneration {
  readonly sourcePath: string;
  readonly canonicalPath: string;
  /** Undefined after a committed save whose new generation could not be verified. */
  fingerprint: FileFingerprint | undefined;
  /** Hash of the opened or committed bytes, never of the unsaved memory image. */
  contentSha256?: string;
}

interface ExistingGeneration {
  exists: true;
  fingerprint: FileFingerprint;
}

interface MissingGeneration {
  exists: false;
}

interface ResolvedTarget {
  replacementPath: string;
  requiresReopen: boolean;
  requiresWriteLock: boolean;
  metadata?: ReplacementFileMetadata;
  generation: ExistingGeneration | MissingGeneration;
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary');
const WAL_HEADER_BYTES = 32n;

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

function fingerprint(stats: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
}): FileFingerprint {
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

function sameFingerprint(left: FileFingerprint, right: FileFingerprint, compareChangeTime = true): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && (!compareChangeTime || left.ctimeNs === right.ctimeNs)
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
}

function sourceChangedError(cause?: unknown): Error {
  return new Error(
    'The database file changed on disk since it was opened or last saved. '
    + 'Your unsaved changes remain available. Use Save As to recover them to a different file, '
    + 'or Reload Database to open the current file.',
    { cause }
  );
}

function contentHash(): import('node:crypto').Hash {
  if (import.meta.env?.VSCODE_BROWSER_EXT) {
    throw new Error('Local database file verification requires VS Code Desktop');
  }
  return (require('crypto') as typeof import('node:crypto')).createHash('sha256');
}

function hashFileDescriptor(fs: NodeFs, descriptor: number, expected: FileFingerprint): string {
  if (!sameFingerprint(expected, fingerprint(fs.fstatSync(descriptor, { bigint: true })))) {
    throw sourceChangedError();
  }
  const hash = contentHash();
  const chunk = Buffer.alloc(1024 * 1024);
  let remaining = expected.size;
  while (remaining > 0n) {
    const length = Number(remaining < BigInt(chunk.length) ? remaining : BigInt(chunk.length));
    const count = fs.readSync(descriptor, chunk, 0, length, null);
    if (count === 0) throw sourceChangedError();
    hash.update(chunk.subarray(0, count));
    remaining -= BigInt(count);
  }
  if (!sameFingerprint(expected, fingerprint(fs.fstatSync(descriptor, { bigint: true })))) {
    throw sourceChangedError();
  }
  return hash.digest('hex');
}

/** Pin the descriptor's generation, then verify its original pathname still names it. */
export function captureDatabaseFileGeneration(
  fs: NodeFs,
  sourcePath: string,
  stats: FileFingerprint,
  content: Uint8Array
): DatabaseFileGeneration {
  const generation: DatabaseFileGeneration = {
    sourcePath: path.resolve(sourcePath),
    // Match promises.realpath in destination resolution. On Windows the JS
    // resolver can retain drive-letter casing that the native resolver changes.
    canonicalPath: fs.realpathSync.native(sourcePath),
    fingerprint: fingerprint(stats)
  };
  // No hash fallback during open: the descriptor's pre-read fingerprint must
  // still match before the bytes can establish a trusted content baseline.
  assertDatabaseFileGenerationCurrent(fs, generation);
  generation.contentSha256 = contentHash().update(content).digest('hex');
  return generation;
}

/** Synchronous so the last check and rename share the same commit turn. */
export function assertDatabaseFileGenerationCurrent(fs: NodeFs, generation: DatabaseFileGeneration): void {
  if (!generation.fingerprint) throw sourceChangedError();
  try {
    const canonicalPath = fs.realpathSync.native(generation.sourcePath);
    const current = fingerprint(fs.statSync(canonicalPath, { bigint: true }));
    if (canonicalPath !== generation.canonicalPath) throw sourceChangedError();
    if (sameFingerprint(generation.fingerprint, current)) return;
    // Windows file dialogs can change ctime without changing the database.
    // Accept only a ctime-only difference whose bytes still match our baseline;
    // same-size edits with a restored mtime must continue to fail closed.
    if (!generation.contentSha256 || !sameFingerprint(generation.fingerprint, current, false)) {
      throw sourceChangedError();
    }
    const descriptor = fs.openSync(canonicalPath, 'r');
    try {
      if (hashFileDescriptor(fs, descriptor, current) !== generation.contentSha256
        || fs.realpathSync.native(generation.sourcePath) !== canonicalPath
        || !sameFingerprint(current, fingerprint(fs.statSync(canonicalPath, { bigint: true })))) {
        throw sourceChangedError();
      }
      generation.fingerprint = current;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    throw sourceChangedError(error);
  }
}

async function hasSqliteHeader(fs: NodeFs, filePath: string): Promise<boolean> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const bytes = Buffer.alloc(SQLITE_HEADER.byteLength);
    const result = await handle.read(bytes, 0, bytes.byteLength, 0);
    return result.bytesRead === SQLITE_HEADER.byteLength && bytes.equals(SQLITE_HEADER);
  } finally {
    await handle.close();
  }
}

async function resolveTarget(
  fs: NodeFs,
  sourcePath: string | undefined,
  targetPath: string
): Promise<ResolvedTarget> {
  const absoluteTarget = path.resolve(targetPath);

  const requiresReopen = async (replacementPath: string): Promise<boolean> => {
    if (!sourcePath) return false;
    const absoluteSource = path.resolve(sourcePath);
    if (absoluteSource === absoluteTarget) return true;
    try {
      return await fs.promises.realpath(absoluteSource) === replacementPath;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }

    // An unlinked native source can remain usable through SQLite's open file
    // descriptor. Resolve its surviving parent only for same-path detection;
    // a missing source must not block recovery to an unrelated Save As target.
    try {
      const canonicalParent = await fs.promises.realpath(path.dirname(absoluteSource));
      return path.join(canonicalParent, path.basename(absoluteSource)) === replacementPath;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  };

  try {
    const replacementPath = await fs.promises.realpath(absoluteTarget);
    const stats = await fs.promises.stat(replacementPath, { bigint: true });
    return {
      replacementPath,
      requiresReopen: await requiresReopen(replacementPath),
      requiresWriteLock: await hasSqliteHeader(fs, replacementPath),
      metadata: replacementFileMetadataFromStats(stats),
      generation: { exists: true, fingerprint: fingerprint(stats) }
    };
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }

  // realpath() also reports ENOENT for dangling links. Replacing that directory
  // entry would silently destroy the link instead of saving to its intended target.
  try {
    await fs.promises.lstat(absoluteTarget);
    throw new Error(`Cannot save through dangling symlink '${targetPath}'`);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }

  const canonicalParent = await fs.promises.realpath(path.dirname(absoluteTarget));
  return {
    replacementPath: path.join(canonicalParent, path.basename(absoluteTarget)),
    requiresReopen: await requiresReopen(
      path.join(canonicalParent, path.basename(absoluteTarget))
    ),
    requiresWriteLock: false,
    generation: { exists: false }
  };
}

function assertTargetUnchanged(fs: NodeFs, target: ResolvedTarget): void {
  if (!target.generation.exists) {
    try {
      fs.lstatSync(target.replacementPath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw new Error('Cannot verify the database save target before replacement.', {
        cause: error
      });
    }
    throw new Error('Database save target appeared during the save; retry.');
  }

  let current: FileFingerprint;
  try {
    current = fingerprint(fs.statSync(target.replacementPath, { bigint: true }));
  } catch (error) {
    throw new Error('Database save target changed during the save; retry.', {
      cause: error
    });
  }
  if (!sameFingerprint(target.generation.fingerprint, current)) {
    throw new Error('Database save target changed during the save; retry.');
  }
}

function assertNoWalFrames(fs: NodeFs, databasePath: string): void {
  try {
    const size = fs.statSync(`${databasePath}-wal`, { bigint: true }).size;
    if (size > WAL_HEADER_BYTES) {
      throw new Error(
        'The database save target has a WAL with uncheckpointed frames. '
        + 'Close other writers or checkpoint that database before retrying.'
      );
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
}

function safeWarn(
  logger: AtomicDatabaseWriteLogger | undefined,
  message: string,
  error?: unknown
): void {
  try {
    if (logger) logger('warn', message, error);
    else console.warn(`[SQLite Explorer] ${message}`, error);
  } catch {
    // A diagnostic sink cannot turn a committed rename into a false save failure.
  }
}

function warnOwnership(
  logger: AtomicDatabaseWriteLogger | undefined,
  failure: OwnershipPreservationFailure
): void {
  safeWarn(
    logger,
    'Database saved, but the replacement could not retain the destination owner/group '
    + `(uid ${failure.uid}, gid ${failure.gid}).`,
    failure.error
  );
}

/**
 * Ask the engine to create a complete snapshot at an adjacent private path,
 * then replace the resolved destination in one rename. The destination is
 * generation-checked immediately before commit; existing SQLite targets are
 * writer-locked so their main file and WAL cannot be replaced over live writes.
 */
export async function writeDatabaseSnapshotAtomically(
  fs: NodeFs,
  sourcePath: string | undefined,
  targetPath: string,
  writeTemporary: (temporaryPath: string) => Promise<void>,
  signal?: CancellationCheck,
  logger?: AtomicDatabaseWriteLogger,
  openedSource?: DatabaseFileGeneration
): Promise<DatabaseWriteResult> {
  signal?.throwIfAborted();
  const target = await resolveTarget(fs, sourcePath, targetPath);
  signal?.throwIfAborted();
  const replacingOpenedSource = openedSource && (
    target.requiresReopen || target.replacementPath === openedSource.canonicalPath
  );
  const assertOpenedSourceCurrent = () => {
    if (!replacingOpenedSource || !openedSource) return;
    if (target.replacementPath !== openedSource.canonicalPath) throw sourceChangedError();
    assertDatabaseFileGenerationCurrent(fs, openedSource);
  };
  assertOpenedSourceCurrent();

  const temporaryPath = path.join(
    path.dirname(target.replacementPath),
    `.${path.basename(target.replacementPath)}.sqlite-explorer-${crypto.randomUUID()}.tmp`
  );
  let temporary: NodeFileHandle | undefined;
  let directory: NodeFileHandle | undefined;
  let ownershipFailure: OwnershipPreservationFailure | undefined;
  let renamed = false;
  try {
    // Reserve by name through the engine: native VACUUM INTO requires a path
    // that does not exist, while WASM creates the same private random path.
    await writeTemporary(temporaryPath);
    signal?.throwIfAborted();

    temporary = await fs.promises.open(temporaryPath, 'r+');
    const temporaryStats = await temporary.stat({ bigint: true });
    if (!temporaryStats.isFile() || temporaryStats.size === 0n) {
      throw new Error('Database engine produced an invalid empty snapshot');
    }
    if (target.metadata) {
      ownershipFailure = await restoreTemporaryMetadata(temporary, target.metadata);
    }
    await temporary.sync();
    const expectedTemporary = fingerprint(await temporary.stat({ bigint: true }));
    const committedContentSha256 = replacingOpenedSource
      ? hashFileDescriptor(fs, temporary.fd, expectedTemporary)
      : undefined;
    await temporary.close();
    temporary = undefined;
    signal?.throwIfAborted();

    try {
      directory = await fs.promises.open(path.dirname(target.replacementPath), 'r');
    } catch {
      // Directory fsync is a post-rename durability enhancement. Unsupported
      // platforms are reported after commit rather than misreported as failure.
    }

    let writeLock: PagedSaveWriteLock | undefined;
    let primaryError: unknown;
    try {
      if (target.requiresWriteLock) {
        // Preserve the actionable hot-WAL diagnosis. The same check is repeated
        // after locking because this preliminary read is not a commit gate.
        assertNoWalFrames(fs, target.replacementPath);
        writeLock = acquireSqliteWriteLock(target.replacementPath);
      }
      assertTargetUnchanged(fs, target);
      if (target.requiresWriteLock) assertNoWalFrames(fs, target.replacementPath);
      const currentTemporary = fingerprint(
        fs.lstatSync(temporaryPath, { bigint: true })
      );
      if (!sameFingerprint(expectedTemporary, currentTemporary)) {
        throw new Error('Temporary database snapshot changed before rename');
      }

      if (writeLock?.releaseBeforeRename) {
        const lock = writeLock;
        writeLock = undefined;
        lock.release();
        assertTargetUnchanged(fs, target);
        if (target.requiresWriteLock) assertNoWalFrames(fs, target.replacementPath);
      }

      signal?.throwIfAborted();
      // A destination fingerprint captured only when Save starts would accept
      // an external replacement made since the in-memory image was opened.
      // Keep distinct Save As targets available even when the source is stale.
      assertOpenedSourceCurrent();
      fs.renameSync(temporaryPath, target.replacementPath);
      renamed = true;
      if (replacingOpenedSource && openedSource) {
        // Never adopt an unrelated replacement that races our committed rename.
        // Rename can change ctime, so accept its new value only after every
        // other field still identifies the private snapshot we just installed.
        openedSource.fingerprint = undefined;
        openedSource.contentSha256 = undefined;
        try {
          const committed = fingerprint(fs.statSync(target.replacementPath, { bigint: true }));
          if (!sameFingerprint(expectedTemporary, committed, false)
            || fs.realpathSync.native(openedSource.sourcePath) !== target.replacementPath) {
            throw sourceChangedError();
          }
          openedSource.contentSha256 = committedContentSha256;
          openedSource.fingerprint = committed;
        } catch (error) {
          safeWarn(logger,
            'Database saved, but its new file generation could not be verified. '
            + 'Use Save As to preserve later edits, or Reload Database before saving again.', error);
        }
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (writeLock) {
        try {
          writeLock.release();
        } catch (error) {
          if (renamed) {
            safeWarn(logger, 'Database saved, but releasing its SQLite write lock failed.', error);
          } else if (primaryError === undefined) {
            throw error;
          }
        }
      }
    }

    if (ownershipFailure) warnOwnership(logger, ownershipFailure);
    if (directory) {
      try {
        await directory.sync();
      } catch (error) {
        safeWarn(logger, 'Database saved, but parent-directory durability could not be confirmed.', error);
      }
    } else {
      safeWarn(logger, 'Database saved, but parent-directory durability is unavailable.');
    }
    return { requiresReopen: target.requiresReopen };
  } catch (error) {
    if (!renamed) {
      try {
        await fs.promises.rm(temporaryPath, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Database save failed and temporary cleanup also failed: ${temporaryPath}`
        );
      }
    }
    throw error;
  } finally {
    try {
      await temporary?.close();
    } catch (error) {
      if (!renamed) safeWarn(logger, 'Failed to close temporary database snapshot.', error);
    }
    try {
      await directory?.close();
    } catch (error) {
      if (renamed) safeWarn(logger, 'Database saved, but closing its directory handle failed.', error);
    }
  }
}
