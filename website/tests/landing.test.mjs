import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import next from 'next';
import { chromium } from 'playwright-core';

// Runs against the production build (npm run build first), like the demo tests.
const website = fileURLToPath(new URL('../', import.meta.url));
const FIRST_TRACK = 'For Those About To Rock (We Salute You)';
const ASSET = /^https:\/\/github\.com\/zknpr\/SQLite-Explorer-App\/releases\/download\/v\d+\.\d+\.\d+\/SQLite-Explorer-\d+\.\d+\.\d+-/;
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

let server;
let browser;
let origin;

before(async () => {
  const app = next({ dev: false, dir: website });
  await app.prepare();
  const handle = app.getRequestHandler();
  server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      console.error(error);
      response.destroy(error);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined
  });
});

after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve) ?? resolve());
});

/** Whether the build could read the app's release manifest (the pages fall back without it). */
async function releaseIsKnown(page) {
  await page.goto(`${origin}/download`);
  return (await page.getByText('GitHub releases page').count()) === 0;
}

test('the landing preview opens Chinook in the real viewer and leaves focus and scroll alone', { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(`${origin}/`);
    const viewer = page.frameLocator('iframe[title^="SQLite Explorer viewer"]');
    // The preview opens the Track table by itself.
    await viewer.getByText(FIRST_TRACK, { exact: true }).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    const where = await page.evaluate(() => ({ active: document.activeElement?.tagName, scrollY: window.scrollY }));
    assert.deepEqual(where, { active: 'BODY', scrollY: 0 }, 'the preview must not move focus or scroll the page');

    // Until the viewer is clicked, the wheel scrolls the page, not the table.
    const frame = page.locator('iframe[title^="SQLite Explorer viewer"]');
    const gridScroll = () => frame.evaluate(element => element.contentDocument.getElementById('gridContainer').scrollTop);
    const scrollY = () => page.evaluate(() => window.scrollY);
    const wheelOverGrid = async () => {
      // Put the whole frame on screen, then turn the wheel over the middle of the grid.
      await frame.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const box = await frame.boundingBox();
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
      const before = await scrollY();
      await page.mouse.wheel(0, 300);
      return before;
    };
    const pageBefore = await wheelOverGrid();
    await page.waitForFunction(start => window.scrollY > start, pageBefore, { timeout: 5_000 });
    assert.equal(await gridScroll(), 0, 'the table must not scroll before the viewer is used');

    await viewer.getByText(FIRST_TRACK, { exact: true }).click();
    const pageAtClick = await wheelOverGrid();
    await page.waitForFunction(
      () => document.querySelector('iframe[title^="SQLite Explorer viewer"]').contentDocument.getElementById('gridContainer').scrollTop > 0,
      undefined,
      { timeout: 5_000 }
    );
    assert.equal(await scrollY(), pageAtClick, 'after a click the wheel belongs to the table');
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

    // The viewer's SQL Query entry opens the page's SQL editor against the preview's worker.
    await viewer.getByRole('button', { name: 'New SQL query', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'SQL Query', exact: true });
    await editor.getByRole('textbox', { name: 'SQL statement', exact: true }).fill('SELECT Name FROM Track WHERE TrackId = 1');
    await editor.getByRole('button', { name: 'Run query', exact: true }).click();
    await editor.getByRole('cell', { name: FIRST_TRACK, exact: true }).waitFor();
    await editor.getByRole('button', { name: 'Close SQL editor' }).click();

    // Reset starts over from the sample, in a new viewer document.
    await page.getByRole('button', { name: 'Reset sample' }).click();
    await viewer.getByText(FIRST_TRACK, { exact: true }).waitFor({ timeout: 30_000 });

    const skip = page.getByRole('link', { name: 'Skip the live preview' });
    assert.equal(await skip.getAttribute('href'), '#desktop');
    assert.equal(await page.locator('#desktop').count(), 1);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test('narrow screens load the preview only when asked', { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const requested = [];
  page.on('request', request => requested.push(new URL(request.url()).pathname));
  try {
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    const load = page.getByRole('button', { name: /Load the live preview/ });
    await load.waitFor();
    assert.equal(requested.filter(path => path.endsWith('chinook.db') || path.endsWith('.wasm')).length, 0);
    await load.click();
    await page
      .frameLocator('iframe[title^="SQLite Explorer viewer"]')
      .getByText(FIRST_TRACK, { exact: true })
      .waitFor({ timeout: 30_000 });
  } finally {
    await context.close();
  }
});

test('download buttons point at the latest release package for the visitor\'s system', { timeout: 60_000 }, async () => {
  const context = await browser.newContext({ userAgent: WINDOWS_UA });
  const page = await context.newPage();
  try {
    const known = await releaseIsKnown(page);
    await page.goto(`${origin}/`);
    const hero = page.locator('section').first().locator('[data-download-platform]');
    if (known) {
      await page.locator('[data-download-platform="windows"]').first().waitFor();
      const href = await hero.getAttribute('href');
      assert.match(href, ASSET);
      assert.match(href, /-windows-x64-setup\.exe$/);
      assert.match(await hero.innerText(), /Download for Windows/);
    } else {
      assert.equal(await hero.getAttribute('href'), '/download');
    }

    await page.goto(`${origin}/download`);
    if (known) {
      for (const [os, suffix] of [['macOS', 'macos-aarch64.dmg'], ['Windows', 'windows-x64-setup.exe'], ['Linux', 'linux-amd64.deb']]) {
        const link = page.getByRole('link', { name: `Download for ${os}`, exact: true }).last();
        const href = await link.getAttribute('href');
        assert.match(href, ASSET);
        assert.ok(href.endsWith(suffix), `${os}: ${href}`);
      }
      assert.match(await page.locator('body').innerText(), /\(Get-FileHash \.\\SQLite-Explorer-[\d.]+-windows-x64-setup\.exe\)/);
    } else {
      await page.getByRole('link', { name: 'GitHub releases page' }).waitFor();
    }
  } finally {
    await context.close();
  }
});

test('no page scrolls sideways on a 375 px phone', { timeout: 60_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const page = await context.newPage();
  try {
    for (const path of ['/', '/download', '/demo']) {
      await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      }));
      assert.equal(scrollWidth, clientWidth, `${path} is ${scrollWidth - clientWidth} px wider than the screen`);
    }
  } finally {
    await context.close();
  }
});

