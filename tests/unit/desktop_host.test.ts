import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopHost } from '../../core/ui/modules/desktop-host.js';

type Envelope = {
  channel: string;
  content: { kind: string; messageId: string; targetMethod: string; payload: unknown[] };
};

function makeFakeWorker(handlers: Record<string, (args: unknown[]) => unknown>) {
  const posted: Envelope[] = [];
  const worker = {
    onmessage: null as null | ((ev: { data: unknown }) => void),
    onerror: null as null | ((err: unknown) => void),
    postMessage(msg: Envelope) {
      posted.push(msg);
      const { messageId, targetMethod, payload } = msg.content;
      queueMicrotask(() => {
        try {
          const handler = handlers[targetMethod];
          if (!handler) throw new Error(`no fake for ${targetMethod}`);
          const data = handler(payload);
          worker.onmessage?.({ data: { channel: 'rpc', content: { kind: 'response', messageId, success: true, data } } });
        } catch (error) {
          worker.onmessage?.({ data: { channel: 'rpc', content: {
            kind: 'response', messageId, success: false,
            errorMessage: error instanceof Error ? error.message : String(error)
          } } });
        }
      });
    },
    terminate() { /* no-op */ }
  };
  return { worker, posted };
}

function makeFakeBridge(overrides: Record<string, unknown> = {}) {
  const saved: { path?: string; bytes?: Uint8Array; settings?: unknown } = {};
  return {
    saved,
    bridge: {
      pickDatabase: async () => ({ path: '/tmp/x.db', name: 'x.db', size: 3 }),
      readDatabaseBytes: async (_p: string) => new Uint8Array([1, 2, 3]),
      saveDatabase: async (path: string, bytes: Uint8Array) => { saved.path = path; saved.bytes = bytes; },
      saveFileAs: async (_n: string, _b: Uint8Array) => '/tmp/out',
      loadSettings: async () => ({}),
      saveSettings: async (s: unknown) => { saved.settings = s; },
      onMenu: (_h: (id: string) => void) => {},
      setTitle: async (_t: string) => {},
      ...overrides
    }
  };
}

function makeHost(handlers: Record<string, (args: unknown[]) => unknown>, bridgeOverrides = {}) {
  const { worker, posted } = makeFakeWorker({
    initializeDatabase: () => ({ isReadOnly: false, storage: 'memory' }),
    ping: () => true,
    ...handlers
  });
  const { bridge, saved } = makeFakeBridge(bridgeOverrides);
  const host = createDesktopHost({
    bridge,
    createWorker: () => worker as unknown as Worker
  });
  return { host, posted, saved, bridge };
}

test('start boots an empty database and initialize reports connected', async () => {
  const { host, posted } = makeHost({});
  await host.start();
  assert.equal(posted[0].content.targetMethod, 'initializeDatabase');
  const init = await host.invoke('initialize', []);
  // `engine` drives the desktop status-bar badge; the empty startup DB is WASM.
  assert.deepEqual(init, { connected: true, isReadOnly: false, filename: 'untitled.db', engine: 'wasm' });
});

test('unknown methods forward to the worker verbatim', async () => {
  const { host, posted } = makeHost({ fetchSchema: () => ({ tables: [], views: [], indexes: [] }) });
  await host.start();
  const schema = await host.invoke('fetchSchema', []);
  assert.deepEqual(schema, { tables: [], views: [], indexes: [] });
  assert.equal(posted.at(-1)!.content.targetMethod, 'fetchSchema');
});

test('getExtensionSettings maps stored keys onto the VS Code wire shape', async () => {
  const { host } = makeHost({}, { loadSettings: async () => ({ doubleClickBehavior: 'modal', instantCommit: 'always' }) });
  await host.start();
  const settings = await host.invoke('getExtensionSettings', []) as Record<string, unknown>;
  // hostBridge.ts parity: panel-facing keys, not the persisted config keys.
  // consoleHistory has no VS Code twin — the SQL console is desktop-only.
  assert.deepEqual(settings, {
    autoCommit: true,
    cellEditBehavior: 'modal',
    fileOperations: 'native',
    theme: 'system',
    consoleHistory: []
  });
});

test('updateExtensionSetting persists the delta through the bridge', async () => {
  const { host, saved } = makeHost({});
  await host.start();
  await host.invoke('updateExtensionSetting', ['doubleClickBehavior', 'modal']);
  assert.deepEqual(saved.settings, { doubleClickBehavior: 'modal' });
  const settings = await host.invoke('getExtensionSettings', []) as Record<string, unknown>;
  assert.equal(settings.cellEditBehavior, 'modal');
});

test('updateExtensionSetting translates autoCommit onto instantCommit', async () => {
  const { host, saved } = makeHost({});
  await host.start();
  await host.invoke('updateExtensionSetting', ['autoCommit', true]);
  assert.deepEqual(saved.settings, { instantCommit: 'always' });
  let settings = await host.invoke('getExtensionSettings', []) as Record<string, unknown>;
  assert.equal(settings.autoCommit, true);
  await host.invoke('updateExtensionSetting', ['autoCommit', false]);
  assert.deepEqual(saved.settings, {});   // back to default → empty delta
  settings = await host.invoke('getExtensionSettings', []) as Record<string, unknown>;
  assert.equal(settings.autoCommit, false);
});

test('cell-edit behavior is pushed to the webview at start and on change', async () => {
  const pushed: unknown[] = [];
  const { host } = makeHost({}, { loadSettings: async () => ({ doubleClickBehavior: 'modal' }) });
  host.setWebviewMethods({
    updateCellEditBehavior: async (value: unknown) => { pushed.push(value); return { success: true }; }
  });
  await host.start();
  assert.deepEqual(pushed, ['modal']);
  await host.invoke('updateExtensionSetting', ['doubleClickBehavior', 'vscode']);
  assert.deepEqual(pushed, ['modal', 'vscode']);
});

test('updateCell records an undoable modification; triggerUndo replays it and refreshes the UI', async () => {
  const calls: unknown[][] = [];
  const { host } = makeHost({
    updateCell: () => 7,                       // worker returns (possibly new) rowId
    undoModification: (args) => { calls.push(args); return { success: true }; }
  });
  await host.start();
  let refreshed = 0;
  host.setWebviewMethods({ refreshContent: async () => { refreshed++; return { success: true }; } });

  await host.invoke('updateCell', ['users', 7, 'name', 'Alice2', 'Alice', 1048576]);
  assert.equal(host.hasUnsavedChanges(), true);

  await host.invoke('triggerUndo', []);
  assert.equal(refreshed, 1);
  const mod = (calls[0] as unknown[])[0] as Record<string, unknown>;
  assert.equal(mod.modificationType, 'cell_update');
  assert.equal(mod.targetTable, 'users');
  assert.equal(mod.targetRowId, 7);
  assert.equal(mod.targetColumn, 'name');
  assert.equal(mod.priorValue, 'Alice');
  assert.equal(mod.newValue, 'Alice2');
});

