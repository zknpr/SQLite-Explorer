import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createFixtures, readRows } from './fixtures.mjs';
import { launchInstalledVsix, openDatabase, selectTable, waitForValue, createRecorder } from './driver.mjs';

const output = path.resolve(process.env.GUI_OUTPUT ?? `.tmp/gui-contention-${Date.now()}`);
const suppliedVsix = process.env.GUI_VSIX && path.resolve(process.env.GUI_VSIX);
assert.ok(suppliedVsix && fs.existsSync(suppliedVsix), 'GUI_VSIX must name a native platform VSIX');
assert.equal(fs.existsSync(output), false, 'use a fresh GUI_OUTPUT');
const workspace = path.join(output, 'workspace');
const fixtures = createFixtures(workspace);
const definitionSql = "SELECT sql FROM sqlite_schema WHERE type='view' AND name='active_contacts'";
const originalDefinition = readRows(fixtures.primary, definitionSql);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originalHash = hash(fixtures.primary);
const vsix = path.join(output, path.basename(suppliedVsix));
fs.copyFileSync(suppliedVsix, vsix);
fs.writeFileSync(path.join(output, 'frozen-vsix.json'), JSON.stringify({
  source: suppliedVsix, vsix, sha256: hash(vsix), bytes: fs.statSync(vsix).size
}, null, 2));
const { app, page } = await launchInstalledVsix({ vsix, output, workspace,
  executable: process.env.VSCODE_TEST_EXECUTABLE_PATH, version: process.env.GUI_VSCODE_VERSION ?? '1.110.0' });
const recorder = createRecorder(page, output);
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
let reader;
let frame;
const view = () => frame.getByRole('button', { name: 'Open view active_contacts', exact: true });
const showViews = async () => {
  if (!await frame.locator('#viewsList').isVisible()) await frame.locator('[data-section="views"]').click();
};
const drop = async () => {
  await showViews(); await view().hover();
  await frame.getByRole('button', { name: 'Drop view active_contacts', exact: true }).click();
  await page.getByRole('button', { name: 'Drop View', exact: true }).click();
};

try {
  await recorder.step('K01 a real external read transaction refuses Drop View without changing the database', async () => {
    frame = await openDatabase(page, 'qa.db'); await selectTable(frame, 'contacts');
    await frame.locator('#btnOpenSettings').click();
    assert.equal(await frame.locator('#setting_autoCommit').isDisabled(), true, 'this regression requires the native backend');
    await frame.locator('#settingsModal .modal-close').click();
    await showViews();
    reader = new DatabaseSync(fixtures.primary, { readOnly: true });
    reader.exec('BEGIN');
    assert.deepEqual(reader.prepare(definitionSql).all().map(row => ({ ...row })), originalDefinition);
    await drop();
    await waitForValue(async () => (await frame.locator('#statusText').textContent()).includes('database is locked'), true, 'visible lock refusal');
    assert.equal(await view().isVisible(), true);
    assert.equal(hash(fixtures.primary), originalHash, 'refused schema change preserves the main file');
    await page.screenshot({ path: path.join(output, '01-reader-refusal.png') });
  });
  await recorder.step('K02 releasing the reader permits a committed retry in the same open editor', async () => {
    reader.exec('ROLLBACK'); reader.close(); reader = undefined;
    await drop();
    await view().waitFor({ state: 'hidden' });
    // Start independent reads only after the UI reports completion. A stale
    // outer savepoint made this retry appear successful while keeping it uncommitted.
    await waitForValue(() => readRows(fixtures.primary, definitionSql), [], 'the retry committed to disk');
    assert.deepEqual(readRows(fixtures.primary, 'PRAGMA quick_check'), [{ quick_check: 'ok' }]);
    await page.screenshot({ path: path.join(output, '02-committed-retry.png') });
  });
  await recorder.step('K03 the committed retry supports persisted Undo and Redo', async () => {
    await frame.locator('#tableNameLabel').click(); await page.keyboard.press(`${modifier}+Z`);
    await showViews(); await view().waitFor();
    await waitForValue(() => readRows(fixtures.primary, definitionSql), originalDefinition, 'Undo restored the committed view');
    await frame.locator('#tableNameLabel').click();
    await page.keyboard.press(process.platform === 'win32' ? 'Control+Y' : `${modifier}+Shift+Z`);
    await view().waitFor({ state: 'hidden' });
    await waitForValue(() => readRows(fixtures.primary, definitionSql), [], 'Redo committed the deletion');
    assert.deepEqual(readRows(fixtures.primary, 'PRAGMA quick_check'), [{ quick_check: 'ok' }]);
    await page.screenshot({ path: path.join(output, '03-redo-committed.png') });
  });
} finally {
  reader?.close();
  await app.close();
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ backend: 'native',
    passed: recorder.results.filter(result => result.status === 'passed').length,
    failed: recorder.results.filter(result => result.status === 'failed').length }, null, 2));
}
