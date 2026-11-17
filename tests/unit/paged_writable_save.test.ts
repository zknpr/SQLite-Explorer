import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import childProcess, { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from '../../vendor/sql.js/sql-wasm.js';
import { writePagedWritableOverlayToFile } from '../../src/pagedWritableSave';
import {
  createDatabaseEngine,
  WasmDatabaseEngine
} from '../../src/core/sqlite-db';
import type {
  WasmDatabaseInstance,
  WasmEngineModule
} from '../../src/core/engine/wasm/WasmDatabaseEngine';
import {
  MAX_PAGED_OVERLAY_RUN_BYTES,
  type PagedFileIdentity,
  type PagedWritableOverlaySnapshot,
  type RawPagedWritableOverlay
} from '../../src/core/paged-writable-overlay';
import { NO_FILE_SYMLINKS } from './helpers/symlinks';
import { entriesForOther, NO_REAL_ENTRIES, shareWithOther } from './helpers/access-entries';
import { othersCanRenameIn } from '../../src/folderAccess';
import { stagedSnapshotAccess } from '../../src/insideDirectory';
import { accessEntryTools, macStoredListTools } from '../../src/posixAccessEntries';

// These tests are not about access-control entries, except the one that says so: no program is
// started for the others, so that what a save logs does not depend on which programs a machine has.
accessEntryTools.use = null;
// Where a test here turns the system's programs on, macOS uses `ls` and `chmod`, as where there is
// no Ruby: what they leave out is what these tests hold. One test below asks for the stored list.
accessEntryTools.storedLists = false;

// The tracked runtime; assets/sqlite3.wasm is a build output the native CI lane lacks.
const wasmBinary = new Uint8Array(
  fs.readFileSync(path.resolve(process.cwd(), 'vendor/sql.js/sql-wasm.wasm'))
).buffer;

let SqlJsModule: WasmEngineModule;
let fixtureDir: string;

before(async () => {
  SqlJsModule = await (initSqlJs as any)({ wasmBinary }) as WasmEngineModule;
  const tmpRoot = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  fixtureDir = fs.mkdtempSync(path.join(tmpRoot, 'paged-writable-save-'));
});

after(() => {
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

function identityFromPath(filePath: string): PagedFileIdentity {
  const stats = fs.statSync(filePath, { bigint: true });
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    mode: stats.mode
  };
}

function snapshotFor(
  basePath: string,
  options: Partial<PagedWritableOverlaySnapshot> = {}
): PagedWritableOverlaySnapshot {
  const chunkSize = options.chunkSize ?? 4;
  const data = options.runs?.[0]?.data ?? new Uint8Array([9, 8, 7, 6]).buffer;
  const runs = options.runs ?? [{ startChunkIndex: 0, data }];
  return {
    chunkSize,
    logicalSize: options.logicalSize ?? Number(identityFromPath(basePath).size),
    baseLimit: options.baseLimit ?? Number(identityFromPath(basePath).size),
    dirtyBytes: options.dirtyBytes ?? runs.reduce((sum, run) => sum + run.data.byteLength, 0),
    baseIdentity: options.baseIdentity ?? identityFromPath(basePath),
    runs
  };
}

function fakePagedInstance(
  expected: Uint8Array,
  rawOverlay: RawPagedWritableOverlay
): WasmDatabaseInstance {
  return {
    exec: () => [],
    prepare: () => { throw new Error('not used'); },
    iterateStatements: () => [],
    progress_handler: () => {},
    interrupt: () => {},
    export: () => expected.slice(),
    exportPagedWritableOverlay: () => rawOverlay,
    close: () => {}
  } as WasmDatabaseInstance;
}

function capabilityWithOpen(
  open: typeof fs.promises.open,
  overrides: Partial<typeof fs.promises> = {},
  syncOverrides: Partial<typeof fs> = {}
): typeof fs {
  const promises = Object.assign(Object.create(fs.promises), overrides, { open });
  return new Proxy(fs, {
    get(target, property) {
      if (property === 'promises') return promises;
      if (Object.prototype.hasOwnProperty.call(syncOverrides, property)) {
        return Reflect.get(syncOverrides, property, syncOverrides);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

/**
 * The file system with the top bit set in every file ID. An NTFS file ID has
 * it once the file's record has been reused 32,768 times, and Node reports
 * the ID as a signed 64-bit integer, so such a file's `ino` is negative.
 */
function capabilityWithHighFileIds(): typeof fs {
  const high = <T>(stats: T): T => {
    if (typeof (stats as { ino?: unknown } | undefined)?.ino !== 'bigint') return stats;
    return new Proxy(stats as object, {
      get(target, property) {
        if (property === 'ino') return BigInt.asIntN(64, (target as { ino: bigint }).ino | (1n << 63n));
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as T;
  };
  const open = async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await fs.promises.open(...args);
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'stat') return async (...statArgs: any[]) => high(await (target.stat as any)(...statArgs));
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  };
  return capabilityWithOpen(open as typeof fs.promises.open, {
    stat: (async (...args: any[]) => high(await (fs.promises.stat as any)(...args))) as typeof fs.promises.stat,
    lstat: (async (...args: any[]) => high(await (fs.promises.lstat as any)(...args))) as typeof fs.promises.lstat
  }, {
    statSync: ((...args: any[]) => high((fs.statSync as any)(...args))) as typeof fs.statSync,
    lstatSync: ((...args: any[]) => high((fs.lstatSync as any)(...args))) as typeof fs.lstatSync,
    fstatSync: ((...args: any[]) => high((fs.fstatSync as any)(...args))) as typeof fs.fstatSync
  });
}

function proxyHandleRead(
  handle: Awaited<ReturnType<typeof fs.promises.open>>,
  read: (...args: any[]) => Promise<any>
): Awaited<ReturnType<typeof fs.promises.open>> {
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'read') return read;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function bundledNativeBinary(): string | undefined {
  let directory: string | undefined;
  if (process.platform === 'darwin') {
    directory = process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos';
  } else if (process.platform === 'linux') {
    directory = process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu';
  } else if (process.platform === 'win32' && process.arch === 'x64') {
    directory = 'x86_64-windows';
  }
  if (!directory) return undefined;
  const binary = path.resolve(
    process.cwd(),
    'natives',
    directory,
    process.platform === 'win32' ? 'tjs.exe' : 'tjs'
  );
  return fs.existsSync(binary) ? binary : undefined;
}

/** File-mechanics fixtures below are intentionally not valid SQLite images. */
const acquireFixtureWriteLock = () => ({ release() {} });

// Measured on Windows: chmod to 0o640 and to 0o600 both leave 0o666, and only
// a mode without the owner write bit changes anything (0o444).
const NO_POSIX_MODES = 'Windows has no owner, group and other modes: chmod there only sets or clears read-only';

describe('paged writable host save', () => {
  it('refuses insufficient adjacent-temp space before creating the temp file', async () => {
    const basePath = path.join(fixtureDir, 'free-space-base.db');
    const targetPath = path.join(fixtureDir, 'free-space-target.db');
    fs.writeFileSync(basePath, Buffer.alloc(64, 3));
    let temporaryCreates = 0;
    const open = async (...args: Parameters<typeof fs.promises.open>) => {
      if (args[1] === 'wx') temporaryCreates++;
      return fs.promises.open(...args);
    };
    const capability = capabilityWithOpen(open as typeof fs.promises.open, {
      statfs: (async () => ({
        type: 0n,
        bsize: 4096n,
        frsize: 4096n,
        blocks: 0n,
        bfree: 0n,
        bavail: 0n,
        files: 0n,
        ffree: 0n
      })) as unknown as typeof fs.promises.statfs
    });

    await assert.rejects(
      writePagedWritableOverlayToFile(
        capability,
        basePath,
        targetPath,
        snapshotFor(basePath)
      ),
      /atomic paged save needs approximately 4096 bytes.*only 0 bytes.*available/i
    );

    assert.strictEqual(temporaryCreates, 0);
    assert.strictEqual(fs.existsSync(targetPath), false);
  });

  it('stream-assembles a real VACUUM shrink byte-identically to explicit serialization', async () => {
    const basePath = path.join(fixtureDir, 'vacuum-base.db');
    const targetPath = path.join(fixtureDir, 'vacuum-save-as.db');
    const db = new (SqlJsModule.Database as any)();
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, payload BLOB)');
    const insert = db.prepare('INSERT INTO items VALUES (?, ?)');
    for (let index = 1; index <= 1200; index++) {
      insert.run([index, new Uint8Array(2048).fill(index & 0xff)]);
    }
    insert.free();
    const original = db.export();
    db.close();
    fs.writeFileSync(basePath, Buffer.from(original));
    fs.chmodSync(basePath, 0o640);

    const opened = await createDatabaseEngine({
      content: null,
      filePath: basePath,
      maxSize: 0,
      pagedOpenThresholdBytes: 4096,
      allowPagedFallback: true,
      readOnlyMode: false
    });
    assert.strictEqual(opened.storage, 'paged');
    const engine = opened.operations as WasmDatabaseEngine;
    try {
      await engine.executeQuery('DELETE FROM items WHERE id > 5');
      await engine.executeQuery('VACUUM');
      const expected = await engine.serializeDatabase();
      const snapshot = engine.exportPagedWritableOverlay();
      assert.ok(snapshot.logicalSize < original.byteLength, 'VACUUM fixture must shrink');
      assert.strictEqual(snapshot.logicalSize, expected.byteLength);

      const result = await writePagedWritableOverlayToFile(
        fs,
        basePath,
        targetPath,
        snapshot
      );

      assert.deepStrictEqual(result, { requiresReopen: false });
      assert.deepStrictEqual(fs.readFileSync(targetPath), Buffer.from(expected));
      assert.deepStrictEqual(fs.readFileSync(basePath), Buffer.from(original));
      if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(targetPath).mode & 0o777, 0o640);
      }
    } finally {
      engine.shutdown();
    }
  });

  it('reproduces sparse growth and baseLimit bytes from serializeDatabase', async () => {
    const basePath = path.join(fixtureDir, 'growth-base.db');
    const targetPath = path.join(fixtureDir, 'growth-target.db');
    const base = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    fs.writeFileSync(basePath, base);
    const expected = new Uint8Array([
      20, 21, 22, 23,
      5, 6, 7, 8,
      9, 10, 11, 12,
      0, 0, 0, 0,
      30, 31, 32, 33,
      0, 0, 0, 0
    ]);
    const rawOverlay: RawPagedWritableOverlay = {
      chunkSize: 4,
      logicalSize: 24,
      baseLimit: 12,
      chunks: [
        { index: 0, data: new Uint8Array([20, 21, 22, 23]) },
        { index: 4, data: new Uint8Array([30, 31, 32, 33]) }
      ]
    };
    const engine = new WasmDatabaseEngine(
      fakePagedInstance(expected, rawOverlay),
      5000,
      false,
      undefined,
      {},
      {
        writable: true,
        fileSizeBytes: base.byteLength,
        exactCountMaxFileBytes: 0,
        baseIdentity: identityFromPath(basePath)
      }
    );
    try {
      const serialized = await engine.serializeDatabase();
      const snapshot = engine.exportPagedWritableOverlay();

      await writePagedWritableOverlayToFile(fs, basePath, targetPath, snapshot);

      assert.deepStrictEqual(fs.readFileSync(targetPath), Buffer.from(serialized));
      assert.deepStrictEqual(serialized, expected);
    } finally {
      engine.shutdown();
    }
  });

  it('rejects malformed host-wire snapshots before creating a replacement', async () => {
    const basePath = path.join(fixtureDir, 'validation-base.db');
    const targetPath = path.join(fixtureDir, 'validation-target.db');
    fs.writeFileSync(basePath, Buffer.alloc(16, 1));
    const valid = snapshotFor(basePath, { logicalSize: 16, baseLimit: 16 });
    const cases: Array<[string, unknown, RegExp]> = [
      ['non-bigint identity', {
        ...valid,
        baseIdentity: { ...valid.baseIdentity, ino: 2 }
      }, /baseIdentity\.ino.*bigint/i],
      ['zero chunk size', { ...valid, chunkSize: 0 }, /chunkSize.*positive safe integer/i],
      ['fractional logical size', { ...valid, logicalSize: 1.5 }, /logicalSize.*non-negative safe integer/i],
      ['base limit past original size', { ...valid, baseLimit: 17 }, /baseLimit.*original base size/i],
      ['empty run', {
        ...valid,
        runs: [{ startChunkIndex: 0, data: new ArrayBuffer(0) }],
        dirtyBytes: 0
      }, /run.*byteLength.*positive/i],
      ['misaligned run', {
        ...valid,
        runs: [{ startChunkIndex: 0, data: new ArrayBuffer(3) }],
        dirtyBytes: 3
      }, /multiple of chunkSize/i],
      ['oversized run', {
        ...valid,
        runs: [{
          startChunkIndex: 0,
          data: new ArrayBuffer(MAX_PAGED_OVERLAY_RUN_BYTES + 4)
        }],
        dirtyBytes: MAX_PAGED_OVERLAY_RUN_BYTES + 4
      }, /8 MiB/i],
      ['unsafe run start', {
        ...valid,
        runs: [{ startChunkIndex: Number.MAX_SAFE_INTEGER, data: new ArrayBuffer(4) }]
      }, /run.*start.*safe integer/i],
      ['overlapping runs', {
        ...valid,
        runs: [
          { startChunkIndex: 0, data: new ArrayBuffer(8) },
          { startChunkIndex: 1, data: new ArrayBuffer(4) }
        ],
        dirtyBytes: 12
      }, /sorted and non-overlapping/i],
      ['dirty byte mismatch', { ...valid, dirtyBytes: 5 }, /dirtyBytes.*sum/i]
    ];

    for (const [name, snapshot, expected] of cases) {
      await assert.rejects(
        writePagedWritableOverlayToFile(
          fs,
          basePath,
          targetPath,
          snapshot as PagedWritableOverlaySnapshot
        ),
        expected,
        name
      );
      assert.strictEqual(fs.existsSync(targetPath), false, name);
    }
  });

  it('fails on a short base read below baseLimit and removes its temp', async () => {
    const basePath = path.join(fixtureDir, 'short-read-base.db');
    const targetPath = path.join(fixtureDir, 'short-read-target.db');
    fs.writeFileSync(basePath, Buffer.alloc(32, 4));
    let readCalls = 0;
    const open = async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await fs.promises.open(...args);
      if (String(args[0]) !== basePath || args[1] !== 'r') return handle;
      const realRead = handle.read.bind(handle);
      return proxyHandleRead(handle, async (
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number
      ) => {
        readCalls++;
        if (readCalls > 1) return { bytesRead: 0, buffer };
        return realRead(buffer, offset, 1, position);
      });
    };

    await assert.rejects(
      writePagedWritableOverlayToFile(
        capabilityWithOpen(open as typeof fs.promises.open),
        basePath,
        targetPath,
        snapshotFor(basePath, { runs: [], dirtyBytes: 0 })
      ),
      /short read.*baseLimit/i
    );
    assert.ok(readCalls >= 2, 'the writer must loop a partial read before rejecting no progress');
    assert.strictEqual(fs.existsSync(targetPath), false);
    assert.ok(!fs.readdirSync(fixtureDir).some(name => name.includes('short-read-target.db.sqlite-explorer')));
  });

  it('cancels after one bounded reconstruction chunk and leaves the active base untouched', async () => {
    const basePath = path.join(fixtureDir, 'cancelled-active-base.db');
    const original = Buffer.alloc(3 * 1024 * 1024, 0x5a);
    fs.writeFileSync(basePath, original);
    const beforeInode = fs.statSync(basePath, { bigint: true }).ino;
    const controller = new AbortController();
    const cancellation = new Error('cancelled paged reconstruction');
    let sourceReadCalls = 0;
    let writeLockCalls = 0;
    const open = async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await fs.promises.open(...args);
      if (String(args[0]) !== basePath || args[1] !== 'r') return handle;
      const realRead = handle.read.bind(handle);
      return proxyHandleRead(handle, async (...readArgs: any[]) => {
        const result = await realRead(...readArgs);
        sourceReadCalls++;
        if (sourceReadCalls === 1) controller.abort(cancellation);
        return result;
      });
    };

    let caught: unknown;
    await writePagedWritableOverlayToFile(
      capabilityWithOpen(open as typeof fs.promises.open),
      basePath,
      basePath,
      snapshotFor(basePath, { runs: [], dirtyBytes: 0 }),
      undefined,
      () => {
        writeLockCalls++;
        return { release() {} };
      },
      controller.signal
    ).catch(error => { caught = error; });

    assert.strictEqual(caught, cancellation);
    assert.strictEqual(sourceReadCalls, 1, 'cancellation must stop before a second 1 MiB read');
    assert.strictEqual(writeLockCalls, 0, 'a cancelled reconstruction must not enter commit');
    assert.strictEqual(fs.statSync(basePath, { bigint: true }).ino, beforeInode);
    assert.deepStrictEqual(fs.readFileSync(basePath), original);
    assert.ok(!fs.readdirSync(fixtureDir).some(name => (
      name.includes('cancelled-active-base.db.sqlite-explorer')
    )));
  });

  it('saves a database whose file ID has its top bit set', async () => {
    const basePath = path.join(fixtureDir, 'high-file-id.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const capability = capabilityWithHighFileIds();
    const stats = capability.statSync(basePath, { bigint: true });
    assert.ok(stats.ino < 0n);

    const result = await writePagedWritableOverlayToFile(
      capability,
      basePath,
      basePath,
      snapshotFor(basePath, {
        baseIdentity: { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, mode: stats.mode }
      }),
      undefined,
      acquireFixtureWriteLock
    );

    assert.deepStrictEqual(result, { requiresReopen: true });
    assert.deepStrictEqual(fs.readFileSync(basePath), Buffer.from([9, 8, 7, 6, 5, 6, 7, 8]));
  });

  it('replaces the active base atomically and requires reopen', async () => {
    const basePath = path.join(fixtureDir, 'active-base.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const beforeIno = fs.statSync(basePath, { bigint: true }).ino;

    const result = await writePagedWritableOverlayToFile(
      fs,
      basePath,
      basePath,
      snapshotFor(basePath),
      undefined,
      acquireFixtureWriteLock
    );

    assert.deepStrictEqual(result, { requiresReopen: true });
    assert.notStrictEqual(fs.statSync(basePath, { bigint: true }).ino, beforeIno);
    assert.deepStrictEqual(fs.readFileSync(basePath), Buffer.from([9, 8, 7, 6, 5, 6, 7, 8]));
  });

  it('follows a target symlink to the active base and leaves the symlink in place', { skip: NO_FILE_SYMLINKS }, async () => {
    const basePath = path.join(fixtureDir, 'symlink-base.db');
    const targetPath = path.join(fixtureDir, 'symlink-target.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    fs.symlinkSync(basePath, targetPath);

    const result = await writePagedWritableOverlayToFile(
      fs,
      basePath,
      targetPath,
      snapshotFor(basePath),
      undefined,
      acquireFixtureWriteLock
    );

    assert.deepStrictEqual(result, { requiresReopen: true });
    assert.strictEqual(fs.lstatSync(targetPath).isSymbolicLink(), true);
    assert.deepStrictEqual(fs.readFileSync(basePath), Buffer.from([9, 8, 7, 6, 5, 6, 7, 8]));
  });

  it('replaces only a distinct hard-link target and does not require reopen', async () => {
    const basePath = path.join(fixtureDir, 'hard-link-base.db');
    const targetPath = path.join(fixtureDir, 'hard-link-target.db');
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    fs.writeFileSync(basePath, original);
    fs.linkSync(basePath, targetPath);

    const result = await writePagedWritableOverlayToFile(
      fs,
      basePath,
      targetPath,
      snapshotFor(basePath)
    );

    assert.deepStrictEqual(result, { requiresReopen: false });
    assert.deepStrictEqual(fs.readFileSync(basePath), Buffer.from(original));
    assert.deepStrictEqual(fs.readFileSync(targetPath), Buffer.from([9, 8, 7, 6, 5, 6, 7, 8]));
    assert.notStrictEqual(
      fs.statSync(basePath, { bigint: true }).ino,
      fs.statSync(targetPath, { bigint: true }).ino
    );
  });

  /**
   * `fs` whose copy reports when it is given its owner and its mode: `step` runs before and after
   * each of the two, with the copy's path and descriptor.
   */
  const watchingCopy = (step: (name: string, copyPath: string, fd: number) => void): typeof fs => new Proxy(fs, {
    get(real, key) {
      if (key !== 'promises') return Reflect.get(real, key);
      return new Proxy(real.promises, {
        get(promises, name) {
          if (name !== 'open') return Reflect.get(promises, name);
          return async (file: fs.PathLike, ...rest: unknown[]) => {
            const handle = await (promises.open as (...given: unknown[]) => Promise<fs.promises.FileHandle>)(file, ...rest);
            if (!/\.sqlite-explorer-[^/\\]*\.tmp$/.test(String(file))) return handle;
            return new Proxy(handle, {
              get(given, property) {
                const value = Reflect.get(given, property);
                if (typeof value !== 'function') return value;
                if (property !== 'chown' && property !== 'chmod') return value.bind(given);
                return async (...args: unknown[]) => {
                  step(`before ${property}`, String(file), given.fd);
                  const answer = await (value as (...all: unknown[]) => Promise<void>).apply(given, args);
                  step(`after ${property}`, String(file), given.fd);
                  return answer;
                };
              }
            });
          };
        }
      });
    }
  });

  it('gives its copy the old file\'s owner first, then its entries, then its mode', async (t) => {
    if (process.platform === 'win32') {
      t.skip('a copy is given no owner on Windows');
      return;
    }
    // The copy is in the destination's own folder: the order of its owner, its entries and its mode.
    const basePath = path.join(fixtureDir, 'order-base.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { mode: 0o640 });
    const events: string[] = [];
    const before = accessEntryTools.use;
    t.after(() => { accessEntryTools.use = before; });
    accessEntryTools.use = {
      readsByDescriptor: true,
      read: (files) => {
        events.push('entries');
        return files.map(() => ['user::rw-', 'group::r--', 'other::---']);
      },
      write: () => true
    };

    await writePagedWritableOverlayToFile(
      watchingCopy((name) => { if (name.startsWith('after')) events.push(name.slice('after '.length)); }),
      basePath, basePath, snapshotFor(basePath), undefined, acquireFixtureWriteLock
    );

    assert.deepStrictEqual(events, ['chown', 'entries', 'chmod']);
    assert.strictEqual(fs.statSync(basePath).mode & 0o777, 0o640);
  });

  it('keeps its copy within the permissions of the file it replaces at every step (Linux)', { skip: process.platform !== 'linux' ? 'a listing carries the mode on Linux only' : NO_REAL_ENTRIES }, async (t) => {
    const before = accessEntryTools.use;
    accessEntryTools.use = undefined;
    t.after(() => { accessEntryTools.use = before; });
    const uid = process.getuid!();
    const ownGroup = process.getgid!();
    // A folder that hands its group down makes the copy with a group the old file does not have.
    const secondGroup = process.getgroups!().find((group) => group !== ownGroup);
    if (secondGroup === undefined) t.diagnostic('this account has one group: the cases with a copy made for another group were not run');
    type Listed = { gid: number; entries: Map<string, number> };
    const rights = (text: string): number => (text[0] === 'r' ? 4 : 0) | (text[1] === 'w' ? 2 : 0) | (text[2] === 'x' ? 1 : 0);
    const listed = (file: string, gid: number): Listed => {
      // A path through this process's descriptors is another process's own under `self`.
      const reached = file.replace(/^\/proc\/self\//, `/proc/${process.pid}/`);
      const printed = spawnSync('/usr/bin/getfacl', ['-c', '-p', '-n', '-E', '--', reached], { encoding: 'utf8' });
      assert.strictEqual(printed.status, 0, printed.stderr);
      const entries = new Map<string, number>();
      for (const line of printed.stdout.split('\n')) {
        const [kind, who, granted] = line.split(':');
        if (granted !== undefined) entries.set(`${kind}:${who}`, rights(granted));
      }
      return { gid, entries };
    };
    /** What an account that is not the owner may do: one an entry names, a member of one group, or anyone else. */
    const allowed = (file: Listed, account: { user?: number; group?: number }): number => {
      const mask = file.entries.get('mask:') ?? 7;
      const named = account.user === undefined ? undefined : file.entries.get(`user:${account.user}`);
      if (named !== undefined) return named & mask;
      if (account.group !== undefined) {
        const classes = [file.gid === account.group ? file.entries.get('group:') : undefined, file.entries.get(`group:${account.group}`)]
          .filter((granted): granted is number => granted !== undefined);
        if (classes.length > 0) return classes.reduce((all, granted) => all | granted, 0) & mask;
      }
      return file.entries.get('other:') ?? 0;
    };
    const accounts = [{ user: 65534 }, { group: ownGroup }, ...(secondGroup === undefined ? [] : [{ group: secondGroup }]), {}];

    for (const own of [false, true]) {
      for (const handsDown of [false, true]) {
        for (const otherGroup of secondGroup === undefined ? [false] : [false, true]) {
          const about = `the old file ${own ? 'has an entry of its own' : 'has its mode only'}, the folder ${handsDown ? 'hands an entry down' : 'hands nothing down'}, the copy is made with ${otherGroup ? 'another group' : "the old file's group"}`;
          const folder = fs.mkdtempSync(path.join(fixtureDir, 'steps-'));
          const basePath = path.join(folder, 'base.db');
          fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
          if (otherGroup) {
            fs.chownSync(folder, uid, secondGroup!);
            fs.chmodSync(folder, 0o2770);
          }
          fs.chownSync(basePath, uid, ownGroup);
          fs.chmodSync(basePath, 0o640);
          // Checked: on a filesystem that keeps no entries these would be cases of a mode only.
          if (own) assert.strictEqual(spawnSync('/usr/bin/setfacl', ['-m', 'u:65534:r--', basePath]).status, 0, about);
          if (handsDown) assert.strictEqual(spawnSync('/usr/bin/setfacl', ['-d', '-m', 'u:65534:r-x', folder]).status, 0, about);
          const old = listed(basePath, ownGroup);
          assert.strictEqual(old.entries.has('user:65534'), own, about);
          const wider: string[] = [];
          const steps: string[] = [];

          await writePagedWritableOverlayToFile(watchingCopy((name, copyPath, fd) => {
            steps.push(name);
            const now = listed(copyPath, fs.fstatSync(fd).gid);
            for (const account of accounts) {
              const more = allowed(now, account) & ~allowed(old, account);
              if (more !== 0) wider.push(`${name}: ${JSON.stringify(account)} is allowed ${more} more than by the old file`);
            }
          }), basePath, basePath, snapshotFor(basePath), undefined, acquireFixtureWriteLock);

          assert.deepStrictEqual(steps, ['before chown', 'after chown', 'before chmod', 'after chmod'], about);
          assert.deepStrictEqual(wider, [], about);
          const now = listed(basePath, fs.statSync(basePath).gid);
          assert.deepStrictEqual([now.gid, [...now.entries]], [old.gid, [...old.entries]], about);
          assert.deepStrictEqual(fs.readFileSync(basePath), Buffer.from([9, 8, 7, 6, 5, 6, 7, 8]), about);
        }
      }
    }
  });

  it('replaces a file in a folder that hands down an entry refusing every account a file\'s removal (macOS)', { skip: process.platform !== 'darwin' && 'entries that refuse are a macOS kind' }, async (t) => {
    const before = accessEntryTools.use;
    accessEntryTools.use = undefined;
    t.after(() => { accessEntryTools.use = before; });
    // The file was there before the folder handed the entry down, so it has none. The copy is made
    // in that folder and has the entry: kept, it would stop the rename, for the copy's owner too.
    // That happened in the folder every account can write, where entries are not copied; in the
    // other one the old file's list, which is empty, always replaced the copy's.
    for (const [name, mode] of [['refusing-open', 0o777], ['refusing-mine', 0o755]] as const) {
      const folder = fs.mkdtempSync(path.join(fixtureDir, `${name}-`));
      t.after(() => { spawnSync('/bin/chmod', ['-R', '-N', folder]); });
      fs.chmodSync(folder, mode);
      const basePath = path.join(folder, 'base.db');
      fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { mode: 0o644 });
      assert.strictEqual(spawnSync('/bin/chmod', ['+a', 'group:everyone deny delete,file_inherit', folder]).status, 0);
      const log: string[] = [];

      await writePagedWritableOverlayToFile(fs, basePath, basePath, snapshotFor(basePath), (_level, message) => { log.push(message); }, acquireFixtureWriteLock);

      assert.deepStrictEqual(fs.readFileSync(basePath), Buffer.from([9, 8, 7, 6, 5, 6, 7, 8]), name);
      assert.deepStrictEqual(fs.readdirSync(folder), ['base.db'], name);
      assert.deepStrictEqual(spawnSync('/bin/ls', ['-lde', basePath], { encoding: 'utf8' }).stdout.split('\n').slice(1).filter((line) => line !== ''), [], name);
      assert.deepStrictEqual(log.filter((message) => /access-control/i.test(message)), [], name);
    }
  });

  it('gives its copy the stored list of the file it replaces, in a folder every account can write (macOS)', { skip: process.platform !== 'darwin' && 'the stored list is read through descriptors on macOS only' }, async (t) => {
    const before = accessEntryTools.use;
    accessEntryTools.use = undefined;
    accessEntryTools.storedLists = undefined;
    t.after(() => { accessEntryTools.use = before; accessEntryTools.storedLists = false; });
    const folder = fs.mkdtempSync(path.join(fixtureDir, 'stored-list-'));
    t.after(() => { spawnSync('/bin/chmod', ['-R', '-N', folder]); });
    fs.chmodSync(folder, 0o777);
    const basePath = path.join(folder, 'base.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { mode: 0o644 });
    // An entry that is only to be handed down and a right without a word: `ls` shows neither on a file.
    assert.strictEqual(spawnSync('/bin/chmod', ['+a', 'user:daemon allow read,write,file_inherit,directory_inherit,only_inherit', basePath]).status, 0);
    assert.strictEqual(spawnSync('/bin/chmod', ['+a', 'user:nobody deny delete_child', basePath]).status, 0);
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
    const was = stored(basePath);
    assert.strictEqual(was.length, 2);
    const log: string[] = [];

    await writePagedWritableOverlayToFile(fs, basePath, basePath, snapshotFor(basePath), (_level, message) => { log.push(message); }, acquireFixtureWriteLock);

    assert.deepStrictEqual(fs.readFileSync(basePath), Buffer.from([9, 8, 7, 6, 5, 6, 7, 8]));
    assert.deepStrictEqual(fs.readdirSync(folder), ['base.db']);
    assert.deepStrictEqual(stored(basePath), was);
    assert.deepStrictEqual(log.filter((message) => /access-control/i.test(message)), []);
  });

  it('removes an entry its folder hands its copy whose rights are not printed (macOS)', { skip: process.platform !== 'darwin' && 'rights that are not printed are a macOS kind' }, async (t) => {
    const before = accessEntryTools.use;
    accessEntryTools.use = undefined;
    t.after(() => { accessEntryTools.use = before; });
    // The file was there before its folder handed anything down, so it has no entry. The copy is
    // made in that folder and is handed a right `ls` has no word for on a file. Such rights can be
    // ones the system goes by, so the copy must not keep an entry the old file did not have.
    for (const kind of ['allow', 'deny']) {
      const folder = fs.mkdtempSync(path.join(fixtureDir, `unprinted-${kind}-`));
      t.after(() => { spawnSync('/bin/chmod', ['-R', '-N', folder]); });
      const basePath = path.join(folder, 'base.db');
      fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { mode: 0o600 });
      assert.strictEqual(spawnSync('/bin/chmod', ['+a', `user:nobody ${kind} delete_child,file_inherit`, folder]).status, 0);
      const listed = (file: string): string[] => spawnSync('/bin/ls', ['-lde', file], { encoding: 'utf8' }).stdout.split('\n').slice(1).filter((line) => line !== '')
        .map((line) => line.replace(/^ \d+: /, '').trimEnd());
      // What a file made there now is handed.
      const probe = path.join(folder, 'probe');
      fs.writeFileSync(probe, '');
      assert.deepStrictEqual(listed(probe), [`user:nobody inherited ${kind}`], kind);
      fs.rmSync(probe);
      const log: string[] = [];

      await writePagedWritableOverlayToFile(fs, basePath, basePath, snapshotFor(basePath), (_level, message) => { log.push(message); }, acquireFixtureWriteLock);

      assert.deepStrictEqual(fs.readFileSync(basePath), Buffer.from([9, 8, 7, 6, 5, 6, 7, 8]), kind);
      assert.deepStrictEqual(listed(basePath), [], kind);
      assert.deepStrictEqual(log.filter((message) => /access-control/i.test(message)), [], kind);
    }
  });

  // macOS reads the old file's entries by its name, so there it matters who else can rename on the
  // way to it: in a folder every account can write, entries that allow are not copied.
  for (const open of process.platform === 'darwin' ? [false, true] : [false]) {
    it(`keeps the access-control entries of the file it replaces${open ? ', and none that allow in a folder every account can write (macOS)' : ''}`, { skip: NO_REAL_ENTRIES }, async (t) => {
      const before = accessEntryTools.use;
      accessEntryTools.use = undefined;
      t.after(() => { accessEntryTools.use = before; });
      const folder = open ? fs.mkdtempSync(path.join(fixtureDir, 'open-entries-')) : fixtureDir;
      if (open) fs.chmodSync(folder, 0o777);
      const basePath = path.join(folder, 'shared-base.db');
      fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { mode: 0o640 });
      shareWithOther(basePath);
      const own = entriesForOther(basePath);
      assert.strictEqual(own.length, 1);
      const beforeIno = fs.statSync(basePath, { bigint: true }).ino;
      const forgeable = process.platform === 'darwin' && othersCanRenameIn(fs, fs.realpathSync(folder)) !== undefined;
      if (open) assert.strictEqual(forgeable, true);
      const log: string[] = [];

      await writePagedWritableOverlayToFile(fs, basePath, basePath, snapshotFor(basePath), (_level, message) => { log.push(message); }, acquireFixtureWriteLock);

      assert.notStrictEqual(fs.statSync(basePath, { bigint: true }).ino, beforeIno, 'the file is replaced, as before');
      assert.deepStrictEqual(fs.readFileSync(basePath), Buffer.from([9, 8, 7, 6, 5, 6, 7, 8]));
      assert.deepStrictEqual(entriesForOther(basePath), forgeable ? [] : own);
      assert.deepStrictEqual(log.filter((message) => /access-control/i.test(message)), forgeable ? ["Access-control entries that let accounts in were not kept on the database's new file."] : []);

      // The control: the step turned off.
      if (entriesForOther(basePath).length === 0) shareWithOther(basePath);
      accessEntryTools.use = null;
      await writePagedWritableOverlayToFile(fs, basePath, basePath, snapshotFor(basePath), undefined, acquireFixtureWriteLock);
      assert.deepStrictEqual(entriesForOther(basePath), []);
    });
  }

  // The copy is made in the folder the save holds open: through that folder's descriptor on
  // Linux, and elsewhere by a helper process from inside it. Linux runs both.
  for (const throughDescriptor of process.platform === 'linux' ? [true, false] : process.platform === 'win32' ? [] : [false]) {
    const route = process.platform !== 'linux' ? '' : throughDescriptor ? ' (through a descriptor)' : ' (by a helper process)';
    /** A database in a folder of this account's own, inside one every account can write. */
    const inOpenFolder = (name: string): { open: string; inner: string; basePath: string } => {
      const open = fs.mkdtempSync(path.join(fixtureDir, `${name}-`));
      fs.chmodSync(open, 0o777);
      const inner = path.join(open, 'inner');
      fs.mkdirSync(inner, { mode: 0o755 });
      const basePath = path.join(inner, 'base.db');
      fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
      return { open, inner, basePath };
    };
    const madeByHelper = fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0);
    /** The save's file calls, with `seen` told of each open that makes or takes the copy. */
    const watching = (seen: (file: string, flags: unknown) => void, afterFolderOpened?: () => void): typeof fs => new Proxy(fs, {
      get(real, key) {
        if (key !== 'promises') return Reflect.get(real, key);
        return new Proxy(real.promises, {
          get(promises, name) {
            if (name !== 'open') return Reflect.get(promises, name);
            return async (file: fs.PathLike, flags: unknown, ...rest: unknown[]) => {
              if (flags === 'wx' || flags === madeByHelper) seen(String(file), flags);
              const handle = await (promises.open as (...given: unknown[]) => Promise<fs.promises.FileHandle>)(file, flags, ...rest);
              if (flags === 'r' && path.basename(String(file)) === 'inner') afterFolderOpened?.();
              return handle;
            };
          }
        });
      }
    });

    it(`makes its copy in the folder it holds open, where another account can rename on the way to it${route}`, async (t) => {
      stagedSnapshotAccess.throughDescriptor = throughDescriptor;
      t.after(() => { stagedSnapshotAccess.throughDescriptor = true; });
      const { inner, basePath } = inOpenFolder('paged-open');
      const opened: Array<[string, unknown]> = [];
      let helpers = 0;
      const start = childProcess.spawnSync;
      t.mock.method(childProcess, 'spawnSync', ((...args: unknown[]) => {
        if (args[0] === process.execPath) helpers++;
        return (start as (...given: unknown[]) => unknown)(...args);
      }) as typeof childProcess.spawnSync);

      const result = await writePagedWritableOverlayToFile(watching((file, flags) => { opened.push([file, flags]); }), basePath, basePath, snapshotFor(basePath), undefined, acquireFixtureWriteLock);

      assert.deepStrictEqual(result, { requiresReopen: true });
      assert.deepStrictEqual(fs.readFileSync(basePath), Buffer.from([9, 8, 7, 6, 5, 6, 7, 8]));
      assert.deepStrictEqual(fs.readdirSync(inner), ['base.db']);
      assert.strictEqual(opened.length, 1);
      if (throughDescriptor) {
        assert.match(opened[0][0], /^\/proc\/self\/fd\/\d+\/\.base\.db\.sqlite-explorer-[-0-9a-f]+\.tmp$/);
        assert.strictEqual(opened[0][1], 'wx');
        assert.strictEqual(helpers, 0);
      } else {
        assert.strictEqual(fs.realpathSync(path.dirname(opened[0][0])), fs.realpathSync(inner));
        assert.strictEqual(opened[0][1], madeByHelper);
        assert.strictEqual(helpers, 1);
      }

      // In a folder no other account can rename on the way to, it is made by name, as before.
      const own = path.join(fixtureDir, `own-${throughDescriptor}.db`);
      fs.writeFileSync(own, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
      opened.length = 0;
      helpers = 0;
      if (othersCanRenameIn(fs, fs.realpathSync(fixtureDir), process.platform, process.platform === 'darwin' ? undefined : false) === undefined) {
        await writePagedWritableOverlayToFile(watching((file, flags) => { opened.push([file, flags]); }), own, own, snapshotFor(own), undefined, acquireFixtureWriteLock);
        assert.deepStrictEqual(opened.map(([file, flags]) => [path.dirname(file) === fs.realpathSync(fixtureDir), flags]), [[true, 'wx']]);
        assert.strictEqual(helpers, 0);
      }
    });

    it(`makes its copy only in the folder it took hold of${route}`, async (t) => {
      stagedSnapshotAccess.throughDescriptor = throughDescriptor;
      t.after(() => { stagedSnapshotAccess.throughDescriptor = true; });
      const { open, inner, basePath } = inOpenFolder('paged-swapped');
      const away = path.join(open, 'inner-away');
      // Once the save has opened the database's folder: that folder moved away, and another under its name.
      const files = watching(() => undefined, () => {
        if (fs.existsSync(away)) return;
        fs.renameSync(inner, away);
        fs.mkdirSync(inner, { mode: 0o777 });
      });

      await assert.rejects(
        writePagedWritableOverlayToFile(files, basePath, basePath, snapshotFor(basePath), undefined, acquireFixtureWriteLock),
        // Whichever look meets the other folder first: the one for the copy, or the one at the database itself.
        /Save target changed on disk; retry the save\.|Database file changed on disk; reload the document\./
      );

      assert.deepStrictEqual(fs.readdirSync(inner), [], 'nothing of the save is in the folder put there');
      assert.deepStrictEqual(fs.readdirSync(away), ['base.db'], 'and nothing is left beside the database');
      assert.deepStrictEqual(fs.readFileSync(path.join(away, 'base.db')), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    });

    it(`writes into no other file than the one the helper process made${route}`, { skip: throughDescriptor && 'only where no path through a descriptor is to be had' }, async (t) => {
      stagedSnapshotAccess.throughDescriptor = throughDescriptor;
      t.after(() => { stagedSnapshotAccess.throughDescriptor = true; });
      const { open, inner, basePath } = inOpenFolder('paged-other-file');
      const away = path.join(open, 'inner-away');
      // Once the helper process has made the copy: the database's folder moved away, and another
      // under its name that holds a file of the copy's name, which this account may write.
      const start = childProcess.spawnSync;
      t.mock.method(childProcess, 'spawnSync', ((...args: unknown[]) => {
        const answer = (start as (...given: unknown[]) => unknown)(...args);
        if (args[0] === process.execPath) {
          const copy = fs.readdirSync(inner).find((name) => name.endsWith('.tmp'))!;
          fs.renameSync(inner, away);
          fs.mkdirSync(inner, { mode: 0o777 });
          fs.writeFileSync(path.join(inner, copy), 'theirs', { mode: 0o666 });
        }
        return answer;
      }) as typeof childProcess.spawnSync);

      await assert.rejects(
        writePagedWritableOverlayToFile(fs, basePath, basePath, snapshotFor(basePath), undefined, acquireFixtureWriteLock),
        /Save target changed on disk; retry the save\./
      );

      const theirs = fs.readdirSync(inner);
      assert.strictEqual(theirs.length, 1);
      assert.strictEqual(fs.readFileSync(path.join(inner, theirs[0]), 'utf8'), 'theirs', 'the other file is as it was');
      assert.deepStrictEqual(fs.readFileSync(path.join(away, 'base.db')), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    });

    it(`fails when the helper process cannot be run${route}`, { skip: throughDescriptor && 'only where no path through a descriptor is to be had' }, async (t) => {
      stagedSnapshotAccess.throughDescriptor = throughDescriptor;
      t.after(() => { stagedSnapshotAccess.throughDescriptor = true; });
      const { inner, basePath } = inOpenFolder('paged-no-helper');
      const start = childProcess.spawnSync;
      t.mock.method(childProcess, 'spawnSync', ((...args: unknown[]) => (args[0] === process.execPath
        ? { error: Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT' }), status: null, stdout: '', stderr: '' }
        : (start as (...given: unknown[]) => unknown)(...args))) as typeof childProcess.spawnSync);
      const opened: string[] = [];

      await assert.rejects(
        writePagedWritableOverlayToFile(watching((file) => { opened.push(file); }), basePath, basePath, snapshotFor(basePath), undefined, acquireFixtureWriteLock),
        /The save could not make its file beside the destination: the helper process failed/
      );

      assert.deepStrictEqual(opened, []);
      assert.deepStrictEqual(fs.readdirSync(inner), ['base.db']);
      assert.deepStrictEqual(fs.readFileSync(basePath), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    });
  }

  it('preserves an existing distinct target mode for Save As', async (t) => {
    if (process.platform === 'win32') {
      t.skip(NO_POSIX_MODES);
      return;
    }
    const basePath = path.join(fixtureDir, 'mode-base.db');
    const targetPath = path.join(fixtureDir, 'mode-target.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    fs.chmodSync(basePath, 0o640);
    fs.writeFileSync(targetPath, Buffer.alloc(8, 2));
    fs.chmodSync(targetPath, 0o604);

    const result = await writePagedWritableOverlayToFile(
      fs,
      basePath,
      targetPath,
      snapshotFor(basePath)
    );

    assert.deepStrictEqual(result, { requiresReopen: false });
    assert.strictEqual(fs.statSync(targetPath).mode & 0o777, 0o604);
  });

  it('restores the active base owner, group, and ordinary mode on the temp inode', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX ownership metadata is not meaningful on Windows');
      return;
    }

    const basePath = path.join(fixtureDir, 'active-owner-mode.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    fs.chmodSync(basePath, 0o644);
    const before = fs.statSync(basePath);
    const chownCalls: Array<[number, number]> = [];
    const open = async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await fs.promises.open(...args);
      if (args[1] !== 'wx') return handle;
      const realChown = handle.chown.bind(handle);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'chown') {
            return async (uid: number, gid: number) => {
              chownCalls.push([uid, gid]);
              await realChown(uid, gid);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };

    const result = await writePagedWritableOverlayToFile(
      capabilityWithOpen(open as typeof fs.promises.open),
      basePath,
      basePath,
      snapshotFor(basePath),
      undefined,
      acquireFixtureWriteLock
    );

    const after = fs.statSync(basePath);
    assert.deepStrictEqual(result, { requiresReopen: true });
    assert.deepStrictEqual(chownCalls, [[before.uid, before.gid]]);
    assert.strictEqual(after.uid, before.uid);
    assert.strictEqual(after.gid, before.gid);
    assert.strictEqual(after.mode & 0o777, 0o644);
  });

  it('continues after EPERM restoring ownership and emits one output-channel note', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX ownership metadata is not meaningful on Windows');
      return;
    }

    const basePath = path.join(fixtureDir, 'owner-eperm.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    fs.chmodSync(basePath, 0o644);
    const warnings: Array<{ message: string; error: unknown }> = [];
    let chownCalls = 0;
    const open = async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await fs.promises.open(...args);
      if (args[1] !== 'wx') return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'chown') {
            return async () => {
              chownCalls++;
              throw Object.assign(new Error('synthetic foreign-owner EPERM'), { code: 'EPERM' });
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };

    const result = await writePagedWritableOverlayToFile(
      capabilityWithOpen(open as typeof fs.promises.open),
      basePath,
      basePath,
      snapshotFor(basePath),
      (_level, message, error) => warnings.push({ message, error }),
      acquireFixtureWriteLock
    );

    assert.deepStrictEqual(result, { requiresReopen: true });
    assert.strictEqual(chownCalls, 1);
    assert.deepStrictEqual(
      fs.readFileSync(basePath),
      Buffer.from([9, 8, 7, 6, 5, 6, 7, 8])
    );
    assert.strictEqual(fs.statSync(basePath).mode & 0o777, 0o644);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0].message, /could not restore.*owner\/group/i);
    assert.match(warnings[0].message, /parent directory.*ACL/i);
    assert.match(String(warnings[0].error), /synthetic foreign-owner EPERM/i);
  });

  it('preserves the active base mode observed when the save starts', async (t) => {
    if (process.platform === 'win32') {
      t.skip(NO_POSIX_MODES);
      return;
    }
    const basePath = path.join(fixtureDir, 'active-mode-before-save.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    fs.chmodSync(basePath, 0o644);
    const snapshot = snapshotFor(basePath);

    // Permission changes do not alter SQLite bytes, but a save must not undo a
    // tightening performed after the paged session opened.
    fs.chmodSync(basePath, 0o600);

    await writePagedWritableOverlayToFile(
      fs,
      basePath,
      basePath,
      snapshot,
      undefined,
      acquireFixtureWriteLock
    );

    assert.strictEqual(fs.statSync(basePath).mode & 0o777, 0o600);
  });

  it('aborts if the active base mode changes during assembly', async (t) => {
    if (process.platform === 'win32') {
      t.skip(NO_POSIX_MODES);
      return;
    }
    const basePath = path.join(fixtureDir, 'active-mode-during-save.db');
    fs.writeFileSync(basePath, Buffer.alloc(64, 3));
    fs.chmodSync(basePath, 0o640);
    const snapshot = snapshotFor(basePath, { runs: [], dirtyBytes: 0 });
    const original = fs.readFileSync(basePath);
    let modeChanged = false;
    let renameCalls = 0;
    const open = async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await fs.promises.open(...args);
      if (String(args[0]) !== basePath || args[1] !== 'r') return handle;
      const realRead = handle.read.bind(handle);
      return proxyHandleRead(handle, async (...readArgs: any[]) => {
        const result = await (realRead as any)(...readArgs);
        if (!modeChanged) {
          modeChanged = true;
          fs.chmodSync(basePath, 0o600);
        }
        return result;
      });
    };
    const capability = capabilityWithOpen(open as typeof fs.promises.open, {}, {
      renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
        renameCalls++;
        return fs.renameSync(...args);
      }) as typeof fs.renameSync
    });

    await assert.rejects(
      writePagedWritableOverlayToFile(
        capability,
        basePath,
        basePath,
        snapshot,
        undefined,
        acquireFixtureWriteLock
      ),
      /save target changed on disk/i
    );

    assert.strictEqual(modeChanged, true);
    assert.strictEqual(renameCalls, 0);
    assert.deepStrictEqual(fs.readFileSync(basePath), original);
    assert.strictEqual(fs.statSync(basePath).mode & 0o777, 0o600);
    assert.ok(!fs.readdirSync(fixtureDir).some(name => name.includes('active-mode-during-save.db.sqlite-explorer')));
  });

  it('replaces a database without a warning', async () => {
    const basePath = path.join(fixtureDir, 'quiet-save-base.db');
    const targetPath = path.join(fixtureDir, 'quiet-save-target.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const warnings: string[] = [];

    await writePagedWritableOverlayToFile(
      fs,
      basePath,
      targetPath,
      snapshotFor(basePath),
      (_level, message) => { warnings.push(message); }
    );

    assert.deepStrictEqual(warnings, []);
  });

  it('says what to do when the target cannot be replaced, and leaves it as it was', async () => {
    const basePath = path.join(fixtureDir, 'refused-save-base.db');
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    fs.writeFileSync(basePath, original);
    const refusal = Object.assign(new Error("EPERM: operation not permitted, rename 'copy' -> 'refused-save-base.db'"), { code: 'EPERM' });
    const refusing = capabilityWithOpen(fs.promises.open, {}, {
      renameSync: (() => { throw refusal; }) as typeof fs.renameSync
    });

    await assert.rejects(
      writePagedWritableOverlayToFile(refusing, basePath, basePath, snapshotFor(basePath), undefined, acquireFixtureWriteLock),
      (error: unknown) => {
        // Only Windows refuses to replace a file another program has open.
        const reported = (error as Error).cause as NodeJS.ErrnoException;
        if (process.platform === 'win32') {
          assert.match((error as Error).message, /another program has the file open/);
          assert.strictEqual(reported.cause, refusal);
          assert.strictEqual(reported.code, 'EPERM');
        } else {
          assert.strictEqual(reported, refusal);
        }
        return true;
      }
    );

    assert.deepStrictEqual(new Uint8Array(fs.readFileSync(basePath)), original);
    assert.ok(!fs.readdirSync(fixtureDir).some(name => name.includes('refused-save-base.db.sqlite-explorer')));
  });

  it('waits for a lock that is held for a moment, then replaces the database', async () => {
    const basePath = path.join(fixtureDir, 'momentary-lock-base.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    let attempts = 0;
    const busyOnce = () => {
      if (++attempts === 1) throw Object.assign(new Error('another connection holds a lock'), { momentary: true });
      return acquireFixtureWriteLock();
    };

    const result = await writePagedWritableOverlayToFile(fs, basePath, basePath, snapshotFor(basePath), undefined, busyOnce);

    assert.strictEqual(attempts, 2);
    assert.deepStrictEqual(result, { requiresReopen: true });
    assert.deepStrictEqual(fs.readFileSync(basePath), Buffer.from([9, 8, 7, 6, 5, 6, 7, 8]));
  });

  it('does not wait for a lock that fails for another reason', async () => {
    const basePath = path.join(fixtureDir, 'failed-lock-base.db');
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    fs.writeFileSync(basePath, original);
    let attempts = 0;
    const failing = () => {
      attempts++;
      throw new Error('this host has no SQLite write locking');
    };

    await assert.rejects(
      writePagedWritableOverlayToFile(fs, basePath, basePath, snapshotFor(basePath), undefined, failing)
    );

    assert.strictEqual(attempts, 1);
    assert.deepStrictEqual(new Uint8Array(fs.readFileSync(basePath)), original);
  });

  it('replaces the database once Windows stops refusing it', async () => {
    const basePath = path.join(fixtureDir, 'refused-twice-base.db');
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    fs.writeFileSync(basePath, original);
    const refusal = Object.assign(new Error("EPERM: operation not permitted, rename 'copy' -> 'refused-twice-base.db'"), { code: 'EPERM' });
    let attempts = 0;
    const refusingTwice = capabilityWithOpen(fs.promises.open, {}, {
      renameSync: ((from: fs.PathLike, to: fs.PathLike) => {
        if (++attempts <= 2) throw refusal;
        fs.renameSync(from, to);
      }) as typeof fs.renameSync
    });
    const save = writePagedWritableOverlayToFile(refusingTwice, basePath, basePath, snapshotFor(basePath), undefined, acquireFixtureWriteLock);

    if (process.platform === 'win32') {
      assert.deepStrictEqual(await save, { requiresReopen: true });
      assert.strictEqual(attempts, 3);
      assert.deepStrictEqual(fs.readFileSync(basePath), Buffer.from([9, 8, 7, 6, 5, 6, 7, 8]));
    } else {
      // Nothing but Windows refuses a rename for a moment, so nothing is tried again.
      await assert.rejects(save);
      assert.strictEqual(attempts, 1);
      assert.deepStrictEqual(new Uint8Array(fs.readFileSync(basePath)), original);
    }
    assert.ok(!fs.readdirSync(fixtureDir).some(name => name.includes('refused-twice-base.db.sqlite-explorer')));
  });

  it('fsyncs the replacement directory after the atomic rename', async () => {
    const basePath = path.join(fixtureDir, 'directory-sync-base.db');
    const targetPath = path.join(fixtureDir, 'directory-sync-target.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    let directorySyncCalls = 0;
    const open = async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await fs.promises.open(...args);
      if (String(args[0]) !== fixtureDir || args[1] !== 'r') return handle;
      const realSync = handle.sync.bind(handle);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') {
            return async () => {
              directorySyncCalls++;
              await realSync();
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };

    await writePagedWritableOverlayToFile(
      capabilityWithOpen(open as typeof fs.promises.open),
      basePath,
      targetPath,
      snapshotFor(basePath)
    );

    assert.strictEqual(directorySyncCalls, 1);
  });

  it('reports directory fsync failure as durability uncertainty after a successful rename', async () => {
    const basePath = path.join(fixtureDir, 'directory-sync-warning-base.db');
    const targetPath = path.join(fixtureDir, 'directory-sync-warning-target.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const warnings: Array<{ message: string; error: unknown }> = [];
    const open = async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await fs.promises.open(...args);
      if (String(args[0]) !== fixtureDir || args[1] !== 'r') return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') {
            return async () => { throw new Error('synthetic directory fsync failure'); };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };

    const result = await writePagedWritableOverlayToFile(
      capabilityWithOpen(open as typeof fs.promises.open),
      basePath,
      targetPath,
      snapshotFor(basePath),
      (_level, message, error) => warnings.push({ message, error })
    );

    assert.deepStrictEqual(result, { requiresReopen: false });
    assert.deepStrictEqual(
      fs.readFileSync(targetPath),
      Buffer.from([9, 8, 7, 6, 5, 6, 7, 8])
    );
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0].message, /durability could not be confirmed/i);
    assert.match(String(warnings[0].error), /synthetic directory fsync failure/i);
  });

  it('aborts after a post-read base mutation, removes its temp, and never renames', async () => {
    const basePath = path.join(fixtureDir, 'toctou-base.db');
    const targetPath = path.join(fixtureDir, 'toctou-target.db');
    fs.writeFileSync(basePath, Buffer.alloc(64, 3));
    const snapshot = snapshotFor(basePath, { runs: [], dirtyBytes: 0 });
    let readObserved = false;
    let renameCalls = 0;
    const open = async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await fs.promises.open(...args);
      if (String(args[0]) !== basePath || args[1] !== 'r') return handle;
      const realRead = handle.read.bind(handle);
      return proxyHandleRead(handle, async (...readArgs: any[]) => {
        const result = await (realRead as any)(...readArgs);
        if (!readObserved) {
          readObserved = true;
          fs.writeFileSync(basePath, Buffer.alloc(64, 4));
          const future = new Date('2100-01-01T00:00:00.000Z');
          fs.utimesSync(basePath, future, future);
        }
        return result;
      });
    };
    const capability = capabilityWithOpen(open as typeof fs.promises.open, {}, {
      renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
        renameCalls++;
        return fs.renameSync(...args);
      }) as typeof fs.renameSync
    });

    await assert.rejects(
      writePagedWritableOverlayToFile(capability, basePath, targetPath, snapshot),
      /file changed on disk; reload the document/i
    );

    assert.strictEqual(readObserved, true);
    assert.strictEqual(renameCalls, 0);
    assert.strictEqual(fs.existsSync(targetPath), false);
    assert.ok(!fs.readdirSync(fixtureDir).some(name => name.includes('toctou-target.db.sqlite-explorer')));
  });

  it('aborts when a frame-bearing WAL appears at the final replacement gate', async () => {
    const basePath = path.join(fixtureDir, 'late-wal-base.db');
    const targetPath = path.join(fixtureDir, 'late-wal-target.db');
    const walPath = `${basePath}-wal`;
    const original = Buffer.alloc(64, 3);
    fs.writeFileSync(basePath, original);
    const snapshot = snapshotFor(basePath, { runs: [], dirtyBytes: 0 });
    let walCreated = false;
    let renameCalls = 0;
    const capability = capabilityWithOpen(fs.promises.open, {}, {
      statSync: ((...args: Parameters<typeof fs.statSync>) => {
        const stats = (fs.statSync as any)(...args);
        if (!walCreated && String(args[0]) === basePath) {
          // Model the external writer winning the race after the main-file
          // identity check but before the synchronous rename.
          fs.writeFileSync(walPath, Buffer.alloc(33, 7));
          walCreated = true;
        }
        return stats;
      }) as typeof fs.statSync,
      renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
        renameCalls++;
        return fs.renameSync(...args);
      }) as typeof fs.renameSync
    });

    await assert.rejects(
      writePagedWritableOverlayToFile(capability, basePath, targetPath, snapshot),
      /WAL.*uncheckpointed frames.*reload/i
    );

    assert.strictEqual(walCreated, true);
    assert.strictEqual(renameCalls, 0);
    assert.deepStrictEqual(fs.readFileSync(basePath), original);
    assert.strictEqual(fs.existsSync(targetPath), false);
    assert.strictEqual(fs.statSync(walPath).size, 33, 'the external WAL must never be deleted');
    assert.ok(!fs.readdirSync(fixtureDir).some(name => name.includes('late-wal-target.db.sqlite-explorer')));
  });

  it('refuses Save As over an open target with uncheckpointed WAL frames', async () => {
    const basePath = path.join(fixtureDir, 'target-wal-base.db');
    const targetPath = path.join(fixtureDir, 'target-wal-existing.db');
    const walPath = `${targetPath}-wal`;
    const shmPath = `${targetPath}-shm`;
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));

    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const targetDatabase = new DatabaseSync(targetPath);
    try {
      targetDatabase.exec(
        'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; ' +
        'CREATE TABLE original_target (value TEXT); ' +
        "INSERT INTO original_target VALUES ('keep me')"
      );
      assert.ok(fs.statSync(walPath).size > 32, 'the target fixture must have WAL frames');
      assert.ok(fs.statSync(shmPath).size > 0, 'the target fixture must have shared WAL state');
      const originalTarget = fs.readFileSync(targetPath);
      const originalWal = fs.readFileSync(walPath);
      let renameCalls = 0;
      const capability = capabilityWithOpen(fs.promises.open, {}, {
        renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
          renameCalls++;
          return fs.renameSync(...args);
        }) as typeof fs.renameSync
      });

      await assert.rejects(
        writePagedWritableOverlayToFile(
          capability,
          basePath,
          targetPath,
          snapshotFor(basePath)
        ),
        /Save As target.*WAL.*uncheckpointed frames/i
      );

      assert.strictEqual(renameCalls, 0);
      assert.deepStrictEqual(fs.readFileSync(targetPath), originalTarget);
      assert.deepStrictEqual(fs.readFileSync(walPath), originalWal);
      assert.ok(fs.statSync(shmPath).size > 0, 'SQLite must retain control of its shared state');
      assert.ok(
        !fs.readdirSync(fixtureDir)
          .some(name => name.includes('target-wal-existing.db.sqlite-explorer'))
      );
    } finally {
      targetDatabase.close();
    }
  });

  it('rechecks the Save As target WAL after releasing a Windows-style target lock', async () => {
    const basePath = path.join(fixtureDir, 'target-windows-base.db');
    const targetPath = path.join(fixtureDir, 'target-windows-existing.db');
    const walPath = `${targetPath}-wal`;
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const targetDatabase = new (SqlJsModule.Database as any)();
    targetDatabase.run('CREATE TABLE target_table (id INTEGER PRIMARY KEY)');
    fs.writeFileSync(targetPath, Buffer.from(targetDatabase.export()));
    targetDatabase.close();

    let lockedPath: string | undefined;
    let renameCalls = 0;
    const capability = capabilityWithOpen(fs.promises.open, {}, {
      renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
        renameCalls++;
        return fs.renameSync(...args);
      }) as typeof fs.renameSync
    });

    await assert.rejects(
      writePagedWritableOverlayToFile(
        capability,
        basePath,
        targetPath,
        snapshotFor(basePath),
        undefined,
        lockPath => {
          lockedPath = lockPath;
          return {
            releaseBeforeRename: true,
            release() {
              fs.writeFileSync(walPath, Buffer.alloc(33, 7));
            }
          };
        }
      ),
      /Save As target.*WAL.*uncheckpointed frames/i
    );

    assert.strictEqual(lockedPath, fs.realpathSync(targetPath));
    assert.strictEqual(renameCalls, 0);
    assert.strictEqual(fs.statSync(walPath).size, 33);
  });

  it('keeps the no-lock fast path for a nonexistent Save As target', async () => {
    const basePath = path.join(fixtureDir, 'new-target-base.db');
    const targetPath = path.join(fixtureDir, 'new-target.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    let lockCalls = 0;

    const result = await writePagedWritableOverlayToFile(
      fs,
      basePath,
      targetPath,
      snapshotFor(basePath),
      undefined,
      () => {
        lockCalls++;
        throw new Error('a new target must not acquire a SQLite lock');
      }
    );

    assert.deepStrictEqual(result, { requiresReopen: false });
    assert.strictEqual(lockCalls, 0);
  });

  it('locks and replaces a clean existing SQLite Save As target', async () => {
    const basePath = path.join(fixtureDir, 'clean-target-base.db');
    const targetPath = path.join(fixtureDir, 'clean-target-existing.db');
    const originalBase = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    fs.writeFileSync(basePath, originalBase);
    const targetDatabase = new (SqlJsModule.Database as any)();
    targetDatabase.run('CREATE TABLE old_target (id INTEGER PRIMARY KEY)');
    fs.writeFileSync(targetPath, Buffer.from(targetDatabase.export()));
    targetDatabase.close();
    let lockedPath: string | undefined;
    let releaseCalls = 0;

    const result = await writePagedWritableOverlayToFile(
      fs,
      basePath,
      targetPath,
      snapshotFor(basePath),
      undefined,
      databasePath => {
        lockedPath = databasePath;
        return { release: () => { releaseCalls++; } };
      }
    );

    assert.deepStrictEqual(result, { requiresReopen: false });
    assert.strictEqual(lockedPath, fs.realpathSync(targetPath));
    assert.strictEqual(releaseCalls, 1);
    assert.deepStrictEqual(fs.readFileSync(targetPath), Buffer.from([9, 8, 7, 6, 5, 6, 7, 8]));
  });

  it('releases a Windows-style SQLite handle before rename and repeats the final gates', async () => {
    const basePath = path.join(fixtureDir, 'windows-sharing-base.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    let released = false;
    let postReleaseBaseChecks = 0;
    const events: string[] = [];
    const capability = capabilityWithOpen(fs.promises.open, {}, {
      statSync: ((...args: Parameters<typeof fs.statSync>) => {
        if (released && String(args[0]) === basePath) {
          postReleaseBaseChecks++;
          events.push('post-release-base-check');
        }
        return (fs.statSync as any)(...args);
      }) as typeof fs.statSync,
      renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
        if (!released) {
          throw Object.assign(
            new Error('simulated Windows sharing violation: SQLite handle still open'),
            { code: 'EPERM' }
          );
        }
        assert.ok(postReleaseBaseChecks > 0, 'identity gates must rerun after releasing the lock');
        events.push('rename');
        return fs.renameSync(...args);
      }) as typeof fs.renameSync
    });

    await writePagedWritableOverlayToFile(
      capability,
      basePath,
      basePath,
      snapshotFor(basePath),
      undefined,
      () => ({
        releaseBeforeRename: true,
        release() {
          released = true;
          events.push('release');
        }
      })
    );

    assert.deepStrictEqual(events.slice(-2), ['post-release-base-check', 'rename']);
    assert.ok(events.indexOf('release') < events.indexOf('post-release-base-check'));
  });

  it('closes the copy source before replacement and rejects changes during its close', async () => {
    for (const mutateAtClose of [false, true]) {
      const basePath = path.join(fixtureDir, `source-close-${mutateAtClose}.db`);
      fs.writeFileSync(basePath, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
      let sourceOpen = false;
      let renamed = false;
      const open = async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await fs.promises.open(...args);
        if (String(args[0]) !== basePath) return handle;
        sourceOpen = true;
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'close') return async () => {
              await target.close();
              sourceOpen = false;
              if (mutateAtClose) fs.writeFileSync(basePath, Buffer.alloc(16, 7));
            };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      };
      const capability = capabilityWithOpen(open as typeof fs.promises.open, {}, {
        renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
          assert.strictEqual(sourceOpen, false, 'Windows replacement cannot retain a read handle');
          renamed = true;
          return fs.renameSync(...args);
        }) as typeof fs.renameSync
      });
      const save = writePagedWritableOverlayToFile(
        capability, basePath, basePath, snapshotFor(basePath), undefined, acquireFixtureWriteLock
      );
      if (mutateAtClose) {
        await assert.rejects(save, /file changed on disk|save target changed on disk/i);
        assert.strictEqual(renamed, false);
        assert.deepStrictEqual(fs.readFileSync(basePath), Buffer.alloc(16, 7));
      } else {
        await save;
        assert.strictEqual(renamed, true);
        assert.deepStrictEqual(fs.readFileSync(basePath), Buffer.from([9, 8, 7, 6, 5, 6, 7, 8]));
      }
    }
  });

  it('rejects WAL frames that appear after releasing a Windows-style lock', async () => {
    const basePath = path.join(fixtureDir, 'windows-post-release-wal-base.db');
    const walPath = `${basePath}-wal`;
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    let renameCalls = 0;
    const capability = capabilityWithOpen(fs.promises.open, {}, {
      renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
        renameCalls++;
        return fs.renameSync(...args);
      }) as typeof fs.renameSync
    });

    await assert.rejects(
      writePagedWritableOverlayToFile(
        capability,
        basePath,
        basePath,
        snapshotFor(basePath),
        undefined,
        () => ({
          releaseBeforeRename: true,
          release() {
            fs.writeFileSync(walPath, Buffer.alloc(33, 7));
          }
        })
      ),
      /WAL.*uncheckpointed frames.*reload/i
    );

    assert.strictEqual(renameCalls, 0);
  });

  it('holds a cross-process SQLite write lock through rename on POSIX', async (t) => {
    if (process.platform === 'win32') {
      t.skip('Windows must close SQLite handles before rename; covered by unit simulation');
      return;
    }
    const binary = bundledNativeBinary();
    if (!binary) {
      t.skip('no bundled native SQLite runtime for this platform');
      return;
    }

    const basePath = path.join(fixtureDir, 'cross-process-lock-base.db');
    const db = new (SqlJsModule.Database as any)();
    db.run(
      'CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); ' +
      "INSERT INTO items VALUES (1, 'original')"
    );
    fs.writeFileSync(basePath, Buffer.from(db.export()));
    db.close();

    const snapshot = snapshotFor(basePath, { runs: [], dirtyBytes: 0 });
    let externalWriter: ReturnType<typeof spawnSync> | undefined;
    const capability = capabilityWithOpen(fs.promises.open, {}, {
      renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
        // This is the exact cross-process window under review: the external
        // connection switches the rollback database to WAL and commits after
        // every metadata/WAL check, immediately before the replacement.
        const script =
          "const sqlite = await import('tjs:sqlite');" +
          `const db = new sqlite.Database(${JSON.stringify(basePath)});` +
          "db.exec(\"PRAGMA busy_timeout=50; PRAGMA journal_mode=WAL; " +
          "UPDATE items SET value='external' WHERE id=1\");" +
          'db.close();';
        externalWriter = spawnSync(binary, ['eval', script], {
          encoding: 'utf8',
          timeout: 2_000
        });
        return fs.renameSync(...args);
      }) as typeof fs.renameSync
    });

    await writePagedWritableOverlayToFile(
      capability,
      basePath,
      basePath,
      snapshot
    );

    assert.ok(externalWriter, 'the external writer probe must run inside renameSync');
    assert.notStrictEqual(
      externalWriter.status,
      0,
      'BEGIN IMMEDIATE must keep the external WAL writer from committing in the final window'
    );
    const reopened = new (SqlJsModule.Database as any)(fs.readFileSync(basePath));
    try {
      assert.deepStrictEqual(
        reopened.exec('SELECT value FROM items WHERE id=1')[0].values,
        [['original']]
      );
    } finally {
      reopened.close();
    }
  });

  it('refuses an in-place temp chmod after close with the same inode and size', async () => {
    const basePath = path.join(fixtureDir, 'temp-swap-base.db');
    const targetPath = path.join(fixtureDir, 'temp-swap-target.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    let temporaryMutated = false;
    let renameCalls = 0;
    const capability = capabilityWithOpen(fs.promises.open, {}, {
      lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => {
        const candidatePath = String(args[0]);
        if (!temporaryMutated && candidatePath.includes('temp-swap-target.db.sqlite-explorer')) {
          temporaryMutated = true;
          const before = fs.lstatSync(candidatePath, { bigint: true });
          // A mode the file does not have yet. A chmod to its present mode
          // changes nothing some file systems record: a folder shared into a
          // container from macOS keeps the same ctime.
          fs.chmodSync(candidatePath, Number(before.mode & 0o777n) ^ 0o040);
          const after = fs.lstatSync(candidatePath, { bigint: true });
          assert.strictEqual(after.ino, before.ino);
          assert.strictEqual(after.size, before.size);
          assert.notStrictEqual(after.mode, before.mode);
        }
        return (fs.lstatSync as any)(...args);
      }) as typeof fs.lstatSync,
      renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
        renameCalls++;
        return fs.renameSync(...args);
      }) as typeof fs.renameSync
    });

    await assert.rejects(
      writePagedWritableOverlayToFile(
        capability,
        basePath,
        targetPath,
        snapshotFor(basePath)
      ),
      /temporary database changed before rename/i
    );

    assert.strictEqual(temporaryMutated, true);
    assert.strictEqual(renameCalls, 0);
    assert.strictEqual(fs.existsSync(targetPath), false);
    assert.ok(!fs.readdirSync(fixtureDir).some(name => name.includes('temp-swap-target.db.sqlite-explorer')));
  });

  it('refuses an existing Save As target chmod after initial resolution', async (t) => {
    if (process.platform === 'win32') {
      t.skip(NO_POSIX_MODES);
      return;
    }
    const basePath = path.join(fixtureDir, 'target-chmod-base.db');
    const targetPath = path.join(fixtureDir, 'target-chmod-target.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    fs.writeFileSync(targetPath, Buffer.alloc(8, 0x55));
    fs.chmodSync(targetPath, 0o600);
    let targetMutated = false;
    let renameCalls = 0;
    const capability = capabilityWithOpen(fs.promises.open, {}, {
      statSync: ((...args: Parameters<typeof fs.statSync>) => {
        if (!targetMutated && String(args[0]) === fs.realpathSync(targetPath)) {
          targetMutated = true;
          fs.chmodSync(targetPath, 0o644);
        }
        return (fs.statSync as any)(...args);
      }) as typeof fs.statSync,
      renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
        renameCalls++;
        return fs.renameSync(...args);
      }) as typeof fs.renameSync
    });

    await assert.rejects(
      writePagedWritableOverlayToFile(
        capability,
        basePath,
        targetPath,
        snapshotFor(basePath)
      ),
      /save target changed on disk/i
    );

    assert.strictEqual(targetMutated, true);
    assert.strictEqual(renameCalls, 0);
    assert.deepStrictEqual(fs.readFileSync(targetPath), Buffer.alloc(8, 0x55));
    assert.ok(!fs.readdirSync(fixtureDir).some(name => name.includes('target-chmod-target.db.sqlite-explorer')));
  });

  it('uses no promise-based filesystem operations after the temp closes', async () => {
    const basePath = path.join(fixtureDir, 'sync-commit-base.db');
    const targetPath = path.join(fixtureDir, 'sync-commit-target.db');
    fs.writeFileSync(basePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    let temporaryClosed = false;
    const open = async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await fs.promises.open(...args);
      if (args[1] !== 'wx') return handle;
      const realClose = handle.close.bind(handle);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'close') {
            return async () => {
              await realClose();
              temporaryClosed = true;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };
    const rejectAfterClose = <T extends (...args: any[]) => Promise<any>>(method: T): T => (
      (async (...args: Parameters<T>) => {
        if (temporaryClosed) {
          throw new Error('promise-based filesystem operation after temp close');
        }
        return method(...args);
      }) as T
    );
    const capability = capabilityWithOpen(open as typeof fs.promises.open, {
      stat: rejectAfterClose(fs.promises.stat),
      lstat: rejectAfterClose(fs.promises.lstat),
      realpath: rejectAfterClose(fs.promises.realpath),
      rename: rejectAfterClose(fs.promises.rename)
    });

    const result = await writePagedWritableOverlayToFile(
      capability,
      basePath,
      targetPath,
      snapshotFor(basePath)
    );

    assert.strictEqual(temporaryClosed, true);
    assert.deepStrictEqual(result, { requiresReopen: false });
    assert.deepStrictEqual(
      fs.readFileSync(targetPath),
      Buffer.from([9, 8, 7, 6, 5, 6, 7, 8])
    );
  });
});
