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

    /** True when both the sidecar binary and its bundle are shipped. */
    nativeAvailable?(): Promise<boolean>;
    /**
     * Spawns (or replaces) the sidecar bound to `path`. The path must already
     * be session-allowlisted (dialog-picked or OS-delivered). Resolves to the
     * CANONICAL bound path — the exact string the sidecar's argv binding and
     * the shell's per-envelope gate compare against, so `initializeDatabase`'s
     * `config.path` must carry this return value, never the input spelling.
     */
    nativeOpen?(path: string, readOnly: boolean): Promise<string>;
    /**
     * Frames one request envelope (the worker protocol, JSON-encoded with the
     * frame-codec value markers) to the sidecar and resolves the response
     * envelope JSON verbatim. Rejects with structured `ERR_NATIVE_*` reasons
     * on transport-level failures (sidecar exit, refused envelope, caps).
     */
    nativeRpc?(envelopeJson: string): Promise<string>;
    /** Shuts the sidecar down; idempotent. */
    nativeClose?(): Promise<void>;
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
    /** Boots the worker with an empty database. */
    start(): Promise<void>;
    invoke(method: string, args: unknown[]): Promise<unknown>;
    /** Registers webview-side callbacks (e.g. `refreshContent`) the host notifies after mutations. */
    setWebviewMethods(methods: Record<string, (...args: unknown[]) => unknown>): void;
    openDatabaseViaDialog(): Promise<boolean>;
    /** Reads and boots a database at a shell-provided path (native "Open With"/recents). */
    openFromShellPath(path: string): Promise<boolean>;
    openDatabaseFromFile(file: File): Promise<boolean>;
    saveToDisk(): Promise<boolean>;
    refreshFromDisk(): Promise<void>;
    hasUnsavedChanges(): boolean;
    currentFilename(): string | null;
}

export function createDesktopHost(options: CreateDesktopHostOptions): DesktopHost;
