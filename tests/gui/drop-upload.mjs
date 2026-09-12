import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { launchInstalledVsix, openDatabase, selectTable, waitForValue, createRecorder } from './driver.mjs';

const output = path.resolve(process.env.GUI_OUTPUT ?? `.tmp/drop-upload-${Date.now()}`);
const sourceVsix = path.resolve(process.env.GUI_VSIX ?? '');
const backend = process.env.GUI_BACKEND ?? 'native';
const only = process.env.GUI_CASES && new Set(process.env.GUI_CASES.split(','));
assert.ok(process.env.GUI_VSIX && fs.existsSync(sourceVsix));
assert.ok(process.env.VSCODE_TEST_EXECUTABLE_PATH);
assert.ok(['native', 'wasm'].includes(backend));
assert.equal(fs.existsSync(output), false, 'use a fresh private GUI_OUTPUT');
fs.mkdirSync(output, { recursive: true });
const vsix = path.join(output, path.basename(sourceVsix));
fs.copyFileSync(sourceVsix, vsix);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const workspace = path.join(output, 'workspace');
fs.mkdirSync(workspace);
const database = path.join(workspace, 'drop-qa.db');
const seed = filename => {
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE upload_target(id INTEGER PRIMARY KEY, label TEXT, payload TEXT);"
    + "INSERT INTO upload_target VALUES(1,'initial',NULL),(2,'cancel target',X'0102');"
    + 'CREATE TABLE second_table(id INTEGER PRIMARY KEY);');
  return db;
};
seed(database).close();
const payload = Buffer.alloc(5 * 1024 * 1024, 65);
const sourceFile = path.join(workspace, 'five-mib.bin');
fs.writeFileSync(sourceFile, payload);
const { app, page } = await launchInstalledVsix({ vsix, output, workspace,
  executable: process.env.VSCODE_TEST_EXECUTABLE_PATH,
  version: process.env.GUI_VSCODE_VERSION ?? '1.110.0',
  settings: { 'sqliteExplorer.instantCommit': backend === 'wasm' ? 'always' : 'never' } });
const recorder = createRecorder(page, output);
const observations = { dropInput: 'DOM File/URI drops through the production handler; trusted workbench keys in Undo cases', payloadSha256: sha256(payload) };
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
let frame;
const run = (id, title, body) => (!only || id === 'U00' || only.has(id)) ? recorder.step(`${id} ${title}`, body) : undefined;
const cell = (row, column) => frame.locator(`tr.data-row[data-rowid="${row}"] td[data-colidx="${column}"]`);
const read = (sql, ...params) => {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return db.prepare(sql).all(...params).map(row => ({ ...row })); }
  finally { db.close(); }
};
const labelIs = value => waitForValue(() => read('SELECT label FROM upload_target WHERE id=1'), [{ label: value }], `independent label ${value}`);
const changeLabel = async value => {
  await cell(1, 1).dblclick();
  const input = cell(1, 1).locator('textarea');
  await input.fill(value); await input.press('Enter');
  await labelIs(value);
  await waitForValue(() => cell(1, 1).textContent(), value, 'authoritative grid label');
};
const drop = async (name, row = 1) => {
  await cell(row, 2).click();
  await frame.evaluate(({ name, row }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(5 * 1024 * 1024).fill(65)], name));
    const target = document.querySelector(`tr[data-rowid="${row}"] td[data-colidx="2"]`);
    window.uploadDropStart = performance.now();
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { name, row });
};
const assertCancelledTarget = () => assert.deepEqual(read('SELECT typeof(payload) AS storage,hex(payload) AS bytes FROM upload_target WHERE id=2'), [{ storage: 'blob', bytes: '0102' }]);
const screenshot = name => page.screenshot({ path: path.join(output, `${name}.png`) });

