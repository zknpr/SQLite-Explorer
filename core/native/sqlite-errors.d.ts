/** Type surface for core/native/sqlite-errors.js (plain JS — see that file's header). */

export interface SqliteResultCode {
    /** Symbolic name, e.g. `SQLITE_CONSTRAINT`. */
    name: string;
    /** Exactly what `sqlite3_errstr` returns for this code. */
    text: string;
    /** A factual clause naming what the class covers; empty when the text says it all. */
    detail: string;
}

export interface SqliteNameProbe {
    /** Compile-only `SELECT 1 FROM "name" WHERE 0`: does SQLite resolve the name? */
    resolves(name: string): boolean;
    /** Does the name have a row in `sqlite_schema` or `sqlite_temp_schema`? */
    inCatalog(name: string): boolean;
}

export interface SqlWordToken {
    kind: 'word' | 'identifier' | 'string' | 'symbol';
    value: string;
}

export const SQLITE_RESULT_CODES: Readonly<Record<number, SqliteResultCode>>;

export function describeResultCode(errno: number): SqliteResultCode | undefined;

export function hasOnlyCanonicalText(message: unknown, errno: number): boolean;

export function scanSqlWords(sql: string): SqlWordToken[];

export function extractTableReferences(sql: string): string[] | null;

export function findUnresolvedTableNames(
    names: readonly string[],
    probe: SqliteNameProbe
): string[];

export function buildSqliteErrorMessage(
    errno: number,
    message: unknown,
    sql: string | undefined,
    probe: SqliteNameProbe | undefined
): string | undefined;
