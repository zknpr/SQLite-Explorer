import './vscode_mock_setup';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Pins the 5000-row default introduced 2026-08-08 (unlocked by keyset
// pagination, the count cache, and grid virtualization) across every layer
// that expresses it, plus the startup precedence contract: persisted in-grid
// choice > configured sqliteExplorer.defaultPageSize > built-in default.

const EXPECTED_DEFAULT = 5000;
const EXPECTED_OPTIONS = [100, 250, 500, 1000, 2500, 5000, 10000];

async function loadStateModule() {
    // Variable specifier keeps tsc from demanding declarations for the
    // plain-JS webview module (established pattern in grid_data_match_nav).
    const stateModulePath = '../../core/ui/modules/state.js';
    return import(stateModulePath);
}

describe('default page size', () => {
    it('template selector offers the preset ladder with 5000 selected', () => {
        const html = readFileSync(
            path.resolve(process.cwd(), 'core/ui/viewer.template.html'),
            'utf8'
        );
        const selectBody = html.match(
            /<select id="pageSizeSelect">([\s\S]*?)<\/select>/
        )?.[1];
        assert.ok(selectBody, 'pageSizeSelect must exist in viewer.template.html');

        const options = [...selectBody.matchAll(/<option value="(\d+)"(\s+selected)?>/g)]
            .map(match => ({ value: Number(match[1]), selected: !!match[2] }));
        assert.deepStrictEqual(
            options.map(option => option.value),
            EXPECTED_OPTIONS,
            'page-size presets changed — update state.js/package.json/docs together'
        );
        assert.deepStrictEqual(
            options.filter(option => option.selected).map(option => option.value),
            [EXPECTED_DEFAULT],
            'exactly one option, 5000, must carry the selected attribute'
        );
    });

    it('package.json contributes the same default', () => {
        const pkg = JSON.parse(
            readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')
        );
        const setting = pkg.contributes.configuration.properties['sqliteExplorer.defaultPageSize'];
        assert.strictEqual(setting.default, EXPECTED_DEFAULT);
    });

    it('webview state starts at the built-in default', async () => {
        const { state, DEFAULT_ROWS_PER_PAGE } = await loadStateModule();
        assert.strictEqual(DEFAULT_ROWS_PER_PAGE, EXPECTED_DEFAULT);
        assert.strictEqual(state.rowsPerPage, EXPECTED_DEFAULT);
    });
});

describe('startup page size precedence', () => {
    it('falls back to the built-in default when nothing else is usable', async () => {
        const { resolveStartupPageSize } = await loadStateModule();
        assert.strictEqual(resolveStartupPageSize(undefined, undefined), EXPECTED_DEFAULT);
        assert.strictEqual(resolveStartupPageSize('', null), EXPECTED_DEFAULT);
    });

    it('a configured sqliteExplorer.defaultPageSize wins over the built-in default', async () => {
        const { resolveStartupPageSize } = await loadStateModule();
        // The host delivers the setting as a dataset string.
        assert.strictEqual(resolveStartupPageSize('1000', undefined), 1000);
        // Non-preset values are honored too (the selector grows a custom option).
        assert.strictEqual(resolveStartupPageSize('750', undefined), 750);
    });

    it('a persisted in-grid choice wins over a configured setting', async () => {
        const { resolveStartupPageSize } = await loadStateModule();
        // Persisted webview state stores the number the user last picked.
        assert.strictEqual(resolveStartupPageSize('1000', 250), 250);
        assert.strictEqual(resolveStartupPageSize(undefined, 250), 250);
    });

    it('invalid values fall through source by source', async () => {
        const { resolveStartupPageSize } = await loadStateModule();
        // Bad persisted state → configured setting.
        assert.strictEqual(resolveStartupPageSize('1000', 0), 1000);
        assert.strictEqual(resolveStartupPageSize('1000', -5), 1000);
        assert.strictEqual(resolveStartupPageSize('1000', 250.5), 1000);
        // Bad persisted state and bad setting → built-in default.
        assert.strictEqual(resolveStartupPageSize('garbage', NaN), EXPECTED_DEFAULT);
        assert.strictEqual(resolveStartupPageSize('0', undefined), EXPECTED_DEFAULT);
        // Above the declared setting maximum → rejected, not clamped.
        assert.strictEqual(resolveStartupPageSize('100001', undefined), EXPECTED_DEFAULT);
        // Declared maximum itself is usable.
        assert.strictEqual(resolveStartupPageSize('100000', undefined), 100000);
    });
});
