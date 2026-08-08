/**
 * Export Table Command
 *
 * Exports table data to CSV, JSON, or SQL format.
 * Handles proper escaping and formatting for each output type.
 */

import * as vsc from 'vscode';
import type { TelemetryReporter } from '@vscode/extension-telemetry';
import type { CellValue, DbParams, ExportOptions } from './core/types';
import type { DatabaseDocument } from './databaseModel';
import { DocumentRegistry } from './documentRegistry';
import { escapeIdentifier, cellValueToSql } from './core/sql-utils';
import { getNodeFs } from './core/sqlite-db';
import {
  EXPORT_CELL_CHUNK_BYTES,
  streamTableExport,
  type AsyncExportSink,
  type ExportCancellation
} from './tableExportStreaming';
import { crypto as webCrypto } from './platform/cryptoShim';
export {
  EXPORT_CELL_CHUNK_BYTES,
  streamTableExport
} from './tableExportStreaming';

/**
 * `workspace.fs.writeFile` accepts one complete Uint8Array and exposes no
 * writable-stream API. Cap the UTF-8 output at 16 MiB so chunk collection plus
 * the final contiguous buffer stays bounded while remote/web workspaces lack a
 * real streaming destination. Local filesystem exports have no such cap.
 */
export const NON_LOCAL_EXPORT_MAX_BYTES = 16 * 1024 * 1024;

const NON_LOCAL_CAP_DESCRIPTION =
  '16 MiB (16,777,216 bytes)';

/**
 * Minimal writable sink consumed by the streaming exporters. Satisfied by Node's
 * `fs.WriteStream` and by lightweight in-memory test doubles alike: the exporters
 * only ever call `write()` with a string chunk, so requiring the full
 * `NodeJS.WritableStream` surface would be unnecessary and would reject valid stubs.
 */
export interface ExportWritable {
  write(chunk: string): void;
}

export interface FormatHelper {
  extension: string;
  streamStart(stream: ExportWritable): void;
  streamWriteBatch(stream: ExportWritable, headers: string[], rows: CellValue[][], isFirstBatch: boolean): void;
  streamEnd(stream: ExportWritable): void;
  exportMemory(headers: string[], rows: CellValue[][]): string;
}

export function getFormatHelper(format: string, tableName: string, includeHeader: boolean, includeTableName: boolean): FormatHelper {
  switch (format) {
    case 'csv':
      return {
        extension: 'csv',
        streamStart: () => {},
        streamWriteBatch: (stream, headers, rows, isFirstBatch) => {
          const chunk = exportToCsv(headers, rows, isFirstBatch && includeHeader);
          if (chunk) stream.write(isFirstBatch ? chunk : '\n' + chunk);
        },
        streamEnd: () => {},
        exportMemory: (headers, rows) => exportToCsv(headers, rows, includeHeader)
      };
    case 'excel':
      return {
        extension: 'csv',
        streamStart: (stream) => stream.write('\uFEFF'),
        streamWriteBatch: (stream, headers, rows, isFirstBatch) => {
          const chunk = exportToCsv(headers, rows, isFirstBatch && includeHeader);
          if (chunk) stream.write(isFirstBatch ? chunk : '\n' + chunk);
        },
        streamEnd: () => {},
        exportMemory: (headers, rows) => '\uFEFF' + exportToCsv(headers, rows, includeHeader)
      };
    case 'json':
      return {
        extension: 'json',
        streamStart: (stream) => stream.write('['),
        streamWriteBatch: (stream, headers, rows, isFirstBatch) => {
          if (!isFirstBatch && rows.length > 0) stream.write(',');
          const jsonStr = exportToJson(headers, rows);
          stream.write(jsonStr.slice(1, -1)); // Remove [ and ]
        },
        streamEnd: (stream) => stream.write(']'),
        exportMemory: (headers, rows) => exportToJson(headers, rows)
      };
    case 'sql':
      return {
        extension: 'sql',
        streamStart: () => {},
        streamWriteBatch: (stream, headers, rows, isFirstBatch) => {
          const chunk = exportToSql(tableName, headers, rows, includeTableName);
          if (chunk) stream.write(isFirstBatch ? chunk : '\n' + chunk);
        },
        streamEnd: () => {},
        exportMemory: (headers, rows) => exportToSql(tableName, headers, rows, includeTableName)
      };
    default:
      if (!format) throw new Error(`Unsupported export format: undefined`);
      throw new Error(`Unsupported export format: ${format}`);
  }
}

