// https://stackoverflow.com/questions/46745014/alternative-for-dirname-in-node-js-when-using-es6-modules
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, lstatSync, unlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
// not the same since these will give the absolute paths for this file instead of for the file using them
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// explicit object instead of Object.fromEntries since the built-in type would loose the keys, better type: https://dev.to/svehla/typescript-object-fromentries-389c
export const dataDir = s => path.resolve(__dirname, '..', 'data', s);

// modified path.resolve to return null if first argument is '0', used to disable screenshots
export const resolve = (...a) => a.length && a[0] == '0' ? null : path.resolve(...a);

// json database
import { JSONFilePreset } from 'lowdb/node';
export const jsonDb = (file, defaultData) => JSONFilePreset(dataDir(file), defaultData);

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// date and time as UTC (no timezone offset) in nicely readable and sortable format, e.g., 2022-10-06 12:05:27.313
export const datetimeUTC = (d = new Date()) => d.toISOString().replace('T', ' ').replace('Z', '');
// same as datetimeUTC() but for local timezone, e.g., UTC + 2h for the above in DE
export const datetime = (d = new Date()) => datetimeUTC(new Date(d.getTime() - d.getTimezoneOffset() * 60000));
export const filenamify = s => s.replaceAll(':', '.').replace(/[^a-z0-9 _\-.]/gi, '_'); // alternative: https://www.npmjs.com/package/filenamify - On Unix-like systems, / is reserved. On Windows, <>:"/\|?* along with trailing periods are reserved.

export const cleanProfileLocks = profileDir => {
  if (!profileDir || !existsSync(profileDir)) return [];
  const removed = [];
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const lockPath = path.join(profileDir, name);
    try {
      const stat = lstatSync(lockPath, { throwIfNoEntry: false });
      if (!stat) continue;
      unlinkSync(lockPath);
      removed.push(name);
    } catch {
      // Best effort: if a live browser owns the lock, launchPersistentContext
      // will fail with the clearer Chromium error.
    }
  }
  return removed;
};

export const closeContextSafely = async (context, timeoutMs = 15000) => {
  const closed = await Promise.race([
    context.close().then(() => true, () => true),
    delay(timeoutMs).then(() => false),
  ]);
  if (!closed) console.warn(`context.close() timed out after ${timeoutMs}ms; letting the process exit.`);
  return closed;
};

const RETRYABLE_NAVIGATION_ERROR_PARTS = [
  'timeout',
  'navigation',
  'net::',
  'ns_error',
  'econn',
  'socket',
];

const isRetryableNavigationError = error => {
  const message = `${error?.message || error || ''}`.toLowerCase();
  if (!message) return true;
  if (message.includes('target page, context or browser has been closed')) return false;
  return RETRYABLE_NAVIGATION_ERROR_PARTS.some(part => message.includes(part));
};

