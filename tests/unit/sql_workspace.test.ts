import './vscode_mock_setup';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { parseQueryParameters, prepareReadQuery, SQL_RESULT_ROWS } from '../../src/core/sql-workspace';

it('binds typed parameters without rounding integers', () => {
    assert.deepEqual(parseQueryParameters('[null,"text",1,1.5]'), [null, 'text', 1, 1.5]);
    assert.throws(() => parseQueryParameters('[9007199254740993]'), /safe integer/);
    assert.throws(() => parseQueryParameters('[true]'), /null, string/);
    assert.deepEqual(prepareReadQuery("SELECT '?' AS literal, ?1 AS value; -- end").parameterCount, 1);
    assert.equal(prepareReadQuery('SELECT account$id FROM accounts').parameterCount, 0);
    for (const token of [':1', '@1', '$1', ':é']) {
        assert.throws(() => prepareReadQuery(`SELECT ${token}`), /Named parameters/);
    }
});

it('executes bounded read queries with exact values in WASM', async () => {
    const engine = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    const db = engine.operations;
    assert.ok(db);
    try {
        const result = await db.executeReadQuery('SELECT ? AS value, 9223372036854775807 AS exact', ['hello']);
        assert.deepEqual(result.headers, ['value', 'exact']);
        assert.equal(result.rows[0][0], 'hello');
        assert.equal(result.exactIntegerTexts?.[0]?.[1], '9223372036854775807');
        const capped = await db.executeReadQuery('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000) SELECT x FROM n');
        assert.equal(capped.rows.length, SQL_RESULT_ROWS + 1);
        assert.ok((await db.executeReadQuery('SELECT 1 AS value', [], true)).rows.length);
        await assert.rejects(db.executeReadQuery('DELETE FROM sqlite_schema'), /read query|syntax/i);
        const abort = new AbortController(); abort.abort();
        await assert.rejects(db.executeReadQuery('SELECT 1', [], false, abort.signal));
        const readonly = await createDatabaseEngine({ content: await db.serializeDatabase(), maxSize: 0, readOnlyMode: true });
        try {
            assert.deepEqual((await readonly.operations!.executeReadQuery('SELECT 1 AS value')).rows, [[1]]);
            assert.ok((await readonly.operations!.executeReadQuery('SELECT 1 AS value', [], true)).rows.length);
            await assert.rejects(readonly.operations!.executeReadQuery('SELECT * FROM missing_table'));
            assert.deepEqual((await readonly.operations!.executeQuery('PRAGMA query_only'))[0].rows, [[1]], 'metadata errors must retain the read-only guard');
            assert.deepEqual((await readonly.operations!.executeQuery('SELECT name FROM sqlite_temp_schema'))[0]?.rows ?? [], [], 'metadata views must be cleaned up');
        } finally { (readonly.operations as WasmDatabaseEngine).shutdown(); }
    } finally { (db as WasmDatabaseEngine).shutdown(); }
});

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import type { DatabaseOperations } from '../../src/core/types';
import { SQL_RESULT_BYTES, resultCsv } from '../../src/core/sql-workspace';

it('uses the existing spreadsheet text policy while preserving negative numeric values', () => {
    assert.equal(resultCsv({ headers: ['+column'], rows: [['-draft'], [-12]] }), '"\'+column"\r\n"\'-draft"\r\n"-12"');
});

async function exerciseReadQuery(db: DatabaseOperations) {
    await db.executeQuery('CREATE TABLE items (id INTEGER, label TEXT)');
    await db.executeQuery("INSERT INTO items VALUES (1, 'one'), (2, 'two')");
    const join = await db.executeReadQuery('SELECT a.id AS id, b.label AS label FROM items a JOIN items b ON a.id = b.id WHERE a.id = ?', [2]);
    assert.deepEqual(join.headers, ['id', 'label']);
    assert.deepEqual(join.rows, [[2, 'two']]);
    const duplicates = await db.executeReadQuery('SELECT 1 AS x, 2 AS x, ? AS parameter', ['value']);
    assert.deepEqual(duplicates.rows, [[1, 2, 'value']]);
    assert.equal(duplicates.headers.length, 3);
    const unaliased = await db.executeReadQuery('SELECT ? + 1, 2 AS named', [3]);
    assert.deepEqual(unaliased.rows, [[4, 2]]);
    const exact = await db.executeReadQuery('SELECT CAST(? AS INTEGER) AS exact', ['9223372036854775807']);
    assert.equal(exact.exactIntegerTexts?.[0]?.[0], '9223372036854775807');
    assert.match(resultCsv(exact), /9223372036854775807/);
    const bounded = await db.executeReadQuery('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 1200) SELECT x, zeroblob(10000) AS payload FROM n');
    assert.equal(bounded.rows.length, 1001);
    assert.ok(bounded.oversizedCells?.[0]?.[1]);
    assert.ok(bounded.rows.reduce((sum, row) => sum + (row[1] as Uint8Array).byteLength, 0) <= SQL_RESULT_BYTES);
    await assert.rejects(db.executeReadQuery('SELECT ? AS value', []), /Expected 1/);
    await assert.rejects(db.executeReadQuery('SELECT missing_column FROM items'), /missing_column|SQL logic error/);
    await assert.rejects(db.executeReadQuery('UPDATE items SET label = ?', ['changed']));
    assert.deepEqual((await db.executeQuery('SELECT label FROM items ORDER BY id'))[0].rows, [['one'], ['two']]);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(db.executeReadQuery('SELECT 1', [], false, aborted.signal));
}

