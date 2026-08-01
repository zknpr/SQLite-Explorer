
import './vscode_mock_setup';
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import { HostBridge } from '../../src/hostBridge';
import * as vscode from 'vscode';

describe('HostBridge', () => {

    afterEach(() => {
        mock.reset();
    });

    it('saveFile should prevent path traversal by stripping directory components from filename', async () => {
        const mockDocument = {
            uri: vscode.Uri.parse('file:///dbDir/test.db'),
            documentKey: Promise.resolve('test-key'),
        };

        const mockProvider = { webviews: new Map(), context: {} };
        const bridge = new HostBridge(mockProvider as any, mockDocument as any);

        const showSaveDialogMock = mock.method(vscode.window, 'showSaveDialog', async () => vscode.Uri.parse('file:///dbDir/safe.txt'));
        const writeFileMock = mock.method(vscode.workspace.fs, 'writeFile', async () => {});

        await bridge.saveFile('../../../etc/passwd', new Uint8Array([1, 2, 3]));

        assert.strictEqual(showSaveDialogMock.mock.callCount(), 1);
        const args = showSaveDialogMock.mock.calls[0].arguments[0] as any;
        // The defaultUri path should end with the base name 'passwd', not the traversed path
        assert.ok(args.defaultUri.path.endsWith('/dbDir/passwd'), `Expected safe path, got ${args.defaultUri.path}`);

        assert.strictEqual(writeFileMock.mock.callCount(), 1);
    });


    it('openCellEditor should open correct URI for binary file with mime type', async () => {
        const executeCommandMock = mock.method(vscode.commands, 'executeCommand', async () => {});

        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
        };

        const mockProvider = {
            webviews: new Map(),
            context: { globalState: { update: () => {} } }
        };

        const bridge = new HostBridge(mockProvider as any, mockDocument as any);

        const params = { table: 'users', name: 'db' };
        const rowId = 1;
        const colName = 'avatar';
        // Passing Uint8Array value so it's treated as binary
        const value = new Uint8Array([1, 2, 3]);
        const type = { mime: 'image/png', ext: 'png' };

        await bridge.openCellEditor(params, rowId, colName, {}, {
            value,
            type,
            webviewId: 'wv1',
            rowCount: 10
        });

        assert.strictEqual(executeCommandMock.mock.callCount(), 1);
        const args = executeCommandMock.mock.calls[0].arguments;
        assert.strictEqual(args[0], 'vscode.open');

        const uri = args[1];
        // Expected path: /test-key/users/db/1/avatar.png
        // Note: The URI scheme construction in HostBridge uses Uri.from which uses the mock.
        // The mock implementation returns a simple object with toString().
        // We verify the path property.

        assert.ok(uri.path.endsWith('avatar.png'), `Path should end with avatar.png, got ${uri.path}`);
        assert.ok(uri.path.includes('users'));
        assert.ok(uri.path.includes('1'));
    });

    it('openCellEditor should default to .bin for unknown binary', async () => {
        const executeCommandMock = mock.method(vscode.commands, 'executeCommand', async () => {});

        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
        };

        const mockProvider = {
            webviews: new Map(),
            context: {}
        };

        const bridge = new HostBridge(mockProvider as any, mockDocument as any);

        const params = { table: 'users' };
        const value = new Uint8Array([1, 2, 3]);

        await bridge.openCellEditor(params, 1, 'data', {}, { value });

        const args = executeCommandMock.mock.calls[0].arguments;
        const uri = args[1];
        assert.ok(uri.path.endsWith('.bin'), `Path should end with .bin, got ${uri.path}`);
    });

    it('openCellEditor should default to .txt for text', async () => {
        const executeCommandMock = mock.method(vscode.commands, 'executeCommand', async () => {});

        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
        };

        const mockProvider = { webviews: new Map(), context: {} };
        const bridge = new HostBridge(mockProvider as any, mockDocument as any);

        await bridge.openCellEditor({ table: 't' }, 1, 'text', {}, { value: 'hello' });

        const args = executeCommandMock.mock.calls[0].arguments;
        const uri = args[1];
        assert.ok(uri.path.endsWith('.txt'), `Path should end with .txt, got ${uri.path}`);
    });

    it('opens a view definition as a writable SQL virtual document', async () => {
        const executeCommandMock = mock.method(vscode.commands, 'executeCommand', async () => {});
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key')
        };
        const mockProvider = { webviews: new Map(), context: {} };
        const bridge = new HostBridge(mockProvider as any, mockDocument as any);

        await bridge.openViewEditor('active users', 'wv1');

        const args = executeCommandMock.mock.calls[0].arguments;
        assert.strictEqual(args[0], 'vscode.open');
        assert.ok(args[1].path.includes('active%20users'));
        assert.ok(args[1].path.includes('__view__.sql'));
        assert.ok(args[1].path.endsWith('definition.sql'));
        assert.strictEqual(args[2], vscode.ViewColumn.Two);
    });

    it('reports that the external view editor is unavailable for untitled databases', async () => {
        const executeCommandMock = mock.method(vscode.commands, 'executeCommand', async () => {});
        const originalTranslate = vscode.l10n.t;
        const mockDocument = {
            uri: { scheme: 'untitled' },
            documentKey: Promise.resolve('test-key')
        };
        const mockProvider = { webviews: new Map(), context: {} };
        const bridge = new HostBridge(mockProvider as any, mockDocument as any);

        (vscode.l10n as any).t = (message: string) => `localized:${message}`;
        try {
            await assert.rejects(
                () => bridge.openViewEditor('active_users', 'wv1'),
                /localized:The external view editor is unavailable for untitled databases/
            );
            assert.strictEqual(executeCommandMock.mock.callCount(), 0);
        } finally {
            (vscode.l10n as any).t = originalTranslate;
        }
    });

    it('should catch and log error if fetch rows for undo history fails in deleteRows', async () => {
        const consoleWarnMock = mock.method(console, 'warn', () => {});
        const error = new Error('Database disconnected');
        const dbOps = {
            executeQuery: mock.fn(async () => { throw error; }),
            deleteRows: mock.fn(async () => {})
        };
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            recordExternalModification: mock.fn(),
        };
        const mockProvider = { webviews: new Map(), context: {} };
        const bridge = new HostBridge(mockProvider as any, mockDocument as any);
        (bridge as any).ensureDatabaseInitialized = () => dbOps as any;

        await bridge.deleteRows('table1', [1]);

        assert.strictEqual(consoleWarnMock.mock.callCount(), 1);
        assert.deepStrictEqual(consoleWarnMock.mock.calls[0].arguments, [
            'Failed to fetch rows for undo history:',
            error
        ]);

        assert.strictEqual(dbOps.deleteRows.mock.callCount(), 1);
    });

    it('treats connection-level read-only documents as read-only for web mutators', async () => {
        const dbOps = {
            updateCell: mock.fn(async () => {}),
            insertRow: mock.fn(async () => 1),
            deleteRows: mock.fn(async () => {}),
            updateCellBatch: mock.fn(async () => {}),
            executeQuery: mock.fn(async () => [])
        };
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: true,
            recordExternalModification: mock.fn()
        };
        const mockProvider = {
            webviews: new Map(),
            context: {},
            isReadOnly: false
        };
        const bridge = new HostBridge(mockProvider as any, mockDocument as any);

        assert.strictEqual(bridge.isReadOnly, true);
        await assert.rejects(
            () => bridge.updateCell('table1', 1, 'name', 'after', 'before'),
            /Document is read-only/
        );
        await assert.rejects(
            () => bridge.insertRow('table1', { name: 'new' }),
            /Document is read-only/
        );
        await assert.rejects(
            () => bridge.deleteRows('table1', [1]),
            /Document is read-only/
        );
        await assert.rejects(
            () => bridge.updateCellBatch('table1', [{ rowId: 1, column: 'name', value: 'after' }], 'Batch update'),
            /Document is read-only/
        );

        assert.strictEqual(dbOps.updateCell.mock.callCount(), 0);
        assert.strictEqual(dbOps.insertRow.mock.callCount(), 0);
        assert.strictEqual(dbOps.deleteRows.mock.callCount(), 0);
        assert.strictEqual(dbOps.updateCellBatch.mock.callCount(), 0);
        assert.strictEqual(mockDocument.recordExternalModification.mock.callCount(), 0);
    });

    it('returns refreshed connection capabilities after reloading from disk', async () => {
        let readOnlyMode = false;
        const reloadFromDisk = mock.fn(async () => {
            readOnlyMode = true;
        });
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            fileParts: { filename: 'test.db' },
            get isReadOnlyMode() { return readOnlyMode; },
            reloadFromDisk
        };
        const mockProvider = {
            webviews: new Map(),
            context: {},
            isReadOnly: false
        };
        const bridge = new HostBridge(mockProvider as any, mockDocument as any);

        const result = await bridge.refreshFile();

        assert.strictEqual(reloadFromDisk.mock.callCount(), 1);
        assert.deepStrictEqual(result, {
            connected: true,
            filename: 'test.db',
            readOnly: true
        });
    });

    it('reports that reload is unavailable for untitled databases', async () => {
        const reloadFromDisk = mock.fn(async () => {});
        const mockDocument = {
            uri: { scheme: 'untitled' },
            reloadFromDisk
        };
        const mockProvider = {
            webviews: new Map(),
            context: {},
            isReadOnly: false
        };
        const bridge = new HostBridge(mockProvider as any, mockDocument as any);

        await assert.rejects(
            () => bridge.refreshFile(),
            /Reload is unavailable for untitled databases/
        );
        assert.strictEqual(reloadFromDisk.mock.callCount(), 0);
    });

    it('should catch and log error if fetch columns for undo history fails in deleteColumns', async () => {
        const consoleWarnMock = mock.method(console, 'warn', () => {});
        const error = new Error('Database disconnected during column info fetch');
        const dbOps = {
            getTableInfo: mock.fn(async () => { throw error; }),
            deleteColumns: mock.fn(async () => {})
        };
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            recordExternalModification: mock.fn(),
        };
        const mockProvider = { webviews: new Map(), context: {} };
        const bridge = new HostBridge(mockProvider as any, mockDocument as any);
        (bridge as any).ensureDatabaseInitialized = () => dbOps as any;

        await bridge.deleteColumns('table1', ['col1']);

        assert.strictEqual(consoleWarnMock.mock.callCount(), 1);
        assert.deepStrictEqual(consoleWarnMock.mock.calls[0].arguments, [
            'Failed to fetch column data for undo history:',
            error
        ]);

        assert.strictEqual(dbOps.deleteColumns.mock.callCount(), 1);
        assert.deepStrictEqual(dbOps.deleteColumns.mock.calls[0].arguments, ['table1', ['col1'], undefined]);
    });
});
