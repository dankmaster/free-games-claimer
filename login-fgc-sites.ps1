[CmdletBinding()]
param(
    [string]$ExtraUrls = ""
)

$ErrorActionPreference = "Stop"

$repo = $PSScriptRoot
$runner = Join-Path $PSScriptRoot "run-fgc.ps1"
$installer = Join-Path $PSScriptRoot "install-1password-extension.ps1"
$browserDir = Join-Path $repo "data\browser"

if (!(Test-Path (Join-Path $repo "package.json"))) {
    throw "Could not find free-games-claimer project at $repo"
}

$task = Get-ScheduledTask -TaskName "Free Games Claimer - Daily" -ErrorAction SilentlyContinue
if ($task -and $task.State -eq "Running") {
    Write-Host "Stopping running scheduled task so the shared browser profile can be opened for login..."
    schtasks.exe /End /TN "Free Games Claimer - Daily" | Out-Host
    Start-Sleep -Seconds 3
}

$escapedBrowserDir = [regex]::Escape($browserDir)
$profileUsers = Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "chrome.exe" -and $_.CommandLine -match $escapedBrowserDir }
if ($profileUsers) {
    $ids = ($profileUsers | Select-Object -ExpandProperty ProcessId) -join ", "
    throw "The automation Chromium profile is already open by process id(s): $ids. Close the Free Games Claimer Chromium window first, then rerun this script."
}

if (Test-Path $installer) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
}

if (Test-Path $runner) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner -InstallOnly -NoPause -LogPrefix "fgc_login_setup"
}

Push-Location $repo
try {
    $env:SHOW = "1"
    $oldExtraUrls = $env:LOGIN_EXTRA_URLS
    if ($ExtraUrls) {
        $env:LOGIN_EXTRA_URLS = $ExtraUrls
    }

    try {
        & npm run login-sites
    } finally {
        $env:LOGIN_EXTRA_URLS = $oldExtraUrls
    }
} finally {
    Pop-Location
}
