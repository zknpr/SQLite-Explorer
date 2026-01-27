import type { DatabaseDocument } from './databaseModel';

/** Global registry for document lookup */
export const DocumentRegistry = new Map<string, DatabaseDocument>();
