/**
 * Types for desktop-theme.js — desktop theme application. `system` resolves
 * to dark/light from the OS and re-resolves live; explicit themes pin
 * data-theme and drop the OS listener.
 */

/** The exact set of theme ids the desktop build supports. */
export type ThemeId = 'system' | 'dark' | 'light' | 'high-contrast' | 'solarized' | 'nord';

/**
 * Injectable environment so tests can run applyTheme without a DOM (see
 * tests/unit/desktop_theme.test.ts). Both fall back to the real global when
 * omitted.
 */
export interface ApplyThemeDeps {
    document?: Document;
    matchMedia?: (query: string) => MediaQueryList;
}

export const THEME_IDS: readonly ThemeId[];

/**
 * Sets `document.documentElement.dataset.theme` and `.style.colorScheme` for
 * `value`, falling back to 'system' when `value` isn't a known theme id.
 * 'system' additionally subscribes a `prefers-color-scheme` listener (torn
 * down on the next call) that re-resolves `dataset.theme` to dark/light live.
 * Returns the requested theme id ('system' included — the dataset attribute,
 * not this return value, carries the live-resolved dark/light).
 */
export function applyTheme(value: string, deps?: ApplyThemeDeps): ThemeId;
