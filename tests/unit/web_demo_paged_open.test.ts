import './vscode_mock_setup';

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import esbuild from 'esbuild';
import initSqlJs from '../../vendor/sql.js/sql-wasm.js';
import {
    BUFFER_OPEN_CEILING_BYTES,
    DEMO_INLINE_CONTENT_MAX_BYTES,
    PAGED_OPEN_THRESHOLD_BYTES,
    WAL_TOO_LARGE_MESSAGE,
    decideOpenPlan,
    isWalMarkedHeader
} from '../../src/core/paged-open';
import { MAX_WEBVIEW_BINARY_VALUE_BYTES } from '../../src/core/webview-transport';

/**
 * Decision-ladder coverage for the web demo's paged-vs-buffer database
 * opens: the pure routing module, and the worker's File-handle open path
 * driven end-to-end with stub File/FileReaderSync plumbing. The vendored
 * sql.js build is the real engine for every leg; the capability-absent
 * leg masks openPaged explicitly (pin-proof either way), and the paged
 * legs run with an openPaged stub layered on top.
 */

const authoredWorkerPath = path.resolve(
    process.cwd(),
    'website/src/sqlite-viewer/worker.js'
);

// ---------------------------------------------------------------------------
// Stub File / FileReaderSync
// ---------------------------------------------------------------------------

/** Minimal Blob.slice result: just the bytes the slice covers. */
class StubBlob {
    constructor(readonly bytes: Uint8Array) {}
}

/**
 * File stand-in with real Blob.slice clamping semantics (out-of-range
 * slices come back short or empty, exactly how EOF short reads reach the
 * paged VFS). The worker duck-types File handles, so no realm-shared
 * File class is needed.
 */
class StubFile {
    constructor(readonly bytes: Uint8Array, readonly name: string) {}

    get size(): number {
        return this.bytes.length;
    }

    slice(start = 0, end = this.bytes.length): StubBlob {
        const clamp = (value: number) =>
            Math.min(Math.max(value < 0 ? this.bytes.length + value : value, 0), this.bytes.length);
        const from = clamp(start);
        const to = Math.max(clamp(end), from);
        return new StubBlob(this.bytes.subarray(from, to));
    }
}

class StubFileReaderSync {
    readAsArrayBuffer(source: StubBlob | StubFile): ArrayBuffer {
        const bytes = source instanceof StubBlob ? source.bytes : source.bytes;
        return bytes.slice().buffer;
    }
}

// ---------------------------------------------------------------------------
// Worker harness (bundled authored worker in a vm, like web_demo_worker)
// ---------------------------------------------------------------------------

let workerBundle: Promise<string> | undefined;

function bundleWorker(): Promise<string> {
    workerBundle ??= esbuild.build({
        entryPoints: [authoredWorkerPath],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2020',
        minify: true,
        write: false
    }).then(result => {
        assert.strictEqual(result.outputFiles.length, 1);
        return result.outputFiles[0].text;
    });
    return workerBundle;
}

// A non-pooled ArrayBuffer: sql.js's typings want ArrayBuffer, and a raw
// Buffer's backing store may be a shared slab slice.
const wasmBinary = new Uint8Array(readFileSync(
    path.resolve(process.cwd(), 'assets/sqlite3.wasm')
)).buffer;

interface PagedHarness {
    invoke(method: string, ...payload: unknown[]): Promise<any>;
    /** SQL strings run on the database handle openPaged returned. */
    pagedSql: string[];
    /** hostIo activity recorded by the openPaged stub. */
    hostReads: Array<{ offset: number; length: number }>;
    openPagedCalls: number;
    openPagedWritableCalls: number;
    lastResponseTransferCount: number;
}

/**
 * Boot the bundled worker in a vm with File/FileReaderSync stubs and an
 * independently masked read-only/writable paged capabilities.
 */
