/**
 * Runtime surface the desktop native sidecar installs BEFORE the worker
 * method layer loads: argv binding, the tjs:sqlite engine factory, the framed
 * stdio transport, the `self` global worker.js expects, and the
 * shell-originated export-to-path route (see the CONTRACT block below). The
 * lifecycle (importing worker.js, then start/flush/exit) lives in
 * native-entry.js.
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
import path from 'tjs:path';
import { createShimDatabase } from './sqljs-shim.js';
import { createStdioTransport } from './stdio-transport.js';
import { frameErrorResponse, toFrameErrorData } from './frame-codec.js';
import { decodeBoundPathArgument } from './bound-path-argument.js';

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
let boundPath;
try {
  boundPath = decodeBoundPathArgument(args[0]);
  if (!boundPath) throw new Error('database path is empty');
} catch (error) {
  console.error(`[native-worker] invalid bound path: ${error.message}`);
  tjs.exit(EXIT_USAGE);
}
const boundReadOnly = args[1] === 'ro';

// ---------------------------------------------------------------------------
// Engine factory (the worker.js seam's `__desktopNativeCreateEngine`)
// ---------------------------------------------------------------------------

// TMPDIR is the user-private temp root on macOS; Windows supplies TEMP/TMP.
// The /tmp fallback is for Unix environments without TMPDIR. makeTempDir guarantees the fresh,
// uniquely named, owner-only directory the shim's export contract requires.
const tempRoot = (tjs.env.TMPDIR ?? tjs.env.TEMP ?? tjs.env.TMP ?? '/tmp').replace(/[\\/]+$/, '');

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

/** The shell installs the pinned reader beside the executable, never at a page-supplied path. */
async function loadQueryPlanReader(db) {
  const directory = path.dirname(tjs.exePath);
  for (const name of ['query-plan.dylib', 'query-plan.so', 'query-plan.dll']) {
    const library = path.join(directory, name);
    try { await tjs.stat(library); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    // A present but incompatible library is a broken installation. Never
    // continue with the unbounded native EXPLAIN implementation after failure.
    db.backingDatabase.loadExtension(library, 'sqlite3_sqliteexplorer_init');
    return;
  }
  throw new Error('Missing bundled query-plan reader beside the native runtime.');
}

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
  try { await loadQueryPlanReader(db); }
  catch (error) {
    db.close();
    throw new Error(`Unable to initialize the bounded query-plan reader: ${error?.message ?? error}`, { cause: error });
  }

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
  return { SQL: Object.freeze({ engine: 'tjs-native', queryPlanReaderActive: true }), db };
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
// ignored. In-process captures (the shell-export route's way of calling a
// worker method without its result crossing the pipe) are checked FIRST — a
// captured response must never reach the frame codec, where its size could
// exceed the cap the whole route exists to avoid.
globalThis.postMessage = (message, _transferList) => {
  if (deliverToInProcessCapture(message)) return;
  sendGuarded(message);
};

// ---------------------------------------------------------------------------
// In-process worker-method calls (for the shell-originated export route)
// ---------------------------------------------------------------------------

/**
 * In-flight in-process response captures, keyed by internal messageId. Ids
 * carry a random suffix so a webview rpc invoke cannot predict one and race a
 * forged same-id response into a pending capture (worst case would be a
 * structurally rejected export, not a wrong file — but the suffix closes even
 * that).
 */
const inProcessCaptures = new Map();
let inProcessSequence = 0;

/** Divert a worker response to its in-process capture. True when diverted. */
const deliverToInProcessCapture = (message) => {
  if (message?.channel !== 'rpc' || message?.content?.kind !== 'response') return false;
  const capture = inProcessCaptures.get(message.content.messageId);
  if (capture === undefined) return false;
  inProcessCaptures.delete(message.content.messageId);
  capture(message.content);
  return true;
};

/**
 * Run one worker method IN PROCESS, through the worker's own dispatch
 * (`globalThis.onmessage`, i.e. worker.js's `self.onmessage`) — same envelope
 * validation, same cell-read-session guard, same error wrapping — but with
 * the response captured here instead of framed onto the pipe. worker.js posts
 * the response before its onmessage promise resolves, so the capture is
 * always settled once the await returns; a missing capture is a structural
 * failure, not a hang.
 *
 * Resolves with the response's `data`; rejects with the response's error
 * (message + code/errno restored) when the method failed.
 */
async function invokeWorkerMethodInProcess(targetMethod, args) {
  const captureId =
    `__shell_export_${++inProcessSequence}_${Math.random().toString(36).slice(2)}`;
  let captured = null;
  inProcessCaptures.set(captureId, (content) => { captured = content; });
  try {
    if (typeof globalThis.onmessage !== 'function') {
      throw new Error('worker method layer is not loaded (no onmessage handler)');
    }
    await globalThis.onmessage({
      data: {
        channel: 'rpc',
        content: { kind: 'invoke', messageId: captureId, targetMethod, payload: args }
      }
    });
  } finally {
    inProcessCaptures.delete(captureId);
  }
  if (captured === null) {
    throw new Error(`in-process ${targetMethod} completed without posting a response`);
  }
  if (captured.success !== true) {
    const error = new Error(captured.errorMessage || `${targetMethod} failed`);
    if (typeof captured.error?.code === 'string') error.code = captured.error.code;
    if (Number.isSafeInteger(captured.error?.errno)) error.errno = captured.error.errno;
    throw error;
  }
  return captured.data;
}

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

// ---------------------------------------------------------------------------
// Shell-originated export-to-path (the out-of-band large-export route)
// ---------------------------------------------------------------------------

/**
 * CONTRACT — pinned verbatim; the Tauri shell's Rust (the only legitimate
 * sender) constructs the request and matches the reply EXACTLY as follows.
 *
 * Request (shell → sidecar), one frame:
 *
 *   { "channel": "shell",
 *     "content": {
 *       "kind": "export",
 *       "messageId": <string|number>,
 *       "method": "exportDatabase" | "exportTable",
 *       "tempPath": <string>,             // shell-owned fresh path; must not exist
 *       "args": <array>                   // exportTable's positional worker args;
 *     } }                                 //   omitted/ignored for exportDatabase
 *
 * Reply (sidecar → shell), one small frame — the export BYTES never cross
 * the pipe, only this path-sized result does:
 *
 *   { "channel": "shell",
 *     "content": {
 *       "kind": "export-result",
 *       "messageId": <echoed>,
 *       "success": true,  "bytesWritten": <number> } }        on success
 *   { ... "success": false, "error": {name, message, code?, errno?} }  on failure
 *
 * SECURITY: `channel:'shell'` is the trust boundary marker. The Rust shell
 * refuses to forward a webview-built shell envelope (its L3 gate), and this
 * dispatch never routes a `{channel:'rpc'}` envelope here — so `tempPath` is
 * always a path the SHELL constructed inside its own 0700 temp directory,
 * never a webview-named one. The sidecar writes to exactly that path and
 * nothing else; on failure the partial temp is the shell's to clean up
 * (it removes the whole temp directory). `args`, by contrast, carries the
 * same webview-authored export options the rpc route already accepts —
 * exportTable treats them as untrusted exactly as it always has.
 */
async function handleShellExport(content) {
  const messageId = typeof content?.messageId === 'string' || typeof content?.messageId === 'number'
    ? content.messageId
    : null;
  if (messageId === null) {
    // Nothing to route a reply to; a trusted-sender message without an id is
    // a shell bug, and silence would strand its await.
    console.error('[native-worker] shell export request without a messageId; dropped');
    return;
  }
  try {
    const method = content.method;
    const tempPath = content.tempPath;
    if (method !== 'exportDatabase' && method !== 'exportTable') {
      throw new Error(`unknown shell export method ${JSON.stringify(method ?? null)}`);
    }
    if (typeof tempPath !== 'string' || tempPath.length === 0) {
      throw new Error('shell export request carries no tempPath');
    }

    let bytesWritten;
    if (method === 'exportDatabase') {
      if (!activeDb) throw new Error('No database initialized');
      // VACUUM INTO the shell's temp path: the image streams to disk inside
      // SQLite; no read-back, nothing held in memory, nothing framed.
      await activeDb.exportToPath(tempPath);
      bytesWritten = (await tjs.stat(tempPath)).size;
    } else {
      if (!Array.isArray(content.args)) {
        throw new Error('shell exportTable request carries no args array');
      }
      // The worker's own exportTable, run in process (its result is bounded
      // by args' maxExportBytes, held briefly here, never framed) — then its
      // chunks land at the shell's temp path. Export first, create the file
      // second: a failed export leaves no file behind.
      const result = await invokeWorkerMethodInProcess('exportTable', content.args);
      const chunks = result?.contentChunks;
      if (!Array.isArray(chunks)) {
        throw new Error('exportTable returned no contentChunks array');
      }
      bytesWritten = await writeChunksToPath(tempPath, chunks);
    }
    sendGuarded({
      channel: 'shell',
      content: { kind: 'export-result', messageId, success: true, bytesWritten }
    });
  } catch (error) {
    sendGuarded({
      channel: 'shell',
      content: {
        kind: 'export-result', messageId, success: false, error: toFrameErrorData(error)
      }
    });
  }
}

/**
 * Create `tempPath` and append each export chunk (exportTable emits strings;
 * Uint8Array accepted for future-proofing). Returns total bytes written.
 * `'wx'` = O_EXCL create: a pre-existing file at the shell's fresh temp path
 * is a protocol violation and fails closed rather than being truncated.
 */
async function writeChunksToPath(tempPath, chunks) {
  const handle = await tjs.open(tempPath, 'wx');
  let bytesWritten = 0;
  let failure = null;
  try {
    const encoder = new TextEncoder();
    for (const chunk of chunks) {
      let view;
      if (typeof chunk === 'string') view = encoder.encode(chunk);
      else if (chunk instanceof Uint8Array) view = chunk;
      else throw new Error(`exportTable produced an unwritable chunk (${typeof chunk})`);
      // pos omitted → current file offset; loop on the returned count so a
      // short write can never silently truncate the export.
      while (view.length > 0) {
        const wrote = await handle.write(view);
        if (!Number.isInteger(wrote) || wrote <= 0) {
          throw new Error(`short write to export temp file (wrote ${wrote})`);
        }
        bytesWritten += wrote;
        view = view.subarray(wrote);
      }
    }
    // The success reply asserts the bytes ARE in the file; make that hold
    // across a crash too — the shell renames this file into place next.
    await handle.sync();
    return bytesWritten;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      // Never mask the original failure with a close failure; a close failure
      // after a clean sync IS the caller's error, though.
      if (failure === null) throw closeError;
      console.error(
        `[native-worker] failed to close export temp file: ${closeError?.message ?? closeError}`
      );
    }
  }
}

