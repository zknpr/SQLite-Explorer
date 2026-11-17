import path from 'path';
import { crypto } from './platform/cryptoShim';

import type { DatabaseWriteResult } from './core/types';
import {
  isUnsupportedFolderFlush,
  patiently,
  refusedReplacement,
  replacementFileMetadataFromStats,
  restoreTemporaryMetadata,
  type OwnershipPreservationFailure,
  type ReplacementFileMetadata
} from './fileReplacementMetadata';
import {
  acquireSqliteWriteLock,
  type PagedSaveWriteLock
} from './pagedWritableSave';
import { hasOnlyItsMode, othersCanRenameIn } from './folderAccess';
import { descriptorsReach, makeFileInside, stagedSnapshotAccess } from './insideDirectory';
import { keepAccessEntries } from './posixAccessEntries';
import { nodeSqlite, ReplacedFileAccessList, type AccessListHost } from './windowsAccessList';

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
  /** The folder the destination is in, as it was when the path was resolved. */
  folder: { dev: bigint; ino: bigint };
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

// What SQLite writes for itself into a file it copies a database into, and
// so what differs from the snapshot afterwards: the journal format (a target
// in WAL mode stays in it), the change counter, the schema cookie, and which
// library wrote the file at which change. Measured with snapshots of both
// engines (SQLite 3.54.1) copied by Node's SQLite 3.50.4.
const REWRITTEN_BY_COPY: ReadonlyArray<readonly [number, number]> = [[18, 20], [24, 28], [40, 44], [92, 100]];
// SQLite never writes the page that holds its lock bytes, so the copy leaves there whatever the file had.
const LOCK_BYTES_OFFSET = 0x40000000;

/**
 * The SHA-256 of the file behind `descriptor`, which must be and stay the
 * generation `expected`. With `copied`, also the hash of its content as
 * SQLite's copy keeps it: two database files with the same one hold the same
 * database, whichever of them SQLite wrote.
 */
function hashFileDescriptor(fs: NodeFs, descriptor: number, expected: FileFingerprint, copied?: { sha256?: string }): string {
  if (!sameFingerprint(expected, fingerprint(fs.fstatSync(descriptor, { bigint: true })))) {
    throw sourceChangedError();
  }
  const hash = contentHash();
  const kept = copied && contentHash();
  const chunk = Buffer.alloc(1024 * 1024);
  let remaining = expected.size;
  let offset = 0;
  let lockPageEnd = 0;
  while (remaining > 0n) {
    const length = Number(remaining < BigInt(chunk.length) ? remaining : BigInt(chunk.length));
    const count = fs.readSync(descriptor, chunk, 0, length, null);
    if (count === 0) throw sourceChangedError();
    hash.update(chunk.subarray(0, count));
    if (kept) {
      // The page size is at byte 16, where 1 stands for 65536.
      if (offset === 0) lockPageEnd = LOCK_BYTES_OFFSET + (chunk.readUInt16BE(16) === 1 ? 65536 : chunk.readUInt16BE(16));
      for (const [start, end] of [...(offset === 0 ? REWRITTEN_BY_COPY : []), [LOCK_BYTES_OFFSET, lockPageEnd]]) {
        chunk.fill(0, Math.min(Math.max(start - offset, 0), count), Math.min(Math.max(end - offset, 0), count));
      }
      kept.update(chunk.subarray(0, count));
    }
    offset += count;
    remaining -= BigInt(count);
  }
  if (!sameFingerprint(expected, fingerprint(fs.fstatSync(descriptor, { bigint: true })))) {
    throw sourceChangedError();
  }
  if (copied && kept) copied.sha256 = kept.digest('hex');
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
      folder: await fs.promises.lstat(path.dirname(replacementPath), { bigint: true }),
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
    folder: await fs.promises.lstat(canonicalParent, { bigint: true }),
    replacementPath: path.join(canonicalParent, path.basename(absoluteTarget)),
    requiresReopen: await requiresReopen(
      path.join(canonicalParent, path.basename(absoluteTarget))
    ),
    requiresWriteLock: false,
    generation: { exists: false }
  };
}

