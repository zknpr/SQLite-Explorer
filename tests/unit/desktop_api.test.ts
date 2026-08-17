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

test('view state round-trips through localStorage', () => {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); }
  };
  saveVsCodeState({ selectedTable: 'users' });
  assert.deepEqual(getVsCodeState(), { selectedTable: 'users' });
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
});
