/**
 * URI and Path Utilities
 *
 * Helpers for working with VS Code URIs and file paths.
 */

import * as vsc from 'vscode';
import * as crypto from 'crypto';

/**
 * Parsed URI components for database files.
 */
export interface UriComponents {
  filename: string;
  dirname: string;
  basename: string;
  extension: string;
}

/**
 * Parse a VS Code URI into components.
 */
export function parseUri(uri: vsc.Uri): UriComponents {
  const pathParts = uri.path.split('/');
  const filename = pathParts[pathParts.length - 1] || '';
  const dirname = pathParts.slice(0, -1).join('/') || '/';

  const dotIndex = filename.lastIndexOf('.');
  const basename = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  const extension = dotIndex > 0 ? filename.slice(dotIndex) : '';

  return {
    filename,
    dirname: uri.with({ path: dirname }).toString(),
    basename,
    extension
  };
}

/**
 * Generate a unique document key from URI.
 */
export async function generateDocumentKey(uri: vsc.Uri): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update(uri.toString());
  return hash.digest('hex').slice(0, 16);
}

/**
 * Convert a cancellation token to an AbortSignal.
 */
export function tokenToSignal(token?: vsc.CancellationToken): AbortSignal | undefined {
  if (!token) return undefined;

  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());

  return controller.signal;
}
