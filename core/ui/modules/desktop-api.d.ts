/**
 * Types for desktop-api.js — the backendApi swap target for the Tauri
 * desktop build. Every backendApi method is a thin sendRpcRequest(method,
 * args) wrapper around DesktopHost.invoke (desktop-host.d.ts), so args and
 * returns are typed at the same fidelity as that boundary: unknown in,
 * unknown out. Table/column/view/pragma names and the handful of concepts
 * already typed elsewhere in the repo (RecordId, CellValue) are typed
 * precisely; opaque payloads (query options, row data, extension settings)
 * are left unknown for callers to narrow, matching host.invoke's own
 * contract.
 */
import type { RecordId, CellValue } from '../../../src/core/types';

/** Minimal host surface desktop-api.js depends on (see DesktopHost in desktop-host.d.ts). */
export interface DesktopApiHost {
    invoke(method: string, args: unknown[]): Promise<unknown>;
}

export const RPC_TIMEOUT_MS: number;
export function getRpcTimeoutMs(method: string): number | undefined;

/** Wires backendApi's RPC calls to the desktop host; must be called before any backendApi method. */
export function initDesktopApi(hostInstance: DesktopApiHost): void;
export function sendRpcRequest(method: string, args: unknown[]): Promise<unknown>;

// Import-parity no-ops: the desktop build has no message channel.
export function handleRpcResponse(message: unknown): void;
export function sendRpcResult(correlationId: string, result: unknown): void;
export function sendRpcError(correlationId: string, error: unknown): void;

/** Backed by localStorage (key: sqlite-explorer-view-state); WKWebView persists it across launches. */
export function getVsCodeState(): object | undefined;
export function saveVsCodeState(stateObj: unknown): void;

export interface DesktopBackendApi {
    initialize(): Promise<unknown>;
    saveSidebarState(state: unknown): Promise<unknown>;
    exportDb(filename: string): Promise<unknown>;
    refreshFile(): Promise<unknown>;
    fireEditEvent(edit: unknown): Promise<unknown>;
    exportTable(
        dbParams: unknown,
        columns: unknown,
        dbOptions: unknown,
        tableStore: unknown,
        exportOptions: unknown,
        extras?: unknown
    ): Promise<unknown>;

    // Database operations
    updateCell(
        table: string,
        rowId: RecordId,
        column: string,
        value: CellValue,
        originalValue: CellValue
    ): Promise<unknown>;
    getCellMetadata(target: unknown): Promise<unknown>;
    openCellReadSession(target: unknown): Promise<unknown>;
    readCellChunk(sessionId: string, byteOffset: number, maxBytes: number): Promise<unknown>;
    closeCellReadSession(sessionId: string): Promise<unknown>;
    insertRow(table: string, data: Record<string, unknown>): Promise<unknown>;
    deleteRows(table: string, rowIds: RecordId[]): Promise<unknown>;
    deleteColumns(table: string, columns: string[]): Promise<unknown>;
    createTable(table: string, columns: unknown): Promise<unknown>;
    getViewDefinition(view: string): Promise<unknown>;
    validateViewDefinition(view: string, selectSql: string, intent?: unknown): Promise<unknown>;
    previewViewDefinition(view: string, selectSql: string, limit: number, intent?: unknown): Promise<unknown>;
    createView(view: string, selectSql: string): Promise<unknown>;
    editView(
        view: string,
        selectSql: string,
        preserveTriggers: boolean,
        expectedSql?: string,
        expectedTriggers?: unknown
    ): Promise<unknown>;
    dropView(view: string): Promise<unknown>;
    updateCellBatch(table: string, updates: unknown[], label?: string): Promise<unknown>;
    addColumn(table: string, column: string, type: string, defaultValue?: unknown): Promise<unknown>;
    fetchTableData(table: string, options: unknown): Promise<unknown>;
    fetchTableCount(table: string, options: unknown): Promise<unknown>;
    fetchSchema(): Promise<unknown>;
    /**
     * Desktop-only: runs an ad hoc, possibly multi-statement script for the
     * SQL console. Resolves with the worker's runConsole payload (typed as
     * ConsoleRunResult by the console results module) and rejects with the
     * first failing statement's error.
     */
    runConsole(sql: string, options?: { maxRows?: number }): Promise<unknown>;
    getTableInfo(table: string): Promise<unknown>;
    getPragmas(): Promise<unknown>;
    setPragma(pragma: string, value: unknown): Promise<unknown>;
    getExtensionSettings(): Promise<unknown>;
    updateExtensionSetting(key: string, value: unknown): Promise<unknown>;
    ping(): Promise<unknown>;

    // Graceful-degradation stubs (same as web-api.js): the modal editing path covers these.
    prepareCellMediaPreview(
        params: unknown,
        rowId: RecordId,
        colName: string,
        options?: { sourceByteLength?: number }
    ): Promise<{ success: boolean; message?: string }>;
    releaseCellMediaPreview(): Promise<void>;
    openCellEditor(
        params: unknown,
        rowId: RecordId,
        colName: string,
        colTypes: unknown,
        options?: { sourceByteLength?: number }
    ): Promise<{ success: boolean; message?: string }>;
    openViewEditor(): Promise<{ success: boolean; message?: string }>;
    readWorkspaceFileUri(): Promise<string | null>;
    triggerUndo(): Promise<unknown>;
    triggerRedo(): Promise<unknown>;

    saveFile(filename: string, data: Uint8Array): Promise<unknown>;
    selectFile(): Promise<{ name: string; data: Uint8Array } | undefined>;
}

export const backendApi: DesktopBackendApi;
