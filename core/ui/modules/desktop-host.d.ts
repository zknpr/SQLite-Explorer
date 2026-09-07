/**
 * Types for desktop-host.js — the Tauri desktop host that owns the sql.js
 * worker, undo/redo history, settings, and bridge-backed file I/O.
 */

/**
 * How many databases may be open at once, across both engines. Each one costs
 * a whole engine instance (a Worker with its own copy of the file, or a
 * sidecar process); the number matches the shell's own native-sidecar cap.
 * Every lane that creates an entry refuses past it, AFTER de-duplicating, so
 * re-opening an already-open file still switches to it at the cap.
 */
export const MAX_OPEN_DATABASES: number;

/** Result of a successful native "Open Database" file-picker round trip. */
export interface PickedDatabase {
    path: string;
    name: string;
    size: number;
}

/**
 * Native shell services desktop-host.js depends on. Implemented by
 * `bridge.js` (Task 8) and mocked directly in tests and the Task 5 harness.
 */
export interface DesktopHostBridge {
    pickDatabase(): Promise<PickedDatabase | null>;
    /** `path` must be session-allowlisted (previously picked/opened). */
    readDatabaseBytes(path: string): Promise<Uint8Array>;
    /** Writes `bytes` to `path` atomically. */
    saveDatabase(path: string, bytes: Uint8Array): Promise<void>;
    /**
     * EXPORT route: save dialog → atomic write → the chosen path (null when the
     * user cancelled). The destination is deliberately NOT added to the session
     * allowlist — an exported CSV must not become silently overwritable for the
     * rest of the session.
     */
    saveFileAs(defaultName: string, bytes: Uint8Array): Promise<string | null>;
    /**
     * SAVE AS route: the same dialog and atomic write, plus the session-allowlist
     * grant that makes the chosen file writable in place afterwards — so the
     * database can adopt it and every later save is an ordinary `saveDatabase`.
     * Resolves to the chosen path, or null if the user cancelled.
     *
     * Optional like {@link onOpenFile}: shells older than this viewer have no
     * such command, and the host refuses Save As loudly rather than writing
     * bytes it then could not save over.
     */
    saveDatabaseAs?(defaultName: string, bytes: Uint8Array): Promise<string | null>;
    loadSettings(): Promise<Record<string, unknown>>;
    saveSettings(settings: Record<string, unknown>): Promise<void>;
    /**
     * CSV/JSON import source: a native open dialog filtered to `.csv`/`.json`.
     * The picked path joins the shell's IMPORT allowlist only — a read-only
     * grant, distinct from the database session allowlist, so an import source
     * never becomes a file the page can write in place or reopen as a database.
     * Resolves null when the user cancelled. Optional like {@link onOpenFile}:
     * the host refuses import on a shell without it.
     */
    pickImportSource?(): Promise<PickedDatabase | null>;
    /**
     * The text of a file {@link pickImportSource} returned this session, as
     * UTF-8; the shell refuses any other path, a non-regular file, non-UTF-8
     * content, and anything over 64 MiB (checked before the read).
     */
    readImportText?(path: string): Promise<string>;
    onMenu(handler: (id: string) => void): void;
    setTitle(title: string): Promise<void>;
    /**
     * Fires when the shell delivers a path via native "Open With"/recents,
     * outside the in-webview open-dialog flow. Optional: implemented by
     * Task 8's bridge.js and the dev harness; older shells may omit it, so
     * callers must use `?.`.
     */
    onOpenFile?(handler: (path: string) => void): void;
    /**
     * Fires when files are DROPPED on the window, with their OS paths.
     *
     * Tauri v2 handles OS drag-and-drop natively (`dragDropEnabled` defaults
     * true), so the webview never receives an HTML5 `drop` for a file and the
     * page cannot see one by itself — the shell has to forward it. Paths, not
     * `File` handles, because a path opens on the native engine, binds a
     * sidecar, and can be saved back in place; a `File` can do none of those.
     *
     * The delivered paths are OS-chosen, exactly like {@link onOpenFile}'s, so
     * they carry the same trust basis: the webview never names them.
     *
     * Optional for the same reason as {@link onOpenFile}.
     */
    onDragDropPaths?(handler: (paths: string[]) => void): void;
    /**
     * Signals the webview has finished booting. Optional for the same reason
     * as {@link onOpenFile}.
     */
    viewerReady?(): Promise<void>;
    /**
     * The window's registry summary, pushed on every dirty-state and registry
     * change. Optional for the same reason as {@link onOpenFile}.
     *
     * `hasUnsaved`/`count` — how many open databases have unsaved changes, so
     * the shell can answer the OS synchronously when the window is asked to
     * close (it cannot await the page at that point).
     *
     * `openPaths` — the files this window currently has open, any engine,
     * path-less databases omitted. The shell replaces THIS window's set with
     * it wholesale and refuses another window opening any of them: two
     * editable copies of one database silently overwrite each other, and the
     * shell has no other way to see a WASM close. Sending a shorter list is
     * how a close is reported; sending none at all (an older host) leaves the
     * shell's previous set standing.
     */
    setUnsavedState?(hasUnsaved: boolean, count: number, openPaths?: string[]): Promise<void>;

