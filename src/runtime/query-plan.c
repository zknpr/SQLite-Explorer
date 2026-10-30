/*
 * Bounded EXPLAIN QUERY PLAN reader and grid cell helpers, compiled into
 * sql.js and as a native loadable SQLite extension. Only this file owns plan
 * extraction: neither JavaScript binding has to materialize an unbounded
 * detail string or array.
 */
#include "sqlite3ext.h"
SQLITE_EXTENSION_INIT1

#ifndef SQLITE_EXPLORER_PLAN_MAX_ROWS
#define SQLITE_EXPLORER_PLAN_MAX_ROWS 1001
#endif
#ifndef SQLITE_EXPLORER_PLAN_MAX_DETAIL_BYTES
#define SQLITE_EXPLORER_PLAN_MAX_DETAIL_BYTES 65536
#endif
#define PLAN_MAX_JSON_BYTES (4 * 1024 * 1024)
#define PLAN_MAX_SQL_BYTES (4 * 65536)
#define PLAN_MAX_VDBE_OPS 100000

static int bounded_length(const char *text, int limit) {
    int length = 0;
    while (length < limit && text[length]) length++;
    return length;
}

static int empty_tail(const char *tail) {
    while (*tail == ' ' || *tail == '\n' || *tail == '\r' || *tail == '\t' || *tail == '\f') tail++;
    return *tail == 0;
}

/* Reserve the escaped size before appending any bytes to the result buffer. */
static int append_detail(sqlite3_str *output, const unsigned char *text, int length) {
    int escaped = 2;
    for (int index = 0; index < length; index++) {
        escaped += text[index] < 0x20 ? 6 : (text[index] == '"' || text[index] == '\\' ? 2 : 1);
    }
    if (escaped > PLAN_MAX_JSON_BYTES - sqlite3_str_length(output) - 2) return SQLITE_TOOBIG;
    sqlite3_str_appendchar(output, 1, '"');
    int start = 0;
    for (int index = 0; index < length; index++) {
        unsigned char value = text[index];
        if (value < 0x20 || value == '"' || value == '\\') {
            sqlite3_str_append(output, (const char *) text + start, index - start);
            if (value < 0x20) sqlite3_str_appendf(output, "\\u%04x", (unsigned) value);
            else { sqlite3_str_appendchar(output, 1, '\\'); sqlite3_str_appendchar(output, 1, value); }
            start = index + 1;
        }
    }
    sqlite3_str_append(output, (const char *) text + start, length - start);
    sqlite3_str_appendchar(output, 1, '"');
    return sqlite3_str_errcode(output);
}

