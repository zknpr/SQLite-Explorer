import { createHash } from 'node:crypto';
import type { QueryResultSet, TableQueryOptions } from '../../../src/core/types';

// A deterministic corpus of grid pages built around REAL values: SQLite's
// text for a REAL (3.54.1: 15 significant digits when they read back, else
// 17; always a decimal point; -0.0 as "0.0") and JavaScript's String(value)
// agree for some values and differ for others, and every page must carry
// exactly the texts that differ.

/** xorshift32; never returns 0 for a nonzero seed. */
export function xorshift32(seed: number): () => number {
    let state = seed | 0 || 0x9e3779b9;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
}

export const SPECIAL_REALS = [
    0, -0, 1, -1, 2, 3, 0.1, 0.2, 0.3, 0.1 + 0.2, 1 / 3, 2 / 3, 0.5, 1.5, 4.35, 2.675, 1.005, 100, 1e15, 1e16,
    1e20, 1e21, 1e22, 1e100, 1e-4, 1e-5, 1e-6, 1e-7, 1e-300, 5e-324, 2.2250738585072014e-308,
    1.7976931348623157e308, -1.7976931348623157e308, Infinity, -Infinity, 123456789012345.6,
    999999999999999.9, 999999999999999, 9007199254740992, 9007199254740994, 123456789012345680,
    0.123456789012345, 0.1234567890123456, 0.12345678901234568, -2.5e-308, 1234567.890123, 1e15 + 0.5
];

/** SQL literal SQLite parses to the double, or the nearest one. */
export function realLiteral(value: number): string {
    if (value === Infinity) return '1e999';
    if (value === -Infinity) return '-1e999';
    if (Object.is(value, -0)) return '-0.0';
    const text = String(value);
    // A literal without '.' or 'e' would be an INTEGER.
    return /[.e]/.test(text) ? text : `${text}.0`;
}

/** One generated REAL: random bit patterns, k-digit decimals, integral values. */
export function nextReal(next: () => number): number {
    const kind = next() % 8;
    if (kind === 0) return SPECIAL_REALS[next() % SPECIAL_REALS.length];
    if (kind <= 2) {
        // A random finite bit pattern: subnormals to the largest exponents.
        const view = new DataView(new ArrayBuffer(8));
        for (;;) {
            view.setUint32(0, next());
            view.setUint32(4, Math.imul(next(), 0x2545f491) >>> 0);
            const value = view.getFloat64(0);
            if (Number.isFinite(value)) return value;
        }
    }
    if (kind <= 5) {
        // 1 to 17 significant digits at a decimal exponent from -12 to 24.
        const digits = 1 + next() % 17;
        let mantissa = String(1 + next() % 9);
        while (mantissa.length < digits) mantissa += String(next() % 10);
        const exponent = (next() % 37) - 12 - digits;
        const value = Number(`${next() % 2 ? '-' : ''}${mantissa}e${exponent}`);
        return value;
    }
    // Integral values, small to past 2^53 and past SQLite's 15-digit switch.
    const magnitude = 10 ** (next() % 23);
    return Math.floor(((next() / 0x100000000) + (Math.imul(next(), 7) >>> 0) / 2 ** 64) * magnitude) * (next() % 5 ? 1 : -1);
}

const PLAIN_WORDS = ['', 'a', 'plain', 'é', '😀 x', '3.0', '1e21', '-0.0', 'Inf', 'NULL', 'x|y:z', "it''s"];

/** One cell literal of any storage class, REAL most often. */
function nextCell(next: () => number, realShare: number, nonPlainText: boolean): string {
    const pick = next() % 100;
    if (pick < realShare) return realLiteral(nextReal(next));
    const rest = pick - realShare;
    const slot = rest % 5;
    if (slot === 0) return 'NULL';
    if (slot === 1) {
        const integers = ['0', '-1', '9007199254740991', '9007199254740993', '9223372036854775807',
            '(-9223372036854775807 - 1)', '-9007199254740993'];
        if (next() % 3 === 0) return integers[next() % integers.length];
        const high = BigInt(next() >>> (1 + next() % 31));
        return String((high << 32n) + BigInt(next()) * (next() % 2 ? 1n : -1n));
    }
    if (slot === 2) {
        if (nonPlainText && next() % 3 === 0) return "CAST(x'ff41' AS TEXT)";
        return `'${PLAIN_WORDS[next() % PLAIN_WORDS.length]}${next() % 1000}'`;
    }
    if (slot === 3) return `x'${(next() >>> 0).toString(16).padStart(8, '0').slice(0, (next() % 4) * 2)}'`;
    return realLiteral(nextReal(next));
}

