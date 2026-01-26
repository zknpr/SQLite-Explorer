/**
 * Cell Editing and Preview Logic
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { escapeHtml, validateRowId, escapeIdentifier, formatCellValue } from './utils.js';
import { updateStatus } from './ui.js';
import { renderDataGrid, loadTableData, updateSelectionStates, clearSelection } from './grid.js';
import { getRowDataOffset, getCellValue } from './data-utils.js';

// ================================================================
// INLINE EDITING
// ================================================================

export function startCellEdit(rowIdx, colIdx, rowId) {
    if (state.selectedTableType !== 'table') {
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

export function onCellInputKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
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
    if (state.isSavingCell) return;
    if (!state.editingCellInfo || !state.activeCellInput) return;

    const { rowIdx, colIdx, rowId, columnName, originalValue } = state.editingCellInfo;
    const newValue = state.activeCellInput.value;

    const origStr = originalValue === null ? '' : String(originalValue);
    if (newValue === origStr) {
        cancelCellEdit();
        state.selectedCells = [];
        state.lastSelectedCell = null;
        updateSelectionStates();
        return;
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

        // Update local grid data
        state.gridData[rowIdx][colIdx + getRowDataOffset()] = valueToSave;

        cleanupCellEdit();

        // Update UI immediately (preserves scroll)
        // refreshContent RPC will handle final consistency check
        updateCellDom(rowIdx, colIdx, valueToSave);

        state.selectedCells = [];
        state.lastSelectedCell = null;
        updateSelectionStates();

        updateStatus('Saved');

    } catch (err) {
        console.error('Save failed:', err);
        // On error, keep editing so user can fix
        let errorMessage = err.message || String(err);
        // ... error message formatting ...
        updateStatus(`Save failed: ${errorMessage}`);
    } finally {
        state.isSavingCell = false;
    }
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

    // We need to determine if it's text, json, blob, etc.
    // For now passing value as is.
    // We pass metadata to help extension determine extension/language.

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

    const isReadonly = state.selectedTableType !== 'table';
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
    // Keydown listener for shortcuts
    textarea.onkeydown = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeCellPreview();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            saveCellPreview();
        }
    };
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

    // Clean up event listeners?
    // Usually fine as elements persist and we overwrite oninput/onkeydown next open
}

export async function saveCellPreview() {
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
    const displayValue = formatCellValue(value, col?.type, state.dateFormat, col?.name);
    const hasContent = value !== null && value !== undefined && !(value instanceof Uint8Array);

    let html = `<span class="cell-text">${displayValue}</span>`;
    if (hasContent) {
        html += `<span class="expand-icon codicon codicon-link-external" title="View full content"></span>`;
    }

    cellEl.innerHTML = html;

    // Check overflow
    const textSpan = cellEl.querySelector('.cell-text');
    if (textSpan) {
        const hasOverflow = textSpan.scrollWidth > textSpan.clientWidth;
        cellEl.classList.toggle('has-overflow', hasOverflow);
    }
}
