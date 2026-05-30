// import { chromium } from 'playwright-chromium';
import { chromium } from 'patchright';
import { authenticator } from 'otplib';
import chalk from 'chalk';
import path from 'path';
import { existsSync, writeFileSync } from 'fs';
import { abortRun, cleanProfileLocks, closeContextSafely, createRunSummary, extensionArgs, gotoWithRetry, html_game_list, handleSIGINT, isExitError, jsonDb, notify, prompt, confirm, resolve, datetime, filenamify, writeRunSummary } from './src/util.js';
import { cfg } from './src/config.js';
import { getMobileGames } from './src/epic-games-mobile.js';
import { gpUrlToStoreUrls, normalizeStoreUrl } from './src/gp.js';
import { smokeExit } from './src/smoke.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'epic-games', ...a);

const URL_CLAIM = 'https://store.epicgames.com/en-US/free-games';
const URL_LOGIN = 'https://www.epicgames.com/id/login?lang=en-US&noHostRedirect=true&redirectUrl=' + URL_CLAIM;
const URL_PROMOTIONS = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=en-US';
const GAMERPOWER_API_URL = 'https://www.gamerpower.com/api/giveaways?platform=epic-games-store&type=game';
const GP_DONE_STATUSES = ['claimed', 'existed', 'manual'];

console.log(datetime(), 'started checking epic-games');
smokeExit('epic-games');

const offerSlugFromValue = value => {
  const clean = normalizeStoreUrl(`${value || ''}`);
  try {
    return decodeURIComponent(new URL(clean).pathname.replace(/\/+$/, '').split('/').pop()).toLowerCase();
  } catch {
    return decodeURIComponent(clean.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop()).toLowerCase();
  }
};

const offerIdMap = {};
try {
  const response = await fetch(URL_PROMOTIONS);
  const data = await response.json();
  for (const element of data?.data?.Catalog?.searchStore?.elements || []) {
    const promos = element.promotions?.promotionalOffers?.[0]?.promotionalOffers || [];
    const isFree = promos.some(offer => offer.discountSetting?.discountPercentage === 0);
    if (!isFree) continue;
    const slug = element.catalogNs?.mappings?.[0]?.pageSlug || element.urlSlug;
    if (slug && element.id) offerIdMap[offerSlugFromValue(slug)] = element.id;
  }
  if (Object.keys(offerIdMap).length) console.log(`Fetched ${Object.keys(offerIdMap).length} Epic offer IDs for cart fallback.`);
} catch (error) {
  console.warn('Could not fetch Epic offer IDs for cart fallback.');
  if (cfg.debug) console.error(error);
}

const db = await jsonDb('epic-games.json', {});

if (cfg.time) console.time('startup');

// https://playwright.dev/docs/auth#multi-factor-authentication
const removedProfileLocks = cleanProfileLocks(cfg.dir.browser);
if (removedProfileLocks.length) console.warn(`Removed stale Chromium profile lock(s): ${removedProfileLocks.join(', ')}`);

const context = await chromium.launchPersistentContext(cfg.dir.browser, {
  // channel: 'chrome', // recommended, but `npx patchright install chrome` clashes with system Chrome - https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs#best-practice----use-chrome-without-fingerprint-injection
  headless: false, // don't use cfg.headless headless here since SHOW=0 will lead to captcha
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US', // ignore OS locale to be sure to have english text for locators
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined, // will record a .webm video for each page navigated; without size, video would be scaled down to fit 800x800
  recordHar: cfg.record ? { path: `data/record/eg-${filenamify(datetime())}.har` } : undefined, // will record a HAR file with network requests and responses; can be imported in Chrome devtools
  handleSIGINT: false, // have to handle ourselves and call context.close(), otherwise recordings from above won't be saved
  // https://peter.sh/experiments/chromium-command-line-switches/
  args: [
    '--hide-crash-restore-bubble',
    '--ignore-gpu-blocklist', // required for OpenGL: Disabled -> Enabled & WebGL: Software only -> Hardware accelerated
    '--enable-unsafe-webgpu', // required for WebGPU: Disabled -> Hardware accelerated
    ...extensionArgs({ headless: false }),
  ],
  // chromiumSandbox: true, // https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/issues/52
});

// console.log(context.browser().browserType()); // browser is null...
if (cfg.debug) console.log(chromium.executablePath());

