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
  _exportOptions?: any,
  _extras?: any
) {
  try {
    const tableName = dbParams.table;
    if (!tableName) {
      vsc.window.showErrorMessage('No table specified for export');
      return;
    }

    // Ask user for export format
    const format = await vsc.window.showQuickPick(
      [
        { label: 'CSV', description: 'Comma-separated values', value: 'csv' },
        { label: 'JSON', description: 'JavaScript Object Notation', value: 'json' },
        { label: 'SQL', description: 'SQL INSERT statements', value: 'sql' }
      ],
      {
        placeHolder: 'Select export format',
        title: `Export "${tableName}"`
      }
    );

    if (!format) return; // User cancelled

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

    // Fetch all data from the table
    // Use escapeIdentifier to prevent SQL injection via malicious table names
    const result = await document.databaseOperations.executeQuery(
      `SELECT * FROM ${escapeIdentifier(tableName)}`
    );

    if (!result || result.length === 0 || !result[0].values) {
      vsc.window.showInformationMessage(`Table "${tableName}" is empty`);
      return;
    }

    const columnNames = (result[0].columns || result[0].headers) as string[];
    const rows = (result[0].values || result[0].rows) as CellValue[][];

    let content: string;
    let defaultExt: string;

    switch (format.value) {
      case 'csv':
        content = exportToCsv(columnNames, rows);
        defaultExt = 'csv';
        break;
      case 'json':
        content = exportToJson(columnNames, rows);
        defaultExt = 'json';
        break;
      case 'sql':
        content = exportToSql(tableName, columnNames, rows);
        defaultExt = 'sql';
        break;
      default:
        return;
    }

    // Show save dialog
    // Set default directory to the database file's directory using joinPath
    // This prevents the dialog from defaulting to the root directory '/'
    const uri = await vsc.window.showSaveDialog({
      defaultUri: vsc.Uri.joinPath(document.uri, '..', `${tableName}.${defaultExt}`),
      filters: {
        [format.label]: [defaultExt],
        'All Files': ['*']
      },
      title: `Export "${tableName}" as ${format.label}`
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
function exportToCsv(columns: string[], rows: CellValue[][]): string {
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

  const headerLine = columns.map(escapeCsvValue).join(',');
  const dataLines = rows.map(row =>
    row.map(escapeCsvValue).join(',')
  );

  return [headerLine, ...dataLines].join('\n');
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
function exportToSql(tableName: string, columns: string[], rows: CellValue[][]): string {
  // Use escapeIdentifier to prevent SQL injection via malicious column names
  const columnList = columns.map(c => escapeIdentifier(c)).join(', ');

  const statements = rows.map(row => {
    const values = row.map(cellValueToSql).join(', ');
    // Use escapeIdentifier for table name as well
    return `INSERT INTO ${escapeIdentifier(tableName)} (${columnList}) VALUES (${values});`;
  });

  return statements.join('\n');
}
