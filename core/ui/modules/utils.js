/**
 * Utility Functions
 */
import { getActiveFilterValue } from '../../../src/core/filter-utils.ts';
import {
    decodePrimaryKeyRecordId,
    isPrimaryKeyRecordId,
    isReadOnlyPrimaryKeyRecordId
} from '../../../src/core/row-identity.ts';

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

/** Preserve decimal text when a declared PK integer cannot survive a JS number round-trip. */
export function parseGridInputValue(value, column, usesDeclaredPrimaryKey = false) {
    const declaredType = (column?.type ?? '').toUpperCase();
    if (
        usesDeclaredPrimaryKey
        && column?.isPrimaryKey
        && /(CHAR|CLOB|TEXT)/.test(declaredType)
    ) {
        return value;
    }
    const numericValue = Number(value);
    if (
        usesDeclaredPrimaryKey
        && column?.isPrimaryKey
        && hasIntegerOrNumericAffinity(declaredType)
        && /^[+-]?\d+$/.test(value.trim())
        && !Number.isSafeInteger(numericValue)
    ) {
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
    if (!value) return null;

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
