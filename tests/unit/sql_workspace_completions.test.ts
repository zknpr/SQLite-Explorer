import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import { mockVscode } from './mocks/vscode';
import { DocumentRegistry } from '../../src/documentRegistry';
import type { DatabaseDocument } from '../../src/databaseModel';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations } from '../../src/core/types';
import { createNativeDatabaseConnection, isNativeAvailable } from '../../src/nativeWorker';

/**
 * The SQL editor's completions list every table and view with its columns.
 * One query read them all, and it fails as a whole when a single object's
 * columns cannot be listed: a view over a dropped table, a view that calls a
 * function only its application registers, a virtual table whose module is
 * missing. New Query then showed that object's error and offered nothing.
 * Each object is now asked on its own when the one query fails, and an object
 * that cannot answer is still offered by name.
 */

type SqlJsDatabase = { run(sql: string): void; export(): Uint8Array; close(): void };

async function image(schema: string): Promise<Uint8Array> {
    const initSqlJs = (await import('../../vendor/sql.js/sql-wasm.js')).default as unknown as
        (config: object) => Promise<{ Database: new () => SqlJsDatabase }>;
    const db = new (await initSqlJs({})).Database();
    try {
        db.run(schema);
        return db.export();
    } finally {
        db.close();
    }
}

const HEALTHY = `
    CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT);
    CREATE VIEW labels AS SELECT label FROM items;
`;

// sql.js writes the virtual table's schema row directly: node:sqlite refuses
// that in the Node versions that open a database in defensive mode.
const WITH_OBJECTS_THAT_CANNOT_LIST_COLUMNS = `${HEALTHY}
    CREATE TABLE gone(x);
    CREATE VIEW stale AS SELECT x FROM gone;
    DROP TABLE gone;
    CREATE VIEW scored AS SELECT application_score(label) AS score FROM items;
    PRAGMA writable_schema = ON;
    INSERT INTO sqlite_schema(type, name, tbl_name, rootpage, sql)
        VALUES ('table', 'ext_idx', 'ext_idx', 0, 'CREATE VIRTUAL TABLE ext_idx USING absent_module()');
    PRAGMA writable_schema = OFF;
`;

// A user table may take a PRAGMA table's name; the completions must read
// SQLite's own.
const WITH_A_TABLE_NAMED_LIKE_THE_PRAGMA = `${HEALTHY}
    CREATE TABLE pragma_table_info(cid, name);
    INSERT INTO pragma_table_info VALUES (0, 'decoy');
`;

/** Labels the completion provider offers after Refresh Query Completions, and the errors shown. */
async function completions(operations: DatabaseOperations): Promise<{ labels: string[]; errors: string[] }> {
    const restorations: Array<() => void> = [];
    const replace = (object: object, key: string, value: unknown) => {
        const original = Object.getOwnPropertyDescriptor(object, key);
        restorations.push(() => { if (original) Object.defineProperty(object, key, original); else Reflect.deleteProperty(object, key); });
        Object.defineProperty(object, key, { configurable: true, writable: true, value });
    };
    const commands = new Map<string, () => Promise<void>>();
    const errors: string[] = [];
    let provider: vscode.CompletionItemProvider | undefined;
    const document = { languageId: 'sql', isClosed: false, getText: () => 'SELECT 1' } as vscode.TextDocument;
    const database = {
        uri: vscode.Uri.file('/workspace/completions.db'), onDidDispose: () => ({ dispose() {} }),
        databaseOperations: operations
    } as unknown as DatabaseDocument;
    let registration: vscode.Disposable | undefined;
    DocumentRegistry.set('sql-completions', database);
    try {
        replace(mockVscode, 'Disposable', class { constructor(private readonly callback: () => void) {} dispose() { this.callback(); } });
        replace(mockVscode, 'CompletionItem', class { constructor(public label: string, public kind: number) {} });
        replace(mockVscode, 'CompletionItemKind', { Module: 8, Class: 6, Field: 4 });
        replace(mockVscode.commands, 'registerCommand', (id: string, command: () => Promise<void>) => { commands.set(id, command); return { dispose() {} }; });
        replace(mockVscode.window, 'activeTextEditor', { document, selection: { isEmpty: true } });
        replace(mockVscode.window, 'showErrorMessage', async (message: string) => { errors.push(message); });
        replace(mockVscode.workspace, 'registerTextDocumentContentProvider', () => ({ dispose() {} }));
        replace(mockVscode, 'languages', { registerCompletionItemProvider: (_selector: unknown, value: vscode.CompletionItemProvider) => { provider = value; return { dispose() {} }; } });
        const { registerSqlWorkspace } = await import('../../src/sqlWorkspace');
        registration = registerSqlWorkspace({} as vscode.ExtensionContext);
        await commands.get('sqlite-explorer.refreshQueryCompletions')!();
        const items = await provider!.provideCompletionItems(
            document, {} as vscode.Position, {} as vscode.CancellationToken, {} as vscode.CompletionContext
        ) as vscode.CompletionItem[] | undefined;
        return { labels: (items ?? []).map(item => `${item.label}${item.detail ? ` (${item.detail})` : ''}`), errors };
    } finally {
        registration?.dispose();
        DocumentRegistry.delete('sql-completions');
        restorations.reverse().forEach(restore => restore());
    }
}

