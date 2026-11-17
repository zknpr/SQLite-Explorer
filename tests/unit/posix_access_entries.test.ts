import assert from 'node:assert';
import childProcess, { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { othersCanRenameIn, writeDatabaseSnapshotAtomically } from '../../src/atomicDatabaseWrite';
import { clearEntries, entriesForOther as sharedWith, handDownToOther as handDown, NO_REAL_ENTRIES, OTHER_ACCOUNT as other, shareWithOther as share } from './helpers/access-entries';
import { accessEntryTools, folderHasOnlyItsMode, foldersOthersMayChange, keepAccessEntries, macStoredListTools, plainEntriesOnly, type AccessEntryFile, type AccessEntryTools } from '../../src/posixAccessEntries';

async function withScratchDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = fs.realpathSync(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sqlite-explorer-access-entries-')));
  try {
    await run(directory);
  } finally {
    clearEntries(directory);
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

// What a save uses is put back after each test: the other test files in this process's place run in their own.
let before: AccessEntryTools | null | undefined;
beforeEach(() => { before = accessEntryTools.use; });
afterEach(() => { accessEntryTools.use = before; accessEntryTools.storedLists = undefined; });

describe('the access-control entries of a file that a save replaces, with the programs modelled', () => {
  /** Programs that answer from, and write to, a table of entries by path. */
  const model = (
    entries: Record<string, string[] | undefined>,
    options: { byDescriptor: boolean; refuse?: (entries: readonly string[]) => boolean; pathOf?: (fd: number) => string }
  ): AccessEntryTools & { written: string[][]; reads: string[][] } => {
    const written: string[][] = [];
    const reads: string[][] = [];
    return {
      written,
      reads,
      readsByDescriptor: options.byDescriptor,
      read(files) {
        reads.push(files.map((file) => file.path));
        const answer = files.map((file) => entries[file.path]);
        return answer.every((list) => list !== undefined) ? (answer as string[][]).map((list) => [...list]) : undefined;
      },
      write(fd, given) {
        written.push([...given]);
        if (options.refuse?.(given)) return false;
        entries[options.pathOf?.(fd) ?? 'snapshot'] = [...given];
        return true;
      }
    };
  };
  /** A target and a snapshot as real files, so that the target can be opened and compared. */
  const files = async (directory: string): Promise<{ target: { path: string; dev: bigint; ino: bigint }; snapshot: AccessEntryFile; close: () => void }> => {
    const targetPath = path.join(directory, 'database.db');
    const snapshotPath = path.join(directory, 'snapshot.db');
    await fs.promises.writeFile(targetPath, 'old');
    await fs.promises.writeFile(snapshotPath, 'new');
    const fd = fs.openSync(snapshotPath, 'r+');
    const stats = fs.statSync(targetPath, { bigint: true });
    return { target: { path: targetPath, dev: stats.dev, ino: stats.ino }, snapshot: { fd, path: 'snapshot' }, close: () => fs.closeSync(fd) };
  };
  const keep = (
    tools: AccessEntryTools,
    given: { target: { path: string; dev: bigint; ino: bigint }; snapshot: AccessEntryFile },
    forged = false
  ): string[] => {
    accessEntryTools.use = tools;
    const log: string[] = [];
    keepAccessEntries(fs, given.target, given.snapshot, () => forged, (message) => { log.push(message); });
    return log;
  };
  const unseen = 'The access-control entries of the database could not be looked at, so its new file has what its folder gives.';
  const notKept = "Access-control entries that let accounts in were not kept on the database's new file.";
  const lost = notKept;
  const refusalLost = "An access-control entry that refuses was not kept on the database's new file: this Mac's programs cannot write its id or its rights back.";

  for (const byDescriptor of [true, false]) {
    const how = byDescriptor ? 'read through descriptors' : 'read by name';

    it(`sets nothing when the new file has what the old one has (${how})`, async () => {
      await withScratchDirectory(async (directory) => {
        const given = await files(directory);
        const tools = model({ [given.target.path]: ['a', 'b'], snapshot: ['a', 'b'] }, { byDescriptor });
        assert.deepStrictEqual(keep(tools, given, true), []);
        assert.deepStrictEqual(tools.written, []);
        // One look at both.
        assert.deepStrictEqual(tools.reads, [[given.target.path, 'snapshot']]);
        given.close();
      });
    });

    it(`removes what the folder handed the new file when the old one has none (${how})`, async () => {
      await withScratchDirectory(async (directory) => {
        const given = await files(directory);
        const entries: Record<string, string[]> = { [given.target.path]: [], snapshot: ['everyone allow read'] };
        const tools = model(entries, { byDescriptor });
        // Removing is done wherever the old file's entries were read from: it can only narrow.
        assert.deepStrictEqual(keep(tools, given, true), []);
        assert.deepStrictEqual(tools.written, [[]]);
        assert.deepStrictEqual(entries.snapshot, []);
        given.close();
      });
    });

    it(`says so, and saves, when there is no answer about the entries (${how})`, async () => {
      await withScratchDirectory(async (directory) => {
        const given = await files(directory);
        const tools = model({ [given.target.path]: undefined, snapshot: [] }, { byDescriptor });
        assert.deepStrictEqual(keep(tools, given), [unseen]);
        assert.deepStrictEqual(tools.written, []);
        given.close();
      });
    });

    it(`fails the save when the new file does not end up with what was asked (${how})`, async () => {
      await withScratchDirectory(async (directory) => {
        const given = await files(directory);
        for (const refuse of [() => true, undefined]) {
          const entries: Record<string, string[]> = { [given.target.path]: [], snapshot: ['everyone allow read'] };
          const tools = model(entries, { byDescriptor, refuse });
          // Accepted by the program, and not there afterwards: what is read back decides.
          if (!refuse) tools.write = (_fd, wanted) => { tools.written.push([...wanted]); return true; };
          assert.throws(() => keep(tools, given), /could not be given the access-control entries of the one it replaces/);
        }
        given.close();
      });
    });
  }

  it('gives the new file the old one\'s entries, in their order, when both are reached through descriptors', async () => {
    await withScratchDirectory(async (directory) => {
      const given = await files(directory);
      const entries: Record<string, string[]> = { [given.target.path]: ['user::rw-', 'user:1001:r--', 'group::---', 'mask::r--', 'other::---'], snapshot: ['user::rw-', 'group::---', 'other::---'] };
      const tools = model(entries, { byDescriptor: true });
      // A descriptor is the file, whatever `readCanBeForged` answers.
      assert.deepStrictEqual(keep(tools, given, true), []);
      assert.deepStrictEqual(tools.written, [entries[given.target.path]]);
      assert.deepStrictEqual(entries.snapshot, entries[given.target.path]);
      given.close();
    });
  });

  it('sets nothing where neither file has more than its mode stands for, whatever the modes are (Linux listing)', async () => {
    await withScratchDirectory(async (directory) => {
      const given = await files(directory);
      // Before the new file has the old one's mode, the three entries a mode stands for differ.
      const entries: Record<string, string[]> = { [given.target.path]: ['user::rw-', 'group::r--', 'other::---'], snapshot: ['user::rw-', 'group::---', 'other::---'] };
      const tools = model(entries, { byDescriptor: true });
      assert.deepStrictEqual(keep(tools, given), []);
      assert.deepStrictEqual(tools.written, []);
      // An entry the folder handed the new file is beyond its mode: the old file's whole listing is set.
      entries.snapshot = ['user::rw-', 'user:1001:r-x', 'group::---', 'mask::---', 'other::---'];
      assert.deepStrictEqual(keep(tools, given), []);
      assert.deepStrictEqual(tools.written, [entries[given.target.path]]);
      given.close();
    });
  });

  it('refuses when the file under the target\'s name is not the one the save resolved, and says so when it cannot be opened', async () => {
    await withScratchDirectory(async (directory) => {
      const given = await files(directory);
      const tools = model({ [given.target.path]: ['a'], snapshot: [] }, { byDescriptor: true });
      assert.throws(() => keep(tools, { ...given, target: { ...given.target, ino: given.target.ino + 1n } }), /Database save target changed during the save/);
      assert.deepStrictEqual(tools.reads, []);
      // A file this account may replace and not read: nothing is known about it.
      const log = keep(tools, { ...given, target: { ...given.target, path: path.join(directory, 'missing.db') } });
      assert.deepStrictEqual(log, [unseen]);
      assert.deepStrictEqual(tools.written, []);
      given.close();
    });
  });

  it('copies entries read by name only where `readCanBeForged` answers no', async () => {
    await withScratchDirectory(async (directory) => {
      const given = await files(directory);
      const own = ['user:colleague allow read,write'];
      const entries: Record<string, string[]> = { [given.target.path]: own, snapshot: [] };
      let tools = model(entries, { byDescriptor: false });
      assert.deepStrictEqual(keep(tools, given, false), []);
      assert.deepStrictEqual(tools.written, [own]);

      // What the name answered may be another file's list, put there by whoever can rename in the
      // folder: it is not given to the new file. That file ends with no entries, and the log says so.
      entries.snapshot = ['group:everyone allow read'];
      entries[given.target.path] = ['user:someone-else allow read,write'];
      tools = model(entries, { byDescriptor: false });
      assert.deepStrictEqual(keep(tools, given, true), [lost]);
      assert.deepStrictEqual(tools.written, [[]]);
      assert.deepStrictEqual(entries.snapshot, []);
      given.close();
    });
  });

  it('keeps the old file\'s entries that refuse, and none that only the new file has, where entries are not copied', async () => {
    await withScratchDirectory(async (directory) => {
      const given = await files(directory);
      // Both files have an entry that refuses one account. The old file also refuses a second
      // one, and lets a third in.
      const entries: Record<string, string[]> = {
        [given.target.path]: ['user:colleague allow read', 'user:intern deny read', 'user:guest deny read,write'],
        snapshot: ['user:intern deny read', 'group:everyone allow read']
      };
      const tools = model(entries, { byDescriptor: false });
      assert.deepStrictEqual(keep(tools, given, true), [notKept]);
      assert.deepStrictEqual(tools.written, [['user:intern deny read', 'user:guest deny read,write']]);
      assert.deepStrictEqual(entries.snapshot, ['user:intern deny read', 'user:guest deny read,write']);

      // An entry only the new file has was handed down by its folder and is not the old file's.
      // Kept, it would refuse what the old file allowed: here the file's removal, to everyone, which
      // stops the save's own rename. Nothing of the old file is lost, so nothing is said.
      entries[given.target.path] = [];
      entries.snapshot = ['group:everyone deny delete', 'group:everyone allow read'];
      const again = model(entries, { byDescriptor: false });
      assert.deepStrictEqual(keep(again, given, true), []);
      assert.deepStrictEqual(again.written, [[]]);
      given.close();
    });
  });

  it('saves without the entries that allow when the program does not take them back, and fails when it does not take one that refuses', async () => {
    await withScratchDirectory(async (directory) => {
      const given = await files(directory);
      const old = ['user:colleague allow read', 'user:intern deny read'];
      const entries: Record<string, string[]> = { [given.target.path]: old, snapshot: ['group:everyone allow read'] };
      let tools = model(entries, { byDescriptor: false, refuse: (wanted) => wanted.includes('user:colleague allow read') });
      assert.deepStrictEqual(keep(tools, given, false), [lost]);
      assert.deepStrictEqual(tools.written, [old, ['user:intern deny read']]);
      assert.deepStrictEqual(entries.snapshot, ['user:intern deny read']);

      // Without an entry that refuses, the new file would allow what the old one did not.
      for (const forged of [true, false]) {
        entries[given.target.path] = ['user:intern deny read'];
        entries.snapshot = [];
        tools = model(entries, { byDescriptor: false, refuse: (wanted) => wanted.length > 0 });
        assert.throws(() => keep(tools, given, forged), /could not be given the access-control entries/, String(forged));
        // Asked once: the list that refuses is the whole list.
        assert.deepStrictEqual(tools.written, [['user:intern deny read']], String(forged));
        assert.deepStrictEqual(entries.snapshot, [], String(forged));
      }
      given.close();
    });
  });

  it('leaves out an entry for an id the system cannot name, and says so', async () => {
    await withScratchDirectory(async (directory) => {
      const given = await files(directory);
      // Measured on macOS: an account that no longer exists is listed as a bare id, and the program
      // that sets entries answers "Unable to translate" to the list that holds it.
      const refuse = (wanted: readonly string[]): boolean => wanted.some((entry) => !/^(user|group):/.test(entry));
      let entries: Record<string, string[]> = { [given.target.path]: ['ABCDEFAB-0000-0000-0000-000000000001 allow read'], snapshot: ['group:everyone allow read'] };
      let tools = model(entries, { byDescriptor: false, refuse });
      assert.deepStrictEqual(keep(tools, given, false), [lost]);
      assert.deepStrictEqual(tools.written, [[]]);
      assert.deepStrictEqual(entries.snapshot, []);

      // One that refuses: the rest of the list is kept as it would be without it, and the log says what is gone.
      const gone = 'ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000007B deny read';
      const rest = ['user:intern deny read', 'user:colleague allow read'];
      for (const forged of [true, false]) {
        entries = { [given.target.path]: [gone, ...rest], snapshot: [] };
        tools = model(entries, { byDescriptor: false, refuse });
        assert.deepStrictEqual(keep(tools, given, forged), forged ? [lost, refusalLost] : [refusalLost], String(forged));
        assert.deepStrictEqual(tools.written, [forged ? ['user:intern deny read'] : rest], String(forged));
        assert.deepStrictEqual(entries.snapshot, forged ? ['user:intern deny read'] : rest, String(forged));
      }
      given.close();
    });
  });

  it('leaves out an entry whose rights are not printed, removes one only the new file has, and says what is gone', async () => {
    await withScratchDirectory(async (directory) => {
      const given = await files(directory);
      // Measured on macOS: `ls` prints no right for rights it has no word for. They can be idle (what
      // a file is handed from a folder's `delete_child`) or the generic ones, which the system goes
      // by. The program that sets entries does not take such a line, so it is never given one.
      const refuse = (wanted: readonly string[]): boolean => wanted.some((entry) => / (allow|deny)$/.test(entry));
      const run = (old: string[], fresh: string[], forged: boolean): { log: string[]; written: string[][]; snapshot: string[] } => {
        const entries: Record<string, string[]> = { [given.target.path]: old, snapshot: fresh };
        const tools = model(entries, { byDescriptor: false, refuse });
        const log = keep(tools, given, forged);
        return { log, written: tools.written, snapshot: entries.snapshot };
      };
      for (const forged of [true, false]) {
        // Only the new file has one, from its folder: it could let an account in, so it is removed.
        assert.deepStrictEqual(run([], ['user:colleague inherited allow'], forged), { log: [], written: [[]], snapshot: [] }, String(forged));
        // Both were handed the same one: nothing is set, and it stays.
        assert.deepStrictEqual(run(['user:intern inherited deny'], ['user:intern inherited deny'], forged),
          { log: [], written: [], snapshot: ['user:intern inherited deny'] }, String(forged));
        // One of the old file's own is not the one the folder hands down, though both print alike but for that word.
        assert.deepStrictEqual(run(['user:intern deny'], ['user:intern inherited deny'], forged), { log: [refusalLost], written: [[]], snapshot: [] }, String(forged));
        // One that lets an account in is gone the same way, under the words for those.
        assert.deepStrictEqual(run(['user:colleague allow'], [], forged), { log: [lost], written: [[]], snapshot: [] }, String(forged));
      }
      // Beside entries that can be written: those are kept as without it, and the log says what is gone.
      const rest = ['user:intern deny read', 'user:colleague allow read'];
      assert.deepStrictEqual(run(['user:guest deny', ...rest], [], false), { log: [refusalLost], written: [rest], snapshot: rest });
      assert.deepStrictEqual(run(['user:guest deny', ...rest], [], true),
        { log: [lost, refusalLost], written: [['user:intern deny read']], snapshot: ['user:intern deny read'] });
      // A word about handing down is not a right, and a name can end in either word.
      assert.deepStrictEqual(run(['user:guest deny file_inherit,directory_inherit', ...rest], [], false), { log: [refusalLost], written: [rest], snapshot: rest });
      assert.deepStrictEqual(run(['group:those we deny allow read'], [], false),
        { log: [], written: [['group:those we deny allow read']], snapshot: ['group:those we deny allow read'] });
      given.close();
    });
  });

  it('counts a folder that an entry lets an account change, and not one whose entries refuse or only let read', () => {
    const folders: Record<string, string[] | undefined> = {
      '/plain': [],
      // As macOS itself puts on home folders.
      '/home': ['group:everyone deny delete'],
      '/readable': ['user:colleague allow list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit'],
      '/shared': ['group:everyone deny delete', 'user:colleague allow list,add_file,search,delete_child'],
      '/owned': ['user:colleague allow writesecurity'],
      '/handed': ['user:colleague allow chown'],
      '/removable': ['user:colleague allow delete'],
      '/unread': ['something this does not read'],
      // A name can hold the word itself: the rights are what follows the last one.
      '/named': ['user:mr allow list allow add_file'],
      '/named-harmless': ['user:allow add_file deny add_file,delete_child'],
      // Rights `ls` does not print can be the generic ones, which let an account write in the folder.
      '/generic': ['user:colleague allow'],
      '/generic-handed-down': ['user:colleague allow file_inherit,directory_inherit'],
      '/generic-refused': ['user:colleague deny', 'user:colleague deny file_inherit']
    };
    accessEntryTools.use = model(folders, { byDescriptor: false });
    assert.deepStrictEqual(foldersOthersMayChange(Object.keys(folders)), ['/shared', '/owned', '/handed', '/removable', '/unread', '/named', '/generic', '/generic-handed-down']);
    assert.deepStrictEqual(foldersOthersMayChange([]), []);
    // No answer about one of them is no answer.
    folders['/gone'] = undefined;
    assert.strictEqual(foldersOthersMayChange(['/plain', '/gone']), undefined);
    // Where entries are read through descriptors, folders are not asked about this way.
    accessEntryTools.use = model(folders, { byDescriptor: true });
    assert.strictEqual(foldersOthersMayChange(['/plain']), undefined);
  });

  it('takes only the three entries a mode stands for as "nothing but its mode"', () => {
    assert.strictEqual(plainEntriesOnly('user::rwx\ngroup::rwx\nother::r-x\n\n'), true);
    assert.strictEqual(plainEntriesOnly('user::rwx\nuser:1001:rwx\ngroup::r-x\nmask::rwx\nother::r-x\n\n'), false, 'an entry for another account');
    assert.strictEqual(plainEntriesOnly('user::rwx\ngroup::rwx\nother::r-x\ndefault:user::rwx\ndefault:group::r-x\ndefault:other::r-x\n'), false, 'entries for new files');
    // A program that ends well and prints nothing has not said "three plain entries".
    assert.strictEqual(plainEntriesOnly(''), false);
    assert.strictEqual(plainEntriesOnly('user::rwx\ngroup::rwx\n'), false);
    assert.strictEqual(plainEntriesOnly('# file: x\nuser::rwx\ngroup::rwx\nother::r-x\n'), false, 'text this does not read');
    assert.strictEqual(plainEntriesOnly('user::rwx\ngroup::rwx\t#effective:r-x\nother::r-x\n'), false);
    // No such folder, or no program to ask: not "nothing more".
    assert.strictEqual(folderHasOnlyItsMode(path.join(os.tmpdir(), 'sqlite-explorer-no-such-folder')), false);
  });

  it('does nothing where no programs are used', async () => {
    await withScratchDirectory(async (directory) => {
      const given = await files(directory);
      accessEntryTools.use = null;
      keepAccessEntries(fs, { ...given.target, ino: given.target.ino + 1n }, given.snapshot, () => { throw new Error('not asked'); }, () => { throw new Error('nothing to say'); });
      assert.deepStrictEqual(foldersOthersMayChange([directory]), []);
      given.close();
    });
  });
});

const mac = process.platform === 'darwin';

describe('the access-control entries of a file that a save replaces, with the system\'s own programs', { skip: NO_REAL_ENTRIES }, () => {
  // On macOS these run `ls` and `chmod`, the programs used where the stored list gives no answer;
  // the suite after this one holds the route through the stored list.
  beforeEach(() => { accessEntryTools.use = undefined; accessEntryTools.storedLists = false; });

  const save = async (targetPath: string, log: string[] = []): Promise<void> => {
    await writeDatabaseSnapshotAtomically(fs, undefined, targetPath, async (candidate, mode) => {
      await fs.promises.writeFile(candidate, 'new database bytes', { flag: 'wx', mode });
    }, undefined, (_level, message) => { log.push(message); });
  };
  const identity = (file: string): bigint => fs.statSync(file, { bigint: true }).ino;
  /** macOS: a file's entries as `ls` prints them, with the word that says an entry was handed down. */
  const listed = (file: string): string[] => execFileSync('/bin/ls', ['-lde', file], { encoding: 'utf8' }).split('\n').slice(1).filter((line) => line !== '')
    .map((line) => line.replace(/^ \d+: /, '').trimEnd());
  const notKept = "Access-control entries that let accounts in were not kept on the database's new file.";
  const refusalLost = "An access-control entry that refuses was not kept on the database's new file: this Mac's programs cannot write its id or its rights back.";

  it('gives the new file no entry from its folder when the old file has none', async () => {
    await withScratchDirectory(async (directory) => {
      const folder = path.join(directory, 'team');
      await fs.promises.mkdir(folder, { mode: 0o755 });
      const targetPath = path.join(folder, 'database.db');
      // Made before the folder handed anything down, as a file moved into such a folder is.
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: mac ? 0o600 : 0o640 });
      handDown(folder);
      assert.deepStrictEqual(sharedWith(targetPath), []);
      const was = identity(targetPath);
      const log: string[] = [];

      await save(targetPath, log);

      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
      assert.notStrictEqual(identity(targetPath), was, 'the file is replaced, as before');
      assert.deepStrictEqual(sharedWith(targetPath), [], 'and gains no entry');
      assert.deepStrictEqual(log, []);

      // The control: the step turned off.
      accessEntryTools.use = null;
      await save(targetPath);
      assert.strictEqual(sharedWith(targetPath).length, 1);
    });
  });

  it('keeps an entry of the file\'s own, where entries read by name are copied', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o640 });
      share(targetPath);
      const own = sharedWith(targetPath);
      assert.strictEqual(own.length, 1);
      const was = identity(targetPath);
      // macOS reads the old file's entries by name, so there it matters who else can rename on the way to it.
      const forgeable = mac && othersCanRenameIn(fs, directory) !== undefined;
      const log: string[] = [];

      await save(targetPath, log);

      assert.notStrictEqual(identity(targetPath), was);
      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
      if (forgeable) {
        assert.deepStrictEqual(sharedWith(targetPath), []);
        assert.deepStrictEqual(log, ["Access-control entries that let accounts in were not kept on the database's new file."]);
      } else {
        assert.deepStrictEqual(sharedWith(targetPath), own);
        assert.deepStrictEqual(log, []);
        // A second save finds them alike and sets nothing.
        await save(targetPath, log);
        assert.deepStrictEqual(sharedWith(targetPath), own);
      }

      // The control: the step turned off.
      share(targetPath);
      if (sharedWith(targetPath).length === 0) share(targetPath);
      accessEntryTools.use = null;
      await save(targetPath);
      assert.deepStrictEqual(sharedWith(targetPath), []);
    });
  });

  it('replaces a file that has just what its folder hands down, and changes nothing', async () => {
    await withScratchDirectory(async (directory) => {
      const folder = path.join(directory, 'team');
      await fs.promises.mkdir(folder, { mode: 0o755 });
      handDown(folder);
      const targetPath = path.join(folder, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o640 });
      const handed = sharedWith(targetPath);
      assert.strictEqual(handed.length, 1);
      const log: string[] = [];

      await save(targetPath, log);

      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
      assert.deepStrictEqual(sharedWith(targetPath), handed);
      assert.deepStrictEqual(log, []);
    });
  });

  it('keeps an entry that refuses an account when it cannot keep the ones that allow (macOS)', { skip: !mac && 'entries that refuse are a macOS kind' }, async () => {
    await withScratchDirectory(async (directory) => {
      // In a folder everyone may write, the file refuses one account and lets another read, both by entries of its own.
      const folder = path.join(directory, 'open');
      await fs.promises.mkdir(folder);
      await fs.promises.chmod(folder, 0o777);
      const targetPath = path.join(folder, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o644 });
      const own = (): void => {
        execFileSync('/bin/chmod', ['+a', 'user:daemon allow read', targetPath]);
        execFileSync('/bin/chmod', ['+a', `user:${other} deny read`, targetPath]);
      };
      own();
      const listed = (): string[] => execFileSync('/bin/ls', ['-lde', targetPath], { encoding: 'utf8' }).split('\n').slice(1).filter((line) => line !== '')
        .map((line) => line.replace(/^ \d+: /, '').replace(' inherited ', ' '));
      assert.deepStrictEqual(listed().sort(), [`user:${other} deny read`, 'user:daemon allow read'].sort());
      const log: string[] = [];

      await save(targetPath, log);

      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
      // The refusal is kept.
      assert.deepStrictEqual(listed(), [`user:${other} deny read`]);
      assert.deepStrictEqual(log, ["Access-control entries that let accounts in were not kept on the database's new file."]);

      // The control: the step turned off.
      execFileSync('/bin/chmod', ['-N', targetPath]);
      own();
      accessEntryTools.use = null;
      await save(targetPath);
      assert.deepStrictEqual(listed(), []);
    });
  });

  it('replaces a file in a folder that hands down an entry refusing every account a file\'s removal (macOS)', { skip: !mac && 'entries that refuse are a macOS kind' }, async () => {
    await withScratchDirectory(async (directory) => {
      // The file was there before the folder handed the entry down, so it has none. A new file with
      // that entry cannot be renamed, by its owner either: kept on the snapshot, it stops the save.
      // That happened in the folder every account can write, where entries are not copied; in the
      // other one the old file's list, which is empty, always replaced the snapshot's.
      for (const [name, mode] of [['open', 0o777], ['mine', 0o755]] as const) {
        const folder = path.join(directory, name);
        await fs.promises.mkdir(folder);
        await fs.promises.chmod(folder, mode);
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o644 });
        execFileSync('/bin/chmod', ['+a', 'group:everyone deny delete,file_inherit,directory_inherit', folder]);
        const log: string[] = [];

        await save(targetPath, log);

        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes', name);
        assert.deepStrictEqual(execFileSync('/bin/ls', ['-lde', targetPath], { encoding: 'utf8' }).split('\n').slice(1).filter((line) => line !== ''), [], name);
        assert.deepStrictEqual(log.filter((message) => /access-control/i.test(message)), [], name);
      }
    });
  });

  it('keeps a file\'s own entry beside one whose rights are not printed, and says that one is gone (macOS)', { skip: !mac && 'rights that are not printed are a macOS kind' }, async () => {
    await withScratchDirectory(async (directory) => {
      // A folder that refuses an account the removal of what is in it hands each file an entry whose
      // right is a folder's: `ls` prints none for it on a file. The program that sets entries does
      // not take such an entry ("No permissions specified"), so the file's own is set without it.
      const folder = path.join(directory, 'team');
      await fs.promises.mkdir(folder, { mode: 0o755 });
      execFileSync('/bin/chmod', ['+a', `user:${other} deny delete_child,file_inherit,directory_inherit`, folder]);
      const targetPath = path.join(folder, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o600 });
      execFileSync('/bin/chmod', ['+a', 'user:daemon allow read', targetPath]);
      assert.deepStrictEqual(listed(targetPath), ['user:daemon allow read', `user:${other} inherited deny`]);
      const log: string[] = [];

      await save(targetPath, log);

      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
      assert.deepStrictEqual(listed(targetPath), ['user:daemon allow read']);
      assert.deepStrictEqual(log, [refusalLost]);
      // The next save has nothing more to say.
      await save(targetPath, log);
      assert.deepStrictEqual(listed(targetPath), ['user:daemon allow read']);
      assert.deepStrictEqual(log, [refusalLost]);

      // The control: the step turned off.
      accessEntryTools.use = null;
      await save(targetPath);
      assert.deepStrictEqual(listed(targetPath).filter((entry) => entry.includes('daemon')), []);
    });
  });

  it('removes an entry its folder hands down whose rights are not printed (macOS)', { skip: !mac && 'rights that are not printed are a macOS kind' }, async () => {
    await withScratchDirectory(async (directory) => {
      // The file was there before its folder handed anything down, so it has no entry. What the
      // folder hands a new file prints without a right, which can be a right the system goes by.
      const folder = path.join(directory, 'team');
      await fs.promises.mkdir(folder, { mode: 0o755 });
      const targetPath = path.join(folder, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o600 });
      execFileSync('/bin/chmod', ['+a', `user:${other} allow delete_child,file_inherit,directory_inherit`, folder]);
      assert.deepStrictEqual(listed(targetPath), []);
      const log: string[] = [];

      await save(targetPath, log);

      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
      assert.deepStrictEqual(listed(targetPath), [], 'and gains no entry');
      assert.deepStrictEqual(log, []);

      // The control: the step turned off.
      accessEntryTools.use = null;
      await save(targetPath);
      assert.deepStrictEqual(listed(targetPath), [`user:${other} inherited allow`]);
    });
  });

  it('says so when an entry of the file\'s own that refuses cannot be written back (macOS)', { skip: !mac && 'rights that are not printed are a macOS kind' }, async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o644 });
      // Stored with a right `ls` has no word for on a file, as the generic rights are.
      execFileSync('/bin/chmod', ['+a', `user:${other} deny delete_child`, targetPath]);
      execFileSync('/bin/chmod', ['+a', 'user:daemon allow read', targetPath]);
      assert.deepStrictEqual(listed(targetPath), [`user:${other} deny`, 'user:daemon allow read']);
      // Entries read by name are copied only where `othersCanRenameIn` finds no folder.
      const forgeable = othersCanRenameIn(fs, directory) !== undefined;
      const log: string[] = [];

      await save(targetPath, log);

      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
      assert.deepStrictEqual(listed(targetPath), forgeable ? [] : ['user:daemon allow read']);
      assert.deepStrictEqual(log, forgeable ? [notKept, refusalLost] : [refusalLost]);

      // A folder can hand down an entry that prints the same but for the word "inherited". The
      // file's own is not that one, so the new file does not pass for having it.
      const folder = path.join(directory, 'team');
      await fs.promises.mkdir(folder, { mode: 0o755 });
      const inFolder = path.join(folder, 'database.db');
      await fs.promises.writeFile(inFolder, 'old database bytes', { mode: 0o644 });
      execFileSync('/bin/chmod', ['+a', `user:${other} deny delete_child`, inFolder]);
      execFileSync('/bin/chmod', ['+a', `user:${other} deny delete_child,file_inherit,directory_inherit`, folder]);
      assert.deepStrictEqual(listed(inFolder), [`user:${other} deny`]);
      log.length = 0;

      await save(inFolder, log);

      assert.deepStrictEqual(listed(inFolder), []);
      assert.deepStrictEqual(log, [refusalLost]);
    });
  });

  it('asks the program again when it does not find the descriptor it was handed (macOS)', { skip: !mac && 'entries are set through /dev/fd on macOS only' }, async (t) => {
    await withScratchDirectory(async (directory) => {
      // Measured on macOS 27.2 while other processes make and remove files: `chmod` answers that
      // `/dev/fd/3` is not there, although it was handed that descriptor, and finds it when asked again.
      let refuse = 0;
      const asked: string[] = [];
      const spawnSync = childProcess.spawnSync;
      t.mock.method(childProcess, 'spawnSync', ((...args: unknown[]) => {
        if (args[0] === '/bin/chmod') {
          asked.push((args[1] as string[])[0]);
          if (refuse > 0) {
            refuse--;
            return { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: 1, signal: null };
          }
        }
        return (spawnSync as (...given: unknown[]) => unknown)(...args);
      }) as typeof childProcess.spawnSync);

      // An entry to remove: the folder's, from a file that had none.
      const folder = path.join(directory, 'team');
      await fs.promises.mkdir(folder, { mode: 0o755 });
      const targetPath = path.join(folder, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o600 });
      handDown(folder);
      const log: string[] = [];
      // One refusal here, so that two tries are left for the system itself, which refuses now and then.
      refuse = 1;
      await save(targetPath, log);
      assert.deepStrictEqual(sharedWith(targetPath), []);
      assert.deepStrictEqual(log, []);
      assert.deepStrictEqual(asked.slice(0, 2), ['-N', '-N']);
      assert.ok(asked.length <= 3, String(asked));

      // An entry to set: the file's own, where entries are copied.
      const ownPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(ownPath, 'old database bytes', { mode: 0o640 });
      share(ownPath);
      if (othersCanRenameIn(fs, directory) === undefined) {
        asked.length = 0;
        refuse = 1;
        await save(ownPath, log);
        assert.deepStrictEqual(sharedWith(ownPath), [`user:${other} allow read`]);
        assert.deepStrictEqual(log, []);
        assert.deepStrictEqual(asked.slice(0, 2), ['-E', '-E']);
        assert.ok(asked.length <= 3, String(asked));
      }

      // Refused every time, the save fails as it does for a list the program does not take, after three tries.
      asked.length = 0;
      refuse = Infinity;
      await assert.rejects(save(targetPath, log), /could not be given the access-control entries/);
      assert.deepStrictEqual(asked, ['-N', '-N', '-N']);
      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes', 'the file is the one the first save left');
      refuse = 0;
    });
  });

  it('takes an entry the folder handed down and the same entry put on the file for the same (macOS)', { skip: !mac && 'where an entry came from is listed on macOS only' }, async (t) => {
    await withScratchDirectory(async (directory) => {
      const folder = path.join(directory, 'team');
      await fs.promises.mkdir(folder, { mode: 0o755 });
      const targetPath = path.join(folder, 'database.db');
      // The file was there before the folder handed anything down, and was given by hand what the folder now gives.
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o600 });
      share(targetPath);
      // Exactly the right the file has by hand: on a folder it reads "list", on what is made in it "read".
      execFileSync('/bin/chmod', ['+a', `user:${other} allow read,file_inherit,directory_inherit`, folder]);
      assert.deepStrictEqual(execFileSync('/bin/ls', ['-lde', targetPath], { encoding: 'utf8' }).split('\n').slice(1, 2), [` 0: user:${other} allow read`]);
      const started: string[] = [];
      const start = childProcess.spawnSync;
      t.mock.method(childProcess, 'spawnSync', ((...args: unknown[]) => {
        started.push(String(args[0]));
        return (start as (...given: unknown[]) => unknown)(...args);
      }) as typeof childProcess.spawnSync);

      await save(targetPath);

      // One look at both files, which lets the same account do the same: nothing is set.
      assert.deepStrictEqual(started.filter((program) => program === '/bin/chmod'), []);
      assert.deepStrictEqual(sharedWith(targetPath), [`user:${other} allow read`]);
    });
  });

  it('does not take a line of a file\'s name for an entry (macOS)', { skip: !mac && 'entries are read from a listing that prints names on macOS only' }, async () => {
    await withScratchDirectory(async (directory) => {
      // A name whose second line reads like an entry that lets everyone read the file, in a folder
      // that hands an entry down: the new file then differs from the old one, and is given the old one's.
      const folder = path.join(directory, 'team');
      await fs.promises.mkdir(folder, { mode: 0o755 });
      const targetPath = path.join(folder, 'database\n 0: group:everyone allow read');
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o600 });
      handDown(folder);
      const listed = (file: string): string[] => execFileSync('/bin/ls', ['-ldeq', file], { encoding: 'utf8' }).split('\n').slice(1).filter((line) => line !== '');
      assert.deepStrictEqual(listed(targetPath), []);
      const log: string[] = [];

      await save(targetPath, log);

      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
      assert.deepStrictEqual(listed(targetPath), [], 'the new file has no entry, as the old one had none');
      assert.deepStrictEqual(log, []);
    });
  });

  it('counts a folder that carries entries as one another account may rename in (macOS)', { skip: !mac && 'entries leave the mode as it is on macOS only' }, async () => {
    await withScratchDirectory(async (directory) => {
      const folder = path.join(directory, 'shared');
      await fs.promises.mkdir(folder, { mode: 0o755 });
      const above = othersCanRenameIn(fs, folder);
      execFileSync('/bin/chmod', ['+a', `user:${other} allow add_file,delete_child,list,search`, folder]);
      assert.strictEqual(fs.statSync(folder).mode & 0o777, 0o755);
      // By its owner and mode alone it is this account's own.
      assert.strictEqual(othersCanRenameIn(fs, folder, process.platform, false), othersCanRenameIn(fs, directory, process.platform, false));
      assert.strictEqual(othersCanRenameIn(fs, folder), above ?? folder);
      assert.strictEqual(foldersOthersMayChange([directory, folder])?.includes(folder), true);
      // An entry that refuses, as on every home folder, and one that only lets read: nobody can rename by them.
      const home = path.join(directory, 'home');
      await fs.promises.mkdir(home, { mode: 0o755 });
      execFileSync('/bin/chmod', ['+a', 'group:everyone deny delete', home]);
      execFileSync('/bin/chmod', ['+a', `user:${other} allow list,search,readattr,file_inherit,directory_inherit`, home]);
      assert.strictEqual(foldersOthersMayChange([home])?.length, 0);
      assert.strictEqual(othersCanRenameIn(fs, home), above);
    });
  });
});

