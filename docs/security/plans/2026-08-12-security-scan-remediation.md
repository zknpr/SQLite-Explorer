# Security Scan Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Neutralize direct-open spreadsheet formulas across every CSV path, preserve caller order for heterogeneous WASM batch inserts, and consume only exact verified sql.js and txiki.js security artifacts.

**Architecture:** Centralize bounded and streamed CSV prefix inspection in `src/core/export-encoding.ts`; cache insert statements by row shape while executing rows in input order; hard-pin upstream workflow branch, commit, run, filenames, and hashes before regenerating downstream bundles.

**Tech Stack:** TypeScript, Node.js test runner, sql.js/WASM, generated web worker bundle, GitHub Actions artifacts, txiki.js native worker.

## Global Constraints

- Work only in `/Users/zero/dev/.codex-worktrees/SQLite-Explorer/security-scan-remediation` on `agent/security-scan-remediation`.
- Follow `CLAUDE.md`, `SECURITY.md`, and `CONTRIBUTING.md`; target the downstream PR at `dev`.
- Preserve unrelated ignored setup outputs and never edit generated bundles directly. Rebuild them only with `node scripts/build.mjs`.
- Apply formula neutralization only to SQLite TEXT/string cells and column headers. Negative INTEGER and REAL values remain numeric; NULL, BLOB, and invalid-TEXT envelopes remain unchanged.
- A dangerous string is one whose first code point after zero or more Unicode `White_Space`, `Cc`, or `Cf` code points is `=`, `+`, `-`, `@`, `＝`, `＋`, `－`, or `＠`. Leading tab, CR, and LF are included by that rule.
- Prefix exactly one apostrophe and force double quoting for every dangerous field. Escape embedded double quotes by doubling them. Also quote ordinary fields containing comma, quote, LF, or CR.
- The emitted direct-open CSV boundary is protected. Do not claim universal safety after a spreadsheet saves and reopens the file.
- Streamed large TEXT may use its existing inspection pass but may not allocate a second whole-cell/export buffer or add an IPC round trip.
- `insertRowBatch()` must execute rows in original caller order while retaining one prepared statement per distinct ordered column/placeholder shape. Free every cached statement on success and failure; rollback and rethrow the original error.
- Do not change code for the tag-workflow finding or the reported action-SHA typo. Document their evidence-backed no-change dispositions in the PR.
- Consume upstream artifacts only after both upstream branches pass local verification, are pushed, and have normal ready-for-review PRs. Pin exact branch, 40-character commit, workflow run, filenames, and SHA-256 values.
- A repeatable native IPC median or p95 regression greater than 5 percent requires optimization or explicit user approval.
- Complete local verification before push. Open a normal ready-for-review PR, never a draft PR.

---

### Task 1: Centralize formula-safe CSV text encoding

**Files:**

- Modify: `src/core/export-encoding.ts:1-125`
- Modify: `src/tableExportStreaming.ts:1420-1495,1570-1605`
- Modify: `src/tableExporter.ts:750-785`
- Modify: `tests/unit/tableExporter.test.ts`
- Modify: `tests/unit/web_demo_worker.test.ts`

- [ ] **Step 1: Add bounded and incremental prefix inspection tests**

  Import the new helpers from `src/core/export-encoding.ts` and table exporters. Cover every ASCII and full-width operator; space, tab, CR, LF, NUL, BOM, zero-width format characters, and mixed ignorable prefixes; embedded comma/quote/CR/LF; ordinary text; empty/all-ignorable text; and a malicious header.

  Required emitted examples include:

  ```text
  =1+1                 -> "'=1+1"
   =1+1                -> "' =1+1"
  BOM + @SUM(A1:A2)    -> "'BOM@SUM(A1:A2)"
  ＋1                   -> "'＋1"
  normal               -> normal
  ```

  In the BOM example, the word `BOM` denotes the actual U+FEFF code point. Parse emitted lines with a minimal RFC-compatible CSV parser in the test and assert the parsed first cell begins with apostrophe, never a formula operator after ignorable prefixes.

