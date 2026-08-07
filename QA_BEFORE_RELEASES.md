# QA Before Releases

## Why this document exists

The goal is not to prove every code path exhaustively. It is to exercise the paths that
have **historically regressed in this project**, on the surfaces where they regress, before
a version-bump `dev` → `main` merge and a `v*` tag.

Every gate below earned its place. Items marked **(repeat offender)** have broken more than
once. Items marked **[unverified]** have never, to our knowledge, been exercised in a
release pass — they are listed because their absence is a risk we are choosing to carry
knowingly rather than one we have forgotten about. Appendix B collects them.

Three structural facts drive the whole plan:

1. **There are two engines.** Desktop uses the native txiki-js backend; VS Code Web and the
   web demo use WebAssembly sql.js. They are separate implementations of the same
   `DatabaseOperations` interface. A green unit suite says little about the engine you did
   not exercise, and several operations diverge (see §3).
2. **The webview is one shared source.** `core/ui/modules/*` is bundled into both the VS
   Code webview and the web demo, so UI logic is verified once — but the *host* around it
   (extension host, RPC bridge, file I/O, custom-editor lifecycle) differs per surface.
3. **The untrusted input is the database file.** Not the network, not user JS. Every
   hostile-input check below assumes the attacker controls bytes in a `.sqlite` file that a
   victim opens.

A conditional gate — "run if X changed" — means exactly that. If the change did not touch
X, record that in the sign-off rather than running it for form's sake.

---

## 0. Traps that make QA pass against the wrong thing

Read this before trusting any desktop result. Each of these produces a *green* result while
testing nothing.

1. **Workspace Trust silently disables custom editors.** In Restricted Mode VS Code reports
   "N extensions are disabled or have limited functionality" and opens a `.sqlite` file in
   the **binary text editor**. Launch with `--disable-workspace-trust`, and assert the
   tab's `input.viewType === 'sqlite-explorer.view'` — matching a tab by file path alone is
   satisfied by the fallback editor too.
2. **`--disable-extensions` also disables the extension under development.** Zero webviews,
   fallback editor, everything "passes".
3. **`code` reuses a running instance for the same `--user-data-dir`.** A run that produces
   no output is usually a stale instance, not a broken test. Kill first.
4. **Hidden webviews are destroyed** (`retainContextWhenHidden` is `false`), so a
   background tab probes as empty. Focus the tab before inspecting.
5. **Extension-host `console.log` never reaches the parent stdout.** Write results to a file.
6. **A DOM query is not proof.** Hidden leftover elements return stale values. Screenshot
   before believing a probe.
7. **`assets/` is gitignored build output.** A fresh worktree carries a stale binary until
   you build, failing the vendored-hash test for reasons unrelated to your change.
8. **Benchmarks under load lie.** Background servers once produced a fake 100× regression.

---

## 1. Repository and build sanity

1. Clean tree: `git status --porcelain` is empty.
2. Releasing from `dev`; `main` untouched since the last release.
3. `node scripts/build.mjs` exits 0.
4. `npx tsc --noEmit -p tsconfig.json` is silent.
5. Generated artifacts rebuilt and committed with their sources: `core/ui/viewer.html`,
   `website/public/sqlite-viewer/viewer.html`, `website/public/sqlite-viewer/worker.js`,
   `assets/sqlite3.wasm`. **Never hand-edit a generated file.**
6. `npm run package` produces a `.vsix` without vsce warnings. Inspect the file list:
   `natives/` present for all five targets, `l10n/` present, no `test_db/`, no
   `docs/superpowers/`, no scan exports, no source maps that shouldn't ship.
7. Confirm `engines.vscode` still matches the pinned `@types/vscode`. `vsce` fails if the
   types are newer than the engine floor.

---

## 2. Mechanical gates

1. `npm test` — zero failures, **run twice consecutively**. The query-deadline lane is
   load-sensitive and has produced flakes that vanish in isolation. Run nothing else heavy
   concurrently.
2. `npm run test:native-smoke` — zero failures. Spawns the **real bundled txiki binary**;
   the only automated lane that catches native-only regressions. It caught an int64
   rounding regression during a binary swap that every mocked test passed.
