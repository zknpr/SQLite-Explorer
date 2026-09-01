/**
 * Utility Functions
 */
import { getActiveFilterValue } from '../../../src/core/filter-utils.ts';
import {
    decodePrimaryKeyRecordId,
    isPrimaryKeyRecordId,
    isReadOnlyPrimaryKeyRecordId
} from '../../../src/core/row-identity.ts';

const MAX_UI_ERROR_MESSAGE_LENGTH = 8192;

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
 * Turn arbitrary rejected values into a usable status message. JavaScript
 * promises may reject with null, strings, proxies, or objects whose coercion
 * throws; error reporting must not become a second failure.
 */
export function getErrorMessage(error, fallback = 'Unknown error') {
    let message = fallback;
    try {
        if (error instanceof Error && typeof error.message === 'string' && error.message) {
            message = error.message;
        } else {
            message = String(error) || fallback;
        }
    } catch {
        message = fallback;
    }
    if (message.length <= MAX_UI_ERROR_MESSAGE_LENGTH) return message;
    return message.slice(0, MAX_UI_ERROR_MESSAGE_LENGTH)
        + `... [truncated from ${message.length} characters]`;
}

/** Normalize transport/file binary values without lossy Uint8Array coercion. */
export function normalizeBinaryData(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    }

    let bytes;
    if (Array.isArray(value)) {
        bytes = value;
    } else if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        if (value.type === 'Buffer'
            && Array.isArray(value.data)
            && keys.length === 2
            && keys.includes('type')
            && keys.includes('data')) {
            bytes = value.data;
        } else if (keys.length > 0 && keys.every((key, index) => key === String(index))) {
            // Legacy typed-array serialization: { 0: byte, 1: byte, ... }.
            bytes = keys.map(key => value[key]);
        }
    }

    if (!bytes || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
        throw new TypeError('Invalid binary data: expected canonical bytes in the range 0..255');
    }
    return new Uint8Array(bytes);
}

/**
 * Escape a string for safe use inside a RegExp pattern.
 */
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fold only ASCII uppercase letters, matching SQLite LIKE's default
 * case-insensitive range without conflating distinct non-ASCII characters.
 */
export function foldAsciiCase(str) {
    return String(str).replace(/[A-Z]/g, char => char.toLowerCase());
}

/** SQLite's built-in LIKE treats the first NUL as the end of a TEXT value. */
export function truncateAtSqliteTextNul(value) {
    const text = String(value);
    const nulIndex = text.indexOf('\0');
    return nulIndex < 0 ? text : text.slice(0, nulIndex);
}

function escapeAsciiCaseInsensitiveRegExp(str) {
    return escapeRegExp(str).replace(/[A-Za-z]/g, char => {
        const lower = foldAsciiCase(char);
        return `[${lower}${lower.toUpperCase()}]`;
    });
}

/**
 * Build a reusable SQLite-compatible ASCII-case-insensitive RegExp that matches
 * any of the given filter terms, or null when there are no active terms. Compile
 * this once per column and reuse it across cells rather than rebuilding per cell.
 *
 * Terms are de-duplicated and sorted longest-first: regex alternation matches
 * the first listed alternative that fits, so without this a shorter term that is
 * a prefix of a longer one (e.g. "cat" vs "category") would shadow the longer
 * match and only highlight the prefix.
 */
export function buildHighlightMatcher(terms) {
    const seen = new Set();
    for (const t of terms) {
        const term = getActiveFilterValue(t);
        if (term !== undefined) seen.add(term);
    }
    if (seen.size === 0) return null;
    const ordered = [...seen].sort((a, b) => b.length - a.length);
    return new RegExp(`(${ordered.map(escapeAsciiCaseInsensitiveRegExp).join('|')})`, 'g');
}

/**
 * Append text to a parent element, wrapping matches of a precompiled `matcher`
 * (from buildHighlightMatcher) in <mark class="cell-highlight"> spans. Uses DOM
 * text nodes (never innerHTML) so untrusted cell content can never be interpreted
 * as markup. When `matcher` is null, the text is appended verbatim (fast path).
 */
