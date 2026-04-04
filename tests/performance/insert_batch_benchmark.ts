import { createDatabaseEngine } from '../../src/core/sqlite-db';
import * as fs from 'fs';
import { performance } from 'perf_hooks';

async function runBenchmark() {
    // We need to pass the wasm binary to createDatabaseEngine
    const wasmPath = './node_modules/sql.js/dist/sql-wasm.wasm';
    let wasmBinary: Buffer;
    try {
        wasmBinary = fs.readFileSync(wasmPath);
    } catch (e) {
        console.error("Could not read wasm binary. Please ensure sql.js is installed.");
        process.exit(1);
    }

    const { operations } = await createDatabaseEngine({
        content: null,
        wasmBinary: wasmBinary,
    });

    await operations.createTable('test_table', [
        { name: 'id', type: 'INTEGER', primaryKey: true },
        { name: 'name', type: 'TEXT' },
        { name: 'value', type: 'INTEGER' }
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
