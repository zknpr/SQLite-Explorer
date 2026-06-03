# json_patch Cell Undo (read-modify-write) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Repo override:** per the project's Codex delegation policy, the implementer role is Codex; this plan is the scoped brief. Verify diff + tests before opening the PR.

**Goal:** Make undo of a JSON cell edit restore only the keys the edit touched, preserving concurrent changes to other keys of the same cell, with no data loss across the edge cases that sank PR #426.

**Architecture:** A pure decision helper (`computeJsonPatchUndo`) reads the cell's *current* value, the recorded forward merge-patch (`newValue`), and the recorded full prior (`priorValue`), and returns either a full restored object to write (`SET col = ?`) or a `replace` signal (value-replace to `priorValue`). Both engines (WASM `WasmDatabaseEngine`, native `nativeWorker`) read-then-write through it. All JSON reasoning happens in JS — no `json_patch()` SQL on the undo path — which eliminates RFC 7396 `null`=delete ambiguity and `json_patch()`'s silent-wrong behavior on non-object inputs.

**Tech Stack:** TypeScript, `node:test` + `node:assert`, `tsx` test runner, esbuild. SQLite via sql.js (WASM) and txiki-js (native).

**Spec:** `docs/superpowers/specs/2026-06-03-json-patch-undo-rmw-design.md` (§4 acceptance table is the binding contract).

