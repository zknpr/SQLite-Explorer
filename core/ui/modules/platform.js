/** Platform-aware UI copy. VS Code shows ⌘ on macOS; so do we — everywhere. */
export const isMac = typeof navigator !== 'undefined'
    && /Mac|iP(hone|ad|od)/.test(navigator.platform ?? '');
export function modLabel(key, mac = isMac) {
    return mac ? `⌘${key}` : `Ctrl+${key}`;
}
export function saveHint(mac = isMac) {
    return `${modLabel('S', mac)} to save`;
}
