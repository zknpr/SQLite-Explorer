import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import type { DatabaseOperations } from '../../src/core/types';

/**
 * The WebAssembly build enables R*Tree, which GeoPackage files use for their
 * spatial index, and SQLite's math functions, which the native build has.
 * extension-functions.c still provides the functions only sql.js had; where
 * SQLite defines the same name and argument count, SQLite's built-in is used,
 * so log(X) is base 10 on both engines. Its libm can differ from a native
 * libm in the last digit; what the WebAssembly build does with a schema that
 * uses a math function is in wasm_math_schema.test.ts.
 */

type Observation = unknown;

async function attempt(work: () => Promise<unknown>): Promise<Observation> {
    try {
        return await work();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `error: ${/no such (?:function|module): \w+/.exec(message)?.[0] ?? message}`;
    }
}

async function rows(ops: DatabaseOperations, sql: string): Promise<unknown[][]> {
    return (await ops.executeQuery(sql))[0]?.rows ?? [];
}

async function rtreeObservations(ops: DatabaseOperations): Promise<Observation[]> {
    await ops.executeQuery('CREATE VIRTUAL TABLE boxes USING rtree(id, minx, maxx, miny, maxy)');
    await ops.executeQuery('INSERT INTO boxes VALUES (1, 0, 10, 0, 10), (2, 5, 15, 5, 15), (3, 20, 30, 20, 30)');
    const hits = await rows(ops, 'SELECT id FROM boxes WHERE minx <= 6 AND maxx >= 6 AND miny <= 6 AND maxy >= 6 ORDER BY id');
    await ops.executeQuery('UPDATE boxes SET minx = 100, maxx = 110 WHERE id = 1');
    await ops.executeQuery('DELETE FROM boxes WHERE id = 2');
    return [
        hits,
        await rows(ops, 'SELECT id, minx, maxx, miny, maxy FROM boxes ORDER BY id'),
        await rows(ops, "SELECT rtreecheck('boxes') AS result")
    ];
}

const RTREE_EXPECTED = [
    [[1], [2]],
    [[1, 100, 110, 0, 10], [3, 20, 30, 20, 30]],
    [['ok']]
];

/**
 * A feature table indexed the way the GeoPackage R*Tree extension specifies:
 * the rows and index exist before the triggers, as in a file written by GDAL.
 * The triggers call ST_IsEmpty and ST_MinX, which neither engine defines.
 */
const GEOPACKAGE_SCHEMA = `
CREATE TABLE gpkg_extensions (table_name TEXT, column_name TEXT, extension_name TEXT NOT NULL, definition TEXT NOT NULL, scope TEXT NOT NULL);
CREATE TABLE places (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB, name TEXT);
INSERT INTO places (fid, geom, name) VALUES (1, x'47500001', 'harbour'), (2, x'47500001', 'hill'), (3, NULL, 'unplaced');
CREATE VIRTUAL TABLE rtree_places_geom USING rtree(id, minx, maxx, miny, maxy);
INSERT INTO rtree_places_geom VALUES (1, 0, 1, 0, 1), (2, 10, 11, 10, 11);
INSERT INTO gpkg_extensions VALUES ('places', 'geom', 'gpkg_rtree_index', 'http://www.geopackage.org/spec120/#extension_rtree', 'write-only');
CREATE TRIGGER rtree_places_geom_insert AFTER INSERT ON places
  WHEN (new.geom NOT NULL AND NOT ST_IsEmpty(NEW.geom))
BEGIN
  INSERT OR REPLACE INTO rtree_places_geom VALUES (NEW.fid, ST_MinX(NEW.geom), ST_MaxX(NEW.geom), ST_MinY(NEW.geom), ST_MaxY(NEW.geom));
END;
CREATE TRIGGER rtree_places_geom_update6 AFTER UPDATE OF geom ON places
  WHEN OLD.fid = NEW.fid AND (NEW.geom NOTNULL AND NOT ST_IsEmpty(NEW.geom))
BEGIN
  UPDATE rtree_places_geom SET minx = ST_MinX(NEW.geom), maxx = ST_MaxX(NEW.geom), miny = ST_MinY(NEW.geom), maxy = ST_MaxY(NEW.geom) WHERE id = NEW.fid;
END;
CREATE TRIGGER rtree_places_geom_update7 AFTER UPDATE OF geom ON places
  WHEN OLD.fid = NEW.fid AND (NEW.geom ISNULL OR ST_IsEmpty(NEW.geom))
BEGIN
  DELETE FROM rtree_places_geom WHERE id = OLD.fid;
END;
CREATE TRIGGER rtree_places_geom_delete AFTER DELETE ON places
  WHEN old.geom NOT NULL
BEGIN
  DELETE FROM rtree_places_geom WHERE id = OLD.fid;
END;`;

