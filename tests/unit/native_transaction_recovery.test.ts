import './vscode_mock_setup';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it, type TestContext } from 'node:test';
import * as v8 from 'node:v8';
import * as vscode from 'vscode';
import { createNativeDatabaseConnection, NativeWorkerProcess } from '../../src/nativeWorker';
import type { EstablishedDatabaseConnection } from '../../src/connectionTypes';
import { importRowsAtomically } from '../../src/core/bulk-import';
import { runReadSnapshot } from '../../src/core/operation-serializer';
import { InvocationTimeoutError } from '../../src/core/rpc';

async function withNativeDatabase(
    testContext: TestContext,
    operation: (connection: EstablishedDatabaseConnection, file: string) => Promise<void>,
    options: { queryTimeout?: number; fixtureSql?: string } = {}
): Promise<void> {
    const root = process.cwd();
    const platform = process.platform === 'darwin'
        ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-macos`
        : process.platform === 'linux'
            ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-linux-gnu`
            : 'x86_64-windows';
    const binary = path.join(root, 'natives', platform, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
    if (!fs.existsSync(binary)) {
        testContext.skip(`no bundled native runtime for ${process.platform}-${process.arch}`);
        return;
    }
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, '.tmp', 'native-transaction-recovery-'));
    const file = path.join(directory, 'test.db');
    const fixture = new DatabaseSync(file);
    try {
        fixture.exec(`
            PRAGMA journal_mode = DELETE;
            CREATE TABLE markers(value TEXT);
            INSERT INTO markers VALUES('committed');
            CREATE VIEW sample_view AS SELECT value FROM markers;
        ` + (options.fixtureSql ?? ''));
    } finally {
        fixture.close();
    }
    const bundle = await createNativeDatabaseConnection(vscode.Uri.file(root), undefined, undefined, options.queryTimeout);
    try {
        const connection = await bundle.establishConnection(vscode.Uri.file(file), 'test.db');
        await operation(connection, file);
    } finally {
        bundle.workerMethods[Symbol.dispose]();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function independentRows(file: string, sql: string): Record<string, unknown>[] {
    const connection = new DatabaseSync(file, { readOnly: true });
    try {
        return connection.prepare(sql).all().map(row => ({ ...row }));
    } finally {
        connection.close();
    }
}

/** Every request frame the native worker receives, as it decodes them. */
function recordNativeRequestFrames(testContext: TestContext): Array<{ method: string; args: unknown[]; timeoutMs?: number }> {
    const frames: Array<{ method: string; args: unknown[]; timeoutMs?: number }> = [];
    const childProcess = require('node:child_process');
    const spawn = childProcess.spawn;
    testContext.mock.method(childProcess, 'spawn', (...spawnArgs: unknown[]) => {
        const child = spawn(...spawnArgs);
        const write = child.stdin.write.bind(child.stdin);
        let pending = Buffer.alloc(0);
        child.stdin.write = (chunk: Uint8Array, ...rest: unknown[]) => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
                const length = pending.readUInt32BE(0);
                frames.push(v8.deserialize(pending.subarray(4, 4 + length)));
                pending = pending.subarray(4 + length);
            }
            return write(chunk, ...rest);
        };
        return child;
    });
    return frames;
}

