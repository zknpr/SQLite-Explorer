import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Real access-control entries for tests, set and listed with the system's own programs: `chmod` and
 * `ls` on macOS, `setfacl` and `getfacl` on Linux.
 */
const mac = process.platform === 'darwin';

/** Why tests with real entries cannot run here, or false when they can. */
export const NO_REAL_ENTRIES: string | false = mac || (process.platform === 'linux' && ['/usr/bin/getfacl', '/usr/bin/setfacl'].every((tool) => fs.existsSync(tool)))
  ? false
  : 'needs macOS, or Linux with getfacl and setfacl';

/** An account other than the one the tests run as, by a name or number the system knows. */
export const OTHER_ACCOUNT = mac ? 'nobody' : '65534';

/** Gives `file` an entry of its own that lets that account read it. */
export function shareWithOther(file: string): void {
  if (mac) execFileSync('/bin/chmod', ['+a', `user:${OTHER_ACCOUNT} allow read`, file]);
  else execFileSync('/usr/bin/setfacl', ['-m', `u:${OTHER_ACCOUNT}:r--`, file]);
}

/** Makes `folder` hand an entry for that account down to what is made in it, folders included. */
export function handDownToOther(folder: string): void {
  if (mac) execFileSync('/bin/chmod', ['+a', `user:${OTHER_ACCOUNT} allow read,list,search,file_inherit,directory_inherit`, folder]);
  else execFileSync('/usr/bin/setfacl', ['-d', '-m', `u:${OTHER_ACCOUNT}:r-x`, folder]);
}

/** The entries of `file` that name that account, as the system lists them, without where they came from. */
export function entriesForOther(file: string): string[] {
  const listing = mac
    ? execFileSync('/bin/ls', ['-lde', file], { encoding: 'utf8' }).split('\n').slice(1)
    : execFileSync('/usr/bin/getfacl', ['-c', '-p', '-n', '-E', file], { encoding: 'utf8' }).split('\n');
  return listing.map((line) => line.replace(/^ \d+: /, '').replace(' inherited ', ' ')).filter((line) => line.includes(OTHER_ACCOUNT));
}

/** Removes every entry under `directory` on macOS, where one that refuses could keep a test's folder from being removed. */
export function clearEntries(directory: string): void {
  if (!mac) return;
  try {
    execFileSync('/bin/chmod', ['-R', '-N', directory]);
  } catch {
    // Entries that stay do not keep a folder from being removed by its owner.
  }
}
