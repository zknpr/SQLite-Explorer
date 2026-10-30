import './vscode_mock_setup';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, nativeGridRowPack, NativeWorkerProcess } from '../../src/nativeWorker';
import { buildCellContainmentQuery, mergeCellContainmentMetadataRows } from '../../src/core/cell-containment';
import { buildCellPackSelectList, buildCellPackWrappedQuery, decodeCellPackRows } from '../../src/core/cell-pack';
import { buildSelectQuery } from '../../src/core/query-builder';
import type { QueryResultSet, TableQueryOptions } from '../../src/core/types';

// Row-packed grid pages (sqlite_explorer_cell_pack) against the 'checked'
// helper path they replace: every fetchTableData result must be identical.
// The TEXT fixture mirrors tests/unit/grid_cell_helpers.test.ts.

const TEXT_BYTES = [
    '', '41', '00', '410042', 'efbbbf41', '41efbbbf', 'eda080', 'c080', 'e08280', 'f4908080',
    'e4b8', '80', 'ff', 'efbfbe', 'efbfbf', 'f09f9880', 'c3a9', 'c3a9'.repeat(200),
    'f09f9880'.repeat(100), '61'.repeat(301), '0000000000', 'c3a9'.repeat(149) + 'f09f9880',
    '8080' + '61'.repeat(400), 'c3' + '80'.repeat(400), '61'.repeat(100) + '00' + '62'.repeat(300)
];
const NOT_PLAIN_UTF8 = ['c1bf', 'e09fbf', 'edbfbf', 'f08fbfbf', 'f5808080', 'f09f98', '41c3'];
const PLAIN_UTF8 = ['c280', 'dfbf', 'e0a080', 'ed9fbf', 'ee8080', 'efbfbd', 'f0908080', 'f48fbfbf', 'efb790', 'f09fbfbe'];
TEXT_BYTES.push(...NOT_PLAIN_UTF8, ...PLAIN_UTF8);

const ROWID_FIXTURE_SQL = [
    'CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT, t TEXT, b BLOB, r REAL, i INTEGER, u)',
    ...TEXT_BYTES.map((hex, index) => {
        const blob = ["x''", "x'000102'", 'zeroblob(400)', 'NULL'][index % 4];
        const real = ['0.1', '1.0 / 3', '1e300', '-0.0', '2.0', 'NULL'][index % 6];
        const integer = ['9223372036854775807', '9007199254740993', '-1', 'NULL'][index % 4];
        const untyped = ["CAST(x'ff' AS TEXT)", '2.5', "'plain'", 'NULL'][index % 4];
        return `INSERT INTO t VALUES (${index + 1}, 'row ${index}', CAST(x'${hex}' AS TEXT), ` +
            `${blob}, ${real}, ${integer}, ${untyped})`;
    }),
    'CREATE VIEW vt AS SELECT label, t, b FROM t'
].join(';\n');
const FIXTURE_SQL = [
    ROWID_FIXTURE_SQL,
    'CREATE TABLE p (k TEXT PRIMARY KEY, v) WITHOUT ROWID',
    ...TEXT_BYTES.map((hex, index) => `INSERT INTO p VALUES (CAST(x'${hex}' AS TEXT), ${index})`)
].join(';\n');

const PAGES: Array<[string, string, TableQueryOptions]> = [
    ['rowid order', 't', {
        columns: ['rowid', 'id', 'label', 't', 'b', 'r', 'i', 'u'], limit: 100, offset: 0, maxInlineCellBytes: 300
    }],
    ['a TEXT sort with keyset anchors', 't', {
        columns: ['rowid', 'id', 'label', 't', 'b', 'r', 'i', 'u'], orderBy: 't', limit: 100, offset: 0,
        maxInlineCellBytes: 300
    }],
    ['an exhausted page budget', 't', {
        columns: ['rowid', 'id', 'label', 't', 'b', 'r', 'i', 'u'], limit: 100, offset: 0,
        maxInlineCellBytes: 300, maxPageResponseBytes: 600
    }],
    ['a WITHOUT ROWID TEXT key', 'p', { columns: ['rowid', 'k', 'v'], limit: 100, offset: 0, maxInlineCellBytes: 300 }],
    ['an identityless view', 'vt', { columns: ['label', 't', 'b'], limit: 100, offset: 0, maxInlineCellBytes: 300 }]
];

const WINDOW = 300;
const PACK = 'sqlite_explorer_cell_pack(';
const WRAPPED = '__sqlite_explorer_cell_pack_source';

