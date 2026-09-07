/**
 * Batch Update Logic (DOM-free, unit-testable)
 *
 * Pure helpers extracted from sidebar.js's batch-update flow so the
 * value-processing rules (column grouping, value summarisation, type
 * coercion, NULL/json_patch handling, skip-empty) can be unit-tested
 * without a DOM. sidebar.js wires these into the actual DOM.
 *
 * Types live in batch-update-logic.d.ts.
 */

import { hasIntegerOrNumericAffinity } from './utils.js';

/**
 * Group the selected cells by column index.
 * @returns Map of colIdx -> { name, type, values } where `values` is the set
 *          of distinct cell values currently selected in that column.
 */
export function groupSelectedCellsByColumn(selectedCells, tableColumns) {
    const columns = new Map();
    for (const cell of selectedCells) {
        const colDef = tableColumns && tableColumns[cell.colIdx];
        if (!colDef) continue; // skip stale/out-of-bounds selections (e.g. after a column drop)
        if (!columns.has(cell.colIdx)) {
            columns.set(cell.colIdx, {
                name: colDef.name,
                type: colDef.type,
                notnull: colDef.notnull,
                isPrimaryKey: colDef.isPrimaryKey,
                values: new Set()
            });
        }
        columns.get(cell.colIdx).values.add(cell.value);
    }
    return columns;
}

/**
 * Placeholder text describing a column's current selected value(s):
 * '(mixed values)' when the selection spans differing values, otherwise the
 * single shared value rendered as NULL / [BLOB] / its string form.
 */
export function summarizeColumnValue(values) {
    const uniqueValues = Array.from(values || []);
    if (uniqueValues.length === 0) return '';
    if (uniqueValues.length > 1) return '(mixed values)';
    const val = uniqueValues[0];
    if (val === null) return 'NULL';
    if (val instanceof Uint8Array) return '[BLOB]';
    if (val === '') return '(empty string)';
    return String(val);
}

/**
 * Build the list of cell updates to send to the backend.
 *
 * `inputsByCol` maps a column index to an input-like object
 * ({ value, dataset:{ isnull, ispatch } }) — in the browser these are the
 * real <input> elements; in tests they are plain stand-ins. Mirrors the
 * batch form's rules: skip cells left blank (unless explicitly NULL), tag
 * json_patch operations, and coerce numeric column types.
 */
export function prepareBatchUpdates(
    selectedCells,
    inputsByCol,
    tableColumns,
    usesDeclaredPrimaryKey = false
) {
    const updates = [];
    for (const cell of selectedCells) {
        const input = inputsByCol.get(cell.colIdx);
        if (!input) continue;

        const dataset = input.dataset || {};
        const explicitMode = dataset.mode;
        if (explicitMode === 'unchanged') continue;
        const isNull = explicitMode
            ? explicitMode === 'null'
            : dataset.isnull === 'true';
        const isPatch = explicitMode
            ? explicitMode === 'patch'
            : dataset.ispatch === 'true';
        const value = input.value;

        // Legacy inputs have no mode; retain skip-blank compatibility. Real
        // batch fields explicitly distinguish untouched from value-mode '',
        // so an empty string can be stored without conflating it with NULL.
        if (!explicitMode && value === '' && !isNull) continue;

        const colDef = tableColumns && tableColumns[cell.colIdx];
        if (!colDef) continue; // skip stale/out-of-bounds selections

        let finalValue = value;
        let operation = 'set';

        if (isNull) {
            finalValue = null;
        } else if (isPatch) {
            operation = 'json_patch';
        } else {
            // Coerce numeric column types when the input parses as a number.
            // Normalize case: SQLite stores the declared type verbatim, so a column
            // may report e.g. 'integer' rather than 'INTEGER'.
            const colType = (colDef.type || '').toUpperCase();
            const numericValue = Number(value);
            if ((usesDeclaredPrimaryKey && colDef.isPrimaryKey || colDef.isRowidAlias === true)
                && hasIntegerOrNumericAffinity(colType)
                && /^[+-]?\d+$/.test(value.trim())
                && !Number.isSafeInteger(numericValue)) {
                finalValue = value.trim();
            } else if ((colType === 'INTEGER' || colType === 'REAL' || colType === 'NUMERIC')
                && !isNaN(Number(value)) && value.trim() !== '') {
                finalValue = numericValue;
            }
        }

        updates.push({
            rowId: cell.rowId,
            column: colDef.name,
            value: finalValue,
            originalValue: cell.value,
            operation,
            rowIdx: cell.rowIdx,
            colIdx: cell.colIdx
        });
    }
    return updates;
}