async function geopackageObservations(ops: DatabaseOperations): Promise<Observation[]> {
    return [
        await attempt(async () => { await ops.executeQuery(GEOPACKAGE_SCHEMA); return 'created'; }),
        await attempt(() => rows(ops,
            'SELECT p.name FROM places p JOIN rtree_places_geom r ON r.id = p.fid ' +
            'WHERE r.minx <= 10.5 AND r.maxx >= 10.5 AND r.miny <= 10.5 AND r.maxy >= 10.5')),
        // Editing an attribute fires no spatial trigger.
        await attempt(async () => { await ops.executeQuery("UPDATE places SET name = 'mount' WHERE fid = 2"); return 'updated'; }),
        // The delete trigger keeps the index in step.
        await attempt(async () => { await ops.executeQuery('DELETE FROM places WHERE fid = 1'); return rows(ops, 'SELECT id FROM rtree_places_geom ORDER BY id'); }),
        // An insert or geometry edit compiles the ST_ triggers, which fails on both engines.
        await attempt(() => ops.executeQuery("INSERT INTO places (geom, name) VALUES (NULL, 'new')")),
        await attempt(() => ops.executeQuery('UPDATE places SET geom = NULL WHERE fid = 2')),
        await attempt(() => rows(ops, "SELECT rtreecheck('rtree_places_geom') AS result")),
        await attempt(() => rows(ops, 'SELECT fid, name FROM places ORDER BY fid'))
    ];
}

const GEOPACKAGE_EXPECTED = [
    'created',
    [['hill']],
    'updated',
    [[2]],
    'error: no such function: ST_IsEmpty',
    'error: no such function: ST_IsEmpty',
    [['ok']],
    [[2, 'mount'], [3, 'unplaced']]
];

/**
 * The math built-ins extension-functions.c lacks, on values whose results are
 * exact, so any platform's libm gives the native engine the same answer.
 * [expression, typeof, quote]
 */
const ADDED_MATH: Array<[string, string, string]> = [
    ['ceiling(1.5)', 'real', '2.0'],
    ['ceiling(-1.5)', 'real', '-1.0'],
    ['ceiling(7)', 'integer', '7'],
    ['ceiling(NULL)', 'null', 'NULL'],
    ['trunc(-2.7)', 'real', '-2.0'],
    ['trunc(5)', 'integer', '5'],
    ['ln(1)', 'real', '0.0'],
    ['ln(0)', 'null', 'NULL'],
    ["ln('abc')", 'null', 'NULL'],
    ['log2(8)', 'real', '3.0'],
    ['log2(-1)', 'null', 'NULL'],
    ['log(2, 2)', 'real', '1.0'],
    ['log(10, 1)', 'real', '0.0'],
    ['log(1, 10)', 'null', 'NULL'],
    ['mod(7, 3)', 'real', '1.0'],
    ['mod(-7.5, 2)', 'real', '-1.5'],
    ['mod(1, 0)', 'null', 'NULL'],
    ['pow(2, 10)', 'real', '1024.0'],
    ['pow(-8, 0.5)', 'null', 'NULL']
];

/**
 * Functions sql.js always had. Those SQLite also defines give SQLite's results;
 * the rest keep the results they had before this build.
 */
const LEGACY: Array<[string, string, string]> = [
    // Base 10, as SQLite's log(X); extension-functions.c's was the natural logarithm.
    ['log(100)', 'real', '2.0'],
    ['log10(1000)', 'real', '3.0'],
    // REAL for REAL input, as SQLite's floor and ceil; extension-functions.c returned INTEGER.
    ['floor(2.5)', 'real', '2.0'],
    ['ceil(2.5)', 'real', '3.0'],
    // NULL for text, as SQLite's math functions; extension-functions.c read it as 0.
    ["cos('abc')", 'null', 'NULL'],
    ['sqrt(16)', 'real', '4.0'],
    ['power(2, 10)', 'real', '1024.0'],
    ['square(3)', 'integer', '9'],
    ['sign(-4)', 'integer', '-1'],
    ['cot(1)', 'real', '0.64209261593433065'],
    ['atn2(1, 1)', 'real', '0.78539816339744828'],
    ["reverse('abc')", 'text', "'cba'"],
    ["padl('7', 3)", 'text', "'  7'"],
    ['(SELECT median(column1) FROM (VALUES (1), (5), (3)))', 'integer', '3'],
    ['(SELECT stdev(column1) FROM (VALUES (1), (3)))', 'real', '1.4142135623730952'],
    ['(SELECT mode(column1) FROM (VALUES (1), (3), (3)))', 'integer', '3']
];

