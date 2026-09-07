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
        // The real DOM throws on a non-node (which is how an array hole
        // reaches this method); a lenient fake would hide that crash.
        if (!(node instanceof FakeNode)) {
            throw new TypeError(`appendChild requires a node, got ${String(node)}`);
        }
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

test('formatStatus counts a query plan in plan entries, never rows', () => {
    // `4 rows` under an EXPLAIN reads as data that was returned; the plan is
    // a listing of what WOULD run.
    assert.equal(
        formatStatus({ results: [rowSet(4)], mutated: false, changes: 0, durationMs: 2, explain: true }),
        '4 plan entries · 2 ms'
    );
    assert.equal(
        formatStatus({ results: [rowSet(1)], mutated: false, changes: 0, durationMs: 2, explain: true }),
        '1 plan entry · 2 ms'
    );
    assert.equal(
        formatStatus({ results: [rowSet(1000, true)], mutated: false, changes: 0, durationMs: 9, explain: true }),
        '1000 plan entries (truncated) · 9 ms'
    );
    // Only an explicit true switches the noun: an ordinary run never carries the flag.
    assert.equal(
        formatStatus({ results: [rowSet(4)], mutated: false, changes: 0, durationMs: 2, explain: undefined }),
        '4 rows · 2 ms'
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
        error: new Error('statement 1: no such table: nope') as unknown as string
    });

    const errors = findAllByClass(container, 'sql-console-results-error');
    assert.equal(errors.length, 1);
    assert.equal(textOf(errors[0]), 'Error: statement 1: no such table: nope');
    assert.equal(findAllByClass(container, 'sql-console-results-status').length, 0);
});

test('a run with no result sets renders the status line alone', () => {
    installDocument();
    const container = new FakeNode('div');

    renderConsoleResults(container as unknown as HTMLElement, {
        results: [],
        mutated: true,
        changes: 2,
        durationMs: 45
    });

    assert.equal(textOf(findAllByClass(container, 'sql-console-results-status')[0]), '2 changed · 45 ms');
    assert.equal(findAllByClass(container, 'sql-console-results-pane').length, 0);
    assert.equal(findAllByClass(container, 'sql-console-results-tabs').length, 0);
    assert.equal(container.children.length, 1);
});

test('a single set leaves its pane visible', () => {
    installDocument();
    const container = new FakeNode('div');

    renderConsoleResults(container as unknown as HTMLElement, {
        results: [{ headers: ['a'], rows: [[1]], truncated: false }],
        mutated: false,
        changes: 0,
        durationMs: 1
    });

    const panes = findAllByClass(container, 'sql-console-results-pane');
    assert.equal(panes.length, 1);
    assert.equal(panes[0].hidden, false);
});

// ---- Export CSV control ---------------------------------------------------

test('an export callback adds an Export CSV control that hands over the visible set', () => {
    installDocument();
    const container = new FakeNode('div');
    const exported: unknown[] = [];
    const payload = {
        results: [
            { headers: ['a'], rows: [[1]], truncated: false },
            { headers: ['b'], rows: [[2], [3]], truncated: true }
        ],
        mutated: false,
        changes: 0,
        durationMs: 9
    };

    renderConsoleResults(container as unknown as HTMLElement, payload, {
        onExportCsv: (set, whole) => { exported.push({ set, whole }); }
    });

    // The status text is unchanged by the control beside it.
    const statusText = findAllByClass(container, 'sql-console-results-status-text');
    assert.equal(statusText.length, 1);
    assert.equal(textOf(statusText[0]), '3 rows in 2 sets (truncated) · 9 ms');
    const buttons = findAllByClass(container, 'sql-console-results-export');
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].type, 'button');
    assert.equal(textOf(buttons[0]), 'Export CSV');

    // Follows the tab strip: the set on screen is the one exported.
    buttons[0].click();
    assert.deepEqual(exported, [{ set: payload.results[0], whole: payload }]);
    findAllByClass(container, 'sql-console-results-tab')[1].click();
    buttons[0].click();
    assert.equal(exported.length, 2);
    assert.equal((exported[1] as { set: unknown }).set, payload.results[1]);
});

