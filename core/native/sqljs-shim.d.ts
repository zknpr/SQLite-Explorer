/**
 * Types for sqljs-shim.js — the sql.js-shaped `Database` the desktop native
 * sidecar runs the existing worker method layer against.
 *
 * The shapes below describe the FORK's `tjs:sqlite` API (probe-verified), not
 * stock txiki.js and not node:sqlite: `Statement` has no cursor, `run()`
 * returns nothing, and the read-only option key is `readOnly`.
 */

/** A value as the fork's binding hands it back: int64 beyond 2^53 arrives as bigint. */
export type NativeValue = null | number | bigint | string | Uint8Array;

/** Parameters accepted by the backing binding. Always wrap positional params in an array. */
export type NativeBindParams = readonly NativeValue[] | Record<string, NativeValue>;

/** The fork's `Statement`: materialising only — `{finalize, toString, all, run}`. */
export interface NativeStatement {
    all(params?: NativeBindParams): Record<string, NativeValue>[];
    run(params?: NativeBindParams): void;
    finalize(): void;
    toString(): string;
}

/** The fork's sync `Database`. Optional members are absent on some backings. */
export interface NativeDatabase {
    exec(sql: string): void;
    prepare(sql: string): NativeStatement;
    close(): void;
    readonly inTransaction?: boolean;
    interrupt?(): void;
    setQueryDeadline?(ms: number): void;
    clearQueryDeadline?(): void;
}

/**
 * `readOnly` and `create` are mutually exclusive on the fork (together they
 * raise SQLITE_MISUSE), and passing any options object at all disables the
 * implicit create-on-open a bare `new Database(path)` performs.
 */
export interface NativeDatabaseConstructor {
    new(path?: string, options?: { readOnly?: boolean } | { create?: boolean }): NativeDatabase;
}

/**
 * Filesystem hooks used only by `export()` / `exportAsync()`.
 *
 * Each may be synchronous or promise-returning; `export()` requires the
 * synchronous flavour, `exportAsync()` accepts either.
 */
export interface ShimFileSystem {
    /**
     * Create a fresh directory and return its path.
     *
     * CONTRACT: the directory MUST be newly created, uniquely named, and
     * owner-only (mode 0700). `export()` writes a complete copy of the database
     * into it, so a shared or predictable directory would expose the user's data
     * to any other local process — and a pre-existing path would let a planted
     * symlink redirect the copy. `fs.mkdtempSync` and `tjs.makeTempDir` both
     * satisfy this; do not substitute a fixed path.
     */
    makeTempDir(): string | Promise<string>;
    readFile(path: string): Uint8Array | Promise<Uint8Array>;
    /** Remove a path recursively. */
    remove(path: string): void | Promise<void>;
}

export interface ShimDeps {
    sqlite: { Database: NativeDatabaseConstructor };
    fs?: ShimFileSystem;
    /**
     * Called when a best-effort cleanup fails (dropping a column-probe view,
     * removing an export temp directory). These never become the caller's error
     * — the hook exists so the sidecar can log them instead of losing them.
     * Throwing from the hook is swallowed.
     */
    onCleanupFailure?(error: unknown, context: string): void;
}

/**
 * `{ path, readOnly }` opens a file, `{}` opens an in-memory database.
 * `content` exists for sql.js signature parity and is always rejected — the
 * fork cannot deserialize bytes.
 */
export interface ShimConfig {
    path?: string;
    readOnly?: boolean;
    content?: Uint8Array;
}

/** sql.js's `get()`/`exec()` value options. */
export interface ShimValueConfig {
    useBigInt?: boolean;
}

/** One statement's result set, in sql.js's `exec()` shape. */
export interface ShimExecResult {
    columns: string[];
    values: NativeValue[][];
}

/** The sql.js `Statement` surface the worker method layer uses. */
export interface ShimStatement {
    bind(values?: NativeBindParams | null): boolean;
    step(): boolean;
    /**
     * The current row, or `[]` until `step()` has produced one. Reading the
     * current row executes nothing; passing `params` is sql.js's bind-and-step
     * overload, which does execute the statement.
     */
    get(params?: NativeBindParams | null, config?: ShimValueConfig): NativeValue[];
    /**
     * Column names, resolved without executing the statement wherever possible
     * (TEMP VIEW probe over the statement's parameter-free expansion). Returns
     * `[]` for statements that can be neither viewed nor safely run — notably
     * DML with a RETURNING clause, which sql.js would name.
     */
    getColumnNames(): string[];
    run(values?: NativeBindParams | null): boolean;
    reset(): boolean;
    /** The statement's own source text, matching sql.js's `sqlite3_sql` contract. */
    getSQL(): string;
    free(): boolean;
}

/** sql.js's `StatementIterator`. */
export interface ShimStatementIterator extends Iterable<ShimStatement> {
    next(): { value: ShimStatement; done: false } | { done: true; value?: undefined };
    /** Un-executed remainder of the original SQL, including trailing trivia. */
    getRemainingSQL(): string;
}

export interface ShimDatabase {
    exec(sql: string, params?: NativeBindParams | null, config?: ShimValueConfig): ShimExecResult[];
    /** Without `params` this executes EVERY statement in `sql`, discarding rows. */
    run(sql: string, params?: NativeBindParams | null): ShimDatabase;
    /** Compiles only the FIRST statement in `sql`. */
    prepare(sql: string, params?: NativeBindParams | null): ShimStatement;
    iterateStatements(sql: string): ShimStatementIterator;
    getRowsModified(): number;
    /** Requires a synchronous `deps.fs`; throws otherwise (see `exportAsync`). */
    export(): Uint8Array;
    exportAsync(): Promise<Uint8Array>;
    /** Recorded for the sidecar; the fork has no per-row callback. */
    progress_handler(interval: number | null, callback?: (() => boolean) | null): undefined;
    readonly progressHandler: { interval: number; callback: () => boolean } | null;
    setQueryDeadline(ms: number): void;
    clearQueryDeadline(): void;
    interrupt(): void;
    readonly inTransaction: boolean;
    close(): void;
    /** Not part of the sql.js surface; for the sidecar entry only. */
    readonly backingDatabase: NativeDatabase;
}

export function createShimDatabase(config?: ShimConfig, deps?: ShimDeps): ShimDatabase;

/** Copies a SQLite error's non-enumerable `errno` onto a replacement error. */
export function copyErrno<T extends Error>(target: T, source: unknown): T;

/**
 * Characters of `source` consumed when the binding compiled `compiled`
 * (the statement's own SQL text). Returns -1 when the two cannot be aligned.
 */
export function consumedSourceLength(source: string, compiled: string): number;
