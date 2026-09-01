/**
 * Sidebar and Schema Logic
 */
import { createSafeColumnState, state, persistState } from './state.js';
import { backendApi } from './api.js';
import {
    showErrorState,
    showEmptyState,
    showLoading,
    updateStatus,
    updateToolbarButtons
} from './ui.js';
import { clearSelection, loadTableData, loadTableColumns } from './grid.js';
import {
    getCellMutationBlockReason,
    getCellValueForDisplay,
    getBatchSelectionEligibility,
    getRowDataOffset,
    clearExactIntegerText,
    clearOversizedCellMetadata,
    resolveDisplayedCell
} from './data-utils.js';
import { updateSelectionStates } from './grid-selection.js';
import { openCreateTableModal } from './crud.js';
import { openSettingsModal } from './settings.js';
import { openCreateViewModal, openEditViewModal, dropViewFromSidebar } from './views.js';
import { groupSelectedCellsByColumn, summarizeColumnValue, prepareBatchUpdates } from './batch-update-logic.js';
import { applyConnectionResult } from './connection-state.js';
import { invalidateAllCounts, noteCellValuesChanged } from './count-cache.js';
import { closeDatabaseTargetModals } from './modals.js';
import { getErrorMessage } from './utils.js';

let isApplyingBatchUpdate = false;
let activeSchemaLoadToken = 0;
let isReloadingFromDisk = false;

function cellSelectionSignature() {
    return state.selectedCells.map(cell => (
        `${typeof cell.rowId}:${String(cell.rowId)}\u0000${cell.colIdx}`
    )).join('\u0001');
}

