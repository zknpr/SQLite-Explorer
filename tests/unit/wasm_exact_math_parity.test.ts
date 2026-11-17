import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations } from '../../src/core/types';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';

/**
 * Some of SQLite's math functions cannot round differently between two math
 * libraries: IEEE 754 fixes the result of ceil, floor, trunc, fmod and sqrt
 * to the last bit, sign() and pi() compute nothing, and radians() and
 * degrees() are one multiplication by a constant. This file checks that
 * claim, bit for bit, between the WebAssembly engine and the bundled native
 * engine of the platform it runs on, over random doubles. The other math
 * functions do differ in the last digit (wasm_rtree_math_functions.test.ts).
 */

const UNARY = ['ceil', 'ceiling', 'floor', 'trunc', 'sqrt', 'sign', 'radians', 'degrees'];
const VALUES_PER_FUNCTION = 6000;
const PAIRS = 12000;
const BATCH = 400;

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

/** xorshift32 on integers: a float generator's cycle once hid most of a fuzz run. */
function generator(seed: number): () => number {
    let state = seed | 0 || 1;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
}

const SPECIAL = [0, -0, 0.5, -0.5, 1, -1, 2 ** 52, 2 ** 53, -(2 ** 53), 2 ** 63, 1e308, -1e308, 5e-324, 2.2250738585072014e-308];

/** The special values once, then finite doubles of every magnitude, with whole numbers, halves and values near them. */
function randomDoubles(count: number, seed: number): number[] {
    const next = generator(seed);
    const view = new DataView(new ArrayBuffer(8));
    const values: number[] = [...SPECIAL];
    while (values.length < count) {
        const kind = next() % 7;
        let value: number;
        if (kind < 4) {
            view.setUint32(0, next());
            view.setUint32(4, next());
            value = view.getFloat64(0);
        } else if (kind === 4) {
            value = (next() - 0x80000000) / 2;
        } else if (kind === 5) {
            value = (next() % 2000001 - 1000000) + (next() % 3 - 1) * Number.EPSILON * (next() % 1024);
        } else {
            value = (next() - 0x80000000) * 2 ** ((next() % 120) - 60);
        }
        if (Number.isFinite(value)) values.push(value);
    }
    return values;
}

/** A literal SQLite reads back as exactly this double; -0 needs its sign spelled. */
const literal = (value: number) => Object.is(value, -0) ? '-0.0' : value.toExponential(17);

async function evaluate(ops: DatabaseOperations, expressions: string[]): Promise<string[]> {
    const results: string[] = [];
    for (let offset = 0; offset < expressions.length; offset += BATCH) {
        const batch = expressions.slice(offset, offset + BATCH);
        const sql = batch.map(expression => `SELECT typeof(${expression}) || ' ' || quote(${expression})`).join(' UNION ALL ');
        const rows = (await ops.executeQuery(sql))[0]?.rows ?? [];
        assert.equal(rows.length, batch.length);
        for (const row of rows) results.push(String(row[0]));
    }
    return results;
}

describe('math functions that cannot round differently', { skip }, () => {
    it('give the native engine\'s result, bit for bit, over random doubles', async () => {
        const expressions: string[] = ['pi()'];
        UNARY.forEach((name, index) => {
            for (const value of randomDoubles(VALUES_PER_FUNCTION, 0x9e3779b9 + index)) expressions.push(`${name}(${literal(value)})`);
        });
        const left = randomDoubles(PAIRS, 0x85ebca6b);
        const right = randomDoubles(PAIRS, 0xc2b2ae35);
        for (let index = 0; index < PAIRS; index++) expressions.push(`mod(${literal(left[index])}, ${literal(right[index])})`);
        // A generator that repeats itself would pass as coverage.
        assert.ok(new Set(expressions).size * 100 >= expressions.length * 98, `${new Set(expressions).size} distinct of ${expressions.length}`);

        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        let wasm: string[];
        try {
            wasm = await evaluate(engine, expressions);
        } finally {
            engine.shutdown();
        }

        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/exact-math-'));
        const file = path.join(directory, 'empty.db');
        fs.closeSync(fs.openSync(file, 'w'));
        const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
        let nativeResults: string[];
        try {
            const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'exact-math', false);
            nativeResults = await evaluate(databaseOps, expressions);
        } finally {
            native.workerMethods[Symbol.dispose]();
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        }

        const differences = expressions
            .map((expression, index) => wasm[index] === nativeResults[index] ? undefined
                : `${expression}: ${wasm[index]}, native ${nativeResults[index]}`)
            .filter((entry): entry is string => entry !== undefined);
        assert.deepEqual(differences.slice(0, 20), [], `${differences.length} of ${expressions.length} results differ`);
        // The inputs must reach the functions as REAL values with results of every kind.
        assert.ok(wasm.some(result => result.startsWith('real ')) && wasm.some(result => result.startsWith('integer ')));
        assert.ok(wasm.filter(result => result === 'null NULL').length < expressions.length / 4);
    });
});
