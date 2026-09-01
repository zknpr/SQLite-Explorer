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
import { encodeCsvExportText } from './core/export-encoding';
import { getNodeFs } from './core/sqlite-db';
import {
  EXPORT_CELL_CHUNK_BYTES,
  streamTableExport,
  type AsyncExportSink,
  type ExportCancellation
} from './tableExportStreaming';
import { crypto as webCrypto } from './platform/cryptoShim';
import {
  replacementFileMetadataFromStats,
  restoreTemporaryMetadata,
  type OwnershipPreservationFailure,
  type ReplacementFileMetadata
} from './fileReplacementMetadata';
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
const NON_LOCAL_EXPORT_PAGE_BYTES = 64 * 1024;
const LOCAL_EXPORT_BUFFER_BYTES = 64 * 1024;

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

export type ExportTableCommandResult =
  | { success: true; rowCount: number; destination: string }
  | { success: false; cancelled: true }
  | { success: false; cancelled?: false; message: string };

function showExportNotification(notification: PromiseLike<unknown> | unknown): void {
  // VS Code notification promises resolve only after dismissal. The export RPC
  // must settle when the file operation does, or the webview remains stuck on
  // "Exporting..." while a completed notification is waiting for the user.
  void Promise.resolve(notification).catch(error => {
    console.error('Failed to show export notification:', error);
  });
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
  private fileDescriptor: number | undefined;
  private streamError: Error | undefined;
  private readonly writeBuffer = Buffer.allocUnsafe(LOCAL_EXPORT_BUFFER_BYTES);
  private bufferedBytes = 0;
  private readonly recordStreamError = (error: Error): void => {
    this.streamError ??= error;
  };

  constructor(private readonly stream: NodeWriteStream) {
    // Keep an error listener installed for the entire lifecycle. In particular,
    // createWriteStream can fail asynchronously while the first database row is
    // still being prepared, before the first write callback exists.
    this.stream.on('error', this.recordStreamError);
    this.stream.once('open', (fd) => {
      this.fileDescriptor = fd;
    });
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

  private async waitForDrain(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.stream.off('drain', onDrain);
        this.stream.off('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) => finish(error);
      const onDrain = () => finish();
      this.stream.once('drain', onDrain);
      this.stream.once('error', onError);
      if (this.streamError) finish(this.streamError);
    });
  }

  private async writeToStream(bytes: Buffer): Promise<void> {
    if (this.streamError) throw this.streamError;
    let accepted: boolean;
    try {
      accepted = this.stream.write(bytes);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    // Immutable output buffers let formatter work continue while the stream is
    // below its high-water mark. Only backpressure requires an async boundary.
    if (!accepted) await this.waitForDrain();
    if (this.streamError) throw this.streamError;
  }

  private async flushBuffered(): Promise<void> {
    if (this.bufferedBytes === 0) return;
    // WriteStream retains Buffer references until I/O completes. Copy the used
    // slab before reusing the bounded scratch buffer; otherwise a fast producer
    // could mutate bytes still queued in libuv.
    const output = Buffer.allocUnsafe(this.bufferedBytes);
    this.writeBuffer.copy(output, 0, 0, this.bufferedBytes);
    this.bufferedBytes = 0;
    await this.writeToStream(output);
  }

  async write(chunk: string): Promise<void> {
    if (this.ended) throw new Error('Cannot write to a completed export stream');
    if (this.streamError) throw this.streamError;
    if (chunk.length === 0) return;

    // Encode every formatter emission independently. Besides avoiding millions
    // of WriteStream callbacks, this preserves the previous UTF-8 treatment of
    // an isolated surrogate at an emission boundary byte-for-byte.
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    if (chunkBytes > this.writeBuffer.byteLength) {
      await this.flushBuffered();
      await this.writeToStream(Buffer.from(chunk, 'utf8'));
      return;
    }
    if (this.bufferedBytes + chunkBytes > this.writeBuffer.byteLength) {
      await this.flushBuffered();
    }
    const written = this.writeBuffer.write(
      chunk,
      this.bufferedBytes,
      chunkBytes,
      'utf8'
    );
    if (written !== chunkBytes) {
      throw new Error('Failed to encode a complete local export chunk');
    }
    this.bufferedBytes += written;
    if (this.bufferedBytes === this.writeBuffer.byteLength) {
      await this.flushBuffered();
    }
  }

  async restoreMetadata(
    fs: NodeFs,
    metadata: ReplacementFileMetadata
  ): Promise<OwnershipPreservationFailure | undefined> {
    if (this.ended) throw new Error('Cannot restore metadata on a completed export stream');
    if (this.streamError) throw this.streamError;
    await this.flushBuffered();
    const fd = this.fileDescriptor;
    if (fd === undefined) {
      throw new Error('Cannot restore export metadata before its file descriptor is ready');
    }
    return restoreTemporaryMetadata(
      {
        chown: (uid, gid) => new Promise<void>((resolve, reject) => {
          fs.fchown(fd, uid, gid, (error) => error ? reject(error) : resolve());
        }),
        chmod: (mode) => new Promise<void>((resolve, reject) => {
          fs.fchmod(fd, mode, (error) => error ? reject(error) : resolve());
        })
      },
      metadata
    );
  }

  async close(): Promise<void> {
    if (this.ended) return;
    await this.flushBuffered();
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
    this.bufferedBytes = 0;
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

export class CappedWorkspaceSink implements AsyncExportSink {
  private readonly encoder = new TextEncoder();
  private readonly pages: Uint8Array[] = [];
  private tailBytes = 0;
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
    // Encode each formatter emission independently so lone-surrogate handling
    // remains byte-identical, then retain only a bounded number of byte pages.
    let sourceOffset = 0;
    while (sourceOffset < bytes.byteLength) {
      if (this.pages.length === 0 || this.tailBytes === NON_LOCAL_EXPORT_PAGE_BYTES) {
        this.pages.push(new Uint8Array(NON_LOCAL_EXPORT_PAGE_BYTES));
        this.tailBytes = 0;
      }
      const copyBytes = Math.min(
        bytes.byteLength - sourceOffset,
        NON_LOCAL_EXPORT_PAGE_BYTES - this.tailBytes
      );
      this.pages[this.pages.length - 1].set(
        bytes.subarray(sourceOffset, sourceOffset + copyBytes),
        this.tailBytes
      );
      sourceOffset += copyBytes;
      this.tailBytes += copyBytes;
    }
    this.totalBytes = nextBytes;
  }

  finish(): Uint8Array {
    const output = new Uint8Array(this.totalBytes);
    let offset = 0;
    for (const page of this.pages) {
      const copyBytes = Math.min(page.byteLength, this.totalBytes - offset);
      output.set(
        copyBytes === page.byteLength ? page : page.subarray(0, copyBytes),
        offset
      );
      offset += copyBytes;
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

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object'
    ? (error as { code?: string }).code
    : undefined;
}

interface ResolvedLocalExportDestination {
  replacementPath: string;
  metadata?: ReplacementFileMetadata;
  generation: LocalExportGeneration;
}

interface LocalExportFingerprint {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
}

type LocalExportGeneration =
  | { exists: true; fingerprint: LocalExportFingerprint }
  | { exists: false };

function localExportFingerprint(stats: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
}): LocalExportFingerprint {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid
  };
}

function sameLocalExportFingerprint(
  left: LocalExportFingerprint,
  right: LocalExportFingerprint
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
}

function assertLocalExportDestinationUnchanged(
  fs: NodeFs,
  destination: ResolvedLocalExportDestination
): void {
  if (!destination.generation.exists) {
    try {
      fs.lstatSync(destination.replacementPath);
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return;
      throw new Error('Cannot verify the export destination before replacement', {
        cause: error
      });
    }
    throw new Error('Export destination appeared during the export; retry');
  }

  let current: LocalExportFingerprint;
  try {
    current = localExportFingerprint(
      fs.statSync(destination.replacementPath, { bigint: true })
    );
  } catch (error) {
    throw new Error('Export destination changed during the export; retry', {
      cause: error
    });
  }
  if (!sameLocalExportFingerprint(destination.generation.fingerprint, current)) {
    throw new Error('Export destination changed during the export; retry');
  }
}

async function resolveLocalExportDestination(
  fs: NodeFs,
  finalPath: string
): Promise<ResolvedLocalExportDestination> {
  try {
    // Replacing the canonical target preserves an existing destination symlink
    // while retaining the sibling-temp atomic swap on the target filesystem.
    const replacementPath = await fs.promises.realpath(finalPath);
    const targetStats = await fs.promises.stat(replacementPath, { bigint: true });
    return {
      replacementPath,
      // Read metadata from the resolved target, not the symlink directory entry.
      metadata: replacementFileMetadataFromStats(targetStats),
      generation: { exists: true, fingerprint: localExportFingerprint(targetStats) }
    };
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error;
  }

  try {
    await fs.promises.lstat(finalPath);
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') {
      return { replacementPath: finalPath, generation: { exists: false } };
    }
    throw error;
  }

  // realpath can fail with ENOENT for a dangling symlink. Replacing that
  // directory entry would silently destroy the link instead of exporting to
  // its intended target, so fail explicitly.
  throw new Error(`Cannot resolve existing local export destination: ${finalPath}`);
}

function warnAfterSuccessfulLocalExportRename(
  failure: OwnershipPreservationFailure
): void {
  const { uid, gid, error } = failure;
  try {
    console.warn(
      '[SQLite Explorer] Export replaced the destination, but could not restore its previous '
      + `owner/group (uid ${uid}, gid ${gid}). Access based only on the previous owner/group may change:`,
      error
    );
  } catch {
    // A diagnostic sink must not turn an already-renamed export into a false failure.
  }
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
  const destination = await resolveLocalExportDestination(fs, uri.fsPath);
  const destinationPath = destination.replacementPath;
  const tempPath = localSiblingTempPath(destinationPath);
  let sink: AwaitedNodeStreamSink | undefined;
  let ownershipPreservationFailure: OwnershipPreservationFailure | undefined;
  try {
    const stream = fs.createWriteStream(tempPath, {
      encoding: 'utf8',
      flags: 'wx',
      // Existing content stays private until its original ordinary mode is
      // restored. New files use Node's normal 0666-and-process-umask policy.
      mode: destination.metadata ? 0o600 : 0o666
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
    if (destination.metadata) {
      ownershipPreservationFailure = await sink.restoreMetadata(fs, destination.metadata);
    }
    await sink.close();
    assertExportNotCancelled(cancellation);
    assertLocalExportDestinationUnchanged(fs, destination);
    await fs.promises.rename(tempPath, destinationPath);
    if (ownershipPreservationFailure) {
      warnAfterSuccessfulLocalExportRename(ownershipPreservationFailure);
    }
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

interface WorkspaceExportFingerprint {
  type: number;
  ctime: number;
  mtime: number;
  size: number;
  permissions: number | undefined;
  digest: Uint8Array;
}

type WorkspaceExportGeneration =
  | { exists: true; fingerprint: WorkspaceExportFingerprint }
  | { exists: false };

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameWorkspaceStat(
  left: Omit<WorkspaceExportFingerprint, 'digest'>,
  right: Omit<WorkspaceExportFingerprint, 'digest'>
): boolean {
  return left.type === right.type
    && left.ctime === right.ctime
    && left.mtime === right.mtime
    && left.size === right.size
    && left.permissions === right.permissions;
}

async function captureWorkspaceExportGeneration(
  uri: vsc.Uri
): Promise<WorkspaceExportGeneration> {
  let stat: vsc.FileStat;
  try {
    stat = await vsc.workspace.fs.stat(uri);
  } catch (error) {
    if (isMissingWorkspaceFile(error)) return { exists: false };
    throw new Error('Cannot inspect the export destination before writing', { cause: error });
  }
  if ((stat.type & vsc.FileType.SymbolicLink) !== 0) {
    throw new Error('Cannot safely replace a symbolic-link destination through this workspace provider');
  }
  if ((stat.type & vsc.FileType.File) === 0
    || !Number.isSafeInteger(stat.size)
    || stat.size < 0
    || stat.size > NON_LOCAL_EXPORT_MAX_BYTES) {
    throw new Error(
      'Existing non-local export destination cannot be safely conflict-checked; '
      + `it must be a regular file no larger than ${NON_LOCAL_CAP_DESCRIPTION}`
    );
  }
  const bytes = await vsc.workspace.fs.readFile(uri);
  if (bytes.byteLength !== stat.size) {
    throw new Error('Export destination changed while its initial state was being inspected');
  }
  const verifiedStat = await vsc.workspace.fs.stat(uri);
  const statFingerprint = {
    type: verifiedStat.type,
    ctime: verifiedStat.ctime,
    mtime: verifiedStat.mtime,
    size: verifiedStat.size,
    permissions: verifiedStat.permissions
  };
  if (!sameWorkspaceStat(
    {
      type: stat.type,
      ctime: stat.ctime,
      mtime: stat.mtime,
      size: stat.size,
      permissions: stat.permissions
    },
    statFingerprint
  )) {
    throw new Error('Export destination changed while its initial state was being inspected');
  }
  const digestInput = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(digestInput).set(bytes);
  const digest = new Uint8Array(await webCrypto.subtle.digest('SHA-256', digestInput));
  return { exists: true, fingerprint: { ...statFingerprint, digest } };
}

async function assertWorkspaceExportDestinationUnchanged(
  uri: vsc.Uri,
  initial: WorkspaceExportGeneration
): Promise<void> {
  const current = await captureWorkspaceExportGeneration(uri);
  if (!initial.exists) {
    if (!current.exists) return;
    throw new Error('Export destination appeared during the export; retry');
  }
  if (!current.exists
    || !sameWorkspaceStat(initial.fingerprint, current.fingerprint)
    || !sameBytes(initial.fingerprint.digest, current.fingerprint.digest)) {
    throw new Error('Export destination changed during the export; retry');
  }
}

async function exportWorkspaceAtomic(
  uri: vsc.Uri,
  document: DatabaseDocument,
  tableName: string,
  columns: string[],
  options: ExportOptions,
  cancellation?: ExportCancellation
): Promise<number> {
  const destinationGeneration = await captureWorkspaceExportGeneration(uri);
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
    await assertWorkspaceExportDestinationUnchanged(uri, destinationGeneration);
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
): Promise<ExportTableCommandResult> {
  try {
    const tableName = dbParams.table;
    if (!tableName) {
      const message = 'No table specified for export';
      showExportNotification(vsc.window.showErrorMessage(message));
      return { success: false, message };
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
      if (!formatPick) return { success: false, cancelled: true };
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
      if (!document) {
        const message = 'The requested database is no longer open';
        showExportNotification(vsc.window.showErrorMessage(message));
        return { success: false, message };
      }
    } else {
      for (const [, doc] of DocumentRegistry) {
        document = doc;
        break;
      }
    }

    if (!document || !document.databaseOperations) {
      const message = 'No active database connection';
      showExportNotification(vsc.window.showErrorMessage(message));
      return { success: false, message };
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
      const message = (e as Error).message;
      showExportNotification(vsc.window.showErrorMessage(message));
      return { success: false, message };
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
    if (!uri) return { success: false, cancelled: true };

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
    showExportNotification(vsc.window.showInformationMessage(
      `Exported ${rowCount} row${rowCount === 1 ? '' : 's'} to `
      + `${uri.fsPath || uri.toString()}`
    ));
    return {
      success: true,
      rowCount,
      destination: uri.fsPath || uri.toString()
    };

  } catch (err) {
    if (isCancellationError(err)) {
      showExportNotification(vsc.window.showInformationMessage('Export cancelled'));
      return { success: false, cancelled: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    showExportNotification(vsc.window.showErrorMessage(`Export failed: ${message}`));
    console.error('Export error:', err);
    return { success: false, message };
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
    return typeof value === 'string' ? encodeCsvExportText(value) : String(value);
  };

  const lines = [];
  if (includeHeader) {
    lines.push(columns.map(encodeCsvExportText).join(','));
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
    const obj = Object.create(null) as Record<string, CellValue>;
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
