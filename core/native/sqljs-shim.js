/**
 * A sql.js-shaped `Database` implemented over the fork's `tjs:sqlite` binding.
 *
 * The desktop native sidecar runs the EXISTING UI-method layer
 * (`website/src/sqlite-viewer/worker.js`) unchanged; that layer talks to
 * sql.js. This module is the adapter that lets it talk to real SQLite instead.
 * It implements exactly the surface that layer uses -- `exec`, `run`,
 * `prepare`, `iterateStatements`, `getRowsModified`, `export`, `close`,
 * `progress_handler`, and the statement methods `step/get/getColumnNames/
 * run/free/getSQL` -- and nothing else.
 *
 * The backing module is INJECTED (`deps.sqlite`) rather than imported, so the
 * same file runs over real `tjs:sqlite` inside the sidecar and over a
 * node:sqlite stand-in in CI. Everything below is written against the fork API
 * facts established by `scripts/native-probe.mjs` (see
 * `.superpowers/sdd/2026-08-17-native-engine/task-1-report.md`), several of
 * which contradict both stock txiki.js and node:sqlite:
 *
 *   - `Statement` is `{finalize, toString, all, run}`. There is NO `step()`,
 *     no cursor, and no column metadata. Every statement therefore MATERIALISES
 *     through `all()` on first use and the shim replays rows from an index.
 *   - `prepare()` compiles but does NOT execute (probed), so prepare-then-step
 *     runs a statement exactly once.
 *   - `prepare()` on a multi-statement string silently compiles only the first
 *     statement and exposes no tail pointer -- see `consumedSourceLength`.
 *   - An empty result set carries NO column names, and duplicate column names
 *     collapse in `all()`'s row objects (last one wins). Both are repaired via
 *     a TEMP VIEW + `pragma_table_info` probe.
 *   - int64 crosses as `number` below 2^53 and `BigInt` at or beyond it; BLOBs
 *     are `Uint8Array`. Values are passed through, never coerced, except where
 *     sql.js's own `useBigInt` contract requires a Number.
 *   - SQLite errors carry the primary result code on a NON-ENUMERABLE
 *     `err.errno`. Errors are propagated unwrapped wherever possible; where the
 *     shim must construct one, `copyErrno` carries the code across.
 */

/** Reserved-prefix-free name for the throwaway column-probe views. */
let columnProbeCounter = 0;

/**
 * Matches an SQLite bound-parameter token: `?`, `?NNN`, `:name`, `@name`, `$name`.
 *
 * The name class mirrors SQLite's own IdChar: alphanumerics, `_`, `$`, and ANY
 * byte at or above 0x80 — so `:café` is one token, not `:caf` followed by a
 * misalignment. (Astral characters arrive as surrogate pairs, each of which
 * falls inside \u0080-\uffff.)
 */
const PARAMETER_TOKEN = /^(?:\?\d*|[:@$][A-Za-z0-9_$\u0080-\uffff]+(?:\([^()]*\))?)/;

/** Leading `EXPLAIN` / `EXPLAIN QUERY PLAN`, after any leading trivia is stripped. */
const EXPLAIN_PREFIX = /^explain\b/i;

/**
 * Leading `ATTACH` / `DETACH`, after any leading trivia is stripped. Both are
 * always the FIRST token of a standalone statement and cannot nest anywhere
 * else in the grammar (see the reject site in `compileNext`), so matching the
 * leading token is a complete test.
 */
const ATTACH_DETACH_PREFIX = /^(?:attach|detach)\b/i;

/** Leading `VACUUM`, after leading trivia is stripped (in-place VACUUM or VACUUM INTO). */
const VACUUM_PREFIX = /^vacuum\b/i;

/**
 * A bareword `into` anywhere in a SINGLE statement's own source. On a statement
 * whose leading token is `VACUUM`, this can only be the `INTO` clause: the
 * legitimate forms are `VACUUM`, `VACUUM main`, `VACUUM temp` (no schema alias
 * beyond main/temp exists, because ATTACH is blocked), none of which contain
 * `into`. Evasion-proof: a real `VACUUM ... INTO` always carries the literal
 * `INTO` token in its source, whatever comments surround it, so this matches it.
 */
const INTO_WORD = /\binto\b/i;

/**
 * Cheap pre-filter for `db.run(sql)`'s no-param branch (the one path that skips
 * `compileNext`): only when one of these path-authority keywords appears is the
 * double-compiling scan worth running. A false hit (the word inside a string
 * literal or comment) costs one extra parse of a script no real caller writes;
 * a miss is impossible because none of these tokens can be spelled another way.
 */
const PATH_AUTHORITY_SCAN_WORD = /\b(?:attach|detach|vacuum)\b/i;

/**
 * Error codes stamped on the path-authority refusals. Distinct from the frame
 * codec's `ERR_NATIVE_FRAME_*` family so a structured consumer can tell a SQL
 * policy refusal from a transport failure, and distinct from each other so the
 * two SQL→filesystem vectors are separable in logs.
 */
export const NATIVE_SQL_ATTACH_BLOCKED = 'ERR_NATIVE_SQL_ATTACH_BLOCKED';
export const NATIVE_SQL_VACUUM_INTO_BLOCKED = 'ERR_NATIVE_SQL_VACUUM_INTO_BLOCKED';

