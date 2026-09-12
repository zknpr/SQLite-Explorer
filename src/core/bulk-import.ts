import type { CellValue, DatabaseOperations, LabeledModification } from './types';
import { runReadSnapshot } from './operation-serializer';
import { estimateUndoMemoryBytes } from './undo-history';
import { DEFAULT_MAX_CELL_EDIT_BYTES } from './cell-edit-policy';

export const IMPORT_MAX_BYTES = 64 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 100_000;
export const IMPORT_MAX_COLUMNS = 256;
// Empty CSV fields and short JSON values still allocate properties and row
// objects. Bound their count independently of the source byte limit.
export const IMPORT_MAX_CELLS = 2_000_000;
export const IMPORT_LIMIT_DESCRIPTION = '64 MiB / 100,000 rows / 256 columns';
export interface ImportData { columns: string[]; rows: Record<string, CellValue>[] }

function validateColumns(columns: string[]): void {
    if (!columns.length || columns.length > IMPORT_MAX_COLUMNS) throw new Error('Import requires 1 to 256 source columns.');
    if (columns.some(column => !column || column.length > 4096)) throw new Error('Import column names must contain 1 to 4096 characters.');
    if (new Set(columns).size !== columns.length) throw new Error('Import contains duplicate column names.');
}

function parseCsv(text: string): ImportData {
    const rows: Record<string, CellValue>[] = [];
    let columns: string[] | undefined, cells = 0;
    const delimiter = /[,"\r\n]/g;
    let record: string[] = [], field = '', quoted = false, afterQuote = false;
    const finishField = () => {
        record.push(field); field = ''; afterQuote = false;
        if (record.length > IMPORT_MAX_COLUMNS) throw new Error('Import supports at most 256 columns.');
    };
    const finishRecord = () => {
        finishField();
        if (!columns) { columns = record; validateColumns(columns); }
        else {
            if (rows.length >= IMPORT_MAX_ROWS) throw new Error('Import supports at most 100,000 rows.');
            if (record.length !== columns.length) throw new Error(`CSV row ${rows.length + 2} has ${record.length} fields; expected ${columns.length}.`);
            cells += record.length;
            if (cells > IMPORT_MAX_CELLS) throw new Error('Import supports at most 2,000,000 source cells. Split the file into smaller imports.');
            rows.push(Object.fromEntries(columns.map((column, index) => [column, record[index]])));
        }
        record = [];
    };
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else { quoted = false; afterQuote = true; }
            } else {
                const end = text.indexOf('"', i);
                if (end < 0) throw new Error('Unterminated CSV quoted field.');
                field += text.slice(i, end); i = end - 1;
            }
        } else if (ch === ',') finishField();
        else if (ch === '\r' || ch === '\n') {
            finishRecord(); if (ch === '\r' && text[i + 1] === '\n') i++;
        } else if (ch === '"' && field === '' && !afterQuote) quoted = true;
        else {
            if (afterQuote || ch === '"') throw new Error('Malformed CSV quoting.');
            // Slice a complete text span; per-character concatenation retains
            // large ropes for multi-megabyte fields in the extension host.
            delimiter.lastIndex = i;
            const end = delimiter.exec(text)?.index ?? text.length;
            field += text.slice(i, end); i = end - 1;
        }
    }
    if (quoted) throw new Error('Unterminated CSV quoted field.');
    if (field !== '' || record.length || afterQuote) finishRecord();
    validateColumns(columns ?? []);
    return { columns: columns!, rows };
}

/** Count UTF-8 bytes without making a second full-size encoded copy. */
function exceedsSourceBytes(text: string): boolean {
    let bytes = text.length;
    if (bytes > IMPORT_MAX_BYTES) return true;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code >= 0x80) {
            if (code < 0x800) bytes++;
            else {
                bytes += 2;
                if (code >= 0xd800 && code <= 0xdbff) {
                    const next = text.charCodeAt(index + 1);
                    if (next >= 0xdc00 && next <= 0xdfff) index++;
                }
            }
            if (bytes > IMPORT_MAX_BYTES) return true;
        }
    }
    return false;
}

/** Check container counts before JSON.parse allocates arrays and objects. */
function checkJsonStructureBudget(text: string): void {
    let quoted = false, depth = 0, rows = 0, cells = 0, rowCells = 0;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (quoted) {
            if (char === '\\') index++;
            else if (char === '"') quoted = false;
        } else if (char === '"') {
            if (depth !== 2) throw new Error('Each JSON row must be an object of scalar values.');
            quoted = true;
        }
        else if (char === '[' || char === '{') {
            if (depth >= 2 || (char === '[' && depth !== 0)) throw new Error('JSON cells must be scalar strings, numbers, or null.');
            depth++;
            if (char === '{') {
                rowCells = 0;
                if (++rows > IMPORT_MAX_ROWS) throw new Error('JSON import requires an array of at most 100,000 row objects.');
            }
        } else if (char === ']' || char === '}') depth--;
        else if (depth === 1 && char !== ',' && !/\s/.test(char)) throw new Error('Each JSON row must be an object of scalar values.');
        else if (char === ':') {
            if (++rowCells > IMPORT_MAX_COLUMNS) throw new Error('Import supports at most 256 columns.');
            if (++cells > IMPORT_MAX_CELLS) throw new Error('Import supports at most 2,000,000 source cells. Split the file into smaller imports.');
        }
    }
}