3. Large-cell containment lane, if cell bounding, exports, blob handling or webview
   transport changed:
   ```
   node scripts/generate-large-cell-fixture.mjs --output <path> [--size-mib 256]
   SQLITE_EXPLORER_RUN_LARGE_CELL_TESTS=1 npx tsx --tsconfig tsconfig.test.json \
     --test tests/performance/large_cell_behavior.test.ts
   ```
   Override size with `SQLITE_EXPLORER_LARGE_CELL_MIB`. Zero TODO/skipped pins.
4. Benchmarks in `tests/performance/` (insert batch, index drop, native column deletion,
   native undo/redo) if the corresponding operation changed. **[unverified]** — these
   exist but are not part of a routine release pass.

---

## 3. Engine matrix — know what you are not testing

| | Native (txiki) | WASM (sql.js) |
|---|---|---|
| Desktop VS Code | default | fallback¹ |
| VS Code Web | — | in **extension host**² |
| Web demo | — | in a Web Worker |

¹ Desktop falls back to WASM on musl/Alpine, Windows-arm, hardened macOS, and wherever the
bundled binary cannot execute. **[unverified]** — the fallback path has never been
deliberately exercised in a release pass.

² This is the only surface where a blocking query stalls the **extension host** rather than
a worker thread. Preemption regressions are invisible on the other two surfaces.

Known divergences to re-check whenever either engine changes:

- `applyModifications` is a no-op on native; history replay goes through `redoModification`.
- Some undo operations (`undoRowDelete`, `insertRowBatch`, `undoColumnDrop`) use raw
  `BEGIN` rather than `SAVEPOINT`, so they cannot be wrapped in an outer savepoint — they
  rely on per-operation atomicity.
- The `maxFileSize` gate (200 MB default) is **WASM-only**. Desktop-native has no size
  limit, so large-file behaviour is not uniform across surfaces.
- `updateCellBatch` grouping differs between engines; the WASM path has historically
  mis-parsed column names.

---

## 4. Desktop + native backend **(repeat offender)**

Preferred: `./install.sh` into a real VS Code, then open a database normally — closer to
what users do than an Extension Development Host, and it avoids throwaway windows.

> `install.sh` packages with `package.json`'s version and does **not** stamp a `-dev`
> suffix, so the dev build is indistinguishable from the release by version. Restore with
> `code --install-extension zknpr.sqlite-explorer --force`.

1. Extension activates; `sqlite-explorer.refresh` is registered and reloads the webview.
2. Each supported extension opens in **our** editor (assert viewType): `.sqlite`,
   `.sqlite3`, `.db`, `.db3`, `.sdb`, `.s3db`. Note `.gpkg` is declared as a **language**
   association but is *not* in the custom-editor selector — confirm the intended behaviour
   rather than assuming.
3. Freshly opened databases are not spuriously dirty.
4. Open several databases at once; confirm no cross-document state bleed (each has its own
   worker, schema, undo stack). **[unverified]** as a deliberate check.
5. Close and reopen an editor: no stale document state.
6. Open a database with no tables, and one with only views.
7. Open a >1 GB database: paging, sorting and editing stay responsive.
8. Open a corrupt/truncated file and a non-SQLite file with a `.db` extension — expect a
   clear error, not a crash or a hang.
9. Open a WAL-mode database with an active `-wal` sidecar; confirm read-only handling and
   that no split-brain write occurs.
10. External mutation: modify the file outside VS Code while open, then use Refresh.
    **[unverified]**

---

## 5. VS Code Web

```
npx @vscode/test-web --extensionDevelopmentPath=<repo-root> \
  --browser none --port 3010 <folder-with-fixtures>
```

The folder is mounted as a **virtual filesystem**, which usefully exercises non-`file:` URI
handling. Real `vscode.dev` / `github.dev` differs — see Appendix B.

1. Extension activates in the browser extension host; custom editor opens from the virtual
   filesystem.
2. Viewer renders inside the cross-origin webview; tables, views, data, exact int64.
3. Editing, saving, undo behave as on desktop.
4. No console errors originating from this extension. Two are expected harness noise: a
   `package.nls.json` 404 probe and a built-in mermaid API-proposal complaint.
5. **Preemption**, if query execution or the WASM engine changed: select an object whose
   evaluation is expensive independently of `LIMIT` — a view wrapping a recursive CTE, an
   aggregate, or an unindexed `ORDER BY` — and confirm it **fails on the query deadline
   rather than hanging**. The extension host is a Web Worker here, so a responsive UI
   thread does *not* prove a responsive host: verify the extension itself still answers.
