# Changelog

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