type NodeFs = typeof import('node:fs');
type NodeWriteStream = import('node:fs').WriteStream;

class AwaitedNodeStreamSink implements AsyncExportSink {
  private ended = false;
  private streamError: Error | undefined;
  private readonly recordStreamError = (error: Error): void => {
    this.streamError ??= error;
  };

  constructor(private readonly stream: NodeWriteStream) {
    // Keep an error listener installed for the entire lifecycle. In particular,
    // createWriteStream can fail asynchronously while the first database row is
    // still being prepared, before the first write callback exists.
    this.stream.on('error', this.recordStreamError);
  }

  async ready(): Promise<void> {
    if (this.streamError) throw this.streamError;
    if (!this.stream.pending) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.stream.off('ready', onReady);
        this.stream.off('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const onReady = () => finish();
      const onError = (error: Error) => finish(error);
      this.stream.once('ready', onReady);
      this.stream.once('error', onError);
      if (!this.stream.pending) finish();
    });
    if (this.streamError) throw this.streamError;
  }

  async write(chunk: string): Promise<void> {
    if (this.ended) throw new Error('Cannot write to a completed export stream');
    if (this.streamError) throw this.streamError;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        this.stream.off('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) => finish(error);
      this.stream.once('error', onError);
      try {
        // Waiting for every write callback is stronger than merely observing
        // `drain`: no formatter emission can outrun the stream's backpressure.
        this.stream.write(chunk, 'utf8', finish);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (this.streamError) throw this.streamError;
  }

  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.streamError) throw this.streamError;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.stream.off('close', onClose);
        this.stream.off('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const onClose = () => finish();
      const onError = (error: Error) => finish(error);
      this.stream.once('close', onClose);
      this.stream.once('error', onError);
      try {
        // `end`'s callback observes `finish`, not descriptor closure. Rename
        // only after `close` so Windows and remote-mounted local files do not
        // race an open handle.
        this.stream.end();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.stream.off('error', this.recordStreamError);
    if (this.streamError) throw this.streamError;
  }

  async abort(): Promise<void> {
    this.ended = true;
    if (!this.stream.closed) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          this.stream.off('close', onClose);
          if (error) reject(error);
          else resolve();
        };
        const onClose = () => finish();
        this.stream.once('close', onClose);
        try {
          this.stream.destroy();
          if (this.stream.closed) finish();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }
    this.stream.off('error', this.recordStreamError);
  }
}

class CappedWorkspaceSink implements AsyncExportSink {
  private readonly encoder = new TextEncoder();
  private readonly chunks: Uint8Array[] = [];
  private totalBytes = 0;

  async write(chunk: string): Promise<void> {
    const bytes = this.encoder.encode(chunk);
    const nextBytes = this.totalBytes + bytes.byteLength;
    if (!Number.isSafeInteger(nextBytes) || nextBytes > NON_LOCAL_EXPORT_MAX_BYTES) {
      throw new Error(
        `Non-local exports are limited to ${NON_LOCAL_CAP_DESCRIPTION} of UTF-8 output ` +
        'because vscode.workspace.fs has no streaming write API; choose a local ' +
        'filesystem destination for larger exports.'
      );
    }
    this.chunks.push(bytes);
    this.totalBytes = nextBytes;
  }