it('preserves ordered values, exact integers and byte caps on WASM', async () => {
    const { operations } = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    assert.ok(operations);
    try { await exerciseReadQuery(operations); } finally { (operations as WasmDatabaseEngine).shutdown(); }
});

it('preserves ordered values, exact integers and byte caps on bundled native SQLite', async () => {
    const tmp = path.join(process.cwd(), '.tmp'); fs.mkdirSync(tmp, { recursive: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'sql-workspace-'));
    const database = path.join(dir, 'query.db'); fs.closeSync(fs.openSync(database, 'w'));
    const bundle = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
    try {
        const { databaseOps } = await bundle.establishConnection(vscode.Uri.file(database), 'query.db');
        await exerciseReadQuery(databaseOps);
        assert.ok((await databaseOps.executeReadQuery('SELECT * FROM items WHERE id = ?', [2], true)).rows.length);
        const controller = new AbortController();
        const cancel = setTimeout(() => controller.abort(), 10);
        try {
            await assert.rejects(databaseOps.executeReadQuery('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT sum(x) FROM n', [], false, controller.signal));
            assert.equal(controller.signal.aborted, true);
        } finally { clearTimeout(cancel); }
        assert.deepEqual((await databaseOps.executeReadQuery('SELECT 1 AS value')).rows, [[1]]);
        await databaseOps.executeQuery('CREATE TEMP TABLE session_items (value TEXT)');
        await databaseOps.executeQuery("INSERT INTO session_items VALUES ('temporary')");
        assert.deepEqual((await databaseOps.executeReadQuery('SELECT value FROM session_items')).rows, [['temporary']]);
    } finally { bundle.workerMethods[Symbol.dispose](); fs.rmSync(dir, { recursive: true, force: true }); }
});

it('enforces the configured query timeout in WASM', async () => {
    const { operations } = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false, queryTimeout: 1 });
    assert.ok(operations);
    try {
        await assert.rejects(operations.executeReadQuery('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100000) SELECT sum(x) FROM n'), /timed out/i);
        assert.deepEqual((await operations.executeReadQuery('SELECT 1 AS value')).rows, [[1]]);
    } finally { (operations as WasmDatabaseEngine).shutdown(); }
});

it('keeps native read queries usable on a read-only main database', async () => {
    const tmp = path.join(process.cwd(), '.tmp'); fs.mkdirSync(tmp, { recursive: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'sql-read-only-'));
    const database = path.join(dir, 'query.db'); fs.closeSync(fs.openSync(database, 'w'));
    const bundle = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()), undefined, undefined, 10);
    try {
        let connection = await bundle.establishConnection(vscode.Uri.file(database), 'query.db');
        await connection.databaseOps.executeQuery('CREATE TABLE items (value TEXT)');
        await connection.databaseOps.executeQuery("INSERT INTO items VALUES ('saved')");
        fs.chmodSync(database, 0o444);
        connection = await bundle.establishConnection(vscode.Uri.file(database), 'query.db');
        assert.equal(connection.isReadOnly, true);
        assert.deepEqual((await connection.databaseOps.executeReadQuery('SELECT value FROM items')).rows, [['saved']]);
        assert.ok((await connection.databaseOps.executeReadQuery('SELECT value FROM items', [], true)).rows.length);
        await assert.rejects(connection.databaseOps.executeReadQuery('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT sum(x) FROM n'), /timed out/i);
        assert.deepEqual((await connection.databaseOps.executeReadQuery('SELECT 1 AS value')).rows, [[1]]);
    } finally { bundle.workerMethods[Symbol.dispose](); fs.chmodSync(database, 0o644); fs.rmSync(dir, { recursive: true, force: true }); }
});

