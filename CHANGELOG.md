# Changelog

## 1.3.1

### Improvements

- **Sidebar Filter**: Added a filter input to the sidebar that lets you search tables, views, and indexes by name. Useful for databases with many tables. Badge counts show filtered/total when a filter is active.

## 1.3.0

### Security

- **SQL Wildcard Injection Prevention**: Added `escapeLikePattern()` function to escape `%`, `_`, and `\` characters in LIKE queries. Prevents attackers from crafting inputs that cause expensive full table scans or bypass filters. All filter queries now use `ESCAPE '\\'` clause.
- **NUL Byte Escaping**: Fixed potential SQL injection via NUL characters in exported SQL strings. Strings containing `\0` are now encoded as hex blobs with `CAST(X'...' AS TEXT)`.
- **JSON Merge Patch Stack Overflow**: Added `MAX_DEPTH=1000` limit to prevent stack overflow from malicious or deeply nested JSON data.
- **Unbounded Undo History Memory**: Added `maxMemory` limit (50MB default) to undo history to prevent memory exhaustion on long editing sessions.
- **CSP Hardening**: Removed unsafe inline styles from webview HTML, extracting 20+ inline styles to CSS classes for stricter Content Security Policy compliance.

### Performance

- **Query Timeout Protection**: Added 30-second query timeout using `iterateStatements` API. Prevents runaway queries from freezing the extension. Timeout is checked during row iteration for interruptible execution.
- **Async File Operations**: Converted synchronous `fs.existsSync` and `readFileSync` calls to async equivalents in native worker, preventing main thread blocking.
- **Batch Undo Operations**: Undo/redo for batch cell updates now uses `updateCellBatch` instead of individual transactions, significantly improving performance.
- **Batch Row Insertions**: Added `insertRowBatch` for bulk row operations, respecting SQLite's 999 parameter limit.
- **Optimized Pragma Fetching**: Added `queryBatch` for fetching multiple pragmas in a single IPC round-trip.
- **Native JSON Patch**: Uses SQLite's native `json_patch()` function when available, with JS fallback for older versions.

### Improvements

- **Type Safety**: Replaced `any[]` with proper `Transferable[]` types throughout the RPC layer, removing `@ts-ignore` comments.
- **Memory Leak Fix**: Fixed listener leak in `cancelTokenToAbortSignal` by properly disposing the cancellation listener after abort.
- **Table Existence Validation**: Virtual file system now validates table/view existence before attempting cell reads.
- **Configurable Query Timeout**: Added `sqliteExplorer.queryTimeout` setting (default 30s) to control query execution timeout.
- **Configurable Undo Memory**: Added `sqliteExplorer.maxUndoMemory` setting (default 50MB) to control undo/redo history memory limit.
- **Full CSP Compliance**: Removed all `'unsafe-inline'` usage from both scripts and styles. Dynamic styles now use CSSOM which is CSP-compliant.

### Refactoring

- **Extracted Serialization Module**: Moved RPC serialization utilities to `src/core/serialization.ts` for reuse.
- **WebviewMessageHandler**: Extracted webview message handling to dedicated class for better separation of concerns.
- **Query Builder DRY**: Extracted `buildFilterConditions` helper to eliminate duplicated filter logic between SELECT and COUNT queries.
- **Undo/Redo Refactor**: Extracted undo operations into private methods (`undoCellUpdate`, `undoRowInsert`, etc.) for better readability.
- **BlobInspector Cleanup**: Removed unused `hostBridge` constructor parameter, using `backendApi` consistently.
- **Worker Endpoint Cleanup**: Removed redundant operations proxy object from worker endpoint initialization.
- **Type Definitions**: Added `WasmPreparedStatement` interface replacing `any` types for sql.js statements.

### Testing

- **New Test Suites**: Added comprehensive tests for:
  - `ModificationTracker` serialization/deserialization
  - `cancelTokenToAbortSignal` utility
  - `WebviewCollection` management
  - `getUriParts` URI parsing
  - `WasmDatabaseEngine.updateCellBatch` batch operations
  - `WasmDatabaseEngine.addColumn` column creation
  - `toDatasetAttrs` HTML attribute generation
  - `SQLiteFileSystemProvider` read/write operations
  - `escapeLikePattern` wildcard escaping
  - RPC `Transfer` wrapper handling
- **VS Code Mocks**: Added comprehensive VS Code API mocks for unit testing extension code.
- **Test Configuration**: Added `tsconfig.test.json` for proper test compilation with mock paths.

## 1.2.7

### Bug Fixes

- **VS Code Web Worker Loading**: Fixed database files not loading in VS Code Web. Web Workers cannot load scripts from `vscode-vfs://` URIs directly. Now uses the VS Code workspace.fs API to read the worker script and creates a Blob URL for Worker instantiation.

