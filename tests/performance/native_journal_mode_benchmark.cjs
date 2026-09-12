// Runs the shipped native protocol without host mocks. The source fixture is
// copied beside itself; no journal-mode mutation reaches the caller's database.
// node native_journal_mode_benchmark.cjs <tjs> <native-worker.js> <fixture.db> [legacy]
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');

const [binary, script, source, legacy] = process.argv.slice(2);
if (!binary || !script || !source) throw new Error('Expected native binary, worker script, and source fixture paths');
const directory = fs.mkdtempSync(path.join(path.dirname(path.resolve(source)), 'journal-mode-benchmark-'));
const file = path.join(directory, 'copy.db');
fs.copyFileSync(source, file);
const worker = spawn(binary, ['run', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const pending = new Map();
let buffered = Buffer.alloc(0);
let sequence = 0;
let readyResolve, readyReject;
const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
const readyTimer = setTimeout(() => readyReject(new Error('Native worker did not become ready')), 10000);
const emit = value => process.stdout.write(JSON.stringify({ platform: process.platform, ...value }) + '\n');
worker.stderr.on('data', chunk => process.stderr.write(chunk));
worker.on('error', error => {
    readyReject(error);
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
});
worker.stdout.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
        const size = buffered.readUInt32BE(0);
        if (size > 64 * 1024 * 1024) throw new Error('Native response exceeds benchmark frame limit');
        if (buffered.length < 4 + size) return;
        const message = v8.deserialize(buffered.subarray(4, 4 + size));
        buffered = buffered.subarray(4 + size);
        if (message.ready) { clearTimeout(readyTimer); readyResolve(); continue; }
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error));
        else entry.resolve(message.result);
    }
});
function call(method, args = []) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 5000);
        pending.set(id, { resolve, reject, timer });
        const payload = v8.serialize({ id, method, args, timeoutMs: 3000 });
        const header = Buffer.alloc(4);
        header.writeUInt32BE(payload.length);
        worker.stdin.write(Buffer.concat([header, payload]));
    });
}
const mode = value => legacy === 'legacy'
    ? call('exec', [`PRAGMA journal_mode = '${value}'`])
    : call('setJournalMode', [value]);

async function run() {
    await ready;
    await call('open', [file, false]);
    await call('exec', ['CREATE TABLE IF NOT EXISTS journal_probe(id INTEGER PRIMARY KEY, value TEXT); INSERT OR IGNORE INTO journal_probe VALUES(1, \'kept\');']);
    const timings = [];
    for (let iteration = 0; iteration < 10; iteration++) {
        const start = performance.now();
        await mode('WAL');
        const page = await call('workspaceQuery', ['SELECT id, value FROM journal_probe', '/*journal_mode_benchmark*/', [], ['id', 'value'], 1000]);
        assert.deepEqual(page.values, [[1, 'kept']]);
        await mode('DELETE');
        assert.equal((await call('query', ['PRAGMA journal_mode'])).values[0][0], 'delete');
        assert.deepEqual((await call('workspaceQuery', ['SELECT id, value FROM journal_probe', '/*journal_mode_benchmark*/', [], ['id', 'value'], 1000])).values, [[1, 'kept']]);
        await call('close');
        await call('open', [file, false]);
        assert.equal((await call('query', ['PRAGMA journal_mode'])).values[0][0], 'delete');
        timings.push(performance.now() - start);
    }
    assert.equal((await call('query', ['PRAGMA quick_check'])).values[0][0], 'ok');
    emit({ status: 'PASS', iterations: timings.length, medianMs: [...timings].sort((a, b) => a - b)[5], maxMs: Math.max(...timings), timings });
}
run().catch(error => { emit({ status: 'FAIL', error: error.message }); process.exitCode = 1; })
    .finally(async () => {
        clearTimeout(readyTimer);
        try { await call('close'); } catch { /* preserve the reported benchmark failure */ }
        const exited = new Promise(resolve => worker.once('exit', resolve));
        worker.kill();
        await exited;
        fs.rmSync(directory, { recursive: true, force: true });
    });
