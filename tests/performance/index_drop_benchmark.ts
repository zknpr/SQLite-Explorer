import fs from 'fs';
import path from 'path';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';

async function runBenchmark() {
    console.log('Starting Index Drop Benchmark...');

    try {
        const wasmBinary = fs.readFileSync(path.resolve(__dirname, '../../node_modules/sql.js/dist/sql-wasm.wasm'));
        const engineResult = await createDatabaseEngine({ wasmBinary });
        const db = engineResult.operations as WasmDatabaseEngine;

        const numIndexes = 50;
        const indexNames = Array.from({ length: numIndexes }, (_, i) => `idx_${i}`);

        console.log(`Creating table and ${numIndexes} indexes...`);
        await db.executeQuery(`CREATE TABLE test_table (id INTEGER PRIMARY KEY, col TEXT)`);

        for (const indexName of indexNames) {
            await db.executeQuery(`CREATE INDEX ${indexName} ON test_table(col)`);
        }

        console.log('Starting baseline drop...');

        // Measure unbatched execution (Baseline)
        const startBaseline = Date.now();

        if (indexNames.length > 0) {
            for (const indexName of indexNames) {
                // Inline logic from unbatched
                await db.executeQuery(`DROP INDEX IF EXISTS "${indexName}"`);
            }
        }

        const endBaseline = Date.now();
        console.log(`Unbatched dropping took ${endBaseline - startBaseline}ms`);

        // Verify
        const verifyBaseline = await db.executeQuery("SELECT count(*) as cnt FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'");
        console.log(`Remaining indexes after baseline: ${verifyBaseline[0].values[0][0]}`);

        // Recreate indexes
        for (const indexName of indexNames) {
            await db.executeQuery(`CREATE INDEX ${indexName} ON test_table(col)`);
        }

        console.log('Starting batched drop...');

        // Measure batched execution (New approach)
        const startBatched = Date.now();

        if (indexNames.length > 0) {
            const dropStatements = indexNames.map(name => `DROP INDEX IF EXISTS "${name}";`).join('\n');
            await db.executeQuery(dropStatements);
        }

        const endBatched = Date.now();
        console.log(`Batched dropping took ${endBatched - startBatched}ms`);

        // Verify
        const verifyBatched = await db.executeQuery("SELECT count(*) as cnt FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'");
        console.log(`Remaining indexes after batched: ${verifyBatched[0].values[0][0]}`);

        console.log('---');
        console.log(`Improvement: ${endBaseline - startBaseline}ms -> ${endBatched - startBatched}ms`);

        // Cleanup

    } catch (e) {
        console.error('Benchmark failed:', e);
    }
}

runBenchmark();
