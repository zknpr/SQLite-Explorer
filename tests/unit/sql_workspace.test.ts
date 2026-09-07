/**
 * The pure SQL-workspace helpers (src/core/sql-workspace.ts), shared verbatim
 * with dev's editor-based workspace. The desktop console uses
 * parseQueryParameters (its parameter field), queryPlanRequest/decodeQueryPlan
 * (the WASM worker's bounded query-plan reader path) and resultCsv (Export
 * CSV of a result set). The engine-driven halves live in
 * web_demo_worker.test.ts against the real worker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    decodeQueryPlan,
    parseQueryParameters,
    prepareReadQuery,
    queryPlanRequest,
    resultCsv,
    SQL_RESULT_BYTES,
    SQL_RESULT_ROWS
} from '../../src/core/sql-workspace';

test('parseQueryParameters binds typed parameters without rounding integers', () => {
    assert.deepEqual(parseQueryParameters('[null,"text",1,1.5]'), [null, 'text', 1, 1.5]);
    assert.throws(() => parseQueryParameters('[9007199254740993]'), /safe integer/);
    assert.throws(() => parseQueryParameters('[true]'), /null, string/);
    assert.throws(() => parseQueryParameters('{"a":1}'), /JSON array/);
    assert.throws(() => parseQueryParameters(`[${Array.from({ length: 101 }, () => '1').join(',')}]`), /at most 100/);
    assert.throws(() => parseQueryParameters('[' + '"x",'.repeat(20_000) + '"x"]'), /65,536 characters/);
});

test('prepareReadQuery counts positional parameters and refuses named ones', () => {
    assert.equal(prepareReadQuery("SELECT '?' AS literal, ?1 AS value; -- end").parameterCount, 1);
    assert.equal(prepareReadQuery('SELECT account$id FROM accounts').parameterCount, 0);
    assert.equal(prepareReadQuery('SELECT ?, ?, ?3').parameterCount, 3);
    for (const token of [':1', '@1', '$1', ':é']) {
        assert.throws(() => prepareReadQuery(`SELECT ${token}`), /Named parameters/);
    }
    assert.throws(() => prepareReadQuery('SELECT 1; SELECT 2'), /Exactly one read query/);
});

test('queryPlanRequest binds the SQL text as the first value and every parameter after it', () => {
    const request = queryPlanRequest('SELECT ? AS v, ? AS w', ['a', 2]);
    assert.equal(request.sql, 'SELECT sqlite_explorer_query_plan(?, ?, ?) AS plan');
    assert.deepEqual(request.params, ['SELECT ? AS v, ? AS w', 'a', 2]);
    assert.equal(queryPlanRequest('SELECT 1', []).sql, 'SELECT sqlite_explorer_query_plan(?) AS plan');
});

test('decodeQueryPlan accepts only the reader\'s exact row shape', () => {
    const plan = decodeQueryPlan('[[2,0,0,"SCAN t"],[3,2,0,"USE TEMP B-TREE FOR ORDER BY"]]');
    assert.deepEqual(plan.headers, ['id', 'parent', 'notused', 'detail']);
    assert.deepEqual(plan.rows, [[2, 0, 0, 'SCAN t'], [3, 2, 0, 'USE TEMP B-TREE FOR ORDER BY']]);
    assert.deepEqual(decodeQueryPlan('[]').rows, []);

    for (const bad of [
        null, 42, '{}', '[1]', '[[1,2,3]]', '[[1,2,3,4]]', '[["1",2,3,"d"]]', '[[1.5,2,3,"d"]]',
        'x'.repeat(SQL_RESULT_BYTES + 1),
        JSON.stringify(Array.from({ length: SQL_RESULT_ROWS + 2 }, () => [1, 0, 0, 'd']))
    ]) {
        assert.throws(() => decodeQueryPlan(bad as never), /invalid query plan/, String(bad).slice(0, 40));
    }
    // Exactly the reader's row ceiling (1000 displayed + 1 lookahead) is fine.
    assert.equal(
        decodeQueryPlan(JSON.stringify(Array.from({ length: SQL_RESULT_ROWS + 1 }, () => [1, 0, 0, 'd']))).rows.length,
        SQL_RESULT_ROWS + 1
    );
});

test('resultCsv uses the spreadsheet text policy while preserving negative numeric values', () => {
    // dev's own pin: a formula-shaped TEXT gets the leading apostrophe, a
    // negative NUMBER does not.
    assert.equal(resultCsv({ headers: ['+column'], rows: [['-draft'], [-12]] }), '"\'+column"\r\n"\'-draft"\r\n"-12"');
});

test('resultCsv spells NULL and blobs the way the result documents do, and escapes quotes', () => {
    const csv = resultCsv({
        headers: ['id', 'note', 'data'],
        rows: [[1, 'say "hi"', new Uint8Array([0x00, 0xff])], [2, null, null]]
    });
    assert.equal(csv, '"id","note","data"\r\n"1","say ""hi""","0x00ff"\r\n"2","NULL","NULL"');
});

test('resultCsv caps at the read-query budget by default and at the caller\'s count when told', () => {
    const rows = Array.from({ length: SQL_RESULT_ROWS + 250 }, (_, i) => [i]);
    const lines = (csv: string) => csv.split('\r\n').length - 1; // minus the header

    assert.equal(lines(resultCsv({ headers: ['n'], rows })), SQL_RESULT_ROWS);
    // The console exports what it displays: its worker cap is larger than the
    // workspace's, so it passes the set's own length.
    assert.equal(lines(resultCsv({ headers: ['n'], rows }, rows.length)), rows.length);
    assert.equal(lines(resultCsv({ headers: ['n'], rows }, 3)), 3);
});
