/**
 * The DOM half of a desktop database switch.
 *
 * `setActiveDb` swaps every per-database field of `state`, but it cannot touch
 * DOM. Anything that mirrors per-database state and is NOT re-rendered by the
 * reload has to be re-synced by desktop-viewer.js's `databaseSwitched` handler,
 * or it keeps describing the OUTGOING database over the incoming one's content.
 * That is a whole class of defect with one cause (a forgotten mirror), so it is
 * pinned here:
 *
 * 1. `closeAllModals` behavior, exercised for real against a DOM stub — a cell
 *    preview / view editor / BLOB inspector left open shows the database the
 *    user just left, and its Save would target a different file.
 * 2. A source-level gate on the handler itself. `databaseSwitched` lives in an
 *    entry-point module with top-level side effects and is not exported, so
 *    this is the only way to assert every mirror is covered; it is the same
 *    approach console_desktop_wiring.test.ts takes for its wiring invariants.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const modalsModulePath = '../../core/ui/modules/modals.js';
const stateModulePath = '../../core/ui/modules/state.js';

function installDocumentMock(modals: Array<{ id: string; hidden: boolean }>) {
  const make = (modal: { id: string; hidden: boolean }) => ({
    id: modal.id,
    classList: {
      add(name: string) { if (name === 'hidden') modal.hidden = true; },
      remove(name: string) { if (name === 'hidden') modal.hidden = false; },
      contains: (name: string) => name === 'hidden' && modal.hidden
    }
  });
  (globalThis as any).document = {
    getElementById: (id: string) => {
      const found = modals.find(modal => modal.id === id);
      return found ? make(found) : null;
    },
    querySelectorAll: () => modals.filter(modal => !modal.hidden).map(make)
  };
}

test('closeAllModals dismisses every open modal and runs their registered cleanup', async () => {
  const modals = [
    { id: 'cellPreviewModal', hidden: false },
    { id: 'viewModal', hidden: false },
    { id: 'blob-inspector-modal', hidden: false },
    { id: 'settingsModal', hidden: true }        // already closed: must stay untouched
  ];
  installDocumentMock(modals);
  try {
    const { closeAllModals, closeModal, registerModalCloseHandler } = await import(modalsModulePath);
    const { state } = await import(stateModulePath);
    const cleanups: string[] = [];
    registerModalCloseHandler('viewModal', () => cleanups.push('viewModal'));
    registerModalCloseHandler('blob-inspector-modal', () => cleanups.push('blob-inspector-modal'));
    state.cellPreviewInfo = { table: 't', rowId: 1, column: 'c' };

    closeAllModals();

    assert.deepEqual(modals.map(m => m.hidden), [true, true, true, true]);
    // Routed through closeModal, so per-modal cleanup ran…
    assert.deepEqual(cleanups.sort(), ['blob-inspector-modal', 'viewModal']);
    // …including the cell preview's state reset, which the desktop needs so a
    // stale preview cannot be saved back into a different database.
    assert.equal(state.cellPreviewInfo, null);

    // Idempotent: nothing is open, nothing more is cleaned up.
    cleanups.length = 0;
    closeAllModals();
    assert.deepEqual(cleanups, []);
    void closeModal;
  } finally {
    delete (globalThis as any).document;
  }
});

/** The body of `async databaseSwitched()` in desktop-viewer.js. */
function databaseSwitchedBody(): string {
  const source = readFileSync(
    path.resolve(process.cwd(), 'core/ui/desktop-viewer.js'), 'utf8'
  );
  const start = source.indexOf('async databaseSwitched()');
  assert.notEqual(start, -1, 'desktop-viewer.js no longer defines a databaseSwitched handler');
  const end = source.indexOf('\n    },', start);
  assert.notEqual(end, -1, 'could not find the end of the databaseSwitched handler');
  return source.slice(start, end);
}

test('the database-switch handler re-syncs every DOM mirror of per-database state', () => {
  const body = databaseSwitchedBody();
  for (const mirror of [
    'tableNameLabel',        // the toolbar's table name
    'filterInput',           // the global filter box
    'btnClearFilter',        // …and its clear affordance
    'sidebarFilterInput',    // the sidebar's name filter
    'closeAllModals',        // modals showing the outgoing database's content
    'showEmptyState',        // the grid, when the incoming database has no selection
    'updateStatus',          // the status line's record count
    'updatePagination'       // the pager's page numbers and arrow states
  ]) {
    assert.equal(body.includes(mirror), true, `databaseSwitched does not re-sync ${mirror}`);
  }
});

test('the table-name label is re-synced unconditionally, not only when no table is selected', () => {
  const body = databaseSwitchedBody();
  const labelAt = body.indexOf('tableNameLabel');
  const noTableBranchAt = body.indexOf('if (!state.selectedTable)');
  assert.notEqual(noTableBranchAt, -1, 'the no-selection branch disappeared');
  // Setting the label only inside the no-selection branch is the bug: switching
  // to a database that HAS a table selected would leave the toolbar naming the
  // outgoing database's table above the incoming one's rows.
  assert.equal(
    labelAt !== -1 && labelAt < noTableBranchAt,
    true,
    'tableNameLabel must be set before (and outside) the no-selection branch'
  );
});
