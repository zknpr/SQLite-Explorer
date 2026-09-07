/**
 * Per-method sweep of the worker surface, driven through the REAL sidecar.
 *
 * The sidecar lane next door proves the transport, the security boundaries and
 * the defects a capstone found. This file proves something narrower and more
 * boring: that **every single method the dispatch table exposes is actually
 * driven at least once against the real binary, on a happy path AND on a
 * failure path**, and that the failure answers something a human could act on.
 *
 * WHY BOTH HALVES. This project's real bugs have not been crashes. They have
 * been an error swallowed into an empty result (a read-only escalation turning
 * a grid into "0 columns"), a message that names nothing ("SQL logic error"
 * where a table name was available), and `undefined` becoming `null` at a JSON
 * boundary (column drop, broken for the ordinary case). None of those are
 * visible from a happy path, and all three are visible from the failure path
 * of a method someone remembered to call.
 *
 * COMPLETENESS IS MECHANICAL, NOT ASPIRATIONAL. `sweep/covers-every-shipped-
 * method` extracts the dispatch table from the COMMITTED sidecar bundle — the
 * same regex the app repo's sync-viewer drift-pin uses — and fails if the
 * sweep's own registry is not exactly that set. A method added upstream is
 * therefore untestable-and-green for exactly zero commits.
 *
 * ENGINE NOTE. Everything here runs on the native engine, whose errors are
 * frequently nonspecific by construction (the fork cannot report SQLite's
 * detailed message). Failure assertions therefore prefer messages the WORKER
 * itself produces — those are engine-independent contracts — and, where only
 * the engine can speak, assert the recovered class plus the fact that the
 * refusal left no state behind.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startSidecar, BUNDLE_PATH } from './native-sidecar-lane.mjs';

/** The blob planted in people.payload row 1; every byte class in five bytes. */
const FIXTURE_BLOB = [0x00, 0x01, 0x7f, 0x80, 0xff];
/** An oversized-cell fixture: 100 bytes, well over the tiny limit we pass in. */
const OVERSIZE_TEXT = 'x'.repeat(100);
/** Edit limit used for the oversized-cell path, so 100 bytes counts as "over". */
const TINY_EDIT_LIMIT = 16;
/** 5 characters, 8 UTF-8 bytes — a character count would be visibly wrong. */
const MULTIBYTE_TEXT = 'A\u{1F600}Bé';
const MULTIBYTE_TEXT_BYTES = new TextEncoder().encode(MULTIBYTE_TEXT).byteLength;

