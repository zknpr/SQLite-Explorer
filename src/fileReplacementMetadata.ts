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
}

// Recreating setuid/setgid after writing user-controlled bytes could turn an
// executable-looking replacement into a privileged program. Sticky is a
// directory policy and has no useful regular-file replacement meaning.
const ORDINARY_PERMISSION_MASK = 0o777n;

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
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
 * Node core has no API for copying per-file ACLs or extended attributes. An
 * atomic rename leaves the parent directory and its ACLs in place, but a fresh
 * temp inode cannot retain target-specific ACL entries, quarantine/provenance
 * xattrs, or other extended attributes without a native dependency or shelling
 * out. Replacement paths deliberately do neither.
 */
export async function restoreTemporaryMetadata(
  temporary: TemporaryMetadataHandle,
  target: ReplacementFileMetadata
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
  await temporary.chmod(target.mode);
  return ownershipFailure;
}
