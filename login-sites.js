import { chromium } from 'patchright';
import { cfg } from './src/config.js';
import { datetime, extensionArgs, gotoWithRetry, handleSIGINT } from './src/util.js';

const ONEPASSWORD_EXTENSION_ID = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa';
const amazonHost = new URL(cfg.pg_luna_base_url).hostname.replace(/^luna\./, 'www.');
const amazonBaseUrl = `https://${amazonHost}/`;
const lunaClaimsUrl = `${cfg.pg_luna_base_url}/claims/home?g=s`;
const GOG_USER_SELECTOR = '#menuUsername, .menu-account__user-name';
const saneGogUsername = text => {
  const value = `${text || ''}`.trim();
  if (!value || value.length > 64) return null;
  if ((/[\n\r{};<>]/).test(value)) return null;
  if ((/^@charset/i).test(value)) return null;
  if ((/\b(function|var|const|display|cookie|storage|document|window)\b/i).test(value)) return null;
  return value;
};

const defaultSitesRaw = [
  {
    name: '1Password',
    url: `chrome-extension://${ONEPASSWORD_EXTENSION_ID}/app/app.html`,
  },
  {
    name: 'Epic Games',
    url: 'https://www.epicgames.com/id/login?lang=en-US&noHostRedirect=true&redirectUrl=https://store.epicgames.com/en-US/free-games',
  },
  {
    name: 'Prime Gaming',
    url: 'https://gaming.amazon.com/home',
  },
  {
    name: `Amazon Store (${amazonHost})`,
    url: amazonBaseUrl,
  },
  {
    name: 'Amazon SE Store',
    url: 'https://www.amazon.se/',
  },
  {
    name: 'Amazon UK Store',
    url: 'https://www.amazon.co.uk/',
  },
  {
    name: 'Amazon Store',
    url: 'https://www.amazon.com/',
  },
  {
    name: 'Amazon Luna Claims',
    url: lunaClaimsUrl,
  },
  {
    name: 'GOG',
    url: 'https://www.gog.com/en',
  },
  {
    name: 'GOG Redeem',
    url: 'https://www.gog.com/redeem',
  },
  {
    name: 'Microsoft Redeem',
    url: 'https://account.microsoft.com/billing/redeem',
  },
  {
    name: 'Legacy Games',
    url: 'https://legacygames.com/my-account/',
  },
];

const extraSites = (process.env.LOGIN_EXTRA_URLS || '')
  .split(/[;\n]/)
  .map(s => s.trim())
  .filter(Boolean)
  .map((url, i) => ({ name: `Extra ${i + 1}`, url }));