- [ ] **Step 2: Record RED on current authored code**

  ```bash
  node --import tsx --test tests/unit/tableExporter.test.ts
  ```

  Expected before production changes: a formula-leading TEXT cell or header is emitted without the apostrophe. Record that assertion as RED evidence.

- [ ] **Step 3: Add the shared inspection state**

  In `src/core/export-encoding.ts`, add a state object and chunk inspector equivalent to:

  ```ts
  export interface CsvTextInspection {
    dangerousPrefix: boolean;
    prefixOpen: boolean;
    needsQuotes: boolean;
  }

  const CSV_FORMULA_START = new Set(['=', '+', '-', '@', '＝', '＋', '－', '＠']);
  const CSV_IGNORABLE_PREFIX = /^(?:\p{White_Space}|\p{Cc}|\p{Cf})$/u;

  export function createCsvTextInspection(): CsvTextInspection {
    return { dangerousPrefix: false, prefixOpen: true, needsQuotes: false };
  }

  export function inspectCsvTextChunk(state: CsvTextInspection, text: string): void {
    if (text.includes(',') || text.includes('"') || text.includes('\n') || text.includes('\r')) {
      state.needsQuotes = true;
    }
    if (!state.prefixOpen) return;
    for (const codePoint of text) {
      if (CSV_FORMULA_START.has(codePoint)) {
        state.dangerousPrefix = true;
        state.needsQuotes = true;
        state.prefixOpen = false;
        return;
      }
      if (!CSV_IGNORABLE_PREFIX.test(codePoint)) {
        state.prefixOpen = false;
        return;
      }
    }
  }
  ```

  Add `encodeCsvExportText(text)` that inspects the complete bounded string, prefixes one apostrophe only when dangerous, and applies the shared forced/RFC quoting rule.

- [ ] **Step 4: Route bounded cells and legacy exports through the helper**

  `encodeCsvExportCell()` must call `encodeCsvExportText()` only for `storageClass === 'text'`. Return canonical INTEGER text, REAL text, NULL, BLOB, and invalid-TEXT envelopes through their existing branches.

  In `exportToCsv()`, encode headers with `encodeCsvExportText()`. Encode row values as follows: nullish to empty, `Uint8Array` to `[BLOB]`, JavaScript strings through `encodeCsvExportText()`, and numeric/bigint values through `String(value)` without neutralization.

- [ ] **Step 5: Apply the same state to streamed large TEXT**

  Replace the local `inspectCsvText()` quote-only flag with `CsvTextInspection`. Its existing decoded-text inspection pass calls `inspectCsvTextChunk()` for every chunk. During the write pass, emit opening quote, then apostrophe when dangerous, then escaped chunks, then closing quote. This preserves bounded memory and adds no IPC pass beyond the already-required representability/quoting inspection.

  Encode streaming headers with `encodeCsvExportText()` rather than the local legacy escaper.

- [ ] **Step 6: Run focused authored-source GREEN checks**

  ```bash
  node --import tsx --test tests/unit/tableExporter.test.ts
  ```

  Expected: CSV and Excel modes neutralize TEXT/header attacks, integer/real negatives remain unquoted numeric cells, and NULL/BLOB/invalid TEXT compatibility tests pass.

- [ ] **Step 7: Commit authored CSV changes and regressions**

  ```bash
  git add src/core/export-encoding.ts src/tableExportStreaming.ts src/tableExporter.ts tests/unit/tableExporter.test.ts
  git commit -m "fix(security): neutralize CSV formula cells"
  ```

---

### Task 2: Preserve heterogeneous batch insertion order

**Files:**

- Modify: `src/core/engine/wasm/WasmDatabaseEngine.ts:1944-2010`
- Modify: `tests/unit/sqlite_db.test.ts`

