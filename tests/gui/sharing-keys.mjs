import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createFixtures, readRows } from './fixtures.mjs';
import { launchInstalledVsix, command, openDatabase, selectTable, waitForValue, createRecorder } from './driver.mjs';

const output = path.resolve(process.env.GUI_OUTPUT ?? `.tmp/gui-sharing-keys-${Date.now()}`);
const backend = process.env.GUI_BACKEND ?? 'native';
assert.ok(['native', 'wasm'].includes(backend), 'GUI_BACKEND must be native or wasm');
const sourceVsix = process.env.GUI_VSIX && path.resolve(process.env.GUI_VSIX);
assert.ok(sourceVsix && fs.existsSync(sourceVsix), 'GUI_VSIX must name the packaged extension');
assert.equal(fs.existsSync(output), false, 'use a fresh GUI_OUTPUT');
fs.mkdirSync(path.join(output, 'inputs'), { recursive: true });
const vsix = path.join(output, 'inputs', path.basename(sourceVsix));
fs.copyFileSync(sourceVsix, vsix, fs.constants.COPYFILE_EXCL);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const artifactSha256 = sha256(fs.readFileSync(vsix));
if (process.env.GUI_EXPECTED_SHA256) assert.equal(artifactSha256, process.env.GUI_EXPECTED_SHA256);
fs.writeFileSync(path.join(output, 'artifact.json'), JSON.stringify({ sourceVsix, vsix,
  sha256: artifactSha256, backend, frozenAt: new Date().toISOString(),
  helpers: Object.fromEntries(['./sharing-keys.mjs', './driver.mjs', './fixtures.mjs', '../../scripts/vscode-runtime.mjs']
    .map(file => [file, sha256(fs.readFileSync(new URL(file, import.meta.url)))]))
}, null, 2));

const workspace = path.join(output, 'workspace');
const fixtures = createFixtures(workspace);
const originalTenant = 'Team-é 東京 😀';
const changedTenant = 'Team-e\u0301 東京 🐙';
const originalValue = 'original value é東京😀';
const changedValue = 'edited value e\u0301東京🐙';
const slot = Buffer.from([0, 255, 16, 127]);
const siblingSlot = Buffer.from([0, 255, 16, 126]);
const sharedOriginal = 'shared original é東京';
const sharedFirstEdit = 'shared edit from first group 😀';
const sharedAfterClose = 'saved after second group closed 🐙';
const seed = new DatabaseSync(fixtures.primary);
try {
  seed.exec(`CREATE TABLE shared_edits(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE composite_keys(tenant TEXT NOT NULL, slot BLOB NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(tenant,slot)) WITHOUT ROWID;`);
  seed.prepare('INSERT INTO shared_edits VALUES(1,?)').run(sharedOriginal);
  const insert = seed.prepare('INSERT INTO composite_keys VALUES(?,?,?)');
  insert.run(originalTenant, slot, originalValue);
  insert.run(originalTenant, siblingSlot, 'sibling key remains unchanged');
  insert.run('Other tenant', slot, 'other tenant remains unchanged');
} finally { seed.close(); }
const hex = value => Buffer.from(value).toString('hex').toUpperCase();
const keyQuery = `SELECT tenant, hex(CAST(tenant AS BLOB)) AS tenant_hex, typeof(tenant) AS tenant_type,
  hex(slot) AS slot_hex, typeof(slot) AS slot_type,
  value, hex(CAST(value AS BLOB)) AS value_hex, typeof(value) AS value_type
  FROM composite_keys ORDER BY hex(CAST(tenant AS BLOB)), hex(slot)`;
