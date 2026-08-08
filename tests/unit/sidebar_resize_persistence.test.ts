import './vscode_mock_setup';

import { it } from 'node:test';
import assert from 'node:assert';

(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState() {},
    postMessage() {}
});

function installSidebarDocument(persistedWidth?: number) {
    const handleListeners = new Map<string, (event: any) => unknown>();
    const documentListeners = new Map<string, (event: any) => unknown>();
    const sidebar = { style: { width: '' } };
    const handle = {
        addEventListener(type: string, listener: (event: any) => unknown) {
            handleListeners.set(type, listener);
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
    return { sidebar, handleListeners, documentListeners };
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