  finish(): Uint8Array {
    const output = new Uint8Array(this.totalBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}

function assertExportNotCancelled(cancellation?: ExportCancellation): void {
  if (!cancellation?.isCancellationRequested) return;
  const error = new Error('Export cancelled');
  error.name = 'CancellationError';
  throw error;
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'CancellationError' ||
    error.name === 'Canceled' ||
    error.message === 'Export cancelled'
  );
}

function localSiblingTempPath(finalPath: string): string {
  const path = require('node:path') as typeof import('node:path');
  return path.join(
    path.dirname(finalPath),
    `.${path.basename(finalPath)}.${webCrypto.randomUUID()}.tmp`
  );
}

function workspaceSiblingTempUri(finalUri: vsc.Uri): vsc.Uri {
  const basename = finalUri.path.split('/').filter(Boolean).pop() || 'export';
  return vsc.Uri.joinPath(
    finalUri,
    '..',
    `.${basename}.${webCrypto.randomUUID()}.tmp`
  );
}

async function removeLocalTemp(fs: NodeFs, tempPath: string, primaryError: unknown): Promise<never> {
  try {
    await fs.promises.rm(tempPath, { force: true });
  } catch (cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `Export failed and temporary file cleanup also failed: ${tempPath}`
    );
  }
  throw primaryError;
}

async function exportLocalAtomic(
  fs: NodeFs,
  uri: vsc.Uri,
  document: DatabaseDocument,
  tableName: string,
  columns: string[],
  options: ExportOptions,
  cancellation?: ExportCancellation
): Promise<number> {
  const tempPath = localSiblingTempPath(uri.fsPath);
  let sink: AwaitedNodeStreamSink | undefined;
  try {
    const stream = fs.createWriteStream(tempPath, {
      encoding: 'utf8',
      flags: 'wx',
      mode: 0o600
    });
    sink = new AwaitedNodeStreamSink(stream);
    await sink.ready();
    const rowCount = await streamTableExport(
      document.databaseOperations,
      tableName,
      columns,
      options,
      sink,
      cancellation
    );
    assertExportNotCancelled(cancellation);
    await sink.close();
    assertExportNotCancelled(cancellation);
    await fs.promises.rename(tempPath, uri.fsPath);
    return rowCount;
  } catch (error) {
    let primaryError = error;
    try {
      await sink?.abort();
    } catch (cleanupError) {
      primaryError = new AggregateError(
        [error, cleanupError],
        `Export failed and the temporary stream could not be closed: ${tempPath}`
      );
    }
    return removeLocalTemp(fs, tempPath, primaryError);
  }
}

/** Invoke the production local atomic-export path from the non-production test API. */
export async function exportTableToLocalFileForTests(
  document: DatabaseDocument,
  destination: string,
  tableName: string,
  columns: string[],
  options: ExportOptions
): Promise<number> {
  const fs = getNodeFs();
  if (!fs) throw new Error('Local filesystem exports are unavailable in this extension host');
  return exportLocalAtomic(
    fs,
    vsc.Uri.file(destination),
    document,
    tableName,
    columns,
    options
  );
}

function isMissingWorkspaceFile(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'FileNotFound' || code === 'ENOENT';
}

async function removeWorkspaceTemp(
  tempUri: vsc.Uri,
  primaryError: unknown
): Promise<never> {
  try {
    await vsc.workspace.fs.delete(tempUri, { recursive: false, useTrash: false });
  } catch (cleanupError) {
    if (!isMissingWorkspaceFile(cleanupError)) {
      throw new AggregateError(
        [primaryError, cleanupError],
        `Export failed and temporary URI cleanup also failed: ${tempUri.toString()}`
      );
    }
  }
  throw primaryError;
}