**Base branch:** `fix/json-patch-undo-rmw` (off `main`). **No** `package.json`/`CHANGELOG.md` change in this PR — the 1.5.1 bump ships with Part 2 (issue #425's other half).

**Test commands:**
- Single file: `npx tsx --tsconfig tsconfig.test.json --test tests/unit/<file>.test.ts`
- Full suite: `npm test`
- Type-check: `npx tsc --noEmit`
- Build: `node scripts/build.mjs`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/core/json-utils.ts` | Pure RFC-7396 merge-patch + the new undo decision helper | Add `JsonUndoPlan`, `computeJsonPatchUndo`, `restoreInto`, `parseJsonObject`; tighten `isObject` to exclude arrays |
| `src/core/engine/wasm/WasmDatabaseEngine.ts` | WASM cell undo wiring | Rewrite `undoCellUpdate` to read→compute→write (single + batch-with-savepoint) |
| `src/nativeWorker.ts` | Native cell undo wiring | Rewrite `undoModification` `cell_update` branch to read→compute→write (single `run` + batch `execBatch`) |
| `tests/unit/json_utils.test.ts` | Pure helper coverage (exhaustive) | Add `computeJsonPatchUndo` scenarios + invariants |
| `tests/unit/sqlite_db.test.ts` | WASM end-to-end undo coverage | Add real-engine undo scenarios (wiring, fallback, batch atomicity) |
| `tests/unit/nativeWorker.test.ts` | Native undo SQL-shape coverage | Add read-then-write SQL-shape + batch-atomicity scenarios |

**Test design (avoid redundancy):** the pure helper gets exhaustive scenario coverage in `json_utils.test.ts`. The engine tests do **not** re-test every algorithm branch — they verify the *wiring* (current value is read; restore writes a full-object `SET`; non-object-current and non-`json_patch` route to value-replace; batch undo is atomic) with a representative subset.

---

## Task 1: Pure undo decision helper (`json-utils.ts`)

**Files:**
- Modify: `src/core/json-utils.ts`
- Test: `tests/unit/json_utils.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/json_utils.test.ts` (the file already imports `generateMergePatch, applyMergePatch` — extend the import to include `computeJsonPatchUndo`):

```ts
// add computeJsonPatchUndo to the existing top-of-file import from '../../src/core/json-utils'
import { generateMergePatch, applyMergePatch, computeJsonPatchUndo } from '../../src/core/json-utils';

describe('computeJsonPatchUndo (RMW undo decision)', () => {
    const j = (v: unknown) => JSON.stringify(v);
    const expectRestore = (plan: ReturnType<typeof computeJsonPatchUndo>, expected: unknown) => {
        assert.strictEqual(plan.kind, 'restore');
        assert.deepStrictEqual(JSON.parse((plan as { kind: 'restore'; value: string }).value), expected);
    };
    const expectReplace = (plan: ReturnType<typeof computeJsonPatchUndo>) =>
        assert.strictEqual(plan.kind, 'replace');

    it('s1: restores the edited key and preserves a concurrent sibling key', () => {
        expectRestore(
            computeJsonPatchUndo(
                j({ status: 'published', owner: 'ada', reviewer: 'grace' }), // current (forward + concurrent)
                j({ status: 'published' }),                                   // forward patch (newValue)
                j({ status: 'draft', owner: 'ada' })                          // prior
            ),
            { status: 'draft', owner: 'ada', reviewer: 'grace' }
        );
    });

    it('s2: removes a wholly-added object key (empty-object collapse)', () => {
        expectRestore(
            computeJsonPatchUndo(j({ meta: { reviewed: true } }), j({ meta: { reviewed: true } }), j({})),
            {}
        );
    });

    it('s3: removes only the added nested leaf, keeping a concurrent nested sibling', () => {
        expectRestore(
            computeJsonPatchUndo(j({ meta: { reviewed: true, note: 'keep' } }), j({ meta: { reviewed: true } }), j({})),
            { meta: { note: 'keep' } }
        );
    });

    it('s4: restores an explicit null at the edited key (preserving a sibling)', () => {
        expectRestore(
            computeJsonPatchUndo(j({ a: 2, b: 1 }), j({ a: 2 }), j({ a: null, b: 1 })),
            { a: null, b: 1 }
        );
    });

    it('s5: restores a nested explicit null in a restored subtree', () => {
        expectRestore(
            computeJsonPatchUndo(j({ meta: { a: 2, keep: 1 } }), j({ meta: { a: 2 } }), j({ meta: { a: null, keep: 1 } })),
            { meta: { a: null, keep: 1 } }
        );
    });

    it('s6: value-replaces when the current cell is not a JSON object', () => {
        for (const current of ['plain text', null, '5', '[1,2]']) {
            expectReplace(computeJsonPatchUndo(current, j({ status: 'published' }), j({ status: 'draft' })));
        }
    });

    it('s7: value-replaces when the forward patch was a scalar/array whole-doc replacement', () => {
        expectReplace(computeJsonPatchUndo(j({ a: 1 }), '5', j({ a: 1 })));
        expectReplace(computeJsonPatchUndo(j({ a: 1 }), '[1,2]', j({ a: 1 })));
    });

    it('s8: value-replaces when the prior cell was SQL NULL / non-object', () => {
        expectReplace(computeJsonPatchUndo(j({ added: true }), j({ added: true }), null));
        expectReplace(computeJsonPatchUndo(j({ added: true }), j({ added: true }), '5'));
    });

    it('invariant: round-trips an object edit (no concurrent change) back to prior', () => {
        const prior = { status: 'draft', meta: { reviewed: false, owner: 'ada' } };
        const forward = generateMergePatch(prior, { status: 'published', meta: { reviewed: true, owner: 'ada' } });
        const current = applyMergePatch(prior, forward);
        expectRestore(computeJsonPatchUndo(j(current), j(forward), j(prior)), prior);
    });

    it('invariant: never touches keys outside the forward patch structure', () => {
        expectRestore(
            computeJsonPatchUndo(
                j({ a: 'forward-changed', untouched: { deep: 1 }, sibling: 2 }),
                j({ a: 'forward-changed' }),
                j({ a: 'orig' })
            ),
            { a: 'orig', untouched: { deep: 1 }, sibling: 2 }
        );
    });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx tsx --tsconfig tsconfig.test.json --test tests/unit/json_utils.test.ts`
Expected: FAIL — `computeJsonPatchUndo` is not exported (compile/import error).

- [ ] **Step 3: Implement the helper**

In `src/core/json-utils.ts`: (a) tighten `isObject` to exclude arrays; (b) add the types + helper below (place after `applyMergePatch`). Reuse the existing `MAX_DEPTH` constant.

```ts
// Tighten the existing isObject (RFC 7396: arrays are atomic values, not merge targets):
function isObject(val: unknown): val is Record<string, unknown> {
    return val !== null && typeof val === 'object' && !Array.isArray(val);
}

export type JsonUndoPlan =
    | { kind: 'restore'; value: string }   // write JSON.stringify(restored) via SET col = ?
    | { kind: 'replace' };                 // value-replace: SET col = recorded priorValue

/** Parse a raw cell value to a plain JSON object, or undefined if it is not one. */
function parseJsonObject(raw: unknown): Record<string, unknown> | undefined {
    if (typeof raw !== 'string') return undefined;
    try {
        const parsed = JSON.parse(raw);
        return isObject(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Decide how to undo a forward json_patch cell edit by read-modify-write.
 *
 * Surgical restore requires current, forwardPatch, and prior to all be JSON
 * objects; otherwise we value-replace to the recorded prior. (Accepted
 * limitation: when prior is SQL NULL / scalar / array we value-replace, which
 * can clobber a concurrent sibling added to such a cell — an extreme corner that
 * matches pre-RMW behavior.)
 *
 * @param currentRaw      the cell value read from the DB *now*
 * @param forwardPatchRaw the recorded forward merge patch (ModificationEntry.newValue)
 * @param priorRaw        the recorded full prior cell value (ModificationEntry.priorValue)
 */
export function computeJsonPatchUndo(
    currentRaw: unknown,
    forwardPatchRaw: unknown,
    priorRaw: unknown
): JsonUndoPlan {
    const current = parseJsonObject(currentRaw);
    const forwardPatch = parseJsonObject(forwardPatchRaw);
    const prior = parseJsonObject(priorRaw);
    if (!current || !forwardPatch || !prior) {
        return { kind: 'replace' };
    }
    return { kind: 'restore', value: JSON.stringify(restoreInto(current, forwardPatch, prior, 0)) };
}

/**
 * Walk only the forward patch's key structure, restoring each touched key from
 * `prior` into a clone of `current`; keys absent from the patch are untouched.
 */
function restoreInto(
    currentObj: Record<string, unknown>,
    patchObj: Record<string, unknown>,
    priorObj: Record<string, unknown>,
    depth: number
): Record<string, unknown> {
    if (depth > MAX_DEPTH) {
        throw new Error('JSON undo restore depth limit exceeded');
    }
    const result: Record<string, unknown> = { ...currentObj };
    for (const key of Object.keys(patchObj)) {
        const pv = patchObj[key];
        const priorHas = Object.prototype.hasOwnProperty.call(priorObj, key);
        const priorVal = priorHas ? priorObj[key] : undefined;

        if (isObject(pv)) {
            if (priorHas && isObject(priorVal)) {
                // Forward patched a nested object that was also an object in prior — recurse.
                const base = isObject(result[key]) ? (result[key] as Record<string, unknown>) : {};
                result[key] = restoreInto(base, pv, priorVal, depth + 1);
            } else if (priorHas) {
                // Prior was a scalar / array / explicit null — restore it wholesale.
                result[key] = priorVal;
            } else {
                // Forward ADDED this object key — strip the leaves it added, keep concurrent siblings.
                const base = isObject(result[key]) ? (result[key] as Record<string, unknown>) : {};
                const child = restoreInto(base, pv, {}, depth + 1);
                if (Object.keys(child).length === 0) {
                    delete result[key]; // wholly-added object, nothing concurrent survived -> drop it
                } else {
                    result[key] = child;
                }
            }
        } else if (priorHas) {
            // Forward set a scalar/array/null at an existing key — restore exact prior (incl. explicit null).
            result[key] = priorVal;
        } else {
            // Forward added this scalar key — remove it.
            delete result[key];
        }
    }
    return result;
}
```

- [ ] **Step 4: Run the tests (new + existing), verify all pass**

Run: `npx tsx --tsconfig tsconfig.test.json --test tests/unit/json_utils.test.ts`
Expected: PASS for the new `computeJsonPatchUndo` suite **and** the pre-existing `generateMergePatch`/`applyMergePatch` suites (the `isObject` array change must not regress them — arrays were already meant to be atomic).

- [ ] **Step 5: Commit**

```bash
git add src/core/json-utils.ts tests/unit/json_utils.test.ts
git commit -m "feat(undo): pure read-modify-write json_patch undo decision helper

computeJsonPatchUndo restores only the forward patch's touched keys from the
recorded prior, preserving concurrent sibling edits; value-replaces when current,
prior, or the forward patch is not a JSON object. isObject now excludes arrays
(RFC 7396 atomic). Pure + exhaustively unit-tested; engine wiring follows.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: WASM engine undo wiring (`WasmDatabaseEngine.undoCellUpdate`)

**Files:**
- Modify: `src/core/engine/wasm/WasmDatabaseEngine.ts:284-298` (the `undoCellUpdate` method) and the import of `json-utils` (add `computeJsonPatchUndo`)
- Test: `tests/unit/sqlite_db.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/sqlite_db.test.ts` inside the `describe('WasmDatabaseEngine', …)` block (harness already provides `engine` and a `users(id,name,age,data TEXT)` table; each test self-cleans with `DELETE FROM users`). Forward json_patch edits are driven with `updateCell(table,row,col,null,patchString)`.

```ts
it('undo single json_patch edit preserves a concurrent sibling key (s1)', async () => {
    await engine.executeQuery('DELETE FROM users');
    const prior = JSON.stringify({ status: 'draft', owner: 'ada' });
    const forward = JSON.stringify({ status: 'published' });
    await engine.insertRow('users', { id: 1, name: 'A', age: 30, data: prior });
    await engine.updateCell('users', 1, 'data', null, forward);                          // tracked edit
    await engine.updateCell('users', 1, 'data', null, JSON.stringify({ reviewer: 'grace' })); // concurrent edit

    await engine.undoModification({
        modificationType: 'cell_update', description: 'u', targetTable: 'users',
        targetRowId: 1, targetColumn: 'data', priorValue: prior, newValue: forward, operation: 'json_patch'
    });

    const r = await engine.executeQuery('SELECT data FROM users WHERE id = 1');
    assert.deepStrictEqual(JSON.parse(r[0].rows[0][0] as string), { status: 'draft', owner: 'ada', reviewer: 'grace' });
});

it('undo of a wholly-added object key removes it entirely (s2)', async () => {
    await engine.executeQuery('DELETE FROM users');
    const forward = JSON.stringify({ meta: { reviewed: true } });
    await engine.insertRow('users', { id: 1, name: 'A', age: 30, data: '{}' });
    await engine.updateCell('users', 1, 'data', null, forward);

    await engine.undoModification({
        modificationType: 'cell_update', description: 'u', targetTable: 'users',
        targetRowId: 1, targetColumn: 'data', priorValue: '{}', newValue: forward, operation: 'json_patch'
    });

    const r = await engine.executeQuery('SELECT data FROM users WHERE id = 1');
    assert.deepStrictEqual(JSON.parse(r[0].rows[0][0] as string), {});
});

it('undo restores an explicit null at the edited key (s4)', async () => {
    await engine.executeQuery('DELETE FROM users');
    const prior = JSON.stringify({ a: null, b: 1 });
    const forward = JSON.stringify({ a: 2 });
    await engine.insertRow('users', { id: 1, name: 'A', age: 30, data: prior });
    await engine.updateCell('users', 1, 'data', null, forward);

    await engine.undoModification({
        modificationType: 'cell_update', description: 'u', targetTable: 'users',
        targetRowId: 1, targetColumn: 'data', priorValue: prior, newValue: forward, operation: 'json_patch'
    });

    const r = await engine.executeQuery('SELECT data FROM users WHERE id = 1');
    const parsed = JSON.parse(r[0].rows[0][0] as string);
    assert.deepStrictEqual(parsed, { a: null, b: 1 });
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'a')); // explicit null kept, not deleted
});

it('undo value-replaces when the cell became non-JSON since the edit (s6)', async () => {
    await engine.executeQuery('DELETE FROM users');
    const prior = JSON.stringify({ status: 'draft', owner: 'ada' });
    const forward = JSON.stringify({ status: 'published' });
    await engine.insertRow('users', { id: 1, name: 'A', age: 30, data: prior });
    await engine.updateCell('users', 1, 'data', null, forward);
    await engine.updateCell('users', 1, 'data', 'plain text'); // current is now non-object

    await engine.undoModification({
        modificationType: 'cell_update', description: 'u', targetTable: 'users',
        targetRowId: 1, targetColumn: 'data', priorValue: prior, newValue: forward, operation: 'json_patch'
    });

    const r = await engine.executeQuery('SELECT data FROM users WHERE id = 1');
    assert.deepStrictEqual(JSON.parse(r[0].rows[0][0] as string), { status: 'draft', owner: 'ada' });
});

it('batch undo restores each json_patch cell, keeps concurrent siblings, and is atomic (s9)', async () => {
    await engine.executeQuery('DELETE FROM users');
    const p1 = JSON.stringify({ count: 1, stable: 'one' });
    const p2 = JSON.stringify({ count: 10, stable: 'two' });
    await engine.insertRow('users', { id: 1, name: 'A', age: 30, data: p1 });
    await engine.insertRow('users', { id: 2, name: 'B', age: 31, data: p2 });
    await engine.updateCellBatch('users', [
        { rowId: 1, column: 'data', value: JSON.stringify({ count: 2 }), operation: 'json_patch' },
        { rowId: 2, column: 'data', value: JSON.stringify({ count: 11 }), operation: 'json_patch' }
    ]);
    await engine.updateCell('users', 1, 'data', null, JSON.stringify({ concurrent: 'one' }));
    await engine.updateCell('users', 2, 'data', null, JSON.stringify({ concurrent: 'two' }));

    await engine.undoModification({
        modificationType: 'cell_update', description: 'u', targetTable: 'users',
        affectedCells: [
            { rowId: 1, columnName: 'data', priorValue: p1, newValue: JSON.stringify({ count: 2 }), operation: 'json_patch' },
            { rowId: 2, columnName: 'data', priorValue: p2, newValue: JSON.stringify({ count: 11 }), operation: 'json_patch' }
        ]
    });

    const r = await engine.executeQuery('SELECT id, data FROM users ORDER BY id');
    assert.deepStrictEqual(JSON.parse(r[0].rows[0][1] as string), { count: 1, stable: 'one', concurrent: 'one' });
    assert.deepStrictEqual(JSON.parse(r[0].rows[1][1] as string), { count: 10, stable: 'two', concurrent: 'two' });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx tsx --tsconfig tsconfig.test.json --test tests/unit/sqlite_db.test.ts`
Expected: FAIL — current `undoCellUpdate` does blind value-replacement, so s1 yields `{status:'draft',owner:'ada'}` (concurrent `reviewer` lost), s2 yields `{meta:{reviewed:true}}` reverted to `{}` only by luck of value-replace… (s1/s4 assertions fail).

- [ ] **Step 3: Rewrite `undoCellUpdate`**

Add `computeJsonPatchUndo` to the `json-utils` import at the top of `WasmDatabaseEngine.ts`. Replace the method body (lines 284-298) with:

```ts
private async undoCellUpdate(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { affectedCells, targetRowId, targetColumn, priorValue, newValue, operation } = mod;

    if (affectedCells) {
        // If any cell is a json_patch undo we must read-modify-write per cell; wrap the
        // whole batch in a SAVEPOINT so a mid-batch failure rolls the row set back atomically.
        if (affectedCells.some(c => c.operation === 'json_patch')) {
            const savepoint = `sp_undo_${Date.now()}`;
            await this.executeQuery(`SAVEPOINT ${savepoint}`);
            try {
                for (const c of affectedCells) {
                    await this.undoOneCell(targetTable, c.rowId, c.columnName, c.priorValue, c.newValue, c.operation);
                }
                await this.executeQuery(`RELEASE SAVEPOINT ${savepoint}`);
            } catch (err) {
                await this.safeRollbackSavepoint(savepoint, 'undoCellUpdate');
                throw err;
            }
        } else {
            // Pure value-replacement batch keeps the existing single-statement-per-cell path.
            await this.updateCellBatch(targetTable, affectedCells.map(c => ({
                rowId: c.rowId, column: c.columnName, value: c.priorValue ?? null
            })));
        }
    } else if (targetRowId !== undefined && targetColumn) {
        await this.undoOneCell(targetTable, targetRowId, targetColumn, priorValue, newValue, operation);
    }
}

/** Undo one cell: read-modify-write for json_patch edits, value-replacement otherwise. */
private async undoOneCell(
    targetTable: string,
    rowId: RecordId,
    column: string,
    priorValue: CellValue | undefined,
    newValue: CellValue | undefined,
    operation: ModificationEntry['operation']
): Promise<void> {
    if (operation === 'json_patch') {
        const current = await this.readCellValue(targetTable, rowId, column);
        const plan = computeJsonPatchUndo(current, newValue, priorValue);
        if (plan.kind === 'restore') {
            await this.updateCell(targetTable, rowId, column, plan.value); // plain SET col = ?
            return;
        }
    }
    await this.updateCell(targetTable, rowId, column, priorValue ?? null);
}

/** Read a single cell's current value (mirrors the SELECT used by the json_patch fallback). */
private async readCellValue(table: string, rowId: RecordId, column: string): Promise<CellValue> {
    const escapedCol = escapeIdentifier(column);
    const escapedTbl = escapeIdentifier(table);
    const res = await this.executeQuery(
        `SELECT ${escapedCol} FROM ${escapedTbl} WHERE rowid = ?`, [validateRowId(rowId)]
    );
    return (res[0]?.rows[0]?.[0] ?? null) as CellValue;
}
```

(Confirm `safeRollbackSavepoint` exists — it is used at `WasmDatabaseEngine.ts:245` by `applyModifications`. Reuse it.)

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx tsx --tsconfig tsconfig.test.json --test tests/unit/sqlite_db.test.ts`
Expected: PASS for all new scenarios and all pre-existing `WasmDatabaseEngine` tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/engine/wasm/WasmDatabaseEngine.ts tests/unit/sqlite_db.test.ts
git commit -m "feat(undo): operation-aware json_patch cell undo in the WASM engine

undoCellUpdate now reads the current cell and routes json_patch undos through
computeJsonPatchUndo (full-object SET), preserving concurrent sibling edits;
non-json_patch and non-object-current cells value-replace. Batch undos that touch
any json_patch cell are wrapped in a SAVEPOINT for atomicity.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Native engine undo wiring (`nativeWorker.undoModification`)

**Files:**
- Modify: `src/nativeWorker.ts` — the `cell_update` branch of `undoModification` (around lines 543-560) and add `computeJsonPatchUndo` to the `json-utils` import
- Test: `tests/unit/nativeWorker.test.ts`

**Native read/write primitives:** read current via `operationsFacade.executeQuery('SELECT <col> FROM <table> WHERE rowid = ?', [rowIdNum])` → `result[0].rows[0][0]` (backed by `worker.call('query', …)`). Write a restored object or value-replace via `operationsFacade.updateCell(table, rowId, column, value)` (value path → `worker.call('run', ['UPDATE … SET col = ? WHERE rowid = ?', [value, rowIdNum]])`). Batch writes go through one `worker.call('execBatch', [items])` for atomicity.

- [ ] **Step 1: Write the failing tests**

The harness in `tests/unit/nativeWorker.test.ts` already supports a per-call responder: `createRecordingConnection(respondToCall?)` where `respondToCall(call) => { result } | { error }`. For RMW, answer `query` (the read) with the current cell, and assert the subsequent `run`/`execBatch` write. Add inside the existing `describe('createNativeDatabaseConnection', …)`:

```ts
it('undoes a single json_patch cell by reading current then writing the restored object', async () => {
    // Respond to the RMW SELECT with the post-forward+concurrent current value; default-respond the write.
    const current = { status: 'published', owner: 'ada', reviewer: 'grace' };
    const connection = await createRecordingConnection((call) => {
        if (call.method === 'query') {
            return { result: { columns: ['payload'], values: [[JSON.stringify(current)]] } };
        }
        return { result: { changes: 1, lastInsertRowId: 1 } };
    });
    try {
        connection.calls.length = 0;
        await connection.databaseOps.undoModification({
            modificationType: 'cell_update', description: 'u', targetTable: 'docs',
            targetRowId: 7, targetColumn: 'payload',
            priorValue: JSON.stringify({ status: 'draft', owner: 'ada' }),
            newValue: JSON.stringify({ status: 'published' }), operation: 'json_patch'
        });

        const queryCall = connection.calls.find(c => c.method === 'query');
        const runCall = connection.calls.find(c => c.method === 'run');
        assert.ok(queryCall, 'expected a SELECT read');
        assert.ok(runCall, 'expected a SET write');
        const [sql, params] = runCall!.args as [string, unknown[]];
        assert.strictEqual(sql, `UPDATE "docs" SET "payload" = ? WHERE rowid = ?`);
        assert.deepStrictEqual(JSON.parse(params[0] as string), { status: 'draft', owner: 'ada', reviewer: 'grace' });
        assert.strictEqual(params[1], 7);
    } finally {
        connection.dispose();
    }
});

it('value-replaces a single json_patch undo when the current cell is non-object', async () => {
    const connection = await createRecordingConnection((call) => {
        if (call.method === 'query') return { result: { columns: ['payload'], values: [['plain text']] } };
        return { result: { changes: 1, lastInsertRowId: 1 } };
    });
    try {
        const prior = JSON.stringify({ status: 'draft' });
        connection.calls.length = 0;
        await connection.databaseOps.undoModification({
            modificationType: 'cell_update', description: 'u', targetTable: 'docs',
            targetRowId: 7, targetColumn: 'payload',
            priorValue: prior, newValue: JSON.stringify({ status: 'published' }), operation: 'json_patch'
        });
        const runCall = connection.calls.find(c => c.method === 'run')!;
        const [sql, params] = runCall.args as [string, unknown[]];
        assert.strictEqual(sql, `UPDATE "docs" SET "payload" = ? WHERE rowid = ?`);
        assert.deepStrictEqual(params, [prior, 7]); // value-replace to recorded prior
    } finally {
        connection.dispose();
    }
});

it('undoes a batch of json_patch cells atomically via execBatch of restored-object writes', async () => {
    const currents: Record<number, unknown> = {
        3: { count: 2, stable: 'one', concurrent: 'a' },
        4: { count: 11, stable: 'two', concurrent: 'b' }
    };
    const connection = await createRecordingConnection((call) => {
        if (call.method === 'query') {
            const [, params] = call.args as [string, unknown[]];
            return { result: { columns: ['payload'], values: [[JSON.stringify(currents[Number(params[0])])]] } };
        }
        return { result: { changes: 1, lastInsertRowId: 1 } };
    });
    try {
        connection.calls.length = 0;
        await connection.databaseOps.undoModification({
            modificationType: 'cell_update', description: 'u', targetTable: 'docs',
            affectedCells: [
                { rowId: 3, columnName: 'payload', priorValue: JSON.stringify({ count: 1, stable: 'one' }), newValue: JSON.stringify({ count: 2 }), operation: 'json_patch' },
                { rowId: 4, columnName: 'payload', priorValue: JSON.stringify({ count: 10, stable: 'two' }), newValue: JSON.stringify({ count: 11 }), operation: 'json_patch' }
            ]
        });

        const batchCall = connection.calls.find(c => c.method === 'execBatch');
        assert.ok(batchCall, 'batch json_patch undo must write through one execBatch (atomic)');
        const items = (batchCall!.args as [Array<{ sql: string; params: unknown[] }>])[0];
        assert.strictEqual(items.length, 2);
        assert.ok(items.every(i => i.sql === `UPDATE "docs" SET "payload" = ? WHERE rowid = ?`));
        assert.deepStrictEqual(JSON.parse(items[0].params[0] as string), { count: 1, stable: 'one', concurrent: 'a' });
        assert.deepStrictEqual(JSON.parse(items[1].params[0] as string), { count: 10, stable: 'two', concurrent: 'b' });
    } finally {
        connection.dispose();
    }
});
```

> **Codex note:** confirm the recording mock's `query` response shape (`{ columns, values }`) matches what `NativeWorkerProcess`/`worker.call<NativeQueryResult>('query', …)` expects in this harness; adjust the mock response wrapper if the harness double-wraps. The assertions on the emitted write SQL/params are the contract and must hold.

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx tsx --tsconfig tsconfig.test.json --test tests/unit/nativeWorker.test.ts`
Expected: FAIL — current native undo emits a blind value-replacement `run`/`execBatch` (no `query` read; batch loses concurrent keys).

- [ ] **Step 3: Rewrite the `cell_update` branch of `undoModification`**

Add `computeJsonPatchUndo` to the `json-utils` import. Replace the `case 'cell_update':` block (lines ~543-560) with read-modify-write. Define a local helper that resolves each cell to a concrete write `{ value }`:

```ts
case 'cell_update': {
    const { newValue, operation } = mod;

    // Resolve one cell to the value to write back (full restored object, or prior for value-replace).
    const resolveUndoValue = async (
        rowId: RecordId, column: string,
        cellPrior: CellValue | undefined, cellNew: CellValue | undefined,
        cellOp: ModificationEntry['operation']
    ): Promise<CellValue> => {
        if (cellOp === 'json_patch') {
            const read = await operationsFacade.executeQuery(
                `SELECT ${escapeIdentifier(column)} FROM ${escapeIdentifier(targetTable)} WHERE rowid = ?`,
                [Number(rowId)]
            );
            const current = (read[0]?.rows[0]?.[0] ?? null) as CellValue;
            const plan = computeJsonPatchUndo(current, cellNew, cellPrior);
            if (plan.kind === 'restore') return plan.value;
        }
        return cellPrior ?? null;
    };

    if (affectedCells) {
        // Read+compute every cell first, then write the whole set in one atomic execBatch.
        const items = [];
        for (const c of affectedCells) {
            const value = await resolveUndoValue(c.rowId, c.columnName, c.priorValue, c.newValue, c.operation);
            items.push({
                sql: `UPDATE ${escapeIdentifier(targetTable)} SET ${escapeIdentifier(c.columnName)} = ? WHERE rowid = ?`,
                params: [value, Number(c.rowId)]
            });
        }
        if (items.length > 0) {
            await worker.call('execBatch', [items]);
        }
    } else if (targetRowId !== undefined && targetColumn) {
        const value = await resolveUndoValue(targetRowId, targetColumn, priorValue, newValue, operation);
        await worker.call('run', [
            `UPDATE ${escapeIdentifier(targetTable)} SET ${escapeIdentifier(targetColumn)} = ? WHERE rowid = ?`,
            [value, Number(targetRowId)]
        ]);
    }
    break;
}
```

(`priorValue`, `affectedCells`, `targetRowId`, `targetColumn` are already destructured at the top of `undoModification`; add `newValue` and `operation` to that destructure. Keep the paired-contract comment noting web and native must interpret `cell_update` fields identically.)

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx tsx --tsconfig tsconfig.test.json --test tests/unit/nativeWorker.test.ts`
Expected: PASS for the new scenarios and all pre-existing native tests.

- [ ] **Step 5: Commit**

```bash
git add src/nativeWorker.ts tests/unit/nativeWorker.test.ts
git commit -m "feat(undo): operation-aware json_patch cell undo in the native engine

undoModification cell_update now reads current then writes the restored object
(or value-replaces) via computeJsonPatchUndo — matching the WASM engine. Batch
json_patch undos write through one execBatch for atomicity.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Full verification (build, types, suite, revert-proof)

**Files:** none (verification only).

- [ ] **Step 1: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Build both targets**

Run: `node scripts/build.mjs`
Expected: completes; `out/extension.js`, `out/extension-browser.js`, `out/worker.js`, `out/worker-browser.js` produced.

- [ ] **Step 3: Full unit suite**

Run: `npm test`
Expected: all tests pass (prior count + the new json_utils/sqlite_db/nativeWorker scenarios).

- [ ] **Step 4: Revert-proof check**

Temporarily revert the three source files (keep the tests) and confirm the new tests fail, then restore:

```bash
git stash push -- src/core/json-utils.ts src/core/engine/wasm/WasmDatabaseEngine.ts src/nativeWorker.ts
npx tsx --tsconfig tsconfig.test.json --test tests/unit/json_utils.test.ts tests/unit/sqlite_db.test.ts tests/unit/nativeWorker.test.ts   # expect failures
git stash pop
npm test   # expect green again
```

(Note: reverting `json-utils.ts` will also remove the export and cause compile-level failures in the engine files — that is acceptable evidence the tests bind to the new code. If the stash makes the type-check too noisy to run the tests, revert only the engine files for the WASM/native suites and only `json-utils.ts`'s helper body for the pure suite.)

- [ ] **Step 5: Manual smoke (optional but recommended)**

Build, F5 Extension Development Host, open a DB with a JSON column. Open a JSON cell in a VS Code tab (VFS), edit a *different* key inline in the grid, undo the inline edit, confirm the tab's key survives.

- [ ] **Step 6: No commit**

Task 4 produces no code changes. Do **not** bump `package.json` or edit `CHANGELOG.md` — the 1.5.1 release ships with Part 2.

---

## Self-Review

**1. Spec coverage:** §4 scenarios 1–9 → Task 1 covers the pure-decision form of 1–8; Task 2 (WASM) covers 1,2,4,6,9 end-to-end; Task 3 (native) covers 1,6,9 at the SQL-shape level. §3.2 atomicity → Task 2 SAVEPOINT, Task 3 single `execBatch`. §3.1 eligibility/`isObject` → Task 1. §5 limitation → comment in `computeJsonPatchUndo`. §6 reuse/rewrite → Task 1 additive on `main`; `isObject` fix in Task 1; plumbing already on `main`. §7 testing → Tasks 1–4. No uncovered spec requirement.

**2. Placeholder scan:** no TBD/TODO; the one "Codex note" in Task 3 is a concrete confirmation instruction (mock response shape) with the binding assertions stated, not a deferred decision.

**3. Type consistency:** `computeJsonPatchUndo(currentRaw, forwardPatchRaw, priorRaw): JsonUndoPlan` used identically in Tasks 1/2/3. `JsonUndoPlan = {kind:'restore';value:string} | {kind:'replace'}`. `restoreInto`/`parseJsonObject` private to `json-utils.ts`. Engine writes use `updateCell(table,row,col,value)` (WASM) and `worker.call('run'/'execBatch', …)` (native) — matching the confirmed signatures.

---

## Notes for the implementer

- `validateRowId` and `escapeIdentifier` are already imported in both engine files — reuse them.
- Do not introduce `json_patch()` SQL anywhere on the undo path; RMW writes full objects or value-replaces.
- Preserve existing behavior for non-`json_patch` cell undos (byte-for-byte) and for all non-cell modification types.
