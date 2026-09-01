/**
 * View creation, validation, preview, editing, and deletion UI.
 */
import { state, persistState } from './state.js';
import { backendApi } from './api.js';
import { openModal, closeModal, registerModalCloseHandler } from './modals.js';
import { refreshSchema } from './sidebar.js';
import { clearSelection, loadTableColumns, loadTableData } from './grid.js';
import { showEmptyState, updateStatus, updateToolbarButtons } from './ui.js';
import { formatCellValueAsText, getErrorMessage } from './utils.js';
import { handleTextareaTab, resetTextareaTabFocusEscape } from './text-editor.js';
import { invalidateAllCounts } from './count-cache.js';
import {
    isViewDefinitionConflictError,
    isViewDefinitionSnapshotCurrent,
    isViewTriggerSnapshotCurrent
} from '../../../src/core/view-utils.ts';
import { assertUsableSqlIdentifier } from '../../../src/core/sql-utils.ts';

let editingViewName = null;
let editingViewDefinitionSql;
let editingViewDefinitionTriggers;
let activeViewModalSession = 0;
let activePreviewRequest = 0;
let activeViewConnectionGeneration = 0;
let activeViewContentGeneration = 0;
const savingViewSessions = new Set();
const droppingViews = new Set();

registerModalCloseHandler('viewModal', () => {
    activeViewModalSession++;
    activePreviewRequest++;
    editingViewName = null;
    editingViewDefinitionSql = undefined;
    editingViewDefinitionTriggers = undefined;
});

function getElements() {
    return {
        title: document.getElementById('viewModalTitle'),
        name: document.getElementById('viewNameInput'),
        sql: document.getElementById('viewSelectSql'),
        feedback: document.getElementById('viewValidationStatus'),
        preview: document.getElementById('viewPreview'),
        triggerOptions: document.getElementById('viewTriggerOptions'),
        triggerSummary: document.getElementById('viewTriggerSummary'),
        preserveTriggers: document.getElementById('viewPreserveTriggers'),
        openInVsCode: document.getElementById('btnOpenViewInVsCode'),
        reloadLatest: document.getElementById('btnReloadViewDefinition'),
        save: document.getElementById('btnSaveView')
    };
}

function setFeedback(message, isError = false) {
    const feedback = getElements().feedback;
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.toggle('view-feedback-error', isError);
}

function clearPreview() {
    const preview = getElements().preview;
    if (!preview) return;
    preview.replaceChildren();
    preview.hidden = true;
}

