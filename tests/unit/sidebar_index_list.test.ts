/**
 * The sidebar's index rows show TWO identifiers — the index name and the table
 * it is on — and they have to be told apart.
 *
 * `renderIndexesList` has always built them correctly (`item-name` and
 * `item-detail` as siblings inside an `item-content` div, plus a correct
 * `title` tooltip), but NEITHER wrapper class had a CSS rule anywhere, in
 * viewer.css or desktop-themes.css. Two unstyled inline spans inside a block
 * div render flush against each other, so `CREATE INDEX idx_people_age ON
 * people(age)` appeared in the sidebar as `idx_people_agepeople` — a string
 * that is not a valid identifier, in the one sidebar section with no other
 * place to read the name. Anyone reading it off the list, copying it, or
 * searching for it got something that does not exist.
 *
 * This is SHARED UI, so the rules must ship in all three generated viewers
 * (VS Code extension, web demo, desktop app) — hence the bundle assertions
 * rather than a source-only check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (relative: string) => readFileSync(path.resolve(relative), 'utf8');

const SIDEBAR = read('core/ui/modules/sidebar.js');
const VIEWER_CSS = read('core/ui/viewer.css');

const GENERATED_VIEWERS = [
    'core/ui/viewer.html',              // VS Code extension webview
    'website/public/sqlite-viewer/viewer.html', // web demo
    'desktop/viewer.html'               // desktop app
];

/** Every class `renderIndexesList` puts on an element, icon font aside. */
function indexRowClasses(): string[] {
    const start = SIDEBAR.indexOf('function renderIndexesList(');
    assert.notEqual(start, -1, 'renderIndexesList was renamed; update this test');
    const end = SIDEBAR.indexOf('\n}', start);
    assert.notEqual(end, -1, 'could not find the end of renderIndexesList');
    const body = SIDEBAR.slice(start, end);

    const classes = new Set<string>();
    for (const match of body.matchAll(/className\s*=\s*['`]([^'`]*)['`]/g)) {
        for (const token of match[1].split(/\s+/)) {
            // `codicon`/`codicon-*` come from the vendored icon font, not from
            // the viewer's own stylesheet.
            if (token && !token.startsWith('codicon')) classes.add(token);
        }
    }
    return [...classes].sort();
}

function ruleFor(css: string, selector: string): string | undefined {
    // Matches both the authored (`.a .b {\n  x: y;\n}`) and the bundled,
    // minified (`.a .b{x:y}`) forms.
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1];
}

test('every class an index row renders is actually styled', () => {
    const classes = indexRowClasses();
    // The defect was two of these silently having no rule at all; assert the
    // whole set so a third one cannot be added the same way.
    assert.deepEqual(classes, ['item-content', 'item-detail', 'item-icon', 'item-name', 'list-item']);
    for (const className of classes) {
        assert.match(
            VIEWER_CSS,
            new RegExp(`\\.${className}(?![\\w-])`),
            `.${className} is rendered by renderIndexesList but has no rule in core/ui/viewer.css`
        );
    }
});

test('the index name and its table cannot render flush against each other', () => {
    const content = ruleFor(VIEWER_CSS, '.list-item .item-content');
    assert.ok(content, '.list-item .item-content has no rule');
    // A flex row is what makes `gap` apply at all; without both, the two
    // identifiers concatenate into `idx_people_agepeople`.
    assert.match(content, /display:\s*flex/);
    const gap = content.match(/gap:\s*(\d+(?:\.\d+)?)px/);
    assert.ok(gap, '.item-content declares no pixel gap between the two identifiers');
    assert.ok(Number(gap[1]) > 0, 'the gap between the two identifiers must not be zero');
    // Truncation only engages on a flex item that may shrink below its content.
    assert.match(content, /min-width:\s*0/);

    const detail = ruleFor(VIEWER_CSS, '.list-item .item-detail');
    assert.ok(detail, '.list-item .item-detail has no rule');
    // Secondary, so the identifier the user came to read is the prominent one.
    assert.match(detail, /color:\s*var\(--text-secondary\)/);
});

for (const viewer of GENERATED_VIEWERS) {
    test(`${viewer} ships the index-row rules (shared UI, not a desktop patch)`, () => {
        const html = read(viewer);
        const content = ruleFor(html, '.list-item .item-content');
        assert.ok(content, `${viewer} is stale or missing .item-content; run node scripts/build.mjs`);
        assert.match(content, /display:flex/);
        assert.match(content, /gap:[1-9]/);
        assert.ok(
            ruleFor(html, '.list-item .item-detail'),
            `${viewer} is stale or missing .item-detail; run node scripts/build.mjs`
        );
    });
}
