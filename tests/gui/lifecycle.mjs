import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { _electron } from 'playwright-core';
import { createFixtures, readRows } from './fixtures.mjs';
import { launchInstalledVsix, command, viewerFrame, openDatabase, selectTable, waitForValue, createRecorder } from './driver.mjs';

const output = path.resolve(process.env.GUI_OUTPUT ?? `.tmp/gui-lifecycle-${process.platform}-${Date.now()}`);
const suppliedVsix = process.env.GUI_VSIX && path.resolve(process.env.GUI_VSIX);
const executable = process.env.VSCODE_TEST_EXECUTABLE_PATH;
const backend = process.env.GUI_BACKEND ?? 'native';
const version = process.env.GUI_VSCODE_VERSION ?? '1.110.0';
const requested = new Set((process.env.GUI_CASES ?? `save-as,hot-exit,read-only,wal-transition,close-active-query${backend === 'wasm' ? ',auto-save,external-replacement' : ''}`).split(','));
if (!suppliedVsix || !fs.existsSync(suppliedVsix)) throw new Error('Set GUI_VSIX to the exact packaged extension to verify.');
if (!executable) throw new Error('Set VSCODE_TEST_EXECUTABLE_PATH to the exact VS Code executable.');
if (!['native', 'wasm'].includes(backend)) throw new Error('GUI_BACKEND must be native or wasm.');
for (const name of requested) if (!['save-as', 'hot-exit', 'read-only', 'auto-save', 'external-replacement', 'wal-transition', 'close-active-query'].includes(name)) throw new Error(`Unknown GUI_CASES entry: ${name}`);
if (fs.existsSync(output)) throw new Error(`Use a new GUI_OUTPUT directory: ${output}`);
fs.mkdirSync(output, { recursive: true });
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const vsix = path.join(output, path.basename(suppliedVsix));
fs.copyFileSync(suppliedVsix, vsix);
fs.writeFileSync(path.join(output, 'frozen-vsix.json'), JSON.stringify({
  source: suppliedVsix, vsix, sha256: hash(vsix), bytes: fs.statSync(vsix).size,
  frozenAt: new Date().toISOString(), backend, executable, version
}, null, 2));

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const results = [];
const query = 'SELECT name FROM contacts WHERE id=1';
const sourceName = 'Ada source edit';
const freshName = 'Ada fresh target edit';
const existingName = 'Ada existing target edit';

