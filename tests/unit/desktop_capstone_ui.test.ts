/**
 * Deep-QA capstone: host API + viewer UI gaps found by surface enumeration.
 *
 * Everything here was UNTESTED before this file. Two kinds of test live in it:
 *
 * 1. Gap closures — behaviour that is correct but had no regression test.
 * 2. Bug markers — a `test.skip` asserting the behaviour the product SHOULD
 *    have, named after the finding in
 *    SQLite-Explorer-App/.superpowers/sdd/2026-08-18-multi-db/capstone-ui-report.md.
 *
 * Fix wave 1b closed D1, D2, D3, U1, U2 and G1. Wave 2 closed the last marker,
 * U3/G2 (oversized cells), together with G3 (drag-and-drop) and G4/G5 (inert
 * settings and unpersisted UI state): NO test in this file is skipped any more,
 * and every former marker is a real assertion against the fixed behaviour.
 *
 * Harnesses are lifted from the files that already own these modules:
 * desktop_host.test.ts (fake worker + fake bridge) and grid_count_cache.test.ts
 * (minimal document + backendApi monkeypatching).
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDesktopHost } from '../../core/ui/modules/desktop-host.js';

// Untyped UI modules are imported through a path VARIABLE, so tsc does not
// demand a declaration file for them — the convention desktop_host.test.ts,
// crud_identity.test.ts and grid_render.test.ts already use. The bindings are
// the same live singletons the host and the viewer mutate.
const stateModulePath = '../../core/ui/modules/state.js';
const sidebarModulePath = '../../core/ui/modules/sidebar.js';
const apiModulePath = '../../core/ui/modules/api.js';
const exportModulePath = '../../core/ui/modules/export.js';
const blobInspectorModulePath = '../../core/ui/modules/blob-inspector.js';
const desktopApiModulePath = '../../core/ui/modules/desktop-api.js';
const gridDataModulePath = '../../core/ui/modules/grid-data.js';
const countCacheModulePath = '../../core/ui/modules/count-cache.js';
const connectionStateModulePath = '../../core/ui/modules/connection-state.js';

// ---------------------------------------------------------------------------
// desktop host harness (same shape as tests/unit/desktop_host.test.ts)
// ---------------------------------------------------------------------------

type Envelope = {
    channel: string;
    content: { kind: string; messageId: string; targetMethod: string; payload: unknown[] };
};

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
                    worker.onmessage?.({
                        data: { channel: 'rpc', content: { kind: 'response', messageId, success: true, data: handler(payload) } }
                    });
                } catch (error) {
                    worker.onmessage?.({
                        data: {
                            channel: 'rpc',
                            content: {
                                kind: 'response', messageId, success: false,
                                errorMessage: error instanceof Error ? error.message : String(error)
                            }
                        }
                    });
                }
            });
        },
        terminate() { worker.terminated = true; }
    };
    return worker;
}

/** Everything the fake bridge recorded, so a test can say WHERE bytes landed. */
type SaveLog = {
    /** In-place `saveDatabase(path, …)` targets — an ordinary ⌘S. */
    paths: string[];
    /** `saveDatabaseAs(…)` destinations — the Save As dialog's answer. */
    savedAs: string[];
    settings: unknown[];
};

function makeHost(
    handlers: Record<string, (args: unknown[]) => unknown> = {},
    bridgeOverrides: Record<string, unknown> = {}
) {
    const workerHandlers = {
        initializeDatabase: () => ({ isReadOnly: false, storage: 'memory' }),
        ping: () => true,
        exportDatabase: () => new Uint8Array([9, 9]),
        insertRow: () => 1,
        ...handlers
    };
    const posted: Envelope[] = [];
    const titles: string[] = [];
    const saved: SaveLog = { paths: [], savedAs: [], settings: [] };
    const bridge = {
        pickDatabase: async () => ({ path: '/tmp/x.db', name: 'x.db', size: 3 }),
        readDatabaseBytes: async (_p: string) => new Uint8Array([1, 2, 3]),
        saveDatabase: async (path: string, _bytes: Uint8Array) => { saved.paths.push(path); },
        saveFileAs: async (_n: string, _b: Uint8Array) => '/tmp/out',
        // Save As: the dialog plus the shell's session-allowlist grant, which
        // is what lets the database adopt the picked path and save in place
        // afterwards. Default answer is a successful pick.
        saveDatabaseAs: async (_n: string, _b: Uint8Array) => {
            saved.savedAs.push('/tmp/picked.db');
            return '/tmp/picked.db';
        },
        loadSettings: async () => ({}),
        saveSettings: async (s: unknown) => { saved.settings.push(s); },
        onMenu: (_h: (id: string) => void) => {},
        setTitle: async (t: string) => { titles.push(t); },
        ...bridgeOverrides
    };
    const host = createDesktopHost({
        bridge,
        createWorker: () => makeFakeWorker(workerHandlers, posted) as unknown as Worker
    });
    return { host, posted, saved, titles, bridge };
}

/** Every method name the host sent to any worker, in order. */
const methodsPosted = (posted: Envelope[]) => posted.map(p => p.content.targetMethod);

// ===========================================================================
// A. Path-less databases: the boot placeholder and drag-dropped files
// ===========================================================================

test('an edited path-less database is dirty and reports itself unsaved (BUG D1 precondition)', async () => {
    // The boot placeholder ("untitled.db") is a real, editable database — the
    // sidebar's Create Table works on it — and `commitEntry` deliberately KEEPS
    // it once edited rather than dropping it on the first real open. That is
    // exactly why it needs a way to reach disk: the close prompt asks about
    // this work. The Save As lane below is that way.
    const { host, titles } = makeHost();
    await host.start();
    await host.invoke('insertRow', ['t', { a: 1 }]);

    assert.equal(host.hasUnsavedChanges(), true);
    assert.match(titles.at(-1)!, /untitled\.db — Edited/);
    assert.deepEqual(host.listDatabases().map(d => [d.name, d.path]), [['untitled.db', null]]);
});