/** CSV values remain text; JSON accepts only SQLite-compatible scalar values. */
export function parseImport(input: string, format: 'csv' | 'json'): ImportData {
    if (exceedsSourceBytes(input)) {
        throw new Error('Import source exceeds the 64 MiB limit. Split the file into smaller imports.');
    }
    const text = input.replace(/^\ufeff/, '');
    let parsed: ImportData;
    if (format === 'csv') parsed = parseCsv(text);
    else {
        checkJsonStructureBudget(text);
        const value: unknown = JSON.parse(text);
        if (!Array.isArray(value) || value.length > IMPORT_MAX_ROWS) throw new Error('JSON import requires an array of at most 100,000 row objects.');
        const columns = new Set<string>();
        for (const row of value) {
            if (!row || Array.isArray(row) || typeof row !== 'object') throw new Error('Each JSON row must be an object of scalar values.');
            for (const [key, cell] of Object.entries(row)) {
                columns.add(key);
                if (columns.size > IMPORT_MAX_COLUMNS) throw new Error('Import supports at most 256 columns.');
                if (cell !== null && typeof cell !== 'string' && typeof cell !== 'number') throw new Error('JSON cells must be scalar strings, numbers, or null.');
                if (typeof cell === 'number') {
                    if (!Number.isFinite(cell)) throw new Error('JSON numbers must be finite.');
                    if (Number.isInteger(cell) && !Number.isSafeInteger(cell)) throw new Error('Supply exact large integers as a quoted string to avoid rounding.');
                }
            }
        }
        parsed = { columns: [...columns], rows: value };
        validateColumns(parsed.columns);
    }
    if (!parsed.rows.length) throw new Error('Import source contains no data rows.');
    return parsed;
}

export function mapImportRows(data: ImportData, targets: Array<string | undefined>): Record<string, CellValue>[] {
    if (targets.length !== data.columns.length) throw new Error('Every source column requires a mapping or Skip.');
    const used = targets.filter((target): target is string => target !== undefined);
    if (!used.length) throw new Error('Map at least one source column.');
    if (new Set(used).size !== used.length) throw new Error('A target column cannot be mapped more than once.');
    if (data.columns.every((column, index) => column === targets[index])) return data.rows;
    return data.rows.map(row => Object.fromEntries(data.columns.flatMap((column, index) => (
        targets[index] !== undefined && Object.hasOwn(row, column) ? [[targets[index]!, row[column]]] : []
    ))));
}

/** The snapshot helper owns the connection queue and a rollback-capable SAVEPOINT. */
export async function importRowsAtomically(
    operations: DatabaseOperations, table: string, rows: Record<string, CellValue>[],
    maxUndoBytes: number, signal?: AbortSignal, progress?: (completed: number) => void
): Promise<LabeledModification> {
    if (!rows.length || rows.length > IMPORT_MAX_ROWS) throw new Error('Import requires 1 to 100,000 rows.');
    let cells = 0;
    for (const row of rows) {
        const count = Object.keys(row).length;
        if (count > IMPORT_MAX_COLUMNS) throw new Error('Import supports at most 256 columns.');
        if ((cells += count) > IMPORT_MAX_CELLS) throw new Error('Import supports at most 2,000,000 source cells. Split the file into smaller imports.');
    }
    const modification: LabeledModification = {
        label: `Import ${rows.length} rows`, description: `Import ${rows.length} rows into ${table}`,
        modificationType: 'row_insert', targetTable: table, insertedRows: []
    };
    let historyBytes = estimateUndoMemoryBytes(modification);
    if (!Number.isFinite(maxUndoBytes) || historyBytes >= maxUndoBytes) throw new Error('Import exceeds the undo memory limit.');
    return runReadSnapshot(operations, async transaction => {
        if (!transaction.insertRowWithHistory) throw new Error('Backend does not support guarded import history.');
        for (let index = 0; index < rows.length; index++) {
            signal?.throwIfAborted();
            const snapshot = await transaction.insertRowWithHistory(table, rows[index], DEFAULT_MAX_CELL_EDIT_BYTES, maxUndoBytes - historyBytes);
            historyBytes += estimateUndoMemoryBytes(snapshot);
            if (historyBytes > maxUndoBytes) throw new Error('Import exceeds the undo memory limit. Split the file into smaller imports.');
            modification.insertedRows!.push(snapshot);
            progress?.(index + 1);
            // In-process WASM must yield so progress/cancellation can be delivered.
            if ((index + 1) % 50 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
        signal?.throwIfAborted();
        return modification;
    });
}