test('triggerRedo replays the undone modification via redoModification', async () => {
  const redone: unknown[][] = [];
  const { host } = makeHost({
    updateCell: () => 7,
    undoModification: () => ({ success: true }),
    redoModification: (args) => { redone.push(args); return { success: true }; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.invoke('updateCell', ['users', 7, 'name', 'B', 'A', 1048576]);
  await host.invoke('triggerUndo', []);
  await host.invoke('triggerRedo', []);
  assert.equal(redone.length, 1);
});

// updateCellBatch's descriptor must be built from the worker's authoritative
// CellUpdateResult[] (per-cell rowId/newRowId/columnName/priorValue/newValue/
// operation — src/core/types.ts:531), not echoed from the caller's request
// array (CellUpdate[] — src/core/types.ts:522, which uses different field
// names entirely: `column`/`originalValue` instead of `columnName`/
// `priorValue`, and has no newRowId concept at all).
test('updateCellBatch descriptor carries the worker\'s authoritative per-cell result, not the caller\'s stale args', async () => {
  const undone: unknown[][] = [];
  const { host } = makeHost({
    // Primary-key branch result shape (worker.js updateCellBatch ~line 2353):
    // rowId/newRowId/columnName/priorValue/newValue/operation all present.
    updateCellBatch: () => ([
      { rowId: 5, newRowId: 9, columnName: 'sku', priorValue: 'A', newValue: 'B', operation: 'set' }
    ]),
    undoModification: (args) => { undone.push(args); return { success: true }; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });

  // Caller-supplied args deliberately disagree with the worker's result
  // (stale originalValue, no newRowId at all) to prove the descriptor is
  // built from the RESULT, not the request.
  await host.invoke('updateCellBatch', ['items', [
    { rowId: 5, column: 'sku', value: 'B', originalValue: 'STALE' }
  ]]);
  await host.invoke('triggerUndo', []);

  const mod = (undone[0] as unknown[])[0] as Record<string, unknown>;
  const cells = mod.affectedCells as Array<Record<string, unknown>>;
  assert.equal(cells.length, 1);
  assert.equal(cells[0].rowId, 5);
  assert.equal(cells[0].newRowId, 9);        // from the worker result — args had no such field
  assert.equal(cells[0].columnName, 'sku');
  assert.equal(cells[0].priorValue, 'A');    // from the worker's fresh read, not args' stale 'STALE'
  assert.equal(cells[0].newValue, 'B');
  assert.equal(cells[0].operation, 'set');
});

test('updateCellBatch defaults newRowId to the unchanged rowId when the worker result omits it (rowid-table path)', async () => {
  const undone: unknown[][] = [];
  const { host } = makeHost({
    // Non-PK (rowid) branch result shape (worker.js updateCellBatch ~line 2430)
    // never reports newRowId — only a changed primary key produces one.
    updateCellBatch: () => ([
      { rowId: 3, columnName: 'name', priorValue: 'old', newValue: 'new', operation: 'set' }
    ]),
    undoModification: (args) => { undone.push(args); return { success: true }; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.invoke('updateCellBatch', ['items', [{ rowId: 3, column: 'name', value: 'new' }]]);
  await host.invoke('triggerUndo', []);
  const mod = (undone[0] as unknown[])[0] as Record<string, unknown>;
  const cells = mod.affectedCells as Array<Record<string, unknown>>;
  assert.equal(cells[0].newRowId, 3);   // defaulted to rowId, not left undefined
});

// Redo-direction coverage (fix round 3): the recorded descriptor must survive
// undo→redo intact and reach redoModification's cell_update case (worker.js
// ~line 2166), which maps affectedCells[].rowId/columnName/newValue/operation
// back into updateCellBatch's update shape.
test('updateCellBatch descriptor survives undo→redo intact: affectedCells (incl. newRowId/operation) reach redoModification', async () => {
  const redone: unknown[][] = [];
  const { host } = makeHost({
    updateCellBatch: () => ([
      { rowId: 5, newRowId: 9, columnName: 'sku', priorValue: 'A', newValue: 'B', operation: 'set' }
    ]),
    undoModification: () => ({ success: true }),
    redoModification: (args) => { redone.push(args); return { success: true }; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.invoke('updateCellBatch', ['items', [
    { rowId: 5, column: 'sku', value: 'B', originalValue: 'STALE' }
  ]]);
  await host.invoke('triggerUndo', []);
  await host.invoke('triggerRedo', []);

  assert.equal(redone.length, 1);
  const mod = (redone[0] as unknown[])[0] as Record<string, unknown>;
  const cells = mod.affectedCells as Array<Record<string, unknown>>;
  assert.equal(cells.length, 1);
  assert.equal(cells[0].rowId, 5);
  assert.equal(cells[0].newRowId, 9);
  assert.equal(cells[0].columnName, 'sku');
  assert.equal(cells[0].newValue, 'B');
  assert.equal(cells[0].operation, 'set');
});

test('insertRow records rowData for redo; undo deletes via targetRowId, redo re-inserts via rowData', async () => {
  const undone: unknown[][] = [];
  const redone: unknown[][] = [];
  const { host } = makeHost({
    insertRow: () => 42,   // worker returns only the new rowId, never the row data
    undoModification: (args) => { undone.push(args); return { success: true }; },
    redoModification: (args) => { redone.push(args); return { success: true }; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });

  await host.invoke('insertRow', ['users', { name: 'Bob' }]);
  assert.equal(host.hasUnsavedChanges(), true);

  await host.invoke('triggerUndo', []);
  const undoMod = (undone[0] as unknown[])[0] as Record<string, unknown>;
  assert.equal(undoMod.modificationType, 'row_insert');
  assert.equal(undoMod.targetTable, 'users');
  assert.equal(undoMod.targetRowId, 42);
  assert.deepEqual(undoMod.rowData, { name: 'Bob' });   // needed for redo, not undo itself

  await host.invoke('triggerRedo', []);
  assert.equal(redone.length, 1);
  const redoMod = (redone[0] as unknown[])[0] as Record<string, unknown>;
  assert.equal(redoMod.modificationType, 'row_insert');
  assert.deepEqual(redoMod.rowData, { name: 'Bob' });   // same recorded entry — redoModification's
                                                          // row_insert case reads `rowData`, not args
});

test('deleteRows records deletedRows from the worker result for undo', async () => {
  const undone: unknown[][] = [];
  // Ground truth (worker.js deleteRows, both rowid and primary-key branches):
  // each entry is { rowId, row }, not { rowId, values }.
  const deleted = [{ rowId: 1, row: { name: 'Alice' } }];
  const { host } = makeHost({
    deleteRows: () => deleted,
    undoModification: (args) => { undone.push(args); return { success: true }; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.invoke('deleteRows', ['users', [1]]);
  await host.invoke('triggerUndo', []);
  const mod = (undone[0] as unknown[])[0] as Record<string, unknown>;
  assert.equal(mod.modificationType, 'row_delete');
  assert.deepEqual(mod.deletedRows, deleted);
});

// Self-discovered while auditing insertRow's rowData gap (see desktop-host.js
// comment on the deleteRows case) — not one of the review's 3 listed critical
// defects, fixed and covered separately. redoModification's row_delete case
// reads `affectedRowIds` (worker.js ~line 2202), not `deletedRows`; without
// it, redo after undo silently deletes nothing.
test('deleteRows records affectedRowIds so triggerRedo can re-delete after undo', async () => {
  const redone: unknown[][] = [];
  const deleted = [{ rowId: 1, row: { name: 'Alice' } }];
  const { host } = makeHost({
    deleteRows: () => deleted,
    undoModification: () => ({ success: true }),
    redoModification: (args) => { redone.push(args); return { success: true }; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.invoke('deleteRows', ['users', [1]]);
  await host.invoke('triggerUndo', []);
  await host.invoke('triggerRedo', []);
  assert.equal(redone.length, 1);
  const mod = (redone[0] as unknown[])[0] as Record<string, unknown>;
  assert.deepEqual(mod.affectedRowIds, [1]);
});

test('DDL operations are barriers: undo stops at them', async () => {
  const { host } = makeHost({ addColumn: () => ({ success: true }), undoModification: () => ({ success: true }) });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.invoke('addColumn', ['users', 'extra', 'TEXT', null]);
  const result = await host.invoke('triggerUndo', []) as { performed: boolean };
  assert.equal(result.performed, false);   // barrier blocks stepping back
});

test('insertRowBatch is a barrier: undo stops at it', async () => {
  const { host } = makeHost({ insertRowBatch: () => ({ success: true }), undoModification: () => ({ success: true }) });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.invoke('insertRowBatch', ['users', [{ name: 'x' }]]);
  const result = await host.invoke('triggerUndo', []) as { performed: boolean };
  assert.equal(result.performed, false);   // no undo/redo design yet — barrier-by-default
});

// createView/editView/dropView descriptors must hold real ViewDefinition
// OBJECTS (identifier/sql/selectSql/triggers — src/core/types.ts:196), never
// the raw SELECT-body string the user typed. applyViewHistoryState's CAS
// guard (assertViewDefinitionStateCurrent, src/core/view-utils.ts:919)
// compares `expected.sql` byte-for-byte against sqlite_schema's stored
// CREATE VIEW text, so a bare string there would always fail the guard.
test('createView records the worker-returned ViewDefinition object (not the raw SQL string) for undo', async () => {
  const undone: unknown[][] = [];
  const viewDef = {
    identifier: 'v_active',
    sql: 'CREATE VIEW "v_active" AS SELECT * FROM users WHERE active = 1',
    selectSql: 'SELECT * FROM users WHERE active = 1',
    triggers: []
  };
  const { host } = makeHost({
    createView: () => viewDef,   // createView's own return IS the post-create ViewDefinition
    undoModification: (args) => { undone.push(args); return { success: true }; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.invoke('createView', ['v_active', 'SELECT * FROM users WHERE active = 1']);
  await host.invoke('triggerUndo', []);
  const mod = (undone[0] as unknown[])[0] as Record<string, unknown>;
  assert.equal(mod.modificationType, 'view_create');
  assert.deepEqual(mod.viewDefAfter, viewDef);
  assert.equal((mod.viewDefAfter as Record<string, unknown>).sql, viewDef.sql);
});

// Redo-direction coverage (fix round 3): redoModification's view_create case
// (worker.js ~line 2204) reads viewDefAfter to replay the create — must
// survive undo→redo as the real object, not be dropped or stringified.
test('createView descriptor survives undo→redo intact: ViewDefinition object (with .sql) reaches redoModification', async () => {
  const redone: unknown[][] = [];
  const viewDef = {
    identifier: 'v_active',
    sql: 'CREATE VIEW "v_active" AS SELECT * FROM users WHERE active = 1',
    selectSql: 'SELECT * FROM users WHERE active = 1',
    triggers: []
  };
  const { host } = makeHost({
    createView: () => viewDef,
    undoModification: () => ({ success: true }),
    redoModification: (args) => { redone.push(args); return { success: true }; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.invoke('createView', ['v_active', 'SELECT * FROM users WHERE active = 1']);
  await host.invoke('triggerUndo', []);
  await host.invoke('triggerRedo', []);

  assert.equal(redone.length, 1);
  const mod = (redone[0] as unknown[])[0] as Record<string, unknown>;
  assert.equal(mod.modificationType, 'view_create');
  assert.deepEqual(mod.viewDefAfter, viewDef);
  assert.equal((mod.viewDefAfter as Record<string, unknown>).sql, viewDef.sql);
});

test('editView records the worker-returned {before, after} ViewDefinition pair for undo', async () => {
  const undone: unknown[][] = [];
  const before = {
    identifier: 'v1', sql: 'CREATE VIEW "v1" AS SELECT a FROM t', selectSql: 'SELECT a FROM t', triggers: []
  };
  const after = {
    identifier: 'v1', sql: 'CREATE VIEW "v1" AS SELECT a, b FROM t', selectSql: 'SELECT a, b FROM t', triggers: []
  };
  const { host } = makeHost({
    // editView's own result is { before, after } (types.ts ViewEditResult) —
    // no separate getViewDefinition pre-fetch is registered here, which also
    // proves desktop-host.js no longer makes that call (it would throw
    // "no fake for getViewDefinition" if it still did).
    editView: () => ({ before, after }),
    undoModification: (args) => { undone.push(args); return { success: true }; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.invoke('editView', ['v1', 'SELECT a, b FROM t']);
  await host.invoke('triggerUndo', []);
  const mod = (undone[0] as unknown[])[0] as Record<string, unknown>;
  assert.equal(mod.modificationType, 'view_edit');
  assert.deepEqual(mod.viewDefBefore, before);
  assert.deepEqual(mod.viewDefAfter, after);
});

// Redo-direction coverage (fix round 3): redoModification's view_edit case
// (worker.js ~line 2211) requires BOTH viewDefBefore and viewDefAfter to
// replay the edit — must survive undo→redo as the real objects.
test('editView descriptor survives undo→redo intact: {before, after} ViewDefinitions reach redoModification', async () => {
  const redone: unknown[][] = [];
  const before = {
    identifier: 'v1', sql: 'CREATE VIEW "v1" AS SELECT a FROM t', selectSql: 'SELECT a FROM t', triggers: []
  };
  const after = {
    identifier: 'v1', sql: 'CREATE VIEW "v1" AS SELECT a, b FROM t', selectSql: 'SELECT a, b FROM t', triggers: []
  };
  const { host } = makeHost({
    editView: () => ({ before, after }),
    undoModification: () => ({ success: true }),
    redoModification: (args) => { redone.push(args); return { success: true }; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.invoke('editView', ['v1', 'SELECT a, b FROM t']);
  await host.invoke('triggerUndo', []);
  await host.invoke('triggerRedo', []);

  assert.equal(redone.length, 1);
  const mod = (redone[0] as unknown[])[0] as Record<string, unknown>;
  assert.equal(mod.modificationType, 'view_edit');
  assert.deepEqual(mod.viewDefBefore, before);
  assert.deepEqual(mod.viewDefAfter, after);
});

test('dropView records the worker-returned pre-drop ViewDefinition for undo', async () => {
  const undone: unknown[][] = [];
  const before = {
    identifier: 'v2', sql: 'CREATE VIEW "v2" AS SELECT * FROM t2', selectSql: 'SELECT * FROM t2', triggers: []
  };
  const { host } = makeHost({
    dropView: () => before,   // dropView's own return IS the pre-drop ViewDefinition
    undoModification: (args) => { undone.push(args); return { success: true }; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.invoke('dropView', ['v2']);
  await host.invoke('triggerUndo', []);
  const mod = (undone[0] as unknown[])[0] as Record<string, unknown>;
  assert.equal(mod.modificationType, 'view_drop');
  assert.deepEqual(mod.viewDefBefore, before);
});

// Redo-direction coverage (fix round 3, closing the class the re-review
// flagged as deferred): redoModification's view_drop case (worker.js ~line
// 2218) reads viewDefBefore to replay the drop — must survive undo→redo.
test('dropView descriptor survives undo→redo intact: pre-drop ViewDefinition reaches redoModification', async () => {
  const redone: unknown[][] = [];
  const before = {
    identifier: 'v2', sql: 'CREATE VIEW "v2" AS SELECT * FROM t2', selectSql: 'SELECT * FROM t2', triggers: []
  };
  const { host } = makeHost({
    dropView: () => before,
    undoModification: () => ({ success: true }),
    redoModification: (args) => { redone.push(args); return { success: true }; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.invoke('dropView', ['v2']);
  await host.invoke('triggerUndo', []);
  await host.invoke('triggerRedo', []);

  assert.equal(redone.length, 1);
  const mod = (redone[0] as unknown[])[0] as Record<string, unknown>;
  assert.equal(mod.modificationType, 'view_drop');
  assert.deepEqual(mod.viewDefBefore, before);
});

test('open → edit → saveToDisk writes exported bytes to the opened path and checkpoints', async () => {
  const bytes = new Uint8Array([9, 9, 9]);
  const { host, saved } = makeHost({ exportDatabase: () => bytes, updateCell: () => 1 });
  await host.start();
  const opened = await host.openDatabaseViaDialog();
  assert.equal(opened, true);
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);
  const ok = await host.saveToDisk();
  assert.equal(ok, true);
  assert.equal(saved.path, '/tmp/x.db');
  assert.deepEqual(saved.bytes, bytes);
  assert.equal(host.hasUnsavedChanges(), false);
});

test('openDatabaseViaDialog rejects a file over the maxFileSize cap before reading bytes', async () => {
  let readCalled = false;
  const { host } = makeHost(
    {},
    {
      pickDatabase: async () => ({ path: '/tmp/huge.db', name: 'huge.db', size: 5 * 1024 * 1024 }),
      readDatabaseBytes: async (_p: string) => { readCalled = true; return new Uint8Array([1, 2, 3]); },
      loadSettings: async () => ({ maxFileSize: 1 })   // 1 MiB cap; picked file reports 5 MiB
    }
  );
  await host.start();
  await assert.rejects(() => host.openDatabaseViaDialog(), /maxFileSize/);
  assert.equal(readCalled, false);   // guard must run before bridge.readDatabaseBytes
});

test('exportDb routes exported bytes through bridge.saveFileAs', async () => {
  let savedAs: { name?: string; len?: number } = {};
  const { host } = makeHost(
    { exportDatabase: () => new Uint8Array([1]) },
    { saveFileAs: async (name: string, b: Uint8Array) => { savedAs = { name, len: b.byteLength }; return '/tmp/e.db'; } }
  );
  await host.start();
  await host.openDatabaseViaDialog();
  await host.invoke('exportDb', ['x.db']);
  assert.equal(savedAs.name, 'x.db');
  assert.equal(savedAs.len, 1);
});

test('saveFile reports the picked filename', async () => {
  const { host } = makeHost({}, { saveFileAs: async () => '/tmp/picked-name.bin' });
  await host.start();
  const res = await host.invoke('saveFile', ['default.bin', new Uint8Array([1])]) as Record<string, unknown>;
  assert.deepEqual(res, { success: true, savedAs: 'picked-name.bin' });
});

test('refreshFile re-reads the current file from disk and reinitializes the worker', async () => {
  const { host, posted } = makeHost({});
  await host.start();
  await host.openDatabaseViaDialog();
  const before = posted.filter(p => p.content.targetMethod === 'initializeDatabase').length;
  await host.invoke('refreshFile', []);
  const after = posted.filter(p => p.content.targetMethod === 'initializeDatabase').length;
  assert.equal(after, before + 1);
});

test('exportTable assembles worker chunks and saves via bridge.saveFileAs', async () => {
  let savedAs: { name?: string; text?: string } = {};
  const { host } = makeHost(
    { exportTable: () => ({ contentChunks: ['a,b\n', '1,2\n'], filename: 'users.csv', mimeType: 'text/csv' }) },
    { saveFileAs: async (name: string, b: Uint8Array) => { savedAs = { name, text: new TextDecoder().decode(b) }; return '/tmp/u.csv'; } }
  );
  await host.start();
  await host.invoke('exportTable', [{ table: 'users' }, ['a', 'b'], null, null, { format: 'csv' }]);
  assert.equal(savedAs.name, 'users.csv');
  assert.equal(savedAs.text, 'a,b\n1,2\n');
});

test('exportTable injects the desktop export cap while preserving caller-passed options', async () => {
  let recordedArgs: unknown[] = [];
  const { host } = makeHost(
    {
      exportTable: (args: unknown[]) => {
        recordedArgs = args;
        return { contentChunks: [], filename: 'users.csv', mimeType: 'text/csv' };
      }
    },
    { saveFileAs: async () => '/tmp/u.csv' }
  );
  await host.start();
  await host.invoke(
    'exportTable',
    [{ table: 'users' }, ['a', 'b'], null, null, { format: 'csv', header: false }]
  );
  const exportOptions = recordedArgs[4] as Record<string, unknown>;
  assert.equal(exportOptions.maxExportBytes, 536870912);
  // Host policy must override, not replace: caller-passed keys still survive the spread.
  assert.equal(exportOptions.format, 'csv');
  assert.equal(exportOptions.header, false);
});

test('exportTable host cap wins over a conflicting caller-passed maxExportBytes', async () => {
  let recordedArgs: unknown[] = [];
  const { host } = makeHost(
    {
      exportTable: (args: unknown[]) => {
        recordedArgs = args;
        return { contentChunks: [], filename: 'users.csv', mimeType: 'text/csv' };
      }
    },
    { saveFileAs: async () => '/tmp/u.csv' }
  );
  await host.start();
  // No live caller passes maxExportBytes today, but if one ever did, host
  // policy must still win rather than merge under a smaller caller value.
  await host.invoke(
    'exportTable',
    [{ table: 'users' }, ['a', 'b'], null, null, { format: 'csv', maxExportBytes: 1 }]
  );
  const exportOptions = recordedArgs[4] as Record<string, unknown>;
  assert.equal(exportOptions.maxExportBytes, 536870912);
});

test('theme defaults to system and round-trips through the wire shape', async () => {
  const { host, saved } = makeHost({});
  await host.start();
  let settings = await host.invoke('getExtensionSettings', []) as Record<string, unknown>;
  assert.equal(settings.theme, 'system');
  await host.invoke('updateExtensionSetting', ['theme', 'nord']);
  assert.deepEqual(saved.settings, { theme: 'nord' });
  settings = await host.invoke('getExtensionSettings', []) as Record<string, unknown>;
  assert.equal(settings.theme, 'nord');
});

test('stored theme loads at start', async () => {
  const { host } = makeHost({}, { loadSettings: async () => ({ theme: 'solarized' }) });
  await host.start();
  const settings = await host.invoke('getExtensionSettings', []) as Record<string, unknown>;
  assert.equal(settings.theme, 'solarized');
});

test('openFromShellPath reads through the bridge and boots the database', async () => {
  const reads: string[] = [];
  const { host, posted } = makeHost({}, {
    readDatabaseBytes: async (p: string) => { reads.push(p); return new Uint8Array([1]); }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/from-finder.db');
  assert.deepEqual(reads, ['/tmp/from-finder.db']);
  assert.equal(posted.at(-1)!.content.targetMethod !== undefined, true);
  const init = await host.invoke('initialize', []);
  assert.equal((init as { filename: string }).filename, 'from-finder.db');
});

test('runConsole with mutations records a barrier and refreshes', async () => {
  const { host } = makeHost({
    runConsole: () => ({ results: [], mutated: true, changes: 2, durationMs: 1 })
  });
  await host.start();
  let refreshed = 0;
  host.setWebviewMethods({ refreshContent: async () => { refreshed++; return { success: true }; } });
  const res = await host.invoke('runConsole', ['INSERT ...', {}]) as Record<string, unknown>;
  assert.equal(res.mutated, true);
  assert.equal(host.hasUnsavedChanges(), true);
  assert.equal(refreshed, 1);
});

test('runConsole without mutations stays clean', async () => {
  const { host } = makeHost({
    runConsole: () => ({ results: [{ headers: ['1'], rows: [[1]], truncated: false }], mutated: false, changes: 0, durationMs: 1 })
  });
  await host.start();
  let refreshed = 0;
  host.setWebviewMethods({ refreshContent: async () => { refreshed++; return { success: true }; } });
  await host.invoke('runConsole', ['SELECT 1', {}]);
  assert.equal(host.hasUnsavedChanges(), false);
  assert.equal(refreshed, 0);
});

test('console history round-trips through the settings wire shape', async () => {
  const { host, saved } = makeHost({});
  await host.start();

  // Default: the console asks for its history before anything has been saved.
  const initial = await host.invoke('getExtensionSettings', []) as Record<string, unknown>;
  assert.deepEqual(initial.consoleHistory, []);

  await host.invoke('updateExtensionSetting', ['consoleHistory', ['SELECT 2', 'SELECT 1']]);
  const after = await host.invoke('getExtensionSettings', []) as Record<string, unknown>;
  assert.deepEqual(after.consoleHistory, ['SELECT 2', 'SELECT 1']);

  // The delta-persist compares against DEFAULT_SETTINGS by reference, so any
  // saved array always lands in the file — including an empty one.
  assert.deepEqual(saved.settings, { consoleHistory: ['SELECT 2', 'SELECT 1'] });
  await host.invoke('updateExtensionSetting', ['consoleHistory', []]);
  assert.deepEqual(saved.settings, { consoleHistory: [] });
});

test('stored console history loads at start', async () => {
  const { host } = makeHost({}, { loadSettings: async () => ({ consoleHistory: ['SELECT 1'] }) });
  await host.start();
  const settings = await host.invoke('getExtensionSettings', []) as Record<string, unknown>;
  assert.deepEqual(settings.consoleHistory, ['SELECT 1']);
});

test('a console script that failed after mutating still records a barrier and refreshes', async () => {
  // runConsole RESOLVES with {error, mutated} once execution has begun (see the
  // worker). The host must key off the resolved `mutated`, not off whether the
  // call threw — otherwise the writes a half-applied script made are never
  // recorded, never mark the file dirty, and are never auto-committed.
  const { host } = makeHost({
    runConsole: () => ({
      results: [],
      error: 'statement 2: no such table: nope',
      multiStatement: true,
      mutated: true,
      changes: 1,
      durationMs: 3
    })
  });
  await host.start();
  let refreshed = 0;
  host.setWebviewMethods({ refreshContent: async () => { refreshed++; return { success: true }; } });

  const res = await host.invoke('runConsole', ['INSERT ...; SELECT * FROM nope;', {}]) as Record<string, unknown>;

  assert.equal(res.error, 'statement 2: no such table: nope');
  assert.equal(host.hasUnsavedChanges(), true);
  assert.equal(refreshed, 1);
});

test('a console script that failed without mutating leaves the document clean', async () => {
  const { host } = makeHost({
    runConsole: () => ({
      results: [], error: 'statement 1: no such table: nope',
      multiStatement: false, mutated: false, changes: 0, durationMs: 1
    })
  });
  await host.start();
  let refreshed = 0;
  host.setWebviewMethods({ refreshContent: async () => { refreshed++; return { success: true }; } });

  await host.invoke('runConsole', ['SELECT * FROM nope', {}]);

  assert.equal(host.hasUnsavedChanges(), false);
  assert.equal(refreshed, 0);
});

// ============================================================================
// Native engine — selection, transport seam, session-transaction save model
// ============================================================================
//
// The fakes below stand in for Task 5's bridge surface: nativeOpen returns a
// CANONICALIZED path (deliberately different from the input spelling — the
// shell canonicalises; layer 3 and the sidecar compare exact strings, so the
// host must carry the RETURNED value into initializeDatabase), and nativeRpc
// is a scripted transport that records every decoded envelope it was sent and
// answers with canned response envelopes, exactly the JSON the Rust proxy
// hands back verbatim.

const CANONICAL_PREFIX = '/private';

type NativeLog = {
  opens: Array<{ path: string; readOnly: boolean }>;
  closes: number;
  envelopes: Envelope[];
};

function makeNativeBridgeMembers(
  handlers: Record<string, (args: unknown[]) => unknown>,
  opts: { available?: boolean; openError?: string } = {}
) {
  const log: NativeLog = { opens: [], closes: 0, envelopes: [] };
  const members = {
    nativeAvailable: async () => opts.available ?? true,
    nativeOpen: async (path: string, readOnly: boolean) => {
      log.opens.push({ path, readOnly });
      if (opts.openError) throw new Error(opts.openError);
      return CANONICAL_PREFIX + path;
    },
    nativeRpc: async (envelopeJson: string) => {
      const envelope = JSON.parse(envelopeJson) as Envelope;
      log.envelopes.push(envelope);
      const { messageId, targetMethod, payload } = envelope.content;
      const handler = handlers[targetMethod];
      const respond = (success: boolean, data: unknown, errorMessage?: string) =>
        JSON.stringify({ channel: 'rpc', content: { kind: 'response', messageId, success, data, errorMessage } });
      if (!handler) return respond(false, undefined, `no native fake for ${targetMethod}`);
      try {
        return respond(true, handler(payload));
      } catch (error) {
        return respond(false, undefined, error instanceof Error ? error.message : String(error));
      }
    },
    nativeClose: async () => { log.closes += 1; }
  };
  return { members, log };
}

function makeNativeHost(
  nativeHandlers: Record<string, (args: unknown[]) => unknown> = {},
  workerHandlers: Record<string, (args: unknown[]) => unknown> = {},
  bridgeOverrides: Record<string, unknown> = {},
  nativeOpts: { available?: boolean; openError?: string } = {}
) {
  const { members, log } = makeNativeBridgeMembers({
    initializeDatabase: () => ({ isReadOnly: false, storage: 'memory' }),
    runQuery: () => [],
    ping: () => true,
    ...nativeHandlers
  }, nativeOpts);
  const made = makeHost(workerHandlers, { ...members, ...bridgeOverrides });
  return { ...made, nativeLog: log };
}

/** targetMethods of everything sent over the native transport, in order. */
const nativeMethods = (log: NativeLog) => log.envelopes.map(e => e.content.targetMethod);
/** First-arg SQL of every runQuery envelope, in order (the txn-control trace). */
const nativeSql = (log: NativeLog) =>
  log.envelopes.filter(e => e.content.targetMethod === 'runQuery').map(e => e.content.payload[0]);

test('native selection: open routes through nativeOpen and initializeDatabase carries the RETURNED canonical path', async () => {
  const initConfigs: unknown[] = [];
  const { host, nativeLog, posted } = makeNativeHost({
    initializeDatabase: (args) => { initConfigs.push(args); return { isReadOnly: false, storage: 'memory' }; },
    fetchSchema: () => ({ tables: [], views: [], indexes: [] })
  });
  await host.start();
  const postedAfterStart = posted.length;
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });

  const opened = await host.openFromShellPath('/tmp/from-finder.db');
  assert.equal(opened, true);
  assert.deepEqual(nativeLog.opens, [{ path: '/tmp/from-finder.db', readOnly: false }]);
  // The canonical returned string, not the input spelling.
  const [name, config] = initConfigs[0] as [string, Record<string, unknown>];
  assert.equal(name, 'from-finder.db');
  assert.equal(config.path, '/private/tmp/from-finder.db');
  assert.equal(config.readOnlyMode, false);
  assert.equal(config.content, undefined);

  // Subsequent RPCs ride the native transport, not the WASM worker.
  await host.invoke('fetchSchema', []);
  assert.equal(nativeMethods(nativeLog).includes('fetchSchema'), true);
  assert.equal(posted.length, postedAfterStart);   // nothing further to the worker

  const init = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(init.engine, 'native');
});

test('nativeOpen failure falls back to the WASM bytes path with engine wasm', async () => {
  const reads: string[] = [];
  const { host, nativeLog, posted } = makeNativeHost({}, {}, {
    readDatabaseBytes: async (p: string) => { reads.push(p); return new Uint8Array([1, 2, 3]); }
  }, { openError: 'ERR_NATIVE_PATH_NOT_ALLOWED: nope' });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });

  const opened = await host.openFromShellPath('/tmp/x.db');
  assert.equal(opened, true);
  assert.deepEqual(reads, ['/tmp/x.db']);
  assert.equal(nativeLog.envelopes.length, 0);          // nothing spoke native
  assert.equal(nativeLog.closes, 0);                    // no sidecar existed to close
  const lastInit = posted.filter(p => p.content.targetMethod === 'initializeDatabase').at(-1)!;
  assert.deepEqual((lastInit.content.payload[1] as Record<string, unknown>).content, new Uint8Array([1, 2, 3]));
  const init = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(init.engine, 'wasm');
});

test('native initializeDatabase refusal closes the sidecar and falls back to WASM', async () => {
  const { host, nativeLog } = makeNativeHost({
    initializeDatabase: () => { throw new Error('ERR_NATIVE_PATH_MISMATCH: refused'); }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  const opened = await host.openFromShellPath('/tmp/x.db');
  assert.equal(opened, true);
  assert.equal(nativeLog.closes, 1);                    // never leave a half-open sidecar
  const init = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(init.engine, 'wasm');
});

test('nativeAvailable=false goes straight to WASM without attempting nativeOpen', async () => {
  const { host, nativeLog } = makeNativeHost({}, {}, {}, { available: false });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/x.db');
  assert.equal(nativeLog.opens.length, 0);
  const init = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(init.engine, 'wasm');
});

test('opening a database over the WASM path closes a live native session first', async () => {
  let failNextOpen = false;
  const { members, log } = makeNativeBridgeMembers({
    initializeDatabase: () => ({ isReadOnly: false, storage: 'memory' }),
    runQuery: () => [],
    ping: () => true
  });
  const realOpen = members.nativeOpen;
  members.nativeOpen = async (path: string, readOnly: boolean) => {
    if (failNextOpen) { log.opens.push({ path, readOnly }); throw new Error('spawn failed'); }
    return realOpen(path, readOnly);
  };
  const { host } = makeHost({}, { ...members });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });

  await host.openFromShellPath('/tmp/first.db');        // native session live
  failNextOpen = true;
  await host.openFromShellPath('/tmp/second.db');       // falls back to WASM
  assert.equal(log.closes, 1);                          // first sidecar shut down on the switch
  const init = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(init.engine, 'wasm');
});

test('dialog opens skip the maxFileSize cap on the native engine but enforce it on the WASM fallback', async () => {
  let readCalled = false;
  const { host } = makeNativeHost({}, {}, {
    pickDatabase: async () => ({ path: '/tmp/huge.db', name: 'huge.db', size: 5 * 1024 * 1024 }),
    readDatabaseBytes: async () => { readCalled = true; return new Uint8Array([1]); },
    loadSettings: async () => ({ maxFileSize: 1 })
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  const opened = await host.openDatabaseViaDialog();    // native: no byte inhaling, no cap
  assert.equal(opened, true);
  assert.equal(readCalled, false);

  const { host: wasmHost } = makeNativeHost({}, {}, {
    pickDatabase: async () => ({ path: '/tmp/huge.db', name: 'huge.db', size: 5 * 1024 * 1024 }),
    readDatabaseBytes: async () => { readCalled = true; return new Uint8Array([1]); },
    loadSettings: async () => ({ maxFileSize: 1 })
  }, { available: false });
  await wasmHost.start();
  await assert.rejects(() => wasmHost.openDatabaseViaDialog(), /maxFileSize/);
  assert.equal(readCalled, false);                      // guard fires before the read
});

test('native txn model: first mutation BEGINs once, save COMMITs without exporting, next mutation BEGINs afresh', async () => {
  const { host, nativeLog, saved } = makeNativeHost({ updateCell: () => 1 });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');

  await host.invoke('updateCell', ['t', 1, 'c', 'v1', 'o1', 1048576]);
  await host.invoke('updateCell', ['t', 1, 'c', 'v2', 'v1', 1048576]);
  assert.deepEqual(nativeSql(nativeLog), ['BEGIN']);    // exactly one BEGIN for two mutations
  assert.equal(host.hasUnsavedChanges(), true);

  const ok = await host.saveToDisk();
  assert.equal(ok, true);
  assert.deepEqual(nativeSql(nativeLog), ['BEGIN', 'COMMIT']);
  assert.equal(nativeMethods(nativeLog).includes('exportDatabase'), false);  // no byte export
  assert.equal(saved.path, undefined);                  // and no bridge.saveDatabase file rewrite
  assert.equal(host.hasUnsavedChanges(), false);

  await host.invoke('updateCell', ['t', 1, 'c', 'v3', 'v2', 1048576]);
  assert.deepEqual(nativeSql(nativeLog), ['BEGIN', 'COMMIT', 'BEGIN']);
});

test('native refresh with an open transaction ROLLBACKs then reopens the bound path in place', async () => {
  const initConfigs: unknown[] = [];
  let reads = 0;
  const { host, nativeLog } = makeNativeHost({
    updateCell: () => 1,
    initializeDatabase: (args) => { initConfigs.push(args); return { isReadOnly: false, storage: 'memory' }; }
  }, {}, { readDatabaseBytes: async () => { reads += 1; return new Uint8Array([1]); } });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);

  await host.refreshFromDisk();
  assert.deepEqual(nativeSql(nativeLog), ['BEGIN', 'ROLLBACK']);
  assert.equal(initConfigs.length, 2);                  // open + refresh reopen
  const [, refreshConfig] = initConfigs[1] as [string, Record<string, unknown>];
  assert.equal(refreshConfig.path, '/private/tmp/y.db');
  assert.equal(reads, 0);                               // refresh never rides the bytes path
  assert.equal(host.hasUnsavedChanges(), false);
});

test("instantCommit='always' on native commits each mutation immediately", async () => {
  const { host, nativeLog } = makeNativeHost(
    { updateCell: () => 1 },
    {},
    { loadSettings: async () => ({ instantCommit: 'always' }) }
  );
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v1', 'o1', 1048576]);
  assert.deepEqual(nativeSql(nativeLog), ['BEGIN', 'COMMIT']);
  await host.invoke('updateCell', ['t', 1, 'c', 'v2', 'v1', 1048576]);
  assert.deepEqual(nativeSql(nativeLog), ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
  assert.equal(host.hasUnsavedChanges(), false);
});

test('undo/redo replay through the native engine inside the open session transaction', async () => {
  const { host, nativeLog } = makeNativeHost({
    updateCell: () => 1,
    undoModification: () => ({ success: true }),
    redoModification: () => ({ success: true })
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);

  await host.invoke('triggerUndo', []);
  await host.invoke('triggerRedo', []);
  // Replay rides the SAME transaction: no extra BEGIN, and both replay
  // envelopes went over the native transport.
  assert.deepEqual(nativeSql(nativeLog), ['BEGIN']);
  assert.equal(nativeMethods(nativeLog).includes('undoModification'), true);
  assert.equal(nativeMethods(nativeLog).includes('redoModification'), true);
});

test('undo after a save opens a fresh transaction before replaying', async () => {
  const { host, nativeLog } = makeNativeHost({
    updateCell: () => 1,
    undoModification: () => ({ success: true })
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);
  await host.saveToDisk();
  await host.invoke('triggerUndo', []);
  assert.deepEqual(nativeSql(nativeLog), ['BEGIN', 'COMMIT', 'BEGIN']);
  const undoIndex = nativeMethods(nativeLog).lastIndexOf('undoModification');
  const beginIndex = nativeMethods(nativeLog).lastIndexOf('runQuery');
  assert.equal(beginIndex < undoIndex, true);           // BEGIN precedes the replay
});

test('a read-only console run closes the transaction it opened; a mutating run leaves it pending', async () => {
  const { host, nativeLog } = makeNativeHost({
    runConsole: (args) => (String(args[0]).startsWith('SELECT')
      ? { results: [{ headers: ['1'], rows: [[1]], truncated: false }], mutated: false, changes: 0, durationMs: 1 }
      : { results: [], mutated: true, changes: 1, durationMs: 1 }),
    updateCell: () => 1
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');

  await host.invoke('runConsole', ['SELECT 1', {}]);
  // BEGIN then COMMIT: a pure read must not leave a transaction (and its
  // SHARED lock on the real file) dangling until save.
  assert.deepEqual(nativeSql(nativeLog), ['BEGIN', 'COMMIT']);
  assert.equal(host.hasUnsavedChanges(), false);

  await host.invoke('runConsole', ['INSERT INTO t DEFAULT VALUES', {}]);
  assert.deepEqual(nativeSql(nativeLog), ['BEGIN', 'COMMIT', 'BEGIN']);
  assert.equal(host.hasUnsavedChanges(), true);

  await host.invoke('runConsole', ['SELECT 2', {}]);    // txn was already open: not this run's to close
  assert.deepEqual(nativeSql(nativeLog), ['BEGIN', 'COMMIT', 'BEGIN']);
});

test('BEGIN tolerance: a console-opened transaction is adopted instead of failing the mutation', async () => {
  const { host, nativeLog } = makeNativeHost({
    runQuery: (args) => {
      if (args[0] === 'BEGIN') throw new Error('cannot start a transaction within a transaction');
      return [];
    },
    updateCell: () => 1
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);   // must not reject
  await host.saveToDisk();
  assert.deepEqual(nativeSql(nativeLog), ['BEGIN', 'COMMIT']);         // adopted, then committed
});

test('COMMIT tolerance: a console-committed transaction still saves cleanly', async () => {
  const { host } = makeNativeHost({
    runQuery: (args) => {
      if (args[0] === 'COMMIT') throw new Error('cannot commit - no transaction is active');
      return [];
    },
    updateCell: () => 1
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);
  const ok = await host.saveToDisk();
  assert.equal(ok, true);
  assert.equal(host.hasUnsavedChanges(), false);
});

test('a genuine BEGIN failure fails the mutation before it executes', async () => {
  const { host, nativeLog } = makeNativeHost({
    runQuery: (args) => {
      if (args[0] === 'BEGIN') throw new Error('database is locked');
      return [];
    },
    updateCell: () => 1
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await assert.rejects(() => host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]), /database is locked/);
  assert.equal(nativeMethods(nativeLog).includes('updateCell'), false);
  assert.equal(host.hasUnsavedChanges(), false);
});

test('native exportDb with an open transaction prompts to save first; cancel aborts, accept commits then exports', async () => {
  const exportCalls: unknown[] = [];
  const { host, nativeLog } = makeNativeHost(
    {
      updateCell: () => 1,
      exportDatabase: () => { exportCalls.push(1); return { __type: 'Uint8Array', base64: 'AQ==' }; }
    },
    {},
    { saveFileAs: async () => '/tmp/out.db' }
  );
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);

  const originalConfirm = (globalThis as { confirm?: unknown }).confirm;
  try {
    (globalThis as { confirm?: unknown }).confirm = () => false;
    const refused = await host.invoke('exportDb', ['y.db']) as Record<string, unknown>;
    assert.equal(refused.success, false);
    assert.equal(exportCalls.length, 0);                // nothing exported on cancel

    (globalThis as { confirm?: unknown }).confirm = () => true;
    const okResult = await host.invoke('exportDb', ['y.db']) as Record<string, unknown>;
    assert.equal(okResult.success, true);
    assert.equal(exportCalls.length, 1);
    // The COMMIT (the save) must precede the export envelope.
    const methods = nativeMethods(nativeLog);
    assert.equal(nativeSql(nativeLog).includes('COMMIT'), true);
    assert.equal(methods.lastIndexOf('runQuery') < methods.lastIndexOf('exportDatabase'), true);
    assert.equal(host.hasUnsavedChanges(), false);
  } finally {
    if (originalConfirm === undefined) delete (globalThis as { confirm?: unknown }).confirm;
    else (globalThis as { confirm?: unknown }).confirm = originalConfirm;
  }
});

test('native exportDb decodes the sidecar Uint8Array marker back into real bytes', async () => {
  let savedBytes: Uint8Array | null = null;
  const { host } = makeNativeHost(
    { exportDatabase: () => ({ __type: 'Uint8Array', base64: 'AQID' }) },   // [1,2,3]
    {},
    { saveFileAs: async (_n: string, b: Uint8Array) => { savedBytes = b; return '/tmp/out.db'; } }
  );
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('exportDb', ['y.db']);
  assert.deepEqual(savedBytes, new Uint8Array([1, 2, 3]));
});

test('native exportDb is refused while a cell read session is open (dispatch-guard parity)', async () => {
  const { host } = makeNativeHost(
    {
      openCellReadSession: () => ({ sessionId: 's1', byteLength: 10, storageClass: 'blob' }),
      closeCellReadSession: () => ({ success: true }),
      exportDatabase: () => ({ __type: 'Uint8Array', base64: 'AQ==' })
    },
    {},
    { saveFileAs: async () => '/tmp/out.db' }
  );
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('openCellReadSession', [{ table: 't', rowId: 1, column: 'c' }]);
  await assert.rejects(() => host.invoke('exportDb', ['y.db']), /cell read snapshot is active/);
  await host.invoke('closeCellReadSession', ['s1']);
  const ok = await host.invoke('exportDb', ['y.db']) as Record<string, unknown>;
  assert.equal(ok.success, true);
});

test('initialize and refreshContent surface the active engine for the badge', async () => {
  const engines: unknown[] = [];
  const { host } = makeNativeHost({});
  host.setWebviewMethods({
    refreshContent: async (_f: unknown, result: unknown) => {
      engines.push((result as Record<string, unknown>).engine);
      return { success: true };
    }
  });
  await host.start();
  const boot = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(boot.engine, 'wasm');                    // the empty startup DB is WASM
  await host.openFromShellPath('/tmp/y.db');
  assert.deepEqual(engines, ['native']);
  const init = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(init.engine, 'native');
});

test('a WASM-only bridge (no native members) reports engine wasm end to end', async () => {
  const { host } = makeHost({});
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/x.db');
  const init = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(init.engine, 'wasm');
});

test('setPragma on native does not open the session transaction (pragmas are untransactable)', async () => {
  const { host, nativeLog } = makeNativeHost({ setPragma: () => undefined });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('setPragma', ['journal_mode', 'wal']);
  assert.deepEqual(nativeSql(nativeLog), []);           // no BEGIN wrapped around it
  assert.equal(host.hasUnsavedChanges(), true);         // still a history barrier
});

test('native transport errors reject the pending call with the structured reason', async () => {
  const { members } = makeNativeBridgeMembers({
    initializeDatabase: () => ({ isReadOnly: false, storage: 'memory' }),
    ping: () => true
  });
  const { host } = makeHost({}, {
    ...members,
    nativeRpc: async (json: string) => {
      const envelope = JSON.parse(json) as Envelope;
      if (envelope.content.targetMethod === 'fetchSchema') {
        throw new Error('ERR_NATIVE_SIDECAR_EXITED: exited with code 1');
      }
      return JSON.stringify({ channel: 'rpc', content: {
        kind: 'response', messageId: envelope.content.messageId, success: true,
        data: { isReadOnly: false, storage: 'memory' }
      } });
    }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await assert.rejects(() => host.invoke('fetchSchema', []), /ERR_NATIVE_SIDECAR_EXITED/);
});

test('outbound native envelopes are frame-codec encoded: Uint8Array args become base64 markers', async () => {
  let rawJson = '';
  const { members } = makeNativeBridgeMembers({
    initializeDatabase: () => ({ isReadOnly: false, storage: 'memory' }),
    runQuery: () => [],
    ping: () => true
  });
  const innerRpc = members.nativeRpc;
  members.nativeRpc = async (json: string) => {
    const envelope = JSON.parse(json) as Envelope;
    if (envelope.content.targetMethod === 'updateCell') rawJson = json;
    return innerRpc(json);
  };
  const { host } = makeHost({}, {
    ...members,
    nativeRpc: members.nativeRpc
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');

  // A blob write: the bytes must cross as the codec's exact-two-key marker,
  // which is what the sidecar's reader decodes back into a Uint8Array.
  await host.invoke('updateCell', ['t', 1, 'c', new Uint8Array([7, 8]), null, 1048576])
    .catch(() => { /* no updateCell fake — the send is what matters */ });
  const parsed = JSON.parse(rawJson) as { content: { payload: unknown[] } };
  assert.deepEqual(parsed.content.payload[3], { __type: 'Uint8Array', base64: 'Bwg=' });
});
