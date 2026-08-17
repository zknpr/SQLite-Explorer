/**
 * Desktop native sidecar entry point. Bundled by `bundleDesktopNativeWorker`
 * (scripts/build.mjs) into `desktop/native-worker-desktop.js` and run inside
 * the pinned txiki fork:
 *
 *     tjs run native-worker-desktop.js <dbPath> ro|rw
 *
 * It is the SAME worker method layer the WASM engine uses —
 * website/src/sqlite-viewer/worker.js, byte-untouched apart from its engine
 * seam — executed over the sql.js-shaped `tjs:sqlite` shim
 * (core/native/sqljs-shim.js) and the framed-JSON stdio transport
 * (core/native/stdio-transport.js) instead of WebAssembly and postMessage.
 * The runtime surface (argv binding, engine factory, transport, the `self`
 * global, the ppid watchdog) is native-host.js; this module owns only the
 * lifecycle: host, then worker, then read-until-shutdown.
 *
 * ARGV CONTRACT (the Rust spawn in the Tauri shell must reproduce this
 * verbatim; the sidecar sees it as `tjs.args.slice(3)` — no `--` separator):
 *
 *   argv[0]  absolute canonical path of the ONLY database file this process
 *            may open, passed as a single argument with no quoting or
 *            escaping layer. Compared by exact string equality — the shell
 *            canonicalises, the sidecar does not.
 *   argv[1]  the literal string `ro` (read-only session) or `rw` (writable).
 *            Required: an omitted or unknown token is a spawn bug and fails
 *            closed with the usage exit rather than defaulting to writable.
 *
 * EXIT CODES:
 *   0  stdin EOF — clean shutdown, and the primary orphan signal (parent
 *      died and the pipe collapsed).
 *   1  transport fatality: frame-stream desync or stdin stream error. The
 *      in-band error frame is flushed first; exiting closes the pipe so the
 *      parent sees EPIPE/EOF instead of blocking against a deaf-alive peer.
 *   2  usage error — malformed argv; nothing was opened.
 *   3  orphaned without EOF — the ppid watchdog saw the parent vanish while
 *      stdin stayed open (write end inherited elsewhere). Abnormal death.
 */

import { transport, getShutdownReason, EXIT_CLEAN, EXIT_TRANSPORT_FATAL } from './native-host.js';

// Dynamic on purpose: worker.js's module body reads the `self` global the
// host just installed, and a static import would hoist above the host's
// initialisation. Loaded before transport.start(), so no frame can ever
// arrive ahead of the worker's onmessage registration.
await import('../../website/src/sqlite-viewer/worker.js');

// start() resolves when reading stops, whatever stopped it. flush() first so
// a queued in-band error frame reaches the parent before the pipe closes.
// Exiting is REQUIRED on every path — it is what turns a dead sidecar into
// EPIPE/EOF at the parent instead of an indefinite block — and the exit code
// is the only signal that distinguishes a desync death from a clean EOF.
await transport.start();
await transport.flush();
const shutdownReason = getShutdownReason();
if (shutdownReason.kind === 'eof') tjs.exit(EXIT_CLEAN);
console.error(
  `[native-worker] shutting down: ${shutdownReason.kind} -- ` +
  `${shutdownReason.error?.message ?? ''}`
);
tjs.exit(EXIT_TRANSPORT_FATAL);
