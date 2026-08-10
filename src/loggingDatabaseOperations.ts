/**
 * Logging Wrapper for Database Operations
 *
 * Intercepts calls to DatabaseOperations and logs SQL queries/actions
 * to the VS Code output channel.
 */

import * as vsc from 'vscode';
import { hash64, maskSensitiveData } from './helpers';
import type {
    DatabaseOperations,
    CellValue,
    RecordId,
    DeletedRow,
    QueryResultSet,
    ModificationEntry,
    CellUpdate,
    CellUpdateResult,
    TableQueryOptions,
    TableCountOptions,
    TableCountResult,
    SchemaSnapshot,
    ColumnMetadata,
    ColumnDefinition,
    ViewDefinition,
    ViewDefinitionIntent,
    ViewEditResult,
    ViewTriggerDefinition,
    CellMetadata,
    CellReadChunk,
    CellReadSession,
    CellReadTarget,
    OversizedCellMetadata,
    DatabaseWriteResult,
    ColumnDropTableState
} from './core/types';
import { escapeIdentifier } from './core/sql-utils';
import { buildSelectQuery, buildCountQuery } from './core/query-builder';
import { runReadSnapshot } from './core/operation-serializer';

type DatabaseMethodName = Exclude<{
    [K in keyof DatabaseOperations]: DatabaseOperations[K] extends (...args: never[]) => unknown ? K : never
}[keyof DatabaseOperations], undefined | 'runReadSnapshot'> & keyof DatabaseOperations;

const MAX_INLINE_LOG_IDENTITY_CHARS = 160;
const LOG_IDENTITY_PREVIEW_CHARS = 48;
const MAX_DELETE_LOG_IDENTITIES = 8;

export class LoggingDatabaseOperations implements DatabaseOperations {
    readonly openQueryReadSession?: NonNullable<DatabaseOperations['openQueryReadSession']>;
    readonly readQueryRows?: NonNullable<DatabaseOperations['readQueryRows']>;
    readonly closeQueryReadSession?: NonNullable<DatabaseOperations['closeQueryReadSession']>;

    constructor(
        private readonly wrapped: DatabaseOperations,
        private readonly filename: string,
        private readonly outputChannel: vsc.OutputChannel
    ) {
        const openQueryReadSession = wrapped.openQueryReadSession;
        const readQueryRows = wrapped.readQueryRows;
        const closeQueryReadSession = wrapped.closeQueryReadSession;
        if (openQueryReadSession && readQueryRows && closeQueryReadSession) {
            this.openQueryReadSession = async (sql: string) => {
                this.log('Opening incremental query read');
                return openQueryReadSession.call(wrapped, sql);
            };
            this.readQueryRows = async (sessionId: string, maxRows: number) => {
                this.log(`Reading up to ${maxRows} incremental query rows`);
                return readQueryRows.call(wrapped, sessionId, maxRows);
            };
            this.closeQueryReadSession = async (sessionId: string) => {
                this.log('Closing incremental query read');
                return closeQueryReadSession.call(wrapped, sessionId);
            };
        }
    }

    get engineKind() {
        return this.wrapped.engineKind;
    }

    async runReadSnapshot<T>(
        operation: (snapshotOperations: DatabaseOperations) => Promise<T>
    ): Promise<T> {
        return runReadSnapshot(this.wrapped, snapshotOperations => operation(
            new LoggingDatabaseOperations(snapshotOperations, this.filename, this.outputChannel)
        ));
    }

    private sanitizeValue(value: unknown): string {
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';
        if (typeof value === 'string') {
            if (value.length > 100) {
                return `"${value.substring(0, 100)}...[TRUNCATED]"`;
            }
            return `"${value}"`;
        }
        if (value instanceof Uint8Array || (typeof value === 'object' && value !== null && 'buffer' in value)) {
            return `[BLOB ${(value as { byteLength?: number }).byteLength ?? 0} bytes]`;
        }
        if (typeof value === 'object') {
             try {
                 return JSON.stringify(value).substring(0, 100) + '...';
             } catch {
                 return '[Object]';
             }
        }
        return String(value);
    }

    private async formatRecordId(rowId: RecordId): Promise<string> {
        if (typeof rowId === 'number') return String(rowId);
        if (rowId.length <= MAX_INLINE_LOG_IDENTITY_CHARS) return JSON.stringify(rowId);

        const digest = await hash64(rowId);
        const preview = `${rowId.slice(0, LOG_IDENTITY_PREVIEW_CHARS)}…`;
        return `[identity length=${rowId.length} sha256=${digest} preview=${JSON.stringify(preview)}]`;
    }

