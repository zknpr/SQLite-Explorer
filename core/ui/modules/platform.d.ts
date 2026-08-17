/**
 * Types for platform.js — platform-aware modifier-key copy. VS Code shows ⌘
 * on macOS regardless of host (desktop or web); this module keys off the
 * same signal (navigator.platform) so both builds render identical copy.
 */

/** True when the running platform is macOS/iOS, per navigator.platform. */
export const isMac: boolean;

/** Renders `key` with the platform's modifier glyph: `⌘${key}` or `Ctrl+${key}`. */
export function modLabel(key: string, mac?: boolean): string;

/** Full "save" hint suffix, e.g. `⌘S to save` / `Ctrl+S to save`. */
export function saveHint(mac?: boolean): string;
