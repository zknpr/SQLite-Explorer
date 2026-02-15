
import './vscode_mock_setup'; // Must be first
import { describe, it, mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as vscode from 'vscode';
import { DocumentRegistry } from '../../src/documentRegistry';
import type { DatabaseDocument } from '../../src/databaseModel';
import { mockVscode } from './mocks/vscode';

// Mock types
interface DbParams {
    filename?: string;
    table: string;
    name?: string;
    uri?: string;
}

// Extend mock vscode directly on the source object BEFORE importing subject
(mockVscode as any).window = {
    showQuickPick: mock.fn(),
    showSaveDialog: mock.fn(),
    showErrorMessage: mock.fn(),
    showInformationMessage: mock.fn()
};

(mockVscode as any).workspace = {
    fs: {
        writeFile: mock.fn()
    }
};

(mockVscode as any).Uri.joinPath = mock.fn((uri: any, ...parts: string[]) => {
    // simple implementation: append parts
    let path = uri.path;
    for (const part of parts) {
        if (!path.endsWith('/')) path += '/';
        path += part;
    }
    return uri.with({ path });
});

describe('exportTableCommand', () => {
    const docKey = 'test-doc';
    const tableName = 'users';
    let mockDbOps: any;
    let exportTableCommand: any;

    beforeEach(async () => {
        mock.reset();
        DocumentRegistry.clear();

        // Dynamic import to ensure mocks are ready
        const module = await import('../../src/tableExporter');
        exportTableCommand = module.exportTableCommand;

        // Setup mocks
        (mockVscode as any).window.showQuickPick.mock.mockImplementation(async () => ({ value: 'csv' }));
        (mockVscode as any).window.showSaveDialog.mock.mockImplementation(async () => vscode.Uri.parse('vscode-vfs://remote/users.csv'));
        (mockVscode as any).workspace.fs.writeFile.mock.mockImplementation(async () => {});
        (mockVscode as any).window.showErrorMessage.mock.mockImplementation(() => {});

        mockDbOps = {
            executeQuery: mock.fn(async (sql: string, params: any[]) => {
                // Check if checking for rowid support
                if (sql.includes('SELECT rowid FROM "users" LIMIT 1')) {
                    // Simulate rowid support
                    return [{ rows: [[1]] }];
                }

                // If querying with rowid (pagination)
                if (sql.includes('rowid, "id", "name"')) {
                    // Keyset pagination query
                    return [{
                        // Note: first column is rowid, then user columns
                        columns: ['rowid', 'id', 'name'],
                        values: [[1, 1, 'Alice'], [2, 2, 'Bob']]
                    }];
                }

                // Fallback / Offset pagination
                return [{
                    columns: ['id', 'name'],
                    values: [[1, 'Alice'], [2, 'Bob']]
                }];
            })
        };

        const mockDocument = {
            uri: vscode.Uri.parse(`vscode-sqlite://${docKey}`),
            databaseOperations: mockDbOps
        } as unknown as DatabaseDocument;

        DocumentRegistry.set(docKey, mockDocument);
    });

    afterEach(() => {
        DocumentRegistry.clear();
    });

    it('should use pagination for in-memory export', async () => {
        const dbParams: DbParams = {
            table: tableName,
            uri: `vscode-sqlite://${docKey}`
        };

        await exportTableCommand(
            {} as any, // context
            undefined, // reporter
            dbParams,
            ['id', 'name'] // columns
        );

        // Verify executeQuery calls
        const calls = mockDbOps.executeQuery.mock.calls;

        // 1. Check for rowid check query
        const rowidCheck = calls.find((c: any) => c.arguments[0].includes('SELECT rowid FROM "users" LIMIT 1'));
        assert.ok(rowidCheck, 'Should check for rowid support');

        // 2. Check for paginated query (LIMIT 5000)
        const mainQuery = calls.find((c: any) => c.arguments[0].includes('LIMIT 5000'));
        assert.ok(mainQuery, 'Query should use LIMIT 5000');

        // 3. Verify query structure for keyset pagination (since we returned rowid support)
        assert.ok(mainQuery.arguments[0].includes('rowid > ?'), 'Should use keyset pagination (rowid > ?)');
        assert.ok(mainQuery.arguments[0].includes('ORDER BY rowid ASC'), 'Should order by rowid');

        // Verify writeFile was called
        const writeFileMock = (mockVscode as any).workspace.fs.writeFile;
        assert.strictEqual(writeFileMock.mock.callCount(), 1);

        // Verify content
        const content = writeFileMock.mock.calls[0].arguments[1].toString(); // Buffer to string
        assert.ok(content.includes('id,name'), 'CSV header should be present');
        assert.ok(content.includes('1,Alice'), 'Row data should be present');
        assert.ok(content.includes('2,Bob'), 'Row data should be present');
    });

    it('should use offset pagination if rowid is not supported', async () => {
        // Disable rowid support in mock
        mockDbOps.executeQuery.mock.mockImplementation(async (sql: string, params: any[]) => {
            if (sql.includes('SELECT rowid FROM "users" LIMIT 1')) {
                throw new Error('no rowid');
            }
            // Offset pagination query
             return [{
                columns: ['id', 'name'],
                values: [[1, 'Alice'], [2, 'Bob']]
            }];
        });

        const dbParams: DbParams = {
            table: tableName,
            uri: `vscode-sqlite://${docKey}`
        };

        await exportTableCommand(
            {} as any, // context
            undefined, // reporter
            dbParams,
            ['id', 'name'] // columns
        );

        const calls = mockDbOps.executeQuery.mock.calls;
        const mainQuery = calls.find((c: any) => c.arguments[0].includes('LIMIT 5000'));
        assert.ok(mainQuery, 'Query should use LIMIT 5000');
        assert.ok(mainQuery.arguments[0].includes('OFFSET 0'), 'Should use OFFSET 0');
        assert.ok(!mainQuery.arguments[0].includes('rowid > ?'), 'Should NOT use keyset pagination');
    });
});
