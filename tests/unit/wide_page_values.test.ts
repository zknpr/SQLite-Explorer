import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, isNativeAvailable } from '../../src/nativeWorker';
import type { DatabaseOperations } from '../../src/core/types';

// The grid's page limit (pageSizeForColumns in grid-data.js) is chosen so a
// UUID, the commonest long key, arrives whole. 200 columns and the rowid give
// 1,200 rows a page under the 250,000-value limit; the old 500,000-value
// limit gave 2,500, where every UUID arrived as an 8-character preview.
const COLUMNS = Array.from({ length: 200 }, (_, index) => `c${index}`);
const LOWERED_ROWS = 1200;
const OLD_ROWS = 2500;
const SETUP = `CREATE TABLE u (${COLUMNS.join(', ')}); ` +
    `INSERT INTO u SELECT ${COLUMNS.map(() => "'123e4567-e89b-12d3-a456-' || printf('%012d', n)").join(', ')} ` +
    `FROM (WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${OLD_ROWS}) SELECT n FROM s)`;

async function clippedCells(ops: DatabaseOperations, limit: number) {
    const page = await ops.fetchTableData!('u', { columns: ['rowid', ...COLUMNS], limit, offset: 0 });
    assert.equal(page.rows.length, limit);
    return {
        clipped: Object.values(page.oversizedCells ?? {}).reduce((sum, row) => sum + Object.keys(row).length, 0),
        first: page.rows[0][1]
    };
}

async function assertUuidsArriveWhole(ops: DatabaseOperations) {
    await ops.executeQuery(SETUP);
    assert.deepEqual(await clippedCells(ops, LOWERED_ROWS), { clipped: 0, first: '123e4567-e89b-12d3-a456-000000000001' });
    const old = await clippedCells(ops, OLD_ROWS);
    assert.equal(old.clipped, OLD_ROWS * COLUMNS.length, 'the old page size clipped every UUID');
}

describe('a lowered page of a wide table', () => {
    it('sends 200 columns of UUIDs whole on WebAssembly', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            await assertUuidsArriveWhole(engine);
        } finally {
            engine.shutdown();
        }
    });

    it('sends 200 columns of UUIDs whole on the native engine', async (context) => {
        if (!await isNativeAvailable(process.cwd())) {
            if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
            return context.skip('Bundled native runtime unavailable');
        }
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/wide-page-values-'));
        const file = path.join(directory, 'wide.db');
        fs.closeSync(fs.openSync(file, 'w'));
        const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
        try {
            const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'wide-page-values', false);
            await assertUuidsArriveWhole(databaseOps);
        } finally {
            native.workerMethods[Symbol.dispose]();
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});
