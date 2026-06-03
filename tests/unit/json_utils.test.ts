
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateMergePatch, applyMergePatch, computeJsonPatchUndo } from '../../src/core/json-utils';

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
});

describe('computeJsonPatchUndo (RMW undo decision)', () => {
    const j = (v: unknown) => JSON.stringify(v);
    const expectRestore = (plan: ReturnType<typeof computeJsonPatchUndo>, expected: unknown) => {
        assert.strictEqual(plan.kind, 'restore');
        assert.deepStrictEqual(JSON.parse((plan as { kind: 'restore'; value: string }).value), expected);
    };
    const expectReplace = (plan: ReturnType<typeof computeJsonPatchUndo>) =>
        assert.strictEqual(plan.kind, 'replace');

    it('s1: restores the edited key and preserves a concurrent sibling key', () => {
        expectRestore(
            computeJsonPatchUndo(
                j({ status: 'published', owner: 'ada', reviewer: 'grace' }), // current (forward + concurrent)
                j({ status: 'published' }),                                   // forward patch (newValue)
                j({ status: 'draft', owner: 'ada' })                          // prior
            ),
            { status: 'draft', owner: 'ada', reviewer: 'grace' }
        );
    });

    it('s2: removes a wholly-added object key (empty-object collapse)', () => {
        expectRestore(
            computeJsonPatchUndo(j({ meta: { reviewed: true } }), j({ meta: { reviewed: true } }), j({})),
            {}
        );
    });

    it('s3: removes only the added nested leaf, keeping a concurrent nested sibling', () => {
        expectRestore(
            computeJsonPatchUndo(j({ meta: { reviewed: true, note: 'keep' } }), j({ meta: { reviewed: true } }), j({})),
            { meta: { note: 'keep' } }
        );
    });

    it('s4: restores an explicit null at the edited key while preserving a concurrently added sibling', () => {
        // c exists in current but not prior — added concurrently after the tracked edit.
        // Blind value-replacement to prior would drop c; RMW restores a=null and keeps c.
        expectRestore(
            computeJsonPatchUndo(j({ a: 2, b: 1, c: 3 }), j({ a: 2 }), j({ a: null, b: 1 })),
            { a: null, b: 1, c: 3 }
        );
    });

    it('s5: restores a nested explicit null while preserving a concurrently added nested sibling', () => {
        // meta.c was added concurrently; RMW restores meta.a=null and keeps meta.c.
        expectRestore(
            computeJsonPatchUndo(
                j({ meta: { a: 2, keep: 1, c: 3 } }),
                j({ meta: { a: 2 } }),
                j({ meta: { a: null, keep: 1 } })
            ),
            { meta: { a: null, keep: 1, c: 3 } }
        );
    });

    it('s6: value-replaces when the current cell is not a JSON object', () => {
        for (const current of ['plain text', null, '5', '[1,2]']) {
            expectReplace(computeJsonPatchUndo(current, j({ status: 'published' }), j({ status: 'draft' })));
        }
    });

    it('s7: value-replaces when the forward patch was a scalar/array whole-doc replacement', () => {
        expectReplace(computeJsonPatchUndo(j({ a: 1 }), '5', j({ a: 1 })));
        expectReplace(computeJsonPatchUndo(j({ a: 1 }), '[1,2]', j({ a: 1 })));
    });

    it('s8: value-replaces when the prior cell was SQL NULL / non-object', () => {
        expectReplace(computeJsonPatchUndo(j({ added: true }), j({ added: true }), null));
        expectReplace(computeJsonPatchUndo(j({ added: true }), j({ added: true }), '5'));
    });

    it('invariant: round-trips an object edit (no concurrent change) back to prior', () => {
        const prior = { status: 'draft', meta: { reviewed: false, owner: 'ada' } };
        const forward = generateMergePatch(prior, { status: 'published', meta: { reviewed: true, owner: 'ada' } });
        const current = applyMergePatch(prior, forward);
        expectRestore(computeJsonPatchUndo(j(current), j(forward), j(prior)), prior);
    });

    it('invariant: never touches keys outside the forward patch structure', () => {
        expectRestore(
            computeJsonPatchUndo(
                j({ a: 'forward-changed', untouched: { deep: 1 }, sibling: 2 }),
                j({ a: 'forward-changed' }),
                j({ a: 'orig' })
            ),
            { a: 'orig', untouched: { deep: 1 }, sibling: 2 }
        );
    });
});