6. Reload the browser tab mid-session; confirm state restoration (see §14).

---

## 6. Web demo

```
npm --prefix website ci      # first time in a fresh checkout; ci, not install
npm --prefix website run dev
```
then `http://localhost:3000/demo`.

Public-facing and takes user-uploaded databases, so its privacy boundary is part of the
product.

1. Upload a database; schema and grid render. Try both bundled samples.
2. Drag-and-drop upload as well as the file picker.
3. Full UI pass (§7–§16 as applicable).
4. **Zero console errors or warnings.**
5. If transport, CSP or framing changed: `frame-ancestors` must not permit an origin space
   anyone can register; the parent must validate `event.origin`, not just `event.source` —
   an ancestor may navigate a descendant frame while its WindowProxy identity is unchanged.
6. No sql.js glue or WASM fetched from a CDN; both self-hosted from the pinned fork.
7. Confirm the "runs entirely in your browser" claim still holds: no database bytes leave
   the page. Check the network panel during upload, query and export.

---

## 7. Grid, selection and navigation

1. Row numbers, column headers, type-appropriate rendering: `NULL` italic, `[BLOB]` marker,
   REAL vs INTEGER, dates under each `Date Format` mode (Raw / Local / ISO / Relative).
2. Primary-key indicator on single-column PKs and on **every** column of a composite PK.
3. Tri-state column sort: none → asc → desc → none.
4. Pagination: first/prev/next/last, page-size change (100/250/500/1000), and the record
   count. Deep pages on a large table.
5. Filtering: global filter, per-column filters, match highlighting, `Enter`/`Shift+Enter`
   match navigation, and clearing filters.
6. A failed filter must revert the term and leave the previous grid intact rather than
   replacing it with an error panel.
7. Selection: click, `Shift+Click` range, `Cmd/Ctrl+Click` multi-select, `Ctrl/Cmd+A`
   select-all, `Escape` clear.
8. **Stale-index hazards (repeat offender):** select a high-index row or column, then
   switch table / change page / apply a filter / drop a column, and interact again. No
   `TypeError`, and no selection silently pointing at different data.
9. Row pinning and column pinning; pinned state across reload.
10. Copy selected cells (`Ctrl/Cmd+C`) — tab-separated, correct for multi-row/column
    rectangles.
11. Scroll position preserved across a same-table refetch; reset on a real table switch.
12. Rapid table switching during a slow load must not render the wrong table's rows
    (superseded-load guard).

---

## 8. Editing, undo/redo, save/revert **(repeat offender)**

This cluster has broken more than any other. Exercise it on **both** engines.

1. Inline edit (`doubleClickBehavior: inline`), modal edit (`modal`), and full-tab edit
   (`vscode`) — all three settings.
2. `Enter` saves, `Escape` cancels and restores the prior value.
3. Edit each storage class: TEXT, INTEGER, REAL, BLOB, NULL — and the explicit NULL control.
4. Batch update: select cells across rows, set a value, Apply. Then the same with the NULL
   and JSON-patch (`{}`) controls.
5. **Batch selection must not survive a table switch** — applying afterwards would resolve a
   stale column index against a different table.
6. Insert row, insert with defaults, insert into a table with a composite PK.
7. Delete rows; delete columns; smart delete (`Cmd/Ctrl+Delete`) in its three modes
   (selected columns, selected rows, clear cells).
8. Undo and redo **every** operation type above, individually and interleaved.
9. Undo across a page change and across a table switch.
10. Revert (discard all changes) after a mixed batch of edits, inserts, deletes and a
    column drop.
11. Save (`Ctrl/Cmd+S`); reopen the file and confirm persistence to disk.
12. `instantCommit` in all three modes: `never`, `always`, `remote-only`.
13. Hot exit: make changes, close VS Code without saving, reopen — the document restores
    and the undo stack is coherent.
14. Undo memory ceiling (`maxUndoMemory`, 50 MB default): exceed it and confirm graceful
    eviction rather than unbounded growth — and that eviction never discards an entry the
    Revert path still needs.
15. Read-only documents must reject every mutating path, including any RPC not driven by
    the UI.

---

## 9. Schema operations