/**
 * The refusal thrown for a leading ATTACH/DETACH. A plain message (no errno:
 * this is a shim policy, not a SQLite result code) naming the reason, plus the
 * distinct `code`.
 */
function attachDetachBlockedError(keyword) {
    const error = new Error(
        `${keyword.toUpperCase()} is blocked on the native engine: it can open or ` +
        'create a database file outside the path this session is bound to, which ' +
        'would defeat the desktop path sandbox. Only the bound database is reachable.'
    );
    error.code = NATIVE_SQL_ATTACH_BLOCKED;
    return error;
}

/**
 * The refusal thrown for a `VACUUM ... INTO`. In-place `VACUUM` is untouched;
 * only the file-writing INTO variant is blocked (it writes a full copy of the
 * bound database to an arbitrary path).
 */
function vacuumIntoBlockedError() {
    const error = new Error(
        'VACUUM ... INTO is blocked on the native engine: it writes a full copy of ' +
        'the database to an arbitrary path outside the one this session is bound to, ' +
        'defeating the desktop path sandbox. Plain VACUUM (in place) is allowed.'
    );
    error.code = NATIVE_SQL_VACUUM_INTO_BLOCKED;
    return error;
}

/**
 * Drop leading whitespace, empty statements and comments.
 *
 * `sqlite3_sql` keeps whatever trivia the parser consumed on its way into the
 * statement, so the shim has to skip past it before it can either recognise a
 * leading keyword or splice the text into a `CREATE VIEW ... AS` body.
 */
function stripLeadingTrivia(text) {
    let index = 0;
    for (;;) {
        const before = index;
        while (index < text.length && (/\s/.test(text[index]) || text[index] === ';')) index += 1;
        if (text.startsWith('--', index)) {
            const lineEnd = text.indexOf('\n', index);
            index = lineEnd < 0 ? text.length : lineEnd + 1;
        } else if (text.startsWith('/*', index)) {
            const blockEnd = text.indexOf('*/', index + 2);
            index = blockEnd < 0 ? text.length : blockEnd + 2;
        }
        if (index === before) return text.slice(index);
    }
}

/** What `sqlite3_expanded_sql` renders for a parameter that was never bound. */
const UNBOUND_PARAMETER_TEXT = 'NULL';

/**
 * Carry a SQLite error's non-enumerable `errno` onto a replacement error.
 *
 * `Object.keys(err)` is empty on fork errors and `errno` is non-enumerable, so
 * spreading or re-throwing a fresh Error silently drops the only field that can
 * classify the failure (messages are nonspecific -- syntax errors and missing
 * tables are both "SQL logic error"/1).
 */
export function copyErrno(target, source) {
    const errno = source?.errno;
    if (errno !== undefined && target.errno === undefined) {
        Object.defineProperty(target, 'errno', {
            value: errno,
            enumerable: false,
            writable: true,
            configurable: true
        });
    }
    return target;
}

/**
 * How many characters of `source` the binding consumed when it compiled
 * `compiled` (the statement's own SQL text, as `Statement.toString()` reports
 * it).
 *
 * This is the shim's replacement for `sqlite3_prepare_v2`'s `pzTail` -- the
 * fork exposes no tail pointer, so the boundary between one statement and the
 * next has to be recovered from the compiled statement's text. That text is
 * SQLite's EXPANDED sql: byte-identical to the consumed source (leading
 * trivia, comments and the terminating semicolon included) except that each
 * bound parameter is replaced by its value. The shim always splits BEFORE
 * binding, so the only possible substitution is `NULL`, which makes the walk
 * below exact rather than heuristic.
 *
 * Returns -1 if the two texts cannot be aligned; callers must treat that as a
 * hard failure rather than guessing a boundary (guessing would silently drop
 * or duplicate a statement in a console script).
 */
export function consumedSourceLength(source, compiled) {
    // Fast path: no parameters in the consumed statement, so the compiled text
    // IS the prefix. This is every statement in practice.
    if (source.startsWith(compiled)) return compiled.length;

    let sourceIndex = 0;
    let compiledIndex = 0;
    while (compiledIndex < compiled.length) {
        if (sourceIndex < source.length && source[sourceIndex] === compiled[compiledIndex]) {
            sourceIndex += 1;
            compiledIndex += 1;
            continue;
        }
        // Divergence can only be a parameter site: expanded SQL copies every
        // other byte verbatim. A parameter sigil is never `N`, so this branch
        // cannot be entered by an accidental character match.
        const token = PARAMETER_TOKEN.exec(source.slice(sourceIndex));
        if (!token || !compiled.startsWith(UNBOUND_PARAMETER_TEXT, compiledIndex)) return -1;
        sourceIndex += token[0].length;
        compiledIndex += UNBOUND_PARAMETER_TEXT.length;
    }
    return sourceIndex;
}

/**
 * Does this column list carry SQLite's own duplicate disambiguation?
 *
 * A view over `SELECT 1 AS x, 2 AS x` reports its columns as `x`, `x:1`, while
 * the binding's row objects collapse both into a single `x` key. Spotting the
 * `name`/`name:N` pair is how the shim knows, before executing anything, that
 * the two would disagree on arity. A column genuinely named `q:1` with no `q`
 * beside it is not a match.
 */
