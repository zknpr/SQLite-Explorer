import './vscode_mock_setup';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import esbuild from 'esbuild';
import * as vscode from 'vscode';
import { createDatabaseEngine, createWorkerEndpoint as createRealWorkerEndpoint } from '../../src/core/sqlite-db';
import type { DatabaseOperations } from '../../src/core/types';
import { createDeferred } from './helpers/deferred';
import { mockVscode } from './mocks/vscode';

type Document = import('../../src/databaseModel').DatabaseDocument;
type Provider = import('../../src/editorController').DatabaseEditorProvider;
type Engine = DatabaseOperations & { shutdown?: () => void };
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as vscode.CancellationToken;
const openContext = { backupId: undefined, untitledDocumentData: undefined };
const workerFactoryPath = path.resolve(__dirname, '../../src/workerFactory.ts');
const workerFactoryCode = esbuild.transformSync(fs.readFileSync(workerFactoryPath, 'utf8'), {
  loader: 'ts', format: 'cjs', define: { 'import.meta.env.VSCODE_BROWSER_EXT': 'true' }
}).code;
let directory: string;
let provider: Provider;
let documents: Document[];
let engines: Engine[];
let maximumMb: number;
let allocations: number;
let disposals: number;
let actualOpens: number;
let openFailure: Error | undefined;
let openBarrier: ReturnType<typeof createDeferred<void>> | undefined;
let openEntered: ReturnType<typeof createDeferred<void>> | undefined;
let registry: typeof import('../../src/documentRegistry').DocumentRegistry;
let edits: vscode.CustomDocumentEditEvent<Document>[];

async function engineFor(content: Uint8Array | null) {
  const result = await createDatabaseEngine({ content, maxSize: 0, readOnlyMode: false });
  assert.ok(result.operations);
  const engine = result.operations as Engine;
  engines.push(engine);
  return engine;
}

async function fixture(name: string, large = true) {
  const engine = await engineFor(null);
  await engine.executeQuery('CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, payload BLOB)');
  await engine.executeQuery('INSERT INTO items VALUES(1, ?, zeroblob(?))', ['saved value', large ? 1_200_000 : 0]);
  const uri = vscode.Uri.file(path.join(directory, name));
  fs.writeFileSync(uri.fsPath, await engine.serializeDatabase());
  return uri;
}

async function open(uri: vscode.Uri, context: vscode.CustomDocumentOpenContext = openContext, cancellation = token) {
  const document = await provider.openCustomDocument(uri, context, cancellation);
  documents.push(document);
  return document;
}

async function close(document: Document) {
  await document.dispose();
  documents.splice(documents.indexOf(document), 1);
}

async function value(document: Document) {
  return (await document.databaseOperations.executeQuery('SELECT name FROM items WHERE id=1'))[0].rows[0][0];
}

