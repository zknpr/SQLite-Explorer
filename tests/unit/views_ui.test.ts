import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

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
        disabled: false,
        hidden: false,
        checked: true,
        classList: createClassList(),
        replaceChildren() {},
        focus() {},
        addEventListener(type: string, listener: (...args: any[]) => any) {
            listeners.set(`${(this as any).id}:${type}`, listener);
        },
        ...overrides
    });
    const elements: Record<string, any> = {
        viewModalTitle: element(),
        viewNameInput: element(),
        viewSelectSql: element(),
        viewValidationStatus: element(),
        viewPreview: element(),
        viewTriggerOptions: element(),
        viewTriggerSummary: element(),
        viewPreserveTriggers: element(),
        btnOpenViewInVsCode: element({ id: 'btnOpenViewInVsCode' }),
        btnSaveView: element({ id: 'btnSaveView' }),
        btnValidateView: element({ id: 'btnValidateView' }),
        btnPreviewView: element({ id: 'btnPreviewView' }),
        viewModal: element({
            querySelector() { return { focus() {} }; }
        }),
        statusText: element()
    };
    (globalThis as any).document = {
        getElementById(id: string) {
            return elements[id] ?? null;
        },
        querySelectorAll() { return []; },
        createElement() { return element({ appendChild() {} }); }
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
    afterEach(() => {
        delete (globalThis as any).document;
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
            validation.resolve();
            await Promise.all([firstSave, secondSave]);

            assert.strictEqual(validationCalls, 1);
            assert.strictEqual(createCalls, 1);
            assert.strictEqual(disabledWhilePending, true);
            assert.strictEqual(elements.btnSaveView.disabled, false);
        } finally {
            backendApi.validateViewDefinition = originalValidate;
            backendApi.createView = originalCreate;
        }
    });
});
