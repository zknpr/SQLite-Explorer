/**
 * Cell Editing and Preview Logic
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { validateRowId, formatCellValueAsText } from './utils.js';
import { updateStatus } from './ui.js';
import { updateSelectionStates, clearSelection } from './grid-selection.js';
import { loadTableData } from './grid-data.js';
import {
    getRowDataOffset,
    getCellValue,
    getRowId,
    getOrderedColumnIndices,
    getOrderedRowIndices
} from './data-utils.js';
import { BlobInspector } from './blob-inspector.js';
import { handleTextareaTab, resetTextareaTabFocusEscape } from './text-editor.js';
import { revealGridCell } from './grid-reveal.js';
import { resetMatchNav } from './match-nav.js';

let blobInspector;

export function initEdit() {
    blobInspector = new BlobInspector();

    // Cell Preview Modal
    document.getElementById('btnCloseCellPreview')?.addEventListener('click', closeCellPreview);
    document.getElementById('formatJsonBtn')?.addEventListener('click', formatCellPreviewJson);
    document.getElementById('compactJsonBtn')?.addEventListener('click', compactCellPreviewJson);
    document.getElementById('wrapTextBtn')?.addEventListener('click', toggleCellPreviewWrap);
    document.getElementById('openInVsCodeBtn')?.addEventListener('click', openCellInVsCode);
    document.getElementById('btnCancelCellPreview')?.addEventListener('click', closeCellPreview);
    document.getElementById('cellPreviewSaveBtn')?.addEventListener('click', saveCellPreview);
    const previewTextarea = document.getElementById('cellPreviewTextarea');
    previewTextarea?.addEventListener('keydown', onCellPreviewKeydown);
    previewTextarea?.addEventListener('blur', () => resetTextareaTabFocusEscape(previewTextarea));
}

// ================================================================
// INLINE EDITING
// ================================================================

export function startCellEdit(rowIdx, colIdx, rowId) {
    if (state.isReadOnly || state.selectedTableType !== 'table') {
        updateStatus('Views are read-only');
        return;
    }

    if (state.editingCellInfo) {
        // Already editing?
        if (state.editingCellInfo.rowIdx === rowIdx && state.editingCellInfo.colIdx === colIdx) {
            return;
        }
        cancelCellEdit();
    }

    const column = state.tableColumns[colIdx];
    if (!column) return;

    // Find the cell element
    const cellEl = document.getElementById(`cell-${rowIdx}-${colIdx}`);
    if (!cellEl) return;

    // Browser focus scrolling ignores sticky grid overlays; reveal the cell in
    // the unpinned viewport before replacing it with the inline textarea.
    revealGridCell(cellEl);

    const row = state.gridData[rowIdx];
    const value = getCellValue(row, colIdx);

    // Don't edit BLOBs inline
    if (value instanceof Uint8Array) {
        openCellPreview(rowIdx, colIdx, rowId);
        return;
    }

    // Auto-open JSON in modal
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try {
                JSON.parse(trimmed);
                openCellPreview(rowIdx, colIdx, rowId);
                return;
            } catch (e) {
                // Not valid JSON, continue to inline edit
            }
        }
    }

    state.editingCellInfo = {
        rowIdx,
        colIdx,
        rowId,
        columnName: column.name,
        originalValue: value
    };

    // Replace cell content with input
    const currentText = value === null ? '' : String(value);

    cellEl.innerHTML = '';
    cellEl.classList.add('editing');

    // Create input element
    const input = document.createElement('textarea');
    input.className = 'cell-input';
    input.value = currentText;
    input.spellcheck = false;

    cellEl.appendChild(input);
    input.focus();

    state.activeCellInput = input;

    // Event listeners
    input.addEventListener('keydown', onCellInputKeydown);
    input.addEventListener('blur', onCellInputBlur);
    input.addEventListener('click', e => e.stopPropagation());

    state.isTransitioningEdit = true;
    setTimeout(() => { state.isTransitioningEdit = false; }, 100);
}

export async function onCellInputKeydown(event) {
    if (event.key === 'Tab') {
        event.preventDefault();
        await saveCellEditAndMove(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        saveCellEdit();
    } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelCellEdit();
    }
}

export function onCellInputBlur() {
    // Small delay to allow clicking on other elements (like save button if we had one)
    setTimeout(() => {
        if (state.editingCellInfo) {
            saveCellEdit();
        }
    }, 100);
}

export async function saveCellEdit() {
    if (state.isSavingCell) return false;
    if (!state.editingCellInfo || !state.activeCellInput) return false;

    const { rowIdx, colIdx, rowId, columnName, originalValue } = state.editingCellInfo;
    const newValue = state.activeCellInput.value;

    const origStr = originalValue === null ? '' : String(originalValue);
    if (newValue === origStr) {
        cancelCellEdit();
        state.selectedCells = [];
        state.lastSelectedCell = null;
        updateSelectionStates();
        return true;
    }

    const column = state.tableColumns[colIdx];
    const isNotNull = column && column.notnull === 1;

    let valueToSave;
    if (newValue === '') {
        if (isNotNull) {
            valueToSave = '';
        } else {
            valueToSave = null;
        }
    } else if (!isNaN(Number(newValue)) && newValue.trim() !== '') {
        valueToSave = Number(newValue);
    } else {
        valueToSave = newValue;
    }

    try {
        state.isSavingCell = true;
        updateStatus('Saving...');

        await backendApi.updateCell(state.selectedTable, validateRowId(rowId), columnName, valueToSave, originalValue);

        // A broadcast refresh can reorder gridData before this RPC resolves.
        // Update the row by its stable SQLite identity, never by the stale DOM index.
        const currentRowIdx = state.gridData.findIndex((row, index) => (
            getRowId(row, index) === rowId
        ));
        const currentColIdx = state.tableColumns.findIndex(column => column.name === columnName);
        if (currentRowIdx >= 0 && currentColIdx >= 0) {
            state.gridData[currentRowIdx][currentColIdx + getRowDataOffset()] = valueToSave;
        }

        cleanupCellEdit();

        // Update UI immediately (preserves scroll)
        // refreshContent RPC will handle final consistency check
        if (currentRowIdx >= 0 && currentColIdx >= 0) {
            updateCellDom(currentRowIdx, currentColIdx, valueToSave);
        }
        if (state.matchNav.scope !== null) resetMatchNav();

        state.selectedCells = [];
        state.lastSelectedCell = null;
        updateSelectionStates();

        updateStatus('Saved');
        return true;

    } catch (err) {
        console.error('Save failed:', err);
        // On error, the cell remains in edit mode to allow user corrections
        let errorMessage = err.message || String(err);
        // ... error message formatting ...
        updateStatus(`Save failed: ${errorMessage}`);
        return false;
    } finally {
        state.isSavingCell = false;
    }
}

async function saveCellEditAndMove(direction) {
    if (!state.editingCellInfo) return;
    const { rowIdx, colIdx, originalValue } = state.editingCellInfo;
    const submittedValue = state.activeCellInput?.value;

    // Pin traversal to the pre-commit rendered ordering. A sort/filter-changing
    // update may reorder gridData while the old DOM remains mounted, so indices
    // captured after the RPC would identify a different row.
    const orderedRowIndices = getOrderedRowIndices();
    const orderedColumnIndices = getOrderedColumnIndices();
    const rowCount = orderedRowIndices.length;
    const columnCount = orderedColumnIndices.length;
    const cellCount = rowCount * columnCount;
    const renderedRowIdx = orderedRowIndices.indexOf(rowIdx);
    const renderedColIdx = orderedColumnIndices.indexOf(colIdx);
    let targetRowId;
    let targetColumnName;
    if (cellCount > 0 && renderedRowIdx >= 0 && renderedColIdx >= 0) {
        const currentIndex = renderedRowIdx * columnCount + renderedColIdx;
        const nextIndex = (currentIndex + direction + cellCount) % cellCount;
        const targetRowIdx = orderedRowIndices[Math.floor(nextIndex / columnCount)];
        const targetColIdx = orderedColumnIndices[nextIndex % columnCount];
        const targetRow = state.gridData[targetRowIdx];
        const targetColumn = state.tableColumns[targetColIdx];
        if (targetRow && targetColumn) {
            targetRowId = getRowId(targetRow, targetRowIdx);
            targetColumnName = targetColumn.name;
        }
    }

    if (!await saveCellEdit()) return;
    if (targetRowId === undefined || targetColumnName === undefined) return;

    const originalText = originalValue === null ? '' : String(originalValue);
    if (submittedValue !== originalText) {
        // recordExternalModification posts refreshContent before the update RPC
        // response, but that broadcast is not awaited. Start an authoritative
        // post-commit reload after the editor is cleaned up; its load token
        // supersedes any still-running broadcast refresh and it renders the row
        // indices that startCellEdit will use below.
        if (await loadTableData(false) !== true) return;
    }

    const nextRowIdx = state.gridData.findIndex((row, index) => (
        getRowId(row, index) === targetRowId
    ));
    const nextColIdx = state.tableColumns.findIndex(column => column.name === targetColumnName);
    if (nextRowIdx < 0 || nextColIdx < 0) return;
    startCellEdit(nextRowIdx, nextColIdx, targetRowId);
}

export function cancelCellEdit() {
    if (!state.editingCellInfo) return;
    const { rowIdx, colIdx, originalValue } = state.editingCellInfo;
    cleanupCellEdit();
    updateCellDom(rowIdx, colIdx, originalValue);
    clearSelection();
}

function cleanupCellEdit() {
    if (state.activeCellInput) {
        state.activeCellInput.removeEventListener('keydown', onCellInputKeydown);
        state.activeCellInput.removeEventListener('blur', onCellInputBlur);
        state.activeCellInput = null;
    }
    state.editingCellInfo = null;
}

// ================================================================
// CELL PREVIEW MODAL
// ================================================================


export async function openCellInVsCode() {
    if (!state.cellPreviewInfo) return;

    const { rowIdx, colIdx, rowId, columnName, originalValue } = state.cellPreviewInfo;
    const column = state.tableColumns[colIdx];

    // We get the webview id from dataset if available or assume 'default'
    const webviewId = document.getElementById('vscode-env')?.dataset.webviewId || 'default';

    try {
        updateStatus('Opening in VS Code...');
        // Close the preview modal as we are moving to VS Code editor
        closeCellPreview();

        await backendApi.openCellEditor(
            { table: state.selectedTable, name: '' }, // dbParams
            validateRowId(rowId),
            columnName,
            {}, // colTypes
            {
                value: originalValue,
                type: { type: column.type }, // Pass column type
                webviewId,
                rowCount: state.gridData.length
            }
        );
        updateStatus('Opened in VS Code');
    } catch (err) {
        console.error('Failed to open in VS Code:', err);
        updateStatus(`Error: ${err.message}`);
    }
}

export function openCellPreview(rowIdx, colIdx, rowId) {
    if (state.editingCellInfo) {
        cancelCellEdit();
    }

    const column = state.tableColumns[colIdx];
    if (!column) return;

    const row = state.gridData[rowIdx];
    if (!row) return;

    const value = getCellValue(row, colIdx);

    // Delegate BLOB inspection
    if (value instanceof Uint8Array) {
        if (blobInspector) {
            blobInspector.inspect(value, rowId, column.name, rowIdx, colIdx);
        }
        return;
    }

    state.cellPreviewInfo = {
        rowIdx,
        colIdx,
        rowId,
        columnName: column.name,
        originalValue: value
    };

    const modal = document.getElementById('cellPreviewModal');
    const columnNameEl = document.getElementById('cellPreviewColumnName');
    const typeBadgeEl = document.getElementById('cellPreviewTypeBadge');
    const textarea = document.getElementById('cellPreviewTextarea');
    resetTextareaTabFocusEscape(textarea);
    const readonlyBadgeEl = document.getElementById('cellPreviewReadonlyBadge');
    const saveBtnEl = document.getElementById('cellPreviewSaveBtn');
    const wrapBtnEl = document.getElementById('wrapTextBtn');

    columnNameEl.textContent = column.name;
    typeBadgeEl.textContent = column.type || 'TEXT';

    let displayValue = '';
    if (value === null || value === undefined) {
        displayValue = '';
    } else if (value instanceof Uint8Array) {
        displayValue = '[BLOB: ' + Array.from(value).map(b => b.toString(16).padStart(2, '0')).join(' ') + ']';
    } else {
        displayValue = String(value);
    }

    textarea.value = displayValue;

    const isReadonly = state.isReadOnly || state.selectedTableType !== 'table';
    textarea.readOnly = isReadonly;
    if (isReadonly) {
        textarea.classList.add('readonly');
        readonlyBadgeEl.style.display = 'inline';
        saveBtnEl.style.display = 'none';
    } else {
        textarea.classList.remove('readonly');
        readonlyBadgeEl.style.display = 'none';
        saveBtnEl.style.display = 'inline-block';
    }

    updateCellPreviewCharCount();

    textarea.style.whiteSpace = state.cellPreviewWrapEnabled ? 'pre-wrap' : 'pre';
    textarea.style.overflowX = state.cellPreviewWrapEnabled ? 'hidden' : 'auto';
    wrapBtnEl.classList.toggle('active', state.cellPreviewWrapEnabled);

    modal.classList.remove('hidden');
    textarea.focus();

    // Attach listener for char count
    textarea.oninput = updateCellPreviewCharCount;
}

export function onCellPreviewKeydown(event) {
    if (handleTextareaTab(event)) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        closeCellPreview();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        saveCellPreview();
    }
}

function updateCellPreviewCharCount() {
    const textarea = document.getElementById('cellPreviewTextarea');
    const charCountEl = document.getElementById('cellPreviewCharCount');
    const len = textarea.value.length;
    charCountEl.textContent = `${len.toLocaleString()} character${len !== 1 ? 's' : ''}`;
}

export function closeCellPreview() {
    const modal = document.getElementById('cellPreviewModal');
    modal.classList.add('hidden');
    state.cellPreviewInfo = null;
}

export async function saveCellPreview() {
    if (state.isReadOnly) {
        updateStatus('Document is read-only');
        return;
    }
    if (!state.cellPreviewInfo) return;
    if (state.selectedTableType !== 'table') {
        updateStatus('Views are read-only');
        return;
    }

    const { rowIdx, colIdx, rowId, columnName, originalValue } = state.cellPreviewInfo;
    const textarea = document.getElementById('cellPreviewTextarea');
    const newValue = textarea.value;

    const origStr = originalValue === null ? '' : String(originalValue);
    if (newValue === origStr) {
        closeCellPreview();
        state.selectedCells = [];
        state.lastSelectedCell = null;
        updateSelectionStates();
        return;
    }

    const column = state.tableColumns[colIdx];
    const isNotNull = column && column.notnull === 1;

    let valueToSave;
    if (newValue === '') {
        valueToSave = isNotNull ? '' : null;
    } else if (!isNaN(Number(newValue)) && newValue.trim() !== '') {
        valueToSave = Number(newValue);
    } else {
        valueToSave = newValue;
    }

    try {
        updateStatus('Saving...');
        await backendApi.updateCell(state.selectedTable, validateRowId(rowId), columnName, valueToSave, originalValue);

        state.gridData[rowIdx][colIdx + getRowDataOffset()] = valueToSave;

        closeCellPreview();
        updateCellDom(rowIdx, colIdx, valueToSave);
        if (state.matchNav.scope !== null) resetMatchNav();

        state.selectedCells = [];
        state.lastSelectedCell = null;
        updateSelectionStates();

        updateStatus('Saved');
    } catch (err) {
        console.error('Save failed:', err);
        updateStatus(`Save failed: ${err.message}`);
    }
}

export function formatCellPreviewJson() {
    const textarea = document.getElementById('cellPreviewTextarea');
    try {
        const parsed = JSON.parse(textarea.value);
        textarea.value = JSON.stringify(parsed, null, 2);
        updateCellPreviewCharCount();
    } catch (e) {
        updateStatus('Content is not valid JSON');
    }
}

export function compactCellPreviewJson() {
    const textarea = document.getElementById('cellPreviewTextarea');
    try {
        const parsed = JSON.parse(textarea.value);
        textarea.value = JSON.stringify(parsed);
        updateCellPreviewCharCount();
    } catch (e) {
        updateStatus('Content is not valid JSON');
    }
}

export function toggleCellPreviewWrap() {
    state.cellPreviewWrapEnabled = !state.cellPreviewWrapEnabled;
    const textarea = document.getElementById('cellPreviewTextarea');
    const wrapBtnEl = document.getElementById('wrapTextBtn');

    textarea.style.whiteSpace = state.cellPreviewWrapEnabled ? 'pre-wrap' : 'pre';
    textarea.style.overflowX = state.cellPreviewWrapEnabled ? 'hidden' : 'auto';
    wrapBtnEl.classList.toggle('active', state.cellPreviewWrapEnabled);
}

function updateCellDom(rowIdx, colIdx, value) {
    const cellEl = document.getElementById(`cell-${rowIdx}-${colIdx}`);
    if (!cellEl) return;

    cellEl.classList.remove('editing');

    if (value === null || value === undefined) {
        cellEl.classList.add('null-value');
    } else {
        cellEl.classList.remove('null-value');
    }

    const col = state.tableColumns[colIdx];
    const displayValue = formatCellValueAsText(value, col?.type, state.dateFormat, col?.name);
    const hasContent = value !== null && value !== undefined && !(value instanceof Uint8Array);

    // Use DOM creation with textContent for XSS prevention (defense-in-depth)
    cellEl.textContent = '';
    const textSpan = document.createElement('span');
    textSpan.className = 'cell-text';
    textSpan.textContent = displayValue;
    cellEl.appendChild(textSpan);

    if (hasContent) {
        const expandIcon = document.createElement('span');
        expandIcon.className = 'expand-icon codicon codicon-link-external';
        expandIcon.title = 'View full content';
        cellEl.appendChild(expandIcon);
    }

    // Check overflow
    const hasOverflow = textSpan.scrollWidth > textSpan.clientWidth;
    cellEl.classList.toggle('has-overflow', hasOverflow);
}
