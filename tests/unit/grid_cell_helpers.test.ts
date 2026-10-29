import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, NativeWorkerProcess } from '../../src/nativeWorker';
import type { DatabaseOperations, TableQueryOptions } from '../../src/core/types';

// The runtime's grid cell helpers (src/runtime/query-plan.c) replace per-cell
// SQL in the grid page. These tests hold them to the SQL they replace: the C
// functions directly on sql.js, and whole pages on both real engines with the
// helpers on and off.

const HELPER_NAME = 'sqlite_explorer_cell_preview';

// TEXT byte patterns the helpers must classify: NUL, BOMs, encoded surrogates,
// overlong and truncated sequences, code points past U+10FFFF, lone and
// invalid bytes, noncharacters, 4-byte characters, and multibyte text across
// the clip boundary.
const TEXT_BYTES = [
    '', '41', '00', '410042', 'efbbbf41', '41efbbbf', 'eda080', 'c080', 'e08280', 'f4908080',
    'e4b8', '80', 'ff', 'efbfbe', 'efbfbf', 'f09f9880', 'c3a9', 'c3a9'.repeat(200),
    'f09f9880'.repeat(100), '61'.repeat(301), '0000000000', 'c3a9'.repeat(149) + 'f09f9880',
    '8080' + '61'.repeat(400), 'c3' + '80'.repeat(400), '61'.repeat(100) + '00' + '62'.repeat(300)
];

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
// UTF-16 conversion merges some malformed keys, so this table is UTF-8 only.
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

async function buildImage(sql: string, encoding?: string): Promise<Uint8Array> {
    const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    const engine = opened.operations as WasmDatabaseEngine;
    try {
        if (encoding) await engine.executeQuery(`PRAGMA encoding = '${encoding}'`);
        await engine.executeQuery(sql);
        return await engine.serializeDatabase();
    } finally {
        engine.shutdown();
    }
}

interface PageBackend {
    ops: DatabaseOperations;
    setHelpers(enabled: boolean): void;
    pageSql: string[];
    dispose(): void;
}

async function openWasm(image: Uint8Array): Promise<PageBackend> {
    const opened = await createDatabaseEngine({ content: image, maxSize: 0, readOnlyMode: false });
    const engine = opened.operations as WasmDatabaseEngine;
    const pageSql: string[] = [];
    const instance = (engine as any).instance;
    const prepare = instance.prepare.bind(instance);
    instance.prepare = (sql: string, ...rest: unknown[]) => { pageSql.push(sql); return prepare(sql, ...rest); };
    return {
        ops: engine,
        setHelpers: enabled => { (engine as any).hasCellHelpers = enabled; },
        pageSql,
        dispose: () => engine.shutdown()
    };
}

const originalCall = NativeWorkerProcess.prototype.call;
let nativeHelpersEnabled = true;
const nativePageSql: string[] = [];
(NativeWorkerProcess.prototype as any).call = async function (method: string, args: unknown[] = [], ...rest: unknown[]) {
    if (method === 'queryNumeric') nativePageSql.push(String(args[0]));
    const result = await (originalCall as any).call(this, method, args, ...rest);
    return method === 'prepareGridPage' && !nativeHelpersEnabled ? { ...result, cellHelpers: false } : result;
};
after(() => { NativeWorkerProcess.prototype.call = originalCall; });

