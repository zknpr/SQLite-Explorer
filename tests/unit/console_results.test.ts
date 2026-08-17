import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStatus, renderConsoleResults } from '../../core/ui/modules/console-results.js';

// ---- fake DOM -------------------------------------------------------------

/**
 * Minimal element stand-in following the repo's existing FakeNode pattern
 * (tests/unit/grid_render.test.ts). innerHTML throws on BOTH read and write:
 * console output is untrusted database content, so the renderer touching
 * innerHTML at all is a security regression the suite must fail on.
 */
class FakeNode {
    readonly tagName: string;
    children: FakeNode[] = [];
    className = '';
    textContent = '';
    hidden = false;
    type = '';
    private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

    constructor(tagName: string) {
        this.tagName = tagName.toUpperCase();
    }

    append(...nodes: FakeNode[]) {
        this.children.push(...nodes);
    }

    appendChild(node: FakeNode) {
        this.children.push(node);
        return node;
    }

    replaceChildren(...nodes: FakeNode[]) {
        this.children = [...nodes];
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
        throw new Error(`console results must not use innerHTML (write on <${this.tagName}>)`);
    }

    get innerHTML(): string {
        throw new Error(`console results must not use innerHTML (read on <${this.tagName}>)`);
    }
}

function installDocument() {
    (globalThis as any).document = {
        createElement: (tagName: string) => new FakeNode(tagName),
        createTextNode: (text: string) => {
            const node = new FakeNode('#text');
            node.textContent = text;
            return node;
        }
    };
}

function hasClass(node: FakeNode, className: string): boolean {
    return node.className.split(/\s+/).includes(className);
}

function findAllByClass(root: FakeNode, className: string): FakeNode[] {
    const matches = hasClass(root, className) ? [root] : [];
    for (const child of root.children) matches.push(...findAllByClass(child, className));
    return matches;
}

function findAllByTag(root: FakeNode, tagName: string): FakeNode[] {
    const upper = tagName.toUpperCase();
    const matches = root.tagName === upper ? [root] : [];
    for (const child of root.children) matches.push(...findAllByTag(child, tagName));
    return matches;
}

function textOf(node: FakeNode): string {
    return node.textContent + node.children.map(textOf).join('');
}

/** Rows of a result table as plain text, header row first. */
function tableText(table: FakeNode): string[][] {
    return findAllByTag(table, 'tr').map(tr =>
        [...findAllByTag(tr, 'th'), ...findAllByTag(tr, 'td')].map(textOf)
    );
}

function rowSet(rowCount: number, truncated = false) {
    return {
        headers: ['n'],
        rows: Array.from({ length: rowCount }, (_, i) => [i]),
        truncated
    };
}

afterEach(() => {
    delete (globalThis as any).document;
});

// ---- formatStatus (pure) --------------------------------------------------

test('formatStatus reports row counts, truncation, and whole milliseconds', () => {
    assert.equal(
        formatStatus({ results: [rowSet(3)], mutated: false, changes: 0, durationMs: 12.4 }),
        '3 rows · 12 ms'
    );
    assert.equal(
        formatStatus({ results: [rowSet(1)], mutated: false, changes: 0, durationMs: 0.6 }),
        '1 row · 1 ms'
    );
    assert.equal(
        formatStatus({ results: [rowSet(0)], mutated: false, changes: 0, durationMs: 4 }),
        '0 rows · 4 ms'
    );
    assert.equal(
        formatStatus({ results: [rowSet(5000, true)], mutated: false, changes: 0, durationMs: 1234.6 }),
        '5000 rows (truncated) · 1235 ms'
    );
});

test('formatStatus sums multiple result sets and names the set count', () => {
    assert.equal(
        formatStatus({ results: [rowSet(3), rowSet(5)], mutated: false, changes: 0, durationMs: 7 }),
        '8 rows in 2 sets · 7 ms'
    );
    assert.equal(
        formatStatus({ results: [rowSet(4), rowSet(5, true)], mutated: false, changes: 0, durationMs: 7 }),
        '9 rows in 2 sets (truncated) · 7 ms'
    );
});

