import './vscode_mock_setup';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as vsc from 'vscode';
import { LoggingDatabaseOperations } from '../../src/loggingDatabaseOperations';
import type { DatabaseOperations, CellValue, QueryResultSet, ModificationEntry, CellUpdate, TableQueryOptions, TableCountOptions, SchemaSnapshot, ColumnMetadata, ColumnDefinition, CellReadTarget, CellMetadata, CellReadSession, CellReadChunk } from '../../src/core/types';

class MockDatabaseOperations implements DatabaseOperations {
    engineKind = Promise.resolve('wasm' as const);
    async executeQuery(sql: string, params?: CellValue[]): Promise<QueryResultSet[]> { return []; }
    async getCellMetadata(_target: CellReadTarget): Promise<CellMetadata> {
        return { storageClass: 'blob', byteLength: 4 };
    }
    async openCellReadSession(_target: CellReadTarget): Promise<CellReadSession> {
        return {
            sessionId: 'mock-session',
            metadata: { storageClass: 'blob', byteLength: 4 },
            expiresAt: Date.now() + 1000
        };
    }
    async readCellChunk(
        _sessionId: string,
        byteOffset: number,
        _maxBytes: number
    ): Promise<CellReadChunk> {
        return { byteOffset, bytes: new Uint8Array(), done: true };
    }
    async closeCellReadSession(_sessionId: string): Promise<void> {}
    async serializeDatabase(): Promise<Uint8Array> { return new Uint8Array(); }
    async applyModifications(mods: ModificationEntry[], signal?: AbortSignal): Promise<void> {}
    async undoModification(mod: ModificationEntry): Promise<void> {}
    async redoModification(mod: ModificationEntry): Promise<void> {}
    async flushChanges(signal?: AbortSignal): Promise<void> {}
    async discardModifications(mods: ModificationEntry[], signal?: AbortSignal): Promise<void> {}
    async updateCell(table: string, rowId: number, column: string, value: CellValue, patch?: string): Promise<void> {}
    async insertRow(table: string, data: Record<string, CellValue>): Promise<number> { return 1; }
    async insertRowBatch(table: string, rows: Record<string, CellValue>[]): Promise<void> {}
    async deleteRows(table: string, rowIds: number[]): Promise<void> {}
    async deleteColumns(table: string, columns: string[], dropDependentIndexes?: string[]): Promise<void> {}
    async findDependentIndexes(table: string, columns: string[]): Promise<string[]> { return []; }
    async createTable(table: string, columns: ColumnDefinition[]): Promise<void> {}
    async getViewDefinition(view: string) { return { identifier: view, sql: `CREATE VIEW ${view} AS SELECT 1`, selectSql: 'SELECT 1', triggers: [] }; }
    async validateViewDefinition(view: string, selectSql: string): Promise<void> {}
    async previewViewDefinition(view: string, selectSql: string, limit?: number): Promise<QueryResultSet> { return { headers: [], rows: [] }; }
    async createView(view: string, selectSql: string) { return { identifier: view, sql: `CREATE VIEW ${view} AS SELECT 1`, selectSql: 'SELECT 1', triggers: [] }; }
    async editView(view: string, selectSql: string) {
        const definition = { identifier: view, sql: `CREATE VIEW ${view} AS SELECT 1`, selectSql: 'SELECT 1', triggers: [] };
        return { before: definition, after: definition };
    }
    async dropView(view: string) { return this.getViewDefinition(view); }
    async updateCellBatch(table: string, updates: CellUpdate[]) { return []; }
    async addColumn(table: string, column: string, type: string, defaultValue?: string): Promise<void> {}
    async fetchTableData(table: string, options: TableQueryOptions): Promise<QueryResultSet> { return { headers: [], rows: [] }; }
    async fetchTableCount(table: string, options: TableCountOptions): Promise<number> { return 0; }
    async fetchSchema(): Promise<SchemaSnapshot> { return { tables: [], views: [], indexes: [] }; }
    async getTableInfo(table: string): Promise<ColumnMetadata[]> { return []; }
    async getPragmas(): Promise<Record<string, CellValue>> { return {}; }
    async setPragma(pragma: string, value: CellValue): Promise<void> {}
    async ping(): Promise<boolean> { return true; }
    async writeToFile(path: string): Promise<void> {}
}

class MockOutputChannel implements vsc.OutputChannel {
    name = 'Mock Output';
    lines: string[] = [];
    append(value: string): void {}
    appendLine(value: string): void {
        this.lines.push(value);
    }
    replace(value: string): void {}
    clear(): void { this.lines = []; }
    show(preserveFocus?: boolean): void;
    show(column?: any, preserveFocus?: boolean): void;
    show(_columnOrPreserveFocus?: any, _preserveFocus?: boolean): void {}
    hide(): void {}
    dispose(): void {}
}

