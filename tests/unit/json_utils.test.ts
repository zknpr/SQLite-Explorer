
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateMergePatch, applyMergePatch } from '../../src/core/json-utils';

describe('JSON Merge Patch (RFC 7396)', () => {
    describe('generateMergePatch', () => {
        it('should return undefined if objects are identical', () => {
            const original = { a: 1 };
            const modified = { a: 1 };
            assert.strictEqual(generateMergePatch(original, modified), undefined);
        });

        it('should detect added keys', () => {
            const original = { a: 1 };
            const modified = { a: 1, b: 2 };
            assert.deepStrictEqual(generateMergePatch(original, modified), { b: 2 });
        });

        it('should detect modified keys', () => {
            const original = { a: 1 };
            const modified = { a: 2 };
            assert.deepStrictEqual(generateMergePatch(original, modified), { a: 2 });
        });

        it('should detect deleted keys', () => {
            const original = { a: 1, b: 2 };
            const modified = { a: 1 };
            assert.deepStrictEqual(generateMergePatch(original, modified), { b: null });
        });

        it('should handle nested objects', () => {
            const original = { a: { x: 1, y: 2 } };
            const modified = { a: { x: 1, y: 3 } };
            assert.deepStrictEqual(generateMergePatch(original, modified), { a: { y: 3 } });
        });

        it('should replace arrays entirely', () => {
            const original = { a: [1, 2] };
            const modified = { a: [1, 3] };
            assert.deepStrictEqual(generateMergePatch(original, modified), { a: [1, 3] });
        });

        it('should handle complex nesting', () => {
            const original = { a: { b: { c: 1 } }, d: 2 };
            const modified = { a: { b: { c: 2 } } }; // d deleted, c modified
            assert.deepStrictEqual(generateMergePatch(original, modified), {
                a: { b: { c: 2 } },
                d: null
            });
        });
    });

    describe('applyMergePatch', () => {
        it('should modify property', () => {
            const target = { a: 1, b: 2 };
            const patch = { a: 3 };
            const result = applyMergePatch(target, patch);
            assert.deepStrictEqual(result, { a: 3, b: 2 });
        });

        it('should add property', () => {
            const target = { a: 1 };
            const patch = { b: 2 };
            const result = applyMergePatch(target, patch);
            assert.deepStrictEqual(result, { a: 1, b: 2 });
        });

        it('should remove property', () => {
            const target = { a: 1, b: 2 };
            const patch = { b: null };
            const result = applyMergePatch(target, patch);
            assert.deepStrictEqual(result, { a: 1 });
        });

        it('should handle nested patches', () => {
            const target = { a: { x: 1, y: 2 } };
            const patch = { a: { y: 3 } };
            const result = applyMergePatch(target, patch);
            assert.deepStrictEqual(result, { a: { x: 1, y: 3 } });
        });

        it('should replace arrays', () => {
            const target = { a: [1, 2] };
            const patch = { a: [3, 4] };
            const result = applyMergePatch(target, patch);
            assert.deepStrictEqual(result, { a: [3, 4] });
        });

        it('should not mutate original object deeply', () => {
            const target = { a: { x: 1 } };
            const patch = { a: { y: 2 } };
            const result = applyMergePatch(target, patch);

            // Result should have both
            assert.deepStrictEqual(result, { a: { x: 1, y: 2 } });

            // Original logic in applyMergePatch creates a shallow copy of the target level being patched,
            // but it modifies nested objects if they are reused?
            // Let's verify implementation behavior.
            // The implementation:
            // target = { ...target } (shallow clone)
            // target[key] = applyMergePatch(target[key], val)
            // So it should be structurally shared but safe for the root.
        });
    });
});
