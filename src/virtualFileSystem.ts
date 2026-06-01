import * as vsc from 'vscode';
import { DocumentRegistry } from './documentRegistry';
import { Disposable } from './lifecycle';
import { escapeIdentifier } from './core/sql-utils';

import type { DatabaseDocument } from './databaseModel';

export class SQLiteFileSystemProvider implements vsc.FileSystemProvider {
    readonly onDidChangeFile: vsc.Event<vsc.FileChangeEvent[]>;
    private _emitter = new vsc.EventEmitter<vsc.FileChangeEvent[]>();

    constructor() {
        this.onDidChangeFile = this._emitter.event;
    }

    watch(uri: vsc.Uri, options: { recursive: boolean; excludes: string[] }): vsc.Disposable {
        return new vsc.Disposable(() => { });
    }

    async stat(uri: vsc.Uri): Promise<vsc.FileStat> {
        // Return generic file stat
        const { rowId } = this.parseUri(uri);

        const now = Date.now();
        const isDir = false; // Only files (cells) supported

        return {
            type: isDir ? vsc.FileType.Directory : vsc.FileType.File,
            ctime: now,
            mtime: now,
            size: 0, // Dynamic size
            permissions: rowId === '__create__.sql' ? vsc.FilePermission.Readonly : undefined
        };
    }

    async readDirectory(uri: vsc.Uri): Promise<[string, vsc.FileType][]> {
        // Not really supported or needed for cell editing
        return [];
    }

    async createDirectory(uri: vsc.Uri): Promise<void> {
        throw vsc.FileSystemError.NoPermissions();
    }

    async readFile(uri: vsc.Uri): Promise<Uint8Array> {
        const { document, table, rowId, column } = this.parseUri(uri);

        try {
            if (rowId === '__create__.sql') {
                // Fetch create statement
                // Query sqlite_schema
                const sql = `SELECT sql FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ?`;
                const result = await document.databaseOperations.executeQuery(sql, [table]);
                const createSql = result?.[0]?.rows?.[0]?.[0];
                if (typeof createSql === 'string') {
                    return new TextEncoder().encode(createSql);
                }
                return new Uint8Array(0);
            }

            

            // Verify if the target is a valid table or view in the schema.
            const checkQuery = `SELECT 1 FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ?`;
            const checkResult = await document.databaseOperations.executeQuery(checkQuery, [table]);

            if (!checkResult?.[0]?.rows?.length) {
                throw vsc.FileSystemError.FileNotFound(uri);
            }

            const colName = column;
            const rowIdNum = Number(rowId);

            if (isNaN(rowIdNum)) {
                return new TextEncoder().encode(`Invalid Row ID: ${rowId}`);
            }

            // For tables, use WHERE rowid = ?
            // Escape identifiers.
            // Reuse `fetchTableData` or `executeQuery`.
            const query = `SELECT ${escapeIdentifier(colName)} FROM ${escapeIdentifier(table)} WHERE rowid = ?`;
            const result = await document.databaseOperations.executeQuery(query, [rowIdNum]);

            const value = result?.[0]?.rows?.[0]?.[0];

            if (value === null) {
                // Return empty content for NULL values as VS Code expects a string/buffer.
                return new Uint8Array(0);
            }

            if (value instanceof Uint8Array) {
                return value;
            }

            return new TextEncoder().encode(String(value));

        } catch (err) {
            console.error('Error reading cell:', err);
            throw vsc.FileSystemError.FileNotFound(uri);
        }
    }

    async writeFile(uri: vsc.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
        const { document, table, rowId, column } = this.parseUri(uri);

        if (rowId === '__create__.sql') {
            throw vsc.FileSystemError.NoPermissions('Cannot edit CREATE statement directly');
        }

        if (document.isReadOnlyMode) {
            // Read-only database documents may expose cell files for viewing, but
            // writes must stop before decoding content or recording dirty edits.
            throw vsc.FileSystemError.NoPermissions('Database is read-only');
        }

        try {
            const rowIdNum = Number(rowId);
            if (isNaN(rowIdNum)) {
                throw vsc.FileSystemError.Unavailable('Invalid Row ID');
            }

           

            let value: string | Uint8Array = content;

            // Try to decode as UTF-8
            try {
                // We strictly try to decode as UTF-8. If the content contains invalid UTF-8 sequences,
                // the TextDecoder with 'fatal: true' will throw, and we will fall back to treating it as a BLOB.
                // This allows saving text containing null bytes, which are valid in UTF-8/SQL TEXT,
                // while correctly handling actual binary data.
                value = new TextDecoder('utf-8', { fatal: true }).decode(content);
            } catch {
                // Keep as Uint8Array, treating as BLOB
            }

            await document.databaseOperations.updateCell(table, rowIdNum, column, value);

            // Trigger refresh
            document.recordExternalModification({
                label: 'Edit Cell (External)',
                description: `Update ${table}.${column} from editor`,
                modificationType: 'cell_update',
                targetTable: table,
                targetRowId: rowIdNum,
                targetColumn: column,
                newValue: value
            });

            this._emitter.fire([{ type: vsc.FileChangeType.Changed, uri }]);

        } catch (err) {
            console.error('Error writing cell:', err);
            throw vsc.FileSystemError.Unavailable(err instanceof Error ? err.message : String(err));
        }
    }

    async delete(uri: vsc.Uri, options: { recursive: boolean }): Promise<void> {
        throw vsc.FileSystemError.NoPermissions();
    }

    async rename(oldUri: vsc.Uri, newUri: vsc.Uri, options: { overwrite: boolean }): Promise<void> {
        throw vsc.FileSystemError.NoPermissions();
    }

    private parseUri(uri: vsc.Uri): { document: DatabaseDocument, table: string, rowId: string, column: string } {
        // Path format: /<document_key>/<table>/<name>/<rowid>/<filename>
        // Note: VS Code URIs usually have a leading slash in path
        const pathParts = uri.path.split('/').filter(p => p.length > 0);

        // Path format structure:
        // [0] documentKey
        // [1] table
        // [2] name (optional grouping)
        // [3] rowId
        // [4] filename (colName + ext)

        if (pathParts.length < 4) {
            throw vsc.FileSystemError.FileNotFound(uri);
        }

        const documentKey = decodeURIComponent(pathParts[0]);
        const table = decodeURIComponent(pathParts[1]);
        // pathParts[2] is grouping name, ignore
        const rowId = decodeURIComponent(pathParts[3]);

        let column = '';
        if (pathParts.length > 4) {
            const filename = decodeURIComponent(pathParts[4]);
            const lastDotIndex = filename.lastIndexOf('.');
            column = lastDotIndex > 0 ? filename.substring(0, lastDotIndex) : filename;
        }

        const document = DocumentRegistry.get(documentKey);
        if (!document) {
            throw vsc.FileSystemError.FileNotFound(uri);
        }

        return { document, table, rowId, column };
    }
}