handleSIGINT(context);

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage(); // should always exist
// await page.setViewportSize({ width: cfg.width, height: cfg.height }); // TODO workaround for https://github.com/vogler/free-games-claimer/issues/277 until Playwright fixes it

// some debug info about the page (screen dimensions, user agent, platform)
if (cfg.debug) console.debug(await page.evaluate(() => [(({ width, height, availWidth, availHeight }) => ({ width, height, availWidth, availHeight }))(window.screen), navigator.userAgent, navigator.platform, navigator.vendor])); // deconstruct screen needed since `window.screen` prints {}, `window.screen.toString()` '[object Screen]', and can't use some pick function without defining it on `page`
if (cfg.debug_network) {
  // const filter = _ => true;
  const filter = r => r.url().includes('store.epicgames.com');
  page.on('request', request => filter(request) && console.log('>>', request.method(), request.url()));
  page.on('response', response => filter(response) && console.log('<<', response.status(), response.url()));
}

const notify_games = [];
const manual_actions = [];
let user;
const runSummary = createRunSummary('epic-games');
let runError;

const addManualAction = action => manual_actions.push(action);
const providerKey = provider => provider?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || null;
const normalizeButtonText = text => text.replace(/\s+/g, ' ').trim().toLowerCase();
const gameIdFromUrl = url => normalizeStoreUrl(url).split('/').filter(Boolean).pop();
const legacyGameIdFromUrl = url => url.split('/').pop();
const gameRecordFromUrl = (userGames, url) => userGames?.[gameIdFromUrl(url)] || userGames?.[legacyGameIdFromUrl(url)];

const waitForInLibraryButton = page => page.waitForFunction(
  () => {
    const btn = document.querySelector('button[data-testid="purchase-cta-button"]');
    return btn?.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() == 'in library';
  },
);
const isInLibraryButton = async page => normalizeButtonText(await page.locator('button[data-testid="purchase-cta-button"]').first().innerText({ timeout: 2000 }).catch(() => '')) == 'in library';
const checkoutSuccessWaiters = scope => [
  scope.locator('text=/Thanks for your order|It.s all yours/i').first().waitFor({ state: 'attached' }).then(() => 'order-confirmation'),
  scope.locator('button:has-text("Continue browsing"), button:has-text("Continue Browsing"), button:has-text("Download launcher"), button:has-text("Download Launcher")').first().waitFor({ state: 'visible' }).then(() => 'order-confirmation'),
];

