# Large database characterization

Run from the intended repository checkout with Node 24 and its locked dependencies installed:

```sh
node tests/performance/large_database_characterization.mjs --payload-mib 16384
```

This creates exactly 16 GiB of live BLOB payload, then runs native and worker-backed WASM characterization. It is opt-in and outside the unit-test glob. No system SQLite CLI is used. A compact preflight uses `--payload-mib 16`; a 1 GiB comparison uses `--payload-mib 1024`.

Options:

- `--fixture .tmp/full-extension-qa/large-db/example.sqlite` chooses a task-owned path inside this checkout. Generation refuses an existing file.
- `--generate-only` creates and verifies the fixture without characterization.
- `--reuse` requires an existing matching `.meta.json` and skips generation.
- `--backend native`, `--backend wasm`, or `--backend both` chooses characterization backends. Generation always uses the shipped native adapter.
- `--build-runtime-only .tmp/full-extension-qa/portable-runtime` builds a portable JavaScript/WASM bundle and hash manifest, then stops without creating a fixture. The target directory must be empty.
- `--prebuilt-runtime .tmp/full-extension-qa/portable-runtime` uses that frozen bundle without importing esbuild or requiring source files or `node_modules` on the test host.

The runner builds an isolated source bundle for `workerFactory` and its real Node worker. Only VS Code URI/config/log services are supplied by a small test adapter; workspace file I/O uses the real filesystem. The worker/RPC, engine, serializer, history operations, export and paged persistence paths are production code. Native uses `createNativeDatabaseConnection` with the checkout's bundled txiki worker and query-plan library. WASM uses the existing desktop test backend/paging setters and must report writable `storage=paged`.

Source-building requires the repo `src/`, `natives/`, `vendor/sql.js/`, locked `node_modules` with the correct platform esbuild binary, and `tests/unit/mocks/vscode.ts`. The runner builds below `.tmp`; it does not regenerate tracked extension artifacts.

For portable VM runs, build the bundle from the final integrated checkout on the development host:

```sh
node tests/performance/large_database_characterization.mjs --build-runtime-only .tmp/full-extension-qa/portable-runtime
```

Transfer this runner at the same relative path, the whole portable runtime directory, `natives/native-worker.js`, and the guest's complete native target directory (`natives/x86_64-linux-gnu` or `natives/x86_64-windows`) into the guest's task directory. With Node 24 installed, run from that task directory:

```sh
node tests/performance/large_database_characterization.mjs --payload-mib 16384 --fixture .tmp/full-extension-qa/large-db/live-16gib.sqlite --prebuilt-runtime .tmp/full-extension-qa/portable-runtime
```

This generates the fixture locally on the guest. It requires no guest package installation and no transferred `node_modules`. The frozen manifest records all bundled source input hashes, build environment, native asset hashes and runtime artifact hashes. Prebuilt mode verifies the bundle bytes before and after copying and requires the guest's native worker, executable and query-plan library to match the frozen build. The run environment report embeds that manifest and the live native asset hashes. It does not claim that unrelated checkout files are identical.

The fixture has 256 KiB BLOBs, an INTEGER PRIMARY KEY, an indexed bucket and a short editable label. At 16 GiB this is 65,536 live rows. Baseline verification checks exact live byte sum, file/page geometry, zero free pages and physical allocated blocks when the OS exposes them. Normal label edits can free a bounded number of overflow pages, so subsequent checks permit up to 1 MiB of mutation-created free space.

Each backend checks open, schema, all five keyset modes, deep OFFSET, indexed count and original plan, grid column-filter/count, default 5,000-row BLOB-page containment including real host serialization, chunk reads, edit/undo/redo, selected JSON export, export cancellation, persistence and fresh connection readback. Undo/redo exercises engine history, not VS Code's UI undo stack. The fixture cells exceed a deliberately lowered 1 KiB preview limit in the chunk check; the separate default-grid check uses normal limits.

Generation is capped at 15 minutes, each process at 20 minutes, and payload at 16 GiB. A new fixture requires three times the payload plus 1 GiB free disk. `--reuse` requires twice the payload plus 1 GiB remaining free disk for atomic-save headroom. `maxFileSize=0`, query timeout 60 seconds and the internal WASM paging threshold 8 MiB are recorded explicitly.

Artifacts beside the fixture include baseline `.meta.json`, source/config `.environment.json`, per-mode logs and stage JSON, and current-invocation `.runs.json`. Reusing a fixture replaces that mode's logs/results. Preserve older runs separately when comparing changes.

RSS in the stage JSON is the entire Node process, including WASM worker threads. A separate process sampler records native sidecar RSS on macOS/Linux at 100 ms during characterization and one second during generation. Sampled values are lower bounds on the actual peak. Native-child RSS and allocated-block evidence may be unavailable on Windows and are reported as such. Timings include the sampler overhead. No cold-cache, installed VSIX, actual browser UI, or cross-platform pass is implied by a local run.
