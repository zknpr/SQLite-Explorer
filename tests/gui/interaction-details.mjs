import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const helperUrl = process.env.GUI_HELPER_DIRECTORY
  ? pathToFileURL(path.join(path.resolve(process.env.GUI_HELPER_DIRECTORY), 'driver.mjs'))
  : new URL('./driver.mjs', import.meta.url);
const { launchInstalledVsix, command, viewerFrame, openDatabase, selectTable, waitForValue, createRecorder } = await import(helperUrl.href);
const { createFixtures, readRows } = await import(new URL('./fixtures.mjs', helperUrl).href);
const output = path.resolve(process.env.GUI_OUTPUT ?? `.tmp/interaction-${Date.now()}`);
const sourceVsix = process.env.GUI_VSIX && path.resolve(process.env.GUI_VSIX);
const backend = process.env.GUI_BACKEND ?? 'native';
const expectedHash = process.env.GUI_EXPECTED_SHA256;
assert.ok(sourceVsix && fs.existsSync(sourceVsix), 'GUI_VSIX must identify the frozen package');
assert.match(expectedHash ?? '', /^[a-f0-9]{64}$/);
assert.ok(['native', 'wasm'].includes(backend));
assert.ok(process.env.VSCODE_TEST_EXECUTABLE_PATH, 'select the actual VS Code executable');
assert.equal(fs.existsSync(output), false, 'use a fresh GUI_OUTPUT directory');
fs.mkdirSync(path.join(output, 'inputs'), { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const vsix = path.join(output, 'inputs', path.basename(sourceVsix));
fs.copyFileSync(sourceVsix, vsix, fs.constants.COPYFILE_EXCL);
assert.equal(sha256(fs.readFileSync(vsix)), expectedHash);
fs.writeFileSync(path.join(output, 'artifact.json'), JSON.stringify({ sourceVsix, vsix, backend,
  sha256: expectedHash, frozenAt: new Date().toISOString(), helper: helperUrl.href,
  helperSha256: sha256(fs.readFileSync(helperUrl)) }, null, 2));
const workspace = path.join(output, 'workspace');
const fixtures = createFixtures(workspace);

function smallPdf() {
  const parts = ['%PDF-1.4\n'];
  const offsets = [0];
  const object = body => {
    offsets.push(Buffer.byteLength(parts.join('')));
    parts.push(`${offsets.length - 1} 0 obj\n${body}\nendobj\n`);
  };
  object('<< /Type /Catalog /Pages 2 0 R >>');
  object('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>');
  object('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const content = 'BT /F1 16 Tf 30 110 Td (Private small PDF) Tj ET\n';
  object(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  const xref = Buffer.byteLength(parts.join(''));
  parts.push(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  parts.push(...offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`));
  parts.push(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(parts.join(''));
}
const pdf = smallPdf();
const malformed = Buffer.from([0x41, 0x80, 0xff, 0xc3, 0x28, 0, 0x42]);
const dragged = Buffer.from([0, 255, 128, 19, 10, 13, 65, 0, 254]);
const draggedFile = path.join(workspace, 'drag-payload.bin');
fs.writeFileSync(draggedFile, dragged);
const seeded = new DatabaseSync(fixtures.primary);
try {
  seeded.exec("CREATE TABLE interaction_values(id INTEGER PRIMARY KEY, label TEXT, value TEXT, payload BLOB);"
    + "INSERT INTO interaction_values VALUES(1,'empty target','before empty',NULL),"
    + "(2,'textarea','alpha'||char(10)||'beta',NULL),(3,'small pdf',NULL,NULL),(4,'drop target',NULL,X'0405');"
    + "CREATE TABLE nullable_default(id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT DEFAULT 'default note');"
    + "CREATE TABLE malformed_text(id INTEGER PRIMARY KEY, value TEXT);"
    + "CREATE VIEW malformed_text_view AS SELECT id,value FROM malformed_text;"
    + "CREATE TABLE export_options(id INTEGER PRIMARY KEY, name TEXT);"
    + "INSERT INTO export_options VALUES(1,'Caffè 東京'),(2,'second');");
  seeded.prepare('UPDATE interaction_values SET payload=? WHERE id=3').run(pdf);
  seeded.prepare('INSERT INTO malformed_text VALUES(1,CAST(? AS TEXT))').run(malformed);
} finally { seeded.close(); }

const { app, page } = await launchInstalledVsix({ vsix, output, workspace,
  executable: process.env.VSCODE_TEST_EXECUTABLE_PATH, version: process.env.GUI_VSCODE_VERSION ?? '1.110.0' });
const recorder = createRecorder(page, output);
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const requested = process.env.GUI_CASES && new Set(process.env.GUI_CASES.split(','));
const browserErrors = [];
const observations = {};
page.on('pageerror', error => browserErrors.push(String(error)));
let frame;
const run = async (id, title, operation) => {
  if (requested && id !== 'J00' && !requested.has(id)) return;
  // Real file drags cross the host/webview boundary and need a supported input
  // route. Keep this explicit until a trusted drag reaches the target cell.
  if (id === 'J13' && !requested?.has('J13') && process.env.GUI_FILE_DRAG !== '1') return;
  await recorder.step(`${id} ${title}`, operation);
};
const screenshot = name => page.screenshot({ path: path.join(output, `${name}.png`) });
const contains = (locator, value) => waitForValue(async () => (await locator.textContent()).replaceAll('\u00a0', ' ').includes(value), true, value);
const primary = async table => {
  const tab = page.locator('.tabs-container .tab[data-resource-name="qa.db"]');
  if (await tab.count()) {
    await tab.click();
    await waitForValue(() => tab.evaluate(element => element.classList.contains('active')), true, 'qa.db tab is active');
    frame = await viewerFrame(page);
  } else frame = await openDatabase(page, 'qa.db');
  if (table) await selectTable(frame, table);
};
const cell = (row, column) => frame.locator(`tr.data-row[data-rowid="${row}"] td[data-colidx="${column}"]`);
const inspect = async (row, column) => {
  const target = cell(row, column); await target.click();
  const expand = target.locator('.expand-icon');
  if (await expand.count()) await expand.click();
  else await target.dblclick();
};
const disk = (sql, expected) => waitForValue(() => readRows(fixtures.primary, sql), expected, sql);
const active = () => frame.evaluate(() => ({ id: document.activeElement?.id, tag: document.activeElement?.tagName,
  text: document.activeElement?.textContent?.slice(0, 160), modal: document.activeElement?.closest('[role="dialog"]')?.id }));
const focused = locator => locator.evaluate(element => element === element.ownerDocument.activeElement);
const saveDatabase = async () => {
  await page.keyboard.press(`${modifier}+S`);
  await waitForValue(() => page.locator('.tabs-container .tab[data-resource-name="qa.db"]').evaluateAll(tabs =>
    tabs.length > 0 && tabs.every(tab => !tab.classList.contains('dirty'))), true, 'database save checkpoint');
};
const fileDialog = async file => {
  const dialog = page.locator('.quick-input-widget').filter({ has: page.getByRole('button', { name: 'OK', exact: true }) });
  await dialog.waitFor(); const input = dialog.locator('input');
  await waitForValue(async () => path.isAbsolute(await input.inputValue()), true, 'initialized file dialog');
  await input.click(); await input.fill(file); await input.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
};
const closeInspector = () => frame.locator('#blob-inspector-modal .modal-close').click();
const download = async (button, file, bytes) => {
  await button.click(); await fileDialog(file);
  await waitForValue(() => fs.existsSync(file), true, 'download committed');
  assert.deepEqual(fs.readFileSync(file), bytes);
};

try {
  await run('J00', 'actual installed backend and private fixture identity', async () => {
    await primary('interaction_values'); await contains(frame.locator('#gridContainer'), 'before empty');
    const logs = path.join(output, 'profile/logs');
    await waitForValue(() => fs.readdirSync(logs, { recursive: true }).filter(file => file.endsWith('SQLite Explorer.log'))
      .some(file => fs.readFileSync(path.join(logs, file), 'utf8').includes(`Using ${backend === 'native' ? 'native' : 'WebAssembly'} SQLite backend`)), true, 'actual backend');
    assert.deepEqual(readRows(fixtures.primary, 'SELECT typeof(value) AS type,hex(value) AS bytes FROM malformed_text'),
      [{ type: 'text', bytes: malformed.toString('hex').toUpperCase() }]);
  });
  await run('J01', 'Tables section collapses and expands using mouse and keyboard', async () => {
    await primary('interaction_values');
    const toggle = frame.locator('#sectionTables .section-toggle');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await toggle.click(); await frame.locator('#tablesList').waitFor({ state: 'hidden' });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.press('Enter'); await frame.locator('#tablesList').waitFor();
    await toggle.press('Space'); await frame.locator('#tablesList').waitFor({ state: 'hidden' });
    await toggle.click(); await frame.locator('#tablesList').waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await contains(frame.locator('#gridContainer'), 'before empty'); await screenshot('01-tables-expanded');
  });
  await run('J02', 'remove a column definition and immediately focus its adjacent definition', async () => {
    await primary(); await frame.locator('#btnOpenCreateTable').click();
    await frame.locator('#newTableName').fill('definition_result');
    await frame.locator('#btnAddColumnDef').click(); await frame.locator('#columnName_2').fill('discarded');
    await frame.locator('#btnAddColumnDef').click(); await frame.locator('#columnName_3').fill('retained');
    await frame.getByRole('button', { name: 'Remove column definition 2', exact: true }).click();
    assert.equal(await frame.locator('#colDef_2').count(), 0);
    assert.equal(await frame.locator('.column-def-row').count(), 2);
    observations.removedDefinitionFocus = { afterRemoval: await active() };
    assert.equal(observations.removedDefinitionFocus.afterRemoval.modal, 'createTableModal', 'removal keeps focus inside the modal immediately');
    assert.equal(observations.removedDefinitionFocus.afterRemoval.id, 'columnName_3', 'removal focuses the next remaining definition');
    await page.keyboard.press('Tab');
    await waitForValue(() => focused(frame.locator('#columnType_3')), true, 'Tab continues within the adjacent definition');
    observations.removedDefinitionFocus.afterTab = await active();
    await frame.locator('#btnSubmitCreateTable').click(); await frame.locator('#createTableModal').waitFor({ state: 'hidden' });
    await selectTable(frame, 'definition_result'); await saveDatabase();
    await disk("SELECT name FROM pragma_table_info('definition_result') ORDER BY cid", [{ name: 'id' }, { name: 'retained' }]);
  });
  await run('J03', 'Add Row explicit SQL NULL overrides a non-NULL column default', async () => {
    await primary('nullable_default'); await frame.locator('#btnAddRow').click();
    await frame.locator('#addRowForm input[data-column="name"]').fill('explicit null');
    const field = frame.locator('#addRowForm .form-field').filter({ has: frame.locator('input[data-column="note"]') });
    await field.getByRole('button', { name: 'SQL NULL', exact: true }).click();
    assert.equal(await field.locator('input').getAttribute('placeholder'), 'SQL NULL');
    await frame.locator('#btnSubmitAddRow').click(); await frame.locator('#addRowModal').waitFor({ state: 'hidden' });
    await contains(frame.locator('#gridContainer'), 'explicit null'); await saveDatabase();
    await disk('SELECT name,note,typeof(note) AS storage FROM nullable_default', [{ name: 'explicit null', note: null, storage: 'null' }]);
  });
  await run('J04', 'Batch Update section toggle retains its selected target', async () => {
    await primary('interaction_values'); await cell(1, 2).click();
    const toggle = frame.locator('#batchUpdateSectionTitle'); await toggle.waitFor();
    const count = await frame.locator('#batchUpdateCount').textContent();
    await toggle.click(); await frame.locator('#batchUpdateList').waitFor({ state: 'hidden' });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.press('Enter'); await frame.locator('#batchUpdateList').waitFor();
    await toggle.press('Space'); await frame.locator('#batchUpdateList').waitFor({ state: 'hidden' });
    await toggle.click(); await frame.locator('#batchUpdateList').waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await frame.locator('#batchUpdateCount').textContent(), count);
    assert.equal(await cell(1, 2).evaluate(element => element.classList.contains('cell-selected')), true);
    await disk('SELECT value FROM interaction_values WHERE id=1', [{ value: 'before empty' }]);
  });
  await run('J05', 'cell preview Empty string persists TEXT instead of NULL', async () => {
    await primary('interaction_values'); await inspect(1, 2);
    await frame.locator('#cellPreviewEmptyBtn').click();
    assert.equal(await frame.locator('#cellPreviewTextarea').inputValue(), '');
    await frame.locator('#cellPreviewSaveBtn').click(); await frame.locator('#cellPreviewModal').waitFor({ state: 'hidden' });
    await saveDatabase();
    await disk('SELECT value,typeof(value) AS storage,length(value) AS length FROM interaction_values WHERE id=1',
      [{ value: '', storage: 'text', length: 0 }]);
  });
  await run('J06', 'textarea Tab indents and Escape then Tab moves focus without cancelling', async () => {
    await primary('interaction_values'); await inspect(2, 2);
    const textarea = frame.locator('#cellPreviewTextarea'); await textarea.click();
    await page.keyboard.press(`${modifier}+A`); await page.keyboard.press('Tab');
    assert.equal(await textarea.inputValue(), '    alpha\n    beta'); assert.equal(await focused(textarea), true);
    await page.keyboard.press('Shift+Tab'); assert.equal(await textarea.inputValue(), 'alpha\nbeta');
    await page.keyboard.press('Tab'); assert.equal(await textarea.inputValue(), '    alpha\n    beta');
    await page.keyboard.press('Escape'); assert.equal(await frame.locator('#cellPreviewModal').isVisible(), true);
    await page.keyboard.press('Tab');
    await waitForValue(() => focused(textarea), false, 'Escape then Tab moves focus out of the textarea');
    assert.equal((await active()).modal, 'cellPreviewModal');
    observations.textareaFocusAfterEscapeTab = await active();
    await frame.locator('#cellPreviewSaveBtn').click(); await frame.locator('#cellPreviewModal').waitFor({ state: 'hidden' });
    await saveDatabase(); await disk('SELECT value FROM interaction_values WHERE id=2', [{ value: '    alpha\n    beta' }]);
  });
  await run('J07', 'small PDF Download to view preserves every source byte', async () => {
    await primary('interaction_values'); await inspect(3, 3);
    await contains(frame.locator('#tab-preview'), 'PDF Document');
    assert.equal(await frame.locator('#tab-preview iframe').count(), 0);
    const destination = path.join(workspace, 'small-pdf-download.pdf');
    await download(frame.getByRole('button', { name: 'Download to view', exact: true }), destination, pdf);
    observations.smallPdf = { bytes: pdf.length, sha256: sha256(fs.readFileSync(destination)) };
    await screenshot('07-small-pdf-download'); await closeInspector();
    await disk('SELECT typeof(payload) AS storage,length(payload) AS length FROM interaction_values WHERE id=3',
      [{ storage: 'blob', length: pdf.length }]);
  });
  await run('J08', 'malformed TEXT retains authoritative Hex bytes and view download', async () => {
    await primary('malformed_text'); await inspect(1, 1);
    await contains(frame.locator('#statusText'), 'Raw bytes remain in Hex');
    await frame.getByRole('button', { name: 'Hex', exact: true }).click();
    const hex = frame.getByRole('region', { name: 'TEXT hexadecimal data', exact: true }); await hex.waitFor();
    assert.match(await hex.textContent(), /41 80 ff c3 28 00 42/i);
    observations.malformedTable = { info: await frame.locator('#blob-info').textContent(), hex: await hex.textContent() };
    await closeInspector();
    if (!await frame.locator('#viewsList').isVisible()) await frame.locator('[data-section="views"]').click();
    await frame.getByRole('button', { name: 'Open view malformed_text_view', exact: true }).click();
    await contains(frame.locator('#tableNameLabel'), 'malformed_text_view');
    const rawCell = frame.locator('tr.data-row td[data-colidx="1"]'); await rawCell.click();
    if (await rawCell.locator('.expand-icon').count()) await rawCell.locator('.expand-icon').click();
    else await rawCell.dblclick();
    await contains(frame.locator('#blob-info'), 'Hex is authoritative');
    await frame.getByRole('button', { name: 'Hex', exact: true }).click();
    assert.match(await frame.getByRole('region', { name: 'TEXT hexadecimal data', exact: true }).textContent(), /41 80 ff c3 28 00 42/i);
    const destination = path.join(workspace, 'malformed-raw-download.bin');
    await download(frame.getByRole('button', { name: 'Download Raw Bytes', exact: true }), destination, malformed);
    observations.malformedDownload = { bytes: malformed.length, sha256: sha256(fs.readFileSync(destination)) };
    await screenshot('08-malformed-text-hex'); await closeInspector();
    await disk('SELECT typeof(value) AS storage,hex(value) AS bytes FROM malformed_text',
      [{ storage: 'text', bytes: malformed.toString('hex').toUpperCase() }]);
  });
  await run('J09', 'Escape and backdrop dismiss only the current draft and retain database ownership', async () => {
    await primary('interaction_values');
    await frame.locator('#btnOpenCreateTable').click(); await frame.locator('#newTableName').fill('escaped_draft');
    await page.keyboard.press('Escape'); await frame.locator('#createTableModal').waitFor({ state: 'hidden' });
    assert.equal(await focused(frame.locator('#btnOpenCreateTable')), true);
    await frame.locator('#btnAddRow').click();
    await frame.locator('#addRowForm input[data-column="label"]').fill('backdrop draft');
    await frame.locator('#addRowModal').click({ position: { x: 4, y: 4 } });
    await frame.locator('#addRowModal').waitFor({ state: 'hidden' });
    assert.equal(await focused(frame.locator('#btnAddRow')), true);
    await inspect(2, 2); const textarea = frame.locator('#cellPreviewTextarea');
    await textarea.fill('discarded cell draft'); await textarea.click();
    await page.keyboard.press('Escape'); assert.equal(await frame.locator('#cellPreviewModal').isVisible(), true);
    await page.keyboard.press('Escape'); await frame.locator('#cellPreviewModal').waitFor({ state: 'hidden' });
    await disk("SELECT count(*) AS n FROM sqlite_schema WHERE name='escaped_draft'", [{ n: 0 }]);
    await disk("SELECT count(*) AS n FROM interaction_values WHERE label='backdrop draft' OR value='discarded cell draft'", [{ n: 0 }]);
    await frame.locator('#btnAddRow').click();
    assert.equal(await frame.locator('#addRowForm input[data-column="label"]').inputValue(), '');
    await frame.locator('#addRowModal .modal-cancel').click(); await screenshot('09-dismissal-owner');
  });
  await run('J10', 'Tab and Shift Tab traverse and wrap inside the actual Create Table modal', async () => {
    await primary(); await frame.locator('#btnOpenCreateTable').click();
    const modal = frame.locator('#createTableModal');
    const first = modal.getByRole('button', { name: 'Close create table', exact: true });
    const last = frame.locator('#btnSubmitCreateTable');
    assert.equal(await focused(first), true);
    await page.keyboard.press('Shift+Tab'); assert.equal(await focused(last), true);
    await page.keyboard.press('Tab'); assert.equal(await focused(first), true);
    const forward = [];
    for (let index = 0; index < 30; index++) {
      await page.keyboard.press('Tab'); const current = await active(); forward.push(current);
      assert.equal(current.modal, 'createTableModal', 'forward Tab stays in modal');
      if (await focused(first)) break;
    }
    assert.equal(await focused(first), true, 'forward traversal wraps');
    assert.ok(forward.some(control => control.id === 'newTableName'));
    assert.ok(forward.some(control => control.id === 'columnType_1'));
    assert.ok(forward.some(control => control.id === 'btnSubmitCreateTable'));
    const reverse = [];
    for (let index = 0; index < 30; index++) {
      await page.keyboard.press('Shift+Tab'); const current = await active(); reverse.push(current);
      assert.equal(current.modal, 'createTableModal', 'reverse Tab stays in modal');
      if (await focused(first)) break;
    }
    assert.equal(await focused(first), true, 'reverse traversal wraps');
    assert.equal(reverse.length, forward.length);
    observations.modalTabTraversal = { forward, reverse };
    await screenshot('10-modal-tab-wrap'); await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' });
  });
  await run('J11', 'export header and SQL table-name checkboxes change committed output', async () => {
    await primary('export_options');
    const exported = {};
    for (const checked of [true, false]) {
      await frame.locator('#btnExport').click(); await frame.locator('#exportFormat').selectOption('csv');
      await frame.locator('#exportHeader').setChecked(checked);
      await frame.locator('#btnSubmitExport').click();
      const destination = path.join(workspace, `headers-${checked}.csv`); await fileDialog(destination);
      await waitForValue(() => fs.existsSync(destination), true, 'CSV export committed');
      exported[`csv${checked}`] = fs.readFileSync(destination, 'utf8');
    }
    assert.equal(exported.csvtrue.replace(/^id,name\r?\n/, ''), exported.csvfalse);
    assert.match(exported.csvtrue, /^id,name\r?\n/); assert.match(exported.csvfalse, /^1,Caffè 東京\r?\n/);
    for (const checked of [true, false]) {
      await frame.locator('#btnExport').click(); await frame.locator('#exportFormat').selectOption('sql');
      await frame.locator('#exportTableName').setChecked(checked);
      await frame.locator('#btnSubmitExport').click();
      const destination = path.join(workspace, `table-name-${checked}.sql`); await fileDialog(destination);
      await waitForValue(() => fs.existsSync(destination), true, 'SQL export committed');
      const sql = fs.readFileSync(destination, 'utf8'); exported[`sql${checked}`] = sql;
      const check = new DatabaseSync(':memory:');
      try {
        const table = checked ? 'export_options' : 'table_name';
        check.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY,name TEXT);`); check.exec(sql);
        assert.deepEqual(check.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(row => ({ ...row })),
          [{ id: 1, name: 'Caffè 東京' }, { id: 2, name: 'second' }]);
      } finally { check.close(); }
    }
    assert.match(exported.sqltrue, /INSERT INTO "export_options"/);
    assert.match(exported.sqlfalse, /INSERT INTO table_name/); assert.doesNotMatch(exported.sqlfalse, /INSERT INTO "export_options"/);
    observations.exportCheckboxes = exported;
  });
  await run('J12', 'ordinary SQL Save close and reopen uses explicit database binding', async () => {
    await openDatabase(page, 'second.db'); await primary('interaction_values');
    await frame.locator('#btnOpenQuery').click();
    const editorText = () => page.locator('.monaco-editor.focused:visible .view-lines');
    await contains(editorText(), 'SELECT 1 AS value;'); await editorText().click();
    await page.keyboard.press(`${modifier}+A`);
    const sql = "SELECT 'SAVED QUERY ' || upper(name) AS binding_result FROM markers;\n";
    await page.keyboard.insertText(sql); await page.keyboard.press(`${modifier}+Shift+S`);
    const saved = path.join(workspace, 'ordinary-query.sql'); await fileDialog(saved);
    await waitForValue(() => fs.existsSync(saved), true, 'ordinary SQL saved to disk'); assert.equal(fs.readFileSync(saved, 'utf8'), sql);
    const tab = page.locator('.tabs-container .tab[data-resource-name="ordinary-query.sql"]'); await tab.waitFor();
    await command(page, 'SQLite Explorer: Choose Query Database');
    await page.locator('.quick-input-widget .label-name').filter({ hasText: /^qa\.db$/ }).click();
    await command(page, 'SQLite Explorer: Run Query');
    const allText = async () => (await page.locator('.monaco-editor:visible .view-lines').allTextContents()).join('\n').replaceAll('\u00a0', ' ');
    await waitForValue(async () => (await allText()).includes('SAVED QUERY PRIMARY'), true, 'saved SQL is bound to qa.db');
    await tab.click(); await page.keyboard.press(`${modifier}+W`); await tab.waitFor({ state: 'hidden' });
    await page.getByRole('treeitem', { name: 'ordinary-query.sql', exact: true }).dblclick();
    await tab.waitFor(); await contains(editorText(), 'binding_result');
    await command(page, 'SQLite Explorer: Run Query');
    await contains(page.locator('.quick-input-widget'), 'Choose query database');
    observations.reopenedSqlRequiredDatabaseSelection = true;
    await page.locator('.quick-input-widget .label-name').filter({ hasText: /^second\.db$/ }).click();
    await waitForValue(async () => (await allText()).includes('SAVED QUERY SECONDARY'), true, 'reopened SQL is explicitly rebound');
    assert.equal(fs.readFileSync(saved, 'utf8'), sql);
    assert.deepEqual(readRows(fixtures.primary, 'SELECT name FROM markers'), [{ name: 'primary' }]);
    assert.deepEqual(readRows(fixtures.secondary, 'SELECT name FROM markers'), [{ name: 'secondary' }]);
    await screenshot('12-saved-query-binding');
  });
  await run('J13', 'trusted Explorer mouse drag replaces a BLOB with the exact file bytes', async () => {
    await primary('interaction_values');
    const source = page.getByRole('treeitem', { name: 'drag-payload.bin', exact: true });
    const target = cell(4, 3); await source.scrollIntoViewIfNeeded(); await target.scrollIntoViewIfNeeded();
    const from = await source.boundingBox(); const to = await target.boundingBox();
    assert.ok(from && to);
    await page.mouse.move(from.x + Math.min(from.width / 2, 85), from.y + from.height / 2);
    await page.mouse.down();
    try {
      await page.mouse.move(from.x + Math.min(from.width / 2, 85) + 12, from.y + from.height / 2, { steps: 4 });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 25 });
      // Enter the editor first, then press Shift to hand its drop overlay to
      // the webview. Pressing Shift before entering is a different gesture.
      await page.keyboard.down('Shift');
      await page.mouse.move(to.x + to.width / 2 + 2, to.y + to.height / 2, { steps: 2 });
      await waitForValue(() => target.evaluate(element => element.classList.contains('drag-over')), true, 'actual file drag reaches the data cell');
      await screenshot('13-trusted-drag-over');
    } finally {
      await page.mouse.up(); await page.keyboard.up('Shift');
    }
    await contains(frame.locator('#statusText'), 'Uploaded drag-payload.bin'); await saveDatabase();
    await disk('SELECT typeof(payload) AS storage,hex(payload) AS bytes FROM interaction_values WHERE id=4',
      [{ storage: 'blob', bytes: dragged.toString('hex').toUpperCase() }]);
    assert.deepEqual(fs.readFileSync(draggedFile), dragged);
    observations.dragDrop = { source: 'VS Code Explorer', input: 'mouse down/move/up', bytes: dragged.length,
      sha256: sha256(dragged), nativeFileListVariant: 'not exercised' };
    await screenshot('13-trusted-drag-persisted');
  });
  assert.deepEqual(browserErrors, []);
} finally {
  try {
    if (frame && !frame.isDetached()) {
      fs.writeFileSync(path.join(output, 'final-viewer.html'), await frame.content());
      fs.writeFileSync(path.join(output, 'final-focus.json'), JSON.stringify({
        viewer: await active(), hasFocus: await frame.evaluate(() => document.hasFocus()),
        workbench: await page.evaluate(() => ({ tag: document.activeElement?.tagName,
          className: document.activeElement?.className, label: document.activeElement?.getAttribute('aria-label') }))
      }, null, 2));
    }
  } finally {
    await app.close();
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ backend, vsixSha256: expectedHash,
      passed: recorder.results.filter(result => result.status === 'passed').length,
      failed: recorder.results.filter(result => result.status === 'failed').length, observations, browserErrors }, null, 2));
  }
}
