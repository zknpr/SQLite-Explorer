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
  assert.deepEqual(init, { connected: true, isReadOnly: false, filename: 'untitled.db' });
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