async function onWasm(schema: string): Promise<{ labels: string[]; errors: string[] }> {
    const engine = (await createDatabaseEngine({ content: await image(schema), maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    try {
        return await completions(engine);
    } finally {
        engine.shutdown();
    }
}

async function onNative(schema: string): Promise<{ labels: string[]; errors: string[] }> {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/sql-completions-'));
    const file = path.join(directory, 'completions.db');
    fs.writeFileSync(file, await image(schema));
    const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
    try {
        const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'completions.db', false);
        return await completions(databaseOps);
    } finally {
        native.workerMethods[Symbol.dispose]();
        await fs.promises.rm(directory, { recursive: true, force: true });
    }
}

const HEALTHY_LABELS = ['main', 'temp', 'items (main)', 'id (items)', 'label (items)', 'labels (main)', 'label (labels)'];

it('goes on object by object when an error only quotes a name that reads like a lock', async () => {
    // A view over a missing table named "database is locked" fails with that name in its message.
    const asked: string[] = [];
    const operations = {
        executeReadQuery: async (sql: string, params?: unknown[]) => {
            asked.push(params?.length ? `columns of ${params[0]}` : sql.includes('JOIN') ? 'every column' : 'object names');
            if (sql.includes('JOIN')) throw new Error('[workspaceQuery] no such table: main.database is locked');
            if (!params?.length) return { headers: ['name'], rows: [['a'], ['broken'], ['c']] };
            if (params[0] === 'broken') throw new Error('[workspaceQuery] no such table: main.database is locked');
            return { headers: ['name'], rows: [['id']] };
        }
    } as unknown as DatabaseOperations;
    const { labels, errors } = await completions(operations);
    assert.deepEqual(asked, ['every column', 'object names', 'columns of a', 'columns of broken', 'columns of c']);
    assert.deepEqual(errors, []);
    for (const label of ['a (main)', 'id (a)', 'broken (main)', 'c (main)', 'id (c)']) assert.ok(labels.includes(label), `${label} in ${labels.join(', ')}`);
});

it('stops asking object by object once the database is locked', async () => {
    // The native engine waits a moment for another program's lock before each
    // refusal: 500 objects asked one by one would wait 500 times.
    const asked: string[] = [];
    const operations = {
        executeReadQuery: async (sql: string, params?: unknown[]) => {
            asked.push(params?.length ? `columns of ${params[0]}` : sql.includes('JOIN') ? 'every column' : 'object names');
            if (sql.includes('JOIN')) throw new Error('[queryBounded] no such table: main.gone');
            if (!params?.length) return { headers: ['name'], rows: [['a'], ['b'], ['c'], ['d']] };
            if (params[0] === 'a') return { headers: ['name'], rows: [['id']] };
            throw new Error('[run] database is locked');
        }
    } as unknown as DatabaseOperations;
    const { labels, errors } = await completions(operations);
    assert.deepEqual(asked, ['every column', 'object names', 'columns of a', 'columns of b']);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /database is locked/);
    assert.deepEqual(labels, []);
});

for (const [engine, run] of [['WebAssembly', onWasm], ['native', onNative]] as const) {
    describe(`SQL editor completions on the ${engine} engine`, () => {
        const skip = async (t: { skip(reason: string): void }) => {
            if (engine !== 'native' || await isNativeAvailable(process.cwd())) return false;
            t.skip('Bundled native runtime unavailable');
            return true;
        };

        it('offers every table and view with its columns', async t => {
            if (await skip(t)) return;
            assert.deepEqual(await run(HEALTHY), { labels: HEALTHY_LABELS, errors: [] });
        });

        it('offers the rest of the database when some objects cannot list their columns', async t => {
            if (await skip(t)) return;
            assert.deepEqual(await run(WITH_OBJECTS_THAT_CANNOT_LIST_COLUMNS), {
                labels: [
                    'main', 'temp',
                    'ext_idx (main)',
                    'items (main)', 'id (items)', 'label (items)',
                    'labels (main)', 'label (labels)',
                    'scored (main)',
                    'stale (main)'
                ],
                errors: []
            });
        });

        it('reads the columns from SQLite when a table has the PRAGMA table\'s name', async t => {
            if (await skip(t)) return;
            assert.deepEqual(await run(WITH_A_TABLE_NAMED_LIKE_THE_PRAGMA), {
                labels: [...HEALTHY_LABELS, 'pragma_table_info (main)', 'cid (pragma_table_info)', 'name (pragma_table_info)'],
                errors: []
            });
        });
    });
}