async function createPagedHarness(options: {
    /** Read-only paged capability. */
    openPaged?: 'absent' | 'working' | 'throwing';
    /** Copy-on-write paged capability. */
    openPagedWritable?: 'absent' | 'working' | 'throwing';
} = {}): Promise<PagedHarness> {
    const source = await bundleWorker();
    const responses: any[] = [];
    const pagedSql: string[] = [];
    const hostReads: Array<{ offset: number; length: number }> = [];
    const readOnlyCapability = options.openPaged ?? 'absent';
    const writableCapability = options.openPagedWritable ?? 'absent';
    let openPagedCalls = 0;
    let openPagedWritableCalls = 0;
    let lastResponseTransferCount = 0;

    const workerGlobal: any = {
        initSqlJs: async (config: any) => {
            const sqlJs = await initSqlJs(config);
            // A plain constructor does not inherit static properties, so each
            // capability below is genuinely present/absent as requested while
            // every working leg still executes the real vendored VFS.
            const PagedDatabase: any = function PagedDatabase(...args: any[]) {
                return Reflect.construct(sqlJs.Database, args, PagedDatabase);
            };
            PagedDatabase.prototype = sqlJs.Database.prototype;

            const wrapHostIo = (hostIo: {
                size(): number;
                read(offset: number, length: number): Uint8Array;
            }) => ({
                size: () => hostIo.size(),
                read: (offset: number, length: number) => {
                    const bytes = hostIo.read(offset, length);
                    hostReads.push({ offset, length: bytes.length });
                    return bytes;
                }
            });
            const instrument = (database: any) => {
                const originalRun = database.run.bind(database);
                database.run = (sql: string, ...rest: unknown[]) => {
                    pagedSql.push(sql);
                    return originalRun(sql, ...rest);
                };
                return database;
            };

            if (readOnlyCapability !== 'absent') {
                PagedDatabase.openPaged = (hostIo: any) => {
                    openPagedCalls += 1;
                    if (readOnlyCapability === 'throwing') {
                        throw new Error('unable to open read-only paged database');
                    }
                    return instrument((sqlJs.Database as any).openPaged(wrapHostIo(hostIo)));
                };
            }
            if (writableCapability !== 'absent') {
                PagedDatabase.openPagedWritable = (hostIo: any) => {
                    openPagedWritableCalls += 1;
                    if (writableCapability === 'throwing') {
                        throw new Error('unable to open writable paged database');
                    }
                    return instrument(
                        (sqlJs.Database as any).openPagedWritable(wrapHostIo(hostIo))
                    );
                };
            }
            return { ...sqlJs, Database: PagedDatabase };
        },
        postMessage(message: unknown, transfer?: unknown[]) {
            lastResponseTransferCount = transfer?.length ?? 0;
            responses.push(message);
        }
    };
    const context = vm.createContext({
        self: workerGlobal,
        importScripts() {},
        console: { log() {}, warn() {}, error() {} },
        FileReaderSync: StubFileReaderSync,
        Uint8Array,
        Int32Array,
        ArrayBuffer,
        SharedArrayBuffer,
        Atomics,
        DataView,
        crypto: webcrypto,
        TextEncoder,
        TextDecoder,
        Date,
        setTimeout,
        clearTimeout
    });
    new vm.Script(source, { filename: 'website/public/sqlite-viewer/worker.js' })
        .runInContext(context);

    let messageId = 0;
    const invoke = async (method: string, ...payload: unknown[]) => {
        const id = `paged_test_${++messageId}`;
        await workerGlobal.onmessage({
            data: {
                channel: 'rpc',
                content: {
                    kind: 'invoke',
                    messageId: id,
                    targetMethod: method,
                    payload
                }
            }
        });
        const responseIndex = responses.findIndex(message => message.content?.messageId === id);
        assert.notStrictEqual(responseIndex, -1, `worker did not respond to ${method}`);
        const [response] = responses.splice(responseIndex, 1);
        if (!response.content.success) {
            throw new Error(response.content.errorMessage);
        }
        return response.content.data;
    };

    return {
        invoke,
        pagedSql,
        hostReads,
        get openPagedCalls() { return openPagedCalls; },
        get openPagedWritableCalls() { return openPagedWritableCalls; },
        get lastResponseTransferCount() { return lastResponseTransferCount; }
    } as PagedHarness;
}

