const { performance } = require('perf_hooks');

const state = {
    tableColumns: Array.from({ length: 100 }, (_, i) => ({ name: `col${i}` })),
    gridData: Array.from({ length: 10000 }, (_, i) => {
        const row = [i * 1000]; // simulate sqlite rowid
        for(let j=0; j<100; j++) row.push(`data${i}_${j}`);
        return row;
    }),
    selectedCells: [],
    selectedColumns: new Set(),
    selectedTableType: 'table'
};

function getRowDataOffset() {
    return state.selectedTableType === 'table' ? 1 : 0;
}

function getRowId(row, rowIdx) {
    if (state.selectedTableType === 'table') {
        return row[0]; // SQLite rowid
    }
    return state.currentPageIndex * state.rowsPerPage + rowIdx;
}

function getCellValue(row, colIdx) {
    return row[colIdx + getRowDataOffset()];
}

const start = 0;
const end = 50;

function runBaseline() {
    const existingSet = new Set();
    state.selectedCells = [];
    state.selectedColumns.clear();

    const t0 = performance.now();
    for (let c = start; c <= end; c++) {
        const colName = state.tableColumns[c].name;
        state.selectedColumns.add(colName);

        for (let r = 0; r < state.gridData.length; r++) {
            if (!existingSet.has(`${r},${c}`)) {
                const rowId = getRowId(state.gridData[r], r);
                const value = getCellValue(state.gridData[r], c);
                state.selectedCells.push({ rowIdx: r, colIdx: c, rowId, value });
                existingSet.add(`${r},${c}`);
            }
        }
    }
    const t1 = performance.now();
    return t1 - t0;
}

function runOptimized() {
    const existingSet = new Set();
    state.selectedCells = [];
    state.selectedColumns.clear();

    const t0 = performance.now();

    for (let c = start; c <= end; c++) {
        const colName = state.tableColumns[c].name;
        state.selectedColumns.add(colName);
    }

    // Outer loop rows, inner loop columns
    for (let r = 0; r < state.gridData.length; r++) {
        const rowData = state.gridData[r];
        const rowId = getRowId(rowData, r);
        for (let c = start; c <= end; c++) {
            if (!existingSet.has(`${r},${c}`)) {
                const value = getCellValue(rowData, c);
                state.selectedCells.push({ rowIdx: r, colIdx: c, rowId, value });
                existingSet.add(`${r},${c}`);
            }
        }
    }
    const t1 = performance.now();
    return t1 - t0;
}

// Warmup
for(let i = 0; i < 5; i++) {
    runBaseline();
    runOptimized();
}

let baseTotal = 0;
let optTotal = 0;
const iterations = 50;

for(let i = 0; i < iterations; i++) {
    if (i % 2 === 0) {
        baseTotal += runBaseline();
        optTotal += runOptimized();
    } else {
        optTotal += runOptimized();
        baseTotal += runBaseline();
    }
}

console.log(`Baseline Avg: ${(baseTotal/iterations).toFixed(2)}ms`);
console.log(`Optimized Avg: ${(optTotal/iterations).toFixed(2)}ms`);
