import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import type { ModificationEntry } from '../../src/core/types';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';

/**
 * A database whose schema uses a math function, written by the native engine
 * and opened by the WebAssembly one. The two math libraries can round a
 * result differently in the last digit (ln(3) does on macOS), so an index key
 * or a stored column computed here is not always the one native computes.
 *
 * That is so for the functions that compute with the library: logarithms,
 * exp, pow, trigonometry. floor, ceil, trunc, mod, sqrt and a few more cannot
 * differ (wasm_exact_math_parity.test.ts) and are ordinary functions here.
 *
 * For the others the WebAssembly SQLite (scripts/lib/sqlite-math-patch.mjs):
 * - loads every such schema and reads every table;
 * - never opens an index that depends on a math function: a query scans the
 *   table instead, and a statement that would have to write the index fails;
 * - does not modify a table that stores a generated column depending on one.
 *
 * Each shape below is one table of one file, and every statement runs against
 * a fresh copy of that file.
 */

const SCHEMA = `
CREATE TABLE e(id INTEGER PRIMARY KEY, x REAL, note TEXT);
INSERT INTO e(x, note) VALUES (3, 'three'), (5, 'five'), (2.5, 'half');
CREATE INDEX e_ln ON e(ln(x));
CREATE TABLE p(id INTEGER PRIMARY KEY, x REAL, note TEXT);
INSERT INTO p(x, note) VALUES (4, 'four'), (0.25, 'quarter');
CREATE INDEX p_part ON p(note) WHERE ln(x) > 0;
CREATE TABLE s(id INTEGER PRIMARY KEY, x REAL, y REAL GENERATED ALWAYS AS (pow(2, x)) STORED, note TEXT);
INSERT INTO s(x, note) VALUES (-7.5, 'a'), (1, 'b');
CREATE TABLE v(id INTEGER PRIMARY KEY, x REAL, y REAL GENERATED ALWAYS AS (exp(x)) VIRTUAL, note TEXT);
INSERT INTO v(x, note) VALUES (1, 'a'), (2, 'b');
CREATE TABLE vi(id INTEGER PRIMARY KEY, x REAL, y REAL GENERATED ALWAYS AS (ln(x)) VIRTUAL, note TEXT);
INSERT INTO vi(x, note) VALUES (3, 'a'), (5, 'b');
CREATE INDEX vi_y ON vi(y);
CREATE TABLE u1(id INTEGER PRIMARY KEY, x REAL, y REAL UNIQUE AS (ln(x)), note TEXT);
INSERT INTO u1(x, note) VALUES (3, 'a'), (5, 'b');
CREATE TABLE u2(id INTEGER PRIMARY KEY, x REAL, y REAL AS (ln(x)) UNIQUE, note TEXT);
INSERT INTO u2(x, note) VALUES (3, 'a'), (5, 'b');
CREATE TABLE f(id INTEGER PRIMARY KEY, x REAL, note TEXT);
INSERT INTO f(x, note) VALUES (2.5, 'a'), (7.25, 'b');
CREATE INDEX f_floor ON f(floor(x));
CREATE TABLE o(id INTEGER PRIMARY KEY, x TEXT, note TEXT);
INSERT INTO o(x, note) VALUES ('Xy', 'a'), ('Zw', 'b');
CREATE INDEX o_lower ON o(lower(x));
`;

/** What a statement does: it runs, or it is refused for an index, or for its table. */
type Outcome = 'runs' | 'index' | 'table';

interface Shape {
    table: string;
    label: string;
    /** A WHERE clause that selects row `lookupRow` and that the shape's index was made for. */
    lookup: string;
    lookupRow: number;
    orderBy: string;
    /** The index that depends on a math function, or the ordinary one of the control. */
    index?: string;
    insert: Outcome;
    editNote: Outcome;
    editSource: Outcome;
    deleteRow: Outcome;
    deleteAll: Outcome;
}