function initConfig(extra: Record<string, unknown>): Record<string, unknown> {
    return { wasmBinary, ...extra };
}

// ---------------------------------------------------------------------------
// Fixture database bytes
// ---------------------------------------------------------------------------

let plainDbBytes: Uint8Array;
let walDbBytes: Uint8Array;
/** 20000 positive rowids inserted, even ids deleted: COUNT 10000, span 19999. */
let gappyDbBytes: Uint8Array;

before(async () => {
    const SQL = await initSqlJs({ wasmBinary });
    const db = new SQL.Database();
    db.run('CREATE TABLE fixtures (id INTEGER PRIMARY KEY, label TEXT)');
    const insert = db.prepare('INSERT INTO fixtures VALUES (?, ?)');
    for (let index = 1; index <= 64; index++) {
        insert.run([index, `row-${index}`]);
    }
    insert.free();
    plainDbBytes = db.export();
    db.close();
    // journal_mode=WAL at rest is bytes 18/19 == 0x02 in an otherwise
    // ordinary database file.
    walDbBytes = new Uint8Array(plainDbBytes);
    walDbBytes[18] = 2;
    walDbBytes[19] = 2;
    assert.ok(plainDbBytes.length > 4096, 'fixture must span multiple pages');

    const gappy = new SQL.Database();
    gappy.run('CREATE TABLE fixtures (id INTEGER PRIMARY KEY, label TEXT)');
    gappy.run(
        'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20000) ' +
        "INSERT INTO fixtures SELECT n, 'row-' || n FROM seq"
    );
    gappy.run('DELETE FROM fixtures WHERE id % 2 = 0');
    gappy.run(
        'CREATE TABLE extreme_rowids (label TEXT); ' +
        "INSERT INTO extreme_rowids(rowid, label) VALUES " +
        "(-9223372036854775808, 'minimum'), (9223372036854775807, 'maximum')"
    );
    gappyDbBytes = gappy.export();
    gappy.close();
});

/** Limits that place the fixture strictly above the paged threshold. */
function limitsAboveThreshold(bytes: Uint8Array) {
    return {
        pagedOpenThresholdBytes: bytes.length - 1,
        bufferOpenCeilingBytes: bytes.length + 1024
    };
}

/** Limits that place the fixture at/above the buffer ceiling. */
function limitsAboveCeiling(bytes: Uint8Array) {
    return {
        pagedOpenThresholdBytes: bytes.length - 1,
        bufferOpenCeilingBytes: bytes.length
    };
}

/** Rehydrate vm-realm objects so deepStrictEqual can compare prototypes. */
function normalize<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

function expectInitResult(
    result: unknown,
    expected: { isReadOnly: boolean; storage: 'paged' | 'memory' }
): void {
    assert.deepStrictEqual(normalize(result), { operations: {}, ...expected });
}

async function expectRows(harness: PagedHarness): Promise<void> {
    const data = await harness.invoke('fetchTableData', 'fixtures', {
        columns: ['id', 'label'],
        limit: 5,
        offset: 0,
        orderBy: 'id',
        orderDir: 'ASC'
    });
    assert.deepStrictEqual(
        normalize(data.rows).map((row: unknown[]) => row[1]),
        ['row-1', 'row-2', 'row-3', 'row-4', 'row-5']
    );
}

async function readLabel(harness: PagedHarness, id: number): Promise<unknown> {
    const data = await harness.invoke('fetchTableData', 'fixtures', {
        columns: ['id', 'label'],
        limit: 1,
        offset: id - 1,
        orderBy: 'id',
        orderDir: 'ASC'
    });
    return data.rows[0][1];
}

// ---------------------------------------------------------------------------
// Pure ladder
// ---------------------------------------------------------------------------

