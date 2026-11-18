import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, isNativeAvailable } from '../../src/nativeWorker';
import { HostBridge } from '../../src/hostBridge';
import type { DatabaseOperations, ModificationEntry } from '../../src/core/types';

// The grid sends a typed whole number as a JS number. Past int32 both
// engines would bind it as a double, which an untyped or BLOB column keeps
// as REAL; edits and added rows must store INTEGER, as the literal does.
async function assertIntegerEdits(ops: DatabaseOperations) {
    await ops.executeQuery("CREATE TABLE t (id INTEGER PRIMARY KEY, a, b BLOB, c TEXT); INSERT INTO t VALUES (1, 'x', 'x', 'x'), (2, 'x', 'x', 'x')");
    const recorded: ModificationEntry[] = [];
    const document = {
        uri: vscode.Uri.file('/fixture/fixture.db'), isConnected: true, fileParts: { filename: 'fixture.db' },
        isReadOnlyMode: false, connectionGeneration: 1, databaseOperations: ops, undoMemoryLimitBytes: 64 * 1024 * 1024,
        recordExternalModification: (modification: ModificationEntry) => { recorded.push(modification); }
    };
    const bridge = new HostBridge({ webviews: new Map(), context: {}, isReadOnly: false } as never, document as never);
    await bridge.updateCell('t', 1, 'a', 1730000000000);
    await bridge.updateCellBatch('t', ['a', 'b', 'c'].map(column => ({ rowId: 2, column, value: 1730000000000 })), 'Paste');
    await bridge.insertRow('t', { id: 3, a: 1730000000000, b: -2147483649, c: 3000000000 });
    const read = async () => (await ops.executeQuery(
        'SELECT id, typeof(a) AS ta, CAST(a AS TEXT) AS a, typeof(b) AS tb, CAST(b AS TEXT) AS b, typeof(c) AS tc, c AS c FROM t ORDER BY id'
    ))[0].rows;
    assert.deepEqual(await read(), [
        [1, 'integer', '1730000000000', 'text', 'x', 'text', 'x'],
        [2, 'integer', '1730000000000', 'integer', '1730000000000', 'text', '1730000000000'],
        [3, 'integer', '1730000000000', 'integer', '-2147483649', 'text', '3000000000']
    ]);
    for (const modification of [...recorded].reverse()) await ops.undoModification(modification);
    assert.deepEqual(await read(), [[1, 'text', 'x', 'text', 'x', 'text', 'x'], [2, 'text', 'x', 'text', 'x', 'text', 'x']]);
}

describe('grid edits of whole numbers past int32', () => {
    it('store INTEGER on WebAssembly', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            await assertIntegerEdits(engine);
        } finally {
            engine.shutdown();
        }
    });

    it('store INTEGER on the native engine', async (context) => {
        if (!await isNativeAvailable(process.cwd())) {
            if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
            return context.skip('Bundled native runtime unavailable');
        }
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/host-integer-edits-'));
        const file = path.join(directory, 'edits.db');
        fs.closeSync(fs.openSync(file, 'w'));
        const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
        try {
            const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'host-integer-edits', false);
            await assertIntegerEdits(databaseOps);
        } finally {
            native.workerMethods[Symbol.dispose]();
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});
