// import { chromium } from 'playwright-chromium';
import { chromium } from 'patchright';
import { authenticator } from 'otplib';
import chalk from 'chalk';
import { abortRun, capturePageDiagnostics, createRunSummary, delay, extensionArgs, gotoWithRetry, handleSIGINT, html_game_list, isExitError, jsonDb, notify, prompt, confirm, resolve, datetime, filenamify, writeRunSummary } from './src/util.js';
import { cfg } from './src/config.js';
import { REDEEM_OUTCOME, classifyGogLookupResponse, classifyGogPageText, classifyGogRedeemResponse, classifyLegacyPageText, isCaptchaRedeemOutcome, isConfirmedRedeemOutcome, makeRedeemResult } from './src/redeem-outcomes.js';
import { smokeExit } from './src/smoke.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'prime-gaming', ...a);

// const URL_LOGIN = 'https://www.amazon.de/ap/signin'; // wrong. needs some session args to be valid?
const BASE_URL = cfg.pg_luna_base_url;
const URL_CLAIM = `${BASE_URL}/claims/home?g=s`;

console.log(datetime(), 'started checking prime-gaming');
console.log(`Prime Gaming/Luna base URL: ${BASE_URL}`);
smokeExit('prime-gaming');

const db = await jsonDb('prime-gaming.json', {});

const redeemTargets = {
  // 'origin': 'https://www.origin.com/redeem', // TODO still needed or now only via account linking?
  'gog.com': 'https://www.gog.com/redeem',
  'microsoft store': 'https://account.microsoft.com/billing/redeem',
  xbox: 'https://account.microsoft.com/billing/redeem',
  'legacy games': 'https://www.legacygames.com/primedeal',
};
const canRedeemCode = store => store in redeemTargets;

const buildRedeemUrl = (store, code, redeemBaseUrl) => {
  if (!redeemBaseUrl) return null;
  return store == 'gog.com' ? `${redeemBaseUrl}/${code}` : redeemBaseUrl;
};

const isStableLegacyRedeemUrl = url => {
  if (!url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!(/legacygames\.com$/i).test(parsed.hostname)) return false;
  const normalized = parsed.href.replace(/\/$/, '').toLowerCase();
  return normalized != redeemTargets['legacy games'].replace(/\/$/, '').toLowerCase()
    && normalized != 'https://legacygames.com/primedeal'
    && normalized != 'https://www.legacygames.com'
    && normalized != 'https://legacygames.com';
};

const getStoredRedeemBaseUrl = entry => {
  if (!entry?.store || !entry?.code) return null;
  if (entry.store == 'legacy games') {
    // Older Legacy entries usually only kept the generic landing page, which now redirects to the homepage and
    // cannot be used to auto-fill the stored code reliably during backlog runs.
    if (!isStableLegacyRedeemUrl(entry.redeemUrl)) return null;
    return entry.redeemUrl;
  }
  return redeemTargets[entry.store] || null;
};

const isStoredCodePendingRedemption = entry => entry?.code
  && canRedeemCode(entry.store)
  && !`${entry.status || ''}`.includes('redeemed')
  && entry.redeem_outcome != REDEEM_OUTCOME.NOT_FOUND;

const isStoredCodeSelectedForPastRun = entry => cfg.pg_redeem_past_verify
  ? entry?.code && canRedeemCode(entry.store)
  : isStoredCodePendingRedemption(entry);

const auditStoredCodeCache = () => {
  const storedMatch = cfg.pg_redeem_past_match?.toLowerCase();
  const allowedStores = new Set(cfg.pg_redeem_past_stores);
  const rows = [];
  const seen = new Set();
  let pendingCount = 0;
  let storeFilteredCount = 0;
  let duplicateCount = 0;

  for (const [cachedUser, games] of Object.entries(db.data || {})) {
    for (const [title, entry] of Object.entries(games || {})) {
      if (!isStoredCodeSelectedForPastRun(entry)) continue;
      if (storedMatch && !title.toLowerCase().includes(storedMatch)) continue;
      pendingCount++;
      if (!allowedStores.has(`${entry.store || ''}`.toLowerCase())) continue;
      storeFilteredCount++;
      const key = `${entry.store || ''}`.toLowerCase() + '\0' + entry.code;
      if (seen.has(key)) {
        duplicateCount++;
        continue;
      }
      seen.add(key);
      rows.push({
        cachedUser,
        title,
        store: entry.store,
        status: entry.status || 'unknown',
        action: entry.redeem_action || 'none',
        stableUrl: getStoredRedeemBaseUrl(entry) ? 'yes' : 'no',
      });
    }
  }

  const selected = cfg.pg_redeem_past_limit > 0 ? rows.slice(0, cfg.pg_redeem_past_limit) : rows;
  console.log('\nStored external-store code audit:');
  console.log(`  ${cfg.pg_redeem_past_verify ? 'Verification candidates' : 'Pending codes'}:`, pendingCount);
  console.log('  Enabled stores:', cfg.pg_redeem_past_stores.join(', '));
  console.log('  Store-filtered candidates:', storeFilteredCount);
  console.log('  Deduplicated candidates:', rows.length);
  console.log('  Selected per current limit:', selected.length);
  if (duplicateCount) console.log('  Skipped duplicate provider/code entries:', duplicateCount);
  for (const row of selected) {
    console.log(`  - ${row.title} [${row.store}] user=${row.cachedUser} status=${row.status} action=${row.action} stableUrl=${row.stableUrl}`);
  }
};

if (cfg.pg_redeem_past_audit) {
  auditStoredCodeCache();
  console.log('Audit mode only; not launching a browser or redeeming stored codes.');
  process.exit(0);
}

