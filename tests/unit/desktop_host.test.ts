import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopHost, MAX_OPEN_DATABASES } from '../../core/ui/modules/desktop-host.js';

// Untyped UI modules: resolved through a path variable inside a hook, so tsc
// does not demand declaration files for them — the same convention the other
// webview-module tests use (crud_identity, grid_render, …). These are the very
// modules desktop-host.js already pulled in above, so the bindings below are
// the same live instances the host mutates.
const stateModulePath = '../../core/ui/modules/state.js';
const dbUiStateModulePath = '../../core/ui/modules/db-ui-state.js';
/** The live viewer state singleton the desktop host swaps per database. */
let state: Record<string, any>;
let PER_DB_STATE_FIELDS: readonly string[];
let TRANSIENT_STATE_FIELDS: readonly string[];
let GLOBAL_STATE_FIELDS: readonly string[];

before(async () => {
  ({ state } = await import(stateModulePath));
  ({ PER_DB_STATE_FIELDS, TRANSIENT_STATE_FIELDS, GLOBAL_STATE_FIELDS } = await import(dbUiStateModulePath));
});

/**
 * Handler sentinel: the fake worker sends NO response at all, leaving the call
 * in flight. Needed by the cross-database settle/fanout tests, which have to
 * hold a pending entry open while another database's transport misbehaves.
 */
const NO_REPLY = Symbol('no reply');

type Envelope = {
  channel: string;
  content: { kind: string; messageId: string; targetMethod: string; payload: unknown[] };
};

/**
 * One fake sql.js worker. Each open WASM database gets its OWN instance (the
 * registry boots a Worker per database), so `posted` is shared by the whole
 * host: it stays the flat, ordered trace of every envelope the host sent to
 * any of its workers, which is what the assertions below read.
 *
 * `terminate()` really stops it answering — a terminated worker that kept
 * replying would hide a closed database still serving.
 */
function makeFakeWorker(handlers: Record<string, (args: unknown[]) => unknown>, posted: Envelope[]) {
  const worker = {
    terminated: false,
    onmessage: null as null | ((ev: { data: unknown }) => void),
    onerror: null as null | ((err: unknown) => void),
    postMessage(msg: Envelope) {
      posted.push(msg);
      const { messageId, targetMethod, payload } = msg.content;
      queueMicrotask(() => {
        if (worker.terminated) return;
        try {
          const handler = handlers[targetMethod];
          if (!handler) throw new Error(`no fake for ${targetMethod}`);
          const data = handler(payload);
          if (data === NO_REPLY) return;   // stays in flight on purpose
          worker.onmessage?.({ data: { channel: 'rpc', content: { kind: 'response', messageId, success: true, data } } });
        } catch (error) {
          worker.onmessage?.({ data: { channel: 'rpc', content: {
            kind: 'response', messageId, success: false,
            errorMessage: error instanceof Error ? error.message : String(error)
          } } });
        }
      });
    },
    terminate() { worker.terminated = true; }
  };
  return worker;
}

type FakeWorker = ReturnType<typeof makeFakeWorker>;

function makeFakeBridge(overrides: Record<string, unknown> = {}) {
  const saved: {
    path?: string; bytes?: Uint8Array; settings?: unknown;
    /** Save As destination, recorded separately from the in-place `path`. */
    savedAsPath?: string;
  } = {};
  return {
    saved,
    bridge: {
      pickDatabase: async () => ({ path: '/tmp/x.db', name: 'x.db', size: 3 }),
      readDatabaseBytes: async (_p: string) => new Uint8Array([1, 2, 3]),
      saveDatabase: async (path: string, bytes: Uint8Array) => { saved.path = path; saved.bytes = bytes; },
      saveFileAs: async (_n: string, _b: Uint8Array) => '/tmp/out',
      // Save As: the shell's dialog + allowlist grant. Separate recorder from
      // `saveDatabase` so a test can tell an in-place save over the database's
      // own file from a save to a newly picked one.
      saveDatabaseAs: async (_n: string, _b: Uint8Array) => { saved.savedAsPath = '/tmp/as.db'; return '/tmp/as.db'; },
      loadSettings: async () => ({}),
      saveSettings: async (s: unknown) => { saved.settings = s; },
      onMenu: (_h: (id: string) => void) => {},
      setTitle: async (_t: string) => {},
      ...overrides
    }
  };
}

/**
 * The host never sends `updateCell` or `insertRow` as themselves: single-cell
 * edits ride `updateCellBatch` and inserts ride `insertRowWithHistory`, the
 * two methods that answer with the exact stored states the worker's replay
 * requires. A fake written for the direct call answers the routed one on its
 * behalf, with the states a real worker would have captured, so a test can
 * keep describing the edit it makes rather than the wire it produces.
 */
function withHistoryRoutes<T extends Record<string, (args: any[], ...rest: any[]) => unknown>>(handlers: T): T {
  const routed: Record<string, (args: any[], ...rest: any[]) => unknown> = { ...handlers };
  if (!routed.updateCellBatch && routed.updateCell) {
    routed.updateCellBatch = (args, ...rest) => {
      const [table, updates] = args as [string, Array<Record<string, unknown>>];
      return updates.map(update => {
        const newRowId = routed.updateCell(
          [table, update.rowId, update.column, update.value, update.originalValue], ...rest
        );
        return {
          rowId: update.rowId,
          newRowId: newRowId ?? update.rowId,
          columnName: update.column,
          priorValue: update.originalValue,
          newValue: update.value,
          operation: 'set',
          priorState: { storageClass: 'text', value: update.originalValue },
          postState: { storageClass: 'text', value: update.value }
        };
      });
    };
  }
  if (!routed.insertRowWithHistory && routed.insertRow) {
    routed.insertRowWithHistory = (args, ...rest) => {
      const [table, data] = args as [string, Record<string, unknown>];
      const rowId = routed.insertRow([table, data], ...rest);
      return {
        rowId,
        row: { ...data },
        storageClasses: Object.keys(data).map(column => ({ column, storageClass: 'text' }))
      };
    };
  }
  return routed as T;
}

function makeHost(handlers: Record<string, (args: unknown[]) => unknown>, bridgeOverrides = {}) {
  const workerHandlers = withHistoryRoutes({
    initializeDatabase: () => ({ isReadOnly: false, storage: 'memory' }),
    ping: () => true,
    ...handlers
  });
  const posted: Envelope[] = [];
  const workers: FakeWorker[] = [];
  const { bridge, saved } = makeFakeBridge(bridgeOverrides);
  const host = createDesktopHost({
    bridge,
    createWorker: () => {
      const worker = makeFakeWorker(workerHandlers, posted);
      workers.push(worker);
      return worker as unknown as Worker;
    }
  });
  // `workers` grows as databases are opened; the last one is the newest WASM
  // database's. Tests that need "the worker serving the active database" take
  // it after the open they care about.
  return { host, posted, saved, bridge, workers };
}

