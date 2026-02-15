/**
 * Platform specific utilities.
 */

import type * as fs from 'fs';

/**
 * Safely require the 'fs' module in Node.js environments.
 * Returns undefined in browser environments or if require is not available.
 *
 * @returns The Node.js fs module or undefined
 */
export function getNodeFs(): typeof fs | undefined {
  if (typeof require === 'function') {
    try {
      return require('fs');
    } catch {
      // Ignore errors if fs cannot be required
    }
  }
  return undefined;
}
