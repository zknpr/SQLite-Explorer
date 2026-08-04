import '../../unit/vscode_mock_setup'; // Must precede imports that load vscode.

import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';

import { createNativeDatabaseConnection } from '../../../src/nativeWorker';
import { serializeValue } from '../../../src/core/serialization';
import { ModificationTracker } from '../../../src/core/undo-history';
import { HostBridge } from '../../../src/hostBridge';
import { SQLiteFileSystemProvider } from '../../../src/virtualFileSystem';
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
    const { value } = await fetchGridCell(operations, options.kind);
    const after = memorySnapshot();
    return {
      mode: options.mode,
      kind: options.kind,
      rawCellBytes: options.sizeBytes,
      transportedCellBytes: cellByteLength(value),
      valueType: value instanceof Uint8Array ? 'Uint8Array' : typeof value,
      oversized: false,
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
  return withNative(options.fixture, true, async operations => {
    const { result, value } = await fetchGridCell(operations, 'blob');
    let serialized: any;
    try {
      serialized = serializeValue(result);
    } catch (error) {
      return {
        mode: options.mode,
        rawCellBytes: cellByteLength(value),
        failureStage: 'base64-serialize',
        error: diagnostic(error),
        elapsedMs: performance.now() - startedAt,
        memoryBefore: before,
        memoryAfter: memorySnapshot()
      };
    }

    const rowsBase64Chars = serialized?.rows?.[0]?.[2]?.base64?.length ?? 0;
    const valuesBase64Chars = serialized?.values?.[0]?.[2]?.base64?.length ?? 0;
    try {
      const json = JSON.stringify({
        channel: 'rpc',
        content: { kind: 'response', success: true, data: serialized }
      });
      return {
        mode: options.mode,
        rawCellBytes: cellByteLength(value),
        failureStage: 'unbounded-success',
        rowsBase64Chars,
        valuesBase64Chars,
        jsonChars: json.length,
        elapsedMs: performance.now() - startedAt,
        memoryBefore: before,
        memoryAfter: memorySnapshot()
      };
    } catch (error) {
      return {
        mode: options.mode,
        rawCellBytes: cellByteLength(value),
        failureStage: 'json-stringify',
        rowsBase64Chars,
        valuesBase64Chars,
        error: diagnostic(error),
        elapsedMs: performance.now() - startedAt,
        memoryBefore: before,
        memoryAfter: memorySnapshot()
      };
    }
  });
}

async function probeWebviewUpdateRequest(options: ProbeOptions): Promise<Record<string, unknown>> {
  const before = memorySnapshot();
  const startedAt = performance.now();
  const bytes = new Uint8Array(options.sizeBytes);
  bytes.fill(0x42);
  let resolvePosted!: (message: any) => void;
  const posted = new Promise<any>(resolve => { resolvePosted = resolve; });
  (globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState: () => undefined,
    postMessage: (message: unknown) => resolvePosted(message)
  });

  const apiPath = pathToFileURL(path.join(REPO_ROOT, 'core', 'ui', 'modules', 'api.js')).href;
  const api = await import(`${apiPath}?large-cell-probe=${process.pid}`);
  const request = api.backendApi.updateCell('large_cells', 1, 'payload', bytes, null);
  const message = await posted;
  const base64Chars = message?.content?.payload?.[3]?.base64?.length ?? 0;
  api.handleRpcResponse({
    kind: 'response',
    messageId: message.content.messageId,
    success: true,
    data: null
  });
  await request;
  return {
    mode: options.mode,
    rawCellBytes: bytes.byteLength,
    failureStage: 'unbounded-success',
    base64Chars,
    elapsedMs: performance.now() - startedAt,
    memoryBefore: before,
    memoryAfter: memorySnapshot()
  };
}

async function probeBlobInspector(options: ProbeOptions): Promise<Record<string, unknown>> {
  const before = memorySnapshot();
  const startedAt = performance.now();
  return withNative(options.fixture, true, async operations => {
    const { value } = await fetchGridCell(operations, 'blob');
    if (!(value instanceof Uint8Array)) throw new Error('BLOB fixture did not return Uint8Array');

    let largestDomTextChars = 0;
    const createElement = () => {
      let text = '';
      return {
        style: {},
        className: '',
        appendChild: () => undefined,
        set textContent(value: string) {
          text = value;
          largestDomTextChars = Math.max(largestDomTextChars, value.length);
        },
        get textContent() { return text; }
      };
    };
    (globalThis as any).document = { createElement };
    const modulePath = pathToFileURL(
      path.join(REPO_ROOT, 'core', 'ui', 'modules', 'blob-inspector.js')
    ).href;
    const { BlobInspector } = await import(`${modulePath}?large-cell-probe=${process.pid}`);
    const inspector = Object.create(BlobInspector.prototype);
    inspector.previewContainer = { appendChild: () => undefined };
    const type = inspector.detectType(value);
    inspector.renderPreview(value, type);

    return {
      mode: options.mode,
      rawCellBytes: value.byteLength,
      detectedType: type.type,
      largestDomTextChars,
      elapsedMs: performance.now() - startedAt,
      memoryBefore: before,
      memoryAfter: memorySnapshot()
    };
  });
}