const dedupeSites = list => {
  const seen = new Set();
  return list.filter(site => {
    const key = site.url.toLowerCase().replace(/\/$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const sites = dedupeSites([...defaultSitesRaw, ...extraSites]);

const readLine = () => new Promise(resolve => {
  process.stdin.resume();
  process.stdin.once('data', data => {
    process.stdin.pause();
    resolve(data.toString().trim());
  });
});

const visibleCount = async locator => {
  let count = 0;
  for (const handle of await locator.elementHandles()) {
    const visible = await handle.evaluate(el => {
      const style = window.getComputedStyle(el);
      return style.display != 'none'
        && style.visibility != 'hidden'
        && !el.hasAttribute('hidden')
        && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }).catch(_ => false);
    if (visible) count++;
  }
  return count;
};

const primeSignedInPredicate = () => {
  const isVisible = el => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display != 'none'
      && style.visibility != 'hidden'
      && !el.hasAttribute('hidden')
      && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  };
  const hasUserMarker = [
    '[data-a-target="user-dropdown-first-name-text"]',
    '[data-a-target="amazon-dropdown-header-interactable"]',
    '[data-a-target="FirstName"]',
  ].some(selector => isVisible(document.querySelector(selector)));
  const hasVisibleSignIn = Array.from(document.querySelectorAll('a, button'))
    .some(el => (/sign in|logga in/i).test((el.textContent || '').trim()) && isVisible(el));
  return hasUserMarker && !hasVisibleSignIn && !(/signin|ap\/signin/i).test(location.href);
};

const describePrimeState = async page => page.evaluate(() => {
  const isVisible = el => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display != 'none'
      && style.visibility != 'hidden'
      && !el.hasAttribute('hidden')
      && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  };
  const userSelectors = [
    '[data-a-target="user-dropdown-first-name-text"]',
    '[data-a-target="amazon-dropdown-header-interactable"]',
    '[data-a-target="FirstName"]',
  ];
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    userTexts: userSelectors.flatMap(selector => Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .map(el => (el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)),
    visibleSignInTexts: Array.from(document.querySelectorAll('a, button'))
      .filter(el => (/sign in|logga in/i).test((el.textContent || '').trim()) && isVisible(el))
      .map(el => (el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()),
    bodyStart: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240),
  };
}).catch(error => ({ url: page.url(), error: error.message.split('\n')[0] }));

const isPrimeSignedInPage = async page => await page.evaluate(primeSignedInPredicate).catch(_ => false);

const findSignedInPrimePage = async () => {
  for (const page of context.pages()) {
    if (!(/luna\.amazon\.|gaming\.amazon\./i).test(page.url())) continue;
    if (await isPrimeSignedInPage(page)) return page;
  }
  return null;
};

const microsoftSignedInPredicate = () => {
  const isVisible = el => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display != 'none'
      && style.visibility != 'hidden'
      && !el.hasAttribute('hidden')
      && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  };
  const bodyText = document.body?.innerText || '';
  const hasLoginInput = Array.from(document.querySelectorAll('input[type="email"], input[name="loginfmt"], input[name="passwd"]'))
    .some(isVisible);
  const loginUrl = (/login\.live\.com|\/oauth2\/|\/signin/i).test(location.href);
  const hasRedeemFrame = !!document.querySelector('#redeem-iframe, iframe[src*="redeem"], iframe[src*="Redeem"]');
  const hasRedeemText = (/redeem|code|kod|l[oö]s in|presentkort/i).test(bodyText);
  const hasAccountText = (/microsoft account|microsoft-konto|konto|account/i).test(bodyText);
  return !hasLoginInput && !loginUrl && hasAccountText && (hasRedeemFrame || hasRedeemText);
};

const checkEpic = async page => {
  await gotoWithRetry(page, 'https://store.epicgames.com/en-US/free-games', { waitUntil: 'domcontentloaded' }, { label: 'verify Epic Games login' });
  await page.locator('egs-navigation').waitFor({ timeout: cfg.timeout }).catch(_ => { });
  return await page.locator('egs-navigation').getAttribute('isloggedin').catch(_ => null) == 'true';
};

const checkPrime = async page => {
  if (await findSignedInPrimePage()) return true;
  await page.bringToFront().catch(_ => { });
  await gotoWithRetry(page, lunaClaimsUrl, { waitUntil: 'domcontentloaded' }, { label: 'verify Prime Gaming login' });
  await page.waitForFunction(primeSignedInPredicate, null, { timeout: cfg.login_timeout }).catch(_ => { });
  if (await isPrimeSignedInPage(page)) return true;
  if (await findSignedInPrimePage()) return true;

  console.error(`[Login] Prime Gaming diagnostic: ${JSON.stringify(await describePrimeState(page))}`);
  return false;
};

const checkAmazon = async (page, baseUrl) => {
  await gotoWithRetry(page, baseUrl, { waitUntil: 'domcontentloaded' }, { label: `verify Amazon login ${baseUrl}` });
  await Promise.any([
    page.locator('#nav-link-accountList').first().waitFor({ timeout: cfg.timeout }),
    page.locator('a:has-text("Sign in")').first().waitFor({ timeout: cfg.timeout }),
  ]).catch(_ => { });
  const accountText = await page.locator('#nav-link-accountList').first().innerText().catch(_ => '');
  return (/\b(hello|hej)\b/i).test(accountText) && !(/sign in|logga in/i).test(accountText);
};

const checkMicrosoft = async page => {
  await gotoWithRetry(page, 'https://account.microsoft.com/billing/redeem', { waitUntil: 'domcontentloaded' }, { label: 'verify Microsoft Redeem login' });
  await page.waitForFunction(microsoftSignedInPredicate, null, { timeout: cfg.timeout }).catch(_ => { });
  return await page.evaluate(microsoftSignedInPredicate).catch(_ => false);
};

const checkGog = async page => {
  await gotoWithRetry(page, 'https://www.gog.com/en', { waitUntil: 'domcontentloaded' }, { label: 'verify GOG login' });
  const isLoggedIn = await page.evaluate(async () => fetch('https://www.gog.com/userData.json', { credentials: 'include' })
    .then(response => response.json())
    .then(userData => userData?.isLoggedIn === true)
    .catch(_ => false));
  if (isLoggedIn) return true;

  await Promise.any([
    page.waitForFunction(selector => {
      const isVisible = el => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display != 'none'
          && style.visibility != 'hidden'
          && !el.hasAttribute('hidden')
          && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      };
      const saneUsername = text => {
        const value = `${text || ''}`.trim();
        if (!value || value.length > 64) return null;
        if ((/[\n\r{};<>]/).test(value)) return null;
        if ((/^@charset/i).test(value)) return null;
        if ((/\b(function|var|const|display|cookie|storage|document|window)\b/i).test(value)) return null;
        return value;
      };
      return Array.from(document.querySelectorAll(selector))
        .some(el => isVisible(el) && saneUsername(el.textContent));
    }, GOG_USER_SELECTOR, { timeout: cfg.timeout }),
    page.locator('a:has-text("Sign in")').first().waitFor({ timeout: cfg.timeout }),
    page.locator('a[href="/feed"]').first().waitFor({ timeout: cfg.timeout }),
  ]).catch(_ => { });
  if (await visibleCount(page.locator(GOG_USER_SELECTOR)) > 0) return true;
  const rawUsernameText = await page.locator(GOG_USER_SELECTOR).evaluateAll(elements => elements
    .map(el => (el.textContent || '').trim())
    .find(text => {
      if (!text || text.length > 64) return false;
      if ((/[\n\r{};<>]/).test(text)) return false;
      if ((/^@charset/i).test(text)) return false;
      if ((/\b(function|var|const|display|cookie|storage|document|window)\b/i).test(text)) return false;
      return true;
    }) || '').catch(_ => '');
  const usernameText = saneGogUsername(rawUsernameText);
  const hasVisibleSignIn = await visibleCount(page.locator('a:has-text("Sign in"), button:has-text("Sign in")')) > 0;
  const hasLoginFrame = await page.locator('#GalaxyAccountsFrameContainer iframe').count().catch(_ => 0) > 0;
  const hasSignedInSignal = !!usernameText
    || await page.locator('a[href="/feed"], a[href*="/account"]').count().catch(_ => 0) > 0;
  return !hasLoginFrame && !hasVisibleSignIn && hasSignedInSignal;
};

