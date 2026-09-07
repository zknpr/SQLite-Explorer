/**
 * Drag and Drop Support for BLOBs
 */
import { backendApi } from './api.js';
import { updateStatus } from './ui.js';
import { state } from './state.js';
import {
    clearExactIntegerText,
    clearOversizedCellMetadata,
    getCellMutationBlockReason,
    getRowId,
    getRowDataOffset,
    remapDisplayedRowIdentity,
    resolveDisplayedCell
} from './data-utils.js';
import { noteCellValuesChanged } from './count-cache.js';
import { formatCellValueAsText, getErrorMessage, normalizeBinaryData } from './utils.js';
import { loadTableData, renderDataGrid } from './grid.js';
import { DEFAULT_MAX_CELL_EDIT_BYTES } from '../../../src/core/cell-edit-policy.ts';

// Track upload state to prevent concurrent uploads and allow proper cleanup
let isUploading = false;

export function initDragAndDrop() {
    const container = document.getElementById('gridContainer');
    if (!container) {
        console.error('gridContainer not found');
        return;
    }

    // Prevent default behavior for dragover/drop on the whole document
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', e => e.preventDefault());
    document.addEventListener('dragend', clearDragHighlight);

    // Highlight cell on dragover
    container.addEventListener('dragover', onDragOver);
    container.addEventListener('dragleave', onDragLeave);
    container.addEventListener('drop', onDrop);
}

let lastHighlightedCell = null;

function clearDragHighlight() {
    if (!lastHighlightedCell) return;
    lastHighlightedCell.classList.remove('drag-over');
    lastHighlightedCell = null;
}

function onDragOver(e) {
    e.preventDefault();

    // Don't offer a drop target while a grid reload is in flight: the cells under
    // the cursor are stale and about to be replaced. Leave dropEffect unset so the
    // cursor shows "no-drop", and clear any lingering highlight.
    if (isUploading || state.isReadOnly || state.isGridReloading || state.isRefreshingContent) {
        clearDragHighlight();
        return;
    }

    e.dataTransfer.dropEffect = 'copy';

    const cell = e.target.closest('.data-cell');
    const rowIdx = cell ? parseInt(cell.dataset.rowidx, 10) : -1;
    const colIdx = cell ? parseInt(cell.dataset.colidx, 10) : -1;
    const mutationBlockReason = rowIdx >= 0 && colIdx >= 0
        ? getCellMutationBlockReason(rowIdx, colIdx, { allowOversizedReplacement: true })
        : undefined;
    if (cell && !cell.classList.contains('row-number') && !mutationBlockReason) {
        if (lastHighlightedCell && lastHighlightedCell !== cell) {
            lastHighlightedCell.classList.remove('drag-over');
        }
        cell.classList.add('drag-over');
        lastHighlightedCell = cell;
    } else clearDragHighlight();
}

function onDragLeave(e) {
    if (!lastHighlightedCell) return;
    const next = e.relatedTarget;
    if (!next || !lastHighlightedCell.contains?.(next)) clearDragHighlight();
}

async function onDrop(e) {
    e.preventDefault();

    clearDragHighlight();

    // Ignore drops while a grid reload is in flight: the targeted cell belongs to
    // the stale result set about to be replaced, so the upload would land on the
    // wrong row/column once the new data renders.
    if (state.isReadOnly || state.isGridReloading || state.isRefreshingContent) return;

    const cell = e.target.closest('.data-cell');
    if (!cell || cell.classList.contains('row-number')) {
        return;
    }
    const uploadTarget = captureUploadTarget(cell);
    if (!uploadTarget) return;

    let upload;
    if (e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        upload = () => handleFileUpload(uploadTarget, file.name, file);
    } else {
        // Check for VS Code internal URI list (dragging from Explorer)
        const uriList = e.dataTransfer.getData('text/uri-list');
        // text/uri-list permits blank lines and #-prefixed comments. VS Code
        // can include either before the first dragged URI.
        const uri = uriList && uriList
            .split(/\r?\n/)
            .map(line => line.trim())
            .find(line => line.length > 0 && !line.startsWith('#'));
        if (uri) {
            // Extract name from URI
            let name = 'unknown_file';
            try {
                // Simple parsing for name
                const parts = uri.split('/');
                name = decodeURIComponent(parts[parts.length - 1]);
            } catch (err) {
                console.warn('Failed to parse name from URI', err);
            }
            upload = () => handleUriUpload(uploadTarget, name, uri);
        }
    }
    if (!upload) return;

    // Reserve before FileReader/workspace I/O. Otherwise several rapid drops
    // can each allocate the full edit limit and race, with the fastest read
    // writing first regardless of which file the user dropped first.
    if (isUploading) {
        updateStatus('Upload already in progress...');
        return;
    }
    isUploading = true;
    try {
        await upload();
    } finally {
        isUploading = false;
    }
}

