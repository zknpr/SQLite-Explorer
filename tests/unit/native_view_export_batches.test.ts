import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createNativeDatabaseConnection, isNativeAvailable, NativeWorkerProcess } from '../../src/nativeWorker';
import { streamTableExport } from '../../src/tableExportStreaming';
import type { DatabaseOperations, ExportOptions } from '../../src/core/types';

// The native engine exports a view through a TEMP spool on its second
// connection, which accepts only the exporter's exact statements. These run
// the batched statements through the bundled worker, where a mocked worker
// could not show that both sides agree on them.
const directories: string[] = [];
after(() => {
    for (const directory of directories) {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

async function exportText(ops: DatabaseOperations, source: string, columns: string[], format: string): Promise<string> {
    const chunks: string[] = [];
    await streamTableExport(
        ops, source, columns,
        { format, includeTableName: false, header: true } as ExportOptions,
        { write: async (chunk: string) => { chunks.push(chunk); } }
    );
    return chunks.join('');
}

describe('native view export through the bundled worker', () => {
    it('reads the spool in batches and writes what the table export writes', async (context) => {
        if (!await isNativeAvailable(process.cwd())) {
            if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
            return context.skip('Bundled native runtime unavailable');
        }
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/native-view-export-'));
        directories.push(directory);
        const file = path.join(directory, 'export.db');
        fs.closeSync(fs.openSync(file, 'w'));
        const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
        context.after(() => native.workerMethods[Symbol.dispose]());
        const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'native-view-export', false);
        await databaseOps.executeQuery('CREATE TABLE notes (id INTEGER PRIMARY KEY, label TEXT, body TEXT, digest BLOB, score)');
        await databaseOps.executeQuery(
            'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400) ' +
            "INSERT INTO notes SELECT i, 'row ' || i || char(233), NULL, randomblob(i % 9), " +
            "CASE i % 4 WHEN 0 THEN NULL WHEN 1 THEN i * 1.5 WHEN 2 THEN 9007199254740993 ELSE 'x' END FROM n"
        );
        // 1.8 MB packed apiece, so twenty of them cannot share one 16 MiB batch.
        await databaseOps.executeQuery('UPDATE notes SET body = hex(zeroblob(450000)) WHERE id BETWEEN 200 AND 219');
        await databaseOps.executeQuery('CREATE VIEW notes_view AS SELECT * FROM notes');

        // The export runs inside a read snapshot with its own operations
        // object, so count the statements where they reach the worker.
        const spoolReads: string[] = [];
        const call = context.mock.method(NativeWorkerProcess.prototype, 'call');
        const columns = ['id', 'label', 'body', 'digest', 'score'];
        for (const format of ['json', 'csv']) {
            call.mock.resetCalls();
            const fromView = await exportText(databaseOps, 'notes_view', columns, format);
            spoolReads.length = 0;
            for (const { arguments: [method, args] } of call.mock.calls) {
                const sql = method === 'queryExportSpool' ? (args as unknown[])[1] : undefined;
                if (typeof sql === 'string' && sql.startsWith('SELECT CAST(rowid AS TEXT)')) spoolReads.push(sql);
            }
            assert.equal(fromView, await exportText(databaseOps, 'notes', columns, format), format);
            const rowQueries = spoolReads.filter(sql => sql.includes('AND rowid <= ?'));
            // 400 rows in runs of at most 128, with the twenty large rows split by bytes.
            assert.ok(rowQueries.length >= 4 && rowQueries.length <= 14, `row queries: ${rowQueries.length}`);
            assert.equal(spoolReads.length, rowQueries.length * 2 + 1, 'one size query per batch and a last empty one');
        }
    });
});