const SHAPES: Shape[] = [
    { table: 'e', label: 'an index on ln(x)', lookup: 'ln(x) = ln(3)', lookupRow: 1, orderBy: 'ln(x)', index: 'e_ln',
        insert: 'index', editNote: 'runs', editSource: 'index', deleteRow: 'index', deleteAll: 'runs' },
    { table: 'p', label: 'a partial index whose WHERE uses ln', lookup: "ln(x) > 0 AND note = 'four'", lookupRow: 1, orderBy: 'note', index: 'p_part',
        insert: 'index', editNote: 'index', editSource: 'index', deleteRow: 'index', deleteAll: 'runs' },
    { table: 's', label: 'a stored generated column using pow', lookup: 'y = pow(2, 1)', lookupRow: 2, orderBy: 'y',
        insert: 'table', editNote: 'table', editSource: 'table', deleteRow: 'table', deleteAll: 'table' },
    { table: 'v', label: 'a virtual generated column using exp', lookup: 'y = exp(1)', lookupRow: 1, orderBy: 'y',
        insert: 'runs', editNote: 'runs', editSource: 'runs', deleteRow: 'runs', deleteAll: 'runs' },
    { table: 'vi', label: 'an index on a virtual generated column using ln', lookup: 'y = ln(3)', lookupRow: 1, orderBy: 'y', index: 'vi_y',
        insert: 'index', editNote: 'runs', editSource: 'index', deleteRow: 'index', deleteAll: 'runs' },
    { table: 'u1', label: 'UNIQUE declared before a virtual generated column using ln', lookup: 'y = ln(3)', lookupRow: 1, orderBy: 'y', index: 'sqlite_autoindex_u1_1',
        insert: 'index', editNote: 'runs', editSource: 'index', deleteRow: 'index', deleteAll: 'runs' },
    { table: 'u2', label: 'UNIQUE declared after a virtual generated column using ln', lookup: 'y = ln(3)', lookupRow: 1, orderBy: 'y', index: 'sqlite_autoindex_u2_1',
        insert: 'index', editNote: 'runs', editSource: 'index', deleteRow: 'index', deleteAll: 'runs' }
];

/** Indexes that depend on no such function work as on any SQLite. */
const CONTROLS: Shape[] = [
    { table: 'f', label: 'an index on floor(x), which cannot round differently', lookup: 'floor(x) = 2', lookupRow: 1, orderBy: 'floor(x)', index: 'f_floor',
        insert: 'runs', editNote: 'runs', editSource: 'runs', deleteRow: 'runs', deleteAll: 'runs' },
    { table: 'o', label: 'an index on lower(x), which is no math function', lookup: "lower(x) = 'xy'", lookupRow: 1, orderBy: 'lower(x)', index: 'o_lower',
        insert: 'runs', editNote: 'runs', editSource: 'runs', deleteRow: 'runs', deleteAll: 'runs' }
];

const REFUSAL: Record<Exclude<Outcome, 'runs'>, RegExp> = {
    index: /index \S+ depends on a math function that this engine can round differently .* cannot be read or written here/,
    table: /table \S+ stores a generated column that depends on a math function, .* cannot be modified here/
};

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

const skip = bundledNativeBinary() ? false : `no bundled txiki worker for ${process.platform}-${process.arch}`;

/** Distance in units in the last place. */
function ulpDistance(x: number, y: number): bigint {
    const view = new DataView(new ArrayBuffer(16));
    view.setFloat64(0, x);
    view.setFloat64(8, y);
    const line = (raw: bigint) => raw < 0n ? -(raw & 0x7fffffffffffffffn) : raw;
    const distance = line(view.getBigInt64(0)) - line(view.getBigInt64(8));
    return distance < 0n ? -distance : distance;
}