export const gotoWithRetry = async (page, url, options = {}, { label = url, retries = 2, baseDelayMs = 1500 } = {}) => {
  const maxAttempts = retries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await page.goto(url, options);
    } catch (error) {
      if (attempt == maxAttempts || !isRetryableNavigationError(error)) throw error;
      const waitMs = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[retry] page.goto failed for ${label} (attempt ${attempt}/${maxAttempts}): ${(error.message || error).split('\n')[0]}`);
      await delay(waitMs);
    }
  }
};

export class ExitError extends Error {
  constructor(code = 1, message = '') {
    super(message || `Exit ${code}`);
    this.name = 'ExitError';
    this.exitCode = code;
  }
}

export const abortRun = (code = 1, message = '') => {
  throw new ExitError(code, message);
};

export const isExitError = error => error instanceof ExitError || Number.isInteger(error?.exitCode);

const stripHtml = value => `${value || ''}`.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

const summarizeRunGames = games => {
  const counts = { total: games.length, claimed: 0, existed: 0, failed: 0, skipped: 0, other: 0 };

  for (const game of games) {
    const status = stripHtml(game?.status);
    if (!status) {
      counts.other++;
    } else if (status.includes('failed')) {
      counts.failed++;
    } else if (status.includes('claimed') || status.includes('redeemed')) {
      counts.claimed++;
    } else if (status.includes('existed') || status.includes('already')) {
      counts.existed++;
    } else if (status.includes('skipped') || status.includes('manual')) {
      counts.skipped++;
    } else {
      counts.other++;
    }
  }

  return counts;
};

const deriveRunStatus = ({ error, exitCode, counts }) => {
  const badExit = (exitCode ?? 0) !== 0;
  if (badExit || error && !isExitError(error)) return counts.claimed ? 'partial' : 'error';
  if (counts.failed) return counts.claimed ? 'partial' : 'warning';
  if (counts.claimed) return 'ok';
  return 'noop';
};

const normalizeRunAction = (action, runStore = null) => {
  if (!action || typeof action != 'object') return null;

  const normalized = {};
  if (runStore) normalized.sourceStore = action.sourceStore || runStore;
  for (const [key, value] of Object.entries(action)) {
    if (value === null || value === undefined || value === '') continue;
    normalized[key] = value;
  }

  return Object.keys(normalized).length ? normalized : null;
};

const summarizeRunActions = (actions, runStore = null) => {
  const seen = new Set();

  return actions
    .map(action => normalizeRunAction(action, runStore))
    .filter(Boolean)
    .filter(action => {
      const key = JSON.stringify(action);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

const appendManualActionHistory = async ({ run, user, finishedAt, actions }) => {
  const db = await jsonDb('manual-actions.json', { updatedAt: null, entries: [] });
  db.data.updatedAt = finishedAt;

  for (const action of actions) {
    db.data.entries.push({
      detectedAt: finishedAt,
      runStore: run.store,
      runStartedAt: run.startedAt,
      runFinishedAt: finishedAt,
      user,
      ...action,
    });
  }

  await db.write();
};

export const createRunSummary = store => ({
  store,
  startedAt: new Date().toISOString(),
  startedMs: Date.now(),
});

export const writeRunSummary = async (run, { user = null, games = [], manualActions = [], error = null, exitCode = process.exitCode, extra = {} } = {}) => {
  const db = await jsonDb('last-run.json', { updatedAt: null, stores: {} });
  const previous = db.data.stores[run.store] || {};
  const finishedAt = new Date().toISOString();
  const counts = summarizeRunGames(games);
  const actions = summarizeRunActions(manualActions, run.store);
  const status = deriveRunStatus({ error, exitCode, counts });
  const errorText = error ? `${error.message || error}`.split('\n')[0] : null;

  db.data.updatedAt = finishedAt;
  db.data.stores[run.store] = {
    store: run.store,
    status,
    startedAt: run.startedAt,
    finishedAt,
    durationMs: Date.now() - run.startedMs,
    exitCode: exitCode ?? 0,
    user: user || previous.user || null,
    counts,
    manualActionCount: actions.length,
    manualActions: actions,
    lastError: status == 'error' || status == 'partial' || status == 'warning'
      ? errorText || (counts.failed ? `${counts.failed} failed item(s)` : previous.lastError || null)
      : null,
    lastSuccessAt: status == 'error' ? previous.lastSuccessAt || null : finishedAt,
    ...extra,
  };
  await db.write();
  if (actions.length) {
    await appendManualActionHistory({
      run,
      user: user || previous.user || null,
      finishedAt,
      actions,
    });
  }
};

export const handleSIGINT = (context = null) => process.on('SIGINT', async () => { // e.g. when killed by Ctrl-C
  console.error('\nInterrupted by SIGINT. Exit!'); // Exception shows where the script was:\n'); // killed before catch in docker...
  process.exitCode = 130; // 128+SIGINT to indicate to parent that process was killed
  if (context) await closeContextSafely(context); // in order to save recordings also on SIGINT, we need to disable Playwright's handleSIGINT and close the context ourselves
  process.exit(process.exitCode);
});

export const launchChromium = async options => {
  const { chromium } = await import('playwright-chromium'); // stealth plugin needs no outdated playwright-extra

  // https://www.nopecha.com extension source from https://github.com/NopeCHA/NopeCHA/releases/tag/0.1.16
  // const ext = path.resolve('nopecha'); // used in Chromium, currently not needed in Firefox

  const context = chromium.launchPersistentContext(cfg.dir.browser, {
    // chrome will not work in linux arm64, only chromium
    // channel: 'chrome', // https://playwright.dev/docs/browsers#google-chrome--microsoft-edge
    args: [ // https://peter.sh/experiments/chromium-command-line-switches
      // don't want to see bubble 'Restore pages? Chrome didn't shut down correctly.'
      // '--restore-last-session', // does not apply for crash/killed
      '--hide-crash-restore-bubble',
      // `--disable-extensions-except=${ext}`,
      // `--load-extension=${ext}`,
    ],
    // ignoreDefaultArgs: ['--enable-automation'], // remove default arg that shows the info bar with 'Chrome is being controlled by automated test software.'. Since Chromeium 106 this leads to show another info bar with 'You are using an unsupported command-line flag: --no-sandbox. Stability and security will suffer.'.
    ...options,
  });
  return context;
};

export const extensionArgs = ({ headless = false } = {}) => {
  const args = [];
  if (!headless && cfg.start_minimized) {
    args.push('--start-minimized');
  }

  if (cfg.chrome_debugging_port) {
    args.push(`--remote-debugging-port=${cfg.chrome_debugging_port}`);
    console.log(`Chrome DevTools Protocol listening on http://127.0.0.1:${cfg.chrome_debugging_port}`);
  }

  const dirs = cfg.dir.extensions;
  if (!dirs.length) return args;
  if (headless && !cfg.extensions_in_headless) {
    console.warn('Skipping Chromium extensions in headless mode. Set EXTENSIONS_IN_HEADLESS=1 to opt in.');
    return args;
  }

  const existingDirs = dirs.filter(dir => {
    if (existsSync(dir)) return true;
    console.warn(`Extension directory does not exist, skipping: ${dir}`);
    return false;
  });
  if (!existingDirs.length) return args;

  const extensions = existingDirs.join(',');
  console.log('Loading Chromium extensions:', existingDirs);
  return [
    ...args,
    `--disable-extensions-except=${extensions}`,
    `--load-extension=${extensions}`,
  ];
};

