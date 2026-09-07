import './vscode_mock_setup';

import { it } from 'node:test';
import assert from 'node:assert';
import { createDeferred } from './helpers/deferred';

(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState() {},
    postMessage() {}
});

function installSidebarDocument(persistedWidth?: number) {
    const handleListeners = new Map<string, (event: any) => unknown>();
    const documentListeners = new Map<string, (event: any) => unknown>();
    const sidebar = { style: { width: '' } };
    const handle: any = {
        attributes: {} as Record<string, string>,
        addEventListener(type: string, listener: (event: any) => unknown) {
            handleListeners.set(type, listener);
        },
        setAttribute(name: string, value: string) {
            this.attributes[name] = value;
        }
    };
    const vscodeEnv = {
        dataset: persistedWidth === undefined
            ? {}
            : { sidebarLeft: String(persistedWidth) }
    };
    (globalThis as any).document = {
        body: { style: { cursor: '' } },
        getElementById(id: string) {
            if (id === 'sidebarPanel') return sidebar;
            if (id === 'resizeHandle') return handle;
            if (id === 'vscode-env') return vscodeEnv;
            if (id === 'statusText') return { textContent: '' };
            return null;
        },
        addEventListener(type: string, listener: (event: any) => unknown) {
            documentListeners.set(type, listener);
        }
    };
    return { sidebar, handle, handleListeners, documentListeners };
}

it('persists the final sidebar width and applies it on the next initialization', async () => {
    const apiModulePath = '../../core/ui/modules/api.js';
    const uiModulePath = '../../core/ui/modules/ui.js';
    const { backendApi } = await import(apiModulePath);
    const { initSidebarResize } = await import(uiModulePath);
    const originalSaveSidebarState = backendApi.saveSidebarState;
    let saved: { side: string; width: number } | undefined;
    backendApi.saveSidebarState = async (side: string, width: number) => {
        saved = { side, width };
    };

    try {
        const first = installSidebarDocument();
        initSidebarResize();
        const mousedown = first.handleListeners.get('mousedown');
        const mousemove = first.documentListeners.get('mousemove');
        const mouseup = first.documentListeners.get('mouseup');
        assert.ok(mousedown && mousemove && mouseup);

        mousedown({ preventDefault() {} });
        mousemove({ clientX: 333 });
        await mouseup({});

        assert.deepStrictEqual(saved, { side: 'left', width: 333 });

        const restored = installSidebarDocument(saved.width);
        initSidebarResize();
        assert.strictEqual(restored.sidebar.style.width, '333px');
    } finally {
        backendApi.saveSidebarState = originalSaveSidebarState;
        delete (globalThis as any).document;
    }
});

it('resizes and persists the sidebar with the keyboard', async () => {
    const apiModulePath = '../../core/ui/modules/api.js';
    const uiModulePath = '../../core/ui/modules/ui.js';
    const { backendApi } = await import(apiModulePath);
    const { initSidebarResize } = await import(uiModulePath);
    const originalSaveSidebarState = backendApi.saveSidebarState;
    const saved: number[] = [];
    backendApi.saveSidebarState = async (_side: string, width: number) => {
        saved.push(width);
    };

    try {
        const fixture = installSidebarDocument(220);
        initSidebarResize();
        const keydown = fixture.handleListeners.get('keydown');
        assert.ok(keydown, 'sidebar resize handle must register keyboard input');
        let prevented = 0;

        await keydown({
            key: 'ArrowRight',
            shiftKey: false,
            preventDefault() { prevented++; }
        });
        await keydown({
            key: 'ArrowLeft',
            shiftKey: true,
            preventDefault() { prevented++; }
        });

        assert.strictEqual(fixture.sidebar.style.width, '229px');
        assert.deepStrictEqual(saved, [230, 229]);
        assert.strictEqual(fixture.handle.attributes['aria-valuenow'], '229');
        assert.strictEqual(prevented, 2);
    } finally {
        backendApi.saveSidebarState = originalSaveSidebarState;
        delete (globalThis as any).document;
    }
});

it('serializes repeated keyboard resize persistence in input order', async () => {
    const apiModulePath = '../../core/ui/modules/api.js';
    const uiModulePath = '../../core/ui/modules/ui.js';
    const { backendApi } = await import(apiModulePath);
    const { initSidebarResize } = await import(uiModulePath);
    const originalSaveSidebarState = backendApi.saveSidebarState;
    const firstSave = createDeferred<void>();
    const calls: number[] = [];
    backendApi.saveSidebarState = async (_side: string, width: number) => {
        calls.push(width);
        if (calls.length === 1) await firstSave.promise;
    };

    try {
        const fixture = installSidebarDocument(220);
        initSidebarResize();
        const keydown = fixture.handleListeners.get('keydown');
        assert.ok(keydown);
        const event = {
            key: 'ArrowRight',
            shiftKey: false,
            preventDefault() {}
        };

        const first = keydown(event);
        const second = keydown(event);
        await Promise.resolve();
        assert.deepStrictEqual(calls, [230]);
        firstSave.resolve();
        await Promise.all([first, second]);

        assert.deepStrictEqual(calls, [230, 240]);
    } finally {
        firstSave.resolve();
        backendApi.saveSidebarState = originalSaveSidebarState;
        delete (globalThis as any).document;
    }
});