static void query_plan(sqlite3_context *context, int argc, sqlite3_value **argv) {
    sqlite3 *db = sqlite3_context_db_handle(context);
    sqlite3_stmt *check = 0, *plan = 0;
    sqlite3_str *output = 0;
    char *wrapped = 0, *explained = 0, *json = 0;
    const char *tail = 0, *message = 0;
    char sqlite_message[4097];
    int rc = SQLITE_OK, rows = 0;
    int old_length = -1, old_sql_length = -1, old_ops = -1;

    if (argc < 1 || argc > 101 || sqlite3_value_type(argv[0]) != SQLITE_TEXT) {
        sqlite3_result_error(context, "Query plan requires SQL text and at most 100 positional parameters.", -1);
        return;
    }
    int sql_bytes = sqlite3_value_bytes(argv[0]);
    if (sql_bytes > PLAN_MAX_SQL_BYTES) {
        sqlite3_result_error(context, "Query plan SQL exceeds 262,144 UTF-8 bytes.", -1);
        return;
    }
    const char *sql = (const char *) sqlite3_value_text(argv[0]);
    if (!sql) { sqlite3_result_error_nomem(context); return; }
    if (bounded_length(sql, sql_bytes) != sql_bytes) {
        sqlite3_result_error(context, "Query plan SQL must not contain NUL characters.", -1);
        return;
    }

    /* Limit compilation as well as extraction. These connection limits are
     * restored on every exit, before SQLite returns to the caller's statement.
     * Never raise a stricter limit previously installed by the host. */
    old_length = sqlite3_limit(db, SQLITE_LIMIT_LENGTH, -1);
    sqlite3_limit(db, SQLITE_LIMIT_LENGTH, old_length < 1048576 ? old_length : 1048576);
    old_sql_length = sqlite3_limit(db, SQLITE_LIMIT_SQL_LENGTH, -1);
    sqlite3_limit(db, SQLITE_LIMIT_SQL_LENGTH, old_sql_length < 524288 ? old_sql_length : 524288);
    old_ops = sqlite3_limit(db, SQLITE_LIMIT_VDBE_OP, -1);
    sqlite3_limit(db, SQLITE_LIMIT_VDBE_OP, old_ops < PLAN_MAX_VDBE_OPS ? old_ops : PLAN_MAX_VDBE_OPS);

    /* Compile inside SELECT grammar before preparing the original text.
     * Some PRAGMAs have prepare-time effects, so readonly() alone is not an
     * adequate admission check for arbitrary input. No user SELECT is stepped. */
    wrapped = sqlite3_mprintf("SELECT * FROM (\n%s\n)", sql);
    if (!wrapped) { rc = SQLITE_NOMEM; goto cleanup; }
    rc = sqlite3_prepare_v2(db, wrapped, -1, &check, &tail);
    if (rc != SQLITE_OK) goto cleanup;
    if (!check || !empty_tail(tail) || !sqlite3_stmt_readonly(check)) {
        message = "Exactly one read query is required for a query plan."; goto cleanup;
    }
    if (sqlite3_bind_parameter_count(check) != argc - 1) {
        message = "Query plan positional parameter count does not match."; goto cleanup;
    }
    rc = sqlite3_finalize(check); check = 0;
    if (rc != SQLITE_OK) goto cleanup;

    explained = sqlite3_mprintf("EXPLAIN QUERY PLAN %s", sql);
    if (!explained) { rc = SQLITE_NOMEM; goto cleanup; }
    rc = sqlite3_prepare_v2(db, explained, -1, &plan, &tail);
    if (rc != SQLITE_OK) goto cleanup;
    if (!plan || !empty_tail(tail) || sqlite3_column_count(plan) != 4) {
        message = "SQLite returned an unsupported query plan."; goto cleanup;
    }
    for (int index = 1; index < argc; index++) {
        rc = sqlite3_bind_value(plan, index, argv[index]);
        if (rc != SQLITE_OK) goto cleanup;
    }
    output = sqlite3_str_new(0);
    if (!output) { rc = SQLITE_NOMEM; goto cleanup; }
    sqlite3_str_appendchar(output, 1, '[');
    while (rows < SQLITE_EXPLORER_PLAN_MAX_ROWS && (rc = sqlite3_step(plan)) == SQLITE_ROW) {
        /* Inspect SQLite-owned UTF-8 before copying it into a result string. */
        const unsigned char *detail = sqlite3_column_text(plan, 3);
        int length = sqlite3_column_bytes(plan, 3);
        if (!detail) { rc = SQLITE_NOMEM; goto cleanup; }
        if (length > SQLITE_EXPLORER_PLAN_MAX_DETAIL_BYTES) {
            message = "Query plan detail exceeds the 65,536-byte limit."; goto cleanup;
        }
        if (sqlite3_str_length(output) > PLAN_MAX_JSON_BYTES - 100) {
            message = "Query plan exceeds the 4 MiB result limit."; goto cleanup;
        }
        sqlite3_str_appendf(output, "%s[%d,%d,%d,", rows ? "," : "",
            sqlite3_column_int(plan, 0), sqlite3_column_int(plan, 1), sqlite3_column_int(plan, 2));
        rc = append_detail(output, detail, length);
        if (rc != SQLITE_OK) {
            if (rc == SQLITE_TOOBIG) message = "Query plan exceeds the 4 MiB result limit.";
            goto cleanup;
        }
        sqlite3_str_appendchar(output, 1, ']');
        rows++;
    }
    if (rc != SQLITE_DONE && rc != SQLITE_OK) goto cleanup;
    sqlite3_str_appendchar(output, 1, ']');
    rc = sqlite3_str_errcode(output);

cleanup:
    if (rc != SQLITE_OK && rc != SQLITE_DONE && !message) {
        const char *error = rc == SQLITE_NOMEM ? "Query plan compilation or allocation limit exceeded." : sqlite3_errmsg(db);
        int length = bounded_length(error, 4096);
        for (int index = 0; index < length; index++) sqlite_message[index] = error[index];
        sqlite_message[length] = 0;
        message = sqlite_message;
    }
    if (check) sqlite3_finalize(check);
    if (plan) sqlite3_finalize(plan);
    sqlite3_free(wrapped);
    sqlite3_free(explained);
    if (output) json = sqlite3_str_finish(output);
    if (old_length >= 0) sqlite3_limit(db, SQLITE_LIMIT_LENGTH, old_length);
    if (old_sql_length >= 0) sqlite3_limit(db, SQLITE_LIMIT_SQL_LENGTH, old_sql_length);
    if (old_ops >= 0) sqlite3_limit(db, SQLITE_LIMIT_VDBE_OP, old_ops);
    if (message) { sqlite3_free(json); sqlite3_result_error(context, message, -1); }
    else if (!json) sqlite3_result_error_nomem(context);
    else sqlite3_result_text(context, json, -1, sqlite3_free);
}