## 1.2.6

### Bug Fixes

- **VS Code Web Compatibility**: Fixed extension failing to load in VS Code Web (vscode.dev) with "Cannot use import statement outside a module" error. The browser extension bundle was incorrectly built with ESM format, which VS Code Web's extension host cannot evaluate. Changed build output to IIFE format for proper compatibility.

### Performance

- **Web Demo Static Generation**: Fixed slow page loads for the `/demo` page by enabling static generation. The page is now pre-rendered at build time and served from Vercel's edge CDN, eliminating serverless function cold starts. This dramatically improves TTFB and FCP, especially for users in distant regions (e.g., Japan saw 8.35s FCP reduced to sub-second loads).

## 1.2.5

### Bug Fixes

- **Blob Upload Freeze**: Fixed UI freezing during blob uploads caused by debug logging that serialized binary data as massive JSON strings. Large blob uploads now complete in under 1 second instead of 15+ seconds.
- **Upload State Management**: Added proper state tracking for drag-and-drop blob uploads to prevent concurrent operations and ensure UI recovery after failed uploads.

### Performance

- **Zero-Copy Blob Transfer**: Added `Transfer` wrapper for blob operations from extension host to worker, eliminating buffer copying for large binary data.
- **Async Base64 Encoding**: Converted synchronous Base64 encoding to async chunked encoding with event loop yields, keeping the UI responsive during large blob serialization.

## 1.2.4

### New Features

- **Blob Inspector**: Added comprehensive blob preview and editing modal:
  - **Image Preview**: View PNG, JPEG, GIF, BMP, and WebP images directly in the inspector
  - **Audio Preview**: Play MP3, OGG, WAV, and FLAC audio files with native controls
  - **Video Preview**: Play MP4, WebM, MOV, and AVI video files with native controls
  - **PDF Preview**: View PDF documents inline with download fallback
  - **Text/JSON Preview**: View and format text and JSON content
  - **Hex View**: Inspect raw binary data in hex dump format
  - **Download**: Save any blob to disk with auto-detected file extension
  - **Replace**: Upload a new file to replace existing blob data

### Bug Fixes

- **Blob Replace**: Fixed blob replacement failing with empty data. The issue was caused by `Uint8Array` being serialized to `{}` (empty object) during RPC postMessage communication. Implemented proper serialization/deserialization for both request and response payloads.

### Technical

- **RPC Serialization**: Added bidirectional `Uint8Array` serialization in the RPC layer:
  - Webview serializes `Uint8Array` in requests and deserializes in responses
  - Extension host deserializes `Uint8Array` in requests and serializes in responses
  - Uses `{__type: 'Uint8Array', data: [...]}` marker format for safe JSON transmission
  - Security: Marker objects must have exactly `__type` and `data` keys to prevent collision with user data

## 1.2.3

### Bug Fixes

- **Revert Functionality**: Fixed a critical bug where the "Revert File" action was not actually rolling back data. Implemented the missing `discardModifications` logic in both WASM and Native backends to ensure changes are properly undone.
- **Large File UX**: Added an explicit error message when opening files larger than `sqliteExplorer.maxFileSize` (default 200MB), instead of silently loading an empty database.
- **Extension Lifecycle**: Fixed a bug where closing a single database tab would inadvertently dispose the entire editor provider, breaking the extension for subsequent file opens.

### Security

