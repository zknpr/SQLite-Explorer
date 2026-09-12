import { state } from './state.js';
import { backendApi } from './api.js';
import { updateStatus } from './ui.js';

export const LARGE_CHANGE_WARNING_THRESHOLD = 1000;

/** Bind approval to the database/table generation shown before the dialog. */
export async function confirmLargeChange(itemCount, unit) {
    if (itemCount <= LARGE_CHANGE_WARNING_THRESHOLD) return true;
    const table = state.selectedTable;
    const connection = state.connectionGeneration;
    const content = state.contentGeneration;
    if (!(await backendApi.confirmLargeChanges(itemCount, unit))) {
        updateStatus('Change cancelled');
        return false;
    }
    if (state.selectedTable !== table || state.selectedTableType !== 'table'
        || state.connectionGeneration !== connection || state.contentGeneration !== content
        || state.isReadOnly || !state.isDbConnected) {
        updateStatus('Change cancelled because the database or table changed');
        return false;
    }
    return true;
}
