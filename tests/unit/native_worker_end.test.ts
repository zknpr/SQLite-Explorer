import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createNativeDatabaseConnection, NativeWorkerProcess } from '../../src/nativeWorker';

/**
 * Closing a document stops its native worker. A killed worker never closes
 * its databases, so it leaves a -wal and a -shm beside a WAL database it only
 * read. The worker closes its databases by itself when its input ends, so a
 * connection that left those two files is disposed that way, and the worker
 * is killed only if it has not exited after a grace period. Any other
 * connection is killed at once, which frees its file soonest.
 *
 * Closing the last connection to a WAL database also checkpoints it: the
 * changes waiting in its -wal are written into the main file and the -wal is
 * deleted. A database that was only looked at must stay as it was found, so
 * a connection closes its database only when that changes nothing: the -wal
 * was not there before the open and holds nothing now. Otherwise the worker
 * is killed, as it always was.
 */

const repoRoot = path.resolve(__dirname, '../..');
const workerScript = path.join(repoRoot, 'natives', 'native-worker.js');

function bundledNativeBinary(): string | undefined {
    const platformDir = process.platform === 'darwin'
        ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos')
        : process.platform === 'linux'
            ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu')
            : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-windows' : undefined;
    const expected = process.env.FUZZ_EXPECT_TARGET;
    if (expected && expected !== platformDir) {
        throw new Error(`Expected native target ${expected}, resolved ${platformDir ?? 'none'}`);
    }
    const binary = platformDir && path.join(repoRoot, 'natives', platformDir, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
    if (binary && fs.existsSync(binary)) return binary;
    if (expected) throw new Error(`Missing native runtime ${binary}`);
    return undefined;
}

const binary = bundledNativeBinary();
const skip = binary ? false : `no bundled txiki worker for ${process.platform}-${process.arch}`;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) return false;
        await sleep(10);
    }
    return true;
}

function scratch(name: string): { directory: string; file: string } {
    fs.mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(repoRoot, '.tmp', `worker-end-${name}-`));
    const file = path.join(directory, 'a.db');
    fs.closeSync(fs.openSync(file, 'w'));
    return { directory, file };
}

const remove = (directory: string) => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });

/** The files SQLite keeps beside a database: -wal, -shm, -journal. */
const siblings = (file: string) => fs.readdirSync(path.dirname(file))
    .filter(name => name.startsWith(`${path.basename(file)}-`)).sort();

const WAL_FILL = 'PRAGMA journal_mode = WAL; CREATE TABLE t(a); INSERT INTO t VALUES (1);';

const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every file of the folder with its size and content hash. */
const snapshot = (directory: string) => Object.fromEntries(fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name);
    return [name, `${fs.statSync(file).size} ${digest(file)}`];
}));

async function openWorker(file: string): Promise<NativeWorkerProcess> {
    const worker = new NativeWorkerProcess(binary!, workerScript);
    await worker.start();
    await worker.call('open', [file, false]);
    return worker;
}