it('fails a slow native read at the configured queryTimeout and keeps the connection usable', async testContext => {
    const queryTimeout = 1000;
    const frames = recordNativeRequestFrames(testContext);
    // An endless view, and a table whose generated column costs about a
    // millisecond a row: sorting by it takes many times queryTimeout. The
    // column is added after the rows, since INSERT would compute it.
    const fixtureSql = `
        CREATE VIEW endless AS
            WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c;
        CREATE TABLE heavy(id INTEGER PRIMARY KEY, n INTEGER);
        WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 30000)
        INSERT INTO heavy(n) SELECT i FROM s;
        ALTER TABLE heavy ADD COLUMN cost INTEGER GENERATED ALWAYS AS (length(hex(zeroblob(1000000 + n)))) VIRTUAL;
    `;
    await withNativeDatabase(testContext, async ({ databaseOps: engine }, file) => {
        // The worker's own deadline error, not the host's transport timeout,
        // which stops the worker.
        const workerTimeout = (methods: string) => (error: unknown) => {
            assert.equal(error instanceof InvocationTimeoutError, false, String(error));
            assert.match(String((error as Error).message), new RegExp(
                `^\\[(?:${methods})\\] Query execution timed out after ${queryTimeout}ms$`
            ));
            return true;
        };
        await assert.rejects(engine.fetchTableCount('endless', {}), workerTimeout('query'));
        await assert.rejects(engine.fetchTableData('endless', {
            columns: ['x'], filters: [{ column: 'x', value: 'never' }], limit: 100, offset: 0
        }), workerTimeout('queryPacked|queryNumeric'));
        // A rowid table page reads inside a snapshot savepoint, which must roll back.
        await assert.rejects(engine.fetchTableData('heavy', {
            columns: ['rowid', 'id', 'n', 'cost'], orderBy: 'cost', orderDir: 'DESC', limit: 100, offset: 0
        }), workerTimeout('queryPacked|queryNumeric'));
        await assert.rejects(engine.executeQuery('SELECT count(*) FROM endless'), workerTimeout('query'));

        assert.deepEqual(await engine.fetchTableCount('markers', {}), { count: 1, isExact: true });
        await engine.updateCell('markers', 1, 'value', 'after-timeout');
        assert.deepEqual(independentRows(file, 'SELECT value FROM markers'), [{ value: 'after-timeout' }]);
        const imported = await runReadSnapshot(engine, tx => importRowsAtomically(tx, 'markers', [{ value: 'imported' }], 64 * 1024 * 1024));
        await engine.undoModification(imported);
        assert.deepEqual(independentRows(file, 'SELECT value FROM markers'), [{ value: 'after-timeout' }]);

        // Tracked writes keep the fixed 30 s, per request and per history unit.
        const update = frames.find(frame => frame.method === 'run' && /^UPDATE /.test(String(frame.args[0])));
        assert.equal(update?.timeoutMs, 30000);
        const history = frames.filter(frame => frame.method === 'queryHistoryBatch');
        assert.ok(history.length > 0);
        for (const frame of history) {
            assert.equal(frame.args[2], 30000);
            assert.equal(frame.timeoutMs, 33000);
        }
        // The import's read snapshot commits it with a RELEASE sent through executeQuery.
        const snapshotControl = frames.filter(frame => frame.method === 'query'
            && /^(?:SAVEPOINT|RELEASE|ROLLBACK TO) sqlite_explorer_read_snapshot_/.test(String(frame.args[0])));
        assert.ok(snapshotControl.length >= 2);
        for (const frame of snapshotControl) assert.equal(frame.timeoutMs, 30000, String(frame.args[0]));
    }, { queryTimeout, fixtureSql });
});

it('recovers a native failed commit before a later mutation reports success', async testContext => {
    await withNativeDatabase(testContext, async ({ databaseOps: engine }, file) => {
        const reader = new DatabaseSync(file, { readOnly: true });
        try {
            reader.exec('BEGIN');
            reader.prepare('SELECT * FROM sample_view').all();
            await assert.rejects(engine.dropView('sample_view'), /database is locked/);
            assert.equal((await engine.getViewDefinition('sample_view')).selectSql, 'SELECT value FROM markers');
        } finally {
            reader.close();
        }

        // This call previously resolved inside the abandoned outer savepoint.
        // Its apparent success still held the file locked and vanished on close.
        await engine.dropView('sample_view');
        assert.deepEqual(
            independentRows(file, "SELECT name FROM sqlite_schema WHERE name='sample_view'"),
            []
        );
        assert.deepEqual(independentRows(file, 'PRAGMA quick_check'), [{ quick_check: 'ok' }]);
    });
});

it('preserves a caller transaction across successful and rejected native savepoints', async testContext => {
    await withNativeDatabase(testContext, async ({ databaseOps: engine }, file) => {
        await engine.executeQuery('SAVEPOINT caller');
        await engine.executeQuery("UPDATE markers SET value='caller-pending'");
        await assert.rejects(engine.createView('invalid_view', 'SELECT * FROM missing_source'));
        await engine.createView('child_view', 'SELECT value FROM markers');
        assert.deepEqual((await engine.executeQuery('SELECT value FROM markers'))[0].rows, [['caller-pending']]);
        assert.deepEqual(independentRows(file, 'SELECT value FROM markers'), [{ value: 'committed' }]);
        await engine.executeQuery('ROLLBACK TO caller');
        await engine.executeQuery('RELEASE caller');
        assert.deepEqual(independentRows(file, 'SELECT value FROM markers'), [{ value: 'committed' }]);
        assert.deepEqual(independentRows(file, "SELECT name FROM sqlite_schema WHERE name='child_view'"), []);

        await engine.executeQuery('SAVEPOINT caller_commit');
        await engine.executeQuery("UPDATE markers SET value='caller-committed'");
        await assert.rejects(engine.createView('invalid_view', 'SELECT * FROM missing_source'));
        await engine.executeQuery('RELEASE caller_commit');
        assert.deepEqual(independentRows(file, 'SELECT value FROM markers'), [{ value: 'caller-committed' }]);
    });
});