const checkoutAddToLibraryLocators = scope => [
  scope.getByRole('button', { name: /^Add to library$/i }),
  scope.locator('[role="button"]:has-text("Add to library")'),
  scope.getByText(/^Add to library$/i),
  scope.locator('button:not([data-testid="purchase-cta-button"]):has-text("Add to library")'),
];
const waitForCheckoutAddToLibraryButton = scope => Promise.any(
  checkoutAddToLibraryLocators(scope).map(locator => locator.waitFor({ state: 'visible' })),
);
const clickCheckoutAddToLibraryButton = async scope => {
  let lastError;
  for (const locator of checkoutAddToLibraryLocators(scope)) {
    try {
      await locator.first().click({ delay: 11, timeout: 5000 });
      return;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
};

const acceptRightOfWithdrawalDialog = async scope => {
  const acceptButton = scope.locator('[role="dialog"]:visible:has-text("Right of Withdrawal Information") button:visible:has-text("I accept")').first();
  await acceptButton.waitFor({ state: 'visible' });
  console.log('  Accept Right of Withdrawal Information');
  await acceptButton.click({ delay: 11 });
  return 'right-of-withdrawal';
};

const waitForCheckoutCompletion = async (page, checkoutFrame = null) => {
  while (true) {
    const waiters = [
      ...checkoutSuccessWaiters(page),
      waitForInLibraryButton(page).then(() => 'in-library'),
      acceptRightOfWithdrawalDialog(page),
    ];
    if (checkoutFrame) {
      waiters.push(
        ...checkoutSuccessWaiters(checkoutFrame),
        acceptRightOfWithdrawalDialog(checkoutFrame),
      );
    }
    const completionSignal = await Promise.any(waiters);
    if (completionSignal != 'right-of-withdrawal') return completionSignal;
  }
};

function isGamerPowerGameAlreadyHandled(userGames, storeUrl) {
  const gameId = normalizeStoreUrl(storeUrl).split('/').pop();
  const status = userGames?.[gameId]?.status;

  if (status && GP_DONE_STATUSES.includes(status)) {
    console.log(`[GamerPower] Already handled: ${storeUrl} (${status})`);
    return true;
  }

  return false;
}

try {
  await context.addCookies([
    { name: 'OptanonAlertBoxClosed', value: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), domain: '.epicgames.com', path: '/' }, // Accept cookies to get rid of banner to save space on screen. Set accept time to 5 days ago.
    { name: 'HasAcceptedAgeGates', value: 'USK:9007199254740991,general:18,EPIC SUGGESTED RATING:18', domain: 'store.epicgames.com', path: '/' }, // gets rid of 'To continue, please provide your date of birth', https://github.com/vogler/free-games-claimer/issues/275, USK number doesn't seem to matter, cookie from 'Fallout 3: Game of the Year Edition'
  ]);

  await gotoWithRetry(page, URL_CLAIM, { waitUntil: 'domcontentloaded' }, { label: 'epic-games free-games page' }); // 'domcontentloaded' faster than default 'load' https://playwright.dev/docs/api/class-page#page-goto

  if (cfg.time) console.timeEnd('startup');
  if (cfg.time) console.time('login');

  // page.click('button:has-text("Accept All Cookies")').catch(_ => { }); // Not needed anymore since we set the cookie above. Clicking this did not always work since the message was animated in too slowly.
  page.locator('button:has-text("Continue")').click().catch(_ => { }); // already logged in, but need to accept updated "Epic Games Privacy Policy"

  while (await page.locator('egs-navigation').getAttribute('isloggedin') != 'true') {
    console.error('Not signed in anymore. Please login in the browser or here in the terminal.');
    if (cfg.nowait) abortRun(1, 'Epic Games login required and NOWAIT=1');
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout); // give user some extra time to log in
    console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);
    await gotoWithRetry(page, URL_LOGIN, { waitUntil: 'domcontentloaded' }, { label: 'epic-games login page' });
    if (cfg.eg_email && cfg.eg_password) console.info('Using email and password from environment.');
    else if (cfg.browser_login) console.info('Browser-login mode enabled; skipping terminal credential prompts.');
    else console.info('Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode).');
    const notifyBrowserLogin = async () => {
      console.log('Waiting for you to login in the browser.');
      await notify('epic-games: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        console.log('Run `SHOW=1 node epic-games` to login in the opened browser.');
        await context.close(); // finishes potential recording
        abortRun(1, 'Epic Games login required in shown browser');
      }
    };
    const email = cfg.eg_email || !cfg.browser_login && await prompt({ message: 'Enter email' });
    if (!email) await notifyBrowserLogin();
    else {
      // await page.click('text=Sign in with Epic Games');
      page.waitForSelector('.h_captcha_challenge iframe').then(async () => {
        console.error('Got a captcha during login (likely due to too many attempts)! You may solve it in the browser, get a new IP or try again in a few hours.');
        await notify('epic-games: got captcha during login. Please check.');
      }).catch(_ => { });
      page.waitForSelector('p:has-text("Incorrect response.")').then(async () => {
        console.error('Incorrect response for captcha!');
      }).catch(_ => { });
      await page.fill('#email', email);
      await page.click('button#continue'); // login was split in two steps for some time, then email and password on the same form, now two steps again...
      const password = email && (cfg.eg_password || !cfg.browser_login && await prompt({ type: 'password', message: 'Enter password' }));
      if (!password) await notifyBrowserLogin();
      else {
        await page.fill('#password', password);
        await page.click('button#sign-in');
      }
      const error = page.locator('#form-error-message');
      error.waitFor().then(async () => {
        console.error('Login error:', await error.innerText());
        console.log('Please login in the browser!');
      }).catch(_ => { });
      page.waitForSelector('button#yes, button[aria-label="Yes, continue"]', { timeout: 30000 }).then(async btn => {
        console.log('Got "Is this the right account?" prompt. Click Yes, continue.');
        await btn.click({ delay: 111 });
      }).catch(_ => { });
      // handle MFA, but don't await it
      page.waitForURL('**/id/login/mfa**').then(async () => {
        console.log('Enter the security code to continue - This appears to be a new device, browser or location. A security code has been sent to your email address at ...');
        // TODO locator for text (email or app?)
        const otp = cfg.eg_otpkey && authenticator.generate(cfg.eg_otpkey) || await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 6 || 'The code must be 6 digits!' }); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
        await page.locator('input[name="code-input-0"]').pressSequentially(otp.toString());
        await page.click('button[type="submit"]');
      }).catch(_ => { });
    }
    await page.waitForURL(URL_CLAIM);
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  user = await page.locator('egs-navigation').getAttribute('displayname'); // 'null' if !isloggedin
  console.log(`Signed in as ${user}`);
  db.data[user] ||= {};
  if (cfg.time) console.timeEnd('login');
  if (cfg.time) console.time('claim all games');

  // Detect free games
  const game_loc = page.locator('a:has(span:text-is("Free Now"))');
  await game_loc.last().waitFor().catch(_ => {
    // rarely there are no free games available -> catch Timeout
    // TODO would be better to wait for alternative like 'coming soon' instead of waiting for timeout
    // see https://github.com/vogler/free-games-claimer/issues/210#issuecomment-1727420943
    console.error('Seems like currently there are no free games available in your region...');
    // urls below should then be an empty list
  });
  // clicking on `game_sel` sometimes led to a 404, see https://github.com/vogler/free-games-claimer/issues/25
  // debug showed that in those cases the href was still correct, so we `goto` the urls instead of clicking.
  // Alternative: parse the json loaded to build the page https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions
  // i.e. filter data.Catalog.searchStore.elements for .promotions.promotionalOffers being set and build URL with .catalogNs.mappings[0].pageSlug or .urlSlug if not set to some wrong id like it was the case for spirit-of-the-north-f58a66 - this is also what's done here: https://github.com/claabs/epicgames-freegames-node/blob/938a9653ffd08b8284ea32cf01ac8727d25c5d4c/src/puppet/free-games.ts#L138-L213
  const urlSlugs = await Promise.all((await game_loc.all()).map(a => a.getAttribute('href')));
  const urls = urlSlugs.map(s => 'https://store.epicgames.com' + s);

  // Free mobile games - https://github.com/vogler/free-games-claimer/issues/474
  // https://egs-platform-service.store.epicgames.com/api/v2/public/discover/home?count=10&country=DE&locale=en&platform=android&start=0&store=EGS
  if (cfg.eg_mobile) {
    console.log('Including mobile games...');
    const mobileGames = await getMobileGames(context);
    urls.push(...mobileGames.map(x => x.url));
  }

  if (cfg.eg_check_gp) {
    const knownUrls = new Set(urls.map(normalizeStoreUrl));
    const gpGames = await gpUrlToStoreUrls(GAMERPOWER_API_URL, context);
    const gpEpicGames = gpGames.filter(g => g.storeUrl.includes('store.epicgames.com'));
    console.log(`[GamerPower] ${gpEpicGames.length} Epic Games store URLs`);

    for (const game of gpEpicGames) {
      const storeUrl = normalizeStoreUrl(game.storeUrl);
      if (knownUrls.has(storeUrl) || isGamerPowerGameAlreadyHandled(db.data[user], storeUrl)) continue;
      knownUrls.add(storeUrl);
      urls.push(storeUrl);
      console.log(`[GamerPower] Added extra Epic URL: ${storeUrl}`);
    }
  }

  console.log('Free games:', urls);

  for (const url of urls) {
    if (cfg.time) console.time('claim game');
    if (gameRecordFromUrl(db.data[user], url)?.status == 'claimed') {
      console.log('Already claimed, skipping:', url);
      if (cfg.time) console.timeEnd('claim game');
      continue;
    }
    await gotoWithRetry(page, url, {}, { label: `epic-games offer ${url}` }); // , { waitUntil: 'domcontentloaded' });
    // when loading, the button text is empty -> need to wait for some text {'get', 'in library', 'requires base game'} -> just wait for e or i to not be too specific; :text-matches("\w+") somehow didn't work - https://github.com/vogler/free-games-claimer/issues/375
    // was using locator('...').first().waitFor(), but that at some point led to exception locator.waitFor: Error: Can't query n-th element
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button[data-testid="purchase-cta-button"]');
        return btn && (/[ei]/i).test(btn.textContent) && btn.textContent != 'Loading';
      },
    );
    const purchaseBtn = page.locator('button[data-testid="purchase-cta-button"]').first();
    const btnText = normalizeButtonText(await purchaseBtn.innerText()); // barrier to block until page is loaded

    // click Continue if 'This game contains mature content recommended only for ages 18+'
    if (await page.locator('button:has-text("Continue")').count() > 0) {
      console.log('  This game contains mature content recommended only for ages 18+');
      if (await page.locator('[data-testid="AgeSelect"]').count()) {
        console.error('  Got "To continue, please provide your date of birth" - This shouldn\'t happen due to cookie set above. Please report to https://github.com/vogler/free-games-claimer/issues/275');
        await page.locator('#month_toggle').click();
        await page.locator('#month_menu li:has-text("01")').click();
        await page.locator('#day_toggle').click();
        await page.locator('#day_menu li:has-text("01")').click();
        await page.locator('#year_toggle').click();
        await page.locator('#year_menu li:has-text("1987")').click();
      }
      await page.click('button:has-text("Continue")', { delay: 111 });
      await page.waitForTimeout(2000);
    }

    let title;
    let bundle_includes;
    if (await page.locator('span:text-is("About Bundle")').count()) {
      title = (await page.locator('span:has-text("Buy"):left-of([data-testid="purchase-cta-button"])').first().innerText()).replace('Buy ', '');
      // h1 first didn't exist for bundles but now it does... However h1 would e.g. be 'Fallout® Classic Collection' instead of 'Fallout Classic Collection'
      try {
        bundle_includes = await Promise.all((await page.locator('.product-card-top-row h5').all()).map(b => b.innerText()));
      } catch (e) {
        console.error('Failed to get "Bundle Includes":', e);
      }
    } else {
      title = await page.locator('h1').first().innerText();
    }
    const game_id = gameIdFromUrl(page.url());
    const legacy_game_id = legacyGameIdFromUrl(page.url());
    if (legacy_game_id != game_id && db.data[user][legacy_game_id] && !db.data[user][game_id]) db.data[user][game_id] = db.data[user][legacy_game_id];
    const existedInDb = db.data[user][game_id];
    db.data[user][game_id] ||= { title, time: datetime(), url: page.url() }; // this will be set on the initial run only!
    console.log('Current free game:', chalk.blue(title));
    if (bundle_includes) console.log('  This bundle includes:', bundle_includes);
    const notify_game = { title, url, status: 'failed' };
    notify_games.push(notify_game); // status is updated below
    let sawCaptcha = false;
    let missingParentalPin = false;
    const recordClaimed = (message = '  Claimed successfully!') => {
      db.data[user][game_id].status = notify_game.status = 'claimed';
      db.data[user][game_id].time = datetime(); // claimed time overwrites failed/dryrun time
      console.log(message);
    };

    if (btnText == 'in library') {
      console.log('  Already in library! Nothing to claim.');
      if (!existedInDb) await notify(`Game already in library: ${url}`);
      notify_game.status = 'existed';
      db.data[user][game_id].status ||= 'existed'; // does not overwrite claimed or failed
      if (db.data[user][game_id].status.startsWith('failed')) db.data[user][game_id].status = 'claimed'; // was failed but now it's claimed
    } else if (btnText == 'requires base game') {
      console.log('  Requires base game! Nothing to claim.');
      notify_game.status = 'requires base game';
      db.data[user][game_id].status ||= 'failed:requires-base-game';
      // TODO claim base game if it is free
      const baseUrl = 'https://store.epicgames.com' + await page.locator('a:has-text("Overview")').getAttribute('href');
      console.log('  Base game:', baseUrl);
      // await page.click('a:has-text("Overview")');
      // TODO handle this via function call for base game above since this will never terminate if DRYRUN=1
      urls.push(baseUrl); // add base game to the list of games to claim
      urls.push(url); // add add-on itself again
    } else { // GET
      const recheckText = normalizeButtonText(await purchaseBtn.innerText().catch(() => btnText));
      if (recheckText == 'in library') {
        console.log('  Already in library after ownership state refreshed.');
        notify_game.status = 'existed';
        db.data[user][game_id].status ||= 'existed';
        if (db.data[user][game_id].status.startsWith('failed')) db.data[user][game_id].status = 'claimed';
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }
      console.log('  Not in library yet! Click', recheckText || btnText);
      await purchaseBtn.click({ delay: 11 }); // got stuck here without delay (or mouse move), see #75, 1ms was also enough

      // click Continue if 'Device not supported. This product is not compatible with your current device.' - avoided by Windows userAgent?
      page.click('button:has-text("Continue")').catch(_ => { }); // needed since change from Chromium to Firefox?

      // click 'Yes, buy now' if 'This edition contains something you already have. Still interested?'
      page.click('button:has-text("Yes, buy now")').catch(_ => { });

      // Accept End User License Agreement (only needed once)
      page.locator('input#agree').waitFor().then(async () => {
        console.log('  Accept End User License Agreement (only needed once)');
        if (cfg.debug) console.log(await page.locator('body').innerHTML());
        await page.locator('input#agree').check(); // TODO Bundle: got stuck here; likely unrelated to bundle and locator just changed: https://github.com/vogler/free-games-claimer/issues/371
        await page.locator('button:has-text("Accept")').click();
      }).catch(_ => { });

      const iframe = page.frameLocator('#webPurchaseContainer iframe');
      const iframePlaceOrderButton = iframe.locator('button:has-text("Add to library"):not(:has(.payment-loading--loading)), button:has-text("Place Order"):not(:has(.payment-loading--loading))');
      const iframeParentalPin = iframe.locator('.payment-pin-code');
      const iframeUnavailable = iframe.locator(':has-text("unavailable in your region")');
      // Epic has used both a legacy iframe checkout and a newer top-page checkout
      // modal. The iframe can exist even when the modal flow is active, so only
      // treat it as legacy checkout when it exposes real checkout content.
      const checkoutStep = await Promise.any([
        waitForCheckoutAddToLibraryButton(page).then(() => 'add-to-library'),
        waitForCheckoutAddToLibraryButton(iframe).then(() => 'iframe-add-to-library'),
        waitForInLibraryButton(page).then(() => 'in-library'),
        iframePlaceOrderButton.waitFor({ state: 'visible' }).then(() => 'iframe'),
        iframeParentalPin.waitFor({ state: 'visible' }).then(() => 'iframe'),
        iframeUnavailable.waitFor({ state: 'visible' }).then(() => 'iframe'),
      ]);
      if (checkoutStep == 'in-library') {
        recordClaimed('  Claimed successfully! Button changed to In Library.');
        const p = screenshot(`${game_id}.png`);
        if (!existsSync(p)) await page.screenshot({ path: p, fullPage: false }); // fullPage is quite long...
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }
      if (checkoutStep == 'add-to-library' || checkoutStep == 'iframe-add-to-library') {
        if (cfg.debug) await page.pause();
        if (cfg.dryrun) {
          console.log('  DRYRUN=1 -> Skip order!');
          notify_game.status = 'skipped';
          if (cfg.time) console.timeEnd('claim game');
          continue;
        }
        if (cfg.interactive && !await confirm()) {
          if (cfg.time) console.timeEnd('claim game');
          continue;
        }

        try {
          console.log('  Checkout ready! Click Add to library');
          await clickCheckoutAddToLibraryButton(checkoutStep == 'iframe-add-to-library' ? iframe : page);
          const completionSignal = await waitForCheckoutCompletion(page, checkoutStep == 'iframe-add-to-library' ? iframe : null);
          recordClaimed(completionSignal == 'in-library'
            ? '  Claimed successfully! Button changed to In Library.'
            : undefined);
        } catch (e) {
          if (await isInLibraryButton(page)) {
            recordClaimed('  Claimed successfully! Button changed to In Library after checkout timeout.');
          } else {
            console.log(e);
            console.error('  Failed to claim! To avoid captchas try to get a new IP address.');
            const p = screenshot('failed', `${game_id}_${filenamify(datetime())}.png`);
            await page.screenshot({ path: p, fullPage: true });
            db.data[user][game_id].status = 'failed';
            addManualAction({
              type: 'claim-failed',
              title,
              sourceStore: 'epic-games',
              provider: 'epic-games',
              providerKey: providerKey('epic-games'),
              targetProvider: 'epic-games',
              targetProviderKey: providerKey('epic-games'),
              url,
              claimUrl: url,
              actionUrl: url,
              message: 'Epic checkout failed. Retry this claim manually.',
            });
          }
        }
        notify_game.status = db.data[user][game_id].status; // claimed or failed
        if (notify_game.status == 'failed') notify_game.details = `<a href="${url}">View game</a>`;

        const p = screenshot(`${game_id}.png`);
        if (!existsSync(p)) await page.screenshot({ path: p, fullPage: false }); // fullPage is quite long...
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }
      // skip game if unavailable in region, https://github.com/vogler/free-games-claimer/issues/46 TODO check games for account's region
      if (await iframe.locator(':has-text("unavailable in your region")').count() > 0) {
        console.error('  This product is unavailable in your region!');
        db.data[user][game_id].status = notify_game.status = 'unavailable-in-region';
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }

      iframe.locator('.payment-pin-code').waitFor().then(async () => {
        missingParentalPin = !cfg.eg_parentalpin;
        if (!cfg.eg_parentalpin) {
          console.error('  EG_PARENTALPIN not set. Need to enter Parental Control PIN manually.');
          notify('epic-games: EG_PARENTALPIN not set. Need to enter Parental Control PIN manually.');
        }
        await iframe.locator('input.payment-pin-code__input').first().pressSequentially(cfg.eg_parentalpin);
        await iframe.locator('button:has-text("Continue")').click({ delay: 11 });
      }).catch(_ => { });

      if (cfg.debug) await page.pause();
      if (cfg.dryrun) {
        console.log('  DRYRUN=1 -> Skip order!');
        notify_game.status = 'skipped';
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }
      if (cfg.interactive && !await confirm()) {
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }

      // Playwright clicked before button was ready to handle event, https://github.com/vogler/free-games-claimer/issues/84#issuecomment-1474346591
      await iframePlaceOrderButton.first().click({ delay: 11 });

      // I Agree button is only shown for EU accounts! https://github.com/vogler/free-games-claimer/pull/7#issuecomment-1038964872
      const btnAgree = iframe.locator('button:has-text("I Accept")');
      btnAgree.waitFor().then(() => btnAgree.click()).catch(_ => { }); // EU: wait for and click 'I Agree'
      try {
        // context.setDefaultTimeout(100 * 1000); // give time to solve captcha, iframe goes blank after 60s?
        const captcha = iframe.locator('#h_captcha_challenge_checkout_free_prod iframe');
        captcha.waitFor().then(async () => { // don't await, since element may not be shown
          sawCaptcha = true;
          // console.info('  Got hcaptcha challenge! NopeCHA extension will likely solve it.')
          console.error('  Got hcaptcha challenge! Lost trust due to too many login attempts? You can solve the captcha in the browser or get a new IP address.');
          // await notify(`epic-games: got captcha challenge right before claim of <a href="${url}">${title}</a>. Solve it manually in the visible browser.`); // TODO not all apprise services understand HTML: https://github.com/vogler/free-games-claimer/pull/417
          await notify(`epic-games: got captcha challenge for.\nGame link: ${url}`);
          // TODO could even create purchase URL, see https://github.com/vogler/free-games-claimer/pull/130
          // await page.waitForTimeout(2000);
          // const p = path.resolve(cfg.dir.screenshots, 'epic-games', 'captcha', `${filenamify(datetime())}.png`);
          // await captcha.screenshot({ path: p });
          // console.info('  Saved a screenshot of hcaptcha challenge to', p);
          // console.error('  Got hcaptcha challenge. To avoid it, get a link from https://www.hcaptcha.com/accessibility'); // TODO save this link in config and visit it daily to set accessibility cookie to avoid captcha challenge?
        }).catch(_ => { }); // may time out if not shown
        iframe.locator('.payment__errors:has-text("Failed to challenge captcha, please try again later.")').waitFor().then(async () => {
          sawCaptcha = true;
          console.error('  Failed to challenge captcha, please try again later.');
          await notify('epic-games: failed to challenge captcha. Please check.');
        }).catch(_ => { });
        const completionSignal = await waitForCheckoutCompletion(page, iframe); // TODO Bundle: got stuck here, but normal game now as well
        recordClaimed(completionSignal == 'in-library'
          ? '  Claimed successfully! Button changed to In Library.'
          : undefined);
        // context.setDefaultTimeout(cfg.timeout);
      } catch (e) {
        if (await isInLibraryButton(page)) {
          recordClaimed('  Claimed successfully! Button changed to In Library after checkout timeout.');
        } else {
          console.log(e);
          // console.error('  Failed to claim! Try again if NopeCHA timed out. Click the extension to see if you ran out of credits (refill after 24h). To avoid captchas try to get a new IP or set a cookie from https://www.hcaptcha.com/accessibility');
          console.error('  Failed to claim! To avoid captchas try to get a new IP address.');
          const p = screenshot('failed', `${game_id}_${filenamify(datetime())}.png`);
          await page.screenshot({ path: p, fullPage: true });
          db.data[user][game_id].status = 'failed';
          notify_game.captcha = sawCaptcha;
          addManualAction({
            type: sawCaptcha ? 'captcha' : missingParentalPin ? 'parental-pin' : 'claim-failed',
            title,
            sourceStore: 'epic-games',
            provider: 'epic-games',
            providerKey: providerKey('epic-games'),
            targetProvider: 'epic-games',
            targetProviderKey: providerKey('epic-games'),
            url,
            claimUrl: url,
            actionUrl: url,
            message: sawCaptcha
              ? 'Epic checkout showed a captcha. Solve it in the browser or retry manually.'
              : missingParentalPin
                ? 'Epic checkout requires a Parental Control PIN.'
                : 'Epic checkout failed. Retry this claim manually.',
          });
        }
      }
      notify_game.status = db.data[user][game_id].status; // claimed or failed
      if (notify_game.status == 'failed') {
        notify_game.details = sawCaptcha
          ? `Captcha blocked claim. <a href="${url}">View game</a>`
          : `<a href="${url}">View game</a>`;
      }

      const p = screenshot(`${game_id}.png`);
      if (!existsSync(p)) await page.screenshot({ path: p, fullPage: false }); // fullPage is quite long...
    }
    if (cfg.time) console.timeEnd('claim game');
  }

  const failedGames = notify_games.filter(g => g.status == 'failed');
  if (failedGames.length && Object.keys(offerIdMap).length) {
    const failedOfferIds = [...new Set(failedGames.map(g => offerIdMap[offerSlugFromValue(g.url)]).filter(Boolean))];
    if (cfg.debug) {
      const unmatched = failedGames.filter(g => !offerIdMap[offerSlugFromValue(g.url)]);
      if (unmatched.length) console.debug('  Cart fallback unmatched slugs:', unmatched.map(g => offerSlugFromValue(g.url)));
    }
    if (failedOfferIds.length) {
      const cartUrl = `https://store.epicgames.com/en-US/cart?${failedOfferIds.map(id => `offerId=${id}`).join('&')}`;
      console.log(`  Cart fallback for ${failedOfferIds.length}/${failedGames.length} failed Epic claim(s): ${cartUrl}`);
      for (const game of failedGames) {
        const offerId = offerIdMap[offerSlugFromValue(game.url)];
        if (!offerId) continue;
        const singleCartUrl = `https://store.epicgames.com/en-US/cart?offerId=${offerId}`;
        game.details = (game.details ? `${game.details}<br>  ` : '') + `<a href="${singleCartUrl}">Claim in Epic cart</a>`;
      }
      notify_games.push({ title: `Claim ${failedOfferIds.length} failed Epic game(s) in cart`, url: cartUrl, status: 'action' });
      addManualAction({
        type: 'cart-fallback',
        title: `Claim ${failedOfferIds.length} failed Epic game(s) in cart`,
        sourceStore: 'epic-games',
        provider: 'epic-games',
        providerKey: providerKey('epic-games'),
        targetProvider: 'epic-games',
        targetProviderKey: providerKey('epic-games'),
        url: cartUrl,
        claimUrl: cartUrl,
        actionUrl: cartUrl,
        message: 'Epic checkout failed, but these offer IDs can be opened in the Epic cart.',
      });
    } else {
      console.warn(`  Cart fallback could not match any of ${failedGames.length} failed Epic claim(s) to offer IDs.`);
    }
  }
} catch (error) {
  runError = error;
  if (isExitError(error)) {
    process.exitCode = error.exitCode || 0;
  } else {
    process.exitCode ||= 1;
    console.error('--- Exception:');
    console.error(error); // .toString()?
    if (error.message && process.exitCode != 130) notify(`epic-games failed: ${error.message.split('\n')[0]}`);
  }
} finally {
  if (cfg.time) console.timeEnd('claim all games');
  await db.write(); // write out json db
  await writeRunSummary(runSummary, { user, games: notify_games, manualActions: manual_actions, error: runError, exitCode: process.exitCode });
  if (notify_games.filter(g => g.status == 'claimed' || g.status == 'failed' || g.status == 'action').length) { // don't notify if all have status 'existed', 'manual', 'requires base game', 'unavailable-in-region', 'skipped'
    notify(`epic-games (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (cfg.debug) writeFileSync(path.resolve(cfg.dir.browser, 'cookies.json'), JSON.stringify(await context.cookies()));
if (page.video()) console.log('Recorded video:', await page.video().path());
await closeContextSafely(context);
