import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// An isolated audit checkout may use the coordinator's current helpers without
// copying or changing shared source files. Normal repository runs use siblings.
const helperUrl = process.env.GUI_HELPER_DIRECTORY
  ? pathToFileURL(path.join(path.resolve(process.env.GUI_HELPER_DIRECTORY), 'driver.mjs'))
  : new URL('./driver.mjs', import.meta.url);
const { launchInstalledVsix, command, openDatabase, selectTable, waitForValue, createRecorder } = await import(helperUrl.href);
const output = path.resolve(process.env.GUI_OUTPUT ?? `.tmp/progress-${Date.now()}`);
const suppliedVsix = process.env.GUI_VSIX && path.resolve(process.env.GUI_VSIX);
const expectedHash = process.env.GUI_EXPECTED_SHA256;
const backend = process.env.GUI_BACKEND ?? 'native';
const executable = process.env.VSCODE_TEST_EXECUTABLE_PATH;
const version = process.env.GUI_VSCODE_VERSION ?? '1.110.0';
assert.ok(suppliedVsix && fs.existsSync(suppliedVsix), 'GUI_VSIX must identify the exact package');
assert.match(expectedHash ?? '', /^[a-f0-9]{64}$/, 'GUI_EXPECTED_SHA256 must identify the frozen package');
assert.ok(executable, 'VSCODE_TEST_EXECUTABLE_PATH must identify the actual runtime');
assert.ok(['native', 'wasm'].includes(backend));
assert.equal(fs.existsSync(output), false, 'use a new GUI_OUTPUT directory');
fs.mkdirSync(path.join(output, 'inputs'), { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const vsix = path.join(output, 'inputs', path.basename(suppliedVsix));
fs.copyFileSync(suppliedVsix, vsix, fs.constants.COPYFILE_EXCL);
assert.equal(sha256(fs.readFileSync(vsix)), expectedHash);
fs.writeFileSync(path.join(output, 'artifact.json'), JSON.stringify({
  suppliedVsix, vsix, sha256: expectedHash, backend, frozenAt: new Date().toISOString(),
  helper: helperUrl.href, helperSha256: sha256(fs.readFileSync(helperUrl))
}, null, 2));

const rowCount = 100_000;
const workspace = path.join(output, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const database = path.join(workspace, 'progress.db');
const source = path.join(workspace, 'large-import.csv');
const retrySource = path.join(workspace, 'retry-import.csv');
const destination = path.join(workspace, 'cancel-export.csv');
const sentinel = Buffer.from('existing destination must survive a cancelled export\n');
fs.writeFileSync(destination, sentinel);
const payload = 'ordinary export text, with quotes "and" a newline\n'.repeat(24);
const seed = new DatabaseSync(database);
try {
  seed.exec('CREATE TABLE import_target(id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT);'
    + "INSERT INTO import_target VALUES(0,'kept','original');"
    + 'CREATE TABLE export_source(id INTEGER PRIMARY KEY, payload TEXT NOT NULL);BEGIN;');
  const statement = seed.prepare('INSERT INTO export_source VALUES(?,?)');
  for (let index = 1; index <= rowCount; index++) statement.run(index, payload);
  seed.exec('COMMIT;');
} finally { seed.close(); }
const sourceHandle = fs.openSync(source, 'wx');
try {
  fs.writeSync(sourceHandle, 'id,name,note\n');
  for (let index = 1; index <= rowCount; index++) fs.writeSync(sourceHandle, `${index},imported ${index},${'x'.repeat(512)}\n`);
} finally { fs.closeSync(sourceHandle); }
fs.writeFileSync(retrySource, 'id,name,note\n100001,retry one,first\n100002,retry two,second\n');
assert.ok(fs.statSync(source).size < 64 * 1024 * 1024, 'import must stay inside the existing 64 MiB limit');
assert.ok(fs.statSync(database).size < 200 * 1024 * 1024, 'database must stay inside the default file-size limit');
const readRows = sql => {
  const connection = new DatabaseSync(database, { readOnly: true });
  try { return connection.prepare(sql).all().map(row => ({ ...row })); }
  finally { connection.close(); }
};
const observations = { fixture: { rows: rowCount, databaseBytes: fs.statSync(database).size,
  importBytes: fs.statSync(source).size, exportedPayloadBytes: Buffer.byteLength(payload) * rowCount } };
fs.writeFileSync(path.join(output, 'fixture.json'), JSON.stringify(observations.fixture, null, 2));
const { app, page } = await launchInstalledVsix({ vsix, output, executable, version, workspace });
const recorder = createRecorder(page, output);
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(String(error)));
let frame;
const open = async table => { frame = await openDatabase(page, 'progress.db'); await selectTable(frame, table); };
const contains = (locator, value) => waitForValue(async () => (await locator.textContent()).replaceAll('\u00a0', ' ').includes(value), true, value);
const databaseIsSaved = () => page.locator('.tabs-container .tab[data-resource-name="progress.db"]')
  .evaluateAll(tabs => tabs.length > 0 && tabs.every(tab => !tab.classList.contains('dirty')));
const pick = async label => {
  await page.locator('.quick-input-widget .label-name').filter({ hasText: new RegExp(`^${label}$`) }).click();
};
const fileDialog = async file => {
  const dialog = page.locator('.quick-input-widget').filter({ has: page.getByRole('button', { name: 'OK', exact: true }) });
  await dialog.waitFor();
  const input = dialog.locator('input');
  await waitForValue(async () => path.isAbsolute(await input.inputValue()), true, 'initialized file dialog');
  await input.click(); await input.fill(file); await input.press('Enter');
};
const importToConfirmation = async file => {
  await command(page, 'SQLite Explorer: Import CSV or JSON');
  await pick('progress.db'); await pick('import_target'); await fileDialog(file);
  await pick('Use matching column names');
  await page.getByRole('button', { name: 'Import', exact: true }).waitFor();
};
const notification = title => page.locator('.notification-list-item').filter({ hasText: title });
const showNotifications = async () => {
  await command(page, 'Notifications: Show Notifications');
  await page.locator('.notifications-center').waitFor();
};
const queryMarker = async (sql, marker) => {
  await open('import_target'); await frame.locator('#btnOpenQuery').click();
  const editor = page.locator('.monaco-editor.focused:visible .view-lines');
  await contains(editor, 'SELECT 1 AS value;'); await editor.click();
  await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql);
  await command(page, 'SQLite Explorer: Run Query');
  await waitForValue(async () => (await page.locator('.monaco-editor:visible .view-lines').allTextContents())
    .join('\n').replaceAll('\u00a0', ' ').includes(marker), true, marker);
  await notification('Running SQL query').waitFor({ state: 'hidden' });
};
const exportTable = async (table, file, overwrite = false) => {
  await open(table); await frame.locator('#btnExport').click();
  await frame.locator('#exportFormat').selectOption('csv');
  await frame.locator('#btnSubmitExport').click(); await fileDialog(file);
  if (overwrite) {
    const replace = page.getByRole('button', { name: 'Replace', exact: true });
    const simple = page.locator('.quick-input-widget').filter({ hasText: 'Are you sure you want to overwrite it?' });
    await waitForValue(async () => await replace.isVisible() || await simple.isVisible(), true, 'actual overwrite confirmation');
    // The simple Save dialog and the extension's atomic export each confirm
    // replacement. Finish both before opening another workbench control.
    if (await simple.isVisible()) await simple.getByRole('button', { name: 'OK', exact: true }).click();
    const confirmation = page.getByText('Replace the existing file?', { exact: true });
    await confirmation.waitFor();
    await replace.click();
    await confirmation.waitFor({ state: 'hidden' });
  }
};
const temporaryExports = file => fs.readdirSync(workspace).filter(name => name.startsWith(`.${path.basename(file)}.`) && name.endsWith('.tmp'))
  .map(name => ({ file: path.join(workspace, name), bytes: fs.statSync(path.join(workspace, name)).size }));

try {
  await recorder.step('P00 installed backend and bounded private fixtures', async () => {
    await open('import_target'); await contains(frame.locator('#gridContainer'), 'kept');
    const logs = path.join(output, 'profile/logs');
    await waitForValue(() => fs.readdirSync(logs, { recursive: true }).filter(file => file.endsWith('SQLite Explorer.log'))
      .some(file => fs.readFileSync(path.join(logs, file), 'utf8').includes(`Using ${backend === 'native' ? 'native' : 'WebAssembly'} SQLite backend`)),
    true, 'actual installed backend identity');
  });
  await recorder.step('P01 cancel an import after rows are processed and verify rollback', async () => {
    const title = 'Importing into import_target';
    await notification(title).waitFor({ state: 'hidden' });
    await importToConfirmation(source); await page.getByRole('button', { name: 'Import', exact: true }).click();
    await showNotifications();
    const progress = notification(title);
    await progress.waitFor();
    await waitForValue(async () => {
      const message = await progress.innerText();
      const completed = Number(/(\d+)\s*\/\s*100000 rows/.exec(message)?.[1] ?? 0);
      observations.import = { messageBeforeCancel: message, completedBeforeCancel: completed };
      return completed > 0 && completed < rowCount;
    }, true, 'real import rows are processed before cancellation');
    await page.screenshot({ path: path.join(output, '01-import-running.png') });
    const started = Date.now(); await progress.getByRole('button', { name: 'Cancel', exact: true }).click();
    await progress.waitFor({ state: 'hidden', timeout: 30_000 });
    observations.import.cancelMs = Date.now() - started;
    // Cancelling the final progress item closes the notification center. The
    // completion message can arrive in a toast, so reopen its ordinary history.
    await showNotifications();
    await contains(page.locator('.notifications-center'), 'aborted');
    await page.keyboard.press('Escape'); await open('import_target');
    assert.equal(await databaseIsSaved(), true, 'cancelled import must leave the database save checkpoint clean');
    assert.deepEqual(readRows('SELECT id,name,note FROM import_target ORDER BY id'), [{ id: 0, name: 'kept', note: 'original' }]);
    await queryMarker("SELECT CASE WHEN count(*)=1 AND max(id)=0 THEN 'IMPORT ROLLBACK VERIFIED' ELSE 'IMPORT ROLLBACK FAILED' END AS outcome FROM import_target;", 'IMPORT ROLLBACK VERIFIED');
    observations.import.rollbackVerifiedThroughGuiQuery = true;
    await page.screenshot({ path: path.join(output, '02-import-rollback.png') });
  });
  await recorder.step('P02 a new import succeeds and persists after cancellation', async () => {
    await importToConfirmation(retrySource); await page.getByRole('button', { name: 'Import', exact: true }).click();
    await showNotifications(); await contains(page.locator('.notifications-center'), 'Imported 2 rows into import_target.');
    await notification('Importing into import_target').waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape'); await open('import_target');
    await contains(frame.locator('#gridContainer'), 'retry one');
    await page.keyboard.press(`${modifier}+S`);
    await waitForValue(() => readRows('SELECT id,name FROM import_target ORDER BY id'),
      [{ id: 0, name: 'kept' }, { id: 100001, name: 'retry one' }, { id: 100002, name: 'retry two' }], 'retry import persisted', 30_000);
    await waitForValue(databaseIsSaved, true, 'saved retry checkpoint');
  });
  await recorder.step('P03 cancel an export after output starts and preserve its destination', async () => {
    const title = 'Exporting "export_source"';
    await notification(title).waitFor({ state: 'hidden' });
    await exportTable('export_source', destination, true);
    await showNotifications(); const progress = notification(title); await progress.waitFor();
    await waitForValue(() => {
      const temporary = temporaryExports(destination);
      observations.export = { temporaryBeforeCancel: temporary };
      return temporary.some(file => file.bytes > 4096);
    }, true, 'export writes data rows to its private temporary output');
    assert.deepEqual(fs.readFileSync(destination), sentinel, 'destination is unchanged while exporting');
    await page.screenshot({ path: path.join(output, '03-export-running.png') });
    const started = Date.now(); await progress.getByRole('button', { name: 'Cancel', exact: true }).click();
    await progress.waitFor({ state: 'hidden', timeout: 30_000 });
    observations.export.cancelMs = Date.now() - started;
    await showNotifications();
    await contains(page.locator('.notifications-center'), 'Export cancelled');
    assert.deepEqual(fs.readFileSync(destination), sentinel, 'cancelled export preserves every destination byte');
    assert.deepEqual(temporaryExports(destination), [], 'cancelled export removes its sibling temporary output');
    observations.export.destinationSha256 = sha256(fs.readFileSync(destination));
    await page.keyboard.press('Escape');
    await queryMarker("SELECT CASE WHEN count(*)=100000 THEN 'EXPORT CONNECTION REUSED' ELSE 'EXPORT SOURCE CHANGED' END AS outcome FROM export_source;", 'EXPORT CONNECTION REUSED');
    await page.screenshot({ path: path.join(output, '04-export-cancelled.png') });
  });
  await recorder.step('P04 a new export succeeds after cancellation with no temporary output left', async () => {
    const retry = path.join(workspace, 'retry-export.csv');
    await exportTable('import_target', retry);
    await waitForValue(() => fs.existsSync(retry), true, 'retry export committed');
    const csv = fs.readFileSync(retry, 'utf8');
    assert.match(csv, /^id,name,note\r?\n/);
    assert.match(csv, /100001,retry one,first/); assert.match(csv, /100002,retry two,second/);
    assert.deepEqual(temporaryExports(retry), []);
    assert.deepEqual(fs.readFileSync(destination), sentinel);
    assert.deepEqual(browserErrors, []);
    await page.screenshot({ path: path.join(output, '05-export-retry.png') });
  });
} finally {
  await app.close();
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ backend, vsixSha256: expectedHash,
    passed: recorder.results.filter(result => result.status === 'passed').length,
    failed: recorder.results.filter(result => result.status === 'failed').length,
    observations, browserErrors
  }, null, 2));
}
