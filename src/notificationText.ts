/**
 * VS Code still parses `[label](command:id?args)`, `https:` and `file:` links
 * in the text extensions pass to notifications, modal messages and progress
 * titles, and a click runs the command with the JSON arguments from the link
 * (microsoft/vscode notificationLegacy.ts, notificationsViewer.ts and
 * openerService.ts). SQLite error messages, table, column and index names and
 * file names can all come from a crafted database, so every such text goes
 * through this function before it is shown.
 *
 * The link syntax needs `]` immediately followed by `(`. A zero-width space
 * between them leaves the text reading the same and leaves VS Code nothing to
 * parse.
 */
export function plainNotificationText(text: string): string {
  return text.replaceAll('](', ']​(');
}

/**
 * VS Code shows the errors that providers and commands throw back to it in its
 * own notifications, for example "Failed to save '…': <message>". VS Code 1.141
 * stopped parsing links in its own messages, but the 1.110 to 1.140 releases
 * this extension supports parse them like extension messages. The message is
 * disarmed in place so the error keeps its class and code
 * (vscode.CancellationError, vscode.FileSystemError).
 */
export function plainNotificationError(error: unknown): unknown {
  if (error instanceof Error) {
    error.message = plainNotificationText(error.message);
    return error;
  }
  return typeof error === 'string' ? plainNotificationText(error) : error;
}

/** A command handler whose errors reach VS Code through plainNotificationError. */
export function plainErrors<A extends unknown[], R>(action: (...args: A) => R | PromiseLike<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await action(...args);
    } catch (error) {
      throw plainNotificationError(error);
    }
  };
}

/**
 * The provider object to register with VS Code: the listed methods' errors pass
 * through plainNotificationError. Every function runs on the provider itself,
 * so its private fields keep working; a listed method the provider lacks stays
 * absent.
 */
export function withPlainErrors<T extends object>(provider: T, methods: readonly string[]): T {
  const wrapped = new Map<PropertyKey, unknown>();
  for (const name of methods) {
    const method: unknown = Reflect.get(provider, name);
    if (typeof method === 'function') {
      wrapped.set(name, plainErrors((...args: unknown[]) => method.apply(provider, args)));
    }
  }
  return new Proxy(provider, {
    get: (target, property) => {
      if (wrapped.has(property)) return wrapped.get(property);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}
