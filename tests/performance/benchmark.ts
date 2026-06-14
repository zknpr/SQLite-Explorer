
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';

const TEST_FILE = path.join(__dirname, 'large_test.db');
const FILE_SIZE = 500 * 1024 * 1024; // 500MB

function createLargeFile() {
    const buffer = Buffer.alloc(FILE_SIZE);
    fs.writeFileSync(TEST_FILE, buffer);
}

function deleteLargeFile() {
    if (fs.existsSync(TEST_FILE)) {
        fs.unlinkSync(TEST_FILE);
    }
}

async function runBenchmark() {
    deleteLargeFile();
    console.log('Creating large file...');
    createLargeFile();
    console.log(`Created ${FILE_SIZE / 1024 / 1024}MB test file.`);

    const start = performance.now();

    // Start a timer to check event loop blocking
    let ticks = 0;
    const interval = setInterval(() => {
        ticks++;
    }, 1); // 1ms interval

    try {
        console.log('Starting createDatabaseEngine...');
        await createDatabaseEngine({
            content: null,
            filePath: TEST_FILE,
            maxSize: 0,
        });
    } catch (e: any) {
        // We expect an error because the file is not a valid SQLite database
    }

    clearInterval(interval);
    const end = performance.now();
    const duration = end - start;

    console.log(`Time taken: ${duration.toFixed(2)}ms`);
    console.log(`Event loop ticks: ${ticks}`);

    // If ticks are very low relative to duration, it means blocking occurred.
    if (duration > 100 && ticks < (duration / 10)) {
        console.log("RESULT: BLOCKED (Ticks significantly lower than duration)");
    } else {
        console.log("RESULT: NON-BLOCKING (or fast enough)");
    }

    deleteLargeFile();
}

runBenchmark();
