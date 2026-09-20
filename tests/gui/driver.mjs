import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { _electron } from 'playwright-core';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { applicationRoot, assertRuntimeVersion } from '../../scripts/vscode-runtime.mjs';

export async function launchInstalledVsix({ vsix, output, executable, version = '1.110.0', workspace, settings = {} }) {
  executable ??= await downloadAndUnzipVSCode({ version, cachePath: path.resolve('.vscode-test/gui') });
  assertRuntimeVersion(executable, version);
  const profile = path.join(output, 'profile');
  const extensions = path.join(output, 'extensions');
  fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
    'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
    'security.workspace.trust.enabled': false, 'files.simpleDialog.enable': true,
    'workbench.editor.enablePreview': false, 'chat.disableAIFeatures': true,
    'git.openRepositoryInParentFolders': 'never',
    'window.dialogStyle': 'custom',
    'sqliteExplorer.defaultPageSize': 100, 'sqliteExplorer.instantCommit': 'never', ...settings
  }, null, 2));
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_IPC_HOOK', 'NODE_OPTIONS']) delete env[name];
  const cli = path.join(applicationRoot(executable), 'out/cli.js');
  const args = ['--user-data-dir', profile, '--extensions-dir', extensions];
  const installed = execFileSync(executable, [cli, ...args, '--install-extension', vsix, '--force'], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000
  });
  fs.writeFileSync(path.join(output, 'install.log'), installed);
  fs.writeFileSync(path.join(output, 'runtime.json'), JSON.stringify({
    vscode: version, executable, platform: process.platform, arch: process.arch,
    node: process.version, vsix, sha256: createHash('sha256').update(fs.readFileSync(vsix)).digest('hex')
  }, null, 2));
  const app = await _electron.launch({ executablePath: executable, env,
    args: [workspace, ...args, '--disable-workspace-trust', '--disable-updates', '--skip-release-notes', '--skip-welcome'],
    timeout: 30_000, bypassCSP: false });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.locator('.monaco-workbench').waitFor();
  // Cold workbench startup can expose command metadata before custom-editor
  // routing is ready. Observe an actual extension response before opening a DB.
  try {
    const deadline = Date.now() + 15_000;
    let retries = 0;
    while (true) {
      await page.keyboard.press('F1');
      await page.locator('.quick-input-widget input').fill('>SQLite Explorer: New SQL Query');
      try {
        await page.locator('.quick-input-widget .label-name').filter({ hasText: 'SQLite Explorer: New SQL Query' }).waitFor({ timeout: Math.min(1000, Math.max(1, deadline - Date.now())) });
        console.log(`GUI_STARTUP_COMMAND_READY retries=${retries}`);
        break;
      } catch (error) {
        if (error.name !== 'TimeoutError' || Date.now() >= deadline) throw error;
        // A palette opened before extension registration keeps its old list.
        // Reopen it while waiting for the contributed command to appear.
        await page.keyboard.press('Escape');
        retries++;
      }
    }
    await page.locator('.quick-input-widget input').fill('>SQLite Explorer: Query History (Session)');
    await page.locator('.quick-input-widget .label-name').filter({ hasText: 'SQLite Explorer: Query History (Session)' }).click();
    await page.locator('.quick-input-title').filter({ hasText: 'SQL query history (session only; parameter values excluded)' }).waitFor();
    console.log('GUI_STARTUP_EXTENSION_READY');
  } catch (error) {
    try {
      await page.screenshot({ path: path.join(output, 'launch-failure.png') });
      fs.writeFileSync(path.join(output, 'launch-failure.txt'), await page.locator('body').innerText());
    } catch (captureError) {
      fs.writeFileSync(path.join(output, 'launch-capture-error.txt'), String(captureError));
    }
    await app.close();
    throw error;
  }
  await page.keyboard.press('Escape');
  return { app, page };
}

export async function command(page, label) {
  await page.keyboard.press('F1');
  await page.locator('.quick-input-widget input').fill(`>${label}`);
  const item = page.locator('.quick-input-widget .label-name').filter({ hasText: label });
  await item.first().waitFor();
  await item.first().click();
}

export async function viewerFrame(page, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!frame.url().startsWith('vscode-webview://') || frame.url().includes('/index.html')) continue;
      try { if (await frame.locator('#sidebarPanel').isVisible()) return frame; } catch { /* frame replaced during editor activation */ }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('The installed extension did not render a database viewer');
}

export async function openDatabase(page, filename) {
  await page.getByRole('treeitem', { name: filename, exact: true }).dblclick();
  const frame = await viewerFrame(page);
  await frame.locator('#tablesList .list-item').first().waitFor();
  return frame;
}

export async function selectTable(frame, name) {
  await frame.getByRole('button', { name: `Open table ${name}`, exact: true }).click();
  await frame.locator('#tableNameLabel').filter({ hasText: name }).waitFor();
  await frame.locator('#gridContainer .data-grid, #gridContainer .empty-view').first().waitFor();
  // Rows can render before the deferred count finishes. During that interval
  // the shipped grid ignores pointer edits; Export reflects all loading guards
  // without depending on whether the selected object permits writes.
  await waitForValue(() => frame.locator('#btnExport').isEnabled(), true, 'selected table ready for actions');
}

export async function waitForValue(probe, expected, description, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let actual;
  let lastBusyError;
  while (Date.now() < deadline) {
    try {
      actual = await probe();
      lastBusyError = undefined;
    } catch (error) {
      // An independent SQLite reader can meet the UI's brief write lock.
      // Preserve real failures and fail on a lock that outlasts the deadline.
      if (error?.code !== 'ERR_SQLITE_ERROR' || ![5, 6].includes(error.errcode & 0xff)) throw error;
      lastBusyError = error;
      await new Promise(resolve => setTimeout(resolve, 50));
      continue;
    }
    try { assert.deepEqual(actual, expected); return; } catch { /* retry only while the UI operation is settling */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (lastBusyError) throw lastBusyError;
  assert.deepEqual(actual, expected, description);
}

export function createRecorder(page, output) {
  const results = [];
  return {
    results,
    async step(name, operation) {
      const start = performance.now();
      try {
        await operation();
        results.push({ name, status: 'passed', ms: performance.now() - start });
        console.log(`PASS ${name}`);
      } catch (error) {
        const screenshot = `${String(results.length + 1).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
        let captureError;
        try { await page.screenshot({ path: path.join(output, screenshot) }); }
        catch (error) { captureError = String(error); }
        try {
          const controls = await page.locator('input,textarea,button,[role="dialog"]').evaluateAll(nodes => nodes.slice(0, 200).map(node => ({
            tag: node.tagName, role: node.getAttribute('role'), label: node.getAttribute('aria-label'),
            placeholder: node.getAttribute('placeholder'), text: node.textContent?.slice(0, 200),
            className: node.className, visible: !!(node.offsetWidth || node.offsetHeight)
          })));
          fs.writeFileSync(path.join(output, screenshot.replace(/\.png$/, '-controls.json')), JSON.stringify(controls, null, 2));
        } catch (error) { captureError = [captureError, String(error)].filter(Boolean).join('\n'); }
        results.push({ name, status: 'failed', ms: performance.now() - start, error: String(error), screenshot, captureError });
        console.error(`FAIL ${name}: ${error}`);
        // Fail fast: later actions would otherwise operate on a failed modal or
        // the wrong document and manufacture unrelated failures.
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
        throw error;
      }
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    }
  };
}
