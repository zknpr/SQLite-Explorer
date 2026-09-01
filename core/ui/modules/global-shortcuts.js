import { state } from './state.js';
import { submitDelete } from './crud.js';
import { clearSelection } from './grid-selection.js';
import { applyCurrentFilter, onSelectAllClick } from './grid-actions.js';
import { resetMatchNav } from './match-nav.js';
import {
    copyCellsToClipboard,
    copySelectedRowsToClipboard,
    clearSelectedCellValues
} from './clipboard.js';

function hasActiveTextEditor(eventTarget = null) {
    const activeTagName = document.activeElement?.tagName;
    const targetTagName = eventTarget?.tagName;
    return state.editingCellInfo
        || activeTagName === 'INPUT'
        || activeTagName === 'TEXTAREA'
        || targetTagName === 'INPUT'
        || targetTagName === 'TEXTAREA'
        || eventTarget?.isContentEditable === true;
}

function hasOpenModal() {
    return !!document.querySelector(
        '.modal-overlay:not(.hidden), .cell-preview-modal:not(.hidden)'
    );
}

function isGridNavigationContext(target) {
    const tagName = target?.tagName;
    if (tagName === 'BUTTON' || tagName === 'SELECT' || tagName === 'A') return false;
    return !!target?.closest?.('#gridContainer')
        || state.lastSelectedCell !== null
        || state.selectedCells.length > 0
        || state.selectedRowIds.size > 0
        || state.selectedColumns.size > 0;
}

/** Register shortcuts shared by the VS Code viewer and standalone web demo. */
export function setupGlobalShortcuts() {
    document.addEventListener('keydown', async event => {
        const shortcutKey = typeof event.key === 'string' ? event.key.toLowerCase() : '';
        const modalOpen = hasOpenModal();
        if (event.key === 'Escape') {
            if (!state.editingCellInfo && !modalOpen) {
                const dismissMatchNavigation = !!event.target?.closest?.(
                    '#gridContainer, .filter-group'
                ) || isGridNavigationContext(event.target);
                clearSelection();
                if (dismissMatchNavigation) resetMatchNav();
            }
        }

        // Grid cells are not native focus controls, so after a cell click the
        // key event can target <body> rather than bubble through gridContainer.
        // Handle that path here while filter inputs keep their own Enter handler.
        if (event.key === 'Enter'
            && !event.defaultPrevented
            && !event.isComposing
            && !event.metaKey
            && !event.ctrlKey
            && !event.altKey
            && !modalOpen
            && !hasActiveTextEditor(event.target)
            && isGridNavigationContext(event.target)) {
            const pending = applyCurrentFilter(event.shiftKey ? -1 : 1);
            if (pending) {
                event.preventDefault();
                await pending;
            }
        }

        if ((event.metaKey || event.ctrlKey) && shortcutKey === 'c') {
            if (modalOpen || hasActiveTextEditor(event.target)) return;

            if (state.selectedCells.length > 0) {
                event.preventDefault();
                await copyCellsToClipboard();
            } else if (state.selectedRowIds.size > 0) {
                event.preventDefault();
                await copySelectedRowsToClipboard();
            }
        }

        if ((event.metaKey || event.ctrlKey) && shortcutKey === 'a') {
            // Selecting all during a reload would capture row ids from the stale,
            // about-to-be-replaced result set.
            if (modalOpen || state.isGridReloading || hasActiveTextEditor(event.target)) return;

            if (state.selectedTable) {
                event.preventDefault();
                onSelectAllClick(event);
            }
        }

        if ((event.metaKey || event.ctrlKey) &&
            (event.key === 'Delete' || event.key === 'Backspace')) {
            // Deleting during a reload would act on stale row/column/cell state.
            if (modalOpen || state.isGridReloading || hasActiveTextEditor(event.target)) return;

            if (state.isReadOnly) {
                if (state.selectedTable && state.selectedTableType === 'table') {
                    event.preventDefault();
                }
                return;
            }

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
