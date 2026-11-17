import './vscode_mock_setup';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, isNativeAvailable, nativeGridRowPack, NativeWorkerProcess } from '../../src/nativeWorker';
import type { ExactIntegerTextMap, QueryResultSet, TableQueryOptions } from '../../src/core/types';
import {
    buildRealCorpusSql, type CorpusPage, fetchCorpusPages, SPECIAL_REALS, UTF16_PAGES, UTF8_PAGES, visitedReals
} from './helpers/real-page-corpus';

// Grid pages keep SQLite's text for a REAL only where it differs from
// String(value). Packed pages decode that text on the host, so every packed
// page must equal the unpacked path's page, and both must equal what SQLite
// itself says each REAL's text is.

const PACK = 'sqlite_explorer_cell_pack(';
// Tables whose pages start with the intrinsic rowid, so SQL can name each row.
const ROWID_TABLES: Record<string, true> = { wide: true, realistic: true, pinned: true, odd: true, ints: true, tidy: true };

let images: Promise<{ utf8: Uint8Array; utf16: Uint8Array }> | undefined;
function corpusImages() {
    images ??= (async () => {
        const { utf8, utf16 } = buildRealCorpusSql();
        const build = async (sql: string) => {
            const seed = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
            try {
                await seed.executeQuery(sql);
                return await seed.serializeDatabase();
            } finally {
                seed.shutdown();
            }
        };
        return { utf8: await build(utf8), utf16: await build(utf16) };
    })();
    return images;
}

/** SQLite's own answer: each row's REAL and unsafe INTEGER texts, by rowid and column name. */
async function sqliteTexts(engine: WasmDatabaseEngine, table: string, columns: readonly string[]) {
    const names = columns.filter(column => column !== 'rowid');
    const select = names.map(name => `typeof("${name}"), CAST("${name}" AS TEXT), "${name}"`).join(', ');
    const [result] = await engine.executeQuery(`SELECT rowid, ${select} FROM "${table}"`);
    const byRowId = new Map<number, Map<string, string>>();
    for (const row of result.rows) {
        const texts = new Map<string, string>();
        names.forEach((name, index) => {
            const [type, text, value] = row.slice(1 + index * 3, 4 + index * 3);
            if (type === 'real' && text !== String(value)) texts.set(name, text as string);
            if (type === 'integer' && !Number.isSafeInteger(Number(text))) texts.set(name, text as string);
        });
        byRowId.set(Number(row[0]), texts);
    }
    return byRowId;
}

async function assertSqliteTexts(oracle: WasmDatabaseEngine, pages: readonly CorpusPage[], results: Map<string, QueryResultSet>, engineName: string) {
    const cache = new Map<string, Map<number, Map<string, string>>>();
    for (const page of pages) {
        const result = results.get(page.label)!;
        const columns = page.options(results)!.columns!;
        if (!ROWID_TABLES[page.table] || columns[0] !== 'rowid') continue;
        if (!cache.has(page.table)) cache.set(page.table, await sqliteTexts(oracle, page.table, columns));
        const byRowId = cache.get(page.table)!;
        let expected: ExactIntegerTextMap | undefined;
        result.rows.forEach((row, rowIndex) => {
            const texts = byRowId.get(row[0] as number);
            assert.ok(texts, `${engineName}, ${page.label}: row ${rowIndex} has no SQLite row`);
            columns.forEach((column, columnIndex) => {
                const text = texts.get(column);
                if (columnIndex > 0 && text !== undefined) ((expected ??= {})[rowIndex] ??= {})[columnIndex] = text;
            });
        });
        assert.deepStrictEqual(result.exactIntegerTexts, expected, `${engineName}, ${page.label}: exact texts differ from SQLite's`);
    }
}

function assertCoverage(results: Iterable<QueryResultSet>, engineName: string) {
    const pages = [...results];
    const visited = visitedReals(pages);
    // Counted over the cells the pages returned, not over the database.
    assert.ok(visited.values.size >= 48000, `${engineName}: only ${visited.values.size} distinct REALs visited`);
    assert.ok(visited.withText >= 140000 && visited.withoutText >= 75000,
        `${engineName}: ${visited.withText} REAL cells kept text, ${visited.withoutText} did not`);
    const view = new DataView(new ArrayBuffer(8));
    for (const special of SPECIAL_REALS) {
        view.setFloat64(0, special);
        assert.ok(visited.values.has(view.getBigUint64(0).toString(16)), `${engineName}: ${Object.is(special, -0) ? '-0' : special} never visited`);
    }
    const tidy = pages.find((_, index) => UTF8_PAGES[index]?.table === 'tidy');
    assert.ok(tidy && tidy.rows.length === 40 && tidy.exactIntegerTexts === undefined, `${engineName}: every REAL of tidy is its own text`);
    const ceiling = pages[UTF8_PAGES.findIndex(page => page.table === 'ceiling')];
    // No sidecar at the width ceiling: no REAL text, as the helper path.
    for (const row of Object.values(ceiling.exactIntegerTexts ?? {})) {
        for (const text of Object.values(row)) assert.match(text, /^-?\d+$/, `${engineName}: REAL text at the width ceiling`);
    }
}

