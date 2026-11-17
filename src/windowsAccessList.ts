import path from 'path';

/**
 * A save that replaces a file by rename puts a new file under the old name,
 * and on Windows a new file takes the access list its folder hands down. The
 * replaced file's list can differ from that: entries of its own, a list cut
 * off from its folder, or the entries of the folder it was moved here from,
 * which Windows leaves on a moved file, still marked inherited.
 *
 * So a save asks this module one question before it writes: does the target
 * have exactly the list a new file beside it gets? Only then is it replaced.
 * Any other target is written into where it is (`writeInto` in
 * `atomicDatabaseWrite.ts`), and stays the same file with the list it had.
 *
 * Nothing here changes a list. The one program run is `icacls /save`, by
 * absolute path and without a shell, which reads a list as SDDL. Each file
 * it reads is held open meanwhile, so that its name and the names of the
 * folders above it stay with it. The answer comes from comparing two whole
 * lists read that way. Volumes without access lists (FAT, exFAT) answer with
 * the list `D:NO_ACCESS_CONTROL`, which counts as nothing to keep.
 */

export interface AccessListCommandResult {
  status: number | null;
  error?: unknown;
}

/** The program and the scratch file, replaceable in tests. */
export interface AccessListHost {
  platform: NodeJS.Platform;
  /** Runs `icacls` with these arguments, no shell, and waits for it. */
  run(program: 'icacls', args: readonly string[]): AccessListCommandResult;
  /** Runs `use` with the path of a new file only this user can reach, then removes it. */
  withScratchFile<T>(use: (scratchPath: string) => T): T;
  /** Reads what `icacls /save` wrote: UTF-16LE text. */
  readSavedList(scratchPath: string): string;
  /**
   * Opens the file at this path so that, until the returned function is
   * called, no program can rename or delete it or rename a folder above it.
   */
  hold(filePath: string): () => void;
}

const NO_LIST = 'D:NO_ACCESS_CONTROL';
// The call blocks its thread: the extension host for a paged save and for
// Save As on the native engine. icacls answers in tens of milliseconds, so
// this only bounds a program that hangs.
const ICACLS_TIMEOUT_MS = 5_000;

/** Node's own SQLite, where the extension host has one. */
export function nodeSqlite(): typeof import('node:sqlite') {
  try {
    return require('node:sqlite');
  } catch (error) {
    // The bundler resolves a bare require at build time, and the browser build has no such module.
    throw new Error('No SQLite in this extension host', { cause: error });
  }
}

function nodeAccessListHost(): AccessListHost {
  // Required here, not imported: this module is also bundled for VS Code Web,
  // where these do not exist and this function is never reached.
  const childProcess = require('child_process') as typeof import('child_process');
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const icacls = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'icacls.exe');
  return {
    platform: process.platform,
    run(_program, args) {
      // /L: a symbolic link at the path's last name is read itself, not what it points to.
      const result = childProcess.spawnSync(icacls, [...args, '/L'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: ICACLS_TIMEOUT_MS
      });
      return { status: result.status, error: result.error };
    },
    withScratchFile(use) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-explorer-access-'));
      try {
        return use(path.join(directory, 'list'));
      } finally {
        try {
          fs.rmSync(directory, { recursive: true, force: true });
        } catch {
          // A leftover scratch folder must not discard the list that was read.
        }
      }
    },
    readSavedList(scratchPath) {
      return fs.readFileSync(scratchPath, 'utf16le');
    },
    hold(filePath) {
      // SQLite opens a file without sharing it for deletion, which Node's own
      // open cannot do. It takes no lock and runs no statement. When another
      // program has the file open without sharing it at all, SQLite tries
      // the open again for a little over a second before it gives up.
      const held = new (nodeSqlite().DatabaseSync)(path.win32.toNamespacedPath(filePath), { readOnly: true });
      return () => held.close();
    }
  };
}

interface ParsedAccessList {
  /** Cut off from the folder's list. */
  isProtected: boolean;
  /** Entries as written, in their order, without their parentheses. */
  entries: string[];
  /** What follows the entries: the part that holds a file's integrity label, when one is written. */
  rest: string;
}

/** The parts of a list in SDDL form, or undefined for text this does not read (a conditional entry, for one). */
export function parseAccessList(sddl: string): ParsedAccessList | undefined {
  const match = /^D:([A-Z]*)((?:\([^()]*\))*)(S:.*)?$/.exec(sddl.trim());
  if (!match) return undefined;
  const [, flags, entries, rest] = match;
  return {
    isProtected: flags.replace(/A[RI]/g, '').includes('P'),
    entries: entries ? entries.slice(1, -1).split(')(') : [],
    rest: rest ?? ''
  };
}

/**
 * Whether two lists are the same list: the same entries in the same order,
 * cut off or not alike, and the same after them. Windows reads a list from
 * its first entry on, so the order is part of the list. A file that got its
 * list from its folder has it in the order a new file there gets it.
 */
export function sameAccessList(left: string, right: string): boolean {
  const a = parseAccessList(left);
  const b = parseAccessList(right);
  if (!a || !b) return left.trim() === right.trim();
  return a.isProtected === b.isProtected && a.rest === b.rest && a.entries.join() === b.entries.join();
}

