
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import './vscode_mock_setup'; // Must be first
import * as vsc from 'vscode';
import { exportTableCommand } from '../../src/tableExporter';
import { DocumentRegistry } from '../../src/documentRegistry';

// Mock DatabaseDocument
const mockDocument = {
    uri: vsc.Uri.file('/path/to/db.sqlite'),
    databaseOperations: {
        executeQuery: async (sql: string, params: any[]) => {
            return [{
                headers: ['id', 'name'],
                rows: [[1, 'Alice'], [2, 'Bob']]
            }];
        }
    }
};

describe('exportTableCommand', () => {
    beforeEach(() => {
        DocumentRegistry.clear();
        // @ts-ignore
        DocumentRegistry.set(mockDocument.uri.toString(), mockDocument);
    });

    it('should run without error for CSV export', async () => {
        const context = {} as vsc.ExtensionContext;
        const reporter = undefined;
        const dbParams = { table: 'users', uri: mockDocument.uri.toString() };
        const columns = ['id', 'name'];
        const exportOptions = { format: 'csv' };

        // We expect this to execute successfully using the mocks
        await exportTableCommand(context, reporter, dbParams, columns, undefined, undefined, exportOptions);

        // If we reach here, no exception was thrown
        assert.ok(true);
    });
});
