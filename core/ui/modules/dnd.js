/**
 * Drag and Drop Support for BLOBs
 */
import { backendApi } from './api.js';
import { updateStatus } from './ui.js';
import { state } from './state.js';
import { getRowId, getRowDataOffset } from './data-utils.js';
import { formatCellValueAsText } from './utils.js';
import { renderDataGrid } from './grid.js';

// Maximum blob size in bytes (50MB) to prevent UI freeze during Base64 encoding
const MAX_BLOB_SIZE_BYTES = 50 * 1024 * 1024;

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

    // Highlight cell on dragover
    container.addEventListener('dragover', onDragOver);
    container.addEventListener('dragleave', onDragLeave);
    container.addEventListener('drop', onDrop);
}

let lastHighlightedCell = null;

function onDragOver(e) {
    e.preventDefault();

    // Don't offer a drop target while a grid reload is in flight: the cells under
    // the cursor are stale and about to be replaced. Leave dropEffect unset so the
    // cursor shows "no-drop", and clear any lingering highlight.
    if (state.isReadOnly || state.isGridReloading) {
        if (lastHighlightedCell) {
            lastHighlightedCell.classList.remove('drag-over');
            lastHighlightedCell = null;
        }
        return;
    }

    e.dataTransfer.dropEffect = 'copy';

    const cell = e.target.closest('.data-cell');
    if (cell && !cell.classList.contains('row-number')) {
        if (lastHighlightedCell && lastHighlightedCell !== cell) {
            lastHighlightedCell.classList.remove('drag-over');
        }
        cell.classList.add('drag-over');
        lastHighlightedCell = cell;
    } else if (lastHighlightedCell) {
        lastHighlightedCell.classList.remove('drag-over');
        lastHighlightedCell = null;
    }
}

function onDragLeave(e) {
    if (e.target === lastHighlightedCell) {
        // Rely on dragover
    }
}

async function onDrop(e) {
    e.preventDefault();

    if (lastHighlightedCell) {
        lastHighlightedCell.classList.remove('drag-over');
        lastHighlightedCell = null;
    }

    // Ignore drops while a grid reload is in flight: the targeted cell belongs to
    // the stale result set about to be replaced, so the upload would land on the
    // wrong row/column once the new data renders.
    if (state.isReadOnly || state.isGridReloading) return;

    const cell = e.target.closest('.data-cell');
    if (!cell || cell.classList.contains('row-number')) {
        return;
    }

    // Check for files
    if (e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        await handleFileUpload(cell, file.name, file);
        return;
    }

    // Check for VS Code internal URI list (dragging from Explorer)
    const uriList = e.dataTransfer.getData('text/uri-list');
    if (uriList) {
        const uris = uriList.split(/\r?\n/);
        if (uris.length > 0 && uris[0]) {
            let uri = uris[0];
            // Extract name from URI
            let name = 'unknown_file';
            try {
                // Simple parsing for name
                const parts = uri.split('/');
                name = decodeURIComponent(parts[parts.length - 1]);
            } catch (err) {
                console.warn('Failed to parse name from URI', err);
            }
            await handleUriUpload(cell, name, uri);
            return;
        }
    }
}

async function handleFileUpload(cell, fileName, fileBlob) {
    // Early size check before reading file
    if (fileBlob.size > MAX_BLOB_SIZE_BYTES) {
        const sizeMB = (fileBlob.size / (1024 * 1024)).toFixed(1);
        const limitMB = (MAX_BLOB_SIZE_BYTES / (1024 * 1024)).toFixed(0);
        updateStatus(`File too large (${sizeMB}MB). Maximum is ${limitMB}MB.`);
        return;
    }

    try {
        updateStatus(`Reading ${fileName}...`);
        const buffer = await readFileAsArrayBuffer(fileBlob);
        const uint8Array = new Uint8Array(buffer);
        await uploadDataToCell(cell, fileName, uint8Array);
    } catch (err) {
        console.error('File read failed:', err);
        updateStatus(`File read failed: ${err.message}`);
    }
}

async function handleUriUpload(cell, fileName, uri) {
    try {
        updateStatus(`Fetching ${fileName}...`);
        const result = await backendApi.readWorkspaceFileUri(uri);

        let uint8Array;
        if (result instanceof Uint8Array) {
            uint8Array = result;
        } else if (result && result.type === 'Buffer' && Array.isArray(result.data)) {
            uint8Array = new Uint8Array(result.data);
        } else if (result && typeof result === 'object' && Object.keys(result).some(k => !isNaN(k))) {
             uint8Array = new Uint8Array(Object.values(result));
        } else {
             console.error('Unknown data format from backend:', result);
             throw new Error('Received invalid data format from backend');
        }

        await uploadDataToCell(cell, fileName, uint8Array);
    } catch (err) {
        console.error('URI upload failed:', err);
        updateStatus(`Upload failed: ${err.message}`);
    }
}

async function uploadDataToCell(cell, fileName, uint8Array) {
    // Prevent concurrent uploads
    if (isUploading) {
        updateStatus('Upload already in progress...');
        return;
    }

    // Check file size limit to prevent UI freeze during Base64 encoding
    if (uint8Array.byteLength > MAX_BLOB_SIZE_BYTES) {
        const sizeMB = (uint8Array.byteLength / (1024 * 1024)).toFixed(1);
        const limitMB = (MAX_BLOB_SIZE_BYTES / (1024 * 1024)).toFixed(0);
        updateStatus(`File too large (${sizeMB}MB). Maximum is ${limitMB}MB.`);
        return;
    }

    const rowIdx = parseInt(cell.dataset.rowidx, 10);
    const colIdx = parseInt(cell.dataset.colidx, 10);

    if (!state.gridData) return;
    const row = state.gridData[rowIdx];
    if (!row) return;

    const rowId = getRowId(row, rowIdx);
    const column = state.tableColumns[colIdx];

    if (state.isReadOnly || state.selectedTableType !== 'table') {
        updateStatus('Cannot upload to a view');
        return;
    }

    // Set upload state to block other operations
    isUploading = true;
    state.isLoadingData = true;

    try {
        updateStatus(`Uploading ${fileName} (${formatBytes(uint8Array.byteLength)})...`);

        // Get original value for undo
        const originalValue = row[colIdx + getRowDataOffset()];

        await backendApi.updateCell(
            state.selectedTable,
            rowId,
            column.name,
            uint8Array,
            originalValue
        );

        // Update local state
        state.gridData[rowIdx][colIdx + getRowDataOffset()] = uint8Array;

        // Update DOM
        updateCellDom(cell, uint8Array);
        updateStatus(`Uploaded ${fileName}`);
    } catch (err) {
        console.error('Upload failed:', err);
        let errorMessage = err.message || String(err);
        if (errorMessage.includes('timeout')) {
            errorMessage = 'Upload timed out. Try a smaller file.';
        }
        updateStatus(`Upload failed: ${errorMessage}`);
    } finally {
        // Always reset upload state to restore functionality
        isUploading = false;
        state.isLoadingData = false;
    }
}

function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
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
}
