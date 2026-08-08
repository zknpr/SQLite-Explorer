/**
 * Database Editor Provider Module
 *
 * Implements VS Code's CustomEditorProvider for SQLite database files.
 * Manages webview creation, bidirectional communication, and document lifecycle.
 */

import type { TelemetryReporter } from '@vscode/extension-telemetry';

import * as vsc from 'vscode';

import { crypto } from './platform/cryptoShim';
import { ConfigurationSection, CopilotChatId, ExtensionId, FirstInstallMs, FullExtensionId, Ns, SidebarLeft, SidebarRight } from './config';
import { Disposable } from './lifecycle';
import { cspUtil, doTry, toDatasetAttrs, themeToCss, uiKindToString, BoolString, toBoolString, IsCursorIDE, lang } from './helpers';
import { WebviewCollection } from './webview-collection';

import { SupportsWriteMode, IsRemoteWorkspaceMode, DatabaseDocument, isAutoCommitEnabled } from './databaseModel';

import { buildMethodProxy } from './core/rpc';
import { WEBVIEW_TRANSPORT_SURFACES, assertWebviewTransportPayload } from './core/webview-transport';
import { WebviewMessageHandler } from './webviewMessageHandler';
import type { CellMaterializationService } from './cellMaterialization';

// Webview functions interface - methods the webview exposes to extension
interface WebviewBridgeFunctions {
  updateColorScheme(scheme: 'light' | 'dark'): Promise<void>;
  updateCellEditBehavior(value: string): Promise<void>;
  refreshContent(
    filename: string,
    connection?: { connected: boolean; readOnly: boolean }
  ): Promise<void>;
}

// VS Code environment data passed to webview
type VSCODE_ENV = {
  webviewId: string,
  browserExt?: BoolString,
  appName: string,
  appHost: string,
  uriScheme: string,
  extensionUrl: string,
  uiKind?: 'desktop' | 'web',
  firstInstall?: string,
  sidebarLeft?: string
  sidebarRight?: string
  l10nBundle?: string,
  panelVisible?: BoolString,
  panelActive?: BoolString,
  copilotActive?: BoolString,
  autoCommit?: BoolString,
  remoteWorkspace?: BoolString,
  cellEditBehavior?: string,
  defaultPageSize?: string,
  maxRows?: string,
};

/**
 * Read-only database viewer provider.
 *
 * Provides a custom read-only editor for SQLite database files.
 * The webview displays database schema and table contents.
 */
export class DatabaseViewerProvider extends Disposable implements vsc.CustomReadonlyEditorProvider<DatabaseDocument> {
  readonly webviews = new WebviewCollection();
  readonly webviewBridges = new Map<vsc.WebviewPanel, WebviewBridgeFunctions>();

  constructor(
    readonly viewType: string,
    readonly context: vsc.ExtensionContext,
    readonly reporter: TelemetryReporter | undefined,
    readonly outputChannel: vsc.OutputChannel | null,
    readonly isVerified: boolean,
    readonly accessToken?: string,
    readonly forceReadOnly?: boolean,
    readonly cellMaterializer?: CellMaterializationService,
  ) {
    super();
  }

  /**
   * Check if the provider is read-only.
   */
  get isReadOnly(): boolean {
    return true;
  }

  /**
   * Open a SQLite database as a custom document.
   *
   * @param uri - Database file URI
   * @param openContext - Open context with backup info
   * @param token - Cancellation token
   * @returns DatabaseDocument instance
   */
  async openCustomDocument(
    uri: vsc.Uri,
    openContext: vsc.CustomDocumentOpenContext,
    token?: vsc.CancellationToken
  ): Promise<DatabaseDocument> {

    const document = await DatabaseDocument.create(this, uri, openContext, token);

    this.configureEventHandlers(document);

    return document;
  }