function insertRows(table: string, rowCount: number, width: number, next: () => number,
    leading: (row: number) => string[], realShare: number, nonPlainText = false): string[] {
    const statements: string[] = [];
    for (let row = 0; row < rowCount; row++) {
        const cells = [...leading(row)];
        for (let column = 0; column < width; column++) cells.push(nextCell(next, realShare, nonPlainText));
        statements.push(`INSERT INTO ${table} VALUES (${cells.join(', ')})`);
    }
    return statements;
}

export const WIDE_COLUMNS = Array.from({ length: 230 }, (_, index) => `c${index}`);
const PLAIN_COLUMNS = Array.from({ length: 12 }, (_, index) => `d${index}`);
const KEYED_COLUMNS = Array.from({ length: 40 }, (_, index) => `v${index}`);
// 997 values: every raw-TEXT slot and no room for the REAL text sidecar, so
// a page of this view carries no REAL text on any path.
const CEILING_COLUMNS = Array.from({ length: 997 }, (_, index) => `x${index}`);

/** Statements of the UTF-8 corpus database, then those of the UTF-16 one. */
export function buildRealCorpusSql(): { utf8: string; utf16: string } {
    const next = xorshift32(0x5eed2026);
    const specials = WIDE_COLUMNS.map((_, index) => realLiteral(SPECIAL_REALS[index % SPECIAL_REALS.length]));
    const utf8 = [
        // 231 values and the rowid: three pack chunks per row.
        `CREATE TABLE wide (id INTEGER PRIMARY KEY, ${WIDE_COLUMNS.join(', ')})`,
        // Every special value at least once, whatever the generator draws.
        `INSERT INTO wide VALUES (0, ${specials.join(', ')})`,
        ...insertRows('wide', 300, WIDE_COLUMNS.length, next, row => [String(row * 3 + 1)], 70),
        'CREATE INDEX wide_c1 ON wide (c1)',
        `CREATE VIEW ceiling AS SELECT ${CEILING_COLUMNS.map((name, index) => `${WIDE_COLUMNS[index % WIDE_COLUMNS.length]} AS ${name}`).join(', ')} FROM wide`,
        // No REAL at all, and REALs that are all their own String(value).
        'CREATE TABLE ints (id INTEGER PRIMARY KEY, a INTEGER, b TEXT, c BLOB)',
        ...Array.from({ length: 40 }, (_, row) => `INSERT INTO ints VALUES (${row + 1}, ` +
            `${row % 3 ? String(next()) : '9007199254740993'}, 'text ${next() % 100}', x'${(next() >>> 0).toString(16).padStart(8, '0')}')`),
        'CREATE TABLE tidy (id INTEGER PRIMARY KEY, p REAL, q REAL, r)',
        ...Array.from({ length: 40 }, (_, row) => `INSERT INTO tidy VALUES (${row + 1}, ${next() % 10000}.${1 + next() % 99}, ` +
            `0.${1 + next() % 999}, -${next() % 100}.5)`),
        `CREATE TABLE realistic (id INTEGER PRIMARY KEY, name TEXT, city TEXT, note TEXT, qty INTEGER, ` +
            'big INTEGER, price REAL, ratio REAL, lat REAL, lon REAL)',
        ...Array.from({ length: 200 }, (_, row) => `INSERT INTO realistic VALUES (${row + 1}, 'n${next() % 50}', ` +
            `'city ${next() % 9}', ${next() % 4 ? `'note ${next()}'` : 'NULL'}, ${next() % 1000}, ` +
            `${next() % 2 ? '9007199254740993' : String(next())}, ${(next() % 100000) / 100}, ` +
            `${realLiteral(nextReal(next))}, ${(next() % 18000000) / 100000 - 90}, ${realLiteral(nextReal(next))})`),
        // A declared rowid INTEGER PRIMARY KEY is the intrinsic rowid.
        'CREATE TABLE pinned (rowid INTEGER PRIMARY KEY, r REAL, x, y)',
        ...insertRows('pinned', 80, 3, next, row => [String(row * 7 + 2)], 80),
        // A REAL column named rowid shadows the intrinsic one.
        'CREATE TABLE shadow (rowid REAL, a, b, c)',
        ...insertRows('shadow', 80, 3, next, () => [realLiteral(nextReal(next))], 75),
        // REAL in a composite primary key.
        `CREATE TABLE keyed (k REAL NOT NULL, j INTEGER NOT NULL, ${KEYED_COLUMNS.join(', ')}, PRIMARY KEY (k, j)) WITHOUT ROWID`,
        ...Array.from({ length: 120 }, (_, row) => `INSERT INTO keyed VALUES (${realLiteral(nextReal(next))}, ${row}, ` +
            `${Array.from({ length: KEYED_COLUMNS.length }, () => nextCell(next, 70, false)).join(', ')})`),
        // Non-plain TEXT: the native engine reads such a page again unpacked.
        `CREATE TABLE odd (id INTEGER PRIMARY KEY, ${PLAIN_COLUMNS.join(', ')})`,
        ...insertRows('odd', 60, PLAIN_COLUMNS.length, next, row => [String(row + 1)], 60, true),
        `CREATE VIEW wide_view AS SELECT ${WIDE_COLUMNS.slice(0, 150).join(', ')} FROM wide`
    ].join(';\n');
    const utf16 = [
        "PRAGMA encoding = 'UTF-16le'",
        `CREATE TABLE sixteen (id INTEGER PRIMARY KEY, ${PLAIN_COLUMNS.join(', ')})`,
        ...insertRows('sixteen', 120, PLAIN_COLUMNS.length, next, row => [String(row + 1)], 70)
    ].join(';\n');
    return { utf8, utf16 };
}

