
import './vscode_mock_setup';
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import { HostBridge, toWebviewQueryResultSet } from '../../src/hostBridge';
import * as vscode from 'vscode';
import { createDeferred } from './helpers/deferred';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { serializeOperations } from '../../src/core/operation-serializer';
import { deserializeValue, serializeValue } from '../../src/core/serialization';
import {
    encodePrimaryKeyRecordId,
    encodeReadOnlyPrimaryKeyRecordId
} from '../../src/core/row-identity';
import {
    CELL_EDIT_VALUE_TOO_LARGE_CODE,
    DEFAULT_MAX_CELL_EDIT_BYTES,
    toCellEditPolicyErrorData
} from '../../src/core/cell-edit-policy';
import { DEFAULT_MAX_INLINE_CELL_BYTES } from '../../src/core/cell-containment';
import { MAX_WEBVIEW_BINARY_VALUE_BYTES } from '../../src/core/webview-transport';

describe('HostBridge', () => {
    it('projects one canonical row matrix without changing bounded consumer bytes', () => {
        const bytes = Uint8Array.from([0, 1, 2, 127, 255]);
        const rows = [[bytes]];
        const projected = toWebviewQueryResultSet({
            headers: ['payload'],
            rows,
            columns: ['payload'],
            values: rows,
            records: rows
        });

        assert.strictEqual(projected.rows, rows);
        assert.strictEqual('values' in projected, false);
        assert.strictEqual('records' in projected, false);
        const consumer = deserializeValue(serializeValue(projected)) as typeof projected;
        assert.deepStrictEqual(consumer.rows[0][0], bytes);
    });

    it('tracks only database-persistent PRAGMAs for writable paged documents', async () => {
        const pragmas: Record<string, unknown> = {
            journal_mode: 'delete',
            auto_vacuum: 0,
            foreign_keys: 0,
            synchronous: 2,
            cache_size: -2000,
            locking_mode: 'normal',
            temp_store: 0
        };
        const recorded: any[] = [];
        const databaseOperations = {
            getPragmas: async () => ({ ...pragmas }),
            setPragma: async (pragma: string, value: unknown) => {
                pragmas[pragma] = value;
            }
        };
        const bridge = new HostBridge(
            { webviews: new Map(), context: {}, isReadOnly: false } as any,
            {
                databaseOperations,
                isReadOnlyMode: false,
                isPagedWritableMode: true,
                runTrackedMutation: async (operation: () => unknown) => await operation(),
                recordExternalModification: (entry: unknown) => recorded.push(entry)
            } as any
        );

        await bridge.setPragma('journal_mode', 'WAL');
        await bridge.setPragma('auto_vacuum', 1);
        await bridge.setPragma('foreign_keys', 1);
        await bridge.setPragma('synchronous', 1);
        await bridge.setPragma('cache_size', -1000);
        await bridge.setPragma('locking_mode', 'EXCLUSIVE');
        await bridge.setPragma('temp_store', 2);

        assert.deepStrictEqual(
            recorded.map(entry => ({
                modificationType: entry.modificationType,
                targetPragma: entry.targetPragma,
                priorValue: entry.priorValue,
                newValue: entry.newValue,
                undoPolicy: entry.undoPolicy,
                undoBarrierKind: entry.undoBarrierKind
            })),
            [
                {
                    modificationType: 'pragma_update',
                    targetPragma: 'journal_mode',
                    priorValue: 'delete',
                    newValue: 'WAL',
                    undoPolicy: 'barrier',
                    undoBarrierKind: 'persistent_pragma'
                },
                {
                    modificationType: 'pragma_update',
                    targetPragma: 'auto_vacuum',
                    priorValue: 0,
                    newValue: 1,
                    undoPolicy: 'barrier',
                    undoBarrierKind: 'persistent_pragma'
                }
            ]
        );
    });

    it('rejects every cell/row mutation for an oversized primary-key identity with its precise reason', async () => {
        const reason = 'Row is read-only because primary-key column "key" is 32 bytes.';
        const rowId = encodeReadOnlyPrimaryKeyRecordId(reason, 0);
        const dbOps = {
            executeQuery: mock.fn(async () => []),
            updateCell: mock.fn(async () => {}),
            deleteRows: mock.fn(async () => {}),
            updateCellBatch: mock.fn(async () => {})
        };
        const bridge = new HostBridge(
            { webviews: new Map(), context: {}, isReadOnly: false } as any,
            {
                uri: vscode.Uri.parse('file:///test.db'),
                documentKey: Promise.resolve('test-key'),
                databaseOperations: dbOps,
                connectionGeneration: 1,
                isReadOnlyMode: false,
                recordExternalModification: mock.fn()
            } as any
        );

        await assert.rejects(
            () => bridge.updateCell('rowidless', rowId, 'value', 'after'),
            error => error instanceof Error && error.message === reason
        );
        await assert.rejects(
            () => bridge.deleteRows('rowidless', [rowId]),
            error => error instanceof Error && error.message === reason
        );
        await assert.rejects(
            () => bridge.updateCellBatch(
                'rowidless',
                [{ rowId, column: 'value', value: 'after' }],
                'Batch'
            ),
            error => error instanceof Error && error.message === reason
        );
        await assert.rejects(
            () => bridge.openCellEditor(
                { table: 'rowidless', name: '' },
                rowId,
                'value',
                {},
                { value: 'preview' }
            ),
            error => error instanceof Error && error.message === reason
        );
        assert.strictEqual(dbOps.executeQuery.mock.callCount(), 0);
        assert.strictEqual(dbOps.updateCell.mock.callCount(), 0);
        assert.strictEqual(dbOps.deleteRows.mock.callCount(), 0);
        assert.strictEqual(dbOps.updateCellBatch.mock.callCount(), 0);
    });

    it('enforces the configured inline-cell ceiling instead of trusting the caller', async () => {
        const result = await createDatabaseEngine({ content: null, maxSize: 0 });
        const dbOps = result.operations!;
        const configStore = (vscode.workspace as any)._config as Map<string, unknown>;
        configStore.set('maxInlineCellBytes', 1024);
        try {
            await dbOps.executeQuery(
                "CREATE TABLE bounded_bridge (value TEXT); " +
                "INSERT INTO bounded_bridge VALUES (printf('%.*c', 2048, 'x'))"
            );
            const bridge = new HostBridge(
                { webviews: new Map(), context: {}, isReadOnly: false } as any,
                { databaseOperations: dbOps, isReadOnlyMode: false } as any
            );

            const page = await bridge.fetchTableData('bounded_bridge', {
                columns: ['value'],
                limit: 1,
                offset: 0,
                maxInlineCellBytes: 8 * 1024 * 1024,
                maxPageResponseBytes: 8 * 1024 * 1024 * 1024
            } as any);

            assert.ok(Buffer.byteLength(page.rows[0][0] as string, 'utf8') <= 1024);
            assert.deepStrictEqual((page as any).oversizedCells, {
                0: { 0: { storageClass: 'text', byteLength: 2048 } }
            });
            assert.strictEqual('values' in page, false);
            assert.strictEqual('records' in page, false);
            const transported = deserializeValue(serializeValue(page)) as typeof page;
            assert.strictEqual(transported.rows[0][0], page.rows[0][0]);
        } finally {
            configStore.clear();
            (dbOps as WasmDatabaseEngine).shutdown();
        }
    });

    it('cancels a superseded view preview', async () => {
        const signals: Array<AbortSignal | undefined> = [];
        let releaseFirstPreview: (() => void) | undefined;
        const previewResult = { headers: ['value'], rows: [[1]] };
        const databaseOperations = {
            previewViewDefinition: async (
                _view: string,
                _selectSql: string,
                _limit?: number,
                _intent?: string,
                signal?: AbortSignal
            ) => {
                signals.push(signal);
                if (signals.length === 1) {
                    await new Promise<void>(resolve => { releaseFirstPreview = resolve; });
                }
                return previewResult;
            }
        };
        const bridge = new HostBridge(
            { webviews: new Map(), context: {} } as any,
            { databaseOperations } as any
        );
        const firstPreview = bridge.previewViewDefinition(
            'first_preview',
            'SELECT 1',
            50,
            'create'
        );
        await Promise.resolve();

        try {
            await bridge.previewViewDefinition(
                'second_preview',
                'SELECT 2',
                50,
                'create'
            );
            assert.ok(signals[0], 'first preview did not receive an AbortSignal');
            assert.strictEqual(signals[0].aborted, true);
            assert.ok(signals[1], 'second preview did not receive an AbortSignal');
            assert.strictEqual(signals[1].aborted, false);
        } finally {
            releaseFirstPreview?.();
        }
        await firstPreview;
    });


    afterEach(() => {
        mock.reset();
    });

    it('saveFile should prevent path traversal by stripping directory components from filename', async () => {
        const mockDocument = {
            uri: vscode.Uri.file('/dbDir/test.db'),
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

    it('rejects an oversized selected BLOB before reading it into the extension host', async () => {
        const selectedUri = vscode.Uri.parse('file:///dbDir/too-large.bin');
        mock.method(vscode.window, 'showOpenDialog', async () => [selectedUri]);
        mock.method(vscode.workspace.fs, 'stat', async () => ({
            type: vscode.FileType.File,
            ctime: 0,
            mtime: 0,
            size: DEFAULT_MAX_CELL_EDIT_BYTES + 1
        }));
        const readFile = mock.method(
            vscode.workspace.fs,
            'readFile',
            async () => new Uint8Array(0)
        );
        const bridge = new HostBridge(
            { webviews: new Map(), context: {} } as any,
            { uri: vscode.Uri.parse('file:///dbDir/test.db') } as any
        );

        await assert.rejects(
            bridge.selectFile(),
            (error: Error) => {
                assert.strictEqual((error as any).code, CELL_EDIT_VALUE_TOO_LARGE_CODE);
                assert.match(error.message, new RegExp(`${DEFAULT_MAX_CELL_EDIT_BYTES}-byte edit limit`));
                return true;
            }
        );
        assert.strictEqual(readFile.mock.callCount(), 0);
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

    it('opens an oversized cell from a temp materialization and marks the editor read-only', async () => {
        const executeCommandMock = mock.method(vscode.commands, 'executeCommand', async () => {});
        const tempUri = vscode.Uri.file('/private/materialized/random.bin');
        const materializer = {
            materialize: mock.fn(async (_operations: any, _target: any, _options: any) => ({
                uri: tempUri,
                metadata: { storageClass: 'blob', byteLength: 2 * 1024 * 1024 },
                byteLength: 2 * 1024 * 1024,
                checksumSha256: '0'.repeat(64)
            })),
            release: mock.fn()
        };
        const dbOps = {
            getCellMetadata: mock.fn(async (_target: any) => ({
                storageClass: 'blob',
                byteLength: 2 * 1024 * 1024
            }))
        };
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            onDidDispose: () => ({ dispose() {} })
        };
        const bridge = new HostBridge({
            webviews: new Map(),
            context: {},
            cellMaterializer: materializer
        } as any, mockDocument as any);

        await bridge.openCellEditor(
            { table: 'large_cells' },
            1,
            'payload',
            {},
            { value: new Uint8Array(1024), type: { type: 'binary', ext: 'bin' } }
        );

        assert.strictEqual(dbOps.getCellMetadata.mock.callCount(), 1);
        assert.deepStrictEqual(dbOps.getCellMetadata.mock.calls[0].arguments[0], {
            table: 'large_cells',
            rowId: 1,
            column: 'payload'
        });
        assert.strictEqual(materializer.materialize.mock.callCount(), 1);
        assert.strictEqual(
            materializer.materialize.mock.calls[0].arguments[2].owner,
            mockDocument
        );
        assert.strictEqual(executeCommandMock.mock.callCount(), 2);
        assert.deepStrictEqual(executeCommandMock.mock.calls[0].arguments, [
            'vscode.open',
            tempUri,
            vscode.ViewColumn.Two
        ]);
        assert.strictEqual(
            executeCommandMock.mock.calls[1].arguments[0],
            'workbench.action.files.setActiveEditorReadonlyInSession'
        );
    });

    it('serves oversized media from a panel-owned temp URI within narrowed roots', async () => {
        const tempUri = vscode.Uri.file(
            '/private/materialized/sqlite-explorer-cell-materializations-run/random.png'
        );
        const webview = {
            options: { enableScripts: true, localResourceRoots: [] as vscode.Uri[] },
            asWebviewUri: mock.fn((uri: vscode.Uri) => ({
                toString: () => `https://wv-resource.test${uri.path}`
            }))
        };
        const panel = {
            webview,
            onDidDispose: () => ({ dispose() {} })
        };
        const documentUri = vscode.Uri.parse('file:///test.db');
        const webviews = {
            getByWebviewId: (id: string) => id === 'wv-media' ? panel : undefined,
            *get(uri: vscode.Uri) {
                if (uri.toString() === documentUri.toString()) yield panel;
            }
        };
        const materializer = {
            materialize: mock.fn(async (_operations: any, _target: any, _options: any) => ({
                uri: tempUri,
                metadata: { storageClass: 'blob', byteLength: 32 * 1024 * 1024 },
                byteLength: 32 * 1024 * 1024,
                checksumSha256: '0'.repeat(64)
            })),
            release: mock.fn((_uri: vscode.Uri) => {})
        };
        const dbOps = {
            getCellMetadata: mock.fn(async () => ({
                storageClass: 'blob',
                byteLength: 32 * 1024 * 1024
            }))
        };
        const bridge = new HostBridge({
            webviews,
            context: { extensionUri: vscode.Uri.file('/extension') },
            cellMaterializer: materializer
        } as any, {
            uri: documentUri,
            databaseOperations: dbOps
        } as any);

        const result = await (bridge as any).prepareCellMediaPreview(
            { table: 'large_cells' },
            1,
            'payload',
            {
                type: { type: 'image', mime: 'image/png', ext: 'png' },
                webviewId: 'wv-media',
                sourceByteLength: 32 * 1024 * 1024
            }
        );

        assert.strictEqual(result.success, true);
        assert.strictEqual(
            result.uri,
            'https://wv-resource.test/private/materialized/sqlite-explorer-cell-materializations-run/random.png'
        );
        assert.strictEqual(result.byteLength, 32 * 1024 * 1024);
        assert.strictEqual('bytes' in result, false);
        assert.strictEqual('data' in result, false);
        assert.strictEqual('value' in result, false);
        assert.deepStrictEqual(materializer.materialize.mock.calls[0].arguments[1], {
            table: 'large_cells',
            rowId: 1,
            column: 'payload'
        });
        assert.strictEqual(materializer.materialize.mock.calls[0].arguments[2].owner, panel);
        assert.strictEqual(materializer.materialize.mock.calls[0].arguments[2].fileExtension, 'png');
        assert.deepStrictEqual(
            webview.options.localResourceRoots.map(uri => uri.fsPath),
            [
                '/extension/assets/codicons',
                '/private/materialized/sqlite-explorer-cell-materializations-run'
            ]
        );

        await (bridge as any).releaseCellMediaPreview('wv-media', result.previewId);
        assert.strictEqual(materializer.release.mock.callCount(), 1);
        assert.strictEqual(materializer.release.mock.calls[0].arguments[0], tempUri);
        assert.deepStrictEqual(
            webview.options.localResourceRoots.map(uri => uri.fsPath),
            ['/extension/assets/codicons']
        );
    });

    it('refuses an oversized VFS open with an explicit export alternative if materialization fails', async () => {
        const executeCommandMock = mock.method(vscode.commands, 'executeCommand', async () => {});
        const materializer = {
            materialize: mock.fn(async () => {
                throw new Error('temporary-file quota exceeded');
            }),
            release: mock.fn()
        };
        const bridge = new HostBridge({
            webviews: new Map(),
            context: {},
            cellMaterializer: materializer
        } as any, {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: {
                getCellMetadata: async () => ({
                    storageClass: 'text',
                    byteLength: 2 * 1024 * 1024
                })
            },
            onDidDispose: () => ({ dispose() {} })
        } as any);

        await assert.rejects(
            bridge.openCellEditor(
                { table: 'large_cells' },
                1,
                'payload',
                {},
                { value: 'bounded preview' }
            ),
            /temporary-file quota exceeded.*Export the cell instead/is
        );
        assert.strictEqual(executeCommandMock.mock.callCount(), 0);
    });

    it('cancels in-flight oversized materialization when the database document closes', async () => {
        const disposeEmitter = new vscode.EventEmitter<void>();
        const materializeStarted = createDeferred<void>();
        const materializer = {
            materialize: mock.fn(async (_operations: any, _target: any, options: any) => {
                materializeStarted.resolve();
                await new Promise<void>((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => {
                        const error = new Error('cancelled');
                        error.name = 'AbortError';
                        reject(error);
                    }, { once: true });
                });
            }),
            release: mock.fn()
        };
        const bridge = new HostBridge({
            webviews: new Map(),
            context: {},
            cellMaterializer: materializer
        } as any, {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: {
                getCellMetadata: async () => ({
                    storageClass: 'blob',
                    byteLength: 2 * 1024 * 1024
                })
            },
            onDidDispose: disposeEmitter.event
        } as any);

        const opening = bridge.openCellEditor(
            { table: 'large_cells' },
            1,
            'payload',
            {},
            { value: new Uint8Array(8) }
        );
        await materializeStarted.promise;
        disposeEmitter.fire();

        await assert.rejects(opening, /cancelled.*Export the cell instead/is);
        assert.strictEqual(materializer.materialize.mock.calls[0].arguments[2].signal.aborted, true);
    });

    it('encodes a BLOB composite primary-key identity into one cell URI segment', async () => {
        const executeCommandMock = mock.method(vscode.commands, 'executeCommand', async () => {});
        const identity = encodePrimaryKeyRecordId(
            [
                { identifier: 'space', declaredType: 'BLOB', position: 1 },
                { identifier: 'key', declaredType: 'TEXT', position: 2 }
            ],
            [new Uint8Array([0, 47, 255]), 'item/one']
        );
        const bridge = new HostBridge({ webviews: new Map(), context: {} } as any, {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key')
        } as any);

        await bridge.openCellEditor(
            { table: 'items', name: 'db' },
            identity,
            'value',
            {},
            { value: 'payload' }
        );

        const uri = executeCommandMock.mock.calls[0].arguments[1] as vscode.Uri;
        const pathSegments = uri.path.split('/').filter(Boolean).map(decodeURIComponent);
        assert.strictEqual(pathSegments[3], identity);
        assert.strictEqual(pathSegments.length, 5);
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

    it('propagates an engine-owned undo preflight failure without recording history', async () => {
        const consoleWarnMock = mock.method(console, 'warn', () => {});
        const error = new Error('Database disconnected');
        const dbOps = {
            deleteRows: mock.fn(async () => { throw error; })
        };
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            recordExternalModification: mock.fn(),
        };
        const mockProvider = { webviews: new Map(), context: {} };
        const bridge = new HostBridge(mockProvider as any, mockDocument as any);
        (bridge as any).ensureDatabaseInitialized = () => dbOps as any;

        await assert.rejects(bridge.deleteRows('table1', [1]), error);
        assert.strictEqual(consoleWarnMock.mock.callCount(), 0);
        assert.strictEqual(dbOps.deleteRows.mock.callCount(), 1);
        assert.strictEqual(mockDocument.recordExternalModification.mock.callCount(), 0);
    });

    it('records the engine-owned exact snapshot and passes a pre-materialization budget', async () => {
        const deletedRows = [{
            rowId: 9,
            row: { base: 5, rowid: 9 }
        }];
        const dbOps = {
            deleteRows: mock.fn(async (
                _table: string,
                _rowIds: (string | number)[],
                _maxUndoSnapshotBytes?: number
            ) => deletedRows)
        };
        const recordExternalModification = mock.fn();
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            undoMemoryLimitBytes: 1024,
            recordExternalModification
        };
        const bridge = new HostBridge(
            { webviews: new Map(), context: {} } as any,
            mockDocument as any
        );
        (bridge as any).ensureDatabaseInitialized = () => dbOps as any;

        await bridge.deleteRows('generated_rows', [9]);

        const deleteArguments = dbOps.deleteRows.mock.calls[0].arguments;
        assert.deepStrictEqual(deleteArguments.slice(0, 2), ['generated_rows', [9]]);
        const snapshotBudget = deleteArguments[2];
        assert.ok(typeof snapshotBudget === 'number' && Number.isSafeInteger(snapshotBudget));
        assert.ok(snapshotBudget > 0 && snapshotBudget < 1024);
        const modification = recordExternalModification.mock.calls[0].arguments[0] as any;
        assert.deepStrictEqual(modification.deletedRows, deletedRows);
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

    it('rejects fireEditEvent for a read-only document without recording history', async () => {
        const recordExternalModification = mock.fn();
        const bridge = new HostBridge(
            { webviews: new Map(), context: {}, isReadOnly: false } as any,
            {
                isReadOnlyMode: true,
                recordExternalModification
            } as any
        );

        await assert.rejects(
            () => bridge.fireEditEvent({
                label: 'Edit Cell',
                description: 'Update items.name',
                modificationType: 'cell_update',
                targetTable: 'items',
                targetRowId: 1,
                targetColumn: 'name',
                priorValue: 'before',
                newValue: 'after'
            }),
            /Document is read-only/
        );
        assert.strictEqual(recordExternalModification.mock.callCount(), 0);
    });

    it('rejects malformed fireEditEvent entries without recording history', async () => {
        const recordExternalModification = mock.fn();
        const bridge = new HostBridge(
            { webviews: new Map(), context: {}, isReadOnly: false } as any,
            {
                isReadOnlyMode: false,
                recordExternalModification
            } as any
        );

        await assert.rejects(
            () => bridge.fireEditEvent({
                label: 'Forged Edit',
                description: 'Unknown history entry',
                modificationType: 'arbitrary_write',
                targetTable: 'items'
            } as any),
            /Invalid document modification/
        );
        await assert.rejects(
            () => bridge.fireEditEvent({
                label: 'Malformed Delete',
                description: 'Missing row snapshots',
                modificationType: 'row_delete',
                targetTable: 'items'
            } as any),
            /Invalid document modification/
        );
        assert.strictEqual(recordExternalModification.mock.callCount(), 0);
    });

    it('records a structurally valid fireEditEvent on a writable document', async () => {
        const recordExternalModification = mock.fn();
        const bridge = new HostBridge(
            { webviews: new Map(), context: {}, isReadOnly: false } as any,
            {
                isReadOnlyMode: false,
                recordExternalModification
            } as any
        );
        const edit = {
            label: 'Edit Cell',
            description: 'Update items.name',
            modificationType: 'cell_update' as const,
            targetTable: 'items',
            targetRowId: 1,
            targetColumn: 'name',
            priorValue: 'before',
            newValue: 'after'
        };

        await bridge.fireEditEvent(edit);

        assert.strictEqual(recordExternalModification.mock.callCount(), 1);
        assert.strictEqual(recordExternalModification.mock.calls[0].arguments[0], edit);
    });

    it('does not record a created view after Reload supersedes its connection', async () => {
        const definition = {
            identifier: 'created_view',
            sql: 'CREATE VIEW created_view AS SELECT 1 AS value',
            selectSql: 'SELECT 1 AS value',
            triggers: []
        };
        let connectionGeneration = 7;
        const createStarted = createDeferred<void>();
        const createResult = createDeferred<typeof definition>();
        const dbOps = {
            createView: mock.fn(async () => {
                createStarted.resolve();
                return createResult.promise;
            })
        };
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            get connectionGeneration() { return connectionGeneration; },
            recordExternalModification: mock.fn()
        };
        const bridge = new HostBridge({ webviews: new Map(), context: {} } as any, mockDocument as any);

        const pending = bridge.createView('created_view', 'SELECT 1 AS value');
        await createStarted.promise;
        connectionGeneration++;
        createResult.resolve(definition);

        await assert.rejects(pending, /document was reloaded/i);
        assert.strictEqual(dbOps.createView.mock.callCount(), 1);
        assert.strictEqual(mockDocument.recordExternalModification.mock.callCount(), 0);
    });

    it('does not record an edited view after Reload supersedes its connection', async () => {
        const before = {
            identifier: 'edited_view',
            sql: 'CREATE VIEW edited_view AS SELECT 1 AS value',
            selectSql: 'SELECT 1 AS value',
            triggers: []
        };
        const after = {
            ...before,
            sql: 'CREATE VIEW edited_view AS SELECT 2 AS value',
            selectSql: 'SELECT 2 AS value'
        };
        let connectionGeneration = 8;
        const editStarted = createDeferred<void>();
        const editResult = createDeferred<{ before: typeof before; after: typeof after }>();
        const dbOps = {
            editView: mock.fn(async () => {
                editStarted.resolve();
                return editResult.promise;
            })
        };
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            get connectionGeneration() { return connectionGeneration; },
            recordExternalModification: mock.fn()
        };
        const bridge = new HostBridge({ webviews: new Map(), context: {} } as any, mockDocument as any);

        const pending = bridge.editView('edited_view', 'SELECT 2 AS value');
        await editStarted.promise;
        connectionGeneration++;
        editResult.resolve({ before, after });

        await assert.rejects(pending, /document was reloaded/i);
        assert.strictEqual(dbOps.editView.mock.callCount(), 1);
        assert.strictEqual(mockDocument.recordExternalModification.mock.callCount(), 0);
    });

    it('does not record a dropped view after Reload supersedes its connection', async () => {
        const definition = {
            identifier: 'dropped_view',
            sql: 'CREATE VIEW dropped_view AS SELECT 1 AS value',
            selectSql: 'SELECT 1 AS value',
            triggers: []
        };
        let connectionGeneration = 9;
        const dropStarted = createDeferred<void>();
        const dropResult = createDeferred<typeof definition>();
        const dbOps = {
            getViewDefinition: mock.fn(async () => definition),
            dropView: mock.fn(async () => {
                dropStarted.resolve();
                return dropResult.promise;
            })
        };
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            get connectionGeneration() { return connectionGeneration; },
            recordExternalModification: mock.fn()
        };
        const bridge = new HostBridge({ webviews: new Map(), context: {} } as any, mockDocument as any);
        mock.method(vscode.window, 'showWarningMessage', async () => ({ title: 'Drop View', value: true }));

        const pending = bridge.dropView('dropped_view');
        await dropStarted.promise;
        connectionGeneration++;
        dropResult.resolve(definition);

        await assert.rejects(pending, /document was reloaded/i);
        assert.strictEqual(dbOps.dropView.mock.callCount(), 1);
        assert.strictEqual(mockDocument.recordExternalModification.mock.callCount(), 0);
    });

    it('rejects a cell update when the document reloads while its undo baseline is loading', async () => {
        const baseline = createDeferred<any>();
        const baselineStarted = createDeferred<void>();
        const dbOps = {
            executeQuery: mock.fn(async (sql: string) => {
                if (sql.includes('pragma_table_list')) {
                    return [{ headers: ['type', 'wr'], rows: [['table', 0]] }];
                }
                baselineStarted.resolve();
                return baseline.promise;
            }),
            updateCell: mock.fn(async () => {})
        };
        let connectionGeneration = 4;
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            get connectionGeneration() { return connectionGeneration; },
            recordExternalModification: mock.fn()
        };
        const bridge = new HostBridge({ webviews: new Map(), context: {} } as any, mockDocument as any);

        const pending = bridge.updateCell('items', 7, 'payload', 'after');
        await baselineStarted.promise;
        connectionGeneration++;
        baseline.resolve([{ headers: ['payload'], rows: [['before']] }]);

        await assert.rejects(pending, /document was reloaded/i);
        assert.strictEqual(dbOps.updateCell.mock.callCount(), 0);
        assert.strictEqual(mockDocument.recordExternalModification.mock.callCount(), 0);
    });

    it('allows a BLOB replacement above the inline preview ceiling up to the transport ceiling', async () => {
        const replacement = new Uint8Array(DEFAULT_MAX_INLINE_CELL_BYTES + 1);
        const dbOps = {
            executeQuery: mock.fn(async (sql: string) => sql.includes('pragma_table_list')
                ? [{ headers: ['type', 'wr'], rows: [['table', 0]] }]
                : [{
                    headers: ['storage_class', 'byte_length', 'bounded_value'],
                    rows: [['blob', 1, new Uint8Array([7])]]
                }]),
            updateCell: mock.fn(async () => 7)
        };
        const recordExternalModification = mock.fn();
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            connectionGeneration: 1,
            recordExternalModification
        };
        const bridge = new HostBridge({ webviews: new Map(), context: {} } as any, mockDocument as any);

        const updatedRowId = await bridge.updateCell('items', 7, 'payload', replacement);

        assert.strictEqual(updatedRowId, 7);
        assert.strictEqual(dbOps.updateCell.mock.callCount(), 1);
        assert.strictEqual(
            Array.from(dbOps.updateCell.mock.calls[0].arguments)[5],
            MAX_WEBVIEW_BINARY_VALUE_BYTES
        );
        assert.strictEqual(recordExternalModification.mock.callCount(), 1);
    });

    it('rejects a new cell value above the transport edit ceiling before any database read', async () => {
        const dbOps = {
            executeQuery: mock.fn(async () => []),
            updateCell: mock.fn(async () => {})
        };
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            connectionGeneration: 1,
            recordExternalModification: mock.fn()
        };
        const bridge = new HostBridge({ webviews: new Map(), context: {} } as any, mockDocument as any);

        await assert.rejects(
            () => bridge.updateCell(
                'items',
                7,
                'payload',
                new Uint8Array(MAX_WEBVIEW_BINARY_VALUE_BYTES + 1)
            ),
            error => {
                const typed = toCellEditPolicyErrorData(error);
                assert.strictEqual(typed?.code, CELL_EDIT_VALUE_TOO_LARGE_CODE);
                assert.strictEqual(typed?.storageClass, 'blob');
                assert.strictEqual(typed?.actualBytes, MAX_WEBVIEW_BINARY_VALUE_BYTES + 1);
                assert.strictEqual(typed?.limitBytes, MAX_WEBVIEW_BINARY_VALUE_BYTES);
                return true;
            }
        );

        assert.strictEqual(dbOps.executeQuery.mock.callCount(), 0);
        assert.strictEqual(dbOps.updateCell.mock.callCount(), 0);
        assert.strictEqual(mockDocument.recordExternalModification.mock.callCount(), 0);
    });

    it('confirms and replaces an oversized prior cell without selecting its whole value', async () => {
        const sourceBytes = 256 * 1024 * 1024;
        const sqlCalls: string[] = [];
        const dbOps = {
            executeQuery: mock.fn(async (sql: string) => {
                sqlCalls.push(sql);
                if (sql.includes('pragma_table_list')) {
                    return [{ headers: ['type', 'wr'], rows: [['table', 0]] }];
                }
                assert.match(sql, /CASE WHEN/);
                assert.match(sql, /length\(CAST\("payload" AS BLOB\)\)/);
                assert.doesNotMatch(sql, /^SELECT\s+"payload"\s+FROM/i);
                return [{
                    headers: ['storage_class', 'byte_length', 'bounded_value'],
                    rows: [['blob', sourceBytes, null]]
                }];
            }),
            replaceOversizedCell: mock.fn(async () => 7),
            updateCell: mock.fn(async () => 7)
        };
        const recordExternalModification = mock.fn();
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            connectionGeneration: 1,
            recordExternalModification
        };
        const bridge = new HostBridge({ webviews: new Map(), context: {} } as any, mockDocument as any);
        const confirmations: unknown[][] = [];
        mock.method(vscode.window, 'showWarningMessage', async (...args: unknown[]) => {
            confirmations.push(args);
            return { title: 'Replace Without Undo', value: true } as any;
        });

        const updatedRowId = await bridge.updateCell('items', 7, 'payload', 'replacement');

        assert.strictEqual(updatedRowId, 7);
        assert.strictEqual(dbOps.updateCell.mock.callCount(), 0);
        assert.strictEqual(dbOps.replaceOversizedCell.mock.callCount(), 1);
        assert.deepStrictEqual(dbOps.replaceOversizedCell.mock.calls[0].arguments, [
            'items',
            7,
            'payload',
            'replacement',
            { storageClass: 'blob', byteLength: sourceBytes },
            MAX_WEBVIEW_BINARY_VALUE_BYTES
        ]);
        assert.strictEqual(confirmations.length, 1);
        const confirmationText = String(confirmations[0][0]);
        assert.match(confirmationText, /items/);
        assert.match(confirmationText, /payload/);
        assert.match(confirmationText, /BLOB/);
        assert.match(confirmationText, /268[,.]435[,.]456 bytes/);
        assert.match(confirmationText, /cannot be undone/i);
        assert.match(confirmationText, /Undo will not cross this edit/i);
        assert.match(confirmationText, /redo history will be discarded/i);
        assert.strictEqual(sqlCalls.length, 2);

        const modification = recordExternalModification.mock.calls[0].arguments[0] as any;
        assert.strictEqual(modification.undoPolicy, 'barrier');
        assert.strictEqual(modification.priorValue, undefined);
        assert.strictEqual(modification.newValue, 'replacement');
    });

    it('leaves history untouched when an oversized replacement fails after confirmation', async () => {
        const writeError = new Error('guarded update failed');
        const dbOps = {
            executeQuery: mock.fn(async (sql: string) => sql.includes('pragma_table_list')
                ? [{ headers: ['type', 'wr'], rows: [['table', 0]] }]
                : [{
                    headers: ['storage_class', 'byte_length', 'bounded_value'],
                    rows: [['text', 32 * 1024 * 1024, null]]
                }]),
            replaceOversizedCell: mock.fn(async () => { throw writeError; }),
            updateCell: mock.fn(async () => 1)
        };
        const recordExternalModification = mock.fn();
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            connectionGeneration: 1,
            recordExternalModification
        };
        const bridge = new HostBridge({ webviews: new Map(), context: {} } as any, mockDocument as any);
        mock.method(vscode.window, 'showWarningMessage', async () => (
            { title: 'Replace Without Undo', value: true } as any
        ));

        await assert.rejects(
            () => bridge.updateCell('items', 1, 'payload', 'replacement'),
            error => error === writeError
        );

        assert.strictEqual(dbOps.replaceOversizedCell.mock.callCount(), 1);
        assert.strictEqual(recordExternalModification.mock.callCount(), 0);
    });

    it('uses database-current batch values for JSON patches and undo history', async () => {
        const sqlCalls: string[] = [];
        const batchCalls: any[][] = [];
        const dbOps = {
            executeQuery: mock.fn(async (sql: string) => {
                sqlCalls.push(sql);
                if (sql.includes('pragma_table_list')) {
                    return [{ headers: ['type', 'wr'], rows: [['table', 0]] }];
                }
                if (sql.startsWith('SELECT CAST(rowid AS TEXT)')) {
                    return [{
                        headers: ['rowid', 'payload', 'label'],
                        rows: [[7, '{"count":1,"concurrent":true}', 'database-current']]
                    }];
                }
                return [];
            }),
            updateCellBatch: mock.fn(async (_table: string, updates: any[]) => {
                batchCalls.push(updates);
                return [
                    {
                        rowId: 7,
                        columnName: 'payload',
                        newValue: '{"count":2}',
                        priorValue: '{"count":1,"concurrent":true}',
                        operation: 'json_patch'
                    },
                    {
                        rowId: 7,
                        columnName: 'label',
                        newValue: 'after',
                        priorValue: 'database-current',
                        operation: 'set'
                    }
                ];
            })
        };
        const recordExternalModification = mock.fn();
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            connectionGeneration: 3,
            recordExternalModification
        };
        const bridge = new HostBridge({ webviews: new Map(), context: {} } as any, mockDocument as any);

        await bridge.updateCellBatch('items', [
            {
                rowId: 7,
                column: 'payload',
                value: '{"count":2,"concurrent":true}',
                originalValue: '{"count":0}'
            },
            {
                rowId: 7,
                column: 'label',
                value: 'after',
                originalValue: 'caller-stale'
            }
        ], 'Authoritative batch');

        assert.strictEqual(batchCalls.length, 1);
        assert.deepStrictEqual(batchCalls[0], [
            {
                rowId: 7,
                column: 'payload',
                value: '{"count":2,"concurrent":true}',
                originalValue: '{"count":0}'
            },
            {
                rowId: 7,
                column: 'label',
                value: 'after',
                originalValue: 'caller-stale'
            }
        ]);
        assert.deepStrictEqual(
            sqlCalls.filter(sql => !sql.includes('pragma_table_list')),
            [],
            'the host must not split the engine-owned batch transaction across RPC calls'
        );

        const modification = recordExternalModification.mock.calls[0].arguments[0] as any;
        assert.deepStrictEqual(modification.affectedCells, [
            {
                rowId: 7,
                columnName: 'payload',
                newValue: '{"count":2}',
                priorValue: '{"count":1,"concurrent":true}',
                operation: 'json_patch'
            },
            {
                rowId: 7,
                columnName: 'label',
                newValue: 'after',
                priorValue: 'database-current',
                operation: 'set'
            }
        ]);
    });

    it('passes only the residual undo-entry budget into an atomic batch', async () => {
        let updateArguments: unknown[] | undefined;
        const dbOps = {
            updateCellBatch: mock.fn(async (...args: unknown[]) => {
                updateArguments = args;
                return [{
                    rowId: 1,
                    columnName: 'payload',
                    priorValue: 'before',
                    newValue: 'after',
                    operation: 'set' as const
                }];
            })
        };
        const recordExternalModification = mock.fn();
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            connectionGeneration: 1,
            undoMemoryLimitBytes: 4096,
            recordExternalModification
        };
        const bridge = new HostBridge(
            { webviews: new Map(), context: {} } as any,
            mockDocument as any
        );

        await bridge.updateCellBatch(
            'items',
            [{ rowId: 1, column: 'payload', value: 'after' }],
            'Budgeted batch'
        );

        assert.ok(updateArguments);
        assert.strictEqual(updateArguments.length, 4);
        assert.strictEqual(updateArguments[0], 'items');
        assert.strictEqual(updateArguments[2], 16 * 1024 * 1024);
        assert.ok(Number.isSafeInteger(updateArguments[3]));
        assert.ok(Number(updateArguments[3]) >= 0 && Number(updateArguments[3]) < 4096);
        assert.strictEqual(recordExternalModification.mock.callCount(), 1);
    });

    it('reserves a rewritten primary-key identity for every affected cell in its row', async () => {
        const updateCellBatch = mock.fn(async () => []);
        const rowId = encodePrimaryKeyRecordId(
            [{ identifier: 'tenant', declaredType: 'TEXT', position: 1 }],
            ['old']
        );
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: { updateCellBatch },
            isReadOnlyMode: false,
            connectionGeneration: 1,
            undoMemoryLimitBytes: 6000,
            recordExternalModification: mock.fn()
        };
        const bridge = new HostBridge(
            { webviews: new Map(), context: {} } as any,
            mockDocument as any
        );

        await assert.rejects(
            bridge.updateCellBatch('items', [
                { rowId, column: 'tenant', value: '\u0800'.repeat(200) },
                { rowId, column: 'payload', value: 'after' }
            ], 'Rewrite key'),
            /Batch update undo metadata exceeds the 6000-byte memory limit/
        );
        assert.strictEqual(updateCellBatch.mock.callCount(), 0);
    });

    it('does not lose an interleaved single edit when an atomic batch rolls back', async () => {
        const database = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
        const raw = database.operations as WasmDatabaseEngine;
        const operations = serializeOperations(raw);
        const batchRejectedAtFacade = createDeferred<void>();
        const releaseBatchRejection = createDeferred<void>();
        const dbOps = new Proxy(operations, {
            get(target, property, receiver) {
                if (property === 'updateCellBatch') {
                    return async (...args: any[]) => {
                        try {
                            return await (target.updateCellBatch as any)(...args);
                        } catch (error) {
                            // Expose the exact old-host window: the engine has
                            // rolled back, but HostBridge has not yet rolled back
                            // its independently issued outer savepoint.
                            batchRejectedAtFacade.resolve();
                            await releaseBatchRejection.promise;
                            throw error;
                        }
                    };
                }
                return Reflect.get(target, property, receiver);
            }
        });
        const recordExternalModification = mock.fn();
        const document = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            connectionGeneration: 1,
            recordExternalModification
        };
        const provider = { webviews: new Map(), context: {}, isReadOnly: false };
        const batchBridge = new HostBridge(provider as any, document as any);
        const singleBridge = new HostBridge(provider as any, document as any);

        try {
            await raw.executeQuery('CREATE TABLE concurrent_batch (value TEXT UNIQUE)');
            await raw.executeQuery("INSERT INTO concurrent_batch(rowid, value) VALUES (1, 'a'), (2, 'b'), (3, 'c')");

            const batch = batchBridge.updateCellBatch('concurrent_batch', [
                { rowId: 1, column: 'value', value: 'x' },
                { rowId: 2, column: 'value', value: 'x' }
            ], 'Conflicting batch');
            await batchRejectedAtFacade.promise;
            const single = singleBridge.updateCell('concurrent_batch', 3, 'value', 'single');
            await single;
            releaseBatchRejection.resolve();

            await assert.rejects(batch, /UNIQUE constraint failed/);
            const rows = await operations.executeQuery(
                'SELECT rowid, value FROM concurrent_batch ORDER BY rowid'
            );
            assert.deepStrictEqual(rows[0].rows, [[1, 'a'], [2, 'b'], [3, 'single']]);
        } finally {
            raw.shutdown();
        }
    });

    it('serializes overlapping batches without crossing their savepoints', async () => {
        const database = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
        const raw = database.operations as WasmDatabaseEngine;
        const firstSavepointStarted = createDeferred<void>();
        const releaseFirstSavepoint = createDeferred<void>();
        const originalExecuteQuery = raw.executeQuery.bind(raw);
        let paused = false;
        raw.executeQuery = async (sql: string, params?: any[]) => {
            const result = await originalExecuteQuery(sql, params);
            if (!paused && /^SAVEPOINT "sp_update_batch_/.test(sql)) {
                paused = true;
                firstSavepointStarted.resolve();
                await releaseFirstSavepoint.promise;
            }
            return result;
        };
        const operations = serializeOperations(raw);
        const document = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: operations,
            isReadOnlyMode: false,
            connectionGeneration: 1,
            recordExternalModification: mock.fn()
        };
        const provider = { webviews: new Map(), context: {}, isReadOnly: false };
        const firstBridge = new HostBridge(provider as any, document as any);
        const secondBridge = new HostBridge(provider as any, document as any);

        try {
            await raw.executeQuery('CREATE TABLE overlapping_batches (value TEXT UNIQUE)');
            await raw.executeQuery("INSERT INTO overlapping_batches(rowid, value) VALUES (1, 'a'), (2, 'b'), (3, 'c')");

            const first = firstBridge.updateCellBatch('overlapping_batches', [
                { rowId: 1, column: 'value', value: 'x' },
                { rowId: 2, column: 'value', value: 'x' }
            ], 'First batch');
            await firstSavepointStarted.promise;
            const second = secondBridge.updateCellBatch('overlapping_batches', [
                { rowId: 3, column: 'value', value: 'second' }
            ], 'Second batch');
            releaseFirstSavepoint.resolve();

            await assert.rejects(first, /UNIQUE constraint failed/);
            await second;
            const rows = await operations.executeQuery(
                'SELECT rowid, value FROM overlapping_batches ORDER BY rowid'
            );
            assert.deepStrictEqual(rows[0].rows, [[1, 'a'], [2, 'b'], [3, 'second']]);
        } finally {
            raw.shutdown();
        }
    });

    it('records single and batch edits for WITHOUT ROWID tables instead of rejecting them', async () => {
        const result = await createDatabaseEngine({ content: null, maxSize: 0 });
        const dbOps = result.operations!;
        const recordExternalModification = mock.fn();
        try {
            await dbOps.executeQuery(
                "CREATE TABLE rowidless (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID; " +
                "INSERT INTO rowidless VALUES ('alpha', 'before')"
            );
            const page = await dbOps.fetchTableData('rowidless', {
                columns: ['rowid', 'key', 'value'],
                limit: 10,
                offset: 0
            });
            const identity = page.rows[0][0] as string;
            const mockDocument = {
                uri: vscode.Uri.parse('file:///test.db'),
                documentKey: Promise.resolve('test-key'),
                databaseOperations: dbOps,
                isReadOnlyMode: false,
                connectionGeneration: 1,
                recordExternalModification
            };
            const bridge = new HostBridge(
                { webviews: new Map(), context: {} } as any,
                mockDocument as any
            );

            await bridge.updateCell('rowidless', identity, 'value', 'after');
            const batchOutcomes = await bridge.updateCellBatch(
                'rowidless',
                [{ rowId: identity, column: 'key', value: 'beta' }],
                'Batch'
            );

            assert.deepStrictEqual(
                (await dbOps.executeQuery('SELECT key, value FROM rowidless'))[0].rows,
                [['beta', 'after']]
            );
            assert.ok(batchOutcomes);
            assert.strictEqual(batchOutcomes.length, 1);
            assert.strictEqual(batchOutcomes[0].rowId, identity);
            assert.notStrictEqual(batchOutcomes[0].newRowId, identity);
            assert.strictEqual(recordExternalModification.mock.callCount(), 2);
            assert.doesNotMatch(
                JSON.stringify(recordExternalModification.mock.calls),
                /WITHOUT ROWID tables are not editable yet/
            );
        } finally {
            (dbOps as WasmDatabaseEngine).shutdown();
        }
    });

    it('preserves rowid editing for virtual tables when resolving host-side identity', async () => {
        const identityQueries: string[] = [];
        const dbOps = {
            executeQuery: mock.fn(async (sql: string) => {
                if (sql.includes('pragma_table_list')) {
                    identityQueries.push(sql);
                    return sql.includes(`"type" = 'table'`)
                        ? [{ headers: ['type', 'wr'], rows: [] }]
                        : [{ headers: ['type', 'wr'], rows: [['virtual', 0]] }];
                }
                return [{
                    headers: ['storage_class', 'byte_length', 'bounded_value'],
                    rows: [['text', 6, 'before']]
                }];
            }),
            getTableInfo: mock.fn(async () => {
                throw new Error('virtual tables must not require declared-PK metadata');
            }),
            updateCell: mock.fn(async () => 7)
        };
        const recordExternalModification = mock.fn();
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            connectionGeneration: 1,
            recordExternalModification
        };
        const bridge = new HostBridge({ webviews: new Map(), context: {} } as any, mockDocument as any);

        await bridge.updateCell('docs_fts', 7, 'body', 'after');

        assert.strictEqual(dbOps.updateCell.mock.callCount(), 1);
        assert.strictEqual(dbOps.getTableInfo.mock.callCount(), 0);
        assert.strictEqual(recordExternalModification.mock.callCount(), 1);
        assert.strictEqual(identityQueries.length, 1);
        assert.doesNotMatch(identityQueries[0], /"type"\s*=\s*'table'/);
    });

    it('does not record an atomic batch after Reload supersedes its connection', async () => {
        const sqlCalls: string[] = [];
        let connectionGeneration = 11;
        const dbOps = {
            executeQuery: mock.fn(async (sql: string) => {
                sqlCalls.push(sql);
                if (sql.includes('pragma_table_list')) {
                    return [{ headers: ['type', 'wr'], rows: [['table', 0]] }];
                }
                return [];
            }),
            updateCellBatch: mock.fn(async () => {
                connectionGeneration++;
                return [{
                    rowId: 1,
                    columnName: 'value',
                    priorValue: 'before',
                    newValue: 'after',
                    operation: 'set' as const
                }];
            })
        };
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            get connectionGeneration() { return connectionGeneration; },
            recordExternalModification: mock.fn()
        };
        const bridge = new HostBridge({ webviews: new Map(), context: {} } as any, mockDocument as any);

        await assert.rejects(
            () => bridge.updateCellBatch(
                'items',
                [{ rowId: 1, column: 'value', value: 'after' }],
                'Batch'
            ),
            /document was reloaded/i
        );

        assert.strictEqual(dbOps.updateCellBatch.mock.callCount(), 1);
        assert.strictEqual(mockDocument.recordExternalModification.mock.callCount(), 0);
        assert.strictEqual(
            sqlCalls.some(sql => sql.startsWith('ROLLBACK TO SAVEPOINT ')),
            false,
            'the fresh connection must not receive rollback SQL for the old endpoint'
        );
    });

    it('preserves an atomic engine batch error without recording history', async () => {
        const writeError = new Error('batch write failed');
        const dbOps = {
            executeQuery: mock.fn(async (sql: string) => {
                if (sql.includes('pragma_table_list')) {
                    return [{ headers: ['type', 'wr'], rows: [['table', 0]] }];
                }
                return [];
            }),
            updateCellBatch: mock.fn(async () => {
                throw writeError;
            })
        };
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            connectionGeneration: 1,
            recordExternalModification: mock.fn()
        };
        const bridge = new HostBridge({ webviews: new Map(), context: {} } as any, mockDocument as any);

        await assert.rejects(
            bridge.updateCellBatch(
                'items',
                [{ rowId: 1, column: 'value', value: 'after' }],
                'Batch'
            ),
            error => {
                assert.strictEqual(error, writeError);
                return true;
            }
        );
        assert.strictEqual(mockDocument.recordExternalModification.mock.callCount(), 0);
    });

    it('rejects a column deletion when reload supersedes its history capture', async () => {
        const rows = createDeferred<any>();
        const rowsStarted = createDeferred<void>();
        const dbOps = {
            findDependentIndexes: mock.fn(async () => []),
            getTableInfo: mock.fn(async () => [{
                ordinal: 0,
                identifier: 'payload',
                declaredType: 'BLOB',
                isRequired: 0,
                defaultExpression: null,
                primaryKeyPosition: 0
            }]),
            executeQuery: mock.fn(async (sql: string) => {
                if (sql.includes('pragma_table_list')) {
                    return [{ headers: ['type', 'wr'], rows: [['table', 0]] }];
                }
                if (sql.includes('sqlite_schema')) {
                    return [{
                        headers: ['type', 'name', 'sql'],
                        rows: [['table', 'items', 'CREATE TABLE items (payload BLOB)']]
                    }];
                }
                rowsStarted.resolve();
                return rows.promise;
            }),
            deleteColumns: mock.fn(async () => {})
        };
        let connectionGeneration = 8;
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            get connectionGeneration() { return connectionGeneration; },
            recordExternalModification: mock.fn()
        };
        const bridge = new HostBridge({ webviews: new Map(), context: {} } as any, mockDocument as any);

        const pending = bridge.deleteColumns('items', ['payload']);
        await rowsStarted.promise;
        connectionGeneration++;
        rows.resolve([{ headers: ['rowid', 'payload'], rows: [[1, new Uint8Array([1])]] }]);

        await assert.rejects(pending, /document was reloaded/i);
        assert.strictEqual(dbOps.deleteColumns.mock.callCount(), 0);
        assert.strictEqual(mockDocument.recordExternalModification.mock.callCount(), 0);
    });

    it('canonicalizes rowids captured for column-drop history', async () => {
        const beforeColumns = [
            {
                ordinal: 0,
                identifier: 'id',
                declaredType: 'INTEGER',
                isRequired: 0,
                defaultExpression: null,
                primaryKeyPosition: 1
            },
            {
                ordinal: 1,
                identifier: 'payload',
                declaredType: '',
                isRequired: 0,
                defaultExpression: null,
                primaryKeyPosition: 0
            }
        ];
        let dropped = false;
        const dbOps = {
            findDependentIndexes: mock.fn(async () => []),
            getTableInfo: mock.fn(async () => dropped ? [beforeColumns[0]] : beforeColumns),
            executeQuery: mock.fn(async (sql: string) => {
                if (sql.includes('pragma_table_list')) {
                    return [{ headers: ['type', 'wr'], rows: [['table', 0]] }];
                }
                if (sql.includes('sqlite_schema')) {
                    return [{
                        headers: ['type', 'name', 'sql'],
                        rows: [[
                            'table',
                            'items',
                            dropped
                                ? 'CREATE TABLE items (id INTEGER PRIMARY KEY)'
                                : 'CREATE TABLE items (id INTEGER PRIMARY KEY, payload)'
                        ]]
                    }];
                }
                return [{
                    headers: ['rowid', 'payload'],
                    rows: [
                        ['7', 'safe'],
                        ['9007199254740993', 'unsafe']
                    ]
                }];
            }),
            deleteColumns: mock.fn(async () => {
                dropped = true;
                return {
                    tableSql: 'CREATE TABLE items (id INTEGER PRIMARY KEY)',
                    columns: ['id'],
                    identity: { kind: 'rowid' as const },
                    schemaObjects: []
                };
            })
        };
        const recordExternalModification = mock.fn();
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            connectionGeneration: 1,
            recordExternalModification
        };
        const bridge = new HostBridge(
            { webviews: new Map(), context: {}, isReadOnly: false } as any,
            mockDocument as any
        );

        await bridge.deleteColumns('items', ['payload']);

        const modification = recordExternalModification.mock.calls[0].arguments[0] as any;
        assert.strictEqual(modification.deletedColumns[0].type, '');
        assert.deepStrictEqual(modification.deletedColumns[0].data, [
            { rowId: 7, value: 'safe' },
            { rowId: '9007199254740993', value: 'unsafe' }
        ]);
    });

    it('records exact pre-drop and post-drop table state for positional undo', async () => {
        const beforeSql =
            'CREATE TABLE items (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, tail TEXT)';
        const afterSql =
            'CREATE TABLE items (id INTEGER PRIMARY KEY, tail TEXT)';
        let dropped = false;
        const beforeColumns = [
            {
                ordinal: 0,
                identifier: 'id',
                declaredType: 'INTEGER',
                isRequired: 0,
                defaultExpression: null,
                primaryKeyPosition: 1
            },
            {
                ordinal: 1,
                identifier: 'payload',
                declaredType: 'TEXT',
                isRequired: 1,
                defaultExpression: null,
                primaryKeyPosition: 0
            },
            {
                ordinal: 2,
                identifier: 'tail',
                declaredType: 'TEXT',
                isRequired: 0,
                defaultExpression: null,
                primaryKeyPosition: 0
            }
        ];
        const dbOps = {
            findDependentIndexes: mock.fn(async () => []),
            getTableInfo: mock.fn(async () => dropped
                ? [beforeColumns[0], { ...beforeColumns[2], ordinal: 1 }]
                : beforeColumns),
            executeQuery: mock.fn(async (sql: string) => {
                if (sql.includes('pragma_table_list')) {
                    return [{ headers: ['type', 'wr'], rows: [['table', 0]] }];
                }
                if (sql.includes('sqlite_schema')) {
                    return [{
                        headers: ['type', 'name', 'sql'],
                        rows: [['table', 'items', dropped ? afterSql : beforeSql]]
                    }];
                }
                return [{
                    headers: ['rowid', 'payload'],
                    rows: [[4, 'kept']]
                }];
            }),
            deleteColumns: mock.fn(async () => {
                dropped = true;
                return {
                    tableSql: afterSql,
                    columns: ['id', 'tail'],
                    identity: { kind: 'rowid' as const },
                    schemaObjects: []
                };
            })
        };
        const recordExternalModification = mock.fn();
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            databaseOperations: dbOps,
            isReadOnlyMode: false,
            connectionGeneration: 1,
            recordExternalModification
        };
        const bridge = new HostBridge(
            { webviews: new Map(), context: {}, isReadOnly: false } as any,
            mockDocument as any
        );

        await bridge.deleteColumns('items', ['payload']);

        const modification = recordExternalModification.mock.calls[0].arguments[0] as any;
        assert.deepStrictEqual(modification.columnDropSnapshot, {
            before: {
                tableSql: beforeSql,
                columns: ['id', 'payload', 'tail'],
                identity: { kind: 'rowid' },
                schemaObjects: []
            },
            after: {
                tableSql: afterSql,
                columns: ['id', 'tail'],
                identity: { kind: 'rowid' },
                schemaObjects: []
            }
        });
    });

    it('uses the engine-owned post-drop snapshot without metadata reads after commit', async () => {
        const beforeColumns = [
            {
                ordinal: 0,
                identifier: 'id',
                declaredType: 'INTEGER',
                isRequired: 0,
                defaultExpression: null,
                primaryKeyPosition: 1
            },
            {
                ordinal: 1,
                identifier: 'payload',
                declaredType: 'TEXT',
                isRequired: 0,
                defaultExpression: null,
                primaryKeyPosition: 0
            }
        ];
        const afterState = {
            tableSql: 'CREATE TABLE items (id INTEGER PRIMARY KEY)',
            columns: ['id'],
            identity: { kind: 'rowid' as const },
            schemaObjects: []
        };
        let dropped = false;
        const dbOps = {
            findDependentIndexes: mock.fn(async () => []),
            getTableInfo: mock.fn(async () => {
                if (dropped) throw new Error('post-commit metadata read');
                return beforeColumns;
            }),
            executeQuery: mock.fn(async (sql: string) => {
                if (sql.includes('pragma_table_list')) {
                    return [{ headers: ['type', 'wr'], rows: [['table', 0]] }];
                }
                if (sql.includes('sqlite_schema')) {
                    return [{
                        headers: ['type', 'name', 'sql'],
                        rows: [[
                            'table',
                            'items',
                            'CREATE TABLE items (id INTEGER PRIMARY KEY, payload TEXT)'
                        ]]
                    }];
                }
                return [{ headers: ['rowid', 'payload'], rows: [[1, 'kept']] }];
            }),
            deleteColumns: mock.fn(async () => {
                dropped = true;
                return afterState;
            })
        };
        const recordExternalModification = mock.fn();
        const bridge = new HostBridge(
            { webviews: new Map(), context: {}, isReadOnly: false } as any,
            {
                uri: vscode.Uri.parse('file:///test.db'),
                documentKey: Promise.resolve('test-key'),
                databaseOperations: dbOps,
                isReadOnlyMode: false,
                connectionGeneration: 1,
                recordExternalModification
            } as any
        );

        await bridge.deleteColumns('items', ['payload']);

        assert.strictEqual(dbOps.getTableInfo.mock.callCount(), 1);
        assert.strictEqual(recordExternalModification.mock.callCount(), 1);
        assert.deepStrictEqual(
            recordExternalModification.mock.calls[0].arguments[0].columnDropSnapshot.after,
            afterState
        );
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

    it('propagates a column-history capture failure without dropping the column', async () => {
        const error = new Error('Database disconnected during column info fetch');
        const dbOps = {
            getTableInfo: mock.fn(async () => { throw error; }),
            deleteColumns: mock.fn(async () => {})
        };
        const recordExternalModification = mock.fn();
        const mockDocument = {
            uri: vscode.Uri.parse('file:///test.db'),
            documentKey: Promise.resolve('test-key'),
            recordExternalModification,
        };
        const mockProvider = { webviews: new Map(), context: {} };
        const bridge = new HostBridge(mockProvider as any, mockDocument as any);
        (bridge as any).ensureDatabaseInitialized = () => dbOps as any;

        await assert.rejects(bridge.deleteColumns('table1', ['col1']), error);

        assert.strictEqual(dbOps.deleteColumns.mock.callCount(), 0);
        assert.strictEqual(recordExternalModification.mock.callCount(), 0);
    });
});
