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

/**
 * Why reading stopped. Delivered to `onEof` exactly once, whatever the cause,
 * so the entry has a single place to exit from.
 *
 * - `eof` — stdin closed. Clean shutdown, and also the primary orphan signal:
 *   an orphaned tjs process is NOT killed by the OS.
 * - `fatal` — the frame stream desynchronised (`NATIVE_FRAME_DESYNC`). The
 *   in-band error frame has been queued; `flush()` before exiting so the
 *   parent receives it. Exiting is REQUIRED, not optional: it closes the pipe
 *   so the parent's next write sees EPIPE/EOF instead of blocking forever
 *   against a process that is alive but no longer listening.
 * - `stream-error` — stdin itself failed. Treated as terminal.
 *
 * EMBEDDER OBLIGATION: map these to the process exit code — 0 for `eof` only,
 * NONZERO (1) for `fatal` and `stream-error`. The parent has to be able to tell
 * a desync death from a clean shutdown; both close the pipe identically, so the
 * exit code is the only signal that survives.
 */
export type StdioShutdownReason =
    | { kind: 'eof' }
    | { kind: 'fatal'; error: import('./frame-codec.js').NativeFrameError }
    | { kind: 'stream-error'; error: unknown };

export interface StdioTransportOptions {
    /** Defaults to `tjs.stdin`. */
    stdin?: StdinLike;
    /** Defaults to `tjs.stdout`. */
    stdout?: StdoutLike;
    /** Fired exactly once when reading stops. See `StdioShutdownReason`. */
    onEof?: (reason: StdioShutdownReason) => void;
    /** Pipe-level failures (write errors, stream errors). Defaults to console.error. */
    onTransportError?: (error: unknown) => void;
    /** Defaults to `MAX_FRAME_BYTES`. */
    maxFrameBytes?: number;
    /**
     * Declared lengths above this are a desync rather than a drain. Defaults to
     * 4x the EFFECTIVE cap — i.e. `MAX_DRAIN_BYTES` only when `maxFrameBytes`
     * is left at its default. Must be >= the effective cap.
     */
    maxDrainBytes?: number;
}

export interface StdioTransport {
    /** Assigned by the worker method layer, exactly as it would assign `self.onmessage`. */
    onmessage: ((event: StdioMessageEvent) => void) | null;
    /**
     * Frame and queue one message. The returned promise resolves once stdout
     * has accepted the frame; it always carries its own rejection handler, so
     * ignoring it is safe and pipe failures still reach `onTransportError`.
     *
     * THROWS SYNCHRONOUSLY on an oversize payload (`NATIVE_FRAME_TOO_LARGE`).
     * That is deliberate — a dropped reply strands the parent's pending request
     * forever, so the failure has to be visible at the call site.
     *
     * EMBEDDER OBLIGATION: every send site must either wrap this call or be
     * handed a surface that self-handles the cap. The worker method layer in
     * `website/src/sqlite-viewer/worker.js` does NOT qualify — only its success
     * send sits inside a try/catch; the unknown-method reply (which interpolates
     * a webview-supplied `targetMethod` and is therefore attacker-influenced)
     * and the catch-branch reply both call `postMessage` unguarded. An oversize
     * frame at either site becomes a stranded RPC plus an unhandled rejection.
     * Because that file is under a byte-identical build gate, the sidecar entry
     * must hand the worker layer a WRAPPED transport that catches the cap error
     * and synthesises a bounded error response for the same `messageId`, rather
     * than this object directly.
     *
     * @throws {import('./frame-codec.js').NativeFrameError}
     */
    postMessage(message: unknown): Promise<void>;
    /** Begin reading stdin. Resolves at EOF. */
    start(): Promise<void>;
    /** Resolves when every queued write has been attempted. */
    flush(): Promise<void>;
}

export function createStdioTransport(options?: StdioTransportOptions): StdioTransport;
