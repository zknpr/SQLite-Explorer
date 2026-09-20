import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import { createFixtures, readRows } from './fixtures.mjs';
import { launchInstalledVsix, command, openDatabase, selectTable, waitForValue, createRecorder } from './driver.mjs';

const output = path.resolve(process.env.GUI_OUTPUT ?? `.tmp/c/${Date.now().toString(36)}`);
const backend = process.env.GUI_BACKEND ?? 'native';
assert.ok(['native', 'wasm'].includes(backend), 'GUI_BACKEND must be native or wasm');
const sourceVsix = process.env.GUI_VSIX && path.resolve(process.env.GUI_VSIX);
if (!sourceVsix || !fs.existsSync(sourceVsix)) throw new Error('Set GUI_VSIX to the packaged extension to verify.');
if (fs.existsSync(output)) throw new Error(`Use a new GUI_OUTPUT directory: ${output}`);
fs.mkdirSync(path.join(output, 'inputs'), { recursive: true });
const vsix = path.join(output, 'inputs', path.basename(sourceVsix));
fs.copyFileSync(sourceVsix, vsix, fs.constants.COPYFILE_EXCL);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const artifactSha256 = sha256(fs.readFileSync(vsix));
if (process.env.GUI_EXPECTED_SHA256) assert.equal(artifactSha256, process.env.GUI_EXPECTED_SHA256);
fs.writeFileSync(path.join(output, 'artifact.json'), JSON.stringify({ sourceVsix, vsix,
  sha256: artifactSha256, frozenAt: new Date().toISOString(), backend,
  helpers: Object.fromEntries(['./driver.mjs', './fixtures.mjs', '../../scripts/vscode-runtime.mjs']
    .map(file => [file, sha256(fs.readFileSync(new URL(file, import.meta.url)))]))
}, null, 2));
const workspace = path.join(output, 'workspace');
const fixtures = createFixtures(workspace);
const textBody = 'é東京😀|'.repeat(160_000);
const largeText = 'START-é東京😀\n' + (process.env.GUI_TEXT_MULTILINE
  ? textBody.match(/.{1,1000}/gu).join('\n') : textBody) + '\nEND-東京😀';
const largeTextBytes = Buffer.from(largeText);
const largeBlob = Buffer.alloc(2 * 1024 * 1024 + 17);
for (let index = 0; index < largeBlob.length; index++) largeBlob[index] = index % 251;
const replacement = Buffer.from([0, 255, 128, 1, 13, 10, 65, 0, 254]);
fixtures.replacement = path.join(workspace, 'replacement.bin');
fixtures.empty = path.join(workspace, 'empty.bin');
fs.writeFileSync(fixtures.replacement, replacement);
fs.writeFileSync(fixtures.empty, Buffer.alloc(0));

