// import { firefox } from 'playwright-firefox';
import { chromium } from 'patchright';
import chalk from 'chalk';
import { abortRun, capturePageDiagnostics, createRunSummary, extensionArgs, gotoWithRetry, handleSIGINT, html_game_list, isExitError, jsonDb, notify, prompt, confirm, resolve, datetime, filenamify, waitForPromiseOrEscape, writeRunSummary } from './src/util.js';
import { cfg } from './src/config.js';
import { gpUrlToStoreUrls } from './src/gp.js';
import { smokeExit } from './src/smoke.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'gog', ...a);

const URL_CLAIM = 'https://www.gog.com/en';
const GOG_GAMERPOWER_API_URL = 'https://www.gamerpower.com/api/giveaways?platform=gog&type=game';
const GOG_USER_SELECTOR = '#menuUsername, .menu-account__user-name';
const saneGogUsername = text => {
  const value = `${text || ''}`.trim();
  if (!value || value.length > 64) return null;
  if ((/[\n\r{};<>]/).test(value)) return null;
  if ((/^@charset/i).test(value)) return null;
  if ((/\b(function|var|const|display|cookie|storage|document|window)\b/i).test(value)) return null;
  return value;
};

console.log(datetime(), 'started checking gog');
smokeExit('gog');

const db = await jsonDb('gog.json', {});

// https://playwright.dev/docs/auth#multi-factor-authentication
const context = await chromium.launchPersistentContext(cfg.dir.browser, {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US', // ignore OS locale to be sure to have english text for locators -> done via /en in URL
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined, // will record a .webm video for each page navigated; without size, video would be scaled down to fit 800x800
  recordHar: cfg.record ? { path: `data/record/gog-${filenamify(datetime())}.har` } : undefined, // will record a HAR file with network requests and responses; can be imported in Chrome devtools
  handleSIGINT: false, // have to handle ourselves and call context.close(), otherwise recordings from above won't be saved
  // https://peter.sh/experiments/chromium-command-line-switches/
  args: [
    '--hide-crash-restore-bubble',
    ...extensionArgs({ headless: cfg.headless }),
  ],
});

handleSIGINT(context);

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage(); // should always exist
await page.setViewportSize({ width: cfg.width, height: cfg.height }); // TODO workaround for https://github.com/vogler/free-games-claimer/issues/277 until Playwright fixes it
// console.debug('userAgent:', await page.evaluate(() => navigator.userAgent));

const notify_games = [];
let user;
const runSummary = createRunSummary('gog');
let runError;

async function firstVisibleHandle(locator) {
  for (const handle of await locator.elementHandles()) {
    const visible = await handle.evaluate(el => {
      const style = window.getComputedStyle(el);
      return style.display != 'none'
        && style.visibility != 'hidden'
        && !el.hasAttribute('hidden')
        && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }).catch(_ => false);
    if (visible) return handle;
  }
  return null;
}

async function textContentOrNull(locator) {
  const handles = await locator.elementHandles();
  for (const handle of handles) {
    const visible = await handle.evaluate(el => {
      const style = window.getComputedStyle(el);
      return style.display != 'none'
        && style.visibility != 'hidden'
        && !el.hasAttribute('hidden')
        && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }).catch(_ => false);
    if (!visible) continue;
    const text = saneGogUsername(await handle.textContent());
    if (text) return text;
  }
  for (const handle of handles) {
    const text = saneGogUsername(await handle.textContent());
    if (text) return text;
  }
  return null;
}

async function waitForGogSignedIn({ allowEscape = false } = {}) {
  await capturePageDiagnostics(page, 'gog-login-wait-start').catch(_ => { });
  const waitForSignedIn = (async () => {
    const deadline = Date.now() + cfg.login_timeout;
    while (Date.now() < deadline) {
      const userData = await getGogUserData();
      if (userData?.isLoggedIn === true) return;
      await page.waitForTimeout(1000);
    }
    throw new Error(`Timed out after ${cfg.login_timeout / 1000}s waiting for GOG login`);
  })();

  try {
    if (allowEscape) {
      await waitForPromiseOrEscape(waitForSignedIn, {
        message: 'Press ESC in this terminal to cancel waiting for GOG login.',
        exitCode: 0,
        exitMessage: 'GOG login cancelled interactively',
      });
    } else {
      await waitForSignedIn;
    }
  } catch (error) {
    await capturePageDiagnostics(page, 'gog-login-timeout', { fullPage: true }).catch(_ => { });
    throw error;
  }
}

async function getGogUserData() {
  return page.evaluate(async () => fetch('https://www.gog.com/userData.json', { credentials: 'include' })
    .then(response => response.json())
    .catch(_ => null));
}

