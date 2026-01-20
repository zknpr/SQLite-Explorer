/**
 * Webview Stream Adapter
 *
 * Adapts VS Code webview messaging to a stream-like interface
 * for bidirectional communication.
 */

import * as vsc from 'vscode';

/**
 * Message envelope for webview communication
 */
interface MessageEnvelope {
  channel: string;
  content: any;
}

/**
 * Stream adapter for webview panel communication.
 * Provides send/receive interface for the messaging layer.
 */
export class WebviewChannel {
  private panel: vsc.WebviewPanel;
  private listeners: Map<string, ((data: any) => void)[]> = new Map();
  private disposables: vsc.Disposable[] = [];

  constructor(panel: vsc.WebviewPanel) {
    this.panel = panel;

    // Listen for incoming messages
    this.disposables.push(
      panel.webview.onDidReceiveMessage((envelope: MessageEnvelope) => {
        if (envelope && envelope.channel) {
          const handlers = this.listeners.get(envelope.channel);
          if (handlers) {
            for (const handler of handlers) {
              try {
                handler(envelope.content);
              } catch (err) {
                console.error('WebviewChannel handler error:', err);
              }
            }
          }
        }
      })
    );
  }

  /**
   * Send a message to the webview.
   */
  send(channel: string, content: any): Thenable<boolean> {
    return this.panel.webview.postMessage({
      channel,
      content
    });
  }

  /**
   * Register a handler for incoming messages on a channel.
   */
  onMessage(channel: string, handler: (data: any) => void): void {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, []);
    }
    this.listeners.get(channel)!.push(handler);
  }

  /**
   * Remove a handler from a channel.
   */
  offMessage(channel: string, handler: (data: any) => void): void {
    const handlers = this.listeners.get(channel);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) {
        handlers.splice(idx, 1);
      }
    }
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.listeners.clear();
  }
}

/**
 * Create a messaging interface for extension-webview communication.
 */
export function createWebviewMessenger(panel: vsc.WebviewPanel) {
  const channel = new WebviewChannel(panel);

  return {
    /**
     * Send RPC message to webview.
     */
    postMessage(data: any): void {
      channel.send('rpc', data);
    },

    /**
     * Register handler for RPC messages from webview.
     */
    onMessage(handler: (data: any) => void): void {
      channel.onMessage('rpc', handler);
    },

    /**
     * Clean up.
     */
    dispose(): void {
      channel.dispose();
    }
  };
}
