/**
 * Export Table Command
 *
 * Exports table data to CSV, JSON, or SQL format.
 * Handles proper escaping and formatting for each output type.
 */

import * as vsc from 'vscode';
import type { TelemetryReporter } from '@vscode/extension-telemetry';
import type { CellValue } from './core/types';
import { DocumentRegistry } from './databaseModel';
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

    // Fetch data from the table
    // Use escapeIdentifier to prevent SQL injection via malicious table names
    // Respect selected columns
    let queryColumns = '*';
    if (columns && columns.length > 0) {
      queryColumns = columns.map(escapeIdentifier).join(', ');
    }

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
