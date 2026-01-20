/**
 * Database Editor Provider Module
 *
 * Implements VS Code's CustomEditorProvider for SQLite database files.
 * Manages webview creation, bidirectional communication, and document lifecycle.
 */

import type { TelemetryReporter } from '@vscode/extension-telemetry';

import * as vsc from 'vscode';

import { crypto } from './platform/cryptoShim';
import { ConfigurationSection, CopilotChatId, ExtensionId, FistInstallMs, FullExtensionId, Ns, SidebarLeft, SidebarRight } from './config';
import { Disposable } from './lifecycle';
import { IsVSCode, IsVSCodium, WebviewCollection, cspUtil, doTry, toDatasetAttrs, themeToCss, uiKindToString, BoolString, toBoolString, IsCursorIDE, lang } from './helpers';

import { enterLicenseKeyCommand } from './commandHandlers';
import { SupportsWriteMode, IsRemoteWorkspaceMode, DatabaseDocument, isAutoCommitEnabled } from './databaseModel';

import { buildMethodProxy, processProtocolMessage } from './core/rpc';

// Webview functions interface - methods the webview exposes to extension
interface WebviewBridgeFunctions {
  updateColorScheme(scheme: 'light' | 'dark'): Promise<void>;
  updateAutoCommit(value: boolean): Promise<void>;
  updateCellEditBehavior(value: string): Promise<void>;
  updateViewState(state: { visible: boolean; active: boolean }): Promise<void>;
  updateCopilotActive(active: boolean): Promise<void>;
  refreshContent(filename: string): Promise<void>;
}

