/**
 * CRUD Operations (Create, Delete Rows/Columns/Tables)
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { updateStatus, updateToolbarButtons } from './ui.js';
import { openModal, closeModal, registerModalCloseHandler } from './modals.js';
import { loadTableData, loadTableColumns } from './grid.js';
import { refreshSchema } from './sidebar.js';
import { getErrorMessage, parseGridInputValue } from './utils.js';
import { noteRowCountChanged, noteCellValuesChanged } from './count-cache.js';
import { getSelectedRowActionEligibility } from './data-utils.js';
import { assertUsableSqlIdentifier } from '../../../src/core/sql-utils.ts';

let isSubmittingAddRow = false;
let isSubmittingDelete = false;
let isSubmittingCreateTable = false;
let isSubmittingAddColumn = false;
let addRowSession = null;
let deleteSession = null;
let createTableSession = null;
let addColumnSession = null;

registerModalCloseHandler('addRowModal', () => {
    addRowSession = null;
});

registerModalCloseHandler('deleteModal', () => {
    deleteSession = null;
});

registerModalCloseHandler('createTableModal', () => {
    createTableSession = null;
});

registerModalCloseHandler('addColumnModal', () => {
    addColumnSession = null;
});

function snapshotAddRowSession() {
    return {
        table: state.selectedTable,
        tableType: state.selectedTableType,
        identityKind: state.selectedTableIdentity?.kind ?? null,
        connectionGeneration: state.connectionGeneration,
        contentGeneration: state.contentGeneration,
        columns: state.tableColumns.map(column => ({ ...column })),
        schemaSignature: JSON.stringify(state.tableColumns)
    };
}

function setOwnRowValue(row, column, value) {
    Object.defineProperty(row, column, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
    });
}

function isAutoRowidPrimaryKey(session, column) {
    // SQLite's inline `INTEGER PRIMARY KEY DESC` exception is indistinguishable
    // in table_xinfo but does not auto-generate this column. Trust the
    // backend's index-aware classification rather than re-inferring it here.
    return session.identityKind === 'rowid'
        && column.isPrimaryKey
        && column.isRowidAlias === true;
}

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

    addRowSession = snapshotAddRowSession();

    const form = document.getElementById('addRowForm');
    form.replaceChildren(); // Clear existing content

    addRowSession.columns.forEach((col, colIdx) => {
        const autoRowidPrimaryKey = isAutoRowidPrimaryKey(addRowSession, col);
        const hasDefault = col.dflt_value != null;
        const isRequired = !col.isGenerated
            && !autoRowidPrimaryKey
            && !hasDefault
            && col.notnull === 1;

        const div = document.createElement('div');
        div.className = 'form-field';

        const label = document.createElement('label');
        const inputId = `addRowField_${colIdx}`;
        label.htmlFor = inputId;
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
        input.id = inputId;
        input.dataset.column = col.name;
        input.dataset.required = isRequired.toString();
        input.dataset.mode = 'default';
        input.oninput = () => {
            input.dataset.mode = 'value';
            input.placeholder = input.dataset.valuePlaceholder || '';
            input.style.fontStyle = 'normal';
        };

        if (col.isGenerated) {
            input.placeholder = 'Generated (read-only)';
            input.disabled = true;
        } else if (autoRowidPrimaryKey) {
            input.placeholder = 'Auto (Primary Key)';
            input.disabled = true;
        } else if (isRequired) {
            input.placeholder = 'Required';
        } else if (hasDefault) {
            input.placeholder = `Default: ${col.dflt_value}`;
        } else {
            input.placeholder = 'Default (SQL NULL)';
        }
        input.dataset.valuePlaceholder = input.placeholder;

        div.appendChild(label);
        div.appendChild(input);

        if (!input.disabled) {
            const actions = document.createElement('div');
            actions.className = 'add-row-value-actions';

            const emptyButton = document.createElement('button');
            emptyButton.type = 'button';
            emptyButton.className = 'btn-secondary btn-add-row-empty';
            emptyButton.textContent = 'Empty string';
            emptyButton.onclick = () => {
                input.value = '';
                input.dataset.mode = 'value';
                input.placeholder = 'EMPTY STRING';
                input.style.fontStyle = 'italic';
            };
            actions.appendChild(emptyButton);

            const nullButton = document.createElement('button');
            nullButton.type = 'button';
            nullButton.className = 'btn-secondary btn-add-row-null';
            nullButton.textContent = 'SQL NULL';
            nullButton.disabled = col.notnull === 1;
            nullButton.title = nullButton.disabled
                ? 'This column does not allow SQL NULL'
                : 'Store SQL NULL explicitly';
            nullButton.onclick = () => {
                if (nullButton.disabled) return;
                input.value = '';
                input.dataset.mode = 'null';
                input.placeholder = 'SQL NULL';
                input.style.fontStyle = 'italic';
            };
            actions.appendChild(nullButton);
            div.appendChild(actions);
        }
        form.appendChild(div);
    });

    openModal('addRowModal');
}

export async function submitAddRow() {
    if (isSubmittingAddRow) return;
    isSubmittingAddRow = true;
    try {
        return await submitAddRowOnce();
    } finally {
        isSubmittingAddRow = false;
    }
}

async function submitAddRowOnce() {
    const ownedSession = addRowSession;
    const session = addRowSession ?? snapshotAddRowSession();
    const isCurrentSession = () => ownedSession === null
        ? addRowSession === null
        : addRowSession === session;
    if (!session.table || session.tableType !== 'table') return;
    if (session.connectionGeneration !== state.connectionGeneration
        || session.contentGeneration !== state.contentGeneration) {
        updateStatus('Add Row cancelled because the database content changed');
        return;
    }
    if (
        addRowSession
        && (
            state.selectedTable !== session.table
            || state.selectedTableType !== session.tableType
            || JSON.stringify(state.tableColumns) !== session.schemaSignature
        )
    ) {
        updateStatus('Add Row target changed; close and reopen the form before inserting');
        return;
    }
    const inputs = document.querySelectorAll('#addRowForm input[data-column]:not([disabled])');
    const missingRequired = [];

    // Validate
    for (const input of inputs) {
        const colName = input.dataset.column;
        const mode = input.dataset.mode === 'default' && input.value !== ''
            ? 'value'
            : input.dataset.mode || (input.value === '' ? 'default' : 'value');
        const isRequired = input.dataset.required === 'true';

        if (isRequired && (mode === 'default' || mode === 'null')) {
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
        const value = input.value;
        const mode = input.dataset.mode === 'default' && value !== ''
            ? 'value'
            : input.dataset.mode || (value === '' ? 'default' : 'value');
        if (mode === 'default') continue;
        if (mode === 'null') {
            setOwnRowValue(rowData, colName, null);
            continue;
        }
        const column = session.columns.find(candidate => candidate.name === colName);
        const parsed = !isNaN(Number(value)) && value.trim() !== ''
            ? parseGridInputValue(value, column, column?.isPrimaryKey === true)
            : value;
        setOwnRowValue(rowData, colName, parsed);
    }

    // Snapshot the target so the count delta below can never be applied to a
    // table the user switched to while the insert RPC was in flight.
    const targetTable = session.table;

    try {
        updateStatus('Inserting row...');
        await backendApi.insertRow(targetTable, rowData);
        // VS Code retains this known delta until its refreshContent echo. The
        // demo cache drops it because INSERT triggers can ignore/add rows.
        noteRowCountChanged(targetTable, 1);

        const ownsModal = isCurrentSession();
        const targetIsCurrent = () => session.connectionGeneration === state.connectionGeneration
            && state.selectedTable === targetTable
            && state.selectedTableType === 'table';
        if (ownsModal) {
            closeModal('addRowModal');
        }
        // A host refresh may close the modal before the mutation reply arrives.
        // Modal ownership controls modal/status changes, not reconciliation of
        // the committed insert against the still-selected database target.
        if (targetIsCurrent()) await loadTableData();
        if (ownsModal && addRowSession === null && targetIsCurrent()) {
            updateStatus('Row inserted - Ctrl+S to save');
        }

    } catch (err) {
        console.error('Insert failed:', err);
        if (isCurrentSession()) updateStatus(`Error: ${getErrorMessage(err)}`);
    }
}

// ================================================================
// DELETE ROWS/COLUMNS
// ================================================================

export function openDeleteModal() {
    if (state.isReadOnly) {
        deleteSession = null;
        updateStatus('Document is read-only');
        return;
    }
    if (state.selectedColumns.size > 0) {
        const columnNames = Array.from(state.selectedColumns);
        const multipleColumns = columnNames.length > 1;
        deleteSession = {
            kind: 'columns',
            table: state.selectedTable,
            connectionGeneration: state.connectionGeneration,
            contentGeneration: state.contentGeneration,
            columns: columnNames
        };
        document.getElementById('deleteConfirmText').textContent =
            `Are you sure you want to delete ${columnNames.length} column${multipleColumns ? 's' : ''} (${columnNames.join(', ')})?` +
            (multipleColumns
                ? ' This will permanently remove the columns and all their data.'
                : ' This will permanently remove the column and its data.');
    } else if (state.selectedRowIds.size > 0) {
        const eligibility = getSelectedRowActionEligibility();
        if (eligibility.rowIds.length === 0) {
            updateStatus(`Delete unavailable: ${eligibility.readOnlyReason}`);
            return;
        }
        const skipped = eligibility.readOnlyCount > 0
            ? ` ${eligibility.readOnlyCount} read-only selected row${eligibility.readOnlyCount === 1 ? '' : 's'} will be skipped: ${eligibility.readOnlyReason}`
            : '';
        deleteSession = {
            kind: 'rows',
            table: state.selectedTable,
            connectionGeneration: state.connectionGeneration,
            contentGeneration: state.contentGeneration,
            rowIds: [...eligibility.rowIds],
            readOnlyCount: eligibility.readOnlyCount,
            readOnlyReason: eligibility.readOnlyReason
        };
        document.getElementById('deleteConfirmText').textContent =
            `Are you sure you want to delete ${eligibility.rowIds.length} row${eligibility.rowIds.length > 1 ? 's' : ''}?${skipped}`;
    } else {
        deleteSession = null;
        return;
    }
    openModal('deleteModal');
}

export async function submitDelete() {
    if (isSubmittingDelete) return;
    isSubmittingDelete = true;
    try {
        return await submitDeleteOnce();
    } finally {
        isSubmittingDelete = false;
    }
}

async function submitDeleteOnce() {
    if (state.isReadOnly) {
        updateStatus('Document is read-only');
        return;
    }
    // The confirmation modal can already be open when a replacement load
    // starts. Never apply its stale row/column selection to the incoming grid.
    if (state.isGridReloading) return;
    const modalSession = deleteSession;
    const session = deleteSession ?? (
        state.selectedColumns.size > 0
            ? {
                kind: 'columns',
                table: state.selectedTable,
                connectionGeneration: state.connectionGeneration,
                contentGeneration: state.contentGeneration,
                columns: Array.from(state.selectedColumns)
              }
            : state.selectedRowIds.size > 0
                ? (() => {
                    const eligibility = getSelectedRowActionEligibility();
                    return {
                        kind: 'rows',
                        table: state.selectedTable,
                        connectionGeneration: state.connectionGeneration,
                        contentGeneration: state.contentGeneration,
                        rowIds: [...eligibility.rowIds],
                        readOnlyCount: eligibility.readOnlyCount,
                        readOnlyReason: eligibility.readOnlyReason
                    };
                  })()
                : null
    );
    const isCurrentSession = () => modalSession === null
        ? deleteSession === null
        : deleteSession === session;
    if (session?.kind === 'columns') {
        await submitDeleteColumns(session, isCurrentSession);
    } else if (session?.kind === 'rows') {
        await submitDeleteRows(session, isCurrentSession);
    }
}

async function submitDeleteRows(session, isCurrentSession) {
    const rowIds = session.rowIds;
    if (rowIds.length === 0) {
        updateStatus(`Delete unavailable: ${session.readOnlyReason}`);
        return;
    }
    const targetTable = session.table;
    if (session.connectionGeneration !== state.connectionGeneration
        || session.contentGeneration !== state.contentGeneration) {
        updateStatus('Delete cancelled because the database content changed');
        return;
    }

    try {
        updateStatus('Deleting rows...');
        await backendApi.deleteRows(targetTable, rowIds);
        // VS Code retains this requested delta until its refreshContent echo.
        // The demo drops it because DELETE triggers can ignore/cascade rows.
        noteRowCountChanged(targetTable, -rowIds.length);

        const ownsModal = isCurrentSession();
        const targetIsCurrent = () => session.connectionGeneration === state.connectionGeneration
            && state.selectedTable === targetTable
            && state.selectedTableType === 'table';
        if (ownsModal) {
            closeModal('deleteModal');
        }
        // Remove only the identities this request deleted. A newer selection
        // made while the RPC was pending belongs to the current grid and must
        // survive this older confirmation's reconciliation.
        if (targetIsCurrent()) {
            for (const rowId of rowIds) state.selectedRowIds.delete(rowId);
            await loadTableData();
            updateToolbarButtons();
        }
        if (ownsModal && deleteSession === null && targetIsCurrent()) {
            const skipped = session.readOnlyCount > 0
                ? `; skipped ${session.readOnlyCount} read-only selection${session.readOnlyCount === 1 ? '' : 's'}`
                : '';
            updateStatus(`Deleted ${rowIds.length} row${rowIds.length > 1 ? 's' : ''}${skipped} - Ctrl+S to save`);
        }

    } catch (err) {
        console.error('Delete rows failed:', err);
        if (isCurrentSession() && state.selectedTable === targetTable) {
            updateStatus(`Error: ${getErrorMessage(err)}`);
        }
    }
}

async function submitDeleteColumns(session, isCurrentSession) {
    const columnNames = session.columns;
    if (columnNames.length === 0) return;
    const table = session.table;
    if (session.connectionGeneration !== state.connectionGeneration
        || session.contentGeneration !== state.contentGeneration) {
        updateStatus('Delete cancelled because the database content changed');
        return;
    }

    try {
        updateStatus('Deleting columns...');
        const result = await backendApi.deleteColumns(table, columnNames);

        // If user cancelled the operation (e.g., declined to drop dependent indexes), don't reload
        if (result && result.cancelled) {
            if (isCurrentSession()) {
                updateStatus('Delete cancelled');
                closeModal('deleteModal');
            }
            return;
        }

        // Dropping a column keeps the row count but changes what filters can
        // match — and count identities name filters, not schema, so a later
        // re-add of the same column name must not revive counts cached
        // against the old column's values.
        noteCellValuesChanged(table);

        const schemaRefreshed = await refreshSchema();
        const targetStillSelected = session.connectionGeneration === state.connectionGeneration
            && state.selectedTable === table
            && state.selectedTableType === 'table';

        // The host broadcasts this edit before the RPC response arrives. That
        // refresh closes the confirmation modal, but our newer schema request
        // can supersede its request. Modal ownership must therefore gate only
        // modal/status updates, not the column/data reconciliation this caller
        // now owns. If our schema request was superseded, the newer refresh is
        // responsible for reconciling the grid instead.
        if (schemaRefreshed && targetStillSelected) {
            state.selectedColumns.clear();
            state.selectedCells = [];
            state.lastSelectedCell = null;
            if (await loadTableColumns()) await loadTableData();
            updateToolbarButtons();
        }

        if (isCurrentSession()) {
            closeModal('deleteModal');
            if (targetStillSelected) {
                updateStatus(`Deleted ${columnNames.length} column${columnNames.length > 1 ? 's' : ''} - Ctrl+S to save`);
            }
        }

    } catch (err) {
        console.error('Delete columns failed:', err);
        if (isCurrentSession() && state.selectedTable === table) {
            updateStatus(`Error: ${getErrorMessage(err)}`);
        }
    }
}

// ================================================================
// CREATE TABLE
// ================================================================

let columnDefCounter = 0;

export function openCreateTableModal() {
    createTableSession = {
        connectionGeneration: state.connectionGeneration,
        contentGeneration: state.contentGeneration
    };
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
    const nameInputId = `columnName_${colId}`;
    const nameLabel = document.createElement('label');
    nameLabel.className = 'visually-hidden';
    nameLabel.htmlFor = nameInputId;
    nameLabel.textContent = `Column ${colId} name`;
    rowDiv.appendChild(nameLabel);
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = nameInputId;
    nameInput.placeholder = 'Column name';
    nameInput.className = 'col-name';
    nameInput.style.flex = '2';
    if (isFirst) nameInput.value = 'id';
    rowDiv.appendChild(nameInput);

    // Type Select
    const typeSelectId = `columnType_${colId}`;
    const typeLabel = document.createElement('label');
    typeLabel.className = 'visually-hidden';
    typeLabel.htmlFor = typeSelectId;
    typeLabel.textContent = `Column ${colId} type`;
    rowDiv.appendChild(typeLabel);
    const typeSelect = document.createElement('select');
    typeSelect.id = typeSelectId;
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
    removeBtn.type = 'button';
    removeBtn.className = 'icon-button btn-remove-col';
    removeBtn.dataset.colid = colId.toString();
    removeBtn.title = `Remove column definition ${colId}`;
    removeBtn.ariaLabel = removeBtn.title;
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
    if (isSubmittingCreateTable) return;
    isSubmittingCreateTable = true;
    try {
        return await submitCreateTableOnce();
    } finally {
        isSubmittingCreateTable = false;
    }
}

async function submitCreateTableOnce() {
    const modalSession = createTableSession;
    const isCurrentSession = () => modalSession === null
        ? createTableSession === null
        : createTableSession === modalSession;
    const tableName = document.getElementById('newTableName').value;
    if (modalSession
        && (modalSession.connectionGeneration !== state.connectionGeneration
            || modalSession.contentGeneration !== state.contentGeneration)) {
        updateStatus('Create Table cancelled because the database content changed');
        return;
    }
    try {
        assertUsableSqlIdentifier(tableName, 'Table name');
    } catch (err) {
        updateStatus(`Error: ${getErrorMessage(err)}`);
        return;
    }

    const colDefs = [];
    const rows = document.querySelectorAll('.column-def-row');

    for (const row of rows) {
        const name = row.querySelector('.col-name').value;
        const type = row.querySelector('.col-type').value;
        const isPK = row.querySelector('.col-pk').checked;
        const isNN = row.querySelector('.col-nn').checked;

        try {
            assertUsableSqlIdentifier(name, 'Column name');
        } catch (err) {
            updateStatus(`Error: ${getErrorMessage(err)}`);
            return;
        }

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

        await refreshSchema();
        if (isCurrentSession()) {
            closeModal('createTableModal');
            updateStatus(`Table "${tableName}" created - Ctrl+S to save`);
        }

    } catch (err) {
        console.error('Create table failed:', err);
        if (isCurrentSession()) updateStatus(`Error: ${getErrorMessage(err)}`);
    }
}

// ================================================================
// ADD COLUMN
// ================================================================

export function openAddColumnModal() {
    if (!state.selectedTable || state.selectedTableType !== 'table') return;

    addColumnSession = {
        table: state.selectedTable,
        connectionGeneration: state.connectionGeneration,
        contentGeneration: state.contentGeneration
    };
    document.getElementById('newColumnName').value = '';
    document.getElementById('newColumnType').value = 'TEXT';
    document.getElementById('newColumnDefault').value = '';

    openModal('addColumnModal');
}

export async function submitAddColumn() {
    if (isSubmittingAddColumn) return;
    isSubmittingAddColumn = true;
    try {
        return await submitAddColumnOnce();
    } finally {
        isSubmittingAddColumn = false;
    }
}

async function submitAddColumnOnce() {
    const modalSession = addColumnSession;
    const isCurrentSession = () => modalSession === null
        ? addColumnSession === null
        : addColumnSession === modalSession;
    const columnName = document.getElementById('newColumnName').value;
    const columnType = document.getElementById('newColumnType').value;
    const defaultValue = document.getElementById('newColumnDefault').value.trim();

    try {
        assertUsableSqlIdentifier(columnName, 'Column name');
    } catch (err) {
        updateStatus(`Error: ${getErrorMessage(err)}`);
        return;
    }

    const table = modalSession?.table ?? state.selectedTable;
    if (!table
        || (modalSession
            && (modalSession.connectionGeneration !== state.connectionGeneration
                || modalSession.contentGeneration !== state.contentGeneration))) {
        updateStatus('Add Column cancelled because the database content changed');
        return;
    }

    try {
        updateStatus('Adding column...');
        await backendApi.addColumn(table, columnName, columnType, defaultValue);

        // Same schema-change rule as submitDeleteColumns: filtered counts
        // cached before this DDL must not survive it.
        noteCellValuesChanged(table);

        if (isCurrentSession()) {
            closeModal('addColumnModal');
            if (state.selectedTable === table && await loadTableColumns()) {
                await loadTableData();
            }
            updateStatus(`Column "${columnName}" added - Ctrl+S to save`);
        }

    } catch (err) {
        console.error('Add column failed:', err);
        if (isCurrentSession()) updateStatus(`Error: ${getErrorMessage(err)}`);
    }
}
