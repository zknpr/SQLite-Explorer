/** The open native handle no longer represents the file selected by the user. */
export class DatabaseFileChangedError extends Error {
    readonly code = 'SQLITE_EXPLORER_DATABASE_FILE_CHANGED';

    constructor(options?: ErrorOptions) {
        super(
            'The database file was replaced, moved, deleted, or became unavailable outside SQLite Explorer. '
            + 'Use Reload Database to open the current file. The previous undo/redo history has been invalidated.',
            options
        );
        this.name = 'DatabaseFileChangedError';
    }
}

export function isDatabaseFileChangedError(error: unknown): error is DatabaseFileChangedError {
    return error instanceof Error
        && 'code' in error
        && error.code === 'SQLITE_EXPLORER_DATABASE_FILE_CHANGED';
}