    // Constrain T to only callable (function) members of DatabaseOperations,
    // excluding non-function properties like `engineKind` (which is a Promise).
    private async logAndDelegate<T extends DatabaseMethodName>(
        message: string,
        isWrite: boolean,
        method: T,
        ...args: Parameters<Extract<DatabaseOperations[T], (...args: never[]) => unknown>>
    ): Promise<ReturnType<Extract<DatabaseOperations[T], (...args: never[]) => unknown>>> {
        this.log(message, isWrite);
        const func = this.wrapped[method] as unknown as (...args: unknown[]) => unknown;
        // Invoke through the receiver: implementations may rely on `this`.
        return func.apply(this.wrapped, args) as ReturnType<Extract<DatabaseOperations[T], (...args: never[]) => unknown>>;
    }

    private log(message: string, isWrite: boolean = false) {
        const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
        const type = isWrite ? '[WRITE]' : '[read] ';

        // Basic PII/Secret masking in the log message itself if it contains SQL values directly
        // This is a heuristic attempt to mask email-like or key-like patterns in raw SQL
        const safeMessage = maskSensitiveData(message);

        this.outputChannel.appendLine(`${timestamp} ${type} [${this.filename}] ${safeMessage}`);
    }

    async executeQuery(
        sql: string,
        params?: CellValue[],
        signal?: AbortSignal
    ): Promise<QueryResultSet[]> {
        const isWrite = /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim());
        const paramStr = params && params.length > 0 ? ` -- params: [${params.map(p => this.sanitizeValue(p)).join(', ')}]` : '';
        this.log(`${sql}${paramStr}`, isWrite);
        return this.wrapped.executeQuery(sql, params, signal);
    }

    async getCellMetadata(target: CellReadTarget): Promise<CellMetadata> {
        return this.logAndDelegate(
            `Reading cell metadata for ${escapeIdentifier(target.table)}.${escapeIdentifier(target.column)}`,
            false,
            'getCellMetadata',
            target
        );
    }

    async openCellReadSession(target: CellReadTarget): Promise<CellReadSession> {
        return this.logAndDelegate(
            `Opening bounded cell read for ${escapeIdentifier(target.table)}.${escapeIdentifier(target.column)}`,
            false,
            'openCellReadSession',
            target
        );
    }

    async readCellChunk(
        sessionId: string,
        byteOffset: number,
        maxBytes: number
    ): Promise<CellReadChunk> {
        return this.logAndDelegate(
            `Reading bounded cell bytes at offset ${byteOffset} (limit ${maxBytes})`,
            false,
            'readCellChunk',
            sessionId,
            byteOffset,
            maxBytes
        );
    }

    async closeCellReadSession(sessionId: string): Promise<void> {
        return this.logAndDelegate(
            'Closing bounded cell read',
            false,
            'closeCellReadSession',
            sessionId
        );
    }

    async serializeDatabase(): Promise<Uint8Array> {
        return this.logAndDelegate(`Exporting database`, false, 'serializeDatabase');
    }

    async applyModifications(mods: ModificationEntry[], signal?: AbortSignal): Promise<void> {
        return this.logAndDelegate(`Applying ${mods.length} modifications`, true, 'applyModifications', mods, signal);
    }

    async undoModification(mod: ModificationEntry): Promise<void> {
        return this.logAndDelegate(`Undo: ${mod.description}`, true, 'undoModification', mod);
    }

    async redoModification(mod: ModificationEntry): Promise<void> {
        return this.logAndDelegate(`Redo: ${mod.description}`, true, 'redoModification', mod);
    }

    async flushChanges(signal?: AbortSignal): Promise<void> {
        return this.logAndDelegate('Flushing changes', true, 'flushChanges', signal);
    }

    async discardModifications(mods: ModificationEntry[], signal?: AbortSignal): Promise<void> {
        return this.logAndDelegate(`Discarding ${mods.length} modifications`, true, 'discardModifications', mods, signal);
    }

    async updateCell(
        table: string,
        rowId: RecordId,
        column: string,
        value: CellValue,
        patch?: string,
        maxEditValueBytes?: number
    ): Promise<RecordId | void> {
        // Reconstruct SQL for logging
        const loggedRowId = await this.formatRecordId(rowId);
        let sql;
        if (patch) {
            sql = `UPDATE ${escapeIdentifier(table)} SET ${escapeIdentifier(column)} = json_patch(${escapeIdentifier(column)}, ${this.sanitizeValue(patch)}) WHERE identity = ${loggedRowId}`;
        } else {
            sql = `UPDATE ${escapeIdentifier(table)} SET ${escapeIdentifier(column)} = ${this.sanitizeValue(value)} WHERE identity = ${loggedRowId}`;
        }
        this.log(sql, true);
        return this.wrapped.updateCell(table, rowId, column, value, patch, maxEditValueBytes);
    }

    async replaceOversizedCell(
        table: string,
        rowId: RecordId,
        column: string,
        value: CellValue,
        expected: OversizedCellMetadata,
        maxEditValueBytes?: number
    ): Promise<RecordId | void> {
        this.log(
            `Replacing confirmed oversized ${escapeIdentifier(table)}.${escapeIdentifier(column)} ` +
            `(${expected.storageClass}, ${expected.byteLength} bytes) without in-memory undo`,
            true
        );
        return this.wrapped.replaceOversizedCell(
            table,
            rowId,
            column,
            value,
            expected,
            maxEditValueBytes
        );
    }

    async insertRow(
        table: string,
        data: Record<string, CellValue>,
        maxEditValueBytes?: number
    ): Promise<RecordId | undefined> {
        const columns = Object.keys(data);
        let sql;
        if (columns.length === 0) {
            sql = `INSERT INTO ${escapeIdentifier(table)} DEFAULT VALUES`;
        } else {
            const colNames = columns.map(escapeIdentifier).join(', ');
            // Use sanitizeValue for logging values
            const values = columns.map(c => this.sanitizeValue(data[c])).join(', ');
            sql = `INSERT INTO ${escapeIdentifier(table)} (${colNames}) VALUES (${values})`;
        }
        this.log(sql, true);
        return this.wrapped.insertRow(table, data, maxEditValueBytes);
    }

    async insertRowBatch(
        table: string,
        rows: Record<string, CellValue>[],
        maxEditValueBytes?: number
    ): Promise<void> {
        this.log(`INSERT batch: ${rows.length} rows into ${escapeIdentifier(table)}`, true);
        return this.wrapped.insertRowBatch(table, rows, maxEditValueBytes);
    }

    async deleteRows(
        table: string,
        rowIds: RecordId[],
        maxUndoSnapshotBytes?: number
    ): Promise<DeletedRow[]> {
        const displayedIds = await Promise.all(
            rowIds.slice(0, MAX_DELETE_LOG_IDENTITIES).map(rowId => this.formatRecordId(rowId))
        );
        const omitted = rowIds.length - displayedIds.length;
        const sql =
            `DELETE FROM ${escapeIdentifier(table)} WHERE identity IN (${displayedIds.join(', ')}) ` +
            `-- ${rowIds.length} identities` +
            (omitted > 0 ? `, showing ${displayedIds.length}; ${omitted} omitted` : '');
        this.log(sql, true);
        return this.wrapped.deleteRows(table, rowIds, maxUndoSnapshotBytes);
    }

    async deleteColumns(
        table: string,
        columns: string[],
        dropDependentIndexes?: string[]
    ): Promise<ColumnDropTableState> {
        if (dropDependentIndexes && dropDependentIndexes.length > 0) {
            for (const indexName of dropDependentIndexes) {
                this.log(`DROP INDEX IF EXISTS ${escapeIdentifier(indexName)}`, true);
            }
        }
        for (const col of columns) {
            this.log(`ALTER TABLE ${escapeIdentifier(table)} DROP COLUMN ${escapeIdentifier(col)}`, true);
        }
        return this.wrapped.deleteColumns(table, columns, dropDependentIndexes);
    }

    async findDependentIndexes(table: string, columns: string[]): Promise<string[]> {
        this.log(`Finding dependent indexes for ${escapeIdentifier(table)} columns: ${columns.join(', ')}`, false);
        return this.wrapped.findDependentIndexes(table, columns);
    }

    async createTable(table: string, columns: ColumnDefinition[]): Promise<void> {
        const columnDefs = columns.map(c => `${c.name} ${c.type}`).join(', ');
        const sql = `CREATE TABLE ${escapeIdentifier(table)} (${columnDefs})`;
        this.log(sql, true);
        return this.wrapped.createTable(table, columns);
    }

    async getViewDefinition(view: string): Promise<ViewDefinition> {
        return this.logAndDelegate(`Reading view ${escapeIdentifier(view)}`, false, 'getViewDefinition', view);
    }

    async validateViewDefinition(
        view: string,
        selectSql: string,
        intent?: ViewDefinitionIntent
    ): Promise<void> {
        return this.logAndDelegate(
            `Validating view ${escapeIdentifier(view)}`,
            false,
            'validateViewDefinition',
            view,
            selectSql,
            intent
        );
    }

    async previewViewDefinition(
        view: string,
        selectSql: string,
        limit?: number,
        intent?: ViewDefinitionIntent,
        signal?: AbortSignal
    ): Promise<QueryResultSet> {
        return this.logAndDelegate(
            `Previewing view ${escapeIdentifier(view)}`,
            false,
            'previewViewDefinition',
            view,
            selectSql,
            limit,
            intent,
            signal
        );
    }

    async createView(view: string, selectSql: string): Promise<ViewDefinition> {
        return this.logAndDelegate(
            `CREATE VIEW ${escapeIdentifier(view)} AS ${this.sanitizeValue(selectSql)}`,
            true,
            'createView',
            view,
            selectSql
        );
    }

    async editView(
        view: string,
        selectSql: string,
        preserveTriggers?: boolean,
        expectedSql?: string,
        expectedTriggers?: readonly ViewTriggerDefinition[]
    ): Promise<ViewEditResult> {
        return this.logAndDelegate(
            `Replacing view ${escapeIdentifier(view)} with ${this.sanitizeValue(selectSql)} (preserve triggers: ${preserveTriggers !== false})`,
            true,
            'editView',
            view,
            selectSql,
            preserveTriggers,
            expectedSql,
            expectedTriggers
        );
    }

    async dropView(
        view: string,
        expectedSql?: string,
        expectedTriggers?: readonly ViewTriggerDefinition[]
    ): Promise<ViewDefinition> {
        return this.logAndDelegate(
            `DROP VIEW ${escapeIdentifier(view)}`,
            true,
            'dropView',
            view,
            expectedSql,
            expectedTriggers
        );
    }

    async updateCellBatch(
        table: string,
        updates: CellUpdate[],
        maxEditValueBytes?: number,
        maxUndoSnapshotBytes?: number
    ): Promise<CellUpdateResult[]> {
        this.log(`Batch update ${updates.length} cells in ${table}`, true);
        return this.wrapped.updateCellBatch(
            table,
            updates,
            maxEditValueBytes,
            maxUndoSnapshotBytes
        );
    }

    async addColumn(table: string, column: string, type: string, defaultValue?: string): Promise<void> {
        let sql = `ALTER TABLE ${escapeIdentifier(table)} ADD COLUMN ${escapeIdentifier(column)} ${type}`;
        if (defaultValue) {
             sql += ` DEFAULT ${defaultValue}`;
        }
        this.log(sql, true);
        return this.wrapped.addColumn(table, column, type, defaultValue);
    }

    async fetchTableData(table: string, options: TableQueryOptions): Promise<QueryResultSet> {
        const { sql, params } = buildSelectQuery(table, options);
        const paramStr = params && params.length > 0 ? ` -- params: [${params.map(p => this.sanitizeValue(p)).join(', ')}]` : '';
        // The engine resolves keyset requests itself (identity lookup +
        // anchor validation), so this preview can only show the OFFSET shape.
        const keysetStr = options.keyset ? ` -- keyset ${options.keyset.mode} requested; OFFSET shape shown` : '';
        this.log(`${sql}${paramStr}${keysetStr}`, false);
        return this.wrapped.fetchTableData(table, options);
    }

    async fetchTableCount(table: string, options: TableCountOptions): Promise<TableCountResult> {
        const { sql, params } = buildCountQuery(table, options);
        const paramStr = params && params.length > 0 ? ` -- params: [${params.map(p => this.sanitizeValue(p)).join(', ')}]` : '';
        this.log(`${sql}${paramStr}`, false);
        return this.wrapped.fetchTableCount(table, options);
    }

    async fetchSchema(): Promise<SchemaSnapshot> {
        return this.logAndDelegate(`Fetching schema`, false, 'fetchSchema');
    }

    async getTableInfo(table: string): Promise<ColumnMetadata[]> {
        return this.logAndDelegate(`PRAGMA table_info(${escapeIdentifier(table)})`, false, 'getTableInfo', table);
    }

    async getPragmas(): Promise<Record<string, CellValue>> {
        return this.logAndDelegate('Fetching PRAGMAs', false, 'getPragmas');
    }

    async setPragma(pragma: string, value: CellValue): Promise<void> {
        return this.logAndDelegate(`PRAGMA ${pragma} = ${this.sanitizeValue(value)}`, true, 'setPragma', pragma, value);
    }

    async ping(): Promise<boolean> {
        return this.wrapped.ping();
    }

    async writeToFile(
        path: string,
        signal?: AbortSignal
    ): Promise<DatabaseWriteResult | void> {
        return this.logAndDelegate(
            `Writing to file: ${path}`,
            true,
            'writeToFile',
            path,
            signal
        );
    }
}
