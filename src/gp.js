import { datetime, gotoWithRetry, jsonDb } from './util.js';
import { cfg } from './config.js';

const NO_GIVEAWAYS_MSG = 'No active giveaways available at the moment, please try again later.';
const gpCache = await jsonDb('gamerpower.json', {});

export const normalizeStoreUrl = url => {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url.split(/[?#]/)[0].replace(/\/$/, '');
  }
};

async function fetchGamerPowerGiveaways(page, apiUrl) {
  console.log('[GamerPower] Fetching giveaways from API...');
  await gotoWithRetry(page, apiUrl, { waitUntil: 'domcontentloaded' }, { label: 'GamerPower API' });
  const data = JSON.parse(await page.locator('body').innerText());

  if (!Array.isArray(data)) {
    if (data.status_message === NO_GIVEAWAYS_MSG) {
      console.log('[GamerPower] No active giveaways available');
      return [];
    }
    throw new Error(`GamerPower API error: ${data.status_message || JSON.stringify(data)}`);
  }

  console.log(`[GamerPower] Fetched ${data.length} giveaways`);
  return data;
}

function getCachedUrl(giveawayUrl) {
  const entry = gpCache.data[giveawayUrl];
  if (!entry) return null;

  const timeMs = Number(entry.timeMs);
  const ageMs = Number.isFinite(timeMs) ? Date.now() - timeMs : Number.POSITIVE_INFINITY;
  if (ageMs > cfg.gp_cache_ttl_hours * 60 * 60 * 1000) {
    console.log(`[GamerPower] Cache expired for ${giveawayUrl}`);
    delete gpCache.data[giveawayUrl];
    return null;
  }

  return entry.storeUrl || null;
}

function cacheUrl(giveawayUrl, storeUrl) {
  const cleanUrl = normalizeStoreUrl(storeUrl);
  gpCache.data[giveawayUrl] = {
    storeUrl: cleanUrl,
    time: datetime(),
    timeMs: Date.now(),
  };
  return cleanUrl;
}

export async function gpUrlToStoreUrls(apiUrl, context) {
  const page = await context.newPage();

  try {
    const giveaways = await fetchGamerPowerGiveaways(page, apiUrl);
    const results = [];
    let uncached = 0;

    for (const giveaway of giveaways) {
      const giveawayUrl = giveaway.open_giveaway_url;
      const cachedUrl = getCachedUrl(giveawayUrl);

      if (cachedUrl) {
        results.push({ giveawayUrl, storeUrl: cachedUrl, title: giveaway.title });
        continue;
      }

      uncached++;
      console.log(`[GamerPower] Resolving ${giveaway.title}: ${giveawayUrl}`);
      await gotoWithRetry(page, giveawayUrl, { waitUntil: 'domcontentloaded' }, { label: `GamerPower resolve ${giveaway.title}` });
      results.push({
        giveawayUrl,
        storeUrl: cacheUrl(giveawayUrl, page.url()),
        title: giveaway.title,
      });
    }

    console.log(`[GamerPower] ${results.length - uncached} cached, ${uncached} resolved`);
    await gpCache.write();
    return results;
  } finally {
    await page.close();
  }
}
