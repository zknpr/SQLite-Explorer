/**
 * Content Security Policy Utilities
 *
 * Helpers for building CSP headers for webviews.
 */

// CSP directive names
export const CspDirective = {
  DEFAULT: 'default-src',
  SCRIPT: 'script-src',
  STYLE: 'style-src',
  IMG: 'img-src',
  FONT: 'font-src',
  FRAME: 'frame-src',
  CHILD: 'child-src',
  CONNECT: 'connect-src',
  WORKER: 'worker-src',
} as const;

// CSP source keywords
export const CspSource = {
  SELF: "'self'",
  UNSAFE_INLINE: "'unsafe-inline'",
  UNSAFE_EVAL: "'unsafe-eval'",
  WASM_UNSAFE_EVAL: "'wasm-unsafe-eval'",
  NONE: "'none'",
  DATA: 'data:',
  BLOB: 'blob:',
} as const;

/**
 * Build a CSP header string from directive map.
 */
export function buildCspHeader(directives: Record<string, string[]>): string {
  const parts: string[] = [];

  for (const [directive, sources] of Object.entries(directives)) {
    if (sources.length > 0) {
      parts.push(`${directive} ${sources.join(' ')}`);
    }
  }

  return parts.join('; ');
}

/**
 * Create default CSP for SQLite Explorer webview.
 */
export function createDefaultCsp(webviewCspSource: string): Record<string, string[]> {
  return {
    [CspDirective.DEFAULT]: [webviewCspSource],
    [CspDirective.SCRIPT]: [webviewCspSource, CspSource.WASM_UNSAFE_EVAL, CspSource.UNSAFE_INLINE],
    [CspDirective.STYLE]: [webviewCspSource, CspSource.UNSAFE_INLINE],
    [CspDirective.IMG]: [webviewCspSource, CspSource.DATA, CspSource.BLOB],
    [CspDirective.FONT]: [webviewCspSource],
    [CspDirective.CHILD]: [CspSource.BLOB],
  };
}
