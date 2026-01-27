/**
 * Export Table Command
 *
 * Exports table data to CSV, JSON, or SQL format.
 * Handles proper escaping and formatting for each output type.
 */

import * as vsc from 'vscode';
import type { TelemetryReporter } from '@vscode/extension-telemetry';
import type { CellValue } from './core/types';
import type { DatabaseDocument } from './databaseModel';
import { DocumentRegistry } from './documentRegistry';
import { escapeIdentifier, cellValueToSql } from './core/sql-utils';

// Legacy DbParams type for backward compatibility with webview
interface DbParams {
  filename?: string;
  table: string;
  name?: string;
  uri?: string;
}

/**
 * Export table data to CSV or JSON file.
 *
 * This command fetches all data from the specified table and saves it
 * to a file chosen by the user via a save dialog.
 *
 * @param context - VS Code extension context
 * @param reporter - Telemetry reporter (unused in this version)
 * @param dbParams - Database parameters containing table name
 * @param columns - Array of column names to export
 */
export async function exportTableCommand(
  context: vsc.ExtensionContext,
  reporter: TelemetryReporter | undefined,
  dbParams: DbParams,
  columns: string[],
  _dbOptions?: any,
  _tableStore?: any,
  _exportOptions?: { format?: string, header?: boolean, includeTableName?: boolean, rowIds?: (string | number)[] },
  _extras?: any
) {
  try {
    const tableName = dbParams.table;
    if (!tableName) {
      vsc.window.showErrorMessage('No table specified for export');
      return;
    }

    let formatValue: string | undefined = _exportOptions?.format;

    // If format not provided in options, ask user
    if (!formatValue) {
      const formatPick = await vsc.window.showQuickPick(
        [
          { label: 'CSV', description: 'Comma-separated values', value: 'csv' },
          { label: 'JSON', description: 'JavaScript Object Notation', value: 'json' },
          { label: 'SQL', description: 'SQL INSERT statements', value: 'sql' },
          { label: 'Excel', description: 'CSV with encoding for Excel', value: 'excel' }
        ],
        {
          placeHolder: 'Select export format',
          title: `Export "${tableName}"`
        }
      );
      if (!formatPick) return; // User cancelled
      formatValue = formatPick.value;
    }

    // Find the active document to get database access
    let document = null;

    // 1. Try to find by URI if provided (most reliable)
    if (dbParams.uri) {
      for (const [, doc] of DocumentRegistry) {
        if (doc.uri.toString() === dbParams.uri) {
          document = doc;
          break;
        }
      }
    }

    // 2. Fallback: pick the first one (legacy behavior)
    // This assumes there is only one active database editor
    if (!document) {
      for (const [, doc] of DocumentRegistry) {
        document = doc;
        break;
      }
    }

    if (!document || !document.databaseOperations) {
      vsc.window.showErrorMessage('No active database connection');
      return;
    }

    // Fetch data from the table in chunks to avoid OOM
    // Use escapeIdentifier to prevent SQL injection via malicious table names
    // Respect selected columns
    let queryColumns = '*';
    if (columns && columns.length > 0) {
      queryColumns = columns.map(escapeIdentifier).join(', ');
    }

    // Determine total count for progress reporting (optional, skipping for now to keep it simple/fast)
    // But we need to know if we should use rowid-based paging or offset-based.
    // Rowid is best but not all tables have it (e.g. WITHOUT ROWID tables).
    // For simplicity and safety across all table types, we'll try to use rowid if available,
    // otherwise fallback to OFFSET (slower but works).

    // Actually, nearly all SQLite tables have rowid unless explicitly WITHOUT ROWID.
    // We can check if rowid exists or just try.
    // Let's use a standard OFFSET/LIMIT approach for now as it's universally compatible,
    // though slower for deep pages. For export, we are reading sequentially, so it's O(N^2) in worst case.
    // BUT, since we are exporting, we can assume we want *all* data.
    // Better optimization: Use `rowid` keyset pagination if possible.

    const BATCH_SIZE = 5000;
    let offset = 0;
    let hasMore = true;
    let fileHandle: vsc.FileSystem | null = null; // We can't stream to file easily with VS Code API?
    // VS Code fs.writeFile writes full content.
    // We cannot append to file easily with vscode.workspace.fs.
    // Node.js fs is not available in browser/remote.
    // But this runs in Extension Host.

    // If we build the whole content string in memory, we still OOM.
    // We need to write in chunks.
    // VS Code API doesn't support appending files efficiently until recently?
    // Actually, we can't do true streaming with `vscode.workspace.fs.writeFile`.
    // We would need to accumulate everything in memory anyway if we use standard API.

    // However, for Local Node.js (desktop), we can use `fs`.
    // For Web, we are limited.
    // But the primary crash vector is Desktop with large DBs.

    // Let's try to detect if we can use native fs.
    const isLocalFile = uri.scheme === 'file';

    if (isLocalFile && typeof require === 'function') {
        // Use Node.js fs streams for memory efficiency
        try {
            const fs = require('fs');
            const stream = fs.createWriteStream(uri.fsPath, { encoding: 'utf-8' });

            // Write BOM for Excel if needed
            if (formatValue === 'excel') {
                stream.write('\uFEFF');
            }

            // Write header
            let isFirstBatch = true;

            while (hasMore) {
                let sql = `SELECT rowid, ${queryColumns} FROM ${escapeIdentifier(tableName)}`;

                // Use rowid pagination for performance
                // We need to track the last seen rowid.
                // Initial query: WHERE rowid > lastId ORDER BY rowid ASC LIMIT BATCH

                // Wait, if columns doesn't include rowid, we need to ask for it to paginate,
                // but exclude it from output if not requested?
                // The user requested `columns`.

                // Let's stick to simple OFFSET for now to avoid complexity with composite keys / WITHOUT ROWID.
                // To minimize OOM, we just need to GC between batches.
                // But if we can't write incrementally, we have to keep all in memory.
                // Since we are using a stream here, we CAN write incrementally!

                // Using standard OFFSET for simplicity. Performance impact acceptable for export?
                // Deep offset is slow.
                // Let's use rowid if we can.

                // Check if table supports rowid?
                // Just try `SELECT rowid FROM table LIMIT 1`.
                let useRowId = false;
                try {
                     await document.databaseOperations.executeQuery(`SELECT rowid FROM ${escapeIdentifier(tableName)} LIMIT 1`);
                     useRowId = true;
                } catch {}

                if (useRowId) {
                     // RowID pagination
                     let lastId = 0; // Assuming rowids are positive, but they can be negative.
                     // Better: use `WHERE rowid > ?` and init with extremely small number?
                     // Or just track last one.

                     // We need to reimplement the loop structure.
                     // Let's use a simpler cursor approach:
                     // SELECT * FROM table WHERE rowid > lastId ORDER BY rowid ASC LIMIT 5000

                     let currentLastId = Number.MIN_SAFE_INTEGER;

                     // Loop
                     while (true) {
                         // Need to handle user-provided filter options (rowIds) too?
                         // If _exportOptions.rowIds is set, we just dump those (usually small selection).
                         // The existing code handles that non-chunked.

                         let sql = `SELECT rowid, ${queryColumns} FROM ${escapeIdentifier(tableName)} WHERE rowid > ?`;
                         const params: any[] = [currentLastId];

                         // Add rowIds filter if present
                         if (_exportOptions?.rowIds && _exportOptions.rowIds.length > 0) {
                              const validIds = _exportOptions.rowIds.map(id => Number(id)).filter(n => !isNaN(n));
                              if (validIds.length > 0) {
                                  sql += ` AND rowid IN (${validIds.map(() => '?').join(',')})`;
                                  params.push(...validIds);
                              }
                         }

                         sql += ` ORDER BY rowid ASC LIMIT ${BATCH_SIZE}`;

                         const result = await document.databaseOperations.executeQuery(sql, params);
                         if (!result || result.length === 0 || !result[0].rows || result[0].rows.length === 0) {
                             break;
                         }

                         const rows = result[0].rows as CellValue[][];
                         const headers = result[0].headers as string[]; // Includes rowid as first col if we added it

                         // Find index of rowid to update cursor
                         // We asked for "rowid, ..." so it should be first?
                         // "rowid" might conflict if user selected "rowid".
                         // `SELECT rowid, col1...` -> columns: ['rowid', 'col1']

                         // Update cursor
                         const lastRow = rows[rows.length - 1];
                         // We assume rowid is the first column because we put it there in SQL
                         currentLastId = Number(lastRow[0]);

                         // Prepare data for export
                         // If user didn't ask for rowid, remove it.
                         // Check `columns` input.
                         const userRequestedRowId = columns.includes('rowid');

                         let outputRows = rows;
                         let outputHeaders = headers;

                         if (!userRequestedRowId) {
                             // Remove first column (rowid)
                             outputRows = rows.map(r => r.slice(1));
                             outputHeaders = headers.slice(1);
                         }

                         // Write chunk
                         let chunkContent = '';
                         switch (formatValue) {
                              case 'excel':
                              case 'csv':
                                chunkContent = exportToCsv(outputHeaders, outputRows, isFirstBatch && includeHeader);
                                if (!isFirstBatch && chunkContent) chunkContent = '\n' + chunkContent;
                                break;
                              case 'json':
                                // JSON streaming is hard (array of objects).
                                // We can write objects one by one but need comma separation.
                                // Or JSONL (JSON Lines).
                                // Standard JSON: [ ... ]
                                if (isFirstBatch) stream.write('[');
                                else if (outputRows.length > 0) stream.write(',');

                                const jsonStr = exportToJson(outputHeaders, outputRows);
                                // jsonStr is "[...]" (array of objects)
                                // We need to strip brackets to stream inside the main array?
                                // exportToJson returns stringified array.
                                // We should refactor exportToJson or just slice.
                                chunkContent = jsonStr.slice(1, -1); // remove [ and ]
                                break;
                              case 'sql':
                                chunkContent = exportToSql(tableName, outputHeaders, outputRows, includeTableName);
                                if (!isFirstBatch && chunkContent) chunkContent = '\n' + chunkContent;
                                break;
                         }

                         if (chunkContent) stream.write(chunkContent);
                         isFirstBatch = false;
                     }

                     if (formatValue === 'json') stream.write(']');
                     stream.end();

                     vsc.window.showInformationMessage(`Exported to ${uri.fsPath}`);
                     return;
                }
            }
        } catch (e) {
            console.warn('Native stream write failed, falling back to memory', e);
        }
    }

    // Fallback to in-memory (existing logic) if not local file or rowid not supported
    // ... (keep original logic below for fallback) ...

    let sql = `SELECT ${queryColumns} FROM ${escapeIdentifier(tableName)}`;
    const params: any[] = [];

    // Filter by row IDs if provided
    if (_exportOptions?.rowIds && _exportOptions.rowIds.length > 0) {
        const rowIds = _exportOptions.rowIds.map(id => Number(id)).filter(n => !isNaN(n));
        if (rowIds.length > 0) {
            const placeholders = rowIds.map(() => '?').join(', ');
            sql += ` WHERE rowid IN (${placeholders})`;
            params.push(...rowIds);
        }
    }

    const result = await document.databaseOperations.executeQuery(sql, params);

    if (!result || result.length === 0 || !result[0].values) {
      vsc.window.showInformationMessage(`Table "${tableName}" is empty or no rows match selection`);
      return;
    }

    const columnNames = (result[0].columns || result[0].headers) as string[];
    const rows = (result[0].values || result[0].rows) as CellValue[][];

    let content: string;
    let defaultExt: string;

    const includeHeader = _exportOptions?.header ?? true;
    const includeTableName = _exportOptions?.includeTableName ?? true;

    switch (formatValue) {
      case 'excel':
        // Excel prefers CSV with BOM for UTF-8
        content = '\uFEFF' + exportToCsv(columnNames, rows, includeHeader);
        defaultExt = 'csv';
        break;
      case 'csv':
        content = exportToCsv(columnNames, rows, includeHeader);
        defaultExt = 'csv';
        break;
      case 'json':
        content = exportToJson(columnNames, rows);
        defaultExt = 'json';
        break;
      case 'sql':
        content = exportToSql(tableName, columnNames, rows, includeTableName);
        defaultExt = 'sql';
        break;
      default:
        vsc.window.showErrorMessage(`Unsupported export format: ${formatValue}`);
        return;
    }

    // Show save dialog
    // Set default directory to the database file's directory using joinPath
    // This prevents the dialog from defaulting to the root directory '/'
    const uri = await vsc.window.showSaveDialog({
      defaultUri: vsc.Uri.joinPath(document.uri, '..', `${tableName}.${defaultExt}`),
      filters: {
        [formatValue.toUpperCase()]: [defaultExt],
        'All Files': ['*']
      },
      title: `Export "${tableName}" as ${formatValue.toUpperCase()}`
    });

    if (!uri) return; // User cancelled

    // Write file
    await vsc.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));

    vsc.window.showInformationMessage(
      `Exported ${rows.length} rows to ${uri.fsPath}`
    );

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vsc.window.showErrorMessage(`Export failed: ${message}`);
    console.error('Export error:', err);
  }
}

