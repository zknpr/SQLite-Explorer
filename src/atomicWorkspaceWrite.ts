import * as vsc from 'vscode';

import { crypto as webCrypto } from './platform/cryptoShim';

interface WorkspaceFileFingerprint {
  type: number;
  ctime: number;
  mtime: number;
  size: number;
  permissions: number | undefined;
}

export type WorkspaceFileGeneration =
  | { exists: false }
  | { exists: true; fingerprint: WorkspaceFileFingerprint };

function isMissingWorkspaceFile(error: unknown): boolean {
  const code = error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;
  return code === 'FileNotFound' || code === 'ENOENT';
}

function fingerprint(stat: vsc.FileStat): WorkspaceFileFingerprint {
  if ((stat.type & vsc.FileType.SymbolicLink) !== 0) {
    throw new Error('Cannot safely replace a symbolic-link database destination');
  }
  if ((stat.type & vsc.FileType.File) === 0) {
    throw new Error('The database destination is not a regular file');
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    throw new Error('The database destination has an invalid file size');
  }
  return {
    type: stat.type,
    ctime: stat.ctime,
    mtime: stat.mtime,
    size: stat.size,
    permissions: stat.permissions
  };
}

function sameFingerprint(
  left: WorkspaceFileFingerprint,
  right: WorkspaceFileFingerprint
): boolean {
  return left.type === right.type
    && left.ctime === right.ctime
    && left.mtime === right.mtime
    && left.size === right.size
    && left.permissions === right.permissions;
}

export async function captureWorkspaceFileGeneration(
  target: vsc.Uri
): Promise<WorkspaceFileGeneration> {
  try {
    return {
      exists: true,
      fingerprint: fingerprint(await vsc.workspace.fs.stat(target))
    };
  } catch (error) {
    if (isMissingWorkspaceFile(error)) return { exists: false };
    throw new Error('Cannot inspect the database destination before saving', { cause: error });
  }
}

async function assertWorkspaceFileGenerationUnchanged(
  target: vsc.Uri,
  expected: WorkspaceFileGeneration
): Promise<void> {
  const current = await captureWorkspaceFileGeneration(target);
  if (!expected.exists) {
    if (!current.exists) return;
    throw new Error('The destination appeared while the database was being saved; retry');
  }
  if (!current.exists || !sameFingerprint(expected.fingerprint, current.fingerprint)) {
    throw new Error('The destination changed while the database was being saved; retry');
  }
}

function siblingTemporaryUri(target: vsc.Uri): vsc.Uri {
  const separator = target.path.lastIndexOf('/');
  const directory = separator < 0 ? '' : target.path.slice(0, separator + 1);
  const leaf = separator < 0 ? target.path : target.path.slice(separator + 1);
  if (leaf.length === 0) {
    throw new Error('Cannot save a database without a destination filename');
  }
  const temporary = target.with({
    path: `${directory}.${leaf}.${webCrypto.randomUUID()}.tmp`,
    fragment: ''
  });
  if (temporary.toString() === target.toString()) {
    throw new Error('The workspace provider did not produce a distinct temporary database URI');
  }
  return temporary;
}

/**
 * Replace a workspace-provider resource only after a complete sibling write.
 * FileStat is the strongest conditional-write token exposed by workspace.fs;
 * checking it immediately before rename prevents normal external-edit races.
 */
export async function writeWorkspaceFileAtomically(
  target: vsc.Uri,
  bytes: Uint8Array,
  expectedGeneration: WorkspaceFileGeneration,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  const temporary = siblingTemporaryUri(target);
  let temporaryMayExist = false;
  try {
    // A provider may create or truncate the resource before rejecting writeFile.
    temporaryMayExist = true;
    await vsc.workspace.fs.writeFile(temporary, bytes);
    signal?.throwIfAborted();
    await assertWorkspaceFileGenerationUnchanged(target, expectedGeneration);
    signal?.throwIfAborted();
    await vsc.workspace.fs.rename(temporary, target, { overwrite: true });
    temporaryMayExist = false;
  } catch (error) {
    if (temporaryMayExist) {
      try {
        await vsc.workspace.fs.delete(temporary, { recursive: false, useTrash: false });
      } catch (cleanupError) {
        if (!isMissingWorkspaceFile(cleanupError)) {
          throw new AggregateError(
            [error, cleanupError],
            `Database save failed and temporary cleanup also failed: ${temporary.toString()}`
          );
        }
      }
    }
    throw error;
  }
}