/*
 * Grid page cell helpers. Each replaces SQL that called typeof() and
 * octet_length() several times per cell. Engines call them only for UTF-8
 * databases, where sqlite3_value_text() and sqlite3_value_bytes() return the
 * stored bytes unconverted, and every scan stays inside those bytes.
 */
static int byte_limit(sqlite3_context *context, sqlite3_value *value, sqlite3_int64 *limit) {
    if (sqlite3_value_type(value) != SQLITE_INTEGER
        || (*limit = sqlite3_value_int64(value)) < 0 || *limit > 0x7fffffff) {
        sqlite3_result_error(context, "Grid cell helper limits must be integers from 0 to 2147483647.", -1);
        return 0;
    }
    return 1;
}

static int is_oversized(sqlite3_value *value, sqlite3_int64 limit) {
    int type = sqlite3_value_type(value);
    return (type == SQLITE_TEXT || type == SQLITE_BLOB) && sqlite3_value_bytes(value) > limit;
}

/* substr(value, 1, characters) as the bundled SQLite divides text: NUL ends
 * it, and any other byte above 0x7f starts a character that absorbs the
 * continuation bytes after it (tag-20260418-01 in sqlite3.c). SQLite leaves
 * that division of malformed UTF-8 unspecified, so the differential tests
 * compare this with substr() on every runtime build. */
static int text_prefix_bytes(const unsigned char *text, int length, sqlite3_int64 characters) {
    int index = 0;
    while (index < length && characters > 0) {
        unsigned char lead = text[index];
        if (!lead) break;
        index++;
        if (lead >= 0x80) {
            while (index < length && (text[index] & 0xc0) == 0x80) index++;
        }
        characters--;
    }
    return index;
}

/* The value, or a bounded prefix of TEXT or a BLOB longer than limit bytes. */
static void cell_preview(sqlite3_context *context, int argc, sqlite3_value **argv) {
    sqlite3_int64 limit, characters;
    (void) argc;
    if (!byte_limit(context, argv[1], &limit) || !byte_limit(context, argv[2], &characters)) return;
    int type = sqlite3_value_type(argv[0]);
    if (type == SQLITE_TEXT) {
        const unsigned char *text = sqlite3_value_text(argv[0]);
        int length = sqlite3_value_bytes(argv[0]);
        if (!text) { sqlite3_result_error_nomem(context); return; }
        if (length > limit) {
            sqlite3_result_text(context, (const char *) text,
                text_prefix_bytes(text, length, characters), SQLITE_TRANSIENT);
            return;
        }
    } else if (type == SQLITE_BLOB) {
        const void *blob = sqlite3_value_blob(argv[0]);
        if (sqlite3_value_bytes(argv[0]) > limit) {
            sqlite3_result_blob(context, blob, (int) limit, SQLITE_TRANSIENT);
            return;
        }
    }
    sqlite3_result_value(context, argv[0]);
}

/* NULL when no argument after the limit is oversized, otherwise one token
 * per argument joined by '|': empty, or t/b and the byte length. */
