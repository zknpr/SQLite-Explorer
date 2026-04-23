/**
 * Utility Functions and Classes
 *
 * Common utilities for the SQLite Explorer extension including:
 * - Environment detection for different VS Code hosts
 * - Webview panel management
 * - Content Security Policy building
 * - URI parsing and manipulation
 * - Cryptographic hashing
 */

import * as vsc from 'vscode';
import { base64urlnopad } from '@scure/base';
import { crypto } from './platform/cryptoShim';
import { Title } from './config';

// ============================================================================
// Environment Detection
// ============================================================================

/**
 * Detect VS Code environment type.
 * These checks help determine available features and appropriate behavior.
 */
export const IsVSCode = vsc.env.uriScheme.includes('vscode');
export const IsVSCodium = vsc.env.uriScheme.includes('vscodium');
export const IsCursorIDE = vsc.env.appName.includes('Cursor') || vsc.env.uriScheme.includes('cursor');

/**
 * Current UI language code (e.g., 'en', 'de', 'zh-cn').
 */
export const lang = vsc.env.language.split('.')[0]?.replace('_', '-') ?? 'en';

// ============================================================================
// Content Security Policy
// ============================================================================

/**
 * Content Security Policy directive constants and builder.
 */
export const cspUtil = {
  // Directive names
  defaultSrc: 'default-src',
  scriptSrc: 'script-src',
  styleSrc: 'style-src',
  imgSrc: 'img-src',
  fontSrc: 'font-src',
  frameSrc: 'frame-src',
  childSrc: 'child-src',
  mediaSrc: 'media-src',  // Required for video/audio blob playback in blob inspector

  // Source values
  self: "'self'",
  none: "'none'",
  data: 'data:',
  blob: 'blob:',
  unsafeEval: "'unsafe-eval'",
  wasmUnsafeEval: "'wasm-unsafe-eval'",

  /**
   * Build CSP string from directive map.
   *
   * @param directives - Map of directive names to source arrays
   * @returns Formatted CSP header value
   */
  build(directives: Record<string, string[]>): string {
    return Object.entries(directives)
      .map(([directive, sources]) => {
        const filteredSources = sources.filter(s => s != null);
        return `${directive} ${filteredSources.join(' ')};`;
      })
      .join(' ');
  }
} as const;

// ============================================================================
// URI Utilities
// ============================================================================

/** Pattern for parsing URI path components */
const uriPathPattern = /(?<directory>.*\/)?(?<fullname>(?<name>[^/]*?)(?<extension>\.[^/.]+)?)$/;

/**
 * Extract path components from a URI.
 *
 * @param uri - URI string or VS Code Uri object
 * @returns Object with dirname, filename, basename, and extname
 */
export function getUriParts(uri: string | vsc.Uri): {
  dirname: string;
  filename: string;
  basename: string;
  extname: string;
} {
  const uriString = uri.toString();
  const match = uriString.match(uriPathPattern);
  const groups = match?.groups ?? {};

  return {
    dirname: decodeURIComponent(groups.directory ?? ''),
    filename: decodeURIComponent(groups.fullname ?? ''),
    basename: decodeURIComponent(groups.name ?? ''),
    extname: decodeURIComponent(groups.extension ?? '')
  };
}

// ============================================================================
// Abort Signal Utilities
// ============================================================================

// Re-export the canonical implementation from cancellation-utils.ts
// which properly cleans up the disposable after abort to prevent memory leaks.
export { cancelTokenToAbortSignal } from './core/cancellation-utils';

// ============================================================================
// Cryptographic Utilities
// ============================================================================

/** UTF-8 text encoder instance */
const textEncoder = new TextEncoder();


/**
 * Generate a base64url-encoded hash of a string.
 *
 * @param input - String to hash
 * @param length - Number of bytes to use (default 6)
 * @returns Truncated SHA-256 hash encoded as base64url
 */
async function hash64(input: string, length: number = 6): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  const hashBytes = new Uint8Array(hashBuffer).subarray(0, length);
  return base64urlnopad.encode(hashBytes);
}


/**
 * Generate a unique key for a database document.
 *
 * Combines filename with path hash for uniqueness while
 * remaining human-readable.
 *
 * @param uri - Document URI
 * @returns Unique document key like "database.sqlite <abc123>"
 */
export async function generateDatabaseDocumentKey(uri: vsc.Uri): Promise<string> {
  const { basename, extname } = getUriParts(uri);
  const pathHash = await hash64(uri.path);
  return `${basename}${extname} <${pathHash}>`;
}

// ============================================================================
// Error Handling Utilities
// ============================================================================

/**
 * Execute a function and suppress any errors.
 *
 * @param fn - Function to execute
 * @returns Function result or undefined on error
 */
export function doTry<T extends (...args: unknown[]) => unknown>(fn: T): ReturnType<T> | undefined {
  try {
    return fn() as ReturnType<T>;
  } catch (err) {
    console.warn(`[${Title}]`, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}


// ============================================================================
// String/HTML Utilities
// ============================================================================

export { toDatasetAttrs, toBoolString, type BoolString } from './html-utils';

// ============================================================================
// Theme Utilities
// ============================================================================

/**
 * Convert VS Code color theme to CSS color-scheme value.
 *
 * @param theme - VS Code color theme
 * @returns 'dark' or 'light'
 */
export function themeToCss(theme: vsc.ColorTheme): 'dark' | 'light' {
  switch (theme.kind) {
    case vsc.ColorThemeKind.Dark:
    case vsc.ColorThemeKind.HighContrast:
      return 'dark';
    case vsc.ColorThemeKind.Light:
    case vsc.ColorThemeKind.HighContrastLight:
      return 'light';
  }
}

/**
 * Convert VS Code UI kind to string.
 *
 * @param uiKind - VS Code UI kind enum
 * @returns 'web' or 'desktop'
 */
export function uiKindToString(uiKind: vsc.UIKind): 'web' | 'desktop' {
  return uiKind === vsc.UIKind.Web ? 'web' : 'desktop';
}