function renderPreview(result) {
    const preview = getElements().preview;
    if (!preview) return;
    preview.replaceChildren();

    const headers = result?.headers ?? [];
    const rows = result?.rows ?? [];
    const table = document.createElement('table');
    table.className = 'view-preview-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const header of headers) {
        const th = document.createElement('th');
        th.textContent = String(header);
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const [rowIndex, row] of rows.entries()) {
        const tr = document.createElement('tr');
        for (const [columnIndex, value] of row.entries()) {
            const td = document.createElement('td');
            td.textContent = result?.exactIntegerTexts?.[rowIndex]?.[columnIndex]
                ?? formatCellValueAsText(value);
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    preview.appendChild(table);
    preview.hidden = false;
}

function getDraft() {
    const elements = getElements();
    return {
        name: elements.name?.value ?? '',
        selectSql: elements.sql?.value.trim() ?? '',
        preserveTriggers: elements.preserveTriggers?.checked !== false
    };
}

function getDraftInputError(draft) {
    try {
        assertUsableSqlIdentifier(draft.name, 'View name');
    } catch (err) {
        return getErrorMessage(err);
    }
    if (!draft.selectSql) return 'A SELECT definition is required.';
    return null;
}

function draftsMatch(left, right) {
    return left.name === right.name
        && left.selectSql === right.selectSql
        && left.preserveTriggers === right.preserveTriggers;
}

function applyViewDefinitionToEditor(definition) {
    const elements = getElements();
    editingViewDefinitionSql = definition.sql;
    editingViewDefinitionTriggers = (definition.triggers ?? []).map(trigger => ({
        identifier: trigger.identifier,
        sql: trigger.sql,
        ...(trigger.temporary ? { temporary: true } : {})
    }));
    elements.sql.value = definition.selectSql;
    elements.preserveTriggers.checked = true;

    const triggerCount = definition.triggers?.length ?? 0;
    elements.triggerOptions.hidden = triggerCount === 0;
    elements.triggerSummary.textContent = triggerCount === 1
        ? `Preserve trigger: ${definition.triggers[0].identifier}`
        : `Preserve ${triggerCount} INSTEAD OF triggers`;
}

function hideReloadDefinitionOffer() {
    const reloadLatest = getElements().reloadLatest;
    if (reloadLatest) reloadLatest.hidden = true;
}

function showDefinitionConflict() {
    setFeedback(
        'This view changed outside this editor. Your draft was not saved. Reload the latest definition before saving again.',
        true
    );
    const reloadLatest = getElements().reloadLatest;
    if (reloadLatest) reloadLatest.hidden = false;
}

export function initViews() {
    const sqlEditor = document.getElementById('viewSelectSql');
    sqlEditor?.addEventListener('keydown', handleTextareaTab);
    sqlEditor?.addEventListener('blur', () => resetTextareaTabFocusEscape(sqlEditor));
    document.getElementById('btnValidateView')?.addEventListener('click', () => validateDraft());
    document.getElementById('btnPreviewView')?.addEventListener('click', previewDraft);
    document.getElementById('btnSaveView')?.addEventListener('click', saveDraft);
    document.getElementById('btnOpenViewInVsCode')?.addEventListener('click', openDraftInVsCode);
    document.getElementById('btnReloadViewDefinition')?.addEventListener('click', reloadLatestViewDefinition);
}

export function openCreateViewModal() {
    if (state.isReadOnly) {
        updateStatus('Document is read-only');
        return;
    }
    activeViewModalSession++;
    activeViewConnectionGeneration = state.connectionGeneration;
    activeViewContentGeneration = state.contentGeneration;
    editingViewName = null;
    editingViewDefinitionSql = undefined;
    editingViewDefinitionTriggers = undefined;
    const elements = getElements();
    resetTextareaTabFocusEscape(elements.sql);
    elements.title.textContent = 'Create View';
    elements.name.value = '';
    elements.name.disabled = false;
    elements.sql.value = 'SELECT 1 AS value';
    elements.sql.disabled = false;
    elements.triggerOptions.hidden = true;
    elements.preserveTriggers.checked = true;
    elements.preserveTriggers.disabled = false;
    elements.openInVsCode.hidden = true;
    hideReloadDefinitionOffer();
    elements.save.textContent = 'Create View';
    elements.save.disabled = false;
    elements.reloadLatest.disabled = false;
    setFeedback('');
    clearPreview();
    openModal('viewModal');
}

export async function openEditViewModal(view) {
    const modalSession = ++activeViewModalSession;
    activeViewConnectionGeneration = state.connectionGeneration;
    activeViewContentGeneration = state.contentGeneration;
    const isSuperseded = () => modalSession !== activeViewModalSession;
    try {
        updateStatus(`Loading view "${view}"...`);
        const definition = await backendApi.getViewDefinition(view);
        if (isSuperseded()) return;
        editingViewName = view;

        const elements = getElements();
        resetTextareaTabFocusEscape(elements.sql);
        elements.title.textContent = 'Edit View';
        elements.name.value = view;
        elements.name.disabled = true;
        applyViewDefinitionToEditor(definition);
        elements.sql.disabled = false;
        elements.preserveTriggers.disabled = false;
        elements.save.textContent = 'Save View';
        elements.save.disabled = false;
        elements.openInVsCode.hidden = !document.getElementById('vscode-env');
        hideReloadDefinitionOffer();
        elements.reloadLatest.disabled = false;

        setFeedback('');
        clearPreview();
        openModal('viewModal');
        updateStatus('Ready');
    } catch (err) {
        if (!isSuperseded()) updateStatus(`Error: ${getErrorMessage(err)}`);
    }
}

function isCurrentModalSession(modalSession) {
    const modal = document.getElementById('viewModal');
    return modalSession === activeViewModalSession && modal && !modal.classList.contains('hidden');
}

async function validateDraft(draft = getDraft(), modalSession = activeViewModalSession) {
    const intent = editingViewName ? 'edit' : 'create';
    const canUpdateFeedback = () => isCurrentModalSession(modalSession)
        && draftsMatch(draft, getDraft());
    const inputError = getDraftInputError(draft);
    if (inputError) {
        if (canUpdateFeedback()) setFeedback(inputError, true);
        return false;
    }

    try {
        if (canUpdateFeedback()) setFeedback('Validating with SQLite...');
        await backendApi.validateViewDefinition(draft.name, draft.selectSql, intent);
        if (canUpdateFeedback()) setFeedback('Definition is valid.');
        return true;
    } catch (err) {
        if (canUpdateFeedback()) setFeedback(getErrorMessage(err), true);
        return false;
    }
}

async function previewDraft() {
    const modalSession = activeViewModalSession;
    const previewRequest = ++activePreviewRequest;
    const draft = getDraft();
    const intent = editingViewName ? 'edit' : 'create';
    const isCurrentPreview = () => previewRequest === activePreviewRequest
        && isCurrentModalSession(modalSession)
        && draftsMatch(draft, getDraft());
    const inputError = getDraftInputError(draft);
    if (inputError) {
        if (isCurrentPreview()) {
            setFeedback(inputError, true);
        }
        return;
    }

    try {
        if (isCurrentPreview()) setFeedback('Compiling preview...');
        const result = await backendApi.previewViewDefinition(
            draft.name,
            draft.selectSql,
            50,
            intent
        );
        if (!isCurrentPreview()) return;
        renderPreview(result);
        const rowCount = result?.rows?.length ?? 0;
        setFeedback(`Preview returned ${rowCount} row${rowCount === 1 ? '' : 's'} (maximum 50).`);
    } catch (err) {
        if (!isCurrentPreview()) return;
        clearPreview();
        setFeedback(getErrorMessage(err), true);
    }
}

async function saveDraft() {
    if (state.isReadOnly) {
        setFeedback('Document is read-only.', true);
        return;
    }
    // The modal can be closed and reused while SQLite validation is pending.
    // Snapshot every mutation input and require the same visible modal session
    // before starting the write, so an old Save cannot target a newer draft.
    const modalSession = activeViewModalSession;
    if (savingViewSessions.has(modalSession)) return;
    if (activeViewConnectionGeneration !== state.connectionGeneration
        || activeViewContentGeneration !== state.contentGeneration) {
        setFeedback('Database content changed. Close and reopen this editor.', true);
        return;
    }
    const draft = getDraft();
    const targetView = editingViewName;
    const targetDefinitionSql = editingViewDefinitionSql;
    const targetDefinitionTriggers = editingViewDefinitionTriggers;
    savingViewSessions.add(modalSession);
    const saveElements = getElements();
    const saveButton = saveElements.save;
    const nameInput = saveElements.name;
    const sqlEditor = saveElements.sql;
    const preserveTriggers = saveElements.preserveTriggers;
    const reloadLatest = saveElements.reloadLatest;
    const draftInputDisabledStates = [nameInput, sqlEditor, preserveTriggers]
        .map(element => element?.disabled);
    if (saveButton) saveButton.disabled = true;
    for (const element of [nameInput, sqlEditor, preserveTriggers]) {
        if (element) element.disabled = true;
    }
    if (reloadLatest) reloadLatest.disabled = true;
    hideReloadDefinitionOffer();
    try {
        if (!await validateDraft(draft, modalSession)) return;
        if (!isCurrentModalSession(modalSession)) return;
        if (activeViewConnectionGeneration !== state.connectionGeneration
            || activeViewContentGeneration !== state.contentGeneration) return;

        if (targetView) {
            const currentDefinition = await backendApi.getViewDefinition(targetView);
            if (!isCurrentModalSession(modalSession)) return;
            if (!isViewDefinitionSnapshotCurrent(targetDefinitionSql, currentDefinition.sql)
                || !isViewTriggerSnapshotCurrent(
                    targetDefinitionTriggers,
                    currentDefinition.triggers
                )) {
                showDefinitionConflict();
                return;
            }
        }

        setFeedback(targetView ? 'Replacing view atomically...' : 'Creating view...');
        const result = targetView
            ? await backendApi.editView(
                targetView,
                draft.selectSql,
                draft.preserveTriggers,
                targetDefinitionSql,
                targetDefinitionTriggers
            )
            : await backendApi.createView(draft.name, draft.selectSql);
        if (result?.cancelled) {
            if (isCurrentModalSession(modalSession)) setFeedback('Edit cancelled.');
            return;
        }
        if (!isCurrentModalSession(modalSession)) return;

        const changedView = targetView ?? draft.name;
        // A redefined view is a different query — and any OTHER view that
        // projects it changed row set too, without a table switch to
        // invalidate for it (the modal can edit view B while view A stays
        // selected). Wholesale invalidation is the only sound scope here;
        // it costs one count refetch on the next load.
        invalidateAllCounts();
        closeModal('viewModal');
        const closedSession = activeViewModalSession;
        await refreshSchema();
        if (state.selectedTable === changedView && state.selectedTableType === 'view') {
            clearSelection();
            persistState();
            if (await loadTableColumns()) await loadTableData(true, false);
        }
        if (activeViewModalSession === closedSession) {
            updateStatus(`View "${changedView}" ${targetView ? 'updated' : 'created'} - Ctrl+S to save`);
        }
    } catch (err) {
        if (isCurrentModalSession(modalSession)) {
            if (targetView && isViewDefinitionConflictError(err)) showDefinitionConflict();
            else setFeedback(getErrorMessage(err), true);
        }
        if (modalSession === activeViewModalSession) updateStatus(`Error: ${getErrorMessage(err)}`);
    } finally {
        savingViewSessions.delete(modalSession);
        if (modalSession === activeViewModalSession) {
            if (saveButton) saveButton.disabled = false;
            if (reloadLatest) reloadLatest.disabled = false;
            [nameInput, sqlEditor, preserveTriggers].forEach((element, index) => {
                if (element) element.disabled = draftInputDisabledStates[index];
            });
        }
    }
}

async function reloadLatestViewDefinition() {
    const modalSession = activeViewModalSession;
    const targetView = editingViewName;
    if (!targetView || !isCurrentModalSession(modalSession)) return;

    const elements = getElements();
    const draftControls = [elements.name, elements.sql, elements.preserveTriggers, elements.save];
    const disabledStates = draftControls.map(element => element?.disabled);
    const reloadDisabled = elements.reloadLatest?.disabled;
    for (const element of draftControls) {
        if (element) element.disabled = true;
    }
    if (elements.reloadLatest) elements.reloadLatest.disabled = true;
    try {
        setFeedback('Loading the latest view definition...');
        const definition = await backendApi.getViewDefinition(targetView);
        if (!isCurrentModalSession(modalSession) || editingViewName !== targetView) return;
        applyViewDefinitionToEditor(definition);
        activePreviewRequest++;
        clearPreview();
        hideReloadDefinitionOffer();
        setFeedback('Latest definition loaded. Review it before saving.');
    } catch (err) {
        if (isCurrentModalSession(modalSession) && editingViewName === targetView) {
            setFeedback(getErrorMessage(err), true);
        }
    } finally {
        if (isCurrentModalSession(modalSession) && editingViewName === targetView) {
            draftControls.forEach((element, index) => {
                if (element) element.disabled = disabledStates[index];
            });
            if (elements.reloadLatest) elements.reloadLatest.disabled = reloadDisabled;
        }
    }
}

async function openDraftInVsCode() {
    const modalSession = activeViewModalSession;
    const targetView = editingViewName;
    if (!targetView) return;
    const isCurrentRequest = () => modalSession === activeViewModalSession
        && editingViewName === targetView;
    try {
        const webviewId = document.getElementById('vscode-env')?.dataset.webviewId;
        await backendApi.openViewEditor(targetView, webviewId);
        if (!isCurrentRequest()) return;
        closeModal('viewModal');
        updateStatus(`Editing view "${targetView}" in VS Code`);
    } catch (err) {
        if (isCurrentRequest()) setFeedback(getErrorMessage(err), true);
    }
}

export async function dropViewFromSidebar(view) {
    if (state.isReadOnly) {
        updateStatus('Document is read-only');
        return;
    }

    if (droppingViews.has(view)) return;
    droppingViews.add(view);
    try {
        const result = await backendApi.dropView(view);
        if (result?.cancelled) {
            updateStatus('Drop view cancelled');
            return;
        }

        if (state.selectedTable === view && state.selectedTableType === 'view') {
            clearSelection();
            state.selectedTable = null;
            state.selectedTableType = 'table';
            state.renderedTable = null;
            state.tableColumns = [];
            state.gridData = [];
            state.gridExactIntegerTexts = {};
            state.gridOversizedCells = {};
            state.gridReadOnlyRowReasons = {};
            document.getElementById('tableNameLabel').textContent = 'No table selected';
            showEmptyState();
            updateToolbarButtons();
            persistState();
        }
        await refreshSchema();
        updateStatus(`View "${view}" dropped - Ctrl+S to save`);
    } catch (err) {
        updateStatus(`Error: ${getErrorMessage(err)}`);
    } finally {
        droppingViews.delete(view);
    }
}
