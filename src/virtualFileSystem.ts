import * as vsc from 'vscode';
import { DocumentRegistry } from './documentRegistry';
import { escapeIdentifier, validateRowId } from './core/sql-utils';
import {
    buildRecordIdentityPredicate,
    classifyTableIdentity,
    isPrimaryKeyRecordId,
    primaryKeyColumnsFromTableInfo
} from './core/row-identity';
import {
    isViewDefinitionConflictError,
    isViewDefinitionSnapshotCurrent,
    isViewTriggerSnapshotCurrent
} from './core/view-utils';
import { GlobalOutputChannel } from './main';
import { getMaxInlineCellBytes } from './config';
import {
    assertCellValueWithinEditLimit,
    formatOversizedCellReplacementWarning,
    isOversizedCellReplacementConflictError,
    isOversizedCellReplacementRequiredError
} from './core/cell-edit-policy';

import type {
    DatabaseDocument,
    DocumentContentChange,
    DocumentModification
} from './databaseModel';
import type {
    RecordId,
    TableIdentity,
    ViewDefinition,
    ViewEditResult,
    ViewTriggerDefinition
} from './core/types';

interface ViewDocumentMetadata {
    ctime: number;
    mtime: number;
    view: string;
    uri: vsc.Uri;
    /** Stored CREATE VIEW SQL observed by the editor's most recent read. */
    snapshotSql?: string;
    /** Ordered trigger state paired with snapshotSql for the atomic CAS. */
    snapshotTriggers?: ViewTriggerDefinition[];
    /**
     * Definition supplied by the latest history event. Kept separate from the
     * editor snapshot so a dirty buffer still conflicts with an undo/redo rather
     * than silently adopting the newer CAS baseline. null means the view is gone.
     */
    pendingDefinition?: ViewDefinition | null;
    /** Encoded SELECT-body size cached until the view is externally invalidated. */
    size?: number;
}

function getViewDefinitionErrorDetail(error: unknown): string {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const sqliteMessage = rawMessage
        .replace(/^\[query\]\s*/, '')
        .replace(/^SQLite error(?:\s+\d+)?:\s*/i, '')
        .trim()
        .replace(/\.+$/, '');
    return sqliteMessage || rawMessage;
}

export class SQLiteFileSystemProvider implements vsc.FileSystemProvider {
    readonly onDidChangeFile: vsc.Event<vsc.FileChangeEvent[]>;
    private _emitter = new vsc.EventEmitter<vsc.FileChangeEvent[]>();
    /**
     * TextDocument URIs are immutable for the lifetime of an open VS Code
     * document. Keep the current PK target behind that stable resource URI so
     * saving a key member can retarget subsequent reads and saves without
     * closing the editor or replacing its buffer.
     */
    private readonly cellDocumentTargets = new WeakMap<
        DatabaseDocument,
        Map<string, RecordId>
    >();
    private readonly viewDocumentMetadata = new Map<
        DatabaseDocument,
        Map<string, ViewDocumentMetadata>
    >();
    private readonly viewDocumentDisposals = new Map<DatabaseDocument, vsc.Disposable>();

    constructor() {
        this.onDidChangeFile = this._emitter.event;
    }

    private async resolveTableIdentity(
        document: DatabaseDocument,
        table: string
    ): Promise<TableIdentity> {
        const metadata = await document.databaseOperations.executeQuery(
            `SELECT "type", "wr" FROM pragma_table_list ` +
            `WHERE "schema" = 'main' AND "name" = ? LIMIT 1`,
            [table]
        );
        if ((metadata[0]?.rows.length ?? 0) === 0) throw new Error(`Table not found: ${table}`);
        const kind = classifyTableIdentity(metadata[0].rows[0][0], metadata[0].rows[0][1]);
        if (!kind) throw new Error(`Table not found: ${table}`);
        if (kind === 'rowid') return { kind: 'rowid' };
        const columns = primaryKeyColumnsFromTableInfo(
            await document.databaseOperations.getTableInfo(table)
        );
        if (columns.length === 0) {
            throw new Error(`WITHOUT ROWID table ${table} has no declared primary key`);
        }
        return { kind: 'primaryKey', columns };
    }

    watch(uri: vsc.Uri, options: { recursive: boolean; excludes: string[] }): vsc.Disposable {
        return new vsc.Disposable(() => { });
    }

