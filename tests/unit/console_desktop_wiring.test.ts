/**
 * Static gates for the desktop-only SQL console.
 *
 * Two invariants that no runtime test can catch, because both are properties
 * of which files reference what:
 *
 * 1. BUNDLE ISOLATION. console.js pulls in CodeMirror 6. Only
 *    desktop-viewer.js may import it (or console-results.js): the moment a
 *    shared module does, CodeMirror lands in the VS Code webview bundle and
 *    the web-demo bundle too, shipping ~380 KB of editor into the .vsix for a
 *    feature neither target exposes. Checked twice — once against the import
 *    graph in source (fast, names the culprit file) and once against the
 *    BUILT viewer.html artifacts (slow to diagnose, but it is the thing that
 *    actually ships, and it holds no matter how the import is spelled).
 *
 * 2. TEMPLATE/CSS CONTRACT. console.js and console-results.js build their DOM
 *    into elements the shared template owns, and both toggle visibility with
 *    the `hidden` attribute. Any author rule that sets `display` on such an
 *    element outranks the UA `[hidden] { display: none }` rule, so every one
 *    of them needs an explicit `[hidden]` companion — a silent, layout-only
 *    failure otherwise (a "hidden" pane stays on screen).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const uiDir = path.resolve(process.cwd(), 'core/ui');
const modulesDir = path.join(uiDir, 'modules');

const readUi = (relative: string) => readFileSync(path.join(uiDir, relative), 'utf8');

/** Every .js under core/ui that is neither a console module nor the desktop entry point. */
function nonDesktopSources(): string[] {
    const entries = readdirSync(uiDir)
        .filter(name => name.endsWith('.js') && name !== 'desktop-viewer.js')
        .map(name => path.join(uiDir, name));
    const modules = readdirSync(modulesDir)
        .filter(name => name.endsWith('.js') && !name.startsWith('console'))
        .map(name => path.join(modulesDir, name));
    return [...entries, ...modules];
}

/**
 * Matches all three ways a module can reach the console modules: `from '…'`,
 * a bare side-effect `import '…'`, and a dynamic `import('…')`. Only the first
 * makes CodeMirror unconditionally part of a bundle, but esbuild inlines the
 * dynamic form too when the output format is iife (which every viewer target
 * uses), so all three are disqualifying.
 */
const CONSOLE_IMPORT = /(?:from|import)\s*\(?\s*['"][^'"]*console(?:-results)?\.js['"]/;

test('only desktop-viewer.js imports the console modules (keeps CodeMirror out of the VS Code/web bundles)', () => {
    const importers = nonDesktopSources().filter(file =>
        CONSOLE_IMPORT.test(readFileSync(file, 'utf8'))
    );
    assert.deepEqual(
        importers.map(file => path.relative(process.cwd(), file)),
        [],
        'a shared module imports the console; CodeMirror would ship in every bundle'
    );

    // Positive control: the isolation assertion above is worthless if nobody
    // imports the console at all.
    const desktopEntry = readUi('desktop-viewer.js');
    assert.match(desktopEntry, /from\s+'\.\/modules\/console\.js'/);
    assert.match(desktopEntry, /from\s+'\.\/modules\/console-results\.js'/);
});

test('the built VS Code and web bundles contain no CodeMirror', () => {
    // The committed build outputs, i.e. what actually ships. This survives any
    // spelling of the import the source-level check above might miss, and it
    // catches a transitive path (shared module -> new module -> console) too.
    const occurrences = (file: string) =>
        (readFileSync(path.resolve(process.cwd(), file), 'utf8').match(/cm-content/g) ?? []).length;

    assert.equal(occurrences('core/ui/viewer.html'), 0, 'CodeMirror leaked into the VS Code webview bundle');
    assert.equal(
        occurrences('website/public/sqlite-viewer/viewer.html'), 0,
        'CodeMirror leaked into the web demo bundle'
    );

    // Positive control: `cm-content` is a CodeMirror-owned class name, so if a
    // dependency bump renamed it the two assertions above would pass while
    // proving nothing. The desktop bundle is where CodeMirror belongs.
    assert.ok(
        occurrences('desktop/viewer.html') > 0,
        'desktop bundle has no cm-content — the marker this test greps for is stale, not the isolation'
    );
});

test('the shared template carries the console mount points, inert by default', () => {
    const template = readUi('viewer.template.html');

    const container = template.match(/<div\b(?=[^>]*\bid=["']consoleContainer["'])[^>]*>/i)?.[0];
    assert.ok(container, 'console container must exist in the shared template');
    // VS Code and the web demo never run the desktop init, so the markup has
    // to be inert on its own rather than relying on a class that is never added.
    assert.match(container, /\bhidden\b/, 'console container must ship hidden');
    // Without this, grid-events.js handleDocumentClick treats any click inside
    // the console as an outside-click and clears the live grid selection.
    assert.match(container, /\bdata-preserve-grid-selection\b/);

    for (const id of ['consoleHost', 'consoleResults', 'consoleNotice']) {
        assert.match(template, new RegExp(`id=["']${id}["']`), `#${id} must exist`);
    }
    const toggle = template.match(/<button\b(?=[^>]*\bid=["']btnSqlConsole["'])[^>]*>/i)?.[0];
    assert.ok(toggle, 'SQL console toolbar button must exist');
    assert.match(toggle, /\bhidden\b/, 'toolbar button must ship hidden (desktop unhides it)');
});

test('every console element the modules hide has a [hidden] display companion', () => {
    const css = readUi('viewer.css');

    // Left side: selectors whose rule sets `display`. Right side: the element
    // whose `hidden` attribute is toggled at runtime, and by whom.
    const hiddenAtRuntime = [
        '.console-container',      // desktop-viewer.js setConsoleMode
        '.sql-console-host',       // console.js show()/hide()
        '.sql-console-notice',     // console.js setNotice()
        '.sql-console-page-notice',// desktop-viewer.js read-only notice
        '.sql-console-results-pane' // console-results.js tab strip select()
    ];

    for (const selector of hiddenAtRuntime) {
        const rule = css.match(
            new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`)
        )?.[1];
        assert.ok(rule, `${selector} must be styled`);
        if (!/display\s*:/.test(rule)) continue;
        assert.match(
            css,
            new RegExp(`\\${selector}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`),
            `${selector} sets display, so it must restate [hidden] { display: none }`
        );
    }

    // The renderer marks NULL cells with the grid's class but deliberately
    // without .data-cell, so the grid's own `.data-cell.null-value` rule does
    // not reach them (see console-results.js buildPane).
    assert.match(css, /\.sql-console-results-table\s+\.null-value\s*\{/);
    // Sticky headers only stick inside a scroll container.
    assert.match(css, /\.sql-console-results-pane\s*\{[^}]*overflow\s*:\s*auto/);
});