export const capturePageDiagnostics = async (page, label, { fullPage = false } = {}) => {
  const debugDir = resolve(cfg.dir.screenshots, 'debug');
  if (!debugDir) return null;

  await mkdir(debugDir, { recursive: true });
  const safeLabel = filenamify(`${datetime()} ${label}`);
  const screenshotPath = path.join(debugDir, `${safeLabel}.png`);
  const jsonPath = path.join(debugDir, `${safeLabel}.json`);
  const bodyText = await page.locator('body').innerText({ timeout: 1500 }).catch(_ => '');
  const visibleElements = await page.evaluate(() => {
    const isVisible = el => {
      const style = window.getComputedStyle(el);
      return style.display != 'none'
        && style.visibility != 'hidden'
        && !el.hasAttribute('hidden')
        && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };

    return Array.from(document.querySelectorAll('a, button, input, [role="button"], [data-a-target], #menuUsername, .menu-account__user-name'))
      .filter(isVisible)
      .slice(0, 80)
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        id: el.id || null,
        name: el.getAttribute('name') || null,
        type: el.getAttribute('type') || null,
        href: el.getAttribute('href') || null,
        dataTarget: el.getAttribute('data-a-target') || null,
        role: el.getAttribute('role') || null,
      }));
  }).catch(error => [{ error: `${error.message || error}`.split('\n')[0] }]);

  await page.screenshot({ path: screenshotPath, fullPage }).catch(error => {
    console.warn(`[diagnostics] Failed to capture screenshot for ${label}: ${error.message.split('\n')[0]}`);
  });
  await writeFile(jsonPath, JSON.stringify({
    label,
    capturedAt: datetime(),
    url: page.url(),
    title: await page.title().catch(_ => null),
    bodySnippet: bodyText.replace(/\s+/g, ' ').trim().slice(0, 2500),
    visibleElements,
  }, null, 2));
  console.warn(`[diagnostics] ${label}: ${screenshotPath}`);
  console.warn(`[diagnostics] ${label}: ${jsonPath}`);
  return { screenshotPath, jsonPath };
};

export const stealth = async context => {
  // stealth with playwright: https://github.com/berstend/puppeteer-extra/issues/454#issuecomment-917437212
  // https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth/evasions
  const enabledEvasions = [
    'chrome.app',
    'chrome.csi',
    'chrome.loadTimes',
    'chrome.runtime',
    // 'defaultArgs',
    'iframe.contentWindow',
    'media.codecs',
    'navigator.hardwareConcurrency',
    'navigator.languages',
    'navigator.permissions',
    'navigator.plugins',
    // 'navigator.vendor',
    'navigator.webdriver',
    'sourceurl',
    // 'user-agent-override', // doesn't work since playwright has no page.browser()
    'webgl.vendor',
    'window.outerdimensions',
  ];
  const stealth = {
    callbacks: [],
    async evaluateOnNewDocument(...args) {
      this.callbacks.push({ cb: args[0], a: args[1] });
    },
  };
  for (const e of enabledEvasions) {
    const evasion = await import(`puppeteer-extra-plugin-stealth/evasions/${e}/index.js`);
    evasion.default().onPageCreated(stealth);
  }
  for (const evasion of stealth.callbacks) {
    await context.addInitScript(evasion.cb, evasion.a);
  }
};

