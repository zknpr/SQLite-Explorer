import { state } from './state.js';
import { submitDelete } from './crud.js';
import { clearSelection } from './grid-selection.js';
import { onSelectAllClick } from './grid-actions.js';
import {
    copyCellsToClipboard,
    copySelectedRowsToClipboard,
    clearSelectedCellValues
} from './clipboard.js';

function hasActiveTextEditor() {
    const tagName = document.activeElement?.tagName;
    return state.editingCellInfo || tagName === 'INPUT' || tagName === 'TEXTAREA';
}

/** Register shortcuts shared by the VS Code viewer and standalone web demo. */
export function setupGlobalShortcuts() {
    document.addEventListener('keydown', async event => {
        if (event.key === 'Escape') {
            if (!state.editingCellInfo && !document.querySelector('.modal-overlay:not(.hidden)')) {
                clearSelection();
            }
        }

        if ((event.metaKey || event.ctrlKey) && event.key === 'c') {
            if (hasActiveTextEditor()) return;

            if (state.selectedCells.length > 0) {
                event.preventDefault();
                await copyCellsToClipboard();
            } else if (state.selectedRowIds.size > 0) {
                event.preventDefault();
                await copySelectedRowsToClipboard();
            }
        }

        if ((event.metaKey || event.ctrlKey) && event.key === 'a') {
            // Selecting all during a reload would capture row ids from the stale,
            // about-to-be-replaced result set.
            if (state.isGridReloading || hasActiveTextEditor()) return;

            if (state.selectedTable) {
                event.preventDefault();
                onSelectAllClick(event);
            }
        }

        if ((event.metaKey || event.ctrlKey) &&
            (event.key === 'Delete' || event.key === 'Backspace')) {
            // Deleting during a reload would act on stale row/column/cell state.
            if (state.isGridReloading || hasActiveTextEditor()) return;

            if (state.selectedTable && state.selectedTableType === 'table') {
                event.preventDefault();
                if (state.selectedColumns.size > 0 || state.selectedRowIds.size > 0) {
                    await submitDelete();
                } else if (state.selectedCells.length > 0) {
                    await clearSelectedCellValues();
                }
            }
        }
    });
}
