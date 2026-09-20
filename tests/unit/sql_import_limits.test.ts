import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import { serializeOperations, runReadSnapshot } from '../../src/core/operation-serializer';
import type { DatabaseOperations } from '../../src/core/types';
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, IMPORT_MAX_COLUMNS, parseImport, mapImportRows, importRowsAtomically } from '../../src/core/bulk-import';
import { prepareReadQuery, parseQueryParameters, resultCsv, SQL_MAX_TEXT } from '../../src/core/sql-workspace';

it('accepts the exact CSV/JSON row, column and UTF-8 source limits and rejects the next unit', () => {
    assert.equal(IMPORT_MAX_BYTES, 64 * 1024 * 1024);
    assert.equal(IMPORT_MAX_ROWS, 100_000);
    assert.equal(IMPORT_MAX_COLUMNS, 256);
    for (const format of ['csv', 'json'] as const) {
        const source = (count: number) => format === 'csv'
            ? 'id\n' + Array.from({ length: count }, (_, i) => String(i)).join('\n')
            : JSON.stringify(Array.from({ length: count }, (_, id) => ({ id })));
        assert.equal(parseImport(source(IMPORT_MAX_ROWS), format).rows.length, IMPORT_MAX_ROWS);
        assert.throws(() => parseImport(source(IMPORT_MAX_ROWS + 1), format), /100,000/);
        const wide = (count: number) => format === 'csv'
            ? Array.from({ length: count }, (_, i) => `c${i}`).join(',') + '\n' + Array(count).fill('x').join(',')
            : JSON.stringify([Object.fromEntries(Array.from({ length: count }, (_, i) => [`c${i}`, 'x']))]);
        assert.equal(parseImport(wide(256), format).columns.length, 256);
        assert.throws(() => parseImport(wide(257), format), /256/);
        const prefix = format === 'csv' ? 'v\n' : '[{"v":"';
        const suffix = format === 'csv' ? '' : '"}]';
        const valueBytes = IMPORT_MAX_BYTES - prefix.length - suffix.length;
        const exact = prefix + 'é'.repeat(Math.floor(valueBytes / 2)) + 'x'.repeat(valueBytes % 2) + suffix;
        assert.equal(Buffer.byteLength(exact), IMPORT_MAX_BYTES);
        assert.equal(parseImport(exact, format).rows.length, 1);
        assert.throws(() => parseImport(exact + ' ', format), /64 MiB/);
    }
});

it('retains CSV empty/multiline fields and JSON defaults through partial mappings', () => {
    const parsed = parseImport('id,value,ignored\r\n1,"",x\r\n2,"a\rb\nc\r\nd",y\r\n3,last,z', 'csv');
    assert.deepEqual(mapImportRows(parsed, ['id', 'text', undefined]), [
        { id: '1', text: '' }, { id: '2', text: 'a\rb\nc\r\nd' }, { id: '3', text: 'last' }
    ]);
    const missing = parseImport('[{"keep":"value"},{"skip":1}]', 'json');
    assert.deepEqual(mapImportRows(missing, ['value', undefined]), [{ value: 'value' }, {}]);
    for (const input of ['[]', '[{}]', '[{"v":true}]', '[{"v":[]}]']) {
        assert.throws(() => parseImport(input, 'json'));
    }
});

it('bounds dense CSV/JSON sources by cell count and checks supplementary UTF-8 bytes', () => {
    const columns = Array.from({ length: 25 }, (_, index) => `c${index}`);
    const csv = columns.join(',') + '\n' + (Array(25).fill('').join(',') + '\n').repeat(80_000);
    assert.equal(parseImport(csv, 'csv').rows.length, 80_000);
    assert.throws(() => parseImport(csv + Array(25).fill('').join(','), 'csv'), /2,000,000 source cells/);
    const row = Object.fromEntries(columns.map(column => [column, '']));
    const json = JSON.stringify(Array(80_000).fill(row));
    assert.equal(parseImport(json, 'json').rows.length, 80_000);
    assert.throws(() => parseImport(json.slice(0, -1) + ',{"c0":""}]', 'json'), /2,000,000 source cells/);
    for (const source of ['["text"]', '[1]', '[null]', '[{} , []]', '[{"v":{"nested":1}}]']) assert.throws(() => parseImport(source, 'json'));
    const supplementary = 'v\n' + '😀'.repeat((IMPORT_MAX_BYTES - 4) / 4) + 'xx';
    assert.equal(Buffer.byteLength(supplementary), IMPORT_MAX_BYTES);
    assert.equal(parseImport(supplementary, 'csv').rows.length, 1);
    assert.throws(() => parseImport(supplementary + '\ud800', 'csv'), /64 MiB/);
});