export function initSidebar() {
    const sidebarPanel = document.getElementById('sidebarPanel');
    if (!sidebarPanel) return;

    // Sidebar filter: update state and re-render on each keystroke
    const sidebarFilterInput = document.getElementById('sidebarFilterInput');
    if (sidebarFilterInput) {
        sidebarFilterInput.addEventListener('input', () => {
            state.sidebarFilter = sidebarFilterInput.value;
            renderSidebar();
            persistState();
        });
    }

    // Batch fields are rebuilt whenever the selection changes. Delegation keeps
    // the explicit NULL mode from surviving once the user types a real value.
    sidebarPanel.addEventListener('input', (event) => {
        const input = event.target?.closest?.('.batch-input');
        if (!input) return;
        if (input.dataset.mode !== 'patch') {
            input.dataset.mode = 'value';
            input.dataset.isnull = 'false';
            input.dataset.ispatch = 'false';
            input.placeholder = input.dataset.valuePlaceholder || '(mixed values)';
        }
        input.style.fontStyle = 'normal';
    });

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
        const listItem = target.closest('.list-item-select')?.closest('.list-item');
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
        const sectionToggle = target.closest('.section-toggle, #batchUpdateSectionTitle');
        if (sectionToggle) {
            const section = sectionToggle.dataset.section;
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

        const emptyBtn = target.closest('.btn-batch-empty');
        if (emptyBtn) {
            const field = emptyBtn.closest('.batch-field');
            if (field) {
                const colIdx = parseInt(field.dataset.colidx, 10);
                setBatchEmpty(colIdx);
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

export function syncSelectedTableIdentity() {
    state.selectedTableIdentity = state.selectedTableType === 'table'
        ? state.schemaCache.tables.find(table => table.name === state.selectedTable)?.identity ?? null
        : null;
}

export async function refreshSchema() {
    if (!state.isDbConnected) return false;

    const loadToken = ++activeSchemaLoadToken;

    try {
        const schema = await backendApi.fetchSchema();
        if (loadToken !== activeSchemaLoadToken) return false;

        state.schemaCache.tables = (schema.tables || []).map(t => ({
            name: t.identifier,
            ...(t.identity ? { identity: t.identity } : {})
        }));
        state.schemaCache.views = (schema.views || []).map(v => ({ name: v.identifier }));
        state.schemaCache.indexes = (schema.indexes || []).map(i => ({ name: i.identifier, table: i.parentTable }));
        syncSelectedTableIdentity();

        renderSidebar();
        return true;
    } catch (err) {
        if (loadToken !== activeSchemaLoadToken) return false;
        console.error('Error loading schema:', err);
        updateStatus('Error loading schema');
        throw err;
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
        li.className = 'list-item empty';
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

        const selectButton = document.createElement('button');
        selectButton.type = 'button';
        selectButton.className = 'list-item-select';
        selectButton.setAttribute('aria-label', `Open ${type} ${item.name}`);
        if (state.selectedTable === item.name && state.selectedTableType === type) {
            selectButton.setAttribute('aria-current', 'true');
        }

        const icon = document.createElement('span');
        icon.className = `item-icon codicon ${iconClass}`;
        selectButton.appendChild(icon);

        const nameSpan = document.createElement('span');
        nameSpan.className = 'item-name';
        nameSpan.textContent = item.name;
        selectButton.appendChild(nameSpan);
        li.appendChild(selectButton);

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
        li.className = 'list-item empty';
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
    const applyButton = document.getElementById('btnApplyBatchUpdate');

    const eligibility = getBatchSelectionEligibility();
    const cellCount = eligibility.cells.length;

    if (state.selectedCells.length === 0) {
        title.classList.add('hidden');
        list.classList.add('hidden');
        countBadge.textContent = '0';
        fieldsContainer.replaceChildren();
        title.title = '';
        if (applyButton) applyButton.disabled = true;
        return;
    }

    title.classList.remove('hidden');
    list.classList.remove('hidden');
    title.classList.remove('collapsed');
    title.setAttribute?.('aria-expanded', 'true');

    countBadge.textContent = cellCount;
    if (applyButton) {
        applyButton.disabled = state.isReadOnly || isApplyingBatchUpdate || cellCount === 0;
    }

    // Analyze selected cells - group by column (see batch-update-logic.js)
    const visibleCells = eligibility.cells.map(cell => {
        const row = state.gridData[cell.rowIdx];
        return row
            ? { ...cell, value: getCellValueForDisplay(row, cell.rowIdx, cell.colIdx) }
            : cell;
    });
    const columns = groupSelectedCellsByColumn(visibleCells, state.tableColumns);

    fieldsContainer.replaceChildren();
    const fragment = document.createDocumentFragment();

    if (eligibility.readOnlyCount > 0) {
        const notice = document.createElement('div');
        notice.className = 'batch-selection-notice';
        Object.assign(notice.style, {
            marginBottom: '8px',
            color: 'var(--text-secondary)',
            fontSize: '11px'
        });
        notice.textContent =
            `${eligibility.readOnlyCount} read-only selected cell${eligibility.readOnlyCount === 1 ? '' : 's'} excluded: ${eligibility.readOnlyReason}`;
        fragment.appendChild(notice);
        title.title = notice.textContent;
    } else {
        title.title = '';
    }

    for (const [colIdx, colInfo] of columns) {
        const valueDisplay = summarizeColumnValue(colInfo.values);

        const div = document.createElement('div');
        div.className = 'form-field batch-field';
        div.dataset.colidx = colIdx;
        div.style.marginBottom = '8px';

        const label = document.createElement('label');
        label.style.fontSize = '11px';
        label.style.color = 'var(--text-secondary)';
        const inputId = `batchInput_${colIdx}`;
        label.htmlFor = inputId;

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
        input.id = inputId;
        input.className = 'batch-input';
        input.placeholder = valueDisplay;
        input.dataset.colidx = colIdx;
        input.dataset.valuePlaceholder = valueDisplay;
        input.dataset.mode = 'unchanged';
        input.dataset.isnull = 'false';
        input.dataset.ispatch = 'false';
        input.style.flex = '1';
        input.style.minWidth = '0';
        controlsDiv.appendChild(input);

        const nullBtn = document.createElement('button');
        nullBtn.type = 'button';
        nullBtn.className = 'btn-secondary btn-batch-null';
        nullBtn.style.padding = '2px 6px';
        nullBtn.title = 'Set to NULL';
        nullBtn.ariaLabel = `Set ${colInfo.name} to NULL`;
        nullBtn.textContent = 'NULL';
        nullBtn.disabled = colInfo.notnull === 1;
        controlsDiv.appendChild(nullBtn);

        const emptyBtn = document.createElement('button');
        emptyBtn.type = 'button';
        emptyBtn.className = 'btn-secondary btn-batch-empty';
        emptyBtn.style.padding = '2px 6px';
        emptyBtn.title = 'Set to an empty string';
        emptyBtn.ariaLabel = `Set ${colInfo.name} to empty string`;
        emptyBtn.textContent = 'Empty';
        controlsDiv.appendChild(emptyBtn);

        const patchBtn = document.createElement('button');
        patchBtn.type = 'button';
        patchBtn.className = 'btn-secondary btn-batch-patch';
        patchBtn.style.padding = '2px 6px';
        patchBtn.title = 'JSON Patch';
        patchBtn.ariaLabel = `Apply JSON patch to ${colInfo.name}`;
        patchBtn.textContent = '{}';
        controlsDiv.appendChild(patchBtn);

        div.appendChild(controlsDiv);
        fragment.appendChild(div);
    }
    fieldsContainer.appendChild(fragment);
}

export async function applyBatchUpdate() {
    if (isApplyingBatchUpdate || state.selectedCells.length === 0) return;
    const eligibility = getBatchSelectionEligibility();
    if (eligibility.cells.length === 0) {
        updateStatus(`Batch update unavailable: ${eligibility.readOnlyReason}`);
        return;
    }
    for (const cell of eligibility.cells) {
        const mutationBlockReason = getCellMutationBlockReason(cell.rowIdx, cell.colIdx);
        if (mutationBlockReason) {
            updateStatus(mutationBlockReason);
            return;
        }
    }

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
    const updates = prepareBatchUpdates(
        eligibility.cells,
        inputsByCol,
        state.tableColumns,
        state.selectedTableIdentity?.kind === 'primaryKey'
    );

    if (updates.length === 0) {
        updateStatus('No values entered for batch update');
        return;
    }

    // Snapshot the target so the count-cache note below can never be applied
    // to a table the user switched to while the batch RPC was in flight.
    const targetTable = state.selectedTable;
    const targetSelectionSignature = cellSelectionSignature();
    isApplyingBatchUpdate = true;
    const applyButton = document.getElementById('btnApplyBatchUpdate');
    if (applyButton) applyButton.disabled = true;

    try {
        const cellCountLabel = `${updates.length} cell${updates.length === 1 ? '' : 's'}`;
        updateStatus(`Updating ${cellCountLabel}...`);
        const label = `Batch update ${cellCountLabel}`;

        // Strip extra metadata for backend
        const backendUpdates = updates.map(u => ({
            rowId: u.rowId,
            column: u.column,
            value: u.value,
            originalValue: u.originalValue,
            operation: u.operation
        }));

        const outcomes = await backendApi.updateCellBatch(targetTable, backendUpdates, label);
        // Edited values may enter/leave an active filter's match set, so the
        // table's cached filtered counts are no longer trustworthy.
        noteCellValuesChanged(targetTable);
        const identityChanges = new Map();
        for (const outcome of outcomes ?? []) {
            if (outcome.newRowId === undefined || outcome.newRowId === outcome.rowId) continue;
            const existing = identityChanges.get(outcome.rowId);
            if (existing !== undefined && existing !== outcome.newRowId) {
                throw new Error('Batch update returned inconsistent row identities');
            }
            identityChanges.set(outcome.rowId, outcome.newRowId);
        }
        // The RPC belongs to the snapshotted table. A table switch can expose
        // opaque identities with identical strings, so never apply table A's
        // remap to table B's selection or pins.
        if (state.selectedTable === targetTable) {
            for (const identities of [state.selectedRowIds, state.pinnedRowIds]) {
                for (const [oldIdentity, newIdentity] of identityChanges) {
                    if (identities.delete(oldIdentity)) identities.add(newIdentity);
                }
            }
        }
        const stillOnTargetTable = state.selectedTable === targetTable;
        // Update local grid data by stable row/column identity. Page reloads
        // and sort changes can move both indices while the RPC is pending.
        const hasPatch = updates.some(u => u.operation === 'json_patch');

        if (stillOnTargetTable && !hasPatch) {
            for (const u of updates) {
                const outcome = (outcomes ?? []).find(candidate => (
                    candidate.rowId === u.rowId && candidate.columnName === u.column
                ));
                const currentCell = resolveDisplayedCell(
                    targetTable,
                    outcome?.newRowId ?? u.rowId,
                    u.column
                ) ?? resolveDisplayedCell(targetTable, u.rowId, u.column);
                if (!currentCell) continue;
                state.gridData[currentCell.rowIdx][currentCell.colIdx + getRowDataOffset()] = u.value;
                clearExactIntegerText(currentCell.rowIdx, currentCell.colIdx);
                clearOversizedCellMetadata(currentCell.rowIdx, currentCell.colIdx);
            }
        }

        // Applying the batch ends the selection gesture. Clear both halves of
        // the cell/column selection before replacing the grid so the DOM diff
        // cache removes the old body and header highlights together.
        if (stillOnTargetTable && cellSelectionSignature() === targetSelectionSignature) {
            state.selectedCells = [];
            state.selectedColumns.clear();
            state.lastSelectedCell = null;
            state.lastSelectedColumnIndex = null;
            updateSelectionStates();
            updateToolbarButtons();
        }

        // A PK edit can move the row in the table's default ordering.
        if (stillOnTargetTable) await loadTableData(false);

        if (state.selectedTable === targetTable) {
            updateStatus(eligibility.readOnlyCount > 0
                ? `Batch update completed; excluded ${eligibility.readOnlyCount} read-only selected cell${eligibility.readOnlyCount === 1 ? '' : 's'}`
                : 'Batch update completed');
        }

    } catch (err) {
        console.error('Batch update failed:', err);
        if (state.selectedTable === targetTable) {
            updateStatus(`Batch update failed: ${getErrorMessage(err)}`);
        }
    } finally {
        isApplyingBatchUpdate = false;
        updateBatchSidebar();
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
        input.dataset.mode = 'null';
        input.style.fontStyle = 'italic';
        if (btn) {
            btn.style.background = '';
            btn.style.color = '';
        }
    }
}

export function setBatchEmpty(colIdx) {
    const input = document.querySelector(`.batch-input[data-colidx="${colIdx}"]`);
    const patchBtn = document.querySelector(
        `.batch-field[data-colidx="${colIdx}"] .btn-batch-patch`
    );
    if (!input) return;
    input.value = '';
    input.placeholder = 'SET TO EMPTY STRING';
    input.dataset.mode = 'value';
    input.dataset.isnull = 'false';
    input.dataset.ispatch = 'false';
    input.style.fontStyle = 'italic';
    if (patchBtn) {
        patchBtn.style.background = '';
        patchBtn.style.color = '';
    }
}

export function toggleBatchPatch(colIdx, btn) {
    const input = document.querySelector(`.batch-input[data-colidx="${colIdx}"]`);
    if (input) {
        const isPatch = input.dataset.ispatch === 'true';

        if (!isPatch) {
            input.dataset.ispatch = 'true';
            input.dataset.isnull = 'false';
            input.dataset.mode = 'patch';
            input.placeholder = 'JSON Patch (e.g. {"a": 1})';
            input.style.fontStyle = 'normal';
            btn.style.background = 'var(--accent-color)';
            btn.style.color = 'white';
        } else {
            input.dataset.ispatch = 'false';
            input.dataset.mode = input.value === '' ? 'unchanged' : 'value';
            input.placeholder = input.dataset.valuePlaceholder || '(mixed values)';
            btn.style.background = '';
            btn.style.color = '';
        }
    }
}

export function toggleSection(section) {
    const list = document.getElementById(`${section}List`);
    const toggle = document.querySelector(`[data-section="${section}"]`);
    const title = toggle?.classList?.contains('section-title')
        ? toggle
        : toggle?.closest?.('.section-title');

    if (list && title) {
        list.classList.toggle('hidden');
        title.classList.toggle('collapsed');
        toggle.setAttribute?.('aria-expanded', String(!list.classList.contains('hidden')));
    }
}

export async function selectTableItem(name, type) {
    // Drop every cached count, not just the target's: views project other
    // tables and triggers/cascades can fan a mutation out, so counts cached
    // for objects other than the one being edited are only sound while the
    // selection cannot have observed such a change — which ends here. A
    // switch's first load fetches its count in parallel with data, so this
    // costs no extra latency class.
    invalidateAllCounts();
    state.selectedTable = name;
    state.selectedTableType = type;
    syncSelectedTableIdentity();
    state.currentPageIndex = 0;
    state.sortedColumn = null;
    state.sortAscending = true;
    state.filterQuery = '';
    state.columnFilters = createSafeColumnState();
    if (state.filterTimer !== null) clearTimeout(state.filterTimer);
    state.filterTimer = null;
    state.filterApplyPending = false;
    state.filterApplyTable = null;
    state.filterPendingAction = null;
    state.selectedRowIds.clear();
    state.selectedCells = [];
    state.lastSelectedCell = null;
    state.lastSelectedColumnIndex = null;
    state.lastSelectedRowIndex = null;
    state.selectedColumns.clear();
    state.pinnedColumns.clear();
    state.pinnedRowIds.clear();
    state.columnWidths = createSafeColumnState(); // Reset widths for new table
    state.scrollPosition = { top: 0, left: 0 };
    // The mounted grid belongs to the previous table until both metadata and
    // rows for this selection commit. Remove every index/identity sidecar now,
    // before the first await, so old DOM cannot issue an edit against `name`.
    state.tableColumns = [];
    state.gridData = [];
    state.gridExactIntegerTexts = {};
    state.gridOversizedCells = {};
    state.gridReadOnlyRowReasons = {};
    state.keysetAnchors = null;
    state.renderedTable = null;
    state.editingCellInfo = null;
    state.activeCellInput = null;
    showLoading();
    updateToolbarButtons();

    // Update UI
    renderSidebar();
    // The cell selection was just cleared; hide the Batch Update panel with it
    // now, synchronously — the loads below can fail before any commit-time
    // refresh, which would leave the previous table's staged columns on screen.
    updateBatchSidebar();

    const tableNameLabel = document.getElementById('tableNameLabel');
    if (tableNameLabel) tableNameLabel.textContent = name;

    const filterInput = document.getElementById('filterInput');
    if (filterInput) filterInput.value = '';
    const clearFilterButton = document.getElementById('btnClearFilter');
    if (clearFilterButton) clearFilterButton.hidden = true;

    if (!await loadTableColumns()) {
        if (state.selectedTable === name && state.selectedTableType === type) {
            showErrorState('Unable to load table columns');
            updateToolbarButtons();
        }
        return;
    }
    if (state.selectedTable !== name || state.selectedTableType !== type) return;
    await loadTableData(true, false);
    if (state.selectedTable !== name || state.selectedTableType !== type) return;
    persistState();
}

export async function reloadFromDisk() {
    if (!state.isDbConnected || isReloadingFromDisk) return;

    isReloadingFromDisk = true;

    try {
        updateStatus('Reloading...');
        // The reload exists to pick up changes this webview didn't make, so
        // no cached count survives it.
        invalidateAllCounts();
        const connectionResult = await backendApi.refreshFile();
        if (connectionResult?.cancelled) {
            updateStatus('Reload cancelled');
            return;
        }
        if (connectionResult?.connected === true) {
            applyConnectionResult(connectionResult);
            closeDatabaseTargetModals({ connectionReplaced: true });
        }
        // The successful reopen has replaced the logical database even when
        // table names and rowids collide. Clear generation-bound identity state
        // in this promise continuation, before the browser can dispatch another
        // input event against the newly active connection.
        clearSelection();
        state.pinnedRowIds.clear();
        state.pinnedColumns.clear();
        state.tableColumns = [];
        state.gridData = [];
        state.gridExactIntegerTexts = {};
        state.gridOversizedCells = {};
        state.gridReadOnlyRowReasons = {};
        state.keysetAnchors = null;
        state.renderedTable = null;
        state.editingCellInfo = null;
        state.activeCellInput = null;
        showLoading();
        updateToolbarButtons();
        persistState();
        if (!await refreshSchema()) return;
        const selectedObjectExists = state.schemaCache.tables.some(
            table => table.name === state.selectedTable
        ) || state.schemaCache.views.some(view => view.name === state.selectedTable);
        if (state.selectedTable && !selectedObjectExists) {
            state.selectedTable = null;
            state.selectedTableType = null;
            state.selectedTableIdentity = null;
            const tableNameLabel = document.getElementById('tableNameLabel');
            if (tableNameLabel) tableNameLabel.textContent = 'No table selected';
            showEmptyState();
            updateToolbarButtons();
            persistState();
            updateStatus(connectionResult?.cancelled ? 'Reload cancelled' : 'Reloaded');
            return;
        }
        if (state.selectedTable) {
            if (!await loadTableColumns()) return;
            if (!await loadTableData()) return;
        }
        updateStatus(connectionResult?.cancelled ? 'Reload cancelled' : 'Reloaded');
    } catch (err) {
        console.error('Reload failed:', err);
        const message = getErrorMessage(err);
        if (err?.name === 'Canceled' || err?.name === 'CancellationError' || /^cancel(?:led|ed)$/i.test(message)) {
            updateStatus('Reload cancelled');
        } else {
            updateStatus(`Reload failed: ${message}`);
        }
    } finally {
        isReloadingFromDisk = false;
    }
}
