import './vscode_mock_setup';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import * as vscode from 'vscode';
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations } from '../../src/core/types';
import { ModificationTracker } from '../../src/core/undo-history';
import { mockVscode } from './mocks/vscode';
import { createDeferred } from './helpers/deferred';

type Document = import('../../src/databaseModel').DatabaseDocument;
type Edit = vscode.CustomDocumentEditEvent<Document>;
type Engine = DatabaseOperations & { shutdown?: () => void };
type Provider = import('../../src/editorController').DatabaseEditorProvider;

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as vscode.CancellationToken;
const query = 'SELECT name FROM items WHERE id=1';
let directory: string;
let provider: Provider;
let documents: Set<Document>;
let backup: Uint8Array;
let events: Edit[];
let failOpenFor: string | undefined;
let controllerModule: typeof import('../../src/editorController');
const engines: Engine[] = [];

async function engineFor(content: Uint8Array | null): Promise<Engine> {
  const result = await createDatabaseEngine({ content, maxSize: 0, readOnlyMode: false });
  assert.ok(result.operations);
  const engine = result.operations as Engine;
  engines.push(engine);
  return engine;
}

async function fixture(name: string, value: string) {
  const file = path.join(directory, name);
  const engine = await engineFor(null);
  await engine.executeQuery('CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT)');
  await engine.executeQuery('INSERT INTO items VALUES(1, ?)', [value]);
  fs.writeFileSync(file, await engine.serializeDatabase());
  return vscode.Uri.file(file);
}

async function open(uri: vscode.Uri, context: vscode.CustomDocumentOpenContext = { backupId: undefined, untitledDocumentData: undefined }) {
  const document = await provider.openCustomDocument(uri, context, token);
  documents.add(document);
  return document;
}

async function value(document: Document) {
  return (await document.databaseOperations.executeQuery(query))[0].rows[0][0];
}

async function backupAndDispose(document: Document) {
  await document.backup(vscode.Uri.file(path.join(directory, 'lifecycle-backup')), token);
  await document.dispose(); documents.delete(document);
  return { backupId: 'file:///lifecycle-backup', untitledDocumentData: undefined };
}

