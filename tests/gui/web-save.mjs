// Saves in VS Code for the Web: the extension's browser build, its WebAssembly engine in the browser's
// extension host, and a workspace that is not on a local disk (`replaceWorkspaceFile`).
//
// Run it from the repository root after a build: `npm run test:gui:web`. It serves the build with
// `npx @vscode/test-web` (downloaded on first use, as is the VS Code build it serves) and drives it with a
// headless Chromium: Playwright's own when installed, or WEB_CHROMIUM, or /usr/bin/chromium.
// WEB_QUALITY (stable) and WEB_COMMIT choose the VS Code build, WEB_PORT the port, WEB_OUTPUT the folder
// for the log, the results and a screenshot of a failed step.
//
// What it had to learn about that tool:
// - The host must be the name localhost. The extension host runs at a subdomain of the host, and an IP
//   address has none.
// - The tool keeps what is written in memory. So every check reads the workspace through VS Code's file
//   API, in the extension host, which is a worker of the page: the helper extension leaves the API there.
// - VS Code for the Web saves by itself a second after an edit, unlike the desktop.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { command, createRecorder, selectTable, waitForValue } from './driver.mjs';

const repository = path.resolve(import.meta.dirname, '../..');
const output = path.resolve(process.env.WEB_OUTPUT ?? '.tmp/web-save');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, 'workspace'), { recursive: true });
const fixture = path.join(output, 'workspace', 'qa.db');
{
  const database = new DatabaseSync(fixture);
  try {
    database.exec("CREATE TABLE contacts(id INTEGER PRIMARY KEY, name TEXT, note TEXT); INSERT INTO contacts VALUES (1, 'Ada', 'first'), (2, 'Grace', 'second'), (3, 'Edsger', 'third')");
  } finally {
    database.close();
  }
}

const port = Number(process.env.WEB_PORT ?? 3010);
const url = `http://localhost:${port}/`;
const serverLog = fs.openSync(path.join(output, 'server.log'), 'w');
const server = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
  '--yes', '@vscode/test-web@0.0.81',
  '--quality', process.env.WEB_QUALITY ?? 'stable',
  ...(process.env.WEB_COMMIT ? ['--commit', process.env.WEB_COMMIT] : []),
  `--extensionDevelopmentPath=${repository}`,
  `--extensionPath=${path.join(repository, 'tests/gui/web-extensions')}`,
  '--browser', 'none', '--port', String(port), '--host', 'localhost',
  path.dirname(fixture)
], { cwd: repository, stdio: ['ignore', serverLog, serverLog], detached: process.platform !== 'win32', shell: process.platform === 'win32' });
function stopServer() {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(server.pid)]);
    else process.kill(-server.pid, 'SIGTERM');
  } catch { /* already gone */ }
}
try {
  // The first run downloads the tool and a VS Code build. The tool says when it listens: a request from
  // here would have to guess whether localhost is 127.0.0.1 or ::1 for it, which the browser need not.
  await waitForValue(async () => {
    if (server.exitCode !== null) throw new Error(`The web server ended with code ${server.exitCode}: see ${path.join(output, 'server.log')}`);
    return fs.readFileSync(path.join(output, 'server.log'), 'utf8').includes(`Listening on ${url.slice(0, -1)}`);
  }, true, 'VS Code for the Web is served', 600_000);
} catch (error) {
  stopServer();
  throw error;
}

// The editor's page runs in a frame of another origin and registers a service worker there, which a
// browser that blocks third-party cookies refuses.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'web-save-profile-'));
fs.mkdirSync(path.join(profile, 'Default'));
fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
  profile: { cookie_controls_mode: 0, block_third_party_cookies: false, default_content_setting_values: { cookies: 1 } }
}));
const executablePath = process.env.WEB_CHROMIUM ?? [chromium.executablePath(), '/usr/bin/chromium'].find(candidate => fs.existsSync(candidate));
const context = await chromium.launchPersistentContext(profile, {
  executablePath, headless: true, args: ['--no-sandbox'], viewport: { width: 1400, height: 900 }
});
const page = context.pages()[0] ?? await context.newPage();
page.setDefaultTimeout(20_000);
const { step, results } = createRecorder(page, output);

/** The extension host: the worker where the helper extension left VS Code's API. */
async function extensionHost() {
  let found;
  await waitForValue(async () => {
    for (const worker of page.workers()) {
      try {
        if (await worker.evaluate(() => typeof globalThis.__webLane === 'object')) found = worker;
      } catch { /* a worker that is starting or gone */ }
    }
    return found !== undefined;
  }, true, 'the extension host with the helper', 60_000);
  return found;
}