describe('paged-open decision ladder', () => {
    it('detects the WAL header mark and nothing else', () => {
        const header = new Uint8Array(100);
        assert.strictEqual(isWalMarkedHeader(header), false);
        header[18] = 2;
        assert.strictEqual(isWalMarkedHeader(header), false);
        header[19] = 2;
        assert.strictEqual(isWalMarkedHeader(header), true);
        header[18] = 1;
        assert.strictEqual(isWalMarkedHeader(header), false);
        // Legacy databases carry 1/1.
        header[18] = 1;
        header[19] = 1;
        assert.strictEqual(isWalMarkedHeader(header), false);
        // Probes shorter than the version offsets are never WAL-marked.
        assert.strictEqual(isWalMarkedHeader(new Uint8Array(0)), false);
        assert.strictEqual(isWalMarkedHeader(new Uint8Array(19)), false);
        const exact = new Uint8Array(20);
        exact[18] = 2;
        exact[19] = 2;
        assert.strictEqual(isWalMarkedHeader(exact), true);
    });

    it('routes by size with paged strictly above the threshold', () => {
        const limits = { pagedThresholdBytes: 1000, bufferCeilingBytes: 2000 };
        const plan = (sizeBytes: number, pagedAvailable = true, walMarked = false) =>
            decideOpenPlan({ sizeBytes, walMarked, pagedAvailable }, limits);

        assert.deepStrictEqual(plan(999), { mode: 'buffer', readOnly: false });
        assert.deepStrictEqual(plan(1000), { mode: 'buffer', readOnly: false });
        assert.deepStrictEqual(plan(1001), { mode: 'paged' });
        // Above the ceiling the paged path is still the answer when present.
        assert.deepStrictEqual(plan(5000), { mode: 'paged' });
    });

    it('degrades to the buffer path when paged is unavailable and rejects only past the ceiling', () => {
        const limits = { pagedThresholdBytes: 1000, bufferCeilingBytes: 2000 };
        const plan = (sizeBytes: number) =>
            decideOpenPlan({ sizeBytes, walMarked: false, pagedAvailable: false }, limits);

        assert.deepStrictEqual(plan(1500), { mode: 'buffer', readOnly: false });
        assert.deepStrictEqual(plan(1999), { mode: 'buffer', readOnly: false });
        const rejected = plan(2000);
        assert.strictEqual(rejected.mode, 'reject');
        assert.match((rejected as { message: string }).message, /too large to load into memory/);
        assert.match((rejected as { message: string }).message, /page-on-demand mode is unavailable/);
    });

    it('never pages WAL-marked databases and forces read-only above the threshold', () => {
        const limits = { pagedThresholdBytes: 1000, bufferCeilingBytes: 2000 };
        const plan = (sizeBytes: number) =>
            decideOpenPlan({ sizeBytes, walMarked: true, pagedAvailable: true }, limits);

        assert.deepStrictEqual(plan(500), { mode: 'buffer', readOnly: false });
        assert.deepStrictEqual(plan(1000), { mode: 'buffer', readOnly: false });
        assert.deepStrictEqual(plan(1001), { mode: 'buffer', readOnly: true });
        assert.deepStrictEqual(plan(1999), { mode: 'buffer', readOnly: true });
        assert.deepStrictEqual(plan(2000), {
            mode: 'reject',
            message: WAL_TOO_LARGE_MESSAGE
        });
        // Paged availability makes no difference for WAL files.
        assert.deepStrictEqual(
            decideOpenPlan(
                { sizeBytes: 2000, walMarked: true, pagedAvailable: false },
                limits
            ),
            { mode: 'reject', message: WAL_TOO_LARGE_MESSAGE }
        );
    });

    it('validates sizes and limit overrides', () => {
        assert.throws(
            () => decideOpenPlan(
                { sizeBytes: 10, walMarked: false, pagedAvailable: true },
                { pagedThresholdBytes: 100, bufferCeilingBytes: 50 }
            ),
            /threshold must not exceed/
        );
        assert.throws(
            () => decideOpenPlan(
                { sizeBytes: 10, walMarked: false, pagedAvailable: true },
                { pagedThresholdBytes: 0 }
            ),
            /positive safe integer/
        );
        assert.throws(
            () => decideOpenPlan({ sizeBytes: -1, walMarked: false, pagedAvailable: true }),
            /non-negative safe integer/
        );
        assert.throws(
            () => decideOpenPlan({ sizeBytes: Number.NaN, walMarked: false, pagedAvailable: true }),
            /non-negative safe integer/
        );
    });

    it('keeps the default constants coherent', () => {
        assert.ok(PAGED_OPEN_THRESHOLD_BYTES < BUFFER_OPEN_CEILING_BYTES);
        // The inline-bytes cutoff must match what the worker-request
        // transport guard accepts, or large posts would be rejected at
        // the RPC boundary.
        assert.strictEqual(DEMO_INLINE_CONTENT_MAX_BYTES, MAX_WEBVIEW_BINARY_VALUE_BYTES);
        assert.ok(DEMO_INLINE_CONTENT_MAX_BYTES < PAGED_OPEN_THRESHOLD_BYTES);
    });
});