- **Asset Integrity**: Hardened the extension package by bundling Codicons font assets directly into the `assets/` directory instead of referencing `node_modules` at runtime. This improves stability and aligns with VS Code packaging best practices.

### Maintenance

- **Test Coverage**: Added comprehensive test suites for `revert` logic and JSON Merge Patch (RFC 7396) utilities, increasing test count from 25 to 39.
- **Web Demo**: Updated the web demo build to use the correct version of `@vscode/codicons` (0.0.44) to match the extension.

## 1.2.2

### Security

- **Web API Hardening**: Restricted `postMessage` communication in the Web API module to trusted origins, preventing unauthorized access when embedded in untrusted contexts.
- **XSS Prevention**: Refactored the Data Grid rendering logic to use `textContent` instead of `innerHTML`. This eliminates Cross-Site Scripting (XSS) risks from malicious database content.
- **SQL Injection Prevention**: Implemented strict validation for SQL types in DDL statements (`CREATE TABLE`, `ALTER TABLE`, `ADD COLUMN`). Column definitions are now validated against a safe pattern to prevent injection attacks.
- **Form Safety**: Added explicit `type="button"` attributes to all UI buttons to prevent accidental form submissions.

### Maintenance

- **Type Safety**: Enhanced TypeScript type safety in `HostBridge` by removing `any` casts and improving `DatabaseOperations` interfaces.
- **Documentation**: Updated `CLAUDE.md` with comprehensive security standards regarding CSP, XSS prevention, and SQL injection hardening.

## 1.2.1

### Improvements

- **Enhanced Grid Selection**:
  - Added range selection for rows and columns using `Shift + Click`.
  - Added multi-range selection for rows and columns using `Cmd/Ctrl + Shift + Click`.
  - Prevented default browser text selection highlight (blue background) when selecting cells, rows, or columns.

### Maintenance

- **Dependency Updates**: Updated core dependencies including `react-dom`, `@vscode/extension-telemetry`, and build tools.
- **Engine Update**: Bumped minimum VS Code engine requirement to `^1.108.1` to match type definitions.

## 1.2.0

### New Features

- **Web Demo**: Added a standalone web preview at `/demo` on the website. Users can now try SQLite Explorer directly in their browser without installing the VS Code extension.
  - Upload your own SQLite databases via drag-and-drop or file picker
  - Try sample databases (Chinook, Northwind)
  - Full editing capabilities (CRUD operations, cell editing)
  - All processing happens client-side using WebAssembly - no data is sent to servers
  - Download modified databases back to your computer

### Website

- Added "Try in Browser" button to the hero section linking to the web demo
- Bundled sample databases for the demo (Chinook ~1MB, Northwind ~25MB)

## 1.1.7

### Security

- **Workspace Isolation**: Enforced stricter file access controls. The extension now prevents reading files outside the current workspace when using drag-and-drop or URI uploads, mitigating arbitrary file read vulnerabilities.
- **Enhanced Log Sanitization**: Implemented comprehensive PII masking in the Output channel. The following patterns are now automatically redacted in SQL logs:
  - Email addresses
  - Phone numbers (various formats)
  - API keys and tokens (sk_live_, api_key_, etc.)
  - Long hex strings (potential secrets/hashes)
  - Credit card numbers
  - Social Security Numbers (SSN)
  - BLOBs and long strings are truncated to prevent data leakage
- **CSP Documentation**: Added security documentation explaining the current CSP configuration and XSS mitigations (escapeHtml, escapeIdentifier).

## 1.1.6

### New Features

- **Comprehensive Undo/Redo**: Added full support for undoing and redoing all operations including row/column creation and deletion, batch updates, and drag-and-drop.
- **Smart Delete**: `Cmd+Delete` (or `Ctrl+Delete`) now intelligently deletes selected columns or rows, or clears selected cells if no structure is selected.

### Performance

- **Large Export Optimization**: Implemented streaming and keyset pagination for table exports, preventing OOM crashes on large datasets.
- **Rendering Optimization**: Refactored data grid rendering to use `DocumentFragment` for reduced DOM thrashing.
- **Batch Update Optimization**: Refactored `applyBatchUpdate` to parse JSON patches once per column instead of per cell.