describe('a native file whose schema uses a math function, on WebAssembly', { skip }, () => {
    let image: Uint8Array;
    /** quote() of the same calls on the native engine. */
    let nativeValues: Record<string, string>;
    /** Native's rows of each table, with its generated columns. */
    let nativeRows: Record<string, unknown[][]>;

    before(async () => {
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/wasm-math-schema-'));
        const file = path.join(directory, 'native.db');
        fs.closeSync(fs.openSync(file, 'w'));
        const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
        try {
            const connection = await native.establishConnection(vscode.Uri.file(file), 'native.db', false);
            const ops = connection.databaseOps;
            await ops.executeQuery(SCHEMA);
            const quoted = (await ops.executeQuery('SELECT quote(ln(3)), quote(exp(1)), quote(pow(2, -7.5))'))[0].rows[0];
            nativeValues = { ln3: String(quoted[0]), exp1: String(quoted[1]), pow: String(quoted[2]) };
            nativeRows = {};
            for (const { table } of [...SHAPES, ...CONTROLS]) {
                nativeRows[table] = (await ops.executeQuery(`SELECT * FROM ${table} ORDER BY id`))[0].rows;
            }
            // A clean close, so the file on disk is complete before it is read.
            await connection.closeDatabase!();
        } finally {
            native.workerMethods[Symbol.dispose]();
        }
        try {
            image = new Uint8Array(fs.readFileSync(file));
        } finally {
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        }
    });

    async function withWasm<T>(work: (engine: WasmDatabaseEngine) => Promise<T>): Promise<T> {
        const engine = (await createDatabaseEngine({ content: image.slice(), maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            return await work(engine);
        } finally {
            engine.shutdown();
        }
    }

    const rows = async (engine: WasmDatabaseEngine, sql: string): Promise<unknown[][]> =>
        (await engine.executeQuery(sql))[0]?.rows ?? [];
    const plan = async (engine: WasmDatabaseEngine, sql: string): Promise<string> =>
        (await rows(engine, `EXPLAIN QUERY PLAN ${sql}`)).map(row => String(row[3])).join(' | ');
    const ids = async (engine: WasmDatabaseEngine, table: string): Promise<unknown[]> =>
        (await rows(engine, `SELECT id FROM ${table} ORDER BY id`)).map(row => row[0]);

    /** Run one statement and check that it did what the shape says, and nothing else. */
    async function expectOutcome(
        shape: Shape,
        outcome: Outcome,
        statement: (engine: WasmDatabaseEngine) => Promise<unknown>,
        changed: (engine: WasmDatabaseEngine) => Promise<void>
    ) {
        await withWasm(async engine => {
            const beforeRows = await rows(engine, `SELECT id, x, note FROM ${shape.table} ORDER BY id`);
            if (outcome === 'runs') {
                await statement(engine);
                await changed(engine);
                return;
            }
            await assert.rejects(statement(engine), REFUSAL[outcome]);
            assert.deepEqual(await rows(engine, `SELECT id, x, note FROM ${shape.table} ORDER BY id`), beforeRows);
            // The refusal leaves the connection usable.
            await engine.updateCell('o', 1, 'note', 'still writable');
        });
    }

    it('rounds ln(3) or pow(2, -7.5) differently from the native engine where the two math libraries differ', async () => {
        const wasm = await withWasm(async engine => (await rows(engine, 'SELECT quote(ln(3)), quote(exp(1)), quote(pow(2, -7.5))'))[0].map(String));
        const native = [nativeValues.ln3, nativeValues.exp1, nativeValues.pow];
        // Not every platform's libm differs on these inputs; where one does, a
        // lookup through the native index with a value computed here would miss.
        wasm.forEach((value, index) => {
            assert.ok(ulpDistance(Number(value), Number(native[index])) <= 2n, `${value} against native ${native[index]}`);
        });
        if (process.platform === 'darwin' && process.arch === 'arm64') {
            assert.notEqual(wasm[0], native[0], 'ln(3) is known to differ in the last digit on macOS arm64');
        }
    });

    it('lists every table and index', async () => {
        await withWasm(async engine => {
            const schema = await engine.fetchSchema();
            assert.deepEqual(schema.tables.map(table => table.identifier), ['e', 'f', 'o', 'p', 's', 'u1', 'u2', 'v', 'vi']);
            assert.deepEqual(schema.indexes.map(index => index.identifier), ['e_ln', 'f_floor', 'o_lower', 'p_part', 'vi_y']);
        });
    });

    for (const shape of [...SHAPES, ...CONTROLS]) {
        const dependent = SHAPES.includes(shape);

        it(`reads a table with ${shape.label}`, async () => {
            await withWasm(async engine => {
                const page = (await engine.fetchTableData(shape.table, { limit: 10, offset: 0 })).rows;
                const native = nativeRows[shape.table];
                assert.equal(page.length, native.length);
                page.forEach((row, rowIndex) => row.forEach((value, column) => {
                    const expected = native[rowIndex][column];
                    if (value === expected) return;
                    // A virtual column is computed here; a stored one is read as native wrote it.
                    assert.ok(shape.table !== 's' && typeof value === 'number' && typeof expected === 'number'
                        && ulpDistance(value, expected) <= 2n, `${shape.table} row ${rowIndex} column ${column}: ${String(value)} against native ${String(expected)}`);
                }));
                assert.deepEqual(await engine.fetchTableCount(shape.table, {}), { count: native.length, isExact: true });
                const sorted = (await engine.fetchTableData(shape.table, { limit: 10, offset: 0, orderBy: 'x', orderDir: 'DESC' })).rows;
                assert.deepEqual(sorted.map(row => row[0]).sort(), native.map(row => row[0]).sort());
            });
        });

        it(`finds a row of a table with ${shape.label} by the indexed expression, ${dependent ? 'without the index' : 'through the index'}`, async () => {
            await withWasm(async engine => {
                const lookup = `SELECT id FROM ${shape.table} WHERE ${shape.lookup}`;
                assert.deepEqual(await rows(engine, lookup), [[shape.lookupRow]]);
                const lookupPlan = await plan(engine, lookup);
                const orderPlan = await plan(engine, `SELECT id FROM ${shape.table} ORDER BY ${shape.orderBy}`);
                if (dependent) {
                    assert.equal(lookupPlan, `SCAN ${shape.table}`);
                    assert.equal(orderPlan, `SCAN ${shape.table} | USE TEMP B-TREE FOR ORDER BY`);
                } else {
                    assert.match(lookupPlan, new RegExp(`USING (COVERING )?INDEX ${shape.index}`));
                    assert.match(orderPlan, new RegExp(`USING (COVERING )?INDEX ${shape.index}`));
                }
                // Other ways SQLite reaches an index: IN, DISTINCT, count(*).
                const column = shape.table === 'o' || shape.table === 'e' || shape.table === 'p' || shape.table === 'f' ? 'x' : 'y';
                for (const sql of [
                    `SELECT 1 WHERE 1 IN (SELECT ${column} FROM ${shape.table})`,
                    `SELECT DISTINCT ${column} FROM ${shape.table}`,
                    `SELECT count(*) FROM ${shape.table}`
                ]) {
                    const text = await plan(engine, sql);
                    if (dependent && shape.index) assert.doesNotMatch(text, new RegExp(shape.index), sql);
                    await rows(engine, sql);
                }
                if (shape.index) {
                    const forced = `SELECT id FROM ${shape.table} INDEXED BY ${shape.index} WHERE ${shape.lookup}`;
                    if (dependent) await assert.rejects(rows(engine, forced), /no query solution/);
                    else assert.deepEqual(await rows(engine, forced), [[shape.lookupRow]]);
                }
            });
        });

        it(`${shape.insert === 'runs' ? 'inserts into' : 'refuses an insert into'} a table with ${shape.label}`, async () => {
            await expectOutcome(shape, shape.insert,
                engine => engine.executeQuery(`INSERT INTO ${shape.table}(x, note) VALUES (${shape.table === 'o' ? "'Q'" : '9'}, 'new')`),
                async engine => assert.equal((await ids(engine, shape.table)).length, nativeRows[shape.table].length + 1));
        });

        it(`${shape.editNote === 'runs' ? 'edits, undoes and redoes' : 'refuses an edit of'} a column the math function does not read, in a table with ${shape.label}`, async () => {
            let modification: ModificationEntry | undefined;
            await expectOutcome(shape, shape.editNote,
                async engine => {
                    const [cell] = await engine.updateCellBatch(shape.table, [{ rowId: 1, column: 'note', value: 'edited' }]);
                    modification = {
                        description: 'Edit note', modificationType: 'cell_update', targetTable: shape.table, targetRowId: 1,
                        targetColumn: 'note', priorValue: cell.priorValue, newValue: cell.newValue,
                        priorState: cell.priorState, postState: cell.postState, operation: cell.operation
                    };
                },
                async engine => {
                    const note = async () => (await rows(engine, `SELECT note FROM ${shape.table} WHERE id = 1`))[0][0];
                    assert.equal(await note(), 'edited');
                    await engine.undoModification(modification!);
                    assert.equal(await note(), nativeRows[shape.table][0].at(-1));
                    await engine.redoModification(modification!);
                    assert.equal(await note(), 'edited');
                });
        });

        it(`${shape.editSource === 'runs' ? 'edits' : 'refuses an edit of'} the column the math function reads, in a table with ${shape.label}`, async () => {
            await expectOutcome(shape, shape.editSource,
                engine => engine.updateCell(shape.table, 1, 'x', shape.table === 'o' ? 'Changed' : 4.5),
                async engine => assert.deepEqual(await rows(engine, `SELECT x FROM ${shape.table} WHERE id = 1`), [[shape.table === 'o' ? 'Changed' : 4.5]]));
        });

        it(`${shape.deleteRow === 'runs' ? 'deletes a row of, and restores it to,' : 'refuses to delete a row of'} a table with ${shape.label}`, async () => {
            let modification: ModificationEntry | undefined;
            await expectOutcome(shape, shape.deleteRow,
                async engine => {
                    const deletedRows = await engine.deleteRows(shape.table, [1]);
                    modification = {
                        description: 'Delete row', modificationType: 'row_delete', targetTable: shape.table,
                        affectedRowIds: [1], deletedRows
                    } as ModificationEntry;
                },
                async engine => {
                    const all = nativeRows[shape.table].map(row => row[0]);
                    assert.deepEqual(await ids(engine, shape.table), all.slice(1));
                    await engine.undoModification(modification!);
                    assert.deepEqual(await ids(engine, shape.table), all);
                });
        });

        it(`${shape.deleteAll === 'runs' ? 'empties' : 'refuses to empty'} a table with ${shape.label}`, async () => {
            // Without a WHERE, SQLite clears the table and its indexes and computes no key.
            await expectOutcome(shape, shape.deleteAll,
                engine => engine.executeQuery(`DELETE FROM ${shape.table}`),
                async engine => assert.deepEqual(await ids(engine, shape.table), []));
        });
    }

    it('refuses to create or rebuild an index on a math function', async () => {
        await withWasm(async engine => {
            await assert.rejects(engine.executeQuery('CREATE INDEX o_exp ON o(exp(length(x)))'), REFUSAL.index);
            await assert.rejects(engine.executeQuery('REINDEX e_ln'), REFUSAL.index);
            assert.deepEqual((await engine.fetchSchema()).indexes.map(index => index.identifier), ['e_ln', 'f_floor', 'o_lower', 'p_part', 'vi_y']);
        });
    });

    it('cannot run integrity_check or quick_check on such a file, which open every index', async () => {
        await withWasm(async engine => {
            await assert.rejects(rows(engine, 'PRAGMA integrity_check'), REFUSAL.index);
            await assert.rejects(rows(engine, 'PRAGMA quick_check'), REFUSAL.index);
        });
    });

    it('saves the file as it was read, and the native engine reads the copy through its indexes', async () => {
        const saved = await withWasm(async engine => {
            // An edit that needs no dependent index, so the copy is not the original.
            await engine.updateCell('e', 1, 'note', 'saved from WebAssembly');
            // A key of the floor(x) index computed here must be the native one.
            await engine.executeQuery("INSERT INTO f(x, note) VALUES (12.75, 'written by WebAssembly'), (-0.5, 'negative')");
            return engine.serializeDatabase();
        });
        const directory = fs.mkdtempSync(path.resolve('.tmp/wasm-math-schema-saved-'));
        const file = path.join(directory, 'saved.db');
        fs.writeFileSync(file, saved);
        const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
        try {
            const connection = await native.establishConnection(vscode.Uri.file(file), 'saved.db', false);
            const ops = connection.databaseOps;
            assert.deepEqual((await ops.executeQuery('PRAGMA integrity_check'))[0].rows, [['ok']]);
            assert.deepEqual((await ops.executeQuery('SELECT note FROM e INDEXED BY e_ln WHERE ln(x) = ln(3)'))[0].rows, [['saved from WebAssembly']]);
            assert.deepEqual((await ops.executeQuery('SELECT id FROM vi INDEXED BY vi_y WHERE y = ln(5)'))[0].rows, [[2]]);
            assert.deepEqual(
                (await ops.executeQuery('SELECT note FROM f INDEXED BY f_floor WHERE floor(x) IN (12, -1) ORDER BY x'))[0].rows,
                [['negative'], ['written by WebAssembly']]
            );
            await connection.closeDatabase!();
        } finally {
            native.workerMethods[Symbol.dispose]();
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        }
    });
});
