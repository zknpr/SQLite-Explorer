/**
 * CRUD Operations (Create, Delete Rows/Columns/Tables)
 */
import { state } from './state.js';
import { backendApi } from './rpc.js';
import { updateStatus, updateToolbarButtons } from './ui.js';
import { openModal, closeModal } from './modals.js';
import { loadTableData, loadTableColumns } from './grid.js';
import { refreshSchema } from './sidebar.js';
import { escapeHtml, validateRowId, escapeIdentifier } from './utils.js';

// ================================================================
// ADD ROW
// ================================================================

export function openAddRowModal() {
    if (!state.selectedTable || state.selectedTableType !== 'table') return;

    const form = document.getElementById('addRowForm');
    form.innerHTML = state.tableColumns.map(col => {
        const isRequired = col.notnull === 1 && !col.isPrimaryKey;
        const requiredLabel = isRequired ? ' <span style="color: var(--error-color)">*</span>' : '';
        return `
        <div class="form-field">
            <label>${escapeHtml(col.name)}${requiredLabel} <span style="opacity:0.5">(${col.type})</span></label>
            <input type="text" data-column="${escapeHtml(col.name)}" data-required="${isRequired}" placeholder="${col.isPrimaryKey ? 'Auto (Primary Key)' : (isRequired ? 'Required' : 'NULL')}" ${col.isPrimaryKey ? 'disabled' : ''}>
        </div>
    `;
    }).join('');

    openModal('addRowModal');
}

export async function submitAddRow() {
    const inputs = document.querySelectorAll('#addRowForm input[data-column]:not([disabled])');
    const missingRequired = [];

    // Validate
    for (const input of inputs) {
        const colName = input.dataset.column;
        const value = input.value.trim();
        const isRequired = input.dataset.required === 'true';

        if (isRequired && (value === '' || value.toLowerCase() === 'null')) {
            missingRequired.push(colName);
            input.style.borderColor = 'var(--error-color)';
        } else {
            input.style.borderColor = '';
        }
    }

    if (missingRequired.length > 0) {
        updateStatus(`Required fields missing: ${missingRequired.join(', ')}`);
        return;
    }

    // Build data object
    const rowData = {};
    for (const input of inputs) {
        const colName = input.dataset.column;
        const value = input.value.trim();

        if (value !== '') {
            if (value.toLowerCase() === 'null') {
                rowData[colName] = null;
            } else if (!isNaN(Number(value)) && value !== '') {
                rowData[colName] = Number(value);
            } else {
                rowData[colName] = value;
            }
        }
    }

    try {
        updateStatus('Inserting row...');
        await backendApi.insertRow(state.selectedTable, rowData);

        closeModal('addRowModal');
        await loadTableData();
        updateStatus('Row inserted - Ctrl+S to save');

    } catch (err) {
        console.error('Insert failed:', err);
        updateStatus(`Error: ${err.message}`);
    }
}

// ================================================================
// DELETE ROWS/COLUMNS
// ================================================================

export function openDeleteModal() {
    if (state.selectedColumns.size > 0) {
        const columnNames = Array.from(state.selectedColumns);
        document.getElementById('deleteConfirmText').textContent =
            `Are you sure you want to delete ${columnNames.length} column${columnNames.length > 1 ? 's' : ''} (${columnNames.join(', ')})?` +
            ` This will permanently remove the column${columnNames.length > 1 ? 's' : ''} and all their data.`;
    } else if (state.selectedRowIds.size > 0) {
        document.getElementById('deleteConfirmText').textContent =
            `Are you sure you want to delete ${state.selectedRowIds.size} row${state.selectedRowIds.size > 1 ? 's' : ''}?`;
    } else {
        return;
    }
    openModal('deleteModal');
}

export async function submitDelete() {
    if (state.selectedColumns.size > 0) {
        await submitDeleteColumns();
    } else if (state.selectedRowIds.size > 0) {
        await submitDeleteRows();
    }
}

async function submitDeleteRows() {
    if (state.selectedRowIds.size === 0) return;

    const rowIds = Array.from(state.selectedRowIds);
    // Validation happens in HostBridge/backend now but good to be type-safe here?
    // They are stored as numbers in state mostly.

    try {
        updateStatus('Deleting rows...');
        await backendApi.deleteRows(state.selectedTable, rowIds);

        closeModal('deleteModal');
        state.selectedRowIds.clear();
        await loadTableData();
        updateToolbarButtons();
        updateStatus(`Deleted ${rowIds.length} row${rowIds.length > 1 ? 's' : ''} - Ctrl+S to save`);

    } catch (err) {
        console.error('Delete rows failed:', err);
        updateStatus(`Error: ${err.message}`);
    }
}

