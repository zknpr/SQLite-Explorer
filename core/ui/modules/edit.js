/**
 * Cell Editing and Preview Logic
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { getErrorMessage, validateRowId, formatCellValueAsText, parseGridInputValue } from './utils.js';
import { updateStatus } from './ui.js';
import { updateSelectionStates, clearSelection } from './grid-selection.js';
import { loadTableData } from './grid-data.js';
import { noteCellValuesChanged } from './count-cache.js';
import {
    getRowDataOffset,
    getCellValue,
    getCellValueForDisplay,
    clearExactIntegerText,
    clearOversizedCellMetadata,
    getOversizedCellMetadata,
    getReadOnlyRowReason,
    getCellMutationBlockReason,
    getRowId,
    resolveDisplayedCell,
    remapDisplayedRowIdentity,
    getOrderedColumnIndices,
    getOrderedRowIndices
} from './data-utils.js';
import { BlobInspector } from './blob-inspector.js';
import { handleTextareaTab, resetTextareaTabFocusEscape } from './text-editor.js';
import { revealGridCell } from './grid-reveal.js';
import { resetMatchNav } from './match-nav.js';
import { ensureGridRowMaterialized, scheduleVirtualGridUpdate } from './grid-render.js';
import { closeModal, openModal } from './modals.js';

let blobInspector;
let isSavingCellPreview = false;

export function initEdit() {
    blobInspector = new BlobInspector();

    // Cell Preview Modal
    document.getElementById('btnCloseCellPreview')?.addEventListener('click', closeCellPreview);
    document.getElementById('formatJsonBtn')?.addEventListener('click', formatCellPreviewJson);
    document.getElementById('compactJsonBtn')?.addEventListener('click', compactCellPreviewJson);
    document.getElementById('wrapTextBtn')?.addEventListener('click', toggleCellPreviewWrap);
    document.getElementById('openInVsCodeBtn')?.addEventListener('click', openCellInVsCode);
    document.getElementById('cellPreviewEmptyBtn')?.addEventListener('click', setCellPreviewEmpty);
    document.getElementById('cellPreviewNullBtn')?.addEventListener('click', setCellPreviewNull);
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

    const mutationBlockReason = getCellMutationBlockReason(rowIdx, colIdx);
    if (mutationBlockReason) {
        updateStatus(mutationBlockReason);
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

    // The target row may be outside the virtualized window (e.g. Tab from the
    // page's last cell wraps to row 0 while scrolled to the bottom). Scroll it
    // into the window first; no-op on fully rendered pages.
    ensureGridRowMaterialized(rowIdx);

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
        // Snapshot of the full save target, taken when the edit starts. Every
        // commit path resolves its target from this snapshot — never from live
        // selection state. The blur commit is deferred (~100ms) and can fire
        // after a sidebar table switch; resolving the table then would aim the
        // UPDATE at a same-named column in the newly selected table.
        table: state.selectedTable,
        tableType: state.selectedTableType,
        column,
        identityKind: state.selectedTableIdentity?.kind ?? null,
        originalValue: value,
        originalText: String(getCellValueForDisplay(row, rowIdx, colIdx) ?? '')
    };

    // Replace cell content with input
    const currentText = state.editingCellInfo.originalText;

    cellEl.innerHTML = '';
    cellEl.classList.add('editing');

    // Create input element
    const input = document.createElement('textarea');
    input.className = 'cell-input';
    input.ariaLabel = `Edit ${column.name}`;
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
    const editSession = state.editingCellInfo;
    setTimeout(() => {
        // Commit only the session this blur belongs to. If it was cancelled or
        // replaced meanwhile (Escape, a new edit started), there is nothing of
        // ours left to save — calling saveCellEdit unconditionally would commit
        // the successor session out from under its own editor.
        if (editSession && state.editingCellInfo === editSession) {
            saveCellEdit();
        }
    }, 100);
}

export async function saveCellEdit() {
    if (state.isSavingCell) return false;
    if (!state.editingCellInfo || !state.activeCellInput) return false;

    const editSession = state.editingCellInfo;
    // Target and typing rules come from the snapshot taken at edit start, not
    // from live selection state: a deferred blur commit may run after the user
    // switched tables, when state.selectedTable/tableColumns already describe
    // an unrelated table.
    const {
        rowId, columnName, column, identityKind,
        originalValue, originalText, table: targetTable
    } = editSession;
    const newValue = state.activeCellInput.value;

    const origStr = originalText ?? (originalValue === null ? '' : String(originalValue));
    if (newValue === origStr) {
        cancelCellEdit();
        state.selectedCells = [];
        state.lastSelectedCell = null;
        updateSelectionStates();
        return true;
    }

    let valueToSave;
    if (newValue === '') {
        // Empty TEXT and SQL NULL have different query, constraint, trigger,
        // and application semantics. NULL is available only through an
        // explicit action; clearing an editor must preserve the empty string.
        valueToSave = '';
    } else if (!isNaN(Number(newValue)) && newValue.trim() !== '') {
        valueToSave = parseGridInputValue(
            newValue,
            column,
            identityKind === 'primaryKey'
        );
    } else {
        valueToSave = newValue;
    }

    try {
        state.isSavingCell = true;
        updateStatus('Saving...');

        const updatedRowId = await backendApi.updateCell(
            targetTable,
            validateRowId(rowId),
            columnName,
            valueToSave,
            originalValue
        );
        // The edited value may enter/leave an active filter's match set, so
        // the table's cached filtered counts are no longer trustworthy.
        noteCellValuesChanged(targetTable);

        // A broadcast refresh can reorder gridData before this RPC resolves.
        // Resolve by stable identity only if the original table is still
        // displayed. Equal rowids/column names in another table are unrelated.
        const currentCell = resolveDisplayedCell(targetTable, rowId, columnName)
            ?? (updatedRowId !== undefined
                ? resolveDisplayedCell(targetTable, updatedRowId, columnName)
                : null);
        remapDisplayedRowIdentity(targetTable, rowId, updatedRowId, currentCell);
        editSession.updatedRowId = updatedRowId;
        if (currentCell) {
            state.gridData[currentCell.rowIdx][currentCell.colIdx + getRowDataOffset()] = valueToSave;
            clearExactIntegerText(currentCell.rowIdx, currentCell.colIdx);
            clearOversizedCellMetadata(currentCell.rowIdx, currentCell.colIdx);
        }

        if (state.editingCellInfo === editSession) cleanupCellEdit();

        // Update UI immediately (preserves scroll)
        // refreshContent RPC will handle final consistency check
        if (currentCell) updateCellDom(currentCell.rowIdx, currentCell.colIdx, valueToSave);
        if (state.selectedTable !== targetTable) {
            // The write landed on the snapshot table while another table is
            // displayed, so the current view shows no trace of it — name the
            // target. The displayed grid is untouched by this write; do not
            // reload it (in VS Code the refreshContent echo refreshes any
            // panel that does show the snapshot table).
            updateStatus(`Saved to ${targetTable}.${columnName}`);
            return true;
        }

        if (state.matchNav.scope !== null) resetMatchNav();
        state.selectedCells = [];
        state.lastSelectedCell = null;
        updateSelectionStates();

        updateStatus('Saved');
        return true;

    } catch (err) {
        console.error('Save failed:', err);
        let errorMessage = getErrorMessage(err);
        // ... error message formatting ...
        // Retaining the failed session only helps while its editor textarea is
        // still there to correct the value. A table switch re-renders the grid
        // and wipes the textarea; keeping the session then would leak frozen
        // edit state with no way to resolve it (editorHoldsWindow defends the
        // virtualized window against exactly that). The isConnected !== false
        // form mirrors editorHoldsWindow: non-DOM test doubles without the
        // property count as live.
        const editorAlive = state.editingCellInfo === editSession
            && state.activeCellInput
            && state.activeCellInput.isConnected !== false;
        if (editorAlive) {
            // On error, the cell remains in edit mode to allow user corrections
            updateStatus(`Save failed: ${errorMessage}`);
        } else {
            if (state.editingCellInfo === editSession) cleanupCellEdit();
            updateStatus(`Save failed for ${targetTable}.${columnName}: ${errorMessage}`);
        }
        return false;
    } finally {
        state.isSavingCell = false;
    }
}

async function saveCellEditAndMove(direction) {
    if (!state.editingCellInfo) return;
    const editSession = state.editingCellInfo;
    // Snapshot table, for the same reason as saveCellEdit: if the selection
    // already drifted, the post-save advance below must compare against the
    // table the edit belongs to, not whatever is now selected.
    const targetTable = editSession.table;
    const { rowIdx, colIdx, originalValue, originalText } = editSession;
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
    if (state.selectedTable !== targetTable) return;
    if (targetRowId === editSession.rowId && editSession.updatedRowId !== undefined) {
        targetRowId = editSession.updatedRowId;
    }
    if (targetRowId === undefined || targetColumnName === undefined) return;

    const submittedOriginalText = originalText
        ?? (originalValue === null ? '' : String(originalValue));
    if (submittedValue !== submittedOriginalText) {
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
    // The virtualized window stays frozen while an inline edit is active so
    // the <textarea> can't be rebuilt away; catch up now in case the user
    // scrolled during the edit or a background commit replaced the page.
    scheduleVirtualGridUpdate();
}

// ================================================================
// CELL PREVIEW MODAL
// ================================================================


export async function openCellInVsCode() {
    if (!state.cellPreviewInfo) return;

    const previewSession = state.cellPreviewInfo;
    const {
        rowId, columnName, originalValue, originalText,
        table, column: sessionColumn, colIdx
    } = previewSession;
    const targetTable = table ?? state.selectedTable;
    const column = sessionColumn ?? state.tableColumns[colIdx];
    if (!targetTable) return;
    if (previewSession.readOnlyReason) {
        updateStatus(previewSession.readOnlyReason);
        return;
    }

    // We get the webview id from dataset if available or assume 'default'
    const webviewId = document.getElementById('vscode-env')?.dataset.webviewId || 'default';

    try {
        updateStatus('Opening in VS Code...');
        const result = await backendApi.openCellEditor(
            { table: targetTable, name: '' }, // dbParams
            validateRowId(rowId),
            columnName,
            {}, // colTypes
            {
                value: originalText ?? originalValue,
                type: { type: column?.type }, // Pass column type
                webviewId,
                rowCount: state.gridData.length
            }
        );
        // The user may have closed A and opened B while the host picker/editor
        // was pending. A's completion owns neither B's draft nor its status.
        if (state.cellPreviewInfo !== previewSession) return;
        if (result?.success === false) {
            updateStatus(result.message || 'External cell editing is unavailable');
            return;
        }
        // Discard the modal draft only after the host confirms that an editor opened.
        closeCellPreview();
        updateStatus(result?.mode === 'temporary-read-only'
            ? 'Opened in VS Code as a verified read-only temporary file'
            : 'Opened in VS Code');
    } catch (err) {
        console.error('Failed to open in VS Code:', err);
        if (state.cellPreviewInfo === previewSession) updateStatus(`Error: ${getErrorMessage(err)}`);
    }
}

export function openCellPreview(rowIdx, colIdx, rowId) {
    const oversizedMetadata = getOversizedCellMetadata(rowIdx, colIdx);
    if (oversizedMetadata) {
        const column = state.tableColumns[colIdx];
        const row = state.gridData[rowIdx];
        if (!column || !row || !blobInspector) {
            updateStatus(
                `Bounded preview only — ${oversizedMetadata.byteLength.toLocaleString()} bytes ` +
                `(${oversizedMetadata.storageClass.toUpperCase()})`
            );
            return;
        }
        return blobInspector.inspectOversized(
            getCellValue(row, colIdx),
            oversizedMetadata,
            rowId,
            column.name,
            rowIdx,
            colIdx
        );
    }

    if (state.editingCellInfo) {
        cancelCellEdit();
    }

    const column = state.tableColumns[colIdx];
    if (!column) return;

    const row = state.gridData[rowIdx];
    if (!row) return;

    const value = getCellValue(row, colIdx);
    const readOnlyRowReason = getCellMutationBlockReason(rowIdx, colIdx, {
        allowOversizedReplacement: true
    });

    // Delegate BLOB inspection
    if (value instanceof Uint8Array) {
        if (blobInspector) {
            blobInspector.inspect(value, rowId, column.name, rowIdx, colIdx);
        }
        return;
    }

    const originalText = String(getCellValueForDisplay(row, rowIdx, colIdx) ?? '');
    state.cellPreviewInfo = {
        rowIdx,
        colIdx,
        rowId,
        columnName: column.name,
        table: state.selectedTable,
        tableType: state.selectedTableType,
        column: { ...column },
        identityKind: state.selectedTableIdentity?.kind ?? null,
        documentReadOnly: state.isReadOnly,
        originalValue: value,
        originalText,
        readOnlyReason: readOnlyRowReason,
        valueMode: 'value',
        dirty: false
    };
    const previewSession = state.cellPreviewInfo;

    const modal = document.getElementById('cellPreviewModal');
    const columnNameEl = document.getElementById('cellPreviewColumnName');
    const typeBadgeEl = document.getElementById('cellPreviewTypeBadge');
    const textarea = document.getElementById('cellPreviewTextarea');
    resetTextareaTabFocusEscape(textarea);
    const readonlyBadgeEl = document.getElementById('cellPreviewReadonlyBadge');
    const saveBtnEl = document.getElementById('cellPreviewSaveBtn');
    const openInVsCodeBtnEl = document.getElementById('openInVsCodeBtn');
    const emptyBtnEl = document.getElementById('cellPreviewEmptyBtn');
    const nullBtnEl = document.getElementById('cellPreviewNullBtn');
    const wrapBtnEl = document.getElementById('wrapTextBtn');

    columnNameEl.textContent = column.name;
    typeBadgeEl.textContent = column.type || 'TEXT';

    let displayValue = '';
    if (value === null || value === undefined) {
        displayValue = '';
    } else if (value instanceof Uint8Array) {
        displayValue = '[BLOB: ' + Array.from(value).map(b => b.toString(16).padStart(2, '0')).join(' ') + ']';
    } else {
        displayValue = originalText;
    }

    textarea.value = displayValue;

    const isReadonly = previewSession.documentReadOnly
        || previewSession.tableType !== 'table'
        || !!readOnlyRowReason;
    textarea.readOnly = isReadonly;
    if (isReadonly) {
        textarea.classList.add('readonly');
        readonlyBadgeEl.style.display = 'inline';
        readonlyBadgeEl.textContent = readOnlyRowReason
            ? column.isGenerated
                ? 'Read-only (Generated column)'
                : 'Read-only (Row)'
            : previewSession.documentReadOnly
                ? 'Read-only (Database)'
                : 'Read-only (View)';
        readonlyBadgeEl.title = readOnlyRowReason || '';
        saveBtnEl.style.display = 'none';
    } else {
        textarea.classList.remove('readonly');
        readonlyBadgeEl.style.display = 'none';
        readonlyBadgeEl.title = '';
        saveBtnEl.style.display = 'inline-block';
    }
    if (openInVsCodeBtnEl) {
        const externalEditorAvailable = !!document.getElementById('vscode-env');
        openInVsCodeBtnEl.style.display = readOnlyRowReason || !externalEditorAvailable ? 'none' : '';
    }
    if (emptyBtnEl) {
        emptyBtnEl.classList.remove('active');
        emptyBtnEl.disabled = isReadonly;
    }
    if (nullBtnEl) {
        nullBtnEl.classList.remove('active');
        nullBtnEl.disabled = isReadonly || column.notnull === 1;
        nullBtnEl.title = column.notnull === 1
            ? 'This column does not allow SQL NULL'
            : 'Store SQL NULL explicitly';
    }

    updateCellPreviewCharCount();

    textarea.style.whiteSpace = state.cellPreviewWrapEnabled ? 'pre-wrap' : 'pre';
    textarea.style.overflowX = state.cellPreviewWrapEnabled ? 'hidden' : 'auto';
    wrapBtnEl.classList.toggle('active', state.cellPreviewWrapEnabled);

    openModal('cellPreviewModal');
    textarea.focus();

    // Attach listener for char count
    textarea.oninput = () => {
        if (state.cellPreviewInfo === previewSession) {
            previewSession.valueMode = 'value';
            previewSession.dirty = true;
        }
        emptyBtnEl?.classList.remove('active');
        nullBtnEl?.classList.remove('active');
        updateCellPreviewCharCount();
    };
}

export function setCellPreviewEmpty() {
    const previewSession = state.cellPreviewInfo;
    if (
        !previewSession
        || previewSession.documentReadOnly
        || previewSession.tableType !== 'table'
        || previewSession.readOnlyReason
    ) return;
    const textarea = document.getElementById('cellPreviewTextarea');
    if (!textarea) return;
    previewSession.valueMode = 'value';
    previewSession.dirty = true;
    textarea.value = '';
    document.getElementById('cellPreviewEmptyBtn')?.classList.add('active');
    document.getElementById('cellPreviewNullBtn')?.classList.remove('active');
    updateCellPreviewCharCount();
    textarea.focus();
}

export function setCellPreviewNull() {
    const previewSession = state.cellPreviewInfo;
    if (
        !previewSession
        || previewSession.documentReadOnly
        || previewSession.tableType !== 'table'
        || previewSession.readOnlyReason
        || previewSession.column?.notnull === 1
    ) return;
    const textarea = document.getElementById('cellPreviewTextarea');
    if (!textarea) return;
    previewSession.valueMode = 'null';
    previewSession.dirty = true;
    textarea.value = '';
    document.getElementById('cellPreviewNullBtn')?.classList.add('active');
    document.getElementById('cellPreviewEmptyBtn')?.classList.remove('active');
    updateCellPreviewCharCount();
    textarea.focus();
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
    closeModal('cellPreviewModal');
}

export async function saveCellPreview() {
    if (isSavingCellPreview) return;
    isSavingCellPreview = true;
    try {
        return await saveCellPreviewOnce();
    } finally {
        isSavingCellPreview = false;
    }
}

async function saveCellPreviewOnce() {
    const previewSession = state.cellPreviewInfo;
    if (!previewSession) return;
    if (previewSession.documentReadOnly ?? state.isReadOnly) {
        updateStatus('Document is read-only');
        return;
    }
    if (previewSession.readOnlyReason) {
        updateStatus(previewSession.readOnlyReason);
        return;
    }
    if ((previewSession.tableType ?? state.selectedTableType) !== 'table') {
        updateStatus('Views are read-only');
        return;
    }

    const targetTable = previewSession.table ?? state.selectedTable;
    const { rowIdx, colIdx, rowId, columnName, originalValue, originalText } = previewSession;
    const textarea = document.getElementById('cellPreviewTextarea');
    const newValue = textarea.value;

    const origStr = originalText ?? (originalValue === null ? '' : String(originalValue));
    const valueMode = previewSession.valueMode ?? 'value';
    const explicitlyUnchanged = previewSession.dirty === false;
    const legacyUnchanged = previewSession.dirty === undefined
        && valueMode === 'value'
        && newValue === origStr;
    const nullUnchanged = valueMode === 'null' && originalValue === null;
    if (explicitlyUnchanged || legacyUnchanged || nullUnchanged) {
        closeCellPreview();
        state.selectedCells = [];
        state.lastSelectedCell = null;
        updateSelectionStates();
        return;
    }

    const column = previewSession.column ?? state.tableColumns[colIdx];

    let valueToSave;
    if (valueMode === 'null') {
        if (column?.notnull === 1) {
            updateStatus(`Column ${columnName} does not allow SQL NULL`);
            return;
        }
        valueToSave = null;
    } else if (newValue === '') {
        valueToSave = '';
    } else if (!isNaN(Number(newValue)) && newValue.trim() !== '') {
        valueToSave = parseGridInputValue(
            newValue,
            column,
            previewSession.identityKind === 'primaryKey'
        );
    } else {
        valueToSave = newValue;
    }

    try {
        updateStatus('Saving...');
        const updatedRowId = await backendApi.updateCell(
            targetTable,
            validateRowId(rowId),
            columnName,
            valueToSave,
            originalValue
        );
        // The edited value may enter/leave an active filter's match set, so
        // the table's cached filtered counts are no longer trustworthy.
        noteCellValuesChanged(targetTable);

        // A broadcast refresh can reorder both rows and columns while the RPC is
        // pending. Resolve the preview target from its stable database identity
        // before touching either the grid value or its exact-INTEGER sidecar.
        const currentCell = resolveDisplayedCell(targetTable, rowId, columnName)
            ?? (updatedRowId !== undefined
                ? resolveDisplayedCell(targetTable, updatedRowId, columnName)
                : null);
        remapDisplayedRowIdentity(targetTable, rowId, updatedRowId, currentCell);
        if (currentCell) {
            state.gridData[currentCell.rowIdx][currentCell.colIdx + getRowDataOffset()] = valueToSave;
            clearExactIntegerText(currentCell.rowIdx, currentCell.colIdx);
            clearOversizedCellMetadata(currentCell.rowIdx, currentCell.colIdx);
        }

        if (state.cellPreviewInfo === previewSession) closeCellPreview();
        if (currentCell) updateCellDom(currentCell.rowIdx, currentCell.colIdx, valueToSave);
        if (state.selectedTable !== targetTable) return;
        if (state.matchNav.scope !== null) resetMatchNav();

        state.selectedCells = [];
        state.lastSelectedCell = null;
        updateSelectionStates();

        updateStatus('Saved');
    } catch (err) {
        console.error('Save failed:', err);
        updateStatus(`Save failed: ${getErrorMessage(err)}`);
    }
}

export function formatCellPreviewJson() {
    const textarea = document.getElementById('cellPreviewTextarea');
    try {
        const parsed = JSON.parse(textarea.value);
        const formatted = JSON.stringify(parsed, null, 2);
        if (formatted !== textarea.value && state.cellPreviewInfo) {
            state.cellPreviewInfo.valueMode = 'value';
            state.cellPreviewInfo.dirty = true;
        }
        textarea.value = formatted;
        updateCellPreviewCharCount();
    } catch (e) {
        updateStatus('Content is not valid JSON');
    }
}

export function compactCellPreviewJson() {
    const textarea = document.getElementById('cellPreviewTextarea');
    try {
        const parsed = JSON.parse(textarea.value);
        const compacted = JSON.stringify(parsed);
        if (compacted !== textarea.value && state.cellPreviewInfo) {
            state.cellPreviewInfo.valueMode = 'value';
            state.cellPreviewInfo.dirty = true;
        }
        textarea.value = compacted;
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
    const row = state.gridData[rowIdx];
    const visibleValue = row ? getCellValueForDisplay(row, rowIdx, colIdx) : value;
    const displayValue = formatCellValueAsText(visibleValue, col?.type, state.dateFormat, col?.name);
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