async function evaluate(ops: DatabaseOperations, cases: Array<[string, string, string]>) {
    const results: Array<[string, unknown, unknown]> = [];
    for (const [expression] of cases) {
        const [[kind, quoted]] = await rows(ops, `SELECT typeof(${expression}) AS kind, quote(${expression}) AS quoted`);
        results.push([expression, kind, quoted]);
    }
    return results;
}

async function functionList(ops: DatabaseOperations): Promise<Set<string>> {
    return new Set((await rows(ops, 'SELECT name, narg FROM pragma_function_list')).map(([name, narg]) => `${name}/${narg}`));
}

/** Functions only sql.js defines, with the results they had before SQLite's built-ins took the shared names. */
const SQLJS_ONLY: Array<[string, string, string]> = [
    ['atn2(1, 2)', 'real', '0.46364760900080609'],
    ["atn2('abc', 1)", 'real', '0.0'],
    ["charindex('b', 'abcb')", 'integer', '2'],
    ["charindex('b', 'abcb', 3)", 'integer', '4'],
    ['cot(2)', 'real', '-0.45765755436028577'],
    ['cot(0)', 'real', '9.0e+999'],
    ['coth(2)', 'real', '1.0373147207275482'],
    ["difference('Robert', 'Rupert')", 'integer', '4'],
    ["leftstr('abcdef', 2)", 'text', "'ab'"],
    ["rightstr('abcdef', 2)", 'text', "'ef'"],
    ["padc('ab', 6)", 'text', "'  ab  '"],
    ["padl('ab', 4)", 'text', "'  ab'"],
    ["padr('ab', 4)", 'text', "'ab  '"],
    ["proper('hello wORLD')", 'text', "'Hello World'"],
    ["replicate('ab', 3)", 'text', "'ababab'"],
    ["reverse('héllo')", 'text', "'olléh'"],
    ['square(2.5)', 'real', '6.25'],
    ["square('abc')", 'real', '0.0'],
    ['square(NULL)', 'null', 'NULL'],
    ["strfilter('abcdef', 'bdf')", 'text', "'bdf'"],
    ['(SELECT median(column1) FROM (VALUES (1), (2), (2), (4), (7), (9)))', 'real', '3.0'],
    ['(SELECT mode(column1) FROM (VALUES (1), (2), (2), (4), (7), (9)))', 'integer', '2'],
    ['(SELECT lower_quartile(column1) FROM (VALUES (1), (2), (2), (4), (7), (9)))', 'integer', '2'],
    ['(SELECT upper_quartile(column1) FROM (VALUES (1), (2), (2), (4), (7), (9)))', 'integer', '7'],
    ['(SELECT stdev(column1) FROM (VALUES (1), (2), (2), (4), (7), (9)))', 'real', '3.1885210782848317'],
    ['(SELECT variance(column1) FROM (VALUES (1), (2), (2), (4), (7), (9)))', 'real', '10.166666666666666']
];

/** The (name, narg) pairs that both SQLite's built-ins and extension-functions.c define. */
const SHARED_PAIRS = ('acos/1 asin/1 atan/1 atan2/2 acosh/1 asinh/1 atanh/1 degrees/1 radians/1 cos/1 sin/1 ' +
    'tan/1 cosh/1 sinh/1 tanh/1 exp/1 log/1 log10/1 power/2 sign/1 sqrt/1 ceil/1 floor/1 pi/0').split(' ');

/** SQLite's math built-ins that extension-functions.c does not define. */
const BUILTIN_ONLY_MATH = ['ceiling/1', 'ln/1', 'log/2', 'log2/1', 'mod/2', 'pow/2', 'trunc/1'];