async function runCase(name, body) {
  if (!requested.has(name)) return;
  const directory = path.join(output, name);
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(directory, { recursive: true });
  const fixtures = createFixtures(workspace);
  let app;
  let applicationProcess;
  let page;
  let frame;
  let recorder;
  const environment = () => {
    const env = { ...process.env };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_IPC_HOOK', 'NODE_OPTIONS']) delete env[key];
    return env;
  };
  const context = {
    directory, workspace, fixtures,
    get app() { return app; }, get page() { return page; }, get frame() { return frame; },
    async open(filename = 'qa.db', table = 'contacts') {
      frame = await openDatabase(page, filename);
      await selectTable(frame, table);
      return frame;
    },
    async activeViewer() { frame = await viewerFrame(page); return frame; },
    cell(row = 1, column = 1) { return frame.locator(`tr.data-row[data-rowid="${row}"] td[data-colidx="${column}"]`); },
    async contains(locator, expected) {
      await waitForValue(async () => (await locator.textContent()).includes(expected), true, expected);
    },
    async edit(value) {
      const cell = context.cell();
      await cell.dblclick();
      const input = cell.locator('textarea');
      await input.fill(value); await input.press('Enter');
      await context.contains(cell, value);
    },
    disk(file, expected) { return waitForValue(() => readRows(file, query), [{ name: expected }], `${path.basename(file)} independent disk value`); },
    async save() { await page.keyboard.press(`${modifier}+S`); },
    async history(direction) {
      // Focus the database before dispatching its normal workbench shortcut.
      // A command palette can still be restoring focus after a prior Undo.
      await context.cell().click();
      const redo = process.platform === 'win32' ? 'Control+Y' : `${modifier}+Shift+Z`;
      await page.keyboard.press(direction === 'Undo' ? `${modifier}+Z` : redo);
    },
    async saveAs(file, expected, { replace = true } = {}) {
      const existing = fs.existsSync(file);
      await page.keyboard.press(`${modifier}+Shift+S`);
      const input = page.locator('.quick-input-widget input');
      await input.waitFor(); await input.fill(file); await input.press('Enter');
      if (existing) {
        // VS Code's simple save picker and the extension's replacement warning
        // are separate confirmations. Consume each once, in their actual order.
        const picker = page.locator('.quick-input-widget');
        await context.contains(picker, 'Are you sure you want to overwrite it?');
        await picker.getByRole('button', { name: 'OK', exact: true }).click();
        const confirm = page.getByRole('button', { name: 'Replace', exact: true });
        await confirm.waitFor();
        await page.getByRole('dialog').getByRole('button', { name: replace ? 'Replace' : 'Cancel', exact: true }).click();
        await confirm.waitFor({ state: 'hidden' });
        if (!replace) return;
      }
      await waitForValue(() => fs.existsSync(file), true, 'Save As created its destination');
      await context.disk(file, expected);
      await page.locator('.tabs-container .tab.active').filter({ hasText: path.basename(file) }).waitFor();
      await context.activeViewer(); await selectTable(frame, 'contacts');
      await context.contains(context.cell(), expected);
    },
    screenshot(label) { return page.screenshot({ path: path.join(directory, `${label}.png`) }); },
    async verifyBackend() {
      await frame.locator('#btnOpenSettings').click();
      const autoCommit = frame.locator('#setting_autoCommit');
      await autoCommit.waitFor();
      assert.equal(await autoCommit.isDisabled(), backend === 'native', 'installed backend settings capability');
      assert.equal(await autoCommit.isChecked(), backend === 'native', 'never setting applies to the WASM backend');
      await frame.locator('#settingsModal .modal-cancel, #settingsModal .modal-close').first().click();
    },
    async configureHotExit() {
      const settingsFile = path.join(directory, 'profile/User/settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      settings['files.hotExit'] = 'onExitAndWindowClose';
      settings['window.restoreWindows'] = 'all';
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
      fs.writeFileSync(path.join(directory, 'hot-exit-settings.json'), JSON.stringify(settings, null, 2));
      // Settings are changed through the private profile's ordinary on-disk
      // configuration, then observed through the workbench settings editor.
      await command(page, 'Preferences: Open User Settings (JSON)');
      await page.locator('.monaco-editor.focused:visible .view-lines').waitFor();
      // Monaco mounts only visible lines; the appended setting can be below
      // the viewport even when the profile has already loaded it correctly.
      await page.keyboard.press(`${modifier}+End`);
      await context.contains(page.locator('.monaco-editor.focused:visible .view-lines'), 'onExitAndWindowClose');
      await page.keyboard.press(`${modifier}+W`);
      await context.activeViewer();
      await selectTable(frame, 'contacts');
    },
    async quitAndRestart() {
      const priorProcess = applicationProcess;
      const priorPid = priorProcess.pid;
      const closed = app.waitForEvent('close', { timeout: 20_000 });
      if (process.platform === 'darwin') await page.keyboard.press('Meta+Q');
      else if (process.platform === 'linux') await page.keyboard.press('Control+Q');
      else {
        // Exit is a real File-menu command, not a Command Palette entry.
        await page.getByRole('menuitem', { name: 'File', exact: true }).click();
        const exit = page.getByRole('menuitem', { name: /^Exit(?:\s|$)/ });
        await exit.waitFor();
        // Pointer delivery through the workbench/webview boundary left this
        // menu open in the preserved baseline. Exercise its real keyboard path.
        await page.keyboard.press('End');
        await waitForValue(() => exit.evaluate(element => element === document.activeElement
          || element.contains(document.activeElement)), true, 'File menu Exit has keyboard focus');
        await page.keyboard.press('Enter');
      }
      await closed;
      await waitForValue(() => priorProcess.exitCode !== null, true, 'the isolated application process exited');
      const backupRoot = path.join(directory, 'profile/Backups');
      const backupFiles = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot, { recursive: true })
        .filter(file => fs.statSync(path.join(backupRoot, file)).isFile())
        .map(file => ({ path: file, bytes: fs.statSync(path.join(backupRoot, file)).size, sha256: hash(path.join(backupRoot, file)) })) : [];
      const quitEvidence = { priorPid, exited: true, backupFiles,
        quitAction: process.platform === 'darwin' ? 'Meta+Q' : process.platform === 'linux' ? 'Control+Q' : 'File menu: Exit' };
      fs.writeFileSync(path.join(directory, 'quit-evidence.json'), JSON.stringify(quitEvidence, null, 2));
      app = await _electron.launch({ executablePath: executable, env: environment(), bypassCSP: false, timeout: 30_000,
        args: [workspace, '--user-data-dir', path.join(directory, 'profile'), '--extensions-dir', path.join(directory, 'extensions'),
          '--disable-workspace-trust', '--disable-updates', '--skip-release-notes', '--skip-welcome'] });
      applicationProcess = app.process();
      page = await app.firstWindow(); page.setDefaultTimeout(15_000);
      await page.locator('.monaco-workbench').waitFor();
      frame = await viewerFrame(page, 30_000);
      assert.notEqual(applicationProcess.pid, priorPid, 'hot-exit restoration must use a new application process');
      // No openDatabase call here: the persisted editor must restore itself.
      await page.locator('.tabs-container .tab.active').filter({ hasText: 'qa.db' }).waitFor();
      fs.writeFileSync(path.join(directory, 'quit-evidence.json'), JSON.stringify({ ...quitEvidence,
        restartedPid: applicationProcess.pid, automaticallyRestoredEditor: 'qa.db'
      }, null, 2));
    }
  };
  try {
    ({ app, page } = await launchInstalledVsix({ vsix, output: directory, workspace, executable, version }));
    applicationProcess = app.process();
    recorder = createRecorder({
      screenshot: options => page.screenshot(options),
      locator: (...args) => page.locator(...args)
    }, directory);
    await body(context, recorder.step);
    results.push({ name, status: 'passed', stages: recorder.results });
  } catch (error) {
    let diagnostics;
    try {
      diagnostics = { page: await page.locator('body').innerText(), frames: [] };
      for (const candidate of page.frames()) if (candidate.url().startsWith('vscode-webview://')) {
        diagnostics.frames.push({ url: candidate.url(), text: await candidate.locator('body').innerText() });
      }
      fs.writeFileSync(path.join(directory, 'failure-ui.json'), JSON.stringify(diagnostics, null, 2));
    } catch (captureError) { diagnostics = String(captureError); }
    results.push({ name, status: 'failed', error: String(error), stages: recorder?.results ?? [], diagnostics: typeof diagnostics === 'string' ? diagnostics : 'failure-ui.json' });
    console.error(`${name}: ${error}`);
  } finally {
    if (app && applicationProcess?.exitCode === null) await app.close();
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({
      backend, vsixSha256: hash(vsix), executable, version,
      passed: results.filter(result => result.status === 'passed').length,
      failed: results.filter(result => result.status === 'failed').length, cases: results
    }, null, 2));
  }
}