- [ ] **Step 1: Add an ordering-trigger regression**

  Open a fresh WASM engine. Create a target table, an audit table, and an `AFTER INSERT` trigger. Insert this alternating-shape sequence:

  ```ts
  [
    { a: 'first' },
    { b: 'second' },
    { a: 'third' }
  ]
  ```

  Assert target `rowid` order and trigger audit order are exactly `first, second, third`. The current grouped implementation must fail by observing `first, third, second`.

- [ ] **Step 2: Add controls for statement reuse and rollback**

  Insert same-shape rows and assert values stay ordered. Then perform a batch whose later row violates a `NOT NULL` or `UNIQUE` constraint; assert the promise rejects, no earlier row from that transaction persists, and a subsequent valid insert succeeds (indirectly proving cached statements were finalized).

- [ ] **Step 3: Record RED**

  ```bash
  node --import tsx --test tests/unit/sqlite_db.test.ts
  ```

  Expected before implementation: the alternating-shape order assertion fails.

- [ ] **Step 4: Replace grouped execution with an ordered statement cache**

  Keep the transaction and edit-size validation. Use:

  ```ts
  const statements = new Map<string, ReturnType<typeof this.instance.prepare>>();
  try {
    for (const row of rows) {
      const columns = Object.keys(row);
      const values = columns.map(column => row[column]);
      const placeholders = values.map(wasmBindPlaceholder);
      const key = `${columns.join('\0')}\0\0${placeholders.join('\0')}`;
      let statement = statements.get(key);
      if (!statement) {
        const sql = columns.length === 0
          ? `INSERT INTO ${escapedTable} DEFAULT VALUES`
          : `INSERT INTO ${escapedTable} (${columns.map(escapeIdentifier).join(', ')}) ` +
            `VALUES (${placeholders.join(', ')})`;
        statement = this.instance.prepare(sql);
        statements.set(key, statement);
      }
      if (columns.length === 0) statement.run();
      else statement.run(normalizeWasmBindParams(values));
    }
  } finally {
    for (const statement of statements.values()) statement.free();
  }
  ```

  Ensure `COMMIT` occurs only after statement finalization. On any prepare/run/free/commit failure, call the existing `safeRollback('insertRowBatch')` and rethrow explicitly. If statement cleanup and the primary database operation both fail, preserve both errors with `AggregateError` rather than silently replacing either failure.

- [ ] **Step 5: Run focused GREEN checks and commit**

  ```bash
  node --import tsx --test tests/unit/sqlite_db.test.ts
  git add src/core/engine/wasm/WasmDatabaseEngine.ts tests/unit/sqlite_db.test.ts
  git commit -m "fix: preserve batch insertion order"
  ```

---

### Task 3: Pin exact upstream workflow provenance

**Files:**

- Modify: `scripts/refresh-sqljs.mjs`
- Modify: `scripts/refresh-natives.mjs`
- Create: `tests/unit/artifact_refresh_policy.test.ts`

- [ ] **Step 1: Add fail-closed script tests before changing scripts**

  Execute each refresh script against temporary artifact directories and a temporary fake `gh` executable placed first on `PATH`. Assert rejection for wrong branch, wrong 40-character commit, wrong run ID, missing/extra expected filenames, and hash mismatch. Assert the happy path installs only the pinned files and preserves executable mode for native binaries. No test may contact GitHub.

- [ ] **Step 2: Record RED for sql.js provenance**

  ```bash
  node --import tsx --test tests/unit/artifact_refresh_policy.test.ts
  ```

  Expected before implementation: `refresh-sqljs.mjs` accepts a run without checking `headBranch` or `headSha`.

- [ ] **Step 3: Harden sql.js refresh metadata validation**

  Add immutable `SOURCE_BRANCH`, `SOURCE_COMMIT`, and `PINNED_RUN_ID` constants alongside the two SHA-256 values. Before downloading, run `gh run view` for that exact run and require `headBranch` and lowercase `headSha` to equal the pins. For `--from`, require explicit `--run`, `--branch`, and `--commit` arguments and reject any value differing from the pins. Reject duplicate candidate pairs instead of silently choosing one.

