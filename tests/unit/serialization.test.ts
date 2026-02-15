import { describe, it } from 'node:test';
import assert from 'node:assert';
import { serializeValue, deserializeValue, uint8ArrayToBase64, base64ToUint8Array } from '../../src/core/serialization';

describe('RPC Serialization', () => {
    describe('Uint8Array', () => {
        it('should encode and decode Uint8Array correctly', () => {
            const original = new Uint8Array([1, 2, 3, 255]);
            const base64 = uint8ArrayToBase64(original);
            const decoded = base64ToUint8Array(base64);
            assert.deepStrictEqual(decoded, original);
        });
    });

    describe('serializeValue', () => {
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

    describe('deserializeValue', () => {
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
});