await runCase('save-as', async (context, step) => {
  const fresh = path.join(context.workspace, 'fresh-target.db');
  const source = context.fixtures.primary;
  const existing = context.fixtures.secondary;
  await step('A01 actual native or WASM viewer and source edit', async () => {
    await context.open(); await context.verifyBackend(); await context.edit(sourceName);
    if (backend === 'native') await context.disk(source, sourceName);
    else await context.disk(source, 'Ada');
  });
  await step('A02 Save As fresh target and independent document ownership', async () => {
    const originalHash = hash(source);
    await context.saveAs(fresh, sourceName);
    assert.equal(hash(source), originalHash, 'Save As must preserve the original file bytes');
    assert.notEqual(fs.statSync(fresh).ino, fs.statSync(source).ino, 'Save As creates an independent file');
    await context.edit(freshName); await context.save(); await context.disk(fresh, freshName);
    assert.equal(hash(source), originalHash, 'editing the new document must preserve original bytes');
    await context.screenshot('02-fresh-target-owner');
  });
  await step('A03 Save As existing open target, replacement, and ownership', async () => {
    await context.open('second.db', 'markers');
    await context.contains(context.frame.locator('#gridContainer'), 'secondary');
    await context.open('fresh-target.db');
    const freshHash = hash(fresh);
    const existingHash = hash(existing);
    await context.saveAs(existing, freshName, { replace: false });
    assert.equal(hash(existing), existingHash, 'cancelling replacement preserves destination bytes');
    assert.equal(hash(fresh), freshHash, 'cancelling replacement preserves source bytes');
    await context.page.locator('.tabs-container .tab.active').filter({ hasText: 'fresh-target.db' }).waitFor();
    await context.activeViewer(); await selectTable(context.frame, 'contacts');
    await context.contains(context.cell(), freshName);
    await context.screenshot('03-existing-target-cancelled');
    await context.saveAs(existing, freshName);
    assert.deepEqual(readRows(existing, 'SELECT name FROM markers'), [{ name: 'primary' }]);
    await context.edit(existingName); await context.save(); await context.disk(existing, existingName);
    assert.equal(hash(fresh), freshHash, 'editing the replaced target must preserve the previous document bytes');
    await context.open('qa.db');
    await context.contains(context.cell(), backend === 'native' ? sourceName : 'Ada');
    await context.open('fresh-target.db'); await context.contains(context.cell(), freshName);
    await context.open('second.db'); await context.contains(context.cell(), existingName);
    await context.screenshot('03-existing-target-owner');
  });
});