async function probeVfsRead(options: ProbeOptions): Promise<Record<string, unknown>> {
  const before = memorySnapshot();
  const startedAt = performance.now();
  return withNative(options.fixture, true, async operations => {
    const documentKey = 'large-cell-probe';
    const document = {
      databaseOperations: operations,
      connectionGeneration: 0,
      isReadOnlyMode: true,
      onDidChangeContent: () => new vscode.Disposable(() => undefined),
      onDidDispose: () => new vscode.Disposable(() => undefined),
      recordExternalModification: () => undefined
    };
    DocumentRegistry.set(documentKey, document as any);
    try {
      const provider = new SQLiteFileSystemProvider();
      const rowId = options.kind === 'blob' ? 1 : 2;
      const uri = vscode.Uri.parse(
        `vscode-sqlite://${documentKey}/large_cells/group/${rowId}/payload.txt`
      );
      const content = await provider.readFile(uri);
      return {
        mode: options.mode,
        kind: options.kind,
        rawCellBytes: options.sizeBytes,
        returnedBytes: content.byteLength,
        elapsedMs: performance.now() - startedAt,
        memoryBefore: before,
        memoryAfter: memorySnapshot()
      };
    } finally {
      DocumentRegistry.delete(documentKey);
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
  try {
    return await withNative(scratch, false, async operations => {
      const tracker = new ModificationTracker<ProbeModification>(100, 50 * 1024 * 1024);
      const document = {
        uri: vscode.Uri.file(scratch),
        documentKey: Promise.resolve('large-cell-probe'),
        databaseOperations: operations,
        connectionGeneration: 0,
        isReadOnlyMode: false,
        recordExternalModification: (modification: ProbeModification) => tracker.record(modification)
      };
      const bridge = new HostBridge({
        webviews: new Map(),
        context: {},
        isReadOnly: false
      } as any, document as any);
      await bridge.updateCell('large_cells', 1, 'payload', 'replacement');
      const undoable = tracker.canStepBack;
      const entry = tracker.stepBack() as ProbeModification | undefined;
      const retainedPriorBytes = cellByteLength(entry?.priorValue);
      return {
        mode: options.mode,
        rawCellBytes: options.sizeBytes,
        undoable,
        retainedPriorBytes,
        historyEntryCountBeforeUndo: undoable ? 1 : 0,
        elapsedMs: performance.now() - startedAt,
        memoryBefore: before,
        memoryAfter: memorySnapshot()
      };
    });
  } finally {
    await removeDatabaseFiles(scratch);
  }
}

async function probeExportJson(options: ProbeOptions): Promise<Record<string, unknown>> {
  const before = memorySnapshot();
  const startedAt = performance.now();
  return withNative(options.fixture, true, async operations => {
    const require = createRequire(import.meta.url);
    const nodeFs = require('node:fs') as typeof import('node:fs');
    const originalCreateWriteStream = nodeFs.createWriteStream;
    const originalShowSaveDialog = (vscode.window as any).showSaveDialog;
    const originalShowInformationMessage = (vscode.window as any).showInformationMessage;
    const originalShowErrorMessage = (vscode.window as any).showErrorMessage;
    const documentKey = 'large-cell-export-probe';
    const documentUri = vscode.Uri.file(options.fixture);
    let largestWriteChars = 0;
    let totalWriteChars = 0;
    let exportError = '';

    DocumentRegistry.set(documentKey, {
      uri: documentUri,
      databaseOperations: operations
    } as any);
    try {
      (nodeFs as any).createWriteStream = () => ({
        write(chunk: string) {
          largestWriteChars = Math.max(largestWriteChars, chunk.length);
          totalWriteChars += chunk.length;
          return true;
        },
        end() {}
      });
      (vscode.window as any).showSaveDialog = async () => vscode.Uri.file(
        path.join(options.scratchRoot, 'large-cell-export.json')
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
        { format: 'json', rowIds: [1] }
      );

      if (exportError) throw new Error(exportError);
      return {
        mode: options.mode,
        rawCellBytes: options.sizeBytes,
        largestWriteChars,
        totalWriteChars,
        elapsedMs: performance.now() - startedAt,
        memoryBefore: before,
        memoryAfter: memorySnapshot()
      };
    } finally {
      (nodeFs as any).createWriteStream = originalCreateWriteStream;
      (vscode.window as any).showSaveDialog = originalShowSaveDialog;
      (vscode.window as any).showInformationMessage = originalShowInformationMessage;
      (vscode.window as any).showErrorMessage = originalShowErrorMessage;
      DocumentRegistry.delete(documentKey);
    }
  });
}

async function probeWebDemoResponse(options: ProbeOptions): Promise<Record<string, unknown>> {
  const before = memorySnapshot();
  const startedAt = performance.now();
  let postedRequest: any;
  let resolvePosted!: () => void;
  const posted = new Promise<void>(resolve => { resolvePosted = resolve; });
  const parentWindow = {
    postMessage(message: unknown) {
      postedRequest = message;
      resolvePosted();
    }
  };
  (globalThis as any).window = {
    parent: parentWindow,
    location: { ancestorOrigins: ['https://demo.test'] },
    addEventListener: () => undefined
  };
  const modulePath = pathToFileURL(
    path.join(REPO_ROOT, 'core', 'ui', 'modules', 'web-api.js')
  ).href;
  const webApi = await import(`${modulePath}?large-cell-probe=${process.pid}`);
  const pending = webApi.sendRpcRequest('fetchTableData', []);
  await posted;
  const messageId = postedRequest?.content?.messageId;
  if (!messageId) throw new Error('Web demo API did not post an RPC request');

  const raw = new Uint8Array(options.sizeBytes);
  webApi.handleRpcResponse({
    kind: 'response',
    messageId,
    success: true,
    data: { rows: [[1, 'blob', raw]] }
  });
  const result = await pending;
  const returned = result?.rows?.[0]?.[2];
  return {
    mode: options.mode,
    rawCellBytes: raw.byteLength,
    failureStage: 'typed-array-enumeration',
    returnedType: returned instanceof Uint8Array ? 'Uint8Array' : typeof returned,
    elapsedMs: performance.now() - startedAt,
    memoryBefore: before,
    memoryAfter: memorySnapshot()
  };
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
