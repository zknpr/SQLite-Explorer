import './vscode_mock_setup';

import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { createDeferred } from './helpers/deferred';

const persistedStates: any[] = [];
(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState: (value: any) => persistedStates.push(value),
    postMessage() {}
});

function createClassList() {
    const classes = new Set<string>();
    return {
        add: (...names: string[]) => names.forEach(name => classes.add(name)),
        remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
        contains: (name: string) => classes.has(name),
        toggle: (name: string, force?: boolean) => {
            const enabled = force ?? !classes.has(name);
            if (enabled) classes.add(name);
            else classes.delete(name);
            return enabled;
        }
    };
}

function installViewDocument() {
    const listeners = new Map<string, (...args: any[]) => any>();
    const element = (overrides: Record<string, unknown> = {}) => ({
        textContent: '',
        value: '',
        children: [] as any[],
        disabled: false,
        hidden: false,
        checked: true,
        classList: createClassList(),
        replaceChildren(...children: any[]) { (this as any).children = children; },
        appendChild(child: any) { (this as any).children.push(child); },
        focus() {},
        addEventListener(type: string, listener: (...args: any[]) => any) {
            listeners.set(`${(this as any).id}:${type}`, listener);
        },
        ...overrides
    });
    const elements: Record<string, any> = {
        viewModalTitle: element(),
        viewNameInput: element(),
        viewSelectSql: element({ id: 'viewSelectSql', selectionStart: 0, selectionEnd: 0, dispatchEvent() {} }),
        viewValidationStatus: element(),
        viewPreview: element(),
        viewTriggerOptions: element(),
        viewTriggerSummary: element(),
        viewPreserveTriggers: element(),
        btnOpenViewInVsCode: element({ id: 'btnOpenViewInVsCode' }),
        btnReloadViewDefinition: element({ id: 'btnReloadViewDefinition', hidden: true }),
        btnSaveView: element({ id: 'btnSaveView' }),
        btnValidateView: element({ id: 'btnValidateView' }),
        btnPreviewView: element({ id: 'btnPreviewView' }),
        viewModal: element({
            querySelector() { return { focus() {} }; }
        }),
        tableNameLabel: element(),
        gridContainer: element({ innerHTML: '' }),
        statusText: element()
    };
    (globalThis as any).document = {
        getElementById(id: string) {
            return elements[id] ?? null;
        },
        querySelectorAll() { return []; },
        createElement() { return element(); }
    };
    return {
        elements,
        listener(id: string, type: string) {
            const registered = listeners.get(`${id}:${type}`);
            assert.ok(registered, `${type} listener was not registered for ${id}`);
            return registered;
        }
    };
}