/** The frame the database editor draws in. */
async function viewer() {
  let found;
  await waitForValue(async () => {
    for (const frame of page.frames()) {
      try {
        if (await frame.locator('#sidebarPanel').isVisible()) found = frame;
      } catch { /* a frame replaced while the editor opens */ }
    }
    return found !== undefined;
  }, true, 'the database editor', 30_000);
  return found;
}

let host;
const workspace = {
  list: () => host.evaluate(async () => {
    const vscode = globalThis.__webLane;
    return (await vscode.workspace.fs.readDirectory(vscode.workspace.workspaceFolders[0].uri)).map(([name]) => name).sort();
  }),
  read: async name => Buffer.from(await host.evaluate(async file => {
    const vscode = globalThis.__webLane;
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, file));
    let text = '';
    for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return btoa(text);
  }, name), 'base64'),
  tab: () => host.evaluate(() => {
    const tab = globalThis.__webLane.window.tabGroups.activeTabGroup.activeTab;
    return { label: tab?.label, viewType: tab?.input?.viewType, dirty: tab?.isDirty };
  })
};

/** What a database file in the workspace holds, read by a SQLite of this process. */
async function names(file) {
  const copy = path.join(output, `read-${process.hrtime.bigint()}.db`);
  fs.writeFileSync(copy, await workspace.read(file));
  const database = new DatabaseSync(copy, { readOnly: true });
  try {
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    return database.prepare('SELECT name FROM contacts ORDER BY id').all().map(row => row.name);
  } finally {
    database.close();
    fs.rmSync(copy);
  }
}

let frame;
const cell = (row, column = 1) => frame.locator(`tr.data-row[data-rowid="${row}"] td[data-colidx="${column}"]`);
async function open(file) {
  await page.getByRole('treeitem', { name: file, exact: true }).dblclick();
  await waitForValue(async () => (await workspace.tab()).label, file, `${file} is the active tab`);
  frame = await viewer();
  await selectTable(frame, 'contacts');
}
async function edit(row, value) {
  await cell(row).dblclick();
  const input = cell(row).locator('textarea');
  await input.fill(value);
  await input.press('Enter');
  await waitForValue(async () => (await cell(row).textContent()).includes(value), true, `row ${row} shows ${value}`);
}
const save = () => page.keyboard.press('Control+S');
const autoSave = mode => host.evaluate(value => {
  const vscode = globalThis.__webLane;
  return vscode.workspace.getConfiguration('files').update('autoSave', value, vscode.ConfigurationTarget.Global);
}, mode);
const noCopiesLeft = async expected => assert.deepEqual(await workspace.list(), expected, 'no temporary copy is left in the folder');

