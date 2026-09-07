import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { initDesktopApi, backendApi, getVsCodeState, saveVsCodeState } from '../../core/ui/modules/desktop-api.js';
import { encodeFrameValue, decodeFrameValue } from '../../core/native/frame-codec.js';
import { FakeElement, installFakeDom } from './helpers/fake-dom';

// The destructive-operation prompts render into the page (see
// destructive_confirm_dialog.test.ts for why `window.confirm` cannot be used
// on the desktop), so these tests need a document to render into.
const dom = installFakeDom();
const modalsModulePath = '../../core/ui/modules/modals.js';

before(async () => {
  const modals = await import(modalsModulePath);
  modals.initModals();
});

/** Settle every pending microtask so an in-flight RPC chain reaches its prompt. */
const flush = () => new Promise(resolve => setImmediate(resolve));

async function presentedConfirmation(): Promise<string> {
  await flush();
  const overlay = dom.getElementById('destructiveConfirmModal');
  assert.ok(
    overlay && !overlay.classList.contains('hidden'),
    'the operation ran without ever presenting its confirmation'
  );
  const body = [...overlay.walk()].find(node => node.className.includes('modal-body'));
  assert.ok(body, 'the confirmation has no body');
  return body.children.map(line => line.textContent).join('\n');
}

function answerConfirmation(approve: boolean): void {
  const overlay = dom.getElementById('destructiveConfirmModal');
  assert.ok(overlay, 'no confirmation is open');
  const wanted = approve ? 'btn-danger' : 'modal-cancel';
  const target = [...overlay.walk()].find(node => node.className.includes(wanted));
  assert.ok(target, `the confirmation has no ${wanted} control`);
  dom.dispatchClick(target as FakeElement);
}

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

function confirmingHost(dependentIndexes: unknown) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    invoke: async (method: string, args: unknown[]) => {
      calls.push({ method, args });
      if (method === 'findDependentIndexes') return dependentIndexes;
      return { ok: true };
    }
  };
}

const EMAIL_INDEX = { identifier: 'idx_users_email', sql: 'CREATE INDEX idx_users_email ON users(email)' };

test('deleteColumns names the indexes it would drop and passes their exact definitions to the engine', async () => {
  const host = confirmingHost([EMAIL_INDEX]);
  initDesktopApi(host as never);

  const pending = backendApi.deleteColumns('users', ['email']);
  const prompt = await presentedConfirmation();

  assert.match(prompt, /idx_users_email/);
  // The undo cost, stated BEFORE the drop rather than discovered after ⌘Z.
  assert.match(prompt, /cannot be undone/);

  answerConfirmation(true);
  await pending;

  // …and the confirmed DEFINITIONS are what reach the engine: the worker
  // re-derives the list inside the drop's savepoint and refuses if an index
  // changed while the prompt was open, so names alone would not do.
  assert.deepEqual(host.calls.at(-1), {
    method: 'deleteColumns',
    args: ['users', ['email'], [EMAIL_INDEX]]
  });
});

test('a malformed dependent-index answer is refused before any prompt', async () => {
  const host = confirmingHost([{ identifier: 'idx', sql: 42 }]);
  initDesktopApi(host as never);
  await assert.rejects(backendApi.deleteColumns('users', ['email']), /Invalid dependent-index definition/);
  assert.deepEqual(host.calls.map(call => call.method), ['findDependentIndexes']);
});

test('declining the prompt cancels honestly and touches nothing', async () => {
  const host = confirmingHost([]);
  initDesktopApi(host as never);

  const pending = backendApi.deleteColumns('users', ['email']);
  await presentedConfirmation();
  answerConfirmation(false);

  // `{cancelled: true}` is the shape crud.js already understands (the VS Code
  // host has always answered it that way), so the grid reports "Delete
  // cancelled" and does not reload.
  assert.deepEqual(await pending, { cancelled: true });
  assert.deepEqual(host.calls.map(call => call.method), ['findDependentIndexes']);
});

test('a column with no dependencies OMITS the third argument entirely', async () => {
  const host = confirmingHost([]);
  initDesktopApi(host as never);

  const pending = backendApi.deleteColumns('users', ['email', 'phone']);
  const prompt = await presentedConfirmation();
  assert.match(prompt, /cannot be undone/);
  assert.doesNotMatch(prompt, /will be dropped first/);
  answerConfirmation(true);
  await pending;

  // TWO arguments, not three-with-a-hole. This lane used to send
  // `[table, columns, undefined]`, reasoning that the worker's third parameter
  // is optional — true in JavaScript, false on the wire. See the round-trip
  // test below: JSON has no `undefined`, so the hole arrived as an explicit
  // `null`, which the worker's confirmation validator rightly refuses as
  // "not an array". Every desktop user dropping a column with no dependent
  // index — the common case — got that refusal.
  assert.deepEqual(host.calls.at(-1), {
    method: 'deleteColumns',
    args: ['users', ['email', 'phone']]
  });
});

