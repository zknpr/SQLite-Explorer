import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import type { DatabaseOperations, ModificationEntry } from '../../src/core/types';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';

/**
 * Undo history reads a deleted row's values from the native worker, whose
 * responses are capped at 64 MiB a frame. A batch read keeps each value under
 * 48 MiB, so that a response holding earlier cells and one more value stays
 * under the cap. A larger value still fits a response of its own: a row that
 * holds one is deleted and restored as before, and only a value no single
 * response can carry is refused, with the row left in place.
 */

const repoRoot = path.resolve(__dirname, '../..');

function bundledNativeBinary(): string | undefined {
    const platformDir = process.platform === 'darwin'
        ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos')
        : process.platform === 'linux'
            ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu')
            : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-windows' : undefined;
    const expected = process.env.FUZZ_EXPECT_TARGET;
    if (expected && expected !== platformDir) {
        throw new Error(`Expected native target ${expected}, resolved ${platformDir ?? 'none'}`);
    }
    const binary = platformDir && path.join(repoRoot, 'natives', platformDir, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
    if (binary && fs.existsSync(binary)) return binary;
    if (expected) throw new Error(`Missing native runtime ${binary}`);
    return undefined;
}

const skip = bundledNativeBinary() ? false : `no bundled txiki worker for ${process.platform}-${process.arch}`;

async function withTable(megabytes: number, work: (ops: DatabaseOperations) => Promise<void>) {
    fs.mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(repoRoot, '.tmp', 'large-value-history-'));
    const file = path.join(directory, 'large.db');
    fs.closeSync(fs.openSync(file, 'w'));
    const native = await createNativeDatabaseConnection(vscode.Uri.file(repoRoot));
    try {
        const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'large.db', false);
        await databaseOps.executeQuery(
            'CREATE TABLE t(id INTEGER PRIMARY KEY, big BLOB, v TEXT);'
            + `INSERT INTO t VALUES (1, zeroblob(${megabytes * 1000 * 1000}), 'a'), (2, x'00', 'b');`
        );
        await work(databaseOps);
    } finally {
        native.workerMethods[Symbol.dispose]();
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
}

const stored = async (ops: DatabaseOperations) =>
    (await ops.executeQuery('SELECT id, length(big), big = zeroblob(length(big)), v FROM t ORDER BY id'))[0].rows;

describe('native history of a row that holds a large value', { skip }, () => {
    for (const [megabytes, budget] of [[40, undefined], [51, undefined], [58, 300 * 1024 * 1024], [62, 300 * 1024 * 1024]] as const) {
        it(`deletes and restores a row holding a ${megabytes} MB BLOB`, async () => {
            await withTable(megabytes, async ops => {
                const whole = [[1, megabytes * 1000 * 1000, 1, 'a'], [2, 1, 1, 'b']];
                assert.deepEqual(await stored(ops), whole);
                const deletedRows = await ops.deleteRows('t', [1], budget);
                assert.deepEqual(await stored(ops), [whole[1]]);
                const entry: ModificationEntry = {
                    modificationType: 'row_delete', targetTable: 't', description: 'Delete', affectedRowIds: [1], deletedRows
                };
                await ops.undoModification(entry);
                assert.deepEqual(await stored(ops), whole);
                await ops.redoModification(entry);
                assert.deepEqual(await stored(ops), [whole[1]]);
            });
        });
    }

    it('replaces a 58 MB BLOB and restores it', async () => {
        await withTable(58, async ops => {
            const whole = [[1, 58 * 1000 * 1000, 1, 'a'], [2, 1, 1, 'b']];
            const [cell] = await ops.updateCellBatch('t', [{ rowId: 1, column: 'big', value: Uint8Array.from([0]) }]);
            assert.deepEqual(await stored(ops), [[1, 1, 1, 'a'], [2, 1, 1, 'b']]);
            const entry: ModificationEntry = {
                description: 'Replace BLOB', modificationType: 'cell_update', targetTable: 't', targetRowId: 1,
                targetColumn: 'big', priorValue: cell.priorValue, newValue: cell.newValue,
                priorState: cell.priorState, postState: cell.postState, operation: cell.operation
            };
            await ops.undoModification(entry);
            assert.deepEqual(await stored(ops), whole);
            await ops.redoModification(entry);
            assert.deepEqual(await stored(ops), [[1, 1, 1, 'a'], [2, 1, 1, 'b']]);
        });
    });

    it('refuses to delete a row holding a value that no response can carry, and leaves it in place', async () => {
        await withTable(70, async ops => {
            await assert.rejects(
                ops.deleteRows('t', [1], 300 * 1024 * 1024),
                /Cannot read t\.big for undo history: its 70000000-byte blob value is larger than the native engine returns at once/
            );
            assert.deepEqual(await stored(ops), [[1, 70 * 1000 * 1000, 1, 'a'], [2, 1, 1, 'b']]);
            // The connection survived the refusal.
            await ops.updateCell('t', 2, 'v', 'still open');
        });
    });
});
