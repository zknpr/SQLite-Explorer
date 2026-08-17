/**
 * tjs-side half of the frame lane. Runs INSIDE the real fork binary.
 *
 *   tjs run <bundled harness>
 *
 * Installs the REAL `core/native/stdio-transport.js` on real stdin/stdout and
 * echoes every decoded envelope straight back through it, so the lane exercises
 * the production codec over production pipes: partial reads, coalescing,
 * backpressure, the oversize drain, and stdin EOF.
 *
 * It is bundled with esbuild before it runs, because the codec imports
 * `src/core/json-safe-numbers.ts` (single source of truth for the sentinel
 * namespace) and tjs cannot resolve TypeScript. That is also exactly how the
 * sidecar itself ships, so the lane tests the shipping shape.
 *
 * The echo is wrapped the same way the worker method layer wraps its handlers:
 * a frame that cannot be written becomes an error response for that request,
 * never a dropped reply.
 */

import { createStdioTransport } from '../../core/native/stdio-transport.js';
import { frameErrorResponse } from '../../core/native/frame-codec.js';

const transport = createStdioTransport({
    onTransportError: (error) => {
        console.error(`[frame-harness] transport error: ${error?.message ?? error}`);
    }
});

const messageIdOf = (message) => {
    const id = message?.content?.messageId;
    return typeof id === 'string' || typeof id === 'number' ? id : null;
};

transport.onmessage = (event) => {
    try {
        transport.postMessage(event.data);
    } catch (error) {
        transport.postMessage(frameErrorResponse(error, messageIdOf(event.data)));
    }
};

// EOF resolves start(); it is both the clean shutdown and the orphan signal.
await transport.start();
await transport.flush();
tjs.exit(0);
