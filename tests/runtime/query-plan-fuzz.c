/*
 * Sanitizer and differential driver for src/runtime/query-plan.c.
 *
 * Built with -fsanitize=address,undefined against the pinned SQLite
 * amalgamation (SQLITE_CORE, so the helpers register as an auto extension).
 * It calls every grid helper with generated argument lists over values of
 * every storage class, read three ways (bound parameters, table columns, and
 * columns of a co-routine subquery, which is how engines read a page), in
 * UTF-8 and UTF-16 databases. Besides the sanitizers it checks:
 *   - cell_pack: the BLOB parses under the documented layout and its
 *     descriptor and text areas end exactly where the header says, and each
 *     REAL's text is SQLite's own CAST(x AS TEXT), for doubles and for
 *     integers SQLite holds as REAL (MEM_IntReal) of any magnitude;
 *   - cell_preview: equals the SQL it replaced (substr / whole value);
 *   - like_any: 1 or 0 agrees with OR-ed LIKE '%needle%' ESCAPE '\'.
 * The two SQL oracles run in UTF-8 databases only, where engines use them.
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sqlite3.h"

int sqlite_explorer_register_query_plan(void);

static uint64_t rng_state;
static uint64_t rng(void) {
    /* xorshift64*: full 2^64-1 period, no float arithmetic. */
    rng_state ^= rng_state >> 12;
    rng_state ^= rng_state << 25;
    rng_state ^= rng_state >> 27;
    return rng_state * 0x2545F4914F6CDD1DULL;
}
static unsigned pick(unsigned n) { return (unsigned) (rng() % n); }

static long failures, statements, rows_checked, packs_checked, previews_checked, likes_checked, likes_decided, real_texts_checked;
static uint64_t distinct_hash;
static long distinct_inputs;
#define SEEN_SLOTS (1u << 20)
static uint64_t *seen;

static void note_input(const char *sql, uint64_t bind_hash) {
    uint64_t h = 1469598103934665603ULL ^ bind_hash;
    for (const char *p = sql; *p; p++) h = (h ^ (unsigned char) *p) * 1099511628211ULL;
    unsigned slot = (unsigned) (h & (SEEN_SLOTS - 1));
    for (unsigned probe = 0; probe < 64; probe++) {
        uint64_t *at = &seen[(slot + probe) & (SEEN_SLOTS - 1)];
        if (*at == h) return;
        if (!*at) { *at = h; distinct_inputs++; return; }
    }
    distinct_inputs++;
}

static void fail(const char *what, const char *sql) {
    failures++;
    fprintf(stderr, "FAIL: %s\n  sql: %s\n", what, sql);
}

/* ---- value generation ---------------------------------------------------- */

