/**
 * Platform-agnostic Web Streams API
 *
 * Provides unified streaming primitives that work in both:
 * - Browser environments (VS Code Web): Uses native Web Streams API
 * - Node.js environments (VS Code Desktop): Uses Node's stream/web module
 *
 * Web Streams provide a standardized way to handle streaming data
 * for operations like file reading, data processing, and exports.
 */

// ============================================================================
// Runtime Detection
// ============================================================================

const isBrowserRuntime = import.meta.env.VSCODE_BROWSER_EXT;

// ============================================================================
// Stream API Exports
// ============================================================================

/**
 * Cross-platform ReadableStream for consuming data.
 * Used for reading database content and file data.
 */
export const ReadableStream: typeof globalThis.ReadableStream = isBrowserRuntime
  ? globalThis.ReadableStream
  : require('stream/web').ReadableStream;

/**
 * Cross-platform WritableStream for producing data.
 * Used for writing exports and database saves.
 */
export const WritableStream: typeof globalThis.WritableStream = isBrowserRuntime
  ? globalThis.WritableStream
  : require('stream/web').WritableStream;

/**
 * Cross-platform TransformStream for data transformation pipelines.
 * Used for processing data as it flows through the system.
 */
export const TransformStream: typeof globalThis.TransformStream = isBrowserRuntime
  ? globalThis.TransformStream
  : require('stream/web').TransformStream;

/**
 * Cross-platform TextEncoderStream for string-to-bytes conversion.
 * Used for encoding text data for binary operations.
 */
export const TextEncoderStream: typeof globalThis.TextEncoderStream = isBrowserRuntime
  ? globalThis.TextEncoderStream
  : require('stream/web').TextEncoderStream;

/**
 * Cross-platform TextDecoderStream for bytes-to-string conversion.
 * Used for decoding binary data to readable text.
 */
export const TextDecoderStream: typeof globalThis.TextDecoderStream = isBrowserRuntime
  ? globalThis.TextDecoderStream
  : require('stream/web').TextDecoderStream;