// VS Code environment data passed to webview
export type VSCODE_ENV = {
  webviewId: string,
  browserExt?: BoolString,
  appName: string,
  appHost: string,
  uriScheme: string,
  extensionUrl: string,
  accessToken?: string,
  uiKind?: 'desktop' | 'web',
  machineId: string,
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
  ) {
    super();
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

    document.onDidDispose(() => {
      this.dispose();
    });

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
        const value = document.autoCommitEnabled = isAutoCommitEnabled();
        for (const bridge of this.#iterateWebviewBridges(document.uri)) {
          bridge.updateAutoCommit(value).catch(console.warn);
        }
      }

      if (e.affectsConfiguration(`${ConfigurationSection}.doubleClickBehavior`)) {
        const value = document.cellEditBehavior;
        for (const bridge of this.#iterateWebviewBridges(document.uri)) {
          bridge.updateCellEditBehavior(value).catch(console.warn);
        }
      }
    }));

    // Listen for when this document gains focus to trigger pending saves
    this._register(vsc.window.onDidChangeActiveTextEditor(editor => {
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
  #createPanelDisposeHandler = (webviewPanel: vsc.WebviewPanel) => () => {
    this.webviewBridges.delete(webviewPanel);
  };

  /**
   * Create handler for webview panel view state changes.
   */
  #createViewStateChangeHandler = (webviewPanel: vsc.WebviewPanel, document: DatabaseDocument) => (e: vsc.WebviewPanelOnDidChangeViewStateEvent) => {
    const bridge = this.webviewBridges.get(webviewPanel);
    if (bridge) {
      bridge.updateViewState({
        visible: e.webviewPanel.visible,
        active: e.webviewPanel.active,
      }).catch(() => { });
    }
    // If the webview panel is active and there is a pending save, save the document
    document.hasActiveViewer = e.webviewPanel.active;
    if (e.webviewPanel.active && document.hasPendingSave) {
      document.triggerSave().catch(() => { });
    }
  };

  /**
   * Create handler for extension changes (e.g., Copilot activation).
   */
  #createExtensionChangeHandler = (webviewPanel: vsc.WebviewPanel) => () => {
    const chat = vsc.extensions.getExtension(CopilotChatId);
    const bridge = this.webviewBridges.get(webviewPanel);
    bridge?.updateCopilotActive(!!chat?.isActive || IsCursorIDE).catch(() => { });
  };

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
      (msg) => webviewPanel.webview.postMessage(msg),
      ['updateColorScheme', 'updateAutoCommit', 'updateCellEditBehavior', 'updateViewState', 'updateCopilotActive', 'refreshContent']
    );
    this.webviewBridges.set(webviewPanel, webviewBridge);

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage((message) => {
      // Handle RPC responses (for calls we make to the webview)
      processProtocolMessage(message);

      // Handle RPC requests from webview (calls to hostBridge)
      // The webview uses format: { channel: 'rpc', content: { kind: 'invoke', messageId, targetMethod, payload } }
      if (message?.channel === 'rpc' && message?.content?.kind === 'invoke') {
        const { messageId, targetMethod, payload } = message.content;
        const hostBridge = document.hostBridge as any;
        const fn = hostBridge[targetMethod];
        if (typeof fn === 'function') {
          Promise.resolve(fn.apply(hostBridge, payload || []))
            .then(result => {
              webviewPanel.webview.postMessage({
                channel: 'rpc',
                content: {
                  kind: 'response',
                  messageId,
                  success: true,
                  data: result
                }
              });
            })
            .catch(err => {
              webviewPanel.webview.postMessage({
                channel: 'rpc',
                content: {
                  kind: 'response',
                  messageId,
                  success: false,
                  errorMessage: err instanceof Error ? err.message : String(err)
                }
              });
            });
        } else {
          // Method not found
          webviewPanel.webview.postMessage({
            channel: 'rpc',
            content: {
              kind: 'response',
              messageId,
              success: false,
              errorMessage: `Method '${targetMethod}' not found on hostBridge`
            }
          });
        }
      }

      // Also handle legacy format: { type: 'rpc-request', method, id, args }
      if (message?.type === 'rpc-request') {
        const hostBridge = document.hostBridge as any;
        const fn = hostBridge[message.method];
        if (typeof fn === 'function') {
          Promise.resolve(fn.apply(hostBridge, message.args))
            .then(result => {
              webviewPanel.webview.postMessage({
                type: 'rpc-response',
                id: message.id,
                result
              });
            })
            .catch(err => {
              webviewPanel.webview.postMessage({
                type: 'rpc-response',
                id: message.id,
                error: err instanceof Error ? err.message : String(err)
              });
            });
        }
      }
    });

    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = await this.#generateWebviewHtml(webviewPanel, document, webviewId);

    document.hasActiveViewer = webviewPanel.active;

    webviewPanel.onDidChangeViewState(this.#createViewStateChangeHandler(webviewPanel, document)),
      webviewPanel.onDidDispose(this.#createPanelDisposeHandler(webviewPanel));

    vsc.extensions.onDidChange(this.#createExtensionChangeHandler(webviewPanel));
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

    // Load viewer HTML from core/ui directory
    const htmlUri = vsc.Uri.joinPath(this.context.extensionUri, 'core', 'ui', 'viewer.html');
    const html = new TextDecoder().decode(await vsc.workspace.fs.readFile(htmlUri));

    // Load codicons CSS
    const codiconsUri = vsc.Uri.joinPath(this.context.extensionUri, 'node_modules', 'codicons', 'dist', 'codicon.css');

    // Build Content Security Policy
    const cspObj = {
      [cspUtil.defaultSrc]: [webview.cspSource],
      [cspUtil.scriptSrc]: [webview.cspSource, cspUtil.wasmUnsafeEval, "'unsafe-inline'"],
      [cspUtil.styleSrc]: [webview.cspSource, cspUtil.inlineStyle],
      [cspUtil.imgSrc]: [webview.cspSource, cspUtil.data, cspUtil.blob],
      [cspUtil.fontSrc]: [webview.cspSource],
      [cspUtil.frameSrc]: [cspUtil.none],
      [cspUtil.childSrc]: [cspUtil.blob],
    };

    // Only set csp for hosts that are known to correctly set `webview.cspSource`
    const cspStr = IsVSCode || IsVSCodium
      ? cspUtil.build(cspObj)
      : '';

    const { uriScheme, appHost, appName, uiKind } = vsc.env;
    const extensionUrl = uriScheme?.includes('vscode')
      ? `https://marketplace.visualstudio.com/items?itemName=${FullExtensionId}&ref=vscode`
      : `https://open-vsx.org/extension/${Ns}/${ExtensionId}&ref=vscode`;

    // Get configuration settings for the webview
    const config = vsc.workspace.getConfiguration(ConfigurationSection);
    const defaultPageSize = config.get<number>('defaultPageSize', 1000);
    const maxRows = config.get<number>('maxRows', 0);

    // Build environment data for webview
    const vscodeEnv = {
      webviewId,
      browserExt: toBoolString(!!import.meta.env.VSCODE_BROWSER_EXT),
      uriScheme, appHost, appName, extensionUrl,
      accessToken: this.accessToken,
      uiKind: uiKindToString(uiKind),
      machineId: vsc.env.machineId,
      firstInstall: doTry(() => new Date(this.context.globalState.get<number>(FistInstallMs) ?? Date.now()).toISOString()),
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
      .replace(/<!--HEAD-->/g, `
        <meta http-equiv="Content-Security-Policy" content="${cspStr}">
        <meta name="color-scheme" content="${themeToCss(vsc.window.activeColorTheme)}">
        <meta id="vscode-env" ${toDatasetAttrs(vscodeEnv)}>
        <link rel="stylesheet" href="${webview.asWebviewUri(codiconsUri)}" crossorigin onerror="console.log('Codicons CSS not found, using fallback')"/>
      `)
      .replace(/<!--BODY-->/g, ``);

    return preparedHtml;
  }

  /**
   * Enter license key command handler.
   */
  enterLicenseKey() {
    return enterLicenseKeyCommand(this.context, this.reporter);
  }
}

/**
 * Read-write database editor provider.
 *
 * Extends the read-only provider with edit, save, and revert capabilities.
 */
export class DatabaseEditorProvider extends DatabaseViewerProvider implements vsc.CustomEditorProvider<DatabaseDocument> {
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
    this._register(document.onDidChangeContent(async () => {
      const { filename } = document.fileParts;
      for (const panel of this.webviews.get(document.uri)) {
        const bridge = this.webviewBridges.get(panel);
        await bridge?.refreshContent(filename);
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
  { verified, accessToken, readOnly }: { verified: boolean, accessToken?: string, readOnly?: boolean }
) {
  const enableReadWrite = !import.meta.env.VSCODE_BROWSER_EXT && verified && SupportsWriteMode;
  const Provider = enableReadWrite ? DatabaseEditorProvider : DatabaseViewerProvider;
  return vsc.window.registerCustomEditorProvider(
    viewType,
    new Provider(viewType, context, reporter, outputChannel, verified, accessToken, readOnly),
    {
      webviewOptions: {
        enableFindWidget: false,
        retainContextWhenHidden: true, // TODO: serialize state!?
      },
      supportsMultipleEditorsPerDocument: true,
    }
  );
}