describe('stopping a native worker', { skip }, () => {
    it('leaves the -wal and -shm of a WAL database when the worker is killed', async () => {
        const { directory, file } = scratch('kill');
        try {
            const worker = await openWorker(file);
            await worker.call('exec', [WAL_FILL]);
            assert.deepEqual(siblings(file), ['a.db-shm', 'a.db-wal']);
            worker.stop();
            await sleep(300);
            assert.deepEqual(siblings(file), ['a.db-shm', 'a.db-wal']);
        } finally {
            remove(directory);
        }
    });

    it('closes the database and removes them when the worker is ended', async () => {
        const { directory, file } = scratch('end');
        try {
            const worker = await openWorker(file);
            await worker.call('exec', [WAL_FILL]);
            assert.deepEqual(siblings(file), ['a.db-shm', 'a.db-wal']);
            worker.end();
            await assert.rejects(worker.call('query', ['SELECT 1']), /Native worker not running/);
            assert.ok(await waitFor(() => siblings(file).length === 0, 5000), `still present: ${siblings(file).join(' ')}`);

            const reader = await openWorker(file);
            try {
                const result = await reader.call<{ values: unknown[][] }>('query', ['SELECT a FROM t']);
                assert.deepEqual(result.values, [[1]]);
                await reader.call('close');
            } finally {
                reader.stop();
            }
        } finally {
            remove(directory);
        }
    });

    it('closes a WAL database that a disposed connection only read, and leaves no file behind', async () => {
        const { directory, file } = scratch('dispose');
        try {
            // A WAL database with nothing pending: its writer closed it.
            const writer = await openWorker(file);
            await writer.call('exec', [WAL_FILL]);
            await writer.call('close');
            writer.stop();
            assert.deepEqual(siblings(file), []);
            const found = snapshot(directory);

            const native = await createNativeDatabaseConnection(vscode.Uri.file(repoRoot));
            const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'a.db', false);
            assert.deepEqual((await databaseOps.executeQuery('SELECT a FROM t'))[0].rows, [[1]]);
            assert.deepEqual(siblings(file), ['a.db-shm', 'a.db-wal']);
            native.workerMethods[Symbol.dispose]();
            assert.ok(await waitFor(() => siblings(file).length === 0, 5000), `still present: ${siblings(file).join(' ')}`);
            assert.deepEqual(snapshot(directory), found);
        } finally {
            remove(directory);
        }
    });

    it('kills the worker of a database that is not in WAL mode, which has nothing to remove', async () => {
        const { directory, file } = scratch('rollback');
        try {
            const native = await createNativeDatabaseConnection(vscode.Uri.file(repoRoot));
            const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'a.db', false);
            await databaseOps.executeQuery('CREATE TABLE t(a); INSERT INTO t VALUES (1);');
            const found = snapshot(directory);
            // Holds SQLite's write lock: a worker that waited for its input to
            // end would keep it for the grace period.
            const busy = databaseOps.executeQuery(
                'BEGIN IMMEDIATE; SELECT count(*) FROM (WITH RECURSIVE c(n) AS '
                + '(SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 100000000000) SELECT n FROM c);'
            );
            busy.catch(() => { /* rejected when the worker is stopped */ });
            await sleep(200);
            native.workerMethods[Symbol.dispose]();
            const reader = await openWorker(file);
            try {
                const started = Date.now();
                for (;;) {
                    try {
                        await reader.call('exec', ['BEGIN IMMEDIATE; ROLLBACK;']);
                        break;
                    } catch (error) {
                        assert.match(String(error), /locked|busy/i);
                        assert.ok(Date.now() - started < 1500, 'the worker was not killed at once');
                        await sleep(20);
                    }
                }
                await reader.call('close');
            } finally {
                reader.stop();
            }
            assert.deepEqual(Object.keys(snapshot(directory)).filter(name => !name.endsWith('-journal')), Object.keys(found));
        } finally {
            remove(directory);
        }
    });

    it('leaves a WAL database with pending changes exactly as it was found', async () => {
        const { directory, file } = scratch('pending');
        try {
            // Its writer was killed: the row is in the -wal, not in the main file.
            const writer = await openWorker(file);
            await writer.call('exec', [WAL_FILL]);
            writer.stop();
            await sleep(300);
            assert.deepEqual(siblings(file), ['a.db-shm', 'a.db-wal']);
            assert.ok(fs.statSync(`${file}-wal`).size > 0);
            const found = { database: digest(file), wal: digest(`${file}-wal`) };

            const native = await createNativeDatabaseConnection(vscode.Uri.file(repoRoot));
            const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'a.db', false);
            assert.deepEqual((await databaseOps.executeQuery('SELECT a FROM t'))[0].rows, [[1]]);
            await databaseOps.fetchSchema();
            native.workerMethods[Symbol.dispose]();
            // Long enough for a worker that closed its database to have checkpointed it.
            await sleep(1000);
            assert.deepEqual({ database: digest(file), wal: digest(`${file}-wal`) }, found);
        } finally {
            remove(directory);
        }
    });

    it('leaves the changes a connection made to a WAL database in its -wal', async () => {
        const { directory, file } = scratch('edited');
        try {
            const native = await createNativeDatabaseConnection(vscode.Uri.file(repoRoot));
            const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'a.db', false);
            await databaseOps.executeQuery(WAL_FILL);
            const walSize = fs.statSync(`${file}-wal`).size;
            assert.ok(walSize > 0);
            native.workerMethods[Symbol.dispose]();
            await sleep(1000);
            assert.equal(fs.statSync(`${file}-wal`).size, walSize);

            const reader = await openWorker(file);
            try {
                assert.deepEqual((await reader.call<{ values: unknown[][] }>('query', ['SELECT a FROM t'])).values, [[1]]);
            } finally {
                reader.stop();
            }
        } finally {
            remove(directory);
        }
    });

    it('kills an ended worker that is still inside a statement', async () => {
        const { directory, file } = scratch('busy');
        try {
            const worker = await openWorker(file);
            await worker.call('exec', ['CREATE TABLE t(a);']);
            // Holds SQLite's write lock and never reads the end of its input.
            const busy = worker.call('exec', [
                'BEGIN IMMEDIATE; SELECT count(*) FROM (WITH RECURSIVE c(n) AS '
                + '(SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 100000000000) SELECT n FROM c);'
            ]);
            busy.catch(() => { /* rejected when the worker is retired */ });
            await sleep(200);
            const started = Date.now();
            worker.end();
            await assert.rejects(busy, /Native worker stopped/);

            // The lock is released only when the busy process is gone.
            const second = await openWorker(file);
            try {
                let locked = 0;
                for (;;) {
                    try {
                        await second.call('exec', ['BEGIN IMMEDIATE; ROLLBACK;']);
                        break;
                    } catch (error) {
                        locked++;
                        assert.match(String(error), /locked|busy/i);
                        assert.ok(Date.now() - started < 10000, 'the busy worker was never killed');
                        await sleep(50);
                    }
                }
                assert.ok(locked > 0, 'the busy worker must have held the write lock after end()');
                await second.call('close');
            } finally {
                second.stop();
            }
        } finally {
            remove(directory);
        }
    });
});
