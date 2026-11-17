import type { CellValue, QueryResultSet } from './types';
import { normalizeViewSelectSql } from './view-utils';
import { buildCellContainmentQuery, decodeCellContainment } from './cell-containment';
import { buildExactNumericTextQuery, normalizeIntegerRowsForTransport, type ExactNumericTextQuery } from './integer-utils';
import { createCsvTextInspection, inspectCsvTextChunk } from './export-encoding';

export const SQL_RESULT_ROWS = 1000;
export const SQL_RESULT_BYTES = 4 * 1024 * 1024;
export const SQL_MAX_TEXT = 64 * 1024;
export const SQL_MAX_COLUMNS = 128;

const INT32_MIN = -2147483648n, INT32_MAX = 2147483647n;
const INT64_MIN = -9223372036854775808n, INT64_MAX = 9223372036854775807n;
const INT64_RANGE_ERROR = 'Integer parameters must fit in a 64-bit signed integer, from -9223372036854775808 to 9223372036854775807.';

/**
 * sql.js binds a whole number in int32 as INTEGER, any other number as REAL and
 * a BigInt as TEXT; the native worker binds numbers the same way
 * (bindableParams). So no JS value binds as an INTEGER past int32 on every
 * engine, or as a REAL with a whole value. Such a parameter is bound as text or
 * as its number and converted in SQL. The unary plus drops the CAST's
 * affinity, so the value compares as a plain ? would.
 */
function typedPlaceholder(placeholder: string, index: number, value: CellValue | undefined): string {
    if (typeof value === 'bigint' && (value < INT32_MIN || value > INT32_MAX)) return ` (+CAST(?${index} AS INTEGER))`;
    if (typeof value === 'number' && Number.isInteger(value)) return ` (+CAST(?${index} AS REAL))`;
    return placeholder;
}

/**
 * Check lexical boundaries and bindings; SQLite compiles the complete SELECT grammar.
 * With params, a bigint binds as INTEGER and a number as REAL, as SQLite types
 * the same literal (parseQueryParameters); `sql`, `sourceSql` and `params` then
 * carry the conversions, while `metadataSql` keeps the result labels unchanged.
 */
export function prepareReadQuery(input: string, params?: readonly CellValue[]) {
    if (input.length > SQL_MAX_TEXT) throw new Error('Query text exceeds 65,536 characters.');
    const body = normalizeViewSelectSql(input);
    let metadataBody = '', boundBody = '', parameterCount = 0, depth = 0;
    for (let i = 0; i < body.length;) {
        const start = i, ch = body[i];
        if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
            const end = ch === '[' ? ']' : ch;
            let closed = false;
            i++;
            while (i < body.length) {
                if (body[i++] === end) {
                    if (body[i] === end) i++; else { closed = true; break; }
                }
            }
            if (!closed) throw new Error('Unterminated SQL quote.');
        } else if (body.slice(i, i + 2) === '--') {
            while (i < body.length && body[i] !== '\n' && body[i] !== '\r') i++;
        } else if (body.slice(i, i + 2) === '/*') {
            const end = body.indexOf('*/', i + 2);
            if (end < 0) throw new Error('Unterminated SQL comment.');
            i = end + 2;
        } else if (/[A-Za-z_\u0080-\uffff]/.test(ch)) {
            i++;
            while (i < body.length && /[A-Za-z_0-9$\u0080-\uffff]/.test(body[i])) i++;
        } else if (ch === '?') {
            i++;
            while (/\d/.test(body[i] ?? '') && i < body.length) i++;
            const index = i > start + 1 ? Number(body.slice(start + 1, i)) : parameterCount + 1;
            if (!Number.isInteger(index) || index < 1 || index > 100) throw new Error('Use at most 100 positional parameters.');
            parameterCount = Math.max(parameterCount, index);
            // SQLite reads `1=?AND` and `LIMIT?` as separate tokens; NULL needs the space.
            const wordPart = /[A-Za-z0-9_$\u0080-\uffff]/;
            metadataBody += `${wordPart.test(metadataBody.slice(-1)) ? ' ' : ''}NULL${wordPart.test(body[i] ?? '') ? ' ' : ''}`;
            boundBody += typedPlaceholder(body.slice(start, i), index, params?.[index - 1]); continue;
        } else {
            if (ch === '(') depth++;
            if (ch === ')' && --depth < 0) throw new Error('Unbalanced query parentheses.');
            if (ch === ';') throw new Error('Exactly one read query is required.');
            if (ch === ':' || ch === '@' || ch === '$') {
                throw new Error('Use positional ? or ?NNN parameters. Named parameters are not supported.');
            }
            i++;
        }
        metadataBody += body.slice(start, i);
        boundBody += body.slice(start, i);
    }
    if (depth !== 0) throw new Error('Unbalanced query parentheses.');
    // Only SELECT grammar is legal inside this wrapper. A compiler boundary
    // marker must also be verified before execution to reject escaped tails.
    return {
        sourceSql: boundBody,
        sql: `SELECT * FROM (\n${boundBody}\n) LIMIT ${SQL_RESULT_ROWS + 1}`,
        metadataSql: `SELECT * FROM (\n${metadataBody}\n) LIMIT 0`,
        parameterCount,
        params: (params ?? []).map(value => {
            if (typeof value !== 'bigint') return value;
            if (value < INT64_MIN || value > INT64_MAX) throw new Error(INT64_RANGE_ERROR);
            return value < INT32_MIN || value > INT32_MAX ? value.toString() : Number(value);
        })
    };
}

