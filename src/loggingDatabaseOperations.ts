/**
 * Logging Wrapper for Database Operations
 *
 * Intercepts calls to DatabaseOperations and logs SQL queries/actions
 * to the VS Code output channel.
 */

import * as vsc from 'vscode';
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
    ColumnDefinition
} from './core/types';
import { escapeIdentifier, cellValueToSql } from './core/sql-utils';
import { buildSelectQuery, buildCountQuery } from './core/query-builder';

export class LoggingDatabaseOperations implements DatabaseOperations {
    constructor(
        private readonly wrapped: DatabaseOperations,
        private readonly filename: string,
        private readonly outputChannel: vsc.OutputChannel
    ) {}

    get engineKind() {
        return this.wrapped.engineKind;
    }

    private sanitizeValue(value: any): string {
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';
        if (typeof value === 'string') {
            if (value.length > 100) {
                return `"${value.substring(0, 100)}...[TRUNCATED]"`;
            }
            return `"${value}"`;
        }
        if (value instanceof Uint8Array || (typeof value === 'object' && value && 'buffer' in value)) {
            return `[BLOB ${value.byteLength} bytes]`;
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

    private log(message: string, isWrite: boolean = false) {
        const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
        const type = isWrite ? '[WRITE]' : '[read] ';

        // Basic PII/Secret masking in the log message itself if it contains SQL values directly
        // This is a heuristic attempt to mask email-like or key-like patterns in raw SQL
        let safeMessage = message;

        // Mask email addresses
        safeMessage = safeMessage.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '***@***.***');

        // Mask phone numbers (various formats: +1-234-567-8901, (234) 567-8901, 234.567.8901, etc.)
        safeMessage = safeMessage.replace(/(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '***-***-****');

        // Mask API keys / tokens (long alphanumeric strings that look like secrets, 20+ chars)
        // Match patterns like: sk_live_xxx, api_key_xxx, or generic hex/base64 tokens
        safeMessage = safeMessage.replace(/\b(sk_live_|sk_test_|api_key_|token_|secret_|key_)[a-zA-Z0-9]{10,}\b/gi, '$1[REDACTED]');
        safeMessage = safeMessage.replace(/\b[a-fA-F0-9]{32,}\b/g, '[REDACTED_HEX]');

        // Mask credit card numbers (basic pattern: 16 digits with optional separators)
        safeMessage = safeMessage.replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, '****-****-****-****');

        // Mask SSN patterns (XXX-XX-XXXX)
        safeMessage = safeMessage.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '***-**-****');

        this.outputChannel.appendLine(`${timestamp} ${type} [${this.filename}] ${safeMessage}`);
    }

    async executeQuery(sql: string, params?: CellValue[]): Promise<QueryResultSet[]> {
        const isWrite = /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim());
        const paramStr = params && params.length > 0 ? ` -- params: [${params.map(p => this.sanitizeValue(p)).join(', ')}]` : '';
        this.log(`${sql}${paramStr}`, isWrite);
        return this.wrapped.executeQuery(sql, params);
    }

    async serializeDatabase(name: string): Promise<Uint8Array> {
        this.log(`Exporting database: ${name}`);
        return this.wrapped.serializeDatabase(name);
    }

    async applyModifications(mods: ModificationEntry[], signal?: AbortSignal): Promise<void> {
        this.log(`Applying ${mods.length} modifications`, true);
        return this.wrapped.applyModifications(mods, signal);
    }

    async undoModification(mod: ModificationEntry): Promise<void> {
        this.log(`Undo: ${mod.description}`, true);
        return this.wrapped.undoModification(mod);
    }

    async redoModification(mod: ModificationEntry): Promise<void> {
        this.log(`Redo: ${mod.description}`, true);
        return this.wrapped.redoModification(mod);
    }

    async flushChanges(signal?: AbortSignal): Promise<void> {
        this.log('Flushing changes', true);
        return this.wrapped.flushChanges(signal);
    }

    async discardModifications(mods: ModificationEntry[], signal?: AbortSignal): Promise<void> {
        this.log(`Discarding ${mods.length} modifications`, true);
        return this.wrapped.discardModifications(mods, signal);
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

    async deleteRows(table: string, rowIds: RecordId[]): Promise<void> {
        const sql = `DELETE FROM ${escapeIdentifier(table)} WHERE rowid IN (${rowIds.join(', ')})`;
        this.log(sql, true);
        return this.wrapped.deleteRows(table, rowIds);
    }

    async deleteColumns(table: string, columns: string[]): Promise<void> {
        for (const col of columns) {
            this.log(`ALTER TABLE ${escapeIdentifier(table)} DROP COLUMN ${escapeIdentifier(col)}`, true);
        }
        return this.wrapped.deleteColumns(table, columns);
    }

    async createTable(table: string, columns: ColumnDefinition[]): Promise<void> {
        const columnDefs = columns.map(c => `${c.name} ${c.type}`).join(', ');
        const sql = `CREATE TABLE ${escapeIdentifier(table)} (${columnDefs})`;
        this.log(sql, true);
        return this.wrapped.createTable(table, columns);
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
        this.log(`Fetching schema`, false);
        return this.wrapped.fetchSchema();
    }

    async getTableInfo(table: string): Promise<ColumnMetadata[]> {
        this.log(`PRAGMA table_info(${escapeIdentifier(table)})`, false);
        return this.wrapped.getTableInfo(table);
    }

    async getPragmas(): Promise<Record<string, CellValue>> {
        this.log('Fetching PRAGMAs', false);
        return this.wrapped.getPragmas();
    }

    async setPragma(pragma: string, value: CellValue): Promise<void> {
        this.log(`PRAGMA ${pragma} = ${this.sanitizeValue(value)}`, true);
        return this.wrapped.setPragma(pragma, value);
    }


    async writeToFile(path: string): Promise<void> {
        this.log(`Writing to file: ${path}`, true);
        return this.wrapped.writeToFile(path);
    }
}
