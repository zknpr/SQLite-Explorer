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
export async function hash64(input: string, length: number = 6): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  const hashBytes = new Uint8Array(hashBuffer).subarray(0, length);
  return base64urlnopad.encode(hashBytes);
}


/**
 * Generate a unique key for a database document.
 *
 * Combines filename with a resource-URI hash for uniqueness while
 * remaining human-readable.
 *
 * @param uri - Document URI
 * @returns Unique document key like "database.sqlite <abc123>"
 */
export async function generateDatabaseDocumentKey(uri: vsc.Uri): Promise<string> {
  const { basename, extname } = getUriParts(uri);
  // URI components are kept separate so no delimiter ambiguity can make two
  // providers with the same path share a database engine or virtual-file root.
  // Preserve the legacy path hash for ordinary local files so already-open
  // virtual cell/view URIs remain valid across an extension update.
  const scheme = uri.scheme.toLowerCase();
  const resourceIdentity = scheme === 'file' && uri.authority === ''
    ? uri.path
    // Query and fragment are provider-defined resource selectors. Omitting
    // either can alias two distinct virtual databases even when their visible
    // scheme, authority, and path are identical.
    : JSON.stringify([scheme, uri.authority, uri.path, uri.query, uri.fragment]);
  const resourceHash = await hash64(resourceIdentity);
  return `${basename}${extname} <${resourceHash}>`;
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
export function doTry<T extends (...args: unknown[]) => unknown>(fn: T, onError?: string | ((err: unknown) => void)): ReturnType<T> | undefined {
  try {
    return fn() as ReturnType<T>;
  } catch (err) {
    if (typeof onError === 'function') {
      onError(err);
    } else {
      const context = onError ? `${onError}: ` : '';
      console.warn(`[${Title}]`, `${context}${err instanceof Error ? err.message : String(err)}`);
    }
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

// ============================================================================
// PII/Secret Masking Utilities
// ============================================================================

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
const API_KEY_REGEX = /\b(sk_live_|sk_test_|api_key_|token_|secret_|key_)[a-zA-Z0-9]{10,}\b/gi;
const HEX_REGEX = /\b[a-fA-F0-9]{32,}\b/g;
const CC_REGEX = /\b(?:\d[ -]*?){13,16}\b/g;
const SSN_REGEX = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g;

/**
 * Masks sensitive data like emails, phone numbers, API keys, hex strings,
 * credit card numbers, and SSNs in a given string.
 *
 * @param message - The string to mask
 * @returns The masked string
 */
export function maskSensitiveData(message: string): string {
  let safeMessage = message;
  safeMessage = safeMessage.replace(EMAIL_REGEX, '***@***.***');
  safeMessage = safeMessage.replace(CC_REGEX, '****-****-****-****');
  safeMessage = safeMessage.replace(PHONE_REGEX, '***-***-****');
  safeMessage = safeMessage.replace(API_KEY_REGEX, '$1[REDACTED]');
  safeMessage = safeMessage.replace(HEX_REGEX, '[REDACTED_HEX]');
  safeMessage = safeMessage.replace(SSN_REGEX, '***-**-****');
  return safeMessage;
}