  /**
   * Configure event listeners for the document.
   *
   * @param document - DatabaseDocument to listen to
   */
  protected configureEventHandlers(document: DatabaseDocument) {
    // Update webview color scheme when VS Code theme changes
    this._register(vsc.window.onDidChangeActiveColorTheme((theme) => {
      const value = themeToCss(theme);
      for (const bridge of this.#iterateWebviewBridges(document.uri)) {
        bridge.updateColorScheme(value).catch(console.warn);
      }
    }));

    // Update webview settings when configuration changes
    this._register(vsc.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(`${ConfigurationSection}.instantCommit`)) {
        document.autoCommitEnabled = isAutoCommitEnabled();
      }

      if (e.affectsConfiguration(`${ConfigurationSection}.doubleClickBehavior`)) {
        const value = document.cellEditBehavior;
        for (const bridge of this.#iterateWebviewBridges(document.uri)) {
          bridge.updateCellEditBehavior(value).catch(console.warn);
        }
      }
    }));

  }

  /**
   * Iterate all webview bridges for a document URI.
   */
  *#iterateWebviewBridges(uri: vsc.Uri): Generator<WebviewBridgeFunctions> {
    for (const panel of this.webviews.get(uri)) {
      const bridge = this.webviewBridges.get(panel);
      if (bridge) {
        yield bridge;
      }
    }
  }

  /**
   * Create handler for webview panel disposal.
   */
  #createPanelDisposeHandler(webviewPanel: vsc.WebviewPanel) {
    return () => {
      this.webviewBridges.delete(webviewPanel);
    };
  }

  /**
   * Create handler for webview panel view state changes.
   */
  #createViewStateChangeHandler(_webviewPanel: vsc.WebviewPanel, document: DatabaseDocument) {
    return (e: vsc.WebviewPanelOnDidChangeViewStateEvent) => {
      // If the webview panel is active and there is a pending save, save the document
      document.hasActiveViewer = e.webviewPanel.active;
      if (e.webviewPanel.active && document.hasPendingSave) {
        document.triggerSave().catch(() => { });
      }
    };
  }

  /**
   * Resolve a webview panel for the document.
   * Creates the webview HTML and sets up message handling.
   *
   * @param document - DatabaseDocument to display
   * @param webviewPanel - Panel to render in
   * @param _token - Cancellation token
   */
  async resolveCustomEditor(
    document: DatabaseDocument,
    webviewPanel: vsc.WebviewPanel,
    _token: vsc.CancellationToken
  ): Promise<void> {
    const webviewId = crypto.randomUUID();
    this.webviews.add(document.uri, webviewPanel, webviewId);

    // Create RPC proxy for webview communication
    const webviewBridge = buildMethodProxy<WebviewBridgeFunctions>(
      (msg) => {
        assertWebviewTransportPayload(msg, {
          surface: WEBVIEW_TRANSPORT_SURFACES.hostRequest
        });
        webviewPanel.webview.postMessage(msg);
      },
      ['updateColorScheme', 'updateCellEditBehavior', 'refreshContent']
    );
    this.webviewBridges.set(webviewPanel, webviewBridge);

    // Handle messages from webview.
    // Pass the per-proxy pending invocations map so RPC responses from the webview
    // are correctly routed to the bridge proxy for this specific panel.
    const pendingMap = webviewBridge.__pendingInvocations;
    const messageHandler = new WebviewMessageHandler(
      (msg) => webviewPanel.webview.postMessage(msg),
      document.hostBridge,
      pendingMap
    );
    webviewPanel.webview.onDidReceiveMessage((message) => messageHandler.handleMessage(message));

    // Keep the default file grant to the one extension asset directory the
    // page loads. HostBridge temporarily adds exactly one Stage-B run
    // directory while an oversized media URI lease is active.
    const codiconsRoot = vsc.Uri.joinPath(
      this.context.extensionUri,
      'node_modules',
      '@vscode',
      'codicons',
      'dist'
    );
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [codiconsRoot]
    };
    webviewPanel.webview.html = await this.#generateWebviewHtml(webviewPanel, document, webviewId);

    document.hasActiveViewer = webviewPanel.active;

    webviewPanel.onDidChangeViewState(this.#createViewStateChangeHandler(webviewPanel, document)),
      webviewPanel.onDidDispose(this.#createPanelDisposeHandler(webviewPanel));
  }

  /**
   * Generate HTML content for the webview.
   *
   * @param webviewPanel - Panel to render in
   * @param document - DatabaseDocument being displayed
   * @param webviewId - Unique ID for this webview
   * @returns HTML string
   */
  async #generateWebviewHtml(webviewPanel: vsc.WebviewPanel, document: DatabaseDocument, webviewId: string): Promise<string> {
    const { webview } = webviewPanel;
    const nonce = crypto.randomUUID();

    // Load viewer HTML from core/ui directory
    const htmlUri = vsc.Uri.joinPath(this.context.extensionUri, 'core', 'ui', 'viewer.html');
    const html = new TextDecoder().decode(await vsc.workspace.fs.readFile(htmlUri));

    // Load codicons CSS from @vscode/codicons package
    const codiconsUri = vsc.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');

    // Build Content Security Policy
    const cspObj = {
      [cspUtil.defaultSrc]: [webview.cspSource],
      // SECURITY NOTE: 'unsafe-inline' removed for scripts.
      // Inline event handlers have been refactored to use addEventListener.
      // wasm-unsafe-eval is NOT required because sql.js runs in a worker thread, not the webview.
      //
      // NOTE: 'unsafe-inline' for styles has been removed.
      // The <style> tag in viewer.html uses a nonce for CSP compliance.
      // Dynamic inline styles for column widths and positioning are handled via
      // CSSOM (element.style.prop = ...) which is allowed by CSP.
      [cspUtil.scriptSrc]: [webview.cspSource, `'nonce-${nonce}'`],
      [cspUtil.styleSrc]: [webview.cspSource, `'nonce-${nonce}'`],
      [cspUtil.imgSrc]: [webview.cspSource, cspUtil.data, cspUtil.blob],
      [cspUtil.fontSrc]: [webview.cspSource],
      // Oversized media uses asWebviewUri for a 0600 Stage-B file. PDFs are
      // additionally rendered in an empty-sandbox iframe in the inspector.
      [cspUtil.frameSrc]: [webview.cspSource],
      [cspUtil.childSrc]: [webview.cspSource, cspUtil.blob],
      [cspUtil.mediaSrc]: [webview.cspSource, cspUtil.blob],
    };

    // Only set csp for hosts that actually populate `webview.cspSource`. The
    // former VS Code/VSCodium brand check approximated this capability but left
    // Open VSX hosts (Cursor, Windsurf, ...) that report neither brand yet set
    // cspSource correctly with no CSP at all. A host that leaves it empty still
    // falls back to no CSP rather than a policy whose blank source lists would
    // block the webview's own scripts and styles.
    const cspStr = webview.cspSource
      ? cspUtil.build(cspObj)
      : '';

    const { uriScheme, appHost, appName, uiKind } = vsc.env;
    const extensionUrl = uriScheme?.includes('vscode')
      ? `https://marketplace.visualstudio.com/items?itemName=${FullExtensionId}&ref=vscode`
      : `https://open-vsx.org/extension/${Ns}/${ExtensionId}&ref=vscode`;

    // Get configuration settings for the webview
    const config = vsc.workspace.getConfiguration(ConfigurationSection);
    // Fallback must match the declared package.json default (5000) so a host
    // that fails to register the configuration still reports the real default.
    const defaultPageSize = config.get<number>('defaultPageSize', 5000);
    const maxRows = config.get<number>('maxRows', 0);

    // Build environment data for webview
    const vscodeEnv = {
      webviewId,
      browserExt: toBoolString(!!import.meta.env?.VSCODE_BROWSER_EXT),
      uriScheme, appHost, appName, extensionUrl,
      uiKind: uiKindToString(uiKind),
      firstInstall: doTry(() => new Date(this.context.globalState.get<number>(FirstInstallMs) ?? Date.now()).toISOString(), 'Failed to parse first install date'),
      sidebarLeft: this.context.globalState.get<number>(SidebarLeft)?.toString(),
      sidebarRight: this.context.globalState.get<number>(SidebarRight)?.toString(),
      panelVisible: toBoolString(webviewPanel.visible),
      panelActive: toBoolString(webviewPanel.active),
      copilotActive: toBoolString(vsc.extensions.getExtension(CopilotChatId)?.isActive || IsCursorIDE),
      autoCommit: toBoolString(document.autoCommitEnabled),
      remoteWorkspace: toBoolString(IsRemoteWorkspaceMode),
      cellEditBehavior: document.cellEditBehavior,
      defaultPageSize: defaultPageSize.toString(),
      maxRows: maxRows.toString(),
    } satisfies VSCODE_ENV;

    // Replace placeholders in HTML template
    const preparedHtml = html
      .replace('<html lang="en"', `<html lang="${lang}"`)
      .replace(/<!--NONCE-->/g, nonce)
      .replace(/<!--HEAD-->/g, `
        <meta http-equiv="Content-Security-Policy" content="${cspStr}">
        <meta name="color-scheme" content="${themeToCss(vsc.window.activeColorTheme)}">
        <meta id="vscode-env" ${toDatasetAttrs(vscodeEnv)}>
        <link rel="stylesheet" href="${webview.asWebviewUri(codiconsUri)}" crossorigin />
      `)
      .replace(/<!--BODY-->/g, ``);

    return preparedHtml;
  }

}

