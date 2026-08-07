
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    generateMergePatch,
    applyMergePatch,
    computeJsonPatchUndo,
    prepareCellUpdateForStorage
} from '../../src/core/json-utils';

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

        it('should throw error if depth limit is exceeded', () => {
            const patch = { a: { b: { c: 1 } } };
            assert.throws(() => applyMergePatch({}, patch, 1001), /JSON apply merge patch depth limit exceeded/);
        });

        it('should replace target if patch is primitive or array', () => {
            assert.strictEqual(applyMergePatch({ a: 1 }, 'test'), 'test');
            assert.deepStrictEqual(applyMergePatch({ a: 1 }, [1, 2]), [1, 2]);
        });

        it('should treat target as empty object if it is primitive, null, or array', () => {
            assert.deepStrictEqual(applyMergePatch(null, { a: 1 }), { a: 1 });
            assert.deepStrictEqual(applyMergePatch('str', { a: 1 }), { a: 1 });
            assert.deepStrictEqual(applyMergePatch([1, 2], { a: 1 }), { a: 1 });
        });

        it('should handle deletion of non-existent property', () => {
            assert.deepStrictEqual(applyMergePatch({ a: 1 }, { b: null }), { a: 1 });
        });

        it('should correctly apply nested patch when target property is not an object', () => {
            assert.deepStrictEqual(applyMergePatch({ a: 1 }, { a: { b: 2 } }), { a: { b: 2 } });
        });

        it('should only process patch own properties', () => {
            const proto = { inherited: 1 };
            const patch = Object.create(proto);
            patch.own = 2;
            assert.deepStrictEqual(applyMergePatch({ a: 1 }, patch), { a: 1, own: 2 });
        });
    });
});

