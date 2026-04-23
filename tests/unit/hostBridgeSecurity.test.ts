import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';

describe('HostBridge Path Security logic', () => {
    it('should correctly identify if a path is inside another using path.resolve', () => {
        const checkIsInside = (docDir: string, filePath: string) => {
            const resolvedDocDir = path.resolve(docDir);
            const resolvedFilePath = path.resolve(filePath);
            const prefix = resolvedDocDir.endsWith(path.sep) ? resolvedDocDir : resolvedDocDir + path.sep;
            return resolvedFilePath === resolvedDocDir || resolvedFilePath.startsWith(prefix);
        };

        // Standard inside path
        assert.strictEqual(checkIsInside('/a/b/c', '/a/b/c/d/e.txt'), true);

        // Allowed because they are strictly inside
        assert.strictEqual(checkIsInside('/a/b/c', '/a/b/c/..foo'), true, 'Files starting with .. should be allowed if they are inside');
        assert.strictEqual(checkIsInside('/a/b/c', '/a/b/c/d/../e.txt'), true, 'Should allow resolved relative paths that remain inside');

        // Exact directory
        assert.strictEqual(checkIsInside('/a/b/c', '/a/b/c'), true);

        // Security violation attempts
        assert.strictEqual(checkIsInside('/a/b/c', '/a/b/c-fake/foo'), false, 'Should prevent directory traversal via prefix spoofing');
        assert.strictEqual(checkIsInside('/a/b/c', '/a/b/c/../../d/e.txt'), false, 'Should prevent directory traversal via ..');
        assert.strictEqual(checkIsInside('/a/b/c', '/a/b/d'), false, 'Sibling directories should be rejected');
    });
});