/** The hero's rotating words, as the page shows them. */
function heroWords(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('h1 [aria-hidden] span span')]
        .filter(word => !word.classList.contains('invisible'))
        .map(word => [word.textContent, getComputedStyle(word).opacity])
    )
  );
}

test('the hero keeps cycling through the places, and holds still with reduced motion', { timeout: 60_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const shown = word => page.waitForFunction(
    text => [...document.querySelectorAll('h1 [aria-hidden] span span')]
      .some(span => span.textContent === text && getComputedStyle(span).opacity === '1'),
    word,
    { timeout: 15_000 }
  );
  try {
    await page.goto(`${origin}/`);
    await shown('in your browser');
    // After the last place the first one comes round again.
    await shown('in VS Code');
  } finally {
    await context.close();
  }

  const still = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  try {
    const page = await still.newPage();
    await page.goto(`${origin}/`);
    await page.waitForTimeout(6_000);
    assert.deepEqual(await heroWords(page), { 'in VS Code': '1', 'on your desktop': '0', 'in your browser': '0' });
  } finally {
    await still.close();
  }
});

test('the hero words are drawn whole while they rest', { timeout: 60_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  // The word at rest, with its box and the box that clips it.
  const resting = text => page.evaluate(word => {
    const span = [...document.querySelectorAll('h1 [aria-hidden] span span')].find(s => s.textContent === word && !s.classList.contains('invisible'));
    const clip = span.parentElement;
    const a = span.getBoundingClientRect();
    const b = clip.getBoundingClientRect();
    return getComputedStyle(span).opacity === '1' && Math.abs(a.top - b.top) < 0.5
      ? { x: b.left - 12, y: b.top - 32, width: b.width + 24, height: b.height + 64 }
      : null;
  }, text);
  try {
    await page.goto(`${origin}/`);
    // "in your browser" has descenders; compare it clipped and unclipped.
    let compared = false;
    for (let attempt = 0; attempt < 5 && !compared; attempt++) {
      await page.waitForFunction(
        () => [...document.querySelectorAll('h1 [aria-hidden] span span')]
          .some(s => s.textContent === 'in your browser' && getComputedStyle(s).opacity === '1'),
        undefined,
        { timeout: 15_000 }
      );
      const area = await resting('in your browser');
      if (!area) continue;
      const clipped = await page.screenshot({ clip: area });
      await page.evaluate(() => { document.querySelector('h1 [aria-hidden] > span').style.overflow = 'visible'; });
      const unclipped = await page.screenshot({ clip: area });
      await page.evaluate(() => { document.querySelector('h1 [aria-hidden] > span').style.overflow = ''; });
      if (!(await resting('in your browser'))) continue;
      assert.ok(clipped.equals(unclipped), 'the clip box cuts part of a resting word');
      compared = true;
    }
    assert.ok(compared, 'never caught "in your browser" at rest');
  } finally {
    await context.close();
  }
});

