/*
** Sanitizer driver for scripts/lib/sqlite-math-patch.mjs: the changes the
** WebAssembly build makes to SQLite for schemas that use a math function.
** scripts/test-runtime-sanitizers.mjs compiles the patched amalgamation with
** AddressSanitizer and UndefinedBehaviorSanitizer and runs this against it;
** its mutation arm then breaks the patch in one place at a time and requires
** this driver to fail.
**
** The patched SQLite cannot build an index on a math function, so each one
** is created on a plain column and its definition is then rewritten in
** sqlite_schema. Its keys are therefore wrong for the expression: a
** statement that reads the index returns the wrong rows, which is how a
** place that still uses it shows up here.
*/
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sqlite3.h"

static int failures = 0;

static void fail(const char *zWhat, const char *zSql, const char *zDetail){
  failures++;
  fprintf(stderr, "FAIL %s: %s%s%s\n", zWhat, zSql, zDetail ? " -> " : "", zDetail ? zDetail : "");
}

static void run(sqlite3 *db, const char *zSql){
  char *zErr = 0;
  if( sqlite3_exec(db, zSql, 0, 0, &zErr)!=SQLITE_OK ){
    fail("statement must run", zSql, zErr);
  }
  sqlite3_free(zErr);
}

/* The statement must fail with a message that contains zNeedle. */
static void refused(sqlite3 *db, const char *zSql, const char *zNeedle){
  char *zErr = 0;
  if( sqlite3_exec(db, zSql, 0, 0, &zErr)==SQLITE_OK ){
    fail("statement must be refused", zSql, 0);
  }else if( zErr==0 || strstr(zErr, zNeedle)==0 ){
    fail("statement refused for another reason", zSql, zErr);
  }
  sqlite3_free(zErr);
}

/* All result values of zSql, joined: columns by ',' and rows by ';'. */
static char *result(sqlite3 *db, const char *zSql){
  sqlite3_stmt *pStmt = 0;
  sqlite3_str *pOut = sqlite3_str_new(db);
  int rc = sqlite3_prepare_v2(db, zSql, -1, &pStmt, 0);
  if( rc!=SQLITE_OK ){
    fail("query must compile", zSql, sqlite3_errmsg(db));
    return sqlite3_str_finish(pOut);
  }
  while( (rc = sqlite3_step(pStmt))==SQLITE_ROW ){
    int i;
    for(i=0; i<sqlite3_column_count(pStmt); i++){
      const unsigned char *z = sqlite3_column_text(pStmt, i);
      sqlite3_str_appendf(pOut, "%s%s", i ? "," : "", z ? (const char*)z : "NULL");
    }
    sqlite3_str_appendall(pOut, ";");
  }
  if( rc!=SQLITE_DONE ) fail("query must finish", zSql, sqlite3_errmsg(db));
  sqlite3_finalize(pStmt);
  return sqlite3_str_finish(pOut);
}

/* sqlite3_str_finish() gives NULL for a result without rows. */
static void expect(sqlite3 *db, const char *zSql, const char *zExpected){
  char *z = result(db, zSql);
  const char *zActual = z ? z : "";
  if( strcmp(zActual, zExpected)!=0 ) fail("wrong result", zSql, zActual);
  sqlite3_free(z);
}

/* The plan of zSql must name zIndex, or must not. */
static void plan(sqlite3 *db, const char *zSql, const char *zIndex, int uses){
  char *zExplain = sqlite3_mprintf("EXPLAIN QUERY PLAN %s", zSql);
  char *z = result(db, zExplain);
  int found = z!=0 && strstr(z, zIndex)!=0;
  if( found!=uses ) fail(uses ? "plan must use the index" : "plan must not use the index", zSql, z ? z : "");
  sqlite3_free(z);
  sqlite3_free(zExplain);
}

/* Give index zName the definition zSql; the caller reloads the schema. */
static void redefine(sqlite3 *db, const char *zName, const char *zSql){
  char *z = sqlite3_mprintf("UPDATE sqlite_schema SET sql = %Q WHERE name = %Q", zSql, zName);
  run(db, z);
  if( sqlite3_changes(db)!=1 ) fail("index to redefine not found", zName, 0);
  sqlite3_free(z);
}

