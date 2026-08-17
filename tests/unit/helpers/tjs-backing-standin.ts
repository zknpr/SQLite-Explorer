/**
 * A `node:sqlite` adapter that presents the FORK's `tjs:sqlite` contract.
 *
 * The shim (`core/native/sqljs-shim.js`) takes its backing module as a
 * constructor dependency precisely so the same file can be exercised in CI,
 * where the tjs binary is not runnable, and in the sidecar, where it is. This
 * adapter is the CI half: node:sqlite drives real SQLite, and everywhere its
 * surface differs from the fork's, the adapter reshapes it to the FORK's
 * behaviour so the shim is never accidentally written against node semantics.
 *
 * Divergences encoded here (all probe-established — see
 * `.superpowers/sdd/2026-08-17-native-engine/task-1-report.md` and the
 * `multistmt` section of `scripts/native-probe.mjs`):
 *
 *   | behaviour                | node:sqlite                        | tjs:sqlite (encoded)              |
 *   |--------------------------|------------------------------------|-----------------------------------|
 *   | positional params        | `all(...values)` only              | `all([values])` accepted          |
 *   | bare named params        | allowed by default                 | rejected; sigil is part of the key|
 *   | int64                    | throws unless `setReadBigInts`     | number < 2^53, BigInt at/above    |
 *   | `run()` result           | `{changes, lastInsertRowid}`       | `undefined`                       |
 *   | `finalize()`             | absent (GC-managed)                | present + idempotent              |
 *   | trivia-only `prepare()`  | throws ERR_INVALID_STATE           | dead statement, `toString() === ''`|
 *   | error identity           | `errcode` (extended), `code`       | non-enumerable primary `errno`    |
 *
 * The one divergence deliberately NOT encoded is error message text: node
 * reports `near "SELEC": syntax error` where the fork reports the nonspecific
 * `SQL logic error`. Tests assert on `errno`, which is what the fork actually
 * makes classifiable, and keep node's better message for debuggability.
 */

import { DatabaseSync, StatementSync } from 'node:sqlite';
import type { NativeValue } from '../../../core/native/sqljs-shim.js';

type ForkRow = Record<string, NativeValue>;

/** SQLite's primary result code — the fork exposes this, node exposes the extended one. */
const PRIMARY_RESULT_CODE_MASK = 0xff;

interface NodeSqliteError extends Error {
    errcode?: number;
    code?: string;
}

/** Reshape a node:sqlite error into the fork's shape: primary code on a non-enumerable `errno`. */
function asForkError(error: unknown): unknown {
    const candidate = error as NodeSqliteError;
    if (!(candidate instanceof Error) || typeof candidate.errcode !== 'number') return error;
    if (Object.prototype.hasOwnProperty.call(candidate, 'errno')) return error;
    Object.defineProperty(candidate, 'errno', {
        value: candidate.errcode & PRIMARY_RESULT_CODE_MASK,
        enumerable: false,
        writable: true,
        configurable: true
    });
    return error;
}

function rethrowAsFork(error: unknown): never {
    throw asForkError(error);
}

/** node returns every integer as BigInt once `setReadBigInts` is on; the fork only does so at 2^53. */
function toForkValue(value: unknown): unknown {
    if (typeof value === 'bigint' && Number.isSafeInteger(Number(value))) return Number(value);
    if (value instanceof Uint8Array && value.constructor !== Uint8Array) {
        // Buffer is a Uint8Array subclass; the fork hands back a plain one.
        return new Uint8Array(value);
    }
    return value;
}

function toForkRow(row: Record<string, unknown>): ForkRow {
    const out: ForkRow = {};
    for (const key of Object.keys(row)) out[key] = toForkValue(row[key]) as NativeValue;
    return out;
}

/** The fork's error for any use of a finalized statement. */
function finalizedError(): Error {
    return new Error('Statement has been finalized');
}

class StandInStatement {
    #statement: StatementSync | null;
    readonly #source: string;

    constructor(statement: StatementSync | null, source: string) {
        this.#statement = statement;
        this.#source = source;
    }

    /** The fork reports EXPANDED sql (parameters substituted), of the consumed statement only. */
    toString(): string {
        if (this.#statement === null) return this.#source;
        try {
            return this.#statement.expandedSQL;
        } catch (error) {
            return rethrowAsFork(error);
        }
    }

    all(params?: unknown): ForkRow[] {
        const statement = this.#require();
        try {
            const rows = (Array.isArray(params)
                ? statement.all(...(params as never[]))
                : params === undefined
                    ? statement.all()
                    : statement.all(params as never)) as Record<string, unknown>[];
            return rows.map(toForkRow);
        } catch (error) {
            return rethrowAsFork(error);
        }
    }

    run(params?: unknown): void {
        this.all(params);
    }

    finalize(): void {
        // node:sqlite statements are GC-managed and have no finalize; the fork's
        // is idempotent, so dropping the reference reproduces both properties.
        this.#statement = null;
    }

    #require(): StatementSync {
        if (this.#statement === null) throw finalizedError();
        return this.#statement;
    }
}

class StandInDatabase {
    #database: DatabaseSync | null = null;

    constructor(path?: string, options?: { readOnly?: boolean; create?: boolean }) {
        try {
            // `create` is the fork's opt-in for create-on-open (any options
            // object disables it there); node creates by default, so the flag
            // needs no translation beyond being accepted.
            this.#database = new DatabaseSync(path ?? ':memory:', {
                readOnly: options?.readOnly === true
            });
        } catch (error) {
            rethrowAsFork(error);
        }
    }

    exec(sql: string): void {
        try {
            this.#require().exec(sql);
        } catch (error) {
            rethrowAsFork(error);
        }
    }

    prepare(sql: string): StandInStatement {
        const database = this.#require();
        try {
            const statement = database.prepare(sql);
            statement.setReadBigInts(true);
            statement.setAllowBareNamedParameters(false);
            return new StandInStatement(statement, statement.sourceSQL);
        } catch (error) {
            // The fork answers trivia-only SQL with an already-finalized
            // statement whose text is empty (sqlite3_prepare_v2 yielding NULL).
            // node returns a statement too, but every access to it raises
            // ERR_INVALID_STATE — including the configuration calls above.
            if ((error as NodeSqliteError)?.code === 'ERR_INVALID_STATE') {
                return new StandInStatement(null, '');
            }
            return rethrowAsFork(error);
        }
    }

    get inTransaction(): boolean {
        return this.#require().isTransaction;
    }

    close(): void {
        // The fork tolerates a double close; node throws.
        if (this.#database === null) return;
        const database = this.#database;
        this.#database = null;
        database.close();
    }

    #require(): DatabaseSync {
        if (this.#database === null) throw new Error('Invalid DB');
        return this.#database;
    }
}

/** `deps.sqlite` for the shim, backed by node:sqlite but shaped like `tjs:sqlite`. */
export const standInSqliteModule = { Database: StandInDatabase };