describe('database custom-editor lifecycle', () => {
  beforeEach(async () => {
    fs.mkdirSync(path.resolve('.tmp/unit-database-lifecycle'), { recursive: true });
    directory = fs.mkdtempSync(path.resolve('.tmp/unit-database-lifecycle/run-'));
    documents = new Set(); events = []; backup = new Uint8Array(); failOpenFor = undefined;
    const cache = require('node:module')._cache;
    for (const name of ['../../src/databaseModel', '../../src/editorController', '../../src/documentRegistry']) delete cache[require.resolve(name)];
    const factoryPath = require.resolve('../../src/workerFactory');
    cache[factoryPath] = { id: factoryPath, filename: factoryPath, loaded: true, exports: {
      createDatabaseConnection: async () => {
        let active: Engine | undefined;
        return {
          establishConnection: async (uri: vscode.Uri) => {
            if (uri.fsPath === failOpenFor) throw new Error('Controlled replacement-open failure');
            active = await engineFor(fs.readFileSync(uri.fsPath));
            return { databaseOps: active, isReadOnly: false, storage: 'memory' };
          },
          workerMethods: { [Symbol.dispose]: () => active?.shutdown?.() }
        };
      }
    } };
    Object.defineProperty(mockVscode, 'ExtensionKind', { value: { Workspace: 2, UI: 1 }, configurable: true });
    Object.defineProperty(mockVscode.env, 'remoteName', { value: 'remote', configurable: true });
    Object.defineProperty(mockVscode, 'extensions', { value: { getExtension: () => ({ extensionKind: 2 }) }, configurable: true });
    Object.defineProperty(mockVscode.window, 'onDidChangeActiveColorTheme', {
      value: () => ({ dispose() {} }), configurable: true
    });
    Object.defineProperty(mockVscode.workspace, 'onDidChangeConfiguration', {
      value: () => ({ dispose() {} }), configurable: true
    });
    mock.method(vscode.workspace, 'getConfiguration', () => ({ get: (_name: string, fallback: unknown) => fallback }) as vscode.WorkspaceConfiguration);
    mock.method(mockVscode.window, 'showWarningMessage', async (message: string, _options: unknown, action?: string) => {
      // These Save As lifecycle cases explicitly replace an existing target.
      // Other prompts keep the default cancellation behavior.
      return message === 'Replace the existing file?' && action === 'Replace' ? action : undefined;
    });
    mock.method(vscode.workspace.fs, 'readFile', async () => backup);
    mock.method(vscode.workspace.fs, 'writeFile', async (_uri: vscode.Uri, bytes: Uint8Array) => { backup = bytes; });
    controllerModule = require('../../src/editorController');
    // The external webview shell is covered by tests/gui/lifecycle.mjs. Keep the
    // real provider's resolve override and document/SQLite lifecycle here.
    mock.method(controllerModule.DatabaseViewerProvider.prototype, 'resolveCustomEditor', async () => {});
    provider = new controllerModule.DatabaseEditorProvider('lifecycle.test', {
      extensionUri: vscode.Uri.file(directory), globalState: { update: async () => {} }
    } as unknown as vscode.ExtensionContext, undefined, null, true);
    provider.onDidChangeCustomDocument(event => events.push(event));
  });

  afterEach(async () => {
    for (const document of documents) await document.dispose();
    provider.dispose();
    for (const engine of engines.splice(0)) engine.shutdown?.();
    mock.restoreAll();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('Save As refreshes an already-open destination and retires its old history', async () => {
    const sourceUri = await fixture('source.db', 'copied value');
    const targetUri = await fixture('target.db', 'old target');
    const source = await open(sourceUri);
    const target = await open(targetUri);
    await target.hostBridge.updateCell('items', 1, 'name', 'saved target edit');
    const oldEdit = events.at(-1)!;
    await target.save();
    const sourceBytes = fs.readFileSync(sourceUri.fsPath);

    await provider.saveCustomDocumentAs(source, targetUri, token);

    assert.equal(await value(target), 'copied value', 'the same destination document must reopen the new bytes');
    await oldEdit.undo();
    assert.equal(await value(target), 'copied value', 'old destination callbacks must not mutate the replacement');
    await target.hostBridge.updateCell('items', 1, 'name', 'target owns edit');
    await target.save();
    assert.deepEqual(fs.readFileSync(sourceUri.fsPath), sourceBytes);
    assert.equal(await value(source), 'copied value');
  });

  it('Save As refuses an open WASM destination with unsaved edits', async () => {
    const sourceUri = await fixture('source.db', 'copied value');
    const targetUri = await fixture('target.db', 'original target');
    const source = await open(sourceUri);
    const target = await open(targetUri);
    await target.hostBridge.updateCell('items', 1, 'name', 'unsaved target');
    const bytes = fs.readFileSync(targetUri.fsPath);

    await assert.rejects(() => provider.saveCustomDocumentAs(source, targetUri, token), /save|revert/i);

    assert.deepEqual(fs.readFileSync(targetUri.fsPath), bytes);
    assert.equal(await value(target), 'unsaved target');
    await events.at(-1)!.undo();
    assert.equal(await value(target), 'original target');
  });

  it('Save As drains an admitted destination edit before deciding whether its overlay can be replaced', async () => {
    const sourceUri = await fixture('source.db', 'copied value');
    const targetUri = await fixture('target.db', 'original target');
    const source = await open(sourceUri);
    const target = await open(targetUri);
    const release = createDeferred<void>();
    const admitted = createDeferred<void>();
    const replacementStarted = createDeferred<void>();
    const replace = target.replaceFromSaveAs.bind(target);
    mock.method(target, 'replaceFromSaveAs', (...args: Parameters<typeof replace>) => {
      replacementStarted.resolve(); return replace(...args);
    });
    const execute = target.databaseOperations.executeQuery.bind(target.databaseOperations);
    mock.method(target.databaseOperations, 'executeQuery', async (...args: Parameters<typeof execute>) => {
      if (args[0].startsWith('SELECT typeof(')) {
        admitted.resolve(); await release.promise;
      }
      return execute(...args);
    });
    const mutation = target.hostBridge.updateCell('items', 1, 'name', 'admitted target edit');
    await admitted.promise;
    const copying = provider.saveCustomDocumentAs(source, targetUri, token);
    const rejected = assert.rejects(copying, /unsaved changes/i);
    await replacementStarted.promise;
    await assert.rejects(() => target.runTrackedMutation(async () => {}), /Save As is in progress/);
    release.resolve(); await mutation; await rejected;
    assert.equal(await value(target), 'admitted target edit');
  });

  it('retires the destination connection before the replacement writer runs', async () => {
    const sourceUri = await fixture('source.db', 'copied value');
    const targetUri = await fixture('target.db', 'original target');
    const source = await open(sourceUri);
    const target = await open(targetUri);
    const oldOperations = target.databaseOperations;
    const write = source.databaseOperations.writeToFile.bind(source.databaseOperations);
    mock.method(source.databaseOperations, 'writeToFile', async (...args: Parameters<typeof write>) => {
      await assert.rejects(() => oldOperations.executeQuery(query), /closed/i);
      return write(...args);
    });
    await provider.saveCustomDocumentAs(source, targetUri, token);
    assert.equal(await value(target), 'copied value');
  });

  it('reopens a failed Save As destination without losing its prior saved Undo history', async () => {
    const sourceUri = await fixture('source.db', 'copied value');
    const targetUri = await fixture('target.db', 'original target');
    const source = await open(sourceUri);
    const target = await open(targetUri);
    await target.hostBridge.updateCell('items', 1, 'name', 'saved target edit');
    const oldEdit = events.at(-1)!;
    await target.save();
    const originalBytes = fs.readFileSync(targetUri.fsPath);
    mock.method(source.databaseOperations, 'writeToFile', async () => { throw new Error('Controlled writer failure'); });
    await assert.rejects(() => provider.saveCustomDocumentAs(source, targetUri, token), /Controlled writer failure/);
    assert.deepEqual(fs.readFileSync(targetUri.fsPath), originalBytes);
    assert.equal(await value(target), 'saved target edit');
    await oldEdit.undo(); assert.equal(await value(target), 'original target');
  });

  it('reports a committed Save As reopen failure and keeps the target read-only until Reload', async () => {
    const sourceUri = await fixture('source.db', 'copied value');
    const targetUri = await fixture('target.db', 'original target');
    const source = await open(sourceUri);
    const target = await open(targetUri);
    const write = source.databaseOperations.writeToFile.bind(source.databaseOperations);
    mock.method(source.databaseOperations, 'writeToFile', async (...args: Parameters<typeof write>) => {
      const result = await write(...args); failOpenFor = targetUri.fsPath; return result;
    });
    await assert.rejects(() => provider.saveCustomDocumentAs(source, targetUri, token), /saved.*destination could not be reopened/i);
    assert.equal(target.isReadOnlyMode, true);
    failOpenFor = undefined;
    await target.reloadFromDisk();
    assert.equal(target.isReadOnlyMode, false);
    assert.equal(await value(target), 'copied value');
  });

  it('publishes restored unsaved edits only after resolve, with sequential Undo and Redo', async () => {
    const uri = await fixture('restore.db', 'saved');
    const original = await open(uri);
    await original.hostBridge.updateCell('items', 1, 'name', 'first');
    await original.hostBridge.updateCell('items', 1, 'name', 'second');
    const openContext = await backupAndDispose(original);
    events = [];
    const restored = await open(uri, openContext);
    assert.equal(await value(restored), 'second');
    assert.equal(events.length, 0, 'openCustomDocument precedes VS Code document registration');

    await provider.resolveCustomEditor(restored, {} as vscode.WebviewPanel, token);
    assert.equal(events.length, 2, 'resolve must publish each restored applied unsaved edit');
    await provider.resolveCustomEditor(restored, {} as vscode.WebviewPanel, token);
    assert.equal(events.length, 2, 'split or recreated viewers must not duplicate Undo entries');
    await events[1].undo(); assert.equal(await value(restored), 'first');
    await events[0].undo(); assert.equal(await value(restored), 'saved');
    await events[0].redo(); assert.equal(await value(restored), 'first');
    await events[1].redo(); assert.equal(await value(restored), 'second');
  });

  it('keeps the saved checkpoint and pre-exit Redo branch out of the restored UI Undo stack', async () => {
    const uri = await fixture('restore.db', 'initial');
    const original = await open(uri);
    await original.hostBridge.updateCell('items', 1, 'name', 'checkpoint');
    await original.save();
    await original.hostBridge.updateCell('items', 1, 'name', 'pending');
    await original.hostBridge.updateCell('items', 1, 'name', 'undone before exit');
    await events.at(-1)!.undo();
    const openContext = await backupAndDispose(original);
    assert.equal(ModificationTracker.deserialize(backup).canStepForward, true);
    events = [];
    const restored = await open(uri, openContext);
    await provider.resolveCustomEditor(restored, {} as vscode.WebviewPanel, token);

    assert.equal(events.length, 1, 'the API can seed only applied edits after the saved checkpoint');
    assert.equal(await value(restored), 'pending');
    await events[0].undo(); assert.equal(await value(restored), 'checkpoint');
    await events[0].redo(); assert.equal(await value(restored), 'pending');
    await restored.backup(vscode.Uri.file(path.join(directory, 'lifecycle-backup')), token);
    assert.equal(ModificationTracker.deserialize(backup).canStepForward, true, 'unregistered Redo remains available to restore bookkeeping');
  });

  it('auto-commits the owning inactive WASM document through VS Code and keeps its Undo checkpoint', async () => {
    const uri = await fixture('inactive.db', 'before');
    const otherUri = await fixture('active.db', 'other database');
    const document = await open(uri);
    const other = await open(otherUri);
    const otherBytes = fs.readFileSync(otherUri.fsPath);
    let saved = createDeferred<void>();
    const save = mock.method(vscode.workspace, 'save', async (target: vscode.Uri) => {
      assert.equal(target.toString(), uri.toString());
      await provider.saveCustomDocument(document, token);
      saved.resolve();
      return target;
    });
    document.autoCommitEnabled = true;
    // No active viewer: imports and SQL workspaces keep their preview selected.
    await document.hostBridge.updateCell('items', 1, 'name', 'background edit');
    assert.equal(save.mock.callCount(), 1);
    await saved.promise;
    await document.backup(vscode.Uri.file(path.join(directory, 'checkpoint')), token);
    assert.equal(ModificationTracker.deserialize(backup).hasUncommittedChanges(), false);
    const persisted = await engineFor(fs.readFileSync(uri.fsPath));
    assert.equal((await persisted.executeQuery(query))[0].rows[0][0], 'background edit');
    assert.deepEqual(fs.readFileSync(otherUri.fsPath), otherBytes);
    assert.equal(await value(other), 'other database');

    saved = createDeferred<void>();
    await events.at(-1)!.undo(); await saved.promise;
    const independent = await engineFor(fs.readFileSync(uri.fsPath));
    assert.equal((await independent.executeQuery(query))[0].rows[0][0], 'before');
    assert.deepEqual(fs.readFileSync(otherUri.fsPath), otherBytes);
  });
});