await runCase('hot-exit', async (context, step) => {
  const marker = `Hot exit ${backend} restored`;
  const firstMarker = `Hot exit ${backend} first edit`;
  await step('H01 dirty custom editor with explicit private hot-exit settings', async () => {
    await context.open(); await context.verifyBackend(); await context.configureHotExit();
    await context.edit(firstMarker); await context.edit(marker);
    await context.page.locator('.tabs-container .tab.active.dirty').waitFor();
    await context.disk(context.fixtures.primary, backend === 'native' ? marker : 'Ada');
    await context.screenshot('01-before-quit');
  });
  await step('H02 real app quit and automatic custom-editor restoration', async () => {
    await context.quitAndRestart();
    await selectTable(context.frame, 'contacts');
    await context.contains(context.cell(), marker);
    await context.page.locator('.tabs-container .tab.active.dirty').waitFor();
    await context.disk(context.fixtures.primary, backend === 'native' ? marker : 'Ada');
    await context.screenshot('02-after-restart');
  });
  await step('H03 restored Undo, Redo, Save, and independent disk readback', async () => {
    await context.history('Undo'); await context.contains(context.cell(), firstMarker);
    await context.history('Undo'); await context.contains(context.cell(), 'Ada');
    await context.disk(context.fixtures.primary, 'Ada');
    await context.history('Redo'); await context.contains(context.cell(), firstMarker);
    await context.history('Redo'); await context.contains(context.cell(), marker);
    await context.save(); await context.disk(context.fixtures.primary, marker);
    await context.screenshot('03-restored-history');
  });
});

