/**
 * Worker-shaped message surface over the sidecar's stdin/stdout pipes.
 *
 * The sidecar runs the EXISTING worker method layer
 * (`website/src/sqlite-viewer/worker.js`) unchanged, and that layer only knows
 * `self.onmessage = handler` and `self.postMessage(message)`. This adapter is
 * what makes those two calls mean "read a frame from stdin" and "write a frame
 * to stdout" instead of "talk to the browser's structured-clone channel".
 *
 * Stdio mechanics are fixed by the probe against tjs 26.6.0
 * (`.superpowers/sdd/2026-08-17-native-engine/task-1-report.md` §4):
 *
 *   - The WHATWG surface is the ONLY one. `tjs.stdin.read(buffer)` and
 *     `tjs.stdout.write(bytes)` are `undefined` on this generation; the reader
 *     and writer are acquired once via `getReader()` / `getWriter()` and held
 *     for the process lifetime.
 *   - `read()` returns whatever the pipe delivered — partial headers, several
 *     whole frames, or a frame plus the head of the next. Reassembly is the
 *     caller's job and lives in `frame-codec.js`.
 *   - Zero-length chunks occur and are NOT EOF.
 *   - EOF (`done === true`) is sticky, and it fires within a tick of the
 *     parent dying. It is therefore both the clean-shutdown path and the
 *     PRIMARY orphan signal — an orphaned tjs process is not killed by the OS
 *     (probe §5) — so `onEof` is the hook the entry exits from.
 *
 * The streams are injectable so the whole adapter is testable in node without
 * a tjs process; the real binary drives it over real pipes in
 * `scripts/native-lane.mjs`.
 */

import {
    createFrameReader,
    encodeFrame,
    frameErrorResponse
} from './frame-codec.js';

/**
 * @param {object} [options]
 * @param {{getReader: () => {read: () => Promise<{value?: Uint8Array, done: boolean}>}}} [options.stdin]
 * @param {{getWriter: () => {write: (bytes: Uint8Array) => Promise<void>}}} [options.stdout]
 * @param {(reason: {kind: 'eof'|'fatal'|'stream-error', error?: unknown}) => void} [options.onEof]
 *   fired exactly once when reading stops, whatever stopped it
 * @param {(error: unknown) => void} [options.onTransportError] pipe-level failures
 * @param {number} [options.maxFrameBytes]
 * @param {number} [options.maxDrainBytes]
 */