1. Create table; create table with a composite PK; create `WITHOUT ROWID`.
2. Add column (each affinity, with and without a default, NOT NULL).
3. Drop column, including one referenced by an index or a view; undo the drop and confirm
   data restoration.
4. Rename/alter paths, if present in the UI.
5. Create, edit, preview and drop views. Validate a deliberately invalid view definition and
   confirm a clear error.
6. A view with an `INSTEAD OF` trigger: confirm editing through the view works and the
   trigger is preserved across an edit.
7. Circular / self-referential view definitions must be rejected with a clear message.
8. Indexes list; index drop. **[unverified]** as a routine check.
9. FTS5 virtual tables: present in the schema, queryable with `MATCH`, and their shadow
   tables shown consistently.
10. Confirm SQL identifier escaping throughout by using hostile names (§10).

---

## 10. Data-integrity checks **(repeat offender)**

Cheap, and each has shipped broken at least once. Run through the UI on both engines.

| Check | What breaks |
|---|---|
| Integer beyond 2^53, positive **and** negative | Silent rounding to the nearest double |
| `INTEGER` min/max (`-9223372036854775808`) | Overflow / sign errors |
| JSON cell edited to contain a `null` | RFC 7396 treats null as delete → edit discarded |
| JSON with nested nulls, and nulls inside arrays | Over-eager patch fallback, or lost data |
| Column named with a `\|` | Grouping key split → write lands on the wrong column |
| Column named `__proto__` / `constructor` / `toString` | Prototype aliasing → empty patch, dropped edit, undo crash |
| Table/column names with quotes, spaces, unicode, emoji | Identifier escaping |
| A column literally named `rowid`, `oid`, `_rowid_` | Shadows the intrinsic rowid → wrong identity, unbounded queries |
| `WITHOUT ROWID` with a composite PK | Wrong row identity → edits hit the wrong row |
| Duplicate values in a declared `rowid` column | Row misattribution |
| Strings containing NUL bytes | Truncation; must export as hex blobs in SQL |
| Oversized cell (hundreds of MB) | Unbounded transport → RSS blowup, wedged webview |
| Empty table, single-row table, table with 1000+ columns | Boundary handling |
| A view whose trigger uses single-quoted identifiers | Legal DDL rejected → view uneditable |

---

## 11. Blob inspector and cell media

1. Image preview: PNG, JPEG, GIF, WebP.
2. Audio: MP3, WAV, OGG, FLAC. **[unverified]**
3. Video: MP4, WebM, MOV. **[unverified]**
4. PDF preview (rendered in a sandboxed frame). **[unverified]**
5. Text and JSON preview, including malformed JSON.
6. Hex view, including its size cap.
7. Download a blob to disk; replace a blob by uploading a file; drag-and-drop replace.
8. A blob whose content contradicts its apparent type (e.g. PNG magic bytes on random
   data) must not crash the inspector.
9. Oversized blobs: preview is capped rather than fully decoded, and the size is stated.
10. Media leases are released — repeatedly opening and closing previews must not leak
    temporary files. Confirm temp files are `0600` in a `0700` directory and are cleaned up.

---

## 12. Large cells and containment

1. A cell in the hundreds of MB: the grid shows a bounded preview with an exact byte count,
   not the payload.
2. Such a cell is not editable inline, and the refusal is explained.
3. The inspector streams rather than materialising the whole value.
4. Export of a table containing one streams to disk without an RSS spike.
5. Undo history involving an oversized cell: the barrier entry must survive eviction, and
   Revert must not silently keep an oversized replacement.
6. Webview transport limits produce a typed rejection, not a `RangeError`.

---

## 13. Export

For each of CSV, Excel (CSV + BOM), and SQL:

1. Export a whole table, a filtered view, and a selection.
2. Round-trip: re-import the SQL export into a fresh database and compare.
3. Values needing quoting: commas, quotes, newlines, unicode.
4. **Formula injection:** cells and column names starting with `=`, `+`, `-`, `@`, tab or
   CR must not execute when the file is opened in a spreadsheet.
5. NULL vs empty string are distinguishable.
6. Exact integers beyond 2^53 export losslessly in every format.
7. Strings containing NUL bytes export as hex blobs in SQL.
8. Export a very large table: streamed to disk, atomic rename, no truncated output on
   cancel.
9. Export from the web demo triggers a browser download with the right filename.

---

## 14. Settings, pragmas and state