await runCase('read-only', async (context, step) => {
  const readonly = context.fixtures.readonly;
  const originalHash = hash(readonly);
  await step('R01 OS read-only detection and disabled write controls', async () => {
    // On Windows this sets the file's read-only attribute. Verify its actual
    // effect with SQLite; mode bits alone are not evidence of OS enforcement.
    if (process.platform === 'win32') fs.chmodSync(readonly, 0o444);
    assert.equal(fs.statSync(readonly).mode & 0o222, 0);
    assert.throws(() => fs.accessSync(readonly, fs.constants.W_OK));
    const probe = new DatabaseSync(readonly);
    let refused;
    try {
      probe.exec('BEGIN');
      try { probe.exec('PRAGMA user_version=19'); }
      catch (error) { refused = { code: error.code, errcode: error.errcode, message: error.message }; }
      finally { probe.exec('ROLLBACK'); }
    } finally { probe.close(); }
    assert.equal(refused?.errcode & 0xff, 8, 'an actual SQLite write must report SQLITE_READONLY');
    assert.equal(hash(readonly), originalHash);
    fs.writeFileSync(path.join(context.directory, 'readonly-enforcement.json'), JSON.stringify({
      file: readonly, mode: fs.statSync(readonly).mode, refused, sha256: originalHash, bytesPreserved: true
    }, null, 2));
    await context.open('readonly.db');
    for (const selector of ['#btnAddRow', '#btnAddColumn', '#btnDeleteRows', '#btnOpenCreateTable', '#btnOpenCreateView']) {
      assert.equal(await context.frame.locator(selector).isDisabled(), true, `${selector} must reject writes`);
    }
    await context.cell().dblclick();
    assert.equal(await context.cell().locator('textarea').count(), 0, 'inline edit must not open for a read-only database');
    assert.equal(hash(readonly), originalHash);
    await context.screenshot('01-read-only-controls');
  });
  await step('R02 table export remains available for an OS read-only database', async () => {
    await context.frame.locator('#btnExport').click();
    await context.frame.locator('#exportFormat').selectOption('json');
    await context.frame.locator('#btnSubmitExport').click();
    const exported = path.join(context.workspace, 'readonly-contacts.json');
    const input = context.page.locator('.quick-input-widget input');
    await input.waitFor(); await input.fill(exported); await input.press('Enter');
    await waitForValue(() => fs.existsSync(exported), true, 'actual table export destination');
    assert.equal(JSON.parse(fs.readFileSync(exported, 'utf8'))[0].name, 'Ada');
    assert.equal(hash(readonly), originalHash);
  });
  await step('R03 SQL read and result export retain read-only document ownership', async () => {
    await context.frame.locator('#btnOpenQuery').click();
    const editor = context.page.locator('.monaco-editor.focused:visible .view-lines');
    await editor.waitFor(); await editor.click();
    await context.page.keyboard.press(`${modifier}+A`);
    await context.page.keyboard.insertText('SELECT name AS readonly_marker FROM contacts WHERE id = 1;');
    await command(context.page, 'SQLite Explorer: Run Query');
    await waitForValue(async () => (await context.page.locator('.monaco-editor:visible .view-lines').allTextContents()).join('\n').includes('Ada'), true, 'SQL result from the read-only document');
    await context.page.locator('.monaco-editor.focused:visible .view-lines').waitFor();
    await command(context.page, 'SQLite Explorer: Export Query Results');
    const exported = path.join(context.workspace, 'readonly-query.csv');
    const input = context.page.locator('.quick-input-widget input');
    await input.waitFor(); await input.fill(exported); await input.press('Enter');
    await waitForValue(() => fs.existsSync(exported), true, 'actual SQL result export destination');
    assert.match(fs.readFileSync(exported, 'utf8'), /Ada/);
    assert.equal(hash(readonly), originalHash);
    await context.screenshot('03-read-only-query-export');
  });
});