static const char *INDEX_REFUSAL = "depends on a math function";
static const char *TABLE_REFUSAL = "stores a generated column that depends on a math function";

int main(void){
  sqlite3 *db = 0;
  sqlite3 *db2 = 0;
  sqlite3_int64 nImage = 0;
  unsigned char *aImage;
  sqlite3_str *pChain;
  char *zChain;
  int i;

  if( sqlite3_open(":memory:", &db)!=SQLITE_OK ) return 2;
  run(db,
    "CREATE TABLE e(id INTEGER PRIMARY KEY, x REAL, note TEXT);"
    "INSERT INTO e(x, note) VALUES (3, 'three'), (5, 'five'), (2.5, 'half');"
    "CREATE INDEX e_ln ON e(x);"
    "CREATE UNIQUE INDEX e_uniq ON e(id, x);"
    "CREATE TABLE p(id INTEGER PRIMARY KEY, x REAL, note TEXT);"
    "INSERT INTO p(x, note) VALUES (4, 'four'), (0.25, 'quarter');"
    "CREATE INDEX p_part ON p(note) WHERE x > 100;"
    "CREATE TABLE s(id INTEGER PRIMARY KEY, x REAL, y REAL GENERATED ALWAYS AS (pow(2, x)) STORED, note TEXT);"
    "CREATE TABLE v(id INTEGER PRIMARY KEY, x REAL, y REAL GENERATED ALWAYS AS (exp(x)) VIRTUAL, note TEXT);"
    "INSERT INTO v(x, note) VALUES (0, 'a'), (1, 'b');"
    "CREATE TABLE vi(id INTEGER PRIMARY KEY, x REAL, y REAL GENERATED ALWAYS AS (x) VIRTUAL, note TEXT);"
    "INSERT INTO vi(x, note) VALUES (1, 'a'), (4, 'b');"
    "CREATE INDEX vi_y ON vi(y);"
    "CREATE TABLE u1(id INTEGER PRIMARY KEY, x REAL, y REAL UNIQUE AS (x), note TEXT);"
    "INSERT INTO u1(x, note) VALUES (1, 'a'), (4, 'b');"
    "CREATE TABLE u2(id INTEGER PRIMARY KEY, x REAL, y REAL AS (x) UNIQUE NOT NULL, note TEXT);"
    "INSERT INTO u2(x, note) VALUES (1, 'a'), (4, 'b');"
    "CREATE TABLE o(id INTEGER PRIMARY KEY, x TEXT, note TEXT);"
    "INSERT INTO o(x, note) VALUES ('Xy', 'a'), ('Zw', 'b');"
    "CREATE INDEX o_lower ON o(lower(x));"
    "CREATE TABLE w(k TEXT PRIMARY KEY, x REAL, y REAL AS (ln(x)) STORED) WITHOUT ROWID;"
  );

  /* A chain of virtual columns, each reading the one before it, that ends in
  ** an indexed column: the dependency test must not follow it. */
  pChain = sqlite3_str_new(db);
  sqlite3_str_appendall(pChain, "CREATE TABLE chain(id INTEGER PRIMARY KEY, x REAL, c0 REAL AS (x)");
  for(i=1; i<200; i++) sqlite3_str_appendf(pChain, ", c%d REAL AS (c%d + 0)", i, i-1);
  sqlite3_str_appendall(pChain, "); INSERT INTO chain(x) VALUES (1), (4); CREATE INDEX chain_last ON chain(c199);");
  zChain = sqlite3_str_finish(pChain);
  run(db, zChain);
  sqlite3_free(zChain);

  /* Now make the schema say what a native engine would have written. */
  run(db, "PRAGMA writable_schema = ON");
  redefine(db, "e_ln", "CREATE INDEX e_ln ON e(ln(x))");
  redefine(db, "e_uniq", "CREATE UNIQUE INDEX e_uniq ON e(id, exp(x))");
  redefine(db, "p_part", "CREATE INDEX p_part ON p(note) WHERE exp(x) > 100");
  redefine(db, "vi", "CREATE TABLE vi(id INTEGER PRIMARY KEY, x REAL, y REAL GENERATED ALWAYS AS (ln(x)) VIRTUAL, note TEXT)");
  redefine(db, "u1", "CREATE TABLE u1(id INTEGER PRIMARY KEY, x REAL, y REAL UNIQUE AS (ln(x)), note TEXT)");
  redefine(db, "u2", "CREATE TABLE u2(id INTEGER PRIMARY KEY, x REAL, y REAL AS (ln(x)) UNIQUE NOT NULL, note TEXT)");
  {
    char *z = result(db, "SELECT replace(sql, 'c0 REAL AS (x)', 'c0 REAL AS (ln(x))') FROM sqlite_schema WHERE name = 'chain'");
    if( z && strlen(z)>1 ){
      z[strlen(z)-1] = 0;  /* the row separator */
      redefine(db, "chain", z);
    }else{
      fail("chain table not found", "chain", 0);
    }
    sqlite3_free(z);
  }
  run(db, "PRAGMA writable_schema = OFF");

  /* Read the image with a second connection, which loads the new schema. */
  aImage = sqlite3_serialize(db, "main", &nImage, 0);
  sqlite3_close(db);
  if( aImage==0 || sqlite3_open(":memory:", &db2)!=SQLITE_OK ) return 2;
  if( sqlite3_deserialize(db2, "main", aImage, nImage, nImage,
        SQLITE_DESERIALIZE_FREEONCLOSE|SQLITE_DESERIALIZE_RESIZEABLE)!=SQLITE_OK ) return 2;
  db = db2;

  /* Every table reads, and no statement reads a dependent index. */
  expect(db, "SELECT count(*) FROM e", "3;");
  expect(db, "SELECT id FROM e WHERE ln(x) = ln(3)", "1;");
  expect(db, "SELECT id FROM e ORDER BY ln(x)", "3;1;2;");
  expect(db, "SELECT id FROM e WHERE id = 2 AND exp(x) = exp(5)", "2;");
  expect(db, "SELECT note FROM p WHERE exp(x) > 100 AND note = 'four'", "");
  expect(db, "SELECT note FROM p WHERE exp(x) > 1 AND note = 'four'", "four;");
  expect(db, "SELECT id FROM vi WHERE y = ln(4)", "2;");
  expect(db, "SELECT id FROM u1 WHERE y = ln(4)", "2;");
  expect(db, "SELECT id FROM u2 WHERE y = ln(4)", "2;");
  expect(db, "SELECT count(DISTINCT y) FROM u2", "2;");
  expect(db, "SELECT 1 WHERE ln(4) IN (SELECT y FROM u2)", "1;");
  expect(db, "SELECT 1 WHERE 4 IN (SELECT y FROM u2)", "");
  expect(db, "SELECT count(*) FROM u2", "2;");
  expect(db, "SELECT id FROM chain WHERE c199 = ln(4)", "2;");
  expect(db, "SELECT id FROM v WHERE y = exp(1)", "2;");
  plan(db, "SELECT id FROM e WHERE ln(x) = ln(3)", "e_ln", 0);
  plan(db, "SELECT id FROM e WHERE id = 2 AND exp(x) = exp(5)", "e_uniq", 0);
  plan(db, "SELECT note FROM p WHERE exp(x) > 100 AND note = 'four'", "p_part", 0);
  plan(db, "SELECT id FROM vi WHERE y = ln(4)", "vi_y", 0);
  plan(db, "SELECT id FROM u1 WHERE y = ln(4)", "sqlite_autoindex_u1_1", 0);
  plan(db, "SELECT id FROM u2 WHERE y = ln(4)", "sqlite_autoindex_u2_1", 0);
  plan(db, "SELECT 1 WHERE ln(4) IN (SELECT y FROM u2)", "sqlite_autoindex_u2_1", 0);
  plan(db, "SELECT DISTINCT y FROM u2", "sqlite_autoindex_u2_1", 0);
  plan(db, "SELECT count(*) FROM u2", "sqlite_autoindex_u2_1", 0);
  plan(db, "SELECT id FROM chain WHERE c199 = ln(4)", "chain_last", 0);
  refused(db, "SELECT id FROM e INDEXED BY e_ln WHERE ln(x) = ln(3)", "no query solution");

  /* An index on a function that is not a math function is used as before,
  ** and so is one on a math function that cannot round differently. */
  expect(db, "SELECT id FROM o WHERE lower(x) = 'zw'", "2;");
  plan(db, "SELECT id FROM o WHERE lower(x) = 'zw'", "o_lower", 1);
  run(db, "CREATE TABLE fl(id INTEGER PRIMARY KEY, x REAL); INSERT INTO fl(x) VALUES (2.5), (7.25);"
          "CREATE INDEX fl_floor ON fl(floor(x)); CREATE INDEX fl_mod ON fl(mod(x, 2)) WHERE sqrt(x) > 1;"
          "INSERT INTO fl(x) VALUES (-0.5); UPDATE fl SET x = 9.5 WHERE id = 1; DELETE FROM fl WHERE id = 2;");
  expect(db, "SELECT id FROM fl WHERE floor(x) = 9", "1;");
  plan(db, "SELECT id FROM fl WHERE floor(x) = 9", "fl_floor", 1);
  expect(db, "PRAGMA integrity_check(fl)", "ok;");

  /* A write that must maintain a dependent index is refused. */
  refused(db, "INSERT INTO e(x, note) VALUES (9, 'new')", INDEX_REFUSAL);
  refused(db, "UPDATE e SET x = 7 WHERE id = 1", INDEX_REFUSAL);
  refused(db, "DELETE FROM e WHERE id = 1", INDEX_REFUSAL);
  refused(db, "INSERT INTO p(x, note) VALUES (9, 'new')", INDEX_REFUSAL);
  refused(db, "UPDATE p SET note = 'z' WHERE id = 1", INDEX_REFUSAL);
  refused(db, "INSERT INTO vi(x, note) VALUES (9, 'new')", INDEX_REFUSAL);
  refused(db, "INSERT INTO u1(x, note) VALUES (9, 'new')", INDEX_REFUSAL);
  refused(db, "INSERT INTO u2(x, note) VALUES (9, 'new')", INDEX_REFUSAL);
  refused(db, "INSERT INTO chain(x) VALUES (9)", INDEX_REFUSAL);
  refused(db, "CREATE INDEX o_exp ON o(exp(length(x)))", INDEX_REFUSAL);
  refused(db, "REINDEX e_ln", INDEX_REFUSAL);
  refused(db, "PRAGMA integrity_check", INDEX_REFUSAL);

  /* One that does not touch it runs. */
  run(db, "UPDATE e SET note = 'edited' WHERE id = 1");
  run(db, "UPDATE vi SET note = 'edited' WHERE id = 1");
  expect(db, "SELECT note FROM e WHERE id = 1", "edited;");

  /* A table that stores a math column is not modified; one whose math
  ** columns are all virtual and unindexed is. */
  refused(db, "INSERT INTO s(x, note) VALUES (1, 'new')", TABLE_REFUSAL);
  refused(db, "DELETE FROM s", TABLE_REFUSAL);
  refused(db, "INSERT INTO w(k, x) VALUES ('a', 3)", TABLE_REFUSAL);
  run(db, "INSERT INTO v(x, note) VALUES (2, 'new')");
  run(db, "UPDATE v SET x = 3 WHERE id = 1");
  run(db, "DELETE FROM v WHERE id = 2");
  expect(db, "SELECT count(*) FROM v", "2;");
  run(db, "INSERT INTO o(x, note) VALUES ('Q', 'new')");

  /* The rows the refused statements named are as they were. */
  expect(db, "SELECT id, x FROM e ORDER BY id", "1,3.0;2,5.0;3,2.5;");
  expect(db, "SELECT count(*) FROM p", "2;");

  sqlite3_close(db);
  if( failures ){
    fprintf(stderr, "%d math schema check(s) failed\n", failures);
    return 1;
  }
  printf("math schema checks passed\n");
  return 0;
}
