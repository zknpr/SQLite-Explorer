/**
 * Install counts for the social proof line under the hero, read at build time
 * and again at most once an hour with the page. Both sources are public APIs;
 * anything that does not parse to a plain non-negative integer drops the line
 * rather than showing a wrong number.
 */

const MARKETPLACE_QUERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const OPEN_VSX_URL = 'https://open-vsx.org/api/zknpr/sqlite-explorer';
const EXTENSION_ID = 'zknpr.sqlite-explorer';
const MAX_BODY_CHARS = 512 * 1024;

export interface ExtensionStats {
  /** Marketplace installs plus Open VSX downloads, rounded down to a thousand. */
  installs: number;
  /** The Marketplace's average rating, when it has one. */
  rating: number | null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_BODY_CHARS) throw new Error('response is too large');
  return JSON.parse(text);
}

async function marketplace(): Promise<{ installs: number; rating: number | null }> {
  const body = await readJson(await fetch(MARKETPLACE_QUERY_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json;api-version=7.1-preview.1',
      'Content-Type': 'application/json'
    },
    // filterType 7 is the extension name; flag 256 asks for statistics.
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: EXTENSION_ID }] }], flags: 256 }),
    next: { revalidate: 3600 },
    signal: AbortSignal.timeout(10_000)
  })) as { results?: { extensions?: { statistics?: { statisticName?: unknown; value?: unknown }[] }[] }[] };
  const statistics = body.results?.[0]?.extensions?.[0]?.statistics;
  if (!Array.isArray(statistics)) throw new Error('no statistics in the Marketplace answer');
  const stat = (name: string) => statistics.find(entry => entry.statisticName === name)?.value;
  const installs = count(stat('install'));
  if (installs === null) throw new Error('the Marketplace install count is malformed');
  const rating = stat('averagerating');
  return { installs, rating: typeof rating === 'number' && rating >= 1 && rating <= 5 ? rating : null };
}

async function openVsx(): Promise<number> {
  const body = await readJson(await fetch(OPEN_VSX_URL, {
    next: { revalidate: 3600 },
    signal: AbortSignal.timeout(10_000)
  })) as { downloadCount?: unknown };
  const downloads = count(body.downloadCount);
  if (downloads === null) throw new Error('the Open VSX download count is malformed');
  return downloads;
}

export async function fetchExtensionStats(): Promise<ExtensionStats | null> {
  try {
    const [store, downloads] = await Promise.all([marketplace(), openVsx()]);
    const total = store.installs + downloads;
    return { installs: Math.floor(total / 1000) * 1000, rating: store.rating };
  } catch (error) {
    console.error(`[extension-stats] Hiding the install count: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
