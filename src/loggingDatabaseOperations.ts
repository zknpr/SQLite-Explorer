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

    private log(message: string, isWrite: boolean = false) {
        const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
        const type = isWrite ? '[WRITE]' : '[read] ';
        this.outputChannel.appendLine(`${timestamp} ${type} [${this.filename}] ${message}`);
    }

    async executeQuery(sql: string, params?: CellValue[]): Promise<QueryResultSet[]> {
        const isWrite = /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim());
        const paramStr = params && params.length > 0 ? ` -- params: ${JSON.stringify(params)}` : '';
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
            sql = `UPDATE ${escapeIdentifier(table)} SET ${escapeIdentifier(column)} = json_patch(${escapeIdentifier(column)}, ${cellValueToSql(patch)}) WHERE rowid = ${rowId}`;
        } else {
            sql = `UPDATE ${escapeIdentifier(table)} SET ${escapeIdentifier(column)} = ${cellValueToSql(value)} WHERE rowid = ${rowId}`;
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
            const values = columns.map(c => cellValueToSql(data[c])).join(', ');
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
        const paramStr = params && params.length > 0 ? ` -- params: ${JSON.stringify(params)}` : '';
        this.log(`${sql}${paramStr}`, false);
        return this.wrapped.fetchTableData(table, options);
    }

    async fetchTableCount(table: string, options: TableCountOptions): Promise<number> {
        const { sql, params } = buildCountQuery(table, options);
        const paramStr = params && params.length > 0 ? ` -- params: ${JSON.stringify(params)}` : '';
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
        this.log(`PRAGMA ${pragma} = ${value}`, true);
        return this.wrapped.setPragma(pragma, value);
    }


    async writeToFile(path: string): Promise<void> {
        this.log(`Writing to file: ${path}`, true);
        return this.wrapped.writeToFile(path);
    }
}
