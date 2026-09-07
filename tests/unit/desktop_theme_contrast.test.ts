/**
 * The desktop theme layer is hand-authored hex, and two whole classes of
 * palette defect shipped in it because nothing measured the values.
 *
 * 1. UNREADABLE SECONDARY TEXT. `viewer.css` maps
 *    `--text-secondary: var(--vscode-descriptionForeground)` and paints ~20
 *    rules with it, including the 11px second identifier in every sidebar
 *    index row (`.list-item .item-detail`). Nord shipped that at 1.96:1 on the
 *    sidebar and Solarized at 2.42:1 — below even the 3:1 large-text floor, so
 *    the text was there and could not be read. Solarized's PRIMARY text was
 *    4.11:1, under AA as well.
 *
 * 2. INVISIBLE SURFACES. `--bg-tertiary: var(--vscode-input-background)` paints
 *    18 surfaces, among them the `Tables / Views / Indexes` count pills in the
 *    sidebar. Nord, Solarized and high-contrast each declared
 *    `--vscode-input-background` BYTE-IDENTICAL to `--vscode-sideBar-background`,
 *    so the pills were invisible at rest and only appeared under the cursor,
 *    when the row behind them changed colour. Being distinct from the sidebar
 *    is not enough on its own: a value equal to `--vscode-list-hoverBackground`
 *    inverts the same bug, hiding the pill exactly when it is pointed at.
 *
 * Both are measurement problems, so this is a measurement test: it parses the
 * authored CSS and puts a floor under every palette, including the ones added
 * later. The generated bundles are covered by desktop_theme_css.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const CSS = readFileSync(path.resolve('core/ui/desktop-themes.css'), 'utf8');

/**
 * WCAG AA for normal text. Primary text carries the identifiers a user reads,
 * copies and types back, so it holds the full body-text line in every palette.
 */
const PRIMARY_MIN_CONTRAST = 4.5;
/**
 * Secondary text sits between AA (4.5) and the 3:1 large-text floor: the two
 * palettes inherited from VS Code's own defaults ship at 4.32 (dark) and 4.40
 * (light) and read fine, so pinning 4.5 would demand a redesign of colours we
 * deliberately mirror. 4.0 is the highest floor they all clear, and it is
 * twice the collapse this test was written for.
 */
const SECONDARY_MIN_CONTRAST = 4.0;
/**
 * Enough separation for a filled pill to have a visible edge against the
 * surface behind it. The shallowest one that ships and is confirmed to render
 * is light's #ffffff on #f3f3f3 at 1.11:1; 1.05 sits just under that, so the
 * floor rejects the defect (three palettes at exactly 1.00) without pinning
 * the light palette to its current hex.
 */
const SURFACE_MIN_CONTRAST = 1.05;

const EXPECTED_THEMES = ['dark', 'high-contrast', 'light', 'nord', 'solarized'];

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
    const channel = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio, 1..21. */
function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/** Every `--name: value` declaration in each `:root[data-theme=...]` block. */
function themeBlocks(): Map<string, Map<string, string>> {
    const blocks = new Map<string, Map<string, string>>();
    for (const block of CSS.matchAll(/:root\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g)) {
        const vars = new Map<string, string>();
        for (const decl of block[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
            vars.set(decl[1], decl[2].trim());
        }
        blocks.set(block[1], vars);
    }
    return blocks;
}

const THEMES = themeBlocks();

test('every desktop palette is measured by this file', () => {
    // Renaming or dropping a block must not silently narrow the coverage.
    assert.deepEqual([...THEMES.keys()].sort(), EXPECTED_THEMES);
});

for (const [theme, vars] of THEMES) {
    /** Reads a var that a contrast floor applies to, so it must be plain 6-digit hex. */
    const hex = (name: string): string => {
        const value = vars.get(name);
        assert.ok(value, `${theme} declares no ${name}`);
        assert.match(value!, /^#[0-9a-f]{6}$/i, `${theme}'s ${name} must be 6-digit hex to be measurable`);
        return value!;
    };

    test(`${theme} text clears its contrast floors`, () => {
        const editorBg = hex('--vscode-editor-background');
        const sidebarBg = hex('--vscode-sideBar-background');
        const inputBg = hex('--vscode-input-background');
        const primary = hex('--vscode-editor-foreground');
        const secondary = hex('--vscode-descriptionForeground');

        // Secondary text is painted over the sidebar and the editor body alike.
        for (const [label, bg] of [['sideBar', sidebarBg], ['editor', editorBg]] as const) {
            const ratio = contrast(secondary, bg);
            assert.ok(
                ratio >= SECONDARY_MIN_CONTRAST,
                `${theme}: descriptionForeground ${secondary} on ${label}-background ${bg} is ${ratio.toFixed(2)}:1, below ${SECONDARY_MIN_CONTRAST}:1`
            );
        }

        // Primary text adds the input surface — it is the text inside the Filter box.
        for (const [label, bg] of [['sideBar', sidebarBg], ['editor', editorBg], ['input', inputBg]] as const) {
            const ratio = contrast(primary, bg);
            assert.ok(
                ratio >= PRIMARY_MIN_CONTRAST,
                `${theme}: editorForeground ${primary} on ${label}-background ${bg} is ${ratio.toFixed(2)}:1, below ${PRIMARY_MIN_CONTRAST}:1`
            );
        }

        // Raising a washed-out secondary past its floor must not flatten the
        // hierarchy. high-contrast sets both to #ffffff by design, hence `<=`.
        assert.ok(
            contrast(secondary, sidebarBg) <= contrast(primary, sidebarBg),
            `${theme}: secondary text ${secondary} is no dimmer than primary ${primary}`
        );
    });

    test(`${theme} keeps the input surface visible against the sidebar`, () => {
        const sidebarBg = hex('--vscode-sideBar-background');
        const inputBg = hex('--vscode-input-background');
        const hoverBg = vars.get('--vscode-list-hoverBackground');
        assert.ok(hoverBg, `${theme} declares no --vscode-list-hoverBackground`);

        assert.notEqual(
            inputBg.toLowerCase(), sidebarBg.toLowerCase(),
            `${theme}: input-background equals sideBar-background, so every --bg-tertiary pill is invisible at rest`
        );
        // Compared as authored: the hover colour is an rgba() in some palettes.
        assert.notEqual(
            inputBg.toLowerCase(), hoverBg!.toLowerCase(),
            `${theme}: input-background equals list-hoverBackground, so every --bg-tertiary pill vanishes under the cursor`
        );

        const ratio = contrast(inputBg, sidebarBg);
        assert.ok(
            ratio >= SURFACE_MIN_CONTRAST,
            `${theme}: input-background ${inputBg} on sideBar-background ${sidebarBg} is ${ratio.toFixed(3)}:1, below ${SURFACE_MIN_CONTRAST}:1`
        );
    });
}
