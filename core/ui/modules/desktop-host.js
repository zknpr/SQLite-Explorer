/**
 * Desktop host — owns the sql.js worker, undo/redo history, settings, and
 * file I/O for the Tauri desktop build. The webview page IS the host (no
 * iframe), so desktop-api.js calls invoke() directly; the only serialization
 * boundaries are worker postMessage (structured clone) and the shell bridge.
 */
import {
    WEBVIEW_TRANSPORT_SURFACES,
    assertWebviewTransportPayload
} from './transport.js';
// The native transport's value codec. The sidecar's stdio transport encodes
// response envelopes with exactly this codec (BigInt/Uint8Array/Error markers,
// ~-escaped scalar sentinels), and the Rust proxy forwards the payload JSON
// verbatim — importing the same module keeps the two ends incapable of drift.
import { decodeFrameValue, encodeFrameValue } from '../../native/frame-codec.js';
import { ModificationTracker } from '../../../src/core/undo-history.ts';

const DEFAULT_SETTINGS = Object.freeze({
    maxFileSize: 200,
    defaultPageSize: 5000,
    instantCommit: 'never',
    doubleClickBehavior: 'inline',
    fileOperations: 'native',
    queryTimeout: 30000,
    maxInlineCellBytes: 1048576,
    maxUndoMemory: 52428800,
    theme: 'system',
    // SQL console history, newest first (see `pushHistory` in the console
    // module: capped at 50 entries of <=4096 chars). Frozen because
    // Object.freeze is shallow — without it a caller mutating the array in
    // place would corrupt the default for the whole session.
    consoleHistory: Object.freeze([])
});

