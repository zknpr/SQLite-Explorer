import { createDatabaseEngine } from '../../src/core/sqlite-db';
import { performance } from 'perf_hooks';
import type { ModificationEntry } from '../../src/core/types';

async function runBenchmark() {
    console.log('Initializing database...');
    const { operations: db } = await createDatabaseEngine({
        content: null,
        maxSize: 0,
        readOnlyMode: false
    });

    console.log('Setting up table with 50,000 rows...');
    await db.executeQuery('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)');
    await db.executeQuery('BEGIN TRANSACTION');
    // Accessing private instance for faster setup in benchmark
    const insertStmt = (db as any).instance.prepare('INSERT INTO test (value) VALUES (?)');
    for (let i = 0; i < 50000; i++) {
        insertStmt.run([`val-${i}`]);
    }
    insertStmt.free();
    await db.executeQuery('COMMIT');

    // Prepare Undo Data
    console.log('Preparing undo data...');
    const affectedCells = [];
    for (let i = 1; i <= 50000; i++) {
        affectedCells.push({
            rowId: i,
            columnName: 'value',
            priorValue: `val-${i-1}`, // Restoring to previous value
            newValue: `new-${i-1}`
        });
    }

    const mod: ModificationEntry = {
        modificationType: 'cell_update',
        targetTable: 'test',
        description: 'Batch update',
        affectedCells
    };

    console.log('Starting Undo Benchmark with 50,000 cells...');

    // Warm up
    console.log('Warming up JIT...');
    const warmupMod: ModificationEntry = {
        modificationType: 'cell_update',
        targetTable: 'test',
        description: 'Batch update warmup',
        affectedCells: affectedCells.slice(0, 1000)
    };
    for (let i = 0; i < 5; i++) {
        await db.undoModification(warmupMod);
    }

    let totalUndoTime = 0;
    const NUM_RUNS = 5;

    for (let i = 0; i < NUM_RUNS; i++) {
        const start = performance.now();
        await db.undoModification(mod);
        const end = performance.now();
        totalUndoTime += (end - start);
    }

    console.log(`Average Undo took: ${(totalUndoTime / NUM_RUNS).toFixed(2)}ms`);

    // Verify
    const result = await db.executeQuery('SELECT value FROM test WHERE id = 1');
    if (result[0].rows[0][0] !== 'val-0') {
        console.error('Verification failed! Expected val-0');
    } else {
        console.log('Verification passed.');
    }
}

runBenchmark().catch(console.error);
