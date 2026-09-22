/**
 * Desktop host — owns the open databases, their engines, undo/redo history,
 * settings, and file I/O for the Tauri desktop build. The webview page IS the
 * host (no iframe), so desktop-api.js calls invoke() directly; the only
 * serialization boundaries are worker postMessage (structured clone) and the
 * shell bridge.
 *
 * N databases are open at once. Each is a `DbEntry` in the registry below with
 * its OWN engine instance (a `Worker` for WASM, a shell-issued sidecar id for
 * native), its own undo history, its own session transaction, and its own
 * snapshot of the viewer's per-database UI state. Every existing host method
 * operates on the ACTIVE entry, so the viewer's call sites are unchanged.
 */
import {
    WEBVIEW_TRANSPORT_SURFACES,
    assertWebviewTransportPayload
} from './transport.js';
// The native transport's value codec. The sidecar's stdio transport encodes
// response envelopes with exactly this codec (BigInt/Uint8Array/Error markers,
// ~-escaped scalar sentinels), and the Rust proxy forwards the payload JSON
// verbatim — importing the same module keeps the two ends incapable of drift.
import { MAX_FRAME_BYTES, decodeFrameValue, encodeFrameValue } from '../../native/frame-codec.js';
import { createPerDbStateSnapshot, restorePerDbState, snapshotPerDbState } from './db-ui-state.js';
import { ModificationTracker, estimateUndoMemoryBytes } from '../../../src/core/undo-history.ts';
// The worker reports its typed cell-edit refusals as structured `error` data
// beside the message; rebuilding the typed error is what lets desktop-api.js
// re-enter the oversized-replacement confirmation instead of failing the edit.
import { fromCellEditRpcErrorData } from '../../../src/core/cell-edit-policy.ts';
// The typed refusal the VS Code host raises when a native handle no longer
// names the file the user opened; the desktop raises the same one so the shared
// UI's Reload Database flow (state.reloadRequiredReason) reads identically.
import { DatabaseFileChangedError } from '../../../src/core/database-file-changed.ts';

const DEFAULT_SETTINGS = Object.freeze({
    // MiB. Enforced by the SHELL at open on BOTH engines (native_open and
    // read_database_bytes both refuse a larger file before spawning or
    // reading anything), like the VS Code host's maxFileSize, which refuses
    // before choosing an engine: a user-selected limit that changing engine
    // cannot lift. The desktop's default is the setting's ceiling
    // (MAX_FILE_SIZE_MB) rather than the extension's 200: its primary engine
    // maps the file instead of inhaling it, so a 400 MiB database is the
    // flagship case, not the failure case. 0 = unlimited.
    maxFileSize: 4000,
    defaultPageSize: 5000,
    instantCommit: 'never',
    doubleClickBehavior: 'inline',
    fileOperations: 'native',
    queryTimeout: 30000,
    maxInlineCellBytes: 1048576,
    // 0 = "never dragged"; initSidebarResize keeps its own default then.
    sidebarWidth: 0,
    maxUndoMemory: 52428800,
    theme: 'system',
    // SQL console history, newest first (see `pushHistory` in the console
    // module: capped at 50 entries of <=4096 chars). Frozen because
    // Object.freeze is shallow — without it a caller mutating the array in
    // place would corrupt the default for the whole session.
    consoleHistory: Object.freeze([])
});

// Worker methods whose successful result must be recorded for undo. The
// worker replays cell and row history as exact-state compare-and-swaps, so
// every entry here has to carry the stored states the worker captured:
// `updateCell` and `insertRow` are therefore never sent as themselves —
// `invoke` routes them through `updateCellBatch` / `insertRowWithHistory`,
// the two methods that return those states (the route hostBridge.ts takes in
// VS Code). DDL and pragma changes cannot be replayed at all, so they insert
// barriers instead (undo stops there until the next save).
const UNDOABLE_METHODS = new Set([
    'updateCellBatch', 'insertRowWithHistory', 'importRows', 'deleteRows',
    'createView', 'editView', 'dropView'
]);
const BARRIER_METHODS = new Set([
    'addColumn', 'deleteColumns', 'createTable', 'setPragma', 'replaceOversizedCell',
    // No live webview call site invokes insertRowBatch today; barrier-by-default
    // keeps dirty-tracking honest until someone designs its undo/redo replay.
    'insertRowBatch'
]);

// The web demo's 16 MiB export cap is a browser-download-path policy (the
// worker RPC can't stream), not a native limit here: the desktop already
// moves whole DB images through saveToDisk. exportTable below assembles the
// chunked result with join('') then re-encodes it with TextEncoder, which
// momentarily holds both the joined string and its encoded bytes at once —
// 512 MiB keeps that worst case to ~1 GiB in-page, matching the worker's own
// 1 GiB hard sanity ceiling on maxExportBytes.
const DESKTOP_EXPORT_MAX_BYTES = 512 * 1024 * 1024;

// The largest importRows ANSWER the native sidecar may return. Its response
// crosses the stdio frame, which the transport caps at MAX_FRAME_BYTES and
// refuses in band when exceeded — AFTER the worker has released the import's
// savepoint. Rows committed inside the session transaction with no history
// entry to undo them is the one outcome the import must never produce, so the
// worker measures its answer against this cap BEFORE releasing (worker.js
// assertImportSnapshotsWithinBudgets) and rolls the import back instead. The
// margin covers the response envelope and the estimate's own slack; the WASM
// worker's structured clone has no frame, so it gets no cap here (the shared
// aggregate ceiling still applies inside the worker).
const NATIVE_IMPORT_RESULT_BYTES = MAX_FRAME_BYTES - 2 * 1024 * 1024;

