import './vscode_mock_setup';

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import { WasmDatabaseEngine } from '../../src/core/engine/wasm/WasmDatabaseEngine';
import type { DatabaseOperations } from '../../src/core/types';

async function checkReplay(engine: DatabaseOperations, readRows: () => Promise<unknown>) {
    const prior = [
        '{ "keep":1, "nested":{"old":2}, "remove":true, "literal":null }',
        '{"keep":2,"nested":{"old":3},"remove":true,"literal":null}'
    ];
    const post = [
        '{"keep":1,"nested":{"old":2,"new":7},"literal":null}',
        '{"keep":2,"nested":{"old":3,"new":7},"literal":null}'
    ];
    await engine.executeQuery('CREATE TABLE json_history(id INTEGER PRIMARY KEY, value TEXT)');
    for (let index = 0; index < prior.length; index++) {
        await engine.insertRow('json_history', { id: index + 1, value: prior[index] });
    }
    const affectedCells = await engine.updateCellBatch('json_history', [1, 2].map(rowId => ({
        rowId, column: 'value', operation: 'json_patch' as const,
        value: '{"nested":{"new":7},"remove":null}'
    })));
    const modification = {
        modificationType: 'cell_update' as const, targetTable: 'json_history',
        description: 'JSON patch byte restoration', affectedCells
    };
    assert.deepEqual(await readRows(), post);
    await engine.undoModification(modification);
    assert.deepEqual(await readRows(), prior);
    await engine.redoModification(modification);
    assert.deepEqual(await readRows(), post);
}

it('restores JSON patch TEXT bytes through the real WASM engine history path', async () => {
    const bundle = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    const engine = bundle.operations;
    assert.ok(engine instanceof WasmDatabaseEngine);
    try {
        await checkReplay(engine, async () => (await engine.executeQuery(
            'SELECT value FROM json_history ORDER BY id'
        ))[0].rows.map(row => row[0]));
    } finally { engine.shutdown(); }
});

it('restores JSON patch TEXT bytes through bundled native history and independent disk reads', async (t: TestContext) => {
    const root = process.cwd();
    const platform = process.platform === 'darwin'
        ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-macos`
        : process.platform === 'linux'
            ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-linux-gnu`
            : 'x86_64-windows';
    const binary = path.join(root, 'natives', platform, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
    if (!fs.existsSync(binary)) {
        t.skip(`No bundled native runtime for ${process.platform}-${process.arch}`);
        return;
    }
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, '.tmp', 'json-history-bytes-'));
    const file = path.join(directory, 'test.db');
    new DatabaseSync(file).close();
    const bundle = await createNativeDatabaseConnection(vscode.Uri.file(root));
    try {
        const connection = await bundle.establishConnection(vscode.Uri.file(file), 'test.db');
        await checkReplay(connection.databaseOps, async () => {
            const reader = new DatabaseSync(file, { readOnly: true });
            try { return reader.prepare('SELECT value FROM json_history ORDER BY id').all().map(row => row.value); }
            finally { reader.close(); }
        });
    } finally {
        bundle.workerMethods[Symbol.dispose]();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