test('same-page section links scroll to their section every time', { timeout: 60_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  // The section must end up right below the sticky header, not under it.
  const landed = id => page.waitForFunction(
    target => Math.abs(document.getElementById(target).getBoundingClientRect().top - document.querySelector('header').getBoundingClientRect().bottom) < 2,
    id,
    { timeout: 5_000 }
  );
  try {
    await page.goto(`${origin}/`);
    const vscode = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'VS Code' });
    for (let round = 0; round < 2; round++) {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await vscode.click();
      await landed('vscode');
    }

    // The logo goes back to the top of the home page.
    await page.evaluate(() => window.scrollTo({ top: 1500, behavior: 'instant' }));
    await page.locator('header a').first().click();
    await page.waitForFunction(() => window.scrollY === 0, undefined, { timeout: 5_000 });

    // From another page the link opens the home page at the section.
    await page.goto(`${origin}/download`);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'VS Code' }).click();
    await page.waitForURL(`${origin}/#vscode`);
    await landed('vscode');
  } finally {
    await context.close();
  }
});

test('the header, the page and the footer share one left edge on every page', { timeout: 60_000 }, async () => {
  const edges = {};
  for (const width of [1440, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    try {
      for (const [path, content] of [['/', '#desktop h2'], ['/download', 'main h1'], ['/demo', 'main h1']]) {
        await page.goto(`${origin}${path}`);
        edges[`${width} ${path}`] = await page.evaluate(selector => {
          const left = element => element && Math.round(element.getBoundingClientRect().left);
          return [left(document.querySelector('header a')), left(document.querySelector(selector)), left(document.querySelector('footer a'))]
            .filter(value => value != null);
        }, content);
      }
    } finally {
      await context.close();
    }
  }
  for (const width of [1440, 375]) {
    const values = Object.entries(edges).filter(([key]) => key.startsWith(`${width} `)).flatMap(([, v]) => v);
    assert.equal(new Set(values).size, 1, JSON.stringify(edges));
  }
});

test('the footer links to every way of supporting the project', { timeout: 30_000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/`);
    const hrefs = await page.locator('footer a').evaluateAll(links => links.map(link => link.href));
    for (const url of ['https://github.com/sponsors/zknpr', 'https://ko-fi.com/zknpr', 'https://buymeacoffee.com/zknpr']) {
      assert.ok(hrefs.includes(url), url);
    }
  } finally {
    await context.close();
  }
});

test('leaving the landing page while its preview downloads starts no worker afterwards', { timeout: 60_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/samples/chinook.db', async route => {
    await held;
    // The page may have aborted the request by now.
    await route.continue().catch(() => undefined);
  });
  try {
    const requested = page.waitForRequest('**/samples/chinook.db');
    await page.goto(`${origin}/`);
    await requested;
    await page.getByRole('link', { name: 'Open your own file' }).click();
    await page.waitForURL('**/demo');
    release();
    await page.waitForTimeout(2_000);
    assert.equal(page.workers().length, 0, 'the finished download started a worker for the page that had left');
  } finally {
    release();
    await context.close();
  }
});

/** Header controls that overlap, or reach past the window, and how wide the page is. */
async function headerLayout(page) {
  return page.evaluate(() => {
    const header = document.querySelector('header.sticky');
    const boxes = [...header.querySelectorAll('a, button')].filter(element => element.offsetParent !== null).map(element => {
      const box = element.getBoundingClientRect();
      return { name: (element.textContent || element.title || '').trim(), left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    });
    const overlaps = [];
    for (const [index, a] of boxes.entries()) {
      for (const b of boxes.slice(index + 1)) {
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps.push(`${a.name} / ${b.name}`);
      }
    }
    return {
      overlaps,
      outside: boxes.filter(box => box.left < 0 || box.right > window.innerWidth).map(box => box.name),
      pageWidth: document.documentElement.scrollWidth,
      headerHeight: Math.round(header.getBoundingClientRect().height)
    };
  });
}

test('on a narrow screen the header keeps every control apart and inside the window', { timeout: 120_000 }, async () => {
  for (const width of [320, 360, 375, 414, 640, 700, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/download`);
      const idle = await headerLayout(page);
      await page.goto(`${origin}/demo`);
      await page.getByRole('button', { name: /chinook/i }).first().click();
      await page.getByRole('button', { name: 'Close', exact: true }).waitFor({ timeout: 30_000 });
      const ready = await headerLayout(page);
      for (const [state, layout] of [['without a database', idle], ['with a database open', ready]]) {
        assert.deepEqual(layout.overlaps, [], `${width} px ${state}: controls overlap`);
        assert.deepEqual(layout.outside, [], `${width} px ${state}: controls past the window`);
        assert.ok(layout.pageWidth <= width, `${width} px ${state}: the page is ${layout.pageWidth} px wide`);
      }
      // From the md breakpoint up the demo's controls stay in the one row.
      if (width >= 768) assert.equal(ready.headerHeight, 65);
    } finally {
      await context.close();
    }
  }
});
