import '../unit/vscode_mock_setup';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import type { ModificationEntry } from '../../src/core/types';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

async function runBenchmark() {
    const bundle = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
    // The native API opens a file URI, so the benchmark uses a unique local database and removes it after disposal.
    const databasePath = path.join(process.cwd(), `native_worker_ddl_batch_${process.pid}_${Date.now()}.sqlite`);

    try {
        const { databaseOps: db } = await bundle.establishConnection(
            vscode.Uri.file(databasePath),
            path.basename(databasePath)
        );

        // create table
        await db.createTable('test_table', [
            { name: 'id', type: 'INTEGER', primaryKey: true, notNull: false },
            ...Array.from({ length: 50 }, (_, i) => ({
                name: `col_${i}`,
                type: 'TEXT',
                primaryKey: false,
                notNull: false
            }))
        ]);

        // insert row
        await db.insertRow('test_table', {
            id: 1,
            ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`col_${i}`, `val_${i}`]))
        });

        const mod = {
            description: 'Drop benchmark columns',
            modificationType: 'column_drop' as const,
            targetTable: 'test_table',
            deletedColumns: Array.from({ length: 50 }, (_, i) => ({
                name: `col_${i}`,
                type: 'TEXT',
                data: [{ rowId: 1, value: `val_${i}` }]
            }))
        } satisfies ModificationEntry;

        console.log('Warming up...');

        // warmup
        await db.undoModification(mod);
        await db.redoModification(mod);

        console.log('Running benchmark...');

        const start = performance.now();
        for (let i = 0; i < 5; i++) {
            await db.undoModification(mod);
            await db.redoModification(mod);
        }
        const end = performance.now();
        console.log(`Time taken: ${(end - start).toFixed(2)}ms`);
    } finally {
        bundle.workerMethods[Symbol.dispose]();
        await fs.rm(databasePath, { force: true });
    }
}

runBenchmark().catch(console.error);
