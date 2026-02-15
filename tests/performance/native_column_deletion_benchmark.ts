
import '../unit/vscode_mock_setup'; // Must be first
import * as vsc from 'vscode';
import * as path from 'path';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import { performance } from 'perf_hooks';

// Mock TelemetryReporter
const mockReporter = {
    sendTelemetryEvent: () => {},
    sendTelemetryErrorEvent: () => {},
    dispose: () => {}
} as any;

async function runBenchmark() {
    console.log('Starting Native Column Deletion Benchmark...');

    // Setup extension URI to current directory
    const extensionUri = vsc.Uri.file(process.cwd());

    try {
        const connectionBundle = await createNativeDatabaseConnection(extensionUri, mockReporter);

        // Use in-memory DB for stable benchmarking without I/O variance
        const dbPath = ':memory:';
        const dbUri = vsc.Uri.file(dbPath);

        console.log(`Creating database at ${dbPath}...`);

        // Establish connection
        const { databaseOps } = await connectionBundle.establishConnection(dbUri, 'bench_db');

        // Setup: Create a table with 50 columns
        const numCols = 50;
        const columns = Array.from({ length: numCols }, (_, i) => `col${i}`);

        console.log(`Creating table with ${numCols} columns...`);
        const createTableSql = `CREATE TABLE test_table (id INTEGER PRIMARY KEY, ${columns.map(c => `${c} TEXT`).join(', ')})`;
        await databaseOps.executeQuery(createTableSql);

        // Insert some dummy data
        await databaseOps.insertRow('test_table', { id: 1, col0: 'val0' });

        // Measure Deletion
        console.log('Deleting columns...');
        const start = performance.now();

        await databaseOps.deleteColumns('test_table', columns);

        const end = performance.now();
        console.log(`Deletion took ${(end - start).toFixed(2)}ms`);

        // Verify deletion
        try {
            const tableInfo = await databaseOps.getTableInfo('test_table');
            console.log(`Remaining columns: ${tableInfo.length} (should be 1 for id)`);
            if (tableInfo.length !== 1) {
                console.error('FAILED: Columns were not deleted correctly.');
            } else {
                console.log('SUCCESS: Columns deleted correctly.');
            }
        } catch (e) {
            console.error('Verification failed:', e);
        }

        // Cleanup
        if (typeof connectionBundle.workerMethods[Symbol.dispose] === 'function') {
            connectionBundle.workerMethods[Symbol.dispose]();
        }

        // Remove temp file if it was a real file (not :memory:)
        const fs = require('fs');
        if (dbPath !== ':memory:' && fs.existsSync(dbPath)) {
            fs.unlinkSync(dbPath);
        }

    } catch (e) {
        console.error('Benchmark failed:', e);
    }
}

runBenchmark();
