
import './vscode_mock_setup';
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import { HostBridge } from '../../src/hostBridge';
import * as vscode from 'vscode';

describe('HostBridge', () => {

    afterEach(() => {
        mock.reset();
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

        // HostBridge constructs path:
        // const uriPath = [docKey, ...cellParts].map(p => encodeURIComponent(p)).join('/');
        // cellParts = [table, name, rowId, filename]
        // filename = colName + extname

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
});
