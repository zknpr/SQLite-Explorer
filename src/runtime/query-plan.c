/*
 * Bounded EXPLAIN QUERY PLAN reader, compiled into sql.js and as a native
 * loadable SQLite extension. Only this file owns plan extraction: neither
 * JavaScript binding has to materialize an unbounded detail string or array.
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

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_sqliteexplorer_init(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
    SQLITE_EXTENSION_INIT2(api);
    (void) error;
    return sqlite3_create_function_v2(db, "sqlite_explorer_query_plan", -1,
        SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, query_plan, 0, 0, 0);
}

#ifdef SQLITE_CORE
/* Emscripten calls this once before creating the first database. */
int sqlite_explorer_register_query_plan(void) {
    return sqlite3_auto_extension((void (*)(void)) sqlite3_sqliteexplorer_init);
}
#endif