test('start boots an empty database and initialize reports connected', async () => {
  const { host, posted } = makeHost({});
  await host.start();
  assert.equal(posted[0].content.targetMethod, 'initializeDatabase');
  const init = await host.invoke('initialize', []);
  // `engine` drives the desktop status-bar badge; the empty startup DB is WASM.
  // `connectionGeneration` is what the page's async intents capture: 1 after
  // the boot open, and it advances only on a real (re)open.
  assert.deepEqual(init, {
    connected: true, isReadOnly: false, filename: 'untitled.db', engine: 'wasm', connectionGeneration: 1
  });
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
  // defaultPageSize/maxInlineCellBytes/sidebarWidth were declared in
  // DEFAULT_SETTINGS and delivered to nobody, which is exactly why all three
  // read as inert settings; they are part of the wire shape now.
  // cellEditBehaviorOptions/autoCommitSupported are the 1.7.2 keys the
  // settings panel builds its controls from: no VS Code editor tab here, and
  // auto-commit is real (unlike the web demo).
  assert.deepEqual(settings, {
    autoCommit: true,
    cellEditBehavior: 'modal',
    fileOperations: 'native',
    cellEditBehaviorOptions: ['inline', 'modal'],
    autoCommitSupported: true,
    theme: 'system',
    defaultPageSize: 5000,
    maxInlineCellBytes: 1048576,
    sidebarWidth: 0,
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
  // A single-cell edit rides updateCellBatch (the host never sends updateCell
  // itself), so the record is the batch shape: one affected cell carrying the
  // worker's exact prior/post states, which the replay refuses to run without.
  const cells = mod.affectedCells as Array<Record<string, unknown>>;
  assert.equal(cells.length, 1);
  assert.equal(cells[0].rowId, 7);
  assert.equal(cells[0].columnName, 'name');
  assert.equal(cells[0].priorValue, 'Alice');
  assert.equal(cells[0].newValue, 'Alice2');
  assert.deepEqual(cells[0].priorState, { storageClass: 'text', value: 'Alice' });
  assert.deepEqual(cells[0].postState, { storageClass: 'text', value: 'Alice2' });
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

test('insertRow rides insertRowWithHistory and records the exact inserted image for undo and redo', async () => {
  const undone: unknown[][] = [];
  const redone: unknown[][] = [];
  const { host, posted } = makeHost({
    insertRow: () => 42,   // the direct call's answer; the routed fake wraps it in the post-image
    undoModification: (args) => { undone.push(args); return { success: true }; },
    redoModification: (args) => { redone.push(args); return { success: true }; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });

  assert.equal(await host.invoke('insertRow', ['users', { name: 'Bob' }]), 42);
  assert.equal(host.hasUnsavedChanges(), true);
  // The wire carries the history-capturing method, with the undo memory
  // budget the worker enforces before releasing the insert.
  const sent = posted.at(-1)!.content;
  assert.equal(sent.targetMethod, 'insertRowWithHistory');
  assert.equal(sent.payload[0], 'users');
  assert.deepEqual(sent.payload[1], { name: 'Bob' });
  assert.ok(Number.isSafeInteger(sent.payload[3]) && (sent.payload[3] as number) > 0);

  await host.invoke('triggerUndo', []);
  const undoMod = (undone[0] as unknown[])[0] as Record<string, unknown>;
  assert.equal(undoMod.modificationType, 'row_insert');
  assert.equal(undoMod.targetTable, 'users');
  assert.equal(undoMod.targetRowId, 42);
  assert.deepEqual(undoMod.rowData, { name: 'Bob' });
  // The worker's replay deletes by exact state: it refuses an entry without
  // the post-image (LegacyRowHistoryError), so the record must carry it.
  assert.deepEqual(undoMod.insertedRow, {
    rowId: 42, row: { name: 'Bob' }, storageClasses: [{ column: 'name', storageClass: 'text' }]
  });

  await host.invoke('triggerRedo', []);
  assert.equal(redone.length, 1);
  const redoMod = (redone[0] as unknown[])[0] as Record<string, unknown>;
  assert.equal(redoMod.modificationType, 'row_insert');
  assert.deepEqual((redoMod.insertedRow as Record<string, unknown>).row, { name: 'Bob' });
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

// redoModification's row_delete case re-deletes by matching the exact
// `deletedRows` images (the 1.7.2 replay), so the same recorded entry must
// reach it intact after an undo.
test('deleteRows keeps its exact images through undo→redo so triggerRedo can re-delete', async () => {
  const redone: unknown[][] = [];
  const deleted = [{ rowId: 1, row: { name: 'Alice' }, storageClasses: [{ column: 'name', storageClass: 'text' }] }];
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
  assert.deepEqual(mod.deletedRows, deleted);
  assert.equal('affectedRowIds' in mod, false);
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
  assert.equal(ok.success, true);
  assert.equal(saved.path, '/tmp/x.db');
  assert.deepEqual(saved.bytes, bytes);
  assert.equal(host.hasUnsavedChanges(), false);
});

// The maxFileSize bound is the SHELL's to enforce (read_database_bytes refuses
// before it allocates, native_open before it spawns): the host's job is to
// hand the configured bound to both lanes and surface the refusal sentence.
const SIZE_REFUSAL = "ERR_FILE_TOO_LARGE: File size (5.00 MB) exceeds the maximum allowed size (1.00 MB). "
  + "Configure 'maxFileSize' in settings.json (0 = unlimited) to increase the limit.";
const SIZE_SENTENCE = SIZE_REFUSAL.slice('ERR_FILE_TOO_LARGE: '.length);

test('openDatabaseViaDialog hands the configured maxFileSize to the shell read and surfaces its refusal without the code', async () => {
  const reads: unknown[][] = [];
  const { host } = makeHost(
    {},
    {
      pickDatabase: async () => ({ path: '/tmp/huge.db', name: 'huge.db', size: 5 * 1024 * 1024 }),
      readDatabaseBytes: async (...args: unknown[]) => { reads.push(args); throw new Error(SIZE_REFUSAL); },
      loadSettings: async () => ({ maxFileSize: 1 })   // 1 MiB cap
    }
  );
  await host.start();
  await assert.rejects(() => host.openDatabaseViaDialog(), (error: Error & { code?: string }) => {
    assert.equal(error.message, SIZE_SENTENCE);
    assert.equal(error.code, 'ERR_FILE_TOO_LARGE');
    return true;
  });
  assert.deepEqual(reads, [['/tmp/huge.db', 1024 * 1024]]);     // the bound in bytes rides the read
  assert.deepEqual(host.listDatabases().map(d => d.name), ['untitled.db']);   // nothing was registered
});

test('maxFileSize is sanitized before it reaches the shell: 0 = unlimited, non-numbers and negatives fall back to the default, the ceiling is 4000 MiB', async () => {
  const MIB = 1024 * 1024;
  for (const [configured, expected] of [
    [undefined, 4000 * MIB],
    [0, 0],
    [1, MIB],
    [99999, 4000 * MIB],
    ['abc', 4000 * MIB],
    [-5, 4000 * MIB],
    [Number.NaN, 4000 * MIB]
  ] as Array<[unknown, number]>) {
    const bounds: unknown[] = [];
    const { host } = makeHost({}, {
      readDatabaseBytes: async (_p: string, maxBytes: unknown) => { bounds.push(maxBytes); return new Uint8Array([1]); },
      loadSettings: async () => (configured === undefined ? {} : { maxFileSize: configured })
    });
    await host.start();
    host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
    await host.openFromShellPath('/tmp/x.db');
    assert.deepEqual(bounds, [expected], `maxFileSize=${String(configured)}`);
  }
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

test('a console EXPLAIN records nothing: no barrier, no dirty flag, no refresh', async () => {
  const plan = {
    results: [{ headers: ['id', 'parent', 'notused', 'detail'], rows: [[2, 0, 0, 'SCAN t']], truncated: false }],
    explain: true, mutated: false, changes: 0, durationMs: 1, statementsSkipped: false
  };
  const { host } = makeHost({ runConsole: () => plan });
  await host.start();
  let refreshed = 0;
  host.setWebviewMethods({ refreshContent: async () => { refreshed++; return { success: true }; } });

  const res = await host.invoke('runConsole', ['SELECT * FROM t', { explain: true }]);

  assert.deepEqual(res, plan);
  assert.equal(host.hasUnsavedChanges(), false);
  assert.equal(refreshed, 0);
});

test('an EXPLAIN that somehow mutated is still barriered: the bypass rests on the worker\'s measured report, not on trust', async () => {
  const { host } = makeHost({
    runConsole: () => ({ results: [], explain: true, mutated: true, changes: 1, durationMs: 1 })
  });
  await host.start();
  let refreshed = 0;
  host.setWebviewMethods({ refreshContent: async () => { refreshed++; return { success: true }; } });

  await host.invoke('runConsole', ['SELECT 1', { explain: true }]);

  assert.equal(host.hasUnsavedChanges(), true);
  assert.equal(refreshed, 1);
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
  /** dbIds issued by nativeOpen, in order. */
  openedIds: string[];
  closes: number;
  /** dbIds passed to nativeClose, in order — a double close would show here. */
  closedIds: string[];
  envelopes: Envelope[];
  /** dbId each envelope was addressed to, index-aligned with `envelopes`. */
  envelopeIds: string[];
  // Out-of-band export route: both calls carry the dbId; the table call also
  // carries the JSON.stringify'd exportTable args so tests can assert the
  // host-injected maxExportBytes crossed WITHOUT any byte frame.
  exportDbCalls: number;
  exportTableArgs: string[];
};

/**
 * The shell's native surface (Task 1, verbatim): `nativeOpen` returns an opaque
 * shell-issued `dbId` plus the CANONICALIZED `boundPath` (deliberately a
 * different spelling from the input — the shell canonicalises, and layer 3 and
 * the sidecar compare exact strings, so the host must carry the RETURNED value
 * into initializeDatabase). Every other call is addressed by `dbId`; an
 * unknown or already-closed id is refused with `ERR_NATIVE_UNKNOWN_DB` and is
 * NEVER retargeted, exactly as the shell behaves.
 *
 * Handlers receive `(payload, dbId)` so a test can give two open databases
 * different answers.
 */
function makeNativeBridgeMembers(
  handlers: Record<string, (args: unknown[], dbId: string) => unknown>,
  opts: { available?: boolean; openError?: string } = {}
) {
  const log: NativeLog = {
    opens: [], openedIds: [], closes: 0, closedIds: [],
    envelopes: [], envelopeIds: [], exportDbCalls: 0, exportTableArgs: []
  };
  const live = new Set<string>();
  let idSeq = 0;
  const requireLive = (dbId: string) => {
    if (!live.has(dbId)) throw new Error(`ERR_NATIVE_UNKNOWN_DB: ${String(dbId)}`);
  };
  handlers = withHistoryRoutes(handlers);
  const members = {
    nativeAvailable: async () => opts.available ?? true,
    nativeOpen: async (path: string, readOnly: boolean) => {
      log.opens.push({ path, readOnly });
      if (opts.openError) throw new Error(opts.openError);
      const dbId = `db_${idSeq++}`;
      live.add(dbId);
      log.openedIds.push(dbId);
      return { dbId, boundPath: CANONICAL_PREFIX + path };
    },
    nativeRpc: async (dbId: string, envelopeJson: string) => {
      requireLive(dbId);
      const envelope = JSON.parse(envelopeJson) as Envelope;
      log.envelopes.push(envelope);
      log.envelopeIds.push(dbId);
      const { messageId, targetMethod, payload } = envelope.content;
      const handler = handlers[targetMethod];
      const respond = (success: boolean, data: unknown, errorMessage?: string) =>
        JSON.stringify({ channel: 'rpc', content: { kind: 'response', messageId, success, data, errorMessage } });
      if (!handler) return respond(false, undefined, `no native fake for ${targetMethod}`);
      try {
        return respond(true, handler(payload, dbId));
      } catch (error) {
        return respond(false, undefined, error instanceof Error ? error.message : String(error));
      }
    },
    // Deliberately NOT idempotent, matching the shell: a second close of the
    // same id rejects instead of silently doing nothing.
    nativeClose: async (dbId: string) => {
      requireLive(dbId);
      live.delete(dbId);
      log.closes += 1;
      log.closedIds.push(dbId);
    },
    // Shell-owned out-of-band export: the sidecar writes to a shell temp and
    // the shell moves it to the dialog-picked dest, returning the dest's
    // basename as savedAs. The default is a clean success; tests override for
    // cancel/empty scenarios. Deliberately NOT reachable by the framed
    // saveFileAs path — asserting exportDbCalls/exportTableArgs proves the host
    // took this route instead of framing bytes.
    nativeExportDatabase: async (dbId: string) => {
      requireLive(dbId);
      log.exportDbCalls += 1;
      return { success: true, savedAs: 'export.db' };
    },
    nativeExportTable: async (dbId: string, argsJson: string) => {
      requireLive(dbId);
      log.exportTableArgs.push(argsJson);
      return { success: true, savedAs: 'export.csv' };
    }
  };
  return { members, log };
}

/**
 * Stateful transaction fake mirroring SQLite's real autocommit answers: nested
 * BEGIN and txn-less COMMIT/ROLLBACK throw. The host's post-console
 * reconciliation probe (a bare BEGIN) is only meaningful against a fake that
 * answers it the way an engine would — the old stateless `runQuery: () => []`
 * would make every probe "discover" autocommit.
 *
 * Two message flavors, both real: 'classic' throws sql.js/sqlite3's
 * contextual messages ("cannot start a transaction within a transaction");
 * 'fork' throws the bundled tjs binary's per-errno generic strings — probed
 * ground truth: nested BEGIN, txn-less COMMIT/ROLLBACK and missing tables ALL
 * answer exactly "SQL logic error" (errno 1, which never crosses the wire).
 * The fork flavor exists because message-based tolerance that only knows the
 * classic strings is dead code on the real sidecar — the live smoke caught
 * exactly that.
 *
 * `applied` records the successful state TRANSITIONS only (failed probes and
 * tolerated no-ops never appear), so tests can assert the engine-side truth
 * (what actually opened/committed/rolled back) instead of wire noise.
 */
function makeTxnFake(flavor: 'classic' | 'fork' = 'classic') {
  // `autoRollbackNextCommit` models SQLite's documented behavior on
  // SQLITE_FULL/IOERR/NOMEM/INTERRUPT: the COMMIT fails AND the engine rolls
  // the transaction back automatically, leaving autocommit active — which is
  // exactly what a post-failure BEGIN probe then observes. Without this mode
  // the fake could only express "failed COMMIT keeps the txn open", hiding
  // the discarded-session family entirely (the same "the fakes lied" gap the
  // fork-message flavor closed for error strings).
  const txn = {
    open: false,
    applied: [] as string[],
    autoRollbackNextCommit: false,
    autoRollbackNextMutation: false,
    /**
     * Whether an enclosing transaction existed when each successful mutation
     * body ran (recorded by `mutate` below). `false` is the
     * persist-without-Save signature: the worker's SAVEPOINT/RELEASE around a
     * mutation autocommits straight to the real file when no session
     * transaction encloses it.
     */
    mutationsInTxn: [] as boolean[]
  };
  const msg = (classic: string) => (flavor === 'fork' ? 'SQL logic error' : classic);
  const exec = (sql: unknown) => {
    const s = String(sql).trim().toUpperCase();
    if (s === 'BEGIN') {
      if (txn.open) throw new Error(msg('cannot start a transaction within a transaction'));
      txn.open = true;
      txn.applied.push('BEGIN');
    } else if (s === 'COMMIT' || s === 'END') {
      if (!txn.open) throw new Error(msg('cannot commit - no transaction is active'));
      if (txn.autoRollbackNextCommit) {
        txn.autoRollbackNextCommit = false;
        txn.open = false;                       // the engine discarded the txn
        txn.applied.push('AUTO-ROLLBACK');
        // Same string on both flavors: sqlite3_errstr(SQLITE_FULL).
        throw new Error('database or disk is full');
      }
      txn.open = false;
      txn.applied.push('COMMIT');
    } else if (s === 'ROLLBACK') {
      if (!txn.open) throw new Error(msg('cannot rollback - no transaction is active'));
      txn.open = false;
      txn.applied.push('ROLLBACK');
    }
    return [];
  };
  /**
   * Models a worker mutation method (a SAVEPOINT-wrapped body). When
   * `autoRollbackNextMutation` is armed the call rejects abort-class
   * (SQLITE_FULL — same sqlite3_errstr string on both flavors, like the
   * COMMIT hook above) AND the engine rolls the WHOLE enclosing transaction
   * back, leaving autocommit active — exactly what a post-failure BEGIN
   * probe then observes. Successful runs record `txn.open` into
   * `mutationsInTxn` so tests can catch a mutation executing with no
   * enclosing transaction (its RELEASE would autocommit to the real file).
   */
  const mutate = () => {
    if (txn.autoRollbackNextMutation) {
      txn.autoRollbackNextMutation = false;
      if (txn.open) {
        txn.open = false;                     // the engine discarded the txn
        txn.applied.push('AUTO-ROLLBACK');
      }
      throw new Error('database or disk is full');
    }
    txn.mutationsInTxn.push(txn.open);
    return 1;
  };
  return { txn, exec, mutate };
}

function makeNativeHost(
  nativeHandlers: Record<string, (args: unknown[]) => unknown> = {},
  workerHandlers: Record<string, (args: unknown[]) => unknown> = {},
  bridgeOverrides: Record<string, unknown> = {},
  nativeOpts: { available?: boolean; openError?: string; txnFlavor?: 'classic' | 'fork' } = {}
) {
  const { txn, exec } = makeTxnFake(nativeOpts.txnFlavor);
  const { members, log } = makeNativeBridgeMembers({
    // Re-init opens a fresh engine session: any transaction is implicitly gone.
    initializeDatabase: () => { txn.open = false; return { isReadOnly: false, storage: 'memory' }; },
    runQuery: (args) => exec(args[0]),
    ping: () => true,
    ...nativeHandlers
  }, nativeOpts);
  const made = makeHost(workerHandlers, { ...members, ...bridgeOverrides });
  return { ...made, nativeLog: log, txn, execTxnSql: exec };
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

// Multi-database semantics: a second open ADDS a database, it does not replace
// the first. The old single-document host shut the live sidecar down here; now
// both stay open and only the active pointer moves.
test('a WASM open alongside a live native database leaves the native sidecar running', async () => {
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
  assert.equal(log.closes, 0);                          // first sidecar untouched by the second open
  const init = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(init.engine, 'wasm');                    // …but the WASM one is now active

  const open = host.listDatabases();
  assert.deepEqual(open.map(d => [d.name, d.engine, d.isActive]), [
    ['first.db', 'native', false],
    ['second.db', 'wasm', true]
  ]);
});

test('the configured maxFileSize binds BOTH engines: nativeOpen receives the bound, and its refusal never falls back to WASM', async () => {
  // A user-selected limit — the VS Code host refuses before choosing an engine
  // for the same reason: changing engine must not make a refused file admissible.
  const opens: unknown[][] = [];
  const reads: unknown[][] = [];
  const { members, log } = makeNativeBridgeMembers({
    initializeDatabase: () => ({ isReadOnly: false, storage: 'memory' }),
    ping: () => true
  });
  let refuse = false;
  const { host } = makeHost({}, {
    ...members,
    nativeOpen: async (...args: unknown[]) => {
      opens.push(args);
      if (refuse) throw new Error(SIZE_REFUSAL);
      return members.nativeOpen(args[0] as string, args[1] as boolean);
    },
    pickDatabase: async () => ({ path: '/tmp/huge.db', name: 'huge.db', size: 5 * 1024 * 1024 }),
    readDatabaseBytes: async (...args: unknown[]) => { reads.push(args); return new Uint8Array([1]); },
    loadSettings: async () => ({ maxFileSize: 1 })
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });

  refuse = true;
  await assert.rejects(() => host.openDatabaseViaDialog(), (error: Error & { code?: string }) => {
    assert.equal(error.message, SIZE_SENTENCE);
    assert.equal(error.code, 'ERR_FILE_TOO_LARGE');
    return true;
  });
  assert.deepEqual(opens, [['/tmp/huge.db', false, 1024 * 1024]]);   // the bound rides the native open
  assert.deepEqual(reads, []);                                       // and the refusal is final: no WASM lane
  assert.equal(log.openedIds.length, 0);
  assert.deepEqual(host.listDatabases().map(d => d.name), ['untitled.db']);

  // Under the bound the native lane serves as before, still carrying it.
  refuse = false;
  assert.equal(await host.openDatabaseViaDialog(), true);
  assert.deepEqual(opens.at(-1), ['/tmp/huge.db', false, 1024 * 1024]);
  assert.deepEqual(reads, []);
  assert.equal((await host.invoke('initialize', []) as Record<string, unknown>).engine, 'native');
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
  assert.equal(ok.success, true);
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
  // Asserted on the txn fake's ENGINE state, not the wire trace: the
  // post-console reconciliation probe (fix round 1) adds a failing BEGIN after
  // every native console run, so raw trace shapes now carry probe noise. The
  // contract under test is unchanged — what matters is whether a transaction
  // (and its SHARED lock on the real file) is left open on the engine.
  const { host, txn } = makeNativeHost({
    runConsole: (args) => (String(args[0]).startsWith('SELECT')
      ? { results: [{ headers: ['1'], rows: [[1]], truncated: false }], mutated: false, changes: 0, durationMs: 1 }
      : { results: [], mutated: true, changes: 1, durationMs: 1 }),
    updateCell: () => 1
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');

  await host.invoke('runConsole', ['SELECT 1', {}]);
  // A pure read must not leave a transaction dangling until save.
  assert.equal(txn.open, false);
  assert.deepEqual(txn.applied, ['BEGIN', 'COMMIT']);
  assert.equal(host.hasUnsavedChanges(), false);

  await host.invoke('runConsole', ['INSERT INTO t DEFAULT VALUES', {}]);
  assert.equal(txn.open, true);                         // mutations stay pending until ⌘S
  assert.equal(host.hasUnsavedChanges(), true);

  await host.invoke('runConsole', ['SELECT 2', {}]);    // txn was already open: not this run's to close
  assert.equal(txn.open, true);
  assert.equal(host.hasUnsavedChanges(), true);
});

test('a native console EXPLAIN opens no session transaction and runs no probe', async () => {
  // A plan lookup compiles and lists; it must not take a SHARED lock on the
  // real file (BEGIN) or leave a phantom "unsaved" session, and it does not
  // need the post-run reconcile probe either -- nothing could have changed
  // the transaction state.
  const { host, txn, nativeLog } = makeNativeHost({
    runConsole: (args) => ((args[1] as Record<string, unknown>)?.explain === true
      ? {
        results: [{ headers: ['id', 'parent', 'notused', 'detail'], rows: [[2, 0, 0, 'SCAN t']], truncated: false }],
        explain: true, mutated: false, changes: 0, durationMs: 1, statementsSkipped: false
      }
      : { results: [], mutated: true, changes: 1, durationMs: 1 })
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  const sqlBefore = nativeSql(nativeLog).length;

  const res = await host.invoke('runConsole', ['SELECT * FROM t', { explain: true }]) as Record<string, unknown>;

  assert.equal(res.explain, true);
  assert.equal(txn.open, false);
  assert.deepEqual(txn.applied, []);                      // no BEGIN, no COMMIT
  assert.deepEqual(nativeSql(nativeLog).slice(sqlBefore), []); // and no probe round trip
  assert.equal(host.hasUnsavedChanges(), false);

  // With a dirty session already open, EXPLAIN leaves it exactly as it was.
  await host.invoke('runConsole', ['INSERT INTO t DEFAULT VALUES', {}]);
  assert.equal(txn.open, true);
  await host.invoke('runConsole', ['SELECT * FROM t', { explain: true }]);
  assert.equal(txn.open, true);
  assert.equal(host.hasUnsavedChanges(), true);
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
  assert.equal(ok.success, true);
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
  // The edit rides updateCellBatch on the wire; neither spelling may have gone out.
  assert.equal(nativeMethods(nativeLog).some(m => m === 'updateCell' || m === 'updateCellBatch'), false);
  assert.equal(host.hasUnsavedChanges(), false);
});

// ---------------------------------------------------------------------------
// Native out-of-band export route (Task 3): native exportDatabase/exportTable
// would return the whole result as ONE stdio frame, capped at 16 MiB, so a
// large export fails on native where WASM does 512 MiB. The host instead routes
// native exports through bridge.nativeExportDatabase()/nativeExportTable(json)
// — the shell drives the sidecar to write to a shell-owned temp and moves it to
// the dialog-picked dest; only a {success, savedAs} result crosses the pipe.
// The WASM path (existing tests above) is UNCHANGED: callWorker + saveFileAs.
// ---------------------------------------------------------------------------

test('native whole-DB export routes through bridge.nativeExportDatabase, never framing bytes via saveFileAs', async () => {
  let saveFileAsCalls = 0;
  const { host, nativeLog } = makeNativeHost(
    // A framed exportDatabase must never run on native — throw if the host
    // wrongly reaches for it.
    { exportDatabase: () => { throw new Error('framed exportDatabase must not run on native'); } },
    {},
    { saveFileAs: async () => { saveFileAsCalls += 1; return '/tmp/out'; } }
  );
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');            // clean native session, no open txn

  const res = await host.invoke('exportDb', ['y.db']) as Record<string, unknown>;
  assert.equal(res.success, true);
  assert.equal(res.savedAs, 'export.db');               // shell-provided basename, surfaced verbatim
  assert.equal(nativeLog.exportDbCalls, 1);             // the out-of-band bridge call
  assert.equal(saveFileAsCalls, 0);                     // no framed byte save
  assert.equal(nativeMethods(nativeLog).includes('exportDatabase'), false);  // no worker frame crossed
});

test('native table export routes through bridge.nativeExportTable with maxExportBytes in the serialized args, never framing bytes via saveFileAs', async () => {
  let saveFileAsCalls = 0;
  const { host, nativeLog } = makeNativeHost(
    { exportTable: () => { throw new Error('framed exportTable must not run on native'); } },
    {},
    { saveFileAs: async () => { saveFileAsCalls += 1; return '/tmp/u.csv'; } }
  );
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');

  const res = await host.invoke(
    'exportTable',
    [{ table: 'users' }, ['a', 'b'], null, null, { format: 'csv', header: false }]
  ) as Record<string, unknown>;
  assert.equal(res.success, true);
  assert.equal(res.savedAs, 'export.csv');
  assert.equal(saveFileAsCalls, 0);                     // no framed byte save
  assert.equal(nativeMethods(nativeLog).includes('exportTable'), false);   // no worker frame crossed

  // The serialized args carry the desktop 512 MiB ceiling (so the sidecar's
  // in-process exportTable isn't clipped by the worker's 16 MiB web-demo cap)
  // AND preserve the caller-passed options.
  assert.equal(nativeLog.exportTableArgs.length, 1);
  const serialized = JSON.parse(nativeLog.exportTableArgs[0]) as unknown[];
  const exportOptions = serialized[4] as Record<string, unknown>;
  assert.equal(exportOptions.maxExportBytes, 536870912);
  assert.equal(exportOptions.format, 'csv');
  assert.equal(exportOptions.header, false);
});

test('native exportDb save-first-if-dirty: cancel aborts before the export; accept COMMITs, THEN routes through nativeExportDatabase', async () => {
  const order: string[] = [];
  const { host, nativeLog, execTxnSql } = makeNativeHost(
    {
      updateCell: () => 1,
      // Record the moment the session COMMIT reaches the engine, then defer to
      // the shared txn fake (execTxnSql is only referenced at run time — after
      // makeNativeHost has assigned it).
      runQuery: (args) => {
        if (String(args[0]).trim().toUpperCase() === 'COMMIT') order.push('commit');
        return execTxnSql(args[0]);
      }
    },
    {},
    { nativeExportDatabase: async () => { order.push('export'); return { success: true, savedAs: 'y.db' }; } }
  );
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);   // dirty: session txn open

  const originalConfirm = (globalThis as { confirm?: unknown }).confirm;
  try {
    (globalThis as { confirm?: unknown }).confirm = () => false;
    const refused = await host.invoke('exportDb', ['y.db']) as Record<string, unknown>;
    assert.equal(refused.success, false);
    assert.deepEqual(order, []);                         // nothing committed, nothing exported
    assert.equal(host.hasUnsavedChanges(), true);        // still dirty — the snapshot was never taken

    (globalThis as { confirm?: unknown }).confirm = () => true;
    const okResult = await host.invoke('exportDb', ['y.db']) as Record<string, unknown>;
    assert.equal(okResult.success, true);
    assert.equal(okResult.savedAs, 'y.db');
    // The save (COMMIT) must precede the out-of-band export — never export an
    // uncommitted, snapshot-inconsistent session.
    assert.deepEqual(order, ['commit', 'export']);
    assert.equal(nativeSql(nativeLog).includes('COMMIT'), true);
    assert.equal(nativeMethods(nativeLog).includes('exportDatabase'), false);   // still no framed bytes
    assert.equal(host.hasUnsavedChanges(), false);
  } finally {
    if (originalConfirm === undefined) delete (globalThis as { confirm?: unknown }).confirm;
    else (globalThis as { confirm?: unknown }).confirm = originalConfirm;
  }
});

test('native export dialog cancel ({success:false}) is a clean no-op — no error, no savedAs — for both DB and table exports', async () => {
  const { host } = makeNativeHost(
    {},
    {},
    {
      nativeExportDatabase: async () => ({ success: false }),
      nativeExportTable: async () => ({ success: false })
    }
  );
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  // `{success:false, cancelled:true}` is the shape export.js and the blob
  // inspector read (the VS Code host's saveFile contract): "Export cancelled",
  // not "Export failed".
  const db = await host.invoke('exportDb', ['y.db']) as Record<string, unknown>;
  assert.deepEqual(db, { success: false, cancelled: true });
  const table = await host.invoke('exportTable', [{ table: 't' }, ['a'], null, null, { format: 'csv' }]) as Record<string, unknown>;
  assert.deepEqual(table, { success: false, cancelled: true });
});

test('native empty-table export surfaces as a successful (0-byte) export, not an error', async () => {
  // Parity with the WASM route's empty Blob: the sidecar writes a 0-byte file
  // and the shell replies {success:true} — the host must NOT treat empty as
  // failure.
  const { host } = makeNativeHost(
    {},
    {},
    { nativeExportTable: async () => ({ success: true, savedAs: 'empty.csv' }) }
  );
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  const res = await host.invoke('exportTable', [{ table: 'empty' }, ['a'], null, null, { format: 'csv' }]) as Record<string, unknown>;
  assert.deepEqual(res, { success: true, savedAs: 'empty.csv' });
});

test('native exportDb is refused while a cell read session is open (dispatch-guard parity), then routes out-of-band once closed', async () => {
  const { host, nativeLog } = makeNativeHost({
    openCellReadSession: () => ({ sessionId: 's1', byteLength: 10, storageClass: 'blob' }),
    closeCellReadSession: () => ({ success: true })
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('openCellReadSession', [{ table: 't', rowId: 1, column: 'c' }]);
  // Refused BEFORE any export is attempted — the out-of-band bridge is never hit.
  await assert.rejects(() => host.invoke('exportDb', ['y.db']), /cell read snapshot is active/);
  assert.equal(nativeLog.exportDbCalls, 0);
  await host.invoke('closeCellReadSession', ['s1']);
  const ok = await host.invoke('exportDb', ['y.db']) as Record<string, unknown>;
  assert.equal(ok.success, true);
  assert.equal(nativeLog.exportDbCalls, 1);             // now the out-of-band route runs
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
    nativeRpc: async (_dbId: string, json: string) => {
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
  members.nativeRpc = async (dbId: string, json: string) => {
    const envelope = JSON.parse(json) as Envelope;
    if (envelope.content.targetMethod === 'updateCellBatch') rawJson = json;
    return innerRpc(dbId, json);
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
    .catch(() => { /* no updateCellBatch fake — the send is what matters */ });
  // The single edit rides updateCellBatch: the value sits inside the first
  // update entry rather than at the updateCell argument position.
  const parsed = JSON.parse(rawJson) as { content: { payload: [string, Array<{ value: unknown }>] } };
  assert.deepEqual(parsed.content.payload[1][0].value, { __type: 'Uint8Array', base64: 'Bwg=' });
});

// ============================================================================
// Fix round 1 — review defects
// ============================================================================

// CRITICAL 1, under the registry. The old single-document host tore the live
// native session down to make room for the new open, which left the shared WASM
// worker NOT holding the document currentPath named — so a failed fallback made
// ⌘S export a stale/empty image over the user's REAL file, and the host needed
// an invalidate-the-document recovery to stop it.
//
// A registry open builds a NEW entry with its OWN engine and only commits it on
// success, so the property is now stronger and structural: a failed open cannot
// touch — let alone damage — the database that was already open. This is the
// same scenario, asserting that.
test('a failed open leaves the live native database completely intact: no teardown, still dirty, still saveable to its own path', async () => {
  let declineNative = false;
  let failRead = false;
  const { txn, exec } = makeTxnFake();
  const { members, log } = makeNativeBridgeMembers({
    initializeDatabase: () => { txn.open = false; return { isReadOnly: false, storage: 'memory' }; },
    runQuery: (args) => exec(args[0]),
    updateCell: () => 1,
    ping: () => true
  });
  const realOpen = members.nativeOpen;
  members.nativeOpen = async (path: string, readOnly: boolean) => {
    if (declineNative) throw new Error('ERR_NATIVE_OPEN_FAILED: symlinked final component');
    return realOpen(path, readOnly);
  };
  const { host, posted, saved } = makeHost(
    { exportDatabase: () => new Uint8Array([9, 9, 9]) },   // what a rogue ⌘S would write
    {
      ...members,
      readDatabaseBytes: async () => {
        if (failRead) throw new Error('EACCES: read refused');
        return new Uint8Array([1, 2, 3]);
      }
    }
  );
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });

  await host.openFromShellPath('/tmp/precious.db');              // native session
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);
  assert.equal(host.hasUnsavedChanges(), true);                  // dirty, txn open

  declineNative = true;
  failRead = true;
  await assert.rejects(() => host.openFromShellPath('/tmp/second.db'), /EACCES/);
  assert.equal(log.closes, 0);                                   // the live sidecar was never touched
  assert.equal(host.listDatabases().length, 1);                  // and no half-built entry was kept

  // The pending edit survived, and ⌘S is a real COMMIT on precious.db's own
  // sidecar — never a byte export of some other image over the file.
  assert.equal(host.hasUnsavedChanges(), true);
  assert.equal((await host.saveToDisk()).success, true);
  assert.equal(saved.path, undefined);                           // bridge.saveDatabase never ran
  assert.equal(posted.filter(p => p.content.targetMethod === 'exportDatabase').length, 0);
  assert.equal(host.hasUnsavedChanges(), false);
  assert.deepEqual(txn.applied, ['BEGIN', 'COMMIT']);

  const init = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(init.filename, 'precious.db');
  assert.equal(init.engine, 'native');
});

// Companion boundary: when NO native teardown happened and the failure fired
// before the worker was touched (the maxFileSize cap), the previous document
// is still fully intact in the worker — a failed open must not destroy it.
test('a failed pure-WASM second open before the worker is touched preserves the current document', async () => {
  const { host, saved } = makeHost(
    { exportDatabase: () => new Uint8Array([7]), updateCell: () => 1 },
    {
      pickDatabase: async () => ({ path: '/tmp/huge.db', name: 'huge.db', size: 5 * 1024 * 1024 }),
      // The shell refuses the oversize read before allocating anything.
      readDatabaseBytes: async (p: string) => {
        if (p === '/tmp/huge.db') throw new Error(SIZE_REFUSAL);
        return new Uint8Array([1, 2, 3]);
      },
      loadSettings: async () => ({ maxFileSize: 1 })
    }
  );
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/keep.db');                  // WASM open (no native bridge)
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);

  await assert.rejects(() => host.openDatabaseViaDialog(), /maximum allowed size/);

  // The old document survived: still saveable to its own path.
  assert.equal(host.hasUnsavedChanges(), true);
  const ok = await host.saveToDisk();
  assert.equal(ok.success, true);
  assert.equal(saved.path, '/tmp/keep.db');
  const init = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(init.filename, 'keep.db');
});

// IMPORTANT 2: a bare COMMIT in the console reports mutated:false, so nothing
// used to reconcile nativeTxnOpen — the stale-true flag made ensureSessionTxn
// early-return and every later grid mutation autocommitted straight into the
// user's file (persist-without-⌘S), while ⌘S "succeeded" via the tolerance
// path writing nothing. The post-console probe must resynchronize the flag.
test('console COMMIT divergence: the next grid edit still runs inside a fresh transaction and ⌘S is a real COMMIT', async () => {
  const editsUnderTxn: boolean[] = [];
  const { host, txn, execTxnSql } = makeNativeHost({
    updateCell: () => { editsUnderTxn.push(txn.open); return 1; },
    runConsole: (args) => {
      execTxnSql(String(args[0]));   // the script's raw COMMIT reaches the engine
      return { results: [], mutated: false, changes: 0, durationMs: 1 };
    }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');

  await host.invoke('updateCell', ['t', 1, 'c', 'v1', 'o', 1048576]);   // BEGIN + pending edit
  await host.invoke('runConsole', ['COMMIT', {}]);                       // script commits underneath
  assert.equal(txn.open, false);                                         // engine is in autocommit

  // The divergence victim: without reconciliation this edit ran OUTSIDE any
  // transaction (txn.open false ⇒ instantly persisted to the real file).
  await host.invoke('updateCell', ['t', 1, 'c', 'v2', 'v1', 1048576]);
  assert.deepEqual(editsUnderTxn, [true, true]);                         // both edits were pending
  assert.equal(txn.open, true);

  // ⌘S must be an honest COMMIT that actually closes the transaction.
  const ok = await host.saveToDisk();
  assert.equal(ok.success, true);
  assert.equal(txn.open, false);
  assert.equal(host.hasUnsavedChanges(), false);
  // Engine-side truth, in order: edit#1's BEGIN, the script's COMMIT, the
  // reconciliation probe pair (BEGIN + immediate COMMIT of the empty probe
  // txn), edit#2's fresh BEGIN, then the real ⌘S COMMIT.
  assert.deepEqual(txn.applied, ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
});

test('console ROLLBACK divergence reconciles the same way: later edits are pending again, not autocommitted', async () => {
  const editsUnderTxn: boolean[] = [];
  const { host, txn, execTxnSql } = makeNativeHost({
    updateCell: () => { editsUnderTxn.push(txn.open); return 1; },
    runConsole: (args) => {
      execTxnSql(String(args[0]));
      return { results: [], mutated: false, changes: 0, durationMs: 1 };
    }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');

  await host.invoke('updateCell', ['t', 1, 'c', 'v1', 'o', 1048576]);
  await host.invoke('runConsole', ['ROLLBACK', {}]);
  assert.equal(txn.open, false);

  await host.invoke('updateCell', ['t', 1, 'c', 'v2', 'v1', 1048576]);
  assert.deepEqual(editsUnderTxn, [true, true]);
  assert.equal(txn.open, true);                                  // pending until ⌘S
});

test('a mutating console script with a COMMIT tail reconciles too: the next mutation BEGINs afresh', async () => {
  const editsUnderTxn: boolean[] = [];
  const { host, txn, execTxnSql } = makeNativeHost({
    updateCell: () => { editsUnderTxn.push(txn.open); return 1; },
    runConsole: () => {
      // Simulates `INSERT ...; COMMIT` while the session txn was open: the
      // worker reports mutated:true (the INSERT) but the tail COMMIT already
      // closed the transaction under the host.
      execTxnSql('COMMIT');
      return { results: [], mutated: true, changes: 1, durationMs: 1 };
    }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');

  await host.invoke('updateCell', ['t', 1, 'c', 'v1', 'o', 1048576]);   // txn open
  await host.invoke('runConsole', ['INSERT INTO t DEFAULT VALUES; COMMIT', {}]);
  assert.equal(txn.open, false);                                 // reconciled to autocommit truth

  await host.invoke('updateCell', ['t', 1, 'c', 'v2', 'v1', 1048576]);
  assert.deepEqual(editsUnderTxn, [true, true]);                 // never autocommitted
  assert.equal(txn.open, true);
});

// IMPORTANT 4: the most dangerous transition — a genuine COMMIT failure must
// keep the transaction open and the session dirty so the user can retry.
test('a genuine COMMIT failure keeps the session dirty and open; a second save retries the COMMIT without re-BEGIN', async () => {
  let failCommitOnce = true;
  const { host, txn, execTxnSql } = makeNativeHost({
    updateCell: () => 1,
    runQuery: (args) => {
      const sql = String(args[0]).trim().toUpperCase();
      if (sql === 'COMMIT' && failCommitOnce) {
        failCommitOnce = false;
        throw new Error('disk I/O error');   // SQLite keeps the txn open on failed COMMIT
      }
      return execTxnSql(args[0]);
    }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);

  await assert.rejects(() => host.saveToDisk(), /disk I\/O error/);
  assert.equal(host.hasUnsavedChanges(), true);                  // still dirty — retry possible
  assert.equal(txn.open, true);                                  // engine still holds the txn

  const ok = await host.saveToDisk();                            // retry
  assert.equal(ok.success, true);
  assert.equal(host.hasUnsavedChanges(), false);
  assert.equal(txn.open, false);
  assert.deepEqual(txn.applied, ['BEGIN', 'COMMIT']);            // one txn: no re-BEGIN between saves
});

// CONCERN 5: PRAGMA foreign_keys is a SILENT SQLite no-op inside an open
// transaction — the engine neither applies nor reports it. The host must
// refuse loudly instead of letting a data-integrity control silently no-op.
test('setPragma foreign_keys is refused while a native transaction is open, and allowed once the session is clean', async () => {
  const pragmas: unknown[][] = [];
  const { host, nativeLog } = makeNativeHost({
    updateCell: () => 1,
    setPragma: (args) => { pragmas.push(args); return undefined; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);   // txn open

  await assert.rejects(
    () => host.invoke('setPragma', ['foreign_keys', true]),
    /Save or discard/
  );
  // Refused host-side: the envelope never reached the engine, and no barrier
  // was recorded for an action that did not happen.
  assert.equal(nativeMethods(nativeLog).includes('setPragma'), false);

  // journal_mode is NOT gated: inside a txn the engine itself errors loudly,
  // and that answer must keep flowing through unchanged.
  await host.invoke('setPragma', ['journal_mode', 'wal']);
  assert.deepEqual(pragmas.at(-1), ['journal_mode', 'wal']);

  await host.saveToDisk();                                       // txn closed
  await host.invoke('setPragma', ['foreign_keys', true]);        // now allowed
  assert.deepEqual(pragmas.at(-1), ['foreign_keys', true]);
});

test('setPragma foreign_keys passes through on WASM regardless of dirty state (in-memory image, no session txn)', async () => {
  const pragmas: unknown[][] = [];
  const { host } = makeHost({
    updateCell: () => 1,
    setPragma: (args) => { pragmas.push(args); return undefined; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/x.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);
  await host.invoke('setPragma', ['foreign_keys', true]);
  assert.deepEqual(pragmas.at(-1), ['foreign_keys', true]);
});

// MINOR: the pending map is shared by both transports (and, now, by every open
// database). A WASM worker error while the native engine is active must fail
// only its own (WASM) calls — in-flight native RPCs are alive on
// bridge.nativeRpc and must settle. Here the WASM worker under test is the boot
// placeholder's, still live because the native open only made it inactive.
test('worker.onerror rejects only WASM-transport pendings; in-flight native calls still settle', async () => {
  let releaseNative!: () => void;
  const gate = new Promise<void>((resolve) => { releaseNative = resolve; });
  const schema = { tables: [{ name: 't' }], views: [], indexes: [] };
  const { members } = makeNativeBridgeMembers({
    initializeDatabase: () => ({ isReadOnly: false, storage: 'memory' }),
    runQuery: () => [],
    ping: () => true,
    fetchSchema: () => schema
  });
  const innerRpc = members.nativeRpc;
  members.nativeRpc = async (dbId: string, json: string) => {
    const envelope = JSON.parse(json) as Envelope;
    if (envelope.content.targetMethod === 'fetchSchema') await gate;   // hold the call in flight
    return innerRpc(dbId, json);
  };
  const realOpen = members.nativeOpen;
  members.nativeOpen = async (path: string, readOnly: boolean) => {
    if (path === '/tmp/wasm-only.db') throw new Error('ERR_NATIVE_UNAVAILABLE');   // force the WASM lane
    return realOpen(path, readOnly);
  };
  const { host, workers } = makeHost({}, { ...members });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  // A WASM database the user keeps open alongside the native one (the boot
  // placeholder is dropped by the first real open, so open a real file).
  await host.openFromShellPath('/tmp/wasm-only.db');
  const wasmWorker = workers.at(-1)!;
  await host.openFromShellPath('/tmp/y.db');            // native; now active

  const inFlight = host.invoke('fetchSchema', []);
  wasmWorker.onerror?.(new Error('wasm worker crashed'));   // must not touch the native pending
  releaseNative();
  // Settled by the NATIVE response, not spuriously rejected by another
  // database's WASM crash.
  assert.deepEqual(await inFlight, schema);
});

// ---------------------------------------------------------------------------
// Fork-message engine (live-smoke regression): the real sidecar's tjs fork
// answers "SQL logic error" for EVERY errno-1 condition, so any transaction
// tolerance keyed on the classic contextual strings is dead code natively.
// The live drive caught this: the reconciliation probe's nested BEGIN came
// back generic, was treated as a genuine failure, and every mutating console
// run on native errored out. These tests run the key transitions against the
// fork's actual message behavior.
// ---------------------------------------------------------------------------

test('fork messages: a mutating console run still lands — the probe adopts the generic nesting answer', async () => {
  const { host, txn } = makeNativeHost({
    runConsole: () => ({ results: [], mutated: true, changes: 1, durationMs: 1 })
  }, {}, {}, { txnFlavor: 'fork' });
  await host.start();
  let refreshed = 0;
  host.setWebviewMethods({ refreshContent: async () => { refreshed++; return { success: true }; } });
  await host.openFromShellPath('/tmp/y.db');
  refreshed = 0;   // the open itself refreshes once; count only the console's

  // Must resolve (the live symptom was a rejection rendered as a console
  // error), record the barrier, and leave the mutation pending.
  const res = await host.invoke('runConsole', ['INSERT INTO t DEFAULT VALUES', {}]) as Record<string, unknown>;
  assert.equal(res.mutated, true);
  assert.equal(host.hasUnsavedChanges(), true);
  assert.equal(refreshed, 1);
  assert.equal(txn.open, true);

  const ok = await host.saveToDisk();
  assert.equal(ok.success, true);
  assert.equal(txn.open, false);
  assert.equal(host.hasUnsavedChanges(), false);
});

test('fork messages: console COMMIT divergence reconciles through the state probe', async () => {
  const editsUnderTxn: boolean[] = [];
  const { host, txn, execTxnSql } = makeNativeHost({
    updateCell: () => { editsUnderTxn.push(txn.open); return 1; },
    runConsole: (args) => {
      execTxnSql(String(args[0]));
      return { results: [], mutated: false, changes: 0, durationMs: 1 };
    }
  }, {}, {}, { txnFlavor: 'fork' });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');

  await host.invoke('updateCell', ['t', 1, 'c', 'v1', 'o', 1048576]);
  await host.invoke('runConsole', ['COMMIT', {}]);
  assert.equal(txn.open, false);

  await host.invoke('updateCell', ['t', 1, 'c', 'v2', 'v1', 1048576]);
  assert.deepEqual(editsUnderTxn, [true, true]);         // never autocommitted
  const ok = await host.saveToDisk();
  assert.equal(ok.success, true);
  assert.equal(txn.open, false);
  assert.deepEqual(txn.applied, ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
});

test('fork messages: a genuine COMMIT failure is still separated from the generic no-txn answer by probing the engine', async () => {
  let failCommitOnce = true;
  const { host, txn, execTxnSql } = makeNativeHost({
    updateCell: () => 1,
    runQuery: (args) => {
      const sql = String(args[0]).trim().toUpperCase();
      if (sql === 'COMMIT' && failCommitOnce) {
        failCommitOnce = false;
        // Fork errstr for SQLITE_IOERR — a REAL failure; the txn stays open.
        throw new Error('disk I/O error');
      }
      return execTxnSql(args[0]);
    }
  }, {}, {}, { txnFlavor: 'fork' });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);

  // The COMMIT failure is not the classic no-txn message, so the host probes:
  // the transaction is still open (probe BEGIN answers the generic nesting
  // refusal) ⇒ genuine failure ⇒ reject, stay dirty, keep the txn.
  await assert.rejects(() => host.saveToDisk(), /disk I\/O error/);
  assert.equal(host.hasUnsavedChanges(), true);
  assert.equal(txn.open, true);

  const ok = await host.saveToDisk();
  assert.equal(ok.success, true);
  assert.equal(txn.open, false);
  assert.deepEqual(txn.applied, ['BEGIN', 'COMMIT']);    // one txn; retry did not re-BEGIN
});

// ============================================================================
// Fix round 2 — re-review defects
// ============================================================================

// STILL-OPEN CRITICAL slice, under the registry. The nastiest ordering: the new
// open's nativeOpen SUCCEEDS (a second sidecar is live), its init refuses, and
// the WASM lane then fails on the cap. The single-document host had to arm an
// invalidation here or ⌘S would overwrite the old file with the empty startup
// image; the registry instead has to (a) reap the second sidecar it spawned and
// (b) leave the first database — its sidecar, its pending edit, its identity —
// untouched.
test('init-refusal slice: native open ok, native init refuses, cap fails the WASM lane — the second sidecar is reaped and the first database is untouched', async () => {
  let refuseNativeInit = false;
  const { txn, exec } = makeTxnFake();
  const { members, log } = makeNativeBridgeMembers({
    initializeDatabase: () => {
      if (refuseNativeInit) throw new Error('file is not a database');
      txn.open = false;
      return { isReadOnly: false, storage: 'memory' };
    },
    runQuery: (args) => exec(args[0]),
    updateCell: () => 1,
    ping: () => true
  });
  const { host, posted, saved } = makeHost(
    { exportDatabase: () => new Uint8Array([9, 9, 9]) },   // what a rogue ⌘S would write
    {
      ...members,
      pickDatabase: async () => ({ path: '/tmp/huge-corrupt.db', name: 'huge-corrupt.db', size: 5 * 1024 * 1024 }),
      // The shell refuses the WASM lane's oversize read (native init already refused).
      readDatabaseBytes: async (p: string) => {
        if (p === '/tmp/huge-corrupt.db') throw new Error(SIZE_REFUSAL);
        return new Uint8Array([1, 2, 3]);
      },
      loadSettings: async () => ({ maxFileSize: 1 })
    }
  );
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/precious.db');              // native
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);
  assert.equal(host.hasUnsavedChanges(), true);

  refuseNativeInit = true;
  await assert.rejects(() => host.openDatabaseViaDialog(), /maximum allowed size/);
  // Exactly the SECOND sidecar was reaped, by its own id — never the first.
  assert.deepEqual(log.closedIds, [log.openedIds[1]]);
  assert.equal(host.listDatabases().length, 1);                  // no half-built entry survived

  // The first database is fully intact: its pending edit, and a ⌘S that is a
  // COMMIT on its own sidecar rather than a byte export over the file.
  assert.equal(host.hasUnsavedChanges(), true);
  assert.equal((await host.saveToDisk()).success, true);
  assert.equal(saved.path, undefined);                           // bridge.saveDatabase never ran
  assert.equal(posted.filter(p => p.content.targetMethod === 'exportDatabase').length, 0);
  const init = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(init.filename, 'precious.db');
  assert.equal(init.engine, 'native');
});

test('init-refusal slice, read-throw variant: a readDatabaseBytes failure after the refusal also leaves the first database intact', async () => {
  let refuseNativeInit = false;
  const { txn, exec } = makeTxnFake();
  const { members, log } = makeNativeBridgeMembers({
    initializeDatabase: () => {
      if (refuseNativeInit) throw new Error('file is not a database');
      txn.open = false;
      return { isReadOnly: false, storage: 'memory' };
    },
    runQuery: (args) => exec(args[0]),
    updateCell: () => 1,
    ping: () => true
  });
  const { host, saved } = makeHost(
    { exportDatabase: () => new Uint8Array([9, 9, 9]) },
    {
      ...members,
      readDatabaseBytes: async () => { throw new Error('EACCES: read refused'); }
    }
  );
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/precious.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);

  refuseNativeInit = true;
  await assert.rejects(() => host.openFromShellPath('/tmp/corrupt.db'), /EACCES/);
  assert.deepEqual(log.closedIds, [log.openedIds[1]]);           // only the refused sidecar
  assert.equal(host.listDatabases().length, 1);
  assert.equal(host.hasUnsavedChanges(), true);                  // the pending edit is still there
  assert.equal((await host.saveToDisk()).success, true);
  assert.equal(saved.path, undefined);
  assert.equal(host.hasUnsavedChanges(), false);
});

// NEW IMPORTANT (introduced by round 1): autocommit after a failed COMMIT is
// SQLite's documented auto-rollback signature (SQLITE_FULL/IOERR/NOMEM/
// INTERRUPT may roll the transaction back; checking autocommit is the
// official detection). The probe-false branch used to read that as tolerable
// state noise and let saveToDisk checkpoint + clean the title — a silent
// discard of the session. It must reject loudly instead.
test('an auto-rolled-back COMMIT is a loud failure, not a fake save (fork messages)', async () => {
  const { host, txn } = makeNativeHost({ updateCell: () => 1 }, {}, {}, { txnFlavor: 'fork' });
  await host.start();
  let refreshes = 0;
  host.setWebviewMethods({ refreshContent: async () => { refreshes++; return { success: true }; } });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);
  refreshes = 0;

  txn.autoRollbackNextCommit = true;
  await assert.rejects(() => host.saveToDisk(), /rolled the transaction back|discarded/);
  assert.equal(host.hasUnsavedChanges(), true);          // checkpoint never ran — no fake "saved"
  assert.equal(txn.open, false);                          // engine really is in autocommit
  assert.equal(refreshes, 1);                             // grid told to reload the engine truth
  // Edit txn, the engine's auto-rollback, then the classifying probe's own
  // empty open/close pair (real transitions, so the fake logs them).
  assert.deepEqual(txn.applied, ['BEGIN', 'AUTO-ROLLBACK', 'BEGIN', 'COMMIT']);

  // The session is recoverable: a new edit opens a fresh transaction and a
  // clean save commits it.
  await host.invoke('updateCell', ['t', 1, 'c', 'v2', 'v', 1048576]);
  const ok = await host.saveToDisk();
  assert.equal(ok.success, true);
  assert.deepEqual(txn.applied, ['BEGIN', 'AUTO-ROLLBACK', 'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
});

test('an auto-rolled-back ROLLBACK stays tolerated: the discard intent was fulfilled', async () => {
  // ROLLBACK that fails non-classically while the engine lands in autocommit:
  // the transaction is gone, which is exactly what refresh wanted — the
  // refresh must complete, not error.
  const { txn, exec } = makeTxnFake('fork');
  const initConfigs: unknown[] = [];
  const { host } = makeNativeHost({
    updateCell: () => 1,
    initializeDatabase: (args) => { initConfigs.push(args); txn.open = false; return { isReadOnly: false, storage: 'memory' }; },
    runQuery: (args) => {
      const sql = String(args[0]).trim().toUpperCase();
      if (sql === 'ROLLBACK' && txn.open) {
        txn.open = false;                                 // engine discarded the txn while erroring
        throw new Error('disk I/O error');
      }
      return exec(args[0]);
    }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);

  await host.refreshFromDisk();                           // must not reject
  assert.equal(initConfigs.length, 2);                    // open + refresh reopen (start rides the WASM worker)
  assert.equal(host.hasUnsavedChanges(), false);
});

// ============================================================================
// Final-review fix — I1: grid-mutation-failure txn reconciliation
// ============================================================================

// The grid twin of the auto-rolled-back COMMIT test above: an abort-class
// failure (FULL/IOERR/NOMEM, or INTERRUPT from the sidecar's query deadline)
// on mutation N rolls the WHOLE session transaction back underneath the flag.
// Without reconciliation the grid keeps showing edits 1..N-1 (phantoms) and —
// worse — the NEXT edit rides the stale-true flag: ensureSessionTxn
// early-returns and the SAVEPOINT/RELEASE autocommits straight into the real
// file (persist-without-Save), unrecoverable by Refresh's then-txn-less
// ROLLBACK.
test('an auto-rolled-back mutation reconciles to engine truth: no phantom edits, no persist-without-Save (fork messages)', async () => {
  const { txn, exec, mutate } = makeTxnFake('fork');
  const { host } = makeNativeHost({
    initializeDatabase: () => { txn.open = false; return { isReadOnly: false, storage: 'memory' }; },
    runQuery: (args) => exec(args[0]),
    updateCell: () => mutate()
  });
  await host.start();
  let refreshes = 0;
  host.setWebviewMethods({ refreshContent: async () => { refreshes++; return { success: true }; } });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v1', 'o', 1048576]);   // edit 1
  await host.invoke('updateCell', ['t', 1, 'c', 'v2', 'v1', 1048576]);  // edit 2
  assert.equal(host.hasUnsavedChanges(), true);
  refreshes = 0;

  txn.autoRollbackNextMutation = true;                    // disk fills up on edit 3
  await assert.rejects(
    () => host.invoke('updateCell', ['t', 1, 'c', 'v3', 'v2', 1048576]),
    /disk is full/                                        // the ORIGINAL mutation error, not a probe artifact
  );
  // Engine truth adopted: the whole session was discarded, so nothing is
  // pending anymore (no "Edited" title over phantom values) and the grid was
  // told to reload the engine's real state.
  assert.equal(host.hasUnsavedChanges(), false);
  assert.equal(txn.open, false);
  assert.equal(refreshes, 1);
  // Edit txn, the engine's auto-rollback, then the classifying probe's own
  // empty BEGIN/COMMIT pair — the same signature as the COMMIT-path test.
  assert.deepEqual(txn.applied, ['BEGIN', 'AUTO-ROLLBACK', 'BEGIN', 'COMMIT']);

  // Edit N+1 must open a FRESH transaction (no early-return on a stale flag)
  // and stay pending until ⌘S. mutationsInTxn records whether an enclosing
  // txn existed when each mutation body ran — a false entry means the edit
  // autocommitted to the real file, the exact defect this fix closes.
  await host.invoke('updateCell', ['t', 1, 'c', 'v4', 'v2', 1048576]);
  assert.deepEqual(txn.applied, ['BEGIN', 'AUTO-ROLLBACK', 'BEGIN', 'COMMIT', 'BEGIN']);
  assert.deepEqual(txn.mutationsInTxn, [true, true, true]);  // edits 1, 2 and N+1 all inside a txn
  assert.equal(txn.open, true);                              // still pending…
  assert.equal(host.hasUnsavedChanges(), true);

  const ok = await host.saveToDisk();                        // …until Save commits it
  assert.equal(ok.success, true);
  assert.deepEqual(txn.applied, ['BEGIN', 'AUTO-ROLLBACK', 'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
  assert.equal(host.hasUnsavedChanges(), false);
});

// The probe must CLASSIFY, not blanket-discard: a statement-level failure
// (constraint violation et al.) keeps the transaction open and edits 1..N-1
// validly pending — discarding them here would be the opposite data-loss bug.
// The failing mutation deliberately throws the fork's generic "SQL logic
// error" — the same string as the probe's nesting refusal — proving the
// classification comes from engine state, never from error-string matching.
test('a mutation failure that KEEPS the transaction stays pending: no discard, no stale re-BEGIN', async () => {
  const { txn, exec, mutate } = makeTxnFake('fork');
  let failNext = false;
  const { host } = makeNativeHost({
    initializeDatabase: () => { txn.open = false; return { isReadOnly: false, storage: 'memory' }; },
    runQuery: (args) => exec(args[0]),
    updateCell: () => {
      if (failNext) { failNext = false; throw new Error('SQL logic error'); }  // txn survives (statement-level)
      return mutate();
    }
  });
  await host.start();
  let refreshes = 0;
  host.setWebviewMethods({ refreshContent: async () => { refreshes++; return { success: true }; } });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v1', 'o', 1048576]);
  refreshes = 0;

  failNext = true;
  await assert.rejects(() => host.invoke('updateCell', ['t', 1, 'c', 'v2', 'v1', 1048576]), /SQL logic error/);
  assert.equal(host.hasUnsavedChanges(), true);           // edit 1 is still validly pending
  assert.equal(txn.open, true);                           // probe saw the open txn and kept it
  assert.equal(refreshes, 0);                             // nothing was discarded, nothing to reload

  await host.invoke('updateCell', ['t', 1, 'c', 'v3', 'v1', 1048576]);
  const ok = await host.saveToDisk();
  assert.equal(ok.success, true);
  assert.deepEqual(txn.applied, ['BEGIN', 'COMMIT']);     // ONE txn throughout — no spurious re-BEGIN
  assert.deepEqual(txn.mutationsInTxn, [true, true]);     // both surviving edits ran inside it
});

// ---- I1 completeness: the same stale-flag desync on the two other native
// mutation-failure lanes (barrier DDL, undo/redo replays). All mutation paths
// now ride callMutationGuarded; the console lane is the deliberate exception
// (execution-phase script errors RESOLVE, reconciled on the resolve path).

test('an auto-rolled-back barrier DDL reconciles too: phantom cleared, fresh txn afterwards', async () => {
  const { txn, exec, mutate } = makeTxnFake('fork');
  const { host } = makeNativeHost({
    initializeDatabase: () => { txn.open = false; return { isReadOnly: false, storage: 'memory' }; },
    runQuery: (args) => exec(args[0]),
    updateCell: () => mutate(),
    createTable: () => mutate()
  });
  await host.start();
  let refreshes = 0;
  host.setWebviewMethods({ refreshContent: async () => { refreshes++; return { success: true }; } });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v1', 'o', 1048576]);   // pending edit
  refreshes = 0;

  txn.autoRollbackNextMutation = true;                    // disk fills up on the DDL
  await assert.rejects(() => host.invoke('createTable', ['CREATE TABLE q (a)']), /disk is full/);
  assert.equal(host.hasUnsavedChanges(), false);          // the pending edit died with the session
  assert.equal(txn.open, false);
  assert.equal(refreshes, 1);
  assert.deepEqual(txn.applied, ['BEGIN', 'AUTO-ROLLBACK', 'BEGIN', 'COMMIT']);

  await host.invoke('updateCell', ['t', 1, 'c', 'v2', 'o', 1048576]);   // N+1: fresh txn, pending
  assert.deepEqual(txn.applied, ['BEGIN', 'AUTO-ROLLBACK', 'BEGIN', 'COMMIT', 'BEGIN']);
  assert.deepEqual(txn.mutationsInTxn, [true, true]);     // never a bare autocommitted write
  assert.equal(txn.open, true);
  assert.equal(host.hasUnsavedChanges(), true);
});

test('an auto-rolled-back undo replay reconciles AND leaves no dangling history entry', async () => {
  const { txn, exec, mutate } = makeTxnFake('fork');
  const { host } = makeNativeHost({
    initializeDatabase: () => { txn.open = false; return { isReadOnly: false, storage: 'memory' }; },
    runQuery: (args) => exec(args[0]),
    updateCell: () => mutate(),
    undoModification: () => mutate()
  });
  await host.start();
  let refreshes = 0;
  host.setWebviewMethods({ refreshContent: async () => { refreshes++; return { success: true }; } });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v1', 'o', 1048576]);
  await host.invoke('updateCell', ['t', 1, 'c', 'v2', 'v1', 1048576]);
  refreshes = 0;

  txn.autoRollbackNextMutation = true;                    // the replay hits the abort
  await assert.rejects(() => host.invoke('triggerUndo', []), /disk is full/);
  assert.equal(host.hasUnsavedChanges(), false);          // whole session gone — nothing pending
  assert.equal(txn.open, false);
  assert.equal(refreshes, 1);
  assert.deepEqual(txn.applied, ['BEGIN', 'AUTO-ROLLBACK', 'BEGIN', 'COMMIT']);
  // The stepped entry must NOT dangle: the history died with the session, so
  // BOTH directions are empty — no stepForward-resurrected phantom on the
  // fresh tracker, nothing left to undo.
  // `reason: 'empty'` — not 'barrier'. The viewer reports the two differently
  // ("Nothing to undo" vs naming the operation that walled the history off).
  assert.deepEqual(await host.invoke('triggerUndo', []), { performed: false, reason: 'empty' });
  assert.deepEqual(await host.invoke('triggerRedo', []), { performed: false, reason: 'empty' });

  await host.invoke('updateCell', ['t', 1, 'c', 'v3', 'o', 1048576]);   // fresh txn, pending
  assert.deepEqual(txn.applied, ['BEGIN', 'AUTO-ROLLBACK', 'BEGIN', 'COMMIT', 'BEGIN']);
  assert.deepEqual(txn.mutationsInTxn, [true, true, true]);
  assert.equal(txn.open, true);
  assert.equal(host.hasUnsavedChanges(), true);
});

test('an undo replay failure that KEEPS the transaction restores the stepped entry', async () => {
  const { txn, exec } = makeTxnFake('fork');
  const undoPayloads: unknown[] = [];
  let failUndo = false;
  const { host } = makeNativeHost({
    initializeDatabase: () => { txn.open = false; return { isReadOnly: false, storage: 'memory' }; },
    runQuery: (args) => exec(args[0]),
    updateCell: () => 1,
    undoModification: (args) => {
      undoPayloads.push(args[0]);
      if (failUndo) { failUndo = false; throw new Error('SQL logic error'); }  // txn survives
      return { success: true };
    }
  });
  await host.start();
  let refreshes = 0;
  host.setWebviewMethods({ refreshContent: async () => { refreshes++; return { success: true }; } });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v1', 'o', 1048576]);
  await host.invoke('updateCell', ['t', 1, 'c', 'v2', 'v1', 1048576]);
  refreshes = 0;

  failUndo = true;
  await assert.rejects(() => host.invoke('triggerUndo', []), /SQL logic error/);
  assert.equal(txn.open, true);                           // probe saw the survivor and kept it
  assert.equal(host.hasUnsavedChanges(), true);
  assert.equal(refreshes, 0);

  // The stepped entry went BACK: the retry pops the SAME modification (the
  // v2 edit), not its predecessor — history and database stayed in step.
  const res = await host.invoke('triggerUndo', []) as Record<string, unknown>;
  assert.equal(res.performed, true);
  assert.equal(undoPayloads.length, 2);
  assert.deepEqual(undoPayloads[1], undoPayloads[0]);
  assert.equal(
    (undoPayloads[0] as { affectedCells: Array<{ newValue?: unknown }> }).affectedCells[0].newValue,
    'v2'
  );
  assert.deepEqual(txn.applied, ['BEGIN']);               // one txn throughout
});

test('an auto-rolled-back redo replay reconciles symmetrically', async () => {
  const { txn, exec, mutate } = makeTxnFake('fork');
  const { host } = makeNativeHost({
    initializeDatabase: () => { txn.open = false; return { isReadOnly: false, storage: 'memory' }; },
    runQuery: (args) => exec(args[0]),
    updateCell: () => mutate(),
    undoModification: () => ({ success: true }),
    redoModification: () => mutate()
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/y.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v1', 'o', 1048576]);
  assert.deepEqual(await host.invoke('triggerUndo', []), { performed: true });

  txn.autoRollbackNextMutation = true;
  await assert.rejects(() => host.invoke('triggerRedo', []), /disk is full/);
  assert.equal(host.hasUnsavedChanges(), false);          // no stepForward-dangled entry on the fresh tracker
  assert.equal(txn.open, false);
  assert.deepEqual(await host.invoke('triggerRedo', []), { performed: false, reason: 'empty' });
  assert.deepEqual(txn.applied, ['BEGIN', 'AUTO-ROLLBACK', 'BEGIN', 'COMMIT']);

  await host.invoke('updateCell', ['t', 1, 'c', 'v2', 'o', 1048576]);   // fresh txn, pending
  assert.deepEqual(txn.applied, ['BEGIN', 'AUTO-ROLLBACK', 'BEGIN', 'COMMIT', 'BEGIN']);
  assert.equal(txn.open, true);
});

// ============================================================================
// Multi-database registry: N open databases, one active, swap-on-switch
// ============================================================================

/** Settles to 'pending' if `promise` has not settled within a macrotask hop. */
async function stillPending(promise: Promise<unknown>): Promise<string> {
  return Promise.race([
    promise.then(() => 'resolved', () => 'rejected'),
    new Promise<string>(resolve => setTimeout(() => resolve('pending'), 5))
  ]);
}

/** A host with N independent native sidecars, each with its own txn state. */
function makeMultiNativeHost(extraHandlers: Record<string, (args: unknown[], dbId: string) => unknown> = {}) {
  const txns = new Map<string, ReturnType<typeof makeTxnFake>>();
  const txnFor = (dbId: string) => {
    if (!txns.has(dbId)) txns.set(dbId, makeTxnFake());
    return txns.get(dbId)!;
  };
  const { members, log } = makeNativeBridgeMembers({
    initializeDatabase: (_args, dbId) => { txnFor(dbId).txn.open = false; return { isReadOnly: false, storage: 'memory' }; },
    runQuery: (args, dbId) => txnFor(dbId).exec(args[0]),
    updateCell: () => 1,
    undoModification: () => ({ success: true }),
    ping: () => true,
    ...extraHandlers
  });
  const made = makeHost({}, members);
  return { ...made, nativeLog: log, txnFor };
}

// ---------------------------------------------------------------------------
// The classification itself. A per-database field wrongly classified global (or
// simply forgotten) leaks one database's grid, filters or selection into
// another — the defining defect of swap-on-switch. This test makes the
// classification exhaustive by construction, so a field added to `state` later
// fails here instead of leaking silently.
// ---------------------------------------------------------------------------

test('state field classification covers every field of the state singleton exactly once', async () => {
  const classified = [...PER_DB_STATE_FIELDS, ...TRANSIENT_STATE_FIELDS, ...GLOBAL_STATE_FIELDS];
  assert.equal(new Set(classified).size, classified.length, 'a field is classified twice');
  assert.deepEqual(
    [...classified].sort(),
    Object.keys(state).sort(),
    'every state field must be per-database, transient, or explicitly global'
  );
});

// ---------------------------------------------------------------------------
// Two databases, independent in every dimension the host owns.
// ---------------------------------------------------------------------------

test('two open databases keep independent undo history, dirty state and session transactions', async () => {
  const { host, nativeLog, txnFor } = makeMultiNativeHost();
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });

  await host.openFromShellPath('/tmp/a.db');
  const [idA] = nativeLog.openedIds;
  await host.invoke('updateCell', ['t', 1, 'c', 'a1', 'a0', 1048576]);   // A is dirty
  const dbA = host.activeDatabaseId()!;

  await host.openFromShellPath('/tmp/b.db');
  const idB = nativeLog.openedIds[1];
  const dbB = host.activeDatabaseId()!;
  assert.notEqual(dbA, dbB);

  // B is clean and has no transaction; A still holds both. Per-database dirt
  // is read from listDatabases — hasUnsavedChanges() is the app-wide question.
  const dirtyOf = (name: string) => host.listDatabases().find(d => d.name === name)!.isDirty;
  assert.deepEqual([dirtyOf('a.db'), dirtyOf('b.db')], [true, false]);
  assert.equal(txnFor(idA).txn.open, true);
  assert.equal(txnFor(idB).txn.open, false);
  assert.deepEqual(
    host.listDatabases().map(d => [d.name, d.isDirty, d.isActive]),
    [['a.db', true, false], ['b.db', false, true]]
  );

  // B's own edit opens B's OWN transaction and does not touch A's history.
  await host.invoke('updateCell', ['t', 2, 'c', 'b1', 'b0', 1048576]);
  assert.equal(txnFor(idB).txn.open, true);
  assert.deepEqual(txnFor(idA).txn.applied, ['BEGIN']);
  assert.deepEqual(txnFor(idB).txn.applied, ['BEGIN']);

  // Saving B commits B's transaction only: A stays dirty and pending.
  assert.equal((await host.saveToDisk()).success, true);
  assert.deepEqual(txnFor(idB).txn.applied, ['BEGIN', 'COMMIT']);
  assert.deepEqual(txnFor(idA).txn.applied, ['BEGIN']);
  assert.deepEqual([dirtyOf('a.db'), dirtyOf('b.db')], [true, false]);

  // Switching back finds A exactly as it was left: dirty, with its own undo
  // entry still on the stack.
  assert.equal(await host.setActiveDb(dbA), true);
  assert.equal(dirtyOf('a.db'), true);
  assert.deepEqual(await host.invoke('triggerUndo', []), { performed: true });
  assert.deepEqual([dirtyOf('a.db'), dirtyOf('b.db')], [false, false]);
  // …and B's history was never consumed by A's undo.
  await host.setActiveDb(dbB);
  assert.deepEqual(await host.invoke('triggerUndo', []), { performed: true });
});

test('every native envelope carries its own database\'s sidecar id — never another\'s', async () => {
  const { host, nativeLog } = makeMultiNativeHost({ fetchSchema: (_a, dbId) => ({ tables: [{ name: dbId }], views: [], indexes: [] }) });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  const dbA = host.activeDatabaseId()!;
  await host.openFromShellPath('/tmp/b.db');
  const [idA, idB] = nativeLog.openedIds;

  const fromB = await host.invoke('fetchSchema', []) as { tables: Array<{ name: string }> };
  assert.deepEqual(fromB.tables, [{ name: idB }]);
  await host.setActiveDb(dbA);
  const fromA = await host.invoke('fetchSchema', []) as { tables: Array<{ name: string }> };
  assert.deepEqual(fromA.tables, [{ name: idA }]);

  // Every envelope's addressed id matches the database whose open produced it:
  // A's initializeDatabase must never be framed at B's sidecar, and vice versa.
  const initIds = nativeLog.envelopes
    .map((envelope, index) => [envelope.content.targetMethod, nativeLog.envelopeIds[index]] as const)
    .filter(([method]) => method === 'initializeDatabase')
    .map(([, id]) => id);
  assert.deepEqual(initIds, [idA, idB]);
  const initPaths = nativeLog.envelopes
    .filter(envelope => envelope.content.targetMethod === 'initializeDatabase')
    .map(envelope => (envelope.content.payload[1] as Record<string, unknown>).path);
  assert.deepEqual(initPaths, ['/private/tmp/a.db', '/private/tmp/b.db']);
});

// ---------------------------------------------------------------------------
// Swap-on-switch: `state` keeps its identity, its per-database fields do not.
// ---------------------------------------------------------------------------

test('setActiveDb restores the incoming database\'s UI state and preserves the outgoing one\'s', async () => {
  const { host } = makeHost({ fetchSchema: () => ({ tables: [], views: [], indexes: [] }) });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  const stateIdentity = state;

  await host.openFromShellPath('/tmp/a.db');
  const dbA = host.activeDatabaseId()!;
  // What the user did in A.
  state.selectedTable = 'users';
  state.selectedTableType = 'table';
  state.currentPageIndex = 3;
  state.columnFilters = { name: 'ali' };
  state.filterQuery = 'ali';
  state.selectedRowIds = new Set([1, 2, 3]);
  state.columnWidths = { name: 240 };
  state.gridData = [['a']];
  state.schemaCache = { tables: [{ name: 'users' }], views: [], indexes: [] };
  state.sidebarFilter = 'us';
  state.matchNav = { scope: 'name', term: 'ali', matches: [{ rowIdx: 0, colIdx: 0 }], currentIndex: 0 };
  const aRowIds = state.selectedRowIds;

  await host.openFromShellPath('/tmp/b.db');
  const dbB = host.activeDatabaseId()!;
  // B starts clean: nothing of A's survived into it. The column dictionaries
  // are null-prototype (state.js createSafeColumnState), so a column named
  // `__proto__` stays a key — hence the prototype-exact comparison.
  assert.equal(state.selectedTable, null);
  assert.deepEqual(state.columnFilters, Object.create(null));
  assert.equal(Object.getPrototypeOf(state.columnFilters), null);
  assert.equal(state.filterQuery, '');
  assert.equal(state.selectedRowIds.size, 0);
  assert.notEqual(state.selectedRowIds, aRowIds);          // a fresh Set, not A's
  assert.deepEqual(state.columnWidths, Object.create(null));
  assert.equal(Object.getPrototypeOf(state.columnWidths), null);
  assert.deepEqual(state.gridData, []);
  assert.deepEqual(state.schemaCache, { tables: [], views: [], indexes: [] });
  assert.equal(state.sidebarFilter, '');
  assert.deepEqual(state.matchNav, { scope: null, term: null, matches: [], currentIndex: -1 });

  state.selectedTable = 'orders';
  state.columnFilters = { total: '>100' };
  state.selectedRowIds = new Set([9]);

  // Back to A: its state comes back intact, including container identity.
  assert.equal(await host.setActiveDb(dbA), true);
  assert.equal(state, stateIdentity, 'the state object identity must survive the swap');
  assert.equal(state.selectedTable, 'users');
  assert.equal(state.currentPageIndex, 3);
  assert.deepEqual(state.columnFilters, { name: 'ali' });
  assert.equal(state.filterQuery, 'ali');
  assert.deepEqual([...state.selectedRowIds], [1, 2, 3]);
  assert.equal(state.selectedRowIds, aRowIds);
  assert.deepEqual(state.columnWidths, { name: 240 });
  assert.deepEqual(state.schemaCache, { tables: [{ name: 'users' }], views: [], indexes: [] });
  assert.equal(state.sidebarFilter, 'us');
  assert.equal(state.matchNav.term, 'ali');

  // And B's edits since the switch were preserved on B, not lost or merged.
  assert.equal(await host.setActiveDb(dbB), true);
  assert.equal(state.selectedTable, 'orders');
  assert.deepEqual(state.columnFilters, { total: '>100' });
  assert.deepEqual([...state.selectedRowIds], [9]);
});

test('a switch resets transient interaction state and leaves global preferences alone', async () => {
  const { host } = makeHost({});
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  const dbA = host.activeDatabaseId()!;
  await host.openFromShellPath('/tmp/b.db');

  // Global preferences the user set once, for the whole app.
  state.rowsPerPage = 250;
  state.dateFormat = 'iso';
  state.cellEditBehavior = 'modal';
  state.cellPreviewWrapEnabled = false;
  state.isDesktop = true;
  // Mid-interaction junk that must NOT travel to another database.
  state.isGridReloading = true;
  state.isSavingCell = true;
  state.resizingColumn = 'name';
  state.resizeStartX = 42;
  state.activeCellInput = { fake: 'dom node' } as unknown as null;
  state.filterApplyPending = true;
  state.filterApplyTable = 'users';
  state.lastDoubleClickTime = 999;
  state.filterTimer = setTimeout(() => { throw new Error('a stale debounce fired into another database'); }, 50) as unknown as null;

  await host.setActiveDb(dbA);

  assert.equal(state.rowsPerPage, 250);
  assert.equal(state.dateFormat, 'iso');
  assert.equal(state.cellEditBehavior, 'modal');
  assert.equal(state.cellPreviewWrapEnabled, false);
  assert.equal(state.isDesktop, true);

  assert.equal(state.isGridReloading, false);
  assert.equal(state.isSavingCell, false);
  assert.equal(state.resizingColumn, null);
  assert.equal(state.resizeStartX, 0);
  assert.equal(state.activeCellInput, null);
  assert.equal(state.filterApplyPending, false);
  assert.equal(state.filterApplyTable, null);
  assert.equal(state.lastDoubleClickTime, 0);
  assert.equal(state.filterTimer, null);
  // The armed debounce was CLEARED, not merely forgotten: give it more than its
  // own delay to prove it never fires.
  await new Promise(resolve => setTimeout(resolve, 60));
});

test('the switch notifies the page after the swap and before the reload, and reports the registry', async () => {
  const order: string[] = [];
  let switchedTable: unknown = 'unset';
  const lists: Array<Array<Record<string, unknown>>> = [];
  const { host } = makeHost({});
  host.setWebviewMethods({
    refreshContent: async () => { order.push('refreshContent'); return { success: true }; },
    databaseSwitched: async () => {
      order.push('databaseSwitched');
      switchedTable = state.selectedTable;   // the swap has already happened
      return { success: true };
    },
    databasesChanged: async (list: unknown) => { lists.push(list as Array<Record<string, unknown>>); return undefined; }
  });
  await host.start();
  await host.openFromShellPath('/tmp/a.db');
  const dbA = host.activeDatabaseId()!;
  state.selectedTable = 'users';
  await host.openFromShellPath('/tmp/b.db');

  order.length = 0;
  await host.setActiveDb(dbA);
  assert.deepEqual(order, ['databaseSwitched', 'refreshContent']);
  assert.equal(switchedTable, 'users');   // A's selection was already restored

  const latest = lists.at(-1)!;
  assert.deepEqual(latest.map(d => [d.name, d.isActive]), [['a.db', true], ['b.db', false]]);
});

// ---------------------------------------------------------------------------
// Call settlement: one pending map, N databases, no cross-talk.
// ---------------------------------------------------------------------------

test('a pending call for one database is never settled by another database\'s response', async () => {
  const foreignRows = { tables: [{ name: 'B_ROWS' }], views: [], indexes: [] };
  const ownRows = { tables: [{ name: 'A_ROWS' }], views: [], indexes: [] };
  const { host, posted, workers } = makeHost({ fetchSchema: () => NO_REPLY });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  const workerA = workers.at(-1)!;
  await host.openFromShellPath('/tmp/b.db');
  const workerB = workers.at(-1)!;
  const dbA = host.listDatabases()[0].dbId;

  await host.setActiveDb(dbA);
  const inFlight = host.invoke('fetchSchema', []);        // held open by NO_REPLY
  const messageId = posted.at(-1)!.content.messageId;

  // B's worker answers with A's messageId — the shape a mis-routed or hostile
  // response takes. It must not settle A's caller.
  workerB.onmessage?.({ data: { channel: 'rpc', content: { kind: 'response', messageId, success: true, data: foreignRows } } });
  assert.equal(await stillPending(inFlight), 'pending');

  // The call is still A's to settle, and A's own answer still works.
  workerA.onmessage?.({ data: { channel: 'rpc', content: { kind: 'response', messageId, success: true, data: ownRows } } });
  assert.deepEqual(await inFlight, ownRows);
});

test('a worker crash fans out only its own database\'s calls', async () => {
  const { host, posted, workers } = makeHost({ fetchSchema: () => NO_REPLY });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  const workerA = workers.at(-1)!;
  await host.openFromShellPath('/tmp/b.db');
  const workerB = workers.at(-1)!;
  const [dbA, dbB] = host.listDatabases().map(d => d.dbId);

  const inFlightB = host.invoke('fetchSchema', []);       // B is active
  const messageIdB = posted.at(-1)!.content.messageId;
  await host.setActiveDb(dbA);
  const inFlightA = host.invoke('fetchSchema', []);
  assert.equal(dbA !== dbB, true);

  workerA.onerror?.(new Error('boom'));
  await assert.rejects(() => inFlightA, /Worker crashed: boom/);
  assert.equal(await stillPending(inFlightB), 'pending');

  const rows = { tables: [], views: [], indexes: [] };
  workerB.onmessage?.({ data: { channel: 'rpc', content: { kind: 'response', messageId: messageIdB, success: true, data: rows } } });
  assert.deepEqual(await inFlightB, rows);
});

// ---------------------------------------------------------------------------
// Close.
// ---------------------------------------------------------------------------

test('closing one database leaves the other serving, closes exactly its own sidecar, and fails only its own calls', async () => {
  const { host, nativeLog } = makeMultiNativeHost({
    fetchSchema: (_args, dbId) => ({ tables: [{ name: dbId }], views: [], indexes: [] })
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  const dbA = host.activeDatabaseId()!;
  await host.openFromShellPath('/tmp/b.db');
  const dbB = host.activeDatabaseId()!;
  const [idA, idB] = nativeLog.openedIds;

  await host.setActiveDb(dbA);
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);   // A is dirty
  assert.equal(host.hasUnsavedChanges(), true);

  assert.equal(await host.closeDatabase(dbA), true);
  // Exactly one close, addressed to A's own sidecar. nativeClose is NOT
  // idempotent shell-side, so a second one would reject loudly.
  assert.deepEqual(nativeLog.closedIds, [idA]);
  // B became active and answers from its OWN sidecar.
  assert.equal(host.activeDatabaseId(), dbB);
  assert.deepEqual(host.listDatabases().map(d => d.name), ['b.db']);
  assert.deepEqual(await host.invoke('fetchSchema', []), { tables: [{ name: idB }], views: [], indexes: [] });
  assert.equal(host.hasUnsavedChanges(), false);          // A's dirty flag left with A
  assert.equal((await host.invoke('initialize', []) as Record<string, unknown>).filename, 'b.db');
});

test('closing a database rejects its in-flight calls and only those', async () => {
  const { host, workers } = makeHost({ fetchSchema: () => NO_REPLY });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  await host.openFromShellPath('/tmp/b.db');
  const workerB = workers.at(-1)!;
  const [dbA, dbB] = host.listDatabases().map(d => d.dbId);

  const inFlightB = host.invoke('fetchSchema', []);       // B active
  await host.setActiveDb(dbA);
  const inFlightA = host.invoke('fetchSchema', []);

  await host.closeDatabase(dbA);
  await assert.rejects(() => inFlightA, /Database "a\.db" was closed/);
  assert.equal(await stillPending(inFlightB), 'pending');
  assert.equal(host.activeDatabaseId(), dbB);
  assert.equal(workerB.terminated, false);                // B's engine untouched
  // inFlightB is deliberately left unsettled — that IS the assertion. Attach a
  // handler so an unhandled-rejection warning can never appear if it ever does.
  void inFlightB.catch(() => undefined);
});

test('closing the last database leaves a fresh empty one, not a dead host', async () => {
  const { host, nativeLog } = makeMultiNativeHost();
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  const dbA = host.activeDatabaseId()!;

  assert.equal(await host.closeDatabase(dbA), true);
  assert.deepEqual(nativeLog.closedIds, nativeLog.openedIds);
  const open = host.listDatabases();
  assert.equal(open.length, 1);
  assert.deepEqual([open[0].name, open[0].path, open[0].engine, open[0].isActive], ['untitled.db', null, 'wasm', true]);
  // Still a working host: the replacement answers RPCs.
  assert.equal((await host.invoke('initialize', []) as Record<string, unknown>).filename, 'untitled.db');
  assert.equal(await host.invoke('ping', []), true);
});

test('closing a background database keeps the active one active', async () => {
  const { host } = makeHost({});
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  await host.openFromShellPath('/tmp/b.db');
  const [dbA, dbB] = host.listDatabases().map(d => d.dbId);

  state.selectedTable = 'orders';                          // B's selection
  await host.closeDatabase(dbA);
  assert.equal(host.activeDatabaseId(), dbB);
  assert.equal(state.selectedTable, 'orders');             // no swap happened
  assert.deepEqual(host.listDatabases().map(d => d.name), ['b.db']);
});

test('setActiveDb and closeDatabase refuse an unknown id instead of picking another database', async () => {
  const { host } = makeHost({});
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  const dbA = host.activeDatabaseId()!;

  await assert.rejects(() => host.setActiveDb('db#999'), /unknown database id/);
  await assert.rejects(() => host.closeDatabase(''), /unknown database id/);
  assert.equal(host.activeDatabaseId(), dbA);
  assert.deepEqual(host.listDatabases().map(d => d.name), ['a.db']);
  // Re-selecting the active database is a no-op, not an error.
  assert.equal(await host.setActiveDb(dbA), false);
});

// ---------------------------------------------------------------------------
// The open cap. Each WASM database is its own Worker holding its own copy of
// the file; each native one is its own sidecar process. The shell caps
// sidecars at 16 — nothing capped the WASM lane, and tabs make N reachable.
// ---------------------------------------------------------------------------

test('opening past the cap is refused with a message naming it, and the registry is untouched', async () => {
  const { host, workers } = makeHost({});
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });

  // The boot placeholder is clean, so the first open replaces it: filling the
  // registry to the cap takes exactly MAX_OPEN_DATABASES opens.
  for (let i = 0; i < MAX_OPEN_DATABASES; i++) {
    assert.equal(await host.openFromShellPath(`/tmp/db${i}.db`), true);
  }
  assert.equal(host.listDatabases().length, MAX_OPEN_DATABASES);
  const workersAtCap = workers.length;

  await assert.rejects(
    () => host.openFromShellPath('/tmp/one-too-many.db'),
    new RegExp(`${MAX_OPEN_DATABASES} databases are already open`)
  );
  // Refused BEFORE anything was built: no worker booted, no entry added, and
  // the database the user was looking at is still the active one.
  assert.equal(workers.length, workersAtCap);
  assert.equal(host.listDatabases().length, MAX_OPEN_DATABASES);
  assert.equal(host.listDatabases().find(d => d.isActive)!.name, `db${MAX_OPEN_DATABASES - 1}.db`);

  // A file that is ALREADY open still switches at the cap: the dedupe runs
  // first, so the cap can never wall the user off from an open database.
  const first = host.listDatabases()[0].dbId;
  assert.equal(await host.openFromShellPath('/tmp/db0.db'), true);
  assert.equal(host.activeDatabaseId(), first);

  // Closing one makes room again.
  assert.equal(await host.closeDatabase(first), true);
  assert.equal(await host.openFromShellPath('/tmp/one-too-many.db'), true);
  assert.equal(host.listDatabases().length, MAX_OPEN_DATABASES);
});

test('the drag-and-drop lane is capped too', async () => {
  // Drag-and-drop no longer has a lane of its own: Tauri handles OS file drops
  // natively, so a dropped database arrives as a PATH through the bridge's
  // onDragDropPaths and opens through openFromShellPath — the same lane, and
  // therefore the same cap, as Open With and Open Recent. (The removed
  // host.openDatabaseFromFile(File) had no call site in core/ at all.)
  const { host } = makeHost({});
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  for (let i = 0; i < MAX_OPEN_DATABASES; i++) await host.openFromShellPath(`/tmp/db${i}.db`);

  await assert.rejects(
    () => host.openFromShellPath('/tmp/dropped.db'),
    new RegExp(`${MAX_OPEN_DATABASES} databases are already open`)
  );
  assert.equal(host.listDatabases().length, MAX_OPEN_DATABASES);
});

test('the cap holds when opens RACE, not only when they are awaited one at a time', async () => {
  // Found live: 14 files "Open With"-ed at once against 3 already open left 17
  // databases against a cap of 16, and the shell — whose MAX_NATIVE_SIDECARS is
  // the SAME number, enforced synchronously in Rust — refused the surplus a
  // sidecar, so it silently ran on WASM instead.
  //
  // This is a real race, not a simulation of one: openFromShellPath runs
  // SYNCHRONOUSLY as far as its first await (readDatabaseBytes), which is after
  // the cap check, so every request below passes that check in the same
  // synchronous burst, while the registry still holds one database.
  // Serialising a caller cannot fix this — a Finder multi-selection, an OS file
  // drop and a dialog open are three separate callers that can race each other.
  const { host, workers } = makeHost({});
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  // One sequential open first, so the boot placeholder is already replaced and
  // the arithmetic below is exact: the cap counts the scratch database like any
  // other while it is still registered.
  await host.openFromShellPath('/tmp/first.db');

  const overshoot = 4;
  const burst = Array.from(
    { length: MAX_OPEN_DATABASES - 1 + overshoot },
    (_, i) => `/tmp/race${i}.db`
  );
  const settled = await Promise.allSettled(burst.map(p => host.openFromShellPath(p)));

  const refused = settled.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(settled.filter(r => r.status === 'fulfilled').length, MAX_OPEN_DATABASES - 1);
  assert.equal(refused.length, overshoot);
  for (const rejection of refused) {
    assert.match(
      String(rejection.reason?.message),
      new RegExp(`${MAX_OPEN_DATABASES} databases are already open`)
    );
  }
  // The registry itself is the invariant: at most one database per slot, no
  // matter how the opens interleaved.
  assert.equal(host.listDatabases().length, MAX_OPEN_DATABASES);

  // …and the refusals cost nothing: one worker for the boot placeholder plus
  // one per opened database, none for the four that were turned away.
  assert.equal(workers.length, MAX_OPEN_DATABASES + 1);

  // The cap is not merely sticky: closing one makes room for exactly one more,
  // so the in-flight accounting released every reservation it took.
  assert.equal(await host.closeDatabase(host.listDatabases()[0].dbId), true);
  assert.equal(await host.openFromShellPath('/tmp/after-close.db'), true);
  assert.equal(host.listDatabases().length, MAX_OPEN_DATABASES);
  await assert.rejects(
    () => host.openFromShellPath('/tmp/one-too-many.db'),
    new RegExp(`${MAX_OPEN_DATABASES} databases are already open`)
  );
});

test('a failed open releases its cap reservation', async () => {
  // The reservation is taken before the engine work and released in a finally,
  // so a burst that mostly FAILS must not leave the cap permanently consumed —
  // otherwise a run of unreadable files would wall the user off from every
  // database until the window was reopened.
  const failing = new Set(['/tmp/bad0.db', '/tmp/bad1.db', '/tmp/bad2.db']);
  const { host } = makeHost({}, {
    readDatabaseBytes: async (p: string) => {
      if (failing.has(p)) throw new Error(`EACCES: ${p}`);
      return new Uint8Array([1, 2, 3]);
    }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });

  const settled = await Promise.allSettled([...failing].map(p => host.openFromShellPath(p)));
  assert.equal(settled.filter(r => r.status === 'rejected').length, failing.size);

  // Room for a full registry afterwards: the boot placeholder is still the only
  // entry, so MAX_OPEN_DATABASES more opens must all succeed.
  for (let i = 0; i < MAX_OPEN_DATABASES; i++) {
    assert.equal(await host.openFromShellPath(`/tmp/ok${i}.db`), true);
  }
  assert.equal(host.listDatabases().length, MAX_OPEN_DATABASES);
});

test('saving a READ-ONLY database is refused by name instead of reported as saved', async () => {
  // Found live on a database in a read-only directory: ⌘S put "Saved
  // locked.db" in the status bar while the file on disk was untouched, right
  // after the grid had failed. Nothing was pending (a read-only database
  // refuses every mutation), so it was not a write that failed — it was a
  // completed-sounding report of an operation that never ran, on the one file
  // where that matters most.
  const READ_ONLY_REASON =
    'This database cannot be written by this process, so it is open read-only.';
  const { host, saved } = makeHost({
    initializeDatabase: (args: unknown[]) =>
      // The boot placeholder is writable; only the opened file is not.
      (args[1] as { content?: unknown })?.content === undefined
        ? { isReadOnly: false, storage: 'memory' }
        : { isReadOnly: true, storage: 'memory', readOnlyReason: READ_ONLY_REASON }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/locked.db');

  const result = await host.saveToDisk() as {
    success: boolean; reason?: string; message?: string; savedAs?: string;
  };
  assert.equal(result.success, false);
  assert.equal(result.reason, 'read-only');
  // The engine's own words, so the refusal says WHY rather than just "no".
  assert.equal(result.message, READ_ONLY_REASON);
  assert.equal(result.savedAs, 'locked.db');
  // …and nothing was written: the refusal happens before the save path runs.
  assert.equal(saved.path, undefined);
  assert.equal(saved.savedAsPath, undefined);
});

test('a writable database still saves normally', async () => {
  // The control for the refusal above: the read-only branch must not swallow
  // the ordinary save.
  const { host, saved } = makeHost({ exportDatabase: () => new Uint8Array([7, 8, 9]) });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/writable.db');
  assert.deepEqual(await host.saveToDisk(), { success: true, savedAs: 'writable.db' });
  assert.equal(saved.path, '/tmp/writable.db');
  assert.deepEqual([...(saved.bytes ?? [])], [7, 8, 9]);
});

// ---------------------------------------------------------------------------
// Dedupe: one file, one entry. The shell does not de-duplicate, so a second
// open of one file would otherwise spawn a second WRITABLE sidecar on it, with
// its own session transaction — SQLITE_BUSY and two racing saves.
// ---------------------------------------------------------------------------

test('opening an already-open file switches to it instead of opening a second instance', async () => {
  const { host, nativeLog } = makeMultiNativeHost();
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  const dbA = host.activeDatabaseId()!;
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);   // pending edit in A
  await host.openFromShellPath('/tmp/b.db');
  assert.equal(nativeLog.opens.length, 2);

  assert.equal(await host.openFromShellPath('/tmp/a.db'), true);
  assert.equal(host.activeDatabaseId(), dbA);              // switched, not duplicated
  assert.equal(nativeLog.opens.length, 2);                 // no third sidecar spawned
  assert.deepEqual(host.listDatabases().map(d => d.name), ['a.db', 'b.db']);
  // Re-opening did NOT discard the pending edit by re-reading the file.
  assert.equal(host.hasUnsavedChanges(), true);
});

test('a second spelling of an already-open native file resolves to the same entry and reaps the duplicate sidecar', async () => {
  // The shell canonicalises, so one file has two spellings the host can be
  // handed. The canonical one is caught before any spawn; a symlink (or any
  // other alias) is only revealed by the RETURNED boundPath, and the sidecar
  // that probe spawned must then be reaped — exactly once, by its own id.
  const { members, log } = makeNativeBridgeMembers({
    initializeDatabase: () => ({ isReadOnly: false, storage: 'memory' }),
    runQuery: () => [],
    ping: () => true
  });
  const realOpen = members.nativeOpen;
  members.nativeOpen = async (path: string, readOnly: boolean) => {
    const opened = await realOpen(path, readOnly);
    // A symlink: a different spelling, the same file underneath.
    return path === '/tmp/link-to-a.db' ? { ...opened, boundPath: '/private/tmp/a.db' } : opened;
  };
  const { host } = makeHost({}, members);
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  const dbA = host.activeDatabaseId()!;
  await host.openFromShellPath('/tmp/b.db');
  assert.equal(host.listDatabases().length, 2);

  // The canonical spelling: caught by the pre-open pass, nothing spawned.
  assert.equal(await host.openFromShellPath('/private/tmp/a.db'), true);
  assert.equal(host.activeDatabaseId(), dbA);
  assert.equal(log.opens.length, 2);
  assert.deepEqual(log.closedIds, []);

  await host.setActiveDb(host.listDatabases()[1].dbId);    // back to b.db
  // The symlink: only the boundPath reveals it, so a sidecar IS spawned — and
  // immediately reaped, leaving the original entry active.
  assert.equal(await host.openFromShellPath('/tmp/link-to-a.db'), true);
  assert.equal(host.activeDatabaseId(), dbA);
  assert.equal(host.listDatabases().length, 2);            // still two databases
  assert.equal(log.opens.length, 3);
  assert.deepEqual(log.closedIds, [log.openedIds[2]]);     // only the duplicate
});

test('WASM opens de-duplicate by path too, without re-reading the file', async () => {
  let reads = 0;
  const { host } = makeHost({}, {
    readDatabaseBytes: async () => { reads += 1; return new Uint8Array([1, 2, 3]); }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  const dbA = host.activeDatabaseId()!;
  await host.openFromShellPath('/tmp/b.db');
  assert.equal(reads, 2);

  await host.openFromShellPath('/tmp/a.db');
  assert.equal(host.activeDatabaseId(), dbA);
  assert.equal(reads, 2);                                  // no re-read, no second worker
  assert.equal(host.listDatabases().length, 2);
});

// ---------------------------------------------------------------------------
// The boot placeholder.
// ---------------------------------------------------------------------------

test('the empty boot database is replaced by the first real open, not left behind as a tab', async () => {
  const { host, workers } = makeHost({});
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  assert.deepEqual(host.listDatabases().map(d => d.name), ['untitled.db']);
  const scratchWorker = workers[0];

  await host.openFromShellPath('/tmp/a.db');
  assert.deepEqual(host.listDatabases().map(d => [d.name, d.isActive]), [['a.db', true]]);
  assert.equal(scratchWorker.terminated, true);            // its engine was reclaimed
});

test('an EDITED boot database is kept: it has no path, so dropping it would destroy the work', async () => {
  const { host } = makeHost({ updateCell: () => 1 });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);
  assert.equal(host.hasUnsavedChanges(), true);

  await host.openFromShellPath('/tmp/a.db');
  assert.deepEqual(
    host.listDatabases().map(d => [d.name, d.isDirty, d.isActive]),
    [['untitled.db', true, false], ['a.db', false, true]]
  );
});

// ---------------------------------------------------------------------------
// Single-database behavior is the status quo: one open file is one tab, and the
// public shape Tasks 3/4 render from is exactly this.
// ---------------------------------------------------------------------------

test('listDatabases reports the documented shape for a single open database', async () => {
  const { host } = makeMultiNativeHost();
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/only.db');
  const [only, ...rest] = host.listDatabases();
  assert.deepEqual(rest, []);
  assert.deepEqual(Object.keys(only).sort(), ['dbId', 'engine', 'isActive', 'isDirty', 'name', 'path'].sort());
  assert.deepEqual(
    [only.name, only.path, only.engine, only.isDirty, only.isActive],
    ['only.db', '/tmp/only.db', 'native', false, true]
  );
  assert.equal(only.dbId, host.activeDatabaseId());
});

test('two concurrent opens of one path resolve to a single database, not two sidecars', async () => {
  let releaseOpen!: () => void;
  const gate = new Promise<void>((resolve) => { releaseOpen = resolve; });
  const { members, log } = makeNativeBridgeMembers({
    initializeDatabase: () => ({ isReadOnly: false, storage: 'memory' }),
    runQuery: () => [],
    ping: () => true
  });
  const realOpen = members.nativeOpen;
  members.nativeOpen = async (path: string, readOnly: boolean) => {
    await gate;                                          // hold the first open mid-spawn
    return realOpen(path, readOnly);
  };
  const { host } = makeHost({}, members);
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });

  // Back-to-back shell deliveries of the same file (a double-clicked Finder
  // item), the second arriving before the first finished spawning.
  const first = host.openFromShellPath('/tmp/twice.db');
  const second = host.openFromShellPath('/tmp/twice.db');
  releaseOpen();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);

  assert.equal(log.opens.length, 1);                     // one sidecar, not two
  assert.deepEqual(host.listDatabases().map(d => d.name), ['twice.db']);
});

// ============================================================================
// Fix round 1 — review defects
// ============================================================================

// An inline edit is a <textarea> the incoming database's render destroys, and
// `editingCellInfo`/`activeCellInput` are set and cleared together. If the
// descriptor were per-database while its input is transient, switching BACK to
// a database left mid-edit would restore a non-null editingCellInfo with a null
// activeCellInput — a state the codebase reads as "an editor is live":
// loadTableData skips renderDataGrid (leaving the OUTGOING database's rows on
// screen over the incoming one's gridData), editorHoldsWindow() returns true so
// the virtual window freezes, and grid clicks/Enter/shortcuts are swallowed.
// Reachable with no tab strip at all — Open Recent and the open-dedupe switch
// both call setActiveDb.
test('an inline edit does not survive a database switch in either direction', async () => {
  assert.equal(TRANSIENT_STATE_FIELDS.includes('editingCellInfo'), true,
    'editingCellInfo must be transient: its <textarea> cannot survive the switch');
  assert.equal(PER_DB_STATE_FIELDS.includes('editingCellInfo'), false);
  // The pair must stay in the SAME class — that is the invariant, not the class.
  assert.equal(TRANSIENT_STATE_FIELDS.includes('activeCellInput'), true);

  const { host } = makeHost({});
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  const dbA = host.activeDatabaseId()!;
  await host.openFromShellPath('/tmp/b.db');
  const dbB = host.activeDatabaseId()!;

  // The user is mid-edit in A when a Finder open / recent switches away.
  await host.setActiveDb(dbA);
  state.selectedTable = 'users';
  state.editingCellInfo = { table: 'users', rowId: 1, column: 'name' };
  state.activeCellInput = { fake: 'textarea' } as unknown as null;

  await host.setActiveDb(dbB);
  assert.equal(state.editingCellInfo, null);
  assert.equal(state.activeCellInput, null);

  // …and coming back does not resurrect it.
  await host.setActiveDb(dbA);
  assert.equal(state.selectedTable, 'users');       // the selection DID survive
  assert.equal(state.editingCellInfo, null);        // the editor did not
  assert.equal(state.activeCellInput, null);
});

test('a throwing databaseSwitched handler cannot leave the switch half-applied', async () => {
  const { host } = makeHost({});
  let refreshed = 0;
  host.setWebviewMethods({
    refreshContent: async () => { refreshed++; return { success: true }; },
    databaseSwitched: async () => { throw new Error('page handler blew up'); }
  });
  await host.start();
  await host.openFromShellPath('/tmp/a.db');
  const dbA = host.activeDatabaseId()!;
  await host.openFromShellPath('/tmp/b.db');
  refreshed = 0;

  // activeId and `state` have already moved by the time the handler runs, so a
  // rejection must not abort the reload — that would strand the incoming
  // database behind the outgoing one's grid.
  assert.equal(await host.setActiveDb(dbA), true);
  assert.equal(host.activeDatabaseId(), dbA);
  assert.equal(refreshed, 1);
});

test('hasUnsavedChanges covers every open database, including the unreachable edited placeholder', async () => {
  const { host } = makeHost({ updateCell: () => 1 });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });

  // Edit the boot placeholder, then open a file: the placeholder is retained
  // (it has no path, so dropping it would destroy the work) but nothing in the
  // UI can reach it until the tab strip exists.
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);
  await host.openFromShellPath('/tmp/a.db');
  assert.deepEqual(
    host.listDatabases().map(d => [d.name, d.isDirty, d.isActive]),
    [['untitled.db', true, false], ['a.db', false, true]]
  );

  // Active-only would answer false here and a quit prompt would never fire.
  assert.equal(host.hasUnsavedChanges(), true);

  // …and it goes quiet only when nothing anywhere is dirty.
  await host.closeDatabase(host.listDatabases()[0].dbId);
  assert.equal(host.hasUnsavedChanges(), false);
});

test('a background database going dirty is visible to the app-level unsaved check', async () => {
  const { host } = makeHost({ updateCell: () => 1, exportDatabase: () => new Uint8Array([1]) });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  const dbA = host.activeDatabaseId()!;
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);
  await host.openFromShellPath('/tmp/b.db');

  assert.equal(host.hasUnsavedChanges(), true);                 // A is dirty in the background
  assert.equal(host.listDatabases().find(d => d.isActive)!.isDirty, false);
  await host.setActiveDb(dbA);
  await host.saveToDisk();
  assert.equal(host.hasUnsavedChanges(), false);
});

// Refresh is the ONE lane that re-initializes an entry's engine in place.
// initializeDatabase tears the previous image down before it can refuse, so a
// failure leaves the engine not holding the document the entry's path, name and
// tracker still describe — a later Save would COMMIT an empty native session
// ("saved" having written nothing) or export whatever the worker now holds over
// the real file. It must fail CLOSED.
test('a failed native refresh closes that database instead of leaving it describing a document its engine no longer holds', async () => {
  let failReinit = false;
  const { txn, exec } = makeTxnFake();
  const { members, log } = makeNativeBridgeMembers({
    initializeDatabase: () => {
      if (failReinit) throw new Error('file is not a database');
      txn.open = false;
      return { isReadOnly: false, storage: 'memory' };
    },
    runQuery: (args) => exec(args[0]),
    updateCell: () => 1,
    ping: () => true
  });
  const { host, saved } = makeHost({ exportDatabase: () => new Uint8Array([9, 9, 9]) }, members);
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);

  failReinit = true;
  await assert.rejects(() => host.refreshFromDisk(), /Refreshing "a\.db" failed .* it was closed/s);

  // The database is gone — sidecar reaped, entry removed — and the host fell
  // back to a fresh empty database rather than a lying one.
  assert.deepEqual(log.closedIds, log.openedIds);
  assert.deepEqual(host.listDatabases().map(d => [d.name, d.path]), [['untitled.db', null]]);
  assert.equal(host.hasUnsavedChanges(), false);
  // The dangerous ⌘S cannot reach a.db any more: the replacement database has
  // no path, so Save routes to Save As and writes only where that dialog says.
  assert.deepEqual(await host.saveToDisk(), { success: true, savedAs: 'as.db' });
  assert.equal(saved.path, undefined, 'nothing was written in place');
  assert.equal(saved.savedAsPath, '/tmp/as.db');
});

test('a failed WASM refresh fails closed the same way, and a failed READ leaves the database untouched', async () => {
  let failReinit = false;
  let failRead = false;
  const { host, saved } = makeHost(
    {
      initializeDatabase: () => {
        // One-shot: the FILE is corrupt, not the WASM runtime — so the empty
        // replacement database the host falls back to still boots.
        if (failReinit) { failReinit = false; throw new Error('file is not a database'); }
        return { isReadOnly: false, storage: 'memory' };
      },
      updateCell: () => 1,
      exportDatabase: () => new Uint8Array([9, 9, 9])
    },
    {
      readDatabaseBytes: async () => {
        if (failRead) throw new Error('EACCES: read refused');
        return new Uint8Array([1, 2, 3]);
      }
    }
  );
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);

  // A failed READ happens before the engine is touched: the document survives
  // intact, still dirty, still saveable to its own path.
  failRead = true;
  await assert.rejects(() => host.refreshFromDisk(), /EACCES/);
  assert.deepEqual(host.listDatabases().map(d => d.name), ['a.db']);
  assert.equal(host.hasUnsavedChanges(), true);

  // A failed RE-INIT is past that point: fail closed.
  failRead = false;
  failReinit = true;
  await assert.rejects(() => host.refreshFromDisk(), /Refreshing "a\.db" failed .* it was closed/s);
  assert.deepEqual(host.listDatabases().map(d => [d.name, d.path]), [['untitled.db', null]]);
  // Same as the native variant: the path-less replacement can only be saved
  // through Save As, never in place over the database that was closed.
  assert.deepEqual(await host.saveToDisk(), { success: true, savedAs: 'as.db' });
  assert.equal(saved.path, undefined, 'nothing was written in place');
});

// The pending map is shared by every database. A call issued against an entry
// whose transport is already gone used to register a pending entry and only
// then throw inside the Promise executor — the caller rejected, but the entry
// stayed in the map forever. Reachable when a close lands during a refresh's
// readDatabaseBytes await.
test('a call issued against a closed database is refused without stranding a pending entry', async () => {
  let releaseRead!: () => void;
  const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
  let closeDuringRead: (() => Promise<unknown>) | null = null;
  const { host, workers } = makeHost({}, {
    readDatabaseBytes: async () => {
      // Only the refresh read is held: the opens above run through this same
      // fake and must not block on a gate released after them.
      if (closeDuringRead) {
        const run = closeDuringRead;
        closeDuringRead = null;
        await run();          // the user closes the tab mid-read
        await gate;
      }
      return new Uint8Array([1, 2, 3]);
    }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  const dbA = host.activeDatabaseId()!;
  const workerA = workers.at(-1)!;
  await host.openFromShellPath('/tmp/b.db');
  await host.setActiveDb(dbA);

  closeDuringRead = () => host.closeDatabase(dbA);
  const refresh = host.refreshFromDisk();
  releaseRead();
  // Loud and specific, not a hang and not a confusing transport error.
  await assert.rejects(() => refresh, /database "a\.db" is closed/);
  assert.equal(workerA.terminated, true);
  assert.deepEqual(host.listDatabases().map(d => d.name), ['b.db']);
  // The surviving database still serves — the shared pending map was not left
  // holding a corpse that a later fanout would trip over.
  assert.equal(await host.invoke('ping', []), true);
});

test('when even the replacement empty database cannot boot, the host is empty and quiet rather than lying', async () => {
  // A dead WASM runtime: every initializeDatabase after the first refuses, so
  // the fail-closed refresh has nothing to fall back to.
  let bootsLeft = 2;                                   // start() + the open
  const { host, saved } = makeHost(
    {
      initializeDatabase: () => {
        if (bootsLeft-- <= 0) throw new Error('worker is gone');
        return { isReadOnly: false, storage: 'memory' };
      },
      updateCell: () => 1,
      exportDatabase: () => new Uint8Array([9, 9, 9])
    }
  );
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/a.db');
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);

  await assert.rejects(() => host.refreshFromDisk(), /Refreshing "a\.db" failed/);

  assert.deepEqual(host.listDatabases(), []);
  assert.equal(host.activeDatabaseId(), null);
  assert.equal(host.currentFilename(), null);
  assert.equal(host.hasUnsavedChanges(), false);
  // ⌘S and ⌘R are quiet no-ops, and nothing was written anywhere. `reason`
  // is what keeps that quiet without lying: there is no database to save, so
  // the page says nothing rather than reporting a cancelled dialog.
  assert.deepEqual(await host.saveToDisk(), { success: false, reason: 'no-database' });
  assert.equal(await host.refreshFromDisk(), undefined);
  assert.equal(saved.path, undefined);
  // A page RPC still fails loudly: it is asking an engine that does not exist.
  await assert.rejects(() => host.invoke('fetchSchema', []), /No database is open/);
});

test('state.dbId always names the active database, from boot through every switch', async () => {
  // The term grid-data.js's superseded-load gate compares against: if it ever
  // lagged the active pointer, a load fetched for one database could commit
  // into another's state.
  const { host } = makeHost({});
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  assert.equal(state.dbId, host.activeDatabaseId());

  await host.openFromShellPath('/tmp/a.db');
  const dbA = host.activeDatabaseId()!;
  assert.equal(state.dbId, dbA);

  await host.openFromShellPath('/tmp/b.db');
  const dbB = host.activeDatabaseId()!;
  assert.equal(state.dbId, dbB);
  assert.notEqual(dbA, dbB);

  await host.setActiveDb(dbA);
  assert.equal(state.dbId, dbA);

  await host.closeDatabase(dbA);
  assert.equal(state.dbId, host.activeDatabaseId());
  assert.equal(state.dbId, dbB);

  await host.closeDatabase(dbB);            // last one out: a fresh placeholder
  assert.equal(state.dbId, host.activeDatabaseId());
  assert.notEqual(state.dbId, dbB);
});

test('the unsaved summary is pushed to the shell on every dirty-state and registry change', async () => {
  // The shell has to answer the OS synchronously when a window is asked to
  // close, so it cannot ask the page then — the page pushes instead, and this
  // is what proves the push tracks every transition rather than only boot.
  const pushes: Array<[boolean, number]> = [];
  const { host } = makeHost({
    updateCell: () => 7,
    exportDatabase: () => new Uint8Array([1, 2, 3])
  }, {
    setUnsavedState: async (hasUnsaved: boolean, count: number) => {
      pushes.push([hasUnsaved, count]);
    }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  assert.deepEqual(pushes.at(-1), [false, 0], 'a clean boot reports nothing unsaved');

  await host.invoke('updateCell', ['t', 7, 'c', 'v', 'o', 1048576]);
  assert.deepEqual(pushes.at(-1), [true, 1]);
  assert.equal(host.hasUnsavedChanges(), true);

  // A SECOND dirty database must be counted, not collapsed to "some" — the
  // shell names the number in its confirm.
  await host.openFromShellPath('/tmp/second.db');
  await host.invoke('updateCell', ['t', 7, 'c', 'v', 'o', 1048576]);
  assert.deepEqual(pushes.at(-1), [true, 2]);

  // The count is exactly `hasUnsavedChanges`' own population: both walk every
  // entry, so a background or UI-unreachable dirty database is included.
  const dirty = host.listDatabases().filter(database => database.isDirty).length;
  assert.equal(pushes.at(-1)?.[1], dirty);

  // Saving clears it again.
  await host.saveToDisk();
  assert.deepEqual(pushes.at(-1), [true, 1]);
  assert.equal(host.hasUnsavedChanges(), true);
});

test('the same push reports which files this window has open', async () => {
  // The shell refuses a second window opening a file this one already has —
  // two editable copies of one database silently overwrite each other — and
  // for the WASM engine this push is the ONLY thing it can see. It has to
  // report opens AND closes, or a legitimate close-then-reopen-elsewhere
  // stays refused forever.
  const paths: Array<string[]> = [];
  const { host } = makeHost({ updateCell: () => 7 }, {
    setUnsavedState: async (_hasUnsaved: boolean, _count: number, openPaths?: string[]) => {
      paths.push(openPaths ?? ['<absent>']);
    }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  // The boot placeholder has no file, so there is nothing to collide over.
  assert.deepEqual(paths.at(-1), [], 'a path-less database must not be reported');

  await host.openFromShellPath('/tmp/first.db');
  assert.deepEqual(paths.at(-1), ['/tmp/first.db']);
  const first = host.activeDatabaseId();
  assert.ok(first, 'the open must have produced an active database');
  await host.openFromShellPath('/tmp/second.db');
  assert.deepEqual(paths.at(-1)?.slice().sort(), ['/tmp/first.db', '/tmp/second.db']);

  // A close drops out of the list — that is the release.
  await host.closeDatabase(first);
  assert.deepEqual(paths.at(-1), ['/tmp/second.db']);

  // …and it is an ARRAY on every push, never undefined, so the shell can tell
  // "nothing open" apart from "this host does not report".
  assert.ok(paths.every(entry => Array.isArray(entry) && entry[0] !== '<absent>'));
});

test('a failed open reports the registry it did NOT gain', async () => {
  // The shell holds the file from the moment it hands over the bytes (its
  // cross-window guard cannot wait for a push that has not happened yet). If
  // the open then throws, only a push says so — otherwise the file stays
  // unopenable anywhere until that hold times out.
  const paths: Array<string[]> = [];
  let failNext = false;
  const { host } = makeHost({
    initializeDatabase: () => {
      if (failNext) throw new Error('corrupt image');
      return { isReadOnly: false, storage: 'memory' };
    }
  }, {
    setUnsavedState: async (_h: boolean, _c: number, openPaths?: string[]) => {
      paths.push(openPaths ?? []);
    }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });

  failNext = true;
  const before = paths.length;
  await assert.rejects(host.openFromShellPath('/tmp/broken.db'), /corrupt image/);
  assert.ok(paths.length > before, 'the failure has to push, not stay silent');
  assert.ok(
    !paths.at(-1)?.includes('/tmp/broken.db'),
    'a database that failed to open must not be reported as open'
  );
});

test('a shell without setUnsavedState still works — the push is optional', async () => {
  // Older shells (and the dev harness) omit it; an unconditional call would
  // throw inside updateTitle and take every edit down with it.
  const { host } = makeHost({ updateCell: () => 7 });   // fake bridge has no setUnsavedState
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.invoke('updateCell', ['t', 7, 'c', 'v', 'o', 1048576]);
  assert.equal(host.hasUnsavedChanges(), true);
});

// ---------------------------------------------------------------------------
// Wave 2: settings that used to be declared and never consumed, and the undo
// refusal the page could not tell apart from a dead keystroke.
// ---------------------------------------------------------------------------

test('the maxInlineCellBytes setting reaches the engine on every page fetch', async () => {
  // Declared in DEFAULT_SETTINGS since the port and read by nobody: the grid
  // never asks for a cell budget, so the worker always fell back to its own
  // default and a user who set the key got silence.
  const seen: unknown[] = [];
  const { host } = makeHost(
    { fetchTableData: (args) => { seen.push(args[1]); return { headers: [], rows: [] }; } },
    { loadSettings: async () => ({ maxInlineCellBytes: 4096 }) }
  );
  await host.start();
  await host.invoke('fetchTableData', ['t', { limit: 10 }]);
  assert.deepEqual(seen[0], { limit: 10, maxInlineCellBytes: 4096 });

  // Default when unset, and the caller's own options are preserved.
  const { host: plain } = makeHost({
    fetchTableData: (args) => { seen.push(args[1]); return { headers: [], rows: [] }; }
  });
  await plain.start();
  await plain.invoke('fetchTableData', ['t', undefined]);
  assert.deepEqual(seen[1], { maxInlineCellBytes: 1048576 });
});

test('the sidebar width persists, and a nonsense one is refused', async () => {
  // saveSidebarState was `async () => undefined` — a no-op — so the dragged
  // width died with the window even though the desktop has a settings store.
  const { host, saved } = makeHost({});
  await host.start();
  await host.invoke('saveSidebarState', ['left', 234.6]);
  assert.deepEqual(saved.settings, { sidebarWidth: 235 });
  assert.equal(
    (await host.invoke('getExtensionSettings', []) as Record<string, unknown>).sidebarWidth,
    235
  );

  // Webview-supplied input landing in the one webview-writable file: refuse,
  // never clamp-and-store, so nothing bogus is persisted quietly.
  for (const bad of [['right', 200], ['left', 10], ['left', 10000], ['left', 'wide']]) {
    await assert.rejects(() => host.invoke('saveSidebarState', bad));
  }
  assert.deepEqual(saved.settings, { sidebarWidth: 235 });
});

test('a refused undo says WHY: a barrier is not an empty history', async () => {
  const { host } = makeHost({
    updateCell: () => ({ success: true }),
    deleteColumns: () => undefined,
    fetchSchema: () => ({ tables: [], views: [], indexes: [] })
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });

  assert.deepEqual(await host.invoke('triggerUndo', []), { performed: false, reason: 'empty' });

  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);
  await host.invoke('deleteColumns', ['t', ['c']]);          // records a BARRIER

  // Undo stops at the barrier and NAMES the operation. Before this, ⌘Z after a
  // column drop was indistinguishable from a keystroke that did nothing.
  assert.deepEqual(await host.invoke('triggerUndo', []), {
    performed: false,
    reason: 'barrier',
    barrierDescription: 'deleteColumns'
  });
});

// ---------------------------------------------------------------------------
// CSV/JSON import: one worker call, one history entry, host-owned budgets
// ---------------------------------------------------------------------------

const IMPORT_SNAPSHOTS = {
  columns: ['id', 'name'],
  storageClassPatterns: [['integer', 'text']],
  rows: [{ rowId: 1, values: [1, 'a'], pattern: 0 }, { rowId: 2, values: [2, 'b'], pattern: 0 }]
};

test('importRows is ONE undoable entry: host budgets replace the page\'s, importedRows is recorded, undo/redo replay it', async () => {
  const undone: unknown[][] = [];
  const redone: unknown[][] = [];
  const { host, posted } = makeHost({
    importRows: () => ({ rowCount: 2, snapshots: IMPORT_SNAPSHOTS }),
    undoModification: (args) => { undone.push(args); return { success: true }; },
    redoModification: (args) => { redone.push(args); return { success: true }; }
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });

  const result = await host.invoke('importRows', ['users', [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], {
    maxEditValueBytes: 1048576,
    // A page cannot lift the budgets: both are replaced by host policy below.
    maxUndoSnapshotBytes: 1,
    maxSnapshotTransportBytes: 1
  }]);
  assert.deepEqual(result, { rowCount: 2, snapshots: IMPORT_SNAPSHOTS });
  assert.equal(host.hasUnsavedChanges(), true);

  const sent = posted.at(-1)!.content;
  assert.equal(sent.targetMethod, 'importRows');
  assert.equal(sent.payload[0], 'users');
  assert.deepEqual(sent.payload[1], [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
  const options = sent.payload[2] as Record<string, unknown>;
  assert.equal(options.maxEditValueBytes, 1048576, 'the page\'s per-value cap rides through');
  // maxUndoMemory (50 MiB default) minus the entry's own metadata.
  assert.ok(Number.isSafeInteger(options.maxUndoSnapshotBytes));
  assert.ok((options.maxUndoSnapshotBytes as number) > 50 * 1024 * 1024 - 4096);
  assert.ok((options.maxUndoSnapshotBytes as number) < 50 * 1024 * 1024);
  // WASM answers cross a structured clone, not a frame: no transport cap.
  assert.equal('maxSnapshotTransportBytes' in options, false);

  await host.invoke('triggerUndo', []);
  const undoMod = (undone[0] as unknown[])[0] as Record<string, unknown>;
  assert.equal(undoMod.modificationType, 'row_insert');
  assert.equal(undoMod.targetTable, 'users');
  assert.equal(undoMod.label, 'Import 2 rows');
  assert.equal(undoMod.description, 'Import 2 rows into users');
  assert.deepEqual(undoMod.importedRows, IMPORT_SNAPSHOTS);
  assert.equal(undoMod.insertedRow, undefined);
  assert.equal(host.hasUnsavedChanges(), false, 'one entry: a single undo clears the import');

  await host.invoke('triggerRedo', []);
  assert.equal(redone.length, 1);
  assert.deepEqual(((redone[0] as unknown[])[0] as Record<string, unknown>).importedRows, IMPORT_SNAPSHOTS);
  assert.equal(host.hasUnsavedChanges(), true);
});

test('a refused importRows records nothing', async () => {
  const { host } = makeHost({
    importRows: () => { throw new Error('UNIQUE constraint failed: users.id'); }
  });
  await host.start();
  await assert.rejects(host.invoke('importRows', ['users', [{ id: 1 }], {}]), /UNIQUE/);
  assert.equal(host.hasUnsavedChanges(), false);
  assert.deepEqual(await host.invoke('triggerUndo', []), { performed: false, reason: 'empty' });
});

test('importRows on a native database carries the frame-safe transport cap and opens the session transaction first', async () => {
  const { host, nativeLog, txn } = makeNativeHost({
    importRows: () => ({ rowCount: 1, snapshots: { ...IMPORT_SNAPSHOTS, rows: IMPORT_SNAPSHOTS.rows.slice(0, 1) } })
  });
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/import-target.db');

  await host.invoke('importRows', ['t', [{ id: 1, name: 'a' }], { maxEditValueBytes: 10 }]);
  const envelope = nativeLog.envelopes.find(e => e.content.targetMethod === 'importRows');
  assert.ok(envelope, 'the import rode the native transport');
  const options = envelope!.content.payload[2] as Record<string, unknown>;
  assert.equal(options.maxEditValueBytes, 10);
  assert.ok(Number.isSafeInteger(options.maxUndoSnapshotBytes));
  // MAX_FRAME_BYTES (16 MiB) minus the 2 MiB envelope/estimate margin: the
  // worker refuses an answer over this BEFORE releasing the import, so a
  // response the frame would drop can never leave committed rows behind.
  assert.equal(options.maxSnapshotTransportBytes, 14 * 1024 * 1024);
  // Pending until Save, like every other native mutation.
  assert.deepEqual(nativeSql(nativeLog), ['BEGIN']);
  assert.equal(txn.open, true);
  assert.equal(host.hasUnsavedChanges(), true);
});

test('the import source pick and read ride the bridge, and refuse loudly on a shell without them', async () => {
  const reads: string[] = [];
  const { host } = makeHost({}, {
    pickImportSource: async () => ({ path: '/tmp/rows.csv', name: 'rows.csv', size: 12 }),
    readImportText: async (path: string) => { reads.push(path); return 'id,name\n1,a'; }
  });
  await host.start();
  assert.deepEqual(await host.invoke('pickImportSource', []), { path: '/tmp/rows.csv', name: 'rows.csv', size: 12 });
  assert.equal(await host.invoke('readImportSource', ['/tmp/rows.csv']), 'id,name\n1,a');
  assert.deepEqual(reads, ['/tmp/rows.csv']);
  await assert.rejects(host.invoke('readImportSource', ['']), /path the import dialog returned/);

  // A cancelled dialog is null, never an error.
  const { host: cancelled } = makeHost({}, { pickImportSource: async () => null });
  await cancelled.start();
  assert.equal(await cancelled.invoke('pickImportSource', []), null);

  // Older shells: no silent in-page fallback (it could not enforce the 64 MiB cap).
  const { host: old } = makeHost({});
  await old.start();
  await assert.rejects(old.invoke('pickImportSource', []), /shell bridge has no pickImportSource/);
  await assert.rejects(old.invoke('readImportSource', ['/tmp/rows.csv']), /shell bridge has no readImportText/);
});

// ============================================================================
// External file replacement — retirement and Reload
// ============================================================================
//
// The SHELL pins each native database's file identity (device + inode) at
// open and refuses every later native_rpc for that DbId with
// ERR_NATIVE_FILE_CHANGED once the file at the bound path is no longer that
// file (an atomic rename over it, a move, a delete). The refusal is a REJECTED
// bridge promise — the envelope never reached the sidecar — not an in-band
// worker error, which is what the fakes below model. Ordinary external writes
// (another process's DML, a WAL checkpoint) keep the inode and never refuse.

const FILE_CHANGED_REFUSAL = 'ERR_NATIVE_FILE_CHANGED: the database file at the bound path is not the file this '
  + 'sidecar opened (device/inode differ): replaced, moved, or deleted outside SQLite Explorer';
const FILE_CHANGED_MESSAGE = 'The database file was replaced, moved, deleted, or became unavailable outside SQLite Explorer. '
  + 'Use Reload Database to open the current file. The previous undo/redo history has been invalidated.';

/**
 * A native host whose shell can be told to refuse every envelope as
 * file-changed (`shell.replaced = true`), plus a readDatabaseBytes the test
 * can fail, so both reload lanes can be driven.
 */
function makeReplaceableNativeHost(nativeOpts: { available?: boolean; openError?: string } = {}) {
  const { txn, exec } = makeTxnFake();
  const { members, log } = makeNativeBridgeMembers({
    initializeDatabase: () => { txn.open = false; return { isReadOnly: false, storage: 'memory' }; },
    runQuery: (args) => exec(args[0]),
    updateCell: () => 1,
    undoModification: () => ({ success: true }),
    fetchSchema: () => ({ tables: [], views: [], indexes: [] }),
    ping: () => true
  }, nativeOpts);
  const shell = { replaced: false, failRead: false };
  const reads: unknown[][] = [];
  const refreshes: Array<Record<string, unknown>> = [];
  const made = makeHost({}, {
    ...members,
    nativeRpc: async (dbId: string, json: string) => {
      if (shell.replaced) throw new Error(FILE_CHANGED_REFUSAL);
      return members.nativeRpc(dbId, json);
    },
    readDatabaseBytes: async (...args: unknown[]) => {
      reads.push(args);
      if (shell.failRead) throw new Error('EACCES: permission denied');
      return new Uint8Array([1, 2, 3]);
    }
  });
  made.host.setWebviewMethods({
    refreshContent: async (_name: unknown, result: unknown) => {
      refreshes.push(result as Record<string, unknown>);
      return { success: true };
    }
  });
  return { ...made, nativeLog: log, txn, shell, reads, refreshes };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('the shell\'s ERR_NATIVE_FILE_CHANGED refusal retires the database: typed error, history discarded, sidecar closed, every engine call answers the reason', async () => {
  const { host, nativeLog, txn, shell, refreshes } = makeReplaceableNativeHost();
  await host.start();
  await host.openFromShellPath('/tmp/a.db');
  const [firstId] = nativeLog.openedIds;
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);   // dirty, session txn open
  assert.equal(host.hasUnsavedChanges(), true);
  assert.equal(txn.open, true);
  const before = await host.invoke('initialize', []) as Record<string, unknown>;

  // The file is replaced underneath the sidecar; the NEXT operation is refused
  // by the shell. A mutation, so the failure also crosses the txn-reconcile
  // path — which must not fire another envelope at the dead sidecar.
  shell.replaced = true;
  const envelopesBefore = nativeLog.envelopes.length;
  const failure = await host.invoke('updateCell', ['t', 1, 'c', 'w', 'v', 1048576]).then(
    () => null, (error: Error) => error
  );
  assert.ok(failure, 'the mutation must fail');
  assert.equal(failure!.name, 'DatabaseFileChangedError');
  assert.equal((failure as { code?: string }).code, 'SQLITE_EXPLORER_DATABASE_FILE_CHANGED');
  assert.equal(failure!.message, FILE_CHANGED_MESSAGE);
  assert.equal((failure as { cause?: Error }).cause?.message, FILE_CHANGED_REFUSAL);
  await settle();

  // Retired: the sidecar is closed (its descriptor pointed at the orphaned
  // inode), the history is gone, the generation advanced, the page was told.
  assert.deepEqual(nativeLog.closedIds, [firstId]);
  assert.equal(host.hasUnsavedChanges(), false);
  assert.deepEqual(host.listDatabases().map(d => [d.name, d.isDirty]), [['a.db', false]]);
  const retired = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(retired.connected, true);
  assert.equal(retired.isReadOnly, true);
  assert.equal(retired.reloadRequiredReason, FILE_CHANGED_MESSAGE);
  assert.ok((retired.connectionGeneration as number) > (before.connectionGeneration as number));
  const pushed = refreshes.at(-1)!;
  assert.equal(pushed.reloadRequiredReason, FILE_CHANGED_MESSAGE);
  assert.equal(pushed.isReadOnly, true);
  assert.equal(pushed.connected, true);

  // Every engine-bound method answers the reason, and nothing more reaches the
  // bridge — the reconcile probe included (exactly the refused envelope's
  // worth of traffic happened, and that never reached the fake's handlers).
  const envelopesAfter = nativeLog.envelopes.length;
  assert.equal(envelopesAfter, envelopesBefore);
  for (const [method, args] of [
    ['updateCell', ['t', 1, 'c', 'x', 'w', 1048576]],
    ['fetchSchema', []],
    ['runConsole', ['SELECT 1', {}]],
    ['exportDb', ['a.db']],
    ['triggerUndo', []],
    ['setPragma', ['journal_mode', 'wal']]
  ] as Array<[string, unknown[]]>) {
    await assert.rejects(() => host.invoke(method, args), { name: 'DatabaseFileChangedError' }, method);
  }
  assert.equal(nativeLog.envelopes.length, envelopesAfter);
  // ⌘S names the reason and the remedy, never "Saved".
  assert.deepEqual(await host.saveToDisk(), {
    success: false, reason: 'read-only', savedAs: 'a.db', message: FILE_CHANGED_MESSAGE
  });
  // Settings and other host-only methods still answer.
  assert.equal(typeof await host.invoke('getExtensionSettings', []), 'object');
});

test('Reload of a retired database reopens the same file in place: a fresh sidecar, the same entry, clean history, no transaction', async () => {
  const { host, nativeLog, txn, shell } = makeReplaceableNativeHost();
  await host.start();
  await host.openFromShellPath('/tmp/a.db');
  const dbId = host.activeDatabaseId();
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);
  shell.replaced = true;
  await assert.rejects(() => host.invoke('fetchSchema', []), { name: 'DatabaseFileChangedError' });
  await settle();

  // The replacement settled; the user clicks Reload Database (sidebar.js
  // reloadFromDisk → backendApi.refreshFile).
  shell.replaced = false;
  const reloaded = await host.invoke('refreshFile', []) as Record<string, unknown>;
  assert.deepEqual(reloaded, {
    connected: true, filename: 'a.db', readOnly: false,
    connectionGeneration: reloaded.connectionGeneration
  });
  assert.equal(nativeLog.openedIds.length, 2, 'a NEW sidecar, through nativeOpen (the allowlist and OpenFiles gates)');
  assert.deepEqual(nativeLog.opens.at(-1), { path: '/tmp/a.db', readOnly: false });
  assert.equal(host.activeDatabaseId(), dbId, 'the same entry');
  assert.equal(host.listDatabases().length, 1);
  const init = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(init.reloadRequiredReason, undefined);
  assert.equal(init.isReadOnly, false);
  assert.equal(init.engine, 'native');
  assert.equal(host.hasUnsavedChanges(), false);
  assert.equal(txn.open, false);
  assert.deepEqual(await host.invoke('triggerUndo', []), { performed: false, reason: 'empty' });

  // …and it is a working database again: edits, undo, save on the new sidecar.
  await host.invoke('updateCell', ['t', 1, 'c', 'x', 'v', 1048576]);
  assert.equal(host.hasUnsavedChanges(), true);
  assert.equal(txn.open, true);
  assert.deepEqual(await host.invoke('triggerUndo', []), { performed: true });
  assert.equal((await host.saveToDisk()).success, true);
  assert.deepEqual(nativeLog.envelopeIds.slice(-3).every(id => id === nativeLog.openedIds[1]), true,
    'every envelope after the reload is addressed to the NEW sidecar');
});

test('a failed reopen keeps the database retired with the NEW reason; a later Reload can still succeed (and may land on WASM)', async () => {
  const nativeOpts: { available?: boolean; openError?: string } = {};
  const { host, nativeLog, shell, reads } = makeReplaceableNativeHost(nativeOpts);
  await host.start();
  await host.openFromShellPath('/tmp/a.db');
  shell.replaced = true;
  await assert.rejects(() => host.invoke('fetchSchema', []), { name: 'DatabaseFileChangedError' });
  await settle();
  shell.replaced = false;

  // The file is gone for now: the native bind fails, the WASM read fails.
  nativeOpts.openError = 'ERR_NATIVE_PATH_NOT_ALLOWED: cannot resolve /tmp/a.db';
  shell.failRead = true;
  await assert.rejects(() => host.invoke('refreshFile', []), /EACCES/);
  assert.deepEqual(reads.map(r => r[0]), ['/tmp/a.db']);
  const stillRetired = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.match(String(stillRetired.reloadRequiredReason), /EACCES/);
  assert.equal(stillRetired.isReadOnly, true);
  assert.equal(host.listDatabases().length, 1, 'the tab stays');
  await assert.rejects(() => host.invoke('fetchSchema', []), /EACCES/);
  assert.equal(nativeLog.openedIds.length, 1, 'no sidecar was bound');

  // The file is back but the native bind still fails: the reload falls back to
  // the WASM lane, exactly like a first open would.
  shell.failRead = false;
  const reloaded = await host.invoke('refreshFile', []) as Record<string, unknown>;
  assert.equal(reloaded.connected, true);
  assert.equal(reloaded.reloadRequiredReason, undefined);
  const init = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(init.engine, 'wasm');
  assert.equal(init.reloadRequiredReason, undefined);
  assert.equal(host.listDatabases().length, 1);
});

test('opening a retired database\'s path again reopens it in place instead of switching to its error state or adding a second entry', async () => {
  const { host, nativeLog, shell } = makeReplaceableNativeHost();
  await host.start();
  await host.openFromShellPath('/tmp/a.db');
  const dbId = host.activeDatabaseId();
  shell.replaced = true;
  await assert.rejects(() => host.invoke('fetchSchema', []), { name: 'DatabaseFileChangedError' });
  await settle();
  shell.replaced = false;

  assert.equal(await host.openFromShellPath('/tmp/a.db'), true);
  assert.equal(host.listDatabases().length, 1);
  assert.equal(host.activeDatabaseId(), dbId);
  assert.equal(nativeLog.openedIds.length, 2);
  const init = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(init.reloadRequiredReason, undefined);
  assert.equal(init.engine, 'native');
});

test('retirement is per database: the other open databases keep serving, and closing a retired tab is clean', async () => {
  const { host, nativeLog, shell } = makeReplaceableNativeHost();
  await host.start();
  await host.openFromShellPath('/tmp/a.db');
  const dbA = host.activeDatabaseId()!;
  await host.openFromShellPath('/tmp/b.db');
  const dbB = host.activeDatabaseId()!;
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);   // B is dirty

  // Only A's shell refusals: the fake refuses everything, so scope it by
  // activating A first and restoring afterwards.
  await host.setActiveDb(dbA);
  shell.replaced = true;
  await assert.rejects(() => host.invoke('fetchSchema', []), { name: 'DatabaseFileChangedError' });
  shell.replaced = false;
  await settle();
  assert.deepEqual(nativeLog.closedIds, [nativeLog.openedIds[0]]);

  await host.setActiveDb(dbB);
  assert.equal(host.hasUnsavedChanges(), true, 'B\'s pending edit survived A\'s retirement');
  assert.deepEqual(await host.invoke('fetchSchema', []), { tables: [], views: [], indexes: [] });
  const initB = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(initB.reloadRequiredReason, undefined);

  // Closing the retired tab: nothing to close on the shell (already closed),
  // no double close, B stays.
  assert.equal(await host.closeDatabase(dbA), true);
  assert.deepEqual(nativeLog.closedIds, [nativeLog.openedIds[0]]);
  assert.deepEqual(host.listDatabases().map(d => d.name), ['b.db']);
});

test('a WASM save the shell refuses as stale (ERR_FILE_CHANGED) surfaces the sentence and leaves the edits pending and the connection live', async () => {
  const refusal = 'ERR_FILE_CHANGED: The database file changed on disk since it was opened or last saved. '
    + 'Your unsaved changes remain available. Use File > Export Database to save them to a different file, '
    + 'or Reload Database to open the current file.';
  let stale = true;
  let writes = 0;
  const { host } = makeHost(
    { updateCell: () => 1, exportDatabase: () => new Uint8Array([9]) },
    { saveDatabase: async () => { if (stale) throw new Error(refusal); writes += 1; } }
  );
  await host.start();
  host.setWebviewMethods({ refreshContent: async () => ({ success: true }) });
  await host.openFromShellPath('/tmp/w.db');                     // WASM (no native bridge)
  await host.invoke('updateCell', ['t', 1, 'c', 'v', 'o', 1048576]);

  await assert.rejects(() => host.saveToDisk(), (error: Error) => {
    assert.equal(error.message, refusal.slice('ERR_FILE_CHANGED: '.length));
    return true;
  });
  // Nothing was lost and nothing was retired: the image predates another
  // writer's changes, so the WRITE was refused — the connection is fine.
  assert.equal(host.hasUnsavedChanges(), true);
  const init = await host.invoke('initialize', []) as Record<string, unknown>;
  assert.equal(init.reloadRequiredReason, undefined);
  assert.equal(init.isReadOnly, false);
  assert.deepEqual(host.listDatabases().map(d => [d.name, d.isDirty]), [['w.db', true]]);

  // After the user reloads (or the file settles), the same save goes through.
  stale = false;
  assert.deepEqual(await host.saveToDisk(), { success: true, savedAs: 'w.db' });
  assert.equal(writes, 1);
  assert.equal(host.hasUnsavedChanges(), false);
});

test('the reload-required reason is per-database UI state', () => {
  assert.equal(PER_DB_STATE_FIELDS.includes('reloadRequiredReason'), true,
    'a retired database\'s Reload prompt must not follow the user to another tab');
  assert.equal(GLOBAL_STATE_FIELDS.includes('reloadRequiredReason'), false);
  assert.equal(TRANSIENT_STATE_FIELDS.includes('reloadRequiredReason'), false);
});
