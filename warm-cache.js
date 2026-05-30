import { chromium } from 'patchright';
import { cfg } from './src/config.js';
import { gpUrlToStoreUrls } from './src/gp.js';
import { datetime, extensionArgs, handleSIGINT } from './src/util.js';

const headless = !cfg.debug && process.env.SHOW != '1';

const targets = [
  {
    name: 'Epic Games GamerPower',
    apiUrl: 'https://www.gamerpower.com/api/giveaways?platform=epic-games-store&type=game',
  },
  {
    name: 'GOG GamerPower',
    apiUrl: 'https://www.gamerpower.com/api/giveaways?platform=gog&type=game',
  },
];

console.log(datetime(), 'started warming caches');

const context = await chromium.launchPersistentContext(cfg.dir.browser, {
  headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US',
  handleSIGINT: false,
  args: [
    '--hide-crash-restore-bubble',
    ...extensionArgs({ headless }),
  ],
});

handleSIGINT(context);

try {
  if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

  for (const target of targets) {
    console.log(`[Cache] ${target.name}`);
    const results = await gpUrlToStoreUrls(target.apiUrl, context);
    console.log(`[Cache] ${target.name}: ${results.length} giveaway URL(s) resolved or reused`);
  }
} finally {
  await context.close();
}

console.log(datetime(), 'finished warming caches');
