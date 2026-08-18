/**
 * Types for desktop-host.js — the Tauri desktop host that owns the sql.js
 * worker, undo/redo history, settings, and bridge-backed file I/O.
 */

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
    /** Resolves to the chosen path, or null if the user cancelled the dialog. */
    saveFileAs(defaultName: string, bytes: Uint8Array): Promise<string | null>;
    loadSettings(): Promise<Record<string, unknown>>;
    saveSettings(settings: Record<string, unknown>): Promise<void>;
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
     * Signals the webview has finished booting. Optional for the same reason
     * as {@link onOpenFile}.
     */
    viewerReady?(): Promise<void>;

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
    /** Opens a database at a shell-provided path (native "Open With"/recents). */
    openFromShellPath(path: string): Promise<boolean>;
    openDatabaseFromFile(file: File): Promise<boolean>;

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

    /** Saves the ACTIVE database. */
    saveToDisk(): Promise<boolean>;
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
