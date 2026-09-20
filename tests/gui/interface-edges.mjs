import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createFixtures, readRows } from './fixtures.mjs';
import { launchInstalledVsix, command, viewerFrame, openDatabase, selectTable, waitForValue, createRecorder } from './driver.mjs';

const output = path.resolve(process.env.GUI_OUTPUT ?? `.tmp/gui-edges-${Date.now()}`);
const vsix = process.env.GUI_VSIX && path.resolve(process.env.GUI_VSIX);
const backend = process.env.GUI_BACKEND ?? 'native';
assert.ok(vsix && fs.existsSync(vsix), 'GUI_VSIX must name the packaged extension');
assert.equal(fs.existsSync(output), false, 'use a fresh GUI_OUTPUT');
const workspace = path.join(output, 'workspace');
const fixtures = createFixtures(workspace);
const names = ['sqlite', 'sqlite3', 'db', 'db3', 'sdb', 's3db', 'gpkg'].map(ext => `association.${ext}`);
names.push('Caffè 東京 spaced.DB');
for (const name of [...names, 'extensionless']) fs.copyFileSync(fixtures.primary, path.join(workspace, name));
fs.writeFileSync(path.join(workspace, 'empty.db'), Buffer.alloc(0));
const corrupt = Buffer.from('This is a private invalid database fixture.\n'.repeat(200));
fs.writeFileSync(path.join(workspace, 'corrupt.db'), corrupt);
const large = new DatabaseSync(path.join(workspace, 'limited.db'));
try { large.exec('CREATE TABLE size_guard(id INTEGER PRIMARY KEY, payload BLOB); INSERT INTO size_guard VALUES(1,zeroblob(2097152))'); }
finally { large.close(); }
const seed = new DatabaseSync(fixtures.primary);
try { seed.exec(`CREATE TRIGGER update_active_name INSTEAD OF UPDATE ON active_contacts BEGIN
  UPDATE contacts SET name=NEW.name WHERE id=OLD.id; END;`); }
finally { seed.close(); }

const { app, page } = await launchInstalledVsix({ vsix, output, workspace,
  executable: process.env.VSCODE_TEST_EXECUTABLE_PATH, version: process.env.GUI_VSCODE_VERSION ?? '1.110.0',
  settings: { 'sqliteExplorer.maxFileSize': 1, 'sqliteExplorer.instantCommit': backend === 'wasm' ? 'always' : 'never' }
});
const recorder = createRecorder(page, output);
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
let frame;
const contains = (locator, expected) => waitForValue(async () => (await locator.textContent()).includes(expected), true, expected);
const disk = (sql, expected) => waitForValue(() => readRows(fixtures.primary, sql), expected, sql);
const closeEditor = () => command(page, 'View: Close Editor');
const primary = async () => { frame = await openDatabase(page, 'qa.db'); };
const viewEdit = async () => {
  if (!await frame.locator('#viewsList').isVisible()) await frame.locator('[data-section="views"]').click();
  await frame.getByRole('button', { name: 'Open view active_contacts', exact: true }).hover();
  await frame.getByRole('button', { name: 'Edit view active_contacts', exact: true }).click();
  await frame.locator('#viewSelectSql').waitFor();
};
const modalClose = () => frame.locator('#viewModal .modal-close').click();
const editSql = async text => {
  const lines = page.locator('.monaco-editor.focused:visible .view-lines');
  await lines.waitFor();
  // Long SQL can leave Monaco horizontally scrolled, so the view-lines box's
  // center can lie under its gutter. Verify the handoff's focus and type there.
  await waitForValue(() => page.evaluate(() => {
    const editor = document.querySelector('.monaco-editor.focused');
    return !!editor?.contains(document.activeElement)
      && editor.closest('.editor-group-container')?.classList.contains('active') === true;
  }), true, 'the SQL editor owns keyboard and workbench focus');
  await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(text);
};
const visibleMessages = async () => {
  const messages = [await page.locator('body').innerText()];
  for (const candidate of page.frames()) {
    if (!candidate.url().startsWith('vscode-webview://')) continue;
    try { messages.push(await candidate.locator('body').innerText()); }
    catch (error) { if (!/detached|disposed|closed/i.test(String(error))) throw error; }
  }
  return messages.join('\n');
};