/**
 * Read-write database editor provider.
 *
 * Extends the read-only provider with edit, save, and revert capabilities.
 */
export class DatabaseEditorProvider extends DatabaseViewerProvider implements vsc.CustomEditorProvider<DatabaseDocument> {
  /**
   * Check if the provider is read-only.
   */
  get isReadOnly(): boolean {
    return false;
  }

  /**
   * Configure event listeners including edit tracking.
   */
  protected configureEventHandlers(document: DatabaseDocument) {
    super.configureEventHandlers(document);

    // Fire edit events to VS Code
    this._register(document.onDidChange(edit => {
      // Tell VS Code that the document has been edited by the user
      this.#editEventEmitter.fire({ document, ...edit });
    }));

    // Update webviews when document content changes
    this._register(document.onDidChangeContent(async change => {
      const { filename } = document.fileParts;
      const connection = change.invalidateAllViewDocuments
        ? { connected: true, readOnly: this.isReadOnly || document.isReadOnlyMode }
        : undefined;
      for (const panel of this.webviews.get(document.uri)) {
        const bridge = this.webviewBridges.get(panel);
        await bridge?.refreshContent(filename, connection);
      }
    }));
  }

  // Edit event emitter for VS Code
  readonly #editEventEmitter = new vsc.EventEmitter<vsc.CustomDocumentEditEvent<DatabaseDocument>>();
  readonly onDidChangeCustomDocument = this.#editEventEmitter.event;

