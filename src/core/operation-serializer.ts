import type { DatabaseOperations } from './types';

const passthroughSymbols = new Set<PropertyKey>([
    Symbol.dispose,
    Symbol.asyncDispose
]);

let readSnapshotSequence = 0;

async function executeReadSnapshot<T>(
    operations: DatabaseOperations,
    operation: (snapshotOperations: DatabaseOperations) => Promise<T>
): Promise<T> {
    const savepoint = `sqlite_explorer_read_snapshot_${++readSnapshotSequence}`;
    await operations.executeQuery(`SAVEPOINT ${savepoint}`);
    try {
        const result = await operation(operations);
        await operations.executeQuery(`RELEASE ${savepoint}`);
        return result;
    } catch (primaryError) {
        const cleanupErrors: unknown[] = [];
        try {
            await operations.executeQuery(`ROLLBACK TO ${savepoint}`);
        } catch (error) {
            cleanupErrors.push(error);
        }
        try {
            await operations.executeQuery(`RELEASE ${savepoint}`);
        } catch (error) {
            cleanupErrors.push(error);
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError(
                [primaryError, ...cleanupErrors],
                'Read snapshot failed and its SQLite savepoint could not be released cleanly'
            );
        }
        throw primaryError;
    }
}

/** Run against one snapshot even when the caller has a bare, unserialized engine. */
export function runReadSnapshot<T>(
    operations: DatabaseOperations,
    operation: (snapshotOperations: DatabaseOperations) => Promise<T>
): Promise<T> {
    if (operations.runReadSnapshot) {
        return operations.runReadSnapshot(operation);
    }
    return executeReadSnapshot(operations, operation);
}

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
            if (property === 'runReadSnapshot') {
                if (!wrappedMethods.has(property)) {
                    wrappedMethods.set(property, <T>(
                        operation: (snapshotOperations: DatabaseOperations) => Promise<T>
                    ) => runSerialized(() => executeReadSnapshot(target, operation)));
                }
                return wrappedMethods.get(property);
            }
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