describe('view modal concurrency', () => {
    after(() => {
        delete (globalThis as any).acquireVsCodeApi;
    });

    afterEach(() => {
        delete (globalThis as any).document;
        persistedStates.length = 0;
    });

    it('ignores an older edit response that resolves after a newer view', async () => {
        const { elements } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { backendApi } = await import(apiModulePath);
        const { openEditViewModal } = await import(viewsModulePath);
        const slow = createDeferred<any>();
        const fast = createDeferred<any>();
        const originalGetViewDefinition = backendApi.getViewDefinition;
        backendApi.getViewDefinition = (view: string) => view === 'slow_view' ? slow.promise : fast.promise;

        try {
            const slowOpen = openEditViewModal('slow_view');
            const fastOpen = openEditViewModal('fast_view');
            fast.resolve({ selectSql: 'SELECT 2', triggers: [] });
            await fastOpen;
            slow.resolve({ selectSql: 'SELECT 1', triggers: [] });
            await slowOpen;

            assert.strictEqual(elements.viewNameInput.value, 'fast_view');
            assert.strictEqual(elements.viewSelectSql.value, 'SELECT 2');
            assert.strictEqual(elements.statusText.textContent, 'Ready');
        } finally {
            backendApi.getViewDefinition = originalGetViewDefinition;
        }
    });

    it('locks the Save action until validation and mutation settle', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const stateModulePath = '../../core/ui/modules/state.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { initViews, openCreateViewModal } = await import(viewsModulePath);
        const validation = createDeferred<void>();
        const originalValidate = backendApi.validateViewDefinition;
        const originalCreate = backendApi.createView;
        let validationCalls = 0;
        let createCalls = 0;
        backendApi.validateViewDefinition = async () => {
            validationCalls++;
            await validation.promise;
        };
        backendApi.createView = async () => {
            createCalls++;
            return { cancelled: true };
        };
        state.isReadOnly = false;

        try {
            initViews();
            openCreateViewModal();
            elements.viewNameInput.value = 'new_view';
            elements.viewSelectSql.value = 'SELECT 1';
            const save = listener('btnSaveView', 'click');

            const firstSave = save();
            const secondSave = save();
            await Promise.resolve();
            const disabledWhilePending = elements.btnSaveView.disabled;
            const editorDisabledWhilePending = elements.viewSelectSql.disabled;
            const nameDisabledWhilePending = elements.viewNameInput.disabled;
            const preserveTriggersDisabledWhilePending = elements.viewPreserveTriggers.disabled;
            validation.resolve();
            await Promise.all([firstSave, secondSave]);

            assert.strictEqual(validationCalls, 1);
            assert.strictEqual(createCalls, 1);
            assert.strictEqual(disabledWhilePending, true);
            assert.strictEqual(editorDisabledWhilePending, true);
            assert.strictEqual(nameDisabledWhilePending, true);
            assert.strictEqual(preserveTriggersDisabledWhilePending, true);
            assert.strictEqual(elements.btnSaveView.disabled, false);
            assert.strictEqual(elements.viewSelectSql.disabled, false);
            assert.strictEqual(elements.viewNameInput.disabled, false);
            assert.strictEqual(elements.viewPreserveTriggers.disabled, false);
        } finally {
            backendApi.validateViewDefinition = originalValidate;
            backendApi.createView = originalCreate;
        }
    });

    it('preserves a legal create-view identifier through validation and creation', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const stateModulePath = '../../core/ui/modules/state.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { initViews, openCreateViewModal } = await import(viewsModulePath);
        const originals = {
            validate: backendApi.validateViewDefinition,
            create: backendApi.createView
        };
        const validatedNames: string[] = [];
        const createdNames: string[] = [];
        backendApi.validateViewDefinition = async (name: string) => {
            validatedNames.push(name);
        };
        backendApi.createView = async (name: string) => {
            createdNames.push(name);
            return { cancelled: true };
        };
        state.isReadOnly = false;

        try {
            initViews();
            openCreateViewModal();
            elements.viewNameInput.value = ' ui "view" 🚀 ';
            elements.viewSelectSql.value = 'SELECT 1 AS value';

            await listener('btnSaveView', 'click')();

            assert.deepStrictEqual(validatedNames, [' ui "view" 🚀 ']);
            assert.deepStrictEqual(createdNames, [' ui "view" 🚀 ']);
        } finally {
            backendApi.validateViewDefinition = originals.validate;
            backendApi.createView = originals.create;
        }
    });

    it('rejects a NUL create-view identifier before validation', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const stateModulePath = '../../core/ui/modules/state.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { initViews, openCreateViewModal } = await import(viewsModulePath);
        const originals = {
            validate: backendApi.validateViewDefinition,
            create: backendApi.createView
        };
        let validationCalls = 0;
        let createCalls = 0;
        backendApi.validateViewDefinition = async () => { validationCalls++; };
        backendApi.createView = async () => { createCalls++; };
        state.isReadOnly = false;

        try {
            initViews();
            openCreateViewModal();
            elements.viewNameInput.value = 'bad\0view';
            elements.viewSelectSql.value = 'SELECT 1 AS value';

            await listener('btnSaveView', 'click')();

            assert.strictEqual(validationCalls, 0);
            assert.strictEqual(createCalls, 0);
            assert.match(elements.viewValidationStatus.textContent, /View name cannot contain NUL/);
        } finally {
            backendApi.validateViewDefinition = originals.validate;
            backendApi.createView = originals.create;
        }
    });

    it('keeps the external editor result when the same view modal is reopened', async () => {
        const { elements } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const modalsModulePath = '../../core/ui/modules/modals.js';
        const { backendApi } = await import(apiModulePath);
        const { openEditViewModal } = await import(viewsModulePath);
        const { closeModal } = await import(modalsModulePath);
        const originalGet = backendApi.getViewDefinition;
        let selectSql = 'SELECT quantity FROM inventory';
        backendApi.getViewDefinition = async () => ({ selectSql, triggers: [] });

        try {
            await openEditViewModal('inventory_view');
            assert.strictEqual(elements.viewSelectSql.value, selectSql);
            closeModal('viewModal');

            // The virtual SQL document was saved and the host refreshed schema/data.
            selectSql = 'SELECT SUM(quantity) AS total FROM inventory';
            await openEditViewModal('inventory_view');

            assert.strictEqual(elements.viewNameInput.value, 'inventory_view');
            assert.strictEqual(elements.viewSelectSql.value, selectSql);
            assert.notStrictEqual(elements.viewSelectSql.value, '');
            assert.strictEqual(elements.viewModal.classList.contains('hidden'), false);
        } finally {
            backendApi.getViewDefinition = originalGet;
        }
    });

    it('does not let a stale external-editor completion close a newer view draft', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const modalsModulePath = '../../core/ui/modules/modals.js';
        const { backendApi } = await import(apiModulePath);
        const { initViews, openEditViewModal } = await import(viewsModulePath);
        const { closeModal } = await import(modalsModulePath);
        const openingEditor = createDeferred<void>();
        const originals = {
            get: backendApi.getViewDefinition,
            open: backendApi.openViewEditor
        };
        const openedViews: string[] = [];
        backendApi.getViewDefinition = async (view: string) => ({
            sql: `CREATE VIEW ${view} AS SELECT 1`,
            selectSql: `SELECT '${view}'`,
            triggers: []
        });
        backendApi.openViewEditor = async (view: string) => {
            openedViews.push(view);
            await openingEditor.promise;
        };

        try {
            initViews();
            await openEditViewModal('old_view');
            const pendingOpen = listener('btnOpenViewInVsCode', 'click')();

            closeModal('viewModal');
            await openEditViewModal('new_view');
            elements.viewSelectSql.value = 'SELECT new_draft';
            assert.strictEqual(elements.statusText.textContent, 'Ready');

            openingEditor.resolve();
            await pendingOpen;

            assert.deepStrictEqual(openedViews, ['old_view']);
            assert.strictEqual(elements.viewNameInput.value, 'new_view');
            assert.strictEqual(elements.viewSelectSql.value, 'SELECT new_draft');
            assert.strictEqual(elements.viewModal.classList.contains('hidden'), false);
            assert.strictEqual(elements.statusText.textContent, 'Ready');
        } finally {
            backendApi.getViewDefinition = originals.get;
            backendApi.openViewEditor = originals.open;
        }
    });

    it('uses Tab for SQL indentation without moving focus to modal buttons', async () => {
        const { elements, listener } = installViewDocument();
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { initViews, openCreateViewModal } = await import(viewsModulePath);

        initViews();
        openCreateViewModal();
        elements.viewSelectSql.value = 'SELECT\nvalue';
        elements.viewSelectSql.selectionStart = 7;
        elements.viewSelectSql.selectionEnd = 7;
        let prevented = false;

        listener('viewSelectSql', 'keydown')({
            key: 'Tab',
            shiftKey: false,
            target: elements.viewSelectSql,
            preventDefault() { prevented = true; }
        });

        assert.strictEqual(prevented, true);
        assert.strictEqual(elements.viewSelectSql.value, 'SELECT\n    value');
        assert.strictEqual(elements.viewSelectSql.selectionStart, 11);
    });

    it('clears the one-shot Tab focus escape on blur and modal reopen', async () => {
        const { elements, listener } = installViewDocument();
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { initViews, openCreateViewModal } = await import(viewsModulePath);

        initViews();
        openCreateViewModal();
        elements.viewSelectSql.value = 'SELECT 1';
        elements.viewSelectSql.selectionStart = 8;
        elements.viewSelectSql.selectionEnd = 8;
        const keydown = listener('viewSelectSql', 'keydown');
        const escapeEvent = () => ({
            key: 'Escape',
            shiftKey: false,
            target: elements.viewSelectSql,
            preventDefault() {},
            stopPropagation() {}
        });
        const tabEvent = () => ({
            key: 'Tab',
            shiftKey: false,
            target: elements.viewSelectSql,
            preventDefault() {}
        });

        keydown(escapeEvent());
        listener('viewSelectSql', 'blur')({ target: elements.viewSelectSql });
        keydown(tabEvent());
        assert.strictEqual(elements.viewSelectSql.value, 'SELECT 1    ');

        elements.viewSelectSql.value = 'SELECT 2';
        elements.viewSelectSql.selectionStart = 8;
        elements.viewSelectSql.selectionEnd = 8;
        keydown(escapeEvent());
        openCreateViewModal();
        elements.viewSelectSql.selectionStart = elements.viewSelectSql.value.length;
        elements.viewSelectSql.selectionEnd = elements.viewSelectSql.value.length;
        keydown(tabEvent());
        assert.strictEqual(elements.viewSelectSql.value, 'SELECT 1 AS value    ');
    });

    it('does not let a pending save mutate a newer modal session', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const stateModulePath = '../../core/ui/modules/state.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const modalsModulePath = '../../core/ui/modules/modals.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { initViews, openCreateViewModal, openEditViewModal } = await import(viewsModulePath);
        const { closeModal } = await import(modalsModulePath);
        const validation = createDeferred<void>();
        const originalGet = backendApi.getViewDefinition;
        const originalValidate = backendApi.validateViewDefinition;
        const originalEdit = backendApi.editView;
        const originalCreate = backendApi.createView;
        let editCalls = 0;
        let createCalls = 0;
        backendApi.getViewDefinition = async () => ({ selectSql: 'SELECT 1 AS a', triggers: [] });
        backendApi.validateViewDefinition = async () => validation.promise;
        backendApi.editView = async () => { editCalls++; };
        backendApi.createView = async () => { createCalls++; };
        state.isReadOnly = false;

        try {
            initViews();
            await openEditViewModal('view_a');
            elements.viewSelectSql.value = 'SELECT 2 AS a';
            const pendingSave = listener('btnSaveView', 'click')();
            await Promise.resolve();

            closeModal('viewModal');
            openCreateViewModal();
            elements.viewNameInput.value = 'view_b';
            elements.viewSelectSql.value = 'SELECT 3 AS b';
            validation.resolve();
            await pendingSave;

            assert.strictEqual(editCalls, 0);
            assert.strictEqual(createCalls, 0);
            assert.strictEqual(elements.viewNameInput.value, 'view_b');
            assert.strictEqual(elements.viewSelectSql.value, 'SELECT 3 AS b');
            assert.strictEqual(elements.viewModal.classList.contains('hidden'), false);
        } finally {
            backendApi.getViewDefinition = originalGet;
            backendApi.validateViewDefinition = originalValidate;
            backendApi.editView = originalEdit;
            backendApi.createView = originalCreate;
        }
    });

    it('does not let an old save unlock controls owned by a newer reload', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const stateModulePath = '../../core/ui/modules/state.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const modalsModulePath = '../../core/ui/modules/modals.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { initViews, openCreateViewModal, openEditViewModal } = await import(viewsModulePath);
        const { closeModal } = await import(modalsModulePath);
        const validation = createDeferred<void>();
        const validationStarted = createDeferred<void>();
        const latestDefinition = createDeferred<any>();
        const originals = {
            get: backendApi.getViewDefinition,
            validate: backendApi.validateViewDefinition,
            create: backendApi.createView
        };
        let getCalls = 0;
        let createCalls = 0;
        backendApi.getViewDefinition = async () => {
            if (getCalls++ === 0) {
                return {
                    sql: 'CREATE VIEW newer_view AS SELECT 1 AS value',
                    selectSql: 'SELECT 1 AS value',
                    triggers: []
                };
            }
            return latestDefinition.promise;
        };
        backendApi.validateViewDefinition = async () => {
            validationStarted.resolve();
            return validation.promise;
        };
        backendApi.createView = async () => { createCalls++; };
        const originalReadOnly = state.isReadOnly;
        state.isReadOnly = false;

        try {
            initViews();
            openCreateViewModal();
            elements.viewNameInput.value = 'older_view';
            elements.viewSelectSql.value = 'SELECT 1 AS value';
            const pendingSave = listener('btnSaveView', 'click')();
            await validationStarted.promise;

            closeModal('viewModal');
            await openEditViewModal('newer_view');
            elements.btnReloadViewDefinition.hidden = false;
            const pendingReload = listener('btnReloadViewDefinition', 'click')();

            assert.strictEqual(elements.viewSelectSql.disabled, true);
            assert.strictEqual(elements.viewPreserveTriggers.disabled, true);
            assert.strictEqual(elements.btnSaveView.disabled, true);
            assert.strictEqual(elements.btnReloadViewDefinition.disabled, true);

            validation.resolve();
            await pendingSave;

            assert.strictEqual(createCalls, 0);
            assert.strictEqual(elements.viewSelectSql.disabled, true);
            assert.strictEqual(elements.viewPreserveTriggers.disabled, true);
            assert.strictEqual(elements.btnSaveView.disabled, true);
            assert.strictEqual(elements.btnReloadViewDefinition.disabled, true);

            latestDefinition.resolve({
                sql: 'CREATE VIEW newer_view AS SELECT 2 AS value',
                selectSql: 'SELECT 2 AS value',
                triggers: []
            });
            await pendingReload;

            assert.strictEqual(elements.viewNameInput.disabled, true);
            assert.strictEqual(elements.viewSelectSql.disabled, false);
            assert.strictEqual(elements.viewPreserveTriggers.disabled, false);
            assert.strictEqual(elements.btnSaveView.disabled, false);
            assert.strictEqual(elements.btnReloadViewDefinition.disabled, false);
        } finally {
            backendApi.getViewDefinition = originals.get;
            backendApi.validateViewDefinition = originals.validate;
            backendApi.createView = originals.create;
            state.isReadOnly = originalReadOnly;
        }
    });

    it('ignores a preview response for a superseded draft', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { backendApi } = await import(apiModulePath);
        const { initViews, openCreateViewModal } = await import(viewsModulePath);
        const oldPreview = createDeferred<any>();
        const newPreview = createDeferred<any>();
        const originalPreview = backendApi.previewViewDefinition;
        backendApi.previewViewDefinition = async (_name: string, sql: string) => (
            sql.includes('old') ? oldPreview.promise : newPreview.promise
        );

        try {
            initViews();
            openCreateViewModal();
            elements.viewNameInput.value = 'previewed_view';
            elements.viewSelectSql.value = 'SELECT old';
            const preview = listener('btnPreviewView', 'click');
            const staleRequest = preview();

            elements.viewSelectSql.value = 'SELECT new';
            const currentRequest = preview();
            newPreview.resolve({ headers: ['value'], rows: [[1]] });
            await currentRequest;
            assert.match(elements.viewValidationStatus.textContent, /Preview returned 1 row/);

            oldPreview.resolve({ headers: ['value'], rows: [[1], [2]] });
            await staleRequest;
            assert.match(elements.viewValidationStatus.textContent, /Preview returned 1 row/);
        } finally {
            backendApi.previewViewDefinition = originalPreview;
        }
    });

    it('renders exact unsafe INTEGER digits from the preview sidecar', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { backendApi } = await import(apiModulePath);
        const { initViews, openCreateViewModal } = await import(viewsModulePath);
        const originalPreview = backendApi.previewViewDefinition;
        backendApi.previewViewDefinition = async () => ({
            headers: ['value'],
            rows: [[9007199254740992]],
            exactIntegerTexts: { 0: { 0: '9007199254740993' } }
        });

        try {
            initViews();
            openCreateViewModal();
            elements.viewNameInput.value = 'unsafe_integer_preview';
            elements.viewSelectSql.value = 'SELECT 9007199254740993 AS value';

            await listener('btnPreviewView', 'click')();

            const table = elements.viewPreview.children[0];
            const tbody = table.children[1];
            const cell = tbody.children[0].children[0];
            assert.strictEqual(cell.textContent, '9007199254740993');
        } finally {
            backendApi.previewViewDefinition = originalPreview;
        }
    });

    it('ignores validation feedback when the draft changes before validation settles', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { backendApi } = await import(apiModulePath);
        const { initViews, openCreateViewModal } = await import(viewsModulePath);
        const validation = createDeferred<void>();
        const originalValidate = backendApi.validateViewDefinition;
        backendApi.validateViewDefinition = async () => validation.promise;

        try {
            initViews();
            openCreateViewModal();
            elements.viewNameInput.value = 'draft_bound_validation';
            elements.viewSelectSql.value = 'SELECT old_value';
            const pendingValidation = listener('btnValidateView', 'click')();

            elements.viewSelectSql.value = 'SELECT new_value';
            validation.resolve();
            await pendingValidation;

            assert.notStrictEqual(
                elements.viewValidationStatus.textContent,
                'Definition is valid.'
            );
        } finally {
            backendApi.validateViewDefinition = originalValidate;
        }
    });

    it('passes create and edit intent through validation and preview requests', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const stateModulePath = '../../core/ui/modules/state.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { initViews, openCreateViewModal, openEditViewModal } = await import(viewsModulePath);
        const originals = {
            get: backendApi.getViewDefinition,
            validate: backendApi.validateViewDefinition,
            preview: backendApi.previewViewDefinition
        };
        const validateCalls: unknown[][] = [];
        const previewCalls: unknown[][] = [];
        backendApi.getViewDefinition = async () => ({
            sql: 'CREATE VIEW existing_view AS SELECT 1 AS value',
            selectSql: 'SELECT 1 AS value',
            triggers: []
        });
        backendApi.validateViewDefinition = async (...args: unknown[]) => {
            validateCalls.push(args);
        };
        backendApi.previewViewDefinition = async (...args: unknown[]) => {
            previewCalls.push(args);
            return { headers: ['value'], rows: [[1]] };
        };
        const originalReadOnly = state.isReadOnly;
        state.isReadOnly = false;

        try {
            initViews();
            openCreateViewModal();
            elements.viewNameInput.value = 'new_view';
            elements.viewSelectSql.value = 'SELECT 2 AS value';
            await listener('btnValidateView', 'click')();
            await listener('btnPreviewView', 'click')();

            await openEditViewModal('existing_view');
            elements.viewSelectSql.value = 'SELECT 3 AS value';
            await listener('btnValidateView', 'click')();
            await listener('btnPreviewView', 'click')();

            assert.deepStrictEqual(validateCalls, [
                ['new_view', 'SELECT 2 AS value', 'create'],
                ['existing_view', 'SELECT 3 AS value', 'edit']
            ]);
            assert.deepStrictEqual(previewCalls, [
                ['new_view', 'SELECT 2 AS value', 50, 'create'],
                ['existing_view', 'SELECT 3 AS value', 50, 'edit']
            ]);
        } finally {
            backendApi.getViewDefinition = originals.get;
            backendApi.validateViewDefinition = originals.validate;
            backendApi.previewViewDefinition = originals.preview;
            state.isReadOnly = originalReadOnly;
        }
    });

    it('keeps a modal draft open when the stored view changed and can reload the latest definition', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const stateModulePath = '../../core/ui/modules/state.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { initViews, openEditViewModal } = await import(viewsModulePath);
        const originalDefinition = {
            sql: 'CREATE VIEW shared_view AS SELECT 1 AS value',
            selectSql: 'SELECT 1 AS value',
            triggers: []
        };
        const latestDefinition = {
            sql: 'CREATE VIEW shared_view AS SELECT 2 AS value',
            selectSql: 'SELECT 2 AS value',
            triggers: []
        };
        const originals = {
            get: backendApi.getViewDefinition,
            validate: backendApi.validateViewDefinition,
            edit: backendApi.editView
        };
        let getCalls = 0;
        let editCalls = 0;
        backendApi.getViewDefinition = async () => (
            getCalls++ === 0 ? originalDefinition : latestDefinition
        );
        backendApi.validateViewDefinition = async () => undefined;
        backendApi.editView = async () => {
            editCalls++;
            return {};
        };
        const originalReadOnly = state.isReadOnly;
        state.isReadOnly = false;

        try {
            initViews();
            await openEditViewModal('shared_view');
            elements.viewSelectSql.value = 'SELECT 3 AS value';

            await listener('btnSaveView', 'click')();

            assert.strictEqual(editCalls, 0);
            assert.strictEqual(elements.viewModal.classList.contains('hidden'), false);
            assert.match(elements.viewValidationStatus.textContent, /changed outside this editor/i);
            assert.strictEqual(elements.btnReloadViewDefinition.hidden, false);
            assert.strictEqual(elements.viewSelectSql.value, 'SELECT 3 AS value');

            await listener('btnReloadViewDefinition', 'click')();
            assert.strictEqual(elements.viewSelectSql.value, latestDefinition.selectSql);
            assert.strictEqual(elements.btnReloadViewDefinition.hidden, true);
            assert.match(elements.viewValidationStatus.textContent, /latest definition loaded/i);
        } finally {
            backendApi.getViewDefinition = originals.get;
            backendApi.validateViewDefinition = originals.validate;
            backendApi.editView = originals.edit;
            state.isReadOnly = originalReadOnly;
        }
    });

    it('locks every draft control while reloading the latest definition', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { backendApi } = await import(apiModulePath);
        const { initViews, openEditViewModal } = await import(viewsModulePath);
        const latestDefinition = createDeferred<any>();
        const originalGet = backendApi.getViewDefinition;
        let getCalls = 0;
        backendApi.getViewDefinition = async () => {
            if (getCalls++ === 0) {
                return {
                    sql: 'CREATE VIEW shared_view AS SELECT 1 AS value',
                    selectSql: 'SELECT 1 AS value',
                    triggers: []
                };
            }
            return latestDefinition.promise;
        };

        try {
            initViews();
            await openEditViewModal('shared_view');

            const reload = listener('btnReloadViewDefinition', 'click')();
            await Promise.resolve();

            assert.strictEqual(elements.viewNameInput.disabled, true);
            assert.strictEqual(elements.viewSelectSql.disabled, true);
            assert.strictEqual(elements.viewPreserveTriggers.disabled, true);
            assert.strictEqual(elements.btnSaveView.disabled, true);
            assert.strictEqual(elements.btnReloadViewDefinition.disabled, true);

            latestDefinition.resolve({
                sql: 'CREATE VIEW shared_view AS SELECT 2 AS value',
                selectSql: 'SELECT 2 AS value',
                triggers: []
            });
            await reload;

            assert.strictEqual(elements.viewNameInput.disabled, true);
            assert.strictEqual(elements.viewSelectSql.disabled, false);
            assert.strictEqual(elements.viewPreserveTriggers.disabled, false);
            assert.strictEqual(elements.btnSaveView.disabled, false);
            assert.strictEqual(elements.btnReloadViewDefinition.disabled, false);
            assert.strictEqual(elements.viewSelectSql.value, 'SELECT 2 AS value');
        } finally {
            backendApi.getViewDefinition = originalGet;
        }
    });

    it('shows the friendly reload conflict when the engine-side snapshot check wins a race', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const stateModulePath = '../../core/ui/modules/state.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { initViews, openEditViewModal } = await import(viewsModulePath);
        const originalDefinition = {
            sql: 'CREATE VIEW shared_view AS SELECT 1 AS value',
            selectSql: 'SELECT 1 AS value',
            triggers: []
        };
        const originals = {
            get: backendApi.getViewDefinition,
            validate: backendApi.validateViewDefinition,
            edit: backendApi.editView
        };
        const editArguments: unknown[][] = [];
        backendApi.getViewDefinition = async () => originalDefinition;
        backendApi.validateViewDefinition = async () => undefined;
        backendApi.editView = async (...args: unknown[]) => {
            editArguments.push(args);
            throw new Error(
                'This view changed outside this editor. Reload before saving; the view was not modified.'
            );
        };
        const originalReadOnly = state.isReadOnly;
        state.isReadOnly = false;

        try {
            initViews();
            await openEditViewModal('shared_view');
            elements.viewSelectSql.value = 'SELECT 3 AS value';

            await listener('btnSaveView', 'click')();

            assert.deepStrictEqual(editArguments, [[
                'shared_view',
                'SELECT 3 AS value',
                true,
                originalDefinition.sql,
                originalDefinition.triggers
            ]]);
            assert.strictEqual(elements.viewModal.classList.contains('hidden'), false);
            assert.match(elements.viewValidationStatus.textContent, /changed outside this editor/i);
            assert.strictEqual(elements.btnReloadViewDefinition.hidden, false);
        } finally {
            backendApi.getViewDefinition = originals.get;
            backendApi.validateViewDefinition = originals.validate;
            backendApi.editView = originals.edit;
            state.isReadOnly = originalReadOnly;
        }
    });

    it('keeps a modal draft open when only the view trigger snapshot changed', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const stateModulePath = '../../core/ui/modules/state.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { initViews, openEditViewModal } = await import(viewsModulePath);
        const originalDefinition = {
            sql: 'CREATE VIEW trigger_shared_view AS SELECT 1 AS value',
            selectSql: 'SELECT 1 AS value',
            triggers: [{ identifier: 'first_trigger', sql: 'CREATE TRIGGER first_trigger' }]
        };
        const latestDefinition = {
            ...originalDefinition,
            triggers: [
                ...originalDefinition.triggers,
                { identifier: 'second_trigger', sql: 'CREATE TRIGGER second_trigger' }
            ]
        };
        const originals = {
            get: backendApi.getViewDefinition,
            validate: backendApi.validateViewDefinition,
            edit: backendApi.editView
        };
        let getCalls = 0;
        let editCalls = 0;
        backendApi.getViewDefinition = async () => (
            getCalls++ === 0 ? originalDefinition : latestDefinition
        );
        backendApi.validateViewDefinition = async () => undefined;
        backendApi.editView = async () => { editCalls++; };
        const originalReadOnly = state.isReadOnly;
        state.isReadOnly = false;

        try {
            initViews();
            await openEditViewModal('trigger_shared_view');
            elements.viewSelectSql.value = 'SELECT 2 AS value';

            await listener('btnSaveView', 'click')();

            assert.strictEqual(editCalls, 0);
            assert.strictEqual(elements.viewModal.classList.contains('hidden'), false);
            assert.match(elements.viewValidationStatus.textContent, /changed outside this editor/i);
            assert.strictEqual(elements.btnReloadViewDefinition.hidden, false);
        } finally {
            backendApi.getViewDefinition = originals.get;
            backendApi.validateViewDefinition = originals.validate;
            backendApi.editView = originals.edit;
            state.isReadOnly = originalReadOnly;
        }
    });

    it('does not let a superseded successful save overwrite newer modal status', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const stateModulePath = '../../core/ui/modules/state.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { initViews, openCreateViewModal, openEditViewModal } = await import(viewsModulePath);
        const validation = createDeferred<void>();
        const mutation = createDeferred<any>();
        const mutationStarted = createDeferred<void>();
        const originals = {
            get: backendApi.getViewDefinition,
            validate: backendApi.validateViewDefinition,
            create: backendApi.createView
        };
        backendApi.getViewDefinition = async () => ({ selectSql: 'SELECT 2', triggers: [] });
        backendApi.validateViewDefinition = async () => validation.promise;
        backendApi.createView = async () => {
            mutationStarted.resolve();
            return mutation.promise;
        };
        state.isReadOnly = false;
        state.isDbConnected = false;

        try {
            initViews();
            openCreateViewModal();
            elements.viewNameInput.value = 'old_view';
            elements.viewSelectSql.value = 'SELECT 1';
            const pendingSave = listener('btnSaveView', 'click')();
            validation.resolve();
            await mutationStarted.promise;

            await openEditViewModal('new_view');
            assert.strictEqual(elements.statusText.textContent, 'Ready');
            mutation.resolve({});
            await pendingSave;

            assert.strictEqual(elements.statusText.textContent, 'Ready');
        } finally {
            backendApi.getViewDefinition = originals.get;
            backendApi.validateViewDefinition = originals.validate;
            backendApi.createView = originals.create;
        }
    });

    it('does not let a superseded failed save overwrite newer modal status', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const stateModulePath = '../../core/ui/modules/state.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { initViews, openCreateViewModal, openEditViewModal } = await import(viewsModulePath);
        const validation = createDeferred<void>();
        const mutation = createDeferred<any>();
        const mutationStarted = createDeferred<void>();
        const originals = {
            get: backendApi.getViewDefinition,
            validate: backendApi.validateViewDefinition,
            create: backendApi.createView
        };
        backendApi.getViewDefinition = async () => ({ selectSql: 'SELECT 2', triggers: [] });
        backendApi.validateViewDefinition = async () => validation.promise;
        backendApi.createView = async () => {
            mutationStarted.resolve();
            return mutation.promise;
        };
        state.isReadOnly = false;
        state.isDbConnected = false;

        try {
            initViews();
            openCreateViewModal();
            elements.viewNameInput.value = 'old_view';
            elements.viewSelectSql.value = 'SELECT 1';
            const pendingSave = listener('btnSaveView', 'click')();
            validation.resolve();
            await mutationStarted.promise;

            await openEditViewModal('new_view');
            assert.strictEqual(elements.statusText.textContent, 'Ready');
            mutation.reject(new Error('stale failure'));
            await pendingSave;

            assert.strictEqual(elements.statusText.textContent, 'Ready');
        } finally {
            backendApi.getViewDefinition = originals.get;
            backendApi.validateViewDefinition = originals.validate;
            backendApi.createView = originals.create;
        }
    });

    it('clears positional selection before reloading an edited selected view', async () => {
        const { elements, listener } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const stateModulePath = '../../core/ui/modules/state.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { initViews, openEditViewModal } = await import(viewsModulePath);
        const originals = {
            get: backendApi.getViewDefinition,
            validate: backendApi.validateViewDefinition,
            edit: backendApi.editView,
            info: backendApi.getTableInfo
        };
        let selectionWasClearedAtReload = false;
        backendApi.getViewDefinition = async () => ({ selectSql: 'SELECT 1 AS a', triggers: [] });
        backendApi.validateViewDefinition = async () => undefined;
        backendApi.editView = async () => ({});
        backendApi.getTableInfo = async () => {
            selectionWasClearedAtReload = state.selectedCells.length === 0
                && state.selectedRowIds.size === 0
                && state.selectedColumns.size === 0
                && state.lastSelectedCell === null
                && state.lastSelectedColumnIndex === null
                && state.lastSelectedRowIndex === null;
            state.selectedTable = null;
            return [];
        };
        state.isReadOnly = false;
        state.isDbConnected = false;
        state.selectedTable = 'selected_view';
        state.selectedTableType = 'view';
        state.gridData = [[1]];
        state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 0, value: 1 }];
        state.selectedRowIds = new Set([0]);
        state.selectedColumns = new Set(['a']);
        state.lastSelectedCell = { rowIdx: 0, colIdx: 0 };
        state.lastSelectedColumnIndex = 0;
        state.lastSelectedRowIndex = 0;

        try {
            initViews();
            await openEditViewModal('selected_view');
            elements.viewSelectSql.value = 'SELECT 2 AS b';
            await listener('btnSaveView', 'click')();
            assert.strictEqual(selectionWasClearedAtReload, true);
        } finally {
            backendApi.getViewDefinition = originals.get;
            backendApi.validateViewDefinition = originals.validate;
            backendApi.editView = originals.edit;
            backendApi.getTableInfo = originals.info;
            state.selectedTable = null;
        }
    });

    it('persists the cleared selection after dropping the displayed view', async () => {
        const { elements } = installViewDocument();
        const apiModulePath = '../../core/ui/modules/api.js';
        const stateModulePath = '../../core/ui/modules/state.js';
        const viewsModulePath = '../../core/ui/modules/views.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { dropViewFromSidebar } = await import(viewsModulePath);
        const originalDrop = backendApi.dropView;
        const originalSetTimeout = globalThis.setTimeout;
        const originalClearTimeout = globalThis.clearTimeout;
        let persistCallback: (() => void) | undefined;
        backendApi.dropView = async () => ({});
        (globalThis as any).setTimeout = (callback: () => void) => {
            persistCallback = callback;
            return 1;
        };
        (globalThis as any).clearTimeout = () => undefined;
        state.isReadOnly = false;
        state.isDbConnected = false;
        state.selectedTable = 'dropped_view';
        state.selectedTableType = 'view';
        state.selectedColumns = new Set(['stale']);

        try {
            await dropViewFromSidebar('dropped_view');
            assert.ok(persistCallback, 'dropping the selected view should schedule state persistence');
            persistCallback();

            assert.strictEqual(elements.tableNameLabel.textContent, 'No table selected');
            assert.ok(persistedStates.at(-1));
            assert.strictEqual(persistedStates.at(-1).selectedTable, null);
            assert.strictEqual(persistedStates.at(-1).selectedTableType, 'table');
            assert.deepStrictEqual(persistedStates.at(-1).selectedColumns, []);
        } finally {
            backendApi.dropView = originalDrop;
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
            state.selectedTable = null;
        }
    });
});