function bundledNativeBinary(): string | undefined {
    const platformDir = process.platform === 'darwin'
        ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos')
        : process.platform === 'linux'
            ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu')
            : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-windows' : undefined;
    if (!platformDir) return undefined;
    const binary = path.join('natives', platformDir, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
    return fs.existsSync(binary) ? binary : undefined;
}

async function openNative(image: Uint8Array): Promise<PageBackend> {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/grid-cell-helpers-'));
    const file = path.join(directory, 'fixture.db');
    fs.writeFileSync(file, image);
    const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
    const connection = await native.establishConnection(vscode.Uri.file(file), 'grid-cell-helpers', false);
    nativePageSql.length = 0;
    return {
        ops: connection.databaseOps,
        setHelpers: enabled => { nativeHelpersEnabled = enabled; },
        pageSql: nativePageSql,
        dispose: () => {
            nativeHelpersEnabled = true;
            native.workerMethods[Symbol.dispose]();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    };
}

async function fetchBoth(backend: PageBackend, table: string, options: TableQueryOptions) {
    backend.setHelpers(false);
    backend.pageSql.length = 0;
    const sqlPage = await backend.ops.fetchTableData!(table, options);
    const sqlUsedHelpers = backend.pageSql.some(sql => sql.includes(HELPER_NAME));
    backend.setHelpers(true);
    backend.pageSql.length = 0;
    const helperPage = await backend.ops.fetchTableData!(table, options);
    const helperUsedHelpers = backend.pageSql.some(sql => sql.includes(HELPER_NAME));
    return { sqlPage, helperPage, sqlUsedHelpers, helperUsedHelpers };
}

describe('grid cell helpers on sql.js', () => {
    it('match the SQL previews, metadata and a strict UTF-8 check for generated values', async () => {
        const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
        const engine = opened.operations as WasmDatabaseEngine;
        const instance = (engine as any).instance;
        const one = (sql: string, params: unknown[]) => {
            const statement = instance.prepare(sql, params);
            try {
                assert.ok(statement.step());
                return statement.get();
            } finally {
                statement.free();
            }
        };
        const fragments = [[0x41], [0x00], [0xc3, 0xa9], [0xe2, 0x82, 0xac], [0xf0, 0x9f, 0x98, 0x80],
            [0xef, 0xbb, 0xbf], [0xed, 0xa0, 0x80], [0xc0, 0x80], [0xe0, 0x82, 0x80], [0xf4, 0x90, 0x80, 0x80],
            [0xef, 0xbf, 0xbe], [0xef, 0xbf, 0xbf], [0xe4, 0xb8], [0x80], [0xff], [0x7f], [0x0a]];
        const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        const plainUtf8 = (bytes: Uint8Array) => {
            if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return false;
            try {
                const text = strict.decode(bytes);
                return !/[\0￾￿]/.test(text);
            } catch {
                return false;
            }
        };
        let seed = 0x5eed;
        const next = (bound: number) => {
            seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
            return seed % bound;
        };
        const distinct = new Set<string>();
        try {
            for (let round = 0; round < 3000; round++) {
                const bytes = Uint8Array.from(Array.from({ length: next(8) }, () => fragments[next(fragments.length)]).flat());
                const limit = next(14);
                const characters = next(5);
                distinct.add(`${Buffer.from(bytes).toString('hex')}:${limit}:${characters}`);
                const [sqlText, helperText, helperType] = one(
                    "SELECT CASE WHEN octet_length(t) > ?2 THEN hex(substr(t, 1, ?3)) ELSE hex(t) END, " +
                    'hex(sqlite_explorer_cell_preview(t, ?2, ?3)), typeof(sqlite_explorer_cell_preview(t, ?2, ?3)) ' +
                    'FROM (SELECT CAST(?1 AS TEXT) AS t)', [bytes, limit, characters]);
                assert.equal(helperText, sqlText, `TEXT preview of ${Buffer.from(bytes).toString('hex')}`);
                assert.equal(helperType, 'text');
                const [sqlBlob, helperBlob] = one(
                    'SELECT CASE WHEN octet_length(?1) > ?2 THEN hex(substr(?1, 1, ?2)) ELSE hex(?1) END, ' +
                    'hex(sqlite_explorer_cell_preview(?1, ?2, ?3))', [bytes, limit, characters]);
                assert.equal(helperBlob, sqlBlob);
                const [check] = one('SELECT sqlite_explorer_cell_text_check(CAST(?1 AS TEXT), ?2)', [bytes, limit]);
                const expected = bytes.length > limit ? 0 : plainUtf8(bytes) ? null : bytes;
                assert.deepEqual(check, expected, `TEXT check of ${Buffer.from(bytes).toString('hex')}`);
            }
            assert.ok(distinct.size > 2000, `only ${distinct.size} distinct generated inputs`);

            const token = (column: string) => `CASE WHEN typeof(${column}) IN ('text', 'blob') AND octet_length(${column}) > ?6 ` +
                `THEN CASE typeof(${column}) WHEN 'text' THEN 't' ELSE 'b' END || CAST(octet_length(${column}) AS TEXT) ELSE '' END`;
            const metadataSql = `SELECT ${['?1', '?2', '?3', '?4', '?5'].map(token).join(" || '|' || ")}, ` +
                'sqlite_explorer_cell_metadata(?6, ?1, ?2, ?3, ?4, ?5)';
            const values = [null, 3, 1.5, 'x'.repeat(9), 'é'.repeat(5), new Uint8Array(12), ''];
            for (let round = 0; round < 2000; round++) {
                const row = Array.from({ length: 5 }, () => values[next(values.length)]);
                const [sqlTokens, helperTokens] = one(metadataSql, [...row, next(16)]);
                assert.equal(helperTokens, sqlTokens === '||||' ? null : sqlTokens);
            }

            for (const [label, value, limit] of [['a negative limit', "'x'", '-1'], ['a REAL limit', "'x'", '1.5']]) {
                assert.throws(() => instance.exec(`SELECT sqlite_explorer_cell_preview(${value}, ${limit}, 1)`),
                    /limits must be integers/, label);
            }
        } finally {
            engine.shutdown();
        }
    });

    it('cannot be called from schema code', async () => {
        const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
        const engine = opened.operations as WasmDatabaseEngine;
        try {
            await engine.executeQuery('CREATE VIEW helper_view AS SELECT sqlite_explorer_cell_text_check(1, 1) AS value');
            await assert.rejects(engine.executeQuery('SELECT * FROM helper_view'), /unsafe use of sqlite_explorer_cell_text_check/);
        } finally {
            engine.shutdown();
        }
    });
});

for (const backendName of ['wasm', 'native'] as const) {
    describe(`${backendName} grid pages with and without the cell helpers`, () => {
        for (const [label, table, options] of PAGES) {
            it(`match for ${label}`, async (context) => {
                if (backendName === 'native' && !bundledNativeBinary()) {
                    context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
                    return;
                }
                const image = await buildImage(FIXTURE_SQL);
                const backend = backendName === 'wasm' ? await openWasm(image) : await openNative(image);
                try {
                    const { sqlPage, helperPage, sqlUsedHelpers, helperUsedHelpers } = await fetchBoth(backend, table, options);
                    assert.equal(sqlUsedHelpers, false);
                    assert.equal(helperUsedHelpers, true);
                    assert.deepStrictEqual(helperPage, sqlPage);
                } finally {
                    backend.dispose();
                }
            });
        }

        it('keep SQL containment for a UTF-16 database', async (context) => {
            if (backendName === 'native' && !bundledNativeBinary()) {
                context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
                return;
            }
            const image = await buildImage(ROWID_FIXTURE_SQL, 'UTF-16le');
            const backend = backendName === 'wasm' ? await openWasm(image) : await openNative(image);
            try {
                const [, table, options] = PAGES[0];
                const { sqlPage, helperPage, helperUsedHelpers } = await fetchBoth(backend, table, options);
                assert.equal(helperUsedHelpers, false);
                assert.deepStrictEqual(helperPage, sqlPage);
            } finally {
                backend.dispose();
            }
        });
    });
}
