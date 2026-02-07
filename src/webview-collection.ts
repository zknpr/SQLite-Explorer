import type { WebviewPanel, Uri } from 'vscode';

/**
 * Tracks webview panels associated with document URIs.
 *
 * Allows lookup of panels by document URI or unique webview ID.
 * Automatically removes entries when panels are disposed.
 */
export class WebviewCollection {
  /** Internal storage for URI to panel mappings */
  private readonly entries = new Set<{
    readonly uriString: string;
    readonly panel: WebviewPanel;
  }>();

  /** Map from webview ID to panel for direct lookup */
  private readonly idLookup = new Map<string, WebviewPanel>();

  /**
   * Iterate all panels associated with a document URI.
   *
   * @param uri - Document URI to look up
   * @yields WebviewPanel instances for this URI
   */
  public *get(uri: Uri): IterableIterator<WebviewPanel> {
    const targetKey = uri.toString();
    for (const entry of this.entries) {
      if (entry.uriString === targetKey) {
        yield entry.panel;
      }
    }
  }

  /**
   * Find a panel by its unique webview ID.
   *
   * @param webviewId - Unique identifier for the webview
   * @returns Panel if found, undefined otherwise
   */
  public getByWebviewId(webviewId: string): WebviewPanel | undefined {
    return this.idLookup.get(webviewId);
  }

  /**
   * Check if any panels exist for a document URI.
   *
   * @param uri - Document URI to check
   * @returns True if at least one panel exists
   */
  public has(uri: Uri): boolean {
    return !this.get(uri).next().done;
  }

  /**
   * Register a new webview panel.
   *
   * @param uri - Associated document URI
   * @param panel - Webview panel instance
   * @param webviewId - Unique identifier for this webview
   */
  public add(uri: Uri, panel: WebviewPanel, webviewId: string): void {
    const entry = { uriString: uri.toString(), panel };
    this.entries.add(entry);
    this.idLookup.set(webviewId, panel);

    // Auto-cleanup on panel disposal
    panel.onDidDispose(() => {
      this.entries.delete(entry);
      this.idLookup.delete(webviewId);
    });
  }
}
