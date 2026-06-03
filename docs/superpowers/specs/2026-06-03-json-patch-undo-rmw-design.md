# Operation-aware json_patch cell undo (read-modify-write)

- **Issue:** [#425](https://github.com/zknpr/SQLite-Explorer/issues/425) — "Hot-exit does not persist redo/undone state (futureStack) — undo of a saved edit is lost on reopen"
- **Scope of this spec:** the **undo-fidelity** half of #425 only (the issue's second sub-problem). PR **1 of 2**.
- **Supersedes:** closed PR [#426](https://github.com/zknpr/SQLite-Explorer/pull/426) (`fix/json-patch-undo`), which attempted the same fix with an inverse-merge-patch algorithm.
- **Release:** **none in this PR.** This PR ships code + tests only. The 1.5.0 → **1.5.1** bump,
  the CHANGELOG entries (for *both* parts), and the `v1.5.1` tag are done in **Part 2** — the PR that
  fully fixes #425. Rationale: #425 is a single issue with two sub-problems; the 1.5.1 release should
  ship the complete fix, not a half of it.
- **Out of scope (→ PR 2):** futureStack hot-exit persistence (issue's original sub-problem); the
  version bump, CHANGELOG, and release tag.

## 1. Problem

Undo of a JSON cell edit replaces the whole cell with the recorded prior document:

```ts
// src/core/engine/wasm/WasmDatabaseEngine.ts  (undoCellUpdate)
await this.updateCell(targetTable, targetRowId, targetColumn, priorValue ?? null);
// native: nativeWorker.ts undoModification — same full-value replacement
```

If a **different key of the same cell** changed between the tracked edit and the undo, that
concurrent change is clobbered. Real trigger: the cell is open in a VFS editor tab
(`virtualFileSystem.ts`) while it is also edited inline in the grid; undoing the inline edit
reverts the tab's independent change. Single-pane / strictly-sequential undo is already correct;
only interleaved same-cell edits are affected. Severity: P2 (data fidelity, not corruption).

The forward path already records everything an operation-aware undo needs (no history-format
change required):

```ts
// src/hostBridge.ts — single cell (updateCell)
const patch = this.tryGeneratePatch(value, originalValue);  // RFC 7396 merge patch, or undefined
newValue:  patch ?? value,        // for json_patch edits this is the FORWARD PATCH string
operation: patch ? 'json_patch' : 'set',
priorValue: originalValue,        // the FULL prior cell value (string | null)
// batch (updateCellBatch) records the same three fields per affectedCells[] entry
```

## 2. Why #426's inverse-patch approach was abandoned

#426 built an **inverse merge patch** (`invertMergePatch` / `tryCreateInverseMergePatch`) and applied
it with SQLite's `json_patch(COALESCE(col,'{}'), ?)`. That representation is structurally lossy
against RFC 7396, so each review round plugged one leak and exposed another. The PR was **closed
with two unresolved P2 correctness holes** still open from its second review round:

1. **Nested explicit nulls** (`json-utils.ts`): the guard only rejected a top-level `priorVal === null`.
   A restored *object* containing nested explicit nulls is emitted into a merge patch, where
   `null` means *delete* — so those keys vanish on undo.
2. **Non-object current cell** (`WasmDatabaseEngine.ts`): if the cell became SQL `NULL` or a JSON
   scalar/array between edit and undo, `json_patch()` does **not** throw — it silently merges with
   wrong semantics — so the `try/catch` fallback never fires.

Both are inherent to expressing the undo as a merge patch (`null` = delete) and delegating the merge
to `json_patch()` (permissive on non-object inputs). They are not fixable without abandoning the
representation.

## 3. Approach: read-modify-write, entirely in JS

Instead of emitting a patch and letting SQLite merge it, **read the current cell value into JS,
compute the exact restored object, and write the whole object back.** This sidesteps both failure
modes above: explicit nulls are ordinary JS values (no `null`=delete ambiguity), and "is the current
cell an object?" is a deterministic JS check (no reliance on `json_patch()` throwing).

### 3.1 Pure decision helper (`src/core/json-utils.ts`)

A single pure function replaces `invertMergePatch` / `tryCreateInverseMergePatch`:

```ts
type JsonUndoPlan =
  | { kind: 'restore'; value: string }   // write JSON.stringify(restoredObject) via SET col = ?
  | { kind: 'replace' };                 // value-replace: SET col = priorValue (recorded)

// currentRaw = value read from the DB *now*; forwardPatchRaw = recorded newValue;
// priorRaw = recorded priorValue. All are raw cell values (string | null | …).
function computeJsonPatchUndo(
  currentRaw: CellValue,
  forwardPatchRaw: CellValue,
  priorRaw: CellValue
): JsonUndoPlan;
```

**Eligibility for surgical restore** — all three must hold, else `{ kind: 'replace' }`:

- `current` parses to a JSON **object**, and
- `prior` parses to a JSON **object**, and
- `forwardPatch` parses to a JSON **object**.

(A non-object `forwardPatch` means the forward edit replaced the whole document — scenario 7. A
non-object `current` means we cannot surgically restore into it — scenario 6. A non-object/NULL
`prior` means value-replace restores it exactly — scenario 8. See §5 limitation.)

**Restore walk** (reference; the §4 acceptance table is the binding contract). Clone `current`; walk
**only the forward patch's key structure**, drawing restoration values from `prior`:

```
restoreInto(currentObj, patchObj, priorObj, depth):
  if depth > MAX_DEPTH: throw
  result = { ...currentObj }
  for key in Object.keys(patchObj):
    pv = patchObj[key]; priorHas = hasOwn(priorObj, key); priorVal = priorObj[key]
    if isObject(pv):                                  # forward patched a nested object
      if priorHas and isObject(priorVal):
        result[key] = restoreInto(asObject(result[key]) ?? {}, pv, priorVal, depth+1)
      else if priorHas:                              # prior was scalar/array/null → restore wholesale
        result[key] = priorVal                       # exact, incl. explicit null
      else:                                          # forward ADDED this object key
        child = restoreInto(asObject(result[key]) ?? {}, pv, {}, depth+1)
        if isEmptyObject(child): delete result[key]  # collapse a wholly-added object
        else: result[key] = child                    # keep concurrent nested siblings
    else:                                            # forward set key to scalar/array/null
      if priorHas: result[key] = priorVal            # restore exact prior, incl. explicit null
      else: delete result[key]                       # forward added it → remove
  return result
```

`isObject(x)` ≡ non-null, `typeof === 'object'`, **not** an array (RFC 7396: arrays are atomic).
Reuse #426's `isObject` arrays-are-atomic correction.

### 3.2 Engine wiring (`WasmDatabaseEngine.undoCellUpdate`, `nativeWorker.undoModification`)

Per cell with `operation === 'json_patch'`:

1. **Read** the current value of `(table, rowId, column)` via the engine's existing query path.
2. `plan = computeJsonPatchUndo(current, cell.newValue, cell.priorValue)`.
3. `plan.kind === 'restore'` → write `plan.value` with a plain `SET col = ?` (the existing
   `updateCell(table, row, col, value)` value path — **not** the `patch` argument).
   `plan.kind === 'replace'` → `updateCell(table, row, col, cell.priorValue ?? null)`.

Cells with `operation !== 'json_patch'` keep today's value-replacement undo unchanged.

**Atomicity (batch).** When any cell in a batch undo is `json_patch`, the per-cell read+write
sequence for the whole batch runs inside **one `SAVEPOINT`** (release on success, rollback-to on
error) so a mid-batch failure does not leave a partially-undone row. (This was #426's open atomicity
P2.) Reuse the existing `safeRollback` pattern; do not let a rollback error mask the original.

**No per-engine duplication.** The decision logic lives once in `computeJsonPatchUndo`; each engine
only reads-then-writes. (This removes #426's duplicated `createUndoCellUpdate` across the WASM engine
and `nativeWorker`.) Keep the paired-contract comment noting web and native must interpret
`cell_update` fields identically.

## 4. Acceptance criteria (binding contract)

Each row is a unit-level scenario. Cell `data` holds a JSON document; the *tracked* forward edit is
listed, then any *concurrent* edit to a different key, then the expected state after undoing the
tracked edit. Rows marked *(#426)* are where #426 regressed or fell back.

| # | Prior cell | Tracked forward patch | Concurrent edit (different key) | Current at undo | Expected after undo |
|---|-----------|-----------------------|---------------------------------|-----------------|---------------------|
| 1 | `{status:"draft",owner:"ada"}` | `{status:"published"}` | add `reviewer:"grace"` | `{status:"published",owner:"ada",reviewer:"grace"}` | `{status:"draft",owner:"ada",reviewer:"grace"}` |
| 2 | `{}` | `{meta:{reviewed:true}}` | none | `{meta:{reviewed:true}}` | `{}` — wholly-added object **removed** *(#426 left `{meta:{}}`)* |
| 3 | `{}` | `{meta:{reviewed:true}}` | add `meta.note:"keep"` | `{meta:{reviewed:true,note:"keep"}}` | `{meta:{note:"keep"}}` — only added leaf removed |
| 4 | `{a:null,b:1}` | `{a:2}` | none | `{a:2,b:1}` | `{a:null,b:1}` — explicit null **restored** *(#426 fell back to clobber)* |
| 5 | `{meta:{a:null,keep:1}}` | `{meta:{a:2}}` | none | `{meta:{a:2,keep:1}}` | `{meta:{a:null,keep:1}}` — nested explicit null restored *(#426 round-2 P2, unfixed)* |
| 6 | `{status:"draft",owner:"ada"}` | `{status:"published"}` | cell overwritten with non-object (`"plain text"` / SQL NULL / `5` / `[1,2]`) | e.g. `"plain text"` | value-replace → `{status:"draft",owner:"ada"}` *(#426 round-2 P2: `json_patch` didn't throw → silent wrong)* |
| 7 | `{a:1}` | `5` (scalar whole-doc replace) | add `extra` | n/a | value-replace → `{a:1}` |
| 8 | SQL `NULL` | `{added:true}` | none | `{added:true}` | value-replace → SQL `NULL` |
| 9 | batch: two rows each json_patch, each with a concurrent sibling on the other key | per-row `{count:…}` | per-row `concurrent:…` | per row | each row: count restored, concurrent kept; **atomic** (all-or-nothing) |

Cross-cutting invariants:

- **Round-trip:** for any object prior/patch, `undo(forward(prior))` with no concurrent edit equals `prior` exactly (key order aside), including explicit nulls.
- **Sibling survival:** keys absent from the forward patch's key structure are never read, written, or deleted by undo.
- **Non-`json_patch` edits:** behavior byte-for-byte unchanged from 1.5.0.

## 5. Accepted limitation (documented, not a TODO)

When the cell's recorded `prior` is **not** a JSON object (SQL `NULL`, scalar, or array), undo
value-replaces to that prior (scenarios 6–8). If a *concurrent* edit had added a sibling key to such
a cell after the tracked json_patch edit, that sibling is clobbered. This is an extreme corner (cell
was non-object → json-patch-edited → a *different* key concurrently added → undo) and matches the
prior 1.5.0 behavior; surfacing it is out of scope. Document it in a code comment at the eligibility
guard so a future reader knows it is deliberate.

## 6. Reuse vs rewrite (relative to #426 / `fix/json-patch-undo`)

**Reuse (adapt):**
- The ~14 edge-case test *scenarios* in `tests/unit/json_utils.test.ts`, `tests/unit/sqlite_db.test.ts`,
  `tests/unit/nativeWorker.test.ts`. Assertions for scenarios 1/3/4/5 change from "value-replaced" to
  "sibling/null preserved"; SQL-shape assertions change from `json_patch(COALESCE(col,'{}'), ?)` to a
  plain `SET col = ?` carrying the full restored object.
- The `isObject` arrays-are-atomic fix.
- The `operation` / `newValue` plumbing and native→`operationsFacade` routing.

**Add:**
- Scenario 2 (empty-object collapse) and scenario 5 (nested explicit null) tests — the cases #426 lacked/failed.

**Rewrite:**
- The core algorithm: delete `invertMergePatch` / `tryCreateInverseMergePatch` (and the
  `UnfaithfulInverseMergePatchError` machinery); replace with `computeJsonPatchUndo` + `restoreInto`.
- The engine undo paths switch from "emit inverse patch via `json_patch` SQL" to "read current → compute → write full object / value-replace".

## 7. Testing

- **Unit (pure):** `computeJsonPatchUndo` / `restoreInto` against every §4 scenario and the
  round-trip + sibling-survival invariants. No DB needed.
- **Engine (WASM):** `tests/unit/sqlite_db.test.ts` — real `WasmDatabaseEngine` over an in-memory DB;
  drive forward edit(s) + concurrent edit(s), call `undoModification`, assert the stored cell.
- **Engine (native):** `tests/unit/nativeWorker.test.ts` — the recording-mock harness; assert the
  emitted SQL is the plain `SET col = ?` with the expected restored object (or value-replace), and
  that batch json_patch undo is wrapped in a single savepoint.
- **Revert-proof:** reverting the source files must fail exactly the new/changed tests; restoring
  makes them pass.
- **Build gate:** `npx tsc --noEmit` clean; `node scripts/build.mjs` OK; full `npm test` green.
- **Manual smoke:** open a JSON cell in a VFS tab, edit a different key inline in the grid, undo the
  inline edit, confirm the tab's key survives.

## 8. Files touched

| File | Change |
|------|--------|
| `src/core/json-utils.ts` | Replace inverse-patch helpers with `computeJsonPatchUndo` + `restoreInto`; keep `isObject` arrays-atomic |
| `src/core/engine/wasm/WasmDatabaseEngine.ts` | `undoCellUpdate`: read-current → compute → write; batch savepoint; drop duplicated helper |
| `src/nativeWorker.ts` | `undoModification` (cell_update): same RMW via `operationsFacade`; batch savepoint |
| `tests/unit/json_utils.test.ts` | Replace inverse-patch tests with `computeJsonPatchUndo` scenarios (incl. #2, #5) |
| `tests/unit/sqlite_db.test.ts` | WASM undo scenarios (assertions updated to sibling/null-preserving) |
| `tests/unit/nativeWorker.test.ts` | Native undo SQL-shape + batch-atomicity scenarios |

**Not touched in this PR:** `package.json` / `CHANGELOG.md`. The 1.5.1 bump and changelog (covering
both sub-problems) are deferred to Part 2 — the PR that closes #425. See the Release note above.

## 9. Delegation note

Implementation is delegated to Codex (per repo policy). The §4 acceptance table is the binding
contract; §3.1's `restoreInto` is reference guidance, not prescriptive. Verify the diff + run the
full suite + revert-proof check before opening the PR.
