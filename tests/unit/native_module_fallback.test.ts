import './vscode_mock_setup'; // Must be first

import assert from 'node:assert';
import * as fs from 'node:fs';
import Module from 'node:module';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { mockVscode } from './mocks/vscode';
import {
  createNativeDatabaseConnection,
  NativeWorkerProcess
} from '../../src/nativeWorker';
import {
  MAX_MODULE_CHECK_TABLES,
  WASM_ONLY_VIRTUAL_TABLE_MODULES
} from '../../src/core/virtual-table-modules';
import type { DatabaseConnectionBundle, EstablishedDatabaseConnection } from '../../src/connectionTypes';

/**
 * Engine choice for files whose schema uses a virtual-table module only the
 * WebAssembly build has, through the real connection factory: the bundled
 * txiki binary on one side and the real sql.js worker on the other. The worker
 * runs src/databaseWorker.ts in a real worker thread; the build normally
 * bundles it beside the factory as worker.cjs.
 */

const repoRoot = path.resolve(__dirname, '../..');
const workerScript = path.join(repoRoot, 'natives', 'native-worker.js');
const vendorWasm = path.join(repoRoot, 'vendor', 'sql.js', 'sql-wasm.wasm');
// scripts/build.mjs copies vendor/sql.js/sql-wasm.wasm to this path.
const wasmAssetPath = path.join(repoRoot, 'assets', 'sqlite3.wasm');

function bundledNativeBinary(): string | undefined {
  const platformDir = process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos')
    : process.platform === 'linux'
      ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu')
      : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-windows' : undefined;
  if (!platformDir) return undefined;
  const binary = path.join(repoRoot, 'natives', platformDir, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
  return fs.existsSync(binary) ? binary : undefined;
}

const binary = bundledNativeBinary();
const skipReason = binary && fs.existsSync(workerScript)
  ? undefined
  : `no bundled txiki worker for ${process.platform}-${process.arch}`;

const outputLines: string[] = [];
const outputChannel = { appendLine: (line: string) => { outputLines.push(line); } };

const originalRequire = Module.prototype.require;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module.prototype as any).require = function (this: unknown, id: string) {
  if (id === './main') return { GlobalOutputChannel: outputChannel };
  if (id === './platform/threadPool') {
    const threadPool = originalRequire.call(this, id) as typeof import('../../src/platform/threadPool');
    const RealWorker = threadPool.Worker as unknown as new (file: string) => object;
    return {
      ...threadPool,
      Worker: class extends RealWorker {
        constructor() { super(path.join(repoRoot, 'src', 'databaseWorker.ts')); }
      }
    };
  }
  return originalRequire.call(this, id);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createDatabaseConnection } = require('../../src/workerFactory') as typeof import('../../src/workerFactory');
Module.prototype.require = originalRequire;

type SqlJsDatabase = {
  run(sql: string): void;
  exec(sql: string): { values: unknown[][] }[];
  export(): Uint8Array;
  close(): void;
};
type SqlJsStatic = { Database: new () => SqlJsDatabase };

let SQL: SqlJsStatic;
let testDir: string;
let fixtureCount = 0;
const originalFs = mockVscode.workspace.fs;
const config = (mockVscode.workspace as unknown as { _config: Map<string, unknown> })._config;

function fileUri(fsPath: string) {
  return {
    scheme: 'file',
    authority: '',
    path: fsPath,
    query: '',
    fragment: '',
    fsPath,
    with({ path: nextPath }: { path: string }) { return fileUri(nextPath); },
    toString: () => `file://${fsPath}`
  } as unknown as import('vscode').Uri;
}

const extensionUri = fileUri(repoRoot);

/** Build a file with the WebAssembly engine, which has FTS3/FTS4. */
function wasmFixture(name: string, sql: string): string {
  const db = new SQL.Database();
  try {
    db.run(sql);
    const file = path.join(testDir, `${++fixtureCount}-${name}.sqlite`);
    fs.writeFileSync(file, db.export());
    return file;
  } finally {
    db.close();
  }
}

