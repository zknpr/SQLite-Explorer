
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
        const mockDocument: any = {
            databaseOperations: dbOps,
            recordExternalModification: mock.fn((modification: any) => {
                contentEmitter.fire({ modification });
            }),
            onDidChangeContent: contentEmitter.event,
            onDidDispose,
            dispose: () => disposeEmitter.fire(),
            fireContentChange: (modification: any) => contentEmitter.fire({ modification }),
            getDisposeSubscriptionDisposeCount: () => disposeSubscriptionDisposeCount
        };
        DocumentRegistry.set(key, mockDocument);
        return mockDocument as DatabaseDocument & {
            fireContentChange(modification: any): void;
            getDisposeSubscriptionDisposeCount(): number;
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

            assert.strictEqual(new TextDecoder().decode(content), 'SELECT id, name FROM users');
            assert.strictEqual(dbOps.getViewDefinition.mock.callCount(), 1);
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
                    assert.match(sql, /SELECT "name" FROM "users" WHERE rowid = \?/);
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

        it('should throw FileNotFound on database error', async () => {
            const dbOps = {
                executeQuery: mock.fn(async () => {
                    throw new Error('Database error');
                })
            };
            setupMockDocument(docKey, dbOps);

            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/col.txt`);

            // It catches error and rethrows as FileNotFound
            await assert.rejects(async () => {
                await provider.readFile(uri);
            }, /FileNotFound/);
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
                updateCell: mock.fn(async () => {})
            };
            const doc = setupMockDocument(docKey, dbOps);

            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/col.txt`);
            const content = new TextEncoder().encode('Hello World');
            await provider.writeFile(uri, content, { create: false, overwrite: true });

            assert.strictEqual(dbOps.updateCell.mock.callCount(), 1);
            assert.deepStrictEqual(dbOps.updateCell.mock.calls[0].arguments, ['users', 1, 'col', 'Hello World']);
            assert.strictEqual((doc.recordExternalModification as any).mock.callCount(), 1);
        });

        it('should write binary content if not valid UTF-8', async () => {
            const dbOps = {
                updateCell: mock.fn(async () => {})
            };
            const doc = setupMockDocument(docKey, dbOps);

            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group/1/col.txt`);
            const content = new Uint8Array([0xff, 0xff, 0xff]); // Invalid UTF-8
            await provider.writeFile(uri, content, { create: false, overwrite: true });

            assert.strictEqual(dbOps.updateCell.mock.callCount(), 1);
            assert.deepStrictEqual(dbOps.updateCell.mock.calls[0].arguments, ['users', 1, 'col', content]);
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
                true
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

        it('should throw NoPermissions for createDirectory', async () => {
            const uri = vscode.Uri.parse(`vscode-sqlite://${docKey}/users/group`);
            await assert.rejects(async () => {
                await provider.createDirectory(uri);
            }, (err: any) => err.message.includes('NoPermissions'));
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
            setupMockDocument(docKey, {
                getViewDefinition: async () => ({ selectSql: 'SELECT 1' })
            });

            const s = await provider.stat(uri);

            assert.strictEqual(s.permissions, undefined);
            assert.strictEqual(s.size, 'SELECT 1'.length);
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