export function createStdioTransport(options = {}) {
    const stdin = options.stdin ?? globalThis.tjs?.stdin;
    const stdout = options.stdout ?? globalThis.tjs?.stdout;
    if (!stdin || typeof stdin.getReader !== 'function') {
        throw new TypeError('stdio transport requires a WHATWG readable stdin (getReader)');
    }
    if (!stdout || typeof stdout.getWriter !== 'function') {
        throw new TypeError('stdio transport requires a WHATWG writable stdout (getWriter)');
    }
    const readerOptions = {};
    if (options.maxFrameBytes !== undefined) readerOptions.maxFrameBytes = options.maxFrameBytes;
    if (options.maxDrainBytes !== undefined) readerOptions.maxDrainBytes = options.maxDrainBytes;
    // Encoding only ever needs the size cap, never the drain limit.
    const frameOptions = options.maxFrameBytes === undefined
        ? undefined
        : { maxFrameBytes: options.maxFrameBytes };

    // Acquired once: a second getReader()/getWriter() on the same stream throws.
    const reader = stdin.getReader();
    const writer = stdout.getWriter();

    let onmessage = null;
    let started = false;
    let eofFired = false;
    /** Set when the frame reader desynchronises; stops the read loop. */
    let fatalError = null;
    /** Serialises writes and carries backpressure; never rejects. */
    let writeChain = Promise.resolve();

    /**
     * Never lets a user callback's own failure escape. These run from the read
     * loop and from promise handlers, where a throw would skip the shutdown
     * path and strand the sidecar alive with nobody listening.
     */
    const guarded = (label, callback, argument) => {
        try {
            callback(argument);
        } catch (failure) {
            console.error(`[stdio-transport] ${label} callback threw`, failure);
        }
    };

    const reportTransportError = (error) => {
        if (options.onTransportError) guarded('onTransportError', options.onTransportError, error);
        else console.error('[stdio-transport]', error);
    };

    /**
     * @param {Uint8Array} bytes
     * @returns {Promise<void>} already has a rejection handler attached, so an
     *   ignoring caller cannot produce an unhandled rejection.
     */
    const writeBytes = (bytes) => {
        const done = writeChain.then(() => writer.write(bytes));
        // Keep the chain alive after a failed write so one broken frame does
        // not wedge every later response behind a rejected promise.
        writeChain = done.then(() => undefined, () => undefined);
        done.catch(reportTransportError);
        return done;
    };

    const frameReader = createFrameReader(
        (message) => {
            // The entry installs `onmessage` before `start()`, so a missing
            // handler means the caller wired things wrong — say so rather than
            // dropping requests into a hole the parent will wait on forever.
            if (!onmessage) {
                reportTransportError(new Error('stdio transport received a frame before onmessage was installed'));
                return;
            }
            // Worker-shaped: the method layer reads `event.data`. Guarded
            // because this runs inside the read loop — a handler bug must not
            // become a dead sidecar.
            guarded('onmessage', onmessage, { data: message });
        },
        (error) => {
            // In-band answer. Encoding it must never throw back into the read
            // loop: this callback runs inside frameReader.push(), so a throw
            // here would unwind the loop and skip the shutdown path. Error
            // messages are bounded by the codec, so this is a floor, not the
            // usual path.
            try {
                writeBytes(encodeFrame(frameErrorResponse(error), frameOptions));
            } catch (encodeFailure) {
                reportTransportError(encodeFailure);
            }
            // A desync leaves the stream unframed; the reader has already
            // stopped for good. Record it so the read loop stops too and the
            // embedder is told to exit, which closes the pipe.
            if (error?.fatal === true) fatalError = error;
        },
        readerOptions
    );

    const shutdown = (reason) => {
        if (eofFired) return;
        eofFired = true;
        if (options.onEof) guarded('onEof', options.onEof, reason);
    };

    const readLoop = async () => {
        let reason = { kind: 'eof' };
        try {
            for (;;) {
                const result = await reader.read();
                if (result.done) break;
                const chunk = result.value;
                // Zero-length chunks are legal and are not EOF.
                if (chunk && chunk.length > 0) frameReader.push(chunk);
                if (fatalError) { reason = { kind: 'fatal', error: fatalError }; break; }
            }
        } catch (error) {
            // A stream-level failure is terminal: fall through to the shutdown
            // path so the entry still gets its single signal.
            reportTransportError(error);
            reason = { kind: 'stream-error', error };
        } finally {
            // In a `finally` so a throwing callback anywhere above cannot skip
            // the shutdown signal and strand the sidecar alive but deaf.
            frameReader.end();
            shutdown(reason);
        }
    };

    return {
        get onmessage() { return onmessage; },
        set onmessage(handler) { onmessage = handler; },

        /**
         * Frame and queue one message. Throws SYNCHRONOUSLY when the message
         * exceeds the cap, which is what lets the worker method layer's own
         * try/catch turn it into an error response for that request — the
         * alternative, silently dropping it, would hang the caller forever.
         *
         * @param {unknown} message
         * @returns {Promise<void>} resolves when stdout accepted the frame
         */
        postMessage(message) {
            return writeBytes(encodeFrame(message, frameOptions));
        },

        /** Begin reading stdin. Resolves at EOF. */
        start() {
            if (started) throw new Error('stdio transport already started');
            started = true;
            return readLoop();
        },

        /** Flush whatever is queued. Used by the shutdown path. */
        flush() {
            return writeChain;
        }
    };
}
