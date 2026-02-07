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
| `src/editorController.ts` | Custom editor provider (DatabaseViewerProvider, DatabaseEditorProvider) |
| `src/databaseModel.ts` | Document model (DatabaseDocument), undo/redo, save/revert |
| `src/workerFactory.ts` | Worker instantiation, connection setup, file reading |
| `src/databaseWorker.ts` | Worker entry point, exposes database operations |
| `src/hostBridge.ts` | HostBridge - functions exposed to webview (exec, export, etc.) |
| `src/core/types.ts` | Core type definitions (CellValue, RecordId, QueryResultSet, etc.) |
| `src/core/rpc.ts` | RPC utilities (buildMethodProxy, processProtocolMessage) |
| `src/core/sqlite-db.ts` | Database engine wrapper |
| `src/core/query-builder.ts` | Safe SQL query construction |
| `src/core/sql-utils.ts` | SQL utilities and escaping |
| `src/core/undo-history.ts` | ModificationTracker for undo/redo |
| `src/virtualFileSystem.ts` | Virtual FS provider for editing cells in tabs |
| `src/loggingDatabaseOperations.ts` | Decorator for logging SQL queries |
| `core/ui/modules/settings.js` | UI logic for database settings/pragma editor |
| `core/ui/modules/web-api.js` | Web demo API module (parent window communication) |
| `core/ui/viewer.html` | Standalone webview UI |
| `core/ui/web-viewer.js` | Web demo entry point |
| `website/app/demo/page.tsx` | Web demo React page |
| `website/public/demo/worker.js` | Web demo SQLite worker |
| `website/public/demo/viewer.html` | Web demo bundled viewer |
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
`Uint8Array` cannot be directly serialized via `postMessage` (becomes `{}`). The RPC layer uses a marker format:
```javascript
// Serialized format (safe for JSON)
{ __type: 'Uint8Array', data: [72, 101, 108, 108, 111] }

// Security: Marker must have exactly 2 keys (__type, data) to prevent collision with user data
```
- Webview serializes in requests, deserializes in responses (`core/ui/modules/api.js`)
- Extension host deserializes in requests, serializes in responses (`src/editorController.ts`)

## Security Standards

### Content Security Policy (CSP)
- **Scripts**: Strict nonce-based policy. No `'unsafe-inline'` allowed.
- **Styles**: No `'unsafe-inline'` allowed. Dynamic inline styles are applied via CSSOM (`element.style.prop = ...`) which is permitted by CSP with `'self'`.
- **Isolation**: Webview communicates only via RPC.

### Cross-Site Scripting (XSS) Prevention
- **Grid Rendering**: Always use `textContent` for cell values. Never use `innerHTML` with untrusted data.
- **Formatting**: Use `formatCellValueAsText()` for safe display strings.

### SQL Injection Prevention
- **Query Parameters**: Use prepared statements (`?` placeholders) for all values.
- **Identifiers**: Always use `escapeIdentifier()` for table/column names.
- **Schema Validation**: Use `validateSqlType()` for all user-provided SQL types in DDL.

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
- `out/worker.js` - Node.js worker
- `out/worker-browser.js` - Browser worker
- `core/ui/viewer.html` - Webview UI
- `website/public/demo/viewer.html` - Web demo viewer (bundled)
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

### Inline Cell Editing

The webview handles inline editing:
1. Double-click cell → Creates input overlay
2. Enter key → `saveCellEdit()` sends UPDATE via `backendApi.exec()`
3. Escape key → `cancelCellEdit()` discards changes

### Virtual File System

The extension registers a `FileSystemProvider` to allow editing cell contents in full VS Code editors:
1. `hostBridge.openCellEditor()` opens a custom URI.
2. `SQLiteFileSystemProvider.readFile()` queries the cell data.
3. `SQLiteFileSystemProvider.writeFile()` triggers `document.databaseOperations.updateCell()`.

### SQL Logging

Database operations are wrapped in `LoggingDatabaseOperations` which writes all executed SQL (both read and write) to the "SQLite Explorer" output channel for debugging.

### Settings & Pragmas

The webview provides a UI to configure SQLite PRAGMAs (e.g., WAL mode, Foreign Keys) directly via `hostBridge.setPragma()`.

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
| `sqliteExplorer.maxRows` | 0 | Max rows to display (0 = unlimited) |
| `sqliteExplorer.defaultPageSize` | 500 | Default page size for pagination |
| `sqliteExplorer.instantCommit` | "never" | Auto-save strategy (always/never/remote-only) |
| `sqliteExplorer.doubleClickBehavior` | "inline" | Double-click action (inline/modal/vscode) |
| `sqliteExplorer.queryTimeout` | 30000 | Query execution timeout in ms (prevents runaway queries) |
| `sqliteExplorer.maxUndoMemory` | 52428800 | Max undo history memory in bytes (default 50MB) |

## Gotchas

### SQL Security
- **LIKE wildcards**: User input in LIKE queries must use `escapeLikePattern()` with `ESCAPE '\\'` clause
- **SQL types in DDL**: Always validate with `validateSqlType()` to prevent injection via malicious type strings
- **NUL bytes**: Strings containing `\0` must be encoded as hex blobs in exported SQL

### RPC Serialization
- **Uint8Array becomes `{}`**: Never send raw Uint8Array via postMessage - use the marker format
- **Transfer for blobs**: Large binary data should use `Transfer` wrapper for zero-copy

### Testing
- **VS Code mocks required**: Unit tests need `tests/mocks/vscode.ts` imported first
- **JSON patch tests**: Test behavior (merged result) not implementation (SQL function)

### Build
- **WASM not found**: Run `node scripts/build.mjs` if `assets/sqlite3.wasm` is missing
- **Browser vs Node**: Check `import.meta.env.VSCODE_BROWSER_EXT` for environment-specific code

## Extension Identifiers

```typescript
// src/config.ts
Ns = 'zknpr'
ExtensionId = 'sqlite-explorer'
FullExtensionId = 'zknpr.sqlite-explorer'
ConfigurationSection = 'sqliteExplorer'
```

## Debugging

### Common Issues

1. **RPC timeout**: Check that message format matches expected protocol
2. **CSP errors**: Verify Content-Security-Policy in `editorController.ts`
3. **Worker not loading**: Check worker path resolution in `webWorker.ts`
4. **WASM not found**: Ensure `assets/sqlite3.wasm` exists after build

### Logging

- Extension Host: `console.log()` appears in VS Code Developer Tools
- Worker: `console.log()` appears in Extension Host output
- Webview: Use browser DevTools (Cmd+Shift+P → "Developer: Open Webview Developer Tools")

## Development Workflow

1. Make changes to source files
2. Run `node scripts/build.mjs` to compile
3. Press F5 in VS Code to launch Extension Development Host
4. Open a `.sqlite` or `.db` file to test

## Testing Checklist

- [ ] Open database file
- [ ] View tables in sidebar
- [ ] Auto-select first table on load
- [ ] Click table rows to select
- [ ] Double-click cells to edit
- [ ] Verify pinned columns stay attached during horizontal scroll
- [ ] Add new rows
- [ ] Delete selected rows
- [ ] Undo/redo operations
- [ ] Save changes (Ctrl+S)
- [ ] Export table to CSV/JSON/SQL
- [ ] Reload database from disk

## Dependencies

- **sql.js**: WebAssembly SQLite implementation (MIT license)
- **@vscode/codicons**: VS Code icon font
- **esbuild**: Fast bundler for extension and worker
