
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateMergePatch, applyMergePatch } from '../../src/core/json-utils';

describe('JSON Merge Patch Security', () => {
    it('generateMergePatch should throw on deep recursion', () => {
        const depth = 1100; // > 1000
        let original: any = { a: 1 };
        let modified: any = { a: 2 };

        for (let i = 0; i < depth; i++) {
            original = { next: original };
            modified = { next: modified };
        }

        try {
            generateMergePatch(original, modified);
            assert.fail('Should have thrown depth limit error');
        } catch (e: any) {
            assert.match(e.message, /JSON merge patch depth limit exceeded/);
        }
    });

    it('applyMergePatch should throw on deep recursion', () => {
        const depth = 1100; // > 1000
        let target: any = { a: 1 };
        let patch: any = { a: 2 };

        for (let i = 0; i < depth; i++) {
            target = { next: target };
            patch = { next: patch };
        }

        try {
             applyMergePatch(target, patch);
             assert.fail('Should have thrown depth limit error');
        } catch (e: any) {
             assert.match(e.message, /JSON apply merge patch depth limit exceeded/);
        }
    });

    it('should handle cyclic references by depth limit', () => {
         const original: any = { a: 1 };
         original.self = original;
         const modified: any = { a: 2 };
         modified.self = modified;

         try {
             generateMergePatch(original, modified);
             assert.fail('Should have thrown depth limit error');
         } catch (e: any) {
             assert.match(e.message, /JSON merge patch depth limit exceeded/);
         }
    });
});
