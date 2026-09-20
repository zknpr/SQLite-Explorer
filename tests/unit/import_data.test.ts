/**
 * The desktop CSV/JSON import module (core/ui/modules/import-data.js).
 *
 * 1. Static gates, the same approach console_desktop_wiring.test.ts takes:
 *    bundle isolation (only desktop-viewer.js may import the module, and the
 *    built VS Code / web-demo bundles carry none of it), the shared template's
 *    toolbar button ships hidden, and the desktop entry actually wires the
 *    menu id and the init.
 * 2. The pure helpers the modal renders from — auto-mapping, mapping
 *    validation, the omitted-column split, preview truncation, and the
 *    user-facing wording of the two transport refusals.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { installFakeDom } from './helpers/fake-dom';
import { createDeferred } from './helpers/deferred';

const uiDir = path.resolve(process.cwd(), 'core/ui');
const modulesDir = path.join(uiDir, 'modules');
const readUi = (relative: string) => readFileSync(path.join(uiDir, relative), 'utf8');

// Untyped UI module, resolved through a path variable inside a hook so tsc
// does not demand a declaration file (the convention the other webview-module
// tests use). The module pulls in DOM-touching siblings, so a document exists first.
const importDocument = installFakeDom();
const originalCreateElement = importDocument.createElement.bind(importDocument);
importDocument.createElement = (name: string) => {
    const node = originalCreateElement(name);
    const classes = node.classList;
    Object.defineProperty(node, 'classList', { get: () => ({
        ...classes,
        toggle(cls: string, force?: boolean) {
            const enabled = force ?? !classes.contains(cls);
            if (enabled) classes.add(cls); else classes.remove(cls);
            return enabled;
        }
    }) });
    (node as any).append = (...children: any[]) => children.forEach(child => node.appendChild(child));
    return node;
};
const importDataModulePath = '../../core/ui/modules/import-data.js';
let importData: any;
before(async () => {
    importData = await import(importDataModulePath);
});

/** Every .js under core/ui that is neither the module itself nor the desktop entry. */
function nonDesktopSources(): string[] {
    const entries = readdirSync(uiDir)
        .filter(name => name.endsWith('.js') && name !== 'desktop-viewer.js')
        .map(name => path.join(uiDir, name));
    const modules = readdirSync(modulesDir)
        .filter(name => name.endsWith('.js') && name !== 'import-data.js')
        .map(name => path.join(modulesDir, name));
    return [...entries, ...modules];
}

