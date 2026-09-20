import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { parseImport, mapImportRows, importRowsAtomically } from '../../src/core/bulk-import';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import { serializeOperations } from '../../src/core/operation-serializer';
import type { DatabaseOperations } from '../../src/core/types';

it('parses quoted CSV and maps exact text without implicit null or number conversion', () => {
    const parsed = parseImport('\ufeffkey,note\r\n9007199254740993,"line 1\nline ""2"""\r\n2,\r\n', 'csv');
    assert.deepEqual(parsed.columns, ['key', 'note']);
    assert.deepEqual(mapImportRows(parsed, ['id', 'value']), [
        { id: '9007199254740993', value: 'line 1\nline "2"' }, { id: '2', value: '' }
    ]);
    for (const csv of ['id,id\n1,2', 'id,note\n1', 'id\n"unclosed', 'id\n"a"tail']) {
        assert.throws(() => parseImport(csv, 'csv'));
    }
});

it('rejects lossy JSON integers and nested values, and preserves omitted columns', () => {
    const parsed = parseImport('[{"id":"9007199254740993","value":null},{"id":2}]', 'json');
    assert.deepEqual(mapImportRows(parsed, ['id', 'value']), [{ id: '9007199254740993', value: null }, { id: 2 }]);
    assert.throws(() => parseImport('[{"id":9007199254740993}]', 'json'), /quoted string/);
    assert.throws(() => parseImport('[{"value":{}}]', 'json'), /scalar/);
    assert.throws(() => parseImport('[{"value":1e309}]', 'json'), /finite/);
    assert.throws(() => mapImportRows(parsed, ['id', 'id']), /more than once/);
});

for (const backend of ['wasm', 'native'] as const) {
    it(`${backend} bulk import rolls back failures and cancellation, and undoes/redoes as one guarded edit`, async () => {
        const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
        const wasm = opened.operations as WasmDatabaseEngine;
        await wasm.executeQuery("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT UNIQUE DEFAULT 'default')");
        let ops: DatabaseOperations = serializeOperations(wasm);
        let native: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
        let directory: string | undefined;
        try {
            if (backend === 'native') {
                fs.mkdirSync('.tmp', { recursive: true });
                directory = fs.mkdtempSync(path.resolve('.tmp/bulk-import-'));
                const file = path.join(directory, 'fixture.db');
                fs.writeFileSync(file, await wasm.serializeDatabase());
                native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
                ops = (await native.establishConnection(vscode.Uri.file(file), 'bulk-import', false)).databaseOps;
            }
            const rows = [{ id: '9007199254740993', value: 'first' }, { id: 2, value: 'second' }];
            const mod = await importRowsAtomically(ops, 'items', rows, 1024 * 1024);
            const values = async () => (await ops.executeQuery('SELECT CAST(id AS TEXT), value FROM items ORDER BY value'))[0].rows;
            assert.deepEqual(await values(), [['9007199254740993', 'first'], ['2', 'second']]);
            await ops.undoModification(mod);
            assert.deepEqual(await values(), []);
            await ops.redoModification(mod);
            assert.deepEqual(await values(), [['9007199254740993', 'first'], ['2', 'second']]);
            await assert.rejects(importRowsAtomically(ops, 'items', [{ id: 3, value: 'third' }, { id: 4, value: 'first' }], 1024 * 1024), /UNIQUE|constraint/i);
            assert.equal((await values()).length, 2);
            const abort = new AbortController();
            await assert.rejects(importRowsAtomically(ops, 'items', [{ id: 3, value: 'third' }, { id: 4, value: 'fourth' }], 1024 * 1024, abort.signal, () => abort.abort()), /abort/i);
            assert.equal((await values()).length, 2);
            await assert.rejects(importRowsAtomically(ops, 'items', [{ id: 3, value: 'large'.repeat(500) }], 500), /memory|snapshot|limit/i);
            assert.equal((await values()).length, 2);
            await ops.executeQuery("UPDATE items SET value = 'external change' WHERE id = 2");
            await assert.rejects(ops.undoModification(mod), /changed|conflict/i);
            assert.equal((await values()).length, 2, 'guard conflict must not partly undo the import');
            await ops.executeQuery('PRAGMA foreign_keys = ON');
            await ops.executeQuery('CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES nodes(id))');
            const hierarchy = await importRowsAtomically(ops, 'nodes', [{ id: 1, parent_id: null }, { id: 2, parent_id: 1 }], 1024 * 1024);
            await ops.undoModification(hierarchy);
            assert.deepEqual((await ops.executeQuery('SELECT id FROM nodes'))[0].rows, []);
            await ops.redoModification(hierarchy);
            assert.deepEqual((await ops.executeQuery('SELECT id, parent_id FROM nodes ORDER BY id'))[0].rows, [[1, null], [2, 1]]);
        } finally {
            native?.workerMethods[Symbol.dispose]();
            wasm.shutdown();
            if (directory) fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}