/** Capture the database identity represented by a DOM cell before any file I/O. */
function captureUploadTarget(cell) {
    if (state.isReadOnly
        || state.isRefreshingContent
        || state.selectedTableType !== 'table'
        || !state.selectedTable) {
        updateStatus('Cannot upload to a read-only document or view');
        return null;
    }

    const rowIdx = parseInt(cell.dataset.rowidx, 10);
    const colIdx = parseInt(cell.dataset.colidx, 10);
    const mutationBlockReason = getCellMutationBlockReason(
        rowIdx,
        colIdx,
        { allowOversizedReplacement: true }
    );
    if (mutationBlockReason) {
        updateStatus(mutationBlockReason);
        return null;
    }
    const row = state.gridData?.[rowIdx];
    const column = state.tableColumns[colIdx];
    if (!row || !column) return null;

    return {
        table: state.selectedTable,
        connectionGeneration: state.connectionGeneration,
        contentGeneration: state.contentGeneration,
        rowId: getRowId(row, rowIdx),
        columnName: column.name,
        originalValue: row[colIdx + getRowDataOffset()]
    };
}

async function handleFileUpload(uploadTarget, fileName, fileBlob) {
    // Early size check before reading file
    if (!Number.isSafeInteger(fileBlob?.size) || fileBlob.size < 0) {
        updateStatus('Unable to determine the dropped file size safely.');
        return;
    }
    if (fileBlob.size > DEFAULT_MAX_CELL_EDIT_BYTES) {
        const sizeMB = (fileBlob.size / (1024 * 1024)).toFixed(1);
        const limitMB = (DEFAULT_MAX_CELL_EDIT_BYTES / (1024 * 1024)).toFixed(0);
        updateStatus(`File too large (${sizeMB}MB). Maximum is ${limitMB}MB.`);
        return;
    }

    try {
        updateStatus(`Reading ${fileName}...`);
        const buffer = await readFileAsArrayBuffer(fileBlob);
        const uint8Array = new Uint8Array(buffer);
        await uploadDataToCell(uploadTarget, fileName, uint8Array);
    } catch (err) {
        console.error('File read failed:', err);
        updateStatus(`File read failed: ${getErrorMessage(err)}`);
    }
}

async function handleUriUpload(uploadTarget, fileName, uri) {
    try {
        updateStatus(`Fetching ${fileName}...`);
        const result = await backendApi.readWorkspaceFileUri(uri);

        const uint8Array = normalizeUploadBytes(result);

        await uploadDataToCell(uploadTarget, fileName, uint8Array);
    } catch (err) {
        console.error('URI upload failed:', err);
        updateStatus(`Upload failed: ${getErrorMessage(err)}`);
    }
}

function normalizeUploadBytes(result) {
    try {
        return normalizeBinaryData(result);
    } catch (error) {
        // The malformed payload may be a very large database value or contain
        // secrets. Diagnostics need the classification, never the bytes.
        console.error('Unknown data format from backend');
        throw new Error('Received invalid data format from backend', { cause: error });
    }
}

