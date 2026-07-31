import './vscode_mock_setup';
import { describe, it, mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as v8 from 'node:v8';
import { EventEmitter } from 'node:events';
import * as vscode from 'vscode';
import { isNativeAvailable, NativeWorkerProcess } from '../../src/nativeWorker';
import type { DatabaseOperations } from '../../src/core/types';

const nativeWorkerSource = fs.readFileSync(
    path.resolve(process.cwd(), 'natives', 'native-worker.js'),
    'utf8'
);

function loadNativeWorkerFunction(
    functionName: string,
    parameters: string[]
): (...args: any[]) => any {
    const signature = `function ${functionName}(${parameters.join(', ')})`;
    const escapedSignature = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const functionSource = nativeWorkerSource.match(
        new RegExp(`${escapedSignature} \\{[\\s\\S]*?^\\}`, 'm')
    )?.[0];
    assert.ok(
        functionSource,
        `native worker signature changed; expected ${signature}`
    );
    return Function(`"use strict"; return (${functionSource});`)();
}

interface RecordedNativeCall {
    id: number;
    method: string;
    args: unknown[];
}

type RecordedNativeResponse = { result?: unknown; error?: string };
type RecordedNativeResponder = (call: RecordedNativeCall) => RecordedNativeResponse | Promise<RecordedNativeResponse>;

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function encodeNativeMessage(message: unknown): Buffer {
    // Native worker messages are length-prefixed V8 payloads, matching NativeWorkerProcess.writeMessage.
    const payload = v8.serialize(message);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.byteLength, 0);
    return Buffer.concat([header, payload]);
}

function createRecordingNativeProcess(recordedCalls: RecordedNativeCall[], respondToCall?: RecordedNativeResponder) {
    const mockProcess = new EventEmitter() as any;
    mockProcess.stdout = new EventEmitter();
    mockProcess.stderr = new EventEmitter();
    mockProcess.kill = mock.fn();

    let inputBuffer = Buffer.alloc(0);

    const emitMessage = (message: unknown) => {
        mockProcess.stdout.emit('data', encodeNativeMessage(message));
    };

    const readInboundMessages = () => {
        while (inputBuffer.length >= 4) {
            const payloadLength = inputBuffer.readUInt32BE(0);
            const frameLength = 4 + payloadLength;
            if (inputBuffer.length < frameLength) {
                return;
            }

            const payload = inputBuffer.subarray(4, frameLength);
            inputBuffer = inputBuffer.subarray(frameLength);

            const call = v8.deserialize(payload) as RecordedNativeCall;
            recordedCalls.push(call);

            // Tests can provide per-method native responses, including deferred
            // promises for deterministic interleaving checks; otherwise writes
            // receive a generic success response.
            queueMicrotask(async () => {
                try {
                    const response = await (respondToCall?.(call) ?? { result: { changes: 1, lastInsertRowId: 1 } });
                    emitMessage({ id: call.id, ...response });
                } catch (err) {
                    emitMessage({ id: call.id, error: err instanceof Error ? err.message : String(err) });
                }
            });
        }
    };

    mockProcess.stdin = {
        write: mock.fn((chunk: Buffer) => {
            // NativeWorkerProcess writes the header and payload separately, so buffer until a full frame arrives.
            inputBuffer = Buffer.concat([inputBuffer, Buffer.from(chunk)]);
            readInboundMessages();
            return true;
        })
    };

    queueMicrotask(() => {
        emitMessage({ ready: true });
    });

    return mockProcess;
}

describe('isNativeAvailable', () => {
    let originalPlatform: string;
    let originalArch: string;

    beforeEach(() => {
        originalPlatform = process.platform;
        originalArch = process.arch;
        Object.defineProperty(vscode.env, 'uiKind', { value: 2, writable: true, configurable: true }); // Desktop
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
        Object.defineProperty(process, 'arch', { value: originalArch });
        Object.defineProperty(vscode.env, 'uiKind', { value: 2, writable: true, configurable: true }); // Desktop
        mock.restoreAll();
    });

    it('should return false when UI kind is web', async () => {
        Object.defineProperty(vscode.env, 'uiKind', { value: 1, writable: true, configurable: true }); // Web

        const result = await isNativeAvailable('/ext/path');
        assert.strictEqual(result, false);
    });

    it('should return false when platform is unsupported', async () => {
        Object.defineProperty(process, 'platform', { value: 'freebsd' });

        const result = await isNativeAvailable('/ext/path');
        assert.strictEqual(result, false);
    });

    it('should return false when binary does not exist', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        Object.defineProperty(process, 'arch', { value: 'x64' });

        mock.method(fs.promises, 'access', async () => {
            throw new Error('ENOENT');
        });

        const result = await isNativeAvailable('/ext/path');
        assert.strictEqual(result, false);
    });

    it('should return true when binary exists on linux x64', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        Object.defineProperty(process, 'arch', { value: 'x64' });

        const accessMock = mock.method(fs.promises, 'access', async () => {});

        const result = await isNativeAvailable('/ext/path');
        assert.strictEqual(result, true);

        const expectedPath = path.join('/ext/path', 'natives', 'x86_64-linux-gnu', 'tjs');
        assert.strictEqual(accessMock.mock.calls[0].arguments[0], expectedPath);
    });

    it('should return true when binary exists on linux arm64', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        Object.defineProperty(process, 'arch', { value: 'arm64' });

        const accessMock = mock.method(fs.promises, 'access', async () => {});

        const result = await isNativeAvailable('/ext/path');
        assert.strictEqual(result, true);

        const expectedPath = path.join('/ext/path', 'natives', 'aarch64-linux-gnu', 'tjs');
        assert.strictEqual(accessMock.mock.calls[0].arguments[0], expectedPath);
    });

    it('should return true when binary exists on darwin arm64', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        Object.defineProperty(process, 'arch', { value: 'arm64' });

        const accessMock = mock.method(fs.promises, 'access', async () => {});

        const result = await isNativeAvailable('/ext/path');
        assert.strictEqual(result, true);

        const expectedPath = path.join('/ext/path', 'natives', 'aarch64-macos', 'tjs');
        assert.strictEqual(accessMock.mock.calls[0].arguments[0], expectedPath);
    });

    it('should return true when binary exists on win32', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        Object.defineProperty(process, 'arch', { value: 'x64' });

        const accessMock = mock.method(fs.promises, 'access', async () => {});

        const result = await isNativeAvailable('/ext/path');
        assert.strictEqual(result, true);

        const expectedPath = path.join('/ext/path', 'natives', 'x86_64-windows', 'tjs.exe');
        assert.strictEqual(accessMock.mock.calls[0].arguments[0], expectedPath);
    });
});