try {
  await recorder.step('E01 all seven file associations and uppercase Unicode filename', async () => {
    for (const name of names) {
      frame = await openDatabase(page, name); await selectTable(frame, 'markers');
      await contains(frame.locator('#gridContainer'), 'primary'); await closeEditor();
    }
  });
  await recorder.step('E02 optional editor opens a valid extensionless database', async () => {
    await page.getByRole('treeitem', { name: 'extensionless', exact: true }).dblclick();
    await command(page, 'View: Reopen Editor With...');
    await page.locator('.quick-input-widget .label-name').filter({ hasText: /^SQLite Explorer \(Optional\)$/ }).click();
    frame = await viewerFrame(page); await selectTable(frame, 'markers');
    await contains(frame.locator('#gridContainer'), 'primary'); await closeEditor();
  });
  await recorder.step('E03 empty database remains usable and corrupt bytes fail visibly without modification', async () => {
    await page.getByRole('treeitem', { name: 'empty.db', exact: true }).dblclick();
    frame = await viewerFrame(page);
    await frame.locator('#btnOpenCreateTable').waitFor();
    assert.equal(await frame.locator('#btnOpenCreateTable').isDisabled(), false);
    await closeEditor();
    await page.getByRole('treeitem', { name: 'corrupt.db', exact: true }).dblclick();
    await waitForValue(async () => /not a database|invalid database|failed to open/i.test(await visibleMessages()), true, 'visible corrupt database error');
    assert.deepEqual(fs.readFileSync(path.join(workspace, 'corrupt.db')), corrupt);
    await page.screenshot({ path: path.join(output, 'corrupt-error.png') }); await closeEditor();
    await primary(); await selectTable(frame, 'contacts'); await contains(frame.locator('#gridContainer'), 'Ada');
  });
  await recorder.step('V04 external view editor validates Save and refreshes the owning database', async () => {
    const focusTrace = [];
    const recordFocus = async label => {
      focusTrace.push({ label, ui: await page.evaluate(() => ({
        activeElement: document.activeElement?.outerHTML.slice(0, 350),
        activeTabs: Array.from(document.querySelectorAll('.tab.active')).map(tab => ({
          text: tab.textContent, group: tab.closest('.editor-group-container')?.className
        })),
        editors: Array.from(document.querySelectorAll('.monaco-editor')).map(editor => ({
          className: editor.className, text: editor.querySelector('.view-lines')?.textContent.slice(0, 200)
        }))
      })) });
      fs.writeFileSync(path.join(output, 'view-focus-trace.json'), JSON.stringify(focusTrace, null, 2));
    };
    await viewEdit(); await frame.locator('#btnOpenViewInVsCode').click();
    await frame.locator('#viewModal').waitFor({ state: 'hidden' });
    await recordFocus('handoff');
    const lines = page.locator('.monaco-editor.focused:visible .view-lines'); await contains(lines, 'SELECT');
    await editSql('SELECT id, lower(name) AS name, score FROM contacts WHERE active=1');
    await recordFocus('edited');
    await page.keyboard.press(`${modifier}+S`);
    await recordFocus('save');
    await disk('SELECT name FROM active_contacts WHERE id=1', [{ name: 'ada' }]);
    await editSql('SELECT name FROM does_not_exist'); await page.keyboard.press(`${modifier}+S`);
    await waitForValue(async () => /Invalid view definition/i.test(await visibleMessages()), true, 'view editor validation notification');
    assert.deepEqual(readRows(fixtures.primary, 'SELECT name FROM active_contacts WHERE id=1'), [{ name: 'ada' }]);
    await editSql('SELECT id, upper(name) AS name, score FROM contacts WHERE active=1'); await page.keyboard.press(`${modifier}+S`);
    await disk('SELECT name FROM active_contacts WHERE id=1', [{ name: 'ADA' }]);
    await closeEditor(); await primary();
  });
  await recorder.step('V05 view trigger preservation, destructive confirmation cancel, and Undo', async () => {
    await viewEdit();
    assert.equal(await frame.locator('#viewPreserveTriggers').isChecked(), true);
    await contains(frame.locator('#viewTriggerSummary'), 'update_active_name');
    await frame.locator('#viewSelectSql').fill('SELECT id,name,score FROM contacts WHERE active=1');
    await frame.locator('#btnSaveView').click(); await frame.locator('#viewModal').waitFor({ state: 'hidden' });
    await disk("SELECT name FROM sqlite_schema WHERE type='trigger'", [{ name: 'update_active_name' }]);
    await viewEdit(); await frame.locator('#viewPreserveTriggers').uncheck();
    await frame.locator('#btnSaveView').click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await contains(frame.locator('#viewValidationStatus'), 'cancelled');
    assert.deepEqual(readRows(fixtures.primary, "SELECT name FROM sqlite_schema WHERE type='trigger'"), [{ name: 'update_active_name' }]);
    await frame.locator('#btnSaveView').click();
    await page.getByRole('button', { name: 'Edit and Drop Triggers', exact: true }).click();
    await frame.locator('#viewModal').waitFor({ state: 'hidden' });
    await disk("SELECT name FROM sqlite_schema WHERE type='trigger'", []);
    await frame.locator('#tableNameLabel').click(); await page.keyboard.press(`${modifier}+Z`);
    await disk("SELECT name FROM sqlite_schema WHERE type='trigger'", [{ name: 'update_active_name' }]);
  });
  if (backend === 'native') await recorder.step('V06 a concurrent view change offers Reload Latest before another Save', async () => {
    await viewEdit(); await frame.locator('#viewSelectSql').fill('SELECT id,name,score FROM contacts WHERE active=0');
    const external = new DatabaseSync(fixtures.primary);
    try { external.exec('DROP VIEW active_contacts; CREATE VIEW active_contacts AS SELECT id,name,score FROM contacts WHERE id=2'); }
    finally { external.close(); }
    await frame.locator('#btnSaveView').click();
    await contains(frame.locator('#viewValidationStatus'), 'changed outside this editor');
    await frame.locator('#btnReloadViewDefinition').click();
    if (backend === 'wasm') {
      const confirmation = page.getByRole('button', { name: 'Reload from Disk', exact: true });
      if (await confirmation.isVisible()) await confirmation.click();
      await frame.locator('#viewModal').waitFor({ state: 'hidden' });
      await viewEdit();
    } else await contains(frame.locator('#viewValidationStatus'), 'Latest definition loaded');
    assert.match(await frame.locator('#viewSelectSql').inputValue(), /id=2/);
    await modalClose();
    assert.deepEqual(readRows(fixtures.primary, 'SELECT id FROM active_contacts'), [{ id: 2 }]);
  });
  await recorder.step('E04 file size refusal retries in the same editor after the setting changes', async () => {
    await page.getByRole('treeitem', { name: 'limited.db', exact: true }).click();
    await waitForValue(async () => /maximum|maxFileSize|exceeds|too large/i.test(await visibleMessages()), true, 'configured file size refusal');
    frame = await viewerFrame(page);
    await frame.locator('#btnReloadDatabase').waitFor();
    assert.equal(await frame.locator('#btnOpenCreateTable').isDisabled(), true);
    await page.screenshot({ path: path.join(output, 'file-size-refused.png') });
    await command(page, 'Preferences: Open Settings (UI)');
    // This search uses Monaco's native EditContext, not an HTML text input.
    await page.locator('.settings-editor .monaco-editor').click();
    await page.keyboard.insertText('@id:sqliteExplorer.maxFileSize');
    const setting = page.getByLabel('sqliteExplorer.maxFileSize', { exact: true });
    await setting.fill('0'); await setting.press('Tab');
    await waitForValue(() => JSON.parse(fs.readFileSync(path.join(output, 'profile/User/settings.json'), 'utf8'))['sqliteExplorer.maxFileSize'], 0, 'saved valid size-limit configuration');
    const modalEditor = page.locator('.modal-editor-part[role="dialog"]');
    if (await modalEditor.isVisible()) {
      await modalEditor.getByRole('button', { name: 'Close Modal Editor (Escape)', exact: true }).click();
    } else {
      await page.locator('.tab.active').filter({ hasText: /^Settings$/ }).click();
      await page.keyboard.press(`${modifier}+W`);
    }
    await page.locator('.settings-editor').waitFor({ state: 'hidden' });
    await page.getByRole('tab').filter({ hasText: 'limited.db' }).click();
    frame = await viewerFrame(page);
    await frame.locator('#btnReloadDatabase').click();
    await frame.getByRole('button', { name: 'Open table size_guard', exact: true }).waitFor();
    await selectTable(frame, 'size_guard');
    await contains(frame.locator('#gridContainer'), 'BLOB');
    assert.equal(await frame.locator('#btnOpenCreateTable').isDisabled(), false);
    await page.screenshot({ path: path.join(output, 'file-size-recovered.png') });
    await closeEditor();
    frame = await openDatabase(page, 'limited.db'); await selectTable(frame, 'size_guard');
    await contains(frame.locator('#gridContainer'), 'BLOB');
  });
  await recorder.step('E05 configured double-click modes and sidebar pointer/keyboard sizing', async () => {
    await primary(); await selectTable(frame, 'contacts');
    const cell = () => frame.locator('tr.data-row[data-rowid="1"] td[data-colidx="1"]');
    for (const mode of ['modal', 'vscode', 'inline']) {
      await frame.locator('#btnOpenSettings').click();
      await frame.locator('.setting-extension[data-key="doubleClickBehavior"]').selectOption(mode);
      await contains(frame.locator('#statusText'), 'Updated doubleClickBehavior');
      await frame.locator('#settingsModal .modal-close').click();
      await cell().dblclick();
      if (mode === 'modal') {
        await frame.locator('#cellPreviewTextarea').waitFor();
        assert.equal(await frame.locator('#cellPreviewTextarea').inputValue(), 'Ada');
        await frame.locator('#btnCloseCellPreview').click();
      } else if (mode === 'vscode') {
        const text = page.locator('.monaco-editor.focused:visible .view-lines'); await contains(text, 'Ada');
        await closeEditor(); await primary(); await selectTable(frame, 'contacts');
      } else {
        const input = cell().locator('textarea'); await input.waitFor();
        assert.equal(await input.inputValue(), 'Ada'); await input.press('Escape');
      }
    }
    const separator = frame.getByRole('separator', { name: 'Resize sidebar', exact: true });
    await separator.focus(); await page.keyboard.press('Home');
    assert.equal(await separator.getAttribute('aria-valuenow'), '150');
    await page.keyboard.press('ArrowRight');
    assert.ok(Number(await separator.getAttribute('aria-valuenow')) > 150);
    const bounds = await separator.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
    await page.mouse.move(bounds.x + 70, bounds.y + bounds.height / 2); await page.mouse.up();
    assert.ok(Number(await separator.getAttribute('aria-valuenow')) > 200);
    await page.screenshot({ path: path.join(output, 'editor-modes-sidebar.png') });
  });
  await recorder.step('E06 Refresh Database command reads changes from the active file', async () => {
    await primary(); await selectTable(frame, 'markers');
    await contains(frame.locator('#gridContainer'), 'primary');
    await frame.locator('#tableNameLabel').click();
    await page.keyboard.press(`${modifier}+S`);
    const external = new DatabaseSync(fixtures.primary);
    try { external.exec("UPDATE markers SET name='refreshed by command'"); }
    finally { external.close(); }
    await command(page, 'SQLite Explorer: Refresh Database');
    frame = await viewerFrame(page); await selectTable(frame, 'markers');
    await contains(frame.locator('#gridContainer'), 'refreshed by command');
    assert.deepEqual(readRows(fixtures.primary, 'SELECT name FROM markers'), [{ name: 'refreshed by command' }]);
  });
} finally {
  await app.close();
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ backend,
    passed: recorder.results.filter(result => result.status === 'passed').length,
    failed: recorder.results.filter(result => result.status === 'failed').length }, null, 2));
}
