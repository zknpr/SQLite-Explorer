import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import * as vscode from 'vscode';
import { SQLiteFileSystemProvider } from '../../src/virtualFileSystem';
import { DocumentRegistry } from '../../src/documentRegistry';

// Mock Document Interface matching DatabaseDocument behavior used by FileSystemProvider
interface MockDocument {
    databaseOperations: {
        updateCell: (table: string, rowId: number, column: string, value: any) => Promise<void>;
    };
    recordExternalModification: (mod: any) => void;
}

describe('SQLiteFileSystemProvider', () => {
    let provider: SQLiteFileSystemProvider;
    let mockDocument: MockDocument;
    const documentKey = 'mock-doc-key';

    // Helper to create URI.
    // Format: /<document_key>/<table>/<group>/<rowid>/<filename>
    const createUri = (path: string) => vscode.Uri.file(path).with({ scheme: 'sqlite-explorer' });

    beforeEach(() => {
        provider = new SQLiteFileSystemProvider();

        mockDocument = {
            databaseOperations: {
                updateCell: async () => {} // Default mock
            },
            recordExternalModification: () => {}
        };

        // Populate Registry
        DocumentRegistry.set(documentKey, mockDocument as any);
    });

    afterEach(() => {
        DocumentRegistry.clear();
        mock.restoreAll();
    });

    it('writeFile should update cell with valid text content', async (t) => {
        const table = 'users';
        const rowId = '1';
        const column = 'name';
        const filename = `${column}.txt`;
        const path = `/${documentKey}/${table}/group/${rowId}/${filename}`;
        const uri = createUri(path);

        const contentStr = 'Alice';
        const content = new TextEncoder().encode(contentStr);

        // Mock updateCell to verify arguments
        const updateCellMock = t.mock.fn(async (tbl: string, rid: number, col: string, val: any) => {
            assert.strictEqual(tbl, table);
            assert.strictEqual(rid, 1);
            assert.strictEqual(col, column);
            assert.strictEqual(val, contentStr);
        });
        mockDocument.databaseOperations.updateCell = updateCellMock;

        // Mock recordExternalModification
        const recordMock = t.mock.fn();
        mockDocument.recordExternalModification = recordMock;

        await provider.writeFile(uri, content, { create: false, overwrite: true });

        assert.strictEqual(updateCellMock.mock.callCount(), 1);
        assert.strictEqual(recordMock.mock.callCount(), 1);

        // Verify modification record
        const callArgs = recordMock.mock.calls[0].arguments;
        assert.strictEqual(callArgs[0].newValue, contentStr);
        assert.strictEqual(callArgs[0].modificationType, 'cell_update');
    });

    it('writeFile should handle binary content (invalid utf-8) by saving as Uint8Array', async (t) => {
        const table = 'data';
        const rowId = '2';
        const column = 'blob';
        const path = `/${documentKey}/${table}/group/${rowId}/${column}.bin`;
        const uri = createUri(path);

        // Invalid UTF-8 sequence (0xFF cannot appear in valid UTF-8)
        const content = new Uint8Array([0xFF, 0xFF]);

        const updateCellMock = t.mock.fn(async (tbl: string, rid: number, col: string, val: any) => {
            assert.ok(val instanceof Uint8Array);
            assert.deepStrictEqual(val, content);
        });
        mockDocument.databaseOperations.updateCell = updateCellMock;
        mockDocument.recordExternalModification = t.mock.fn();

        await provider.writeFile(uri, content, { create: false, overwrite: true });

        assert.strictEqual(updateCellMock.mock.callCount(), 1);
    });

    it('writeFile should throw NoPermissions for __create__.sql', async () => {
        const path = `/${documentKey}/table/group/__create__.sql/foo.sql`;
        const uri = createUri(path);

        await assert.rejects(
            async () => await provider.writeFile(uri, new Uint8Array(), { create: false, overwrite: true }),
            (err: any) => {
                assert.strictEqual(err.code, 'NoPermissions');
                return true;
            }
        );
    });

    it('writeFile should throw Unavailable for invalid Row ID', async () => {
        const path = `/${documentKey}/table/group/invalid-id/col.txt`;
        const uri = createUri(path);

        await assert.rejects(
            async () => await provider.writeFile(uri, new Uint8Array(), { create: false, overwrite: true }),
            (err: any) => {
                assert.strictEqual(err.code, 'Unavailable');
                assert.match(err.message, /Invalid Row ID/);
                return true;
            }
        );
    });

    it('writeFile should throw FileNotFound if document not found', async () => {
        const path = `/non-existent-key/table/group/1/col.txt`;
        const uri = createUri(path);

        await assert.rejects(
            async () => await provider.writeFile(uri, new Uint8Array(), { create: false, overwrite: true }),
            (err: any) => {
                assert.strictEqual(err.code, 'FileNotFound');
                return true;
            }
        );
    });
});
