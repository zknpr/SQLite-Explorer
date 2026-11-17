import assert from 'node:assert';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { hasOnlyItsMode, othersCanRenameIn, stagedSnapshotAccess, writeDatabaseSnapshotAtomically } from '../../src/atomicDatabaseWrite';
import { isMomentary, patiently, refusedReplacement } from '../../src/fileReplacementMetadata';
import { acquireSqliteWriteLock } from '../../src/pagedWritableSave';
import { accessEntryTools } from '../../src/posixAccessEntries';
import { NO_FILE_SYMLINKS } from './helpers/symlinks';

// These tests are not about access-control entries (posix_access_entries.test.ts is): no program is
// started for them, so that what a save logs does not depend on which programs a machine has.
accessEntryTools.use = null;

/** The flags a save opens its file beside the destination with, once a helper process has made it. */
const MADE_BY_HELPER = fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0);
/** Whether an open is the save's own of the file it copies a staged snapshot into. */
const isCopyOpen = (flags: unknown): boolean => flags === 'wx+' || flags === MADE_BY_HELPER;

// On Windows a snapshot gets a directory of its own only when its target's
// access list is not its folder's (windows_access_list.test.ts). Every other
// snapshot is written beside its target there.
const ownDirectory = { skip: process.platform === 'win32' && 'this snapshot is written beside its target on Windows' };
/** The folder a snapshot's path lies in: one directory up on Windows, two where it has a private directory. */
const folderOf = (snapshotPath: string): string =>
  process.platform === 'win32' ? path.dirname(snapshotPath) : path.dirname(path.dirname(snapshotPath));

/** A save's answer: whether its engine must reopen, and which file is now at the target. */
function assertInstalled(result: unknown, targetPath: string, requiresReopen: boolean): void {
  const now = fs.statSync(targetPath, { bigint: true });
  assert.deepStrictEqual(result, { requiresReopen, installed: { dev: now.dev, ino: now.ino } });
}