/**
 * A path as icacls takes it. It does not find a file whose path is longer
 * than Windows' classic limit of 260 characters (it ends with code 3) unless
 * the path is in its extended form, `\\?\C:\...`.
 */
function forProgram(filePath: string): string {
  return filePath.length < 248 ? filePath : path.win32.toNamespacedPath(filePath);
}

/** The file calls a save needs for the empty file it makes beside its target. */
export interface ProbeFileSystem {
  openSync(path: string, flags: string): number;
  closeSync(fd: number): void;
  rmSync(path: string, options: { force: boolean }): void;
  fstatSync(fd: number, options: { bigint: true }): { dev: bigint; ino: bigint };
  lstatSync(path: string, options: { bigint: true }): { dev: bigint; ino: bigint };
}

/** What a save learns, before it writes, about the access list of the file it is about to replace. */
export interface ReplacedFileAccessList {
  /**
   * Whether the save must write into the existing file where it is. On
   * Windows, for any target not known to have exactly the list a new file
   * beside it gets: replacing that file would lose its list. Never on other
   * platforms, for a new destination, or on a volume without access lists.
   */
  keepsOwnList: boolean;
  /**
   * Whether a snapshot that replaces its target is written in a directory of
   * its own. On other platforms, where that directory is what keeps other
   * users out. On Windows it is written beside its target, where it gets the
   * folder's list as it is created.
   */
  needsPrivateDirectory: boolean;
  /** Why it could not be learned what the target has or what a new file gets, when that is why the file is kept. */
  unknown?: unknown;
  /**
   * Holds the target under its name, as while its list was read, until the
   * returned function is called: for the copy into it. It throws when the
   * target cannot be held, and does nothing where no list is kept.
   */
  holdTarget(): () => void;
}

/**
 * Reads the target's list, makes an empty file at `probePath` beside it,
 * reads the list that one got, and removes it. On other platforms nothing is
 * read or made.
 *
 * `assertStillTarget` throws when the file at the target's path is not the
 * one the save resolved. It runs once that path is held, so the list read
 * next is that file's.
 */
function read(
  existingTargetPath: string | undefined,
  fs: ProbeFileSystem,
  probePath: string,
  assertStillTarget: () => void,
  givenHost?: AccessListHost
): ReplacedFileAccessList {
  const windows = (givenHost?.platform ?? process.platform) === 'win32';
  // An existing file on Windows keeps its list until it is found below to be the one a new file gets.
  let keepsOwnList = windows && existingTargetPath !== undefined;
  let unknown: unknown;
  let host: AccessListHost | undefined;
  if (keepsOwnList) {
    const releases: Array<() => void> = [];
    let probe: number | undefined;
    // Whether the name the empty file was made under still leads to it.
    const probeIsThere = (): boolean => {
      const made = fs.fstatSync(probe!, { bigint: true });
      const there = fs.lstatSync(probePath, { bigint: true });
      return made.dev === there.dev && made.ino === there.ino;
    };
    try {
      host = givenHost ?? nodeAccessListHost();
      const reader = host;
      const listOf = (filePath: string): string => reader.withScratchFile(scratchPath => {
        const saved = reader.run('icacls', [forProgram(filePath), '/save', scratchPath]);
        if (saved.error || saved.status !== 0) throw new Error(`Reading the access list ended with code ${saved.status}`);
        // Two lines: the file's name, then its list.
        const found = reader.readSavedList(scratchPath).split(/\r?\n/)[1]?.trim();
        if (!found) throw new Error('The access list read was empty');
        return found;
      });
      releases.push(reader.hold(existingTargetPath!));
      assertStillTarget();
      const list = listOf(existingTargetPath!);
      // A volume without access lists reports this for every file. So does
      // an NTFS file with no list at all, which is left to take its folder's.
      if (list === NO_LIST) keepsOwnList = false;
      else {
        probe = fs.openSync(probePath, 'wx');
        releases.push(reader.hold(probePath));
        // What is held under that name is the file just made, not one put there since.
        keepsOwnList = !probeIsThere() || !sameAccessList(list, listOf(probePath));
      }
    } catch (error) {
      // Not known what the target has, or what the folder gives: it is written where it is.
      unknown = error;
    } finally {
      for (const release of releases.reverse()) {
        try {
          release();
        } catch {
          // A handle that does not close must not stop the save.
        }
      }
      if (probe !== undefined) {
        // Removed by its name, so only while that name leads to it.
        let there = false;
        try {
          there = probeIsThere();
        } catch {
          // Not known: it is left.
        }
        try {
          fs.closeSync(probe);
        } catch {
          // As above.
        }
        try {
          if (there) fs.rmSync(probePath, { force: true });
        } catch {
          // An empty leftover file must not stop the save.
        }
      }
    }
  }
  return {
    keepsOwnList,
    needsPrivateDirectory: !windows,
    unknown,
    holdTarget: () => (keepsOwnList ? (host ?? nodeAccessListHost()).hold(existingTargetPath!) : () => undefined)
  };
}

export const ReplacedFileAccessList = { read };