/**
 * Shared pairs whose results come from the platform's libm, compared within
 * LIBM_TOLERANCE_ULPS: two libms that each stay within one ULP of the exact
 * value can differ by two. log and log10 are among them: glibc on x86_64
 * gives log10(pi) one ULP below this build's value, while Apple's and
 * Microsoft's libms agree with it. The tolerance still tells base 10 from
 * the natural logarithm. The others (ceil, floor, sign, sqrt, pi, degrees and
 * radians) are arithmetic or correctly rounded on both engines and must
 * match exactly, as must every type and NULL.
 */
const LIBM_PAIRS = new Set(('acos/1 asin/1 atan/1 atan2/2 acosh/1 asinh/1 atanh/1 cos/1 sin/1 tan/1 cosh/1 ' +
    'sinh/1 tanh/1 exp/1 log/1 log10/1 power/2').split(' '));
const LIBM_TOLERANCE_ULPS = 2n;

const EDGE_VALUES = ['NULL', '0', '-0.0', '1', '-1', '0.5', '-0.5', '2', '3', '10', '100', '1e308', '-1e308',
    '9223372036854775807', '-9223372036854775808', '1e999', '-1e999', '4.9e-324', '1e-310',
    '2.2250738585072014e-308', '3.141592653589793', '1e15', '1e16', '0.1', '-7.5', "'abc'", "'12'", "' 3.5 '",
    "''", "x'01'"];
const EDGE_ARGUMENT_PAIRS = ['NULL', '0', '-0.0', '1', '-1', '0.5', '2', '-7.5', '10', '1e308', '1e999', '-1e999',
    '4.9e-324', "'abc'", "'12'"];

/** [pair, expression] for every shared pair over the edge values. */
function sharedCalls(): Array<[string, string]> {
    return SHARED_PAIRS.flatMap(pair => {
        const [name, narg] = pair.split('/');
        const argumentLists = narg === '0' ? [[]] : narg === '1'
            ? EDGE_VALUES.map(value => [value])
            : EDGE_ARGUMENT_PAIRS.flatMap(first => EDGE_ARGUMENT_PAIRS.map(second => [first, second]));
        return argumentLists.map(values => [pair, `${name}(${values.join(', ')})`] as [string, string]);
    });
}

async function typedResults(ops: DatabaseOperations, calls: Array<[string, string]>): Promise<unknown[][]> {
    const results: unknown[][] = [];
    for (const [, expression] of calls) {
        results.push((await rows(ops, `SELECT typeof(${expression}) AS kind, quote(${expression}) AS quoted`))[0]);
    }
    return results;
}

/** Distance in units in the last place; quote() writes infinities as 9.0e+999, which Number() reads. */
function ulpDistance(x: number, y: number): bigint {
    const view = new DataView(new ArrayBuffer(16));
    view.setFloat64(0, x);
    view.setFloat64(8, y);
    // Map the sign-magnitude bit patterns onto one line, so adjacent doubles differ by 1.
    const line = (raw: bigint) => raw < 0n ? -(raw & 0x7fffffffffffffffn) : raw;
    const distance = line(view.getBigInt64(0)) - line(view.getBigInt64(8));
    return distance < 0n ? -distance : distance;
}

