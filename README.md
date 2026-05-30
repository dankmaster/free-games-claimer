# free-games-claimer

This fork is focused on running Free Games Claimer locally on Windows.

It claims or tracks free games and related offers from:

- [Epic Games Store](https://store.epicgames.com/free-games)
- [Amazon Prime Gaming](https://gaming.amazon.com)
- [GOG](https://www.gog.com)
- AliExpress coins
- Prime Gaming external-store keys, including GOG and Legacy Games backlog retries

Runtime data, cookies, browser profiles, screenshots, logs, claim caches, extension installs, and local config live under `data/`. That directory is ignored by Git and should not be committed.

## Requirements

- Windows 10/11
- PowerShell
- [Node.js LTS](https://nodejs.org/)
- Optional: [1Password](https://1password.com/) desktop app and browser extension for passkeys, MFA, and safer login storage
- Optional: [Apprise](https://github.com/caronc/apprise) for notifications

## Quick Setup

Open PowerShell in the repository root and run:

```powershell
.\initialize-fgc.ps1
```

That helper installs npm dependencies, installs Patchright Chromium, prepares the ignored `data/` folder, installs the 1Password browser extension copy when available, opens login pages, verifies the main sessions, warms giveaway caches, and runs a first no-prompt claim pass against the shared browser profile.

To set up local config manually:

```powershell
New-Item -ItemType Directory -Force data | Out-Null
Copy-Item .\config.env.example .\data\config.env
notepad .\data\config.env
```

Fill only the values you want to store locally. You can leave credentials blank and sign in through the browser during setup.

## 1Password Vaults

This fork is designed to work well with 1Password because some services use passkeys or browser-mediated login flows. Environment variables can provide passwords and OTP seeds, but they cannot complete a passkey prompt. The 1Password browser extension can complete those prompts during the visible login setup, and scheduled runs then reuse the saved cookies in `data/browser`.

Recommended setup:

1. Create a dedicated 1Password vault, for example `Free Games Claimer`.
2. Add Login items for the accounts you want the claimer to use.
3. Make sure the vault is available to the 1Password browser extension for this Windows user.
4. Store passkeys in the same Login item or vault used by the extension.
5. Run `.\login-fgc-sites.ps1` or `.\initialize-fgc.ps1`.
6. Unlock 1Password in the opened Chromium window and use it to sign in.
7. Return to PowerShell and press Enter when the helper asks you to verify logins.

Suggested Login item URLs:

| Account | URLs to add to the 1Password item |
|---------|-----------------------------------|
| Epic Games | `https://www.epicgames.com`, `https://store.epicgames.com` |
| Amazon / Prime Gaming | `https://gaming.amazon.com`, `https://www.amazon.com`, your regional Amazon host such as `https://www.amazon.se`, and your Luna host such as `https://luna.amazon.se` |
| GOG | `https://www.gog.com` |
| Microsoft redeem | `https://login.live.com`, `https://account.microsoft.com` |
| Legacy Games | `https://legacygames.com` |

If your Prime/Luna region is not the default, set `PG_LUNA_BASE_URL` in `data/config.env` before running the login helper. Sweden, for example, uses:

```env
PG_LUNA_BASE_URL=https://luna.amazon.se
```

Extra login pages can be opened with:

```powershell
.\login-fgc-sites.ps1 -ExtraUrls "https://example.com/login"
```

## Running Locally

Useful commands:

```powershell
# Run all supported stores visibly.
.\run-fgc.ps1 -NoPause -ShowAll

# Run all supported stores the same way scheduled tasks do.
.\run-fgc.ps1 -NoPause

# Reopen the shared browser profile for manual logins.
.\login-fgc-sites.ps1

# Run only one store directly.
node .\epic-games.js
node .\prime-gaming.js
node .\gog.js
```

Epic Games, Prime Gaming, and GOG run visibly by default so they can reuse the same browser-session behavior as manual login runs. Wrapper and scheduled runs with login prompts suppressed hide visible browser windows while keeping the shared browser profile active.

Logs are written to `data/logs/`. Screenshots and diagnostics are written under `data/screenshots/`.

## Automatic Runs

Install a daily scheduled task plus an at-logon fallback:

```powershell
.\initialize-fgc.ps1 -InstallScheduledTask -DailyAt 09:15 -LogonDelayMinutes 2
```

Or install/update scheduling after setup:

```powershell
.\install-fgc-scheduled-task.ps1 -DailyAt 09:15 -LogonDelayMinutes 2
```

Remove scheduled tasks and the startup fallback:

```powershell
.\uninstall-fgc-scheduled-task.ps1
```

The scheduled wrapper uses a lock file so overlapping runs are skipped. By default it also avoids running more often than every 12 hours.

Scheduled/startup runs hide the PowerShell/CMD window by default and keep logs under `data/logs/`. They also suppress login prompts and hide visible Chromium windows by default. If a store needs a fresh login, the run writes `data/login-required.flag`, aborts the remaining stores, auto-starts `.\initialize-fgc.ps1`, and blocks future background runs until setup finishes. Add `-ShowConsole` for a visible console or `-AllowLoginPrompts` if you want scheduled runs to wait in the browser for manual login.

## Configuration

Local config is loaded from `data/config.env`. That file is ignored by Git.

Common options:

| Option | Description |
|--------|-------------|
| `SHOW=1` | Show browser windows. Visible runs load browser extensions by default. |
| `START_MINIMIZED=1` | Start visible Chromium windows minimized where supported. |
| `TIMEOUT=90` | Page action timeout in seconds. |
| `LOGIN_TIMEOUT=240` | Login wait timeout in seconds. |
| `NOTIFY=...` | Apprise notification URL. Store real values only in `data/config.env`. |
| `NOTIFY_TITLE=...` | Optional notification title. |
| `BROWSER_DIR=...` | Browser profile directory. Defaults to `data/browser`. |
| `EXTENSION_DIRS=...` | Unpacked Chromium extension directories separated by `;` on Windows. |
| `CHROME_DEBUGGING_PORT=9222` | Optional local DevTools port for inspection. |
| `EG_EMAIL`, `EG_PASSWORD`, `EG_OTPKEY`, `EG_PARENTALPIN` | Epic Games login helpers. Optional when using browser login/1Password. |
| `EG_CHECK_GP=1` | Add Epic URLs found through GamerPower as a secondary source. |
| `PG_EMAIL`, `PG_PASSWORD`, `PG_OTPKEY` | Prime Gaming login helpers. Optional when using browser login/1Password. |
| `PG_LUNA_BASE_URL=...` | Regional Luna base URL, for example `https://luna.amazon.se`. |
| `PG_REDEEM=1` | Redeem newly claimed Prime Gaming external-store keys where supported. |
| `PG_REDEEM_PAST=1` | Retry older saved external-store codes from `data/prime-gaming.json`. |
| `PG_REDEEM_PAST_AUDIT=1` | List retry candidates without redeeming or printing codes. |
| `PG_REDEEM_CAPTCHA_MODE=pause` | Pause visible redeem runs for manual captcha solving. |
| `GOG_EMAIL`, `GOG_PASSWORD` | GOG login helpers. Optional when using browser login/1Password. |
| `GOG_CHECK_GP=1` | Use GamerPower as a secondary GOG giveaway source. |
| `LG_EMAIL=...` | Legacy Games email for Prime Gaming key redemption. |

See [src/config.js](src/config.js) for the full option list.

## Notifications

Notifications use Apprise. Install Apprise separately, then put your private notification URL in `data/config.env`:

```env
NOTIFY=pover://user@token
NOTIFY_TITLE=Free Games Claimer
```

Notifications include claimed games, failures, captcha/manual follow-up items, and cart fallback links when Epic checkout fails but offer IDs can be resolved.

## Service Notes

### Epic Games

Run:

```powershell
node .\epic-games.js
```

The script handles the newer Epic checkout flow that shows `Add to library`, `Right of Withdrawal Information`, and post-checkout confirmation modals. If Epic's free-games page misses an item for your region or platform, set `EG_CHECK_GP=1`.

### Prime Gaming

Run:

```powershell
node .\prime-gaming.js
```

Some Prime Gaming offers require account linking. Others provide external-store keys. Keys and manual follow-up URLs are saved under `data/` and included in run summaries.

To redeem future external-store keys during normal claim runs:

```env
PG_REDEEM=1
```

To revisit older stored codes:

```env
PG_REDEEM_PAST=1
```

For safer backlog checks without redeeming or printing codes:

```env
PG_REDEEM_PAST_AUDIT=1
```

### GOG

Run:

```powershell
node .\gog.js
```

If the homepage banner is flaky for your region, set `GOG_CHECK_GP=1`.

## Run Summaries

Each store writes a compact summary to `data/last-run.json` with status, duration, counters, unresolved manual actions, and last success time.

Manual follow-up items are appended to `data/manual-actions.json` with source/target provider context such as claim URLs, auth links, redeem URLs, and codes when available.

## Troubleshooting

- If a scheduled run fails because login expired, run `.\login-fgc-sites.ps1` and sign in again.
- If Epic shows captcha, solve it in the visible browser or retry later from a trusted network.
- If Chromium says the profile is in use, close any leftover Chromium windows and rerun. The scripts also clean stale profile lock files before Epic starts.
- If a page changed, run visibly with `.\run-fgc.ps1 -NoPause -ShowAll` and check `data/logs/` plus `data/screenshots/`.
- For Playwright/Patchright debugging, run with `PWDEBUG=1`.

## Updating

```powershell
git pull
npm install
npx patchright install chromium
```

Then rerun:

```powershell
.\run-fgc.ps1 -NoPause -ShowAll
```

## Upstream

This fork is based on [vogler/free-games-claimer](https://github.com/vogler/free-games-claimer) and keeps the original AGPL-3.0 license. Our fork adds local Windows helpers, safer ignored runtime state, 1Password/passkey-oriented setup docs, GamerPower fallback work, Prime external-store redemption improvements, and Epic checkout hardening.
