import './vscode_mock_setup';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';

const changed = /database file changed on disk|database save target changed/i;
let directory: string;
const engines = new Set<WasmDatabaseEngine>();
const warnings: unknown[][] = [];

function fixture(name = 'source.db', value = 'original') {
  const file = path.join(directory, name);
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO items VALUES(1, ?)').run(value);
  } finally { db.close(); }
  return file;
}

function diskValue(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT value FROM items WHERE id=1').get()!.value as string; }
  finally { db.close(); }
}

function externalUpdate(file: string, value: string) {
  const db = new DatabaseSync(file);
  try { db.prepare('UPDATE items SET value=? WHERE id=1').run(value); }
  finally { db.close(); }
  // Ensure the generation change is deterministic on filesystems whose write
  // timestamps are coarser than two immediately adjacent SQLite transactions.
  const time = new Date(Date.now() + 3000);
  fs.utimesSync(file, time, time);
}

function changeOnlyMetadata(file: string) {
  const before = fs.statSync(file, { bigint: true });
  const mode = Number(before.mode & 0o777n);
  fs.chmodSync(file, mode ^ 0o200);
  fs.chmodSync(file, mode);
  const after = fs.statSync(file, { bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'mode', 'uid', 'gid'] as const) {
    assert.equal(after[key], before[key], `${key} must not change in the metadata-only fixture`);
  }
  assert.notEqual(after.ctimeNs, before.ctimeNs);
}

async function open(file: string) {
  const result = await createDatabaseEngine({ content: null, filePath: file, maxSize: 0, readOnlyMode: false },
    (level, ...args) => { if (level === 'warn') warnings.push(args); });
  assert.equal(result.storage, 'memory');
  const engine = result.operations as WasmDatabaseEngine;
  engines.add(engine);
  return engine;
}

async function edit(engine: WasmDatabaseEngine, value = 'unsaved overlay') {
  await engine.updateCell('items', 1, 'value', value);
}

async function memoryValue(engine: WasmDatabaseEngine) {
  return (await engine.executeQuery('SELECT value FROM items WHERE id=1'))[0].rows[0][0];
}

function assertNoTemporaryFiles() {
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('.sqlite-explorer-')), []);
}