// https://playwright.dev/docs/auth#multi-factor-authentication
const context = await chromium.launchPersistentContext(cfg.dir.browser, {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US', // ignore OS locale to be sure to have english text for locators
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined, // will record a .webm video for each page navigated; without size, video would be scaled down to fit 800x800
  recordHar: cfg.record ? { path: `data/record/pg-${filenamify(datetime())}.har` } : undefined, // will record a HAR file with network requests and responses; can be imported in Chrome devtools
  handleSIGINT: false, // have to handle ourselves and call context.close(), otherwise recordings from above won't be saved
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
const manual_actions = [];
let user;
const runSummary = createRunSummary('prime-gaming');
let runError;

const addManualAction = action => manual_actions.push(action);
const providerKey = provider => provider?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || null;
const checkpointDb = async reason => {
  await db.write();
  if (reason) console.log(`  Saved Prime cache checkpoint: ${reason}`);
};

const buildClaimUrl = (origin, slug) => {
  if (!slug) return slug;
  const cleanSlug = slug.split('?')[0];
  return cleanSlug.startsWith('http') ? cleanSlug : origin + cleanSlug;
};

const addRedeemManualAction = ({ title, store, url, code, redeemUrl, redeemAction }) => {
  if (['redeemed', 'already redeemed'].includes(redeemAction)) return;

  addManualAction({
    type: 'redeem-code',
    title,
    sourceStore: 'prime-gaming',
    provider: store,
    providerKey: providerKey(store),
    targetProvider: store,
    targetProviderKey: providerKey(store),
    url,
    claimUrl: url,
    actionUrl: redeemUrl,
    code,
    redeemUrl,
    message: redeemAction == 'redeem'
      ? `Redeem this code on ${store}.`
      : `Redeem requires manual follow-up: ${redeemAction}.`,
  });
};

const parseJsonResponse = async response => {
  const text = await response.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
};

const pageBodyText = async pageToInspect => (await pageToInspect.locator('body').innerText({ timeout: 1500 }).catch(_ => ''))
  .replace(/\s+/g, ' ')
  .trim();

const markRedeemAttempt = (dbEntry, result) => {
  const normalized = typeof result == 'string'
    ? makeRedeemResult(REDEEM_OUTCOME.UNKNOWN, { redeem_action: result })
    : result || makeRedeemResult(REDEEM_OUTCOME.UNKNOWN);
  dbEntry.redeem_action = normalized.redeem_action;
  dbEntry.redeem_outcome = normalized.outcome;
  dbEntry.redeem_checked_at = datetime();
};

const applyRedeemResultToEntry = (dbEntry, result, redeemUrl = null) => {
  markRedeemAttempt(dbEntry, result);
  if (redeemUrl) dbEntry.redeemUrl = redeemUrl;
  if (isConfirmedRedeemOutcome(result.outcome)) dbEntry.status = 'claimed and redeemed';
};

const sameStoredCode = (a, b) => a?.code && b?.code
  && `${a.store || ''}`.toLowerCase() == `${b.store || ''}`.toLowerCase()
  && a.code == b.code;

const canPropagateRedeemResultToDuplicate = outcome => isConfirmedRedeemOutcome(outcome)
  || outcome == REDEEM_OUTCOME.MANUAL_FOLLOW_UP;

const propagateRedeemResultToDuplicateStoredCodes = ({ sourceEntry, result, redeemUrl }) => {
  if (!canPropagateRedeemResultToDuplicate(result.outcome)) return 0;
  let count = 0;
  for (const games of Object.values(db.data || {})) {
    for (const duplicate of Object.values(games || {})) {
      if (!sameStoredCode(sourceEntry, duplicate)) continue;
      applyRedeemResultToEntry(duplicate, result, redeemUrl);
      count++;
    }
  }
  return count;
};

const logDuplicatePropagation = (count, outcome) => {
  if (count <= 1) return;
  const kind = isConfirmedRedeemOutcome(outcome) ? 'confirmed result' : 'manual follow-up result';
  console.log(`  Propagated ${kind} to ${count - 1} duplicate stored code entr${count == 2 ? 'y' : 'ies'}.`);
};

const waitForGogRedeemSuccess = async (pageToInspect, title) => {
  console.log('  Waiting for GOG success confirmation...');
  try {
    await Promise.any([
      pageToInspect.locator('h1:has-text("Code redeemed successfully")').waitFor({ timeout: 45000 }),
      pageToInspect.getByText(/Code redeemed successfully/i).first().waitFor({ timeout: 45000 }),
    ]);
    if (cfg.pg_redeem_confirm_delay_ms > 0) {
      console.log(`  Confirmed success; keeping the page visible for ${cfg.pg_redeem_confirm_delay_ms}ms.`);
      await delay(cfg.pg_redeem_confirm_delay_ms);
    }
    await capturePageDiagnostics(pageToInspect, `gog-redeem-success-${filenamify(title)}`, { fullPage: true }).catch(_ => { });
    return makeRedeemResult(REDEEM_OUTCOME.REDEEMED);
  } catch {
    const text = await pageBodyText(pageToInspect);
    const result = classifyGogPageText(text);
    await capturePageDiagnostics(pageToInspect, `gog-redeem-uncertain-${filenamify(title)}`, { fullPage: true }).catch(_ => { });
    if (result.outcome == REDEEM_OUTCOME.CAPTCHA) {
      console.error('  GOG asked for captcha after Redeem; leaving this code for manual follow-up.');
      return result;
    }
    if (result.outcome == REDEEM_OUTCOME.ALREADY_REDEEMED) {
      console.log('  GOG page says the code is already used.');
      return result;
    }
    console.error('  GOG did not show a clear success confirmation after Redeem.');
    const snippet = text.slice(0, 500);
    if (snippet) console.error(`  GOG page text: ${snippet}`);
    return result.outcome == REDEEM_OUTCOME.UNKNOWN
      ? makeRedeemResult(REDEEM_OUTCOME.UNKNOWN, { redeem_action: 'redeem (verify manually)' })
      : result;
  }
};

const clickVisibleGogButton = async (pageToClick, actionLabel) => {
  const clicked = await pageToClick.evaluate(label => {
    const wanted = label.toLowerCase();
    const isVisible = el => {
      const style = window.getComputedStyle(el);
      return style.display != 'none'
        && style.visibility != 'hidden'
        && !el.disabled
        && !el.hasAttribute('disabled')
        && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const labelFor = el => (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const controls = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'));
    const button = controls.find(el => isVisible(el) && labelFor(el).toLowerCase().includes(wanted));
    if (!button) {
      return {
        clicked: false,
        visibleButtons: controls.filter(isVisible).map(labelFor).filter(Boolean).slice(0, 10),
      };
    }
    const text = labelFor(button);
    button.scrollIntoView({ block: 'center', inline: 'center' });
    button.click();
    return { clicked: true, text };
  }, actionLabel);

  if (!clicked?.clicked) {
    throw new Error(`Could not find visible GOG ${actionLabel} button. Visible buttons: ${(clicked?.visibleButtons || []).join(' | ') || '(none)'}`);
  }
  console.log(`  Clicked GOG ${actionLabel} button: ${clicked.text}`);
};

const hasVisibleGogButton = (pageToInspect, actionLabel) => pageToInspect.evaluate(label => {
  const wanted = label.toLowerCase();
  const isVisible = el => {
    const style = window.getComputedStyle(el);
    return style.display != 'none'
      && style.visibility != 'hidden'
      && !el.disabled
      && !el.hasAttribute('disabled')
      && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  };
  const labelFor = el => (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  return Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'))
    .some(el => isVisible(el) && labelFor(el).toLowerCase().includes(wanted));
}, actionLabel).catch(_ => false);

const waitForGogFinalRedeemButton = async pageToInspect => {
  await pageToInspect.waitForFunction(() => {
    const isVisible = el => {
      const style = window.getComputedStyle(el);
      return style.display != 'none'
        && style.visibility != 'hidden'
        && !el.disabled
        && !el.hasAttribute('disabled')
        && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const textFor = el => (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'))
      .some(el => isVisible(el) && (/redeem/i).test(textFor(el)));
  }, { timeout: 20000 });
};

const waitForLegacyRedeemPostSubmit = async pageToInspect => {
  const originalUrl = pageToInspect.url();
  await Promise.race([
    pageToInspect.waitForSelector('h2:has-text("Thanks for redeeming")').catch(_ => { }),
    pageToInspect.waitForURL(url => url.toString() != originalUrl, { timeout: 10000 }).catch(_ => { }),
    pageToInspect.waitForFunction(() => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return (/thanks for redeeming|redemption successful|successfully redeemed|already (been )?(redeemed|used)|invalid coupon|invalid code|not valid|not found|couldn'?t be found|page not found|\b404\b|expired|captcha|not a robot|error|problem|try again/).test(text);
    }, { timeout: 10000 }).catch(_ => { }),
    pageToInspect.waitForLoadState('networkidle').catch(_ => { }),
    delay(10000),
  ]);
};

const isLegacyRedeemFormStillReady = async pageToInspect => pageToInspect.locator('[name=coupon_code]').isVisible({ timeout: 1000 }).catch(_ => false)
  && pageToInspect.locator('[name=email]').isVisible({ timeout: 1000 }).catch(_ => false)
  && pageToInspect.locator('[type="submit"]').isVisible({ timeout: 1000 }).catch(_ => false);

const submitLegacyRedeemForm = async pageToInspect => {
  const submitButton = pageToInspect.locator('#submitbutton, form [type="submit"], [type="submit"]').first();
  await submitButton.scrollIntoViewIfNeeded().catch(_ => { });
  await submitButton.click();
  await waitForLegacyRedeemPostSubmit(pageToInspect);

  if (!await isLegacyRedeemFormStillReady(pageToInspect)) return;

  console.log('  Legacy form still visible after submit; retrying submit through the page DOM.');
  await capturePageDiagnostics(pageToInspect, 'legacy-redeem-submit-still-visible', { fullPage: true }).catch(_ => { });
  await pageToInspect.evaluate(() => {
    const button = document.querySelector('#submitbutton, form [type="submit"], [type="submit"]');
    button?.click();
  });
  await waitForLegacyRedeemPostSubmit(pageToInspect);
};

const waitForCaptchaResolution = async (pageToInspect, title, classifier, { phase, finalButtonLabel = null } = {}) => {
  await capturePageDiagnostics(pageToInspect, `${phase}-captcha-${filenamify(title)}`, { fullPage: true }).catch(_ => { });

  if (cfg.pg_redeem_captcha_mode != 'pause' || cfg.headless) {
    return makeRedeemResult(REDEEM_OUTCOME.CAPTCHA);
  }

  const timeoutMs = cfg.pg_redeem_captcha_timeout_seconds * 1000;
  console.error(`  CAPTCHA requires manual action. Solve it in the visible browser; waiting up to ${cfg.pg_redeem_captcha_timeout_seconds}s.`);
  await notify(`prime-gaming: captcha during ${phase} for ${title}. Solve it in the visible browser.`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await pageBodyText(pageToInspect);
    const result = classifier(text);
    if (result.outcome != REDEEM_OUTCOME.UNKNOWN && result.outcome != REDEEM_OUTCOME.CAPTCHA) return result;
    if (finalButtonLabel && await hasVisibleGogButton(pageToInspect, finalButtonLabel)) return makeRedeemResult(REDEEM_OUTCOME.READY);
    await delay(1000);
  }

  console.error('  CAPTCHA wait timed out; leaving this code pending for manual follow-up.');
  await capturePageDiagnostics(pageToInspect, `${phase}-captcha-timeout-${filenamify(title)}`, { fullPage: true }).catch(_ => { });
  return makeRedeemResult(REDEEM_OUTCOME.CAPTCHA);
};

const getLocatorMeta = async locator => {
  if (await locator.count() == 0) return {};

  const target = locator.first();
  const rawLabel = await target.getAttribute('aria-label') || await target.textContent() || '';
  const label = rawLabel.replace(/\s+/g, ' ').trim() || null;
  const href = await target.evaluate(el => {
    return el.getAttribute('href')
      || el.closest('a')?.href
      || el.getAttribute('data-url')
      || el.getAttribute('data-href')
      || el.dataset?.url
      || el.dataset?.href
      || null;
  }).catch(_ => null);

  return { label, href };
};

const getPrimeAuthContext = async page => {
  const selectors = [
    '[data-a-target="LinkAccountButton"]',
    'button:has-text("Link account")',
    'button:has-text("Link game account")',
    'a:has-text("Link account")',
    'a:has-text("Link game account")',
    'button[data-a-target="gms-cta"]',
  ];

  for (const selector of selectors) {
    const meta = await getLocatorMeta(page.locator(selector));
    if (meta.label || meta.href) return meta;
  }

  for (const selector of [
    'a[href*="authorize"]',
    'a[href*="oauth"]',
    'a[href*="link.amazon"]',
    'a[href*="epicgames.com"]',
    'a[href*="ea.com"]',
    'a[href*="battle.net"]',
    'a[href*="blizzard.com"]',
  ]) {
    const meta = await getLocatorMeta(page.locator(selector));
    if (meta.href) return meta;
  }

  return { label: null, href: null };
};

const firstMatchingLocator = async (selectors, predicate) => {
  for (const selector of selectors) {
    const matches = page.locator(selector);
    const count = await matches.count().catch(_ => 0);
    for (let i = 0; i < count; i++) {
      const candidate = matches.nth(i);
      if (await predicate(candidate).catch(_ => false)) return candidate;
    }
  }
  return null;
};

const firstVisibleLocator = selectors => firstMatchingLocator(selectors, locator => locator.isVisible());

const firstEnabledLocator = selectors => firstMatchingLocator(selectors, async locator => {
  return await locator.isVisible() && await locator.isEnabled();
});

const hasVisibleLocator = async locators => {
  for (const locator of locators) {
    const count = await locator.count().catch(_ => 0);
    for (let i = 0; i < count; i++) {
      if (await locator.nth(i).isVisible().catch(_ => false)) return true;
    }
  }
  return false;
};

const locatorLabel = async locator => {
  if (!locator) return null;
  const raw = await locator.getAttribute('aria-label').catch(_ => null)
    || await locator.textContent().catch(_ => null)
    || await locator.getAttribute('title').catch(_ => null);
  return raw?.replace(/\s+/g, ' ').trim() || null;
};

const waitForExternalClaimState = async () => {
  const claimSelectors = [
    '[data-a-target="buy-box"] .tw-button:has-text("Get game")',
    '[data-a-target="buy-box"] .tw-button:has-text("Claim")',
    '.tw-button:has-text("Complete Claim")',
  ];
  const linkAccountLocators = [
    page.locator('[data-a-target="LinkAccountModal"]'),
    page.locator('button:has-text("Link account")'),
    page.locator('button:has-text("Link game account")'),
    page.locator('div:has-text("Link account")'),
    page.locator('div:has-text("Link game account")'),
  ];
  const successLocators = [
    page.locator('.thank-you-title:has-text("Success")'),
    page.locator('[data-a-target="ClaimStateClaimCodeContent"]'),
    page.locator('input[type="text"]'),
    page.locator('text=/Successfully Claimed|Your code:/i'),
  ];
  const deadline = Date.now() + Math.min(cfg.timeout, 30000);

  while (Date.now() < deadline) {
    const button = await firstEnabledLocator(claimSelectors);
    if (button) return { state: 'click', button };
    if (await hasVisibleLocator(linkAccountLocators)) return { state: 'ready' };
    if (await hasVisibleLocator(successLocators)) return { state: 'ready' };
    await page.waitForTimeout(500);
  }

  const disabledButton = await firstVisibleLocator(claimSelectors);
  return {
    state: 'manual',
    label: await locatorLabel(disabledButton),
  };
};

const getPrimeUsername = async () => {
  const primaryItems = page.locator('[data-a-target="user-dropdown-first-name-text"]');
  if (await primaryItems.count() > 0) {
    const primary = primaryItems.first();
    if (await primary.isVisible()) {
      return (await primary.innerText()).trim();
    }
  }

  const dropdownItems = page.locator('[data-a-target="amazon-dropdown-header-interactable"]');
  if (await dropdownItems.count() > 0 && await dropdownItems.first().isVisible()) {
    await dropdownItems.first().click().catch(_ => { });
    const fallback = page.locator('[data-a-target="FirstName"]').first();
    await fallback.waitFor({ timeout: 5000 }).catch(_ => { });
    if (await page.locator('[data-a-target="FirstName"]').count() > 0) {
      return (await fallback.textContent())?.trim();
    }
  }
};

const waitForPrimeSignedIn = async () => {
  const waitForUsableClaimsPage = page.waitForFunction(() => {
    const isVisible = el => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display != 'none'
        && style.visibility != 'hidden'
        && !el.hasAttribute('hidden')
        && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const visibleSignIn = Array.from(document.querySelectorAll('a, button'))
      .some(el => (/sign in/i).test((el.textContent || '').trim()) && isVisible(el));
    const hasUser = [
      '[data-a-target="user-dropdown-first-name-text"]',
      '[data-a-target="amazon-dropdown-header-interactable"]',
      '[data-a-target="FirstName"]',
    ].some(selector => isVisible(document.querySelector(selector)));
    return !visibleSignIn && !(/signin|ap\/signin/i).test(location.href) && hasUser;
  }, { timeout: cfg.login_timeout });

  await waitForUsableClaimsPage;
};

const describePrimeLoginPage = async () => {
  const url = page.url();
  const body = await page.locator('body').innerText({ timeout: 1500 }).catch(_ => '');
  if ((/\/ap\/mfa/i).test(url) || (/two-step verification/i).test(body)) {
    return 'Amazon Two-Step Verification is required. Complete the code in the visible browser; keep "Don\'t require code on this browser" checked.';
  }
  if ((/\/ap\/signin/i).test(url)) {
    return 'Amazon sign-in is required for the Luna claims page.';
  }
  return 'Prime/Luna sign-in is required.';
};

const finishGogRedeem = async (page2, title, { allowCaptchaRetry = true } = {}) => {
  await waitForGogFinalRedeemButton(page2);
  await capturePageDiagnostics(page2, `gog-before-final-redeem-${filenamify(title)}`, { fullPage: true }).catch(_ => { });
  if (cfg.pg_redeem_before_final_delay_ms > 0) {
    console.log(`  Final GOG Redeem button is visible; waiting ${cfg.pg_redeem_before_final_delay_ms}ms for inspection before clicking.`);
    await delay(cfg.pg_redeem_before_final_delay_ms);
  }

  const r2 = page2.waitForResponse(r => r.request().method() == 'POST' && r.url().startsWith('https://redeem.gog.com/'));
  await clickVisibleGogButton(page2, 'Redeem');
  const { json: r2j, text: r2t } = await parseJsonResponse(await r2);
  const responseResult = classifyGogRedeemResponse(r2j);

  if (responseResult.outcome == REDEEM_OUTCOME.CONFIRMING) {
    return waitForGogRedeemSuccess(page2, title);
  }
  if (responseResult.outcome == REDEEM_OUTCOME.CAPTCHA) {
    console.error(`  GOG refused the final Redeem POST with captcha: ${responseResult.reason}`);
    const captchaResult = await waitForCaptchaResolution(page2, title, classifyGogPageText, {
      phase: 'gog-redeem-final',
      finalButtonLabel: 'Redeem',
    });
    if (captchaResult.outcome == REDEEM_OUTCOME.READY && allowCaptchaRetry) {
      return finishGogRedeem(page2, title, { allowCaptchaRetry: false });
    }
    return captchaResult;
  }
  if (responseResult.outcome != REDEEM_OUTCOME.UNKNOWN) return responseResult;

  console.debug(`  Response 2: ${r2t}`);
  console.log('  Unknown GOG final Redeem response.');
  await capturePageDiagnostics(page2, `gog-redeem-final-unknown-${filenamify(title)}`, { fullPage: true }).catch(_ => { });
  return responseResult;
};

const redeemStoredCode = async ({ title, store, code, redeemBaseUrl, dbEntry, enabled, label }) => {
  let result = makeRedeemResult(REDEEM_OUTCOME.READY);
  const redeem_url = buildRedeemUrl(store, code, redeemBaseUrl);
  dbEntry.code = code;
  if (redeem_url) dbEntry.redeemUrl = redeem_url;
  console.log('  URL to redeem game:', redeem_url);

  if (!enabled || !redeemBaseUrl) {
    result = makeRedeemResult(REDEEM_OUTCOME.MANUAL_FOLLOW_UP, { redeem_action: 'redeem' });
    applyRedeemResultToEntry(dbEntry, result, redeem_url);
    return { ...result, redeem_url };
  }

  console.log(`  Trying to redeem ${code} on ${store} (need to be logged in)!`);
  const page2 = await context.newPage();
  try {
    await gotoWithRetry(page2, redeemBaseUrl, { waitUntil: 'domcontentloaded' }, { label });
    if (store == 'gog.com') {
      const hasCodeInput = await page2.locator('#codeInput').isVisible({ timeout: 10000 }).catch(_ => false);
      if (!hasCodeInput) {
        result = classifyGogPageText(await pageBodyText(page2));
        if (result.outcome == REDEEM_OUTCOME.UNKNOWN && (/login|signin|sign-in/i).test(page2.url())) {
          result = makeRedeemResult(REDEEM_OUTCOME.LOGIN_REQUIRED);
        }
        console.error(`  GOG redeem page is not ready: ${result.redeem_action}`);
        await capturePageDiagnostics(page2, `gog-redeem-not-ready-${filenamify(title)}`, { fullPage: true }).catch(_ => { });
        return { ...result, redeem_url };
      }
      // await page.goto(`https://redeem.gog.com/v1/bonusCodes/${code}`); // {"reason":"Invalid or no captcha"}
      await page2.fill('#codeInput', code);
      // wait for responses before clicking on Continue and then Redeem
      // first there are requests with OPTIONS and GET to https://redeem.gog.com/v1/bonusCodes/XYZ?language=de-DE
      const r1 = page2.waitForResponse(r => r.request().method() == 'GET' && r.url().startsWith('https://redeem.gog.com/'));
      await clickVisibleGogButton(page2, 'Continue');
      const { json: r1j, text: r1t } = await parseJsonResponse(await r1);
      if (!r1j) {
        console.debug(`  Response 1: ${r1t}`);
        result = makeRedeemResult(REDEEM_OUTCOME.UNKNOWN, { redeem_action: 'redeem (unknown response)' });
        await capturePageDiagnostics(page2, `gog-redeem-continue-unknown-${filenamify(title)}`, { fullPage: true }).catch(_ => { });
        return { ...result, redeem_url };
      }
      // {"reason":"Invalid or no captcha"}
      // {"reason":"code_used"}
      // {"reason":"code_not_found"}
      const lookupResult = classifyGogLookupResponse(r1j);
      if (lookupResult.outcome == REDEEM_OUTCOME.CAPTCHA) {
        console.error(`  GOG refused the code lookup with captcha: ${lookupResult.reason}`);
        result = await waitForCaptchaResolution(page2, title, classifyGogPageText, {
          phase: 'gog-redeem-lookup',
          finalButtonLabel: 'Redeem',
        });
        if (result.outcome == REDEEM_OUTCOME.READY) result = await finishGogRedeem(page2, title);
      } else if (lookupResult.outcome == REDEEM_OUTCOME.ALREADY_REDEEMED) {
        result = lookupResult;
        console.error('  GOG says this code was already used; marking it as already redeemed.');
      } else if (lookupResult.outcome == REDEEM_OUTCOME.NOT_FOUND) {
        result = lookupResult;
        console.error('  Code was not found!');
      } else if (lookupResult.outcome == REDEEM_OUTCOME.READY) {
        console.log('  Redeeming', lookupResult.productTitle || title);
        result = await finishGogRedeem(page2, title);
      } else {
        result = lookupResult;
        console.debug(`  Response 1: ${r1t}`);
        console.log('  Unknown GOG code lookup response.');
        await capturePageDiagnostics(page2, `gog-redeem-lookup-unknown-${filenamify(title)}`, { fullPage: true }).catch(_ => { });
      }
    } else if (store == 'microsoft store' || store == 'xbox') {
      console.error(`  Redeem on ${store} is experimental!`);
      if (page2.url().startsWith('https://login.')) {
        console.error('  Not logged in! Please redeem the code above manually. You can now login in the browser for next time. Waiting for 60s.');
        await page2.waitForTimeout(60 * 1000);
        result = makeRedeemResult(REDEEM_OUTCOME.LOGIN_REQUIRED);
      } else {
        const iframe = page2.frameLocator('#redeem-iframe');
        const input = iframe.locator('[name=tokenString]');
        await input.waitFor();
        await input.fill(code);
        const r = page2.waitForResponse(r => r.url().startsWith('https://cart.production.store-web.dynamics.com/v1.0/Redeem/PrepareRedeem'));
        const rt = await (await r).text();
        const j = JSON.parse(rt);
        const reason = j?.events?.cart.length && j.events.cart[0]?.data?.reason;
        if (reason == 'TokenNotFound') {
          result = makeRedeemResult(REDEEM_OUTCOME.NOT_FOUND);
          console.error('  Code was not found!');
        } else if (j?.productInfos?.length && j.productInfos[0]?.redeemable) {
          await iframe.locator('button:has-text("Next")').click();
          await iframe.locator('button:has-text("Confirm")').click();
          const redeemResponse = page2.waitForResponse(r => r.url().startsWith('https://cart.production.store-web.dynamics.com/v1.0/Redeem/RedeemToken'));
          const redeemJson = JSON.parse(await (await redeemResponse).text());
          if (redeemJson?.events?.cart.length && redeemJson.events.cart[0]?.data?.reason == 'UserAlreadyOwnsContent') {
            result = makeRedeemResult(REDEEM_OUTCOME.ALREADY_REDEEMED);
            console.error('  error: UserAlreadyOwnsContent');
          } else {
            result = makeRedeemResult(REDEEM_OUTCOME.UNKNOWN, { redeem_action: 'redeemed?' });
            dbEntry.status = 'claimed and redeemed?';
            console.log('  Redeemed successfully? Please report if not in https://github.com/vogler/free-games-claimer/issues/5');
          }
        } else {
          result = makeRedeemResult(REDEEM_OUTCOME.UNKNOWN);
          console.debug(`  Response: ${rt}`);
          console.log('  Redeemed successfully? Please report your Response from above (if it is new) in https://github.com/vogler/free-games-claimer/issues/5');
        }
      }
    } else if (store == 'legacy games') {
      if (!cfg.lg_email) {
        result = makeRedeemResult(REDEEM_OUTCOME.MANUAL_FOLLOW_UP, { redeem_action: 'redeem (missing email)' });
        console.error('  Legacy Games redeem needs LG_EMAIL, PG_EMAIL, or EMAIL set.');
        await capturePageDiagnostics(page2, `legacy-redeem-missing-email-${filenamify(title)}`, { fullPage: true }).catch(_ => { });
      } else if (!await page2.locator('[name=coupon_code]').isVisible({ timeout: 10000 }).catch(_ => false)) {
        result = classifyLegacyPageText(await pageBodyText(page2));
        if (result.outcome == REDEEM_OUTCOME.UNKNOWN) result = makeRedeemResult(REDEEM_OUTCOME.MANUAL_FOLLOW_UP, { redeem_action: 'redeem (manual backlog)' });
        console.error(`  Legacy Games redeem form is not available: ${result.redeem_action}`);
        await capturePageDiagnostics(page2, `legacy-redeem-form-missing-${filenamify(title)}`, { fullPage: true }).catch(_ => { });
      } else {
        await page2.fill('[name=coupon_code]', code);
        await page2.fill('[name=email]', cfg.lg_email);
        await page2.fill('[name=email_validate]', cfg.lg_email);
        await page2.uncheck('[name=newsletter_sub]').catch(_ => { });
        await submitLegacyRedeemForm(page2);
        result = classifyLegacyPageText(await pageBodyText(page2));
        if (result.outcome == REDEEM_OUTCOME.UNKNOWN) {
          console.error('  Legacy Games did not show a recognized redeem result.');
          await capturePageDiagnostics(page2, `legacy-redeem-unknown-${filenamify(title)}`, { fullPage: true }).catch(_ => { });
        } else if (isCaptchaRedeemOutcome(result.outcome)) {
          console.error('  Legacy Games asked for captcha.');
          result = await waitForCaptchaResolution(page2, title, classifyLegacyPageText, { phase: 'legacy-redeem' });
        }
      }
    } else {
      console.error(`  Redeem on ${store} not yet implemented!`);
      result = makeRedeemResult(REDEEM_OUTCOME.MANUAL_FOLLOW_UP);
    }
    if (result.outcome == REDEEM_OUTCOME.REDEEMED) console.log('  Redeemed successfully.');
    if (result.outcome == REDEEM_OUTCOME.ALREADY_REDEEMED) console.log('  Already redeemed.');
  } finally {
    applyRedeemResultToEntry(dbEntry, result, redeem_url);
    if (cfg.pg_redeem_result_delay_ms > 0 && !cfg.headless) {
      await capturePageDiagnostics(page2, `redeem-result-${result.outcome}-${filenamify(title)}`, { fullPage: true }).catch(_ => { });
      console.log(`  Keeping redeem result page visible for ${cfg.pg_redeem_result_delay_ms}ms.`);
      await delay(cfg.pg_redeem_result_delay_ms);
    }
    if (cfg.debug) await page2.pause();
    await page2.close();
  }

  return { ...result, redeem_url };
};

const storedCodeKey = entry => `${entry.store || ''}`.toLowerCase() + '\0' + entry.code;

const buildStoredCodeCandidates = () => {
  const storedMatch = cfg.pg_redeem_past_match?.toLowerCase();
  const allowedStores = new Set(cfg.pg_redeem_past_stores);
  const candidateUsers = [user];
  if (user != 'prime-user' && db.data['prime-user']) candidateUsers.push('prime-user');
  const allPending = candidateUsers.flatMap(candidateUser => Object.entries(db.data[candidateUser] || {})
    .map(([title, entry]) => ({ candidateUser, title, entry }))
    .filter(({ entry }) => isStoredCodeSelectedForPastRun(entry))
    .filter(({ title }) => !storedMatch || title.toLowerCase().includes(storedMatch)));
  const storeFiltered = allPending.filter(({ entry }) => allowedStores.has(`${entry.store || ''}`.toLowerCase()));
  const seen = new Set();
  const deduped = storeFiltered
    .map(({ candidateUser, title, entry }) => ({ candidateUser, title, entry, redeemBaseUrl: getStoredRedeemBaseUrl(entry) }))
    .filter(({ entry }) => {
      const key = storedCodeKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const limited = cfg.pg_redeem_past_limit > 0 ? deduped.slice(0, cfg.pg_redeem_past_limit) : deduped;

  return {
    allPending,
    storeFiltered,
    deduped,
    selected: limited,
    skippedByStore: allPending.length - storeFiltered.length,
    duplicateCount: storeFiltered.length - deduped.length,
  };
};

const logStoredCodeAudit = ({ allPending, storeFiltered, deduped, selected, skippedByStore, duplicateCount }) => {
  console.log('\nStored external-store code audit:');
  console.log('  Pending codes:', allPending.length);
  console.log('  Enabled stores:', cfg.pg_redeem_past_stores.join(', '));
  console.log('  Store-filtered candidates:', storeFiltered.length);
  console.log('  Deduplicated candidates:', deduped.length);
  console.log('  Selected this run:', selected.length);
  if (skippedByStore) console.log('  Skipped by store filter:', skippedByStore);
  if (duplicateCount) console.log('  Skipped duplicate provider/code entries:', duplicateCount);
  for (const { candidateUser, title, entry, redeemBaseUrl } of selected) {
    console.log(`  - ${title} [${entry.store}] user=${candidateUser || user} status=${entry.status || 'unknown'} action=${entry.redeem_action || 'none'} stableUrl=${redeemBaseUrl ? 'yes' : 'no'}`);
  }
};

try {
  await gotoWithRetry(page, URL_CLAIM, { waitUntil: 'domcontentloaded' }, { label: 'prime-gaming claims home' }); // default 'load' takes forever
  // need to wait for some elements to exist before checking if signed in or accepting cookies:
  await Promise.any([
    'button:has-text("Sign in")',
    '[data-a-target="user-dropdown-first-name-text"]',
    '[data-a-target="amazon-dropdown-header-interactable"]',
    '[data-a-target="FirstName"]',
  ].map(s => page.waitForSelector(s)));
  page.click('[aria-label="Cookies usage disclaimer banner"] button:has-text("Accept Cookies")').catch(_ => { }); // to not waste screen space when non-headless, TODO does not work reliably, need to wait for something else first?
  while (await page.locator('button:has-text("Sign in")').count() > 0) {
    console.error(await describePrimeLoginPage());
    if (cfg.nowait) abortRun(1, 'Prime Gaming login required and NOWAIT=1');
    await page.click('button:has-text("Sign in")');
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout); // give user some extra time to log in
    console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);
    if (cfg.pg_email && cfg.pg_password) console.info('Using email and password from environment.');
    else if (cfg.browser_login) console.info('Browser-login mode enabled; skipping terminal credential prompts.');
    else console.info('Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode).');
    const email = cfg.pg_email || !cfg.browser_login && await prompt({ message: 'Enter email' });
    const password = email && (cfg.pg_password || !cfg.browser_login && await prompt({ type: 'password', message: 'Enter password' }));
    if (email && password) {
      await page.fill('[name=email]', email);
      await page.click('input[type="submit"]');
      await page.fill('[name=password]', password);
      // await page.check('[name=rememberMe]'); // no longer exists
      await page.click('input[type="submit"]');
      page.waitForURL('**/ap/signin**').then(async () => { // check for wrong credentials
        const alertLocator = page.locator('.a-alert-content').first();
        if (await alertLocator.count() == 0) return;
        const error = await alertLocator.innerText();
        if (!error || !error.trim().length) return;
        console.error('Login error:', error);
        await notify(`prime-gaming: login: ${error}`);
        await context.close(); // finishes potential recording
        abortRun(1, 'Prime Gaming login failed');
      }).catch(_ => { });
      // handle MFA, but don't await it
      page.waitForURL('**/ap/mfa**').then(async () => {
        console.log('Two-Step Verification - enter the One Time Password (OTP), e.g. generated by your Authenticator App');
        await page.check('[name=rememberDevice]');
        const otp = cfg.pg_otpkey && authenticator.generate(cfg.pg_otpkey) || await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 6 || 'The code must be 6 digits!' }); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
        await page.locator('input[name=otpCode]').pressSequentially(otp.toString());
        await page.click('input[type="submit"]');
      }).catch(_ => { });
    } else {
      console.log('Waiting for you to login in the browser.');
      await notify('prime-gaming: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        console.log('Run `SHOW=1 node prime-gaming` to login in the opened browser.');
        await context.close(); // finishes potential recording
        abortRun(1, 'Prime Gaming login required in shown browser');
      }
    }
    await capturePageDiagnostics(page, 'prime-login-wait-start').catch(_ => { });
    try {
      await waitForPrimeSignedIn();
    } catch (error) {
      await capturePageDiagnostics(page, 'prime-login-timeout', { fullPage: true }).catch(_ => { });
      throw error;
    }
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  user = await getPrimeUsername();
  if (!user) {
    user = cfg.pg_email || 'prime-user';
    console.warn(`Could not determine Prime username, falling back to ${user}`);
  }
  console.log(`Signed in as ${user}`);
  // await page.click('button[aria-label="User dropdown and more options"]');
  // const twitch = await page.locator('[data-a-target="TwitchDisplayName"]').first().innerText();
  // console.log(`Twitch user name is ${twitch}`);
  db.data[user] ||= {};

  if (await page.getByRole('button', { name: 'Try Prime' }).count()) {
    console.error('User is currently not an Amazon Prime member, so no games to claim. Exit!');
    await context.close();
    abortRun(1, 'Amazon Prime membership required');
  }

  const waitUntilStable = async (f, act) => {
    let v;
    while (true) {
      const v2 = await f();
      console.log('waitUntilStable', v2);
      if (v == v2) break;
      v = v2;
      await act();
    }
  };
  const scrollUntilStable = async f => await waitUntilStable(f, async () => {
    // await page.keyboard.press('End'); // scroll to bottom to show all games
  // loading all games became flaky; see https://github.com/vogler/free-games-claimer/issues/357
    await page.keyboard.press('PageDown'); // scrolling to straight to the bottom started to skip loading some games
    await page.waitForLoadState('networkidle'); // wait for all games to be loaded
    await page.waitForTimeout(3000); // TODO networkidle wasn't enough to load all already collected games
    // do it again since once wasn't enough...
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(3000);
  });

  const clickedGameTab = await page.evaluate(() => {
    const tab = document.querySelector('button[data-type="Game"]');
    if (!tab) return false;
    tab.click();
    return true;
  });
  if (!clickedGameTab) {
    console.warn('Could not find Prime Gaming game tab; continuing with the visible claims list.');
  }
  const games = page.locator('div[data-a-target="offer-list-FGWP_FULL"]');
  await games.waitFor();
  // await scrollUntilStable(() => games.locator('.item-card__action').count()); // number of games
  await scrollUntilStable(() => page.evaluate(() => document.querySelector('.tw-full-width')?.scrollHeight
    || document.scrollingElement?.scrollHeight
    || document.body?.scrollHeight
    || 0)); // height may change during loading while number of games is still the same?
  console.log('Number of already claimed games (total):', await games.locator('p:has-text("Collected")').count());
  // can't use .all() since the list of elements via locator will change after click while we iterate over it
  const internal = await games.locator('.item-card__action:has(button[data-a-target="FGWPOffer"])').all();
  const external = await games.locator('.item-card__action:has(a[data-a-target="FGWPOffer"])').all();
  // bottom to top: oldest to newest games
  internal.reverse();
  external.reverse();
  const origin = new URL(page.url()).origin;
  const sameOrNewPage = async url => {
    const isNew = page.url() != url;
    let p = page;
    if (isNew) {
      p = await context.newPage();
      await gotoWithRetry(p, url, { waitUntil: 'domcontentloaded' }, { label: `prime-gaming detail ${url}` });
    }
    return { p, isNew };
  };

  const findLegacyRedeemUrlOnPage = async pageToInspect => {
    const links = await pageToInspect.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(a => ({
      href: a.href,
      text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim(),
    }))).catch(_ => []);

    const stableLinks = links.filter(link => isStableLegacyRedeemUrl(link.href));
    return stableLinks.find(link => (/click here|redeem|redemption|code/i).test(link.text))?.href
    || stableLinks.find(link => (/promo\.legacygames\.com/i).test(link.href))?.href
    || stableLinks[0]?.href
    || null;
  };

  const discoverLegacyStoredRedeemBaseUrl = async (title, entry) => {
    if (entry.store != 'legacy games' || !entry.url) return null;
    const detailPage = await context.newPage();
    try {
      await gotoWithRetry(detailPage, entry.url, { waitUntil: 'domcontentloaded' }, { label: `prime-gaming legacy stored detail ${title}` });
      const deadline = Date.now() + 30000;
      let discoveredUrl = null;
      while (Date.now() < deadline) {
        discoveredUrl = await findLegacyRedeemUrlOnPage(detailPage);
        if (discoveredUrl) break;
        await delay(1000);
      }
      if (!discoveredUrl) {
        await capturePageDiagnostics(detailPage, `legacy-stored-detail-no-redeem-url-${filenamify(title)}`, { fullPage: true }).catch(_ => { });
        return null;
      }
      console.log(`  Discovered Legacy redeem URL from saved Luna detail page: ${discoveredUrl}`);
      entry.redeemUrl = discoveredUrl;
      return discoveredUrl;
    } catch (error) {
      console.error(`  Could not rediscover Legacy redeem URL from saved Luna detail page: ${error.message}`);
      await capturePageDiagnostics(detailPage, `legacy-stored-detail-error-${filenamify(title)}`, { fullPage: true }).catch(_ => { });
      return null;
    } finally {
      await detailPage.close().catch(_ => { });
    }
  };

  const skipBasedOnTime = async url => {
  // console.log('  Checking time left for game:', url);
    const { p, isNew } = await sameOrNewPage(url);
    const dueDateOrg = await p.locator('.availability-date .tw-bold').innerText();
    const dueDate = new Date(Date.parse(dueDateOrg + ' 17:00'));
    const daysLeft = (dueDate.getTime() - Date.now()) / 1000 / 60 / 60 / 24;
    console.log(' ', await p.locator('.availability-date').innerText(), '->', daysLeft.toFixed(2));
    if (isNew) await p.close();
    return daysLeft > cfg.pg_timeLeft;
  };
  console.log('\nNumber of free unclaimed games (Prime Gaming):', internal.length);
  // claim games in internal store
  for (const card of internal) {
    await card.scrollIntoViewIfNeeded();
    const title = await (await card.locator('.item-card-details__body__primary')).innerText();
    const slug = await (await card.locator('a')).getAttribute('href');
    const url = buildClaimUrl(origin, slug);
    console.log('Current free game:', chalk.blue(title));
    if (cfg.pg_timeLeft && await skipBasedOnTime(url)) continue;
    if (cfg.dryrun) continue;
    if (cfg.interactive && !await confirm()) continue;
    await card.locator('.tw-button:has-text("Claim")').click();
    db.data[user][title] ||= { title, time: datetime(), url, store: 'internal' };
    notify_games.push({ title, status: 'claimed', url });
    // const img = await card.locator('img.tw-image').getAttribute('src');
    // console.log('Image:', img);
    await card.screenshot({ path: screenshot('internal', `${filenamify(title)}.png`) });
  }
  console.log('\nNumber of free unclaimed games (external stores):', external.length);
  // claim games in external/linked stores. Linked: origin.com, epicgames.com; Redeem-key: gog.com, legacygames.com, microsoft
  const external_info = [];
  for (const card of external) { // need to get data incl. URLs in this loop and then navigate in another, otherwise .all() would update after coming back and .elementHandles() like above would lead to error due to page navigation: elementHandle.$: Protocol error (Page.adoptNode)
    const title = await card.locator('.item-card-details__body__primary').innerText();
    const slug = await card.locator('a:has-text("Claim")').first().getAttribute('href');
    const url = buildClaimUrl(origin, slug);
    // await (await card.$('text=Claim')).click(); // goes to URL of game, no need to wait
    external_info.push({ title, url });
  }
  // external_info = [ { title: 'Fallout 76 (XBOX)', url: 'https://gaming.amazon.com/fallout-76-xbox-fgwp/dp/amzn1.pg.item.9fe17d7b-b6c2-4f58-b494-cc4e79528d0b?ingress=amzn&ref_=SM_Fallout76XBOX_S01_FGWP_CRWN' } ];
  for (const { title, url } of external_info) {
    console.log('Current free game:', chalk.blue(title)); // , url);
    await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded' }, { label: `prime-gaming external claim ${url}` });
    if (cfg.debug) await page.pause();
    const item_text = await page.innerText('[data-a-target="DescriptionItemDetails"]');
    const store = item_text.toLowerCase().replace(/.* on /, '').slice(0, -1);
    console.log('  External store:', store);
    if (cfg.pg_timeLeft && await skipBasedOnTime(url)) continue;
    if (cfg.dryrun) continue;
    if (cfg.interactive && !await confirm()) continue;
    const claimState = await waitForExternalClaimState();
    if (claimState.state == 'click') {
      await claimState.button.click(); // waits for navigation
    } else if (claimState.state == 'manual') {
      const reason = claimState.label ? `claim control stayed disabled: ${claimState.label}` : 'no enabled claim control appeared';
      console.warn(`  Manual follow-up needed: ${reason}`);
      db.data[user][title] ||= { title, time: datetime(), url, store };
      db.data[user][title].status = `skipped: ${reason}`;
      notify_games.push({ title, url, status: `manual: ${reason} on ${store}` });
      addManualAction({
        type: 'prime-claim-unavailable',
        title,
        sourceStore: 'prime-gaming',
        provider: store,
        providerKey: providerKey(store),
        targetProvider: store,
        targetProviderKey: providerKey(store),
        url,
        claimUrl: url,
        actionUrl: url,
        actionLabel: claimState.label,
        message: `Open the Prime Gaming claim page and finish the claim manually: ${reason}.`,
      });
      await page.screenshot({ path: screenshot('external', `${filenamify(title)}-manual.png`), fullPage: true }).catch(_ => { });
      continue;
    }
    db.data[user][title] ||= { title, time: datetime(), url, store };
    const notify_game = { title, url };
    notify_games.push(notify_game); // status is updated below
    if (await page.locator('div:has-text("Link game account")').count() // TODO still needed? epic games store just has 'Link account' as the button text now.
       || await page.locator('div:has-text("Link account")').count()) {
      console.error('  Account linking is required to claim this offer!');
      notify_game.status = `failed: need account linking for ${store}`;
      db.data[user][title].status = 'failed: need account linking';
      const { label: actionLabel, href: authLink } = await getPrimeAuthContext(page);
      addManualAction({
        type: 'account-linking',
        title,
        sourceStore: 'prime-gaming',
        provider: store,
        providerKey: providerKey(store),
        targetProvider: store,
        targetProviderKey: providerKey(store),
        url,
        claimUrl: url,
        actionUrl: authLink || url,
        authLink,
        actionLabel,
        message: `Link your ${store} account and finish the Prime Gaming claim.`,
      });
      // await page.pause();
      // await page.click('[data-a-target="LinkAccountModal"] [data-a-target="LinkAccountButton"]');
      // TODO login for epic games also needed if already logged in
      // wait for https://www.epicgames.com/id/authorize?redirect_uri=https%3A%2F%2Fservice.link.amazon.gg...
      // await page.click('button[aria-label="Allow"]');
    } else {
      db.data[user][title].status = 'claimed';
      // print code if there is one
      if (canRedeemCode(store)) { // did not work for linked origin: && !await page.locator('div:has-text("Successfully Claimed")').count()
        const code = await Promise.any([page.inputValue('input[type="text"]'), page.textContent('[data-a-target="ClaimStateClaimCodeContent"]').then(s => s.replace('Your code: ', ''))]); // input: Legacy Games; text: gog.com
        console.log('  Code to redeem game:', chalk.blue(code));
        db.data[user][title].code = code;
        await checkpointDb(`saved external code for ${title}`);
        let redeemBaseUrl = redeemTargets[store];
        if (store == 'legacy games') { // may be different URL like https://legacygames.com/primeday/puzzleoftheyear/
          redeemBaseUrl = await page.locator('li:has-text("Click here") a').first().getAttribute('href'); // full text: Click here to enter your redemption code.
        }
        const { redeem_action, redeem_url } = await redeemStoredCode({
          title,
          store,
          code,
          url,
          redeemBaseUrl,
          dbEntry: db.data[user][title],
          enabled: cfg.pg_redeem,
          label: `prime-gaming redeem ${store}`,
        });
        await checkpointDb(`saved redeem result for ${title}`);
        addRedeemManualAction({ title, store, url, code, redeemUrl: redeem_url, redeemAction: redeem_action });
        notify_game.status = `<a href="${redeem_url}">${redeem_action}</a> ${code} on ${store}`;
      } else {
        notify_game.status = `claimed on ${store}`;
        db.data[user][title].status = 'claimed';
      }
      // save screenshot of potential code just in case
      await page.screenshot({ path: screenshot('external', `${filenamify(title)}.png`), fullPage: true });
      // console.info('  Saved a screenshot of page to', p);
    }
    // await page.pause();
  }
  await gotoWithRetry(page, URL_CLAIM, { waitUntil: 'domcontentloaded' }, { label: 'prime-gaming claims home refresh' });
  await page.evaluate(() => document.querySelector('button[data-type="Game"]')?.click()).catch(_ => { });

  if (notify_games.length) { // make screenshot of all games if something was claimed
    const p = screenshot(`${filenamify(datetime())}.png`);
    // await page.screenshot({ path: p, fullPage: true }); // fullPage does not make a difference since scroll not on body but on some element
    await scrollUntilStable(() => games.locator('.item-card__action').count());
    const viewportSize = page.viewportSize(); // current viewport size
    await page.setViewportSize({ ...viewportSize, height: 3000 }); // increase height, otherwise element screenshot is cut off at the top and bottom
    await games.screenshot({ path: p }); // screenshot of all claimed games
  }

  if (cfg.pg_redeem_past || cfg.pg_redeem_past_audit) {
    let skipRemainingStoredCodes = false;
    const storedCodeAudit = buildStoredCodeCandidates();
    const storedCodes = storedCodeAudit.selected;
    console.log(`\nNumber of stored external-store codes ${cfg.pg_redeem_past_verify ? 'selected for verification' : 'pending redemption'}:`, storedCodeAudit.allPending.length);
    console.log('Number of stored external-store codes selected this run:', storedCodes.length);
    if (storedCodeAudit.skippedByStore) console.log('Stored codes skipped by store filter:', storedCodeAudit.skippedByStore);
    if (storedCodeAudit.duplicateCount) console.log('Stored duplicate provider/code entries skipped this run:', storedCodeAudit.duplicateCount);
    if (cfg.pg_redeem_past_audit) {
      logStoredCodeAudit(storedCodeAudit);
      console.log('Audit mode only; not redeeming stored codes.');
    }
    if (cfg.pg_redeem_past_audit) storedCodes.length = 0;
    for (const { title, entry, redeemBaseUrl: storedRedeemBaseUrl } of storedCodes) {
      let redeemBaseUrl = storedRedeemBaseUrl;
      console.log('Stored code:', chalk.blue(title));
      console.log('  External store:', entry.store);
      console.log('  Code to redeem game:', chalk.blue(entry.code));
      if (skipRemainingStoredCodes) {
        console.log('  Skipping backlog auto-redeem: a previous attempt hit captcha in this batch.');
        const skipResult = makeRedeemResult(REDEEM_OUTCOME.CAPTCHA, { redeem_action: 'redeem (skipped after captcha)' });
        addRedeemManualAction({
          title,
          store: entry.store,
          url: entry.url,
          code: entry.code,
          redeemUrl: entry.redeemUrl || buildRedeemUrl(entry.store, entry.code, redeemTargets[entry.store]),
          redeemAction: skipResult.redeem_action,
        });
        notify_games.push({
          title,
          url: entry.url,
          status: 'skipped: backlog halted after earlier captcha',
        });
        markRedeemAttempt(entry, skipResult);
        await checkpointDb(`stored-code skip for ${title}`);
        continue;
      }
      if (!redeemBaseUrl && entry.store == 'legacy games') {
        redeemBaseUrl = await discoverLegacyStoredRedeemBaseUrl(title, entry);
        if (redeemBaseUrl) await checkpointDb(`rediscovered Legacy redeem URL for ${title}`);
      }
      if (!redeemBaseUrl) {
        console.log('  Skipping backlog auto-redeem: no stable stored redeem URL for this provider.');
        const manualResult = makeRedeemResult(REDEEM_OUTCOME.MANUAL_FOLLOW_UP);
        addRedeemManualAction({
          title,
          store: entry.store,
          url: entry.url,
          code: entry.code,
          redeemUrl: entry.redeemUrl || buildRedeemUrl(entry.store, entry.code, redeemTargets[entry.store]),
          redeemAction: manualResult.redeem_action,
        });
        notify_games.push({
          title,
          url: entry.url,
          status: `skipped: manual backlog follow-up for ${entry.store}`,
        });
        markRedeemAttempt(entry, manualResult);
        logDuplicatePropagation(propagateRedeemResultToDuplicateStoredCodes({
          sourceEntry: entry,
          result: manualResult,
          redeemUrl: entry.redeemUrl || buildRedeemUrl(entry.store, entry.code, redeemTargets[entry.store]),
        }), manualResult.outcome);
        await checkpointDb(`stored-code manual follow-up for ${title}`);
        continue;
      }
      if (entry.store == 'gog.com' && cfg.pg_redeem_past_delay_ms > 0) {
        console.log(`  Waiting ${cfg.pg_redeem_past_delay_ms}ms before GOG backlog retry...`);
        await new Promise(resolve => setTimeout(resolve, cfg.pg_redeem_past_delay_ms));
      }
      try {
        const { outcome, redeem_action, redeem_url } = await redeemStoredCode({
          title,
          store: entry.store,
          code: entry.code,
          url: entry.url,
          redeemBaseUrl,
          dbEntry: entry,
          enabled: true,
          label: `prime-gaming redeem stored ${entry.store}`,
        });
        addRedeemManualAction({
          title,
          store: entry.store,
          url: entry.url,
          code: entry.code,
          redeemUrl: redeem_url,
          redeemAction: redeem_action,
        });
        notify_games.push({
          title,
          url: entry.url,
          status: `<a href="${redeem_url}">${redeem_action}</a> ${entry.code} on ${entry.store} (stored code)`,
        });
        const propagated = propagateRedeemResultToDuplicateStoredCodes({
          sourceEntry: entry,
          result: { outcome, redeem_action },
          redeemUrl: redeem_url,
        });
        logDuplicatePropagation(propagated, outcome);
        await checkpointDb(`stored-code result for ${title}`);
        if (isCaptchaRedeemOutcome(outcome) && cfg.pg_redeem_past_stop_on_captcha) {
          skipRemainingStoredCodes = true;
          console.log('  Stopping remaining stored-code retries after captcha to avoid poisoning the rest of the batch.');
        }
      } catch (error) {
        console.error(`  Stored-code redemption failed for ${title}:`, error.message);
        const redeem_url = buildRedeemUrl(entry.store, entry.code, redeemBaseUrl);
        const errorResult = makeRedeemResult(REDEEM_OUTCOME.ERROR);
        addRedeemManualAction({
          title,
          store: entry.store,
          url: entry.url,
          code: entry.code,
          redeemUrl: redeem_url,
          redeemAction: errorResult.redeem_action,
        });
        notify_games.push({
          title,
          url: entry.url,
          status: `failed: stored-code redeem error on ${entry.store}`,
        });
        markRedeemAttempt(entry, errorResult);
        await checkpointDb(`stored-code error for ${title}`);
      }
    }
  }

  // https://github.com/vogler/free-games-claimer/issues/55
  if (cfg.pg_claimdlc) {
    console.log('Trying to claim in-game content...');
    const inGameLootButton = page.locator('button[data-type="InGameLoot"]').first();
    if (!await inGameLootButton.isVisible().catch(_ => false)) {
      console.warn('In-game content tab is not available; skipping DLC claims.');
    } else {
      await inGameLootButton.click();
      const loot = page.locator('div[data-a-target="offer-list-IN_GAME_LOOT"]');
      await loot.waitFor();

      process.stdout.write('Loading all DLCs on page...');
      await scrollUntilStable(() => loot.locator('[data-a-target="item-card"]').count());

      console.log('\nNumber of already claimed DLC:', await loot.locator('p:has-text("Collected")').count());

      const cards = await loot.locator('[data-a-target="item-card"]:has(p:text-is("Claim"))').all();
      console.log('Number of unclaimed DLC:', cards.length);
      const dlcs = await Promise.all(cards.map(async card => ({
        game: await card.locator('.item-card-details__body p').innerText(),
        title: await card.locator('.item-card-details__body__primary').innerText(),
        url: buildClaimUrl(origin, await card.locator('a').first().getAttribute('href')),
      })));
      // console.log(dlcs);

      const dlc_unlinked = {};
      for (const dlc of dlcs) {
        const title = `${dlc.game} - ${dlc.title}`;
        const url = dlc.url;
        console.log('Current DLC:', title);
        if (cfg.debug) await page.pause();
        if (cfg.dryrun) continue;
        if (cfg.interactive && !await confirm()) continue;
        db.data[user][title] ||= { title, time: datetime(), store: 'DLC', status: 'failed: need account linking' };
        const notify_game = { title, url };
        notify_games.push(notify_game); // status is updated below
        try {
          await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded' }, { label: `prime-gaming dlc ${url}` });
          // most games have a button 'Get in-game content'
          // epic-games: Fall Guys: Claim -> Continue -> Go to Epic Games (despite account linked and logged into epic-games) -> not tied to account but via some cookie?
          await Promise.any([page.click('.tw-button:has-text("Get in-game content")'), page.click('.tw-button:has-text("Claim your gift")'), page.click('.tw-button:has-text("Claim")').then(() => page.click('button:has-text("Continue")'))]);
          page.click('button:has-text("Continue")').catch(_ => { });
          const linkAccountButton = page.locator('[data-a-target="LinkAccountButton"]');
          let unlinked_store;
          if (await linkAccountButton.count()) {
            unlinked_store = await linkAccountButton.first().getAttribute('aria-label');
            console.debug('  LinkAccountButton label:', unlinked_store);
            const match = unlinked_store.match(/Link (.*) account/);
            if (match && match.length == 2) unlinked_store = match[1];
          } else if (await page.locator('text=Link game account').count()) { // epic-games only?
            console.error('  Missing account linking (epic-games specific button?):', await page.locator('button[data-a-target="gms-cta"]').innerText()); // TODO needed?
            unlinked_store = 'epic-games';
          }
          if (unlinked_store) {
            console.error('  Missing account linking:', unlinked_store, url);
            dlc_unlinked[unlinked_store] ??= [];
            dlc_unlinked[unlinked_store].push(title);
            const { label: actionLabel, href: authLink } = await getPrimeAuthContext(page);
            addManualAction({
              type: 'account-linking',
              title,
              sourceStore: 'prime-gaming',
              provider: unlinked_store,
              providerKey: providerKey(unlinked_store),
              targetProvider: unlinked_store,
              targetProviderKey: providerKey(unlinked_store),
              url,
              claimUrl: url,
              actionUrl: authLink || url,
              authLink,
              actionLabel,
              message: `Link your ${unlinked_store} account to claim this Prime Gaming DLC.`,
            });
          } else {
            const code = await page.inputValue('input[type="text"]').catch(_ => undefined);
            console.log('  Code to redeem game:', chalk.blue(code));
            db.data[user][title].code = code;
            db.data[user][title].status = 'claimed';
          // notify_game.status = `<a href="${redeem[store]}">${redeem_action}</a> ${code} on ${store}`;
          }
        // await page.pause();
        } catch (error) {
          console.error(error);
        } finally {
          await gotoWithRetry(page, URL_CLAIM, { waitUntil: 'domcontentloaded' }, { label: 'prime-gaming claims home restore' });
          await page.evaluate(() => document.querySelector('button[data-type="InGameLoot"]')?.click()).catch(_ => { });
        }
      }
      console.log('DLC: Unlinked accounts:', dlc_unlinked);
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
    if (error.message && process.exitCode != 130) notify(`prime-gaming failed: ${error.message.split('\n')[0]}`);
  }
} finally {
  await db.write(); // write out json db
  await writeRunSummary(runSummary, { user, games: notify_games, manualActions: manual_actions, error: runError, exitCode: process.exitCode });
  if (notify_games.length) { // list should only include claimed games
    notify(`prime-gaming (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (page.video()) {
  const videoPath = await page.video().path().catch(_ => null);
  if (videoPath) console.log('Recorded video:', videoPath);
}
await context.close().catch(error => console.warn(`Browser context was already closed: ${error.message.split('\n')[0]}`));