static void cell_metadata(sqlite3_context *context, int argc, sqlite3_value **argv) {
    sqlite3_int64 limit;
    if (argc < 2) {
        sqlite3_result_error(context, "Grid cell metadata requires a limit and at least one value.", -1);
        return;
    }
    if (!byte_limit(context, argv[0], &limit)) return;
    int index = 1;
    while (index < argc && !is_oversized(argv[index], limit)) index++;
    if (index == argc) return;
    sqlite3_str *output = sqlite3_str_new(0);
    for (index = 1; index < argc; index++) {
        if (index > 1) sqlite3_str_appendchar(output, 1, '|');
        if (is_oversized(argv[index], limit)) {
            sqlite3_str_appendf(output, "%c%d",
                sqlite3_value_type(argv[index]) == SQLITE_TEXT ? 't' : 'b',
                sqlite3_value_bytes(argv[index]));
        }
    }
    int rc = sqlite3_str_errcode(output);
    int length = sqlite3_str_length(output);
    char *tokens = sqlite3_str_finish(output);
    if (rc != SQLITE_OK || !tokens) {
        sqlite3_free(tokens);
        if (rc == SQLITE_TOOBIG) sqlite3_result_error_toobig(context);
        else sqlite3_result_error_nomem(context);
        return;
    }
    sqlite3_result_text(context, tokens, length, sqlite3_free);
}

/* Shortest-form UTF-8 scalar values with no NUL, no leading BOM and neither
 * U+FFFE nor U+FFFF. Both engines decode such bytes to a string that encodes
 * back to them; anything else needs the stored bytes. Returns the string's
 * UTF-16 length, or -1 when the bytes are not plain. */
static int plain_utf8_units(const unsigned char *text, int length) {
    if (length >= 3 && text[0] == 0xef && text[1] == 0xbb && text[2] == 0xbf) return -1;
    int index = 0, units = 0;
    while (index < length) {
        unsigned lead = text[index];
        if (lead < 0x80) {
            if (!lead) return -1;
            index++;
            units++;
            continue;
        }
        int extra = lead >= 0xc2 && lead <= 0xdf ? 1
            : lead >= 0xe0 && lead <= 0xef ? 2
            : lead >= 0xf0 && lead <= 0xf4 ? 3 : 0;
        if (!extra || length - index <= extra) return -1;
        unsigned point = lead & (0x3fu >> extra);
        for (int offset = 1; offset <= extra; offset++) {
            unsigned next = text[index + offset];
            if ((next & 0xc0) != 0x80) return -1;
            point = (point << 6) | (next & 0x3f);
        }
        if (extra == 2 && (point < 0x800 || (point >= 0xd800 && point <= 0xdfff) || point >= 0xfffe)) return -1;
        if (extra == 3 && (point < 0x10000 || point > 0x10ffff)) return -1;
        index += extra + 1;
        units += extra == 3 ? 2 : 1;
    }
    return units;
}

static int is_plain_utf8(const unsigned char *text, int length) {
    return plain_utf8_units(text, length) >= 0;
}

/* For TEXT of at most limit bytes: NULL when is_plain_utf8, else its bytes as
 * a BLOB. 0 for longer TEXT and NULL for other values, so the common cells
 * cost nothing to transport. */
static void cell_text_check(sqlite3_context *context, int argc, sqlite3_value **argv) {
    sqlite3_int64 limit;
    (void) argc;
    if (!byte_limit(context, argv[1], &limit)) return;
    if (sqlite3_value_type(argv[0]) != SQLITE_TEXT) return;
    const unsigned char *text = sqlite3_value_text(argv[0]);
    int length = sqlite3_value_bytes(argv[0]);
    if (!text) { sqlite3_result_error_nomem(context); return; }
    if (length > limit) sqlite3_result_int(context, 0);
    else if (!is_plain_utf8(text, length)) sqlite3_result_blob(context, text, length, SQLITE_TRANSIENT);
}

static unsigned char fold_ascii(unsigned char c) {
    return c >= 'A' && c <= 'Z' ? (unsigned char) (c | 0x20) : c;
}

static int contains_folded(const unsigned char *text, int length, const unsigned char *needle, int size) {
    for (int start = 0; start + size <= length; start++) {
        int index = 0;
        while (index < size && fold_ascii(text[start + index]) == fold_ascii(needle[index])) index++;
        if (index == size) return 1;
    }
    return 0;
}