static int gen_bytes(unsigned char *out, int cap) {
    static const int sizes[] = { 0, 0, 1, 2, 3, 4, 5, 7, 8, 15, 16, 17, 31, 63, 64, 65, 255, 256, 257, 300 };
    int n = sizes[pick(sizeof sizes / sizeof *sizes)];
    if (pick(40) == 0) n = 1000 + (int) pick(70000);
    if (n > cap) n = cap;
    unsigned mode = pick(8);
    for (int i = 0; i < n; ) {
        unsigned m = mode == 7 ? pick(7) : mode;
        if (m == 0) out[i++] = (unsigned char) (0x20 + pick(0x5f));              /* ASCII */
        else if (m == 1) out[i++] = (unsigned char) "0123456789-+.eEinfINF"[pick(21)]; /* numeric alphabet */
        else if (m == 2) {                                                        /* valid 2-4 byte scalar */
            unsigned kind = pick(3);
            unsigned cp = kind == 0 ? 0x80 + pick(0x780) : kind == 1 ? 0x800 + pick(0xf7ff) : 0x10000 + pick(0x100000);
            if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xe000;
            unsigned char buf[4]; int len;
            if (cp < 0x800) { buf[0] = 0xc0 | (cp >> 6); buf[1] = 0x80 | (cp & 0x3f); len = 2; }
            else if (cp < 0x10000) { buf[0] = 0xe0 | (cp >> 12); buf[1] = 0x80 | ((cp >> 6) & 0x3f); buf[2] = 0x80 | (cp & 0x3f); len = 3; }
            else { buf[0] = 0xf0 | (cp >> 18); buf[1] = 0x80 | ((cp >> 12) & 0x3f); buf[2] = 0x80 | ((cp >> 6) & 0x3f); buf[3] = 0x80 | (cp & 0x3f); len = 4; }
            for (int k = 0; k < len && i < n; k++) out[i++] = buf[k];
        }
        else if (m == 3) out[i++] = (unsigned char) pick(256);                    /* any byte */
        else if (m == 4) out[i++] = (unsigned char) (0x80 + pick(0x80));          /* high bytes only */
        else if (m == 5) out[i++] = pick(6) == 0 ? 0 : (unsigned char) (0x41 + pick(26)); /* NULs */
        else {                                                                    /* edge sequences */
            static const unsigned char edges[][4] = {
                { 0xef, 0xbb, 0xbf, 3 }, { 0xef, 0xbf, 0xbe, 3 }, { 0xef, 0xbf, 0xbf, 3 }, { 0xed, 0xa0, 0x80, 3 },
                { 0xc0, 0x80, 0, 2 }, { 0xe0, 0x80, 0x80, 3 }, { 0xf4, 0x90, 0x80, 3 }, { 0xf0, 0x9f, 0x98, 3 },
                { 0xc2, 0, 0, 1 }, { 0xe2, 0x82, 0, 2 }, { 0xff, 0, 0, 1 }, { 0x25, 0, 0, 1 }, { 0x5f, 0, 0, 1 }, { 0x5c, 0, 0, 1 } };
            const unsigned char *e = edges[pick(sizeof edges / sizeof *edges)];
            for (int k = 0; k < e[3] && i < n; k++) out[i++] = e[k];
        }
    }
    return n;
}

static const sqlite3_int64 int_edges[] = { 0, 1, -1, 28, 127, 255, 256, 65535, 2147483647LL, -2147483648LL, 2147483648LL,
    9007199254740992LL, 9007199254740993LL, INT64_MAX, INT64_MIN, 1730000000000LL };
static const double real_edges[] = { 0.0, -0.0, 0.1, 1.0, 5.0, -2.5, 1e308, 5e-324, 1.0 / 3.0, INFINITY, -INFINITY, 9.6529377952984946e+282,
    1e15, 1e16, 123456789.123456789, 4.9406564584124654e-324 };

#define SCRATCH (128 * 1024)
static unsigned char scratch[SCRATCH];

/* Bind one generated value and fold it into the input hash. utf16: database encoding is UTF-16. */
static void bind_value(sqlite3_stmt *stmt, int index, uint64_t *hash) {
    unsigned kind = pick(12);
    *hash = (*hash ^ kind) * 1099511628211ULL;
    if (kind == 0) sqlite3_bind_null(stmt, index);
    else if (kind <= 2) { sqlite3_int64 v = pick(3) ? int_edges[pick(sizeof int_edges / sizeof *int_edges)] : (sqlite3_int64) rng();
        *hash = (*hash ^ (uint64_t) v) * 1099511628211ULL; sqlite3_bind_int64(stmt, index, v); }
    else if (kind <= 4) { double v = real_edges[pick(sizeof real_edges / sizeof *real_edges)];
        uint64_t bits; memcpy(&bits, &v, 8); *hash = (*hash ^ bits) * 1099511628211ULL; sqlite3_bind_double(stmt, index, v); }
    else if (kind == 5) { int n = (int) pick(3) ? (int) pick(4096) : 0; *hash = (*hash ^ (uint64_t) n) * 1099511628211ULL; sqlite3_bind_zeroblob(stmt, index, n); }
    else {
        int n = gen_bytes(scratch, SCRATCH);
        for (int i = 0; i < n; i++) *hash = (*hash ^ scratch[i]) * 1099511628211ULL;
        if (kind <= 9) sqlite3_bind_text(stmt, index, (const char *) scratch, n, SQLITE_TRANSIENT);
        else sqlite3_bind_blob(stmt, index, scratch, n, SQLITE_TRANSIENT);
    }
}

/* ---- oracles ------------------------------------------------------------- */

static uint32_t get_u32(const unsigned char *p) { return (uint32_t) p[0] | (uint32_t) p[1] << 8 | (uint32_t) p[2] << 16 | (uint32_t) p[3] << 24; }

