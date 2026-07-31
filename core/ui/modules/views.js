/**
 * View creation, validation, preview, editing, and deletion UI.
 */
import { state, persistState } from './state.js';
import { backendApi } from './api.js';
import { openModal, closeModal } from './modals.js';
import { refreshSchema } from './sidebar.js';
import { clearSelection, loadTableColumns, loadTableData } from './grid.js';
import { showEmptyState, updateStatus, updateToolbarButtons } from './ui.js';
import { formatCellValueAsText } from './utils.js';
import { handleTextareaTab, resetTextareaTabFocusEscape } from './text-editor.js';
import {
    isViewDefinitionConflictError,
    isViewDefinitionSnapshotCurrent,
    isViewTriggerSnapshotCurrent
} from '../../../src/core/view-utils.ts';

let editingViewName = null;
let editingViewDefinitionSql;
let editingViewDefinitionTriggers;
let activeViewModalSession = 0;
let activePreviewRequest = 0;
let isSavingView = false;

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

    const headers = result?.headers ?? result?.columns ?? [];
    const rows = result?.rows ?? result?.values ?? [];
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
    for (const row of rows) {
        const tr = document.createElement('tr');
        for (const value of row) {
            const td = document.createElement('td');
            td.textContent = formatCellValueAsText(value);
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
        name: elements.name?.value.trim() ?? '',
        selectSql: elements.sql?.value.trim() ?? '',
        preserveTriggers: elements.preserveTriggers?.checked !== false
    };
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
    elements.openInVsCode.hidden = true;
    hideReloadDefinitionOffer();
    elements.save.textContent = 'Create View';
    setFeedback('');
    clearPreview();
    openModal('viewModal');
}

export async function openEditViewModal(view) {
    const modalSession = ++activeViewModalSession;
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
        elements.save.textContent = 'Save View';
        elements.openInVsCode.hidden = !document.getElementById('vscode-env');
        hideReloadDefinitionOffer();

        setFeedback('');
        clearPreview();
        openModal('viewModal');
        updateStatus('Ready');
    } catch (err) {
        if (!isSuperseded()) updateStatus(`Error: ${err.message}`);
    }
}

function isCurrentModalSession(modalSession) {
    const modal = document.getElementById('viewModal');
    return modalSession === activeViewModalSession && modal && !modal.classList.contains('hidden');
}

async function validateDraft(draft = getDraft(), modalSession = activeViewModalSession) {
    const canUpdateFeedback = () => isCurrentModalSession(modalSession)
        && draftsMatch(draft, getDraft());
    if (!draft.name || !draft.selectSql) {
        if (canUpdateFeedback()) setFeedback('A view name and SELECT definition are required.', true);
        return false;
    }

    try {
        if (canUpdateFeedback()) setFeedback('Validating with SQLite...');
        await backendApi.validateViewDefinition(draft.name, draft.selectSql);
        if (canUpdateFeedback()) setFeedback('Definition is valid.');
        return true;
    } catch (err) {
        if (canUpdateFeedback()) setFeedback(err.message, true);
        return false;
    }
}

async function previewDraft() {
    const modalSession = activeViewModalSession;
    const previewRequest = ++activePreviewRequest;
    const draft = getDraft();
    const isCurrentPreview = () => previewRequest === activePreviewRequest
        && isCurrentModalSession(modalSession)
        && draftsMatch(draft, getDraft());
    if (!draft.name || !draft.selectSql) {
        if (isCurrentPreview()) {
            setFeedback('A view name and SELECT definition are required.', true);
        }
        return;
    }

    try {
        if (isCurrentPreview()) setFeedback('Compiling preview...');
        const result = await backendApi.previewViewDefinition(draft.name, draft.selectSql, 50);
        if (!isCurrentPreview()) return;
        renderPreview(result);
        const rowCount = result?.rows?.length ?? result?.values?.length ?? 0;
        setFeedback(`Preview returned ${rowCount} row${rowCount === 1 ? '' : 's'} (maximum 50).`);
    } catch (err) {
        if (!isCurrentPreview()) return;
        clearPreview();
        setFeedback(err.message, true);
    }
}

async function saveDraft() {
    if (state.isReadOnly) {
        setFeedback('Document is read-only.', true);
        return;
    }
    if (isSavingView) return;

    // The modal can be closed and reused while SQLite validation is pending.
    // Snapshot every mutation input and require the same visible modal session
    // before starting the write, so an old Save cannot target a newer draft.
    const modalSession = activeViewModalSession;
    const draft = getDraft();
    const targetView = editingViewName;
    const targetDefinitionSql = editingViewDefinitionSql;
    const targetDefinitionTriggers = editingViewDefinitionTriggers;
    isSavingView = true;
    const saveElements = getElements();
    const saveButton = saveElements.save;
    const sqlEditor = saveElements.sql;
    const reloadLatest = saveElements.reloadLatest;
    if (saveButton) saveButton.disabled = true;
    if (sqlEditor) sqlEditor.disabled = true;
    if (reloadLatest) reloadLatest.disabled = true;
    hideReloadDefinitionOffer();
    try {
        if (!await validateDraft(draft, modalSession)) return;
        if (!isCurrentModalSession(modalSession)) return;

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

        const changedView = targetView ?? draft.name;
        if (isCurrentModalSession(modalSession)) closeModal('viewModal');
        await refreshSchema();
        if (state.selectedTable === changedView && state.selectedTableType === 'view') {
            clearSelection();
            persistState();
            await loadTableColumns();
            await loadTableData(true, false);
        }
        if (modalSession === activeViewModalSession) {
            updateStatus(`View "${changedView}" ${targetView ? 'updated' : 'created'} - Ctrl+S to save`);
        }
    } catch (err) {
        if (isCurrentModalSession(modalSession)) {
            if (targetView && isViewDefinitionConflictError(err)) showDefinitionConflict();
            else setFeedback(err.message, true);
        }
        if (modalSession === activeViewModalSession) updateStatus(`Error: ${err.message}`);
    } finally {
        isSavingView = false;
        if (saveButton) saveButton.disabled = false;
        if (sqlEditor) sqlEditor.disabled = false;
        if (reloadLatest) reloadLatest.disabled = false;
    }
}

async function reloadLatestViewDefinition() {
    const modalSession = activeViewModalSession;
    const targetView = editingViewName;
    if (!targetView || !isCurrentModalSession(modalSession)) return;

    const reloadLatest = getElements().reloadLatest;
    if (reloadLatest) reloadLatest.disabled = true;
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
            setFeedback(err.message, true);
        }
    } finally {
        if (reloadLatest) reloadLatest.disabled = false;
    }
}

async function openDraftInVsCode() {
    if (!editingViewName) return;
    try {
        const webviewId = document.getElementById('vscode-env')?.dataset.webviewId;
        await backendApi.openViewEditor(editingViewName, webviewId);
        closeModal('viewModal');
        updateStatus(`Editing view "${editingViewName}" in VS Code`);
    } catch (err) {
        setFeedback(err.message, true);
    }
}

export async function dropViewFromSidebar(view) {
    if (state.isReadOnly) {
        updateStatus('Document is read-only');
        return;
    }

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
            document.getElementById('tableNameLabel').textContent = 'No table selected';
            showEmptyState();
            updateToolbarButtons();
            persistState();
        }
        await refreshSchema();
        updateStatus(`View "${view}" dropped - Ctrl+S to save`);
    } catch (err) {
        updateStatus(`Error: ${err.message}`);
    }
}
