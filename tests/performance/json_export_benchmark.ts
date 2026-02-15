
import '../unit/vscode_mock_setup';
import { exportToJson } from '../../src/tableExporter';
import { CellValue } from '../../src/core/types';

function generateData(rowCount: number, colCount: number): { columns: string[], rows: CellValue[][] } {
    const columns = Array.from({ length: colCount }, (_, i) => `col_${i}`);
    const rows: CellValue[][] = [];

    for (let i = 0; i < rowCount; i++) {
        const row: CellValue[] = [];
        for (let j = 0; j < colCount; j++) {
            if (j === 0) {
                row.push(i); // ID
            } else if (j % 3 === 0) {
                row.push(`text_value_${i}_${j}`); // String
            } else if (j % 3 === 1) {
                row.push(Math.random() * 1000); // Number
            } else {
                row.push(null); // Null
            }
        }
        rows.push(row);
    }

    return { columns, rows };
}

function runBenchmark() {
    const ROW_COUNT = 100000;
    const COL_COUNT = 10;

    console.log(`Generating data: ${ROW_COUNT} rows, ${COL_COUNT} columns...`);
    const { columns, rows } = generateData(ROW_COUNT, COL_COUNT);

    console.log('Starting benchmark...');

    if (global.gc) {
        global.gc();
    }

    const startMemory = process.memoryUsage();
    const startTime = performance.now();

    const json = exportToJson(columns, rows);

    const endTime = performance.now();
    const endMemory = process.memoryUsage();

    console.log(`Execution Time: ${(endTime - startTime).toFixed(2)} ms`);
    console.log(`Result length: ${(json.length / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Heap Used Change: ${((endMemory.heapUsed - startMemory.heapUsed) / 1024 / 1024).toFixed(2)} MB`);

    // Check if valid JSON (optional, takes time)
    // JSON.parse(json);
}

runBenchmark();