1. Every setting takes effect without a reload where it claims to: `maxFileSize`,
   `defaultPageSize`, `maxRows`, `instantCommit`, `doubleClickBehavior`, `fileOperations`,
   `queryTimeout`, `maxInlineCellBytes`, `maxUndoMemory`.
2. `fileOperations: web` forces the WASM path on desktop — an easy way to exercise the
   fallback engine. **[unverified]**
3. `maxFileSize: 0` (unlimited) and a deliberately small value.
4. Pragma editor: `journal_mode`, `foreign_keys`, `auto_vacuum`, `cache_size`,
   `locking_mode`. Changing `journal_mode` to WAL and back is the highest-risk one.
5. Pragma values are validated — reject injection attempts through the pragma UI.
6. **State persistence:** `retainContextWhenHidden` is false, so hide the tab (switch to
   another editor) and return. Selected table, scroll position, filters, pins, sort and
   page must restore. Extension settings must win over restored state.
7. Sidebar width/collapse state persists across reloads.

---

## 15. Query execution, timeout and cancellation

1. A long-running query can be cancelled from the UI; the connection stays usable
   afterwards.
2. `queryTimeout` is enforced; the error names the timeout rather than surfacing a raw
   engine message.
3. Cancellation during: initial load, page change, filter, sort, export.
4. Native: an abort delivered while the request is still queued in the thread pool must
   reject, not resolve with rows.
5. WASM: the progress handler interrupts a running statement; a throwing progress callback
   also interrupts.
6. After a timeout, the next query works — no wedged handler, no leaked prepared statement.

---

## 16. Virtual filesystem and cell-in-tab editing

1. `doubleClickBehavior: vscode` opens a cell in a real editor tab.
2. Editing and saving that tab writes back to the cell.
3. The tab's language/encoding is sensible for the content.
4. Closing the database while a cell tab is open, and vice versa. **[unverified]**
5. Two cell tabs open simultaneously from different databases. **[unverified]**

---

## 17. Security surface

The threat model: the attacker controls the bytes of a database the victim opens. Webview
script execution is *not* assumed — no HTML-injection sink is known — but the boundary
should hold if one appeared.

1. `readWorkspaceFileUri` containment: a path traversing out of the workspace or the
   document directory must be denied, for `file:` **and** every virtual scheme
   (`vscode-remote:`, `vscode-vfs:`, `vscode-userdata:`). Backslash separators on a
   Windows-semantics provider must be denied.
2. The extension's own `sqlite-explorer:` scheme must be blocked from that method — its
   document key is a plain hash of the path, so otherwise one document's webview could read
   another's cells.
3. The webview RPC dispatcher exposes every function-valued `HostBridge` property by name.
   Review any newly added method as public API, and confirm read-only documents reject
   mutating ones.
4. CSP is emitted on every host that populates `webview.cspSource` — including VS Code
   forks such as Cursor and Windsurf, which install from Open VSX. Confirm a nonce-based
   policy with no `unsafe-inline` for scripts. **[unverified on forks]**
5. Grid rendering uses `textContent`; filter highlighting builds `<mark>` via DOM nodes,
   never `innerHTML` with data.
6. SQL identifiers escaped via `escapeIdentifier`; values always bound as parameters;
   `LIKE` patterns escaped with an explicit `ESCAPE` clause.
7. No secrets in logs. The output channel logs SQL — confirm it does not log cell values
   that could contain credentials. **[unverified]**

---

## 18. Localization and accessibility

13 locales ship (`l10n/`): de, es, fr, it, ja, ko, nl, pl, pt-br, ru, tr, zh-cn, zh-tw.

1. Launch VS Code in at least one non-English locale and confirm strings resolve and the
   layout survives longer translations. **[unverified]**
2. No untranslated placeholder keys visible.
3. Keyboard-only operation: reach and operate the sidebar, grid, filters and modals with
   Tab/Shift-Tab; focus is visible and never trapped. **[unverified]**
4. Screen-reader labels on grid cells and toolbar controls. **[unverified]**
5. Light, dark and **high-contrast** themes: no unreadable text, no invisible focus ring.
   **[unverified for high contrast]**
6. Editor font-size and zoom changes do not break the grid layout.

---

## 19. Platform and packaging matrix

