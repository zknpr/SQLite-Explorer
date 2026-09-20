/**
 * Sidecar half of the native lane: drives the COMMITTED
 * `desktop/native-worker-desktop.js` inside the real fork binary over real
 * pipes — the complete shipping path in one piece: RPC envelope in, frame
 * codec, stdio transport, the byte-identical worker method layer, the
 * tjs:sqlite shim, and back.
 *
 * What this proves that the unit suite and the other lane phases cannot:
 * the argv/path binding refuses at the process boundary, real schema/console
 * results come back through real frames, the codec's int64/blob tagging
 * survives REAL RPC responses (not echoes), the wrapped postMessage answers
 * an oversize response in band for the same messageId, the query deadline
 * actually interrupts a runaway statement, and the ppid watchdog kills an
 * orphan whose stdin never closed.
 *
 * RPCs are issued strictly sequentially (send, await the reply, send the
 * next) — the same discipline the desktop host applies. The dispatch layer
 * itself does not serialise concurrent envelopes, exactly like the WASM
 * worker's message queue around initializeDatabase's awaits.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
    MAX_FRAME_BYTES,
    NATIVE_FRAME_TOO_LARGE,
    createFrameReader,
    encodeFrame
} from '../../core/native/frame-codec.js';
import { buildDesktopNativeWorkerSource } from '../build.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BUNDLE_PATH = path.join(REPO_ROOT, 'desktop', 'native-worker-desktop.js');

const FIXTURE_BLOB = [0x00, 0x01, 0x7f, 0x80, 0xff];
const INT64_MAX = 9223372036854775807n;

/** Seed the on-disk fixture the sidecar sessions open. */
function createFixture(dbPath) {
    fs.rmSync(dbPath, { force: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
        CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, data BLOB, big INTEGER, r REAL);
        INSERT INTO t VALUES
            (1, 'alpha', X'00017f80ff', 9223372036854775807, 1.5),
            (2, 'beta',  NULL,          -9223372036854775808, -2.25),
            (3, 'gamma', X'',           9007199254740993,      0.0);
        CREATE VIEW v AS SELECT id, name FROM t;
    `);
    db.close();
}

/**
 * Spawn one sidecar session and return a sequential RPC client over it.
 * Replies are matched by messageId; stderr is collected for the caller.
 *
 * Exported so the per-method sweep (native-method-sweep.mjs) drives the same
 * real binary through the same real pipes rather than reimplementing — and so
 * a change to the spawn contract cannot silently apply to only one of them.
 */
export function startSidecar(binary, dbPath, mode) {
    const child = spawn(binary, ['run', BUNDLE_PATH, dbPath, mode], {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    const pending = new Map();
    let stderr = '';
    let exit = null;
    let exitWaiters = [];

    const reader = createFrameReader(
        (message) => {
            const id = message?.content?.messageId;
            const waiter = pending.get(id);
            if (waiter) {
                pending.delete(id);
                waiter.resolve(message);
            }
        },
        (error) => {
            // Lane-side decode failures fail every in-flight RPC loudly rather
            // than timing out.
            for (const [id, waiter] of pending) {
                pending.delete(id);
                waiter.reject(new Error(`frame reader error while awaiting ${id}: ${error.message}`));
            }
        }
    );

    child.stdout.on('data', (chunk) => reader.push(new Uint8Array(chunk)));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', (error) => { stderr += `[stdin] ${error.code ?? error.message}\n`; });
    child.on('close', (code) => {
        exit = code;
        for (const waiter of exitWaiters) waiter(code);
        exitWaiters = [];
        for (const [id, waiter] of pending) {
            pending.delete(id);
            waiter.reject(new Error(`sidecar exited ${code} while awaiting ${id}`));
        }
    });

    let messageId = 0;
    const awaitReply = (id, envelope, label, timeoutMs) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`timed out waiting for ${label} (${id})`));
        }, timeoutMs);
        pending.set(id, {
            resolve: (message) => { clearTimeout(timer); resolve(message); },
            reject: (error) => { clearTimeout(timer); reject(error); }
        });
        child.stdin.write(Buffer.from(encodeFrame(envelope)));
    });
    return {
        child,
        get stderr() { return stderr; },
        get exitCode() { return exit; },
        /** Send one invoke and resolve with the FULL response envelope. */
        invoke(targetMethod, payload = [], timeoutMs = 30000) {
            const id = `lane_${++messageId}`;
            return awaitReply(id, {
                channel: 'rpc',
                content: { kind: 'invoke', messageId: id, targetMethod, payload }
            }, targetMethod, timeoutMs);
        },
        /**
         * Send one SHELL-ORIGINATED export-to-path request — the exact message
         * the Rust shell will construct (native-host.js pins the contract) —
         * and resolve with the full `{channel:'shell'}` export-result envelope.
         * `args` is omitted from the content when undefined (exportDatabase
         * takes none; the field is required only for exportTable).
         */
        shellExport(method, tempPath, args = undefined, timeoutMs = 30000) {
            const id = `shell_${++messageId}`;
            const content = { kind: 'export', messageId: id, method, tempPath };
            if (args !== undefined) content.args = args;
            return awaitReply(id, { channel: 'shell', content }, `shell-export ${method}`, timeoutMs);
        },
        /** Fire-and-forget raw envelope (for messages that must produce NO reply). */
        sendRaw(envelope) {
            child.stdin.write(Buffer.from(encodeFrame(envelope)));
        },
        endStdin() { child.stdin.end(); },
        untilExit(timeoutMs = 15000) {
            if (exit !== null) return Promise.resolve(exit);
            return new Promise((resolve) => {
                const timer = setTimeout(() => resolve('TIMEOUT'), timeoutMs);
                exitWaiters.push((code) => { clearTimeout(timer); resolve(code); });
            });
        }
    };
}

const equalBytes = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A statement that runs for minutes unless the deadline interrupts it. */
const RUNAWAY_SQL =
    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<200000000) ' +
    'SELECT max(x) AS m FROM c';

/**
 * @param {{binary: string, scratch: string, note: (ok: boolean, label: string, detail?: string) => void}} context
 * @returns {Promise<number>} number of checks run
 */
export async function runSidecarLane({ binary, scratch, note }) {
    let checks = 0;
    const check = (ok, label, detail) => { note(ok, label, detail); checks += 1; };

    // 0. The committed artifact is fresh against the build script's own
    //    bundler config (single source of truth — the import above).
    const committed = fs.readFileSync(BUNDLE_PATH, 'utf8');
    const rebuilt = await buildDesktopNativeWorkerSource();
    check(committed === rebuilt, 'sidecar/committed-bundle-is-fresh',
        committed === rebuilt ? '' : 'desktop/native-worker-desktop.js is stale; run node scripts/build.mjs');

    const dbPath = path.join(scratch, 'sidecar-fixture.sqlite');
    createFixture(dbPath);

    // The executable's directory is the sole native-library authority. An
    // incomplete installation must refuse open rather than weaken plan limits.
    const missingReaderDirectory = path.join(scratch, 'missing-plan-reader');
    fs.mkdirSync(missingReaderDirectory);
    const isolatedBinary = path.join(missingReaderDirectory, path.basename(binary));
    fs.copyFileSync(binary, isolatedBinary);
    const missingReader = startSidecar(isolatedBinary, dbPath, 'rw');
    try {
        const refused = await missingReader.invoke('initializeDatabase', ['sidecar-fixture.sqlite', {
            path: dbPath, readOnlyMode: false
        }]);
        check(refused.content?.success === false
            && /Missing bundled query-plan reader/.test(refused.content?.errorMessage ?? ''),
            'sidecar/missing-bundled-reader-refuses-open', JSON.stringify(refused.content));
        missingReader.endStdin();
        await missingReader.untilExit();
    } finally {
        if (missingReader.exitCode === null) missingReader.child.kill('SIGKILL');
    }

    // ---- writable session -------------------------------------------------
    const rw = startSidecar(binary, dbPath, 'rw');
    try {
        const init = await rw.invoke('initializeDatabase', ['sidecar-fixture.sqlite', {
            path: dbPath,
            readOnlyMode: false,
            queryTimeout: 30000
        }]);
        check(init.content?.success === true
            && init.content?.data?.isReadOnly === false
            && init.content?.data?.storage === 'memory',
            'sidecar/initializeDatabase-opens-bound-path', JSON.stringify(init.content));

        const schema = await rw.invoke('fetchSchema', []);
        const tables = schema.content?.data?.tables?.map((table) => table.identifier) ?? [];
        const views = schema.content?.data?.views?.map((view) => view.identifier) ?? [];
        check(schema.content?.success === true
            && tables.includes('t') && views.includes('v'),
            'sidecar/fetchSchema-returns-real-schema', JSON.stringify({ tables, views }));

        // Real rows through real frames; the blob arrives as a tagged
        // Uint8Array, byte-intact.
        const rows = await rw.invoke('runConsole', ['SELECT id, name, data, r FROM t ORDER BY id']);
        const result = rows.content?.data?.results?.[0];
        const blob = result?.rows?.[0]?.[2];
        check(rows.content?.success === true
            && JSON.stringify(result?.headers) === JSON.stringify(['id', 'name', 'data', 'r'])
            && result?.rows?.length === 3
            && result?.rows?.[0]?.[1] === 'alpha'
            && result?.rows?.[0]?.[3] === 1.5
            && blob instanceof Uint8Array && equalBytes([...blob], FIXTURE_BLOB)
            && result?.rows?.[1]?.[2] === null,
            'sidecar/runConsole-selects-with-blob-tag',
            JSON.stringify(rows.content, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? [...v] : v)));

        // int64 OUTBOUND: updateCellBatch reads prior values with useBigInt, so
        // the response carries a genuine BigInt through the codec's int64 tag.
        const update = await rw.invoke('updateCellBatch', ['t', [{ rowId: 1, column: 'big', value: 5 }]]);
        const priorValue = update.content?.data?.[0]?.priorValue;
        check(update.content?.success === true && priorValue === INT64_MAX,
            'sidecar/int64-survives-outbound-envelope',
            `priorValue=${typeof priorValue === 'bigint' ? `${priorValue}n` : JSON.stringify(priorValue)}`);

        // int64 INBOUND: a BigInt RPC parameter binds losslessly (a lossy
        // Number would make the equality fail).
        const bound = await rw.invoke('runQuery', [
            'SELECT ? = 9223372036854775807 AS eq', [INT64_MAX]
        ]);
        check(bound.content?.success === true && bound.content?.data?.[0]?.rows?.[0]?.[0] === 1,
            'sidecar/int64-survives-inbound-envelope', JSON.stringify(bound.content?.data));

        const mutation = await rw.invoke('runConsole', [
            "INSERT INTO t VALUES (4, 'delta', NULL, 4, 4.0)"
        ]);
        check(mutation.content?.success === true
            && mutation.content?.data?.mutated === true
            && mutation.content?.data?.changes === 1,
            'sidecar/runConsole-reports-mutation', JSON.stringify(mutation.content?.data));

        // exportDatabase served through the shim's exportAsync at the dispatch
        // layer; the image must reopen and contain the mutation above.
        const exported = await rw.invoke('exportDatabase', []);
        const bytes = exported.content?.data;
        let reopenedCount = null;
        if (bytes instanceof Uint8Array) {
            const copyPath = path.join(scratch, 'sidecar-export.sqlite');
            fs.writeFileSync(copyPath, bytes);
            const reopened = new DatabaseSync(copyPath, { readOnly: true });
            reopenedCount = reopened.prepare('SELECT count(*) AS c FROM t').get().c;
            reopened.close();
        }
        check(exported.content?.success === true
            && bytes instanceof Uint8Array
            && String.fromCharCode(...bytes.subarray(0, 15)) === 'SQLite format 3'
            && reopenedCount === 4,
            'sidecar/exportDatabase-roundtrips', `bytes=${bytes?.length}, rows=${reopenedCount}`);

        // SECURITY: ATTACH/DETACH must not reach files outside the bound path.
        // The reviewer's exact READ and WRITE bypasses, replayed through the
        // real binary via runConsole (an intended webview feature). runConsole
        // resolves failures (failure-is-a-resolution), so the block surfaces in
        // data.error; nothing must run, and the out-of-path files must be
        // untouched. `secret` proves a READ can't reach it; `planted` proves a
        // WRITE can't create it.
        const secretPath = path.join(scratch, 'attack-secret.sqlite');
        const plantedPath = path.join(scratch, 'attack-planted.sqlite');
        fs.rmSync(plantedPath, { force: true });
        {
            const secret = new DatabaseSync(secretPath);
            secret.exec("CREATE TABLE secrets(v); INSERT INTO secrets VALUES('TOPSECRET')");
            secret.close();
        }
        const attachBlocked = (data) => /blocked on the native engine/i.test(data?.error ?? '')
            && (data?.results?.length ?? 0) === 0
            && data?.mutated === false;

        const attachRead = await rw.invoke('runConsole', [
            `ATTACH DATABASE '${secretPath}' AS steal; SELECT v FROM steal.secrets`
        ]);
        check(attachRead.content?.success === true && attachBlocked(attachRead.content?.data),
            'sidecar/ATTACH-read-blocked', JSON.stringify(attachRead.content?.data));

        const attachWrite = await rw.invoke('runConsole', [
            `ATTACH DATABASE '${plantedPath}' AS evil; CREATE TABLE evil.pwn(x); INSERT INTO evil.pwn VALUES(1)`
        ]);
        check(attachWrite.content?.success === true
            && attachBlocked(attachWrite.content?.data)
            && !fs.existsSync(plantedPath),
            'sidecar/ATTACH-write-blocked-and-no-file-created',
            `${JSON.stringify(attachWrite.content?.data)} planted=${fs.existsSync(plantedPath)}`);

        const detach = await rw.invoke('runConsole', ['DETACH DATABASE steal']);
        check(detach.content?.success === true
            && /blocked on the native engine/i.test(detach.content?.data?.error ?? ''),
            'sidecar/DETACH-blocked', JSON.stringify(detach.content?.data?.error));

        // Smuggling: a leading block comment and mixed case must not slip past
        // the leading-token reject.
        const smuggle = await rw.invoke('runConsole', [
            `/*x*/ AtTaCh DATABASE '${secretPath}' AS s3`
        ]);
        check(smuggle.content?.success === true
            && /blocked on the native engine/i.test(smuggle.content?.data?.error ?? ''),
            'sidecar/ATTACH-smuggle-comment-and-case-blocked', JSON.stringify(smuggle.content?.data?.error));

        // Not over-broad: the word `attach` inside a string literal is fine, and
        // normal single-DB SELECT/INSERT keep working right after the blocks.
        const benign = await rw.invoke('runConsole', ["SELECT 'attach me' AS note"]);
        check(benign.content?.success === true
            && benign.content?.data?.results?.[0]?.rows?.[0]?.[0] === 'attach me'
            && benign.content?.data?.error === undefined,
            'sidecar/word-attach-in-literal-not-blocked', JSON.stringify(benign.content?.data));

        const normalInsert = await rw.invoke('runConsole', ["INSERT INTO t VALUES (5, 'epsilon', NULL, 5, 5.0)"]);
        check(normalInsert.content?.success === true && normalInsert.content?.data?.mutated === true,
            'sidecar/normal-sql-unaffected-by-attach-block', JSON.stringify(normalInsert.content?.data));

        // SECURITY: VACUUM ... INTO must not write a database copy outside the
        // bound path. The reviewer's exact probe, replayed through the real
        // binary via runConsole; nothing must run and the out-of-path file must
        // not be created.
        const vacuumTarget = path.join(scratch, 'attack-PWNED.db');
        fs.rmSync(vacuumTarget, { force: true });
        const vacuumInto = await rw.invoke('runConsole', [`VACUUM INTO '${vacuumTarget}'`]);
        check(vacuumInto.content?.success === true
            && /blocked on the native engine/i.test(vacuumInto.content?.data?.error ?? '')
            && (vacuumInto.content?.data?.results?.length ?? 0) === 0
            && !fs.existsSync(vacuumTarget),
            'sidecar/VACUUM-INTO-blocked-and-no-file-created',
            `${JSON.stringify(vacuumInto.content?.data?.error)} created=${fs.existsSync(vacuumTarget)}`);

        // In-place VACUUM (no INTO) must stay legitimate.
        const plainVacuum = await rw.invoke('runConsole', ['VACUUM']);
        check(plainVacuum.content?.success === true && plainVacuum.content?.data?.error === undefined,
            'sidecar/plain-VACUUM-allowed', JSON.stringify(plainVacuum.content?.data));

        // NON-INTERFERENCE: exportDatabase issues the shim's OWN VACUUM INTO via
        // backing.prepare (bypassing compileNext), so the guard must not touch
        // it — prove the whole export path still works after the block lands.
        const exportAfterBlock = await rw.invoke('exportDatabase', []);
        check(exportAfterBlock.content?.success === true
            && exportAfterBlock.content?.data instanceof Uint8Array
            && String.fromCharCode(...exportAfterBlock.content.data.subarray(0, 15)) === 'SQLite format 3',
            'sidecar/export-still-works-after-vacuum-block',
            `bytes=${exportAfterBlock.content?.data?.length}`);

        // Not over-broad: the phrase in a string literal is fine.
        const vacuumLiteral = await rw.invoke('runConsole', ["SELECT 'vacuum into' AS note"]);
        check(vacuumLiteral.content?.success === true
            && vacuumLiteral.content?.data?.results?.[0]?.rows?.[0]?.[0] === 'vacuum into'
            && vacuumLiteral.content?.data?.error === undefined,
            'sidecar/vacuum-into-in-literal-not-blocked', JSON.stringify(vacuumLiteral.content?.data));

        // A table whose name merely starts with "vacuum" is unaffected (leading
        // token `vacuumlog` is not the `vacuum` keyword; no INTO involved).
        const vacuumlog = await rw.invoke('runConsole', [
            'CREATE TABLE vacuumlog(into_count); INSERT INTO vacuumlog VALUES (1); SELECT into_count FROM vacuumlog'
        ]);
        check(vacuumlog.content?.success === true
            && vacuumlog.content?.data?.results?.[0]?.rows?.[0]?.[0] === 1
            && vacuumlog.content?.data?.error === undefined,
            'sidecar/vacuumlog-table-and-into-column-unaffected', JSON.stringify(vacuumlog.content?.data?.error));

        // Tripwires: the other SQL→filesystem vectors are absent/disabled in the
        // pinned fork binary. If a future binary bump enables one, THIS fails —
        // forcing a matching block before it can ship as a hole.
        for (const [label, sql] of [
            ['readfile', "SELECT readfile('/etc/hosts')"],
            ['writefile', "SELECT writefile('/tmp/sqlx-tripwire','x')"],
            ['load_extension', "SELECT load_extension('/tmp/x')"]
        ]) {
            const probe = await rw.invoke('runConsole', [sql]);
            check(probe.content?.success === true && (probe.content?.data?.error ?? '') !== '',
                `sidecar/tripwire-${label}-unavailable`, JSON.stringify(probe.content?.data?.error));
        }

        // ---- deep-QA capstone engine defects, on the real binary ----------
        // Every one of these was a SILENTLY WRONG answer through this exact
        // path, so each asserts the value or the on-disk state, not a message.

        // E-1: a statement with no trailing `;` used to lose its whole result
        // set to a fabricated leftover-SQL error (sql.js) — the guard is gone
        // on both engines, so this must simply answer.
        const noSemicolon = await rw.invoke('runConsole', ['SELECT 1 AS one']);
        check(noSemicolon.content?.success === true
            && noSemicolon.content?.data?.error === undefined
            && noSemicolon.content?.data?.results?.[0]?.rows?.[0]?.[0] === 1,
            'sidecar/E1-statement-without-trailing-semicolon-returns-rows',
            JSON.stringify(noSemicolon.content?.data));

        // E-1b: NUL in console SQL is refused up front rather than running the
        // prefix and dropping the rest.
        const nulSql = await rw.invoke('runConsole', ['SELECT 1\u0000; SELECT 2']);
        check(nulSql.content?.success === false
            && /NUL/.test(nulSql.content?.errorMessage ?? ''),
            'sidecar/E1-nul-in-console-sql-refused',
            JSON.stringify(nulSql.content?.errorMessage));

        // E-2: every value-returning PRAGMA came back as ZERO ROWS and no
        // error, because the shim cannot name a PRAGMA's columns before it has
        // been stepped and the console read that as "this is DML".
        const pragmaRows = await rw.invoke('runConsole', ['PRAGMA table_info(t)']);
        const pragmaResult = pragmaRows.content?.data?.results?.[0];
        check(pragmaRows.content?.success === true
            && pragmaRows.content?.data?.error === undefined
            && JSON.stringify(pragmaResult?.headers)
                === JSON.stringify(['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'])
            && JSON.stringify(pragmaResult?.rows?.map((row) => row[1]))
                === JSON.stringify(['id', 'name', 'data', 'big', 'r']),
            'sidecar/E2-value-returning-pragma-returns-rows',
            JSON.stringify(pragmaRows.content?.data));

        const journalMode = await rw.invoke('runConsole', ['PRAGMA journal_mode']);
        check(journalMode.content?.success === true
            && journalMode.content?.data?.results?.[0]?.rows?.length === 1,
            'sidecar/E2-pragma-journal_mode-returns-its-value',
            JSON.stringify(journalMode.content?.data));

        // E-2b: the same root cause as the known RETURNING gap — and the fix
        // closes it. The row comes back AND the insert applies exactly once.
        await rw.invoke('runConsole', ['CREATE TABLE returning_probe(n INTEGER)']);
        const returning = await rw.invoke('runConsole', [
            'INSERT INTO returning_probe VALUES (41) RETURNING n + 1 AS answer'
        ]);
        const applied = await rw.invoke('runConsole', [
            'SELECT count(*) AS c FROM returning_probe'
        ]);
        check(returning.content?.success === true
            && returning.content?.data?.results?.[0]?.rows?.[0]?.[0] === 42
            && applied.content?.data?.results?.[0]?.rows?.[0]?.[0] === 1,
            'sidecar/E2-dml-with-returning-yields-its-row-once',
            JSON.stringify(returning.content?.data));

        // E-4: db.exec() collapsed duplicate result column names and shifted
        // the values left. runQuery is the only caller, and it answered wrong
        // rather than erroring.
        await rw.invoke('runConsole', [
            'CREATE TABLE dup_parent(id INTEGER PRIMARY KEY, label TEXT);'
            + 'CREATE TABLE dup_child(id INTEGER PRIMARY KEY, parent_id INTEGER, note TEXT);'
            + "INSERT INTO dup_parent VALUES (1,'p1'); INSERT INTO dup_child VALUES (7,1,'c1')"
        ]);
        const joined = await rw.invoke('runQuery', [
            'SELECT * FROM dup_parent JOIN dup_child ON dup_child.parent_id = dup_parent.id'
        ]);
        const joinedSet = joined.content?.data?.[0];
        check(joined.content?.success === true
            && joinedSet?.headers?.length === 5
            && JSON.stringify(joinedSet?.rows?.[0]) === JSON.stringify([1, 'p1', 7, 1, 'c1']),
            'sidecar/E4-duplicate-result-columns-keep-every-value',
            JSON.stringify(joinedSet));

        // E-3: updateCell reported success for a row that does not exist and
        // changed nothing; updateCellBatch always refused. They must agree.
        const ghost = await rw.invoke('updateCell', ['t', 999999, 'name', 'ghost']);
        check(ghost.content?.success === false
            && /row 999999 no longer exists/.test(ghost.content?.errorMessage ?? ''),
            'sidecar/E3-updateCell-refuses-a-row-that-does-not-exist',
            JSON.stringify(ghost.content?.errorMessage));

        const liveEdit = await rw.invoke('updateCell', ['t', 1, 'name', 'alpha-edited']);
        const liveRead = await rw.invoke('runConsole', ['SELECT name FROM t WHERE id = 1']);
        check(liveEdit.content?.success === true
            && liveRead.content?.data?.results?.[0]?.rows?.[0]?.[0] === 'alpha-edited',
            'sidecar/E3-updateCell-still-applies-to-a-row-that-exists',
            JSON.stringify(liveRead.content?.data));

        // E-5: TEXT written through the WASM engine lost everything past its
        // first NUL. Both engines now route it through a blob bind + CAST, so
        // the bytes on disk are identical on both.
        await rw.invoke('updateCell', ['t', 1, 'name', 'a\u0000b']);
        const nulBytes = await rw.invoke('runConsole', [
            'SELECT hex(CAST(name AS BLOB)) AS h, typeof(name) AS t FROM t WHERE id = 1'
        ]);
        check(nulBytes.content?.data?.results?.[0]?.rows?.[0]?.[0] === '610062'
            && nulBytes.content?.data?.results?.[0]?.rows?.[0]?.[1] === 'text',
            'sidecar/E5-text-with-an-embedded-nul-round-trips',
            JSON.stringify(nulBytes.content?.data?.results?.[0]?.rows?.[0]));

        // E-15: foreign_keys defaulted to 1 on native and 0 on WASM, so the
        // same delete was refused on one engine and orphaned children on the
        // other. Pinned ON at open on both.
        const pragmas = await rw.invoke('getPragmas', []);
        check(pragmas.content?.success === true && pragmas.content?.data?.foreign_keys === 1,
            'sidecar/E15-foreign-keys-enforced', JSON.stringify(pragmas.content?.data?.foreign_keys));

        await rw.invoke('runConsole', [
            'CREATE TABLE fk_parent(id INTEGER PRIMARY KEY);'
            + 'CREATE TABLE fk_child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES fk_parent(id));'
            + 'INSERT INTO fk_parent VALUES (1); INSERT INTO fk_child VALUES (1,1)'
        ]);
        const orphan = await rw.invoke('deleteRows', ['fk_parent', [1]]);
        const survivors = await rw.invoke('runConsole', ['SELECT count(*) AS c FROM fk_child']);
        check(orphan.content?.success === false
            && survivors.content?.data?.results?.[0]?.rows?.[0]?.[0] === 1,
            'sidecar/E15-parent-delete-refused-instead-of-orphaning',
            JSON.stringify(orphan.content?.errorMessage));

        // Oversize response: the wrapped postMessage must answer IN BAND for
        // the same messageId instead of stranding the RPC (worker.js's send
        // sites are unguarded by design — byte-identity gate).
        const oversize = await rw.invoke('runConsole', [
            'SELECT randomblob(17 * 1024 * 1024) AS b'
        ], 60000);
        check(oversize.content?.success === false
            && oversize.content?.error?.code === NATIVE_FRAME_TOO_LARGE
            && typeof oversize.content?.messageId === 'string',
            'sidecar/oversize-response-answers-in-band', JSON.stringify(oversize.content?.error));

        const afterOversize = await rw.invoke('runConsole', ['SELECT 1 AS ok']);
        check(afterOversize.content?.success === true
            && afterOversize.content?.data?.results?.[0]?.rows?.[0]?.[0] === 1,
            'sidecar/session-survives-oversize-response');

        const unknown = await rw.invoke('definitelyNotAMethod', []);
        check(unknown.content?.success === false
            && unknown.content?.errorMessage === 'Unknown method: definitelyNotAMethod',
            'sidecar/unknown-method-reply-passes-wrapped-send', JSON.stringify(unknown.content));

        // Query deadline: re-init with a 250ms budget, then fire a statement
        // that would otherwise run for minutes. runConsole RESOLVES with the
        // interrupt recorded (failure-is-a-resolution), fast.
        const reinit = await rw.invoke('initializeDatabase', ['sidecar-fixture.sqlite', {
            path: dbPath,
            readOnlyMode: false,
            queryTimeout: 250
        }]);
        check(reinit.content?.success === true, 'sidecar/re-initializeDatabase');

        const startedAt = Date.now();
        const runaway = await rw.invoke('runConsole', [RUNAWAY_SQL], 30000);
        const elapsedMs = Date.now() - startedAt;
        check(runaway.content?.success === true
            && /interrupt/i.test(runaway.content?.data?.error ?? '')
            && elapsedMs < 10000,
            'sidecar/query-deadline-interrupts-runaway',
            `${elapsedMs}ms -- ${JSON.stringify(runaway.content?.data?.error)}`);

        const afterDeadline = await rw.invoke('runConsole', ['SELECT 1 AS ok']);
        check(afterDeadline.content?.success === true,
            'sidecar/session-survives-deadline-interrupt');

        // Path binding: layer 2 must refuse any path but the argv one, and the
        // refusal must not create the other file (`create: true` would).
        const elsewhere = path.join(scratch, 'not-the-bound-db.sqlite');
        const refused = await rw.invoke('initializeDatabase', ['x', {
            path: elsewhere, readOnlyMode: false
        }]);
        check(refused.content?.success === false
            && /bound to at spawn/.test(refused.content?.errorMessage ?? '')
            && !fs.existsSync(elsewhere),
            'sidecar/wrong-path-initializeDatabase-refused',
            JSON.stringify(refused.content?.errorMessage));

        // Byte-mode opens have no place in the native engine either.
        const byteMode = await rw.invoke('initializeDatabase', ['x', {
            content: new Uint8Array([1, 2, 3])
        }]);
        check(byteMode.content?.success === false,
            'sidecar/content-mode-initializeDatabase-refused',
            JSON.stringify(byteMode.content?.errorMessage));

        rw.endStdin();
        const code = await rw.untilExit();
        check(code === 0, 'sidecar/stdin-eof-exits-clean', `exit ${code}`);
    } finally {
        if (rw.exitCode === null) rw.child.kill('SIGKILL');
        const stderrText = rw.stderr.trim();
        // Worker-side console.error noise (method errors) is expected for the
        // refusal cases; keep it visible without failing on it.
        if (stderrText) console.log(`[sidecar rw stderr]\n${stderrText}\n`);
    }

    // ---- read-only session ------------------------------------------------
    createFixture(dbPath);
    const ro = startSidecar(binary, dbPath, 'ro');
    try {
        const init = await ro.invoke('initializeDatabase', ['sidecar-fixture.sqlite', {
            path: dbPath, readOnlyMode: true
        }]);
        check(init.content?.success === true && init.content?.data?.isReadOnly === true,
            'sidecar/ro-session-opens-read-only', JSON.stringify(init.content));

        const boundedRead = await ro.invoke('executeReadQuery', ['SELECT 1 AS value']);
        const badRead = await ro.invoke('executeReadQuery', ['SELECT * FROM absent_read_table']);
        const enforced = await ro.invoke('executeReadQuery', ['SELECT query_only FROM pragma_query_only']);
        const noMetadataViews = await ro.invoke('executeReadQuery', [
            "SELECT count(*) FROM sqlite_temp_schema WHERE name LIKE 'query_columns_%'"
        ]);
        check(boundedRead.content?.success === true && boundedRead.content?.data?.rows?.[0]?.[0] === 1
            && badRead.content?.success === false
            && enforced.content?.data?.rows?.[0]?.[0] === 1
            && noMetadataViews.content?.data?.rows?.[0]?.[0] === 0,
            'sidecar/ro-bounded-reads-preserve-enforcement-and-clean-up',
            JSON.stringify({ read: boundedRead.content, guard: enforced.content, views: noMetadataViews.content }));

        const write = await ro.invoke('runConsole', ["INSERT INTO t VALUES (9, 'x', NULL, 9, 9.0)"]);
        check(write.content?.success === false
            && /read-only/i.test(write.content?.errorMessage ?? ''),
            'sidecar/ro-session-blocks-writes', JSON.stringify(write.content?.errorMessage));

        // Reads still flow — through the structured methods, not runConsole
        // (worker parity: ad hoc SQL is refused wholesale on read-only
        // databases, SELECTs included). Export also works read-only (VACUUM
        // INTO a temp copy, not a write to the database itself).
        const read = await ro.invoke('fetchSchema', []);
        check(read.content?.success === true
            && (read.content?.data?.tables?.map((table) => table.identifier) ?? []).includes('t'),
            'sidecar/ro-session-reads-via-structured-methods');

        const exported = await ro.invoke('exportDatabase', []);
        check(exported.content?.success === true
            && exported.content?.data instanceof Uint8Array
            && String.fromCharCode(...exported.content.data.subarray(0, 15)) === 'SQLite format 3',
            'sidecar/ro-session-exports');

        // Escalation refusal: an `ro` spawn never grants a writable open, no
        // matter what the config asks for.
        const escalate = await ro.invoke('initializeDatabase', ['sidecar-fixture.sqlite', {
            path: dbPath, readOnlyMode: false
        }]);
        check(escalate.content?.success === false
            && /read-only session/.test(escalate.content?.errorMessage ?? ''),
            'sidecar/ro-session-refuses-writable-reopen',
            JSON.stringify(escalate.content?.errorMessage));

        ro.endStdin();
        const code = await ro.untilExit();
        check(code === 0, 'sidecar/ro-session-eof-exits-clean', `exit ${code}`);
    } finally {
        if (ro.exitCode === null) ro.child.kill('SIGKILL');
        const stderrText = ro.stderr.trim();
        if (stderrText) console.log(`[sidecar ro stderr]\n${stderrText}\n`);
    }

    // ---- shell-originated export-to-path (> 16 MiB, bytes never framed) ----
    // The out-of-band export route: the shell hands the sidecar a temp path
    // and the RESULT crosses the pipe as a path-sized reply, never as bytes.
    // Driven on a fixture whose DB image AND CSV export both exceed the
    // 16 MiB frame cap — the framed route provably cannot carry either.
    checks += await runShellExportCase(binary, scratch, note);

    // ---- fatal desync exit mapping ----------------------------------------
    // The frame lane proves this contract for its echo harness; this proves
    // the SHIPPING entry maps a desync to flush + NONZERO exit too.
    const desync = startSidecar(binary, dbPath, 'rw');
    try {
        // 0xffffffff: not a plausible length — the reader stops for good.
        desync.child.stdin.write(Buffer.from([0xff, 0xff, 0xff, 0xff]));
        const code = await desync.untilExit();
        check(code !== 'TIMEOUT' && code !== 0 && code !== null,
            'sidecar/desync-exits-nonzero-without-hanging', `exit ${code}`);
    } finally {
        if (desync.exitCode === null) desync.child.kill('SIGKILL');
        const stderrText = desync.stderr.trim();
        if (stderrText) console.log(`[sidecar desync stderr]\n${stderrText}\n`);
    }

    // ---- usage exit (malformed argv) --------------------------------------
    // A direct child (no reparenting), so its real wait-status IS reap-able.
    // Bad flag + a path that must never be opened: assert exit 2 and that the
    // named file was not created (the entry exits at argv parse, before any
    // open).
    {
        const neverOpened = path.join(scratch, 'must-not-open.sqlite');
        fs.rmSync(neverOpened, { force: true });
        const usage = spawn(binary, ['run', BUNDLE_PATH, neverOpened, 'bogus'], {
            stdio: ['ignore', 'ignore', 'pipe']
        });
        let usageStderr = '';
        usage.stderr.on('data', (chunk) => { usageStderr += chunk; });
        const code = await new Promise((resolve) => usage.on('close', resolve));
        check(code === 2 && !fs.existsSync(neverOpened),
            'sidecar/malformed-argv-exits-2-without-opening',
            `exit ${code}, opened=${fs.existsSync(neverOpened)}, stderr=${JSON.stringify(usageStderr.trim().slice(0, 120))}`);
    }

    // ---- a file the process cannot write (capstone E-11) ------------------
    checks += await runUnwritableFileCase(binary, scratch, note);

    // ---- journal_mode WAL round trip --------------------------------------
    checks += await runJournalModeCase(binary, scratch, note);

    // ---- ppid watchdog ----------------------------------------------------
    checks += await runWatchdogCase(binary, dbPath, note);

    return checks;
}

/**
 * journal_mode WAL and back through the shipped sidecar.
 *
 * The desktop's Configuration modal drives exactly these RPCs (setPragma,
 * getPragmas, and — for a checkpoint — runQuery), and this is what a WASM
 * image can never do: the mode change lands on the real file. Asserted: the
 * -wal/-shm sidecars appear on the first write and an external reader sees
 * the row through the log; a TRUNCATE checkpoint drains the log (SQLite
 * resets it before reading the counters, hence 0/0/0 and an empty -wal);
 * the switch is refused while a transaction is open — the host's session
 * transaction on a dirty database — and the mode stays put; leaving WAL
 * removes both sidecars; the mode a session leaves is the mode a FRESH
 * session finds, with the rows intact; and a read-only session cannot
 * change it at all.
 *
 * @returns {Promise<number>} checks run
 */
async function runJournalModeCase(binary, scratch, note) {
    let checks = 0;
    const check = (ok, label, detail) => { note(ok, label, detail); checks += 1; };

    const dbPath = path.join(scratch, 'journal-fixture.sqlite');
    createFixture(dbPath);
    const sidecarFiles = () => ['-wal', '-shm'].filter((suffix) => fs.existsSync(`${dbPath}${suffix}`));
    const walBytes = () => (fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : -1);
    const journalMode = async (session) => (await session.invoke('getPragmas', [])).content?.data?.journal_mode;

    let session = startSidecar(binary, dbPath, 'rw');
    try {
        await session.invoke('initializeDatabase', ['journal-fixture.sqlite', {
            path: dbPath, readOnlyMode: false
        }]);
        const before = await journalMode(session);
        const toWal = await session.invoke('setPragma', ['journal_mode', 'WAL']);
        const afterSwitch = await journalMode(session);
        check(before === 'delete' && toWal.content?.success === true && afterSwitch === 'wal',
            'sidecar/journal-mode-switches-to-wal',
            `before=${before}, answer=${JSON.stringify(toWal.content)}, after=${afterSwitch}`);

        const write = await session.invoke('runConsole', ["INSERT INTO t VALUES (4, 'delta', NULL, 4, 4.0)"]);
        const external = new DatabaseSync(dbPath, { readOnly: true });
        let externalMode;
        let externalCount;
        try {
            externalMode = external.prepare('PRAGMA journal_mode').get()?.journal_mode;
            externalCount = external.prepare('SELECT count(*) AS c FROM t').get()?.c;
        } finally {
            external.close();
        }
        check(write.content?.data?.mutated === true
            && JSON.stringify(sidecarFiles()) === JSON.stringify(['-wal', '-shm'])
            && walBytes() > 0
            && externalMode === 'wal' && externalCount === 4,
            'sidecar/wal-write-lands-in-the-log-and-an-external-reader-sees-it',
            `files=${JSON.stringify(sidecarFiles())}, walBytes=${walBytes()}, externalMode=${externalMode}, externalCount=${externalCount}`);

        const checkpoint = await session.invoke('runQuery', ['PRAGMA wal_checkpoint(TRUNCATE)']);
        const counters = checkpoint.content?.data?.[0]?.rows?.[0];
        check(checkpoint.content?.success === true
            && JSON.stringify(counters) === JSON.stringify([0, 0, 0])
            && walBytes() === 0,
            'sidecar/wal-checkpoint-drains-the-log',
            `counters=${JSON.stringify(counters)}, walBytes=${walBytes()}`);

        // The fork answers the in-transaction refusal with its generic
        // "SQL logic error" (message loss, not a different outcome): what
        // matters is that it IS refused and the mode did not move.
        await session.invoke('runQuery', ['BEGIN']);
        await session.invoke('runQuery', ['SELECT count(*) FROM t']);
        const inTransaction = await session.invoke('setPragma', ['journal_mode', 'DELETE']);
        const stillWal = await journalMode(session);
        await session.invoke('runQuery', ['ROLLBACK']);
        check(inTransaction.content?.success === false && stillWal === 'wal',
            'sidecar/journal-mode-change-inside-a-transaction-is-refused-and-keeps-wal',
            `answer=${JSON.stringify(inTransaction.content)}, mode=${stillWal}`);

        const toDelete = await session.invoke('setPragma', ['journal_mode', 'DELETE']);
        const afterDelete = await journalMode(session);
        check(toDelete.content?.success === true && afterDelete === 'delete' && sidecarFiles().length === 0,
            'sidecar/leaving-wal-removes-both-sidecar-files',
            `answer=${JSON.stringify(toDelete.content)}, mode=${afterDelete}, files=${JSON.stringify(sidecarFiles())}`);

        // Lower-case value (the settings modal's select) — left in place so
        // the fresh session below proves the mode outlives the process.
        const lower = await session.invoke('setPragma', ['journal_mode', 'wal']);
        check(lower.content?.success === true && await journalMode(session) === 'wal',
            'sidecar/journal-mode-accepts-a-lower-case-value', JSON.stringify(lower.content));

        session.endStdin();
        const code = await session.untilExit();
        check(code === 0, 'sidecar/journal-session-exits-clean', `exit ${code}`);
    } finally {
        if (session.exitCode === null) session.child.kill('SIGKILL');
        const stderrText = session.stderr.trim();
        if (stderrText) console.log(`[sidecar journal stderr]\n${stderrText}\n`);
    }

    session = startSidecar(binary, dbPath, 'rw');
    try {
        await session.invoke('initializeDatabase', ['journal-fixture.sqlite', {
            path: dbPath, readOnlyMode: false
        }]);
        const reopenedMode = await journalMode(session);
        const rows = await session.invoke('runQuery', ['SELECT count(*) AS c FROM t']);
        const back = await session.invoke('setPragma', ['journal_mode', 'DELETE']);
        check(reopenedMode === 'wal'
            && rows.content?.data?.[0]?.rows?.[0]?.[0] === 4
            && back.content?.success === true,
            'sidecar/journal-mode-persists-into-a-fresh-session-with-its-rows',
            `mode=${reopenedMode}, rows=${JSON.stringify(rows.content?.data)}, back=${JSON.stringify(back.content)}`);
        session.endStdin();
        await session.untilExit();
    } finally {
        if (session.exitCode === null) session.child.kill('SIGKILL');
        const stderrText = session.stderr.trim();
        if (stderrText) console.log(`[sidecar journal reopen stderr]\n${stderrText}\n`);
    }

    const independent = new DatabaseSync(dbPath, { readOnly: true });
    let finalMode;
    let quickCheck;
    try {
        finalMode = independent.prepare('PRAGMA journal_mode').get()?.journal_mode;
        quickCheck = independent.prepare('PRAGMA quick_check').get()?.quick_check;
    } finally {
        independent.close();
    }
    check(finalMode === 'delete' && quickCheck === 'ok' && sidecarFiles().length === 0,
        'sidecar/leaving-wal-is-durable-and-the-file-is-intact',
        `mode=${finalMode}, quick_check=${quickCheck}, files=${JSON.stringify(sidecarFiles())}`);

    const readOnly = startSidecar(binary, dbPath, 'ro');
    try {
        await readOnly.invoke('initializeDatabase', ['journal-fixture.sqlite', {
            path: dbPath, readOnlyMode: true
        }]);
        const refused = await readOnly.invoke('setPragma', ['journal_mode', 'WAL']);
        check(refused.content?.success === false && /read-only/i.test(refused.content?.errorMessage ?? ''),
            'sidecar/read-only-session-cannot-change-journal-mode', JSON.stringify(refused.content));
        readOnly.endStdin();
        await readOnly.untilExit();
    } finally {
        if (readOnly.exitCode === null) readOnly.child.kill('SIGKILL');
    }
    return checks;
}

/**
 * A 0444 database opened in a WRITABLE session (capstone E-11).
 *
 * SQLite opens such a file happily and only refuses at the first write, so
 * initializeDatabase used to answer `isReadOnly: false` and the UI offered
 * edits that could not possibly land. The open-time BEGIN IMMEDIATE probe has
 * to catch it, report it, and leave the session honestly read-only.
 *
 * @returns {Promise<number>} checks run
 */
async function runUnwritableFileCase(binary, scratch, note) {
    let checks = 0;
    const check = (ok, label, detail) => { note(ok, label, detail); checks += 1; };

    const dbPath = path.join(scratch, 'unwritable-fixture.sqlite');
    createFixture(dbPath);
    fs.chmodSync(dbPath, 0o444);

    const session = startSidecar(binary, dbPath, 'rw');
    try {
        const init = await session.invoke('initializeDatabase', ['unwritable-fixture.sqlite', {
            path: dbPath, readOnlyMode: false
        }]);
        check(init.content?.success === true
            && init.content?.data?.isReadOnly === true
            && /read-only/i.test(init.content?.data?.readOnlyReason ?? ''),
            'sidecar/E11-unwritable-file-opens-read-only',
            JSON.stringify(init.content?.data));

        // ...and the refusal is the ordinary read-only one, before SQLite is
        // ever asked to do the impossible.
        const write = await session.invoke('insertRow', ['t', { name: 'nope' }]);
        check(write.content?.success === false
            && /read-only/i.test(write.content?.errorMessage ?? ''),
            'sidecar/E11-unwritable-file-refuses-edits-up-front',
            JSON.stringify(write.content?.errorMessage));

        const read = await session.invoke('fetchSchema', []);
        check(read.content?.success === true
            && (read.content?.data?.tables?.map((table) => table.identifier) ?? []).includes('t'),
            'sidecar/E11-unwritable-file-still-reads');

        // …and the GRID reads, which is the half that was broken. Escalating to
        // read-only used to arm `PRAGMA query_only` behind the shim's back, so
        // the shim's column probe could no longer create its TEMP VIEW, the
        // refusal was swallowed into "no columns", and fetchTableData died on
        // "Cell containment requires a positive column count, got 0" — the
        // schema loaded, the table was selectable, and selecting it replaced the
        // grid with an internal invariant message. fetchSchema alone never saw
        // it, because schema reads do not go through the probe.
        const grid = await session.invoke('fetchTableData', ['t', { limit: 100, offset: 0 }]);
        check(grid.content?.success === true
            && Array.isArray(grid.content?.data?.headers)
            && grid.content.data.headers.length > 0
            && (grid.content?.data?.rows?.length ?? 0) > 0,
            'sidecar/E11-unwritable-file-renders-a-grid',
            JSON.stringify(grid.content?.errorMessage ?? grid.content?.data?.headers));

        session.endStdin();
        const code = await session.untilExit();
        check(code === 0, 'sidecar/E11-unwritable-session-exits-clean', `exit ${code}`);
    } finally {
        if (session.exitCode === null) session.child.kill('SIGKILL');
        const stderrText = session.stderr.trim();
        if (stderrText) console.log(`[sidecar unwritable stderr]\n${stderrText}\n`);
        fs.chmodSync(dbPath, 0o644);
    }

    // WRITABLE CONTROL. The probe attempts a real write, so it has to be
    // provably invisible: open a writable database, do nothing else, and the
    // file must be byte-identical afterwards with no journal left behind.
    const controlPath = path.join(scratch, 'probe-control.sqlite');
    createFixture(controlPath);
    const before = createHash('sha256').update(fs.readFileSync(controlPath)).digest('hex');
    const control = startSidecar(binary, controlPath, 'rw');
    try {
        const init = await control.invoke('initializeDatabase', ['probe-control.sqlite', {
            path: controlPath, readOnlyMode: false
        }]);
        const sidecars = ['-journal', '-wal', '-shm']
            .filter((suffix) => fs.existsSync(`${controlPath}${suffix}`));
        const after = createHash('sha256').update(fs.readFileSync(controlPath)).digest('hex');
        check(init.content?.data?.isReadOnly === false
            && init.content?.data?.readOnlyReason === undefined
            && after === before
            && sidecars.length === 0,
            'sidecar/E11-write-probe-leaves-a-writable-database-untouched',
            `same=${after === before}, leftovers=${JSON.stringify(sidecars)}`);

        control.endStdin();
        const code = await control.untilExit();
        check(code === 0, 'sidecar/E11-control-session-exits-clean', `exit ${code}`);
    } finally {
        if (control.exitCode === null) control.child.kill('SIGKILL');
        const stderrText = control.stderr.trim();
        if (stderrText) console.log(`[sidecar probe-control stderr]\n${stderrText}\n`);
    }

    // READ-ONLY DIRECTORY: the shape this defect was actually reported in (a
    // read-only mount, a locked-down folder). The FILE stays rw-r--r--; only
    // the directory refuses, so SQLite opens it happily, serves every read, and
    // fails only when it tries to create the journal. Same escalation path as
    // the 0444 case above, different trigger — and the one a user hits without
    // having done anything unusual.
    checks += await runReadOnlyDirectoryCase(binary, scratch, note);
    return checks;
}

/**
 * @returns {Promise<number>} checks run (0 when the platform cannot express it)
 */
async function runReadOnlyDirectoryCase(binary, scratch, note) {
    if (process.platform === 'win32') return 0;
    const directory = path.join(scratch, 'readonly-dir');
    fs.mkdirSync(directory, { recursive: true });
    const dbPath = path.join(directory, 'locked.sqlite');
    createFixture(dbPath);
    fs.chmodSync(directory, 0o555);
    try {
        // Running as root defeats the fixture entirely (root writes read-only
        // directories), so PROVE the trigger before asserting anything about it
        // — a silently-writable directory would turn this into a green test of
        // nothing.
        const witness = path.join(directory, '.write-probe');
        let refuses = false;
        try {
            fs.writeFileSync(witness, 'x');
            fs.rmSync(witness, { force: true });
        } catch {
            refuses = true;
        }
        if (!refuses) {
            note(true, 'sidecar/E11-readonly-directory-SKIPPED', 'the directory is still writable (root?)');
            return 1;
        }

        const session = startSidecar(binary, dbPath, 'rw');
        try {
            const init = await session.invoke('initializeDatabase', ['locked.sqlite', {
                path: dbPath, readOnlyMode: false
            }]);
            const grid = await session.invoke('fetchTableData', ['t', { limit: 100, offset: 0 }]);
            note(init.content?.data?.isReadOnly === true
                && /read-only/i.test(init.content?.data?.readOnlyReason ?? '')
                && grid.content?.success === true
                && (grid.content?.data?.headers?.length ?? 0) > 0
                && (grid.content?.data?.rows?.length ?? 0) > 0,
                'sidecar/E11-readonly-directory-opens-read-only-and-renders',
                JSON.stringify({
                    isReadOnly: init.content?.data?.isReadOnly,
                    grid: grid.content?.errorMessage ?? grid.content?.data?.headers
                }));

            session.endStdin();
            const code = await session.untilExit();
            note(code === 0, 'sidecar/E11-readonly-directory-session-exits-clean', `exit ${code}`);
        } finally {
            if (session.exitCode === null) session.child.kill('SIGKILL');
            const stderrText = session.stderr.trim();
            if (stderrText) console.log(`[sidecar readonly-dir stderr]\n${stderrText}\n`);
        }
        return 2;
    } finally {
        // Always restore, or the scratch directory cannot be removed.
        fs.chmodSync(directory, 0o755);
    }
}

/** Mirrors DESKTOP_EXPORT_MAX_BYTES in desktop-host.js (the host's raised ceiling). */
const DESKTOP_EXPORT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Drive the SHELL-ORIGINATED export-to-path route through the real binary:
 * `{channel:'shell', content:{kind:'export', ...}}` in, a small
 * `{kind:'export-result'}` reply out, and the actual bytes land at the
 * shell-provided temp path — for BOTH methods, on results larger than the
 * 16 MiB frame cap (which the framed route provably cannot carry). Also the
 * negative space: the webview's rpc surface must NOT reach exportToPath, and
 * an rpc-channel envelope must never be treated as a shell export.
 *
 * @returns {Promise<number>} checks run
 */
async function runShellExportCase(binary, scratch, note) {
    let checks = 0;
    const check = (ok, label, detail) => { note(ok, label, detail); checks += 1; };

    // A fixture whose DB image AND CSV export both exceed MAX_FRAME_BYTES:
    // 20,000 rows x 1,016 chars of hex text ≈ 20.3 MiB of payload.
    const bigPath = path.join(scratch, 'shell-export-big.sqlite');
    fs.rmSync(bigPath, { force: true });
    {
        const big = new DatabaseSync(bigPath);
        big.exec(`
            CREATE TABLE big(id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
            INSERT INTO big(payload)
                WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 20000)
                SELECT hex(randomblob(508)) FROM n;
        `);
        big.close();
    }

    const session = startSidecar(binary, bigPath, 'rw');
    try {
        const init = await session.invoke('initializeDatabase', ['shell-export-big.sqlite', {
            path: bigPath, readOnlyMode: false, queryTimeout: 30000
        }]);
        check(init.content?.success === true, 'sidecar/shell-export-session-initializes',
            JSON.stringify(init.content?.errorMessage ?? ''));

        // exportDatabase → VACUUM INTO the shell's temp path. Only the small
        // export-result crosses the pipe; the >16 MiB image never does.
        const dbTemp = path.join(scratch, 'shell-export-db.sqlite');
        fs.rmSync(dbTemp, { force: true });
        let dbReply;
        try {
            dbReply = await session.shellExport('exportDatabase', dbTemp, undefined, 120000);
        } catch (error) {
            dbReply = { laneError: String(error?.message ?? error) };
        }
        const dbSize = fs.existsSync(dbTemp) ? fs.statSync(dbTemp).size : -1;
        let bigCount = null;
        if (dbSize > 0) {
            const reopened = new DatabaseSync(dbTemp, { readOnly: true });
            bigCount = reopened.prepare('SELECT count(*) AS c FROM big').get().c;
            reopened.close();
        }
        check(dbReply?.channel === 'shell'
            && dbReply?.content?.kind === 'export-result'
            && dbReply?.content?.success === true
            && dbReply?.content?.bytesWritten === dbSize
            && dbSize > MAX_FRAME_BYTES
            && bigCount === 20000,
            'sidecar/shell-export-database-lands-over-16MiB',
            `reply=${JSON.stringify(dbReply?.content ?? dbReply)} size=${dbSize} rows=${bigCount}`);

        // exportTable → the worker's own exportTable runs in-process; its
        // chunks are written to the shell's temp path as one CSV file.
        const csvTemp = path.join(scratch, 'shell-export-table.csv');
        fs.rmSync(csvTemp, { force: true });
        let csvReply;
        try {
            csvReply = await session.shellExport('exportTable', csvTemp, [
                { table: 'big' }, [], null, null,
                { format: 'csv', header: true, maxExportBytes: DESKTOP_EXPORT_MAX_BYTES }
            ], 120000);
        } catch (error) {
            csvReply = { laneError: String(error?.message ?? error) };
        }
        const csvSize = fs.existsSync(csvTemp) ? fs.statSync(csvTemp).size : -1;
        let csvShape = null;
        if (csvSize > 0) {
            const lines = fs.readFileSync(csvTemp, 'utf8').split('\n');
            // Row 1 checked against the DB itself: real content, byte-exact.
            const reopened = new DatabaseSync(bigPath, { readOnly: true });
            const row1 = reopened.prepare('SELECT payload FROM big WHERE id = 1').get().payload;
            reopened.close();
            csvShape = {
                header: lines[0],
                lineCount: lines.length,
                row1Matches: lines[1] === `1,${row1}`
            };
        }
        check(csvReply?.channel === 'shell'
            && csvReply?.content?.kind === 'export-result'
            && csvReply?.content?.success === true
            && csvReply?.content?.bytesWritten === csvSize
            && csvSize > MAX_FRAME_BYTES
            && csvShape?.header === 'id,payload'
            && csvShape?.lineCount === 20001
            && csvShape?.row1Matches === true,
            'sidecar/shell-export-table-csv-lands-over-16MiB',
            `reply=${JSON.stringify(csvReply?.content ?? csvReply)} size=${csvSize} ` +
            `shape=${JSON.stringify({ ...csvShape, header: csvShape?.header?.slice(0, 40) })}`);

        // Failure contract, exportDatabase: an existing target fails closed
        // (VACUUM INTO refuses it) with a structured error; file untouched.
        const occupied = path.join(scratch, 'shell-export-occupied');
        fs.writeFileSync(occupied, 'occupied');
        const clash = await session.shellExport('exportDatabase', occupied, undefined, 60000)
            .catch((error) => ({ laneError: String(error?.message ?? error) }));
        check(clash?.content?.kind === 'export-result'
            && clash?.content?.success === false
            && typeof clash?.content?.error?.message === 'string'
            && clash.content.error.message.length > 0
            && fs.readFileSync(occupied, 'utf8') === 'occupied',
            'sidecar/shell-export-existing-target-fails-closed',
            JSON.stringify(clash?.content ?? clash));

        // Failure contract, exportTable: a worker-level failure (unknown
        // table) reports structurally and creates NO file at the temp path.
        const failTemp = path.join(scratch, 'shell-export-fail.csv');
        fs.rmSync(failTemp, { force: true });
        const noTable = await session.shellExport('exportTable', failTemp, [
            { table: 'no_such_table' }, [], null, null,
            { format: 'csv', header: true, maxExportBytes: DESKTOP_EXPORT_MAX_BYTES }
        ], 60000).catch((error) => ({ laneError: String(error?.message ?? error) }));
        check(noTable?.content?.kind === 'export-result'
            && noTable?.content?.success === false
            && typeof noTable?.content?.error?.message === 'string'
            && !fs.existsSync(failTemp),
            'sidecar/shell-export-table-failure-creates-no-file',
            `${JSON.stringify(noTable?.content ?? noTable)} created=${fs.existsSync(failTemp)}`);

        // SECURITY: the webview surface did not widen — exportToPath is not a
        // worker method the rpc channel can reach.
        const viaRpc = await session.invoke('exportToPath', ['/tmp/shell-export-pwn.sqlite']);
        check(viaRpc.content?.success === false
            && viaRpc.content?.errorMessage === 'Unknown method: exportToPath',
            'sidecar/exportToPath-not-a-worker-method', JSON.stringify(viaRpc.content));

        // SECURITY: an rpc-channel envelope carrying the shell-export shape is
        // NEVER treated as a shell export (worker.js ignores it; no file, no
        // reply). The ping is the ordering barrier: by the time it answers,
        // the forged frame has been consumed.
        const forgedTemp = path.join(scratch, 'shell-export-forged');
        fs.rmSync(forgedTemp, { force: true });
        session.sendRaw({
            channel: 'rpc',
            content: { kind: 'export', messageId: 'forged_1', method: 'exportDatabase', tempPath: forgedTemp }
        });
        const barrier = await session.invoke('ping', []);
        check(barrier.content?.success === true && !fs.existsSync(forgedTemp),
            'sidecar/rpc-envelope-never-treated-as-shell-export',
            `created=${fs.existsSync(forgedTemp)}`);

        session.endStdin();
        const code = await session.untilExit();
        check(code === 0, 'sidecar/shell-export-session-eof-exits-clean', `exit ${code}`);
    } finally {
        if (session.exitCode === null) session.child.kill('SIGKILL');
        const stderrText = session.stderr.trim();
        if (stderrText) console.log(`[sidecar shell-export stderr]\n${stderrText}\n`);
    }
    return checks;
}

/**
 * Kill the sidecar's PARENT while a grandparent keeps its stdin pipe open, so
 * EOF never arrives and only the ppid watchdog can notice the orphaning.
 *
 * Topology: this process (L) spawns an intermediary node process (P) with an
 * extra pipe on fd 3; P spawns the sidecar (S) with that fd as S's stdin. The
 * pipe's write end lives in L, so SIGKILLing P closes nothing S reads from —
 * exactly the "write end inherited elsewhere" scenario the watchdog exists
 * for. S's stderr rides P's inherited stderr pipe, which S keeps holding
 * after P dies, so the watchdog's log line still reaches L.
 *
 * @returns {Promise<number>} checks run
 */
async function runWatchdogCase(binary, dbPath, note) {
    let checks = 0;
    const check = (ok, label, detail) => { note(ok, label, detail); checks += 1; };

    const intermediarySource = `
        const { spawn } = require('node:child_process');
        const child = spawn(${JSON.stringify(binary)},
            ['run', ${JSON.stringify(BUNDLE_PATH)}, ${JSON.stringify(dbPath)}, 'rw'],
            { stdio: [3, 'ignore', 'inherit'] });
        console.log(String(child.pid));
        setInterval(() => {}, 1000); // stay alive until killed
    `;
    const intermediary = spawn(process.execPath, ['-e', intermediarySource], {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe']
    });

    let stderr = '';
    intermediary.stderr.on('data', (chunk) => { stderr += chunk; });
    const sidecarPid = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('intermediary never reported the sidecar pid')), 10000);
        let stdout = '';
        intermediary.stdout.on('data', (chunk) => {
            stdout += chunk;
            const match = stdout.match(/^(\d+)\n/);
            if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
    });

    const alive = (pid) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
    };

    try {
        // No false positive while the parent lives: outlast one watchdog tick.
        await sleep(2000);
        check(alive(sidecarPid), 'sidecar/watchdog-quiet-while-parent-alive', `pid ${sidecarPid}`);

        intermediary.kill('SIGKILL');
        // L still holds the stdin write end, so the ONLY signal S gets is the
        // reparenting the watchdog polls for.
        let died = false;
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            if (!alive(sidecarPid)) { died = true; break; }
            await sleep(200);
        }
        check(died, 'sidecar/watchdog-exits-orphan-with-open-stdin', `pid ${sidecarPid}`);

        // The abnormal-death breadcrumb reached us over the inherited stderr.
        // The orphan reparents to the OS reaper (launchd/init), so its real
        // wait-status is unreachable here — the watchdog names its numeric exit
        // code in the breadcrumb (EXIT_ORPHANED = 3), and that is what we assert.
        await sleep(200);
        check(/vanished without closing stdin/.test(stderr) && /exiting \(code 3\)/.test(stderr),
            'sidecar/watchdog-logs-abnormal-death-with-code-3', JSON.stringify(stderr.trim().slice(0, 220)));
    } finally {
        if (alive(sidecarPid)) process.kill(sidecarPid, 'SIGKILL');
        if (intermediary.exitCode === null) intermediary.kill('SIGKILL');
    }
    return checks;
}
