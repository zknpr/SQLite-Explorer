/**
 * Runtime surface the desktop native sidecar installs BEFORE the worker
 * method layer loads: argv binding, the tjs:sqlite engine factory, the framed
 * stdio transport, and the `self` global worker.js expects. The lifecycle
 * (importing worker.js, then start/flush/exit) lives in native-entry.js.
 *
 * This split is load-bearing, not cosmetic. worker.js's module body reads
 * `self`, so everything here must initialise first — and the engine seam's
 * injected binding (core/native/native-engine-inject.js) makes worker.js
 * depend on this module. If the factory lived in the entry alongside its
 * top-level awaits, that dependency would put a top-level-await module inside
 * an import cycle, which esbuild can only express by wrapping it lazily —
 * and a lazily-wrapped module cannot legally contain top-level await (the
 * bundle it emits fails to parse). Keeping this module synchronous and
 * cycle-free is what keeps the bundle valid.
 *
 * See native-entry.js for the argv contract and exit codes.
 */

import { Database } from 'tjs:sqlite';
import { createShimDatabase } from './sqljs-shim.js';
import { createStdioTransport } from './stdio-transport.js';
import { frameErrorResponse } from './frame-codec.js';

export const EXIT_CLEAN = 0;
export const EXIT_TRANSPORT_FATAL = 1;
export const EXIT_USAGE = 2;
export const EXIT_ORPHANED = 3;

/** Mirrors DEFAULT_QUERY_TIMEOUT_MS in worker.js (which the seam cannot export). */
const DEFAULT_QUERY_TIMEOUT_MS = 30000;
const PPID_WATCHDOG_INTERVAL_MS = 1000;

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

const args = tjs.args.slice(3);
if (args.length !== 2 || args[0] === '' || (args[1] !== 'ro' && args[1] !== 'rw')) {
  console.error(
    `[native-worker] bad argv ${JSON.stringify(args)}; ` +
    'usage: tjs run native-worker-desktop.js <dbPath> ro|rw'
  );
  tjs.exit(EXIT_USAGE);
}
const boundPath = args[0];
const boundReadOnly = args[1] === 'ro';

// ---------------------------------------------------------------------------
// Engine factory (the worker.js seam's `__desktopNativeCreateEngine`)
// ---------------------------------------------------------------------------

// tjs.env.TMPDIR is the user-private temp root on macOS; the fallback only
// matters for stripped environments. makeTempDir itself guarantees the fresh,
// uniquely named, owner-only directory the shim's export contract requires.
const tempRoot = (tjs.env.TMPDIR ?? '/tmp').replace(/\/+$/, '');

const shimDeps = {
  sqlite: { Database },
  fs: {
    makeTempDir: () => tjs.makeTempDir(`${tempRoot}/sqlite-explorer-export-XXXXXX`),
    readFile: (path) => tjs.readFile(path),
    remove: (path) => tjs.remove(path, { recursive: true })
  },
  onCleanupFailure: (error, context) => {
    console.error(`[native-worker] cleanup failed (${context}): ${error?.message ?? error}`);
  }
};

/**
 * The engine the factory last produced, or null before the first successful
 * `initializeDatabase` and after a refused one. Only the `exportDatabase`
 * interception below reads it; worker.js owns the engine's lifecycle (it
 * closes the previous instance before every re-initialisation).
 */
let activeDb = null;

/**
 * Engine factory called by worker.js's engine seam with the raw
 * `initializeDatabase` config. Returns `{ SQL, db }`: `db` is the sql.js-shaped
 * shim over `tjs:sqlite`, and `SQL` is an inert marker — the only WASM-build
 * code that reaches into `SQL` (the paged-open ladder) is unreachable here
 * because native configs carry a path, never a File handle.
 *
 * PATH BINDING (layer 2 of the desktop's three-layer path authority; layers
 * 1 and 3 live in the Rust shell): the open is refused unless `config.path`
 * strictly equals the argv path, and a session spawned `ro` refuses a
 * writable open. This holds even if the Rust layers are bypassed, because
 * this factory is the only code in the process that opens databases.
 * Refusals throw; worker.js's dispatch catch turns them into a structured
 * `{ success: false, errorMessage }` response for the caller.
 */
export async function createNativeEngine(config) {
  // Whatever happens next, the engine we handed out before this call is gone:
  // worker.js closes it before asking for a new one.
  activeDb = null;

  if (config?.path !== boundPath) {
    throw new Error(
      'refusing to open a database other than the one this sidecar was ' +
      `bound to at spawn (got ${JSON.stringify(config?.path ?? null)})`
    );
  }
  // `readOnlyMode` is the same key worker.js consumes for its own read-only
  // state, so worker guards and engine enforcement cannot diverge. A stricter
  // open than the session (ro over an rw spawn) is harmless and allowed; a
  // writable open of an `ro` session would be privilege escalation and is
  // refused rather than silently downgraded.
  const readOnly = config.readOnlyMode === true;
  if (boundReadOnly && !readOnly) {
    throw new Error(
      'refusing a writable open: this sidecar was spawned for a read-only session'
    );
  }

  const db = createShimDatabase({ path: boundPath, readOnly }, shimDeps);

  // Query-timeout wiring. worker.js arms `db.progress_handler(interval, cb)`
  // immediately before every bounded synchronous operation and disarms it in
  // a `finally`; on the fork the callback is inert (queries run as one
  // synchronous native call, so no JS can observe progress), which would
  // leave the timeout dead. Translate arm/disarm into the fork's native
  // statement deadline instead. The budget mirrors worker.js's own
  // computation (armed-at + queryTimeout); an expiry surfaces as SQLite's
  // "interrupted" (errno 9) rather than the WASM timeout message.
  // Cancellation flags cannot arrive here at all: they require a
  // SharedArrayBuffer, which the JSON frame codec cannot carry.
  const queryTimeoutMs = Number.isFinite(config.queryTimeout) && config.queryTimeout > 0
    ? config.queryTimeout
    : DEFAULT_QUERY_TIMEOUT_MS;
  const recordProgressHandler = db.progress_handler.bind(db);
  db.progress_handler = (interval, callback) => {
    // Keep the shim's own recording (its `progressHandler` inspection hook).
    recordProgressHandler(interval, callback);
    if (interval != null && typeof callback === 'function') {
      db.setQueryDeadline(queryTimeoutMs);
    } else {
      db.clearQueryDeadline();
    }
    return undefined;
  };

  activeDb = db;
  return { SQL: Object.freeze({ engine: 'tjs-native' }), db };
}