test('no Export CSV control without a callback, without a result set, or on an error', () => {
    installDocument();
    const container = new FakeNode('div');
    const run = { results: [rowSet(2)], mutated: false, changes: 0, durationMs: 1 };

    renderConsoleResults(container as unknown as HTMLElement, run);
    assert.equal(findAllByClass(container, 'sql-console-results-export').length, 0);
    // Existing callers see the same status text through the same class.
    assert.equal(textOf(findAllByClass(container, 'sql-console-results-status')[0]), '2 rows · 1 ms');

    const onExportCsv = () => { throw new Error('must not be rendered'); };
    renderConsoleResults(
        container as unknown as HTMLElement,
        { results: [], mutated: true, changes: 1, durationMs: 1 },
        { onExportCsv }
    );
    assert.equal(findAllByClass(container, 'sql-console-results-export').length, 0);

    renderConsoleResults(container as unknown as HTMLElement, { error: 'nope' }, { onExportCsv });
    assert.equal(findAllByClass(container, 'sql-console-results-export').length, 0);
});

/** Renders `payload` with console.error captured, asserting the contract-violation output. */
function assertContractViolation(payload: unknown) {
    installDocument();
    const container = new FakeNode('div');
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
        renderConsoleResults(container as unknown as HTMLElement, payload as never);
    } finally {
        console.error = realError;
    }

    const errors = findAllByClass(container, 'sql-console-results-error');
    assert.equal(errors.length, 1, 'contract violation must render through the error path');
    assert.equal(textOf(errors[0]), 'Malformed console result payload');
    assert.equal(findAllByClass(container, 'sql-console-results-status').length, 0);
    assert.equal(findAllByClass(container, 'sql-console-results-note').length, 0);
    assert.equal(findAllByTag(container, 'table').length, 0);
    // Fail loud as well as visible: the raw payload reaches devtools.
    assert.equal(logged.length, 1);
    assert.equal(logged[0][1], payload);
}

test('malformed payloads render a contract violation instead of throwing', () => {
    // Nothing at all.
    assertContractViolation(null);
    assertContractViolation(undefined);
    // Right shape, wrong types.
    assertContractViolation({ results: null, mutated: false, changes: 0, durationMs: 1 });
    assertContractViolation({ results: [{ headers: null, rows: [] }], mutated: false, changes: 0, durationMs: 1 });
    assertContractViolation({ results: [{ headers: ['a'], rows: null }], mutated: false, changes: 0, durationMs: 1 });
    assertContractViolation({ results: [{ headers: ['a'], rows: [null] }], mutated: false, changes: 0, durationMs: 1 });
    // A nulled-out error is not an error message; it must not render "null".
    assertContractViolation({ error: null });
    assertContractViolation('not a payload at all');
});

test('array holes are rejected by the gate rather than crashed on', () => {
    // `.every()` SKIPS holes; the render path (for...of / map + for...of) does
    // not — so a sparse array walks straight past a naive gate into a
    // TypeError. Pinned as genuine holes: if the toolchain ever materializes
    // `[,]` into `[undefined]`, these assertions fail rather than quietly
    // reducing the regression to a weaker one.
    const sparseSets: unknown[] = [, ];
    const sparseRows: unknown[] = [, ];
    assert.equal(sparseSets.length, 1);
    assert.equal(0 in sparseSets, false);
    assert.equal(0 in sparseRows, false);

    assertContractViolation({ results: sparseSets, mutated: false, changes: 0, durationMs: 1 });
    assertContractViolation({
        results: [{ headers: ['a'], rows: sparseRows, truncated: false }],
        mutated: false,
        changes: 0,
        durationMs: 1
    });
});

test('a blank error message is a contract violation, not a blank pane', () => {
    assertContractViolation({ error: '' });
    assertContractViolation({ error: '   ' });
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

test('formatStatus flags a capped run so a one-statement plan is not read as covering the script', () => {
    assert.equal(
        formatStatus({
            results: [rowSet(2)], mutated: false, changes: 0, durationMs: 3, statementsSkipped: true
        }),
        '2 rows · 3 ms · remaining statements not executed'
    );
    // Absent and false both read as "the whole script ran".
    assert.equal(
        formatStatus({
            results: [rowSet(2)], mutated: false, changes: 0, durationMs: 3, statementsSkipped: false
        }),
        '2 rows · 3 ms'
    );
    assert.equal(
        formatStatus({ results: [rowSet(2)], mutated: false, changes: 0, durationMs: 3 }),
        '2 rows · 3 ms'
    );
});

test('renderConsoleResults surfaces the skipped-statements flag in the rendered status line', () => {
    installDocument();
    const container = new FakeNode('div');
    renderConsoleResults(container as unknown as HTMLElement, {
        results: [{ headers: ['id'], rows: [[1]], truncated: false }],
        mutated: false, changes: 0, durationMs: 1, statementsSkipped: true
    });
    const [status] = findAllByClass(container, 'sql-console-results-status');
    assert.ok(status);
    assert.match(textOf(status), /remaining statements not executed$/);
});