/* Walk a pack under the documented layout; every read is bounds-checked here,
 * so a layout the reader could run past is reported instead of trusted. */
static const char *check_pack(const unsigned char *pack, sqlite3_int64 size, int expected_values) {
    if (!pack || size < 6) return "pack shorter than its header";
    if (pack[0] != 1) return "unexpected version";
    if (pack[1] != expected_values) return "value count differs from the argument count";
    sqlite3_int64 text_offset = get_u32(pack + 2), at = 6, area = 0;
    if (text_offset < 6 || text_offset > size) return "text area offset outside the pack";
    for (int index = 0; index < expected_values; index++) {
        if (at >= text_offset) return "descriptor area ends before its values";
        unsigned tag = pack[at++];
        sqlite3_int64 need = 0, inline_bytes = 0;
        if (tag == 0) need = 0;
        else if (tag == 1) need = 8;
        else if (tag == 2) { if (at + 9 > text_offset) return "REAL descriptor truncated"; inline_bytes = pack[at + 8]; if (inline_bytes < 1) return "empty REAL text"; need = 9; }
        else if (tag == 3) { if (at + 8 > text_offset) return "tag 3 truncated"; if (get_u32(pack + at) > get_u32(pack + at + 4)) return "tag 3 UTF-16 length exceeds bytes"; area += get_u32(pack + at + 4); need = 8; }
        else if (tag == 4 || tag == 7) { if (at + 4 > text_offset) return "tag 4/7 truncated"; inline_bytes = get_u32(pack + at); need = 4; }
        else if (tag == 5) { if (at + 12 > text_offset) return "tag 5 truncated"; if (get_u32(pack + at + 8) > get_u32(pack + at)) return "tag 5 preview longer than the value"; area += get_u32(pack + at + 8); need = 12; }
        else if (tag == 6 || tag == 8) { if (at + 8 > text_offset) return "tag 6/8 truncated"; inline_bytes = get_u32(pack + at + 4); if (inline_bytes > get_u32(pack + at)) return "tag 6/8 preview longer than the value"; need = 8; }
        else return "unknown tag";
        at += need + inline_bytes;
        if (at > text_offset) return "descriptor runs into the text area";
    }
    if (at != text_offset) return "descriptor area does not end at the text offset";
    if (text_offset + area != size) return "text area does not end at the pack's end";
    return 0;
}

/* ---- statement generation ------------------------------------------------ */

static const char *limit_literals[] = { "0", "1", "2", "3", "4", "7", "8", "16", "64", "255", "256", "1000", "65536", "2147483647",
    "-1", "2147483648", "NULL", "'8'", "1.5", "x'01'", "9223372036854775807" };
static const char *good_limits[] = { "0", "1", "2", "3", "4", "7", "8", "16", "64", "255", "256", "1000", "65536", "2147483647" };
static const char *columns[] = { "a", "b", "c", "d", "e", "f", "g", "h" };
static const char *sources[] = {
    " FROM t",
    " FROM (SELECT * FROM t LIMIT -1 OFFSET 0)",
    " FROM (SELECT * FROM t ORDER BY a, b LIMIT -1 OFFSET 0)",
    " FROM t ORDER BY h, g",
    ""
};

struct sql { char *text; size_t length, cap; };
static void add(struct sql *s, const char *piece) {
    size_t n = strlen(piece);
    if (s->length + n + 1 > s->cap) { s->cap = (s->length + n + 1) * 2; s->text = realloc(s->text, s->cap); if (!s->text) abort(); }
    memcpy(s->text + s->length, piece, n + 1);
    s->length += n;
}

/* Appends `count` value arguments; returns how many '?' it used. from_table: column refs allowed. */
static int add_values(struct sql *s, int count, int from_table, int *binds) {
    for (int i = 0; i < count; i++) {
        add(s, ", ");
        if (from_table && pick(4)) add(s, columns[pick(8)]);
        else { add(s, "?"); (*binds)++; }
    }
    return count;
}

static int value_count(void) {
    static const int counts[] = { 1, 1, 2, 3, 5, 8, 13, 50, 99, 100, 100, 101, 102, 126, 127, 0 };
    return counts[pick(sizeof counts / sizeof *counts)];
}

