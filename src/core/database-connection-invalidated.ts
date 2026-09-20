import { DatabaseFileChangedError, isDatabaseFileChangedError } from './database-file-changed';

/** A failed native cleanup left transaction state unsafe for further operations. */
export class DatabaseTransactionRecoveryError extends Error {
    readonly code = 'SQLITE_EXPLORER_TRANSACTION_RECOVERY_FAILED';

    constructor(readonly context: string, options?: ErrorOptions) {
        super(
            'The native database transaction could not be recovered safely. '
            + 'Use Reload Database to reopen it. The previous undo/redo history has been invalidated.',
            options
        );
        this.name = 'DatabaseTransactionRecoveryError';
    }
}

export type DatabaseConnectionInvalidatedError = DatabaseFileChangedError | DatabaseTransactionRecoveryError;

export function isDatabaseConnectionInvalidatedError(error: unknown): error is DatabaseConnectionInvalidatedError {
    return isDatabaseFileChangedError(error)
        || (error instanceof Error
            && 'code' in error
            && error.code === 'SQLITE_EXPLORER_TRANSACTION_RECOVERY_FAILED');
}
