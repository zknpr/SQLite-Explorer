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
// Webview Panel Collection
// ============================================================================

/**
 * Tracks webview panels associated with document URIs.
 *
 * Allows lookup of panels by document URI or unique webview ID.
 * Automatically removes entries when panels are disposed.
 */
export class WebviewCollection {
  /** Internal storage for URI to panel mappings */
  private readonly entries = new Set<{
    readonly uriString: string;
    readonly panel: vsc.WebviewPanel;
  }>();

  /** Map from webview ID to panel for direct lookup */
  private readonly idLookup = new Map<string, vsc.WebviewPanel>();

  /**
   * Iterate all panels associated with a document URI.
   *
   * @param uri - Document URI to look up
   * @yields WebviewPanel instances for this URI
   */
  public *get(uri: vsc.Uri): IterableIterator<vsc.WebviewPanel> {
    const targetKey = uri.toString();
    for (const entry of this.entries) {
      if (entry.uriString === targetKey) {
        yield entry.panel;
      }
    }
  }

  /**
   * Find a panel by its unique webview ID.
   *
   * @param webviewId - Unique identifier for the webview
   * @returns Panel if found, undefined otherwise
   */
  public getByWebviewId(webviewId: string): vsc.WebviewPanel | undefined {
    return this.idLookup.get(webviewId);
  }

  /**
   * Check if any panels exist for a document URI.
   *
   * @param uri - Document URI to check
   * @returns True if at least one panel exists
   */
  public has(uri: vsc.Uri): boolean {
    return !this.get(uri).next().done;
  }

  /**
   * Register a new webview panel.
   *
   * @param uri - Associated document URI
   * @param panel - Webview panel instance
   * @param webviewId - Unique identifier for this webview
   */
  public add(uri: vsc.Uri, panel: vsc.WebviewPanel, webviewId: string): void {
    const entry = { uriString: uri.toString(), panel };
    this.entries.add(entry);
    this.idLookup.set(webviewId, panel);

    // Auto-cleanup on panel disposal
    panel.onDidDispose(() => {
      this.entries.delete(entry);
      this.idLookup.delete(webviewId);
    });
  }
}

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

  // Source values
  self: "'self'",
  none: "'none'",
  data: 'data:',
  blob: 'blob:',
  inlineStyle: "'unsafe-inline'",
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

/**
 * Convert VS Code CancellationToken to standard AbortSignal.
 *
 * @param token - VS Code cancellation token (or null/undefined)
 * @returns AbortSignal that triggers when token is cancelled
 */
export function cancelTokenToAbortSignal<T extends vsc.CancellationToken | null | undefined>(
  token: T
): T extends null ? undefined : AbortSignal {
  if (token == null) return undefined as any;

  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  } else {
    token.onCancellationRequested(() => controller.abort());
  }
  return controller.signal as any;
}

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
    if (import.meta.env.DEV) {
      console.warn(`[${Title}]`, err instanceof Error ? err.message : String(err));
    }
  }
}


// ============================================================================
// String Utilities
// ============================================================================

/**
 * Convert camelCase to dash-case.
 */
function toDashCase(str: string): string {
  return str.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);
}

/**
 * Convert object to HTML data attributes string.
 *
 * @param obj - Object with string/boolean/undefined values
 * @returns HTML attribute string like 'data-foo="bar" data-baz="true"'
 */
export function toDatasetAttrs(obj: Record<string, string | boolean | undefined>): string {
  return Object.entries(obj)
    .filter(([, value]) => value != null)
    .map(([key, value]) => `data-${toDashCase(key)}="${value}"`)
    .join(' ');
}

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

// ============================================================================
// Type Utilities
// ============================================================================

/**
 * String representation of boolean for HTML attributes.
 */
export type BoolString = 'true' | 'false';

/**
 * Convert boolean to string for HTML attributes.
 *
 * @param value - Boolean value (or null/undefined)
 * @returns 'true', 'false', or undefined
 */
export function toBoolString(value?: boolean | null): BoolString | undefined {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return undefined;
}