// ---------------------------------------------------------------------------
// Worker File-open paths
// ---------------------------------------------------------------------------

describe('web demo worker File opens', () => {
    it('buffers small File handles editable, exactly like the bytes path', async () => {
        const harness = await createPagedHarness();
        const result = await harness.invoke(
            'initializeDatabase',
            'small.db',
            initConfig({ file: new StubFile(plainDbBytes, 'small.db') })
        );
        expectInitResult(result, { isReadOnly: false, storage: 'memory' });
        await expectRows(harness);
        await harness.invoke('updateCell', 'fixtures', 1, 'label', 'edited');
        assert.strictEqual(await readLabel(harness, 1), 'edited');
    });

    it('falls back to the editable buffer path when openPaged is absent (vendored build)', async () => {
        const harness = await createPagedHarness({ openPaged: 'absent' });
        const result = await harness.invoke(
            'initializeDatabase',
            'large.db',
            initConfig({
                file: new StubFile(plainDbBytes, 'large.db'),
                ...limitsAboveThreshold(plainDbBytes)
            })
        );
        expectInitResult(result, { isReadOnly: false, storage: 'memory' });
        await expectRows(harness);
        await harness.invoke('updateCell', 'fixtures', 1, 'label', 'still-editable');
    });

    it('edits, downloads, and reopens a File through the real writable paged VFS', async () => {
        const originalBase = plainDbBytes.slice();
        const harness = await createPagedHarness({ openPagedWritable: 'working' });
        const result = await harness.invoke(
            'initializeDatabase',
            'large.db',
            initConfig({
                file: new StubFile(plainDbBytes, 'large.db'),
                ...limitsAboveThreshold(plainDbBytes)
            })
        );
        expectInitResult(result, { isReadOnly: false, storage: 'paged' });
        assert.strictEqual(harness.openPagedWritableCalls, 1);
        assert.strictEqual(harness.openPagedCalls, 0);
        assert.ok(!harness.pagedSql.includes('PRAGMA query_only = ON'));

        await harness.invoke('updateCell', 'fixtures', 1, 'label', 'updated');
        await harness.invoke('insertRow', 'fixtures', { id: 65, label: 'inserted' });
        await harness.invoke('deleteRows', 'fixtures', [2]);
        assert.deepStrictEqual(plainDbBytes, originalBase, 'the uploaded File base must stay immutable');

        const exported = await harness.invoke('exportDatabase', 'main') as Uint8Array;
        assert.strictEqual(
            harness.lastResponseTransferCount,
            1,
            'the merged image must transfer to the page without a second structured-clone copy'
        );
        assert.deepStrictEqual(plainDbBytes, originalBase);
        const SQL = await initSqlJs({ wasmBinary });
        const reopened = new SQL.Database(exported);
        try {
            assert.deepStrictEqual(
                reopened.exec(
                    'SELECT id, label FROM fixtures WHERE id IN (1, 2, 65) ORDER BY id'
                )[0].values,
                [[1, 'updated'], [65, 'inserted']]
            );
            assert.deepStrictEqual(reopened.exec('PRAGMA integrity_check')[0].values, [['ok']]);
        } finally {
            reopened.close();
        }
    });

    it('surfaces a clean paged download refusal while a transaction is open', async () => {
        const harness = await createPagedHarness({ openPagedWritable: 'working' });
        await harness.invoke(
            'initializeDatabase',
            'large.db',
            initConfig({
                file: new StubFile(plainDbBytes, 'large.db'),
                ...limitsAboveThreshold(plainDbBytes)
            })
        );
        await harness.invoke('runQuery', 'BEGIN');
        await assert.rejects(
            harness.invoke('exportDatabase', 'main'),
            /cannot save.*transaction.*retry after the edit completes/i
        );
        await harness.invoke('runQuery', 'ROLLBACK');
    });

    it('opens a database above the browser save ceiling paged and read-only', async () => {
        const harness = await createPagedHarness({
            openPagedWritable: 'working',
            openPaged: 'working'
        });
        const saveCeiling = plainDbBytes.length - 1;
        const result = await harness.invoke(
            'initializeDatabase',
            'large.db',
            initConfig({
                file: new StubFile(plainDbBytes, 'large.db'),
                pagedOpenThresholdBytes: plainDbBytes.length - 2,
                bufferOpenCeilingBytes: saveCeiling,
                pagedExportMaxBytes: saveCeiling
            })
        );
        const normalizedResult = normalize(result) as any;
        assert.deepStrictEqual(
            {
                operations: normalizedResult.operations,
                isReadOnly: normalizedResult.isReadOnly,
                storage: normalizedResult.storage
            },
            { operations: {}, isReadOnly: true, storage: 'paged' }
        );
        assert.match(normalizedResult.readOnlyReason, /browser save limit.*read-only/i);
        assert.strictEqual(harness.openPagedWritableCalls, 0);
        assert.strictEqual(harness.openPagedCalls, 1);
        assert.ok(harness.pagedSql.includes('PRAGMA query_only = ON'));
        await assert.rejects(
            harness.invoke('updateCell', 'fixtures', 1, 'label', 'unsavable edit'),
            /read-only/i
        );
    });

    it('opens large File handles paged and read-only when only openPaged exists', async () => {
        const harness = await createPagedHarness({ openPaged: 'working' });
        const result = await harness.invoke(
            'initializeDatabase',
            'large.db',
            initConfig({
                file: new StubFile(plainDbBytes, 'large.db'),
                ...limitsAboveThreshold(plainDbBytes)
            })
        );
        expectInitResult(result, { isReadOnly: true, storage: 'paged' });
        assert.strictEqual(harness.openPagedCalls, 1);
        // Every VFS read stays inside the immutable uploaded-file snapshot;
        // SQLite is free to leave untouched pages unread.
        assert.ok(harness.hostReads.length >= 1);
        for (const read of harness.hostReads) {
            assert.ok(read.offset >= 0);
            assert.ok(read.length >= 0);
            assert.ok(read.offset + read.length <= plainDbBytes.length);
        }
        // The existing read-only machinery engaged on the paged handle.
        assert.ok(harness.pagedSql.includes('PRAGMA query_only = ON'));
        await expectRows(harness);
        await assert.rejects(
            harness.invoke('updateCell', 'fixtures', 1, 'label', 'nope'),
            /read-only/
        );
        await assert.rejects(
            harness.invoke('runQuery', 'SELECT 1'),
            /read-only/
        );
        await assert.rejects(
            harness.invoke('exportDatabase', 'main'),
            /read-only snapshots; export\(\).*openPagedWritable/
        );
    });

    it('falls back to read-only paging when openPagedWritable throws', async () => {
        const harness = await createPagedHarness({
            openPagedWritable: 'throwing',
            openPaged: 'working'
        });
        const result = await harness.invoke(
            'initializeDatabase',
            'large.db',
            initConfig({
                file: new StubFile(plainDbBytes, 'large.db'),
                ...limitsAboveThreshold(plainDbBytes)
            })
        );
        expectInitResult(result, { isReadOnly: true, storage: 'paged' });
        assert.strictEqual(harness.openPagedWritableCalls, 1);
        assert.strictEqual(harness.openPagedCalls, 1);
        await assert.rejects(
            harness.invoke('updateCell', 'fixtures', 1, 'label', 'nope'),
            /read-only/
        );
    });

    it('falls back to the editable buffer path when the paged open fails under the ceiling', async () => {
        const harness = await createPagedHarness({ openPaged: 'throwing' });
        const result = await harness.invoke(
            'initializeDatabase',
            'large.db',
            initConfig({
                file: new StubFile(plainDbBytes, 'large.db'),
                ...limitsAboveThreshold(plainDbBytes)
            })
        );
        assert.strictEqual(harness.openPagedCalls, 1);
        expectInitResult(result, { isReadOnly: false, storage: 'memory' });
        await expectRows(harness);
    });

    it('surfaces one clear message when the paged open fails on an oversized file', async () => {
        const harness = await createPagedHarness({ openPaged: 'throwing' });
        await assert.rejects(
            harness.invoke(
                'initializeDatabase',
                'huge.db',
                initConfig({
                    file: new StubFile(plainDbBytes, 'huge.db'),
                    ...limitsAboveCeiling(plainDbBytes)
                })
            ),
            (error: Error) => {
                assert.match(error.message, /too large to load into memory/);
                assert.match(
                    error.message,
                    /paged open failed: unable to open read-only paged database/
                );
                return true;
            }
        );
    });

    it('rejects oversized files plainly when the capability is absent', async () => {
        const harness = await createPagedHarness({ openPaged: 'absent' });
        await assert.rejects(
            harness.invoke(
                'initializeDatabase',
                'huge.db',
                initConfig({
                    file: new StubFile(plainDbBytes, 'huge.db'),
                    ...limitsAboveCeiling(plainDbBytes)
                })
            ),
            (error: Error) => {
                assert.match(error.message, /too large to load into memory/);
                assert.match(error.message, /page-on-demand mode is unavailable/);
                assert.doesNotMatch(error.message, /paged open failed/);
                return true;
            }
        );
    });

    it('routes large WAL-marked files to the read-only buffer path, never paged', async () => {
        const harness = await createPagedHarness({
            openPaged: 'working',
            openPagedWritable: 'working'
        });
        const result = await harness.invoke(
            'initializeDatabase',
            'wal.db',
            initConfig({
                file: new StubFile(walDbBytes, 'wal.db'),
                ...limitsAboveThreshold(walDbBytes)
            })
        );
        expectInitResult(result, { isReadOnly: true, storage: 'memory' });
        assert.strictEqual(harness.openPagedCalls, 0);
        assert.strictEqual(harness.openPagedWritableCalls, 0);
        await expectRows(harness);
        await assert.rejects(
            harness.invoke('updateCell', 'fixtures', 1, 'label', 'nope'),
            /read-only/
        );
    });

    it('rejects oversized WAL-marked files with the checkpoint message', async () => {
        const harness = await createPagedHarness({
            openPaged: 'working',
            openPagedWritable: 'working'
        });
        await assert.rejects(
            harness.invoke(
                'initializeDatabase',
                'wal.db',
                initConfig({
                    file: new StubFile(walDbBytes, 'wal.db'),
                    ...limitsAboveCeiling(walDbBytes)
                })
            ),
            new Error(WAL_TOO_LARGE_MESSAGE)
        );
        assert.strictEqual(harness.openPagedCalls, 0);
        assert.strictEqual(harness.openPagedWritableCalls, 0);
    });

    it('keeps small WAL-marked files on today\'s editable path', async () => {
        const harness = await createPagedHarness({
            openPaged: 'working',
            openPagedWritable: 'working'
        });
        const result = await harness.invoke(
            'initializeDatabase',
            'wal-small.db',
            initConfig({ file: new StubFile(walDbBytes, 'wal-small.db') })
        );
        expectInitResult(result, { isReadOnly: false, storage: 'memory' });
        assert.strictEqual(harness.openPagedCalls, 0);
        assert.strictEqual(harness.openPagedWritableCalls, 0);
        await harness.invoke('updateCell', 'fixtures', 1, 'label', 'editable');
    });

    it('keeps the inline-bytes path unchanged', async () => {
        const harness = await createPagedHarness({
            openPaged: 'working',
            openPagedWritable: 'working'
        });
        const result = await harness.invoke(
            'initializeDatabase',
            'bytes.db',
            initConfig({ content: plainDbBytes })
        );
        expectInitResult(result, { isReadOnly: false, storage: 'memory' });
        assert.strictEqual(harness.openPagedCalls, 0);
        assert.strictEqual(harness.openPagedWritableCalls, 0);
        await expectRows(harness);
        await harness.invoke('updateCell', 'fixtures', 1, 'label', 'edited');
    });

    it('keeps exact counts on paged storage for small files', async () => {
        const harness = await createPagedHarness({ openPaged: 'working' });
        await harness.invoke(
            'initializeDatabase',
            'large.db',
            initConfig({
                file: new StubFile(gappyDbBytes, 'large.db'),
                ...limitsAboveThreshold(gappyDbBytes)
                // Fixture is far below PAGED_EXACT_COUNT_MAX_FILE_BYTES.
            })
        );
        assert.strictEqual(await harness.invoke('fetchTableCount', 'fixtures', {}), 10000);
    });

    it('answers large paged unfiltered counts with the rowid-span upper bound', async () => {
        const harness = await createPagedHarness({ openPaged: 'working' });
        await harness.invoke(
            'initializeDatabase',
            'large.db',
            initConfig({
                file: new StubFile(gappyDbBytes, 'large.db'),
                ...limitsAboveThreshold(gappyDbBytes),
                // Treat every paged file as too large for an exact scan.
                pagedExactCountMaxFileBytes: 0
            })
        );
        // Exact count is 10000; min(rowid)=1 makes the span 19999.
        assert.strictEqual(await harness.invoke('fetchTableCount', 'fixtures', {}), 19999);
        // Filtered counts keep exact semantics (row-19999 uniquely matches).
        assert.strictEqual(
            await harness.invoke('fetchTableCount', 'fixtures', {
                columns: ['id', 'label'],
                filters: [{ column: 'label', value: 'row-19999' }]
            }),
            1
        );
        assert.strictEqual(
            await harness.invoke('fetchTableCount', 'extreme_rowids', {}),
            2,
            'unsafe spans must reject the shortcut and fall through to exact COUNT(*)'
        );
    });

    it('never rewrites counts on buffer storage', async () => {
        const harness = await createPagedHarness();
        await harness.invoke(
            'initializeDatabase',
            'bytes.db',
            initConfig({ content: gappyDbBytes, pagedExactCountMaxFileBytes: 0 })
        );
        assert.strictEqual(await harness.invoke('fetchTableCount', 'fixtures', {}), 10000);
    });

    it('re-initializes cleanly from paged to bytes (close on a paged handle)', async () => {
        const harness = await createPagedHarness({ openPaged: 'working' });
        const first = await harness.invoke(
            'initializeDatabase',
            'large.db',
            initConfig({
                file: new StubFile(plainDbBytes, 'large.db'),
                ...limitsAboveThreshold(plainDbBytes)
            })
        );
        assert.strictEqual(first.storage, 'paged');
        const second = await harness.invoke(
            'initializeDatabase',
            'bytes.db',
            initConfig({ content: plainDbBytes })
        );
        expectInitResult(second, { isReadOnly: false, storage: 'memory' });
        await harness.invoke('updateCell', 'fixtures', 1, 'label', 'writable-again');
    });
});
