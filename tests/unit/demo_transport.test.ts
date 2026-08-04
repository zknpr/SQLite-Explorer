import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
    MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES,
    MAX_WEBVIEW_BINARY_VALUE_BYTES,
    WebviewPayloadLimitError
} from '../../src/core/webview-transport';
import {
    guardDemoIframeRequest,
    guardDemoIframeResponse,
    guardDemoWorkerRequest,
    guardDemoWorkerResponse
} from '../../website/app/demo/transport';

function rejectsAt(surface: string, operation: () => void) {
    assert.throws(operation, (error: unknown) => {
        assert.ok(error instanceof WebviewPayloadLimitError);
        assert.strictEqual(error.surface, surface);
        assert.strictEqual(error.kind, 'binary-value');
        assert.strictEqual(error.limitBytes, MAX_WEBVIEW_BINARY_VALUE_BYTES);
        return true;
    });
}

function rejectsAggregateAt(surface: string, operation: () => void) {
    assert.throws(operation, (error: unknown) => {
        assert.ok(error instanceof WebviewPayloadLimitError);
        assert.strictEqual(error.surface, surface);
        assert.strictEqual(error.kind, 'aggregate-payload');
        assert.strictEqual(error.limitBytes, MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES);
        return true;
    });
}

describe('DemoClient transport guards', () => {
    it('guards both sides of the iframe boundary', () => {
        const oversized = new Uint8Array(MAX_WEBVIEW_BINARY_VALUE_BYTES + 1);
        rejectsAt('web demo iframe -> parent request', () => guardDemoIframeRequest(oversized));
        rejectsAt('web demo parent -> iframe response', () => guardDemoIframeResponse(oversized));
    });

    it('guards both sides of the worker boundary', () => {
        const oversized = new Uint8Array(MAX_WEBVIEW_BINARY_VALUE_BYTES + 1);
        rejectsAt('web demo parent -> worker request', () => guardDemoWorkerRequest(oversized));
        rejectsAt('web demo worker -> parent response', () => guardDemoWorkerResponse(oversized));
    });

    it('applies the aggregate budget on all four demo clone boundaries', () => {
        const amplified = [
            new Uint8Array(13 * 1024 * 1024),
            new Uint8Array(13 * 1024 * 1024)
        ];
        rejectsAggregateAt(
            'web demo iframe -> parent request',
            () => guardDemoIframeRequest(amplified)
        );
        rejectsAggregateAt(
            'web demo parent -> iframe response',
            () => guardDemoIframeResponse(amplified)
        );
        rejectsAggregateAt(
            'web demo parent -> worker request',
            () => guardDemoWorkerRequest(amplified)
        );
        rejectsAggregateAt(
            'web demo worker -> parent response',
            () => guardDemoWorkerResponse(amplified)
        );
    });
});
