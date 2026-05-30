import * as dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = s => path.resolve(__dirname, '..', 'data', s);
const pathList = value => value
  ? value.split(path.delimiter).map(s => s.trim()).filter(Boolean).map(s => path.resolve(s))
  : [];
const valueList = value => value
  ? value.split(/[;,]/).map(s => s.trim()).filter(Boolean)
  : [];
const numberWithDefault = (value, defaultValue) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
};

dotenv.config({ path: dataDir('config.env'), quiet: true }); // loads env vars from file relative to the repo data dir; environment vars still override file values

// Options - also see table in README.md
export const cfg = {
  debug: process.env.DEBUG == '1' || process.env.PWDEBUG == '1', // runs non-headless and opens https://playwright.dev/docs/inspector
  debug_network: process.env.DEBUG_NETWORK == '1', // log network requests and responses
  record: process.env.RECORD == '1', // `recordHar` (network) + `recordVideo`
  time: process.env.TIME == '1', // log duration of each step
  interactive: process.env.INTERACTIVE == '1', // confirm to claim, enter to skip
  dryrun: process.env.DRYRUN == '1', // don't claim anything
  nowait: process.env.NOWAIT == '1', // fail fast instead of waiting for user input
  browser_login: process.env.BROWSER_LOGIN == '1', // skip terminal credential prompts and wait for browser login
  show: process.env.SHOW == '1', // run non-headless
  get headless() {
    return !this.debug && !this.show;
  },
  width: Number(process.env.WIDTH) || 1920, // width of the opened browser
  height: Number(process.env.HEIGHT) || 1080, // height of the opened browser
  timeout: (Number(process.env.TIMEOUT) || 60) * 1000, // default timeout for playwright is 30s
  login_timeout: (Number(process.env.LOGIN_TIMEOUT) || 180) * 1000, // higher timeout for login, will wait twice: prompt + wait for manual login
  chrome_debugging_port: Number(process.env.CHROME_DEBUGGING_PORT) || null, // expose Chrome DevTools Protocol on localhost for MCP/debugging
  gp_cache_ttl_hours: Number(process.env.GP_CACHE_TTL_HOURS) || 24, // refresh GamerPower redirects after this many hours
  start_minimized: process.env.START_MINIMIZED == '1', // start visible automation windows minimized where Chromium supports it
  notify: process.env.NOTIFY, // apprise notification services
  notify_title: process.env.NOTIFY_TITLE, // apprise notification title
  extensions_in_headless: process.env.EXTENSIONS_IN_HEADLESS == '1', // opt in to loading EXTENSION_DIRS for headless runs
  get dir() { // avoids ReferenceError: Cannot access 'dataDir' before initialization
    return {
      browser: process.env.BROWSER_DIR || dataDir('browser'), // for multiple accounts or testing
      screenshots: process.env.SCREENSHOTS_DIR || dataDir('screenshots'), // set to 0 to disable screenshots
      extensions: pathList(process.env.EXTENSION_DIRS), // unpacked Chromium extension directories separated by ; on Windows
    };
  },
  // auth epic-games
  eg_email: process.env.EG_EMAIL || process.env.EMAIL,
  eg_password: process.env.EG_PASSWORD || process.env.PASSWORD,
  eg_otpkey: process.env.EG_OTPKEY,
  eg_parentalpin: process.env.EG_PARENTALPIN,
  eg_check_gp: process.env.EG_CHECK_GP == '1', // merge Epic URLs from GamerPower as a secondary source
  eg_mobile: process.env.EG_MOBILE != '0', // claim mobile games
  // auth prime-gaming
  pg_email: process.env.PG_EMAIL || process.env.EMAIL,
  pg_password: process.env.PG_PASSWORD || process.env.PASSWORD,
  pg_otpkey: process.env.PG_OTPKEY,
  pg_luna_base_url: (process.env.PG_LUNA_BASE_URL || 'https://luna.amazon.com').replace(/\/$/, ''),
  // auth gog
  gog_email: process.env.GOG_EMAIL || process.env.EMAIL,
  gog_password: process.env.GOG_PASSWORD || process.env.PASSWORD,
  gog_check_gp: process.env.GOG_CHECK_GP == '1', // use GamerPower as a secondary fallback when GOG giveaway detection misses a banner
  gog_newsletter: process.env.GOG_NEWSLETTER == '1', // do not unsubscribe from newsletter after claiming a game
  // auth AliExpress
  ae_email: process.env.AE_EMAIL || process.env.EMAIL,
  ae_password: process.env.AE_PASSWORD || process.env.PASSWORD,
  // OTP only via GOG_EMAIL, can't add app...
  // experimmental
  pg_redeem: process.env.PG_REDEEM == '1', // prime-gaming: redeem keys on external stores for newly claimed offers
  pg_redeem_past: process.env.PG_REDEEM_PAST == '1', // prime-gaming: revisit previously saved external-store codes that are not marked redeemed yet
  pg_redeem_past_verify: process.env.PG_REDEEM_PAST_VERIFY == '1', // prime-gaming: verify all saved external-store codes, including redeemed/not-found terminal states
  pg_redeem_past_audit: process.env.PG_REDEEM_PAST_AUDIT == '1', // prime-gaming: list stored-code retry candidates without redeeming or printing codes
  pg_redeem_past_match: process.env.PG_REDEEM_PAST_MATCH?.trim(), // prime-gaming: limit stored-code retries to titles containing this case-insensitive substring
  pg_redeem_past_limit: Math.max(0, numberWithDefault(process.env.PG_REDEEM_PAST_LIMIT, 1)), // prime-gaming: max stored codes to retry per run, 0 means no limit
  pg_redeem_past_stores: valueList(process.env.PG_REDEEM_PAST_STORES || 'gog.com;legacy games').map(s => s.toLowerCase()), // prime-gaming: stored-code providers to retry
  pg_redeem_past_delay_ms: numberWithDefault(process.env.PG_REDEEM_PAST_DELAY_MS, 2500), // prime-gaming: delay between stored-code redemption attempts to reduce captcha risk
  pg_redeem_before_final_delay_ms: numberWithDefault(process.env.PG_REDEEM_BEFORE_FINAL_DELAY_MS, 0), // prime-gaming: optional debug pause before clicking GOG's final Redeem button
  pg_redeem_confirm_delay_ms: numberWithDefault(process.env.PG_REDEEM_CONFIRM_DELAY_MS, 2500), // prime-gaming: keep successful external-store redeem pages visible this long before closing
  pg_redeem_result_delay_ms: numberWithDefault(process.env.PG_REDEEM_RESULT_DELAY_MS, 0), // prime-gaming: keep any classified external-store redeem result visible this long before closing
  pg_redeem_captcha_mode: process.env.PG_REDEEM_CAPTCHA_MODE || 'pause', // prime-gaming: pause, stop, or record when GOG/Legacy asks for captcha
  pg_redeem_captcha_timeout_seconds: numberWithDefault(process.env.PG_REDEEM_CAPTCHA_TIMEOUT_SECONDS, 600), // prime-gaming: visible captcha pause timeout
  pg_redeem_past_stop_on_captcha: process.env.PG_REDEEM_PAST_STOP_ON_CAPTCHA != '0', // prime-gaming: stop remaining stored GOG retries after the first captcha
  lg_email: process.env.LG_EMAIL || process.env.PG_EMAIL || process.env.EMAIL, // prime-gaming: external: legacy-games: email to use for redeeming
  pg_claimdlc: process.env.PG_CLAIMDLC == '1', // prime-gaming: claim in-game content
  pg_timeLeft: Number(process.env.PG_TIMELEFT), // prime-gaming: check time left to claim and skip game if there are more than PG_TIMELEFT days left to claim it
};
