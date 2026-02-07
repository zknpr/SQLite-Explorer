
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { WebviewCollection } from '../../src/webview-collection';

// Mock types to simulate VS Code objects
class MockUri {
    constructor(private path: string) {}
    toString() { return this.path; }
}

class MockWebviewPanel {
    private disposeCallback?: () => void;

    onDidDispose(callback: () => void) {
        this.disposeCallback = callback;
        return { dispose: () => {} }; // Return disposable
    }

    // Helper for test to trigger disposal
    dispose() {
        if (this.disposeCallback) {
            this.disposeCallback();
        }
    }
}

describe('WebviewCollection', () => {
    let collection: WebviewCollection;

    beforeEach(() => {
        collection = new WebviewCollection();
    });

    it('should add a panel and retrieve it by ID', () => {
        const uri = new MockUri('file:///test');
        const panel = new MockWebviewPanel();
        const id = 'view-1';

        // Cast to any to bypass strict type checking against real VS Code types
        collection.add(uri as any, panel as any, id);

        const retrieved = collection.getByWebviewId(id);
        assert.strictEqual(retrieved, panel);
    });

    it('should retrieve all panels for a specific URI', () => {
        const uri1 = new MockUri('file:///test1');
        const uri2 = new MockUri('file:///test2');

        const panel1 = new MockWebviewPanel();
        const panel2 = new MockWebviewPanel();
        const panel3 = new MockWebviewPanel(); // different URI

        collection.add(uri1 as any, panel1 as any, 'view-1');
        collection.add(uri1 as any, panel2 as any, 'view-2');
        collection.add(uri2 as any, panel3 as any, 'view-3');

        const panels1 = Array.from(collection.get(uri1 as any));
        assert.strictEqual(panels1.length, 2);
        assert.ok(panels1.includes(panel1 as any));
        assert.ok(panels1.includes(panel2 as any));

        const panels2 = Array.from(collection.get(uri2 as any));
        assert.strictEqual(panels2.length, 1);
        assert.ok(panels2.includes(panel3 as any));
    });

    it('should return empty iterator for unknown URI', () => {
        const uri = new MockUri('file:///unknown');
        const panels = Array.from(collection.get(uri as any));
        assert.strictEqual(panels.length, 0);
    });

    it('should correctly check if panels exist for a URI', () => {
        const uri = new MockUri('file:///test');
        const panel = new MockWebviewPanel();

        assert.strictEqual(collection.has(uri as any), false);

        collection.add(uri as any, panel as any, 'view-1');
        assert.strictEqual(collection.has(uri as any), true);
    });

    it('should remove panel when it is disposed', () => {
        const uri = new MockUri('file:///test');
        const panel = new MockWebviewPanel();
        const id = 'view-1';

        collection.add(uri as any, panel as any, id);

        // Verify it exists
        assert.ok(collection.getByWebviewId(id));
        assert.ok(collection.has(uri as any));

        // Trigger disposal
        panel.dispose();

        // Verify it is removed
        assert.strictEqual(collection.getByWebviewId(id), undefined);
        assert.strictEqual(collection.has(uri as any), false);
    });

    it('should handle multiple panels for same URI and remove only the disposed one', () => {
        const uri = new MockUri('file:///test');
        const panel1 = new MockWebviewPanel();
        const panel2 = new MockWebviewPanel();

        collection.add(uri as any, panel1 as any, 'view-1');
        collection.add(uri as any, panel2 as any, 'view-2');

        assert.strictEqual(collection.has(uri as any), true);

        panel1.dispose();

        const panels = Array.from(collection.get(uri as any));
        assert.strictEqual(panels.length, 1);
        assert.strictEqual(panels[0], panel2);

        assert.strictEqual(collection.getByWebviewId('view-1'), undefined);
        assert.strictEqual(collection.getByWebviewId('view-2'), panel2);
    });
});