async function resolveGogUser(usernameLocator) {
  const userData = await getGogUserData();
  const userDataName = saneGogUsername(userData?.username || userData?.user?.username || userData?.account?.username);
  if (userDataName) return userDataName;

  const username = (await textContentOrNull(usernameLocator))?.trim();
  if (username) return username;

  const previousUser = Object.keys(db.data || {}).at(-1);
  if (previousUser) {
    console.warn(`Could not determine GOG username from the page, falling back to ${previousUser}`);
    return previousUser;
  }

  return cfg.gog_email || null;
}

async function getGamerPowerFallback() {
  if (!cfg.gog_check_gp) return null;

  const gpGames = await gpUrlToStoreUrls(GOG_GAMERPOWER_API_URL, context);
  const gogGames = gpGames.filter(g => g.storeUrl.includes('gog.com'));
  console.log(`[GamerPower] ${gogGames.length} GOG store URLs`);
  return gogGames[0] || null;
}

try {
  if (cfg.width < 1280) { // otherwise 'Sign in' and #menuUsername are hidden (but attached to DOM), see https://github.com/vogler/free-games-claimer/issues/335
    console.error(`Window width is set to ${cfg.width} but needs to be at least 1280 for GOG!`);
    abortRun(1, 'GOG requires WIDTH >= 1280');
  }

  await context.addCookies([{ name: 'CookieConsent', value: '{stamp:%274oR8MJL+bxVlG6g+kl2we5+suMJ+Tv7I4C5d4k+YY4vrnhCD+P23RQ==%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true%2Cmethod:%27explicit%27%2Cver:1%2Cutc:1672331618201%2Cregion:%27de%27}', domain: 'www.gog.com', path: '/' }]); // to not waste screen space when non-headless

  await gotoWithRetry(page, URL_CLAIM, { waitUntil: 'domcontentloaded' }, { label: 'gog home' }); // default 'load' takes forever

  // page.click('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll').catch(_ => { }); // does not work reliably, solved by setting CookieConsent above
  const signIn = page.locator('a:has-text("Sign in")');
  // TODO for the below signIn.waitFor(), patchright failed most of the time with: locator.waitFor: JSHandles can be evaluated only in the context they were created!
  // await Promise.any([signIn.waitFor(), page.waitForSelector('#menuUsername')]);
  const username = page.locator(GOG_USER_SELECTOR);
  while (await firstVisibleHandle(signIn) && !await firstVisibleHandle(username)) {
    const userData = await getGogUserData();
    if (userData?.isLoggedIn === true) break;

    const hasStoredCredentials = !!(cfg.gog_email && cfg.gog_password);
    console.error('Not signed!');
    if (cfg.nowait) abortRun(1, 'GOG login required and NOWAIT=1');
    if (!await page.locator('#GalaxyAccountsFrameContainer iframe').count().catch(_ => 0)) {
      await (await firstVisibleHandle(signIn)).click();
    }
    // it then creates an iframe for the login
    await page.waitForSelector('#GalaxyAccountsFrameContainer iframe'); // TODO needed?
    const iframe = page.frameLocator('#GalaxyAccountsFrameContainer iframe');
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout); // give user some extra time to log in
    console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);
    if (hasStoredCredentials) {
      console.info('Using email and password from environment.');
      // iframe.locator('a[href="/logout"]').click().catch(_ => { }); // Click 'Change account' (email from previous login is set in some cookie)
      // TODO above didn't work with patchright
      if (!await iframe.locator('#login_username').isDisabled()) {
        await iframe.locator('#login_username').fill(cfg.gog_email);
      }
      await iframe.locator('#login_password').fill(cfg.gog_password);
      await iframe.locator('#login_login').click();
      await page.waitForTimeout(2000); // TODO patchright waits forever for MFA locator otherwise
      // handle MFA, but don't await it
      iframe.locator('form[name=second_step_authentication]').waitFor().then(async () => {
        console.log('Two-Step Verification - Enter security code');
        console.log(await iframe.locator('.form__description').innerText());
        const otp = await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 4 || 'The code must be 4 digits!' }); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
        await iframe.locator('#second_step_authentication_token_letter_1').pressSequentially(otp.toString(), { delay: 10 });
        await iframe.locator('#second_step_authentication_send').click();
        await page.waitForTimeout(1000); // TODO still needed with wait for username below?
      }).catch(_ => { });
      // iframe.locator('iframe[title=reCAPTCHA]').waitFor().then(() => {
      // iframe.locator('.g-recaptcha').waitFor().then(() => {
      iframe.locator('text=Invalid captcha').waitFor().then(() => {
        console.error('Got a captcha during login (likely due to too many attempts)! You may solve it in the browser, get a new IP or try again in a few hours.');
        notify('gog: got captcha during login. Please check.');
        // TODO solve reCAPTCHA?
      }).catch(_ => { });
      await waitForGogSignedIn();
    } else if (cfg.headless) {
      console.info('No stored GOG credentials found. Using terminal prompts because the browser is hidden.');
      const email = await prompt({ message: 'Enter email' });
      const password = email && await prompt({ type: 'password', message: 'Enter password' });
      if (email && password) {
        if (!await iframe.locator('#login_username').isDisabled()) {
          await iframe.locator('#login_username').fill(email);
        }
        await iframe.locator('#login_password').fill(password);
        await iframe.locator('#login_login').click();
        await waitForGogSignedIn();
      } else {
        console.log('Run `SHOW=1 node gog` to login in the opened browser.');
        await context.close();
        abortRun(1, 'GOG login required in shown browser');
      }
    } else {
      console.log('Waiting for you to login in the browser. Enter your GOG credentials in the opened window.');
      await notify('gog: no longer signed in and not enough options set for automatic login.');
      await waitForGogSignedIn({ allowEscape: true });
    }
    await gotoWithRetry(page, URL_CLAIM, { waitUntil: 'domcontentloaded' }, { label: 'gog home after login' });
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  user = await resolveGogUser(username); // innerText is uppercase due to styling!
  if (!user) abortRun(1, 'Unable to determine signed-in GOG user');
  console.log(`Signed in as ${user}`);
  db.data[user] ||= {};

  const banner = page.locator('#giveaway');
  await page.waitForTimeout(2000); // TODO patchright sometimes missed banner otherwise
  const bannerCount = await banner.count();
  let fallbackGiveaway = null;
  if (!bannerCount && cfg.gog_check_gp) {
    fallbackGiveaway = await getGamerPowerFallback();
  }

  if (!bannerCount && !fallbackGiveaway) {
    console.log('Currently no free giveaway!');
  } else {
    let title;
    let url;
    if (bannerCount) {
      const text = await page.locator('.giveaway__content-header').innerText();
      const match_all = text.match(/Claim (.*) and don't miss the|Success! (.*) was added to/);
      title = match_all[1] ? match_all[1] : match_all[2];
      url = await banner.locator('a').first().getAttribute('href');
    } else {
      url = fallbackGiveaway.storeUrl;
      console.log(`[GamerPower] Trying fallback giveaway: ${url}`);
      await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded' }, { label: `gog fallback giveaway ${url}` });
      title = await page.locator('h1').first().innerText().catch(_ => fallbackGiveaway.title);
    }
    console.log(`Current free game: ${chalk.blue(title)} - ${url}`);
    db.data[user][title] ||= { title, time: datetime(), url };
    if (cfg.dryrun) abortRun(1, 'GOG DRYRUN=1');
    if (cfg.interactive && !await confirm()) abortRun(0, 'GOG claim cancelled interactively');
    // await page.locator('#giveaway:not(.is-loading)').waitFor(); // otherwise screenshot is sometimes with loading indicator instead of game title; #TODO fix, skipped due to timeout, see #240
    if (bannerCount) {
      await banner.screenshot({ path: screenshot(`${filenamify(title)}.png`) }); // overwrites every time - only keep first?
    } else {
      await page.screenshot({ path: screenshot(`${filenamify(title)}.png`), fullPage: false });
    }

    // await banner.getByRole('button', { name: 'Add to library' }).click();
    // instead of clicking the button, we visit the auto-claim URL which gives as a JSON response which is easier than checking the state of a button
    await gotoWithRetry(page, 'https://www.gog.com/giveaway/claim', {}, { label: 'gog giveaway claim endpoint' });
    const response = await page.innerText('body');
    // console.log(response);
    // {} // when successfully claimed
    // {"message":"Already claimed"}
    // {"message":"Unauthorized"}
    // {"message":"Giveaway has ended"}
    let status;
    if (response == '{}') {
      status = 'claimed';
      console.log('  Claimed successfully!');
    } else {
      const message = JSON.parse(response).message;
      if (message == 'Already claimed') {
        status = 'existed'; // same status text as for epic-games
        console.log('  Already in library! Nothing to claim.');
      } else if (message == 'Unauthorized') {
        status = 'failed: Unauthorized';
        console.warn('  GOG claim endpoint says Unauthorized. Refresh the GOG login in the visible helper.');
      } else {
        console.log(response);
        status = message;
      }
    }
    db.data[user][title].status ||= status;
    notify_games.push({ title, url, status });

    if (status == 'claimed' && !cfg.gog_newsletter) {
      console.log('Unsubscribe from \'Promotions and hot deals\' newsletter');
      await gotoWithRetry(page, 'https://www.gog.com/en/account/settings/subscriptions', {}, { label: 'gog newsletter settings' });
      await page.locator('li:has-text("Marketing communications through Trusted Partners") label').uncheck();
      await page.locator('li:has-text("Promotions and hot deals") label').uncheck();
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
    if (error.message && process.exitCode != 130) notify(`gog failed: ${error.message.split('\n')[0]}`);
  }
} finally {
  await db.write(); // write out json db
  await writeRunSummary(runSummary, { user, games: notify_games, error: runError, exitCode: process.exitCode });
  if (notify_games.filter(g => g.status != 'existed').length) { // don't notify if all were already claimed
    notify(`gog (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (page.video()) console.log('Recorded video:', await page.video().path());
await context.close();