function pngChunk(type, bytes) {
  const content = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, content, checksum]);
}
function png(padding = 0) {
  const header = Buffer.alloc(13); header.writeUInt32BE(32); header.writeUInt32BE(24, 4);
  header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(24 * (1 + 32 * 3));
  for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) pixels[y * 97 + 3 * x + 3] = 255;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header),
    ...(padding ? [pngChunk('tEXt', Buffer.from('Comment\0' + 'x'.repeat(padding)))] : []),
    pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
}
function silentWav() {
  const data = Buffer.alloc(44 + 8000 * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  return data;
}
function simplePdf(padding) {
  const parts = ['%PDF-1.4\n'];
  const offsets = [0];
  const addObject = body => {
    offsets.push(Buffer.byteLength(parts.join('')));
    parts.push(`${offsets.length - 1} 0 obj\n${body}\nendobj\n`);
  };
  addObject('<< /Type /Catalog /Pages 2 0 R >>');
  addObject('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  addObject('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>');
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const content = 'BT /F1 18 Tf 30 110 Td (Private PDF fixture) Tj ET\n';
  addObject(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  // An unreferenced inert stream makes the valid one-page document oversized.
  addObject(`<< /Length ${padding} >>\nstream\n${'x'.repeat(padding)}\nendstream`);
  const xref = Buffer.byteLength(parts.join(''));
  parts.push(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  parts.push(...offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`));
  parts.push(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(parts.join(''));
}
const imageBytes = png();
const oversizedImage = png(1100 * 1024);
const oversizedPdf = simplePdf(1100 * 1024);
fixtures.oversizedPdf = path.join(workspace, 'oversized.pdf');
fs.writeFileSync(fixtures.oversizedPdf, oversizedPdf);
const audioBytes = silentWav();
const videoFile = path.join(workspace, 'sample.webm');
const videoWidth = 160;
const videoHeight = 120;
const videoCodec = process.env.GUI_VIDEO_CODEC ?? 'libvpx-vp9';
let videoBytes;
try {
  execFileSync(process.env.GUI_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `testsrc2=size=${videoWidth}x${videoHeight}:rate=10:duration=1`,
    '-c:v', videoCodec, '-pix_fmt', 'yuv420p', '-an', videoFile],
  { timeout: 30_000, stdio: 'pipe' });
  videoBytes = fs.readFileSync(videoFile);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const fixtureDb = new DatabaseSync(fixtures.primary);
try {
  fixtureDb.exec('CREATE TABLE cell_workflows(id INTEGER PRIMARY KEY, label TEXT, text_value TEXT, blob_value BLOB)');
  const insert = fixtureDb.prepare('INSERT INTO cell_workflows VALUES(?,?,?,?)');
  insert.run(1, 'editable', 'original\nCaffè 東京 😀', Buffer.from([0, 1, 2, 255]));
  insert.run(2, 'empty blob', '', Buffer.alloc(0));
  insert.run(3, 'oversized', largeText, largeBlob);
  insert.run(4, 'png', null, imageBytes);
  insert.run(5, 'wav', null, audioBytes);
  if (videoBytes) insert.run(6, 'webm', null, videoBytes);
  insert.run(7, 'oversized png', null, oversizedImage);
  insert.run(8, 'oversized pdf', null, oversizedPdf);
  const columns = Array.from({ length: 100 }, (_, i) => `c${String(i).padStart(3, '0')}`);
  fixtureDb.exec(`CREATE TABLE wide_rows(id INTEGER PRIMARY KEY,${columns.map(column => `${column} TEXT`).join(',')})`);
  const insertWide = fixtureDb.prepare(`INSERT INTO wide_rows VALUES(${Array(101).fill('?').join(',')})`);
  fixtureDb.exec('BEGIN');
  for (let row = 1; row <= 1200; row++) insertWide.run(row, ...columns.map(column => `R${row}-${column}`));
  fixtureDb.exec('COMMIT');
} finally { fixtureDb.close(); }
fs.writeFileSync(path.join(output, 'fixture-manifest.json'), JSON.stringify({
  largeText: { bytes: largeTextBytes.length, sha256: sha256(largeTextBytes) },
  largeBlob: { bytes: largeBlob.length, sha256: sha256(largeBlob) },
  image: { bytes: imageBytes.length, width: 32, height: 24 },
  oversizedImage: { bytes: oversizedImage.length, sha256: sha256(oversizedImage) },
  oversizedPdf: { bytes: oversizedPdf.length, sha256: sha256(oversizedPdf), pages: 1 },
  audio: { bytes: audioBytes.length, seconds: 1 },
  video: videoBytes ? { bytes: videoBytes.length, width: videoWidth, height: videoHeight, codec: videoCodec } : 'ffmpeg unavailable'
}, null, 2));

const { app, page } = await launchInstalledVsix({ vsix, output, workspace,
  executable: process.env.VSCODE_TEST_EXECUTABLE_PATH, version: process.env.GUI_VSCODE_VERSION ?? '1.110.0',
  settings: { 'sqliteExplorer.instantCommit': backend === 'wasm' ? 'always' : 'never', 'files.eol': '\n' }
});
const recorder = createRecorder(page, output);
const selected = process.env.GUI_ONLY ? new Set(process.env.GUI_ONLY.split(',')) : undefined;
const run = async (id, name, operation) => {
  if (selected && !selected.has(id)) return;
  try { return await recorder.step(`${id} ${name}`, operation); }
  catch (error) {
    if (id === 'C13L' && !observations.oversizedTextLoaded
      && process.platform === 'darwin' && /timeout|timed out/i.test(String(error))) {
      const owned = new Set([app.process().pid]);
      const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
        .split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
        .map(([, pid, parent, command]) => ({ pid: Number(pid), parent: Number(parent), command }));
      for (let added = true; added;) {
        added = false;
        for (const process of processes) if (owned.has(process.parent) && !owned.has(process.pid)) {
          owned.add(process.pid); added = true;
        }
      }
      const renderers = processes.filter(process => owned.has(process.pid) && process.command.includes('--type=renderer'));
      fs.writeFileSync(path.join(output, 'renderer-processes.json'), JSON.stringify(renderers, null, 2));
      for (const renderer of renderers) {
        try {
          execFileSync('/usr/bin/sample', [String(renderer.pid), '5', '1', '-file',
            path.join(output, `renderer-${renderer.pid}.sample.txt`)], { timeout: 15_000, stdio: 'pipe' });
        } catch (sampleError) {
          fs.writeFileSync(path.join(output, `renderer-${renderer.pid}.sample-error.txt`), String(sampleError));
        }
      }
    }
    throw error;
  }
};
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const browserErrors = [];
const observations = {};
page.on('pageerror', error => browserErrors.push(String(error)));
let frame;
const cell = (row, column) => frame.locator(`tr.data-row[data-rowid="${row}"] td[data-colidx="${column}"]`);
const contains = (locator, value) => waitForValue(async () => (await locator.textContent()).includes(value), true, value);
const disk = (sql, expected) => waitForValue(() => readRows(fixtures.primary, sql), expected, sql);
const screenshot = name => page.screenshot({ path: path.join(output, `${name}.png`) });
const closeInspector = () => frame.locator('#blob-inspector-modal .modal-close').click();
const settleReplacement = async () => {
  await waitForValue(async () => !/^(Reading|Uploading) /.test(await frame.locator('#statusText').textContent()),
    true, 'replacement UI finished');
  // The refresh can close the inspector itself. Escape is safe in either
  // state, unlike checking visibility then racing a click on its close button.
  await page.keyboard.press('Escape');
  await frame.locator('#blob-inspector-modal').waitFor({ state: 'hidden' });
  await waitForValue(() => frame.locator('#btnExport').isEnabled(), true, 'replacement grid ready');
};
const captureInputTrace = async label => {
  if (process.env.GUI_TRACE_INPUT !== '1' || !frame || frame.isDetached()) return;
  fs.writeFileSync(path.join(output, `input-trace-${label}.json`), JSON.stringify(
    await frame.evaluate(() => window.__qaCellInputTrace ?? []), null, 2));
};
const fileDialog = async file => {
  const input = page.locator('.quick-input-widget input');
  await input.waitFor(); await input.fill(file); await input.press('Enter');
};
const primary = async () => {
  frame = await openDatabase(page, 'qa.db');
  await selectTable(frame, 'cell_workflows');
};
const inspectText = async row => {
  await cell(row, 2).click(); await cell(row, 2).locator('.expand-icon').click();
};
const download = async (filename, bytes) => {
  await frame.locator('#blob-download-btn').click();
  const destination = path.join(workspace, filename); await fileDialog(destination);
  await waitForValue(() => fs.existsSync(destination), true, filename);
  assert.deepEqual(fs.readFileSync(destination), bytes);
};
const materializedFiles = () => {
  const directory = path.join(output, 'profile/User/globalStorage');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true }).filter(name =>
    name.includes('cell-materializations') && !name.endsWith('.owner.json'))
    .map(name => path.join(directory, name)).filter(name => fs.statSync(name).isFile());
};
const fullContent = async (bytes, extension) => {
  const before = new Set(materializedFiles());
  await frame.locator('.tab-btn[data-tab="preview"]').click();
  await frame.locator('#blob-download-btn').click();
  await contains(frame.locator('#statusText'), 'Opened full content');
  let created;
  await waitForValue(() => {
    created = materializedFiles().find(file => !before.has(file) && file.endsWith(extension));
    return !!created;
  }, true, 'full content temporary file');
  assert.deepEqual(fs.readFileSync(created), bytes);
  if (process.platform !== 'win32') assert.equal(fs.statSync(created).mode & 0o777, 0o600);
  let contentFrame;
  await waitForValue(async () => {
    for (const candidate of page.frames()) {
      if (!candidate.url().startsWith('vscode-webview://')) continue;
      if (await candidate.locator('nav[aria-label="Cell content pages"]').isVisible()) {
        contentFrame = candidate;
        return (await candidate.locator('#status').textContent()).startsWith('Bytes ');
      }
    }
    return false;
  }, true, 'bounded full-content viewer loaded');
  return { created, contentFrame };
};

try {
  await recorder.step('C00 installed viewer and private cell fixtures', async () => {
    await primary(); await contains(cell(1, 2), 'Caffè 東京');
    if (process.env.GUI_TRACE_INPUT === '1') {
      await frame.evaluate(() => {
        const trace = [];
        window.__qaCellInputTrace = trace;
        const record = (kind, event) => {
          if (trace.length >= 2000) return;
          const target = event?.target;
          const cell = target instanceof Element ? target.closest('td[data-colidx]') : null;
          trace.push({ at: performance.now(), kind, trusted: event?.isTrusted,
            detail: event?.detail, key: event?.key,
            defaultPrevented: event?.defaultPrevented,
            clipboardCharacters: event?.clipboardData?.getData('text/plain').length,
            target: target instanceof Element ? { tag: target.tagName, id: target.id,
              class: target.className, row: cell?.closest('tr')?.dataset.rowid,
              column: cell?.dataset.colidx } : undefined,
            exportDisabled: document.getElementById('btnExport')?.disabled,
            status: document.getElementById('statusText')?.textContent,
            inspector: document.getElementById('blob-inspector-modal')?.className,
            active: { tag: document.activeElement?.tagName, id: document.activeElement?.id },
            selectionCharacters: window.getSelection()?.toString().length });
        };
        for (const type of ['mousedown', 'click', 'dblclick', 'keydown', 'copy']) {
          document.addEventListener(type, event => record(type, event), true);
        }
        document.addEventListener('copy', event => record('copy-completed', event));
        const observer = new MutationObserver(() => record('mutation'));
        for (const id of ['btnExport', 'statusText', 'blob-inspector-modal']) {
          const element = document.getElementById(id);
          if (element) observer.observe(element, { attributes: true, childList: true, characterData: true, subtree: id === 'statusText' });
        }
        record('attached');
      });
    }
    const logRoot = path.join(output, 'profile/logs');
    await waitForValue(() => {
      observations.backendEvidence = fs.readdirSync(logRoot, { recursive: true })
        .filter(name => name.endsWith('SQLite Explorer.log'))
        .flatMap(name => fs.readFileSync(path.join(logRoot, name), 'utf8').split('\n'))
        .filter(line => line.includes('SQLite backend'));
      return observations.backendEvidence.some(line =>
        line.includes(`Using ${backend === 'native' ? 'native' : 'WebAssembly'} SQLite backend`));
    }, true, `installed ${backend} backend selected`);
    await screenshot('00-cell-fixtures');
  });
  await run('C10', 'TEXT Edit in VS Code and Save persists exact Unicode', async () => {
    await inspectText(1);
    assert.equal(await frame.locator('#cellPreviewTextarea').inputValue(), 'original\nCaffè 東京 😀');
    await frame.locator('#openInVsCodeBtn').click();
    const lines = page.locator('.monaco-editor.focused:visible .view-lines');
    await waitForValue(async () => (await lines.allTextContents()).join('').includes('Caffè'), true, 'external cell editor loaded');
    await lines.click(); await page.keyboard.press(`${modifier}+A`);
    await page.keyboard.insertText('saved externally\nUTF-8: é東京😀\nlast line');
    await page.keyboard.press(`${modifier}+S`);
    await disk('SELECT text_value FROM cell_workflows WHERE id=1', [{ text_value: 'saved externally\nUTF-8: é東京😀\nlast line' }]);
    await screenshot('10-text-editor-saved');
    await command(page, 'View: Close Editor'); await primary();
    await contains(cell(1, 2), 'saved externally');
  });
  await run('C11', 'BLOB replace from file and exact download', async () => {
    await primary(); await cell(1, 3).dblclick(); await frame.locator('#blob-replace-btn').click();
    await fileDialog(fixtures.replacement);
    await disk('SELECT hex(blob_value) AS bytes,typeof(blob_value) AS type FROM cell_workflows WHERE id=1',
      [{ bytes: replacement.toString('hex').toUpperCase(), type: 'blob' }]);
    // A host refresh may close the old inspector after a successful write.
    // Reopen the committed cell before checking the independent download.
    await settleReplacement();
    await primary(); await cell(1, 3).dblclick();
    await download('replaced-download.bin', replacement);
    await closeInspector();
  });
  await run('C12', 'empty BLOB download and replace preserve blob storage', async () => {
    await primary(); await cell(2, 3).dblclick(); await contains(frame.locator('#blob-info'), '0 B');
    await download('empty-download.bin', Buffer.alloc(0)); await closeInspector();
    await cell(1, 3).dblclick(); await frame.locator('#blob-replace-btn').click(); await fileDialog(fixtures.empty);
    await disk('SELECT length(blob_value) AS bytes,typeof(blob_value) AS type FROM cell_workflows WHERE id=1', [{ bytes: 0, type: 'blob' }]);
    await settleReplacement();
    await primary(); await cell(1, 3).dblclick();
    await contains(frame.locator('#blob-info'), '0 B'); await closeInspector();
  });
  await run('C13', 'oversized UTF-8 TEXT initial preview stays bounded', async () => {
    await primary(); await inspectText(3); await frame.locator('#blob-inspector-modal').waitFor();
    const initial = await frame.locator('#tab-preview pre').textContent();
    observations.oversizedTextInitial = { bytes: Buffer.byteLength(initial), characters: initial.length,
      sourceBytes: largeTextBytes.length, isPrefix: largeText.startsWith(initial),
      info: await frame.locator('#blob-info').textContent() };
    assert.ok(Buffer.byteLength(initial) <= 64 * 1024,
      `Initial TEXT DOM contains ${Buffer.byteLength(initial)} bytes; expected at most 65536`);
    assert.ok(largeText.startsWith(initial));
    assert.equal(initial.includes('\ufffd'), false);
    await closeInspector();
  });
  await run('C13L', 'oversized UTF-8 TEXT incremental Load more preserves characters', async () => {
    await primary(); await inspectText(3); await frame.locator('#blob-inspector-modal').waitFor();
    const started = performance.now();
    await frame.locator('#blob-load-more-btn').click(); await contains(frame.locator('#blob-info'), 'Loaded 1 MB');
    const pre = frame.locator('#tab-preview pre');
    const navigation = frame.getByRole('navigation', { name: 'Loaded text pages', exact: true });
    const pageInput = navigation.getByRole('spinbutton', { name: 'Text preview page', exact: true });
    const readLoadedPages = async expected => {
      const pages = Number(await pageInput.getAttribute('max'));
      assert.ok(Number.isSafeInteger(pages) && pages > 1 && pages <= 32);
      const chunks = [];
      for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
        await waitForValue(() => pageInput.inputValue(), String(pageNumber), 'text page navigation');
        const chunk = await pre.textContent();
        assert.ok(chunk.length > 0 && chunk.length <= 65_536, 'only one bounded text page belongs in the DOM');
        assert.equal(chunk.includes('\ufffd'), false, 'page boundaries preserve Unicode');
        chunks.push(chunk);
        if (pageNumber < pages) await navigation.getByRole('button', { name: 'Next', exact: true }).click();
      }
      const actualBytes = Buffer.from(chunks.join(''));
      const expectedBytes = Buffer.from(expected);
      const checkpoint = { pages, actualBytes: actualBytes.length, expectedBytes: expectedBytes.length,
        actualSha256: sha256(actualBytes), expectedSha256: sha256(expectedBytes) };
      (observations.textPageCheckpoints ??= []).push(checkpoint);
      assert.equal(checkpoint.actualBytes, checkpoint.expectedBytes, 'loaded text byte length survives page navigation');
      assert.equal(checkpoint.actualSha256, checkpoint.expectedSha256, 'every loaded character survives page navigation');
      assert.equal(await navigation.getByRole('button', { name: 'Next', exact: true }).isDisabled(), true);
      return { pages, firstPage: chunks[0] };
    };
    // The grid preview is not a retained snapshot: the first Load more reads
    // one fresh MiB. Only one bounded page of that snapshot belongs in the DOM.
    const loadedPrefix = new TextDecoder('utf-8', { fatal: true }).decode(largeTextBytes.subarray(0, 1_048_576), { stream: true });
    const prefix = await readLoadedPages(loadedPrefix);
    await screenshot('13-text-loaded-prefix');
    await frame.locator('#blob-load-more-btn').click(); await contains(frame.locator('#blob-info'), 'Full value');
    const complete = await readLoadedPages(largeText);
    assert.equal(await frame.locator('#blob-load-more-btn').isVisible(), false);
    const blocks = pre.locator('.inspector-text-block');
    const blockCount = await blocks.count();
    assert.ok(blockCount <= 4100);
    const layout = await pre.evaluate(element => ({
      whiteSpace: getComputedStyle(element).whiteSpace,
      wordBreak: getComputedStyle(element).wordBreak,
      width: element.clientWidth, scrollWidth: element.scrollWidth,
      height: element.clientHeight, scrollHeight: element.scrollHeight
    }));
    assert.equal(layout.whiteSpace, 'pre-wrap');
    assert.equal(layout.wordBreak, 'break-all');
    assert.ok(layout.scrollWidth <= layout.width + 1);
    let copied;
    if (process.env.GUI_CLIPBOARD === '1') {
      await pageInput.fill('1'); await navigation.getByRole('button', { name: 'Go', exact: true }).click();
      await waitForValue(() => pre.textContent(), complete.firstPage, 'first complete text page');
      await pre.click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.press(`${modifier}+C`);
      copied = complete.firstPage;
      if (process.env.GUI_TRACE_INPUT === '1') {
        const actual = await app.evaluate(({ clipboard }) => clipboard.readText());
        observations.clipboardDiagnostic = { characters: actual.length,
          bytes: Buffer.byteLength(actual), sha256: sha256(Buffer.from(actual)),
          expectedBytes: Buffer.byteLength(copied), expectedSha256: sha256(Buffer.from(copied)),
          equal: actual === copied, equalAfterNewlineNormalization: actual.replaceAll('\r\n', '\n') === copied };
        fs.writeFileSync(path.join(output, 'clipboard-actual.txt'), actual);
        fs.writeFileSync(path.join(output, 'clipboard-diagnostic.json'), JSON.stringify(observations.clipboardDiagnostic, null, 2));
        // Opening a text editor detaches this webview. Preserve the input
        // evidence before changing editors, including on a later paste failure.
        await captureInputTrace('clipboard');
      }
    }
    observations.oversizedTextLoaded = { bytes: largeTextBytes.length, blockCount, layout,
      prefixPages: prefix.pages, completePages: complete.pages, clipboard: copied !== undefined,
      milliseconds: Math.round(performance.now() - started) };
    await screenshot('13-text-full-scroll');
    await closeInspector();
    if (copied !== undefined) {
      const copiedFile = path.join(workspace, 'selected-copy.txt');
      await command(page, 'File: New Untitled Text File');
      await page.locator('.monaco-editor.focused:visible').waitFor();
      await page.keyboard.press(`${modifier}+V`);
      await page.keyboard.press(`${modifier}+S`); await fileDialog(copiedFile);
      await waitForValue(() => fs.existsSync(copiedFile), true, 'selected text saved from actual clipboard paste');
      await page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
      await page.locator('.tabs-container .tab.active:not(.dirty)').filter({ hasText: 'selected-copy.txt' }).waitFor();
      const pasted = fs.readFileSync(copiedFile, 'utf8');
      fs.writeFileSync(path.join(output, 'clipboard-paste.json'), JSON.stringify({
        at: new Date().toISOString(), bytes: Buffer.byteLength(pasted), sha256: sha256(Buffer.from(pasted)),
        expectedBytes: Buffer.byteLength(copied), expectedSha256: sha256(Buffer.from(copied)),
        pickerVisibleAfterDiskWrite: await page.locator('.quick-input-widget').isVisible()
      }, null, 2));
      if (pasted !== copied && process.env.GUI_TRACE_INPUT === '1') {
        // Control experiment: copy the same typed value from VS Code's text
        // editor to distinguish the host clipboard from the extension handler.
        await page.locator('.monaco-editor.focused:visible .view-lines').click();
        await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(copied);
        await page.keyboard.press(`${modifier}+A`); await page.keyboard.press(`${modifier}+C`);
        let control;
        let controlError;
        try {
          await waitForValue(async () => {
            control = await app.evaluate(({ clipboard }) => clipboard.readText());
            return control === copied;
          }, true, 'plain editor clipboard control', 5000);
        } catch (error) { controlError = String(error); }
        fs.writeFileSync(path.join(output, 'clipboard-editor-control.json'), JSON.stringify({
          pastedBytes: Buffer.byteLength(pasted), pastedSha256: sha256(Buffer.from(pasted)),
          expectedBytes: Buffer.byteLength(copied), expectedSha256: sha256(Buffer.from(copied)),
          controlBytes: Buffer.byteLength(control ?? ''), controlSha256: sha256(Buffer.from(control ?? '')),
          controlEqual: control === copied, controlError
        }, null, 2));
      }
      assert.equal(sha256(Buffer.from(pasted)), sha256(Buffer.from(copied)),
        'copy preserves the current page without including unloaded pages');
      observations.oversizedTextLoaded.copiedBytes = Buffer.byteLength(copied);
      observations.oversizedTextLoaded.copiedSha256 = sha256(Buffer.from(copied));
      await command(page, 'View: Close Editor'); await primary();
    }
  });
  await run('C14', 'oversized TEXT Full Content uses bounded read-only pages and exact stored bytes', async () => {
    await primary(); await inspectText(3);
    const { created, contentFrame } = await fullContent(largeTextBytes, '.txt');
    const content = contentFrame.locator('#content');
    const before = await content.textContent();
    assert.ok(before.includes('START')); assert.ok(before.length <= 65540);
    await content.click();
    await page.keyboard.press('Home'); await page.keyboard.insertText('GUI_READONLY_PROBE');
    const after = await content.textContent();
    observations.fullTextReadonlyInputRefused = before === after;
    assert.equal(after, before, 'read-only full content editor must refuse typed input');
    await contentFrame.locator('#last').click();
    // Every navigation button is also disabled while a page request is pending.
    // The rendered page number distinguishes the response from that loading state.
    await waitForValue(async () => await contentFrame.locator('#page').inputValue()
      === await contentFrame.locator('#page').getAttribute('max'), true, 'last stored-text page rendered');
    assert.equal(await contentFrame.locator('#last').isDisabled(), true);
    assert.ok((await content.textContent()).endsWith('END-東京😀'));
    await screenshot('14-full-text-readonly');
    await command(page, 'View: Close Editor');
    await waitForValue(() => fs.existsSync(created), false, 'closed cell snapshot released');
    await closeInspector(); await primary();
  });
  await run('C15', 'oversized BLOB Hex stays bounded and Full Content bytes are exact', async () => {
    await primary(); await cell(3, 3).dblclick();
    await frame.locator('#blob-inspector-modal').waitFor();
    await frame.locator('#blob-load-more-btn').waitFor();
    await frame.locator('.tab-btn[data-tab="hex"]').click();
    const hexRegion = frame.getByRole('region', { name: 'BLOB hexadecimal data', exact: true });
    const hex = await hexRegion.textContent();
    assert.ok(hex.length < 85_000); assert.match(hex, /00 01 02 03 04 05 06 07/);
    await frame.locator('#blob-load-more-btn').click(); await contains(frame.locator('#blob-info'), 'Loaded 1 MB');
    await frame.locator('#blob-hex-next').click();
    assert.match(await hexRegion.textContent(), /00004000/);
    await screenshot('15-blob-bounded-hex');
    const { contentFrame } = await fullContent(largeBlob, '.bin');
    assert.ok((await contentFrame.locator('#content').textContent()).length < 100_000);
    await contentFrame.locator('#last').click();
    await waitForValue(async () => await contentFrame.locator('#page').inputValue()
      === await contentFrame.locator('#page').getAttribute('max'), true, 'last stored-blob page rendered');
    assert.equal(await contentFrame.locator('#last').isDisabled(), true);
    await screenshot('15-full-blob');
    await command(page, 'View: Close Editor'); await closeInspector(); await primary();
  });
  await run('C16', 'small PNG preview actually decodes', async () => {
    await primary(); await cell(4, 3).dblclick();
    const image = frame.locator('#tab-preview img'); await image.waitFor();
    await waitForValue(() => image.evaluate(element => [element.complete, element.naturalWidth, element.naturalHeight]), [true, 32, 24], 'decoded PNG dimensions');
    await screenshot('16-png-decoded'); await closeInspector();
  });
  await run('C17', 'WAV preview decodes and its play, pause, and seek controls work', async () => {
    await primary(); await cell(5, 3).dblclick();
    const audio = frame.locator('#tab-preview audio'); await audio.waitFor();
    await waitForValue(() => audio.evaluate(element => element.readyState >= 2 && element.duration === 1 && !element.error), true, 'decoded silent WAV');
    const bounds = await audio.boundingBox();
    await audio.click({ position: { x: 20, y: bounds.height / 2 } });
    await waitForValue(() => audio.evaluate(element => !element.paused), true, 'WAV play control');
    await audio.click({ position: { x: 20, y: bounds.height / 2 } });
    await waitForValue(() => audio.evaluate(element => element.paused), true, 'WAV pause control');
    await audio.click({ position: { x: bounds.width * 0.55, y: bounds.height / 2 } });
    await waitForValue(() => audio.evaluate(element => element.currentTime > 0.2), true, 'WAV seek control');
    await screenshot('17-wav-decoded'); await closeInspector();
  });
  await run('C17V', 'WebM decodes or exposes its usable unsupported-format fallback', async () => {
    if (videoBytes) {
      await primary();
      await cell(6, 3).dblclick();
      let decoded = false;
      let outcome;
      try {
        await waitForValue(async () => {
          // Decode failure replaces the video; inspect it and the fallback together.
          outcome = await frame.locator('#tab-preview').evaluate(container => {
            const element = container.querySelector('video');
            return { media: element && { readyState: element.readyState,
              width: element.videoWidth, height: element.videoHeight,
              error: element.error && { code: element.error.code, message: element.error.message } },
              text: container.innerText.slice(0, 512) };
          });
          if (outcome.media) observations.video = outcome.media;
          decoded = !!outcome.media && outcome.media.readyState >= 2 && !outcome.media.error;
          return decoded || outcome.text.includes('could not be decoded');
        }, true, 'video decode or explicit fallback');
      } catch (error) {
        throw new Error(`WebM preview did not decode or show its fallback: ${JSON.stringify(outcome)}`, { cause: error });
      }
      observations.video = { ...observations.video, decoded, unsupportedFallback: !decoded };
      if (decoded) {
        assert.equal(observations.video.width, videoWidth); assert.equal(observations.video.height, videoHeight);
      } else {
        assert.equal(await frame.getByRole('button', { name: 'View bounded Hex preview', exact: true }).isVisible(), true);
        await frame.getByRole('button', { name: 'View bounded Hex preview', exact: true }).click();
        assert.match(await frame.locator('#tab-hex textarea').inputValue(), /1A 45 DF A3/i);
      }
      await download('video-download.webm', videoBytes);
      await screenshot('17-webm-outcome'); await closeInspector();
    } else throw new Error('Set GUI_FFMPEG to test video preview with a real generated WebM fixture');
  });
  await run('C18', 'oversized PNG private media URI actually decodes', async () => {
    await primary(); await cell(7, 3).dblclick();
    const image = frame.locator('#tab-preview img'); await image.waitFor();
    await waitForValue(() => image.evaluate(element => [element.complete, element.naturalWidth, element.naturalHeight]), [true, 32, 24], 'decoded oversized PNG dimensions');
    assert.match(await image.getAttribute('src'), /^https:\/\/[^/]+\.vscode-cdn\.net\//);
    const mediaFile = materializedFiles().find(file => file.endsWith('.png'));
    assert.ok(mediaFile);
    assert.deepEqual(fs.readFileSync(mediaFile), oversizedImage);
    await screenshot('18-private-uri-png'); await closeInspector();
    await waitForValue(() => fs.existsSync(mediaFile), false, 'closed media file released');
    await contains(frame.locator('#tableNameLabel'), 'cell_workflows');
    await cell(7, 3).dblclick();
    await waitForValue(() => image.evaluate(element => [element.complete, element.naturalWidth, element.naturalHeight]), [true, 32, 24], 'reopened oversized PNG dimensions');
    const reopenedFile = materializedFiles().find(file => file.endsWith('.png'));
    assert.ok(reopenedFile && reopenedFile !== mediaFile);
    assert.equal(path.dirname(reopenedFile), path.dirname(mediaFile));
    observations.oversizedMedia = { root: path.dirname(mediaFile), bytes: oversizedImage.length,
      exactTemporaryBytes: true, decodedTwice: true, selectedTablePreserved: true };
    await closeInspector();
    await waitForValue(() => fs.existsSync(reopenedFile), false, 'reopened media file released');
  });
  await run('C18P', 'oversized PDF downloads complete bytes without an unsupported inline viewer', async () => {
    await primary(); await cell(8, 3).dblclick();
    const downloadPdf = frame.getByRole('button', { name: 'Download to view', exact: true });
    await downloadPdf.waitFor();
    assert.equal(await frame.locator('#tab-preview iframe').count(), 0);
    assert.equal(materializedFiles().filter(file => file.endsWith('.pdf')).length, 0);
    await downloadPdf.click();
    await page.locator('.quick-input-widget input').waitFor(); await page.keyboard.press('Escape');
    await contains(frame.locator('#statusText'), 'Save cancelled');
    assert.equal(materializedFiles().filter(file => file.endsWith('.pdf')).length, 0);
    await downloadPdf.click();
    const destination = path.join(workspace, 'downloaded-full.pdf'); await fileDialog(destination);
    await contains(frame.locator('#statusText'), 'Saved full cell content');
    assert.deepEqual(fs.readFileSync(destination), oversizedPdf);
    assert.equal(materializedFiles().filter(file => file.endsWith('.pdf')).length, 0);
    await contains(frame.locator('#tableNameLabel'), 'cell_workflows');
    await screenshot('18-full-pdf-download');
    observations.oversizedPdf = { bytes: oversizedPdf.length, exactDownloadBytes: true,
      cancellationVerified: true, temporaryFilesReleased: true, selectedTablePreserved: true,
      rendering: 'PDFs download for viewing in a separate PDF reader' };
    await closeInspector();
    await contains(frame.locator('#tableNameLabel'), 'cell_workflows');
  });
  await run('C19', 'wide schema and virtualized scroll retain visible row identity', async () => {
    await primary(); await selectTable(frame, 'wide_rows');
    await frame.locator('#pageSizeSelect').selectOption('1000'); await contains(frame.locator('#pageIndicator'), '1 / 2');
    assert.equal(await frame.locator('th[data-column]').count(), 101);
    const initialRows = await frame.locator('tr.data-row').count(); assert.ok(initialRows < 200);
    await cell(1, 1).hover(); await page.mouse.wheel(0, 18_000);
    await waitForValue(async () => Number(await frame.locator('tr.data-row').first().getAttribute('data-rowid')) > 400, true, 'virtualized row window advanced');
    const visible = frame.locator('tr.data-row').nth(15);
    const row = Number(await visible.getAttribute('data-rowid'));
    await contains(visible.locator('td[data-colidx="1"]'), `R${row}-c000`);
    await page.mouse.wheel(18_000, 0);
    await waitForValue(() => frame.locator('#gridContainer').evaluate(element => element.scrollLeft > element.clientWidth), true, 'wide table scroll position');
    const containerBounds = await frame.locator('#gridContainer').boundingBox();
    const lastColumnBounds = await frame.locator('th[data-column="c099"]').boundingBox();
    assert.ok(lastColumnBounds.x >= containerBounds.x &&
      lastColumnBounds.x + lastColumnBounds.width <= containerBounds.x + containerBounds.width + 1);
    await screenshot('19-wide-virtualized-grid');
    const mountedRows = await frame.locator('tr.data-row').count();
    assert.ok(mountedRows < 200);
    observations.wideGrid = { initialRows, mountedRows,
      firstRow: await frame.locator('tr.data-row').first().getAttribute('data-rowid'),
      lastRow: await frame.locator('tr.data-row').last().getAttribute('data-rowid'),
      scroll: await frame.locator('#gridContainer').evaluate(element => ({ left: element.scrollLeft,
        width: element.scrollWidth, viewportWidth: element.clientWidth })) };
  });
} finally {
  try {
    await captureInputTrace('final');
  } catch (error) {
    observations.inputTraceCaptureError = String(error);
    console.error(`Input trace capture failed: ${error}`);
  }
  const materializedBeforeClose = materializedFiles();
  await app.close();
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({
    passed: recorder.results.filter(result => result.status === 'passed').length,
    failed: recorder.results.filter(result => result.status === 'failed').length,
    selected: selected ? [...selected] : 'all', browserErrors, observations, materializedBeforeClose,
    materializedAfterClose: materializedFiles(), fixtures,
    logs: path.join(output, 'profile/logs')
  }, null, 2));
}