Bundled native targets: `aarch64-macos`, `x86_64-macos`, `aarch64-linux-gnu`,
`x86_64-linux-gnu`, `x86_64-windows`.

1. Smoke-test the platform you are releasing from, at minimum.
2. **[unverified]** Windows: path handling, drive letters, UNC paths, CRLF in exports.
3. **[unverified]** Linux: both architectures.
4. **[unverified]** musl/Alpine: the native binary cannot run; confirm the WASM fallback
   engages cleanly rather than erroring.
5. **[unverified]** Remote-SSH and Dev Containers: the extension runs on the remote, the
   webview locally; check file paths and drag-and-drop.
6. macOS: binaries are ad-hoc signed, not notarized. Confirm Gatekeeper behaviour on a
   machine that has never run them. **[unverified]**
7. Confirm the extension activates on the **minimum** supported VS Code version, not only
   the latest. **[unverified]**

---

## 20. Performance gate

**Benchmark only on a quiet machine.** Shut down dev servers and browser automation first.

```
npx tsx --tsconfig tsconfig.test.json scripts/bench-native.ts \
  --db <large fixture> --iterations 7
```

Reference (aarch64-macos, 1.39 GB fixture, 7 iterations, 2026-08-07):

| Workload | Median | Throughput |
|---|---:|---:|
| cold start | 17.51 ms | — |
| schema refresh | 0.18 ms | — |
| first page (500) | 3.04 ms | 164k rows/s |
| deep page (500) | 186.23 ms | 2.68k rows/s |
| wide result (~100k) | 175.66 ms | 569k rows/s |
| aggregate `COUNT(*)` | 11.88 ms | — |
| blob/text heavy | 0.79 ms | 76.8 MiB/s |
| edit round-trip | 0.41 ms | — |
| cancellation overhead | 0.10 ms | — |

Rules: discard the warm-up, take the median of the remainder. A **5%+ regression** needs a
clean rerun and an explanation. A repeatable **10%+ regression** is a release blocker unless
it is a documented, deliberate trade — cold start already carries one (the load-safe native
capability probe costs ~10 ms and is accepted).

Deep-OFFSET paging is ~60× slower than page one. This is a property of **our current
query shape**, not an unavoidable engine limit: `OFFSET n` makes SQLite walk and discard n
rows, so the cost grows with depth. Measured on the 1.39 GB fixture at offset 3.5 M
(process startup subtracted): plain OFFSET ~97 ms, index-assisted OFFSET ~95 ms (no help —
the primary key *is* the rowid, so its index is the table), keyset/seek **~3 ms**, first
page ~3 ms. Keyset does not shrink the cliff, it removes it.

Until that lands, treat the deep-page number as a baseline to compare against rather than a
target, and flag only movement.

Also compare startup time and peak RSS when loading, caching, streaming or temporary
buffers changed. **[unverified]** — WASM-side performance has no tracked baseline at all.

### Scaling with row count

One fixture does not show which operations degrade. Re-measure the curve whenever the query
shape, pagination or engine changes. Narrow schema (`id INTEGER PRIMARY KEY, n INTEGER,
s TEXT`, ~30 bytes/row), generated by table doubling; raw `sqlite3`, process spawn+open
subtracted; warm.

| Rows | File | Open | First page | Last via OFFSET | Last via keyset | `COUNT(*)` | Unindexed scan |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 K | 216 K | 21.8 | 0.0 | 0.0 | 0.0 | 0.1 | 0.0 |
| 100 K | 2.2 M | 20.7 | 0.0 | 0.6 | 0.0 | 0.0 | 3.0 |
| 1 M | 22 M | 18.3 | 1.0 | 8.4 | 0.2 | 4.9 | 24.8 |
| 10 M | 231 M | 19.8 | 0.0 | 67.2 | 0.0 | 31.4 | 216.3 |
| 100 M | 2.4 G | 21.6 | 1.2 | 708.0 | 0.0 | 376.0 | 2239.5 |

All times ms. What the curve says:

- **Open is O(1)** — a 2.4 GB database opens as fast as a 216 KB one. File size alone is
  not a risk; row count on the operation you run is.
- **First page is O(1)** at every size.
- **`OFFSET` is exactly linear.** 708 ms for a single page turn at 100 M rows.
- **Keyset is O(1)** — 0.0 ms at 100 M rows. This is why §20's cliff is a query-shape
  problem, not an engine limit.
