import './vscode_mock_setup';
import { describe, it, mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as v8 from 'node:v8';
import { EventEmitter } from 'node:events';
import * as vscode from 'vscode';
import { isNativeAvailable, NativeWorkerProcess } from '../../src/nativeWorker';
import { InvocationTimeoutError } from '../../src/core/rpc';
import type { DatabaseOperations } from '../../src/core/types';
import {
    encodePrimaryKeyRecordId,
    MAIN_TABLE_ROOT_PAGE_SQL
} from '../../src/core/row-identity';
import {
    ROWID_ALIAS_COLUMN_SQL,
    ROWID_TABLE_AUTHORITY_SQL,
    TABLE_XINFO_WITH_ROWID_ALIAS_SQL
} from '../../src/core/integer-utils';
import { createDeferred } from './helpers/deferred';
import {
    CellEditPolicyError,
    DEFAULT_MAX_CELL_EDIT_BYTES,
    OversizedCellReplacementRequiredError
} from '../../src/core/cell-edit-policy';
import { buildCreateViewTriggerSql } from '../../src/core/view-utils';

const nativeWorkerSource = fs.readFileSync(
    path.resolve(process.cwd(), 'natives', 'native-worker.js'),
    'utf8'
);

function loadNativeWorkerFunction(
    functionName: string,
    parameters: string[],
    dependencies: Record<string, unknown> = {}
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
    const resolvedDependencies = { ...dependencies };
    if (
        functionName !== 'describeNativeError'
        && functionSource.includes('describeNativeError(')
        && !Object.prototype.hasOwnProperty.call(resolvedDependencies, 'describeNativeError')
    ) {
        resolvedDependencies.describeNativeError = loadNativeWorkerFunction(
            'describeNativeError',
            ['error', 'fallback'],
            { MAX_NATIVE_ERROR_MESSAGE_LENGTH: 8192 }
        );
    }
    const dependencyNames = Object.keys(resolvedDependencies);
    return Function(
        ...dependencyNames,
        `"use strict"; return (${functionSource});`
    )(...dependencyNames.map(name => resolvedDependencies[name]));
}

function loadNativeBoundaryFunction(
    functionName: 'executeSingleStatement' | 'executeBoundedQuery',
    parameters: string[]
): (...args: any[]) => any {
    const assertSingleStatementPayload = loadNativeWorkerFunction(
        'assertSingleStatementPayload',
        ['db', 'markedSql', 'sql', 'requiredSuffix']
    );
    const dependencies: Record<string, unknown> = { assertSingleStatementPayload };
    if (functionName === 'executeBoundedQuery') {
        dependencies.compactExactNumericResult = loadNativeWorkerFunction(
            'compactExactNumericResult',
            ['result', 'transportColumns', 'valueColumnCount']
        );
    }
    return loadNativeWorkerFunction(functionName, parameters, dependencies);
}

interface RecordedNativeCall {
    id: number;
    method: string;
    args: unknown[];
    timeoutMs?: number;
}

type RecordedNativeResponse = { result?: unknown; error?: string; cancelled?: boolean };
type RecordedNativeResponder = (
    call: RecordedNativeCall
) => RecordedNativeResponse | undefined | Promise<RecordedNativeResponse | undefined>;

function isRowIdAliasMetadataCall(call: RecordedNativeCall): boolean {
    return call.method === 'query' && call.args[0] === ROWID_ALIAS_COLUMN_SQL;
}

function isPostUpdateRowIdCall(call: RecordedNativeCall): boolean {
    return call.method === 'query'
        && /^SELECT CAST\(rowid AS TEXT\) FROM /.test(String(call.args[0]));
}

function isTextEncodingRead(call: RecordedNativeCall): boolean {
    return call.method === 'query' && call.args[0] === 'PRAGMA encoding';
}

function withoutTextEncodingReads(calls: readonly RecordedNativeCall[]): RecordedNativeCall[] {
    return calls.filter(call => !isTextEncodingRead(call));
}

function assertSingleTextEncodingRead(calls: readonly RecordedNativeCall[]): void {
    assert.strictEqual(
        calls.filter(isTextEncodingRead).length,
        1,
        'stored TEXT history must resolve and cache the database encoding exactly once'
    );
}

function noRowIdAliasResponse(): RecordedNativeResponse {
    return { result: { columns: ['name'], values: [] } };
}

function updatedRowIdResponse(...rowIds: Array<number | string>): RecordedNativeResponse {
    return {
        result: {
            columns: ['rowid'],
            values: rowIds.map(rowId => [String(rowId)])
        }
    };
}

function isUpdateTriggerGuardCall(call: RecordedNativeCall): boolean {
    if (call.method !== 'queryBatch') return false;
    const queries = call.args[0];
    return Array.isArray(queries)
        && queries.length === 2
        && queries[0]?.sql === MAIN_TABLE_ROOT_PAGE_SQL
        && /^EXPLAIN UPDATE /.test(String(queries[1]?.sql));
}

const explainColumns = ['addr', 'opcode', 'p1', 'p2', 'p3', 'p4', 'p5', 'comment'];

function updateTriggerGuardResponse(
    rows: unknown[][] = [[0, 'Init', 0, 1, 0, null, 0, null]],
    rootPage: number = 31
): RecordedNativeResponse {
    return {
        result: {
            results: [
                { columns: ['rootpage'], values: [[rootPage]] },
                { columns: explainColumns, values: rows }
            ]
        }
    };
}

function targetWritingTriggerGuardResponse(): RecordedNativeResponse {
    return updateTriggerGuardResponse([
        [0, 'Init', 0, 1, 0, null, 0, null],
        [0, 'Init', 0, 1, 0, '-- TRIGGER native_entry', 0, null],
        [1, 'Program', 0, 2, 0, 'program', 0, null],
        [0, 'Init', 0, 1, 0, '-- TRIGGER native_descendant', 0, null],
        [1, 'OpenWrite', 0, 31, 0, '2', 0, null]
    ]);
}

function auditOnlyTriggerGuardResponse(): RecordedNativeResponse {
    return updateTriggerGuardResponse([
        [0, 'Init', 0, 1, 0, null, 0, null],
        [0, 'Init', 0, 1, 0, '-- TRIGGER native_audit', 0, null],
        [1, 'OpenWrite', 0, 32, 0, '1', 0, null]
    ]);
}

function foreignKeyUpdateGuardResponse(
    assignment: 'cascade' | 'set-null' | 'set-default'
): RecordedNativeResponse {
    const assignmentRow = assignment === 'cascade'
        ? [20, 'Param', 2, 7, 0, null, 0, null]
        : assignment === 'set-null'
            ? [20, 'Null', 0, 7, 0, null, 0, null]
            : [20, 'String8', 0, 7, 0, 'fallback', 0, null];
    return updateTriggerGuardResponse([
        [0, 'Init', 0, 36, 0, null, 0, null],
        [0, 'Init', 0, 1, 0, null, 0, null],
        [1, 'Param', 0, 1, 0, null, 0, null],
        [2, 'Param', 2, 2, 0, null, 0, null],
        [14, 'OpenWrite', 0, 32, 0, '1', 0, null],
        assignmentRow,
        [22, 'MakeRecord', 7, 1, 8, 'D', 0, null],
        [32, 'Delete', 0, 68, 6, 'child', 0, null],
        [33, 'Insert', 0, 8, 6, 'child', 5, null],
        [36, 'Halt', 0, 0, 0, null, 0, null]
    ]);
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
                    const defaultResponse = call.method === 'compileBatch'
                        ? {
                            result: {
                                errors: Array.isArray(call.args[0])
                                    ? call.args[0].map(() => null)
                                    : []
                            }
                        }
                        : { result: { changes: 1, lastInsertRowId: 1 } };
                    const suppliedResponse = call.method === 'query'
                        && call.args[0] === ROWID_TABLE_AUTHORITY_SQL
                        ? { result: { columns: ['1'], values: [[1]] } }
                        : call.method === 'query' && call.args[0] === 'PRAGMA encoding'
                            ? { result: { columns: ['encoding'], values: [['UTF-8']] } }
                        : await respondToCall?.(call);
                    const response = call.method === 'compileBatch'
                        && suppliedResponse?.error === undefined
                        && !Array.isArray((suppliedResponse?.result as any)?.errors)
                        ? defaultResponse
                        : suppliedResponse ?? defaultResponse;
                    emitMessage({ id: call.id, ...response });
                } catch (err) {
                    emitMessage({ id: call.id, error: err instanceof Error ? err.message : String(err) });
                }
            });
        }
    };

    mockProcess.stdin = new EventEmitter();
    mockProcess.stdin.write = mock.fn((chunk: Buffer) => {
            // NativeWorkerProcess writes the header and payload separately, so buffer until a full frame arrives.
            inputBuffer = Buffer.concat([inputBuffer, Buffer.from(chunk)]);
            readInboundMessages();
            return true;
        });

    queueMicrotask(() => {
        emitMessage({ ready: true });
    });

    return mockProcess;
}