    async stat(uri: vsc.Uri): Promise<vsc.FileStat> {
        if (this.isLogicalDirectory(uri)) {
            const now = Date.now();
            return {
                type: vsc.FileType.Directory,
                ctime: now,
                mtime: now,
                size: 0
            };
        }

        const { document, table, rowId } = this.parseUri(uri);

        if (rowId === '__view__.sql') {
            const metadata = this.getViewDocumentMetadata(document, uri, table);
            if (metadata.size === undefined) {
                try {
                    if (metadata.pendingDefinition === null) {
                        throw vsc.FileSystemError.FileNotFound(uri);
                    }
                    const definition = metadata.pendingDefinition
                        ?? await document.databaseOperations.getViewDefinition(table);
                    metadata.size = new TextEncoder().encode(definition.selectSql).byteLength;
                } catch (err) {
                    // A missing schema object is a missing virtual document, not a
                    // raw database error from getViewDefinition().
                    if (this.isMissingViewError(err)) {
                        throw vsc.FileSystemError.FileNotFound(uri);
                    }
                    throw err;
                }
            }
            return {
                type: vsc.FileType.File,
                ctime: metadata.ctime,
                mtime: metadata.mtime,
                size: metadata.size,
                permissions: document.isReadOnlyMode
                    ? vsc.FilePermission.Readonly
                    : undefined
            };
        }

        const now = Date.now();
        return {
            type: vsc.FileType.File,
            ctime: now,
            mtime: now,
            size: 0,
            permissions: rowId === '__create__.sql' || document.isReadOnlyMode
                ? vsc.FilePermission.Readonly
                : undefined
        };
    }

    async readDirectory(uri: vsc.Uri): Promise<[string, vsc.FileType][]> {
        // Not really supported or needed for cell editing
        return [];
    }

    async createDirectory(uri: vsc.Uri): Promise<void> {
        // workspace.fs.writeFile has mkdirp semantics. These directories are
        // logical URI ancestors, so creating an existing one is an idempotent
        // no-op; actual cell resources remain non-creatable as directories.
        if (this.isLogicalDirectory(uri)) return;
        throw vsc.FileSystemError.NoPermissions();
    }