test('FIXED D1: ⌘S on a path-less database saves it through Save As and adopts the picked file', async () => {
    // Was: `saveToDisk` short-circuited on `!entry.currentPath` and returned a
    // quiet `false` that both callers discarded — no dialog, no status line, no
    // error. ⌘S on the database the app BOOTS INTO did nothing and said
    // nothing, while the close prompt asked about work the user had no way to
    // save.
    const { host, saved, titles } = makeHost();
    await host.start();
    await host.invoke('insertRow', ['t', { a: 1 }]);

    const result = await host.saveToDisk();
    assert.deepEqual(result, { success: true, savedAs: 'picked.db' });
    assert.deepEqual(saved.savedAs, ['/tmp/picked.db'], 'the bytes went to the picked file');
    assert.deepEqual(saved.paths, [], 'nothing was written in place — there was no path yet');

    // The entry adopted the file: name, path, and a clean checkpoint.
    assert.deepEqual(host.listDatabases().map(d => [d.name, d.path, d.isDirty]),
        [['picked.db', '/tmp/picked.db', false]]);
    assert.equal(host.hasUnsavedChanges(), false);
    assert.equal(host.currentFilename(), 'picked.db');
    assert.match(titles.at(-1)!, /^picked\.db — SQLite Explorer$/);
});

test('FIXED D1: after Save As, the next ⌘S is an ordinary in-place save', async () => {
    // Adoption is the point: the shell's `saveDatabaseAs` allowlists the picked
    // path, so from here the database behaves exactly like one opened from
    // disk. Without adoption every save would re-prompt.
    const { host, saved } = makeHost();
    await host.start();
    await host.invoke('insertRow', ['t', { a: 1 }]);
    await host.saveToDisk();

    await host.invoke('insertRow', ['t', { a: 2 }]);
    assert.deepEqual(await host.saveToDisk(), { success: true, savedAs: 'picked.db' });
    assert.deepEqual(saved.paths, ['/tmp/picked.db'], 'in place, not through the dialog again');
    assert.deepEqual(saved.savedAs, ['/tmp/picked.db'], 'the dialog ran exactly once');
});

test('FIXED D1: a cancelled Save As writes nothing, says so, and leaves the work intact', async () => {
    const { host, saved } = makeHost({}, { saveDatabaseAs: async () => null });
    await host.start();
    await host.invoke('insertRow', ['t', { a: 1 }]);

    assert.deepEqual(await host.saveToDisk(), { success: false, reason: 'cancelled' });
    assert.deepEqual(saved.paths, []);
    // Still path-less and still dirty — a cancelled dialog must not checkpoint.
    assert.deepEqual(host.listDatabases().map(d => [d.name, d.path, d.isDirty]),
        [['untitled.db', null, true]]);
    assert.equal(host.hasUnsavedChanges(), true);
});

test('FIXED D1: an adopted database is no longer the scratch placeholder, so the next open cannot delete it', async () => {
    // `commitEntry` removes the previous entry when it is a CLEAN scratch one.
    // Save As makes the placeholder clean (it checkpoints), so leaving
    // `isScratch` set would have made the very next open silently destroy the
    // database the user had just saved to disk.
    const { host } = makeHost();
    await host.start();
    await host.invoke('insertRow', ['t', { a: 1 }]);
    await host.saveToDisk();

    await host.openFromShellPath('/tmp/other.db');
    assert.deepEqual(host.listDatabases().map(d => d.name), ['picked.db', 'other.db']);
});

test('FIXED D1: Save As refuses to LINK a file another database already has open', async () => {
    // One file, one entry — the invariant the open lanes' dedupe keeps. Two
    // entries on one path would mean two writable engines with independent
    // session transactions on it. The bytes still land (the user picked that
    // file in a save dialog); what is refused is the adoption.
    const writes: string[] = [];
    const { host, saved } = makeHost({}, {
        saveDatabaseAs: async () => { writes.push('/tmp/taken.db'); return '/tmp/taken.db'; }
    });
    await host.start();
    // Edit the placeholder FIRST so the open below retains it (commitEntry
    // drops an unedited scratch database), then open the file it will try to
    // claim, then come back to it.
    await host.invoke('insertRow', ['t', { a: 1 }]);
    await host.openFromShellPath('/tmp/taken.db');
    const scratch = host.listDatabases().find(d => d.path === null)!;
    await host.setActiveDb(scratch.dbId);

    await assert.rejects(() => host.saveToDisk(), /already open in another tab/);
    assert.deepEqual(writes, ['/tmp/taken.db'], 'the write itself happened');
    // The placeholder did NOT adopt the path, so nothing has two engines.
    assert.deepEqual(
        host.listDatabases().map(d => [d.name, d.path]),
        [['untitled.db', null], ['taken.db', '/tmp/taken.db']]
    );
    assert.equal(saved.paths.includes('/tmp/taken.db'), false);
});

test('FIXED D1: a shell too old for Save As refuses loudly instead of half-saving', async () => {
    // The alternative — falling back to `saveFileAs` — would write the bytes
    // and then leave the database unable to save to the file the user just
    // chose, because that route deliberately does not allowlist its
    // destination. That is the silent half-success this lane exists to remove.
    const { host, saved } = makeHost({}, { saveDatabaseAs: undefined });
    await host.start();
    await host.invoke('insertRow', ['t', { a: 1 }]);

    await assert.rejects(() => host.saveToDisk(), /cannot Save As/);
    assert.deepEqual(saved.paths, []);
    assert.deepEqual(saved.savedAs, []);
    assert.equal(host.hasUnsavedChanges(), true);
});