const IMPORT_MODULE_IMPORT = /(?:from|import)\s*\(?\s*['"][^'"]*import-data\.js['"]/;

test('only desktop-viewer.js imports the import module (keeps it out of the VS Code/web bundles)', () => {
    const importers = nonDesktopSources().filter(file => IMPORT_MODULE_IMPORT.test(readFileSync(file, 'utf8')));
    assert.deepEqual(importers.map(file => path.relative(process.cwd(), file)), []);
    const desktopEntry = readUi('desktop-viewer.js');
    assert.match(desktopEntry, /from\s+'\.\/modules\/import-data\.js'/);
    // …and wires both entry points: the File menu id and the init that unhides the button.
    assert.match(desktopEntry, /id === 'import-data'/);
    assert.match(desktopEntry, /initImportData\(\{ surface \}\)/);
});

test('the built VS Code and web bundles contain no import modal; the desktop bundle does', () => {
    const occurrences = (file: string) =>
        (readFileSync(path.resolve(process.cwd(), file), 'utf8').match(/importDataModal/g) ?? []).length;
    assert.equal(occurrences('core/ui/viewer.html'), 0, 'the import module leaked into the VS Code webview bundle');
    assert.equal(occurrences('website/public/sqlite-viewer/viewer.html'), 0, 'the import module leaked into the web demo bundle');
    // Positive control for the marker.
    assert.ok(occurrences('desktop/viewer.html') > 0, 'desktop bundle has no importDataModal — the marker is stale');
});

test('the shared template carries the import button, inert by default, with a [hidden] companion', () => {
    const template = readUi('viewer.template.html');
    const button = template.match(/<button\b(?=[^>]*\bid=["']btnImportData["'])[^>]*>/i)?.[0];
    assert.ok(button, 'import toolbar button must exist in the shared template');
    assert.match(button!, /\bhidden\b/, 'the button must ship hidden (the desktop unhides it)');
    assert.match(button!, /\bdata-preserve-grid-selection\b/);
    // The toolbar button rule sets `display`, which outranks the UA's
    // [hidden] rule; the companion is what keeps a hidden button off screen.
    const css = readUi('viewer.css');
    const rule = css.match(/\.toolbar-button\s*\{([^}]*)\}/)?.[1] ?? '';
    if (/display\s*:/.test(rule)) {
        assert.match(css, /\.toolbar-button\[hidden\]\s*\{[^}]*display\s*:\s*none/);
    }
});

test('importFormatOf: .json is JSON, everything else is CSV', () => {
    assert.equal(importData.importFormatOf('rows.json'), 'json');
    assert.equal(importData.importFormatOf('ROWS.JSON'), 'json');
    assert.equal(importData.importFormatOf('rows.csv'), 'csv');
    assert.equal(importData.importFormatOf('rows.txt'), 'csv');
    assert.equal(importData.importFormatOf(undefined), 'csv');
});

test('autoMapColumns: exact names first, then a unique case-insensitive match, each target claimed once', () => {
    assert.deepEqual(
        importData.autoMapColumns(['id', 'Name', 'note', 'extra'], ['id', 'name', 'note']),
        ['id', 'name', 'note', undefined]
    );
    // Two source columns spelling one target differently: the exact one wins,
    // the other stays unmapped rather than double-claiming.
    assert.deepEqual(importData.autoMapColumns(['NAME', 'name'], ['name']), [undefined, 'name']);
    // Ambiguous case-insensitive targets (`Id` and `ID` both match `id`) stay unmapped.
    assert.deepEqual(importData.autoMapColumns(['id'], ['Id', 'ID']), [undefined]);
    assert.deepEqual(importData.autoMapColumns(['a', 'b'], []), [undefined, undefined]);
});

test('describeMappingProblem mirrors mapImportRows\' refusals without throwing', () => {
    assert.equal(importData.describeMappingProblem([undefined, undefined]), 'Map at least one source column.');
    assert.equal(importData.describeMappingProblem(['id', 'id']), 'Target column "id" is mapped more than once.');
    assert.equal(importData.describeMappingProblem(['id', undefined, 'name']), null);
});

test('describeOmittedColumns separates defaults-apply from will-refuse, and never blames the rowid alias', () => {
    const columns = [
        { identifier: 'id', isRequired: 1, defaultExpression: null, primaryKeyPosition: 1, isRowidAlias: true },
        { identifier: 'name', isRequired: 1, defaultExpression: null, primaryKeyPosition: 0 },
        { identifier: 'note', isRequired: 0, defaultExpression: null, primaryKeyPosition: 0 },
        { identifier: 'kind', isRequired: 1, defaultExpression: "'x'", primaryKeyPosition: 0 }
    ];
    assert.deepEqual(importData.describeOmittedColumns(columns, [undefined]), {
        omitted: ['id', 'name', 'note', 'kind'],
        blocking: ['name']
    });
    assert.deepEqual(importData.describeOmittedColumns(columns, ['name', 'note']), {
        omitted: ['id', 'kind'],
        blocking: []
    });
});

test('previewRows shortens long text for display only and names NULL and DEFAULT cells', () => {
    const long = 'x'.repeat(300);
    const rows = [{ id: 1, name: long, note: null }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];
    const preview = importData.previewRows(rows, ['id', 'name', 'note']);
    assert.equal(preview.length, 5, 'five rows, never more');
    assert.deepEqual(preview[0][0], { text: '1', kind: 'text' });
    assert.equal(preview[0][1].text, `${'x'.repeat(256)}… [preview shortened]`);
    assert.deepEqual(preview[0][2], { text: 'NULL', kind: 'null' });
    assert.deepEqual(preview[1][1], { text: 'DEFAULT', kind: 'default' });
    assert.deepEqual(importData.previewRows(rows, ['id'], { limit: 2 }).map((row: any[]) => row[0].text), ['1', '2']);
});

test('describeImportFailure turns the two transport refusals into a sentence and passes everything else through', () => {
    assert.match(
        importData.describeImportFailure(new Error('ERR_NATIVE_FRAME_TOO_LARGE: envelope is 20000000 bytes')),
        /16 MiB the native engine accepts in one edit.*No rows were imported/
    );
    assert.match(
        importData.describeImportFailure(new Error('ERR_WEBVIEW_PAYLOAD_LIMIT: aggregate-payload')),
        /exceeds what the engine accepts in one edit/
    );
    assert.equal(importData.describeImportFailure(new Error('UNIQUE constraint failed: t.id')), 'UNIQUE constraint failed: t.id');
    assert.equal(importData.describeImportFailure(null), 'null');
});

const importColumns = [
    { identifier: 'id', declaredType: 'INTEGER', isRequired: 0, isRowidAlias: true },
    { identifier: 'label', declaredType: 'TEXT', isRequired: 0 },
    { identifier: 'created', declaredType: 'TEXT', isRequired: 1, defaultExpression: "'fresh'" }
];
const settleImport = () => new Promise<void>(resolve => setImmediate(resolve));
const importElement = (id: string): any => {
    const element = importDocument.getElementById(id);
    assert.ok(element, `missing import control ${id}`);
    return element;
};
const displayedText = (element: any): string => [element.textContent, ...element.children.map(displayedText)].join(' ');
function changeImportTable(name: string) {
    const select = importElement('importTargetTable');
    select.value = name;
    for (const listener of select.listeners.get('change') ?? []) listener({ target: select });
}

async function withImportUi(run: (harness: { api: any; state: any; imports: unknown[][]; surfaced: unknown[] }) => Promise<void>) {
    const apiPath = '../../core/ui/modules/api.js';
    const statePath = '../../core/ui/modules/state.js';
    const modalsPath = '../../core/ui/modules/modals.js';
    const { backendApi: api } = await import(apiPath);
    const { state } = await import(statePath);
    const { closeAllModals } = await import(modalsPath);
    const originalApi = { ...api };
    const originalState = { ...state };
    const imports: unknown[][] = [];
    const surfaced: unknown[] = [];
    if (!importDocument.getElementById('statusText')) {
        const status = importDocument.createElement('span');
        status.id = 'statusText';
        importDocument.body.appendChild(status);
    }
    Object.assign(state, {
        isDbConnected: true, isReadOnly: false, isRefreshingContent: false,
        dbId: 'import-db', connectionGeneration: 1, selectedTable: null,
        schemaCache: { tables: [{ name: 'first' }, { name: 'second' }], views: [], indexes: [] }
    });
    Object.assign(api, {
        pickImportSource: async () => ({ name: 'rows.json', path: '/picked/rows.json', size: 32 }),
        readImportSource: async () => '[{"label":"one"},{"label":null}]',
        getTableInfo: async () => importColumns,
        getImportTarget: async () => ({ columns: importColumns, schemaVersion: '1:0' }),
        importRows: async (...args: unknown[]) => { imports.push(args); return { rowCount: 2 }; }
    });
    importData.initImportData({ surface: () => (error: unknown) => surfaced.push(error) });
    try {
        await run({ api, state, imports, surfaced });
    } finally {
        closeAllModals();
        Object.assign(state, originalState);
        for (const name of Object.keys(api)) if (!Object.hasOwn(originalApi, name)) delete api[name];
        Object.assign(api, originalApi);
    }
}

test('the mapped preview shows omitted defaults and submits the schema version reviewed by the user', async () => {
    await withImportUi(async ({ imports }) => {
        assert.equal(await importData.openImportDialog(), true);
        const preview = displayedText(importElement('importPreview'));
        assert.match(preview, /created/);
        assert.match(preview, /DEFAULT 'fresh'/);
        assert.match(preview, /NULL/);
        importDocument.dispatchClick(importElement('btnSubmitImport'));
        await settleImport();
        assert.deepEqual(imports, [[
            'first', [{ label: 'one' }, { label: null }], { expectedSchemaVersion: '1:0' }
        ]]);
    });
});

test('target metadata races cannot submit the previous preview or overwrite the newest schema snapshot', async () => {
    await withImportUi(async ({ api, imports }) => {
        await importData.openImportDialog();
        const older = createDeferred<unknown>();
        const newer = createDeferred<unknown>();
        api.getImportTarget = (name: string) => name === 'second' ? older.promise : newer.promise;
        changeImportTable('second');
        assert.equal(importElement('btnSubmitImport').disabled, true);
        importDocument.dispatchClick(importElement('btnSubmitImport'));
        await settleImport();
        assert.deepEqual(imports, []);
        changeImportTable('first');
        newer.resolve({ columns: importColumns, schemaVersion: '3:0' });
        await settleImport();
        older.resolve({ columns: [{ identifier: 'wrong' }], schemaVersion: '2:0' });
        await settleImport();
        assert.equal(importElement('btnSubmitImport').disabled, false);
        importDocument.dispatchClick(importElement('btnSubmitImport'));
        await settleImport();
        assert.deepEqual(imports[0], [
            'first', [{ label: 'one' }, { label: null }], { expectedSchemaVersion: '3:0' }
        ]);
    });
});

test('a failed target metadata load leaves the old preview uncommittable', async () => {
    await withImportUi(async ({ api, imports, surfaced }) => {
        await importData.openImportDialog();
        api.getImportTarget = async () => { throw new Error('destination metadata unavailable'); };
        changeImportTable('second');
        await settleImport();
        importDocument.dispatchClick(importElement('btnSubmitImport'));
        await settleImport();
        assert.deepEqual(imports, []);
        assert.equal(importElement('btnSubmitImport').disabled, true);
        assert.match(displayedText(importElement('importNotice')), /destination metadata unavailable/);
        assert.equal(surfaced.length, 1);
    });
});

test('a superseded metadata failure cannot overwrite the current preview', async () => {
    await withImportUi(async ({ api, surfaced }) => {
        await importData.openImportDialog();
        const older = createDeferred<unknown>();
        api.getImportTarget = (name: string) => name === 'second' ? older.promise
            : Promise.resolve({ columns: importColumns, schemaVersion: 'latest-snapshot' });
        changeImportTable('second');
        changeImportTable('first');
        await settleImport();
        older.reject(new Error('stale failure'));
        await settleImport();
        assert.deepEqual(surfaced, []);
        assert.equal(importElement('btnSubmitImport').disabled, false);
        assert.doesNotMatch(displayedText(importElement('importNotice')), /stale failure/);
    });
});

test('a schema mismatch refuses repeat submission until a new target preview is loaded', async () => {
    await withImportUi(async ({ api }) => {
        await importData.openImportDialog();
        let attempts = 0;
        api.importRows = async () => {
            attempts++;
            throw new Error('The destination database schema changed after the preview was prepared. Start the import again.');
        };
        importDocument.dispatchClick(importElement('btnSubmitImport'));
        await settleImport();
        assert.equal(importElement('btnSubmitImport').disabled, true);
        assert.match(displayedText(importElement('importNotice')), /schema changed/);
        importDocument.dispatchClick(importElement('btnSubmitImport'));
        await settleImport();
        assert.equal(attempts, 1);
        changeImportTable('second');
        await settleImport();
        assert.equal(importElement('btnSubmitImport').disabled, false);
    });
});

test('default preview distinguishes omitted values from NULL and empty text and bounds SQL expressions', () => {
    const metadata = [{ identifier: 'value', defaultExpression: 'x'.repeat(300) }];
    const rows = importData.previewRows([{}, { value: null }, { value: '' }], ['value'], { columnMetadata: metadata });
    assert.deepEqual(rows[0][0], { text: `DEFAULT ${'x'.repeat(256)}… [default preview shortened]`, kind: 'default' });
    assert.deepEqual(rows[1][0], { text: 'NULL', kind: 'null' });
    assert.deepEqual(rows[2][0], { text: '', kind: 'text' });
});

for (const stage of ['picker', 'read', 'metadata']) {
    test(`a database switch during import ${stage} cannot retarget the pending source`, async () => {
        await withImportUi(async ({ api, state, imports }) => {
            const paused = createDeferred<unknown>();
            const started = createDeferred<void>();
            const method = stage === 'picker' ? 'pickImportSource' : stage === 'read' ? 'readImportSource' : 'getImportTarget';
            const prior = api[method];
            api[method] = () => { started.resolve(); return paused.promise; };
            const opening = importData.openImportDialog();
            await started.promise;
            state.dbId = 'different-database';
            paused.resolve(await prior());
            assert.equal(await opening, false);
            assert.deepEqual(imports, []);
            assert.equal(importElement('importDataModal').classList.contains('hidden'), true);
        });
    });
}
