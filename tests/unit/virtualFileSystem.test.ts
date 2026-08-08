
import './vscode_mock_setup'; // Must be first
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import { SQLiteFileSystemProvider } from '../../src/virtualFileSystem';
import { DocumentRegistry } from '../../src/documentRegistry';
import type { DatabaseDocument } from '../../src/databaseModel';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import * as vscode from 'vscode';

describe('SQLiteFileSystemProvider', () => {

    function setupMockDocument(key: string, dbOps: any = {}) {
        const disposeEmitter = new vscode.EventEmitter<void>();
        const contentEmitter = new vscode.EventEmitter<any>();
        let disposeSubscriptionDisposeCount = 0;
        const onDidDispose = (listener: () => void) => {
            const subscription = disposeEmitter.event(listener);
            return {
                dispose() {
                    disposeSubscriptionDisposeCount++;
                    subscription.dispose();
                }
            };
        };
        let connectionGeneration = 0;
        const mockDocument: any = {
            databaseOperations: dbOps,
            get connectionGeneration() { return connectionGeneration; },
            bumpConnectionGeneration: () => { connectionGeneration++; },
            recordExternalModification: mock.fn((modification: any) => {
                contentEmitter.fire({ modification });
            }),
            onDidChangeContent: contentEmitter.event,
            onDidDispose,
            dispose: () => disposeEmitter.fire(),
            fireContentChange: (modification: any, modificationDirection = 'forward') =>
                contentEmitter.fire({ modification, modificationDirection }),
            invalidateAllViewDocuments: () => contentEmitter.fire({
                invalidateAllViewDocuments: true
            }),
            getDisposeSubscriptionDisposeCount: () => disposeSubscriptionDisposeCount
        };
        DocumentRegistry.set(key, mockDocument);
        return mockDocument as DatabaseDocument & {
            fireContentChange(modification: any, modificationDirection?: 'forward' | 'undo'): void;
            invalidateAllViewDocuments(): void;
            getDisposeSubscriptionDisposeCount(): number;
            bumpConnectionGeneration(): void;
        };
    }

    afterEach(() => {
        DocumentRegistry.clear();
        mock.reset();
    });

    it('initialization', () => {
        const provider = new SQLiteFileSystemProvider();
        assert.ok(provider.onDidChangeFile);
    });

    describe('readFile', () => {
        const provider = new SQLiteFileSystemProvider();
        const docKey = 'test-doc';

        it('should throw FileNotFound if document not found', async () => {
            const uri = vscode.Uri.parse(`vscode-sqlite://missing-doc/table/group/1/col.txt`);
            await assert.rejects(async () => {
                await provider.readFile(uri);
            }, /FileNotFound/);
        });

        it('should throw FileNotFound if URI path is too short', async () => {
             // Path format: /<document_key>/<table>/<name>/<rowid>/<filename>
             // Short path
             const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/table`);
             setupMockDocument(docKey);
             await assert.rejects(async () => {
                 await provider.readFile(uri);
             }, /FileNotFound/);
        });

        it('should read __create__.sql correctly', async () => {
            const createSql = 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)';
            const dbOps = {
                executeQuery: mock.fn(async (sql: string, params: any[]) => {
                    if (sql.includes('sqlite_schema') && params[0] === 'users') {
                        return [{ rows: [[createSql]] }];
                    }
                    return [];
                })
            };
            setupMockDocument(docKey, dbOps);

            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/__create__.sql/create.sql`);
            const content = await provider.readFile(uri);
            const text = new TextDecoder().decode(content);

            assert.strictEqual(text, createSql);
            assert.strictEqual(dbOps.executeQuery.mock.callCount(), 1);
        });

        it('should return empty for __create__.sql if not found', async () => {
            const dbOps = {
                executeQuery: mock.fn(async () => [])
            };
            setupMockDocument(docKey, dbOps);

            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/__create__.sql/create.sql`);
            const content = await provider.readFile(uri);

            assert.strictEqual(content.byteLength, 0);
        });

        it('reads the SELECT body for a writable view definition document', async () => {
            const dbOps = {
                getViewDefinition: mock.fn(async () => ({
                    identifier: 'active users',
                    sql: 'CREATE VIEW "active users" AS SELECT id, name FROM users',
                    selectSql: 'SELECT id, name FROM users',
                    triggers: []
                }))
            };
            setupMockDocument(docKey, dbOps);
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/active%20users/group/__view__.sql/definition.sql`
            );

            const content = await provider.readFile(uri);
            const stat = await provider.stat(uri);

            assert.strictEqual(new TextDecoder().decode(content), 'SELECT id, name FROM users');
            assert.strictEqual(stat.size, content.byteLength);
            assert.strictEqual(dbOps.getViewDefinition.mock.callCount(), 1);
        });

        it('does not misreport a view-definition timeout as FileNotFound', async () => {
            const { InvocationTimeoutError } = await import('../../src/core/rpc');
            const dbOps = {
                getViewDefinition: mock.fn(async () => {
                    throw new InvocationTimeoutError('getViewDefinition');
                })
            };
            setupMockDocument(docKey, dbOps);
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/slow_view/group/__view__.sql/definition.sql`
            );

            await assert.rejects(
                () => provider.readFile(uri),
                (error: any) => {
                    assert.match(error.message, /Invocation timeout: getViewDefinition/);
                    assert.doesNotMatch(error.message, /FileNotFound/);
                    return true;
                }
            );
        });

        it('preserves an intentional virtual FileNotFound error', async () => {
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/gone_view/group/__view__.sql/definition.sql`
            );
            const missing = vscode.FileSystemError.FileNotFound(uri);
            setupMockDocument(docKey, {
                getViewDefinition: mock.fn(async () => { throw missing; })
            });

            await assert.rejects(
                () => provider.readFile(uri),
                error => error === missing
            );
        });

        it('should read regular string cell', async () => {
            // The virtualFileSystem first checks if table exists, then queries the cell
            let queryCount = 0;
            const dbOps = {
                executeQuery: mock.fn(async (sql: string, params: any[]) => {
                    queryCount++;
                    if (sql.includes('sqlite_schema')) {
                        // Table existence check - return that table exists
                        return [{ rows: [['users']] }];
                    }
                    // Cell query
                    assert.match(sql, /SELECT "name", CASE WHEN typeof\("name"\)/);
                    assert.deepStrictEqual(params, [1]);
                    return [{ rows: [['Alice']] }];
                })
            };
            setupMockDocument(docKey, dbOps);

            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/name.txt`);
            const content = await provider.readFile(uri);
            const text = new TextDecoder().decode(content);

            assert.strictEqual(text, 'Alice');
        });

        it('reads SQLite-exact unsafe INTEGER text for an external cell editor', async () => {
            const dbOps = {
                executeQuery: mock.fn(async (sql: string, params: any[]) => {
                    if (sql.includes('sqlite_schema')) return [{ rows: [[1]] }];
                    assert.match(sql, /CAST\("counter" AS TEXT\)/);
                    assert.deepStrictEqual(params, ['9007199254740993']);
                    return [{ rows: [[9007199254740992, '9007199254740993']] }];
                })
            };
            setupMockDocument(docKey, dbOps);
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/counters/group/9007199254740993/counter.txt`
            );

            assert.strictEqual(
                new TextDecoder().decode(await provider.readFile(uri)),
                '9007199254740993'
            );
        });

        it('should handle null values as empty content', async () => {
            const dbOps = {
                executeQuery: mock.fn(async (sql: string) => {
                    if (sql.includes('sqlite_schema')) {
                        return [{ rows: [['users']] }];
                    }
                    return [{ rows: [[null]] }];
                })
            };
            setupMockDocument(docKey, dbOps);

            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/name.txt`);
            const content = await provider.readFile(uri);

            assert.strictEqual(content.byteLength, 0);
        });

        it('should return Uint8Array (BLOB) as is', async () => {
            const blob = new Uint8Array([1, 2, 3, 4]);
            const dbOps = {
                executeQuery: mock.fn(async (sql: string) => {
                    if (sql.includes('sqlite_schema')) {
                        return [{ rows: [['users']] }];
                    }
                    return [{ rows: [[blob]] }];
                })
            };
            setupMockDocument(docKey, dbOps);

            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/data.bin`);
            const content = await provider.readFile(uri);

            assert.deepStrictEqual(content, blob);
        });

        it('keeps a small cell byte-identical after the metadata containment check', async () => {
            const blob = Uint8Array.from([0, 255, 1, 254]);
            let queryCount = 0;
            const dbOps = {
                getCellMetadata: mock.fn(async () => ({
                    storageClass: 'blob',
                    byteLength: blob.byteLength
                })),
                executeQuery: mock.fn(async () => {
                    queryCount++;
                    return queryCount === 1
                        ? [{ rows: [[1]] }]
                        : [{ rows: [[blob, null]] }];
                })
            };
            setupMockDocument(docKey, dbOps);
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/users/group/1/payload.bin`
            );

            const content = await provider.readFile(uri);

            assert.deepStrictEqual(content, blob);
            assert.strictEqual(dbOps.getCellMetadata.mock.callCount(), 1);
        });

        it('refuses a direct oversized VFS read before fetching the raw value', async () => {
            const dbOps = {
                getCellMetadata: mock.fn(async () => ({
                    storageClass: 'text',
                    byteLength: 2 * 1024 * 1024
                })),
                executeQuery: mock.fn(async () => [{ rows: [[1]] }])
            };
            setupMockDocument(docKey, dbOps);
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/users/group/1/payload.txt`
            );

            await assert.rejects(
                provider.readFile(uri),
                /oversized.*temporary-file.*Export the cell instead/is
            );
            assert.strictEqual(dbOps.executeQuery.mock.callCount(), 1);
        });

        it('should return invalid row ID message for non-numeric row ID', async () => {
            const dbOps = {
                executeQuery: mock.fn(async (sql: string) => {
                    if (sql.includes('sqlite_schema')) {
                        return [{ rows: [['users']] }];
                    }
                    return [{ rows: [] }];
                })
            };
            setupMockDocument(docKey, dbOps);
            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/invalid-id/col.txt`);

            // The code returns a message instead of throwing for invalid row IDs
            const content = await provider.readFile(uri);
            const text = new TextDecoder().decode(content);

            assert.ok(text.includes('Invalid Row ID: invalid-id'));
        });

        it('should preserve database errors as unavailable reads', async () => {
            const dbOps = {
                executeQuery: mock.fn(async () => {
                    throw new Error('Database error');
                })
            };
            setupMockDocument(docKey, dbOps);

            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/col.txt`);

            await assert.rejects(async () => {
                await provider.readFile(uri);
            }, /Database error/);
        });
    });
    describe('writeFile', () => {
        const provider = new SQLiteFileSystemProvider();
        const docKey = 'test-doc';

        it('should throw NoPermissions if writing to __create__.sql', async () => {
            setupMockDocument(docKey, {});
            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/__create__.sql/create.sql`);
            await assert.rejects(async () => {
                await provider.writeFile(uri, new Uint8Array(), { create: false, overwrite: true });
            }, (err: any) => err.message.includes('Cannot edit CREATE statement directly'));
        });

        it('should throw Unavailable for invalid row ID', async () => {
            setupMockDocument(docKey, {});
            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/invalid-id/col.txt`);
            await assert.rejects(async () => {
                await provider.writeFile(uri, new Uint8Array(), { create: false, overwrite: true });
            }, (err: any) => err.message.includes('Invalid Row ID'));
        });

        it('should map string error to Unavailable', async () => {
            const dbOps = {
                getCellMetadata: mock.fn(async () => ({ storageClass: 'text', byteLength: 0 })),
                executeQuery: mock.fn(async () => [{
                    headers: ['type', 'bytes', 'value'],
                    rows: [['text', 0, '']]
                }]),
                updateCell: mock.fn(async () => {
                    throw 'Database write string error';
                })
            };
            setupMockDocument(docKey, dbOps);

            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/col.txt`);

            await assert.rejects(async () => {
                await provider.writeFile(uri, new Uint8Array(), { create: false, overwrite: true });
            }, (err: any) => err.message.includes('Database write string error'));
        });

        it('should map Error object to Unavailable', async () => {
            const dbOps = {
                getCellMetadata: mock.fn(async () => ({ storageClass: 'text', byteLength: 0 })),
                executeQuery: mock.fn(async () => [{
                    headers: ['type', 'bytes', 'value'],
                    rows: [['text', 0, '']]
                }]),
                updateCell: mock.fn(async () => {
                    throw new Error('Database write error');
                })
            };
            setupMockDocument(docKey, dbOps);

            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/col.txt`);

            await assert.rejects(async () => {
                await provider.writeFile(uri, new Uint8Array(), { create: false, overwrite: true });
            }, (err: any) => err.message.includes('Database write error'));
        });

        it('should reject read-only documents before updating a cell', async () => {
            const dbOps = {
                updateCell: mock.fn(async () => {})
            };
            setupMockDocument(docKey, dbOps);
            const document = DocumentRegistry.get(docKey) as any;
            Object.defineProperty(document, 'isReadOnlyMode', {
                value: true,
                configurable: true
            });

            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/col.txt`);
            const content = new TextEncoder().encode('blocked write');

            // Read-only database documents are immutable from the cell editor,
            // so writeFile must stop before decoding content or mutating SQLite.
            await assert.rejects(async () => {
                await provider.writeFile(uri, content, { create: false, overwrite: true });
            }, (err: any) => err.message.includes('Database is read-only'));
            assert.strictEqual(dbOps.updateCell.mock.callCount(), 0);
        });

        it('should write text content correctly', async () => {
            const dbOps = {
                getCellMetadata: mock.fn(async () => ({ storageClass: 'text', byteLength: 11 })),
                executeQuery: mock.fn(async () => [{
                    headers: ['type', 'bytes', 'value'],
                    rows: [['text', 11, 'Before Text']]
                }]),
                updateCell: mock.fn(async () => {})
            };
            const doc = setupMockDocument(docKey, dbOps);

            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/col.txt`);
            const content = new TextEncoder().encode('Hello World');
            await provider.writeFile(uri, content, { create: false, overwrite: true });

            assert.strictEqual(dbOps.updateCell.mock.callCount(), 1);
            assert.deepStrictEqual(dbOps.updateCell.mock.calls[0].arguments, [
                'users',
                1,
                'col',
                'Hello World',
                undefined,
                1024 * 1024
            ]);
            assert.strictEqual((doc.recordExternalModification as any).mock.callCount(), 1);
        });

        it('refuses an oversized new external-editor value before metadata or mutation', async () => {
            const dbOps = {
                getCellMetadata: mock.fn(async () => ({ storageClass: 'text', byteLength: 1 })),
                updateCell: mock.fn(async () => {}),
                replaceOversizedCell: mock.fn(async () => {})
            };
            const doc = setupMockDocument(docKey, dbOps);
            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/col.txt`);

            await assert.rejects(
                provider.writeFile(
                    uri,
                    new Uint8Array(1024 * 1024 + 1),
                    { create: false, overwrite: true }
                ),
                /New TEXT cell value is 1048577 bytes.*1048576-byte edit limit/i
            );
            assert.strictEqual(dbOps.getCellMetadata.mock.callCount(), 0);
            assert.strictEqual(dbOps.updateCell.mock.callCount(), 0);
            assert.strictEqual(dbOps.replaceOversizedCell.mock.callCount(), 0);
            assert.strictEqual((doc.recordExternalModification as any).mock.callCount(), 0);
        });

        it('confirms and barriers an oversized external-editor replacement without reading it', async () => {
            const dbOps = {
                getCellMetadata: mock.fn(async () => ({
                    storageClass: 'blob',
                    byteLength: 2 * 1024 * 1024
                })),
                executeQuery: mock.fn(async () => {
                    throw new Error('whole prior value must not be queried');
                }),
                updateCell: mock.fn(async () => {
                    throw new Error('ordinary update must not run');
                }),
                replaceOversizedCell: mock.fn(async () => 1)
            };
            const doc = setupMockDocument(docKey, dbOps);
            const warning = mock.method(
                vscode.window,
                'showWarningMessage',
                async (...args: any[]) => args[2]
            );
            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/assets/group/1/payload.bin`);
            const saved = new Uint8Array([0xff, 0xfe]);

            await provider.writeFile(uri, saved, { create: false, overwrite: true });

            assert.match(String(warning.mock.calls[0].arguments[0]), /"assets"\."payload"/);
            assert.match(String(warning.mock.calls[0].arguments[0]), /BLOB/);
            assert.match(
                String(warning.mock.calls[0].arguments[0]),
                /2(?:,|\.)097(?:,|\.)152 bytes/
            );
            assert.deepStrictEqual(dbOps.replaceOversizedCell.mock.calls[0].arguments, [
                'assets',
                1,
                'payload',
                saved,
                { storageClass: 'blob', byteLength: 2 * 1024 * 1024 },
                1024 * 1024
            ]);
            assert.strictEqual(dbOps.executeQuery.mock.callCount(), 0);
            assert.strictEqual(dbOps.updateCell.mock.callCount(), 0);
            assert.strictEqual((doc.recordExternalModification as any).mock.callCount(), 1);
            assert.strictEqual(
                (doc.recordExternalModification as any).mock.calls[0].arguments[0].undoPolicy,
                'barrier'
            );
            assert.strictEqual(
                'priorValue' in (doc.recordExternalModification as any).mock.calls[0].arguments[0],
                false
            );
        });

        it('leaves external-editor history untouched when oversized replacement fails', async () => {
            const dbOps = {
                getCellMetadata: mock.fn(async () => ({
                    storageClass: 'blob',
                    byteLength: 2 * 1024 * 1024
                })),
                replaceOversizedCell: mock.fn(async () => {
                    throw new Error('guarded update failed');
                })
            };
            const doc = setupMockDocument(docKey, dbOps);
            mock.method(
                vscode.window,
                'showWarningMessage',
                async (...args: any[]) => args[2]
            );
            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/assets/group/1/payload.bin`);

            await assert.rejects(
                provider.writeFile(
                    uri,
                    new Uint8Array([0xff]),
                    { create: false, overwrite: true }
                ),
                /guarded update failed/
            );
            assert.strictEqual((doc.recordExternalModification as any).mock.callCount(), 0);
        });

        it('keeps an unsafe INTEGER byte-identical across external-editor open and save', async () => {
            const engineResult = await createDatabaseEngine({
                content: null,
                maxSize: 0,
                readOnlyMode: false
            });
            const engine = engineResult.operations!;
            await engine.executeQuery(
                'CREATE TABLE exact_counter (counter INTEGER); ' +
                'INSERT INTO exact_counter(rowid, counter) ' +
                'VALUES (9007199254740993, 9007199254740993)'
            );
            setupMockDocument(docKey, engine);
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/exact_counter/group/9007199254740993/counter.txt`
            );

            try {
                const opened = await provider.readFile(uri);
                assert.strictEqual(new TextDecoder().decode(opened), '9007199254740993');
                await provider.writeFile(uri, opened, { create: false, overwrite: true });
                const stored = await engine.executeQuery(
                    'SELECT typeof(counter), CAST(counter AS TEXT) FROM exact_counter ' +
                    'WHERE rowid = 9007199254740993'
                );
                assert.deepStrictEqual(stored[0].rows, [['integer', '9007199254740993']]);
            } finally {
                (engine as WasmDatabaseEngine).shutdown();
            }
        });

        it('records a rowid cell prior so an external-editor write can be undone', async () => {
            const engineResult = await createDatabaseEngine({
                content: null,
                maxSize: 0,
                readOnlyMode: false
            });
            const engine = engineResult.operations!;
            await engine.executeQuery(
                'CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL); ' +
                "INSERT INTO items VALUES (1, 'original')"
            );
            const document = setupMockDocument(docKey, engine);
            const uri = vscode.Uri.from({
                scheme: 'vscode-sqlite',
                path: `/${docKey}/items/-/1/value.txt`
            });

            try {
                await provider.writeFile(
                    uri,
                    new TextEncoder().encode('replacement'),
                    { create: false, overwrite: true }
                );
                const modification = (document.recordExternalModification as any)
                    .mock.calls[0].arguments[0];
                assert.strictEqual(modification.priorValue, 'original');

                await engine.undoModification(modification);
                assert.deepStrictEqual(
                    (await engine.executeQuery('SELECT value FROM items WHERE id = 1'))[0].rows,
                    [['original']]
                );
            } finally {
                (engine as WasmDatabaseEngine).shutdown();
            }
        });

        it('round-trips a BLOB composite primary-key identity through a cell URI', async () => {
            const engineResult = await createDatabaseEngine({
                content: null,
                maxSize: 0,
                readOnlyMode: false
            });
            const engine = engineResult.operations!;
            await engine.executeQuery(
                'CREATE TABLE uri_identity (' +
                'space BLOB, key TEXT, value TEXT, PRIMARY KEY (space, key)' +
                ') WITHOUT ROWID'
            );
            const identity = await engine.insertRow('uri_identity', {
                space: new Uint8Array([0, 47, 255]),
                key: 'item/one',
                value: 'before'
            });
            const document = setupMockDocument(docKey, engine);
            const uri = vscode.Uri.from({
                scheme: 'vscode-sqlite',
                path: '/' + [docKey, 'uri_identity', 'group', String(identity), 'value.txt']
                    .map(part => encodeURIComponent(part))
                    .join('/')
            });

            try {
                assert.strictEqual(
                    new TextDecoder().decode(await provider.readFile(uri)),
                    'before'
                );
                await provider.writeFile(
                    uri,
                    new TextEncoder().encode('after'),
                    { create: false, overwrite: true }
                );
                assert.deepStrictEqual(
                    (await engine.executeQuery(
                        'SELECT hex(space), key, value FROM uri_identity'
                    ))[0].rows,
                    [['002FFF', 'item/one', 'after']]
                );
                const modification = (document.recordExternalModification as any)
                    .mock.calls[0].arguments[0];
                assert.strictEqual(modification.targetRowId, identity);
                assert.strictEqual(modification.newTargetRowId, identity);
                assert.strictEqual(modification.priorValue, 'before');
                await engine.undoModification(modification);
                assert.strictEqual(
                    (await engine.executeQuery('SELECT value FROM uri_identity'))[0].rows[0][0],
                    'before'
                );
                await engine.redoModification(modification);
                assert.strictEqual(
                    (await engine.executeQuery('SELECT value FROM uri_identity'))[0].rows[0][0],
                    'after'
                );
            } finally {
                (engine as WasmDatabaseEngine).shutdown();
            }
        });

        it('keeps unsafe INTEGER primary-key history exact when the external editor changes identity', async () => {
            const engineResult = await createDatabaseEngine({
                content: null,
                maxSize: 0,
                readOnlyMode: false
            });
            const engine = engineResult.operations!;
            await engine.executeQuery(
                'CREATE TABLE uri_int64_identity (' +
                'id INTEGER PRIMARY KEY, value TEXT' +
                ') WITHOUT ROWID'
            );
            const identity = await engine.insertRow('uri_int64_identity', {
                id: '9007199254740993',
                value: 'payload'
            });
            const document = setupMockDocument(docKey, engine);
            const uri = vscode.Uri.from({
                scheme: 'vscode-sqlite',
                path: '/' + [docKey, 'uri_int64_identity', 'group', String(identity), 'id.txt']
                    .map(part => encodeURIComponent(part))
                    .join('/')
            });

            try {
                await provider.writeFile(
                    uri,
                    new TextEncoder().encode('9007199254740994'),
                    { create: false, overwrite: true }
                );
                const modification = (document.recordExternalModification as any)
                    .mock.calls[0].arguments[0];
                assert.strictEqual(modification.priorValue, '9007199254740993');
                assert.notStrictEqual(modification.newTargetRowId, identity);
                assert.deepStrictEqual(
                    (await engine.executeQuery(
                        'SELECT CAST(id AS TEXT), value FROM uri_int64_identity'
                    ))[0].rows,
                    [['9007199254740994', 'payload']]
                );

                await engine.undoModification(modification);
                assert.strictEqual(
                    (await engine.executeQuery(
                        'SELECT CAST(id AS TEXT) FROM uri_int64_identity'
                    ))[0].rows[0][0],
                    '9007199254740993'
                );
                await engine.redoModification(modification);
                assert.strictEqual(
                    (await engine.executeQuery(
                        'SELECT CAST(id AS TEXT) FROM uri_int64_identity'
                    ))[0].rows[0][0],
                    '9007199254740994'
                );
            } finally {
                (engine as WasmDatabaseEngine).shutdown();
            }
        });

        it('retargets an open external editor after each primary-key member save', async () => {
            const engineResult = await createDatabaseEngine({
                content: null,
                maxSize: 0,
                readOnlyMode: false
            });
            const engine = engineResult.operations!;
            await engine.executeQuery(
                'CREATE TABLE retargeted_editor (' +
                'id INTEGER PRIMARY KEY, value TEXT' +
                ') WITHOUT ROWID; ' +
                "INSERT INTO retargeted_editor VALUES (1, 'payload')"
            );
            const page = await engine.fetchTableData('retargeted_editor', {
                columns: ['rowid', 'id', 'value'],
                limit: 10,
                offset: 0
            });
            const originalIdentity = page.rows[0][0];
            const document = setupMockDocument(docKey, engine);
            const uri = vscode.Uri.from({
                scheme: 'vscode-sqlite',
                path: '/' + [docKey, 'retargeted_editor', 'group', String(originalIdentity), 'id.txt']
                    .map(part => encodeURIComponent(part))
                    .join('/')
            });
            const changedUris: string[] = [];
            const subscription = provider.onDidChangeFile(changes => {
                changedUris.push(...changes.map(change => change.uri.toString()));
            });

            try {
                await provider.writeFile(
                    uri,
                    new TextEncoder().encode('2'),
                    { create: false, overwrite: true }
                );
                await provider.writeFile(
                    uri,
                    new TextEncoder().encode('3'),
                    { create: false, overwrite: true }
                );

                assert.strictEqual(
                    new TextDecoder().decode(await provider.readFile(uri)),
                    '3'
                );
                assert.deepStrictEqual(
                    (await engine.executeQuery(
                        'SELECT CAST(id AS TEXT), value FROM retargeted_editor'
                    ))[0].rows,
                    [['3', 'payload']]
                );
                const modifications = (document.recordExternalModification as any).mock.calls
                    .map((call: any) => call.arguments[0]);
                assert.strictEqual(modifications.length, 2);
                assert.strictEqual(modifications[1].targetRowId, modifications[0].newTargetRowId);
                assert.strictEqual(changedUris.length, 2);
                assert.ok(changedUris.every(changedUri => changedUri === uri.toString()));
            } finally {
                subscription.dispose();
                (engine as WasmDatabaseEngine).shutdown();
            }
        });

        it('should write binary content if not valid UTF-8', async () => {
            const priorContent = new Uint8Array([1, 2, 3]);
            const dbOps = {
                getCellMetadata: mock.fn(async () => ({ storageClass: 'blob', byteLength: 3 })),
                executeQuery: mock.fn(async () => [{
                    headers: ['type', 'bytes', 'value'],
                    rows: [['blob', 3, priorContent]]
                }]),
                updateCell: mock.fn(async () => {})
            };
            const doc = setupMockDocument(docKey, dbOps);

            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/col.txt`);
            const content = new Uint8Array([0xff, 0xff, 0xff]); // Invalid UTF-8
            await provider.writeFile(uri, content, { create: false, overwrite: true });

            assert.strictEqual(dbOps.updateCell.mock.callCount(), 1);
            assert.deepStrictEqual(dbOps.updateCell.mock.calls[0].arguments, [
                'users',
                1,
                'col',
                content,
                undefined,
                1024 * 1024
            ]);
            assert.strictEqual((doc.recordExternalModification as any).mock.callCount(), 1);
        });

        it('atomically saves a view definition and records its undo state', async () => {
            const before = {
                identifier: 'active users',
                sql: 'CREATE VIEW "active users" AS SELECT id, name FROM users',
                selectSql: 'SELECT id, name FROM users',
                triggers: []
            };
            const after = {
                ...before,
                sql: 'CREATE VIEW "active users" AS SELECT id, upper(name) AS name FROM users',
                selectSql: 'SELECT id, upper(name) AS name FROM users'
            };
            const dbOps = {
                getViewDefinition: mock.fn(async () => before),
                editView: mock.fn(async () => ({ before, after }))
            };
            const doc = setupMockDocument(docKey, dbOps);
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/active%20users/group/__view__.sql/definition.sql`
            );
            const content = new TextEncoder().encode(after.selectSql);

            await provider.writeFile(uri, content, { create: false, overwrite: true });

            assert.deepStrictEqual(dbOps.editView.mock.calls[0].arguments, [
                'active users',
                after.selectSql,
                true,
                undefined,
                undefined
            ]);
            assert.deepStrictEqual((doc.recordExternalModification as any).mock.calls[0].arguments[0], {
                label: 'Edit View',
                description: 'Edit view active users from editor',
                modificationType: 'view_edit',
                targetTable: 'active users',
                viewDefBefore: before,
                viewDefAfter: after
            });
        });

        it('does not adopt or record a view save completed on a reloaded connection', async () => {
            const before = {
                identifier: 'generation_view',
                sql: 'CREATE VIEW generation_view AS SELECT 1 AS value',
                selectSql: 'SELECT 1 AS value',
                triggers: []
            };
            const after = {
                ...before,
                sql: 'CREATE VIEW generation_view AS SELECT 2 AS value',
                selectSql: 'SELECT 2 AS value'
            };
            let document: ReturnType<typeof setupMockDocument>;
            const dbOps = {
                editView: mock.fn(async () => {
                    document.bumpConnectionGeneration();
                    return { before, after };
                })
            };
            document = setupMockDocument(docKey, dbOps);
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/generation_view/group/__view__.sql/definition.sql`
            );

            await assert.rejects(
                provider.writeFile(
                    uri,
                    new TextEncoder().encode(after.selectSql),
                    { create: false, overwrite: true }
                ),
                /reloaded while the view definition was being saved/i
            );
            assert.strictEqual(
                (document.recordExternalModification as any).mock.callCount(),
                0
            );
        });

        it('keeps view document metadata coherent across the VS Code save protocol', async () => {
            const engineResult = await createDatabaseEngine({
                content: null,
                maxSize: 0,
                readOnlyMode: false
            });
            const engine = engineResult.operations!;
            await engine.executeQuery('CREATE TABLE inventory (quantity INTEGER)');
            await engine.createView('inventory_rollup', 'SELECT MAX(quantity) AS total FROM inventory');
            setupMockDocument(docKey, engine);
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/inventory_rollup/group/__view__.sql/definition.sql`
            );
            const changedEvents: vscode.FileChangeEvent[][] = [];
            const subscription = provider.onDidChangeFile(events => changedEvents.push(events));

            try {
                // VS Code stats before saving, then stats and re-reads after the
                // Changed event. Metadata must describe the content it will read,
                // and timestamps must stay stable until an actual write occurs.
                const before = await provider.stat(uri);
                const beforeAgain = await provider.stat(uri);
                assert.strictEqual(before.size, 'SELECT MAX(quantity) AS total FROM inventory'.length);
                assert.strictEqual(beforeAgain.mtime, before.mtime);

                const saved = new TextEncoder().encode(
                    'SELECT SUM(quantity) AS total FROM inventory;\n'
                );
                await provider.writeFile(uri, saved, { create: false, overwrite: true });

                assert.strictEqual(changedEvents.length, 1);
                assert.strictEqual(changedEvents[0][0].type, vscode.FileChangeType.Changed);
                const after = await provider.stat(uri);
                const reread = await provider.readFile(uri);
                const afterAgain = await provider.stat(uri);
                const rereadText = new TextDecoder().decode(reread);

                assert.strictEqual(rereadText, 'SELECT SUM(quantity) AS total FROM inventory');
                assert.notStrictEqual(rereadText, '');
                assert.strictEqual(after.size, reread.byteLength);
                assert.ok(after.mtime > before.mtime);
                assert.strictEqual(afterAgain.mtime, after.mtime);
                assert.strictEqual(afterAgain.size, after.size);
            } finally {
                subscription.dispose();
                (engine as WasmDatabaseEngine).shutdown();
            }
        });

        it('invalidates every open URI for a view changed outside the virtual editor', async () => {
            let now = 100;
            mock.method(Date, 'now', () => now);
            let definition = {
                identifier: 'shared_view',
                sql: 'CREATE VIEW "shared_view" AS SELECT 1 AS value',
                selectSql: 'SELECT 1 AS value',
                triggers: []
            };
            const document = setupMockDocument(docKey, {
                getViewDefinition: mock.fn(async () => definition)
            });
            const firstUri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/shared_view/group/__view__.sql/definition.sql?webview-id=one`
            );
            const secondUri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/shared_view/group/__view__.sql/definition.sql?webview-id=two`
            );
            const events: vscode.FileChangeEvent[][] = [];
            const subscription = provider.onDidChangeFile(changes => events.push(changes));

            try {
                const firstBefore = await provider.stat(firstUri);
                const secondBefore = await provider.stat(secondUri);
                now = 200;
                definition = {
                    ...definition,
                    sql: 'CREATE VIEW "shared_view" AS SELECT 2 AS value',
                    selectSql: 'SELECT 2 AS value'
                };
                document.fireContentChange({
                    label: 'Edit View',
                    description: 'Edit shared view',
                    modificationType: 'view_edit',
                    targetTable: 'shared_view'
                });

                assert.strictEqual(events.length, 1);
                assert.deepStrictEqual(
                    events[0].map(change => change.uri.toString()).sort(),
                    [firstUri.toString(), secondUri.toString()].sort()
                );
                assert.ok((await provider.stat(firstUri)).mtime > firstBefore.mtime);
                assert.ok((await provider.stat(secondUri)).mtime > secondBefore.mtime);
            } finally {
                subscription.dispose();
            }
        });

        it('emits view lifecycle file events for forward, undo, and redo semantics', async () => {
            const definition = {
                identifier: 'lifecycle_view',
                sql: 'CREATE VIEW lifecycle_view AS SELECT 1 AS value',
                selectSql: 'SELECT 1 AS value',
                triggers: []
            };
            const document = setupMockDocument(docKey, {
                getViewDefinition: mock.fn(async () => definition)
            });
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/lifecycle_view/group/__view__.sql/definition.sql`
            );
            const events: vscode.FileChangeEvent[][] = [];
            const subscription = provider.onDidChangeFile(changes => events.push(changes));
            const modification = (modificationType: 'view_create' | 'view_edit' | 'view_drop') => ({
                label: modificationType,
                description: modificationType,
                modificationType,
                targetTable: 'lifecycle_view'
            });

            try {
                await provider.stat(uri);
                document.fireContentChange(modification('view_create'));
                document.fireContentChange(modification('view_edit'));
                document.fireContentChange(modification('view_drop'));
                document.fireContentChange(modification('view_create'), 'undo');
                document.fireContentChange(modification('view_edit'), 'undo');
                document.fireContentChange(modification('view_drop'), 'undo');

                assert.deepStrictEqual(
                    events.map(changes => changes[0].type),
                    [
                        vscode.FileChangeType.Created,
                        vscode.FileChangeType.Changed,
                        vscode.FileChangeType.Deleted,
                        vscode.FileChangeType.Deleted,
                        vscode.FileChangeType.Changed,
                        vscode.FileChangeType.Created
                    ]
                );
            } finally {
                subscription.dispose();
            }
        });

        it('serves the direction-appropriate view definition after undo and redo', async () => {
            const before = {
                identifier: 'history_view',
                sql: 'CREATE VIEW history_view AS SELECT 1 AS value',
                selectSql: 'SELECT 1 AS value',
                triggers: []
            };
            const after = {
                identifier: 'history_view',
                sql: 'CREATE VIEW history_view AS SELECT 222 AS updated_value',
                selectSql: 'SELECT 222 AS updated_value',
                triggers: []
            };
            const getViewDefinition = mock.fn(async () => after);
            const document = setupMockDocument(docKey, { getViewDefinition });
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/history_view/group/__view__.sql/definition.sql`
            );
            const modification = {
                label: 'Edit View',
                description: 'Edit history view',
                modificationType: 'view_edit' as const,
                targetTable: 'history_view',
                viewDefBefore: before,
                viewDefAfter: after
            };

            assert.strictEqual(
                new TextDecoder().decode(await provider.readFile(uri)),
                after.selectSql
            );

            document.fireContentChange(modification, 'undo');
            assert.strictEqual((await provider.stat(uri)).size, before.selectSql.length);
            assert.strictEqual(
                new TextDecoder().decode(await provider.readFile(uri)),
                before.selectSql
            );

            document.fireContentChange(modification, 'forward');
            assert.strictEqual(
                new TextDecoder().decode(await provider.readFile(uri)),
                after.selectSql
            );
            assert.strictEqual(
                getViewDefinition.mock.callCount(),
                1,
                'history payloads should not be replaced by a stale engine/cache reread'
            );
        });

        it('invalidates every open view document when File Revert replaces the database state', async () => {
            let now = 100;
            mock.method(Date, 'now', () => now);
            const definitions: Record<string, { selectSql: string }> = {
                first_view: { selectSql: 'SELECT 1' },
                second_view: { selectSql: 'SELECT 2' }
            };
            const document = setupMockDocument(docKey, {
                getViewDefinition: async (view: string) => definitions[view],
                fetchSchema: async () => ({
                    tables: [],
                    views: [
                        { identifier: 'first_view' },
                        { identifier: 'second_view' }
                    ],
                    indexes: []
                })
            });
            const firstUri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/first_view/group/__view__.sql/definition.sql`
            );
            const secondUri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/second_view/group/__view__.sql/definition.sql`
            );
            const events: vscode.FileChangeEvent[][] = [];
            let resolveEvent!: () => void;
            const eventReceived = new Promise<void>(resolve => { resolveEvent = resolve; });
            const subscription = provider.onDidChangeFile(changes => {
                events.push(changes);
                resolveEvent();
            });

            try {
                const firstBefore = await provider.stat(firstUri);
                const secondBefore = await provider.stat(secondUri);
                now = 200;

                document.invalidateAllViewDocuments();
                await eventReceived;

                assert.strictEqual(events.length, 1);
                assert.deepStrictEqual(
                    events[0].map(change => change.uri.toString()).sort(),
                    [firstUri.toString(), secondUri.toString()].sort()
                );
                assert.ok((await provider.stat(firstUri)).mtime > firstBefore.mtime);
                assert.ok((await provider.stat(secondUri)).mtime > secondBefore.mtime);
            } finally {
                subscription.dispose();
            }
        });

        it('marks removed view documents Deleted while changing surviving views on reload', async () => {
            let now = 100;
            mock.method(Date, 'now', () => now);
            const definitions = new Map([
                ['surviving_view', {
                    identifier: 'surviving_view',
                    sql: 'CREATE VIEW surviving_view AS SELECT 1',
                    selectSql: 'SELECT 1',
                    triggers: []
                }],
                ['removed_view', {
                    identifier: 'removed_view',
                    sql: 'CREATE VIEW removed_view AS SELECT 2',
                    selectSql: 'SELECT 2',
                    triggers: []
                }]
            ]);
            const document = setupMockDocument(docKey, {
                getViewDefinition: async (view: string) => {
                    const definition = definitions.get(view);
                    if (!definition) throw new Error(`View not found: ${view}`);
                    return definition;
                },
                fetchSchema: async () => ({
                    tables: [],
                    views: [{ identifier: 'surviving_view' }],
                    indexes: []
                })
            });
            const survivingUri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/surviving_view/group/__view__.sql/definition.sql`
            );
            const removedUri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/removed_view/group/__view__.sql/definition.sql`
            );
            await provider.stat(survivingUri);
            await provider.stat(removedUri);
            let resolveEvent!: (changes: vscode.FileChangeEvent[]) => void;
            const eventReceived = new Promise<vscode.FileChangeEvent[]>(resolve => {
                resolveEvent = resolve;
            });
            const subscription = provider.onDidChangeFile(resolveEvent);

            try {
                definitions.delete('removed_view');
                now = 200;
                document.invalidateAllViewDocuments();
                const changes = await eventReceived;
                const changesByUri = new Map(changes.map(change => [change.uri.toString(), change.type]));

                assert.strictEqual(
                    changesByUri.get(survivingUri.toString()),
                    vscode.FileChangeType.Changed
                );
                assert.strictEqual(
                    changesByUri.get(removedUri.toString()),
                    vscode.FileChangeType.Deleted
                );
                await assert.rejects(provider.stat(removedUri), /FileNotFound/);
            } finally {
                subscription.dispose();
            }
        });

        it('rejects a stale view editor save instead of overwriting an external edit', async () => {
            const original = {
                identifier: 'conflicted_view',
                sql: 'CREATE VIEW "conflicted_view" AS SELECT 1 AS value',
                selectSql: 'SELECT 1 AS value',
                triggers: []
            };
            let definition = original;
            const editView = mock.fn(async () => {
                throw new Error('stale editor must not reach editView');
            });
            const document = setupMockDocument(docKey, {
                getViewDefinition: mock.fn(async () => definition),
                editView
            });
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/conflicted_view/group/__view__.sql/definition.sql`
            );
            const events: vscode.FileChangeEvent[][] = [];
            const subscription = provider.onDidChangeFile(changes => events.push(changes));

            try {
                assert.strictEqual(
                    new TextDecoder().decode(await provider.readFile(uri)),
                    original.selectSql
                );
                definition = {
                    ...original,
                    sql: 'CREATE VIEW "conflicted_view" AS SELECT 2 AS value',
                    selectSql: 'SELECT 2 AS value'
                };
                document.fireContentChange({
                    label: 'Edit View',
                    description: 'Edit conflicted view in modal',
                    modificationType: 'view_edit',
                    targetTable: 'conflicted_view'
                });
                // VS Code stats a changed file before deciding whether a dirty
                // buffer can reload. stat() must not advance the read snapshot.
                await provider.stat(uri);

                await assert.rejects(
                    provider.writeFile(
                        uri,
                        new TextEncoder().encode('SELECT 3 AS value'),
                        { create: false, overwrite: true }
                    ),
                    /changed outside this editor.*not modified/i
                );
                assert.strictEqual(editView.mock.callCount(), 0);
                assert.strictEqual(
                    (document.recordExternalModification as any).mock.callCount(),
                    0
                );
                assert.ok(events.length >= 2, 'the mutation and conflict should both offer a reload');
                assert.strictEqual(events.at(-1)?.[0].uri.toString(), uri.toString());
            } finally {
                subscription.dispose();
            }
        });

        it('preserves the stale-write conflict when the document registry entry disappears mid-check', async () => {
            const original = {
                identifier: 'detached_view',
                sql: 'CREATE VIEW "detached_view" AS SELECT 1 AS value',
                selectSql: 'SELECT 1 AS value',
                triggers: []
            };
            const changed = {
                ...original,
                sql: 'CREATE VIEW "detached_view" AS SELECT 2 AS value',
                selectSql: 'SELECT 2 AS value'
            };
            let definitionReads = 0;
            const editView = mock.fn(async () => {
                throw new Error('stale editor must not reach editView');
            });
            setupMockDocument(docKey, {
                getViewDefinition: mock.fn(async () => {
                    definitionReads++;
                    if (definitionReads === 1) return original;
                    // writeFile already resolved the document and metadata. A
                    // later registry teardown must not mask the conflict it has
                    // now detected or suppress the reload event.
                    DocumentRegistry.delete(docKey);
                    return changed;
                }),
                editView
            });
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/detached_view/group/__view__.sql/definition.sql`
            );
            const events: vscode.FileChangeEvent[][] = [];
            const subscription = provider.onDidChangeFile(changes => events.push(changes));

            try {
                await provider.readFile(uri);
                await assert.rejects(
                    provider.writeFile(
                        uri,
                        new TextEncoder().encode('SELECT 3 AS value'),
                        { create: false, overwrite: true }
                    ),
                    /changed outside this editor.*not modified/i
                );
                assert.strictEqual(editView.mock.callCount(), 0);
                assert.strictEqual(events.at(-1)?.[0].type, vscode.FileChangeType.Changed);
                assert.strictEqual(events.at(-1)?.[0].uri.toString(), uri.toString());
            } finally {
                subscription.dispose();
            }
        });

        it('passes the read snapshot into the engine and maps a raced CAS conflict to reload', async () => {
            const original = {
                identifier: 'raced_view',
                sql: 'CREATE VIEW "raced_view" AS SELECT 1 AS value',
                selectSql: 'SELECT 1 AS value',
                triggers: []
            };
            const editView = mock.fn(async () => {
                throw new Error(
                    'This view changed outside this editor. Reload before saving; the view was not modified.'
                );
            });
            const document = setupMockDocument(docKey, {
                getViewDefinition: mock.fn(async () => original),
                editView
            });
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/raced_view/group/__view__.sql/definition.sql`
            );
            const events: vscode.FileChangeEvent[][] = [];
            const subscription = provider.onDidChangeFile(changes => events.push(changes));

            try {
                await provider.readFile(uri);
                await assert.rejects(
                    provider.writeFile(
                        uri,
                        new TextEncoder().encode('SELECT 3 AS value'),
                        { create: false, overwrite: true }
                    ),
                    /changed outside this editor.*not modified/i
                );

                assert.deepStrictEqual(editView.mock.calls[0].arguments, [
                    'raced_view',
                    'SELECT 3 AS value',
                    true,
                    original.sql,
                    original.triggers
                ]);
                assert.strictEqual(
                    (document.recordExternalModification as any).mock.callCount(),
                    0
                );
                assert.strictEqual(events.at(-1)?.[0].uri.toString(), uri.toString());
            } finally {
                subscription.dispose();
            }
        });

        it('rejects a view save when only the attached trigger snapshot changed', async () => {
            const original = {
                identifier: 'trigger_conflict_view',
                sql: 'CREATE VIEW trigger_conflict_view AS SELECT 1 AS value',
                selectSql: 'SELECT 1 AS value',
                triggers: [{
                    identifier: 'trigger_conflict_first',
                    sql: 'CREATE TRIGGER trigger_conflict_first INSTEAD OF INSERT ON trigger_conflict_view BEGIN SELECT 1; END'
                }]
            };
            let current = original;
            const editView = mock.fn(async () => {
                throw new Error('stale trigger snapshot must not reach editView');
            });
            setupMockDocument(docKey, {
                getViewDefinition: mock.fn(async () => current),
                editView
            });
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/trigger_conflict_view/group/__view__.sql/definition.sql`
            );

            await provider.readFile(uri);
            current = {
                ...original,
                triggers: [
                    ...original.triggers,
                    {
                        identifier: 'trigger_conflict_second',
                        sql: 'CREATE TRIGGER trigger_conflict_second INSTEAD OF UPDATE ON trigger_conflict_view BEGIN SELECT 2; END'
                    }
                ]
            };

            await assert.rejects(
                provider.writeFile(
                    uri,
                    new TextEncoder().encode('SELECT 2 AS value'),
                    { create: false, overwrite: true }
                ),
                /changed outside this editor.*not modified/i
            );
            assert.strictEqual(editView.mock.callCount(), 0);
        });

        it('keeps a rejected view edit dirty and reports the SQLite error clearly', async () => {
            const sqliteError = '[query] SQLite error 1: near "MAX": syntax error';
            const dbOps = {
                editView: mock.fn(async () => {
                    throw new Error(sqliteError);
                })
            };
            const doc = setupMockDocument(docKey, dbOps);
            const showErrorMessage = mock.method(vscode.window, 'showErrorMessage');
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/product_inventory/group/__view__.sql/definition.sql`
            );
            const content = new TextEncoder().encode(
                'SELECT quantity MAX(quantity) FROM inventory'
            );

            await assert.rejects(
                provider.writeFile(uri, content, { create: false, overwrite: true }),
                (error: Error) => {
                    assert.strictEqual(
                        error.message,
                        'Invalid view definition. The view was not modified.'
                    );
                    return true;
                }
            );

            assert.strictEqual(showErrorMessage.mock.callCount(), 1);
            assert.strictEqual(
                showErrorMessage.mock.calls[0].arguments[0],
                'Invalid view definition: near "MAX": syntax error. The view was not modified.'
            );
            assert.strictEqual((doc.recordExternalModification as any).mock.callCount(), 0);
        });

        it('rejects a failed view save without waiting for the error notification', async () => {
            const dbOps = {
                editView: mock.fn(async () => {
                    throw new Error('SQLite error 1: invalid body');
                })
            };
            setupMockDocument(docKey, dbOps);
            let resolveNotification!: (value: string | undefined) => void;
            const notification = new Promise<string | undefined>(resolve => {
                resolveNotification = resolve;
            });
            mock.method(vscode.window, 'showErrorMessage', () => notification);
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/slow-notification/group/__view__.sql/definition.sql`
            );
            const outcome = provider.writeFile(
                uri,
                new TextEncoder().encode('SELECT invalid body'),
                { create: false, overwrite: true }
            ).then(
                () => ({ resolved: true as const }),
                error => ({ resolved: false as const, error })
            );

            await new Promise<void>(resolve => setImmediate(resolve));
            let settled = false;
            void outcome.then(() => { settled = true; });
            await Promise.resolve();
            try {
                assert.strictEqual(settled, true, 'writeFile remained pending on showErrorMessage');
                const result = await outcome;
                assert.strictEqual(result.resolved, false);
                assert.match(String('error' in result ? result.error : ''), /Invalid view definition/);
            } finally {
                resolveNotification(undefined);
            }
        });

        it('maps invalid UTF-8 in a view document to the clean dirty-buffer error path', async () => {
            const dbOps = {
                editView: mock.fn(async () => {
                    throw new Error('editView must not be called for invalid UTF-8');
                })
            };
            const doc = setupMockDocument(docKey, dbOps);
            const showErrorMessage = mock.method(vscode.window, 'showErrorMessage');
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/product_inventory/group/__view__.sql/definition.sql`
            );

            await assert.rejects(
                provider.writeFile(uri, new Uint8Array([0xff, 0xfe]), {
                    create: false,
                    overwrite: true
                }),
                (error: Error) => {
                    assert.strictEqual(
                        error.message,
                        'Invalid view definition. The view was not modified.'
                    );
                    return true;
                }
            );

            assert.strictEqual(dbOps.editView.mock.callCount(), 0);
            assert.strictEqual((doc.recordExternalModification as any).mock.callCount(), 0);
            assert.strictEqual(showErrorMessage.mock.callCount(), 1);
            assert.match(String(showErrorMessage.mock.calls[0].arguments[0]), /The view was not modified\.$/);
        });
    });

    describe('delete / rename / stat / watch', () => {
        const provider = new SQLiteFileSystemProvider();
        const docKey = 'test-doc';

        it('presents virtual ancestors as idempotent directories for workspace.fs writes', async () => {
            setupMockDocument(docKey, {});
            const ancestors = [
                '/',
                `/${docKey}`,
                `/${docKey}/users`,
                `/${docKey}/users/group`,
                `/${docKey}/users/group/1`
            ].map(uriPath => vscode.Uri.from({ scheme: 'vscode-sqlite', path: uriPath }));

            for (const uri of ancestors) {
                const metadata = await provider.stat(uri);
                assert.strictEqual(metadata.type, vscode.FileType.Directory);
                await provider.createDirectory(uri);
            }

            const fileUri = vscode.Uri.from({
                scheme: 'vscode-sqlite',
                path: `/${docKey}/users/group/1/name.txt`
            });
            await assert.rejects(
                provider.createDirectory(fileUri),
                (err: any) => err.message.includes('NoPermissions')
            );
        });

        it('should return empty array for readDirectory', async () => {
            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group`);
            const res = await provider.readDirectory(uri);
            assert.deepStrictEqual(res, []);
        });

        it('stat should return generic file stat for normal cell', async () => {
            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/col.txt`);
            setupMockDocument(docKey, {});
            const s = await provider.stat(uri);
            assert.strictEqual(s.type, vscode.FileType.File);
            assert.strictEqual(s.size, 0);
            assert.strictEqual(s.permissions, undefined);
        });

        it('stat marks a normal cell document read-only with its database', async () => {
            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/col.txt`);
            const document = setupMockDocument(docKey, {});
            (document as any).isReadOnlyMode = true;

            const s = await provider.stat(uri);

            assert.strictEqual(s.permissions, vscode.FilePermission.Readonly);
        });

        it('stat should return generic file stat with Readonly for __create__.sql', async () => {
            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/__create__.sql/create.sql`);
            setupMockDocument(docKey, {});
            const s = await provider.stat(uri);
            assert.strictEqual(s.type, vscode.FileType.File);
            assert.strictEqual(s.size, 0);
            assert.strictEqual(s.permissions, vscode.FilePermission.Readonly);
        });

        it('stat keeps __view__.sql writable', async () => {
            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/__view__.sql/definition.sql`);
            const getViewDefinition = mock.fn(async () => ({ selectSql: 'SELECT 1' }));
            setupMockDocument(docKey, {
                getViewDefinition
            });

            const s = await provider.stat(uri);
            const again = await provider.stat(uri);

            assert.strictEqual(s.permissions, undefined);
            assert.strictEqual(s.size, 'SELECT 1'.length);
            assert.strictEqual(again.size, s.size);
            assert.strictEqual(getViewDefinition.mock.callCount(), 1);
        });

        it('stat reflects a view document becoming read-only after reload', async () => {
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/wal_view/group/__view__.sql/definition.sql`
            );
            const document = setupMockDocument(docKey, {
                getViewDefinition: async () => ({
                    identifier: 'wal_view',
                    sql: 'CREATE VIEW wal_view AS SELECT 1',
                    selectSql: 'SELECT 1',
                    triggers: []
                }),
                fetchSchema: async () => ({
                    tables: [],
                    views: [{ identifier: 'wal_view' }],
                    indexes: []
                })
            });
            (document as any).isReadOnlyMode = false;
            assert.strictEqual((await provider.stat(uri)).permissions, undefined);
            let resolveEvent!: (changes: vscode.FileChangeEvent[]) => void;
            const eventReceived = new Promise<vscode.FileChangeEvent[]>(resolve => {
                resolveEvent = resolve;
            });
            const subscription = provider.onDidChangeFile(resolveEvent);

            try {
                (document as any).isReadOnlyMode = true;
                document.invalidateAllViewDocuments();
                await eventReceived;

                assert.strictEqual(
                    (await provider.stat(uri)).permissions,
                    vscode.FilePermission.Readonly
                );
            } finally {
                subscription.dispose();
            }
        });

        it('forgets view metadata when its database document is disposed', async () => {
            let now = 100;
            mock.method(Date, 'now', () => now);
            const disposableDocKey = 'disposed-view-doc';
            const document = setupMockDocument(disposableDocKey, {
                getViewDefinition: async () => ({ selectSql: 'SELECT 1' })
            });
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${disposableDocKey}/users/group/__view__.sql/definition.sql`
            );

            const first = await provider.stat(uri);
            now = 200;
            document.dispose();
            const afterDispose = await provider.stat(uri);

            assert.strictEqual(first.ctime, 100);
            assert.strictEqual(afterDispose.ctime, 200);
            assert.strictEqual(document.getDisposeSubscriptionDisposeCount(), 1);
        });

        it('maps a missing view stat to FileNotFound', async () => {
            const uri = vscode.Uri.parse(
                `vscode-sqlite://${docKey}/missing_view/group/__view__.sql/definition.sql`
            );
            setupMockDocument(docKey, {
                getViewDefinition: async () => {
                    throw new Error('View not found: missing_view');
                }
            });

            await assert.rejects(
                provider.stat(uri),
                (error: any) => error.code === 'FileNotFound'
            );
        });

        it('watch should return a generic Disposable', async () => {
            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/col.txt`);
            const disposable = provider.watch(uri, { recursive: false, excludes: [] });
            assert.ok(disposable.dispose);
        });

        it('should throw NoPermissions for delete', async () => {
            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/col.txt`);
            await assert.rejects(async () => {
                await provider.delete(uri, { recursive: false });
            }, (err: any) => err.message.includes('NoPermissions'));
        });

        it('should throw NoPermissions for rename', async () => {
            const uri1 = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/col.txt`);
            const uri2 = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/col2.txt`);
            await assert.rejects(async () => {
                await provider.rename(uri1, uri2, { overwrite: true });
            }, (err: any) => err.message.includes('NoPermissions'));
        });
    });
});