import { mockVscode } from './mocks/vscode';
import { DocumentRegistry } from '../../src/documentRegistry';
import type { DatabaseDocument } from '../../src/databaseModel';

for (const languageId of ['sql', 'sqlite']) it(`runs selected ${languageId} and refuses to retarget a closed document binding`, async () => {
    const changes: Array<() => void> = [];
    const replace = (object: object, key: string, value: unknown) => {
        const target = object as Record<string, unknown>;
        const old = Object.getOwnPropertyDescriptor(target, key);
        changes.push(() => { if (old) Object.defineProperty(target, key, old); else delete target[key]; });
        target[key] = value;
    };
    const { operations } = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    assert.ok(operations);
    const commands = new Map<string, () => Promise<void>>();
    const errors: string[] = [];
    let picks = 0, executed = 0, outputText = '';
    const outputUris: string[] = [];
    let contentProvider: vscode.TextDocumentContentProvider | undefined;
    const sqlDocument = { languageId, isClosed: false, getText: (selection?: unknown) => selection ? 'SELECT 42 AS selected' : 'SELECT 99 AS whole_document' };
    const editor = { document: sqlDocument, selection: { isEmpty: false } };
    const database = {
        uri: vscode.Uri.file('/workspace/selected.db'),
        databaseOperations: { executeReadQuery: (...args: Parameters<DatabaseOperations['executeReadQuery']>) => { executed++; return operations.executeReadQuery(...args); } },
        onDidDispose: () => ({ dispose() {} })
    } as unknown as DatabaseDocument;
    const unrelated = { ...database, uri: vscode.Uri.file('/workspace/unrelated.db') } as DatabaseDocument;
    DocumentRegistry.set('selected', database); DocumentRegistry.set('unrelated', unrelated);
    let registration: vscode.Disposable | undefined;
    try {
        replace(mockVscode, 'Disposable', class { constructor(private readonly callback: () => void) {} dispose() { this.callback(); } });
        replace(mockVscode.commands, 'registerCommand', (name: string, action: () => Promise<void>) => { commands.set(name, action); return { dispose() {} }; });
        replace(mockVscode.window, 'activeTextEditor', editor);
        replace(mockVscode.window, 'showQuickPick', async (items: unknown[]) => { picks++; return items[0]; });
        replace(mockVscode.window, 'showErrorMessage', async (message: string) => { errors.push(message); });
        replace(mockVscode.workspace, 'registerTextDocumentContentProvider', (_scheme: string, provider: vscode.TextDocumentContentProvider) => { contentProvider = provider; return { dispose() {} }; });
        replace(mockVscode.workspace, 'openTextDocument', async (uri: vscode.Uri) => { outputUris.push(uri.toString()); outputText = String(await contentProvider!.provideTextDocumentContent(uri, {} as vscode.CancellationToken)); return { uri }; });
        replace(mockVscode.window, 'showTextDocument', async () => undefined);
        replace(mockVscode, 'languages', { registerCompletionItemProvider: () => ({ dispose() {} }) });
        const { registerSqlWorkspace } = await import('../../src/sqlWorkspace');
        registration = registerSqlWorkspace({} as vscode.ExtensionContext);
        await commands.get('sqlite-explorer.runQuery')!();
        assert.match(outputText, /"42"/); assert.doesNotMatch(outputText, /"99"/);
        assert.equal(executed, 1); assert.equal(picks, 1);
        registration.dispose();
        registration = registerSqlWorkspace({} as vscode.ExtensionContext);
        await commands.get('sqlite-explorer.runQuery')!();
        assert.notEqual(outputUris[0], outputUris[1], 'a new activation must not reuse a cached result document');
        DocumentRegistry.delete('selected');
        await commands.get('sqlite-explorer.runQuery')!();
        assert.equal(executed, 2); assert.equal(picks, 2);
        assert.match(errors.at(-1)!, /database was closed/);
    } finally {
        registration?.dispose(); DocumentRegistry.delete('selected'); DocumentRegistry.delete('unrelated');
        changes.reverse().forEach(restore => restore()); (operations as WasmDatabaseEngine).shutdown();
    }
});
