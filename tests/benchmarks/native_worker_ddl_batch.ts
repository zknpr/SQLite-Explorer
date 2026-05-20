import '../unit/vscode_mock_setup';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import * as vscode from 'vscode';
import * as path from 'path';

async function runBenchmark() {
    const bundle = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
    const loadResult = await bundle.loadDatabase({ buffer: new Uint8Array() });
    const db = loadResult.databaseOps;

    // create table
    await db.createTable('test_table', [
        { name: 'id', type: 'INTEGER', primaryKey: true },
        ...Array.from({ length: 50 }, (_, i) => ({ name: `col_${i}`, type: 'TEXT' }))
    ]);

    // insert row
    await db.insertRow('test_table', {
        id: 1,
        ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`col_${i}`, `val_${i}`]))
    });

    const mod = {
        modificationType: 'column_drop' as const,
        targetTable: 'test_table',
        deletedColumns: Array.from({ length: 50 }, (_, i) => ({
            name: `col_${i}`,
            type: 'TEXT',
            data: [{ rowId: 1, value: `val_${i}` }]
        }))
    };

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

    bundle.workerMethods[Symbol.dispose]();
}

runBenchmark().catch(console.error);