const checkLegacyGames = async page => {
  await gotoWithRetry(page, 'https://legacygames.com/my-account/', { waitUntil: 'domcontentloaded' }, { label: 'verify Legacy Games login' });
  await Promise.any([
    page.locator('.woocommerce-MyAccount-content').first().waitFor({ timeout: cfg.timeout }),
    page.locator('form.login, form.woocommerce-form-login').first().waitFor({ timeout: cfg.timeout }),
  ]).catch(_ => { });

  if (await visibleCount(page.locator('form.login, form.woocommerce-form-login')) > 0) return false;

  const bodyText = await page.locator('body').innerText().catch(_ => '');
  return (/hello\s+\S+/i).test(bodyText)
    || (/my account/i).test(bodyText) && (/account settings|billing address|my free games|my purchased games/i).test(bodyText);
};

const verifyCoreLogins = async pagesByName => {
  const amazonChecks = [
    { name: `Amazon Store (${amazonHost})`, url: amazonBaseUrl },
    { name: 'Amazon SE Store', url: 'https://www.amazon.se/' },
    { name: 'Amazon UK Store', url: 'https://www.amazon.co.uk/' },
    { name: 'Amazon Store', url: 'https://www.amazon.com/' },
  ].filter((site, index, list) => list.findIndex(other => other.url == site.url) == index);
  const checks = [
    { name: 'Epic Games', check: checkEpic },
    { name: 'Prime Gaming', check: checkPrime },
    ...amazonChecks.map(site => ({ name: site.name, check: page => checkAmazon(page, site.url) })),
    { name: 'GOG', check: checkGog },
    { name: 'Microsoft Redeem', check: checkMicrosoft },
    { name: 'Legacy Games', check: checkLegacyGames },
  ];

  const results = [];
  for (const { name, check } of checks) {
    let page = pagesByName.get(name);
    if (!page || page.isClosed()) {
      page = await context.newPage();
    }
    pagesByName.set(name, page);
    const signedIn = await check(page).catch(error => {
      console.error(`[Login] Could not verify ${name}: ${error.message}`);
      return false;
    });
    results.push({ name, signedIn });
  }

  return results;
};

