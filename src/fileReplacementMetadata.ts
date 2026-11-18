export interface ReplacementFileMetadata {
  mode: number;
  ownership?: {
    uid: number;
    gid: number;
  };
}

export interface OwnershipPreservationFailure {
  uid: number;
  gid: number;
  error: unknown;
}

export interface TemporaryMetadataHandle {
  chown(uid: number, gid: number): Promise<void>;
  chmod(mode: number): Promise<void>;
  /** The file's mode as the filesystem reports it now. */
  stat?(): Promise<{ mode: number | bigint }>;
}

// Recreating setuid/setgid after writing user-controlled bytes could turn an
// executable-looking replacement into a privileged program. Sticky is a
// directory policy and has no useful regular-file replacement meaning.
const ORDINARY_PERMISSION_MASK = 0o777n;

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

/**
 * Whether a failed flush of the replaced file's folder is only Windows saying
 * that folders cannot be flushed. FlushFileBuffers needs write access, a
 * folder handle is opened for reading, and the answer is "access denied"
 * (EPERM) for every folder on every save. That says nothing about the save at
 * hand, so it is not reported, where any other error is. The rename itself is
 * then as durable as the file system's own journal makes it, which is all
 * Windows offers here; SQLite does not flush folders there either.
 */
export function isUnsupportedFolderFlush(error: unknown): boolean {
  return process.platform === 'win32' && errorCode(error) === 'EPERM';
}

/**
 * What a failed rename onto a save's target means on Windows. It will not
 * replace a file that any program holds open, whether that program uses the
 * database or only reads it, and Node reports "operation not permitted" with
 * the temporary path and the target. Nothing has been changed by then, so the
 * error says what to do. Other errors, and other platforms, pass through.
 * The program may have the file open for a moment only, which the reworded
 * error says (`isMomentary`).
 */
export function refusedReplacement(error: unknown, targetPath: string, platform: string = process.platform): unknown {
  const code = errorCode(error);
  if (platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) return error;
  return Object.assign(new Error(
    `Windows refused to replace '${targetPath}'. That usually means another program has the file open: `
    + 'close the database there and save again. The file was not changed.',
    { cause: error }
  ), { code, momentary: true });
}

/**
 * Whether a save step failed because of something another program may stop
 * doing in a moment: a connection that holds a SQLite lock, or, on Windows, a
 * handle that keeps the file from being replaced.
 */
export const isMomentary = (error: unknown): boolean =>
  (error as { momentary?: unknown } | null | undefined)?.momentary === true;

// Measured on Windows beside a second process that read the database every 5
// to 50 ms: up to 4% of saves met a busy lock or a refused rename, and each
// of those went through within 75 ms when tried again. These waits add up to
// 630 ms, after which the refusal is reported as it was before.
const MOMENTARY_WAITS_MS = [10, 20, 40, 80, 160, 320];

/**
 * Runs `step`, and runs it again after each wait for as long as it fails for
 * a moment (`isMomentary`). `step` must make every check its action relies
 * on: what was checked before a wait is stale after it, so a later run can
 * fail for another reason, and that failure is passed on at once.
 *
 * Returns a promise only after it has had to wait. A step that succeeds, or
 * fails for another reason, has run without a pause when this returns.
 */
export function patiently<T>(
  step: () => T,
  wait: (milliseconds: number) => Promise<unknown> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
): T | Promise<T> {
  try {
    return step();
  } catch (error) {
    if (!isMomentary(error)) throw error;
  }
  return (async () => {
    for (let attempt = 0; ; attempt++) {
      await wait(MOMENTARY_WAITS_MS[attempt]);
      try {
        return step();
      } catch (error) {
        if (!isMomentary(error) || attempt === MOMENTARY_WAITS_MS.length - 1) throw error;
      }
    }
  })();
}

export function ordinaryPermissionMode(mode: bigint): number {
  return Number(mode & ORDINARY_PERMISSION_MASK);
}

export function replacementFileMetadataFromStats(stats: {
  mode: bigint;
  uid: bigint;
  gid: bigint;
}): ReplacementFileMetadata {
  return {
    mode: ordinaryPermissionMode(stats.mode),
    ownership: {
      uid: Number(stats.uid),
      gid: Number(stats.gid)
    }
  };
}

/**
 * Restore the inode metadata Node can reach without a path race.
 *
 * Owner and mode only. Node core has no API for a file's access-control
 * entries or extended attributes. The entries are given to the new file by
 * the system's own programs (`posixAccessEntries.ts`): after this, or in
 * `ownerRestored`, which runs between the owner and the mode, for a file
 * other accounts can reach meanwhile.
 * Quarantine and provenance attributes and other extended attributes of the
 * replaced file are not carried over. On Windows, where the access list is
 * the only permission a file has, a file whose list a rename would lose is
 * not replaced at all (`windowsAccessList.ts`).
 */
export async function restoreTemporaryMetadata(
  temporary: TemporaryMetadataHandle,
  target: ReplacementFileMetadata,
  ownerRestored?: () => void
): Promise<OwnershipPreservationFailure | undefined> {
  let ownershipFailure: OwnershipPreservationFailure | undefined;
  if (target.ownership && process.platform !== 'win32') {
    try {
      // fchown before chmod: ownership changes can clear mode bits on POSIX.
      await temporary.chown(target.ownership.uid, target.ownership.gid);
    } catch (error) {
      if (errorCode(error) !== 'EPERM') throw error;
      // A non-root writer cannot give its temp inode back to a different owner.
      // The rename can still be valid; report the access consequence only once
      // the replacement has actually succeeded.
      ownershipFailure = { ...target.ownership, error };
    }
  }
  ownerRestored?.();
  try {
    await temporary.chmod(target.mode);
  } catch (error) {
    // A filesystem that keeps no modes (FAT) reports the owner and mode its
    // mount was given for every file, and refuses a change by anyone that
    // owner is not. The new file then has the mode the replaced one has:
    // there is nothing to restore. Any other refusal fails the save.
    if (errorCode(error) !== 'EPERM' || !temporary.stat) throw error;
    const now = Number(BigInt((await temporary.stat()).mode) & ORDINARY_PERMISSION_MASK);
    if (now !== target.mode) throw error;
  }
  return ownershipFailure;
}