await runCase('auto-save', async (context, step) => {
  assert.equal(backend, 'wasm', 'The inactive-document save lane verifies WASM instant commit.');
  const page = context.page;
  const expected = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const rows = () => readRows(context.fixtures.primary, 'SELECT id FROM import_target ORDER BY id');
  const databaseTab = page.locator('.tabs-container .tab').filter({ hasText: 'qa.db' });
  const dirty = () => databaseTab.getAttribute('class').then(value => value.includes('dirty'));
  const pick = async label => {
    await page.locator('.quick-input-widget .label-name').filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).click();
  };
  const autoCommit = async enabled => {
    await context.frame.locator('#btnOpenSettings').click();
    await context.frame.locator('#setting_autoCommit').setChecked(enabled);
    await waitForValue(() => JSON.parse(fs.readFileSync(path.join(context.directory, 'profile/User/settings.json')))
      ['sqliteExplorer.instantCommit'], enabled ? 'always' : 'never', 'the setting is persisted in the private profile');
    await context.frame.locator('#settingsModal .modal-cancel, #settingsModal .modal-close').first().click();
  };
  await step('S01 WASM instant commit with another database open', async () => {
    await context.open(); await context.verifyBackend(); await autoCommit(true);
    await context.open('second.db');
  });
  await step('S02 import saves its inactive database and leaves the dirty preview selected', async () => {
    await command(page, 'SQLite Explorer: Import CSV or JSON'); await pick('qa.db'); await pick('import_target');
    const dialog = page.locator('.quick-input-widget').filter({ has: page.getByRole('button', { name: 'OK', exact: true }) });
    await dialog.waitFor();
    const input = dialog.locator('input');
    await waitForValue(async () => path.isAbsolute(await input.inputValue()), true, 'import source dialog is initialized');
    await input.fill(context.fixtures.csv); await input.press('Enter');
    await pick('Use matching column names');
    const importButton = page.getByRole('button', { name: 'Import', exact: true });
    await importButton.waitFor();
    const preview = page.locator('.tabs-container .tab.active');
    await waitForValue(async () => (await preview.innerText()).includes('Untitled'), true, 'the import preview is selected');
    const previewName = await preview.innerText();
    assert.match(previewName, /Untitled/);
    await importButton.click();
    await waitForValue(rows, expected, 'the inactive database is persisted');
    await waitForValue(dirty, false, 'VS Code marks the database save checkpoint clean');
    assert.equal(await preview.innerText(), previewName, 'targeted save must preserve the selected preview');
    assert.match(await preview.getAttribute('class'), /dirty/, 'the unrelated preview must remain unsaved');
    assert.deepEqual(readRows(context.fixtures.secondary, 'SELECT id FROM import_target ORDER BY id'), [{ id: 1 }]);
    await context.screenshot('02-background-import-saved');
  });
  await step('S03 imported batch Undo and Redo auto-save through the custom-editor lifecycle', async () => {
    await context.open('qa.db', 'import_target');
    await context.history('Undo'); await waitForValue(rows, [{ id: 1 }], 'Undo is persisted');
    await waitForValue(dirty, false, 'Undo has a saved checkpoint');
    await context.history('Redo'); await waitForValue(rows, expected, 'Redo is persisted');
    await waitForValue(dirty, false, 'Redo has a saved checkpoint');
    await context.screenshot('03-auto-saved-undo-redo');
  });
  await step('S04 manual Undo stays dirty and File Revert returns to the last automatic save', async () => {
    await autoCommit(false);
    await context.history('Undo');
    await waitForValue(dirty, true, 'manual Undo dirties the database');
    assert.deepEqual(rows(), expected, 'manual Undo must preserve the last saved bytes');
    await waitForValue(() => context.frame.locator('tr.data-row').count(), 1, 'manual Undo is visible');
    await command(page, 'File: Revert File');
    await waitForValue(dirty, false, 'File Revert clears the unsaved Undo');
    await waitForValue(() => context.frame.locator('tr.data-row').count(), 3, 'File Revert restores the automatic-save checkpoint');
    assert.deepEqual(rows(), expected);
    await context.screenshot('04-reverted-to-automatic-save');
  });
});

