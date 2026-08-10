import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
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

const wasmBinary = new Uint8Array(
  fs.readFileSync(path.resolve(process.cwd(), 'assets/sqlite3.wasm'))
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

describe('paged writable host save', () => {
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
      assert.strictEqual(fs.statSync(targetPath).mode & 0o777, 0o640);
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

  it('follows a target symlink to the active base and leaves the symlink in place', async () => {
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

  it('preserves an existing distinct target mode for Save As', async () => {
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

  it('preserves the active base mode observed when the save starts', async () => {
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

  it('aborts if the active base mode changes during assembly', async () => {
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
          fs.chmodSync(candidatePath, 0o644);
          const after = fs.lstatSync(candidatePath, { bigint: true });
          assert.strictEqual(after.ino, before.ino);
          assert.strictEqual(after.size, before.size);
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

  it('refuses an existing Save As target chmod after initial resolution', async () => {
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