function createSweepFixture(dbPath) {
    fs.rmSync(dbPath, { force: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
        CREATE TABLE people(
            id INTEGER PRIMARY KEY,
            name TEXT,
            note TEXT,
            payload BLOB,
            big INTEGER,
            r REAL
        );
        INSERT INTO people VALUES
            (1, 'alpha', 'n1', X'00017f80ff',  9223372036854775807,  1.5),
            (2, 'beta',  'n2', NULL,          -9223372036854775808, -2.25),
            (3, 'gamma', 'n3', X'',            9007199254740993,      0.0);
        CREATE INDEX idx_people_note ON people(note);
        CREATE VIEW people_view AS SELECT id, name FROM people;
        CREATE TABLE oversize(id INTEGER PRIMARY KEY, texty TEXT, blobby BLOB);
        INSERT INTO oversize VALUES (1, '${OVERSIZE_TEXT}', randomblob(100));
        -- Row 2 is the getCellMetadata TEXT fixture and nothing else writes it:
        -- 5 characters, ${MULTIBYTE_TEXT_BYTES} UTF-8 bytes, so a character count would be visibly wrong.
        INSERT INTO oversize VALUES (2, '${MULTIBYTE_TEXT}', NULL);
    `);
    db.close();
}

const equalBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
/** Response `content`, or a lane-side stand-in so a check never sees undefined. */
const body = (reply) => reply?.content ?? { success: undefined, laneError: 'no content' };
const failed = (reply, pattern) => {
    const content = body(reply);
    return content.success === false && pattern.test(String(content.errorMessage ?? ''));
};
const detail = (reply) => JSON.stringify(body(reply), (_k, v) => (
    typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? [...v] : v
));

/**
 * The method registry. One entry per shipped dispatch-table method; each entry
 * runs at least one happy check and at least one failure check. Order is
 * deliberate — later entries lean on schema earlier ones built.
 *
 * @type {Array<[string, (ctx: {s: any, check: Function, scratch: string, dbPath: string, state: Record<string, any>}) => Promise<void>]>}
 */
const SWEEP = [
    // ---- lifecycle -------------------------------------------------------
    ['initializeDatabase', async ({ s, check, dbPath }) => {
        const init = await s.invoke('initializeDatabase', ['sweep.sqlite', {
            path: dbPath, readOnlyMode: false, queryTimeout: 30000
        }]);
        const data = body(init).data;
        check(body(init).success === true
            && data?.isReadOnly === false
            && data?.storage === 'memory',
            'sweep/initializeDatabase/happy', detail(init));

        // The failure path lives in the dead-session phase at the end of the
        // sweep, because a refused re-init DESTROYS the live connection (the
        // worker closes `db` before it asks the engine factory for a new one).
        // Running it here would end the sweep at method one.
        check(true, 'sweep/initializeDatabase/error-deferred-to-dead-session-phase');
    }],

    ['ping', async ({ s, check }) => {
        const alive = await s.invoke('ping', []);
        check(body(alive).success === true && body(alive).data === true,
            'sweep/ping/happy', detail(alive));
        // ping's failure path is "the database is gone" — it answers `false`
        // rather than throwing. Asserted in the dead-session phase.
        check(true, 'sweep/ping/error-deferred-to-dead-session-phase');
    }],

    ['refreshFile', async ({ s, check }) => {
        // DELIBERATE REFUSAL at the worker layer. The desktop answers ⌘R in
        // desktop-host.js (which re-opens the bound path and returns
        // {connected, filename, readOnly}) and never forwards it; the worker's
        // own version exists so the VS Code contract has a callee, and it
        // refuses because only a host holding the original source can reload.
        // Pinned so a future change has to be deliberate: it must not start
        // reporting a refresh it did not do, and it must not touch the data.
        const before = await s.invoke('runQuery', ['SELECT count(*) AS c FROM people']);
        const refresh = await s.invoke('refreshFile', []);
        const after = await s.invoke('runQuery', ['SELECT count(*) AS c FROM people']);
        check(failed(refresh, /Reload must be handled by the demo host/)
            && JSON.stringify(body(before).data) === JSON.stringify(body(after).data),
            'sweep/refreshFile/happy-refuses-and-claims-nothing', detail(refresh));

        // No argument shape changes that answer: a refusal must not become a
        // crash surface for a hostile caller either.
        const hostile = await s.invoke('refreshFile', [{ __proto__: { polluted: true } }, 'extra']);
        check(failed(hostile, /Reload must be handled by the demo host/),
            'sweep/refreshFile/error-surplus-and-hostile-arguments-still-refuse', detail(hostile));
    }],

    // ---- schema reads ----------------------------------------------------
    ['fetchSchema', async ({ s, check }) => {
        const schema = await s.invoke('fetchSchema', []);
        const data = body(schema).data;
        check(body(schema).success === true
            && data?.tables?.some((t) => t.identifier === 'people')
            && data?.views?.some((v) => v.identifier === 'people_view')
            && data?.indexes?.some((i) => i.identifier === 'idx_people_note' && i.parentTable === 'people'),
            'sweep/fetchSchema/happy', detail(schema));
        check(true, 'sweep/fetchSchema/error-deferred-to-dead-session-phase');
    }],

    ['getTableInfo', async ({ s, check }) => {
        const info = await s.invoke('getTableInfo', ['people']);
        const columns = (body(info).data ?? []).map((c) => c.identifier);
        const idColumn = (body(info).data ?? [])[0];
        check(body(info).success === true
            && JSON.stringify(columns) === JSON.stringify(['id', 'name', 'note', 'payload', 'big', 'r'])
            && idColumn?.declaredType === 'INTEGER'
            && idColumn?.primaryKeyPosition === 1,
            'sweep/getTableInfo/happy', detail(info));

        // FINDING (reported, not fixed here): an unknown table is answered
        // with an EMPTY ARRAY and success:true, not an error — PRAGMA
        // table_info on a missing table legitimately returns no rows and the
        // method cannot tell that from a table with no columns. This is the
        // project's signature bug class, so it is pinned rather than left
        // undiscovered: the assertion records TODAY's behaviour so a fix
        // shows up here as a deliberate change.
        const missing = await s.invoke('getTableInfo', ['no_such_table']);
        check(body(missing).success === true
            && Array.isArray(body(missing).data)
            && body(missing).data.length === 0,
            'sweep/getTableInfo/error-unknown-table-answers-empty-NOT-an-error',
            detail(missing));
    }],

    ['getPragmas', async ({ s, check }) => {
        const pragmas = await s.invoke('getPragmas', []);
        const data = body(pragmas).data ?? {};
        // Every pragma the settings modal renders must come back. A missing
        // key renders as a blank control the user cannot reason about, and
        // getPragmas swallows per-pragma failures by design.
        const expected = ['foreign_keys', 'journal_mode', 'synchronous', 'cache_size',
            'locking_mode', 'temp_store', 'encoding', 'auto_vacuum'];
        const missing = expected.filter((name) => data[name] === undefined);
        check(body(pragmas).success === true && missing.length === 0 && data.foreign_keys === 1,
            'sweep/getPragmas/happy-every-rendered-pragma-has-a-value',
            missing.length ? `missing: ${missing.join(', ')}` : detail(pragmas));
        check(true, 'sweep/getPragmas/error-deferred-to-dead-session-phase');
    }],

    ['setPragma', async ({ s, check }) => {
        const set = await s.invoke('setPragma', ['cache_size', -4000]);
        const readBack = await s.invoke('getPragmas', []);
        check(body(set).success === true && body(readBack).data?.cache_size === -4000,
            'sweep/setPragma/happy-value-is-observable-afterwards', detail(readBack));

        const disallowed = await s.invoke('setPragma', ['page_size', 4096]);
        check(failed(disallowed, /Invalid or disallowed PRAGMA: page_size/),
            'sweep/setPragma/error-unlisted-pragma-is-named-and-refused', detail(disallowed));

        // The string branch is a string-concatenated PRAGMA, so its allowlist
        // is load-bearing, not cosmetic.
        const injected = await s.invoke('setPragma', ['journal_mode', "delete'; DROP TABLE people; --"]);
        const survived = await s.invoke('runQuery', ['SELECT count(*) AS c FROM people']);
        check(failed(injected, /Invalid PRAGMA string value/)
            && body(survived).data?.[0]?.rows?.[0]?.[0] === 3,
            'sweep/setPragma/error-injection-in-a-string-value-is-refused-and-inert',
            detail(injected));
    }],

    // ---- data reads ------------------------------------------------------
    ['runQuery', async ({ s, check }) => {
        const ok = await s.invoke('runQuery', ['SELECT id, name FROM people ORDER BY id']);
        const set = body(ok).data?.[0];
        check(body(ok).success === true
            && JSON.stringify(set?.headers) === JSON.stringify(['id', 'name'])
            && JSON.stringify(set?.rows?.map((row) => row[1])) === JSON.stringify(['alpha', 'beta', 'gamma']),
            'sweep/runQuery/happy', detail(ok));

        // The message must NAME the missing table. The native fork answers a
        // nonspecific "SQL logic error" and the shim recovers the specific
        // phrasing by probing the catalog; if that recovery ever regresses,
        // the user is told nothing and this fails.
        const bad = await s.invoke('runQuery', ['SELECT * FROM definitely_absent']);
        check(failed(bad, /no such table: definitely_absent/),
            'sweep/runQuery/error-names-the-missing-table', detail(bad));
    }],

    ['runConsole', async ({ s, check }) => {
        const ok = await s.invoke('runConsole', ['SELECT name FROM people ORDER BY id']);
        check(body(ok).success === true
            && body(ok).data?.error === undefined
            && body(ok).data?.results?.[0]?.rows?.length === 3,
            'sweep/runConsole/happy', detail(ok));

        // Execution-phase failures RESOLVE with data.error (the host's
        // result-conditional barrier depends on it), so "success:false" would
        // itself be the bug here.
        const bad = await s.invoke('runConsole', ['SELECT * FROM definitely_absent']);
        check(body(bad).success === true
            && /no such table: definitely_absent/.test(body(bad).data?.error ?? '')
            && (body(bad).data?.results?.length ?? 0) === 0
            && body(bad).data?.mutated === false,
            'sweep/runConsole/error-resolves-with-a-named-error-and-no-phantom-rows',
            detail(bad));
    }],

    ['fetchTableData', async ({ s, check }) => {
        const page = await s.invoke('fetchTableData', ['people', { limit: 2, offset: 1, orderBy: 'id' }]);
        const data = body(page).data;
        check(body(page).success === true
            && data?.headers?.includes('name')
            && data?.rows?.length === 2,
            'sweep/fetchTableData/happy', detail(page));

        const bad = await s.invoke('fetchTableData', ['definitely_absent', { limit: 10 }]);
        check(body(bad).success === false && String(body(bad).errorMessage ?? '').length > 0,
            'sweep/fetchTableData/error-unknown-table-rejects-instead-of-empty-grid',
            detail(bad));
    }],

    ['fetchTableCount', async ({ s, check }) => {
        const count = await s.invoke('fetchTableCount', ['people']);
        check(body(count).success === true
            && body(count).data?.count === 3
            && body(count).data?.isExact === true,
            'sweep/fetchTableCount/happy', detail(count));

        // The count feeds pagination clamps; a swallowed failure reading as 0
        // would silently empty the grid.
        const bad = await s.invoke('fetchTableCount', ['definitely_absent']);
        check(body(bad).success === false && String(body(bad).errorMessage ?? '').length > 0,
            'sweep/fetchTableCount/error-unknown-table-rejects-instead-of-zero',
            detail(bad));
    }],

    // ---- DDL: tables and columns ----------------------------------------
    ['createTable', async ({ s, check }) => {
        const made = await s.invoke('createTable', ['sweep_made', [
            { name: 'id', type: 'INTEGER', primaryKey: true },
            { name: 'label', type: 'TEXT', notNull: true, defaultValue: 'unset' }
        ]]);
        const info = await s.invoke('getTableInfo', ['sweep_made']);
        const columns = (body(info).data ?? []).map((c) => c.identifier);
        check(body(made).success === true
            && JSON.stringify(columns) === JSON.stringify(['id', 'label'])
            && (body(info).data ?? [])[1]?.isRequired === 1,
            'sweep/createTable/happy', detail(info));

        // The type string is interpolated into DDL, so validateSqlType is the
        // only thing between a column type and arbitrary SQL. Prove the
        // refusal AND that nothing was created.
        const injected = await s.invoke('createTable', ['sweep_injected', [
            { name: 'x', type: 'TEXT); DROP TABLE people; --' }
        ]]);
        const survived = await s.invoke('runQuery', ['SELECT count(*) AS c FROM people']);
        const leftover = await s.invoke('runQuery', [
            "SELECT count(*) AS c FROM sqlite_schema WHERE name = 'sweep_injected'"
        ]);
        check(body(injected).success === false
            && body(survived).data?.[0]?.rows?.[0]?.[0] === 3
            && body(leftover).data?.[0]?.rows?.[0]?.[0] === 0,
            'sweep/createTable/error-injected-type-refused-and-nothing-created',
            detail(injected));
    }],

    ['addColumn', async ({ s, check }) => {
        const added = await s.invoke('addColumn', ['sweep_made', 'added', 'TEXT', 'seed']);
        const info = await s.invoke('getTableInfo', ['sweep_made']);
        const added_ = (body(info).data ?? []).find((c) => c.identifier === 'added');
        check(body(added).success === true
            && added_?.declaredType === 'TEXT'
            && String(added_?.defaultExpression ?? '').includes('seed'),
            'sweep/addColumn/happy-with-a-default', detail(info));

        const injected = await s.invoke('addColumn', ['sweep_made', 'evil', 'TEXT DEFAULT (randomblob(1)) --']);
        const after = await s.invoke('getTableInfo', ['sweep_made']);
        check(body(injected).success === false
            && !(body(after).data ?? []).some((c) => c.identifier === 'evil'),
            'sweep/addColumn/error-invalid-type-refused-and-no-column-added',
            detail(injected));
    }],

    ['findDependentIndexes', async ({ s, check }) => {
        // SQLite itself is the parser here: the worker recreates each index
        // against a TEMP probe table and asks DROP COLUMN. The answer is the
        // exact {identifier, sql} definitions, which go back with the drop.
        const deps = await s.invoke('findDependentIndexes', ['people', ['note']]);
        const data = body(deps).data;
        check(body(deps).success === true
            && Array.isArray(data)
            && data.some((index) => index.identifier === 'idx_people_note' && /idx_people_note/.test(index.sql)),
            'sweep/findDependentIndexes/happy-names-the-blocking-index', detail(deps));

        // Shape validation matters here specifically: this result is fed
        // straight back in as deleteColumns' third argument.
        const bad = await s.invoke('findDependentIndexes', ['people', 'note']);
        check(failed(bad, /Column names must be an array/),
            'sweep/findDependentIndexes/error-a-bare-string-is-refused', detail(bad));
    }],

    ['deleteColumns', async ({ s, check }) => {
        // REGRESSION PIN for F-E, at the layer where it actually broke. The
        // webview used to send `[table, columns, undefined]`, which JSON
        // renders as `null`, and the worker's confirmation validator rejects
        // it. Two-and-a-half assertions: the ordinary no-dependency drop must
        // SUCCEED with an absent third argument, an explicit `null` must still
        // be REFUSED (the validator is load-bearing, not collateral), and the
        // dependency-carrying drop must work when handed the definitions.
        await s.invoke('runConsole', [
            'CREATE TABLE drop_plain(id INTEGER PRIMARY KEY, keep TEXT, victim TEXT);'
            + "INSERT INTO drop_plain VALUES (1,'k','v')"
        ]);
        const plain = await s.invoke('deleteColumns', ['drop_plain', ['victim']]);
        const plainInfo = await s.invoke('getTableInfo', ['drop_plain']);
        check(body(plain).success === true
            && !(body(plainInfo).data ?? []).some((c) => c.identifier === 'victim'),
            'sweep/deleteColumns/happy-F-E-absent-third-argument-drops-the-column',
            detail(plain));

        const nulled = await s.invoke('deleteColumns', ['drop_plain', ['keep'], null]);
        const stillThere = await s.invoke('getTableInfo', ['drop_plain']);
        check(failed(nulled, /Dependent-index confirmation must be an array/)
            && (body(stillThere).data ?? []).some((c) => c.identifier === 'keep'),
            'sweep/deleteColumns/error-explicit-null-is-still-refused-and-nothing-dropped',
            detail(nulled));

        // The dependency lane end to end: refused without the confirmation,
        // accepted with exactly the definitions findDependentIndexes returned.
        const blocked = await s.invoke('deleteColumns', ['people', ['note']]);
        const deps = await s.invoke('findDependentIndexes', ['people', ['note']]);
        const withList = await s.invoke('deleteColumns', [
            'people', ['note'], Array.from(body(deps).data ?? [])
        ]);
        const peopleInfo = await s.invoke('getTableInfo', ['people']);
        check(failed(blocked, /requires confirmation for dependent indexes: idx_people_note/)
            && body(withList).success === true
            && !(body(peopleInfo).data ?? []).some((c) => c.identifier === 'note'),
            'sweep/deleteColumns/happy-dependent-index-drops-when-the-definitions-are-supplied',
            `blocked=${detail(blocked)} withList=${detail(withList)}`);
    }],

    // ---- views -----------------------------------------------------------
    ['createView', async ({ s, check }) => {
        const made = await s.invoke('createView', ['sweep_view', 'SELECT id, name FROM people']);
        check(body(made).success === true && body(made).data?.identifier === 'sweep_view',
            'sweep/createView/happy', detail(made));

        // G-1 REGRESSION PIN. The view editor validates through
        // `compileSingleStatement('EXPLAIN SELECT …')`, and the native engine's
        // missing-table recovery used to give up on any statement wrapped in
        // EXPLAIN — so a plain typo in the view body came back as "SQL logic
        // error (… the native engine cannot report SQLite's detailed message)"
        // while the identical body named the table through runQuery. The
        // message must NAME what is missing on every one of these four
        // methods; that is the whole point of the view editor.
        const bad = await s.invoke('createView', ['sweep_broken', 'SELECT * FROM definitely_absent']);
        const leftover = await s.invoke('runQuery', [
            "SELECT count(*) AS c FROM sqlite_schema WHERE name = 'sweep_broken'"
        ]);
        check(failed(bad, /no such table: definitely_absent/)
            && body(leftover).data?.[0]?.rows?.[0]?.[0] === 0,
            'sweep/createView/error-G1-names-the-missing-table-and-leaves-no-view-behind',
            detail(bad));
    }],

    ['getViewDefinition', async ({ s, check }) => {
        const def = await s.invoke('getViewDefinition', ['sweep_view']);
        check(body(def).success === true
            && /CREATE VIEW/i.test(body(def).data?.sql ?? '')
            && Array.isArray(body(def).data?.triggers),
            'sweep/getViewDefinition/happy', detail(def));

        const missing = await s.invoke('getViewDefinition', ['definitely_absent_view']);
        check(failed(missing, /View not found: definitely_absent_view/),
            'sweep/getViewDefinition/error-names-the-view-it-could-not-find', detail(missing));
    }],

    ['validateViewDefinition', async ({ s, check }) => {
        const ok = await s.invoke('validateViewDefinition', ['sweep_view', 'SELECT id FROM people']);
        const unchanged = await s.invoke('getViewDefinition', ['sweep_view']);
        check(body(ok).success === true
            && /name/i.test(body(unchanged).data?.sql ?? ''),
            'sweep/validateViewDefinition/happy-validates-without-installing', detail(ok));

        const bad = await s.invoke('validateViewDefinition', ['sweep_view', 'SELECT * FROM definitely_absent']);
        const stillOk = await s.invoke('runQuery', ['SELECT count(*) AS c FROM sweep_view']);
        check(body(bad).success === false && body(stillOk).success === true,
            'sweep/validateViewDefinition/error-refuses-and-rolls-the-view-back', detail(bad));

        // G-1b, CLOSED. Every view-editor method now validates through the
        // INSTALLED main view (1.7.2), so the failing statement names only the
        // view — in the catalog, hence never accused. The missing-table proof
        // therefore walks into the view's stored body (sqlite-errors.js
        // findUnresolvedTableNames) and names the table it lost, on all four
        // methods alike.
        check(failed(bad, /no such table: definitely_absent/),
            'sweep/validateViewDefinition/error-G1-names-the-missing-table-through-the-installed-view',
            detail(bad));
    }],

    ['previewViewDefinition', async ({ s, check }) => {
        const preview = await s.invoke('previewViewDefinition', [
            'sweep_view', 'SELECT id, name FROM people ORDER BY id', 2
        ]);
        const set = body(preview).data;
        check(body(preview).success === true
            && (set?.rows?.length ?? set?.values?.length) === 2,
            'sweep/previewViewDefinition/happy-honours-the-limit', detail(preview));

        const bad = await s.invoke('previewViewDefinition', [
            'sweep_view', 'SELECT * FROM definitely_absent', 5
        ]);
        const stillOk = await s.invoke('runQuery', ['SELECT count(*) AS c FROM sweep_view']);
        check(body(bad).success === false && body(stillOk).success === true,
            'sweep/previewViewDefinition/error-refuses-and-leaves-the-installed-view-intact',
            detail(bad));
        // Same route as validateViewDefinition — see G-1b there.
        check(failed(bad, /no such table: definitely_absent/),
            'sweep/previewViewDefinition/error-G1-names-the-missing-table-through-the-installed-view',
            detail(bad));
    }],

    ['editView', async ({ s, check, state }) => {
        const before = body(await s.invoke('getViewDefinition', ['sweep_view'])).data;
        const edited = await s.invoke('editView', [
            'sweep_view', 'SELECT id, name, big FROM people', true, before.sql, before.triggers
        ]);
        const after = body(await s.invoke('getViewDefinition', ['sweep_view'])).data;
        check(body(edited).success === true
            && /big/.test(after?.sql ?? '')
            && body(edited).data?.before?.sql === before.sql,
            'sweep/editView/happy-with-a-matching-snapshot', detail(edited));
        state.viewSql = after?.sql;
        state.viewTriggers = after?.triggers;

        // A stale snapshot is the concurrent-edit guard; it must refuse rather
        // than overwrite someone else's definition.
        const stale = await s.invoke('editView', [
            'sweep_view', 'SELECT id FROM people', true, before.sql, before.triggers
        ]);
        const unchanged = body(await s.invoke('getViewDefinition', ['sweep_view'])).data;
        check(body(stale).success === false && unchanged?.sql === after?.sql,
            'sweep/editView/error-stale-snapshot-refused-and-definition-untouched',
            detail(stale));

        // G-1 on the fourth EXPLAIN-validated method (see createView).
        const broken = await s.invoke('editView', [
            'sweep_view', 'SELECT * FROM definitely_absent', true, after.sql, after.triggers
        ]);
        check(failed(broken, /no such table: definitely_absent/),
            'sweep/editView/error-G1-names-the-missing-table', detail(broken));
    }],

    ['dropView', async ({ s, check, state }) => {
        // Stale snapshot FIRST, so the failure path is proven while the view
        // still exists — then the real drop.
        const stale = await s.invoke('dropView', ['sweep_view', 'CREATE VIEW sweep_view AS SELECT 1', []]);
        const survived = await s.invoke('getViewDefinition', ['sweep_view']);
        check(body(stale).success === false && body(survived).success === true,
            'sweep/dropView/error-stale-snapshot-refused-and-the-view-survives', detail(stale));

        const dropped = await s.invoke('dropView', ['sweep_view', state.viewSql, state.viewTriggers]);
        const gone = await s.invoke('getViewDefinition', ['sweep_view']);
        check(body(dropped).success === true
            && body(dropped).data?.identifier === 'sweep_view'
            && failed(gone, /View not found/),
            'sweep/dropView/happy-returns-the-definition-it-removed', detail(dropped));
    }],

    // ---- row mutation ----------------------------------------------------
    ['insertRow', async ({ s, check }) => {
        const inserted = await s.invoke('insertRow', ['people', { id: 10, name: 'delta', r: 4.5 }]);
        const readBack = await s.invoke('runQuery', ['SELECT name FROM people WHERE id = 10']);
        check(body(inserted).success === true
            && Number(body(inserted).data) === 10
            && body(readBack).data?.[0]?.rows?.[0]?.[0] === 'delta',
            'sweep/insertRow/happy', detail(inserted));

        const clash = await s.invoke('insertRow', ['people', { id: 10, name: 'dup' }]);
        const count = await s.invoke('runQuery', ['SELECT count(*) AS c FROM people WHERE id = 10']);
        check(body(clash).success === false
            && /constraint/i.test(String(body(clash).errorMessage ?? ''))
            && body(count).data?.[0]?.rows?.[0]?.[0] === 1,
            'sweep/insertRow/error-primary-key-clash-is-classified-and-inert', detail(clash));
    }],

    ['insertRowWithHistory', async ({ s, check }) => {
        // The route the desktop host actually takes for Add Row: the insert
        // AND its exact post-image ({rowId, row, storageClasses}) in one
        // savepoint, which is what undo deletes by and redo re-inserts by.
        const inserted = await s.invoke('insertRowWithHistory', [
            'people', { id: 11, name: 'epsilon', r: 0.5 }, undefined, 1024 * 1024
        ]);
        const image = body(inserted).data;
        const readBack = await s.invoke('runQuery', ['SELECT name FROM people WHERE id = 11']);
        check(body(inserted).success === true
            && Number(image?.rowId) === 11
            && image?.row?.name === 'epsilon'
            && Array.isArray(image?.storageClasses)
            && image.storageClasses.some((c) => c.column === 'name' && c.storageClass === 'text')
            && body(readBack).data?.[0]?.rows?.[0]?.[0] === 'epsilon',
            'sweep/insertRowWithHistory/happy-returns-the-exact-post-image', detail(inserted));

        // The snapshot budget is enforced BEFORE the insert is released: a
        // row whose image would not fit the undo memory is refused, and the
        // savepoint takes the insert back with it.
        const tooBig = await s.invoke('insertRowWithHistory', [
            'people', { id: 12, name: 'x'.repeat(2048) }, undefined, 64
        ]);
        const count = await s.invoke('runQuery', ['SELECT count(*) AS c FROM people WHERE id = 12']);
        check(body(tooBig).success === false
            && body(count).data?.[0]?.rows?.[0]?.[0] === 0,
            'sweep/insertRowWithHistory/error-over-budget-snapshot-refuses-and-rolls-the-insert-back',
            detail(tooBig));
    }],

    ['updateCell', async ({ s, check }) => {
        const edit = await s.invoke('updateCell', ['people', 10, 'name', 'delta-edited']);
        const readBack = await s.invoke('runQuery', ['SELECT name FROM people WHERE id = 10']);
        check(body(edit).success === true
            && body(readBack).data?.[0]?.rows?.[0]?.[0] === 'delta-edited',
            'sweep/updateCell/happy', detail(edit));

        const ghost = await s.invoke('updateCell', ['people', 987654, 'name', 'ghost']);
        check(failed(ghost, /row 987654 no longer exists/),
            'sweep/updateCell/error-absent-row-is-named-not-silently-ignored', detail(ghost));
    }],

    ['updateCellBatch', async ({ s, check, state }) => {
        const batch = await s.invoke('updateCellBatch', ['people', [
            { rowId: 1, column: 'name', value: 'alpha-2' },
            { rowId: 2, column: 'name', value: 'beta-2' }
        ]]);
        const readBack = await s.invoke('runQuery', ['SELECT name FROM people WHERE id IN (1,2) ORDER BY id']);
        const outcomes = body(batch).data ?? [];
        // Kept for the history-replay entries below: the states are what make
        // an entry replayable.
        state.history = outcomes;
        check(body(batch).success === true
            && outcomes.length === 2
            && outcomes[0]?.priorValue === 'alpha'
            && outcomes[0]?.priorState?.storageClass === 'text'
            && outcomes[0]?.postState?.value === 'alpha-2'
            && JSON.stringify(body(readBack).data?.[0]?.rows?.map((r) => r[0]))
                === JSON.stringify(['alpha-2', 'beta-2']),
            'sweep/updateCellBatch/happy-reports-prior-and-post-states', detail(batch));

        // The batch is one savepoint: a single bad member must take the whole
        // batch down, or a partial write silently diverges from the history
        // entry the host recorded for it.
        const partial = await s.invoke('updateCellBatch', ['people', [
            { rowId: 1, column: 'name', value: 'alpha-3' },
            { rowId: 987654, column: 'name', value: 'ghost' }
        ]]);
        const afterFail = await s.invoke('runQuery', ['SELECT name FROM people WHERE id = 1']);
        check(body(partial).success === false
            && body(afterFail).data?.[0]?.rows?.[0]?.[0] === 'alpha-2',
            'sweep/updateCellBatch/error-one-absent-row-rolls-the-whole-batch-back',
            detail(partial));
    }],

    ['replaceOversizedCell', async ({ s, check }) => {
        const expected = { storageClass: 'text', byteLength: OVERSIZE_TEXT.length };
        const replaced = await s.invoke('replaceOversizedCell', [
            'oversize', 1, 'texty', 'small', expected, TINY_EDIT_LIMIT
        ]);
        const readBack = await s.invoke('runQuery', ['SELECT texty FROM oversize WHERE id = 1']);
        check(body(replaced).success === true
            && body(readBack).data?.[0]?.rows?.[0]?.[0] === 'small',
            'sweep/replaceOversizedCell/happy-guarded-replacement-applies', detail(replaced));

        // The guard is the whole point: the confirmation the user saw quoted a
        // size, and the write must not land if the cell changed since.
        const stale = await s.invoke('replaceOversizedCell', [
            'oversize', 1, 'texty', 'smaller', expected, TINY_EDIT_LIMIT
        ]);
        const unchanged = await s.invoke('runQuery', ['SELECT texty FROM oversize WHERE id = 1']);
        check(failed(stale, /Oversized cell metadata changed/)
            && body(unchanged).data?.[0]?.rows?.[0]?.[0] === 'small',
            'sweep/replaceOversizedCell/error-stale-metadata-refused-and-value-untouched',
            detail(stale));
    }],

    ['deleteRows', async ({ s, check }) => {
        const deleted = await s.invoke('deleteRows', ['people', [10]]);
        const count = await s.invoke('runQuery', ['SELECT count(*) AS c FROM people WHERE id = 10']);
        const snapshot = body(deleted).data?.[0];
        check(body(deleted).success === true
            && Number(snapshot?.rowId) === 10
            && snapshot?.row?.name === 'delta-edited'
            && body(count).data?.[0]?.rows?.[0]?.[0] === 0,
            'sweep/deleteRows/happy-returns-the-restorable-snapshot', detail(deleted));

        // A partially-matching id list must delete NOTHING — the snapshot the
        // undo stack gets has to describe exactly what left the table.
        const ghost = await s.invoke('deleteRows', ['people', [1, 987654]]);
        const survivors = await s.invoke('runQuery', ['SELECT count(*) AS c FROM people WHERE id = 1']);
        check(failed(ghost, /one or more row identities no longer exist/)
            && body(survivors).data?.[0]?.rows?.[0]?.[0] === 1,
            'sweep/deleteRows/error-absent-id-aborts-the-whole-delete', detail(ghost));
    }],

    // ---- history replay --------------------------------------------------
    // The replay is an exact-state compare-and-swap: the entry has to carry
    // the prior/post states the worker captured, which is what the desktop
    // host records from updateCellBatch's own answer. `state.history` is the
    // record of the batch above (alpha → alpha-2 on row 1), and both replays
    // are refused without those states — LegacyCellHistoryError, pinned below.
    ['undoModification', async ({ s, check, state }) => {
        const outcome = state.history?.[0];
        const entry = outcome && {
            modificationType: 'cell_update',
            targetTable: 'people',
            affectedCells: [{
                rowId: outcome.rowId,
                newRowId: outcome.newRowId ?? outcome.rowId,
                columnName: outcome.columnName,
                priorValue: outcome.priorValue,
                newValue: outcome.newValue,
                priorState: outcome.priorState,
                postState: outcome.postState,
                operation: outcome.operation
            }]
        };
        state.cellEntry = entry;
        const undo = await s.invoke('undoModification', [entry ?? {}]);
        const readBack = await s.invoke('runQuery', ['SELECT name FROM people WHERE id = 1']);
        check(!!entry
            && body(undo).success === true
            && body(readBack).data?.[0]?.rows?.[0]?.[0] === 'alpha',
            'sweep/undoModification/happy-restores-the-prior-value', detail(undo));

        // An entry without the captured states cannot be replayed safely, and
        // must say so rather than guess at what the cell held.
        const legacy = await s.invoke('undoModification', [{
            modificationType: 'cell_update',
            targetTable: 'people',
            targetRowId: 1,
            targetColumn: 'name',
            priorValue: 'alpha',
            newValue: 'alpha-2',
            operation: 'set'
        }]);
        check(failed(legacy, /predates guarded cell history/),
            'sweep/undoModification/error-stateless-entry-is-refused-not-guessed', detail(legacy));

        // A barrier type reaching the replay engine is a contract breach, and
        // has to say so rather than no-op into a silently divergent history.
        const barrier = await s.invoke('undoModification', [{
            modificationType: 'column_drop', targetTable: 'people'
        }]);
        check(failed(barrier, /column_drop cannot be undone/),
            'sweep/undoModification/error-barrier-type-is-refused-loudly', detail(barrier));
    }],

    ['redoModification', async ({ s, check, state }) => {
        const redo = await s.invoke('redoModification', [state.cellEntry ?? {}]);
        const readBack = await s.invoke('runQuery', ['SELECT name FROM people WHERE id = 1']);
        check(!!state.cellEntry
            && body(redo).success === true
            && body(readBack).data?.[0]?.rows?.[0]?.[0] === 'alpha-2',
            'sweep/redoModification/happy-re-applies-the-new-value', detail(redo));

        const barrier = await s.invoke('redoModification', [{
            modificationType: 'column_drop', targetTable: 'people'
        }]);
        check(failed(barrier, /column_drop cannot be redone/),
            'sweep/redoModification/error-barrier-type-is-refused-loudly', detail(barrier));
    }],

    // ---- bounded cell reads ---------------------------------------------
    ['getCellMetadata', async ({ s, check }) => {
        const meta = await s.invoke('getCellMetadata', [
            { table: 'people', rowId: 1, column: 'payload' }
        ]);
        check(body(meta).success === true
            && body(meta).data?.storageClass === 'blob'
            && body(meta).data?.byteLength === FIXTURE_BLOB.length,
            'sweep/getCellMetadata/happy-exact-storage-class-and-size', detail(meta));

        // The TEXT branch additionally reads `PRAGMA encoding` through the
        // shim — the same value-returning-PRAGMA path that answered ZERO ROWS
        // before the E-2 fix, which would have made every text cell's encoding
        // undecidable. Byte length, not character count.
        const text = await s.invoke('getCellMetadata', [
            { table: 'oversize', rowId: 2, column: 'texty' }
        ]);
        check(body(text).success === true
            && body(text).data?.storageClass === 'text'
            && body(text).data?.byteLength === MULTIBYTE_TEXT_BYTES
            && body(text).data?.textEncoding === 'utf-8',
            'sweep/getCellMetadata/happy-text-carries-its-encoding-and-BYTE-length', detail(text));

        const ghost = await s.invoke('getCellMetadata', [
            { table: 'people', rowId: 987654, column: 'payload' }
        ]);
        check(failed(ghost, /no longer exists/),
            'sweep/getCellMetadata/error-absent-row-is-named', detail(ghost));

        const bad = await s.invoke('getCellMetadata', [{ table: 'people', rowId: 1, column: '' }]);
        check(failed(bad, /Cell read column must be a non-empty string/),
            'sweep/getCellMetadata/error-malformed-target-is-refused', detail(bad));
    }],

    ['openCellReadSession', async ({ s, check, state }) => {
        const opened = await s.invoke('openCellReadSession', [
            { table: 'people', rowId: 1, column: 'payload' }
        ]);
        state.sessionId = body(opened).data?.sessionId;
        check(body(opened).success === true
            && typeof state.sessionId === 'string'
            && body(opened).data?.metadata?.byteLength === FIXTURE_BLOB.length,
            'sweep/openCellReadSession/happy', detail(opened));

        // A second open is refused by the DISPATCH guard
        // (assertCellReadSessionAllowsMethod), which runs before the handler —
        // so the method body's own "At most one web cell read session may be
        // open" is unreachable over RPC. Asserting the dispatch wording is
        // asserting what a caller can actually observe.
        const second = await s.invoke('openCellReadSession', [
            { table: 'people', rowId: 2, column: 'payload' }
        ]);
        check(failed(second, /cell read snapshot is active/),
            'sweep/openCellReadSession/error-a-second-session-is-refused', detail(second));

        // The snapshot guard: while a session holds a savepoint, no other
        // database operation may run. This is what keeps the chunks coherent.
        const blocked = await s.invoke('runQuery', ['SELECT 1']);
        check(failed(blocked, /cell read snapshot is active/),
            'sweep/openCellReadSession/error-other-methods-are-refused-while-open',
            detail(blocked));
    }],

    ['readCellChunk', async ({ s, check, state }) => {
        const first = await s.invoke('readCellChunk', [state.sessionId, 0, 3]);
        const rest = await s.invoke('readCellChunk', [state.sessionId, 3, 3]);
        const assembled = [...(body(first).data?.bytes ?? []), ...(body(rest).data?.bytes ?? [])];
        check(body(first).success === true
            && body(first).data?.done === false
            && body(rest).data?.done === true
            && equalBytes(assembled, FIXTURE_BLOB),
            'sweep/readCellChunk/happy-chunks-reassemble-byte-exact',
            `${detail(first)} ${detail(rest)}`);

        const unknown = await s.invoke('readCellChunk', ['not-a-session', 0, 3]);
        check(failed(unknown, /Unknown cell read session/),
            'sweep/readCellChunk/error-unknown-session-is-named', detail(unknown));

        const badWindow = await s.invoke('readCellChunk', [state.sessionId, -1, 3]);
        check(failed(badWindow, /byte offset must be a non-negative safe integer/),
            'sweep/readCellChunk/error-negative-offset-is-refused', detail(badWindow));
    }],

    ['closeCellReadSession', async ({ s, check, state }) => {
        const closed = await s.invoke('closeCellReadSession', [state.sessionId]);
        const unblocked = await s.invoke('runQuery', ['SELECT 1 AS ok']);
        check(body(closed).success === true
            && body(unblocked).success === true,
            'sweep/closeCellReadSession/happy-releases-the-snapshot', detail(closed));

        const empty = await s.invoke('closeCellReadSession', ['']);
        check(failed(empty, /Cell read session id is required/),
            'sweep/closeCellReadSession/error-empty-id-is-refused', detail(empty));

        // Closing the SAME id again is tolerated (the worker remembers closed
        // ids) — the inspector's teardown is allowed to be over-eager. An
        // id that was never open still errors.
        const again = await s.invoke('closeCellReadSession', [state.sessionId]);
        const never = await s.invoke('closeCellReadSession', ['never-opened']);
        check(body(again).success === true && failed(never, /Unknown cell read session/),
            'sweep/closeCellReadSession/error-idempotent-for-known-ids-only',
            `${detail(again)} ${detail(never)}`);
    }],

    // ---- export ----------------------------------------------------------
    ['exportDatabase', async ({ s, check, scratch }) => {
        const exported = await s.invoke('exportDatabase', []);
        const bytes = body(exported).data;
        let reopened = null;
        if (bytes instanceof Uint8Array) {
            const copy = path.join(scratch, 'sweep-export.sqlite');
            fs.writeFileSync(copy, bytes);
            const image = new DatabaseSync(copy, { readOnly: true });
            reopened = image.prepare('SELECT count(*) AS c FROM people').get().c;
            image.close();
        }
        const live = await s.invoke('runQuery', ['SELECT count(*) AS c FROM people']);
        const expectedRows = body(live).data?.[0]?.rows?.[0]?.[0];
        check(body(exported).success === true
            && bytes instanceof Uint8Array
            && String.fromCharCode(...bytes.subarray(0, 15)) === 'SQLite format 3'
            && Number.isInteger(expectedRows)
            && reopened === expectedRows,
            'sweep/exportDatabase/happy-image-reopens',
            `bytes=${bytes?.length} rows=${reopened} expected=${expectedRows}`);
        check(true, 'sweep/exportDatabase/error-deferred-to-dead-session-phase');
    }],

    ['exportTable', async ({ s, check }) => {
        const csv = await s.invoke('exportTable', [
            { table: 'people' }, ['id', 'name'], null, null, { format: 'csv', header: true }
        ]);
        const text = (body(csv).data?.contentChunks ?? []).join('');
        check(body(csv).success === true
            && text.split('\n')[0] === 'id,name'
            && text.includes('alpha'),
            'sweep/exportTable/happy-csv', JSON.stringify(text.slice(0, 60)));

        const badFormat = await s.invoke('exportTable', [
            { table: 'people' }, [], null, null, { format: 'xml' }
        ]);
        check(failed(badFormat, /Unsupported export format: xml/),
            'sweep/exportTable/error-unknown-format-is-named', detail(badFormat));

        const noTable = await s.invoke('exportTable', [{}, [], null, null, { format: 'csv' }]);
        check(failed(noTable, /No table specified/),
            'sweep/exportTable/error-missing-table-is-refused', detail(noTable));
    }]
];

/**
 * The methods whose failure path is "the connection is gone". Driven together
 * at the end, because the only way to reach that state through the real
 * sidecar is a refused re-init — which is destructive by design (the worker
 * closes `db` before the engine factory can refuse).
 *
 * The point of the phase is the project's signature bug class: a method that
 * answers `[]`, `{}` or `0` instead of failing when its database is gone reads
 * to the UI as "this database is empty".
 */
const DEAD_SESSION_METHODS = [
    ['fetchSchema', [], /No database initialized/],
    ['getPragmas', [], /No database initialized/],
    ['exportDatabase', [], /No database initialized/],
    ['runQuery', ['SELECT 1'], /No database initialized/],
    ['fetchTableCount', ['people'], /No database initialized/],
    ['getCellMetadata', [{ table: 'people', rowId: 1, column: 'payload' }], /No database initialized/]
];

/** Extract the shipped dispatch table from the COMMITTED sidecar bundle. */
function shippedMethods() {
    const bundle = fs.readFileSync(BUNDLE_PATH, 'utf8');
    // Same shape the app repo's sync-viewer drift pin keys on: minification
    // preserves the table's property names, and `initializeDatabase` appears
    // in exactly one brace-free object literal.
    const table = bundle.match(/\{initializeDatabase:[^{}]*\}/);
    if (!table) return null;
    return table[0].slice(1, -1).split(',').map((pair) => pair.split(':')[0].trim());
}

/**
 * @param {{binary: string, scratch: string, note: (ok: boolean, label: string, detail?: string) => void}} context
 * @returns {Promise<number>} number of checks run
 */
export async function runMethodSweep({ binary, scratch, note }) {
    let checks = 0;
    const check = (ok, label, detail) => { note(ok, label, detail); checks += 1; };

    // ---- completeness gate, before anything is driven --------------------
    const shipped = shippedMethods();
    const swept = SWEEP.map(([name]) => name);
    const missing = (shipped ?? []).filter((name) => !swept.includes(name));
    const stale = swept.filter((name) => !(shipped ?? []).includes(name));
    check(shipped !== null && missing.length === 0 && stale.length === 0,
        'sweep/covers-every-shipped-method',
        shipped === null
            ? 'cannot find the dispatch table in desktop/native-worker-desktop.js'
            : `shipped=${shipped.length} swept=${swept.length}`
            + (missing.length ? ` NOT SWEPT: [${missing.join(', ')}]` : '')
            + (stale.length ? ` SWEPT BUT NOT SHIPPED: [${stale.join(', ')}]` : ''));

    const dbPath = path.join(scratch, 'method-sweep.sqlite');
    createSweepFixture(dbPath);

    const s = startSidecar(binary, dbPath, 'rw');
    const state = {};
    try {
        for (const [name, run] of SWEEP) {
            try {
                await run({ s, check, scratch, dbPath, state });
            } catch (error) {
                // A lane-side throw (timeout, dead sidecar) must be reported as
                // this method's failure, not swallowed into a shorter run.
                check(false, `sweep/${name}/LANE-ERROR`, String(error?.message ?? error));
            }
        }

        // ---- dead-session phase ------------------------------------------
        // A refused re-init leaves the worker with `db === null`.
        const elsewhere = path.join(scratch, 'sweep-not-the-bound-db.sqlite');
        const refused = await s.invoke('initializeDatabase', ['x', {
            path: elsewhere, readOnlyMode: false
        }]);
        check(failed(refused, /bound to at spawn/) && !fs.existsSync(elsewhere),
            'sweep/initializeDatabase/error-unbound-path-refused-without-creating-it',
            detail(refused));

        const alive = await s.invoke('ping', []);
        check(body(alive).success === true && body(alive).data === false,
            'sweep/ping/error-answers-false-once-the-database-is-gone', detail(alive));

        for (const [method, payload, pattern] of DEAD_SESSION_METHODS) {
            const reply = await s.invoke(method, payload);
            check(failed(reply, pattern),
                `sweep/${method}/error-dead-session-rejects-instead-of-answering-empty`,
                detail(reply));
        }

        s.endStdin();
        const code = await s.untilExit();
        check(code === 0, 'sweep/session-exits-clean', `exit ${code}`);
    } finally {
        if (s.exitCode === null) s.child.kill('SIGKILL');
        const stderrText = s.stderr.trim();
        // Worker-side console.error noise is EXPECTED here: every entry drives
        // a failure path on purpose. Keep it visible, never fail on it.
        if (stderrText) {
            console.log(`[method sweep stderr: ${stderrText.split('\n').length} lines of expected method errors]`);
        }
    }
    return checks;
}