### Bug Fixes

- **JSON Visualization**: Fixed double-escaping of HTML entities in the data grid, ensuring JSON objects display correctly.
- **Pinned Highlighting**: Improved visual styling for pinned rows and columns to maintain legibility when selected.

### Maintenance

- **Cleanup**: Removed dead code, unused RPC methods (`enterAccessTokenCommand`, `downloadBlob`), and unused files (`batch.js`).
- **Dependency Cleanup**: Removed unused `@workers/v8-value-serializer` and moved `@vscode/vsce` to devDependencies.
- **Refactoring**: Converted internal monologue comments to professional documentation.

## 1.1.5

### Bug Fixes

- **Fixed Export Table Crash**: Resolved a `ReferenceError` when exporting tables caused by accessing the file URI before initialization. The export dialog now correctly prompts for a destination before processing.

### Performance

- **Zero-Copy Data Transfer**: Implemented `Transfer` wrapper for RPC to enable zero-copy transfer of ArrayBuffers between extension host and worker. This significantly reduces memory usage and startup time when opening large databases.
- **Optimized Batch Updates**: Rewrote the batch update logic in the sidebar to use O(N) lookup instead of O(N*M), dramatically improving performance when updating many rows simultaneously.
- **Efficient Query Execution**: Refactored `fetchTableData` and JSON patch operations to reuse prepared statements and avoid unnecessary intermediate object allocation.

### Improvements

- **Drag & Drop**: Relaxed security restrictions on `readWorkspaceFileUri` to allow dropping files from VS Code's "Open Editors" view or when running in Single File mode.

### Maintenance

- **Refactoring**: Extracted `DocumentRegistry` to a separate file to resolve circular dependencies and improve code organization.
- **Cleanup**: Removed unused core modules.

## 1.1.4

### Bug Fixes

- **Fixed Sticky Column Headers Transparency**: Resolved a visual bug where sticky column headers would become transparent when hovered or selected, causing the data scrolling underneath to show through. The headers now maintain their opacity while correctly displaying hover and selection states.

## 1.1.3

### Security

- **Strict Table Creation**: `createTable` now requires structured column definitions instead of raw strings. This prevents potential SQL injection vulnerabilities where malicious column definitions could be passed to the table creation query.
- **Workspace Isolation**: `readWorkspaceFileUri` now validates that the requested file is located within the current workspace folder, preventing unauthorized access to files outside the project scope.

### Bug Fixes

- **Fixed Pinned Column Layout**: Resolved an issue where pinned columns would detach from the left border when horizontal scrolling was active. Fixed sticky positioning logic in the data grid to ensure headers and rows stay correctly aligned.

## 1.1.2

### Performance
- **Optimized Large File Handling**: Loading and saving large databases in VS Code Desktop now bypasses the extension host memory buffer, significantly reducing RAM usage and preventing crashes with large files (200MB+). Native backend now uses `VACUUM INTO` for atomic saves.
- **Faster Batch Updates**: Cell updates are now grouped into a single transaction with prepared statements, drastically improving performance when updating multiple rows.
- **Efficient Schema Loading**: Combined multiple schema queries into a single round-trip to the worker thread.

### UI/UX
- **Scrollable Sidebar**: The table/view list is now independently scrollable, ensuring the explorer header and configuration footer remain accessible even with hundreds of tables.
- **Selection Clearing**: Pressing `Esc` key now unselects any highlighted cells or rows in the data grid.

### Maintenance
- **Cleanup**: Removed dead code, unused exports, and redundant polyfills to reduce bundle size and improve maintainability.


## 1.1.1

### New Features

- **Virtual File System Integration**: Edit cell contents in a full VS Code editor tab. Perfect for large JSON blobs, SQL queries, or extensive text data. Saving the file automatically updates the database.
- **Batch Updates**: New sidebar panel allows updating specific columns for multiple selected rows simultaneously.
- **Database Settings Editor**: A new UI to inspect and configure SQLite pragmas (Journal Mode, Foreign Keys, Synchronous, Cache Size, etc.) and extension preferences.
- **Drag & Drop Binary Upload**: Drag files from your OS or VS Code Explorer directly onto a cell to upload them as BLOB data.
- **Smart JSON Patching**: Edits to JSON cells now use **RFC 7396 Merge Patching**, sending only the specific changes to the database rather than rewriting the entire string.
- **SQL Query Logging**: View all executed SQL queries (Reads and Writes) in the VS Code Output panel for debugging and auditing.