const reportCookiePresence = async context => {
  const targets = [
    { name: 'Epic Games', urls: ['https://www.epicgames.com/', 'https://store.epicgames.com/'] },
    { name: `Amazon (${amazonHost})`, urls: [amazonBaseUrl, cfg.pg_luna_base_url] },
    { name: 'Amazon SE', urls: ['https://www.amazon.se/', 'https://luna.amazon.se/'] },
    { name: 'Amazon UK', urls: ['https://www.amazon.co.uk/', 'https://luna.amazon.co.uk/'] },
    { name: 'Amazon US', urls: ['https://www.amazon.com/', 'https://luna.amazon.com/'] },
    { name: 'GOG', urls: ['https://www.gog.com/'] },
    { name: 'Microsoft Redeem', urls: ['https://account.microsoft.com/', 'https://login.live.com/'] },
    { name: 'Legacy Games', urls: ['https://legacygames.com/'] },
  ];

  console.log('[Login] Cookie presence in shared profile:');
  for (const target of targets) {
    const cookies = await context.cookies(target.urls).catch(_ => []);
    console.log(`[Login]   ${target.name}: ${cookies.length} cookie(s)`);
  }
};

console.log(datetime(), 'started visible login helper');

const context = await chromium.launchPersistentContext(cfg.dir.browser, {
  headless: false,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US',
  handleSIGINT: false,
  args: [
    '--hide-crash-restore-bubble',
    ...extensionArgs({ headless: false }),
  ],
});

handleSIGINT(context);
if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

try {
  const pagesByName = new Map();
  for (const [index, site] of sites.entries()) {
    const page = index == 0 && context.pages().length
      ? context.pages()[0]
      : await context.newPage();
    pagesByName.set(site.name, page);
    console.log(`[Login] Opening ${site.name}: ${site.url}`);
    await gotoWithRetry(page, site.url, { waitUntil: 'domcontentloaded' }, { label: `login helper ${site.name}` })
      .catch(error => console.error(`[Login] Could not open ${site.name}: ${error.message}`));
  }

  while (true) {
    console.log('');
    console.log('Use the visible Chromium window to unlock/sign in to 1Password and log in to Epic, Prime Gaming, Amazon, GOG, Microsoft, and Legacy Games.');
    console.log('Do not close the Chromium window until this helper says the core logins are verified.');
    console.log('When done, return here and press Enter to verify. Type q and press Enter to quit without verifying.');

    const answer = await readLine();
    if (answer.toLowerCase() == 'q') break;

    const results = await verifyCoreLogins(pagesByName);
    for (const result of results) {
      console.log(`[Login] ${result.name}: ${result.signedIn ? 'signed in' : 'not signed in yet'}`);
    }

    if (results.every(result => result.signedIn)) {
      await reportCookiePresence(context);
      console.log('[Login] Core logins verified. The shared browser profile can now be reused by scheduled runs.');
      break;
    }
  }
} finally {
  await context.close();
}

console.log(datetime(), 'finished visible login helper');
