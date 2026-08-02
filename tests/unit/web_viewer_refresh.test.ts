import './vscode_mock_setup';

import assert from 'node:assert';
import path from 'node:path';
import { after, it } from 'node:test';
import esbuild from 'esbuild';
import { createDeferred } from './helpers/deferred';

const originalWindow = (globalThis as any).window;
const originalDocument = (globalThis as any).document;

after(() => {
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
    if (originalDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = originalDocument;
    delete (globalThis as any).__webViewerRefreshHarness;
});

it('clears and persists a displayed view selection before the demo refresh reloads it', async () => {
    const response = createDeferred<unknown>();
    const initialSchemaRefresh = createDeferred<void>();
    const state = {
        isDbConnected: true,
        selectedTable: 'shared_view',
        selectedTableType: 'view',
        selectedCells: [{ rowIdx: 1, colIdx: 0, rowId: 2, value: 'old' }],
        selectedRowIds: new Set([2]),
        selectedColumns: new Set(['old_column']),
        lastSelectedCell: { rowIdx: 1, colIdx: 0 },
        lastSelectedColumnIndex: 0,
        lastSelectedRowIndex: 1,
        schemaCache: { tables: [], views: [{ name: 'shared_view' }], indexes: [] }
    };
    let messageHandler: ((event: { data: unknown }) => void) | undefined;
    let persistCalls = 0;
    let refreshSchemaCalls = 0;
    let selectionWasClearedBeforeSchemaReload = false;
    const refreshOrder: string[] = [];
    (globalThis as any).__webViewerRefreshHarness = {
        state,
        refreshOrder,
        backendApi: {
            initialize: async () => ({ connected: true, readOnly: false }),
            ping: async () => true
        },
        persistState() {
            persistCalls++;
        },
        refreshSchema: async () => {
            refreshOrder.push('schema');
            refreshSchemaCalls++;
            if (refreshSchemaCalls === 1) initialSchemaRefresh.resolve();
            selectionWasClearedBeforeSchemaReload = state.selectedCells.length === 0
                && state.selectedRowIds.size === 0
                && state.selectedColumns.size === 0
                && state.lastSelectedCell === null
                && state.lastSelectedColumnIndex === null
                && state.lastSelectedRowIndex === null
                && persistCalls === 1;
        },
        sendRpcResult: (_correlationId: string, result: unknown) => response.resolve(result),
        sendRpcError: (_correlationId: string, error: unknown) => response.reject(error)
    };
    (globalThis as any).window = {
        parent: { postMessage() {} },
        location: { ancestorOrigins: [] },
        addEventListener(type: string, handler: (event: { data: unknown }) => void) {
            if (type === 'message') messageHandler = handler;
        }
    };
    (globalThis as any).document = {
        documentElement: { style: {} },
        getElementById: () => ({ textContent: '', style: {}, dataset: {} }),
        querySelectorAll: () => []
    };

    const entryPoint = path.resolve(__dirname, '../../core/ui/web-viewer.js');
    const bundle = await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        write: false,
        plugins: [{
            name: 'web-viewer-refresh-stubs',
            setup(build) {
                build.onResolve({ filter: /^\.\/modules\// }, args => ({
                    path: args.path,
                    namespace: 'web-viewer-refresh-stub'
                }));
                build.onLoad({ filter: /.*/, namespace: 'web-viewer-refresh-stub' }, args => {
                    const harness = 'globalThis.__webViewerRefreshHarness';
                    const modules: Record<string, string> = {
                        './modules/state.js': `
                            export const state = ${harness}.state;
                            export function persistState() { ${harness}.persistState(); }
                        `,
                        './modules/web-api.js': `
                            export const backendApi = ${harness}.backendApi;
                            export function isTrustedParentMessage() { return true; }
                            export function handleRpcResponse() {}
                            export function sendRpcResult(id, result) { ${harness}.sendRpcResult(id, result); }
                            export function sendRpcError(id, error) { ${harness}.sendRpcError(id, error); }
                        `,
                        './modules/sidebar.js': `
                            export function initSidebar() {}
                            export function refreshSchema() { return ${harness}.refreshSchema(); }
                        `,
                        './modules/export.js': 'export function initExport() {}',
                        './modules/crud.js': 'export function initCrud() {}',
                        './modules/ui.js': `
                            export function updateStatus() {}
                            export function showEmptyState() {}
                            export function showErrorState() {}
                            export function initSidebarResize() {}
                        `,
                        './modules/modals.js': 'export function initModals() {}',
                        './modules/grid.js': `
                            export async function loadTableColumns() {
                                ${harness}.refreshOrder.push('columns');
                            }
                            export async function loadTableData() {
                                ${harness}.refreshOrder.push('data');
                            }
                            export function initGridInteraction() {}
                            export function initGridControls() {}
                            export function clearSelection() {
                                const state = ${harness}.state;
                                state.selectedCells = [];
                                state.selectedRowIds.clear();
                                state.selectedColumns.clear();
                                state.lastSelectedCell = null;
                                state.lastSelectedColumnIndex = null;
                                state.lastSelectedRowIndex = null;
                            }
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
                        './modules/global-shortcuts.js': 'export function setupGlobalShortcuts() {}'
                    };
                    const contents = modules[args.path];
                    if (!contents) throw new Error(`Missing web-viewer test stub for ${args.path}`);
                    return { contents, loader: 'js' };
                });
            }
        }]
    });
    const compiled = bundle.outputFiles[0].text;
    const evaluatedModule = { exports: {} };
    new Function('module', 'exports', compiled)(evaluatedModule, evaluatedModule.exports);
    await initialSchemaRefresh.promise;
    assert.ok(messageHandler, 'web demo RPC listener should be installed');
    refreshOrder.length = 0;

    messageHandler!({
        data: {
            kind: 'invoke',
            correlationId: 'refresh-1',
            methodName: 'refreshContent',
            parameters: ['shared.db']
        }
    });
    await response.promise;

    assert.strictEqual(selectionWasClearedBeforeSchemaReload, true);
    assert.strictEqual(persistCalls, 1);
    assert.deepStrictEqual(refreshOrder, ['schema', 'columns', 'data']);
});
