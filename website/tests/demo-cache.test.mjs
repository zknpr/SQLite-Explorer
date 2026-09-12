import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import next from 'next';
import { chromium } from 'playwright-core';

const website = fileURLToPath(new URL('../', import.meta.url));
const assets = ['worker.js', 'viewer.html', 'sql-wasm.js', 'sql-wasm.wasm'];

test('the demo opens both samples after upgrading a warm unversioned runtime cache', { timeout: 90_000 }, async () => {
  const app = next({ dev: false, dir: website });
  await app.prepare();
  const handle = app.getRequestHandler();
  let legacy = true;
  const requests = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    requests.push(pathname);
    if (pathname === '/__demo_cache_probe') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Demo cache regression</title>');
      return;
    }
    // Recreate the previous deployment's response policy in an isolated origin.
    // Use the real shipped assets, and prove the browser actually retains them.
    if (legacy && /^\/sqlite-viewer\/(worker|sql-wasm)\.js$/.test(pathname)) {
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    void handle(request, response).catch(error => {
      console.error(error);
      response.destroy(error);
    });
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${origin}/__demo_cache_probe`);

    for (let attempt = 0; attempt < 2; attempt++) {
      const value = await page.evaluate(async () => {
        const content = new Uint8Array(await (await fetch('/samples/chinook.db')).arrayBuffer());
        const worker = new Worker('/sqlite-viewer/worker.js');
        try {
          const invoke = (targetMethod, payload) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Legacy ${targetMethod} timed out`)), 10_000);
            worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
            worker.onmessage = event => {
              const response = event.data?.content;
              if (response?.kind !== 'response' || response.messageId !== targetMethod) return;
              clearTimeout(timer);
              if (response.success) resolve(response.data);
              else reject(new Error(response.errorMessage));
            };
            worker.postMessage({ channel: 'rpc', content: {
              kind: 'invoke', messageId: targetMethod, targetMethod, payload
            } });
          });
          await invoke('initializeDatabase', ['chinook.db', { content }]);
          const result = await invoke('runQuery', ['SELECT 1 AS value']);
          return result[0].rows[0][0];
        } finally {
          worker.terminate();
        }
      });
      assert.equal(value, 1);
    }
    for (const asset of ['worker.js', 'sql-wasm.js']) {
      assert.equal(requests.filter(url => url === `/sqlite-viewer/${asset}`).length, 1,
        `${asset} must really be served from the warm browser cache on the second open`);
    }

    legacy = false;
    const upgradeStart = requests.length;
    let basePath;
    for (const [sample, table, cell] of [
      ['Chinook', 'Album', 'For Those About To Rock We Salute You'],
      ['Northwind', 'Categories', 'Beverages']
    ]) {
      await page.goto(`${origin}/demo`, { waitUntil: 'load' });
      const started = page.waitForEvent('worker', { timeout: 15_000 });
      await page.getByRole('button', { name: new RegExp(sample) }).click();
      const worker = await started;
      const workerPath = new URL(worker.url()).pathname;
      assert.match(workerPath, /^\/sqlite-viewer\/[a-f0-9]{64}\/worker\.js$/,
        'the upgraded page must bypass its cached unversioned worker');
      basePath = workerPath.slice(0, -'/worker.js'.length);
      await page.getByTitle('Reload database').waitFor({ state: 'visible', timeout: 15_000 });
      assert.equal(await page.locator('iframe').getAttribute('src'), `${basePath}/viewer.html`);
      const viewer = page.frameLocator('iframe');
      await viewer.getByRole('button', { name: `Open table ${table}`, exact: true }).click({ timeout: 15_000 });
      await viewer.getByText(cell, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    }
    assert.deepEqual(pageErrors, []);
    const upgradedRequests = requests.slice(upgradeStart).filter(url => url.startsWith('/sqlite-viewer/'));
    for (const asset of assets) {
      assert.ok(upgradedRequests.includes(`${basePath}/${asset}`), `missing versioned ${asset} request`);
    }
    assert.ok(upgradedRequests.every(url => url.startsWith(`${basePath}/`)),
      'worker-relative JS/WASM loads must stay in the same versioned directory');

    for (const asset of assets) {
      const response = await fetch(`${origin}${basePath}/${asset}`);
      assert.equal(response.status, 200);
      assert.equal(response.redirected, false, 'a redirect would lose the worker runtime base URL');
      assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),
        readFileSync(path.join(website, 'public/sqlite-viewer', asset)));
      const stale = await fetch(`${origin}/sqlite-viewer/${'0'.repeat(64)}/${asset}`);
      assert.equal(stale.status, 404, 'an unknown revision must not alias the current runtime');
      assert.doesNotMatch(stale.headers.get('cache-control') || '', /immutable/);
      await stale.arrayBuffer();
      const mutable = await fetch(`${origin}/sqlite-viewer/${asset}`);
      assert.doesNotMatch(mutable.headers.get('cache-control') || '', /immutable|max-age=[1-9]/);
      await mutable.arrayBuffer();
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await app.close();
  }
});