function hasDisambiguatedDuplicates(names) {
    const present = new Set(names);
    return names.some(name => {
        const match = /^(.*):\d+$/.exec(name);
        return match !== null && present.has(match[1]);
    });
}

/** Normalise the fork's row values to sql.js's `get()` contract. */
function toSqlJsValue(value, useBigInt) {
    // sql.js reads INTEGER columns through sqlite3_column_double unless
    // `useBigInt` is set, so an int64 beyond 2^53 arrives there as a lossy
    // Number. Match that exactly; the fork would otherwise hand back a BigInt
    // the caller never asked for.
    if (typeof value === 'bigint' && !useBigInt) return Number(value);
    return value;
}

/**
 * Compile the next statement in `sql` starting at `from`.
 *
 * Returns null when only trivia (whitespace/comments/empty statements) remains
 * -- the fork answers a trivia-only `prepare()` with an already-finalized
 * statement whose text is empty, which is exactly `sqlite3_prepare_v2`
 * yielding a NULL statement.
 */
function compileNext(backing, sql, from) {
    if (from >= sql.length) return null;
    const rest = sql.slice(from);
    // SECURITY: reject ATTACH/DETACH before it is ever compiled. `compileNext`
    // is the chokepoint for exec/prepare/iterateStatements, so blocking here
    // holds for every RPC that reaches raw SQL (runQuery, runConsole) on every
    // session, engine-level -- NOT relying on the read-only wholesale block,
    // which does not stop ATTACH reads (query_only blocks only attached-DB
    // writes). ATTACH would otherwise open/create a file outside the bound
    // path from inside SQL, defeating the desktop's path authority.
    //
    // Matching only the LEADING token is complete because ATTACH/DETACH is
    // always the first token of a standalone statement and CANNOT nest: verified
    // against the shipped fork binary that SQLite rejects `WITH x AS (ATTACH..)`,
    // `SELECT (ATTACH..)`, `SELECT * FROM (ATTACH..)`, `ATTACH` in a CREATE
    // TRIGGER body, a compound `... UNION ATTACH..`, and `VALUES (ATTACH..)` all
    // at COMPILE. The `rest`'s leading token (after trivia) is this statement's
    // leading token, so a later ATTACH in a multi-statement script is caught on
    // the compileNext call that reaches it. Checked pre-compile because ATTACH's
    // side effect lands at step, not prepare (also verified) -- but not compiling
    // it at all is the cleaner guarantee.
    const leading = stripLeadingTrivia(rest);
    const attachDetach = ATTACH_DETACH_PREFIX.exec(leading);
    if (attachDetach) throw attachDetachBlockedError(attachDetach[0]);
    const compiled = backing.prepare(rest);
    let text;
    try {
        text = String(compiled);
    } catch (error) {
        finalizeQuietly(compiled);
        throw error;
    }
    if (text === '') {
        finalizeQuietly(compiled);
        return null;
    }
    const length = consumedSourceLength(rest, text);
    if (length < 0) {
        finalizeQuietly(compiled);
        throw new Error(
            'Unable to determine the SQL statement boundary: the compiled statement ' +
            'text does not align with its source'
        );
    }
    const source = rest.slice(0, length);
    // SECURITY: reject `VACUUM ... INTO` (an arbitrary out-of-path file write --
    // it copies the whole bound database to any path SQL names, the last
    // SQL->filesystem vector after ATTACH). Unlike ATTACH, VACUUM is ALSO the
    // leading token of the legitimate in-place `VACUUM`/`VACUUM main`, so the
    // leading token alone is not enough -- the INTO clause has to be detected.
    // The `into` bareword is tested against THIS statement's own `source` (not
    // the whole remaining multi-statement string), so `VACUUM; SELECT ... INTO
    // ...temp...` in a later statement cannot false-trip it. Soundness: with
    // ATTACH blocked there is no schema alias beyond main/temp, so on a
    // VACUUM-led statement the only source of a bareword `into` is the INTO
    // clause itself (the accepted narrow exception is the word `into` written
    // inside a comment on a plain VACUUM -- pathological, and fails loud, never
    // silent). Rejected AFTER compile / BEFORE step because VACUUM INTO's file
    // is created at step, not prepare (verified against the shipped binary), so
    // the compiled-but-never-stepped statement writes nothing. The shim's own
    // export issues its VACUUM INTO through `backing.prepare` directly (see
    // `vacuumInto`), NOT through compileNext, so it is deliberately unaffected.
    if (VACUUM_PREFIX.test(leading) && INTO_WORD.test(source)) {
        finalizeQuietly(compiled);
        throw vacuumIntoBlockedError();
    }
    // `text` is captured HERE, before any bind: it is the source with every
    // parameter rendered as NULL. Read later it would inline the bound VALUES
    // instead, which is both non-deterministic and user data in SQL text.
    return { compiled, source, expanded: text, end: from + length };
}

function finalizeQuietly(statement) {
    try {
        statement?.finalize?.();
    } catch {
        // A statement that cannot be finalized is already gone; the caller is
        // on an error path and has a more informative failure to report.
    }
}

