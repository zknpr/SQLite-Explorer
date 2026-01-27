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
export function formatCellValue(value, columnType = null, dateFormat = 'raw', columnName = null) {
    // Handle null and undefined as NULL display
    if (value === null || value === undefined) return 'NULL';
    if (value instanceof Uint8Array) return '[BLOB]';

    // Date formatting
    if (dateFormat !== 'raw') {
        const isDate = isDateType(columnType, columnName);
        if (isDate) {
            const formatted = formatDate(value, dateFormat);
            if (formatted) return escapeHtml(formatted);
        }
    }

    if (typeof value === 'string' && value.length > 100) {
        return escapeHtml(value.substring(0, 100)) + '...';
    }
    return escapeHtml(String(value));
}

/**
 * Check if a column type indicates a date/time.
 */
function isDateType(type, name) {
    if (type) {
        const t = type.toUpperCase();
        if (t.includes('DATE') || t.includes('TIME') || t.includes('TIMESTAMP')) return true;
    }
    if (name) {
        const n = name.toUpperCase();
        // Heuristics for column names that likely contain dates
        return n.endsWith('_AT') ||
               n.endsWith('_ON') ||
               n.includes('DATE') ||
               n.includes('TIME') ||
               n === 'CREATED' ||
               n === 'UPDATED';
    }
    return false;
}

/**
 * Format a date value.
 */
function formatDate(value, format) {
    if (!value) return null;

    // Parse date (assuming string or number)
    let date;
    if (value instanceof Date) {
        date = value;
    } else if (typeof value === 'number') {
        // Assume unix timestamp (seconds if small, millis if large?)
        // SQLite often uses seconds (REAL or INTEGER)
        // If it's small (e.g. < 10^11), assume seconds.
        if (value < 100000000000) {
            date = new Date(value * 1000);
        } else {
            date = new Date(value);
        }
    } else {
        // Try parsing string
        let dateStr = String(value);

        // Handle SQLite "YYYY-MM-DD HH:MM:SS" format by replacing space with T
        // This makes it compatible with ISO 8601 parsing
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(dateStr)) {
            dateStr = dateStr.replace(' ', 'T');
        }

        const parsed = Date.parse(dateStr);
        if (isNaN(parsed)) {
            return null; // Not a valid date
        }
        date = new Date(parsed);
    }

    if (isNaN(date.getTime())) return null;

    switch (format) {
        case 'local':
            return date.toLocaleString();
        case 'iso':
            return date.toISOString();
        case 'relative':
            return timeAgo(date);
        default:
            return String(value);
    }
}

/**
 * Format date as relative time (e.g. "2 hours ago").
 */
function timeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    const intervals = {
        year: 31536000,
        month: 2592000,
        week: 604800,
        day: 86400,
        hour: 3600,
        minute: 60,
        second: 1
    };

    let counter;
    for (const [unit, secondsInUnit] of Object.entries(intervals)) {
        counter = Math.floor(seconds / secondsInUnit);
        if (counter > 0) {
            if (counter === 1) {
                return `1 ${unit} ago`;
            } else {
                return `${counter} ${unit}s ago`;
            }
        }
    }
    return 'Just now';
}