// Literal cells for the generated tables, spanning every pack tag and the
// edges of the 300-byte window and its 75-character TEXT preview.
const hexText = (hex: string) => `CAST(x'${hex}' AS TEXT)`;
const CELL_LITERALS = [
    'NULL', '0', '1', '-1', '9007199254740991', '9007199254740993', '9223372036854775807',
    '(-9223372036854775807 - 1)',
    '0.1', '1.0 / 3', '1e300', '-0.0', '2.0', '5e-324', '1.7976931348623157e308', '1e999', '-1e999',
    '9007199254740993.0', '123456789012345678.0', '0.000001', '-2.5e-308',
    ...TEXT_BYTES.map(hexText),
    `'${'a'.repeat(WINDOW - 1)}'`, `'${'a'.repeat(WINDOW)}'`, `'${'a'.repeat(WINDOW + 1)}'`,
    `'${'é'.repeat(WINDOW / 2)}'`, `'${'é'.repeat(WINDOW / 2)}a'`, `'${'😀'.repeat(80)}'`,
    `'${'a'.repeat(74)}😀${'b'.repeat(300)}'`, hexText('efbbbf' + '61'.repeat(40)),
    hexText('efbbbf' + '61'.repeat(WINDOW)), hexText('ff'.repeat(WINDOW + 1)),
    "x''", "x'00'", `zeroblob(${WINDOW - 1})`, `zeroblob(${WINDOW})`, `zeroblob(${WINDOW + 1})`, "x'deadbeef'"
];

function makeLcg(seed: number) {
    return (bound: number) => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed % bound;
    };
}

function generatedTableSql(name: string, width: number, rows: number, seed: number, distinctRows: Set<string>,
    usedLiterals: Set<number>, literals: readonly string[] = CELL_LITERALS): string {
    const next = makeLcg(seed);
    const columns = Array.from({ length: width }, (_, index) => `c${index}`);
    const statements = [`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, ${columns.join(', ')})`];
    for (let row = 0; row < rows; row++) {
        const picks = columns.map(() => next(literals.length));
        picks.forEach(pick => usedLiterals.add(pick));
        distinctRows.add(picks.join(','));
        statements.push(`INSERT INTO ${name} VALUES (${row + 1}, ${picks.map(pick => literals[pick]).join(', ')})`);
    }
    statements.push(`CREATE VIEW ${name}_v AS SELECT ${columns.slice(0, Math.min(width, 120)).join(', ')} FROM ${name}`);
    return statements.join(';\n');
}