describe('createNativeDatabaseConnection', () => {
    let originalPlatform: string;
    let originalArch: string;
    let tempDir: string;
    const child_process = require('node:child_process');

    beforeEach(() => {
        originalPlatform = process.platform;
        originalArch = process.arch;
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
        Object.defineProperty(vscode.env, 'uiKind', { value: 2, writable: true, configurable: true }); // Desktop

        tempDir = fs.mkdtempSync(path.join(__dirname, 'test-native-'));
        const nativesDir = path.join(tempDir, 'natives', 'x86_64-linux-gnu');
        fs.mkdirSync(nativesDir, { recursive: true });
        fs.writeFileSync(path.join(nativesDir, 'tjs'), 'dummy');
        fs.writeFileSync(path.join(tempDir, 'natives', 'native-worker.js'), 'dummy');
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
        fs.rmSync(tempDir, { recursive: true, force: true });
        Object.defineProperty(vscode.env, 'uiKind', { value: 2, writable: true, configurable: true });

        mock.restoreAll();
    });

    async function createRecordingConnection(
        respondToCall?: RecordedNativeResponder,
        outputChannel?: vscode.OutputChannel,
        queryTimeout: number = 30000,
        forceReadOnly: boolean = false
    ): Promise<{
        databaseOps: DatabaseOperations;
        calls: RecordedNativeCall[];
        dispose: () => void;
    }> {
        const calls: RecordedNativeCall[] = [];
        mock.method(child_process, 'spawn', () => createRecordingNativeProcess(calls, respondToCall));

        const { createNativeDatabaseConnection } = require('../../src/nativeWorker');
        const bundle = await createNativeDatabaseConnection(
            { fsPath: tempDir } as any,
            undefined,
            outputChannel,
            queryTimeout
        );
        const connection = await bundle.establishConnection(
            { fsPath: '/db/path.sqlite' } as any,
            'TestDB',
            forceReadOnly
        );

        return {
            databaseOps: connection.databaseOps,
            calls,
            dispose: () => bundle.workerMethods[Symbol.dispose]()
        };
    }

    it('should throw an error with context when database opening fails', async () => {
        let mockProcess: any;
        const EventEmitter = require('node:events').EventEmitter;
        const v8 = require('v8');

        let writeChunks: Buffer[] = [];
        let writeChunksTotalLength = 0;

        let stdinWriteMock = mock.fn((buffer: Buffer) => {
            writeChunks.push(buffer);
            writeChunksTotalLength += buffer.length;

            if (writeChunksTotalLength >= 4) {
                const expectedLength = writeChunks[0].length >= 4 ? writeChunks[0].readUInt32BE(0) : Buffer.concat(writeChunks).readUInt32BE(0);
                const totalNeeded = 4 + expectedLength;

                if (writeChunksTotalLength >= totalNeeded) {
                    const fullBuffer = Buffer.concat(writeChunks);
                    const data = fullBuffer.subarray(4, totalNeeded);
                    const msg = v8.deserialize(data);

                    if (msg.method === 'open') {
                        setTimeout(() => {
                            const errorMsg = Buffer.from(v8.serialize({ id: msg.id, error: 'SQLITE_CANTOPEN: unable to open database file' }));
                            const header = Buffer.alloc(4);
                            header.writeUInt32BE(errorMsg.length, 0);
                            mockProcess.stdout.emit('data', Buffer.concat([header, errorMsg]));
                        }, 10);
                    }

                    const remaining = fullBuffer.subarray(totalNeeded);
                    writeChunks = remaining.length > 0 ? [remaining] : [];
                    writeChunksTotalLength = remaining.length;
                }
            }
            return true;
        });

        mock.method(child_process, 'spawn', () => {
            mockProcess = new EventEmitter() as any;
            mockProcess.stdout = new EventEmitter();
            mockProcess.stderr = new EventEmitter();
            mockProcess.stdin = { write: stdinWriteMock };
            mockProcess.kill = mock.fn();

            setTimeout(() => {
                const readyMsg = Buffer.from(v8.serialize({ id: -1, ready: true }));
                const header = Buffer.alloc(4);
                header.writeUInt32BE(readyMsg.length, 0);
                mockProcess.stdout.emit('data', Buffer.concat([header, readyMsg]));
            }, 10);

            return mockProcess;
        });

        const { createNativeDatabaseConnection } = require('../../src/nativeWorker');
        const extensionUri = { fsPath: tempDir } as any;
        const bundle = await createNativeDatabaseConnection(extensionUri);

        const fileUri = { fsPath: '/db/path.sqlite' } as any;
        await assert.rejects(
            bundle.establishConnection(fileUri, 'TestDB'),
            /Failed to open database "TestDB": SQLITE_CANTOPEN: unable to open database file\. Path: \/db\/path\.sqlite/
        );

        bundle.workerMethods[Symbol.dispose]();
    });

    it('undoes a single json_patch cell by reading current then writing the restored object', async () => {
        // The SELECT response is the current document after the forward edit plus a concurrent key.
        const current = { status: 'published', owner: 'ada', reviewer: 'grace' };
        const connection = await createRecordingConnection((call) => {
            if (call.method === 'query') {
                return { result: { columns: ['payload'], values: [[JSON.stringify(current)]] } };
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        try {
            connection.calls.length = 0;
            await connection.databaseOps.undoModification({
                modificationType: 'cell_update',
                description: 'undo payload',
                targetTable: 'docs',
                targetRowId: 7,
                targetColumn: 'payload',
                priorValue: JSON.stringify({ status: 'draft', owner: 'ada' }),
                newValue: JSON.stringify({ status: 'published' }),
                operation: 'json_patch'
            });

            const queryCall = connection.calls.find(call => call.method === 'query');
            const runCall = connection.calls.find(call => call.method === 'run');
            assert.ok(queryCall, 'expected a SELECT read');
            assert.ok(runCall, 'expected a SET write');

            const [readSql, readParams] = queryCall.args as [string, unknown[]];
            assert.strictEqual(readSql, `SELECT "payload" FROM "docs" WHERE rowid = ?`);
            assert.deepStrictEqual(readParams, [7]);

            const [sql, params] = runCall.args as [string, unknown[]];
            assert.strictEqual(sql, `UPDATE "docs" SET "payload" = ? WHERE rowid = ?`);
            assert.deepStrictEqual(JSON.parse(params[0] as string), {
                status: 'draft',
                owner: 'ada',
                reviewer: 'grace'
            });
            assert.strictEqual(params[1], 7);
        } finally {
            connection.dispose();
        }
    });

    it('value-replaces a single json_patch undo when the current cell is non-object', async () => {
        // A non-object current value makes surgical restore unsafe, but the undo still performs the read.
        const connection = await createRecordingConnection((call) => {
            if (call.method === 'query') {
                return { result: { columns: ['payload'], values: [['plain text']] } };
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        try {
            const prior = JSON.stringify({ status: 'draft' });
            connection.calls.length = 0;
            await connection.databaseOps.undoModification({
                modificationType: 'cell_update',
                description: 'undo payload',
                targetTable: 'docs',
                targetRowId: 7,
                targetColumn: 'payload',
                priorValue: prior,
                newValue: JSON.stringify({ status: 'published' }),
                operation: 'json_patch'
            });

            const queryCall = connection.calls.find(call => call.method === 'query');
            const runCall = connection.calls.find(call => call.method === 'run');
            assert.ok(queryCall, 'expected a SELECT read');
            assert.ok(runCall, 'expected a SET write');
            const [sql, params] = runCall.args as [string, unknown[]];
            assert.strictEqual(sql, `UPDATE "docs" SET "payload" = ? WHERE rowid = ?`);
            assert.deepStrictEqual(params, [prior, 7]);
        } finally {
            connection.dispose();
        }
    });

    it('undoes a batch of json_patch cells with one queryBatch read and one execBatch write', async () => {
        // The read side is batched into one worker round-trip, and the write
        // side remains one execBatch so restored values are applied atomically.
        const currents: Record<number, unknown> = {
            3: { count: 2, stable: 'one', concurrent: 'a' },
            4: { count: 11, stable: 'two', concurrent: 'b' }
        };
        const connection = await createRecordingConnection((call) => {
            if (call.method === 'queryBatch') {
                const [queries] = call.args as [Array<{ sql: string; params: unknown[] }>];
                return {
                    result: {
                        results: queries.map(query => ({
                            columns: ['payload'],
                            values: [[JSON.stringify(currents[Number(query.params[0])])]]
                        }))
                    }
                };
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        try {
            connection.calls.length = 0;
            await connection.databaseOps.undoModification({
                modificationType: 'cell_update',
                description: 'undo batch payloads',
                targetTable: 'docs',
                affectedCells: [
                    {
                        rowId: 3,
                        columnName: 'payload',
                        priorValue: JSON.stringify({ count: 1, stable: 'one' }),
                        newValue: JSON.stringify({ count: 2 }),
                        operation: 'json_patch'
                    },
                    {
                        rowId: 4,
                        columnName: 'payload',
                        priorValue: JSON.stringify({ count: 10, stable: 'two' }),
                        newValue: JSON.stringify({ count: 11 }),
                        operation: 'json_patch'
                    }
                ]
            });

            const queryCalls = connection.calls.filter(call => call.method === 'query');
            const queryBatchCalls = connection.calls.filter(call => call.method === 'queryBatch');
            const batchCall = connection.calls.find(call => call.method === 'execBatch');
            assert.strictEqual(queryCalls.length, 0);
            assert.strictEqual(queryBatchCalls.length, 1);
            assert.ok(batchCall, 'batch json_patch undo must write through one execBatch');

            const [queries] = queryBatchCalls[0].args as [Array<{ sql: string; params: unknown[] }>];
            assert.deepStrictEqual(queries, [
                { sql: `SELECT "payload" FROM "docs" WHERE rowid = ?`, params: [3] },
                { sql: `SELECT "payload" FROM "docs" WHERE rowid = ?`, params: [4] }
            ]);

            const items = (batchCall.args as [Array<{ sql: string; params: unknown[] }>])[0];
            assert.strictEqual(items.length, 2);
            assert.ok(items.every(item => item.sql === `UPDATE "docs" SET "payload" = ? WHERE rowid = ?`));
            assert.deepStrictEqual(JSON.parse(items[0].params[0] as string), {
                count: 1,
                stable: 'one',
                concurrent: 'a'
            });
            assert.deepStrictEqual(JSON.parse(items[1].params[0] as string), {
                count: 10,
                stable: 'two',
                concurrent: 'b'
            });
            assert.strictEqual(items[0].params[1], 3);
            assert.strictEqual(items[1].params[1], 4);
        } finally {
            connection.dispose();
        }
    });

    it('serializes overlapping undoModification and updateCell worker messages', async () => {
        // The undo read is intentionally held open. A public updateCell call
        // started during that read must wait until undo has also written, so the
        // undo read/write sequence remains contiguous at the worker boundary.
        const queryStarted = createDeferred<void>();
        const queryResponse = createDeferred<RecordedNativeResponse>();
        const connection = await createRecordingConnection((call) => {
            if (call.method === 'query') {
                queryStarted.resolve();
                return queryResponse.promise;
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        let undoPromise: Promise<void> | undefined;
        let updatePromise: Promise<void> | undefined;
        try {
            connection.calls.length = 0;
            undoPromise = connection.databaseOps.undoModification({
                modificationType: 'cell_update',
                description: 'undo payload',
                targetTable: 'docs',
                targetRowId: 7,
                targetColumn: 'payload',
                priorValue: JSON.stringify({ status: 'draft', owner: 'ada' }),
                newValue: JSON.stringify({ status: 'published' }),
                operation: 'json_patch'
            });

            await queryStarted.promise;
            updatePromise = connection.databaseOps.updateCell('docs', 7, 'payload', '{"status":"manual"}');
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setImmediate(resolve));

            try {
                assert.deepStrictEqual(
                    connection.calls.map(call => call.method),
                    ['query'],
                    'concurrent updateCell must not write while undo is between read and write'
                );
            } finally {
                queryResponse.resolve({
                    result: {
                        columns: ['payload'],
                        values: [[JSON.stringify({ status: 'published', owner: 'ada', reviewer: 'grace' })]]
                    }
                });
                await Promise.allSettled([undoPromise, updatePromise]);
            }

            assert.deepStrictEqual(connection.calls.map(call => call.method), ['query', 'run', 'run']);
            const undoRun = connection.calls[1];
            const updateRun = connection.calls[2];
            assert.deepStrictEqual(JSON.parse((undoRun.args as [string, unknown[]])[1][0] as string), {
                status: 'draft',
                owner: 'ada',
                reviewer: 'grace'
            });
            assert.deepStrictEqual((updateRun.args as [string, unknown[]])[1], ['{"status":"manual"}', 7]);
        } finally {
            queryResponse.resolve({
                result: {
                    columns: ['payload'],
                    values: [[JSON.stringify({ status: 'published', owner: 'ada' })]]
                }
            });
            if (undoPromise || updatePromise) {
                await Promise.allSettled([undoPromise, updatePromise].filter(Boolean) as Promise<void>[]);
            }
            connection.dispose();
        }
    });

    it('replays single json_patch cell redo through the patch-aware updateCell primitive', async () => {
        const connection = await createRecordingConnection();

        try {
            const patch = JSON.stringify({ meta: { reviewed: true } });
            connection.calls.length = 0;

            await connection.databaseOps.redoModification({
                modificationType: 'cell_update',
                description: 'Patch payload',
                targetTable: 'docs',
                targetRowId: 7,
                targetColumn: 'payload',
                newValue: patch,
                operation: 'json_patch'
            });

            assert.strictEqual(connection.calls.length, 1);
            const call = connection.calls[0];
            assert.strictEqual(call.method, 'run');

            const [sql, params] = call.args as [string, unknown[]];
            assert.strictEqual(
                sql,
                `UPDATE "docs" SET "payload" = json_patch(COALESCE("payload", '{}'), ?) WHERE rowid = ?`
            );
            assert.notStrictEqual(sql, `UPDATE "docs" SET "payload" = ? WHERE rowid = ?`);
            assert.deepStrictEqual(params, [patch, 7]);
        } finally {
            connection.dispose();
        }
    });

    it('replays batch json_patch cell redo through operation-aware updateCellBatch', async () => {
        const connection = await createRecordingConnection();

        try {
            const firstPatch = JSON.stringify({ status: 'reviewed' });
            const secondPatch = JSON.stringify({ status: 'approved' });
            connection.calls.length = 0;

            await connection.databaseOps.redoModification({
                modificationType: 'cell_update',
                description: 'Batch patch payloads',
                targetTable: 'docs',
                affectedCells: [
                    { rowId: 3, columnName: 'payload', newValue: firstPatch, operation: 'json_patch' },
                    { rowId: 4, columnName: 'payload', newValue: secondPatch, operation: 'json_patch' },
                    { rowId: 5, columnName: 'title', newValue: 'Plain title' }
                ]
            });

            assert.strictEqual(connection.calls.length, 1);
            const call = connection.calls[0];
            assert.strictEqual(call.method, 'execBatch');

            const batch = call.args[0] as {
                sql: string;
                paramsList?: unknown[][];
                params?: unknown[];
            }[];

            assert.strictEqual(batch.length, 2);
            // COALESCE so a batch patch on a NULL JSON cell applies to '{}' instead of
            // returning NULL — must match single-cell updateCell and both WASM json_patch sites.
            assert.strictEqual(
                batch[0].sql,
                `UPDATE "docs" SET "payload" = json_patch(COALESCE("payload", '{}'), ?) WHERE rowid = ?`
            );
            assert.notStrictEqual(
                batch[0].sql,
                `UPDATE "docs" SET "payload" = json_patch("payload", ?) WHERE rowid = ?`
            );
            assert.deepStrictEqual(batch[0].paramsList, [[firstPatch, 3], [secondPatch, 4]]);
            assert.strictEqual(batch[1].sql, `UPDATE "docs" SET "title" = ? WHERE rowid = ?`);
            assert.deepStrictEqual(batch[1].paramsList, [['Plain title', 5]]);
        } finally {
            connection.dispose();
        }
    });

    it('replays column_drop redo by dropping recorded dependent indexes first', async () => {
        const connection = await createRecordingConnection();

        try {
            connection.calls.length = 0;

            await connection.databaseOps.redoModification({
                modificationType: 'column_drop',
                description: 'Drop indexed payload',
                targetTable: 'docs',
                deletedColumns: [{ name: 'payload', type: 'TEXT', data: [] }],
                droppedIndexes: ['idx_docs_payload']
            });

            assert.strictEqual(connection.calls.length, 1);
            const call = connection.calls[0];
            assert.strictEqual(call.method, 'execBatch');

            const batch = call.args[0] as { sql: string }[];
            assert.deepStrictEqual(
                batch.map(item => item.sql),
                [
                    `DROP INDEX IF EXISTS "idx_docs_payload"`,
                    `ALTER TABLE "docs" DROP COLUMN "payload"`
                ]
            );
        } finally {
            connection.dispose();
        }
    });

    it('terminates line-comment view bodies before native wrapped compile and preview queries', async () => {
        const body = 'SELECT MAX(quantity) AS m FROM inventory -- rollup of stock';
        const connection = await createRecordingConnection(call => {
            if (call.method === 'query') {
                const sql = String(call.args[0]);
                if (sql.startsWith('PRAGMA table_info')) {
                    return { result: { columns: ['cid', 'name'], values: [[0, 'm']] } };
                }
                return { result: { columns: [], values: [] } };
            }
            if (call.method === 'querySingle') {
                return { result: { columns: [], values: [] } };
            }
            if (call.method === 'queryBounded') {
                return { result: { columns: ['m'], values: [[9]] } };
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        try {
            connection.calls.length = 0;

            await connection.databaseOps.validateViewDefinition('inventory_rollup', body);
            const preview = await connection.databaseOps.previewViewDefinition(
                'inventory_rollup',
                body,
                10
            );

            assert.deepStrictEqual(preview.headers, ['m']);
            assert.deepStrictEqual(preview.rows, [[9]]);
            const createCalls = connection.calls.filter(call => call.method === 'runSingle');
            assert.strictEqual(createCalls.length, 2);
            assert.ok(String(createCalls[0].args[0]).includes(`${body}\n/*sqlite_explorer_boundary_`));
            assert.ok(String(createCalls[1].args[0]).includes(`${body}\n/*sqlite_explorer_boundary_`));
            assert.strictEqual(createCalls[0].args[3], String(createCalls[0].args[0]).split('\n').at(-1));
            assert.strictEqual(createCalls[1].args[3], String(createCalls[1].args[0]).split('\n').at(-1));
            assert.strictEqual(connection.calls.filter(call => call.method === 'queryBounded').length, 1);
        } finally {
            connection.dispose();
        }
    });

    it('validates with the disposable CREATE VIEW and rolls it back on rejection', async () => {
        const connection = await createRecordingConnection(call => {
            if (call.method === 'query') {
                return { result: { columns: ['sql'], values: [] } };
            }
            if (call.method === 'runSingle' && String(call.args[1]).includes('SELECT ? AS value')) {
                return { error: 'parameters are not allowed in views' };
            }
            return { result: { columns: [], values: [] } };
        });

        try {
            connection.calls.length = 0;
            await assert.rejects(
                connection.databaseOps.validateViewDefinition('parameter_view', 'SELECT ? AS value'),
                /parameters are not allowed in views/
            );

            const calls = connection.calls.map(call => ({
                method: call.method,
                sql: String(call.method === 'runSingle' ? call.args[1] : call.args[0])
            }));
            assert.match(calls[1].sql, /^SAVEPOINT "sp_validate_view_/);
            assert.strictEqual(calls[2].method, 'runSingle');
            assert.match(calls[2].sql, /^CREATE VIEW "parameter_view" AS SELECT \? AS value$/);
            assert.match(calls[3].sql, /^ROLLBACK TO "sp_validate_view_/);
            assert.match(calls[4].sql, /^RELEASE "sp_validate_view_/);
        } finally {
            connection.dispose();
        }
    });

    it('rejects native validation and preview before DDL on a read-only connection', async () => {
        const connection = await createRecordingConnection(
            undefined,
            undefined,
            30000,
            true
        );
        try {
            const callsBefore = connection.calls.length;
            await assert.rejects(
                connection.databaseOps.validateViewDefinition('read_only_view', 'SELECT 1'),
                /View validation is unavailable because the database is read-only/
            );
            await assert.rejects(
                connection.databaseOps.previewViewDefinition('read_only_view', 'SELECT 1', 10),
                /View preview is unavailable because the database is read-only/
            );
            assert.deepStrictEqual(
                connection.calls.slice(callsBefore),
                [],
                'read-only validation and preview must not reach the native worker'
            );
        } finally {
            connection.dispose();
        }
    });

    it('returns preview metadata for zero rows and duplicate aliases', async () => {
        let currentBody = '';
        const connection = await createRecordingConnection(call => {
            if (call.method === 'runSingle') {
                currentBody = String(call.args[1]);
            }
            if (call.method === 'querySingle') {
                return { result: { columns: [], values: [] } };
            }
            if (call.method === 'query' && String(call.args[0]).startsWith('PRAGMA table_info')) {
                return {
                    result: {
                        columns: ['cid', 'name'],
                        values: [[0, 'x'], [1, 'x:1']]
                    }
                };
            }
            if (call.method === 'queryBounded') {
                const values = currentBody.includes('WHERE 0') ? [] : [[1, 2]];
                return { result: { columns: ['x', 'x:1'], values } };
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        try {
            const empty = await connection.databaseOps.previewViewDefinition(
                'preview_empty',
                'SELECT 1 AS x, 2 AS x WHERE 0',
                10
            );
            assert.deepStrictEqual(empty.headers, ['x', 'x:1']);
            assert.deepStrictEqual(empty.rows, []);

            const duplicate = await connection.databaseOps.previewViewDefinition(
                'preview_duplicate',
                'SELECT 1 AS x, 2 AS x',
                10
            );
            assert.deepStrictEqual(duplicate.headers, ['x', 'x:1']);
            assert.deepStrictEqual(duplicate.rows, [[1, 2]]);
        } finally {
            connection.dispose();
        }
    });

    it('propagates the configured timeout through the native preview query', async () => {
        const connection = await createRecordingConnection(call => {
            if (call.method === 'query' && String(call.args[0]).startsWith('PRAGMA table_info')) {
                return { result: { columns: ['cid', 'name'], values: [[0, 'value']] } };
            }
            if (call.method === 'queryBounded') {
                assert.strictEqual(call.args[5], 25);
                return { error: 'Query execution timed out after 25ms' };
            }
            return { result: { columns: [], values: [] } };
        }, undefined, 25);

        try {
            await assert.rejects(
                connection.databaseOps.previewViewDefinition('slow_preview', 'SELECT 1', 10),
                /Query execution timed out after 25ms/
            );
        } finally {
            connection.dispose();
        }
    });

    it('logs a failed savepoint rollback through the extension output channel', async () => {
        const outputLines: string[] = [];
        const outputChannel = {
            appendLine(value: string) {
                outputLines.push(value);
            }
        } as vscode.OutputChannel;
        const warnMock = mock.method(console, 'warn', () => {});
        const connection = await createRecordingConnection(call => {
            const sql = String(call.args[0]);
            if (call.method === 'runSingle' && String(call.args[1]).startsWith('CREATE VIEW')) {
                return { error: 'create failed' };
            }
            if (call.method === 'run' && sql.startsWith('ROLLBACK TO')) {
                return { error: 'rollback failed' };
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        }, outputChannel);

        try {
            await assert.rejects(
                connection.databaseOps.createView('broken view', 'SELECT 1'),
                /create failed/
            );
            assert.strictEqual(warnMock.mock.calls.length, 0);
            assert.deepStrictEqual(outputLines, [
                '[NativeWorker] Failed to rollback native savepoint (createView): rollback failed'
            ]);
        } finally {
            connection.dispose();
        }
    });

    it('rejects a preview with a smuggled trailing statement before querying it', async () => {
        const body = 'SELECT 1) LIMIT 1; DROP TABLE preview_sentinel; --';
        const connection = await createRecordingConnection(call => {
            if (call.method === 'runSingle' && String(call.args[1]).includes('DROP TABLE')) {
                return { error: 'Exactly one SQL statement is required' };
            }
            return { result: { columns: [], values: [] } };
        });

        try {
            connection.calls.length = 0;

            await assert.rejects(
                connection.databaseOps.previewViewDefinition('unsafe_preview', body, 10),
                /Exactly one SQL statement is required/
            );

            assert.strictEqual(connection.calls.some(call => call.method === 'queryBounded'), false);
        } finally {
            connection.dispose();
        }
    });

    it('preserves a duplicate explicit view column list through native replacement', async () => {
        let currentViewSql = 'CREATE VIEW "duplicate names" (a, a) AS SELECT 1, 2';
        const connection = await createRecordingConnection(call => {
            if (call.method === 'queryBatch') {
                const [queries] = call.args as [Array<{ sql: string }>];
                return {
                    result: {
                        results: queries.map(query => {
                            if (query.sql.includes("type = 'view'")) {
                                return { columns: ['sql'], values: [[currentViewSql]] };
                            }
                            if (query.sql.includes("type = 'trigger'")) {
                                return { columns: ['name', 'sql'], values: [] };
                            }
                            if (query.sql.startsWith('PRAGMA table_info')) {
                                return {
                                    columns: ['cid', 'name'],
                                    values: [[0, 'a'], [1, 'a:1']]
                                };
                            }
                            return { columns: [], values: [] };
                        })
                    }
                };
            }
            if (call.method === 'runSingle') {
                const sql = String(call.args[1]);
                if (sql.startsWith('CREATE VIEW "duplicate names"')) {
                    currentViewSql = sql;
                }
            }
            return { result: { columns: [], values: [] } };
        });

        try {
            connection.calls.length = 0;

            await connection.databaseOps.editView('duplicate names', 'SELECT 3, 4', true);

            const createCall = connection.calls.find(call => (
                call.method === 'runSingle'
                && String(call.args[1]).startsWith('CREATE VIEW "duplicate names"')
            ));
            assert.strictEqual(
                createCall?.args[1],
                'CREATE VIEW "duplicate names" (a, a) AS SELECT 3, 4'
            );
        } finally {
            connection.dispose();
        }
    });

    it('rolls back a native edit if the stored SELECT body differs from the submitted SQL', async () => {
        const submittedBody = `SELECT
    o.created_at,
    MAX(oi.price) AS max_item_price
FROM orders o
LEFT JOIN order_items oi ON o.id = oi.order_id`;
        let currentViewSql = 'CREATE VIEW "order_summary" AS SELECT o.created_at FROM orders o';
        const connection = await createRecordingConnection(call => {
            if (call.method === 'queryBatch') {
                return {
                    result: {
                        results: [
                            { columns: ['sql'], values: [[currentViewSql]] },
                            { columns: ['name', 'sql'], values: [] }
                        ]
                    }
                };
            }
            if (
                call.method === 'runSingle'
                && String(call.args[1]).startsWith('CREATE VIEW "order_summary"')
            ) {
                currentViewSql = `CREATE VIEW "order_summary" AS SELECT
    o.created_at
    MAX
FROM orders o`;
            }
            return { result: { columns: [], values: [] } };
        });

        try {
            connection.calls.length = 0;
            await assert.rejects(
                connection.databaseOps.editView('order_summary', submittedBody, true),
                /stored a view definition different from the submitted SQL/
            );

            const transactionSql = connection.calls
                .filter(call => call.method === 'run')
                .map(call => String(call.args[0]));
            assert.ok(transactionSql.some(sql => sql.startsWith('ROLLBACK TO "sp_edit_view_')));
            assert.strictEqual(
                transactionSql.filter(sql => sql.startsWith('RELEASE "sp_edit_view_')).length,
                1,
                'the only RELEASE must be the one that closes the rolled-back savepoint'
            );
        } finally {
            connection.dispose();
        }
    });

    it('rejects a stored view replay tail through the checked native path', async () => {
        const connection = await createRecordingConnection(call => {
            if (call.method === 'runSingle') {
                return { error: 'Exactly one SQL statement is required' };
            }
            return { result: { columns: [], values: [] } };
        });

        try {
            await assert.rejects(
                connection.databaseOps.undoModification({
                    modificationType: 'view_drop',
                    description: 'restore crafted view',
                    targetTable: 'crafted_view',
                    viewDefBefore: {
                        identifier: 'crafted_view',
                        sql: 'CREATE VIEW crafted_view AS SELECT 1; DROP TABLE sentinel',
                        selectSql: '',
                        triggers: []
                    }
                }),
                /Exactly one SQL statement is required/
            );
            const replay = connection.calls.find(call => call.method === 'runSingle');
            assert.strictEqual(
                replay?.args[1],
                'CREATE VIEW crafted_view AS SELECT 1; DROP TABLE sentinel'
            );
        } finally {
            connection.dispose();
        }
    });

    it('drops a native view even when its stored SQL is not editable', async () => {
        const connection = await createRecordingConnection(call => {
            if (call.method === 'queryBatch') {
                return {
                    result: {
                        results: [
                            { columns: ['sql'], values: [['opaque stored view text']] },
                            { columns: ['name', 'sql'], values: [] }
                        ]
                    }
                };
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        try {
            const dropped = await connection.databaseOps.dropView('opaque_view');
            assert.strictEqual(dropped.sql, 'opaque stored view text');
            assert.strictEqual(dropped.selectSql, '');
            assert.ok(connection.calls.some(call => (
                call.method === 'run' && call.args[0] === 'DROP VIEW "opaque_view"'
            )));
        } finally {
            connection.dispose();
        }
    });

    it('logs a missing native view definition while preserving undo no-op behavior', async () => {
        const outputLines: string[] = [];
        const outputChannel = {
            appendLine(line: string) {
                outputLines.push(line);
            }
        } as unknown as vscode.OutputChannel;
        const connection = await createRecordingConnection(undefined, outputChannel);
        try {
            await connection.databaseOps.undoModification({
                modificationType: 'view_edit',
                description: 'legacy edit',
                targetTable: 'legacy_view'
            });
            assert.deepStrictEqual(outputLines, [
                '[NativeWorker] Skipping view undo: definition missing from history entry'
            ]);
        } finally {
            connection.dispose();
        }
    });

    it('atomically replaces a view and recreates its triggers through the native worker', async () => {
        let currentViewSql = 'CREATE VIEW "user names" ("user id", "display name") AS SELECT id, name FROM users';
        const triggerSql = [
            'CREATE TRIGGER "user names insert"',
            'INSTEAD OF INSERT ON "user names"',
            'BEGIN SELECT 1; END'
        ].join(' ');
        let triggerPresent = true;

        const connection = await createRecordingConnection((call) => {
            if (call.method === 'queryBatch') {
                const [queries] = call.args as [Array<{ sql: string }>];
                return {
                    result: {
                        results: queries.map(query => {
                            if (query.sql.includes("type = 'view'")) {
                                return { columns: ['sql'], values: [[currentViewSql]] };
                            }
                            if (query.sql.includes("type = 'trigger'")) {
                                return {
                                    columns: ['name', 'sql'],
                                    values: triggerPresent ? [['user names insert', triggerSql]] : []
                                };
                            }
                            if (query.sql.startsWith('PRAGMA table_info')) {
                                return {
                                    columns: ['cid', 'name'],
                                    values: [[0, 'user id'], [1, 'display name']]
                                };
                            }
                            return { columns: [], values: [] };
                        })
                    }
                };
            }
            if (call.method === 'querySingle') {
                const [sql] = call.args as [string];
                if (sql.startsWith('EXPLAIN')) {
                    return { result: { columns: [], values: [] } };
                }
            }

            if (call.method === 'run' || call.method === 'runSingle') {
                const sql = String(call.method === 'run' ? call.args[0] : call.args[1]);
                if (sql === 'DROP VIEW "user names"') {
                    triggerPresent = false;
                } else if (sql.startsWith('CREATE VIEW "user names" ')) {
                    currentViewSql = sql;
                } else if (sql === triggerSql) {
                    triggerPresent = true;
                }
            }

            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        try {
            connection.calls.length = 0;
            const result = await connection.databaseOps.editView(
                'user names',
                'SELECT id, name, upper(name) AS display_name FROM users',
                true
            );

            assert.strictEqual(result.before.triggers.length, 1);
            assert.strictEqual(result.before.columnListSql, '("user id", "display name")');
            assert.strictEqual(result.after.triggers.length, 1);
            assert.strictEqual(
                result.after.selectSql,
                'SELECT id, name, upper(name) AS display_name FROM users'
            );

            const runSql = connection.calls
                .filter(call => call.method === 'run' || call.method === 'runSingle')
                .map(call => String(call.method === 'run' ? call.args[0] : call.args[1]));
            assert.match(runSql[0], /^SAVEPOINT "sp_edit_view_/);
            assert.strictEqual(runSql[1], 'DROP VIEW "user names"');
            assert.strictEqual(
                runSql[2],
                'CREATE VIEW "user names" ("user id", "display name") AS SELECT id, name, upper(name) AS display_name FROM users'
            );
            assert.strictEqual(runSql[3], triggerSql);
            assert.match(runSql[4], /^RELEASE "sp_edit_view_/);

            assert.strictEqual(
                connection.calls.filter(call => call.method === 'queryBatch').length,
                2,
                'view and trigger metadata should share one native IPC round-trip per snapshot'
            );

            const triggerQueries = connection.calls
                .filter(call => call.method === 'queryBatch')
                .flatMap(call => (call.args[0] as Array<{ sql: string }>))
                .filter(query => query.sql.includes("type = 'trigger'"));
            assert.ok(triggerQueries.length > 0);
            assert.ok(triggerQueries.every(query => query.sql.endsWith('ORDER BY rowid')));

            const createIndex = connection.calls.findIndex(call => (
                call.method === 'runSingle'
                && String(call.args[1]).startsWith('CREATE VIEW "user names" ')
            ));
            const releaseIndex = connection.calls.findIndex(call => (
                call.method === 'run'
                && String(call.args[0]).startsWith('RELEASE "sp_edit_view_')
            ));
            const replacementExplainIndex = connection.calls.findIndex(call => (
                call.method === 'querySingle'
                && String(call.args[0]).startsWith(
                    'EXPLAIN SELECT * FROM "user names"\n/*sqlite_explorer_boundary_'
                )
            ));
            assert.ok(createIndex >= 0);
            assert.ok(replacementExplainIndex > createIndex);
            assert.ok(replacementExplainIndex < releaseIndex);
        } finally {
            connection.dispose();
        }
    });
});

describe('NativeWorkerProcess', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('should catch deserialization errors on invalid data', () => {
        // Instantiate the worker directly to test internal handleData method
        const worker = new NativeWorkerProcess('/fake/bin', '/fake/script');

        let errorLogged = false;
        mock.method(console, 'error', (msg: string, err: any) => {
            if (msg && typeof msg === 'string' && msg.includes('Failed to deserialize message')) {
                errorLogged = true;
            }
        });

        const badMsg = Buffer.from('this is not valid v8 data');
        const header = Buffer.alloc(4);
        header.writeUInt32BE(badMsg.length, 0);
        const payload = Buffer.concat([header, badMsg]);

        // Using any to access private handleData
        (worker as any).handleData(payload);

        assert.strictEqual(errorLogged, true, 'Should log error on bad deserialization');
    });
});

describe('native querySingle worker handler', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('rejects a preview tail before stepping the prepared statement', () => {
        const executeSingleQuery = loadNativeWorkerFunction(
            'executeSingleQuery',
            ['db', 'sql', 'params', 'requiredSuffix']
        );
        const boundary = '/*sqlite_explorer_boundary_test*/';
        const sql = [
            'SELECT * FROM (SELECT 1) LIMIT 1; DROP TABLE preview_sentinel; --',
            ') LIMIT 10',
            boundary
        ].join('\n');
        let stepped = false;
        let finalized = false;
        const database = {
            prepare() {
                return {
                    // txiki exposes only the first prepared statement here, so
                    // the generated boundary is absent when a tail escaped.
                    toString: () => 'SELECT * FROM (SELECT 1) LIMIT 1;',
                    all() {
                        stepped = true;
                        return [];
                    },
                    finalize() {
                        finalized = true;
                    }
                };
            }
        };

        assert.throws(
            () => executeSingleQuery(database, sql, undefined, boundary),
            /Exactly one SQL statement is required/
        );
        assert.strictEqual(stepped, false);
        assert.strictEqual(finalized, true);
    });

    it('checks elapsed time while reading a native preview row-by-row', () => {
        const executeBoundedQuery = loadNativeWorkerFunction(
            'executeBoundedQuery',
            ['db', 'markedSql', 'sql', 'requiredSuffix', 'columns', 'limit', 'timeoutMs']
        );
        const boundary = '/*sqlite_explorer_boundary_test*/';
        let finalized = 0;
        let rowQueries = 0;
        const database = {
            prepare(sql: string) {
                if (sql.endsWith(boundary)) {
                    return {
                        toString: () => sql,
                        finalize() { finalized++; }
                    };
                }
                return {
                    all() {
                        rowQueries++;
                        return [{ value: 1 }];
                    },
                    finalize() { finalized++; }
                };
            }
        };
        const times = [0, 1, 10];
        mock.method(Date, 'now', () => times.shift() ?? 10);

        assert.throws(
            () => executeBoundedQuery(
                database,
                `SELECT * FROM preview\n${boundary}`,
                'SELECT * FROM preview',
                boundary,
                ['value'],
                10,
                5
            ),
            /Query execution timed out after 5ms/
        );
        assert.strictEqual(rowQueries, 1);
        assert.strictEqual(finalized, 2);
    });

    it('executes a 100-row duplicate-alias preview only once', () => {
        const executeBoundedQuery = loadNativeWorkerFunction(
            'executeBoundedQuery',
            ['db', 'markedSql', 'sql', 'requiredSuffix', 'columns', 'limit', 'timeoutMs']
        );
        const boundary = '/*sqlite_explorer_boundary_test*/';
        let dataPrepareCalls = 0;
        let finalized = 0;
        const database = {
            prepare(sql: string) {
                if (sql.endsWith(boundary)) {
                    return {
                        toString: () => sql,
                        finalize() { finalized++; }
                    };
                }
                dataPrepareCalls++;
                return {
                    all() {
                        return Array.from({ length: 100 }, (_, index) => ({
                            x: index + 1,
                            'x:1': (index + 1) * 10
                        }));
                    },
                    finalize() { finalized++; }
                };
            }
        };
        mock.method(Date, 'now', () => 0);

        const result = executeBoundedQuery(
            database,
            `SELECT * FROM preview\n${boundary}`,
            'SELECT * FROM preview',
            boundary,
            ['x', 'x:1'],
            100,
            5000
        );

        assert.strictEqual(dataPrepareCalls, 1);
        assert.strictEqual(finalized, 2);
        assert.strictEqual(result.rowCount, 100);
        assert.deepStrictEqual(result.values[0], [1, 10]);
        assert.deepStrictEqual(result.values[99], [100, 1000]);
    });

    it('rejects a stored mutation tail before executing the original SQL', () => {
        const executeSingleStatement = loadNativeWorkerFunction(
            'executeSingleStatement',
            ['db', 'markedSql', 'sql', 'params', 'requiredSuffix']
        );
        let finalized = false;
        let prepareCalls = 0;
        const database = {
            prepare() {
                prepareCalls++;
                return {
                    toString: () => 'CREATE VIEW crafted AS SELECT 1;',
                    finalize() { finalized = true; }
                };
            }
        };

        assert.throws(
            () => executeSingleStatement(
                database,
                'CREATE VIEW crafted AS SELECT 1; DROP TABLE sentinel\n/*boundary*/',
                'CREATE VIEW crafted AS SELECT 1; DROP TABLE sentinel',
                undefined,
                '/*boundary*/'
            ),
            /Exactly one SQL statement is required/
        );
        assert.strictEqual(prepareCalls, 1);
        assert.strictEqual(finalized, true);
    });

    it('rejects divergent marked and executable mutation payloads', () => {
        const executeSingleStatement = loadNativeWorkerFunction(
            'executeSingleStatement',
            ['db', 'markedSql', 'sql', 'params', 'requiredSuffix']
        );
        let prepareCalls = 0;
        const database = {
            prepare() {
                prepareCalls++;
                throw new Error('prepare must not run for a divergent payload');
            }
        };
        const boundary = '/*sqlite_explorer_boundary_test*/';

        assert.throws(
            () => executeSingleStatement(
                database,
                `CREATE VIEW sample AS SELECT MAX(1) AS value\n${boundary}`,
                'CREATE VIEW sample AS SELECT MAX',
                undefined,
                boundary
            ),
            /Single-statement SQL payload mismatch/
        );
        assert.strictEqual(prepareCalls, 0);
    });
});