describe('configured-size WASM refusal custom-document recovery', () => {
  beforeEach(() => {
    fs.mkdirSync(path.resolve('.tmp/unit-open-retry'), { recursive: true });
    directory = fs.mkdtempSync(path.resolve('.tmp/unit-open-retry/run-'));
    documents = []; engines = []; edits = [];
    maximumMb = 1; allocations = 0; disposals = 0; actualOpens = 0;
    openFailure = undefined; openBarrier = undefined; openEntered = undefined;
    Object.defineProperty(mockVscode, 'ExtensionKind', { value: { Workspace: 2, UI: 1 }, configurable: true });
    Object.defineProperty(mockVscode, 'extensions', { value: { getExtension: () => ({ extensionKind: 2 }) }, configurable: true });
    Object.defineProperty(mockVscode.window, 'onDidChangeActiveColorTheme', { value: () => ({ dispose() {} }), configurable: true });
    Object.defineProperty(mockVscode.workspace, 'onDidChangeConfiguration', { value: () => ({ dispose() {} }), configurable: true });
    mock.method(vscode.workspace, 'getConfiguration', () => ({
      get: (key: string, fallback: unknown) => key === 'maxFileSize' ? maximumMb : fallback
    }) as vscode.WorkspaceConfiguration);
    const originalFileUri = vscode.Uri.file;
    mock.method(vscode.Uri, 'file', (filePath: string) => ({
      ...originalFileUri(filePath),
      // The WASM opener checks the sibling WAL file before allowing writes.
      with: (changes: { path?: string }) => vscode.Uri.file(changes.path ?? filePath)
    }) as vscode.Uri);
    mock.method(vscode.Uri, 'parse', (value: string) => vscode.Uri.file(fileURLToPath(value)));
    mock.method(vscode.workspace.fs, 'stat', async (uri: vscode.Uri) => {
      const stat = await fs.promises.stat(uri.fsPath);
      return { type: vscode.FileType.File, size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs };
    });
    mock.method(vscode.workspace.fs, 'readFile', async (uri: vscode.Uri) => fs.promises.readFile(uri.fsPath));
    mock.method(vscode.workspace.fs, 'writeFile', async (uri: vscode.Uri, bytes: Uint8Array) => fs.promises.writeFile(uri.fsPath, bytes));
    const cache = require('node:module')._cache;
    for (const name of ['../../src/databaseModel', '../../src/editorController', '../../src/documentRegistry']) {
      delete cache[require.resolve(name)];
    }
    const compiled = new Module(workerFactoryPath, module as unknown as Module);
    compiled.filename = workerFactoryPath;
    compiled.paths = (Module as unknown as { _nodeModulePaths(directory: string): string[] })._nodeModulePaths(path.dirname(workerFactoryPath));
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (name: string) {
      if (name.endsWith('/core/sqlite-db')) return {
        // Exercise the real WASM size admission and endpoint. Native opens
        // intentionally no longer produce configured-size refusal shells.
        createWorkerEndpoint: (...args: Parameters<typeof createRealWorkerEndpoint>) => {
          allocations++;
          const endpoint = createRealWorkerEndpoint(...args);
          return {
            ...endpoint,
            initializeDatabase: async (...initArgs: Parameters<typeof endpoint.initializeDatabase>) => {
              actualOpens++;
              openEntered?.resolve();
              await openBarrier?.promise;
              if (openFailure) throw openFailure;
              return endpoint.initializeDatabase(...initArgs);
            },
            dispose() { disposals++; endpoint.dispose(); }
          };
        }
      };
      if (name.endsWith('/main')) return { GlobalOutputChannel: null };
      return originalRequire.call(this, name);
    };
    try {
      (compiled as unknown as { _compile(code: string, filename: string): void })._compile(workerFactoryCode, workerFactoryPath);
    } finally { Module.prototype.require = originalRequire; }
    cache[require.resolve('../../src/workerFactory')] = compiled;
    compiled.exports.setDesktopTestDatabaseBackend('wasm');
    registry = require('../../src/documentRegistry').DocumentRegistry;
    const controller = require('../../src/editorController') as typeof import('../../src/editorController');
    mock.method(controller.DatabaseViewerProvider.prototype, 'resolveCustomEditor', async () => {});
    provider = new controller.DatabaseEditorProvider('open-retry.test', {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, '../..')), globalState: { update: async () => {} }
    } as unknown as vscode.ExtensionContext, undefined, null, true);
    provider.onDidChangeCustomDocument(edit => edits.push(edit));
  });

  afterEach(async () => {
    openBarrier?.resolve();
    for (const document of documents) await document.dispose();
    provider.dispose();
    for (const engine of engines) engine.shutdown?.();
    mock.restoreAll();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('keeps the same refused document and re-reads 1 MB to 0 on Retry without disturbing a dirty sibling', async () => {
    const sibling = await open(await fixture('sibling.db', false));
    await sibling.hostBridge.updateCell('items', 1, 'name', 'unsaved sibling');
    const uri = await fixture('large.db');
    const document = await open(uri);
    provider.webviews.add(uri, { onDidDispose: () => ({ dispose() {} }) } as unknown as vscode.WebviewPanel, 'retry-test');
    assert.equal(document.isConnected, false);
    assert.equal(document.isReadOnlyMode, true);
    assert.match(document.reloadRequiredReason!, /maximum allowed size \(1.00 MB\)/);
    assert.throws(() => document.databaseOperations, /maximum allowed size/);
    await assert.rejects(() => document.runTrackedMutation(async () => { assert.fail('must not admit a mutation'); }), /maximum allowed size/);
    const refused = await document.hostBridge.initialize();
    assert.equal(refused.connected, false);
    assert.equal(refused.readOnly, true);
    assert.equal(disposals, 1);
    assert.equal(actualOpens, 1, 'the refused file must never reach SQLite');
    await assert.rejects(() => document.reloadFromDisk(), /maximum allowed size \(1.00 MB\)/);
    assert.equal(actualOpens, 1, 'Retry cannot bypass the unchanged byte limit');
    maximumMb = 0;
    await document.reloadFromDisk();
    assert.equal(document.isConnected, true);
    assert.equal(document.isReadOnlyMode, false);
    assert.equal(document.reloadRequiredReason, undefined);
    assert.equal(await value(document), 'saved value');
    assert.equal((await document.hostBridge.initialize()).connected, true);
    assert.equal(await registry.get(await document.documentKey), document);
    assert.equal(await value(sibling), 'unsaved sibling');
    assert.equal((await sibling.getDesktopTestState()).dirty, true);
  });

  it('coalesces refused opens, releases both references, and reopens the exact URI normally', async () => {
    const uri = await fixture('shared.db');
    const [first, second] = await Promise.all([open(uri), open(uri)]);
    assert.equal(first, second);
    assert.equal(allocations, 1);
    assert.equal(disposals, 1);
    await close(first);
    assert.equal(registry.get(await second.documentKey), second);
    await close(second);
    assert.equal(registry.get(await second.documentKey), undefined);
    maximumMb = 0;
    const reopened = await open(uri);
    assert.notEqual(reopened, first);
    assert.equal(reopened.uri.toString(), uri.toString());
    assert.equal(await value(reopened), 'saved value');
  });

  it('does not cancel a coalesced live open when its first caller is cancelled', async () => {
    maximumMb = 0;
    const uri = await fixture('cancel-shared.db');
    // Finish URI hashing before either caller is cancelled so this exercises
    // retained callers of the same in-flight creation, not two serial opens.
    const { crypto } = require('../../src/platform/cryptoShim') as typeof import('../../src/platform/cryptoShim');
    mock.method(crypto.subtle, 'digest', async () => new ArrayBuffer(32));
    openBarrier = createDeferred<void>(); openEntered = createDeferred<void>();
    const cancelled = { ...token, isCancellationRequested: false };
    const first = open(uri, openContext, cancelled);
    const rejected = assert.rejects(first, /cancel/i);
    const second = open(uri);
    await openEntered.promise;
    cancelled.isCancellationRequested = true;
    openBarrier.resolve();
    await rejected;
    const document = await second;
    assert.equal(await value(document), 'saved value');
    assert.equal((await document.getDesktopTestState()).referenceCount, 1);
    assert.equal(disposals, 0);
    await close(document);
    assert.equal(disposals, 1);
  });

  it('honors pre-cancellation before allocating a worker', async () => {
    const uri = await fixture('cancel-before.db');
    await assert.rejects(() => open(uri, openContext, { ...token, isCancellationRequested: true }), /cancel/i);
    assert.equal(allocations, 0);
  });

  it('disposes a successful Retry connection if the refused shell closes while it opens', async () => {
    const document = await open(await fixture('close-during-retry.db'));
    maximumMb = 0;
    openBarrier = createDeferred<void>(); openEntered = createDeferred<void>();
    const retry = document.reloadFromDisk();
    const rejected = assert.rejects(retry, /disposed/i);
    await openEntered.promise;
    await close(document);
    openBarrier.resolve();
    await rejected;
    assert.equal(registry.get(await document.documentKey), undefined);
    assert.equal(disposals, 2);
  });

  it('does not disguise a non-size open error as a retryable size refusal', async () => {
    maximumMb = 0;
    openFailure = new Error('Controlled invalid database');
    const uri = await fixture('invalid.db');
    await assert.rejects(() => open(uri), /Controlled invalid database/);
    assert.equal(registry.size, 0);
    assert.equal(disposals, 1);
  });

  it('restores pending hot-exit history after Retry and publishes Undo only after resolve', async () => {
    maximumMb = 0;
    const uri = await fixture('restore-retry.db');
    const original = await open(uri);
    await original.hostBridge.updateCell('items', 1, 'name', 'unsaved restored value');
    const backupUri = vscode.Uri.file(path.join(directory, 'history.backup'));
    await original.backup(backupUri, token);
    await close(original);
    edits = [];
    maximumMb = 1;
    const restored = await open(uri, { ...openContext, backupId: backupUri.toString() });
    await provider.resolveCustomEditor(restored, {} as vscode.WebviewPanel, token);
    assert.equal(edits.length, 0);
    maximumMb = 0;
    await restored.reloadFromDisk();
    assert.equal(await value(restored), 'unsaved restored value');
    assert.equal((await restored.getDesktopTestState()).dirty, true);
    assert.equal(edits.length, 1);
    await edits[0].undo();
    assert.equal(await value(restored), 'saved value');
  });

  it('notifies once per failed autosave episode and preserves the pending retry and dirty edits', async () => {
    const document = await open(await fixture('autosave.db', false));
    document.autoCommitEnabled = true;
    let fail = true;
    mock.method(vscode.workspace, 'save', async () => {
      if (fail) throw new Error('Controlled autosave destination conflict');
      await document.save(); return document.uri;
    });
    const notifications = mock.method(vscode.window, 'showErrorMessage', async () => undefined);
    await document.hostBridge.updateCell('items', 1, 'name', 'first unsaved');
    await new Promise<void>(resolve => setImmediate(resolve));
    await document.hostBridge.updateCell('items', 1, 'name', 'second unsaved');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(notifications.mock.callCount(), 1);
    assert.match(String(notifications.mock.calls[0].arguments[0]), /auto.*save.*failed.*retry/i);
    assert.equal(document.hasPendingSave, true);
    assert.equal((await document.getDesktopTestState()).dirty, true);
    fail = false;
    await document.triggerSave();
    assert.equal(document.hasPendingSave, false);
    fail = true;
    await document.hostBridge.updateCell('items', 1, 'name', 'next failed episode');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(notifications.mock.callCount(), 2);
  });

  for (const rpcError of [false, true]) {
    it(`keeps a cancelled autosave retryable without a failure notification (${rpcError ? 'RPC' : 'local'} error)`, async () => {
      const document = await open(await fixture(`autosave-cancel-${rpcError}.db`, false));
      const savedBytes = fs.readFileSync(document.uri.fsPath);
      document.autoCommitEnabled = true;
      const cancellation = rpcError
        ? Object.assign(new Error('Canceled'), { name: 'Canceled' })
        : new vscode.CancellationError();
      mock.method(vscode.workspace, 'save', async () => { throw cancellation; });
      const notifications = mock.method(vscode.window, 'showErrorMessage', async () => undefined);

      await document.hostBridge.updateCell('items', 1, 'name', 'pending after cancellation');
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(notifications.mock.callCount(), 0);
      assert.equal(document.hasPendingSave, true);
      assert.equal((await document.getDesktopTestState()).dirty, true);
      assert.deepEqual(fs.readFileSync(document.uri.fsPath), savedBytes);

      // A manual Save enters the provider directly, not through triggerSave.
      await document.save(token);
      assert.equal(document.hasPendingSave, false);
      assert.equal((await document.getDesktopTestState()).dirty, false);
      const reopened = await engineFor(fs.readFileSync(document.uri.fsPath));
      assert.deepEqual((await reopened.executeQuery('SELECT name FROM items'))[0].rows, [['pending after cancellation']]);
    });
  }

  it('does not restore a pending retry when a superseded autosave rejects after manual Save completes', async () => {
    const document = await open(await fixture('autosave-late-cancel.db', false));
    document.autoCommitEnabled = true;
    const superseded = createDeferred<vscode.Uri | undefined>();
    mock.method(vscode.workspace, 'save', () => superseded.promise);
    const notifications = mock.method(vscode.window, 'showErrorMessage', async () => undefined);
    await document.hostBridge.updateCell('items', 1, 'name', 'manual save won');
    assert.equal(document.hasPendingSave, true);
    await document.save(token);
    superseded.reject(Object.assign(new Error('Canceled'), { name: 'Canceled' }));
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(notifications.mock.callCount(), 0);
    assert.equal(document.hasPendingSave, false);
    assert.equal((await document.getDesktopTestState()).dirty, false);
    const reopened = await engineFor(fs.readFileSync(document.uri.fsPath));
    assert.deepEqual((await reopened.executeQuery('SELECT name FROM items'))[0].rows, [['manual save won']]);
  });

  it('does not treat an ordinary error message as cancellation and rearms warnings after manual Save', async () => {
    const document = await open(await fixture('autosave-real-error.db', false));
    document.autoCommitEnabled = true;
    mock.method(vscode.workspace, 'save', async () => { throw new Error('Canceled'); });
    const notifications = mock.method(vscode.window, 'showErrorMessage', async () => undefined);
    await document.hostBridge.updateCell('items', 1, 'name', 'first failed edit');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(notifications.mock.callCount(), 1);
    assert.equal(document.hasPendingSave, true);
    assert.equal((await document.getDesktopTestState()).dirty, true);

    await document.save(token);
    assert.equal(document.hasPendingSave, false);
    await document.hostBridge.updateCell('items', 1, 'name', 'second failed edit');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(notifications.mock.callCount(), 2);
    assert.equal(document.hasPendingSave, true);
    assert.equal((await document.getDesktopTestState()).dirty, true);
    const reopened = await engineFor(fs.readFileSync(document.uri.fsPath));
    assert.deepEqual((await reopened.executeQuery('SELECT name FROM items'))[0].rows, [['first failed edit']]);
  });
});
