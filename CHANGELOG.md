# Changelog

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
