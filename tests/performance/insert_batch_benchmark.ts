import { createDatabaseEngine } from '../../src/core/sqlite-db';
import * as fs from 'fs';
import { performance } from 'perf_hooks';

async function runBenchmark() {
    // We need to pass the wasm binary to createDatabaseEngine
    const wasmPath = './vendor/sql.js/sql-wasm.wasm';
    let wasmBinary: Buffer;
    try {
        wasmBinary = fs.readFileSync(wasmPath);
    } catch (e) {
        console.error("Could not read the vendored sql.js WASM binary.");
        process.exit(1);
    }

    const { operations } = await createDatabaseEngine({
        content: null,
        maxSize: 0,
        wasmBinary: wasmBinary,
    });

    if (!operations) {
        console.error("Failed to initialize database engine.");
        process.exit(1);
    }

    await operations.createTable('test_table', [
        { name: 'id', type: 'INTEGER', primaryKey: true, notNull: false },
        { name: 'name', type: 'TEXT', primaryKey: false, notNull: false },
        { name: 'value', type: 'INTEGER', primaryKey: false, notNull: false }
    ]);

    const numRows = 10000;
    const rows = [];
    for (let i = 0; i < numRows; i++) {
        rows.push({
            name: `Test ${i}`,
            value: i
        });
    }

    console.log(`Starting benchmark for inserting ${numRows} rows...`);
    const start = performance.now();
    await operations.insertRowBatch('test_table', rows);
    const end = performance.now();

    console.log(`Time taken: ${(end - start).toFixed(2)}ms`);
}

runBenchmark();
