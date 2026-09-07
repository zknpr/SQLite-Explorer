import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { buildCreateTableSql } from '../../src/core/schema-ddl';
import { createDatabaseEngine, createWorkerEndpoint, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import type { ColumnDefinition, DatabaseOperations, LabeledModification } from '../../src/core/types';

const columns: ColumnDefinition[] = [
    { name: 'key', type: 'TEXT', primaryKey: true, notNull: false },
    { name: 'value', type: 'INTEGER', primaryKey: false, notNull: false, defaultValue: '7' },
    { name: 'label', type: 'TEXT', primaryKey: false, notNull: false, defaultValue: "O'Reilly" }
];

it('builds explicit WITHOUT ROWID tables and rejects the option without a primary key', () => {
    assert.match(buildCreateTableSql('items', columns, { withoutRowid: true }), /WITHOUT ROWID$/);
    assert.doesNotMatch(buildCreateTableSql('items', columns), /WITHOUT ROWID/);
    assert.throws(() => buildCreateTableSql('items', columns.map(column => ({ ...column, primaryKey: false })), { withoutRowid: true }), /primary key/i);
    assert.throws(() => buildCreateTableSql('items', columns, { withoutRowid: 'yes' } as never), /option/i);
});

it('worker endpoint forwards Create Table options to the real WASM engine', async () => {
    const endpoint = createWorkerEndpoint();
    try {
        await endpoint.initializeDatabase('endpoint.db', { content: null, maxSize: 0, readOnlyMode: false });
        await endpoint.createTable('items', columns, { withoutRowid: true });
        assert.match((await endpoint.runQuery("SELECT sql FROM sqlite_schema WHERE name='items'"))[0].rows[0][0] as string, /WITHOUT ROWID$/);
        await endpoint.createTable('ordinary', columns);
        assert.doesNotMatch((await endpoint.runQuery("SELECT sql FROM sqlite_schema WHERE name='ordinary'"))[0].rows[0][0] as string, /WITHOUT ROWID/);
    } finally { endpoint.dispose(); }
});

for (const backend of ['wasm', 'native'] as const) it(`${backend} creates defaults and preserves WITHOUT ROWID through undo and redo`, async () => {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/create-table-options-'));
    const initialized = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    const wasm = initialized.operations as WasmDatabaseEngine;
    let native: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
    try {
        let operations: DatabaseOperations = wasm;
        if (backend === 'native') {
            const file = vscode.Uri.file(path.join(directory, 'database.db'));
            fs.writeFileSync(file.fsPath, await wasm.serializeDatabase());
            native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
            operations = (await native.establishConnection(file, 'create-table-options', false)).databaseOps;
        }
        const options = { withoutRowid: true };
        const created = await operations.createTable('items', columns, options);
        const history: LabeledModification = {
            label: 'Create Table', description: 'Create items', modificationType: 'table_create',
            targetTable: 'items', tableDef: { columns, options }, tableCreateSnapshot: created
        };
        assert.match((await operations.executeQuery("SELECT sql FROM sqlite_schema WHERE name = 'items'"))[0].rows[0][0] as string, /WITHOUT ROWID$/);
        await operations.undoModification(history);
        await operations.redoModification(history);
        assert.match((await operations.executeQuery("SELECT sql FROM sqlite_schema WHERE name = 'items'"))[0].rows[0][0] as string, /WITHOUT ROWID$/);
        await operations.executeQuery("INSERT INTO items(key) VALUES ('one')");
        assert.deepEqual((await operations.executeQuery('SELECT key, value, label FROM items'))[0].rows, [['one', 7, "O'Reilly"]]);
    } finally {
        native?.workerMethods[Symbol.dispose](); wasm.shutdown();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
