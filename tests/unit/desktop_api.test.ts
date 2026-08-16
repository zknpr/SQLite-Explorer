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