- **`COUNT(*)` is linear** — 376 ms at 100 M rows, and it is paid on every table load to
  compute the page count. Once pagination is keyset-based this becomes the dominant cost of
  opening a large table.
- **An unindexed filter is linear and brutal** — 2.24 s at 100 M rows. Not fixable by query
  shape; it is what cancellation exists for.

Note the extension pays more than these raw numbers: its rows are wider (BLOBs), and every
result crosses the worker IPC boundary. Treat this table as the engine floor, not the
product's cost.

Generate the fixtures with the scaling harness rather than by hand; a 100 M-row file builds
in well under a minute by doubling, and 2.4 GB is worth deleting afterwards.

### Scaling with page size

End-to-end page turn in the web demo (WASM engine + IPC + DOM), 8-column table, measured
from the page-size change to the last row appearing:

| Page size | Total | Cells | DOM nodes | ms / 1000 rows |
|---:|---:|---:|---:|---:|
| 100 | 32 ms | 900 | 2,700 | 320 |
| 250 | 57 ms | 2,250 | 6,750 | 228 |
| **500 (default)** | **92 ms** | 4,500 | 13,500 | 184 |
| 1,000 | 157 ms | 9,000 | 27,000 | 157 |
| 2,500 | 324 ms | 22,500 | 67,500 | 130 |
| 5,000 | 621 ms | 45,000 | 135,000 | 124 |
| 10,000 | 1,197 ms | 90,000 | 270,000 | 120 |
| 25,000 | 3,087 ms | 225,000 | 675,000 | 123 |

Linear at **~0.12 ms/row** beyond 500, over ~20 ms of fixed overhead. For comparison the
engine alone returns 10,000 wide rows (1.57 MB, 6 columns incl. BLOB) in **6.1 ms** and
25,000 in 16.7 ms — so **over 90% of a page turn is IPC and DOM, not SQL**.

The grid does not virtualize: `grid-render.js` builds DOM for every row in the page, at
`<td>` → `<span class="cell-text">` → text node, i.e. **27 nodes per row** for 8 columns.
That is the wall, and it is why the default page size cannot simply be raised: 500 rows is
92 ms (about the edge of feeling instant), 1,000 is 157 ms, and 2,500 is visibly janky.

Re-measure this curve if cell rendering, highlighting, or the transport changes. A
regression here is felt on every single page turn.

---

## 21. Vendored binaries and WASM **(repeat offender)**

The extension ships prebuilt native binaries and a patched sql.js. Provenance has been a
real problem: the original binaries came from a fork that was later deleted, leaving
unauditable blobs in the tree.

If `natives/` or `vendor/sql.js/` changed:

1. Artifacts come from a **pinned CI run of our own fork**, installed via
   `scripts/refresh-natives.mjs` / `scripts/refresh-sqljs.mjs`, which verify SHA-256
   against the pins and refuse anything else.
2. Re-pin all coordinates together: source branch, run id, digests, and the usage examples
   in the script header.
3. Fork **source** changes ship nothing until CI rebuilds and the hashes are re-pinned.
4. txiki embeds its JS stdlib as precompiled bytecode: `src/bundles/c/stdlib/*.c` must be
   regenerated and committed with their JS sources, or the binary runs stale JS.
5. Rerun the native smoke lane after any binary swap.
6. Confirm the README credit links to the fork actually being shipped.
7. Ideally verify the build is reproducible — a local rebuild matching the CI digest.

---

## 22. Release mechanics

1. Version bump touches `package.json` and `CHANGELOG.md` only — **never hand-edit the
   lockfile**.
2. Versioning convention: patch by default, minor only for real features, never skip or
   jump a version.
3. Merge `dev` → `main`. This is where the review bots run — Codex auto-reviews every push
   (~6 min), CodeRabbit and Gemini also comment. **Read and verify their findings before
   merging.** Bots skip bot-authored PRs, so you are the reviewer there.
4. The release ships on a `v*` tag, not on merge. `release.yml` builds the `.vsix` and
   creates the GitHub Release.
5. Open VSX is published separately by `scripts/publish-openvsx.mjs`, which verifies the
   GitHub asset's SHA-256 before uploading. `--verify-only <version>` audits a published
   version; `--dry-run` rehearses.