/** All 206 (name, narg) pairs of the WebAssembly build before SQLite's built-ins took the shared names. */
const PREVIOUS_WASM_FUNCTIONS = (
    '->/2 ->>/2 abs/1 acos/1 acosh/1 asin/1 asinh/1 atan/1 atan2/2 atanh/1 atn2/2 avg/1 bm25/-1 ceil/1 ' +
    'ceiling/1 changes/0 char/-1 charindex/2 charindex/3 coalesce/-4 concat/-3 concat_ws/-4 cos/1 cosh/1 cot/1 ' +
    'coth/1 count/0 count/1 cume_dist/0 current_date/0 current_time/0 current_timestamp/0 date/-1 datetime/-1 ' +
    'degrees/1 dense_rank/0 difference/2 exp/1 first_value/1 floor/1 format/-1 fts3_tokenizer/1 ' +
    'fts3_tokenizer/2 fts5/1 fts5_get_locale/-1 fts5_insttoken/1 fts5_locale/2 fts5_source_id/0 glob/2 ' +
    'group_concat/1 group_concat/2 hex/1 highlight/-1 if/-4 ifnull/2 iif/-4 instr/2 json/1 json_array/-1 ' +
    'json_array_insert/-1 json_array_length/1 json_array_length/2 json_error_position/1 json_extract/-1 ' +
    'json_group_array/1 json_group_object/2 json_insert/-1 json_object/-1 json_patch/2 json_pretty/1 ' +
    'json_pretty/2 json_quote/1 json_remove/-1 json_replace/-1 json_set/-1 json_type/1 json_type/2 json_valid/1 ' +
    'json_valid/2 jsonb/1 jsonb_array/-1 jsonb_array_insert/-1 jsonb_extract/-1 jsonb_group_array/1 ' +
    'jsonb_group_object/2 jsonb_insert/-1 jsonb_object/-1 jsonb_patch/2 jsonb_remove/-1 jsonb_replace/-1 ' +
    'jsonb_set/-1 julianday/-1 lag/1 lag/2 lag/3 last_insert_rowid/0 last_value/1 lead/1 lead/2 lead/3 ' +
    'leftstr/2 length/1 like/2 like/3 likelihood/2 likely/1 ln/1 log/1 log/2 log10/1 log2/1 lower/1 ' +
    'lower_quartile/1 ltrim/1 ltrim/2 match/2 matchinfo/1 matchinfo/2 max/-3 max/1 median/1 min/-3 min/1 mod/2 ' +
    'mode/1 nth_value/2 ntile/1 nullif/2 octet_length/1 offsets/1 optimize/1 padc/2 padl/2 padr/2 ' +
    'percent_rank/0 pi/0 pow/2 power/2 printf/-1 proper/1 quote/1 radians/1 random/0 randomblob/1 rank/0 ' +
    'replace/3 replicate/2 reverse/1 rightstr/2 round/1 round/2 row_number/0 rtreecheck/-1 rtreedepth/1 ' +
    'rtreenode/2 rtrim/1 rtrim/2 sign/1 sin/1 sinh/1 snippet/-1 sqlite_compileoption_get/1 ' +
    'sqlite_compileoption_used/1 sqlite_explorer_cell_metadata/-1 sqlite_explorer_cell_pack/-1 ' +
    'sqlite_explorer_cell_preview/3 sqlite_explorer_cell_text_check/2 sqlite_explorer_like_any/-1 ' +
    'sqlite_explorer_query_plan/-1 sqlite_explorer_real_texts/-1 sqlite_log/2 sqlite_source_id/0 ' +
    'sqlite_version/0 sqrt/1 square/1 stdev/1 strfilter/2 strftime/-1 string_agg/2 substr/2 substr/3 ' +
    'substring/2 substring/3 subtype/1 sum/1 tan/1 tanh/1 time/-1 timediff/2 total/1 total_changes/0 trim/1 ' +
    'trim/2 trunc/1 typeof/1 unhex/1 unhex/2 unicode/1 unistr/1 unistr_quote/1 unixepoch/-1 unlikely/1 upper/1 ' +
    'upper_quartile/1 variance/1 zeroblob/1'
).split(' ');

/**
 * Schemas on reverse(), a function only sql.js defines, as a SQLite with a
 * deterministic reverse() writes them. sql.js's reverse() is not
 * deterministic, so these stay refused: registering it must not load the
 * schema first, while SQLite still ignores unknown functions.
 */
const SQLJS_ONLY_SCHEMAS: Array<[string, string, RegExp]> = [
    ['an index on reverse(x)',
        "CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('ab'); CREATE INDEX t_rev ON t(reverse(x))",
        /malformed database schema \(t_rev\) - non-deterministic functions prohibited in index expressions/],
    ['a stored generated column using reverse',
        "CREATE TABLE t (x TEXT, y TEXT GENERATED ALWAYS AS (reverse(x)) STORED); INSERT INTO t (x) VALUES ('ab')",
        /malformed database schema \(t\) - non-deterministic functions prohibited in generated columns/],
    ['a partial index whose WHERE uses reverse',
        "CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('ab'); CREATE INDEX t_partial ON t(x) WHERE reverse(x) <> ''",
        /malformed database schema \(t_partial\) - non-deterministic functions prohibited in partial index WHERE clauses/]
];

