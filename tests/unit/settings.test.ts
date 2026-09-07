import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { createDeferred } from './helpers/deferred';

(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState() {},
    postMessage() {}
});

const apiModulePath = '../../core/ui/modules/api.js';
const settingsModulePath = '../../core/ui/modules/settings.js';

class TestElement {
    readonly children: TestElement[] = [];
    readonly dataset: Record<string, string> = {};
    readonly style: Record<string, string> = {};
    className = '';
    id = '';
    htmlFor = '';
    type = '';
    value: any = '';
    selected = false;
    checked = false;
    disabled = false;
    private text = '';

    constructor(readonly tagName: string) {}

    get textContent(): string {
        return this.text;
    }

    set textContent(value: string) {
        this.text = String(value);
        this.children.length = 0;
    }

    appendChild(child: TestElement): TestElement {
        this.children.push(child);
        return child;
    }

    replaceChildren(...children: TestElement[]): void {
        this.text = '';
        this.children.splice(0, this.children.length, ...children);
    }
}

function installSettingsDocument() {
    const container = new TestElement('div');
    const status = new TestElement('div');
    const modal = new TestElement('div') as TestElement & {
        classList: { remove(name: string): void };
    };
    modal.classList = { remove() {} };
    const elements: Record<string, TestElement> = {
        pragmaSettingsContainer: container,
        settingsModal: modal,
        statusText: status
    };

    (globalThis as any).document = {
        getElementById(id: string) {
            return elements[id] ?? null;
        },
        createElement(tagName: string) {
            return new TestElement(tagName);
        },
        createTextNode(text: string) {
            const node = new TestElement('#text');
            node.textContent = text;
            return node;
        }
    };
    return { container, status };
}

function findElement(root: TestElement, predicate: (element: TestElement) => boolean): TestElement | undefined {
    if (predicate(root)) return root;
    for (const child of root.children) {
        const match = findElement(child, predicate);
        if (match) return match;
    }
    return undefined;
}

function collectText(root: TestElement): string {
    return [root.textContent, ...root.children.map(collectText)].filter(Boolean).join(' ');
}

const effectivePragmas = {
    foreign_keys: 1,
    journal_mode: 'delete',
    synchronous: 2,
    cache_size: -2000,
    locking_mode: 'normal',
    temp_store: 0,
    encoding: 'UTF-8',
    auto_vacuum: 0
};