/** Build or extend a file with the native engine, which has R*Tree. */
async function nativeExec(file: string, sql: string): Promise<void> {
  const worker = new NativeWorkerProcess(binary!, workerScript);
  await worker.start();
  try {
    await worker.call('open', [file, false]);
    await worker.call('exec', [sql]);
    await worker.call('close');
  } finally {
    worker.stop();
  }
}

interface Opened {
  bundle: DatabaseConnectionBundle;
  connection: EstablishedDatabaseConnection;
  engine: 'native' | 'wasm';
  lines: string[];
}

const opened: DatabaseConnectionBundle[] = [];

async function openThroughFactory(
  file: string,
  options: { readOnly?: boolean; backupEngine?: 'native' | 'wasm' } = {}
): Promise<Opened> {
  const firstLine = outputLines.length;
  const bundle = await createDatabaseConnection(extensionUri);
  opened.push(bundle);
  const connection = await bundle.establishConnection(
    fileUri(file), path.basename(file), options.readOnly ?? false, false, options.backupEngine
  );
  return {
    bundle,
    connection,
    engine: await connection.databaseOps.engineKind,
    lines: outputLines.slice(firstLine)
  };
}

/** The factory's lines about this file. */
function moduleLines(lines: readonly string[], file: string): string[] {
  return lines.filter(line => line.startsWith(`[SQLite Explorer] ${path.basename(file)}: `));
}

async function rows(connection: EstablishedDatabaseConnection, sql: string): Promise<unknown[][]> {
  return (await connection.databaseOps.executeQuery(sql))[0]?.rows ?? [];
}

const DOCS_WITH_FTS4 = `
  CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT);
  CREATE VIRTUAL TABLE docs_fts USING fts4(content="docs", body);
  CREATE TRIGGER docs_bu BEFORE UPDATE ON docs BEGIN
    DELETE FROM docs_fts WHERE docid = old.rowid;
  END;
  CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
    INSERT INTO docs_fts(docid, body) VALUES (new.rowid, new.body);
  END;
  INSERT INTO docs(id, body) VALUES (1, 'hello world');
  INSERT INTO docs_fts(docid, body) SELECT id, body FROM docs;
`;

