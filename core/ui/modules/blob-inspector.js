import { backendApi } from './api.js';
import { state } from './state.js';
import {
    clearExactIntegerText,
    clearOversizedCellMetadata,
    getCellMutationBlockReason,
    getRowDataOffset,
    remapDisplayedRowIdentity,
    resolveDisplayedCell
} from './data-utils.js';
import { updateStatus } from './ui.js';
import { noteCellValuesChanged } from './count-cache.js';
import { closeModal, openModal, registerModalCloseHandler } from './modals.js';
import {
    CellEditPolicyError,
    DEFAULT_MAX_CELL_EDIT_BYTES
} from '../../../src/core/cell-edit-policy.ts';
import { MAX_CELL_READ_CHUNK_BYTES } from '../../../src/core/cell-read.ts';
import { getErrorMessage, normalizeBinaryData } from './utils.js';


const FILE_SIGNATURES = {
    PNG: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
    JPEG: [0xFF, 0xD8, 0xFF],
    GIF: [0x47, 0x49, 0x46, 0x38],
    BMP: [0x42, 0x4D],
    RIFF: [0x52, 0x49, 0x46, 0x46],
    WEBP: [0x57, 0x45, 0x42, 0x50],
    PDF: [0x25, 0x50, 0x44, 0x46, 0x2D],
    ID3: [0x49, 0x44, 0x33],
    MP3_SYNC1: [0xFF, 0xFB],
    MP3_SYNC2: [0xFF, 0xF3],
    MP3_SYNC3: [0xFF, 0xF2],
    OGG: [0x4F, 0x67, 0x67, 0x53],
    WAVE: [0x57, 0x41, 0x56, 0x45],
    FLAC: [0x66, 0x4C, 0x61, 0x43],
    FTYP: [0x66, 0x74, 0x79, 0x70],
    WEBM: [0x1A, 0x45, 0xDF, 0xA3],
    AVI: [0x41, 0x56, 0x49, 0x20]
};

export const MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES = 64 * 1024;
export const OVERSIZED_INSPECTOR_LOAD_STEP_BYTES = MAX_CELL_READ_CHUNK_BYTES;
export const MAX_OVERSIZED_INSPECTOR_LOAD_BYTES = 8 * 1024 * 1024;

const CELL_TEXT_ENCODINGS = new Set(['utf-8', 'utf-16le', 'utf-16be']);
let mediaPreviewRequestCounter = 0;

function createMediaPreviewRequestId() {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
    mediaPreviewRequestCounter++;
    return `media-${Date.now().toString(36)}-${mediaPreviewRequestCounter.toString(36)}`;
}

/** Decode a database-byte prefix while withholding only an incomplete final character. */
export function decodeCellTextPrefix(bytes, encoding, complete) {
    if (!(bytes instanceof Uint8Array)) {
        throw new TypeError('Cell TEXT bytes must be a Uint8Array');
    }
    if (!CELL_TEXT_ENCODINGS.has(encoding)) {
        throw new Error(`Unsupported SQLite text encoding: ${String(encoding)}`);
    }
    try {
        const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
        return decoder.decode(bytes, { stream: !complete });
    } catch (error) {
        throw new Error(`Cell TEXT is not validly encoded as ${encoding}`, { cause: error });
    }
}

function validateCellReadMetadata(metadata) {
    if (!metadata || (metadata.storageClass !== 'text' && metadata.storageClass !== 'blob')) {
        throw new Error('Cell changed to a storage class that the inspector cannot stream');
    }
    if (!Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 0) {
        throw new Error('Cell read session returned an invalid byte length');
    }
    if (metadata.storageClass === 'text' && !CELL_TEXT_ENCODINGS.has(metadata.textEncoding)) {
        throw new Error(`Unsupported SQLite text encoding: ${String(metadata.textEncoding)}`);
    }
}

function validateCellReadChunk(chunk, expectedOffset, requestedBytes, totalBytes) {
    if (!chunk || chunk.byteOffset !== expectedOffset) {
        throw new Error(`Cell read returned offset ${String(chunk?.byteOffset)} instead of ${expectedOffset}`);
    }
    if (!(chunk.bytes instanceof Uint8Array)) {
        throw new Error('Cell read returned non-binary chunk data');
    }
    if (chunk.bytes.byteLength > requestedBytes) {
        throw new Error('Cell read returned more bytes than requested');
    }
    if (chunk.bytes.byteLength === 0 && expectedOffset < totalBytes) {
        throw new Error('Cell read ended before the advertised byte length');
    }
    const nextOffset = expectedOffset + chunk.bytes.byteLength;
    const expectedDone = nextOffset >= totalBytes;
    if (chunk.done !== expectedDone) {
        throw new Error('Cell read returned inconsistent completion metadata');
    }
}

function isOversizedMediaType(type) {
    return type?.type === 'image'
        || type?.type === 'audio'
        || type?.type === 'video'
        || type?.type === 'pdf';
}

/** Keep inspector DOM work bounded and preserve a valid UTF-8 prefix for TEXT. */
export function capOversizedInspectorPreview(value, storageClass) {
    const bytes = storageClass === 'text'
        ? new TextEncoder().encode(String(value))
        : value instanceof Uint8Array
            ? value
            : new Uint8Array(value);
    if (bytes.byteLength <= MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES) return bytes;

    let end = MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES;
    if (storageClass === 'text') {
        // If the next byte is a continuation byte, the cap landed inside one
        // UTF-8 sequence. Drop that sequence instead of displaying U+FFFD.
        while (end > 0 && (bytes[end] & 0xC0) === 0x80) end--;
    }
    return bytes.slice(0, end);
}

export class BlobInspector {
    constructor() {
        this.currentObjectUrl = null;
        this.currentMediaPreview = null;
        this.pendingMediaRequest = null;
        this.previewGeneration = 0;
        this.modal = document.getElementById('blob-inspector-modal');
        this.previewContainer = document.getElementById('tab-preview');
        this.hexContainer = document.querySelector('.hex-dump');
        this.infoContainer = document.getElementById('blob-info');

        this.currentData = null;
        this.currentType = null;
        this.currentRowId = null;
        this.currentColName = null;
        this.currentCellInfo = null;
        this.currentOversizedMetadata = null;
        this.currentTable = null;
        this.oversizedLoadedBytes = 0;
        this.isLoadingOversized = false;
        this.oversizedLoadOperation = null;

        // Track upload state to prevent multiple concurrent uploads and enable proper cleanup
        this.isUploading = false;
        this.activeReplacement = null;
        this.activeFullContent = null;
        this.activeDownload = null;

        this.setupEventListeners();
        registerModalCloseHandler('blob-inspector-modal', () => this.cleanup());
    }

