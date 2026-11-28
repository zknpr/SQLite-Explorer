import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, isNativeAvailable } from '../../src/nativeWorker';
import { serializeOperations } from '../../src/core/operation-serializer';
import { estimateUndoMemoryBytes, ModificationTracker } from '../../src/core/undo-history';
import { importRowsAtomically } from '../../src/core/bulk-import';
import type { CellValue, DatabaseOperations, LabeledModification } from '../../src/core/types';

// A tenth of the default sqliteExplorer.maxUndoMemory for a tenth of the
// 100,000 rows an import may hold: the same ratio, ten times faster.
const ROWS = 10_000;
const BUDGET = 52_428_800 / 10;
const SCHEMA = 'CREATE TABLE t (id INTEGER, name TEXT, email TEXT, amount REAL, created TEXT)';

function sourceRows(): Record<string, CellValue>[] {
    // A NULL in every seventh row gives the snapshots two storage-class lists.
    return Array.from({ length: ROWS }, (_, i) => ({
        id: i, name: i % 7 === 0 ? null : 'user_' + i, email: 'user' + i + '@example.com',
        amount: i * 1.5 + 0.25, created: '2026-11-27'
    }));
}

/** Skips a native case where no bundled runtime runs, as the other native tests do. */
async function skipWithoutNative(context: TestContext): Promise<boolean> {
    if (await isNativeAvailable(process.cwd())) return false;
    if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
    context.skip('Bundled native runtime unavailable');
    return true;
}

