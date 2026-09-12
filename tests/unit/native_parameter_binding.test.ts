import './vscode_mock_setup';

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it, type TestContext } from 'node:test';
import { NativeWorkerProcess } from '../../src/nativeWorker';

async function fixture(t: TestContext) {
    const platform = process.platform === 'darwin'
        ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-macos`
        : process.platform === 'linux'
            ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-linux-gnu`
            : 'x86_64-windows';
    const root = process.cwd();
    const binary = path.join(root, 'natives', platform, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
    if (!fs.existsSync(binary)) {
        t.skip(`no bundled native runtime for ${process.platform}-${process.arch}`);
        return;
    }
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, '.tmp', 'native-parameter-binding-'));
    const file = path.join(directory, 'test.db');
    const seed = new DatabaseSync(file);
    seed.exec('CREATE TABLE entries(value)');
    seed.close();
    const worker = new NativeWorkerProcess(binary, path.join(root, 'natives', 'native-worker.js'));
    t.after(async () => {
        try { await worker.call('close', []); }
        finally {
            worker.stop();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    await worker.start();
    await worker.call('open', [file, false]);
    const stored = () => {
        const independent = new DatabaseSync(file, { readOnly: true });
        try {
            return independent.prepare('SELECT typeof(value) AS type, hex(value) AS bytes FROM entries ORDER BY rowid')
                .all().map(row => [row.type, row.bytes]);
        } finally { independent.close(); }
    };
    return { worker, stored };
}

// A view also verifies that the worker binds only the requested bytes, not its
// backing buffer. NULL and Uint8Array are both objects at the txiki overload.
const blob = new Uint8Array([0x99, 0x00, 0xff, 0xa5, 0x88]).subarray(1, 4);
const cases: [string, unknown, string, string][] = [
    ['NULL', null, 'null', ''],
    ['BLOB', blob, 'blob', '00FFA5'],
    ['empty BLOB', new Uint8Array(), 'blob', ''],
    ['empty TEXT', '', 'text', ''],
    ['INTEGER', 7, 'integer', '37']
];

for (const [name, value, type, bytes] of cases) {
    it(`binds a single ${name} through native run without changing its storage class`, async t => {
        const f = await fixture(t); if (!f) return;
        await f.worker.call('run', ['INSERT INTO entries(value) VALUES (?)', [value]]);
        assert.deepEqual(f.stored(), [[type, bytes]]);
    });
}

it('binds all single-value shapes and mixed values through native query', async t => {
    const f = await fixture(t); if (!f) return;
    for (const [, value, type, bytes] of cases) {
        const result: { values: unknown[][] } = await f.worker.call('query', [
            'SELECT typeof(?1) AS type, hex(?1) AS bytes', [value]
        ]);
        assert.deepEqual(result.values, [[type, bytes]]);
    }
    const mixed = await f.worker.call<{ values: unknown[][] }>('query', [
        'SELECT typeof(?) AS type, hex(?) AS bytes, ? AS text, ? AS number', [null, blob, '', 7]
    ]);
    assert.deepEqual(mixed.values, [['null', '00FFA5', '', 7]]);
    assert.deepEqual((await f.worker.call<{ values: unknown[][] }>('query', ['SELECT 42'])).values, [[42]]);
});

it('preserves single-value parameters through the native single-statement routes', async t => {
    const f = await fixture(t); if (!f) return;
    const boundary = '/*native_parameter_binding*/';
    const insert = 'INSERT INTO entries(value) VALUES (?)';
    const select = 'SELECT typeof(?1) AS type, hex(?1) AS bytes';
    for (const [, value, type, bytes] of cases) {
        await f.worker.call('runSingle', [`${insert}\n${boundary}`, insert, [value], boundary]);
        const result: { values: unknown[][] } = await f.worker.call('querySingle', [
            `${select}\n${boundary}`, [value], boundary
        ]);
        assert.deepEqual(result.values, [[type, bytes]]);
    }
    assert.deepEqual(f.stored(), cases.map(([, , type, bytes]) => [type, bytes]));
});

it('preserves NULL and BLOB parameters when reusing native batch statements', async t => {
    const f = await fixture(t); if (!f) return;
    await f.worker.call('execBatch', [[{
        sql: 'INSERT INTO entries(value) VALUES (?)',
        paramsList: cases.map(([, value]) => [value])
    }, { sql: 'INSERT INTO entries(value) VALUES (?)', params: [blob] }]]);
    assert.deepEqual(f.stored(), [...cases.map(([, , type, bytes]) => [type, bytes]), ['blob', '00FFA5']]);
});

it('preserves single-value bindings in the main-connection SQL workspace fallback', async t => {
    const f = await fixture(t); if (!f) return;
    await f.worker.call('run', ['CREATE TEMP TABLE use_main_connection(value)']);
    for (const [, value, type, bytes] of cases) {
        const result: { values: unknown[][] } = await f.worker.call('workspaceQuery', [
            'SELECT typeof(?1) AS type, hex(?1) AS bytes', '/*native_parameter_binding*/',
            [value], ['type', 'bytes'], 1000
        ]);
        assert.deepEqual(result.values, [[type, bytes]]);
    }
});

it('binds and rebinds every value through native prepared statement dispatch', async t => {
    const f = await fixture(t); if (!f) return;
    const insert = await f.worker.call<{ stmtId: number }>('prepare', ['INSERT INTO entries(value) VALUES (?)']);
    const select = await f.worker.call<{ stmtId: number }>('prepare', ['SELECT typeof(?1) AS type, hex(?1) AS bytes']);
    try {
        for (const [, value, type, bytes] of cases) {
            const run: { changes: number } = await f.worker.call('stmtRun', [insert.stmtId, [value]]);
            assert.equal(run.changes, 1);
            const result: { values: unknown[][] } = await f.worker.call('stmtAll', [select.stmtId, [value]]);
            assert.deepEqual(result.values, [[type, bytes]]);
        }
        assert.deepEqual(f.stored(), cases.map(([, , type, bytes]) => [type, bytes]));
    } finally {
        await f.worker.call('stmtFinalize', [insert.stmtId]);
        await f.worker.call('stmtFinalize', [select.stmtId]);
    }
});

it('still rejects non-array native query and statement bindings', async t => {
    const f = await fixture(t); if (!f) return;
    await assert.rejects(f.worker.call('run', ['INSERT INTO entries VALUES (?)', { value: 7 }]), /parameters must be an array/);
    await assert.rejects(f.worker.call('query', ['SELECT ?', { value: 7 }]), /parameters must be an array/);
    assert.deepEqual(f.stored(), []);
});
