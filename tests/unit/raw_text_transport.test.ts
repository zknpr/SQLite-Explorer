import './vscode_mock_setup';

import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { buildCellContainmentQuery, containUnrepresentableTextCells, decodeRawTextColumns } from '../../src/core/cell-containment';

async function database(t: TestContext, encoding = 'UTF-8') {
    const { operations } = await createDatabaseEngine({ content: null, maxSize: 0 });
    const engine = operations as WasmDatabaseEngine;
    t.after(() => engine.shutdown());
    await engine.executeQuery(`PRAGMA encoding = '${encoding}'`);
    return engine;
}

it('pools actual SQLite raw TEXT companions into bounded backing slabs', async t => {
    const engine = await database(t);
    const columns = Array.from({ length: 8 }, (_, index) => `c${index}`);
    await engine.executeQuery(
        `CREATE TABLE wide(${columns.map(column => `${column} TEXT`).join(',')});`
        + 'WITH RECURSIVE rows(id) AS (VALUES(1) UNION ALL SELECT id + 1 FROM rows WHERE id < 1000)'
        + ` INSERT INTO wide SELECT ${columns.map(column => `'${column}-' || id`).join(',')} FROM rows`
    );
    const query = buildCellContainmentQuery('SELECT * FROM wide LIMIT 1000', columns.length,
        { limit: 1000 }, columns.map((_, index) => index), 'hex');
    const rows = (await engine.executeQuery(query.sql))[0].rows;
    assert.equal(typeof rows[0][query.rawTextColumnStart], 'string');
    const raw = decodeRawTextColumns(rows, query);
    const buffers = new Set(raw.flat().filter(value => value !== null).map(value => value.buffer));
    assert.equal(buffers.size, 1, 'short cell companions share one 64 KiB slab, not one ArrayBuffer per cell');
    assert.ok([...buffers].every(buffer => buffer.byteLength <= 64 * 1024));
    assert.deepEqual(raw[0][0], new TextEncoder().encode('c0-1'));
    assert.deepEqual(raw[999][7], new TextEncoder().encode('c7-1000'));
    assert.notEqual(raw[0][0], raw[0][1]);
});

it('does not allocate sql.js BLOB buffers for ordinary TEXT in the public WASM page path', async t => {
    const engine = await database(t);
    await engine.executeQuery(
        'CREATE TABLE entries(id INTEGER PRIMARY KEY, a TEXT, b TEXT);'
        + 'WITH RECURSIVE rows(id) AS (VALUES(1) UNION ALL SELECT id + 1 FROM rows WHERE id < 1000)'
        + " INSERT INTO entries SELECT id, 'a-' || id, 'b-' || id FROM rows"
    );
    type Statement = { getBlob(index?: number): Uint8Array };
    const instance = (engine as unknown as { instance: { prepare(...args: unknown[]): Statement } }).instance;
    const prepare = instance.prepare;
    let blobCopies = 0;
    t.mock.method(instance, 'prepare', function (...args: unknown[]) {
        const statement = prepare.apply(instance, args);
        const getBlob = statement.getBlob;
        statement.getBlob = function (index?: number) {
            blobCopies++;
            return getBlob.call(statement, index);
        };
        return statement;
    });
    const page = await engine.fetchTableData('entries', { columns: ['rowid', 'id', 'a', 'b'], limit: 1000, offset: 0 });
    assert.deepEqual(page.rows[0], [1, 1, 'a-1', 'b-1']);
    assert.deepEqual(page.rows.at(-1), [1000, 1000, 'a-1000', 'b-1000']);
    assert.equal(blobCopies, 0, 'the private raw-TEXT proof must not allocate a backing store for each cell');
});

