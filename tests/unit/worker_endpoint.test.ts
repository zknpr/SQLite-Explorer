import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';

// Mock parentPort BEFORE importing createWorkerEndpoint
import Module from 'module';
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
    if (request === 'worker_threads') {
        return {
            parentPort: {
                postMessage: () => {},
                on: () => {}
            }
        };
    }
    return originalLoad(request, parent, isMain);
};

// Now we can import the module to test
import { createWorkerEndpoint } from '../../src/core/sqlite-db';

describe('Worker Endpoint', () => {
    let endpoint: ReturnType<typeof createWorkerEndpoint>;
    let wasmBinary: Buffer;

    beforeEach(() => {
        endpoint = createWorkerEndpoint();
        wasmBinary = fs.readFileSync('./vendor/sql.js/sql-wasm.wasm');
    });

    it('should throw Error if database is not initialized', async () => {
        const expectedError = new Error('No database initialized');

        await assert.rejects(endpoint.runQuery('SELECT 1'), expectedError);
        await assert.rejects(endpoint.exportDatabase(), expectedError);
        await assert.rejects(endpoint.updateCell('table', 1, 'col', 'val'), expectedError);
        await assert.rejects(endpoint.insertRow('table', {}), expectedError);
        await assert.rejects(endpoint.insertRowBatch('table', []), expectedError);
        await assert.rejects(endpoint.deleteRows('table', [1]), expectedError);
        await assert.rejects(endpoint.deleteColumns('table', ['col']), expectedError);
        await assert.rejects(endpoint.findDependentIndexes('table', ['col']), expectedError);
        await assert.rejects(endpoint.createTable('table', []), expectedError);
        await assert.rejects(endpoint.updateCellBatch('table', []), expectedError);
        await assert.rejects(endpoint.addColumn('table', 'col', 'TEXT'), expectedError);
        await assert.rejects(endpoint.fetchTableData('table', { offset: 0, limit: 10 }), expectedError);
        await assert.rejects(endpoint.fetchTableCount('table', {}), expectedError);
        await assert.rejects(endpoint.fetchSchema(), expectedError);
        await assert.rejects(endpoint.getTableInfo('table'), expectedError);
        await assert.rejects(endpoint.getPragmas(), expectedError);
        await assert.rejects(endpoint.setPragma('journal_mode', 'WAL'), expectedError);
        await assert.rejects(endpoint.writeToFile('path'), expectedError);

        const pingResult = await endpoint.ping();
        assert.strictEqual(pingResult, false);
    });

    it('should delegate operations after database is initialized', async () => {
        const initResult = await endpoint.initializeDatabase('test.db', {
            content: null,
            maxSize: 0,
            readOnlyMode: false,
            wasmBinary
        });

        assert.strictEqual(initResult.isReadOnly, false);

        // Ping should work
        assert.strictEqual(await endpoint.ping(), true);

        // Run a query
        const queryResult = await endpoint.runQuery('SELECT 1 + 1 AS result');
        assert.deepStrictEqual(queryResult[0].rows, [[2]]);

        // Create table and insert
        await endpoint.createTable('users', [
            { name: 'id', type: 'INTEGER', primaryKey: true, notNull: false },
            { name: 'name', type: 'TEXT', primaryKey: false, notNull: false }
        ]);

        await endpoint.insertRow('users', { id: 1, name: 'Alice' });

        const tableData = await endpoint.fetchTableData('users', { offset: 0, limit: 10 });
        assert.deepStrictEqual(tableData.rows, [[1, 'Alice']]);

        // Export DB
        const data = await endpoint.exportDatabase();
        assert.ok(data instanceof Uint8Array);
        assert.ok(data.length > 0);
    });

    it('routes bounded cell sessions through the worker endpoint', async () => {
        await endpoint.initializeDatabase('test.db', {
            content: null,
            maxSize: 0,
            readOnlyMode: false,
            wasmBinary
        });
        await endpoint.runQuery(
            "CREATE TABLE cell_windows (payload TEXT); " +
            "INSERT INTO cell_windows VALUES ('A😀B')"
        );
        const target = { table: 'cell_windows', rowId: 1, column: 'payload' };

        const metadata = await endpoint.getCellMetadata(target);
        assert.deepStrictEqual(metadata, {
            storageClass: 'text',
            byteLength: 6,
            textEncoding: 'utf-8'
        });
        const session = await endpoint.openCellReadSession(target);
        const first = await endpoint.readCellChunk(session.sessionId, 0, 3);
        const second = await endpoint.readCellChunk(session.sessionId, 3, 3);
        await endpoint.closeCellReadSession(session.sessionId);

        assert.deepStrictEqual(first.bytes, new Uint8Array([65, 240, 159]));
        assert.deepStrictEqual(second.bytes, new Uint8Array([152, 128, 66]));
        assert.strictEqual(second.done, true);
    });

    it('forwards skipped view-undo diagnostics through the endpoint logger', async () => {
        const logs: Array<{ level: string; args: unknown[] }> = [];
        endpoint = createWorkerEndpoint((level, ...args) => {
            logs.push({ level, args });
        });
        await endpoint.initializeDatabase('test.db', {
            content: null,
            maxSize: 0,
            readOnlyMode: false,
            wasmBinary
        });

        await endpoint.undoModification({
            description: 'Corrupt legacy view history',
            modificationType: 'view_edit',
            targetTable: 'missing_view'
        });

        assert.deepStrictEqual(logs, [{
            level: 'warn',
            args: ['[WasmDatabaseEngine] Skipping view undo: definition missing from history entry']
        }]);
    });

    it('should shutdown previous database when initializing a new one', async () => {
        await endpoint.initializeDatabase('test1.db', {
            content: null,
            maxSize: 0,
            readOnlyMode: false,
            wasmBinary
        });

        await endpoint.createTable('test_table', [{ name: 'id', type: 'INTEGER', primaryKey: false, notNull: false }]);

        // Initialize a new database, which should shutdown the previous one and create a clean state
        await endpoint.initializeDatabase('test2.db', {
            content: null,
            maxSize: 0,
            readOnlyMode: false,
            wasmBinary
        });

        // The new database should not have the test_table
        const schema = await endpoint.fetchSchema();
        const hasTestTable = schema.tables.some(t => t.identifier === 'test_table');
        assert.strictEqual(hasTestTable, false);
    });

    it('should delegate remaining operations after database is initialized', async () => {
        await endpoint.initializeDatabase('test.db', {
            content: null,
            maxSize: 0,
            readOnlyMode: false,
            wasmBinary
        });

        await endpoint.createTable('users', [
            { name: 'id', type: 'INTEGER', primaryKey: true, notNull: false },
            { name: 'name', type: 'TEXT', primaryKey: false, notNull: false }
        ]);

        await endpoint.insertRowBatch('users', [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' }
        ]);

        await endpoint.updateCellBatch('users', [
            { rowId: 1, column: 'name', value: 'Alice Smith' },
            { rowId: 2, column: 'name', value: 'Bob Jones' }
        ]);

        await endpoint.updateCell('users', 1, 'name', 'Alice S.');

        await endpoint.addColumn('users', 'age', 'INTEGER', '30');

        const tableData = await endpoint.fetchTableData('users', { offset: 0, limit: 10 });
        assert.deepStrictEqual(tableData.rows, [
            [1, 'Alice S.', 30],
            [2, 'Bob Jones', 30]
        ]);

        await endpoint.setPragma('journal_mode', 'WAL');
        const pragmas = await endpoint.getPragmas();
        assert.ok(pragmas.journal_mode !== undefined);

        await endpoint.deleteColumns('users', ['age']);
        const info = await endpoint.getTableInfo('users');
        assert.strictEqual(info.length, 2);

        const dependentIndexes = await endpoint.findDependentIndexes('users', ['name']);
        assert.deepStrictEqual(dependentIndexes, []);

        await endpoint.deleteRows('users', [1]);
        const count = await endpoint.fetchTableCount('users', {});
        assert.strictEqual(count, 1);

        await endpoint.writeToFile('/tmp/test_dump.db');
    });

    it('should forward JSON merge patches through updateCell to the WASM engine', async () => {
        await endpoint.initializeDatabase('test.db', {
            content: null,
            maxSize: 0,
            readOnlyMode: false,
            wasmBinary
        });

        await endpoint.createTable('json_items', [
            { name: 'id', type: 'INTEGER', primaryKey: true, notNull: false },
            { name: 'data', type: 'TEXT', primaryKey: false, notNull: false }
        ]);
        await endpoint.insertRow('json_items', {
            id: 1,
            data: '{"preserved":true,"changed":"before"}'
        });

        // The fourth argument represents the stale full-cell value. When the
        // fifth patch argument reaches WasmDatabaseEngine.updateCell, SQLite
        // merges it into the existing document instead of writing this stale value.
        await endpoint.updateCell(
            'json_items',
            1,
            'data',
            '{"changed":"stale-overwrite"}',
            '{"changed":"after","added":42}'
        );

        const tableData = await endpoint.fetchTableData('json_items', { offset: 0, limit: 10 });
        assert.deepStrictEqual(JSON.parse(tableData.rows[0][1] as string), {
            preserved: true,
            changed: 'after',
            added: 42
        });
    });
});