### Improvements

- **Export Options**: Added granular controls to export dialogs (Include/Exclude headers for CSV/Excel, Toggle Table Name for SQL).
- **Export Selection**: Added ability to export only the currently selected rows.
- **Auto-Open JSON**: The editor now detects JSON content and offers to open it in a specialized preview or VS Code editor.

### Security

- **Dependency Updates**: Updated various dependencies to patch known security vulnerabilities and improve stability, including `brace-expansion`, `semver`, `lodash`, `qs`, and `minimist`.


## 1.1.0

- **Security**: Moved SQL generation for write operations (UPDATE, INSERT, DELETE) from the frontend to the backend to prevent SQL injection risks.
- **Security**: Centralized SQL escaping logic in `src/core/sql-utils.ts`.
- **Security**: Pinned GitHub Actions dependencies to specific commit hashes.
- **Architecture**: Refactored the monolithic `viewer.js` into modular components (`core/ui/modules/`) for better maintainability.
- **Build**: Updated build system to bundle frontend modules using `esbuild`.
- **Fix**: Resolved visual regression in cell editing mode where input styling was missing.
- **Fix**: Resolved "not a function" error during cell updates in native backend by using explicit `run` command for write operations.
- **Fix**: The export table dialog now defaults to the directory containing the database file, rather than the workspace root.
- **Docs**: Added "Buy Me a Coffee" link to the README and package configuration.

## 1.0.11

### Security

- **Fixed SQL injection in webview queries**: The frontend viewer now uses `escapeIdentifier()` for all table and column names in SQL queries (SELECT, INSERT, UPDATE, DELETE, ALTER TABLE, CREATE TABLE, PRAGMA). Previously, table names containing double quotes like `my"table` would cause syntax errors or potential SQL injection.

- **Fixed rowId injection vulnerability**: All SQL queries that use `rowid` in WHERE clauses now validate that the value is a finite number using `validateRowId()`. This prevents a compromised webview from injecting malicious SQL via crafted rowId values. Affected: `viewer.js` (UPDATE, DELETE queries), `nativeWorker.ts` (undo/redo operations).

### Bug Fixes

- **Fixed binary data serialization in undo history**: The main undo/redo tracker (`src/core/undo-history.ts`) now properly serializes `Uint8Array` (BLOB data) using base64 encoding. This ensures undo/redo works correctly when editing binary cells.

## 1.0.10

### Security

- **Fixed XSS vulnerability in schema names**: The `escapeHtml` function now escapes single quotes (`'` → `&#39;`), preventing DOM-based XSS attacks through malicious table or column names. Previously, a table named `user'); alert('XSS'); //` could execute arbitrary JavaScript when rendered in the sidebar.

- **Fixed SQL injection in identifier escaping**: Table and column names are now properly escaped by doubling internal double quotes (SQL standard). Previously, identifiers like `table"--DROP TABLE other` could break out of the quoted context. Affected: `nativeWorker.ts` (undo/redo), `tableExporter.ts` (export queries).

- **Fixed RPC prototype pollution**: The RPC message handler now uses `hasOwnProperty` check before invoking methods, preventing attackers from calling Object prototype methods like `constructor` or `__proto__`.

- **Fixed path traversal in downloadBlob**: Filenames are now sanitized using `path.basename()` to prevent writing files outside the intended directory. Previously, a filename like `../../etc/passwd` could write to arbitrary locations.

- **Fixed binary data serialization**: The undo/redo history tracker now properly serializes `Uint8Array` (BLOB data) using base64 encoding. Previously, `JSON.stringify` would corrupt binary data by converting it to `{"0": 1, "1": 2, ...}`.

- **Improved write operation detection**: SQL write detection now handles leading comments (`/* */`, `--`) and CTEs (`WITH ... AS`). Previously, queries like `/* log */ INSERT INTO...` would not be detected as write operations.

