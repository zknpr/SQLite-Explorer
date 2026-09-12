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
   Code webview and the web demo. Run the applicable UI actions on each surface: the
   extension host, RPC bridge, file I/O, media loaders, and custom-editor lifecycle differ.
3. **The untrusted input is the database file.** Not the network, not user JS. Every
   hostile-input check below assumes the attacker controls bytes in a `.sqlite` file that a
   victim opens.

A conditional gate — "run if X changed" — means exactly that. If the change did not touch
X, record that in the sign-off rather than running it for form's sake.

For every release candidate, complete the [full real-session pass in Appendix C](#appendix-c-full-real-session-pass).
It preserves the 161-action inventory from the 2026-09-06 computer-use session, with
expected results, fixture requirements, and the four cases that still need a complete
retest. Its checkboxes start empty for each candidate. Prior results do not clear a new
release, and this inventory supplements the integrity, platform, and conditional gates below.

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
9. **A cached application's directory name does not prove its version.** Read the actual
   application's version. A cache named `1.110.0` had updated itself to `1.135.0` during
   QA. `scripts/run-desktop-tests.mjs` rejects that mismatch; use
   `VSCODE_TEST_EXECUTABLE_PATH` for a separately verified minimum-version executable.
10. **Named VS Code profiles can share installed extension files.** Installing a native
    VSIX can change the backend of a newly opened database in a window named "WASM".
    Use separate `--user-data-dir` and `--extensions-dir` directories for independent
    candidates/backends, or test installations sequentially. Verify installed file hashes
    and the live backend log for each connection; a profile name is not evidence.
11. **Automation input limits are coverage gaps.** A synthetic click/drop or direct RPC
    call does not verify an actual mouse gesture. If computer use cannot hold a modifier,
    have a person perform Cmd/Ctrl-click and Shift-drag. Record the case as blocked until
    it runs. An unavailable fullscreen button also needs an explicit result.
12. **A stale accessibility tree can hide a busy webview.** Confirm the visible state and
    inspect the relevant renderer when the UI stops responding. The workbench renderer
    can be idle while the shared webview renderer is CPU-bound. A recovered window does
    not turn the stalled operation into a pass.

---

## 1. Repository and build sanity

1. Clean tree: `git status --porcelain` is empty.
2. Releasing from `dev`; `main` untouched since the last release.
3. `node scripts/build.mjs` exits 0.
4. `npx tsc --noEmit -p tsconfig.json` is silent.
5. Generated artifacts rebuilt and committed with their sources: `core/ui/viewer.html`,
   `website/public/sqlite-viewer/viewer.html`, `website/public/sqlite-viewer/worker.js`,
   `assets/sqlite3.wasm`. **Never hand-edit a generated file.**
6. `npm run package` produces exactly six `.vsix` files without vsce warnings: five
   platform targets plus the natives-free universal. The packaging script lists and gates
   every archive before moving it into `release/`. Each target must contain only
   `natives/native-worker.js`, its mapped `tjs` executable, and its query-plan library;
   universal must contain no
   `natives/` path. Every package retains `out/extension-browser.js` and `l10n/`, with no
   `test_db/`, `docs/superpowers/`, scan exports, or source maps.
7. **Package size is a gate, not a footnote (repeat offender).** The old universal package
   doubled once (9→19 MB) from shipping unstripped binaries with linked DWARF — invisible
   to every test. Record every package's byte size and archive file count; a **>10% growth**
   against its own baseline needs an explanation before shipping. Baseline from the
   1.6.0 build on 2026-08-09:

   | Package | Bytes | MiB | Files |
   |---|---:|---:|---:|
   | `sqlite-explorer-darwin-x64-1.6.0.vsix` | 3,112,074 | 2.97 | 69 |
   | `sqlite-explorer-darwin-arm64-1.6.0.vsix` | 3,019,726 | 2.88 | 69 |
   | `sqlite-explorer-linux-x64-1.6.0.vsix` | 3,305,318 | 3.15 | 69 |
   | `sqlite-explorer-linux-arm64-1.6.0.vsix` | 3,278,494 | 3.13 | 69 |
   | `sqlite-explorer-win32-x64-1.6.0.vsix` | 3,296,228 | 3.14 | 69 |
   | `sqlite-explorer-1.6.0.vsix` (WASM-only universal) | 1,334,478 | 1.27 | 67 |

   Compare file counts with the most recent approved release of the same target. The
   counts above are historical, not fixed requirements for newer versions. Inspect and
   explain added or removed entries; a jump into the hundreds is a release blocker
   because it usually means `node_modules` leaked back in.
   The binaries come from the fork artifact workflow with
   `BUILD_WITH_STRIP`+`GC_SECTIONS` **and** `BUILD_WITH_WASM/FFI/LWS=OFF` (the worker only
   uses `tjs:sqlite`+`tjs:v8`, so the WASM interpreter, FFI/dlopen and the
   libwebsockets/TLS/HTTP stack are excluded — also a security win: the file-parsing
   worker has no network egress or dlopen). A plain-Release rebuild, or one that re-enables
   those subsystems, silently regresses both size and attack surface.
8. Confirm `engines.vscode` still matches the pinned `@types/vscode`. `vsce` fails if the
   types are newer than the engine floor.

---

## 2. Mechanical gates

1. `npm test` — zero failures, **run twice consecutively**. The query-deadline lane is
   load-sensitive and has produced flakes that vanish in isolation. Run nothing else heavy
   concurrently.
2. `npm run test:native-smoke` — zero failures. Spawns the **real bundled txiki binary**;
   the only automated lane that catches native-only regressions. It caught an int64
   rounding regression during a binary swap that every mocked test passed.
3. `npm run test:desktop` — run locally after `node scripts/build.mjs` for every release
   candidate and whenever custom-document lifecycle, persistence, virtual files, exports,
   or backend selection changes. It downloads/caches the `engines.vscode` version and runs
   the native/WASM host-integration matrix in one Extension Development Host launch. This
   is deliberately a local/release gate, not part of `ci.yml`. It does not replace the
   installed-extension computer-use pass in Appendix C. The runners in `tests/gui/`
   provide additional automated regressions; direct API or DOM checks alone cannot clear
   real menu, file-dialog, keyboard, drag/drop, or media-player actions.
4. Large-cell containment lane, if cell bounding, exports, blob handling or webview
   transport changed:
   ```
   node scripts/generate-large-cell-fixture.mjs --output <path> [--size-mib 256]
   SQLITE_EXPLORER_RUN_LARGE_CELL_TESTS=1 npx tsx --tsconfig tsconfig.test.json \
     --test tests/performance/large_cell_behavior.test.ts
   ```
   Override size with `SQLITE_EXPLORER_LARGE_CELL_MIB`. Zero TODO/skipped pins.
5. Benchmarks in `tests/performance/` (insert batch, index drop, native column deletion,
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
bundled binary is absent or cannot execute. The unit suite pins a natives-absent open
through the WASM worker with no native connection attempt or error notification; a real
unsupported-host release smoke test remains **[unverified]**.

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
1a. **Wide tables at the default page size (repeat offender).** Open a **≥50-column** table
    at page size **5000 and 10000** and confirm ordinary cells (UUIDs, short JSON, emails —
    tens of bytes) render **inline, not as `TEXT · N bytes` oversized markers**. A regression
    once made the per-cell inline budget `maxPageResponseBytes / (rows × columns)`, so at
    50 cols × 5000 rows every cell got ~30 bytes and clipped. The fix is a 256-byte SQL clip
    floor plus budget enforcement on *actual* transported bytes; the guard is a
    50-col × 5000-row zero-marker unit test, but eyeball it on a real wide table too — the
    number of columns × the page size is the axis that breaks it.
2. Primary-key indicator on single-column PKs and on **every** column of a composite PK.
3. Tri-state column sort: none → asc → desc → none.
4. Pagination: first/prev/next/last, page-size change (100/250/500/1000/2500/5000/10000,
   default 5000), and the record count. Deep pages on a large table.
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
2. Audio: MP3, WAV, OGG, FLAC. Play, pause, and seek; record each format separately.
3. Video: MP4, WebM, MOV. Play, pause, seek, and try fullscreen in both the inspector and
   the full-content viewer. Test files must also play directly in the same VS Code host.
4. PDF: test the small-file download/open path and bounded oversized preview separately.
5. Text and JSON preview, including malformed JSON.
6. Hex view, including its size cap.
7. Download a blob to disk; replace a blob by uploading a file; drag-and-drop replace.
8. A blob whose content contradicts its apparent type (e.g. PNG magic bytes on random
   data) must not crash the inspector.
9. Oversized blobs: preview is capped rather than fully decoded, and the size is stated.
10. Media leases are released — repeatedly opening and closing previews must not leak
    temporary files. Confirm temp files are `0600` in a `0700` directory and are cleaned up.
11. Oversized BLOB labels use neutral text and a byte count. Ordinary large values must
    not look like yellow warnings.
12. Select **Hex**, then click **Open Full Hex** for BLOB, TEXT, video, and PDF cells.
    A complete read-only hex document opens. Decode it independently and compare its
    length and SHA-256 with the stored bytes, including the final partial row. PDF Hex
    must follow the hex-document path. The Preview tab still opens the original content.
13. Open a known-good MP4 below the inline threshold through **Open Full Content**.
    Confirm a nonzero, accurate file size, actual playback, and seeking. Repeat above
    the threshold to cover temporary-file materialization as well as the virtual URI.
14. Load a 2,800,000-byte TEXT fixture with 400,000 short lines of `é😀`, each followed by
    a newline. Step from the 64 KiB preview through 1 MiB, 2 MiB, and the full value on
    both engines. Also use a single long Unicode line. Record load/close timings, inspect
    the first and last preview pages, and copy across internal text chunks without
    inserting bytes. Exercise Previous, Next, Last, and valid/invalid page-number input.
    Selection/copy must match the displayed page, whose limit is stated. Check that
    selecting after scrolling cannot attach or lay out the complete loaded value.
    Watch for delayed stalls after loading, closing, and switching databases.
15. Replace a cell with a 5 MiB file via the picker and actual Shift-drag from Explorer.
    Compare stored bytes, then verify byte-exact undo and redo. Cancelling either path
    must preserve the original value.
16. Malformed media must offer bounded Hex recovery. Malformed database TEXT must expose
    its original bytes in Hex. Do not use decoded replacement characters as the oracle.
17. Full Hex reserves quota for the expanded dump before reading. Check rejection,
    cancellation, source changes, and temporary-file cleanup through the existing
    materialization regressions; the original database must remain unchanged.

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

For each of CSV, JSON, Excel (CSV + BOM), and SQL:

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
   `defaultPageSize`, `instantCommit`, `doubleClickBehavior`, `fileOperations`,
   `queryTimeout`, `maxInlineCellBytes`, `maxUndoMemory`.
2. Exercise desktop WASM using a natives-free universal VSIX in its own extension
   directory. Confirm the live backend log. A file-I/O setting or a profile name is not
   proof of backend selection.
3. `maxFileSize: 0` (unlimited) and a deliberately small value. On WASM, first refuse a
   larger file, then raise/remove the limit and retry without reloading. Record whether
   the host retries or caches the failed custom-editor open. A subsequent successful
   Reload Window is a separate result, not evidence that the immediate retry worked.
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

Reference (aarch64-macos, 1.39 GB fixture, 9 iterations, 2026-08-08):

| Workload | Median | Throughput |
|---|---:|---:|
| cold start | 17.30 ms | — |
| schema refresh | 0.18 ms | — |
| first page (500) | 3.15 ms | 159k rows/s |
| deep page OFFSET (500) | 208.12 ms | 2.40k rows/s |
| deep page keyset (500) | 3.18 ms | 157k rows/s |
| wide result (~100k) | 171.92 ms | 582k rows/s |
| aggregate `COUNT(*)` | 11.76 ms | — |
| blob/text heavy | 0.87 ms | 70.2 MiB/s |
| edit round-trip | 0.43 ms | — |
| cancellation overhead | 0.11 ms | — |

Rules: discard the warm-up, take the median of the remainder. A **5%+ regression** needs a
clean rerun and an explanation. A repeatable **10%+ regression** is a release blocker unless
it is a documented, deliberate trade — cold start already carries one (the load-safe native
capability probe costs ~10 ms and is accepted).

Keyset (seek) pagination shipped 2026-08-08: grid navigation and current-page refetches
seek from engine-minted anchors instead of scanning to OFFSET, so a deep page turn costs
the same as the first page (3.18 vs 3.15 ms above — 65× below the OFFSET shape, which
`OFFSET n` pays by walking and discarding n rows). The OFFSET query remains as the
engine-validated fallback (first load of a table, restored webview state, any anchor
staleness), and both paths emit one deterministic total order — identity tiebreak
appended to sorts — so mixed OFFSET/keyset sequences cannot skip or duplicate rows.

Gate on both deep-page rows: keyset must sit at first-page cost, and the harness prints a
stderr warning when the keyset workload's timing suggests it silently fell back to OFFSET
— treat that warning as a failure. First page carries one rowid-authority read per grid
load (deliberate: the same in-snapshot answer gates seek eligibility, fallback ordering,
and anchor minting).

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
  compute the page count. Now that pagination seeks instead of scanning (2026-08-08), this
  is the dominant per-load cost on a large table — the next optimization target.
- **An unindexed filter is linear and brutal** — 2.24 s at 100 M rows. Not fixable by query
  shape; it is what cancellation exists for.

Note the extension pays more than these raw numbers: its rows are wider (BLOBs), and every
result crosses the worker IPC boundary. Treat this table as the engine floor, not the
product's cost.

Generate the fixtures with the scaling harness rather than by hand; a 100 M-row file builds
in well under a minute by doubling, and 2.4 GB is worth deleting afterwards.

### The two engines compared

`scripts/bench-wasm-scaling.mjs` runs the same query set as the native harness against the
vendored sql.js build, so the curves are directly comparable. Same narrow fixtures.

| Rows | File | WASM open¹ | first | OFFSET | keyset | `COUNT(*)` | scan | RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 K | 216 K | 8.0 | 0.4 | 0.4 | 0.3 | 0.0 | 0.7 | 89 M |
| 100 K | 2.2 M | 0.2 | 0.2 | 1.5 | 0.2 | 0.2 | 5.8 | 109 M |
| 1 M | 23 M | 13 | 0.1 | 7.4 | 0.2 | 1.2 | 37.1 | 82 M |
| 10 M | 242 M | 37 | 0.1 | 74.3 | 0.1 | 12.1 | 376.2 | 347 M |
| — | 1.39 G | 260 | — | — | — | — | — | 1735 M |
| — | 2.61 G | **fails** | — | — | — | — | — | — |

¹ open includes reading the file into memory, which for WASM is unavoidable.

Build flags are settled: an `-O3` build of the same fork (measured 2026-08-08, warm
A/B/A on the 10 M fixture) doubles the artifact for identical hot paths, a ~5% *slower*
deep OFFSET, and ~12% on unindexed scans only — keep `-Oz` for every target and re-test
only if the compiler toolchain changes.

Head-to-head at 10 M rows (WASM vs raw `sqlite3`): deep OFFSET 74.3 vs 67.2 ms, keyset 0.1
vs 0.0, `COUNT(*)` **12.1 vs 31.4** (WASM wins — the whole database is already resident, so
there are no page-cache misses), unindexed scan 376 vs 216 ms.

**The conclusion that matters: WASM's limits are memory and load time, not query speed.**
Once loaded it is within ~2× of native on a full scan and comparable or better elsewhere,
and **keyset is O(1) on both engines**, so the keyset pagination gated in §20 pays off
identically on each.

Where they genuinely differ:

| | Native (txiki) | WASM (sql.js) |
|---|---|---|
| Open | by path, O(1) — ~20 ms at any size | must materialise the whole file |
| Open cost vs size | flat | ~187 MB/s (260 ms for 1.39 GB) |
| RSS vs database size | independent | **≈ 1:1** (a 1.39 GB file costs 1.39 GB) |
| Practical size ceiling | none observed | fails above ~2 GiB |

The 2.61 GB failure is Node's 2 GiB `Buffer` limit, a *host* limit rather than a WASM one —
in a browser the binding ceiling is the WASM32 address space and whatever the host allows
for one ArrayBuffer. Either way a browser tab holding 1.4 GB is hostile, which is what the
WASM-only `maxFileSize` gate (200 MB default) exists to prevent. Worth knowing that the
engine itself handled 1.39 GB fine, so that default is conservative rather than a hard
technical bound — revisit it deliberately rather than assuming it is load-bearing.

Re-run both harnesses whenever query shape, pagination or either engine changes.

### Scaling with page size

End-to-end page turn in the web demo (WASM engine + IPC + DOM), 8-column table, measured
from the page-size change to the last row appearing:

| Page size | Total | Cells | DOM nodes | ms / 1000 rows |
|---:|---:|---:|---:|---:|
| 100 | 32 ms | 900 | 2,700 | 320 |
| 250 | 57 ms | 2,250 | 6,750 | 228 |
| 500 (default until 2026-08-08) | 92 ms | 4,500 | 13,500 | 184 |
| 1,000 | 157 ms | 9,000 | 27,000 | 157 |
| 2,500 | 324 ms | 22,500 | 67,500 | 130 |
| **5,000 (default since 2026-08-08)** | **621 ms** | 45,000 | 135,000 | 124 |
| 10,000 | 1,197 ms | 90,000 | 270,000 | 120 |
| 25,000 | 3,087 ms | 225,000 | 675,000 | 123 |

Linear at **~0.12 ms/row** beyond 500, over ~20 ms of fixed overhead. For comparison the
engine alone returns 10,000 wide rows (1.57 MB, 6 columns incl. BLOB) in **6.1 ms** and
25,000 in 16.7 ms — so **over 90% of a page turn is IPC and DOM, not SQL**.

The curve above is the PRE-virtualization baseline (kept as the fallback-path reference).
Since 2026-08-08 the grid windows its rows: only the visible slice plus 20 overscan rows
per side is materialized between two spacer rows, so render cost is proportional to the
viewport (~38-58 rows regardless of page size; a 2500-row page renders ~59× fewer nodes
than a full build). Pages within ~1.5 viewports still render fully — that path is the
table above. Gate on both:

- a large page must materialize only the window (count `tbody tr:not(.virtual-spacer)`
  and check the two spacer heights sum to `(rows − materialized) × 26px`);
- scrolling must back-fill within a frame, zebra stripes must be a pure function of the
  row ordinal across re-centers, and an inline edit must freeze the window only while its
  editor is actually in the DOM (a leaked session must not blank the grid — regression
  test in grid_virtualization.test.ts).

The default was raised 500 → 5000 on 2026-08-08 on the strength of keyset page turns,
the count cache, and virtualization; the remaining per-page cost is SQL + transport
(~548k rows/s native marshal), with the per-page inline-cell byte budget clipping
oversized cells on wide tables as the designed graceful path. Re-measure before raising
it again.

Re-measure the full-render curve if cell rendering, highlighting, or the transport
changes. A regression here is felt on every page turn of the small-page path.

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
4. The release ships on a `v*` tag, not on merge. `release.yml` builds all five platform
   VSIX files plus the WASM-only universal in one run and uploads all six to the GitHub
   Release.
5. Open VSX is published separately by `scripts/publish-openvsx.mjs`. It validates all six
   GitHub assets, publishes platform packages with `ovsx --target`, publishes universal,
   and SHA-256-compares every served target with its GitHub release asset.
   `--verify-only <version>` audits all six published variants; `--dry-run` rehearses.
6. The Microsoft Marketplace is published by `scripts/publish-marketplace.mjs`, using the
   PAT from macOS Keychain service `vsce.k`. Its `--dry-run` validates all six assets
   without reading the PAT or publishing. If the script cannot be used, the Microsoft web
   portal remains the manual fallback: drag **all six VSIX files** into the same release.
7. All third-party GitHub Actions pinned to full commit SHAs, and each pin resolves to the
   tag its comment claims.
8. After publishing, install the released artifact from the Marketplace **and** Open VSX in
   a clean profile and smoke-test it. The thing users get is not the thing you built
   locally. **[unverified]** as a routine step.

---

## 23. Sign-off

Do not tag until each line is satisfied or **explicitly documented with a reason**.

- [ ] Clean tree; build and type-check pass; generated artifacts rebuilt and committed
- [ ] All six `.vsix` contents inspected; per-package native/browser gates pass
- [ ] Full unit suite green **twice consecutively**
- [ ] Native real-binary smoke lane green
- [ ] Large-cell lane green, or documented as not applicable
- [ ] Desktop + native: editor verified **by viewType**; edit/save/undo/revert; export
- [ ] Appendix C: all 161 current action IDs have per-environment results and evidence
- [ ] Final candidate VSIX hashes, actual runtime versions, and live backend selection recorded
- [ ] Real computer-use/human actions cover native and WASM; automated results recorded separately
- [ ] Full Hex, video playback/seek, large Unicode preview, and replacement regressions rerun
- [ ] Cmd/Ctrl-click, Shift-drag, fullscreen, and size-limit retry have explicit current results
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
- **Open Full Content ignored the Hex tab.** The selected view was omitted from the host
  request; the PDF shortcut also took the content-download route while Hex was selected.
- **Video preview failed for valid media.** Virtual cell files reported size zero, causing
  the host's media range loader to calculate an invalid end offset. Playing the same MP4
  directly in the same host distinguished the provider defect from a codec limitation.
- **Large Unicode text froze the webview.** Only long individual lines were split into
  layout blocks. Hundreds of thousands of short lines still reached one large text node.
  The real UI pass exposed a delayed stall that bounded transport tests did not catch.

## Appendix B: known coverage gaps

Re-evaluate these per candidate and record results. Historical gaps do not become passes
because a related automated test is green. The 2026-09-06 real-session pass covered
157 of 161 actions; Appendix C records the four incomplete cases and requires fresh results.

- **Platforms**: only macOS-arm64 is routinely exercised. Windows, Linux (both arches),
  musl/Alpine and the WASM fallback path are untested per release.
- **Remote development**: Remote-SSH, Dev Containers, WSL, Codespaces.
- **Real `vscode.dev` / `github.dev`**: `@vscode/test-web` is close but not identical.
- **VS Code forks**: Cursor and Windsurf install from Open VSX and now receive a CSP for
  the first time; never launched there.
- **Minimum supported VS Code version**: host integration passed on actual 1.110.0 on
  2026-09-06; the full computer-use pass ran on 1.136.1. Full UI coverage on the minimum
  remains a separate requirement.
- **Localization**: 13 locales ship; none are exercised.
- **Accessibility**: sidebar/grid keys and modal focus were exercised on 2026-09-06.
  Screen-reader behavior, high-contrast themes, and modifier-based mouse selection still
  need their own results.
- **Media previews**: WAV, MP4 playback/seek, PDF, and complete Hex were exercised on
  2026-09-06. Other advertised formats need separate results; fullscreen was host-disabled.
- **The published artifact**: Marketplace and Open VSX installs are not smoke-tested
  post-release.
- **WASM performance**: no tracked baseline exists; only the native backend is benchmarked.
- **Concurrency**: multiple databases and duplicate editor groups were exercised on
  2026-09-06. External writes and replacement during active operations need separate results.
- **Gatekeeper**: binaries are ad-hoc signed, not notarized; first-run behaviour on a clean
  macOS machine is unverified.

---

## Appendix C: full real-session pass

This is the reusable 161-action checklist from the 2026-09-06 computer-use QA session.
Run it against each release candidate. Keep the IDs stable; compare the current command
manifest, menus, toolbars, context menus, settings, and dialogs with this list before
starting, and add IDs for newly exposed actions. Do not silently remove an action because
a control was hard to reach.

### Prepare the candidate and evidence

1. Finish source changes, run the build, and package the candidate. Record commit, dirty
   diff if any, VSIX filename, SHA-256, byte size, target platform, and build/test logs.
   Release sign-off requires the final clean candidate from §1.
2. Install the actual VSIX in an isolated QA user-data and extension directory. Verify
   its installed runtime, viewer, and native artifact hashes against the archive. Do not
   edit generated bundles or installed code to get a test to pass.
3. Run the full applicable checklist on desktop native and desktop WASM. Repeat relevant
   UI checks in VS Code Web and the standalone demo, with explicit N/A for desktop-only
   controls. Cover the minimum supported and current supported VS Code versions and
   record the OS/architecture coverage required by §19. One platform's success cannot
   clear another platform's cell.
4. Verify the actual application version and active engine from the connection's live
   output log. Use a natives-free universal VSIX for WASM. Separate extension directories
   prevent one profile's installation from changing another profile's new connections.
5. Use disposable fixture copies and independent database/file readers. Record expected
   data before mutations. A success toast or a matching visible cell alone is insufficient
   for save, import, export, replacement, undo/redo, or schema operations.
6. Drive actual visible controls with computer use or a human. Include native file dialogs,
   the command palette, Explorer, clipboard paste into a real editor, keyboard gestures,
   and media controls. API tests and scripted DOM events belong in separate automated
   evidence. Arrange a human pass for gestures the automation cannot perform.
7. Copy this checklist into a durable release evidence directory. Give every ID separate
   results for each applicable backend/platform/version and each named subcase. Preserve
   screenshots or recordings, concise action logs, exported-byte checks, test logs, and
   package hashes together. Do not make the release record depend on disposable
   `.tmp/cua-qa` files or a chat transcript.
8. Use PASS, FAIL, PARTIAL, BLOCKED, or N/A. PASS requires every named subcase for that
   environment. Record reason, evidence, owner, and release disposition for the other
   states. Untested or unavailable actions never count as passed. List totals by
   environment and category, and reconcile them with the inventory.
9. After any fix, rebuild/repackage/reinstall and repeat the affected actions and required
   automated regressions. State which actions ran before and after that change. Before
   release, complete any remaining final-candidate checks; do not attribute an entire
   earlier pass to a new package hash.

Release result row template:

| ID / subcase | VSIX SHA-256 | OS / arch | Actual VS Code | Actual engine / surface | Input method | Result | Evidence / observed values | Gap owner / disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C24 / full-video seek | | | | | computer use or human | | | |

### Fixture set

Start with `createFixtures(directory)` in `tests/gui/fixtures.mjs`; make a fresh copy
for each independent run. Extend only those disposable fixtures for the following cases.

| Fixture | Required contents or property |
| --- | --- |
| Primary and second databases | Distinguishable tables/values; enough rows for multiple pages; defaults, generated columns, ordinary and composite keys, WITHOUT ROWID, quoted/Unicode identifiers, views, indexes, INSTEAD OF triggers |
| Data-integrity rows | Exact positive/negative int64 boundaries, REAL, SQL NULL, empty TEXT, embedded NUL, nested JSON with nulls/arrays, malformed TEXT, and the identifier cases from §10 |
| Wide tables | At least 14 columns for horizontal navigation; at least 50 columns at page sizes 5000 and 10000 for inline-value/transport checks |
| Dates | Known epoch and ISO values whose expected Raw/Local/ISO/Relative displays can be calculated |
| Media | Known-good files for every advertised format; below/above inline thresholds; matching standalone originals; deliberately malformed media; ordinary and oversized PDFs |
| Large text | 400,000 repetitions of `é😀` followed by a newline, exactly 2,800,000 UTF-8 bytes, plus a single long Unicode line, a BLOB, and valid UTF-16 TEXT |
| Replacement | A 5 MiB source file with bytes different from the original cell; exact original/replacement lengths and SHA-256 recorded |
| Import/export | CSV/JSON with matching and different column names, ignored fields, defaults, NULL/empty values, quotes/newlines/Unicode; a constraint-conflict source; at least 100,000 rows for visible cancellation |
| Persistence | OS-read-only file; active WAL with an uncheckpointed committed row; empty/views-only databases; corrupt/truncated/non-database files; a valid database with an arbitrary filename suffix |
| Isolation | Separate workspaces, user-data directories, extension directories, and destinations; no edits to a user's working database or application-level preferences |

The repository MP4 `media/edit_cells_add_delete_rows.mp4` was a useful reference on
2026-09-06: 946,090 bytes, SHA-256
`4884d196ffc0c4cd01daef0a48de2b214c2ba0211e105d0cdee6d13e633cb3fb`.
Verify the fixture hash again if that file changes. An audio sample long enough to seek
and a 51.9 MB CSV exposed controls that tiny fixtures completed too quickly to test.

### Cases carried from 2026-09-06

These are required retests, not permanent exemptions.

| ID | Previous outcome | Required next result |
| --- | --- | --- |
| L15 | PARTIAL: small limit rejected correctly, but changing it to 0 needed Reload Window because VS Code cached the failed open | Test immediate retry and reload separately on each runtime; record a host limitation explicitly if it persists |
| G11 | PARTIAL: keyboard range passed; held Cmd/Ctrl-click was unavailable through that CUA API | Perform actual non-adjacent Cmd/Ctrl-click and Shift-click, with human input if needed |
| C21 | BLOCKED: the API could not hold Shift during an Explorer drag; picker replacement passed | Perform real Shift-drag and verify stored bytes and undo/redo |
| C24 | PARTIAL: play/pause/seek passed; fullscreen was disabled in both embedded players | Exercise fullscreen in the tested host; record unavailable host capability separately from successful playback |

The historical total was 157 PASS, 3 PARTIAL, and 1 BLOCKED. Most actions ran before the
last large-text rendering fix; affected media/hex/text/cancellation paths were repeated
afterward. Those totals describe that session only and are not a final-candidate sign-off.

### Action inventory

| Category | IDs | Count |
| --- | --- | ---: |
| SQL commands | Q01-Q14 | 14 |
| Database lifecycle | L01-L16 | 16 |
| Schema | S01-S25 | 25 |
| Grid | G01-G41 | 41 |
| Cells and media | C01-C28 | 28 |
| Export | X01-X11 | 11 |
| Import | I01-I10 | 10 |
| Settings and dialogs | T01-T16 | 16 |
| Total | | 161 |

Use the actual platform shortcut: Cmd on macOS where the control advertises it, Ctrl on
Windows/Linux. Combined entries require separate subcase results; for example, a working
video Play button does not clear seek or fullscreen.

### SQL commands

- [ ] `Q01` Import CSV or JSON. The command starts the import flow for the intended database; complete the I01-I10 cases for CSV and JSON.
- [ ] `Q02` Refresh Database. Refresh reads current schema/data. Exercise any history-reset confirmation and verify both its cancel and continue paths.
- [ ] `Q03` New SQL Query. A SQL editor opens with the originating database selected.
- [ ] `Q04` Choose Query Database. Choose either of two open databases, execute distinguishable queries, and confirm the selected database supplies the results.
- [ ] `Q05` Run Query, whole editor or selection. Run a whole read-query document, then select valid SQL beside deliberately invalid unselected text. Only the selection executes.
- [ ] `Q06` Enter positional parameters or cancel parameter prompt. Bind each positional parameter, verify the result, then cancel a fresh prompt. Cancellation runs no query and parameter values stay out of history.
- [ ] `Q07` Explain Query Plan. A valid query produces a plan for the bound database; invalid SQL reports an error and leaves the connection usable.
- [ ] `Q08` Refresh Query Completions. Refresh after a schema change and invoke actual suggestions. Current table/column names appear and inserted identifiers are correctly quoted.
- [ ] `Q09` Query History, select previous SQL. Choose a prior query and verify the reopened SQL and database choice.
- [ ] `Q10` Clear Query History. Clear history, reopen the picker, and verify that prior entries are absent.
- [ ] `Q11` Export Query Results. Export a result through the native destination dialog; independently check headers, values, encoding, and the requested row scope.
- [ ] `Q12` Cancel running SQL or plan in progress notification. Cancel while the progress notification is still running, separately for SQL and plan work. Confirm cancellation and execute a short follow-up query.
- [ ] `Q13` Read/copy bounded result document. Use a result beyond the display cap. Verify its truncation notice, copy the displayed rows, and confirm the UI stays responsive.
- [ ] `Q14` Save/open ordinary SQL file in VS Code. Save the SQL document, close it, reopen it from Explorer, bind a database if prompted, and run it successfully.

### Database lifecycle

- [ ] `L01` Open associated database in default SQLite Explorer editor. Open every contributed filename extension and verify the SQLite custom editor, schema, and clean initial state.
- [ ] `L02` Reopen With SQLite Explorer Optional for arbitrary filename. Open a valid database with an arbitrary suffix through Reopen Editor With and choose SQLite Explorer Optional.
- [ ] `L03` Open same DB in two editor groups. Edit with the same database visible in two groups. Both reflect the same document and share undo/redo without duplicate connections.
- [ ] `L04` Open two distinct databases and switch tabs. Use distinguishable contents in two databases. Schema, selection, query binding, edits, and undo stay with the correct database.
- [ ] `L05` Close database editor, close final reference. Close one duplicate editor and continue using the other; close the final reference and reopen without stale state or a leftover lock.
- [ ] `L06` Save / Ctrl+S. Save through the menu and keyboard shortcut, reopen, and independently check persisted bytes/rows and the dirty marker.
- [ ] `L07` Save As to new/existing DB path. Save As to a new path, cancel an overwrite, then confirm an overwrite of another disposable database. Reopen each successful destination.
- [ ] `L08` Revert File. On WASM with deferred commit, mix edits, inserts, and deletes, then Revert. UI, disk, dirty state, and undo history return to the saved state.
- [ ] `L09` Hot-exit backup and restore. In an isolated user-data directory, test dirty window reload and actual close/reopen separately. Restore data and undo/redo; disk changes only when the selected backend/commit mode permits.
- [ ] `L10` Undo. Undo cell edits, batch updates, row insert/delete, schema changes, replacement, and import, including after table/page changes.
- [ ] `L11` Redo. Redo those operations and compare values, types, schema, selection identity, and persistence with the original successful operation.
- [ ] `L12` Reload button. Use the visible reload button and verify refreshed data, correct object selection, and no stale modal result.
- [ ] `L13` Open with native backend or automatic WASM fallback. Open with the native target, then with a natives-free universal installation. Confirm each live engine log and its actual persistence behavior.
- [ ] `L14` Open OS-read-only/WAL-bearing DB and see disabled edits. Test OS-read-only files and a WASM database with committed data still in WAL. Mutation controls are disabled; checkpoint/close/reopen exposes all committed rows safely.
- [ ] `L15` Refuse configured maximum file size, then allow at 0. On WASM, reject a fixture above a small configured limit, set the limit to 0, and retry. Record immediate retry and Reload Window recovery separately.
- [ ] `L16` Hide/show editor, retain selected object/filter/scroll/settings. Hide and show a database editor after setting a filter, sort, page size, date mode, pins, and scroll. The correct database restores that state.

### Schema

- [ ] `S01` Select a table. The clicked table owns the displayed headers, rows, count, and mutation controls.
- [ ] `S02` Select a view. The selected view displays its rows and appropriate read-only/editable controls.
- [ ] `S03` Expand/collapse Tables. Collapse and expand Tables without losing selection or entries.
- [ ] `S04` Expand/collapse Views. Collapse and expand Views without losing selection or entries.
- [ ] `S05` Expand/collapse Indexes. Collapse and expand Indexes without changing their ownership or counts.
- [ ] `S06` Filter table/view/index names. Filter for a table, view, and index separately; clearing the term restores the complete list.
- [ ] `S07` Resize sidebar by drag. Drag the sidebar divider. Width changes, controls remain usable, and the width survives hide/show.
- [ ] `S08` Resize sidebar by keyboard. Focus the sidebar divider and resize with the keyboard; verify visible movement and focus.
- [ ] `S09` Open Create Table. The Create Table dialog opens with reachable name and column controls; cancelling leaves no table.
- [ ] `S10` Add a column definition. Add several definitions and enter distinct names, types, defaults, and key settings.
- [ ] `S11` Remove a column definition. Remove a middle definition and verify the remaining fields and order still map to the intended columns.
- [ ] `S12` Submit Create Table. Create ordinary, composite-primary-key, and WITHOUT ROWID tables. Check actual schema and use the new tables.
- [ ] `S13` Open Add Column. The Add Column dialog targets the selected table; cancel leaves its schema unchanged.
- [ ] `S14` Submit Add Column with type/default. Add columns with type/default combinations, then verify schema, existing-row values, and undo/redo.
- [ ] `S15` Delete selected column(s), confirm dependent indexes. Select columns with dependent indexes. Cancel the dependency prompt, then repeat and confirm. Undo restores column order, data, and indexes.
- [ ] `S16` Open Create View. The Create View editor opens with an editable name/definition and no mutation before confirmation.
- [ ] `S17` Open Edit View. Edit View loads the current definition of the selected view.
- [ ] `S18` Validate view draft. Validate valid and invalid drafts; show the correct result without creating or modifying the view.
- [ ] `S19` Preview view draft. Preview a draft and verify returned columns/rows without persisting the draft.
- [ ] `S20` Toggle Preserve INSTEAD OF triggers. Exercise both preservation choices on a view with an INSTEAD OF trigger and independently check the resulting triggers.
- [ ] `S21` Create View / Save View draft. Create and update a view, then query it and verify its stored definition.
- [ ] `S22` Edit View in VS Code. Edit the view in a VS Code text editor, save, return to the viewer, and verify the definition and rows.
- [ ] `S23` Reload Latest view definition after conflict. Change the same disposable view externally while a draft is open. The conflict is explicit; Reload Latest replaces the stale draft with the current definition.
- [ ] `S24` Drop View. Cancel Drop View, then confirm it. Check the view and associated triggers are removed as indicated.
- [ ] `S25` Read index names/table ownership. Inspect index names and owning tables, including after a dependent-column change.

### Grid

- [ ] `G01` Open Add Row. Add Row opens for the selected table with the correct editable/default/generated fields.
- [ ] `G02` Choose explicit Empty string in Add Row. Use the explicit empty-string control; the stored value has TEXT type and zero length.
- [ ] `G03` Choose explicit SQL NULL in Add Row. Use the explicit NULL control; the stored value is SQL NULL, distinct from empty text.
- [ ] `G04` Submit Add Row. Insert rows using explicit values and defaults, including composite keys. Verify the new row identity and undo/redo.
- [ ] `G05` Open Delete for selected rows. Select rows and open Delete. The confirmation describes the intended selection; cancelling preserves all rows.
- [ ] `G06` Confirm Delete rows. Confirm deletion of selected rows only, then undo and redo while checking exact contents.
- [ ] `G07` Select a cell. Click a cell and verify focus and the batch-update target.
- [ ] `G08` Select a row. Select a row using its gutter control; the intended row is highlighted and batch/copy/delete targets match.
- [ ] `G09` Select a column. Select a column through its header control and verify the selected cells and mutation target.
- [ ] `G10` Select all current-page rows or Ctrl/Cmd+A. Use the page select-all control and keyboard shortcut separately. Verify the visible page scope and large-selection confirmation where applicable.
- [ ] `G11` Range-select with Shift and multi-select with Ctrl/Cmd. Perform real Shift-click range selection and non-adjacent Cmd/Ctrl-click, plus keyboard range selection. Check the exact selected cells.
- [ ] `G12` Clear selection with Escape/click-away. Clear selection with Escape and click-away separately; subsequent actions must not use old targets.
- [ ] `G13` Move focus with arrows and select with Space. Move with arrows and select with Space, including cells entering the virtualized viewport.
- [ ] `G14` Pin/unpin column. Pin and unpin a column, scroll horizontally, and verify data/header alignment.
- [ ] `G15` Pin/unpin row. Pin and unpin a row, scroll vertically, and verify identity and values remain correct.
- [ ] `G16` Resize column by drag. Drag a column divider across narrow and wide widths; adjacent columns and scrolling remain usable.
- [ ] `G17` Resize column by keyboard. Focus the column divider and resize with the keyboard; verify width and focus.
- [ ] `G18` Expand/collapse batch-update section. Collapse and reopen batch update; the controls describe the current selection.
- [ ] `G19` Enter batch replacement value. Enter a replacement for multiple selected cells and verify only the intended column targets receive it.
- [ ] `G20` Set batch NULL. Apply batch NULL, check SQL storage classes, then undo/redo.
- [ ] `G21` Set batch Empty. Apply batch Empty, verify zero-length TEXT remains distinct from NULL, then undo/redo.
- [ ] `G22` Toggle batch JSON Patch. Apply a JSON merge patch with nested values and deletion, preserving unrelated keys. Verify full-value editing still preserves literal JSON nulls.
- [ ] `G23` Apply batch Changes. Apply a mixed batch and compare all targeted rows. A rejected batch must not leave a partial update.
- [ ] `G24` Copy selected cells with Ctrl/Cmd+C. Copy a selected cell rectangle and paste into a real text editor. Check tabs, newlines, Unicode, and ordering.
- [ ] `G25` Copy selected rows with Ctrl/Cmd+C. Copy selected rows and paste into a real text editor; verify row scope, headers where supplied, and values.
- [ ] `G26` Smart Delete with Ctrl/Cmd+Delete/Backspace. Exercise smart delete for cells, rows, and columns separately, including confirmations and undo/redo.
- [ ] `G27` Type global filter. Enter a global search term and verify the typed value and expected matching columns.
- [ ] `G28` Apply global filter / Enter. Apply through the search control and Enter separately; rows/count/highlights reflect the term.
- [ ] `G29` Clear global filter. Clear the global term; rows, count, and page selection recover correctly.
- [ ] `G30` Type per-column filter. Enter a per-column term and combine it with another column/global filter.
- [ ] `G31` Apply column filter. Apply the column filter and verify only the intended column is searched.
- [ ] `G32` Clear column filter. Clear one column filter while preserving other active terms, then clear all.
- [ ] `G33` Next/previous text match with Enter/Shift+Enter. Navigate next and previous matches with Enter and Shift+Enter, including matches outside the currently rendered rows.
- [ ] `G34` Sort ascending/descending by header. Cycle ascending, descending, and cleared sort. Verify stable identity ordering, including duplicate sort values.
- [ ] `G35` First page. Navigate to the first page from a later page and verify its first/last row identities.
- [ ] `G36` Previous page. Navigate to the previous page without skipping or duplicating rows.
- [ ] `G37` Next page. Navigate to the next page without skipping or duplicating rows.
- [ ] `G38` Last page. Navigate to the final partial page and verify its count and boundary buttons.
- [ ] `G39` Change rows per page. Exercise every offered page size, including 5000/10000 on a wide fixture. Ordinary short cells remain inline.
- [ ] `G40` Change date format. Use actual epoch and ISO timestamps. Verify Raw, Local, ISO, and Relative output without changing stored values.
- [ ] `G41` Scroll large page vertically/horizontally. Scroll a large page vertically and a wide table horizontally. Test pointer scrolling and keyboard reveal, keeping headers/cells aligned.

### Cells and media

- [ ] `C01` Double-click cell for configured inline/modal/VS Code behavior. Choose inline, modal, and VS Code behaviors in turn; actual double-click follows the selected setting.
- [ ] `C02` Save inline cell with Enter. Edit and press Enter. Exactly one save occurs and the stored value matches.
- [ ] `C03` Save inline cell with Tab/Shift+Tab and move. Edit and save using Tab and Shift+Tab separately; focus moves in the expected direction without losing the edit.
- [ ] `C04` Save inline cell by blur. Edit and click another control; blur saves once and does not overwrite a different cell.
- [ ] `C05` Cancel inline edit with Escape. Change an inline draft and press Escape; the original value remains.
- [ ] `C06` Expand cell to detail preview. Use the cell expand control, verify complete/bounded content as indicated, and close back to the grid.
- [ ] `C07` Format JSON in cell preview. Format valid JSON and verify its data is unchanged; malformed JSON reports an error without corrupting the draft.
- [ ] `C08` Compact JSON in cell preview. Compact formatted JSON and verify equivalent data.
- [ ] `C09` Toggle word wrap. Toggle wrap on long text; only presentation changes and horizontal/vertical navigation remains usable.
- [ ] `C10` Set Empty in cell preview. Set Empty, save, and independently verify zero-length TEXT.
- [ ] `C11` Set NULL in cell preview. Set NULL, save, and independently verify SQL NULL.
- [ ] `C12` Save preview with button/Ctrl+Enter. Save with the button and Ctrl+Enter separately; compare values and check undo/redo.
- [ ] `C13` Edit cell in VS Code. Open a cell in VS Code, edit/save, return to the grid, and verify persisted data and history.
- [ ] `C14` Preview modal text Tab indentation and Escape then Tab focus exit. Tab inserts indentation in the text editor; Escape then Tab exits editing focus to the next modal control.
- [ ] `C15` Open BLOB inspector Preview tab. Open Preview for text, JSON, BLOB, and recognized media. Labels, type, size, and available controls match the value.
- [ ] `C16` Open BLOB inspector Hex tab. Select Hex for BLOB/TEXT/video/PDF. Check stored bytes and the Open Full Hex label; switching back restores Preview behavior.
- [ ] `C17` Load more bounded TEXT/BLOB bytes. Load successive chunks of large BLOB, long-line TEXT, and many-short-line Unicode TEXT. Navigate first/last/adjacent text pages and valid/invalid page-number input. Copy selected text across internal chunks after scrolling. Bytes stay exact, each selectable page stays bounded, and the window stays responsive afterward.
- [ ] `C18` Open Full Content for oversized cell. Open full raw content from Preview and full read-only hex from Hex, below/above inline limits. Compare all output bytes; verify hex quota and cancellation through supporting regressions.
- [ ] `C19` Replace inspected BLOB/TEXT from file. Replace from a real file picker with a 5 MiB fixture. Verify stored bytes, undo/redo, and picker cancellation.
- [ ] `C20` Download inspected BLOB/TEXT. Download text/BLOB to a chosen path and compare exact bytes; cancelling the destination dialog leaves no new file.
- [ ] `C21` Drag/drop file onto BLOB cell. Use a real Shift-drag from VS Code Explorer onto the intended cell. Verify replacement bytes, undo/redo, rejection/cancellation, and no write to adjacent cells.
- [ ] `C22` View image preview. Open every advertised image format and verify the expected image at ordinary and bounded sizes.
- [ ] `C23` Play/pause/seek audio preview. Play, pause, and seek each advertised audio format; check elapsed time and release the preview on close.
- [ ] `C24` Play/pause/seek/fullscreen video preview. Play, pause, seek, and request fullscreen in the inspector and full-video viewer. Compare with direct playback of the same file in the same host.
- [ ] `C25` Download normal PDF to view. Open/download a normal PDF from Preview and compare the downloaded bytes. Hex still opens a hex document.
- [ ] `C26` View oversized PDF preview. Open an oversized PDF preview, then its complete download. Verify preview bounds and exact full bytes.
- [ ] `C27` Use View bounded Hex preview after media failure. Open malformed media and use View bounded Hex preview. Show the original bytes without a stuck spinner or decoder crash.
- [ ] `C28` Inspect malformed database TEXT as raw bytes. Inspect malformed TEXT as raw Hex, including embedded NUL and invalid UTF-8. Valid UTF-16 TEXT keeps its stored bytes in Hex.

### Export

- [ ] `X01` Open Export Table modal. Export opens for the selected table/view with the correct available columns.
- [ ] `X02` Choose CSV. Export CSV and check quotes, delimiters, Unicode, embedded newlines, and row scope.
- [ ] `X03` Choose JSON. Export JSON and check rows, keys, NULL/empty distinction, and exact large integers as represented by the exporter.
- [ ] `X04` Choose SQL INSERT. Export SQL INSERTs and import them into a fresh disposable database; compare data and storage classes.
- [ ] `X05` Choose Excel. Verify Excel export is UTF-8 CSV with BOM, uses its advertised filename, and preserves quoting and rows.
- [ ] `X06` Select/deselect export columns. Deselect/reselect columns and verify exported order and omission.
- [ ] `X07` Toggle Include Headers. Toggle Include Headers and inspect both outputs.
- [ ] `X08` Toggle Include Table Name. Toggle Include Table Name and verify the actual table name or documented generic placeholder in SQL.
- [ ] `X09` Export selected rows or full table/view when none selected. Export selected rows, then a full table/view with no selection. Check the exact intended scope with filters active and cleared.
- [ ] `X10` Submit Export and choose destination. Choose a new destination, cancel a dialog, and exercise overwrite confirmation on a disposable file.
- [ ] `X11` Cancel export progress. Cancel a genuinely running large export; no truncated destination or adjacent temporary file remains, and a later export succeeds.

### Import

- [ ] `I01` Choose import destination database. Choose between two open destination databases and verify the importer binds to the chosen one.
- [ ] `I02` Choose existing destination table. Choose an existing destination table and verify its columns/defaults are shown.
- [ ] `I03` Choose CSV/JSON source file. Select CSV and JSON files through real file dialogs; verify both parse correctly and cancelled picks do not mutate.
- [ ] `I04` Use matching column names. Use matching names and verify the inferred source-to-target mapping.
- [ ] `I05` Map columns manually. Map differently named fields manually and independently check inserted values.
- [ ] `I06` Skip source column. Skip a source field; destination defaults and omitted fields behave as declared.
- [ ] `I07` Read five-row import preview. Inspect the five-row preview, including Unicode, embedded newlines, NULL, empty text, and a longer source file.
- [ ] `I08` Confirm Import / cancel confirmation. Cancel the final confirmation and verify zero writes; then repeat, confirm, and verify the completed import.
- [ ] `I09` Cancel import progress. Cancel during an active large import after visible progress. Independently verify the transaction left no partial rows, then confirm the connection works.
- [ ] `I10` Undo/redo completed import. Undo the completed import as one operation, then redo and compare the entire imported batch.

### Settings and dialogs

- [ ] `T01` Open Configuration modal. Configuration opens, reflects the active connection, and closes back to a usable grid.
- [ ] `T02` Toggle Auto-Commit Changes. On WASM, toggle auto-commit and verify disk before/after Save. Native shows immediate persistence and an explained disabled/on control.
- [ ] `T03` Change Double Click Behavior. Change double-click behavior and exercise each resulting edit path.
- [ ] `T04` Change Journal Mode. Change journal mode to WAL and back in an isolated fixture; verify the actual mode and valid reopen behavior.
- [ ] `T05` Change Foreign Keys. Toggle foreign keys and verify actual enforcement, then restore the initial setting.
- [ ] `T06` Change Synchronous. Change synchronous mode and read back the actual setting.
- [ ] `T07` Change Locking Mode. Change locking mode, verify readback, and restore it before other fixture connections.
- [ ] `T08` Change Temp Store. Change temporary-store mode and verify readback.
- [ ] `T09` Change Auto Vacuum. Change auto-vacuum and compare the actual mode. Existing-database prerequisites must not be mistaken for successful application of the requested value.
- [ ] `T10` Change Cache Size. Edit cache size using the actual numeric control, including a negative value; blur and reopen to verify it was accepted intact.
- [ ] `T11` Close/cancel each modal using its Close or Cancel control. Use Close and Cancel for every modal family, including row/column/table/view/export/configuration/cell/inspector/import confirmations. No cancelled action writes data.
- [ ] `T12` Close modal with Escape or backdrop click. Use Escape and backdrop clicks where supported; confirm closure and restored focus without unintended application.
- [ ] `T13` Tab/Shift+Tab through modal controls. Tab and Shift+Tab through every modal family, including wrapping, visible focus, and the embedded editor's Escape-then-Tab exit.
- [ ] `T14` Cancel large-selection/dependency/large-edit confirmation. Cancel large-selection, dependency, and large-edit confirmations separately; verify the corresponding operation did not run.
- [ ] `T15` Recover from worker/RPC error or timeout. Trigger an ordinary invalid-query error and a bounded timeout/cancellation. Each is explicit, and the next short query/edit succeeds.
- [ ] `T16` Reload/switch table/close during pending modal read or mutation. During visible pending modal work, refresh or close. Switch table/database when permitted and verify no stale result, stuck overlay, partial mutation, or lost recovery.