// ---------------------------------------------------------------------------
// Transport + the worker's `self` surface
// ---------------------------------------------------------------------------

/** Set by onEof exactly once; consulted after start() resolves to pick the exit code. */
let shutdownReason = { kind: 'eof' };
export const getShutdownReason = () => shutdownReason;

export const transport = createStdioTransport({
  onEof: (reason) => { shutdownReason = reason; },
  onTransportError: (error) => {
    console.error(`[native-worker] transport error: ${error?.message ?? error}`);
  }
});

const messageIdOf = (message) => {
  const id = message?.content?.messageId;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
};

/**
 * The cap-safe send every reply goes through. `transport.postMessage` throws
 * synchronously on an over-cap frame, and two of worker.js's three send sites
 * (the unknown-method reply, which interpolates the caller-supplied method
 * name, and the catch-branch reply) call it unguarded — so the worker layer is
 * handed THIS instead: on a cap error the response is replaced by a bounded
 * error response for the same messageId, and the pending RPC still resolves.
 * The fallback send is itself guarded because this function must never throw
 * back into worker.js.
 */
const sendGuarded = (message) => {
  try {
    transport.postMessage(message);
  } catch (error) {
    try {
      transport.postMessage(frameErrorResponse(error, messageIdOf(message)));
    } catch (secondary) {
      console.error(
        `[native-worker] failed to send bounded error response: ${secondary?.message ?? secondary}`
      );
    }
  }
};

// worker.js's `self` global: in the tjs runtime `self === globalThis`, so the
// process global IS the worker-scope surface, exactly like a real
// DedicatedWorkerGlobalScope — worker.js's `self.onmessage = ...` lands on
// globalThis, and its `self.postMessage(...)` resolves to the send installed
// here. This is not a stylistic choice: tjs pins `self` behind a fixed
// accessor, so a replacement surface object assigned to `globalThis.self`
// would be silently discarded and the worker would wire itself to nothing.
// The transfer list worker.js passes on export responses is a WASM-side
// memory optimisation with no meaning on a byte-copying pipe; accepted and
// ignored.
globalThis.postMessage = (message, _transferList) => { sendGuarded(message); };

/**
 * `exportDatabase`, served at this dispatch layer instead of worker.js's own
 * handler: that handler calls `db.export()`, which requires a synchronous
 * filesystem the fork does not have. The shim's `exportAsync()` (VACUUM INTO
 * a fresh temp file, read, remove) is the native equivalent. A result larger
 * than the frame cap becomes `sendGuarded`'s bounded error response by
 * design — the out-of-band large-export route is a later host decision.
 *
 * Accepted parity gap: the worker-side cell-read-session guard
 * (`assertCellReadSessionAllowsMethod`) is not consulted here; the host
 * closes read sessions before exporting.
 */
async function handleExportDatabase(messageId) {
  try {
    if (!activeDb) throw new Error('No database initialized');
    const bytes = await activeDb.exportAsync();
    sendGuarded({
      channel: 'rpc',
      content: { kind: 'response', messageId, success: true, data: bytes }
    });
  } catch (error) {
    sendGuarded(frameErrorResponse(error, messageId));
  }
}

// Dispatch: exportDatabase is intercepted, everything else flows to the
// unchanged worker method layer (its `self.onmessage` assignment — the
// globalThis read below). Async (and try/caught) so no malformed envelope or
// handler failure can throw synchronously into the transport's read loop — a
// dispatch-level failure answers in band instead. worker.js has registered
// its onmessage by the time any frame can arrive: native-entry.js imports it
// before calling transport.start().
transport.onmessage = async (event) => {
  const envelope = event?.data;
  try {
    const content = envelope?.channel === 'rpc' ? envelope.content : undefined;
    if (content?.kind === 'invoke' && content.targetMethod === 'exportDatabase') {
      await handleExportDatabase(content.messageId);
      return;
    }
    await globalThis.onmessage?.(event);
  } catch (error) {
    sendGuarded(frameErrorResponse(error, messageIdOf(envelope)));
  }
};

// ---------------------------------------------------------------------------
// Orphan watchdog
// ---------------------------------------------------------------------------

// stdin EOF is the PRIMARY orphan signal (transport.start() resolving in the
// entry). This ppid poll is the backstop for the write end having been
// inherited by some other process, which would keep the pipe open after the
// parent died. Captured at boot: if the parent died even earlier, ppid never
// changes again and the EOF path is the one that fires.
const bootPpid = tjs.ppid;
setInterval(() => {
  if (tjs.ppid !== bootPpid) {
    console.error(
      `[native-worker] parent process ${bootPpid} vanished without closing ` +
      `stdin (ppid now ${tjs.ppid}); exiting`
    );
    tjs.exit(EXIT_ORPHANED);
  }
}, PPID_WATCHDOG_INTERVAL_MS);