describe('REAL text on grid pages', () => {
    it('on WebAssembly: packed pages equal the helper path and SQLite\'s texts', async () => {
        const { utf8, utf16 } = await corpusImages();
        const oracle = (await createDatabaseEngine({ content: utf8, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        const wrappedPages: QueryResultSet[] = [];
        try {
            for (const [image, pages, packs] of [[utf8, UTF8_PAGES, true], [utf16, UTF16_PAGES, false]] as const) {
                const engine = (await createDatabaseEngine({ content: image, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
                const instance = (engine as any).instance;
                const prepare = instance.prepare.bind(instance);
                const statements: string[] = [];
                instance.prepare = (sql: string, ...rest: unknown[]) => { statements.push(sql); return prepare(sql, ...rest); };
                try {
                    const byMode: Record<string, Map<string, QueryResultSet>> = {};
                    for (const mode of ['off', 'wrapped', 'direct'] as const) {
                        engine.gridRowPackTransport = mode;
                        byMode[mode] = await fetchCorpusPages(async (table, options) => {
                            statements.length = 0;
                            const page = await engine.fetchTableData(table, options);
                            const packed = statements.some(sql => sql.includes(PACK) && !sql.startsWith('EXPLAIN'));
                            assert.equal(packed, mode !== 'off' && packs, `${mode}: ${table} ${packed ? 'packed' : 'did not pack'}`);
                            assert.ok(page.rows.length > 0, `${mode}: ${table} returned no rows`);
                            return page;
                        }, pages);
                    }
                    for (const page of pages) {
                        assert.deepStrictEqual(byMode.wrapped.get(page.label), byMode.off.get(page.label), `wrapped: ${page.label}`);
                        assert.deepStrictEqual(byMode.direct.get(page.label), byMode.off.get(page.label), `direct: ${page.label}`);
                    }
                    if (packs) await assertSqliteTexts(oracle, pages, byMode.wrapped, 'WebAssembly');
                    wrappedPages.push(...byMode.wrapped.values());
                } finally {
                    engine.gridRowPackTransport = 'wrapped';
                    engine.shutdown();
                }
            }
        } finally {
            oracle.shutdown();
        }
        assertCoverage(wrappedPages, 'WebAssembly');
    });

    const nativeCalls: string[] = [];
    const originalCall = NativeWorkerProcess.prototype.call;
    (NativeWorkerProcess.prototype as any).call = function (method: string, ...rest: unknown[]) {
        nativeCalls.push(method);
        return (originalCall as any).call(this, method, ...rest);
    };
    after(() => { NativeWorkerProcess.prototype.call = originalCall; });

    it('on the native engine: packed pages equal queryNumeric and SQLite\'s texts', async (context) => {
        if (!await isNativeAvailable(process.cwd())) {
            if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
            return context.skip('Bundled native runtime unavailable');
        }
        const { utf8, utf16 } = await corpusImages();
        const oracle = (await createDatabaseEngine({ content: utf8, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/grid-real-text-'));
        const packedPages: QueryResultSet[] = [];
        try {
            for (const [name, image, pages] of [['utf8', utf8, UTF8_PAGES], ['utf16', utf16, UTF16_PAGES]] as const) {
                const file = path.join(directory, `${name}.db`);
                fs.writeFileSync(file, image);
                const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
                try {
                    const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), `grid-real-text-${name}`, false);
                    const byMode: Record<string, Map<string, QueryResultSet>> = {};
                    for (const enabled of [false, true]) {
                        nativeGridRowPack.enabled = enabled;
                        byMode[String(enabled)] = await fetchCorpusPages(async (table, options) => {
                            nativeCalls.length = 0;
                            const page = await databaseOps.fetchTableData!(table, options);
                            const read = nativeCalls.includes('queryPacked')
                                ? (nativeCalls.includes('queryNumeric') ? 'packed, then queryNumeric' : 'packed')
                                : 'queryNumeric';
                            // The host reads a page with non-plain TEXT again unpacked; UTF-16 never packs.
                            const expected = !enabled || name === 'utf16' ? 'queryNumeric'
                                : table === 'odd' ? 'packed, then queryNumeric' : 'packed';
                            assert.equal(read, expected, `${enabled ? 'packed' : 'unpacked'}: ${table}`);
                            assert.ok(page.rows.length > 0, `${table} returned no rows`);
                            return page;
                        }, pages);
                    }
                    for (const page of pages) {
                        assert.deepStrictEqual(byMode.true.get(page.label), byMode.false.get(page.label), `packed: ${page.label}`);
                    }
                    if (name === 'utf8') await assertSqliteTexts(oracle, pages, byMode.true, 'native');
                    packedPages.push(...byMode.true.values());
                } finally {
                    nativeGridRowPack.enabled = true;
                    native.workerMethods[Symbol.dispose]();
                }
            }
        } finally {
            oracle.shutdown();
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
        assertCoverage(packedPages, 'native');
    });
});