test('formatStatus reports mutations, with the schema-only case named', () => {
    assert.equal(
        formatStatus({ results: [], mutated: true, changes: 2, durationMs: 45 }),
        '2 changed · 45 ms'
    );
    assert.equal(
        formatStatus({ results: [rowSet(123, true)], mutated: true, changes: 2, durationMs: 45 }),
        '123 rows (truncated) · 2 changed · 45 ms'
    );
    // mutated with zero row changes can only be a schema_version bump (DDL);
    // "0 changed" would read as "nothing happened".
    assert.equal(
        formatStatus({ results: [], mutated: true, changes: 0, durationMs: 3 }),
        'schema changed · 3 ms'
    );
});

test('formatStatus never degenerates to a bare duration', () => {
    assert.equal(
        formatStatus({ results: [], mutated: false, changes: 0, durationMs: 0 }),
        'no results · 0 ms'
    );
    // A non-finite duration must not surface as "NaN ms".
    assert.equal(
        formatStatus({ results: [], mutated: false, changes: 0, durationMs: Number.NaN }),
        'no results · 0 ms'
    );
});

// ---- renderConsoleResults (DOM) -------------------------------------------

test('renders a single result set as a table with no tab strip', () => {
    installDocument();
    const container = new FakeNode('div');

    renderConsoleResults(container as unknown as HTMLElement, {
        results: [{ headers: ['id', 'name'], rows: [[1, 'a'], [2, 'b']], truncated: false }],
        mutated: false,
        changes: 0,
        durationMs: 5
    });

    const status = findAllByClass(container, 'sql-console-results-status');
    assert.equal(status.length, 1);
    assert.equal(textOf(status[0]), '2 rows · 5 ms');
    assert.equal(findAllByClass(container, 'sql-console-results-tabs').length, 0);

    const tables = findAllByClass(container, 'sql-console-results-table');
    assert.equal(tables.length, 1);
    assert.deepEqual(tableText(tables[0]), [['id', 'name'], ['1', 'a'], ['2', 'b']]);
    assert.equal(findAllByTag(tables[0], 'thead').length, 1);
});

test('NULL cells reuse the grid null-value class and render the NULL literal', () => {
    installDocument();
    const container = new FakeNode('div');

    renderConsoleResults(container as unknown as HTMLElement, {
        results: [{ headers: ['v'], rows: [[null], ['x'], [undefined]], truncated: false }],
        mutated: false,
        changes: 0,
        durationMs: 1
    });

    const cells = findAllByTag(container, 'td');
    assert.equal(cells.length, 3);
    assert.deepEqual(cells.map(cell => hasClass(cell, 'null-value')), [true, false, true]);
    assert.deepEqual(cells.map(textOf), ['NULL', 'x', 'NULL']);
});

test('multiple result sets get a tab strip that switches the visible table', () => {
    installDocument();
    const container = new FakeNode('div');

    renderConsoleResults(container as unknown as HTMLElement, {
        results: [
            { headers: ['a'], rows: [[1]], truncated: false },
            { headers: ['b'], rows: [[2]], truncated: false }
        ],
        mutated: false,
        changes: 0,
        durationMs: 9
    });

    const tabs = findAllByClass(container, 'sql-console-results-tab');
    const panes = findAllByClass(container, 'sql-console-results-pane');
    assert.equal(tabs.length, 2);
    assert.equal(panes.length, 2);
    assert.deepEqual(panes.map(pane => pane.hidden), [false, true]);
    assert.deepEqual(tabs.map(tab => hasClass(tab, 'active')), [true, false]);
    assert.deepEqual(tabs.map(tab => tab.type), ['button', 'button']);
    assert.deepEqual(tabs.map(textOf), ['Set 1', 'Set 2']);

    tabs[1].click();
    assert.deepEqual(panes.map(pane => pane.hidden), [true, false]);
    assert.deepEqual(tabs.map(tab => hasClass(tab, 'active')), [false, true]);

    tabs[0].click();
    assert.deepEqual(panes.map(pane => pane.hidden), [false, true]);
});

