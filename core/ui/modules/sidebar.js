/**
 * Sidebar and Schema Logic
 */
import { state, persistState } from './state.js';
import { backendApi } from './api.js';
import { updateStatus } from './ui.js';
import { loadTableData, loadTableColumns } from './grid.js';
import { getCellValueForDisplay, getRowDataOffset } from './data-utils.js';
import { openCreateTableModal } from './crud.js';
import { openSettingsModal } from './settings.js';
import { openCreateViewModal, openEditViewModal, dropViewFromSidebar } from './views.js';
import { groupSelectedCellsByColumn, summarizeColumnValue, prepareBatchUpdates } from './batch-update-logic.js';
import { applyConnectionResult } from './connection-state.js';

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

        // 3. Create View Button
        if (target.closest('#btnOpenCreateView')) {
            event.stopPropagation();
            openCreateViewModal();
            return;
        }

        const editViewButton = target.closest('.view-action-edit');
        if (editViewButton) {
            event.stopPropagation();
            const view = editViewButton.closest('.list-item')?.dataset.name;
            if (view) void openEditViewModal(view);
            return;
        }

        const dropViewButton = target.closest('.view-action-drop');
        if (dropViewButton) {
            event.stopPropagation();
            const view = dropViewButton.closest('.list-item')?.dataset.name;
            if (view) void dropViewFromSidebar(view);
            return;
        }

        // 4. Reload Button
        if (target.closest('#btnReload')) {
            reloadFromDisk();
            return;
        }

        // 5. Batch Update Apply
        if (target.closest('#btnApplyBatchUpdate')) {
            applyBatchUpdate();
            return;
        }

        // 6. Table/View Selection
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

        // 7. Section Toggling
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

        // 8. Batch Update Actions
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

function filterSchemaItems(items, filter) {
    if (!filter) return items;
    return items.filter(item => item.name.toLowerCase().includes(filter));
}

function updateBadge(badgeId, filteredCount, totalCount, isFiltered) {
    const badge = document.getElementById(badgeId);
    if (badge) {
        badge.textContent = isFiltered ? `${filteredCount}/${totalCount}` : totalCount;
    }
}

function renderSidebarList(listId, items, type, iconClass, emptyText) {
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

        if (type === 'view') {
            const actions = document.createElement('span');
            actions.className = 'view-item-actions';

            const editButton = document.createElement('button');
            editButton.type = 'button';
            editButton.className = 'icon-button view-action-edit';
            editButton.title = `Edit view ${item.name}`;
            editButton.setAttribute('aria-label', `Edit view ${item.name}`);
            editButton.disabled = state.isReadOnly;
            const editIcon = document.createElement('span');
            editIcon.className = 'codicon codicon-edit';
            editButton.appendChild(editIcon);

            const dropButton = document.createElement('button');
            dropButton.type = 'button';
            dropButton.className = 'icon-button view-action-drop';
            dropButton.title = `Drop view ${item.name}`;
            dropButton.setAttribute('aria-label', `Drop view ${item.name}`);
            dropButton.disabled = state.isReadOnly;
            const dropIcon = document.createElement('span');
            dropIcon.className = 'codicon codicon-trash';
            dropButton.appendChild(dropIcon);

            actions.appendChild(editButton);
            actions.appendChild(dropButton);
            li.appendChild(actions);
        }

        fragment.appendChild(li);
    });
    list.appendChild(fragment);
}

function renderIndexesList(listId, indexes, emptyText) {
    const indexesList = document.getElementById(listId);
    if (!indexesList) return;

    indexesList.replaceChildren();

    if (indexes.length === 0) {
        const li = document.createElement('li');
        li.className = 'list-item';
        li.style.opacity = '0.5';
        li.textContent = emptyText;
        indexesList.appendChild(li);
        return;
    }

    const fragment = document.createDocumentFragment();
    indexes.forEach(i => {
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

export function renderSidebar() {
    const filter = state.sidebarFilter.toLowerCase();
    const isFiltered = filter.length > 0;

    const filteredTables = filterSchemaItems(state.schemaCache.tables, filter);
    const filteredViews = filterSchemaItems(state.schemaCache.views, filter);
    const filteredIndexes = filterSchemaItems(state.schemaCache.indexes, filter);

    updateBadge('tablesBadge', filteredTables.length, state.schemaCache.tables.length, isFiltered);
    updateBadge('viewsBadge', filteredViews.length, state.schemaCache.views.length, isFiltered);
    updateBadge('indexesBadge', filteredIndexes.length, state.schemaCache.indexes.length, isFiltered);

    renderSidebarList('tablesList', filteredTables, 'table', 'codicon-table', filter ? 'No matching tables' : 'No tables');
    renderSidebarList('viewsList', filteredViews, 'view', 'codicon-eye', filter ? 'No matching views' : 'No views');
    renderIndexesList('indexesList', filteredIndexes, filter ? 'No matching indexes' : 'No indexes');
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

    // Analyze selected cells - group by column (see batch-update-logic.js)
    const visibleCells = state.selectedCells.map(cell => {
        const row = state.gridData[cell.rowIdx];
        return row
            ? { ...cell, value: getCellValueForDisplay(row, cell.rowIdx, cell.colIdx) }
            : cell;
    });
    const columns = groupSelectedCellsByColumn(visibleCells, state.tableColumns);

    fieldsContainer.replaceChildren();
    const fragment = document.createDocumentFragment();

    for (const [colIdx, colInfo] of columns) {
        const valueDisplay = summarizeColumnValue(colInfo.values);

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
        fragment.appendChild(div);
    }
    fieldsContainer.appendChild(fragment);
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
                updateStatus(`Invalid JSON for patch in ${colDef?.name ?? `column ${colIdx}`}`);
                return;
            }
        }
    }

    // 2. Processing Phase — value coercion / NULL / json_patch (see batch-update-logic.js)
    const updates = prepareBatchUpdates(state.selectedCells, inputsByCol, state.tableColumns);

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
    if (state.filterTimer !== null) clearTimeout(state.filterTimer);
    state.filterTimer = null;
    state.filterApplyPending = false;
    state.filterApplyTable = null;
    state.filterPendingAction = null;
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
    const clearFilterButton = document.getElementById('btnClearFilter');
    if (clearFilterButton) clearFilterButton.hidden = true;

    await loadTableColumns();
    await loadTableData(true, false);
    persistState();
}

export async function reloadFromDisk() {
    if (!state.isDbConnected) return;

    try {
        updateStatus('Reloading...');
        const connectionResult = await backendApi.refreshFile();
        if (connectionResult?.connected === true) {
            applyConnectionResult(connectionResult);
        }
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
