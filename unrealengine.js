// New assets to claim every first Tuesday of a month.

import { chromium } from 'patchright';
import { authenticator } from 'otplib';
import path from 'path';
import { existsSync, writeFileSync } from 'fs';
import { abortRun, createRunSummary, gotoWithRetry, handleSIGINT, html_game_list, isExitError, jsonDb, notify, prompt, resolve, datetime, filenamify, writeRunSummary } from './src/util.js';
import { cfg } from './src/config.js';
import { smokeExit } from './src/smoke.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'unrealengine', ...a);

const URL_CLAIM = 'https://www.fab.com/limited-time-free';
const URL_LOGIN = 'https://www.epicgames.com/id/login?lang=en-US&noHostRedirect=true&redirectUrl=' + encodeURIComponent(URL_CLAIM);

console.log(datetime(), 'started checking unrealengine');
smokeExit('unrealengine');

const db = await jsonDb('unrealengine.json', {});

// https://playwright.dev/docs/auth#multi-factor-authentication
const context = await chromium.launchPersistentContext(cfg.dir.browser, {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US',
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined,
  recordHar: cfg.record ? { path: `data/record/ue-${filenamify(datetime())}.har` } : undefined,
  handleSIGINT: false,
  args: [
    '--hide-crash-restore-bubble',
  ],
});

handleSIGINT(context);

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage();
await page.setViewportSize({ width: cfg.width, height: cfg.height });

const notify_games = [];
let user;
const runSummary = createRunSummary('unrealengine');
let runError;

