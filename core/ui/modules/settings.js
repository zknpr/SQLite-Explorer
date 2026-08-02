/**
 * Settings and Pragma Editor Logic
 */
import { backendApi } from './api.js';
import { updateStatus } from './ui.js';
import { closeModal } from './modals.js';
import { state } from './state.js';

export function initSettings() {
    const container = document.getElementById('pragmaSettingsContainer');
    if (container) {
        container.addEventListener('change', (e) => {
            const target = e.target;
            if (target.matches('.setting-extension')) {
                const key = target.dataset.key;
                const value = target.type === 'checkbox' ? target.checked : target.value;
                updateExtensionSetting(key, value);
            } else if (target.matches('.setting-pragma')) {
                const name = target.dataset.name;
                const type = target.dataset.type; // 'number' or 'bool' or 'string'
                let value = target.value;

                if (type === 'number') {
                    value = Number(value);
                } else if (type === 'bool') {
                    value = value === 'true' ? 1 : 0;
                }

                updatePragma(name, value);
            }
        });
    }
}

export async function openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (modal) {
        modal.classList.remove('hidden');
        await loadPragmas();
    }
}

async function loadPragmas() {
    const container = document.getElementById('pragmaSettingsContainer');
    container.textContent = 'Loading settings...';

    try {
        const [pragmas, settings] = await Promise.all([
            backendApi.getPragmas(),
            backendApi.getExtensionSettings()
        ]);
        renderPragmaForm(pragmas, settings);
    } catch (err) {
        console.error('Failed to load settings:', err);
        container.textContent = `Error loading settings: ${err.message}`;
        container.style.color = 'var(--error-color)';
    }
}

