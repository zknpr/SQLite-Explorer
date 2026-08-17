/**
 * Desktop theme application. `system` resolves to dark/light from the OS and
 * re-resolves live; explicit themes pin data-theme and drop the listener.
 * Deps are injectable for tests (no DOM in the unit runner).
 */
const THEME_IDS = ['system', 'dark', 'light', 'high-contrast', 'solarized', 'nord'];
let systemMedia = null;
let systemHandler = null;

export function applyTheme(value, deps = {}) {
    const doc = deps.document ?? document;
    const matchMedia = deps.matchMedia ?? window.matchMedia.bind(window);
    const theme = THEME_IDS.includes(value) ? value : 'system';

    if (systemMedia && systemHandler) {
        systemMedia.removeEventListener('change', systemHandler);
        systemMedia = null;
        systemHandler = null;
    }

    const set = (id) => {
        doc.documentElement.dataset.theme = id;
        doc.documentElement.style.colorScheme =
            (id === 'light') ? 'light' : 'dark';
    };

    if (theme === 'system') {
        systemMedia = matchMedia('(prefers-color-scheme: dark)');
        systemHandler = () => set(systemMedia.matches ? 'dark' : 'light');
        systemMedia.addEventListener('change', systemHandler);
        systemHandler();
    } else {
        set(theme);
    }
    return theme;
}

export { THEME_IDS };
