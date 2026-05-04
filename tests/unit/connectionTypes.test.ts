import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { DatabaseConnectionBundle } from '../../src/connectionTypes';
import type { Uri } from 'vscode';
import type { DatabaseOperations, DatabaseInitConfig } from '../../src/core/types';

describe('connectionTypes', () => {
    it('should allow implementing DatabaseConnectionBundle', () => {
        const mockOperations: DatabaseOperations = {
            engineKind: Promise.resolve('wasm'),
            executeQuery: async () => [],
            serializeDatabase: async () => new Uint8Array(),
            applyModifications: async () => {},
            undoModification: async () => {},
            redoModification: async () => {},
            flushChanges: async () => {},
            discardModifications: async () => {},
            updateCell: async () => {},
            insertRow: async () => ({ lastInsertRowid: 1, changes: 1 }),
            insertRowBatch: async () => {},
            deleteRows: async () => {},
            deleteColumns: async () => {},
            findDependentIndexes: async () => [],
            createTable: async () => {},
            updateCellBatch: async () => {},
            addColumn: async () => {},
            fetchTableData: async () => ({ rows: [], totalCount: 0, timeTaken: 0 }),
            fetchTableCount: async () => ({ totalCount: 0 }),
            fetchSchema: async () => ({ tables: [] }),
            getTableInfo: async () => [],
            getPragmas: async () => [],
            setPragma: async () => {},
            ping: async () => true,
            writeToFile: async () => {}
        };

        const mockBundle: DatabaseConnectionBundle = {
            workerMethods: {
                initializeDatabase: async (filename: string, config: DatabaseInitConfig) => ({ isReadOnly: false }),
                runQuery: async (sql: string) => [],
                exportDatabase: async (name: string) => new Uint8Array(),
                [Symbol.dispose]: () => {}
            },
            establishConnection: async (fileUri: Uri, displayName: string, forceReadOnly?: boolean, autoCommit?: boolean) => ({
                databaseOps: mockOperations,
                isReadOnly: false
            })
        };

        assert.ok(mockBundle);
        assert.ok(mockBundle.workerMethods);
        assert.strictEqual(typeof mockBundle.establishConnection, 'function');
    });
});