    // ---- native engine (tjs sidecar) — all four present or the host stays
    // ---- on WASM. Implemented by the shell's bridge.js over the Rust
    // ---- native_* commands; older shells and the dev harness omit them.
    //
    // Every call names ONE sidecar by its shell-issued `dbId`. The token is
    // opaque: pass it back verbatim, never construct, parse, derive, or reuse
    // one after close. An unknown or closed id is refused
    // (`ERR_NATIVE_UNKNOWN_DB`) and NEVER silently retargeted to another
    // database — that refusal is what keeps path-less envelopes (runQuery,
    // mutations, undo/redo) off another database's connection.

    /** True when both the sidecar binary and its bundle are shipped. */
    nativeAvailable?(): Promise<boolean>;
    /**
     * Spawns a NEW sidecar bound to `path` (the shell keeps N of them, capped).
     * The path must already be session-allowlisted (dialog-picked or
     * OS-delivered). Resolves to the sidecar's `dbId` plus its CANONICAL
     * `boundPath` — the exact string the sidecar's argv binding and the shell's
     * per-envelope gate compare against, so `initializeDatabase`'s
     * `config.path` must carry `boundPath`, never the input spelling.
     *
     * The shell does NOT de-duplicate: opening one file twice yields two ids
     * and two writable sidecars. The host de-duplicates by path instead.
     */
    nativeOpen?(path: string, readOnly: boolean): Promise<{ dbId: string; boundPath: string }>;
    /**
     * Frames one request envelope (the worker protocol, JSON-encoded with the
     * frame-codec value markers) to `dbId`'s sidecar and resolves the response
     * envelope JSON verbatim. Rejects with structured `ERR_NATIVE_*` reasons
     * on transport-level failures (unknown id, sidecar exit, refused envelope,
     * caps).
     */
    nativeRpc?(dbId: string, envelopeJson: string): Promise<string>;
    /**
     * Shuts `dbId`'s sidecar down. Deliberately NOT idempotent: closing an
     * unknown or already-closed id rejects with `ERR_NATIVE_UNKNOWN_DB`, so a
     * double close is a loud bug rather than a silent one. Call it exactly once
     * per sidecar (the host takes the id out of its entry before closing).
     */
    nativeClose?(dbId: string): Promise<void>;

    // ---- native out-of-band export (tjs sidecar) — the whole-DB image / the
    // ---- table bytes would exceed the 16 MiB stdio frame cap if framed back,
    // ---- so the shell shows the save dialog, drives the sidecar to write the
    // ---- export to a shell-owned temp, and atomically moves it to the picked
    // ---- dest; only a small result crosses the pipe. Optional like the other
    // ---- native members. `savedAs` is the picked file's basename;
    // ---- { success:false } means the user cancelled the dialog.

    /** Whole-DB export (native): dialog → sidecar VACUUM INTO temp → atomic move to dest. */
    nativeExportDatabase?(dbId: string): Promise<{ success: boolean; savedAs?: string }>;
    /**
     * Table export (native): `argsJson` is `JSON.stringify` of the exportTable
     * args array (with the host-injected `maxExportBytes` ceiling). The sidecar
     * runs exportTable in-process and streams its chunks to the shell temp.
     */
    nativeExportTable?(dbId: string, argsJson: string): Promise<{ success: boolean; savedAs?: string }>;
}

/** One open database, as reported by {@link DesktopHost.listDatabases}. */
export interface OpenDatabase {
    /**
     * Host-issued registry key — opaque to the UI, stable for the life of the
     * entry. NOT the shell's native sidecar id (that one exists only for
     * native databases and never leaves the host).
     */
    dbId: string;
    /** Filename shown in the tab / overview row. */
    name: string;
    /** Absolute path on disk, or null (the boot placeholder, dropped files). */
    path: string | null;
    engine: 'native' | 'wasm';
    /** Unsaved changes — the close prompt keys on this. */
    isDirty: boolean;
    isActive: boolean;
}