### Bug Fixes

- **Native SQLite fallback to WASM**: When the native SQLite backend fails to open a specific file (e.g., due to macOS sandboxing, permission issues, or file locks), the extension now automatically falls back to the WASM backend instead of showing an error. This fixes "SQLite error 14: unable to open database file" on macOS.

## 1.0.9

### Bug Fixes

- **Scroll position preserved when filtering**: Column filtering no longer resets the horizontal/vertical scroll position. When filtering columns on the far right of a wide table, the view now stays in place after the table re-renders.

## 1.0.8

### Improvements

- **Column widths fit titles**: Column widths are now calculated based on the column name length, ensuring headers are fully visible. Long column names are truncated with ellipsis (max 250px).
- **Default page size reduced**: Default rows per page changed from 1000 to 500 for better performance on large tables.
- **Simplified page size options**: Removed 5000 and 10000 row options to prevent performance issues. Options are now 100/250/500/1000.

### Internal

- Refactored webview into separate source files (HTML template, CSS, JavaScript) for better maintainability. The build process bundles and minifies them into a single HTML file.

## 1.0.7

### New Features

- **Primary key indicator**: Column headers now display a key icon for primary key columns, making it easy to identify primary keys at a glance.

### Improvements

- **Manual column filter**: Filters now require pressing Enter or clicking the search button to apply, instead of auto-filtering while typing. This provides better control and avoids unnecessary queries.

### Bug Fixes

- Fixed column filter returning no results causing headers to disappear, leaving users stuck with no way to clear the filter. Now shows a "No rows match the current filter" message while keeping filter inputs accessible.
- Fixed "n.on is not a function" error when opening databases in VS Code Web. The browser worker communication now correctly uses addEventListener instead of Node.js-style .on() method.

## 1.0.6

### Bug Fixes

- Fixed icons not showing

## 1.0.5

### New Features

- **Fully customizable column widths**: Columns can now be resized to any width (minimum 30px). Resize handle extends beyond cell border for easier grabbing on narrow columns.
- **Cell preview modal**: Click the expand icon on truncated cells to view and edit full content in a floating window. Includes JSON formatting, word wrap toggle, and character count.
- **Delete columns**: Select a column (click header selection icon) and press Delete button to remove the column and all its data.
- **Clear cell values (Cmd+Delete / Ctrl+Delete)**: Select cells and press Cmd+Delete (Mac) or Ctrl+Delete (Windows/Linux) to clear their values to NULL (or empty string for NOT NULL columns).

### Improvements

- Resize handle is now 10px wide with 4px extension beyond cell border for easier grabbing
- Column width minimum reduced from 60px to 30px for compact display
- Delete button now works for both row and column deletion

## 1.0.4

### Bug Fixes

- Fixed "no such column: rowid" error when viewing SQL views
- Views now display correctly (read-only, as SQLite views don't have rowid)

## 1.0.3

### New Features

- Column selection: Click on column header to select all cells in a column
- Cmd/Ctrl+Click on column header to add column to existing selection
- Visual indicator on column header when entire column is selected

## 1.0.2

### New Features

- Multi-cell selection with Cmd+Click (Mac) / Ctrl+Click (Windows/Linux)
- Range selection with Shift+Click
- Add to selection with Cmd+Shift+Click / Ctrl+Shift+Click
- Copy multiple cells to clipboard as tab-separated values

## 1.0.1

### Bug Fixes

- Fixed telemetry error when connection string is empty
- Fixed spam-clicking on cell borders preventing editing
- Fixed cell selection blocking edit mode on other cells
- Fixed empty column values showing 'undefined' instead of NULL
- Improved cell selection speed (reduced debounce from 200ms to 80ms)
- Added comprehensive error handling to prevent UI from breaking
- Added failsafe timeout to recover from stuck states

## 1.0.0

- Initial release
- View SQLite databases directly in VS Code
- Browse tables, views, and indexes
- Inline cell editing with double-click
- Sorting and filtering
- Pagination for large tables
- VS Code theme integration