/**
 * Node hands mkdtemp's prefix to Windows as it is, where every other call
 * here gets a path past 260 characters in Windows' extended form from Node
 * itself. Without that form Windows does not find the directory to create the
 * new one in, and a save beside a long path failed with ENOENT. The prefix is
 * given in that form, and taken off the name that comes back.
 */
function withoutNamespace(directoryPath: string): string {
  if (directoryPath.startsWith('\\\\?\\UNC\\')) return `\\\\${directoryPath.slice(8)}`;
  return directoryPath.startsWith('\\\\?\\') ? directoryPath.slice(4) : directoryPath;
}

function assertTargetUnchanged(fs: NodeFs, target: ResolvedTarget): void {
  // The path was resolved once: the folder must be the one resolved, and
  // the name is not followed.
  let folder: { dev: bigint; ino: bigint } | undefined;
  let gone: unknown;
  try {
    folder = fs.lstatSync(path.dirname(target.replacementPath), { bigint: true });
  } catch (error) {
    gone = error;
  }
  if (!folder || folder.dev !== target.folder.dev || folder.ino !== target.folder.ino) {
    throw new Error('Database save target changed during the save; retry.', { cause: gone });
  }
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

  let current: FileFingerprint | undefined;
  let cause: unknown;
  try {
    current = fingerprint(fs.lstatSync(target.replacementPath, { bigint: true }));
  } catch (error) {
    cause = error;
  }
  if (!current || !sameFingerprint(target.generation.fingerprint, current)) {
    throw new Error('Database save target changed during the save; retry.', { cause });
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

const WAITS_FOR_ANOTHER_PROGRAM_MS = [10, 20, 40, 80, 160, 320];

/**
 * Copy the snapshot's content into the existing file at `targetPath` through
 * SQLite's backup, inside one transaction on that file. The file stays the
 * same file, with its owner and its access list, where a rename would leave a
 * new one. A reader that arrives meanwhile is refused until the copy is
 * committed, and a writer that dies in the middle leaves a rollback journal:
 * SQLite restores the old content when it next opens the file, and the
 * WebAssembly engine refuses a file with such a journal beside it.
 *
 * Another connection that holds the file makes the backup fail at once, with
 * the message "not an error" and code 0 (measured in Node 24.12; nothing else
 * was seen to fail that way). Only that is tried again.
 *
 * SQLite opens the target by its name. `holdTarget` keeps that name on the
 * file from before `beforeEachAttempt`, which checks that it is the file the
 * save resolved, until the copy is done; `afterCopy` then throws when the
 * name leads to another file all the same.
 */
async function writeInto(
  snapshotPath: string,
  targetPath: string,
  holdTarget: () => () => void,
  beforeEachAttempt: () => void,
  afterCopy: () => void
): Promise<void> {
  const sqlite = nodeSqlite() as typeof import('node:sqlite') & {
    backup(source: import('node:sqlite').DatabaseSync, path: string): Promise<number>;
  };
  const cannot = (why: unknown): string => `Cannot write into '${targetPath}': ${String(why)}. The file was not changed.`;
  for (let attempt = 0; ; attempt++) {
    let failure: { errcode?: unknown; message?: unknown } | undefined;
    // Without the hold nothing is copied.
    let letGo: () => void;
    try {
      letGo = holdTarget();
    } catch (error) {
      throw new Error(cannot((error as Error).message), { cause: error });
    }
    try {
      beforeEachAttempt();
      // Read-write: a snapshot marked as a WAL database cannot be opened read-only.
      const snapshot = new sqlite.DatabaseSync(snapshotPath);
      try {
        // In its extended form on Windows: SQLite does not open a path past 260 characters as it is given.
        await sqlite.backup(snapshot, path.toNamespacedPath(targetPath));
      } catch (error) {
        failure = error as typeof failure;
      } finally {
        snapshot.close();
      }
      if (!failure) {
        afterCopy();
        return;
      }
    } finally {
      letGo();
    }
    const code = Number(failure.errcode);
    if (code === 0 && attempt < WAITS_FOR_ANOTHER_PROGRAM_MS.length) {
      await new Promise(resolve => setTimeout(resolve, WAITS_FOR_ANOTHER_PROGRAM_MS[attempt]));
      continue;
    }
    throw new Error(
      code === 0
        ? `Another program has '${targetPath}' open or locked: close the database there and save again. The file was not changed.`
        : code === 26
          ? `'${targetPath}' is not a SQLite database, and its permissions are its own, so it cannot be overwritten `
            + 'where it is. Save under another name. The file was not changed.'
          : cannot(failure.message)
            // SQLite gives this one code for a file it may not write and for a WAL file it cannot give another page size.
            + (code === 8 ? ' It is read-only, or a WAL file with another page size: save under another name.' : ''),
      { cause: failure }
    );
  }
}

export { hasOnlyItsMode, othersCanRenameIn, stagedSnapshotAccess };

/**
 * Ask the engine to create a complete snapshot, then install it: by one rename
 * over the resolved destination, or, for a file on Windows that would lose its
 * access list that way, by copying it into that file (`writeInto`). A snapshot
 * that is renamed is written beside the destination, on POSIX in a private
 * directory. The destination is generation-checked immediately before commit;
 * existing SQLite targets are writer-locked so their main file and WAL cannot
 * be replaced over live writes.
 *
 * `installed` identifies the file now at the destination, as this save
 * verified it: the snapshot it renamed, or the file it wrote into.
 *
 * `stage` is for an engine whose snapshot is created by another program, by
 * name and with a mode of that program's choosing (native VACUUM INTO). An
 * engine called without it must write in this process: on Linux the path it
 * is given can go through one of this process's descriptors. On POSIX,
 * where `othersCanRenameIn` answers for the destination's folder, such a
 * snapshot is written in this account's temporary folder and then copied
 * into a file this save creates beside the destination, owner-only and
 * never in place of anything: only that file's descriptor is written to,
 * and not before that very file was found, under its name, in the
 * directory made here.
 */
export async function writeDatabaseSnapshotAtomically(
  fs: NodeFs,
  sourcePath: string | undefined,
  targetPath: string,
  writeTemporary: (temporaryPath: string, mode: number) => Promise<void>,
  signal?: CancellationCheck,
  logger?: AtomicDatabaseWriteLogger,
  openedSource?: DatabaseFileGeneration,
  accessListHost?: AccessListHost,
  stage = false
): Promise<DatabaseWriteResult & { installed: { dev: bigint; ino: bigint } }> {
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

  const temporaryBase = path.join(
    path.dirname(target.replacementPath),
    `.${path.basename(target.replacementPath)}.sqlite-explorer-`
  );
  // Windows gives a new file the access list of the directory around it. A
  // file that has another list is not replaced. The empty file that shows
  // what a new one gets has a name no other program can know beforehand.
  const accessList = ReplacedFileAccessList.read(
    target.generation.exists ? target.replacementPath : undefined,
    fs,
    `${temporaryBase}${crypto.randomUUID()}.new`,
    () => assertTargetUnchanged(fs, target),
    accessListHost
  );
  if (accessList.unknown !== undefined) {
    safeWarn(logger, 'Could not compare the database\'s permissions with a new file\'s, so it is written where it is.', accessList.unknown);
  }
  // A target that keeps a list of its own is not replaced: the snapshot is
  // copied into it, so it is written in the account's temporary folder.
  const inPlace = accessList.keepsOwnList;
  type Made = { dev: bigint; ino: bigint; uid: bigint };
  let privateDirectory: string | undefined;
  let madeDirectory: Made | undefined;
  // Whether another account can rename on the way to the destination, once
  // that has been looked at with the platform's whole rule (below).
  let othersKnown = false;
  let othersCanRename = false;
  let stageDirectory: string | undefined;
  let madeStage: Made | undefined;
  let temporaryPath = `${temporaryBase}${crypto.randomUUID()}.tmp`;
  const replaced = (directoryPath: string | undefined, cause?: unknown): Error =>
    new Error(`The save's temporary directory was replaced while it was in use: ${directoryPath}`, { cause });
  // A directory is made and looked at in one step, with no pause between.
  // What is found must be what was just made: a directory with nothing in
  // it, and not a link.
  const make = (prefix: string): [string, Made] => {
    const made = withoutNamespace(fs.mkdtempSync(path.toNamespacedPath(prefix)));
    const found = fs.lstatSync(made, { bigint: true });
    // Not followed when it is a link by now.
    if (!found.isDirectory()) throw replaced(made);
    // One entry is enough to know.
    let entry: unknown;
    try {
      const listing = fs.opendirSync(made);
      try {
        entry = listing.readSync();
      } finally {
        listing.closeSync();
      }
    } catch (error) {
      // No longer a directory this account can list: not the one just made.
      if (['ENOTDIR', 'ENOENT', 'EACCES', 'ELOOP'].includes(errorCode(error) ?? '')) throw replaced(made, error);
      throw error;
    }
    if (entry) throw replaced(made);
    return [made, found];
  };
  // mkdtemp creates the directory 0700 under a name that did not exist, in
  // the destination's own directory: the same filesystem, so the rename
  // below stays atomic. On POSIX no other user can open the snapshot inside
  // it, whatever mode its writer gives the file, before the rename.
  const makeBesideTarget = (): void => {
    [privateDirectory, madeDirectory] = make(temporaryBase);
    temporaryPath = path.join(privateDirectory, path.basename(target.replacementPath));
  };
  // This account's temporary folder as it really is: a link is followed
  // first, so that the folders looked at are the ones the files go through.
  const ownTemporary = (): string => {
    const given = (require('os') as typeof import('os')).tmpdir();
    try {
      return path.join(fs.realpathSync.native(given), 'sqlite-explorer-save-');
    } catch (error) {
      throw new Error(`The temporary folder '${given}' cannot be used: ${(error as Error).message}`, { cause: error });
    }
  };
  if (inPlace) {
    [privateDirectory, madeDirectory] = make(ownTemporary());
    // A short name of its own: the target's could make this path too long for SQLite.
    temporaryPath = path.join(privateDirectory, 'snapshot.db');
  } else if (accessList.needsPrivateDirectory) {
    const folder = path.dirname(target.replacementPath);
    // An engine in another process is staged wherever another account can
    // rename. One in this process is handed a path through a descriptor
    // where there is one (below, at no cost), and is staged as well where
    // there is none.
    let openToOthers: string | undefined;
    if (stage) {
      openToOthers = othersCanRenameIn(fs, folder);
      othersKnown = true;
    } else if (!descriptorsReach(fs)) {
      try {
        // macOS: with its look at the folders' entries. Elsewhere by owners and modes, every group counted.
        openToOthers = othersCanRenameIn(fs, folder, process.platform, process.platform === 'darwin' ? undefined : false);
      } catch {
        // Not known, so not trusted.
        openToOthers = folder;
      }
      othersKnown = process.platform === 'darwin';
    }
    othersCanRename = openToOthers !== undefined;
    if (openToOthers !== undefined) {
      // The account's own temporary folder, and no other place when it cannot be used.
      const prefix = ownTemporary();
      const open = othersCanRenameIn(fs, path.dirname(prefix));
      if (open !== undefined) {
        // "May": a folder whose access-control entries could not be read counts, too.
        throw new Error(`Other accounts may be able to rename what is in '${openToOthers}', which the destination is in or under, `
          + `and in '${open}', which the temporary folder '${path.dirname(prefix)}' is or is under, so the save cannot keep the `
          + 'database from them. Set TMPDIR to a folder that no other account can write, under folders none can write. '
          + 'On Linux a folder only its own group can write is told from a shared one by getfacl, which must be installed for that.');
      }
      [stageDirectory, madeStage] = make(prefix);
    } else {
      makeBesideTarget();
    }
  }
  // Everything below reaches the snapshot through the private directory's
  // name, so it must still be the directory made above.
  const assertStill = (directoryPath: string | undefined, made: Made | undefined): void => {
    if (directoryPath === undefined || made === undefined) return;
    const now = fs.lstatSync(directoryPath, { bigint: true });
    // Its owner as well: a filesystem can give a removed directory's number
    // to the next one made.
    if (!now.isDirectory() || now.dev !== made.dev || now.ino !== made.ino || now.uid !== made.uid) {
      throw replaced(directoryPath);
    }
  };
  const assertPrivateDirectory = (): void => assertStill(privateDirectory, madeDirectory);
  // The private directory and a file this save made in it have the same
  // owner: each filesystem reports both owners its own way, but the same way.
  const assertOwned = (file: { uid: bigint }): void => {
    if (!inPlace && madeDirectory !== undefined && madeDirectory.uid !== file.uid) throw replaced(privateDirectory);
  };
  // Before a snapshot gets a mode wider than owner-only: it is where the
  // destination is, in the directory made here, under its name.
  const assertSnapshotInPlace = (snapshot: { dev: bigint; ino: bigint }): void => {
    assertTargetUnchanged(fs, target);
    assertPrivateDirectory();
    if (privateDirectory === undefined || inPlace) return;
    let there: { dev: bigint; ino: bigint };
    try {
      there = fs.lstatSync(temporaryPath, { bigint: true });
    } catch (error) {
      // Made, and not there: it was made somewhere else.
      throw replaced(privateDirectory, error);
    }
    if (there.dev !== snapshot.dev || there.ino !== snapshot.ino) throw replaced(privateDirectory);
  };
  // Linux, where another account can rename in the destination's folder:
  // the snapshot's file is made and looked at through a descriptor of the
  // private directory. The descriptor is the directory made above, by
  // device, number and owner, or the save stops. Whether such paths work
  // here is decided before the file is made, from the descriptor's own
  // entry, which answers the same once the directory is removed: after that
  // a create that fails fails the save, and nothing is tried by name
  // instead. Where they do not work, the file is made by a helper process
  // from inside the directory (`makeFileInside`).
  let heldDirectory: number | undefined;
  // Whether `temporaryPath` goes through that descriptor. Until it does, it
  // is a path by name, and what is under a name is not this save's to remove.
  let throughDescriptor = false;
  const reachThroughDescriptor = (): boolean => {
    if (process.platform !== 'linux' || !stagedSnapshotAccess.throughDescriptor) return false;
    if (privateDirectory === undefined || madeDirectory === undefined) return false;
    try {
      heldDirectory = fs.openSync(privateDirectory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      // A link, or nothing, where the directory was.
      if (['ELOOP', 'ENOTDIR', 'ENOENT', 'EACCES'].includes(errorCode(error) ?? '')) throw replaced(privateDirectory, error);
      throw error;
    }
    const opened = fs.fstatSync(heldDirectory, { bigint: true });
    if (opened.dev !== madeDirectory.dev || opened.ino !== madeDirectory.ino || opened.uid !== madeDirectory.uid) {
      throw replaced(privateDirectory);
    }
    const through = `/proc/self/fd/${heldDirectory}`;
    let entry: { dev: bigint; ino: bigint } | undefined;
    try {
      entry = fs.statSync(through, { bigint: true });
    } catch {
      // No /proc here.
    }
    // No /proc here: the caller goes another way.
    if (entry === undefined || entry.dev !== opened.dev || entry.ino !== opened.ino) return false;
    temporaryPath = path.join(through, path.basename(temporaryPath));
    throughDescriptor = true;
    return true;
  };
  const removeStage = (): void => {
    if (stageDirectory === undefined) return;
    assertStill(stageDirectory, madeStage);
    fs.rmSync(stageDirectory, { recursive: true, force: true });
  };
  let temporary: NodeFileHandle | undefined;
  let directory: NodeFileHandle | undefined;
  let ownershipFailure: OwnershipPreservationFailure | undefined;
  let renamed = false;
  try {
    // Opened before the engine writes and kept until the end: for the flush
    // after the rename, and because FAT gives a folder a new number once
    // nothing holds it in memory (measured on Linux: 101, then 104 after a
    // cache drop), which the target check would take for another folder.
    try {
      directory = await fs.promises.open(path.dirname(target.replacementPath), 'r');
    } catch {
      // Directory fsync is a post-rename durability enhancement. Unsupported
      // platforms are reported after commit rather than misreported as failure.
    }
    // The engine creates the snapshot at this new path: native VACUUM INTO
    // with SQLite's default file mode, WASM with `mode`. An existing target's
    // bytes stay owner-only until its own mode is restored below, and a new
    // target gets the umask default the renamed file would have had anyway.
    if (stageDirectory === undefined) {
      // An engine in this process (`stage` is false) can be given a path
      // through this process's descriptor, so its snapshot is made in the
      // directory itself too. When the folders cannot be looked at, that
      // route is the one that needs no answer.
      if (!stage && !inPlace && privateDirectory !== undefined && process.platform === 'linux') {
        let open = true;
        try {
          // Every group counts here: this route costs nothing, so none needs to be told apart.
          open = othersCanRenameIn(fs, path.dirname(target.replacementPath), process.platform, false) !== undefined;
        } catch {
          // Taken as open to others.
        }
        // Chosen above because such paths work here: without one the engine would make its file by name.
        if (open && !reachThroughDescriptor()) throw new Error('The save could not reach its temporary directory through a descriptor.');
      }
      try {
        await writeTemporary(temporaryPath, target.metadata ? 0o600 : 0o666);
      } catch (error) {
        if (throughDescriptor && errorCode(error) === 'ENOENT') throw replaced(privateDirectory, error);
        throw error;
      }
      assertPrivateDirectory();
      signal?.throwIfAborted();
      temporary = await fs.promises.open(temporaryPath, 'r+');
    } else {
      const stagedPath = path.join(stageDirectory, 'snapshot.db');
      try {
        await writeTemporary(stagedPath, target.metadata ? 0o600 : 0o666);
      } catch (error) {
        // Where it was writing, which is not the destination's folder: a
        // full temporary folder stops a save into another one. A cancelled
        // save is told by its error, which is passed on as it is.
        let cancelled = false;
        try {
          signal?.throwIfAborted();
        } catch {
          cancelled = true;
        }
        if (cancelled || !(error instanceof Error)) throw error;
        // A new error: the engine may keep its own and throw it again.
        const told = new Error(`${error.message} (the snapshot is written in '${stageDirectory}' first)`, { cause: error });
        told.name = error.name;
        throw Object.assign(told, error);
      }
      signal?.throwIfAborted();
      const staged = await fs.promises.open(stagedPath, 'r');
      try {
        const given = (await staged.stat()).mode & 0o777;
        // The engine took its time: the destination's folder is still the one resolved.
        assertTargetUnchanged(fs, target);
        makeBesideTarget();
        // Created here, owner-only, and never in place of something else.
        if (reachThroughDescriptor()) {
          try {
            temporary = await fs.promises.open(temporaryPath, 'wx+', 0o600);
          } catch (error) {
            // Through a descriptor only a directory removed since has no room for a new name.
            if (errorCode(error) === 'ENOENT') throw replaced(privateDirectory, error);
            throw error;
          }
        } else {
          // No path through a descriptor here: a helper process makes the
          // file from inside the directory. The file opened by name is this
          // save's only if it is that very file.
          const inside = makeFileInside(privateDirectory!, madeDirectory!, path.basename(temporaryPath));
          if (inside === undefined) throw replaced(privateDirectory);
          try {
            temporary = await fs.promises.open(temporaryPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
          } catch (error) {
            // Not under the name: the name leads elsewhere by now.
            throw replaced(privateDirectory, error);
          }
          const opened = await temporary.stat({ bigint: true });
          if (opened.dev !== inside.dev || opened.ino !== inside.ino) throw replaced(privateDirectory);
        }
        const created = await temporary.stat({ bigint: true });
        // Before it holds anything, in one step: the directory under the name
        // is the one made above, and the file under the name in it is this
        // very file.
        assertSnapshotInPlace(created);
        assertOwned(created);
        const chunk = Buffer.alloc(1024 * 1024);
        for (let at = 0, count; (count = (await staged.read(chunk, 0, chunk.length, at)).bytesRead) > 0; at += count) {
          // A write can take fewer bytes than it was given, and say so without failing.
          for (let done = 0; done < count;) {
            signal?.throwIfAborted();
            const wrote = (await temporary.write(chunk, done, count - done, at + done)).bytesWritten;
            if (wrote === 0) throw new Error('The snapshot could not be copied beside its destination');
            done += wrote;
          }
        }
        if (!target.metadata) {
          // Wider than owner-only only where it was meant to go.
          assertSnapshotInPlace(created);
          try {
            await temporary.chmod(given);
          } catch (error) {
            // A filesystem that keeps no modes (FAT) has given the file the one it can have.
            safeWarn(logger, 'The new database keeps the mode its filesystem gave it.', error);
          }
        }
      } finally {
        await staged.close();
      }
    }
    const temporaryStats = await temporary.stat({ bigint: true });
    if (!temporaryStats.isFile() || temporaryStats.size === 0n) {
      throw new Error('Database engine produced an invalid empty snapshot');
    }
    assertOwned(temporaryStats);
    if (target.metadata) {
      // The destination's own mode can be wider than owner-only: not before
      // the snapshot is known to be where the destination is.
      assertSnapshotInPlace(temporaryStats);
      ownershipFailure = await restoreTemporaryMetadata(temporary, target.metadata);
      if (!inPlace && target.generation.exists) {
        // What a mode does not carry: the access-control entries of the file
        // this one replaces (`posixAccessEntries.ts`). Before the snapshot's
        // change time is remembered below, since setting them moves it. After
        // its mode, unlike the paged save's copy: on Linux, where a listing
        // carries the mode and the order matters, the snapshot is in a
        // directory only this account can enter.
        keepAccessEntries(
          fs,
          { path: target.replacementPath, dev: target.generation.fingerprint.dev, ino: target.generation.fingerprint.ino },
          { fd: temporary.fd, path: temporaryPath },
          () => {
            // Looked at once for the route, where it was: each look starts a program on macOS.
            if (othersKnown) return othersCanRename;
            try {
              return othersCanRenameIn(fs, path.dirname(target.replacementPath)) !== undefined;
            } catch {
              // Not known, so not trusted.
              return true;
            }
          },
          (message, error) => safeWarn(logger, message, error)
        );
      }
    }
    await temporary.sync();
    const expectedTemporary = fingerprint(await temporary.stat({ bigint: true }));
    // For a copy into the target, what the snapshot holds is compared with what the target holds afterwards.
    const snapshotContent: { sha256?: string } = {};
    const committedContentSha256 = replacingOpenedSource
      ? hashFileDescriptor(fs, temporary.fd, expectedTemporary, inPlace ? snapshotContent : undefined)
      : undefined;
    await temporary.close();
    temporary = undefined;
    signal?.throwIfAborted();

    let writeLock: PagedSaveWriteLock | undefined;
    let primaryError: unknown;
    try {
      if (target.requiresWriteLock) {
        // Preserve the actionable hot-WAL diagnosis. The same check is repeated
        // after locking because this preliminary read is not a commit gate.
        assertNoWalFrames(fs, target.replacementPath);
        writeLock = await patiently(() => {
          signal?.throwIfAborted();
          return acquireSqliteWriteLock(target.replacementPath);
        });
      }
      const assertReady = (): void => {
        assertPrivateDirectory();
        assertTargetUnchanged(fs, target);
        if (target.requiresWriteLock) assertNoWalFrames(fs, target.replacementPath);
        const currentTemporary = fingerprint(
          fs.lstatSync(temporaryPath, { bigint: true })
        );
        if (!sameFingerprint(expectedTemporary, currentTemporary)) {
          throw new Error('Temporary database snapshot changed before rename');
        }
      };

      if (writeLock && (writeLock.releaseBeforeRename || inPlace)) {
        // Windows cannot rename over SQLite's open handle, and the copy into
        // an existing file takes this lock for itself: check under the lock,
        // let it go, and check again with the commit below.
        assertReady();
        const lock = writeLock;
        writeLock = undefined;
        lock.release();
      }

      // Every check runs again with each attempt, right before its rename.
      // Only Windows refuses a rename for a moment, and there the lock is
      // gone by now; any program that could change the file between two
      // attempts has it open, which is what refuses the rename.
      const beforeCommit = (): void => {
        assertReady();
        signal?.throwIfAborted();
        // A destination fingerprint captured only when Save starts would accept
        // an external replacement made since the in-memory image was opened.
        // Keep distinct Save As targets available even when the source is stale.
        assertOpenedSourceCurrent();
      };
      if (inPlace) {
        await writeInto(temporaryPath, target.replacementPath, accessList.holdTarget, beforeCommit, () => {
          const written = fs.statSync(target.replacementPath, { bigint: true });
          if (!target.generation.exists
            || written.dev !== target.generation.fingerprint.dev
            || written.ino !== target.generation.fingerprint.ino) {
            throw new Error(`'${target.replacementPath}' was replaced while it was written into.`);
          }
        });
      } else {
        const replaced = patiently(() => {
          beforeCommit();
          try {
            fs.renameSync(temporaryPath, target.replacementPath);
          } catch (error) {
            throw refusedReplacement(error, target.replacementPath);
          }
        });
        if (replaced) await replaced;
      }
      renamed = true;
      if (replacingOpenedSource && openedSource) {
        // Never adopt an unrelated replacement that races our committed rename.
        // Rename can change ctime, so accept its new value only after every
        // other field still identifies the private snapshot we just installed.
        openedSource.fingerprint = undefined;
        openedSource.contentSha256 = undefined;
        try {
          const committed = fingerprint(fs.statSync(target.replacementPath, { bigint: true }));
          if (fs.realpathSync.native(openedSource.sourcePath) !== target.replacementPath) throw sourceChangedError();
          if (inPlace) {
            // The same file with new content, written by SQLite. It is this
            // save's only while it holds what the snapshot held: a write by
            // another program since the copy is not adopted, and with another
            // connection on a WAL database the content is still in the log.
            if (!target.generation.exists
              || committed.dev !== target.generation.fingerprint.dev
              || committed.ino !== target.generation.fingerprint.ino) throw sourceChangedError();
            assertNoWalFrames(fs, target.replacementPath);
            const written = fs.openSync(target.replacementPath, 'r');
            try {
              const writtenContent: { sha256?: string } = {};
              const sha256 = hashFileDescriptor(fs, written, committed, writtenContent);
              if (writtenContent.sha256 !== snapshotContent.sha256) throw sourceChangedError();
              openedSource.contentSha256 = sha256;
            } finally {
              fs.closeSync(written);
            }
          } else {
            if (!sameFingerprint(expectedTemporary, committed, false)) throw sourceChangedError();
            openedSource.contentSha256 = committedContentSha256;
          }
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
    const remains = (directoryPath: string | undefined, error: unknown): void =>
      safeWarn(logger, `Database saved, but its temporary directory remains: ${directoryPath}`, error);
    try {
      removeStage();
    } catch (error) {
      remains(stageDirectory, error);
    }
    if (privateDirectory !== undefined) {
      try {
        // In the account's temporary folder the snapshot is still there, with
        // whatever SQLite put beside it while reading it.
        if (inPlace) await fs.promises.rm(privateDirectory, { recursive: true, force: true });
        else {
          assertPrivateDirectory();
          fs.rmdirSync(privateDirectory);
        }
      } catch (error) {
        remains(privateDirectory, error);
      }
    }
    if (directory) {
      try {
        await directory.sync();
      } catch (error) {
        if (!isUnsupportedFolderFlush(error)) {
          safeWarn(logger, 'Database saved, but parent-directory durability could not be confirmed.', error);
        }
      }
    } else {
      safeWarn(logger, 'Database saved, but parent-directory durability is unavailable.');
    }
    const installed = inPlace && target.generation.exists ? target.generation.fingerprint : expectedTemporary;
    return { requiresReopen: target.requiresReopen, installed: { dev: installed.dev, ino: installed.ino } };
  } catch (error) {
    if (!renamed) {
      try {
        // Windows keeps a deleted file's name until its last handle closes,
        // and that name would keep the directory from being removed.
        try {
          await temporary?.close();
        } catch (closeError) {
          // The cleanup below is tried all the same.
          safeWarn(logger, 'Failed to close temporary database snapshot.', closeError);
        }
        temporary = undefined;
        // Never through a name that is no longer the directory made above,
        // and never recursively beside the destination. What is left then
        // stays for the user to look at.
        // Checked and removed in one step, for the same reason. The
        // directory of a copy is in this account's own temporary folder.
        try {
          // Through the descriptor the snapshot is removed from the directory
          // made here.
          if (throughDescriptor) fs.rmSync(temporaryPath, { force: true });
          assertPrivateDirectory();
          if (inPlace && privateDirectory !== undefined) {
            fs.rmSync(privateDirectory, { recursive: true, force: true });
          } else {
            fs.rmSync(temporaryPath, { force: true });
            if (privateDirectory !== undefined) fs.rmdirSync(privateDirectory);
          }
        } finally {
          removeStage();
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Database save failed and temporary cleanup also failed: ${privateDirectory ?? temporaryPath}`
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
    if (heldDirectory !== undefined) {
      try {
        fs.closeSync(heldDirectory);
      } catch (error) {
        safeWarn(logger, 'Failed to close the descriptor of the save\'s temporary directory.', error);
      }
    }
  }
}
