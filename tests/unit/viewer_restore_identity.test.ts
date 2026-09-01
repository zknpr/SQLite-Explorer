import './vscode_mock_setup';

import assert from 'node:assert';
import path from 'node:path';
import { after, it } from 'node:test';
import esbuild from 'esbuild';
import { createDeferred } from './helpers/deferred';

const originalDocument = (globalThis as any).document;

after(() => {
    if (originalDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = originalDocument;
    delete (globalThis as any).__viewerRestoreIdentityHarness;
});

it('restores a saved table identity before loading its columns or data', async () => {
    const restored = createDeferred<void>();
    const primaryKeyIdentity = {
        kind: 'primaryKey',
        columns: [{ identifier: 'id', declaredType: 'INTEGER', position: 1 }]
    };
    const state: Record<string, any> = {
        isDbConnected: false,
        selectedTable: null,
        selectedTableType: 'table',
        selectedTableIdentity: null,
        schemaCache: { tables: [], views: [], indexes: [] },
        rowsPerPage: 5000,
        totalRecordCount: 0
    };
    let identityAtColumnLoad: unknown;
    (globalThis as any).__viewerRestoreIdentityHarness = {
        state,
        savedState: {
            selectedTable: 'restored_wr',
            selectedTableType: 'table',
            rowsPerPage: 5000
        },
        backendApi: {
            initialize: async () => ({ connected: true, readOnly: false }),
            ping: async () => true
        },
        refreshSchema: async () => {
            state.schemaCache.tables = [{ name: 'restored_wr', identity: primaryKeyIdentity }];
            // This mirrors the real initial refresh: no selection has been restored yet.
            state.selectedTableIdentity = state.selectedTableType === 'table'
                ? state.schemaCache.tables.find((table: any) => table.name === state.selectedTable)?.identity ?? null
                : null;
        },
        syncSelectedTableIdentity: () => {
            state.selectedTableIdentity = state.selectedTableType === 'table'
                ? state.schemaCache.tables.find((table: any) => table.name === state.selectedTable)?.identity ?? null
                : null;
        },
        loadTableColumns: async () => {
            identityAtColumnLoad = state.selectedTableIdentity;
            return true;
        },
        loadTableData: async () => {
            restored.resolve();
        }
    };

    const elements = new Map<string, any>();
    const element = (id: string) => {
        if (!elements.has(id)) {
            elements.set(id, {
                dataset: {},
                style: {},
                options: id === 'pageSizeSelect' ? [{ value: '5000' }] : [],
                value: '',
                hidden: false,
                textContent: '',
                scrollLeft: 0,
                scrollTop: 0,
                insertBefore() {}
            });
        }
        return elements.get(id);
    };
    (globalThis as any).document = {
        getElementById: element,
        createElement: () => ({ value: '', textContent: '' })
    };

    const entryPoint = path.resolve(__dirname, '../../core/ui/viewer.js');
    const bundle = await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        write: false,
        plugins: [{
            name: 'viewer-restore-identity-stubs',
            setup(build) {
                build.onResolve({ filter: /^\.\/modules\// }, args => ({
                    path: args.path,
                    namespace: 'viewer-restore-identity-stub'
                }));
                build.onLoad({ filter: /.*/, namespace: 'viewer-restore-identity-stub' }, args => {
                    const harness = 'globalThis.__viewerRestoreIdentityHarness';
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
                            export const backendApi = ${harness}.backendApi;
                            export function getVsCodeState() { return ${harness}.savedState; }
                        `,
                        './modules/sidebar.js': `
                            export function initSidebar() {}
                            export function renderSidebar() {}
                            export function refreshSchema() { return ${harness}.refreshSchema(); }
                            export function syncSelectedTableIdentity() {
                                return ${harness}.syncSelectedTableIdentity();
                            }
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
                            export function loadTableColumns() { return ${harness}.loadTableColumns(); }
                            export function loadTableData() { return ${harness}.loadTableData(); }
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
                        './modules/global-shortcuts.js': 'export function setupGlobalShortcuts() {}'
                    };
                    const contents = modules[args.path];
                    if (!contents) throw new Error(`Missing viewer restore test stub for ${args.path}`);
                    return { contents, loader: 'js' };
                });
            }
        }]
    });
    const evaluatedModule = { exports: {} };
    new Function('module', 'exports', bundle.outputFiles[0].text)(
        evaluatedModule,
        evaluatedModule.exports
    );
    await restored.promise;

    assert.deepStrictEqual(identityAtColumnLoad, primaryKeyIdentity);
});