async function uploadDataToCell(uploadTarget, fileName, uint8Array) {
    // URI reads cannot preflight a browser File, so enforce the same edit
    // ceiling again before serialization or database mutation.
    if (uint8Array.byteLength > DEFAULT_MAX_CELL_EDIT_BYTES) {
        const sizeMB = (uint8Array.byteLength / (1024 * 1024)).toFixed(1);
        const limitMB = (DEFAULT_MAX_CELL_EDIT_BYTES / (1024 * 1024)).toFixed(0);
        updateStatus(`File too large (${sizeMB}MB). Maximum is ${limitMB}MB.`);
        return;
    }

    // File/URI reads are asynchronous. Never reinterpret the original DOM
    // indices against a table selected while that read was in flight.
    if (state.isReadOnly
        || state.selectedTableType !== 'table'
        || state.selectedTable !== uploadTarget.table) {
        updateStatus('Upload cancelled because the selected table changed');
        return;
    }
    if (state.connectionGeneration !== uploadTarget.connectionGeneration) {
        updateStatus('Upload cancelled because the database was reloaded');
        return;
    }
    if (state.contentGeneration !== uploadTarget.contentGeneration) {
        updateStatus('Upload cancelled because the database content changed');
        return;
    }

    // Block conflicting cell-selection/edit gestures during the database write.
    state.isLoadingData = true;

    try {
        updateStatus(`Uploading ${fileName} (${formatBytes(uint8Array.byteLength)})...`);

        const updatedRowId = await backendApi.updateCell(
            uploadTarget.table,
            uploadTarget.rowId,
            uploadTarget.columnName,
            uint8Array,
            uploadTarget.originalValue
        );
        // The uploaded value may enter/leave an active filter's match set,
        // so the table's cached filtered counts can't be trusted.
        noteCellValuesChanged(uploadTarget.table);

        // A background refresh may reorder rows or columns while the write is
        // in flight. Resolve the current UI position only after the stable
        // database identity has been written, and never paint another table.
        const targetStillCurrent = state.connectionGeneration === uploadTarget.connectionGeneration
            && state.contentGeneration === uploadTarget.contentGeneration
            && state.selectedTable === uploadTarget.table
            && state.selectedTableType === 'table';
        const currentCell = targetStillCurrent
            ? resolveDisplayedCell(
                uploadTarget.table,
                uploadTarget.rowId,
                uploadTarget.columnName
            ) ?? (updatedRowId !== undefined
                ? resolveDisplayedCell(
                    uploadTarget.table,
                    updatedRowId,
                    uploadTarget.columnName
                )
                : null)
            : null;
        if (currentCell) {
            // The write has committed. Invalidate metadata describing the
            // replaced value before any authoritative refresh, because that
            // refresh can fail and leave the existing grid mounted.
            clearExactIntegerText(currentCell.rowIdx, currentCell.colIdx);
            clearOversizedCellMetadata(currentCell.rowIdx, currentCell.colIdx);
        }
        if (targetStillCurrent && !document.getElementById('vscode-env')) {
            // The standalone demo has no host refresh echo. A BLOB can change
            // sort/filter/page membership, so an in-place cell paint is not an
            // authoritative representation of the query result.
            await loadTableData(false);
        } else if (targetStillCurrent) {
            remapDisplayedRowIdentity(
                uploadTarget.table,
                uploadTarget.rowId,
                updatedRowId,
                currentCell
            );
            if (currentCell) {
                state.gridData[currentCell.rowIdx][currentCell.colIdx + getRowDataOffset()] = uint8Array;
                const cellElement = document.getElementById(
                    `cell-${currentCell.rowIdx}-${currentCell.colIdx}`
                );
                if (cellElement) updateCellDom(cellElement, uint8Array);
            }
        }
        if (state.connectionGeneration === uploadTarget.connectionGeneration
            && state.contentGeneration === uploadTarget.contentGeneration) {
            updateStatus(`Uploaded ${fileName}`);
        }
    } catch (err) {
        console.error('Upload failed:', err);
        let errorMessage = getErrorMessage(err);
        if (errorMessage.includes('timeout')) {
            errorMessage = 'Upload timed out. Try a smaller file.';
        }
        updateStatus(`Upload failed: ${errorMessage}`);
    } finally {
        state.isLoadingData = false;
    }
}

export function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            if (reader.result instanceof ArrayBuffer) resolve(reader.result);
            else reject(new Error('FileReader returned a non-binary result'));
        };
        reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
        reader.onabort = () => reject(new Error('File read was aborted'));
        try {
            reader.readAsArrayBuffer(file);
        } catch (error) {
            reject(error);
        }
    });
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function updateCellDom(cell, value) {
    const displayValue = formatCellValueAsText(value);

    // Use DOM creation with textContent for XSS prevention (defense-in-depth)
    cell.textContent = '';
    const textSpan = document.createElement('span');
    textSpan.className = 'cell-text';
    textSpan.textContent = displayValue;
    cell.appendChild(textSpan);

    const expandIcon = document.createElement('span');
    expandIcon.className = 'expand-icon codicon codicon-link-external';
    expandIcon.title = 'View full content';
    cell.appendChild(expandIcon);

    cell.classList.remove('null-value');
    // The old measurement belongs to the replaced text node. Let the delegated
    // mouseover handler measure the new content against the live column width.
    cell.classList.remove('checked-overflow', 'has-overflow');
}
