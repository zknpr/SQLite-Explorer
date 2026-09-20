import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createFixtures, readRows } from './fixtures.mjs';
import { launchInstalledVsix, command, openDatabase, selectTable, waitForValue, createRecorder } from './driver.mjs';

const output = path.resolve(process.env.GUI_OUTPUT ?? `.tmp/gui-grid-${Date.now()}`);
const vsix = process.env.GUI_VSIX && path.resolve(process.env.GUI_VSIX);
const backend = process.env.GUI_BACKEND ?? 'native';
assert.ok(vsix && fs.existsSync(vsix), 'GUI_VSIX must name the installed artifact');
assert.ok(['native', 'wasm'].includes(backend));
assert.equal(fs.existsSync(output), false, 'use a fresh GUI_OUTPUT');
const workspace = path.join(output, 'workspace');
const fixtures = createFixtures(workspace);
const seed = new DatabaseSync(fixtures.primary);
try {
  seed.exec(`CREATE TABLE grid_cases(id INTEGER PRIMARY KEY, category TEXT NOT NULL,
    note TEXT, json TEXT, created_at INTEGER);
    INSERT INTO grid_cases VALUES
      (-2,'alpha','first','{"keep":1,"remove":true}',1704067200),
      (0,'beta','second','{"keep":2,"remove":true}',1704153600),
      (9,'gamma',NULL,'{"keep":3}',1704240000);`);
} finally { seed.close(); }
const { app, page } = await launchInstalledVsix({ vsix, output, workspace,
  executable: process.env.VSCODE_TEST_EXECUTABLE_PATH,
  version: process.env.GUI_VSCODE_VERSION ?? '1.110.0',
  settings: { 'sqliteExplorer.instantCommit': backend === 'wasm' ? 'always' : 'never' }
});
const recorder = createRecorder(page, output);
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
let frame;
const cell = (row, column) => frame.locator(`tr.data-row[data-rowid="${row}"] td[data-colidx="${column}"]`);
const contains = (locator, value) => waitForValue(async () => (await locator.textContent()).includes(value), true, value);
const disk = (sql, value) => waitForValue(() => readRows(fixtures.primary, sql), value, sql);
const primary = async table => { frame = await openDatabase(page, 'qa.db'); await selectTable(frame, table); };
const selection = count => waitForValue(() => frame.locator('.cell-selected').count(), count, 'selected cell count');
const undo = async () => { await frame.locator('#tableNameLabel').click(); await page.keyboard.press(`${modifier}+z`); };
const inspect = async (row, column) => { await cell(row, column).click(); await cell(row, column).locator('.expand-icon').click(); };
const fileDialog = async file => {
  const dialog = page.locator('.quick-input-widget').filter({ has: page.getByRole('button', { name: 'OK', exact: true }) });
  await dialog.waitFor();
  const input = dialog.locator('input');
  await waitForValue(async () => path.isAbsolute(await input.inputValue()), true, 'initialized file dialog');
  await input.click(); await input.fill(file); await input.press('Enter');
};
const visibleText = async () => (await page.locator('.monaco-editor:visible .view-lines').allTextContents()).join('\n').replaceAll('\u00a0', ' ');
const newQuery = async sql => {
  await primary('markers'); await frame.locator('#btnOpenQuery').click();
  const editor = page.locator('.monaco-editor.focused:visible .view-lines');
  await contains(editor, 'SELECT'); await editor.click();
  await page.keyboard.press(`${modifier}+a`); await page.keyboard.insertText(sql);
};

