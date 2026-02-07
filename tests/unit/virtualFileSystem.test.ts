
import './vscode_mock_setup'; // Must be first
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import { SQLiteFileSystemProvider } from '../../src/virtualFileSystem';
import { DocumentRegistry } from '../../src/documentRegistry';
import type { DatabaseDocument } from '../../src/databaseModel';
import * as vscode from 'vscode';

describe('SQLiteFileSystemProvider', () => {

    function setupMockDocument(key: string, dbOps: any = {}) {
        const mockDocument = {
            databaseOperations: dbOps,
            recordExternalModification: mock.fn()
        } as unknown as DatabaseDocument;
        DocumentRegistry.set(key, mockDocument);
        return mockDocument;
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
});