// Worker methods whose successful result must be recorded for undo. DDL and
// pragma changes cannot be replayed by the worker's history engine, so they
// insert barriers instead (undo stops there until the next save).
const UNDOABLE_METHODS = new Set([
    'updateCell', 'updateCellBatch', 'insertRow', 'deleteRows',
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

export function createDesktopHost({ bridge, createWorker }) {
    let worker = null;
    let messageCounter = 0;
    const pendingCalls = new Map();

    let settings = { ...DEFAULT_SETTINGS };
    let tracker = new ModificationTracker(100, settings.maxUndoMemory);

    let currentPath = null;      // absolute path on disk (null for the empty startup DB)
    let currentName = 'untitled.db';
    let connectionInfo = { isReadOnly: false };
    let webviewMethods = {};

    // ---- engine state -------------------------------------------------------
    // One envelope protocol, two transports. 'wasm' routes callWorker through
    // worker.postMessage; 'native' routes the SAME envelope as JSON through
    // bridge.nativeRpc to the tjs sidecar. Selection happens per open in
    // openFromPath; everything above callWorker is engine-agnostic.
    let engine = 'wasm';
    // Canonical path the live sidecar is bound to (nativeOpen's RETURN value —
    // layer 3 and the sidecar compare exact strings, so reopen/refresh must
    // reuse this spelling, never the user-supplied one). null = no sidecar.
    let nativeBoundPath = null;
    // The session transaction: the native engine executes against the REAL
    // file, so "edits are pending until Save" is SQLite's own transaction —
    // first mutation BEGINs, Save COMMITs, refresh/close ROLLBACK. WASM mode
    // gets the same contract for free from its in-memory image.
    let nativeTxnOpen = false;
    // Replica of the worker dispatch's cell-read-session guard, tracked here
    // because the sidecar serves exportDatabase ABOVE that guard (Task 4's
    // accepted parity gap): the host refuses native exports while a session is
    // open, with the worker's own message, so both engines answer identically.
    let cellReadSessionOpen = false;

    const hasNativeBridge = () =>
        typeof bridge.nativeAvailable === 'function'
        && typeof bridge.nativeOpen === 'function'
        && typeof bridge.nativeRpc === 'function'
        && typeof bridge.nativeClose === 'function';

    // ---- worker RPC ---------------------------------------------------------

    // Shared response routing for BOTH transports — one pending map, one
    // settle path, whichever side produced the envelope.
    function settleFromEnvelope(envelope) {
        if (envelope?.channel !== 'rpc' || envelope.content?.kind !== 'response') return;
        const { messageId, success, data, errorMessage } = envelope.content;
        const pending = pendingCalls.get(messageId);
        if (!pending) return;
        pendingCalls.delete(messageId);
        if (success) pending.resolve(data);
        else pending.reject(new Error(errorMessage || `Worker call failed: ${pending.method}`));
    }

    function rejectPending(messageId, error) {
        const pending = pendingCalls.get(messageId);
        if (!pending) return;
        pendingCalls.delete(messageId);
        pending.reject(error);
    }

    function bootWorkerObject() {
        worker = createWorker();
        worker.onmessage = (event) => settleFromEnvelope(event.data);
        worker.onerror = (error) => {
            const failure = new Error(`Worker crashed: ${error?.message ?? error}`);
            // Only this transport's calls die with the worker: the pending map
            // is shared, and an in-flight native RPC is alive on
            // bridge.nativeRpc — it must settle from its own response, not be
            // spuriously failed by a WASM-side crash.
            for (const [messageId, pending] of [...pendingCalls]) {
                if (pending.transport !== 'wasm') continue;
                pendingCalls.delete(messageId);
                pending.reject(failure);
            }
        };
    }

    function callWorker(method, args, { maxBinaryBytes, transfer } = {}) {
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
        const nativeJson = engine === 'native'
            ? JSON.stringify(encodeFrameValue(message))
            : null;
        return new Promise((resolve, reject) => {
            pendingCalls.set(messageId, {
                method,
                // Tags which transport owns this entry, so a WASM worker error
                // (onerror above) cannot reject in-flight native calls.
                transport: nativeJson !== null ? 'native' : 'wasm',
                resolve,
                reject
            });
            if (nativeJson !== null) {
                bridge.nativeRpc(nativeJson).then(
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
                        settleFromEnvelope(envelope);
                        // The Rust proxy routes by messageId, so the response is
                        // ours; if it somehow wasn't, fail this call loudly
                        // rather than hanging it (no-op after a normal settle).
                        rejectPending(messageId, new Error(
                            `Native RPC response for ${method} settled a different messageId`
                        ));
                    },
                    (error) => rejectPending(
                        messageId,
                        error instanceof Error ? error : new Error(String(error))
                    )
                );
            } else if (transfer?.length) {
                worker.postMessage(message, transfer);
            } else {
                worker.postMessage(message);
            }
        });
    }

    async function initializeWorkerDatabase(name, config) {
        const fullConfig = { queryTimeout: settings.queryTimeout, ...config };
        // Database bytes may legitimately exceed the standard 16 MiB inline cap;
        // bound them by the user's maxFileSize setting instead (0 = unlimited).
        const capBytes = settings.maxFileSize > 0 ? settings.maxFileSize * 1024 * 1024 : Number.MAX_SAFE_INTEGER;
        const transfer = fullConfig.content ? [fullConfig.content.buffer] : undefined;
        const result = await callWorker('initializeDatabase', [name, fullConfig], {
            maxBinaryBytes: capBytes,
            transfer
        });
        connectionInfo = { isReadOnly: result?.isReadOnly === true, readOnlyReason: result?.readOnlyReason };
        tracker = new ModificationTracker(100, settings.maxUndoMemory);
        // initializeDatabase closes any open cell read session worker-side and
        // opens a fresh engine session with no transaction.
        cellReadSessionOpen = false;
        nativeTxnOpen = false;
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
    async function probeTxnOpen() {
        try {
            await callWorker('runQuery', ['BEGIN']);
        } catch (error) {
            if (!BEGIN_ALREADY_IN_TXN.test(error?.message ?? '')) throw error;
            return true;
        }
        try {
            await callWorker('runQuery', ['COMMIT']);
        } catch (error) {
            // Unreachable for an empty deferred transaction short of a dying
            // engine — but if it happens, a transaction IS now open: record
            // that truthfully before propagating.
            nativeTxnOpen = true;
            throw error;
        }
        return false;
    }

    async function ensureSessionTxn() {
        if (engine !== 'native' || nativeTxnOpen) return;
        try {
            await callWorker('runQuery', ['BEGIN']);
        } catch (error) {
            // A console script may have left a transaction open — adopt it.
            // Any other failure propagates and the mutation never executes.
            if (!BEGIN_ALREADY_IN_TXN.test(error?.message ?? '')) throw error;
        }
        nativeTxnOpen = true;
    }

    /** @param {'COMMIT' | 'ROLLBACK'} statement */
    async function endSessionTxn(statement) {
        if (engine !== 'native' || !nativeTxnOpen) return;
        try {
            await callWorker('runQuery', [statement]);
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
                if (await probeTxnOpen()) throw error;
                if (statement === 'COMMIT') {
                    // Auto-rollback: the engine DISCARDED the session's
                    // pending changes while failing the save. Reporting
                    // success here (checkpoint, clean title) would silently
                    // lose them — the save must fail loudly, and the grid
                    // must stop showing values that no longer exist.
                    nativeTxnOpen = false;   // nothing left to commit against
                    try {
                        await refreshUi();
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
        nativeTxnOpen = false;
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
    async function reconcileConsoleTxnState() {
        if (engine !== 'native') return;
        nativeTxnOpen = await probeTxnOpen();
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
    async function reconcileTxnAfterMutationFailure() {
        if (engine !== 'native' || !nativeTxnOpen) return;
        try {
            if (await probeTxnOpen()) return;
        } catch (probeError) {
            // Unclassifiable (transport death; or the probe's own COMMIT
            // failed, which already re-marked the flag true). Keep the
            // pending state — if the sidecar is gone every later call fails
            // loudly anyway, and the next probe path re-derives the flag.
            console.warn('Post-mutation-failure txn probe failed:', probeError);
            return;
        }
        // Auto-rollback: the engine discarded the whole session transaction.
        nativeTxnOpen = false;
        tracker = new ModificationTracker(100, settings.maxUndoMemory);
        updateTitle();
        try {
            await refreshUi();
        } catch (uiError) {
            console.warn('Post-auto-rollback UI refresh failed:', uiError);
        }
    }

    // ---- modification recording --------------------------------------------

    function buildModification(method, args, result) {
        switch (method) {
            case 'updateCell': {
                const [table, rowId, column, value, originalValue] = args;
                return {
                    label: `Edit ${column}`,
                    description: `Edit ${column}`,
                    modificationType: 'cell_update',
                    targetTable: table,
                    targetRowId: rowId,
                    newTargetRowId: result ?? rowId,
                    targetColumn: column,
                    priorValue: originalValue,
                    newValue: value
                };
            }
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
                        operation: r.operation
                    }))
                };
            }
            case 'insertRow': {
                const [table, data] = args;
                return {
                    label: 'Insert row',
                    description: 'Insert row',
                    modificationType: 'row_insert',
                    targetTable: table,
                    targetRowId: result,
                    // redoModification's row_insert case reads `rowData` (not
                    // args) to reconstruct the insert; without it, redo silently
                    // inserts an empty row.
                    rowData: data
                };
            }
            case 'deleteRows': {
                const [table, rowIds] = args;
                return {
                    label: 'Delete rows',
                    description: 'Delete rows',
                    modificationType: 'row_delete',
                    targetTable: table,
                    deletedRows: result,
                    // Self-discovered while auditing insertRow's analogous gap
                    // above (not one of the review's 3 listed defects — flagged
                    // separately in the report): redoModification's row_delete
                    // case reads `affectedRowIds` (not deletedRows) to
                    // re-delete; without it, redo silently deletes nothing.
                    affectedRowIds: rowIds
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

    async function invokeMutation(method, args) {
        await ensureSessionTxn();
        let result;
        try {
            result = await callWorker(method, args);
        } catch (error) {
            // The failure may have taken the whole session transaction with
            // it (see reconcileTxnAfterMutationFailure) — reconcile BEFORE
            // the error surfaces so the grid the user sees next tells the
            // truth. Netted here as well: nothing secondary may mask the
            // mutation error the user actually needs.
            try {
                await reconcileTxnAfterMutationFailure();
            } catch (reconcileError) {
                console.warn('Txn reconciliation after a failed mutation failed:', reconcileError);
            }
            throw error;
        }
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
        if (modification) tracker.record(modification);

        if (settings.instantCommit === 'always' && currentPath) {
            await saveToDisk();
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

    async function refreshUi() {
        await notifyWebview('refreshContent', [currentName, { connected: true, engine, ...connectionInfo }]);
    }

    function updateTitle() {
        const dirty = tracker.hasUncommittedChanges() ? ' — Edited' : '';
        void bridge.setTitle(`${currentName}${dirty} — SQLite Explorer`);
    }

    async function saveToDisk() {
        if (!currentPath) return false;
        if (engine === 'native') {
            // Native edits already live in the real file inside the session
            // transaction — Save IS the COMMIT. No byte export, no file
            // rewrite; SQLite's journal makes the commit atomic.
            await endSessionTxn('COMMIT');
            await tracker.createCheckpoint();
            updateTitle();
            return true;
        }
        const bytes = await callWorker('exportDatabase', [currentName]);
        await bridge.saveDatabase(currentPath, bytes);
        await tracker.createCheckpoint();
        updateTitle();
        return true;
    }

    async function openFromBytes(path, name, bytes) {
        await initializeWorkerDatabase(name, { content: bytes });
        currentPath = path;
        currentName = name;
        updateTitle();
        await refreshUi();
        return true;
    }

    // ---- engine selection ---------------------------------------------------

    /** Shuts the live sidecar down and puts the transport back on WASM. */
    async function closeNativeSidecar() {
        engine = 'wasm';
        nativeTxnOpen = false;
        nativeBoundPath = null;
        try {
            await bridge.nativeClose();
        } catch (error) {
            // The sidecar may already be gone (crash fanout); the shell also
            // force-kills survivors on close/replace/app-exit. Not fatal, not
            // silent.
            console.warn('nativeClose failed:', error);
        }
    }

    /**
     * Tries to serve `path` with the native engine. On success the transport
     * is switched and the sidecar session is live; on any failure the caller
     * proceeds down the WASM lane (with no half-open sidecar left behind).
     */
    async function tryOpenNative(path, name) {
        let available = false;
        try {
            available = await bridge.nativeAvailable() === true;
        } catch (error) {
            console.warn('nativeAvailable failed; using the WASM engine:', error);
            return false;
        }
        if (!available) return false;

        let boundPath;
        try {
            // The host always requests a writable session, matching the WASM
            // desktop (which never opens read-only; read-only-ness is reported
            // by the engine, not requested by the user).
            boundPath = await bridge.nativeOpen(path, false);
        } catch (error) {
            // Allowlist refusal, symlinked final component, spawn/handshake
            // failure — all fall back to bytes. (nativeOpen's replace semantics
            // may or may not have shut a previous sidecar; the WASM lane closes
            // any survivor.)
            console.warn(`Native open failed for ${path}; falling back to the WASM engine:`, error);
            return false;
        }

        engine = 'native';
        nativeBoundPath = boundPath;
        try {
            await initializeWorkerDatabase(name, { path: boundPath, readOnlyMode: false });
            return true;
        } catch (error) {
            console.warn(`Native initializeDatabase failed for ${path}; falling back to the WASM engine:`, error);
            // Never leave a half-open sidecar behind the fallback.
            await closeNativeSidecar();
            return false;
        }
    }

    /**
     * Engine-selecting open shared by the dialog and shell-path entries.
     * Native first when the bridge offers it; otherwise (or on any native
     * failure) the existing WASM bytes path, unchanged — including the
     * worker-reported read-only notice (WAL et al.) and the dialog's
     * maxFileSize cap, which only ever applied to byte inhaling.
     */
    async function openFromPath(path, name, { size } = {}) {
        // Sampled BEFORE the native attempt: tryOpenNative's init-refusal
        // path itself calls closeNativeSidecar(), which nulls nativeBoundPath
        // — sampling after it would read "no native session" for exactly the
        // slice where the OLD native document was just torn down (nativeOpen
        // replaced the sidecar, init refused), leaving the invalidation below
        // unarmed while ⌘S was pointed at the old file with a stale worker.
        const hadNativeSession = nativeBoundPath !== null;
        if (hasNativeBridge() && await tryOpenNative(path, name)) {
            currentPath = path;
            currentName = name;
            updateTitle();
            await refreshUi();
            return true;
        }
        // A native session from a previous open must not outlive the switch:
        // its sidecar still holds the old file (open transaction included —
        // shutdown rolls it back by SQLite journal semantics). Conditional on
        // the CURRENT binding — tryOpenNative may have already closed it.
        if (nativeBoundPath !== null) await closeNativeSidecar();
        engine = 'wasm';
        // Once the sidecar is gone — or the worker re-init below has begun —
        // the WASM worker does NOT hold the document currentPath names: its
        // last successful init is the empty startup DB or an older file. If
        // the lane then fails, title/tracker/grid still describe the OLD
        // document while Save would export whatever the worker actually holds
        // and bridge.saveDatabase it over the old (still-allowlisted) path,
        // destroying the user's real file. Any failure past that point must
        // invalidate the document identity before the error propagates. A
        // failure BEFORE that point (the cap check / a failed read with no
        // native teardown) leaves the previous document fully intact in the
        // worker, and destroying that session would be its own regression.
        let workerHoldsStaleDoc = hadNativeSession;
        try {
            if (size !== undefined && settings.maxFileSize > 0 && size > settings.maxFileSize * 1024 * 1024) {
                throw new Error(
                    `Cannot open "${name}": file is ${size} bytes, which exceeds ` +
                    `the ${settings.maxFileSize} MiB cap set by the maxFileSize setting.`
                );
            }
            const bytes = await bridge.readDatabaseBytes(path);
            workerHoldsStaleDoc = true;   // initializeDatabase may tear the old image down
            return await openFromBytes(path, name, bytes);
        } catch (error) {
            if (workerHoldsStaleDoc) await invalidateDocument();
            throw error;
        }
    }

    /**
     * Fail-closed reset after an open left the transport without a known-good
     * document. Nulling the identity FIRST is the primary guard: saveToDisk
     * refuses on a null currentPath, so nothing can be written anywhere even
     * if the recovery below fails. The re-init to the empty startup DB is
     * hardening — it puts the worker, tracker, and page into the same
     * coherent no-document state the app boots with.
     */
    async function invalidateDocument() {
        currentPath = null;
        currentName = 'untitled.db';
        try {
            // Also resets the tracker and the session/txn flags.
            await initializeWorkerDatabase(currentName, {});
        } catch (initError) {
            // The null path above already made saves impossible; still reset
            // the host-side trackers so the title stops claiming edits exist.
            console.warn('Post-failure worker re-init failed:', initError);
            connectionInfo = { isReadOnly: false };
            tracker = new ModificationTracker(100, settings.maxUndoMemory);
            cellReadSessionOpen = false;
            nativeTxnOpen = false;
        }
        updateTitle();
        try {
            await refreshUi();
        } catch (uiError) {
            // Best-effort during error recovery: the ORIGINAL open failure is
            // what must reach the user, not a secondary refresh problem.
            console.warn('Post-failure UI refresh failed:', uiError);
        }
    }

    // Save-dialog results report the full picked path; only the filename is
    // status-bar-worthy (and the only part VS Code's webContents.postMessage
    // equivalent would ever have had access to).
    const basename = (p) => String(p).split('/').pop();

    const localMethods = {
        async initialize() {
            return { connected: true, isReadOnly: connectionInfo.isReadOnly === true, filename: currentName, engine };
        },
        async getExtensionSettings() {
            // Wire-shape parity with the VS Code host (hostBridge.ts
            // getExtensionSettings): the settings panel reads `autoCommit` and
            // `cellEditBehavior`; the persisted store keeps the config keys
            // `instantCommit` and `doubleClickBehavior`.
            return {
                autoCommit: settings.instantCommit === 'always',
                cellEditBehavior: settings.doubleClickBehavior,
                fileOperations: settings.fileOperations,
                theme: settings.theme,
                // Desktop-only; the VS Code host has no console. `?? []` covers
                // a settings file written before this key existed.
                consoleHistory: settings.consoleHistory ?? []
            };
        },
        async updateExtensionSetting(key, value) {
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
            await bridge.saveSettings(delta);
            return { success: true };
        },
        async exportDb(filename) {
            if (engine === 'native') {
                // The sidecar answers exportDatabase at its dispatch layer,
                // above the worker's cell-read-session guard — replicate the
                // refusal here so both engines answer identically.
                if (cellReadSessionOpen) {
                    throw new Error('A cell read snapshot is active; close it before another database operation');
                }
                if (nativeTxnOpen) {
                    // The export is VACUUM INTO on the sidecar's connection,
                    // which cannot run inside the open session transaction —
                    // and silently committing (or exporting a state the user
                    // hasn't saved) would both lie. One modal, honest.
                    const saveFirst = globalThis.confirm?.(
                        'This database has unsaved changes. Exporting requires saving them first.\n\n'
                        + 'Save the pending changes and continue the export?'
                    );
                    if (saveFirst !== true) return { success: false };
                    await saveToDisk();
                }
            }
            const bytes = await callWorker('exportDatabase', [currentName]);
            const target = await bridge.saveFileAs(filename || currentName, bytes);
            return { success: target !== null, savedAs: target ? basename(target) : undefined };
        },
        async exportTable(...args) {
            // Host policy overrides anything UI-passed (nothing passes one today):
            // raise the worker's default web-demo cap to the desktop ceiling.
            args = [...args];
            args[4] = { ...(args[4] ?? {}), maxExportBytes: DESKTOP_EXPORT_MAX_BYTES };
            const result = await callWorker('exportTable', args);
            const text = result.contentChunks.join('');
            const target = await bridge.saveFileAs(result.filename, new TextEncoder().encode(text));
            return { success: target !== null, savedAs: target ? basename(target) : undefined };
        },
        async refreshFile() {
            if (!currentPath) return { success: true };
            if (engine === 'native') {
                // Refresh discards pending edits (WASM parity: the re-read
                // replaces the in-memory image): roll the session transaction
                // back, then reopen the SAME bound path on the live sidecar —
                // the file is live, so no bytes ride the bridge.
                await endSessionTxn('ROLLBACK');
                await initializeWorkerDatabase(currentName, { path: nativeBoundPath, readOnlyMode: false });
                updateTitle();
                return { success: true };
            }
            const bytes = await bridge.readDatabaseBytes(currentPath);
            await initializeWorkerDatabase(currentName, { content: bytes });
            updateTitle();
            return { success: true };
        },
        async saveFile(filename, data) {
            const target = await bridge.saveFileAs(filename, data);
            return { success: target !== null, savedAs: target ? basename(target) : undefined };
        },
        async triggerUndo() {
            const entry = tracker.stepBack();
            if (!entry) return { performed: false };
            // Replay is a mutation like any other: it runs inside the open
            // session transaction, or opens a fresh one after a save. A BEGIN
            // failure means the replay never executed — put the history entry
            // back so tracker and database stay in step.
            try {
                await ensureSessionTxn();
            } catch (error) {
                tracker.stepForward();
                throw error;
            }
            await callWorker('undoModification', [entry]);
            updateTitle();
            await refreshUi();
            return { performed: true };
        },
        async triggerRedo() {
            const entry = tracker.stepForward();
            if (!entry) return { performed: false };
            try {
                await ensureSessionTxn();
            } catch (error) {
                tracker.stepBack();
                throw error;
            }
            await callWorker('redoModification', [entry]);
            updateTitle();
            await refreshUi();
            return { performed: true };
        },
        async fireEditEvent() { return { success: true }; },
        async saveSidebarState() { return undefined; }
    };

    // ---- public host API ----------------------------------------------------

    const host = {
        async start() {
            settings = { ...DEFAULT_SETTINGS, ...(await bridge.loadSettings()) };
            tracker = new ModificationTracker(100, settings.maxUndoMemory);
            // VS Code seeds the webview's initial cell-edit behavior through the
            // HTML template env (editorController.ts VSCODE_ENV); the desktop has
            // no template pass, so push it the way config changes arrive.
            await notifyWebview('updateCellEditBehavior', [settings.doubleClickBehavior]);
            bootWorkerObject();
            await initializeWorkerDatabase(currentName, {});
            updateTitle();
        },
        async invoke(method, args) {
            const local = localMethods[method];
            if (local) return local(...args);
            if (method === 'openCellReadSession' || method === 'closeCellReadSession') {
                // Mirror of the worker's activeCellReadSession flag, consumed by
                // the native exportDb guard above. Worker-side idle expiry can
                // leave this stale-open; the inspector's eventual close (which
                // the worker tolerates for expired sessions) re-syncs it.
                const result = await callWorker(method, args);
                cellReadSessionOpen = method === 'openCellReadSession';
                return result;
            }
            if (method === 'runConsole') {
                // The script may mutate, and pending-ness must be in place
                // BEFORE its first statement executes — so the session
                // transaction opens up front. Whether it stays open depends on
                // what the run reports below.
                const beganForThisRun = engine === 'native' && !nativeTxnOpen;
                await ensureSessionTxn();
                const result = await callWorker(method, args);
                // Runs only when runConsole RESOLVED: execution-phase script
                // errors resolve (with {error, mutated}), so a rejection here
                // means the script never ran (pre-execution refusal — txn
                // state unchanged) or the transport died (everything after
                // this rejects anyway; recovery is reopening the database).
                await reconcileConsoleTxnState();
                // Arbitrary SQL cannot be replayed by the undo engine; a mutating run
                // barriers the history exactly like DDL does. A pure SELECT must not
                // dirty the file or wall off the user's undo stack.
                if (result?.mutated) {
                    tracker.record({
                        label: method,
                        description: method,
                        modificationType: method,
                        undoPolicy: 'barrier'
                    });
                    if (settings.instantCommit === 'always' && currentPath) await saveToDisk();
                    updateTitle();
                    await refreshUi();
                } else if (beganForThisRun) {
                    // Nothing mutated: close the transaction this run opened so
                    // a pure read never leaves a SHARED lock (or a phantom
                    // "unsaved" session) dangling on the real file. Commits
                    // nothing — the run made no changes.
                    await endSessionTxn('COMMIT');
                }
                return result;
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
                // the native session transaction is open. journal_mode needs no
                // guard: the engine itself errors loudly there.
                if (method === 'setPragma') {
                    if (engine === 'native' && nativeTxnOpen && args[0] === 'foreign_keys') {
                        throw new Error(
                            'Save or discard the pending changes before changing foreign-key '
                            + 'enforcement: PRAGMA foreign_keys is silently ignored by SQLite '
                            + 'while a transaction is open.'
                        );
                    }
                } else {
                    await ensureSessionTxn();
                }
                const result = await callWorker(method, args);
                // No ModificationType union member fits a generic DDL/pragma
                // barrier (there's no "barrier"/"pragma" entry); the literal RPC
                // method name is used for modificationType/description instead.
                // This has no runtime effect: ModificationTracker.stepBack()
                // refuses to pop a barrier entry, so undoModification/
                // redoModification never destructure it.
                tracker.record({
                    label: method,
                    description: method,
                    modificationType: method,
                    undoPolicy: 'barrier'
                });
                if (settings.instantCommit === 'always' && currentPath) await saveToDisk();
                updateTitle();
                return result;
            }
            if (UNDOABLE_METHODS.has(method)) return invokeMutation(method, args);
            return callWorker(method, args);
        },
        setWebviewMethods(methods) { webviewMethods = methods; },
        async openDatabaseViaDialog() {
            const picked = await bridge.pickDatabase();
            if (!picked) return false;
            // The maxFileSize cap belongs to the WASM lane inside openFromPath:
            // it bounds byte inhaling, which the native engine never does.
            return openFromPath(picked.path, picked.name, { size: picked.size });
        },
        async openFromShellPath(path) {
            const name = String(path).split('/').pop() || 'database.db';
            return openFromPath(path, name);
        },
        async openDatabaseFromFile(file) {
            // Drag-and-dropped File objects keep the demo's paged-open path for
            // very large databases (the worker reads the handle on demand).
            // Always WASM — there is no OS path to bind a sidecar to. A native
            // session from a previous open must not survive the switch.
            if (nativeBoundPath !== null) await closeNativeSidecar();
            engine = 'wasm';
            try {
                await initializeWorkerDatabase(file.name, { file });
            } catch (error) {
                // Same failure class as openFromPath's WASM lane: the previous
                // document (native session or torn WASM image) is gone but
                // currentPath still names it — Save must find no target.
                await invalidateDocument();
                throw error;
            }
            currentPath = null; // no on-disk write-back target for DnD opens
            currentName = file.name;
            updateTitle();
            await refreshUi();
            return true;
        },
        saveToDisk,
        async refreshFromDisk() { await localMethods.refreshFile(); await refreshUi(); },
        hasUnsavedChanges: () => tracker.hasUncommittedChanges(),
        currentFilename: () => currentName
    };
    return host;
}
