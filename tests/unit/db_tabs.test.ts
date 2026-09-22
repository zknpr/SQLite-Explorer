/**
 * Database tabs + the sidebar's "Open Databases" overview.
 *
 * Both presentations render from ONE registry snapshot (`host.listDatabases()`)
 * and both are DESKTOP-ONLY: the markup ships hidden in the shared template
 * (like #btnSqlConsole and #engineBadge) and only desktop-viewer.js runs the
 * module that fills it in. Three classes of invariant are pinned here:
 *
 * 1. Rendering + wiring, against a fake DOM (the FakeNode pattern from
 *    console_results.test.ts / grid_render.test.ts — there is no jsdom in this
 *    runner).
 * 2. The close path, which is the one place the UI is load-bearing for data
 *    safety: `closeDatabase` DISCARDS unsaved changes, so a dirty database must
 *    not close without an explicit confirmation.
 * 3. Static gates: bundle isolation (the module must not leak into the VS Code
 *    or web bundles), the `[hidden]` CSS companions, and the desktop entry's
 *    wiring — the same approach console_desktop_wiring.test.ts takes.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const dbTabsModulePath = '../../core/ui/modules/db-tabs.js';

// ---- fake DOM -------------------------------------------------------------

/** Every node scrollIntoView() was called on, in order. */
let scrolledInto: FakeNode[] = [];

class FakeNode {
    readonly tagName: string;
    children: FakeNode[] = [];
    className = '';
    textContent = '';
    title = '';
    type = '';
    hidden = false;
    disabled = false;
    dataset: Record<string, string> = {};
    attributes: Record<string, string> = {};
    private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

    constructor(tagName: string) {
        this.tagName = tagName.toUpperCase();
    }

    scrollIntoView() {
        scrolledInto.push(this);
    }

    focus() {
        (globalThis as any).document.activeElement = this;
    }

    appendChild(node: FakeNode) {
        if (!(node instanceof FakeNode)) {
            throw new TypeError(`appendChild requires a node, got ${String(node)}`);
        }
        this.children.push(node);
        return node;
    }

    replaceChildren(...nodes: FakeNode[]) {
        this.children = [...nodes];
    }

    setAttribute(name: string, value: string) {
        this.attributes[name] = value;
    }

    getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
    }

    addEventListener(type: string, listener: (event: unknown) => void) {
        const registered = this.listeners.get(type) ?? [];
        registered.push(listener);
        this.listeners.set(type, registered);
    }

    click() {
        for (const listener of this.listeners.get('click') ?? []) listener({});
    }

    set innerHTML(_value: string) {
        // Database names and paths are untrusted content (a file can be named
        // anything); the renderer must never build markup from them.
        throw new Error(`db-tabs must not use innerHTML (write on <${this.tagName}>)`);
    }

    get innerHTML(): string {
        throw new Error(`db-tabs must not use innerHTML (read on <${this.tagName}>)`);
    }
}

/** The four template elements the two presentations own. */
function installDocument() {
    const elements: Record<string, FakeNode> = {
        dbTabStrip: new FakeNode('div'),
        sectionOpenDatabases: new FakeNode('div'),
        openDatabasesList: new FakeNode('ul'),
        openDatabasesBadge: new FakeNode('span')
    };
    for (const node of Object.values(elements)) node.hidden = true;   // ships hidden
    scrolledInto = [];
    (globalThis as any).document = {
        // Written by FakeNode.focus(), read by the renderer's focus-restore.
        activeElement: null as FakeNode | null,
        getElementById: (id: string) => elements[id] ?? null,
        createElement: (tagName: string) => new FakeNode(tagName)
    };
    return elements;
}

const activeElement = (): FakeNode | null => (globalThis as any).document.activeElement;

function hasClass(node: FakeNode, className: string): boolean {
    return node.className.split(/\s+/).includes(className);
}

function findAllByClass(root: FakeNode, className: string): FakeNode[] {
    const matches = hasClass(root, className) ? [root] : [];
    for (const child of root.children) matches.push(...findAllByClass(child, className));
    return matches;
}

