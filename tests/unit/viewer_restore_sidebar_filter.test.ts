import './vscode_mock_setup';

import assert from 'node:assert';
import path from 'node:path';
import { it } from 'node:test';
import esbuild from 'esbuild';
import { createDeferred } from './helpers/deferred';

it('restores and renders a saved sidebar filter without a selected table', async () => {
    const completed = createDeferred<void>();
    const state: Record<string, any> = {
        isDbConnected: false,
        selectedTable: null,
        selectedTableType: 'table',
        rowsPerPage: 5000,
        sidebarFilter: ''
    };
    let renderCalls = 0;
    (globalThis as any).__viewerSidebarFilterHarness = {
        state,
        savedState: { rowsPerPage: 5000, sidebarFilter: 'audit' },
        renderSidebar() { renderCalls++; },
        completed
    };
    const elements: Record<string, any> = {
        'vscode-env': { dataset: {} },
        sidebarFilterInput: { value: '' },
        pageSizeSelect: {
            value: '', options: [{ value: '5000' }],
            insertBefore() {}
        }
    };
    (globalThis as any).document = {
        getElementById(id: string) { return elements[id] ?? null; },
        createElement() { return { value: '', textContent: '' }; }
    };

    const entryPoint = path.resolve(__dirname, '../../core/ui/viewer.js');
    const bundle = await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        write: false,
        plugins: [{
            name: 'viewer-sidebar-filter-stubs',
            setup(build) {
                build.onResolve({ filter: /^\.\/modules\// }, args => ({
                    path: args.path,
                    namespace: 'viewer-sidebar-filter-stub'
                }));
                build.onLoad({ filter: /.*/, namespace: 'viewer-sidebar-filter-stub' }, args => {
                    const harness = 'globalThis.__viewerSidebarFilterHarness';
                    const modules: Record<string, string> = {
                        './modules/state.js': `
                            export const state = ${harness}.state;
                            export function createSafeColumnState(value = {}) {
                                return Object.assign(Object.create(null), value);
                            }
                            export function resolveStartupPageSize(_configured, persisted) {
                                return persisted ?? 5000;
                            }
                        `,
                        './modules/rpc.js': 'export function initRpc() {}',
                        './modules/api.js': `
                            export const backendApi = {
                                initialize: async () => ({ connected: true, readOnly: false }),
                                ping: async () => true
                            };
                            export function getVsCodeState() { return ${harness}.savedState; }
                        `,
                        './modules/sidebar.js': `
                            export function initSidebar() {}
                            export function refreshSchema() {}
                            export function renderSidebar() { return ${harness}.renderSidebar(); }
                            export function syncSelectedTableIdentity() {}
                        `,
                        './modules/export.js': 'export function initExport() {}',
                        './modules/crud.js': 'export function initCrud() {}',
                        './modules/ui.js': `
                            export function updateStatus() {}
                            export function showEmptyState() {}
                            export function showErrorState(error) { throw error; }
                            export function initSidebarResize() {}
                        `,
                        './modules/modals.js': 'export function initModals() {}',
                        './modules/grid.js': `
                            export function loadTableColumns() {}
                            export function loadTableData() {}
                            export function initGridInteraction() {}
                            export function initGridControls() {}
                        `,
                        './modules/edit.js': 'export function initEdit() {}',
                        './modules/settings.js': 'export function initSettings() {}',
                        './modules/dnd.js': 'export function initDragAndDrop() {}',
                        './modules/views.js': 'export function initViews() {}',
                        './modules/connection-state.js': `
                            export function applyConnectionResult(result) {
                                ${harness}.state.isDbConnected = !!result?.connected;
                                return ${harness}.state.isDbConnected;
                            }
                        `,
                        './modules/global-shortcuts.js': `
                            export function setupGlobalShortcuts() { ${harness}.completed.resolve(); }
                        `
                    };
                    const contents = modules[args.path];
                    if (!contents) throw new Error(`Missing stub for ${args.path}`);
                    return { contents, loader: 'js' };
                });
            }
        }]
    });

    try {
        const evaluated = { exports: {} };
        new Function('module', 'exports', bundle.outputFiles[0].text)(evaluated, evaluated.exports);
        await completed.promise;
        assert.strictEqual(state.sidebarFilter, 'audit');
        assert.strictEqual(elements.sidebarFilterInput.value, 'audit');
        assert.strictEqual(renderCalls, 1);
    } finally {
        delete (globalThis as any).__viewerSidebarFilterHarness;
        delete (globalThis as any).document;
    }
});