static void run_statement(sqlite3 *db, int utf8_db) {
    struct sql s = { 0, 0, 0 };
    int binds = 0, values = 0, kind = (int) pick(100), oracle = 0, like_shape = 0;
    int source = (int) pick(5), from_table = sources[source][0] != 0;
    const char *limit = 0, *characters = 0;
    add(&s, "SELECT ");
    if (kind < 30) {            /* cell_pack */
        int strict = pick(8) != 0;
        limit = strict ? good_limits[pick(14)] : limit_literals[pick(21)];
        characters = strict ? good_limits[pick(14)] : limit_literals[pick(21)];
        values = value_count();
        add(&s, "sqlite_explorer_cell_pack("); add(&s, limit); add(&s, ", "); add(&s, characters);
        add_values(&s, values, from_table, &binds);
        add(&s, ")");
        oracle = strict && values >= 1 && values <= 100 ? 1 : 0;
    } else if (kind < 50) {     /* cell_preview with its SQL equivalent */
        int strict = pick(8) != 0;
        limit = strict ? good_limits[pick(14)] : limit_literals[pick(21)];
        characters = strict ? good_limits[pick(14)] : limit_literals[pick(21)];
        const char *v = from_table ? columns[pick(8)] : "?1";
        if (!from_table) binds = 1;
        char buf[1024];
        snprintf(buf, sizeof buf,
            "hex(sqlite_explorer_cell_preview(%s, %s, %s)), typeof(sqlite_explorer_cell_preview(%s, %s, %s)), "
            "hex(CASE WHEN typeof(%s) = 'text' AND octet_length(%s) > %s THEN substr(%s, 1, %s) "
            "WHEN typeof(%s) = 'blob' AND octet_length(%s) > %s THEN substr(%s, 1, %s) ELSE %s END), "
            "typeof(CASE WHEN typeof(%s) = 'text' AND octet_length(%s) > %s THEN substr(%s, 1, %s) "
            "WHEN typeof(%s) = 'blob' AND octet_length(%s) > %s THEN substr(%s, 1, %s) ELSE %s END)",
            v, limit, characters, v, limit, characters,
            v, v, limit, v, characters, v, v, limit, v, limit, v,
            v, v, limit, v, characters, v, v, limit, v, limit, v);
        add(&s, buf);
        oracle = strict && utf8_db ? 2 : 0;
    } else if (kind < 60) {     /* cell_metadata */
        limit = pick(8) ? good_limits[pick(14)] : limit_literals[pick(21)];
        add(&s, "sqlite_explorer_cell_metadata("); add(&s, limit);
        add_values(&s, value_count(), from_table, &binds);
        add(&s, ")");
    } else if (kind < 68) {     /* cell_text_check */
        limit = pick(8) ? good_limits[pick(14)] : limit_literals[pick(21)];
        add(&s, "sqlite_explorer_cell_text_check(");
        if (from_table && pick(4)) add(&s, columns[pick(8)]); else { add(&s, "?"); binds++; }
        add(&s, ", "); add(&s, limit); add(&s, ")");
    } else if (kind < 76) {     /* real_texts */
        limit = pick(8) ? good_limits[pick(14)] : limit_literals[pick(21)];
        add(&s, "sqlite_explorer_real_texts("); add(&s, limit);
        add_values(&s, value_count(), from_table, &binds);
        add(&s, ")");
    } else if (kind < 97) {     /* like_any with the LIKE chain it stands in for; ?1 needle, ?2 pattern */
        values = 1 + (int) pick(pick(6) ? 8 : 120);
        binds = 2;
        like_shape = 1;
        /* Engines always bind the needle; a column needle only checks memory safety. */
        int column_needle = from_table && pick(6) == 0;
        add(&s, "sqlite_explorer_like_any(");
        add(&s, column_needle ? columns[pick(8)] : "?1");
        struct sql chain = { 0, 0, 0 };
        add(&chain, "0");
        for (int i = 0; i < values; i++) {
            const char *v = from_table ? columns[pick(8)] : "?1";
            add(&s, ", "); add(&s, v);
            add(&chain, " OR COALESCE("); add(&chain, v); add(&chain, " LIKE ?2 ESCAPE '\\', 0)");
        }
        add(&s, "), ("); add(&s, chain.text); add(&s, ")");
        free(chain.text);
        oracle = utf8_db && !column_needle ? 3 : 0;
    } else {                    /* arity and type misuse of every helper */
        static const char *misuse[] = {
            "sqlite_explorer_cell_pack()", "sqlite_explorer_cell_pack(1)", "sqlite_explorer_cell_pack(1, 1)",
            "sqlite_explorer_cell_metadata()", "sqlite_explorer_cell_metadata(1)", "sqlite_explorer_real_texts()",
            "sqlite_explorer_real_texts(1)", "sqlite_explorer_like_any()", "sqlite_explorer_like_any('a')",
            "sqlite_explorer_like_any(1, 'a')", "sqlite_explorer_like_any(x'61', 'a')", "sqlite_explorer_like_any(NULL, 'a')",
            "sqlite_explorer_like_any('', '', NULL, 1, 1.5, x'')", "sqlite_explorer_query_plan()", "sqlite_explorer_query_plan(1)",
            "sqlite_explorer_query_plan('SELECT 1; SELECT 2')", "sqlite_explorer_query_plan('SELECT * FROM t WHERE a = ?', 1)",
            "sqlite_explorer_query_plan('SELECT sqlite_explorer_cell_pack(1, 1, a) FROM t')",
            "sqlite_explorer_query_plan('DELETE FROM t')", "sqlite_explorer_query_plan('SELECT ' || zeroblob(10))",
            "sqlite_explorer_cell_pack(8, 8, zeroblob(100000), zeroblob(0), CAST(zeroblob(9) AS TEXT))",
            "sqlite_explorer_cell_preview(zeroblob(100000), 16, 4)", "sqlite_explorer_cell_text_check(CAST(zeroblob(9) AS TEXT), 100)" };
        add(&s, misuse[pick(sizeof misuse / sizeof *misuse)]);
    }
    add(&s, sources[source]);

    sqlite3_stmt *stmt = 0;
    statements++;
    int rc = sqlite3_prepare_v2(db, s.text, -1, &stmt, 0);
    if (rc != SQLITE_OK) {
        /* Wrong arity for a fixed-arity helper and over-long argument lists fail here by design. */
        if (oracle) fail(sqlite3_errmsg(db), s.text);
        note_input(s.text, 0);
        free(s.text);
        return;
    }
    uint64_t hash = 0;
    if (like_shape) {
        /* Needle as TEXT (sometimes not), pattern = '%' + needle with \ % _ escaped + '%'. */
        unsigned char needle[512], pattern[1100];
        int n = gen_bytes(needle, pick(3) ? 12 : 500), p = 0;
        pattern[p++] = '%';
        for (int i = 0; i < n; i++) { if (needle[i] == '\\' || needle[i] == '%' || needle[i] == '_') pattern[p++] = '\\'; pattern[p++] = needle[i]; }
        pattern[p++] = '%';
        for (int i = 0; i < n; i++) hash = (hash ^ needle[i]) * 1099511628211ULL;
        sqlite3_bind_text(stmt, 1, (const char *) needle, n, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt, 2, (const char *) pattern, p, SQLITE_TRANSIENT);
    } else {
        for (int i = 1; i <= binds; i++) bind_value(stmt, i, &hash);
    }
    note_input(s.text, hash);
    int row_limit = 64;
    while (row_limit-- > 0 && (rc = sqlite3_step(stmt)) == SQLITE_ROW) {
        rows_checked++;
        /* Touch every result byte so a short or stale result is read under ASan. */
        const unsigned char *blob = sqlite3_column_blob(stmt, 0);
        int size = sqlite3_column_bytes(stmt, 0);
        unsigned checksum = 0;
        for (int i = 0; i < size; i++) checksum += blob[i];
        distinct_hash += checksum;
        if (oracle == 1) {
            packs_checked++;
            if (sqlite3_column_type(stmt, 0) != SQLITE_BLOB) fail("cell_pack did not return a BLOB", s.text);
            else { const char *problem = check_pack(blob, size, values); if (problem) fail(problem, s.text); }
        } else if (oracle == 2) {
            previews_checked++;
            const char *got = (const char *) sqlite3_column_text(stmt, 0), *got_type = (const char *) sqlite3_column_text(stmt, 1);
            const char *want = (const char *) sqlite3_column_text(stmt, 2), *want_type = (const char *) sqlite3_column_text(stmt, 3);
            if (strcmp(got ? got : "", want ? want : "") || strcmp(got_type, want_type)) fail("cell_preview differs from its SQL equivalent", s.text);
        } else if (oracle == 3) {
            likes_checked++;
            if (sqlite3_column_type(stmt, 0) != SQLITE_NULL) {
                likes_decided++;
                if ((sqlite3_column_int(stmt, 0) != 0) != (sqlite3_column_int(stmt, 1) != 0)) fail("like_any disagrees with LIKE", s.text);
            }
        }
    }
    if (rc != SQLITE_ROW && rc != SQLITE_DONE && oracle) {
        /* The only accepted failures on well-formed calls are SQLite's own size limits. */
        if (rc != SQLITE_TOOBIG && rc != SQLITE_NOMEM && !strstr(sqlite3_errmsg(db), "pattern too complex")) fail(sqlite3_errmsg(db), s.text);
    }
    sqlite3_finalize(stmt);
    free(s.text);
}

