import '../unit/vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, isNativeAvailable } from '../../src/nativeWorker';
import { runReadSnapshot } from '../../src/core/operation-serializer';
import { importRowsAtomically } from '../../src/core/bulk-import';
import type { CellValue, DatabaseOperations, ModificationEntry, RecordId } from '../../src/core/types';

// Differential fuzz of the history-tracked mutation API: the same inserts,
// batch edits, key edits, JSON patches, deletes, imports, undos and redos run
// on in-memory and paged WebAssembly and on the native engine in lockstep. After every step both
// must have succeeded or both failed, and every cell must have the same
// storage class and stored bytes. A successful undo must also restore the
// exact contents from before its entry, and a redo those after it, which
// catches a bug both engines share. Seeded so a failure reproduces. Opt-in
// (`npm run test:history-fuzz`); .github/workflows/native-fuzz.yml runs it on
// every bundled target.
//
// FUZZ_SEEDS / FUZZ_STEPS: databases and steps per database. FUZZ_SEED: first
// seed. FUZZ_EXPECT_TARGET: fail unless the native runtime is present.
//
// -0 is left out of the values: the native engine keeps it a REAL -0.0 so
// cell history round-trips it, where sql.js binds INTEGER 0 (bindableParams in
// natives/native-worker.js).
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 300);
const STEPS = Number(process.env.FUZZ_STEPS ?? 40);
const FIRST_SEED = Number(process.env.FUZZ_SEED ?? 1);
// Generator health, not engine judgement: each table kind's operations must
// succeed often enough to exercise the paths behind them, and draw most of
// the value pool. At the default counts the rarest pair (a key edit or JSON
// patch on one kind) measures well over 50 successes.
const OK_FLOOR = SEEDS >= 100 ? 10 : 0;
const VALUE_SHARE_FLOOR = SEEDS >= 100 ? 0.9 : 0;