/* An ASCII needle in NUL-terminated text, stopping at the first NUL as LIKE
 * does. The needle holds no NUL, so a compare never passes the text's. */
static int contains_ascii(const unsigned char *text, const unsigned char *needle, int size) {
    if (!size) return 1;
    unsigned char first = fold_ascii(needle[0]);
    for (const unsigned char *at = text; *at; at++) {
        if (fold_ascii(*at) != first) continue;
        int index = 1;
        while (index < size && fold_ascii(at[index]) == fold_ascii(needle[index])) index++;
        if (index == size) return 1;
    }
    return 0;
}

/* Whether any argument after the first matches LIKE '%needle%' ESCAPE '\'
 * with the first argument as the literal needle: 1, 0, or NULL when only
 * SQLite's LIKE can tell. LIKE folds ASCII case only and stops at a NUL.
 * Its UTF-8 reader returns every byte below 0x80 as itself and never decodes
 * other bytes to one, so an ASCII needle is searched in any text's bytes. A
 * non-ASCII needle is compared byte by byte only with plain UTF-8
 * (is_plain_utf8); other TEXT gives NULL unless a plain value matched. A
 * needle that is not plain, or that LIKE could refuse as too long, always
 * gives NULL. BLOBs never match LIKE in a LIKE_DOESNT_MATCH_BLOBS build and
 * are text in any other. INTEGER and REAL text holds only digits, '-', '+',
 * '.', 'e' and "Inf", so a needle with any other character never matches one
 * and skips its conversion. The caller must not use this under
 * PRAGMA case_sensitive_like. */
static void like_any(sqlite3_context *context, int argc, sqlite3_value **argv) {
    if (argc < 2) {
        sqlite3_result_error(context, "sqlite_explorer_like_any needs a needle and a value", -1);
        return;
    }
    if (sqlite3_value_type(argv[0]) != SQLITE_TEXT) return;
    const unsigned char *needle = sqlite3_value_text(argv[0]);
    int size = sqlite3_value_bytes(argv[0]);
    if (!needle) { sqlite3_result_error_nomem(context); return; }
    /* Escaping at most doubles the needle inside its two '%'. */
    int pattern_limit = sqlite3_limit(sqlite3_context_db_handle(context), SQLITE_LIMIT_LIKE_PATTERN_LENGTH, -1);
    if ((sqlite3_int64) size * 2 + 2 > pattern_limit) return;
    int ascii = 1, integer_text = 1, real_text = 1;
    for (int index = 0; index < size; index++) {
        unsigned char c = fold_ascii(needle[index]);
        int digit = c >= '0' && c <= '9';
        if (!c || c >= 0x80) ascii = 0;
        if (!digit && c != '-') integer_text = 0;
        if (!digit && c != '-' && c != '+' && c != '.' && c != 'e' && c != 'i' && c != 'n' && c != 'f') real_text = 0;
    }
    if (!ascii && !is_plain_utf8(needle, size)) return;
    int blobs_match = sqlite3_user_data(context) != 0;
    int undecided = 0;
    for (int index = 1; index < argc; index++) {
        int type = sqlite3_value_type(argv[index]);
        if (type == SQLITE_NULL
            || (type == SQLITE_INTEGER && !integer_text)
            || (type == SQLITE_FLOAT && !real_text)
            || (type == SQLITE_BLOB && !blobs_match)) continue;
        const unsigned char *text = sqlite3_value_text(argv[index]);
        int length = sqlite3_value_bytes(argv[index]);
        if (!text) {
            if (length) { sqlite3_result_error_nomem(context); return; }
            text = (const unsigned char *) "";
        }
        int found;
        if (ascii) {
            found = contains_ascii(text, needle, size);
        } else if ((type == SQLITE_TEXT || type == SQLITE_BLOB) && !is_plain_utf8(text, length)) {
            undecided = 1;
            continue;
        } else {
            found = contains_folded(text, length, needle, size);
        }
        if (found) {
            sqlite3_result_int(context, 1);
            return;
        }
    }
    if (!undecided) sqlite3_result_int(context, 0);
}