export interface CorpusPage {
    label: string;
    table: string;
    /** Undefined when the page it chains from minted no anchor. */
    options: (earlier: ReadonlyMap<string, QueryResultSet>) => TableQueryOptions | undefined;
}

const fixed = (options: TableQueryOptions) => () => options;
const anchored = (from: string, end: 'first' | 'last', mode: 'after' | 'before' | 'atOrAfter', base: TableQueryOptions) =>
    (earlier: ReadonlyMap<string, QueryResultSet>) => {
        const anchor = earlier.get(from)?.keysetAnchors?.[end];
        return anchor ? { ...base, keyset: { mode, anchor } } : undefined;
    };

const wideBase: TableQueryOptions = { columns: ['rowid', 'id', ...WIDE_COLUMNS], limit: 100, offset: 0 };
const realisticBase: TableQueryOptions = {
    columns: ['rowid', 'id', 'name', 'city', 'note', 'qty', 'big', 'price', 'ratio', 'lat', 'lon'], limit: 200, offset: 0
};
const keyedBase: TableQueryOptions = { columns: ['rowid', 'k', 'j', ...KEYED_COLUMNS], limit: 40, offset: 0 };
const sixteenBase: TableQueryOptions = { columns: ['rowid', 'id', ...PLAIN_COLUMNS], limit: 50, offset: 0 };

// Together the pages of each table visit every one of its rows.
export const UTF8_PAGES: CorpusPage[] = [
    { label: 'wide: first page', table: 'wide', options: fixed(wideBase) },
    { label: 'wide: offset page', table: 'wide', options: fixed({ ...wideBase, offset: 150 }) },
    { label: 'wide: keyset first', table: 'wide', options: fixed({ ...wideBase, keyset: { mode: 'first' } }) },
    { label: 'wide: keyset after', table: 'wide', options: anchored('wide: keyset first', 'last', 'after', wideBase) },
    { label: 'wide: keyset before', table: 'wide', options: anchored('wide: keyset after', 'first', 'before', wideBase) },
    { label: 'wide: keyset last', table: 'wide', options: fixed({ ...wideBase, keyset: { mode: 'last', lastPageRowCount: 60 } }) },
    { label: 'wide: sorted by a REAL-heavy column', table: 'wide', options: fixed({ ...wideBase, orderBy: 'c0', orderDir: 'DESC' }) },
    { label: 'wide: sorted keyset first', table: 'wide', options: fixed({ ...wideBase, orderBy: 'c1', keyset: { mode: 'first' } }) },
    { label: 'wide: sorted keyset before', table: 'wide',
        options: anchored('wide: sorted keyset first', 'last', 'before', { ...wideBase, orderBy: 'c1' }) },
    { label: 'wide: global filter', table: 'wide',
        options: fixed({ ...wideBase, globalFilter: '5e', globalFilterColumns: WIDE_COLUMNS }) },
    { label: 'wide: column filter', table: 'wide', options: fixed({ ...wideBase, filters: [{ column: 'c2', value: '.' }] }) },
    { label: 'wide: exhausted page budget', table: 'wide', options: fixed({ ...wideBase, maxPageResponseBytes: 2000 }) },
    { label: 'wide view', table: 'wide_view', options: fixed({ columns: WIDE_COLUMNS.slice(0, 150), limit: 60, offset: 20 }) },
    { label: 'view at the width ceiling', table: 'ceiling', options: fixed({ columns: CEILING_COLUMNS, limit: 12, offset: 0 }) },
    { label: 'realistic: first page', table: 'realistic', options: fixed(realisticBase) },
    { label: 'realistic: sorted by price', table: 'realistic', options: fixed({ ...realisticBase, orderBy: 'price' }) },
    { label: 'pinned rowid: first page', table: 'pinned', options: fixed({ columns: ['rowid', 'r', 'x', 'y'], limit: 80, offset: 0 }) },
    { label: 'shadowed rowid: first page', table: 'shadow', options: fixed({ columns: ['rowid', 'a', 'b', 'c'], limit: 80, offset: 0 }) },
    { label: 'without rowid: keyset first', table: 'keyed', options: fixed({ ...keyedBase, keyset: { mode: 'first' } }) },
    { label: 'without rowid: keyset after', table: 'keyed',
        options: anchored('without rowid: keyset first', 'last', 'after', keyedBase) },
    { label: 'without rowid: keyset before', table: 'keyed',
        options: anchored('without rowid: keyset after', 'first', 'before', keyedBase) },
    { label: 'without rowid: keyset last', table: 'keyed', options: fixed({ ...keyedBase, keyset: { mode: 'last', lastPageRowCount: 40 } }) },
    { label: 'non-plain TEXT: first page', table: 'odd', options: fixed({ columns: ['rowid', 'id', ...PLAIN_COLUMNS], limit: 60, offset: 0 }) },
    { label: 'no REAL: first page', table: 'ints', options: fixed({ columns: ['rowid', 'id', 'a', 'b', 'c'], limit: 40, offset: 0 }) },
    { label: 'REALs that are their own text', table: 'tidy', options: fixed({ columns: ['rowid', 'id', 'p', 'q', 'r'], limit: 40, offset: 0 }) }
];