/**
 * Walk every statement in a multi-statement script through `compileNext` purely
 * to trip its path-authority rejects (ATTACH/DETACH and VACUUM ... INTO), then
 * discard each compiled statement WITHOUT stepping it -- so nothing executes.
 * Used only to guard `db.run(sql)`'s no-param `backing.exec` path, which does
 * not itself pass through compileNext. Compiling here and again in
 * `backing.exec` is redundant but harmless (compile has no side effects; both
 * blocked vectors' effects land at step), and only runs at all when one of the
 * scanned keywords is present.
 */
function rejectPathAuthorityViolationsInScript(backing, sql) {
    let cursor = 0;
    for (;;) {
        const next = compileNext(backing, sql, cursor);
        if (next === null) return;
        cursor = next.end;
        finalizeQuietly(next.compiled);
    }
}

/**
 * The sql.js statement surface over a materialised result set.
 *
 * `context` carries the shared database plumbing: the backing connection, the
 * live-statement registry, and the read-only escape hatch the column probe
 * needs.
 */
function createShimStatement(context, compiled, source, expanded) {
    let backingStatement = compiled;
    let boundParameters;
    /** Materialised result: `{ columns, values }`, or null before first use. */
    let rows = null;
    /** Column names resolved without executing, when the probe could answer. */
    let probedColumns;
    let resolvedColumns = null;
    /** Index of the row `get()` returns; -1 means "no current row". */
    let position = -1;

    // A view body may not contain bound parameters, so a parameterised
    // statement has to be probed through its EXPANDED text (parameters rendered
    // as NULL at compile time), which compiles as a view and reports the same
    // column names. Without this, every parameterised query fell through to the
    // materialise fallback -- returning [] for a zero-row result, which the grid
    // reports as "Primary-key column missing", and executing each filtered page
    // twice. Probing the source when there are no parameters keeps sql.js's
    // exact names for the unaliased-placeholder case.
    const probeText = source === expanded ? source : expanded;

    const assertLive = () => {
        // Connection-level quarantine outranks statement-level liveness: if
        // read-only enforcement was lost, "this statement is closed" is the
        // wrong (and reassuring) thing to say.
        context.assertUsable();
        if (backingStatement === null) throw new Error('Statement closed');
    };

    /** Column names from a TEMP VIEW over this statement's own SQL, or null. */
    const probeColumns = () => {
        if (probedColumns !== undefined) return probedColumns;
        const probed = context.probeColumnNames(probeText);
        // The probe reports the view's disambiguated columns (`x`, `x:1`) while
        // `all()` collapses the duplicates into one key. ensureRows() repairs
        // that by re-reading through the same view -- but only for a
        // parameter-free statement, because a parameterised statement's view
        // holds NULLs where the bound values belong. Without a repair available,
        // handing back the disambiguated list would promise more names than
        // there will ever be values, so decline and let the caller fall through.
        probedColumns = probed && source !== expanded && hasDisambiguatedDuplicates(probed)
            ? null
            : probed;
        return probedColumns;
    };

    const ensureRows = () => {
        if (rows !== null) return rows;
        const objectRows = boundParameters === undefined
            ? backingStatement.all()
            : backingStatement.all(boundParameters);
        const keys = objectRows.length > 0 ? Object.keys(objectRows[0]) : [];
        const values = objectRows.map(row => keys.map(key => row[key]));

        // Duplicate result names collapse into one object key, taking the value
        // with them. When the probe already told us the true column count, read
        // the rows back through the view instead -- SQLite disambiguates the
        // view's own columns (`x`, `x:1`), so both values survive. If that
        // repair is unavailable, keep the collapsed shape: names and values
        // MUST come from the same materialisation or the grid mis-renders.
        if (probedColumns && objectRows.length > 0 && probedColumns.length !== keys.length) {
            // Only when the probe text IS the source. A parameterised statement
            // is probed through its params-as-NULL expansion, and re-reading
            // rows from THAT view would return values computed with NULL
            // parameters rather than the bound ones -- wrong data is worse than
            // a collapsed column. Fall through to the keys instead.
            const repaired = source === expanded ? context.readRowsThroughView(probeText) : null;
            if (repaired) {
                rows = repaired;
                return rows;
            }
            probedColumns = keys;
            resolvedColumns = keys;
        }
        rows = { columns: probedColumns ?? keys, values };
        return rows;
    };

    /**
     * Column names, WITHOUT executing the statement wherever that is possible.
     *
     * sql.js reads `sqlite3_column_count`/`_name` off the compiled statement and
     * never runs anything; the fork exposes neither, so the shim works down a
     * ladder and stops at the first rung that can answer without a side effect:
     *
     *   1. already materialised -> those columns (the only arity-safe answer,
     *      whatever the probe would say);
     *   2. the TEMP VIEW probe (CREATE VIEW compiles the body, never runs it);
     *   3. EXPLAIN, which cannot be a view body but is by definition
     *      side-effect-free -- it lists the bytecode of the statement it
     *      describes and never executes it;
     *   4. `[]`.
     *
     * Rung 4 is the deliberate stop: answering a metadata question by running a
     * mutation is not a trade the shim makes. The visible cost is that a
     * `DELETE ... RETURNING` in the console reports no result columns until it
     * has been stepped, so its rows are treated as side-effect-only.
     */
    const ensureColumns = () => {
        if (resolvedColumns !== null) return resolvedColumns;
        if (rows !== null) {
            resolvedColumns = rows.columns;
            return resolvedColumns;
        }
        const probed = probeColumns();
        if (probed) {
            resolvedColumns = probed;
            return resolvedColumns;
        }
        if (EXPLAIN_PREFIX.test(stripLeadingTrivia(probeText))) {
            resolvedColumns = ensureRows().columns;
            return resolvedColumns;
        }
        // Rung 4 is NOT memoised: it is an admission of ignorance, not an
        // answer. Once the caller steps the statement the real columns become
        // available, and asking again should get them.
        return [];
    };

    const statement = {
        /** Bind values; invalidates any previous materialisation, as sql.js's reset does. */
        bind(values) {
            assertLive();
            boundParameters = values ?? undefined;
            rows = null;
            position = -1;
            return true;
        },

        step() {
            assertLive();
            ensureRows();
            position += 1;
            if (position < rows.values.length) return true;
            // sqlite3_step implicitly resets after SQLITE_DONE, so the next
            // step() replays the result set. Side effects are NOT replayed --
            // re-running a DML statement because a caller over-stepped it is a
            // footgun the shim declines to reproduce.
            position = -1;
            return false;
        },

        get(params, config) {
            assertLive();
            if (params != null) {
                statement.bind(params);
                statement.step();
            }
            // sql.js reads sqlite3_data_count, which is 0 until step() has
            // produced a row -- so an un-stepped get() is empty and, crucially,
            // executes NOTHING. Materialisation stays deferred to step().
            if (rows === null || position < 0 || position >= rows.values.length) return [];
            const useBigInt = config?.useBigInt === true;
            return rows.values[position].map(value => toSqlJsValue(value, useBigInt));
        },

        getColumnNames() {
            assertLive();
            return ensureColumns().slice();
        },

        /** sql.js's shorthand for bind + step + reset. */
        run(values) {
            assertLive();
            if (values != null) statement.bind(values);
            statement.step();
            return statement.reset();
        },

        reset() {
            assertLive();
            boundParameters = undefined;
            rows = null;
            position = -1;
            return true;
        },

        /** The statement's own SQL text -- `sqlite3_sql`, not the expanded form. */
        getSQL() {
            return source;
        },

        free() {
            if (backingStatement === null) return false;
            const finalizing = backingStatement;
            backingStatement = null;
            context.forget(statement);
            finalizeQuietly(finalizing);
            return true;
        }
    };

    context.register(statement);
    return statement;
}

