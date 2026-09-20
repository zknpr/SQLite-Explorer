import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import next from 'next';
import { chromium } from 'playwright-core';

test('the SQL Query button opens a working, bounded browser editor on both samples', { timeout: 90_000 }, async () => {
  const app = next({ dev: false, dir: fileURLToPath(new URL('../', import.meta.url)) });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => response.destroy(error));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const [sample, sql, value] of [
      ['Chinook', 'SELECT Title FROM Album WHERE AlbumId = 1', 'For Those About To Rock We Salute You'],
      ['Northwind', 'SELECT CategoryName FROM Categories WHERE CategoryID = 1', 'Beverages']
    ]) {
      await page.emulateMedia({ colorScheme: sample === 'Northwind' ? 'dark' : 'light' });
      await page.goto(`${origin}/demo`, { waitUntil: 'load' });
      await page.getByRole('button', { name: new RegExp(sample) }).click();
      const queryButton = page.frameLocator('iframe').getByRole('button', { name: 'New SQL query', exact: true });
      await queryButton.click({ timeout: 15_000 });
      const editor = page.getByRole('dialog', { name: 'SQL Query', exact: true });
      await editor.waitFor({ state: 'visible', timeout: 5_000 });
      const input = editor.getByRole('textbox', { name: 'SQL statement', exact: true });
      assert.equal(await input.evaluate(element => document.activeElement === element), true, 'opening must focus the SQL input');
      const run = editor.getByRole('button', { name: 'Run query', exact: true });
      const execute = async (query) => {
        await input.fill(query);
        await run.click();
        await run.waitFor({ state: 'visible' });
      };
      await execute(sql);
      await editor.getByRole('cell', { name: value, exact: true }).waitFor();
      await editor.getByRole('button', { name: 'Close SQL editor' }).click();
      await queryButton.click();
      assert.equal(await input.inputValue(), sql, 'closing must preserve the draft on this database');
      await editor.getByRole('cell', { name: value, exact: true }).waitFor();

      await execute('SELECT * FROM missing_table');
      await editor.getByRole('alert').filter({ hasText: 'missing_table' }).waitFor();
      assert.equal(await editor.getByRole('table').count(), 0, 'failed runs must not show stale results');
      await execute('DELETE FROM sqlite_schema');
      await editor.getByRole('alert').waitFor();
      await input.fill("SELECT 9223372036854775807 AS exact, NULL AS empty, x'0102' AS bytes, '<b>plain text</b>' AS label");
      await input.press('Control+Enter');
      for (const cell of ['9223372036854775807', 'NULL', '0x0102', '<b>plain text</b>']) {
        await editor.getByRole('cell', { name: cell, exact: true }).waitFor();
      }
      assert.equal(await editor.locator('td b').count(), 0, 'database text must not become HTML');

      await editor.getByText('Parameters (JSON array)', { exact: true }).click();
      await editor.getByRole('textbox', { name: 'Parameter values' }).fill('["bound value"]');
      await execute('SELECT ? AS value');
      await editor.getByRole('cell', { name: 'bound value', exact: true }).waitFor();
      await editor.getByRole('textbox', { name: 'Parameter values' }).fill('[]');
      await execute('SELECT zeroblob(70000) AS payload');
      await editor.getByText('Preview; 70,000 bytes total', { exact: true }).waitFor();
      await execute('SELECT 1 AS value WHERE 0');
      await editor.getByText('No rows returned.', { exact: true }).waitFor();
      await execute('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1200) SELECT x FROM n');
      await editor.getByText('Showing the first 1,000 rows. Refine the query to see other rows.', { exact: true }).waitFor();
      assert.equal(await editor.locator('tbody tr').count(), 50, 'render only one result page');
      await editor.getByRole('button', { name: 'Next results page' }).click();
      await editor.getByRole('cell', { name: '51', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await editor.waitFor({ state: 'hidden' });

      // A reload replaces the connection even when the file name stays the same.
      await page.getByTitle('Reload database').click();
      await queryButton.click();
      await editor.waitFor({ state: 'visible' });
      assert.equal(await input.inputValue(), 'SELECT 1 AS value;');
      assert.equal(await editor.getByRole('table').count(), 0);
      await page.setViewportSize({ width: 390, height: 844 });
      const bounds = await editor.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0 && bounds.y + bounds.height <= 844);
      await execute(sql);
      await editor.getByRole('cell', { name: value, exact: true }).waitFor();
      if (process.env.DEMO_SQL_SCREENSHOT_PATH) await page.screenshot({ path: process.env.DEMO_SQL_SCREENSHOT_PATH });
      await page.setViewportSize({ width: 1280, height: 900 });
      if (process.env.DEMO_SQL_DESKTOP_SCREENSHOT_PATH) await page.screenshot({ path: process.env.DEMO_SQL_DESKTOP_SCREENSHOT_PATH });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await app.close();
  }
});