// Dispatch: shell-originated messages are routed to the shell-export handler
// (and ONLY messages already marked `channel:'shell'` — an rpc envelope can
// never become a shell export, whatever its content claims); exportDatabase
// invokes are intercepted; everything else flows to the unchanged worker
// method layer (its `self.onmessage` assignment — the globalThis read below).
// Async (and try/caught) so no malformed envelope or handler failure can
// throw synchronously into the transport's read loop — a dispatch-level
// failure answers in band instead. worker.js has registered its onmessage by
// the time any frame can arrive: native-entry.js imports it before calling
// transport.start().
transport.onmessage = async (event) => {
  const envelope = event?.data;
  try {
    if (envelope?.channel === 'shell') {
      if (envelope.content?.kind === 'export') {
        await handleShellExport(envelope.content);
      } else {
        // Trusted sender, unknown kind: version skew. There is no defined
        // reply shape for it, so say so where the shell's logs can see it.
        console.error(
          `[native-worker] unknown shell message kind ${JSON.stringify(envelope.content?.kind ?? null)}; dropped`
        );
      }
      return;
    }
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
    // The code is named in the breadcrumb because an orphaned process reparents
    // to the OS reaper (launchd/init), so its real wait-status is not reap-able
    // by any surviving relative — the log line is the only channel that carries
    // the numeric exit code out.
    console.error(
      `[native-worker] parent process ${bootPpid} vanished without closing ` +
      `stdin (ppid now ${tjs.ppid}); exiting (code ${EXIT_ORPHANED})`
    );
    tjs.exit(EXIT_ORPHANED);
  }
}, PPID_WATCHDOG_INTERVAL_MS);
