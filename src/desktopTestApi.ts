import * as vsc from 'vscode';

import { ExtensionId } from './config';
import type { CellValue, ExportOptions, QueryResultSet, RecordId } from './core/types';
import {
  DatabaseDocument,
  type DesktopTestDocumentState
} from './databaseModel';
import { DocumentRegistry } from './documentRegistry';
import { DatabaseEditorProvider } from './editorController';
import { GlobalOutputChannel } from './main';
import { exportTableToLocalFileForTests } from './tableExporter';
import {
  setDesktopTestDatabaseBackend,
  setDesktopTestPagedOpenThresholdBytes
} from './workerFactory';

export interface DesktopTestDocumentSnapshot extends DesktopTestDocumentState {
  documentId: string;
  uri: string;
  documentKey: string;
}

export interface DesktopTestApi extends vsc.Disposable {
  readonly version: 1;
  setBackend(backend: 'native' | 'wasm'): void;
  setPagedOpenThresholdBytes(thresholdBytes: number | undefined): void;
  inspectDocument(uri: string): Promise<DesktopTestDocumentSnapshot | null>;
  inspectLifecycle(documentId: string): DesktopTestDocumentSnapshot | null;
  openCustomDocument(
    viewType: string,
    uri: string,
    backupId?: string
  ): Promise<{ handle: string; state: DesktopTestDocumentSnapshot }>;
  disposeCustomDocument(handle: string): Promise<void>;
  query(target: string, sql: string, params?: CellValue[]): Promise<QueryResultSet[]>;
  updateCell(
    target: string,
    table: string,
    rowId: RecordId,
    column: string,
    value: CellValue
  ): Promise<RecordId | void>;
  save(target: string): Promise<void>;
  revert(target: string): Promise<void>;
  backup(target: string, destination: string): Promise<string>;
  exportTable(
    target: string,
    destination: string,
    table: string,
    columns: string[],
    options: ExportOptions
  ): Promise<number>;
}

/**
 * Real extension objects stay inside the bundled extension module graph. This
 * controller returns only opaque handles and snapshots to the separately loaded
 * test extension, avoiding the false assumption that importing src/ shares state.
 */
class DesktopTestController implements DesktopTestApi {
  readonly version = 1 as const;
  readonly #provider: DatabaseEditorProvider;
  readonly #handles = new Map<string, DatabaseDocument>();
  readonly #documentIds = new WeakMap<DatabaseDocument, string>();
  readonly #trackedDocuments = new WeakSet<DatabaseDocument>();
  readonly #lifecycle = new Map<string, DesktopTestDocumentSnapshot>();
  readonly #cancellation = new vsc.CancellationTokenSource();
  #nextHandle = 1;
  #nextDocumentId = 1;
  #disposed = false;

