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
import { base58, base64urlnopad } from '@scure/base';
import { Disposable } from './lifecycle';
import { ReadableStream, WritableStream } from './platform/streams/webStreams';
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
export const IsGitHubDotDev = vsc.env.uriScheme.includes('vscode') && vsc.env.appHost === 'github.dev';
export const IsGitPodWeb = vsc.env.uriScheme.includes('gitpod-code') || vsc.env.appHost === 'Gitpod' || vsc.env.appName === 'Gitpod Code';
export const IsGoogleIDX = vsc.env.appName.includes('IDX') || (vsc.env.appHost === 'web' && vsc.env.remoteName?.startsWith('idx'));
export const IsCursorIDE = vsc.env.appName.includes('Cursor') || vsc.env.uriScheme.includes('cursor');
export const IsDesktop = vsc.env.appHost === 'desktop';

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
// Content Cache
// ============================================================================

/**
 * Temporary cache for text editor contents.
 *
 * Periodically removes entries for documents that are no longer open.
 * Useful for preserving content during save operations.
 */
export class ContentCache implements vsc.Disposable {
  private storage = new Map<string, string>();
  private cleanupTimer: ReturnType<typeof setInterval> | null;

  constructor() {
    // Run cleanup every minute
    this.cleanupTimer = setInterval(() => this.removeStaleEntries(), 60_000);
  }

  /**
   * Store content for a document URI.
   */
  set(uri: vsc.Uri, content: string): void {
    this.removeStaleEntries();
    this.storage.set(uri.toString(), content);
  }

  /**
   * Retrieve cached content for a document URI.
   */
  get(uri: vsc.Uri): string | null {
    return this.storage.get(uri.toString()) ?? null;
  }

  /**
   * Remove entries for documents that are no longer open.
   */
  private removeStaleEntries(): void {
    try {
      const openDocs = vsc.workspace.textDocuments;
      const openUriSet = new Set<string>(openDocs.map(doc => doc.uri.toString()));
      for (const cachedUri of [...this.storage.keys()]) {
        if (!openUriSet.has(cachedUri)) {
          this.storage.delete(cachedUri);
        }
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  /**
   * Clear all cached content.
   */
  clear(): void {
    this.storage.clear();
  }

  /**
   * Release resources.
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.storage.clear();
  }
}

// ============================================================================
// Webview Streaming
// ============================================================================

/**
 * Bidirectional stream wrapper for VS Code webview messaging.
 *
 * Provides ReadableStream and WritableStream interfaces over the
 * webview's postMessage API. Enables binary protocol overlays
 * for more efficient communication.
 */
export class WebviewStream extends Disposable {
  private inputStream: ReadableStream<Uint8Array>;
  private outputStream: WritableStream<Uint8Array>;
  private inputController!: ReadableStreamDefaultController<Uint8Array>;
  private outputController!: WritableStreamDefaultController;
  private inputClosed = false;
  private outputClosed = false;

  constructor(private readonly panel: vsc.WebviewPanel) {
    super();

    // Create input stream (receives data from webview)
    this.inputStream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.inputController = controller;

        // Forward binary messages to stream
        this._register(this.panel.webview.onDidReceiveMessage(msg => {
          if (msg instanceof Uint8Array) {
            controller.enqueue(msg);
          }
        }));

        // Handle panel disposal
        this._register(this.panel.onDidDispose(() => {
          this.shutdown(new DOMException('Panel disposed', 'AbortError'));
        }));
      },
      cancel: (reason) => {
        this.inputClosed = true;
        this.shutdown(reason);
      }
    });

    // Create output stream (sends data to webview)
    this.outputStream = new WritableStream<Uint8Array>({
      start: (controller) => {
        this.outputController = controller;
      },
      write: (chunk, controller) => {
        try {
          // Extract buffer view properties for transfer
          const { buffer, byteOffset, byteLength } = chunk;
          this.panel.webview.postMessage({ buffer, byteOffset, byteLength });
        } catch (err) {
          controller.error(err);
        }
      },
      close: () => {
        this.outputClosed = true;
        this.shutdown(null);
      },
      abort: (reason) => {
        this.outputClosed = true;
        this.shutdown(reason);
      }
    });
  }

  /**
   * Clean up stream resources.
   */
  private shutdown(reason?: unknown): void {
    super.dispose();

    // Close input stream
    if (!this.inputClosed) {
      this.inputClosed = true;
      if (reason) {
        this.inputController.error(reason);
      } else {
        this.inputController.close();
      }
    }

    // Close output stream
    if (!this.outputClosed) {
      this.outputClosed = true;
      if (this.outputStream.locked || reason) {
        this.outputController.error(reason ?? new DOMException('Stream closed', 'AbortError'));
      } else {
        this.outputStream.getWriter().close().catch(() => { });
      }
    }
  }

  /** Stream for receiving data from webview */
  get readable(): ReadableStream<Uint8Array> {
    return this.inputStream;
  }

  /** Stream for sending data to webview */
  get writable(): WritableStream<Uint8Array> {
    return this.outputStream;
  }

  dispose(): void {
    this.shutdown();
  }

  [Symbol.dispose](): void {
    this.shutdown();
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
 * Check if an error is an AbortError.
 */
export const isAbortError = (err: unknown): err is Error =>
  err instanceof Error && (err.name === 'AbortError' || err.message.startsWith('AbortError'));

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
 * Encode string to UTF-8 bytes.
 */
export const encodeUtf8 = (str: string): Uint8Array => textEncoder.encode(str);

/**
 * Generate a short base58-encoded hash of a string.
 *
 * @param input - String to hash
 * @returns 6-byte SHA-256 hash encoded as base58
 */
export async function shortHash(input: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', encodeUtf8(input) as any);
  const hashBytes = new Uint8Array(hashBuffer).subarray(0, 6);
  return base58.encode(hashBytes);
}

/**
 * Generate a base64url-encoded hash of a string.
 *
 * @param input - String to hash
 * @param length - Number of bytes to use (default 6)
 * @returns Truncated SHA-256 hash encoded as base64url
 */
export async function hash64(input: string, length: number = 6): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', encodeUtf8(input) as any);
  const hashBytes = new Uint8Array(hashBuffer).subarray(0, length);
  return base64urlnopad.encode(hashBytes);
}

/**
 * Get a short hash of the machine ID for anonymization.
 */
export async function getShortMachineId(): Promise<string> {
  return shortHash(vsc.env.machineId);
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
// Disposable Utilities
// ============================================================================

/**
 * ES2022 Disposable symbol interface.
 */
export type ESDisposable = {
  [Symbol.dispose](): void;
};

/**
 * Add ES2022 Symbol.dispose to a VS Code Disposable.
 *
 * @param disposable - VS Code Disposable object
 * @returns Same object with Symbol.dispose added
 */
export function assignESDispose<T extends vsc.Disposable>(disposable: T): T & ESDisposable {
  return Object.assign(disposable, {
    [Symbol.dispose]() {
      disposable.dispose();
    }
  });
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

/**
 * Execute an async function and suppress any errors.
 *
 * @param fn - Async function to execute
 * @returns Promise resolving to function result or undefined on error
 */
export async function doTryAsync<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T
): Promise<Awaited<ReturnType<T>> | undefined> {
  try {
    return await fn() as Awaited<ReturnType<T>>;
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

// ============================================================================
// Binary Utilities
// ============================================================================

/**
 * Concatenate multiple Uint8Array chunks into one.
 *
 * @param chunks - Array of Uint8Array chunks
 * @returns Single concatenated Uint8Array
 */
export function concat(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