// Rust canonicalization returns Windows extended paths; native dialogs return
// ordinary drive/UNC paths. Compare those equivalent spellings without changing
// the path sent to the shell. Verbatim-only names must stay distinct: Win32 trims
// trailing dots/spaces and interprets reserved device names in ordinary paths.
function databasePathKey(path) {
    if (typeof path !== 'string') return path;
    let ordinary;
    if (path.startsWith('\\\\?\\UNC\\')) ordinary = '\\\\' + path.slice(8);
    else if (/^\\\\\?\\[A-Za-z]:\\/.test(path)) ordinary = path.slice(4);
    else return path;
    const parts = ordinary.replace(/^[A-Za-z]:\\/, '').split('\\').filter(Boolean);
    if (parts.some(part => /[ .]$|[<>:"|?*]/.test(part)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return path;
    return ordinary;
}

const STARTUP_DB_NAME = 'untitled.db';

/** The largest maxFileSize a user can express, in MiB (src/config.ts MAX_FILE_SIZE_MB). */
const MAX_FILE_SIZE_MB = 4000;
const MIB = 1024 * 1024;

// Structured refusals the shell answers with a stable code prefix. The host
// branches on the code; the user sees the sentence after it.
const SHELL_ERROR_CODE = /^ERR_[A-Z_]+:\s*/;
const errorText = (error) => String(error?.message ?? error);
const shellErrorText = (error) => errorText(error).replace(SHELL_ERROR_CODE, '');
const isShellError = (error, code) => {
    const text = errorText(error);
    return text === code || text.startsWith(`${code}:`);
};
/** The configured maxFileSize refusal, with the shell's sentence and a stable code for callers. */
const sizeRefusal = (error) => Object.assign(
    new Error(shellErrorText(error), { cause: error }),
    { code: 'ERR_FILE_TOO_LARGE' }
);

// The two host methods a RETIRED database (its engine is gone — see
// retireEntry) still answers: one reports the reason, the other is the
// recovery. Every engine-bound method throws the reason instead.
const RETIRED_ENTRY_METHODS = new Set(['initialize', 'refreshFile']);

/**
 * How many databases may be open at once.
 *
 * Every open database costs a whole engine: a WASM one is its own `Worker`
 * holding its own full copy of the file in memory, a native one is its own
 * sidecar process. Nothing bounded the WASM lane — the shell caps native
 * sidecars at 16 (`MAX_NATIVE_SIDECARS`, src-tauri/src/native.rs), and once
 * tabs made opening a one-click habit an unbounded registry was one held ⌘O
 * away from N workers and N copies of the data.
 *
 * The number is deliberately the SHELL's: one cap for both engines means the
 * refusal never depends on which engine served the open, and a native open
 * can't be silently downgraded to WASM by hitting the shell's cap first (a
 * failed `nativeOpen` falls back to bytes on purpose — see tryOpenNative).
 * Enforced at the two lanes that CREATE an entry, after the dedupe, so
 * switching to an already-open file always works at the cap.
 */
export const MAX_OPEN_DATABASES = 16;

export function createDesktopHost({ bridge, createWorker }) {
    // ---- app-global state ---------------------------------------------------
    // Everything here is app-wide by design: one settings store, one webview,
    // one pending-call map. Anything that belongs to a single open database
    // lives on its DbEntry instead.
    let settings = { ...DEFAULT_SETTINGS };
    let webviewMethods = {};

    let messageCounter = 0;
    // ONE map for every open database and both transports. Ids are globally
    // unique; each entry is tagged with the `dbId` that issued it (and the
    // transport that will answer it) so a response, a worker crash, or a
    // sidecar death can only ever settle or fail its OWN database's calls.
    const pendingCalls = new Map();

    // ---- the registry -------------------------------------------------------
    /** @type {Map<string, object>} dbId -> DbEntry */
    const databases = new Map();
    /** @type {Map<string, Promise<boolean>>} in-flight opens, by requested path */
    const openRequests = new Map();
    /**
     * Opens that have passed the {@link MAX_OPEN_DATABASES} check but have not
     * put their entry in `databases` yet. Counted by the cap so concurrent
     * opens cannot all pass a check against a registry that is still short —
     * see assertRoomForAnotherDatabase.
     */
    let openingEntries = 0;
    let activeId = null;
    let dbIdCounter = 0;

    // Host-issued registry key. Deliberately NOT the shell's native DbId: that
    // token names a sidecar and only exists for native entries, while this one
    // names an open document of either engine. The `db#` spelling cannot be
    // confused with the shell's `db_<n>` in a log line.
    const nextDbId = () => `db#${++dbIdCounter}`;

    const activeEntry = () => (activeId === null ? null : databases.get(activeId) ?? null);

    function requireActiveEntry() {
        const entry = activeEntry();
        if (!entry) throw new Error('No database is open (host.start() has not completed)');
        return entry;
    }

    /**
     * @param {object} init
     * @returns {object} a DbEntry — the complete per-database state.
     */
    function createEntry({ engine, nativeDbId, nativeBoundPath, currentPath, currentName, isScratch }) {
        const dbId = nextDbId();
        return {
            dbId,
            engine,
            // WASM: this database's own Worker (its own sql.js instance and its
            // own in-memory image). Native: null — the engine lives in a
            // sidecar process the shell owns.
            worker: null,
            // The shell's opaque sidecar token. Passed back VERBATIM to
            // nativeRpc/nativeClose/nativeExport*; never constructed or parsed
            // here, never reused after close.
            nativeDbId: nativeDbId ?? null,
            // Canonical path this sidecar is bound to (nativeOpen's RETURNED
            // boundPath — layer 3 and the sidecar compare exact strings, so
            // reopen/refresh must reuse this spelling, never the user's).
            nativeBoundPath: nativeBoundPath ?? null,
            tracker: new ModificationTracker(100, settings.maxUndoMemory),
            connectionInfo: { isReadOnly: false },
            // Advances on every (re)initialisation of this database's engine
            // session — open, refresh, fallback — and rides every connection
            // result. The page's async intents (a confirmation left open, an
            // in-flight edit) capture it and refuse to complete against a
            // replaced connection; the VS Code host reports its document
            // generation the same way. Per entry, because each open database
            // is its own connection: a global counter would let a reload of
            // one database invalidate what another's modal captured.
            connectionGeneration: 0,
            // Set when this database's connection was RETIRED: the shell
            // refused an envelope because the file the sidecar was bound to
            // is no longer the file at that path (device/inode differ), or a
            // reopen failed. The engine is gone (worker/nativeDbId null), the
            // history was discarded, and every engine-bound method answers
            // with this error until refreshFile reopens the file — the page
            // shows its message beside a Reload Database button
            // (state.reloadRequiredReason). Null while the connection is live.
            invalidatedError: null,
            currentPath: currentPath ?? null,   // absolute path on disk (null = no write-back target)
            currentName: currentName,
            // The session transaction: the native engine executes against the
            // REAL file, so "edits are pending until Save" is SQLite's own
            // transaction — first mutation BEGINs, Save COMMITs, refresh/close
            // ROLLBACK. WASM gets the same contract from its in-memory image.
            nativeTxnOpen: false,
            // Replica of the worker dispatch's cell-read-session guard, tracked
            // here because the sidecar serves exportDatabase ABOVE that guard:
            // the host refuses native exports while a session is open, with the
            // worker's own message, so both engines answer identically.
            cellReadSessionOpen: false,
            // The boot placeholder: an empty in-memory database nobody asked
            // for. Replaced (not accumulated) by the first real open.
            isScratch: isScratch === true,
            // This database's slice of the viewer's `state` singleton, parked
            // here while another database is active. See setActiveDb. `dbId` is
            // stamped into it so asynchronous UI work can tell which database
            // the state it is about to commit into was fetched for.
            uiState: { ...createPerDbStateSnapshot(), dbId }
        };
    }

    const hasNativeBridge = () =>
        typeof bridge.nativeAvailable === 'function'
        && typeof bridge.nativeOpen === 'function'
        && typeof bridge.nativeRpc === 'function'
        && typeof bridge.nativeClose === 'function';

    /**
     * The configured open bound in BYTES, 0 meaning unlimited — the value both
     * shell open paths receive. settings.json is webview-writable and may hold
     * anything: a non-number, NaN, Infinity or a negative value would disable
     * every `size > limit` comparison, so those fall back to the default
     * (src/config.ts getMaximumFileSizeBytes applies the same rule), and the
     * ceiling is the largest value the setting can express.
     */
    function maxFileSizeBytes() {
        const configured = settings.maxFileSize;
        if (typeof configured !== 'number' || !Number.isFinite(configured) || configured < 0) {
            return DEFAULT_SETTINGS.maxFileSize * MIB;
        }
        return Math.min(configured, MAX_FILE_SIZE_MB) * MIB;
    }

    /** The reload-required half of a connection result — present only for a retired entry. */
    const reloadRequired = (entry) => (
        entry.invalidatedError ? { reloadRequiredReason: entry.invalidatedError.message } : {}
    );

    // ---- worker RPC ---------------------------------------------------------

    /**
     * Shared response routing for BOTH transports and every open database —
     * one pending map, one settle path, whichever side produced the envelope.
     * `sourceDbId` is the database whose transport delivered it.
     */
    function settleFromEnvelope(envelope, sourceDbId) {
        if (envelope?.channel !== 'rpc' || envelope.content?.kind !== 'response') return;
        const { messageId, success, data, errorMessage, error } = envelope.content;
        const pending = pendingCalls.get(messageId);
        if (!pending) return;
        if (pending.dbId !== sourceDbId) {
            // A transport answered with another database's messageId. Refusing
            // (rather than settling) is the fail-closed choice: no engine may
            // ever hand a different database's caller its rows. The call stays
            // pending and settles from its own transport — or dies with its own
            // database's fanout.
            console.warn(
                `Refused a ${pending.method} response delivered by ${sourceDbId}: `
                + `the call belongs to ${pending.dbId}`
            );
            return;
        }
        pendingCalls.delete(messageId);
        if (success) pending.resolve(data);
        else {
            pending.reject(
                fromCellEditRpcErrorData(error)
                ?? new Error(errorMessage || `Worker call failed: ${pending.method}`)
            );
        }
    }

    function rejectPending(messageId, error) {
        const pending = pendingCalls.get(messageId);
        if (!pending) return;
        pendingCalls.delete(messageId);
        pending.reject(error);
    }

    /** Fails every in-flight call belonging to ONE database, and only those. */
    function failEntryPendingCalls(entry, error) {
        for (const [messageId, pending] of [...pendingCalls]) {
            if (pending.dbId !== entry.dbId) continue;
            pendingCalls.delete(messageId);
            pending.reject(error);
        }
    }

    function bootWorkerFor(entry) {
        entry.worker = createWorker();
        entry.worker.onmessage = (event) => settleFromEnvelope(event.data, entry.dbId);
        entry.worker.onerror = (error) => {
            const failure = new Error(`Worker crashed: ${error?.message ?? error}`);
            // Only THIS database's WASM calls die with THIS worker. The pending
            // map is shared across every open database and both transports:
            // another database's worker call, and any in-flight native RPC
            // alive on bridge.nativeRpc, must settle from their own responses
            // rather than be spuriously failed by this crash.
            for (const [messageId, pending] of [...pendingCalls]) {
                if (pending.dbId !== entry.dbId || pending.transport !== 'wasm') continue;
                pendingCalls.delete(messageId);
                pending.reject(failure);
            }
        };
    }

    function callWorker(entry, method, args, { maxBinaryBytes, transfer } = {}) {
        // A retired connection answers every call with the reason it was
        // retired (the VS Code host rethrows its invalidated error the same
        // way) — never "closed", which would read as a host bug.
        if (entry.invalidatedError) throw entry.invalidatedError;
        // Refuse BEFORE a pending entry is registered. A closed database's
        // transport is gone (worker terminated / sidecar id surrendered), and
        // discovering that inside the Promise executor below would reject the
        // caller while leaving its entry stranded in the shared pending map
        // forever. Reachable when work started before a close awakes after it.
        if (entry.engine === 'native' ? entry.nativeDbId === null : entry.worker === null) {
            throw new Error(
                `Cannot run ${method}: the database "${entry.currentName}" is closed`
            );
        }
        const messageId = `rpc_${++messageCounter}_${Date.now()}`;
        const message = {
            channel: 'rpc',
            content: { kind: 'invoke', messageId, targetMethod: method, payload: args }
        };
        assertWebviewTransportPayload(message, {
            surface: WEBVIEW_TRANSPORT_SURFACES.demoWorkerRequest,
            ...(maxBinaryBytes ? { maxBinaryBytes } : {})
        });
        // Encode before registering the pending entry so a codec failure (like
        // the assertion above) throws to the caller instead of stranding an
        // entry in the map. Transfer lists don't apply to JSON — the only
        // transfer-bearing call is the WASM bytes open, which never runs native.
        const nativeJson = entry.engine === 'native'
            ? JSON.stringify(encodeFrameValue(message))
            : null;
        return new Promise((resolve, reject) => {
            pendingCalls.set(messageId, {
                method,
                // Tags the OWNER of this entry: which database issued it, and
                // which transport will answer it. Both are consulted before any
                // settle or fanout.
                dbId: entry.dbId,
                transport: nativeJson !== null ? 'native' : 'wasm',
                resolve,
                reject
            });
            if (nativeJson !== null) {
                // The sidecar is addressed by its shell-issued id, never by
                // "whatever is current" — that is what keeps DB-A's path-less
                // envelopes (runQuery, mutations, undo) off DB-B's connection.
                bridge.nativeRpc(entry.nativeDbId, nativeJson).then(
                    (responseJson) => {
                        let envelope;
                        try {
                            envelope = decodeFrameValue(JSON.parse(responseJson));
                        } catch (error) {
                            rejectPending(messageId, new Error(
                                `Native RPC response for ${method} is undecodable: ${error?.message ?? error}`
                            ));
                            return;
                        }
                        settleFromEnvelope(envelope, entry.dbId);
                        // The Rust proxy routes by dbId + messageId, so the
                        // response is ours; if it somehow wasn't, fail this call
                        // loudly rather than hanging it (no-op after a normal
                        // settle).
                        rejectPending(messageId, new Error(
                            `Native RPC response for ${method} did not settle its own call `
                            + '(foreign messageId or database)'
                        ));
                    },
                    (error) => {
                        const failure = error instanceof Error ? error : new Error(String(error));
                        if (isShellError(failure, 'ERR_NATIVE_FILE_CHANGED')) {
                            // The shell refused to forward: the file at the
                            // bound path is not the file this sidecar opened.
                            // Retire synchronously-first so the caller's own
                            // failure handling (the txn reconcile probe
                            // included) sees a retired entry rather than
                            // racing another envelope at the dead sidecar.
                            const changed = new DatabaseFileChangedError({ cause: failure });
                            retireEntry(entry, changed).catch(retireError => {
                                console.warn('Retiring a replaced database failed:', retireError);
                            });
                            rejectPending(messageId, changed);
                            return;
                        }
                        rejectPending(messageId, failure);
                    }
                );
            } else if (transfer?.length) {
                entry.worker.postMessage(message, transfer);
            } else {
                entry.worker.postMessage(message);
            }
        });
    }

    async function initializeWorkerDatabase(entry, name, config) {
        const fullConfig = { queryTimeout: settings.queryTimeout, ...config };
        // Database bytes may legitimately exceed the standard 16 MiB inline cap;
        // bound them by the user's maxFileSize setting instead (0 = unlimited).
        // The shell already refused a larger read; this is the in-page belt.
        const capBytes = maxFileSizeBytes() || Number.MAX_SAFE_INTEGER;
        const transfer = fullConfig.content ? [fullConfig.content.buffer] : undefined;
        const result = await callWorker(entry, 'initializeDatabase', [name, fullConfig], {
            maxBinaryBytes: capBytes,
            transfer
        });
        entry.connectionInfo = { isReadOnly: result?.isReadOnly === true, readOnlyReason: result?.readOnlyReason };
        entry.connectionGeneration += 1;
        entry.tracker = new ModificationTracker(100, settings.maxUndoMemory);
        // initializeDatabase closes any open cell read session worker-side and
        // opens a fresh engine session with no transaction.
        entry.cellReadSessionOpen = false;
        entry.nativeTxnOpen = false;
        return result;
    }

    // ---- native session transaction -----------------------------------------
    // BEGIN/COMMIT/ROLLBACK travel as ordinary runQuery envelopes: the worker's
    // method layer has no transaction method, the shim blocks only
    // ATTACH/DETACH/VACUUM INTO, and worker.js's own mutations use SAVEPOINTs
    // exclusively, which nest cleanly inside the session transaction.
    //
    // The console can run raw transaction SQL underneath the host (a script
    // containing BEGIN or COMMIT), so both helpers tolerate exactly the two
    // "already in that state" engine answers and adopt reality instead of
    // failing the user's action; every other failure propagates.

    // Engine answers meaning "a transaction is already open" for a bare
    // BEGIN. Classic engines answer contextually ("cannot start a transaction
    // within a transaction"); the fork's messages are per-errno generic
    // strings (sqlite3_errstr) and errno never crosses the RPC wire — probed
    // ground truth from the bundled binary: nested BEGIN, txn-less
    // COMMIT/ROLLBACK and even missing tables ALL answer "SQL logic error"
    // (errno 1). Matching that generic string is sound ONLY because the SQL
    // tested here is the fixed literal 'BEGIN', whose sole errno-1 failure
    // mode is the transaction-nesting refusal. Never reuse this pattern for
    // any other statement's errors.
    const BEGIN_ALREADY_IN_TXN = /within a transaction|SQL logic error/i;

    /**
     * Asks the engine whether a transaction is open, via a bare deferred
     * BEGIN (SQLite has no SQL-level autocommit introspection). BEGIN success
     * means autocommit was active; the empty probe transaction is closed
     * straight back out (a deferred BEGIN acquires no locks and wrote
     * nothing, so that COMMIT cannot fail for busy/IO reasons). The nesting
     * refusal means a transaction is open — and the failed BEGIN changed no
     * state. Anything else (transport, sidecar death) propagates.
     */
    async function probeTxnOpen(entry) {
        try {
            await callWorker(entry, 'runQuery', ['BEGIN']);
        } catch (error) {
            if (!BEGIN_ALREADY_IN_TXN.test(error?.message ?? '')) throw error;
            return true;
        }
        try {
            await callWorker(entry, 'runQuery', ['COMMIT']);
        } catch (error) {
            // Unreachable for an empty deferred transaction short of a dying
            // engine — but if it happens, a transaction IS now open: record
            // that truthfully before propagating.
            entry.nativeTxnOpen = true;
            throw error;
        }
        return false;
    }

    async function ensureSessionTxn(entry) {
        if (entry.engine !== 'native' || entry.nativeTxnOpen) return;
        try {
            await callWorker(entry, 'runQuery', ['BEGIN']);
        } catch (error) {
            // A console script may have left a transaction open — adopt it.
            // Any other failure propagates and the mutation never executes.
            if (!BEGIN_ALREADY_IN_TXN.test(error?.message ?? '')) throw error;
        }
        entry.nativeTxnOpen = true;
    }

    /** @param {'COMMIT' | 'ROLLBACK'} statement */
    async function endSessionTxn(entry, statement) {
        if (entry.engine !== 'native' || !entry.nativeTxnOpen) return;
        try {
            await callWorker(entry, 'runQuery', [statement]);
        } catch (error) {
            // Three failure families share this catch and MUST diverge: "no
            // transaction is active" (a console script already closed the
            // session underneath — tolerate, nothing left to end); a genuine
            // failure with the transaction KEPT open (SQLite's default —
            // flag stays true so the user can retry); and a genuine COMMIT
            // failure where the engine ROLLED THE TRANSACTION BACK itself
            // (documented for SQLITE_FULL/IOERR/NOMEM/INTERRUPT — and
            // autocommit-after-a-failed-COMMIT is the documented way to
            // DETECT it). Classic engines separate the first by message; for
            // the rest the ENGINE state decides: probe says open ⇒ retryable
            // genuine failure; probe says autocommit ⇒ depends on intent.
            if (!/no transaction is active/i.test(error?.message ?? '')) {
                if (await probeTxnOpen(entry)) throw error;
                if (statement === 'COMMIT') {
                    // Auto-rollback: the engine DISCARDED the session's
                    // pending changes while failing the save. Reporting
                    // success here (checkpoint, clean title) would silently
                    // lose them — the save must fail loudly, and the grid
                    // must stop showing values that no longer exist.
                    entry.nativeTxnOpen = false;   // nothing left to commit against
                    try {
                        await refreshUi(entry);
                    } catch (uiError) {
                        console.warn('Post-auto-rollback UI refresh failed:', uiError);
                    }
                    const rolledBack = new Error(
                        'COMMIT failed and SQLite rolled the transaction back — '
                        + `the pending changes were discarded, not saved (${error?.message ?? error})`
                    );
                    rolledBack.cause = error;
                    throw rolledBack;
                }
                // ROLLBACK: the discard intent was fulfilled by the engine's
                // own rollback — tolerate and fall through.
            }
        }
        entry.nativeTxnOpen = false;
    }

    /**
     * Post-console flag reconciliation. The console is the ONE path raw SQL
     * reaches the engine (no UI module issues runQuery; the sidecar's own
     * methods are SAVEPOINT-only), and a script's bare COMMIT/ROLLBACK/END
     * changes the engine's autocommit state while reporting mutated:false —
     * so nothing above would notice. A stale-true flag is the dangerous
     * direction: ensureSessionTxn would early-return and every later grid
     * mutation would autocommit straight into the user's real file
     * (persist-without-Save), while a later Save would "succeed" through the
     * COMMIT tolerance path writing nothing. After every console run the flag
     * is therefore re-derived from the engine's actual state.
     */
    async function reconcileConsoleTxnState(entry) {
        if (entry.engine !== 'native') return;
        entry.nativeTxnOpen = await probeTxnOpen(entry);
    }

    /**
     * Post-mutation-failure reconciliation — the grid twin of endSessionTxn's
     * COMMIT auto-rollback branch. An abort-class failure inside the session
     * transaction (SQLITE_FULL/IOERR/NOMEM, or SQLITE_INTERRUPT from the
     * sidecar's query deadline) rolls the WHOLE transaction back while the
     * mutation rejects, discarding every pending edit underneath the flag.
     * Stale-true is the dangerous direction: the grid keeps showing the
     * discarded (phantom) edits, and the NEXT edit's ensureSessionTxn
     * early-returns, so its SAVEPOINT/RELEASE commits straight into the real
     * file (persist-without-Save) — a later discard's txn-less ROLLBACK then
     * no-ops. The fork's per-errno generic messages make string
     * classification impossible, so the ENGINE decides via the usual probe:
     * still open ⇒ statement-level failure, edits so far remain validly
     * pending, flag stays true; autocommit ⇒ adopt engine truth — flag,
     * tracker, title and grid all reset to the last-saved state. No replay
     * of the discarded edits into a fresh transaction (and no
     * rollbackToCheckpoint redo-stack resurrection of them): safe-and-honest
     * over clever-and-risky — the user redoes from a known-good state.
     * Never throws by design: the ORIGINAL mutation error is what the user
     * needs — secondary probe/refresh failures are logged, never propagated.
     */
    async function reconcileTxnAfterMutationFailure(entry) {
        // A retired connection has no engine to probe and no pending edits
        // left to describe — the retirement already reset both.
        if (entry.invalidatedError) return;
        if (entry.engine !== 'native' || !entry.nativeTxnOpen) return;
        try {
            if (await probeTxnOpen(entry)) return;
        } catch (probeError) {
            // Unclassifiable (transport death; or the probe's own COMMIT
            // failed, which already re-marked the flag true). Keep the
            // pending state — if the sidecar is gone every later call fails
            // loudly anyway, and the next probe path re-derives the flag.
            console.warn('Post-mutation-failure txn probe failed:', probeError);
            return;
        }
        // Auto-rollback: the engine discarded the whole session transaction.
        entry.nativeTxnOpen = false;
        entry.tracker = new ModificationTracker(100, settings.maxUndoMemory);
        updateTitle();
        try {
            await refreshUi(entry);
        } catch (uiError) {
            console.warn('Post-auto-rollback UI refresh failed:', uiError);
        }
    }

    /**
     * callWorker for mutation-bearing methods: any rejection runs the txn
     * reconcile above before the ORIGINAL error propagates, netted so
     * nothing secondary can displace the error the user needs. EVERY native
     * mutation path must ride this — grid mutations, the barrier DDL/pragma
     * lane, and the undo/redo replays (which layer their history
     * compensation outside, keyed on tracker identity). The console lane is
     * the deliberate exception: execution-phase script errors RESOLVE by
     * design (worker runConsole), so it reconciles on the resolve path via
     * reconcileConsoleTxnState instead.
     */
    async function callMutationGuarded(entry, method, args) {
        try {
            return await callWorker(entry, method, args);
        } catch (error) {
            // The failure may have taken the whole session transaction with
            // it — reconcile BEFORE the error surfaces so the grid the user
            // sees next tells the truth.
            try {
                await reconcileTxnAfterMutationFailure(entry);
            } catch (reconcileError) {
                console.warn('Txn reconciliation after a failed mutation failed:', reconcileError);
            }
            throw error;
        }
    }

    // ---- modification recording --------------------------------------------

    function buildModification(method, args, result) {
        switch (method) {
            case 'updateCellBatch': {
                const [table, updates, label] = args;
                const summaryLabel = label || `Edit ${updates.length} cells`;
                // Build affectedCells from the worker's authoritative
                // CellUpdateResult[] (result), not the caller's request array
                // (updates/args[1]). The worker re-reads priorValue from the row
                // at update time and computes newRowId only when a primary-key
                // member actually changed — the caller's originalValue can be
                // stale and args never carries a newRowId concept at all. The
                // rowid-table path never reports newRowId (CellUpdateResult in
                // src/core/types.ts: "Identity to use after the update when a PK
                // member changed"); default to the unchanged rowId there,
                // matching undoModification's own `cell.newRowId ?? cell.rowId`.
                // `priorState`/`postState` are the exact stored states the
                // worker read around the write; its replay refuses an entry
                // without them (LegacyCellHistoryError), which is why
                // single-cell edits ride this method too (see UNDOABLE_METHODS).
                return {
                    label: summaryLabel,
                    description: summaryLabel,
                    modificationType: 'cell_update',
                    targetTable: table,
                    affectedCells: result.map(r => ({
                        rowId: r.rowId,
                        newRowId: r.newRowId ?? r.rowId,
                        columnName: r.columnName,
                        priorValue: r.priorValue,
                        newValue: r.newValue,
                        priorState: r.priorState,
                        postState: r.postState,
                        operation: r.operation
                    }))
                };
            }
            case 'insertRowWithHistory': {
                const [table] = args;
                // `result` is the worker's post-image of the inserted row
                // ({rowId, row, storageClasses}, captured inside the insert's
                // own savepoint). Undo deletes it by exact state and redo
                // re-inserts it by exact state, so the record carries that
                // image rather than the caller's request data.
                return {
                    label: 'Insert row',
                    description: 'Insert row',
                    modificationType: 'row_insert',
                    targetTable: table,
                    targetRowId: result.rowId,
                    rowData: result.row,
                    insertedRow: result
                };
            }
            case 'importRows': {
                const [table] = args;
                // `result.snapshots` is the worker's compact post-image set of
                // every row the import inserted (the column list once, storage
                // class patterns deduplicated, values per row), read inside the
                // import's own savepoint. It rides a `row_insert` entry as
                // `importedRows`: undo deletes those exact states in reverse
                // order and redo re-inserts them — one entry, however many rows.
                const count = result.rowCount;
                return {
                    label: `Import ${count} rows`,
                    description: `Import ${count} rows into ${table}`,
                    modificationType: 'row_insert',
                    targetTable: table,
                    importedRows: result.snapshots
                };
            }
            case 'deleteRows': {
                const [table] = args;
                // Each entry is the worker's exact pre-delete image
                // ({rowId, row, storageClasses}); undo re-inserts from it and
                // redo re-deletes by matching it, so nothing else is needed.
                return {
                    label: 'Delete rows',
                    description: 'Delete rows',
                    modificationType: 'row_delete',
                    targetTable: table,
                    deletedRows: result
                };
            }
            case 'createView': {
                const [view] = args;
                return {
                    label: `Create view ${view}`,
                    description: `Create view ${view}`,
                    modificationType: 'view_create',
                    targetTable: view,
                    // The worker's createView() return IS the post-create
                    // ViewDefinition (it fetches one internally via
                    // getViewDefinition) — required so the undo-path CAS guard
                    // (assertViewDefinitionStateCurrent) compares real stored
                    // sqlite_schema SQL, not the user's raw SELECT body string.
                    viewDefAfter: result
                };
            }
            // editView/dropView build their modification directly in
            // invokeMutation from the worker's own {before, after} / before
            // result (see below) — no separate pre-fetch needed.
            default:
                return null;
        }
    }

    async function invokeMutation(entry, method, args) {
        await ensureSessionTxn(entry);
        const result = await callMutationGuarded(entry, method, args);
        if (result && typeof result === 'object' && result.cancelled === true) return result;

        let modification = buildModification(method, args, result);
        if (method === 'editView') {
            // editView's own result already carries {before, after} as real
            // ViewDefinition objects (worker.js editView / types.ts
            // ViewEditResult) — using args[1] (the raw SELECT body string) here
            // would make the undo-path CAS guard
            // (assertViewDefinitionStateCurrent) compare a bare SELECT fragment
            // against sqlite_schema's stored CREATE VIEW text and always fail.
            modification = {
                label: `Edit view ${args[0]}`, description: `Edit view ${args[0]}`,
                modificationType: 'view_edit', targetTable: args[0],
                viewDefBefore: result.before, viewDefAfter: result.after
            };
        } else if (method === 'dropView') {
            // dropView's own result IS the pre-drop ViewDefinition.
            modification = {
                label: `Drop view ${args[0]}`, description: `Drop view ${args[0]}`,
                modificationType: 'view_drop', targetTable: args[0],
                viewDefBefore: result
            };
        }
        if (modification) entry.tracker.record(modification);

        if (settings.instantCommit === 'always' && entry.currentPath) {
            await saveToDisk(entry);
        }
        updateTitle();
        return result;
    }

    // ---- host-answered methods ---------------------------------------------

    async function notifyWebview(methodName, parameters) {
        const method = webviewMethods[methodName];
        if (typeof method === 'function') return method(...parameters);
        return undefined;
    }

    /**
     * The registry changed shape, active pointer, or dirty state. Optional
     * webview hook: the tab strip and the sidebar overview render from it.
     * Never propagates — a broken renderer must not fail a save.
     */
    function notifyDatabasesChanged() {
        const list = listDatabases();
        // Push the window's whole registry summary to the shell on this one
        // signal. It is the only place that sees every transition:
        // `updateTitle` calls it on every dirty-state change (it renders the
        // " — Edited" suffix from the same flag), and the registry lifecycle
        // calls it on open/close/switch.
        //
        // unsaved — the shell needs it SYNCHRONOUSLY when the OS asks whether
        // a window may close (it cannot await the page at that moment), so the
        // answer has to already be there. Counting `isDirty` over the whole
        // list matches `hasUnsavedChanges` exactly — both walk every entry,
        // including the retained scratch placeholder that no tab can reach.
        //
        // paths — which files this window has open, whichever engine serves
        // them. The shell has no visible open/close pair for the WASM engine,
        // so THIS is how it learns; it replaces this window's set wholesale
        // and refuses a second window opening any of them, because two
        // editable copies of one database silently overwrite each other. A
        // path-less database (the boot placeholder, a dropped file) reports
        // null and is dropped here — it has no file to collide over.
        const unsaved = list.filter(database => database.isDirty).length;
        const paths = list
            .map(database => database.path)
            .filter(path => typeof path === 'string' && path.length > 0);
        bridge.setUnsavedState?.(unsaved > 0, unsaved, paths)
            ?.catch(error => console.warn('setUnsavedState failed:', error));
        notifyWebview('databasesChanged', [list])
            .catch(error => console.warn('databasesChanged notification failed:', error));
    }

    /**
     * Tell the page to re-render from `entry`. Only the ACTIVE database owns
     * the single rendered sidebar/grid/console: a background database's
     * late-completing operation must not repaint the page with data from a
     * file the user is not looking at.
     */
    /**
     * The outcome of a dialog-mediated write, in the shape the shared UI
     * reads (export.js, blob-inspector.js — the VS Code host's saveFile
     * contract): `{ success: false, cancelled: true }` when the user dismissed
     * the dialog and nothing was written, `{ success: true, savedAs }` naming
     * the file otherwise. A genuine failure REJECTS before reaching here.
     */
    function dialogOutcome(target) {
        if (target === null || target === undefined) return { success: false, cancelled: true };
        return { success: true, savedAs: basename(target) };
    }

    /** Same contract for the shell's out-of-band native export routes, whose `{success:false}` is a clean dialog cancel. */
    function shellDialogOutcome(result) {
        if (result?.success !== true) return { success: false, cancelled: true };
        return { success: true, savedAs: result.savedAs };
    }

    async function refreshUi(entry) {
        if (entry.dbId !== activeId) return;
        await notifyWebview('refreshContent', [
            entry.currentName,
            {
                connected: true,
                engine: entry.engine,
                connectionGeneration: entry.connectionGeneration,
                ...entry.connectionInfo,
                ...reloadRequired(entry)
            }
        ]);
    }

    /**
     * Retires ONE database's connection: the shell refused an envelope with
     * ERR_NATIVE_FILE_CHANGED because the file at the sidecar's bound path is
     * no longer the file it opened — its device/inode differ (an atomic
     * rename over it, a move, a delete). The sidecar's descriptor still
     * points at the OLD inode, so every further statement — a COMMIT above
     * all — would land where the user can never see it. The VS Code host's
     * answer (nativeWorker.ts retireConnection, databaseModel.ts
     * #observeConnectionInvalidation) is reproduced here: the engine is
     * closed, the undo/redo history is discarded (it describes a file that is
     * gone), the connection generation advances so open modals refuse to
     * complete, and the page is told the reason so it can offer Reload
     * Database. Idempotent — the first refusal wins; in-flight calls fail
     * with the same error.
     *
     * Ordinary external writes never reach here: another process's DML, a
     * WAL checkpoint or a VACUUM keep the inode, and the shell compares
     * device+inode ONLY — deliberately not size or mtime, which change on
     * every ordinary SQLite write.
     */
    async function retireEntry(entry, error) {
        if (entry.invalidatedError) return;
        entry.invalidatedError = error;
        entry.connectionGeneration += 1;
        entry.connectionInfo = { isReadOnly: true };
        entry.tracker = new ModificationTracker(100, settings.maxUndoMemory);
        entry.nativeTxnOpen = false;
        entry.cellReadSessionOpen = false;
        failEntryPendingCalls(entry, error);
        // The sidecar's open transaction targeted the orphaned inode; closing
        // it rolls that back by journal semantics and releases the shell's
        // native hold. The page's own hold (the open-path push) keeps the
        // file reserved for this window until Reload or close.
        await disposeEntryTransport(entry);
        updateTitle();
        await refreshUi(entry);
    }

    function updateTitle() {
        const entry = activeEntry();
        const name = entry ? entry.currentName : STARTUP_DB_NAME;
        const dirty = entry?.tracker.hasUncommittedChanges() ? ' — Edited' : '';
        void bridge.setTitle(`${name}${dirty} — SQLite Explorer`);
        notifyDatabasesChanged();
    }

    /**
     * Writes `entry` back to ITS OWN file. Requires a path: a path-less
     * database is the Save As lane ({@link saveEntryAs}), and returning a quiet
     * `false` here is what made ⌘S a silent no-op on the boot placeholder.
     * Every internal caller (instant-commit, the barrier methods, the native
     * export's save-first) already guards on `entry.currentPath`; the public
     * `host.saveToDisk` routes the path-less case to Save As instead.
     */
    async function saveToDisk(entry) {
        if (!entry.currentPath) {
            throw new Error(
                `"${entry.currentName}" has no file on disk yet — use Save As (host.saveToDisk `
                + 'routes a path-less database there).'
            );
        }
        if (entry.engine === 'native') {
            // Native edits already live in the real file inside the session
            // transaction — Save IS the COMMIT. No byte export, no file
            // rewrite; SQLite's journal makes the commit atomic.
            await endSessionTxn(entry, 'COMMIT');
            await entry.tracker.createCheckpoint();
            updateTitle();
            return true;
        }
        const bytes = await callWorker(entry, 'exportDatabase', [entry.currentName]);
        try {
            await bridge.saveDatabase(entry.currentPath, bytes);
        } catch (error) {
            // The shell refuses to write over a file whose on-disk generation
            // moved since this window read (or last wrote) it — the in-memory
            // image predates another writer's changes, and writing it back
            // would silently discard them. The image and its history are
            // intact; only the write was refused, and the sentence names
            // both remedies (export a copy, or reload).
            if (isShellError(error, 'ERR_FILE_CHANGED')) {
                throw new Error(shellErrorText(error), { cause: error });
            }
            throw error;
        }
        await entry.tracker.createCheckpoint();
        updateTitle();
        return true;
    }

    /**
     * Save As: writes a path-less database to a dialog-picked file and makes
     * that file the database's home, so every later ⌘S is an ordinary in-place
     * save.
     *
     * Why a dedicated bridge call and not `saveFileAs`: the shell only lets the
     * webview write paths on the session allowlist, and `saveFileAs` (the
     * EXPORT route) deliberately does not add its destination to it — an
     * exported CSV must not become silently overwritable for the rest of the
     * session. `saveDatabaseAs` is the same dialog plus that grant, which is
     * exactly what "this file is now my database" means and exactly the grant
     * `pickDatabase` already makes. Without it the adopted path would be
     * refused by the very next save.
     *
     * Only WASM databases can reach this: a native entry exists only for a path
     * the shell already bound a sidecar to.
     */
    async function saveEntryAs(entry) {
        if (entry.engine === 'native') {
            throw new Error(
                `"${entry.currentName}" is served by the native engine, which is always bound to a `
                + 'file — Save As is only for databases that have none.'
            );
        }
        if (typeof bridge.saveDatabaseAs !== 'function') {
            // Fail loudly rather than fall back to `saveFileAs`: that would
            // write the bytes and then leave the database unable to save to the
            // file the user just chose, which is the silent-ish half-success
            // this whole lane exists to remove.
            throw new Error(
                'This app build cannot Save As: the shell bridge has no saveDatabaseAs. '
                + 'Update SQLite Explorer, or use File > Export Database to write a copy.'
            );
        }
        const bytes = await callWorker(entry, 'exportDatabase', [entry.currentName]);
        const target = await bridge.saveDatabaseAs(entry.currentName, bytes);
        if (target === null || target === undefined) return { success: false, reason: 'cancelled' };

        const name = basename(target);
        // One file, one entry — the same invariant the open lanes' dedupe
        // keeps. Adopting a path another database already owns would give one
        // file two writable engines with independent session transactions,
        // which is precisely the lost-update hazard `findEntryByPath` exists to
        // prevent. The bytes ARE on disk (the user picked that file in a save
        // dialog and confirmed the overwrite); what is refused is the LINK.
        const conflict = findEntryByPath(target);
        if (conflict && conflict !== entry) {
            throw new Error(
                `Wrote ${name}, but that file is already open in another tab, so `
                + `"${entry.currentName}" was not linked to it — one file must not have two `
                + `writable engines. Close the other tab, then reopen ${name}.`
            );
        }
        entry.currentPath = target;
        entry.currentName = name;
        // It has a file now, so it is a document like any other. Left set, the
        // next open would see a clean `isScratch` entry and `commitEntry` would
        // delete the database the user just saved.
        entry.isScratch = false;
        await entry.tracker.createCheckpoint();
        updateTitle();
        return { success: true, savedAs: name };
    }

    // ---- registry lifecycle -------------------------------------------------

    function listDatabases() {
        return [...databases.values()].map(entry => ({
            dbId: entry.dbId,
            name: entry.currentName,
            path: entry.currentPath,
            engine: entry.engine,
            isDirty: entry.tracker.hasUncommittedChanges(),
            isActive: entry.dbId === activeId
        }));
    }

    /**
     * Is this file already open? Both spellings are compared: the path the
     * caller handed us and, for native entries, the canonical path the shell
     * bound the sidecar to — one file reached through two spellings must still
     * resolve to one entry.
     */
    function findEntryByPath(path) {
        if (path === null || path === undefined) return null;
        const key = databasePathKey(path);
        for (const entry of databases.values()) {
            if (databasePathKey(entry.currentPath) === key
                || databasePathKey(entry.nativeBoundPath) === key) return entry;
        }
        return null;
    }

    /**
     * Shuts an entry's engine down for good. `nativeClose` is deliberately NOT
     * idempotent shell-side (a close that silently did nothing would hide a
     * double-close bug), so the id is taken out of the entry FIRST: exactly one
     * close per sidecar, whatever calls this.
     */
    async function disposeEntryTransport(entry) {
        if (entry.engine === 'native') {
            const nativeDbId = entry.nativeDbId;
            entry.nativeDbId = null;
            entry.nativeBoundPath = null;
            entry.nativeTxnOpen = false;
            if (nativeDbId === null) return;
            try {
                // Shutting the sidecar down rolls its open session transaction
                // back by SQLite journal semantics — unsaved edits are
                // discarded, which is why closeDatabase's caller prompts first.
                await bridge.nativeClose(nativeDbId);
            } catch (error) {
                // The sidecar may already be gone (crash fanout); the shell also
                // force-kills survivors on app exit. Not fatal, not silent.
                console.warn(`nativeClose(${nativeDbId}) failed:`, error);
            }
            return;
        }
        const worker = entry.worker;
        entry.worker = null;
        if (!worker) return;
        try {
            worker.terminate();
        } catch (error) {
            console.warn('Worker terminate failed:', error);
        }
    }

    /** Removes an entry from the registry and tears its engine down. */
    async function removeEntry(entry) {
        databases.delete(entry.dbId);
        // Anything still in flight against a closed database can never settle:
        // fail it here, and ONLY it.
        failEntryPendingCalls(entry, new Error(`Database "${entry.currentName}" was closed`));
        await disposeEntryTransport(entry);
    }

    /**
     * Swap-on-switch. `state` (state.js) keeps its module identity and stays
     * the single object the 21 UI importers render from: the outgoing
     * database's per-database fields are snapshotted OUT of it and the
     * incoming database's are restored back IN, then the page re-renders.
     *
     * The refreshUi at the end is load-bearing beyond repainting: its
     * refreshContent invalidates the module-scoped row-count cache
     * (count-cache.js), which is keyed by table name and would otherwise serve
     * one database's counts for another's identically named table.
     */
    async function activateEntry(entry, { snapshotOutgoing }) {
        const outgoing = activeEntry();
        if (outgoing && outgoing.dbId === entry.dbId) {
            // Already active (a dedupe hit): no swap, but still a re-render
            // request — bring the live session's schema and grid up to date.
            updateTitle();
            await refreshUi(entry);
            return;
        }
        if (snapshotOutgoing && outgoing) outgoing.uiState = snapshotPerDbState();
        activeId = entry.dbId;
        restorePerDbState(entry.uiState);
        updateTitle();
        // The swap cannot reach DOM. Static controls that mirror per-database
        // state (#tableNameLabel, the two filter inputs), open modals and the
        // rendered grid have to be re-synced by the page before the reload
        // below repaints.
        //
        // Never allowed to abort the switch: `activeId` and `state` have
        // already moved, so a throwing page handler would leave the host on the
        // incoming database with the outgoing one's grid never reloaded — a
        // half-applied switch, strictly worse than a stale control. The reload
        // runs regardless and the failure is reported, not swallowed.
        try {
            await notifyWebview('databaseSwitched', [entry.dbId]);
        } catch (error) {
            console.warn('databaseSwitched notification failed:', error);
        }
        await refreshUi(entry);
    }

    /** Boots the empty in-memory database the app starts (and ends) with. */
    async function bootScratchEntry() {
        const entry = createEntry({ engine: 'wasm', currentName: STARTUP_DB_NAME, isScratch: true });
        bootWorkerFor(entry);
        databases.set(entry.dbId, entry);
        try {
            await initializeWorkerDatabase(entry, entry.currentName, {});
        } catch (error) {
            await removeEntry(entry);
            throw error;
        }
        return entry;
    }

    async function closeDatabaseById(dbId) {
        const entry = databases.get(dbId);
        if (!entry) throw new Error(`closeDatabase: unknown database id ${String(dbId)}`);
        const wasActive = entry.dbId === activeId;
        await removeEntry(entry);
        if (!wasActive) {
            updateTitle();
            return true;
        }
        // Its uiState died with it — there is nothing left to snapshot out.
        activeId = null;
        const next = databases.values().next().value ?? await bootScratchEntry();
        await activateEntry(next, { snapshotOutgoing: false });
        return true;
    }

    /**
     * Re-initialize an entry's engine IN PLACE. Refresh is the only operation
     * that does this — every other lane builds a fresh entry and commits it only
     * on success.
     *
     * A failure here is the dangerous shape: `initializeDatabase` tears the
     * previous image/session down BEFORE it can refuse, so the engine no longer
     * holds the document the entry's path, name and tracker still describe. A
     * later Save would then COMMIT an empty native session (reporting "saved"
     * having written nothing) or export whatever the worker now holds over the
     * real file. So a failed re-init CLOSES that database: the file on disk is
     * untouched and the user reopens it.
     */
    async function reinitializeOrClose(entry, config) {
        try {
            await initializeWorkerDatabase(entry, entry.currentName, config);
        } catch (error) {
            const name = entry.currentName;
            try {
                await closeDatabaseById(entry.dbId);
            } catch (closeError) {
                console.warn(`Closing "${name}" after a failed refresh failed:`, closeError);
            }
            const failed = new Error(
                `Refreshing "${name}" failed and its session could not be recovered, so it was `
                + `closed — the file on disk is unchanged (${error?.message ?? error})`
            );
            failed.cause = error;
            throw failed;
        }
    }

    /** Adds a fully-initialized entry to the registry and makes it active. */
    async function commitEntry(entry) {
        const previous = activeEntry();
        databases.set(entry.dbId, entry);
        await activateEntry(entry, { snapshotOutgoing: true });
        // The boot placeholder is not a document anybody asked for: replace it
        // rather than leaving an empty "untitled.db" behind every open. One the
        // user actually edited is KEPT — it has no path, so it cannot be saved
        // and dropping it would silently destroy work.
        if (previous && previous.isScratch && !previous.tracker.hasUncommittedChanges()) {
            await removeEntry(previous);
            notifyDatabasesChanged();
        }
    }

    // ---- engine selection ---------------------------------------------------

    /**
     * Tries to serve `path` with the native engine, as a NEW entry. Resolves to
     * the entry on success, or null on any failure — in which case the caller
     * proceeds down the WASM lane with no half-open sidecar left behind.
     */
    async function tryOpenNative(path, name) {
        const opened = await bindNativeSidecar(path);
        if (!opened) return null;
        const entry = createEntry({
            engine: 'native',
            nativeDbId: opened.dbId,
            nativeBoundPath: opened.boundPath,
            currentPath: path,
            currentName: name
        });
        try {
            await initializeWorkerDatabase(entry, name, { path: opened.boundPath, readOnlyMode: false });
            return entry;
        } catch (error) {
            console.warn(`Native initializeDatabase failed for ${path}; falling back to the WASM engine:`, error);
            // Never leave a half-open sidecar behind the fallback.
            await disposeEntryTransport(entry);
            return null;
        }
    }

    /**
     * The bridge half of a native open: the shell binds a NEW sidecar to
     * `path` and hands back its routing token plus the canonical path it is
     * bound to. Resolves null on every failure the WASM lane can still serve
     * (allowlist refusal, symlinked final component, spawn/handshake failure,
     * the shell's open cap, version skew) — and THROWS on the one it cannot:
     * size and ownership refusals bind both engines, so falling back cannot
     * make the file admissible (the VS
     * Code host refuses before choosing an engine for the same reason).
     */
    async function bindNativeSidecar(path) {
        let available = false;
        try {
            available = await bridge.nativeAvailable() === true;
        } catch (error) {
            console.warn('nativeAvailable failed; using the WASM engine:', error);
            return null;
        }
        if (!available) return null;

        let opened;
        try {
            // The host always requests a writable session, matching the WASM
            // desktop (which never opens read-only; read-only-ness is reported
            // by the engine, not requested by the user).
            opened = await bridge.nativeOpen(path, false, maxFileSizeBytes());
        } catch (error) {
            if (isShellError(error, 'ERR_FILE_TOO_LARGE')) throw sizeRefusal(error);
            // Ownership applies to both engines. Falling back here can create a
            // second editable snapshot in this same window under another spelling.
            if (isShellError(error, 'ERR_NATIVE_DB_ALREADY_OPEN')) throw error;
            // Allowlist refusal, symlinked final component, spawn/handshake
            // failure, the shell's open cap — all fall back to bytes. Nothing
            // was registered, so there is nothing to clean up.
            console.warn(`Native open failed for ${path}; falling back to the WASM engine:`, error);
            return null;
        }

        if (typeof opened?.dbId !== 'string' || typeof opened?.boundPath !== 'string') {
            // Version skew: a shell older than this viewer answers nativeOpen
            // with a bare canonical path and has no per-database ids at all.
            // Without an id nothing can be routed, so refuse the native lane —
            // and best-effort close whatever it just spawned (an older shell's
            // zero-arg nativeClose shuts its single sidecar; this shell answers
            // ERR_NATIVE_UNKNOWN_DB, which the catch below swallows).
            console.warn('nativeOpen did not return {dbId, boundPath}; the shell bridge predates '
                + 'multi-database routing — using the WASM engine.');
            try {
                await bridge.nativeClose(opened?.dbId);
            } catch (error) {
                console.warn('nativeClose after a version-skewed nativeOpen failed:', error);
            }
            return null;
        }
        return opened;
    }

    /**
     * The WASM lane's read, bounded by the same maxFileSize the native lane
     * is: the shell refuses a larger file BEFORE reading it (fstat on the
     * descriptor, no allocation), so the cap is not "read it all, then
     * refuse" for either engine.
     */
    async function readDatabaseBytes(path) {
        try {
            return await bridge.readDatabaseBytes(path, maxFileSizeBytes());
        } catch (error) {
            if (isShellError(error, 'ERR_FILE_TOO_LARGE')) throw sizeRefusal(error);
            throw error;
        }
    }

    /**
     * Reload of a RETIRED database (see retireEntry): the engine is gone, so
     * this is a fresh open — the same native-then-WASM selection every open
     * takes, through the same shell gates (the allowlist the original pick or
     * OS delivery made, the one-editable-copy registry) — bound to the SAME
     * entry so its tab, dbId and parked UI state survive. A fresh open is a
     * fresh history and no session transaction (initializeWorkerDatabase
     * resets both). A failed reopen keeps the entry retired with the NEW
     * reason, exactly as the VS Code host's #retryInitialConnection does:
     * nothing live was lost, and the user can retry once the cause is fixed.
     */
    async function reopenRetiredEntry(entry) {
        const retired = entry.invalidatedError;
        if (!entry.currentPath) throw retired;
        // callWorker refuses a retired entry, and the reopen IS its recovery.
        entry.invalidatedError = null;
        try {
            await reopenEngineInPlace(entry);
        } catch (error) {
            entry.invalidatedError = error instanceof Error ? error : new Error(String(error));
            throw error;
        }
        updateTitle();
    }

    async function reopenEngineInPlace(entry) {
        const { currentPath: path, currentName: name } = entry;
        if (hasNativeBridge()) {
            const opened = await bindNativeSidecar(path);
            if (opened) {
                entry.engine = 'native';
                entry.worker = null;
                entry.nativeDbId = opened.dbId;
                entry.nativeBoundPath = opened.boundPath;
                try {
                    await initializeWorkerDatabase(entry, name, { path: opened.boundPath, readOnlyMode: false });
                    return;
                } catch (error) {
                    console.warn(`Native initializeDatabase failed for ${path}; falling back to the WASM engine:`, error);
                    await disposeEntryTransport(entry);
                }
            }
        }
        const bytes = await readDatabaseBytes(path);
        entry.engine = 'wasm';
        entry.nativeDbId = null;
        entry.nativeBoundPath = null;
        bootWorkerFor(entry);
        try {
            await initializeWorkerDatabase(entry, name, { content: bytes });
        } catch (error) {
            await disposeEntryTransport(entry);
            throw error;
        }
    }

    /**
     * Engine-selecting open shared by the dialog and shell-path entries. Native
     * first when the bridge offers it; otherwise (or on any native failure) the
     * WASM bytes path, including the worker-reported read-only notice (WAL et
     * al.) and the dialog's maxFileSize cap, which only ever applied to byte
     * inhaling.
     *
     * ADDS a database — it never replaces one. Two consequences:
     * - Dedupe: a file that is already open switches to its entry instead of
     *   opening a second one. The shell does not de-duplicate, so without this
     *   one file would get two writable sidecars with independent session
     *   transactions (SQLITE_BUSY, and a save through either one silently
     *   racing the other).
     * - A failed open can no longer damage the database that was open before
     *   it: everything happens on a NEW entry with its own engine, and a
     *   failure disposes that entry and rethrows. There is no shared worker to
     *   leave holding a stale image, which is what the old single-document host
     *   needed its invalidate-the-document recovery for.
     */
    async function openFromPath(path, name) {
        // The dedupe below cannot see an open that has not finished yet, and
        // shell-delivered opens genuinely arrive back to back (an impatient
        // double-click on a Finder file, Open Recent twice). Two concurrent
        // opens of one path would both miss and spawn two writable sidecars on
        // it — so a second request for a path already being opened joins the
        // first instead of racing it. Windows extended prefixes share a key;
        // for other aliases, two
        // DIFFERENT spellings racing still fall through to the post-open
        // boundPath dedupe, one open later.
        const key = databasePathKey(path);
        const inFlight = openRequests.get(key);
        if (inFlight) return inFlight;
        const request = openPathOnce(path, name)
            .finally(() => { openRequests.delete(key); });
        openRequests.set(key, request);
        return request;
    }

    /**
     * Refuses an open that would exceed {@link MAX_OPEN_DATABASES}. Called
     * AFTER the dedupe on every lane that creates an entry: re-opening a file
     * that is already open only switches to it, so the cap can never wall the
     * user off from a database they already have.
     *
     * Counts the opens that have PASSED this check but have not registered
     * their entry yet, not just `databases.size`. Without that the cap is a
     * check-then-act across the whole async engine boot: a Finder
     * multi-selection, an OS file drop and a dialog open all land through
     * different callers, and any two of them in flight together read a
     * registry that is still short. The shell's `MAX_NATIVE_SIDECARS` is the
     * same number enforced SYNCHRONOUSLY in Rust, so an overshoot here does
     * not fail loudly — it silently downgrades the surplus database to the
     * WASM engine, which is the one lane that holds the whole file in
     * renderer memory. Two caps over the same resource must agree or one of
     * them lies.
     */
    function assertRoomForAnotherDatabase(name) {
        if (databases.size + openingEntries < MAX_OPEN_DATABASES) return;
        throw new Error(
            `Cannot open "${name}": ${MAX_OPEN_DATABASES} databases are already open. `
            + 'Close one first.'
        );
    }

    async function openPathOnce(path, name) {
        const alreadyOpen = findEntryByPath(path);
        if (alreadyOpen) {
            // Opening a RETIRED database again is the user asking for it back:
            // reopen it in place rather than switching to its error state.
            if (alreadyOpen.invalidatedError) await reopenRetiredEntry(alreadyOpen);
            await activateEntry(alreadyOpen, { snapshotOutgoing: true });
            return true;
        }
        // Before the engine work, not after: refusing here spawns no sidecar,
        // boots no worker and reads no bytes.
        assertRoomForAnotherDatabase(name);
        // Reserved in the SAME synchronous step as the check above (no await
        // between them, so no other open can interleave) and released only
        // once this open has either registered its entry or given up. The
        // reservation is held ACROSS commitEntry, so the count never dips
        // between "no longer reserved" and "in the registry".
        openingEntries++;
        try {
            return await openEngineFor(path, name);
        } finally {
            openingEntries--;
        }
    }

    /**
     * The engine work of an open, from a cap reservation already taken to a
     * committed entry. Split out only so the reservation has an exception-safe
     * release around every exit of it.
     */
    async function openEngineFor(path, name) {
        if (hasNativeBridge()) {
            const nativeEntry = await tryOpenNative(path, name);
            if (nativeEntry) {
                // Second dedupe pass on the CANONICAL spelling: the same file
                // reached as /tmp/x.db and /private/tmp/x.db only collides here.
                const duplicate = findEntryByPath(nativeEntry.nativeBoundPath);
                if (duplicate) {
                    await disposeEntryTransport(nativeEntry);
                    await activateEntry(duplicate, { snapshotOutgoing: true });
                    return true;
                }
                await commitEntry(nativeEntry);
                return true;
            }
        }

        // Read before the entry exists so a read failure has nothing to clean up.
        // The maxFileSize refusal happens inside the shell for this lane as for
        // the native one (see readDatabaseBytes), so no size check lives here.
        const bytes = await readDatabaseBytes(path);
        const entry = createEntry({ engine: 'wasm', currentPath: path, currentName: name });
        bootWorkerFor(entry);
        try {
            await initializeWorkerDatabase(entry, name, { content: bytes });
        } catch (error) {
            await disposeEntryTransport(entry);
            // The read above made the shell hold this file for this window
            // (its cross-window guard cannot wait for a push that has not
            // happened yet). The open failed, so say so: the registry never
            // gained the entry, and pushing the unchanged list is what
            // releases the hold instead of leaving it to time out.
            notifyDatabasesChanged();
            throw error;
        }
        await commitEntry(entry);
        return true;
    }

    // Save-dialog results report the full picked path; only the filename is
    // status-bar-worthy (and the only part VS Code's webContents.postMessage
    // equivalent would ever have had access to).
    const basename = (p) => {
        const path = String(p);
        // Backslashes are separators in drive/UNC paths, but literal filename
        // characters on Unix. Shell paths are absolute, so keep that distinction.
        return path.split(/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) ? /[\\/]/ : '/').pop();
    };

    // Methods answered by the host itself, against the ACTIVE database.
    const databaseMethods = {
        async initialize(entry) {
            return {
                connected: true,
                isReadOnly: entry.connectionInfo.isReadOnly === true,
                filename: entry.currentName,
                engine: entry.engine,
                connectionGeneration: entry.connectionGeneration,
                ...reloadRequired(entry)
            };
        },
        async exportDb(entry, filename) {
            if (entry.engine === 'native') {
                // The sidecar answers exportDatabase at its dispatch layer,
                // above the worker's cell-read-session guard — replicate the
                // refusal here so both engines answer identically.
                if (entry.cellReadSessionOpen) {
                    throw new Error('A cell read snapshot is active; close it before another database operation');
                }
                if (entry.nativeTxnOpen) {
                    // The export is VACUUM INTO on the sidecar's connection,
                    // which cannot run inside the open session transaction —
                    // and silently committing (or exporting a state the user
                    // hasn't saved) would both lie. One modal, honest.
                    const saveFirst = globalThis.confirm?.(
                        'This database has unsaved changes. Exporting requires saving them first.\n\n'
                        + 'Save the pending changes and continue the export?'
                    );
                    if (saveFirst !== true) return { success: false, cancelled: true };
                    await saveToDisk(entry);
                }
                // Out-of-band file route: the sidecar VACUUM INTOs the whole-DB
                // image to a shell-owned temp and the shell atomically moves it
                // to the dialog-picked dest — the bytes NEVER cross the 16 MiB
                // stdio frame cap a framed exportDatabase would hit (a framed
                // export > 16 MiB fails on native where WASM's structured-clone
                // path does 512 MiB; this gives native the same reach). The
                // shell owns the dialog and returns savedAs already basenamed;
                // { success:false } is a clean dialog-cancel no-op.
                const result = await bridge.nativeExportDatabase(entry.nativeDbId);
                return shellDialogOutcome(result);
            }
            const bytes = await callWorker(entry, 'exportDatabase', [entry.currentName]);
            return dialogOutcome(await bridge.saveFileAs(filename || entry.currentName, bytes));
        },
        async openCellEditor(entry, params, rowId, column, _columnTypes, options = {}) {
            if (options.download !== true) {
                return { success: false, message: 'Use the cell inspector to view this value, or Save Full to download its stored bytes.' };
            }
            // Bind the complete read to this entry, even if the active tab changes.
            const session = await callWorker(entry, 'openCellReadSession', [{ table: params?.table, rowId, column }]);
            entry.cellReadSessionOpen = true;
            let bytes;
            let readError;
            try {
                const size = session.metadata?.byteLength;
                if (!Number.isSafeInteger(size) || size < 0 || size > DESKTOP_EXPORT_MAX_BYTES) {
                    throw new Error('Cell download exceeds the 512 MiB limit or has an invalid byte length.');
                }
                bytes = new Uint8Array(size);
                let offset = 0;
                while (offset < size) {
                    const wanted = Math.min(64 * 1024, size - offset);
                    const chunk = await callWorker(entry, 'readCellChunk', [session.sessionId, offset, wanted]);
                    if (chunk.byteOffset !== offset || !(chunk.bytes instanceof Uint8Array)
                        || chunk.bytes.byteLength === 0 || chunk.bytes.byteLength > wanted
                        || (chunk.done && offset + chunk.bytes.byteLength !== size)) {
                        throw new Error('Cell download returned an incomplete or invalid byte window.');
                    }
                    bytes.set(chunk.bytes, offset);
                    offset += chunk.bytes.byteLength;
                    if (offset === size && chunk.done !== true) {
                        throw new Error('Cell download returned an incomplete snapshot.');
                    }
                }
            } catch (error) {
                readError = error;
            }
            // Release the snapshot before the OS dialog. Failed cleanup stays
            // visible and keeps the native export guard armed.
            try {
                await callWorker(entry, 'closeCellReadSession', [session.sessionId]);
                entry.cellReadSessionOpen = false;
            } catch (error) {
                if (readError) throw new AggregateError([readError, error], `${readError.message}; snapshot close failed: ${error.message}`);
                throw error;
            }
            if (readError) throw readError;
            const extension = /^[a-z0-9]{1,8}$/i.test(options.type?.ext ?? '') ? options.type.ext
                : session.metadata.storageClass === 'text' ? 'txt' : 'bin';
            const basename = `${params.table}_${column}`.replace(/[\\/:\x00-\x1f]/g, '_');
            const result = dialogOutcome(await bridge.saveFileAs(`${basename}.${extension}`, bytes));
            return result.success ? { ...result, mode: 'download' } : result;
        },
        async exportTable(entry, ...args) {
            // Host policy overrides anything UI-passed (nothing passes one today):
            // raise the worker's default web-demo cap to the desktop ceiling.
            // Injected BEFORE the native route serializes the args: the sidecar
            // runs exportTable IN-PROCESS, so the worker's 16 MiB web-demo cap
            // bites without it (the whole-DB VACUUM INTO export has no such arg
            // and is uncapped).
            args = [...args];
            args[4] = { ...(args[4] ?? {}), maxExportBytes: DESKTOP_EXPORT_MAX_BYTES };
            if (entry.engine === 'native') {
                // Out-of-band file route: the sidecar runs the (byte-frozen)
                // exportTable in-process and writes the chunks to a shell-owned
                // temp; only a path crosses the pipe, beating the 16 MiB frame
                // cap the assembled bytes would hit. An empty table is a 0-byte
                // file with success:true — a successful (empty) export, not an
                // error; { success:false } is a clean dialog-cancel no-op. The
                // shell owns the dialog and returns savedAs already basenamed.
                const result = await bridge.nativeExportTable(entry.nativeDbId, JSON.stringify(args));
                return shellDialogOutcome(result);
            }
            const result = await callWorker(entry, 'exportTable', args);
            const text = result.contentChunks.join('');
            return dialogOutcome(
                await bridge.saveFileAs(result.filename, new TextEncoder().encode(text))
            );
        },
        /**
         * Answers the VS Code host's contract (hostBridge.ts refreshFile):
         * "refreshed connection capabilities for immediate webview gating" —
         * { connected, filename, readOnly }. The sidebar's Reload button gates
         * on `connected === true` before calling applyConnectionResult
         * (sidebar.js reloadFromDisk), so a bare { success:true } made that
         * button the one refresh entry point that never re-applied read-only
         * state: a file that came back read-only kept offering edits. The ⌘R /
         * File > Refresh path goes through host.refreshFromDisk → refreshUi and
         * always carried the real flags.
         *
         * A failed re-init CLOSES the database and throws (reinitializeOrClose),
         * so reaching a return here always means a live connection.
         */
        async refreshFile(entry) {
            const connectionResult = () => ({
                connected: true,
                filename: entry.currentName,
                readOnly: entry.connectionInfo.isReadOnly === true,
                connectionGeneration: entry.connectionGeneration,
                ...reloadRequired(entry)
            });
            // A retired database has no engine to roll back or re-init: the
            // reload is a fresh open of the same file, in place. Its failure
            // propagates with the entry still retired (new reason).
            if (entry.invalidatedError) {
                await reopenRetiredEntry(entry);
                return connectionResult();
            }
            // Nothing on disk to re-read (the boot placeholder, a dropped
            // file): report the capabilities it still has rather than pretend
            // a reload happened.
            if (!entry.currentPath) return connectionResult();
            if (entry.engine === 'native') {
                // Refresh discards pending edits (WASM parity: the re-read
                // replaces the in-memory image): roll the session transaction
                // back, then reopen the SAME bound path on this database's
                // sidecar — the file is live, so no bytes ride the bridge.
                await endSessionTxn(entry, 'ROLLBACK');
                await reinitializeOrClose(entry, { path: entry.nativeBoundPath, readOnlyMode: false });
                updateTitle();
                return connectionResult();
            }
            // Read BEFORE the engine is touched: a read failure must leave the
            // document exactly as it was, which is why this is not inside
            // reinitializeOrClose's fail-closed handling.
            const bytes = await bridge.readDatabaseBytes(entry.currentPath);
            await reinitializeOrClose(entry, { content: bytes });
            updateTitle();
            return connectionResult();
        },
        async triggerUndo(entry) {
            // A barrier and an empty stack both refuse the step, and until the
            // page could tell them apart ⌘Z on a DDL/console change looked
            // exactly like a keystroke that did nothing. `reason` is what lets
            // the viewer name the operation that walled the history off.
            const blocking = entry.tracker.undoBlockingEntry;
            const entryToUndo = entry.tracker.stepBack();
            if (!entryToUndo) {
                return blocking
                    ? {
                        performed: false,
                        reason: 'barrier',
                        barrierDescription: blocking.description ?? blocking.modificationType
                    }
                    : { performed: false, reason: 'empty' };
            }
            // Replay is a mutation like any other: it runs inside the open
            // session transaction, or opens a fresh one after a save. A BEGIN
            // failure means the replay never executed — put the history entry
            // back so tracker and database stay in step.
            try {
                await ensureSessionTxn(entry);
            } catch (error) {
                entry.tracker.stepForward();
                throw error;
            }
            // A failed replay composes TWO compensations, order-sensitive:
            // the txn reconcile runs first (inside callMutationGuarded)
            // because on auto-rollback it REPLACES the tracker — the whole
            // history died with the discarded session, and pushing the
            // stepped entry into the fresh tracker would resurrect a
            // phantom. Identity (not the nativeTxnOpen flag) decides,
            // so the WASM path — no txn model, but a failed replay still
            // means the entry was not applied — puts its history back too.
            const trackerBeforeReplay = entry.tracker;
            try {
                await callMutationGuarded(entry, 'undoModification', [entryToUndo]);
            } catch (error) {
                if (entry.tracker === trackerBeforeReplay) entry.tracker.stepForward();
                throw error;
            }
            updateTitle();
            await refreshUi(entry);
            return { performed: true };
        },
        async triggerRedo(entry) {
            const entryToRedo = entry.tracker.stepForward();
            // No barrier case: a barrier clears the future stack when it is
            // recorded, so "nothing to redo" is the only refusal here.
            if (!entryToRedo) return { performed: false, reason: 'empty' };
            try {
                await ensureSessionTxn(entry);
            } catch (error) {
                entry.tracker.stepBack();
                throw error;
            }
            // Mirror of triggerUndo's composition — see the comment there.
            const trackerBeforeReplay = entry.tracker;
            try {
                await callMutationGuarded(entry, 'redoModification', [entryToRedo]);
            } catch (error) {
                if (entry.tracker === trackerBeforeReplay) entry.tracker.stepBack();
                throw error;
            }
            updateTitle();
            await refreshUi(entry);
            return { performed: true };
        }
    };

    // Methods with no database of their own: settings, save-as, UI no-ops.
    // Answered even before start() has booted the first database.
    const globalMethods = {
        async getExtensionSettings() {
            // Wire-shape parity with the VS Code host (hostBridge.ts
            // getExtensionSettings): the settings panel reads `autoCommit` and
            // `cellEditBehavior`; the persisted store keeps the config keys
            // `instantCommit` and `doubleClickBehavior`.
            return {
                autoCommit: settings.instantCommit === 'always',
                cellEditBehavior: settings.doubleClickBehavior,
                fileOperations: settings.fileOperations,
                // The settings panel builds its double-click picker from this
                // list (the hosts own it since 1.7.2): the desktop has no VS
                // Code editor tab to open a cell in, so 'vscode' is not offered.
                cellEditBehaviorOptions: ['inline', 'modal'],
                // Auto-commit is real here (instantCommit → saveToDisk), unlike
                // the web demo, which has no file to commit into.
                autoCommitSupported: true,
                theme: settings.theme,
                // Declared in DEFAULT_SETTINGS since the port and never
                // delivered to anyone, so both read as inert: the page could not
                // see defaultPageSize (VS Code seeds it through an HTML template
                // the desktop has no equivalent of) and nothing consumed
                // maxInlineCellBytes at all. They are answers now — see
                // desktop-viewer.js's startup page size and the fetchTableData
                // injection in `invoke`.
                defaultPageSize: settings.defaultPageSize,
                maxInlineCellBytes: settings.maxInlineCellBytes,
                // Restores the dragged sidebar width across a relaunch. The
                // shell has a real settings store, so this belongs there rather
                // than in the localStorage the desktop never read back.
                sidebarWidth: settings.sidebarWidth,
                // Desktop-only; the VS Code host has no console. `?? []` covers
                // a settings file written before this key existed.
                consoleHistory: settings.consoleHistory ?? []
            };
        },
        async updateExtensionSetting(key, value) {
            // Snapshot BEFORE the change: every write below replaces `settings`
            // with a fresh object rather than mutating it, so holding the old
            // reference is a complete rollback point.
            const previous = settings;
            // Same key translation the VS Code host performs, and the same push:
            // there, a doubleClickBehavior config change fans out
            // updateCellEditBehavior to every webview (editorController.ts).
            if (key === 'autoCommit') {
                settings = { ...settings, instantCommit: value ? 'always' : 'never' };
            } else {
                settings = { ...settings, [key]: value };
            }
            if (key === 'doubleClickBehavior') {
                await notifyWebview('updateCellEditBehavior', [value]);
            }
            // Persist only deviations from defaults to keep the file readable.
            // The comparison is by reference, so an object-valued setting
            // (consoleHistory) always persists once written — including an
            // empty array, which is not the frozen default array. Harmless:
            // `"consoleHistory": []` in the file round-trips identically.
            const delta = {};
            for (const [k, v] of Object.entries(settings)) {
                if (DEFAULT_SETTINGS[k] !== v) delta[k] = v;
            }
            try {
                await bridge.saveSettings(delta);
            } catch (error) {
                // Fail CLOSED: a setting the shell refused to persist must not
                // stay live. Left applied, `autoCommit` is the dangerous one —
                // the user sees the error, yet every later edit really would
                // commit straight into their file with no ⌘S, and the next
                // launch would silently revert to manual.
                settings = previous;
                if (key === 'doubleClickBehavior') {
                    // Undo the push too, or the page keeps the rejected
                    // behaviour while the host has the old one. Secondary
                    // failure only: never allowed to mask the write error the
                    // caller is about to receive.
                    await notifyWebview('updateCellEditBehavior', [previous.doubleClickBehavior])
                        .catch(pushError => console.warn(
                            'Restoring the previous cell-edit behaviour failed:', pushError
                        ));
                }
                throw error;
            }
            return { success: true };
        },
        async saveFile(filename, data) {
            return dialogOutcome(await bridge.saveFileAs(filename, data));
        },
        /**
         * CSV/JSON import, the file half (import-data.js drives the flow). Two
         * shell calls, both dialog-mediated: the pick is a native open dialog
         * filtered to .csv/.json, and the read returns the picked file's text.
         * The page never NAMES a file — it hands back exactly the path the
         * dialog returned, and the shell reads only paths its import dialog
         * produced this session (a separate, read-only allowlist: an import
         * source never becomes a database the page could write in place).
         * Both refuse loudly on a shell that predates them rather than falling
         * back to an in-page file input, which could not enforce the 64 MiB
         * cap before reading.
         */
        async pickImportSource() {
            if (typeof bridge.pickImportSource !== 'function') {
                throw new Error(
                    'This app build cannot import files: the shell bridge has no pickImportSource. '
                    + 'Update SQLite Explorer.'
                );
            }
            return (await bridge.pickImportSource()) ?? null;
        },
        async readImportSource(path) {
            if (typeof bridge.readImportText !== 'function') {
                throw new Error(
                    'This app build cannot import files: the shell bridge has no readImportText. '
                    + 'Update SQLite Explorer.'
                );
            }
            if (typeof path !== 'string' || path.length === 0) {
                throw new Error('readImportSource requires the path the import dialog returned');
            }
            const text = await bridge.readImportText(path);
            if (typeof text !== 'string') {
                throw new Error('The shell did not return the import source as text');
            }
            return text;
        },
        /**
         * Persist the dragged sidebar width. Was a no-op, which is why the
         * sidebar snapped back to its default on every relaunch even though the
         * desktop has a real settings store.
         *
         * Only the left sidebar exists in this UI; an unknown side or an
         * out-of-range width is REFUSED rather than written, because this is
         * webview-supplied input landing in the one file the webview can write.
         * The bounds mirror initSidebarResize's own clamp.
         */
        async saveSidebarState(side, position) {
            if (side !== 'left') throw new Error(`Unknown sidebar: ${String(side)}`);
            const width = Number(position);
            if (!Number.isFinite(width) || width < 150 || width > 400) {
                throw new Error(`Sidebar width out of range: ${String(position)}`);
            }
            await globalMethods.updateExtensionSetting('sidebarWidth', Math.round(width));
            return undefined;
        }
    };

    // ---- public host API ----------------------------------------------------

    const host = {
        async start() {
            settings = { ...DEFAULT_SETTINGS, ...(await bridge.loadSettings()) };
            // VS Code seeds the webview's initial cell-edit behavior through the
            // HTML template env (editorController.ts VSCODE_ENV); the desktop has
            // no template pass, so push it the way config changes arrive.
            await notifyWebview('updateCellEditBehavior', [settings.doubleClickBehavior]);
            const entry = await bootScratchEntry();
            activeId = entry.dbId;
            // Nothing to swap OUT at boot, but the restore still runs so the
            // invariant "`state` always holds the ACTIVE entry's uiState" —
            // `state.dbId` included — holds from the first moment. Everything
            // it writes is already at its default here; initializeApp drives
            // the first render.
            restorePerDbState(entry.uiState);
            updateTitle();
        },
        async invoke(method, args) {
            const global = globalMethods[method];
            if (global) return global(...args);

            const entry = requireActiveEntry();
            if (entry.invalidatedError && !RETIRED_ENTRY_METHODS.has(method)) {
                // The engine is gone. Every engine-bound method answers with
                // the reason — the VS Code host throws its invalidated error
                // from every document operation the same way — so the page
                // never sees "closed" or a routing refusal for a database it
                // still shows a tab for.
                throw entry.invalidatedError;
            }
            const local = databaseMethods[method];
            if (local) return local(entry, ...args);

            if (method === 'openCellReadSession' || method === 'closeCellReadSession') {
                // Mirror of the worker's activeCellReadSession flag, consumed by
                // the native exportDb guard above. Worker-side idle expiry can
                // leave this stale-open; the inspector's eventual close (which
                // the worker tolerates for expired sessions) re-syncs it.
                const result = await callWorker(entry, method, args);
                entry.cellReadSessionOpen = method === 'openCellReadSession';
                return result;
            }
            if (method === 'runConsole') {
                // EXPLAIN compiles and lists; it never executes (worker
                // readQueryPlan). So no session transaction is opened for it —
                // a plan lookup must not take a SHARED lock on the real file
                // or leave a phantom "unsaved" session — and no txn probe
                // follows it. The worker still MEASURES `mutated` for the
                // lookup rather than assuming it, so the barrier below stays
                // armed should a plan ever change anything.
                const explain = args[1]?.explain === true;
                // The script may mutate, and pending-ness must be in place
                // BEFORE its first statement executes — so the session
                // transaction opens up front. Whether it stays open depends on
                // what the run reports below.
                const beganForThisRun = !explain && entry.engine === 'native' && !entry.nativeTxnOpen;
                if (!explain) await ensureSessionTxn(entry);
                const result = await callWorker(entry, method, args);
                // Runs only when runConsole RESOLVED: execution-phase script
                // errors resolve (with {error, mutated}), so a rejection here
                // means the script never ran (pre-execution refusal — txn
                // state unchanged) or the transport died (everything after
                // this rejects anyway; recovery is reopening the database).
                if (!explain) await reconcileConsoleTxnState(entry);
                // Arbitrary SQL cannot be replayed by the undo engine; a mutating run
                // barriers the history exactly like DDL does. A pure SELECT must not
                // dirty the file or wall off the user's undo stack.
                if (result?.mutated) {
                    entry.tracker.record({
                        label: method,
                        description: method,
                        modificationType: method,
                        undoPolicy: 'barrier'
                    });
                    if (settings.instantCommit === 'always' && entry.currentPath) await saveToDisk(entry);
                    updateTitle();
                    await refreshUi(entry);
                } else if (beganForThisRun) {
                    // Nothing mutated: close the transaction this run opened so
                    // a pure read never leaves a SHARED lock (or a phantom
                    // "unsaved" session) dangling on the real file. Commits
                    // nothing — the run made no changes.
                    await endSessionTxn(entry, 'COMMIT');
                }
                return result;
            }
            if (method === 'fetchTableData') {
                // The grid never asks for a cell budget; the SETTING is the one
                // the user can express, and until now nothing read it. The
                // worker clamps the value against its own
                // DEFAULT_MAX_INLINE_CELL_BYTES and ignores a non-positive or
                // unsafe one, so a hand-edited settings.json can only ever
                // LOWER the amount of cell data a page carries.
                const [table, options] = args;
                return callWorker(entry, method, [table, {
                    ...(options ?? {}),
                    maxInlineCellBytes: settings.maxInlineCellBytes
                }]);
            }
            if (BARRIER_METHODS.has(method)) {
                // setPragma stays outside the session transaction: journal_mode
                // cannot change inside one and foreign_keys is a silent no-op
                // there — pragmas are connection/file-level engine actions, not
                // row edits. With a dirty session the engine's own "cannot ...
                // within a transaction" answer surfaces to the user unchanged —
                // EXCEPT foreign_keys, which SQLite silently ignores inside any
                // open transaction (no error, no effect). A data-integrity
                // control must not silently no-op, so the host refuses it while
                // the native session transaction is open. journal_mode DOES error
                // inside a txn, but the fork answers with a generic, misleading
                // "SQL logic error (SQLITE_ERROR: a misspelled name...)" — nothing
                // is misspelled — so the host pre-empts it with the same clear
                // "save or discard first" message it gives foreign_keys.
                if (method === 'setPragma'
                    && entry.engine === 'native' && entry.nativeTxnOpen) {
                    if (args[0] === 'foreign_keys') {
                        throw new Error(
                            'Save or discard the pending changes before changing foreign-key '
                            + 'enforcement: PRAGMA foreign_keys is silently ignored by SQLite '
                            + 'while a transaction is open.'
                        );
                    }
                    if (args[0] === 'journal_mode') {
                        throw new Error(
                            'Save or discard the pending changes before changing the journal '
                            + 'mode: PRAGMA journal_mode cannot change while a transaction is open.'
                        );
                    }
                }
                if (method !== 'setPragma') {
                    await ensureSessionTxn(entry);
                }
                // Guarded like every mutation: an abort-class failure here
                // (DDL is still a write) discards the session txn underneath
                // the flag exactly like a failed grid edit would. The
                // ensureSessionTxn-less setPragma ride-along is harmless —
                // with no txn open the reconcile is a no-op, and a
                // journal_mode-inside-txn refusal probes back "still open".
                const result = await callMutationGuarded(entry, method, args);
                // No ModificationType union member fits a generic DDL/pragma
                // barrier (there's no "barrier"/"pragma" entry); the literal RPC
                // method name is used for modificationType/description instead.
                // This has no runtime effect: ModificationTracker.stepBack()
                // refuses to pop a barrier entry, so undoModification/
                // redoModification never destructure it.
                entry.tracker.record({
                    label: method,
                    description: method,
                    modificationType: method,
                    undoPolicy: 'barrier'
                });
                if (settings.instantCommit === 'always' && entry.currentPath) await saveToDisk(entry);
                updateTitle();
                return result;
            }
            if (method === 'updateCell') {
                // Single-cell edits ride updateCellBatch so the history entry
                // carries the worker's exact prior/post states (see
                // UNDOABLE_METHODS). Same argument order as the worker's own
                // updateCell — (table, rowId, column, value, originalValue,
                // maxEditValueBytes) — and the same answer: the row identity
                // after the edit. The batch's unread `label` slot is the one
                // interior hole the JSON lane may carry (it crosses as null);
                // an absent byte cap is left absent rather than sent as null.
                const [table, rowId, column, value, originalValue, maxEditValueBytes] = args;
                const updates = [{ rowId, column, value, originalValue }];
                const outcomes = await invokeMutation(entry, 'updateCellBatch',
                    maxEditValueBytes === undefined
                        ? [table, updates]
                        : [table, updates, undefined, maxEditValueBytes]);
                return outcomes?.[0]?.newRowId ?? rowId;
            }
            if (method === 'insertRow') {
                // Same reason: insertRowWithHistory captures the inserted row's
                // exact post-image inside the insert's own savepoint. The
                // snapshot budget mirrors hostBridge.ts — whatever the undo
                // memory limit leaves after the entry's own metadata.
                const [table, data, maxEditValueBytes] = args;
                const budget = Math.max(
                    0,
                    settings.maxUndoMemory - estimateUndoMemoryBytes({ table, rowData: data })
                );
                const inserted = await invokeMutation(entry, 'insertRowWithHistory',
                    [table, data, maxEditValueBytes, budget]);
                return inserted?.rowId;
            }
            if (method === 'importRows') {
                // Host policy over whatever the page sent, like exportTable's
                // maxExportBytes: the undo budget is what maxUndoMemory leaves
                // after the entry's own metadata (mirrors insertRow), and the
                // transport budget exists only where the answer crosses a
                // capped frame — the native sidecar. A page cannot lift either.
                const [table, rows, options] = args;
                const rowCount = Array.isArray(rows) ? rows.length : 0;
                const budget = Math.max(0, settings.maxUndoMemory - estimateUndoMemoryBytes({
                    label: `Import ${rowCount} rows`,
                    description: `Import ${rowCount} rows into ${table}`,
                    modificationType: 'row_insert',
                    targetTable: table
                }));
                const importOptions = {
                    ...(options && typeof options === 'object' ? options : {}),
                    maxUndoSnapshotBytes: budget
                };
                if (entry.engine === 'native') {
                    importOptions.maxSnapshotTransportBytes = NATIVE_IMPORT_RESULT_BYTES;
                } else {
                    delete importOptions.maxSnapshotTransportBytes;
                }
                return invokeMutation(entry, 'importRows', [table, rows, importOptions]);
            }
            if (UNDOABLE_METHODS.has(method)) return invokeMutation(entry, method, args);
            return callWorker(entry, method, args);
        },
        setWebviewMethods(methods) { webviewMethods = methods; },
        async openDatabaseViaDialog() {
            const picked = await bridge.pickDatabase();
            if (!picked) return false;
            // The maxFileSize cap is enforced by the shell inside both open
            // lanes (see bindNativeSidecar / readDatabaseBytes), so the
            // dialog's `size` is not consulted here.
            return openFromPath(picked.path, picked.name);
        },
        async openFromShellPath(path) {
            const name = basename(path) || 'database.db';
            return openFromPath(path, name);
        },
        // REMOVED: openDatabaseFromFile(file). It opened a dropped `File` handle
        // as a path-less WASM database and had no call site anywhere in core/ —
        // dead since it was written, because Tauri handles OS drag-and-drop
        // natively and the page never receives an HTML5 file drop. Drag-to-open
        // now arrives as PATHS through the bridge's onDragDropPaths and goes
        // through openFromShellPath, which dedupes by canonical path, can bind a
        // native sidecar, and leaves the database saveable in place. Restoring a
        // File-handle lane would be a strict downgrade of all three.

        // ---- multi-database surface (consumed by the tab strip and the
        // ---- sidebar's Open Databases overview)

        /** Every open database, in open order. */
        listDatabases,
        /** The active database's registry id, or null before start(). */
        activeDatabaseId: () => activeId,
        /**
         * Makes `dbId` active, swapping the viewer's per-database UI state.
         * Resolves false when it was already active (nothing to do); rejects on
         * an unknown id rather than silently picking another database.
         */
        async setActiveDb(dbId) {
            const entry = databases.get(dbId);
            if (!entry) throw new Error(`setActiveDb: unknown database id ${String(dbId)}`);
            if (entry.dbId === activeId) return false;
            await activateEntry(entry, { snapshotOutgoing: true });
            return true;
        },
        /**
         * Closes `dbId`: fails its in-flight calls, terminates its worker or
         * closes its sidecar, drops its UI state, and — if it was the active
         * one — activates another open database (or a fresh empty one when it
         * was the last). Unsaved changes are DISCARDED: the caller is the UI,
         * which prompts first using the `isDirty` flag from listDatabases().
         */
        closeDatabase: closeDatabaseById,

        // The menu/keyboard operations tolerate the no-database state the
        // registry can legitimately land in: `closeDatabase` boots a
        // replacement empty database, and if even THAT fails (a dead WASM
        // runtime) the registry is empty rather than holding a database whose
        // engine is gone. ⌘S and ⌘R must then be quiet no-ops — there is
        // nothing to save or refresh — not a confusing "no database is open"
        // error. `invoke` still throws there, which is correct: the page is
        // asking the engine for something.
        //
        // Answers the same { success, savedAs } contract as exportDb /
        // exportTable / saveFile so the page has one shape to report, plus a
        // `reason` for the two ways nothing gets written. `success:false` is
        // never a failure — a genuine failure REJECTS.
        async saveToDisk() {
            const entry = activeEntry();
            if (!entry) return { success: false, reason: 'no-database' };
            // A database with no file on disk yet (the boot placeholder, a
            // dropped file) goes to the save dialog instead of quietly doing
            // nothing — it is editable, it reports dirty, and the close prompt
            // asks about it, so it must have a way to reach disk.
            if (!entry.currentPath) return saveEntryAs(entry);
            // Retired (its file was replaced underneath the engine): nothing
            // is pending — the history died with the connection — and the
            // engine is gone. ⌘S names the reason and the remedy, never
            // "Saved".
            if (entry.invalidatedError) {
                return {
                    success: false,
                    reason: 'read-only',
                    savedAs: entry.currentName,
                    message: entry.invalidatedError.message
                };
            }
            // A read-only database has nothing to commit: every mutation was
            // refused before it reached the engine, so the native COMMIT below
            // would close a transaction that was never opened and report
            // "Saved <file>" for an operation that never happened — on exactly
            // the file where the user most needs to know it did not. Refuse by
            // name instead, quoting the engine's own reason. Export Database
            // still copies it somewhere writable.
            if (entry.connectionInfo.isReadOnly === true) {
                return {
                    success: false,
                    reason: 'read-only',
                    savedAs: entry.currentName,
                    message: entry.connectionInfo.readOnlyReason
                        ?? `"${entry.currentName}" is open read-only, so there is nothing to save.`
                };
            }
            await saveToDisk(entry);
            return { success: true, savedAs: entry.currentName };
        },
        async refreshFromDisk() {
            const entry = activeEntry();
            if (!entry) return;
            await databaseMethods.refreshFile(entry);
            await refreshUi(entry);
        },
        /**
         * ANY open database, not just the active one — this is the app-level
         * "is there unsaved work" question (the quit prompt). A background tab
         * can be dirty, and the edited boot placeholder is retained while being
         * unreachable from the UI, so an active-only answer would let its edits
         * be discarded silently. Per-tab dirty marks come from
         * listDatabases()[].isDirty.
         */
        hasUnsavedChanges: () => [...databases.values()]
            .some(entry => entry.tracker.hasUncommittedChanges()),
        currentFilename: () => activeEntry()?.currentName ?? null
    };
    return host;
}
