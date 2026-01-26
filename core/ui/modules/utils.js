/**
 * Utility Functions
 */

/**
 * Escape HTML special characters to prevent XSS attacks.
 */
export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Validate and sanitize a rowid for use in SQL queries.
 */
export function validateRowId(rowId) {
    const num = Number(rowId);
    if (!Number.isFinite(num)) {
        throw new Error(`Invalid rowid: ${rowId}`);
    }
    return num;
}

/**
 * Escape a SQL identifier (table name, column name).
 */
export function escapeIdentifier(identifier) {
    if (identifier === null || identifier === undefined) return '""';
    return `"${String(identifier).replace(/"/g, '""')}"`;
}

/**
 * Format a cell value for display.
 */
export function formatCellValue(value) {
    // Handle null and undefined as NULL display
    if (value === null || value === undefined) return 'NULL';
    if (value instanceof Uint8Array) return '[BLOB]';
    if (typeof value === 'string' && value.length > 100) {
        return escapeHtml(value.substring(0, 100)) + '...';
    }
    return escapeHtml(String(value));
}