/* SQLite's text for each REAL argument after the first, as "index:text"
 * joined by '|', where index counts from the first argument's value. NULL
 * when no argument is REAL. The text comes from a copy of the value, so it is
 * exactly what CAST(value AS TEXT) produces. One packed column per row costs
 * a native row object far less than one mostly-NULL column per value. */
static void real_texts(sqlite3_context *context, int argc, sqlite3_value **argv) {
    sqlite3_int64 base;
    if (argc < 2) {
        sqlite3_result_error(context, "REAL text packing requires a base index and at least one value.", -1);
        return;
    }
    if (!byte_limit(context, argv[0], &base)) return;
    sqlite3_str *output = 0;
    for (int index = 1; index < argc; index++) {
        if (sqlite3_value_type(argv[index]) != SQLITE_FLOAT) continue;
        sqlite3_value *copy = sqlite3_value_dup(argv[index]);
        const unsigned char *text = copy ? sqlite3_value_text(copy) : 0;
        if (!text) {
            sqlite3_value_free(copy);
            sqlite3_free(output ? sqlite3_str_finish(output) : 0);
            sqlite3_result_error_nomem(context);
            return;
        }
        if (!output) output = sqlite3_str_new(0);
        else sqlite3_str_appendchar(output, 1, '|');
        sqlite3_str_appendf(output, "%lld:%s", base + index - 1, (const char *) text);
        sqlite3_value_free(copy);
    }
    if (!output) return;
    int rc = sqlite3_str_errcode(output);
    int length = sqlite3_str_length(output);
    char *packed = sqlite3_str_finish(output);
    if (rc != SQLITE_OK || !packed) {
        sqlite3_free(packed);
        if (rc == SQLITE_TOOBIG) sqlite3_result_error_toobig(context);
        else sqlite3_result_error_nomem(context);
        return;
    }
    sqlite3_result_text(context, packed, length, sqlite3_free);
}

/*
 * One BLOB per row chunk of at most 100 values carrying what the four helpers
 * above return for each value: cell_preview's value, cell_metadata's
 * oversized length, cell_text_check's verdict or bytes, and real_texts' text.
 * Every number is little-endian.
 *
 *   u8 version (1), u8 value count, u32 offset of the text area
 *   per value: u8 tag, then
 *     0 NULL
 *     1 INTEGER   i64
 *     2 REAL      f64, u8 length, SQLite's text for it
 *     3 TEXT      u32 UTF-16 length, u32 byte length; bytes in the text area
 *     4 TEXT      u32 byte length, bytes (not plain UTF-8)
 *     5 TEXT      u32 stored byte length, u32 UTF-16 length, u32 preview byte
 *                 length; preview bytes in the text area (oversized)
 *     6 TEXT      u32 stored byte length, u32 preview byte length, preview
 *                 bytes (oversized, preview not plain UTF-8)
 *     7 BLOB      u32 byte length, bytes
 *     8 BLOB      u32 stored byte length, u32 preview byte length, bytes
 *   text area: the plain UTF-8 bytes of tags 3 and 5, in value order, which
 *   the reader decodes with one call per chunk
 */
#define PACK_MAX_VALUES 100
#define PACK_MAX_REAL_TEXT 255

struct pack_cell {
    int tag;
    const unsigned char *bytes;
    int length;   /* bytes carried: whole value or preview */
    int stored;   /* stored byte length of an oversized value */
    int units;    /* UTF-16 length of plain text */
    sqlite3_value *copy;
};

static unsigned char *put_u32(unsigned char *out, sqlite3_uint64 value) {
    for (int index = 0; index < 4; index++) out[index] = (unsigned char) (value >> (8 * index));
    return out + 4;
}

static unsigned char *put_u64(unsigned char *out, sqlite3_uint64 value) {
    for (int index = 0; index < 8; index++) out[index] = (unsigned char) (value >> (8 * index));
    return out + 8;
}

static unsigned char *put_bytes(unsigned char *out, const unsigned char *bytes, int length) {
    for (int index = 0; index < length; index++) out[index] = bytes[index];
    return out + length;
}