    async readFile(uri: vsc.Uri): Promise<Uint8Array> {
        const { document, table, rowId, column } = this.parseUri(uri);

        try {
            if (rowId === '__create__.sql') {
                // Fetch create statement
                // Query sqlite_schema
                const sql = `SELECT sql FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ?`;
                const result = await document.databaseOperations.executeQuery(sql, [table]);
                const createSql = result?.[0]?.rows?.[0]?.[0];
                if (typeof createSql === 'string') {
                    return new TextEncoder().encode(createSql);
                }
                return new Uint8Array(0);
            }

            if (rowId === '__view__.sql') {
                const metadata = this.getViewDocumentMetadata(document, uri, table);
                if (metadata.pendingDefinition === null) {
                    throw vsc.FileSystemError.FileNotFound(uri);
                }
                const definition = metadata.pendingDefinition
                    ?? await document.databaseOperations.getViewDefinition(table);
                metadata.pendingDefinition = undefined;
                metadata.snapshotSql = definition.sql;
                metadata.snapshotTriggers = this.cloneTriggerSnapshot(definition.triggers);
                const content = new TextEncoder().encode(definition.selectSql);
                metadata.size = content.byteLength;
                return content;
            }

            

            // Verify if the target is a valid table or view in the schema.
            const checkQuery = `SELECT 1 FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ?`;
            const checkResult = await document.databaseOperations.executeQuery(checkQuery, [table]);

            if (!checkResult?.[0]?.rows?.length) {
                throw vsc.FileSystemError.FileNotFound(uri);
            }

            const colName = column;
            const targetRowId = this.getCellDocumentTarget(document, uri, rowId);
            let rowPredicate: ReturnType<typeof buildRecordIdentityPredicate>;
            try {
                if (isPrimaryKeyRecordId(targetRowId)) {
                    const identity = await this.resolveTableIdentity(document, table);
                    rowPredicate = buildRecordIdentityPredicate(targetRowId, identity);
                } else {
                    const validatedRowId = validateRowId(targetRowId);
                    rowPredicate = { sql: 'rowid = ?', params: [validatedRowId] };
                }
            } catch {
                return new TextEncoder().encode(`Invalid Row ID: ${rowId}`);
            }

            if (typeof document.databaseOperations.getCellMetadata === 'function') {
                const metadata = await document.databaseOperations.getCellMetadata({
                    table,
                    rowId: targetRowId,
                    column: colName
                });
                if (metadata.byteLength > getMaxInlineCellBytes()) {
                    throw vsc.FileSystemError.NoPermissions(
                        `This oversized ${metadata.storageClass.toUpperCase()} cell is ` +
                        `${metadata.byteLength.toLocaleString()} bytes and cannot be returned by ` +
                        'FileSystemProvider.readFile. Open it from the grid to use a read-only ' +
                        'temporary-file document. Export the cell instead if temporary ' +
                        'materialization is unavailable.'
                    );
                }
            }

            const escapedColumn = escapeIdentifier(colName);
            // Ask SQLite for numeric text in the same read that supplies the
            // cell. A rounded JavaScript Number must never become the contents
            // of an external editor for an unsafe int64 value.
            const query =
                `SELECT ${escapedColumn}, ` +
                `CASE WHEN typeof(${escapedColumn}) IN ('integer', 'real') ` +
                `THEN CAST(${escapedColumn} AS TEXT) END ` +
                `FROM ${escapeIdentifier(table)} WHERE ${rowPredicate.sql}`;
            const result = await document.databaseOperations.executeQuery(query, rowPredicate.params);

            const value = result?.[0]?.rows?.[0]?.[0];
            const exactNumericText = result?.[0]?.rows?.[0]?.[1];

            if (value === null) {
                // Return empty content for NULL values as VS Code expects a string/buffer.
                return new Uint8Array(0);
            }

            if (value instanceof Uint8Array) {
                return value;
            }

            if (typeof exactNumericText === 'string') {
                return new TextEncoder().encode(exactNumericText);
            }

            return new TextEncoder().encode(String(value));

        } catch (err) {
            const details = err instanceof Error ? err.message : String(err);
            GlobalOutputChannel?.appendLine(`[VirtualFileSystem] Error reading file: ${details}`);
            // Preserve deliberate virtual-filesystem decisions (notably a view
            // invalidated as Deleted). Database/worker faults are availability
            // failures, not evidence that the virtual file disappeared.
            if (this.isFileSystemError(err)) throw err;
            if (rowId === '__view__.sql' && this.isMissingViewError(err)) {
                throw vsc.FileSystemError.FileNotFound(uri);
            }
            throw vsc.FileSystemError.Unavailable(details);
        }
    }

