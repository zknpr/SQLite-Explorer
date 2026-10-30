import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, isNativeAvailable } from '../../src/nativeWorker';
import { HostBridge } from '../../src/hostBridge';
import { ModificationTracker } from '../../src/core/undo-history';
import type { DatabaseOperations, LabeledModification, ModificationEntry } from '../../src/core/types';

// Values whose JS form binds as another class, or decodes to other bytes:
// integral and negative-zero REALs, integers past int32 and 2^53, TEXT that
// is not plain UTF-8. Undoing a column drop must restore each exactly.
const LITERALS = [
    '5.0', '-0.0', '1.5', '7', '3000000000', '1730000000000', '9007199254740993', '-9223372036854775808',
    "CAST(X'FF61' AS TEXT)", "CAST(X'EFBBBF61' AS TEXT)", 'char(55296)', "'a' || char(0) || 'b'", "'12'",
    "X'00FF'", 'NULL'
];

async function seed(ops: DatabaseOperations) {
    await ops.executeQuery('CREATE TABLE t (id INTEGER PRIMARY KEY, keep, n, b BLOB, r REAL)');
    for (const [index, literal] of LITERALS.entries()) {
        await ops.executeQuery(`INSERT INTO t VALUES (${index + 1}, 'k', ${literal}, ${literal}, ${literal})`);
    }
}

/** Storage class and stored bytes of every cell; -0.0 shows as its sign. */
async function contents(ops: DatabaseOperations): Promise<unknown[][]> {
    const cell = (column: string) => (
        `typeof(${column}) AS t_${column}, ` +
        `CASE typeof(${column}) WHEN 'real' THEN printf('%!.17g', ${column}) || CASE WHEN ${column} = 0 AND 1 / ${column} IS NULL ` +
        `AND CAST(${column} AS TEXT) LIKE '-%' THEN '-' ELSE '' END ELSE hex(CAST(${column} AS BLOB)) END AS v_${column}`
    );
    return (await ops.executeQuery(`SELECT id AS id, ${['keep', 'n', 'b', 'r'].map(cell).join(', ')} FROM t ORDER BY id`))[0].rows;
}

function bridgeFor(ops: DatabaseOperations) {
    const recorded: ModificationEntry[] = [];
    const document = {
        uri: vscode.Uri.file('/fixture/fixture.db'), isConnected: true, fileParts: { filename: 'fixture.db' },
        isReadOnlyMode: false, connectionGeneration: 1, databaseOperations: ops, undoMemoryLimitBytes: 64 * 1024 * 1024,
        recordExternalModification: (modification: ModificationEntry) => { recorded.push(modification); }
    };
    return { bridge: new HostBridge({ webviews: new Map(), context: {}, isReadOnly: false } as never, document as never), recorded };
}

async function dropAndUndo(ops: DatabaseOperations) {
    await seed(ops);
    const before = await contents(ops);
    const { bridge, recorded } = bridgeFor(ops);
    await bridge.deleteColumns('t', ['n', 'b', 'r']);
    assert.equal(recorded.length, 1);
    await ops.undoModification(recorded[0]);
    assert.deepEqual(await contents(ops), before);
    await ops.redoModification(recorded[0]);
    await ops.undoModification(recorded[0]);
    assert.deepEqual(await contents(ops), before);
    return { before, modification: recorded[0] };
}

async function withNative(image: Uint8Array | undefined, work: (ops: DatabaseOperations) => Promise<void>) {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/column-drop-exact-'));
    const file = path.join(directory, 'fixture.db');
    if (image) fs.writeFileSync(file, image);
    else fs.closeSync(fs.openSync(file, 'w'));
    const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
    try {
        const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'column-drop-exact', false);
        await work(databaseOps);
    } finally {
        native.workerMethods[Symbol.dispose]();
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
}

async function nativeOrSkip(context: { skip: (message: string) => void }): Promise<boolean> {
    if (await isNativeAvailable(process.cwd())) return true;
    if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
    context.skip('Bundled native runtime unavailable');
    return false;
}

describe('column drop undo restores each cell exactly', () => {
    it('on WebAssembly', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            await dropAndUndo(engine);
        } finally {
            engine.shutdown();
        }
    });

    it('on the native engine', async (context) => {
        if (!await nativeOrSkip(context)) return;
        await withNative(undefined, async ops => { await dropAndUndo(ops); });
    });

    // A column-drop entry is bound to its connection's data_version, so it
    // replays on the engine that recorded it; the hot-exit round trip must
    // keep the storage classes.
    it('after a hot-exit round trip of its history', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            await seed(engine);
            const before = await contents(engine);
            const { bridge, recorded } = bridgeFor(engine);
            await bridge.deleteColumns('t', ['n', 'b', 'r']);
            const tracker = new ModificationTracker<LabeledModification>();
            tracker.record({ ...recorded[0], label: 'Delete Columns' } as LabeledModification);
            const restored = ModificationTracker.deserialize<LabeledModification>(tracker.serialize()).getUncommittedEntries()[0];
            assert.deepEqual(
                restored.deletedColumns?.map(column => column.storageClasses),
                recorded[0].deletedColumns?.map(column => column.storageClasses)
            );
            await engine.undoModification(restored);
            assert.deepEqual(await contents(engine), before);
        } finally {
            engine.shutdown();
        }
    });

    it('keeps restoring history recorded without storage classes as before', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            await engine.executeQuery("CREATE TABLE t (id INTEGER PRIMARY KEY, keep, n); INSERT INTO t VALUES (1, 'k', 7), (2, 'k', 'text'), (3, 'k', NULL)");
            const { bridge, recorded } = bridgeFor(engine);
            await bridge.deleteColumns('t', ['n']);
            const legacy = {
                ...recorded[0],
                deletedColumns: recorded[0].deletedColumns!.map(({ storageClasses: _omitted, ...column }) => ({
                    ...column, data: column.data.map(cell => ({ ...cell, value: cell.value instanceof Uint8Array ? new TextDecoder().decode(cell.value) : cell.value }))
                }))
            };
            await engine.undoModification(legacy);
            assert.deepEqual(
                (await engine.executeQuery('SELECT id, typeof(n) AS t, n FROM t ORDER BY id'))[0].rows,
                [[1, 'integer', 7], [2, 'text', 'text'], [3, 'null', null]]
            );
        } finally {
            engine.shutdown();
        }
    });
});
