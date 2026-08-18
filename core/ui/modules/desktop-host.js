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
import { decodeFrameValue, encodeFrameValue } from '../../native/frame-codec.js';
import { createPerDbStateSnapshot, restorePerDbState, snapshotPerDbState } from './db-ui-state.js';
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

const STARTUP_DB_NAME = 'untitled.db';

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
        return {
            dbId: nextDbId(),
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
            // here while another database is active. See setActiveDb.
            uiState: createPerDbStateSnapshot()
        };
    }

    const hasNativeBridge = () =>
        typeof bridge.nativeAvailable === 'function'
        && typeof bridge.nativeOpen === 'function'
        && typeof bridge.nativeRpc === 'function'
        && typeof bridge.nativeClose === 'function';

    // ---- worker RPC ---------------------------------------------------------

    /**
     * Shared response routing for BOTH transports and every open database —
     * one pending map, one settle path, whichever side produced the envelope.
     * `sourceDbId` is the database whose transport delivered it.
     */
    function settleFromEnvelope(envelope, sourceDbId) {
        if (envelope?.channel !== 'rpc' || envelope.content?.kind !== 'response') return;
        const { messageId, success, data, errorMessage } = envelope.content;
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
        else pending.reject(new Error(errorMessage || `Worker call failed: ${pending.method}`));
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
                    (error) => rejectPending(
                        messageId,
                        error instanceof Error ? error : new Error(String(error))
                    )
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
        const capBytes = settings.maxFileSize > 0 ? settings.maxFileSize * 1024 * 1024 : Number.MAX_SAFE_INTEGER;
        const transfer = fullConfig.content ? [fullConfig.content.buffer] : undefined;
        const result = await callWorker(entry, 'initializeDatabase', [name, fullConfig], {
            maxBinaryBytes: capBytes,
            transfer
        });
        entry.connectionInfo = { isReadOnly: result?.isReadOnly === true, readOnlyReason: result?.readOnlyReason };
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
        notifyWebview('databasesChanged', [listDatabases()])
            .catch(error => console.warn('databasesChanged notification failed:', error));
    }

    /**
     * Tell the page to re-render from `entry`. Only the ACTIVE database owns
     * the single rendered sidebar/grid/console: a background database's
     * late-completing operation must not repaint the page with data from a
     * file the user is not looking at.
     */
    async function refreshUi(entry) {
        if (entry.dbId !== activeId) return;
        await notifyWebview('refreshContent', [
            entry.currentName,
            { connected: true, engine: entry.engine, ...entry.connectionInfo }
        ]);
    }

    function updateTitle() {
        const entry = activeEntry();
        const name = entry ? entry.currentName : STARTUP_DB_NAME;
        const dirty = entry?.tracker.hasUncommittedChanges() ? ' — Edited' : '';
        void bridge.setTitle(`${name}${dirty} — SQLite Explorer`);
        notifyDatabasesChanged();
    }

    async function saveToDisk(entry) {
        if (!entry.currentPath) return false;
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
        await bridge.saveDatabase(entry.currentPath, bytes);
        await entry.tracker.createCheckpoint();
        updateTitle();
        return true;
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
        for (const entry of databases.values()) {
            if (entry.currentPath === path || entry.nativeBoundPath === path) return entry;
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
        // state (#filterInput, #sidebarFilterInput) and the rendered grid have
        // to be re-synced by the page before the reload below repaints.
        await notifyWebview('databaseSwitched', [entry.dbId]);
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
            opened = await bridge.nativeOpen(path, false);
        } catch (error) {
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
    async function openFromPath(path, name, options) {
        // The dedupe below cannot see an open that has not finished yet, and
        // shell-delivered opens genuinely arrive back to back (an impatient
        // double-click on a Finder file, Open Recent twice). Two concurrent
        // opens of one path would both miss and spawn two writable sidecars on
        // it — so a second request for a path already being opened joins the
        // first instead of racing it. Keyed by the requested spelling: two
        // DIFFERENT spellings racing still fall through to the post-open
        // boundPath dedupe, one open later.
        const inFlight = openRequests.get(path);
        if (inFlight) return inFlight;
        const request = openPathOnce(path, name, options)
            .finally(() => { openRequests.delete(path); });
        openRequests.set(path, request);
        return request;
    }

    async function openPathOnce(path, name, { size } = {}) {
        const alreadyOpen = findEntryByPath(path);
        if (alreadyOpen) {
            await activateEntry(alreadyOpen, { snapshotOutgoing: true });
            return true;
        }

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

        if (size !== undefined && settings.maxFileSize > 0 && size > settings.maxFileSize * 1024 * 1024) {
            throw new Error(
                `Cannot open "${name}": file is ${size} bytes, which exceeds ` +
                `the ${settings.maxFileSize} MiB cap set by the maxFileSize setting.`
            );
        }
        // Read before the entry exists so a read failure has nothing to clean up.
        const bytes = await bridge.readDatabaseBytes(path);
        const entry = createEntry({ engine: 'wasm', currentPath: path, currentName: name });
        bootWorkerFor(entry);
        try {
            await initializeWorkerDatabase(entry, name, { content: bytes });
        } catch (error) {
            await disposeEntryTransport(entry);
            throw error;
        }
        await commitEntry(entry);
        return true;
    }

    // Save-dialog results report the full picked path; only the filename is
    // status-bar-worthy (and the only part VS Code's webContents.postMessage
    // equivalent would ever have had access to).
    const basename = (p) => String(p).split('/').pop();

    // Methods answered by the host itself, against the ACTIVE database.
    const databaseMethods = {
        async initialize(entry) {
            return {
                connected: true,
                isReadOnly: entry.connectionInfo.isReadOnly === true,
                filename: entry.currentName,
                engine: entry.engine
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
                    if (saveFirst !== true) return { success: false };
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
                return { success: result?.success === true, savedAs: result?.savedAs };
            }
            const bytes = await callWorker(entry, 'exportDatabase', [entry.currentName]);
            const target = await bridge.saveFileAs(filename || entry.currentName, bytes);
            return { success: target !== null, savedAs: target ? basename(target) : undefined };
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
                return { success: result?.success === true, savedAs: result?.savedAs };
            }
            const result = await callWorker(entry, 'exportTable', args);
            const text = result.contentChunks.join('');
            const target = await bridge.saveFileAs(result.filename, new TextEncoder().encode(text));
            return { success: target !== null, savedAs: target ? basename(target) : undefined };
        },
        async refreshFile(entry) {
            if (!entry.currentPath) return { success: true };
            if (entry.engine === 'native') {
                // Refresh discards pending edits (WASM parity: the re-read
                // replaces the in-memory image): roll the session transaction
                // back, then reopen the SAME bound path on this database's
                // sidecar — the file is live, so no bytes ride the bridge.
                await endSessionTxn(entry, 'ROLLBACK');
                await initializeWorkerDatabase(entry, entry.currentName, {
                    path: entry.nativeBoundPath, readOnlyMode: false
                });
                updateTitle();
                return { success: true };
            }
            const bytes = await bridge.readDatabaseBytes(entry.currentPath);
            await initializeWorkerDatabase(entry, entry.currentName, { content: bytes });
            updateTitle();
            return { success: true };
        },
        async triggerUndo(entry) {
            const entryToUndo = entry.tracker.stepBack();
            if (!entryToUndo) return { performed: false };
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
            if (!entryToRedo) return { performed: false };
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
        async saveFile(filename, data) {
            const target = await bridge.saveFileAs(filename, data);
            return { success: target !== null, savedAs: target ? basename(target) : undefined };
        },
        async fireEditEvent() { return { success: true }; },
        async saveSidebarState() { return undefined; }
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
            // No swap on boot: `state` is already at its per-database defaults
            // and initializeApp drives the first render.
            activeId = entry.dbId;
            updateTitle();
        },
        async invoke(method, args) {
            const global = globalMethods[method];
            if (global) return global(...args);

            const entry = requireActiveEntry();
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
                // The script may mutate, and pending-ness must be in place
                // BEFORE its first statement executes — so the session
                // transaction opens up front. Whether it stays open depends on
                // what the run reports below.
                const beganForThisRun = entry.engine === 'native' && !entry.nativeTxnOpen;
                await ensureSessionTxn(entry);
                const result = await callWorker(entry, method, args);
                // Runs only when runConsole RESOLVED: execution-phase script
                // errors resolve (with {error, mutated}), so a rejection here
                // means the script never ran (pre-execution refusal — txn
                // state unchanged) or the transport died (everything after
                // this rejects anyway; recovery is reopening the database).
                await reconcileConsoleTxnState(entry);
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
                    if (entry.engine === 'native' && entry.nativeTxnOpen && args[0] === 'foreign_keys') {
                        throw new Error(
                            'Save or discard the pending changes before changing foreign-key '
                            + 'enforcement: PRAGMA foreign_keys is silently ignored by SQLite '
                            + 'while a transaction is open.'
                        );
                    }
                } else {
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
            if (UNDOABLE_METHODS.has(method)) return invokeMutation(entry, method, args);
            return callWorker(entry, method, args);
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
            // Always WASM — there is no OS path to bind a sidecar to, and no
            // on-disk write-back target either.
            const entry = createEntry({ engine: 'wasm', currentPath: null, currentName: file.name });
            bootWorkerFor(entry);
            try {
                await initializeWorkerDatabase(entry, file.name, { file });
            } catch (error) {
                await disposeEntryTransport(entry);
                throw error;
            }
            await commitEntry(entry);
            return true;
        },

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
        async closeDatabase(dbId) {
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
        },

        async saveToDisk() { return saveToDisk(requireActiveEntry()); },
        async refreshFromDisk() {
            const entry = requireActiveEntry();
            await databaseMethods.refreshFile(entry);
            await refreshUi(entry);
        },
        hasUnsavedChanges: () => activeEntry()?.tracker.hasUncommittedChanges() === true,
        currentFilename: () => activeEntry()?.currentName ?? null
    };
    return host;
}
