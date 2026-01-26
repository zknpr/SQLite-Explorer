/**
 * Settings and Pragma Editor Logic
 */
import { backendApi } from './api.js';
import { updateStatus } from './ui.js';
import { closeModal } from './modals.js';

export async function openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (modal) {
        modal.classList.remove('hidden');
        await loadPragmas();
    }
}

async function loadPragmas() {
    const container = document.getElementById('pragmaSettingsContainer');
    container.innerHTML = '<div class="loading-spinner"></div> Loading settings...';

    try {
        const [pragmas, settings] = await Promise.all([
            backendApi.getPragmas(),
            backendApi.getExtensionSettings()
        ]);
        renderPragmaForm(pragmas, settings);
    } catch (err) {
        console.error('Failed to load settings:', err);
        container.innerHTML = `<div style="color: var(--error-color)">Error loading settings: ${err.message}</div>`;
    }
}

function renderPragmaForm(pragmas, settings) {
    const container = document.getElementById('pragmaSettingsContainer');
    if (!container) return;

    // Helper to create select options
    const createOptions = (options, selected) => {
        return options.map(opt =>
            `<option value="${opt}" ${String(selected).toUpperCase() === String(opt).toUpperCase() ? 'selected' : ''}>${opt}</option>`
        ).join('');
    };

    let html = '';

    // Extension Settings Section
    html += `<div class="setting-section-title" style="font-weight:600;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--border-color)">Extension Settings</div>`;

    // Auto Commit
    html += `
        <div class="form-field">
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
                <input type="checkbox" ${settings.autoCommit ? 'checked' : ''} onchange="updateExtensionSetting('autoCommit', this.checked)" style="margin:0;">
                Auto-Commit Changes
            </label>
            <div class="setting-desc">Automatically save changes to disk immediately. If disabled, you must save manually (Ctrl+S).</div>
        </div>
    `;

    // Double Click Behavior
    html += `
        <div class="form-field">
            <label>Double Click Behavior</label>
            <select onchange="updateExtensionSetting('doubleClickBehavior', this.value)">
                ${createOptions(['inline', 'modal', 'vscode'], settings.cellEditBehavior)}
            </select>
            <div class="setting-desc">Action when double-clicking a cell</div>
        </div>
    `;

    // Database Settings Section
    html += `<div class="setting-section-title" style="font-weight:600;margin:16px 0 8px 0;padding-bottom:4px;border-bottom:1px solid var(--border-color)">SQLite Settings (Pragmas)</div>`;

    // Journal Mode
    html += `
        <div class="form-field">
            <label>Journal Mode</label>
            <select onchange="updatePragma('journal_mode', this.value)">
                ${createOptions(['DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'WAL', 'OFF'], pragmas.journal_mode)}
            </select>
            <div class="setting-desc">Database journaling mode (WAL is recommended for concurrency)</div>
        </div>
    `;

    // Foreign Keys
    html += `
        <div class="form-field">
            <label>Foreign Keys</label>
            <select onchange="updatePragma('foreign_keys', this.value === 'true' ? 1 : 0)">
                <option value="true" ${Number(pragmas.foreign_keys) === 1 ? 'selected' : ''}>ON</option>
                <option value="false" ${Number(pragmas.foreign_keys) === 0 ? 'selected' : ''}>OFF</option>
            </select>
            <div class="setting-desc">Enforce foreign key constraints</div>
        </div>
    `;

    // Synchronous
    html += `
        <div class="form-field">
            <label>Synchronous</label>
            <select onchange="updatePragma('synchronous', this.value)">
                <option value="0" ${Number(pragmas.synchronous) === 0 ? 'selected' : ''}>OFF (0)</option>
                <option value="1" ${Number(pragmas.synchronous) === 1 ? 'selected' : ''}>NORMAL (1)</option>
                <option value="2" ${Number(pragmas.synchronous) === 2 ? 'selected' : ''}>FULL (2)</option>
                <option value="3" ${Number(pragmas.synchronous) === 3 ? 'selected' : ''}>EXTRA (3)</option>
            </select>
            <div class="setting-desc">Disk synchronization safety level</div>
        </div>
    `;

    // Locking Mode
    html += `
        <div class="form-field">
            <label>Locking Mode</label>
            <select onchange="updatePragma('locking_mode', this.value)">
                ${createOptions(['NORMAL', 'EXCLUSIVE'], pragmas.locking_mode)}
            </select>
        </div>
    `;

    // Auto Vacuum
    html += `
        <div class="form-field">
            <label>Auto Vacuum</label>
            <select onchange="updatePragma('auto_vacuum', this.value)">
                <option value="0" ${Number(pragmas.auto_vacuum) === 0 ? 'selected' : ''}>NONE (0)</option>
                <option value="1" ${Number(pragmas.auto_vacuum) === 1 ? 'selected' : ''}>FULL (1)</option>
                <option value="2" ${Number(pragmas.auto_vacuum) === 2 ? 'selected' : ''}>INCREMENTAL (2)</option>
            </select>
        </div>
    `;

    // Cache Size
    html += `
        <div class="form-field">
            <label>Cache Size</label>
            <input type="number" value="${pragmas.cache_size}" onchange="updatePragma('cache_size', Number(this.value))">
            <div class="setting-desc">Number of pages (positive) or kilobytes (negative)</div>
        </div>
    `;

    container.innerHTML = html;
}

export async function updateExtensionSetting(key, value) {
    try {
        await backendApi.updateExtensionSetting(key, value);
        updateStatus(`Updated ${key}`);
    } catch (err) {
        console.error(`Failed to set ${key}:`, err);
        updateStatus(`Error: ${err.message}`);
        await loadPragmas();
    }
}

export async function updatePragma(name, value) {
    try {
        updateStatus(`Updating ${name}...`);
        await backendApi.setPragma(name, value);
        updateStatus(`Updated ${name}`);
        // Reload to verify (some pragmas normalize values)
        // await loadPragmas();
    } catch (err) {
        console.error(`Failed to set ${name}:`, err);
        updateStatus(`Error: ${err.message}`);
        // Reload to revert UI
        await loadPragmas();
    }
}