/**
 * Create a sql.js-shaped database over an injected `tjs:sqlite`-shaped module.
 *
 * @param config `{ path, readOnly }` to open a file, `{}` for an in-memory
 *   database. `{ content }` is accepted for signature parity with sql.js and
 *   rejected: the fork has no deserialize entry point, and opening by path is
 *   the entire point of the native engine.
 * @param deps `{ sqlite: { Database }, fs? }`. `fs` is only needed by
 *   `export()`/`exportAsync()`.
 */
export function createShimDatabase(config = {}, deps = {}) {
    const sqlite = deps.sqlite;
    if (typeof sqlite?.Database !== 'function') {
        throw new Error('createShimDatabase requires deps.sqlite.Database');
    }
    if (config.content !== undefined) {
        throw new Error(
            'createShimDatabase: opening from bytes is not supported by the native ' +
            'engine; open by path ({ path, readOnly }) or use the WASM engine'
        );
    }

    const readOnly = config.readOnly === true;
    // Passing ANY options object suppresses file creation on the fork -- even
    // `{}` fails with errno 14 on a missing path, where a bare
    // `new Database(path)` would have created it. `create` restores sql.js's
    // create-on-open behaviour, and is MUTUALLY EXCLUSIVE with `readOnly`
    // (together they raise SQLITE_MISUSE/21). Both probed.
    const backing = config.path === undefined || config.path === null
        ? new sqlite.Database(':memory:')
        : new sqlite.Database(config.path, readOnly ? { readOnly: true } : { create: true });

    let closed = false;
    /** Live shim statements, freed together on close() (sql.js does the same). */
    const liveStatements = new Set();
    let changesStatement = null;
    /**
     * Set when read-only enforcement could not be restored after an internal
     * lift. The connection is then in an unknown write state, so every
     * subsequent operation fails rather than proceeding on a broken guarantee.
     */
    let poisoned = null;

    const assertOpen = () => {
        if (poisoned !== null) throw poisoned;
        if (closed) throw new Error('Database closed');
    };

    /** Report a swallowed cleanup failure without turning it into the caller's error. */
    const reportCleanupFailure = (error, context) => {
        try {
            deps.onCleanupFailure?.(error, context);
        } catch {
            // A reporting hook must never escalate a cleanup failure into a
            // primary one.
        }
    };

    const readScalar = (sql) => {
        const statement = backing.prepare(sql);
        try {
            const result = statement.all();
            const row = result[0];
            return row === undefined ? undefined : row[Object.keys(row)[0]];
        } finally {
            finalizeQuietly(statement);
        }
    };

    if (readOnly) {
        // The fork's `readOnly` open flag is honoured, but a typo'd key is
        // silently ignored (the shipped extension has exactly that bug), so the
        // shim does not trust the flag at all: `query_only` blocks writes at the
        // SQLite level regardless of how the connection was opened, and reading
        // it back proves the guard is armed. This is a pure connection flag --
        // nothing is written to prove it.
        try {
            backing.exec('PRAGMA query_only = 1');
        } catch (error) {
            backing.close();
            throw copyErrno(
                new Error(`Unable to enforce read-only mode: ${error?.message ?? error}`),
                error
            );
        }
        if (Number(readScalar('PRAGMA query_only')) !== 1) {
            backing.close();
            throw new Error('Unable to enforce read-only mode: PRAGMA query_only did not take');
        }
    }

    /** True while `query_only` is lifted; see the re-entrancy note below. */
    let writesLifted = false;

    /**
     * Run shim-authored DDL that must write on a connection pinned read-only.
     *
     * Exactly two operations need this and both are shim-authored: creating and
     * dropping the column-probe TEMP VIEW, and `VACUUM INTO`, which writes only
     * its own output file. Reading FROM the probe view does NOT need it
     * (verified against the real binary: a SELECT from a temp view succeeds with
     * `query_only = 1`), so the window is DDL-only -- no user SQL is ever
     * executed inside it. `CREATE VIEW` compiles its body without running it, so
     * even the view's own SELECT does not execute while writes are permitted.
     *
     * NOT re-entrant, and asserted so: a nested call would restore `query_only`
     * at the inner exit and leave the outer body running unprotected. Callers
     * keep the lifts sequential rather than nested.
     */
    const withInternalWrites = (operation) => {
        if (!readOnly) return operation();
        // A poisoned connection is one whose query_only state is unknown, so
        // lifting it again is precisely the thing not to do. Unreachable today
        // -- every caller passes assertOpen/assertUsable first, and the probe
        // re-throws before its DROP cleanup -- but this is THE choke point for
        // "permit writes on a read-only connection", so it checks for itself
        // rather than trusting each future caller to have checked.
        if (poisoned !== null) throw poisoned;
        if (writesLifted) {
            throw new Error('Internal error: read-only write lift is not re-entrant');
        }
        backing.exec('PRAGMA query_only = 0');
        writesLifted = true;

        let failure = null;
        let value;
        try {
            value = operation();
        } catch (error) {
            failure = error;
        }

        try {
            backing.exec('PRAGMA query_only = 1');
        } catch (restoreError) {
            // Losing the restore means the connection may now accept writes.
            // Poison it so nothing else runs, and ATTACH rather than mask: an
            // error thrown from a finally would hide whatever the caller was
            // actually trying to do.
            poisoned = copyErrno(
                new Error(
                    'Read-only enforcement could not be restored (PRAGMA query_only); ' +
                    'this connection is no longer trustworthy and has been disabled'
                ),
                restoreError
            );
            poisoned.cause = restoreError;
            if (failure) {
                if (failure.cause === undefined) failure.cause = restoreError;
            } else {
                failure = poisoned;
            }
        } finally {
            writesLifted = false;
        }

        if (failure) throw failure;
        return value;
    };

    /**
     * Wrap `sql` in a TEMP VIEW and hand the view to `reader`.
     *
     * This is the only way to get column names for a zero-row result out of
     * this binding, and it is simultaneously the only way to see columns that
     * `all()`'s row objects collapse. Callers pass the statement's PARAMETER-FREE
     * text -- its compile-time expansion, where every parameter reads as NULL --
     * because a view body may not contain parameters; that is what lets a
     * parameterised query be probed at all.
     *
     * Returns null when the statement cannot be expressed as a view (DML, DDL,
     * PRAGMA, EXPLAIN). That is not a fallback to executing the statement: it is
     * the signal for the caller's ladder to move to its next rung, which reports
     * `[]` rather than run anything. See `ensureColumns`.
     *
     * The two `catch { return null }` arms below are deliberately blanket --
     * "this statement is not viewable" is exactly what a failure here means --
     * EXCEPT for a poisoned connection, which is re-thrown: degrading a lost
     * read-only guarantee into "no columns" would hide it.
     */
    const withColumnProbeView = (sql, reader) => {
        const body = stripLeadingTrivia(sql);
        if (body === '') return null;
        // Shim-generated, [A-Za-z0-9_] only: safe to embed as both an identifier
        // and a string literal without escaping. `pragma_table_info` takes its
        // argument as a STRING -- a double-quoted identifier there is only
        // accepted under SQLite's legacy double-quoted-string misfeature, which
        // is off on some builds.
        const name = `_sqlx_shim_cols_${++columnProbeCounter}`;
        const quoted = `"${name}"`;
        const literal = `'${name}'`;
        try {
            withInternalWrites(() => {
                // prepare+run rather than exec: `exec` would run EVERY statement
                // in the string, so a mis-split (which `consumedSourceLength`
                // reports rather than guesses at, but still) could not turn this
                // into a second execution of something else. prepare compiles
                // only the first statement, and CREATE VIEW never runs its body.
                const creation = backing.prepare(`CREATE TEMP VIEW ${quoted} AS ${body}`);
                try {
                    creation.run();
                } finally {
                    finalizeQuietly(creation);
                }
            });
        } catch (error) {
            if (poisoned !== null) throw poisoned;
            return null;
        }
        try {
            // Deliberately OUTSIDE the write lift: reading a temp view needs no
            // write permission, so nothing that touches user SQL runs while
            // query_only is down.
            return reader({ quoted, literal });
        } catch (error) {
            if (poisoned !== null) throw poisoned;
            return null;
        } finally {
            try {
                withInternalWrites(() => backing.exec(`DROP VIEW IF EXISTS temp.${quoted}`));
            } catch (error) {
                // Leaving a temp view behind is harmless (it dies with the
                // connection) and must not mask the caller's result.
                reportCleanupFailure(error, 'drop column-probe view');
            }
        }
    };

    const statementContext = {
        /** Statements share the connection's quarantine, not just its handle. */
        assertUsable: () => {
            if (poisoned !== null) throw poisoned;
        },
        register: (statement) => liveStatements.add(statement),
        forget: (statement) => liveStatements.delete(statement),
        probeColumnNames: (sql) => withColumnProbeView(sql, ({ literal }) => {
            const statement = backing.prepare(`SELECT name FROM pragma_table_info(${literal})`);
            try {
                const names = statement.all().map(row => row.name);
                return names.length > 0 ? names : null;
            } finally {
                finalizeQuietly(statement);
            }
        }),
        readRowsThroughView: (sql) => withColumnProbeView(sql, ({ quoted }) => {
            const statement = backing.prepare(`SELECT * FROM ${quoted}`);
            try {
                const objectRows = statement.all();
                if (objectRows.length === 0) return null;
                const columns = Object.keys(objectRows[0]);
                return { columns, values: objectRows.map(row => columns.map(key => row[key])) };
            } finally {
                finalizeQuietly(statement);
            }
        })
    };

    const prepareInternal = (sql) => {
        const next = compileNext(backing, sql, 0);
        if (next === null) throw new Error('Nothing to prepare');
        return createShimStatement(statementContext, next.compiled, next.source, next.expanded);
    };

    const requireFs = () => {
        const fs = deps.fs;
        if (!fs || typeof fs.makeTempDir !== 'function' || typeof fs.readFile !== 'function'
            || typeof fs.remove !== 'function') {
            throw new Error('export() requires deps.fs with makeTempDir/readFile/remove');
        }
        return fs;
    };

    let progressHandler = null;

    const vacuumInto = (target) => withInternalWrites(() => {
        const statement = backing.prepare('VACUUM INTO ?');
        try {
            statement.run([target]);
        } finally {
            finalizeQuietly(statement);
        }
    });

    const database = {
        /** `[{columns, values}]`, one entry per statement that produced rows. */
        exec(sql, params, config) {
            assertOpen();
            const results = [];
            let cursor = 0;
            for (;;) {
                const next = compileNext(backing, sql, cursor);
                if (next === null) break;
                cursor = next.end;
                const statement = createShimStatement(statementContext, next.compiled, next.source, next.expanded);
                try {
                    if (params != null) statement.bind(params);
                    // Resolve the columns BEFORE the first step, even though the
                    // loop below asks again. The probe is what tells ensureRows()
                    // the statement's TRUE arity, and ensureRows() can only repair
                    // `all()`'s collapsed duplicate keys when the probe has already
                    // run. sql.js's exec() steps first, and copying that order here
                    // meant `SELECT * FROM a JOIN b` silently came back one column
                    // short with its values shifted left. The probe compiles a temp
                    // view and never executes anything, so this costs a compile on
                    // statements that are viewable and one failed compile on the
                    // ones that are not.
                    statement.getColumnNames();
                    let columns = null;
                    const values = [];
                    while (statement.step()) {
                        if (columns === null) columns = statement.getColumnNames();
                        values.push(statement.get(null, config));
                    }
                    if (columns !== null) results.push({ columns, values });
                } finally {
                    statement.free();
                }
            }
            return results;
        },

        /** Execute, discarding rows. Without params this runs EVERY statement in `sql`. */
        run(sql, params) {
            assertOpen();
            if (params != null) {
                const statement = prepareInternal(sql);
                try {
                    statement.bind(params);
                    statement.step();
                } finally {
                    statement.free();
                }
            } else {
                // The one path that does NOT flow through compileNext: a
                // no-param `run()` hands the whole string to `backing.exec`,
                // which compiles and steps every statement natively. Worker.js
                // only reaches this with shim-built DDL/DML (escaped
                // identifiers, never a leading ATTACH or VACUUM INTO), so it is
                // not a reachable bypass today -- but the shim is the security
                // boundary, not worker.js, so close it unconditionally. Fast
                // path: skip the scan entirely unless a scanned keyword appears.
                if (PATH_AUTHORITY_SCAN_WORD.test(sql)) rejectPathAuthorityViolationsInScript(backing, sql);
                backing.exec(sql);
            }
            return database;
        },

        /** Compile the FIRST statement in `sql`; `getSQL()` reports just that statement. */
        prepare(sql, params) {
            assertOpen();
            const statement = prepareInternal(sql);
            if (params != null) statement.bind(params);
            return statement;
        },

        /** sql.js's StatementIterator: one statement per next(), tail via getRemainingSQL(). */
        iterateStatements(sql) {
            assertOpen();
            let cursor = 0;
            let active = null;
            let finished = false;
            return {
                next() {
                    if (active !== null) {
                        active.free();
                        active = null;
                    }
                    if (finished) return { done: true };
                    assertOpen();
                    let next;
                    try {
                        next = compileNext(backing, sql, cursor);
                    } catch (error) {
                        // Leave the cursor where it is so getRemainingSQL()
                        // reports the text that failed to compile, as sql.js does.
                        finished = true;
                        throw error;
                    }
                    if (next === null) {
                        finished = true;
                        return { done: true };
                    }
                    cursor = next.end;
                    active = createShimStatement(statementContext, next.compiled, next.source, next.expanded);
                    return { value: active, done: false };
                },
                getRemainingSQL() {
                    return sql.slice(cursor);
                },
                [Symbol.iterator]() {
                    return this;
                }
            };
        },

        /** Rows changed by the most recent statement (`sqlite3_changes`). */
        getRowsModified() {
            assertOpen();
            changesStatement ??= backing.prepare('SELECT changes() AS c');
            return Number(changesStatement.all()[0].c);
        },

        /**
         * Snapshot the database as bytes.
         *
         * `VACUUM INTO` a fresh 0700 temp directory, read it, delete it. The
         * image is vacuumed rather than a byte copy -- unavoidable, and
         * equivalent for every consumer (they hand it to the file writer).
         */
        export() {
            assertOpen();
            const fs = requireFs();
            const directory = fs.makeTempDir();
            if (typeof directory?.then === 'function') {
                throw new Error(
                    'export() requires a synchronous deps.fs; use exportAsync() on runtimes ' +
                    'whose filesystem API is promise-based (tjs)'
                );
            }
            try {
                const target = `${directory}/export.sqlite`;
                vacuumInto(target);
                const bytes = fs.readFile(target);
                if (typeof bytes?.then === 'function') {
                    throw new Error(
                        'export() requires a synchronous deps.fs.readFile; use exportAsync()'
                    );
                }
                return bytes;
            } finally {
                try {
                    fs.remove(directory);
                } catch (error) {
                    // A leaked temp directory must not fail an otherwise good
                    // export -- but it holds a full copy of the database, so it
                    // is reported rather than silently dropped.
                    reportCleanupFailure(error, 'remove export temp directory');
                }
            }
        },

        /** `export()` for runtimes with a promise-based filesystem (tjs). */
        async exportAsync() {
            assertOpen();
            const fs = requireFs();
            const directory = await fs.makeTempDir();
            try {
                const target = `${directory}/export.sqlite`;
                vacuumInto(target);
                return await fs.readFile(target);
            } finally {
                try {
                    await fs.remove(directory);
                } catch (error) {
                    // As above: cleanup failure is not an export failure, but a
                    // leaked directory holding a database copy is worth hearing about.
                    reportCleanupFailure(error, 'remove export temp directory');
                }
            }
        },

        /**
         * Write a vacuumed image of the database directly to `target` -- the
         * out-of-band export route. Unlike `export()`/`exportAsync()` there is
         * NO read-back and NO image in memory: `VACUUM INTO` streams the copy
         * to disk and this resolves once it commits. `target` must live
         * somewhere only the caller can write -- the desktop shell hands in a
         * path inside its own 0700 temp directory, and THAT is the boundary
         * that makes planting impossible. Do NOT rely on VACUUM INTO to refuse
         * a planted target: SQLite refuses only a NON-EMPTY existing file; a
         * zero-byte file is written into, and (no `O_NOFOLLOW`) a symlink is
         * followed. No `deps.fs` needed: nothing is read back.
         *
         * SECURITY: this is the shim's own privileged `VACUUM INTO` (the same
         * `vacuumInto` behind `export()`), deliberately bypassing the
         * compileNext path-authority guard. It is reachable ONLY from the
         * sidecar's shell-originated export handler in native-host.js -- it is
         * never exposed as a worker method, so the webview can neither invoke
         * it nor choose `target`.
         */
        async exportToPath(target) {
            assertOpen();
            if (typeof target !== 'string' || target.length === 0) {
                throw new Error('exportToPath requires a non-empty target path');
            }
            vacuumInto(target);
        },

        /**
         * sql.js's row-callback cancellation hook. The fork's binding has no
         * per-row callback, so this records the handler and does nothing else;
         * cancellation on the native engine runs through `setQueryDeadline` /
         * `interrupt` below, which the sidecar wires to the same timeout.
         */
        progress_handler(interval, callback) {
            assertOpen();
            progressHandler = callback == null ? null : { interval, callback };
            return undefined;
        },

        /** The handler last installed by `progress_handler`, for the sidecar to inspect. */
        get progressHandler() {
            return progressHandler;
        },

        /** Fork cancellation primitives, passed through for the sidecar to drive. */
        setQueryDeadline(ms) {
            assertOpen();
            backing.setQueryDeadline?.(ms);
        },
        clearQueryDeadline() {
            assertOpen();
            backing.clearQueryDeadline?.();
        },
        interrupt() {
            assertOpen();
            backing.interrupt?.();
        },

        /** True while an explicit transaction is open on this connection. */
        get inTransaction() {
            assertOpen();
            return backing.inTransaction === true;
        },

        close() {
            if (closed) return;
            closed = true;
            for (const statement of [...liveStatements]) statement.free();
            liveStatements.clear();
            finalizeQuietly(changesStatement);
            changesStatement = null;
            backing.close();
        },

        /** Escape hatch for the sidecar entry; NOT part of the sql.js surface. */
        get backingDatabase() {
            return backing;
        }
    };

    return database;
}
