import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFixtures, readRows } from './fixtures.mjs';
import { launchInstalledVsix, command, viewerFrame, openDatabase, selectTable, waitForValue, createRecorder } from './driver.mjs';

const output = path.resolve(process.env.GUI_OUTPUT ?? `.tmp/gui-${process.platform}-${Date.now()}`);
const vsix = process.env.GUI_VSIX && path.resolve(process.env.GUI_VSIX);
const backend = process.env.GUI_BACKEND ?? 'native';
assert.ok(['native', 'wasm'].includes(backend), 'GUI_BACKEND must be native or wasm');
if (!vsix || !fs.existsSync(vsix)) throw new Error('Set GUI_VSIX to the exact packaged extension to verify.');
if (fs.existsSync(output)) throw new Error(`Use a new GUI_OUTPUT directory: ${output}`);
fs.mkdirSync(output, { recursive: true });
const workspace = path.join(output, 'workspace');
const fixtures = createFixtures(workspace);
const { app, page } = await launchInstalledVsix({
  vsix, output, workspace, executable: process.env.VSCODE_TEST_EXECUTABLE_PATH,
  version: process.env.GUI_VSCODE_VERSION ?? '1.110.0',
  settings: { 'sqliteExplorer.instantCommit': backend === 'wasm' ? 'always' : 'never' }
});
const recorder = createRecorder(page, output);
const { step } = recorder;
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
let frame;
const rows = (sql, file = fixtures.primary) => readRows(file, sql);
const disk = (sql, expected, file = fixtures.primary) => waitForValue(() => rows(sql, file), expected, sql);
const cell = (row, column) => frame.locator(`tr.data-row[data-rowid="${row}"] td[data-colidx="${column}"]`);
const inspectCell = async (row, column) => {
  await cell(row, column).click(); await cell(row, column).locator('.expand-icon').click();
};
const text = async () => (await page.locator('.monaco-editor:visible .view-lines').allTextContents()).join('\n').replaceAll('\u00a0', ' ');
const contains = (locator, expected) => waitForValue(async () => (await locator.textContent()).includes(expected), true, expected);
const screenshot = name => page.screenshot({ path: path.join(output, `${name}.png`) });
const primary = async () => { frame = await openDatabase(page, 'qa.db'); return frame; };
const views = async () => { if (!await frame.locator('#viewsList').isVisible()) await frame.locator('[data-section="views"]').click(); };
const viewAction = async (action, name) => {
  const button = frame.getByRole('button', { name: `${action} view ${name}`, exact: true });
  await frame.getByRole('button', { name: `Open view ${name}`, exact: true }).hover();
  await button.click();
};
const closeModal = id => frame.locator(`#${id} .modal-cancel, #${id} .modal-close`).first().click();
const pick = async label => {
  const choice = page.locator('.quick-input-widget .label-name').filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
  await choice.first().waitFor();
  await choice.first().click();
};
const fileDialog = async file => {
  const dialog = page.locator('.quick-input-widget').filter({ has: page.getByRole('button', { name: 'OK', exact: true }) });
  // The outgoing command palette shares the input selector with file dialogs.
  // The simple file dialog has an accept button and an initialized file path;
  // BLOB saves have no title, while export and import dialogs supply one.
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: 'OK', exact: true }).waitFor();
  const title = (await dialog.locator('.quick-input-title').textContent()).trim();
  if (title) assert.match(title, /^(Save As|Export displayed query rows|Export ".+" as .+|Choose import source \(.+\))$/);
  const input = dialog.locator('input');
  await waitForValue(async () => path.isAbsolute(await input.inputValue()), true, 'simple file dialog has an initialized path');
  await input.click();
  await waitForValue(() => input.evaluate(element => element === element.ownerDocument.activeElement), true, 'simple file dialog input is focused');
  await input.fill(file);
  await waitForValue(() => input.inputValue(), file, 'simple file dialog path');
  await input.press('Enter');
};
const editSql = async sql => {
  await page.locator('.monaco-editor.focused:visible .view-lines').click();
  await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql);
};
const newQuery = async sql => {
  await frame.locator('#btnOpenQuery').click();
  await waitForValue(async () => (await page.locator('.monaco-editor.focused:visible .view-lines').allTextContents()).join('').replaceAll('\u00a0', ' ').includes('SELECT 1 AS value;'), true, 'new SQL editor is ready');
  await editSql(sql);
};