  /**
   * Save the document.
   */
  saveCustomDocument(document: DatabaseDocument, cancellation: vsc.CancellationToken): Thenable<void> {
    return document.save(cancellation);
  }

  /**
   * Save the document to a new location.
   */
  saveCustomDocumentAs(document: DatabaseDocument, destination: vsc.Uri, cancellation: vsc.CancellationToken): Thenable<void> {
    return document.saveAs(destination, cancellation);
  }

  /**
   * Revert the document to last saved state.
   */
  revertCustomDocument(document: DatabaseDocument, cancellation: vsc.CancellationToken): Thenable<void> {
    return document.revert(cancellation);
  }

  /**
   * Create a backup of the document for hot exit.
   */
  backupCustomDocument(document: DatabaseDocument, context: vsc.CustomDocumentBackupContext, cancellation: vsc.CancellationToken): Thenable<vsc.CustomDocumentBackup> {
    return document.backup(context.destination, cancellation);
  }
}

/**
 * Register an editor provider for SQLite files.
 *
 * @param viewType - View type identifier
 * @param context - Extension context
 * @param reporter - Telemetry reporter
 * @param outputChannel - Output channel for logging
 * @param options - Provider options
 * @returns Disposable for the registered provider
 */
export function registerEditorProvider(
  viewType: string,
  context: vsc.ExtensionContext,
  reporter: TelemetryReporter | undefined,
  outputChannel: vsc.OutputChannel | null,
  { verified, accessToken, readOnly }: { verified: boolean, accessToken?: string, readOnly?: boolean },
  cellMaterializer?: CellMaterializationService
) {
  // Optional chaining is required: `import.meta.env` is undefined when this module is require()'d
  // under tsx (unit tests); esbuild's `define` substitutes the value in real builds. Do not make
  // this a bare access to match workerFactory.ts — that module is never required raw in tests.
  // SupportsWriteMode includes the browser extension host only after the
  // in-process WASM engine is available, so the provider gate can stay shared.
  const enableReadWrite = verified && !readOnly && SupportsWriteMode;
  const Provider = enableReadWrite ? DatabaseEditorProvider : DatabaseViewerProvider;
  return vsc.window.registerCustomEditorProvider(
    viewType,
    new Provider(
      viewType,
      context,
      reporter,
      outputChannel,
      verified,
      accessToken,
      readOnly,
      cellMaterializer
    ),
    {
      webviewOptions: {
        enableFindWidget: false,
        // Allow VS Code to destroy the webview when the tab is hidden.
        // The webview persists its state via vscodeApi.setState() / getState()
        // and restores it on re-initialization, saving memory for inactive tabs.
        retainContextWhenHidden: false,
      },
      supportsMultipleEditorsPerDocument: true,
    }
  );
}