6. All third-party GitHub Actions pinned to full commit SHAs, and each pin resolves to the
   tag its comment claims.
7. After publishing, install the released artifact from the Marketplace **and** Open VSX in
   a clean profile and smoke-test it. The thing users get is not the thing you built
   locally. **[unverified]** as a routine step.

---

## 23. Sign-off

Do not tag until each line is satisfied or **explicitly documented with a reason**.

- [ ] Clean tree; build and type-check pass; generated artifacts rebuilt and committed
- [ ] `.vsix` contents inspected
- [ ] Full unit suite green **twice consecutively**
- [ ] Native real-binary smoke lane green
- [ ] Large-cell lane green, or documented as not applicable
- [ ] Desktop + native: editor verified **by viewType**; edit/save/undo/revert; export
- [ ] VS Code Web: activation, open, read, edit; no extension-originated console errors
- [ ] Web demo: full UI pass; zero console errors or warnings
- [ ] Editing/undo/redo/save/revert exercised on **both** engines
- [ ] Data-integrity checks (§10) exercised
- [ ] Export round-trip and formula-injection checks passed
- [ ] Query timeout and cancellation verified on both engines
- [ ] Security surface (§17) reviewed for anything newly exposed
- [ ] Performance gate passed on a quiet machine, or the regression documented as deliberate
- [ ] Vendored binaries/WASM traceable to a pinned fork CI run; hashes re-pinned
- [ ] Review-bot findings read and resolved on the `dev` → `main` merge
- [ ] CHANGELOG updated; version bump touches `package.json` + `CHANGELOG.md` only
- [ ] Every skipped item recorded with its reason

---

## Appendix A: regression history

Why the gates are shaped this way. Each of these shipped or nearly shipped.

- **Native binary swap rounded int64s** — adjacent unsafe rowids became identical. Caught
  only by the real-binary smoke lane.
- **JSON merge-patch dropped nulls** — editing a cell to contain `null` silently discarded
  the edit while reporting success, on the most common editing path in the product.
- **`fetchTableData` skipped query preemption** behind a comment asserting `LIMIT` bounds
  execution time. It bounds rows returned, not work done.
- **Workspace Trust masked the custom editor**, making desktop QA pass against the binary
  text editor.
- **A `\|` in a column name** truncated the grouping key and wrote to a different column.
- **Batch-update selection survived a table switch**, letting an Apply resolve a stale
  column index against a different table.
- **`__proto__` as a column name** produced an empty patch (edit dropped) and crashed undo
  of a column drop.
- **A declared `rowid` column** shadowed the intrinsic rowid, producing an unbounded
  companion query and misattributed row metadata.
- **vscode.dev failed to load** because the browser build was emitted as an IIFE with no
  `activate` export — invisible on desktop.
- **Grid concurrency** — overlapping loads and a stale grid produced flicker and
  interactions against data already replaced.
- **Hot exit and undo atomicity** — repeatedly, until transactions were savepoint-bracketed.
- **A 256 MB cell** pushed RSS near 1 GB and wedged the webview before containment.
- **A serializer shape-cache use-after-free** in the native IPC path emitted structurally
  valid bytes carrying a value under the wrong property key.

## Appendix B: known coverage gaps

Carried knowingly. Revisit when one of these areas changes, or when a bug lands in it.

- **Platforms**: only macOS-arm64 is routinely exercised. Windows, Linux (both arches),
  musl/Alpine and the WASM fallback path are untested per release.
- **Remote development**: Remote-SSH, Dev Containers, WSL, Codespaces.
- **Real `vscode.dev` / `github.dev`**: `@vscode/test-web` is close but not identical.
- **VS Code forks**: Cursor and Windsurf install from Open VSX and now receive a CSP for
  the first time; never launched there.
- **Minimum supported VS Code version**: only the latest is tested.
- **Localization**: 13 locales ship; none are exercised.
- **Accessibility**: keyboard-only operation, screen readers, high-contrast themes.
- **Media previews**: audio, video and PDF paths.
- **The published artifact**: Marketplace and Open VSX installs are not smoke-tested
  post-release.
- **WASM performance**: no tracked baseline exists; only the native backend is benchmarked.
- **Concurrency**: external writes to an open database, and multiple databases open at once.
- **Gatekeeper**: binaries are ad-hoc signed, not notarized; first-run behaviour on a clean
  macOS machine is unverified.
