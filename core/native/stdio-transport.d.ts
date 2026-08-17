/**
 * Types for stdio-transport.js — the worker-shaped message surface the sidecar
 * installs so the unchanged worker method layer talks over stdin/stdout frames.
 */

/** The slice of a WHATWG readable stream the transport uses (tjs 26.6.0 shape). */
export interface StdinLike {
    getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }> };
}

/** The slice of a WHATWG writable stream the transport uses. */
export interface StdoutLike {
    getWriter(): { write(bytes: Uint8Array): Promise<void> };
}

/** What the method layer sees: a structured-clone-style message event. */
export interface StdioMessageEvent {
    data: unknown;
}

export interface StdioTransportOptions {
    /** Defaults to `tjs.stdin`. */
    stdin?: StdinLike;
    /** Defaults to `tjs.stdout`. */
    stdout?: StdoutLike;
    /**
     * Fired exactly once when stdin reaches EOF. EOF is both the clean
     * shutdown signal and the primary orphan signal — an orphaned tjs process
     * is not killed by the OS.
     */
    onEof?: () => void;
    /** Pipe-level failures (write errors, stream errors). Defaults to console.error. */
    onTransportError?: (error: unknown) => void;
    /** Defaults to `MAX_FRAME_BYTES`. */
    maxFrameBytes?: number;
}

export interface StdioTransport {
    /** Assigned by the worker method layer, exactly as it would assign `self.onmessage`. */
    onmessage: ((event: StdioMessageEvent) => void) | null;
    /**
     * Frame and queue one message.
     * @throws {import('./frame-codec.js').NativeFrameError} synchronously when
     *   the encoded payload exceeds the cap, so the caller can answer the
     *   request with an error instead of leaving it pending forever.
     */
    postMessage(message: unknown): Promise<void>;
    /** Begin reading stdin. Resolves at EOF. */
    start(): Promise<void>;
    /** Resolves when every queued write has been attempted. */
    flush(): Promise<void>;
}

export function createStdioTransport(options?: StdioTransportOptions): StdioTransport;
