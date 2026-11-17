/**
 * Access-control entries on macOS and Linux, for a save that replaces a file.
 *
 * A save writes a new file and renames it over the old one. Before the
 * rename the new file is given the entries of the file it replaces.
 *
 * Node has no call that reads or sets these entries, so the system's own
 * programs are started, and handed descriptors wherever they take one:
 * - Linux: `getfacl` and `setfacl` read and set through `/proc/self/fd/3`,
 *   the descriptor passed to the program. Both the old file and the new one
 *   are reached that way.
 * - macOS: the system Ruby reads and sets the stored list itself through
 *   descriptors, with the system's own calls (`macStoredListTools`). Every
 *   stored entry is carried over as it is.
 * - macOS where that gives no answer: `ls` and `chmod`, and the save's log
 *   says so. `chmod` sets through `/dev/fd/3`. `ls` shows no entries for
 *   such a path, so it reads the old file by its name; `keepAccessEntries`
 *   says what is copied then.
 *
 * Windows keeps a file's list another way (`windowsAccessList.ts`).
 */
import type { SpawnSyncReturns } from 'child_process';

/** A file as the programs are given it: a descriptor of it, and its name. */
export interface AccessEntryFile {
  fd: number;
  path: string;
}

/** The programs that read and set entries on one platform. */
export interface AccessEntryTools {
  /** Whether `read` goes through the descriptors, and not through the names. */
  readsByDescriptor: boolean;
  /**
   * The entries of each file, in the order the system applies them, one list
   * per file. On Linux every line `getfacl` prints, the three a mode stands
   * for included; on macOS the entries a mode does not carry. Undefined when
   * there is no answer: no such program, an error, or text this cannot read.
   */
  read(files: readonly AccessEntryFile[]): string[][] | undefined;
  /** Replaces the entries of the file open at `fd` by these, and says whether the program accepted them. */
  write(fd: number, entries: readonly string[]): boolean;
}

// The calls block their thread. The programs answer in milliseconds, so this
// only bounds one that hangs.
const TIMEOUT_MS = 5_000;

function run(program: string, args: string[], descriptors: number[], input?: string): SpawnSyncReturns<string> {
  // Required here, not imported: this module is also bundled for VS Code Web,
  // where there is no such module and this is never reached.
  const { spawnSync } = require('child_process') as typeof import('child_process');
  return spawnSync(program, args, {
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore', ...descriptors],
    input,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    // The programs' own words are not read, only their structure, but dates and names are kept plain.
    env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' }
  });
}

/** Whether the program ran to its end and answered success. */
const answered = (result: SpawnSyncReturns<string>): boolean => !result.error && result.status === 0;

