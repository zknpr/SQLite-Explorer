import { performance } from 'perf_hooks';

// Type definitions copied from src/core/types.ts
type CellValue = string | number | null | Uint8Array;

function escapeCsvValue(value: CellValue): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Uint8Array) return '[BLOB]';
    const str = String(value);
    // If contains comma, quote, or newline, wrap in quotes and escape internal quotes
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

// Baseline implementation (original)
function exportToCsvBaseline(columns: string[], rows: CellValue[][], includeHeader: boolean = true): string {
  const lines = [];
  if (includeHeader) {
    lines.push(columns.map(escapeCsvValue).join(','));
  }

  rows.forEach(row => {
    lines.push(row.map(escapeCsvValue).join(','));
  });

  return lines.join('\n');
}

// Optimized implementation (Pre-allocated Array)
function exportToCsvOptimized(columns: string[], rows: CellValue[][], includeHeader: boolean = true): string {
  const rowCount = rows.length;
  const totalLines = rowCount + (includeHeader ? 1 : 0);
  const lines = new Array(totalLines);
  let idx = 0;

  if (includeHeader) {
    lines[idx++] = columns.map(escapeCsvValue).join(',');
  }

  for (let i = 0; i < rowCount; i++) {
    lines[idx++] = rows[i].map(escapeCsvValue).join(',');
  }

  return lines.join('\n');
}

// Generate data
const ROWS = 500000;
const COLS = 10;
const columns = Array.from({ length: COLS }, (_, i) => `col_${i}`);
const rows: CellValue[][] = [];
for (let i = 0; i < ROWS; i++) {
    const row: CellValue[] = [];
    for (let j = 0; j < COLS; j++) {
        const rand = Math.random();
        if (rand < 0.1) row.push(null);
        else if (rand < 0.2) row.push(new Uint8Array([1, 2, 3]));
        else if (rand < 0.3) row.push(`Text with "quotes" and, commas`);
        else row.push(`Simple text ${i}-${j}`);
    }
    rows.push(row);
}

console.log(`Generated ${ROWS} rows with ${COLS} columns.`);

// Warmup
console.log('Warming up...');
exportToCsvBaseline(columns, rows.slice(0, 1000));
exportToCsvOptimized(columns, rows.slice(0, 1000));

// Benchmark Baseline
global.gc && global.gc();
const startMemBase = process.memoryUsage().heapUsed;
const startBase = performance.now();
const resBase = exportToCsvBaseline(columns, rows);
const endBase = performance.now();
const endMemBase = process.memoryUsage().heapUsed;
console.log(`Baseline: ${(endBase - startBase).toFixed(2)}ms, Mem Diff: ${((endMemBase - startMemBase) / 1024 / 1024).toFixed(2)} MB`);

// Benchmark Optimized
global.gc && global.gc();
const startMemOpt = process.memoryUsage().heapUsed;
const startOpt = performance.now();
const resOpt = exportToCsvOptimized(columns, rows);
const endOpt = performance.now();
const endMemOpt = process.memoryUsage().heapUsed;
console.log(`Optimized: ${(endOpt - startOpt).toFixed(2)}ms, Mem Diff: ${((endMemOpt - startMemOpt) / 1024 / 1024).toFixed(2)} MB`);

// Verify Correctness
if (resBase !== resOpt) {
    console.error('Results do not match!');
    console.log('Base length:', resBase.length);
    console.log('Opt length:', resOpt.length);
} else {
    console.log('Results match.');
}