export const UTF16_PAGES: CorpusPage[] = [
    { label: 'UTF-16: first page', table: 'sixteen', options: fixed(sixteenBase) },
    { label: 'UTF-16: keyset first', table: 'sixteen', options: fixed({ ...sixteenBase, keyset: { mode: 'first' } }) },
    { label: 'UTF-16: keyset after', table: 'sixteen', options: anchored('UTF-16: keyset first', 'last', 'after', sixteenBase) },
    { label: 'UTF-16: keyset before', table: 'sixteen', options: anchored('UTF-16: keyset after', 'first', 'before', sixteenBase) },
    { label: 'UTF-16: keyset last', table: 'sixteen', options: fixed({ ...sixteenBase, keyset: { mode: 'last', lastPageRowCount: 20 } }) }
];

/**
 * REAL cells of fetched pages, by f64 bit pattern. An INTEGER arrives as a
 * safe integer without exact text or, past 2^53, with a text of digits; a
 * REAL's text always has '.', 'e' or "Inf" ("3.0", "1.0e+21"), and a REAL
 * without one is not a safe integer ("2.45e+21" is its own text).
 */
export function visitedReals(pages: Iterable<QueryResultSet>): { values: Map<string, number>; withText: number; withoutText: number } {
    const values = new Map<string, number>();
    const view = new DataView(new ArrayBuffer(8));
    let withText = 0;
    let withoutText = 0;
    for (const page of pages) {
        page.rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
            if (typeof value !== 'number') return;
            const text = page.exactIntegerTexts?.[rowIndex]?.[columnIndex];
            if (text === undefined ? Number.isSafeInteger(value) : /^-?\d+$/.test(text)) return;
            view.setFloat64(0, value);
            values.set(view.getBigUint64(0).toString(16), value);
            if (text === undefined) withoutText++;
            else withText++;
        }));
    }
    return { values, withText, withoutText };
}

/**
 * JSON of a page that keeps what JSON.stringify drops or merges: BigInt,
 * bytes, -0, non-finite numbers and properties present as undefined.
 * Property order is kept.
 */
export function canonicalPage(page: unknown): string {
    return JSON.stringify(page, (_key, value) => {
        if (typeof value === 'bigint') return { $bigint: value.toString() };
        if (value instanceof Uint8Array) return { $bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex') };
        if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) {
            return { $number: Object.is(value, -0) ? '-0' : String(value) };
        }
        if (value === undefined) return { $undefined: true };
        return value;
    });
}

export function pageDigest(page: unknown): string {
    return createHash('sha256').update(canonicalPage(page)).digest('hex').slice(0, 24);
}

/** Fetch every page in order, each chained page from the ones before it. */
export async function fetchCorpusPages(
    fetch: (table: string, options: TableQueryOptions) => Promise<QueryResultSet>,
    pages: readonly CorpusPage[]
): Promise<Map<string, QueryResultSet>> {
    const results = new Map<string, QueryResultSet>();
    for (const page of pages) {
        const options = page.options(results);
        if (!options) throw new Error(`${page.label}: the page it chains from minted no anchor`);
        results.set(page.label, await fetch(page.table, structuredClone(options)));
    }
    return results;
}
