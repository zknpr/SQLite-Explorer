/**
 * Sidebar and Schema Logic
 */
import { state } from './state.js';
import { backendApi } from './rpc.js';
import { escapeHtml } from './utils.js';
import { updateStatus } from './ui.js';
import { loadTableData, loadTableColumns } from './grid.js'; // Will define later

export async function refreshSchema() {
    if (!state.isDbConnected) return;

    try {
        const schema = await backendApi.fetchSchema();

        state.schemaCache.tables = (schema.tables || []).map(t => ({ name: t.identifier }));
        state.schemaCache.views = (schema.views || []).map(v => ({ name: v.identifier }));
        state.schemaCache.indexes = (schema.indexes || []).map(i => ({ name: i.identifier, table: i.parentTable }));

        renderSidebar();

    } catch (err) {
        console.error('Error loading schema:', err);
        updateStatus('Error loading schema');
    }
}

export function renderSidebar() {
    const tablesBadge = document.getElementById('tablesBadge');
    const viewsBadge = document.getElementById('viewsBadge');
    const indexesBadge = document.getElementById('indexesBadge');

    if (tablesBadge) tablesBadge.textContent = state.schemaCache.tables.length;
    if (viewsBadge) viewsBadge.textContent = state.schemaCache.views.length;
    if (indexesBadge) indexesBadge.textContent = state.schemaCache.indexes.length;

    const tablesList = document.getElementById('tablesList');
    if (tablesList) {
        if (state.schemaCache.tables.length === 0) {
            tablesList.innerHTML = '<li class="list-item" style="opacity:0.5">No tables</li>';
        } else {
            tablesList.innerHTML = state.schemaCache.tables.map(t => `
                <li class="list-item ${state.selectedTable === t.name && state.selectedTableType === 'table' ? 'selected' : ''}"
                    onclick="selectTableItem('${escapeHtml(t.name)}', 'table')"
                    title="${escapeHtml(t.name)}">
                    <span class="item-icon codicon codicon-table"></span>
                    <span class="item-name">${escapeHtml(t.name)}</span>
                </li>
            `).join('');
        }
    }

    const viewsList = document.getElementById('viewsList');
    if (viewsList) {
        if (state.schemaCache.views.length === 0) {
            viewsList.innerHTML = '<li class="list-item" style="opacity:0.5">No views</li>';
        } else {
            viewsList.innerHTML = state.schemaCache.views.map(v => `
                <li class="list-item ${state.selectedTable === v.name && state.selectedTableType === 'view' ? 'selected' : ''}"
                    onclick="selectTableItem('${escapeHtml(v.name)}', 'view')"
                    title="${escapeHtml(v.name)}">
                    <span class="item-icon codicon codicon-eye"></span>
                    <span class="item-name">${escapeHtml(v.name)}</span>
                </li>
            `).join('');
        }
    }

    const indexesList = document.getElementById('indexesList');
    if (indexesList) {
        if (state.schemaCache.indexes.length === 0) {
            indexesList.innerHTML = '<li class="list-item" style="opacity:0.5">No indexes</li>';
        } else {
            indexesList.innerHTML = state.schemaCache.indexes.map(i => `
                <li class="list-item" title="${escapeHtml(i.name)} on ${escapeHtml(i.table)}">
                    <span class="item-icon codicon codicon-list-selection"></span>
                    <div class="item-content">
                        <span class="item-name">${escapeHtml(i.name)}</span>
                        <span class="item-detail">${escapeHtml(i.table)}</span>
                    </div>
                </li>
            `).join('');
        }
    }
}

export function toggleSection(section) {
    const list = document.getElementById(`${section}List`);
    const title = document.querySelector(`.section-title[data-section="${section}"]`);

    if (list && title) {
        list.classList.toggle('hidden');
        title.classList.toggle('collapsed');
    }
}

export async function selectTableItem(name, type) {
    state.selectedTable = name;
    state.selectedTableType = type;
    state.currentPageIndex = 0;
    state.sortedColumn = null;
    state.sortAscending = true;
    state.filterQuery = '';
    state.columnFilters = {};
    state.selectedRowIds.clear();
    state.selectedCells = [];
    state.lastSelectedCell = null;
    state.selectedColumns.clear();
    state.pinnedColumns.clear();
    state.pinnedRowIds.clear();
    state.columnWidths = {}; // Reset widths for new table
    state.scrollPosition = { top: 0, left: 0 };

    // Update UI
    renderSidebar();

    const tableNameLabel = document.getElementById('tableNameLabel');
    if (tableNameLabel) tableNameLabel.textContent = name;

    const filterInput = document.getElementById('filterInput');
    if (filterInput) filterInput.value = '';

    await loadTableColumns();
    await loadTableData(true, false);
}

export async function reloadFromDisk() {
    if (!state.isDbConnected) return;

    try {
        updateStatus('Reloading...');
        await backendApi.refreshFile();
        await refreshSchema();
        if (state.selectedTable) {
            await loadTableColumns();
            await loadTableData();
        }
        updateStatus('Reloaded');
    } catch (err) {
        console.error('Reload failed:', err);
        updateStatus(`Reload failed: ${err.message}`);
    }
}
