# SQLite Explorer - VS Code Extension

## Overview

SQLite Explorer is a VS Code extension that provides a powerful SQLite database viewer and editor. It uses WebAssembly-based SQLite (sql.js) to work across all platforms, including VS Code for Web.

## Architecture

### Three-Layer RPC Architecture

The extension uses a three-layer communication architecture:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    Webview      │ ←→  │  Extension Host │ ←→  │     Worker      │
│  (viewer.html)  │     │  (extension.ts) │     │   (worker.ts)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        ↑                       ↑                       ↑
    UI Layer              VS Code API             SQLite WASM
```

1. **Webview Layer** (`core/ui/viewer.html` + `core/ui/modules/*.js`)
   - Renders the UI (table grid, sidebar, modals)
   - Handles user interactions (cell editing, row selection, CRUD operations)
   - Communicates with Extension Host via custom RPC protocol
   - Modularized logic in `core/ui/modules/` (rpc, state, grid, sidebar, etc.)

2. **Extension Host Layer** (`src/main.ts`, `src/databaseModel.ts`, `src/editorController.ts`)
   - Manages VS Code custom editor lifecycle
   - Bridges Webview and Worker communication
   - Handles file I/O via VS Code workspace API
   - Exposes `HostBridge` to the Webview

3. **Worker Layer** (`src/databaseWorker.ts`, `src/nativeWorker.ts`)
   - Runs WebAssembly SQLite (sql.js) or Native SQLite (txiki-js)
   - Executes all SQL queries
   - Handles database operations via `DatabaseOperations`

### Key Files

| File | Purpose |
|------|---------|
| `src/main.ts` | Extension activation, command registration |
| `src/sqlWorkspace.ts` | SQL editor bindings, session history, bounded result documents and commands |
| `src/core/sql-workspace.ts` | Read-query boundary, positional parameters, containment and CSV formatting |
| `src/bulkImport.ts` | CSV/JSON import selection, preview, mapping and tracked document mutation |
| `src/core/bulk-import.ts` | Bounded import parsing and atomic guarded row insertion |
| `src/editorController.ts` | Custom editor provider (DatabaseViewerProvider, DatabaseEditorProvider) |
| `src/databaseModel.ts` | Document model (DatabaseDocument), undo/redo, save/revert |
| `src/workerFactory.ts` | Worker instantiation, connection setup, file reading |
| `src/databaseWorker.ts` | Worker entry point, exposes database operations |
| `src/nativeWorker.ts` | Native SQLite worker (txiki-js), batched IPC via `queryBatch` |
| `src/config.ts` | Extension constants, URI scheme, storage keys, typed config accessors |
| `src/shims.ts` | Polyfills for Symbol.dispose, AbortSignal.throwIfAborted, Promise.withResolvers |
| `src/hostBridge.ts` | HostBridge - functions exposed to webview (exec, export, etc.) |
| `src/core/types.ts` | Core type definitions (CellValue, RecordId, QueryResultSet, etc.) |
| `src/core/rpc.ts` | RPC utilities (buildMethodProxy, processProtocolMessage) |
| `src/core/sqlite-db.ts` | Database engine wrapper |
| `src/core/query-builder.ts` | Safe SQL query construction |
| `src/core/sql-utils.ts` | SQL utilities and escaping |
| `src/core/json-utils.ts` | JSON Merge Patch (RFC 7396) generate and apply |
| `src/core/cancellation-utils.ts` | CancellationToken to AbortSignal bridge |
| `src/core/serialization.ts` | Serialization utilities |
| `src/core/undo-history.ts` | ModificationTracker for undo/redo |
| `src/documentRegistry.ts` | Global registry of open DatabaseDocument instances |
| `src/webviewMessageHandler.ts` | Webview → Extension Host message routing |
| `src/webview-collection.ts` | Tracks active webview panels per document |
| `src/virtualFileSystem.ts` | Virtual FS provider for editing cells in tabs |
| `src/connectionTypes.ts` | Database connection bundle interfaces |
| `src/helpers.ts` | Helper utilities |
| `src/html-utils.ts` | HTML utilities |
| `src/lifecycle.ts` | Resource lifecycle management (Disposable utilities) |
| `src/tableExporter.ts` | Table export to CSV/JSON/SQL |
| `src/posixAccessEntries.ts` | Access-control entries on macOS and Linux: read and set through descriptors before a save replaces a file |
| `src/folderAccess.ts` | What a save needs to know about the folders on the way to its file (owners, modes, groups, entries) |
| `src/insideDirectory.ts` | Making a save's file inside its own directory: descriptor path or helper process |
| `src/platform/cryptoShim.ts` | Platform crypto abstraction |
| `src/platform/threadPool.ts` | Cross-platform worker thread APIs (Browser + Node) |
| `src/loggingDatabaseOperations.ts` | Decorator for logging SQL queries |
| `core/ui/modules/settings.js` | UI logic for database settings/pragma editor |
| `core/ui/modules/web-api.js` | Web demo API module (parent window communication) |
| `core/ui/viewer.html` | Standalone webview UI |
| `core/ui/web-viewer.js` | Web demo entry point |
| `website/app/demo/page.tsx` | Web demo React page |
| `website/src/sqlite-viewer/worker.js` | Web demo SQLite worker (authored source; imports `src/core/view-utils.ts`) |
| `website/public/sqlite-viewer/worker.js` | Web demo SQLite worker (GENERATED by build.mjs from `website/src/`) |
| `website/public/sqlite-viewer/viewer.html` | Web demo bundled viewer |
| `assets/sqlite3.wasm` | SQLite WebAssembly binary |

### RPC Protocol

The extension uses two distinct RPC protocols for cross-boundary communication.

**1. Core RPC (Worker Communication & Extension → Webview)**
Defined in `src/core/rpc.ts`, used for all Worker communication and when the Extension invokes Webview methods.

*Request:*
```javascript
{
  kind: 'invoke',
  correlationId: 'ipc_...',
  methodName: 'methodName',
  parameters: [arg1, arg2, ...]
}
```

*Response:*
```javascript
{
  kind: 'result',
  correlationId: 'ipc_...',
  payload: result, // or errorText: "error"
}
```

**2. Webview RPC (Webview → Extension)**
Used when the Webview invokes Extension Host methods.

*Request:*
```javascript
{
  channel: 'rpc',
  content: {
    kind: 'invoke',
    messageId: 'rpc_...',
    targetMethod: 'methodName',
    payload: [arg1, arg2, ...]
  }
}
```

*Response:*
```javascript
{
  channel: 'rpc',
  content: {
    kind: 'response',
    messageId: 'rpc_...',
    success: true,
    data: result // or errorMessage: "error"
  }
}
```

**Zero-Copy Transfer:**
To transfer large binary data (ArrayBuffers) without copying, use the `Transfer` wrapper in the RPC layer (supported in Core RPC).
```typescript
// workerFactory.ts
const data = new Uint8Array(...);
workerProxy.method(new Transfer(data, [data.buffer]));
```

**Uint8Array Serialization:**
`Uint8Array` cannot be directly serialized via `postMessage` (becomes `{}`). The RPC layer uses Base64 encoding:
```javascript
// Serialized format (preferred, compact)
{ __type: 'Uint8Array', base64: 'SGVsbG8=' }

// Legacy array format (supported for backward-compatible deserialization only)
{ __type: 'Uint8Array', data: [72, 101, 108, 108, 111] }

// Security: Marker must have exactly 2 keys to prevent collision with user data
```
- Webview serializes in requests, deserializes in responses (`core/ui/modules/api.js`)
- Extension host deserializes in requests, serializes in responses (`src/editorController.ts`)

**Worker Log Forwarding:**
Workers route logs through RPC using `LogEnvelope` instead of `console.*`:
```javascript
{ kind: 'log', level: 'warn', args: ['message', 42] }
```
The host routes these to the VS Code "SQLite Explorer" output channel via `GlobalOutputChannel`.

## Security Standards

### Content Security Policy (CSP)
- **Scripts**: Strict nonce-based policy. No `'unsafe-inline'` allowed.
- **Styles**: Nonce-based policy for `<style>` tags. Dynamic inline styles are applied via CSSOM (`element.style.prop = ...`) which is permitted by CSP.
- **Isolation**: Webview communicates only via RPC.

### Cross-Site Scripting (XSS) Prevention
- **Grid Rendering**: Always use `textContent` for cell values. Never use `innerHTML` with untrusted data.
- **Formatting**: Use `formatCellValueAsText()` for safe display strings.

### SQL Injection Prevention
- **Query Parameters**: Use prepared statements (`?` placeholders) for all values.
- **Identifiers**: Always use `escapeIdentifier()` for table/column names.
- **Schema Validation**: Use `validateSqlType()` for all user-provided SQL types in DDL.
- **PRAGMA Values**: String values validated via `/^[a-zA-Z0-9_-]+$/` whitelist; numeric values checked with `Number.isFinite()`.

## Build System

### Build Commands

```bash
# Install dependencies
npm install

# Full build (compiles extension + worker)
node scripts/build.mjs

# Package extension as .vsix
npm run package

# Development build with sourcemaps
DEV=1 node scripts/build.mjs

# Quick install (build + package + install)
./install.sh

# Run unit tests
npm test
```

### Build Outputs

- `out/extension.js` - Node.js extension (desktop VS Code)
- `out/extension-browser.js` - Browser extension (VS Code Web)
- `out/worker.cjs` - Node.js worker (VS Code Web runs sql.js in the extension host; there is no browser worker bundle)
- `core/ui/viewer.html` - Webview UI
- `website/public/sqlite-viewer/viewer.html` - Web demo viewer (bundled)
- `assets/sqlite3.wasm` - SQLite WASM binary

### Web Demo

The project includes a standalone web demo at `/demo` on the website. This allows users to try SQLite Explorer in their browser without installing the VS Code extension.

**Architecture:**
```
┌─────────────────┐     ┌─────────────────┐
│   React Page    │ ←→  │   Web Worker    │
│  (demo/page.tsx)│     │   (worker.js)   │
└─────────────────┘     └─────────────────┘
        ↓                       ↑
   ┌────────────┐         sql.js WASM
   │   iframe   │
   │(viewer.html)│
   └────────────┘
```

**Key differences from VS Code extension:**
- Uses `window.parent.postMessage` instead of VS Code API
- Loads sql.js directly from CDN
- No file system access (upload-only)
- No undo/redo integration

**Building the web demo:**
```bash
# Build extension (includes web demo viewer)
node scripts/build.mjs

# Generate sample databases
node scripts/generate-samples.mjs

# Build website
cd website && npm run build
```

### Build Configuration

The build uses esbuild with these targets:
- **Extension**: CJS format, ES2022, externals: `vscode`, `worker_threads`
- **Worker**: ESM format, ES2022, includes sql.js WASM

## Key Types and Naming

| Type | Description |
|------|-------------|
| `CellValue` | Any value in a SQLite cell (string, number, null, Uint8Array) |
| `RecordId` | Row identifier (string or number) |
| `QueryResultSet` | Query results with headers and rows |
| `ModificationEntry` | Record of a database modification |
| `DatabaseOperations` | Interface for database operations |
| `DatabaseDocument` | VS Code custom document for a database file |
| `HostBridge` | Methods exposed to webview |

## Key Patterns

### Custom Editor Provider

```typescript
// DatabaseEditorProvider implements vsc.CustomEditorProvider
// - openCustomDocument: Creates DatabaseDocument
// - resolveCustomEditor: Creates webview, sets up RPC
```

### Document Lifecycle

1. `openCustomDocument()` - Creates DatabaseDocument, loads database into worker
2. `resolveCustomEditor()` - Creates webview, establishes RPC connection
3. User edits trigger `recordModification()` - Tracked in ModificationTracker
4. `save()` - Commits changes to database file
5. `dispose()` - Cleans up worker, removes from DocumentRegistry

Hot exit backs up only the `ModificationTracker`. On WebAssembly, restore replays its unsaved entries onto the saved file, so the document pins them (`pinUncommittedEntries`): the entry and memory limits evict saved entries only, and once unsaved entries fill `maxUndoMemory` further edits wait for a save. The native engine has written every edit already and keeps the plain limits.

### Inline Cell Editing

The webview handles inline editing:
1. Double-click cell → Creates input overlay
2. Enter key → `saveCellEdit()` sends UPDATE via `backendApi.updateCell()`
3. Escape key → `cancelCellEdit()` discards changes

### Export Reads

`src/tableExportStreaming.ts` reads rowid and primary-key tables in keyed batches and a view through a query read session (WebAssembly) or a TEMP spool on the second connection (native). Values within a batch's per-cell share travel in the row batch, BLOBs included for SQL and JSON; only a larger value opens a cell read session, which costs several engine calls. A view's rows have no key and can hold a megabyte per column, so their batches are bounded by bytes: `readQueryRows(sessionId, maxRows, maxBytes)` on WebAssembly, and on native a size column stored in the spool, read 128 rows ahead. The native worker accepts spool statements only by exact text (`parseExportSpoolStatement` in `natives/native-worker.js`, mirrored by `isGeneratedExportSpoolStatement` in `nativeWorker.ts`); change both with the exporter. SQL exports leave generated columns out of the INSERTs.

### Virtual File System

The extension registers a `FileSystemProvider` to allow editing cell contents in full VS Code editors:
1. `hostBridge.openCellEditor()` opens a custom URI.
2. `SQLiteFileSystemProvider.readFile()` queries the cell data.
3. `SQLiteFileSystemProvider.writeFile()` triggers `document.databaseOperations.updateCell()`.

### Reads Refuse Writes

Every read runs with `PRAGMA query_only` held on the connection that steps it. The flag is always restored after the statement deadline has been handled; a read that times out leaves the connection writable (`read_refuses_writes.test.ts`).

- `isReadStatement` in `src/core/read-statement.ts` decides from the text whether a generic statement is one SELECT: `SELECT`, `VALUES`, or `WITH` followed by either. Only a SELECT can start that way, so a write is never treated as a read. Both transports use the same function to give a read the query timeout.
- WebAssembly engine and demo worker: `withWritesRefused` / `readRefusingWrites` wrap each strictly synchronous read span (page, count, generic SELECT, preview, each `readQueryRows` call, the console).
- Native: the worker's request dispatcher holds the flag around the request deadline for `queryNumeric`, `queryPacked`, `queryBounded`, and for `query`, `querySingle` and `queryBatch` when the host marks them (`NativeWorkerProcess.call`). `querySingle` also carries writes, so it is classified, never assumed. The second connection (`asyncDb`) is opened read-only whatever the document is: `query_only` would also refuse the TEMP spool it writes for a view export.
- A new read path must go through one of these. A method that steps a SELECT over a user object outside them is a bug.

### SQL Logging

Database operations are wrapped in `LoggingDatabaseOperations` which writes all executed SQL (both read and write) to the "SQLite Explorer" output channel for debugging.

### Settings & Pragmas

The webview provides a UI to configure SQLite PRAGMAs (e.g., WAL mode, Foreign Keys) directly via `hostBridge.setPragma()`.

### Webview State Persistence

`retainContextWhenHidden` is `false` — webviews are destroyed when hidden to save memory. State survives via `vscodeApi.setState()`/`getState()`:
- `persistState()` in `state.js` saves user-facing state (selected table, scroll position, filters, pins, settings) at once, without a timer: a hidden webview can be destroyed before one fires
- `viewer.js` restores state on re-initialization, including scroll position after grid render
- VS Code extension settings (e.g., `cellEditBehavior`) take precedence over restored state
- Web demo (`web-api.js`) provides no-op stubs since there is no VS Code API

### Platform Helpers

`getNodeFs()` in `sqlite-db.ts` safely requires the Node.js `fs` module, returning `undefined` in browser environments. Used by `sqlite-db.ts` (file reading, writing) and `tableExporter.ts` (streaming export).

### Transaction Safety

`updateCellBatch` uses `SAVEPOINT`/`RELEASE`/`ROLLBACK TO` instead of `BEGIN TRANSACTION` so it can be safely called from within outer transactions (e.g., `undoColumnDrop`). All transaction error handlers use the `safeRollback(context)` private helper which logs failures instead of throwing — preventing secondary rollback errors from masking the original error.

### Saves That Replace a File

- A save that replaces the file (a WebAssembly save, a paged save, native Save As) takes SQLite's exclusive lock first, checks its target again right before it renames, and runs a refused lock or rename again for up to 630 ms (`patiently` in `fileReplacementMetadata.ts`). The extension does not serialize the saves of a document held in memory, so two can overlap; the checks stop whichever commits second.
- The new file keeps the owner, mode and permissions of the one it replaces, on every platform. The code is in `atomicDatabaseWrite.ts`, `pagedWritableSave.ts`, `fileReplacementMetadata.ts`, `insideDirectory.ts`, `folderAccess.ts`, `posixAccessEntries.ts` and `windowsAccessList.ts`.
- The reasons for the rules in those files are not kept in the repository. The maintainer's checkout has them in `personal/save-hardening.md`. Without that file, do not change how a save makes, checks or renames its copy, which programs it starts, or the order of its steps. Each rule has a unit test, most with a control: `atomic_database_write.test.ts`, `paged_writable_save.test.ts`, `posix_access_entries.test.ts`, `windows_access_list.test.ts`, `save_in_place_engines.test.ts`.
- Running those tests:
  - Two tests in `atomic_database_write.test.ts` need Windows. On Linux some run twice, once for each way a save reaches its copy (`stagedSnapshotAccess`).
  - The tests that use the system's own programs need macOS, or Linux with `getfacl` and `setfacl`. Test files that assert what a save logs turn those programs off for themselves (`accessEntryTools.use = null`), so that they do not depend on which programs a machine has.
  - Run `windows_access_list.test.ts` and `save_in_place_engines.test.ts` on Windows as a standard user as well. `save_lock_page.test.ts` runs only with `SQLITE_EXPLORER_BIG_TESTS=1`.
  - `tests/desktop` checks in the editor's own runtime that a child process told to run as Node does.
- `scripts/build.mjs` holds `out/extension.js` to 500,000 bytes and `out/extension-browser.js` to 550,000.

### Reads and Edits Beside Another Program (native)

The native engine reads and writes the file itself, beside whatever else has it open. In a rollback-journal database SQLite refuses a statement at once when another connection holds a lock in its way: a write beside a reader, a read beside a writer that is committing. An edit failed with "database is locked" whenever the database's application read the file at that instant; 1.8.3 does the same (`busy_timeout` 0, measured with its own macOS binary). `natives/native-worker.js` now gives its connections `LOCK_WAIT_MS` (600 ms, about what a save waits, see Saves Beside Another Program) through `PRAGMA busy_timeout`:
- **The main connection** gets it before each request (`syncMainLockWait`), the second connection when it is opened, and a cell read session's own handle when the session opens.
- **Not while a cell read session holds its snapshot on a handle of its own.** That lock is the worker's, and only the worker's one thread can end it, so a statement waiting for it would block the thread that could and then fail as it does at once. The main connection's wait is 0 for as long as such a session is open. An edit then fails at once, as it always did.
- **One wait per request.** SQLite's busy handler sleeps in steps of 1 to 100 ms (the build has sub-second sleep: `HAVE_NANOSLEEP` is not defined to 0 in the fork's flags) and the statement deadline cannot interrupt it. A request that tried statement after statement on a locked file would wait once for each: `compileBatch` stops at the first SQLITE_BUSY and gives the rest the same answer, the SQL editor's per-object completion fallback stops at the first "database is locked" (SQLite's whole message: a name in the schema can put those words into another one), the missing-module check answers "not checked" when the file was locked, and `prepareGridPage` reads the file before it loads the runtime library, whose probes would otherwise wait too.
- **That order in `prepareGridPage` also keeps the grid's helpers.** On a connection that has not read its schema yet, the library's probes read the file. One refused by a lock left `cell_pack` or `like_any` off until the file was opened again.
- **What it costs.** Beside a program that keeps the file locked, each operation fails after about 0.67 s where it failed within 3 ms (measured on macOS arm64 for open, schema, page, count, edits, deletes, exports and the module check, with a reader and with a writer holding the file). An open while a writer holds the file takes that long once, for the second connection's probe, which then stays off as before.
- **Not covered: an edit beside another connection's open write transaction.** It fails at once, in both journal modes (measured, as in 1.8.3; in WAL mode it is the only pair that is refused). The edit reads its prior values inside its savepoint before it writes, and SQLite calls the busy handler for the write lock only from a transaction that holds no lock yet (`sqlite3BtreeBeginTrans`: `inTransaction==TRANS_NONE`). Covering it means taking the write lock before the first read of every edit path.
- **Not covered, by SQLite's locking rules and not measured:** a writer that is waiting for this engine's own snapshot. During a view export the main connection holds a read snapshot; another program's commit then waits for it and refuses new readers, among them the export's second connection, which waits its 600 ms and fails unless that program gives up first.
- `native_lock_wait.test.ts` holds each rule against the real binary, with another connection that lets go after 150 ms or never. Each part of the change removed alone fails one of its tests.

### JSON Patch Optimization

`updateCell` and `updateCellBatch` in `sqlite-db.ts` probe for SQLite's `json_patch()` at engine construction time (`hasJsonPatch` flag). When available, uses `json_patch(COALESCE(col, '{}'), ?)` in a single UPDATE (no SELECT round-trip). Falls back to JS-side `applyMergePatch()` from `json-utils.ts` when JSON1 extension is unavailable.

### Batched IPC

`queryBatch` in `nativeWorker.ts` sends multiple SQL queries in a single IPC round-trip. Used for schema fetching (3 queries → 1 call) and pragma reads.

### Native Memory-Mapped Reads

At each open, `nativeMemoryMapBytes()` in `nativeWorker.ts` decides whether the worker sets `PRAGMA main.mmap_size` (256 MiB). SQLite cannot catch a fault on a mapped page. An I/O error, or another program truncating the file during a statement, kills the tjs process, where `read()` fails only that statement with "database disk image is malformed". So only files on Linux local filesystems are mapped, picked by statfs magic number:
- **macOS:** never. On APFS, removing the mapping at close or process exit changes the file's ctime, even after reads only. That breaks the atomic save's target check (`native_file_replacement.test.ts`) and touches files the user only viewed. `native_memory_map.test.ts` asserts that ctime stays unchanged.
- **Windows:** never, because a mapped file can't be truncated by other processes.

Don't add network, FUSE, 9p or removable-media types to the allowlist.

### Engine Choice for FTS3/FTS4 Files

The native build leaves FTS3 and FTS4 out on purpose: they would parse index data from the file unsandboxed. The WebAssembly build has them, and every module the native build has, so a file opened there loses no table. `core/virtual-table-modules.ts` lists the difference, and `native_module_fallback.test.ts` checks both facts against `pragma_module_list` of both bundled builds; re-run it after a runtime rebuild. Right after a native open, `createDatabaseConnection` asks native which main-schema virtual tables use a module it lacks:
- One `sqlite_schema` query selects virtual tables whose SQL mentions a listed module, then one `compileBatch` prepares `EXPLAIN SELECT 1 FROM` each. Only an exact "no such module: <listed module>" counts. An ordinary database pays the one query.
- Past 256 candidates, or with a candidate name over 1024 bytes, nothing is prepared and the file stays native.
- A file with such tables opens on WebAssembly unless it is over `maxFileSize`, its -wal holds frames, or the WebAssembly engine cannot open it or load its schema (native stays open until both succeed). SQLite reads the schema for the first statement that needs it, not at the open, so the factory runs one statement on the new connection: the WebAssembly build refuses schemas native accepts, such as a libm math function in an index, and every statement would then fail. Each case that keeps native writes one output line naming the tables. On native those tables fail with "no such module" and the rest of the file opens: `TABLE_IDENTITY_METADATA_SQL` asks `pragma_table_info` only about the WITHOUT ROWID tables whose columns it reads, because SQLite runs a joined table-valued function before the ON clause and `table_info` fails on a virtual table whose module is missing (`schema_identity_missing_module.test.ts`). Without the module SQLite lists an FTS3/FTS4 table's shadow tables as ordinary tables.

Hot-exit backups record their engine, and restore reopens it (`establishConnection`'s `backupEngine`): native has written a backup's entries to the file, WebAssembly replays them. A backup without one restores on native.

### Math Functions in a Schema (WebAssembly)

A math function's result can differ between the WebAssembly libm and a native one in the last digit (`ln(3)` does on macOS), so an index key or a stored generated column computed on WebAssembly might not be the one native computes, and a row could be missing from its index. SQLite's math functions stay deterministic there and keep SQLite's code, so every schema loads and every table reads. `scripts/lib/sqlite-math-patch.mjs` marks them with the free function flag bit `0x0200` and changes two decisions:
- **An index that depends on one is never opened.** `sqliteExplorerIndexUsesLibm` is true when an expression of the index or its WHERE calls a math function, or when a key column is a VIRTUAL column of a table that has a generated column calling one (generated columns are not followed into each other, so a crafted schema cannot make the test deep). `sqlite3KeyInfoOfIndex`, which every statement that opens an index calls and where SQLite refuses an unknown collation, refuses it. The places that pick an index to read (`whereLoopAddBtree`, `whereShortCut`, `sqlite3FindInIndex`, the `count(*)` pick, `isDistinctRedundant`) skip it first, so a query scans; a pick site the patch misses fails the statement and cannot return a wrong row. A write that must maintain the index fails; one that does not touch it works.
- **A table that has a STORED generated column is not modified when any generated column of it calls one** (`sqlite3IsReadOnly`). As for an index, generated columns are not followed into each other. A table without a STORED generated column, whose math columns are unindexed, is fully writable.

`wasm_math_schema.test.ts` runs each schema shape (expression index, partial index, stored column, virtual column, index on a virtual column, inline UNIQUE in both constraint orders) against each kind of statement on a file the native engine wrote. Re-run it, and review the patch's anchors, after a SQLite upgrade.

The rule covers the functions that compute with the library: `exp`, `pow`, `power`, the logarithms, the trigonometric and hyperbolic functions. `ceil`, `ceiling`, `floor`, `trunc`, `mod` and `sqrt` (fixed to the last bit by IEEE 754), `radians` and `degrees` (one multiplication by a constant), `sign` and `pi` are left as SQLite has them, so their indexes are read and written; `wasm_exact_math_parity.test.ts` compares them with the platform's native engine bit for bit over random doubles, and must pass on every target before a release. A math function a later SQLite adds is treated as one that can differ until the patch lists it.

**On a SQLite upgrade** the patch has to be re-fitted before the WebAssembly runtime builds: each of its replacements must match the new amalgamation exactly once, and the builder stops at the first that does not. Budget for it, also when the upgrade is an urgent security fix:
1. Run the builder. For each replacement it reports, read the new SQLite code at that place and re-fit the replacement; do not loosen a match to make it apply.
2. Three groups are needed for safety and must all apply: the flag and macros with the function table entries, `sqlite3KeyInfoOfIndex`, and `sqlite3IsReadOnly`. The five pick sites only turn a refusal into a table scan. If one of them cannot be re-fitted in time, remove that replacement: queries of that shape on such a database then fail with the index message, which `wasm_math_schema.test.ts` and the sanitizer driver will show, and nothing reads a wrong row.
3. Look for new places that pick an index to read without going through `whereLoopAddBtree` (search the planner for loops over `pTab->pIndex`); a new one needs no change to stay safe, only to scan instead of failing.
4. Run `wasm_math_schema.test.ts`, `wasm_exact_math_parity.test.ts` and `npm run test:runtime-sanitizers` (its mutation arm must still catch all six patch defects).
5. If the patch cannot be re-fitted at all, the fallback that needs only the function table is the one this replaced: mark every math function non-deterministic (the three replacements in `scripts/build-query-plan.mjs` at `4c87eeb`). SQLite then refuses such schemas when it loads them, so those databases do not open on WebAssembly until the patch is back; the matrix test fails by design and the changelog has to say so.

### Global Filter Function

On a UTF-8 database with the runtime registered, the global filter calls `sqlite_explorer_like_any(needle, col1..col100)` once per row for each chunk of up to 100 columns (`buildFilterConditions` in `query-builder.ts`). The call sits inside `COALESCE(CASE WHEN 'a' LIKE 'A' THEN … END, <the LIKE chain>)`. The function returns 1 or 0 only when LIKE `'%needle%'` must agree, and NULL otherwise, which hands that row to the chain. The constant `'a' LIKE 'A'` keeps it out of the way under `PRAGMA case_sensitive_like`.

Rules it relies on, read from SQLite 3.54.1's `patternCompare` and `sqlite3Utf8Read`:
- LIKE folds ASCII case only and stops at the first NUL.
- Bytes below 0x80 always decode as themselves, and no other bytes decode to one, so an ASCII needle is matched against raw bytes.
- A non-ASCII needle is compared only with plain UTF-8; other TEXT is undecided.
- Both builds set `LIKE_DOESNT_MATCH_BLOBS`.
- INTEGER and REAL text uses only `0-9 . + - e Inf`.

`global_filter_like_any.test.ts` compares both forms over every value class on both engines and checks these rules. Re-run it after any SQLite upgrade.

### Keyset Pagination

Grid page turns seek instead of scanning (deep page = first-page cost on every engine). Engines mint opaque anchor tokens (`ksa:` + canonical JSON, `src/core/keyset-pagination.ts`) for the first/last row of every page of an anchorable table (authority-confirmed unshadowed rowid, or WITHOUT ROWID primary key). The webview commits them atomically with the grid rows (inside the superseded-load gate in `grid-data.js`) and round-trips them verbatim with a navigation intent (`first`/`after`/`atOrAfter`/`before`/`last`). Engines strictly re-validate every received anchor — canonical decode, embedded query-identity tag (table, sort, filters, page size), key arity — and fall back to the LIMIT/OFFSET query on any legitimate staleness; structurally malformed tokens throw (engines never mint them, so they signal tampering, not staleness). Both paths emit one deterministic total order — the identity tiebreak is appended to sorts, and the OFFSET fallback adopts the full key ordering via `keysetFallbackOrder` — so mixed OFFSET/keyset sequences can never skip or duplicate rows. NULL sort boundaries decompose per direction (NULLs first ASC / last DESC); INTEGER-class anchor values bind through `+CAST(? AS INTEGER)` so int64 beyond 2^53 seeks exactly even on NONE-affinity columns; the unary plus drops the CAST's INTEGER affinity, which would compare a typeless column under NUMERIC affinity and treat stored TEXT `'7'` as 7 (row identity predicates use the same placeholder for the same reason). The tag's page size is the request's `pageSize`, the rows per page the grid pages by, not its LIMIT: the grid bounds a final page's LIMIT to the rows its count leaves, and that page's anchors must still seek the page before it. A LIMIT above the page size never seeks. The webview records the page size with the anchors it commits and sends none for a load under another page size. Views and keyless objects always use OFFSET. `before`/`last` execute reversed with a bounded SQL-side re-sort so row-indexed sidecars (oversizedCells, exactIntegerTexts) stay aligned.

Sorted pages of authority-confirmed ordinary rowid tables (not virtual tables) take `buildRowIdLookupSelect` in `keyset-pagination.ts`, for keyset and OFFSET pages alike:
- The inner query sorts only the key columns (sort column, then rowid) under the page's WHERE, seek, LIMIT and OFFSET.
- A `CROSS JOIN` reads each page row by rowid.
- The outer `ORDER BY` over the inner key columns is the display order. SQLite drops it for forward pages, and a reversed page sorts at most a page.
- The inner key columns keep the column's collation. They are table-qualified, because `ORDER BY` resolves a bare name to a result alias first: a column named `k1` would otherwise sort by the rowid.
- The query ends in `LIMIT -1 OFFSET 0`. Without it SQLite flattens it into the containment wrapper and the page order is lost, which `sorted_page_rowid_lookup.test.ts` catches.

### Count Cache

`core/ui/modules/count-cache.js` makes repeat grid loads count-free: COUNT(*) results are cached per identity (table + active column filters + active global filter, + displayed columns only while a global filter is active), so page turns issue zero count RPCs and a cache miss fetches count and data in parallel (`Promise.allSettled`, speculative data discarded and refetched once if the count clamps the page index; `last` navigation on a cold cache stays sequential because its remainder derives from the count). Webview inserts/deletes adjust the unfiltered identity by their known delta and drop the table's filtered identities. In VS Code, cell edits preserve the unfiltered identity and drop filtered identities. The host's post-edit `refreshContent` echo carries the history entry's `modificationType`. A `cell_update` echo keeps every table's unfiltered identity, and drops views and filters, when the last schema load reported no main or TEMP trigger and no virtual table (`SchemaSnapshot.hasTriggers`; an FTS5 update adds rows to its shadow tables without a trigger). Each refresh clears that answer until its own schema load, and every other echo invalidates wholesale. The web demo has no echo, so cell edits also drop its unfiltered identity because uploaded databases can contain UPDATE triggers that change cardinality. Table switch / refreshContent / reload-from-disk / view redefinition invalidate wholesale. In-flight fetches are epoch-gated: a count RPC that overlapped any mutation or invalidation is never stored. Within one load, a single count value feeds the clamp, page count, keyset `last` remainder, retry check, and commit — cached and fetched counts are never mixed. Not persisted; restored webviews re-fetch in parallel with their first data query.

### Wide-Table Page Size

The host fits each page into 16 MiB by giving every cell an equal share, so a page of many cells clips short values or cannot fit at all. `pageSizeForColumns` in `grid-data.js` lowers a load's rows per page so rows × the values each row returns (the displayed columns, plus the rowid a table query adds) stays within 250,000, about 67 bytes each, enough for a UUID; it rounds down to a multiple of 100. The limit counts values, not columns: a narrow table at a large page size reaches the same per-value share, so it applies to every width. `wide_page_values.test.ts` checks on both engines that 200 columns of UUIDs arrive whole at the lowered size. The Rows selector keeps the chosen size and `#pageSizeNote` beside it shows a lowered one (`syncPageSizeNote`, run with each row commit and hidden when an error replaces the page); the status bar also names it until the next status message. When a column change gives a load a different page size from the displayed page, the load moves the page index to the page holding the first row the old index pointed at. `state.rowsPerPage` stays the user's persisted choice. `state.pageSize` is the size the displayed page was loaded with, committed with its rows. Code that places a row in the whole result (row numbers, view row identities, clipboard) reads `getPageSize()` from `data-utils.js`, never `state.rowsPerPage`.

### Virtualized Grid

`grid-render.js` windows the data grid: only the visible rows plus 20 overscan rows per side are materialized in the `<tbody>`, between two `virtual-spacer` rows whose heights preserve exact scroll geometry (26px uniform rows; scrollHeight is byte-identical to a full render, so persisted scroll positions keep their meaning). Scroll/resize revalidation is rAF-throttled (`scheduleVirtualGridUpdate` hooked in grid-events, deliberately before the `isGridReloading` guard) and re-centers when the visible range drifts within 10 rows of a window edge, reusing overlapping row elements by identity. Pages within ~1.5 viewports (and unknown-viewport environments, including minimal test DOMs) render fully — byte-for-byte the pre-virtualization DOM. Pinned rows are always materialized. Code addressing a cell's DOM must tolerate absence or call `ensureGridCellMaterialized(rowIdx, colIdx)` first (match nav, keyboard navigation and `startCellEdit` do). While an inline edit's editor is live in the DOM the window freezes (`cleanupCellEdit` schedules the catch-up, which also heals a page committed under the render-skip); a leaked edit session whose editor DOM is gone must not freeze the window (`editorHoldsWindow`). A window move that removes the focused element parks focus on `#gridContainer` (`parkFocusLeaving`), which then shows a ring: its own border, always there and transparent until then. An outline drawn inside the container is painted over by whatever is positioned in it (it had a gap at every row line and cell text over its right and bottom edges), and `grid_edit_focus.test.ts` reads every pixel along all four edges; the data cell gets it back when a window builds it again, and an arrow key, Enter or Space pressed meanwhile acts on it (`takeParkedGridFocus`). The roving tab stop lives in `ctx.keyboardTarget`, which `setGridTabstop` updates through `noteGridKeyboardTarget`, so cells built later carry it. While that cell is out of the windows, `#gridContainer` holds the tab stop (`syncContainerTabStop`), and keyboard focus arriving on it from outside the grid goes on to the cell (`focusGridTabStop`); parking and a click on empty grid area leave it on the container, where an arrow key, Enter or Space acts on the tab stop's cell. Zebra striping is the `stripe-even` class keyed to the display ordinal, never `:nth-child` (spacers shift DOM parity).

Columns are windowed too, from 100 unpinned columns (`VIRTUAL_COLUMN_MIN_COUNT`) when the container has a measured width; narrower tables and minimal test DOMs keep the full DOM. A windowed data row holds its row number and pinned cells, a left `virtual-column-spacer` `<td>`, the unpinned columns around the viewport plus 10 per side, and a right spacer. The header keeps every column, and under `table-layout: fixed` the header's widths set the columns, so each spacer's `colSpan` covers exactly the columns it stands in for and scrollWidth matches a full render. A spacer for no column is `display: none`, because `colSpan` cannot be 0. Moving the window patches rows in place and keeps the cells still inside it, so a focused cell keeps focus; rows built later read the live bounds from `ctx.columnWindow`. A column width change without a re-render must call `noteColumnWidthsChanged()`. Because the spacers are `aria-hidden`, a windowed axis sets `aria-rowcount`/`aria-colcount` on the table and `aria-rowindex`/`aria-colindex` on every built row and cell (header row 1, row-number column 1); build rows and cells only through `buildDataRow`/`buildDataCell` so those stay right. `grid_column_window.test.ts` checks header alignment, scrolling, focus, editing, match navigation and resize in Chromium.

### Packed Grid Pages

UTF-8 table pages read one `sqlite_explorer_cell_pack()` BLOB per 100 values of each row (`src/core/cell-pack.ts`; C in `src/runtime/query-plan.c`) instead of the four per-cell helpers. WASM decodes the BLOBs in place from `Module.HEAPU8` via `Statement.prototype.sqliteExplorerPointer()`; `scripts/build-query-plan.mjs` adds both to the pinned sql.js source at build time (no fork commit), and the engine probes heap, accessor and pack function once at construction, logging what is missing. Native packs in the worker (`queryPacked`) and decodes on the host. Fixed per-cell descriptors make a wide page of short values several times its `queryNumeric` size, so past `nativeGridRowPack.maxBytes` (32 MiB, under the 64 MiB response cap that retires the worker) the worker returns nothing and the page is read through `queryNumeric`; so is any page with non-plain TEXT, which txiki decodes unlike sql.js. Switches: `WasmDatabaseEngine.gridRowPackTransport` (`wrapped` default; `direct` is opt-in because it keys on EXPLAIN QUERY PLAN wording, pinned by `grid_cell_pack.test.ts`) and `nativeGridRowPack.enabled`. Tests that compare the helpers with SQL containment turn packing off.

A packed REAL carries SQLite's own text for the value. `CellPackDecoder` compares that text with `String(value)` in place and keeps it, in `exactTexts`, only where the two differ; `realTextIsOwn` in `cell-pack.ts` decides a plain decimal of up to 15 significant digits from its bytes and leaves everything else to the comparison. The engines hand that map to the normalizer (`decodedExactTexts`) instead of a text column per row. In C, `cell_pack` writes the text with `sqlite3_snprintf("%!.*g", 17, …)` for a REAL below 2^53 in magnitude, which is what SQLite's own conversion produces, and converts any other value on a copy; the sanitizer driver compares every packed REAL text with `CAST(x AS TEXT)`. `grid_real_text_pages.test.ts` compares packed pages with unpacked ones and with `CAST(col AS TEXT)` on both engines, and `real_text_is_own.test.ts` checks the predicate against `String(value)`; re-run both after a SQLite upgrade, because they pin how SQLite writes a REAL (15 digits when they read back as the same double, otherwise 17).

### Blob Inspector

The Blob Inspector (`core/ui/modules/blob-inspector.js`) provides preview and editing for BLOB data:
- **Supported previews**: Images (PNG, JPEG, GIF, WebP), Audio (MP3, WAV, OGG, FLAC), Video (MP4, WebM, MOV), PDF, Text/JSON
- **Hex view**: Raw binary inspection
- **Download/Replace**: Save blobs to disk or upload new files
- Uses `backendApi` (not `hostBridge` directly) to ensure proper Uint8Array serialization

## Configuration

Settings in `package.json` → `contributes.configuration`:

| Setting | Default | Description |
|---------|---------|-------------|
| `sqliteExplorer.maxFileSize` | 200 | Max file size in MB (0 = unlimited) |
| `sqliteExplorer.defaultPageSize` | 5000 | Default page size for pagination |
| `sqliteExplorer.instantCommit` | "never" | Auto-save strategy (always/never/remote-only) |
| `sqliteExplorer.doubleClickBehavior` | "inline" | Double-click action (inline/modal/vscode) |
| `sqliteExplorer.fileOperations` | "native" | File I/O strategy (native/wasm) |
| `sqliteExplorer.queryTimeout` | 30000 | Query execution timeout in ms (prevents runaway queries) |
| `sqliteExplorer.maxUndoMemory` | 52428800 | Max undo history memory in bytes (default 50MB) |

## Gotchas

### SQL Security
- **LIKE wildcards**: User input in LIKE queries must use `escapeLikePattern()` with `ESCAPE '\\'` clause
- **SQL types in DDL**: Always validate with `validateSqlType()` to prevent injection via malicious type strings
- **NUL bytes**: Strings containing `\0` are written in exported SQL as quoted segments joined by `char(0)`, never as a raw NUL; past 100 NULs such a chain would pass SQLite's expression depth limit of 1000, so the text is one literal escaped for two `replace()` calls (`escapeSqlNulText` in `sql-utils.ts`); a `CAST(X'..' AS TEXT)` would be read in the target database's encoding

### RPC Serialization
- **Uint8Array becomes `{}`**: Never send raw Uint8Array via postMessage - use the marker format
- **Transfer for blobs**: Large binary data should use `Transfer` wrapper for zero-copy
- **Native wire format**: the bundled runtime (`tjs:v8`) reads V8's serialization format up to version 15. The extension host used to write its requests with its own V8's `v8.serialize`, and V8 15.0, which VS Code runs from 1.139 on (Electron 43), writes version 16; 1.110 to 1.138 write 15 (each release measured on Linux arm64). The runtime refused every request ("Data clone error"), so each open waited out its 30 seconds and fell back to WebAssembly, in 1.8.3 as well. Now `encodeNativeRequest` in `src/nativeRequestFormat.ts` writes every request itself, always as version 15, so the editor's V8 cannot change what the worker receives. It writes the kinds of value a request is made of (numbers, text, booleans, null, undefined, BigInts, `Uint8Array` and `Buffer`, arrays without gaps, plain objects, repeated references) with V8's and Node's own bytes; where V8 goes by how it holds a value in memory (a whole number held as a double, one-byte text held as two, an array that once had gaps) it picks one form, which the reader takes. Any other value is left to `v8.serialize` (`serializedByV8` in `nativeWorker.ts`, counted in `nativeRequestsWrittenByV8` and logged once), with a version 16 message labelled 15: version 16 only writes the lengths and offsets of ArrayBuffers and their views as 64-bit numbers (V8 commit `3f4cb1dd`), the same bytes below 4 GB. No request the extension makes takes that path; the native smoke, fuzz and desktop lanes fail if one does. A request the worker cannot read is answered as such, and `handleMessage` fails every request in flight at once with that reason. A new kind of value in a request needs a case in the writer and in `native_request_format.test.ts`, which compares its bytes with `v8.serialize` under Node. The worker still answers in version 15, which every V8 reads; the fork's writer must stay at 15 for VS Code 1.110 to 1.138. `native_wire_format.test.ts` runs the real engine with V8's serializer stamped as a version it cannot read. `npm run test:desktop:stable` runs the desktop lane on the current VS Code; the default lane runs the oldest supported version and cannot show a change in the editor's runtime.
- **Native integer binding**: V8 serializes a whole number in a double-typed array, such as `[28, 2.5]`, as a double, and txiki binds a double as REAL. txiki also refuses a BigInt in the int32 range, which WebAssembly history produces for every INTEGER. Pass every parameter array the native worker binds through `bindableParams()` in `natives/native-worker.js`; `native_number_binding.test.ts` compares the stored classes with WebAssembly

### Testing
- **VS Code mocks required**: Unit tests need `tests/unit/vscode_mock_setup.ts` imported first (path-mapped via `tsconfig.test.json`)
- **Where the tests keep their files**: tests that follow a save's snapshot by the name of its private directory use a folder under the temporary folder and ask for the route by name (`stagedSnapshotAccess.throughDescriptor = false`). Depending on the permissions of the checkout's folders a save can take another route, and tests that keep their scratch folder under the checkout's `.tmp` then follow routes they were not written for.
- **VS Code for the Web lane**: `npm run test:gui:web` (`tests/gui/web-save.mjs`) serves the built extension with `npx @vscode/test-web` and drives it with a headless Chromium: activation, the custom editor, edit, save twice, reopen, Save As to a new and to an existing file, and the web's own auto save. It covers `replaceWorkspaceFile`, which no other lane reaches. Set `WEB_COMMIT` to a VS Code commit to choose the build (1.110.0 is `0870c2a0c7c0564e7631bfed2675573a94ba4455`). Four things it had to learn: the server's host must be the name `localhost` (the extension host runs at a subdomain of it); the tool keeps writes in memory, so checks read the workspace through `vscode.workspace.fs` in the extension host, a worker of the page that a helper extension makes reachable; the editor's page registers a service worker in a cross-origin frame, which a browser profile that blocks third-party cookies refuses; and VS Code for the Web saves by itself a second after an edit
- **JSON patch tests**: Test behavior (merged result) not implementation (SQL function)
- **Test organization**: about 200 test files (about 2,900 tests) in `tests/unit/`, engine differential fuzzes in `tests/fuzz/`, the runtime's sanitizer driver in `tests/runtime/`, Electron host tests in `tests/desktop/`, benchmarks in `tests/benchmarks/`, performance tests in `tests/performance/`
- **Native real-binary smoke lane**: `tests/unit/native_real_smoke.test.ts` spawns the bundled txiki binary (`npm run test:native-smoke`; also part of the `npm test` glob, skips gracefully without a bundled binary). It guards native-only regressions that mocked-worker tests structurally cannot catch (reserved object names, statement-boundary behavior, edit round-trip integrity) — extend it when touching the native worker
- **Test runner**: Uses `tsx` with Node's built-in test runner (`npx tsx --tsconfig tsconfig.test.json --test tests/unit/*.test.ts`)
- **Readonly mock properties**: Use `Object.defineProperty(obj, prop, { value, writable: true, configurable: true })` for readonly VS Code API fields like `vscode.env.uiKind`
- **Windows**: the unit suite passes there with no helper. `vscode_mock_setup.ts` retries a recursive removal for up to five seconds, because a stopped worker's files stay undeletable for some tens of milliseconds (`SQLITE_EXPLORER_TEST_RM_STATS=1` prints how many removals waited and the longest wait per file). A test whose dispose asks the worker to close its database (`NativeWorkerProcess.end`, taken when the open left an empty `-wal`) must remove its folder with `fs.promises.rm`: the synchronous retry blocks the event loop that the worker's shutdown needs. Facts measured there that tests and code must not assume away: `chmod` only sets or clears read-only (0o640 and 0o600 both read back 0o666), a rename onto a file that any process has open fails with EPERM, the test's own process or another program (so a save that replaces the file tries again for 630 ms, see Saves Beside Another Program, then fails until that program closes it, and `refusedReplacement` in `fileReplacementMetadata.ts` words that error), a folder cannot be flushed (EPERM), a file's `ino` read with `bigint: true` is negative when its NTFS file ID has the top bit set, and `fs.mkdtemp` passes its prefix to Windows as it is, so a prefix past 260 characters fails with ENOENT unless it is given through `path.toNamespacedPath` (every other `fs` call does that itself).

### Workspace File System
- **`workspace.fs.rename` with `overwrite: true` is not a replace**: VS Code's file service deletes the destination and then renames (`doMoveCopy`). Onto an open database that removes the file for a moment, leaves no copy when the rename fails, and leaves the custom editor marked unsaved after a save that succeeded (seen in VS Code Web, stable and Insiders). Saves to a non-`file:` workspace go through `replaceWorkspaceFile` in `src/atomicWorkspaceWrite.ts`: a complete sibling copy first, then the existing destination written in place, and the copy removed only after that write succeeded; a new destination is created by a rename that cannot overwrite. `workspace_file_replace.test.ts` models the delete-then-rename behaviour.

### Platform Polyfills
- **`src/shims.ts` must be imported early**: Polyfills `Symbol.dispose`, `Symbol.asyncDispose`, `AbortSignal.throwIfAborted`, `Promise.withResolvers` for older VS Code runtimes that lack these APIs

### Build
- **WASM not found**: Run `node scripts/build.mjs` if `assets/sqlite3.wasm` is missing
- **Browser vs Node**: Check `import.meta.env.VSCODE_BROWSER_EXT` for environment-specific code
- **Query-plan runtime**: `src/runtime/query-plan.c` bounds plan compilation and extraction on the primary connection. `node scripts/build-query-plan.mjs` builds the five native libraries and the WASM runtime from that file and pinned sql.js commit `53f08bc0011b622f7462894dafd486990a32b63c` (the fork with upstream 1.16.0 merged) and SQLite amalgamation 3.54.1. SQLite's built-ins keep every function name and argument count they define. The builder patches the WASM amalgamation (`scripts/lib/sqlite-math-patch.mjs`, each replacement required to match exactly once) because the WASM libm differs from native libms in the last digit: see Math Functions in a Schema. It requires Emscripten 5.0.0 and the official Zig 0.16.0 release (`zig cc --version` must report `clang version 21.1.0`; distribution builds such as Homebrew's are refused); use `--emcc PATH` and optionally `--sqljs-source GIT_CHECKOUT`. The source checkout is read through `git archive` at the pin. `scripts/refresh-sqljs.mjs` delegates to this builder. Native Explain uses the primary connection's signalled `Database.allAsync` so cancel RPCs remain deliverable without losing TEMP or pending transaction state. `scripts/refresh-natives.mjs` pins the tested `master` commit, Actions run, and hashes for all five native targets.
- **Runtime sanitizer lane**: `npm run test:runtime-sanitizers` compiles `src/runtime/query-plan.c` with AddressSanitizer and UndefinedBehaviorSanitizer against the amalgamation the builder pins, drives it with `tests/runtime/query-plan-fuzz.c`, and then requires every injected defect in its mutation list (nine at present) to fail the same run. It also compiles the amalgamation as the WebAssembly build patches it (`scripts/lib/sqlite-math-patch.mjs`), with and without SQLite's own assertions, runs `tests/runtime/math-schema-driver.c` against it, and requires six defects injected into that patch to fail the driver: this C code otherwise runs only as WebAssembly. It needs any clang or gcc and `unzip`, not the pinned toolchain. Run it after any change to that file or to the patch, and keep both mutation lists in `scripts/test-runtime-sanitizers.mjs` matching the code they guard.
- **Runtime artifact gate**: `vendor/query-plan-manifest.json` records source and output hashes. Normal builds verify it before bundling. Regenerate runtime changes with the builder; do not edit native libraries, WASM/glue, or the manifest by hand. `node scripts/build-query-plan.mjs --check` verifies all copies.

## Extension Identifiers

```typescript
// src/config.ts
Ns = 'zknpr'
ExtensionId = 'sqlite-explorer'
FullExtensionId = 'zknpr.sqlite-explorer'
ConfigurationSection = 'sqliteExplorer'
UriScheme = 'sqlite-explorer'        // Virtual file system URI scheme
CopilotChatId = 'github.copilot-chat'
// Storage keys: FirstInstallMs, SidebarLeft, SidebarRight, FileNestingPatternsAdded
// Config accessors: getMaximumFileSizeBytes(), getQueryTimeout()
```

## Debugging

### Common Issues

1. **RPC timeout**: Check that message format matches expected protocol
2. **CSP errors**: Verify Content-Security-Policy in `editorController.ts`
3. **Worker not loading**: Check worker path resolution in `workerFactory.ts`
4. **WASM not found**: Ensure `assets/sqlite3.wasm` exists after build

### Logging

- Extension Host: Use `GlobalOutputChannel?.appendLine()` (not `console.log`). Output appears in "SQLite Explorer" output channel.
- Worker: Logs route via RPC `LogEnvelope` to "SQLite Explorer" output channel (View → Output → SQLite Explorer)
- Webview: Use browser DevTools (Cmd+Shift+P → "Developer: Open Webview Developer Tools")

## Development Workflow

1. Make changes to source files
2. Run `node scripts/build.mjs` to compile
3. Press F5 in VS Code to launch Extension Development Host
4. Open a `.sqlite` or `.db` file to test

## Dependencies

- **sql.js**: WebAssembly SQLite implementation (MIT license)
- **@vscode/codicons**: VS Code icon font
- **esbuild**: Fast bundler for extension and worker
- **TypeScript**: 6.0.2 (requires `"types": ["node"]` in tsconfig.json)