describe('engine choice for virtual-table modules the native build lacks', { skip: skipReason }, () => {
  before(async () => {
    const initSqlJs = (await import('../../vendor/sql.js/sql-wasm.js')).default as unknown as
      (config: object) => Promise<SqlJsStatic>;
    SQL = await initSqlJs({});
    fs.mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
    testDir = fs.mkdtempSync(path.join(repoRoot, '.tmp', 'module-fallback-'));
    Object.defineProperty(mockVscode.workspace, 'fs', {
      value: {
        ...originalFs,
        stat: async (uri: { fsPath: string }) => {
          const stats = await fs.promises.stat(uri.fsPath);
          return { type: stats.isFile() ? 1 : 2, ctime: stats.ctimeMs, mtime: stats.mtimeMs, size: stats.size };
        },
        // The mock's joinPath joins with '/', so compare resolved paths.
        readFile: async (uri: { fsPath: string }) => new Uint8Array(
          await fs.promises.readFile(path.resolve(uri.fsPath) === wasmAssetPath ? vendorWasm : uri.fsPath)
        )
      },
      writable: true,
      configurable: true
    });
  });

  after(() => {
    for (const bundle of opened) {
      try { bundle.workerMethods[Symbol.dispose](); } catch { /* already disposed */ }
    }
    Object.defineProperty(mockVscode.workspace, 'fs', { value: originalFs, writable: true, configurable: true });
    config.delete('maxFileSize');
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('lists only modules that the bundled WebAssembly build has and the native build lacks', async () => {
    const wasm = new SQL.Database();
    const wasmModules = new Set(wasm.exec('SELECT name FROM pragma_module_list')[0].values.map(([name]) => name));
    wasm.close();
    const file = wasmFixture('modules', 'CREATE TABLE t(a);');
    const worker = new NativeWorkerProcess(binary!, workerScript);
    await worker.start();
    let nativeModules: Set<unknown>;
    try {
      await worker.call('open', [file, true]);
      const result = await worker.call<{ values: unknown[][] }>('query', ['SELECT name FROM pragma_module_list']);
      nativeModules = new Set(result.values.map(([name]) => name));
    } finally {
      worker.stop();
    }
    for (const module of WASM_ONLY_VIRTUAL_TABLE_MODULES) {
      assert.ok(wasmModules.has(module), `the WebAssembly build must register ${module}`);
      assert.ok(!nativeModules.has(module), `the native build must not register ${module}`);
    }
    // A file moved to WebAssembly must keep every table native could open.
    for (const module of nativeModules) {
      assert.ok(wasmModules.has(module), `the WebAssembly build must register ${module}, which the native build has`);
    }
    assert.ok(nativeModules.has('rtree') && nativeModules.has('fts5'));
  });

  it('opens an FTS4 file on WebAssembly, where its FTS4 tables read and edit', async () => {
    const file = wasmFixture('fts4', `${DOCS_WITH_FTS4}
      CREATE VIRTUAL TABLE notes USING fts4(body);
      INSERT INTO notes(docid, body) VALUES (1, 'hello world');
      CREATE TABLE audit(id);
      CREATE TABLE items(id INTEGER PRIMARY KEY, v TEXT);
      CREATE TRIGGER items_au AFTER UPDATE ON items BEGIN INSERT INTO audit VALUES (new.id); END;
      INSERT INTO items VALUES (1, 'a');
    `);

    // Control: the native engine cannot read or edit this file's FTS4 tables,
    // nor edit the table whose trigger feeds one. It refuses an edit under an
    // UPDATE trigger that touches no FTS table for the trigger's own reason.
    const native = await createNativeDatabaseConnection(extensionUri, undefined, null);
    try {
      const nativeConnection = await native.establishConnection(fileUri(file), 'control.sqlite');
      await assert.rejects(rows(nativeConnection, "SELECT docid FROM notes WHERE notes MATCH 'hello'"), /no such module: fts4/);
      await assert.rejects(nativeConnection.databaseOps.updateCell('notes', 1, 'body', 'native edit'), /no such module: fts4/);
      await assert.rejects(nativeConnection.databaseOps.updateCell('docs', 1, 'body', 'native edit'), /no such module: fts4/);
      await assert.rejects(
        nativeConnection.databaseOps.updateCell('items', 1, 'v', 'b'),
        /Cannot update items while an applicable UPDATE trigger can run/
      );
    } finally {
      native.workerMethods[Symbol.dispose]();
    }

    const { engine, connection, lines } = await openThroughFactory(file);
    assert.strictEqual(engine, 'wasm');
    assert.deepStrictEqual(await rows(connection, "SELECT body FROM docs_fts WHERE docs_fts MATCH 'hello'"), [['hello world']]);
    await connection.databaseOps.updateCell('notes', 1, 'body', 'goodbye world');
    assert.deepStrictEqual(await rows(connection, "SELECT docid FROM notes WHERE notes MATCH 'goodbye'"), [[1]]);
    assert.deepStrictEqual(await rows(connection, "SELECT docid FROM notes WHERE notes MATCH 'hello'"), []);
    // Both engines refuse grid edits under a user UPDATE trigger, whose side
    // effects undo history cannot record; this one now gets that refusal
    // instead of the missing module.
    await assert.rejects(
      connection.databaseOps.updateCell('docs', 1, 'body', 'goodbye world'),
      /Cannot update docs while an applicable UPDATE trigger can run/
    );
    const logged = moduleLines(lines, file);
    assert.strictEqual(logged.length, 1, lines.join('\n'));
    assert.match(logged[0], /tables "docs_fts", "notes" use fts4, which the native SQLite engine does not include; opening it with the WebAssembly engine\.$/);
  });

  it('saves an edit made after the move, and reopens the saved file on WebAssembly', async () => {
    const file = wasmFixture('fts4-save', "CREATE VIRTUAL TABLE notes USING fts4(body); INSERT INTO notes(docid, body) VALUES (1, 'hello world');");
    const first = await openThroughFactory(file);
    assert.strictEqual(first.engine, 'wasm');
    await first.connection.databaseOps.updateCell('notes', 1, 'body', 'saved words');
    await first.connection.databaseOps.writeToFile(file);
    first.bundle.workerMethods[Symbol.dispose]();
    const reopened = await openThroughFactory(file);
    assert.strictEqual(reopened.engine, 'wasm');
    assert.deepStrictEqual(await rows(reopened.connection, "SELECT docid FROM notes WHERE notes MATCH 'saved'"), [[1]]);
  });

  it('moves a WAL-mode FTS4 file with no frames, saves an edit, and native reads the saved rows', async () => {
    const file = wasmFixture('fts4-wal-clean', `
      CREATE VIRTUAL TABLE notes USING fts4(body);
      INSERT INTO notes(docid, body) VALUES (1, 'hello world');
      CREATE TABLE plain(a);
    `);
    await nativeExec(file, 'PRAGMA journal_mode = WAL; INSERT INTO plain VALUES (1);');
    assert.strictEqual(fs.existsSync(`${file}-wal`), false, 'a clean close checkpoints and removes the -wal');
    assert.deepStrictEqual([...fs.readFileSync(file).subarray(18, 20)], [2, 2], 'the file must be in WAL mode');

    const first = await openThroughFactory(file);
    assert.strictEqual(first.engine, 'wasm');
    assert.strictEqual(first.connection.isReadOnly, false);
    // The native engine closed the database before it was stopped. A worker
    // that is only killed leaves these files, and its lock on a WAL database
    // lasts until the process is gone: a save made at once found it locked.
    assert.deepStrictEqual(
      fs.readdirSync(path.dirname(file)).filter(name => name.startsWith(`${path.basename(file)}-`)),
      [],
      'the native engine must leave no -wal or -shm file behind'
    );
    await first.connection.databaseOps.updateCell('plain', 1, 'a', 2);
    await first.connection.databaseOps.updateCell('notes', 1, 'body', 'saved words');
    await first.connection.databaseOps.writeToFile(file);
    first.bundle.workerMethods[Symbol.dispose]();
    // The native worker the move retired was stopped with the file open.
    const walBytes = fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0;    assert.ok(walBytes <= 32, `the retired native worker must leave no WAL frames (${walBytes} bytes)`);

    const native = await createNativeDatabaseConnection(extensionUri, undefined, null);
    try {
      const nativeConnection = await native.establishConnection(fileUri(file), 'reread.sqlite');
      assert.deepStrictEqual(await rows(nativeConnection, 'SELECT a FROM plain'), [[2]]);
      assert.deepStrictEqual(await rows(nativeConnection, 'SELECT c0body FROM notes_content WHERE docid = 1'), [['saved words']]);
    } finally {
      native.workerMethods[Symbol.dispose]();
    }
    const reopened = await openThroughFactory(file);
    assert.strictEqual(reopened.engine, 'wasm');
    assert.deepStrictEqual(await rows(reopened.connection, "SELECT docid FROM notes WHERE notes MATCH 'saved'"), [[1]]);
  });

  it('keeps an ordinary file on native at the cost of one query', async () => {
    const file = wasmFixture('plain', 'CREATE TABLE t(a); CREATE INDEX t_a ON t(a); CREATE VIEW v AS SELECT a FROM t;');
    const { engine, lines } = await openThroughFactory(file);
    assert.strictEqual(engine, 'native');
    assert.deepStrictEqual(moduleLines(lines, file), []);
  });

  it('keeps FTS5-only and R*Tree-only files on native', async () => {
    const fts5 = wasmFixture('fts5', "CREATE VIRTUAL TABLE notes USING fts5(body); INSERT INTO notes VALUES ('x');");
    const rtree = wasmFixture('rtree', 'CREATE TABLE t(a);');
    await nativeExec(rtree, 'CREATE VIRTUAL TABLE boxes USING rtree(id, minX, maxX); INSERT INTO boxes VALUES (1, 0, 1);');
    for (const file of [fts5, rtree]) {
      const { engine, lines } = await openThroughFactory(file);
      assert.strictEqual(engine, 'native', file);
      assert.deepStrictEqual(moduleLines(lines, file), []);
    }
  });

  it('keeps an FTS4 file over maxFileSize on native and names the module and table once', async () => {
    const file = wasmFixture('fts4-large', DOCS_WITH_FTS4);
    config.set('maxFileSize', 0.001);
    try {
      const { engine, connection, lines } = await openThroughFactory(file);
      assert.strictEqual(engine, 'native');
      await assert.rejects(rows(connection, 'SELECT * FROM docs_fts'), /no such module: fts4/);
      const logged = moduleLines(lines, file);
      assert.strictEqual(logged.length, 1, lines.join('\n'));
      assert.match(logged[0], /table "docs_fts" uses fts4, which the native SQLite engine does not include/);
      assert.match(logged[0], /larger than sqliteExplorer\.maxFileSize/);
      assert.match(logged[0], /stays on the native engine and those tables will not open/);
    } finally {
      config.delete('maxFileSize');
    }
  });

  it('opens an FTS4 file on WebAssembly when maxFileSize is 0 (unlimited)', async () => {
    const file = wasmFixture('fts4-unlimited', DOCS_WITH_FTS4);
    config.set('maxFileSize', 0);
    try {
      assert.strictEqual((await openThroughFactory(file)).engine, 'wasm');
    } finally {
      config.delete('maxFileSize');
    }
  });

  it(`prepares nothing past ${MAX_MODULE_CHECK_TABLES} candidate tables and stays on native`, async () => {
    const statements: string[] = [];
    for (let index = 0; index <= MAX_MODULE_CHECK_TABLES; index++) {
      statements.push(`CREATE VIRTUAL TABLE f${index} USING fts4(a);`);
    }
    const file = wasmFixture('past-cap', statements.join('\n'));
    const { engine, lines } = await openThroughFactory(file);
    assert.strictEqual(engine, 'native');
    const logged = moduleLines(lines, file);
    assert.strictEqual(logged.length, 1, lines.join('\n'));
    assert.match(logged[0], new RegExp(`more than ${MAX_MODULE_CHECK_TABLES} virtual tables might use`));
  });

  it('finds FTS3/FTS4 tables behind quoted, Unicode, commented and mixed-case spellings', async () => {
    const file = wasmFixture('odd-names', `
      CREATE TABLE fts4(a);
      CREATE VIRTUAL TABLE IF NOT EXISTS "we""ird fts4 name" USING FtS4(body);
      CREATE VIRTUAL TABLE c /* USING fts5 */ USING /* x */ fts3 (a);
      CREATE VIRTUAL TABLE "文档" USING fts4aux(c);
      CREATE VIRTUAL TABLE tok USING fts3tokenize(simple);
      CREATE VIRTUAL TABLE "USING fts4" USING fts5(a);
    `);
    const native = await createNativeDatabaseConnection(extensionUri, undefined, null);
    try {
      const connection = await native.establishConnection(fileUri(file), 'odd.sqlite');
      const result = await connection.findTablesWithMissingModules!(WASM_ONLY_VIRTUAL_TABLE_MODULES);
      assert.deepStrictEqual(result, {
        checked: true,
        tables: [
          { table: 'we"ird fts4 name', module: 'fts4' },
          { table: 'c', module: 'fts3' },
          { table: '文档', module: 'fts4aux' },
          { table: 'tok', module: 'fts3tokenize' }
        ]
      });
    } finally {
      native.workerMethods[Symbol.dispose]();
    }
    const { engine, connection } = await openThroughFactory(file);
    assert.strictEqual(engine, 'wasm');
    assert.deepStrictEqual(await rows(connection, 'SELECT count(*) FROM "we""ird fts4 name"'), [[0]]);
  });

  it('keeps a file on native when fts4 is only a name: an ordinary table, an FTS5 table, a TEMP table', async () => {
    const file = wasmFixture('names-only', `
      CREATE TABLE fts4(a);
      CREATE VIRTUAL TABLE "USING fts4" USING fts5(a);
      CREATE VIRTUAL TABLE temp.scratch USING fts4(a);
    `);
    const { engine, lines } = await openThroughFactory(file);
    assert.strictEqual(engine, 'native');
    assert.deepStrictEqual(moduleLines(lines, file), []);
  });

  it('keeps an FTS4 file with uncheckpointed WAL frames on native', async () => {
    const file = wasmFixture('fts4-wal', `${DOCS_WITH_FTS4} CREATE TABLE plain(a);`);
    const writer = new NativeWorkerProcess(binary!, workerScript);
    await writer.start();
    try {
      await writer.call('open', [file, false]);
      await writer.call('exec', ['PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; INSERT INTO plain VALUES (1);']);
      assert.ok(fs.statSync(`${file}-wal`).size > 32, 'the writer must leave WAL frames');
      const { engine, connection, lines } = await openThroughFactory(file);
      assert.strictEqual(engine, 'native');
      assert.deepStrictEqual(await rows(connection, 'SELECT a FROM plain'), [[1]]);
      const logged = moduleLines(lines, file);
      assert.strictEqual(logged.length, 1, lines.join('\n'));
      assert.match(logged[0], /-wal file holds changes the WebAssembly engine cannot read/);
    } finally {
      writer.stop();
    }
  });

  it('opens a file with FTS4 and R*Tree tables on WebAssembly, where both read', async () => {
    const file = wasmFixture('fts4-rtree', DOCS_WITH_FTS4);
    await nativeExec(file, 'CREATE VIRTUAL TABLE boxes USING rtree(id, minX, maxX); INSERT INTO boxes VALUES (1, 0, 1);');
    const { engine, connection, lines } = await openThroughFactory(file);
    assert.strictEqual(engine, 'wasm');
    const logged = moduleLines(lines, file);
    assert.strictEqual(logged.length, 1, lines.join('\n'));
    assert.match(logged[0], /table "docs_fts" uses fts4, which the native SQLite engine does not include; opening it with the WebAssembly engine\.$/);
    assert.deepStrictEqual(await rows(connection, 'SELECT id FROM boxes WHERE minX <= 0.5 AND maxX >= 0.5'), [[1]]);
  });

  it('keeps an FTS4 file on native when the WebAssembly engine cannot load its schema', async () => {
    // reverse() is a function only sql.js has, and there it is not
    // deterministic, so the WebAssembly build refuses a schema that indexes
    // it. The native build does not know the function and loads the schema.
    // Such a schema fails on the first statement that reads it, not when the
    // file is opened, and then every statement fails. Native lists the tables
    // and reads the ordinary ones.
    const file = wasmFixture('fts4-refused-index', `${DOCS_WITH_FTS4}
      CREATE TABLE measures(id INTEGER PRIMARY KEY, x REAL);
      INSERT INTO measures VALUES (1, 3), (2, 5);
    `);
    const writer = new DatabaseSync(file);
    try {
      writer.function('reverse', { deterministic: true }, (value: unknown) => [...String(value)].reverse().join(''));
      writer.exec('CREATE INDEX measures_rev ON measures(reverse(x));');
    } finally {
      writer.close();
    }

    const expectLine = (lines: readonly string[]) => {
      const logged = moduleLines(lines, file);
      assert.strictEqual(logged.length, 1, lines.join('\n'));
      assert.match(logged[0], /table "docs_fts" uses fts4, which the native SQLite engine does not include/);
      assert.match(logged[0], /The WebAssembly engine could not load its schema \(.*non-deterministic functions prohibited in index expressions.*\)/);
      assert.match(logged[0], /stays on the native engine and those tables will not open/);
    };
    const { bundle, engine, connection, lines } = await openThroughFactory(file);
    assert.strictEqual(engine, 'native');
    assert.deepStrictEqual(await rows(connection, 'SELECT x FROM measures ORDER BY id'), [[3], [5]]);
    const schema = await connection.databaseOps.fetchSchema();
    assert.ok(schema.tables.some(table => table.identifier === 'measures'));
    expectLine(lines);

    // The refused WebAssembly worker was released, so a later open through
    // the same bundle starts a new one and reports the schema again.
    const lineCount = outputLines.length;
    const reopened = await bundle.establishConnection(fileUri(file), path.basename(file), false, false);
    assert.strictEqual(await reopened.databaseOps.engineKind, 'native');
    assert.deepStrictEqual(await rows(reopened, 'SELECT x FROM measures ORDER BY id'), [[3], [5]]);
    expectLine(outputLines.slice(lineCount));
  });

  it('moves an FTS4 file with an index on a math function to WebAssembly, where the table reads without the index', async () => {
    const file = wasmFixture('fts4-math-index', `${DOCS_WITH_FTS4}
      CREATE TABLE measures(id INTEGER PRIMARY KEY, x REAL);
      INSERT INTO measures VALUES (1, 3), (2, 5);
    `);
    await nativeExec(file, 'CREATE INDEX measures_ln ON measures(ln(x));');
    const { engine, connection } = await openThroughFactory(file);
    assert.strictEqual(engine, 'wasm');
    assert.deepStrictEqual(await rows(connection, 'SELECT id FROM measures WHERE ln(x) = ln(5)'), [[2]]);
    assert.deepStrictEqual(await rows(connection, "SELECT body FROM docs_fts WHERE docs_fts MATCH 'hello'"), [['hello world']]);
    await assert.rejects(
      connection.databaseOps.executeQuery('INSERT INTO measures VALUES (3, 7)'),
      /index measures_ln depends on a math function/
    );
  });

  it('makes the same choice on every connection made for the document', async () => {
    const fts4 = wasmFixture('fts4-reopen', DOCS_WITH_FTS4);
    const plain = wasmFixture('plain-reopen', 'CREATE TABLE t(a);');

    // A reconnect (#reconnectFromDisk, #retryInitialConnection) makes a new bundle.
    assert.strictEqual((await openThroughFactory(fts4)).engine, 'wasm');
    assert.strictEqual((await openThroughFactory(fts4, { readOnly: true })).engine, 'wasm');

    // A failed hot-exit replay reopens read-only through the same bundle.
    const first = await openThroughFactory(fts4);
    assert.strictEqual(first.engine, 'wasm');
    const lineCount = outputLines.length;
    const reopened = await first.bundle.establishConnection(fileUri(fts4), 'reopen.sqlite', true, false);
    assert.strictEqual(await reopened.databaseOps.engineKind, 'wasm');
    assert.strictEqual(reopened.isReadOnly, true);
    assert.deepStrictEqual(outputLines.slice(lineCount).filter(line => /Native file open failed/.test(line)), []);

    // A hot-exit restore reopens the engine the backup was written on.
    assert.strictEqual((await openThroughFactory(fts4, { backupEngine: 'native' })).engine, 'native');
    assert.strictEqual((await openThroughFactory(plain, { backupEngine: 'wasm' })).engine, 'wasm');
    assert.strictEqual((await openThroughFactory(plain)).engine, 'native');
  });
});
