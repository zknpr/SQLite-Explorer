import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

declare function suite(title: string, body: () => void): void;
declare function test(title: string, body: () => void | Promise<void>): void;
declare function setup(body: () => void | Promise<void>): void;
declare function teardown(body: () => void | Promise<void>): void;
declare function suiteSetup(body: () => void | Promise<void>): void;
declare function suiteTeardown(body: () => void | Promise<void>): void;

type SqlValue = number | string | Uint8Array | null;

interface SqlJsDatabase {
  run(sql: string, params?: SqlValue[]): void;
  exec(sql: string): Array<{ columns: string[]; values: SqlValue[][] }>;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: Uint8Array | ArrayBuffer) => SqlJsDatabase;
}

const initSqlJs = require('sql.js') as (config?: {
  locateFile?: (filename: string) => string;
}) => Promise<SqlJsStatic>;

type Backend = 'native' | 'wasm';
type Storage = 'native' | 'memory' | 'paged';
type CellValue = string | number | bigint | null | Uint8Array;

interface QueryResult {
  headers: string[];
  rows: CellValue[][];
}

interface DesktopDocumentState {
  documentId: string;
  uri: string;
  documentKey: string;
  referenceCount: number;
  engineKind: Backend;
  storage: Storage;
  readOnly: boolean;
  dirty: boolean;
  workerDisposeRequested: boolean;
  resolvedEditorCount: number;
}

interface DesktopTestApi {
  readonly version: 1;
  setBackend(backend: Backend): void;
  inspectDocument(uri: string): Promise<DesktopDocumentState | null>;
  inspectLifecycle(documentId: string): DesktopDocumentState | null;
  openCustomDocument(
    viewType: string,
    uri: string,
    backupId?: string
  ): Promise<{ handle: string; state: DesktopDocumentState }>;
  disposeCustomDocument(handle: string): Promise<void>;
  query(target: string, sql: string, params?: CellValue[]): Promise<QueryResult[]>;
  updateCell(
    target: string,
    table: string,
    rowId: string | number,
    column: string,
    value: CellValue
  ): Promise<string | number | void>;
  save(target: string): Promise<void>;
  revert(target: string): Promise<void>;
  backup(target: string, destination: string): Promise<string>;
  exportTable(
    target: string,
    destination: string,
    table: string,
    columns: string[],
    options: { format: 'csv' | 'json' | 'sql'; header?: boolean; includeTableName?: boolean }
  ): Promise<number>;
}

interface ExtensionExports {
  desktopTest?: DesktopTestApi;
}

interface Fixture {
  filePath: string;
  uri: vscode.Uri;
  originalBytes: Buffer;
}

const EXTENSION_ID = 'zknpr.sqlite-explorer';
const EXPECTED_VIEW_TYPES = ['sqlite-explorer.view', 'sqlite-explorer.option'] as const;
const DEFAULT_MAX_FILE_SIZE_MIB = 200;
const PAGED_TEST_LIMIT_MIB = 0.01;