    async writeFile(uri: vsc.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
        const { document, table, rowId, column } = this.parseUri(uri);

        if (rowId === '__create__.sql') {
            throw vsc.FileSystemError.NoPermissions('Cannot edit CREATE statement directly');
        }

        if (document.isReadOnlyMode) {
            // Read-only database documents may expose cell files for viewing, but
            // writes must stop before decoding content or recording dirty edits.
            throw vsc.FileSystemError.NoPermissions('Database is read-only');
        }

        const runTrackedMutation = typeof document.runTrackedMutation === 'function'
            ? document.runTrackedMutation.bind(document)
            : async <T>(operation: () => T | PromiseLike<T>) => operation();
        return runTrackedMutation(async () => {

        if (rowId === '__view__.sql') {
            const metadata = this.getViewDocumentMetadata(document, uri, table);
            const connectionGeneration = document.connectionGeneration;
            const databaseOperations = document.databaseOperations;
            if (metadata.snapshotSql !== undefined || metadata.snapshotTriggers !== undefined) {
                let currentDefinition;
                try {
                    currentDefinition = await databaseOperations.getViewDefinition(table);
                } catch (err) {
                    if (this.isMissingViewError(err)) {
                        this.rejectStaleViewWrite(metadata, uri);
                    }
                    throw vsc.FileSystemError.Unavailable(
                        err instanceof Error ? err.message : String(err)
                    );
                }
                if (!isViewDefinitionSnapshotCurrent(
                    metadata.snapshotSql,
                    currentDefinition.sql
                ) || !isViewTriggerSnapshotCurrent(
                    metadata.snapshotTriggers,
                    currentDefinition.triggers
                )) {
                    this.rejectStaleViewWrite(metadata, uri);
                }
            }

            if (document.connectionGeneration !== connectionGeneration) {
                throw vsc.FileSystemError.Unavailable(
                    'The database document was reloaded while the view definition was being saved. ' +
                    'The active document and its history were not updated.'
                );
            }

            let result: ViewEditResult;
            try {
                const selectSql = new TextDecoder('utf-8', { fatal: true }).decode(content);
                result = await databaseOperations.editView(
                    table,
                    selectSql,
                    true,
                    metadata.snapshotSql,
                    metadata.snapshotTriggers
                );
            } catch (err) {
                if (isViewDefinitionConflictError(err)) {
                    this.rejectStaleViewWrite(metadata, uri);
                }
                const rawMessage = err instanceof Error ? err.message : String(err);
                GlobalOutputChannel?.appendLine(`[VirtualFileSystem] Error writing view definition: ${rawMessage}`);
                const detail = getViewDefinitionErrorDetail(err);
                void vsc.window.showErrorMessage(
                    `Invalid view definition: ${detail}. The view was not modified.`
                ).then(undefined, notificationError => {
                    GlobalOutputChannel?.appendLine(
                        `[VirtualFileSystem] Failed to show view error notification: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`
                    );
                });
                throw vsc.FileSystemError.Unavailable(
                    'Invalid view definition. The view was not modified.'
                );
            }

            if (document.connectionGeneration !== connectionGeneration) {
                throw vsc.FileSystemError.Unavailable(
                    'The database document was reloaded while the view definition was being saved. ' +
                    'The active document and its history were not updated.'
                );
            }

            // Update this editor's baseline before recordExternalModification
            // synchronously broadcasts the change to every open URI.
            metadata.snapshotSql = result.after.sql;
            metadata.snapshotTriggers = this.cloneTriggerSnapshot(result.after.triggers);
            document.recordExternalModification({
                label: 'Edit View',
                description: `Edit view ${table} from editor`,
                modificationType: 'view_edit',
                targetTable: table,
                viewDefBefore: result.before,
                viewDefAfter: result.after
            });
            metadata.size = new TextEncoder().encode(result.after.selectSql).byteLength;
            return;
        }

        try {
            const targetRowId = this.getCellDocumentTarget(document, uri, rowId);
            let validatedRowId: RecordId;
            let rowPredicate: ReturnType<typeof buildRecordIdentityPredicate>;
            try {
                if (isPrimaryKeyRecordId(targetRowId)) {
                    const identity = await this.resolveTableIdentity(document, table);
                    rowPredicate = buildRecordIdentityPredicate(targetRowId, identity);
                    validatedRowId = targetRowId;
                } else {
                    validatedRowId = validateRowId(targetRowId);
                    rowPredicate = { sql: 'rowid = ?', params: [validatedRowId] };
                }
            } catch {
                throw vsc.FileSystemError.Unavailable('Invalid Row ID');
            }

           

            let value: string | Uint8Array = content;

            // Try to decode as UTF-8
            try {
                // We strictly try to decode as UTF-8. If the content contains invalid UTF-8 sequences,
                // the TextDecoder with 'fatal: true' will throw, and we will fall back to treating it as a BLOB.
                // This allows saving text containing null bytes, which are valid in UTF-8/SQL TEXT,
                // while correctly handling actual binary data.
                value = new TextDecoder('utf-8', { fatal: true }).decode(content);
            } catch {
                // Keep as Uint8Array, treating as BLOB
            }
            const editLimitBytes = getMaxInlineCellBytes();
            assertCellValueWithinEditLimit(value, editLimitBytes);

            while (true) {
                const metadata = await document.databaseOperations.getCellMetadata({
                    table,
                    rowId: validatedRowId,
                    column
                });
                const oversized = (
                    metadata.storageClass === 'text' || metadata.storageClass === 'blob'
                ) && metadata.byteLength > editLimitBytes;

                if (oversized) {
                    const expected = {
                        storageClass: metadata.storageClass as 'text' | 'blob',
                        byteLength: metadata.byteLength
                    };
                    const answer = await vsc.window.showWarningMessage(
                        formatOversizedCellReplacementWarning(table, column, expected),
                        { modal: true },
                        { title: vsc.l10n.t('Replace Without Undo'), value: true },
                        { title: vsc.l10n.t('Cancel'), value: false, isCloseAffordance: true }
                    );
                    if (!answer?.value) throw new vsc.CancellationError();

                    try {
                        const updatedRowId = await document.databaseOperations.replaceOversizedCell(
                            table,
                            validatedRowId,
                            column,
                            value,
                            expected,
                            editLimitBytes
                        );
                        const newTargetRowId = updatedRowId ?? validatedRowId;
                        if (isPrimaryKeyRecordId(validatedRowId)) {
                            this.setCellDocumentTarget(document, uri, newTargetRowId);
                        }
                        // Future file-backed undo would attach its checksummed
                        // snapshot here and replace this forward-only policy.
                        document.recordExternalModification({
                            label: 'Replace Oversized Cell (External)',
                            description: `Replace oversized ${table}.${column} from editor without undo`,
                            modificationType: 'cell_update',
                            targetTable: table,
                            targetRowId: validatedRowId,
                            ...(isPrimaryKeyRecordId(validatedRowId) ? { newTargetRowId } : {}),
                            targetColumn: column,
                            newValue: value,
                            operation: 'set',
                            undoPolicy: 'barrier'
                        });
                        this._emitter.fire([{ type: vsc.FileChangeType.Changed, uri }]);
                        return;
                    } catch (error) {
                        if (isOversizedCellReplacementConflictError(error)) continue;
                        throw error;
                    }
                }

                const escapedColumn = escapeIdentifier(column);
                const byteLengthExpression =
                    `CASE WHEN ${escapedColumn} IS NULL THEN 0 ` +
                    `ELSE length(CAST(${escapedColumn} AS BLOB)) END`;
                const previous = await document.databaseOperations.executeQuery(
                    `SELECT typeof(${escapedColumn}), ${byteLengthExpression}, ` +
                    `CASE WHEN typeof(${escapedColumn}) IN ('text', 'blob') ` +
                    `AND ${byteLengthExpression} > ? THEN NULL ELSE ${escapedColumn} END ` +
                    `FROM ${escapeIdentifier(table)} WHERE ${rowPredicate.sql} LIMIT 2`,
                    [editLimitBytes, ...rowPredicate.params]
                );
                if (previous[0]?.rows.length !== 1) {
                    throw new Error(`Cannot update ${table}.${column}: row identity no longer exists`);
                }
                const [storageClass, rawByteLength, boundedValue] = previous[0].rows[0];
                const byteLength = typeof rawByteLength === 'bigint'
                    ? Number(rawByteLength)
                    : rawByteLength;
                if (
                    (storageClass === 'text' || storageClass === 'blob')
                    && Number(byteLength) > editLimitBytes
                ) {
                    // The CASE above deliberately returned NULL instead of
                    // the raced oversized payload. Re-read and confirm it.
                    continue;
                }
                const keyColumnIndex = rowPredicate.primaryKey?.columns.indexOf(column) ?? -1;
                const priorValue = keyColumnIndex >= 0
                    ? rowPredicate.primaryKey!.values[keyColumnIndex]
                    : boundedValue;

                let updatedRowId: RecordId | void;
                try {
                    updatedRowId = await document.databaseOperations.updateCell(
                        table,
                        validatedRowId,
                        column,
                        value,
                        undefined,
                        editLimitBytes
                    );
                } catch (error) {
                    if (isOversizedCellReplacementRequiredError(error)) continue;
                    throw error;
                }
                const newTargetRowId = updatedRowId ?? validatedRowId;
                if (isPrimaryKeyRecordId(validatedRowId)) {
                    this.setCellDocumentTarget(document, uri, newTargetRowId);
                }

                document.recordExternalModification({
                    label: 'Edit Cell (External)',
                    description: `Update ${table}.${column} from editor`,
                    modificationType: 'cell_update',
                    targetTable: table,
                    targetRowId: validatedRowId,
                    ...(isPrimaryKeyRecordId(validatedRowId) ? { newTargetRowId } : {}),
                    targetColumn: column,
                    priorValue,
                    newValue: value
                });

                this._emitter.fire([{ type: vsc.FileChangeType.Changed, uri }]);
                return;
            }

        } catch (err) {
            GlobalOutputChannel?.appendLine(`[VirtualFileSystem] Error writing cell: ${err instanceof Error ? err.message : String(err)}`);
            throw vsc.FileSystemError.Unavailable(err instanceof Error ? err.message : String(err));
        }
        });
    }