// used prompts before, but couldn't cancel prompt
// alternative inquirer is big (node_modules 29MB, enquirer 9.7MB, prompts 9.8MB, none 9.4MB) and slower
// open issue: prevents handleSIGINT() to work if prompt is cancelled with Ctrl-C instead of Escape: https://github.com/enquirer/enquirer/issues/372
import Enquirer from 'enquirer'; const enquirer = new Enquirer();
const timeoutPlugin = timeout => enquirer => { // cancel prompt after timeout ms
  enquirer.on('prompt', prompt => {
    const t = setTimeout(() => {
      prompt.hint = () => 'timeout';
      prompt.cancel();
    }, timeout);
    prompt.on('submit', _ => clearTimeout(t));
    prompt.on('cancel', _ => clearTimeout(t));
  });
};
enquirer.use(timeoutPlugin(cfg.login_timeout)); // TODO may not want to have this timeout for all prompts; better extend Prompt and add a timeout prompt option
// single prompt that just returns the non-empty value instead of an object
// @ts-ignore
export const prompt = o => enquirer.prompt({ name: 'name', type: 'input', message: 'Enter value', ...o }).then(r => r.name).catch(_ => {});
export const confirm = o => prompt({ type: 'confirm', message: 'Continue?', ...o });
export const waitForPromiseOrEscape = (promise, { message = '', exitCode = 0, exitMessage = 'Cancelled interactively' } = {}) => new Promise((resolve, reject) => {
  const stdin = process.stdin;
  if (!stdin?.isTTY || typeof stdin.setRawMode != 'function') {
    promise.then(resolve, reject);
    return;
  }

  if (message) console.info(message);

  const wasRaw = !!stdin.isRaw;
  let settled = false;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    stdin.off('data', onData);
    if (!wasRaw) stdin.setRawMode(false);
    stdin.pause();
  };
  const finishResolve = value => {
    cleanup();
    resolve(value);
  };
  const finishReject = error => {
    cleanup();
    reject(error);
  };
  const onData = data => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (bytes.length == 1 && bytes[0] == 0x1b) {
      finishReject(new ExitError(exitCode, exitMessage));
    } else if (bytes.length == 1 && bytes[0] == 0x03) {
      finishReject(new ExitError(130, 'Interrupted by SIGINT'));
    }
  };

  if (!wasRaw) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', onData);
  promise.then(finishResolve, finishReject);
});

// notifications via apprise CLI
import { execFile } from 'child_process';
import { cfg } from './config.js';

export const notify = html => new Promise((resolve, reject) => {
  if (!cfg.notify) {
    if (cfg.debug) console.debug('notify: NOTIFY is not set!');
    return resolve();
  }
  // const cmd = `apprise '${cfg.notify}' ${title} -i html -b '${html}'`; // this had problems if e.g. ' was used in arg; could have `npm i shell-escape`, but instead using safer execFile which takes args as array instead of exec which spawned a shell to execute the command
  const args = [cfg.notify, '-i', 'html', '-b', `'${html}'`];
  if (cfg.notify_title) args.push(...['-t', cfg.notify_title]);
  if (cfg.debug) console.debug(`apprise ${args.map(a => `'${a}'`).join(' ')}`); // this also doesn't escape, but it's just for info
  execFile('apprise', args, (error, stdout, stderr) => {
    if (error) {
      console.log(`error: ${error.message}`);
      if (error.message.includes('command not found')) {
        console.info('Run `pip install apprise`. See https://github.com/vogler/free-games-claimer#notifications');
      }
      return reject(error);
    }
    if (stderr) console.error(`stderr: ${stderr}`);
    if (stdout) console.log(`stdout: ${stdout}`);
    resolve();
  });
});

export const escapeHtml = unsafe => unsafe.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&#039;');

export const html_game_list = games => games.map(g => {
  if (g.status == 'action') return `<b><a href="${g.url}">${escapeHtml(g.title)}</a></b>`;
  let line = `- <a href="${g.url}">${escapeHtml(g.title)}</a> (${g.status})`;
  if (g.details) line += `<br>  ${g.details}`;
  return line;
}).join('<br>');