let api: DesktopTestApi;
let SQL: SqlJsStatic;
let fixtureRoot: string;
let viewTypes: string[];
const directHandles = new Set<string>();

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor<T>(
  description: string,
  probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMilliseconds = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${description}${suffix}`);
}

function customTabs(uri?: vscode.Uri): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
    if (!(tab.input instanceof vscode.TabInputCustom)) return false;
    return uri === undefined || tab.input.uri.toString() === uri.toString();
  });
}

function findCustomTab(uri: vscode.Uri, viewType: string): vscode.Tab | undefined {
  return customTabs(uri).find(tab => {
    const input = tab.input as vscode.TabInputCustom;
    return input.viewType === viewType;
  });
}

async function closeCustomTab(uri: vscode.Uri, viewType: string): Promise<void> {
  // TabGroups.close validates object identity against its current tab model.
  // Re-resolve immediately before closing: opening/resolving another editor can
  // replace the API snapshot while leaving the same visible tab alive.
  const tab = findCustomTab(uri, viewType);
  assert.ok(tab, `Custom editor tab disappeared before close: ${viewType}`);
  assert.equal(await vscode.window.tabGroups.close(tab), true, 'VS Code refused to close the custom-editor tab');
}

async function closeAllCustomTabs(): Promise<void> {
  const tabs = customTabs();
  if (tabs.length > 0) {
    assert.equal(await vscode.window.tabGroups.close(tabs), true, 'VS Code refused to close test tabs');
  }
  await waitFor('the document registry to empty', async () => {
    for (const tab of customTabs()) {
      const input = tab.input as vscode.TabInputCustom;
      if (await api.inspectDocument(input.uri.toString())) return false;
    }
    return true;
  });
}

async function setMaxFileSize(mebibytes: number): Promise<void> {
  await vscode.workspace.getConfiguration('sqliteExplorer').update(
    'maxFileSize',
    mebibytes,
    vscode.ConfigurationTarget.Workspace
  );
  assert.equal(
    vscode.workspace.getConfiguration('sqliteExplorer').get<number>('maxFileSize'),
    mebibytes
  );
}

function createFixture(name: string, options: { large?: boolean; exportCases?: boolean } = {}): Fixture {
  const database = new SQL.Database();
  database.run('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  database.run('INSERT INTO items VALUES (?, ?)', [1, 'original']);

  if (options.large) {
    database.run('CREATE TABLE padding (payload BLOB NOT NULL)');
    database.run('INSERT INTO padding VALUES (zeroblob(131072))');
  }

  if (options.exportCases) {
    database.run(
      'CREATE TABLE export_cases (id INTEGER, payload BLOB, nul_text TEXT)'
    );
    database.run(
      'INSERT INTO export_cases VALUES (?, ?, CAST(? AS TEXT))',
      [
        1,
        new Uint8Array([0, 1, 2, 253, 254, 255]),
        new TextEncoder().encode('before\0after')
      ]
    );
  }

  const filePath = path.join(fixtureRoot, `${name}.sqlite`);
  const originalBytes = Buffer.from(database.export());
  database.close();
  fs.writeFileSync(filePath, originalBytes, { flag: 'wx' });
  return { filePath, uri: vscode.Uri.file(filePath), originalBytes };
}

function queryFile(filePath: string, sql: string): SqlValue[][] {
  const database = new SQL.Database(new Uint8Array(fs.readFileSync(filePath)));
  try {
    return database.exec(sql)[0]?.values ?? [];
  } finally {
    database.close();
  }
}

async function openDirect(
  fixture: Fixture,
  backupId?: string
): Promise<{ handle: string; state: DesktopDocumentState }> {
  const opened = await api.openCustomDocument(viewTypes[0], fixture.uri.toString(), backupId);
  directHandles.add(opened.handle);
  return opened;
}

async function disposeDirect(handle: string): Promise<void> {
  await api.disposeCustomDocument(handle);
  directHandles.delete(handle);
}

function assertSingleValue(results: QueryResult[], expected: CellValue): void {
  assert.deepEqual(results[0]?.rows, [[expected]]);
}

function cellUri(state: DesktopDocumentState, column: string): vscode.Uri {
  const uriPath = [state.documentKey, 'items', '-', '1', `${column}.txt`]
    .map(part => encodeURIComponent(part))
    .join('/');
  return vscode.Uri.from({ scheme: 'sqlite-explorer', path: `/${uriPath}` });
}

function assertFileBytes(filePath: string, expected: string): void {
  assert.deepEqual(fs.readFileSync(filePath), Buffer.from(expected, 'utf8'));
}

suite('SQLite Explorer desktop extension-host matrix', () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension<ExtensionExports>(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} was not loaded as the extension under development`);
    const exports = await extension.activate();
    assert.equal(extension.isActive, true);
    assert.ok(exports.desktopTest, 'Test-host activation did not expose the desktop test API');
    assert.equal(exports.desktopTest.version, 1);
    api = exports.desktopTest;

    viewTypes = (extension.packageJSON.contributes?.customEditors ?? []).map(
      (editor: { viewType: string }) => editor.viewType
    );
    assert.deepEqual(viewTypes, EXPECTED_VIEW_TYPES);
    assert.equal(vscode.workspace.isTrusted, true, 'runner must disable Workspace Trust restrictions');

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'desktop test runner did not open its temporary workspace');
    fixtureRoot = fs.mkdtempSync(path.join(workspaceRoot, 'runtime-fixtures-'));

    SQL = await initSqlJs({
      locateFile: filename => path.join(extension.extensionPath, 'node_modules', 'sql.js', 'dist', filename)
    });
  });

  suiteTeardown(async () => {
    for (const handle of [...directHandles]) {
      await disposeDirect(handle);
    }
    await closeAllCustomTabs();
    await setMaxFileSize(DEFAULT_MAX_FILE_SIZE_MIB);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  for (const backend of ['native', 'wasm'] as const) {
    suite(`backend=${backend}`, () => {
      setup(async () => {
        await closeAllCustomTabs();
        await setMaxFileSize(DEFAULT_MAX_FILE_SIZE_MIB);
        api.setBackend(backend);
      });

      teardown(async () => {
        for (const handle of [...directHandles]) {
          await disposeDirect(handle);
        }
        await closeAllCustomTabs();
        await setMaxFileSize(DEFAULT_MAX_FILE_SIZE_MIB);
      });

      test('[row 1] real custom-editor open resolves, registers, and tears down its document worker', async () => {
        const fixture = createFixture(`lifecycle-${backend}`);
        await vscode.commands.executeCommand(
          'vscode.openWith',
          fixture.uri,
          viewTypes[0],
          vscode.ViewColumn.One
        );

        const tab = await waitFor('the real custom editor tab', () => findCustomTab(fixture.uri, viewTypes[0]));
        const input = tab.input as vscode.TabInputCustom;
        assert.equal(input.viewType, viewTypes[0]);

        const state = await waitFor('the registered and resolved DatabaseDocument', async () => {
          const candidate = await api.inspectDocument(fixture.uri.toString());
          return candidate?.resolvedEditorCount === 1 ? candidate : undefined;
        });
        assert.equal(state.referenceCount, 1);
        assert.equal(state.engineKind, backend);
        assert.equal(state.workerDisposeRequested, false);

        await closeCustomTab(fixture.uri, viewTypes[0]);
        await waitFor('registry removal after editor close', async () => (
          (await api.inspectDocument(fixture.uri.toString())) === null
        ));
        const disposed = await waitFor('document worker disposal', () => {
          const candidate = api.inspectLifecycle(state.documentId);
          return candidate?.workerDisposeRequested ? candidate : undefined;
        });
        assert.equal(disposed.referenceCount, 0);
      });

      test('[row 2] both contributed viewTypes share one ref-counted DatabaseDocument', async () => {
        const fixture = createFixture(`dual-editor-${backend}`);
        await vscode.commands.executeCommand(
          'vscode.openWith',
          fixture.uri,
          viewTypes[0],
          vscode.ViewColumn.One
        );
        await waitFor('the default custom editor', () => findCustomTab(fixture.uri, viewTypes[0]));
        const firstState = await waitFor('the first registered document', () => (
          api.inspectDocument(fixture.uri.toString())
        ));

        await vscode.commands.executeCommand(
          'vscode.openWith',
          fixture.uri,
          viewTypes[1],
          vscode.ViewColumn.Beside
        );
        await waitFor('the optional custom editor', () => (
          findCustomTab(fixture.uri, viewTypes[1])
        ));
        const defaultTab = findCustomTab(fixture.uri, viewTypes[0]);
        assert.ok(defaultTab);
        assert.equal(customTabs(fixture.uri).length, 2);

        const shared = await waitFor('a two-reference shared document', async () => {
          const candidate = await api.inspectDocument(fixture.uri.toString());
          return candidate?.referenceCount === 2 ? candidate : undefined;
        });
        assert.equal(shared.documentId, firstState.documentId);
        assert.equal(shared.engineKind, backend);

        await closeCustomTab(fixture.uri, viewTypes[0]);
        const retained = await waitFor('the remaining document reference', async () => {
          const candidate = await api.inspectDocument(fixture.uri.toString());
          return candidate?.referenceCount === 1 ? candidate : undefined;
        });
        assert.equal(retained.documentId, firstState.documentId);
        assertSingleValue(
          await api.query(fixture.uri.toString(), 'SELECT value FROM items WHERE id = 1'),
          'original'
        );

        await closeCustomTab(fixture.uri, viewTypes[1]);
        await waitFor('final shared-document disposal', async () => (
          (await api.inspectDocument(fixture.uri.toString())) === null
        ));
        await waitFor('shared document worker disposal', () => {
          const candidate = api.inspectLifecycle(firstState.documentId);
          return candidate?.workerDisposeRequested ? candidate : undefined;
        });
      });

      test('[row 10] backend matrix selects and observes the requested real engine', async () => {
        const fixture = createFixture(`engine-coverage-${backend}`);
        const { handle, state } = await openDirect(fixture);
        assert.equal(state.engineKind, backend);
        assert.equal(state.storage, backend === 'native' ? 'native' : 'memory');
        assertSingleValue(await api.query(handle, 'SELECT value FROM items WHERE id = 1'), 'original');
        await disposeDirect(handle);
      });

      if (backend === 'native') {
        test('[row 3][native-only] save checkpoints native write-through; atomic rename is not applicable', async () => {
          const fixture = createFixture('save-native');
          const { handle, state } = await openDirect(fixture);
          assert.equal(state.storage, 'native');

          await api.updateCell(handle, 'items', 1, 'value', 'native-saved');
          assert.deepEqual(queryFile(fixture.filePath, 'SELECT value FROM items'), [['native-saved']]);
          assert.equal((await api.inspectDocument(fixture.uri.toString()))?.dirty, true);

          await api.save(handle);
          assert.equal((await api.inspectDocument(fixture.uri.toString()))?.dirty, false);
          assert.deepEqual(queryFile(fixture.filePath, 'SELECT value FROM items'), [['native-saved']]);
          await disposeDirect(handle);
        });

        test('[row 7][native-only] maxFileSize materialization ladder is not applicable to native file I/O', async () => {
          await setMaxFileSize(PAGED_TEST_LIMIT_MIB);
          const fixture = createFixture('materialization-native', { large: true });
          const { handle, state } = await openDirect(fixture);
          assert.equal(state.engineKind, 'native');
          assert.equal(state.storage, 'native');
          assertSingleValue(await api.query(handle, 'SELECT length(payload) FROM padding'), 131072);
          await disposeDirect(handle);
        });
      } else {
        test('[row 3][WASM paged-only] save uses adjacent-temp atomic rename and reopens final bytes', async () => {
          await setMaxFileSize(PAGED_TEST_LIMIT_MIB);
          const fixture = createFixture('save-wasm-paged', { large: true });
          const { handle, state } = await openDirect(fixture);
          assert.equal(state.storage, 'paged');
          assert.equal(state.readOnly, false);

          const originalStat = fs.statSync(fixture.filePath, { bigint: true });
          const frozenDescriptor = fs.openSync(fixture.filePath, 'r');
          try {
            await api.updateCell(handle, 'items', 1, 'value', 'wasm-paged-saved');
            assert.deepEqual(fs.readFileSync(fixture.filePath), fixture.originalBytes);
            await api.save(handle);

            const finalBytes = fs.readFileSync(fixture.filePath);
            assert.notDeepEqual(finalBytes, fixture.originalBytes);
            assert.deepEqual(queryFile(fixture.filePath, 'SELECT value FROM items'), [['wasm-paged-saved']]);

            // An in-place overwrite would change reads through this already-open
            // descriptor. Atomic rename leaves it on the byte-identical old inode.
            const frozenBytes = Buffer.alloc(fixture.originalBytes.length);
            const bytesRead = fs.readSync(frozenDescriptor, frozenBytes, 0, frozenBytes.length, 0);
            assert.equal(bytesRead, fixture.originalBytes.length);
            assert.deepEqual(frozenBytes, fixture.originalBytes);

            const finalStat = fs.statSync(fixture.filePath, { bigint: true });
            assert.notEqual(
              `${originalStat.dev}:${originalStat.ino}`,
              `${finalStat.dev}:${finalStat.ino}`,
              'the final path must identify the atomically replaced file'
            );
            assert.equal(
              fs.readdirSync(fixtureRoot).some(name => name.includes('.sqlite-explorer-') && name.endsWith('.tmp')),
              false,
              'adjacent save temp files must be removed after rename'
            );
            const savedState = await api.inspectDocument(fixture.uri.toString());
            assert.equal(savedState?.dirty, false);
            assert.equal(savedState?.storage, 'paged');
          } finally {
            fs.closeSync(frozenDescriptor);
          }
          await disposeDirect(handle);
        });

        test('[row 6][WASM-only] a frame-bearing WAL sibling forces read-only and rejects writes loudly', async () => {
          const fixture = createFixture('wal-read-only-wasm');
          fs.writeFileSync(`${fixture.filePath}-wal`, Buffer.alloc(33, 7), { flag: 'wx' });
          const { handle, state } = await openDirect(fixture);
          assert.equal(state.engineKind, 'wasm');
          assert.equal(state.storage, 'memory');
          assert.equal(state.readOnly, true);
          assertSingleValue(await api.query(handle, 'SELECT value FROM items WHERE id = 1'), 'original');
          await assert.rejects(
            api.updateCell(handle, 'items', 1, 'value', 'must-not-write'),
            /read-only/i
          );
          assert.deepEqual(fs.readFileSync(fixture.filePath), fixture.originalBytes);
          await disposeDirect(handle);
        });

        test('[row 7][WASM-only] observable storage selects memory below and paged above the ladder gate', async () => {
          await setMaxFileSize(PAGED_TEST_LIMIT_MIB);
          const small = createFixture('materialization-wasm-small');
          const large = createFixture('materialization-wasm-large', { large: true });
          assert.ok(small.originalBytes.length < PAGED_TEST_LIMIT_MIB * 2 ** 20);
          assert.ok(large.originalBytes.length > PAGED_TEST_LIMIT_MIB * 2 ** 20);

          const smallOpen = await openDirect(small);
          const largeOpen = await openDirect(large);
          assert.equal(smallOpen.state.storage, 'memory');
          assert.equal(largeOpen.state.storage, 'paged');
          assert.equal(largeOpen.state.readOnly, false);
          assertSingleValue(await api.query(smallOpen.handle, 'SELECT value FROM items'), 'original');
          assertSingleValue(await api.query(largeOpen.handle, 'SELECT length(payload) FROM padding'), 131072);
          await disposeDirect(smallOpen.handle);
          await disposeDirect(largeOpen.handle);
        });
      }

      test(`[row 4] revert restores content and clean state${backend === 'native' ? '; byte identity is WASM-only' : ' with byte-identical disk'}`, async () => {
        const fixture = createFixture(`revert-${backend}`);
        const { handle } = await openDirect(fixture);
        await api.updateCell(handle, 'items', 1, 'value', `changed-${backend}`);
        assert.equal((await api.inspectDocument(fixture.uri.toString()))?.dirty, true);
        assertSingleValue(await api.query(handle, 'SELECT value FROM items'), `changed-${backend}`);

        await api.revert(handle);
        assert.equal((await api.inspectDocument(fixture.uri.toString()))?.dirty, false);
        assertSingleValue(await api.query(handle, 'SELECT value FROM items'), 'original');
        assert.deepEqual(queryFile(fixture.filePath, 'SELECT value FROM items'), [['original']]);
        if (backend === 'wasm') {
          assert.deepEqual(fs.readFileSync(fixture.filePath), fixture.originalBytes);
        }
        await disposeDirect(handle);
      });

      test('[row 5] backup reopens through openCustomDocument(backupId) with unsaved mutations present', async () => {
        const fixture = createFixture(`hot-exit-${backend}`);
        const first = await openDirect(fixture);
        const restoredValue = `restored-${backend}`;
        await api.updateCell(first.handle, 'items', 1, 'value', restoredValue);

        const backupPath = path.join(fixtureRoot, `hot-exit-${backend}.backup`);
        const backupId = await api.backup(first.handle, backupPath);
        assert.ok(fs.statSync(backupPath).size > 0);
        await disposeDirect(first.handle);
        assert.equal(await api.inspectDocument(fixture.uri.toString()), null);

        const second = await openDirect(fixture, backupId);
        assert.notEqual(second.state.documentId, first.state.documentId);
        assert.equal(second.state.dirty, true);
        assertSingleValue(await api.query(second.handle, 'SELECT value FROM items'), restoredValue);
        await disposeDirect(second.handle);
        fs.rmSync(backupPath, { force: true });
      });

      test('[row 8] registered sqlite-explorer:// provider reads and round-trips a cell update', async () => {
        const fixture = createFixture(`virtual-fs-${backend}`);
        const { handle, state } = await openDirect(fixture);
        const uri = cellUri(state, 'value');
        assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), 'original');

        const replacement = `virtual-${backend}`;
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(replacement));
        assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), replacement);
        assertSingleValue(await api.query(handle, 'SELECT value FROM items WHERE id = 1'), replacement);

        await api.revert(handle);
        await disposeDirect(handle);
      });

      test('[row 9] tableExporter writes exact CSV/JSON/SQL bytes for BLOB and NUL text', async () => {
        const fixture = createFixture(`exports-${backend}`, { exportCases: true });
        const { handle } = await openDirect(fixture);
        const columns = ['id', 'payload', 'nul_text'];
        const csvPath = path.join(fixtureRoot, `export-${backend}.csv`);
        const jsonPath = path.join(fixtureRoot, `export-${backend}.json`);
        const sqlPath = path.join(fixtureRoot, `export-${backend}.sql`);

        assert.equal(await api.exportTable(handle, csvPath, 'export_cases', columns, {
          format: 'csv', header: true
        }), 1);
        assert.equal(await api.exportTable(handle, jsonPath, 'export_cases', columns, {
          format: 'json'
        }), 1);
        assert.equal(await api.exportTable(handle, sqlPath, 'export_cases', columns, {
          format: 'sql', includeTableName: true
        }), 1);

        assertFileBytes(csvPath, 'id,payload,nul_text\n1,[BLOB],before\0after');
        assertFileBytes(
          jsonPath,
          '[\n' +
          '  {\n' +
          '    "id": 1,\n' +
          '    "payload": "AAEC/f7/",\n' +
          '    "nul_text": "before\\u0000after"\n' +
          '  }\n' +
          ']'
        );
        assertFileBytes(
          sqlPath,
          'INSERT INTO "export_cases" ("id", "payload", "nul_text") VALUES ' +
          '(1, X\'000102fdfeff\', CAST(X\'6265666f7265006166746572\' AS TEXT));'
        );
        assert.equal(
          fs.readdirSync(fixtureRoot).some(name => /^\.export-.*\.tmp$/.test(name)),
          false,
          'atomic export temp files must not remain'
        );
        await disposeDirect(handle);
      });
    });
  }
});