async function withScratchDirectory(
  run: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'sqlite-explorer-atomic-write-')
  );
  try {
    await run(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertNoAtomicTemporaryFiles(directory: string): Promise<void> {
  const entries = await fs.promises.readdir(directory);
  assert.deepStrictEqual(
    entries.filter((entry) => entry.includes('.sqlite-explorer-')),
    []
  );
}

describe('writeDatabaseSnapshotAtomically', () => {
  // These tests follow the snapshot by the name of its private directory. On Linux a folder that
  // other accounts can rename in (any folder made here under a umask of 0) sends a save through a
  // descriptor instead: the tests further down that are about that route ask for it themselves.
  beforeEach(() => { stagedSnapshotAccess.throughDescriptor = false; });
  after(() => { stagedSnapshotAccess.throughDescriptor = true; });
  it('refuses to replace a clean WAL target while another connection retains it', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX pathname replacement is the corruption path under review');
      return;
    }

    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
      const peer = new DatabaseSync(targetPath);
      try {
        peer.exec(
          'PRAGMA journal_mode=WAL; '
          + 'CREATE TABLE original (value TEXT); '
          + "INSERT INTO original VALUES ('keep me')"
        );
        assert.deepStrictEqual(
          { ...peer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() },
          { busy: 0, log: 0, checkpointed: 0 },
          'the peer must retain a clean WAL with no frames for the replacement gate to detect'
        );

        await assert.rejects(
          writeDatabaseSnapshotAtomically(
            fs,
            undefined,
            targetPath,
            async (temporaryPath) => {
              const replacement = new DatabaseSync(temporaryPath);
              try {
                replacement.exec('CREATE TABLE replacement (value TEXT)');
              } finally {
                replacement.close();
              }
            }
          ),
          /exclusive SQLite lock.*close other connections/i
        );

        assert.deepStrictEqual(
          peer.prepare('SELECT value FROM original').all().map(row => ({ ...row })),
          [{ value: 'keep me' }]
        );
      } finally {
        peer.close();
      }

      const reopened = new DatabaseSync(targetPath, { readOnly: true });
      try {
        assert.deepStrictEqual(
          reopened.prepare('SELECT value FROM original').all().map(row => ({ ...row })),
          [{ value: 'keep me' }]
        );
        assert.throws(
          () => reopened.prepare('SELECT * FROM replacement').all(),
          /no such table: replacement/i
        );
      } finally {
        reopened.close();
      }
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('preserves an existing target and removes the temporary file when the producer fails', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const originalBytes = Buffer.from('existing database bytes');
      let temporaryPath: string | undefined;
      await fs.promises.writeFile(targetPath, originalBytes);

      await assert.rejects(
        writeDatabaseSnapshotAtomically(
          fs,
          undefined,
          targetPath,
          async (candidatePath) => {
            temporaryPath = candidatePath;
            await fs.promises.writeFile(candidatePath, 'incomplete snapshot');
            throw new Error('producer failed');
          }
        ),
        /producer failed/
      );

      assert.deepStrictEqual(await fs.promises.readFile(targetPath), originalBytes);
      assert.ok(temporaryPath, 'the producer should receive a temporary path');
      assert.strictEqual(await pathExists(temporaryPath), false);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('removes the private directory after a failure with the snapshot still open', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(targetPath, 'existing database bytes');
      await assert.rejects(
        writeDatabaseSnapshotAtomically(fs, undefined, targetPath, async (candidatePath) => {
          await fs.promises.writeFile(candidatePath, '');
        }),
        /invalid empty snapshot/
      );
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('removes only the snapshot from its private directory when a save fails', ownDirectory, async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      let privateDirectory: string | undefined;
      await fs.promises.writeFile(targetPath, 'existing database bytes');
      const failure = await writeDatabaseSnapshotAtomically(
        fs,
        undefined,
        targetPath,
        async (candidatePath) => {
          privateDirectory = path.dirname(candidatePath);
          await fs.promises.writeFile(candidatePath, 'incomplete snapshot');
          await fs.promises.writeFile(path.join(privateDirectory, 'not-the-snapshot'), 'keep');
          throw new Error('producer failed');
        }
      ).then(() => undefined, (error: unknown) => error);
      assert.ok(failure instanceof AggregateError, 'the cleanup failure must be reported');
      assert.match((failure.errors[0] as Error).message, /producer failed/);
      assert.ok(privateDirectory);
      assert.deepStrictEqual(await fs.promises.readdir(privateDirectory), ['not-the-snapshot']);
      assert.deepStrictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'existing database bytes');
    });
  });

  // The private directory is moved away while the snapshot is written, and
  // a link is put at its name.
  for (const [label, alreadyThere] of [
    ['a file of the snapshot\'s name in the directory the link points to', true],
    ['an empty directory the link points to', false]
  ] as const) {
    it(`removes only what it made when its private directory is not the one it made: ${label}`, { skip: NO_FILE_SYMLINKS || ownDirectory.skip }, async () => {
      await withScratchDirectory(async (directory) => {
        const shared = path.join(directory, 'shared');
        const elsewhere = path.join(directory, 'elsewhere');
        await fs.promises.mkdir(shared, { mode: 0o755 });
        await fs.promises.mkdir(elsewhere, { mode: 0o755 });
        const targetPath = path.join(shared, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        if (alreadyThere) await fs.promises.writeFile(path.join(elsewhere, 'database.db'), 'another file');
        let moved = '';

        const failure = await writeDatabaseSnapshotAtomically(fs, undefined, targetPath, async (candidatePath) => {
          const privateDirectory = path.dirname(candidatePath);
          moved = `${privateDirectory}-moved`;
          await fs.promises.rename(privateDirectory, moved);
          await fs.promises.symlink(elsewhere, privateDirectory);
          // As the WebAssembly engine writes its snapshot.
          await fs.promises.writeFile(candidatePath, 'new database bytes', { flag: 'wx', mode: 0o600 });
        }).then(() => undefined, (error: unknown) => error);

        assert.ok(failure instanceof AggregateError, String(failure));
        assert.match(String((failure.errors[1] as Error).message), /temporary directory was replaced/);
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
        // What is behind the link is left as it was found, or as the write left it.
        assert.strictEqual(
          await fs.promises.readFile(path.join(elsewhere, 'database.db'), 'utf8'),
          alreadyThere ? 'another file' : 'new database bytes'
        );
        assert.strictEqual((await fs.promises.lstat(moved)).isDirectory(), true);
      });
    });
  }

  it('saves onto a file on a filesystem that keeps no modes, and fails when a mode the file could have is refused', ownDirectory, async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o600 });
      for (const sameMode of [true, false]) {
        // As FAT mounted for another account answers: every file has the owner and mode its mount was
        // given, the new one like the one it replaces, and nobody but that owner may change a mode.
        const files = new Proxy(fs, {
          get(real, key) {
            if (key !== 'promises') return Reflect.get(real, key);
            return new Proxy(real.promises, {
              get(promises, name) {
                if (name !== 'open') return Reflect.get(promises, name);
                return async (file: fs.PathLike, flags: unknown, ...rest: unknown[]) => {
                  const handle = await (promises.open as (...given: unknown[]) => Promise<fs.promises.FileHandle>)(file, flags, ...rest);
                  if (flags !== 'r+') return handle;
                  return new Proxy(handle, {
                    get(given, property) {
                      if (property === 'chmod') return async () => { throw Object.assign(new Error('EPERM: operation not permitted, fchmod'), { code: 'EPERM' }); };
                      if (property === 'stat' && !sameMode) {
                        // A filesystem that does keep modes, on which the change was refused all the same.
                        return async (...args: unknown[]) => {
                          const stats = await (given.stat as (...all: unknown[]) => Promise<fs.Stats | fs.BigIntStats>)(...args);
                          return new Proxy(stats, {
                            get(found, field) {
                              if (field === 'mode') return typeof found.mode === 'bigint' ? found.mode | 0o044n : found.mode | 0o044;
                              const value = Reflect.get(found, field);
                              return typeof value === 'function' ? value.bind(found) : value;
                            }
                          });
                        };
                      }
                      const value = Reflect.get(given, property);
                      return typeof value === 'function' ? value.bind(given) : value;
                    }
                  });
                };
              }
            });
          }
        });
        const save = writeDatabaseSnapshotAtomically(files, undefined, targetPath, async (candidate, mode) => {
          await fs.promises.writeFile(candidate, 'new database bytes', { flag: 'wx', mode });
        });

        if (sameMode) {
          await save;
          assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
          await fs.promises.writeFile(targetPath, 'old database bytes');
        } else {
          await assert.rejects(save, /EPERM: operation not permitted, fchmod/);
          assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
        }
        await assertNoAtomicTemporaryFiles(directory);
      }
    });
  });

  it('goes on only with the private directory it made itself', ownDirectory, async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes');
      const swapped: string[] = [];
      // The directory's name is given to another one as soon as the directory
      // exists: after the call that made it returns, whichever of the two forms was used.
      const swap = (made: string): void => {
        fs.renameSync(made, `${made}-ours`);
        fs.mkdirSync(made, { mode: 0o777 });
        swapped.push(made);
      };
      const files = new Proxy(fs, {
        get(real, key) {
          if (key === 'mkdtempSync') {
            return (prefix: string) => {
              const made = real.mkdtempSync(prefix);
              queueMicrotask(() => swap(made));
              return made;
            };
          }
          if (key !== 'promises') return Reflect.get(real, key);
          return new Proxy(real.promises, {
            get(promises, name) {
              if (name !== 'mkdtemp') return Reflect.get(promises, name);
              return async (prefix: string) => {
                const made = await promises.mkdtemp(prefix);
                swap(made);
                return made;
              };
            }
          });
        }
      });
      let writtenIn: fs.BigIntStats | undefined;

      const failure = await writeDatabaseSnapshotAtomically(files, undefined, targetPath, async (candidatePath) => {
        writtenIn = fs.lstatSync(path.dirname(candidatePath), { bigint: true });
        // As the native engine's VACUUM INTO writes its snapshot: with SQLite's default mode.
        await fs.promises.writeFile(candidatePath, 'new database bytes', { flag: 'wx', mode: 0o644 });
      }).then(() => undefined, (error: unknown) => error);

      assert.strictEqual(swapped.length, 1);
      // The save saw that the directory under the name was no longer the one it made, and stopped.
      assert.ok(failure instanceof AggregateError, String(failure));
      assert.match(String((failure.errors[1] as Error).message), /temporary directory was replaced/);
      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
      assert.notStrictEqual(writtenIn, undefined);
    });
  });

  it('stops waiting for another program\'s lock when the save is cancelled', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const made = new DatabaseSync(targetPath);
      made.exec('CREATE TABLE old(x)');
      made.close();
      // A reader that stays: the save's lock is refused for as long as it tries.
      const reader = new DatabaseSync(targetPath, { readOnly: true });
      reader.exec('BEGIN');
      reader.prepare('SELECT count(*) FROM sqlite_schema').get();
      const cancel = new AbortController();
      // The save looks for a WAL beside its target right before it first asks for the lock: the
      // cancel comes a moment after that, whatever the machine took to get there.
      let cancelledAt = 0;
      const files = new Proxy(fs, {
        get(real, key) {
          const value = Reflect.get(real, key);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (cancelledAt === 0 && String(args[0]).endsWith('database.db-wal')) {
              cancelledAt = -1;
              setTimeout(() => { cancelledAt = performance.now(); cancel.abort(); }, 60);
            }
            return (value as (...given: unknown[]) => unknown).apply(real, args);
          };
        }
      });
      try {
        const failure = await writeDatabaseSnapshotAtomically(files, undefined, targetPath, async (candidatePath) => {
          const fresh = new DatabaseSync(candidatePath);
          fresh.exec('CREATE TABLE fresh(x)');
          fresh.close();
        }, cancel.signal).then(() => undefined, (error: unknown) => error);

        // Not the refusal of the lock, which is what the save reports when it has waited to the end.
        assert.strictEqual((failure as Error)?.name, 'AbortError', String(failure));
        assert.ok(cancelledAt > 0, 'the save was cancelled while it waited for the lock');
        // All its waits together are 630 ms: it left at the first attempt after the cancel.
        assert.ok(performance.now() - cancelledAt < 450, `it went on waiting for ${performance.now() - cancelledAt} ms after the cancel`);
      } finally {
        reader.exec('COMMIT');
        reader.close();
      }
      assert.deepStrictEqual((await fs.promises.readdir(directory)).filter((entry) => entry.includes('.sqlite-explorer-')), []);
    });
  });

  it('checks its private directory and cleans up after a failure without a pause between the two', ownDirectory, async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes');
      // A removal that waits its turn would leave time, after the check, for the name to be given
      // to something else. So none of the removals after a failure may be one that waits.
      const waited: string[] = [];
      const files = new Proxy(fs, {
        get(real, key) {
          if (key !== 'promises') return Reflect.get(real, key);
          return new Proxy(real.promises, {
            get(promises, name) {
              if (name !== 'rm' && name !== 'rmdir' && name !== 'unlink') return Reflect.get(promises, name);
              return async (...args: unknown[]) => {
                waited.push(String(name));
                return (Reflect.get(promises, name) as (...given: unknown[]) => Promise<void>)(...args);
              };
            }
          });
        }
      });

      await assert.rejects(writeDatabaseSnapshotAtomically(files, undefined, targetPath, async (candidatePath) => {
        await fs.promises.writeFile(candidatePath, 'half a snapshot', { flag: 'wx', mode: 0o600 });
        throw new Error('the engine failed');
      }), /the engine failed/);

      assert.deepStrictEqual(waited, []);
      assert.deepStrictEqual((await fs.promises.readdir(directory)).filter((entry) => entry.includes('.sqlite-explorer-')), []);
      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
    });
  });

  // An engine whose snapshot is created by another program, by name and with that program's mode
  // (native VACUUM INTO), asks for it to be staged where another account can rename in the
  // destination's folder.
  // Linux reaches a staged snapshot through a descriptor of its directory, every other platform by
  // that directory's name. Linux runs both, so that the route the others take is held there too.
  for (const throughDescriptor of process.platform === 'linux' ? [true, false] : [false]) describe(`a snapshot another program writes, for a folder other accounts can rename in${process.platform !== 'linux' ? '' : throughDescriptor ? ' (reached through a descriptor)' : ' (reached by name)'}`, ownDirectory, () => {
    beforeEach(() => { stagedSnapshotAccess.throughDescriptor = throughDescriptor; });
    /** The private directory a save has made beside `name` in `folder`, by its name. */
    const privateDirectoryOf = (folder: string, name: string): string =>
      path.join(folder, fs.readdirSync(folder).find((entry) => entry.startsWith(`.${name}.sqlite-explorer-`))!);
    // A temporary folder of this test's own, so that what a save leaves there can be told from what
    // other test files, which run beside this one, are doing in the shared one.
    let realTemporary: string | undefined;
    let ownTemporary = '';
    beforeEach(() => {
      realTemporary = process.env.TMPDIR;
      ownTemporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-explorer-staged-test-')));
      process.env.TMPDIR = ownTemporary;
    });
    afterEach(() => {
      if (realTemporary === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = realTemporary;
      fs.rmSync(ownTemporary, { recursive: true, force: true });
    });

    const staged = async (
      targetPath: string,
      options: { files?: typeof fs; stage?: boolean; write?: (candidatePath: string) => Promise<void>; signal?: AbortSignal; log?: string[] } = {}
    ): Promise<{ result: unknown; candidatePath: string }> => {
      let candidatePath = '';
      const result = await writeDatabaseSnapshotAtomically(options.files ?? fs, undefined, targetPath, async (given) => {
        candidatePath = given;
        if (options.write) await options.write(given);
        // As VACUUM INTO creates its file: readable by everyone the umask lets.
        else await fs.promises.writeFile(given, 'new database bytes', { flag: 'wx', mode: 0o644 });
      }, options.signal, (_level, message) => { options.log?.push(message); }, undefined, undefined, options.stage ?? true);
      return { result, candidatePath };
    };
    /** A folder every account may write, in a scratch folder only this one can reach. */
    const shared = async (directory: string, mode = 0o777): Promise<string> => {
      const folder = path.join(directory, 'shared');
      await fs.promises.mkdir(folder);
      await fs.promises.chmod(folder, mode);
      return folder;
    };
    const underTemporaryFolder = (candidatePath: string): boolean => path.dirname(path.dirname(candidatePath)) === ownTemporary;
    /** The file calls as they answer where `folder` has the group of an account that is alone in it, or shares it with `members`. */
    const ownGroup = (folder: string, members = ''): typeof fs => {
      const uid = process.geteuid!();
      return new Proxy(fs, {
        get(real, key) {
          if (key === 'statSync') {
            return (file: fs.PathLike, ...rest: unknown[]) => {
              const stats = (real.statSync as (...given: unknown[]) => fs.BigIntStats)(file, ...rest);
              if (String(file) !== fs.realpathSync(folder)) return stats;
              return new Proxy(stats, {
                get(given, name) {
                  if (name === 'gid') return BigInt(uid);
                  const value = Reflect.get(given, name);
                  return typeof value === 'function' ? value.bind(given) : value;
                }
              });
            };
          }
          if (key === 'readFileSync') {
            return (file: fs.PathLike, ...rest: unknown[]) => (String(file) === '/etc/passwd' ? `me:x:${uid}:${uid}::/:/bin/sh\n`
              : String(file) === '/etc/group' ? `me:x:${uid}:${members}\n`
                : (real.readFileSync as (...given: unknown[]) => unknown)(file, ...rest));
          }
          return Reflect.get(real, key);
        }
      });
    };
    const stagesLeft = (): string[] => fs.readdirSync(ownTemporary).filter((entry) => entry.startsWith('sqlite-explorer-save-'));
    const failureOf = (failure: unknown): string =>
      String(failure instanceof AggregateError ? (failure.errors[0] as Error).message : (failure as Error)?.message);
    /**
     * Runs `around` for the one step that makes the save's file beside the destination: the open
     * through a descriptor on Linux, the helper process elsewhere. `around` gets the step to run.
     */
    const aroundMaking = (t: { mock: { method: (...given: never[]) => unknown } }, around: <T>(make: () => T) => T): typeof fs => {
      const spawnSync = childProcess.spawnSync;
      (t.mock.method as (...given: unknown[]) => unknown)(childProcess, 'spawnSync', (...args: unknown[]) => {
        const run = (): unknown => (spawnSync as (...given: unknown[]) => unknown)(...args);
        return args[0] === process.execPath ? around(run) : run();
      });
      return withCall('promises', (real) => new Proxy(real.promises, {
        get(promises, name) {
          if (name !== 'open') return Reflect.get(promises, name);
          return (file: fs.PathLike, flags: unknown, ...rest: unknown[]) => {
            const open = (): Promise<fs.promises.FileHandle> => (promises.open as (...given: unknown[]) => Promise<fs.promises.FileHandle>)(file, flags, ...rest);
            return flags === 'wx+' ? around(open) : open();
          };
        }
      }));
    };
    /** Makes `name` lead to `elsewhere` while `step` runs, and to the directory again afterwards. */
    const ledElsewhere = (folder: string, name: string, elsewhere: string) => <T>(step: () => T): T => {
      const made = privateDirectoryOf(folder, name);
      fs.renameSync(made, `${made}-ours`);
      fs.symlinkSync(elsewhere, made);
      const back = (): void => {
        fs.unlinkSync(made);
        fs.renameSync(`${made}-ours`, made);
      };
      let answer: T;
      try {
        answer = step();
      } catch (error) {
        back();
        throw error;
      }
      if (answer instanceof Promise) return answer.finally(back) as T;
      back();
      return answer;
    };
    /** The save's file calls, with one of them replaced. */
    const withCall = (name: string, replacement: (real: typeof fs) => unknown): typeof fs =>
      new Proxy(fs, { get: (real, key) => (key === name ? replacement(real) : Reflect.get(real, key)) });
    /** The save's file calls, with the handle it creates beside the destination changed by `wrap`. */
    const withCopyHandle = (wrap: (handle: fs.promises.FileHandle) => Partial<fs.promises.FileHandle>): typeof fs =>
      withCall('promises', (real) => new Proxy(real.promises, {
        get(promises, name) {
          if (name !== 'open') return Reflect.get(promises, name);
          return async (file: fs.PathLike, flags: unknown, ...rest: unknown[]) => {
            const handle = await (promises.open as (...given: unknown[]) => Promise<fs.promises.FileHandle>)(file, flags, ...rest);
            if (!isCopyOpen(flags)) return handle;
            const changed = wrap(handle);
            return new Proxy(handle, {
              get(given, property) {
                if (property in changed) return Reflect.get(changed, property);
                const value = Reflect.get(given, property);
                return typeof value === 'function' ? value.bind(given) : value;
              }
            });
          };
        }
      }));

    it('is written in the temporary folder and copied beside its destination only when complete', async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o600 });
        const content = Buffer.alloc(3 * 1024 * 1024 + 17, 0x61);

        const { result, candidatePath } = await staged(targetPath, { write: (given) => fs.promises.writeFile(given, content, { flag: 'wx', mode: 0o644 }) });

        assert.strictEqual(underTemporaryFolder(candidatePath), true, candidatePath);
        assertInstalled(result, targetPath, false);
        assert.ok((await fs.promises.readFile(targetPath)).equals(content));
        // The destination's own mode, not the one the other program gave its file.
        assert.strictEqual((await fs.promises.stat(targetPath)).mode & 0o777, 0o600);
        assert.deepStrictEqual(await fs.promises.readdir(folder), ['database.db']);
        assert.deepStrictEqual(stagesLeft(), []);
      });
    });

    it('gives a new destination the mode the other program gave its file, and its folder\'s group', async () => {
      await withScratchDirectory(async (directory) => {
        // A group this account is in that is not the one its new files get: a folder of a team.
        const team = process.getgroups!().find((group) => group !== process.getegid!());
        // Set-group-ID: on Linux that is what hands a folder's group to what is made in it.
        const folder = await shared(directory, 0o2777);
        if (team !== undefined) await fs.promises.chown(folder, -1, team);
        const targetPath = path.join(folder, 'new.db');

        const { candidatePath } = await staged(targetPath, {
          write: async (given) => {
            await fs.promises.writeFile(given, 'new database bytes', { flag: 'wx' });
            await fs.promises.chmod(given, 0o640);
          }
        });

        assert.strictEqual(underTemporaryFolder(candidatePath), true);
        const saved = await fs.promises.stat(targetPath);
        assert.strictEqual(saved.mode & 0o777, 0o640);
        // As a file made in that folder: not the group of the temporary folder it was first written in.
        assert.strictEqual(saved.gid, (await fs.promises.stat(folder)).gid);
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
      });
    });

    it('saves a new file on a filesystem that will not take the mode the other program gave it', async () => {
      await withScratchDirectory(async (directory) => {
        const targetPath = path.join(await shared(directory), 'new.db');
        // As FAT answers a mode it cannot keep: the file is this account's, and the change is refused.
        let refused = 0;
        const files = withCopyHandle(() => ({
          chmod: async () => {
            refused++;
            throw Object.assign(new Error('EPERM: operation not permitted, fchmod'), { code: 'EPERM' });
          }
        }));

        const log: string[] = [];

        await staged(targetPath, { files, log });

        assert.strictEqual(refused, 1);
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
        assert.deepStrictEqual(log.filter((message) => /mode/.test(message)), ['The new database keeps the mode its filesystem gave it.']);
      });
    });

    for (const [label, prepare, expected] of [
      ['a folder only this account can write', async (directory: string) => directory, false],
      ['a folder everyone can write that is sticky', async (directory: string) => shared(directory, 0o1777), false],
      ['a folder of its own inside one everyone can write', async (directory: string) => {
        const inner = path.join(await shared(directory), 'mine');
        await fs.promises.mkdir(inner, { mode: 0o700 });
        return inner;
      }, true]
    ] as const) {
      it(`${expected ? 'is' : 'is not'} staged for ${label}`, async () => {
        await withScratchDirectory(async (directory) => {
          const targetPath = path.join(await prepare(directory), 'database.db');
          await fs.promises.writeFile(targetPath, 'old database bytes');

          const { candidatePath } = await staged(targetPath);

          assert.strictEqual(underTemporaryFolder(candidatePath), expected, candidatePath);
          assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
        });
      });
    }

    it('hands an engine that writes its own snapshot a path through the descriptor, and stages it where there is none', async () => {
      await withScratchDirectory(async (directory) => {
        const targetPath = path.join(await shared(directory), 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');

        const { candidatePath } = await staged(targetPath, { stage: false });

        // Beside its destination through a descriptor of the directory made there, which costs nothing.
        // Where no such path is to be had its own create would go by name, so it writes in the
        // temporary folder like an engine in another process.
        assert.strictEqual(underTemporaryFolder(candidatePath), !throughDescriptor);
        if (throughDescriptor) assert.match(candidatePath, /^\/proc\/self\/fd\/\d+\/database\.db$/);
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
        assert.deepStrictEqual(await fs.promises.readdir(path.dirname(targetPath)), ['database.db']);
      });
    });

    it('goes by name for an engine that writes its own snapshot in a folder no other account can rename in', async () => {
      await withScratchDirectory(async (directory) => {
        const targetPath = path.join(directory, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');

        const { candidatePath } = await staged(targetPath, { stage: false });

        assert.strictEqual(fs.realpathSync(folderOf(candidatePath)), fs.realpathSync(directory));
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
      });
    });

    it('goes through the descriptor for such an engine when the folders above cannot be looked at, and says the directory was replaced when it is gone', {
      skip: !throughDescriptor && 'only Linux has the route through a descriptor'
    }, async () => {
      await withScratchDirectory(async (directory) => {
        // A folder of this account's own: by what can be seen of it, the route would be by name.
        const targetPath = path.join(directory, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        const resolved = fs.realpathSync(directory);
        const files = withCall('statSync', (real) => (file: fs.PathLike, ...rest: unknown[]) => {
          if (String(file) === resolved) throw Object.assign(new Error('EACCES: permission denied, stat'), { code: 'EACCES' });
          return (real.statSync as (...given: unknown[]) => unknown)(file, ...rest);
        });

        const { candidatePath } = await staged(targetPath, { files, stage: false });

        assert.match(candidatePath, /^\/proc\/self\/fd\/\d+\/database\.db$/);
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');

        // Removed by whoever can rename in the folder around it, before the engine makes its file.
        const folder = await shared(directory);
        const inShared = path.join(folder, 'database.db');
        const failure = await staged(inShared, {
          stage: false,
          write: async (given) => {
            fs.rmdirSync(privateDirectoryOf(folder, 'database.db'));
            await fs.promises.writeFile(given, 'new database bytes', { flag: 'wx' });
          }
        }).then(() => undefined, (error: unknown) => error);
        assert.match(failureOf(failure), /temporary directory was replaced/);
        assert.deepStrictEqual(await fs.promises.readdir(folder), []);
      });
    });

    it('sends an engine in this process through the descriptor in a folder only its own group can write as well', {
      skip: !throughDescriptor && 'only Linux has the route through a descriptor'
    }, async () => {
      await withScratchDirectory(async (directory) => {
        const folder = path.join(directory, 'project');
        await fs.promises.mkdir(folder);
        await fs.promises.chmod(folder, 0o775);
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');

        // Every group counts for it: that route costs nothing, and asking about a group costs a program start.
        const { candidatePath } = await staged(targetPath, { files: ownGroup(folder), stage: false });

        assert.match(candidatePath, /^\/proc\/self\/fd\/\d+\/database\.db$/);
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
        // An engine in another process is not staged there, which is what the rule for a group of one's own is for.
        if (fs.existsSync('/usr/bin/getfacl')) {
          const other = await staged(targetPath, { files: ownGroup(folder) });
          assert.strictEqual(fs.realpathSync(folderOf(other.candidatePath)), fs.realpathSync(folder));
        }
      });
    });

    // The engine in this process makes its snapshot's file itself, by the path it is given.
    for (const existing of [true, false]) {
      it(`has an engine that writes its own snapshot make it in the directory itself (${existing ? 'existing' : 'new'} destination)`, {
        skip: NO_FILE_SYMLINKS || ownDirectory.skip || (!throughDescriptor && 'without a path through a descriptor such an engine writes in the temporary folder')
      }, async () => {
        await withScratchDirectory(async (directory) => {
          const folder = await shared(directory);
          const elsewhere = path.join(directory, 'elsewhere');
          await fs.promises.mkdir(elsewhere, { mode: 0o777 });
          const targetPath = path.join(folder, 'database.db');
          if (existing) await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o600 });

          const failure = await staged(targetPath, {
            stage: false,
            write: async (given) => {
              const made = privateDirectoryOf(folder, 'database.db');
              fs.renameSync(made, `${made}-ours`);
              fs.symlinkSync(elsewhere, made);
              try {
                await fs.promises.writeFile(given, 'new database bytes', { flag: 'wx', mode: 0o640 });
              } finally {
                fs.unlinkSync(made);
                fs.renameSync(`${made}-ours`, made);
              }
            }
          }).then(() => undefined, (error: unknown) => error);

          assert.deepStrictEqual(await fs.promises.readdir(elsewhere), []);
          assert.strictEqual(failure, undefined);
          assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
          assert.deepStrictEqual(await fs.promises.readdir(folder), ['database.db']);
        });
      });
    }

    it('copies every byte when a write takes fewer than it was given', async () => {
      await withScratchDirectory(async (directory) => {
        const targetPath = path.join(await shared(directory), 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o644 });
        const content = Buffer.from(Array.from({ length: 2 * 1024 * 1024 + 4099 }, (_, index) => index % 251));
        // As a disk that fills, or a file size limit, answers: part of the bytes, and no error.
        let short = 0;
        const modes: number[] = [];
        const files = withCopyHandle((handle) => ({
          write: (async (buffer: Buffer, offset: number, length: number, position: number) => {
            short++;
            modes.push((await handle.stat()).mode & 0o777);
            return handle.write(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
          }) as fs.promises.FileHandle['write']
        }));

        await staged(targetPath, { files, write: (given) => fs.promises.writeFile(given, content, { flag: 'wx', mode: 0o644 }) });

        assert.ok(short > 3);
        assert.ok((await fs.promises.readFile(targetPath)).equals(content), 'the saved file is the snapshot, whole');
        // Only its owner could read it while it was written, whatever the destination's mode is.
        assert.deepStrictEqual([...new Set(modes)], [0o600]);
      });
    });

    it('stops copying when the save is cancelled, and leaves nothing', async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        const cancel = new AbortController();
        let writes = 0;
        const files = withCopyHandle((handle) => ({
          write: (async (...args: unknown[]) => {
            writes++;
            cancel.abort();
            return (handle.write as (...given: unknown[]) => Promise<unknown>)(...args);
          }) as fs.promises.FileHandle['write']
        }));

        const failure = await staged(targetPath, {
          files, signal: cancel.signal,
          write: (given) => fs.promises.writeFile(given, Buffer.alloc(3 * 1024 * 1024, 0x62), { flag: 'wx', mode: 0o644 })
        }).then(() => undefined, (error: unknown) => error);

        assert.strictEqual((failure as Error)?.name, 'AbortError', String(failure));
        assert.strictEqual(writes, 1);
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
        assert.deepStrictEqual(await fs.promises.readdir(folder), ['database.db']);
        assert.deepStrictEqual(stagesLeft(), []);
      });
    });

    // The private directory's name is given to something else at each of these moments: before
    // the save has looked at what it made, between its two looks (what it is, what it holds), and
    // right after them, when the save's next call on that name is the one that makes its file there.
    for (const moment of ['before the save has looked at its private directory', 'between its two looks', 'right after it has looked'] as const) {
      const swapping = (folder: string, swap: (made: string) => void): typeof fs => {
        const within = (made: string): boolean => path.dirname(made) === fs.realpathSync(folder);
        if (moment === 'before the save has looked at its private directory') {
          return withCall('mkdtempSync', (real) => (prefix: string) => {
            const made = real.mkdtempSync(prefix);
            if (within(made)) swap(made);
            return made;
          });
        }
        let swapped = false;
        const call = moment === 'between its two looks' ? 'lstatSync' : 'opendirSync';
        return withCall(call, (real) => (file: fs.PathLike, ...rest: unknown[]) => {
          const answer = (Reflect.get(real, call) as (...given: unknown[]) => unknown).call(real, file, ...rest);
          if (!swapped && within(String(file)) && String(file).includes('.sqlite-explorer-')) {
            swapped = true;
            swap(String(file));
          }
          return answer;
        });
      };

      it(`writes only into the directory it made (its name changed ${moment})`, { skip: NO_FILE_SYMLINKS || ownDirectory.skip }, async () => {
        await withScratchDirectory(async (directory) => {
          const folder = await shared(directory);
          const elsewhere = path.join(directory, 'elsewhere');
          await fs.promises.mkdir(elsewhere, { mode: 0o777 });
          const targetPath = path.join(folder, 'database.db');
          // A destination everyone may read: its mode must not reach a file that went astray.
          await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o644 });
          let listed = 0;
          let opened = 0;
          const swapped = swapping(folder, (made) => {
            fs.renameSync(made, `${made}-ours`);
            fs.symlinkSync(elsewhere, made);
          });
          const files = new Proxy(swapped, {
            get: (given, key) => {
              if (key === 'readdirSync') return (...args: unknown[]) => { listed++; return (fs.readdirSync as (...all: unknown[]) => unknown)(...args); };
              if (key !== 'opendirSync') return Reflect.get(given, key);
              return (...args: unknown[]) => {
                // Beside the destination: the directory in the temporary folder is opened too.
                if (path.dirname(String(args[0])) === fs.realpathSync(folder)) opened++;
                return (Reflect.get(given, key) as (...all: unknown[]) => unknown)(...args);
              };
            }
          });

          const failure = await staged(targetPath, { files }).then(() => undefined, (error: unknown) => error);

          assert.match(failureOf(failure), /temporary directory was replaced/);
          assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
          assert.strictEqual(listed, 0, 'what is under the name is never listed whole');
          // A link seen to be one is not followed.
          if (moment === 'before the save has looked at its private directory') assert.strictEqual(opened, 0);
          // At most an empty file only its owner can read went through the name, never the content,
          // and not even that when the link was there before the save first looked.
          if (moment === 'before the save has looked at its private directory') assert.deepStrictEqual(await fs.promises.readdir(elsewhere), []);
          for (const stray of await fs.promises.readdir(elsewhere)) {
            const found = await fs.promises.stat(path.join(elsewhere, stray));
            assert.deepStrictEqual([found.size, found.mode & 0o777], [0, 0o600], stray);
          }
          assert.deepStrictEqual(stagesLeft(), []);
        });
      });

      it(`replaces only its own destination (the directory's name changed ${moment})`, { skip: NO_FILE_SYMLINKS || ownDirectory.skip }, async () => {
        await withScratchDirectory(async (directory) => {
          const folder = await shared(directory);
          const elsewhere = path.join(directory, 'elsewhere');
          await fs.promises.mkdir(elsewhere);
          await fs.promises.writeFile(path.join(elsewhere, 'database.db'), 'another file of this account');
          const targetPath = path.join(folder, 'database.db');
          await fs.promises.writeFile(targetPath, 'old database bytes');
          const files = swapping(folder, (made) => {
            fs.renameSync(made, `${made}-ours`);
            fs.symlinkSync(elsewhere, made);
          });

          await assert.rejects(staged(targetPath, { files }));

          assert.strictEqual(await fs.promises.readFile(path.join(elsewhere, 'database.db'), 'utf8'), 'another file of this account');
          assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
          assert.deepStrictEqual(stagesLeft(), []);
        });
      });

      it(`leaves another directory of this account's as it was (the directory's name changed ${moment})`, async () => {
        await withScratchDirectory(async (directory) => {
          const folder = await shared(directory);
          const backup = path.join(folder, 'backup');
          await fs.promises.mkdir(backup);
          await fs.promises.writeFile(path.join(backup, 'database.db'), 'another file of this account');
          const targetPath = path.join(folder, 'database.db');
          await fs.promises.writeFile(targetPath, 'old database bytes');
          let moved = '';
          const files = swapping(folder, (made) => {
            fs.renameSync(made, `${made}-ours`);
            fs.renameSync(backup, made);
            moved = made;
          });

          await assert.rejects(staged(targetPath, { files }));

          // Neither written among nor cleaned up: the directory and its file are there, under the name they were given.
          assert.strictEqual(await fs.promises.readFile(path.join(moved, 'database.db'), 'utf8'), 'another file of this account');
          assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
          assert.deepStrictEqual(stagesLeft(), []);
        });
      });
    }

    it('copies only into the file it made (the name changed while the file was made)', { skip: NO_FILE_SYMLINKS || ownDirectory.skip }, async (t) => {
      for (const behind of ['nothing', 'a file of the same name'] as const) {
        await withScratchDirectory(async (directory) => {
          const folder = await shared(directory);
          const elsewhere = path.join(directory, 'elsewhere');
          await fs.promises.mkdir(elsewhere, { mode: 0o777 });
          if (behind !== 'nothing') await fs.promises.writeFile(path.join(elsewhere, 'new.db'), 'another file of this account');
          const targetPath = path.join(folder, 'new.db');
          // Two changes of name: a link under the private directory's name for the one step
          // that makes the file, and the directory back under its name before the save looks again.
          const files = aroundMaking(t, ledElsewhere(folder, 'new.db', elsewhere));

          const failure = await staged(targetPath, { files }).then(() => undefined, (error: unknown) => error);
          t.mock.restoreAll();

          // Nothing of the save is where the name led, and what was there is as it was.
          assert.deepStrictEqual(await fs.promises.readdir(elsewhere), behind === 'nothing' ? [] : ['new.db']);
          if (behind !== 'nothing') assert.strictEqual(await fs.promises.readFile(path.join(elsewhere, 'new.db'), 'utf8'), 'another file of this account');
          assert.deepStrictEqual(stagesLeft(), []);
          if (throughDescriptor) {
            // Made in the directory itself, whatever its name led to: the save is done.
            assert.strictEqual(failure, undefined, behind);
            assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
            assert.deepStrictEqual(await fs.promises.readdir(folder), ['new.db']);
          } else {
            // The helper process found itself in another directory than the one made, and made nothing.
            assert.match(failureOf(failure), /temporary directory was replaced/, behind);
            assert.strictEqual(fs.existsSync(targetPath), false);
          }
        });
      }
    });

    it('does not go on with a directory that has another owner at a later look', async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        // A filesystem can give a removed directory's number to the next one made under the name:
        // here the directory has that number and another owner from the second look on.
        let looks = 0;
        let written = 0;
        const owner = withCall('lstatSync', (real) => (file: fs.PathLike, options?: fs.StatSyncOptions) => {
          const stats = real.lstatSync(file, options) as fs.BigIntStats;
          if (!String(file).endsWith(path.join('shared', path.basename(String(file)))) || !path.basename(String(file)).startsWith('.database.db.sqlite-explorer-')) return stats;
          if (++looks === 1) return stats;
          return new Proxy(stats, {
            get(given, name) {
              if (name === 'uid') return given.uid + 1n;
              const value = Reflect.get(given, name);
              return typeof value === 'function' ? value.bind(given) : value;
            }
          });
        });
        const counting = withCopyHandle((handle) => ({
          write: (async (...args: unknown[]) => {
            written++;
            return (handle.write as (...given: unknown[]) => Promise<unknown>)(...args);
          }) as fs.promises.FileHandle['write']
        }));
        const files = new Proxy(owner, { get: (given, key) => (key === 'promises' ? counting.promises : Reflect.get(given, key)) });

        const failure = await staged(targetPath, { files }).then(() => undefined, (error: unknown) => error);

        assert.ok(looks >= 2);
        assert.match(failureOf(failure), /temporary directory was replaced/);
        assert.strictEqual(written, 0);
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
      });
    });

    // Another folder is put under the destination's path while the engine writes, with a link in it
    // that leads to the real file.
    for (const existing of [true, false]) {
      it(`refuses when the destination's folder is another one by the time the engine has written (${existing ? 'existing' : 'new'} destination)`, { skip: NO_FILE_SYMLINKS || ownDirectory.skip }, async () => {
        await withScratchDirectory(async (directory) => {
          const open = await shared(directory);
          const mine = path.join(open, 'mine');
          await fs.promises.mkdir(mine, { mode: 0o700 });
          const targetPath = path.join(mine, 'database.db');
          if (existing) await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o644 });
          const away = path.join(open, 'mine-away');
          let madeThere = 0;
          const files = withCall('mkdtempSync', (real) => (prefix: string) => {
            if (fs.existsSync(away) && path.dirname(prefix).endsWith(`${path.sep}mine`)) madeThere++;
            return real.mkdtempSync(prefix);
          });

          const failure = await staged(targetPath, {
            files,
            write: async (given) => {
              await fs.promises.writeFile(given, 'new database bytes', { flag: 'wx', mode: 0o644 });
              fs.renameSync(mine, away);
              fs.mkdirSync(mine, { mode: 0o777 });
              if (existing) fs.symlinkSync(path.join(away, 'database.db'), path.join(mine, 'database.db'));
            }
          }).then(() => undefined, (error: unknown) => error);

          assert.match(failureOf(failure), /Database save target changed during the save/);
          assert.strictEqual(madeThere, 0, 'not even a directory was made in the folder put there');
          // Nothing of the save is in the folder put there, and the real file is as it was.
          assert.deepStrictEqual(await fs.promises.readdir(mine), existing ? ['database.db'] : []);
          if (existing) {
            assert.strictEqual((await fs.promises.lstat(path.join(mine, 'database.db'))).isSymbolicLink(), true);
            assert.strictEqual(await fs.promises.readFile(path.join(away, 'database.db'), 'utf8'), 'old database bytes');
          }
          assert.deepStrictEqual(stagesLeft(), []);
        });
      });
    }

    it('reports a cancel during the engine\'s write as that cancel', async () => {
      await withScratchDirectory(async (directory) => {
        const targetPath = path.join(await shared(directory), 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        // The reason a signal gives by default, whose text cannot be changed, and one given to it, whose text can.
        for (const reason of [undefined, new Error('Canceled')]) {
          const cancel = new AbortController();

          const failure = await staged(targetPath, {
            signal: cancel.signal,
            // As the native engine rejects a cancelled call: with the signal's own reason.
            write: async () => { cancel.abort(reason); throw cancel.signal.reason; }
          }).then(() => undefined, (error: unknown) => error);

          assert.strictEqual(failure, cancel.signal.reason);
          assert.strictEqual((failure as Error).message.includes('snapshot is written in'), false);
          assert.deepStrictEqual(stagesLeft(), []);
        }
      });
    });

    it('writes no content into a directory of another owner', async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'new.db');
        // Every look at the directory is answered as for one with another owner.
        let looked = false;
        let written = 0;
        const owner = withCall('lstatSync', (real) => (file: fs.PathLike, options?: fs.StatSyncOptions) => {
          const stats = real.lstatSync(file, options) as fs.BigIntStats;
          if (!String(file).includes('.new.db.sqlite-explorer-') || path.dirname(String(file)) !== fs.realpathSync(folder)) return stats;
          looked = true;
          return new Proxy(stats, {
            get(given, name) {
              if (name === 'uid') return given.uid + 1n;
              const value = Reflect.get(given, name);
              return typeof value === 'function' ? value.bind(given) : value;
            }
          });
        });
        let made = 0;
        const counting = withCopyHandle((handle) => {
          made++;
          return {
            write: (async (...args: unknown[]) => {
              written++;
              return (handle.write as (...given: unknown[]) => Promise<unknown>)(...args);
            }) as fs.promises.FileHandle['write']
          };
        });
        const files = new Proxy(owner, { get: (given, key) => (key === 'promises' ? counting.promises : Reflect.get(given, key)) });

        const failure = await staged(targetPath, { files }).then(() => undefined, (error: unknown) => error);

        assert.strictEqual(looked, true);
        assert.match(failureOf(failure), /temporary directory was replaced/);
        // Refused before any file was made: the descriptor is compared with the directory first, and
        // the helper process compares the directory it finds itself in.
        assert.strictEqual(made, 0);
        assert.strictEqual(written, 0);
        assert.strictEqual(fs.existsSync(targetPath), false);
        assert.deepStrictEqual(stagesLeft(), []);
      });
    });

    it('refuses when other accounts can rename in the temporary folder as well, also behind a link', { skip: NO_FILE_SYMLINKS || ownDirectory.skip }, async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        // A folder of this account's own, inside one everyone can rename in.
        const open = path.join(directory, 'open');
        await fs.promises.mkdir(open);
        await fs.promises.chmod(open, 0o777);
        const inner = path.join(open, 'inner');
        await fs.promises.mkdir(inner, { mode: 0o700 });
        const link = path.join(directory, 'temporary-link');
        await fs.promises.symlink(inner, link);
        for (const temporary of [inner, link]) {
          let wrote = false;
          process.env.TMPDIR = temporary;
          await assert.rejects(
            staged(targetPath, { write: async () => { wrote = true; } }),
            /Other accounts may be able to rename what is in '.*shared', which the destination is in or under, and in '.*open', which the temporary folder '.*inner' is or is under, so the save cannot keep the database from them\. Set TMPDIR to a folder that no other account can write, under folders none can write\. On Linux a folder only its own group can write is told from a shared one by getfacl, which must be installed for that\./,
            temporary
          );
          assert.strictEqual(wrote, false);
        }
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
        assert.deepStrictEqual(await fs.promises.readdir(inner), []);
      });
    });

    it('names the temporary folder when it cannot be used, and when it has no room', async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');

        process.env.TMPDIR = path.join(directory, 'missing');
        await assert.rejects(staged(targetPath), /The temporary folder '.*missing' cannot be used: ENOENT/);

        process.env.TMPDIR = ownTemporary;
        // A quota answers "disk I/O error", not "full": whatever the engine reports, the folder is named.
        for (const text of ['database or disk is full', 'disk I/O error']) {
          await assert.rejects(
            staged(targetPath, { write: async () => { throw new Error(text); } }),
            new RegExp(`^Error: ${text} \\(the snapshot is written in '.*sqlite-explorer-save-.*' first\\)$`)
          );
        }
        // The engine's own error is left as it was: an engine may keep one and throw it again.
        const kept = Object.assign(new Error('the file changed on disk'), { code: 'KEPT' });
        for (let again = 0; again < 2; again++) {
          const failure = await staged(targetPath, { write: async () => { throw kept; } }).then(() => undefined, (error: unknown) => error) as Error & { code?: string };
          assert.match(failure.message, /^the file changed on disk \(the snapshot is written in '[^']*' first\)$/);
          assert.strictEqual(failure.cause, kept);
          assert.strictEqual(failure.code, 'KEPT');
          assert.strictEqual(kept.message, 'the file changed on disk');
        }
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
        assert.deepStrictEqual(await fs.promises.readdir(folder), ['database.db']);
        assert.deepStrictEqual(stagesLeft(), []);
      });
    });

    it('says which directory remains when the one in the temporary folder cannot be removed after a save', async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        const busy = Object.assign(new Error('EBUSY: resource busy or locked, rm'), { code: 'EBUSY' });
        const files = withCall('rmSync', (real) => (file: fs.PathLike, options?: fs.RmOptions) => {
          if (path.dirname(String(file)) === ownTemporary) throw busy;
          return real.rmSync(file, options);
        });
        const log: string[] = [];

        await staged(targetPath, { files, log });

        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
        const left = stagesLeft();
        assert.strictEqual(left.length, 1);
        assert.deepStrictEqual(log.filter((message) => /remains/.test(message)), [`Database saved, but its temporary directory remains: ${path.join(ownTemporary, left[0])}`]);
        // The other one, beside the destination, is removed all the same.
        assert.deepStrictEqual(await fs.promises.readdir(folder), ['database.db']);
      });
    });

    it('makes its file through a descriptor of its directory on Linux, and has a helper process make it elsewhere', async (t) => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'new.db');
        const opened: Array<[string, unknown]> = [];
        const helpers: string[][] = [];
        const spawnSync = childProcess.spawnSync;
        t.mock.method(childProcess, 'spawnSync', ((...args: unknown[]) => {
          if (args[0] === process.execPath) helpers.push((args[1] as string[]).slice(3));
          return (spawnSync as (...given: unknown[]) => unknown)(...args);
        }) as typeof childProcess.spawnSync);
        const files = withCall('promises', (real) => new Proxy(real.promises, {
          get(promises, name) {
            if (name !== 'open') return Reflect.get(promises, name);
            return async (file: fs.PathLike, flags: unknown, ...rest: unknown[]) => {
              if (isCopyOpen(flags)) opened.push([String(file), flags]);
              return (promises.open as (...given: unknown[]) => Promise<fs.promises.FileHandle>)(file, flags, ...rest);
            };
          }
        }));

        await staged(targetPath, { files });

        assert.strictEqual(opened.length, 1);
        if (throughDescriptor) {
          assert.match(opened[0][0], /^\/proc\/self\/fd\/\d+\/new\.db$/);
          assert.strictEqual(opened[0][1], 'wx+');
          assert.deepStrictEqual(helpers, []);
        } else {
          // One helper process, told the directory, what it must be (device, number, owner) and the
          // file's name. The save then opens what is under that name, without making or following anything.
          assert.strictEqual(helpers.length, 1);
          assert.strictEqual(fs.realpathSync(path.dirname(helpers[0][0])), fs.realpathSync(folder));
          assert.match(helpers[0].slice(1, 4).join(' '), /^-?\d+ -?\d+ \d+$/);
          assert.strictEqual(helpers[0][4], 'new.db');
          assert.strictEqual(opened[0][0], path.join(helpers[0][0], 'new.db'));
          assert.strictEqual(opened[0][1], MADE_BY_HELPER);
        }
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
        assert.strictEqual((await fs.promises.stat(targetPath)).mode & 0o777, 0o644);
        assert.deepStrictEqual(await fs.promises.readdir(folder), ['new.db']);
        assert.deepStrictEqual(stagesLeft(), []);
      });
    });

    it('fails the save, and makes nothing by name, when the helper process cannot be run', { skip: throughDescriptor && 'only where no path through a descriptor is to be had' }, async (t) => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        const spawnSync = childProcess.spawnSync;
        for (const [how, answer] of [
          ['is not there', { error: Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT' }), status: null, stdout: '', stderr: '' }],
          ['ends badly', { status: 4, stdout: '', stderr: 'EEXIST: file already exists' }],
          ['answers what is not a file\'s identity', { status: 0, stdout: 'made', stderr: '' }]
        ] as const) {
          t.mock.method(childProcess, 'spawnSync', ((...args: unknown[]) =>
            (args[0] === process.execPath ? answer : (spawnSync as (...given: unknown[]) => unknown)(...args))) as typeof childProcess.spawnSync);
          let opened = 0;
          const files = withCopyHandle(() => { opened++; return {}; });

          await assert.rejects(staged(targetPath, { files }), /The save could not make its file beside the destination: the helper process failed \(.+\)\. The file was not changed\./, how);
          t.mock.restoreAll();

          assert.strictEqual(opened, 0, how);
          assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
          assert.deepStrictEqual(await fs.promises.readdir(folder), ['database.db'], how);
          assert.deepStrictEqual(stagesLeft(), []);
        }
      });
    });

    it('writes into no other file than the one the helper process made, though every look by name finds that other', {
      skip: (throughDescriptor && 'only where no path through a descriptor is to be had') || NO_FILE_SYMLINKS
    }, async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const elsewhere = path.join(directory, 'elsewhere');
        await fs.promises.mkdir(elsewhere, { mode: 0o777 });
        // Another file of the same name, which this account may write.
        await fs.promises.writeFile(path.join(elsewhere, 'database.db'), 'theirs', { mode: 0o666 });
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        // The helper process makes the file in the directory, undisturbed. From then on the name
        // leads elsewhere for the save's open of the file and for each look at it, and to the
        // directory itself whenever the directory is looked at.
        const led = ledElsewhere(folder, 'database.db', elsewhere);
        const files = new Proxy(fs, {
          get(real, key) {
            if (key === 'lstatSync') {
              return (file: fs.PathLike, ...rest: unknown[]) => {
                const look = (): unknown => (real.lstatSync as (...all: unknown[]) => unknown)(file, ...rest);
                const byName = path.basename(String(file)) === 'database.db' && path.basename(path.dirname(String(file))).startsWith('.database.db.sqlite-explorer-');
                return byName ? led(look) : look();
              };
            }
            if (key !== 'promises') return Reflect.get(real, key);
            return new Proxy(real.promises, {
              get(promises, name) {
                if (name !== 'open') return Reflect.get(promises, name);
                return (file: fs.PathLike, flags: unknown, ...rest: unknown[]) => {
                  const open = (): Promise<fs.promises.FileHandle> => (promises.open as (...all: unknown[]) => Promise<fs.promises.FileHandle>)(file, flags, ...rest);
                  return flags === MADE_BY_HELPER ? led(open) : open();
                };
              }
            });
          }
        });

        const failure = await staged(targetPath, { files }).then(() => undefined, (error: unknown) => error);

        assert.match(failureOf(failure), /temporary directory was replaced/);
        assert.strictEqual(await fs.promises.readFile(path.join(elsewhere, 'database.db'), 'utf8'), 'theirs');
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
      });
    });

    it('takes for its own only the very file the helper process made', { skip: (throughDescriptor && 'only where no path through a descriptor is to be had') || NO_FILE_SYMLINKS }, async (t) => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const elsewhere = path.join(directory, 'elsewhere');
        await fs.promises.mkdir(elsewhere, { mode: 0o777 });
        // Another file of the same name, which this account may write.
        await fs.promises.writeFile(path.join(elsewhere, 'database.db'), 'theirs', { mode: 0o666 });
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        // The helper process makes the file in the directory. Then the name leads elsewhere for the
        // save's own open, which finds that other file under it.
        const spawnSync = childProcess.spawnSync;
        t.mock.method(childProcess, 'spawnSync', ((...args: unknown[]) => {
          const answer = (spawnSync as (...given: unknown[]) => unknown)(...args);
          if (args[0] === process.execPath) {
            const made = privateDirectoryOf(folder, 'database.db');
            fs.renameSync(made, `${made}-ours`);
            fs.symlinkSync(elsewhere, made);
          }
          return answer;
        }) as typeof childProcess.spawnSync);
        let written = 0;
        const files = withCopyHandle((handle) => ({
          write: (async (...args: unknown[]) => {
            written++;
            return (handle.write as (...given: unknown[]) => Promise<unknown>)(...args);
          }) as fs.promises.FileHandle['write']
        }));

        const failure = await staged(targetPath, { files }).then(() => undefined, (error: unknown) => error);

        assert.match(failureOf(failure), /temporary directory was replaced/);
        assert.strictEqual(written, 0);
        assert.strictEqual(await fs.promises.readFile(path.join(elsewhere, 'database.db'), 'utf8'), 'theirs');
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
      });
    });

    // The name leading to another folder for the step that makes the file, for the save's
    // open of it and for each look at that file, and to the directory itself whenever the directory
    // is looked at.
    it('puts content only in the directory it made (its name changed while the file was made and at each look)', {
      skip: NO_FILE_SYMLINKS || ownDirectory.skip
    }, async (t) => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const elsewhere = path.join(directory, 'elsewhere');
        await fs.promises.mkdir(elsewhere, { mode: 0o777 });
        const targetPath = path.join(folder, 'new.db');
        const led = ledElsewhere(folder, 'new.db', elsewhere);
        const making = aroundMaking(t, led);
        const files = new Proxy(making, {
          get(given, key) {
            if (key === 'lstatSync') {
              return (file: fs.PathLike, ...rest: unknown[]) => {
                const look = (): unknown => (fs.lstatSync as (...all: unknown[]) => unknown)(file, ...rest);
                // A look at the file by the directory's name, not a look at the directory.
                const byName = path.basename(String(file)) === 'new.db' && path.basename(path.dirname(String(file))).startsWith('.new.db.sqlite-explorer-');
                return byName ? led(look) : look();
              };
            }
            if (key !== 'promises') return Reflect.get(given, key);
            return new Proxy(given.promises, {
              get(promises, name) {
                if (name !== 'open') return Reflect.get(promises, name);
                return (file: fs.PathLike, flags: unknown, ...rest: unknown[]) => {
                  const open = (): Promise<fs.promises.FileHandle> => (promises.open as (...all: unknown[]) => Promise<fs.promises.FileHandle>)(file, flags, ...rest);
                  // The save's open of the file a helper process made.
                  return flags === MADE_BY_HELPER ? led(open) : open();
                };
              }
            });
          }
        });

        const failure = await staged(targetPath, { files }).then(() => undefined, (error: unknown) => error);

        // Whatever became of the save, nothing of the database is where the name led.
        assert.deepStrictEqual(await fs.promises.readdir(elsewhere), []);
        if (throughDescriptor) {
          assert.strictEqual(failure, undefined);
          assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
        } else {
          assert.match(failureOf(failure), /temporary directory was replaced/);
          assert.strictEqual(fs.existsSync(targetPath), false);
        }
      });
    });

    it('makes nothing by name when its directory is removed before the file is made', {
      skip: (!throughDescriptor && 'only the route through a descriptor has another one it could fall back to') || NO_FILE_SYMLINKS
    }, async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const elsewhere = path.join(directory, 'elsewhere');
        await fs.promises.mkdir(elsewhere, { mode: 0o777 });
        const targetPath = path.join(folder, 'new.db');
        // An empty directory can be removed by whoever can rename in the folder around it.
        let removed = false;
        const attempts: string[] = [];
        const files = withCall('promises', (real) => new Proxy(real.promises, {
          get(promises, name) {
            if (name !== 'open') return Reflect.get(promises, name);
            return async (file: fs.PathLike, flags: unknown, ...rest: unknown[]) => {
              if (flags === 'wx+') attempts.push(String(file));
              if (flags === 'wx+' && !removed) {
                removed = true;
                const made = privateDirectoryOf(folder, 'new.db');
                fs.rmdirSync(made);
                fs.symlinkSync(elsewhere, made);
              }
              return (promises.open as (...given: unknown[]) => Promise<fs.promises.FileHandle>)(file, flags, ...rest);
            };
          }
        }));

        const failure = await staged(targetPath, { files }).then(() => undefined, (error: unknown) => error);

        assert.match(failureOf(failure), /temporary directory was replaced/);
        // One attempt, through the descriptor: the name was not tried after it.
        assert.deepStrictEqual(attempts.map((attempt) => attempt.startsWith('/proc/self/fd/')), [true]);
        assert.deepStrictEqual(await fs.promises.readdir(elsewhere), []);
        assert.strictEqual(fs.existsSync(targetPath), false);
        assert.deepStrictEqual(stagesLeft(), []);
      });
    });

    it('leaves no descriptor open, however the save ends', { skip: !throughDescriptor && 'only the route through a descriptor holds one' }, async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        const open = (): number => fs.readdirSync('/proc/self/fd').length;
        await staged(targetPath);
        const before = open();

        await staged(targetPath);
        assert.strictEqual(open(), before, 'after a save');

        // The directory is another owner's by the time its descriptor is compared with it.
        const owner = withCall('lstatSync', (real) => (file: fs.PathLike, options?: fs.StatSyncOptions) => {
          const stats = real.lstatSync(file, options) as fs.BigIntStats;
          if (!String(file).includes('.database.db.sqlite-explorer-') || path.dirname(String(file)) !== fs.realpathSync(folder)) return stats;
          return new Proxy(stats, {
            get(given, name) {
              if (name === 'uid') return given.uid + 1n;
              const value = Reflect.get(given, name);
              return typeof value === 'function' ? value.bind(given) : value;
            }
          });
        });
        await assert.rejects(staged(targetPath, { files: owner }), /temporary directory was replaced/);
        assert.strictEqual(open(), before, 'after a refusal');

        const cancel = new AbortController();
        const cancelling = withCopyHandle((handle) => ({
          write: (async (...args: unknown[]) => {
            cancel.abort();
            return (handle.write as (...given: unknown[]) => Promise<unknown>)(...args);
          }) as fs.promises.FileHandle['write']
        }));
        await assert.rejects(staged(targetPath, { files: cancelling, signal: cancel.signal }), { name: 'AbortError' });
        assert.strictEqual(open(), before, 'after a cancel');

        await assert.rejects(staged(targetPath, { write: async () => { throw new Error('disk I/O error'); } }), /disk I\/O error/);
        assert.strictEqual(open(), before, 'after an engine failure');

        // An engine in this process, done and failed.
        await staged(targetPath, { stage: false });
        assert.strictEqual(open(), before, 'after a save by an engine in this process');
        await assert.rejects(staged(targetPath, { stage: false, write: async () => { throw new Error('disk I/O error'); } }), /disk I\/O error/);
        assert.strictEqual(open(), before, 'after that engine failed');
        assert.deepStrictEqual(await fs.promises.readdir(folder), ['database.db']);
      });
    });

    it('has a helper process make the file where /proc does not lead to the descriptor', { skip: !throughDescriptor && 'only the route through a descriptor needs /proc' }, async (t) => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'new.db');
        let helpers = 0;
        const spawnSync = childProcess.spawnSync;
        t.mock.method(childProcess, 'spawnSync', ((...args: unknown[]) => {
          if (args[0] === process.execPath) helpers++;
          return (spawnSync as (...given: unknown[]) => unknown)(...args);
        }) as typeof childProcess.spawnSync);
        // No /proc at all, and one whose entry for a descriptor is not what the descriptor is open on.
        for (const how of ['missing', 'another file'] as const) {
          const files = withCall('statSync', (real) => (file: fs.PathLike, ...rest: unknown[]) => {
            if (!String(file).startsWith('/proc/')) return (real.statSync as (...given: unknown[]) => unknown)(file, ...rest);
            if (how === 'missing') throw Object.assign(new Error('ENOENT: no such file or directory, stat'), { code: 'ENOENT' });
            const stats = (real.statSync as (...given: unknown[]) => fs.BigIntStats)(file, ...rest);
            return new Proxy(stats, {
              get(given, name) {
                if (name === 'dev') return given.dev + 1n;
                const value = Reflect.get(given, name);
                return typeof value === 'function' ? value.bind(given) : value;
              }
            });
          });
          const log: string[] = [];
          helpers = 0;

          // An engine in another process, and one in this process: without such a path both are staged.
          for (const stage of [true, false]) {
            const { candidatePath } = await staged(targetPath, { files, log, stage });
            assert.strictEqual(underTemporaryFolder(candidatePath), true, `${how}, ${stage}`);
            assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
            await fs.promises.rm(targetPath);
          }
          assert.strictEqual(helpers, 2, how);
          assert.deepStrictEqual(log, []);
          assert.deepStrictEqual(await fs.promises.readdir(folder), []);
        }
      });
    });

    it('opens the destination\'s folder before the engine writes, and keeps it open until the rename', async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        const resolved = fs.realpathSync(folder);
        // In the order they happen: the folder opened, the engine's write, the rename, the folder closed.
        const events: string[] = [];
        const files = new Proxy(fs, {
          get(real, key) {
            if (key === 'renameSync') {
              return (from: fs.PathLike, to: fs.PathLike) => {
                events.push('rename');
                return real.renameSync(from, to);
              };
            }
            if (key !== 'promises') return Reflect.get(real, key);
            return new Proxy(real.promises, {
              get(promises, name) {
                if (name !== 'open') return Reflect.get(promises, name);
                return async (file: fs.PathLike, flags: unknown, ...rest: unknown[]) => {
                  const handle = await (promises.open as (...given: unknown[]) => Promise<fs.promises.FileHandle>)(file, flags, ...rest);
                  if (String(file) !== resolved) return handle;
                  events.push('folder opened');
                  return new Proxy(handle, {
                    get(given, property) {
                      if (property === 'close') return async () => { events.push('folder closed'); return given.close(); };
                      const value = Reflect.get(given, property);
                      return typeof value === 'function' ? value.bind(given) : value;
                    }
                  });
                };
              }
            });
          }
        });

        await staged(targetPath, { files, write: async (given) => { events.push('engine writes'); await fs.promises.writeFile(given, 'new database bytes', { flag: 'wx', mode: 0o644 }); } });

        assert.deepStrictEqual(events, ['folder opened', 'engine writes', 'rename', 'folder closed']);
      });
    });

    it(`${throughDescriptor ? 'removes its snapshot from the directory it made' : 'removes nothing'} when that directory's name leads elsewhere by the time a save fails`, { skip: NO_FILE_SYMLINKS || ownDirectory.skip }, async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const elsewhere = path.join(directory, 'elsewhere');
        await fs.promises.mkdir(elsewhere, { mode: 0o777 });
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        const cancel = new AbortController();
        let moved = '';
        const files = withCopyHandle((handle) => ({
          write: (async (...args: unknown[]) => {
            const made = privateDirectoryOf(folder, 'database.db');
            moved = `${made}-ours`;
            fs.renameSync(made, moved);
            fs.symlinkSync(elsewhere, made);
            cancel.abort();
            return (handle.write as (...given: unknown[]) => Promise<unknown>)(...args);
          }) as fs.promises.FileHandle['write']
        }));

        const failure = await staged(targetPath, { files, signal: cancel.signal }).then(() => undefined, (error: unknown) => error);

        assert.match(String((failure as Error)?.message), /temporary cleanup also failed/);
        // By name the owner-only snapshot stays in the directory that was moved away.
        assert.deepStrictEqual(await fs.promises.readdir(moved), throughDescriptor ? [] : ['database.db']);
        assert.deepStrictEqual(await fs.promises.readdir(elsewhere), []);
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
        assert.deepStrictEqual(stagesLeft(), []);
      });
    });

    for (const existing of [true, false]) {
      it(`gives its snapshot no wider mode once the destination's folder is another one (${existing ? 'existing' : 'new'} destination)`, async () => {
        await withScratchDirectory(async (directory) => {
          const open = await shared(directory);
          const mine = path.join(open, 'mine');
          await fs.promises.mkdir(mine, { mode: 0o700 });
          const targetPath = path.join(mine, 'database.db');
          if (existing) await fs.promises.writeFile(targetPath, 'old database bytes', { mode: 0o644 });
          const away = path.join(open, 'mine-away');
          // While the content is copied: the folder moved away, and another put under its path.
          const widened: string[] = [];
          let swapped = false;
          const files = withCopyHandle((handle) => ({
            write: (async (...args: unknown[]) => {
              if (!swapped) {
                swapped = true;
                fs.renameSync(mine, away);
                fs.mkdirSync(mine, { mode: 0o777 });
              }
              return (handle.write as (...given: unknown[]) => Promise<unknown>)(...args);
            }) as fs.promises.FileHandle['write'],
            chmod: (async (mode: number) => {
              widened.push(`chmod ${mode.toString(8)}`);
              return handle.chmod(mode);
            }) as fs.promises.FileHandle['chmod'],
            chown: (async (uid: number, gid: number) => {
              widened.push('chown');
              return handle.chown(uid, gid);
            }) as fs.promises.FileHandle['chown']
          }));

          const failure = await staged(targetPath, { files }).then(() => undefined, (error: unknown) => error);

          assert.match(failureOf(failure), /Database save target changed during the save/);
          assert.deepStrictEqual(widened, []);
          assert.deepStrictEqual(await fs.promises.readdir(mine), []);
          assert.deepStrictEqual(stagesLeft(), []);
        });
      });
    }

    it('passes on an ordinary failure to look into its new directory as it is', async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        // A process out of descriptors: nothing was put under the name.
        const files = withCall('opendirSync', (real) => (file: fs.PathLike, ...rest: unknown[]) => {
          if (path.dirname(String(file)) === fs.realpathSync(folder)) throw Object.assign(new Error('EMFILE: too many open files, opendir'), { code: 'EMFILE' });
          return (real.opendirSync as (...given: unknown[]) => unknown)(file, ...rest);
        });

        const failure = await staged(targetPath, { files }).then(() => undefined, (error: unknown) => error);

        assert.match(failureOf(failure), /^EMFILE/);
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
        assert.deepStrictEqual(stagesLeft(), []);
      });
    });

    it('copies nothing when another file is under its snapshot\'s name', async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'new.db');
        let written = 0;
        const other = withCall('lstatSync', (real) => (file: fs.PathLike, options?: fs.StatSyncOptions) => {
          const stats = real.lstatSync(file, options) as fs.BigIntStats;
          // The snapshot under its name in the private directory, not the destination of the same name.
          if (path.basename(String(file)) !== 'new.db' || path.dirname(String(file)) === fs.realpathSync(folder)) return stats;
          return new Proxy(stats, {
            get(given, name) {
              if (name === 'ino') return given.ino + 1n;
              const value = Reflect.get(given, name);
              return typeof value === 'function' ? value.bind(given) : value;
            }
          });
        });
        const counting = withCopyHandle((handle) => ({
          write: (async (...args: unknown[]) => {
            written++;
            return (handle.write as (...given: unknown[]) => Promise<unknown>)(...args);
          }) as fs.promises.FileHandle['write']
        }));
        const files = new Proxy(other, { get: (given, key) => (key === 'promises' ? counting.promises : Reflect.get(given, key)) });

        const failure = await staged(targetPath, { files }).then(() => undefined, (error: unknown) => error);

        assert.match(failureOf(failure), /temporary directory was replaced/);
        assert.strictEqual(written, 0);
        assert.strictEqual(fs.existsSync(targetPath), false);
        assert.deepStrictEqual(stagesLeft(), []);
      });
    });

    it('leaves alone another directory found under its private directory\'s name after the rename', async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        let put = '';
        const files = withCall('renameSync', (real) => (from: fs.PathLike, to: fs.PathLike) => {
          real.renameSync(from, to);
          if (path.basename(String(to)) !== 'database.db' || put !== '') return;
          // The emptied directory moved away, and another empty one put under its name.
          put = privateDirectoryOf(folder, 'database.db');
          fs.renameSync(put, `${put}-ours`);
          fs.mkdirSync(put);
        });
        const log: string[] = [];

        await staged(targetPath, { files, log });

        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
        assert.strictEqual(fs.statSync(put).isDirectory(), true, 'the directory put there is not removed');
        const remains = log.filter((message) => /remains/.test(message));
        assert.strictEqual(remains.length, 1);
        assert.ok(remains[0].startsWith('Database saved, but its temporary directory remains: ') && remains[0].endsWith(path.basename(put)), remains[0]);
      });
    });

    it('says so when its snapshot cannot be closed after a failure, and cleans up all the same', async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        let closes = 0;
        const files = withCopyHandle((handle) => ({
          write: (async () => { throw new Error('the disk went away'); }) as unknown as fs.promises.FileHandle['write'],
          close: (async () => {
            await handle.close();
            if (closes++ === 0) throw new Error('close failed');
          }) as fs.promises.FileHandle['close']
        }));
        const log: string[] = [];

        const failure = await staged(targetPath, { files, log }).then(() => undefined, (error: unknown) => error);

        assert.strictEqual((failure as Error)?.message, 'the disk went away');
        assert.deepStrictEqual(log.filter((message) => /close/.test(message)), ['Failed to close temporary database snapshot.']);
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
        assert.deepStrictEqual(await fs.promises.readdir(folder), ['database.db']);
        assert.deepStrictEqual(stagesLeft(), []);
      });
    });

    it('refuses when the folder under the destination\'s path is on another device, or cannot be looked at, at a later look', async () => {
      for (const change of ['another device', 'no access'] as const) {
        await withScratchDirectory(async (directory) => {
          const folder = await shared(directory);
          const targetPath = path.join(folder, 'database.db');
          await fs.promises.writeFile(targetPath, 'old database bytes');
          const resolved = fs.realpathSync(folder);
          const files = withCall('lstatSync', (real) => (file: fs.PathLike, options?: fs.StatSyncOptions) => {
            if (String(file) !== resolved) return real.lstatSync(file, options);
            if (change === 'no access') throw Object.assign(new Error('EACCES: permission denied, lstat'), { code: 'EACCES' });
            const stats = real.lstatSync(file, options) as fs.BigIntStats;
            return new Proxy(stats, {
              get(given, name) {
                if (name === 'dev') return given.dev + 1n;
                const value = Reflect.get(given, name);
                return typeof value === 'function' ? value.bind(given) : value;
              }
            });
          });

          const failure = await staged(targetPath, { files }).then(() => undefined, (error: unknown) => error);

          assert.match(failureOf(failure), /Database save target changed during the save/, change);
          const first = failure instanceof AggregateError ? failure.errors[0] as Error : failure as Error;
          // Why the folder could not be looked at is kept, for whoever reads the log.
          assert.strictEqual((first.cause as NodeJS.ErrnoException | undefined)?.code, change === 'no access' ? 'EACCES' : undefined);
          assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
          assert.deepStrictEqual(await fs.promises.readdir(folder), ['database.db']);
          assert.deepStrictEqual(stagesLeft(), []);
        });
      }
    });

    it('takes a temporary folder that only this account\'s own group can write, and not one another account\'s group can', {
      skip: (process.platform !== 'linux' && 'the rule for a group of one\'s own is for Linux') || (!fs.existsSync('/usr/bin/getfacl') && 'needs getfacl')
    }, async () => {
      await withScratchDirectory(async (directory) => {
        const folder = await shared(directory);
        const targetPath = path.join(folder, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        const inner = path.join(directory, 'group-writable');
        await fs.promises.mkdir(inner);
        await fs.promises.chmod(inner, 0o775);
        process.env.TMPDIR = inner;
        const { candidatePath } = await staged(targetPath, { files: ownGroup(inner) });

        assert.strictEqual(path.dirname(path.dirname(candidatePath)), fs.realpathSync(inner));
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'new database bytes');
        await assert.rejects(
          staged(targetPath, { files: ownGroup(inner, 'someone') }),
          /Other accounts may be able to rename what is in '.*shared', which the destination is in or under, and in '.*group-writable'/
        );
        assert.deepStrictEqual(await fs.promises.readdir(inner), []);
      });
    });
  });

  it('atomically replaces an existing target with the produced snapshot', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const replacementBytes = Buffer.from('replacement database bytes');
      let temporaryPath: string | undefined;
      await fs.promises.writeFile(targetPath, 'old database bytes');

      const result = await writeDatabaseSnapshotAtomically(
        fs,
        undefined,
        targetPath,
        async (candidatePath) => {
          temporaryPath = candidatePath;
          await fs.promises.writeFile(candidatePath, replacementBytes);
        }
      );

      assertInstalled(result, targetPath, false);
      assert.deepStrictEqual(await fs.promises.readFile(targetPath), replacementBytes);
      assert.ok(temporaryPath, 'the producer should receive a temporary path');
      assert.strictEqual(await pathExists(temporaryPath), false);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('replaces a target on a path past 260 characters', async () => {
    await withScratchDirectory(async (directory) => {
      let deep = directory;
      while (deep.length < 300) deep = path.join(deep, 'd'.repeat(40));
      await fs.promises.mkdir(deep, { recursive: true, mode: 0o755 });
      const targetPath = path.join(deep, 'database.db');
      // A real database, so that the save takes SQLite's lock on it first. In
      // its extended form: SQLite does not open so long a path on Windows as given.
      const existing = new DatabaseSync(path.toNamespacedPath(targetPath));
      try { existing.exec('CREATE TABLE old(x)'); } finally { existing.close(); }
      let temporaryPath = '';

      const result = await writeDatabaseSnapshotAtomically(
        fs,
        undefined,
        targetPath,
        async (candidatePath) => {
          temporaryPath = candidatePath;
          await fs.promises.writeFile(candidatePath, 'replacement database bytes');
        }
      );

      assertInstalled(result, targetPath, false);
      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'replacement database bytes');
      // The snapshot's path is an ordinary one, as the engines are given elsewhere.
      assert.strictEqual(folderOf(temporaryPath), await fs.promises.realpath(deep));
      assert.deepStrictEqual(await fs.promises.readdir(deep), ['database.db']);
    });
  });

  it('rewords only the refusal Windows gives for a target it will not replace', () => {
    const target = 'C:\\data\\app.db';
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      const refusal = Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
      const reworded = refusedReplacement(refusal, target, 'win32') as NodeJS.ErrnoException;
      assert.match(reworded.message, /refused to replace 'C:\\data\\app\.db'.*another program has the file open.*was not changed/s);
      assert.strictEqual(reworded.cause, refusal);
      assert.strictEqual(reworded.code, code);
      // The program may let go in a moment; the unworded error says nothing of the kind.
      assert.strictEqual(isMomentary(reworded), true);
      assert.strictEqual(isMomentary(refusal), false);
      assert.strictEqual(refusedReplacement(refusal, target, 'linux'), refusal);
      assert.strictEqual(refusedReplacement(refusal, target, 'darwin'), refusal);
    }
    const missing = Object.assign(new Error('ENOENT: no such file or directory, rename'), { code: 'ENOENT' });
    assert.strictEqual(refusedReplacement(missing, target, 'win32'), missing);
  });

  it('says what to do when the target cannot be replaced, and leaves it as it was', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes');
      const refusal = Object.assign(new Error("EPERM: operation not permitted, rename 'copy' -> 'database.db'"), { code: 'EPERM' });
      const refusing = { ...fs, renameSync: (() => { throw refusal; }) as typeof fs.renameSync } as typeof fs;

      await assert.rejects(
        writeDatabaseSnapshotAtomically(refusing, undefined, targetPath, async (candidatePath) => {
          await fs.promises.writeFile(candidatePath, 'replacement database bytes');
        }),
        (error: unknown) => {
          // Only Windows refuses to replace a file another program has open.
          if (process.platform === 'win32') {
            assert.match((error as Error).message, /another program has the file open/);
            assert.strictEqual((error as Error).cause, refusal);
            assert.strictEqual((error as NodeJS.ErrnoException).code, 'EPERM');
          } else {
            assert.strictEqual(error, refusal);
          }
          return true;
        }
      );

      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
      assert.deepStrictEqual(await fs.promises.readdir(directory), ['database.db']);
    });
  });

  describe('a step another program refuses for a moment', () => {
    const refusedForNow = () => Object.assign(new Error('refused for now'), { momentary: true });

    it('runs once, and returns no promise, when nothing refuses it', () => {
      let waits = 0;
      assert.strictEqual(patiently(() => 7, async () => { waits++; }), 7);
      assert.strictEqual(waits, 0);
    });

    it('runs again after each wait and returns what the step then gives', async () => {
      const waited: number[] = [];
      let calls = 0;
      const result = patiently(() => {
        if (++calls < 3) throw refusedForNow();
        return 'done';
      }, async (milliseconds) => { waited.push(milliseconds); });

      assert.ok(result instanceof Promise);
      assert.strictEqual(await result, 'done');
      assert.deepStrictEqual(waited, [10, 20]);
    });

    it('reports the last refusal once the waits are used up', async () => {
      const waited: number[] = [];
      const refusals: Error[] = [];
      await assert.rejects(
        Promise.resolve(patiently(() => {
          refusals.push(refusedForNow());
          throw refusals.at(-1);
        }, async (milliseconds) => { waited.push(milliseconds); })),
        (error: unknown) => error === refusals.at(-1)
      );

      // 630 ms in all, against 75 ms for the longest refusal that was measured.
      assert.deepStrictEqual(waited, [10, 20, 40, 80, 160, 320]);
      assert.strictEqual(refusals.length, 7);
    });

    it('passes any other failure on at once, from the first run and from a later one', async () => {
      const changed = new Error('the target changed');
      let waits = 0;
      assert.throws(
        () => patiently(() => { throw changed; }, async () => { waits++; }),
        (error: unknown) => error === changed
      );
      assert.strictEqual(waits, 0);

      let calls = 0;
      await assert.rejects(
        Promise.resolve(patiently(() => {
          if (++calls === 1) throw refusedForNow();
          throw changed;
        }, async () => { waits++; })),
        (error: unknown) => error === changed
      );
      assert.strictEqual(waits, 1);
      assert.strictEqual(calls, 2);
    });
  });

  it('replaces the target once Windows stops refusing it', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes');
      const refusal = Object.assign(new Error("EPERM: operation not permitted, rename 'copy' -> 'database.db'"), { code: 'EPERM' });
      let attempts = 0;
      const refusingTwice = { ...fs, renameSync: ((from: fs.PathLike, to: fs.PathLike) => {
        if (++attempts <= 2) throw refusal;
        fs.renameSync(from, to);
      }) as typeof fs.renameSync } as typeof fs;
      const save = writeDatabaseSnapshotAtomically(refusingTwice, undefined, targetPath, async (candidatePath) => {
        await fs.promises.writeFile(candidatePath, 'replacement database bytes');
      });

      if (process.platform === 'win32') {
        await save;
        assert.strictEqual(attempts, 3);
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'replacement database bytes');
      } else {
        // Nothing but Windows refuses a rename for a moment, so nothing is tried again.
        await assert.rejects(save, (error: unknown) => error === refusal);
        assert.strictEqual(attempts, 1);
        assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
      }
      assert.deepStrictEqual(await fs.promises.readdir(directory), ['database.db']);
    });
  });

  it('checks the target again before it tries the rename again', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes');
      const refusal = Object.assign(new Error("EPERM: operation not permitted, rename 'copy' -> 'database.db'"), { code: 'EPERM' });
      let attempts = 0;
      // The program that had the file open wrote to it before it let go.
      const changedWhileRefusing = { ...fs, renameSync: (() => {
        attempts++;
        fs.writeFileSync(targetPath, 'bytes another program wrote meanwhile');
        throw refusal;
      }) as typeof fs.renameSync } as typeof fs;

      await assert.rejects(
        writeDatabaseSnapshotAtomically(changedWhileRefusing, undefined, targetPath, async (candidatePath) => {
          await fs.promises.writeFile(candidatePath, 'replacement database bytes');
        }),
        (error: unknown) => {
          if (process.platform === 'win32') {
            assert.doesNotMatch((error as Error).message, /refused to replace/);
            assert.notStrictEqual(error, refusal);
          } else {
            assert.strictEqual(error, refusal);
          }
          return true;
        }
      );

      assert.strictEqual(attempts, 1);
      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'bytes another program wrote meanwhile');
      assert.deepStrictEqual(await fs.promises.readdir(directory), ['database.db']);
    });
  });

  it('says that a lock another connection holds may be gone in a moment', async () => {
    await withScratchDirectory(async (directory) => {
      const databasePath = path.join(directory, 'database.db');
      const seed = new DatabaseSync(databasePath);
      seed.exec('CREATE TABLE t (v); INSERT INTO t VALUES (1)');
      seed.close();
      const reader = new DatabaseSync(databasePath);
      reader.exec('BEGIN');
      reader.prepare('SELECT v FROM t').get();
      try {
        assert.throws(() => acquireSqliteWriteLock(databasePath), (error: unknown) => {
          assert.match((error as Error).message, /Cannot acquire the exclusive SQLite lock/);
          assert.strictEqual(isMomentary(error), true);
          return true;
        });
      } finally {
        reader.close();
      }
      acquireSqliteWriteLock(databasePath).release();

      // A file SQLite cannot open at all will not open in a moment either.
      assert.throws(() => acquireSqliteWriteLock(path.join(directory, 'missing', 'database.db')), (error: unknown) => {
        assert.match((error as Error).message, /Cannot acquire the exclusive SQLite lock/);
        assert.strictEqual(isMomentary(error), false);
        return true;
      });
    });
  });

  it('waits for a reader to let go of the database, then saves', async (t) => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const seed = new DatabaseSync(targetPath);
      seed.exec('CREATE TABLE t (v); INSERT INTO t VALUES (1)');
      seed.close();
      const image = await fs.promises.readFile(targetPath);
      const reader = new DatabaseSync(targetPath);
      reader.exec('BEGIN');
      reader.prepare('SELECT v FROM t').get();

      // Only the waits between attempts use this timer. While it stands still
      // a save that does not settle is a save that is waiting for the lock.
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let settled = false;
      const save = writeDatabaseSnapshotAtomically(fs, undefined, targetPath, async (candidatePath) => {
        await fs.promises.writeFile(candidatePath, image);
      }).finally(() => { settled = true; });
      save.catch(() => undefined);
      try {
        const started = performance.now();
        while (!settled && performance.now() - started < 1500) {
          await new Promise<void>((resolve) => {
            const interval = setInterval(() => { clearInterval(interval); resolve(); }, 20);
          });
        }
        assert.strictEqual(settled, false, 'the save waits while the reader holds its lock');
      } finally {
        reader.close();
      }
      t.mock.timers.tick(10);
      await save;
      t.mock.timers.reset();

      assert.deepStrictEqual(await fs.promises.readFile(targetPath), image);
      assert.deepStrictEqual(await fs.promises.readdir(directory), ['database.db']);
    });
  });

  const onlyWindows = { skip: process.platform === 'win32' ? false : 'only Windows refuses to replace a file a program has open' };

  it('saves once a program that had the file open lets go of it', onlyWindows, async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes');
      let held: number | undefined = fs.openSync(targetPath, 'r');
      let refusals = 0;
      // Lets go only after Windows has refused the rename once.
      const lettingGoWhenRefused = { ...fs, renameSync: ((from: fs.PathLike, to: fs.PathLike) => {
        try {
          fs.renameSync(from, to);
        } catch (error) {
          refusals++;
          if (held !== undefined) fs.closeSync(held);
          held = undefined;
          throw error;
        }
      }) as typeof fs.renameSync } as typeof fs;
      try {
        await writeDatabaseSnapshotAtomically(lettingGoWhenRefused, undefined, targetPath, async (candidatePath) => {
          await fs.promises.writeFile(candidatePath, 'replacement database bytes');
        });
      } finally {
        if (held !== undefined) fs.closeSync(held);
      }

      assert.strictEqual(refusals, 1);
      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'replacement database bytes');
      assert.deepStrictEqual(await fs.promises.readdir(directory), ['database.db']);
    });
  });

  it('gives up after its waits when the program keeps the file open', onlyWindows, async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes');
      const held = fs.openSync(targetPath, 'r');
      let attempts = 0;
      const counting = { ...fs, renameSync: ((from: fs.PathLike, to: fs.PathLike) => {
        attempts++;
        fs.renameSync(from, to);
      }) as typeof fs.renameSync } as typeof fs;
      const started = performance.now();
      try {
        await assert.rejects(
          writeDatabaseSnapshotAtomically(counting, undefined, targetPath, async (candidatePath) => {
            await fs.promises.writeFile(candidatePath, 'replacement database bytes');
          }),
          /another program has the file open/
        );
      } finally {
        fs.closeSync(held);
      }
      const elapsed = performance.now() - started;

      assert.strictEqual(attempts, 7);
      assert.ok(elapsed >= 600 && elapsed < 10_000, `${elapsed.toFixed(0)} ms`);
      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'old database bytes');
      assert.deepStrictEqual(await fs.promises.readdir(directory), ['database.db']);
    });
  });

  it('replaces a target without a warning', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      await fs.promises.writeFile(targetPath, 'old database bytes');
      const warnings: string[] = [];

      await writeDatabaseSnapshotAtomically(
        fs,
        undefined,
        targetPath,
        async (candidatePath) => {
          await fs.promises.writeFile(candidatePath, 'replacement database bytes');
        },
        undefined,
        (_level, message) => { warnings.push(message); }
      );

      assert.deepStrictEqual(warnings, []);
    });
  });

  it('reports a failed folder flush, but not the refusal Windows gives for every folder', async () => {
    for (const code of ['EIO', 'EPERM']) {
      await withScratchDirectory(async (directory) => {
        const targetPath = path.join(directory, 'database.db');
        await fs.promises.writeFile(targetPath, 'old database bytes');
        const folder = await fs.promises.realpath(directory);
        const failure = Object.assign(new Error(`${code}: fsync`), { code });
        const open = async (...args: Parameters<typeof fs.promises.open>) => {
          const handle = await fs.promises.open(...args);
          if (String(args[0]) !== folder || args[1] !== 'r') return handle;
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'sync') return async () => { throw failure; };
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            }
          });
        };
        const warnings: Array<{ message: string; error: unknown }> = [];

        const result = await writeDatabaseSnapshotAtomically(
          { ...fs, promises: { ...fs.promises, open } } as typeof fs,
          undefined,
          targetPath,
          async (candidatePath) => {
            await fs.promises.writeFile(candidatePath, 'replacement database bytes');
          },
          undefined,
          (_level, message, error) => { warnings.push({ message, error }); }
        );

        assertInstalled(result, targetPath, false);
        // Windows cannot flush a folder and answers EPERM for each one, so
        // there that code says nothing about this save.
        if (code === 'EPERM' && process.platform === 'win32') {
          assert.deepStrictEqual(warnings, []);
        } else {
          assert.strictEqual(warnings.length, 1, code);
          assert.match(warnings[0].message, /durability could not be confirmed/i);
          assert.strictEqual(warnings[0].error, failure);
        }
      });
    }
  });

  it('reports a save as done when its emptied private directory cannot be removed', ownDirectory, async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const replacementBytes = Buffer.from('replacement database bytes');
      await fs.promises.writeFile(targetPath, 'old database bytes');
      // Another process can hold the directory after the rename, as a scanner does on Windows.
      const busy = Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' });
      const heldFs = { ...fs, rmdirSync: () => { throw busy; } } as typeof fs;
      const warnings: Array<{ message: string; error: unknown }> = [];

      const result = await writeDatabaseSnapshotAtomically(
        heldFs,
        undefined,
        targetPath,
        async (candidatePath) => {
          await fs.promises.writeFile(candidatePath, replacementBytes);
        },
        undefined,
        (_level, message, error) => { warnings.push({ message, error }); }
      );

      assertInstalled(result, targetPath, false);
      assert.deepStrictEqual(await fs.promises.readFile(targetPath), replacementBytes);
      const remaining = warnings.filter(({ message }) => /temporary directory remains/.test(message));
      assert.strictEqual(remaining.length, 1);
      assert.strictEqual(remaining[0].error, busy);
      const left = (await fs.promises.readdir(directory)).filter((entry) => entry.includes('.sqlite-explorer-'));
      assert.strictEqual(left.length, 1);
      assert.deepStrictEqual(await fs.promises.readdir(path.join(directory, left[0])), []);
    });
  });

  it('replaces the resolved target without replacing a symlink', { skip: NO_FILE_SYMLINKS }, async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const linkPath = path.join(directory, 'database-link.db');
      const replacementBytes = Buffer.from('replacement through symlink');
      let temporaryPath: string | undefined;
      await fs.promises.writeFile(targetPath, 'old database bytes');
      await fs.promises.symlink(path.basename(targetPath), linkPath);

      const result = await writeDatabaseSnapshotAtomically(
        fs,
        undefined,
        linkPath,
        async (candidatePath) => {
          temporaryPath = candidatePath;
          await fs.promises.writeFile(candidatePath, replacementBytes);
        }
      );

      assertInstalled(result, targetPath, false);
      assert.strictEqual((await fs.promises.lstat(linkPath)).isSymbolicLink(), true);
      assert.strictEqual(await fs.promises.readlink(linkPath), path.basename(targetPath));
      assert.deepStrictEqual(await fs.promises.readFile(targetPath), replacementBytes);
      assert.deepStrictEqual(await fs.promises.readFile(linkPath), replacementBytes);
      assert.ok(temporaryPath, 'the producer should receive a temporary path');
      // The snapshot sits beside the resolved target, on its filesystem, so
      // the rename stays atomic.
      assert.strictEqual(folderOf(temporaryPath), await fs.promises.realpath(directory));
      assert.strictEqual(await pathExists(temporaryPath), false);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('refuses a dangling symlink without invoking the producer', { skip: NO_FILE_SYMLINKS }, async () => {
    await withScratchDirectory(async (directory) => {
      const linkPath = path.join(directory, 'dangling.db');
      const missingTarget = 'missing.db';
      let producerCalled = false;
      await fs.promises.symlink(missingTarget, linkPath);

      await assert.rejects(
        writeDatabaseSnapshotAtomically(
          fs,
          undefined,
          linkPath,
          async () => {
            producerCalled = true;
          }
        ),
        /cannot save through dangling symlink/i
      );

      assert.strictEqual(producerCalled, false);
      assert.strictEqual((await fs.promises.lstat(linkPath)).isSymbolicLink(), true);
      assert.strictEqual(await fs.promises.readlink(linkPath), missingTarget);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('refuses a target generation change without clobbering the newer bytes', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const newerBytes = Buffer.from('newer target generation with a different byte length');
      let temporaryPath: string | undefined;
      await fs.promises.writeFile(targetPath, 'old bytes');

      await assert.rejects(
        writeDatabaseSnapshotAtomically(
          fs,
          undefined,
          targetPath,
          async (candidatePath) => {
            temporaryPath = candidatePath;
            await fs.promises.writeFile(candidatePath, 'stale produced snapshot');
            await fs.promises.writeFile(targetPath, newerBytes);
          }
        ),
        /database save target changed during the save; retry/i
      );

      assert.deepStrictEqual(await fs.promises.readFile(targetPath), newerBytes);
      assert.ok(temporaryPath, 'the producer should receive a temporary path');
      assert.strictEqual(await pathExists(temporaryPath), false);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('honors cancellation after validation and before the atomic rename', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const originalBytes = Buffer.from('old database bytes');
      const replacementBytes = Buffer.from('replacement database bytes');
      const cancellation = new AbortController();
      const reason = new Error('cancelled at the commit boundary');
      await fs.promises.writeFile(targetPath, originalBytes);

      const hookedFs = Object.create(fs) as typeof fs;
      Object.defineProperty(hookedFs, 'lstatSync', {
        value(candidatePath: fs.PathLike, options?: unknown) {
          const result = (fs.lstatSync as (...args: unknown[]) => fs.Stats)(
            candidatePath,
            options
          );
          if (String(candidatePath).includes('.sqlite-explorer-')) {
            cancellation.abort(reason);
          }
          return result;
        }
      });

      await assert.rejects(
        writeDatabaseSnapshotAtomically(
          hookedFs,
          undefined,
          targetPath,
          async (temporaryPath) => {
            await fs.promises.writeFile(temporaryPath, replacementBytes);
          },
          cancellation.signal
        ),
        reason
      );

      assert.deepStrictEqual(await fs.promises.readFile(targetPath), originalBytes);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('reports requiresReopen when the active source resolves to the target', { skip: NO_FILE_SYMLINKS }, async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const sourceLinkPath = path.join(directory, 'active-database.db');
      const replacementBytes = Buffer.from('replacement of active source');
      await fs.promises.writeFile(targetPath, 'old active database bytes');
      await fs.promises.symlink(path.basename(targetPath), sourceLinkPath);

      const result = await writeDatabaseSnapshotAtomically(
        fs,
        sourceLinkPath,
        targetPath,
        async (temporaryPath) => {
          await fs.promises.writeFile(temporaryPath, replacementBytes);
        }
      );

      assertInstalled(result, targetPath, true);
      assert.strictEqual((await fs.promises.lstat(sourceLinkPath)).isSymbolicLink(), true);
      assert.deepStrictEqual(await fs.promises.readFile(sourceLinkPath), replacementBytes);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('creates a missing target from the produced snapshot', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'new-database.db');
      const snapshotBytes = Buffer.from('new database snapshot');
      let temporaryPath: string | undefined;

      const result = await writeDatabaseSnapshotAtomically(
        fs,
        undefined,
        targetPath,
        async (candidatePath) => {
          temporaryPath = candidatePath;
          await fs.promises.writeFile(candidatePath, snapshotBytes);
        }
      );

      assertInstalled(result, targetPath, false);
      assert.deepStrictEqual(await fs.promises.readFile(targetPath), snapshotBytes);
      assert.ok(temporaryPath, 'the producer should receive a temporary path');
      assert.strictEqual(await pathExists(temporaryPath), false);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('saves to a distinct target after the active source pathname disappears', async () => {
    await withScratchDirectory(async (directory) => {
      const sourcePath = path.join(directory, 'unlinked-source.db');
      const targetPath = path.join(directory, 'recovered-copy.db');
      const snapshotBytes = Buffer.from('recoverable open database snapshot');
      await fs.promises.writeFile(sourcePath, 'former source pathname');
      await fs.promises.unlink(sourcePath);

      const result = await writeDatabaseSnapshotAtomically(
        fs,
        sourcePath,
        targetPath,
        async (temporaryPath) => {
          await fs.promises.writeFile(temporaryPath, snapshotBytes);
        }
      );

      assertInstalled(result, targetPath, false);
      assert.deepStrictEqual(await fs.promises.readFile(targetPath), snapshotBytes);
      assert.strictEqual(await pathExists(sourcePath), false);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });
});

describe('folders in which another account can rename', {
  skip: (process.platform === 'win32' && 'owners and modes as POSIX has them') || (process.geteuid?.() === 0 && 'root is no other account\'s other')
}, () => {
  const me = BigInt(process.geteuid?.() ?? 0);
  const someone = me + 1n;
  type Folder = { uid?: bigint; gid?: bigint; mode: number };
  const accounts = (more = ''): string => `root:x:0:0:root:/root:/bin/sh\nme:x:${me}:${me}::/home/me:/bin/sh\n${more}`;
  const groups = (members = '', more = ''): string => `root:x:0:\nme:x:${me}:${members}\n${more}`;
  let reads: string[] = [];
  /** A system of folders by path, with this account as their owner and group unless said otherwise, and its two account files. */
  const system = (folders: Record<string, Folder>, passwd: string | undefined, group: string | undefined, sources?: string | null): typeof fs => ({
    statSync: (at: string) => {
      const folder = folders[at] ?? { uid: 0n, gid: 0n, mode: 0o755 };
      return { uid: folder.uid ?? me, gid: folder.gid ?? me, mode: BigInt(0o040000 | folder.mode) };
    },
    readFileSync: (file: string) => {
      reads.push(file);
      const text = file === '/etc/passwd' ? passwd : file === '/etc/group' ? group : file === '/etc/nsswitch.conf' ? sources ?? undefined : undefined;
      // The file that names the sources of accounts: not there unless given, and unreadable when given as null.
      if (file === '/etc/nsswitch.conf' && sources === null) throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' });
      if (text === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' });
      return text;
    }
  }) as unknown as typeof fs;
  const work = '/home/me/work';
  let asked: string[] = [];
  const open = (
    folders: Record<string, Folder>,
    files: { passwd?: string | null; group?: string | null; sources?: string | null; platform?: string; onlyItsMode?: false | ((folder: string) => boolean) } = {}
  ): string | undefined => {
    reads = [];
    asked = [];
    const onlyItsMode = files.onlyItsMode ?? (() => true);
    return othersCanRenameIn(
      system(folders, files.passwd === null ? undefined : files.passwd ?? accounts(), files.group === null ? undefined : files.group ?? groups(), files.sources),
      work,
      files.platform ?? 'linux',
      onlyItsMode === false ? false : (folder) => { asked.push(folder); return onlyItsMode(folder); }
    );
  };
  it('finds none where only owners write, and names the first folder, from the destination up, where another account can', () => {
    assert.strictEqual(open({ [work]: { mode: 0o755 }, '/home/me': { mode: 0o700 } }), undefined);
    assert.strictEqual(open({ [work]: { mode: 0o777 } }), work);
    assert.strictEqual(open({ [work]: { mode: 0o755 }, '/home/me': { mode: 0o777 } }), '/home/me');
    assert.strictEqual(open({ [work]: { mode: 0o755 }, '/home/me': { mode: 0o755 }, '/home': { uid: someone, mode: 0o755 } }), '/home');
    // Root's folders are not another account's, and a sticky folder lets nobody rename what is not theirs.
    assert.strictEqual(open({ [work]: { mode: 0o755 }, '/home/me': { uid: 0n, gid: 0n, mode: 0o755 } }), undefined);
    assert.strictEqual(open({ [work]: { mode: 0o1777 } }), undefined);
    assert.strictEqual(open({ [work]: { gid: someone, mode: 0o1775 } }), undefined);
  });

  it('does not count a group that is this account\'s alone by the system\'s files, on Linux', () => {
    const folders = { [work]: { mode: 0o775 }, '/home/me': { mode: 0o770 } };
    assert.strictEqual(open(folders), undefined);
    // Listed as a member of its own group as well, as some systems write it.
    assert.strictEqual(open(folders, { group: groups('me') }), undefined);
    // Each file is read once, however many folders have that group.
    assert.deepStrictEqual(reads, ['/etc/passwd', '/etc/group', '/etc/nsswitch.conf']);
    // Sources the local files answer for, with what is to be done with an answer in brackets.
    assert.strictEqual(open(folders, { sources: '# where accounts come from\npasswd:  files systemd\ngroup: files [NOTFOUND=return] systemd # and groups\nhosts: files dns\n' }), undefined);
    assert.strictEqual(open(folders, { sources: 'passwd: compat\ngroup: compat mymachines\n' }), undefined);
    // What everyone may write is not the group's to answer for.
    assert.strictEqual(open({ [work]: { mode: 0o777 } }), work);
    // Only where new folders get that group by default: other platforms keep the plain rule.
    assert.strictEqual(open(folders, { platform: 'darwin' }), work);
  });

  it('counts a group that anyone else is in, or that the files do not show to be this account\'s alone', () => {
    const folders = { [work]: { mode: 0o775 } };
    assert.strictEqual(open(folders, { group: groups('someone') }), work, 'another member');
    assert.strictEqual(open(folders, { group: groups('me,someone') }), work, 'another member beside this account');
    assert.strictEqual(open(folders, { passwd: accounts(`someone:x:${someone}:${me}::/home/someone:/bin/sh\n`) }), work, 'another account\'s primary group');
    assert.strictEqual(open(folders, { group: 'root:x:0:\n' }), work, 'a group the files do not list');
    assert.strictEqual(open(folders, { passwd: 'root:x:0:0:root:/root:/bin/sh\n' }), work, 'an account the files do not list');
    assert.strictEqual(open(folders, { passwd: null }), work, 'no account file');
    assert.strictEqual(open(folders, { group: null }), work, 'no group file');
    // A group with another id is another group, also when nobody is listed in it.
    assert.strictEqual(open({ [work]: { gid: someone, mode: 0o775 } }, { group: groups('', `team:x:${someone}:\n`) }), work, 'another group');
    // The files as the C library reads them: an id is a number however it is written, a line that
    // begins with # is a comment, and a line that brings in another source means they do not say all.
    assert.strictEqual(open(folders, { passwd: accounts(`someone:x:${someone}:0${me}::/home/someone:/bin/sh\n`) }), work, 'a primary group written with a leading zero');
    assert.strictEqual(open(folders, { group: `root:x:0:\n#me:x:${me}:\n` }), work, 'a group that is only in a comment');
    assert.strictEqual(open(folders, { group: groups('', `team:x:+${me}:someone\n`) }), work, 'a second line for the group, its id written with a sign');
    assert.strictEqual(open(folders, { passwd: accounts(`someone:x:${someone}: ${me}::/home/someone:/bin/sh\n`) }), work, 'a primary group written after a space');
    assert.strictEqual(open(folders, { group: groups('', '-someone:::\n') }), work, 'a line that leaves an account of another source out');
    assert.strictEqual(open(folders, { group: groups('', '  +:::\n') }), work, 'such a line after spaces');
    assert.strictEqual(open(folders, { group: groups('', '+:::\n') }), work, 'another source of groups');
    assert.strictEqual(open(folders, { passwd: accounts('+::::::\n') }), work, 'another source of accounts');
    assert.strictEqual(open(folders, { group: `  me:x:${me}:\n# a comment\n\nroot:x:0:\n` }), undefined, 'blank lines, comments and leading spaces');
    // A system that asks a directory service too: the files do not show everyone who is in a group.
    assert.strictEqual(open(folders, { sources: 'passwd: files sss\ngroup: files\n' }), work, 'accounts from a directory service');
    assert.strictEqual(open(folders, { sources: 'passwd: files\ngroup: files ldap\n' }), work, 'groups from a directory service');
    assert.strictEqual(open(folders, { sources: 'passwd: files altfiles\ngroup: files\n' }), work, 'a second set of files');
    assert.strictEqual(open(folders, { sources: 'passwd: files\ngroup: files\ninitgroups: files sss\n' }), work, 'further groups from a directory service');
    assert.strictEqual(open(folders, { sources: null }), work, 'sources that cannot be read');
  });

  it('counts a group-writable folder that has access-control entries beyond its mode, whoever its group is', () => {
    // With such entries the group bits are their mask: a folder shared with one account by an entry reads 775 too.
    const folders = { [work]: { mode: 0o775 }, '/home/me': { mode: 0o775 } };
    assert.strictEqual(open(folders, { onlyItsMode: () => false }), work);
    assert.deepStrictEqual(asked, [work]);
    assert.strictEqual(open(folders, { onlyItsMode: (folder) => folder === work }), '/home/me');
    assert.deepStrictEqual(asked, [work, '/home/me']);
    // Asked only where the rest of the rule would let the folder pass: the answer costs a program start.
    assert.strictEqual(open({ [work]: { gid: someone, mode: 0o775 } }), work);
    assert.strictEqual(open({ [work]: { mode: 0o777 } }), work);
    assert.strictEqual(open({ [work]: { mode: 0o755 } }), undefined);
    assert.strictEqual(open(folders, { platform: 'darwin' }), work);
    assert.deepStrictEqual(asked, []);
    // macOS: entries leave a folder's mode as it is, so every folder on the way is asked about, nearest first.
    const plain = { [work]: { mode: 0o755 }, '/home/me': { mode: 0o700 } };
    assert.strictEqual(open(plain, { platform: 'darwin' }), undefined);
    assert.deepStrictEqual(asked, [work, '/home/me', '/home', '/']);
    assert.strictEqual(open(plain, { platform: 'darwin', onlyItsMode: (folder) => folder !== '/home/me' }), '/home/me');
    assert.deepStrictEqual(asked, [work, '/home/me']);
    assert.strictEqual(open(plain, { platform: 'darwin', onlyItsMode: false }), undefined);
    // A caller that wants every group counted asks nothing, and reads no file.
    assert.strictEqual(open(folders, { onlyItsMode: false }), work);
    assert.deepStrictEqual(reads, []);
  });

  it('takes a folder it gets no answer about for one with more than its mode', () => {
    // With the system's own programs, which the other tests here do not start.
    accessEntryTools.use = undefined;
    try {
      // No such folder, or on Linux no program to ask: either way, not "nothing more".
      assert.strictEqual(hasOnlyItsMode(path.join(os.tmpdir(), 'sqlite-explorer-no-such-folder')), false);
    } finally {
      accessEntryTools.use = null;
    }
  });

  const tools = ['/usr/bin/getfacl', '/usr/bin/setfacl'].every((tool) => fs.existsSync(tool));
  it('sees a real access-control entry on a real folder, and none where there is none', {
    skip: (process.platform !== 'linux' && 'the rule for a group of one\'s own is for Linux') || (!tools && 'needs getfacl and setfacl')
  }, async () => {
    await withScratchDirectory(async (directory) => {
      const folder = path.join(directory, 'project');
      await fs.promises.mkdir(folder);
      await fs.promises.chmod(folder, 0o775);
      const uid = process.geteuid!();
      // The real folder, with the account files of an account that is alone in its own group.
      const files = new Proxy(fs, {
        get(real, key) {
          if (key === 'statSync') {
            return (file: fs.PathLike, ...rest: unknown[]) => {
              const stats = (real.statSync as (...given: unknown[]) => fs.BigIntStats)(file, ...rest);
              if (String(file) !== folder) return stats;
              return new Proxy(stats, {
                get(given, name) {
                  if (name === 'gid') return BigInt(uid);
                  const value = Reflect.get(given, name);
                  return typeof value === 'function' ? value.bind(given) : value;
                }
              });
            };
          }
          if (key === 'readFileSync') {
            return (file: fs.PathLike) => (String(file) === '/etc/passwd' ? `me:x:${uid}:${uid}::/:/bin/sh\n` : `me:x:${uid}:\n`);
          }
          return Reflect.get(real, key);
        }
      });
      const { execFileSync } = await import('node:child_process');

      assert.strictEqual(othersCanRenameIn(files, folder, 'linux'), undefined);
      // Shared with one other account by an entry. Its mode stays 775: the group bits are now the entries' mask.
      await fs.promises.chmod(folder, 0o755);
      execFileSync('/usr/bin/setfacl', ['-m', 'u:65534:rwx', folder]);
      assert.strictEqual(fs.statSync(folder).mode & 0o777, 0o775);
      assert.strictEqual(othersCanRenameIn(files, folder, 'linux'), folder);
      // An entry that only new files inherit is more than a mode as well.
      execFileSync('/usr/bin/setfacl', ['-b', folder]);
      await fs.promises.chmod(folder, 0o775);
      assert.strictEqual(othersCanRenameIn(files, folder, 'linux'), undefined);
      execFileSync('/usr/bin/setfacl', ['-d', '-m', 'u:65534:r-x', folder]);
      assert.strictEqual(othersCanRenameIn(files, folder, 'linux'), folder);
    });
  });
});