  constructor(context: vsc.ExtensionContext) {
    this.#provider = new DatabaseEditorProvider(
      `${ExtensionId}.view`,
      context,
      undefined,
      GlobalOutputChannel,
      true
    );
  }

  setBackend(backend: 'native' | 'wasm'): void {
    this.#assertActive();
    if (DocumentRegistry.size !== 0 || this.#handles.size !== 0) {
      throw new Error('Close every database document before changing the desktop test backend');
    }
    setDesktopTestDatabaseBackend(backend);
  }

  setPagedOpenThresholdBytes(thresholdBytes: number | undefined): void {
    this.#assertActive();
    if (DocumentRegistry.size !== 0 || this.#handles.size !== 0) {
      throw new Error('Close every database document before changing the desktop test paging threshold');
    }
    setDesktopTestPagedOpenThresholdBytes(thresholdBytes);
  }

  async inspectDocument(uri: string): Promise<DesktopTestDocumentSnapshot | null> {
    this.#assertActive();
    const document = this.#findDocumentByUri(uri);
    return document ? this.#capture(document) : null;
  }

  inspectLifecycle(documentId: string): DesktopTestDocumentSnapshot | null {
    this.#assertActive();
    return this.#lifecycle.get(documentId) ?? null;
  }

  async openCustomDocument(
    viewType: string,
    uri: string,
    backupId?: string
  ): Promise<{ handle: string; state: DesktopTestDocumentSnapshot }> {
    this.#assertActive();
    if (viewType !== `${ExtensionId}.view` && viewType !== `${ExtensionId}.option`) {
      throw new Error(`Unknown SQLite Explorer custom editor viewType: ${viewType}`);
    }
    const document = await this.#provider.openCustomDocument(
      vsc.Uri.parse(uri),
      { backupId, untitledDocumentData: undefined },
      this.#cancellation.token
    );
    const handle = `desktop-document-${this.#nextHandle++}`;
    this.#handles.set(handle, document);
    return { handle, state: await this.#capture(document) };
  }

  async disposeCustomDocument(handle: string): Promise<void> {
    this.#assertActive();
    const document = this.#handles.get(handle);
    if (!document) throw new Error(`Unknown desktop document handle: ${handle}`);
    this.#handles.delete(handle);
    await document.dispose();
  }

  async query(target: string, sql: string, params?: CellValue[]): Promise<QueryResultSet[]> {
    return this.#resolveDocument(target).databaseOperations.executeQuery(sql, params);
  }

  async updateCell(
    target: string,
    table: string,
    rowId: RecordId,
    column: string,
    value: CellValue
  ): Promise<RecordId | void> {
    return this.#resolveDocument(target).hostBridge.updateCell(table, rowId, column, value);
  }

  async save(target: string): Promise<void> {
    await this.#resolveDocument(target).save(this.#cancellation.token);
  }

  async revert(target: string): Promise<void> {
    await this.#resolveDocument(target).revert(this.#cancellation.token);
  }

  async backup(target: string, destination: string): Promise<string> {
    const backup = await this.#resolveDocument(target).backup(
      vsc.Uri.file(destination),
      this.#cancellation.token
    );
    return backup.id;
  }

  async exportTable(
    target: string,
    destination: string,
    table: string,
    columns: string[],
    options: ExportOptions
  ): Promise<number> {
    return exportTableToLocalFileForTests(
      this.#resolveDocument(target),
      destination,
      table,
      columns,
      options
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    setDesktopTestDatabaseBackend(undefined);
    setDesktopTestPagedOpenThresholdBytes(undefined);
    for (const document of new Set(this.#handles.values())) {
      document.dispose().catch(error => {
        GlobalOutputChannel?.appendLine(
          `[DesktopTest] Failed to dispose a test-owned document: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }
    this.#handles.clear();
    this.#cancellation.dispose();
    this.#provider.dispose();
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('Desktop test API has been disposed');
  }

  #findDocumentByUri(uri: string): DatabaseDocument | undefined {
    for (const document of DocumentRegistry.values()) {
      if (document.uri.toString() === uri) return document;
    }
    return undefined;
  }

  #resolveDocument(target: string): DatabaseDocument {
    this.#assertActive();
    const document = this.#handles.get(target) ?? this.#findDocumentByUri(target);
    if (!document) throw new Error(`No open database document for target: ${target}`);
    return document;
  }

  #getDocumentId(document: DatabaseDocument): string {
    let documentId = this.#documentIds.get(document);
    if (!documentId) {
      documentId = `database-document-${this.#nextDocumentId++}`;
      this.#documentIds.set(document, documentId);
    }
    return documentId;
  }

  async #capture(document: DatabaseDocument): Promise<DesktopTestDocumentSnapshot> {
    const documentId = this.#getDocumentId(document);
    const state = await document.getDesktopTestState();
    const snapshot = {
      documentId,
      uri: document.uri.toString(),
      documentKey: await document.documentKey,
      ...state
    };
    this.#lifecycle.set(documentId, snapshot);

    if (!this.#trackedDocuments.has(document)) {
      this.#trackedDocuments.add(document);
      document.onDidDispose(() => {
        this.#capture(document).catch(error => {
          GlobalOutputChannel?.appendLine(
            `[DesktopTest] Failed to capture disposed document state: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      });
    }
    return snapshot;
  }
}

export function createDesktopTestApi(context: vsc.ExtensionContext): DesktopTestApi {
  return new DesktopTestController(context);
}
