import fs from 'fs';
import path from 'path';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';

async function setupTestDb(db: WasmDatabaseEngine, numIndexes: number) {
    await db.executeQuery(`DROP TABLE IF EXISTS test_table`);
    await db.executeQuery(`CREATE TABLE test_table (id INTEGER PRIMARY KEY, col TEXT)`);
    for (let i = 0; i < numIndexes; i++) {
        await db.executeQuery(`CREATE INDEX idx_${i} ON test_table(col)`);
    }
    const indexNames = Array.from({ length: numIndexes }, (_, i) => `idx_${i}`);
    return indexNames;
}

async function measureUnbatched(db: WasmDatabaseEngine, indexNames: string[]) {
    const start = performance.now();
    for (const indexName of indexNames) {
        await db.executeQuery(`DROP INDEX IF EXISTS "${indexName}"`);
    }
    return performance.now() - start;
}

async function measureBatched(db: WasmDatabaseEngine, indexNames: string[]) {
    const start = performance.now();
    if (indexNames.length > 0) {
        const dropStatements = indexNames.map(name => `DROP INDEX IF EXISTS "${name}";`).join('\n');
        await db.executeQuery(dropStatements);
    }
    return performance.now() - start;
}

async function runBenchmark() {
    console.log('Starting Index Drop Benchmark (Hygienic)...');

    try {
        const wasmBinary = fs.readFileSync(path.resolve(__dirname, '../../node_modules/sql.js/dist/sql-wasm.wasm'));
        const engineResult = await createDatabaseEngine({ wasmBinary } as any);
        const db = engineResult.operations as WasmDatabaseEngine;

        const numIndexes = 50;
        const iterations = 10;

        console.log('Warming up...');
        for (let i = 0; i < 3; i++) {
            let idxs = await setupTestDb(db, numIndexes);
            await measureUnbatched(db, idxs);
            idxs = await setupTestDb(db, numIndexes);
            await measureBatched(db, idxs);
        }

        let unbatchedTotal = 0;
        let batchedTotal = 0;

        console.log(`Running ${iterations} iterations (Alternating)...`);
        for (let i = 0; i < iterations; i++) {
            // Unbatched first
            let idxs = await setupTestDb(db, numIndexes);
            unbatchedTotal += await measureUnbatched(db, idxs);

            // Batched second
            idxs = await setupTestDb(db, numIndexes);
            batchedTotal += await measureBatched(db, idxs);

            // Batched first (reverse order)
            idxs = await setupTestDb(db, numIndexes);
            batchedTotal += await measureBatched(db, idxs);

            // Unbatched second
            idxs = await setupTestDb(db, numIndexes);
            unbatchedTotal += await measureUnbatched(db, idxs);
        }

        const avgUnbatched = unbatchedTotal / (iterations * 2);
        const avgBatched = batchedTotal / (iterations * 2);

        console.log('--- Results ---');
        console.log(`Average Unbatched (${numIndexes} indexes): ${avgUnbatched.toFixed(2)}ms`);
        console.log(`Average Batched (${numIndexes} indexes): ${avgBatched.toFixed(2)}ms`);
        console.log(`Improvement: ${((avgUnbatched - avgBatched) / avgUnbatched * 100).toFixed(2)}%`);

    } catch (e) {
        console.error('Benchmark failed:', e);
    }
}

runBenchmark();