test('error payloads render the message, with the applied-statements note only when multi-statement', () => {
    installDocument();
    const container = new FakeNode('div');

    renderConsoleResults(container as unknown as HTMLElement, {
        error: 'statement 2: no such table: nope',
        multiStatement: true
    });

    const errors = findAllByClass(container, 'sql-console-results-error');
    assert.equal(errors.length, 1);
    assert.equal(textOf(errors[0]), 'statement 2: no such table: nope');
    const notes = findAllByClass(container, 'sql-console-results-note');
    assert.equal(notes.length, 1);
    assert.equal(textOf(notes[0]), 'Statements before the error were applied.');
    // No status line and no table for an error payload.
    assert.equal(findAllByClass(container, 'sql-console-results-status').length, 0);
    assert.equal(findAllByTag(container, 'table').length, 0);

    renderConsoleResults(container as unknown as HTMLElement, {
        error: 'no such column: nope',
        multiStatement: false
    });
    assert.equal(findAllByClass(container, 'sql-console-results-note').length, 0);
    assert.equal(textOf(findAllByClass(container, 'sql-console-results-error')[0]), 'no such column: nope');
});

test('an error payload carrying a non-string still renders as an error, not a crash', () => {
    installDocument();
    const container = new FakeNode('div');

    // A caller that forgets `.message` must still get its failure on screen —
    // the error branch is exactly where throwing a second time is worst.
    renderConsoleResults(container as unknown as HTMLElement, {
        error: new Error('statement 1: no such table: nope')
    } as unknown as { error: string; multiStatement: boolean });

    const errors = findAllByClass(container, 'sql-console-results-error');
    assert.equal(errors.length, 1);
    assert.equal(textOf(errors[0]), 'Error: statement 1: no such table: nope');
    assert.equal(findAllByClass(container, 'sql-console-results-status').length, 0);
});

test('each render replaces the previous one entirely', () => {
    installDocument();
    const container = new FakeNode('div');
    const payload = {
        results: [{ headers: ['a'], rows: [[1]], truncated: false }, { headers: ['b'], rows: [[2]], truncated: false }],
        mutated: false,
        changes: 0,
        durationMs: 1
    };

    renderConsoleResults(container as unknown as HTMLElement, payload);
    renderConsoleResults(container as unknown as HTMLElement, { error: 'boom', multiStatement: false });

    assert.equal(findAllByClass(container, 'sql-console-results-status').length, 0);
    assert.equal(findAllByClass(container, 'sql-console-results-tabs').length, 0);
    assert.equal(findAllByTag(container, 'table').length, 0);
    assert.equal(findAllByClass(container, 'sql-console-results-error').length, 1);

    renderConsoleResults(container as unknown as HTMLElement, payload);
    assert.equal(findAllByClass(container, 'sql-console-results-error').length, 0);
    assert.equal(findAllByClass(container, 'sql-console-results-tab').length, 2);
});

test('hostile headers, values, and error text land as text only', () => {
    installDocument();
    const container = new FakeNode('div');
    const hostileHeader = '<img src=x onerror=alert(1)>';
    const hostileValue = '"><script>alert(2)</script>';

    // The fake node throws on any innerHTML access, so reaching this line at
    // all proves the renderer built everything with textContent/text nodes.
    renderConsoleResults(container as unknown as HTMLElement, {
        results: [{ headers: [hostileHeader], rows: [[hostileValue]], truncated: false }],
        mutated: false,
        changes: 0,
        durationMs: 1
    });
    assert.equal(textOf(findAllByTag(container, 'th')[0]), hostileHeader);
    assert.equal(textOf(findAllByTag(container, 'td')[0]), hostileValue);

    renderConsoleResults(container as unknown as HTMLElement, {
        error: hostileValue,
        multiStatement: false
    });
    assert.equal(textOf(findAllByClass(container, 'sql-console-results-error')[0]), hostileValue);
});