function textOf(node: FakeNode): string {
    return node.textContent + node.children.map(textOf).join('');
}

// ---- fake host ------------------------------------------------------------

type DbRow = {
    dbId: string;
    name: string;
    path: string | null;
    engine: 'native' | 'wasm';
    isDirty: boolean;
    isActive: boolean;
};

function db(dbId: string, overrides: Partial<DbRow> = {}): DbRow {
    return {
        dbId,
        name: `${dbId}.db`,
        path: `/tmp/${dbId}.db`,
        engine: 'wasm',
        isDirty: false,
        isActive: false,
        ...overrides
    };
}

function makeHost(rows: DbRow[]) {
    const calls: Array<[string, string]> = [];
    return {
        calls,
        rows,
        listDatabases: () => rows.map(row => ({ ...row })),
        activeDatabaseId: () => rows.find(row => row.isActive)?.dbId ?? null,
        async setActiveDb(dbId: string) {
            calls.push(['setActiveDb', dbId]);
            return true;
        },
        async closeDatabase(dbId: string) {
            calls.push(['closeDatabase', dbId]);
            return true;
        }
    };
}

/** Lets the click handlers' promises settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).confirm;
});

// ---- rendering ------------------------------------------------------------

test('the tab strip renders one tab per open database with name, engine and dirty marker', async () => {
    const elements = installDocument();
    const host = makeHost([
        db('a', { isActive: true, engine: 'native' }),
        db('b', { isDirty: true })
    ]);
    const { initDatabaseTabs, renderDatabaseTabs } = await import(dbTabsModulePath);
    initDatabaseTabs({ host });
    renderDatabaseTabs(host.listDatabases());

    const tabs = findAllByClass(elements.dbTabStrip, 'db-tab');
    assert.equal(tabs.length, 2);
    assert.deepEqual(
        tabs.map(tab => findAllByClass(tab, 'db-tab-name').map(textOf)[0]),
        ['a.db', 'b.db']
    );
    assert.deepEqual(
        tabs.map(tab => findAllByClass(tab, 'db-tab-engine')[0].dataset.engine),
        ['native', 'wasm']
    );
    // The active tab is visually distinct, and exactly one is.
    assert.deepEqual(tabs.map(tab => hasClass(tab, 'active')), [true, false]);
    assert.deepEqual(
        tabs.map(tab => findAllByClass(tab, 'db-tab-select')[0].getAttribute('aria-pressed')),
        ['true', 'false']
    );
    // The dirty marker is present only on the dirty database.
    assert.deepEqual(tabs.map(tab => findAllByClass(tab, 'db-tab-dirty').length), [0, 1]);
    // Every tab can be closed.
    assert.deepEqual(tabs.map(tab => findAllByClass(tab, 'db-tab-close').length), [1, 1]);
    // The full path is the hover hint: two files can share a basename.
    assert.equal(findAllByClass(tabs[0], 'db-tab-select')[0].title, '/tmp/a.db');
});

test('the tab strip and the sidebar section appear together, and only from two databases on', async () => {
    const elements = installDocument();
    const host = makeHost([db('a', { isActive: true })]);
    const { initDatabaseTabs, renderDatabaseTabs } = await import(dbTabsModulePath);
    initDatabaseTabs({ host });

    renderDatabaseTabs(host.listDatabases());
    assert.equal(elements.dbTabStrip.hidden, true, 'one database must keep the single-database look');
    assert.equal(elements.sectionOpenDatabases.hidden, true);
    assert.equal(elements.openDatabasesList.hidden, true);

    host.rows.push(db('b'));
    renderDatabaseTabs(host.listDatabases());
    assert.equal(elements.dbTabStrip.hidden, false);
    assert.equal(elements.sectionOpenDatabases.hidden, false);
    assert.equal(elements.openDatabasesList.hidden, false);
    assert.equal(elements.openDatabasesBadge.textContent, '2');

    // …and back again when one is closed.
    host.rows.pop();
    renderDatabaseTabs(host.listDatabases());
    assert.equal(elements.dbTabStrip.hidden, true);
    assert.equal(elements.sectionOpenDatabases.hidden, true);
    assert.equal(elements.openDatabasesList.hidden, true);
});

test('the sidebar overview lists the same registry and marks the active database', async () => {
    const elements = installDocument();
    const host = makeHost([db('a'), db('b', { isActive: true, isDirty: true, engine: 'native' })]);
    const { initDatabaseTabs, renderDatabaseTabs } = await import(dbTabsModulePath);
    initDatabaseTabs({ host });
    renderDatabaseTabs(host.listDatabases());

    const items = findAllByClass(elements.openDatabasesList, 'db-list-item');
    assert.equal(items.length, 2);
    assert.deepEqual(items.map(item => findAllByClass(item, 'item-name').map(textOf)[0]), ['a.db', 'b.db']);
    assert.deepEqual(items.map(item => hasClass(item, 'selected')), [false, true]);
    assert.deepEqual(items.map(item => findAllByClass(item, 'db-item-engine')[0].dataset.engine), ['wasm', 'native']);
    assert.deepEqual(items.map(item => findAllByClass(item, 'db-item-dirty').length), [0, 1]);
});

test('sidebar entries carry no data-name/data-type, so the schema-tree delegation cannot fire on them', async () => {
    const elements = installDocument();
    const host = makeHost([db('a', { isActive: true }), db('b')]);
    const { initDatabaseTabs, renderDatabaseTabs } = await import(dbTabsModulePath);
    initDatabaseTabs({ host });
    renderDatabaseTabs(host.listDatabases());

    // sidebar.js's delegated handler selects a table when a `.list-item` has
    // BOTH data-name and data-type; desktop-viewer.js's console wiring closes
    // the console on the same pair. An open-database entry that carried them
    // would be read as a table click on a table that does not exist.
    for (const item of findAllByClass(elements.openDatabasesList, 'db-list-item')) {
        assert.equal(item.dataset.name, undefined);
        assert.equal(item.dataset.type, undefined);
        assert.equal(item.dataset.dbId, item === elements.openDatabasesList.children[0] ? 'a' : 'b');
    }
});

test('a switch scrolls the newly active tab into view; an ordinary re-render does not', async () => {
    const elements = installDocument();
    const host = makeHost([db('a', { isActive: true }), db('b'), db('c')]);
    const { initDatabaseTabs, renderDatabaseTabs } = await import(dbTabsModulePath);
    initDatabaseTabs({ host });
    renderDatabaseTabs(host.listDatabases());

    // At the open cap the strip is wider than any window, so the tab ⌘7 just
    // selected has to be brought into view…
    scrolledInto = [];
    host.rows[0].isActive = false;
    host.rows[2].isActive = true;
    renderDatabaseTabs(host.listDatabases());
    assert.equal(scrolledInto.length, 1);
    assert.equal(findAllByClass(scrolledInto[0], 'db-tab-name').map(textOf)[0], 'c.db');

    // …but the strip re-renders on every dirty-flag change too (each edit
    // reaches it), and scrolling then would fight a user who has scrolled it.
    scrolledInto = [];
    host.rows[1].isDirty = true;
    renderDatabaseTabs(host.listDatabases());
    assert.deepEqual(scrolledInto, []);
    void elements;
});

test('keyboard focus in the strip survives a re-render, and falls back when its tab is gone', async () => {
    const elements = installDocument();
    const host = makeHost([db('a', { isActive: true }), db('b'), db('c')]);
    const { initDatabaseTabs, renderDatabaseTabs } = await import(dbTabsModulePath);
    initDatabaseTabs({ host });
    renderDatabaseTabs(host.listDatabases());

    // The user has tabbed to c.db's close button.
    findAllByClass(elements.dbTabStrip, 'db-tab-close')[2].focus();
    assert.equal(activeElement()?.dataset.dbId, 'c');

    // A re-render replaces the whole subtree, and they are FREQUENT — the host
    // notifies on every dirty-flag flip, i.e. on every edit. Focus must not be
    // silently dropped on the body by an edit somewhere else.
    host.rows[1].isDirty = true;
    renderDatabaseTabs(host.listDatabases());
    const refocused = activeElement();
    assert.equal(refocused?.dataset.dbId, 'c');
    assert.equal(refocused?.className, 'db-tab-close');
    // Restored onto the NEW node, not a detached one.
    assert.equal(findAllByClass(elements.dbTabStrip, 'db-tab-close')[2], refocused);

    // Its database is closed (which is what pressing Enter on that button
    // does): focus lands on the now active tab rather than the body, so
    // keyboard navigation survives its own close.
    host.rows.splice(2, 1);
    renderDatabaseTabs(host.listDatabases());
    assert.equal(activeElement()?.dataset.dbId, 'a');
    assert.equal(activeElement()?.className, 'db-tab-select');
});

test('a re-render does not steal focus from outside the strip', async () => {
    const elements = installDocument();
    const host = makeHost([db('a', { isActive: true }), db('b')]);
    const { initDatabaseTabs, renderDatabaseTabs } = await import(dbTabsModulePath);
    initDatabaseTabs({ host });
    renderDatabaseTabs(host.listDatabases());

    // The user is typing in the filter box while an edit lands.
    const elsewhere = new FakeNode('input');
    elsewhere.focus();
    host.rows[1].isDirty = true;
    renderDatabaseTabs(host.listDatabases());
    assert.equal(activeElement(), elsewhere);
    void elements;
});

// ---- switching ------------------------------------------------------------

test('clicking a tab switches to that database', async () => {
    const elements = installDocument();
    const host = makeHost([db('a', { isActive: true }), db('b')]);
    const { initDatabaseTabs, renderDatabaseTabs } = await import(dbTabsModulePath);
    initDatabaseTabs({ host });
    renderDatabaseTabs(host.listDatabases());

    findAllByClass(elements.dbTabStrip, 'db-tab-select')[1].click();
    await flush();
    assert.deepEqual(host.calls, [['setActiveDb', 'b']]);
});

test('clicking a sidebar entry switches to that database', async () => {
    const elements = installDocument();
    const host = makeHost([db('a', { isActive: true }), db('b')]);
    const { initDatabaseTabs, renderDatabaseTabs } = await import(dbTabsModulePath);
    initDatabaseTabs({ host });
    renderDatabaseTabs(host.listDatabases());

    findAllByClass(elements.openDatabasesList, 'db-list-item')[1].click();
    await flush();
    assert.deepEqual(host.calls, [['setActiveDb', 'b']]);
});

// ---- closing --------------------------------------------------------------

test('closing a clean database closes it without prompting', async () => {
    const elements = installDocument();
    let prompts = 0;
    const host = makeHost([db('a', { isActive: true }), db('b')]);
    const { initDatabaseTabs, renderDatabaseTabs } = await import(dbTabsModulePath);
    initDatabaseTabs({ host, confirmClose: async () => { prompts += 1; return true; } });
    renderDatabaseTabs(host.listDatabases());

    findAllByClass(elements.dbTabStrip, 'db-tab-close')[1].click();
    await flush();
    assert.equal(prompts, 0);
    assert.deepEqual(host.calls, [['closeDatabase', 'b']]);
});

test('closing a dirty database prompts first, and a cancelled prompt closes nothing', async () => {
    const elements = installDocument();
    const asked: string[] = [];
    let answer = false;
    const host = makeHost([db('a', { isActive: true }), db('b', { isDirty: true })]);
    const { initDatabaseTabs, renderDatabaseTabs } = await import(dbTabsModulePath);
    initDatabaseTabs({ host, confirmClose: async ({ message }: { message: string }) => {
        asked.push(message);
        return answer;
    } });
    renderDatabaseTabs(host.listDatabases());

    findAllByClass(elements.dbTabStrip, 'db-tab-close')[1].click();
    await flush();
    assert.equal(asked.length, 1);
    assert.match(asked[0], /b\.db/);
    assert.match(asked[0], /unsaved/i);
    // closeDatabase DISCARDS: a cancelled prompt must not reach it at all.
    assert.deepEqual(host.calls, []);

    answer = true;
    findAllByClass(elements.dbTabStrip, 'db-tab-close')[1].click();
    await flush();
    assert.deepEqual(host.calls, [['closeDatabase', 'b']]);
});

test('an unavailable in-page confirmation reports an error without closing the dirty database', async () => {
    const elements = installDocument();
    const host = makeHost([db('a', { isActive: true }), db('b', { isDirty: true })]);
    const { initDatabaseTabs, renderDatabaseTabs } = await import(dbTabsModulePath);
    const errors: Error[] = [];
    initDatabaseTabs({ host, surface: () => (error: Error) => errors.push(error) });
    renderDatabaseTabs(host.listDatabases());

    // The fake document has no body for the real dialog. Do not substitute
    // window.confirm or silently treat that rendering failure as approval.
    findAllByClass(elements.dbTabStrip, 'db-tab-close')[1].click();
    await flush();
    assert.deepEqual(host.calls, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /document to render/);
});

test('dirty close awaits an explicit answer and rejects a stale answer after a database switch', async () => {
    const elements = installDocument();
    const host = makeHost([db('a'), db('b', { isActive: true, isDirty: true })]);
    let answer!: (approved: boolean) => void;
    const { initDatabaseTabs } = await import(dbTabsModulePath);
    initDatabaseTabs({ host, confirmClose: () => new Promise<boolean>(resolve => { answer = resolve; }) });
    findAllByClass(elements.dbTabStrip, 'db-tab-close')[1].click();
    await flush();
    assert.deepEqual(host.calls, [], 'must await the prompt instead of treating a Promise as approval');
    host.rows[0].isActive = true;
    host.rows[1].isActive = false;
    answer(true);
    await flush();
    assert.deepEqual(host.calls, [], 'switching databases invalidates the pending close');
});

test('a rejected close confirmation is surfaced and preserves all databases', async () => {
    const elements = installDocument();
    const host = makeHost([db('a'), db('b', { isActive: true, isDirty: true })]);
    const errors: Error[] = [];
    const { initDatabaseTabs } = await import(dbTabsModulePath);
    initDatabaseTabs({ host,
        confirmClose: async () => { throw new Error('dialog failed'); },
        surface: () => (error: Error) => errors.push(error)
    });
    findAllByClass(elements.dbTabStrip, 'db-tab-close')[1].click();
    await flush();
    assert.deepEqual(host.calls, []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'dialog failed');
});

// ---- keyboard -------------------------------------------------------------

function keyEvent(overrides: Record<string, unknown> = {}) {
    let prevented = false;
    return {
        key: '',
        code: '',
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault() { prevented = true; },
        get defaultPrevented() { return prevented; },
        ...overrides
    } as any;
}

test('Cmd+W closes the active database while more than one is open', async () => {
    installDocument();
    const host = makeHost([db('a'), db('b', { isActive: true })]);
    const { initDatabaseTabs, handleDatabaseShortcut } = await import(dbTabsModulePath);
    initDatabaseTabs({ host });

    const event = keyEvent({ key: 'w', code: 'KeyW' });
    const handled = handleDatabaseShortcut(event);
    assert.notEqual(handled, null, 'Cmd+W must be handled while a second database is open');
    await handled;
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(host.calls, [['closeDatabase', 'b']]);
});

test('Cmd+W is left to the shell at one open database', async () => {
    installDocument();
    const host = makeHost([db('a', { isActive: true })]);
    const { initDatabaseTabs, handleDatabaseShortcut } = await import(dbTabsModulePath);
    initDatabaseTabs({ host });

    const event = keyEvent({ key: 'w', code: 'KeyW' });
    // Unhandled AND un-prevented: WKWebView hands the key to the page first, so
    // preventing it here would swallow the window's own Close accelerator.
    assert.equal(handleDatabaseShortcut(event), null);
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(host.calls, []);
});

test('Cmd+W on a dirty active database prompts before closing', async () => {
    installDocument();
    let asked = 0;
    const host = makeHost([db('a'), db('b', { isActive: true, isDirty: true })]);
    const { initDatabaseTabs, handleDatabaseShortcut } = await import(dbTabsModulePath);
    initDatabaseTabs({ host, confirmClose: async () => { asked += 1; return false; } });

    await handleDatabaseShortcut(keyEvent({ key: 'w', code: 'KeyW' }));
    assert.equal(asked, 1);
    assert.deepEqual(host.calls, []);
});

test('Cmd+1..9 select by position, and a digit past the end is an unhandled no-op', async () => {
    installDocument();
    const host = makeHost([db('a', { isActive: true }), db('b'), db('c')]);
    const { initDatabaseTabs, handleDatabaseShortcut } = await import(dbTabsModulePath);
    initDatabaseTabs({ host });

    const third = keyEvent({ key: '3', code: 'Digit3' });
    await handleDatabaseShortcut(third);
    assert.equal(third.defaultPrevented, true);
    assert.deepEqual(host.calls, [['setActiveDb', 'c']]);

    // Past the end: nothing happens, and the event is left alone.
    host.calls.length = 0;
    const ninth = keyEvent({ key: '9', code: 'Digit9' });
    assert.equal(handleDatabaseShortcut(ninth), null);
    assert.equal(ninth.defaultPrevented, false);
    assert.deepEqual(host.calls, []);
});

test('Cmd+digit selects by PHYSICAL key, so it works on a layout whose digits need Shift', async () => {
    installDocument();
    const host = makeHost([db('a', { isActive: true }), db('b'), db('c')]);
    const { initDatabaseTabs, handleDatabaseShortcut } = await import(dbTabsModulePath);
    initDatabaseTabs({ host });

    // AZERTY-shaped: the digit row types &é"… unshifted, so the ONLY stable
    // identity of "the 1 key" is event.code. This project has already shipped a
    // dead accelerator by binding a layout-dependent spelling (CmdOrCtrl+= was
    // unreachable on this machine's Italian-Pro layout); event.key here would
    // be the same mistake in the page handler.
    for (const overrides of [
        { key: '&', code: 'Digit1', shiftKey: false },   // Cmd + the 1 key, unshifted
        { key: '1', code: 'Digit1', shiftKey: true },    // Cmd+Shift produces the digit
        { key: '&', code: 'Digit1', shiftKey: true }     // …reported either way
    ]) {
        host.calls.length = 0;
        const event = keyEvent(overrides);
        await handleDatabaseShortcut(event);
        assert.deepEqual(host.calls, [['setActiveDb', 'a']], JSON.stringify(overrides));
        assert.equal(event.defaultPrevented, true);
    }

    // The key fallback still covers events that carry no code at all.
    host.calls.length = 0;
    await handleDatabaseShortcut(keyEvent({ key: '2', code: undefined }));
    assert.deepEqual(host.calls, [['setActiveDb', 'b']]);
});

test('the database shortcuts ignore events that are not theirs', async () => {
    installDocument();
    const host = makeHost([db('a', { isActive: true }), db('b')]);
    const { initDatabaseTabs, handleDatabaseShortcut } = await import(dbTabsModulePath);
    initDatabaseTabs({ host });

    for (const overrides of [
        { key: '2', code: 'Digit2', metaKey: false, ctrlKey: false },   // no modifier
        { key: '2', code: 'Digit2', altKey: true },                     // Cmd+Alt+2
        // Shift is ignored for DIGITS (a layout may need it) but not for W:
        // Cmd+Shift+W is Close All Windows and stays the shell's.
        { key: 'w', code: 'KeyW', shiftKey: true }
    ]) {
        const event = keyEvent(overrides);
        assert.equal(handleDatabaseShortcut(event), null, JSON.stringify(overrides));
        assert.equal(event.defaultPrevented, false);
    }
    assert.deepEqual(host.calls, []);
});

// ---- static gates ---------------------------------------------------------

const uiDir = path.resolve(process.cwd(), 'core/ui');

test('only desktop-viewer.js imports db-tabs.js (it is desktop-only chrome)', () => {
    const IMPORT = /(?:from|import)\s*\(?\s*['"][^'"]*db-tabs\.js['"]/;
    const sources = [
        ...readdirSync(uiDir)
            .filter(name => name.endsWith('.js') && name !== 'desktop-viewer.js')
            .map(name => path.join(uiDir, name)),
        ...readdirSync(path.join(uiDir, 'modules'))
            .filter(name => name.endsWith('.js') && name !== 'db-tabs.js')
            .map(name => path.join(uiDir, 'modules', name))
    ];
    assert.deepEqual(
        sources.filter(file => IMPORT.test(readFileSync(file, 'utf8')))
            .map(file => path.relative(process.cwd(), file)),
        [],
        'a shared module imports db-tabs.js; the tab chrome would run in VS Code and the web demo'
    );
    // Positive control.
    assert.match(readFileSync(path.join(uiDir, 'desktop-viewer.js'), 'utf8'), /from\s+'\.\/modules\/db-tabs\.js'/);
});

test('the built VS Code and web bundles ship the markup inert and none of the runtime', () => {
    const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8');
    // A string literal that only db-tabs.js contains, so it survives minification
    // and identifies the RUNTIME (the template markup below is shared).
    const RUNTIME_SENTINEL = 'Closing it discards them';
    for (const bundle of ['core/ui/viewer.html', 'website/public/sqlite-viewer/viewer.html']) {
        const html = read(bundle);
        assert.equal(html.includes(RUNTIME_SENTINEL), false, `db-tabs runtime leaked into ${bundle}`);
        // The markup does ship — hidden and unreferenced — exactly like the
        // engine badge and the SQL console container already do.
        assert.match(html, /id="dbTabStrip"[^>]*\shidden/);
        assert.match(html, /id="openDatabasesList"[^>]*\shidden/);
    }
    assert.equal(read('desktop/viewer.html').includes(RUNTIME_SENTINEL), true,
        'the desktop bundle lost the database-tab runtime');
});

test('viewer.css hides the tab strip and the Open Databases section when the hidden attribute is set', () => {
    const css = readFileSync(path.join(uiDir, 'viewer.css'), 'utf8');
    // An author rule that sets `display` outranks the UA `[hidden]` rule, so
    // every element gated by the attribute needs an explicit companion — the
    // same load-bearing pairing the SQL console documents.
    for (const selector of ['.db-tab-strip[hidden]', '.section-title[hidden]', '.item-list[hidden]']) {
        const rule = new RegExp(`${selector.replace(/[.[\]]/g, '\\$&')}\\s*\\{[^}]*display\\s*:\\s*none`);
        assert.match(css, rule, `${selector} needs a display:none companion or the "hidden" element stays on screen`);
    }
    assert.match(css, /\.db-tab-strip\s*\{[^}]*display\s*:\s*flex/);
});

test('the desktop entry re-renders the chrome from both host hooks and wires the shortcuts', () => {
    const source = readFileSync(path.join(uiDir, 'desktop-viewer.js'), 'utf8');
    // databasesChanged is the registry feed (open/close/save/switch all reach
    // it); databaseSwitched re-renders too so the chrome cannot depend on the
    // host's notification ORDER.
    assert.match(source, /async databasesChanged\(/);
    const switched = source.slice(source.indexOf('async databaseSwitched('), source.indexOf('async updateColorScheme('));
    assert.match(switched, /renderDatabaseTabs\(/, 'databaseSwitched must re-render the tab strip');
    // The shortcuts ride the existing desktop keydown handler, next to Cmd+S
    // and Cmd+O — menu accelerators are resolved by AppKit against the active
    // keyboard layout and silently dropped when unreachable.
    assert.match(source, /handleDatabaseShortcut\(event\)/);
    assert.match(source, /initDatabaseTabs\(/);

    // …and BEFORE the handler's "user is typing" guard, unlike every other
    // shortcut in it. ⌘W must mean the same thing wherever focus is: gating it
    // on `inEditor` would close the WINDOW (with every open database in it)
    // whenever the filter box happened to have focus.
    const shortcutAt = source.indexOf('handleDatabaseShortcut(event)');
    const editorGuardAt = source.indexOf('if (inEditor) return;');
    assert.notEqual(editorGuardAt, -1, 'the desktop keydown handler no longer has a standalone inEditor guard');
    assert.equal(shortcutAt < editorGuardAt, true,
        'the database shortcuts must be consulted before the "user is typing" guard');
});
