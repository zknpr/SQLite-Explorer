/**
 * CRUD Operations (Create, Delete Rows/Columns/Tables)
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { updateStatus, updateToolbarButtons } from './ui.js';
import { openModal, closeModal } from './modals.js';
import { loadTableData, loadTableColumns } from './grid.js';
import { refreshSchema } from './sidebar.js';
import { escapeHtml, validateRowId, escapeIdentifier } from './utils.js';

export function initCrud() {
    // --- Toolbar Buttons ---
    document.getElementById('btnAddRow')?.addEventListener('click', openAddRowModal);
    document.getElementById('btnDeleteRows')?.addEventListener('click', openDeleteModal);
    document.getElementById('btnAddColumn')?.addEventListener('click', openAddColumnModal);

    // Add Row (Modal Submit)
    document.getElementById('btnSubmitAddRow')?.addEventListener('click', submitAddRow);

    // Delete
    document.getElementById('btnSubmitDelete')?.addEventListener('click', submitDelete);

    // Create Table
    document.getElementById('btnSubmitCreateTable')?.addEventListener('click', submitCreateTable);
    document.getElementById('btnAddColumnDef')?.addEventListener('click', () => addColumnDefinition());

    // Delegation for removing column definitions
    document.getElementById('columnDefinitions')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-remove-col');
        if (btn) {
            const colId = btn.dataset.colid;
            removeColumnDefinition(colId);
        }
    });

    // Add Column
    document.getElementById('btnSubmitAddColumn')?.addEventListener('click', submitAddColumn);
}

// ================================================================
// ADD ROW
// ================================================================

export function openAddRowModal() {
    if (!state.selectedTable || state.selectedTableType !== 'table') return;

    const form = document.getElementById('addRowForm');
    form.replaceChildren(); // Clear existing content

    state.tableColumns.forEach(col => {
        const isRequired = col.notnull === 1 && !col.isPrimaryKey;

        const div = document.createElement('div');
        div.className = 'form-field';

        const label = document.createElement('label');
        label.textContent = col.name;

        if (isRequired) {
            const reqSpan = document.createElement('span');
            reqSpan.style.color = 'var(--error-color)';
            reqSpan.textContent = '*';
            label.appendChild(document.createTextNode(' '));
            label.appendChild(reqSpan);
        }

        const typeSpan = document.createElement('span');
        typeSpan.style.opacity = '0.5';
        typeSpan.textContent = ` (${col.type})`;
        label.appendChild(document.createTextNode(' '));
        label.appendChild(typeSpan);

        const input = document.createElement('input');
        input.type = 'text';
        input.dataset.column = col.name;
        input.dataset.required = isRequired.toString();

        if (col.isPrimaryKey) {
            input.placeholder = 'Auto (Primary Key)';
            input.disabled = true;
        } else if (isRequired) {
            input.placeholder = 'Required';
        } else {
            input.placeholder = 'NULL';
        }

        div.appendChild(label);
        div.appendChild(input);
        form.appendChild(div);
    });

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
        const result = await backendApi.deleteColumns(state.selectedTable, columnNames);

        // If user cancelled the operation (e.g., declined to drop dependent indexes), don't reload
        if (result && result.cancelled) {
            updateStatus('Delete cancelled');
            closeModal('deleteModal');
            return;
        }

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
// CREATE TABLE
// ================================================================

let columnDefCounter = 0;

export function openCreateTableModal() {
    document.getElementById('newTableName').value = '';
    const container = document.getElementById('columnDefinitions');
    container.replaceChildren();
    columnDefCounter = 0;
    addColumnDefinition(true);
    openModal('createTableModal');
}

export function addColumnDefinition(isFirst = false) {
    const container = document.getElementById('columnDefinitions');
    const colId = ++columnDefCounter;

    const rowDiv = document.createElement('div');
    rowDiv.className = 'column-def-row';
    rowDiv.id = `colDef_${colId}`;
    Object.assign(rowDiv.style, {
        display: 'flex',
        gap: '8px',
        marginBottom: '8px',
        alignItems: 'center'
    });

    // Name Input
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Column name';
    nameInput.className = 'col-name';
    nameInput.style.flex = '2';
    if (isFirst) nameInput.value = 'id';
    rowDiv.appendChild(nameInput);

    // Type Select
    const typeSelect = document.createElement('select');
    typeSelect.className = 'col-type';
    typeSelect.style.flex = '1';
    ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC'].forEach(type => {
        const option = document.createElement('option');
        option.value = type;
        option.textContent = type;
        if (isFirst && type === 'INTEGER') option.selected = true;
        if (!isFirst && type === 'TEXT') option.selected = true;
        typeSelect.appendChild(option);
    });
    rowDiv.appendChild(typeSelect);

    // PK Checkbox
    const pkLabel = document.createElement('label');
    Object.assign(pkLabel.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        cursor: 'pointer'
    });
    const pkInput = document.createElement('input');
    pkInput.type = 'checkbox';
    pkInput.className = 'col-pk';
    pkInput.style.margin = '0';
    if (isFirst) pkInput.checked = true;
    pkLabel.appendChild(pkInput);
    pkLabel.appendChild(document.createTextNode(' PK'));
    rowDiv.appendChild(pkLabel);

    // NN Checkbox
    const nnLabel = document.createElement('label');
    Object.assign(nnLabel.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        cursor: 'pointer'
    });
    const nnInput = document.createElement('input');
    nnInput.type = 'checkbox';
    nnInput.className = 'col-nn';
    nnInput.style.margin = '0';
    nnLabel.appendChild(nnInput);
    nnLabel.appendChild(document.createTextNode(' NN'));
    rowDiv.appendChild(nnLabel);

    // Remove Button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'icon-button btn-remove-col';
    removeBtn.dataset.colid = colId.toString();
    removeBtn.title = 'Remove';
    if (isFirst) removeBtn.disabled = true;

    const iconSpan = document.createElement('span');
    iconSpan.className = 'codicon codicon-close';
    removeBtn.appendChild(iconSpan);

    rowDiv.appendChild(removeBtn);

    container.appendChild(rowDiv);
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

        colDefs.push({
            name: name,
            type: type,
            primaryKey: isPK,
            notNull: isNN
        });
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
