import { backendApi } from './api.js';
import { state } from './state.js';
import { getRowDataOffset } from './data-utils.js';
import { updateStatus } from './ui.js';


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

export class BlobInspector {
    constructor() {
        this.currentObjectUrl = null;
        this.modal = document.getElementById('blob-inspector-modal');
        this.previewContainer = document.getElementById('tab-preview');
        this.hexContainer = document.querySelector('.hex-dump');
        this.infoContainer = document.getElementById('blob-info');

        this.currentData = null;
        this.currentType = null;
        this.currentRowId = null;
        this.currentColName = null;
        this.currentCellInfo = null;

        // Track upload state to prevent multiple concurrent uploads and enable proper cleanup
        this.isUploading = false;

        this.setupEventListeners();
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

        if (replaceBtn) {
            replaceBtn.disabled = state.isReadOnly || uploading;
            replaceBtn.textContent = uploading ? 'Uploading...' : 'Replace';
        }
        if (downloadBtn) {
            downloadBtn.disabled = uploading;
        }
    }

    async handleReplace() {
        // Prevent concurrent uploads
        if (state.isReadOnly || this.isUploading) return;

        try {
            // Check fileOperations setting to determine behavior
            const settings = await backendApi.getExtensionSettings();
            const fileOperations = settings?.fileOperations || 'native';

            if (fileOperations === 'web') {
                // Web mode: Use file input
                this.showFileInput();
            } else {
                // Native mode: Use VS Code API to select file
                // NOTE: Use backendApi directly because it has the proper serialize/deserialize
                // layer for Uint8Array data, ensuring consistent handling across all callers.
                const result = await backendApi.selectFile();
                if (result) {
                    // Data should already be a Uint8Array after deserialization
                    let data = result.data;
                    if (!(data instanceof Uint8Array)) {
                        // Fallback: Convert array-like object or array to Uint8Array
                        if (Array.isArray(data)) {
                            data = new Uint8Array(data);
                        } else if (data && typeof data === 'object') {
                            // Object with numeric keys like {0: 255, 1: 128, ...}
                            const values = Object.keys(data)
                                .filter(k => !isNaN(parseInt(k, 10)))
                                .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
                                .map(k => data[k]);
                            data = new Uint8Array(values);
                        }
                    }

                    // Mock a File object for uploadFile
                    const file = {
                        name: result.name,
                        arrayBuffer: async () => data.buffer
                    };
                    await this.uploadFile(file);
                }
            }
        } catch (err) {
            console.error('Replace failed:', err);
            updateStatus(`Replace failed: ${err.message}`);
        }
    }

    /**
     * Show file input for web mode
     */
    showFileInput() {
        const input = document.createElement('input');
        input.type = 'file';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (file) {
                await this.uploadFile(file);
            }
        };
        input.click();
    }

    async uploadFile(file) {
        if (!this.currentRowId || !this.currentColName) return;
        if (state.isReadOnly || this.isUploading) return;

        this.setUploadState(true);

        try {
            updateStatus(`Reading ${file.name}...`);
            const buffer = await file.arrayBuffer();
            const uint8Array = new Uint8Array(buffer);

            const sizeMB = uint8Array.length / (1024 * 1024);

            // Reject files larger than 50MB to prevent extension freeze
            const MAX_BLOB_SIZE_MB = 50;
            if (sizeMB > MAX_BLOB_SIZE_MB) {
                throw new Error(`File too large (${sizeMB.toFixed(1)}MB). Maximum size is ${MAX_BLOB_SIZE_MB}MB to prevent freezing.`);
            }

            // Warn about moderately large files
            if (sizeMB > 10) {
                updateStatus(`Uploading ${file.name} (${sizeMB.toFixed(1)}MB - this may take a moment)...`);
            } else {
                updateStatus(`Uploading ${file.name}...`);
            }

            const { rowIdx, colIdx } = this.currentCellInfo;
            const originalValue = this.currentData;

            await backendApi.updateCell(
                state.selectedTable,
                this.currentRowId,
                this.currentColName,
                uint8Array,
                originalValue
            );

            // Update Local State
            if (state.gridData && state.gridData[rowIdx]) {
                state.gridData[rowIdx][colIdx + getRowDataOffset()] = uint8Array;
            }

            // Update Inspector UI
            this.inspect(uint8Array, this.currentRowId, this.currentColName, rowIdx, colIdx);

            updateStatus(`Replaced with ${file.name}`);

        } catch (err) {
            console.error('Replace failed:', err);
            // Provide helpful error message for timeouts
            let errorMessage = err.message || String(err);
            if (errorMessage.includes('timeout')) {
                errorMessage = 'Upload timed out. Try a smaller file or increase the timeout.';
            }
            updateStatus(`Replace failed: ${errorMessage}`);
        } finally {
            // Always reset upload state to restore UI functionality
            this.setUploadState(false);
        }
    }

    close() {
        this.modal.classList.add('hidden');
        this.cleanup();
    }

    cleanup() {
        // Reset upload state to ensure buttons are re-enabled
        this.setUploadState(false);

        if (this.currentObjectUrl) {
            URL.revokeObjectURL(this.currentObjectUrl);
            this.currentObjectUrl = null;
        }
        this.previewContainer.innerHTML = '';
        this.hexContainer.value = '';
        this.infoContainer.textContent = '';
        this.currentData = null;
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

        let ext = this.currentType?.ext || 'bin';
        let filename = `blob_${this.currentRowId}.${ext}`;

        try {
            // Check fileOperations setting to determine behavior
            const settings = await backendApi.getExtensionSettings();
            const fileOperations = settings?.fileOperations || 'native';

            if (fileOperations === 'web') {
                // Web mode: Use browser download
                this.downloadBlob(this.currentData, filename);
                updateStatus(`Downloaded ${filename}`);
            } else {
                // Native mode: Use VS Code API to save file via backendApi
                await backendApi.saveFile(filename, this.currentData);
                updateStatus(`Saved ${filename}`);
            }
        } catch (err) {
            console.error('Download failed:', err);
            updateStatus(`Download failed: ${err.message}`);
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
        a.click();
        URL.revokeObjectURL(url);
    }

    inspect(blobData, rowId, colName, rowIdx, colIdx) {
        this.cleanup();

        // Store metadata
        this.currentRowId = rowId;
        this.currentColName = colName;
        this.currentCellInfo = { rowIdx, colIdx };

        // Show modal
        this.modal.classList.remove('hidden');

        // Reset tabs to preview
        this.switchTab('preview');

        // Ensure we have a Uint8Array
        const data = blobData instanceof Uint8Array ? blobData : new Uint8Array(blobData);
        this.currentData = data;

        // Detect type
        const type = this.detectType(data);
        this.currentType = type;
        const size = this.formatSize(data.length);

        this.infoContainer.textContent = `${colName} (Row ${rowId}) | ${type.mime || 'Unknown Type'} | ${size}`;

        // Render Preview
        this.renderPreview(data, type);

        // Render Hex
        this.renderHex(data);
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

    renderPreview(data, type) {
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
            const text = new TextDecoder().decode(data);
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