/** Exactly what desktop-host.js's `callWorker` does for a native engine. */
function acrossTheNativeWire(method: string, args: unknown[]): unknown[] {
  const message = {
    channel: 'rpc',
    content: { kind: 'invoke', messageId: 'rpc_1', targetMethod: method, payload: args }
  };
  const wire = JSON.stringify(encodeFrameValue(message));
  const decoded = decodeFrameValue(JSON.parse(wire)) as {
    content: { payload: unknown[] };
  };
  return decoded.content.payload;
}

test('the deleteColumns argument list survives the native JSON transport intact', async () => {
  // The bug was a TRANSPORT bug, so assert against the transport rather than
  // against the argument array the caller happened to build.
  const host = confirmingHost([]);
  initDesktopApi(host as never);
  const pending = backendApi.deleteColumns('people', ['note']);
  await presentedConfirmation();
  answerConfirmation(true);
  await pending;

  const sent = host.calls.at(-1)!;
  const received = acrossTheNativeWire(sent.method, sent.args);

  // Absent on arrival — which is what makes the worker's
  // `normalizeDependentIndexConfirmation(undefined)` early-out fire.
  assert.deepEqual(received, ['people', ['note']]);
  assert.equal(received.length, 2);

  // The shape this used to send, proven to mangle. `JSON.stringify` has no
  // representation for `undefined` in an array, so it substitutes `null` —
  // a value the caller never wrote and the worker rightly rejects.
  assert.deepEqual(
    acrossTheNativeWire('deleteColumns', ['people', ['note'], undefined]),
    ['people', ['note'], null]
  );

  // And with a real dependency list nothing is lost either.
  const definitions = [{ identifier: 'idx_people_note', sql: 'CREATE INDEX idx_people_note ON people(note)' }];
  assert.deepEqual(
    acrossTheNativeWire('deleteColumns', ['people', ['note'], definitions]),
    ['people', ['note'], definitions]
  );
});

test('sendRpcRequest never hands the JSON lane a trailing hole', async () => {
  // The class fix behind the specific one above: `undefined` is not
  // expressible in JSON, but "argument absent" is — by making the list
  // shorter. Truncation is lossless because the worker dispatches with
  // `handler(...(payload || []))` and never reads `arguments.length`.
  const host = fakeHost();
  initDesktopApi(host as never);

  await backendApi.addColumn('users', 'nickname', 'TEXT', undefined);
  assert.deepEqual(host.calls.at(-1), {
    method: 'addColumn',
    args: ['users', 'nickname', 'TEXT']
  });
  assert.deepEqual(
    acrossTheNativeWire('addColumn', host.calls.at(-1)!.args),
    ['users', 'nickname', 'TEXT']
  );

  // An INTERIOR hole is NOT truncated — it cannot be, positionally — so the
  // rule the call sites have to follow is narrower than "never pass
  // undefined": never place one where the receiving method can tell `null`
  // from absent. `updateCellBatch`'s optional `label` sits before the byte cap
  // this lane appends, and the worker's `_label` parameter is unread, so it is
  // the one interior hole that is safe. Pinned so it stays deliberate.
  await backendApi.updateCellBatch('users', [], undefined);
  const batch = host.calls.at(-1)!;
  assert.equal(batch.args.length, 4);
  assert.equal(acrossTheNativeWire('updateCellBatch', batch.args)[2], null);
});

test('the truncation keys on `undefined` ONLY — an explicit trailing null survives', async () => {
  // The other half of the F-E fix, and the one that would have been a silent
  // regression: several worker parameters mean something as `null` (a
  // null-valued cell, an explicitly cleared filter, `exportTable`'s
  // dbOptions/tableStore). If the truncation had matched "nullish" instead of
  // `undefined`, it would have deleted arguments the caller meant, in the same
  // invisible way the original bug added one.
  const host = fakeHost();
  initDesktopApi(host as never);

  // A trailing null is a VALUE. It must reach the worker, and reach it as null.
  await backendApi.updateCell('users', 1, 'name', null, null);
  const update = host.calls.at(-1)!;
  assert.equal(update.method, 'updateCell');
  const wire = acrossTheNativeWire(update.method, update.args);
  assert.equal(wire[3], null, 'the null cell value must survive the JSON lane');
  assert.equal(wire[4], null, 'the null originalValue must not be truncated away');

  // Mixed tail: only the `undefined`s go, and the null before them stays put —
  // so the argument INDEXES of everything to its left are preserved.
  await backendApi.exportTable(
    { table: 'users' }, ['id'], null, null, { format: 'csv' }, undefined
  );
  const exported = host.calls.at(-1)!;
  assert.equal(exported.args.length, 5, 'only the trailing undefined `extras` is dropped');
  const exportedWire = acrossTheNativeWire(exported.method, exported.args);
  assert.equal(exportedWire[2], null);
  assert.equal(exportedWire[3], null);
  assert.deepEqual(exportedWire[4], { format: 'csv' });
});

test('the oversized-cell refusals name THIS app and the route that works', async () => {
  const editor = await backendApi.openCellEditor({}, 1, 'blob', {}, { sourceByteLength: 5_000_000 });
  assert.equal(editor.success, false);
  const message = String(editor.message);
  assert.doesNotMatch(message, /web demo/);
  assert.match(message, /Load More/);
});