describe('pragma settings', () => {
    afterEach(() => {
        delete (globalThis as any).document;
    });

    it('renders the effective cache_size returned after a successful pragma update', async () => {
        const { container, status } = installSettingsDocument();
        const { backendApi } = await import(apiModulePath);
        const { updatePragma } = await import(settingsModulePath);
        const originalSetPragma = backendApi.setPragma;
        const originalGetPragmas = backendApi.getPragmas;
        const originalGetExtensionSettings = backendApi.getExtensionSettings;
        let reads = 0;
        backendApi.setPragma = async () => {};
        backendApi.getPragmas = async () => {
            reads++;
            return { ...effectivePragmas };
        };
        backendApi.getExtensionSettings = async () => ({
            autoCommit: false,
            cellEditBehavior: 'inline'
        });

        try {
            await updatePragma('cache_size', 999999999);

            assert.strictEqual(reads, 1);
            const cacheSize = findElement(
                container,
                element => element.dataset.name === 'cache_size'
            );
            assert.ok(cacheSize);
            assert.strictEqual(String(cacheSize.value), '-2000');
            assert.strictEqual(status.textContent, 'Updated cache_size');
        } finally {
            backendApi.setPragma = originalSetPragma;
            backendApi.getPragmas = originalGetPragmas;
            backendApi.getExtensionSettings = originalGetExtensionSettings;
        }
    });

    it('labels connection-scoped pragmas as session only', async () => {
        const { container } = installSettingsDocument();
        const { backendApi } = await import(apiModulePath);
        const { openSettingsModal } = await import(settingsModulePath);
        const originalGetPragmas = backendApi.getPragmas;
        const originalGetExtensionSettings = backendApi.getExtensionSettings;
        backendApi.getPragmas = async () => ({ ...effectivePragmas });
        backendApi.getExtensionSettings = async () => ({
            autoCommit: false,
            cellEditBehavior: 'inline'
        });

        try {
            await openSettingsModal();

            const renderedText = collectText(container);
            assert.match(renderedText, /session only/i);
            assert.match(renderedText, /reconnect|connection is reopened/i);
        } finally {
            backendApi.getPragmas = originalGetPragmas;
            backendApi.getExtensionSettings = originalGetExtensionSettings;
        }
    });

    it('honors web-demo extension-setting capabilities', async () => {
        const { container } = installSettingsDocument();
        const { backendApi } = await import(apiModulePath);
        const { openSettingsModal } = await import(settingsModulePath);
        const originalGetPragmas = backendApi.getPragmas;
        const originalGetExtensionSettings = backendApi.getExtensionSettings;
        backendApi.getPragmas = async () => ({ ...effectivePragmas });
        backendApi.getExtensionSettings = async () => ({
            autoCommit: false,
            autoCommitSupported: false,
            cellEditBehavior: 'inline',
            cellEditBehaviorOptions: ['inline', 'modal'],
            fileOperations: 'web'
        });

        try {
            await openSettingsModal();

            const autoCommit = findElement(
                container,
                element => element.dataset.key === 'autoCommit'
            );
            const doubleClick = findElement(
                container,
                element => element.dataset.key === 'doubleClickBehavior'
            );
            assert.strictEqual(autoCommit?.disabled, true);
            assert.deepStrictEqual(
                doubleClick?.children.map(option => option.value),
                ['inline', 'modal']
            );
        } finally {
            backendApi.getPragmas = originalGetPragmas;
            backendApi.getExtensionSettings = originalGetExtensionSettings;
        }
    });

    it('associates every generated setting control with its visible label', async () => {
        const { container } = installSettingsDocument();
        const { backendApi } = await import(apiModulePath);
        const { openSettingsModal } = await import(settingsModulePath);
        const originalGetPragmas = backendApi.getPragmas;
        const originalGetExtensionSettings = backendApi.getExtensionSettings;
        backendApi.getPragmas = async () => ({ ...effectivePragmas });
        backendApi.getExtensionSettings = async () => ({
            autoCommit: false,
            cellEditBehavior: 'inline'
        });

        try {
            await openSettingsModal();

            const controls: TestElement[] = [];
            const collectControls = (element: TestElement) => {
                if (element.tagName === 'input' || element.tagName === 'select') {
                    controls.push(element);
                }
                element.children.forEach(collectControls);
            };
            collectControls(container);
            assert.ok(controls.length > 0, 'settings must render form controls');

            for (const control of controls) {
                assert.notStrictEqual(control.id, '', 'each setting control must have an id');
                const label = findElement(
                    container,
                    element => element.tagName === 'label' && element.htmlFor === control.id
                );
                assert.ok(label, `control ${control.id} must have an associated label`);
            }
        } finally {
            backendApi.getPragmas = originalGetPragmas;
            backendApi.getExtensionSettings = originalGetExtensionSettings;
        }
    });

    it('keeps the newest Settings load when an older request resolves last', async () => {
        const { container } = installSettingsDocument();
        const { backendApi } = await import(apiModulePath);
        const { openSettingsModal } = await import(settingsModulePath);
        const originalGetPragmas = backendApi.getPragmas;
        const originalGetExtensionSettings = backendApi.getExtensionSettings;
        const firstPragmas = createDeferred<any>();
        const secondPragmas = createDeferred<any>();
        let calls = 0;
        backendApi.getPragmas = async () => (
            ++calls === 1 ? firstPragmas.promise : secondPragmas.promise
        );
        backendApi.getExtensionSettings = async () => ({
            autoCommit: false,
            cellEditBehavior: 'inline'
        });

        try {
            const firstOpen = openSettingsModal();
            const secondOpen = openSettingsModal();
            secondPragmas.resolve({ ...effectivePragmas, cache_size: -2222 });
            await secondOpen;
            firstPragmas.resolve({ ...effectivePragmas, cache_size: -1111 });
            await firstOpen;

            const cacheSize = findElement(
                container,
                element => element.dataset.name === 'cache_size'
            );
            assert.strictEqual(String(cacheSize?.value), '-2222');
        } finally {
            backendApi.getPragmas = originalGetPragmas;
            backendApi.getExtensionSettings = originalGetExtensionSettings;
        }
    });

    it('clears stale error styling after a later Settings load succeeds', async () => {
        const { container } = installSettingsDocument();
        const { backendApi } = await import(apiModulePath);
        const { openSettingsModal } = await import(settingsModulePath);
        const originalGetPragmas = backendApi.getPragmas;
        const originalGetExtensionSettings = backendApi.getExtensionSettings;
        const originalConsoleError = console.error;
        let calls = 0;
        backendApi.getPragmas = async () => {
            calls += 1;
            if (calls === 1) throw new Error('temporary settings failure');
            return { ...effectivePragmas };
        };
        backendApi.getExtensionSettings = async () => ({
            autoCommit: false,
            cellEditBehavior: 'inline'
        });
        console.error = () => {};

        try {
            await openSettingsModal();
            assert.strictEqual(container.style.color, 'var(--error-color)');
            await openSettingsModal();
            assert.strictEqual(container.style.color, '');
        } finally {
            backendApi.getPragmas = originalGetPragmas;
            backendApi.getExtensionSettings = originalGetExtensionSettings;
            console.error = originalConsoleError;
        }
    });
});