function deterministicReverseImage(schema: string): Uint8Array {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/wasm-sqljs-only-schema-'));
    try {
        const file = path.join(directory, 'reverse.db');
        const db = new DatabaseSync(file);
        try {
            db.function('reverse', { deterministic: true }, (value: unknown) => [...String(value)].reverse().join(''));
            db.exec(schema);
        } finally {
            db.close();
        }
        return new Uint8Array(fs.readFileSync(file));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

/** The native engine's file for a schema, as bytes. */
async function nativeImage(schema: string): Promise<Uint8Array> {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/wasm-math-schema-'));
    const file = path.join(directory, 'native.db');
    fs.closeSync(fs.openSync(file, 'w'));
    const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
    try {
        const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'wasm-math-schema', false);
        await databaseOps.executeQuery(schema);
        assert.ok(Number((await rows(databaseOps, 'SELECT count(*) AS n FROM t'))[0][0]) > 0);
    } finally {
        native.workerMethods[Symbol.dispose]();
    }
    try {
        return new Uint8Array(fs.readFileSync(file));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
}

async function withWasm(work: (ops: WasmDatabaseEngine) => Promise<void>) {
    const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    try {
        await work(engine);
    } finally {
        engine.shutdown();
    }
}

/** The bundled worker for this platform; under FUZZ_EXPECT_TARGET a missing one fails. */
function bundledNativeBinary(): string | undefined {
    const platformDir = process.platform === 'darwin'
        ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos')
        : process.platform === 'linux'
            ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu')
            : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-windows' : undefined;
    const expected = process.env.FUZZ_EXPECT_TARGET;
    if (expected && expected !== platformDir) {
        throw new Error(`Expected native target ${expected}, resolved ${platformDir ?? 'none'}`);
    }
    const binary = platformDir && path.join('natives', platformDir, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
    if (binary && fs.existsSync(binary)) return binary;
    if (expected) throw new Error(`Missing native runtime ${binary}`);
    return undefined;
}

async function withNative(work: (ops: DatabaseOperations) => Promise<void>) {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/wasm-rtree-math-'));
    const file = path.join(directory, 'empty.db');
    fs.closeSync(fs.openSync(file, 'w'));
    const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
    try {
        const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'wasm-rtree-math', false);
        await work(databaseOps);
    } finally {
        native.workerMethods[Symbol.dispose]();
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
}

const noNative = () => bundledNativeBinary() ? false : `no bundled txiki worker for ${process.platform}-${process.arch}`;

describe('WebAssembly R*Tree', () => {
    it('creates, fills, queries and checks an R*Tree index', async () => {
        await withWasm(async ops => assert.deepEqual(await rtreeObservations(ops), RTREE_EXPECTED));
    });

    it('gives the native engine\'s answers', { skip: noNative() }, async () => {
        await withNative(async ops => assert.deepEqual(await rtreeObservations(ops), RTREE_EXPECTED));
    });

    it('reads and deletes from a GeoPackage-style feature table, and refuses inserts its triggers cannot run', async () => {
        await withWasm(async ops => assert.deepEqual(await geopackageObservations(ops), GEOPACKAGE_EXPECTED));
    });

    it('treats the GeoPackage-style table as the native engine does', { skip: noNative() }, async () => {
        await withNative(async ops => assert.deepEqual(await geopackageObservations(ops), GEOPACKAGE_EXPECTED));
    });
});

describe('WebAssembly math functions', () => {
    it('adds SQLite\'s math built-ins that extension-functions.c lacks', async () => {
        await withWasm(async ops => assert.deepEqual(await evaluate(ops, ADDED_MATH), ADDED_MATH));
    });

    it('gives the native engine\'s answers for the added built-ins', { skip: noNative() }, async () => {
        await withNative(async ops => assert.deepEqual(await evaluate(ops, ADDED_MATH), ADDED_MATH));
    });

    it('gives the shared names SQLite\'s results and keeps the others, without printing anything', async () => {
        const printed: unknown[][] = [];
        const methods = ['log', 'info', 'warn', 'error'] as const;
        const originals = methods.map(method => console[method]);
        for (const method of methods) console[method] = (...args: unknown[]) => { printed.push([method, ...args]); };
        try {
            await withWasm(async ops => assert.deepEqual(await evaluate(ops, LEGACY), LEGACY));
        } finally {
            methods.forEach((method, index) => { console[method] = originals[index]; });
        }
        assert.deepEqual(printed, []);
        // Upstream's Makefile wraps these functions in a deprecation warning
        // emitted from the glue; this build compiles the wrapper silent.
        assert.doesNotMatch(fs.readFileSync('vendor/sql.js/sql-wasm.js', 'utf8'), /legacy function/);
    });

    it('keeps the results of the functions only sql.js defines', async () => {
        await withWasm(async ops => assert.deepEqual(await evaluate(ops, SQLJS_ONLY), SQLJS_ONLY));
    });

    it('keeps every function of the previous build', async () => {
        await withWasm(async ops => {
            const wasm = await functionList(ops);
            assert.deepEqual(PREVIOUS_WASM_FUNCTIONS.filter(entry => !wasm.has(entry)), []);
        });
    });

    it('keeps SQLite\'s math functions deterministic, as the native engine has them', async () => {
        await withWasm(async ops => {
            const math = new Set([...SHARED_PAIRS, ...BUILTIN_ONLY_MATH]);
            const listed = await rows(ops, "SELECT DISTINCT name, narg, flags FROM pragma_function_list WHERE builtin");
            assert.deepEqual([...math].filter(pair => !listed.some(([name, narg]) => `${name}/${narg}` === pair)), []);
            // 0x800 is SQLITE_DETERMINISTIC.
            const notDeterministic = listed
                .filter(([name, narg, flags]) => math.has(`${name}/${narg}`) && (Number(flags) & 0x800) === 0)
                .map(([name, narg]) => `${name}/${narg}`);
            assert.deepEqual(notDeterministic, []);
        });
    });

    it('gives the native engine\'s answers for every shared pair', { skip: noNative() }, async () => {
        const calls = sharedCalls();
        let wasm: unknown[][] = [];
        let native: unknown[][] = [];
        await withWasm(async ops => { wasm = await typedResults(ops, calls); });
        await withNative(async ops => { native = await typedResults(ops, calls); });
        const mismatches: string[] = [];
        calls.forEach(([pair, expression], index) => {
            const [wasmType, wasmText] = wasm[index];
            const [nativeType, nativeText] = native[index];
            if (wasmType === nativeType && wasmText === nativeText) return;
            if (wasmType === 'real' && nativeType === 'real' && LIBM_PAIRS.has(pair)
                && ulpDistance(Number(wasmText), Number(nativeText)) <= LIBM_TOLERANCE_ULPS) return;
            mismatches.push(`${expression}: ${String(wasmType)} ${String(wasmText)}, native ${String(nativeType)} ${String(nativeText)}`);
        });
        assert.equal(calls.length, 1081);
        assert.deepEqual(mismatches, []);
    });

    for (const [label, schema, message] of SQLJS_ONLY_SCHEMAS) {
        it(`refuses a file with ${label}, a function only sql.js defines`, async () => {
            const engine = (await createDatabaseEngine({ content: deterministicReverseImage(schema), maxSize: 0, readOnlyMode: false }))
                .operations as WasmDatabaseEngine;
            try {
                await assert.rejects(engine.fetchSchema(), message);
                await assert.rejects(engine.executeQuery("INSERT INTO t (x) VALUES ('cd')"), message);
            } finally {
                engine.shutdown();
            }
        });
    }

    it('opens a native file with a CHECK constraint using log, and checks it with SQLite\'s base-10 log', { skip: noNative() }, async () => {
        // SQLite accepts non-deterministic functions in CHECK constraints, so
        // this file opened before as well; the CHECK then used the natural log.
        const content = await nativeImage('CREATE TABLE t (x REAL CHECK (log(x) < 10)); INSERT INTO t VALUES (100)');
        const engine = (await createDatabaseEngine({ content, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            await engine.fetchSchema();
            await engine.executeQuery('INSERT INTO t VALUES (1e9)');
            await assert.rejects(engine.executeQuery('INSERT INTO t VALUES (1e11)'), /CHECK constraint failed/);
            assert.deepEqual(await rows(engine, 'SELECT x FROM t ORDER BY x'), [[100], [1e9]]);
        } finally {
            engine.shutdown();
        }
    });

    it('defines every function the native engine has, except load_extension', { skip: noNative() }, async () => {
        let native = new Set<string>();
        await withNative(async ops => { native = await functionList(ops); });
        await withWasm(async ops => {
            const wasm = await functionList(ops);
            const missing = [...native].filter(entry => !wasm.has(entry) && !entry.startsWith('load_extension/'));
            assert.deepEqual(missing, []);
            for (const entry of ['ceiling/1', 'ln/1', 'log/2', 'log2/1', 'mod/2', 'pow/2', 'trunc/1', 'rtreecheck/-1', 'median/1']) {
                assert.ok(wasm.has(entry), entry);
            }
        });
    });
});