// mulberry32: exact 32-bit arithmetic through Math.imul, full period.
function generator(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const VALUES: ReadonlyArray<readonly [string, () => CellValue]> = [
    ['int0', () => 0], ['int1', () => 1], ['int-1', () => -1], ['int7', () => 7],
    ['int32max', () => 2147483647], ['int32min', () => -2147483648], ['int32over', () => 2147483648],
    ['int3e9', () => 3000000000], ['safemax', () => Number.MAX_SAFE_INTEGER], ['safemin', () => -Number.MAX_SAFE_INTEGER],
    ['big2^53+1', () => 9007199254740993n], ['bigmin', () => -9223372036854775808n], ['bigmax', () => 9223372036854775807n],
    ['big5', () => 5n], ['big-5', () => -5n], ['big3e9', () => 3000000000n],
    ['half', () => 0.5], ['-2.25', () => -2.25], ['third', () => 1 / 3], ['1e300', () => 1e300], ['-1e-300', () => -1e-300],
    ['0.1+0.2', () => 0.1 + 0.2], ['1e16', () => 1e16], ['2^63', () => 2 ** 63],
    ['empty', () => ''], ['a', () => 'a'], ['A', () => 'A'], ['unicode', () => 'ünï'], ['emoji', () => '😀'],
    ['long', () => 'x'.repeat(300)], ['text12', () => '12'], ['text3.5', () => '3.5'], ['spaced7', () => ' 7 '],
    ['hex', () => '0x10'], ['nul', () => 'a\u0000b'], ['lone-surrogate', () => '\ud800x'], ['crlf', () => 'a\r\nb'],
    ['json', () => '{"a":1}'], ['json-nested', () => '{"a":{"x":1},"b":[1]}'], ['json-array', () => '[1,2]'],
    ['blob0', () => new Uint8Array([])], ['blob2', () => new Uint8Array([0, 255])], ['blob-digits', () => new Uint8Array([49, 50])],
    ['null', () => null]
];
// SQL literals for stored values no bound parameter produces: integral and
// negative-zero REALs, large integers next to fractional ones, TEXT that is
// not plain UTF-8. The literal step writes them outside history, so history
// meets them only as prior states.
const LITERALS: ReadonlyArray<readonly [string, string]> = [
    ['real5', '5.0'], ['real100', '100.0'], ['real-0', '-0.0'], ['big', '9007199254740993'], ['int3e9', '3000000000'],
    ['msTimestamp', '1730000000000'], ['int-2^31-1', '-2147483649'], ['invalidUtf8', "CAST(X'FF61' AS TEXT)"],
    ['bom', "CAST(X'EFBBBF61' AS TEXT)"], ['surrogate', 'char(55296)'], ['nul', "'a' || char(0) || 'b'"],
    ['lead', "CAST(X'C0' AS TEXT)"], ['1e300', '1e300'], ['blob', "X'00'"], ['text12', "'12'"], ['null', 'NULL']
];
const PATCHES: ReadonlyArray<readonly [string, string]> = [
    ['set', '{"b":2}'], ['remove', '{"a":null}'], ['nested', '{"a":{"y":2}}'], ['array', '{"c":[1,2]}'], ['malformed', 'not json']
];
const KINDS = ['alias', 'plain', 'withoutRowid', 'textKey'] as const;
type Kind = typeof KINDS[number];
const TYPES = ['', 'INTEGER', 'REAL', 'TEXT', 'NUMERIC', 'BLOB', 'INT', 'VARCHAR(10)', 'DOUBLE', 'BOOLEAN'];
const COLUMNS = ['c0', 'c1', 'c2', 'c3'];
const OPERATIONS = ['insert', 'insert', 'literal', 'batch', 'batch', 'keyEdit', 'patch', 'delete', 'import', 'undo', 'undo', 'redo'] as const;
// In-memory WebAssembly is the reference; the paged engine reads its file
// page by page with a writable overlay, as large files open.
const ENGINES = ['wasm', 'paged', 'native'] as const;
type Engine = typeof ENGINES[number];
type Outcome = { ok: true } | { ok: false; error: string };

const orderColumn = (kind: Kind) => (kind === 'textKey' ? 'k' : 'id');

function tableSql(kind: Kind, random: () => number): string {
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    const check = random() < 0.3 ? ' CHECK (c0 IS NULL OR length(c0) < 200)' : '';
    const unique = random() < 0.4 ? ' UNIQUE' : '';
    const notNull = random() < 0.3 ? " NOT NULL DEFAULT 'd'" : '';
    const columns = `c0 ${pick(TYPES)}${check}, c1 ${pick(TYPES)}${unique}, c2 ${pick(TYPES)}${notNull}, c3 ${pick(TYPES)}`;
    switch (kind) {
        case 'alias': return `CREATE TABLE t (id INTEGER PRIMARY KEY, ${columns})`;
        case 'plain': return `CREATE TABLE t (id INT, ${columns})`;
        case 'withoutRowid': return `CREATE TABLE t (id INTEGER PRIMARY KEY, ${columns}) WITHOUT ROWID`;
        case 'textKey': return `CREATE TABLE t (k TEXT PRIMARY KEY, id INTEGER, ${columns}) WITHOUT ROWID`;
    }
}

/** Storage class and stored bytes of every cell, rows in key order. */
async function contents(ops: DatabaseOperations, kind: Kind): Promise<string> {
    const cells = ['id', ...COLUMNS, ...(kind === 'textKey' ? ['k'] : [])];
    // Native executeQuery keys row values by column name, so each is aliased.
    const projection = cells.map((column, index) => (
        `typeof("${column}") AS t${index}, CASE WHEN typeof("${column}") = 'text' ` +
        `THEN 'x' || hex(CAST("${column}" AS BLOB)) ELSE quote("${column}") END AS v${index}`
    )).join(', ');
    const order = kind === 'plain' ? 'rowid' : orderColumn(kind);
    return JSON.stringify((await ops.executeQuery(`SELECT ${projection} FROM t ORDER BY ${order}`))[0]?.rows ?? []);
}

/** Each engine's own record identity per row, in key order. */
async function identities(ops: DatabaseOperations, kind: Kind): Promise<RecordId[]> {
    const page = await ops.fetchTableData!('t', {
        columns: ['rowid', 'id'], limit: 100000, offset: 0, filters: [],
        orderBy: kind === 'plain' ? 'rowid' : orderColumn(kind), orderDir: 'ASC'
    } as never);
    return page.rows.map(row => row[0] as RecordId);
}

/** A WebAssembly engine on a file past the paged threshold, holding the table. */
async function openPaged(ddl: string, file: string): Promise<WasmDatabaseEngine> {
    const seedEngine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    try {
        await seedEngine.executeQuery(ddl);
        await seedEngine.executeQuery('CREATE TABLE pad (b BLOB); INSERT INTO pad VALUES (zeroblob(16384))');
        fs.writeFileSync(file, await seedEngine.serializeDatabase());
    } finally {
        seedEngine.shutdown();
    }
    const opened = await createDatabaseEngine({
        content: null, filePath: file, maxSize: 0, pagedOpenThresholdBytes: 4096, allowPagedFallback: true, readOnlyMode: false
    });
    assert.equal(opened.storage, 'paged');
    return opened.operations as WasmDatabaseEngine;
}

const attempt = async (work: () => Promise<unknown>): Promise<Outcome> => {
    try {
        await work();
        return { ok: true };
    } catch (error) {
        return { ok: false, error: (error as Error).message.slice(0, 200) };
    }
};

it('keeps in-memory, paged and native history-tracked mutations identical', async (context) => {
    const expectedTarget = process.env.FUZZ_EXPECT_TARGET;
    if (!await isNativeAvailable(process.cwd())) {
        if (expectedTarget) throw new Error(`Missing native runtime for ${expectedTarget}`);
        return context.skip('Bundled native runtime unavailable');
    }
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/engine-history-fuzz-'));
    const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
    const successes = new Map<string, number>();
    const values = new Map<Kind, Set<string>>(KINDS.map(kind => [kind, new Set()]));
    let steps = 0;
    try {
        for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) {
            const random = generator(seed);
            const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
            const kind = KINDS[seed % KINDS.length];
            const file = path.join(directory, `seed-${seed}.db`);
            fs.closeSync(fs.openSync(file, 'w'));
            const ddl = tableSql(kind, random);
            // One database in seven stores TEXT as UTF-16LE.
            const encoding = seed % 7 === 0 ? "PRAGMA encoding = 'UTF-16le'; " : '';
            const { databaseOps: nativeOps } = await native.establishConnection(vscode.Uri.file(file), `seed-${seed}`, false);
            const wasm = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
            const paged = await openPaged(encoding + ddl, path.join(directory, `seed-${seed}-paged.db`));
            const engines: Record<Engine, DatabaseOperations> = { wasm, paged, native: nativeOps };
            try {
                for (const engine of ['wasm', 'native'] as const) await engines[engine].executeQuery(encoding + ddl);
                for (const engine of ENGINES) {
                    const actual = (await engines[engine].executeQuery('PRAGMA encoding'))[0]?.rows[0]?.[0];
                    assert.equal(actual, encoding ? 'UTF-16le' : 'UTF-8', `${engine} encoding`);
                }
                const history: Record<Engine, ModificationEntry[]> = { wasm: [], paged: [], native: [] };
                // Contents around each entry, for the undo and redo oracle.
                const around = new WeakMap<ModificationEntry, { before: string; after?: string }>();
                let current = await contents(wasm, kind);
                const pending: ModificationEntry[] = [];
                const redo: Record<Engine, ModificationEntry[]> = { wasm: [], paged: [], native: [] };
                const log = [encoding + ddl];
                let nextId = 1;
                for (let step = 0; step < STEPS; step++) {
                    const rows = {} as Record<Engine, RecordId[]>;
                    for (const engine of ENGINES) rows[engine] = await identities(engines[engine], kind);
                    for (const engine of ENGINES) assert.equal(rows[engine].length, rows.wasm.length);
                    const operation = pick(OPERATIONS);
                    const value = () => {
                        const [name, make] = pick(VALUES);
                        values.get(kind)!.add(name);
                        return { name, value: make() };
                    };
                    const newRow = () => {
                        const data: Record<string, CellValue> = {};
                        const names: string[] = [];
                        const id = random() < 0.2 && nextId > 1 ? 1 + Math.floor(random() * (nextId - 1)) : nextId++;
                        if (kind === 'withoutRowid' || kind === 'textKey' || random() < 0.7) { data.id = id; names.push(`id=${id}`); }
                        if (kind === 'textKey') { data.k = `k${id}`; names.push(`k=k${id}`); }
                        for (const column of COLUMNS) {
                            if (random() < 0.7) { const drawn = value(); data[column] = drawn.value; names.push(`${column}=${drawn.name}`); }
                        }
                        return { data, names };
                    };
                    const record = (engine: Engine, entry: ModificationEntry) => {
                        history[engine].push(entry);
                        redo[engine].length = 0;
                        around.set(entry, { before: current });
                        pending.push(entry);
                    };
                    let replayed: { entry: ModificationEntry; operation: 'undo' | 'redo' } | undefined;
                    const outcomes = {} as Record<Engine, Outcome>;
                    let description: string = operation;
                    if (operation === 'literal') {
                        const columns: string[] = [];
                        const literals: string[] = [];
                        const id = nextId++;
                        if (kind !== 'alias' || random() < 0.7) { columns.push('id'); literals.push(String(id)); }
                        if (kind === 'textKey') { columns.push('k'); literals.push(`'k${id}'`); }
                        for (const column of COLUMNS) {
                            if (random() < 0.8) {
                                const [name, literal] = pick(LITERALS);
                                values.get(kind)!.add(`literal:${name}`);
                                columns.push(column); literals.push(literal); description += ` ${column}=${name}`;
                            }
                        }
                        const sql = columns.length > 0
                            ? `INSERT INTO t (${columns.join(', ')}) VALUES (${literals.join(', ')})`
                            : 'INSERT INTO t DEFAULT VALUES';
                        for (const engine of ENGINES) {
                            outcomes[engine] = await attempt(async () => {
                                await engines[engine].executeQuery(sql);
                                // Outside history: later entries start from here.
                                history[engine].length = 0;
                                redo[engine].length = 0;
                            });
                        }
                    } else if (operation === 'insert') {
                        const { data, names } = newRow();
                        description += ` ${names.join(' ')}`;
                        for (const engine of ENGINES) {
                            outcomes[engine] = await attempt(async () => {
                                const insertedRow = await engines[engine].insertRowWithHistory!('t', { ...data });
                                record(engine, {
                                    modificationType: 'row_insert', targetTable: 't', targetRowId: insertedRow.rowId,
                                    description: 'Insert', rowData: insertedRow.row, insertedRow
                                });
                            });
                        }
                    } else if ((operation === 'batch' || operation === 'keyEdit' || operation === 'patch') && rows.wasm.length > 0) {
                        const edits: Array<{ index: number; column: string; value: CellValue; operation?: 'json_patch' }> = [];
                        const used = new Set<string>();
                        for (let count = 1 + Math.floor(random() * 4); count > 0; count--) {
                            const index = Math.floor(random() * rows.wasm.length);
                            const column = operation === 'keyEdit'
                                ? (kind === 'textKey' ? pick(['k', 'id']) : 'id')
                                : pick(COLUMNS);
                            if (used.has(`${index}/${column}`)) continue;
                            used.add(`${index}/${column}`);
                            if (operation === 'patch') {
                                const [name, patch] = pick(PATCHES);
                                edits.push({ index, column, value: patch, operation: 'json_patch' });
                                description += ` ${index}.${column}+=${name}`;
                            } else if (operation === 'keyEdit') {
                                const key = column === 'k' ? `k${nextId++}` : random() < 0.3 ? 1 + Math.floor(random() * nextId) : nextId++;
                                edits.push({ index, column, value: key });
                                description += ` ${index}.${column}=${key}`;
                            } else {
                                const drawn = value();
                                edits.push({ index, column, value: drawn.value });
                                description += ` ${index}.${column}=${drawn.name}`;
                            }
                        }
                        for (const engine of ENGINES) {
                            outcomes[engine] = await attempt(async () => {
                                const affectedCells = await engines[engine].updateCellBatch('t', edits.map(edit => ({
                                    rowId: rows[engine][edit.index], column: edit.column, value: edit.value,
                                    ...(edit.operation ? { operation: edit.operation } : {})
                                })));
                                record(engine, { modificationType: 'cell_update', targetTable: 't', description: 'Edit', affectedCells });
                            });
                        }
                    } else if (operation === 'delete' && rows.wasm.length > 0) {
                        const victims = rows.wasm.map((_, index) => index).filter(() => random() < 0.3);
                        if (victims.length === 0) victims.push(Math.floor(random() * rows.wasm.length));
                        description += ` ${victims.join(',')}`;
                        for (const engine of ENGINES) {
                            outcomes[engine] = await attempt(async () => {
                                const deletedRows = await engines[engine].deleteRows('t', victims.map(index => rows[engine][index]));
                                record(engine, { modificationType: 'row_delete', targetTable: 't', description: 'Delete', deletedRows });
                            });
                        }
                    } else if (operation === 'import') {
                        const batch = Array.from({ length: 1 + Math.floor(random() * 3) }, newRow);
                        description += ` ${batch.map(row => row.names.join(' ')).join(' | ')}`;
                        for (const engine of ENGINES) {
                            outcomes[engine] = await attempt(async () => {
                                record(engine, await runReadSnapshot(engines[engine], tx => importRowsAtomically(
                                    tx, 't', batch.map(row => ({ ...row.data })), 64 * 1024 * 1024
                                )) as ModificationEntry);
                            });
                        }
                    } else if (operation === 'undo' || operation === 'redo') {
                        for (const engine of ENGINES) {
                            const from = operation === 'undo' ? history[engine] : redo[engine];
                            const to = operation === 'undo' ? redo[engine] : history[engine];
                            const entry = from[from.length - 1];
                            if (!entry) { outcomes[engine] = { ok: true }; continue; }
                            description = `${operation} ${entry.modificationType}`;
                            outcomes[engine] = await attempt(async () => {
                                await (operation === 'undo' ? engines[engine].undoModification(entry) : engines[engine].redoModification(entry));
                                from.pop();
                                to.push(entry);
                                if (engine === 'wasm') replayed = { entry, operation };
                            });
                        }
                    } else {
                        continue;
                    }
                    steps++;
                    const status = (outcome: Outcome) => (outcome.ok ? 'ok' : `failed: ${outcome.error}`);
                    log.push(`${step}: ${description} -> ${ENGINES.map(engine => `${engine} ${status(outcomes[engine])}`).join('; ')}`);
                    if (outcomes.wasm.ok) successes.set(`${kind}:${operation}`, (successes.get(`${kind}:${operation}`) ?? 0) + 1);
                    const wasmCells = await contents(wasm, kind);
                    const trail = () => `seed ${seed} (${kind}) step ${step}\n  ${log.join('\n  ')}\n  contents before the step: ${current}`;
                    for (const engine of ENGINES) {
                        assert.equal(outcomes[engine].ok, outcomes.wasm.ok, `${engine} outcome differs\n${trail()}`);
                        assert.equal(await contents(engines[engine], kind), wasmCells, `${engine} cells differ\n${trail()}`);
                    }
                    for (const entry of pending.splice(0)) {
                        const snapshot = around.get(entry);
                        if (snapshot && history.wasm.includes(entry)) snapshot.after = wasmCells;
                    }
                    // Only history writes here, and literal steps restart it, so a
                    // replay can fail on a constraint mid-batch but never conflict.
                    if ((operation === 'undo' || operation === 'redo') && !outcomes.wasm.ok) {
                        assert.match(outcomes.wasm.error, /constraint failed/, `${operation} failed\n${trail()}`);
                    }
                    if (replayed && outcomes.wasm.ok) {
                        const snapshot = around.get(replayed.entry);
                        const expected = replayed.operation === 'undo' ? snapshot?.before : snapshot?.after;
                        assert.ok(expected !== undefined, `no recorded contents for the ${replayed.operation}\n${trail()}`);
                        assert.equal(wasmCells, expected, `${replayed.operation} did not restore the contents\n${trail()}`);
                    }
                    current = wasmCells;
                }
            } finally {
                wasm.shutdown();
                paged.shutdown();
            }
        }
    } finally {
        native.workerMethods[Symbol.dispose]();
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    for (const kind of KINDS) {
        for (const operation of new Set(OPERATIONS)) {
            const count = successes.get(`${kind}:${operation}`) ?? 0;
            assert.ok(count >= OK_FLOOR, `${kind} ${operation} succeeded ${count} times, under the floor of ${OK_FLOOR}`);
        }
        const share = values.get(kind)!.size / VALUES.length;
        assert.ok(share >= VALUE_SHARE_FLOOR, `${kind} drew ${(share * 100).toFixed(0)}% of the values`);
    }
    console.log(`[history fuzz] ${SEEDS} databases, ${steps} steps, all ${ENGINES.length} engines identical`);
});
