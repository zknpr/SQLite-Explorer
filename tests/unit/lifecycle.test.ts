import './vscode_mock_setup'; // Ensure vscode is mocked
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Disposable, disposeAll } from '../../src/lifecycle';
import * as vscode from 'vscode';

// Mock Disposable for testing
class TestDisposable implements vscode.Disposable {
    public disposed = false;
    constructor(private onDispose?: () => void) {}
    dispose() {
        this.disposed = true;
        if (this.onDispose) {
            this.onDispose();
        }
    }
}

describe('disposeAll', () => {
    it('should dispose all items', () => {
        const d1 = new TestDisposable();
        const d2 = new TestDisposable();
        disposeAll([d1, d2]);
        assert.strictEqual(d1.disposed, true);
        assert.strictEqual(d2.disposed, true);
    });

    it('should dispose items in reverse order', () => {
        const log: number[] = [];
        const d1 = new TestDisposable(() => log.push(1));
        const d2 = new TestDisposable(() => log.push(2));
        const d3 = new TestDisposable(() => log.push(3));
        disposeAll([d1, d2, d3]);
        assert.deepStrictEqual(log, [3, 2, 1]);
    });

    it('should collect errors and throw AggregateError', () => {
        const error1 = new Error('Error 1');
        const error2 = new Error('Error 2');
        const d1 = { dispose: () => { throw error1; } };
        const d2 = { dispose: () => { throw error2; } };
        const d3 = new TestDisposable();

        try {
            disposeAll([d1, d3, d2]);
            assert.fail('Should have thrown AggregateError');
        } catch (err: any) {
            assert.ok(err instanceof AggregateError);
            assert.strictEqual(err.errors.length, 2);
            assert.strictEqual(err.errors[0], error2); // d2 is disposed first (reverse order)
            assert.strictEqual(err.errors[1], error1); // d1 is disposed last
            assert.strictEqual(d3.disposed, true); // d3 should still be disposed
        }
    });
});

describe('Disposable', () => {
    class MyService extends Disposable {
        public register<T extends vscode.Disposable>(child: T): T {
            return this._register(child);
        }
        public get isDisposedPublic(): boolean {
            return this.isDisposed;
        }
    }

    it('should dispose registered children', () => {
        const service = new MyService();
        const child1 = new TestDisposable();
        const child2 = new TestDisposable();

        service.register(child1);
        service.register(child2);

        service.dispose();

        assert.strictEqual(child1.disposed, true);
        assert.strictEqual(child2.disposed, true);
        assert.strictEqual(service.isDisposedPublic, true);
    });

    it('should dispose children in reverse order', () => {
        const service = new MyService();
        const log: number[] = [];
        const child1 = new TestDisposable(() => log.push(1));
        const child2 = new TestDisposable(() => log.push(2));

        service.register(child1);
        service.register(child2);

        service.dispose();

        assert.deepStrictEqual(log, [2, 1]);
    });

    it('should be idempotent', () => {
        const service = new MyService();
        let callCount = 0;
        const child = new TestDisposable(() => callCount++);

        service.register(child);

        service.dispose();
        service.dispose();

        assert.strictEqual(callCount, 1);
    });

    it('should dispose child immediately if parent is already disposed', () => {
        const service = new MyService();
        service.dispose();

        const child = new TestDisposable();
        service.register(child);

        assert.strictEqual(child.disposed, true);
    });

    it('should support Symbol.dispose', () => {
        const child = new TestDisposable();
        {
            using service = new MyService();
            service.register(child);
        } // service disposed here

        assert.strictEqual(child.disposed, true);
    });
});