await runCase('external-replacement', async (context, step) => {
  assert.equal(backend, 'wasm', 'This lane verifies the small in-memory WASM save path.');
  const oldOverlay = 'Uncommitted before external replacement';
  const external = 'Independent external replacement';
  let replacementHash;
  let replacementInode;
  await step('E01 private in-memory WASM edit and independent atomic file replacement', async () => {
    assert.ok(fs.statSync(context.fixtures.primary).size < 256 * 1024, 'fixture must use the small in-memory path');
    await context.open(); await context.verifyBackend(); await context.edit(oldOverlay);
    await context.disk(context.fixtures.primary, 'Ada');
    const incoming = path.join(context.workspace, 'incoming.db');
    fs.copyFileSync(context.fixtures.secondary, incoming);
    const independent = new DatabaseSync(incoming);
    try { independent.prepare('UPDATE contacts SET name=? WHERE id=1').run(external); }
    finally { independent.close(); }
    replacementHash = hash(incoming);
    replacementInode = fs.statSync(incoming).ino;
    fs.renameSync(incoming, context.fixtures.primary);
    assert.equal(hash(context.fixtures.primary), replacementHash);
    await context.disk(context.fixtures.primary, external);
    await context.screenshot('01-independent-replacement');
  });
  await step('E02 Save reports the conflict and preserves all replacement bytes', async () => {
    await context.save();
    await command(context.page, 'Notifications: Show Notifications');
    const notifications = context.page.locator('.notifications-center');
    await notifications.waitFor();
    const activeTab = context.page.locator('.tabs-container .tab.active');
    await waitForValue(async () => !((await activeTab.getAttribute('class')).includes('dirty'))
      || /failed to save|reload database|database.+(?:changed|replaced)/i.test(await notifications.innerText()),
    true, 'the Save attempt has completed or reported its conflict');
    const result = {
      replacementHash, afterSaveHash: hash(context.fixtures.primary), replacementInode,
      afterSaveInode: fs.statSync(context.fixtures.primary).ino,
      afterSaveRows: readRows(context.fixtures.primary, query),
      afterSaveMarkers: readRows(context.fixtures.primary, 'SELECT name FROM markers'),
      notifications: await notifications.innerText(), dirty: (await activeTab.getAttribute('class')).includes('dirty')
    };
    fs.writeFileSync(path.join(context.directory, 'save-attempt.json'), JSON.stringify(result, null, 2));
    await context.screenshot('02-after-save-attempt');
    assert.equal(result.afterSaveHash, replacementHash, 'Save must preserve the independently replaced database bytes');
    assert.equal(result.afterSaveInode, replacementInode, 'refused Save must preserve the replacement inode');
    assert.equal(result.dirty, true, 'refused Save must keep the unsaved document dirty');
    assert.deepEqual(result.afterSaveRows, [{ name: external }]);
    assert.match(result.notifications, /failed to save|reload database|database.+(?:changed|replaced)/i);
  });
  await step('E03 Save As recovers the unsaved image and repeated saves preserve the external database', async () => {
    await context.page.keyboard.press('Escape');
    await context.contains(context.cell(), oldOverlay);
    const recovery = path.join(context.workspace, 'recovered.db');
    await context.cell().click(); await context.saveAs(recovery, oldOverlay);
    for (const value of ['Recovered image first save', 'Recovered image second save']) {
      await context.edit(value); await context.save(); await context.disk(recovery, value);
      assert.equal(hash(context.fixtures.primary), replacementHash, 'recovery must preserve all replacement bytes');
    }
    await context.open('qa.db'); await context.contains(context.cell(), external);
    assert.equal(hash(context.fixtures.primary), replacementHash);
    await context.screenshot('03-recovered-image-and-external-database');
  });
});

await runCase('wal-transition', async (context, step) => {
  const external = new DatabaseSync(context.fixtures.primary);
  let externalClosed = false;
  let expected = 'Committed in the external WAL';
  try {
    external.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    external.prepare('UPDATE contacts SET name=? WHERE id=1').run(expected);
    assert.ok(fs.statSync(context.fixtures.primary + '-wal').size > 32);
    const mainHash = hash(context.fixtures.primary);
    const walHash = hash(context.fixtures.primary + '-wal');
    await step('W01 live WAL is readable natively and visibly protected on WASM', async () => {
      // Wait for both newly created sidecars to enter Explorer before clicking:
      // inserting them during a double-click can move another file under it.
      await context.page.getByRole('treeitem', { name: 'qa.db-wal', exact: true }).waitFor();
      await context.page.getByRole('treeitem', { name: 'qa.db-shm', exact: true }).waitFor();
      await context.open();
      if (backend === 'wasm') {
        await waitForValue(() => context.frame.locator('#btnAddRow').isDisabled(), true, 'WAL write protection');
        await waitForValue(async () => (await context.page.locator('body').innerText()).includes('WAL changes'), true, 'visible incomplete-snapshot explanation');
        await context.cell().dblclick();
        assert.equal(await context.cell().locator('textarea').count(), 0);
        assert.equal(hash(context.fixtures.primary), mainHash);
        assert.equal(hash(context.fixtures.primary + '-wal'), walHash);
      } else {
        await context.contains(context.cell(), expected);
        assert.equal(await context.frame.locator('#btnAddRow').isDisabled(), false);
        expected = 'Native edit with an external WAL connection';
        await context.edit(expected); await context.disk(context.fixtures.primary, expected);
      }
      await context.screenshot('01-live-wal');
    });
    await step('W02 checkpoint and Reload restore current writable rows', async () => {
      const checkpoint = external.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      assert.equal(checkpoint.busy, 0, 'independent checkpoint completed');
      external.close(); externalClosed = true;
      assert.ok(!fs.existsSync(context.fixtures.primary + '-wal') || fs.statSync(context.fixtures.primary + '-wal').size <= 32);
      await context.frame.locator('#btnReload').click();
      if (backend === 'native') {
        await context.page.getByRole('button', { name: 'Reload from Disk', exact: true }).click();
      }
      await context.activeViewer(); await selectTable(context.frame, 'contacts');
      await context.contains(context.cell(), expected);
      await waitForValue(() => context.frame.locator('#btnAddRow').isDisabled(), false, 'writable after checkpoint and reload');
      await context.edit('Saved after WAL checkpoint and reload');
      await context.cell().click(); await context.save();
      await context.disk(context.fixtures.primary, 'Saved after WAL checkpoint and reload');
      await context.screenshot('02-writable-after-checkpoint');
    });
  } finally {
    if (!externalClosed) external.close();
  }
});