describe('prepareCellUpdateForStorage', () => {
    it('emits a merge patch for a plain object edit that round-trips through apply', () => {
        const prior = '{"a":1,"b":2}';
        const next = '{"a":5,"b":2}';
        const prepared = prepareCellUpdateForStorage(next, prior);
        assert.strictEqual(prepared.operation, 'json_patch');
        assert.deepStrictEqual(JSON.parse(prepared.value as string), { a: 5 });
        assert.deepStrictEqual(
            applyMergePatch(JSON.parse(prior), JSON.parse(prepared.value as string)),
            JSON.parse(next)
        );
    });

    it('stores the full value when the edit sets a key to null', () => {
        // The patch would be {"a":null}, which applies as a key DELETION
        // (RFC 7396) — the user's explicit null must survive as a set.
        const prepared = prepareCellUpdateForStorage('{"a":null,"b":2}', '{"a":1,"b":2}');
        assert.deepStrictEqual(prepared, { value: '{"a":null,"b":2}', operation: 'set' });
    });

    it('stores the full value when a key becomes null at any depth', () => {
        const next = '{"a":{"b":{"c":null}},"d":1}';
        const prepared = prepareCellUpdateForStorage(next, '{"a":{"b":{"c":1}},"d":1}');
        assert.deepStrictEqual(prepared, { value: next, operation: 'set' });
    });

    it('stores the full value when an added subtree contains null', () => {
        // Merge-patch application strips nulls even inside newly added objects.
        const next = '{"a":1,"b":{"c":null,"d":2}}';
        const prepared = prepareCellUpdateForStorage(next, '{"a":1}');
        assert.deepStrictEqual(prepared, { value: next, operation: 'set' });
    });

    it('stores the full value when the edit deletes a key', () => {
        // The patch would be the ambiguous {"b":null}; correctness beats the
        // optimization.
        const prepared = prepareCellUpdateForStorage('{"a":1}', '{"a":1,"b":2}');
        assert.deepStrictEqual(prepared, { value: '{"a":1}', operation: 'set' });
    });

    it('still patches when null appears only inside an array', () => {
        // Merge patch copies arrays verbatim, so nulls inside them are data,
        // not delete markers — the optimization stays safe here.
        const prior = '{"a":[1,2],"b":1}';
        const next = '{"a":[1,null,{"c":null}],"b":1}';
        const prepared = prepareCellUpdateForStorage(next, prior);
        assert.strictEqual(prepared.operation, 'json_patch');
        assert.deepStrictEqual(
            applyMergePatch(JSON.parse(prior), JSON.parse(prepared.value as string)),
            JSON.parse(next)
        );
    });

    it('keeps pre-built history-replay patches verbatim, including nulls', () => {
        const prepared = prepareCellUpdateForStorage('{"a":null}', '{"a":1}', 'json_patch');
        assert.deepStrictEqual(prepared, { value: '{"a":null}', operation: 'json_patch' });
    });

    it('falls back to set for non-object or unparseable values', () => {
        assert.deepStrictEqual(prepareCellUpdateForStorage(5, 4), { value: 5, operation: 'set' });
        assert.deepStrictEqual(
            prepareCellUpdateForStorage('plain', '{"a":1}'),
            { value: 'plain', operation: 'set' }
        );
        assert.deepStrictEqual(
            prepareCellUpdateForStorage('[1,2]', '[1]'),
            { value: '[1,2]', operation: 'set' }
        );
        assert.deepStrictEqual(
            prepareCellUpdateForStorage('{"a":}', '{"a":1}'),
            { value: '{"a":}', operation: 'set' }
        );
    });

    it('falls back to set when nothing changed', () => {
        assert.deepStrictEqual(
            prepareCellUpdateForStorage('{"a":1}', '{ "a" : 1 }'),
            { value: '{"a":1}', operation: 'set' }
        );
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

    it('restores literal __proto__ keys as data without mutating prototypes', () => {
        const priorRaw = '{"a":1,"__proto__":{"x":9}}';
        const forwardRaw = '{"__proto__":{"x":10}}';
        const currentRaw = '{"a":1,"b":2}';

        const beforePrototype = ({} as Record<string, unknown>).x;
        const plan = computeJsonPatchUndo(currentRaw, forwardRaw, priorRaw);

        assert.strictEqual(plan.kind, 'restore');
        const restoredRaw = (plan as { kind: 'restore'; value: string }).value;
        assert.strictEqual(restoredRaw, '{"a":1,"b":2,"__proto__":{"x":9}}');
        const restored = JSON.parse(restoredRaw);
        assert.deepStrictEqual(restored.__proto__, { x: 9 });
        assert.strictEqual(({} as Record<string, unknown>).x, beforePrototype);
    });

    it('preserves literal __proto__ and constructor keys already present on the current cell', () => {
        const priorRaw = '{"a":1,"constructor":{"safe":1,"owner":"ada"}}';
        const forwardRaw = '{"b":2,"constructor":{"safe":2}}';
        const currentRaw = '{"a":1,"b":2,"__proto__":{"x":9},"constructor":{"safe":2,"owner":"ada","keep":3}}';

        const plan = computeJsonPatchUndo(currentRaw, forwardRaw, priorRaw);

        assert.strictEqual(plan.kind, 'restore');
        const restoredRaw = (plan as { kind: 'restore'; value: string }).value;
        assert.strictEqual(restoredRaw.includes('"__proto__":{"x":9}'), true);
        expectRestore(
            plan,
            JSON.parse('{"a":1,"__proto__":{"x":9},"constructor":{"safe":1,"owner":"ada","keep":3}}')
        );
        assert.strictEqual(({} as Record<string, unknown>).x, undefined);
    });

    it('restores the full prior subtree when the current nested value is no longer an object', () => {
        expectRestore(
            computeJsonPatchUndo(
                j({ meta: 'archived' }),
                j({ meta: { reviewed: true } }),
                j({ meta: { reviewed: false, owner: 'ada' } })
            ),
            { meta: { reviewed: false, owner: 'ada' } }
        );
    });

    it('value-replaces when untouched integer tokens cannot survive JSON parse/stringify exactly', () => {
        expectReplace(
            computeJsonPatchUndo(
                '{"id":9007199254740993,"a":2}',
                j({ a: 2 }),
                '{"id":9007199254740993,"a":1}'
            )
        );
    });

    it('value-replaces when untouched exponent tokens overflow JSON number parsing', () => {
        expectReplace(
            computeJsonPatchUndo(
                '{"huge":1e999,"a":2}',
                j({ a: 2 }),
                '{"huge":1e999,"a":1}'
            )
        );
    });

    it('value-replaces when an untouched high-precision decimal cannot round-trip', () => {
        // The decimal carries more precision than a JS double; JSON.parse/stringify
        // would round it, so undo must value-replace to keep it byte-exact.
        expectReplace(
            computeJsonPatchUndo(
                '{"precise":0.1234567890123456789012345,"a":2}',
                j({ a: 2 }),
                '{"precise":0.1234567890123456789012345,"a":1}'
            )
        );
    });

    it('still performs a surgical restore when object cells have no precision-risky integers', () => {
        expectRestore(
            computeJsonPatchUndo(
                j({ id: 42, a: 2, untouched: 'keep' }),
                j({ a: 2 }),
                j({ id: 42, a: 1 })
            ),
            { id: 42, a: 1, untouched: 'keep' }
        );
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