test('GAP: refreshFromDisk on a path-less database is a quiet no-op, not an error', async () => {
    const { host, posted } = makeHost();
    await host.start();
    const bootCalls = methodsPosted(posted).length;
    await host.refreshFromDisk();
    // No re-initialize, no bridge read: there is no file to re-read.
    assert.deepEqual(methodsPosted(posted).slice(bootCalls), []);
});

test('GAP: a cancelled Open dialog opens nothing and reports false', async () => {
    const { host, posted } = makeHost({}, { pickDatabase: async () => null });
    await host.start();
    const before = methodsPosted(posted).length;
    assert.equal(await host.openDatabaseViaDialog(), false);
    assert.equal(host.listDatabases().length, 1);
    assert.deepEqual(methodsPosted(posted).slice(before), [], 'no second engine booted');
});

// ===========================================================================
// B. Settings persistence
// ===========================================================================

test('FIXED D2: a settings write that FAILS rolls the in-memory value back', async () => {
    // Was: `settings` was reassigned BEFORE `bridge.saveSettings`, and never
    // restored when the write rejected. The error propagated (good), but the
    // rejected value stayed live for the whole session. With `autoCommit` that
    // is not cosmetic: every later edit would commit straight into the user's
    // file with no ⌘S, and the next launch would silently revert to manual.
    const { host, saved } = makeHost({}, {
        saveSettings: async () => { throw new Error('disk full'); }
    });
    await host.start();

    await assert.rejects(
        () => host.invoke('updateExtensionSetting', ['autoCommit', true]),
        /disk full/
    );
    assert.deepEqual(saved.settings, [], 'nothing was persisted');

    // The wire shape the settings modal re-reads matches disk again.
    const wire = await host.invoke('getExtensionSettings', []) as { autoCommit: boolean };
    assert.equal(wire.autoCommit, false);

    // …and, the half that touches the user's file: auto-commit is genuinely OFF.
    await host.openFromShellPath('/tmp/real.db');
    await host.invoke('insertRow', ['t', { a: 1 }]);
    assert.deepEqual(saved.paths, [], 'the rejected setting did not auto-commit');
    assert.equal(host.hasUnsavedChanges(), true);
});

test('FIXED D2: a failed doubleClickBehavior write re-pushes the PREVIOUS value to the page', async () => {
    // The host pushes this one to the webview before persisting (VS Code parity
    // — a config change fans out updateCellEditBehavior). Rolling back memory
    // without undoing the push would leave the page on the rejected behaviour.
    let failWrites = false;
    const pushed: unknown[] = [];
    const { host } = makeHost({}, {
        saveSettings: async () => { if (failWrites) throw new Error('read-only volume'); }
    });
    host.setWebviewMethods({ updateCellEditBehavior: async (value: unknown) => { pushed.push(value); } });
    await host.start();
    assert.deepEqual(pushed, ['inline'], 'start() seeds the page');

    failWrites = true;
    await assert.rejects(
        () => host.invoke('updateExtensionSetting', ['doubleClickBehavior', 'modal']),
        /read-only volume/
    );
    assert.deepEqual(pushed, ['inline', 'modal', 'inline'], 'pushed, then put back');
    const wire = await host.invoke('getExtensionSettings', []) as { cellEditBehavior: string };
    assert.equal(wire.cellEditBehavior, 'inline');
});

test('a settings write that SUCCEEDS keeps the new value and persists only the delta', async () => {
    const { host, saved } = makeHost();
    await host.start();
    assert.deepEqual(await host.invoke('updateExtensionSetting', ['autoCommit', true]), { success: true });
    assert.deepEqual(saved.settings, [{ instantCommit: 'always' }]);
    const wire = await host.invoke('getExtensionSettings', []) as { autoCommit: boolean };
    assert.equal(wire.autoCommit, true);
});

// ===========================================================================
// C. refreshFile's contract
// ===========================================================================

test('FIXED D3: refreshFile answers {connected, filename, readOnly} like the VS Code host', async () => {
    // src/hostBridge.ts documents refreshFile's return as "Refreshed connection
    // capabilities for immediate webview gating". The desktop host answered
    // {success:true}, and sidebar.js's reloadFromDisk gates on
    // `connectionResult?.connected === true` before calling
    // applyConnectionResult — so the sidebar's Reload button was the one
    // refresh entry point that never re-applied read-only state. (⌘R goes
    // through host.refreshFromDisk → refreshUi and always carried the flags.)
    const { host } = makeHost();
    await host.start();
    await host.openFromShellPath('/tmp/real.db');

    assert.deepEqual(await host.invoke('refreshFile', []), {
        connected: true, filename: 'real.db', readOnly: false
    });
});

test('FIXED D3: a file that comes back READ-ONLY re-gates the sidebar through applyConnectionResult', async () => {
    let readOnly = false;
    const { host } = makeHost({ initializeDatabase: () => ({ isReadOnly: readOnly, storage: 'memory' }) });
    await host.start();
    await host.openFromShellPath('/tmp/real.db');

    readOnly = true;                                    // permissions changed on disk
    const result = await host.invoke('refreshFile', []) as Record<string, unknown>;
    assert.deepEqual(result, { connected: true, filename: 'real.db', readOnly: true });

    // The guard the sidebar actually uses, against the module that owns it.
    const { applyConnectionResult } = await import(connectionStateModulePath);
    const { state: liveState } = await import(stateModulePath);
    (globalThis as any).document = { getElementById: () => null };
    try {
        assert.equal(applyConnectionResult(result), true);
        assert.equal(liveState.isReadOnly, true);
    } finally {
        delete (globalThis as any).document;
    }
});

test('FIXED D3: a path-less database reports its capabilities rather than faking a reload', async () => {
    const { host } = makeHost();
    await host.start();
    assert.deepEqual(await host.invoke('refreshFile', []), {
        connected: true, filename: 'untitled.db', readOnly: false
    });
});