async function exportWorkspaceAtomic(
  uri: vsc.Uri,
  document: DatabaseDocument,
  tableName: string,
  columns: string[],
  options: ExportOptions,
  cancellation?: ExportCancellation
): Promise<number> {
  const sink = new CappedWorkspaceSink();
  const rowCount = await streamTableExport(
    document.databaseOperations,
    tableName,
    columns,
    options,
    sink,
    cancellation
  );
  assertExportNotCancelled(cancellation);
  const bytes = sink.finish();
  const tempUri = workspaceSiblingTempUri(uri);
  try {
    await vsc.workspace.fs.writeFile(tempUri, bytes);
    assertExportNotCancelled(cancellation);
    await vsc.workspace.fs.rename(tempUri, uri, { overwrite: true });
    return rowCount;
  } catch (error) {
    return removeWorkspaceTemp(tempUri, error);
  }
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
  _context: vsc.ExtensionContext,
  _reporter: TelemetryReporter | undefined,
  dbParams: DbParams,
  columns: string[],
  _dbOptions?: unknown,
  _tableStore?: unknown,
  _exportOptions?: ExportOptions,
  _extras?: unknown
) {
  try {
    const tableName = dbParams.table;
    if (!tableName) {
      await vsc.window.showErrorMessage('No table specified for export');
      return;
    }

    let formatValue: string | undefined = _exportOptions?.format;
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

    let document: DatabaseDocument | undefined;
    if (dbParams.uri) {
      for (const [, doc] of DocumentRegistry) {
        if (doc.uri.toString() === dbParams.uri) {
          document = doc;
          break;
        }
      }
    }
    if (!document) {
      for (const [, doc] of DocumentRegistry) {
        document = doc;
        break;
      }
    }

    if (!document || !document.databaseOperations) {
      await vsc.window.showErrorMessage('No active database connection');
      return;
    }

    const includeHeader = _exportOptions?.header ?? true;
    const includeTableName = _exportOptions?.includeTableName ?? true;
    let formatHelper: FormatHelper;
    try {
      formatHelper = getFormatHelper(
        formatValue,
        tableName,
        includeHeader,
        includeTableName
      );
    } catch (e) {
      await vsc.window.showErrorMessage((e as Error).message);
      return;
    }

    const uri = await vsc.window.showSaveDialog({
      // Keep the dialog beside the database instead of defaulting to `/`.
      defaultUri: vsc.Uri.joinPath(
        document.uri,
        '..',
        `${tableName}.${formatHelper.extension}`
      ),
      filters: {
        [formatValue.toUpperCase()]: [formatHelper.extension],
        'All Files': ['*']
      },
      title: `Export "${tableName}" as ${formatValue.toUpperCase()}`
    });
    if (!uri) return; // User cancelled

    const options: ExportOptions = {
      ..._exportOptions,
      format: formatValue,
      header: includeHeader,
      includeTableName
    };
    const fs = uri.scheme === 'file' ? getNodeFs() : undefined;
    const rowCount = await vsc.window.withProgress(
      {
        location: vsc.ProgressLocation.Notification,
        title: `Exporting "${tableName}"`,
        cancellable: true
      },
      async (_progress, cancellation) => {
        if (fs) {
          return exportLocalAtomic(
            fs,
            uri,
            document,
            tableName,
            columns,
            options,
            cancellation
          );
        }
        return exportWorkspaceAtomic(
          uri,
          document,
          tableName,
          columns,
          options,
          cancellation
        );
      }
    );
    await vsc.window.showInformationMessage(
      `Exported ${rowCount} rows to ${uri.fsPath || uri.toString()}`
    );

  } catch (err) {
    if (isCancellationError(err)) {
      await vsc.window.showInformationMessage('Export cancelled');
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await vsc.window.showErrorMessage(`Export failed: ${message}`);
    console.error('Export error:', err);
  }
}

/**
 * Convert data to CSV format.
 * Handles proper escaping of values containing commas, quotes, or newlines.
 */
export function exportToCsv(columns: string[], rows: CellValue[][], includeHeader: boolean = true): string {
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
export function exportToJson(columns: string[], rows: CellValue[][]): string {
  const objects = rows.map(row => {
    const obj: Record<string, CellValue> = {};
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
export function exportToSql(tableName: string, columns: string[], rows: CellValue[][], includeTableName: boolean = true): string {
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