async function openEngine(sql: string) {
    const seed = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    await seed.executeQuery(sql);
    const image = await seed.serializeDatabase();
    seed.shutdown();
    const engine = (await createDatabaseEngine({ content: image, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    const pageSql: string[] = [];
    const instance = (engine as any).instance;
    const prepare = instance.prepare.bind(instance);
    instance.prepare = (statement: string, ...rest: unknown[]) => { pageSql.push(statement); return prepare(statement, ...rest); };
    return { engine, pageSql };
}

type Mode = 'off' | 'wrapped' | 'direct';

/** Fetch one page in every mode; returns the reference page and which SQL each mode ran. */
async function fetchAllModes(engine: WasmDatabaseEngine, pageSql: string[], table: string, options: TableQueryOptions) {
    const pages = {} as Record<Mode, QueryResultSet>;
    const used = {} as Record<Mode, 'helpers' | 'wrapped' | 'direct'>;
    for (const mode of ['off', 'wrapped', 'direct'] as const) {
        engine.gridRowPackTransport = mode;
        pageSql.length = 0;
        pages[mode] = await engine.fetchTableData(table, structuredClone(options));
        const page = pageSql.filter(sql => sql.includes(PACK) && !sql.startsWith('EXPLAIN QUERY PLAN'));
        used[mode] = page.length === 0 ? 'helpers' : page.every(sql => sql.includes(WRAPPED)) ? 'wrapped' : 'direct';
    }
    engine.gridRowPackTransport = 'off';
    return { pages, used };
}

function assertSamePages(pages: Record<Mode, QueryResultSet>, label: string) {
    assert.deepStrictEqual(pages.wrapped, pages.off, `${label}: wrapped`);
    assert.deepStrictEqual(pages.direct, pages.off, `${label}: direct`);
}

// First in this file, while the process's heap is still small: each row of
// the view allocates more than the last, so memory grows between steps of
// one packed page.
describe('row-packed WASM pages and heap growth', () => {
    it('decode a page whose steps grow WASM memory', async () => {
        const step = 8 * 1024 * 1024;
        const { engine, pageSql } = await openEngine(`${ROWID_FIXTURE_SQL};\n` +
            `CREATE VIEW grow AS SELECT id, label, octet_length(zeroblob(id * ${step}) || x'00') AS n FROM t WHERE id <= 6`);
        const module = (engine as any).packHeap().module;
        const columnBlob = module._sqlite3_column_blob;
        try {
            assert.ok(module.HEAPU8.byteLength < 6 * step, `the heap already holds ${module.HEAPU8.byteLength} bytes`);
            const buffers = new Set<ArrayBufferLike>();
            module._sqlite3_column_blob = (statement: number, column: number) => {
                buffers.add(module.HEAPU8.buffer);
                return columnBlob(statement, column);
            };
            const options: TableQueryOptions = { columns: ['id', 'label', 'n'], limit: 6, offset: 0, maxInlineCellBytes: 300 };
            engine.gridRowPackTransport = 'wrapped';
            pageSql.length = 0;
            const packed = await engine.fetchTableData('grow', structuredClone(options));
            assert.ok(pageSql.some(sql => sql.includes(WRAPPED)), 'the page was not packed');
            assert.ok(buffers.size >= 2, `memory did not grow during the page (${buffers.size} heap buffer)`);
            module._sqlite3_column_blob = columnBlob;
            engine.gridRowPackTransport = 'off';
            const helpers = await engine.fetchTableData('grow', structuredClone(options));
            assert.deepStrictEqual(packed, helpers);
            assert.deepEqual(packed.rows.map(row => Number(row[2])), [1, 2, 3, 4, 5, 6].map(id => id * step + 1));
        } finally {
            module._sqlite3_column_blob = columnBlob;
            engine.shutdown();
        }
    });
});

describe('row-packed grid pages on WASM', () => {
    for (const [label, table, options] of PAGES) {
        it(`match the helper path for ${label}`, async () => {
            const { engine, pageSql } = await openEngine(FIXTURE_SQL);
            try {
                const { pages, used } = await fetchAllModes(engine, pageSql, table, options);
                assert.equal(used.off, 'helpers');
                assert.equal(used.wrapped, 'wrapped');
                // A TEXT sort needs a sorter, so the direct mode wraps instead.
                assert.equal(used.direct, options.orderBy ? 'wrapped' : 'direct', label);
                assert.ok(pages.off.rows.length > 0);
                assertSamePages(pages, label);
            } finally {
                engine.shutdown();
            }
        });
    }

    for (const width of [10, 98, 99, 148]) {
        it(`match the helper path for generated cells across ${width + 2} value columns`, async () => {
            const distinctRows = new Set<string>();
            const usedLiterals = new Set<number>();
            const rows = 60;
            const { engine, pageSql } = await openEngine(
                `${generatedTableSql('f', width, rows, 0x9ac0 + width, distinctRows, usedLiterals)};\nCREATE INDEX f_c0 ON f (c0)`);
            try {
                assert.equal(distinctRows.size, rows, 'generated rows repeat');
                if (width >= 98) assert.equal(usedLiterals.size, CELL_LITERALS.length, 'a literal was never generated');
                const columns = ['rowid', 'id', ...Array.from({ length: width }, (_, index) => `c${index}`)];
                const base: TableQueryOptions = { columns, limit: 25, offset: 0, maxInlineCellBytes: WINDOW };
                let compared = 0;
                const check = async (label: string, options: TableQueryOptions, expectDirect: boolean) => {
                    const { pages, used } = await fetchAllModes(engine, pageSql, 'f', options);
                    assert.equal(used.off, 'helpers', label);
                    assert.equal(used.wrapped, 'wrapped', label);
                    assert.equal(used.direct, expectDirect ? 'direct' : 'wrapped', label);
                    assertSamePages(pages, `${width}: ${label}`);
                    compared++;
                    return pages.off;
                };
                await check('first page', base, true);
                await check('second page', { ...base, offset: 25 }, true);
                const first = await check('keyset first', { ...base, keyset: { mode: 'first' } }, true);
                assert.ok(first.keysetAnchors?.last, 'first page minted no anchor');
                const second = await check('keyset after', { ...base, keyset: { mode: 'after', anchor: first.keysetAnchors!.last } }, true);
                await check('keyset atOrAfter', { ...base, keyset: { mode: 'atOrAfter', anchor: first.keysetAnchors!.last } }, true);
                if (second.keysetAnchors?.first) {
                    await check('keyset before', { ...base, keyset: { mode: 'before', anchor: second.keysetAnchors.first } }, false);
                }
                await check('keyset last', { ...base, keyset: { mode: 'last', lastPageRowCount: 10 } }, false);
                await check('sorted by an untyped column', { ...base, orderBy: 'c1', orderDir: 'DESC' }, false);
                // The index already orders c0 with its rowid tiebreak, so neither needs a sorter.
                await check('sorted by an indexed column', { ...base, orderBy: 'c0' }, true);
                await check('sorted by an indexed column, descending', { ...base, orderBy: 'c0', orderDir: 'DESC' }, true);
                await check('a global filter', { ...base, globalFilter: 'a', globalFilterColumns: columns.slice(2) }, true);
                await check('an exhausted page budget', { ...base, maxPageResponseBytes: 4000 }, true);
                await check('a view', { columns: columns.slice(2, 2 + Math.min(width, 120)), limit: 25, offset: 5, maxInlineCellBytes: WINDOW }, true);
                assert.equal(compared, second.keysetAnchors?.first ? 13 : 12);
            } finally {
                engine.shutdown();
            }
        });
    }

    // 999 value columns: every raw-TEXT slot, no REAL sidecar (rowid
    // companions instead). 1000: identity-only raw slots with the sidecar.
    // 1990: identity-only raw slots, no sidecar.
    for (const width of [997, 998, 1988]) {
        it(`match the helper path at the width ceiling, ${width + 2} value columns`, async () => {
            const { engine, pageSql } = await openEngine(generatedTableSql('f', width, 6, 0x7a11 + width, new Set(), new Set()));
            try {
                const columns = ['rowid', 'id', ...Array.from({ length: width }, (_, index) => `c${index}`)];
                const base: TableQueryOptions = { columns, limit: 5, offset: 0, maxInlineCellBytes: WINDOW };
                const shapes: string[] = [];
                const check = async (label: string, options: TableQueryOptions, expectDirect: boolean) => {
                    const { pages, used } = await fetchAllModes(engine, pageSql, 'f', options);
                    assert.deepEqual(used, { off: 'helpers', wrapped: 'wrapped', direct: expectDirect ? 'direct' : 'wrapped' }, label);
                    assertSamePages(pages, `${width}: ${label}`);
                    return pages.off;
                };
                const helperSql = () => {
                    engine.gridRowPackTransport = 'off';
                    pageSql.length = 0;
                    return engine.fetchTableData('f', structuredClone(base)).then(() => pageSql.find(sql => sql.includes('sqlite_explorer_cell_preview('))!);
                };
                const sql = await helperSql();
                shapes.push(sql.includes('sqlite_explorer_real_texts(') ? 'sidecar' : 'no sidecar');
                shapes.push(sql.split('sqlite_explorer_cell_text_check(').length - 1 === width + 2 ? 'all raw slots' : 'identity raw slots');
                assert.deepEqual(shapes, width === 997 ? ['no sidecar', 'all raw slots']
                    : width === 998 ? ['sidecar', 'identity raw slots'] : ['no sidecar', 'identity raw slots']);
                const first = await check('keyset first', { ...base, keyset: { mode: 'first' } }, true);
                await check('keyset after', { ...base, keyset: { mode: 'after', anchor: first.keysetAnchors!.last } }, true);
                await check('second page', { ...base, offset: 5 }, true);
                await check('sorted', { ...base, orderBy: 'c2' }, false);
            } finally {
                engine.shutdown();
            }
        });
    }

    it('rebuild the exact checked transport rows, wrapped and direct', async () => {
        for (const width of [10, 98, 99, 148]) {
            const { engine } = await openEngine(generatedTableSql('f', width, 60, 0x51de + width, new Set(), new Set()));
            const instance = (engine as any).instance;
            const rowsOf = (sql: string) => {
                const statement = instance.prepare(sql);
                const rows: unknown[][] = [];
                try {
                    while (statement.step()) rows.push(statement.get(null, { useBigInt: true }));
                } finally {
                    statement.free();
                }
                return rows;
            };
            try {
                const columns = ['rowid', 'id', ...Array.from({ length: width }, (_, index) => `c${index}`)];
                const options: TableQueryOptions = { columns, orderByColumns: ['rowid'], limit: 60, offset: 0, maxInlineCellBytes: WINDOW };
                const { sql } = buildSelectQuery('f', options);
                const query = buildCellContainmentQuery(sql, columns.length, options, columns.map((_, index) => index),
                    'checked', true, true);
                const expected = mergeCellContainmentMetadataRows(rowsOf(query.numericTransport.sql), undefined, query);
                assert.equal(expected.length, 60);
                const direct = buildSelectQuery('f', options, undefined, expressions => buildCellPackSelectList(expressions, query)).sql;
                assert.ok(!direct.includes('WITH'), direct.slice(0, 80));
                assert.deepStrictEqual(decodeCellPackRows(rowsOf(buildCellPackWrappedQuery(sql, query, true)), query), expected);
                assert.deepStrictEqual(decodeCellPackRows(rowsOf(direct), query), expected);
            } finally {
                engine.shutdown();
            }
        }
    });

    it('read packed rows in place: no sql.js BLOB copy per row, raw TEXT in slabs', async () => {
        const rows = 1000;
        const { engine, pageSql } = await openEngine(
            'CREATE TABLE entries(id INTEGER PRIMARY KEY, a TEXT, b TEXT, c BLOB);'
            + `WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id + 1 FROM n WHERE id < ${rows})`
            + " INSERT INTO entries SELECT id, 'a-' || id, CAST(x'ff' || randomblob(40) AS TEXT), x'0102' FROM n");
        const instance = (engine as any).instance;
        const prepare = instance.prepare;
        let blobCopies = 0;
        instance.prepare = (...args: unknown[]) => {
            const statement = prepare(...args);
            const getBlob = statement.getBlob;
            statement.getBlob = (...rest: unknown[]) => { blobCopies++; return getBlob.apply(statement, rest); };
            return statement;
        };
        try {
            for (const mode of ['wrapped', 'direct'] as const) {
                engine.gridRowPackTransport = mode;
                blobCopies = 0;
                pageSql.length = 0;
                const page = await engine.fetchTableData('entries', { columns: ['rowid', 'id', 'a', 'b', 'c'], limit: rows, offset: 0 });
                assert.ok(pageSql.some(sql => sql.includes(PACK) && !sql.startsWith('EXPLAIN')), `${mode} did not pack`);
                assert.equal(page.rows.length, rows);
                assert.deepEqual(page.rows[0].slice(0, 3), [1, 1, 'a-1']);
                assert.equal(blobCopies, 0, `${mode} copied a sql.js BLOB`);
            }
            // Raw bytes of non-plain TEXT share 64 KiB slabs.
            const values = Array.from({ length: 40 }, (_, index) => `CAST(x'ff${'61'.repeat(index)}' AS TEXT) AS v${index}`);
            const source = `SELECT ${values.join(', ')} LIMIT 1 OFFSET 0`;
            const query = buildCellContainmentQuery(source, values.length, { limit: 1, maxInlineCellBytes: 100 },
                values.map((_, index) => index), 'checked', true, true);
            const statement = prepare(buildCellPackWrappedQuery(source, query, true));
            assert.ok(statement.step());
            const packed: Uint8Array = statement.get(null, { useBigInt: true })[0];
            statement.free();
            const decoded = decodeCellPackRows(Array.from({ length: 200 }, () => [packed]), query);
            const raw = decoded.flatMap(row => row.slice(values.length + 1, values.length + 1 + values.length));
            assert.ok(raw.every(slot => slot instanceof Uint8Array && slot[0] === 0xff));
            const buffers = new Set(raw.map(slot => (slot as Uint8Array).buffer));
            const bytes = raw.reduce<number>((sum, slot) => sum + (slot as Uint8Array).byteLength, 0);
            assert.ok(buffers.size <= Math.ceil(bytes / (64 * 1024)) + 1, `${buffers.size} buffers for ${bytes} bytes`);
        } finally {
            engine.gridRowPackTransport = 'off';
            engine.shutdown();
        }
    });

    it('refresh the heap view when a step grows WASM memory', async () => {
        const { engine } = await openEngine('CREATE TABLE x (a)');
        try {
            const values = ['7', "'plain'", "CAST(x'ff' AS TEXT)", "x'0102'"];
            const source = `SELECT ${values.map((value, index) => `${value} AS v${index}`).join(', ')} LIMIT 1 OFFSET 0`;
            const query = buildCellContainmentQuery(source, values.length, { limit: 1, maxInlineCellBytes: 64 },
                values.map((_, index) => index), 'checked', true, true);
            const statement = (engine as any).instance.prepare(buildCellPackWrappedQuery(source, query, true));
            assert.ok(statement.step());
            const packed: Uint8Array = statement.get(null, { useBigInt: true })[0];
            statement.free();
            // A stand-in heap whose every step replaces the buffer, as memory.grow() does,
            // and detaches the old one so a stale view reads nothing. The glue then
            // exports a view of the new buffer.
            let buffer = new ArrayBuffer(4096);
            let heap = new Uint8Array(buffer);
            let steps = 0;
            const pointer = 1024;
            const fakeStatement = {
                sqliteExplorerPointer: () => 1,
                step() {
                    if (steps++ === 3) return false;
                    const grown = new ArrayBuffer(buffer.byteLength + 65536);
                    new Uint8Array(grown).set(packed, pointer + steps * 8);
                    structuredClone(buffer, { transfer: [buffer] });
                    buffer = grown;
                    heap = new Uint8Array(grown);
                    return true;
                }
            };
            const module = {
                get HEAPU8() { return heap; },
                _sqlite3_sql: () => 0,
                UTF8ToString: () => 'packed page',
                _sqlite3_column_count: () => 1,
                _sqlite3_column_type: () => 4,
                _sqlite3_column_blob: () => pointer + steps * 8,
                _sqlite3_column_bytes: () => packed.byteLength
            };
            const rows = (engine as any).readPackedRows(fakeStatement, 'packed page', { module }, query);
            assert.equal(rows.length, 3);
            const expected = decodeCellPackRows([[packed]], query)[0];
            for (const row of rows) assert.deepStrictEqual(row, expected);
        } finally {
            engine.shutdown();
        }
    });

    it('route view pages by their plan: direct without a sorter, wrapped with one', async () => {
        const { engine, pageSql } = await openEngine([
            FIXTURE_SQL,
            'CREATE VIEW v_union AS SELECT label, t FROM t WHERE id <= 20 UNION ALL SELECT label, t FROM t WHERE id > 20',
            'CREATE VIEW v_window AS SELECT label, t, row_number() OVER (ORDER BY label) AS n FROM t',
            'CREATE VIEW v_distinct AS SELECT DISTINCT label, t FROM t'
        ].join(';\n'));
        try {
            const shapes: Array<[string, string, TableQueryOptions, Mode]> = [
                ['a UNION ALL view, offset across its branches', 'v_union',
                    { columns: ['label', 't'], limit: 10, offset: 15, maxInlineCellBytes: 300 }, 'direct'],
                ['a UNION ALL view sorted by a column', 'v_union',
                    { columns: ['label', 't'], orderBy: 'label', limit: 10, offset: 15, maxInlineCellBytes: 300 }, 'wrapped'],
                // The window's sort is a temp B-tree inside the view; any sorter wraps.
                ['a window function view', 'v_window',
                    { columns: ['label', 't', 'n'], limit: 10, offset: 5, maxInlineCellBytes: 300 }, 'wrapped'],
                ['a DISTINCT view', 'v_distinct',
                    { columns: ['label', 't'], limit: 10, offset: 5, maxInlineCellBytes: 300 }, 'wrapped']
            ];
            for (const [label, view, options, direct] of shapes) {
                const { pages, used } = await fetchAllModes(engine, pageSql, view, options);
                // Direct mode reads the EXPLAIN QUERY PLAN wording, which SQLite
                // may change; an upgrade that changes it fails here.
                assert.deepEqual(used, { off: 'helpers', wrapped: 'wrapped', direct }, label);
                assert.equal(pages.off.rows.length, 10, label);
                assertSamePages(pages, label);
            }
        } finally {
            engine.shutdown();
        }
    });

    it('fall back to the helpers for a UTF-16 database', async () => {
        const { engine, pageSql } = await openEngine(`PRAGMA encoding = 'UTF-16le';\n${ROWID_FIXTURE_SQL}`);
        try {
            const [, table, options] = PAGES[0];
            const { pages, used } = await fetchAllModes(engine, pageSql, table, options);
            assert.deepEqual(used, { off: 'helpers', wrapped: 'helpers', direct: 'helpers' });
            assertSamePages(pages, 'UTF-16');
        } finally {
            engine.shutdown();
        }
    });

    it('cannot be called from schema code', async () => {
        const { engine } = await openEngine('CREATE TABLE x (a)');
        try {
            await engine.executeQuery('CREATE VIEW pack_view AS SELECT sqlite_explorer_cell_pack(1, 1, 2) AS value');
            await assert.rejects(engine.executeQuery('SELECT * FROM pack_view'), /unsafe use of sqlite_explorer_cell_pack/);
            await assert.rejects(engine.executeQuery('SELECT sqlite_explorer_cell_pack(1, 1)'), /1 to 100 values/);
            await assert.rejects(engine.executeQuery('SELECT sqlite_explorer_cell_pack(-1, 1, 2)'), /limits must be integers/);
        } finally {
            engine.shutdown();
        }
    });

    it('reject malformed packed rows', async () => {
        const { engine } = await openEngine('CREATE TABLE x (a)');
        try {
            const values = ['NULL', '7', '0.5', "'plain'", "CAST(x'ff' AS TEXT)", `'${'a'.repeat(10)}'`, "x'0102'", `zeroblob(9)`, "'é'"];
            const source = `SELECT ${values.map((value, index) => `${value} AS v${index}`).join(', ')} LIMIT 1 OFFSET 0`;
            const query = buildCellContainmentQuery(source, values.length, { limit: 1, maxInlineCellBytes: 4 },
                values.map((_, index) => index), 'checked', true, true);
            assert.equal(query.effectiveInlineCellBytes, 4);
            const instance = (engine as any).instance;
            const statement = instance.prepare(buildCellPackWrappedQuery(source, query, true));
            assert.ok(statement.step());
            const packed: Uint8Array = statement.get(null, { useBigInt: true })[0];
            statement.free();
            const decoded = decodeCellPackRows([[packed]], query);
            assert.deepStrictEqual(decoded[0], [
                null, 7n, 0.5, 'p', '\ufffd', 'a', new Uint8Array([1, 2]), new Uint8Array(4), 'é',
                '|||t5||t10||b9|', null, null, null, 0n, new Uint8Array([0xff]), 0n, null, null, null, '2:0.5'
            ]);
            const corrupt = (edit: (bytes: Uint8Array) => Uint8Array) => () => decodeCellPackRows([[edit(packed.slice())]], query);
            const tagAt = (tag: number) => {
                let offset = 6;
                for (;;) {
                    if (packed[offset] === tag) return offset;
                    offset++;
                }
            };
            for (const [label, edit] of [
                ['a wrong version', (bytes: Uint8Array) => { bytes[0] = 2; return bytes; }],
                ['a wrong cell count', (bytes: Uint8Array) => { bytes[1] = 8; return bytes; }],
                ['a truncated row', (bytes: Uint8Array) => bytes.subarray(0, 20)],
                ['trailing bytes', (bytes: Uint8Array) => Uint8Array.from([...bytes, 0x61])],
                ['an unknown tag', (bytes: Uint8Array) => { bytes[6] = 9; return bytes; }],
                ['a text area offset past the end', (bytes: Uint8Array) => { bytes[2] = 0xff; bytes[3] = 0xff; return bytes; }],
                ['a short BLOB preview', (bytes: Uint8Array) => { bytes[tagAt(8) + 5] = 3; return bytes; }],
                ['invalid UTF-8 in the text area', (bytes: Uint8Array) => { bytes[bytes.length - 1] = 0xff; return bytes; }],
                ['NUL in the text area', (bytes: Uint8Array) => { bytes[bytes.length - 3] = 0; return bytes; }]
            ] as const) {
                assert.throws(corrupt(edit), /malformed/, label);
            }
            // Two plain cells, 'a' and '😀', with the boundary moved into the surrogate pair.
            const pair = buildCellContainmentQuery('SELECT 1, 2 LIMIT 1 OFFSET 0', 2, { limit: 1, maxInlineCellBytes: 8 },
                [0, 1], 'checked', true, true);
            const split = Uint8Array.from([1, 2, 24, 0, 0, 0, 3, 2, 0, 0, 0, 2, 0, 0, 0, 3, 1, 0, 0, 0, 3, 0, 0, 0,
                0x61, 0xf0, 0x9f, 0x98, 0x80]);
            assert.deepStrictEqual(decodeCellPackRows([[Uint8Array.from([1, 2, 24, 0, 0, 0, 3, 1, 0, 0, 0, 1, 0, 0, 0,
                3, 2, 0, 0, 0, 4, 0, 0, 0, 0x61, 0xf0, 0x9f, 0x98, 0x80])]], pair)[0].slice(0, 2), ['a', '😀']);
            assert.throws(() => decodeCellPackRows([[split]], pair), /splits a character/);
            assert.throws(() => decodeCellPackRows([[packed, packed]], query), /expected 1/);
            assert.throws(() => decodeCellPackRows([['text']], query), /not a BLOB/);
        } finally {
            engine.shutdown();
        }
    });
});

// Native pages are packed in the worker and decoded on the host. The txiki
// binding decodes non-plain TEXT unlike sql.js, so pages holding it are read
// again through queryNumeric.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const isPlainHex = (hex: string) => {
    if (hex.startsWith('efbbbf')) return false;
    try {
        return !/[\0\uFFFE\uFFFF]/.test(strictUtf8.decode(Buffer.from(hex, 'hex')));
    } catch {
        return false;
    }
};
const PLAIN_LITERALS = CELL_LITERALS.filter(literal => {
    const text = /^CAST\(x'([0-9a-f]*)' AS TEXT\)$/.exec(literal);
    return !text || isPlainHex(text[1]);
});

function bundledNativeBinary(): string | undefined {
    const platformDir = process.platform === 'darwin'
        ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos')
        : process.platform === 'linux'
            ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu')
            : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-windows' : undefined;
    // The five-target CI workflow names the runtime each runner must use.
    const expected = process.env.FUZZ_EXPECT_TARGET;
    if (expected && expected !== platformDir) {
        throw new Error(`Expected native target ${expected}, resolved ${platformDir ?? 'none'}`);
    }
    if (!platformDir) return undefined;
    const binary = path.join('natives', platformDir, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
    if (expected && !fs.existsSync(binary)) throw new Error(`Missing native runtime ${binary}`);
    return fs.existsSync(binary) ? binary : undefined;
}

const nativeCalls: string[] = [];
let nativeCellPackReported = true;
const originalNativeCall = NativeWorkerProcess.prototype.call;
(NativeWorkerProcess.prototype as any).call = async function (method: string, ...rest: unknown[]) {
    nativeCalls.push(method);
    const result = await (originalNativeCall as any).call(this, method, ...rest);
    return method === 'prepareGridPage' && !nativeCellPackReported ? { ...result, cellPack: false } : result;
};
after(() => { NativeWorkerProcess.prototype.call = originalNativeCall; });

async function openNative(sql: string) {
    const seed = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    await seed.executeQuery(sql);
    const image = await seed.serializeDatabase();
    seed.shutdown();
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/grid-cell-pack-'));
    const file = path.join(directory, 'fixture.db');
    fs.writeFileSync(file, image);
    const logs: string[] = [];
    const outputChannel = { appendLine: (line: string) => { logs.push(line); } } as unknown as vscode.OutputChannel;
    const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()), undefined, outputChannel);
    const connection = await native.establishConnection(vscode.Uri.file(file), 'grid-cell-pack', false);
    return {
        ops: connection.databaseOps,
        logs,
        dispose: () => {
            native.workerMethods[Symbol.dispose]();
            // Windows can hold the file briefly after the worker exits.
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    };
}

type NativeRead = 'queryNumeric' | 'packed' | 'packed, then queryNumeric';

async function fetchNativeBoth(ops: Awaited<ReturnType<typeof openNative>>['ops'], table: string, options: TableQueryOptions) {
    const pages = {} as Record<'off' | 'packed', QueryResultSet>;
    const reads = {} as Record<'off' | 'packed', NativeRead>;
    try {
        for (const enabled of [false, true]) {
            nativeGridRowPack.enabled = enabled;
            nativeCalls.length = 0;
            const key = enabled ? 'packed' : 'off';
            pages[key] = await ops.fetchTableData!(table, structuredClone(options));
            const packed = nativeCalls.includes('queryPacked');
            const numeric = nativeCalls.includes('queryNumeric');
            reads[key] = packed ? (numeric ? 'packed, then queryNumeric' : 'packed') : 'queryNumeric';
        }
    } finally {
        nativeGridRowPack.enabled = true;
    }
    return { pages, reads };
}

describe('row-packed grid pages on the native engine', () => {
    for (const [label, table, options] of PAGES) {
        it(`match queryNumeric for ${label}`, async (context) => {
            if (!bundledNativeBinary()) return context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
            const backend = await openNative(FIXTURE_SQL);
            try {
                const { pages, reads } = await fetchNativeBoth(backend.ops, table, options);
                assert.equal(reads.off, 'queryNumeric', label);
                assert.notEqual(reads.packed, 'queryNumeric', label);
                assert.ok(pages.off.rows.length > 0);
                assert.deepStrictEqual(pages.packed, pages.off, label);
            } finally {
                backend.dispose();
            }
        });
    }

    for (const [kind, literals] of [['every literal', CELL_LITERALS], ['plain literals', PLAIN_LITERALS]] as const) {
        for (const width of [10, 98, 99, 148]) {
            it(`match queryNumeric for generated cells of ${kind} across ${width + 2} value columns`, async (context) => {
                if (!bundledNativeBinary()) return context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
                const backend = await openNative(
                    `${generatedTableSql('f', width, 60, 0x4e7 + width, new Set(), new Set(), literals)};\nCREATE INDEX f_c0 ON f (c0)`);
                try {
                    const columns = ['rowid', 'id', ...Array.from({ length: width }, (_, index) => `c${index}`)];
                    const base: TableQueryOptions = { columns, limit: 25, offset: 0, maxInlineCellBytes: WINDOW };
                    const check = async (label: string, options: TableQueryOptions, table = 'f') => {
                        const { pages, reads } = await fetchNativeBoth(backend.ops, table, options);
                        assert.equal(reads.off, 'queryNumeric', label);
                        // Plain cells decode on the host; any other TEXT reads the page again.
                        assert.equal(reads.packed, kind === 'plain literals' ? 'packed' : 'packed, then queryNumeric', label);
                        assert.deepStrictEqual(pages.packed, pages.off, `${width}, ${kind}: ${label}`);
                        return pages.off;
                    };
                    const first = await check('keyset first', { ...base, keyset: { mode: 'first' } });
                    const second = await check('keyset after', { ...base, keyset: { mode: 'after', anchor: first.keysetAnchors!.last } });
                    await check('keyset atOrAfter', { ...base, keyset: { mode: 'atOrAfter', anchor: first.keysetAnchors!.last } });
                    if (second.keysetAnchors?.first) {
                        await check('keyset before', { ...base, keyset: { mode: 'before', anchor: second.keysetAnchors.first } });
                    }
                    await check('keyset last', { ...base, keyset: { mode: 'last', lastPageRowCount: 10 } });
                    await check('second page', { ...base, offset: 25 });
                    await check('sorted by an untyped column', { ...base, orderBy: 'c1', orderDir: 'DESC' });
                    await check('sorted by an indexed column', { ...base, orderBy: 'c0' });
                    await check('a global filter', { ...base, globalFilter: 'a', globalFilterColumns: columns.slice(2) });
                    await check('an exhausted page budget', { ...base, maxPageResponseBytes: 4000 });
                    await check('a view', { columns: columns.slice(2, 2 + Math.min(width, 120)), limit: 25, offset: 5,
                        maxInlineCellBytes: WINDOW }, 'f_v');
                } finally {
                    backend.dispose();
                }
            });
        }
    }

    it('read a page through queryNumeric when its packed rows would near the response cap', async (context) => {
        if (!bundledNativeBinary()) return context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
        // 7.5 million empty strings: about 15 MB through queryNumeric, about
        // 68 MB packed, past the 64 MiB response cap that retires the worker.
        const width = 1500;
        const columns = Array.from({ length: width }, (_, index) => `c${index}`);
        const backend = await openNative([
            `CREATE TABLE w (${columns.join(', ')})`,
            `INSERT INTO w SELECT ${columns.map(() => "''").join(', ')} FROM ` +
                '(WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 5000) SELECT n FROM s)'
        ].join(';\n'));
        try {
            nativeCalls.length = 0;
            const page = await backend.ops.fetchTableData!('w', { columns: ['rowid', ...columns], limit: 5000, offset: 0 });
            assert.ok(nativeCalls.includes('queryPacked') && nativeCalls.includes('queryNumeric'), nativeCalls.join(', '));
            assert.equal(page.rows.length, 5000);
            assert.deepStrictEqual(page.rows[4999], [5000, ...columns.map(() => '')]);
            assert.ok(backend.logs.some(line => line.includes('packs to more than')), backend.logs.join('\n'));
            // The connection outlives the page.
            assert.deepStrictEqual((await backend.ops.executeQuery('SELECT count(*) FROM w'))[0].rows, [[5000]]);
        } finally {
            backend.dispose();
        }
    });

    it('keep queryNumeric when the runtime library has no pack function', async (context) => {
        if (!bundledNativeBinary()) return context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
        const backend = await openNative(FIXTURE_SQL);
        nativeCellPackReported = false;
        try {
            nativeCalls.length = 0;
            const [, table, options] = PAGES[0];
            const page = await backend.ops.fetchTableData!(table, structuredClone(options));
            assert.ok(page.rows.length > 0);
            assert.ok(nativeCalls.includes('queryNumeric') && !nativeCalls.includes('queryPacked'), nativeCalls.join(', '));
        } finally {
            nativeCellPackReported = true;
            backend.dispose();
        }
    });
});
