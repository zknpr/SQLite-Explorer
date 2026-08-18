import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDesktopApi, backendApi, getVsCodeState, saveVsCodeState } from '../../core/ui/modules/desktop-api.js';

function fakeHost() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    invoke: async (method: string, args: unknown[]) => {
      calls.push({ method, args });
      if (method === 'getCellMetadata') return { storageClass: 'text', byteLength: 10 };
      return { ok: true };
    }
  };
}

test('backendApi methods route through host.invoke with the web-api payload shapes', async () => {
  const host = fakeHost();
  initDesktopApi(host as never);
  await backendApi.fetchTableData('users', { limit: 10 });
  assert.deepEqual(host.calls.at(-1), { method: 'fetchTableData', args: ['users', { limit: 10 }] });

  await backendApi.updateCell('users', 1, 'name', 'x', 'y');
  // small cell: metadata checked first, then updateCell with the byte cap appended
  assert.equal(host.calls.at(-2)!.method, 'getCellMetadata');
  const update = host.calls.at(-1)!;
  assert.equal(update.method, 'updateCell');
  assert.equal(update.args.length, 6); // table,rowId,column,value,original,DEFAULT_MAX_CELL_EDIT_BYTES
});

test('the VS Code view-state seam is inert on the desktop, and writes NOTHING', () => {
  // It used to write persistState()'s snapshot into localStorage that nothing
  // read back (getVsCodeState has exactly one caller, the VS Code entry), so
  // the desktop paid for the write on every interaction and restored nothing.
  // Restoring it would be WRONG rather than merely absent: the desktop keeps N
  // databases behind one `state` object and boots to an empty scratch database,
  // so one global blob would be replayed onto whichever database opened first.
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); }
  };
  saveVsCodeState({ selectedTable: 'users' });
  assert.equal(store.size, 0, 'the desktop must not write viewer state to localStorage');
  assert.equal(getVsCodeState(), undefined);
});

test('sendRpcRequest clears its timeout timer once the host invocation settles (no leaked timer)', async () => {
  const host = fakeHost();
  initDesktopApi(host as never);

  // Spy on the real global timer functions rather than faking time: this
  // proves the actual fix mechanism (finally -> clearTimeout(sameId)), not
  // just that *a* clearTimeout happened somewhere. A stale-id bug would
  // still call clearTimeout while leaking the real timer; asserting the
  // cleared id matches the one setTimeout handed back rules that out.
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let capturedTimerId: unknown;
  const clearCalls: unknown[] = [];

  (globalThis as unknown as { setTimeout: (fn: (...args: unknown[]) => void, ms?: number) => unknown }).setTimeout =
    (fn: (...args: unknown[]) => void, ms?: number) => {
      const id = (realSetTimeout as unknown as (fn: (...args: unknown[]) => void, ms?: number) => unknown)(fn, ms);
      capturedTimerId = id;
      return id;
    };
  (globalThis as unknown as { clearTimeout: (id: unknown) => void }).clearTimeout = (id: unknown) => {
    clearCalls.push(id);
    (realClearTimeout as unknown as (id: unknown) => void)(id);
  };

  try {
    const result = await backendApi.ping();
    assert.deepEqual(result, { ok: true });
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }

  assert.equal(clearCalls.length, 1);
  assert.equal(clearCalls[0], capturedTimerId);
});

test('runConsole passes the script and an options object through to the host', async () => {
  const host = fakeHost();
  initDesktopApi(host as never);

  await backendApi.runConsole('SELECT 1');
  assert.deepEqual(host.calls.at(-1), { method: 'runConsole', args: ['SELECT 1', {}] });

  await backendApi.runConsole('SELECT 1', { maxRows: 10 });
  assert.deepEqual(host.calls.at(-1), { method: 'runConsole', args: ['SELECT 1', { maxRows: 10 }] });

  // EXPLAIN's contract: the console module injects this and the passthrough
  // must not drop it, or a diagnostics click runs the whole script for real.
  await backendApi.runConsole('EXPLAIN QUERY PLAN SELECT 1; DROP TABLE t;', { maxStatements: 1 });
  assert.deepEqual(host.calls.at(-1), {
    method: 'runConsole',
    args: ['EXPLAIN QUERY PLAN SELECT 1; DROP TABLE t;', { maxStatements: 1 }]
  });
});

// ---------------------------------------------------------------------------
// Wave 2 (capstone E-9): dropping an indexed column ALWAYS failed, because this
// lane never passed `dropDependentIndexes` — and a column drop is a history
// barrier, which nothing told the user before they took it.
// ---------------------------------------------------------------------------

function confirmingHost(dependencies: unknown) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    invoke: async (method: string, args: unknown[]) => {
      calls.push({ method, args });
      if (method === 'findColumnDependencies') return dependencies;
      return { ok: true };
    }
  };
}

test('deleteColumns names the indexes it would drop and passes them to the engine', async () => {
  const host = confirmingHost({
    indexes: ['idx_users_email'],
    dependentObjects: [{ type: 'view', identifier: 'active_users' }]
  });
  initDesktopApi(host as never);
  const prompts: string[] = [];
  (globalThis as Record<string, unknown>).window = {
    confirm: (message: string) => { prompts.push(message); return true; }
  };

  await backendApi.deleteColumns('users', ['email']);

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /idx_users_email/);
  assert.match(prompts[0], /view active_users/);
  // The undo cost, stated BEFORE the drop rather than discovered after ⌘Z.
  assert.match(prompts[0], /cannot be undone/);
  // …and the confirmed list is what actually reaches the engine. Without it
  // SQLite refuses the drop outright ("error in index ... no such column").
  assert.deepEqual(host.calls.at(-1), {
    method: 'deleteColumns',
    args: ['users', ['email'], ['idx_users_email']]
  });
});

test('declining the prompt cancels honestly and touches nothing', async () => {
  const host = confirmingHost({ indexes: [], dependentObjects: [] });
  initDesktopApi(host as never);
  (globalThis as Record<string, unknown>).window = { confirm: () => false };

  // `{cancelled: true}` is the shape crud.js already understands (the VS Code
  // host has always answered it that way), so the grid reports "Delete
  // cancelled" and does not reload.
  assert.deepEqual(await backendApi.deleteColumns('users', ['email']), { cancelled: true });
  assert.deepEqual(host.calls.map(call => call.method), ['findColumnDependencies']);
});

test('a column with no dependencies still gets the undo warning, and no index list', async () => {
  const host = confirmingHost({ indexes: [], dependentObjects: [] });
  initDesktopApi(host as never);
  const prompts: string[] = [];
  (globalThis as Record<string, unknown>).window = {
    confirm: (message: string) => { prompts.push(message); return true; }
  };

  await backendApi.deleteColumns('users', ['email', 'phone']);
  assert.match(prompts[0], /cannot be undone/);
  assert.doesNotMatch(prompts[0], /will be dropped first/);
  // undefined, not [] — the worker's third parameter is optional and an empty
  // list would still be a list.
  assert.deepEqual(host.calls.at(-1), {
    method: 'deleteColumns',
    args: ['users', ['email', 'phone'], undefined]
  });
});

test('the oversized-cell refusals name THIS app and the route that works', async () => {
  const editor = await backendApi.openCellEditor({}, 1, 'blob', {}, { sourceByteLength: 5_000_000 });
  assert.equal(editor.success, false);
  const message = String(editor.message);
  assert.doesNotMatch(message, /web demo/);
  assert.match(message, /Load More/);
});
