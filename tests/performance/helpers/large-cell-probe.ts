import '../../unit/vscode_mock_setup'; // Must precede imports that load vscode.

import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';

import { createNativeDatabaseConnection } from '../../../src/nativeWorker';
import { serializeValue } from '../../../src/core/serialization';
import { ModificationTracker } from '../../../src/core/undo-history';
import { HostBridge, toWebviewQueryResultSet } from '../../../src/hostBridge';
import { CellMaterializationService, type MaterializedCell } from '../../../src/cellMaterialization';
import { CELL_TEXT_PAGE_BYTES } from '../../../src/cellContentViewer';
import {
  WEBVIEW_TRANSPORT_SURFACES,
  toWebviewPayloadLimitErrorData
} from '../../../src/core/webview-transport';
import { DocumentRegistry } from '../../../src/documentRegistry';
import { exportTableCommand } from '../../../src/tableExporter';
import type { DatabaseConnectionBundle } from '../../../src/connectionTypes';
import type { CellValue, DatabaseOperations, LabeledModification } from '../../../src/core/types';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

type ProbeKind = 'blob' | 'text';

interface ProbeOptions {
  mode: string;
  fixture: string;
  kind: ProbeKind;
  sizeBytes: number;
  scratchRoot: string;
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parsePositiveInteger(raw: string, option: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${option} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${option} must be a positive integer`);
  return value;
}

function parseArgs(argv: string[]): ProbeOptions {
  let mode = '';
  let fixture = '';
  let kind: ProbeKind = 'blob';
  let sizeBytes = 0;
  let scratchRoot = '';

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--mode') {
      mode = requireValue(argv, index, '--mode');
      index++;
    } else if (argument === '--fixture') {
      fixture = requireValue(argv, index, '--fixture');
      index++;
    } else if (argument === '--kind') {
      const value = requireValue(argv, index, '--kind');
      if (value !== 'blob' && value !== 'text') throw new Error('--kind must be blob or text');
      kind = value;
      index++;
    } else if (argument === '--size-bytes') {
      sizeBytes = parsePositiveInteger(requireValue(argv, index, '--size-bytes'), '--size-bytes');
      index++;
    } else if (argument === '--scratch-root') {
      scratchRoot = requireValue(argv, index, '--scratch-root');
      index++;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!mode || !fixture || !sizeBytes || !scratchRoot) {
    throw new Error('--mode, --fixture, --size-bytes, and --scratch-root are required');
  }
  return {
    mode,
    fixture: path.resolve(fixture),
    kind,
    sizeBytes,
    scratchRoot: path.resolve(scratchRoot)
  };
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    maxRssBytes: process.resourceUsage().maxRSS * 1024
  };
}

function cellByteLength(value: CellValue | undefined): number {
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  return 0;
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`LARGE_CELL_PROBE ${JSON.stringify(payload)}\n`);
}

function transportErrorFields(error: unknown): Record<string, unknown> {
  const typed = toWebviewPayloadLimitErrorData(error);
  return typed
    ? {
      errorName: typed.name,
      errorCode: typed.code,
      errorSurface: typed.surface,
      errorKind: typed.kind,
      errorActualBytes: typed.actualBytes,
      errorLimitBytes: typed.limitBytes,
      errorMessage: typed.message
    }
    : { error: diagnostic(error) };
}

async function openNative(
  databasePath: string,
  readOnly: boolean
): Promise<{ bundle: DatabaseConnectionBundle; operations: DatabaseOperations }> {
  const bundle = await createNativeDatabaseConnection(vscode.Uri.file(REPO_ROOT));
  try {
    const connection = await bundle.establishConnection(
      vscode.Uri.file(databasePath),
      path.basename(databasePath),
      readOnly
    );
    return { bundle, operations: connection.databaseOps };
  } catch (error) {
    bundle.workerMethods[Symbol.dispose]();
    throw error;
  }
}

async function withNative<T>(
  databasePath: string,
  readOnly: boolean,
  body: (operations: DatabaseOperations) => Promise<T>
): Promise<T> {
  const connection = await openNative(databasePath, readOnly);
  try {
    return await body(connection.operations);
  } finally {
    connection.bundle.workerMethods[Symbol.dispose]();
  }
}

async function fetchGridCell(operations: DatabaseOperations, kind: ProbeKind) {
  const result = await operations.fetchTableData('large_cells', {
    columns: ['rowid', 'kind', 'payload'],
    filters: [{ column: 'kind', value: kind }],
    limit: 1,
    offset: 0
  });
  const row = result.rows[0];
  if (!row) throw new Error(`No ${kind} fixture row returned`);
  return { result, value: row[2] };
}

async function cloneFixture(options: ProbeOptions): Promise<string> {
  const scratch = path.join(options.scratchRoot, `mutable-${options.mode}-${process.pid}.sqlite`);
  try {
    await fs.copyFile(options.fixture, scratch, fsConstants.COPYFILE_FICLONE);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOTSUP') {
      await fs.copyFile(options.fixture, scratch);
    } else {
      throw error;
    }
  }
  return scratch;
}

async function removeDatabaseFiles(databasePath: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) {
    await fs.rm(`${databasePath}${suffix}`, { force: true });
  }
}

async function probeGridFetch(options: ProbeOptions): Promise<Record<string, unknown>> {
  const before = memorySnapshot();
  const startedAt = performance.now();
  return withNative(options.fixture, true, async operations => {
    const { result, value } = await fetchGridCell(operations, options.kind);
    const metadata = result.oversizedCells?.[0]?.[2];
    const webviewResult = toWebviewQueryResultSet(result);
    const serializedResponseChars = JSON.stringify(serializeValue(webviewResult)).length;
    const after = memorySnapshot();
    return {
      mode: options.mode,
      kind: options.kind,
      rawCellBytes: options.sizeBytes,
      transportedCellBytes: cellByteLength(value),
      valueType: value instanceof Uint8Array ? 'Uint8Array' : typeof value,
      oversized: metadata !== undefined,
      storageClass: metadata?.storageClass,
      sourceCellBytes: metadata?.byteLength,
      serializedResponseChars,
      hasValuesAlias: 'values' in webviewResult,
      hasRecordsAlias: 'records' in webviewResult,
      maxRssBytes: after.maxRssBytes,
      elapsedMs: performance.now() - startedAt,
      memoryBefore: before,
      memoryAfter: after
    };
  });
}

async function probeWindowedRead(options: ProbeOptions): Promise<Record<string, unknown>> {
  const before = memorySnapshot();
  const startedAt = performance.now();
  return withNative(options.fixture, true, async operations => {
    const result = await operations.executeQuery(
      'SELECT kind, typeof(payload), octet_length(payload), substr(payload, 1, ?) ' +
      'FROM large_cells ORDER BY kind',
      [64 * 1024]
    );
    const rows = result[0]?.rows ?? [];
    return {
      mode: options.mode,
      kinds: rows.map(row => row[0]),
      storageClasses: rows.map(row => row[1]),
      sourceBytes: rows.map(row => Number(row[2])),
      windowBytes: rows.map(row => cellByteLength(row[3])),
      elapsedMs: performance.now() - startedAt,
      memoryBefore: before,
      memoryAfter: memorySnapshot()
    };
  });
}

async function probeHostWebviewResponse(options: ProbeOptions): Promise<Record<string, unknown>> {
  const before = memorySnapshot();
  const startedAt = performance.now();
  const raw = new Uint8Array(options.sizeBytes);
  raw.fill(0x42);
  try {
    serializeValue({ headers: ['payload'], rows: [[raw]] }, {
      surface: WEBVIEW_TRANSPORT_SURFACES.hostResponse
    });
    const after = memorySnapshot();
    return {
      mode: options.mode,
      rawCellBytes: raw.byteLength,
      failureStage: 'unbounded-success',
      maxRssBytes: after.maxRssBytes,
      elapsedMs: performance.now() - startedAt,
      memoryBefore: before,
      memoryAfter: after
    };
  } catch (error) {
    const after = memorySnapshot();
    return {
      mode: options.mode,
      rawCellBytes: raw.byteLength,
      failureStage: toWebviewPayloadLimitErrorData(error) ? 'size-guard' : 'serialize-error',
      ...transportErrorFields(error),
      maxRssBytes: after.maxRssBytes,
      elapsedMs: performance.now() - startedAt,
      memoryBefore: before,
      memoryAfter: after
    };
  }
}

async function probeWebviewUpdateRequest(options: ProbeOptions): Promise<Record<string, unknown>> {
  const before = memorySnapshot();
  const startedAt = performance.now();
  const bytes = new Uint8Array(options.sizeBytes);
  bytes.fill(0x42);
  let posted = false;
  (globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState: () => undefined,
    postMessage: () => { posted = true; }
  });

  const apiPath = pathToFileURL(path.join(REPO_ROOT, 'core', 'ui', 'modules', 'api.js')).href;
  const api = await import(`${apiPath}?large-cell-probe=${process.pid}`);
  try {
    await api.backendApi.updateCell('large_cells', 1, 'payload', bytes, null);
    const after = memorySnapshot();
    return {
      mode: options.mode,
      rawCellBytes: bytes.byteLength,
      failureStage: 'unbounded-success',
      posted,
      maxRssBytes: after.maxRssBytes,
      elapsedMs: performance.now() - startedAt,
      memoryBefore: before,
      memoryAfter: after
    };
  } catch (error) {
    const after = memorySnapshot();
    return {
      mode: options.mode,
      rawCellBytes: bytes.byteLength,
      failureStage: toWebviewPayloadLimitErrorData(error) ? 'size-guard' : 'request-error',
      posted,
      ...transportErrorFields(error),
      maxRssBytes: after.maxRssBytes,
      elapsedMs: performance.now() - startedAt,
      memoryBefore: before,
      memoryAfter: after
    };
  }
}

async function probeBlobInspector(options: ProbeOptions): Promise<Record<string, unknown>> {
  const before = memorySnapshot();
  const startedAt = performance.now();
  return withNative(options.fixture, true, async operations => {
    const { result, value } = await fetchGridCell(operations, 'blob');
    if (!(value instanceof Uint8Array)) throw new Error('BLOB fixture did not return Uint8Array');
    const metadata = result.oversizedCells?.[0]?.[2];
    if (!metadata) throw new Error('BLOB fixture was not marked oversized');

    let largestDomTextChars = 0;
    interface ProbeElement {
      style: Record<string, string>;
      className: string;
      textContent: string;
      appendChild(child: ProbeElement): void;
      addEventListener(): void;
      setAttribute(): void;
    }
    const createElement = (): ProbeElement => {
      let text = '';
      const children: ProbeElement[] = [];
      return {
        style: {},
        className: '',
        appendChild: child => { children.push(child); },
        addEventListener: () => undefined,
        setAttribute: () => undefined,
        set textContent(value: string) {
          text = value;
          children.length = 0;
          largestDomTextChars = Math.max(largestDomTextChars, value.length);
        },
        get textContent() { return text + children.map(child => child.textContent).join(''); }
      };
    };
    (globalThis as any).document = { createElement, getElementById: () => null };
    const modulePath = pathToFileURL(
      path.join(REPO_ROOT, 'core', 'ui', 'modules', 'blob-inspector.js')
    ).href;
    const { BlobInspector } = await import(`${modulePath}?large-cell-probe=${process.pid}`);
    const inspector = Object.create(BlobInspector.prototype);
    inspector.currentObjectUrl = null;
    inspector.previewContainer = createElement();
    inspector.hexContainer = createElement();
    inspector.infoContainer = { textContent: '' };
    inspector.modal = { classList: { remove: () => undefined } };
    inspector.cleanup = () => undefined;
    inspector.setUploadState = () => undefined;
    inspector.switchTab = () => undefined;
    await inspector.inspectOversized(value, metadata, 1, 'payload', 0, 0);
    const after = memorySnapshot();

    return {
      mode: options.mode,
      rawCellBytes: options.sizeBytes,
      sourceCellBytes: metadata.byteLength,
      transportedCellBytes: value.byteLength,
      inspectorPreviewBytes: inspector.currentData.byteLength,
      detectedType: inspector.currentType.type,
      largestDomTextChars,
      previewRenderedChars: inspector.previewContainer.textContent.length,
      hexRenderedChars: inspector.hexContainer.textContent.length,
      elapsedMs: performance.now() - startedAt,
      memoryBefore: before,
      memoryAfter: after,
      maxRssBytes: after.maxRssBytes
    };
  });
}

async function probeVfsRead(options: ProbeOptions): Promise<Record<string, unknown>> {
  const before = memorySnapshot();
  const startedAt = performance.now();
  return withNative(options.fixture, true, async operations => {
    const { value } = await fetchGridCell(operations, options.kind);
    const storageRoot = vscode.Uri.file(
      path.join(options.scratchRoot, `materialized-${process.pid}`)
    );
    const materializer = new CellMaterializationService(storageRoot);
    let snapshot: MaterializedCell | undefined;
    const materialize = materializer.materialize.bind(materializer);
    materializer.materialize = async (...args) => {
      snapshot = await materialize(...args);
      return snapshot;
    };
    let panel: vscode.WebviewPanel | undefined;
    let receive: ((message: unknown) => unknown) | undefined;
    const messages: unknown[] = [];
    const openedCommandUris: string[] = [];
    let vfsReadFileCalled = false;
    const originalExecuteCommand = vscode.commands.executeCommand;
    const originalCreatePanel = vscode.window.createWebviewPanel;
    const originalReadFile = vscode.workspace.fs.readFile;
    const document = {
      uri: vscode.Uri.file(options.fixture),
      documentKey: Promise.resolve('large-cell-probe'),
      databaseOperations: operations,
      connectionGeneration: 0,
      isReadOnlyMode: true,
      onDidDispose: () => new vscode.Disposable(() => undefined),
      recordExternalModification: () => undefined
    };
    try {
      const rowId = options.kind === 'blob' ? 1 : 2;
      (vscode.commands as any).executeCommand = async (
        command: string,
        uri?: vscode.Uri
      ) => {
        if (command === 'vscode.open' || command === 'vscode.openWith') openedCommandUris.push(uri?.scheme ?? 'missing');
      };
      vscode.workspace.fs.readFile = async uri => {
        vfsReadFileCalled = true;
        return originalReadFile(uri);
      };
      vscode.window.createWebviewPanel = (...args) => {
        const original = originalCreatePanel(...args);
        panel = {
          ...original,
          webview: {
            ...original.webview,
            onDidReceiveMessage: listener => {
              receive = listener;
              return new vscode.Disposable(() => undefined);
            },
            postMessage: async message => { messages.push(message); return true; }
          }
        };
        return panel;
      };
      const bridge = new HostBridge({
        webviews: new Map(),
        context: {},
        isReadOnly: true,
        cellMaterializer: materializer
      } as any, document as any);
      const opened = await bridge.openCellEditor(
        { table: 'large_cells', name: '' },
        rowId,
        'payload',
        {},
        { value }
      );
      if (opened.mode !== 'paged-read-only' || !panel || !receive || !snapshot) {
        throw new Error('Oversized cell did not open the snapshot-backed paginated viewer');
      }
      const stat = await fs.stat(snapshot.uri.fsPath);
      type ContentPage = Awaited<ReturnType<typeof import('../../../src/cellContentViewer').readCellContentPage>>;
      const requestPage = async (page: number, mode: 'text' | 'hex'): Promise<ContentPage> => {
        messages.length = 0;
        await receive!({ type: 'page', page, mode });
        const reply = messages[0];
        if (messages.length !== 1 || !reply || typeof reply !== 'object' || !('type' in reply) || reply.type !== 'page') {
          throw new Error(`Paginated viewer did not return a page: ${JSON.stringify(messages)}`);
        }
        return reply as ContentPage;
      };
      // Exercise the production panel handler against the complete snapshot,
      // including the tail. A manually sampled file alone does not test bounds
      // on the bytes sent to the webview.
      const first = await requestPage(0, 'text');
      const last = await requestPage(Math.ceil(options.sizeBytes / CELL_TEXT_PAGE_BYTES) - 1, 'text');
      const hex = await requestPage(0, 'hex');
      panel.dispose();
      const snapshotReleased = await fs.stat(snapshot.uri.fsPath).then(() => false, error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
        throw error;
      });
      const after = memorySnapshot();
      return {
        mode: options.mode,
        kind: options.kind,
        rawCellBytes: options.sizeBytes,
        openedMode: opened.mode,
        openedScheme: snapshot.uri.scheme,
        openedCommandUris,
        vfsReadFileCalled,
        materializedBytes: stat.size,
        textPagesMatchExpected: first.text === 'T'.repeat(Math.min(options.sizeBytes, CELL_TEXT_PAGE_BYTES))
          && last.text === 'T'.repeat(options.sizeBytes % CELL_TEXT_PAGE_BYTES || CELL_TEXT_PAGE_BYTES),
        firstPageStart: first.byteStart,
        firstPageEnd: first.byteEnd,
        lastPageStart: last.byteStart,
        lastPageEnd: last.byteEnd,
        reportedCellBytes: first.byteLength,
        largestTextPageBytes: Math.max(first.byteEnd - first.byteStart, last.byteEnd - last.byteStart),
        largestTextPageChars: Math.max(first.text.length, last.text.length),
        hexPageBytes: hex.byteEnd - hex.byteStart,
        hexPageChars: hex.text.length,
        hexPrefixMatches: hex.text.startsWith('00000000  ' + '54 '.repeat(15) + '54'),
        snapshotReleased,
        elapsedMs: performance.now() - startedAt,
        memoryBefore: before,
        memoryAfter: after,
        maxRssBytes: after.maxRssBytes
      };
    } finally {
      (vscode.commands as any).executeCommand = originalExecuteCommand;
      vscode.window.createWebviewPanel = originalCreatePanel;
      vscode.workspace.fs.readFile = originalReadFile;
      panel?.dispose();
      materializer.dispose();
    }
  });
}

interface ProbeModification extends LabeledModification {
  priorValue?: CellValue;
  newValue?: CellValue;
}

async function probeCellSaveUndo(options: ProbeOptions): Promise<Record<string, unknown>> {
  const scratch = await cloneFixture(options);
  const before = memorySnapshot();
  const startedAt = performance.now();
  const originalShowWarningMessage = (vscode.window as any).showWarningMessage;
  let confirmationMessage = '';
  try {
    return await withNative(scratch, false, async operations => {
      const tracker = new ModificationTracker<ProbeModification>(100, 50 * 1024 * 1024);
      let containmentReadObserved = false;
      let wholePriorValueReadObserved = false;
      const instrumentedOperations = new Proxy(operations, {
        get(target, property, receiver) {
          if (property !== 'executeQuery') return Reflect.get(target, property, receiver);
          return async (sql: string, params?: CellValue[]) => {
            if (
              /\bFROM\s+(?:main\.)?"large_cells"(?:\s|$)/i.test(sql)
              && sql.includes('"payload"')
            ) {
              const bounded = sql.includes('THEN NULL ELSE "payload" END');
              containmentReadObserved ||= bounded;
              wholePriorValueReadObserved ||= !bounded;
            }
            return operations.executeQuery(sql, params);
          };
        }
      });
      const document = {
        uri: vscode.Uri.file(scratch),
        documentKey: Promise.resolve('large-cell-probe'),
        databaseOperations: instrumentedOperations,
        connectionGeneration: 0,
        isReadOnlyMode: false,
        recordExternalModification: (modification: ProbeModification) => tracker.record(modification)
      };
      (vscode.window as any).showWarningMessage = async (message: string) => {
        confirmationMessage = String(message);
        return { title: 'Replace Without Undo', value: true };
      };
      const bridge = new HostBridge({
        webviews: new Map(),
        context: {},
        isReadOnly: false
      } as any, document as any);
      await bridge.updateCell('large_cells', 1, 'payload', 'replacement');
      const entries = tracker.getUncommittedEntries();
      const entry = entries[0];
      const undoable = tracker.canStepBack;
      const retainedPriorBytes = cellByteLength(entry?.priorValue);
      const after = memorySnapshot();
      return {
        mode: options.mode,
        rawCellBytes: options.sizeBytes,
        undoable,
        redoable: tracker.canStepForward,
        undoPolicy: entry?.undoPolicy,
        retainedPriorBytes,
        historyEntryCount: entries.length,
        confirmationSurfaced: confirmationMessage.length > 0,
        confirmationContainsTarget:
          confirmationMessage.includes('large_cells') && confirmationMessage.includes('payload'),
        confirmationContainsStorageClass: confirmationMessage.includes('BLOB'),
        confirmationContainsExactBytes:
          confirmationMessage.includes(options.sizeBytes.toLocaleString()),
        containmentReadObserved,
        wholePriorValueReadObserved,
        elapsedMs: performance.now() - startedAt,
        memoryBefore: before,
        memoryAfter: after,
        maxRssBytes: after.maxRssBytes
      };
    });
  } finally {
    (vscode.window as any).showWarningMessage = originalShowWarningMessage;
    await removeDatabaseFiles(scratch);
  }
}

async function probeExport(
  options: ProbeOptions,
  format: 'json' | 'sql'
): Promise<Record<string, unknown>> {
  const before = memorySnapshot();
  const startedAt = performance.now();
  return withNative(options.fixture, true, async operations => {
    const require = createRequire(import.meta.url);
    const nodeFs = require('node:fs') as typeof import('node:fs');
    const originalCreateWriteStream = nodeFs.createWriteStream;
    const originalRename = nodeFs.promises.rename;
    const originalShowSaveDialog = (vscode.window as any).showSaveDialog;
    const originalShowInformationMessage = (vscode.window as any).showInformationMessage;
    const originalShowErrorMessage = (vscode.window as any).showErrorMessage;
    const documentKey = 'large-cell-export-probe';
    const documentUri = vscode.Uri.file(options.fixture);
    let largestWriteChars = 0;
    let totalWriteChars = 0;
    let outputPrefix = '';
    let outputSuffix = '';
    let streamClosed = false;
    let renameObserved = false;
    let renameAfterClose = false;
    let exportError = '';

    DocumentRegistry.set(documentKey, {
      uri: documentUri,
      databaseOperations: operations
    } as any);
    try {
      (nodeFs as any).createWriteStream = () => {
        const sink = new Writable({
          decodeStrings: false,
          write(chunk: string | Buffer, _encoding, callback) {
            const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            largestWriteChars = Math.max(largestWriteChars, text.length);
            totalWriteChars += text.length;
            outputPrefix = (outputPrefix + text).slice(0, 256);
            outputSuffix = (outputSuffix + text).slice(-256);
            callback();
          }
        });
        sink.once('close', () => { streamClosed = true; });
        return sink;
      };
      (nodeFs.promises as any).rename = async () => {
        renameObserved = true;
        renameAfterClose = streamClosed;
      };
      (vscode.window as any).showSaveDialog = async () => vscode.Uri.file(
        path.join(options.scratchRoot, `large-cell-export.${format}`)
      );
      (vscode.window as any).showInformationMessage = async () => undefined;
      (vscode.window as any).showErrorMessage = async (message: string) => {
        exportError = message;
        return undefined;
      };

      await exportTableCommand(
        {} as any,
        undefined,
        { table: 'large_cells', uri: documentUri.toString() },
        ['payload'],
        undefined,
        undefined,
        { format, rowIds: [1] }
      );

      if (exportError) throw new Error(exportError);
      const after = memorySnapshot();
      return {
        mode: options.mode,
        format,
        rawCellBytes: options.sizeBytes,
        largestWriteChars,
        totalWriteChars,
        outputPrefix,
        outputSuffix,
        renameObserved,
        renameAfterClose,
        maxRssBytes: after.maxRssBytes,
        elapsedMs: performance.now() - startedAt,
        memoryBefore: before,
        memoryAfter: after
      };
    } finally {
      (nodeFs as any).createWriteStream = originalCreateWriteStream;
      (nodeFs.promises as any).rename = originalRename;
      (vscode.window as any).showSaveDialog = originalShowSaveDialog;
      (vscode.window as any).showInformationMessage = originalShowInformationMessage;
      (vscode.window as any).showErrorMessage = originalShowErrorMessage;
      DocumentRegistry.delete(documentKey);
    }
  });
}

async function probeExportJson(options: ProbeOptions): Promise<Record<string, unknown>> {
  return probeExport(options, 'json');
}

async function probeExportSql(options: ProbeOptions): Promise<Record<string, unknown>> {
  return probeExport(options, 'sql');
}

async function probeWebDemoResponse(options: ProbeOptions): Promise<Record<string, unknown>> {
  const before = memorySnapshot();
  const startedAt = performance.now();
  const modulePath = pathToFileURL(
    path.join(REPO_ROOT, 'website', 'app', 'demo', 'transport.ts')
  ).href;
  const { guardDemoWorkerResponse } = await import(
    `${modulePath}?large-cell-probe=${process.pid}`
  );

  const raw = new Uint8Array(options.sizeBytes);
  raw.fill(0x42);
  let forwardedToIframe = false;
  try {
    guardDemoWorkerResponse({
      channel: 'rpc',
      content: {
        kind: 'response',
        messageId: 'worker-large-cell',
        success: true,
        data: { rows: [[1, 'blob', raw]] }
      }
    });
    // This assignment stands at the DemoClient forwarding seam. A successful
    // Stage-C guard would otherwise permit postMessage to the iframe.
    forwardedToIframe = true;
    const after = memorySnapshot();
    return {
      mode: options.mode,
      rawCellBytes: raw.byteLength,
      failureStage: 'unbounded-success',
      forwardedToIframe,
      maxRssBytes: after.maxRssBytes,
      elapsedMs: performance.now() - startedAt,
      memoryBefore: before,
      memoryAfter: after
    };
  } catch (error) {
    const after = memorySnapshot();
    return {
      mode: options.mode,
      rawCellBytes: raw.byteLength,
      failureStage: toWebviewPayloadLimitErrorData(error) ? 'size-guard' : 'response-error',
      forwardedToIframe,
      ...transportErrorFields(error),
      maxRssBytes: after.maxRssBytes,
      elapsedMs: performance.now() - startedAt,
      memoryBefore: before,
      memoryAfter: after
    };
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const handlers: Record<string, (input: ProbeOptions) => Promise<Record<string, unknown>>> = {
    'grid-fetch': probeGridFetch,
    'windowed-read': probeWindowedRead,
    'host-webview-response': probeHostWebviewResponse,
    'webview-update-request': probeWebviewUpdateRequest,
    'blob-inspector': probeBlobInspector,
    'vfs-read': probeVfsRead,
    'cell-save-undo': probeCellSaveUndo,
    'export-json': probeExportJson,
    'export-sql': probeExportSql,
    'web-demo-response': probeWebDemoResponse
  };
  const handler = handlers[options.mode];
  if (!handler) throw new Error(`Unknown probe mode: ${options.mode}`);
  const result = await handler(options);
  emit(result);
}

main().catch(error => {
  process.stderr.write(`${diagnostic(error)}\n`);
  process.exitCode = 1;
});