// The web build starts no programs: both sets are left out of its bundle.
const linuxTools: AccessEntryTools | null = import.meta.env?.VSCODE_BROWSER_EXT ? null : {
  readsByDescriptor: true,
  read(files) {
    for (const program of ['/usr/bin/getfacl', '/bin/getfacl']) {
      // -c: no header with the file's name; -p: no word about the leading
      // slash; -n: ids as numbers; -E: no note of what a mask leaves of an entry.
      const result = run(program, ['-c', '-p', '-n', '-E', '--', ...files.map((_, index) => `/proc/self/fd/${index + 3}`)], files.map(file => file.fd));
      // The next place is tried only when the program is not at this one: one that hangs is waited for once.
      if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue;
      if (!answered(result)) return undefined;
      // One block of lines for each file, a blank line after each.
      const blocks = result.stdout.split('\n\n').map(block => block.split('\n').filter(line => line !== '')).filter(block => block.length > 0);
      const known = blocks.every(block => block.length >= 3 && block.every(line => /^(user|group|mask|other):[0-9]*:[r-][w-][x-]$/.test(line)));
      return known && blocks.length === files.length ? blocks : undefined;
    }
    return undefined;
  },
  write(fd, entries) {
    for (const program of ['/usr/bin/setfacl', '/bin/setfacl']) {
      const result = run(program, ['--set-file=-', '/proc/self/fd/3'], [fd], `${entries.join('\n')}\n`);
      if ((result.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') return answered(result);
    }
    return false;
  }
};

const macTools: AccessEntryTools | null = import.meta.env?.VSCODE_BROWSER_EXT ? null : {
  readsByDescriptor: false,
  read(files) {
    // -d: the folder itself, not what is in it; -e: its entries; -q: a name
    // is printed on one line, so a name with a newline in it cannot pass for
    // an entry; -f: in the order given.
    const result = run('/bin/ls', ['-ldeqf', '--', ...files.map(file => file.path)], []);
    if (!answered(result)) return undefined;
    const blocks: string[][] = [];
    for (const line of result.stdout.split('\n')) {
      if (line === '') continue;
      const entry = /^ \d+: (.+)$/.exec(line);
      if (entry) {
        if (blocks.length === 0) return undefined;
        // Whether an entry came from the folder or was put on the file does
        // not change whom it lets in, so that word is left out. It stays on
        // an entry whose rights are not printed (`rightsUnread`): two of
        // those are only taken for the same when both were handed down.
        blocks[blocks.length - 1].push(rightsUnread(entry[1]) ? entry[1].trimEnd() : entry[1].replace(/ inherited (allow|deny) /, ' $1 '));
      } else if (/^[-dlbcps][-rwxsStT]{9}/.test(line)) {
        blocks.push([]);
      } else {
        return undefined;
      }
    }
    return blocks.length === files.length ? blocks : undefined;
  },
  write(fd, entries) {
    // -E takes the whole list from its input and does not take an empty one; -N removes every entry.
    const set = (): boolean => answered(entries.length === 0
      ? run('/bin/chmod', ['-N', '/dev/fd/3'], [fd])
      : run('/bin/chmod', ['-E', '/dev/fd/3'], [fd], `${entries.join('\n')}\n`));
    // Asked up to three times. While other processes make and remove files,
    // macOS now and then does not find `/dev/fd/3` for a program that was
    // handed that descriptor (measured on macOS 27.2 with three processes
    // saving at once: 16 of 36,000 `chmod` calls, none of 12,000 alone; the
    // descriptor is open, and the same call made again found it every
    // time). A list the program does not take is refused each time.
    return set() || set() || set();
  }
};

// The words `ls` prints after "allow" or "deny" that are not rights: how an entry is handed down.
const HANDING_DOWN = new Set(['file_inherit', 'directory_inherit', 'limit_inherit', 'only_inherit']);

/**
 * macOS: an entry's kind and the words after it, read from the end, because
 * a name can hold either word, and spaces. No word after the kind is an
 * entry printed without one, not a right of that name.
 */
function kindAndWords(entry: string): { kind: string; words: string[] } | undefined {
  const bare = / (allow|deny) *$/.exec(entry);
  if (bare) return { kind: bare[1], words: [] };
  const full = / (allow|deny) ([^ ]+)$/.exec(entry);
  return full ? { kind: full[1], words: full[2].split(',') } : undefined;
}

/**
 * macOS: whether `ls` printed no right for this entry. `chmod` has no word
 * for such rights either, so it cannot write the entry back ("No
 * permissions specified").
 */
function rightsUnread(entry: string): boolean {
  const read = kindAndWords(entry);
  return !read || read.words.every(word => HANDING_DOWN.has(word));
}

// macOS: reads and sets a file's stored list itself, through descriptors,
// with the system's own calls (`acl_get_fd_np`, `acl_set_fd_np`). The system
// Ruby has a library that makes such calls (Fiddle). Each entry is read and
// written as its 24 stored bytes: the id it names, its kind and flags, its
// rights. A list's own flags go first when it has any.
const STORED_LIST = import.meta.env?.VSCODE_BROWSER_EXT ? '' : [
  "require 'fiddle'",
  'c = Fiddle.dlopen(nil)',
  'I, P, L = Fiddle::TYPE_INT, Fiddle::TYPE_VOIDP, Fiddle::TYPE_SSIZE_T',
  "get = Fiddle::Function.new(c['acl_get_fd_np'], [I, I], P)",
  "set = Fiddle::Function.new(c['acl_set_fd_np'], [I, P, I], I)",
  "size = Fiddle::Function.new(c['acl_size'], [P], L)",
  "ext = Fiddle::Function.new(c['acl_copy_ext_native'], [P, P, L], L)",
  "int = Fiddle::Function.new(c['acl_copy_int_native'], [P], P)",
  "init = Fiddle::Function.new(c['acl_init'], [I], P)",
  'MAGIC = 0x012cc16d',
  "if ARGV[0] == 'read'",
  '  ARGV[1].to_i.times do |i|',
  '    acl = get.call(3 + i, 0x100)',
  '    if acl.null?',
  // No list is ENOENT, also on a volume that keeps none. Anything else is no answer.
  '      exit 1 unless Fiddle.last_error == 2',
  "      puts '-'",
  '      next',
  '    end',
  '    n = size.call(acl)',
  '    exit 1 if n < 44',
  '    b = Fiddle::Pointer.malloc(n)',
  '    w = ext.call(b, acl, n)',
  '    exit 1 if w < 44',
  '    raw = b[0, w]',
  "    count, flags = raw[36, 4].unpack1('V'), raw[40, 4].unpack1('V')",
  // The layout this reads: a tag, two unused ids, the count, the list's flags, the entries.
  "    exit 1 unless raw[0, 4].unpack1('V') == MAGIC && w == 44 + 24 * count && raw[4, 32] == \"\\0\" * 32",
  '    words = []',
  "    words << format('flags:%08x', flags) unless flags.zero?",
  "    count.times { |k| words << raw[44 + 24 * k, 24].unpack1('H*') }",
  "    puts(words.empty? ? '-' : words.join(' '))",
  '  end',
  'else',
  '  flags = 0',
  '  entries = []',
  '  STDIN.read.split("\\n").each do |line|',
  '    next if line.empty?',
  '    if line =~ /\\Aflags:([0-9a-f]{8})\\z/ then flags = $1.to_i(16)',
  "    elsif line =~ /\\A[0-9a-f]{48}\\z/ then entries << [line].pack('H*')",
  '    else exit 1',
  '    end',
  '  end',
  // A list with nothing in it reads back as no list (measured).
  '  acl = if entries.empty? && flags.zero?',
  '    init.call(0)',
  '  else',
  "    int.call(Fiddle::Pointer[[MAGIC].pack('V') + \"\\0\" * 32 + [entries.length, flags].pack('VV') + entries.join])",
  '  end',
  '  exit 1 if acl.null?',
  '  exit(set.call(3, acl, 0x100).zero? ? 0 : 1)',
  'end'
].join('\n');

export const macStoredListTools: AccessEntryTools | null = import.meta.env?.VSCODE_BROWSER_EXT ? null : {
  readsByDescriptor: true,
  read(files) {
    // No gems: the script needs none, and loading them takes most of the start.
    const result = run('/usr/bin/ruby', ['--disable=gems', '-e', STORED_LIST, 'read', String(files.length)], files.map(file => file.fd));
    if (!answered(result)) return undefined;
    const lines = result.stdout.split('\n').filter(line => line !== '');
    if (lines.length !== files.length) return undefined;
    const lists = lines.map(line => (line === '-' ? [] : line.split(' ')));
    return lists.every(list => list.every(entry => /^(flags:[0-9a-f]{8}|[0-9a-f]{48})$/.test(entry))) ? lists : undefined;
  },
  write(fd, entries) {
    return answered(run('/usr/bin/ruby', ['--disable=gems', '-e', STORED_LIST, 'write'], [fd], `${entries.join('\n')}\n`));
  }
};

/**
 * Switches for tests. `use`: the programs a save uses; `undefined` is this
 * platform's own, `null` none (nothing is read or set, as on Windows).
 * `storedLists`: `false` keeps macOS to `ls` and `chmod`, as where there is
 * no Ruby.
 */
export const accessEntryTools: { use: AccessEntryTools | null | undefined; storedLists?: boolean } = { use: undefined };

/** The programs that list a folder's entries: by name, since a folder is not opened for this. */
function folderTools(): AccessEntryTools | null {
  if (accessEntryTools.use !== undefined) return accessEntryTools.use;
  return process.platform === 'linux' ? linuxTools : process.platform === 'darwin' ? macTools : null;
}

/**
 * The programs that carry a file's entries over, in the order they are
 * tried. On macOS the stored list is copied through descriptors first, and
 * `ls` and `chmod` only when that gives no answer.
 */
function fileTools(): Array<AccessEntryTools | null> {
  if (accessEntryTools.use !== undefined) return [accessEntryTools.use];
  if (process.platform === 'linux') return [linuxTools];
  if (process.platform !== 'darwin') return [];
  return accessEntryTools.storedLists === false ? [macTools] : [macStoredListTools, macTools];
}

const same = (left: readonly string[] | undefined, right: readonly string[]): boolean =>
  left !== undefined && left.length === right.length && left.every((entry, index) => entry === right[index]);

// What lets an account add, remove or rename what is in a folder, remove the
// folder, or give itself any of that.
const CHANGES_A_FOLDER = new Set(['add_file', 'add_subdirectory', 'delete_child', 'delete', 'write', 'append', 'writesecurity', 'chown']);

/**
 * macOS: the folders among these that an entry lets an account change, or
 * `undefined` when that cannot be told. An entry leaves a folder's mode as
 * it is, so the mode does not show it. Which account an entry names is not
 * worked out: any entry that allows such a right counts. An entry that
 * refuses, or allows reading only, does not count: macOS itself puts
 * "everyone deny delete" on home folders.
 */
export function foldersOthersMayChange(folders: readonly string[]): string[] | undefined {
  const tools = folderTools();
  if (!tools || folders.length === 0) return [];
  // Folders are listed by their names: they are not opened for this.
  const read = tools.readsByDescriptor ? undefined : tools.read(folders.map(folder => ({ fd: -1, path: folder })));
  return read?.flatMap((entries, index) => (entries.some(entry => {
    const rights = kindAndWords(entry);
    // An entry this does not read counts, and so does one that allows
    // rights `ls` does not print.
    if (!rights) return true;
    return rights.kind === 'allow' && (rightsUnread(entry) || rights.words.some(right => CHANGES_A_FOLDER.has(right)));
  }) ? [folders[index]] : []));
}

/** Whether what `getfacl -c -p -n -E` printed for one folder is the three entries a mode stands for and nothing else. */
export function plainEntriesOnly(printed: string): boolean {
  const lines = printed.split('\n').filter(line => line !== '');
  return lines.length === 3 && lines.every(line => /^(user|group|other)::[r-][w-][x-]$/.test(line));
}

/**
 * Linux: whether the folder has no access-control entries beyond the three
 * its mode stands for. With more, the group bits of the mode are the
 * entries' mask, not what the owning group may do. No answer counts as more.
 */
export function folderHasOnlyItsMode(folder: string): boolean {
  try {
    for (const program of ['/usr/bin/getfacl', '/bin/getfacl']) {
      const answer = run(program, ['-c', '-p', '-n', '-E', '--', folder], []);
      // The next place is tried only when the program is not at this one: one that hangs is waited for once.
      if ((answer.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue;
      return answered(answer) && plainEntriesOnly(answer.stdout);
    }
  } catch {
    // Counts as more.
  }
  return false;
}

type EntryFs = Pick<typeof import('fs'), 'openSync' | 'closeSync' | 'fstatSync' | 'constants'>;

const STORED_LIST_UNREAD = "The database's access-control entries could not be read as they are stored, so this save goes by what `ls` shows of them.";

/**
 * Gives the snapshot that is about to replace `target` the entries `target`
 * has, when the two differ. Call it before anything remembers the
 * snapshot's change time. For a snapshot in the destination's own folder
 * (the paged save's copy), call it once the snapshot has the old file's
 * owner and group and before its mode is made wider than owner-only. A
 * snapshot in a directory only this account can enter can have its mode
 * first.
 *
 * - No answer about the entries (Linux without the programs, a file that
 *   cannot be opened, text this does not read): the save goes on as it
 *   always did and `warn` says so. The new file then has what its folder
 *   hands down.
 * - macOS, no answer about the stored list: the save goes by `ls` and
 *   `chmod`, and `warn` says so, each time.
 * - The old file's entries were read by name (macOS with `ls`) and
 *   `readCanBeForged` answers true: they are not copied. The new file is left with the old
 *   file's entries that refuse, and none that allows; `warn` says so when
 *   that drops an entry the old file had. The same is done when the program
 *   does not take the old file's entries back.
 * - An entry `ls` and `chmod` cannot write back is left out, and `warn`
 *   says so: one for an id the system cannot name (printed bare, as for a
 *   deleted account), and one whose rights `ls` does not print
 *   (`rightsUnread`). Such an entry on the new file alone, handed down by
 *   its folder, is removed with the rest.
 * - The new file does not end up with what was asked: the save fails.
 */
export function keepAccessEntries(
  fs: EntryFs,
  target: { path: string; dev: bigint; ino: bigint },
  snapshot: AccessEntryFile,
  readCanBeForged: () => boolean,
  warn: (message: string, error?: unknown) => void
): void {
  let unseen: { cause?: unknown } | undefined;
  for (const tools of fileTools()) {
    if (!tools) return;
    // The programs before these gave no answer. Said for every such save: what the next ones read is not the stored list.
    if (unseen) warn(STORED_LIST_UNREAD, unseen.cause);
    unseen = keepWith(tools, fs, target, snapshot, readCanBeForged, warn);
    if (!unseen) return;
  }
  if (unseen) {
    warn('The access-control entries of the database could not be looked at, so its new file has what its folder gives.', unseen.cause);
  }
}

/** One set of programs' turn. Answers nothing when the entries are settled, and why not when it could not look at them. */
function keepWith(
  tools: AccessEntryTools,
  fs: EntryFs,
  target: { path: string; dev: bigint; ino: bigint },
  snapshot: AccessEntryFile,
  readCanBeForged: () => boolean,
  warn: (message: string, error?: unknown) => void
): { cause?: unknown } | undefined {
  let targetFd = -1;
  try {
    if (tools.readsByDescriptor) {
      try {
        // Not followed, and not waited for: only a regular file is the target.
        targetFd = fs.openSync(target.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      } catch (cause) {
        return { cause };
      }
      const opened = fs.fstatSync(targetFd, { bigint: true });
      if (opened.dev !== target.dev || opened.ino !== target.ino) {
        throw new Error('Database save target changed during the save; retry.');
      }
    }
    const read = tools.read([{ fd: targetFd, path: target.path }, snapshot]);
    if (!read) return {};
    const [old, fresh] = read;
    if (same(old, fresh)) return undefined;
    // Linux lists the three entries a mode stands for with the rest. Where
    // neither file has more than those, the mode says it all, and the mode
    // is the caller's to set: nothing is set here, also before it is.
    const beyondMode = (entries: readonly string[]): boolean => entries.some(entry => !/^(user|group|other)::/.test(entry));
    if (tools.readsByDescriptor && !beyondMode(old) && !beyondMode(fresh)) return undefined;
    const given = (entries: readonly string[]): boolean =>
      tools.write(snapshot.fd, entries) && same(tools.read([snapshot])?.[0], entries);
    if (!tools.readsByDescriptor) {
      // One whose kind cannot be read is taken for one that refuses.
      const refuses = (entry: string): boolean => kindAndWords(entry)?.kind !== 'allow';
      // What `chmod -E` can be given back: an entry for an id this Mac can
      // name, with rights `ls` printed. An id it cannot name is printed
      // bare, and rights it does not print cannot be written
      // (`rightsUnread`). Such an entry is left out, or every save of its
      // file would fail.
      const settable = old.filter(entry => /^(user|group):/.test(entry) && !rightsUnread(entry));
      // What is left when entries cannot be copied: the old file's entries
      // that refuse, and none that allows. An entry only the new file has
      // is its folder's, not the old file's: one that refuses this account
      // the file's removal would stop the save's own rename.
      const refusing = settable.filter(refuses);
      const kept = (entries: readonly string[]): boolean => {
        if (!given(entries)) return false;
        const dropped = old.filter(entry => !entries.includes(entry));
        if (dropped.some(entry => !refuses(entry))) {
          warn("Access-control entries that let accounts in were not kept on the database's new file.");
        }
        if (dropped.some(refuses)) {
          warn("An access-control entry that refuses was not kept on the database's new file: this Mac's programs cannot write its id or its rights back.");
        }
        return true;
      };
      // Copied, or narrowed where `readCanBeForged` says so or the program
      // did not take the entries that allow.
      if (readCanBeForged() ? kept(refusing) : kept(settable) || (refusing.length !== settable.length && kept(refusing))) return undefined;
    } else if (given(old)) {
      return undefined;
    }
    throw new Error("The database's new file could not be given the access-control entries of the one it replaces. The file was not changed.");
  } finally {
    if (targetFd !== -1) {
      try {
        fs.closeSync(targetFd);
      } catch {
        // A descriptor that does not close must not fail a save that is otherwise done.
      }
    }
  }
}