async function submitDeleteColumns() {
    if (state.selectedColumns.size === 0) return;

    const columnNames = Array.from(state.selectedColumns);

    try {
        updateStatus('Deleting columns...');
        await backendApi.deleteColumns(state.selectedTable, columnNames);

        closeModal('deleteModal');
        state.selectedColumns.clear();
        state.selectedCells = [];
        state.lastSelectedCell = null;

        await refreshSchema();
        await loadTableColumns();
        await loadTableData();
        updateToolbarButtons();
        updateStatus(`Deleted ${columnNames.length} column${columnNames.length > 1 ? 's' : ''} - Ctrl+S to save`);

    } catch (err) {
        console.error('Delete columns failed:', err);
        updateStatus(`Error: ${err.message}`);
    }
}

// ================================================================
// EXPORT
// ================================================================

export async function exportCurrentTable() {
    if (!state.selectedTable) return;
    await backendApi.exportTable({ table: state.selectedTable }, state.tableColumns.map(c => c.name));
}

// ================================================================
// CREATE TABLE
// ================================================================

let columnDefCounter = 0;

export function openCreateTableModal() {
    document.getElementById('newTableName').value = '';
    document.getElementById('columnDefinitions').innerHTML = '';
    columnDefCounter = 0;
    addColumnDefinition(true);
    openModal('createTableModal');
}

export function addColumnDefinition(isFirst = false) {
    const container = document.getElementById('columnDefinitions');
    const colId = ++columnDefCounter;

    const html = `
        <div class="column-def-row" id="colDef_${colId}" style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center;">
            <input type="text" placeholder="Column name" class="col-name" style="flex: 2;" value="${isFirst ? 'id' : ''}">
            <select class="col-type" style="flex: 1;">
                <option value="INTEGER" ${isFirst ? 'selected' : ''}>INTEGER</option>
                <option value="TEXT" ${!isFirst ? 'selected' : ''}>TEXT</option>
                <option value="REAL">REAL</option>
                <option value="BLOB">BLOB</option>
                <option value="NUMERIC">NUMERIC</option>
            </select>
            <label style="display: flex; align-items: center; gap: 4px;">
                <input type="checkbox" class="col-pk" ${isFirst ? 'checked' : ''}> PK
            </label>
            <label style="display: flex; align-items: center; gap: 4px;">
                <input type="checkbox" class="col-nn"> NN
            </label>
            <button class="icon-button" onclick="removeColumnDefinition(${colId})" title="Remove" ${isFirst ? 'disabled' : ''}>
                <span class="codicon codicon-close"></span>
            </button>
        </div>
    `;
    container.insertAdjacentHTML('beforeend', html);
}

export function removeColumnDefinition(colId) {
    const elem = document.getElementById(`colDef_${colId}`);
    if (elem) elem.remove();
}

export async function submitCreateTable() {
    const tableName = document.getElementById('newTableName').value.trim();

    if (!tableName) {
        updateStatus('Error: Table name is required');
        return;
    }

    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
        updateStatus('Error: Invalid table name');
        return;
    }

    const colDefs = [];
    const rows = document.querySelectorAll('.column-def-row');

    for (const row of rows) {
        const name = row.querySelector('.col-name').value.trim();
        const type = row.querySelector('.col-type').value;
        const isPK = row.querySelector('.col-pk').checked;
        const isNN = row.querySelector('.col-nn').checked;

        if (!name) continue;

        let def = `${escapeIdentifier(name)} ${type}`;
        if (isPK) def += ' PRIMARY KEY';
        if (isNN && !isPK) def += ' NOT NULL';
        colDefs.push(def);
    }

    if (colDefs.length === 0) {
        updateStatus('Error: At least one column is required');
        return;
    }

    try {
        updateStatus('Creating table...');
        await backendApi.createTable(tableName, colDefs);

        closeModal('createTableModal');
        await refreshSchema();
        updateStatus(`Table "${tableName}" created - Ctrl+S to save`);

    } catch (err) {
        console.error('Create table failed:', err);
        updateStatus(`Error: ${err.message}`);
    }
}

// ================================================================
// ADD COLUMN
// ================================================================

export function openAddColumnModal() {
    if (!state.selectedTable || state.selectedTableType !== 'table') return;

    document.getElementById('newColumnName').value = '';
    document.getElementById('newColumnType').value = 'TEXT';
    document.getElementById('newColumnDefault').value = '';

    openModal('addColumnModal');
}

export async function submitAddColumn() {
    const columnName = document.getElementById('newColumnName').value.trim();
    const columnType = document.getElementById('newColumnType').value;
    const defaultValue = document.getElementById('newColumnDefault').value.trim();

    if (!columnName) {
        updateStatus('Error: Column name is required');
        return;
    }

    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(columnName)) {
        updateStatus('Error: Invalid column name');
        return;
    }

    try {
        updateStatus('Adding column...');
        await backendApi.addColumn(state.selectedTable, columnName, columnType, defaultValue);

        closeModal('addColumnModal');
        await loadTableColumns();
        await loadTableData();
        updateStatus(`Column "${columnName}" added - Ctrl+S to save`);

    } catch (err) {
        console.error('Add column failed:', err);
        updateStatus(`Error: ${err.message}`);
    }
}