try {
  await run('U00', 'private fixture and actual installed backend', async () => {
    frame = await openDatabase(page, 'drop-qa.db');
    await selectTable(frame, 'upload_target');
    const logs = path.join(output, 'profile/logs');
    await waitForValue(() => fs.readdirSync(logs, { recursive: true }).filter(file => file.endsWith('SQLite Explorer.log'))
      .some(file => fs.readFileSync(path.join(logs, file), 'utf8').includes(`Using ${backend === 'native' ? 'native' : 'WebAssembly'} SQLite backend`)), true, 'actual backend');
  });
  await run('U01', 'five MiB drop persists exact BLOB bytes and records elapsed time', async () => {
    await frame.evaluate(() => {
      window.uploadStatuses = [];
      const status = document.getElementById('statusText');
      new MutationObserver(() => window.uploadStatuses.push({ text: status.textContent, at: performance.now() }))
        .observe(status, { childList: true });
    });
    await drop('five-mib.bin');
    await waitForValue(() => read('SELECT typeof(payload) AS storage,length(payload) AS length FROM upload_target WHERE id=1'),
      [{ storage: 'blob', length: payload.length }], 'full file persisted', 20_000);
    await waitForValue(() => cell(1, 2).getAttribute('class').then(value => value.includes('oversized-cell')), true, 'authoritative bounded BLOB row');
    observations.upload = await frame.evaluate(() => ({ elapsedMs: performance.now() - window.uploadDropStart, statuses: window.uploadStatuses }));
    assert.equal(sha256(read('SELECT payload FROM upload_target WHERE id=1')[0].payload), sha256(payload));
    assert.deepEqual(fs.readFileSync(sourceFile), payload);
  });
  await run('U02', 'large BLOB in a TEXT-affinity column keeps its BLOB label and inspector', async () => {
    assert.match(await cell(1, 2).textContent(), /^\[BLOB\]/);
    await cell(1, 2).locator('.expand-icon').click();
    await frame.locator('#blob-inspector-modal').waitFor();
    await frame.locator('#blob-info').waitFor();
    observations.inspector = await frame.locator('#blob-info').textContent();
    await screenshot('large-blob-inspector');
    await frame.locator('#blob-inspector-modal .modal-close').click();
  });
  await run('U03', 'trusted Undo cancels pending FileReader without consuming the previous edit', async () => {
    await changeLabel('before cancelled read');
    await frame.evaluate(() => {
      const original = FileReader.prototype.readAsArrayBuffer;
      const originalAbort = FileReader.prototype.abort;
      window.uploadReaderAbortCalls = 0;
      FileReader.prototype.readAsArrayBuffer = function (file) {
        if (file.name === 'cancel-read.bin') { window.heldUploadReader = this; return; }
        return original.call(this, file);
      };
      FileReader.prototype.abort = function () { window.uploadReaderAbortCalls++; return originalAbort.call(this); };
      window.restoreUploadReader = () => { FileReader.prototype.readAsArrayBuffer = original; FileReader.prototype.abort = originalAbort; };
    });
    try {
      await drop('cancel-read.bin', 2);
      await waitForValue(() => frame.evaluate(() => !!window.heldUploadReader), true, 'file read is pending');
      await page.keyboard.press(`${modifier}+Z`);
      await waitForValue(() => frame.locator('#statusText').textContent(), 'Upload cancelled', 'pending upload cancelled');
      await labelIs('before cancelled read'); assertCancelledTarget();
      assert.equal(await frame.evaluate(() => window.uploadReaderAbortCalls), 1);
      // A second ordinary Undo must still own the edit that preceded the drop.
      await page.keyboard.press(`${modifier}+Z`);
      await labelIs('initial'); assertCancelledTarget();
      await screenshot('cancelled-file-read');
    } finally { await frame.evaluate(() => window.restoreUploadReader()); }
  });
  await run('U04', 'trusted Undo cancels binary preparation before the mutation is posted', async () => {
    await changeLabel('before cancelled encoding');
    await frame.evaluate(() => {
      const OriginalChannel = MessageChannel;
      window.MessageChannel = function () {
        const channel = new OriginalChannel();
        const post = channel.port2.postMessage.bind(channel.port2);
        channel.port2.postMessage = (...args) => { window.releaseUploadEncoding = () => post(...args); };
        return channel;
      };
      window.restoreUploadChannel = () => { window.MessageChannel = OriginalChannel; };
    });
    try {
      await drop('cancel-encoding.bin', 2);
      await waitForValue(() => frame.evaluate(() => typeof window.releaseUploadEncoding), 'function', 'encoding is yielding before RPC');
      await page.keyboard.press(`${modifier}+Z`);
      await frame.evaluate(() => { window.restoreUploadChannel(); window.releaseUploadEncoding(); });
      await waitForValue(() => frame.locator('#statusText').textContent(), 'Upload cancelled', 'encoding cancelled');
      await labelIs('before cancelled encoding'); assertCancelledTarget();
      await page.keyboard.press(`${modifier}+Z`); await labelIs('initial');
      await screenshot('cancelled-binary-preparation');
    } finally { await frame.evaluate(() => window.restoreUploadChannel()); }
  });
  await run('U07', 'workspace URI drop reads the actual five MiB file and preserves its bytes', async () => {
    await cell(2, 2).click();
    await frame.evaluate(uri => {
      const transfer = new DataTransfer();
      transfer.setData('text/uri-list', uri);
      window.workspaceDropStart = performance.now();
      document.querySelector('tr[data-rowid="2"] td[data-colidx="2"]').dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
      );
    }, pathToFileURL(sourceFile).href);
    await waitForValue(() => read('SELECT typeof(payload) AS storage,length(payload) AS length FROM upload_target WHERE id=2'),
      [{ storage: 'blob', length: payload.length }], 'workspace file persisted', 20_000);
    await waitForValue(() => cell(2, 2).getAttribute('class').then(value => value.includes('oversized-cell')), true, 'workspace BLOB row refreshed');
    observations.workspaceUpload = { elapsedMs: await frame.evaluate(() => performance.now() - window.workspaceDropStart),
      source: sourceFile, sourceBytes: payload.length };
    assert.equal(sha256(read('SELECT payload FROM upload_target WHERE id=2')[0].payload), sha256(payload));
    assert.deepEqual(fs.readFileSync(sourceFile), payload);
  });
  if (backend === 'native') {
    await run('U05', 'external in-place SQLite writes retain a usable native connection', async () => {
      await waitForValue(() => frame.locator('#btnExport').isEnabled(), true, 'upload refresh and count finished');
      const inode = fs.statSync(database, { bigint: true }).ino;
      const db = new DatabaseSync(database);
      const started = performance.now();
      try {
        // A normal external writer waits for brief reader locks. This still
        // fails on a retained lock; it does not retry a failed UI mutation.
        db.exec('PRAGMA busy_timeout=5000');
        db.prepare('UPDATE upload_target SET label=? WHERE id=1').run('external SQL edit');
      }
      finally { db.close(); }
      observations.externalWriteMilliseconds = Math.round(performance.now() - started);
      assert.equal(fs.statSync(database, { bigint: true }).ino, inode);
      await selectTable(frame, 'second_table'); await selectTable(frame, 'upload_target');
      await waitForValue(() => cell(1, 1).textContent(), 'external SQL edit', 'external value refresh');
      assert.equal(await frame.locator('#btnReloadDatabase').count(), 0);
      await changeLabel('native still writable');
    });
    await run('U06', 'atomic replacement offers Reload Database and preserves replacement bytes', async () => {
      const replacement = path.join(workspace, 'replacement.db');
      const db = seed(replacement);
      db.prepare('UPDATE upload_target SET label=? WHERE id=1').run('replacement file'); db.close();
      const expected = sha256(fs.readFileSync(replacement));
      const oldInode = fs.statSync(database, { bigint: true }).ino;
      fs.renameSync(replacement, database);
      assert.notEqual(fs.statSync(database, { bigint: true }).ino, oldInode);
      await frame.getByRole('button', { name: 'Open table second_table', exact: true }).click();
      const reload = frame.getByRole('button', { name: 'Reload Database', exact: true });
      await reload.waitFor();
      assert.equal(sha256(fs.readFileSync(database)), expected);
      await screenshot('external-change-reload-action');
      await reload.click();
      await frame.locator('#tablesList .list-item').first().waitFor();
      await selectTable(frame, 'upload_target');
      await waitForValue(() => cell(1, 1).textContent(), 'replacement file', 'replacement opened through visible recovery action');
      assert.equal(await reload.count(), 0);
      await cell(1, 1).click(); await page.keyboard.press(`${modifier}+Z`);
      await labelIs('replacement file');
      assert.equal(sha256(fs.readFileSync(database)), expected);
      await screenshot('external-change-recovered');
    });
  }
} finally {
  if (frame && !frame.isDetached()) fs.writeFileSync(path.join(output, 'final-viewer.html'), await frame.content());
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ backend, vsix, sha256: sha256(fs.readFileSync(vsix)),
    results: recorder.results, observations }, null, 2));
  await app.close();
}
