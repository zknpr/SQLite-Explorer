import '../unit/vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, isNativeAvailable } from '../../src/nativeWorker';
import { HostBridge } from '../../src/hostBridge';
import type { CellValue, DatabaseOperations, ModificationEntry, RecordId } from '../../src/core/types';

// Differential fuzz of column history: columns are added and dropped, rows
// inserted and edited, and every entry undone and redone, through HostBridge
// on WebAssembly and on the native engine in lockstep. Both engines must agree
// on each step's outcome and on the schema and every cell's storage class and
// bytes; a successful undo must restore the exact contents from before its
// entry and a redo those after it. Values include SQL literals no bound
// parameter produces. Opt-in (`npm run test:history-fuzz`);
// .github/workflows/native-fuzz.yml runs it on every bundled target.
//
// FUZZ_SEEDS / FUZZ_STEPS: databases and steps per database. FUZZ_SEED: first
// seed. FUZZ_EXPECT_TARGET: fail unless the native runtime is present.
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 120);
const STEPS = Number(process.env.FUZZ_STEPS ?? 30);
const FIRST_SEED = Number(process.env.FUZZ_SEED ?? 1);
// Generator health: each operation must succeed often enough to matter.
const OK_FLOOR = SEEDS >= 60 ? 10 : 0;

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
    ['int', () => 7], ['int3e9', () => 3000000000], ['big', () => 9007199254740993n], ['big3e9', () => 3000000000n],
    ['real', () => 1 / 3], ['text', () => 'héllo'], ['numtext', () => '12'], ['empty', () => ''],
    ['nul', () => 'a\u0000b'], ['blob', () => new Uint8Array([0, 255])], ['null', () => null]
];
const LITERALS = [
    '5.0', '-0.0', '3000000000', '9007199254740993', "CAST(X'FF61' AS TEXT)", "CAST(X'EFBBBF61' AS TEXT)",
    'char(55296)', "'a' || char(0) || 'b'", "X'00'", 'NULL', '1e300'
];
const NEW_COLUMNS = ['n1', 'N2', 'with space', 'ünï', 'x"q', 'select'];
const TYPES = ['', 'TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC', 'VARCHAR(5)'];
const DEFAULTS: ReadonlyArray<string | undefined> = [undefined, "'dflt'", '0', 'NULL', '1.5', "X'00FF'", '-7', "'it''s'"];
const OPERATIONS = ['insert', 'literal', 'edit', 'addColumn', 'addColumn', 'dropColumn', 'dropColumn', 'undo', 'undo', 'redo'] as const;
const KINDS = ['alias', 'plain', 'withoutRowid', 'textKey'] as const;
type Kind = typeof KINDS[number];
type Engine = 'wasm' | 'native';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const keyColumns = (kind: Kind) => (kind === 'textKey' ? ['k', 'id'] : ['id']);

function tableSql(kind: Kind): string {
    switch (kind) {
        case 'alias': return 'CREATE TABLE t (id INTEGER PRIMARY KEY, a, b TEXT, c INTEGER)';
        case 'plain': return 'CREATE TABLE t (id INT, a, b TEXT, c INTEGER)';
        case 'withoutRowid': return 'CREATE TABLE t (id INTEGER PRIMARY KEY, a, b TEXT, c INTEGER) WITHOUT ROWID';
        case 'textKey': return 'CREATE TABLE t (k TEXT PRIMARY KEY, id INTEGER, a, b TEXT, c INTEGER) WITHOUT ROWID';
    }
}

async function columnsOf(ops: DatabaseOperations): Promise<string[]> {
    return ((await ops.executeQuery("SELECT name AS name FROM pragma_table_info('t') ORDER BY cid"))[0]?.rows ?? [])
        .map(row => String(row[0]));
}

/** Schema, then every cell's storage class and stored bytes in key order. */
async function contents(ops: DatabaseOperations, kind: Kind): Promise<string> {
    const info = (await ops.executeQuery(
        "SELECT cid AS c, name AS n, type AS t, \"notnull\" AS nn, dflt_value AS d, pk AS p FROM pragma_table_info('t') ORDER BY cid"
    ))[0]?.rows ?? [];
    const ddl = (await ops.executeQuery("SELECT sql AS s FROM sqlite_schema WHERE name = 't'"))[0]?.rows ?? [];
    const projection = info.map((row, index) => {
        const column = quote(String(row[1]));
        return `typeof(${column}) AS t${index}, CASE WHEN typeof(${column}) = 'text' ` +
            `THEN 'x' || hex(CAST(${column} AS BLOB)) ELSE quote(${column}) END AS v${index}`;
    }).join(', ');
    const order = kind === 'plain' || kind === 'alias' ? 'rowid' : quote(keyColumns(kind)[0]);
    const cells = (await ops.executeQuery(`SELECT ${projection} FROM t ORDER BY ${order}`))[0]?.rows ?? [];
    return JSON.stringify({ info, ddl, cells });
}

