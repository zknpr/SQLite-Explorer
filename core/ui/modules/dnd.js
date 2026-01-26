/**
 * Drag and Drop Support for BLOBs
 */
import { backendApi } from './api.js';
import { updateStatus } from './ui.js';
import { state } from './state.js';
import { getRowId, getRowDataOffset } from './data-utils.js';
import { formatCellValue } from './utils.js';

export function initDragAndDrop() {
    console.log('Initializing Drag and Drop');
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
    console.log('Drag and Drop initialized');
}

let lastHighlightedCell = null;

function onDragOver(e) {
    e.preventDefault();
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
    // Only remove if leaving the cell (not entering a child)
    // But dragleave fires when entering a child too.
    // Simpler to rely on dragover to manage the class, or clean up if leaving grid.
    if (e.target === lastHighlightedCell) {
        // This flickers. Rely on dragover.
    }
}

async function onDrop(e) {
    e.preventDefault();
    console.log('Drop detected');
    console.log('dataTransfer types:', e.dataTransfer.types);
    console.log('dataTransfer files length:', e.dataTransfer.files.length);
    console.log('dataTransfer items length:', e.dataTransfer.items.length);

    if (lastHighlightedCell) {
        lastHighlightedCell.classList.remove('drag-over');
        lastHighlightedCell = null;
    }

    const cell = e.target.closest('.data-cell');
    if (!cell || cell.classList.contains('row-number')) {
        console.log('Drop target is not a valid data cell');
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
        console.log('Found URI list:', uriList);
        const uris = uriList.split(/\r?\n/);
        if (uris.length > 0 && uris[0]) {
            let uri = uris[0];
            // Decode URI if needed, but VS Code usually provides encoded URIs
            // We need a name. Try to extract from URI.
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

    console.log('No handled content found in drop');
}

async function handleFileUpload(cell, fileName, fileBlob) {
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
        // Use backend to read file from workspace
        // Response should be the buffer/array
        const result = await backendApi.readWorkspaceFileUri(uri);

        // Result comes back as the data structure from RPC.
        // HostBridge returns Uint8Array.
        // PostMessage serialization handles Uint8Array correctly usually.
        // If it comes as { type: 'Buffer', data: [...] } (Node Buffer serialization), we need to handle it.

        let uint8Array;
        if (result instanceof Uint8Array) {
            uint8Array = result;
        } else if (result && result.type === 'Buffer' && Array.isArray(result.data)) {
            uint8Array = new Uint8Array(result.data);
        } else if (result && typeof result === 'object' && Object.keys(result).some(k => !isNaN(k))) {
             // Sometimes obj-like {0: x, 1: y...}
             uint8Array = new Uint8Array(Object.values(result));
        } else {
             // Fallback or error
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
    const rowIdx = parseInt(cell.dataset.rowidx, 10);
    const colIdx = parseInt(cell.dataset.colidx, 10);

    if (!state.gridData) return;
    const row = state.gridData[rowIdx];
    if (!row) return;

    const rowId = getRowId(row, rowIdx);
    const column = state.tableColumns[colIdx];

    if (state.selectedTableType !== 'table') {
        updateStatus('Cannot upload to a view');
        return;
    }

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
        updateStatus(`Upload failed: ${err.message}`);
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
    const displayValue = formatCellValue(value);
    const hasContent = true; // It's a BLOB now

    let html = `<span class="cell-text">${displayValue}</span>`;
    html += `<span class="expand-icon codicon codicon-link-external" title="View full content"></span>`;

    cell.innerHTML = html;
    cell.classList.remove('null-value');
}
