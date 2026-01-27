/**
 * Sidebar and Schema Logic
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { escapeHtml } from './utils.js';
import { updateStatus } from './ui.js';
import { loadTableData, loadTableColumns } from './grid.js';
import { getRowDataOffset, getRowId } from './data-utils.js';

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

export function updateBatchSidebar() {
    const title = document.getElementById('batchUpdateSectionTitle');
    const list = document.getElementById('batchUpdateList');
    const countBadge = document.getElementById('batchUpdateCount');
    const fieldsContainer = document.getElementById('batchUpdateFields');

    if (!title || !list || !countBadge || !fieldsContainer) return;

    const cellCount = state.selectedCells.length;

    if (cellCount === 0) {
        title.classList.add('hidden');
        list.classList.add('hidden');
        return;
    }

    title.classList.remove('hidden');
    list.classList.remove('hidden');
    title.classList.remove('collapsed');

    countBadge.textContent = cellCount;

    // Analyze selected cells - Group by column
    const columns = new Map();

    for (const cell of state.selectedCells) {
        if (!columns.has(cell.colIdx)) {
            const colDef = state.tableColumns[cell.colIdx];
            columns.set(cell.colIdx, {
                name: colDef.name,
                type: colDef.type,
                values: new Set()
            });
        }
        columns.get(cell.colIdx).values.add(cell.value);
    }

    let html = '';

    for (const [colIdx, colInfo] of columns) {
        const uniqueValues = Array.from(colInfo.values);
        const isMixed = uniqueValues.length > 1;

        let valueDisplay = '';
        if (isMixed) {
            valueDisplay = '(mixed values)';
        } else {
            const val = uniqueValues[0];
            if (val === null) valueDisplay = 'NULL';
            else if (val instanceof Uint8Array) valueDisplay = '[BLOB]';
            else valueDisplay = String(val);
        }

        html += `
            <div class="form-field batch-field" data-colidx="${colIdx}" style="margin-bottom:8px">
                <label style="font-size:11px; color:var(--text-secondary)">${escapeHtml(colInfo.name)} <span style="opacity:0.7">${colInfo.type || ''}</span></label>
                <div style="display:flex; gap:4px">
                    <input type="text" class="batch-input" placeholder="${escapeHtml(valueDisplay)}" data-colidx="${colIdx}" style="flex:1; min-width:0">
                    <button class="btn-secondary" style="padding:2px 6px;" title="Set to NULL" onclick="setBatchNull(${colIdx})">NULL</button>
                    <button class="btn-secondary" style="padding:2px 6px;" title="JSON Patch" onclick="toggleBatchPatch(${colIdx}, this)">{}</button>
                </div>
            </div>
        `;
    }

    fieldsContainer.innerHTML = html;
}

export async function applyBatchUpdate() {
    if (state.selectedCells.length === 0) return;

    const inputs = document.querySelectorAll('.batch-input');
    const updates = [];

    // Map inputs by column index for O(1) lookup
    const inputsByCol = new Map();
    for (const input of inputs) {
        inputsByCol.set(parseInt(input.dataset.colidx, 10), input);
    }

    // Process all selected cells
    // This is O(N) where N is number of selected cells
    for (const cell of state.selectedCells) {
        const input = inputsByCol.get(cell.colIdx);
        if (!input) continue;

        const isNull = input.dataset.isnull === 'true';
        const isPatch = input.dataset.ispatch === 'true';
        const value = input.value;

        // Skip if empty and not explicitly set to NULL (and not patch with content)
        if (value === "" && !isNull) continue;

        const colDef = state.tableColumns[cell.colIdx];

        // Prepare value
        let finalValue = value;
        let operation = 'set';

        if (isNull) {
            finalValue = null;
        } else if (isPatch) {
            operation = 'json_patch';
            // Validate JSON
            try {
                // If it's a patch, validation happens once per input ideally,
                // but here we do it per cell unless we cache it.
                // Given we're optimizing, let's trust the input loop?
                // Actually, let's just parse it. JSON.parse is fast enough for typical patch sizes.
                JSON.parse(value);
            } catch (e) {
                // We should ideally validate before this loop.
                // But for now, just abort or skip.
                // Since this is inside the loop, we might show error multiple times if we're not careful.
                // Let's validate inputs FIRST.
                continue;
            }
        } else {
             // Basic type coercion
             if (colDef.type === 'INTEGER' || colDef.type === 'REAL' || colDef.type === 'NUMERIC') {
                 if (!isNaN(Number(value)) && value.trim() !== '') {
                     finalValue = Number(value);
                 }
             }
        }

        updates.push({
            rowId: cell.rowId,
            column: colDef.name,
            value: finalValue,
            originalValue: cell.value,
            operation,
            rowIdx: cell.rowIdx, // Local metadata
            colIdx: cell.colIdx  // Local metadata
        });
    }

    // Pre-validate JSON patches to avoid issues in the loop above
    for (const input of inputs) {
        if (input.dataset.ispatch === 'true') {
            try {
                JSON.parse(input.value);
            } catch (e) {
                const colIdx = parseInt(input.dataset.colidx, 10);
                const colDef = state.tableColumns[colIdx];
                updateStatus(`Invalid JSON for patch in ${colDef.name}`);
                return;
            }
        }
    }

    if (updates.length === 0) {
        updateStatus('No values entered for batch update');
        return;
    }

    try {
        updateStatus(`Updating ${updates.length} cells...`);
        const label = `Batch update ${updates.length} cells`;

        // Strip extra metadata for backend
        const backendUpdates = updates.map(u => ({
            rowId: u.rowId,
            column: u.column,
            value: u.value,
            originalValue: u.originalValue,
            operation: u.operation
        }));

        await backendApi.updateCellBatch(state.selectedTable, backendUpdates, label);

        // Update local grid data
        // For JSON patch, we don't know the new value without re-querying or implementing patch logic locally.
        // Easiest is to reload.
        const hasPatch = updates.some(u => u.operation === 'json_patch');

        if (!hasPatch) {
            for (const u of updates) {
                state.gridData[u.rowIdx][u.colIdx + getRowDataOffset()] = u.value;
            }
        }

        // Refresh grid and sidebar
        await loadTableData(false);

        // If we kept selection, update values in selectedCells
        // This is tricky if we don't have the new values from backend (for patches).
        // Since we reloaded table data, `state.gridData` is fresh.
        // We can re-populate `state.selectedCells` from `state.gridData` based on indices/rowIds?
        // `loadTableData` preserves scroll but not selection logic?
        // `grid.js` `loadTableData`:
        // `renderDataGrid` uses `state.selectedCells`.
        // But `state.selectedCells` has stale values.

        // We should refresh `state.selectedCells` values from fresh `state.gridData`.
        const freshSelectedCells = [];
        for (const oldCell of state.selectedCells) {
            // Find corresponding row in new gridData
            // If pagination/sort changed, indices might be wrong, but we didn't change those.
            // However, we re-fetched, so rows might have moved if we sorted by the column we updated?
            // Assuming stable order for now.
            const newValue = state.gridData[oldCell.rowIdx][oldCell.colIdx + getRowDataOffset()];
            freshSelectedCells.push({ ...oldCell, value: newValue });
        }
        state.selectedCells = freshSelectedCells;

        updateBatchSidebar();

        updateStatus('Batch update completed');

    } catch (err) {
        console.error('Batch update failed:', err);
        updateStatus(`Batch update failed: ${err.message}`);
    }
}

export function setBatchNull(colIdx) {
    const input = document.querySelector(`.batch-input[data-colidx="${colIdx}"]`);
    const btn = document.querySelector(`.batch-field[data-colidx="${colIdx}"] button[title="JSON Patch"]`);

    if (input) {
        input.value = '';
        input.placeholder = 'SET TO NULL';
        input.dataset.isnull = 'true';
        input.dataset.ispatch = 'false';
        input.style.fontStyle = 'italic';
        if (btn) {
            btn.style.background = '';
            btn.style.color = '';
        }
    }
}

export function toggleBatchPatch(colIdx, btn) {
    const input = document.querySelector(`.batch-input[data-colidx="${colIdx}"]`);
    if (input) {
        const isPatch = input.dataset.ispatch === 'true';

        if (!isPatch) {
            input.dataset.ispatch = 'true';
            input.dataset.isnull = 'false';
            input.placeholder = 'JSON Patch (e.g. {"a": 1})';
            input.style.fontStyle = 'normal';
            btn.style.background = 'var(--accent-color)';
            btn.style.color = 'white';
        } else {
            input.dataset.ispatch = 'false';
            input.placeholder = '(mixed values)';
            btn.style.background = '';
            btn.style.color = '';
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