export function queryPlanRequest(sql: string, params: CellValue[]) {
    return {
        sql: `SELECT sqlite_explorer_query_plan(${Array(params.length + 1).fill('?').join(', ')}) AS plan`,
        params: [sql, ...params]
    };
}

export function decodeQueryPlan(value: CellValue): QueryResultSet {
    if (typeof value !== 'string' || value.length > SQL_RESULT_BYTES) throw new Error('SQLite returned an invalid query plan.');
    const rows: unknown = JSON.parse(value);
    if (!Array.isArray(rows) || rows.length > SQL_RESULT_ROWS + 1 || rows.some(row => !Array.isArray(row)
        || row.length !== 4 || row.slice(0, 3).some(cell => !Number.isSafeInteger(cell)) || typeof row[3] !== 'string')) {
        throw new Error('SQLite returned an invalid query plan.');
    }
    return { headers: ['id', 'parent', 'notused', 'detail'], rows };
}

/**
 * A number is typed as SQLite types the same literal: digits alone are an
 * INTEGER, returned as a bigint so it stays exact; a fraction or an exponent
 * makes a REAL, returned as a number. prepareReadQuery binds them that way.
 */
export function parseQueryParameters(text: string): CellValue[] {
    if (text.length > SQL_MAX_TEXT) throw new Error('Parameters exceed 65,536 characters.');
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.length > 100) throw new Error('Enter a JSON array of at most 100 values.');
    // JSON.parse keeps a number's value, not its spelling. The text is valid
    // JSON, so outside strings each match is a number token, in array order.
    const numberTokens = (text.match(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [])
        .filter(token => !token.startsWith('"'));
    let nextToken = 0;
    return value.map((item: unknown): CellValue => {
        if (item !== null && typeof item !== 'string' && typeof item !== 'number') throw new Error('Parameters must be null, string, or number.');
        if (typeof item !== 'number') return item;
        const token = numberTokens[nextToken++];
        if (token === undefined) throw new Error('Parameter numbers could not be read.');
        if (/[.eE]/.test(token)) {
            if (!Number.isFinite(item)) throw new Error('Numbers must be finite.');
            return item;
        }
        const integer = BigInt(token);
        if (integer < INT64_MIN || integer > INT64_MAX) throw new Error(INT64_RANGE_ERROR);
        return integer;
    });
}

export interface ReadTransport extends ExactNumericTextQuery {
    metadataMayBeNull: boolean;
}

/**
 * cellHelpers: the connection registered the runtime's cell helpers and its
 * database is UTF-8. The statement then packs the value columns' REAL text
 * into its own projection, as the grid page does.
 */
export function buildReadTransport(sql: string, columnCount: number, cellHelpers = false): ReadTransport {
    if (columnCount < 1 || columnCount > SQL_MAX_COLUMNS) throw new Error('Queries support 1 to 128 result columns.');
    const options = { limit: SQL_RESULT_ROWS + 1, maxInlineCellBytes: 64 * 1024, maxPageResponseBytes: SQL_RESULT_BYTES };
    if (cellHelpers) {
        const containment = buildCellContainmentQuery(sql, columnCount, options, [], 'checked', true);
        return { ...containment.numericTransport, metadataMayBeNull: containment.metadataMayBeNull };
    }
    const containment = buildCellContainmentQuery(sql, columnCount, options);
    return {
        ...buildExactNumericTextQuery(containment.sql, containment.primaryTransportColumnCount),
        metadataMayBeNull: false
    };
}

export function decodeReadTransport(
    headers: string[],
    values: Array<Array<CellValue | bigint>>,
    transport: Pick<ReadTransport, 'valueColumnCount' | 'realTextColumnCount' | 'packedRealTextColumnCount' | 'metadataMayBeNull'>
): QueryResultSet {
    const normalized = normalizeIntegerRowsForTransport(values, transport.valueColumnCount, undefined, undefined,
        transport.realTextColumnCount, transport.packedRealTextColumnCount);
    return {
        headers,
        ...decodeCellContainment(normalized.rows, headers.length, normalized.exactIntegerTexts, SQL_RESULT_BYTES,
            transport.metadataMayBeNull)
    };
}

/** CSV stays positional and text-only; exact numbers and clipped-cell notices survive export. */
export function resultCsv(result: QueryResultSet): string {
    const quote = (value: string) => '"' + value.replace(/"/g, '""') + '"';
    const quoteText = (value: string) => {
        const inspection = createCsvTextInspection();
        inspectCsvTextChunk(inspection, value);
        return quote(inspection.dangerousPrefix ? `'${value}` : value);
    };
    const rows = result.rows.slice(0, SQL_RESULT_ROWS).map((row, r) => row.map((cell, c) => {
        let text = result.exactIntegerTexts?.[r]?.[c] ?? (cell === null ? 'NULL' : cell instanceof Uint8Array
            ? '0x' + Array.from(cell, b => b.toString(16).padStart(2, '0')).join('') : String(cell));
        const clipped = result.oversizedCells?.[r]?.[c];
        if (clipped) text += ` [preview; ${clipped.byteLength} bytes total]`;
        return typeof cell === 'string' && result.exactIntegerTexts?.[r]?.[c] === undefined
            ? quoteText(text) : quote(text);
    }).join(','));
    return [result.headers.map(quoteText).join(','), ...rows].join('\r\n');
}
