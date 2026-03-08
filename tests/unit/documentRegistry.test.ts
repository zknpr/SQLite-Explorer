import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { DocumentRegistry } from '../../src/documentRegistry';
import type { DatabaseDocument } from '../../src/databaseModel';

describe('DocumentRegistry', () => {
  // Clear the registry before each test to ensure isolation
  beforeEach(() => {
    DocumentRegistry.clear();
  });

  it('should be an instance of Map', () => {
    assert.ok(DocumentRegistry instanceof Map);
  });

  it('should initially be empty', () => {
    assert.strictEqual(DocumentRegistry.size, 0);
  });

  it('should be able to set, get, and has elements', () => {
    const mockDoc = { uri: { fsPath: '/test.sqlite' } } as unknown as DatabaseDocument;
    const key = 'test-key';

    DocumentRegistry.set(key, mockDoc);

    assert.strictEqual(DocumentRegistry.size, 1);
    assert.strictEqual(DocumentRegistry.has(key), true);
    assert.strictEqual(DocumentRegistry.get(key), mockDoc);
  });

  it('should be able to delete elements', () => {
    const mockDoc = { uri: { fsPath: '/test.sqlite' } } as unknown as DatabaseDocument;
    const key = 'test-key';

    DocumentRegistry.set(key, mockDoc);
    assert.strictEqual(DocumentRegistry.has(key), true);

    const deleted = DocumentRegistry.delete(key);

    assert.strictEqual(deleted, true);
    assert.strictEqual(DocumentRegistry.size, 0);
    assert.strictEqual(DocumentRegistry.has(key), false);
  });

  it('should return false when deleting a non-existent element', () => {
    const deleted = DocumentRegistry.delete('non-existent-key');
    assert.strictEqual(deleted, false);
  });

  it('should be able to clear all elements', () => {
    const mockDoc1 = {} as DatabaseDocument;
    const mockDoc2 = {} as DatabaseDocument;

    DocumentRegistry.set('key1', mockDoc1);
    DocumentRegistry.set('key2', mockDoc2);

    assert.strictEqual(DocumentRegistry.size, 2);

    DocumentRegistry.clear();

    assert.strictEqual(DocumentRegistry.size, 0);
    assert.strictEqual(DocumentRegistry.has('key1'), false);
    assert.strictEqual(DocumentRegistry.has('key2'), false);
  });
});
