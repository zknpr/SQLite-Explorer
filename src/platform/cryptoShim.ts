/**
 * Platform-agnostic Web Crypto API
 *
 * Provides a unified crypto interface that works in both:
 * - Browser environments (VS Code Web): Uses native globalThis.crypto
 * - Node.js environments (VS Code Desktop): Uses Node's webcrypto polyfill
 *
 * This abstraction allows cryptographic operations to work seamlessly
 * across all VS Code runtime environments.
 */

// Determine runtime environment and export appropriate crypto implementation
const isBrowserRuntime = import.meta.env.VSCODE_BROWSER_EXT;

// In browser: use native Web Crypto API
// In Node.js: use the webcrypto module from Node's crypto package
export const crypto: typeof globalThis.crypto = isBrowserRuntime
  ? globalThis.crypto
  : require('crypto').webcrypto;