describe('the stored list of a file that a save replaces, copied through descriptors (macOS)', { skip: !mac && 'the stored list is read through descriptors on macOS only' }, () => {
  beforeEach(() => { accessEntryTools.use = undefined; accessEntryTools.storedLists = undefined; });

  const save = async (targetPath: string, log: string[] = []): Promise<void> => {
    await writeDatabaseSnapshotAtomically(fs, undefined, targetPath, async (candidate, mode) => {
      await fs.promises.writeFile(candidate, 'new database bytes', { flag: 'wx', mode });
    }, undefined, (_level, message) => { log.push(message); });
  };
  /** A file's entries as they are stored: the id, the kind and flags, and the rights of each. */
  const stored = (file: string): string[] => {
    const fd = fs.openSync(file, 'r');
    try {
      const read = macStoredListTools!.read([{ fd, path: file }]);
      assert.ok(read, 'the stored list is read');
      return read[0];
    } finally {
      fs.closeSync(fd);
    }
  };
  const identity = (file: string): bigint => fs.statSync(file, { bigint: true }).ino;

  it('gives the new file the stored entries as they are: one that is only handed down, and a right without a word', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const make = async (): Promise<string[]> => {
        await fs.promises.rm(targetPath, { force: true });
        await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o640 });
        // An entry that is only to be handed down, and a right `ls` has no word for.
        execFileSync('/bin/chmod', ['+a', `user:${other} allow read,write,file_inherit,directory_inherit,only_inherit`, targetPath]);
        execFileSync('/bin/chmod', ['+a', `user:${other} deny delete_child`, targetPath]);
        return stored(targetPath);
      };
      const before = await make();
      assert.strictEqual(before.length, 2);
      const was = identity(targetPath);
      const log: string[] = [];

      await save(targetPath, log);

      assert.notStrictEqual(identity(targetPath), was, 'the file is replaced');
      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
      assert.deepStrictEqual(stored(targetPath), before);
      assert.deepStrictEqual(log, []);
      // A second save finds them alike.
      await save(targetPath, log);
      assert.deepStrictEqual(stored(targetPath), before);
      assert.deepStrictEqual(log, []);

      // The control: the route by `ls` and `chmod`.
      assert.deepStrictEqual(await make(), before);
      accessEntryTools.storedLists = false;
      await save(targetPath);
      assert.notDeepStrictEqual(stored(targetPath), before);
    });
  });

  it('copies entries that allow and entries that refuse in a folder every account can write', async () => {
    await withScratchDirectory(async (directory) => {
      // The old file is opened and compared with the one the save resolved, so no name is trusted.
      const folder = path.join(directory, 'open');
      await fs.promises.mkdir(folder);
      await fs.promises.chmod(folder, 0o777);
      const targetPath = path.join(folder, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o644 });
      execFileSync('/bin/chmod', ['+a', 'user:daemon allow read', targetPath]);
      execFileSync('/bin/chmod', ['+a', `user:${other} deny read`, targetPath]);
      const before = stored(targetPath);
      assert.strictEqual(before.length, 2);
      const log: string[] = [];

      await save(targetPath, log);

      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
      assert.deepStrictEqual(stored(targetPath), before);
      assert.deepStrictEqual(log.filter((message) => /access-control/i.test(message)), []);
    });
  });

  it('removes what the folder hands the new file when the old one has none', async () => {
    await withScratchDirectory(async (directory) => {
      const folder = path.join(directory, 'team');
      await fs.promises.mkdir(folder, { mode: 0o755 });
      const targetPath = path.join(folder, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o600 });
      handDown(folder);
      assert.deepStrictEqual(stored(targetPath), []);
      const log: string[] = [];

      await save(targetPath, log);

      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
      assert.deepStrictEqual(stored(targetPath), []);
      assert.deepStrictEqual(log, []);

      // The control: the step turned off.
      accessEntryTools.use = null;
      await save(targetPath);
      assert.strictEqual(stored(targetPath).length, 1);
    });
  });

  it('keeps an entry for an id the system cannot name', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o644 });
      // As a deleted account leaves: an id no account has, refused reading (kind 2, right 2).
      const orphan = 'abcdefab0000000000000000000000070200000002000000';
      const fd = fs.openSync(targetPath, 'r+');
      try {
        assert.strictEqual(macStoredListTools!.write(fd, [orphan]), true);
      } finally {
        fs.closeSync(fd);
      }
      assert.deepStrictEqual(stored(targetPath), [orphan]);
      const log: string[] = [];

      await save(targetPath, log);

      assert.deepStrictEqual(stored(targetPath), [orphan]);
      assert.deepStrictEqual(log, []);
    });
  });

  it('carries the flags a list has of its own', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o644 });
      // A list can say of itself that it takes nothing its folder hands down: no entry holds that.
      const list = ['flags:00020000', 'ffffeeeeddddccccbbbbaaaafffffffe0100000002000000'];
      const fd = fs.openSync(targetPath, 'r+');
      try {
        assert.strictEqual(macStoredListTools!.write(fd, list), true);
      } finally {
        fs.closeSync(fd);
      }
      assert.deepStrictEqual(stored(targetPath), list);
      const log: string[] = [];

      await save(targetPath, log);

      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
      assert.deepStrictEqual(stored(targetPath), list);
      assert.deepStrictEqual(log, []);
    });
  });

  it('goes by `ls` and `chmod` when the stored list gives no answer, as where there is no Ruby', async (t) => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o640 });
      share(targetPath);
      const own = sharedWith(targetPath);
      assert.strictEqual(own.length, 1);
      const asked: string[] = [];
      const spawnSync = childProcess.spawnSync;
      t.mock.method(childProcess, 'spawnSync', ((...args: unknown[]) => {
        asked.push(String(args[0]));
        if (args[0] === '/usr/bin/ruby') {
          return { pid: 0, output: [], stdout: '', stderr: '', status: null, signal: null, error: Object.assign(new Error('spawnSync /usr/bin/ruby ENOENT'), { code: 'ENOENT' }) };
        }
        return (spawnSync as (...given: unknown[]) => unknown)(...args);
      }) as typeof childProcess.spawnSync);
      const forgeable = othersCanRenameIn(fs, directory) !== undefined;
      const log: string[] = [];

      await save(targetPath, log);

      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
      assert.deepStrictEqual(sharedWith(targetPath), forgeable ? [] : own);
      // Asked once, then the other programs for the rest of this save.
      assert.strictEqual(asked.filter((program) => program === '/usr/bin/ruby').length, 1);
      assert.ok(asked.includes('/bin/chmod') || forgeable, String(asked));
      // The save says that it did not go by the stored list, once.
      assert.strictEqual(log.filter((message) => message.includes('could not be read as they are stored')).length, 1, String(log));
    });
  });

  it('reads what `chmod` set as the bytes the system stores, and sets bytes that `ls` then lists', async () => {
    await withScratchDirectory(async (directory) => {
      const file = path.join(directory, 'database.db');
      await fs.promises.writeFile(file, 'bytes');
      // "everyone" has one id on every Mac. Kind 2 refuses and kind 1 allows; right 8 is execute and right 2 is read.
      const refusesExecute = 'abcdefabcdefabcdefabcdef0000000c0200000008000000';
      const allowsRead = 'abcdefabcdefabcdefabcdef0000000c0100000002000000';
      execFileSync('/bin/chmod', ['+a', 'everyone allow read', file]);
      execFileSync('/bin/chmod', ['+a', 'everyone deny execute', file]);
      assert.deepStrictEqual(stored(file), [refusesExecute, allowsRead]);

      execFileSync('/bin/chmod', ['-N', file]);
      assert.deepStrictEqual(stored(file), []);
      const fd = fs.openSync(file, 'r+');
      try {
        assert.strictEqual(macStoredListTools!.write(fd, [refusesExecute, allowsRead]), true);
      } finally {
        fs.closeSync(fd);
      }
      const listed = execFileSync('/bin/ls', ['-le', file], { encoding: 'utf8' }).split('\n').slice(1).map((line) => line.trim()).filter((line) => line !== '');
      assert.deepStrictEqual(listed, ['0: group:everyone deny execute', '1: group:everyone allow read']);
    });
  });

  it('gives no answer about a list the system does not let it read', async (t) => {
    if (process.getuid?.() === 0) {
      t.skip('the system lets root read any list');
      return;
    }
    await withScratchDirectory(async (directory) => {
      const file = path.join(directory, 'database.db');
      await fs.promises.writeFile(file, 'bytes');
      const fd = fs.openSync(file, 'r+');
      try {
        assert.deepStrictEqual(macStoredListTools!.read([{ fd, path: file }]), [[]]);
        // A save does not get this far: with this entry its own look at the file fails first.
        execFileSync('/bin/chmod', ['+a', `user:${os.userInfo().username} deny readsecurity`, file]);
        try {
          assert.strictEqual(macStoredListTools!.read([{ fd, path: file }]), undefined, 'refused is not "no list"');
        } finally {
          // Through the descriptor: by its name the file cannot be looked at now, also not to remove it.
          assert.strictEqual(macStoredListTools!.write(fd, []), true);
        }
        assert.deepStrictEqual(macStoredListTools!.read([{ fd, path: file }]), [[]]);
      } finally {
        fs.closeSync(fd);
      }
    });
  });

  it('fails the save when the stored list is read and cannot be set, and does not go on to `ls` and `chmod`', async (t) => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o640 });
      share(targetPath);
      const before = stored(targetPath);
      assert.strictEqual(before.length, 1);
      const asked: string[] = [];
      const spawnSync = childProcess.spawnSync;
      t.mock.method(childProcess, 'spawnSync', ((...args: unknown[]) => {
        asked.push(String(args[0]));
        return (spawnSync as (...given: unknown[]) => unknown)(...args);
      }) as typeof childProcess.spawnSync);
      const refused = t.mock.method(macStoredListTools!, 'write', () => false);

      await assert.rejects(save(targetPath), /could not be given the access-control entries/);

      assert.strictEqual(refused.mock.callCount(), 1);
      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
      assert.deepStrictEqual(stored(targetPath), before);
      assert.ok(!asked.includes('/bin/chmod'), String(asked));
      assert.deepStrictEqual(await fs.promises.readdir(directory), ['database.db']);
    });
  });
});

