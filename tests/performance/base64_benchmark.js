const { performance } = require('perf_hooks');

function uint8ArrayToBase64Sync_old(bytes) {
    const CHUNK_SIZE = 32768;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
}

function uint8ArrayToBase64Sync_new(bytes) {
    const CHUNK_SIZE = 32768;
    const numChunks = Math.ceil(bytes.length / CHUNK_SIZE);
    const chunks = new Array(numChunks);

    for (let i = 0, j = 0; i < bytes.length; i += CHUNK_SIZE, j++) {
        const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
        chunks[j] = String.fromCharCode.apply(null, chunk);
    }
    return btoa(chunks.join(''));
}

async function runBenchmark() {
    const memUsageOld = [];
    const memUsageNew = [];

    const size = 150 * 1024 * 1024;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = i % 256;

    global.gc();
    let startMem = process.memoryUsage().heapUsed;
    let start = performance.now();
    let res1 = uint8ArrayToBase64Sync_old(bytes);
    let end = performance.now();
    let endMem = process.memoryUsage().heapUsed;
    console.log(`Old (concat) - Time: ${(end - start).toFixed(2)}ms, Mem: ${((endMem - startMem)/1024/1024).toFixed(2)}MB`);
    res1 = null;

    global.gc();
    startMem = process.memoryUsage().heapUsed;
    start = performance.now();
    let res2 = uint8ArrayToBase64Sync_new(bytes);
    end = performance.now();
    endMem = process.memoryUsage().heapUsed;
    console.log(`New (array) - Time: ${(end - start).toFixed(2)}ms, Mem: ${((endMem - startMem)/1024/1024).toFixed(2)}MB`);
}

runBenchmark().catch(console.error);