    async delete(uri: vsc.Uri, options: { recursive: boolean }): Promise<void> {
        throw vsc.FileSystemError.NoPermissions();
    }

    async rename(oldUri: vsc.Uri, newUri: vsc.Uri, options: { overwrite: boolean }): Promise<void> {
        throw vsc.FileSystemError.NoPermissions();
    }

    private getCellDocumentTarget(
        document: DatabaseDocument,
        uri: vsc.Uri,
        uriRowId: string
    ): RecordId {
        if (!isPrimaryKeyRecordId(uriRowId)) return uriRowId;
        return this.cellDocumentTargets.get(document)?.get(uri.toString()) ?? uriRowId;
    }

    private setCellDocumentTarget(
        document: DatabaseDocument,
        uri: vsc.Uri,
        rowId: RecordId
    ): void {
        let targets = this.cellDocumentTargets.get(document);
        if (!targets) {
            targets = new Map<string, RecordId>();
            this.cellDocumentTargets.set(document, targets);
        }
        targets.set(uri.toString(), rowId);
    }

    private isLogicalDirectory(uri: vsc.Uri): boolean {
        const pathParts = uri.path.split('/').filter(part => part.length > 0);
        if (pathParts.length === 0) return true;
        if (pathParts.length > 4) return false;

        const documentKey = decodeURIComponent(pathParts[0]);
        if (!DocumentRegistry.has(documentKey)) {
            throw vsc.FileSystemError.FileNotFound(uri);
        }
        return true;
    }

