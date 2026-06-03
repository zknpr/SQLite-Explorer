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

interface RecordedNativeCall {
    id: number;
    method: string;
    args: unknown[];
}

type RecordedNativeResponder = (call: RecordedNativeCall) => { result?: unknown; error?: string };

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

            // Tests can provide per-method native responses; otherwise use a generic write success.
            queueMicrotask(() => {
                const response = respondToCall?.(call) ?? { result: { changes: 1, lastInsertRowId: 1 } };
                emitMessage({ id: call.id, ...response });
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

    async function createRecordingConnection(respondToCall?: RecordedNativeResponder): Promise<{
        databaseOps: DatabaseOperations;
        calls: RecordedNativeCall[];
        dispose: () => void;
    }> {
        const calls: RecordedNativeCall[] = [];
        mock.method(child_process, 'spawn', () => createRecordingNativeProcess(calls, respondToCall));

        const { createNativeDatabaseConnection } = require('../../src/nativeWorker');
        const bundle = await createNativeDatabaseConnection({ fsPath: tempDir } as any);
        const connection = await bundle.establishConnection({ fsPath: '/db/path.sqlite' } as any, 'TestDB');

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

    it('undoes a batch of json_patch cells atomically via execBatch of restored-object writes', async () => {
        // Reads happen before the one execBatch write so the native worker applies the batch atomically.
        const currents: Record<number, unknown> = {
            3: { count: 2, stable: 'one', concurrent: 'a' },
            4: { count: 11, stable: 'two', concurrent: 'b' }
        };
        const connection = await createRecordingConnection((call) => {
            if (call.method === 'query') {
                const [, params] = call.args as [string, unknown[]];
                return { result: { columns: ['payload'], values: [[JSON.stringify(currents[Number(params[0])])]] } };
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
            const batchCall = connection.calls.find(call => call.method === 'execBatch');
            assert.strictEqual(queryCalls.length, 2);
            assert.ok(batchCall, 'batch json_patch undo must write through one execBatch');

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
