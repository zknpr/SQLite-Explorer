import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { _electron } from 'playwright-core';
import { assertRuntimeVersion } from '../../scripts/vscode-runtime.mjs';

// Characterize the host assumption exposed by the selected-copy test: opening
// the same saved Unicode text without any extension must leave Code responsive.
const output = path.resolve(process.env.GUI_OUTPUT);
const source = path.resolve(process.env.GUI_CONTROL_FILE);
const executable = process.env.VSCODE_TEST_EXECUTABLE_PATH;
const version = process.env.GUI_VSCODE_VERSION;
assertRuntimeVersion(executable, version);
assert.equal(fs.existsSync(output), false, 'use fresh control evidence');
fs.mkdirSync(path.join(output, 'profile/User'), { recursive: true });
fs.mkdirSync(path.join(output, 'workspace'));
const textFile = path.join(output, 'workspace/selected-copy.txt');
fs.copyFileSync(source, textFile, fs.constants.COPYFILE_EXCL);
fs.writeFileSync(path.join(output, 'profile/User/settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
  'update.mode': 'none', 'extensions.autoUpdate': false,
  'security.workspace.trust.enabled': false, 'chat.disableAIFeatures': true,
  'workbench.editor.enablePreview': false, 'files.eol': '\n', 'files.simpleDialog.enable': true
}));
const env = { ...process.env };
for (const key of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_IPC_HOOK', 'NODE_OPTIONS']) delete env[key];
const results = [];
let app;
let application;
let page;
const bounded = async (operation, label, milliseconds = 8000) => {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
};
const step = async (name, operation) => {
  const started = Date.now();
  try {
    await operation();
    results.push({ name, status: 'passed', milliseconds: Date.now() - started });
  } catch (error) {
    results.push({ name, status: 'failed', milliseconds: Date.now() - started, error: String(error) });
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  }
};
let failure;
let cleanupError;
try {
  app = await _electron.launch({ executablePath: executable, env, timeout: 15000,
    args: [path.join(output, 'workspace'), '--user-data-dir', path.join(output, 'profile'),
      '--extensions-dir', path.join(output, 'extensions'), '--disable-extensions',
      '--disable-workspace-trust', '--disable-updates', '--skip-release-notes', '--skip-welcome'],
    bypassCSP: false });
  application = app.process();
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  await step('H00 extension-disabled workbench is responsive', async () => {
    await bounded(page.locator('.monaco-workbench').waitFor(), 'initial workbench');
    await bounded(page.keyboard.press('F1'), 'initial palette key');
    await bounded(page.locator('.quick-input-widget input').waitFor(), 'initial command palette');
    await bounded(page.keyboard.press('Escape'), 'close initial palette');
  });
  await step('H01 same saved Unicode text opens in the built-in editor', async () => {
    await bounded(page.getByRole('treeitem', { name: 'selected-copy.txt', exact: true }).dblclick(), 'open text fixture');
    await bounded(page.locator('.tab.active').filter({ hasText: 'selected-copy.txt' }).waitFor(), 'selected text tab');
  });
  await step('H02 plain-text host remains responsive after opening', async () => {
    await bounded(page.keyboard.press('F1'), 'text-editor palette key');
    await bounded(page.locator('.quick-input-widget input').waitFor(), 'text-editor command palette');
    await bounded(page.keyboard.press('Escape'), 'close text-editor palette');
    await bounded(page.screenshot({ path: path.join(output, 'responsive-text-editor.png') }), 'responsive screenshot');
  });
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await step('H03 extension-disabled clipboard paste and Save preserve the same bytes', async () => {
    await bounded(page.keyboard.press(`${modifier}+W`), 'close source text');
    await bounded(page.keyboard.press(`${modifier}+N`), 'create control text editor');
    await bounded(page.locator('.monaco-editor.focused:visible').waitFor(), 'control text editor');
    // This is control-fixture setup, not evidence of the extension's copy path.
    await bounded(app.evaluate(({ clipboard }, value) => clipboard.writeText(value), fs.readFileSync(source, 'utf8')), 'seed control clipboard');
    await bounded(page.keyboard.press(`${modifier}+V`), 'paste control text');
    await bounded(page.keyboard.press(`${modifier}+S`), 'save control text');
    const destination = path.join(output, 'workspace/pasted-control.txt');
    const input = page.locator('.quick-input-widget input');
    fs.writeFileSync(path.join(output, 'save-picker-before.json'), JSON.stringify({
      input: await bounded(input.inputValue(), 'read control Save input'),
      widget: await bounded(page.locator('.quick-input-widget').innerText(), 'read control Save picker')
    }, null, 2));
    await bounded(input.fill(destination), 'control Save destination');
    await bounded(input.press('Enter'), 'confirm control Save');
    await bounded(page.locator('.quick-input-widget').waitFor({ state: 'hidden' }), 'control Save picker closed', 15000);
    await bounded(page.locator('.tabs-container .tab.active:not(.dirty)').filter({ hasText: 'pasted-control.txt' }).waitFor(),
      'control Save reached its clean UI checkpoint', 15000);
    const actual = fs.readFileSync(destination);
    const expected = fs.readFileSync(source);
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    const comparison = { actualBytes: actual.length, expectedBytes: expected.length,
      actualSha256: digest(actual), expectedSha256: digest(expected) };
    fs.writeFileSync(path.join(output, 'paste-comparison.json'), JSON.stringify(comparison, null, 2));
    // Hash equality is byte-exact without constructing a huge buffer diff if
    // the independent reader sees a mismatched or incomplete output.
    assert.equal(comparison.actualBytes, comparison.expectedBytes);
    assert.equal(comparison.actualSha256, comparison.expectedSha256);
  });
  await step('H04 extension-disabled workbench can close the pasted text', async () => {
    await bounded(page.keyboard.press('F1'), 'post-paste palette key');
    await bounded(page.locator('.quick-input-widget input').fill('>View: Close Editor'), 'post-paste palette filter');
    await bounded(page.locator('.quick-input-widget .label-name').filter({ hasText: 'View: Close Editor' }).first().click(), 'post-paste close command');
    await bounded(page.locator('.tab.active').filter({ hasText: 'pasted-control.txt' }).waitFor({ state: 'hidden' }), 'pasted text tab closed');
  });
} catch (error) {
  failure = String(error);
  console.error(failure);
  if (page) {
    const capture = {};
    try { capture.text = await bounded(page.locator('body').innerText(), 'capture host failure UI', 2000); }
    catch (captureError) { capture.textError = String(captureError); }
    try { await bounded(page.screenshot({ path: path.join(output, 'failure.png') }), 'capture host failure screenshot', 2000); }
    catch (captureError) { capture.screenshotError = String(captureError); }
    fs.writeFileSync(path.join(output, 'failure-ui.json'), JSON.stringify(capture, null, 2));
  }
} finally {
  if (app) {
    try { await bounded(app.close(), 'close isolated host', 3000); }
    catch (error) {
      cleanupError = String(error);
      if (application?.exitCode === null) {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/PID', String(application.pid), '/T', '/F'], { timeout: 10000 });
        } else {
          const rows = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')
            .map(line => line.trim().split(/\s+/).map(Number));
          const owned = new Set([application.pid]);
          for (let changed = true; changed;) {
            changed = false;
            for (const [pid, parent] of rows) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); changed = true; }
          }
          for (const pid of [...owned].reverse()) {
            try { process.kill(pid, 'SIGKILL'); }
            catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
          }
        }
      }
    }
  }
  const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({
    passed: results.filter(r => r.status === 'passed').length,
    failed: results.filter(r => r.status === 'failed').length,
    source, file: textFile, bytes: fs.statSync(textFile).size, sha256: digest(textFile),
    sourceSha256: digest(source), extensionsDisabled: true, version, executable,
    pid: application?.pid, failure, cleanupError, results
  }, null, 2));
}
process.exit(failure || cleanupError ? 1 : 0);