describe('LoggingDatabaseOperations', () => {
    let mockDb: MockDatabaseOperations;
    let mockChannel: MockOutputChannel;
    let logger: LoggingDatabaseOperations;

    beforeEach(() => {
        mockDb = new MockDatabaseOperations();
        mockChannel = new MockOutputChannel();
        logger = new LoggingDatabaseOperations(mockDb, 'test.db', mockChannel);
    });

    describe('sanitizeValue', () => {
        it('should sanitize null', async () => {
            await logger.executeQuery('SELECT *', [null]);
            assert.ok(mockChannel.lines[0].includes('params: [null]'));
        });

        it('should sanitize undefined', async () => {
            await logger.executeQuery('SELECT *', [undefined as any]);
            assert.ok(mockChannel.lines[0].includes('params: [undefined]'));
        });

        it('should sanitize normal string', async () => {
            await logger.executeQuery('SELECT *', ['hello']);
            assert.ok(mockChannel.lines[0].includes('params: ["hello"]'));
        });

        it('should truncate long string (> 100 chars)', async () => {
            const longStr = 'a'.repeat(150);
            await logger.executeQuery('SELECT *', [longStr]);
            const expectedStr = 'a'.repeat(100);
            // Since it's > 32 chars of 'a', it will be replaced by [REDACTED_HEX]
            assert.ok(mockChannel.lines[0].includes(`params: ["[REDACTED_HEX]...[TRUNCATED]"]`));
        });

        it('should truncate long non-hex string (> 100 chars)', async () => {
            const longStr = 'z'.repeat(150);
            await logger.executeQuery('SELECT *', [longStr]);
            const expectedStr = 'z'.repeat(100);
            assert.ok(mockChannel.lines[0].includes(`params: ["${expectedStr}...[TRUNCATED]"]`));
        });

        it('should sanitize Uint8Array as BLOB', async () => {
            const blob = new Uint8Array([1, 2, 3]);
            await logger.executeQuery('SELECT *', [blob]);
            assert.ok(mockChannel.lines[0].includes('params: [[BLOB 3 bytes]]'));
        });

        it('should sanitize object with buffer property as BLOB', async () => {
            const bufferObj = { buffer: new ArrayBuffer(4), byteLength: 4 };
            await logger.executeQuery('SELECT *', [bufferObj as any]);
            assert.ok(mockChannel.lines[0].includes('params: [[BLOB 4 bytes]]'));
        });

        it('should sanitize standard objects to JSON', async () => {
            await logger.executeQuery('SELECT *', [{ foo: 'bar' } as any]);
            assert.ok(mockChannel.lines[0].includes('params: [{"foo":"bar"}...]'));
        });

        it('should fallback to [Object] for circular objects', async () => {
            const circular: any = {};
            circular.self = circular;
            await logger.executeQuery('SELECT *', [circular]);
            assert.ok(mockChannel.lines[0].includes('params: [[Object]]'));
        });

        it('should fallback to [Object] when JSON.stringify throws', async () => {
            const thrower = {
                toJSON() { throw new Error('Stringify error'); }
            };
            await logger.executeQuery('SELECT *', [thrower as any]);
            assert.ok(mockChannel.lines[0].includes('params: [[Object]]'));
        });

        it('should pass through numbers', async () => {
            await logger.executeQuery('SELECT *', [123.45]);
            assert.ok(mockChannel.lines[0].includes('params: [123.45]'));
        });

        it('should pass through booleans', async () => {
            await logger.executeQuery('SELECT *', [true, false] as any);
            assert.ok(mockChannel.lines[0].includes('params: [true, false]'));
        });
    });

    describe('PII/Secret Masking', () => {
        it('should mask email addresses', async () => {
            await logger.executeQuery("SELECT 'user@example.com'");
            assert.ok(mockChannel.lines[0].includes('***@***.***'));
            assert.ok(!mockChannel.lines[0].includes('user@example.com'));
        });

        it('should mask phone numbers', async () => {
            await logger.executeQuery("SELECT '+1-234-567-8901'");
            assert.ok(mockChannel.lines[0].includes('***-***-****'));
            assert.ok(!mockChannel.lines[0].includes('+1-234-567-8901'));
        });

        it('should mask API keys', async () => {
            await logger.executeQuery("SELECT 'sk_live_abcdefghijklmnopqr'");
            assert.ok(mockChannel.lines[0].includes('sk_live_[REDACTED]'));
            assert.ok(!mockChannel.lines[0].includes('abcdefghijklmnopqr'));
        });

        it('should mask long hex strings', async () => {
            await logger.executeQuery("SELECT 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'");
            assert.ok(mockChannel.lines[0].includes('[REDACTED_HEX]'));
        });

        it('should mask credit card numbers', async () => {
            await logger.executeQuery("SELECT '1234-5678-9012-3456'");
            assert.ok(mockChannel.lines[0].includes('****-****-****-****'));
        });

        it('should mask SSN patterns', async () => {
            await logger.executeQuery("SELECT '123-45-6789'");
            assert.ok(mockChannel.lines[0].includes('***-**-****'));
        });
    });

    describe('view definition logging', () => {
        it('logs a sanitized and masked CREATE VIEW definition', async () => {
            const selectSql = `SELECT 'user@example.com' AS email, '${'z'.repeat(120)}' AS padding`;

            await logger.createView('customer view', selectSql);

            const line = mockChannel.lines[0];
            assert.match(line, /CREATE VIEW "customer view" AS/);
            assert.ok(line.includes('***@***.***'));
            assert.ok(line.includes('...[TRUNCATED]'));
            assert.ok(!line.includes('user@example.com'));
            assert.ok(!line.includes('[definition]'));
        });

        it('logs a sanitized and masked replacement definition', async () => {
            const selectSql = `SELECT 'user@example.com' AS email, '${'z'.repeat(120)}' AS padding`;

            await logger.editView('customer view', selectSql, false);

            const line = mockChannel.lines[0];
            assert.match(line, /Replacing view "customer view" with/);
            assert.ok(line.includes('***@***.***'));
            assert.ok(line.includes('...[TRUNCATED]'));
            assert.ok(line.includes('(preserve triggers: false)'));
            assert.ok(!line.includes('user@example.com'));
        });
    });
});
