import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import {
    MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES,
    MAX_WEBVIEW_BINARY_VALUE_BYTES,
    WebviewPayloadLimitError
} from '../../src/core/webview-transport';
import { isTrustedViewerMessage } from '../../website/app/demo/messageGuard';
import {
    demoRpcErrorFields,
    guardDemoIframeRequest,
    guardDemoIframeResponse,
    guardDemoDatabaseExportResponse,
    guardDemoWorkerRequest,
    guardDemoWorkerResponse,
    serializeDemoIframeResponse
} from '../../website/app/demo/transport';
import {
    createDemoExtensionSettings,
    DEMO_EXTENSION_SETTINGS,
    updateDemoExtensionSetting
} from '../../website/app/demo/extensionSettings';
import { deserializeValue } from '../../core/ui/modules/transport.js';

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
    it('rejects malformed RPC identities and payload shapes at clone boundaries', () => {
        assert.throws(() => guardDemoIframeRequest({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: { reflected: true },
                targetMethod: 'fetchSchema',
                payload: []
            }
        }), /messageId.*bounded string/i);
        assert.throws(() => guardDemoWorkerRequest({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: 'request-1',
                targetMethod: { constructor: true },
                payload: []
            }
        }), /method.*bounded string/i);
        assert.throws(() => guardDemoIframeRequest({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: 'request-2',
                targetMethod: 'fetchSchema',
                payload: 'not-an-array'
            }
        }), /payload.*array/i);
        assert.throws(() => guardDemoWorkerResponse({
            channel: 'rpc',
            content: {
                kind: 'response',
                messageId: 'response-1',
                success: 'yes',
                data: { accepted: false }
            }
        }), /success.*boolean/i);
    });

    it('serializes hostile rejection values without throwing from the response path', () => {
        const hostile = {
            [Symbol.toPrimitive]() {
                throw new Error('coercion trap');
            }
        };

        assert.deepStrictEqual(demoRpcErrorFields(hostile), {
            errorMessage: 'Unknown error'
        });

        const bounded = demoRpcErrorFields(new Error('x'.repeat(20_000)));
        assert.ok(bounded.errorMessage.length < 8400);
        assert.match(bounded.errorMessage, /truncated from 20000 characters/i);
    });

    it('reports settings in the shape consumed by the shared viewer', () => {
        assert.deepStrictEqual(DEMO_EXTENSION_SETTINGS, {
            autoCommit: false,
            autoCommitSupported: false,
            cellEditBehavior: 'inline',
            cellEditBehaviorOptions: ['inline', 'modal'],
            fileOperations: 'web'
        });
    });

    it('updates supported demo settings without forwarding them to the worker', () => {
        const settings = createDemoExtensionSettings();
        const updated = updateDemoExtensionSetting(
            settings,
            'doubleClickBehavior',
            'modal'
        );

        assert.strictEqual(updated.cellEditBehavior, 'modal');
        assert.strictEqual(settings.cellEditBehavior, 'inline');
        assert.throws(
            () => updateDemoExtensionSetting(updated, 'doubleClickBehavior', 'vscode'),
            /not available in the web demo/
        );
        assert.throws(
            () => updateDemoExtensionSetting(updated, 'autoCommit', true),
            /Auto-commit is not available in the web demo/
        );
        assert.throws(
            () => updateDemoExtensionSetting(updated, '__proto__', true),
            /Unsupported demo extension setting/
        );
    });

    it('preserves reserved-prefix TEXT and infinities across the iframe response', () => {
        const original = {
            text: '~sqlite-explorer-non-finite:Infinity',
            number: Infinity
        };
        const encoded = serializeDemoIframeResponse(original);
        const restored = deserializeValue(encoded, {
            surface: 'demo reserved-prefix response test'
        });

        assert.deepStrictEqual(restored, original);
    });
    it('guards both sides of the iframe boundary', () => {
        const oversized = new Uint8Array(MAX_WEBVIEW_BINARY_VALUE_BYTES + 1);
        rejectsAt('web demo iframe -> parent request', () => guardDemoIframeRequest(oversized));
        rejectsAt('web demo parent -> iframe response', () => guardDemoIframeResponse(oversized));
    });

    it('guards both sides of the worker boundary', () => {
        const oversized = new Uint8Array(MAX_WEBVIEW_BINARY_VALUE_BYTES + 1);
        rejectsAt('web demo parent -> worker request', () => guardDemoWorkerRequest(oversized));
        rejectsAt('web demo worker -> parent response', () => guardDemoWorkerResponse(oversized));

        assert.doesNotThrow(() => guardDemoDatabaseExportResponse({
            channel: 'rpc',
            content: {
                kind: 'response',
                messageId: 'export-1',
                success: true,
                data: oversized
            }
        }));
    });

    it('widens only the database image and keeps an exact export ceiling', () => {
        const response = (data: unknown, sidecar?: unknown) => ({
            channel: 'rpc',
            content: {
                kind: 'response',
                messageId: 'export-1',
                success: true,
                data,
                ...(sidecar === undefined ? {} : { sidecar })
            }
        });

        assert.doesNotThrow(() => guardDemoDatabaseExportResponse(
            response(new Uint8Array(32)),
            32
        ));
        assert.throws(
            () => guardDemoDatabaseExportResponse(response(new Uint8Array(33)), 32),
            (error: unknown) => {
                assert.ok(error instanceof WebviewPayloadLimitError);
                assert.strictEqual(error.kind, 'binary-value');
                assert.strictEqual(error.limitBytes, 32);
                return true;
            }
        );
        assert.throws(
            () => guardDemoDatabaseExportResponse(response('not bytes'), 32),
            /Uint8Array/
        );
        assert.throws(
            () => guardDemoDatabaseExportResponse(
                response(new Uint8Array(1), new Uint8Array(MAX_WEBVIEW_BINARY_VALUE_BYTES + 1)),
                32
            ),
            WebviewPayloadLimitError
        );
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

describe('DemoClient viewer message trust gate', () => {
    const viewerOrigin = 'https://sqlite-explorer.zknpr.xyz';
    const viewerWindow = { name: 'viewer' };

    it('accepts the viewer window posting from the demo origin', () => {
        assert.strictEqual(
            isTrustedViewerMessage(
                { source: viewerWindow, origin: viewerOrigin },
                viewerWindow,
                viewerOrigin
            ),
            true
        );
    });

    it('rejects the viewer WindowProxy once an ancestor navigated it cross-origin', () => {
        // Ancestor navigation preserves the WindowProxy identity, so only the
        // browser-verified origin distinguishes the attacker's document.
        assert.strictEqual(
            isTrustedViewerMessage(
                { source: viewerWindow, origin: 'https://attacker.vercel.app' },
                viewerWindow,
                viewerOrigin
            ),
            false
        );
    });

    it('rejects opaque-origin senders', () => {
        assert.strictEqual(
            isTrustedViewerMessage(
                { source: viewerWindow, origin: 'null' },
                viewerWindow,
                viewerOrigin
            ),
            false
        );
    });

    it('rejects a foreign source even on a matching origin', () => {
        assert.strictEqual(
            isTrustedViewerMessage(
                { source: { name: 'other' }, origin: viewerOrigin },
                viewerWindow,
                viewerOrigin
            ),
            false
        );
    });

    it('rejects nullish sources while no viewer iframe is mounted', () => {
        assert.strictEqual(
            isTrustedViewerMessage(
                { source: null, origin: viewerOrigin },
                null,
                viewerOrigin
            ),
            false
        );
        assert.strictEqual(
            isTrustedViewerMessage(
                { source: undefined, origin: viewerOrigin },
                undefined,
                viewerOrigin
            ),
            false
        );
    });
});

describe('demo frame-ancestors policy', () => {
    const requireConfig = createRequire(import.meta.url);

    type HeaderRule = { headers?: { key: string; value: string }[] };

    function contentSecurityPolicyOf(rules: HeaderRule[]): string {
        const values = rules
            .flatMap(rule => rule.headers ?? [])
            .filter(header => header.key === 'Content-Security-Policy')
            .map(header => header.value);
        assert.strictEqual(values.length, 1);
        return values[0];
    }

    // The only first-party framing is the demo page embedding its same-origin
    // viewer, so 'self' covers production, previews and localhost alike;
    // https://*.vercel.app would trust an origin space anyone can register.
    const expectedPolicy = "frame-ancestors 'self'";

    it('next.config.js does not trust registrable origin spaces', async () => {
        const nextConfig = requireConfig('../../website/next.config.js');
        assert.strictEqual(
            contentSecurityPolicyOf(await nextConfig.headers()),
            expectedPolicy
        );
    });

    it('vercel.json stays in lockstep with next.config.js', () => {
        const vercelConfig = JSON.parse(
            readFileSync(new URL('../../website/vercel.json', import.meta.url), 'utf8')
        );
        assert.strictEqual(
            contentSecurityPolicyOf(vercelConfig.headers),
            expectedPolicy
        );
    });
});