    private parseUri(uri: vsc.Uri): { document: DatabaseDocument, table: string, rowId: string, column: string } {
        // Path format: /<document_key>/<table>/<name>/<rowid>/<filename>
        // Note: VS Code URIs usually have a leading slash in path
        const pathParts = uri.path.split('/').filter(p => p.length > 0);

        // Path format structure:
        // [0] documentKey
        // [1] table
        // [2] name (optional grouping)
        // [3] rowId
        // [4] filename (colName + ext)

        if (pathParts.length < 4) {
            throw vsc.FileSystemError.FileNotFound(uri);
        }

        const documentKey = decodeURIComponent(pathParts[0]);
        const table = decodeURIComponent(pathParts[1]);
        // pathParts[2] is grouping name, ignore
        const rowId = decodeURIComponent(pathParts[3]);

        let column = '';
        if (pathParts.length > 4) {
            const filename = decodeURIComponent(pathParts[4]);
            const lastDotIndex = filename.lastIndexOf('.');
            column = lastDotIndex > 0 ? filename.substring(0, lastDotIndex) : filename;
        }

        const document = DocumentRegistry.get(documentKey);
        if (!document) {
            throw vsc.FileSystemError.FileNotFound(uri);
        }

        return { document, table, rowId, column };
    }

    private getViewDocumentMetadata(
        document: DatabaseDocument,
        uri: vsc.Uri,
        view: string
    ): ViewDocumentMetadata {
        let documentMetadata = this.viewDocumentMetadata.get(document);
        if (!documentMetadata) {
            documentMetadata = new Map();
            this.viewDocumentMetadata.set(document, documentMetadata);

            const contentChangeSubscription = document.onDidChangeContent(change => {
                this.handleDocumentContentChange(document, change);
            });
            let disposeSubscription: vsc.Disposable = { dispose() {} };
            const combinedSubscription: vsc.Disposable = {
                dispose: () => {
                    contentChangeSubscription.dispose();
                    disposeSubscription.dispose();
                }
            };
            disposeSubscription = document.onDidDispose(() => {
                this.viewDocumentMetadata.delete(document);
                this.viewDocumentDisposals.delete(document);
                combinedSubscription.dispose();
            });
            this.viewDocumentDisposals.set(document, combinedSubscription);
        }

        const key = uri.toString();
        let metadata = documentMetadata.get(key);
        if (!metadata) {
            const now = Date.now();
            metadata = { ctime: now, mtime: now, view, uri };
            documentMetadata.set(key, metadata);
        }
        return metadata;
    }

    private handleDocumentContentChange(
        document: DatabaseDocument,
        change: DocumentContentChange
    ): void {
        const documentMetadata = this.viewDocumentMetadata.get(document);
        if (!documentMetadata) return;

        if (change.invalidateAllViewDocuments) {
            void this.invalidateAllTrackedViewDocuments(document, documentMetadata);
            return;
        }

        const modification = change.modification;
        if (!modification || !this.isViewModification(modification) || !modification.targetTable) {
            return;
        }

        const direction = change.modificationDirection ?? 'forward';
        const fileChangeType = this.getViewFileChangeType(modification, direction);
        const pendingDefinition = this.getViewDefinitionAfterChange(
            modification,
            direction,
            fileChangeType
        );
        const changes: vsc.FileChangeEvent[] = [];
        for (const metadata of documentMetadata.values()) {
            if (metadata.view !== modification.targetTable) continue;
            metadata.pendingDefinition = pendingDefinition;
            metadata.size = pendingDefinition
                ? new TextEncoder().encode(pendingDefinition.selectSql).byteLength
                : undefined;
            this.bumpViewDocumentMtime(metadata);
            changes.push({
                type: fileChangeType,
                uri: metadata.uri
            });
        }
        if (changes.length > 0) this._emitter.fire(changes);
    }

