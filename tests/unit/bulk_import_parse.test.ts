/**
 * The pure half of src/core/bulk-import.ts — parsing, mapping and the shared
 * limits — as the desktop viewer uses it (import-data.js parses in the page).
 * The engine-side tests (importRowsAtomically against the extension's two
 * engines) live with the extension's controller upstream; the desktop's engine
 * path is the worker's `importRows`, tested through the worker harness in
 * web_demo_worker.test.ts.
 */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
    IMPORT_MAX_BYTES,
    IMPORT_MAX_CELLS,
    IMPORT_MAX_COLUMNS,
    IMPORT_MAX_ROWS,
    IMPORT_LIMIT_DESCRIPTION,
    mapImportRows,
    parseImport
} from '../../src/core/bulk-import';

it('parses quoted CSV and maps exact text without implicit null or number conversion', () => {
    const parsed = parseImport('﻿key,note\r\n9007199254740993,"line 1\nline ""2"""\r\n2,\r\n', 'csv');
    assert.deepEqual(parsed.columns, ['key', 'note']);
    assert.deepEqual(mapImportRows(parsed, ['id', 'value']), [
        { id: '9007199254740993', value: 'line 1\nline "2"' }, { id: '2', value: '' }
    ]);
    for (const csv of ['id,id\n1,2', 'id,note\n1', 'id\n"unclosed', 'id\n"a"tail']) {
        assert.throws(() => parseImport(csv, 'csv'));
    }
});

it('rejects lossy JSON integers and nested values, and preserves omitted columns', () => {
    const parsed = parseImport('[{"id":"9007199254740993","value":null},{"id":2}]', 'json');
    assert.deepEqual(mapImportRows(parsed, ['id', 'value']), [{ id: '9007199254740993', value: null }, { id: 2 }]);
    assert.throws(() => parseImport('[{"id":9007199254740993}]', 'json'), /quoted string/);
    assert.throws(() => parseImport('[{"value":{}}]', 'json'), /scalar/);
    assert.throws(() => parseImport('[{"value":1e309}]', 'json'), /finite/);
    assert.throws(() => mapImportRows(parsed, ['id', 'id']), /more than once/);
    assert.throws(() => mapImportRows(parsed, [undefined, undefined]), /at least one/);
    assert.throws(() => mapImportRows(parsed, ['id']), /Skip/);
});

it('retains CSV empty/multiline fields and JSON defaults through partial mappings', () => {
    const parsed = parseImport('id,value,ignored\r\n1,"",x\r\n2,"a\rb\nc\r\nd",y\r\n3,last,z', 'csv');
    assert.deepEqual(mapImportRows(parsed, ['id', 'text', undefined]), [
        { id: '1', text: '' }, { id: '2', text: 'a\rb\nc\r\nd' }, { id: '3', text: 'last' }
    ]);
    const missing = parseImport('[{"keep":"value"},{"skip":1}]', 'json');
    assert.deepEqual(mapImportRows(missing, ['value', undefined]), [{ value: 'value' }, {}]);
    for (const input of ['[]', '[{}]', '[{"v":true}]', '[{"v":[]}]']) {
        assert.throws(() => parseImport(input, 'json'));
    }
});

it('states the limits the desktop dialog quotes', () => {
    assert.equal(IMPORT_MAX_BYTES, 64 * 1024 * 1024);
    assert.equal(IMPORT_MAX_ROWS, 100_000);
    assert.equal(IMPORT_MAX_COLUMNS, 256);
    assert.equal(IMPORT_MAX_CELLS, 2_000_000);
    assert.equal(IMPORT_LIMIT_DESCRIPTION, '64 MiB / 100,000 rows / 256 columns');
});

it('accepts the exact CSV/JSON row, column and UTF-8 source limits and rejects the next unit', () => {
    for (const format of ['csv', 'json'] as const) {
        const source = (count: number) => format === 'csv'
            ? 'id\n' + Array.from({ length: count }, (_, i) => String(i)).join('\n')
            : JSON.stringify(Array.from({ length: count }, (_, id) => ({ id })));
        assert.equal(parseImport(source(IMPORT_MAX_ROWS), format).rows.length, IMPORT_MAX_ROWS);
        assert.throws(() => parseImport(source(IMPORT_MAX_ROWS + 1), format), /100,000/);
        const wide = (count: number) => format === 'csv'
            ? Array.from({ length: count }, (_, i) => `c${i}`).join(',') + '\n' + Array(count).fill('x').join(',')
            : JSON.stringify([Object.fromEntries(Array.from({ length: count }, (_, i) => [`c${i}`, 'x']))]);
        assert.equal(parseImport(wide(256), format).columns.length, 256);
        assert.throws(() => parseImport(wide(257), format), /256/);
        const prefix = format === 'csv' ? 'v\n' : '[{"v":"';
        const suffix = format === 'csv' ? '' : '"}]';
        const valueBytes = IMPORT_MAX_BYTES - prefix.length - suffix.length;
        const exact = prefix + 'é'.repeat(Math.floor(valueBytes / 2)) + 'x'.repeat(valueBytes % 2) + suffix;
        assert.equal(Buffer.byteLength(exact), IMPORT_MAX_BYTES);
        assert.equal(parseImport(exact, format).rows.length, 1);
        assert.throws(() => parseImport(exact + ' ', format), /64 MiB/);
    }
});

it('bounds dense CSV/JSON sources by cell count and checks supplementary UTF-8 bytes', () => {
    const columns = Array.from({ length: 25 }, (_, index) => `c${index}`);
    const csv = columns.join(',') + '\n' + (Array(25).fill('').join(',') + '\n').repeat(80_000);
    assert.equal(parseImport(csv, 'csv').rows.length, 80_000);
    assert.throws(() => parseImport(csv + Array(25).fill('').join(','), 'csv'), /2,000,000 source cells/);
    const row = Object.fromEntries(columns.map(column => [column, '']));
    const json = JSON.stringify(Array(80_000).fill(row));
    assert.equal(parseImport(json, 'json').rows.length, 80_000);
    assert.throws(() => parseImport(json.slice(0, -1) + ',{"c0":""}]', 'json'), /2,000,000 source cells/);
    for (const source of ['["text"]', '[1]', '[null]', '[{} , []]', '[{"v":{"nested":1}}]']) assert.throws(() => parseImport(source, 'json'));
    const supplementary = 'v\n' + '😀'.repeat((IMPORT_MAX_BYTES - 4) / 4) + 'xx';
    assert.equal(Buffer.byteLength(supplementary), IMPORT_MAX_BYTES);
    assert.equal(parseImport(supplementary, 'csv').rows.length, 1);
    assert.throws(() => parseImport(supplementary + '\ud800', 'csv'), /64 MiB/);
});
