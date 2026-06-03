import { describe, it } from 'node:test';
import assert from 'node:assert';
import { serializeOperations } from '../../src/core/operation-serializer';
import type { DatabaseOperations, QueryResultSet } from '../../src/core/types';

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function createOperations(overrides: Partial<DatabaseOperations> = {}): DatabaseOperations {
    const operations: DatabaseOperations = {
        engineKind: Promise.resolve('wasm'),
        executeQuery: async (): Promise<QueryResultSet[]> => [],
        serializeDatabase: async () => new Uint8Array(),
        applyModifications: async () => {},
        undoModification: async () => {},
        redoModification: async () => {},
        flushChanges: async () => {},
        discardModifications: async () => {},
        updateCell: async () => {},
        insertRow: async () => undefined,
        insertRowBatch: async () => {},
        deleteRows: async () => {},
        deleteColumns: async () => {},
        findDependentIndexes: async () => [],
        createTable: async () => {},
        updateCellBatch: async () => {},
        addColumn: async () => {},
        fetchTableData: async () => ({
            headers: [],
            rows: []
        }),
        fetchTableCount: async () => 0,
        fetchSchema: async () => ({
            tables: [],
            views: [],
            indexes: []
        }),
        getTableInfo: async () => [],
        getPragmas: async () => ({}),
        setPragma: async () => {},
        ping: async () => true,
        writeToFile: async () => {}
    };
    return Object.assign(operations, overrides);
}

describe('serializeOperations', () => {
    it('runs overlapping public operations one at a time in FIFO order', async () => {
        const events: string[] = [];
        const firstStarted = createDeferred<void>();
        const releaseFirst = createDeferred<void>();
        const raw = createOperations({
            engineKind: Promise.resolve('native'),
            executeQuery: async (sql: string): Promise<QueryResultSet[]> => {
                events.push(`start:${sql}`);
                if (sql === 'first') {
                    firstStarted.resolve();
                    await releaseFirst.promise;
                }
                events.push(`end:${sql}`);
                return [];
            }
        });
        const dispose = () => {
            events.push('dispose');
        };
        Object.defineProperty(raw, Symbol.dispose, {
            configurable: true,
            value: dispose
        });

        const wrapped = serializeOperations(raw);

        assert.strictEqual(wrapped.engineKind, raw.engineKind);
        assert.strictEqual((wrapped as DatabaseOperations & { [Symbol.dispose]: () => void })[Symbol.dispose], dispose);

        const first = wrapped.executeQuery('first');
        await firstStarted.promise;
        const second = wrapped.executeQuery('second');
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));

        assert.deepStrictEqual(events, ['start:first']);

        releaseFirst.resolve();
        await Promise.all([first, second]);

        assert.deepStrictEqual(events, [
            'start:first',
            'end:first',
            'start:second',
            'end:second'
        ]);
    });

    it('releases the operation lock after a public operation throws', async () => {
        const events: string[] = [];
        const raw = createOperations({
            executeQuery: async (sql: string): Promise<QueryResultSet[]> => {
                events.push(sql);
                if (sql === 'first') {
                    throw new Error('boom');
                }
                return [];
            }
        });
        const wrapped = serializeOperations(raw);

        await assert.rejects(() => wrapped.executeQuery('first'), /boom/);
        await wrapped.executeQuery('second');

        assert.deepStrictEqual(events, ['first', 'second']);
    });
});
