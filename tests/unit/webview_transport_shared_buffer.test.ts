import assert from 'node:assert';
import path from 'node:path';
import { describe, it } from 'node:test';
import esbuild from 'esbuild';

import { WEBVIEW_BINARY_MARKER_OVERHEAD_BYTES } from '../../src/core/cell-containment';
import {
    WebviewPayloadLimitError,
    assertWebviewTransportPayload
} from '../../src/core/webview-transport';

function pagePayload(rowCount: number) {
    const rows = [];
    for (let row = 0; row < rowCount; row++) {
        rows.push([row + 1, `text ${row}`, row / 3, null, 'x'.repeat(row % 7)]);
    }
    return { rows, oversizedCells: {}, exactIntegerTexts: {} };
}

/** Count reads of the SharedArrayBuffer global while `run` executes. */
function countSharedArrayBufferReads(run: () => void): number {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer');
    let reads = 0;
    Object.defineProperty(globalThis, 'SharedArrayBuffer', {
        configurable: true,
        get() {
            reads++;
            return descriptor?.value;
        }
    });
    try {
        run();
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'SharedArrayBuffer', descriptor);
        else delete (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer;
    }
    return reads;
}

describe('webview transport guard and the SharedArrayBuffer global', () => {
    it('does not look up the global once per visited value', () => {
        // Browsers without cross-origin isolation do not define the global, and
        // each miss there goes through the window's named-property lookup.
        const small = countSharedArrayBufferReads(() => {
            assertWebviewTransportPayload(pagePayload(2), { surface: 'test' });
        });
        const large = countSharedArrayBufferReads(() => {
            assertWebviewTransportPayload(pagePayload(400), { surface: 'test' });
        });
        assert.strictEqual(large, small);
    });

    it('still measures a SharedArrayBuffer as a binary value', () => {
        assert.strictEqual(
            assertWebviewTransportPayload(new SharedArrayBuffer(10), { surface: 'test' }),
            10 + WEBVIEW_BINARY_MARKER_OVERHEAD_BYTES
        );
        assert.throws(
            () => assertWebviewTransportPayload(
                { data: new SharedArrayBuffer(9) },
                { surface: 'test', maxBinaryBytes: 8 }
            ),
            (error: unknown) => error instanceof WebviewPayloadLimitError
                && error.kind === 'binary-value'
                && error.actualBytes === 9
        );
    });

    it('measures payloads the same when the global is absent at load time', async () => {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer');
        const payload = { ...pagePayload(20), buffer: new ArrayBuffer(5), view: new Uint8Array(4) };
        const expected = assertWebviewTransportPayload(payload, { surface: 'test' });
        // Bundle first: the TypeScript loader itself needs the global.
        const rendered = await esbuild.build({
            entryPoints: [path.resolve(process.cwd(), 'src/core/webview-transport.ts')],
            bundle: true,
            platform: 'neutral',
            format: 'esm',
            write: false
        });
        const source = Buffer.from(rendered.outputFiles[0].text).toString('base64');
        delete (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer;
        try {
            const isolated = await import(`data:text/javascript;base64,${source}`);
            assert.strictEqual(
                isolated.assertWebviewTransportPayload(payload, { surface: 'test' }),
                expected
            );
        } finally {
            if (descriptor) Object.defineProperty(globalThis, 'SharedArrayBuffer', descriptor);
        }
    });
});
