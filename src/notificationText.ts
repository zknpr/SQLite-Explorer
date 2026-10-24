/**
 * VS Code still parses `[label](command:id?args)`, `https:` and `file:` links
 * in the text extensions pass to notifications and progress titles, and a click
 * runs the command with the JSON arguments from the link (microsoft/vscode
 * notificationLegacy.ts, notificationsViewer.ts and openerService.ts). SQLite
 * error messages, table, column and index names and file names can all come
 * from a crafted database, so every such text goes through this function before
 * it is shown, including modal messages, which are cheap to cover.
 *
 * The link syntax needs `]` immediately followed by `(`. A zero-width space
 * after every `]` leaves the text reading the same and leaves VS Code nothing
 * to parse. It goes after every `]`, not only before `(`, because VS Code
 * removes `$(icon)` syntax from a progress title before parsing it, so
 * `]$(x)(` would become `](`; U+200B is not whitespace to that removal. A `]`
 * already followed by one is left alone, so disarming twice changes nothing:
 * errors are disarmed in place and can pass through a wrapper again.
 */
export function plainNotificationText(text: string): string {
  return text.replace(/\](?!\u200B)/g, ']\u200B');
}

/**
 * VS Code shows the errors that providers and commands throw back to it in its
 * own notifications, for example "Failed to save '…': <message>". VS Code 1.141
 * stopped parsing links in its own messages, but the 1.110 to 1.140 releases
 * this extension supports parse them like extension messages. The message is
 * disarmed in place so the error keeps its class and code
 * (vscode.CancellationError, vscode.FileSystemError).
 *
 * A DOMException, such as an aborted save's AbortError, defines message as a
 * getter without a setter: assigning it throws in strict mode and would replace
 * the error. An own property shadows the getter instead; an own data property,
 * which a sealed error keeps, only gets a new value. An error whose message
 * cannot be changed, such as a frozen one, is replaced by a plain Error with it
 * as cause. A message that is not text is left to VS Code.
 */
export function plainNotificationError(error: unknown): unknown {
  if (error instanceof Error) {
    if (typeof error.message !== 'string') return error;
    const message = plainNotificationText(error.message);
    if (message === error.message) return error;
    const own = Object.getOwnPropertyDescriptor(error, 'message');
    try {
      Object.defineProperty(error, 'message', own && 'value' in own
        ? { value: message }
        : { value: message, writable: true, configurable: true });
    } catch {
      return new Error(message, { cause: error });
    }
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
