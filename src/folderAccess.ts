/**
 * Whether another account can rename what is in a folder: by the folder's
 * owner and mode, and by what the system's files and programs say about its
 * group and its access-control entries. A save chooses its route by the
 * answer (`atomicDatabaseWrite.ts`).
 */
import path from 'path';

import { folderHasOnlyItsMode, foldersOthersMayChange } from './posixAccessEntries';

type NodeFs = typeof import('node:fs');

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

/**
 * Whether `/etc/nsswitch.conf` names only sources of accounts and groups
 * that the local files answer for: the files themselves (`files`, `compat`)
 * and systemd's own, which hand out ids of their own and none of an account
 * in the files. Any other source (`sss`, `ldap`, `nis`, `winbind`, a second
 * set of files) can put another account into a group these files show as
 * one account's alone. No such file means the C library reads the files only.
 */
function accountsComeFromFilesOnly(fs: NodeFs): boolean {
  let text: string;
  try {
    text = fs.readFileSync('/etc/nsswitch.conf', 'utf8');
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  }
  for (const line of text.split('\n')) {
    const [database, sources] = line.split('#')[0].split(':');
    // `initgroups` names where an account's further groups come from, when it is there.
    if (sources === undefined || !['passwd', 'group', 'initgroups'].includes(database.trim())) continue;
    // What follows a source in brackets says what to do with its answer, and names no source.
    const named = sources.replace(/\[[^\]]*\]/g, ' ').split(/\s+/).filter(source => source !== '');
    if (named.some(source => !['files', 'compat', 'systemd', 'mymachines'].includes(source))) return false;
  }
  return true;
}

/**
 * Whether the group `gid` is this account's alone, by the system's own files
 * (Linux): it has the account's id, as the group made for each account does,
 * `/etc/passwd` has no other account with it as primary group, and
 * `/etc/group` lists no other member. Where new folders are group-writable
 * by default (umask 002), that group is why. A group those files do not
 * show, such as one from a directory service, is not known to be anyone's
 * alone, and neither is the group of an account they do not list.
 */
function isOwnGroup(fs: NodeFs, gid: bigint, me: bigint, platform: string): boolean {
  if (platform !== 'linux' || gid !== me) return false;
  try {
    // As the C library reads these files: lines that begin with `#` are
    // comments, and an id is a number however it is written.
    const entries = (file: string): string[][] => fs.readFileSync(file, 'utf8').split('\n')
      .map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#')).map(line => line.split(':'));
    const id = (text: string | undefined): bigint | undefined => (/^\+?\d+$/.test((text ?? '').trim()) ? BigInt((text ?? '').trim()) : undefined);
    const accounts = entries('/etc/passwd');
    const groups = entries('/etc/group');
    // A line that brings in another source of accounts (NIS): the files do not say everything.
    if ([...accounts, ...groups].some(([name]) => name.startsWith('+') || name.startsWith('-'))) return false;
    // Neither do they where the system asks a directory service as well.
    if (!accountsComeFromFilesOnly(fs)) return false;
    const mine = new Set<string>();
    for (const [name, , uid, primary] of accounts) {
      if (id(uid) === me) mine.add(name);
      else if (id(primary) === gid) return false;
    }
    let listed = false;
    for (const [, , group, members] of groups) {
      if (id(group) !== gid) continue;
      listed = true;
      if ((members ?? '').split(',').some(member => member.trim() !== '' && !mine.has(member.trim()))) return false;
    }
    // An account these files do not list comes from somewhere they say nothing about.
    return listed && mine.size > 0;
  } catch {
    return false;
  }
}

/**
 * Whether the folder has nothing but its mode: on Linux no access-control
 * entries beyond the three a mode stands for (`getfacl` is asked, since Node
 * cannot read them), on macOS no entry that lets an account change the
 * folder (`ls` is asked). No answer counts as more.
 */
export function hasOnlyItsMode(folder: string): boolean {
  return process.platform === 'darwin' ? foldersOthersMayChange([folder])?.length === 0 : folderHasOnlyItsMode(folder);
}

/**
 * The first folder, from `directory` up, in which an account other than this
 * one and root can rename entries: a folder's owner can, and so can everyone
 * it lets write, unless it is sticky. Undefined when there is none.
 *
 * On Linux a group that is this account's alone (`isOwnGroup`) is not
 * someone else, provided the folder has nothing but its mode (`onlyItsMode`,
 * by default what `getfacl` answers). On macOS every folder on the way must
 * have nothing but its mode. Pass `false` to go by owners and modes alone,
 * every group counted, which costs no program start.
 */
export function othersCanRenameIn(
  fs: NodeFs,
  directory: string,
  platform: string = process.platform,
  onlyItsMode: false | ((folder: string) => boolean) = hasOnlyItsMode
): string | undefined {
  const me = BigInt(process.geteuid!());
  const own = new Map<bigint, boolean>();
  const groupIsOthers = (gid: bigint, folder: string): boolean => {
    if (onlyItsMode === false) return true;
    if (!own.has(gid)) own.set(gid, isOwnGroup(fs, gid, me, platform));
    // Asked last, and only for a folder the rest of the rule would let pass.
    return !own.get(gid) || !onlyItsMode(folder);
  };
  const chain: string[] = [];
  for (let at = directory, up = path.dirname(at); ; at = up, up = path.dirname(at)) {
    const { uid, gid, mode } = fs.statSync(at, { bigint: true });
    const othersWrite = (mode & 0o2n) !== 0n || ((mode & 0o20n) !== 0n && groupIsOthers(gid, at));
    if ((uid !== me && uid !== 0n) || (othersWrite && (mode & 0o1000n) === 0n)) return at;
    chain.push(at);
    if (up === at) break;
  }
  // macOS: an entry on a folder can let another account add and remove what
  // is in it, and the folder's mode says nothing of it.
  if (platform !== 'darwin' || onlyItsMode === false) return undefined;
  if (onlyItsMode !== hasOnlyItsMode) return chain.find(folder => !onlyItsMode(folder));
  // One program start for all of them.
  const changeable = foldersOthersMayChange(chain);
  return changeable === undefined ? chain[0] : changeable[0];
}