// ===========================================================================
// D. Save targets exactly one database
// ===========================================================================

test('GAP: ⌘S checkpoints ONLY the active database; a dirty background one stays dirty', async () => {
    const { host, saved } = makeHost();
    await host.start();
    await host.openFromShellPath('/tmp/a.db');
    await host.invoke('insertRow', ['t', { a: 1 }]);
    await host.openFromShellPath('/tmp/b.db');
    await host.invoke('insertRow', ['t', { b: 2 }]);

    const idOf = (name: string) => host.listDatabases().find(d => d.name === name)!.dbId;
    await host.setActiveDb(idOf('a.db'));
    assert.deepEqual(await host.saveToDisk(), { success: true, savedAs: 'a.db' });

    assert.deepEqual(saved.paths, ['/tmp/a.db'], 'only the active file was written');
    const byName = Object.fromEntries(host.listDatabases().map(d => [d.name, d.isDirty]));
    assert.deepEqual(byName, { 'a.db': false, 'b.db': true });
    // The app-level unsaved check still sees the background database, which is
    // what makes the quit prompt honest.
    assert.equal(host.hasUnsavedChanges(), true);
});

// ===========================================================================
// E. Sidebar schema tree: the name filter
// ===========================================================================

function createClassList(initial: string[] = []) {
    const classes = new Set(initial);
    return {
        add: (...names: string[]) => names.forEach(n => classes.add(n)),
        remove: (...names: string[]) => names.forEach(n => classes.delete(n)),
        contains: (name: string) => classes.has(name),
        toggle: (name: string, force?: boolean) => {
            const on = force ?? !classes.has(name);
            if (on) classes.add(name); else classes.delete(name);
            return on;
        }
    };
}

/** Node stand-in rich enough for renderSidebar's list building. */
function makeNode(tagName = 'div') {
    const node: any = {
        tagName: tagName.toUpperCase(),
        children: [] as any[],
        dataset: {} as Record<string, string>,
        style: {} as Record<string, string>,
        classList: createClassList(),
        className: '',
        textContent: '',
        title: '',
        type: '',
        disabled: false,
        appendChild(child: any) { node.children.push(child); return child; },
        replaceChildren(...kids: any[]) { node.children = kids; },
        setAttribute(name: string, value: string) { node.dataset[`attr_${name}`] = value; },
        addEventListener() {},
        focus() {}
    };
    return node;
}

function installSidebarDocument() {
    const ids = [
        'tablesList', 'viewsList', 'indexesList',
        'tablesBadge', 'viewsBadge', 'indexesBadge'
    ];
    const elements: Record<string, any> = {};
    for (const id of ids) elements[id] = makeNode('ul');
    (globalThis as any).document = {
        getElementById: (id: string) => elements[id] ?? null,
        createElement: (tag: string) => makeNode(tag),
        createDocumentFragment: () => makeNode('fragment'),
        querySelector: () => null,
        querySelectorAll: () => []
    };
    return elements;
}

/** Names rendered into a list stand-in (fragments are appended whole). */
function renderedNames(list: any): string[] {
    const items: any[] = [];
    for (const child of list.children) {
        if (child.tagName === 'FRAGMENT') items.push(...child.children);
        else items.push(child);
    }
    return items.map(li => li.dataset.name ?? li.textContent);
}

let state: Record<string, any>;
let renderSidebar: () => void;

before(async () => {
    ({ state } = await import(stateModulePath));
    ({ renderSidebar } = await import(sidebarModulePath));
});

function primeSchema() {
    state.schemaCache = {
        tables: [
            { name: 'orders' },
            { name: 'ORDERS_ARCHIVE' },
            // Adversarial identifiers: non-ASCII, a quote, and markup. All of
            // them must survive the filter as data and reach the DOM through
            // textContent/dataset, never markup.
            { name: 'Ünïcode_Tábla' },
            { name: 'we"ird' },
            { name: '<script>alert(1)</script>' },
            { name: '__proto__' }
        ],
        views: [{ name: 'order_totals' }],
        indexes: [{ name: 'idx_orders', table: 'orders' }]
    };
    state.selectedTable = null;
    state.selectedTableType = 'table';
    state.isReadOnly = false;
}

test('GAP: the sidebar filter is case-insensitive, unicode-safe, and reports filtered/total', () => {
    const elements = installSidebarDocument();
    try {
        primeSchema();

        state.sidebarFilter = '';
        renderSidebar();
        assert.equal(elements.tablesBadge.textContent, 6, 'unfiltered badge is the raw total');
        assert.equal(renderedNames(elements.tablesList).length, 6);

        state.sidebarFilter = 'OrDeRs';
        renderSidebar();
        assert.deepEqual(renderedNames(elements.tablesList), ['orders', 'ORDERS_ARCHIVE']);
        assert.equal(elements.tablesBadge.textContent, '2/6');

        // Non-ASCII: the filter lowercases both sides, so a lowercase query
        // still finds a capitalised accented identifier.
        state.sidebarFilter = 'ünïcode';
        renderSidebar();
        assert.deepEqual(renderedNames(elements.tablesList), ['Ünïcode_Tábla']);

        // A name that is also an Object.prototype key must be an ordinary row.
        state.sidebarFilter = '__proto__';
        renderSidebar();
        assert.deepEqual(renderedNames(elements.tablesList), ['__proto__']);

        // Quotes and markup are carried verbatim as data.
        state.sidebarFilter = 'script';
        renderSidebar();
        const [markup] = renderedNames(elements.tablesList);
        assert.equal(markup, '<script>alert(1)</script>');
    } finally {
        delete (globalThis as any).document;
    }
});