/* An integer result SQLite holds as REAL (MEM_IntReal). SQLite itself makes
 * one only of an integer within 2^47 written to a REAL column; the test control
 * makes one of any int64, which is how a larger one is checked. */
static void intreal(sqlite3_context *context, int argc, sqlite3_value **argv) {
    (void) argc;
    sqlite3_result_int64(context, sqlite3_value_int64(argv[0]));
    sqlite3_test_control(SQLITE_TESTCTRL_RESULT_INTREAL, context);
}

static const sqlite3_int64 intreal_edges[] = { 0, 1, -1, 140737488355327LL, 140737488355328LL, -140737488355328LL,
    9007199254740991LL, 9007199254740992LL, 9007199254740993LL, -9007199254740992LL, 1000000000000000LL,
    10000000000000000LL, 100000000000000000LL, 123456789012345678LL, 1000000000000000000LL, INT64_MAX, INT64_MIN };

/* Each packed REAL's text against CAST(x AS TEXT) of the same value: a double
 * and an integer held as REAL per row. */
static void check_real_texts(sqlite3 *db, int count) {
    sqlite3_stmt *stmt = 0;
    const char *sql = "SELECT sqlite_explorer_cell_pack(64, 16, ?1, intreal(?2)), CAST(?1 AS TEXT), CAST(intreal(?2) AS TEXT)";
    if (sqlite3_create_function(db, "intreal", 1, SQLITE_UTF8, 0, intreal, 0, 0) != SQLITE_OK
        || sqlite3_prepare_v2(db, sql, -1, &stmt, 0) != SQLITE_OK) { fail(sqlite3_errmsg(db), sql); return; }
    for (int index = 0; index < count; index++) {
        double real;
        unsigned kind = pick(4);
        if (kind == 0) real = real_edges[pick(sizeof real_edges / sizeof *real_edges)];
        else if (kind == 1) { do { uint64_t bits = rng(); memcpy(&real, &bits, 8); } while (real != real); }
        else if (kind == 2) real = (double) (sqlite3_int64) (rng() % 100000000) / pow(10.0, 1 + pick(6)) * (pick(2) ? 1 : -1);
        else real = (double) (sqlite3_int64) (rng() >> (1 + pick(63))) * (pick(2) ? 1 : -1);
        sqlite3_int64 integer = pick(3) ? intreal_edges[pick(sizeof intreal_edges / sizeof *intreal_edges)]
            : (sqlite3_int64) (rng() >> (1 + pick(63))) * (pick(2) ? 1 : -1);
        sqlite3_bind_double(stmt, 1, real);
        sqlite3_bind_int64(stmt, 2, integer);
        if (sqlite3_step(stmt) != SQLITE_ROW) { fail(sqlite3_errmsg(db), sql); break; }
        const unsigned char *pack = sqlite3_column_blob(stmt, 0);
        int size = sqlite3_column_bytes(stmt, 0);
        const char *problem = check_pack(pack, size, 2);
        if (problem) { fail(problem, sql); sqlite3_reset(stmt); continue; }
        int at = 6;
        for (int cell = 0; cell < 2; cell++) {
            const char *want = (const char *) sqlite3_column_text(stmt, 1 + cell);
            int length = pack[at + 9];
            if (pack[at] != 2) { fail("a REAL argument did not pack as REAL", sql); break; }
            if (!want || (int) strlen(want) != length || memcmp(pack + at + 10, want, (size_t) length) != 0) {
                char detail[160];
                snprintf(detail, sizeof detail, "packed REAL text %.*s differs from CAST AS TEXT %s", length, (const char *) pack + at + 10, want ? want : "NULL");
                fail(detail, sql);
            }
            real_texts_checked++;
            at += 10 + length;
        }
        sqlite3_reset(stmt);
    }
    sqlite3_finalize(stmt);
}

