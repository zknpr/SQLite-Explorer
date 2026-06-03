import type { DatabaseOperations } from './types';

const passthroughSymbols = new Set<PropertyKey>([
    Symbol.dispose,
    Symbol.asyncDispose
]);

/**
 * Native worker ops and WASM in-process ops are already serial at their boundary;
 * this lock keeps each public operation's internal multi-step sequence
 * (json_patch undo read->compute->write) contiguous against concurrent edits.
 */
export function serializeOperations(ops: DatabaseOperations): DatabaseOperations {
    let tail: Promise<void> = Promise.resolve();
    const wrappedMethods = new Map<PropertyKey, unknown>();

    const runSerialized = async <T>(operation: () => Promise<T>): Promise<T> => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>(resolve => {
            release = resolve;
        });

        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    };

    return new Proxy(ops as DatabaseOperations & Record<PropertyKey, unknown>, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (passthroughSymbols.has(property) || typeof value !== 'function') {
                return value;
            }

            if (!wrappedMethods.has(property)) {
                wrappedMethods.set(property, (...args: unknown[]) => (
                    runSerialized(() => value.apply(target, args))
                ));
            }

            return wrappedMethods.get(property);
        }
    }) as DatabaseOperations;
}
