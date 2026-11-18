/**
 * Making a file inside a directory without going through the directory's
 * name: through a descriptor of the directory where the system has a path
 * for one, and by a helper process that works from inside the directory
 * where it has none.
 */
type NodeFs = typeof import('node:fs');

/**
 * On Linux, where `othersCanRenameIn` answers for the destination's folder,
 * a snapshot is made, looked at, renamed and removed through a descriptor
 * of its directory (`/proc/self/fd/<n>/<name>`). A switch, so that tests
 * can run the route every other platform takes on Linux as well.
 */
export const stagedSnapshotAccess = { throughDescriptor: true };

/**
 * Whether a path through `/proc/self/fd/<n>` leads to what the descriptor is
 * open on: Linux with `/proc` mounted. Asked with a descriptor of the root
 * folder, before a save chooses its route.
 */
export function descriptorsReach(fs: NodeFs): boolean {
  if (process.platform !== 'linux' || !stagedSnapshotAccess.throughDescriptor) return false;
  let root: number | undefined;
  try {
    root = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    const opened = fs.fstatSync(root, { bigint: true });
    const entry = fs.statSync(`/proc/self/fd/${root}`, { bigint: true });
    return entry.dev === opened.dev && entry.ino === opened.ino;
  } catch {
    return false;
  } finally {
    if (root !== undefined) {
      try {
        fs.closeSync(root);
      } catch {
        // Nothing depends on it.
      }
    }
  }
}

// What the helper process runs. A process's working directory is the
// directory itself, not a name for it. Once inside, the helper checks that
// the directory is the one the save made (device, number, owner) and makes
// the file by a name relative to it. Its last five arguments are the
// directory, the three numbers and the file's name. It ends with 3 when the
// directory is not the one made, and prints the new file's device and number.
// The web build starts no process and leaves the script out of its bundle.
const MAKE_FILE_INSIDE = import.meta.env?.VSCODE_BROWSER_EXT ? '' : [
  "const fs=require('fs');const a=process.argv.slice(-5);",
  // Not the directory made, or none under that name: 3.
  "try{process.chdir(a[0]);const d=fs.statSync('.',{bigint:true});",
  "if(!d.isDirectory()||String(d.dev)!==a[1]||String(d.ino)!==a[2]||String(d.uid)!==a[3])process.exit(3);}",
  "catch(e){process.exit(e&&['ENOENT','ENOTDIR','EACCES','ELOOP'].includes(e.code)?3:4);}",
  // In it. A removed directory has no room for a new name: 3. Anything else is said as it is.
  "try{const c=fs.constants;const f=fs.fstatSync(fs.openSync(a[4],c.O_RDWR|c.O_CREAT|c.O_EXCL|c.O_NOFOLLOW,0o600),{bigint:true});",
  "process.stdout.write(f.dev+':'+f.ino);}",
  "catch(e){process.stderr.write(String(e&&e.message||e));process.exit(e&&e.code==='ENOENT'?3:4);}"
].join('');

/**
 * Where no path through a descriptor is to be had (macOS, Linux without
 * `/proc`): has a child of this runtime make an empty owner-only file named
 * `name` inside `directory`, from inside it. Answers the file's device and
 * number, by which the save then tells the file it opens by name, or
 * `undefined` when the directory under that name is not the one made.
 */
export function makeFileInside(directory: string, made: { dev: bigint; ino: bigint; uid: bigint }, name: string): { dev: bigint; ino: bigint } | undefined {
  const { spawnSync } = require('child_process') as typeof import('child_process');
  // The editor's own program runs as plain Node when told to, as it does for its extension host.
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_OPTIONS;
  const result = spawnSync(
    process.execPath,
    ['-e', MAKE_FILE_INSIDE, '--', directory, String(made.dev), String(made.ino), String(made.uid), name],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }
  );
  if (!result.error && result.status === 3) return undefined;
  const answer = /^(-?\d+):(-?\d+)$/.exec(result.stdout ?? '');
  if (result.error || result.status !== 0 || !answer) {
    const why = result.error?.message ?? (result.stderr?.trim() || `it ended with code ${result.status}`);
    throw new Error(`The save could not make its file beside the destination: the helper process failed (${why}). The file was not changed.`, { cause: result.error });
  }
  return { dev: BigInt(answer[1]), ino: BigInt(answer[2]) };
}
