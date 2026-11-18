import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { realTextIsOwn } from '../../src/core/cell-pack';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { nextReal, xorshift32 } from './helpers/real-page-corpus';

// realTextIsOwn decides "these bytes are String(value)" without formatting
// value. Wherever it decides (1 or 0) it must agree with String(value), for
// any text, not only the texts SQLite writes.

const view = new DataView(new ArrayBuffer(8));
/** The double `steps` representable values above value (below when negative). */
function adjacent(value: number, steps: number): number {
    view.setFloat64(0, value);
    const bits = view.getBigInt64(0);
    // Doubles of one sign are ordered as their bit patterns.
    view.setBigInt64(0, value < 0 || Object.is(value, -0) ? bits - BigInt(steps) : bits + BigInt(steps));
    return view.getFloat64(0);
}

/** Without trailing fraction zeros, as "1.5e+3" or "2" or "2.0". */
function stripped(text: string): string[] {
    const [mantissa, exponent] = text.split('e');
    if (!mantissa.includes('.')) return [text];
    const trimmed = mantissa.replace(/0+$/, '');
    const forms = trimmed.endsWith('.') ? [trimmed.slice(0, -1), `${trimmed}0`] : [trimmed];
    return forms.map(form => (exponent === undefined ? form : `${form}e${exponent}`));
}

function bumpLastDigit(text: string, delta: number): string | undefined {
    const last = text.charCodeAt(text.length - 1) - 0x30 + delta;
    return last >= 0 && last <= 9 ? text.slice(0, -1) + String(last) : undefined;
}

function candidateTexts(value: number): string[] {
    const own = String(value);
    const texts = new Set([own, String(-value), `0${own}`, `${own}0`, `${own}.0`, `-${own}`, `+${own}`]);
    if (Number.isFinite(value)) {
        for (let precision = 1; precision <= 17; precision++) {
            const text = value.toPrecision(precision);
            texts.add(text);
            for (const form of stripped(text)) texts.add(form);
        }
        if (Math.abs(value) < 1e21) {
            for (let fraction = 0; fraction <= 24; fraction++) {
                const text = value.toFixed(fraction);
                texts.add(text);
                for (const form of stripped(text)) texts.add(form);
            }
        }
    }
    // One digit longer, and one unit apart in the last place.
    for (const text of [...texts]) {
        if (!/^-?\d+\.\d+$/.test(text)) continue;
        texts.add(`${text}1`);
        texts.add(`${text}9`);
        for (const delta of [-1, 1]) {
            const bumped = bumpLastDigit(text, delta);
            if (bumped) texts.add(bumped);
        }
    }
    return [...texts];
}

function testValues(): number[] {
    const next = xorshift32(0x0e7a1);
    const values = [0, -0, NaN, Infinity, -Infinity, 5e-324, 2.2250738585072014e-308, Number.MAX_VALUE, 0.1 + 0.2, 1 / 3];
    // Around powers of ten and two, and both sides of the five-zero limit.
    for (let exponent = -9; exponent <= 22; exponent++) {
        for (let digit = 1; digit <= 9; digit++) {
            const base = digit * 10 ** exponent;
            for (let steps = -2; steps <= 2; steps++) values.push(adjacent(base, steps), -adjacent(base, steps));
        }
    }
    for (let exponent = -30; exponent <= 70; exponent++) {
        for (let steps = -2; steps <= 2; steps++) values.push(adjacent(2 ** exponent, steps));
    }
    for (const text of ['0.000001', '0.0000015', '0.00000999', '0.0000001', '0.000000123', '0.00001', '0.000012345678901234']) {
        const value = Number(text);
        for (let steps = -1; steps <= 1; steps++) values.push(adjacent(value, steps));
    }
    // Decimals of 1 to 15 digits with a fraction, from 1e-6 up, then the
    // corpus generator's mix.
    for (let index = 0; index < 4000; index++) {
        const digits = 1 + next() % 15;
        let mantissa = String(1 + next() % 9);
        while (mantissa.length < digits) mantissa += String(next() % 10);
        values.push(Number(`${next() % 2 ? '-' : ''}${mantissa}e-${1 + next() % Math.min(digits + 5, 20)}`));
    }
    for (let index = 0; index < 4000; index++) values.push(nextReal(next));
    return values;
}

const encoder = new TextEncoder();
function verdictOf(text: string, value: number): number {
    const bytes = encoder.encode(text);
    return realTextIsOwn(bytes, 0, bytes.length, value);
}

describe('realTextIsOwn', () => {
    it('agrees with String(value) wherever it decides, for any text', () => {
        const counts = { own: 0, other: 0, undecided: 0 };
        for (const value of testValues()) {
            for (const text of candidateTexts(value)) {
                const verdict = verdictOf(text, value);
                if (verdict < 0) {
                    counts.undecided++;
                    continue;
                }
                assert.equal(verdict === 1, text === String(value), `${JSON.stringify(text)} for ${String(value)}`);
                if (verdict === 1) counts.own++;
                else counts.other++;
            }
        }
        // Digit text for values that have none.
        for (const value of [NaN, Infinity, -Infinity]) assert.equal(verdictOf('0.5', value), 0);
        assert.ok(counts.own > 4000 && counts.other > 100000, JSON.stringify(counts));
    });

    it('decides SQLite\'s own texts', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        const statement = (engine as any).instance.prepare('SELECT CAST(CAST(?1 AS REAL) AS TEXT), CAST(?1 AS REAL)');
        const counts = { own: 0, other: 0, undecided: 0 };
        try {
            for (const value of testValues()) {
                if (!Number.isFinite(value)) continue;
                statement.bind([value]);
                assert.ok(statement.step());
                const [text, real] = statement.get();
                statement.reset();
                const verdict = verdictOf(text, real);
                if (verdict < 0) counts.undecided++;
                else {
                    assert.equal(verdict === 1, text === String(real), `${text} for ${String(real)}`);
                    if (verdict === 1) counts.own++;
                    else counts.other++;
                }
            }
        } finally {
            statement.free();
            engine.shutdown();
        }
        // SQLite writes 15 digits when they read back and 17 otherwise, so
        // the short decimals from 1e-6 up are decided as their own text.
        assert.ok(counts.own > 3000, JSON.stringify(counts));
    });
});
