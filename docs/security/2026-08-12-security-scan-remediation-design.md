# Security Scan Remediation and Artifact Integration

Date: 2026-08-12

## Scope and Finding Disposition

This change is the downstream SQLite Explorer portion of the 2026-08-12 scan and the integration point for two upstream fixes.

The actionable paths are:

- CSV formula injection: an untrusted SQLite database supplies TEXT values or column names, a user exports CSV or Excel-compatible CSV, and a spreadsheet application interprets a formula-leading cell. The second-stage impact depends on spreadsheet capabilities and policy, but can include external requests, data exfiltration, or unsafe local actions.
- Heterogeneous batch insertion order: WasmDatabaseEngine groups rows by column shape before executing inserts, so rows with alternating shapes are inserted out of caller order. Triggers, generated rowids, constraints, and history replay can therefore observe a different sequence.
- sql.js paged VFS isolation: consume the upstream fix that denies ATTACH on host-backed paged connections.
- txiki V8 host-view isolation: consume the upstream fix that gives decoded typed arrays exact-extent backing buffers.

Two scan rows require no code change:

- The tag-triggered publishing workflow does not create a separate unreviewed-code path in the current repository authority model: the same sole administrator who can create the tag can already push the protected source. Existing action references are pinned. This is an operational trust decision, not a bypass available to a lower-privileged actor.
- The reported GitHub Action SHA typo is refuted: the configured commit resolves upstream to the intended release.

The no-change findings will be documented in the pull request, not represented by unrelated defensive edits.

## CSV Security Policy

All CSV-producing paths will share one formula-neutralization policy before normal RFC-style CSV quoting.

A string is dangerous when the first character after zero or more Unicode White_Space, Cc, or Cf code points is equals, plus, minus, at-sign, or its full-width counterpart. A leading tab, carriage return, or line feed is scanned as part of that ignorable prefix rather than treated as dangerous on its own; carriage returns and line feeds still force normal CSV quoting. Dangerous text receives one leading apostrophe and is always enclosed in double quotes with embedded double quotes escaped. The apostrophe is therefore the first parsed cell character when a spreadsheet directly opens the export.

The policy applies to:

- SQLite TEXT storage-class values in the streaming exporter;
- string values in the legacy bounded exportToCsv helper;
- column headers, which are always text;
- CSV and Excel-compatible CSV;
- the web demo worker, through the shared authored export encoder.

It does not apply to SQLite INTEGER or REAL storage classes, so negative numeric values remain numeric. NULL and BLOB output remain unchanged. Invalid SQLite TEXT represented by the existing tagged byte envelope is already non-formula-leading and remains byte-faithful.