async function withBackend(backend: 'wasm' | 'native', action: (ops: DatabaseOperations) => Promise<void>) {
    const wasm = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    let native: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
    let directory: string | undefined;
    try {
        await wasm.executeQuery(SCHEMA);
        let ops: DatabaseOperations = serializeOperations(wasm);
        if (backend === 'native') {
            fs.mkdirSync('.tmp', { recursive: true });
            directory = fs.mkdtempSync(path.resolve('.tmp/import-undo-memory-'));
            const file = path.join(directory, 'fixture.db');
            fs.writeFileSync(file, await wasm.serializeDatabase());
            native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
            ops = (await native.establishConnection(vscode.Uri.file(file), 'import-undo-memory', false)).databaseOps;
        }
        await action(ops);
    } finally {
        native?.workerMethods[Symbol.dispose](); wasm.shutdown();
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function tableRows(ops: DatabaseOperations): Promise<unknown[][]> {
    const [result] = await ops.executeQuery('SELECT rowid, id, name, email, amount, created, typeof(id), typeof(amount) FROM t ORDER BY rowid');
    return result?.rows ?? [];
}

it('the tracker shares the equal storage-class lists of an entry it records, and counts it the same after a restore', () => {
    const list = () => [{ column: 'a', storageClass: 'integer' }, { column: 'b', storageClass: 'text' }];
    const deletedRows = Array.from({ length: 1000 }, (_, i) => ({ rowId: i + 1, row: { a: BigInt(i), b: 'x' + i }, storageClasses: list() }));
    // A list of any other shape keeps its own copy.
    deletedRows.push({ rowId: 1001, row: { a: 1000n, b: 'y' }, storageClasses: [{ column: 'a', storageClass: 'integer', note: 1 } as never, list()[1]] });
    const entry = { label: 'Delete 1001 rows', modificationType: 'row_delete', targetTable: 't', deletedRows } as unknown as LabeledModification;
    const text = JSON.stringify(entry, (_key, value) => typeof value === 'bigint' ? String(value) : value);
    const unshared = estimateUndoMemoryBytes(entry);
    const tracker = new ModificationTracker<LabeledModification>(100, unshared);
    tracker.record(entry);
    const live = (tracker as unknown as { currentSize: number }).currentSize;
    assert.equal(live, estimateUndoMemoryBytes(entry));
    assert.ok(live < unshared / 2, `${live} of ${unshared} bytes`);
    assert.equal(new Set(deletedRows.map(row => row.storageClasses)).size, 2);
    assert.equal(JSON.stringify(entry, (_key, value) => typeof value === 'bigint' ? String(value) : value), text);
    const restored = ModificationTracker.deserialize<LabeledModification>(tracker.serialize(), 100, unshared);
    assert.equal((restored as unknown as { currentSize: number }).currentSize, live);
});

it('a backup names each list once, also for an entry kept to revert a save, and restores the lists', () => {
    const list = () => [{ column: 'a', storageClass: 'integer' }, { column: 'b', storageClass: 'text' }];
    const deletedRows = Array.from({ length: 100 }, (_, i) => ({ rowId: i + 1, row: { a: BigInt(i), b: 'x' + i }, storageClasses: list() }));
    deletedRows.push({ rowId: 101, row: { a: 100n, b: 'y' }, storageClasses: [{ column: 'a', storageClass: 'integer', note: 1 } as never, list()[1]] });
    const removed = { label: 'Delete 101 rows', modificationType: 'row_delete', targetTable: 't', deletedRows } as unknown as LabeledModification;
    const text = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item);
    const before = text(removed);
    const tracker = new ModificationTracker<LabeledModification>(100, 1 << 30);
    tracker.record(removed);
    tracker.createCheckpointAt(tracker.getCurrentPosition());
    tracker.stepBack();
    // Recording after undoing past the save keeps the entry to revert it.
    tracker.record({ label: 'Edit', modificationType: 'cell_update', targetTable: 't' } as LabeledModification);
    assert.equal(tracker.getCheckpointRevertSequence().length, 1);
    const backup = tracker.serialize();
    // One shared list, and the list of another shape inline.
    assert.equal(new TextDecoder().decode(backup).split('"storageClass"').length - 1, 2 + 2);
    assert.equal(text(removed), before, 'the backup changed the live entry');
    const restored = ModificationTracker.deserialize<LabeledModification>(backup, 100, 1 << 30);
    const [kept] = restored.getCheckpointRevertSequence();
    assert.equal(text(kept), before);
    assert.equal(new Set(kept.deletedRows!.map(row => row.storageClasses)).size, 2);
    assert.equal((restored as unknown as { currentSize: number }).currentSize, (tracker as unknown as { currentSize: number }).currentSize);
});

it('a backup written with a list in every row, as 1.9.0 wrote them, restores with the lists shared', () => {
    const backup = new TextEncoder().encode(JSON.stringify({
        timeline: [{
            label: 'Import 3 rows', description: 'Import 3 rows into t', modificationType: 'row_insert', targetTable: 't',
            insertedRows: [1, 2, 3].map(i => ({
                rowId: i, row: { a: { __type: 'BigInt', text: String(i) }, b: 'x' + i },
                storageClasses: [{ column: 'a', storageClass: 'integer' }, { column: 'b', storageClass: 'text' }]
            }))
        }],
        checkpointIndex: 0, futureStack: [], revertOnRestore: [], uncommittedEntriesEvicted: false, engineKind: 'wasm'
    }));
    const restored = ModificationTracker.deserialize<LabeledModification>(backup, 100, 1 << 20);
    const [entry] = restored.getUncommittedEntries();
    assert.deepEqual(entry.insertedRows!.map(row => row.row.a), [1n, 2n, 3n]);
    assert.deepEqual(entry.insertedRows![2].storageClasses, [{ column: 'a', storageClass: 'integer' }, { column: 'b', storageClass: 'text' }]);
    assert.equal(new Set(entry.insertedRows!.map(row => row.storageClasses)).size, 1);
    assert.equal((restored as unknown as { currentSize: number }).currentSize, estimateUndoMemoryBytes(entry));
});

it('a backup that names a list it does not hold, or holds a malformed list, does not restore', () => {
    const tracker = new ModificationTracker<LabeledModification>(100, 1 << 20);
    tracker.record({
        label: 'Delete 2 rows', modificationType: 'row_delete', targetTable: 't',
        deletedRows: [1, 2].map(i => ({ rowId: i, row: { a: 'x' }, storageClasses: [{ column: 'a', storageClass: 'text' }] }))
    } as unknown as LabeledModification);
    const payload = JSON.parse(new TextDecoder().decode(tracker.serialize()));
    assert.equal(payload.timeline[0].deletedRows[1].storageClasses, 0);
    const restore = (value: unknown) => ModificationTracker.deserialize<LabeledModification>(new TextEncoder().encode(JSON.stringify(value)), 100, 1 << 20);
    assert.throws(() => restore({ ...payload, timeline: [{ ...payload.timeline[0], deletedRows: [{ ...payload.timeline[0].deletedRows[0], storageClasses: 1 }] }] }), /does not hold/);
    assert.throws(() => restore({ ...payload, timeline: [{ ...payload.timeline[0], deletedRows: [{ ...payload.timeline[0].deletedRows[0], storageClasses: 0.5 }] }] }), /does not hold/);
    assert.throws(() => restore({ ...payload, storageClassLists: [[{ column: 'a' }]] }), /malformed/);
    assert.throws(() => restore({ ...payload, storageClassLists: undefined }), /does not hold/);
});

for (const backend of ['wasm', 'native'] as const) {
    it(`${backend}: an import that fits the undo memory limit is admitted, undone, redone and restored at the size it was admitted at`, async (context) => {
        if (backend === 'native' && await skipWithoutNative(context)) return;
        await withBackend(backend, async ops => {
            const rows = sourceRows();
            const modification = await importRowsAtomically(ops, 't', rows, BUDGET);
            const admitted = estimateUndoMemoryBytes(modification);
            assert.ok(admitted <= BUDGET, `entry of ${admitted} bytes over the ${BUDGET}-byte limit`);
            const imported = await tableRows(ops);
            assert.equal(imported.length, ROWS);

            await ops.undoModification(modification);
            assert.deepEqual(await tableRows(ops), []);
            await ops.redoModification(modification);
            assert.deepEqual(await tableRows(ops), imported);
            assert.equal(estimateUndoMemoryBytes(modification), admitted, 'undo and redo changed the entry');

            // Hot exit: the restored tracker counts the entry as the live one did.
            const tracker = new ModificationTracker<LabeledModification>(100, BUDGET);
            tracker.record(modification);
            const live = (tracker as unknown as { currentSize: number }).currentSize;
            assert.equal(live, admitted);
            const backup = tracker.serialize();
            // The backup holds each of the import's two lists once.
            assert.equal(new TextDecoder().decode(backup).split('"storageClass"').length - 1, 2 * 5);
            const restored = ModificationTracker.deserialize<LabeledModification>(backup, 100, BUDGET);
            assert.equal((restored as unknown as { currentSize: number }).currentSize, live);
            // The restored entry replays, from the undo stack and, after another
            // backup, from the redo stack.
            await ops.undoModification(restored.stepBack()!);
            assert.deepEqual(await tableRows(ops), []);
            const redoTracker = ModificationTracker.deserialize<LabeledModification>(restored.serialize(), 100, BUDGET);
            await ops.redoModification(redoTracker.stepForward()!);
            assert.deepEqual(await tableRows(ops), imported);

            // Admission and the tracker count the same bytes: one byte less
            // than the entry is refused, a few kilobytes more is not.
            await ops.undoModification(modification);
            await assert.rejects(importRowsAtomically(ops, 't', rows, admitted - 1), /sqliteExplorer\.maxUndoMemory/);
            assert.deepEqual(await tableRows(ops), []);
            const again = await importRowsAtomically(ops, 't', rows, admitted + 4096);
            assert.equal(estimateUndoMemoryBytes(again), admitted);
        });
    });

    it(`${backend}: an import over the undo memory limit names the setting and how far it got, and imports nothing`, async (context) => {
        if (backend === 'native' && await skipWithoutNative(context)) return;
        await withBackend(backend, async ops => {
            await assert.rejects(importRowsAtomically(ops, 't', sourceRows(), BUDGET / 20), (error: Error) => {
                assert.match(error.message, /sqliteExplorer\.maxUndoMemory/);
                assert.match(error.message, /\(262,144 bytes\)/);
                assert.match(error.message, /the history of [\d,]+ of its 10,000 rows fit/);
                assert.match(error.message, /Nothing was imported/);
                return true;
            });
            assert.deepEqual(await tableRows(ops), []);
        });
    });
}