try {
  await step('W00 the workbench and both extensions start', async () => {
    await page.goto(url);
    await page.locator('.monaco-workbench').waitFor({ timeout: 90_000 });
    host = await extensionHost();
    const about = await host.evaluate(() => {
      const vscode = globalThis.__webLane;
      return { version: vscode.version, ui: vscode.env.uiKind, scheme: vscode.workspace.workspaceFolders[0].uri.scheme,
        extension: vscode.extensions.getExtension('zknpr.sqlite-explorer')?.packageJSON.version };
    });
    console.log(`WEB_RUNTIME ${JSON.stringify({ ...about, browser: context.browser()?.version() })}`);
    assert.equal(about.ui, 2, 'this is VS Code for the Web');
    assert.notEqual(about.scheme, 'file');
    assert.notEqual(about.extension, undefined, 'the extension is installed');
    // VS Code for the Web saves by itself a second after an edit. Off for the steps that save by hand.
    await autoSave('off');
  });

  await step('W01 a database opens in the extension\'s editor, not in a fallback', async () => {
    await open('qa.db');
    assert.equal((await workspace.tab()).viewType, 'sqlite-explorer.view');
    assert.equal(await host.evaluate(() => globalThis.__webLane.extensions.getExtension('zknpr.sqlite-explorer').isActive), true);
    assert.match(await cell(1).textContent(), /Ada/);
  });

  await step('W02 the workspace read through the file API is the file that was served', async () => {
    const served = createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
    assert.equal(createHash('sha256').update(await workspace.read('qa.db')).digest('hex'), served);
    assert.deepEqual(await names('qa.db'), ['Ada', 'Grace', 'Edsger']);
  });

  await step('W03 an edit is not in the file until it is saved', async () => {
    await edit(1, 'Ada edited');
    await waitForValue(async () => (await workspace.tab()).dirty, true, 'the tab is marked unsaved');
    // The check the save below must turn: it fails here.
    await assert.rejects(waitForValue(() => names('qa.db'), ['Ada edited', 'Grace', 'Edsger'], 'not saved yet', 1500));
  });

  await step('W04 a save writes the file in place and leaves no copy beside it', async () => {
    await save();
    await waitForValue(() => names('qa.db'), ['Ada edited', 'Grace', 'Edsger'], 'the saved file holds the edit');
    await waitForValue(async () => (await workspace.tab()).dirty, false, 'the tab is saved');
    await noCopiesLeft(['qa.db']);
  });

  await step('W05 a second save follows the first', async () => {
    await edit(2, 'Grace edited');
    await save();
    await waitForValue(() => names('qa.db'), ['Ada edited', 'Grace edited', 'Edsger'], 'the saved file holds both edits');
    await waitForValue(async () => (await workspace.tab()).dirty, false, 'the tab is saved');
    await noCopiesLeft(['qa.db']);
  });

  await step('W06 the saved file reopens with both edits', async () => {
    await command(page, 'View: Close Editor');
    await waitForValue(async () => (await workspace.tab()).label, undefined, 'the editor is closed');
    await open('qa.db');
    assert.match(await cell(1).textContent(), /Ada edited/);
    assert.match(await cell(2).textContent(), /Grace edited/);
  });

  await step('W07 Save As makes a new file, and later saves go to it', async () => {
    await cell(1).click();
    await page.keyboard.press('Control+Shift+S');
    const input = page.locator('.quick-input-widget input');
    await input.waitFor();
    await input.fill('/copy.db');
    await input.press('Enter');
    await waitForValue(async () => (await workspace.tab()).label, 'copy.db', 'the copy is the active tab');
    await waitForValue(() => workspace.list(), ['copy.db', 'qa.db'], 'the copy exists and nothing else was left');
    assert.deepEqual(await names('copy.db'), ['Ada edited', 'Grace edited', 'Edsger']);
    assert.equal((await workspace.tab()).viewType, 'sqlite-explorer.view');
    frame = await viewer();
    await selectTable(frame, 'contacts');
    await edit(3, 'Edsger edited');
    await save();
    await waitForValue(() => names('copy.db'), ['Ada edited', 'Grace edited', 'Edsger edited'], 'the copy holds the new edit');
    assert.deepEqual(await names('qa.db'), ['Ada edited', 'Grace edited', 'Edsger'], 'the first file is as it was saved');
    await noCopiesLeft(['copy.db', 'qa.db']);
  });

  await step('W08 Save As over an existing database replaces its content after both confirmations', async () => {
    await cell(1).click();
    await page.keyboard.press('Control+Shift+S');
    const input = page.locator('.quick-input-widget input');
    await input.waitFor();
    await input.fill('/qa.db');
    await input.press('Enter');
    const picker = page.locator('.quick-input-widget');
    await waitForValue(async () => (await picker.textContent()).includes('Are you sure you want to overwrite it?'), true, 'the picker asks first');
    await picker.getByRole('button', { name: 'OK', exact: true }).click();
    const confirm = page.getByRole('button', { name: 'Replace', exact: true });
    await confirm.waitFor();
    await confirm.click();
    await waitForValue(async () => (await workspace.tab()).label, 'qa.db', 'the replaced file is the active tab');
    await waitForValue(() => names('qa.db'), ['Ada edited', 'Grace edited', 'Edsger edited'], 'the replaced file holds the copy\'s content');
    await noCopiesLeft(['copy.db', 'qa.db']);
  });

  await step('W09 with the web default, an edit is saved by itself, in place', async () => {
    await autoSave('afterDelay');
    frame = await viewer();
    await selectTable(frame, 'contacts');
    await edit(1, 'Ada by itself');
    await waitForValue(() => names('qa.db'), ['Ada by itself', 'Grace edited', 'Edsger edited'], 'the file holds the edit without a save');
    await waitForValue(async () => (await workspace.tab()).dirty, false, 'the tab is saved');
    await noCopiesLeft(['copy.db', 'qa.db']);
  });
} finally {
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
  stopServer();
}