static void cell_pack(sqlite3_context *context, int argc, sqlite3_value **argv) {
    sqlite3_int64 limit, characters;
    struct pack_cell cells[PACK_MAX_VALUES];
    int count = argc - 2;
    if (count < 1 || count > PACK_MAX_VALUES) {
        sqlite3_result_error(context, "Grid cell packing requires two limits and 1 to 100 values.", -1);
        return;
    }
    if (!byte_limit(context, argv[0], &limit) || !byte_limit(context, argv[1], &characters)) return;
    sqlite3_uint64 descriptors = 0, area = 0;
    int ready = 0, failed = 0;
    for (; ready < count; ready++) {
        sqlite3_value *value = argv[ready + 2];
        struct pack_cell *cell = &cells[ready];
        cell->copy = 0;
        int type = sqlite3_value_type(value);
        if (type == SQLITE_INTEGER) {
            cell->tag = 1;
            descriptors += 9;
        } else if (type == SQLITE_FLOAT) {
            /* real_texts' conversion, on a copy so the argument stays REAL. */
            cell->tag = 2;
            cell->copy = sqlite3_value_dup(value);
            cell->bytes = cell->copy ? sqlite3_value_text(cell->copy) : 0;
            if (!cell->bytes) { failed = SQLITE_NOMEM; ready++; break; }
            cell->length = sqlite3_value_bytes(cell->copy);
            if (cell->length < 1 || cell->length > PACK_MAX_REAL_TEXT) { failed = SQLITE_ERROR; ready++; break; }
            descriptors += 10 + (sqlite3_uint64) cell->length;
        } else if (type == SQLITE_TEXT) {
            const unsigned char *text = sqlite3_value_text(value);
            int length = sqlite3_value_bytes(value);
            if (!text) { failed = SQLITE_NOMEM; break; }
            cell->bytes = text;
            if (length > limit) {
                cell->stored = length;
                cell->length = text_prefix_bytes(text, length, characters);
                cell->units = plain_utf8_units(text, cell->length);
                cell->tag = cell->units >= 0 ? 5 : 6;
            } else {
                cell->length = length;
                cell->units = plain_utf8_units(text, length);
                cell->tag = cell->units >= 0 ? 3 : 4;
            }
            if (cell->tag == 3) { descriptors += 9; area += (sqlite3_uint64) cell->length; }
            else if (cell->tag == 4) descriptors += 5 + (sqlite3_uint64) cell->length;
            else if (cell->tag == 5) { descriptors += 13; area += (sqlite3_uint64) cell->length; }
            else descriptors += 9 + (sqlite3_uint64) cell->length;
        } else if (type == SQLITE_BLOB) {
            const unsigned char *blob = sqlite3_value_blob(value);
            int length = sqlite3_value_bytes(value);
            if (!blob && length > 0) { failed = SQLITE_NOMEM; break; }
            cell->bytes = blob;
            if (length > limit) {
                cell->tag = 8;
                cell->stored = length;
                cell->length = (int) limit;
                descriptors += 9 + (sqlite3_uint64) limit;
            } else {
                cell->tag = 7;
                cell->length = length;
                descriptors += 5 + (sqlite3_uint64) length;
            }
        } else {
            cell->tag = 0;
            descriptors += 1;
        }
    }
    unsigned char *output = 0;
    sqlite3_uint64 total = 6 + descriptors + area;
    if (!failed && total > 0x7fffffff) failed = SQLITE_TOOBIG;
    if (!failed) {
        output = sqlite3_malloc64(total);
        if (!output) failed = SQLITE_NOMEM;
    }
    if (!failed) {
        unsigned char *out = output, *text = output + 6 + descriptors;
        *out++ = 1;
        *out++ = (unsigned char) count;
        out = put_u32(out, 6 + descriptors);
        for (int index = 0; index < count; index++) {
            struct pack_cell *cell = &cells[index];
            sqlite3_value *value = argv[index + 2];
            *out++ = (unsigned char) cell->tag;
            if (cell->tag == 1) {
                out = put_u64(out, (sqlite3_uint64) sqlite3_value_int64(value));
            } else if (cell->tag == 2) {
                union { double real; sqlite3_uint64 bits; } number;
                number.real = sqlite3_value_double(value);
                out = put_u64(out, number.bits);
                *out++ = (unsigned char) cell->length;
                out = put_bytes(out, cell->bytes, cell->length);
            } else if (cell->tag == 3) {
                out = put_u32(out, (sqlite3_uint64) cell->units);
                out = put_u32(out, (sqlite3_uint64) cell->length);
                text = put_bytes(text, cell->bytes, cell->length);
            } else if (cell->tag == 4 || cell->tag == 7) {
                out = put_u32(out, (sqlite3_uint64) cell->length);
                out = put_bytes(out, cell->bytes, cell->length);
            } else if (cell->tag == 5) {
                out = put_u32(out, (sqlite3_uint64) cell->stored);
                out = put_u32(out, (sqlite3_uint64) cell->units);
                out = put_u32(out, (sqlite3_uint64) cell->length);
                text = put_bytes(text, cell->bytes, cell->length);
            } else if (cell->tag == 6 || cell->tag == 8) {
                out = put_u32(out, (sqlite3_uint64) cell->stored);
                out = put_u32(out, (sqlite3_uint64) cell->length);
                out = put_bytes(out, cell->bytes, cell->length);
            }
        }
    }
    for (int index = 0; index < ready; index++) sqlite3_value_free(cells[index].copy);
    if (failed == SQLITE_NOMEM) sqlite3_result_error_nomem(context);
    else if (failed == SQLITE_TOOBIG) sqlite3_result_error_toobig(context);
    else if (failed) sqlite3_result_error(context, "Grid cell packing received unsupported REAL text.", -1);
    else sqlite3_result_blob64(context, output, total, sqlite3_free);
}

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_sqliteexplorer_init(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
    SQLITE_EXTENSION_INIT2(api);
    (void) error;
    /* DIRECTONLY keeps schema code (views, triggers, CHECK, DEFAULT,
     * generated columns, indexes) from calling any of these. */
    int rc = sqlite3_create_function_v2(db, "sqlite_explorer_query_plan", -1,
        SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, query_plan, 0, 0, 0);
    if (rc == SQLITE_OK) rc = sqlite3_create_function_v2(db, "sqlite_explorer_cell_preview", 3,
        SQLITE_UTF8 | SQLITE_DIRECTONLY | SQLITE_DETERMINISTIC, 0, cell_preview, 0, 0, 0);
    if (rc == SQLITE_OK) rc = sqlite3_create_function_v2(db, "sqlite_explorer_cell_metadata", -1,
        SQLITE_UTF8 | SQLITE_DIRECTONLY | SQLITE_DETERMINISTIC, 0, cell_metadata, 0, 0, 0);
    if (rc == SQLITE_OK) rc = sqlite3_create_function_v2(db, "sqlite_explorer_cell_text_check", 2,
        SQLITE_UTF8 | SQLITE_DIRECTONLY | SQLITE_DETERMINISTIC, 0, cell_text_check, 0, 0, 0);
    if (rc == SQLITE_OK) rc = sqlite3_create_function_v2(db, "sqlite_explorer_real_texts", -1,
        SQLITE_UTF8 | SQLITE_DIRECTONLY | SQLITE_DETERMINISTIC, 0, real_texts, 0, 0, 0);
    if (rc == SQLITE_OK) rc = sqlite3_create_function_v2(db, "sqlite_explorer_cell_pack", -1,
        SQLITE_UTF8 | SQLITE_DIRECTONLY | SQLITE_DETERMINISTIC, 0, cell_pack, 0, 0, 0);
    /* Non-NULL user data: this SQLite's LIKE can match a BLOB. */
    if (rc == SQLITE_OK) rc = sqlite3_create_function_v2(db, "sqlite_explorer_like_any", -1,
        SQLITE_UTF8 | SQLITE_DIRECTONLY | SQLITE_DETERMINISTIC,
        sqlite3_compileoption_used("LIKE_DOESNT_MATCH_BLOBS") ? 0 : (void *) db, like_any, 0, 0, 0);
    return rc;
}

#ifdef SQLITE_CORE
/* Emscripten calls this once before creating the first database. */
int sqlite_explorer_register_query_plan(void) {
    return sqlite3_auto_extension((void (*)(void)) sqlite3_sqliteexplorer_init);
}
#endif