- [ ] **Step 4: Make txiki.js branch/commit pins exact**

  Replace the old `master` assumption with the exact `agent/v8-bounded-host-views` workflow branch and its final 40-character commit. Pin the exact artifact run. Apply the same duplicate/missing filename and local-source argument rules as sql.js. Keep all five hashes and executable modes mandatory.

- [ ] **Step 5: Populate pins from verified upstream runs**

  After both upstream PR branches have passed local gates and been pushed, use `gh run list`/`gh run view` to identify successful runs whose `headBranch` and `headSha` exactly match the reviewed branch heads. Download into temporary directories, enumerate filenames, compute SHA-256 with `shasum -a 256`, and write those observed values directly into the constants. Do not use artifacts from a moving default branch or a different commit.

- [ ] **Step 6: Run script policy tests and install artifacts**

  ```bash
  node --import tsx --test tests/unit/artifact_refresh_policy.test.ts
  node scripts/refresh-sqljs.mjs
  node scripts/refresh-natives.mjs
  ```

  Expected: both scripts re-query metadata, reject mismatches, verify every hash, and install exact copies into all documented destinations.

- [ ] **Step 7: Commit provenance scripts and binary inputs**

  Stage the scripts, tests, `vendor/sql.js`, `assets/sqlite3.wasm`, web-demo sql.js files, and five `natives` platform binaries. Commit with `fix(security): pin isolated runtime artifacts`.

---

### Task 4: Regenerate bundles and verify the completed downstream branch

**Files:**

- Regenerate: `core/ui/viewer.html`
- Regenerate: `website/public/sqlite-viewer/viewer.html`
- Regenerate: `website/public/sqlite-viewer/worker.js`
- Verify: compiled outputs created by `scripts/build.mjs`

- [ ] **Step 1: Rebuild only from authored sources**

  ```bash
  node scripts/build.mjs
  ```

- [ ] **Step 2: Run the generated web-worker exploit regression**

  Extend `tests/unit/web_demo_worker.test.ts` to invoke the built worker's CSV export with a formula-bearing TEXT value and malicious header. Assert the emitted direct-open cells begin with apostrophe and are quoted. Then run:

  ```bash
  node --import tsx --test tests/unit/web_demo_worker.test.ts
  ```

- [ ] **Step 3: Run full unit, build, and native smoke gates**

  ```bash
  node --import tsx --test tests/unit/*.test.ts
  npm run build
  npm run test:native-smoke
  ```

  Record exact counts, skips, and failures. Do not claim Electron or VS Code host coverage unless those lanes are actually run.

- [ ] **Step 4: Compare shipped and candidate native IPC performance**

  Use `scripts/bench-native.ts` with the old shipped local-platform binary and the candidate binary, the same benchmark database, warmup, and measured iteration count. Record every sample, median, nearest-rank p95, throughput, and relative delta. A reproducible regression above 5 percent blocks publication pending optimization or explicit approval.

- [ ] **Step 5: Audit generated and binary provenance**

  Verify identical sql.js hashes at every destination, all five native hashes against the script pins, executable bits, and that generated diffs correspond to authored source changes. Run:

  ```bash
  git diff origin/dev...HEAD --check
  git status --short
  git log --oneline origin/dev..HEAD
  ```

- [ ] **Step 6: Commit generated outputs and final verification metadata**

  Commit only tracked generated outputs required by repository convention. Keep benchmark scratch files and downloaded archives ignored.

- [ ] **Step 7: Push and open a normal downstream PR**

  Only after all local gates pass, push `agent/security-scan-remediation` and create a non-draft PR targeting `dev`. The PR body must contain Problem, Solution, Architecture, Per-file Changes, Security, and Test Plan; exact upstream PR URLs/commits/run IDs/hashes; performance data; and an explicit disposition for all seven scanner rows, including the two no-change findings.
