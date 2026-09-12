import type { CellValue, QueryResultSet } from './types';
import { normalizeViewSelectSql } from './view-utils';
import { buildCellContainmentQuery, decodeCellContainment } from './cell-containment';
import { buildExactNumericTextQuery, normalizeIntegerRowsForTransport } from './integer-utils';
import { createCsvTextInspection, inspectCsvTextChunk } from './export-encoding';

export const SQL_RESULT_ROWS = 1000;
export const SQL_RESULT_BYTES = 4 * 1024 * 1024;
export const SQL_MAX_TEXT = 64 * 1024;
export const SQL_MAX_COLUMNS = 128;

/** Check lexical boundaries and bindings; SQLite compiles the complete SELECT grammar. */
export function prepareReadQuery(input: string) {
    if (input.length > SQL_MAX_TEXT) throw new Error('Query text exceeds 65,536 characters.');
    const body = normalizeViewSelectSql(input);
    let metadataBody = '', parameterCount = 0, depth = 0;
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
            metadataBody += 'NULL'; continue;
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
    }
    if (depth !== 0) throw new Error('Unbalanced query parentheses.');
    // Only SELECT grammar is legal inside this wrapper. A compiler boundary
    // marker must also be verified before execution to reject escaped tails.
    return {
        sourceSql: body,
        sql: `SELECT * FROM (\n${body}\n) LIMIT ${SQL_RESULT_ROWS + 1}`,
        metadataSql: `SELECT * FROM (\n${metadataBody}\n) LIMIT 0`,
        parameterCount
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

export function parseQueryParameters(text: string): CellValue[] {
    if (text.length > SQL_MAX_TEXT) throw new Error('Parameters exceed 65,536 characters.');
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.length > 100) throw new Error('Enter a JSON array of at most 100 values.');
    for (const item of value) {
        if (item !== null && typeof item !== 'string' && typeof item !== 'number') throw new Error('Parameters must be null, string, or number.');
        if (typeof item === 'number' && (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) {
            throw new Error('Numbers must be finite and integer values must be safe integers. Supply an exact integer as a quoted string and use CAST(? AS INTEGER).');
        }
    }
    return value;
}

export function buildReadTransport(sql: string, columnCount: number) {
    if (columnCount < 1 || columnCount > SQL_MAX_COLUMNS) throw new Error('Queries support 1 to 128 result columns.');
    const containment = buildCellContainmentQuery(sql, columnCount, {
        limit: SQL_RESULT_ROWS + 1, maxInlineCellBytes: 64 * 1024, maxPageResponseBytes: SQL_RESULT_BYTES
    });
    return buildExactNumericTextQuery(containment.sql, containment.primaryTransportColumnCount);
}

export function decodeReadTransport(headers: string[], values: Array<Array<CellValue | bigint>>, valueColumnCount?: number): QueryResultSet {
    const normalized = normalizeIntegerRowsForTransport(values, valueColumnCount);
    return { headers, ...decodeCellContainment(normalized.rows, headers.length, normalized.exactIntegerTexts, SQL_RESULT_BYTES) };
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
