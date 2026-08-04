import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { serializeValue, deserializeValue, deserializeArgs, uint8ArrayToBase64, base64ToUint8Array } from '../../src/core/serialization';
import {
    WEBVIEW_PAYLOAD_LIMIT_ERROR_CODE,
    WebviewPayloadLimitError,
    fromWebviewPayloadLimitErrorData,
    toWebviewPayloadLimitErrorData
} from '../../src/core/webview-transport';

describe('RPC Serialization', () => {

    describe('deserializeArgs', () => {
        it('should correctly deserialize an array of arguments', () => {
            const args = [
                1,
                { __type: 'Uint8Array', base64: uint8ArrayToBase64(new Uint8Array([1, 2])) },
                "test"
            ];
            const result = deserializeArgs(args);
            assert.strictEqual(result.length, 3);
            assert.strictEqual(result[0], 1);
            assert.ok(result[1] instanceof Uint8Array);
            assert.deepStrictEqual(result[1], new Uint8Array([1, 2]));
            assert.strictEqual(result[2], "test");
        });

        it('should correctly deserialize an empty array of arguments', () => {
            const result = deserializeArgs([]);
            assert.strictEqual(result.length, 0);
        });
    });

    describe('Uint8Array', () => {
        it('should encode and decode empty Uint8Array correctly', () => {
            const original = new Uint8Array([]);
            const base64 = uint8ArrayToBase64(original);
            assert.strictEqual(base64, '');
            const decoded = base64ToUint8Array(base64);
            assert.deepStrictEqual(decoded, original);
        });

        it('should encode and decode Uint8Array correctly', () => {
            const original = new Uint8Array([1, 2, 3, 255]);
            const base64 = uint8ArrayToBase64(original);
            const decoded = base64ToUint8Array(base64);
            assert.deepStrictEqual(decoded, original);
        });
    });

    describe('serializeValue', () => {
        it('rejects a per-value overflow before invoking the base64 encoder', () => {
            const bytes = new Uint8Array(5);
            const bufferFrom = mock.method(Buffer, 'from', () => {
                throw new Error('base64 encoder reached');
            });

            try {
                assert.throws(
                    () => serializeValue(bytes, {
                        surface: 'serialization outbound test',
                        maxBinaryBytes: 4,
                        maxAggregateBytes: 64
                    }),
                    (error: unknown) => {
                        assert.ok(error instanceof WebviewPayloadLimitError);
                        assert.strictEqual(error.code, WEBVIEW_PAYLOAD_LIMIT_ERROR_CODE);
                        assert.strictEqual(error.surface, 'serialization outbound test');
                        assert.strictEqual(error.kind, 'binary-value');
                        assert.strictEqual(error.actualBytes, 5);
                        assert.strictEqual(error.limitBytes, 4);
                        assert.match(error.message, /serialization outbound test/);
                        assert.match(error.message, /4-byte binary-value limit/);
                        return true;
                    }
                );
                assert.strictEqual(bufferFrom.mock.callCount(), 0);
            } finally {
                bufferFrom.mock.restore();
            }
        });

        it('rejects aggregate encoded payload amplification before encoding either value', () => {
            const bufferFrom = mock.method(Buffer, 'from', () => {
                throw new Error('base64 encoder reached');
            });

            try {
                assert.throws(
                    () => serializeValue(
                        [new Uint8Array(4), new Uint8Array(4)],
                        {
                            surface: 'serialization aggregate test',
                            maxBinaryBytes: 8,
                            maxAggregateBytes: 16
                        }
                    ),
                    (error: unknown) => {
                        assert.ok(error instanceof WebviewPayloadLimitError);
                        assert.strictEqual(error.kind, 'aggregate-payload');
                        assert.strictEqual(error.surface, 'serialization aggregate test');
                        assert.ok(error.actualBytes > error.limitBytes);
                        assert.strictEqual(error.limitBytes, 16);
                        return true;
                    }
                );
                assert.strictEqual(bufferFrom.mock.callCount(), 0);
            } finally {
                bufferFrom.mock.restore();
            }
        });

        it('should serialize Uint8Array to marker object', () => {
            const arr = new Uint8Array([10, 20]);
            const result = serializeValue(arr) as any;
            assert.strictEqual(result.__type, 'Uint8Array');
            assert.strictEqual(typeof result.base64, 'string');
        });

        it('should serialize DataView to marker object', () => {
            const buffer = new ArrayBuffer(4);
            const view = new DataView(buffer);
            view.setUint8(0, 10);
            view.setUint8(1, 20);

            const result = serializeValue(view) as any;
            assert.strictEqual(result.__type, 'Uint8Array');

            // Verify content
            const decoded = base64ToUint8Array(result.base64);
            assert.deepStrictEqual(decoded, new Uint8Array([10, 20, 0, 0]));
        });

        it('should serialize other TypedArrays (Float32Array) to marker object', () => {
            const floatArr = new Float32Array([1.5]);
            const result = serializeValue(floatArr) as any;

            assert.strictEqual(result.__type, 'Uint8Array');

            // Verify content by reinterpreting bytes
            const decoded = base64ToUint8Array(result.base64);
            const decodedFloat = new Float32Array(decoded.buffer);
            assert.strictEqual(decodedFloat[0], 1.5);
        });

        it('should handle ArrayBuffer views with offset and length', () => {
            // Create a buffer with [0, 1, 2, 3, 4, 5]
            const buffer = new Uint8Array([0, 1, 2, 3, 4, 5]).buffer;

            // Create a view on the middle part: [2, 3]
            const view = new Uint8Array(buffer, 2, 2);

            const result = serializeValue(view) as any;
            assert.strictEqual(result.__type, 'Uint8Array');

            const decoded = base64ToUint8Array(result.base64);
            assert.deepStrictEqual(decoded, new Uint8Array([2, 3]));
        });

        it('should recursively serialize objects', () => {
            const obj = {
                a: 1,
                b: new Uint8Array([1]),
                c: { d: new Uint8Array([2]) }
            };
            const result = serializeValue(obj) as any;
            assert.strictEqual(result.a, 1);
            assert.strictEqual(result.b.__type, 'Uint8Array');
            assert.strictEqual(result.c.d.__type, 'Uint8Array');
        });

        it('should recursively serialize arrays', () => {
            const arr = [new Uint8Array([1]), 2];
            const result = serializeValue(arr) as any[];
            assert.strictEqual(result[0].__type, 'Uint8Array');
            assert.strictEqual(result[1], 2);
        });
    });


    describe('deserializeValue edge cases', () => {
        it('should ignore marker objects with extra keys (Base64 format)', () => {
            const marker = { __type: 'Uint8Array', base64: Buffer.from([1, 2]).toString('base64'), extra: 123 };
            const result = deserializeValue(marker) as any;
            assert.ok(!(result instanceof Uint8Array), 'extra-key marker must NOT be deserialized as Uint8Array (security invariant)');
            assert.strictEqual(result.__type, 'Uint8Array');
            assert.strictEqual(result.extra, 123);
        });

        it('should ignore marker objects with extra keys (legacy array format)', () => {
            const marker = { __type: 'Uint8Array', data: [1, 2], extra: 123 };
            const result = deserializeValue(marker) as any;
            assert.ok(!(result instanceof Uint8Array), 'extra-key legacy marker must NOT be deserialized as Uint8Array (security invariant)');
            assert.strictEqual(result.__type, 'Uint8Array');
            assert.strictEqual(result.extra, 123);
        });

        it('should handle primitives', () => {
            assert.strictEqual(deserializeValue(123), 123);
            assert.strictEqual(deserializeValue("test"), "test");
            assert.strictEqual(deserializeValue(null), null);
            assert.strictEqual(deserializeValue(undefined), undefined);
        });
    });

    describe('deserializeValue more edge cases', () => {
        it('should handle array of primitives', () => {
             const result = deserializeValue([1, 2, 3]);
             assert.deepStrictEqual(result, [1, 2, 3]);
        });
        it('should ignore marker objects with missing base64 key', () => {
            const marker = { __type: 'Uint8Array', other: 'test' };
            const result = deserializeValue(marker) as any;
            assert.ok(!(result instanceof Uint8Array), 'missing-base64 marker must NOT be deserialized as Uint8Array (security invariant)');
            assert.strictEqual(result.__type, 'Uint8Array');
        });
        it('should handle custom objects gracefully', () => {
            const date = new Date();
            const dateRes = serializeValue(date);
            assert.strictEqual(dateRes, date);
        });
    });

    describe('deserializeValue', () => {

        it('rejects an oversized Base64 marker before invoking the decoder', () => {
            const bufferFrom = mock.method(Buffer, 'from', () => {
                throw new Error('base64 decoder reached');
            });

            try {
                assert.throws(
                    () => deserializeValue(
                        { __type: 'Uint8Array', base64: 'AAAA' },
                        {
                            surface: 'serialization inbound test',
                            maxBinaryBytes: 2,
                            maxAggregateBytes: 64
                        }
                    ),
                    (error: unknown) => {
                        assert.ok(error instanceof WebviewPayloadLimitError);
                        assert.strictEqual(error.surface, 'serialization inbound test');
                        assert.strictEqual(error.kind, 'binary-value');
                        assert.strictEqual(error.actualBytes, 3);
                        assert.strictEqual(error.limitBytes, 2);
                        return true;
                    }
                );
                assert.strictEqual(bufferFrom.mock.callCount(), 0);
            } finally {
                bufferFrom.mock.restore();
            }
        });

        it('should deserialize marker object to Uint8Array', () => {
            const marker = { __type: 'Uint8Array', base64: Buffer.from([1, 2]).toString('base64') };
            const result = deserializeValue(marker);
            assert.ok(result instanceof Uint8Array);
            assert.deepStrictEqual(result, new Uint8Array([1, 2]));
        });

        it('should deserialize legacy array format', () => {
            const marker = { __type: 'Uint8Array', data: [1, 2] };
            const result = deserializeValue(marker);
            assert.ok(result instanceof Uint8Array);
            assert.deepStrictEqual(result, new Uint8Array([1, 2]));
        });

        it('should recursively deserialize objects', () => {
             const obj = {
                a: 1,
                b: { __type: 'Uint8Array', base64: Buffer.from([1]).toString('base64') }
            };
            const result = deserializeValue(obj) as any;
            assert.strictEqual(result.a, 1);
            assert.ok(result.b instanceof Uint8Array);
        });
    });

    it('round-trips the typed payload-limit error shape without trusting arbitrary objects', () => {
        const original = new WebviewPayloadLimitError({
            surface: 'extension host -> webview response',
            kind: 'aggregate-payload',
            actualBytes: 40,
            limitBytes: 32
        });
        const data = toWebviewPayloadLimitErrorData(original);
        const restored = fromWebviewPayloadLimitErrorData(data);

        assert.ok(restored instanceof WebviewPayloadLimitError);
        assert.deepStrictEqual(toWebviewPayloadLimitErrorData(restored), data);
        assert.strictEqual(fromWebviewPayloadLimitErrorData({
            ...data,
            code: 'NOT_THE_TRANSPORT_CODE'
        }), undefined);
    });
});