function renderPragmaForm(pragmas, settings) {
    const container = document.getElementById('pragmaSettingsContainer');
    if (!container) return;

    // Helper to create select options
    const createOptions = (options, selected) => {
        return options.map(opt => {
            const optVal = String(opt);
            const selVal = String(selected);
            const isSelected = selVal.toUpperCase() === optVal.toUpperCase();
            const option = document.createElement('option');
            option.value = optVal;
            option.selected = isSelected;
            option.textContent = optVal;
            return option;
        });
    };

    container.replaceChildren();

    // Helper to append HTML structure
    const appendSection = (title) => {
        const div = document.createElement('div');
        div.className = 'setting-section-title';
        Object.assign(div.style, {
            fontWeight: '600',
            marginBottom: '8px',
            paddingBottom: '4px',
            borderBottom: '1px solid var(--border-color)'
        });
        div.textContent = title;
        container.appendChild(div);
    };

    const appendField = (labelStr, control, descStr) => {
        if (control.className?.includes('setting-pragma')) {
            control.disabled = state.isReadOnly;
        }
        const div = document.createElement('div');
        div.className = 'form-field';

        const label = document.createElement('label');
        if (control.type === 'checkbox') {
            Object.assign(label.style, { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' });
            control.style.margin = '0';
            label.appendChild(control);
            label.appendChild(document.createTextNode(labelStr));
            div.appendChild(label);
        } else {
            label.textContent = labelStr;
            div.appendChild(label);
            div.appendChild(control);
        }

        if (descStr) {
            const desc = document.createElement('div');
            desc.className = 'setting-desc';
            desc.textContent = descStr;
            div.appendChild(desc);
        }

        container.appendChild(div);
    };

    // Extension Settings Section
    if (container.children.length > 0) {
        const spacer = document.createElement('div');
        spacer.style.height = '16px';
        container.appendChild(spacer);
    }
    appendSection('Extension Settings');

    // Auto Commit
    const autoCommitInput = document.createElement('input');
    autoCommitInput.type = 'checkbox';
    autoCommitInput.className = 'setting-extension';
    autoCommitInput.dataset.key = 'autoCommit';
    autoCommitInput.checked = !!settings.autoCommit;
    appendField('Auto-Commit Changes', autoCommitInput, 'Automatically save changes to disk immediately. If disabled, you must save manually (Ctrl+S).');

    // Double Click Behavior
    const doubleClickSelect = document.createElement('select');
    doubleClickSelect.className = 'setting-extension';
    doubleClickSelect.dataset.key = 'doubleClickBehavior';
    createOptions(['inline', 'modal', 'vscode'], settings.cellEditBehavior).forEach(opt => doubleClickSelect.appendChild(opt));
    appendField('Double Click Behavior', doubleClickSelect, 'Action when double-clicking a cell');

    // Database Settings Section
    const spacer = document.createElement('div');
    spacer.style.height = '16px';
    container.appendChild(spacer);
    appendSection('SQLite Settings (Pragmas)');

    // Journal Mode
    const journalSelect = document.createElement('select');
    journalSelect.className = 'setting-pragma';
    journalSelect.dataset.name = 'journal_mode';
    createOptions(['DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'WAL', 'OFF'], pragmas.journal_mode).forEach(opt => journalSelect.appendChild(opt));
    appendField('Journal Mode', journalSelect, 'Database journaling mode (WAL is recommended for concurrency)');

    // Foreign Keys
    const fkSelect = document.createElement('select');
    fkSelect.className = 'setting-pragma';
    fkSelect.dataset.name = 'foreign_keys';
    fkSelect.dataset.type = 'bool';
    const fkOn = document.createElement('option'); fkOn.value = 'true'; fkOn.textContent = 'ON';
    const fkOff = document.createElement('option'); fkOff.value = 'false'; fkOff.textContent = 'OFF';
    if (Number(pragmas.foreign_keys) === 1) fkOn.selected = true; else fkOff.selected = true;
    fkSelect.appendChild(fkOn);
    fkSelect.appendChild(fkOff);
    appendField('Foreign Keys', fkSelect, 'Enforce foreign key constraints');

    // Synchronous
    const syncSelect = document.createElement('select');
    syncSelect.className = 'setting-pragma';
    syncSelect.dataset.name = 'synchronous';
    syncSelect.dataset.type = 'number';
    [
        {v:0, t:'OFF (0)'}, {v:1, t:'NORMAL (1)'}, {v:2, t:'FULL (2)'}, {v:3, t:'EXTRA (3)'}
    ].forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.v;
        opt.textContent = o.t;
        if (Number(pragmas.synchronous) === o.v) opt.selected = true;
        syncSelect.appendChild(opt);
    });
    appendField('Synchronous', syncSelect, 'Disk synchronization safety level');

    // Locking Mode
    const lockSelect = document.createElement('select');
    lockSelect.className = 'setting-pragma';
    lockSelect.dataset.name = 'locking_mode';
    createOptions(['NORMAL', 'EXCLUSIVE'], pragmas.locking_mode).forEach(opt => lockSelect.appendChild(opt));
    appendField('Locking Mode', lockSelect, '');

    // Auto Vacuum
    const vacSelect = document.createElement('select');
    vacSelect.className = 'setting-pragma';
    vacSelect.dataset.name = 'auto_vacuum';
    vacSelect.dataset.type = 'number';
    [
        {v:0, t:'NONE (0)'}, {v:1, t:'FULL (1)'}, {v:2, t:'INCREMENTAL (2)'}
    ].forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.v;
        opt.textContent = o.t;
        if (Number(pragmas.auto_vacuum) === o.v) opt.selected = true;
        vacSelect.appendChild(opt);
    });
    appendField('Auto Vacuum', vacSelect, '');

    // Cache Size
    const cacheInput = document.createElement('input');
    cacheInput.type = 'number';
    cacheInput.className = 'setting-pragma';
    cacheInput.dataset.name = 'cache_size';
    cacheInput.dataset.type = 'number';
    cacheInput.value = pragmas.cache_size;
    appendField('Cache Size', cacheInput, 'Number of pages (positive) or kilobytes (negative)');
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