const normalizeFabUrl = url => url?.split(/[?#]/)[0].replace(/\/$/, '');

async function isFabLoggedIn() {
  const egsNav = page.locator('egs-navigation');
  if (await egsNav.count() > 0) {
    return await egsNav.getAttribute('isloggedin') == 'true';
  }
  return await page.locator('a[href="/library"]').count() > 0;
}

async function getFabUser() {
  const egsNav = page.locator('egs-navigation');
  if (await egsNav.count() > 0) {
    const displayname = await egsNav.getAttribute('displayname');
    if (displayname && displayname != 'null') return displayname;
  }
  return cfg.eg_email || 'fab-user';
}

async function chooseFabLicense() {
  const opener = page.locator('button.fabkit-InputContainer-root').first();
  if (await opener.count() == 0) return;

  const chooseOption = async label => {
    await opener.click().catch(_ => { });
    const option = page.locator(`text=${label}`).first();
    if (await option.count() == 0) {
      await page.keyboard.press('Escape').catch(_ => { });
      return false;
    }
    await option.click();
    await page.waitForTimeout(500);
    return true;
  };

  // Prefer the safer free Personal path when Fab requires an explicit license choice.
  if (await chooseOption('Personal')) return;
  if (await chooseOption('Professional')) {
    const pageText = await page.locator('body').innerText();
    if (!pageText.includes('Free')) {
      throw new Error('Fab item does not appear to be free after selecting Professional license.');
    }
  }
}

try {
  await context.addCookies([
    { name: 'OptanonAlertBoxClosed', value: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), domain: '.epicgames.com', path: '/' },
  ]);

  await gotoWithRetry(page, URL_CLAIM, { waitUntil: 'domcontentloaded' }, { label: 'fab limited-time-free' });
  page.locator('button:has-text("Continue")').click().catch(_ => { });

  while (!await isFabLoggedIn()) {
    console.error('Not signed in anymore. Please login in the browser or here in the terminal.');
    if (cfg.novnc_port) console.info(`Open http://localhost:${cfg.novnc_port} to login inside the docker container.`);
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout);
    console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);
    await gotoWithRetry(page, URL_LOGIN, { waitUntil: 'domcontentloaded' }, { label: 'fab login' });
    if (cfg.eg_email && cfg.eg_password) console.info('Using email and password from environment.');
    else console.info('Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode).');
    const email = cfg.eg_email || await prompt({ message: 'Enter email' });
    const password = email && (cfg.eg_password || await prompt({ type: 'password', message: 'Enter password' }));
    if (email && password) {
      await page.fill('#email', email);
      await page.click('button[type="submit"]');
      await page.fill('#password', password);
      await page.click('button[type="submit"]');
      page.waitForSelector('#h_captcha_challenge_login_prod iframe').then(() => {
        console.error('Got a captcha during login (likely due to too many attempts)! You may solve it in the browser, get a new IP or try again in a few hours.');
        notify('unrealengine: got captcha during login. Please check.');
      }).catch(_ => { });
      page.waitForURL('**/id/login/mfa**').then(async () => {
        console.log('Enter the security code to continue - This appears to be a new device, browser or location.');
        const otp = cfg.eg_otpkey && authenticator.generate(cfg.eg_otpkey) || await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 6 || 'The code must be 6 digits!' });
        await page.locator('input[name="code-input-0"]').pressSequentially(otp.toString());
        await page.click('button[type="submit"]');
      }).catch(_ => { });
    } else {
      console.log('Waiting for you to login in the browser.');
      await notify('unrealengine: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        console.log('Run `SHOW=1 node unrealengine` to login in the opened browser.');
        await context.close();
        abortRun(1, 'Fab login required in shown browser');
      }
    }
    await page.waitForURL('**fab.com/**');
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }

  await page.waitForTimeout(1000);
  user = await getFabUser();
  console.log(`Signed in as ${user}`);
  db.data[user] ||= {};

  page.locator('button:has-text("Accept All Cookies")').click().catch(_ => { });
  await page.waitForTimeout(1500);
  const urls = [...new Set((await Promise.all((await page.locator('main a[href^="/listings/"]').all()).map(link => link.getAttribute('href'))))
    .filter(Boolean)
    .map(link => normalizeFabUrl(new URL(link, 'https://www.fab.com').toString())))];

  if (!urls.length) {
    console.log('Nothing to claim');
  } else {
    console.log('Free items:', urls);
  }

  for (const url of urls) {
    const gameId = url.split('/').pop();
    if (db.data[user][gameId]?.status == 'claimed') {
      console.log('Already claimed, skipping:', url);
      continue;
    }

    await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded' }, { label: `fab listing ${url}` });
    await page.locator('h1').first().waitFor().catch(_ => { });
    await page.waitForTimeout(1000);

    const title = await page.locator('h1').first().innerText().catch(_ => gameId);
    const existedInDb = db.data[user][gameId];
    db.data[user][gameId] ||= { title, time: datetime(), url };
    console.log('Current free item:', title);
    const notify_game = { title, url, status: 'failed' };
    notify_games.push(notify_game);

    if (await page.locator('h2:has-text("Saved in My Library"), text=Saved in My Library').count() > 0) {
      console.log('  Already in library! Nothing to claim.');
      if (!existedInDb) await notify(`Item already in library: ${url}`);
      notify_game.status = 'existed';
      db.data[user][gameId].status ||= 'existed';
      if (db.data[user][gameId].status?.startsWith('failed')) db.data[user][gameId].status = 'manual';
      continue;
    }

    if (cfg.debug) await page.pause();
    if (cfg.dryrun) {
      console.log('  DRYRUN=1 -> Skip claim!');
      notify_game.status = 'skipped';
      continue;
    }

    await chooseFabLicense();
    const buyButton = page.locator('button:has-text("Buy now")').first();
    await buyButton.waitFor({ timeout: 10000 });
    console.log('  Clicking Buy now...');
    await buyButton.click({ delay: 11 });

    try {
      await page.waitForSelector('h2:has-text("Saved in My Library"), text=Saved in My Library', { timeout: 30000 });
      db.data[user][gameId].status = 'claimed';
      db.data[user][gameId].time = datetime();
      notify_game.status = 'claimed';
      console.log('  Claimed successfully!');
    } catch (error) {
      console.error('  Failed to claim!', error);
      const failedPath = screenshot('failed', `${gameId}_${filenamify(datetime())}.png`);
      if (failedPath) await page.screenshot({ path: failedPath, fullPage: true });
      db.data[user][gameId].status = 'failed';
      notify_game.status = 'failed';
    }

    const itemShot = screenshot(`${gameId}.png`);
    if (itemShot && !existsSync(itemShot)) await page.screenshot({ path: itemShot, fullPage: false });
  }
} catch (error) {
  runError = error;
  if (isExitError(error)) {
    process.exitCode = error.exitCode || 0;
  } else {
    process.exitCode ||= 1;
    console.error('--- Exception:');
    console.error(error);
    if (error.message && process.exitCode != 130) notify(`unrealengine failed: ${error.message.split('\n')[0]}`);
  }
} finally {
  await db.write();
  await writeRunSummary(runSummary, { user, games: notify_games, error: runError, exitCode: process.exitCode });
  if (notify_games.filter(g => g.status != 'existed').length) {
    notify(`unrealengine (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (cfg.debug) writeFileSync(path.resolve(cfg.dir.browser, 'cookies.json'), JSON.stringify(await context.cookies()));
if (page.video()) console.log('Recorded video:', await page.video().path());
await context.close();