function bridgeFor(ops: DatabaseOperations) {
    const recorded: ModificationEntry[] = [];
    const document = {
        uri: vscode.Uri.file('/fuzz/fuzz.db'), isConnected: true, fileParts: { filename: 'fuzz.db' },
        isReadOnlyMode: false, connectionGeneration: 1, databaseOperations: ops, undoMemoryLimitBytes: 64 * 1024 * 1024,
        recordExternalModification: (modification: ModificationEntry) => { recorded.push(modification); }
    };
    return { bridge: new HostBridge({ webviews: new Map(), context: {}, isReadOnly: false } as never, document as never), recorded };
}

it('keeps WebAssembly and native column history identical and exact', async (context) => {
    if (!await isNativeAvailable(process.cwd())) {
        if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
        return context.skip('Bundled native runtime unavailable');
    }
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/engine-column-history-fuzz-'));
    const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
    const successes = new Map<string, number>();
    let steps = 0;
    try {
        for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) {
            const random = generator(seed);
            const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
            const kind = KINDS[seed % KINDS.length];
            const file = path.join(directory, `seed-${seed}.db`);
            fs.closeSync(fs.openSync(file, 'w'));
            const { databaseOps: nativeOps } = await native.establishConnection(vscode.Uri.file(file), `seed-${seed}`, false);
            const wasm = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
            const engines: Record<Engine, DatabaseOperations> = { wasm, native: nativeOps };
            const bridges = { wasm: bridgeFor(wasm), native: bridgeFor(nativeOps) };
            try {
                const ddl = tableSql(kind);
                for (const ops of Object.values(engines)) await ops.executeQuery(ddl);
                const undone: Record<Engine, ModificationEntry[]> = { wasm: [], native: [] };
                const around = new WeakMap<ModificationEntry, { before: string; after?: string }>();
                let current = await contents(wasm, kind);
                const log = [ddl];
                let nextId = 1;
                for (let step = 0; step < STEPS; step++) {
                    const columns = await columnsOf(wasm);
                    const editable = columns.filter(column => !keyColumns(kind).includes(column) || kind === 'plain');
                    const page = async (engine: Engine) => (await engines[engine].fetchTableData!('t', {
                        columns: ['rowid', ...columns], limit: 1000, offset: 0, filters: []
                    } as never)).rows.map(row => row[0] as RecordId);
                    const rows: Record<Engine, RecordId[]> = { wasm: await page('wasm'), native: await page('native') };
                    const operation = pick(OPERATIONS);
                    let description: string = operation;
                    const outcomes = {} as Record<Engine, { ok: boolean; error?: string }>;
                    let replayed: { entry: ModificationEntry; operation: 'undo' | 'redo' } | undefined;
                    const before = { wasm: bridges.wasm.recorded.length, native: bridges.native.recorded.length };
                    const runBoth = async (work: (engine: Engine) => Promise<unknown>) => {
                        for (const engine of ['wasm', 'native'] as const) {
                            try {
                                await work(engine);
                                outcomes[engine] = { ok: true };
                            } catch (error) {
                                outcomes[engine] = { ok: false, error: (error as Error).message.slice(0, 200) };
                            }
                        }
                    };
                    const keyValues = () => {
                        const id = nextId++;
                        const data: Record<string, CellValue> = {};
                        if (kind !== 'alias' || random() < 0.7) data.id = id;
                        if (kind === 'textKey') data.k = `k${id}`;
                        return data;
                    };
                    if (operation === 'insert') {
                        const data = keyValues();
                        for (const column of editable.filter(c => c !== 'id' || kind === 'plain')) {
                            if (random() < 0.6) { const [name, make] = pick(VALUES); data[column] = make(); description += ` ${column}=${name}`; }
                        }
                        await runBoth(engine => bridges[engine].bridge.insertRow('t', { ...data }));
                    } else if (operation === 'literal') {
                        const data = keyValues();
                        const names = Object.keys(data);
                        const literals = names.map(name => (typeof data[name] === 'string' ? `'${data[name]}'` : String(data[name])));
                        for (const column of editable.filter(c => !names.includes(c))) {
                            if (random() < 0.7) { const literal = pick(LITERALS); names.push(column); literals.push(literal); description += ` ${column}=${literal}`; }
                        }
                        const sql = `INSERT INTO t (${names.map(quote).join(', ')}) VALUES (${literals.join(', ')})`;
                        await runBoth(async engine => {
                            await engines[engine].executeQuery(sql);
                            // Outside history: later entries start from here.
                            bridges[engine].recorded.length = 0;
                            undone[engine].length = 0;
                        });
                    } else if (operation === 'edit' && rows.wasm.length > 0 && editable.length > 0) {
                        const edits: Array<{ index: number; column: string; value: CellValue }> = [];
                        for (let count = 1 + Math.floor(random() * 3); count > 0; count--) {
                            const index = Math.floor(random() * rows.wasm.length);
                            const column = pick(editable);
                            if (edits.some(edit => edit.index === index && edit.column === column)) continue;
                            const [name, make] = pick(VALUES);
                            edits.push({ index, column, value: make() });
                            description += ` ${index}.${column}=${name}`;
                        }
                        await runBoth(engine => bridges[engine].bridge.updateCellBatch('t', edits.map(edit => ({
                            rowId: rows[engine][edit.index], column: edit.column, value: edit.value
                        })), 'Edit'));
                    } else if (operation === 'addColumn') {
                        const name = NEW_COLUMNS.find(column => !columns.includes(column) && random() < 0.5) ?? `extra${step}`;
                        const type = pick(TYPES);
                        const defaultValue = pick(DEFAULTS);
                        description += ` ${JSON.stringify(name)} ${type} default ${defaultValue}`;
                        await runBoth(engine => bridges[engine].bridge.addColumn('t', name, type, defaultValue));
                    } else if (operation === 'dropColumn' && columns.length > 1) {
                        const column = pick(columns);
                        description += ` ${JSON.stringify(column)}`;
                        await runBoth(engine => bridges[engine].bridge.deleteColumns('t', [column]));
                    } else if (operation === 'undo' || operation === 'redo') {
                        await runBoth(async engine => {
                            const recorded = bridges[engine].recorded;
                            const from = operation === 'undo' ? recorded : undone[engine];
                            const to = operation === 'undo' ? undone[engine] : recorded;
                            const entry = from[from.length - 1];
                            if (!entry) return;
                            description = `${operation} ${entry.modificationType}`;
                            await (operation === 'undo' ? engines[engine].undoModification(entry) : engines[engine].redoModification(entry));
                            from.pop();
                            to.push(entry);
                            if (engine === 'wasm') replayed = { entry, operation };
                        });
                    } else {
                        continue;
                    }
                    // A new entry clears what was undone; record its surrounding contents.
                    for (const engine of ['wasm', 'native'] as const) {
                        if (bridges[engine].recorded.length > before[engine] && operation !== 'redo') {
                            undone[engine].length = 0;
                            if (engine === 'wasm') around.set(bridges.wasm.recorded[bridges.wasm.recorded.length - 1], { before: current });
                        }
                    }
                    steps++;
                    const status = (outcome: { ok: boolean; error?: string }) => (outcome.ok ? 'ok' : `failed: ${outcome.error}`);
                    log.push(`${step}: ${description} -> wasm ${status(outcomes.wasm)}; native ${status(outcomes.native)}`);
                    if (outcomes.wasm.ok) successes.set(operation, (successes.get(operation) ?? 0) + 1);
                    const [wasmContents, nativeContents] = [await contents(wasm, kind), await contents(nativeOps, kind)];
                    const trail = () => `seed ${seed} (${kind}) step ${step}\n  ${log.join('\n  ')}\n  contents before the step: ${current}`;
                    assert.equal(outcomes.native.ok, outcomes.wasm.ok, `outcomes differ\n${trail()}`);
                    assert.equal(nativeContents, wasmContents, `contents differ\n${trail()}`);
                    // Only history writes the table between literal steps, so a
                    // replay may fail on a constraint but never conflict.
                    if ((operation === 'undo' || operation === 'redo') && !outcomes.wasm.ok) {
                        assert.match(outcomes.wasm.error ?? '', /constraint failed/, `${operation} failed\n${trail()}`);
                    }
                    const latest = bridges.wasm.recorded[bridges.wasm.recorded.length - 1];
                    const latestSnapshot = latest && around.get(latest);
                    if (latestSnapshot && latestSnapshot.after === undefined && operation !== 'undo' && operation !== 'redo') {
                        latestSnapshot.after = wasmContents;
                    }
                    if (replayed && outcomes.native.ok) {
                        const snapshot = around.get(replayed.entry);
                        const expected = replayed.operation === 'undo' ? snapshot?.before : snapshot?.after;
                        assert.ok(expected !== undefined, `no recorded contents for the ${replayed.operation}\n${trail()}`);
                        assert.equal(wasmContents, expected, `${replayed.operation} did not restore the contents\n${trail()}`);
                    }
                    current = wasmContents;
                }
            } finally {
                wasm.shutdown();
            }
        }
    } finally {
        native.workerMethods[Symbol.dispose]();
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    for (const operation of new Set(OPERATIONS)) {
        const count = successes.get(operation) ?? 0;
        assert.ok(count >= OK_FLOOR, `${operation} succeeded ${count} times, under the floor of ${OK_FLOOR}`);
    }
    console.log(`[column history fuzz] ${SEEDS} databases, ${steps} steps, both engines identical`);
});