try {
  await recorder.step('B01 range and multi-selection, batch value, NULL, empty, and Undo', async () => {
    await primary('grid_cases');
    await cell(-2, 2).click(); await cell(0, 2).click({ modifiers: [modifier] }); await selection(2);
    await frame.locator('#batchInput_2').fill('batch value'); await frame.locator('#btnApplyBatchUpdate').click();
    await disk('SELECT note FROM grid_cases WHERE id<=0 ORDER BY id', [{ note: 'batch value' }, { note: 'batch value' }]);
    await undo(); await disk('SELECT note FROM grid_cases WHERE id<=0 ORDER BY id', [{ note: 'first' }, { note: 'second' }]);
    await cell(-2, 2).click(); await cell(9, 2).click({ modifiers: ['Shift'] }); await selection(3);
    await frame.getByRole('button', { name: 'Set note to NULL', exact: true }).click();
    await frame.locator('#btnApplyBatchUpdate').click();
    await disk('SELECT count(*) AS n FROM grid_cases WHERE note IS NULL', [{ n: 3 }]);
    await undo(); await disk('SELECT note FROM grid_cases WHERE id=-2', [{ note: 'first' }]);
    await frame.getByRole('button', { name: 'Select column note', exact: true }).click(); await selection(3);
    await frame.getByRole('button', { name: 'Set note to empty string', exact: true }).click();
    await frame.locator('#btnApplyBatchUpdate').click();
    await disk("SELECT count(*) AS n FROM grid_cases WHERE typeof(note)='text' AND length(note)=0", [{ n: 3 }]);
    await undo(); await disk('SELECT note FROM grid_cases WHERE id=9', [{ note: null }]);
  });
  await recorder.step('B02 batch JSON merge, invalid JSON refusal, and one Undo', async () => {
    await frame.getByRole('button', { name: 'Select column json', exact: true }).click();
    await frame.getByRole('button', { name: 'Apply JSON patch to json', exact: true }).click();
    await frame.locator('#batchInput_3').fill('{invalid'); await frame.locator('#btnApplyBatchUpdate').click();
    await contains(frame.locator('#statusText'), 'Invalid JSON');
    await frame.locator('#batchInput_3').fill('{"added":"東京","remove":null}');
    await frame.locator('#btnApplyBatchUpdate').click();
    await disk("SELECT json_extract(json,'$.keep') AS k,json_extract(json,'$.added') AS a,json_type(json,'$.remove') AS r FROM grid_cases ORDER BY id",
      [1, 2, 3].map(k => ({ k, a: '東京', r: null })));
    await undo(); await disk("SELECT json_extract(json,'$.added') AS a FROM grid_cases ORDER BY id", [{ a: null }, { a: null }, { a: null }]);
  });
  await recorder.step('B03 row zero, Select All, Escape, and Smart Delete Undo', async () => {
    await cell(0, 0).click(); await page.keyboard.press('Escape');
    await frame.locator('tr[data-rowid="0"] .row-select-button').click();
    await page.keyboard.press(`${modifier}+Backspace`);
    await disk('SELECT id FROM grid_cases ORDER BY id', [{ id: -2 }, { id: 9 }]);
    await undo(); await disk('SELECT id FROM grid_cases ORDER BY id', [{ id: -2 }, { id: 0 }, { id: 9 }]);
    await cell(0, 1).click(); await page.keyboard.press(`${modifier}+a`);
    await waitForValue(() => frame.locator('tr.data-row.selected').count(), 3, 'current-page row selection');
    await page.keyboard.press('Escape');
    await waitForValue(() => frame.locator('tr.data-row.selected').count(), 0, 'cleared selection');
    await cell(0, 2).click(); await page.keyboard.press(`${modifier}+Backspace`);
    await disk('SELECT note FROM grid_cases WHERE id=0', [{ note: null }]);
    await undo(); await disk('SELECT note FROM grid_cases WHERE id=0', [{ note: 'second' }]);
  });
  await recorder.step('K01 inline Tab, Shift-Tab, blur, and grid keyboard focus', async () => {
    await cell(0, 1).dblclick(); await cell(0, 1).locator('textarea').fill('tab edit');
    await page.keyboard.press('Tab');
    await disk('SELECT category FROM grid_cases WHERE id=0', [{ category: 'tab edit' }]);
    await cell(0, 2).locator('textarea').waitFor(); await cell(0, 2).locator('textarea').fill('backward tab');
    await page.keyboard.press('Shift+Tab'); await cell(0, 1).locator('textarea').waitFor();
    await page.keyboard.press('Escape');
    await disk('SELECT note FROM grid_cases WHERE id=0', [{ note: 'backward tab' }]);
    await cell(0, 2).dblclick(); await cell(0, 2).locator('textarea').fill('blur edit');
    await frame.locator('#tableNameLabel').click(); await disk('SELECT note FROM grid_cases WHERE id=0', [{ note: 'blur edit' }]);
    await cell(-2, 1).click(); await page.keyboard.press('ArrowRight');
    await waitForValue(() => frame.locator(':focus').getAttribute('data-colidx'), '2', 'arrow focus moves one column');
  });
  await recorder.step('K02 pin columns/rows and resize by keyboard and mouse', async () => {
    await frame.getByRole('button', { name: 'Pin column category', exact: true }).click();
    assert.equal(await frame.getByRole('button', { name: 'Unpin column category', exact: true }).getAttribute('aria-pressed'), 'true');
    await frame.getByRole('button', { name: 'Unpin column category', exact: true }).click();
    await frame.locator('tr[data-rowid="0"] .pin-icon').click();
    assert.equal(await frame.locator('tr[data-rowid="0"]').evaluate(el => el.classList.contains('pinned')), true);
    await frame.locator('tr[data-rowid="0"] .pin-icon').click();
    const handle = frame.getByRole('separator', { name: 'Resize column category', exact: true });
    await handle.focus(); const before = Number(await handle.getAttribute('aria-valuenow'));
    await handle.press('ArrowRight');
    await waitForValue(async () => Number(await handle.getAttribute('aria-valuenow')) > before, true, 'keyboard column resize');
    const bounds = await handle.boundingBox(); const prior = Number(await handle.getAttribute('aria-valuenow'));
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down(); await page.mouse.move(bounds.x + 45, bounds.y + bounds.height / 2, { steps: 5 }); await page.mouse.up();
    await waitForValue(async () => Number(await handle.getAttribute('aria-valuenow')) > prior + 20, true, 'pointer column resize');
  });
  await recorder.step('F01 per-column filter, match navigation, and independent clear', async () => {
    await selectTable(frame, 'pages');
    await frame.getByRole('textbox', { name: 'Filter column category', exact: true }).fill('even');
    await frame.getByRole('button', { name: 'Search column category', exact: true }).click();
    await contains(frame.locator('#statusText'), '125');
    assert.ok((await frame.locator('tr.data-row td[data-colidx="1"]').allTextContents()).every(value => value.includes('even')));
    const input = frame.getByRole('textbox', { name: 'Filter column category', exact: true });
    await input.press('Enter');
    await frame.locator('.active-match-cell').first().waitFor();
    const first = await frame.locator('.active-match-cell').first().getAttribute('id');
    await input.press('Enter'); await waitForValue(async () => await frame.locator('.active-match-cell').first().getAttribute('id') !== first, true, 'next match');
    await input.press('Shift+Enter'); await waitForValue(() => frame.locator('.active-match-cell').first().getAttribute('id'), first, 'previous match');
    await frame.getByRole('button', { name: 'Clear filter for category', exact: true }).click();
    await contains(frame.locator('#statusText'), '251');
  });
  await recorder.step('F02 date display modes preserve stored timestamps', async () => {
    await selectTable(frame, 'grid_cases');
    await frame.locator('#dateFormatSelect').selectOption('iso'); await contains(cell(-2, 4), '2024-01-01');
    for (const mode of ['local', 'relative']) {
      await frame.locator('#dateFormatSelect').selectOption(mode);
      assert.notEqual((await cell(-2, 4).textContent()).trim(), '1704067200');
    }
    await frame.locator('#dateFormatSelect').selectOption('raw'); await contains(cell(-2, 4), '1704067200');
    assert.deepEqual(readRows(fixtures.primary, 'SELECT created_at FROM grid_cases WHERE id=-2'), [{ created_at: 1704067200 }]);
  });
  await recorder.step('J01 JSON formatting, compacting, wrap, invalid draft, and keyboard save', async () => {
    await inspect(-2, 3); const editor = frame.locator('#cellPreviewTextarea');
    await frame.locator('#formatJsonBtn').click(); assert.match(await editor.inputValue(), /\n/);
    await frame.locator('#compactJsonBtn').click(); assert.doesNotMatch(await editor.inputValue(), /\n/);
    const wrap = await editor.evaluate(el => el.style.whiteSpace);
    await frame.locator('#wrapTextBtn').click(); assert.notEqual(await editor.evaluate(el => el.style.whiteSpace), wrap);
    await editor.fill('{invalid'); await frame.locator('#formatJsonBtn').click();
    await contains(frame.locator('#statusText'), 'not valid JSON'); assert.equal(await editor.inputValue(), '{invalid');
    await editor.fill('{"valid":"é😀"}'); await editor.press(`${modifier}+Enter`);
    await disk('SELECT json FROM grid_cases WHERE id=-2', [{ json: '{"valid":"é😀"}' }]);
    await inspect(-2, 3); await frame.locator('#cellPreviewEmptyBtn').click(); await frame.locator('#cellPreviewSaveBtn').click();
    await disk('SELECT json FROM grid_cases WHERE id=-2', [{ json: '' }]);
  });
  await recorder.step('X02 selected-row CSV, Excel encoding, SQL INSERT, and column validation', async () => {
    await selectTable(frame, 'contacts');
    await frame.locator('tr[data-rowid="2"] .row-select-button').click();
    for (const format of ['csv', 'excel', 'sql']) {
      await frame.locator('#btnExport').click(); await frame.locator('#exportFormat').selectOption(format);
      for (const checkbox of await frame.locator('.export-col-check').all()) await checkbox.uncheck();
      await frame.locator('#btnSubmitExport').click(); await contains(frame.locator('#statusText'), 'Select at least one column');
      for (const name of ['id', 'name']) await frame.locator(`.export-col-check[value="${name}"]`).check();
      const file = path.join(workspace, `selected.${format === 'sql' ? 'sql' : `${format}.csv`}`);
      await frame.locator('#btnSubmitExport').click(); await fileDialog(file);
      await waitForValue(() => fs.existsSync(file), true, 'export saved');
      const bytes = fs.readFileSync(file); const exported = bytes.toString('utf8');
      assert.ok(exported.includes('Caffè 東京')); assert.ok(!exported.includes('Ada'));
      if (format === 'sql') {
        const imported = new DatabaseSync(':memory:');
        try { imported.exec('CREATE TABLE contacts(id INTEGER,name TEXT);'); imported.exec(exported);
          assert.equal(imported.prepare('SELECT name FROM contacts').get().name, 'Caffè 東京');
        } finally { imported.close(); }
      } else if (format === 'excel') assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      else assert.match(exported, /^id,name\r?\n/);
    }
    await page.keyboard.press('Escape');
  });
  await recorder.step('S04 selected-column deletion and exact Undo', async () => {
    await selectTable(frame, 'grid_cases');
    await frame.getByRole('button', { name: 'Select column note', exact: true }).click();
    await page.keyboard.press(`${modifier}+Backspace`);
    await disk("SELECT name FROM pragma_table_info('grid_cases') WHERE name='note'", []);
    await undo();
    await disk("SELECT name FROM pragma_table_info('grid_cases') WHERE name='note'", [{ name: 'note' }]);
    await disk('SELECT note FROM grid_cases WHERE id=0', [{ note: 'blur edit' }]);
  });
  if (process.env.GUI_CLIPBOARD === '1') {
    await recorder.step('P01 real clipboard exact int64 and selected-row Unicode', async () => {
      await selectTable(frame, 'exact_values'); await cell(1, 1).click(); await page.keyboard.press(`${modifier}+c`);
      await waitForValue(() => app.evaluate(({ clipboard }) => clipboard.readText()), '9223372036854775807', 'exact clipboard integer');
      await selectTable(frame, 'contacts'); await frame.locator('tr[data-rowid="2"] .row-select-button').click(); await page.keyboard.press(`${modifier}+c`);
      await waitForValue(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())).includes('Caffè 東京'), true, 'actual row clipboard');
    });
  }
  await recorder.step('Q05 actual SQL selection executes only the selected statement', async () => {
    await newQuery('SELECT name FROM missing_table;\nSELECT name FROM markers;');
    await page.keyboard.press('Shift+Home'); await command(page, 'SQLite Explorer: Run Query');
    await waitForValue(async () => (await visibleText()).includes('primary'), true, 'selected query result');
  });
  await recorder.step('Q06 completion refresh and visible schema suggestions', async () => {
    await newQuery('SELECT * FROM grid_c'); await command(page, 'SQLite Explorer: Refresh Query Completions');
    await command(page, 'Trigger Suggest');
    await page.locator('.suggest-widget.visible').waitFor();
    await contains(page.locator('.suggest-widget.visible'), 'grid_cases'); await page.keyboard.press('Escape');
  });
  await recorder.step('Q07 invalid parameter validation, cancellation, and retry', async () => {
    await newQuery('SELECT ? AS value;'); await command(page, 'SQLite Explorer: Run Query');
    const input = page.locator('.quick-input-widget input'); await input.fill('[1,2]');
    await contains(page.locator('.quick-input-widget'), 'Expected 1 values');
    await input.press('Escape'); await command(page, 'SQLite Explorer: Run Query');
    await input.fill('["valid parameter"]'); await input.press('Enter');
    await waitForValue(async () => (await visibleText()).includes('valid parameter'), true, 'parameter retry');
  });
  await recorder.step('Q08 cancel a running read and run the next query', async () => {
    const queryProgress = page.locator('.notification-list-item').filter({ hasText: 'Running SQL query' });
    // VS Code keeps a completed query's Cancel button during notification fade-out.
    // Wait for that notification to close before starting and cancelling a new query.
    await waitForValue(() => queryProgress.count(), 0, 'previous query progress closed');
    await newQuery('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n;');
    const started = Date.now(); await command(page, 'SQLite Explorer: Run Query');
    await queryProgress.getByRole('button', { name: 'Cancel', exact: true }).click();
    await waitForValue(() => queryProgress.count(), 0, 'query progress cancelled');
    assert.ok(Date.now() - started < 20_000, 'cancellation must precede the configured timeout');
    await newQuery('SELECT 789 AS next_query;'); await command(page, 'SQLite Explorer: Run Query');
    await waitForValue(async () => (await visibleText()).includes('789'), true, 'query after cancellation');
    await waitForValue(() => queryProgress.count(), 0, 'next query progress closed');
  });
  await recorder.step('Q09 clear query history through the contributed command', async () => {
    await page.locator('.monaco-editor:visible .view-lines').filter({ hasText: 'next_query' }).click();
    const historyPicker = page.locator('.quick-input-widget');
    await command(page, 'SQLite Explorer: Query History');
    await contains(historyPicker, 'SELECT 789 AS next_query;'); await page.keyboard.press('Escape');
    await command(page, 'SQLite Explorer: Clear Query History'); await command(page, 'SQLite Explorer: Query History');
    await contains(historyPicker, 'SQL query history (session only; parameter values excluded)');
    await waitForValue(() => historyPicker.locator('.quick-input-list .monaco-list-row').count(), 0, 'cleared query history');
    await page.keyboard.press('Escape');
  });
  await page.screenshot({ path: path.join(output, 'grid-query-finished.png') });
} finally {
  await app.close();
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({
    backend, clipboard: process.env.GUI_CLIPBOARD === '1',
    passed: recorder.results.filter(result => result.status === 'passed').length,
    failed: recorder.results.filter(result => result.status === 'failed').length
  }, null, 2));
}