describe('small local WASM file generations', () => {
  beforeEach(() => {
    const root = path.resolve('.tmp/unit-wasm-memory-generation');
    fs.mkdirSync(root, { recursive: true }); directory = fs.mkdtempSync(path.join(root, 'run-'));
    warnings.length = 0;
  });
  afterEach(() => {
    mock.restoreAll();
    for (const engine of engines) engine.shutdown();
    engines.clear();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('refuses a replaced source, retains the overlay, and allows recovery to a distinct Save As file', async () => {
    const source = fixture();
    const engine = await open(source); await edit(engine);
    fs.renameSync(fixture('incoming.db', 'external replacement'), source);
    const externalBytes = fs.readFileSync(source);
    await assert.rejects(() => engine.writeToFile(source), changed);
    assert.deepEqual(fs.readFileSync(source), externalBytes);
    assert.equal(await memoryValue(engine), 'unsaved overlay');
    const recovery = path.join(directory, 'recovered.db');
    assert.deepEqual(await engine.writeToFile(recovery), { requiresReopen: false });
    assert.equal(diskValue(recovery), 'unsaved overlay');
    assert.deepEqual(fs.readFileSync(source), externalBytes);
    await assert.rejects(() => engine.writeToFile(source), changed);
    assertNoTemporaryFiles();
  });

  it('refuses an in-place external SQLite edit even when the file identity and size are unchanged', async () => {
    const source = fixture(); const before = fs.statSync(source);
    const engine = await open(source); await edit(engine);
    externalUpdate(source, 'external in-place edit');
    assert.equal(fs.statSync(source).ino, before.ino);
    assert.equal(fs.statSync(source).size, before.size);
    const externalBytes = fs.readFileSync(source);
    await assert.rejects(() => engine.writeToFile(source), changed);
    assert.deepEqual(fs.readFileSync(source), externalBytes);
    assert.equal(await memoryValue(engine), 'unsaved overlay');
  });

  it('rejects a stale WASM view draft before changing its in-memory definition', async () => {
    const source = fixture();
    const external = new DatabaseSync(source);
    external.exec('CREATE VIEW item_view AS SELECT value FROM items');
    external.close();
    const engine = await open(source);
    const original = await engine.getViewDefinition('item_view');
    await edit(engine, 'retained unrelated edit');
    const writer = new DatabaseSync(source);
    writer.exec('DROP VIEW item_view; CREATE VIEW item_view AS SELECT id, value FROM items');
    writer.close();
    const bytes = fs.readFileSync(source);
    await assert.rejects(() => engine.editView('item_view', 'SELECT id FROM items', true, original.sql, []),
      /database file changed on disk.*view draft was not saved/i);
    assert.deepEqual(fs.readFileSync(source), bytes);
    assert.equal((await engine.executeQuery("SELECT sql FROM sqlite_schema WHERE name='item_view'"))[0].rows[0][0], original.sql);
    assert.equal(await memoryValue(engine), 'retained unrelated edit');
  });

  it('does not recreate a deleted source and can recover without that path existing', async () => {
    const source = fixture(); const engine = await open(source); await edit(engine);
    fs.unlinkSync(source);
    await assert.rejects(() => engine.writeToFile(source), changed);
    assert.equal(fs.existsSync(source), false);
    const recovery = path.join(directory, 'recovered.db');
    await engine.writeToFile(recovery);
    assert.equal(diskValue(recovery), 'unsaved overlay');
  });

  it('advances the expected source generation after each successful Save without reopening its engine', async () => {
    const source = fixture(); const engine = await open(source);
    for (const value of ['first save', 'second save', 'third save']) {
      const inode = fs.statSync(source).ino;
      await edit(engine, value);
      assert.deepEqual(await engine.writeToFile(source), { requiresReopen: false });
      assert.equal(diskValue(source), value);
      assert.equal(await memoryValue(engine), value);
      assert.notEqual(fs.statSync(source).ino, inode);
    }
    assertNoTemporaryFiles();
  });

  it('saves unchanged file bytes after metadata-only changes, including after its own prior saves', async () => {
    const source = fixture(); const engine = await open(source);
    for (const value of ['first metadata save', 'second metadata save', 'third metadata save']) {
      const before = fs.readFileSync(source);
      await edit(engine, value);
      changeOnlyMetadata(source);
      assert.deepEqual(fs.readFileSync(source), before);
      await engine.writeToFile(source);
      assert.equal(diskValue(source), value);
      assert.equal(await memoryValue(engine), value);
    }
    assertNoTemporaryFiles();
  });

  it('keeps a view draft usable when only the source metadata changed', async () => {
    const source = fixture();
    const database = new DatabaseSync(source);
    database.exec('CREATE VIEW item_view AS SELECT value FROM items');
    database.close();
    const engine = await open(source);
    const definition = await engine.getViewDefinition('item_view');
    changeOnlyMetadata(source);
    assert.deepEqual(await engine.getViewDefinition('item_view'), definition);
    await edit(engine, 'retained overlay');
    await engine.writeToFile(source);
    assert.equal(diskValue(source), 'retained overlay');
  });

  it('refuses changed bytes with the same file identity, size, and restored modification time', async () => {
    const source = fixture();
    // An exact whole-second timestamp avoids precision loss in utimes itself.
    fs.utimesSync(source, 1700000000, 1700000000);
    const engine = await open(source); await edit(engine);
    const before = fs.statSync(source, { bigint: true });
    externalUpdate(source, 'external');
    fs.utimesSync(source, 1700000000, 1700000000);
    const after = fs.statSync(source, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.notEqual(after.ctimeNs, before.ctimeNs);
    const externalBytes = fs.readFileSync(source);
    await assert.rejects(() => engine.writeToFile(source), changed);
    assert.deepEqual(fs.readFileSync(source), externalBytes);
    assert.equal(await memoryValue(engine), 'unsaved overlay');
    const recovery = path.join(directory, 'metadata-recovery.db');
    await engine.writeToFile(recovery);
    assert.equal(diskValue(recovery), 'unsaved overlay');
    assertNoTemporaryFiles();
  });

  it('checks the complete content after a metadata-only mismatch, not just the first hash chunk', async () => {
    const source = fixture('source.db', 'x'.repeat(2 * 1024 * 1024));
    fs.utimesSync(source, 1700000000, 1700000000);
    const engine = await open(source); await edit(engine);
    const before = fs.readFileSync(source);
    const descriptor = fs.openSync(source, 'r+');
    try {
      fs.writeSync(descriptor, Buffer.from([before[before.length - 1] ^ 1]), 0, 1, before.length - 1);
    } finally { fs.closeSync(descriptor); }
    fs.utimesSync(source, 1700000000, 1700000000);
    const externalBytes = fs.readFileSync(source);
    assert.deepEqual(externalBytes.subarray(0, 1024 * 1024), before.subarray(0, 1024 * 1024));
    assert.notDeepEqual(externalBytes, before);
    await assert.rejects(() => engine.writeToFile(source), changed);
    assert.deepEqual(fs.readFileSync(source), externalBytes);
    assert.equal(await memoryValue(engine), 'unsaved overlay');
    assertNoTemporaryFiles();
  });

  it('retains the source and overlay when metadata verification cannot read the file, then allows retry', async () => {
    const source = fixture(); const engine = await open(source); await edit(engine);
    changeOnlyMetadata(source);
    const before = fs.readFileSync(source);
    const inode = fs.statSync(source, { bigint: true }).ino;
    const read = fs.readSync;
    const intercept = mock.method(fs, 'readSync', (...args: Parameters<typeof read>) => {
      if (fs.fstatSync(args[0], { bigint: true }).ino === inode) throw new Error('controlled verification read failure');
      return read(...args);
    });
    await assert.rejects(() => engine.writeToFile(source), changed);
    intercept.mock.restore();
    assert.deepEqual(fs.readFileSync(source), before);
    assert.equal(await memoryValue(engine), 'unsaved overlay');
    await engine.writeToFile(source);
    assert.equal(diskValue(source), 'unsaved overlay');
    assertNoTemporaryFiles();
  });

  it('does not accept the old descriptor when the pathname is replaced during metadata verification', async () => {
    const source = fixture(); const incoming = fixture('incoming.db', 'replacement during verification');
    const engine = await open(source); await edit(engine);
    changeOnlyMetadata(source);
    const inode = fs.statSync(source, { bigint: true }).ino;
    let replaced = false;
    const read = fs.readSync;
    const intercept = mock.method(fs, 'readSync', (...args: Parameters<typeof read>) => {
      const count = read(...args);
      if (!replaced && fs.fstatSync(args[0], { bigint: true }).ino === inode) {
        fs.renameSync(incoming, source);
        replaced = true;
      }
      return count;
    });
    await assert.rejects(() => engine.writeToFile(source), changed);
    intercept.mock.restore();
    assert.equal(replaced, true);
    assert.equal(diskValue(source), 'replacement during verification');
    assert.equal(await memoryValue(engine), 'unsaved overlay');
    await assert.rejects(() => engine.writeToFile(source), changed);
    assertNoTemporaryFiles();
  });

  it('preserves connection PRAGMAs and foreign-key enforcement across exports and repeated saves', async () => {
    const source = fixture(); const engine = await open(source);
    await engine.executeQuery('CREATE TABLE child(parent INTEGER REFERENCES items(id));');
    await engine.executeQuery(`
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -321;
      PRAGMA locking_mode = EXCLUSIVE;
      PRAGMA temp_store = MEMORY;
    `);
    const before = await engine.getPragmas();
    await engine.serializeDatabase();
    assert.deepEqual(await engine.getPragmas(), before);
    for (const value of ['first pragma save', 'second pragma save']) {
      await edit(engine, value);
      await engine.writeToFile(source);
      assert.deepEqual(await engine.getPragmas(), before);
      await assert.rejects(() => engine.executeQuery('INSERT INTO child VALUES(999)'), /FOREIGN KEY constraint failed/);
      assert.equal(diskValue(source), value);
    }
  });

  it('restores connection PRAGMAs when writing the exported snapshot fails', async () => {
    const source = fixture(); const engine = await open(source);
    await engine.setPragma('foreign_keys', 1);
    await edit(engine);
    const write = fs.promises.writeFile;
    mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof write>) => {
      if (String(args[0]).includes('.sqlite-explorer-')) throw new Error('controlled write failure');
      return write(...args);
    });
    await assert.rejects(() => engine.writeToFile(source), /controlled write failure/);
    assert.equal((await engine.getPragmas()).foreign_keys, 1);
    assert.equal(await memoryValue(engine), 'unsaved overlay');
  });

  it('blocks further SQL after a failed PRAGMA restoration and retries without losing the overlay', async () => {
    const source = fixture(); const engine = await open(source);
    await engine.executeQuery('CREATE TABLE child(parent INTEGER REFERENCES items(id)); PRAGMA foreign_keys=ON');
    await edit(engine);
    const instance = (engine as unknown as { instance: { exec(sql: string): unknown[] } }).instance;
    const exec = instance.exec.bind(instance);
    const failure = mock.method(instance, 'exec', (sql: string) => {
      if (/^PRAGMA foreign_keys = 1$/.test(sql)) throw new Error('controlled PRAGMA restore failure');
      return exec(sql);
    });
    await assert.rejects(engine.serializeDatabase(), /controlled PRAGMA restore failure/);
    await assert.rejects(engine.executeQuery('INSERT INTO child VALUES(999)'), /controlled PRAGMA restore failure/);
    failure.mock.restore();
    assert.equal((await engine.getPragmas()).foreign_keys, 1);
    assert.deepEqual((await engine.executeQuery('SELECT * FROM child'))[0].rows, []);
    assert.equal(await memoryValue(engine), 'unsaved overlay');
    await assert.rejects(engine.executeQuery('INSERT INTO child VALUES(999)'), /FOREIGN KEY constraint failed/);
    await engine.writeToFile(source);
    assert.equal(diskValue(source), 'unsaved overlay');
  });

  it('saves repeatedly when JavaScript and native realpath spell the same existing file differently', async () => {
    const source = fixture();
    const resolve = fs.realpathSync;
    // On Windows the JS resolver can retain a lowercase drive letter while
    // promises.realpath uses the native uppercase spelling. A dot segment
    // models the same spelling-only difference on every test platform.
    const differentSpelling = mock.method(fs, 'realpathSync', (file: fs.PathLike) => {
      const canonical = resolve(file);
      return `${path.dirname(canonical)}${path.sep}.${path.sep}${path.basename(canonical)}`;
    });
    Object.defineProperty(differentSpelling, 'native', { value: resolve.native });
    const engine = await open(source);
    for (const value of ['first canonical save', 'second canonical save']) {
      await edit(engine, value);
      await engine.writeToFile(source);
      assert.equal(diskValue(source), value);
    }
    externalUpdate(source, 'external change');
    await edit(engine, 'retained overlay');
    await assert.rejects(() => engine.writeToFile(source), changed);
    assert.equal(diskValue(source), 'external change');
    assert.equal(await memoryValue(engine), 'retained overlay');
  });

  it('keeps the expected source generation and overlay after a failed temporary write, allowing retry', async () => {
    const source = fixture(); const engine = await open(source); await edit(engine);
    const before = fs.readFileSync(source);
    const write = fs.promises.writeFile;
    const failure = new Error('controlled temporary write failure');
    const intercept = mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof write>) => {
      if (String(args[0]).includes('.sqlite-explorer-')) throw failure;
      return write(...args);
    });
    await assert.rejects(() => engine.writeToFile(source), failure);
    intercept.mock.restore();
    assert.deepEqual(fs.readFileSync(source), before);
    assert.equal(await memoryValue(engine), 'unsaved overlay');
    await engine.writeToFile(source);
    assert.equal(diskValue(source), 'unsaved overlay');
    assertNoTemporaryFiles();
  });

  it('does not advance the source generation for early or mid-save cancellation and can retry', async () => {
    const source = fixture(); const engine = await open(source); await edit(engine);
    const before = fs.readFileSync(source);
    const early = new AbortController(); early.abort(new Error('early cancellation'));
    await assert.rejects(() => engine.writeToFile(source, early.signal), /early cancellation/);
    const middle = new AbortController();
    const write = fs.promises.writeFile;
    const intercept = mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof write>) => {
      await write(...args);
      if (String(args[0]).includes('.sqlite-explorer-')) middle.abort(new Error('mid-save cancellation'));
    });
    await assert.rejects(() => engine.writeToFile(source, middle.signal), /mid-save cancellation/);
    intercept.mock.restore();
    assert.deepEqual(fs.readFileSync(source), before);
    await engine.writeToFile(source);
    assert.equal(diskValue(source), 'unsaved overlay');
    assertNoTemporaryFiles();
  });

  it('preserves an external replacement that arrives while the temporary snapshot is being written', async () => {
    const source = fixture(); const incoming = fixture('incoming.db', 'late external replacement');
    const engine = await open(source); await edit(engine);
    const write = fs.promises.writeFile;
    mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof write>) => {
      await write(...args);
      if (String(args[0]).includes('.sqlite-explorer-')) fs.renameSync(incoming, source);
    });
    await assert.rejects(() => engine.writeToFile(source), changed);
    assert.equal(diskValue(source), 'late external replacement');
    assert.equal(await memoryValue(engine), 'unsaved overlay');
    assertNoTemporaryFiles();
  });

  it('checks source symlink retargeting at the final commit gate and preserves both databases', async t => {
    if (process.platform === 'win32') { t.skip('File symlinks require separate OS privilege on Windows.'); return; }
    const original = fixture(); const external = fixture('external.db', 'other database');
    const link = path.join(directory, 'source-link.db'); fs.symlinkSync(original, link);
    const engine = await open(link); await edit(engine);
    const before = fs.readFileSync(original);
    const write = fs.promises.writeFile;
    mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof write>) => {
      await write(...args);
      if (String(args[0]).includes('.sqlite-explorer-')) {
        fs.unlinkSync(link); fs.symlinkSync(external, link);
      }
    });
    await assert.rejects(() => engine.writeToFile(link), changed);
    assert.deepEqual(fs.readFileSync(original), before);
    assert.equal(diskValue(external), 'other database');
    assertNoTemporaryFiles();
  });

  it('preserves a stable source symlink across repeated saves', async t => {
    if (process.platform === 'win32') { t.skip('File symlinks require separate OS privilege on Windows.'); return; }
    const source = fixture(); const link = path.join(directory, 'source-link.db'); fs.symlinkSync(source, link);
    const engine = await open(link);
    for (const value of ['first alias save', 'second alias save']) {
      await edit(engine, value); await engine.writeToFile(link);
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      assert.equal(diskValue(source), value);
    }
  });

  it('rejects an image whose source changes while its bytes are being read', async () => {
    const source = fixture(); let changedDuringRead = false;
    const changeAfterRead = () => {
      if (!changedDuringRead) { externalUpdate(source, 'changed during read'); changedDuringRead = true; }
    };
    const read = fs.promises.readFile;
    mock.method(fs.promises, 'readFile', async (...args: Parameters<typeof read>) => {
      const bytes = await read(...args);
      if (String(args[0]) === source) changeAfterRead();
      return bytes;
    });
    const openFile = fs.promises.open;
    mock.method(fs.promises, 'open', async (...args: Parameters<typeof openFile>) => {
      const handle = await openFile(...args);
      if (String(args[0]) === source) {
        const readHandle = handle.readFile.bind(handle);
        mock.method(handle, 'readFile', async (...readArgs: Parameters<typeof readHandle>) => {
          const bytes = await readHandle(...readArgs); changeAfterRead(); return bytes;
        });
      }
      return handle;
    });
    await assert.rejects(() => open(source), /Failed to open.*database file changed on disk/i);
    assert.equal(changedDuringRead, true);
    assert.equal(diskValue(source), 'changed during read');
  });

  it('does not adopt an unrelated generation substituted immediately after its own successful rename', async () => {
    const source = fixture(); const incoming = fixture('incoming.db', 'post-commit replacement');
    const engine = await open(source); await edit(engine);
    const rename = fs.renameSync;
    const intercept = mock.method(fs, 'renameSync', (...args: Parameters<typeof rename>) => {
      rename(...args);
      if (String(args[0]).includes('.sqlite-explorer-') && String(args[1]) === source) rename(incoming, source);
    });
    await engine.writeToFile(source);
    intercept.mock.restore();
    assert.equal(diskValue(source), 'post-commit replacement');
    await assert.rejects(() => engine.writeToFile(source), changed);
    assert.ok(warnings.some(args => args.some(value => /generation.*verif/i.test(String(value)))));
    assert.equal(diskValue(source), 'post-commit replacement');
    const recovery = path.join(directory, 'recovered.db');
    await engine.writeToFile(recovery); assert.equal(diskValue(recovery), 'unsaved overlay');
  });
});