test('GAP: a filter that matches nothing renders the empty notice, not an empty list', () => {
    const elements = installSidebarDocument();
    try {
        primeSchema();
        state.sidebarFilter = 'zzz-no-such-object';
        renderSidebar();

        assert.deepEqual(renderedNames(elements.tablesList), ['No matching tables']);
        assert.deepEqual(renderedNames(elements.viewsList), ['No matching views']);
        assert.deepEqual(renderedNames(elements.indexesList), ['No matching indexes']);
        assert.equal(elements.tablesBadge.textContent, '0/6');
        assert.equal(elements.viewsBadge.textContent, '0/1');
        assert.equal(elements.indexesBadge.textContent, '0/1');

        // An EMPTY database (no filter, nothing in the schema) says something
        // different — "No tables", not "No matching tables".
        state.sidebarFilter = '';
        state.schemaCache = { tables: [], views: [], indexes: [] };
        renderSidebar();
        assert.deepEqual(renderedNames(elements.tablesList), ['No tables']);
        assert.equal(elements.tablesBadge.textContent, 0);
    } finally {
        delete (globalThis as any).document;
    }
});

// ===========================================================================
// F. The file-output surface: one { success, savedAs } contract, honoured
// ===========================================================================

function installExportDocument(checkedColumns: string[]) {
    const elements: Record<string, any> = {
        statusText: { textContent: '' },
        exportModal: { id: 'exportModal', classList: createClassList() },
        exportFormat: { value: 'csv' },
        exportHeader: { checked: true }
    };
    (globalThis as any).document = {
        getElementById: (id: string) => elements[id] ?? null,
        querySelectorAll: (selector: string) =>
            selector === '.export-col-check:checked'
                ? checkedColumns.map(value => ({ value }))
                : [],
        querySelector: () => null,
        createElement: (tag: string) => makeNode(tag)
    };
    return elements;
}

async function runExport(result: unknown) {
    const elements = installExportDocument(['value']);
    const { backendApi } = await import(apiModulePath);
    const original = backendApi.exportTable;
    const calls: unknown[][] = [];
    try {
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.selectedRowIds = new Set();
        state.gridReadOnlyRowReasons = {};
        state.gridData = [];
        const { submitExport } = await import(exportModulePath);
        backendApi.exportTable = async (...args: unknown[]) => { calls.push(args); return result; };
        await submitExport();
    } finally {
        backendApi.exportTable = original;
        delete (globalThis as any).document;
    }
    return { status: elements.statusText.textContent as string, calls };
}

test('FIXED U1: a CANCELLED table export says so instead of reporting success', async () => {
    // export.js awaited backendApi.exportTable and then wrote "Export
    // initiated" unconditionally, dropping the {success, savedAs} the desktop
    // host returns. On the desktop `success:false` is exactly "the user pressed
    // Cancel in the save dialog", so Cancel was indistinguishable from a real
    // export.
    const { status, calls } = await runExport({ success: false });
    assert.equal(status, 'Export cancelled');
    // The RPC payload itself was already correct — pin it as a regression test.
    assert.equal((calls[0][0] as any).table, 'items');
    assert.deepEqual(calls[0][1], ['value']);
    assert.deepEqual(calls[0][4], { format: 'csv', header: true });
});

test('FIXED U1: a successful export names the file the host wrote', async () => {
    const { status } = await runExport({ success: true, savedAs: 'items.csv' });
    assert.equal(status, 'Exported to items.csv');
});

test('U1: the VS Code and web lanes, which resolve without the flag, keep the old wording', async () => {
    // hostBridge.ts's exportTable resolves void and the web demo resolves the
    // worker's {contentChunks, filename}: neither is a cancellation, and on
    // those lanes the host really does finish the write out of band.
    assert.equal((await runExport(undefined)).status, 'Export initiated');
    assert.equal((await runExport({ contentChunks: [], filename: 'items.csv' })).status, 'Export initiated');
});

function installBlobDocument() {
    const elements: Record<string, any> = {
        statusText: { textContent: '' },
        'blob-inspector-modal': Object.assign(makeNode('div'), { querySelectorAll: () => [] }),
        'tab-preview': makeNode('div'),
        'blob-info': makeNode('div'),
        'blob-download-btn': makeNode('button'),
        'blob-replace-btn': makeNode('button')
    };
    (globalThis as any).document = {
        getElementById: (id: string) => elements[id] ?? null,
        querySelector: (sel: string) => (sel === '.hex-dump' ? makeNode('textarea') : null),
        querySelectorAll: () => [],
        createElement: (tag: string) => makeNode(tag)
    };
    return elements;
}

async function runBlobDownload(result: unknown) {
    const elements = installBlobDocument();
    const { backendApi } = await import(apiModulePath);
    const originalSave = backendApi.saveFile;
    const originalSettings = backendApi.getExtensionSettings;
    try {
        const { BlobInspector } = await import(blobInspectorModulePath);
        const inspector: any = new BlobInspector();
        inspector.currentData = new Uint8Array([1, 2, 3]);
        inspector.currentType = { ext: 'bin' };
        inspector.currentRowId = 7;

        backendApi.getExtensionSettings = async () => ({ fileOperations: 'native' });
        backendApi.saveFile = async () => result;
        await inspector.download();
    } finally {
        backendApi.saveFile = originalSave;
        backendApi.getExtensionSettings = originalSettings;
        delete (globalThis as any).document;
    }
    return elements.statusText.textContent as string;
}

test('FIXED U2: a cancelled blob download no longer claims the file was saved', async () => {
    // `updateStatus(\`Saved ${result?.savedAs ?? filename}\`)` fell back to the
    // PROPOSED filename precisely when savedAs was absent — the cancelled case
    // — so it named a file that was never written. Worse than U1: the flag was
    // returned and actively masked.
    assert.equal(await runBlobDownload({ success: false }), 'Save cancelled');
});