for (const [encoding, malformed, nul] of [
    ['UTF-8', '80', '610062'],
    ['UTF-16le', '00D8', '610000006200'],
    ['UTF-16be', 'D800', '006100000062']
]) {
    it(`retains exact ${encoding} malformed, NUL, empty, NULL and oversized TEXT bytes`, async t => {
        const engine = await database(t, encoding);
        await engine.executeQuery(
            'CREATE TABLE cells(id INTEGER PRIMARY KEY, value TEXT);'
            + `INSERT INTO cells VALUES(1, CAST(X'${malformed}' AS TEXT)), (2, CAST(X'${nul}' AS TEXT)),`
            + " (3, ''), (4, NULL), (5, 'ordinary'), (9223372036854775806, 'large')"
        );
        const query = buildCellContainmentQuery('SELECT value FROM cells ORDER BY id', 1, { limit: 6 }, [0], 'hex');
        const transport = (await engine.executeQuery(query.sql))[0].rows;
        const raw = decodeRawTextColumns(transport, query);
        assert.deepEqual(raw[0][0], new Uint8Array(Buffer.from(malformed, 'hex')));
        assert.deepEqual(raw[1][0], new Uint8Array(Buffer.from(nul, 'hex')));
        assert.equal(raw[2][0]?.byteLength, 0);
        assert.equal(raw[3][0], null);

        const page = await engine.fetchTableData('cells', { columns: ['rowid', 'id', 'value'], limit: 6, offset: 0 });
        assert.deepEqual(page.rows[0][2], raw[0][0]);
        assert.deepEqual(page.rows[1][2], raw[1][0]);
        assert.equal(page.rows[2][2], '');
        assert.equal(page.rows[3][2], null);
        assert.equal(page.rows[4][2], 'ordinary');
        assert.equal(page.oversizedCells?.[0]?.[2].byteLength, malformed.length / 2);
        assert.equal(page.oversizedCells?.[1]?.[2].byteLength, nul.length / 2);
        assert.equal(page.rows[5][0], '9223372036854775806');
        assert.equal(page.exactIntegerTexts?.[5]?.[1], '9223372036854775806');

        const clipped = await engine.fetchTableData('cells', {
            columns: ['rowid', 'id', 'value'], limit: 6, offset: 0, maxInlineCellBytes: 4, maxPageResponseBytes: 1024
        });
        assert.equal(clipped.oversizedCells?.[4]?.[2].storageClass, 'text');
        assert.equal(clipped.oversizedCells?.[4]?.[2].byteLength, encoding === 'UTF-8' ? 8 : 16);
    });
}

it('keeps the default native raw TEXT transport as BLOBs', async t => {
    const engine = await database(t);
    const query = buildCellContainmentQuery("SELECT 'native'", 1, { limit: 1 }, [0]);
    const rows = (await engine.executeQuery(query.sql))[0].rows;
    assert.ok(rows[0][query.rawTextColumnStart] instanceof Uint8Array);
    assert.deepEqual(decodeRawTextColumns(rows, query)[0][0], new TextEncoder().encode('native'));
});

it('handles slab rollover and isolates a large cell without reserving a complete page', () => {
    const query = buildCellContainmentQuery('SELECT value FROM cells', 1, { limit: 3 }, [0], 'hex');
    const hexRows = [40000, 40000, 70000].map(length => [null, '', 'ab'.repeat(length)]);
    const raw = decodeRawTextColumns(hexRows, query);
    assert.equal(raw[0][0]?.buffer.byteLength, 64 * 1024);
    assert.equal(raw[1][0]?.buffer.byteLength, 64 * 1024);
    assert.equal(raw[2][0]?.buffer.byteLength, 70000);
    assert.notEqual(raw[0][0]?.buffer, raw[1][0]?.buffer);
    assert.deepEqual(raw.map(row => [row[0]?.[0], row[0]?.at(-1)]), [[0xab, 0xab], [0xab, 0xab], [0xab, 0xab]]);
});

it('rejects malformed or over-window hexadecimal transport before retaining bytes', () => {
    const query = buildCellContainmentQuery('SELECT value FROM cells', 1, { limit: 1, maxInlineCellBytes: 2 }, [0], 'hex');
    for (const value of ['0', 'xx', '000000', 123, Uint8Array.of(1)]) {
        assert.throws(() => decodeRawTextColumns([[null, '', value]], query), /Raw TEXT/);
    }
});

it('copies a retained malformed TEXT prefix so its pooled backing slab cannot escape', () => {
    const query = buildCellContainmentQuery('SELECT a, b FROM cells', 2, { limit: 1 }, [0, 1], 'hex');
    const raw = decodeRawTextColumns([['�', '�', '', '80', 'EFBFBD']], query);
    const contained = containUnrepresentableTextCells({
        sourceRows: [['�', '�']], rawTextRows: raw, rawTextColumnIndices: [0, 1],
        textEncoding: 'utf-8', contained: { rows: [['�', '�']] }
    });
    const prefix = contained.rows[0][0];
    assert.ok(prefix instanceof Uint8Array);
    assert.equal(prefix.buffer.byteLength, 1);
    assert.notEqual(prefix.buffer, raw[0][0]?.buffer);
    raw[0][0]![0] = 0x41;
    assert.deepEqual(prefix, Uint8Array.of(0x80));
    assert.equal(contained.rows[0][1], '�');
});