/**
 * Outcome of {@link DesktopHost.saveToDisk} — the same `{ success, savedAs }`
 * contract the host's export/saveFile methods answer, so the page has one shape
 * to surface. `success: false` is never an error (errors reject); it is one of
 * the two ways nothing was written:
 * - `cancelled` — the user dismissed the Save As dialog.
 * - `no-database` — the registry is empty (only reachable when the WASM runtime
 *   itself died), so ⌘S is a quiet no-op rather than a confusing error.
 */
export interface SaveResult {
    success: boolean;
    /** Basename of the file written. Present exactly when `success` is true. */
    savedAs?: string;
    reason?: 'cancelled' | 'no-database';
}

/** Options accepted by {@link createDesktopHost}. */
export interface CreateDesktopHostOptions {
    bridge: DesktopHostBridge;
    /** Factory so tests can inject a fake worker instead of a real `Worker`. */
    createWorker: () => Worker;
}

/**
 * Public surface returned by {@link createDesktopHost}. `invoke` is the
 * single entry point desktop-api.js calls for every RPC method name; the
 * remaining methods are the host-level operations the native menu/toolbar
 * drive directly (open/save dialogs, refresh, unsaved-changes state).
 */
export interface DesktopHost {
    /** Boots the empty in-memory database the app starts with. */
    start(): Promise<void>;
    invoke(method: string, args: unknown[]): Promise<unknown>;
    /**
     * Registers webview-side callbacks the host notifies. Beyond
     * `refreshContent` / `updateCellEditBehavior` / `updateColorScheme`, two
     * are multi-database hooks and both are optional:
     * - `databasesChanged(list: OpenDatabase[])` — the registry, the active
     *   pointer, or a dirty flag changed; the tab strip renders from it.
     * - `databaseSwitched(dbId: string)` — fired inside `setActiveDb` AFTER the
     *   UI state swap and BEFORE the reload, so the page can re-sync the DOM
     *   that mirrors per-database state and is not re-rendered by the reload
     *   (the toolbar's table label, the global and sidebar filter inputs, the
     *   status line and pager when the incoming database has no selection) and
     *   dismiss modals showing the outgoing database's content. A rejection
     *   from it is logged, never allowed to abort the switch.
     */
    setWebviewMethods(methods: Record<string, (...args: unknown[]) => unknown>): void;
    /** Opens (or, if already open, switches to) a dialog-picked database. */
    openDatabaseViaDialog(): Promise<boolean>;
    /**
     * Opens a database at a shell-provided path — native "Open With", Open
     * Recent, and OS drag-and-drop, all of which name the file outside the
     * webview. Resolves true when a database is open at that path afterwards
     * (including when it already was, and was activated instead).
     */
    openFromShellPath(path: string): Promise<boolean>;

    /** Every open database, in open order. */
    listDatabases(): OpenDatabase[];
    /** The active database's registry id, or null before `start()`. */
    activeDatabaseId(): string | null;
    /**
     * Makes `dbId` active, swapping the viewer's per-database UI state out of
     * the outgoing database and into the incoming one. Resolves false when it
     * was already active; rejects on an unknown id (never falls back to another
     * database).
     */
    setActiveDb(dbId: string): Promise<boolean>;
    /**
     * Closes `dbId` — fails its in-flight calls, terminates its worker or
     * closes its sidecar, and activates another open database (or a fresh empty
     * one when it was the last). Unsaved changes are DISCARDED: prompt first
     * using `isDirty` from {@link DesktopHost.listDatabases}.
     */
    closeDatabase(dbId: string): Promise<boolean>;

    /**
     * Saves the ACTIVE database, routing one with no file on disk yet (the boot
     * placeholder, a dropped file) to a Save As dialog and adopting the chosen
     * path. Never a silent no-op: a genuine failure REJECTS, and
     * `success: false` always carries the `reason` the page reports.
     */
    saveToDisk(): Promise<SaveResult>;
    /** Re-reads the ACTIVE database from disk, discarding pending edits. */
    refreshFromDisk(): Promise<void>;
    /**
     * Unsaved changes in ANY open database — the app-level question a quit
     * prompt asks. Per-tab dirty marks come from `listDatabases()[].isDirty`.
     */
    hasUnsavedChanges(): boolean;
    currentFilename(): string | null;
}

export function createDesktopHost(options: CreateDesktopHostOptions): DesktopHost;