test('FIXED U2: a successful blob download names the file the host wrote', async () => {
    assert.equal(await runBlobDownload({ success: true, savedAs: 'picked.bin' }), 'Saved picked.bin');
});

test('U2: the VS Code and web lanes keep the proposed-filename fallback', async () => {
    assert.equal(await runBlobDownload(undefined), 'Saved blob_7.bin');
});

// ===========================================================================
// G. Whole-database export is REACHABLE (BUG G1)
// ===========================================================================

const desktopBundle = () =>
    readFileSync(path.resolve(process.cwd(), 'desktop/viewer.html'), 'utf8');

test('FIXED G1: the shipped desktop bundle actually CALLS exportDb', () => {
    // The finding was a static one and so is its regression test: `exportDb`
    // was fully implemented on both engines (native out-of-band VACUUM INTO +
    // shell atomic move; WASM bytes + save dialog), listed in rpc-constants,
    // covered by host unit tests — and had zero call sites, so no user could
    // ever reach it. A unit test cannot catch that; only the built artifact can.
    const bundle = desktopBundle();
    assert.ok(/\.exportDb\(/.test(bundle), 'no call site for exportDb in desktop/viewer.html');
    assert.ok(bundle.includes('export-db'), 'the File > Export Database menu id is not handled');
});

test('FIXED G1: the desktop entry point wires the export-db menu id to the host', () => {
    const source = readFileSync(
        path.resolve(process.cwd(), 'core/ui/desktop-viewer.js'), 'utf8'
    );
    assert.match(source, /id === 'export-db'/);
    // …and reports the SAME contract the rest of the file-output surface does,
    // rather than announcing a copy the user cancelled.
    assert.match(source, /Database export cancelled/);
});

// ===========================================================================
// H. Oversized cells: the desktop tells the user about "the web demo"
// ===========================================================================

test('FIXED U3: the desktop refusals name the DESKTOP and point at the working route', async () => {
    // desktop-api.js:200-218 was copied from web-api.js verbatim, so the two
    // refusals a desktop user can actually hit — "Download" on an oversized
    // cell (blob-inspector openFullContent) and a large media preview — named a
    // product they are not running, and named no alternative because there was
    // none. Both are still refusals (neither capability exists on the desktop),
    // but they now name this app and the route that does work.
    const desktopApi = await import(desktopApiModulePath);
    const editor = await desktopApi.backendApi.openCellEditor(
        {}, 1, 'blob', {}, { sourceByteLength: 5_000_000 }
    ) as { success: boolean; message: string };
    assert.equal(editor.success, false);
    assert.doesNotMatch(editor.message, /web demo/);
    assert.match(editor.message, /Load More/);

    const media = await desktopApi.backendApi.prepareCellMediaPreview(
        {}, 1, 'blob', { sourceByteLength: 5_000_000 }
    ) as { success: boolean; message: string };
    assert.equal(media.success, false);
    assert.doesNotMatch(media.message, /web demo/);
    assert.match(media.message, /Load More/);
});

test('FIXED G2: the shipped desktop bundle actually CALLS the chunked cell-read API', () => {
    // The other half of the finding, and a static one like G1: the worker
    // implemented openCellReadSession/readCellChunk/closeCellReadSession, the
    // host special-cased them to keep its native export guard honest, and NO UI
    // module called them — so the host's cellReadSessionOpen flag could never
    // become true and a >64 KiB cell could not be read in full at all.
    const bundle = desktopBundle();
    assert.ok(/\.openCellReadSession\(/.test(bundle), 'no call site for openCellReadSession');
    assert.ok(/\.readCellChunk\(/.test(bundle), 'no call site for readCellChunk');
    assert.ok(/\.closeCellReadSession\(/.test(bundle), 'no call site for closeCellReadSession');
});

// ===========================================================================
// I. Grid: empty tables and filters that match nothing
// ===========================================================================

function installGridDocument() {
    const elements: Record<string, any> = {
        pageIndicator: { textContent: '' },
        btnFirst: { disabled: false },
        btnPrev: { disabled: false },
        btnNext: { disabled: false },
        btnLast: { disabled: false },
        statusText: { textContent: '' },
        filterMatchCounter: { textContent: '' }
    };
    (globalThis as any).document = {
        getElementById: (id: string) => elements[id] ?? null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: (tag: string) => makeNode(tag)
    };
    return elements;
}

function primeGrid(table: string, pageIndex: number) {
    state.dbId = null;
    state.selectedTable = table;
    state.selectedTableType = 'table';
    state.selectedTableIdentity = null;
    state.renderedTable = null;
    state.tableColumns = [{ name: 'value', type: 'TEXT' }];
    state.currentPageIndex = pageIndex;
    state.rowsPerPage = 20;
    state.columnFilters = {};
    state.filterQuery = '';
    state.sortedColumn = null;
    state.sortAscending = true;
    state.isLoadingData = false;
    state.isGridReloading = false;
    state.isReadOnly = false;
    state.editingCellInfo = null;
    state.keysetAnchors = null;
    state.gridData = [];
    state.selectedRowIds = new Set();
    state.selectedColumns = new Set();
    state.selectedCells = [];
    state.gridReadOnlyRowReasons = {};
}

test('GAP: an empty table clamps to page 1/1, shows "0 records", and disables every pager arrow', async () => {
    const elements = installGridDocument();
    const { backendApi } = await import(apiModulePath);
    const { loadTableData } = await import(gridDataModulePath);
    const countCache = await import(countCacheModulePath);
    const originals = { count: backendApi.fetchTableCount, data: backendApi.fetchTableData };
    try {
        countCache.invalidateAllCounts();
        // Deep page index on purpose: an emptied table must clamp, not render a
        // ghost page 4 of 1.
        primeGrid('items', 3);
        backendApi.fetchTableCount = async () => ({ count: 0, isExact: true });
        backendApi.fetchTableData = async () => ({ rows: [] });

        assert.equal(await loadTableData(true, false), true);
        assert.equal(state.totalRecordCount, 0);
        assert.equal(state.totalPageCount, 1);
        assert.equal(state.currentPageIndex, 0);
        assert.deepEqual(state.gridData, []);
        assert.equal(elements.pageIndicator.textContent, '1 / 1');
        assert.deepEqual(
            ['btnFirst', 'btnPrev', 'btnNext', 'btnLast'].map(id => elements[id].disabled),
            [true, true, true, true]
        );
        assert.equal(elements.statusText.textContent, '0 records');
    } finally {
        backendApi.fetchTableCount = originals.count;
        backendApi.fetchTableData = originals.data;
        delete (globalThis as any).document;
    }
});

test('GAP: a filter that matches nothing EMPTIES the grid instead of leaving the last page on screen', async () => {
    const elements = installGridDocument();
    const { backendApi } = await import(apiModulePath);
    const { loadTableData } = await import(gridDataModulePath);
    const countCache = await import(countCacheModulePath);
    const originals = { count: backendApi.fetchTableCount, data: backendApi.fetchTableData };
    try {
        countCache.invalidateAllCounts();
        primeGrid('items', 0);
        backendApi.fetchTableCount = async () => ({ count: 2, isExact: true });
        backendApi.fetchTableData = async () => ({ rows: [[1, 'a'], [2, 'b']] });
        await loadTableData(true, false);
        assert.equal(state.gridData.length, 2);

        // Now a predicate nothing satisfies.
        state.filterQuery = 'no-such-value';
        backendApi.fetchTableCount = async () => ({ count: 0, isExact: true });
        backendApi.fetchTableData = async () => ({ rows: [] });
        assert.equal(await loadTableData(false, false), true);

        assert.deepEqual(state.gridData, [], 'stale rows must not survive a zero-match filter');
        assert.equal(state.totalRecordCount, 0);
        assert.equal(elements.statusText.textContent, '0 records');
        // The retained filter identity is the one that actually loaded, so a
        // later failure rolls back to THIS predicate, not the previous one.
        assert.equal(state.lastSuccessfulFilterState.filterQuery, 'no-such-value');
        assert.equal(state.lastSuccessfulFilterState.table, 'items');
    } finally {
        backendApi.fetchTableCount = originals.count;
        backendApi.fetchTableData = originals.data;
        delete (globalThis as any).document;
    }
});

// ===========================================================================
// J. Drag-and-drop, and settings that used to do nothing (BUGS G3, G4, G5)
// ===========================================================================

test('FIXED G3: the desktop entry wires OS file drops to the shell path lane', () => {
    // `host.openDatabaseFromFile` had no call site in core/ — dropping a .db on
    // the window could not open it. It is gone: Tauri handles OS drag-and-drop
    // natively (`dragDropEnabled` defaults true), so the webview never receives
    // an HTML5 file drop at all and a `File` handle could never have arrived.
    // The shell forwards PATHS instead, which is also the only shape that can
    // bind a native sidecar and stay saveable in place.
    const source = readFileSync(
        path.resolve(process.cwd(), 'core/ui/desktop-viewer.js'), 'utf8'
    );
    assert.match(source, /bridge\.onDragDropPaths\?\.\(/);
    assert.match(source, /openFromShellPath\(path\)/);

    const host = readFileSync(
        path.resolve(process.cwd(), 'core/ui/modules/desktop-host.js'), 'utf8'
    );
    assert.doesNotMatch(host, /^\s*async openDatabaseFromFile\(/m);

    // The optional bridge member is declared, like onOpenFile, so an older
    // shell without it degrades to "drops do nothing" rather than throwing.
    const types = readFileSync(
        path.resolve(process.cwd(), 'core/ui/modules/desktop-host.d.ts'), 'utf8'
    );
    assert.match(types, /onDragDropPaths\?\(handler: \(paths: string\[\]\) => void\): void;/);
});

test('FIXED G4: the desktop consumes defaultPageSize and maxInlineCellBytes', () => {
    // Both were declared in DEFAULT_SETTINGS and read by nobody:
    // resolveStartupPageSize is called only from the VS Code entry (which gets
    // the value off an HTML-template dataset the desktop page does not have),
    // and maxInlineCellBytes had no reader anywhere.
    const source = readFileSync(
        path.resolve(process.cwd(), 'core/ui/desktop-viewer.js'), 'utf8'
    );
    assert.match(source, /resolveStartupPageSize\(startupSettings\.defaultPageSize/);
    assert.match(source, /syncPageSizeSelect\(state\.rowsPerPage\)/);

    const host = readFileSync(
        path.resolve(process.cwd(), 'core/ui/modules/desktop-host.js'), 'utf8'
    );
    assert.match(host, /maxInlineCellBytes: settings\.maxInlineCellBytes/);
});

test('FIXED G5: sidebar width persists through the settings store, not dead localStorage', () => {
    const source = readFileSync(
        path.resolve(process.cwd(), 'core/ui/desktop-viewer.js'), 'utf8'
    );
    assert.match(source, /initSidebarResize\(\s*startupSettings\.sidebarWidth > 0/);

    // The width was ALSO dropped one layer lower: ui.js calls
    // saveSidebarState('left', width) and this lane declared one parameter.
    const api = readFileSync(
        path.resolve(process.cwd(), 'core/ui/modules/desktop-api.js'), 'utf8'
    );
    assert.match(api, /saveSidebarState: \(side, position\) =>/);

    // And the viewer-state seam is now an explicit no-op rather than a write
    // nobody reads — see tests/unit/desktop_api.test.ts for the behaviour.
    assert.match(api, /export function saveVsCodeState\(_stateObj\) \{\}/);
});

// ===========================================================================
// K. The OS-delivered open lane is SERIALISED (BUG F-B)
//
// Found live against a bundled .app: "Open With" on a 14-file Finder selection
// started 14 independent `host.openFromShellPath` calls. The shell emits one
// `desktop-open-file` event PER PATH, so the `for … await` loop that already
// serialises the drop lane has no batch to loop over here — the ordering has
// to be carried ACROSS handler invocations by a chain.
// ===========================================================================

/**
 * The `onOpenFile` registration from desktop-viewer.js as runnable source, so
 * the assertions below execute the SHIPPED wiring rather than paraphrasing it.
 * (Same technique as web_viewer_refresh.test.ts, which evaluates a built
 * bundle; the entry point itself cannot be imported — it boots a whole viewer
 * against a real DOM on import.)
 */
function shellOpenLaneSource(): string {
    const source = readFileSync(
        path.resolve(process.cwd(), 'core/ui/desktop-viewer.js'), 'utf8'
    );
    const start = source.indexOf('let shellOpenChain');
    assert.notEqual(start, -1, 'desktop-viewer.js no longer serialises the onOpenFile lane');
    const terminator = '\n        });';
    const end = source.indexOf(terminator, start);
    assert.notEqual(end, -1, 'could not find the end of the onOpenFile registration');
    return source.slice(start, end + terminator.length);
}

test('FIXED F-B: OS-delivered opens run one at a time, in delivery order, and every file is attempted', async () => {
    const running: string[] = [];
    const overlaps: string[] = [];
    const started: string[] = [];
    const completed: string[] = [];
    const reported: string[] = [];
    let settledCount = 0;

    const host = {
        openFromShellPath: async (p: string) => {
            // The overlap check is the whole point: with the old handler every
            // delivery started its own open, so a second path entered here
            // while the first was still awaiting its engine.
            if (running.length > 0) overlaps.push(`${running.join()} || ${p}`);
            running.push(p);
            started.push(p);
            await new Promise(resolve => setTimeout(resolve, 0));
            running.pop();
            settledCount += 1;
            if (p.includes('bad')) throw new Error('file is not a database');
            completed.push(p);
            return true;
        }
    };
    const surface = (label: string) => (err: Error) => { reported.push(`${label}: ${err.message}`); };
    let deliver: ((p: string) => void) | null = null;
    const bridge = { onOpenFile: (handler: (p: string) => void) => { deliver = handler; } };

    new Function('bridge', 'host', 'surface', shellOpenLaneSource())(bridge, host, surface);
    assert.notEqual(deliver, null, 'the registration did not install a handler');

    // Five SEPARATE events in one synchronous burst — exactly how a Finder
    // multi-selection arrives.
    const delivered = ['/a.db', '/b.db', '/bad.db', '/c.db', '/d.db'];
    for (const p of delivered) deliver!(p);

    for (let i = 0; i < 500 && settledCount < delivered.length; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(settledCount, delivered.length, 'the open chain never drained');

    assert.deepEqual(overlaps, [], 'two OS-delivered opens were in flight at once');
    // Delivery order is preserved, so the LAST file the user selected is the
    // last one opened — and therefore the one left active.
    assert.deepEqual(started, delivered);
    // A file that fails is reported and does not break the chain: the two after
    // it still open.
    assert.deepEqual(completed, ['/a.db', '/b.db', '/c.db', '/d.db']);
    assert.deepEqual(reported, ['Open failed: file is not a database']);
});

// ===========================================================================
// L. A read-only database says SO, and cannot report a save it never made
//     (BUG F-C)
//
// A database in a read-only DIRECTORY (equally: a 0444 file, a read-only
// mount) opens read-only. That is a legitimate outcome — but the engine's
// `readOnlyReason` reached the page in every connection result and nothing
// read it, so the only signals were disabled buttons; and ⌘S then reported
// "Saved <file>" for a commit that never happened.
// ===========================================================================

test('FIXED F-C: the desktop worker escalates to read-only THROUGH the engine, not behind it', () => {
    // The root cause of the broken grid, and a static one: the worker armed
    // `PRAGMA query_only` itself, which on the native engine left the sql.js
    // shim's own read-only flag false — so its column probe never lifted the
    // pragma, SQLite refused the probe's TEMP VIEW as a write, and the
    // swallowed refusal became "no columns". Only the built artifacts show
    // which branch each bundle actually ships.
    const authored = readFileSync(
        path.resolve(process.cwd(), 'website/src/sqlite-viewer/worker.js'), 'utf8'
    );
    assert.match(authored, /typeof db\.enforceReadOnly === 'function'/);

    // The desktop native worker is the bundle that has a shim to talk to.
    const nativeBundle = readFileSync(
        path.resolve(process.cwd(), 'desktop/native-worker-desktop.js'), 'utf8'
    );
    assert.ok(nativeBundle.includes('enforceReadOnly'),
        'the shipped native sidecar bundle never calls enforceReadOnly');

    // sql.js has no read-only state of its own, so the raw pragma is still the
    // right call there and must survive.
    assert.match(authored, /PRAGMA query_only = ON/);
});

test('FIXED F-C: the desktop entry says WHY a database is read-only, once per change', () => {
    const source = readFileSync(
        path.resolve(process.cwd(), 'core/ui/desktop-viewer.js'), 'utf8'
    );
    // Fed from the connection result the host already carried.
    assert.match(source, /reportReadOnlyReason\(connectionResult\.readOnlyReason\)/);
    // Guarded against re-posting on every refreshContent, which would keep
    // wiping the status line the user's last action wrote.
    assert.match(source, /if \(current === reportedReadOnlyReason\) return;/);
    // And ⌘S no longer claims a save on a database that cannot take one.
    assert.match(source, /result\?\.reason === 'read-only'/);
});
