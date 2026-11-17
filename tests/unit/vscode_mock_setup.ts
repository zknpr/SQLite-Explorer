
import fs from 'fs';
import Module, { syncBuiltinESMExports } from 'module';
import { mockVscode } from './mocks/vscode';

// Windows keeps a database file undeletable until the process that had it
// open is gone, which is a few milliseconds after a native worker was stopped
// (13 to 26 ms measured). Tests remove their scratch folder right after they
// dispose a connection, so there a recursive removal is tried again for up to
// five seconds. Node's own maxRetries does not cover this: it retries
// "operation not permitted", and Windows reports a held file as "permission
// denied". A file that is still held after that fails the test as before.
// The synchronous form blocks the event loop while it waits, and a worker that
// is asked to close its database (NativeWorkerProcess.end) only hears of it
// when the loop runs: a test whose dispose takes that path removes its folder
// with fs.promises.rm.
if (process.platform === 'win32') {
    const HELD = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);
    const ATTEMPTS = 50;
    const PAUSE_MS = 100;
    const held = (error: unknown, attempt: number): boolean =>
        attempt < ATTEMPTS && HELD.has((error as NodeJS.ErrnoException)?.code ?? '');
    // SQLITE_EXPLORER_TEST_RM_STATS=1 prints, per test file, how many removals
    // had to wait and the longest wait, so a growing hold shows in a lane's log
    // long before it reaches the five seconds that fail a test.
    let retried = 0;
    let longestMs = 0;
    const waited = (attempt: number, started: number): void => {
        if (attempt === 1) return;
        retried++;
        longestMs = Math.max(longestMs, Date.now() - started);
    };
    if (process.env.SQLITE_EXPLORER_TEST_RM_STATS) {
        process.on('exit', () => {
            if (retried > 0) console.error(`[rm-retry] removals that waited: ${retried}, longest wait: ${longestMs} ms`);
        });
    }
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const rmSync = fs.rmSync;
    fs.rmSync = (target, options) => {
        if (!options?.recursive) return rmSync(target, options);
        const started = Date.now();
        for (let attempt = 1; ; attempt++) {
            try {
                rmSync(target, options);
                return waited(attempt, started);
            } catch (error) {
                if (!held(error, attempt)) throw error;
                Atomics.wait(pause, 0, 0, PAUSE_MS);
            }
        }
    };
    const rm = fs.promises.rm;
    fs.promises.rm = async (target, options) => {
        if (!options?.recursive) return rm(target, options);
        const started = Date.now();
        for (let attempt = 1; ; attempt++) {
            try {
                await rm(target, options);
                return waited(attempt, started);
            } catch (error) {
                if (!held(error, attempt)) throw error;
                await new Promise(resolve => setTimeout(resolve, PAUSE_MS));
            }
        }
    };
    syncBuiltinESMExports();
}

// @ts-ignore
const originalLoad = Module._load;

// @ts-ignore
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return mockVscode;
    }
    return originalLoad(request, parent, isMain);
};