export function appendHighlightedText(parentEl, text, matcher) {
    if (!matcher) {
        parentEl.appendChild(document.createTextNode(text));
        return;
    }

    // Match only the prefix SQLite LIKE can inspect. Preserve the suffix for
    // display, but never mark text that SQL could not have matched.
    const searchableText = truncateAtSqliteTextNul(text);
    const displaySuffix = text.slice(searchableText.length);

    // The matcher is shared across cells; reset its state before scanning.
    matcher.lastIndex = 0;
    let lastIndex = 0;
    let match;
    while ((match = matcher.exec(searchableText)) !== null) {
        if (match.index > lastIndex) {
            parentEl.appendChild(document.createTextNode(searchableText.slice(lastIndex, match.index)));
        }
        const mark = document.createElement('mark');
        mark.className = 'cell-highlight';
        mark.textContent = match[0];
        parentEl.appendChild(mark);
        lastIndex = match.index + match[0].length;
        if (match[0].length === 0) matcher.lastIndex++; // guard against zero-length matches
    }
    if (lastIndex < searchableText.length) {
        parentEl.appendChild(document.createTextNode(searchableText.slice(lastIndex)));
    }
    if (displaySuffix) {
        parentEl.appendChild(document.createTextNode(displaySuffix));
    }
}

/**
 * Validate and sanitize a rowid for use in SQL queries.
 */
export function validateRowId(rowId) {
    // Read-only identity tokens never enter SQL. Preserve them through DOM event
    // routing so the host can return the exact server-authored refusal reason.
    if (isReadOnlyPrimaryKeyRecordId(rowId)) return rowId;
    if (isPrimaryKeyRecordId(rowId)) {
        decodePrimaryKeyRecordId(rowId);
        return rowId;
    }
    if (typeof rowId === 'number') {
        if (!Number.isSafeInteger(rowId)) throw new Error(`Invalid rowid: ${rowId}`);
        return rowId;
    }
    if (typeof rowId !== 'string' || !/^[+-]?\d+$/.test(rowId.trim())) {
        throw new Error(`Invalid rowid: ${rowId}`);
    }
    const exact = BigInt(rowId.trim());
    if (exact < -9223372036854775808n || exact > 9223372036854775807n) {
        throw new Error(`Invalid rowid: ${rowId}`);
    }
    const num = Number(exact);
    return Number.isSafeInteger(num) ? num : exact.toString();
}

/** Match SQLite's INTEGER and NUMERIC affinity rules for declared types. */
export function hasIntegerOrNumericAffinity(declaredType) {
    const type = String(declaredType ?? '').toUpperCase();
    if (/INT/.test(type)) return true;
    if (/(CHAR|CLOB|TEXT)/.test(type)) return false;
    if (type === '' || /BLOB/.test(type)) return false;
    if (/(REAL|FLOA|DOUB)/.test(type)) return false;
    return true;
}

/** Apply declared affinity without destroying lexical TEXT or unsafe integer input. */
export function parseGridInputValue(value, column, usesDeclaredPrimaryKey = false) {
    const declaredType = (column?.type ?? '').toUpperCase();
    if (/(CHAR|CLOB|TEXT)/.test(declaredType)) {
        return value;
    }
    const numericValue = Number(value);
    if (
        hasIntegerOrNumericAffinity(declaredType)
        && /^[+-]?\d+$/.test(value.trim())
        && !Number.isSafeInteger(numericValue)
    ) {
        // Binding exact decimal text lets SQLite apply INTEGER/NUMERIC affinity
        // without first rounding through JavaScript's binary64 Number.
        return value.trim();
    }
    return numericValue;
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
 * Format a cell value for display as plain text (no HTML escaping).
 * Use this when setting textContent.
 */
export function formatCellValueAsText(
    value,
    columnType = null,
    dateFormat = 'raw',
    columnName = null,
    truncateLongText = true
) {
    // Handle null and undefined as NULL display
    if (value === null || value === undefined) return 'NULL';
    if (value instanceof Uint8Array) return '[BLOB]';

    // Date formatting
    if (dateFormat !== 'raw') {
        const isDate = isDateType(columnType, columnName);
        if (isDate) {
            const formatted = formatDate(value, dateFormat);
            if (formatted) return formatted;
        }
    }

    if (truncateLongText && typeof value === 'string' && value.length > 100) {
        return value.substring(0, 100) + '...';
    }
    return String(value);
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
    if (value === null || value === undefined || value === '') return null;

    // Parse date (assuming string or number)
    let date;
    if (value instanceof Date) {
        date = value;
    } else if (typeof value === 'number') {
        // Assume unix timestamp
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
    const signedSeconds = Math.trunc((Date.now() - date.getTime()) / 1000);
    const seconds = Math.abs(signedSeconds);
    const intervals = {
        year: 31536000,
        month: 2592000,
        week: 604800,
        day: 86400,
        hour: 3600,
        minute: 60,
        second: 1
    };

    for (const [unit, secondsInUnit] of Object.entries(intervals)) {
        const counter = Math.floor(seconds / secondsInUnit);
        if (counter > 0) {
            const quantity = `${counter} ${unit}${counter === 1 ? '' : 's'}`;
            return signedSeconds < 0 ? `in ${quantity}` : `${quantity} ago`;
        }
    }
    return 'Just now';
}
