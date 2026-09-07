/**
 * Guards against a whole class of desktop-bundle breakage that every headless
 * unit test and `tsc` miss because none of them PARSE the built bundle in a
 * browser. Three real regressions shipped past 2769 green tests on 2026-09-07
 * and were caught only by driving the bundle in a browser:
 *
 *  1. A single missing `}` on `.section-title[hidden]` in `viewer.css` made a
 *     browser's CSS parser drop EVERY rule after it (298 rules → 21), so
 *     `.list-item { display: flex }` never applied and the sidebar rows were
 *     unstyled and mostly unclickable.
 *  2. `desktop-viewer.js` called `updateToolbarButtons()` without importing it —
 *     a ReferenceError thrown on every database open (the grid never rendered).
 *  3. A dropped empty-state fallback left a fresh open stuck on "Loading…".
 *
 * (1) and (2) are mechanically detectable from the built artifacts; this file
 * does exactly that, so the class cannot silently return.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** Braces outside comments and quoted strings must balance. */
function braceBalance(css: string): number {
    const stripped = css
        .replace(/\/\*[\s\S]*?\*\//g, '')      // comments
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')     // double-quoted strings
        .replace(/'(?:[^'\\]|\\.)*'/g, "''");    // single-quoted strings
    let depth = 0;
    for (const ch of stripped) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
    }
    return depth;
}

test('source CSS files have balanced braces (a missing } breaks the whole stylesheet)', () => {
    for (const rel of ['core/ui/viewer.css', 'core/ui/desktop-themes.css']) {
        const css = fs.readFileSync(path.resolve(rel), 'utf-8');
        assert.equal(braceBalance(css), 0, `${rel} has unbalanced braces (a missing } drops every later rule at parse time)`);
    }
});

test('built desktop bundle CSS is well-formed and critical layout rules survive', () => {
    const html = fs.readFileSync(path.resolve('desktop', 'viewer.html'), 'utf-8');
    const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
    assert.ok(styles.length > 1000, 'no inline <style> found in the built bundle');
    assert.equal(braceBalance(styles), 0, 'built bundle CSS has unbalanced braces');

    // Each rule is a complete `selector{...}` unit — a missing brace before it
    // swallows it into the previous rule, so a match for the CLOSED form proves
    // the parser reaches it. `[^{}]*` forbids a nested `{`, i.e. a leaked selector.
    const mustSurvive: Array<[string, RegExp]> = [
        ['.list-item is a flex row', /\.list-item\{[^{}]*display:\s*flex[^{}]*\}/],
        ['.list-item-select fills the row', /\.list-item-select\{[^{}]*flex:\s*1[^{}]*\}/],
        ['.section-title[hidden] is closed', /\.section-title\[hidden\]\{[^{}]*\}/],
    ];
    for (const [label, re] of mustSurvive) {
        assert.match(styles, re, `${label} — rule missing or swallowed by a parse break`);
    }
});

test('desktop-viewer.js imports every shared-UI helper it calls', () => {
    const src = fs.readFileSync(path.resolve('core/ui/desktop-viewer.js'), 'utf-8');
    const imported = new Set<string>();
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
        for (const raw of m[1].split(',')) {
            const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
            if (name) imported.add(name);
        }
    }
    const defined = new Set<string>();
    for (const m of src.matchAll(/(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);

    // Free-standing UI helpers that live in the shared modules: if desktop-viewer
    // calls one, it must import it, or the bundle throws a ReferenceError at
    // runtime (never at build or tsc time). Curated to avoid method-call noise.
    const SHARED_UI_HELPERS = [
        'updateToolbarButtons', 'updateStatus', 'showLoading', 'showEmptyState',
        'showErrorState', 'renderSidebar', 'updateBatchSidebar', 'renderDataGrid',
        'updatePagination', 'clearSelection', 'persistState', 'loadTableData',
        'loadTableColumns', 'refreshSchema', 'updateMutationControlCapabilities',
    ];
    const missing = SHARED_UI_HELPERS.filter(name =>
        new RegExp(`(?<![.\\w])${name}\\s*\\(`).test(src) && !imported.has(name) && !defined.has(name));
    assert.deepEqual(missing, [], `desktop-viewer.js calls but never imports: ${missing.join(', ')}`);
});