    private async invalidateAllTrackedViewDocuments(
        document: DatabaseDocument,
        documentMetadata: Map<string, ViewDocumentMetadata>
    ): Promise<void> {
        let existingViews: Set<string> | undefined;
        try {
            const schema = await document.databaseOperations.fetchSchema();
            existingViews = new Set(schema.views.map(view => view.identifier));
        } catch (error) {
            // A reload must still invalidate cached contents if schema
            // classification fails. Falling back to Changed preserves the old
            // behavior without silently hiding the diagnostic.
            GlobalOutputChannel?.appendLine(
                `[VirtualFileSystem] Failed to classify view documents after reload: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        // The database document may have closed while the schema request was in
        // flight. Its metadata and subscriptions are already gone in that case.
        if (this.viewDocumentMetadata.get(document) !== documentMetadata) return;

        const changes: vsc.FileChangeEvent[] = [];
        for (const metadata of documentMetadata.values()) {
            const viewStillExists = existingViews?.has(metadata.view) ?? true;
            metadata.pendingDefinition = viewStillExists ? undefined : null;
            metadata.size = undefined;
            this.bumpViewDocumentMtime(metadata);
            changes.push({
                type: viewStillExists
                    ? vsc.FileChangeType.Changed
                    : vsc.FileChangeType.Deleted,
                uri: metadata.uri
            });
        }
        if (changes.length > 0) this._emitter.fire(changes);
    }

    private isViewModification(modification: DocumentModification): boolean {
        return modification.modificationType === 'view_create'
            || modification.modificationType === 'view_edit'
            || modification.modificationType === 'view_drop';
    }

    private getViewFileChangeType(
        modification: DocumentModification,
        direction: 'forward' | 'undo'
    ): vsc.FileChangeType {
        if (modification.modificationType === 'view_edit') {
            return vsc.FileChangeType.Changed;
        }
        const createsView = modification.modificationType === 'view_create';
        const existsAfterChange = direction === 'forward' ? createsView : !createsView;
        return existsAfterChange
            ? vsc.FileChangeType.Created
            : vsc.FileChangeType.Deleted;
    }

    private getViewDefinitionAfterChange(
        modification: DocumentModification,
        direction: 'forward' | 'undo',
        fileChangeType: vsc.FileChangeType
    ): ViewDefinition | null | undefined {
        if (fileChangeType === vsc.FileChangeType.Deleted) return null;
        return direction === 'forward'
            ? modification.viewDefAfter
            : modification.viewDefBefore;
    }

    private cloneTriggerSnapshot(
        triggers: readonly ViewTriggerDefinition[] | undefined
    ): ViewTriggerDefinition[] {
        return (triggers ?? []).map(trigger => ({
            identifier: trigger.identifier,
            sql: trigger.sql,
            ...(trigger.temporary ? { temporary: true } : {})
        }));
    }

    private bumpViewDocumentMtime(metadata: ViewDocumentMetadata): void {
        metadata.mtime = Math.max(Date.now(), metadata.mtime + 1);
    }

    private rejectStaleViewWrite(
        metadata: ViewDocumentMetadata,
        uri: vsc.Uri
    ): never {
        metadata.size = undefined;
        this.bumpViewDocumentMtime(metadata);
        this._emitter.fire([{ type: vsc.FileChangeType.Changed, uri }]);
        throw vsc.FileSystemError.Unavailable(
            'The view changed outside this editor. Reload before saving; the view was not modified.'
        );
    }

    private isMissingViewError(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error);
        return /\bView not found:/i.test(message);
    }

    private isFileSystemError(error: unknown): error is vsc.FileSystemError {
        if (!(error instanceof Error)) return false;
        const code = (error as Error & { code?: unknown }).code;
        return typeof code === 'string' && [
            'FileExists',
            'FileNotFound',
            'FileNotADirectory',
            'FileIsADirectory',
            'NoPermissions',
            'Unavailable'
        ].includes(code);
    }
}
