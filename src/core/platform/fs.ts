/**
 * Platform helper: safely require Node.js 'fs'.
 *
 * Lives in its own module so both src/core/sqlite-db.ts and
 * src/core/engine/wasm/WasmDatabaseEngine.ts can import it without
 * forming a circular dependency (sqlite-db re-exports the engine).
 */
export function getNodeFs(): typeof import('fs') | undefined {
  if (typeof require === 'function') {
    try {
      return require('fs');
    } catch {
      // fs not available (e.g., sandboxed environment)
    }
  }
  return undefined;
}
