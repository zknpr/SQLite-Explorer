// Run with Node 24 or the installed Code executable in ELECTRON_RUN_AS_NODE mode.
// The wide fixture is read into memory; this benchmark never persists changes.
// node wasm_wide_page_benchmark.cjs <worker.cjs> <sqlite3.wasm> <fixture.db>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const [workerPath, wasmPath, fixturePath] = process.argv.slice(2).map(value => path.resolve(value));
if (!workerPath || !wasmPath || !fixturePath) throw new Error('Expected worker, WASM, and wide-fixture paths');
const wasmBinary = new Uint8Array(fs.readFileSync(wasmPath));
const emit = value => process.stdout.write(JSON.stringify({ platform: process.platform, node: process.version, ...value }) + '\n');

function openWorker() {
    const worker = new Worker(workerPath, { execArgv: [] });
    const pending = new Map();
    let sequence = 0;
    const rejectAll = error => {
        for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
        pending.clear();
    };
    worker.on('error', rejectAll);
    worker.on('exit', code => rejectAll(new Error(`Database worker exited with code ${code}`)));
    worker.on('message', message => {
        if (message.kind !== 'result') return;
        const operation = pending.get(message.correlationId);
        if (!operation) return;
        pending.delete(message.correlationId);
        clearTimeout(operation.timer);
        if (message.errorText !== undefined) operation.reject(new Error(message.errorText));
        else operation.resolve(message.payload);
    });
    function call(methodName, parameters = [], timeout = 60000) {
        const correlationId = `benchmark_${++sequence}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(correlationId); reject(new Error(`${methodName} exceeded ${timeout}ms`)); }, timeout);
            pending.set(correlationId, { resolve, reject, timer });
            worker.postMessage({ kind: 'invoke', correlationId, methodName, parameters });
        });
    }
    return {
        call,
        initialize: () => call('initializeDatabase', ['wide-benchmark.db', {
            filePath: fixturePath, wasmBinary, resourceMap: {}, maxSize: 0,
            readOnlyMode: true, queryTimeout: 30000
        }]),
        close: async () => {
            // A stuck runtime must fail this standalone benchmark, not leave
            // its process behind after the terminal result.
            const watchdog = setTimeout(() => {
                emit({ status: 'FAIL', phase: 'worker-termination', error: 'Worker termination exceeded 10000ms' });
                process.exit(1);
            }, 10000);
            try { await worker.terminate(); }
            finally { clearTimeout(watchdog); }
        }
    };
}

async function run() {
    emit({ status: 'START', workerPath, fixturePath });
    const first = openWorker();
    const timings = [];
    let peakRssBytes = 0;
    let columns;
    let shortQueryMs;
    let terminateMs;
    try {
        await first.initialize();
        columns = ['rowid', ...(await first.call('getTableInfo', ['wide'])).map(column => column.identifier)];
        assert.equal(columns.length, 52);
        for (let cycle = 0; cycle < 10; cycle++) {
            for (const limit of [5000, 10000, 1000, 5000, 100]) {
                const started = performance.now();
                const result = await first.call('fetchTableData', ['wide', { columns, limit, offset: 0, keyset: { mode: 'first' } }]);
                const ms = performance.now() - started;
                assert.equal(result.rows.length, limit);
                assert.equal(result.rows[0].length, 52);
                assert.deepEqual(result.rows[0].slice(0, 4), [1, 1, 'c1-1', 'c2-1']);
                assert.equal(result.rows.at(-1)[51], `c50-${limit}`);
                assert.equal(Object.keys(result.oversizedCells ?? {}).length, 0);
                assert.ok(ms < 10000, `${limit}-row page exceeded the 10s performance gate (${ms.toFixed(1)}ms)`);
                peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
                timings.push({ limit, ms });
            }
        }
        const shortStart = performance.now();
        assert.deepEqual((await first.call('runQuery', ['SELECT 1 AS value'], 5000))[0].rows, [[1]]);
        shortQueryMs = performance.now() - shortStart;
        await first.call('dispose');
        await first.initialize();
        assert.equal((await first.call('fetchTableData', ['wide', { columns, limit: 100, offset: 0 }])).rows.length, 100);
    } finally {
        const terminationStart = performance.now();
        await first.close();
        terminateMs = performance.now() - terminationStart;
    }
    const reopened = openWorker();
    try {
        await reopened.initialize();
        assert.equal((await reopened.call('fetchTableData', ['wide', { columns, limit: 100, offset: 0 }])).rows.length, 100);
        assert.deepEqual((await reopened.call('runQuery', ['SELECT 1 AS value'], 5000))[0].rows, [[1]]);
    } finally {
        await reopened.close();
    }
    const pages = [5000, 10000, 1000, 100].map(limit => {
        const values = timings.filter(value => value.limit === limit).map(value => value.ms).sort((a, b) => a - b);
        return { limit, samples: values.length, medianMs: values[Math.floor(values.length / 2)], maxMs: values.at(-1) };
    });
    emit({ status: 'PASS', requests: timings.length, pages, shortQueryMs, terminateMs, workerReopen: true, peakRssBytes });
}
run().catch(error => { emit({ status: 'FAIL', error: error.message }); process.exitCode = 1; });