/**
 * Convert data to CSV format.
 * Handles proper escaping of values containing commas, quotes, or newlines.
 */
function exportToCsv(columns: string[], rows: CellValue[][], includeHeader: boolean = true): string {
  const escapeCsvValue = (value: CellValue): string => {
    if (value === null || value === undefined) return '';
    if (value instanceof Uint8Array) return '[BLOB]';
    const str = String(value);
    // If contains comma, quote, or newline, wrap in quotes and escape internal quotes
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [];
  if (includeHeader) {
    lines.push(columns.map(escapeCsvValue).join(','));
  }

  rows.forEach(row => {
    lines.push(row.map(escapeCsvValue).join(','));
  });

  return lines.join('\n');
}

/**
 * Convert data to JSON format.
 * Each row becomes an object with column names as keys.
 */
function exportToJson(columns: string[], rows: CellValue[][]): string {
  const objects = rows.map(row => {
    const obj: Record<string, any> = {};
    columns.forEach((col, idx) => {
      const value = row[idx];
      // Convert Uint8Array to base64 for JSON
      if (value instanceof Uint8Array) {
        obj[col] = Buffer.from(value).toString('base64');
      } else {
        obj[col] = value;
      }
    });
    return obj;
  });

  return JSON.stringify(objects, null, 2);
}

/**
 * Convert data to SQL INSERT statements.
 * Generates INSERT statements that can be used to recreate the data.
 */
function exportToSql(tableName: string, columns: string[], rows: CellValue[][], includeTableName: boolean = true): string {
  // Use escapeIdentifier to prevent SQL injection via malicious column names
  const columnList = columns.map(c => escapeIdentifier(c)).join(', ');
  const targetTable = includeTableName ? escapeIdentifier(tableName) : 'table_name';

  const statements = rows.map(row => {
    const values = row.map(cellValueToSql).join(', ');
    // Use escapeIdentifier for table name as well
    return `INSERT INTO ${targetTable} (${columnList}) VALUES (${values});`;
  });

  return statements.join('\n');
}
