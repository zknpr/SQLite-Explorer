
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateMergePatch, applyMergePatch } from '../../src/core/json-utils';

function createDeepObject(depth: number, leafValue: unknown = 1) {
    let obj: Record<string, unknown> = { leaf: leafValue };
    for (let i = 0; i < depth; i++) {
        obj = { next: obj };
    }
    return obj;
}

describe('JSON Merge Patch Security', () => {
    // MAX_DEPTH is 1000.
    // Nesting level N creates depth N+1 (recursion for leaf comparison/application).
    // So Nesting 999 -> Depth 1000 (Allowed).
    // Nesting 1000 -> Depth 1001 (Throw).

    it('generateMergePatch should allow max depth (1000)', () => {
        const nesting = 999;
        const original = createDeepObject(nesting, 1);
        const modified = createDeepObject(nesting, 2);

        // Should not throw
        const patch = generateMergePatch(original, modified);
        assert.notStrictEqual(patch, undefined);
    });

    it('generateMergePatch should throw on max depth + 1 (1001)', () => {
        const nesting = 1000;
        const original = createDeepObject(nesting, 1);
        const modified = createDeepObject(nesting, 2);

        try {
            generateMergePatch(original, modified);
            assert.fail('Should have thrown depth limit error');
        } catch (e: unknown) {
            if (e instanceof Error) {
                assert.match(e.message, /JSON merge patch depth limit exceeded/);
            } else {
                throw e;
            }
        }
    });

    it('applyMergePatch should allow max depth (1000)', () => {
        const nesting = 999;
        const target = {};
        const patch = createDeepObject(nesting, 1);

        // Should not throw
        applyMergePatch(target, patch);
    });

    it('applyMergePatch should throw on max depth + 1 (1001)', () => {
        const nesting = 1000;
        const target = {};
        const patch = createDeepObject(nesting, 1);

        try {
            applyMergePatch(target, patch);
            assert.fail('Should have thrown depth limit error');
        } catch (e: unknown) {
            if (e instanceof Error) {
                assert.match(e.message, /JSON apply merge patch depth limit exceeded/);
            } else {
                throw e;
            }
        }
    });

    it('should handle cyclic references by depth limit', () => {
         const original: Record<string, unknown> = { a: 1 };
         original.self = original;
         const modified: Record<string, unknown> = { a: 2 };
         modified.self = modified;

         try {
             generateMergePatch(original, modified);
             assert.fail('Should have thrown depth limit error');
         } catch (e: unknown) {
             if (e instanceof Error) {
                 assert.match(e.message, /JSON merge patch depth limit exceeded/);
             } else {
                 throw e;
             }
         }
    });
});
