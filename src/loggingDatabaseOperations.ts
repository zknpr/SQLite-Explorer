/**
 * Logging Wrapper for Database Operations
 *
 * Intercepts calls to DatabaseOperations and logs SQL queries/actions
 * to the VS Code output channel.
 */

import * as vsc from 'vscode';
import { maskSensitiveData } from './helpers';
import type {
    DatabaseOperations,
    CellValue,
    RecordId,
    QueryResultSet,
    ModificationEntry,
    CellUpdate,
    TableQueryOptions,
    TableCountOptions,
    SchemaSnapshot,
    ColumnMetadata,
    ColumnDefinition,
    ViewDefinition,
    ViewEditResult
} from './core/types';
import { escapeIdentifier } from './core/sql-utils';
import { buildSelectQuery, buildCountQuery } from './core/query-builder';

type DatabaseMethodName = {
    [K in keyof DatabaseOperations]: DatabaseOperations[K] extends (...args: never[]) => unknown ? K : never
}[keyof DatabaseOperations];

export class LoggingDatabaseOperations implements DatabaseOperations {
    constructor(
        private readonly wrapped: DatabaseOperations,
        private readonly filename: string,
        private readonly outputChannel: vsc.OutputChannel
    ) {}

    get engineKind() {
        return this.wrapped.engineKind;
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
        return func(...args) as ReturnType<Extract<DatabaseOperations[T], (...args: never[]) => unknown>>;
    }

    private log(message: string, isWrite: boolean = false) {
        const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
        const type = isWrite ? '[WRITE]' : '[read] ';

        // Basic PII/Secret masking in the log message itself if it contains SQL values directly
        // This is a heuristic attempt to mask email-like or key-like patterns in raw SQL
        const safeMessage = maskSensitiveData(message);

        this.outputChannel.appendLine(`${timestamp} ${type} [${this.filename}] ${safeMessage}`);
    }

    async executeQuery(sql: string, params?: CellValue[]): Promise<QueryResultSet[]> {
        const isWrite = /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim());
        const paramStr = params && params.length > 0 ? ` -- params: [${params.map(p => this.sanitizeValue(p)).join(', ')}]` : '';
        this.log(`${sql}${paramStr}`, isWrite);
        return this.wrapped.executeQuery(sql, params);
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

    async updateCell(table: string, rowId: RecordId, column: string, value: CellValue, patch?: string): Promise<void> {
        // Reconstruct SQL for logging
        let sql;
        if (patch) {
            sql = `UPDATE ${escapeIdentifier(table)} SET ${escapeIdentifier(column)} = json_patch(${escapeIdentifier(column)}, ${this.sanitizeValue(patch)}) WHERE rowid = ${rowId}`;
        } else {
            sql = `UPDATE ${escapeIdentifier(table)} SET ${escapeIdentifier(column)} = ${this.sanitizeValue(value)} WHERE rowid = ${rowId}`;
        }
        this.log(sql, true);
        return this.wrapped.updateCell(table, rowId, column, value, patch);
    }

    async insertRow(table: string, data: Record<string, CellValue>): Promise<RecordId | undefined> {
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
        return this.wrapped.insertRow(table, data);
    }

    async insertRowBatch(table: string, rows: Record<string, CellValue>[]): Promise<void> {
        this.log(`INSERT batch: ${rows.length} rows into ${escapeIdentifier(table)}`, true);
        return this.wrapped.insertRowBatch(table, rows);
    }

    async deleteRows(table: string, rowIds: RecordId[]): Promise<void> {
        const sql = `DELETE FROM ${escapeIdentifier(table)} WHERE rowid IN (${rowIds.join(', ')})`;
        this.log(sql, true);
        return this.wrapped.deleteRows(table, rowIds);
    }

    async deleteColumns(table: string, columns: string[], dropDependentIndexes?: string[]): Promise<void> {
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

    async validateViewDefinition(view: string, selectSql: string): Promise<void> {
        return this.logAndDelegate(`Validating view ${escapeIdentifier(view)}`, false, 'validateViewDefinition', view, selectSql);
    }

    async previewViewDefinition(view: string, selectSql: string, limit?: number): Promise<QueryResultSet> {
        return this.logAndDelegate(`Previewing view ${escapeIdentifier(view)}`, false, 'previewViewDefinition', view, selectSql, limit);
    }

    async createView(view: string, selectSql: string): Promise<ViewDefinition> {
        return this.logAndDelegate(`CREATE VIEW ${escapeIdentifier(view)} AS [definition]`, true, 'createView', view, selectSql);
    }

    async editView(view: string, selectSql: string, preserveTriggers?: boolean): Promise<ViewEditResult> {
        return this.logAndDelegate(`Replacing view ${escapeIdentifier(view)} (preserve triggers: ${preserveTriggers !== false})`, true, 'editView', view, selectSql, preserveTriggers);
    }

    async dropView(view: string): Promise<ViewDefinition> {
        return this.logAndDelegate(`DROP VIEW ${escapeIdentifier(view)}`, true, 'dropView', view);
    }

    async updateCellBatch(table: string, updates: CellUpdate[]): Promise<void> {
        this.log(`Batch update ${updates.length} cells in ${table}`, true);
        return this.wrapped.updateCellBatch(table, updates);
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
        this.log(`${sql}${paramStr}`, false);
        return this.wrapped.fetchTableData(table, options);
    }

    async fetchTableCount(table: string, options: TableCountOptions): Promise<number> {
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

    async writeToFile(path: string): Promise<void> {
        return this.logAndDelegate(`Writing to file: ${path}`, true, 'writeToFile', path);
    }
}
