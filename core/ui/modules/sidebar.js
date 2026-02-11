/**
 * Sidebar and Schema Logic
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { escapeHtml } from './utils.js';
import { updateStatus } from './ui.js';
import { loadTableData, loadTableColumns } from './grid.js';
import { getRowDataOffset } from './data-utils.js';
import { openCreateTableModal } from './crud.js';
import { openSettingsModal } from './settings.js';

export function initSidebar() {
    const sidebarPanel = document.getElementById('sidebarPanel');
    if (!sidebarPanel) return;

    // Sidebar filter: update state and re-render on each keystroke
    const sidebarFilterInput = document.getElementById('sidebarFilterInput');
    if (sidebarFilterInput) {
        sidebarFilterInput.addEventListener('input', () => {
            state.sidebarFilter = sidebarFilterInput.value;
            renderSidebar();
        });
    }

    sidebarPanel.addEventListener('click', (event) => {
        const target = event.target;

        // 1. Configuration Button
        if (target.closest('#btnOpenSettings')) {
            openSettingsModal();
            return;
        }

        // 2. Create Table Button
        if (target.closest('#btnOpenCreateTable')) {
            event.stopPropagation();
            openCreateTableModal();
            return;
        }

        // 3. Reload Button
        if (target.closest('#btnReload')) {
            reloadFromDisk();
            return;
        }

        // 4. Batch Update Apply
        if (target.closest('#btnApplyBatchUpdate')) {
            applyBatchUpdate();
            return;
        }

        // 5. Table/View Selection
        const listItem = target.closest('.list-item');
        if (listItem) {
            // Check if it's a table/view item (has data attributes)
            const name = listItem.dataset.name;
            const type = listItem.dataset.type;

            if (name && type) {
                selectTableItem(name, type);
                return;
            }
        }

        // 6. Section Toggling
        // Check if we clicked the section header
        const sectionTitle = target.closest('.section-title');
        if (sectionTitle) {
            // Ignore clicks on buttons inside the header (e.g. Create Table) or settings
            if (target.closest('.icon-button') || sectionTitle.id === 'btnOpenSettings') return;

            const section = sectionTitle.dataset.section;
            if (section) {
                toggleSection(section);
            }
        }

        // 7. Batch Update Actions
        const nullBtn = target.closest('.btn-batch-null');
        if (nullBtn) {
            const field = nullBtn.closest('.batch-field');
            if (field) {
                const colIdx = parseInt(field.dataset.colidx, 10);
                setBatchNull(colIdx);
            }
            return;
        }

        const patchBtn = target.closest('.btn-batch-patch');
        if (patchBtn) {
            const field = patchBtn.closest('.batch-field');
            if (field) {
                const colIdx = parseInt(field.dataset.colidx, 10);
                toggleBatchPatch(colIdx, patchBtn);
            }
            return;
        }
    });
}

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

    // Apply sidebar filter (case-insensitive substring match)
    const filter = state.sidebarFilter.toLowerCase();
    const filteredTables = filter
        ? state.schemaCache.tables.filter(t => t.name.toLowerCase().includes(filter))
        : state.schemaCache.tables;
    const filteredViews = filter
        ? state.schemaCache.views.filter(v => v.name.toLowerCase().includes(filter))
        : state.schemaCache.views;
    const filteredIndexes = filter
        ? state.schemaCache.indexes.filter(i => i.name.toLowerCase().includes(filter))
        : state.schemaCache.indexes;

    // Update badge counts: show "filtered/total" when filtering, otherwise just total
    if (tablesBadge) {
        tablesBadge.textContent = filter
            ? `${filteredTables.length}/${state.schemaCache.tables.length}`
            : state.schemaCache.tables.length;
    }
    if (viewsBadge) {
        viewsBadge.textContent = filter
            ? `${filteredViews.length}/${state.schemaCache.views.length}`
            : state.schemaCache.views.length;
    }
    if (indexesBadge) {
        indexesBadge.textContent = filter
            ? `${filteredIndexes.length}/${state.schemaCache.indexes.length}`
            : state.schemaCache.indexes.length;
    }

    // Helper to render list
    const renderList = (listId, items, type, iconClass, emptyText) => {
        const list = document.getElementById(listId);
        if (!list) return;

        list.replaceChildren(); // Clear list

        if (items.length === 0) {
            const li = document.createElement('li');
            li.className = 'list-item';
            li.style.opacity = '0.5';
            li.textContent = emptyText;
            list.appendChild(li);
            return;
        }

        const fragment = document.createDocumentFragment();
        items.forEach(item => {
            const li = document.createElement('li');
            li.className = 'list-item';
            if (state.selectedTable === item.name && state.selectedTableType === type) {
                li.classList.add('selected');
            }
            // Data attributes for delegation
            li.dataset.name = item.name;
            if (type) li.dataset.type = type;
            li.title = item.name;

            const icon = document.createElement('span');
            icon.className = `item-icon codicon ${iconClass}`;
            li.appendChild(icon);

            const nameSpan = document.createElement('span');
            nameSpan.className = 'item-name';
            nameSpan.textContent = item.name;
            li.appendChild(nameSpan);

            fragment.appendChild(li);
        });
        list.appendChild(fragment);
    };

    renderList('tablesList', filteredTables, 'table', 'codicon-table', filter ? 'No matching tables' : 'No tables');
    renderList('viewsList', filteredViews, 'view', 'codicon-eye', filter ? 'No matching views' : 'No views');

    const indexesList = document.getElementById('indexesList');
    if (indexesList) {
        indexesList.replaceChildren();
        if (filteredIndexes.length === 0) {
            const li = document.createElement('li');
            li.className = 'list-item';
            li.style.opacity = '0.5';
            li.textContent = filter ? 'No matching indexes' : 'No indexes';
            indexesList.appendChild(li);
        } else {
            const fragment = document.createDocumentFragment();
            filteredIndexes.forEach(i => {
                const li = document.createElement('li');
                li.className = 'list-item';
                li.title = `${i.name} on ${i.table}`;

                const icon = document.createElement('span');
                icon.className = 'item-icon codicon codicon-list-selection';
                li.appendChild(icon);

                const content = document.createElement('div');
                content.className = 'item-content';

                const nameSpan = document.createElement('span');
                nameSpan.className = 'item-name';
                nameSpan.textContent = i.name;
                content.appendChild(nameSpan);

                const detailSpan = document.createElement('span');
                detailSpan.className = 'item-detail';
                detailSpan.textContent = i.table;
                content.appendChild(detailSpan);

                li.appendChild(content);
                fragment.appendChild(li);
            });
            indexesList.appendChild(fragment);
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

    fieldsContainer.replaceChildren();

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

        const div = document.createElement('div');
        div.className = 'form-field batch-field';
        div.dataset.colidx = colIdx;
        div.style.marginBottom = '8px';

        const label = document.createElement('label');
        label.style.fontSize = '11px';
        label.style.color = 'var(--text-secondary)';

        const nameText = document.createTextNode(colInfo.name + ' ');
        label.appendChild(nameText);

        const typeSpan = document.createElement('span');
        typeSpan.style.opacity = '0.7';
        typeSpan.textContent = colInfo.type || '';
        label.appendChild(typeSpan);

        div.appendChild(label);

        const controlsDiv = document.createElement('div');
        controlsDiv.style.display = 'flex';
        controlsDiv.style.gap = '4px';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'batch-input';
        input.placeholder = valueDisplay;
        input.dataset.colidx = colIdx;
        input.style.flex = '1';
        input.style.minWidth = '0';
        controlsDiv.appendChild(input);

        const nullBtn = document.createElement('button');
        nullBtn.className = 'btn-secondary btn-batch-null';
        nullBtn.style.padding = '2px 6px';
        nullBtn.title = 'Set to NULL';
        nullBtn.textContent = 'NULL';
        controlsDiv.appendChild(nullBtn);

        const patchBtn = document.createElement('button');
        patchBtn.className = 'btn-secondary btn-batch-patch';
        patchBtn.style.padding = '2px 6px';
        patchBtn.title = 'JSON Patch';
        patchBtn.textContent = '{}';
        controlsDiv.appendChild(patchBtn);

        div.appendChild(controlsDiv);
        fieldsContainer.appendChild(div);
    }
}

export async function applyBatchUpdate() {
    if (state.selectedCells.length === 0) return;

    const inputs = document.querySelectorAll('.batch-input');

    // 1. Validation and Setup Phase
    const inputsByCol = new Map();
    for (const input of inputs) {
        const colIdx = parseInt(input.dataset.colidx, 10);
        inputsByCol.set(colIdx, input);

        if (input.dataset.ispatch === 'true') {
            try {
                JSON.parse(input.value);
            } catch (e) {
                const colDef = state.tableColumns[colIdx];
                updateStatus(`Invalid JSON for patch in ${colDef.name}`);
                return;
            }
        }
    }

    const updates = [];

    // 2. Processing Phase
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
        const hasPatch = updates.some(u => u.operation === 'json_patch');

        if (!hasPatch) {
            for (const u of updates) {
                state.gridData[u.rowIdx][u.colIdx + getRowDataOffset()] = u.value;
            }
        }

        // Refresh grid and sidebar
        await loadTableData(false);

        const freshSelectedCells = [];
        for (const oldCell of state.selectedCells) {
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
    const btn = document.querySelector(`.batch-field[data-colidx="${colIdx}"] .btn-batch-patch`);

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
