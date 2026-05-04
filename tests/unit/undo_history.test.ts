import { describe, it } from 'node:test';
import assert from 'node:assert';
import { binaryReplacer, binaryReviver, calculateSize } from '../../src/core/undo-history';

describe('undo-history internal functions', () => {
    describe('binaryReplacer', () => {
        it('should return non-Uint8Array values as is', () => {
            assert.strictEqual(binaryReplacer('key', 'value'), 'value');
            assert.strictEqual(binaryReplacer('key', 123), 123);
            assert.strictEqual(binaryReplacer('key', null), null);
            assert.deepStrictEqual(binaryReplacer('key', { a: 1 }), { a: 1 });
        });

        it('should convert Uint8Array to base64 object format', () => {
            const data = new Uint8Array([72, 101, 108, 108, 111]); // 'Hello'
            const result = binaryReplacer('key', data) as any;

            assert.ok(result);
            assert.strictEqual(result.__type, 'Uint8Array');
            assert.strictEqual(result.data, Buffer.from(data).toString('base64'));
        });
    });

    describe('binaryReviver', () => {
        it('should return normal values as is', () => {
            assert.strictEqual(binaryReviver('key', 'value'), 'value');
            assert.strictEqual(binaryReviver('key', 123), 123);
            assert.strictEqual(binaryReviver('key', null), null);
            assert.deepStrictEqual(binaryReviver('key', { a: 1 }), { a: 1 });
        });

        it('should convert base64 object format back to Uint8Array', () => {
            const originalData = new Uint8Array([72, 101, 108, 108, 111]);
            const serialized = {
                __type: 'Uint8Array',
                data: Buffer.from(originalData).toString('base64')
            };

            const result = binaryReviver('key', serialized) as Uint8Array;
            assert.ok(result instanceof Uint8Array);
            assert.deepStrictEqual(result, originalData);
        });

        it('should return object as is if it does not have correct __type', () => {
            const invalidFormat = { __type: 'OtherType', data: 'something' };
            assert.deepStrictEqual(binaryReviver('key', invalidFormat), invalidFormat);
        });

        it('should return object as is if data is not string', () => {
            const invalidFormat = { __type: 'Uint8Array', data: 123 };
            assert.deepStrictEqual(binaryReviver('key', invalidFormat), invalidFormat);
        });
    });

    describe('calculateSize', () => {
        it('should return 0 for null/undefined', () => {
            assert.strictEqual(calculateSize(null), 0);
            assert.strictEqual(calculateSize(undefined), 0);
        });

        it('should calculate size of primitive types correctly', () => {
            assert.strictEqual(calculateSize(true), 4);
            assert.strictEqual(calculateSize(false), 4);
            assert.strictEqual(calculateSize(123), 8);
            assert.strictEqual(calculateSize('hello'), 10); // length 5 * 2
        });

        it('should calculate size of Uint8Array correctly', () => {
            const data = new Uint8Array(10);
            assert.strictEqual(calculateSize(data), 10);
        });

        it('should calculate size of object correctly', () => {
            // object overhead (8) + key "a" (1*2=2) + number value (8) = 18
            assert.strictEqual(calculateSize({ a: 1 }), 18);
        });

        it('should calculate size of array correctly', () => {
            // object overhead (8) + 2 numbers (8+8) = 24
            assert.strictEqual(calculateSize([1, 2]), 24);
        });

        it('should handle circular references without infinite loop', () => {
            const obj: any = { a: 1 };
            obj.self = obj;

            // object overhead (8)
            // + key "a" (1*2=2) + number value (8)
            // + key "self" (4*2=8) + seen object (0)
            // = 26
            assert.strictEqual(calculateSize(obj), 26);
        });
    });
});
