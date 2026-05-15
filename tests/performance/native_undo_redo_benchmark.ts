import '../unit/vscode_mock_setup'; // Must be first
import * as vsc from 'vscode';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import { performance } from 'perf_hooks';

const mockReporter = {
    sendTelemetryEvent: () => {},
    sendTelemetryErrorEvent: () => {},
    dispose: () => {}
} as any;

async function runBenchmark() {
    console.log('Starting Native Undo/Redo Deletion Benchmark...');

    const extensionUri = vsc.Uri.file(process.cwd());

    try {
        const connectionBundle = await createNativeDatabaseConnection(extensionUri, mockReporter);

        const dbPath = ':memory:';
        const dbUri = vsc.Uri.file(dbPath);

        const { databaseOps } = await connectionBundle.establishConnection(dbUri, 'bench_db');

        const numCols = 50;
        const columns = Array.from({ length: numCols }, (_, i) => `col${i}`);

        console.log(`Creating table with ${numCols} columns...`);
        const createTableSql = `CREATE TABLE test_table (id INTEGER PRIMARY KEY, ${columns.map(c => `${c} TEXT`).join(', ')})`;
        await databaseOps.executeQuery(createTableSql);

        await databaseOps.insertRow('test_table', { id: 1, ...Object.fromEntries(columns.map(c => [c, 'val'])) });

        const mod = {
            modificationType: 'column_drop' as const,
            targetTable: 'test_table',
            deletedColumns: columns.map((col, i) => ({
                name: col,
                type: 'TEXT',
                data: [{ rowId: 1, value: 'val' }]
            }))
        };

        // First do a drop
        await databaseOps.deleteColumns('test_table', columns);

        console.log('Measuring undo/redo of column_drop...');
        const start = performance.now();

        // 1. Undo (Adds columns back)
        await databaseOps.undoModification(mod);

        // 2. Redo (Drops columns again)
        await databaseOps.redoModification(mod);

        const end = performance.now();
        console.log(`Undo + Redo took ${(end - start).toFixed(2)}ms`);

        if (typeof connectionBundle.workerMethods[Symbol.dispose] === 'function') {
            connectionBundle.workerMethods[Symbol.dispose]();
        }
    } catch (e) {
        console.error('Benchmark failed:', e);
    }
}

runBenchmark();