    setupEventListeners() {
        // Close button
        this.modal.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => this.close());
        });

        // Tabs
        this.modal.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tab = e.target.dataset.tab;
                this.switchTab(tab);
            });
        });

        // Download button
        const dlBtn = document.getElementById('blob-download-btn');
        if (dlBtn) {
            dlBtn.addEventListener('click', () => this.download());
        }

        // Replace button
        const replaceBtn = document.getElementById('blob-replace-btn');
        if (replaceBtn) {
            replaceBtn.addEventListener('click', () => this.handleReplace());
        }

        const loadMoreBtn = document.getElementById('blob-load-more-btn');
        if (loadMoreBtn) {
            loadMoreBtn.addEventListener('click', () => {
                void this.loadMoreOversizedContent();
            });
        }
    }

    setInspectorTitle(label) {
        const title = this.modal?.querySelector?.('#blobInspectorModalTitle')
            ?? globalThis.document?.getElementById?.('blobInspectorModalTitle');
        if (title) title.textContent = label;
        const closeButton = this.modal?.querySelector?.('.modal-close');
        if (closeButton) {
            closeButton.setAttribute(
                'aria-label',
                `Close ${label.replace(/ Inspector$/, ' inspector')}`
            );
        }
        this.hexContainer?.setAttribute?.(
            'aria-label',
            `${label.replace(/ Inspector$/, '')} hexadecimal data`
        );
    }

    /**
     * Set upload state and update UI accordingly.
     * Disables buttons during upload to prevent concurrent operations.
     *
     * @param {boolean} uploading - Whether upload is in progress
     */
    setUploadState(uploading) {
        this.isUploading = uploading;
        const replaceBtn = document.getElementById('blob-replace-btn');
        const downloadBtn = document.getElementById('blob-download-btn');
        const loadMoreBtn = document.getElementById('blob-load-more-btn');
        const mutationBlockReason = this.currentCellInfo
            ? getCellMutationBlockReason(
                this.currentCellInfo.rowIdx,
                this.currentCellInfo.colIdx,
                { allowOversizedReplacement: true }
            )
            : undefined;

        if (replaceBtn) {
            replaceBtn.disabled = state.isReadOnly
                || uploading
                || !!this.activeReplacement
                || !!mutationBlockReason;
            replaceBtn.textContent = uploading
                ? 'Uploading...'
                : this.activeReplacement
                    ? 'Selecting...'
                    : 'Replace';
            replaceBtn.title = mutationBlockReason || '';
        }
        if (downloadBtn) {
            downloadBtn.disabled = uploading || !!this.activeFullContent;
            downloadBtn.textContent = this.activeFullContent
                ? 'Opening...'
                : this.currentOversizedMetadata
                    ? 'Open Full Content'
                : 'Download';
            downloadBtn.title = this.currentOversizedMetadata
                ? 'Desktop opens the complete value in VS Code; the web demo is preview-only'
                : '';
        }
        if (loadMoreBtn) {
            const totalBytes = this.currentOversizedMetadata?.byteLength ?? 0;
            const loadLimit = Math.min(totalBytes, MAX_OVERSIZED_INSPECTOR_LOAD_BYTES);
            const canLoadMore = this.currentOversizedMetadata?.storageClass === 'text'
                && this.oversizedLoadedBytes < loadLimit;
            const nextBytes = Math.min(
                OVERSIZED_INSPECTOR_LOAD_STEP_BYTES,
                Math.max(0, loadLimit - this.oversizedLoadedBytes)
            );
            loadMoreBtn.hidden = !canLoadMore;
            loadMoreBtn.disabled = uploading || this.isLoadingOversized || !canLoadMore;
            loadMoreBtn.textContent = this.isLoadingOversized ? 'Loading...' : 'Load more';
            loadMoreBtn.title = canLoadMore
                ? `Load the next ${this.formatSize(nextBytes)} from one fresh cell snapshot`
                : '';
        }
    }

    beginReplacementOperation() {
        if (
            this.activeReplacement
            || this.currentRowId === null
            || this.currentRowId === undefined
            || this.currentColName === null
            || this.currentColName === undefined
        ) return null;
        const targetTable = this.currentTable ?? state.selectedTable;
        if (!targetTable || !this.currentCellInfo) return null;
        const operation = {
            generation: this.previewGeneration,
            connectionGeneration: state.connectionGeneration,
            contentGeneration: state.contentGeneration,
            targetTable,
            targetRowId: this.currentRowId,
            targetColumn: this.currentColName,
            targetCell: { ...this.currentCellInfo },
            originalValue: this.currentData,
            targetStorageClass: this.currentOversizedMetadata?.storageClass
        };
        this.activeReplacement = operation;
        this.setUploadState(false);
        return operation;
    }

    isReplacementOperationCurrent(operation) {
        return this.activeReplacement === operation
            && this.previewGeneration === operation.generation
            && state.connectionGeneration === operation.connectionGeneration
            && state.contentGeneration === operation.contentGeneration
            && state.selectedTable === operation.targetTable
            && this.currentRowId === operation.targetRowId
            && this.currentColName === operation.targetColumn;
    }

    finishReplacementOperation(operation) {
        if (this.activeReplacement !== operation) return;
        this.activeReplacement = null;
        this.isUploading = false;
        this.setUploadState(false);
    }

    async handleReplace() {
        // Prevent concurrent file pickers and uploads.
        if (state.isReadOnly || this.isUploading || this.activeReplacement) return;
        const mutationBlockReason = this.currentCellInfo
            ? getCellMutationBlockReason(
                this.currentCellInfo.rowIdx,
                this.currentCellInfo.colIdx,
                { allowOversizedReplacement: true }
            )
            : undefined;
        if (mutationBlockReason) {
            updateStatus(mutationBlockReason);
            return;
        }

        const operation = this.beginReplacementOperation();
        if (!operation) return;
        let fileInputOwnsOperation = false;

        try {
            // Check fileOperations setting to determine behavior
            const settings = await backendApi.getExtensionSettings();
            const fileOperations = settings?.fileOperations || 'native';
            if (!this.isReplacementOperationCurrent(operation)) return;

            if (fileOperations === 'web') {
                // Web mode: Use file input
                this.showFileInput(operation);
                fileInputOwnsOperation = true;
            } else {
                // Native mode: Use VS Code API to select file
                // NOTE: Use backendApi directly because it has the proper serialize/deserialize
                // layer for Uint8Array data, ensuring consistent handling across all callers.
                const result = await backendApi.selectFile();
                if (!this.isReplacementOperationCurrent(operation)) return;
                if (result) {
                    const data = normalizeBinaryData(result.data);

                    // Mock a File object for uploadFile
                    const file = {
                        name: result.name,
                        size: data.byteLength,
                        arrayBuffer: async () => data.buffer.slice(
                            data.byteOffset,
                            data.byteOffset + data.byteLength
                        )
                    };
                    await this.uploadFile(file, operation);
                }
            }
        } catch (err) {
            console.error('Replace failed:', err);
            if (this.isReplacementOperationCurrent(operation)) {
                updateStatus(`Replace failed: ${getErrorMessage(err)}`);
            }
        } finally {
            if (!fileInputOwnsOperation && !this.isUploading) {
                this.finishReplacementOperation(operation);
            }
        }
    }

    /**
     * Show file input for web mode
     */
    showFileInput(operation = this.beginReplacementOperation()) {
        if (!operation || !this.isReplacementOperationCurrent(operation)) return;
        const input = document.createElement('input');
        input.type = 'file';
        const parent = document.body;
        let removed = false;
        const cleanup = () => {
            if (removed) return;
            removed = true;
            parent.removeChild(input);
        };
        input.onchange = async (e) => {
            const file = e?.target?.files?.[0];
            cleanup();
            if (file) {
                await this.uploadFile(file, operation);
            } else {
                this.finishReplacementOperation(operation);
            }
        };
        input.oncancel = () => {
            cleanup();
            this.finishReplacementOperation(operation);
        };
        parent.appendChild(input);
        try {
            input.click();
        } catch (error) {
            cleanup();
            throw error;
        }
    }

    async uploadFile(file, operation = this.beginReplacementOperation()) {
        if (!operation || state.isReadOnly || this.isUploading) return;
        if (!this.isReplacementOperationCurrent(operation)) return;
        const {
            targetTable,
            targetRowId,
            targetColumn,
            targetCell,
            originalValue
        } = operation;
        this.isUploading = true;
        this.setUploadState(true);

        try {
            if (!Number.isSafeInteger(file.size) || file.size < 0) {
                throw new Error('Unable to determine the selected file size safely.');
            }
            if (file.size > DEFAULT_MAX_CELL_EDIT_BYTES) {
                throw new CellEditPolicyError(
                    'blob',
                    file.size,
                    DEFAULT_MAX_CELL_EDIT_BYTES
                );
            }

            if (this.isReplacementOperationCurrent(operation)) {
                updateStatus(`Reading ${file.name}...`);
            }
            const buffer = await file.arrayBuffer();
            const uint8Array = new Uint8Array(buffer);

            if (!this.isReplacementOperationCurrent(operation)) return;

            // Recheck the bytes actually read to close size/read races and to
            // distrust file-like providers whose metadata understates data.
            if (uint8Array.byteLength > DEFAULT_MAX_CELL_EDIT_BYTES) {
                throw new CellEditPolicyError(
                    'blob',
                    uint8Array.byteLength,
                    DEFAULT_MAX_CELL_EDIT_BYTES
                );
            }
            let replacementValue = uint8Array;
            if (operation.targetStorageClass === 'text') {
                try {
                    replacementValue = new TextDecoder('utf-8', { fatal: true }).decode(uint8Array);
                } catch (error) {
                    throw new Error(
                        `${file.name} is not valid UTF-8 and cannot replace a TEXT cell`,
                        { cause: error }
                    );
                }
            }
            const sizeMB = uint8Array.length / (1024 * 1024);

            // Warn about moderately large files
            if (sizeMB > 10) {
                updateStatus(`Uploading ${file.name} (${sizeMB.toFixed(1)}MB - this may take a moment)...`);
            } else {
                updateStatus(`Uploading ${file.name}...`);
            }

            if (!this.isReplacementOperationCurrent(operation)) return;
            const { rowIdx, colIdx } = targetCell;

            const updatedRowId = await backendApi.updateCell(
                targetTable,
                targetRowId,
                targetColumn,
                replacementValue,
                originalValue
            );
            // The replaced value may enter/leave an active filter's match
            // set, so the table's cached filtered counts can't be trusted.
            noteCellValuesChanged(targetTable);

            const currentCell = resolveDisplayedCell(targetTable, targetRowId, targetColumn)
                ?? (updatedRowId !== undefined
                    ? resolveDisplayedCell(targetTable, updatedRowId, targetColumn)
                    : null);
            remapDisplayedRowIdentity(targetTable, targetRowId, updatedRowId, currentCell);
            if (currentCell) {
                state.gridData[currentCell.rowIdx][currentCell.colIdx + getRowDataOffset()] = replacementValue;
                clearExactIntegerText(currentCell.rowIdx, currentCell.colIdx);
                clearOversizedCellMetadata(currentCell.rowIdx, currentCell.colIdx);
            }

            if (this.isReplacementOperationCurrent(operation)) {
                // Update Inspector UI only while this modal session still owns the operation.
                this.inspect(
                    replacementValue,
                    updatedRowId ?? targetRowId,
                    targetColumn,
                    currentCell?.rowIdx ?? rowIdx,
                    currentCell?.colIdx ?? colIdx
                );
                updateStatus(`Replaced with ${file.name}`);
            }

        } catch (err) {
            console.error('Replace failed:', err);
            // Provide helpful error message for timeouts
            let errorMessage = getErrorMessage(err);
            if (errorMessage.includes('timeout')) {
                errorMessage = 'Upload timed out. Try a smaller file or increase the timeout.';
            }
            if (this.isReplacementOperationCurrent(operation)) {
                updateStatus(`Replace failed: ${errorMessage}`);
            }
        } finally {
            this.finishReplacementOperation(operation);
        }
    }

    close() {
        closeModal('blob-inspector-modal', this.modal);
    }

    cleanup() {
        this.previewGeneration++;
        const pendingMediaRequest = this.pendingMediaRequest;
        this.pendingMediaRequest = null;
        if (pendingMediaRequest) {
            void backendApi.cancelCellMediaPreview(
                pendingMediaRequest.webviewId,
                pendingMediaRequest.requestId
            ).catch(error => console.warn('Failed to cancel media preview:', error));
        }
        const mediaPreview = this.currentMediaPreview;
        this.currentMediaPreview = null;
        if (mediaPreview) {
            // Cleanup races are expected when a modal closes or a new cell is
            // selected. The host release is idempotent, and a failed release is
            // surfaced in diagnostics without making close() throw.
            void backendApi.releaseCellMediaPreview(
                mediaPreview.webviewId,
                mediaPreview.previewId
            ).catch(error => console.warn('Failed to release media preview:', error));
        }

        // Reset upload state to ensure buttons are re-enabled
        this.activeReplacement = null;
        this.activeFullContent = null;
        this.activeDownload = null;
        this.isUploading = false;
        this.currentOversizedMetadata = null;
        this.currentTable = null;
        this.oversizedLoadedBytes = 0;
        this.oversizedLoadOperation = null;
        this.isLoadingOversized = false;
        this.setUploadState(false);

        if (this.currentObjectUrl) {
            URL.revokeObjectURL(this.currentObjectUrl);
            this.currentObjectUrl = null;
        }
        this.previewContainer.innerHTML = '';
        this.hexContainer.value = '';
        this.infoContainer.textContent = '';
        this.currentData = null;
        this.currentType = null;
        this.currentRowId = null;
        this.currentColName = null;
        this.currentCellInfo = null;
    }

    switchTab(tabId) {
        // Update tab buttons
        this.modal.querySelectorAll('.tab-btn').forEach(btn => {
            if (btn.dataset.tab === tabId) {
                btn.classList.add('active');
                btn.style.borderBottom = '2px solid var(--accent-color)';
                btn.style.color = 'var(--text-primary)';
            } else {
                btn.classList.remove('active');
                btn.style.borderBottom = 'none';
                btn.style.color = 'var(--text-secondary)';
            }
        });

        // Update tab content
        const previewTab = document.getElementById('tab-preview');
        const hexTab = document.getElementById('tab-hex');

        if (tabId === 'preview') {
            previewTab.style.display = 'flex';
            hexTab.style.display = 'none';
        } else {
            previewTab.style.display = 'none';
            hexTab.style.display = 'block';
        }
    }

    async download() {
        if (!this.currentData) return;
        if (this.currentOversizedMetadata) {
            await this.openFullContent();
            return;
        }

        if (this.activeDownload?.promise) return this.activeDownload.promise;

        const ext = this.currentType?.ext || 'bin';
        const operation = {
            generation: this.previewGeneration ?? 0,
            rowId: this.currentRowId,
            filename: `blob_${this.currentRowId}.${ext}`,
            data: this.currentData instanceof Uint8Array
                ? this.currentData.slice()
                : this.currentData,
            promise: null
        };
        this.activeDownload = operation;
        operation.promise = this.runDownload(operation);
        return operation.promise;
    }

    isDownloadOperationCurrent(operation) {
        return this.activeDownload === operation
            && (this.previewGeneration ?? 0) === operation.generation
            && this.currentRowId === operation.rowId;
    }

    async runDownload(operation) {
        try {
            // Check fileOperations setting to determine behavior
            const settings = await backendApi.getExtensionSettings();
            if (!this.isDownloadOperationCurrent(operation)) return false;
            const fileOperations = settings?.fileOperations || 'native';

            if (fileOperations === 'web') {
                // Web mode: Use browser download
                this.downloadBlob(operation.data, operation.filename);
                if (this.isDownloadOperationCurrent(operation)) {
                    updateStatus(`Downloaded ${operation.filename}`);
                }
            } else {
                // Native mode: Use VS Code API to save file via backendApi
                const result = await backendApi.saveFile(operation.filename, operation.data);
                if (!this.isDownloadOperationCurrent(operation)) return false;
                if (result?.success === false) {
                    updateStatus(result.cancelled ? 'Save cancelled' : (result.message || 'Save failed'));
                    return false;
                }
                updateStatus(`Saved ${operation.filename}`);
            }
            return true;
        } catch (err) {
            console.error('Download failed:', err);
            if (this.isDownloadOperationCurrent(operation)) {
                updateStatus(`Download failed: ${getErrorMessage(err)}`);
            }
            return false;
        } finally {
            if (this.activeDownload === operation) this.activeDownload = null;
        }
    }

    async openFullContent() {
        if (this.activeFullContent?.promise) return this.activeFullContent.promise;
        const targetTable = this.currentTable ?? state.selectedTable;
        if (
            !this.currentOversizedMetadata
            || !targetTable
            || this.currentRowId === null
            || this.currentRowId === undefined
            || this.currentColName === null
            || this.currentColName === undefined
        ) return;

        const webviewId = document.getElementById('vscode-env')?.dataset.webviewId || 'default';
        const operation = {
            generation: this.previewGeneration,
            targetTable,
            rowId: this.currentRowId,
            column: this.currentColName,
            type: this.currentType,
            sourceByteLength: this.currentOversizedMetadata.byteLength,
            webviewId,
            promise: null
        };
        this.activeFullContent = operation;
        this.setUploadState(this.isUploading);
        operation.promise = this.runFullContentOperation(operation);
        return operation.promise;
    }

    isFullContentOperationCurrent(operation) {
        return this.activeFullContent === operation
            && this.previewGeneration === operation.generation
            && this.currentRowId === operation.rowId
            && this.currentColName === operation.column;
    }

    async runFullContentOperation(operation) {
        try {
            const result = await backendApi.openCellEditor(
                { table: operation.targetTable, name: '' },
                operation.rowId,
                operation.column,
                {},
                {
                    type: operation.type,
                    webviewId: operation.webviewId,
                    sourceByteLength: operation.sourceByteLength
                }
            );
            if (!this.isFullContentOperationCurrent(operation)) return false;
            if (result?.success === false) {
                updateStatus(result.message || 'Full content is unavailable in the web demo');
                return false;
            }
            updateStatus(result?.mode === 'temporary-read-only'
                ? 'Opened full content in a verified read-only temporary file'
                : 'Opened full content in VS Code');
            return true;
        } catch (error) {
            if (this.isFullContentOperationCurrent(operation)) {
                const details = getErrorMessage(error);
                updateStatus(`Full content unavailable: ${details}`);
            }
            return false;
        } finally {
            if (this.activeFullContent === operation) {
                this.activeFullContent = null;
                if (this.previewGeneration === operation.generation) {
                    this.setUploadState(this.isUploading);
                }
            }
        }
    }

    /**
     * Download blob using browser download (web mode)
     */
    downloadBlob(data, filename) {
        const blob = new Blob([data]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        let appended = false;
        let clicked = false;
        try {
            document.body.appendChild(a);
            appended = true;
            a.click();
            clicked = true;
        } finally {
            try {
                if (appended) document.body.removeChild(a);
            } finally {
                if (clicked) setTimeout(() => URL.revokeObjectURL(url), 100);
                else URL.revokeObjectURL(url);
            }
        }
    }

    inspect(blobData, rowId, colName, rowIdx, colIdx) {
        this.cleanup();
        const isText = typeof blobData === 'string';
        this.setInspectorTitle(isText ? 'TEXT Inspector' : 'BLOB Inspector');

        // Store metadata
        this.currentTable = state.selectedTable;
        this.currentRowId = rowId;
        this.currentColName = colName;
        this.currentCellInfo = { rowIdx, colIdx };
        this.setUploadState(false);

        // Show modal
        openModal('blob-inspector-modal', this.modal);

        // Reset tabs to preview
        this.switchTab('preview');

        // Ensure we have a Uint8Array
        const data = isText
            ? new TextEncoder().encode(blobData)
            : blobData instanceof Uint8Array
                ? blobData
                : new Uint8Array(blobData);
        // Downloads and hex rendering share this value. Keep it byte-based even
        // for TEXT so native saves cannot reinterpret a JavaScript string as an
        // ArrayBuffer-like object.
        this.currentData = data;

        // Detect type
        const type = isText
            ? { mime: 'text/plain', type: 'text', ext: 'txt' }
            : this.detectType(data);
        this.currentType = type;
        const size = this.formatSize(data.length);

        this.infoContainer.textContent =
            `${colName} (Row ${rowId}) | ${isText ? 'TEXT' : (type.mime || 'Unknown Type')} | ${size}`;

        // Render Preview
        this.renderPreview(data, type, { text: isText ? blobData : undefined });

        // Render Hex
        this.renderHex(data);
    }

    inspectOversized(previewValue, metadata, rowId, colName, rowIdx, colIdx) {
        this.cleanup();
        this.setInspectorTitle(metadata.storageClass === 'text' ? 'TEXT Inspector' : 'BLOB Inspector');

        this.currentTable = state.selectedTable;
        this.currentRowId = rowId;
        this.currentColName = colName;
        this.currentCellInfo = { rowIdx, colIdx };
        this.currentOversizedMetadata = metadata;
        this.oversizedLoadedBytes = 0;
        this.setUploadState(false);
        openModal('blob-inspector-modal', this.modal);
        this.switchTab('preview');

        const data = capOversizedInspectorPreview(previewValue, metadata.storageClass);
        this.currentData = data;
        const type = metadata.storageClass === 'text'
            ? { mime: 'text/plain', type: 'text', ext: 'txt' }
            : this.detectType(data);
        this.currentType = type;
        this.infoContainer.textContent =
            `${colName} (Row ${rowId}) | ${metadata.storageClass.toUpperCase()} | ` +
            `Preview ${this.formatSize(data.byteLength)} of ${this.formatSize(metadata.byteLength)} | ` +
            'Full content opens from a desktop temporary file; web is preview-only';

        this.renderHex(data);
        if (metadata.byteLength <= OVERSIZED_INSPECTOR_LOAD_STEP_BYTES) {
            // Aggregate page pressure can truncate a modest value to a few
            // hundred characters. One bounded snapshot read restores it.
            return this.loadMoreOversizedContent(metadata.byteLength);
        }
        if (isOversizedMediaType(type)) {
            const generation = this.previewGeneration;
            this.renderOversizedMediaStatus('Preparing a private desktop media URI...');
            void this.loadOversizedMediaPreview(type, metadata, generation);
        } else {
            // Bounded text/binary previews keep the existing byte path.
            this.renderPreview(data, type, {
                text: metadata.storageClass === 'text' ? String(previewValue) : undefined
            });
        }
        return Promise.resolve(false);
    }

    /** Reread one complete prefix from offset zero inside a single snapshot. */
    async loadMoreOversizedContent(requestedPrefixBytes) {
        const metadata = this.currentOversizedMetadata;
        const table = this.currentTable;
        const rowId = this.currentRowId;
        const colName = this.currentColName;
        if (
            !metadata
            || !table
            || rowId === null
            || rowId === undefined
            || colName === null
            || colName === undefined
        ) {
            updateStatus('Cannot read this cell because its identity changed. Reopen the inspector.');
            return false;
        }
        if (this.oversizedLoadOperation) return false;

        const defaultTarget = Math.max(
            OVERSIZED_INSPECTOR_LOAD_STEP_BYTES,
            this.oversizedLoadedBytes + OVERSIZED_INSPECTOR_LOAD_STEP_BYTES
        );
        const requestedTarget = requestedPrefixBytes ?? defaultTarget;
        if (!Number.isSafeInteger(requestedTarget) || requestedTarget < 0) {
            updateStatus('Cannot read this cell because the requested preview size is invalid.');
            return false;
        }
        if (this.oversizedLoadedBytes >= MAX_OVERSIZED_INSPECTOR_LOAD_BYTES) return false;

        const generation = this.previewGeneration;
        const operation = {};
        this.oversizedLoadOperation = operation;
        this.isLoadingOversized = true;
        this.setUploadState(this.isUploading);
        let session;
        let loaded;
        let failure;
        try {
            session = await backendApi.openCellReadSession({ table, rowId, column: colName });
            if (!session || typeof session.sessionId !== 'string' || session.sessionId.length === 0) {
                throw new Error('Cell read session returned an invalid identifier');
            }
            validateCellReadMetadata(session.metadata);
            const targetBytes = Math.min(
                requestedTarget,
                session.metadata.byteLength,
                MAX_OVERSIZED_INSPECTOR_LOAD_BYTES
            );
            const bytes = new Uint8Array(targetBytes);
            let offset = 0;
            while (offset < targetBytes) {
                const requestBytes = Math.min(MAX_CELL_READ_CHUNK_BYTES, targetBytes - offset);
                const chunk = await backendApi.readCellChunk(
                    session.sessionId,
                    offset,
                    requestBytes
                );
                validateCellReadChunk(
                    chunk,
                    offset,
                    requestBytes,
                    session.metadata.byteLength
                );
                bytes.set(chunk.bytes, offset);
                offset += chunk.bytes.byteLength;
            }
            loaded = { bytes, metadata: session.metadata, complete: targetBytes >= session.metadata.byteLength };
        } catch (error) {
            failure = error;
        }

        if (session?.sessionId) {
            try {
                await backendApi.closeCellReadSession(session.sessionId);
            } catch (closeError) {
                failure = failure
                    ? new AggregateError([failure, closeError], 'Cell read and session cleanup both failed')
                    : closeError;
            }
        }

        if (this.oversizedLoadOperation === operation) {
            this.oversizedLoadOperation = null;
            this.isLoadingOversized = false;
            if (generation === this.previewGeneration) this.setUploadState(this.isUploading);
        }
        if (failure) {
            const details = getErrorMessage(failure);
            console.error('Reading the full cell failed:', failure);
            if (generation === this.previewGeneration) {
                updateStatus(`Reading the full cell failed: ${details}`);
            }
            return false;
        }
        if (!loaded || generation !== this.previewGeneration) return false;

        this.currentData = loaded.bytes;
        this.currentOversizedMetadata = loaded.metadata;
        this.oversizedLoadedBytes = loaded.bytes.byteLength;
        let renderedText;
        if (loaded.metadata.storageClass === 'text') {
            try {
                renderedText = decodeCellTextPrefix(
                    loaded.bytes,
                    loaded.metadata.textEncoding,
                    loaded.complete
                );
                try {
                    const parsed = JSON.parse(renderedText);
                    this.currentType = typeof parsed === 'object' && parsed !== null
                        ? { mime: 'application/json', type: 'json', ext: 'json' }
                        : { mime: 'text/plain', type: 'text', ext: 'txt' };
                } catch {
                    this.currentType = { mime: 'text/plain', type: 'text', ext: 'txt' };
                }
            } catch (error) {
                const details = getErrorMessage(error);
                updateStatus(`Text preview unavailable: ${details}. Raw bytes remain in Hex.`);
                this.currentType = { mime: 'application/octet-stream', type: 'binary', ext: 'bin' };
            }
        } else {
            this.currentType = this.detectType(loaded.bytes);
        }

        if (this.currentObjectUrl) {
            URL.revokeObjectURL(this.currentObjectUrl);
            this.currentObjectUrl = null;
        }
        this.previewContainer.replaceChildren?.();
        if (!this.previewContainer.replaceChildren) this.previewContainer.innerHTML = '';
        this.renderHex(loaded.bytes);
        this.renderPreview(loaded.bytes, this.currentType, { text: renderedText });
        this.infoContainer.textContent = loaded.complete
            ? `${colName} (Row ${rowId}) | ${loaded.metadata.storageClass.toUpperCase()} | ` +
                `Full value ${this.formatSize(loaded.metadata.byteLength)}`
            : `${colName} (Row ${rowId}) | ${loaded.metadata.storageClass.toUpperCase()} | ` +
                `Loaded ${this.formatSize(loaded.bytes.byteLength)} of ` +
                `${this.formatSize(loaded.metadata.byteLength)} source bytes`;
        this.setUploadState(this.isUploading);
        return true;
    }

    async loadOversizedMediaPreview(type, metadata, generation) {
        const table = this.currentTable ?? state.selectedTable;
        const rowId = this.currentRowId;
        const colName = this.currentColName;
        const webviewId = document.getElementById('vscode-env')?.dataset.webviewId || 'default';
        if (
            !table
            || rowId === null
            || rowId === undefined
            || colName === null
            || colName === undefined
        ) {
            this.renderOversizedMediaStatus(
                'Oversized media is unavailable because the cell identity changed. ' +
                'The bounded Hex preview remains available.'
            );
            return;
        }

        const request = {
            requestId: createMediaPreviewRequestId(),
            webviewId,
            generation,
            table,
            rowId,
            colName
        };
        this.pendingMediaRequest = request;

        try {
            const result = await backendApi.prepareCellMediaPreview(
                { table, name: '' },
                rowId,
                colName,
                {
                    type,
                    webviewId,
                    requestId: request.requestId,
                    sourceByteLength: metadata.byteLength
                }
            );
            if (
                this.pendingMediaRequest !== request
                || generation !== this.previewGeneration
                || (this.currentTable ?? state.selectedTable) !== table
                || this.currentRowId !== rowId
                || this.currentColName !== colName
            ) {
                if (result?.success) {
                    await backendApi.releaseCellMediaPreview(webviewId, result.previewId);
                }
                return;
            }
            this.pendingMediaRequest = null;
            if (!result?.success) {
                this.renderOversizedMediaStatus(
                    `${result?.message || 'Oversized media preview is unavailable'} ` +
                    'The bounded Hex preview remains available.'
                );
                return;
            }

            this.currentMediaPreview = {
                webviewId,
                requestId: request.requestId,
                previewId: result.previewId
            };
            try {
                this.renderMediaUri(result.uri, type, generation);
            } catch (error) {
                this.currentMediaPreview = null;
                await backendApi.releaseCellMediaPreview(webviewId, result.previewId);
                throw error;
            }
        } catch (error) {
            const requestIsCurrent = this.pendingMediaRequest === request
                && generation === this.previewGeneration
                && (this.currentTable ?? state.selectedTable) === table
                && this.currentRowId === rowId
                && this.currentColName === colName;
            if (this.pendingMediaRequest === request) this.pendingMediaRequest = null;
            if (!requestIsCurrent) return;
            const details = getErrorMessage(error);
            this.renderOversizedMediaStatus(
                `Oversized media preview unavailable: ${details}. ` +
                'The bounded Hex preview remains available.'
            );
        }
    }

    renderOversizedMediaStatus(message) {
        this.previewContainer.innerHTML = '';
        const container = document.createElement('div');
        container.className = 'empty-view';

        const text = document.createElement('span');
        text.textContent = message;

        const hexButton = document.createElement('button');
        hexButton.className = 'btn-primary';
        hexButton.textContent = 'View bounded Hex preview';
        hexButton.addEventListener('click', () => this.switchTab('hex'));

        container.appendChild(text);
        container.appendChild(hexButton);
        this.previewContainer.appendChild(container);
    }

    renderMediaUri(uri, type, generation) {
        let protocol;
        try {
            protocol = new URL(uri).protocol;
        } catch {
            throw new Error('The host returned an invalid media URI');
        }
        if (protocol !== 'https:' && protocol !== 'vscode-webview-resource:') {
            throw new Error(`The host returned a disallowed media URI scheme: ${protocol}`);
        }

        this.previewContainer.innerHTML = '';
        let mediaElement;
        if (type.type === 'image') {
            mediaElement = document.createElement('img');
            mediaElement.style.maxWidth = '100%';
            mediaElement.style.maxHeight = '100%';
            mediaElement.style.objectFit = 'contain';
            mediaElement.style.boxShadow = '0 0 10px rgba(0,0,0,0.5)';
        } else if (type.type === 'audio') {
            mediaElement = document.createElement('audio');
            mediaElement.controls = true;
            mediaElement.style.width = '100%';
            mediaElement.style.maxWidth = '400px';
        } else if (type.type === 'video') {
            mediaElement = document.createElement('video');
            mediaElement.controls = true;
            mediaElement.style.maxWidth = '100%';
            mediaElement.style.maxHeight = '100%';
            mediaElement.style.objectFit = 'contain';
        } else if (type.type === 'pdf') {
            mediaElement = document.createElement('iframe');
            // A PDF resource is untrusted database content. An empty iframe
            // sandbox prevents scripts, navigation, downloads, and same-origin
            // access even if the renderer misclassifies the bytes.
            mediaElement.setAttribute('sandbox', '');
            mediaElement.title = 'Oversized PDF preview';
            mediaElement.style.width = '100%';
            mediaElement.style.height = '100%';
            mediaElement.style.border = '0';
        } else {
            throw new Error(`Unsupported oversized media category: ${type.type}`);
        }

        const lease = this.currentMediaPreview;
        mediaElement.addEventListener('error', async () => {
            if (
                generation !== this.previewGeneration
                || !lease
                || this.currentMediaPreview !== lease
            ) return;
            try {
                await backendApi.releaseCellMediaPreview(lease.webviewId, lease.previewId);
            } catch (error) {
                const details = getErrorMessage(error);
                this.renderOversizedMediaStatus(
                    `The media preview failed to load and its temporary file could not be ` +
                    `released: ${details}. Close the inspector to retry cleanup. ` +
                    'The bounded Hex preview remains available.'
                );
                return;
            }
            if (this.currentMediaPreview === lease) this.currentMediaPreview = null;
            this.renderOversizedMediaStatus(
                'The media preview failed to load, so its temporary file was released. ' +
                'The bounded Hex preview remains available.'
            );
        }, { once: true });
        mediaElement.src = uri;
        this.previewContainer.appendChild(mediaElement);
    }

    detectType(data) {
        // Image Signatures
        if (this.checkSignature(data, FILE_SIGNATURES.PNG)) return { mime: 'image/png', type: 'image', ext: 'png' };
        if (this.checkSignature(data, FILE_SIGNATURES.JPEG)) return { mime: 'image/jpeg', type: 'image', ext: 'jpg' };
        if (this.checkSignature(data, FILE_SIGNATURES.GIF)) return { mime: 'image/gif', type: 'image', ext: 'gif' };
        if (this.checkSignature(data, FILE_SIGNATURES.BMP)) return { mime: 'image/bmp', type: 'image', ext: 'bmp' };
        if (this.checkSignature(data, FILE_SIGNATURES.RIFF) && this.checkSignature(data.subarray(8), FILE_SIGNATURES.WEBP)) return { mime: 'image/webp', type: 'image', ext: 'webp' };

        // PDF
        if (this.checkSignature(data, FILE_SIGNATURES.PDF)) return { mime: 'application/pdf', type: 'pdf', ext: 'pdf' };

        // Audio formats
        if (this.checkSignature(data, FILE_SIGNATURES.ID3)) return { mime: 'audio/mpeg', type: 'audio', ext: 'mp3' };
        if (this.checkSignature(data, FILE_SIGNATURES.MP3_SYNC1) || this.checkSignature(data, FILE_SIGNATURES.MP3_SYNC2) || this.checkSignature(data, FILE_SIGNATURES.MP3_SYNC3)) return { mime: 'audio/mpeg', type: 'audio', ext: 'mp3' };
        if (this.checkSignature(data, FILE_SIGNATURES.OGG)) return { mime: 'audio/ogg', type: 'audio', ext: 'ogg' };
        if (this.checkSignature(data, FILE_SIGNATURES.RIFF) && this.checkSignature(data.subarray(8), FILE_SIGNATURES.WAVE)) return { mime: 'audio/wav', type: 'audio', ext: 'wav' };
        if (this.checkSignature(data, FILE_SIGNATURES.FLAC)) return { mime: 'audio/flac', type: 'audio', ext: 'flac' };

        // Video formats - check ftyp box for MP4/MOV/M4V
        if (this.checkSignature(data.subarray(4), FILE_SIGNATURES.FTYP)) {
            // ftyp box detected - check brand
            const brand = String.fromCharCode(...data.subarray(8, 12));
            if (brand.startsWith('mp4') || brand === 'isom' || brand === 'avc1' || brand === 'M4V ') {
                return { mime: 'video/mp4', type: 'video', ext: 'mp4' };
            }
            if (brand === 'qt  ' || brand.startsWith('M4A')) {
                return { mime: 'video/quicktime', type: 'video', ext: 'mov' };
            }
            // Generic MP4-like
            return { mime: 'video/mp4', type: 'video', ext: 'mp4' };
        }
        if (this.checkSignature(data, FILE_SIGNATURES.WEBM)) return { mime: 'video/webm', type: 'video', ext: 'webm' };
        if (this.checkSignature(data, FILE_SIGNATURES.RIFF) && this.checkSignature(data.subarray(8), FILE_SIGNATURES.AVI)) return { mime: 'video/avi', type: 'video', ext: 'avi' };

        // Text check
        if (this.isText(data)) {
            // Check if JSON
            try {
                const text = new TextDecoder().decode(data);
                const json = JSON.parse(text);
                if (typeof json === 'object' && json !== null) {
                    return { mime: 'application/json', type: 'json', ext: 'json' };
                }
            } catch (e) {
                // Not JSON
            }
            return { mime: 'text/plain', type: 'text', ext: 'txt' };
        }

        return { mime: 'application/octet-stream', type: 'binary', ext: 'bin' };
    }

    checkSignature(data, signature) {
        if (data.length < signature.length) return false;
        for (let i = 0; i < signature.length; i++) {
            if (data[i] !== signature[i]) return false;
        }
        return true;
    }

    isText(data) {
        if (data.length === 0) return true;
        // Simple heuristic: check for null bytes or extensive control characters in the first KB
        const sample = data.subarray(0, Math.min(data.length, 1024));
        let controlChars = 0;

        for (let i = 0; i < sample.length; i++) {
            const byte = sample[i];
            if (byte === 0) return false; // Null byte -> likely binary
            if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
                controlChars++;
            }
        }

        // If more than 10% are control chars, assume binary
        return (controlChars / sample.length) < 0.1;
    }

    renderPreview(data, type, { text: decodedText } = {}) {
        if (type.type === 'image') {
            // Image preview using object URL
            const blob = new Blob([data], { type: type.mime });
            this.currentObjectUrl = URL.createObjectURL(blob);
            const img = document.createElement('img');
            img.src = this.currentObjectUrl;
            img.style.maxWidth = '100%';
            img.style.maxHeight = '100%';
            img.style.objectFit = 'contain';
            img.style.boxShadow = '0 0 10px rgba(0,0,0,0.5)';
            this.previewContainer.appendChild(img);
        } else if (type.type === 'audio') {
            // Audio preview with native controls
            const blob = new Blob([data], { type: type.mime });
            this.currentObjectUrl = URL.createObjectURL(blob);

            const wrapper = document.createElement('div');
            wrapper.className = 'empty-view';
            wrapper.style.gap = '16px';

            const icon = document.createElement('span');
            icon.className = 'codicon codicon-play-circle';
            icon.style.fontSize = '48px';
            icon.style.opacity = '0.5';

            const label = document.createElement('span');
            label.textContent = `Audio File (${type.ext.toUpperCase()})`;
            label.style.marginBottom = '8px';

            const audio = document.createElement('audio');
            audio.controls = true;
            audio.src = this.currentObjectUrl;
            audio.style.width = '100%';
            audio.style.maxWidth = '400px';

            wrapper.appendChild(icon);
            wrapper.appendChild(label);
            wrapper.appendChild(audio);
            this.previewContainer.appendChild(wrapper);
        } else if (type.type === 'video') {
            // Video preview with native controls
            const blob = new Blob([data], { type: type.mime });
            this.currentObjectUrl = URL.createObjectURL(blob);

            const video = document.createElement('video');
            video.controls = true;
            video.src = this.currentObjectUrl;
            video.style.maxWidth = '100%';
            video.style.maxHeight = '100%';
            video.style.objectFit = 'contain';
            video.style.boxShadow = '0 0 10px rgba(0,0,0,0.5)';

            this.previewContainer.appendChild(video);
        } else if (type.type === 'text' || type.type === 'json') {
            const text = decodedText ?? new TextDecoder().decode(data);
            const pre = document.createElement('pre');
            if (type.type === 'json') {
                try {
                    pre.textContent = JSON.stringify(JSON.parse(text), null, 2);
                } catch {
                    pre.textContent = text;
                }
            } else {
                pre.textContent = text;
            }
            pre.style.whiteSpace = 'pre-wrap';
            pre.style.wordBreak = 'break-all';
            pre.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
            pre.style.fontSize = 'var(--vscode-editor-font-size, 13px)';
            pre.style.color = 'var(--text-primary)';
            pre.style.width = '100%';
            pre.style.height = '100%';
            pre.style.overflow = 'auto';
            this.previewContainer.appendChild(pre);
        } else if (type.type === 'pdf') {
             // VS Code webview sandbox does not support inline PDF rendering.
             // Show file info and a download button that uses the VS Code save dialog.
             const container = document.createElement('div');
             container.className = 'empty-view';

             const icon = document.createElement('span');
             icon.className = 'codicon codicon-file-pdf';
             icon.style.fontSize = '48px';
             icon.style.opacity = '0.5';

             const text = document.createElement('span');
             text.style.marginTop = '12px';
             text.textContent = `PDF Document (${this.formatSize(data.byteLength)})`;

             const dlBtn = document.createElement('button');
             dlBtn.className = 'btn-primary';
             dlBtn.style.marginTop = '12px';
             dlBtn.textContent = 'Download to view';
             dlBtn.addEventListener('click', () => this.download());

             container.appendChild(icon);
             container.appendChild(text);
             container.appendChild(dlBtn);

             this.previewContainer.appendChild(container);
        } else {
            const div = document.createElement('div');
            div.className = 'empty-view';

            const icon = document.createElement('span');
            icon.className = 'codicon codicon-file-binary';
            icon.style.fontSize = '48px';
            icon.style.opacity = '0.5';

            const text = document.createElement('span');
            text.style.marginTop = '12px';
            text.textContent = 'Binary Data';

            const subtext = document.createElement('span');
            subtext.style.fontSize = '12px';
            subtext.style.opacity = '0.7';
            subtext.textContent = 'Use Hex view to inspect';

            div.appendChild(icon);
            div.appendChild(text);
            div.appendChild(subtext);

            this.previewContainer.appendChild(div);
        }
    }

    renderHex(data) {
        if (!this.hexContainer) return;

        // Generate hex dump (limit to reasonable size for performance)
        const limit = 16 * 1000; // Show first ~16KB
        let output = '';
        const view = data.subarray(0, limit);

        for (let i = 0; i < view.length; i += 16) {
            const offset = i.toString(16).padStart(8, '0');
            const bytes = [];
            const chars = [];

            for (let j = 0; j < 16; j++) {
                if (i + j < view.length) {
                    const b = view[i + j];
                    bytes.push(b.toString(16).padStart(2, '0'));
                    chars.push(b >= 32 && b <= 126 ? String.fromCharCode(b) : '.');
                } else {
                    bytes.push('  ');
                    chars.push(' ');
                }
            }

            // Format: Offset  Hex Bytes  ASCII
            const hexPart1 = bytes.slice(0, 8).join(' ');
            const hexPart2 = bytes.slice(8).join(' ');
            const asciiPart = chars.join('');

            output += `${offset}  ${hexPart1}  ${hexPart2}  |${asciiPart}|\n`;
        }

        if (data.length > limit) {
            output += `\n... (${(data.length - limit).toLocaleString()} more bytes not shown)`;
        }

        this.hexContainer.value = output;
    }

    formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}