static void fill_table(sqlite3 *db, int utf8_db) {
    char *error = 0;
    if (sqlite3_exec(db, "CREATE TABLE t(a, b, c TEXT, d BLOB, e INTEGER, f REAL, g NUMERIC, h)", 0, 0, &error) != SQLITE_OK) { fprintf(stderr, "%s\n", error); exit(2); }
    /* In a UTF-16 database a bound UTF-8 TEXT is converted on the way in; CAST of a
     * BLOB stores its bytes as TEXT unchanged, which is how odd or invalid UTF-16 gets in. */
    sqlite3_stmt *plain = 0, *raw = 0;
    sqlite3_prepare_v2(db, "INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?, ?)", -1, &plain, 0);
    sqlite3_prepare_v2(db, "INSERT INTO t VALUES (CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), ?, ?, ?, ?, CAST(? AS TEXT))", -1, &raw, 0);
    for (int row = 0; row < 48; row++) {
        sqlite3_stmt *stmt = (!utf8_db || pick(3) == 0) && pick(2) ? raw : plain;
        uint64_t hash = 0;
        for (int i = 1; i <= 8; i++) bind_value(stmt, i, &hash);
        if (sqlite3_step(stmt) != SQLITE_DONE) { fprintf(stderr, "insert: %s\n", sqlite3_errmsg(db)); exit(2); }
        sqlite3_reset(stmt);
    }
    sqlite3_finalize(plain);
    sqlite3_finalize(raw);
}