await runCase('close-active-query', async (context, step) => {
  const page = context.page;
  const progress = page.locator('.notification-list-item').filter({ hasText: 'Running SQL query' });
  const enterSql = async sql => {
    const editor = page.locator('.monaco-editor.focused:visible .view-lines');
    await editor.waitFor(); await editor.click();
    await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql);
  };
  await step('D01 closing a database aborts its running query before the timeout', async () => {
    await context.open('second.db', 'markers');
    await context.open('qa.db', 'markers');
    await context.frame.locator('#btnOpenQuery').click();
    await enterSql('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n;');
    await command(page, 'SQLite Explorer: Run Query');
    await progress.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
    const databaseTab = page.locator('.tabs-container .tab').filter({ hasText: /^qa\.db$/ });
    const started = performance.now();
    await databaseTab.click(); await page.keyboard.press(`${modifier}+W`);
    await waitForValue(() => databaseTab.count(), 0, 'the database editor closed');
    await waitForValue(() => progress.count(), 0, 'closed database query progress cleared');
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 10_000, 'closing the database must abort before the 30-second query deadline');
    fs.writeFileSync(path.join(context.directory, 'query-close.json'), JSON.stringify({ elapsedMs, databaseTabClosed: true, queryProgressClosed: true }, null, 2));
    assert.deepEqual(readRows(context.fixtures.primary, 'SELECT name FROM markers'), [{ name: 'primary' }]);
    await context.screenshot('01-query-owner-closed');
  });
  await step('D02 the remaining database can run and export a fresh query', async () => {
    await context.open('second.db', 'markers');
    await context.frame.locator('#btnOpenQuery').click();
    await enterSql('SELECT name AS connection_after_close FROM markers;');
    await command(page, 'SQLite Explorer: Run Query');
    const result = page.locator('.monaco-editor:visible .view-lines').filter({ hasText: 'secondary' });
    await result.waitFor(); await result.click();
    await waitForValue(() => progress.count(), 0, 'fresh query completed');
    await command(page, 'SQLite Explorer: Export Query Results');
    const destination = path.join(context.workspace, 'after-close.csv');
    const dialog = page.locator('.quick-input-widget');
    const input = dialog.locator('input'); await input.waitFor();
    await waitForValue(async () => path.isAbsolute(await input.inputValue()), true, 'initialized query-export dialog');
    await input.fill(destination); await input.press('Enter');
    await waitForValue(() => fs.existsSync(destination), true, 'fresh query export');
    assert.equal(fs.readFileSync(destination, 'utf8'), '"connection_after_close"\r\n"secondary"');
    await context.screenshot('02-next-database-query');
  });
});

console.log(`Lifecycle artifacts: ${output}`);
if (results.some(result => result.status === 'failed')) process.exitCode = 1;