it('checks exact SQL and parameter limits while ignoring literal/comment placeholders', () => {
    const sql = 'SELECT 1' + ' '.repeat(SQL_MAX_TEXT - 8);
    assert.doesNotThrow(() => prepareReadQuery(sql));
    assert.throws(() => prepareReadQuery(sql + ' '), /65,536/);
    assert.equal(prepareReadQuery("SELECT '?', ?2, ?1, ? -- ?100\n").parameterCount, 3);
    assert.equal(prepareReadQuery('SELECT ?100').parameterCount, 100);
    assert.throws(() => prepareReadQuery('SELECT ?101'), /100 positional/);
    assert.throws(() => prepareReadQuery('SELECT ?0'), /100 positional/);
    assert.equal(parseQueryParameters(JSON.stringify(Array(100).fill(null))).length, 100);
    assert.throws(() => parseQueryParameters(JSON.stringify(Array(101).fill(null))), /100 values/);
    assert.equal(parseQueryParameters('["' + 'x'.repeat(SQL_MAX_TEXT - 4) + '"]')[0]!.toString().length, SQL_MAX_TEXT - 4);
    assert.throws(() => parseQueryParameters('["' + 'x'.repeat(SQL_MAX_TEXT - 3) + '"]'), /65,536/);
});

async function withBackend(backend: 'wasm' | 'native', action: (ops: DatabaseOperations) => Promise<void>) {
    const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    const wasm = opened.operations as WasmDatabaseEngine;
    let native: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
    let directory: string | undefined;
    try {
        let ops: DatabaseOperations = serializeOperations(wasm);
        if (backend === 'native') {
            fs.mkdirSync('.tmp', { recursive: true });
            directory = fs.mkdtempSync(path.resolve('.tmp/improvements-qa-'));
            const file = path.join(directory, 'fixture.db');
            fs.writeFileSync(file, await wasm.serializeDatabase());
            native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
            ops = (await native.establishConnection(vscode.Uri.file(file), 'qa', false)).databaseOps;
        }
        await action(ops);
    } finally {
        native?.workerMethods[Symbol.dispose](); wasm.shutdown();
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
}

for (const backend of ['wasm', 'native'] as const) {
    it(`${backend} imports and replays a source at the full 64 MiB byte limit without clipping`, async t => {
        await withBackend(backend, async ops => {
            await ops.executeQuery('CREATE TABLE payloads (value TEXT)');
            const valueBytes = (IMPORT_MAX_BYTES - 6 - 7) / 8;
            const source = 'value\n' + Array.from({ length: 8 }, (_, i) => 'x'.repeat(Math.floor(valueBytes) + (i < 3 ? 1 : 0))).join('\n');
            assert.equal(Buffer.byteLength(source), IMPORT_MAX_BYTES);
            const rows = parseImport(source, 'csv').rows;
            const start = performance.now();
            const modification = await importRowsAtomically(ops, 'payloads', rows, 256 * 1024 * 1024);
            const imported = performance.now();
            const sizes = async () => (await ops.executeQuery('SELECT count(*), coalesce(sum(octet_length(value)), 0) FROM payloads'))[0].rows;
            assert.deepEqual(await sizes(), [[8, IMPORT_MAX_BYTES - 13]]);
            await ops.undoModification(modification);
            assert.deepEqual(await sizes(), [[0, 0]]);
            const undone = performance.now();
            await ops.redoModification(modification);
            assert.deepEqual(await sizes(), [[8, IMPORT_MAX_BYTES - 13]]);
            t.diagnostic(JSON.stringify({ backend, sourceBytes: IMPORT_MAX_BYTES, importMs: imported - start, undoMs: undone - imported, redoMs: performance.now() - undone }));
        });
    });

    it(`${backend} read workspace preserves empty headers, ordering, width limits and transaction visibility`, async () => {
        await withBackend(backend, async ops => {
            const empty = await ops.executeReadQuery('SELECT 1 AS value WHERE 0');
            assert.deepEqual(empty, { headers: ['value'], rows: [] });
            assert.equal(resultCsv(empty), '"value"');
            const width = (count: number) => 'SELECT ' + Array.from({ length: count }, (_, i) => `${i} AS c${i}`).join(',');
            const wide = await ops.executeReadQuery(width(128));
            assert.equal(wide.headers.length, 128); assert.equal(wide.rows[0][127], 127);
            await assert.rejects(ops.executeReadQuery(width(129)), /128/);
            const label = 'é'.repeat(4096);
            assert.equal((await ops.executeReadQuery(`SELECT 1 AS "${label}"`)).headers[0], label);
            await assert.rejects(ops.executeReadQuery(`SELECT 1 AS "${label}é"`), /4096/);
            assert.deepEqual((await ops.executeReadQuery('SELECT ?2 AS second, ?1 AS first, ? AS third', ['a', 'b', 'c'])).rows, [['b', 'a', 'c']]);
            assert.deepEqual((await ops.executeReadQuery('SELECT 3 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 ORDER BY n DESC')).rows, [[3], [2], [1]]);
            await ops.executeQuery('CREATE TABLE pending (value INTEGER)');
            await runReadSnapshot(ops, async transaction => {
                await transaction.executeQuery('INSERT INTO pending VALUES (42)');
                assert.deepEqual((await transaction.executeReadQuery('SELECT value FROM pending')).rows, [[42]]);
            });
            assert.ok((await ops.executeReadQuery('SELECT value FROM pending', [], true)).rows.length);
            assert.deepEqual((await ops.executeReadQuery('SELECT value FROM pending')).rows, [[42]]);
            assert.deepEqual((await ops.executeQuery('SELECT name FROM sqlite_temp_schema'))[0]?.rows ?? [], []);
        });
    });

    it(`${backend} imports 100,000 rows atomically, preserves defaults/generated values, and reverses one edit`, async () => {
        await withBackend(backend, async ops => {
            await ops.executeQuery("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT DEFAULT 'default', doubled INTEGER GENERATED ALWAYS AS (id * 2) STORED)");
            const rows = Array.from({ length: IMPORT_MAX_ROWS }, (_, index) => ({ id: index + 1 }));
            const count = async () => (await ops.executeQuery('SELECT count(*) FROM items'))[0].rows[0][0];
            const modification = await importRowsAtomically(ops, 'items', rows, 50 * 1024 * 1024);
            assert.equal(modification.insertedRows!.length, IMPORT_MAX_ROWS);
            assert.equal(await count(), IMPORT_MAX_ROWS);
            assert.deepEqual((await ops.executeQuery('SELECT value, doubled FROM items WHERE id=10000'))[0].rows, [['default', 20000]]);
            await ops.undoModification(modification); assert.equal(await count(), 0);
            await ops.redoModification(modification); assert.equal(await count(), IMPORT_MAX_ROWS);
            await assert.rejects(importRowsAtomically(ops, 'items', [...rows, { id: IMPORT_MAX_ROWS + 1 }], 50 * 1024 * 1024), /100,000/);
            assert.equal(await count(), IMPORT_MAX_ROWS);
            const abort = new AbortController();
            await assert.rejects(importRowsAtomically(ops, 'items', Array.from({ length: 150 }, (_, i) => ({ id: i + IMPORT_MAX_ROWS + 1 })),
                1024 * 1024, abort.signal, completed => { if (completed === 55) abort.abort(); }), /abort/i);
            assert.equal(await count(), IMPORT_MAX_ROWS);
        });
    });

    it(`${backend} import handles quoted composite keys and rolls back constraint and history failures`, async () => {
        await withBackend(backend, async ops => {
            await ops.executeQuery('CREATE TABLE "odd table" ("group" TEXT, "key" INTEGER, value TEXT NOT NULL DEFAULT \'ok\', PRIMARY KEY ("group", "key")) WITHOUT ROWID');
            const modification = await importRowsAtomically(ops, 'odd table', [{ group: 'a"b', key: '9223372036854775807' }, { group: 'a"b', key: 2 }], 1024 * 1024);
            await ops.undoModification(modification);
            await ops.redoModification(modification);
            assert.deepEqual((await ops.executeQuery('SELECT "group", CAST("key" AS TEXT), value FROM "odd table" ORDER BY "key"'))[0].rows,
                [['a"b', '2', 'ok'], ['a"b', '9223372036854775807', 'ok']]);
            await assert.rejects(importRowsAtomically(ops, 'odd table', [{ group: 'c', key: 1 }, { group: 'c', key: 2, value: null }], 1024 * 1024), /NOT NULL|constraint/i);
            await assert.rejects(importRowsAtomically(ops, 'odd table', [{ group: 'c', key: 1 }, { group: 'c', key: 2, value: 'x'.repeat(10000) }], 1500), /snapshot|memory|limit/i);
            assert.deepEqual((await ops.executeQuery('SELECT count(*) FROM "odd table"'))[0].rows, [[2]]);
        });
    });
}
