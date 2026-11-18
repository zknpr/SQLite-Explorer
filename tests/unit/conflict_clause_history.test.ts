import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import { serializeOperations } from '../../src/core/operation-serializer';
import { importRowsAtomically } from '../../src/core/bulk-import';
import type { DatabaseOperations, ModificationEntry } from '../../src/core/types';

// A schema ON CONFLICT clause applies to every INSERT and UPDATE that does not
// name its own. History-tracked writes say OR ABORT, so a conflicting edit
// fails instead of deleting a row history never captured (REPLACE), skipping
// the write (IGNORE) or ending the enclosing transaction (ROLLBACK).

async function withBackend(
    backend: 'wasm' | 'native',
    setup: string,
    action: (ops: DatabaseOperations) => Promise<void>
) {
    const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    const wasm = opened.operations as WasmDatabaseEngine;
    let native: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
    let directory: string | undefined;
    let invalidated: unknown;
    try {
        await wasm.executeQuery(setup);
        let ops: DatabaseOperations = serializeOperations(wasm);
        if (backend === 'native') {
            fs.mkdirSync('.tmp', { recursive: true });
            directory = fs.mkdtempSync(path.resolve('.tmp/conflict-clause-'));
            const file = path.join(directory, 'fixture.db');
            fs.writeFileSync(file, await wasm.serializeDatabase());
            native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
            const connection = await native.establishConnection(vscode.Uri.file(file), 'conflict', false);
            connection.onDidInvalidate?.((error: unknown) => { invalidated = error; });
            ops = connection.databaseOps;
        }
        await action(ops);
        // A refused statement must leave the connection usable.
        assert.equal(invalidated, undefined);
        await ops.executeQuery('SELECT 1');
    } finally {
        native?.workerMethods[Symbol.dispose](); wasm.shutdown();
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
}

const rows = async (ops: DatabaseOperations, table = 't') => (
    (await ops.executeQuery(`SELECT * FROM ${table} ORDER BY 1`))[0]?.rows ?? []
);
const UNIQUE_REPLACE = "CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT UNIQUE ON CONFLICT REPLACE, v TEXT); " +
    "INSERT INTO t VALUES (1, 'x', 'keep'), (2, 'y', 'other');";
const CONFLICT = /UNIQUE constraint failed|constraint failed/;

for (const backend of ['wasm', 'native'] as const) {
    it(`${backend} import that collides with a UNIQUE ON CONFLICT REPLACE row fails and keeps the row`, async () => {
        await withBackend(backend, UNIQUE_REPLACE, async ops => {
            const before = await rows(ops);
            await assert.rejects(importRowsAtomically(ops, 't', [{ k: 'z', v: 'fine' }, { k: 'x', v: 'new' }], 1 << 20), CONFLICT);
            assert.deepEqual(await rows(ops), before);
        });
    });

    it(`${backend} inserting an existing INTEGER PRIMARY KEY ON CONFLICT REPLACE key fails and keeps the row`, async () => {
        const setup = "CREATE TABLE t (id INTEGER PRIMARY KEY ON CONFLICT REPLACE, v TEXT); INSERT INTO t VALUES (1, 'keep');";
        await withBackend(backend, setup, async ops => {
            await assert.rejects(ops.insertRowWithHistory!('t', { id: 1, v: 'new' }), CONFLICT);
            assert.deepEqual(await rows(ops), [[1, 'keep']]);
        });
    });

    it(`${backend} editing a cell to a UNIQUE ON CONFLICT REPLACE duplicate fails and keeps the other row`, async () => {
        await withBackend(backend, UNIQUE_REPLACE, async ops => {
            const before = await rows(ops);
            await assert.rejects(ops.updateCellBatch('t', [{ rowId: 2, column: 'k', value: 'x' }]), CONFLICT);
            assert.deepEqual(await rows(ops), before);
            await assert.rejects(ops.updateCellBatch('t', [
                { rowId: 2, column: 'v', value: 'changed' },
                { rowId: 2, column: 'k', value: 'x' }
            ]), CONFLICT);
            assert.deepEqual(await rows(ops), before);
        });
    });

    it(`${backend} replacing an oversized cell with a UNIQUE ON CONFLICT REPLACE duplicate fails and keeps the other row`, async () => {
        const setup = "CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT UNIQUE ON CONFLICT REPLACE, v TEXT); " +
            "INSERT INTO t VALUES (1, 'x', 'keep'), (2, 'yyyyyyyyyyyy', 'other');";
        await withBackend(backend, setup, async ops => {
            const before = await rows(ops);
            // An 8-byte edit limit makes the 12-byte value oversized.
            await assert.rejects(
                ops.replaceOversizedCell('t', 2, 'k', 'x', { storageClass: 'text', byteLength: 12 }, 8),
                CONFLICT
            );
            assert.deepEqual(await rows(ops), before);
        });
    });

    it(`${backend} undoing a cell edit whose old value now collides fails and keeps the colliding row`, async () => {
        await withBackend(backend, UNIQUE_REPLACE, async ops => {
            const [cell] = await ops.updateCellBatch('t', [{ rowId: 2, column: 'k', value: 'w' }]);
            const edit: ModificationEntry = {
                modificationType: 'cell_update', targetTable: 't', targetRowId: 2, targetColumn: 'k',
                description: 'Edit k', priorValue: cell.priorValue, newValue: cell.newValue,
                operation: cell.operation, priorState: cell.priorState, postState: cell.postState
            } as ModificationEntry;
            await ops.executeQuery("INSERT INTO t (id, k, v) VALUES (3, 'y', 'external')");
            const before = await rows(ops);
            await assert.rejects(ops.undoModification(edit), CONFLICT);
            assert.deepEqual(await rows(ops), before);
        });
    });

    it(`${backend} redoing an import whose row now collides fails and keeps the colliding row`, async () => {
        await withBackend(backend, UNIQUE_REPLACE, async ops => {
            const imported = await importRowsAtomically(ops, 't', [{ k: 'z', v: 'imported' }], 1 << 20);
            await ops.undoModification(imported);
            await ops.executeQuery("INSERT INTO t (id, k, v) VALUES (9, 'z', 'external')");
            const before = await rows(ops);
            await assert.rejects(ops.redoModification(imported), CONFLICT);
            assert.deepEqual(await rows(ops), before);
        });
    });

    it(`${backend} NULL into a NOT NULL ON CONFLICT REPLACE column fails instead of taking the default`, async () => {
        const setup = "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL ON CONFLICT REPLACE DEFAULT 'd')";
        await withBackend(backend, setup, async ops => {
            await assert.rejects(ops.insertRowWithHistory!('t', { id: 1, v: null }), /NOT NULL constraint failed|constraint failed/);
            assert.deepEqual(await rows(ops), []);
            // Leaving the column out still takes its default.
            await ops.insertRowWithHistory!('t', { id: 2 });
            assert.deepEqual(await rows(ops), [[2, 'd']]);
        });
    });

    it(`${backend} a plain UNIQUE conflict fails and keeps the row (control)`, async () => {
        const setup = "CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT UNIQUE); INSERT INTO t VALUES (1, 'x'), (2, 'y');";
        await withBackend(backend, setup, async ops => {
            await assert.rejects(ops.updateCellBatch('t', [{ rowId: 2, column: 'k', value: 'x' }]), CONFLICT);
            await assert.rejects(importRowsAtomically(ops, 't', [{ k: 'x' }], 1 << 20), CONFLICT);
            assert.deepEqual(await rows(ops), [[1, 'x'], [2, 'y']]);
        });
    });
}