try {
  await step('S01 installed viewer, backend log, and visible query entry', async () => {
    await primary(); await selectTable(frame, 'contacts');
    await waitForValue(() => {
      const logRoot = path.join(output, 'profile/logs');
      return fs.readdirSync(logRoot, { recursive: true }).filter(name => name.endsWith('SQLite Explorer.log'))
        .map(name => fs.readFileSync(path.join(logRoot, name), 'utf8')).join('\n')
        .includes(`Using ${backend === 'native' ? 'native' : 'WebAssembly'} SQLite backend`);
    }, true, 'installed backend identity');
    assert.equal(await frame.getByRole('button', { name: 'New SQL query' }).isVisible(), true);
    await contains(cell(1, 1), 'Ada');
    await contains(cell(2, 1), 'Caffè 東京');
    await screenshot('01-installed-viewer');
  });
  await step('V01 edit existing view, validate, preview, and save', async () => {
    await views(); await viewAction('Edit', 'active_contacts');
    const sql = 'SELECT id, upper(name) AS name, score FROM contacts WHERE active = 1';
    await frame.locator('#viewSelectSql').fill(sql);
    await frame.locator('#btnValidateView').click();
    await contains(frame.locator('#viewValidationStatus'), 'valid');
    await frame.locator('#btnPreviewView').click();
    await contains(frame.locator('#viewPreview'), 'ADA');
    await screenshot('02-view-preview');
    await frame.locator('#btnSaveView').click();
    await frame.locator('#viewModal').waitFor({ state: 'hidden' });
    await disk('SELECT name FROM active_contacts WHERE id=1', [{ name: 'ADA' }]);
  });
  await step('V02 invalid view SQL and cancel leave schema unchanged', async () => {
    await viewAction('Edit', 'active_contacts');
    await frame.locator('#viewSelectSql').fill('SELECT name FROM missing_table');
    await frame.locator('#btnValidateView').click();
    await waitForValue(async () => /error|no such table/i.test(await frame.locator('#viewValidationStatus').textContent()), true, 'invalid view is refused');
    await closeModal('viewModal');
    assert.deepEqual(rows('SELECT name FROM active_contacts WHERE id=1'), [{ name: 'ADA' }]);
  });
  await step('V03 create, browse, and drop a view', async () => {
    await frame.locator('#btnOpenCreateView').click();
    await frame.locator('#viewNameInput').fill('qa view');
    await frame.locator('#viewSelectSql').fill('SELECT name FROM markers');
    await frame.locator('#btnSaveView').click();
    await frame.locator('#viewModal').waitFor({ state: 'hidden' });
    await views(); await frame.getByRole('button', { name: 'Open view qa view', exact: true }).click();
    await contains(frame.locator('#gridContainer'), 'primary');
    assert.equal(await frame.locator('#btnAddRow').isDisabled(), true);
    await viewAction('Drop', 'qa view');
    await page.getByRole('button', { name: 'Drop View', exact: true }).click();
    await disk("SELECT name FROM sqlite_schema WHERE name='qa view'", []);
  });
  await step('S02 schema search, sections, and index inventory', async () => {
    const search = frame.locator('#sidebarFilterInput');
    await search.fill('contacts');
    assert.equal(await frame.getByRole('button', { name: 'Open table contacts', exact: true }).isVisible(), true);
    assert.equal(await frame.getByRole('button', { name: 'Open table pages', exact: true }).count(), 0);
    await search.fill('');
    if (!await frame.locator('#indexesList').isVisible()) await frame.locator('[data-section="indexes"]').click();
    await contains(frame.locator('#indexesList'), 'by_contact_name');
  });
  await step('G01 first, next, previous, last, and page-size boundaries', async () => {
    await selectTable(frame, 'pages');
    await contains(frame.locator('#pageIndicator'), '1 / 3');
    await frame.locator('#btnNext').click(); await contains(frame.locator('#pageIndicator'), '2 / 3');
    await contains(cell(101, 0), '101');
    await frame.locator('#btnLast').click(); await contains(frame.locator('#pageIndicator'), '3 / 3');
    assert.equal(await frame.locator('#btnNext').isDisabled(), true);
    await frame.locator('#btnPrev').click(); await contains(frame.locator('#pageIndicator'), '2 / 3');
    await frame.locator('#btnFirst').click(); await contains(frame.locator('#pageIndicator'), '1 / 3');
    await frame.locator('#pageSizeSelect').selectOption('250'); await contains(frame.locator('#pageIndicator'), '1 / 2');
    await frame.locator('#btnLast').click(); await contains(cell(251, 0), '251');
    await frame.locator('#pageSizeSelect').selectOption('100');
  });
  await step('G02 filter, empty results, clear, and column sort', async () => {
    await selectTable(frame, 'pages');
    await frame.locator('#filterInput').fill('even'); await frame.locator('#btnApplyFilter').click();
    await contains(frame.locator('#statusText'), '125');
    await frame.locator('#filterInput').fill('no-matching-value'); await frame.locator('#btnApplyFilter').click();
    await frame.locator('.no-results-row, .empty-view').first().waitFor();
    const panel = await frame.locator('.main-panel').boundingBox();
    for (const selector of ['#tableNameLabel', '#btnAddRow', '#btnApplyFilter', '#statusText', '#btnLast']) {
      const bounds = await frame.locator(selector).boundingBox();
      assert.ok(bounds.x >= panel.x - 1 && bounds.x + bounds.width <= panel.x + panel.width + 1,
        `${selector} must remain inside the visible editor when the search receives focus`);
    }
    await frame.locator('#btnClearFilter').click();
    await contains(frame.locator('#statusText'), '251');
    const sort = frame.locator('th[data-column="id"] .header-sort-button');
    await sort.click(); await sort.click();
    await waitForValue(() => frame.locator('tr.data-row').first().getAttribute('data-rowid'), '251', 'descending sort');
  });
  await step('C01 inline edit, Escape, Undo, and Redo', async () => {
    await selectTable(frame, 'contacts');
    await cell(1, 1).dblclick();
    const input = cell(1, 1).locator('textarea'); await input.fill('Ada edited'); await input.press('Enter');
    await disk('SELECT name FROM contacts WHERE id=1', [{ name: 'Ada edited' }]);
    await cell(1, 1).dblclick(); await cell(1, 1).locator('textarea').fill('cancelled');
    await page.keyboard.press('Escape');
    assert.deepEqual(rows('SELECT name FROM contacts WHERE id=1'), [{ name: 'Ada edited' }]);
    await command(page, 'Undo'); await disk('SELECT name FROM contacts WHERE id=1', [{ name: 'Ada' }]);
    await command(page, 'Redo'); await disk('SELECT name FROM contacts WHERE id=1', [{ name: 'Ada edited' }]);
  });
  await step('C02 text detail editor preserves multiline and explicit NULL', async () => {
    await inspectCell(1, 4);
    assert.equal(await frame.locator('#cellPreviewTextarea').inputValue(), 'first line\nsecond line');
    await frame.locator('#cellPreviewTextarea').fill('changed\n東京');
    await frame.locator('#cellPreviewSaveBtn').click();
    await disk('SELECT note FROM contacts WHERE id=1', [{ note: 'changed\n東京' }]);
    await inspectCell(1, 4); await frame.locator('#cellPreviewNullBtn').click();
    await frame.locator('#cellPreviewSaveBtn').click(); await disk('SELECT note FROM contacts WHERE id=1', [{ note: null }]);
  });
  await step('C03 BLOB inspector hex and download', async () => {
    await cell(1, 6).dblclick();
    await frame.locator('.tab-btn[data-tab="hex"]').click();
    await contains(frame.getByRole('region', { name: 'BLOB hexadecimal data', exact: true }), '00 01 02 ff');
    await screenshot('03-blob-hex');
    // Hex opens a read-only document; Preview retains the raw-file download.
    assert.equal(await frame.getByRole('button', { name: 'Open Full Hex', exact: true }).isVisible(), true);
    await frame.getByRole('button', { name: 'Preview', exact: true }).click();
    await frame.getByRole('button', { name: 'Download', exact: true }).click();
    const exported = path.join(workspace, 'downloaded.bin'); await fileDialog(exported);
    await waitForValue(() => fs.existsSync(exported), true, 'BLOB download destination');
    assert.deepEqual(fs.readFileSync(exported), Buffer.from([0, 1, 2, 255]));
    await closeModal('blob-inspector-modal');
  });
  await step('C04 add row defaults and required field validation', async () => {
    await frame.locator('#btnAddRow').click(); await frame.locator('#btnSubmitAddRow').click();
    await contains(frame.locator('#statusText'), 'Required fields missing');
    await frame.locator('#addRowForm input[data-column="name"]').fill('New contact');
    const note = frame.locator('#addRowForm .form-field').filter({ has: frame.locator('input[data-column="note"]') });
    await note.locator('.btn-add-row-empty').click(); await frame.locator('#btnSubmitAddRow').click();
    await frame.locator('#addRowModal').waitFor({ state: 'hidden' });
    await disk("SELECT name,note,active FROM contacts WHERE name='New contact'", [{ name: 'New contact', note: '', active: 1 }]);
  });
  await step('C05 selected-row delete cancel and commit', async () => {
    await frame.locator('tr.data-row[data-rowid="4"] .row-select-button').click();
    await frame.locator('#btnDeleteRows').click(); await closeModal('deleteModal');
    assert.equal(rows('SELECT count(*) AS n FROM contacts')[0].n, 4);
    await frame.locator('#btnDeleteRows').click(); await frame.locator('#btnSubmitDelete').click();
    await disk('SELECT count(*) AS n FROM contacts', [{ n: 3 }]);
  });
  await step('S03 create table and add column with defaults', async () => {
    await frame.locator('#btnOpenCreateTable').click(); await frame.locator('#newTableName').fill('created table');
    await frame.locator('#btnAddColumnDef').click(); await frame.locator('.col-name').nth(1).fill('value');
    await frame.locator('#btnSubmitCreateTable').click(); await frame.locator('#createTableModal').waitFor({ state: 'hidden' });
    await selectTable(frame, 'created table');
    await frame.locator('#btnAddColumn').click(); await frame.locator('#newColumnName').fill('extra');
    await frame.locator('#newColumnType').selectOption('INTEGER'); await frame.locator('#newColumnDefault').fill('7');
    await frame.locator('#btnSubmitAddColumn').click(); await frame.locator('#addColumnModal').waitFor({ state: 'hidden' });
    await disk("SELECT name,dflt_value FROM pragma_table_info('created table') WHERE name='extra'", [{ name: 'extra', dflt_value: '7' }]);
  });
  await step('C06 WITHOUT ROWID, generated columns, and quoted identifiers', async () => {
    await selectTable(frame, 'pairs'); await contains(frame.locator('#gridContainer'), 'pair value');
    await selectTable(frame, 'computed'); await frame.locator('#btnAddRow').click();
    assert.equal(await frame.locator('#addRowForm input[data-column="doubled"]').isDisabled(), true);
    await frame.locator('#btnSubmitAddRow').click(); await frame.locator('#addRowModal').waitFor({ state: 'hidden' });
    await disk('SELECT id,base,doubled FROM computed WHERE id=2', [{ id: 2, base: 7, doubled: 14 }]);
    await selectTable(frame, 'space " table'); await contains(frame.locator('#gridContainer'), 'quoted identifiers');
  });
  await step('Q01 two database tabs and visible query ownership', async () => {
    await openDatabase(page, 'second.db'); await primary();
    await newQuery('SELECT name AS bound_database FROM markers;'); await command(page, 'SQLite Explorer: Run Query');
    await waitForValue(async () => (await text()).includes('primary'), true, 'query is bound to the originating qa.db');
    await screenshot('04-query-results');
  });
  await step('Q02 query parameters and actual indexed Explain', async () => {
    await primary(); await newQuery('SELECT id FROM pages WHERE category = ? ORDER BY id LIMIT 2;');
    await command(page, 'SQLite Explorer: Run Query');
    const input = page.locator('.quick-input-widget input'); await input.fill('["even"]'); await input.press('Enter');
    await waitForValue(async () => (await text()).includes('2 rows'), true, 'parameter query results');
    await primary(); await newQuery("SELECT id FROM pages WHERE category = 'even' ORDER BY id;");
    await command(page, 'SQLite Explorer: Explain Query Plan');
    await waitForValue(async () => (await text()).includes('by_page_category'), true, 'real indexed plan');
    await screenshot('05-query-plan');
  });
  await step('Q03 export displayed query result rows', async () => {
    await command(page, 'SQLite Explorer: Export Query Results');
    const exported = path.join(workspace, 'query-plan.csv'); await fileDialog(exported);
    await waitForValue(() => fs.existsSync(exported), true, 'query result export');
    assert.match(fs.readFileSync(exported, 'utf8'), /by_page_category/);
  });
  await step('Q04 query history and explicit database switching', async () => {
    await command(page, 'SQLite Explorer: Query History (Session)');
    await page.locator('.quick-input-widget .label-name').filter({ hasText: 'SELECT name AS bound_database FROM markers;' }).click();
    await waitForValue(async () => (await page.locator('.monaco-editor.focused:visible .view-lines').allTextContents()).join('').includes('bound_database'), true, 'history SQL editor is ready');
    await command(page, 'SQLite Explorer: Choose Query Database'); await pick('second.db');
    await command(page, 'SQLite Explorer: Run Query');
    await waitForValue(async () => (await text()).includes('secondary'), true, 'explicit query rebinding');
    assert.ok(await page.locator('.editor-group-container').count() <= 2, 'repeated query results must reuse one pane');
  });
  await step('I01 CSV import wizard, preview, and commit', async () => {
    await command(page, 'SQLite Explorer: Import CSV or JSON'); await pick('qa.db'); await pick('import_target');
    await fileDialog(fixtures.csv); await pick('Use matching column names');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    if (backend === 'wasm') {
      // The independent SQLite reader must not contend with the atomic save
      // whose result it measures. Observe import completion and a clean editor
      // before opening another connection; a save failure still fails this gate.
      await command(page, 'Notifications: Show Notifications');
      await contains(page.locator('.notifications-center'), 'Imported 2 rows into import_target.');
      await waitForValue(() => page.locator('.tabs-container .tab[data-resource-name="qa.db"]')
        .evaluateAll(tabs => tabs.length > 0 && tabs.every(tab => !tab.classList.contains('dirty'))), true, 'import automatic-save checkpoint');
      await page.keyboard.press('Escape');
    }
    await disk('SELECT id,name,note,amount FROM import_target WHERE id>1 ORDER BY id', [
      { id: 2, name: 'Caffè 東京', note: 'line one\nline two', amount: 7 },
      { id: 3, name: 'Empty', note: '', amount: 7 }
    ]);
    assert.equal(rows('SELECT count(*) AS n FROM import_target', fixtures.secondary)[0].n, 1);
  });
  await step('I02 import conflict rolls back the complete batch', async () => {
    await command(page, 'SQLite Explorer: Import CSV or JSON'); await pick('qa.db'); await pick('import_target');
    await fileDialog(fixtures.conflict); await pick('Use matching column names');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    // The notification center also retains errors when this test window is in
    // the background and a transient toast is not displayed by VS Code.
    await command(page, 'Notifications: Show Notifications');
    await page.locator('.notifications-center').waitFor();
    console.log('IMPORT_NOTIFICATIONS', await page.locator('.notifications-center').innerText());
    await waitForValue(async () => /constraint/i.test(await page.locator('.notifications-center').textContent()), true, 'constraint failure is reported');
    assert.deepEqual(rows('SELECT id FROM import_target ORDER BY id'), [{ id: 1 }, { id: 2 }, { id: 3 }]);
    await page.keyboard.press('Escape');
  });
  await step('I03 one database Undo and Redo cover the complete CSV import', async () => {
    await primary(); await selectTable(frame, 'import_target');
    await command(page, 'Undo'); await disk('SELECT id FROM import_target ORDER BY id', [{ id: 1 }]);
    await command(page, 'Redo'); await disk('SELECT id FROM import_target ORDER BY id', [{ id: 1 }, { id: 2 }, { id: 3 }]);
  });
  await step('I04 manual JSON mapping, skip, NULL, and destination defaults', async () => {
    await command(page, 'SQLite Explorer: Import CSV or JSON'); await pick('qa.db'); await pick('import_target');
    await fileDialog(fixtures.json); await pick('Map columns manually');
    await pick('id'); await pick('name'); await pick('note'); await pick('Skip source column');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await disk('SELECT id,name,note,amount FROM import_target WHERE id=4', [{ id: 4, name: 'JSON row', note: null, amount: 7 }]);
  });
  await step('I05 cancel import confirmation leaves database untouched', async () => {
    await command(page, 'SQLite Explorer: Import CSV or JSON'); await pick('qa.db'); await pick('import_target');
    await fileDialog(fixtures.csv); await pick('Use matching column names');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual(rows('SELECT id FROM import_target ORDER BY id'), [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  });
  await step('X01 table export uses actual format and destination', async () => {
    await primary(); await selectTable(frame, 'contacts'); await frame.locator('#btnExport').click();
    await frame.locator('#exportFormat').selectOption('json'); await frame.locator('#btnSubmitExport').click();
    const exported = path.join(workspace, 'contacts.json'); await fileDialog(exported);
    await waitForValue(() => fs.existsSync(exported), true, 'table export destination');
    const result = JSON.parse(fs.readFileSync(exported, 'utf8')); assert.equal(result.length, 3); assert.equal(result[0].name, 'Ada edited');
  });
  await step('T01 all seven pragma controls and effective readback', async () => {
    const priorWindowBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 800));
    await frame.locator('#btnOpenSettings').click();
    await frame.locator('#setting_cache_size').waitFor();
    const viewport = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const dialog = await frame.locator('#settingsModal .modal-dialog').evaluate(element => {
      const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    assert.ok(dialog.left >= 0 && dialog.right <= viewport.width && dialog.top >= 0 && dialog.bottom <= viewport.height,
      'the Configuration dialog must remain inside a narrow split editor');
    assert.equal(await frame.locator('#setting_autoCommit').isChecked(), true);
    assert.equal(await frame.locator('#setting_autoCommit').isDisabled(), backend === 'native');
    if (backend === 'native') await contains(frame.locator('#pragmaSettingsContainer'), 'Native SQLite writes changes to the database immediately');
    for (const [name, value, effective = value] of [['journal_mode', 'WAL'], ['journal_mode', 'DELETE'], ['foreign_keys', 'false'], ['foreign_keys', 'true'], ['synchronous', '1'], ['locking_mode', 'EXCLUSIVE'], ['locking_mode', 'NORMAL'], ['temp_store', '2'], ['auto_vacuum', '1', '0']]) {
      const control = frame.locator(`#setting_${name}`);
      const previous = await control.inputValue();
      const previousControl = await control.elementHandle();
      assert.ok(previousControl);
      await control.selectOption(value);
      // WASM automatic persistence can replace the footer message with a grid
      // refresh. Wait for server-read controls, not that transient message or
      // the optimistic value selected in the outgoing control.
      if (previous !== value) await waitForValue(() => previousControl.evaluate(element => element.isConnected), false, `${name} controls were refreshed`);
      await previousControl.dispose();
      await waitForValue(() => frame.locator(`#setting_${name}`).inputValue(), effective, name);
      if (name === 'journal_mode') await disk('PRAGMA journal_mode', [{ journal_mode: effective.toLowerCase() }]);
    }
    await frame.locator('#setting_cache_size').fill('-4096'); await frame.locator('#setting_cache_size').press('Tab');
    await contains(frame.locator('#statusText'), 'Updated cache_size');
    assert.equal(await frame.locator('#setting_cache_size').inputValue(), '-4096');
    await screenshot('06-settings'); await closeModal('settingsModal');
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), priorWindowBounds);
  });
  await step(backend === 'native' ? 'L01 external replacement refuses stale view work and Reload recovers' : 'L01 Reload replaces the WASM snapshot after external replacement', async () => {
    await views(); await viewAction('Edit', 'active_contacts');
    const replacement = path.join(workspace, 'replacement.db'); fs.copyFileSync(fixtures.secondary, replacement);
    try { fs.renameSync(replacement, fixtures.primary); }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await closeModal('viewModal');
      assert.equal(rows('SELECT name FROM markers')[0].name, 'primary');
      console.log('Windows refused replacement of the open file; unchanged connection verified.');
      return;
    }
    if (backend === 'native') {
      await frame.locator('#btnValidateView').click();
      await waitForValue(async () => (await frame.locator('body').innerText()).includes('Reload Database'), true, 'actionable external replacement message');
    }
    assert.equal(rows('SELECT name FROM markers')[0].name, 'secondary');
    await screenshot('07-replaced-file');
    if (await frame.locator('#viewModal').isVisible()) await closeModal('viewModal');
    await frame.locator('#btnReload').click();
    await selectTable(frame, 'markers'); await contains(frame.locator('#gridContainer'), 'secondary');
    await views(); await viewAction('Edit', 'active_contacts');
    await frame.locator('#viewSelectSql').fill('SELECT id,name FROM contacts WHERE active=0');
    await frame.locator('#btnSaveView').click(); await frame.locator('#viewModal').waitFor({ state: 'hidden' });
    await disk('SELECT name FROM active_contacts', [{ name: 'Caffè 東京' }]);
  });
  await screenshot('08-finished');
} finally {
  await app.close();
  const logs = path.join(output, 'profile/logs');
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({
    passed: recorder.results.filter(result => result.status === 'passed').length,
    failed: recorder.results.filter(result => result.status === 'failed').length,
    logs, fixtures, backend
  }, null, 2));
}