const keyRows = (tenant, value) => [
  { tenant, slot, value },
  { tenant: originalTenant, slot: siblingSlot, value: 'sibling key remains unchanged' },
  { tenant: 'Other tenant', slot, value: 'other tenant remains unchanged' }
].map(row => ({ tenant: row.tenant, tenant_hex: hex(row.tenant), tenant_type: 'text',
  slot_hex: hex(row.slot), slot_type: 'blob', value: row.value, value_hex: hex(row.value), value_type: 'text' }))
  .sort((left, right) => {
    const a = `${left.tenant_hex}:${left.slot_hex}`, b = `${right.tenant_hex}:${right.slot_hex}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
fs.writeFileSync(path.join(output, 'fixture-manifest.json'), JSON.stringify({
  originalTenant, changedTenant, originalValue, changedValue,
  slotHex: hex(slot), siblingSlotHex: hex(siblingSlot),
  originalRows: keyRows(originalTenant, originalValue)
}, null, 2));

const { app, page } = await launchInstalledVsix({ vsix, output, workspace,
  executable: process.env.VSCODE_TEST_EXECUTABLE_PATH, version: process.env.GUI_VSCODE_VERSION ?? '1.110.0',
  settings: { 'sqliteExplorer.instantCommit': backend === 'wasm' ? 'always' : 'never' }
});
const recorder = createRecorder(page, output);
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const browserErrors = [];
const observations = {};
page.on('pageerror', error => browserErrors.push(String(error)));
let firstFrame, secondFrame, remainingFrame;
const contains = (locator, value) => waitForValue(async () => (await locator.textContent()).includes(value), true, value);
const disk = (sql, expected) => waitForValue(() => readRows(fixtures.primary, sql), expected, sql);
const screenshot = name => page.screenshot({ path: path.join(output, `${name}.png`) });
const sharedCell = frame => frame.locator('tr.data-row[data-rowid="1"] td[data-colidx="1"]');
const visibleViewers = async () => {
  const viewers = [];
  for (const frame of page.frames()) {
    if (!frame.url().startsWith('vscode-webview://') || frame.url().includes('/index.html')) continue;
    try {
      if (await frame.locator('#sidebarPanel').isVisible()) viewers.push(frame);
    } catch (error) {
      if (!frame.isDetached()) throw error;
    }
  }
  return viewers;
};
const editCell = async (frame, target, value) => {
  await target.dblclick();
  // The rendered value used to locate a composite row is replaced by this input.
  const input = frame.locator('#gridContainer tr.data-row td textarea');
  await input.waitFor(); await input.fill(value);
  await frame.locator('#tableNameLabel').click();
};
const undo = async frame => {
  await frame.locator('#tableNameLabel').click();
  await page.keyboard.press(`${modifier}+z`);
};
const redo = async frame => {
  await frame.locator('#tableNameLabel').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y');
};
const targetKeyRow = value => remainingFrame.locator('tr.data-row').filter({
  has: remainingFrame.locator('td[data-colidx="2"]').filter({ hasText: value })
});
const assertKeyState = async (tenant, value, label) => {
  await disk(keyQuery, keyRows(tenant, value));
  const row = targetKeyRow(value);
  await waitForValue(() => row.count(), 1, `${label} has one visible composite row`);
  await contains(row.locator('td[data-colidx="0"]'), tenant);
  assert.equal(await remainingFrame.locator('tr.data-row').count(), 3);
  const state = { label, tenant, value, identity: await row.getAttribute('data-rowid'),
    rows: readRows(fixtures.primary, keyQuery) };
  assert.ok(state.identity, 'WITHOUT ROWID row has an addressable identity');
  (observations.keyStates ??= []).push(state);
};

try {
  await recorder.step('G00 installed backend and exact composite-key fixtures', async () => {
    firstFrame = await openDatabase(page, 'qa.db');
    await selectTable(firstFrame, 'shared_edits');
    await contains(sharedCell(firstFrame), sharedOriginal);
    const logRoot = path.join(output, 'profile/logs');
    await waitForValue(() => {
      observations.backendEvidence = fs.readdirSync(logRoot, { recursive: true })
        .filter(name => name.endsWith('SQLite Explorer.log'))
        .flatMap(name => fs.readFileSync(path.join(logRoot, name), 'utf8').split('\n'))
        .filter(line => line.includes('SQLite backend'));
      return observations.backendEvidence.some(line =>
        line.includes(`Using ${backend === 'native' ? 'native' : 'WebAssembly'} SQLite backend`));
    }, true, `installed ${backend} backend selected`);
    assert.match(readRows(fixtures.primary, "SELECT sql FROM sqlite_schema WHERE name='composite_keys'")[0].sql, /WITHOUT ROWID/);
    await disk(keyQuery, keyRows(originalTenant, originalValue));
  });
  await recorder.step('G01 two editor groups share the same database edit and Undo', async () => {
    await firstFrame.locator('#tableNameLabel').click();
    await command(page, 'View: Split Editor Right');
    await waitForValue(async () => (await visibleViewers()).length, 2, 'two visible database viewers');
    const frames = await visibleViewers();
    secondFrame = frames.find(frame => frame !== firstFrame);
    assert.ok(secondFrame);
    await selectTable(secondFrame, 'shared_edits');
    await contains(sharedCell(secondFrame), sharedOriginal);
    observations.sharedViewers = await Promise.all(frames.map(async frame => ({
      url: frame.url(), table: await frame.locator('#tableNameLabel').textContent(),
      bounds: await frame.locator('#tableNameLabel').boundingBox()
    })));
    assert.notEqual(observations.sharedViewers[0].bounds.x, observations.sharedViewers[1].bounds.x,
      'the same database is visible in two distinct editor groups');
    await editCell(firstFrame, sharedCell(firstFrame), sharedFirstEdit);
    await disk('SELECT value FROM shared_edits WHERE id=1', [{ value: sharedFirstEdit }]);
    await contains(sharedCell(firstFrame), sharedFirstEdit); await contains(sharedCell(secondFrame), sharedFirstEdit);
    await screenshot('01-shared-edit-both-groups');
    await undo(secondFrame);
    await disk('SELECT value FROM shared_edits WHERE id=1', [{ value: sharedOriginal }]);
    await contains(sharedCell(firstFrame), sharedOriginal); await contains(sharedCell(secondFrame), sharedOriginal);
    await screenshot('01-shared-undo-both-groups');
  });
  await recorder.step('G02 closing one group retains the database for subsequent edits', async () => {
    await secondFrame.locator('#tableNameLabel').click();
    await page.keyboard.press(`${modifier}+w`);
    await waitForValue(async () => (await visibleViewers()).length, 1, 'one shared database viewer remains');
    [remainingFrame] = await visibleViewers();
    await contains(remainingFrame.locator('#tableNameLabel'), 'shared_edits');
    await editCell(remainingFrame, sharedCell(remainingFrame), sharedAfterClose);
    await disk('SELECT value FROM shared_edits WHERE id=1', [{ value: sharedAfterClose }]);
    await contains(sharedCell(remainingFrame), sharedAfterClose);
    observations.afterGroupClose = { viewerCount: (await visibleViewers()).length,
      rows: readRows(fixtures.primary, 'SELECT value, hex(CAST(value AS BLOB)) AS value_hex FROM shared_edits WHERE id=1') };
    await screenshot('02-edit-after-group-close');
  });
  await recorder.step('K10 WITHOUT ROWID composite-key row edit preserves exact sibling keys', async () => {
    await selectTable(remainingFrame, 'composite_keys');
    await assertKeyState(originalTenant, originalValue, 'initial');
    await editCell(remainingFrame, targetKeyRow(originalValue).locator('td[data-colidx="2"]'), changedValue);
    await assertKeyState(originalTenant, changedValue, 'value edit');
    await screenshot('10-composite-value-edit');
  });
  await recorder.step('K11 changing a Unicode composite key preserves its binary key component', async () => {
    await editCell(remainingFrame, targetKeyRow(changedValue).locator('td[data-colidx="0"]'), changedTenant);
    await assertKeyState(changedTenant, changedValue, 'key edit');
    await screenshot('11-composite-key-edit');
  });
  await recorder.step('K12 composite key and value Undo/Redo restore exact bytes in order', async () => {
    await undo(remainingFrame); await assertKeyState(originalTenant, changedValue, 'undo key');
    await undo(remainingFrame); await assertKeyState(originalTenant, originalValue, 'undo value');
    await redo(remainingFrame); await assertKeyState(originalTenant, changedValue, 'redo value');
    await redo(remainingFrame); await assertKeyState(changedTenant, changedValue, 'redo key');
    await disk('SELECT value FROM shared_edits WHERE id=1', [{ value: sharedAfterClose }]);
    await screenshot('12-composite-key-redo');
  });
} finally {
  await app.close();
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ backend,
    passed: recorder.results.filter(result => result.status === 'passed').length,
    failed: recorder.results.filter(result => result.status === 'failed').length,
    browserErrors, observations, fixtures
  }, null, 2));
}
