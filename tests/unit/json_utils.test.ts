
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateMergePatch, applyMergePatch, invertMergePatch, tryCreateInverseMergePatch } from '../../src/core/json-utils';

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
        it('should return null if patch is null at root level', () => {
            const target = { a: 1 };
            const patch = null;
            const result = applyMergePatch(target, patch);
            assert.strictEqual(result, null);
        });

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
        });
    });

    describe('invertMergePatch', () => {
        it('should delete keys added by the forward patch', () => {
            const prior = { a: 1 };
            const forward = { b: 2 };

            // The inverse uses null for keys that did not exist in the prior document.
            assert.deepStrictEqual(invertMergePatch(forward, prior), { b: null });
        });

        it('should restore changed scalar values from the prior document', () => {
            const prior = { status: 'draft', count: 1 };
            const forward = { status: 'published' };

            assert.deepStrictEqual(invertMergePatch(forward, prior), { status: 'draft' });
        });

        it('should recurse into nested object patches', () => {
            const prior = { meta: { reviewed: false, owner: 'ada' } };
            const forward = { meta: { reviewed: true } };

            assert.deepStrictEqual(invertMergePatch(forward, prior), { meta: { reviewed: false } });
        });

        it('should restore values removed by a forward delete patch', () => {
            const prior = { a: 1, retired: 'keep' };
            const forward = { retired: null };

            assert.deepStrictEqual(invertMergePatch(forward, prior), { retired: 'keep' });
        });

        it('should round-trip the touched keys while preserving concurrent sibling changes', () => {
            const prior = { status: 'draft', meta: { reviewed: false, owner: 'ada' } };
            const forward = { status: 'published', meta: { reviewed: true }, added: 'new' };
            const inverse = invertMergePatch(forward, prior);
            const afterForward = applyMergePatch(prior, forward);

            assert.deepStrictEqual(applyMergePatch(afterForward, inverse), prior);

            // A sibling key added after the forward patch is outside the inverse key structure.
            const withConcurrentSibling = applyMergePatch(afterForward, {
                concurrent: 'survives',
                meta: { note: 'keep' }
            });

            assert.deepStrictEqual(applyMergePatch(withConcurrentSibling, inverse), {
                status: 'draft',
                meta: { reviewed: false, owner: 'ada', note: 'keep' },
                concurrent: 'survives'
            });
        });
    });

    describe('tryCreateInverseMergePatch', () => {
        it('should reject scalar and array forward patches so undo can value-replace the cell', () => {
            const prior = JSON.stringify({ a: 1 });

            // RFC 7396 scalar and array patches replace the whole document, so a key-limited inverse is not faithful.
            assert.strictEqual(tryCreateInverseMergePatch('5', prior), undefined);
            assert.strictEqual(tryCreateInverseMergePatch('[1,2]', prior), undefined);
        });

        it('should reject inverse patches that would restore an explicit null leaf', () => {
            const prior = JSON.stringify({ a: null, b: 1 });
            const forward = JSON.stringify({ a: 2 });

            // Emitting { a: null } would delete a instead of restoring an explicit JSON null.
            assert.strictEqual(tryCreateInverseMergePatch(forward, prior), undefined);
        });

        it('should still emit null when deleting a key added by the forward patch', () => {
            const prior = JSON.stringify({ b: 1 });
            const forward = JSON.stringify({ a: 2 });

            assert.deepStrictEqual(
                JSON.parse(tryCreateInverseMergePatch(forward, prior)!),
                { a: null }
            );
        });

        it('should recurse into nested additions so concurrent nested siblings survive undo', () => {
            const prior = JSON.stringify({});
            const forward = JSON.stringify({ meta: { reviewed: true } });
            const inverse = JSON.parse(tryCreateInverseMergePatch(forward, prior)!);

            assert.deepStrictEqual(inverse, { meta: { reviewed: null } });
            assert.deepStrictEqual(
                applyMergePatch({ meta: { reviewed: true, note: 'keep' } }, inverse),
                { meta: { note: 'keep' } }
            );
        });
    });
});
