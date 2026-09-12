# SQLite Explorer

A powerful, open-source SQLite database viewer and editor for Visual Studio Code.

**[Try it in your browser](https://sqlite-explorer.zknpr.xyz/demo)** | **[Website](https://sqlite-explorer.zknpr.xyz/)** | **[Changelog](CHANGELOG.md)**

![SQLite Explorer](media/main.png)

## Demos

### Inline Editing
Double-click any cell to edit. Add new rows and delete existing ones with ease.

![Inline Editing](media/edit_cells_add_delete_rows.gif)

### Pin Columns
Keep important columns visible while scrolling horizontally through wide tables.

![Pin Columns](media/pin_colums.gif)

### Pin Rows
Pin rows to the top for easy reference while navigating through data.

![Pin Rows](media/pin_rows.gif)

### Large Tables
Handle tables with thousands of rows smoothly with pagination.

![Large Tables](media/large_tables.gif)

## Features

### Database Viewing
- **Open SQLite files directly** — Supports `.sqlite`, `.db`, `.sqlite3`, `.db3`, `.sdb`, `.s3db`, and `.gpkg` formats
- **Schema browser** — Explore tables, views, and indexes in a sidebar with search filtering
- **Pagination** — Navigate large datasets with configurable page sizes (100–10,000 rows)
- **Tri-state column sorting** — Click headers to cycle none → ascending → descending
- **Column & global filtering** — Per-column search and full-table text search, with match highlighting and Enter / Shift+Enter navigation between matches
- **View management** — Create, edit, and drop views from the sidebar; definitions are validated and previewed before saving, and edits open in a real VS Code editor tab
- **Exact 64-bit integers** — Values beyond JavaScript's safe range display, edit, filter, and export losslessly
- **Pin columns & rows** — Keep important data visible while scrolling
- **SQL logging** — Inspect grid and editing operations in the VS Code Output panel; SQL workspace text and parameter values are excluded

### SQL Workspace
- **New SQL Query** — Click **SQL Query** in the database sidebar to open a SQL editor bound to that database, or use the Command Palette. Run and Explain buttons appear in the SQL editor toolbar. Use normal `.sql` files and VS Code Save/Save As for saved queries.
- **Run Query** — Executes the selection, or the whole document when nothing is selected. Supports one read-only SELECT/CTE, with schema completions and positional `?` / `?NNN` parameters supplied as a JSON array.
- **Explain Query Plan** — Shows SQLite's plan for the original selection/query and supplied parameters without executing it. Works with native and WASM, including read-only databases, TEMP tables, and pending schema changes.
- **Bounded results** — Shows up to 1,000 rows in a read-only CSV document with execution time, exact integer text, and explicit cell-preview markers. Result values have a 4 MiB transport budget. Export Query Results saves the displayed rows atomically; use table export for complete datasets.
- **Session history** — Reopen recent query text or clear it. Bound parameter values are excluded; query text remains only in the current extension session.
- **Database binding** — Choose Query Database explicitly changes the destination for a SQL document. Closing that database invalidates its binding.

Query text and parameter input are each limited to 65,536 characters, with at most 100 parameters and 128 result columns. Plans show up to 1,000 entries; the runtime limits each detail to 65,536 UTF-8 bytes and the result to 4 MiB before JavaScript extraction. It also limits compilation and restores the connection's limits afterward. Supply large integers as quoted strings and use `CAST(? AS INTEGER)` to preserve their value. Quote identifiers containing unusual punctuation. Arbitrary write scripts are not exposed through this workspace.

### CSV / JSON Import
Use **SQLite Explorer: Import CSV or JSON** on a desktop or remote extension host. Choose a writable database and existing table, map columns, review five sample rows, then confirm. An import is one transaction and one guarded undo/redo edit; errors or cancellation roll it back completely.

The preview lists destination defaults and omitted columns. SQLite evaluates defaults for omitted values; an explicit NULL or empty string does not request the default.

Each source file can contain up to **64 MiB, 100,000 rows, 256 columns, and 2,000,000 source fields**. Empty CSV fields count toward the field limit. Each imported cell must fit the existing 16 MiB edit limit, and the captured history must fit the configured undo-memory limit. Large imports may require a higher undo budget or smaller files. CSV requires a header and preserves fields as text, including empty strings. JSON accepts an array of row objects containing strings, finite numbers, and null; missing properties retain column defaults. Use quoted strings for large integers. Generated columns are omitted from mapping, and SQLite applies destination types and constraints. Tables with programs that prevent guarded insertion are refused. Native imports write to disk immediately, like other native edits.

### Editing
- **Inline cell editing** — Double-click any cell to modify its value
- **WITHOUT ROWID tables** — Fully editable via primary-key identity: composite keys, TEXT/REAL/BLOB key columns, exact 64-bit keys, complete undo/redo
- **VS Code editor integration** — Edit JSON, SQL, and text in a VS Code editor tab within the configured edit limits; oversized content uses the read-only snapshot viewer
- **Batch updates** — Update a column for multiple selected rows simultaneously via the sidebar
- **Row operations** — Insert new rows, delete selected rows
- **Column operations** — Add columns (with type and default value), delete columns
- **Table creation** — Create tables with column types, literal defaults, primary keys, and an optional WITHOUT ROWID layout
- **Drag & drop BLOBs** — Drag a file over the database, then hold Shift while dropping it onto a cell in VS Code. Large BLOBs retain their `[BLOB]` label and open in the inspector.
- **Smart JSON patching** — Edits to JSON cells use RFC 7396 Merge Patching (only diffs are sent)
- **Full undo/redo** — All operations (cell edits, row/column CRUD, batch updates) are undoable

Press Ctrl/Cmd+Z while a dropped file is being read or prepared to cancel that upload. Once the database write has started, the viewer protects the preceding edit; wait for completion, then press Undo to revert the upload.

Batch edits, cell clears, and row deletes above 1000 affected cells or rows require confirmation. Cancelling leaves the selection and data unchanged.

Large TEXT values open in a bounded read-only inspector when using inline or detailed cell editing. Use Load more to inspect additional bytes, Open Full Content for a paged snapshot, or Replace to supply a complete replacement file. A displayed prefix is never saved as the complete value.

If another program replaces an open database, use the **Reload Database** button shown in the viewer before continuing native edits. WASM Save refuses to overwrite a file changed since opening or the last save, and keeps unsaved edits available for **Save As** to a different file. Saving over an already-open destination refreshes its existing viewer; an unsaved WASM destination must first be saved or reverted. After hot exit, applied unsaved edits regain Undo/Redo. VS Code does not expose a way to restore a previously undone Redo branch or the old saved position in its Undo stack.

Save and close database editors before using **Save Workspace As** when VS Code requests an extension restart. Do not override its dirty-custom-editor warning with **Restart Anyway**. A reproduced VS Code host issue can leave the editor disconnected after that forced restart and report a backup error when closing the window. The [upstream reproduction](https://github.com/microsoft/vscode/issues/184142#issuecomment-5645116416) also occurs with SQLite Explorer absent; ordinary window reload and close/reopen are separate paths.

### Blob Inspector
- **Image preview** — PNG, JPEG, GIF, WebP displayed inline
- **Audio playback** — MP3, WAV, OGG, FLAC with native controls
- **Video playback** — Native controls when the installed VS Code runtime supports the codec; decoding failures show a hex preview and keep the original download available
- **Text/JSON preview** — View and format text and JSON content; large previews load in bounded chunks
- **Hex view** — Inspect raw bytes in 16 KiB pages, load more of an oversized BLOB, or use **Open Full Hex** for a complete read-only hex dump in VS Code
- **Complete content** — **Open Full Content** opens a desktop read-only snapshot with 64 KiB text or 16 KiB Hex pages, keeping multi-megabyte values out of a single editor buffer
- **Download & replace** — Save complete stored TEXT/BLOB bytes to disk or upload BLOB replacements. **Download stored cell** excludes unsaved text in the modal draft; UTF-16 downloads retain SQLite's stored encoding
- **PDF content** — Download the complete document to view it in a PDF application

### Export
- **Formats** — CSV, JSON, SQL INSERT statements
- **Options** — Include/exclude headers, toggle table name in SQL output
- **Selection export** — Export only selected rows
- **Streaming** — Large exports use streaming and keyset pagination to prevent OOM

### Database Settings
- **Pragma editor** — Configure SQLite pragmas (journal mode, foreign keys, synchronous, cache size, etc.) via GUI
- **Query interruption** — Runaway queries are cancelled mid-statement on both backends; the configurable timeout (default 30s) is enforced inside SQLite's VM, and superseded view previews are cancelled automatically
- **Auto-commit** — Optional instant-save mode for remote workspaces

### Cross-Platform
- **Dual backend** — Native SQLite (txiki-js) for desktop performance, sql.js (WebAssembly) for universal compatibility
- **Automatic fallback** — If the native backend fails (sandboxing, permissions), falls back to WASM transparently
- **VS Code for Web** — Works in browser-based VS Code (vscode.dev)
- **Remote development** — Full support for SSH, WSL, and containers
- **Web demo** — Try it at [sqlite-explorer.zknpr.xyz/demo](https://sqlite-explorer.zknpr.xyz/demo) — all processing is client-side

### UI/UX
- **Theme integration** — Automatically matches your VS Code color theme (light, dark, high contrast)
- **Resizable layout** — Adjustable sidebar and column widths
- **Multi-cell selection** — Click, Shift+Click (range), Cmd/Ctrl+Click (multi), column/row selection
- **Keyboard-driven** — Full keyboard support for editing, navigation, and selection
- **Localized** — 14 languages (EN, DE, ES, FR, IT, JA, KO, NL, PL, PT-BR, RU, TR, ZH-CN, ZH-TW)

### Security
- **Strict CSP** — Nonce-based Content Security Policy, no `unsafe-inline`
- **XSS prevention** — All cell data rendered via `textContent`, never `innerHTML`
- **SQL injection prevention** — Parameterized queries, escaped identifiers, validated SQL types
- **PII masking** — Email, phone, API keys, credit cards, SSNs are redacted in SQL logs
- **Workspace isolation** — File access restricted to the current workspace

## Installation

1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for **"SQLite Explorer"**
4. Click **Install**

Or from the command line:
```bash
code --install-extension zknpr.sqlite-explorer
```

## Usage

1. Open any `.sqlite`, `.db`, or `.sqlite3` file in VS Code
2. Browse tables and views in the sidebar
3. Click a table to display its data
4. Double-click any cell to edit
5. `Ctrl+S` / `Cmd+S` to save changes

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Double-click` | Edit cell (inline, modal, or VS Code tab — configurable) |
| `Enter` | Save cell edit |
| `Escape` | Cancel edit / clear selection |
| `Ctrl+A` / `Cmd+A` | Select all cells |
| `Enter` / `Shift+Enter` (filter active) | Jump to next / previous match |
| `Ctrl+C` / `Cmd+C` | Copy selected cells (tab-separated) |
| `Ctrl+Z` / `Cmd+Z` | Undo |
| `Ctrl+Y` / `Cmd+Shift+Z` | Redo |
| `Ctrl+S` / `Cmd+S` | Save database |
| `Cmd+Delete` / `Ctrl+Delete` | Smart delete (selected columns, rows, or clear cells) |
| `Shift+Click` | Range selection |
| `Cmd+Click` / `Ctrl+Click` | Multi-select |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `sqliteExplorer.maxFileSize` | `200` | Max database size in MB for WASM opens and buffered file copies; native opens are not capped (0 = unlimited) |
| `sqliteExplorer.defaultPageSize` | `5000` | Rows per page |
| `sqliteExplorer.instantCommit` | `never` | Auto-save strategy (`always`, `never`, `remote-only`) |
| `sqliteExplorer.doubleClickBehavior` | `inline` | Cell double-click action (`inline`, `modal`, `vscode`) |
| `sqliteExplorer.fileOperations` | `native` | Blob save/upload method (`native`, `web`) |
| `sqliteExplorer.queryTimeout` | `30000` | Query timeout in ms (prevents runaway queries) |
| `sqliteExplorer.maxUndoMemory` | `52428800` | Max undo history memory in bytes (default 50MB) |

## Supported File Types

| Extension | Description |
|-----------|-------------|
| `.sqlite` | SQLite database |
| `.sqlite3` | SQLite 3 database |
| `.db` | Database file |
| `.db3` | SQLite 3 database |
| `.sdb` | SQLite database |
| `.s3db` | SQLite 3 database |
| `.gpkg` | GeoPackage (SQLite-based) |

## Requirements

- VS Code 1.110.0 or higher
- No external dependencies required

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    Webview       │ ←→  │  Extension Host  │ ←→  │     Worker      │
│  (viewer.html)   │     │   (main.ts)      │     │  (worker.ts)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        ↑                       ↑                       ↑
    UI Layer              VS Code API         SQLite (WASM or Native)
```

- **Webview** — Renders the data grid, sidebar, modals, and blob inspector
- **Extension Host** — Manages document lifecycle, RPC bridge, file I/O
- **Worker** — Runs SQLite in a separate thread (sql.js WASM or txiki-js native)

Communication uses a custom RPC protocol with correlation IDs, timeouts, and zero-copy `Transfer` wrappers for binary data.

## Building from Source

```bash
git clone https://github.com/zknpr/sqlite-explorer.git
cd sqlite-explorer

npm install          # Install dependencies
node scripts/build.mjs   # Build extension + worker
npm test             # Run the unit test suite
npm run package      # Package as .vsix
./install.sh         # Build + package + install to VS Code
```

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests on [GitHub](https://github.com/zknpr/sqlite-explorer).

Before tagging a release, work through [QA_BEFORE_RELEASES.md](QA_BEFORE_RELEASES.md) — the
release gate covering both engines (native and WebAssembly) and all three surfaces (desktop
VS Code, VS Code Web, and the web demo).

## Support

If you find this extension useful, consider supporting development:

<span>
<a href="https://buymeacoffee.com/zknpr">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="60"/>
</a>
</span>
<span>
<a href="https://ko-fi.com/zknpr">
  <img src="https://storage.ko-fi.com/cdn/kofi2.png?v=3" alt="Support me on Ko-fi" height="60" />
</a>
</span>

## Credits

- **[sql.js](https://github.com/sql-js/sql.js)** — WebAssembly SQLite implementation (shipped as a pinned [patched build](https://github.com/zknpr/sql.js/tree/master) with paged I/O and progress-handler/interrupt exports for query cancellation)
- **[txiki.js](https://github.com/saghul/txiki.js)** — Native JavaScript runtime powering the native SQLite backend (bundled binaries built from [zknpr/txiki.js](https://github.com/zknpr/txiki.js), with async SQLite, V8-format IPC serialization, and query cancellation)
- **[@vscode/codicons](https://github.com/microsoft/vscode-codicons)** — Icon font
- **Icon** — [SQLite](https://iconscout.com/3d-icons/sqlite) by [Toms Design](https://iconscout.com/contributors/tomsdesign)

## License

MIT License — see [LICENSE.md](LICENSE.md) for details.