This policy follows the [OWASP CSV Injection guidance](https://owasp.org/www-community/attacks/CSV_Injection) for direct-open sanitization. It does not claim a universal guarantee after a spreadsheet saves and reopens the CSV: Microsoft Excel may remove CSV escape characters during that round trip, and no sanitization is reliable across every spreadsheet and downstream consumer. The export boundary guarantees that the file SQLite Explorer emits is not formula-leading when directly opened.

The authored helper belongs in src/core/export-encoding.ts. src/tableExportStreaming.ts and website/src/sqlite-viewer/worker.js already call encodeCsvExportCell and will inherit the policy. src/tableExporter.ts will reuse the same string neutralizer for its legacy CellValue path instead of retaining separate escaping logic.

## Batch Order Preservation

WasmDatabaseEngine.insertRowBatch() will execute the input array in its original order while retaining prepared-statement reuse.

For each row:

1. Derive its ordered column list, bind placeholders, values, and statement-cache key.
2. Look up or prepare the INSERT statement for that exact shape.
3. Execute that row immediately.
4. Continue to the next caller-provided row.

Prepared statements are cached per row shape for the transaction and freed in a finally block. Empty rows reuse one INSERT DEFAULT VALUES statement. Nonempty rows preserve existing identifier escaping, typed placeholder selection, and normalizeWasmBindParams behavior.

The existing transaction remains atomic. Any prepare or execution failure frees every cached statement, rolls back through safeRollback(), and rethrows the original error. The change does not alter native-engine ordering because that path already sends rows in order.

This design preserves the previous statement-preparation optimization without the semantic reordering caused by executing one complete group at a time.

## Upstream Artifact Integration

The downstream branch will consume artifacts only from exact verified upstream commits.

sql.js flow:

1. Complete and verify the paged-VFS branch locally.
2. Push it and open a normal upstream pull request.
3. Use its successful branch CI run's dist artifact.
4. Update scripts/refresh-sqljs.mjs with the run ID and SHA-256 hashes.
5. Install identical sql-wasm.js and sql-wasm.wasm copies in vendor, assets, and the web-demo public directory.

txiki flow:

1. Complete correctness and performance verification locally.
2. Push it and open a normal upstream pull request.
3. Dispatch SQLite Explorer artifacts against the exact branch commit.
4. Update scripts/refresh-natives.mjs to accept and verify that source branch and pin the run, commit, and five hashes.
5. Install all five platform binaries under natives with executable modes preserved.

The refresh scripts must fail closed on a branch, commit, run, filename, or hash mismatch. Payload basenames are derived from the exact artifact manifest so adding a manifest entry cannot omit that filename from duplicate and misplaced-payload detection.

Every destination replacement is staged in a same-directory workspace, assigned its final mode, and hash-verified before the commit phase changes any destination. The commit phase moves each original into its workspace before installing the staged replacement. If a later synchronous filesystem operation fails, the scripts restore earlier destinations in reverse order; rollback and cleanup failures are reported explicitly, and a backup whose restoration failed is retained for recovery.

This is rollback protection for ordinary synchronous failures, not a crash-atomic multi-file filesystem transaction. A process crash or power loss during the commit window can still require rerunning the pinned refresh. The downstream pull request will name the exact upstream pull requests, commits, CI runs, and artifact hashes.

## Generated Artifacts

After authored CSV changes and upstream artifact installation, node scripts/build.mjs will regenerate:

- core/ui/viewer.html;
- website/public/sqlite-viewer/viewer.html;
- website/public/sqlite-viewer/worker.js;
- compiled extension and worker outputs used for local verification.

Only repository-tracked generated outputs will be committed. Generated files will not be edited manually.

## Testing

CSV tests will cover:

- equals, plus, minus, and at-sign prefixes;
- their full-width variants;
- attacks hidden behind spaces, tabs, newlines, BOM, format characters, and control bytes;
- malicious column headers;
- commas, quotes, and embedded line breaks after neutralization;
- forced quoting of every neutralized field;
- negative INTEGER and REAL cells remaining numeric;
- NULL, BLOB, ordinary text, and unrepresentable TEXT remaining compatible;
- parity across streaming desktop export, legacy exportToCsv, CSV and Excel modes, and the built web-demo worker.

The exploit regression must fail before the helper changes by producing a formula-leading parsed cell, then pass with the apostrophe prefix.

Batch tests will create a table and an ordering trigger, insert alternating row shapes such as A, B, A, and assert both rowid order and trigger-log order exactly match the caller array. A same-shape control verifies statement reuse does not change values. A failing insert verifies rollback remains atomic and statements are freed.

Integration verification includes focused tests, npm test, npm run build, the real native smoke lane for the current platform binary, and artifact hash checks. The generated web-demo worker test exercises the browser-facing path with the actual bundled sql.js WebAssembly.

## Performance

CSV neutralization adds one prefix scan only for text cells and headers; it does not add an IPC round trip or a second whole-export buffer. Batch insertion retains one prepared statement per distinct row shape and one execution per row, changing only execution order.

The txiki allocation and IPC concern is measured upstream and again through SQLite Explorer's native IPC benchmark. The downstream PR will report the fixed benchmark command, every candidate binary, median, p95, throughput, and relative delta. A repeatable regression greater than 5 percent requires optimization or explicit approval before publication.

## Delivery and Pull Request Ordering

No draft pull request will be opened.

The sql.js and txiki branches will each be completed locally, tested, benchmarked where applicable, and only then pushed as normal ready-for-review pull requests. Their exact CI artifacts will feed the completed SQLite Explorer branch. SQLite Explorer will then receive its own final local verification and a normal ready-for-review pull request targeting dev.

Each pull request description will contain Problem, Solution, Architecture, Per-file Changes, Security, and Test Plan sections. Scanner rows that were refuted or not actionable will be listed with evidence so every imported finding has an explicit disposition.