int main(int argc, char **argv) {
    uint64_t seed = argc > 1 ? strtoull(argv[1], 0, 10) : 1;
    long databases = argc > 2 ? atol(argv[2]) : 30, per_database = argc > 3 ? atol(argv[3]) : 2000;
    static const char *encodings[] = { "UTF-8", "UTF-16le", "UTF-16be" };
    seen = calloc(SEEN_SLOTS, sizeof *seen);
    if (!seen) return 2;
    if (sqlite_explorer_register_query_plan() != SQLITE_OK) { fprintf(stderr, "registration failed\n"); return 2; }
    for (long index = 0; index < databases; index++) {
        rng_state = (seed + (uint64_t) index) * 0x9E3779B97F4A7C15ULL + 1;
        for (int warm = 0; warm < 8; warm++) rng();
        const char *encoding = encodings[index % 3];
        sqlite3 *db = 0;
        if (sqlite3_open(":memory:", &db) != SQLITE_OK) return 2;
        char pragma[64];
        snprintf(pragma, sizeof pragma, "PRAGMA encoding = '%s'", encoding);
        sqlite3_exec(db, pragma, 0, 0, 0);
        /* A fifth of the databases lower SQLite's limits, as a host may. */
        fill_table(db, index % 3 == 0);
        if (index % 5 == 4) { sqlite3_limit(db, SQLITE_LIMIT_LENGTH, 100000); sqlite3_limit(db, SQLITE_LIMIT_LIKE_PATTERN_LENGTH, 40); }
        for (long step = 0; step < per_database; step++) run_statement(db, index % 3 == 0);
        check_real_texts(db, 400);
        if (sqlite3_close(db) != SQLITE_OK) { fprintf(stderr, "close: %s\n", sqlite3_errmsg(db)); failures++; }
    }
    printf("seed %llu: %ld statements (%ld distinct inputs), %ld rows; packs %ld, previews %ld, likes %ld (%ld decided), REAL texts %ld; failures %ld\n",
        (unsigned long long) seed, statements, distinct_inputs, rows_checked, packs_checked, previews_checked, likes_checked, likes_decided,
        real_texts_checked, failures);
    free(seen);
    /* Release SQLite's own allocations so a leak report names only real leaks. */
    sqlite3_reset_auto_extension();
    sqlite3_shutdown();
    return failures ? 1 : 0;
}