describe('native statement fallback integrity', () => {
    it('bounds arbitrary native error text before it reaches IPC or stderr', () => {
        const describeNativeError = loadNativeWorkerFunction(
            'describeNativeError',
            ['error', 'fallback'],
            { MAX_NATIVE_ERROR_MESSAGE_LENGTH: 8192 }
        );
        const hostile = {
            [Symbol.toPrimitive]() {
                throw new Error('coercion trap');
            }
        };

        assert.strictEqual(describeNativeError(null, 'Unknown error'), 'null');
        assert.strictEqual(describeNativeError(hostile, 'Unknown error'), 'Unknown error');
        const bounded = describeNativeError(new Error('x'.repeat(20_000)), 'Unknown error');
        assert.ok(bounded.length < 8300);
        assert.match(bounded, /truncated from 20000 characters/);
    });

    it('never writes SQL text or bound parameter values to worker diagnostics', () => {
        const diagnosticLines = nativeWorkerSource
            .split('\n')
            .filter(line => /console\.(?:error|warn|log)\s*\(/.test(line));

        assert.deepStrictEqual(
            diagnosticLines.filter(line => /\bsql\b|param/i.test(line)),
            [],
            'worker stderr is forwarded into the VS Code extension host and must contain metadata only'
        );
    });

    it('does not emit per-request success chatter into the VS Code output channel', () => {
        const diagnosticSource = nativeWorkerSource
            .split('\n')
            .filter(line => /console\.(?:error|warn|log)\s*\(/.test(line))
            .join('\n');

        assert.doesNotMatch(
            diagnosticSource,
            /Starting|Sent ready signal|Received request|Sending response|query complete|completed statements|DEBUG: run complete/i
        );
    });

    it('propagates fallback bind failures without executing the unbound statement', () => {
        const executeStatement = loadNativeWorkerFunction(
            'executeStatement',
            ['db', 'sql', 'params']
        );
        let steps = 0;
        let finalizes = 0;
        const db = {
            prepare() {
                return {
                    bind() { throw new Error('bind rejected value'); },
                    step() { steps++; },
                    finalize() { finalizes++; }
                };
            }
        };

        assert.throws(
            () => executeStatement(db, 'UPDATE t SET value = ?', ['secret']),
            /bind rejected value/
        );
        assert.strictEqual(steps, 0);
        assert.strictEqual(finalizes, 1);
    });

    it('refuses parameters when a fallback statement has no binding API', () => {
        const executeStatement = loadNativeWorkerFunction(
            'executeStatement',
            ['db', 'sql', 'params']
        );
        let steps = 0;
        const db = {
            prepare() {
                return {
                    step() { steps++; },
                    finalize() {}
                };
            }
        };

        assert.throws(
            () => executeStatement(db, 'UPDATE t SET value = ?', [17]),
            /does not support parameter binding/i
        );
        assert.strictEqual(steps, 0);
    });

    it('preserves the primary SQLite error when statement finalization also fails', () => {
        const executeStatement = loadNativeWorkerFunction(
            'executeStatement',
            ['db', 'sql', 'params']
        );
        const db = {
            prepare() {
                return {
                    run() { throw new Error('attempt to write a readonly database'); },
                    finalize() { throw new Error('statement already finalized'); }
                };
            }
        };

        let error: unknown;
        try {
            executeStatement(db, 'UPDATE t SET value = 1');
        } catch (caught) {
            error = caught;
        }
        assert.ok(error instanceof Error);
        assert.match(error.message, /attempt to write a readonly database/i);
        assert.ok(error instanceof AggregateError);
        assert.strictEqual(error.errors.length, 2);
        assert.match(error.message, /statement already finalized/i);
    });

    it('propagates a changes-query failure instead of reporting a false zero', () => {
        const readRunFallbackResult = loadNativeWorkerFunction(
            'readRunFallbackResult',
            ['db']
        );
        let finalizes = 0;
        const db = {
            prepare() {
                return {
                    all() { throw new Error('changes query failed'); },
                    finalize() { finalizes++; }
                };
            }
        };

        assert.throws(() => readRunFallbackResult(db), /changes query failed/);
        assert.strictEqual(finalizes, 1);
    });

    it('rejects an impossible empty changes result instead of treating it as success', () => {
        const readRunFallbackResult = loadNativeWorkerFunction(
            'readRunFallbackResult',
            ['db']
        );
        const db = {
            prepare() {
                return { all: () => [], finalize() {} };
            }
        };

        assert.throws(
            () => readRunFallbackResult(db),
            /did not return mutation metadata/i
        );
    });

    it('validates query SQL before trying to log a substring', () => {
        const executeQuery = loadNativeWorkerFunction(
            'executeQuery',
            ['db', 'sql', 'params'],
            { MAX_QUERY_STATEMENTS: 32 }
        );
        assert.throws(
            () => executeQuery({}, 42, []),
            /SQL query must be a string/
        );
    });

    it('rejects non-array query parameters before preparing or stepping SQL', () => {
        const executeQuery = loadNativeWorkerFunction(
            'executeQuery',
            ['db', 'sql', 'params'],
            { MAX_QUERY_STATEMENTS: 32 }
        );
        let prepares = 0;
        const db = {
            prepare() {
                prepares++;
                return {
                    toString: () => 'SELECT ?',
                    all: (...values: unknown[]) => [{ values }],
                    finalize() {}
                };
            }
        };

        assert.throws(
            () => executeQuery(db, 'SELECT ?', 'secret'),
            /query parameters must be an array/i
        );
        assert.strictEqual(prepares, 0);
    });
});

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
        forceReadOnly: boolean = false,
        respondToTriggerGuard?: RecordedNativeResponder
    ): Promise<{
        databaseOps: DatabaseOperations;
        calls: RecordedNativeCall[];
        exportDatabase: () => Promise<Uint8Array>;
        dispose: () => void;
    }> {
        const calls: RecordedNativeCall[] = [];
        const responder: RecordedNativeResponder = async call => {
            if (isUpdateTriggerGuardCall(call)) {
                return await respondToTriggerGuard?.(call)
                    ?? updateTriggerGuardResponse();
            }
            return respondToCall?.(call);
        };
        mock.method(child_process, 'spawn', () => createRecordingNativeProcess(calls, responder));

        const { createNativeDatabaseConnection } = require('../../src/nativeWorker');
        const bundle = await createNativeDatabaseConnection(
            { fsPath: tempDir } as any,
            undefined,
            outputChannel,
            queryTimeout
        );
        const connection = await bundle.establishConnection(
            // Keep the leaf absent: native SQLite may legitimately create a
            // new database when its parent directory is writable.
            { fsPath: path.join(tempDir, 'path.sqlite') } as any,
            'TestDB',
            forceReadOnly
        );

        return {
            databaseOps: connection.databaseOps,
            calls,
            exportDatabase: () => bundle.workerMethods.exportDatabase() as Promise<Uint8Array>,
            dispose: () => bundle.workerMethods[Symbol.dispose]()
        };
    }

    it('uses an isolated cross-platform scratch directory for native snapshots and cleans it', async () => {
        let exportedPath = '';
        const connection = await createRecordingConnection(call => {
            if (call.method === 'vacuumInto') {
                exportedPath = String(call.args[0]);
                fs.writeFileSync(exportedPath, new Uint8Array([1, 2, 3]));
                return { result: { success: true } };
            }
            return { result: { columns: [], values: [] } };
        });

        try {
            assert.deepStrictEqual(await connection.exportDatabase(), new Uint8Array([1, 2, 3]));
            assert.ok(path.isAbsolute(exportedPath));
            assert.strictEqual(path.dirname(exportedPath).startsWith(os.tmpdir()), true);
            assert.match(path.basename(path.dirname(exportedPath)), /^sqlite-explorer-export-/);
            assert.strictEqual(fs.existsSync(path.dirname(exportedPath)), false);
        } finally {
            connection.dispose();
        }
    });

    it('removes the native snapshot scratch directory when export fails', async () => {
        let exportedPath = '';
        const connection = await createRecordingConnection(call => {
            if (call.method === 'vacuumInto') {
                exportedPath = String(call.args[0]);
                fs.writeFileSync(exportedPath, 'partial');
                fs.writeFileSync(`${exportedPath}-journal`, 'partial sidecar');
                return { error: 'snapshot failed' };
            }
            return { result: { columns: [], values: [] } };
        });

        try {
            await assert.rejects(connection.exportDatabase(), /snapshot failed/);
            assert.notStrictEqual(exportedPath, '');
            assert.strictEqual(fs.existsSync(path.dirname(exportedPath)), false);
        } finally {
            connection.dispose();
        }
    });

    it('routes generated export spool statements through one interruptible native connection', async () => {
        const connection = await createRecordingConnection(call => {
            if (call.method === 'queryExportSpool') {
                return { result: { columns: ['value'], values: [['one']], rowCount: 1 } };
            }
            return { result: { columns: [], values: [] } };
        });
        const spool = '__sqlite_explorer_export_0123456789abcdef0123456789abcdef';
        const controller = new AbortController();

        try {
            connection.calls.length = 0;
            await connection.databaseOps.executeQuery(
                `CREATE TEMP TABLE "${spool}" AS SELECT 'one' AS value`,
                undefined,
                controller.signal
            );
            await connection.databaseOps.executeQuery(
                `SELECT CAST(rowid AS TEXT), * FROM "${spool}" ` +
                'WHERE rowid > ? ORDER BY rowid LIMIT 1',
                [0],
                controller.signal
            );
            await connection.databaseOps.executeQuery(
                `DROP TABLE IF EXISTS temp."${spool}"`
            );

            assert.deepStrictEqual(
                connection.calls.map(call => call.method),
                ['queryExportSpool', 'queryExportSpool', 'queryExportSpool']
            );
            assert.ok(connection.calls.slice(0, 2).every(call => (
                String(call.args[0]).includes(spool)
            )));
        } finally {
            connection.dispose();
        }
    });

    it('loads native table identities in one schema queryBatch, including virtual and shadow tables', async () => {
        const identityMetadata = {
            columns: [
                'table_name',
                'object_type',
                'without_rowid',
                'column_ordinal',
                'column_name',
                'declared_type',
                'primary_key_position'
            ],
            values: [
                ['docs', 'table', 0, null, null, null, null],
                ['docs_fts', 'virtual', 0, null, null, null, null],
                ['docs_fts_data', 'shadow', 0, null, null, null, null],
                ['records', 'table', 1, 0, 'tenant', 'TEXT', 1],
                ['records', 'table', 1, 1, 'sequence', 'INTEGER', 2],
                ['records', 'table', 1, 2, 'value', 'TEXT', 0]
            ]
        };
        const connection = await createRecordingConnection(call => {
            if (call.method === 'queryBatch') {
                const [queries] = call.args as [Array<{ sql: string }>];
                return {
                    result: {
                        results: [
                            {
                                columns: ['name'],
                                values: [['docs'], ['docs_fts'], ['docs_fts_data'], ['records']]
                            },
                            { columns: ['name'], values: [] },
                            { columns: ['name', 'tbl_name'], values: [] },
                            ...(queries.length > 3 ? [identityMetadata] : [])
                        ]
                    }
                };
            }
            if (call.method === 'query') {
                throw new Error('schema identity metadata must not use per-table IPC');
            }
            return { result: { columns: [], values: [] } };
        });

        try {
            connection.calls.length = 0;
            const schema = await connection.databaseOps.fetchSchema();

            assert.deepStrictEqual(
                schema.tables.map(table => [table.identifier, table.identity]),
                [
                    ['docs', { kind: 'rowid' }],
                    ['docs_fts', { kind: 'rowid' }],
                    ['docs_fts_data', { kind: 'rowid' }],
                    ['records', {
                        kind: 'primaryKey',
                        columns: [
                            { identifier: 'tenant', declaredType: 'TEXT', position: 1 },
                            { identifier: 'sequence', declaredType: 'INTEGER', position: 2 }
                        ]
                    }]
                ]
            );
            assert.deepStrictEqual(connection.calls.map(call => call.method), ['queryBatch']);
            assert.strictEqual((connection.calls[0].args[0] as unknown[]).length, 4);
        } finally {
            connection.dispose();
        }
    });

    it('routes bounded cell sessions with a structured validated row locator and transport margin', async () => {
        const metadata = { storageClass: 'blob', byteLength: 4 };
        const connection = await createRecordingConnection(call => {
            if (call.method === 'query') {
                return {
                    result: {
                        columns: ['type', 'wr'],
                        values: [['table', 0]]
                    }
                };
            }
            if (call.method === 'getCellMetadata') return { result: metadata };
            if (call.method === 'openCellReadSession') {
                return {
                    result: {
                        sessionId: 'native-session-1',
                        metadata,
                        expiresAt: 1234
                    }
                };
            }
            if (call.method === 'readCellChunk') {
                return {
                    result: {
                        byteOffset: 0,
                        bytes: new Uint8Array([0, 1, 2, 3]),
                        done: true
                    }
                };
            }
            if (call.method === 'closeCellReadSession') return { result: { closed: true } };
            return { result: { success: true } };
        }, undefined, 173);

        try {
            connection.calls.length = 0;
            const target = { table: 'assets', rowId: 7, column: 'payload' };
            assert.deepStrictEqual(await connection.databaseOps.getCellMetadata(target), metadata);
            const session = await connection.databaseOps.openCellReadSession(target);
            const chunk = await connection.databaseOps.readCellChunk(
                session.sessionId,
                0,
                4
            );
            await connection.databaseOps.closeCellReadSession(session.sessionId);

            assert.deepStrictEqual(chunk.bytes, new Uint8Array([0, 1, 2, 3]));
            const metadataCall = connection.calls.find(candidate => (
                candidate.method === 'getCellMetadata'
            ));
            assert.ok(metadataCall, 'missing getCellMetadata native call');
            assert.deepStrictEqual(metadataCall.args, [
                'assets',
                'payload',
                { kind: 'rowid', value: 7 }
            ]);

            const sessionCalls = connection.calls.filter(call => (
                ['openCellReadSession', 'readCellChunk', 'closeCellReadSession']
                    .includes(call.method)
            ));
            assert.deepStrictEqual(
                sessionCalls.map(call => [call.method, call.args, call.timeoutMs]),
                [
                    ['openCellReadSession', [
                        'assets',
                        'payload',
                        { kind: 'rowid', value: 7 },
                        173
                    ], 2173],
                    ['readCellChunk', ['native-session-1', 0, 4, 173], 2173],
                    ['closeCellReadSession', ['native-session-1', 173], 2173]
                ]
            );
            assert.ok(connection.calls.every(call => (
                !['getCellMetadata', 'openCellReadSession'].includes(call.method)
                || !call.args.some(argument => typeof argument === 'string' && /rowid\s*=/.test(argument))
            )));
        } finally {
            connection.dispose();
        }
    });

    it('preserves typeless INTEGER cast flags in native primary-key cell locators', async () => {
        const metadata = { storageClass: 'blob', byteLength: 4 };
        const connection = await createRecordingConnection(call => {
            if (call.method === 'query') {
                const sql = String(call.args[0]);
                if (sql.startsWith('SELECT "type", "wr" FROM pragma.pragma_table_list')) {
                    return { result: { columns: ['type', 'wr'], values: [['table', 1]] } };
                }
                if (sql === TABLE_XINFO_WITH_ROWID_ALIAS_SQL) {
                    return {
                        result: {
                            columns: [
                                'cid',
                                'name',
                                'type',
                                'notnull',
                                'dflt_value',
                                'pk',
                                'hidden',
                                'is_rowid_alias'
                            ],
                            values: [
                                [0, 'id', '', 1, null, 1, 0, 0],
                                [1, 'shard', 'TEXT', 1, null, 2, 0, 0],
                                [2, 'payload', 'BLOB', 0, null, 0, 0, 0]
                            ]
                        }
                    };
                }
            }
            if (call.method === 'getCellMetadata') return { result: metadata };
            if (call.method === 'openCellReadSession') {
                return {
                    result: { sessionId: 'native-pk-session', metadata, expiresAt: 1234 }
                };
            }
            return { result: { success: true } };
        });
        const columns = [
            { identifier: 'id', declaredType: '', position: 1 },
            { identifier: 'shard', declaredType: 'TEXT', position: 2 }
        ];
        const rowId = encodePrimaryKeyRecordId(columns, [9007199254740993n, 'a']);
        const target = { table: 'assets', rowId, column: 'payload' };

        try {
            connection.calls.length = 0;
            assert.deepStrictEqual(await connection.databaseOps.getCellMetadata(target), metadata);
            await connection.databaseOps.openCellReadSession(target);
            const expectedLocator = {
                kind: 'primaryKey',
                columns: ['id', 'shard'],
                values: ['9007199254740993', 'a'],
                integerCasts: [true, false]
            };
            for (const method of ['getCellMetadata', 'openCellReadSession']) {
                const call = connection.calls.find(candidate => candidate.method === method);
                assert.ok(call, `missing ${method} native call`);
                assert.deepStrictEqual(
                    call.args,
                    method === 'openCellReadSession'
                        ? ['assets', 'payload', expectedLocator, 30000]
                        : ['assets', 'payload', expectedLocator]
                );
            }

            const escapeCellIdentifier = loadNativeWorkerFunction(
                'escapeCellIdentifier',
                ['value', 'label']
            );
            const isCellBinding = loadNativeWorkerFunction('isCellBinding', ['value']);
            const buildCellLocator = loadNativeWorkerFunction(
                'buildCellLocator',
                ['locator'],
                { escapeCellIdentifier, isCellBinding }
            );
            assert.deepStrictEqual(buildCellLocator(expectedLocator), {
                sql: '"id" = CAST(? AS INTEGER) AND "shard" = ?',
                params: ['9007199254740993', 'a']
            });
            assert.throws(
                () => buildCellLocator({ ...expectedLocator, integerCasts: [true, '?'] }),
                /invalid INTEGER cast flag/
            );
        } finally {
            connection.dispose();
        }
    });

    it('rejects oversized native new values before crossing the worker boundary', async () => {
        const connection = await createRecordingConnection(() => ({
            result: { changes: 1, lastInsertRowId: 1 }
        }));
        const limit = 1024;
        const oversized = new Uint8Array(limit + 1);
        try {
            connection.calls.length = 0;
            for (const mutation of [
                () => connection.databaseOps.updateCell(
                    'native_limits', 1, 'payload', oversized, undefined, limit
                ),
                () => connection.databaseOps.insertRow(
                    'native_limits', { payload: oversized }, limit
                ),
                () => connection.databaseOps.insertRowBatch(
                    'native_limits', [{ payload: oversized }], limit
                ),
                () => connection.databaseOps.updateCellBatch(
                    'native_limits',
                    [{ rowId: 1, column: 'payload', value: oversized }],
                    limit
                )
            ]) {
                await assert.rejects(mutation, error => {
                    assert.ok(error instanceof CellEditPolicyError);
                    assert.strictEqual(error.actualBytes, limit + 1);
                    return true;
                });
            }
            assert.strictEqual([...connection.calls].length, 0);
        } finally {
            connection.dispose();
        }
    });

    it('rejects a native non-alias edit when a descendant trigger can write the target', async () => {
        const connection = await createRecordingConnection(
            call => {
                if (isRowIdAliasMetadataCall(call)) return noRowIdAliasResponse();
                if (isPostUpdateRowIdCall(call)) return updatedRowIdResponse(5);
                return { result: { changes: 1, lastInsertRowId: 1 } };
            },
            undefined,
            30000,
            false,
            () => targetWritingTriggerGuardResponse()
        );
        try {
            connection.calls.length = 0;
            await assert.rejects(
                connection.databaseOps.updateCell(
                    'native_trigger_target',
                    5,
                    'note',
                    'changed'
                ),
                /UPDATE trigger.*target table.*rowid identity/i
            );
            assert.strictEqual(
                connection.calls.some(call => (
                    call.method === 'run'
                    && /^UPDATE /.test(String(call.args[0]))
                )),
                false
            );
        } finally {
            connection.dispose();
        }
    });

    it('rejects a native rowid-alias trigger side effect outside undo history', async () => {
        const connection = await createRecordingConnection(
            call => {
                if (isRowIdAliasMetadataCall(call)) {
                    return { result: { columns: ['name'], values: [['id']] } };
                }
                if (isPostUpdateRowIdCall(call)) return updatedRowIdResponse(6);
                return { result: { changes: 1, lastInsertRowId: 1 } };
            },
            undefined,
            30000,
            false,
            () => auditOnlyTriggerGuardResponse()
        );
        try {
            connection.calls.length = 0;
            await assert.rejects(
                connection.databaseOps.updateCell(
                    'native_audit_target',
                    5,
                    'id',
                    6
                ),
                /UPDATE trigger.*undo history/i
            );
            assert.strictEqual(
                connection.calls.filter(isUpdateTriggerGuardCall).length,
                1
            );
        } finally {
            connection.dispose();
        }
    });

    for (const [action, assignment] of [
        ['SET NULL', 'set-null'],
        ['SET DEFAULT', 'set-default']
    ] as const) {
        it(`rejects a native ON UPDATE ${action} action before issuing the edit`, async () => {
            const connection = await createRecordingConnection(
                call => {
                    if (isRowIdAliasMetadataCall(call)) return noRowIdAliasResponse();
                    if (isPostUpdateRowIdCall(call)) return updatedRowIdResponse(2);
                    return { result: { changes: 1, lastInsertRowId: 1 } };
                },
                undefined,
                30000,
                false,
                () => foreignKeyUpdateGuardResponse(assignment)
            );
            try {
                connection.calls.length = 0;
                await assert.rejects(
                    connection.databaseOps.updateCell(
                        'native_fk_parent',
                        1,
                        'id',
                        2
                    ),
                    /foreign-key.*UPDATE.*undo history|UPDATE.*foreign-key.*undo history/i
                );
                assert.strictEqual(
                    connection.calls.some(call => (
                        call.method === 'run'
                        && /^UPDATE /.test(String(call.args[0]))
                    )),
                    false
                );
            } finally {
                connection.dispose();
            }
        });
    }

    it('allows a native ON UPDATE CASCADE program that propagates the new parent key', async () => {
        const connection = await createRecordingConnection(
            call => {
                if (isRowIdAliasMetadataCall(call)) return noRowIdAliasResponse();
                if (isPostUpdateRowIdCall(call)) return updatedRowIdResponse(2);
                return { result: { changes: 1, lastInsertRowId: 1 } };
            },
            undefined,
            30000,
            false,
            () => foreignKeyUpdateGuardResponse('cascade')
        );
        try {
            connection.calls.length = 0;
            assert.strictEqual(
                await connection.databaseOps.updateCell(
                    'native_fk_parent',
                    1,
                    'id',
                    2
                ),
                2
            );
            assert.strictEqual(
                connection.calls.some(call => (
                    call.method === 'run'
                    && /^UPDATE /.test(String(call.args[0]))
                )),
                true
            );
        } finally {
            connection.dispose();
        }
    });

    it('rejects a native non-alias batch when a trigger can substitute its rowid', async () => {
        const connection = await createRecordingConnection(
            call => {
                if (isRowIdAliasMetadataCall(call)) return noRowIdAliasResponse();
                if (call.method === 'query') {
                    const sql = String(call.args[0]);
                    if (sql.startsWith('SELECT CAST(rowid AS TEXT),')) {
                        return {
                            result: {
                                columns: ['rowid', 'note'],
                                values: [['5', 'target']]
                            }
                        };
                    }
                    if (sql.startsWith('SELECT CAST(rowid AS TEXT) FROM')) {
                        return updatedRowIdResponse(5);
                    }
                }
                return { result: { changes: 1, lastInsertRowId: 1 } };
            },
            undefined,
            30000,
            false,
            () => targetWritingTriggerGuardResponse()
        );
        try {
            connection.calls.length = 0;
            await assert.rejects(
                connection.databaseOps.updateCellBatch('native_trigger_batch', [{
                    rowId: 5,
                    column: 'note',
                    value: 'changed'
                }]),
                /UPDATE trigger.*target table.*rowid identity/i
            );
            assert.strictEqual(
                connection.calls.some(call => call.method === 'execBatch'),
                false
            );
        } finally {
            connection.dispose();
        }
    });

    it('rejects a native oversized replacement before a trigger can substitute its rowid', async () => {
        const connection = await createRecordingConnection(
            call => {
                if (call.method === 'query') {
                    if (isRowIdAliasMetadataCall(call)) return noRowIdAliasResponse();
                    if (isPostUpdateRowIdCall(call)) return updatedRowIdResponse(5);
                    return {
                        result: {
                            columns: ['type', 'wr'],
                            values: [['table', 0]]
                        }
                    };
                }
                if (call.method === 'replaceOversizedCell') {
                    return { result: { changes: 1 } };
                }
                return { result: { changes: 1, lastInsertRowId: 1 } };
            },
            undefined,
            30000,
            false,
            () => targetWritingTriggerGuardResponse()
        );
        try {
            connection.calls.length = 0;
            await assert.rejects(
                connection.databaseOps.replaceOversizedCell(
                    'native_trigger_replacement',
                    5,
                    'note',
                    'new',
                    { storageClass: 'text', byteLength: 32 },
                    8
                ),
                /UPDATE trigger.*target table.*rowid identity/i
            );
            assert.strictEqual(
                connection.calls.some(call => call.method === 'replaceOversizedCell'),
                false
            );
        } finally {
            connection.dispose();
        }
    });

    it('rejects a native JSON patch whose resulting stored value is oversized', async () => {
        const prior = JSON.stringify({ a: 'x'.repeat(32) });
        const patch = JSON.stringify({ b: 'y'.repeat(32) });
        const limit = 64;
        const connection = await createRecordingConnection(call => {
            if (call.method === 'queryBatch') {
                const [queries] = call.args as [unknown[]];
                return {
                    result: {
                        results: queries.map(() => ({
                            columns: ['storage_class', 'byte_length'],
                            values: []
                        }))
                    }
                };
            }
            if (call.method === 'query') {
                const sql = String(call.args[0]);
                if (isRowIdAliasMetadataCall(call)) return noRowIdAliasResponse();
                if (sql.startsWith('SELECT CAST(rowid AS TEXT),')) {
                    return {
                        result: {
                            columns: ['rowid', 'storage_class', 'payload'],
                            values: [['1', 'text', prior]]
                        }
                    };
                }
                if (sql.startsWith('SELECT json_patch')) {
                    return {
                        result: {
                            columns: ['json_patch'],
                            values: [[JSON.stringify({ a: 'x'.repeat(32), b: 'y'.repeat(32) })]]
                        }
                    };
                }
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });
        try {
            connection.calls.length = 0;
            await assert.rejects(
                connection.databaseOps.updateCellBatch(
                    'native_patch_limits',
                    [{ rowId: 1, column: 'payload', value: patch, operation: 'json_patch' }],
                    limit
                ),
                error => {
                    assert.ok(error instanceof CellEditPolicyError);
                    assert.strictEqual(error.storageClass, 'text');
                    assert.ok(error.actualBytes > limit);
                    return true;
                }
            );
            assert.strictEqual(
                connection.calls.some(call => call.method === 'execBatch'),
                false,
                'native mutation must not run after the policy refusal'
            );
        } finally {
            connection.dispose();
        }
    });

    it('preflights bounded rowid batches in one worker round trip', async () => {
        let projectionReadCount = 0;
        const connection = await createRecordingConnection(call => {
            if (call.method === 'open') return { result: { success: true } };
            if (call.method === 'run' || call.method === 'execBatch') {
                return { result: { changes: 1, lastInsertRowId: 1 } };
            }
            if (call.method === 'queryBatch') {
                const [queries] = call.args as [Array<{ sql: string; params: unknown[] }>];
                return {
                    result: {
                        results: queries.map(() => ({
                            columns: ['storage_class', 'byte_length'],
                            values: []
                        }))
                    }
                };
            }
            if (call.method === 'query') {
                if (isRowIdAliasMetadataCall(call)) return noRowIdAliasResponse();
                if (isPostUpdateRowIdCall(call)) return updatedRowIdResponse(1, 2, 3);
                projectionReadCount += 1;
                const after = projectionReadCount > 1;
                return {
                    result: {
                        columns: [
                            'rowid',
                            'left_storage_class',
                            'left_value',
                            'right_storage_class',
                            'right_value'
                        ],
                        values: [
                            [1, 'text', after ? 'same-left' : 'left-1', 'text', after ? 'same-right' : 'right-1'],
                            [2, 'text', after ? 'same-left' : 'left-2', 'text', after ? 'same-right' : 'right-2'],
                            [3, 'text', after ? 'same-left' : 'left-3', 'text', after ? 'same-right' : 'right-3']
                        ]
                    }
                };
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });
        try {
            connection.calls.length = 0;
            const outcomes = await connection.databaseOps.updateCellBatch(
                'native_batch_preflight',
                [1, 2, 3].flatMap(rowId => [
                    { rowId, column: 'left_value', value: 'same-left' },
                    { rowId, column: 'right_value', value: 'same-right' }
                ]),
                1024
            );

            const operationCalls = withoutTextEncodingReads(connection.calls);
            assertSingleTextEncodingRead(connection.calls);
            assert.deepStrictEqual(
                operationCalls.map(call => call.method),
                [
                    'query',
                    'run',
                    'queryBatch',
                    'query',
                    'queryBatch',
                    'query',
                    'execBatch',
                    'query',
                    'query',
                    'run'
                ]
            );
            const preflightCall = operationCalls[2];
            const [queries] = preflightCall.args as [Array<{ sql: string; params: unknown[] }>];
            assert.strictEqual(queries.length, 2);
            assert.ok(queries.every(query => /rowid\s+IN\s*\(/i.test(query.sql)));
            assert.ok(queries.some(query => /"left_value"/.test(query.sql)));
            assert.ok(queries.some(query => /"right_value"/.test(query.sql)));
            assert.strictEqual(outcomes.length, 6);
        } finally {
            connection.dispose();
        }
    });

    it('chunks native rowid value and identity reads above the SQLite variable ceiling', async () => {
        const updateCount = 32_767;
        const updates = Array.from({ length: updateCount }, (_, index) => ({
            rowId: index + 1,
            column: 'payload',
            value: 'after'
        }));
        const currentReadSizes: number[] = [];
        const postReadSizes: number[] = [];
        const identityReadSizes: number[] = [];
        let mutationApplied = false;
        const connection = await createRecordingConnection(call => {
            if (call.method === 'open') return { result: { success: true } };
            if (call.method === 'run' || call.method === 'execBatch') {
                if (call.method === 'execBatch') mutationApplied = true;
                return { result: { changes: 1, lastInsertRowId: 1 } };
            }
            if (call.method === 'query') {
                if (isRowIdAliasMetadataCall(call)) return noRowIdAliasResponse();
                const sql = String(call.args[0]);
                const rowIds = (call.args[1] ?? []) as Array<number | string>;
                if (/^SELECT CAST\(rowid AS TEXT\),/.test(sql)) {
                    assert.ok(rowIds.length <= 32_766);
                    (mutationApplied ? postReadSizes : currentReadSizes).push(rowIds.length);
                    return {
                        result: {
                            columns: ['rowid', 'storage_class', 'payload'],
                            values: rowIds.map(rowId => [
                                String(rowId),
                                'text',
                                mutationApplied ? 'after' : 'before'
                            ])
                        }
                    };
                }
                if (/^SELECT CAST\(rowid AS TEXT\) FROM main\."native_batch_bind_limit"/.test(sql)) {
                    assert.ok(rowIds.length <= 32_766);
                    identityReadSizes.push(rowIds.length);
                    return {
                        result: {
                            columns: ['rowid'],
                            values: rowIds.map(rowId => [String(rowId)])
                        }
                    };
                }
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        try {
            connection.calls.length = 0;
            const outcomes = await connection.databaseOps.updateCellBatch(
                'native_batch_bind_limit',
                updates
            );

            assert.ok(currentReadSizes.length > 1);
            assert.ok(postReadSizes.length > 1);
            assert.ok(identityReadSizes.length > 1);
            assert.strictEqual(currentReadSizes.reduce((sum, size) => sum + size, 0), updateCount);
            assert.strictEqual(postReadSizes.reduce((sum, size) => sum + size, 0), updateCount);
            assert.strictEqual(identityReadSizes.reduce((sum, size) => sum + size, 0), updateCount);
            assert.strictEqual(outcomes.length, updateCount);
            assert.deepStrictEqual(outcomes[0], {
                rowId: 1,
                columnName: 'payload',
                priorValue: 'before',
                newValue: 'after',
                priorState: { storageClass: 'text', value: 'before' },
                postState: { storageClass: 'text', value: 'after' },
                operation: 'set'
            });
            assert.strictEqual(outcomes.at(-1)?.rowId, updateCount);

            const execBatch = connection.calls.find(call => call.method === 'execBatch');
            assert.ok(execBatch);
            const [batchItems] = execBatch.args as [Array<{ paramsList: unknown[][] }>];
            assert.strictEqual(batchItems.length, 1);
            assert.strictEqual(batchItems[0].paramsList.length, updateCount);
        } finally {
            connection.dispose();
        }
    });

    it('refuses an oversized native batch prior before reading values or writing', async () => {
        const connection = await createRecordingConnection(call => {
            if (call.method === 'open') return { result: { success: true } };
            if (call.method === 'run') return { result: { changes: 0 } };
            if (call.method === 'queryBatch') {
                return {
                    result: {
                        results: [{
                            columns: ['storage_class', 'byte_length'],
                            values: [['blob', 2048]]
                        }]
                    }
                };
            }
            throw new Error(`unexpected native call: ${call.method}`);
        });
        try {
            connection.calls.length = 0;
            await assert.rejects(
                connection.databaseOps.updateCellBatch(
                    'native_batch_oversized_prior',
                    [
                        { rowId: 1, column: 'payload', value: 'bounded' },
                        { rowId: 2, column: 'payload', value: 'bounded' }
                    ],
                    1024
                ),
                error => {
                    assert.ok(error instanceof OversizedCellReplacementRequiredError);
                    assert.strictEqual(error.storageClass, 'blob');
                    assert.strictEqual(error.actualBytes, 2048);
                    return true;
                }
            );
            assert.deepStrictEqual(
                connection.calls.map(call => call.method),
                ['query', 'run', 'queryBatch', 'run', 'run']
            );
        } finally {
            connection.dispose();
        }
    });

    it('refuses aggregate native batch history before opening a savepoint', async () => {
        const connection = await createRecordingConnection(call => {
            if (call.method === 'queryBatch') {
                const [queries] = call.args as [Array<{ sql: string }>];
                return {
                    result: {
                        results: queries.map(query => (
                            /SELECT COUNT\(\*\), COALESCE\(SUM/i.test(query.sql)
                                ? { columns: ['COUNT(*)', 'value_bytes'], values: [[4, 2 * 1024 * 1024]] }
                                : { columns: ['storage_class', 'byte_length'], values: [] }
                        ))
                    }
                };
            }
            if (call.method === 'query') {
                return {
                    result: {
                        columns: ['rowid', 'payload'],
                        values: [1, 2, 3, 4].map(rowId => [rowId, 'x'])
                    }
                };
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });
        try {
            connection.calls.length = 0;
            await assert.rejects(
                (connection.databaseOps.updateCellBatch as any)(
                    'native_aggregate_history',
                    [1, 2, 3, 4].map(rowId => ({
                        rowId,
                        column: 'payload',
                        value: 'after'
                    })),
                    1024 * 1024,
                    700 * 1024
                ),
                /Batch update undo snapshot exceeds the 716800-byte memory budget/i
            );
            assert.strictEqual(
                connection.calls.some(call => (
                    call.method === 'run' && /^SAVEPOINT /.test(String(call.args[0]))
                )),
                false,
                'native aggregate refusal must precede the savepoint'
            );
            assert.strictEqual(connection.calls.some(call => call.method === 'execBatch'), false);
        } finally {
            connection.dispose();
        }
    });

    it('refuses oversized native delete history before selecting row values or deleting', async () => {
        const connection = await createRecordingConnection(call => {
            if (call.method === 'open') {
                return { result: { success: true } };
            }
            if (call.method === 'run') {
                return { result: { changes: 0 } };
            }
            if (call.method === 'query') {
                const sql = String(call.args[0]);
                if (sql === ROWID_TABLE_AUTHORITY_SQL) {
                    return { result: { columns: ['1'], values: [[1]] } };
                }
                if (sql.includes('pragma.pragma_table_list')) {
                    return {
                        result: {
                            columns: ['type', 'wr'],
                            values: [['table', 0]]
                        }
                    };
                }
                if (/^EXPLAIN DELETE /i.test(sql)) {
                    return {
                        result: {
                            columns: ['addr', 'opcode', 'p1', 'p2', 'p3', 'p4', 'p5'],
                            values: [[0, 'Init', 0, 1, 0, null, 0]]
                        }
                    };
                }
                if (sql.includes('pragma_table_xinfo')) {
                    return { result: { columns: ['name'], values: [['payload']] } };
                }
                if (/SELECT COUNT\(\*\), COALESCE\(SUM/i.test(sql)) {
                    return {
                        result: {
                            columns: ['COUNT(*)', 'value_bytes'],
                            values: [[1, 2 * 1024 * 1024]]
                        }
                    };
                }
            }
            throw new Error(`unexpected native call: ${call.method}`);
        });
        try {
            connection.calls.length = 0;
            await assert.rejects(
                connection.databaseOps.deleteRows('native_large_delete', [1], 1024),
                /undo snapshot exceeds.*memory budget/i
            );
            assert.deepStrictEqual(
                connection.calls.map(call => call.method),
                ['query', 'query', 'run', 'query', 'query', 'query', 'run', 'run']
            );
            assert.ok(connection.calls.every(call => {
                const sql = String(call.args[0]);
                return !/SELECT CAST\(rowid AS TEXT\)/i.test(sql)
                    && !/^DELETE\s/i.test(sql);
            }));
        } finally {
            connection.dispose();
        }
    });

    it('fails closed for native legacy cell history while public edits remain guarded', async () => {
        const connection = await createRecordingConnection(call => {
            if (isRowIdAliasMetadataCall(call)) return noRowIdAliasResponse();
            if (isPostUpdateRowIdCall(call)) return updatedRowIdResponse(1);
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });
        const legacyValue = new Uint8Array(DEFAULT_MAX_CELL_EDIT_BYTES + 1);
        try {
            connection.calls.length = 0;
            await assert.rejects(
                connection.databaseOps.updateCell(
                    'native_legacy_history', 1, 'payload', legacyValue
                ),
                CellEditPolicyError
            );

            await assert.rejects(
                connection.databaseOps.undoModification({
                    modificationType: 'cell_update',
                    description: 'legacy oversized prior',
                    targetTable: 'native_legacy_history',
                    targetRowId: 1,
                    targetColumn: 'payload',
                    priorValue: legacyValue,
                    newValue: Uint8Array.from([1])
                }),
                /predates guarded cell history/i
            );
            assert.deepStrictEqual(connection.calls, []);
        } finally {
            connection.dispose();
        }
    });

    it('uses the native guarded replacement command without reading the prior value', async () => {
        const connection = await createRecordingConnection(call => {
            if (call.method === 'query') {
                if (call.args[0] === ROWID_TABLE_AUTHORITY_SQL) {
                    return { result: { columns: ['1'], values: [[1]] } };
                }
                if (isRowIdAliasMetadataCall(call)) return noRowIdAliasResponse();
                if (isPostUpdateRowIdCall(call)) return updatedRowIdResponse(7);
                return {
                    result: {
                        columns: ['type', 'wr'],
                        values: [['table', 0]]
                    }
                };
            }
            if (call.method === 'replaceOversizedCell') {
                return { result: { changes: 1 } };
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });
        try {
            connection.calls.length = 0;
            await connection.databaseOps.replaceOversizedCell(
                'native_large',
                7,
                'payload',
                'bounded',
                { storageClass: 'blob', byteLength: 2048 },
                1024
            );

            assert.deepStrictEqual(
                connection.calls.map(call => call.method),
                [
                    'query',
                    'query',
                    'run',
                    'queryBatch',
                    'replaceOversizedCell',
                    'query',
                    'query',
                    'run'
                ]
            );
            assert.strictEqual(connection.calls[1].args[0], ROWID_TABLE_AUTHORITY_SQL);
            assert.match(String(connection.calls[2].args[0]), /^SAVEPOINT "sp_replace_oversized_cell_/);
            assert.match(String(connection.calls[7].args[0]), /^RELEASE "sp_replace_oversized_cell_/);
            const guarded = connection.calls[4];
            assert.deepStrictEqual(guarded.args, [
                'native_large',
                'payload',
                { kind: 'rowid', value: 7 },
                'bounded',
                { storageClass: 'blob', byteLength: 2048 },
                1024
            ]);
            assert.ok(connection.calls.every(call => (
                call.method !== 'query'
                || !/SELECT\s+"payload"/i.test(String(call.args[0]))
            )));
        } finally {
            connection.dispose();
        }
    });

    it('refuses an unconfirmed oversized native prior using metadata only', async () => {
        const connection = await createRecordingConnection(call => {
            if (call.method === 'open') return { result: { success: true } };
            if (call.method === 'run') return { result: { changes: 0 } };
            if (call.method === 'getCellMetadata') {
                return { result: { storageClass: 'blob', byteLength: 2048 } };
            }
            if (isRowIdAliasMetadataCall(call)) return noRowIdAliasResponse();
            throw new Error(`unexpected native call: ${call.method}`);
        });
        try {
            connection.calls.length = 0;
            await assert.rejects(
                connection.databaseOps.updateCell(
                    'native_large', 7, 'payload', 'bounded', undefined, 1024
                ),
                error => {
                    assert.ok(error instanceof OversizedCellReplacementRequiredError);
                    assert.strictEqual(error.actualBytes, 2048);
                    return true;
                }
            );
            assert.deepStrictEqual(
                connection.calls.map(call => call.method),
                ['query', 'run', 'query', 'queryBatch', 'run', 'getCellMetadata', 'run', 'run']
            );
            const runSql = connection.calls
                .filter(call => call.method === 'run')
                .map(call => String(call.args[0]));
            assert.match(runSql[0], /^SAVEPOINT "sp_update_rowid_cell_/);
            assert.strictEqual(runSql[1], 'UPDATE main."native_large" SET "payload" = ? WHERE rowid = ? AND NOT (typeof("payload") IN (\'text\', \'blob\') AND length(CAST("payload" AS BLOB)) > ?)');
            assert.strictEqual(runSql[2], `ROLLBACK TO ${runSql[0].slice('SAVEPOINT '.length)}`);
            assert.strictEqual(runSql[3], `RELEASE ${runSql[0].slice('SAVEPOINT '.length)}`);
        } finally {
            connection.dispose();
        }
    });

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
            mockProcess.stdin = new EventEmitter();
            mockProcess.stdin.write = stdinWriteMock;
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

        const databasePath = path.join(tempDir, 'unopenable.sqlite');
        const fileUri = { fsPath: databasePath } as any;
        await assert.rejects(
            bundle.establishConnection(fileUri, 'TestDB'),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(
                    error.message,
                    /Failed to open database "TestDB": SQLITE_CANTOPEN: unable to open database file/
                );
                assert.match(error.message, new RegExp(`Path: ${databasePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
                return true;
            }
        );

        bundle.workerMethods[Symbol.dispose]();
    });

    it('undoes a guarded native JSON patch while preserving an untouched sibling', async () => {
        const prior = JSON.stringify({ status: 'draft', owner: 'ada' });
        const patch = JSON.stringify({ status: 'published' });
        const post = JSON.stringify({ status: 'published', owner: 'ada' });
        const current = JSON.stringify({ status: 'published', owner: 'ada', reviewer: 'grace' });
        const restored = JSON.stringify({ status: 'draft', owner: 'ada', reviewer: 'grace' });
        let stateReadCount = 0;
        const connection = await createRecordingConnection(call => {
            if (call.method === 'query') {
                stateReadCount += 1;
                return {
                    result: {
                        columns: ['storage_class', 'payload'],
                        values: [['text', stateReadCount === 1 ? current : restored]]
                    }
                };
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
                priorValue: prior,
                newValue: patch,
                operation: 'json_patch',
                priorState: { storageClass: 'text', value: prior },
                postState: { storageClass: 'text', value: post }
            });

            const operationCalls = withoutTextEncodingReads(connection.calls);
            assertSingleTextEncodingRead(connection.calls);
            assert.deepStrictEqual(
                operationCalls.map(call => call.method),
                ['query', 'run', 'queryBatch', 'query', 'run', 'query', 'run']
            );
            assert.match(String(operationCalls[1].args[0]), /^SAVEPOINT "sp_replay_cell_history_/);
            assert.strictEqual(isUpdateTriggerGuardCall(operationCalls[2]), true);

            const update = operationCalls[4];
            const [sql, params] = update.args as [string, unknown[]];
            assert.match(sql, /^UPDATE main\."docs" SET "payload" = CAST\(\? AS TEXT\) WHERE rowid = \?/);
            assert.match(sql, /typeof\("payload"\) = 'text'/);
            assert.deepStrictEqual(JSON.parse(params[0] as string), {
                status: 'draft',
                owner: 'ada',
                reviewer: 'grace'
            });
            assert.strictEqual(params[1], 7);
            assert.strictEqual(params[2], current);
        } finally {
            connection.dispose();
        }
    });

    it('rejects native JSON undo when a touched path changed externally', async () => {
        const prior = JSON.stringify({ status: 'draft', owner: 'ada' });
        const patch = JSON.stringify({ status: 'published' });
        const post = JSON.stringify({ status: 'published', owner: 'ada' });
        const external = JSON.stringify({ status: 'external', owner: 'ada', reviewer: 'grace' });
        const connection = await createRecordingConnection(call => {
            if (call.method === 'query') {
                return {
                    result: {
                        columns: ['storage_class', 'payload'],
                        values: [['text', external]]
                    }
                };
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        try {
            connection.calls.length = 0;
            await assert.rejects(
                connection.databaseOps.undoModification({
                    modificationType: 'cell_update',
                    description: 'undo payload',
                    targetTable: 'docs',
                    targetRowId: 7,
                    targetColumn: 'payload',
                    priorValue: prior,
                    newValue: patch,
                    operation: 'json_patch',
                    priorState: { storageClass: 'text', value: prior },
                    postState: { storageClass: 'text', value: post }
                }),
                /changed outside SQLite Explorer history/i
            );

            const operationCalls = withoutTextEncodingReads(connection.calls);
            assertSingleTextEncodingRead(connection.calls);
            assert.deepStrictEqual(
                operationCalls.map(call => call.method),
                ['query', 'run', 'queryBatch', 'query', 'run', 'run']
            );
            assert.strictEqual(
                connection.calls.some(call => (
                    call.method === 'run' && /^UPDATE /.test(String(call.args[0]))
                )),
                false
            );
            assert.match(String(operationCalls[4].args[0]), /^ROLLBACK TO /);
            assert.match(String(operationCalls[5].args[0]), /^RELEASE /);
        } finally {
            connection.dispose();
        }
    });

    it('rejects native set undo when the guarded UPDATE loses a post-read race', async () => {
        const connection = await createRecordingConnection(call => {
            if (call.method === 'query') {
                return {
                    result: {
                        columns: ['storage_class', 'value'],
                        values: [['text', 'after']]
                    }
                };
            }
            if (call.method === 'run' && /^UPDATE /.test(String(call.args[0]))) {
                return { result: { changes: 0 } };
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        try {
            connection.calls.length = 0;
            await assert.rejects(
                connection.databaseOps.undoModification({
                    modificationType: 'cell_update',
                    description: 'undo set',
                    targetTable: 'docs',
                    targetRowId: 7,
                    targetColumn: 'value',
                    newValue: 'after',
                    operation: 'set',
                    priorState: { storageClass: 'text', value: 'before' },
                    postState: { storageClass: 'text', value: 'after' }
                }),
                /changed outside SQLite Explorer history/i
            );

            const update = connection.calls.find(call => (
                call.method === 'run' && /^UPDATE /.test(String(call.args[0]))
            ));
            assert.ok(update);
            const [sql, params] = update.args as [string, unknown[]];
            assert.strictEqual(
                sql,
                `UPDATE main."docs" SET "value" = CAST(? AS TEXT) WHERE rowid = ? AND ` +
                `(typeof("value") = 'text' AND CAST("value" AS BLOB) = CAST(? AS BLOB))`
            );
            assert.deepStrictEqual(params, ['before', 7, 'after']);
            const operationCalls = withoutTextEncodingReads(connection.calls);
            assertSingleTextEncodingRead(connection.calls);
            assert.deepStrictEqual(
                operationCalls.map(call => call.method),
                ['query', 'run', 'queryBatch', 'query', 'run', 'run', 'run']
            );
            assert.match(String(operationCalls[5].args[0]), /^ROLLBACK TO /);
            assert.match(String(operationCalls[6].args[0]), /^RELEASE /);
        } finally {
            connection.dispose();
        }
    });

    it('undoes a guarded native JSON batch inside one replay savepoint', async () => {
        const currents: Record<number, unknown> = {
            3: { count: 2, stable: 'one', concurrent: 'a' },
            4: { count: 11, stable: 'two', concurrent: 'b' }
        };
        const restored: Record<number, unknown> = {
            3: { count: 1, stable: 'one', concurrent: 'a' },
            4: { count: 10, stable: 'two', concurrent: 'b' }
        };
        const updatedRows = new Set<number>();
        const connection = await createRecordingConnection((call) => {
            if (call.method === 'query') {
                const rowId = Number((call.args[1] as unknown[])[0]);
                return {
                    result: {
                        columns: ['storage_class', 'payload'],
                        values: [[
                            'text',
                            JSON.stringify(updatedRows.has(rowId) ? restored[rowId] : currents[rowId])
                        ]]
                    }
                };
            }
            if (call.method === 'run' && /^UPDATE /.test(String(call.args[0]))) {
                updatedRows.add(Number((call.args[1] as unknown[])[1]));
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
                        operation: 'json_patch',
                        priorState: {
                            storageClass: 'text',
                            value: JSON.stringify({ count: 1, stable: 'one' })
                        },
                        postState: {
                            storageClass: 'text',
                            value: JSON.stringify({ count: 2, stable: 'one' })
                        }
                    },
                    {
                        rowId: 4,
                        columnName: 'payload',
                        priorValue: JSON.stringify({ count: 10, stable: 'two' }),
                        newValue: JSON.stringify({ count: 11 }),
                        operation: 'json_patch',
                        priorState: {
                            storageClass: 'text',
                            value: JSON.stringify({ count: 10, stable: 'two' })
                        },
                        postState: {
                            storageClass: 'text',
                            value: JSON.stringify({ count: 11, stable: 'two' })
                        }
                    }
                ]
            });

            const operationCalls = withoutTextEncodingReads(connection.calls);
            assertSingleTextEncodingRead(connection.calls);
            const queryCalls = operationCalls.filter(call => call.method === 'query');
            const queryBatchCalls = connection.calls.filter(call => call.method === 'queryBatch');
            assert.deepStrictEqual(
                operationCalls.map(call => call.method),
                [
                    'query',
                    'run',
                    'queryBatch',
                    'query',
                    'run',
                    'query',
                    'query',
                    'run',
                    'query',
                    'run'
                ]
            );
            assert.strictEqual(queryCalls.length, 5);
            assert.strictEqual(queryBatchCalls.length, 1);
            assert.strictEqual(isUpdateTriggerGuardCall(queryBatchCalls[0]), true);
            assert.match(String(operationCalls[1].args[0]), /^SAVEPOINT "sp_replay_cell_history_/);
            assert.match(String(operationCalls.at(-1)?.args[0]), /^RELEASE "sp_replay_cell_history_/);
            const updates = connection.calls.filter(call => (
                call.method === 'run' && /^UPDATE /.test(String(call.args[0]))
            ));
            assert.strictEqual(updates.length, 2);
            assert.deepStrictEqual(JSON.parse((updates[0].args[1] as unknown[])[0] as string), restored[3]);
            assert.deepStrictEqual(JSON.parse((updates[1].args[1] as unknown[])[0] as string), restored[4]);
        } finally {
            connection.dispose();
        }
    });

    it('serializes overlapping undoModification and updateCell worker messages', async () => {
        // The undo read is intentionally held open. A public updateCell call
        // started during that read must wait until undo has also written, so the
        // undo read/write sequence remains contiguous at the worker boundary.
        const prior = JSON.stringify({ status: 'draft', owner: 'ada' });
        const patch = JSON.stringify({ status: 'published' });
        const post = JSON.stringify({ status: 'published', owner: 'ada' });
        const current = JSON.stringify({ status: 'published', owner: 'ada', reviewer: 'grace' });
        const restored = JSON.stringify({ status: 'draft', owner: 'ada', reviewer: 'grace' });
        const queryStarted = createDeferred<void>();
        const queryResponse = createDeferred<RecordedNativeResponse>();
        let replayStateReadCount = 0;
        const connection = await createRecordingConnection((call) => {
            const sql = String(call.args[0]);
            if (
                call.method === 'query'
                && sql.startsWith(`SELECT typeof("payload"), CASE WHEN typeof("payload") = 'text'`)
                && sql.includes(`FROM main."docs" WHERE rowid = ?`)
            ) {
                replayStateReadCount += 1;
                if (replayStateReadCount === 1) {
                    queryStarted.resolve();
                    return queryResponse.promise;
                }
                return {
                    result: {
                        columns: ['storage_class', 'payload'],
                        values: [['text', new TextEncoder().encode(restored)]]
                    }
                };
            }
            if (isRowIdAliasMetadataCall(call)) return noRowIdAliasResponse();
            if (isPostUpdateRowIdCall(call)) return updatedRowIdResponse(7);
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        let undoPromise: Promise<void> | undefined;
        let updatePromise: Promise<unknown> | undefined;
        try {
            connection.calls.length = 0;
            undoPromise = connection.databaseOps.undoModification({
                modificationType: 'cell_update',
                description: 'undo payload',
                targetTable: 'docs',
                targetRowId: 7,
                targetColumn: 'payload',
                priorValue: prior,
                newValue: patch,
                operation: 'json_patch',
                priorState: { storageClass: 'text', value: prior },
                postState: { storageClass: 'text', value: post }
            });

            await queryStarted.promise;
            updatePromise = connection.databaseOps.updateCell('docs', 7, 'payload', '{"status":"manual"}');
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setImmediate(resolve));

            try {
                const operationCalls = withoutTextEncodingReads(connection.calls);
                assertSingleTextEncodingRead(connection.calls);
                assert.deepStrictEqual(
                    operationCalls.map(call => call.method),
                    ['query', 'run', 'queryBatch', 'query'],
                    'concurrent updateCell must not write while undo is between read and write'
                );
            } finally {
                queryResponse.resolve({
                    result: {
                        columns: ['storage_class', 'payload'],
                        values: [['text', new TextEncoder().encode(current)]]
                    }
                });
                await Promise.allSettled([undoPromise, updatePromise]);
            }

            const operationCalls = withoutTextEncodingReads(connection.calls);
            assertSingleTextEncodingRead(connection.calls);
            assert.deepStrictEqual(
                operationCalls.map(call => call.method),
                [
                    'query', 'run', 'queryBatch', 'query', 'run', 'query', 'run',
                    'query', 'run', 'query', 'queryBatch', 'run', 'query', 'run'
                ]
            );
            const runCalls = connection.calls.filter(call => call.method === 'run');
            const runSql = runCalls.map(call => String(call.args[0]));
            assert.match(runSql[0], /^SAVEPOINT "sp_replay_cell_history_/);
            assert.match(runSql[1], /^UPDATE main\."docs" SET "payload" = CAST\(\? AS TEXT\)/);
            assert.match(runSql[2], /^RELEASE "sp_replay_cell_history_/);
            assert.match(runSql[3], /^SAVEPOINT "sp_update_rowid_cell_/);
            assert.strictEqual(runSql[4], 'UPDATE main."docs" SET "payload" = ? WHERE rowid = ?');
            assert.match(runSql[5], /^RELEASE "sp_update_rowid_cell_/);
            const undoRun = runCalls[1];
            const updateRun = runCalls[4];
            assert.deepStrictEqual(JSON.parse((undoRun.args as [string, unknown[]])[1][0] as string), {
                status: 'draft',
                owner: 'ada',
                reviewer: 'grace'
            });
            assert.deepStrictEqual((updateRun.args as [string, unknown[]])[1], ['{"status":"manual"}', 7]);
        } finally {
            queryResponse.resolve({
                result: {
                    columns: ['storage_class', 'payload'],
                    values: [['text', new TextEncoder().encode(current)]]
                }
            });
            if (undoPromise || updatePromise) {
                await Promise.allSettled([undoPromise, updatePromise].filter(Boolean) as Promise<unknown>[]);
            }
            connection.dispose();
        }
    });

    it('redoes a guarded native JSON patch only from its recorded prior state', async () => {
        const prior = JSON.stringify({ meta: { reviewed: false }, owner: 'ada' });
        const patch = JSON.stringify({ meta: { reviewed: true } });
        const post = JSON.stringify({ meta: { reviewed: true }, owner: 'ada' });
        const current = JSON.stringify({
            meta: { reviewed: false },
            owner: 'ada',
            reviewer: 'grace'
        });
        const replayed = JSON.stringify({
            meta: { reviewed: true },
            owner: 'ada',
            reviewer: 'grace'
        });
        let stateReadCount = 0;
        const connection = await createRecordingConnection(call => {
            if (call.method === 'query') {
                stateReadCount += 1;
                return {
                    result: {
                        columns: ['storage_class', 'payload'],
                        values: [['text', stateReadCount === 1 ? current : replayed]]
                    }
                };
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        try {
            connection.calls.length = 0;

            await connection.databaseOps.redoModification({
                modificationType: 'cell_update',
                description: 'Patch payload',
                targetTable: 'docs',
                targetRowId: 7,
                targetColumn: 'payload',
                newValue: patch,
                operation: 'json_patch',
                priorState: { storageClass: 'text', value: prior },
                postState: { storageClass: 'text', value: post }
            });

            const operationCalls = withoutTextEncodingReads(connection.calls);
            assertSingleTextEncodingRead(connection.calls);
            assert.strictEqual(operationCalls.length, 7);
            assert.match(String(operationCalls[1].args[0]), /^SAVEPOINT "sp_replay_cell_history_/);
            assert.strictEqual(isUpdateTriggerGuardCall(operationCalls[2]), true);
            assert.strictEqual(operationCalls[3].method, 'query');
            assert.match(String(operationCalls[6].args[0]), /^RELEASE "sp_replay_cell_history_/);
            const call = operationCalls[4];
            assert.strictEqual(call.method, 'run');

            const [sql, params] = call.args as [string, unknown[]];
            assert.match(sql, /^UPDATE main\."docs" SET "payload" = CAST\(\? AS TEXT\)/);
            assert.match(sql, /typeof\("payload"\) = 'text'/);
            assert.deepStrictEqual(JSON.parse(params[0] as string), JSON.parse(replayed));
            assert.strictEqual(params[1], 7);
            assert.strictEqual(params[2], current);
        } finally {
            connection.dispose();
        }
    });

    it('redoes guarded native JSON and set cells as one atomic batch', async () => {
        const valuesBefore: Record<number, string> = {
            3: '{}',
            4: '{}',
            5: 'Old title'
        };
        const valuesAfter: Record<number, string> = {
            3: JSON.stringify({ status: 'reviewed' }),
            4: JSON.stringify({ status: 'approved' }),
            5: 'Plain title'
        };
        const updatedRows = new Set<number>();
        const connection = await createRecordingConnection(call => {
            if (call.method === 'query') {
                const rowId = Number((call.args[1] as unknown[])[0]);
                return {
                    result: {
                        columns: ['storage_class', 'value'],
                        values: [['text', updatedRows.has(rowId) ? valuesAfter[rowId] : valuesBefore[rowId]]]
                    }
                };
            }
            if (call.method === 'run' && /^UPDATE /.test(String(call.args[0]))) {
                updatedRows.add(Number((call.args[1] as unknown[])[1]));
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        try {
            const firstPatch = JSON.stringify({ status: 'reviewed' });
            const secondPatch = JSON.stringify({ status: 'approved' });
            connection.calls.length = 0;

            await connection.databaseOps.redoModification({
                modificationType: 'cell_update',
                description: 'Batch patch payloads',
                targetTable: 'docs',
                affectedCells: [
                    {
                        rowId: 3,
                        columnName: 'payload',
                        newValue: firstPatch,
                        operation: 'json_patch',
                        priorState: { storageClass: 'text', value: valuesBefore[3] },
                        postState: { storageClass: 'text', value: valuesAfter[3] }
                    },
                    {
                        rowId: 4,
                        columnName: 'payload',
                        newValue: secondPatch,
                        operation: 'json_patch',
                        priorState: { storageClass: 'text', value: valuesBefore[4] },
                        postState: { storageClass: 'text', value: valuesAfter[4] }
                    },
                    {
                        rowId: 5,
                        columnName: 'title',
                        newValue: 'Plain title',
                        priorState: { storageClass: 'text', value: valuesBefore[5] },
                        postState: { storageClass: 'text', value: valuesAfter[5] }
                    }
                ]
            });

            const operationCalls = withoutTextEncodingReads(connection.calls);
            assertSingleTextEncodingRead(connection.calls);
            assert.strictEqual(operationCalls.length, 13);
            assert.strictEqual(operationCalls[1].method, 'run');
            assert.match(String(operationCalls[1].args[0]), /^SAVEPOINT "sp_replay_cell_history_/);
            assert.strictEqual(isUpdateTriggerGuardCall(operationCalls[2]), true);
            assert.match(String(operationCalls.at(-1)?.args[0]), /^RELEASE "sp_replay_cell_history_/);
            const updates = connection.calls.filter(call => (
                call.method === 'run' && /^UPDATE /.test(String(call.args[0]))
            ));
            assert.strictEqual(updates.length, 3);
            assert.deepStrictEqual(
                updates.map(call => (call.args[1] as unknown[]).slice(0, 2)),
                [
                    [valuesAfter[3], 3],
                    [valuesAfter[4], 4],
                    [valuesAfter[5], 5]
                ]
            );
            assert.ok(updates.every(call => /typeof\(/.test(String(call.args[0]))));
        } finally {
            connection.dispose();
        }
    });

    it('replays column_drop redo by dropping recorded dependent indexes first', async () => {
        const connection = await createRecordingConnection(call => {
            if (call.method === 'query') {
                const sql = String(call.args[0]);
                if (sql === ROWID_TABLE_AUTHORITY_SQL) {
                    return { result: { columns: ['1'], values: [[1]] } };
                }
                if (sql.includes('sqlite_schema')) {
                    return {
                        result: {
                            columns: ['type', 'name', 'sql'],
                            values: [['table', 'docs', 'CREATE TABLE docs (id INTEGER PRIMARY KEY)']]
                        }
                    };
                }
                if (sql === TABLE_XINFO_WITH_ROWID_ALIAS_SQL) {
                    return {
                        result: {
                            columns: [
                                'cid',
                                'name',
                                'type',
                                'notnull',
                                'dflt_value',
                                'pk',
                                'hidden',
                                'is_rowid_alias'
                            ],
                            values: [[0, 'id', 'INTEGER', 0, null, 1, 0, 1]]
                        }
                    };
                }
                if (sql.includes('pragma_table_list')) {
                    return {
                        result: {
                            columns: ['type', 'wr'],
                            values: [['table', 0]]
                        }
                    };
                }
                if (sql === 'PRAGMA data_version') {
                    return { result: { columns: ['data_version'], values: [[1]] } };
                }
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        try {
            connection.calls.length = 0;

            await connection.databaseOps.redoModification({
                modificationType: 'column_drop',
                description: 'Drop indexed payload',
                targetTable: 'docs',
                deletedColumns: [{ name: 'payload', type: 'TEXT', data: [] }],
                droppedIndexes: ['idx_docs_payload']
            });

            assert.deepStrictEqual(
                connection.calls
                    .filter(call => call.method === 'run')
                    .map(call => String(call.args[0]))
                    .slice(1, -1),
                [
                    `DROP INDEX IF EXISTS main."idx_docs_payload"`,
                    `ALTER TABLE main."docs" DROP COLUMN "payload"`
                ]
            );
        } finally {
            connection.dispose();
        }
    });

    it('captures native post-drop state before releasing the delete savepoint', async () => {
        const connection = await createRecordingConnection(call => {
            if (call.method === 'query') {
                const sql = String(call.args[0]);
                if (sql.includes('sqlite_schema')) {
                    return {
                        result: {
                            columns: ['type', 'name', 'sql'],
                            values: [['table', 'docs', 'CREATE TABLE docs (id INTEGER PRIMARY KEY)']]
                        }
                    };
                }
                if (sql === TABLE_XINFO_WITH_ROWID_ALIAS_SQL) {
                    return {
                        result: {
                            columns: [
                                'cid',
                                'name',
                                'type',
                                'notnull',
                                'dflt_value',
                                'pk',
                                'hidden',
                                'is_rowid_alias'
                            ],
                            values: [[0, 'id', 'INTEGER', 0, null, 1, 0, 1]]
                        }
                    };
                }
                if (sql.includes('pragma_table_list')) {
                    return {
                        result: {
                            columns: ['type', 'wr'],
                            values: [['table', 0]]
                        }
                    };
                }
                if (sql === 'PRAGMA data_version') {
                    return { result: { columns: ['data_version'], values: [[1]] } };
                }
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        try {
            connection.calls.length = 0;

            const stateAfter = await connection.databaseOps.deleteColumns(
                'docs',
                ['payload'],
                ['idx_docs_payload']
            );

            assert.deepStrictEqual(stateAfter, {
                tableSql: 'CREATE TABLE docs (id INTEGER PRIMARY KEY)',
                columns: ['id'],
                identity: { kind: 'rowid' },
                schemaObjects: [],
                dataVersion: 1
            });
            assert.deepStrictEqual(
                connection.calls.map(call => call.method),
                ['run', 'run', 'run', 'query', 'query', 'query', 'query', 'query', 'run']
            );
            assert.match(String(connection.calls[0].args[0]), /^SAVEPOINT /);
            assert.strictEqual(
                connection.calls[1].args[0],
                'DROP INDEX IF EXISTS main."idx_docs_payload"'
            );
            assert.strictEqual(
                connection.calls[2].args[0],
                'ALTER TABLE main."docs" DROP COLUMN "payload"'
            );
            assert.match(String(connection.calls.at(-1)?.args[0]), /^RELEASE /);
        } finally {
            connection.dispose();
        }
    });

    it('rolls back the native column drop when post-drop capture fails', async () => {
        const connection = await createRecordingConnection(call => {
            if (
                call.method === 'query'
                && String(call.args[0]).includes('sqlite_schema')
            ) {
                throw new Error('post-drop snapshot failed');
            }
            return { result: { columns: [], values: [] } };
        });

        try {
            connection.calls.length = 0;

            await assert.rejects(
                connection.databaseOps.deleteColumns('docs', ['payload']),
                /post-drop snapshot failed/
            );

            const runSql = connection.calls
                .filter(call => call.method === 'run')
                .map(call => String(call.args[0]));
            assert.match(runSql[0], /^SAVEPOINT /);
            assert.strictEqual(runSql[1], 'ALTER TABLE main."docs" DROP COLUMN "payload"');
            assert.strictEqual(runSql[2], `ROLLBACK TO ${runSql[0].slice('SAVEPOINT '.length)}`);
            assert.strictEqual(runSql[3], `RELEASE ${runSql[0].slice('SAVEPOINT '.length)}`);
        } finally {
            connection.dispose();
        }
    });

    it('terminates line-comment view bodies before native wrapped compile and preview queries', async () => {
        const body = 'SELECT MAX(quantity) AS m FROM inventory -- rollup of stock';
        const connection = await createRecordingConnection(call => {
            if (call.method === 'query') {
                const sql = String(call.args[0]);
                if (sql.startsWith('PRAGMA main.table_xinfo')) {
                    return { result: { columns: ['cid', 'name', 'hidden'], values: [[0, 'm', 0]] } };
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

            await connection.databaseOps.validateViewDefinition('inventory_rollup', body, 'create');
            const preview = await connection.databaseOps.previewViewDefinition(
                'inventory_rollup',
                body,
                10,
                'create'
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
                connection.databaseOps.validateViewDefinition(
                    'parameter_view',
                    'SELECT ? AS value',
                    'create'
                ),
                /parameters are not allowed in views/
            );

            const calls = connection.calls
                .filter(call => call.method === 'run' || call.method === 'runSingle')
                .map(call => ({
                    method: call.method,
                    sql: String(call.method === 'runSingle' ? call.args[1] : call.args[0])
                }));
            assert.match(calls[0].sql, /^SAVEPOINT "sp_validate_view_/);
            assert.strictEqual(calls[1].method, 'runSingle');
            assert.match(calls[1].sql, /^CREATE VIEW "parameter_view" AS SELECT \? AS value$/);
            assert.match(calls[2].sql, /^ROLLBACK TO "sp_validate_view_/);
            assert.match(calls[3].sql, /^RELEASE "sp_validate_view_/);
        } finally {
            connection.dispose();
        }
    });

    it('rejects native view operations before reaching a read-only connection', async () => {
        const connection = await createRecordingConnection(
            undefined,
            undefined,
            30000,
            true
        );
        try {
            const callsBefore = connection.calls.length;
            await assert.rejects(
                connection.databaseOps.validateViewDefinition(
                    'read_only_view',
                    'SELECT 1',
                    'create'
                ),
                /View validation is unavailable because the database is read-only/
            );
            await assert.rejects(
                connection.databaseOps.previewViewDefinition(
                    'read_only_view',
                    'SELECT 1',
                    10,
                    'create'
                ),
                /View preview is unavailable because the database is read-only/
            );
            await assert.rejects(
                connection.databaseOps.createView('read_only_create', 'SELECT 1'),
                /View creation is unavailable because the database is read-only/
            );
            await assert.rejects(
                connection.databaseOps.editView('read_only_edit', 'SELECT 2'),
                /View editing is unavailable because the database is read-only/
            );
            await assert.rejects(
                connection.databaseOps.dropView('read_only_drop'),
                /View deletion is unavailable because the database is read-only/
            );
            assert.deepStrictEqual(
                connection.calls.slice(callsBefore),
                [],
                'read-only view operations must not reach the native worker'
            );
        } finally {
            connection.dispose();
        }
    });

    it('rejects unusable created identifiers before reaching the native worker', async () => {
        const connection = await createRecordingConnection();
        const column = {
            name: 'value',
            type: 'TEXT',
            primaryKey: false,
            notNull: false
        };
        try {
            connection.calls.length = 0;

            await assert.rejects(
                connection.databaseOps.createTable('', [column]),
                /Table name is required/
            );
            await assert.rejects(
                connection.databaseOps.createTable(
                    'valid table',
                    [{ ...column, name: 'bad\0column' }]
                ),
                /Column name cannot contain NUL/
            );
            await assert.rejects(
                connection.databaseOps.addColumn('valid table', '', 'TEXT'),
                /Column name is required/
            );
            await assert.rejects(
                connection.databaseOps.validateViewDefinition(
                    'bad\0view',
                    'SELECT 1',
                    'create'
                ),
                /View name cannot contain NUL/
            );
            await assert.rejects(
                connection.databaseOps.previewViewDefinition('', 'SELECT 1', 10, 'create'),
                /View name is required/
            );
            await assert.rejects(
                connection.databaseOps.createView('bad\0view', 'SELECT 1'),
                /View name cannot contain NUL/
            );

            assert.deepStrictEqual(
                connection.calls,
                [],
                'unusable identifiers must not reach the native worker'
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
            if (call.method === 'query' && String(call.args[0]).startsWith('PRAGMA main.table_xinfo')) {
                return {
                    result: {
                        columns: ['cid', 'name', 'hidden'],
                        values: [[0, 'x', 0], [1, 'x:1', 0]]
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
                10,
                'create'
            );
            assert.deepStrictEqual(empty.headers, ['x', 'x:1']);
            assert.deepStrictEqual(empty.rows, []);

            const duplicate = await connection.databaseOps.previewViewDefinition(
                'preview_duplicate',
                'SELECT 1 AS x, 2 AS x',
                10,
                'create'
            );
            assert.deepStrictEqual(duplicate.headers, ['x', 'x:1']);
            assert.deepStrictEqual(duplicate.rows, [[1, 2]]);
        } finally {
            connection.dispose();
        }
    });

    it('executes native preview through the disposable main view binding', async () => {
        const order: string[] = [];
        const connection = await createRecordingConnection(call => {
            if (call.method === 'run') {
                order.push(String(call.args[0]));
            }
            if (call.method === 'query'
                && String(call.args[0]).startsWith('PRAGMA main.table_xinfo')) {
                return {
                    result: {
                        columns: ['cid', 'name', 'hidden'],
                        values: [[0, 'value', 0]]
                    }
                };
            }
            if (call.method === 'queryBounded') {
                const sql = String(call.args[1]);
                order.push(`QUERY ${sql}`);
                return {
                    result: {
                        columns: ['value'],
                        values: [[sql.includes('main."preview_binding"') ? 'MAIN' : 'TEMP']]
                    }
                };
            }
            return { result: { columns: [], values: [] } };
        });

        try {
            connection.calls.length = 0;
            const preview = await connection.databaseOps.previewViewDefinition(
                'preview_binding',
                'SELECT value FROM shadowed_source',
                10,
                'create'
            );

            assert.deepStrictEqual(preview.rows, [['MAIN']]);
            const queryIndex = order.findIndex(entry => entry.startsWith('QUERY '));
            const rollbackIndex = order.findIndex(entry => entry.startsWith('ROLLBACK TO '));
            assert.ok(queryIndex >= 0);
            assert.ok(rollbackIndex > queryIndex, 'preview query must run before disposable-view rollback');
        } finally {
            connection.dispose();
        }
    });

    it('leaves transport margin for the native preview timeout message', async () => {
        const connection = await createRecordingConnection(async call => {
            if (call.method === 'query' && String(call.args[0]).startsWith('PRAGMA main.table_xinfo')) {
                return { result: { columns: ['cid', 'name', 'hidden'], values: [[0, 'value', 0]] } };
            }
            if (call.method === 'queryBounded') {
                assert.strictEqual(call.args[5], 7, 'preview row limit');
                assert.strictEqual(call.args[6], 10, 'worker execution timeout');
                await new Promise(resolve => setTimeout(resolve, 30));
                return { error: 'Query execution timed out after 10ms' };
            }
            return { result: { columns: [], values: [] } };
        }, undefined, 10);

        try {
            await assert.rejects(
                connection.databaseOps.previewViewDefinition(
                    'slow_preview',
                    'SELECT 1',
                    7,
                    'create'
                ),
                (error: unknown) => {
                    assert.ok(error instanceof Error);
                    assert.match(error.message, /Query execution timed out after 10ms/);
                    assert.strictEqual(
                        error instanceof InvocationTimeoutError,
                        false,
                        'the worker timeout must arrive before the transport deadline'
                    );
                    return true;
                }
            );
        } finally {
            connection.dispose();
        }
    });

    it('routes a superseded native preview abort to its bounded worker query', async () => {
        const queryStarted = createDeferred<RecordedNativeCall>();
        const queryResponse = createDeferred<RecordedNativeResponse>();
        const connection = await createRecordingConnection(call => {
            if (call.method === 'query' && String(call.args[0]).startsWith('PRAGMA main.table_xinfo')) {
                return { result: { columns: ['cid', 'name', 'hidden'], values: [[0, 'value', 0]] } };
            }
            if (call.method === 'queryBounded') {
                queryStarted.resolve(call);
                return queryResponse.promise;
            }
            return { result: { columns: [], values: [] } };
        });
        const controller = new AbortController();
        const cancellation = new DOMException('Superseded preview', 'AbortError');
        const preview = connection.databaseOps.previewViewDefinition(
            'cancelled_preview',
            'SELECT 1 AS value',
            10,
            'create',
            controller.signal
        );

        try {
            const queryCall = await queryStarted.promise;
            controller.abort(cancellation);
            await new Promise(resolve => setImmediate(resolve));

            const cancelCall = connection.calls.find(call => call.method === 'cancel');
            assert.ok(cancelCall, 'preview cancellation must reach the native worker');
            assert.deepStrictEqual(cancelCall.args, [queryCall.id]);
            queryResponse.resolve({
                error: '[queryBounded] Operation cancelled',
                cancelled: true
            });
            await assert.rejects(preview, error => error === cancellation);
        } finally {
            queryResponse.resolve({ error: 'test cleanup' });
            await preview.catch(() => {});
            connection.dispose();
        }
    });

    it('merges native and companion exact numeric text maps with native entries winning', async () => {
        const columns = ['rowid', ...Array.from({ length: 1000 }, (_, index) => `c${index}`)];
        // queryNumeric receives the bounded transport SELECT, whose final
        // private column packs one empty containment token per numeric value.
        const transportColumns = [
            ...columns,
            '__sqlite_explorer_cell_metadata',
            '__sqlite_explorer_cell_raw_text_0'
        ];
        const sourceRow = [
            1,
            1.25,
            2.5,
            ...Array.from({ length: 998 }, () => 0),
            '|'.repeat(columns.length - 1),
            null
        ];
        const connection = await createRecordingConnection(call => {
            if (call.method === 'queryNumeric') {
                return {
                    result: {
                        columns: transportColumns,
                        values: [sourceRow],
                        exactIntegerTexts: { 0: { 2: '2.50000000000001' } }
                    }
                };
            }
            if (
                call.method === 'query'
                && String(call.args[0]).startsWith('SELECT "type", "wr" FROM pragma.pragma_table_list')
            ) {
                return { result: { columns: ['type', 'wr'], values: [['table', 0]] } };
            }
            if (
                call.method === 'query'
                && String(call.args[0]).startsWith('SELECT 1 FROM pragma.pragma_table_list')
            ) {
                return { result: { columns: ['1'], values: [[1]] } };
            }
            if (call.method === 'query' && call.args[0] === 'PRAGMA encoding') {
                return { result: { columns: ['encoding'], values: [['UTF-8']] } };
            }
            if (call.method === 'queryBatch') {
                const [queries] = call.args as [Array<{ sql: string; params: unknown[] }>];
                return {
                    result: {
                        results: queries.map(query => {
                            const columnIndices = Array.from(
                                query.sql.matchAll(/AS "__sqlite_explorer_numeric_rowid_text_(\d+)"/g),
                                match => Number(match[1])
                            );
                            const row = [
                                1,
                                ...columnIndices.map(columnIndex => {
                                    if (columnIndex === 1) return '1.25000000000001';
                                    if (columnIndex === 2) return '2.50000000000000';
                                    return null;
                                })
                            ];
                            return { columns: [], values: [row] };
                        })
                    }
                };
            }
            if (
                call.method === 'query'
                && String(call.args[0]).includes('__sqlite_explorer_numeric_rowid')
            ) {
                throw new Error('native companions must use one queryBatch IPC call');
            }
            return { result: { columns: [], values: [] } };
        });

        try {
            const result = await connection.databaseOps.fetchTableData('wide_numeric_rows', {
                columns,
                limit: 1,
                offset: 0
            });
            assert.strictEqual(result.exactIntegerTexts?.[0]?.[1], '1.25000000000001');
            assert.strictEqual(
                result.exactIntegerTexts?.[0]?.[2],
                '2.50000000000001',
                'single-evaluation native sidecars must override companion reads'
            );

            const snapshotSavepointIndex = connection.calls.findIndex(call => (
                call.method === 'run'
                && /^SAVEPOINT "sp_numeric_snapshot_/.test(String(call.args[0]))
            ));
            const mainReadIndex = connection.calls.findIndex(call => call.method === 'queryNumeric');
            const authorityReadIndex = connection.calls.findIndex(call => (
                call.method === 'query'
                && String(call.args[0]).startsWith('SELECT 1 FROM pragma.pragma_table_list')
            ));
            const companionBatchIndices = connection.calls
                .map((call, index) => ({ call, index }))
                .filter(({ call }) => {
                    if (call.method !== 'queryBatch') return false;
                    const [queries] = call.args as [Array<{ sql: string }>];
                    return queries.some(query => query.sql.includes('__sqlite_explorer_numeric_rowid'));
                })
                .map(({ index }) => index);
            const snapshotReleaseIndex = connection.calls.findIndex(call => (
                call.method === 'run'
                && /^RELEASE "sp_numeric_snapshot_/.test(String(call.args[0]))
            ));

            assert.ok(snapshotSavepointIndex >= 0, 'wide native reads must open a snapshot savepoint');
            assert.ok(authorityReadIndex > snapshotSavepointIndex);
            assert.ok(mainReadIndex > authorityReadIndex);
            assert.deepStrictEqual(companionBatchIndices.length, 1);
            assert.ok(companionBatchIndices[0] > mainReadIndex);
            assert.ok(snapshotReleaseIndex > companionBatchIndices[0]);
        } finally {
            connection.dispose();
        }
    });

    it('rolls back and releases the native numeric snapshot when a companion read fails', async () => {
        const columns = ['rowid', ...Array.from({ length: 1000 }, (_, index) => `c${index}`)];
        const connection = await createRecordingConnection(call => {
            if (call.method === 'queryNumeric') {
                return {
                    result: {
                        columns,
                        values: [[1, 1.25, ...Array.from({ length: 999 }, () => 0)]]
                    }
                };
            }
            if (
                call.method === 'query'
                && String(call.args[0]).startsWith('SELECT "type", "wr" FROM pragma.pragma_table_list')
            ) {
                return { result: { columns: ['type', 'wr'], values: [['table', 0]] } };
            }
            if (
                call.method === 'query'
                && String(call.args[0]).startsWith('SELECT 1 FROM pragma.pragma_table_list')
            ) {
                return { result: { columns: ['1'], values: [[1]] } };
            }
            if (call.method === 'queryBatch') {
                throw new Error('companion read failed');
            }
            if (
                call.method === 'query'
                && String(call.args[0]).includes('__sqlite_explorer_numeric_rowid')
            ) {
                throw new Error('native companions must use one queryBatch IPC call');
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        try {
            await assert.rejects(
                connection.databaseOps.fetchTableData('wide_numeric_rows', {
                    columns,
                    limit: 1,
                    offset: 0
                }),
                /companion read failed/
            );

            const snapshotSql = connection.calls
                .filter(call => (
                    call.method === 'run'
                    && String(call.args[0]).includes('sp_numeric_snapshot_')
                ))
                .map(call => String(call.args[0]));
            assert.match(snapshotSql[0], /^SAVEPOINT "sp_numeric_snapshot_/);
            assert.match(snapshotSql[1], /^ROLLBACK TO "sp_numeric_snapshot_/);
            assert.match(snapshotSql[2], /^RELEASE "sp_numeric_snapshot_/);
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
                connection.databaseOps.previewViewDefinition(
                    'unsafe_preview',
                    body,
                    10,
                    'create'
                ),
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
                            if (query.sql.startsWith(
                                "SELECT sql FROM main.sqlite_schema WHERE type = 'view'"
                            )) {
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
                            { columns: ['name', 'sql'], values: [] },
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
            if (call.method === 'queryBatch') {
                return {
                    result: {
                        results: [
                            { columns: ['sql'], values: [] },
                            { columns: ['name', 'sql'], values: [] },
                            { columns: ['name', 'sql'], values: [] }
                        ]
                    }
                };
            }
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
                            { columns: ['name', 'sql'], values: [] },
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
                call.method === 'run' && call.args[0] === 'DROP VIEW main."opaque_view"'
            )));
        } finally {
            connection.dispose();
        }
    });

    it('captures the native drop snapshot inside the drop savepoint', async () => {
        const connection = await createRecordingConnection(call => {
            if (call.method === 'queryBatch') {
                return {
                    result: {
                        results: [
                            {
                                columns: ['sql'],
                                values: [['CREATE VIEW drop_order_view AS SELECT 1 AS value']]
                            },
                            { columns: ['name', 'sql'], values: [] },
                            { columns: ['name', 'sql'], values: [] }
                        ]
                    }
                };
            }
            return { result: { changes: 1, lastInsertRowId: 1 } };
        });

        try {
            connection.calls.length = 0;
            const dropped = await connection.databaseOps.dropView('drop_order_view');
            const order = connection.calls.flatMap(call => {
                const sql = String(call.args[0] ?? '');
                if (call.method === 'run' && /^SAVEPOINT "sp_drop_view_/.test(sql)) {
                    return ['savepoint'];
                }
                if (call.method === 'queryBatch') return ['snapshot'];
                if (call.method === 'run' && sql === 'DROP VIEW main."drop_order_view"') {
                    return ['drop'];
                }
                if (call.method === 'run' && /^RELEASE "sp_drop_view_/.test(sql)) {
                    return ['release'];
                }
                return [];
            });

            assert.strictEqual(dropped.selectSql, 'SELECT 1 AS value');
            assert.deepStrictEqual(order, ['savepoint', 'snapshot', 'drop', 'release']);
        } finally {
            connection.dispose();
        }
    });

    it('fails closed when native view undo lacks its definition', async () => {
        const outputLines: string[] = [];
        const outputChannel = {
            appendLine(line: string) {
                outputLines.push(line);
            }
        } as unknown as vscode.OutputChannel;
        const connection = await createRecordingConnection(undefined, outputChannel);
        try {
            await assert.rejects(
                connection.databaseOps.undoModification({
                    modificationType: 'view_edit',
                    description: 'legacy edit',
                    targetTable: 'legacy_view'
                }),
                /Cannot undo view_edit: missing view definition/
            );
            assert.deepStrictEqual(outputLines, []);
        } finally {
            connection.dispose();
        }
    });

    it('fails closed when native view redo lacks its definition', async () => {
        const outputLines: string[] = [];
        const outputChannel = {
            appendLine(line: string) {
                outputLines.push(line);
            }
        } as unknown as vscode.OutputChannel;
        const connection = await createRecordingConnection(undefined, outputChannel);
        try {
            await assert.rejects(
                connection.databaseOps.redoModification({
                    modificationType: 'view_edit',
                    description: 'legacy edit',
                    targetTable: 'legacy_view'
                }),
                /Cannot redo view_edit: missing view definition/
            );
            assert.deepStrictEqual(outputLines, []);
        } finally {
            connection.dispose();
        }
    });

    it('recreates captured temp-schema triggers as TEMP through the native worker', async () => {
        let currentViewSql = 'CREATE VIEW "temp native view" AS SELECT value FROM source_rows';
        const storedTriggerSql = [
            'CREATE TRIGGER "temp native insert"',
            'INSTEAD OF INSERT ON "temp native view"',
            'BEGIN SELECT 1; END'
        ].join(' ');
        const replayTriggerSql = buildCreateViewTriggerSql({
            identifier: 'temp native insert',
            sql: storedTriggerSql,
            temporary: true
        });
        let tempTriggerPresent = true;

        const connection = await createRecordingConnection(call => {
            if (call.method === 'queryBatch') {
                const [queries] = call.args as [Array<{ sql: string }>];
                return {
                    result: {
                        results: queries.map(query => {
                            if (query.sql.startsWith(
                                "SELECT sql FROM main.sqlite_schema WHERE type = 'view'"
                            )) {
                                return { columns: ['sql'], values: [[currentViewSql]] };
                            }
                            if (query.sql.includes('sqlite_temp_schema')) {
                                return {
                                    columns: ['name', 'sql', 'temp_view_exists'],
                                    values: tempTriggerPresent
                                        ? [['temp native insert', storedTriggerSql, 0]]
                                        : []
                                };
                            }
                            return { columns: ['name', 'sql'], values: [] };
                        })
                    }
                };
            }
            if (call.method === 'run' || call.method === 'runSingle') {
                const sql = String(call.method === 'run' ? call.args[0] : call.args[1]);
                if (sql === 'DROP VIEW main."temp native view"') {
                    tempTriggerPresent = false;
                } else if (sql.startsWith('CREATE VIEW "temp native view"')) {
                    currentViewSql = sql;
                } else if (sql === replayTriggerSql) {
                    tempTriggerPresent = true;
                }
            }
            if (call.method === 'query') {
                const sql = String(call.args[0]);
                if (sql.includes('pragma_table_xinfo')) {
                    return { result: { columns: ['name'], values: [['value']] } };
                }
                if (sql.startsWith('EXPLAIN ')) {
                    return {
                        result: {
                            columns: ['addr', 'opcode', 'p1', 'p2', 'p3', 'p4', 'p5', 'comment'],
                            values: [[0, 'Init', 0, 1, 0, null, 0, '-- TRIGGER temp native insert']]
                        }
                    };
                }
            }
            return { result: { columns: [], values: [] } };
        });

        try {
            connection.calls.length = 0;
            const result = await connection.databaseOps.editView(
                'temp native view',
                'SELECT value * 2 AS value FROM source_rows',
                true
            );

            assert.strictEqual(result.before.triggers[0].temporary, true);
            assert.strictEqual(result.after.triggers[0].temporary, true);
            assert.ok(connection.calls.some(call => (
                call.method === 'runSingle' && call.args[1] === replayTriggerSql
            )));
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
                            if (query.sql.startsWith(
                                "SELECT sql FROM main.sqlite_schema WHERE type = 'view'"
                            )) {
                                return { columns: ['sql'], values: [[currentViewSql]] };
                            }
                            if (query.sql.includes('sqlite_temp_schema')) {
                                return { columns: ['name', 'sql'], values: [] };
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
            if (call.method === 'query') {
                const [sql] = call.args as [string];
                if (sql.startsWith('PRAGMA main.table_xinfo')) {
                    return {
                        result: {
                            columns: ['cid', 'name', 'hidden'],
                            values: [[0, 'user id', 0], [1, 'display name', 0]]
                        }
                    };
                }
            }

            if (call.method === 'run' || call.method === 'runSingle') {
                const sql = String(call.method === 'run' ? call.args[0] : call.args[1]);
                if (sql === 'DROP VIEW main."user names"') {
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
            assert.strictEqual(runSql[1], 'DROP VIEW main."user names"');
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
            assert.ok(triggerQueries.every(query => (
                /ORDER BY (?:temp_trigger\.)?rowid$/.test(query.sql)
            )));
            assert.ok(triggerQueries.some(query => query.sql.includes('sqlite_schema')));
            assert.ok(triggerQueries.some(query => query.sql.includes('sqlite_temp_schema')));

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
                    'EXPLAIN SELECT * FROM main."user names"\n/*sqlite_explorer_boundary_'
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

    it('terminates the worker when a response frame advertises an unsafe allocation', async () => {
        const worker = new NativeWorkerProcess('/fake/bin', '/fake/script');
        let killCount = 0;
        (worker as any).process = {
            stdin: { write: () => true },
            kill: () => { killCount++; }
        };
        const pending = worker.call('query', [], 50);
        const hostileHeader = Buffer.alloc(4);
        hostileHeader.writeUInt32BE(0xffff_ffff, 0);

        (worker as any).handleData(hostileHeader);

        await assert.rejects(pending, /native worker response frame.*limit/i);
        assert.strictEqual(killCount, 1);
        assert.strictEqual((worker as any).process, null);
        assert.strictEqual((worker as any).chunksTotalLength, 0);
        assert.strictEqual((worker as any).pendingRequests.size, 0);
    });

    it('retires the worker and clears request state when an IPC write fails', async () => {
        const worker = new NativeWorkerProcess('/fake/bin', '/fake/script');
        let killCount = 0;
        (worker as any).process = {
            stdin: {
                write() { throw new Error('native stdin EPIPE'); }
            },
            kill: () => { killCount++; }
        };

        try {
            await assert.rejects(worker.call('query', [], 1000), /native stdin EPIPE/);
            assert.strictEqual(killCount, 1);
            assert.strictEqual((worker as any).process, null);
            assert.strictEqual((worker as any).pendingRequests.size, 0);
        } finally {
            worker.stop();
        }
    });

    it('handles an asynchronous child-stdin EPIPE without an unhandled stream error', async () => {
        const childProcess = require('node:child_process');
        const fakeChild = new EventEmitter() as any;
        fakeChild.stdout = new EventEmitter();
        fakeChild.stderr = new EventEmitter();
        fakeChild.stdin = new EventEmitter();
        fakeChild.stdin.write = () => true;
        let killCount = 0;
        fakeChild.kill = () => { killCount++; };
        mock.method(childProcess, 'spawn', () => fakeChild);
        mock.method(console, 'error', () => {});
        const worker = new NativeWorkerProcess('/fake/bin', '/fake/script');

        const starting = worker.start();
        fakeChild.stdout.emit('data', encodeNativeMessage({ ready: true }));
        await starting;
        const pending = worker.call('query', [], 1000);

        fakeChild.stdin.emit('error', new Error('EPIPE from native child'));

        await assert.rejects(pending, /request stream failed: EPIPE from native child/);
        assert.strictEqual(killCount, 1);
        assert.strictEqual((worker as any).process, null);
        assert.strictEqual((worker as any).pendingRequests.size, 0);
    });

    it('marks native request deadlines as invocation timeouts for recovery', async () => {
        const worker = new NativeWorkerProcess('/fake/bin', '/fake/script');
        let killCount = 0;
        const fakeProcess = {
            stdin: { write: () => true },
            kill: () => { killCount++; }
        };
        (worker as any).process = fakeProcess;

        try {
            await assert.rejects(
                worker.call('run', [], 1),
                (error: unknown) => {
                    assert.ok(error instanceof InvocationTimeoutError);
                    assert.strictEqual(error.methodName, 'run');
                    assert.strictEqual(error.message, 'Request run timed out');
                    return true;
                }
            );
            assert.strictEqual(killCount, 1);
            assert.strictEqual((worker as any).process, null);
            assert.strictEqual((worker as any).pendingRequests.size, 0);
        } finally {
            worker.stop();
        }
    });

    it('kills abandoned native open work when its host deadline expires', async () => {
        const worker = new NativeWorkerProcess('/fake/bin', '/fake/script');
        let killCount = 0;
        (worker as any).process = {
            stdin: { write: () => true },
            kill: () => { killCount++; }
        };

        await assert.rejects(
            worker.call('open', [], 1),
            (error: unknown) => {
                assert.ok(error instanceof InvocationTimeoutError);
                assert.strictEqual(error.methodName, 'open');
                assert.strictEqual(error.message, 'Request open timed out');
                return true;
            }
        );
        assert.strictEqual(killCount, 1);
        assert.strictEqual((worker as any).process, null);
        assert.strictEqual((worker as any).pendingRequests.size, 0);
    });

    it('routes an in-flight bounded-query abort to the worker correlation id', async () => {
        const calls: RecordedNativeCall[] = [];
        const mockProcess = createRecordingNativeProcess(calls);
        const worker = new NativeWorkerProcess('/fake/bin', '/fake/script');
        (worker as any).process = {
            stdin: mockProcess.stdin,
            kill: () => {}
        };
        const controller = new AbortController();
        const cancellation = new DOMException('Cancelled by test', 'AbortError');
        let queryPromise: Promise<unknown> | undefined;

        try {
            queryPromise = worker.call('queryBounded', [], 1000, controller.signal);
            await new Promise(resolve => setImmediate(resolve));
            const queryCall = calls.find(call => call.method === 'queryBounded');
            assert.ok(queryCall, 'bounded query must be dispatched before cancellation');

            controller.abort(cancellation);
            await new Promise(resolve => setImmediate(resolve));

            const cancelCall = calls.find(call => call.method === 'cancel');
            assert.ok(cancelCall, 'aborting the host signal must send a cancel verb');
            assert.deepStrictEqual(cancelCall.args, [queryCall.id]);

            (worker as any).handleMessage({
                id: queryCall.id,
                error: '[queryBounded] Operation cancelled',
                cancelled: true
            });
            await assert.rejects(queryPromise, error => error === cancellation);
            queryPromise = undefined;
        } finally {
            if (queryPromise) {
                const queryCall = calls.find(call => call.method === 'queryBounded');
                if (queryCall) {
                    (worker as any).handleMessage({ id: queryCall.id, error: 'test cleanup' });
                }
                await queryPromise.catch(() => {});
            }
            worker.stop();
        }
    });

    it('routes an in-flight export-spool abort to the worker correlation id', async () => {
        const calls: RecordedNativeCall[] = [];
        const mockProcess = createRecordingNativeProcess(calls);
        const worker = new NativeWorkerProcess('/fake/bin', '/fake/script');
        (worker as any).process = {
            stdin: mockProcess.stdin,
            kill: () => {}
        };
        const controller = new AbortController();
        const cancellation = new DOMException('Cancelled export spool', 'AbortError');
        let queryPromise: Promise<unknown> | undefined;

        try {
            queryPromise = worker.call('queryExportSpool', [], 1000, controller.signal);
            await new Promise(resolve => setImmediate(resolve));
            const queryCall = calls.find(call => call.method === 'queryExportSpool');
            assert.ok(queryCall, 'export spool must be dispatched before cancellation');

            controller.abort(cancellation);
            await new Promise(resolve => setImmediate(resolve));

            const cancelCall = calls.find(call => call.method === 'cancel');
            assert.ok(cancelCall, 'aborting the export signal must send a cancel verb');
            assert.deepStrictEqual(cancelCall.args, [queryCall.id]);

            (worker as any).handleMessage({
                id: queryCall.id,
                error: '[queryExportSpool] Operation cancelled',
                cancelled: true
            });
            await assert.rejects(queryPromise, error => error === cancellation);
            queryPromise = undefined;
        } finally {
            if (queryPromise) {
                const queryCall = calls.find(call => call.method === 'queryExportSpool');
                if (queryCall) {
                    (worker as any).handleMessage({ id: queryCall.id, error: 'test cleanup' });
                }
                await queryPromise.catch(() => {});
            }
            worker.stop();
        }
    });

    it('routes an in-flight VACUUM abort to the worker correlation id', async () => {
        const calls: RecordedNativeCall[] = [];
        const mockProcess = createRecordingNativeProcess(calls);
        const worker = new NativeWorkerProcess('/fake/bin', '/fake/script');
        (worker as any).process = {
            stdin: mockProcess.stdin,
            kill: () => {}
        };
        const controller = new AbortController();
        const cancellation = new DOMException('Cancelled native snapshot', 'AbortError');
        let vacuumPromise: Promise<unknown> | undefined;

        try {
            vacuumPromise = worker.call('vacuumInto', ['/private/snapshot.sqlite'], 1000, controller.signal);
            await new Promise(resolve => setImmediate(resolve));
            const vacuumCall = calls.find(call => call.method === 'vacuumInto');
            assert.ok(vacuumCall, 'VACUUM must be dispatched before cancellation');

            controller.abort(cancellation);
            await new Promise(resolve => setImmediate(resolve));

            const cancelCall = calls.find(call => call.method === 'cancel');
            assert.ok(cancelCall, 'aborting the snapshot must send a cancel verb');
            assert.deepStrictEqual(cancelCall.args, [vacuumCall.id]);

            (worker as any).handleMessage({
                id: vacuumCall.id,
                error: '[vacuumInto] Operation cancelled',
                cancelled: true
            });
            await assert.rejects(vacuumPromise, error => error === cancellation);
            vacuumPromise = undefined;
        } finally {
            if (vacuumPromise) {
                const vacuumCall = calls.find(call => call.method === 'vacuumInto');
                if (vacuumCall) {
                    (worker as any).handleMessage({ id: vacuumCall.id, error: 'test cleanup' });
                }
                await vacuumPromise.catch(() => {});
            }
            worker.stop();
        }
    });
});

describe('native synchronous query deadlines', () => {
    it('arms and clears the bundled Database deadline around SQLite stepping', () => {
        const runWithQueryDeadline = loadNativeWorkerFunction(
            'runWithQueryDeadline',
            ['database', 'timeoutMs', 'operation']
        );
        const calls: unknown[] = [];
        const database = {
            setQueryDeadline(timeoutMs: number) { calls.push(['set', timeoutMs]); },
            clearQueryDeadline() { calls.push(['clear']); }
        };

        const result = runWithQueryDeadline(database, 37, () => {
            calls.push(['step']);
            return 42;
        });

        assert.strictEqual(result, 42);
        assert.deepStrictEqual(calls, [['set', 37], ['step'], ['clear']]);
    });

    it('clears an expired deadline before reporting SQLite interruption', () => {
        const runWithQueryDeadline = loadNativeWorkerFunction(
            'runWithQueryDeadline',
            ['database', 'timeoutMs', 'operation']
        );
        let cleared = false;
        const database = {
            setQueryDeadline() {},
            clearQueryDeadline() { cleared = true; }
        };
        const interruption = Object.assign(new Error('interrupted'), { errno: 9 });

        assert.throws(
            () => runWithQueryDeadline(database, 25, () => { throw interruption; }),
            /Query execution timed out after 25ms/
        );
        assert.strictEqual(cleared, true);
    });

    it('preserves timeout identity when clearing the expired deadline also fails', () => {
        const runWithQueryDeadline = loadNativeWorkerFunction(
            'runWithQueryDeadline',
            ['database', 'timeoutMs', 'operation']
        );
        const database = {
            setQueryDeadline() {},
            clearQueryDeadline() { throw new Error('deadline cleanup failed'); }
        };
        const interruption = Object.assign(new Error('interrupted'), { errno: 9 });
        let error: unknown;

        try {
            runWithQueryDeadline(database, 25, () => { throw interruption; });
        } catch (caught) {
            error = caught;
        }

        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /Query execution timed out after 25ms/);
        assert.match(error.message, /deadline cleanup failed/);
        assert.strictEqual(error.errors.length, 2);
    });

    it('fails closed when the bundled Database lacks deadline support', () => {
        const runWithQueryDeadline = loadNativeWorkerFunction(
            'runWithQueryDeadline',
            ['database', 'timeoutMs', 'operation']
        );

        assert.throws(
            () => runWithQueryDeadline({}, 25, () => undefined),
            /setQueryDeadline.*clearQueryDeadline/i
        );
    });

    it('arms the dedicated connection while reading a cell chunk', () => {
        const runWithQueryDeadline = loadNativeWorkerFunction(
            'runWithQueryDeadline',
            ['database', 'timeoutMs', 'operation']
        );
        const calls: unknown[] = [];
        const session = {
            connection: {
                setQueryDeadline(timeoutMs: number) { calls.push(['set', timeoutMs]); },
                clearQueryDeadline() { calls.push(['clear']); }
            },
            target: {
                table: 'assets',
                column: 'payload',
                escapedTable: 'main."assets"',
                escapedColumn: '"payload"',
                predicate: { sql: 'rowid = ?', params: [7] }
            },
            metadata: { storageClass: 'blob', byteLength: 4 },
            lastAccessAt: 0
        };
        const readCellChunkFromSession = loadNativeWorkerFunction(
            'readCellChunkFromSession',
            ['session', 'byteOffset', 'maxBytes', 'timeoutMs'],
            {
                runWithQueryDeadline,
                executeQuery(_connection: unknown, sql: string, params: unknown[]) {
                    calls.push(['query', sql, params]);
                    return { values: [[Uint8Array.from([1, 2, 3, 4])]] };
                },
                scheduleCellReadSessionExpiry() { calls.push(['schedule']); },
                Date: { now: () => 91 }
            }
        );

        assert.deepStrictEqual(readCellChunkFromSession(session, 0, 4, 23), {
            byteOffset: 0,
            bytes: Uint8Array.from([1, 2, 3, 4]),
            done: true
        });
        assert.deepStrictEqual(calls.map(call => Array.isArray(call) ? call[0] : call), [
            'set',
            'query',
            'clear',
            'schedule'
        ]);
        assert.strictEqual(session.lastAccessAt, 91);
    });

    it('deadlines snapshot cleanup and clears the deadline before closing the handle', () => {
        const runWithQueryDeadline = loadNativeWorkerFunction(
            'runWithQueryDeadline',
            ['database', 'timeoutMs', 'operation']
        );
        const calls: unknown[] = [];
        const connection = {
            setQueryDeadline(timeoutMs: number) { calls.push(['set', timeoutMs]); },
            clearQueryDeadline() { calls.push(['clear']); },
            exec(sql: string) { calls.push(['exec', sql]); },
            close() { calls.push(['close']); }
        };
        const cellReadSessions = new Map([['session-1', {
            sessionId: 'session-1',
            connection,
            usesMainConnection: false,
            savepointName: 'snapshot_1',
            expiryTimer: 44
        }]]);
        const closeCellReadSessionInternal = loadNativeWorkerFunction(
            'closeCellReadSessionInternal',
            ['sessionId', 'timeoutMs'],
            {
                CELL_READ_SESSION_IDLE_TIMEOUT_MS: 30_000,
                cellReadSessions,
                rememberClosedCellReadSession(sessionId: string) {
                    calls.push(['remember', sessionId]);
                },
                clearTimeout(timer: number) { calls.push(['clear-timeout', timer]); },
                runWithQueryDeadline,
                abandonMainConnectionAfterCellReadCleanupFailure() {
                    calls.push(['abandon']);
                }
            }
        );

        assert.throws(
            () => closeCellReadSessionInternal('session-1', 0),
            /positive finite number/
        );
        assert.strictEqual(cellReadSessions.size, 1);
        assert.deepStrictEqual(calls, []);

        assert.strictEqual(closeCellReadSessionInternal('session-1', 29), true);
        assert.deepStrictEqual(calls.map(call => Array.isArray(call) ? call[0] : call), [
            'remember',
            'clear-timeout',
            'set',
            'exec',
            'clear',
            'close'
        ]);
        assert.strictEqual(cellReadSessions.size, 0);
    });
});

describe('native async VACUUM routing', () => {
    it('uses a bound VACUUM main INTO path only outside the main transaction', async () => {
        const isExplicitlyOutsideTransaction = loadNativeWorkerFunction(
            'isExplicitlyOutsideTransaction',
            ['database']
        );
        const runVacuumInto = loadNativeWorkerFunction(
            'runVacuumInto',
            ['asyncDatabase', 'database', 'snapshotPath', 'signal'],
            { isExplicitlyOutsideTransaction }
        );
        const calls: unknown[][] = [];
        const asyncDatabase = {
            async run(...args: unknown[]) { calls.push(args); }
        };
        const signal = new AbortController().signal;

        await runVacuumInto(
            asyncDatabase,
            { inTransaction: false },
            "/private/quote'snapshot.sqlite",
            signal
        );
        assert.deepStrictEqual(calls, [[
            'VACUUM main INTO ?',
            ["/private/quote'snapshot.sqlite"],
            { signal }
        ]]);

        await assert.rejects(
            runVacuumInto(asyncDatabase, { inTransaction: true }, '/private/blocked.sqlite', signal),
            /active transaction/i
        );
        assert.strictEqual(calls.length, 1);
    });

    it('reports a deadline that lands before an async completion is observed', async () => {
        const activeOperations = new Map<number, {
            controller: AbortController;
            reason?: 'deadline' | 'host';
        }>();
        const executeInterruptibleAsyncOperation = loadNativeWorkerFunction(
            'executeInterruptibleAsyncOperation',
            ['requestId', 'timeoutMs', 'operation'],
            {
                activeOperations,
                setTimeout(callback: () => void) {
                    queueMicrotask(callback);
                    return 1;
                },
                clearTimeout() {}
            }
        );

        await assert.rejects(
            executeInterruptibleAsyncOperation(17, 19, async () => {
                await new Promise<void>(resolve => queueMicrotask(resolve));
                return 'completed';
            }),
            /Query execution timed out after 19ms/
        );
        assert.strictEqual(activeOperations.size, 0);
    });
});

describe('native async bounded-query capability routing', () => {
    const loadProbeAsyncDatabase = (dependencies: Record<string, unknown> = {}) => loadNativeWorkerFunction(
        'probeAsyncDatabase',
        ['candidate'],
        dependencies
    );

    it('requires the complete AsyncDatabase surface', async () => {
        const probeAsyncDatabase = loadProbeAsyncDatabase();

        assert.strictEqual(await probeAsyncDatabase({ all() {}, run() {} }), false);
    });

    it('retries an inconclusive completion with a larger query before succeeding', async () => {
        const probeAsyncDatabase = loadProbeAsyncDatabase();
        const probeSql: string[] = [];
        let probeCalls = 0;
        let healthChecks = 0;
        const candidate = {
            close() {},
            run() {},
            async all(sql: string, _params: unknown[], options?: { signal?: AbortSignal }) {
                if (!options?.signal) {
                    healthChecks++;
                    return [{ value: 1 }];
                }

                probeSql.push(sql);
                probeCalls++;
                if (probeCalls === 1) {
                    // Simulate completion winning the event-loop race, so the
                    // scheduled abort was never delivered in flight.
                    return [{ value: 1 }];
                }
                await new Promise<void>((_resolve, reject) => {
                    options.signal!.addEventListener(
                        'abort',
                        () => reject(new Error('Aborted')),
                        { once: true }
                    );
                });
                return [{ value: 1 }];
            }
        };

        assert.strictEqual(await probeAsyncDatabase(candidate), true);
        assert.strictEqual(probeCalls, 2);
        assert.strictEqual(healthChecks, 1);
        assert.match(probeSql[0], /value < 1000000/);
        assert.match(probeSql[1], /value < 8000000/);
    });

    it('keeps a starved abort pending so it can land during the retry', async () => {
        interface ProbeTimer {
            callback: () => void;
            cleared: boolean;
        }
        const timers: ProbeTimer[] = [];
        const probeAsyncDatabase = loadProbeAsyncDatabase({
            setTimeout(callback: () => void, delayMs: number) {
                assert.strictEqual(delayMs, 10);
                const timer = { callback, cleared: false };
                timers.push(timer);
                return timer;
            },
            clearTimeout(timer: ProbeTimer) {
                timer.cleared = true;
            }
        });
        let probeCalls = 0;
        const candidate = {
            close() {},
            run() {},
            async all(_sql: string, _params: unknown[], options?: { signal?: AbortSignal }) {
                if (!options?.signal) return [{ value: 1 }];

                probeCalls++;
                if (probeCalls === 1) return [{ value: 1 }];
                await new Promise<void>((resolve, reject) => {
                    options.signal!.addEventListener(
                        'abort',
                        () => reject(new Error('Aborted')),
                        { once: true }
                    );
                    const originalTimer = timers[0];
                    if (originalTimer && !originalTimer.cleared) {
                        originalTimer.callback();
                    } else {
                        resolve();
                    }
                });
                return [{ value: 1 }];
            }
        };

        assert.strictEqual(await probeAsyncDatabase(candidate), true);
        assert.strictEqual(probeCalls, 2);
        assert.strictEqual(timers.length, 1);
        assert.strictEqual(timers[0].cleared, true);
    });

    it('reports unsupported when an in-flight abort is demonstrably ignored', async () => {
        const probeAsyncDatabase = loadProbeAsyncDatabase();
        let probeCalls = 0;
        let healthChecks = 0;
        const candidate = {
            close() {},
            run() {},
            async all(_sql: string, _params: unknown[], options?: { signal?: AbortSignal }) {
                if (!options?.signal) {
                    healthChecks++;
                    return [{ value: 1 }];
                }

                probeCalls++;
                await new Promise<void>(resolve => {
                    options.signal!.addEventListener('abort', () => resolve(), { once: true });
                });
                return [{ value: 1 }];
            }
        };

        assert.strictEqual(await probeAsyncDatabase(candidate), false);
        assert.strictEqual(probeCalls, 1);
        assert.strictEqual(healthChecks, 0);
    });

    it('accepts first-try signal support and verifies connection health', async () => {
        const probeAsyncDatabase = loadNativeWorkerFunction(
            'probeAsyncDatabase',
            ['candidate']
        );
        const calls: string[] = [];
        const candidate = {
            close() {},
            run() {},
            async all(sql: string, _params: unknown[], options?: { signal?: AbortSignal }) {
                calls.push(sql);
                if (options?.signal) {
                    await new Promise<void>((_resolve, reject) => {
                        options.signal!.addEventListener(
                            'abort',
                            () => reject(new Error('Aborted')),
                            { once: true }
                        );
                    });
                }
                return [{ value: 1 }];
            }
        };

        assert.strictEqual(await probeAsyncDatabase(candidate), true);
        assert.strictEqual(calls.length, 2);
        assert.match(calls[0], /WITH RECURSIVE sqlite_explorer_probe/);
        assert.strictEqual(calls[1], 'SELECT 1 AS value');
    });

    it('keeps bounded reads on the sync connection unless no transaction is active', () => {
        const isExplicitlyOutsideTransaction = loadNativeWorkerFunction(
            'isExplicitlyOutsideTransaction',
            ['database']
        );
        const shouldUseAsyncDatabase = loadNativeWorkerFunction(
            'shouldUseAsyncDatabase',
            ['database', 'asyncDatabase'],
            { isExplicitlyOutsideTransaction }
        );
        const asyncDatabase = {};

        assert.strictEqual(shouldUseAsyncDatabase({ inTransaction: false }, asyncDatabase), true);
        assert.strictEqual(shouldUseAsyncDatabase({ inTransaction: true }, asyncDatabase), false);
        assert.strictEqual(shouldUseAsyncDatabase({ inTransaction: () => false }, asyncDatabase), true);
        assert.strictEqual(shouldUseAsyncDatabase({ inTransaction: () => true }, asyncDatabase), false);
        assert.strictEqual(shouldUseAsyncDatabase({}, asyncDatabase), false);
        assert.strictEqual(shouldUseAsyncDatabase({ inTransaction: false }, null), false);
    });

    it('routes cancel only to the matching active operation', () => {
        const activeOperations = new Map<number, {
            controller: { abort(): void };
            reason?: string;
        }>();
        const cancelOperation = loadNativeWorkerFunction(
            'cancelOperation',
            ['correlationId'],
            { activeOperations }
        );
        let aborts = 0;
        const operation = {
            controller: { abort() { aborts++; } },
            reason: undefined
        };
        activeOperations.set(41, operation);

        assert.strictEqual(cancelOperation(99), false);
        assert.strictEqual(cancelOperation(41), true);
        assert.strictEqual(operation.reason, 'host');
        assert.strictEqual(aborts, 1);
        assert.strictEqual(cancelOperation(41), true);
        assert.strictEqual(aborts, 1, 'duplicate cancel frames must not abort twice');
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
        const executeBoundedQuery = loadNativeBoundaryFunction(
            'executeBoundedQuery',
            ['db', 'markedSql', 'sql', 'requiredSuffix', 'columns', 'valueColumnCount', 'limit', 'timeoutMs']
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
                undefined,
                10,
                5
            ),
            /Query execution timed out after 5ms/
        );
        assert.strictEqual(rowQueries, 1);
        assert.strictEqual(finalized, 2);
    });

    it('reports a native preview timeout even when the query returns zero rows', () => {
        const executeBoundedQuery = loadNativeBoundaryFunction(
            'executeBoundedQuery',
            ['db', 'markedSql', 'sql', 'requiredSuffix', 'columns', 'valueColumnCount', 'limit', 'timeoutMs']
        );
        const boundary = '/*sqlite_explorer_boundary_test*/';
        let finalized = 0;
        const database = {
            prepare(sql: string) {
                if (sql.endsWith(boundary)) {
                    return {
                        toString: () => sql,
                        finalize() { finalized++; }
                    };
                }
                return {
                    all() { return []; },
                    finalize() { finalized++; }
                };
            }
        };
        const times = [0, 10];
        mock.method(Date, 'now', () => times.shift() ?? 10);

        assert.throws(
            () => executeBoundedQuery(
                database,
                `SELECT * FROM preview\n${boundary}`,
                'SELECT * FROM preview',
                boundary,
                ['value'],
                undefined,
                10,
                5
            ),
            /Query execution timed out after 5ms/
        );
        assert.strictEqual(finalized, 2);
    });

    it('executes a 100-row duplicate-alias preview only once', () => {
        const executeBoundedQuery = loadNativeBoundaryFunction(
            'executeBoundedQuery',
            ['db', 'markedSql', 'sql', 'requiredSuffix', 'columns', 'valueColumnCount', 'limit', 'timeoutMs']
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
                            value0: index + 1,
                            value1: (index + 1) * 10,
                            exact0: null,
                            exact1: null
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
            ['value0', 'value1', 'exact0', 'exact1'],
            2,
            100,
            5000
        );

        assert.strictEqual(dataPrepareCalls, 1);
        assert.strictEqual(finalized, 2);
        assert.strictEqual(result.rowCount, 100);
        assert.deepStrictEqual(result.values[0], [1, 10]);
        assert.deepStrictEqual(result.values[99], [100, 1000]);
    });

    it('compacts integral REAL metadata before returning a bounded native query', () => {
        const executeBoundedQuery = loadNativeBoundaryFunction(
            'executeBoundedQuery',
            ['db', 'markedSql', 'sql', 'requiredSuffix', 'columns', 'valueColumnCount', 'limit', 'timeoutMs']
        );
        const boundary = '/*sqlite_explorer_boundary_test*/';
        const database = {
            prepare(sql: string) {
                if (sql.endsWith(boundary)) {
                    return {
                        toString: () => sql,
                        finalize() {}
                    };
                }
                return {
                    all() {
                        return [{ value0: 1, exact0: '1.0' }];
                    },
                    finalize() {}
                };
            }
        };
        mock.method(Date, 'now', () => 0);

        const result = executeBoundedQuery(
            database,
            `SELECT * FROM preview\n${boundary}`,
            'SELECT * FROM preview',
            boundary,
            ['value0', 'exact0'],
            1,
            10,
            5000
        );

        assert.deepStrictEqual(result.values, [[1]]);
        assert.deepStrictEqual(result.exactIntegerTexts, { 0: { 0: '1.0' } });
    });

    it('rejects divergent marked and executable bounded-query payloads before prepare', () => {
        const executeBoundedQuery = loadNativeBoundaryFunction(
            'executeBoundedQuery',
            ['db', 'markedSql', 'sql', 'requiredSuffix', 'columns', 'valueColumnCount', 'limit', 'timeoutMs']
        );
        const boundary = '/*sqlite_explorer_boundary_test*/';
        let prepareCalls = 0;
        const database = {
            prepare() {
                prepareCalls++;
                throw new Error('prepare must not run for a divergent payload');
            }
        };

        assert.throws(
            () => executeBoundedQuery(
                database,
                `SELECT * FROM safe_preview\n${boundary}`,
                'SELECT * FROM safe_preview;',
                boundary,
                ['value'],
                undefined,
                10,
                5000
            ),
            /Single-statement SQL payload mismatch/
        );
        assert.strictEqual(prepareCalls, 0);
    });

    it('rejects a stored mutation tail before executing the original SQL', () => {
        const executeSingleStatement = loadNativeBoundaryFunction(
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
        const executeSingleStatement = loadNativeBoundaryFunction(
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

    it('reports unavailable statement introspection for mutation boundaries', () => {
        const executeSingleStatement = loadNativeBoundaryFunction(
            'executeSingleStatement',
            ['db', 'markedSql', 'sql', 'params', 'requiredSuffix']
        );
        const boundary = '/*sqlite_explorer_boundary_test*/';
        let finalized = false;
        const database = {
            prepare() {
                return {
                    toString: undefined,
                    finalize() { finalized = true; }
                };
            }
        };

        assert.throws(
            () => executeSingleStatement(
                database,
                `CREATE VIEW sample AS SELECT 1\n${boundary}`,
                'CREATE VIEW sample AS SELECT 1',
                undefined,
                boundary
            ),
            /Statement introspection unavailable/
        );
        assert.strictEqual(finalized, true);
    });

    it('reports inherited Object.prototype introspection as unavailable', () => {
        const executeSingleStatement = loadNativeBoundaryFunction(
            'executeSingleStatement',
            ['db', 'markedSql', 'sql', 'params', 'requiredSuffix']
        );
        const boundary = '/*sqlite_explorer_boundary_test*/';
        let finalized = false;
        const database = {
            prepare() {
                return {
                    finalize() { finalized = true; }
                };
            }
        };

        assert.throws(
            () => executeSingleStatement(
                database,
                `CREATE VIEW sample AS SELECT 1\n${boundary}`,
                'CREATE VIEW sample AS SELECT 1',
                undefined,
                boundary
            ),
            /Statement introspection unavailable/
        );
        assert.strictEqual(finalized, true);
    });

    it('reports unavailable statement introspection for bounded-query boundaries', () => {
        const executeBoundedQuery = loadNativeBoundaryFunction(
            'executeBoundedQuery',
            ['db', 'markedSql', 'sql', 'requiredSuffix', 'columns', 'valueColumnCount', 'limit', 'timeoutMs']
        );
        const boundary = '/*sqlite_explorer_boundary_test*/';
        let finalized = false;
        const database = {
            prepare() {
                return {
                    toString: undefined,
                    finalize() { finalized = true; }
                };
            }
        };

        assert.throws(
            () => executeBoundedQuery(
                database,
                `SELECT * FROM preview\n${boundary}`,
                'SELECT * FROM preview',
                boundary,
                ['value'],
                undefined,
                10,
                5000
            ),
            /Statement introspection unavailable/
        );
        assert.strictEqual(finalized, true);
    });
});