it('retires a native connection when savepoint ownership metadata is unavailable', async testContext => {
    const actualCall = NativeWorkerProcess.prototype.call;
    for (const value of [undefined, null, 'false', 0]) {
        await testContext.test(`transactionWasActive=${JSON.stringify(value) ?? 'undefined'}`, async nested => {
            const callMock = nested.mock.method(NativeWorkerProcess.prototype, 'call', async function <T>(
                this: NativeWorkerProcess,
                method: string,
                args: unknown[] = [],
                timeoutMs?: number,
                signal?: AbortSignal,
                workerTimeoutMs?: number
            ): Promise<T> {
                const result = await actualCall.call(this, method, args, timeoutMs, signal, workerTimeoutMs);
                if (method === 'run' && String(args[0]).startsWith('SAVEPOINT ')) {
                    return { ...(result as Record<string, unknown>), transactionWasActive: value } as T;
                }
                return result as T;
            });
            try {
                await withNativeDatabase(nested, async ({ databaseOps: engine, onDidInvalidate }, file) => {
                    const invalidations: Error[] = [];
                    const listener = onDidInvalidate?.(error => invalidations.push(error));
                    try {
                        await assert.rejects(engine.createView('new_view', 'SELECT value FROM markers'), /transaction.*recover|ownership/i);
                        assert.equal(invalidations.length, 1);
                        assert.equal((invalidations[0] as Error & { code: string }).code, 'SQLITE_EXPLORER_TRANSACTION_RECOVERY_FAILED');
                        await assert.rejects(engine.executeQuery('SELECT 1'), /transaction.*recover|ownership/i);
                        assert.deepEqual(independentRows(file, "SELECT name FROM sqlite_schema WHERE name='new_view'"), []);
                    } finally {
                        listener?.dispose();
                    }
                });
            } finally {
                callMock.mock.restore();
            }
        });
    }
});

it('retires a native connection when a nested savepoint cannot be recovered', async testContext => {
    const actualCall = NativeWorkerProcess.prototype.call;
    const callMock = testContext.mock.method(NativeWorkerProcess.prototype, 'call', async function <T>(
        this: NativeWorkerProcess,
        method: string,
        args: unknown[] = [],
        timeoutMs?: number,
        signal?: AbortSignal,
        workerTimeoutMs?: number
    ): Promise<T> {
        if (method === 'run' && String(args[0]).startsWith('ROLLBACK TO ')) {
            throw new Error('injected nested rollback failure');
        }
        return await actualCall.call(this, method, args, timeoutMs, signal, workerTimeoutMs) as T;
    });
    try {
        await withNativeDatabase(testContext, async ({ databaseOps: engine, onDidInvalidate }, file) => {
            const invalidations: Error[] = [];
            const listener = onDidInvalidate?.(error => invalidations.push(error));
            try {
                await engine.executeQuery('SAVEPOINT caller');
                await engine.executeQuery("UPDATE markers SET value='must-not-escape'");
                await assert.rejects(
                    engine.createView('invalid_view', 'SELECT * FROM missing_source'),
                    error => {
                        const cause = (error as Error).cause as AggregateError;
                        assert.ok(cause instanceof AggregateError);
                        assert.match(String(cause.errors[0]), /SQL logic error|missing_source/);
                        assert.match(String(cause.errors[1]), /injected nested rollback failure/);
                        return (error as Error & { code: string }).code === 'SQLITE_EXPLORER_TRANSACTION_RECOVERY_FAILED';
                    }
                );
                assert.equal(invalidations.length, 1);
                await assert.rejects(engine.executeQuery('SELECT 1'), error => error === invalidations[0]);
                assert.deepEqual(independentRows(file, 'SELECT value FROM markers'), [{ value: 'committed' }]);
                assert.deepEqual(independentRows(file, "SELECT name FROM sqlite_schema WHERE name='invalid_view'"), []);
            } finally {
                listener?.dispose();
            }
        });
    } finally {
        callMock.mock.restore();
    }
});
